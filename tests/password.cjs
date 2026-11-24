// Password-protected documents: PDF (tests/fixtures/locked.pdf, AES-256) and
// HWP/HWPX (generated here with rhwp). All use the password 1234. For each:
// cancelling the prompt keeps the editor empty, a wrong password asks again,
// the right one opens the pages, and the saved PDF needs no password.
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const S = fs.mkdtempSync(path.join(os.tmpdir(), "gakin-password-"));
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
  // The in-app dialog must be used, never the browser's own prompt().
  const nativeDialogs = [];
  page.on("dialog", d => { nativeDialogs.push(d.message()); d.dismiss(); });
  // Waits for the password dialog, then types the answer (Enter or 열기) or cancels.
  // Returns whether the dialog showed the wrong-password message.
  const answer = async (pw, { enter = false } = {}) => {
    await page.waitForSelector("#password-dialog[open]", { timeout: 60000 });
    const retry = await page.locator("#password-error").isVisible();
    if (pw === null) await page.click("#password-cancel");
    else {
      await page.fill("#password-input", pw);
      if (enter) await page.press("#password-input", "Enter"); else await page.click("#password-submit");
    }
    // Taken once the dialog closes, or (for a wrong HWP password, which re-asks
    // at once) comes back empty with the error showing.
    await page.waitForFunction(() => {
      const d = document.getElementById("password-dialog");
      return !d.open || (!document.getElementById("password-input").value && !document.getElementById("password-error").hidden);
    });
    return retry;
  };
  await page.goto(`http://localhost:${server.address().port}/editor.html`);

  const locked = await page.evaluate(async () => {
    const rhwp = await import("./vendor/rhwp/rhwp.js");
    await rhwp.default({ module_or_path: "./vendor/rhwp/rhwp_bg.wasm" });
    const doc = rhwp.HwpDocument.createEmpty();
    doc.createBlankDocument();
    const text = "암호 문서 본문";
    doc.insertText(0, 0, 0, text);
    doc.insertPageBreak(0, 0, text.length);
    const out = { hwp: [...doc.exportHwpWithPassword("1234")], hwpx: [...doc.exportHwpxWithPassword("1234")] };
    doc.free();
    return out;
  });
  fs.writeFileSync(`${S}/locked.hwp`, Buffer.from(locked.hwp));
  fs.writeFileSync(`${S}/locked.hwpx`, Buffer.from(locked.hwpx));
  fs.copyFileSync(path.join(__dirname, "fixtures/locked.pdf"), `${S}/locked.pdf`);

  for (const ext of ["pdf", "hwp", "hwpx"]) {
    const file = `${S}/locked.${ext}`;

    await page.setInputFiles("#fileInput", file);
    await page.waitForSelector("#password-dialog[open]", { timeout: 60000 });
    assert((await page.textContent("#password-description")).includes(`locked.${ext}`), `${ext}: dialog asks for the file's password`);
    assert(await page.locator("#password-submit").isDisabled(), `${ext}: 열기 disabled until a password is typed`);
    assert(await page.getAttribute("#password-input", "type") === "password", `${ext}: password is masked`);
    assert(await page.locator("#busy").isHidden(), `${ext}: progress overlay hidden while asking`);
    await answer(null);
    await page.waitForFunction(() => document.getElementById("toast").textContent.includes("취소"));
    assert(await page.locator("#docChip").isHidden() && await page.locator(".page").count() === 0, `${ext}: cancelling opens nothing`);
    await page.evaluate(() => { document.getElementById("toast").hidden = true; document.getElementById("toast").textContent = ""; });

    await page.setInputFiles("#fileInput", file);
    const firstRetry = await answer("0000");
    const secondRetry = await answer("1234", { enter: ext === "hwp" });
    await page.waitForFunction(n => document.getElementById("docName").textContent === n && document.querySelectorAll(".page canvas").length > 0, `locked.${ext}`, { timeout: 60000 });
    assert(!firstRetry && secondRetry, `${ext}: wrong password asks again with a message`);
    assert(await page.locator(".page").count() === 2, `${ext}: right password opens both pages`);

    // 저장 is off until something is placed.
    await page.click('.mark-btn[data-tool="check"]');
    await page.locator(".page").first().click({ position: { x: 150, y: 150 } });
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#saveBtn"),
    ]);
    await dl.saveAs(`${S}/out-${ext}.pdf`);
    const out = fs.readFileSync(`${S}/out-${ext}.pdf`).toString("latin1");
    assert(out.startsWith("%PDF-") && !out.includes("/Encrypt"), `${ext}: saved PDF opens without a password`);
    await page.click("#closeDocBtn");
  }

  assert(nativeDialogs.length === 0, `no browser prompt() ${JSON.stringify(nativeDialogs)}`);
  assert(errors.length === 0, `no page errors ${JSON.stringify(errors)}`);
  console.log("artifacts:", S);
  await b.close();
  server.close();
})();
