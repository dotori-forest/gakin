// Backup file for saved signatures, so they can move between browsers or
// between the extension and the web version, and survive clearing site data.
const FORMAT = "gakin-signatures";
const COLOR = /^#[0-9a-f]{6}$/i;
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
const finite = n => typeof n === "number" && Number.isFinite(n);
const positive = n => finite(n) && n > 0 && n < 100000;
// Generous for real signatures, small enough that one record cannot fill storage.
const MAX_DATA_URL = 4_000_000; // characters (~3 MB PNG)
const MAX_STROKES = 2000;
const MAX_POINTS = 100_000; // per signature

export function backupBlob(signatures) {
  const body = { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), signatures };
  return new Blob([JSON.stringify(body)], { type: "application/json" });
}

// Rebuilds each record field by field so nothing unexpected is stored.
function clean(sig) {
  if (!sig || typeof sig !== "object") return null;
  const name = typeof sig.name === "string" && sig.name.trim() ? sig.name.trim().slice(0, 20) : "서명";
  const id = typeof sig.id === "string" && /^[\w-]{1,64}$/.test(sig.id) ? sig.id : crypto.randomUUID();
  const base = { id, name, width: sig.width, height: sig.height, createdAt: finite(sig.createdAt) ? sig.createdAt : Date.now() };
  if (!positive(sig.width) || !positive(sig.height)) return null;
  if (positive(sig.lastWidth)) base.lastWidth = sig.lastWidth;
  if (sig.kind === "image") {
    if (typeof sig.dataUrl !== "string" || sig.dataUrl.length > MAX_DATA_URL || !PNG_DATA_URL.test(sig.dataUrl)) return null;
    return { ...base, kind: "image", dataUrl: sig.dataUrl };
  }
  if (sig.kind === "vector") {
    if (typeof sig.color !== "string" || !COLOR.test(sig.color) || !positive(sig.size) || !Array.isArray(sig.strokes) || sig.strokes.length === 0) return null;
    if (sig.strokes.length > MAX_STROKES) return null;
    const strokes = [];
    let total = 0;
    for (const stroke of sig.strokes) {
      if (Array.isArray(stroke) && (total += stroke.length) > MAX_POINTS) return null;
      if (!Array.isArray(stroke) || stroke.length === 0) return null;
      const points = [];
      for (const p of stroke) {
        if (!Array.isArray(p) || !finite(p[0]) || !finite(p[1])) return null;
        points.push([p[0], p[1]]);
      }
      strokes.push(points);
    }
    return { ...base, kind: "vector", color: sig.color, size: sig.size, strokes };
  }
  return null;
}

/** Valid signatures from an untrusted list (backup file or stored data), first of each id kept. */
export function cleanSignatures(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.map(clean).filter(sig => sig && !seen.has(sig.id) && seen.add(sig.id));
}

/** @returns {object[]} valid signatures from a backup file's text */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("백업 파일을 읽을 수 없습니다.");
  }
  if (data?.format !== FORMAT || !Array.isArray(data.signatures)) {
    throw new Error("서명 백업 파일이 아닙니다.");
  }
  return cleanSignatures(data.signatures);
}
