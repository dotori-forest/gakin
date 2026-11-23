const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const { execFileSync } = require("child_process");
// --site tests the GitHub Pages build (run scripts/build-site.sh first).
const SITE = process.argv.includes("--site");
const ROOT = SITE ? path.resolve(__dirname, "../dist/site") : path.resolve(__dirname, "..");
const PAGE = SITE ? "index.html" : "editor.html";
const S = fs.mkdtempSync(path.join(os.tmpdir(), "gakin-e2e-"));
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
(async () => {
  const server = await serve();
  const b = await chromium.launch();
  // sample form PDF
  const gen = await b.newPage();
  await gen.setContent(`<html><body style="font-family:'WenQuanYi Zen Hei';padding:40px">
    <h1 style="text-align:center">휴가 신청서</h1><p>신청인: 홍길동 / 기간: 2026. 11. 20. ~ 11. 21.</p>
    <p style="margin-top:400px;text-align:right;font-size:18px">신청인 홍길동 (서명) ________________</p>
    <div style="page-break-before:always"><h2>붙임</h2><p>두 번째 쪽</p></div></body></html>`);
  await gen.pdf({ path: `${S}/sample.pdf`, format: "A4" });
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://localhost:${server.address().port}/${PAGE}`);
  await page.click("#newSigBtn");
  const box = await page.locator("#padCanvas").boundingBox();
  // cursive-ish signature: sample a parametric curve, speed varies
  const draw = async (pts) => {
    await page.mouse.move(box.x + pts[0][0], box.y + pts[0][1]); await page.mouse.down();
    for (const [x, y] of pts.slice(1)) await page.mouse.move(box.x + x, box.y + y);
    await page.mouse.up();
  };
  const s1 = []; for (let t = 0; t <= 1; t += 0.012) { const x = 120 + t * 360; const y = 150 - 60 * Math.sin(t * Math.PI * 3) * (1 - t * .4) + (Math.random() - .5) * 3; s1.push([x, y]); }
  await draw(s1);
  const s2 = []; for (let t = 0; t <= 1; t += 0.03) s2.push([200 + t * 260 + (Math.random()-.5)*2, 190 - t * 30 + (Math.random()-.5)*2]);
  await draw(s2);
  await page.screenshot({ path: `${S}/01-pad.png` });
  await page.click("#padSave");
  await page.setInputFiles("#fileInput", `${S}/sample.pdf`);
  await page.waitForSelector(".page canvas");
  await page.waitForTimeout(800);
  const pg = await page.locator(".page").first().boundingBox();
  await page.mouse.move(pg.x + pg.width * 0.78, pg.y + pg.height * 0.53);
  await page.screenshot({ path: `${S}/02-ghost.png` });
  await page.mouse.click(pg.x + pg.width * 0.78, pg.y + pg.height * 0.53);
  // drag a bit, resize a bit
  const it = await page.locator(".item").boundingBox();
  await page.mouse.move(it.x + it.width / 2, it.y + it.height / 2); await page.mouse.down();
  await page.mouse.move(it.x + it.width / 2 + 20, it.y + it.height / 2 - 6, { steps: 5 }); await page.mouse.up();
  const h = await page.locator(".item .handle").boundingBox();
  await page.mouse.move(h.x + 7, h.y + 7); await page.mouse.down(); await page.mouse.move(h.x + 27, h.y + 17, { steps: 5 }); await page.mouse.up();
  await page.screenshot({ path: `${S}/03-placed.png` });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#saveBtn")]);
  await dl.saveAs(`${S}/out.pdf`);
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem("gakin.signatures")));
  assert(stored.length === 1 && stored[0].strokes.length === 2, "signature saved with 2 strokes");
  // backup round trip: export, wipe storage, reload, import
  const [backup] = await Promise.all([page.waitForEvent("download"), page.click("#exportSigBtn")]);
  await backup.saveAs(`${S}/backup.json`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  assert(await page.locator(".sig-card").count() === 0, "storage cleared");
  await page.setInputFiles("#backupInput", `${S}/backup.json`);
  await page.waitForSelector(".sig-card");
  const restored = JSON.parse(await page.evaluate(() => localStorage.getItem("gakin.signatures")));
  const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
  assert(canon(restored) === canon(stored), "backup restores the same signature");
  assert(await page.locator(".web-only").first().isVisible(), "web-only notes shown outside the extension");
  assert(errors.length === 0, `no page errors ${JSON.stringify(errors)}`);
  if (SITE) {
    // Each deploy versions its CSS/JS so Safari can't mix a new page with old cached files.
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const unversioned = fs.readdirSync(path.join(ROOT, "src")).filter(f => f.endsWith(".js"))
      .flatMap(f => fs.readFileSync(path.join(ROOT, "src", f), "utf8").match(/(from |import\()"\.{1,2}\/[^"?]+"/g) || []);
    assert(/editor\.css\?v=\w+"/.test(html) && /editor\.js\?v=\w+"/.test(html) && unversioned.length === 0, `site: the stylesheet, entry script and every src import carry ?v= (${unversioned.join(", ") || "all versioned"})`);
  }
  const head = fs.readFileSync(`${S}/out.pdf`).subarray(0, 8).toString();
  assert(head.startsWith("%PDF-1.4"), "output is a PDF");
  try {
    const info = execFileSync("pdfinfo", [`${S}/out.pdf`]).toString();
    assert(/Pages:\s+2/.test(info), "output keeps 2 pages");
    const text = execFileSync("pdftotext", [`${S}/out.pdf`, "-"]).toString().trim();
    assert(text === "", "output has no editable text layer");
  } catch (e) { if (e.code === "ENOENT") console.log("skip - poppler-utils not installed"); else throw e; }
  console.log("artifacts:", S);
  await b.close();
  server.close();
})();
