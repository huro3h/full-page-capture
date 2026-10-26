// タイルを1枚ずつ取り出してcanvasへ合成し、PNG / JPEG / PDF として保存する。
// service worker 側ではなくこのページで合成するのは、DOM のある文脈の方が
// blob URL の寿命を気にせずダウンロードまで完結できるため。

// Chrome のcanvas上限。辺は65535px、面積はおよそ2^28px。
const MAX_SIDE = 65535;
const MAX_AREA = 268435456;

const JPEG_QUALITY = 0.92;
// PDFに埋め込むJPEGは少し強めに圧縮する。ページ数ぶん積み上がるため。
const PDF_JPEG_QUALITY = 0.85;

// A4縦 (210×297mm) をポイントで。
const A4 = { w: 595.28, h: 841.89 };
// 多くのPDFビューアが扱えるページの辺の上限 (200インチ)。
const PDF_MAX_SIDE = 14400;

const canvas = document.getElementById("canvas");
const info = document.getElementById("info");
const warn = document.getElementById("warn");
const pdfLayout = document.getElementById("pdf-layout");
const filenameInput = document.getElementById("filename");
const resetFilename = document.getElementById("reset-filename");
const openOptions = document.getElementById("open-options");
const buttons = {
  png: document.getElementById("save-png"),
  jpeg: document.getElementById("save-jpeg"),
  pdf: document.getElementById("save-pdf"),
};

// 設定のテンプレートから作った名前。入力欄を空にしたときもこれで保存する。
let presetName = "capture";
// 入力欄を手で書き換えたか。書き換えた後は設定変更で上書きしない。
let filenameEdited = false;
let summary = "";
// 撮影したページの情報と撮影時刻。ファイル名テンプレートの展開に使う。
let captureMeta = null;
let capturedAt = null;

// 手入力の名前に付ける長さの上限。設定の最大文字数は自動生成の名前を抑えるためのもので、
// 自分で打った名前を黙って切り詰めるのは不親切なので、OSの上限の手前だけで止める。
const CUSTOM_NAME_MAX = 200;
// 拡張子まで打たれた場合に二重にならないよう落とす。
const TYPED_EXTENSION = /\.(png|jpe?g|pdf)$/i;

const ask = (message) => chrome.runtime.sendMessage({ __fpcResult: true, ...message });

async function main() {
  const head = await ask({ type: "meta" });
  if (!head || head.error) {
    info.textContent = head?.error || "撮影結果を取得できませんでした";
    return;
  }

  const { meta, count } = head;
  const notes = [];
  // 撮影対象の可視領域。通常のページではビューポート全体と一致する。
  const clip = meta.clip || { x: 0, y: 0, w: meta.viewW, h: meta.viewH };

  // 実寸(デバイスピクセル)。上限を超える場合だけ全体を縮小する。
  let width = Math.round(meta.pageW * meta.dpr);
  let height = Math.round(meta.pageH * meta.dpr);
  let scale = 1;
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_AREA) {
    scale = Math.min(MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
    width = Math.floor(width * scale);
    height = Math.floor(height * scale);
    notes.push(`canvas上限のため ${(scale * 100).toFixed(0)}% に縮小`);
  }

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < count; i++) {
    const { tile } = await ask({ type: "tile", index: i });
    if (!tile) continue;
    const blob = await (await fetch(tile.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    // 撮影画像はビューポート全体。スクロールコンテナやiframeが対象のときは、
    // その可視領域(clip)だけを切り出して使う。
    // 置く位置は実際に到達したスクロール座標。これだけで重なりも最後の半端な行も吸収される。
    ctx.drawImage(
      bitmap,
      Math.round(clip.x * meta.dpr),
      Math.round(clip.y * meta.dpr),
      Math.round(clip.w * meta.dpr),
      Math.round(clip.h * meta.dpr),
      Math.round(tile.x * meta.dpr * scale),
      Math.round(tile.y * meta.dpr * scale),
      Math.round(clip.w * meta.dpr * scale),
      Math.round(clip.h * meta.dpr * scale),
    );
    bitmap.close();
    info.textContent = `合成中… ${i + 1}/${count}`;
  }

  if (meta.scrollerKind === "iframe") notes.push("ページ内のiframeを撮影しました");
  else if (meta.scrollerKind === "element") notes.push("ページ内のスクロール領域を撮影しました");
  if (meta.fallbackReason) notes.push(`高速モードが使えず連写しました (${meta.fallbackReason})`);
  if (meta.grew) notes.push("撮影中にページが伸びました(開始時点の高さで打ち切り)");
  if (meta.truncated) notes.push("タイル数の上限に達したため途中で打ち切りました");
  // 高速モードは上限を超えると無言で全面黒を返す。手前で弾いてはいるが、
  // 掴んでしまった場合に気づかず保存させないよう最後に確かめる。
  if (meta.method === "fast" && isBlank(ctx, width, height)) {
    notes.push("画像が真っ黒です。設定で撮影方法を「連写」に変えて撮り直してください");
  }

  const methodLabel =
    meta.method === "fast" ? "高速" : meta.method === "visible" ? "表示範囲" : `連写 ${count}枚`;
  summary = `${width} × ${height} px / ${methodLabel} / ${meta.dpr.toFixed(2)}x`;
  info.textContent = summary;
  warn.textContent = notes.join(" · ");
  captureMeta = { title: meta.title, url: meta.url, width, height };
  capturedAt = new Date();
  await refreshFilename();
  updatePdfLayoutOptions();
  setBusy(false);
}

// 縦に散らした点がすべて純黒なら、撮影に失敗した画像とみなす。
// 本当に全面が真っ黒なページはまず無く、外したとしても出るのは警告文だけ。
function isBlank(ctx, width, height) {
  const x = Math.floor(width / 2);
  const samples = 24;
  for (let i = 0; i < samples; i++) {
    const y = Math.min(height - 1, Math.floor((height * i) / samples) + 8);
    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
    if (r !== 0 || g !== 0 || b !== 0) return false;
  }
  return true;
}

// ファイル名は設定ページのテンプレートから作る。
// 日時の変数には撮影時刻 (capturedAt) を渡す。展開のたびに現在時刻を使うと、
// 同じ撮影結果をPNG→PDFと続けて保存しただけで名前がずれてしまうため。
async function refreshFilename() {
  if (!captureMeta) return;
  const settings = await loadSettings();
  presetName = buildFilename(settings.template, captureMeta, settings.maxLength, capturedAt);
  filenameInput.placeholder = presetName;
  if (!filenameEdited) filenameInput.value = presetName;
}

// 保存に使う名前(拡張子なし)。入力欄の値をそのまま使い、空なら設定の名前に戻す。
// 手入力にも %DATE% などの変数を書けるよう、テンプレートとして展開する。
function baseName() {
  const typed = filenameInput.value.trim().replace(TYPED_EXTENSION, "");
  if (!typed || !captureMeta) return presetName;
  return buildFilename(typed, captureMeta, CUSTOM_NAME_MAX, capturedAt);
}

function setFilenameEdited(edited) {
  filenameEdited = edited;
  resetFilename.hidden = !edited;
}

filenameInput.addEventListener("input", () =>
  setFilenameEdited(filenameInput.value !== presetName),
);
// Enter で確定したらPNGで保存する。いちばん使う形式なので。
filenameInput.addEventListener("keydown", (event) => {
  if (event.isComposing) return; // 変換の確定・取り消しは日本語入力に任せる
  if (event.key === "Enter" && !buttons.png.disabled) buttons.png.click();
  if (event.key === "Escape") resetFilename.click();
});
resetFilename.addEventListener("click", () => {
  filenameInput.value = presetName;
  setFilenameEdited(false);
});
openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

// 設定ページで変えたら、開きっぱなしの結果ページにも即反映する。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && ("template" in changes || "maxLength" in changes)) void refreshFilename();
});

// 「1ページにまとめる」は、ページの辺がPDFの上限を超えると多くのビューアで開けない。
function updatePdfLayoutOptions() {
  const singleHeight = canvas.height * (A4.w / canvas.width);
  const option = pdfLayout.querySelector('option[value="single"]');
  if (singleHeight > PDF_MAX_SIDE) {
    option.disabled = true;
    option.textContent = `1ページにまとめる (長すぎて不可)`;
    pdfLayout.value = "a4";
  } else {
    option.disabled = false;
    option.textContent = "1ページにまとめる";
  }
}

function setBusy(busy, text) {
  for (const button of Object.values(buttons)) button.disabled = busy;
  pdfLayout.disabled = busy;
  info.textContent = busy && text ? text : summary;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const toBlob = (target, type, quality) =>
  new Promise((resolve) => target.toBlob(resolve, type, quality));

// canvasの一部を切り出してJPEGにする。PDFのページ分割で使う。
// JPEGは透過を持てないので、切り出し先を必ず白で塗ってから描く。
const sliceCanvas = document.createElement("canvas");
async function encodeSlice(sourceY, sliceHeight, quality) {
  sliceCanvas.width = canvas.width;
  sliceCanvas.height = sliceHeight;
  const ctx = sliceCanvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, sliceCanvas.width, sliceHeight);
  ctx.drawImage(canvas, 0, sourceY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
  const blob = await toBlob(sliceCanvas, "image/jpeg", quality);
  return new Uint8Array(await blob.arrayBuffer());
}

buttons.png.addEventListener("click", async () => {
  setBusy(true, "PNGを書き出し中…");
  try {
    download(await toBlob(canvas, "image/png"), `${baseName()}.png`);
  } finally {
    setBusy(false);
  }
});

buttons.jpeg.addEventListener("click", async () => {
  setBusy(true, "JPEGを書き出し中…");
  try {
    // 背景は合成時に白で塗ってあるので、そのまま変換してよい。
    download(await toBlob(canvas, "image/jpeg", JPEG_QUALITY), `${baseName()}.jpg`);
  } finally {
    setBusy(false);
  }
});

buttons.pdf.addEventListener("click", async () => {
  setBusy(true, "PDFを書き出し中…");
  try {
    const pages = [];
    const ptPerPx = A4.w / canvas.width; // 幅をA4に合わせる

    if (pdfLayout.value === "single") {
      const drawH = canvas.height * ptPerPx;
      pages.push({
        jpeg: await encodeSlice(0, canvas.height, PDF_JPEG_QUALITY),
        pxW: canvas.width,
        pxH: canvas.height,
        pageW: A4.w,
        pageH: drawH,
        drawW: A4.w,
        drawH,
        x: 0,
        y: 0,
      });
    } else {
      const sliceHeight = Math.floor(A4.h / ptPerPx);
      const total = Math.ceil(canvas.height / sliceHeight);
      for (let y = 0, i = 0; y < canvas.height; y += sliceHeight, i++) {
        const height = Math.min(sliceHeight, canvas.height - y);
        const drawH = height * ptPerPx;
        pages.push({
          jpeg: await encodeSlice(y, height, PDF_JPEG_QUALITY),
          pxW: canvas.width,
          pxH: height,
          pageW: A4.w,
          pageH: A4.h,
          drawW: A4.w,
          drawH,
          x: 0,
          // PDFの原点は左下。最後のページは中身が短いので上端に寄せる。
          y: A4.h - drawH,
        });
        info.textContent = `PDFを書き出し中… ${i + 1}/${total}ページ`;
      }
    }

    download(buildPdf(pages), `${baseName()}.pdf`);
  } finally {
    setBusy(false);
  }
});

void main();
