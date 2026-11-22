// Drawing surface for creating a signature. Collects every pointer sample
// (including coalesced ones between frames) and redraws smoothed strokes live.
import { strokePath } from "./strokes.js";

export class SignaturePad {
  constructor(canvas, { onChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.strokes = [];
    this.active = null;
    this.size = 6.5;
    this.color = "#1b1b1f";
    this.onChange = onChange;
    this.frame = 0;
    canvas.addEventListener("pointerdown", e => this.#down(e));
    canvas.addEventListener("pointermove", e => this.#move(e));
    canvas.addEventListener("pointerup", e => this.#up(e));
    canvas.addEventListener("pointercancel", e => this.#up(e));
    new ResizeObserver(() => this.#resize()).observe(canvas);
  }

  get isEmpty() {
    return this.strokes.length === 0;
  }

  setPen({ size, color }) {
    if (size) this.size = size;
    if (color) this.color = color;
    this.redraw();
  }

  undo() {
    this.strokes.pop();
    this.redraw();
    this.onChange?.();
  }

  clear() {
    this.strokes = [];
    this.active = null;
    this.redraw();
    this.onChange?.();
  }

  #point(e) {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  // One pointer draws at a time, so a second finger or a resting palm cannot
  // mix its points into the stroke in progress.
  #down(e) {
    if (e.button !== 0 || this.active) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.pointerId = e.pointerId;
    this.active = [this.#point(e)];
    this.strokes.push(this.active);
    this.#schedule();
  }

  #move(e) {
    if (!this.active || e.pointerId !== this.pointerId) return;
    const samples = e.getCoalescedEvents?.() ?? [];
    for (const s of samples.length ? samples : [e]) this.active.push(this.#point(s));
    this.#schedule();
  }

  #up(e) {
    if (!this.active || e.pointerId !== this.pointerId) return;
    this.active = null;
    this.redraw();
    this.onChange?.();
  }

  #schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.redraw();
    });
  }

  #resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.redraw();
  }

  redraw() {
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = this.color;
    for (const points of this.strokes) {
      ctx.fill(new Path2D(strokePath(points, this.size, points !== this.active)));
    }
  }
}

// Turns a photo or scan of a seal (도장) into a transparent, trimmed PNG:
// near-white paper becomes transparent, ink keeps its colour.
export async function imageToStamp(file, maxSide = 600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // Fully transparent above 235, fully opaque below 175, soft in between.
      const keep = Math.min(1, Math.max(0, (235 - lum) / 60));
      d[i + 3] = Math.round(d[i + 3] * keep);
      if (d[i + 3] > 16) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  ctx.putImageData(img, 0, 0);
  const tw = maxX - minX + 1, th = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = tw;
  out.height = th;
  out.getContext("2d").drawImage(canvas, minX, minY, tw, th, 0, 0, tw, th);
  return { dataUrl: out.toDataURL("image/png"), width: tw, height: th };
}
