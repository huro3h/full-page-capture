// 撮影のオーケストレーション。
// captureVisibleTab は「今見えている範囲」しか撮れないので、
// コンテンツスクリプトにスクロールさせながら連写し、結果ページで1枚に合成する。

// captureVisibleTab は 1秒あたり2回までのレート制限がある(MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND)。
// 制限に当たると lastError が返るだけで撮れないので、最初から余裕を持って間隔を空ける。
const CAPTURE_INTERVAL_MS = 520;
const CAPTURE_MAX_RETRY = 5;

// スクロール後、遅延読み込み画像や再描画が落ち着くのを待つ時間。
const SETTLE_MS = 180;

// タイル同士の重なり。端の描画欠けやstickyの残骸を次のタイルで上書きさせる。
const OVERLAP_PX = 40;

// 無限スクロールなどで止まらなくなった場合の保険。
const MAX_TILES = 240;

let busy = false;
/** @type {{tiles: {x:number,y:number,dataUrl:string}[], meta: object} | null} */
let lastResult = null;

chrome.action.onClicked.addListener((tab) => {
  void run(tab, "full");
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  void run(tab, command === "02_capture-visible" ? "visible" : "full");
});

// Chromeが拡張機能に触らせないページ。権限をいくら足しても解除できない。
function restrictedReason(url) {
  if (!url) return "このページのURLを取得できません";
  if (/^https?:/.test(url)) {
    // ウェブストアだけは https でも別格。Chromium が
    // "The extensions gallery cannot be scripted." で拒否する。
    if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url)) {
      return "Chrome ウェブストアは、どの拡張機能も操作できない保護対象ページです";
    }
    return null;
  }
  if (url.startsWith("file:")) return null; // 「ファイルのURLへのアクセスを許可する」が必要
  if (url.startsWith("chrome-extension:")) return "拡張機能のページは撮影できません";
  return `${url.split(":")[0]}: のページは撮影できません`;
}

async function run(tab, mode) {
  if (busy) return;
  const reason = restrictedReason(tab.url);
  if (!tab.id || reason) {
    await fail(reason || "このタブは撮影できません");
    return;
  }
  busy = true;
  try {
    const result = await capture(tab, mode);
    lastResult = result;
    await chrome.tabs.create({ url: chrome.runtime.getURL("src/result/result.html") });
    setBadge("");
  } catch (error) {
    console.error("[full-page-capture]", error);
    await fail(String(error && error.message ? error.message : error));
  } finally {
    busy = false;
  }
}

async function capture(tab, mode) {
  const tabId = tab.id;

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/scripts/content.js"],
  });

  const meta = await send(tabId, { type: "prepare", mode });
  try {
    // デバイスピクセル比は devicePixelRatio を信用せず、実際に撮れた画像の幅から逆算する。
    // ブラウザズーム・OSスケーリング・Retinaが混ざると devicePixelRatio だけでは1pxずれる。
    const probe = await captureVisible(tab.windowId, 0);
    const probeSize = await imageSize(probe);
    // 撮影画像はビューポート全体なので、撮影対象のコンテナ幅ではなくウィンドウ幅と比べる。
    const dpr = probeSize.width / meta.windowW;

    if (mode === "visible") {
      return {
        tiles: [{ x: 0, y: 0, dataUrl: probe }],
        meta: { ...meta, dpr, pageW: meta.viewW, pageH: meta.viewH, grew: false, truncated: false },
      };
    }

    const tiles = [];
    const stepX = Math.max(1, meta.viewW - OVERLAP_PX);
    const stepY = Math.max(1, meta.viewH - OVERLAP_PX);

    // 撮影中にページが伸びても(無限スクロール)、開始時点の高さまでで打ち切る。
    const targetW = meta.pageW;
    const targetH = meta.pageH;
    let grew = false;
    let truncated = false;
    let lastCaptureAt = 0;

    let y = 0;
    outer: while (true) {
      let x = 0;
      while (true) {
        const at = await scrollTo(tabId, x, y, tiles.length === 0);
        await sleep(SETTLE_MS);

        const elapsed = Date.now() - lastCaptureAt;
        if (elapsed < CAPTURE_INTERVAL_MS) await sleep(CAPTURE_INTERVAL_MS - elapsed);
        const dataUrl = await captureVisible(tab.windowId, 0);
        lastCaptureAt = Date.now();

        // 実際に到達した座標に置く。これだけで重なり分も、最後の半端な行も正しく収まる
        // (後のタイルが前のタイルを上書きするため)。
        tiles.push({ x: at.x, y: at.y, dataUrl });
        setBadge(String(tiles.length));

        if (at.pageH > targetH) grew = true;
        if (tiles.length >= MAX_TILES) {
          truncated = true;
          break outer;
        }

        if (at.x + meta.viewW >= targetW - 1) break;
        const nextX = Math.min(x + stepX, targetW - meta.viewW);
        if (nextX <= at.x) break; // これ以上右に進めない
        x = nextX;
      }

      if (y + meta.viewH >= targetH - 1) break;
      const nextY = Math.min(y + stepY, targetH - meta.viewH);
      if (nextY <= y) break; // これ以上下に進めない
      y = nextY;
    }

    return {
      tiles,
      meta: { ...meta, dpr, pageW: targetW, pageH: targetH, grew, truncated },
    };
  } finally {
    await send(tabId, { type: "restore" }).catch(() => {});
  }
}

function scrollTo(tabId, x, y, isFirstTile) {
  return send(tabId, { type: "scrollTo", x, y, isFirstTile });
}

function send(tabId, message) {
  return chrome.tabs.sendMessage(tabId, { __fpc: true, ...message });
}

function captureVisible(windowId, attempt) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, async (dataUrl) => {
      if (!chrome.runtime.lastError && dataUrl) {
        resolve(dataUrl);
        return;
      }
      if (attempt >= CAPTURE_MAX_RETRY) {
        reject(new Error("captureVisibleTab が失敗しました: " + (chrome.runtime.lastError?.message || "unknown")));
        return;
      }
      await sleep(CAPTURE_INTERVAL_MS);
      captureVisible(windowId, attempt + 1).then(resolve, reject);
    });
  });
}

async function imageSize(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setBadge(text) {
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color: "#1f2937" });
}

async function fail(message) {
  // ページを操作できない状況で失敗するので、ページ内に通知を出す手段がない。
  // アイコンのバッジとツールチップ(ホバーで見える)が唯一の伝達経路。
  void chrome.action.setBadgeText({ text: "!" });
  void chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
  await chrome.action.setTitle({ title: "撮影できませんでした\n" + message });
  setTimeout(() => {
    setBadge("");
    void chrome.action.setTitle({ title: "ページ全体を撮影" });
  }, 10000);
}

// 結果ページからの取り出し。タイルは1枚ずつ渡す(まとめて渡すとメッセージが大きくなりすぎる)。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.__fpcResult !== true) return;
  if (!lastResult) {
    sendResponse({ error: "撮影結果がありません" });
    return;
  }
  if (message.type === "meta") {
    sendResponse({ meta: lastResult.meta, count: lastResult.tiles.length });
  } else if (message.type === "tile") {
    sendResponse({ tile: lastResult.tiles[message.index] });
  }
  return true;
});
