// Every input format is exposed through the same small interface so the editor
// and exporter do not care where pages come from:
//   { name, pageCount, pageSize(i) -> {width, height} in PDF points,
//     render(i, canvas, scale) -> Promise, destroy() }
// Protected files call askPassword({ name, retry }) -> Promise<string | null>.
import * as pdfjs from "../vendor/pdfjs/pdf.min.mjs";

const base = new URL("../vendor/pdfjs/", import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;

export class DocumentError extends Error {}

const noPassword = async () => null;

export async function openDocument(file, { askPassword = noPassword } = {}) {
  const name = file.name || "문서";
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf") || file.type === "application/pdf") return openPdf(file, name, askPassword);
  if (/\.(png|jpe?g|webp)$/.test(lower) || ["image/png", "image/jpeg", "image/webp"].includes(file.type)) return openImage(file, name);
  if (/\.(hwp|hwpx)$/.test(lower)) return openHwp(file, name, askPassword);
  throw new DocumentError("PDF, 한글(HWP·HWPX) 또는 이미지(PNG·JPG·WebP) 파일만 열 수 있습니다.");
}

// rhwp (Rust + WebAssembly) lays out and paints HWP/HWPX pages. The WASM is
// large, so it is loaded only when a 한글 file is first opened.
let rhwpReady = null;
function loadRhwp() {
  rhwpReady ??= (async () => {
    const rhwp = await import("../vendor/rhwp/rhwp.js");
    await rhwp.default({ module_or_path: new URL("../vendor/rhwp/rhwp_bg.wasm", import.meta.url) });
    return rhwp;
  })().catch(error => {
    rhwpReady = null;
    throw error;
  });
  return rhwpReady;
}

const HWP_PASSWORD_WRONG = "비밀번호가 일치하지 않";

async function openHwp(file, name, askPassword) {
  let rhwp;
  try {
    rhwp = await loadRhwp();
  } catch (error) {
    throw new DocumentError("한글 문서 엔진을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.", { cause: error });
  }
  const data = new Uint8Array(await file.arrayBuffer());
  let doc;
  try {
    doc = new rhwp.HwpDocument(data);
  } catch (error) {
    if (!/암호|비밀번호|password|encrypt/i.test(String(error?.message ?? error))) {
      throw new DocumentError("한글 문서를 열 수 없습니다. 파일이 손상되었거나 지원하지 않는 형식(배포용 문서 등)인지 확인해 주세요.", { cause: error });
    }
    doc = await openHwpWithPassword(rhwp, data, name, askPassword);
  }
  try {
    const pageCount = doc.pageCount();
    if (!pageCount) throw new Error("no pages");
    const sizes = [];
    for (let i = 0; i < pageCount; i++) {
      // getPageInfo reports 96-dpi CSS pixels; the editor works in PDF points.
      const info = JSON.parse(doc.getPageInfo(i));
      sizes.push({ width: info.width * 0.75, height: info.height * 0.75 });
    }
    return {
      name,
      pageCount,
      pageSize: i => sizes[i],
      async render(i, canvas, scale) {
        // rhwp sizes the canvas to page px × its scale (ours is per point) and
        // leaves its own transform on the context, which would misplace
        // anything drawn afterwards, such as stamps when saving. So it draws
        // into a scratch canvas and only the finished pixels are copied over.
        const scratch = document.createElement("canvas");
        doc.renderPageToCanvas(i, scratch, scale * 0.75);
        canvas.width = scratch.width;
        canvas.height = scratch.height;
        const ctx = canvas.getContext("2d", { alpha: false });
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(scratch, 0, 0);
        scratch.width = scratch.height = 0;
      },
      destroy: () => doc.free(),
    };
  } catch (error) {
    doc.free();
    throw new DocumentError("한글 문서의 쪽을 그릴 수 없습니다.", { cause: error });
  }
}

async function openHwpWithPassword(rhwp, data, name, askPassword) {
  for (let retry = false; ; retry = true) {
    const pw = await askPassword({ name, retry });
    if (pw === null) throw new DocumentError("비밀번호 입력을 취소했습니다.");
    try {
      return rhwp.HwpDocument.openWithPassword(data, pw);
    } catch (error) {
      if (!String(error?.message ?? error).includes(HWP_PASSWORD_WRONG)) {
        throw new DocumentError("암호가 걸린 한글 문서를 열 수 없습니다. 지원하지 않는 암호화 방식일 수 있습니다.", { cause: error });
      }
    }
  }
}

async function openPdf(file, name, askPassword) {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    isEvalSupported: false,
    enableXfa: false,
  });
  let cancelled = false;
  task.onPassword = async (update, reason) => {
    const retry = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
    const pw = await askPassword({ name, retry });
    if (pw === null) {
      cancelled = true;
      task.destroy();
    } else {
      update(pw);
    }
  };
  let pdf;
  try {
    pdf = await task.promise;
  } catch (error) {
    if (cancelled) throw new DocumentError("비밀번호 입력을 취소했습니다.");
    throw new DocumentError("PDF를 열 수 없습니다. 파일이 손상되었는지 확인해 주세요.", { cause: error });
  }
  const pages = [];
  const sizes = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    pages.push(page);
    sizes.push({ width: vp.width, height: vp.height });
  }
  return {
    name,
    pageCount: pages.length,
    pageSize: i => sizes[i],
    async render(i, canvas, scale) {
      const viewport = pages[i].getViewport({ scale });
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pages[i].render({ canvas, canvasContext: ctx, viewport, background: "#ffffff" }).promise;
    },
    destroy: () => task.destroy(),
  };
}

const A4 = { width: 595.28, height: 841.89 };

async function openImage(file, name) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (error) {
    throw new DocumentError("이미지를 열 수 없습니다.", { cause: error });
  }
  const landscape = bitmap.width > bitmap.height;
  const width = landscape ? A4.height : A4.width;
  const size = { width, height: (width * bitmap.height) / bitmap.width };
  return {
    name,
    pageCount: 1,
    pageSize: () => size,
    async render(_i, canvas, scale) {
      canvas.width = Math.round(size.width * scale);
      canvas.height = Math.round(size.height * scale);
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    },
    destroy: () => bitmap.close(),
  };
}
