// Opens a PDF, stamps a signature, closes the document (with and without the
// unsaved-stamps confirmation) and checks the editor is back to empty.
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const S = fs.mkdtempSync(path.join(os.tmpdir(), "gakin-close-"));
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
  const gen = await b.newPage();
  await gen.setContent("<h1>닫기 테스트</h1><p style='margin-top:500px'>(서명) ________</p>");
  await gen.pdf({ path: `${S}/sample.pdf`, format: "A4" });
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://localhost:${server.address().port}/editor.html`);

  const order = await page.$$eval(".topbar > *", els => els.map(el => el.id).filter(Boolean));
  assert(order.indexOf("openBtn") + 2 === order.indexOf("saveGroup"), "file-open button sits left of save");
  assert(await page.locator(".sidebar #dpi").isVisible() && await page.locator("#dpi").inputValue() === "200", "quality select in the sidebar, 보통 by default");
  assert(await page.locator("#viewerTools").isHidden(), "zoom tools hidden before opening");
  assert(await page.locator("#docChip").isHidden(), "no file name before opening");

  // draw a signature
  await page.click("#newSigBtn");
  const box = await page.locator("#padCanvas").boundingBox();
  await page.mouse.move(box.x + 100, box.y + 120); await page.mouse.down();
  for (let i = 0; i < 30; i++) await page.mouse.move(box.x + 100 + i * 10, box.y + 120 + Math.sin(i / 3) * 30);
  await page.mouse.up();
  await page.click("#padSave");

  await page.setInputFiles("#fileInput", `${S}/sample.pdf`);
  await page.waitForSelector(".page canvas");
  assert(await page.locator("#docName").textContent() === "sample.pdf", "file name shown with close button");
  await page.screenshot({ path: `${S}/01-open.png` });
  assert(await page.locator(".viewer-area #viewerTools").isVisible(), "zoom tools float over the document");
  const zoom = () => page.locator("#zoomLabel").textContent();
  await page.click("#zoomIn");
  assert(await zoom() === "125%", "zoom-in button works");
  await page.click("#zoomOut");
  const v = await page.locator("#viewer").boundingBox();
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await page.waitForTimeout(100);
  assert(await zoom() === "125%", "ctrl + wheel up zooms in");
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 100);
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Control");
  await page.waitForTimeout(100);
  assert(await zoom() === "80%", "ctrl + wheel down zooms out");
  const before = await page.evaluate(() => document.getElementById("viewer").scrollTop);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(200);
  assert(await zoom() === "80%" && await page.evaluate(() => document.getElementById("viewer").scrollTop) > before, "plain wheel still scrolls");
  await page.evaluate(() => document.getElementById("viewer").scrollTop = 0);
  await page.click("#zoomIn");

  // stamp, then close: confirmation appears; cancel keeps the document
  const pg = await page.locator(".page").first().boundingBox();
  await page.mouse.click(pg.x + pg.width * 0.7, pg.y + pg.height * 0.6);
  assert(await page.locator(".item").count() === 1, "stamp placed");
  await page.click("#closeDocBtn");
  await page.waitForSelector("#confirmation-dialog[open]");
  await page.click("#confirmation-cancel");
  assert(await page.locator(".page").count() > 0 && await page.locator(".item").count() === 1, "cancel keeps document and stamp");

  await page.click("#closeDocBtn");
  await page.click("#confirmation-confirm");
  assert(await page.locator(".page").count() === 0, "pages removed");
  assert(await page.locator("#empty").isVisible(), "empty drop area back");
  assert(await page.locator("#docChip").isHidden(), "file name hidden");
  assert(await page.locator("#saveBtn").isDisabled() && await page.locator("#zoomIn").isDisabled(), "save and zoom disabled");
  assert(await page.locator("#viewerTools").isHidden(), "zoom tools hidden after closing");
  await page.screenshot({ path: `${S}/02-closed.png` });

  // reopen and close with nothing stamped: no confirmation
  await page.setInputFiles("#fileInput", `${S}/sample.pdf`);
  await page.waitForSelector(".page canvas");
  await page.keyboard.press("Escape");
  await page.click("#closeDocBtn");
  await page.waitForTimeout(200);
  assert(await page.locator("#confirmation-dialog[open]").count() === 0 && await page.locator(".page").count() === 0, "closes without asking when nothing is stamped");

  assert(errors.length === 0, `no page errors ${JSON.stringify(errors)}`);
  console.log("artifacts:", S);
  await b.close();
  server.close();
})();
