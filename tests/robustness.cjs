// Storage and memory safeguards: broken or foreign data under the storage key
// cannot stop the editor from starting, the pre-namespacing key migrates, a
// failed save (full storage) is reported instead of claimed as saved, and
// pages far out of view give their bitmaps back.
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const S = fs.mkdtempSync(path.join(os.tmpdir(), "gakin-robust-"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".wasm": "application/wasm" };
function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok -", msg); }

const vector = (id, name) => ({ id, kind: "vector", name, color: "#1f2937", size: 3, width: 120, height: 60, strokes: [[[10, 30], [60, 20], [110, 40]]], createdAt: 1 });

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, r));
  const url = `http://localhost:${server.address().port}/editor.html`;
  const b = await chromium.launch();
  // 2× display so a zoomed page would exceed the bitmap cap without it.
  const page = await b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  const seed = async (key, value) => { await page.evaluate(([k, v]) => { localStorage.clear(); localStorage.setItem(k, v); }, [key, value]); await page.reload(); };
  const cards = () => page.locator(".sig-card").count();

  // 1. Broken or foreign data under the key: the editor still starts.
  for (const [label, value] of [["not JSON", "{oops"], ["an object", JSON.stringify({ theme: "dark" })], ["records without strokes", JSON.stringify([{ id: "a", kind: "vector" }, 42, null])]]) {
    await seed("gakin.signatures", value);
    await page.waitForSelector("#newSigBtn");
    assert(await cards() === 0 && await page.locator("#empty").isVisible(), `starts normally when storage holds ${label}`);
  }
  await seed("gakin.signatures", JSON.stringify([vector("dup", "첫째"), vector("dup", "둘째"), { ...vector("bad", "색"), color: ["#000000"] }, vector("ok", "셋째")]));
  assert(await cards() === 2, "keeps valid records only, first of each duplicated id");

  // 2. Signatures saved under the old key are picked up and saved under the new one.
  await seed("signatures", JSON.stringify([vector("legacy", "예전 서명")]));
  assert(await cards() === 1 && (await page.textContent(".sig-card")).includes("예전 서명"), "migrates signatures from the old key");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // 3. A failed save is reported, and the signature is not added.
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("full", "QuotaExceededError"); }; });
  await page.click("#newSigBtn");
  const box = await page.locator("#padCanvas").boundingBox();
  await page.mouse.move(box.x + 100, box.y + 150); await page.mouse.down();
  for (let x = 100; x <= 400; x += 10) await page.mouse.move(box.x + x, box.y + 150 + 40 * Math.sin(x / 30));
  await page.mouse.up();
  await page.click("#padSave");
  await page.waitForSelector("#toast:not([hidden])");
  await page.waitForTimeout(300);
  const msg = await page.textContent("#toast");
  assert(msg.includes("저장하지 못했습니다") && !msg.includes("저장했습니다"), `failed save shows the failure (${msg})`);
  assert(await cards() === 0, "failed save adds no signature");
  await page.reload();

  // 4. Long document: only pages near the view keep a bitmap; zoomed pages stay under the cap.
  const gen = await b.newPage();
  await gen.setContent(Array.from({ length: 30 }, (_, i) => `<div style="height:1000px;page-break-after:always"><h1>쪽 ${i + 1}</h1></div>`).join(""));
  await gen.pdf({ path: `${S}/long.pdf`, format: "A4" });
  // Pages with 20 000 vector lines take over a second to draw, so closing
  // soon after opening lands mid-draw without slowing the machine down.
  const lines = Array.from({ length: 20000 }, (_, i) => `<line x1="${i % 600}" y1="0" x2="${600 - (i % 600)}" y2="${800 + (i % 7)}" stroke="#${(i * 2654435761 % 0xffffff).toString(16).padStart(6, "0")}" stroke-width="0.3"/>`).join("");
  await gen.setContent(Array.from({ length: 2 }, () => `<svg width="600" height="820" style="page-break-after:always">${lines}</svg>`).join(""));
  await gen.pdf({ path: `${S}/heavy.pdf`, format: "A4" });
  await gen.close();
  await page.setInputFiles("#fileInput", `${S}/long.pdf`);
  await page.waitForFunction(() => document.querySelectorAll(".page").length === 30);
  const live = () => page.$$eval(".page canvas", cs => cs.filter(c => c.width > 0).length);
  await page.waitForFunction(() => document.querySelector(".page canvas").width > 0);
  for (let i = 0; i < 30; i += 3) {
    await page.$eval(".viewer", (v, n) => { v.scrollTop = document.querySelectorAll(".page")[n].offsetTop; }, i);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);
  const kept = await live();
  assert(kept > 0 && kept <= 6, `after scrolling 30 pages only nearby ones keep a bitmap (${kept})`);
  for (let i = 0; i < 8; i++) await page.click("#zoomIn").catch(() => {});
  await page.waitForTimeout(1500);
  const biggest = await page.$$eval(".page canvas", cs => Math.max(...cs.map(c => c.width * c.height)));
  assert(biggest > 12_000_000 && biggest <= 16_000_000, `zoomed page bitmap stays under the cap (${(biggest / 1e6).toFixed(1)} MP)`);


  // 5. Opening and closing quickly while pages are still drawing logs no errors
  //    (pdf.js reports the cancelled draw; that is expected, not an error).
  for (const delay of [0, 50, 150, 300, 600]) {
    await page.setInputFiles("#fileInput", `${S}/heavy.pdf`);
    // Opened is enough; drawing is what this races against.
    await page.waitForSelector(".page", { state: "attached", timeout: 60000 });
    await page.waitForTimeout(delay);
    // Press it directly: Playwright's click waits for the throttled page to
    // settle, which is exactly what this check must not do.
    await page.evaluate(() => document.getElementById("closeDocBtn").click());
    if (await page.evaluate(() => document.getElementById("confirmation-dialog").open)) await page.click("#confirmation-confirm");
  }
  await page.waitForTimeout(1500);
  assert(!errors.some(e => /Rendering|cancel/i.test(e)), "closing while pages draw logs no errors");

  // 6. A backup whose stamp image does not decode is not imported.
  const bad = { format: "gakin-signatures", version: 1, signatures: [{ id: "broken", kind: "image", name: "깨진 도장", width: 40, height: 40, dataUrl: "data:image/png;base64,AAAAAAAA", createdAt: 1 }] };
  fs.writeFileSync(`${S}/bad-backup.json`, JSON.stringify(bad));
  await page.evaluate(() => { document.getElementById("toast").textContent = ""; });
  await page.setInputFiles("#backupInput", `${S}/bad-backup.json`);
  await page.waitForFunction(() => document.getElementById("toast").textContent.length > 0);
  assert(await cards() === 0 && (await page.textContent("#toast")).includes("새로 불러올 서명이 없습니다"), "a stamp image that does not decode is not imported");

  // 7. Very large pages are exported under the canvas limit instead of failing.
  const exportScale = await page.evaluate(async () => {
    const { exportFlatPdf } = await import("./src/exporter.js");
    let used = 0;
    const doc = { name: "big.pdf", pageCount: 1, pageSize: () => ({ width: 2384, height: 3370 }), // A0 in points
      async render(_i, canvas, scale) { used = scale; canvas.width = Math.round(2384 * scale); canvas.height = Math.round(3370 * scale); } };
    await exportFlatPdf(doc, [], new Map(), { dpi: 300 });
    return { used, pixels: Math.round(2384 * used) * Math.round(3370 * used) };
  });
  assert(exportScale.pixels <= 16_100_000 && exportScale.used < 300 / 72, `an A0 page at 300 dpi is written under the canvas limit (${(exportScale.pixels / 1e6).toFixed(1)} MP)`);

  // 8. Framed by another page, the editor refuses to run.
  const framed = await b.newPage();
  await framed.setContent(`<iframe src="${url}" style="width:800px;height:400px"></iframe>`);
  await framed.waitForTimeout(1500);
  const frameText = await framed.frames()[1].evaluate(() => document.body.textContent);
  assert(frameText.includes("다른 사이트 안에서 열 수 없습니다"), "refuses to run inside another site's frame");
  await framed.close();

  assert(errors.length === 0, `no page errors ${JSON.stringify(errors)}`);
  console.log("artifacts:", S);
  await b.close();
  server.close();
})();
