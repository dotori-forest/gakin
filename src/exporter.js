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

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("JPEG 변환 실패"))), "image/jpeg", quality);
  });
}

/**
 * @param {object} doc document source (see documentSources.js)
 * @param {{page:number,x:number,y:number,w:number,h:number,sigId:string}[]} items
 * @param {Map<string, object>} signatures by id
 * @param {{dpi?: number, quality?: number, onProgress?: (done:number,total:number)=>void}} opts
 */
export async function exportFlatPdf(doc, items, signatures, { dpi = 200, quality = 0.9, onProgress } = {}) {
  const pages = [];
  const canvas = document.createElement("canvas");
  for (let i = 0; i < doc.pageCount; i++) {
    // Browsers (Safari on iOS especially) refuse canvases much over ~16.7 MP,
    // so very large pages are written slightly below the chosen dpi.
    const { width, height } = doc.pageSize(i);
    const scale = Math.min(dpi / 72, Math.sqrt(MAX_EXPORT_PIXELS / (width * height)));
    await doc.render(i, canvas, scale);
    const ctx = canvas.getContext("2d");
    for (const item of items) {
      if (item.page !== i) continue;
      const sig = signatures.get(item.sigId);
      const drawable = item.kind === "text" ? Boolean(item.text) : item.kind === "shape" || Boolean(sig);
      if (drawable) await drawItem(ctx, item, sig, scale);
    }
    const jpeg = new Uint8Array(await (await canvasToJpeg(canvas, quality)).arrayBuffer());
    const size = doc.pageSize(i);
    pages.push({ jpeg, pxWidth: canvas.width, pxHeight: canvas.height, ptWidth: size.width, ptHeight: size.height });
    onProgress?.(i + 1, doc.pageCount);
  }
  canvas.width = canvas.height = 0;
  return buildImagePdf(pages, { title: doc.name.replace(/\.[^.]+$/, "") });
}
