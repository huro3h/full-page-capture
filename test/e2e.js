// 合成結果のピクセルを直接検証するE2Eテスト。
//   node test/e2e.js
// Playwright が必要: PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
//
// 検証の考え方: フィクスチャの各行に一意な色を割り当て、合成画像の
// 「文書座標 → 色」が一致するかを見る。ずれ・欠け・二重描画があれば必ず落ちる。
// 通常のページ、本文が同一オリジンiframeに入ったページ、
// 左にサイドバーがあり本文だけがスクロールするページの3通りで回す。

const { chromium } = require("playwright");
const { spawnSync } = require("child_process");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");

// 実行ファイルではなくアプリとして open で起動する (withBrowser を参照)。
const BRAVE_APP = "/Applications/Brave Browser Nightly.app";
const SRC = path.resolve(__dirname, "..");
const PORT = 8931;
const ORIGIN = `http://localhost:${PORT}`;

const VIEW_W = 900;
const VIEW_H = 700;
const HEAD_H = 60; // fixture.html の body padding-top
const ROW_H = 100;
const ROWS = 40;

// off = 合成画像上でスクロール領域が始まる位置。contentW = スクロール領域の幅。
// out = 画像全体の大きさ(CSS px)。スクロール領域が対象のときは、周囲の1画面に
// 「領域が伸びたぶん」を足した大きさになる。
// fixture は検証の種類 ("standard" = fixture.html の固定要素, "sidebar" = 周囲の写り方)。
const SCENARIOS = [
  {
    name: "通常のページ",
    url: `${ORIGIN}/`,
    fixture: "standard",
    off: { x: 0, y: 0 },
    contentW: VIEW_W,
    headH: HEAD_H,
    out: { w: VIEW_W, h: HEAD_H + ROWS * ROW_H },
    kind: "document",
    method: "高速",
    extras: true,
  },
  {
    // iframe は (70, 50) に 760×520。外側のページも先頭の1画面ぶん写る。
    name: "同一オリジンiframe",
    url: `${ORIGIN}/iframe`,
    fixture: "standard",
    off: { x: 70, y: 50 },
    contentW: 760,
    headH: HEAD_H,
    out: { w: VIEW_W, h: VIEW_H + HEAD_H + ROWS * ROW_H - 520 },
    kind: "iframe",
    method: "連写",
    extras: false,
  },
  {
    // 本文は (200, 50) に 700×620。上に50px・下に30pxのバー、左に200pxのサイドバー。
    name: "サイドバー付きのページ",
    url: `${ORIGIN}/sidebar`,
    fixture: "sidebar",
    off: { x: 200, y: 50 },
    contentW: 700,
    headH: 0,
    out: { w: VIEW_W, h: VIEW_H + ROWS * ROW_H - 620 },
    kind: "element",
    method: "連写",
    extras: false,
  },
];

function startServer() {
  const direct = fs.readFileSync(path.join(__dirname, "fixture.html"));
  const framed = fs.readFileSync(path.join(__dirname, "fixture-iframe.html"));
  const sidebar = fs.readFileSync(path.join(__dirname, "fixture-sidebar.html"));
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (req.url.startsWith("/iframe")) res.end(framed);
      else if (req.url.startsWith("/sidebar")) res.end(sidebar);
      else res.end(direct);
    });
    server.listen(PORT, () => resolve(server));
  });
}

// 実運用の権限は activeTab (クリックというユーザー操作で付与される)。
// 自動操作にはそのジェスチャが無いので、テスト用コピーにだけ host_permissions を足す。
function buildTestExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fpc-ext-"));
  fs.cpSync(SRC, dir, {
    recursive: true,
    filter: (s) => !s.includes("/.git") && !s.includes("/node_modules"),
  });
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

const failures = [];
function report(label, ok, detail) {
  console.log(
    `${ok ? "  ok  " : "  NG  "} ${label}${ok || !detail ? "" : "  " + detail}`,
  );
  if (!ok) failures.push(label);
}

const fmtSize = (n) =>
  n > 1024 * 1024
    ? (n / 1024 / 1024).toFixed(1) + "MB"
    : Math.round(n / 1024) + "KB";

// 撮影を実行し、結果ページが使える状態になるまで待つ。
async function capture(context, sw, url) {
  const resultPromise = context.waitForEvent("page", { timeout: 180000 });
  const error = await sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({ url: u + "*" });
    if (!tabs.length) return "対象タブが見つからない";
    try {
      await run(tabs[0], "full");
      return null;
    } catch (e) {
      return String(e);
    }
  }, url);
  if (error) throw new Error("撮影に失敗: " + error);

  const result = await resultPromise;
  await result.waitForLoadState("load");
  await result.waitForFunction(
    () => !document.getElementById("save-png").disabled,
    null,
    {
      timeout: 180000,
    },
  );
  return result;
}

async function checkImage(result, scenario) {
  const samples = await result.evaluate(
    ({ outW, off, headH, rowH, rows }) => {
      const c = document.getElementById("canvas");
      const ctx = c.getContext("2d");
      const dpr = c.width / outW;
      const out = [];
      for (let i = 0; i < rows; i++) {
        const y = Math.round((off.y + headH + i * rowH + rowH / 2) * dpr);
        const px = ctx.getImageData(Math.round((off.x + 20) * dpr), y, 1, 1).data;
        out.push([i, px[0], px[1], px[2]]);
      }
      return { dpr, w: c.width, h: c.height, out };
    },
    { outW: scenario.out.w, off: scenario.off, headH: scenario.headH, rowH: ROW_H, rows: ROWS },
  );

  const mismatched = samples.out.filter(([i, r, g, b]) => {
    const [er, eg, eb] = [i * 6, 40, 200 - i * 4];
    return Math.abs(r - er) > 4 || Math.abs(g - eg) > 4 || Math.abs(b - eb) > 4;
  });
  report(
    `[${scenario.name}] 全${ROWS}行の色が一致`,
    mismatched.length === 0,
    JSON.stringify(mismatched.slice(0, 5)),
  );

  const expectedW = Math.round(scenario.out.w * samples.dpr);
  const expectedH = Math.round(scenario.out.h * samples.dpr);
  report(
    `[${scenario.name}] 画像サイズ ${samples.w}×${samples.h} == ${expectedW}×${expectedH}`,
    samples.w === expectedW && samples.h === expectedH,
  );

  // 縦1列を走査して、条件に合う色の帯が何回現れたかを数える。列は CSS px で渡す。
  const bands = await result.evaluate(
    ({ dpr, columns }) => {
      const c = document.getElementById("canvas");
      const ctx = c.getContext("2d");
      const preds = {
        // 純色は表示先ディスプレイの色変換で寄せられることがある
        // (外部ディスプレイ上の窓では #ff00ff が (255,64,255) で撮れた)。
        // 行の色 (G=40固定) と取り違えない範囲で、色相が分かる程度に緩く判定する。
        magenta: (r, g, b) => r > 200 && g < 110 && b > 200,
        cyan: (r, g, b) => r < 80 && g > 200 && b > 200,
        yellow: (r, g, b) => r > 200 && g > 200 && b < 80,
        green: (r, g, b) => r < 80 && g > 200 && b < 80,
        orange: (r, g, b) => r > 200 && g > 90 && g < 180 && b < 80,
        blue: (r, g, b) => r < 80 && g < 80 && b > 200,
        // 外側のページのグレー(#888)
        gray: (r, g, b) =>
          Math.abs(r - 136) < 6 && Math.abs(g - 136) < 6 && Math.abs(b - 136) < 6,
      };
      const out = {};
      for (const [key, x, color] of columns) {
        const d = ctx.getImageData(Math.round(x * dpr), 0, 1, c.height).data;
        let n = 0;
        let inBand = false;
        let last = -1;
        for (let y = 0; y < c.height; y++) {
          const hit = preds[color](d[y * 4], d[y * 4 + 1], d[y * 4 + 2]);
          if (hit && !inBand) n++;
          if (hit) last = y;
          inBand = hit;
        }
        // 帯の数と、最後に現れた位置 (CSS px)
        out[key] = { n, last: last < 0 ? -1 : Math.floor(last / dpr) };
      }
      return out;
    },
    { dpr: samples.dpr, columns: bandColumns(scenario) },
  );

  const expect = (label, key, n) =>
    report(`[${scenario.name}] ${label}`, bands[key].n === n, `実際 ${bands[key].n}`);

  if (scenario.fixture === "standard") {
    expect("固定ヘッダーは1回だけ写る", "header", 1);
    expect("固定フッターは写らない", "footer", 0);
    expect("浮遊ウィジェットは写らない", "widget", 0);
    expect("stickyサイドバーは1回だけ写る", "side", 1);
    if (scenario.kind === "iframe") expect("外側のページは先頭に1回だけ写る", "outer", 1);
    return;
  }

  // サイドバー付きのページ
  const { h } = scenario.out;
  expect("上のバーは先頭に1回だけ写る", "top", 1);
  expect("浮遊ウィジェットは写らない", "widget", 0);
  report(
    `[${scenario.name}] サイドバーが途切れず下端まで続く`,
    bands.nav.n === 1 && bands.nav.last === h - 31,
    JSON.stringify(bands.nav),
  );
  report(
    `[${scenario.name}] 下のバーは末尾に1回だけ写る`,
    bands.status.n === 1 && bands.status.last === h - 1,
    JSON.stringify(bands.status),
  );
}

// 帯を数える列 (CSS px)。[名前, x, 色]
// ヘッダー・フッターは中央に白い文字があり、中央列で数えると字画で帯が分断されて
// 1回しか写っていなくても複数回に数えてしまう。文字の無い左寄りの列で数える。
function bandColumns(scenario) {
  const { off, contentW } = scenario;
  if (scenario.fixture === "standard") {
    const left = off.x + contentW * 0.1;
    return [
      ["header", left, "magenta"],
      ["footer", left, "cyan"],
      ["widget", off.x + contentW - 50, "yellow"],
      ["side", off.x + contentW - 50, "green"],
      ["outer", off.x + contentW / 2, "gray"],
    ];
  }
  return [
    ["top", off.x + contentW / 2, "gray"],
    ["widget", VIEW_W - 50, "yellow"],
    ["nav", 180, "orange"], // SIDEBAR の文字を避けた右寄りの列
    ["status", 100, "blue"],
  ];
}

// --remote-debugging-port=0 で起動すると、実際に使ったポートがこのファイルに書かれる。
async function waitForDevToolsPort(userDataDir) {
  const file = path.join(userDataDir, "DevToolsActivePort");
  for (let i = 0; i < 200; i++) {
    const port = fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").split("\n")[0]
      : "";
    if (port) return port;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("ブラウザのデバッグポートが開かない");
}

// シナリオごとにブラウザを立て直す。撮影のたびにデバッガの付け外しが起きるので、
// 前のシナリオの状態を持ち越さないよう分離しておく。
//
// ブラウザは裏で起動し、作業中のアプリから前面を奪わない。
// Playwright の launch はバイナリを直接起動するため、起動時と newPage() のたびに
// ブラウザが前面へ出てしまう。そこで
//   1. open -g (前面にしない) + --no-startup-window (窓なし) で起動し
//   2. connectOverCDP で繋ぎ
//   3. ページは Target.createTarget({newWindow, background}) で裏の窓に開く
// 裏の窓でも描画を止めないよう、occluded 扱いによる間引きを切っておく。
// ヘッドレスにしないのは、高速モードの不具合がデバッガの警告バー(窓のUI)に絡むため。
async function withBrowser(ext, fn) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fpc-e2e-"));
  spawnSync("open", [
    "-g",
    "-n",
    "-a",
    BRAVE_APP,
    "--args",
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
  ]);
  const port = await waitForDevToolsPort(userDataDir);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const cdp = await browser.newBrowserCDPSession();

  // 撮影対象を裏の新しい窓に開き、内寸を VIEW_W×VIEW_H に合わせる。
  // ビューポートのエミュレーションは使わない — デバッガの付け外しで解除されるため。
  const openPage = async (url) => {
    const pagePromise = context.waitForEvent("page", { timeout: 20000 });
    const { targetId } = await cdp.send("Target.createTarget", {
      url,
      newWindow: true,
      background: true,
    });
    const page = await pagePromise;
    await page.waitForLoadState("load");
    const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget", {
      targetId,
    });
    const inner = await page.evaluate(() => [innerWidth, innerHeight]);
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        width: bounds.width + VIEW_W - inner[0],
        height: bounds.height + VIEW_H - inner[1],
      },
    });
    await page.waitForFunction(
      ([w, h]) => innerWidth === w && innerHeight === h,
      [VIEW_W, VIEW_H],
      { timeout: 10000 },
    );
    return page;
  };

  try {
    const sw =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker", { timeout: 20000 }));
    return await fn(context, sw, openPage);
  } finally {
    await cdp.send("Browser.close").catch(() => {});
  }
}

(async () => {
  const server = await startServer();
  const ext = buildTestExtension();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "fpc-out-"));
  try {
    // 高速モードを諦める条件。実撮影は重いので判定関数を直接呼ぶ。
    await withBrowser(ext, async (_context, sw) => {
      const blockers = await sw.evaluate(() => ({
        ok: fastModeBlocker(
          { scrollerKind: "document", pageW: 900, pageH: 4060 },
          2,
        ),
        tall: fastModeBlocker(
          { scrollerKind: "document", pageW: 900, pageH: 40000 },
          2,
        ),
        iframe: fastModeBlocker(
          { scrollerKind: "iframe", pageW: 900, pageH: 4060 },
          2,
        ),
        element: fastModeBlocker(
          { scrollerKind: "element", pageW: 900, pageH: 4060 },
          2,
        ),
      }));
      report(
        "通常サイズは高速モードを使う",
        blockers.ok === null,
        JSON.stringify(blockers.ok),
      );
      report(
        "64000pxを超えると高速モードを諦める",
        typeof blockers.tall === "string" &&
          blockers.tall.includes("大きすぎる"),
        JSON.stringify(blockers.tall),
      );
      report(
        "iframeが対象なら高速モードを諦める",
        typeof blockers.iframe === "string" &&
          blockers.iframe.includes("iframe"),
        JSON.stringify(blockers.iframe),
      );
      report(
        "スクロール領域が対象なら高速モードを諦める",
        typeof blockers.element === "string" &&
          blockers.element.includes("スクロール領域"),
        JSON.stringify(blockers.element),
      );
    });

    for (const scenario of SCENARIOS) {
      await withBrowser(ext, async (context, sw, openPage) => {
        const page = await openPage(scenario.url);
        await page.waitForTimeout(800);

        const result = await capture(context, sw, scenario.url);
        const info = await result.textContent("#info");
        console.log(`\n[${scenario.name}] ${info}`);

        report(
          `[${scenario.name}] ${scenario.method}モードで撮影される`,
          info.includes(scenario.method),
          `info="${info}"`,
        );

        const warn = await result.textContent("#warn");
        const kindNote = {
          document: warn === "",
          iframe: warn.includes("iframe"),
          element: warn.includes("スクロール領域"),
        };
        report(
          `[${scenario.name}] スクロール対象を ${scenario.kind} と判定`,
          kindNote[scenario.kind],
          `warn="${warn}"`,
        );
        if (scenario.kind !== "document") {
          report(
            `[${scenario.name}] 連写へ切り替えた理由が表示される`,
            warn.includes("高速モードが使えず"),
            `warn="${warn}"`,
          );
        }
        await checkImage(result, scenario);

        // 撮影で触ったスタイルとスクロール位置が元に戻っているか。
        // 期待値は各要素の元の状態 (fixed のまま・見えるまま・top は 0px のまま)。
        const restored = await page.evaluate((fixture) => {
          const style = (doc, id) => getComputedStyle(doc.getElementById(id));
          if (fixture === "sidebar") {
            return {
              scrollY: document.getElementById("main").scrollTop,
              styleTag: !!document.getElementById("__fpc-style"),
              navVis: style(document, "nav").visibility,
              widgetVis: style(document, "widget").visibility,
            };
          }
          const doc =
            document.querySelector("iframe")?.contentDocument ?? document;
          const scroller = doc.scrollingElement || doc.documentElement;
          return {
            scrollY: scroller.scrollTop,
            styleTag: !!doc.getElementById("__fpc-style"),
            headPos: style(doc, "head").position,
            footVis: style(doc, "foot").visibility,
            sideTop: style(doc, "side").top,
          };
        }, scenario.fixture);
        const expectedRestore =
          scenario.fixture === "sidebar"
            ? { scrollY: 0, styleTag: false, navVis: "visible", widgetVis: "visible" }
            : { scrollY: 0, styleTag: false, headPos: "fixed", footVis: "visible", sideTop: "0px" };
        report(
          `[${scenario.name}] 撮影後にページが復元される`,
          JSON.stringify(restored) === JSON.stringify(expectedRestore),
          JSON.stringify(restored),
        );

        if (!scenario.extras) {
          await result.close();
          await page.close();
          return;
        }

        // 保存形式とファイル名は通常ページのケースだけで確認する。
        const save = async (buttonId, setup, tag) => {
          if (setup) await setup();
          const [download] = await Promise.all([
            result.waitForEvent("download", { timeout: 120000 }),
            result.click("#" + buttonId),
          ]);
          const file = path.join(
            outDir,
            (tag ? tag + "-" : "") + download.suggestedFilename(),
          );
          await download.saveAs(file);
          await result.waitForFunction(
            () => !document.getElementById("save-png").disabled,
            null,
            {
              timeout: 120000,
            },
          );
          return { file, bytes: fs.readFileSync(file) };
        };

        const png = await save("save-png");
        report(
          `PNGで保存できる (${fmtSize(png.bytes.length)})`,
          png.file.endsWith(".png") &&
            png.bytes
              .subarray(0, 8)
              .equals(
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
              ),
        );

        const jpeg = await save("save-jpeg");
        report(
          `JPEGで保存できる (${fmtSize(jpeg.bytes.length)})`,
          jpeg.file.endsWith(".jpg") &&
            jpeg.bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
        );

        report(
          "PDFの既定は「1ページにまとめる」",
          (await result.inputValue("#pdf-layout")) === "single",
          `実際 ${await result.inputValue("#pdf-layout")}`,
        );

        const pdfA4 = await save(
          "save-pdf",
          () => result.selectOption("#pdf-layout", "a4"),
          "a4",
        );
        const a4Count = Number(
          /\/Count (\d+)/.exec(pdfA4.bytes.toString("latin1"))?.[1],
        );
        // 1800x8120px を幅595.28ptへ縮めると 1ページ 2545px 相当 → 4ページ
        report(
          `PDF(A4分割)で保存できる (${a4Count}ページ, ${fmtSize(pdfA4.bytes.length)})`,
          pdfA4.bytes.subarray(0, 5).toString("latin1") === "%PDF-" &&
            a4Count === 4,
          `count=${a4Count}`,
        );

        const pdfSingle = await save(
          "save-pdf",
          () => result.selectOption("#pdf-layout", "single"),
          "single",
        );
        const singleCount = Number(
          /\/Count (\d+)/.exec(pdfSingle.bytes.toString("latin1"))?.[1],
        );
        report(
          `PDF(1ページ)で保存できる (${singleCount}ページ, ${fmtSize(pdfSingle.bytes.length)})`,
          pdfSingle.bytes.subarray(0, 5).toString("latin1") === "%PDF-" &&
            singleCount === 1,
          `count=${singleCount}`,
        );

        // ファイル名テンプレート
        await sw.evaluate(() =>
          chrome.storage.sync.set({
            template: "%DOMAIN%-%TITLE%-%YEAR%%MONTH%%DAY%",
            maxLength: 100,
          }),
        );
        await result.waitForFunction(
          () =>
            document.getElementById("filename").value.startsWith("localhost-"),
          null,
          { timeout: 20000 },
        );
        const templated = await save("save-png", null, "tpl");
        const stamp = new Date();
        const expected =
          `localhost-FPC Fixture-${stamp.getFullYear()}` +
          String(stamp.getMonth() + 1).padStart(2, "0") +
          String(stamp.getDate()).padStart(2, "0") +
          ".png";
        report(
          `テンプレートが保存名に反映される (${path.basename(templated.file).replace(/^tpl-/, "")})`,
          path.basename(templated.file) === "tpl-" + expected,
          `期待 ${expected}`,
        );

        await sw.evaluate(() =>
          chrome.storage.sync.set({ template: "%TITLE%", maxLength: 12 }),
        );
        await result.evaluate(() => {
          captureMeta.title = 'a/b:c*d?e"f<g>h|i とても長いタイトル';
          return refreshFilename();
        });
        const shortName = await result.inputValue("#filename");
        report(
          `禁止文字を除去して指定文字数に収める ("${shortName}")`,
          shortName.length <= 12 && !/[\\/:*?"<>|]/.test(shortName),
          `長さ ${shortName.length}`,
        );

        // 結果ページの入力欄で任意の名前を付けられるか。
        // 拡張子まで打っても二重にならず、禁止文字は落とし、変数も展開する。
        await result.fill("#filename", "メモ/手入力 %YEAR%.png");
        const custom = await save("save-png", null, "custom");
        const customExpected = `メモ_手入力 ${new Date().getFullYear()}.png`;
        report(
          `入力欄の名前で保存できる (${path.basename(custom.file).replace(/^custom-/, "")})`,
          path.basename(custom.file) === "custom-" + customExpected,
          `期待 ${customExpected}`,
        );

        // 手入力した名前は設定を変えても上書きされない。
        await sw.evaluate(() => chrome.storage.sync.set({ template: "%DOMAIN%" }));
        await result.waitForFunction(
          () => document.getElementById("filename").placeholder === "localhost",
          null,
          { timeout: 20000 },
        );
        const kept = await result.inputValue("#filename");
        report(
          "手入力した名前は設定変更で上書きされない",
          kept === "メモ/手入力 %YEAR%.png",
          kept,
        );

        // ↺ で設定の名前に戻り、空欄なら設定の名前で保存する。
        await result.click("#reset-filename");
        const reset = await result.inputValue("#filename");
        await result.fill("#filename", "");
        const empty = await save("save-png", null, "empty");
        report(
          "↺で設定の名前に戻り、空欄なら設定の名前で保存する",
          reset === "localhost" &&
            path.basename(empty.file) === "empty-localhost.png",
          `reset=${reset} file=${path.basename(empty.file)}`,
        );

        // 長すぎて1ページに収まらない場合は A4分割へ退避するか。
        // canvasの中身を捨てる操作なので、他の検証をすべて終えてから行う。
        const fallback = await result.evaluate(() => {
          const c = document.getElementById("canvas");
          c.height = 70000; // 幅595ptに縮めても14400ptを超える高さ
          updatePdfLayoutOptions();
          const option = document.querySelector(
            '#pdf-layout option[value="single"]',
          );
          return {
            value: document.getElementById("pdf-layout").value,
            disabled: option.disabled,
          };
        });
        report(
          "1ページに収まらない場合はA4分割へ退避する",
          fallback.value === "a4" && fallback.disabled === true,
          JSON.stringify(fallback),
        );

        // 次のシナリオに影響しないよう既定へ戻す
        await sw.evaluate(() => chrome.storage.sync.clear());
        await result.close();
        await page.close();
      });
    }

    console.log("\n書き出したファイル: " + outDir);
  } finally {
    server.close();
  }

  console.log(
    failures.length === 0 ? "\nPASS" : `\nFAIL (${failures.length}件)`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
})();
