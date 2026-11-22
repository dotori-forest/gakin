// "이름으로 만들기": writes a name in a font and turns it into a transparent
// PNG, stored like an imported stamp (kind "image"), so placing, backup and
// export need nothing new. Fonts load only when the dialog opens and never
// come from the network.
import { HANDWRITING_FONTS } from "./handwritingFonts.js";

// Windows system fonts (HanYang I&C, licensed with Windows). They cannot be
// redistributed, so they are not bundled: local() uses the copy installed on
// the user's PC, and the choice is hidden where it is not installed.
const FULL_KOREAN = [[0x20, 0x7e], [0xb7, 0xb7], [0x3131, 0x318e], [0xac00, 0xd7a3]];
const SYSTEM_FONTS = [
  { id: "gulim", label: "굴림", local: ["Gulim", "굴림"], system: true, covers: FULL_KOREAN },
  { id: "dotum", label: "돋움", local: ["Dotum", "돋움"], system: true, covers: FULL_KOREAN },
];

/** Bundled handwriting fonts first, then the PC's own fonts. */
export const FONT_CHOICES = [...HANDWRITING_FONTS, ...SYSTEM_FONTS];

const RENDER_SIZE = 360; // px; a 3-character name comes out ~600px wide, sharp at 300dpi
const loaded = new Map();

const familyOf = font => `gakin-${font.id}`;

/** Loads a font once; resolves to the CSS family name to use. */
export function loadHandwritingFont(font) {
  if (!loaded.has(font.id)) {
    const source = font.local
      ? font.local.map(name => `local("${name}")`).join(", ")
      : `url("${new URL(`../${font.file}`, import.meta.url).href}")`;
    const face = new FontFace(familyOf(font), source, { display: "block" });
    loaded.set(font.id, face.load().then(f => {
      document.fonts.add(f);
      return familyOf(font);
    }).catch(error => {
      loaded.delete(font.id);
      throw error;
    }));
  }
  return loaded.get(font.id);
}

/** Characters of `text` the font has no glyph for (spaces are fine). */
export function missingCharacters(font, text) {
  const missing = new Set();
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === " ") continue;
    if (!font.covers.some(([a, b]) => a <= code && code <= b)) missing.add(ch);
  }
  return [...missing];
}

/** Renders the name and trims it to the ink. */
export async function renderNameSignature(text, font, color) {
  const family = await loadHandwritingFont(font);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const css = `${RENDER_SIZE}px "${family}"`;
  ctx.font = css;
  const pad = Math.round(RENDER_SIZE * 0.4);
  canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.height = Math.round(RENDER_SIZE * 1.8);
  ctx.font = css; // resizing the canvas resets the context
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, pad, Math.round(RENDER_SIZE * 1.25));

  const { width: w, height: h } = canvas;
  const d = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const margin = 4;
  minX = Math.max(0, minX - margin);
  minY = Math.max(0, minY - margin);
  maxX = Math.min(w - 1, maxX + margin);
  maxY = Math.min(h - 1, maxY + margin);
  const tw = maxX - minX + 1, th = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = tw;
  out.height = th;
  out.getContext("2d").drawImage(canvas, minX, minY, tw, th, 0, 0, tw, th);
  return { dataUrl: out.toDataURL("image/png"), width: tw, height: th };
}
