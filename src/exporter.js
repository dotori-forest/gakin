// Renders each page with its stamped signatures into a single image and packs
// the images into a PDF, so the result is flat like a scan.
import { buildImagePdf } from "./pdfWriter.js";
import { signaturePaths } from "./strokes.js";
import { drawShape, drawText } from "./marks.js";

const imageCache = new Map();
const MAX_EXPORT_PIXELS = 16_000_000;

async function stampBitmap(sig) {
  let bitmap = imageCache.get(sig.id);
  if (!bitmap) {
    const blob = await (await fetch(sig.dataUrl)).blob();
    bitmap = await createImageBitmap(blob);
    imageCache.set(sig.id, bitmap);
  }
  return bitmap;
}

// Draws one stamp or text item, rotated about its centre like the editor's CSS transform.
export async function drawItem(ctx, item, sig, scale) {
  const w = item.w * scale, h = item.h * scale;
  const bitmap = sig?.kind === "image" ? await stampBitmap(sig) : null;
  ctx.save();
  ctx.translate(item.x * scale + w / 2, item.y * scale + h / 2);
  if (item.rotation) ctx.rotate((item.rotation * Math.PI) / 180);
  ctx.translate(-w / 2, -h / 2);
  if (item.kind === "text") {
    drawText(ctx, item, scale);
  } else if (item.kind === "shape") {
    drawShape(ctx, item, scale);
  } else if (bitmap) {
    ctx.drawImage(bitmap, 0, 0, w, h);
  } else {
    ctx.scale(w / sig.width, h / sig.height);
    ctx.fillStyle = sig.color;
    for (const d of signaturePaths(sig)) ctx.fill(new Path2D(d));
  }
  ctx.restore();
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("이미지 변환 실패"))), type, quality);
  });
}

// Renders every page with its stamps as a JPEG (or PNG), one page at a time.
// An item that actually draws something (an empty text box or a deleted signature doesn't).
const isDrawable = (item, signatures) =>
  item.kind === "text" ? Boolean(item.text) : item.kind === "shape" || signatures.has(item.sigId);

/** Indexes of the pages that carry at least one signature, text or mark. */
export function markedPages(doc, items, signatures) {
  const marked = new Set(items.filter(item => isDrawable(item, signatures)).map(item => item.page));
  return [...Array(doc.pageCount).keys()].filter(i => marked.has(i));
}

async function* flatPages(doc, items, signatures, { dpi = 200, quality = 0.9, type = "image/jpeg", pages, onProgress } = {}) {
  const canvas = document.createElement("canvas");
  const indexes = pages ?? [...Array(doc.pageCount).keys()];
  try {
    for (const [n, i] of indexes.entries()) {
      // Browsers (Safari on iOS especially) refuse canvases much over ~16.7 MP,
      // so very large pages are written slightly below the chosen dpi.
      const size = doc.pageSize(i);
      const scale = Math.min(dpi / 72, Math.sqrt(MAX_EXPORT_PIXELS / (size.width * size.height)));
      await doc.render(i, canvas, scale);
      const ctx = canvas.getContext("2d");
      for (const item of items) {
        if (item.page !== i) continue;
        const sig = signatures.get(item.sigId);
        if (isDrawable(item, signatures)) await drawItem(ctx, item, sig, scale);
      }
      const blob = await canvasToBlob(canvas, type, quality);
      yield { blob, page: i, pxWidth: canvas.width, pxHeight: canvas.height, ptWidth: size.width, ptHeight: size.height };
      onProgress?.(n + 1, indexes.length);
    }
  } finally {
    canvas.width = canvas.height = 0;
  }
}

/**
 * @param {object} doc document source (see documentSources.js)
 * @param {{page:number,x:number,y:number,w:number,h:number,sigId:string}[]} items
 * @param {Map<string, object>} signatures by id
 * @param {{dpi?: number, quality?: number, onProgress?: (done:number,total:number)=>void}} opts
 */
export async function exportFlatPdf(doc, items, signatures, opts = {}) {
  const pages = [];
  for await (const { blob, page: _index, ...page } of flatPages(doc, items, signatures, { ...opts, type: "image/jpeg" })) {
    pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), ...page });
  }
  return buildImagePdf(pages, { title: doc.name.replace(/\.[^.]+$/, "") });
}

/**
 * Pages as images (opts.type: image/jpeg or image/png), all of them or only opts.pages.
 * @returns {Promise<{blob: Blob, page: number}[]>} page is the 0-based page index
 */
export async function exportFlatImages(doc, items, signatures, opts = {}) {
  const images = [];
  for await (const { blob, page } of flatPages(doc, items, signatures, opts)) images.push({ blob, page });
  return images;
}
