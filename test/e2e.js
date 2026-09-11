// 合成結果のピクセルを直接検証するE2Eテスト。
//   node test/e2e.js
// Playwright が必要: PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
//
// 検証の考え方: フィクスチャの各行に一意な色を割り当て、合成画像の
// 「文書座標 → 色」が一致するかを見る。ずれ・欠け・二重描画があれば必ず落ちる。
// 通常のページと、本文が同一オリジンiframeに入ったページの2通りで回す。

const { chromium } = require("playwright");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");

const BRAVE = "/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly";
const SRC = path.resolve(__dirname, "..");
const PORT = 8931;
const ORIGIN = `http://localhost:${PORT}`;

const VIEW_W = 900;
const VIEW_H = 700;
const HEAD_H = 60; // fixture.html の body padding-top
const ROW_H = 100;
const ROWS = 40;

// contentW = 撮影対象の幅。直接撮るならビューポート幅、iframeならiframeの幅。
const SCENARIOS = [
  { name: "通常のページ", url: `${ORIGIN}/`, contentW: VIEW_W, kind: "document", extras: true },
  { name: "同一オリジンiframe", url: `${ORIGIN}/iframe`, contentW: 760, kind: "iframe", extras: false },
];

function startServer() {
  const direct = fs.readFileSync(path.join(__dirname, "fixture.html"));
  const framed = fs.readFileSync(path.join(__dirname, "fixture-iframe.html"));
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(req.url.startsWith("/iframe") ? framed : direct);
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
  console.log(`${ok ? "  ok  " : "  NG  "} ${label}${ok || !detail ? "" : "  " + detail}`);
  if (!ok) failures.push(label);
}

const fmtSize = (n) =>
  n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + "MB" : Math.round(n / 1024) + "KB";

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
  await result.waitForFunction(() => !document.getElementById("save-png").disabled, null, {
    timeout: 180000,
  });
  return result;
}

async function checkImage(result, scenario) {
  const samples = await result.evaluate(
    ({ contentW, headH, rowH, rows }) => {
      const c = document.getElementById("canvas");
      const ctx = c.getContext("2d");
      const dpr = c.width / contentW;
      const out = [];
      for (let i = 0; i < rows; i++) {
        const y = Math.round((headH + i * rowH + rowH / 2) * dpr);
        const px = ctx.getImageData(Math.round(20 * dpr), y, 1, 1).data;
        out.push([i, px[0], px[1], px[2]]);
      }
      return { dpr, w: c.width, h: c.height, out };
    },
    { contentW: scenario.contentW, headH: HEAD_H, rowH: ROW_H, rows: ROWS },
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

  const expectedW = Math.round(scenario.contentW * samples.dpr);
  const expectedH = Math.round((HEAD_H + ROWS * ROW_H) * samples.dpr);
  report(
    `[${scenario.name}] 画像サイズ ${samples.w}×${samples.h} == 内容サイズ ${expectedW}×${expectedH}`,
    samples.w === expectedW && samples.h === expectedH,
  );

  const bands = await result.evaluate(() => {
    const c = document.getElementById("canvas");
    const ctx = c.getContext("2d");
    const count = (x, pred) => {
      const d = ctx.getImageData(x, 0, 1, c.height).data;
      let n = 0;
      let inBand = false;
      for (let y = 0; y < c.height; y++) {
        const hit = pred(d[y * 4], d[y * 4 + 1], d[y * 4 + 2]);
        if (hit && !inBand) n++;
        inBand = hit;
      }
      return n;
    };
    const mid = Math.round(c.width / 2);
    const right = c.width - 100;
    return {
      header: count(mid, (r, g, b) => r > 240 && g < 20 && b > 240),
      footer: count(mid, (r, g, b) => r < 20 && g > 240 && b > 240),
      widget: count(right, (r, g, b) => r > 240 && g > 240 && b < 20),
      side: count(right, (r, g, b) => r < 20 && g > 240 && b < 20),
      // 外側のページのグレー(#888)。iframeのクリップが効いていれば1回も出ない。
      outer: count(mid, (r, g, b) => Math.abs(r - 136) < 6 && Math.abs(g - 136) < 6 && Math.abs(b - 136) < 6),
    };
  });
  report(`[${scenario.name}] 固定ヘッダーは1回だけ写る`, bands.header === 1, `実際 ${bands.header}`);
  report(`[${scenario.name}] 固定フッターは写らない`, bands.footer === 0, `実際 ${bands.footer}`);
  report(`[${scenario.name}] 浮遊ウィジェットは写らない`, bands.widget === 0, `実際 ${bands.widget}`);
  report(`[${scenario.name}] stickyサイドバーは1回だけ写る`, bands.side === 1, `実際 ${bands.side}`);
  if (scenario.kind === "iframe") {
    report(`[${scenario.name}] 外側のページが写り込まない`, bands.outer === 0, `実際 ${bands.outer}`);
  }
}

(async () => {
  const server = await startServer();
  const ext = buildTestExtension();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fpc-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: BRAVE,
    headless: false,
    viewport: { width: VIEW_W, height: VIEW_H },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "fpc-out-"));
  try {
    const sw =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker", { timeout: 20000 }));

    for (const scenario of SCENARIOS) {
      const page = await context.newPage();
      await page.goto(scenario.url, { waitUntil: "load" });
      await page.waitForTimeout(800);

      const result = await capture(context, sw, scenario.url);
      console.log(`\n[${scenario.name}] ${await result.textContent("#info")}`);

      const warn = await result.textContent("#warn");
      report(
        `[${scenario.name}] スクロール対象を ${scenario.kind} と判定`,
        scenario.kind === "iframe" ? warn.includes("iframe") : warn === "",
        `warn="${warn}"`,
      );
      await checkImage(result, scenario);

      const restored = await page.evaluate(() => {
        const doc = document.querySelector("iframe")?.contentDocument ?? document;
        const scroller = doc.scrollingElement || doc.documentElement;
        return {
          scrollY: scroller.scrollTop,
          styleTag: !!doc.getElementById("__fpc-style"),
          headPos: getComputedStyle(doc.getElementById("head")).position,
          footVis: getComputedStyle(doc.getElementById("foot")).visibility,
          sideTop: getComputedStyle(doc.getElementById("side")).top,
        };
      });
      report(
        `[${scenario.name}] 撮影後にページが復元される`,
        restored.scrollY === 0 &&
          !restored.styleTag &&
          restored.headPos === "fixed" &&
          restored.footVis === "visible" &&
          restored.sideTop === "0px",
        JSON.stringify(restored),
      );

      if (!scenario.extras) {
        await result.close();
        await page.close();
        continue;
      }

      // 保存形式とファイル名は通常ページのケースだけで確認する。
      const save = async (buttonId, setup, tag) => {
        if (setup) await setup();
        const [download] = await Promise.all([
          result.waitForEvent("download", { timeout: 120000 }),
          result.click("#" + buttonId),
        ]);
        const file = path.join(outDir, (tag ? tag + "-" : "") + download.suggestedFilename());
        await download.saveAs(file);
        await result.waitForFunction(() => !document.getElementById("save-png").disabled, null, {
          timeout: 120000,
        });
        return { file, bytes: fs.readFileSync(file) };
      };

      const png = await save("save-png");
      report(
        `PNGで保存できる (${fmtSize(png.bytes.length)})`,
        png.file.endsWith(".png") &&
          png.bytes
            .subarray(0, 8)
            .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      );

      const jpeg = await save("save-jpeg");
      report(
        `JPEGで保存できる (${fmtSize(jpeg.bytes.length)})`,
        jpeg.file.endsWith(".jpg") && jpeg.bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
      );

      report(
        "PDFの既定は「1ページにまとめる」",
        (await result.inputValue("#pdf-layout")) === "single",
        `実際 ${await result.inputValue("#pdf-layout")}`,
      );

      const pdfA4 = await save("save-pdf", () => result.selectOption("#pdf-layout", "a4"), "a4");
      const a4Count = Number(/\/Count (\d+)/.exec(pdfA4.bytes.toString("latin1"))?.[1]);
      // 1800x8120px を幅595.28ptへ縮めると 1ページ 2545px 相当 → 4ページ
      report(
        `PDF(A4分割)で保存できる (${a4Count}ページ, ${fmtSize(pdfA4.bytes.length)})`,
        pdfA4.bytes.subarray(0, 5).toString("latin1") === "%PDF-" && a4Count === 4,
        `count=${a4Count}`,
      );

      const pdfSingle = await save(
        "save-pdf",
        () => result.selectOption("#pdf-layout", "single"),
        "single",
      );
      const singleCount = Number(/\/Count (\d+)/.exec(pdfSingle.bytes.toString("latin1"))?.[1]);
      report(
        `PDF(1ページ)で保存できる (${singleCount}ページ, ${fmtSize(pdfSingle.bytes.length)})`,
        pdfSingle.bytes.subarray(0, 5).toString("latin1") === "%PDF-" && singleCount === 1,
        `count=${singleCount}`,
      );

      // ファイル名テンプレート
      await sw.evaluate(() =>
        chrome.storage.sync.set({ template: "%DOMAIN%-%TITLE%-%YEAR%%MONTH%%DAY%", maxLength: 100 }),
      );
      await result.waitForFunction(
        () => document.getElementById("open-options").textContent.startsWith("localhost-"),
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

      await sw.evaluate(() => chrome.storage.sync.set({ template: "%TITLE%", maxLength: 12 }));
      await result.evaluate(() => {
        captureMeta.title = 'a/b:c*d?e"f<g>h|i とても長いタイトル';
        return refreshFilename();
      });
      const shortName = await result.textContent("#open-options");
      report(
        `禁止文字を除去して指定文字数に収める ("${shortName}")`,
        shortName.length <= 12 && !/[\\/:*?"<>|]/.test(shortName),
        `長さ ${shortName.length}`,
      );

      // 長すぎて1ページに収まらない場合は A4分割へ退避するか。
      // canvasの中身を捨てる操作なので、他の検証をすべて終えてから行う。
      const fallback = await result.evaluate(() => {
        const c = document.getElementById("canvas");
        c.height = 70000; // 幅595ptに縮めても14400ptを超える高さ
        updatePdfLayoutOptions();
        const option = document.querySelector('#pdf-layout option[value="single"]');
        return { value: document.getElementById("pdf-layout").value, disabled: option.disabled };
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
    }

    console.log("\n書き出したファイル: " + outDir);
  } finally {
    await context.close();
    server.close();
  }

  console.log(failures.length === 0 ? "\nPASS" : `\nFAIL (${failures.length}件)`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
