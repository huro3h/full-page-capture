// ファイル名テンプレートの展開。オプションページと結果ページの両方から使う。
// classic script として読み込むので、グローバルに関数を置く。

const FILENAME_DEFAULTS = {
  // 既定は「ページタイトル_日付-時刻」。
  template: "%TITLE%_%DATE%-%TIME%",
  maxLength: 100,
};

// 順序は、オプションページの一覧にそのまま出る順。
const FILENAME_TOKENS = [
  { token: "%TITLE%", label: "ページタイトル" },
  { token: "%DOMAIN%", label: "ドメイン名" },
  { token: "%PATH%", label: "URLのパス" },
  { token: "%URL%", label: "URL全体" },
  { token: "%DATE%", label: "日付 (20260911)" },
  { token: "%TIME%", label: "時刻 (143005)" },
  { token: "%YEAR%", label: "年 (2026)" },
  { token: "%MONTH%", label: "月 (09)" },
  { token: "%DAY%", label: "日 (11)" },
  { token: "%HOUR%", label: "時 (14)" },
  { token: "%MIN%", label: "分 (30)" },
  { token: "%SEC%", label: "秒 (05)" },
  { token: "%WIDTH%", label: "画像の幅 (px)" },
  { token: "%HEIGHT%", label: "画像の高さ (px)" },
];

// ファイル名に使えない文字。OSごとに差があるので、いちばん厳しいWindowsに合わせる。
// 制御文字が混ざるとダウンロード自体が失敗するので、まとめて落とす。
const ILLEGAL = /[\\/:*?"<>|\x00-\x1f\x7f]/g;
// Windowsが予約している名前。拡張子を付けても使えない。
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitizeFilenamePart(value) {
  return String(value ?? "")
    .replace(ILLEGAL, "_")
    .replace(/\s+/g, " ")
    .trim();
}

// テンプレートに入れる値を作る。meta は撮影時のページ情報。
function filenameValues(meta, now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const year = String(now.getFullYear());
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hour = pad(now.getHours());
  const min = pad(now.getMinutes());
  const sec = pad(now.getSeconds());

  let domain = "";
  let path = "";
  try {
    const url = new URL(meta.url);
    domain = url.hostname;
    // パスはスラッシュを含むので区切りをハイフンへ。末尾スラッシュは落とす。
    path = url.pathname.replace(/^\/|\/$/g, "").replace(/\//g, "-");
  } catch {
    // about:blank などURLとして解釈できない場合は空のままにする
  }

  return {
    "%TITLE%": meta.title || domain || "capture",
    "%DOMAIN%": domain,
    "%PATH%": path,
    "%URL%": String(meta.url || "").replace(/^https?:\/\//, ""),
    "%DATE%": year + month + day,
    "%TIME%": hour + min + sec,
    "%YEAR%": year,
    "%MONTH%": month,
    "%DAY%": day,
    "%HOUR%": hour,
    "%MIN%": min,
    "%SEC%": sec,
    "%WIDTH%": String(meta.width ?? ""),
    "%HEIGHT%": String(meta.height ?? ""),
  };
}

// テンプレートを展開してファイル名(拡張子なし)にする。
function buildFilename(template, meta, maxLength, now) {
  const values = filenameValues(meta, now);
  // 値そのものは個別にサニタイズする。テンプレート側の区切り文字を巻き込まないため。
  let name = String(template || FILENAME_DEFAULTS.template).replace(
    /%[A-Z]+%/g,
    (token) => (token in values ? sanitizeFilenamePart(values[token]) : token),
  );

  // テンプレート自体に紛れ込んだ禁止文字も落とす。
  name = name.replace(ILLEGAL, "_").replace(/\s+/g, " ").trim();
  // 先頭・末尾のドットはOSによって隠しファイル扱いや拒否になる。
  name = name.replace(/^\.+/, "").replace(/\.+$/, "");

  const limit = Number(maxLength) > 0 ? Number(maxLength) : FILENAME_DEFAULTS.maxLength;
  if (name.length > limit) name = name.slice(0, limit).trim();

  if (!name || RESERVED.test(name)) name = "capture";
  return name;
}

async function loadFilenameSettings() {
  try {
    const stored = await chrome.storage.sync.get(FILENAME_DEFAULTS);
    return { ...FILENAME_DEFAULTS, ...stored };
  } catch {
    return { ...FILENAME_DEFAULTS };
  }
}
