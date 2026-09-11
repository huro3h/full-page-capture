// 依存ライブラリなしの最小限のPDF書き出し。
//
// PDFは画像XObjectのフィルタとして DCTDecode (= JPEG) をそのまま解釈できる。
// つまりJPEGのバイト列を再エンコードせず丸ごと埋め込めるので、
// 画像1枚を1ページに貼るだけのPDFなら数十行で書ける。
//
// buildPdf(pages) の pages は以下の形:
//   { jpeg: Uint8Array, pxW, pxH,          // 埋め込むJPEGとその画素サイズ
//     pageW, pageH,                        // ページサイズ (pt)
//     drawW, drawH, x, y }                 // ページ内の配置 (pt, 原点は左下)
function buildPdf(pages) {
  const encoder = new TextEncoder();
  const parts = [];
  let length = 0;

  const push = (chunk) => {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };

  // オブジェクト番号: 1=カタログ, 2=ページツリー,
  // 以降ページごとに [ページ, 内容ストリーム, 画像] の3つを消費する。
  const objectCount = 2 + pages.length * 3;
  const offsets = new Array(objectCount + 1).fill(0);
  const pageObjectNumber = (i) => 3 + i * 3;

  const beginObject = (n) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
  };
  const endObject = () => push("endobj\n");
  const pt = (n) => n.toFixed(2);

  // ヘッダ。2行目のバイナリコメントは「このファイルはバイナリだ」の慣習的な目印。
  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  beginObject(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\n");
  endObject();

  const kids = pages.map((_, i) => `${pageObjectNumber(i)} 0 R`).join(" ");
  beginObject(2);
  push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\n`);
  endObject();

  pages.forEach((page, i) => {
    const pageNum = pageObjectNumber(i);
    const contentNum = pageNum + 1;
    const imageNum = pageNum + 2;

    beginObject(pageNum);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(page.pageW)} ${pt(page.pageH)}] ` +
        `/Resources << /XObject << /Im0 ${imageNum} 0 R >> >> /Contents ${contentNum} 0 R >>\n`,
    );
    endObject();

    // 画像空間は単位正方形なので、cm行列で目的の大きさ・位置へ写す。
    const content =
      `q\n${pt(page.drawW)} 0 0 ${pt(page.drawH)} ${pt(page.x)} ${pt(page.y)} cm\n/Im0 Do\nQ\n`;
    beginObject(contentNum);
    push(`<< /Length ${encoder.encode(content).length} >>\nstream\n`);
    push(content);
    push("endstream\n");
    endObject();

    beginObject(imageNum);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${page.pxW} /Height ${page.pxH} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${page.jpeg.length} >>\nstream\n`,
    );
    push(page.jpeg);
    push("\nendstream\n");
    endObject();
  });

  const xrefOffset = length;
  push(`xref\n0 ${objectCount + 1}\n`);
  push("0000000000 65535 f \n");
  for (let n = 1; n <= objectCount; n++) {
    push(String(offsets[n]).padStart(10, "0") + " 00000 n \n");
  }
  push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob(parts, { type: "application/pdf" });
}
