// Opens 한글 documents (HWP and HWPX, generated here with rhwp itself), checks the
// pages render, stamps a signature and saves a flattened PDF. Also checks that a
// broken .hwp is rejected with a message instead of an error.
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const S = fs.mkdtempSync(path.join(os.tmpdir(), "gakin-hwp-"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".wasm": "application/wasm" };
function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok -", msg); }

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, r));
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://localhost:${server.address().port}/editor.html`);

  // Two-page sample document, saved as both HWP and HWPX.
  const samples = await page.evaluate(async () => {
    const rhwp = await import("./vendor/rhwp/rhwp.js");
    await rhwp.default({ module_or_path: "./vendor/rhwp/rhwp_bg.wasm" });
    const doc = rhwp.HwpDocument.createEmpty();
    doc.createBlankDocument();
    const text = "휴가 신청서 — 신청인 홍길동 (서명) ________";
    doc.insertText(0, 0, 0, text);
    doc.insertPageBreak(0, 0, text.length);
    doc.insertText(0, 1, 0, "붙임");
    const out = { hwp: [...doc.exportHwp()], hwpx: [...doc.exportHwpx()] };
    doc.free();
    return out;
  });
  fs.writeFileSync(`${S}/sample.hwp`, Buffer.from(samples.hwp));
  fs.writeFileSync(`${S}/sample.hwpx`, Buffer.from(samples.hwpx));

  // draw a signature
  await page.click("#newSigBtn");
  const box = await page.locator("#padCanvas").boundingBox();
  await page.mouse.move(box.x + 120, box.y + 150); await page.mouse.down();
  for (let t = 0; t <= 1; t += 0.02) await page.mouse.move(box.x + 120 + t * 360, box.y + 150 - 50 * Math.sin(t * Math.PI * 3));
  await page.mouse.up();
  await page.click("#padSave");

  for (const ext of ["hwp", "hwpx"]) {
    await page.setInputFiles("#fileInput", `${S}/sample.${ext}`);
    await page.waitForFunction(n => document.querySelectorAll(".page").length === 2 && document.getElementById("docName").textContent === n, `sample.${ext}`, { timeout: 60000 });
    await page.waitForFunction(() => {
      const c = document.querySelector(".page canvas");
      if (!c || !c.width) return false;
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) return true;
      return false;
    }, null, { timeout: 30000 });
    assert(true, `${ext}: both pages laid out and text painted`);
    const pg = await page.locator(".page").first().boundingBox();
    assert(Math.abs(pg.height / pg.width - 297 / 210) < 0.01, `${ext}: page has A4 proportions`);
    if (await page.locator(".sig-card").first().getAttribute("aria-pressed") !== "true") await page.locator(".sig-card").first().click();
    await page.mouse.click(pg.x + pg.width * 0.7, pg.y + pg.height * 0.2);
    assert(await page.locator(".item").count() === 1, `${ext}: signature stamped`);
    await page.screenshot({ path: `${S}/${ext}.png` });
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#saveBtn")]);
    assert(dl.suggestedFilename() === "sample_서명.pdf", `${ext}: saved as sample_서명.pdf`);
    await dl.saveAs(`${S}/${ext}.pdf`);
    assert(fs.readFileSync(`${S}/${ext}.pdf`).subarray(0, 5).toString() === "%PDF-", `${ext}: output is a PDF`);
    // The stamp must be in the saved page image where it was placed (around
    // 70% across, 20% down), not just on screen.
    const pdf = fs.readFileSync(`${S}/${ext}.pdf`);
    const jpegStart = pdf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    const jpeg = pdf.subarray(jpegStart, pdf.indexOf(Buffer.from([0xff, 0xd9]), jpegStart) + 2).toString("base64");
    const ink = await page.evaluate(async b64 => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob());
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      const x0 = Math.round(c.width * 0.55), y0 = Math.round(c.height * 0.15);
      const d = ctx.getImageData(x0, y0, Math.round(c.width * 0.3), Math.round(c.height * 0.1)).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 100) dark++;
      return dark;
    }, jpeg);
    assert(ink > 200, `${ext}: the stamp is in the saved PDF (${ink} dark pixels where it was placed)`);
    try {
      const info = execFileSync("pdfinfo", [`${S}/${ext}.pdf`]).toString();
      assert(/Pages:\s+2/.test(info), `${ext}: output keeps 2 pages`);
      assert(/Page size:\s+595\.\d+ x 841\.\d+/.test(info), `${ext}: output pages are A4`);
    } catch (e) { if (e.code === "ENOENT") console.log("skip - poppler-utils not installed"); else throw e; }
  }

  // A broken file is refused with a message and keeps the open document.
  fs.writeFileSync(`${S}/broken.hwp`, "not a hwp file");
  await page.setInputFiles("#fileInput", `${S}/broken.hwp`);
  await page.waitForSelector("#toast:not([hidden])");
  assert((await page.textContent("#toast")).includes("한글 문서를 열 수 없습니다"), "broken .hwp shows an error message");
  assert(await page.textContent("#docName") === "sample.hwpx", "broken file leaves the open document in place");

  assert(errors.length === 0, `no page errors ${JSON.stringify(errors)}`);
  console.log("artifacts:", S);
  await b.close();
  server.close();
})();
