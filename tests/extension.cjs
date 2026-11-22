// Loads the unpacked extension in Chromium and checks that the editor page
// opens a PDF and saves a signed copy without CSP or runtime errors.
// Usage: node tests/extension.cjs [sample.pdf]  (makes a sample PDF when omitted)
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gakin-profile-"));
  let pdf = process.argv[2];
  if (!pdf) {
    pdf = path.join(profile, "sample.pdf");
    const b = await chromium.launch();
    const gen = await b.newPage();
    await gen.setContent("<h1>서명 테스트</h1><p style='margin-top:500px'>(서명) ________</p>");
    await gen.pdf({ path: pdf, format: "A4" });
    await b.close();
  }
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const id = new URL(sw.url()).host;
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => m.type() === "error" && errors.push(m.text()));
  await page.goto(`chrome-extension://${id}/editor.html`);
  // 이름으로 만들기: bundled fonts must load under the extension's CSP.
  await page.click("#moreSigBtn");
    await page.click("#nameSigBtn");
  await page.fill("#nameText", "홍길동");
  await page.waitForFunction(() => ["nanum-pen", "nanum-brush", "dokdo", "gaegu"].every(id => [...document.fonts].some(f => f.family === `gakin-${id}` && f.status === "loaded")), null, { timeout: 15000 });
  await page.click("#nameSave");
  await page.waitForSelector(".sig-card");
  console.log("ok - name signature made with bundled fonts");
  await page.setInputFiles("#fileInput", pdf);
  await page.waitForSelector(".page canvas");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#saveBtn").then(() => page.click("#confirmation-confirm")),
  ]);
  const name = download.suggestedFilename();
  console.log(name.endsWith("_서명.pdf") ? "ok" : "FAIL", "- download name", name);
  console.log(errors.length === 0 ? "ok" : "FAIL", "- no errors", JSON.stringify(errors));
  if (errors.length || !name.endsWith("_서명.pdf")) process.exitCode = 1;
  await ctx.close();
})();
