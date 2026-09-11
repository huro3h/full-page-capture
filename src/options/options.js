// 設定ページ。入力のたびに保存し、プレビューを更新する。

// プレビュー用のダミー。実際の撮影結果を使わずに形だけ見せる。
const SAMPLE_META = {
  title: "サンプルページのタイトル",
  url: "https://example.com/docs/getting-started",
  width: 1800,
  height: 8120,
};

const PRESETS = [
  { label: "既定", template: "%TITLE%_%DATE%-%TIME%" },
  { label: "ドメイン優先", template: "%DOMAIN%_%TITLE%_%DATE%" },
  { label: "日付フォルダ風", template: "%YEAR%-%MONTH%-%DAY%_%TITLE%" },
  { label: "時刻のみ", template: "%DATE%-%TIME%" },
  { label: "サイズ付き", template: "%TITLE%_%WIDTH%x%HEIGHT%" },
];

const templateInput = document.getElementById("template");
const maxLengthInput = document.getElementById("maxLength");
const preview = document.getElementById("preview");
const status = document.getElementById("status");

let statusTimer = 0;
function flashStatus(text) {
  status.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.textContent = ""), 1600);
}

function renderPreview() {
  const name = buildFilename(templateInput.value, SAMPLE_META, maxLengthInput.value);
  // 変数として解釈されなかった %...% が残っていれば、綴り間違いの可能性が高い。
  const unknown = templateInput.value.match(/%[A-Z]+%/g)?.filter((t) => name.includes(t)) ?? [];
  if (unknown.length) {
    preview.classList.add("invalid");
    preview.textContent = `${name}.png  ← ${unknown.join(", ")} は変数として認識されていません`;
  } else {
    preview.classList.remove("invalid");
    preview.textContent = `${name}.png`;
  }
}

async function save() {
  const maxLength = Math.min(200, Math.max(10, Number(maxLengthInput.value) || FILENAME_DEFAULTS.maxLength));
  await chrome.storage.sync.set({ template: templateInput.value, maxLength });
  renderPreview();
  flashStatus("保存しました");
}

// カーソル位置に変数を差し込む。末尾に追記するだけだと編集しづらい。
function insertToken(token) {
  const start = templateInput.selectionStart ?? templateInput.value.length;
  const end = templateInput.selectionEnd ?? start;
  templateInput.value =
    templateInput.value.slice(0, start) + token + templateInput.value.slice(end);
  const caret = start + token.length;
  templateInput.setSelectionRange(caret, caret);
  templateInput.focus();
  void save();
}

function renderTokens() {
  const container = document.getElementById("tokens");
  for (const { token, label } of FILENAME_TOKENS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = token;
    const note = document.createElement("span");
    note.textContent = label;
    button.appendChild(note);
    button.addEventListener("click", () => insertToken(token));
    container.appendChild(button);
  }
}

function renderPresets() {
  const container = document.getElementById("presets");
  for (const { label, template } of PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${label}: ${template}`;
    button.addEventListener("click", () => {
      templateInput.value = template;
      void save();
    });
    container.appendChild(button);
  }
}

document.getElementById("reset").addEventListener("click", async () => {
  templateInput.value = FILENAME_DEFAULTS.template;
  maxLengthInput.value = FILENAME_DEFAULTS.maxLength;
  await save();
});

templateInput.addEventListener("input", () => {
  renderPreview();
  void save();
});
maxLengthInput.addEventListener("input", () => {
  renderPreview();
  void save();
});

(async () => {
  const settings = await loadFilenameSettings();
  templateInput.value = settings.template;
  maxLengthInput.value = settings.maxLength;
  renderTokens();
  renderPresets();
  renderPreview();
})();
