// Minimal PDF writer: one full-page JPEG per page and nothing else.
// The result has no text layer or separate signature object, so like a scan
// it cannot be edited or have the signature lifted off.
const enc = new TextEncoder();

function pdfDate(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// UTF-16BE hex string with BOM, so Korean titles survive.
function pdfTextString(text) {
  let hex = "FEFF";
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `<${hex}>`;
}

const num = n => (Math.round(n * 1000) / 1000).toString();

/**
 * @param {{jpeg: Uint8Array, pxWidth: number, pxHeight: number, ptWidth: number, ptHeight: number}[]} pages
 * @param {{title?: string}} [meta]
 * @returns {Blob}
 */
export function buildImagePdf(pages, { title } = {}) {
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = chunk => {
    const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (id, body, stream) => {
    offsets[id] = length;
    push(`${id} 0 obj\n${body}\n`);
    if (stream) {
      push("stream\n");
      push(stream);
      push("\nendstream\n");
    }
    push("endobj\n");
  };

  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const pageIds = pages.map((_, i) => 4 + i * 3);
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  const info = [`/Producer (gakin)`, `/CreationDate (${pdfDate()})`];
  if (title) info.push(`/Title ${pdfTextString(title)}`);
  object(3, `<< ${info.join(" ")} >>`);

  pages.forEach((page, i) => {
    const pageId = pageIds[i], contentId = pageId + 1, imageId = pageId + 2;
    const w = num(page.ptWidth), h = num(page.ptHeight);
    object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    const content = enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
    object(contentId, `<< /Length ${content.length} >>`, content);
    object(imageId, `<< /Type /XObject /Subtype /Image /Width ${page.pxWidth} /Height ${page.pxHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>`, page.jpeg);
  });

  const size = 4 + pages.length * 3;
  const xrefAt = length;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}
