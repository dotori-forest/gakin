// 이름으로 만들기: fonts load, previews follow the name, fonts without a glyph
// are disabled, and the saved signature can be stamped and exported.
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const S = fs.mkdtempSync(path.join(os.tmpdir(), "gakin-name-"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".wasm": "application/wasm", ".ttf": "font/ttf", ".woff2": "font/woff2" };
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
  await gen.setContent("<h1>이름 서명 테스트</h1><p style='margin-top:500px'>(서명) ________</p>");
  await gen.pdf({ path: `${S}/sample.pdf`, format: "A4" });
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://localhost:${server.address().port}/editor.html`);

  await page.click("#moreSigBtn");
    await page.click("#nameSigBtn");
  await page.waitForSelector("#nameDialog[open]");
  assert(await page.locator(".font-choice").count() === 6, "four bundled fonts plus 굴림·돋움 offered");
  assert(await page.locator("#nameSave").isDisabled(), "save disabled before typing");

  await page.fill("#nameText", "홍길동");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => ["nanum-pen", "nanum-brush", "dokdo", "gaegu"].every(id => [...document.fonts].some(f => f.family === `gakin-${id}` && f.status === "loaded")), null, { timeout: 15000 });
  assert(true, "all four bundled fonts load from the package");
  // 굴림·돋움 come from the PC: shown when installed (Windows), hidden otherwise.
  const hasGulim = fs.existsSync("C:/Windows/Fonts/gulim.ttc");
  await page.waitForFunction(() => ["gulim", "dotum"].every(id => [...document.fonts].some(f => f.family === `gakin-${id}` && f.status !== "loading")) || document.querySelectorAll('.font-choice[data-failed="true"]').length === 2, null, { timeout: 15000 });
  const systemShown = await page.locator('.font-choice[data-font="gulim"]:visible, .font-choice[data-font="dotum"]:visible').count();
  assert(systemShown === (hasGulim ? 2 : 0), hasGulim ? "굴림·돋움 shown from this PC" : "굴림·돋움 hidden when not installed");
  const previews = await page.$$eval(".font-preview", els => els.map(e => e.dataset.text));
  assert(previews.every(t => t === "홍길동"), "previews show the typed name");
  // Every visible preview's ink sits in the middle of its box, at the same height.
  const inks = await page.$$eval(".font-choice:not([hidden]) .font-preview", els => els.map(c => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 40) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { dx: (minX + maxX) / 2 - c.width / 2, dy: (minY + maxY) / 2 - c.height / 2, h: (maxY - minY) / c.height };
  }));
  assert(inks.length >= 4 && inks.every(i => Math.abs(i.dx) <= 3 && Math.abs(i.dy) <= 3), `previews centred ${JSON.stringify(inks.map(i => [Math.round(i.dx), Math.round(i.dy)]))}`);
  assert(Math.max(...inks.map(i => i.h)) - Math.min(...inks.map(i => i.h)) < 0.08, "previews drawn at the same ink height");
  assert(await page.locator(".font-choice:visible:disabled").count() === 0, "every font has 홍길동");
  await page.screenshot({ path: `${S}/01-dialog.png` });

  // 갂 is outside both subset fonts; only the full-Hangul Nanum fonts have it.
  await page.fill("#nameText", "김갂");
  assert(await page.locator(".font-choice:visible:disabled").count() === 2, "fonts without 갂 are disabled");
  assert((await page.locator('.font-choice[data-font="dokdo"] .font-note').textContent()).includes("갂"), "the missing character is named");
  await page.screenshot({ path: `${S}/02-missing.png` });

  await page.fill("#nameText", "홍길동");
  await page.click('.font-choice[data-font="dokdo"]');
  assert(await page.locator('.font-choice[data-font="dokdo"]').getAttribute("aria-checked") === "true", "a font can be chosen");
  await page.click('[data-name-color="blue"]');
  await page.click("#nameSave");
  await page.waitForSelector(".sig-card");
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem("gakin.signatures")));
  assert(stored.length === 1 && stored[0].kind === "image" && stored[0].name === "홍길동", "saved as an image signature named after the text");
  assert(stored[0].width > stored[0].height * 1.6 && stored[0].width > 300, `rendered wide and sharp (${stored[0].width}x${stored[0].height})`);

  if (hasGulim) {
    await page.click("#moreSigBtn");
    await page.click("#nameSigBtn");
    await page.fill("#nameText", "홍길동");
    await page.click('.font-choice[data-font="gulim"]');
    await page.click("#nameSave");
    await page.waitForFunction(() => document.querySelectorAll(".sig-card").length === 2);
    const two = JSON.parse(await page.evaluate(() => localStorage.getItem("gakin.signatures")));
    assert(two.length === 2 && two[1].width > 300, "굴림 signature rendered from the PC font");
  }
  await page.setInputFiles("#fileInput", `${S}/sample.pdf`);
  await page.waitForSelector(".page canvas");
  if (hasGulim) await page.click(".sig-card >> nth=0"); // two signatures: pick the 동해 독도 one
  const pg = await page.locator(".page").first().boundingBox();
  await page.mouse.click(pg.x + pg.width * 0.7, pg.y + pg.height * 0.6);
  const item = await page.locator(".item").boundingBox();
  assert(item && item.width > item.height * 1.6 && item.width > 120, "stamped at signature size, not stamp size");
  await page.screenshot({ path: `${S}/03-placed.png` });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#saveBtn")]);
  await dl.saveAs(`${S}/out.pdf`);
  assert(fs.readFileSync(`${S}/out.pdf`).subarray(0, 5).toString() === "%PDF-", "PDF with the name signature saved");

  assert(errors.length === 0, `no page errors ${JSON.stringify(errors)}`);
  console.log("artifacts:", S);
  await b.close();
  server.close();
})();
