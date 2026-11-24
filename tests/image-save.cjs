// PNG·JPG로 저장: computers get a .png/.jpg (or a .zip of them for several pages),
// phones get 이미지로 저장 (PNG) as the main button and the share sheet.
// The ⋯ menus also open when the mouse rests on ⋯.
const { chromium, devices } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const ROOT = path.resolve(__dirname, "..");
const S = fs.mkdtempSync(path.join(os.tmpdir(), "gakin-img-"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".wasm": "application/wasm", ".json": "application/json" };
function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, () => r(server)));
}
function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok -", msg); }
const isPng = buf => buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const isJpeg = buf => buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;

// Reads the stored entries of a zip from its central directory.
function zipEntries(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    entries.push({ name, data: buf.subarray(dataAt, dataAt + size) });
    at += 46 + nameLen + extra + comment;
  }
  return entries;
}

// Puts a check mark on page n (0-based); 저장 stays off until something is placed.
async function markPage(page, n, { tap = false } = {}) {
  const tool = page.locator('.mark-btn[data-tool="check"]');
  const target = page.locator(".page").nth(n);
  await target.scrollIntoViewIfNeeded();
  if (tap) { await tool.tap(); await target.tap({ position: { x: 120, y: 120 } }); }
  else { await tool.click(); await target.click({ position: { x: 200, y: 200 } }); }
}

(async () => {
  const server = await serve();
  const url = `http://localhost:${server.address().port}/editor.html`;
  const b = await chromium.launch();
  const gen = await b.newPage();
  await gen.setContent(`<h1>첫 쪽</h1><div style="page-break-before:always"><h1>두 번째 쪽</h1></div>`);
  await gen.pdf({ path: `${S}/two.pdf`, format: "A4" });
  await gen.setContent(`<h1>한 쪽</h1>`);
  await gen.pdf({ path: `${S}/one.pdf`, format: "A4" });
  await gen.close();

  // ---------- computer ----------
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(url);
  assert(await page.locator("#saveLabel").textContent() === "PDF로 저장", "computer: the main button saves a PDF");
  assert(await page.locator("#moreSaveBtn").isDisabled(), "⋯ disabled before a file is open");
  await page.setInputFiles("#fileInput", `${S}/two.pdf`);
  await page.waitForSelector(".page canvas");
  assert(await page.locator("#saveBtn").isDisabled() && await page.locator("#moreSaveBtn").isDisabled(), "저장 stays off while nothing is placed");
  await markPage(page, 1);
  assert(await page.locator(".item.is-shape").count() === 1 && await page.locator("#saveBtn").isEnabled(), "placing a mark on page 2 turns 저장 on");
  // resting the mouse on ⋯ opens the menu; leaving the button and the menu closes it
  await page.hover("#moreSaveBtn");
  assert(await page.locator("#saveMenu").isVisible(), "hovering ⋯ opens the save menu");
  const items = (await page.locator("#saveMenu .menu-item").allTextContents()).map(t => t.trim());
  assert(items.join("|") === "PDF로 저장|PNG로 저장|JPG로 저장", `the save menu offers PDF, PNG and JPG (${items.join(", ")})`);
  await page.hover("#saveJpgItem");
  await page.waitForTimeout(400);
  assert(await page.locator("#saveMenu").isVisible(), "moving from ⋯ down into the menu keeps it open");
  await page.mouse.move(640, 600);
  await page.waitForTimeout(450);
  assert(await page.locator("#saveMenu").isHidden(), "moving the mouse away closes a hover-opened menu");
  await page.hover("#moreSigBtn");
  assert(await page.locator("#sigMenu").isVisible(), "hovering the ⋯ in 서명 그리기 opens its menu too");
  await page.click("#moreSigBtn");
  await page.mouse.move(640, 600);
  await page.waitForTimeout(450);
  assert(await page.locator("#sigMenu").isVisible() && await page.evaluate(() => document.activeElement.id) === "nameSigBtn", "clicking ⋯ after hovering keeps the menu open (focus on the first item)");
  await page.keyboard.press("Escape");
  await page.click("#moreSaveBtn");
  assert(await page.locator("#saveMenu").isVisible(), "⋯ opens the save menu");
  await page.keyboard.press("Escape");
  assert(await page.locator("#saveMenu").isHidden() && await page.evaluate(() => document.activeElement.id) === "moreSaveBtn", "Escape closes the menu and returns focus");

  // Images cover only the signed/marked pages; PDF keeps them all.
  await page.click("#moreSaveBtn");
  const [markedDl] = await Promise.all([page.waitForEvent("download"), page.click("#savePngItem")]);
  assert(markedDl.suggestedFilename() === "two_서명.png", `only the marked page 2 is saved, as one image (${markedDl.suggestedFilename()})`);
  await page.click("#moreSaveBtn");
  const [allPdf] = await Promise.all([page.waitForEvent("download"), page.click("#savePdfItem")]);
  await allPdf.saveAs(`${S}/two-marked.pdf`);
  const pdfPages = (fs.readFileSync(`${S}/two-marked.pdf`, "latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert(pdfPages === 2, `PDF still saves both pages (${pdfPages})`);
  await markPage(page, 0);
  await page.click("#moreSaveBtn");
  const [zipDl] = await Promise.all([page.waitForEvent("download"), page.click("#saveJpgItem")]);
  assert(zipDl.suggestedFilename() === "two_서명.zip", `two marked pages download as one zip (${zipDl.suggestedFilename()})`);
  await zipDl.saveAs(`${S}/two.zip`);
  const entries = zipEntries(fs.readFileSync(`${S}/two.zip`));
  assert(entries.length === 2 && entries[0].name === "two_서명_1.jpg" && entries[1].name === "two_서명_2.jpg", `zip holds one JPEG per page (${entries.map(e => e.name)})`);
  assert(entries.every(e => isJpeg(e.data)), "zip entries are whole JPEGs");

  await page.setInputFiles("#fileInput", `${S}/one.pdf`);
  await page.waitForFunction(() => document.querySelector("#docName").textContent === "one.pdf");
  await page.waitForSelector(".page canvas");
  await markPage(page, 0);
  await page.click("#moreSaveBtn");
  const [jpgDl] = await Promise.all([page.waitForEvent("download"), page.click("#saveJpgItem")]);
  assert(jpgDl.suggestedFilename() === "one_서명.jpg", `one page downloads as a .jpg (${jpgDl.suggestedFilename()})`);
  await jpgDl.saveAs(`${S}/one.jpg`);
  assert(isJpeg(fs.readFileSync(`${S}/one.jpg`)), "the .jpg is a JPEG");
  await page.click("#moreSaveBtn");
  const [pngDl] = await Promise.all([page.waitForEvent("download"), page.click("#savePngItem")]);
  assert(pngDl.suggestedFilename() === "one_서명.png", `PNG로 저장 downloads a .png (${pngDl.suggestedFilename()})`);
  await pngDl.saveAs(`${S}/one.png`);
  assert(isPng(fs.readFileSync(`${S}/one.png`)), "the .png is a PNG");
  await page.click("#moreSaveBtn");
  const [pdfDl] = await Promise.all([page.waitForEvent("download"), page.click("#savePdfItem")]);
  assert(pdfDl.suggestedFilename() === "one_서명.pdf", "the menu still saves a PDF");
  assert(errors.length === 0, `no page errors (${errors})`);
  await page.close();

  // ---------- phone ----------
  const phone = await b.newContext({ ...devices["iPhone 13"], defaultBrowserType: undefined });
  await phone.addInitScript(() => {
    window.__shared = [];
    navigator.canShare = data => Array.isArray(data?.files);
    navigator.share = async data => { window.__shared.push(data.files.map(f => ({ name: f.name, type: f.type, size: f.size }))); };
  });
  const pp = await phone.newPage();
  await pp.goto(url);
  assert(await pp.locator("#saveLabel").textContent() === "이미지로 저장", "phone: the main button saves images");
  await pp.setInputFiles("#fileInput", `${S}/two.pdf`);
  await pp.waitForSelector(".page canvas");
  const right = await pp.evaluate(() => innerWidth - document.querySelector("#saveGroup").getBoundingClientRect().right);
  assert(right >= 0 && right <= 16, `phone: save buttons fit at the right edge (${right}px)`);
  await markPage(pp, 0, { tap: true });
  await markPage(pp, 1, { tap: true });
  await pp.tap("#saveBtn");
  await pp.waitForFunction(() => window.__shared.length === 1);
  const shared = await pp.evaluate(() => window.__shared[0]);
  assert(shared.length === 2 && shared.every(f => f.type === "image/png" && f.size > 0) && shared[0].name === "two_서명_1.png", `phone: pages go to the share sheet as PNGs (${shared.map(f => f.name)})`);
  await pp.tap("#moreSaveBtn");
  const menu = await pp.locator("#saveMenu").boundingBox();
  assert(menu && menu.x >= 0 && menu.x + menu.width <= 390 && menu.y > 0, "phone: the save menu opens below the button, on screen");
  await phone.close();

  await b.close();
  server.close();
})();
