// Text and marks placed on a page (글자·표시 넣기), measured and drawn the same
// way on screen and when saving, so the saved PDF matches what was placed.
//   text:  { id, kind: "text",  page, x, y, w, h, rotation?, text, size, color }
//   shape: { id, kind: "shape", page, x, y, w, h, rotation?, shape, color }
// size is the font size in PDF points; a text box's w and h follow from text
// and size. Shapes are outlines with a fixed pen width, stretched to the box.

export const TEXT_FONT = '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI Symbol", sans-serif';
export const LINE_HEIGHT = 1.3;
export const TEXT_SIZE = 12; // pt; resizing the box scales it
export const MARK_COLOR = "#1b1b1f";

let measureCtx = null;

/** Box of the text in points: widest line by the number of lines. */
export function measureText(text, size) {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  measureCtx.font = `${size}px ${TEXT_FONT}`;
  const lines = text.split("\n");
  const w = Math.max(...lines.map(line => measureCtx.measureText(line).width), size * 0.5);
  return { w: Math.ceil(w * 10) / 10 + size * 0.2, h: lines.length * size * LINE_HEIGHT };
}

/** Draws a text item at the context's origin (the caller has moved and rotated it). */
export function drawText(ctx, item, scale) {
  const size = item.size * scale;
  ctx.font = `${size}px ${TEXT_FONT}`;
  ctx.fillStyle = item.color;
  ctx.textBaseline = "middle";
  item.text.split("\n").forEach((line, i) => ctx.fillText(line, size * 0.1, (i + 0.5) * size * LINE_HEIGHT));
}

/** "2026. 11. 20." as Korean documents write dates. */
export function todayText(date = new Date()) {
  return `${date.getFullYear()}. ${date.getMonth() + 1}. ${date.getDate()}.`;
}

export const SHAPES = ["check", "circle", "cross"];
export const SHAPE_PEN = 1.6; // pt, the same at any box size
export const SHAPE_SIZES = { check: { w: 16, h: 14 }, circle: { w: 24, h: 24 }, cross: { w: 14, h: 14 } };

// Outlines in a 100 × 100 box, stretched to the item's box.
const SHAPE_PATHS = {
  check: [[[6, 52], [38, 88], [94, 10]]],
  cross: [[[10, 10], [90, 90]], [[90, 10], [10, 90]]],
};

/** SVG markup for the editor; stroke width comes from CSS so it stays constant. */
export function shapeSvg(shape) {
  const body = shape === "circle"
    ? '<ellipse cx="50" cy="50" rx="50" ry="50" />'
    : SHAPE_PATHS[shape].map(line => `<polyline points="${line.map(p => p.join(",")).join(" ")}" />`).join("");
  return `<svg class="mark-shape" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${body}</svg>`;
}

/** Draws a shape item into a w × h box at the context's origin. */
export function drawShape(ctx, item, scale) {
  const w = item.w * scale, h = item.h * scale;
  ctx.strokeStyle = item.color;
  ctx.lineWidth = SHAPE_PEN * scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (item.shape === "circle") {
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else {
    for (const line of SHAPE_PATHS[item.shape]) {
      line.forEach(([x, y], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, (x / 100) * w, (y / 100) * h));
    }
  }
  ctx.stroke();
}
