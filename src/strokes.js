// Turns raw pointer samples into smooth, pen-like signature outlines.
// perfect-freehand does the heavy lifting: it streamlines jitter, simulates
// pressure from pointer speed (fast = thin, slow = thick) and tapers stroke ends.
import { getStroke } from "../vendor/perfect-freehand/index.mjs";

export const PEN_SIZES = { thin: 4.5, normal: 6.5, bold: 9 };
export const PEN_COLORS = { black: "#1b1b1f", blue: "#1c3f9e" };

export function strokeOptions(size, last = true) {
  return {
    size,
    thinning: 0.6,
    smoothing: 0.62,
    streamline: 0.5,
    simulatePressure: true,
    easing: t => Math.sin((t * Math.PI) / 2),
    start: { taper: size * 1.2, cap: true },
    end: { taper: size * 3, cap: true },
    last,
  };
}

const avg = (a, b) => (a + b) / 2;
const r = n => Math.round(n * 100) / 100;

// Closed SVG path through the outline points, using quadratic curves between
// midpoints so the edge stays smooth even where the outline is sparse.
export function outlineToPath(outline) {
  const len = outline.length;
  if (len === 0) return "";
  if (len < 4) {
    return `M${outline.map(([x, y]) => `${r(x)},${r(y)}`).join(" L")} Z`;
  }
  let a = outline[0], b = outline[1];
  const c = outline[2];
  let d = `M${r(a[0])},${r(a[1])} Q${r(b[0])},${r(b[1])} ${r(avg(b[0], c[0]))},${r(avg(b[1], c[1]))} T`;
  for (let i = 2; i < len - 1; i++) {
    a = outline[i];
    b = outline[i + 1];
    d += `${r(avg(a[0], b[0]))},${r(avg(a[1], b[1]))} `;
  }
  return `${d}Z`;
}

export function strokeOutline(points, size, last = true) {
  return getStroke(points, strokeOptions(size, last));
}

export function strokePath(points, size, last = true) {
  return outlineToPath(strokeOutline(points, size, last));
}

// Normalises drawn strokes into a signature record: translated so the ink's
// bounding box starts at (0,0), with a small margin so tapers are not clipped.
export function buildVectorSignature(strokes, { size, color, name }) {
  const outlines = strokes.map(points => strokeOutline(points, size));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const outline of outlines) {
    for (const [x, y] of outline) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  const pad = size;
  const ox = minX - pad, oy = minY - pad;
  const moved = strokes.map(points => points.map(([x, y]) => [r(x - ox), r(y - oy)]));
  return {
    id: crypto.randomUUID(),
    kind: "vector",
    name,
    color,
    size,
    width: r(maxX - minX + pad * 2),
    height: r(maxY - minY + pad * 2),
    strokes: moved,
    createdAt: Date.now(),
  };
}

const pathCache = new WeakMap();

export function signaturePaths(sig) {
  let paths = pathCache.get(sig);
  if (!paths) {
    paths = sig.strokes.map(points => strokePath(points, sig.size));
    pathCache.set(sig, paths);
  }
  return paths;
}
