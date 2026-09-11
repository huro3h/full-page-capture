---
name: full-page-capture
description: full-page-capture (ページ全体スクリーンショット拡張) の実装を読む・直すときに使う。連写と合成の座標設計、固定要素の扱い、captureVisibleTabのレート制限、E2Eテストの回し方。
---

# full-page-capture 開発メモ

## 撮影方法は2通りある

| モード | 仕組み | 実測(MDN, 文書31844px) |
| --- | --- | --- |
| **高速**(既定) | `chrome.debugger` → CDP `Page.captureScreenshot({captureBeyondViewport:true})` を1回 | 6.4秒 |
| 連写 | `captureVisibleTab` + スクロール + 合成 | 31.4秒 |

高速モードは DevTools の「Capture full size screenshot」と同じ経路。
`debugger` 権限が要るためウェブストア審査は厳しいが、
**このプロジェクトは未パッケージ運用と決めた**ので採用している。

### 高速モードを諦める条件 (`fastModeBlocker`)

1. `meta.scrollerKind !== "document"` — CDPはタブの最上位ドキュメントしか撮れない。
   iframeやスクロール領域が本文なら連写でないと中身が撮れない
2. 画像の辺が **64000px** を超える — 下記の無言破綻を避けるため
3. `chrome.debugger.attach` / `sendCommand` が失敗した場合

いずれも `meta.fallbackReason` に理由を入れ、結果ページに表示する。

### captureBeyondViewport の罠 (どちらも実測済み)

**その1: 65535px を超えると無言で真っ黒を返す。**
例外も警告も出ず、正しい寸法の完全な黒画像が返る。境界を詰めた結果:

```
画像高さ 65520px → 正常
画像高さ 65720px → 黒率100%
```

canvasと同じテクスチャ上限だが、canvasは例外を投げるのにCDPは成功したふりをする。
デバッガを繋ぐと警告バーのぶんビューポートが縮んで再レイアウトが起きるため、
予測値には余裕を持たせて **64000px** で切っている。
それでも掴んでしまった場合に備え、結果ページ側で `isBlank()` が縦24点を見て警告を出す。

**その2: fixed / sticky が画面数ぶん繰り返されることがある。**
captureBeyondViewport は「ビューポートを全高に広げて1回描く」場合と
「画面ぶんずつ区切って描いて繋ぐ」場合があり、**どちらになるかは実行ごとに変わる**
(同一条件の3回中2回が繰り返しになった)。後者だと固定ヘッダーが6回焼き付き、
内容が1画面分ずれる。

連写モードのように1枚ずつ制御できないので、**撮る前に固定をやめさせる**しかない。
`content.js` の `flatten()` が:

- 上端のヘッダー(`anchorTop`) → `position: absolute` で文書の先頭へ流す
  (消さずに済み、繰り返しも起きない)
- その他の fixed → `visibility: hidden`
- sticky → `position: static` まで落とす
  (基準位置を飛ばす連写モードの手では区切り描画に耐えない。
   sticky は通常フローでの配置が static と同じなのでレイアウトは動かない)

## なぜこの作りなのか

ブラウザに「ページ全体を撮る」APIは無い。使えるのは `chrome.tabs.captureVisibleTab` だけで、
これは**今見えているビューポート**しか返さない。よって
「スクロール → 撮る」を繰り返して1枚に合成する以外に方法がない。

この設計は FireShot (Chrome ウェブストアの
"Take Webpage Screenshots Entirely", ID `mcbpblocgmgfnpjjppndjkmgjaogfceg`) の
実装を読んで確認した方針をなぞっている。CRXは以下で取得でき、難読化されていないので読める:

```bash
curl -sL -o ext.crx "https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=130.0&x=id%3D<拡張ID>%26uc"
unzip ext.crx -d src   # CRX3ヘッダのぶん警告が出るが展開できる
```

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `src/scripts/background.js` | 撮影のオーケストレーション。スクロール指示・連写・タイル保持 |
| `src/scripts/content.js` | ページ側の下ごしらえとスクロール実行。`executeScript` で都度注入 |
| `src/result/result.js` | タイルを1枚ずつ引き取ってcanvasへ合成、PNG保存 |
| `test/e2e.js` + `test/fixture.html` | 合成画像のピクセルを直接見るE2E |

## 設計の要点

### タイルは「実際に到達したスクロール座標」に置く

これが合成部分のほぼ全て。要求した座標ではなく `scrollTop` の実測値を返させ、
`ctx.drawImage(bitmap, at.x * dpr, at.y * dpr)` で置く。この一手で

- タイル同士の**重なり** (後のタイルが前を上書きする)
- ページ末尾の**半端な行** (これ以上スクロールできず前のタイルと大きく重なる)

の両方が自動的に吸収される。行の高さを計算して継ぎ目を合わせる必要はない。

### スクロールの主体はドキュメントとは限らない

`document.scrollingElement` が動かないページがある。`findScrollTarget()` が

1. ドキュメント (`scrollHeight - clientHeight > 200`)
2. ページ内のスクロールコンテナ (`overflow-y: auto|scroll|overlay` で、
   面積がビューポートの25%以上)
3. **同一オリジンiframeの中のドキュメント** (`iframe.contentDocument`)

の順に探し、いちばん大きくスクロールできるものを選ぶ。
実例: HackMD の `https://hackmd.io/community/@user/note` はノート本体を
同一オリジンのiframe (`?embed=true`) に入れており、**親ページは1pxも動かない**。
`/community/` を外した `https://hackmd.io/@user/note` なら親が普通にスクロールする。

### 対象がドキュメント以外のときの座標

撮影画像は常に**ビューポート全体**なので、コンテナの可視領域だけを切り出す必要がある。
`prepare()` が `clip = {x, y, w, h}` (トップのビューポート座標) を返し、
結果ページが `drawImage` の9引数版で切り出す。通常のページでは
`clip = {0, 0, ビューポート幅, ビューポート高}` になり、同じコードが素通りする。

出力画像のサイズは **`scrollHeight - clientHeight + clip.h`**。
単純に `scrollHeight` としないのは、コンテナが画面からはみ出していると
一度に撮れる量が `clientHeight` より小さくなり、最下部まで到達できないため。
タイルを置く位置は `scrollTop` そのままでよく、画像の原点がコンテナ可視領域の左上に対応する。

**dprの算出に注意**: 撮影画像はビューポート全体なので、
`撮影画像の幅 ÷ コンテナ幅` ではなく `÷ ウィンドウ幅` で求める。
`prepare()` が `windowW` を別途返しているのはこのため。ここを間違えると
iframeを撮ったときだけ倍率がずれる。

クロスオリジンiframeは `contentDocument` が読めないので対象外。
全フレームに注入して連携すれば対応できるが、未実装
(FireShotは `fsFrames.js` でそこまでやっている)。

### デバイスピクセル比は `devicePixelRatio` から取らない

最初に1枚撮り、**撮れた画像の幅 ÷ ビューポート幅**で求める。
Retina・ブラウザズーム・OSスケーリングが混ざると `devicePixelRatio` だけでは
1pxずれる。FireShotも同じ逆算をしている (service worker 内で
`capturedWidth / tab.width` を比較している箇所がある)。

### 固定要素は3種類に分けて扱う

何もしないと `position: fixed` / `sticky` の要素が1コマごとに写り込んで縞模様になる。
一方で全部消すと、完成画像の先頭にナビが無くて不自然になる。そこで:

| 種類 | 判定 | 扱い |
| --- | --- | --- |
| sticky | `position: sticky` | `top: -1000000000px` / `bottom: 1000000000px` を当てる |
| 上端の固定ヘッダー | `position: fixed` かつ `rect.top <= 8` かつ 幅がビューポートの60%以上 | 1枚目だけ表示、2枚目以降は `visibility: hidden` |
| その他の固定要素 | 上記以外の `fixed` | 常に `visibility: hidden` |

sticky を `position: static` ではなく**基準位置を飛ばして**解除しているのが肝。
`static` や `display: none` はレイアウトを変えてしまうが、
`top` をあり得ない値にすると貼り付きが一度も成立せず、要素は素の流れの位置に落ち着く。
レイアウトは動かない。この手は FireShot の `fsContent.js` から借りた。

**判定の閾値でハマった**: 最初は「ビューポート上半分にあれば固定ヘッダー」
(`rect.top < vh / 2`) にしていたら、`top: 300px` に浮くチャットウィジェットを
ヘッダーと誤判定して1枚目に写り込んだ。ヘッダーは「**最上端に貼り付いた横長の帯**」
という形をしているので、位置と幅の両方で見る必要がある。

**ビューポート大の要素は触らない**: `rect.width >= vw * 0.9 && rect.height >= vh * 0.9`
の固定要素はモーダルの背景やページ本体のラッパーであって、ヘッダーではない。
これを動かすとページが壊れる。

### `captureVisibleTab` のレート制限

1秒あたり2回まで (`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`)。超えると
`chrome.runtime.lastError` が返るだけで画像は来ない。最初から
`CAPTURE_INTERVAL_MS = 520` の間隔を空けたうえで、失敗時はリトライする。
**長いページの所要時間はここで決まる** (実測: MDNの長いリファレンスで49枚・31秒)。

### スクロール前に消しておくもの

- **スクロールバー**: `overflow: hidden` ではなく `::-webkit-scrollbar { display: none }` +
  `scrollbar-width: none`。`overflow: hidden` をスクローラに当てるとスクロールできなくなる
- **`scroll-behavior: smooth`**: これが効いていると `scrollTo` がアニメーションになり、
  撮影とスクロールがずれて継ぎ目が破綻する。`auto !important` で潰す
- **アニメーション/トランジション**: コマごとに違う状態が写る
- **`background-attachment: fixed`**: パララックス背景がスクロールに追従せず縞になる

計測は**スクロールバーを消したあと**に行う。消す前後で `innerWidth` と
`clientWidth` がずれるため。FireShotが `preStep1` / `preStep2` と2段階で
測っているのはこれが理由。

### 合成は結果ページでやる (service workerではない)

MV3のservice workerでも `OffscreenCanvas` は使えるが、
blob URLの寿命がワーカーの生存に縛られ、そのままダウンロードへ繋げにくい。
DOMのある結果ページで合成すれば `URL.createObjectURL` + `<a download>` で完結する。
タイルはservice workerが配列で保持し、結果ページが**1枚ずつ**引き取る
(まとめて渡すとメッセージが大きくなりすぎる)。

## ファイル名テンプレート

`src/lib/filename.js` が展開を担い、設定ページと結果ページの両方から
classic script として読み込まれる (グローバル関数を置く方式)。
設定は `chrome.storage.sync` に `{ template, maxLength }` で入る。

変数の記法は `%TITLE%` 形式。FireShot も同じ流儀 (`%VERSION%` などが残っている)
で、`{}` と違ってURLのパーセントエンコーディング (`%20`) と衝突しない
— 展開の正規表現が `/%[A-Z]+%/g` なので、数字を含む `%20` にはマッチしない。

### サニタイズの順序に意味がある

1. **変数の値を個別にサニタイズ**してから差し込む
2. その後でテンプレート由来の禁止文字を落とす

逆にすると、テンプレートの区切り文字 (`_` や `-`) を巻き込んで壊す。
禁止文字はいちばん厳しいWindowsに合わせ、`\\ / : * ? " < > |` に加えて
**制御文字 (`\x00-\x1f`, `\x7f`) も落とす** — 混ざるとダウンロード自体が失敗する。
Windowsの予約名 (`CON`, `PRN`, `LPT1` など) に化けた場合は `capture` に戻す。

### 日時は「保存時刻」ではなく「撮影時刻」で固定する

`refreshFilename()` は `buildFilename(..., capturedAt)` と撮影時刻を明示的に渡す。
展開のたびに `new Date()` を使うと、**同じ撮影結果をPNG→PDFと続けて保存しただけで
名前がずれる**。テンプレートを設定ページで変更した際の再展開でも同じ時刻を使う。

### 実装中にひっかかったこと

禁止文字の正規表現を書くとき、文字クラスに**制御文字を生バイトで埋め込んでしまった**。
`grep` がファイルをバイナリ扱いして何も返さなくなり、原因の特定に遠回りした。
エディタ上は `| -]` のように見えるので気づきにくい。
正規表現に制御文字を入れるときは必ず `\x00` のようなエスケープ表記で書く。
混入の検査はこれで足りる:

```bash
python3 -c "s=open('FILE',encoding='utf-8').read(); print([hex(ord(c)) for c in s if ord(c)<9 or 11<=ord(c)<32] or 'なし')"
```

## PDF書き出しに外部ライブラリを使っていない理由

`src/result/pdf.js` は依存ゼロの最小限のPDFライタ (約90行)。jsPDF等を抱えていない。

**PDFは画像XObjectのフィルタとして `DCTDecode` (= JPEG) をそのまま解釈できる。**
つまり `canvas.toBlob(..., 'image/jpeg')` で得たバイト列を再エンコードせず丸ごと
埋め込める。画像1枚を1ページに貼るだけなら、必要なのは

- カタログ / ページツリー / ページ / 内容ストリーム / 画像XObject の5種のオブジェクト
- 配置用の内容ストリーム1行 — 画像空間は単位正方形なので
  `q <drawW> 0 0 <drawH> <x> <y> cm /Im0 Do Q` で目的の大きさ・位置へ写す
- バイトオフセットを持つ xref テーブル

だけ。ワークスペースの「ビルド不要のプレーンJS」方針とも噛み合う。

### 書くときの注意

- **オフセットはバイト単位で数える**。JPEGを混ぜるので文字列連結では組めない。
  `Uint8Array` の配列に積み、`length` を都度加算する
- ヘッダ2行目のバイナリコメント (`%\xE2\xE3\xCF\xD3`) は `TextEncoder` に通すと
  UTF-8に化ける。生バイトで `push(new Uint8Array([...]))` する
- **PDFの原点は左下**。最終ページは中身が短いので `y = pageH - drawH` で上端に寄せる
- JPEGは透過を持てない。切り出し先のcanvasを必ず白で塗ってから描く

### ページ分割

幅をA4 (595.28pt) に合わせ、`ptPerPx = A4幅 / canvas幅` を求めて
`floor(A4高 / ptPerPx)` px ごとに切り出す。1800×8120pxの画像で4ページになる。

**既定は「1ページにまとめる」**(縦に長い1枚)。スクリーンショットを見るだけなら
分割されない方が自然なため。「A4縦で分割」は印刷向けの選択肢。

ただし**多くのPDFビューアはページの辺が 14400pt (200インチ) を超えると開けない**。
`updatePdfLayoutOptions()` が超過を検出して選択肢を無効化し、A4分割へ退避させる。
1800×63688px のような長いページだと 21055pt になって引っかかる。
既定を1ページ側にした以上、この退避が効かないと保存できないPDFが出るので、
E2Eでも「canvasを70000pxにして `updatePdfLayoutOptions()` を呼ぶ」形で検証している。

### 検証方法

自前のライタなので、自前のテスト (`/Count` の正規表現) だけでは不十分。
**別実装のPDFレンダラ2つで開けることを確認する**:

```bash
qlmanage -t -s 500 -o . out.pdf   # macOS QuickLook = CoreGraphics
```

さらに Brave (PDFium) で `file://` として開き、ツールバーのページ数表示と
サムネイルを目視する。CoreGraphicsとPDFiumは独立実装なので、
両方が読めれば構造は妥当と判断してよい。

## 撮影できないページ

Chromium が拡張機能に触らせないページがあり、**権限を足しても解除できない**。
`<all_urls>` を付けた状態で実測した結果:

| URL | `chrome.scripting.executeScript` の結果 |
| --- | --- |
| `https://chromewebstore.google.com/...` | `The extensions gallery cannot be scripted.` |
| `https://chrome.google.com/webstore/...` | 同上 (上へリダイレクトされる) |
| `https://example.com/` | OK |
| `https://developer.chrome.com/...` | OK |

**ウェブストアだけは `https:` なのに拒否される**のが引っかかりどころ。
URLスキームだけで可否を判定すると素通りしてしまうので、
`restrictedReason()` でホスト名も見ている。FireShot を含め、どの拡張機能でも同じ制限を受ける。

失敗はバッジの赤い `!` とツールチップだけで伝える。
**ページを操作できない状況で失敗するので、ページ内にトーストを出す手段が無い**
(それができるなら、そもそも撮影もできている)。`notifications` 権限を足せば
OSの通知は出せるが、この機能のためだけに常時権限を増やすのは見合わないと判断した。

## ショートカットキーの方針

`manifest.json` の `commands` に `suggested_key` を**書かない**。
デフォルト割り当てがあると既存のショートカットと衝突し、
拡張を入れ直すたびに手で未設定へ戻すことになる。ユーザーが
`chrome://extensions/shortcuts` で自分で割り当てる。

コマンド名の `01_` / `02_` プレフィックスは `chrome://extensions/shortcuts` の
表示順を固定するため (manifestのキー名でソートされる。記述順や description ではない)。
`yt-quick-filter` と同じ流儀。

## テスト

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright   # 初回のみ
node test/e2e.js
```

Brave Browser Nightly を `executablePath` で使う (リリース版Chromeは
`--load-extension` を黙って無視する)。ワークスペース共通の方針は
`~/.claude/skills/browser-testing` を参照。

### 検証の考え方

フィクスチャの各行に**一意な色**を割り当て、合成画像の「文書座標 → 色」が
一致するかを見る。ずれ・欠け・二重描画があれば必ず落ちる。
目視では継ぎ目の1px欠けは見つからない。

固定要素は色で塗り分け、縦1列を走査して**色の帯が何回現れたか**を数える
(固定ヘッダー=1回、固定フッター=0回、浮遊ウィジェット=0回、stickyサイドバー=1回)。

### 高速モードとPlaywrightのビューポートエミュレーションは併用できない

`chrome.debugger.attach/detach` は **Playwright が張った
`Emulation.setDeviceMetricsOverride` を巻き添えで解除する**。
その結果、同じブラウザで続けて撮ると `captureVisibleTab` の倍率がずれる
(実測: dpr 2.00 が 1.92 になり、画像が 1520×8120 → 1456×7777 に狂った)。

**製品側の問題ではない** — `viewport: null` (エミュレーションなし) で試すと正常だった。
テストの前提が崩れるだけなので、`withBrowser()` で**シナリオごとにブラウザを立て直す**。
「単独では通るのに連続実行だと落ちる」形で出るので、原因の見当がつきにくい。
似た症状が出たら、まず単独実行と `viewport: null` で切り分ける。

### テスト時の権限

実運用は `activeTab` (クリックというユーザー操作で付与される) だが、
自動操作にはそのジェスチャが無い。`test/e2e.js` は拡張を一時ディレクトリへコピーし、
**そのコピーにだけ** `host_permissions: ["<all_urls>"]` を足して読み込む。
リポジトリの `manifest.json` は `activeTab` のままにしておく。

撮影はservice workerの `run()` を `sw.evaluate()` から直接呼ぶ
(`background.js` はクラシックスクリプトなので、トップレベルの関数宣言が
ワーカーのグローバルに乗る)。

### フィクスチャで一度ひっかかった罠

固定フッターの高さをタイルの重なり幅 (`OVERLAP_PX = 40`) と同じ40pxにしていたため、
**次のタイルが偶然フッターを上書きして**「バグが無い」ように見えていた。
フッターを70pxに変えたら写り込みが露見した。
重なり幅と検証対象のサイズは必ずずらすこと。

## よくある変更

- **速度を上げたい** → `CAPTURE_INTERVAL_MS` は下げられない (APIの制限)。
  下げられるのは `SETTLE_MS` (スクロール後の描画待ち)。遅延読み込みの多いページで
  白く抜けるようなら逆に増やす
- **継ぎ目に線が出る** → `OVERLAP_PX` を増やす
- **独自スクロールコンテナに対応したい** → `content.js` の `scroller()` を
  「最も大きくスクロールできる要素」を探す実装に置き換える。
  FireShotは `fsFrames.js` でiframeごとに再帰処理までしている
