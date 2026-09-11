// ページ側の下ごしらえとスクロール。
// executeScript で毎回注入されるので、二重登録しないようフラグで守る。
(() => {
  if (window.__fpcInstalled) return;
  window.__fpcInstalled = true;

  const STYLE_ID = "__fpc-style";
  // sticky の基準位置をあり得ない値に飛ばすと、貼り付きが一度も成立せず素の位置に流れる。
  // display:none や position:static と違ってレイアウトを壊さないのが利点。
  const FAR = "-1000000000px";
  const NEAR = "1000000000px";

  // これ未満しか動かない要素はスクロールコンテナとみなさない。
  const MIN_SCROLLABLE = 200;
  // ビューポートに対してこれより小さい領域は、本文ではなく脇のリストとみなす。
  const MIN_AREA_RATIO = 0.25;

  /** @type {{el: HTMLElement, prop: string, value: string, priority: string}[]} */
  let savedStyles = [];
  /** @type {{el: HTMLElement, anchorTop: boolean}[]} */
  let fixedElements = [];
  /** @type {HTMLElement[]} */
  let stickyElements = [];
  // スクロールの主体。ドキュメントとは限らない。
  let target = null;
  let origScroll = { x: 0, y: 0 };
  let prepared = false;

  const documentScroller = (doc) => doc.scrollingElement || doc.documentElement;

  function setStyle(el, prop, value) {
    savedStyles.push({
      el,
      prop,
      value: el.style.getPropertyValue(prop),
      priority: el.style.getPropertyPriority(prop),
    });
    el.style.setProperty(prop, value, "important");
  }

  function restoreStyles() {
    for (let i = savedStyles.length - 1; i >= 0; i--) {
      const s = savedStyles[i];
      if (s.value) s.el.style.setProperty(s.prop, s.value, s.priority);
      else s.el.style.removeProperty(s.prop);
    }
    savedStyles = [];
  }

  // スクロールの主体を決める。
  // 通常はドキュメントだが、ページによっては中の要素や同一オリジンのiframeが
  // 実際のスクロールコンテナになっている。例えば HackMD の /community/ ビューは
  // ノート本体を同一オリジンのiframeに入れており、親ページは1pxも動かない。
  function findScrollTarget() {
    const topScroller = documentScroller(document);
    if (topScroller.scrollHeight - topScroller.clientHeight > MIN_SCROLLABLE) {
      return { scroller: topScroller, doc: document, host: null, kind: "document" };
    }

    const minArea = window.innerWidth * window.innerHeight * MIN_AREA_RATIO;
    let best = null;
    const consider = (candidate) => {
      if (candidate.amount <= MIN_SCROLLABLE) return;
      if (!best || candidate.amount > best.amount) best = candidate;
    };

    // ページ内のスクロールコンテナ
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    for (let el = document.documentElement; el; el = walker.nextNode()) {
      if (el.clientWidth * el.clientHeight < minArea) continue;
      const overflowY = getComputedStyle(el).overflowY;
      if (!/auto|scroll|overlay/.test(overflowY)) continue;
      consider({
        scroller: el,
        doc: document,
        host: el,
        kind: "element",
        amount: el.scrollHeight - el.clientHeight,
      });
    }

    // 同一オリジンのiframe。クロスオリジンは contentDocument が読めないので諦める。
    for (const frame of document.querySelectorAll("iframe, frame")) {
      if (frame.clientWidth * frame.clientHeight < minArea) continue;
      let inner = null;
      try {
        inner = frame.contentDocument;
      } catch {
        continue;
      }
      if (!inner || !inner.documentElement) continue;
      const scroller = documentScroller(inner);
      consider({
        scroller,
        doc: inner,
        host: frame,
        kind: "iframe",
        amount: scroller.scrollHeight - scroller.clientHeight,
      });
    }

    return best || { scroller: topScroller, doc: document, host: null, kind: "document" };
  }

  // 撮影で使える可視領域を、トップのビューポート座標で求める。
  // コンテナが画面からはみ出していれば、その分は撮れないので切り詰める。
  function computeClip() {
    const viewW = document.documentElement.clientWidth;
    const viewH = document.documentElement.clientHeight;

    let box;
    if (!target.host) {
      box = { left: 0, top: 0, width: viewW, height: viewH };
    } else {
      const rect = target.host.getBoundingClientRect();
      const cs = getComputedStyle(target.host);
      box = {
        left: rect.left + (parseFloat(cs.borderLeftWidth) || 0),
        top: rect.top + (parseFloat(cs.borderTopWidth) || 0),
        width: target.host.clientWidth,
        height: target.host.clientHeight,
      };
    }

    const x = Math.max(0, box.left);
    const y = Math.max(0, box.top);
    const right = Math.min(viewW, box.left + box.width);
    const bottom = Math.min(viewH, box.top + box.height);
    return {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.max(0, Math.round(right - x)),
      h: Math.max(0, Math.round(bottom - y)),
    };
  }

  // 出力画像のサイズ。コンテナが一部しか見えていない場合、
  // 撮れるのは「スクロールしきれる量 + 一度に見える量」まで。
  function contentSize(clip) {
    const s = target.scroller;
    return {
      pageW: s.scrollWidth - s.clientWidth + clip.w,
      pageH: s.scrollHeight - s.clientHeight + clip.h,
    };
  }

  function injectStyle(doc) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* スクロールバーを消す。overflow:hidden と違いスクロール自体は生きたまま。 */
      ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
      html { scrollbar-width: none !important; }
      /* scroll-behavior:smooth のページだと scrollTo がアニメーションになり、
         撮影とスクロールがずれる。 */
      html, body, * { scroll-behavior: auto !important; }
      /* アニメーション中のコマが混ざるのを防ぐ。 */
      *, *::before, *::after {
        animation-play-state: paused !important;
        transition-duration: 0s !important;
        caret-color: transparent !important;
      }
    `;
    doc.documentElement.appendChild(style);
  }

  // position:fixed / sticky の要素は、何もしないと1コマごとに写り込んで縞模様になる。
  // ただしコンテナ大の要素はページ本体やモーダルの背景なので触ってはいけない。
  function collectStuckElements(doc, clip) {
    const vw = clip.w;
    const vh = clip.h;
    const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
    const sticky = [];
    const fixed = [];

    for (let el = doc.documentElement; el; el = walker.nextNode()) {
      if (el.id === STYLE_ID) continue;
      const cs = getComputedStyle(el);

      // 背景のパララックスもスクロールに追従させる。
      if (cs.backgroundAttachment === "fixed") setStyle(el, "background-attachment", "scroll");

      const pos = cs.position;
      if (pos !== "fixed" && pos !== "sticky") continue;
      if (cs.display === "none" || cs.visibility === "hidden") continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width >= vw * 0.9 && rect.height >= vh * 0.9) continue;

      // サイトのヘッダー/ナビは「最上端に貼り付いた横長の帯」という形をしている。
      // これを満たすものだけをヘッダー扱いし、宙に浮くチャットウィジェットやCookieバーは除く。
      if (pos === "sticky") sticky.push(el);
      else fixed.push({ el, anchorTop: rect.top <= 8 && rect.width >= vw * 0.6 });
    }

    stickyElements = sticky;
    for (const el of sticky) {
      const cs = getComputedStyle(el);
      if (cs.top !== "auto") setStyle(el, "top", FAR);
      if (cs.bottom !== "auto") setStyle(el, "bottom", NEAR);
      if (cs.left !== "auto") setStyle(el, "left", "auto");
      if (cs.right !== "auto") setStyle(el, "right", "auto");
    }
    // fixed は sticky と違って流し込めないので隠すしかない。
    // ただし上端のヘッダーだけは1枚目に残す — 完成画像の先頭にナビが無いと不自然なため。
    // 下端・中央に浮くものは、1枚目に残すとページ途中に紛れ込むので常に隠す。
    return fixed;
  }

  function prepare(mode) {
    if (prepared) restore();
    prepared = true;

    // 表示範囲だけを撮る場合はページに一切手を加えない。
    target =
      mode === "visible"
        ? { scroller: documentScroller(document), doc: document, host: null, kind: "document" }
        : findScrollTarget();

    origScroll = { x: target.scroller.scrollLeft, y: target.scroller.scrollTop };

    if (mode !== "visible") {
      // コンテナが画面外に追いやられていたら、まず見える位置へ持ってくる。
      if (target.host) target.host.scrollIntoView({ block: "nearest", inline: "nearest" });
      injectStyle(target.doc);
    }

    // スクロールバーを消したあとに測る。消す前後で clientWidth がずれるため。
    const clip = computeClip();
    if (mode !== "visible") fixedElements = collectStuckElements(target.doc, clip);

    const { pageW, pageH } = contentSize(clip);
    return {
      viewW: clip.w,
      viewH: clip.h,
      pageW,
      pageH,
      clip,
      scrollerKind: target.kind,
      // デバイスピクセル比の算出に使う。撮影画像はビューポート全体なので、
      // コンテナの幅ではなくウィンドウの幅と比べる必要がある。
      windowW: document.documentElement.clientWidth,
      title: document.title,
      url: location.href,
    };
  }

  function restore() {
    if (!prepared) return { ok: true };
    for (const { el } of fixedElements) el.style.removeProperty("visibility");
    fixedElements = [];
    stickyElements = [];
    restoreStyles();
    if (target) {
      target.doc.getElementById(STYLE_ID)?.remove();
      target.scroller.scrollLeft = origScroll.x;
      target.scroller.scrollTop = origScroll.y;
    }
    prepared = false;
    return { ok: true };
  }

  // 高速モード(CDPの captureBeyondViewport)用の下ごしらえ。
  //
  // captureBeyondViewport は実装によって「ビューポートを全高に広げて1回描く」場合と
  // 「画面ぶんずつ区切って描いて繋ぐ」場合があり、後者になると fixed / sticky が
  // 画面数ぶん繰り返し焼き付く。どちらになるかは実行ごとに変わる(実測で3回中2回が繰り返し)。
  // 連写モードのように1枚ずつ制御できないので、撮る前に固定をやめさせるしかない。
  function flatten() {
    for (const { el, anchorTop } of fixedElements) {
      // 上端のヘッダーは absolute にして文書の先頭へ流す。
      // 消さずに済み、かつ繰り返し描かれることもなくなる。
      if (anchorTop) setStyle(el, "position", "absolute");
      else el.style.setProperty("visibility", "hidden", "important");
    }
    // sticky は基準位置を飛ばすだけでは区切り描画に耐えないので、static まで落とす。
    // sticky は通常フローでの配置は static と同じなので、レイアウトは動かない。
    for (const el of stickyElements) setStyle(el, "position", "static");

    const s = target.scroller;
    s.scrollLeft = 0;
    s.scrollTop = 0;
    return { ok: true };
  }

  const afterPaint = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  async function scrollTo(x, y, isFirstTile) {
    for (const { el, anchorTop } of fixedElements) {
      if (isFirstTile && anchorTop) el.style.removeProperty("visibility");
      else el.style.setProperty("visibility", "hidden", "important");
    }

    const s = target.scroller;
    s.scrollLeft = x;
    s.scrollTop = y;
    await afterPaint();

    const clip = computeClip();
    const { pageW, pageH } = contentSize(clip);
    // 画像上の位置はスクロール量そのもの。原点はコンテナの可視領域の左上に対応する。
    return { x: s.scrollLeft, y: s.scrollTop, pageW, pageH };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.__fpc !== true) return;
    if (message.type === "prepare") {
      sendResponse(prepare(message.mode));
      return;
    }
    if (message.type === "flatten") {
      sendResponse(flatten());
      return;
    }
    if (message.type === "restore") {
      sendResponse(restore());
      return;
    }
    if (message.type === "scrollTo") {
      scrollTo(message.x, message.y, message.isFirstTile).then(sendResponse);
      return true; // 非同期で返す
    }
  });

  // タブを離れたまま撮影が中断された場合に元へ戻す最後の砦。
  window.addEventListener("pagehide", restore);
})();
