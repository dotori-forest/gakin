// 글자·표시 넣기: text (typed, today's date, my name) and marks (check,
// circle, cross) are placed, edited, moved, resized, restyled and undone like
// stamps, and the saved PDF draws them where they were placed.
const { chromium, webkit, devices } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const S = fs.mkdtempSync(path.join(os.tmpdir(), "gakin-marks-"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".wasm": "application/wasm" };
function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok -", msg); }

const SIG = { id: "s1", kind: "vector", name: "서명", color: "#000000", size: 5, width: 300, height: 100, strokes: [[[10, 50], [150, 20], [290, 50]]], createdAt: 1 };
const NAME_SIG = { id: "n1", kind: "image", name: "김길동", width: 2, height: 1, dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0AAQ2mR8oAAAAASUVORK5CYII=", createdAt: 2 };

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
  const gen = await b.newPage();
  await gen.setContent("<p style='font:14px sans-serif'>□ 상 &nbsp; □ 중 &nbsp; □ 하</p>");
  await gen.pdf({ path: `${S}/form.pdf`, format: "A4" });
  await gen.close();

  const errors = [];
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  await page.evaluate(sigs => localStorage.setItem("gakin.signatures", JSON.stringify(sigs)), [SIG, NAME_SIG]);
  await page.reload();
  await page.setInputFiles("#fileInput", `${S}/form.pdf`);
  await page.waitForSelector(".page canvas");
  const pg = await page.locator(".page").first().boundingBox();
  const at = (fx, fy) => ({ x: pg.x + pg.width * fx, y: pg.y + pg.height * fy });
  const marks = () => page.evaluate(() => [...document.querySelectorAll(".item")].map(el => ({ kind: el.className, text: el.querySelector(".mark-text")?.textContent ?? null, width: el.style.width, left: el.style.left })));
  const tool = name => page.click(`.mark-btn[data-tool="${name}"]`);

  // desktop sidebar: 서명 그리기|⋯ on top, signatures, then the tools row just above the settings
  const side = await page.evaluate(() => {
    const r = q => document.querySelector(q).getBoundingClientRect();
    return { make: r(".sig-make"), draw: r("#newSigBtn"), more: r("#moreSigBtn"), list: r("#sigList"), tools: r(".mark-tools"), foot: r("#sidebarFoot"), heading: Boolean(document.querySelector("#sidebarFoot h2")) };
  });
  assert(side.more.left >= side.draw.right - 1 && side.more.right <= side.make.right && side.more.top >= side.make.top && side.more.bottom <= side.make.bottom, "⋯ sits inside the 서명 그리기 button shape, after its label");
  assert(side.list.bottom <= side.tools.top && side.tools.bottom <= side.foot.top && side.foot.top - side.tools.bottom < 40, "desktop: the tools row sits under the signatures, right above the settings");
  assert(!side.heading && await page.locator("#dpi").isVisible() && await page.locator("#exportSigBtn").isVisible(), "desktop: the settings rows show without a 설정 heading");

  // ⋯ next to 서명 그리기 holds the other ways to make a signature
  assert(await page.locator("#sigMenu").isHidden() && await page.locator("#nameSigBtn").isHidden(), "the ⋯ menu starts closed");
  await page.click("#moreSigBtn");
  const labels = (await page.locator("#sigMenu .menu-item").allTextContents()).map(t => t.trim());
  assert(await page.locator("#sigMenu").isVisible() && labels.join("|") === "이름으로 만들기|이미지로 만들기", `⋯ opens 이름으로 만들기 and 이미지로 만들기 (${labels.join(", ")})`);
  assert(await page.evaluate(() => document.activeElement.id) === "nameSigBtn", "the first menu item takes focus");
  await page.keyboard.press("ArrowDown");
  assert(await page.evaluate(() => document.activeElement.id) === "importStampBtn", "arrow keys move through the menu");
  await page.keyboard.press("Escape");
  assert(await page.locator("#sigMenu").isHidden() && await page.evaluate(() => document.activeElement.id) === "moreSigBtn", "Esc closes the menu and returns to ⋯");
  await page.click("#moreSigBtn");
  await page.mouse.click(pg.x + pg.width * 0.9, pg.y + pg.height * 0.95);
  assert(await page.locator("#sigMenu").isHidden(), "clicking elsewhere closes the menu");
  assert(await page.locator(".privacy").filter({ hasText: /기기 밖으로|법적 효력/ }).count() === 0, "the two footer notes are gone");

  // typed text: a box opens for typing, Enter adds a line, Esc finishes
  await tool("text");
  assert(await page.locator('.mark-btn[data-tool="text"]').getAttribute("aria-pressed") === "true", "글자 arms text placing");
  let p = at(0.15, 0.3);
  await page.mouse.click(p.x, p.y);
  await page.waitForSelector(".item.editing");
  await page.keyboard.type("확인했습니다");
  await page.keyboard.press("Enter");
  await page.keyboard.type("홍길동");
  await page.keyboard.press("Escape");
  let m = await marks();
  assert(m.length === 1 && m[0].text === "확인했습니다\n홍길동" && !(await page.locator(".item.editing").count()), "글자: typed two lines, Esc finishes");
  await page.keyboard.press("Control+z");
  assert((await marks()).length === 0, "undo removes the typed text in one step");
  await page.keyboard.press("Control+Shift+z");
  assert((await marks())[0]?.text === "확인했습니다\n홍길동", "redo brings it back");

  // an empty text box disappears and leaves no undo step
  const undoBefore = await page.locator("#undoItemBtn").isEnabled();
  await tool("text");
  p = at(0.5, 0.6);
  await page.mouse.click(p.x, p.y);
  await page.waitForSelector(".item.editing");
  await page.keyboard.press("Escape");
  assert((await marks()).length === 1, "an empty text box is removed");

  // double-click edits; changed text is one undo step
  await page.locator(".item.is-text").dblclick();
  await page.waitForSelector(".item.editing");
  await page.keyboard.press("End");
  await page.keyboard.type("(인)");
  await page.mouse.click(at(0.8, 0.9).x, at(0.8, 0.9).y);
  assert((await marks())[0].text === "확인했습니다\n홍길동(인)", "double-click edits the text, clicking elsewhere finishes");
  await page.keyboard.press("Control+z");
  assert((await marks())[0].text === "확인했습니다\n홍길동", "undo reverts the edit");

  // date and name
  await tool("date");
  p = at(0.15, 0.45);
  await page.mouse.click(p.x, p.y);
  const today = new Date();
  const dateText = `${today.getFullYear()}. ${today.getMonth() + 1}. ${today.getDate()}.`;
  assert((await marks()).some(x => x.text === dateText), `날짜 puts today's date (${dateText})`);
  await tool("name");
  p = at(0.15, 0.52);
  await page.mouse.click(p.x, p.y);
  assert((await marks()).some(x => x.text === "김길동"), "이름 puts the name from 이름으로 만들기");

  // marks: check in the first box, circle around 중, cross
  await tool("check");
  p = at(0.115, 0.0335);
  await page.mouse.click(p.x, p.y);
  await tool("circle");
  p = at(0.21, 0.0335);
  await page.mouse.click(p.x, p.y);
  await tool("cross");
  p = at(0.7, 0.3);
  await page.mouse.click(p.x, p.y);
  m = await marks();
  assert(m.filter(x => x.kind.includes("is-shape")).length === 3, "체크, 동그라미 and 엑스 are placed");

  // a circle is round; dragging keeps it round, Shift stretches it into an oval
  const circle = page.locator(".item.is-shape").nth(1);
  await circle.click();
  const cb = await circle.boundingBox();
  assert(Math.abs(cb.width - cb.height) < 1, `동그라미 starts as a circle (${cb.width.toFixed(0)}×${cb.height.toFixed(0)})`);
  const drag = async (dx, dy, shift) => {
    const h = await page.locator(".item.selected .handle").boundingBox();
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + dx, h.y + h.height / 2 + dy, { steps: 5 });
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
    return circle.boundingBox();
  };
  const round = await drag(20, 4, false);
  assert(round.width > cb.width + 15 && Math.abs(round.width - round.height) < 1, "dragging the handle enlarges it and keeps it round");
  const oval = await drag(40, 0, true);
  assert(oval.width > round.width + 30 && Math.abs(oval.height - round.height) < 6, "with Shift it stretches into an oval around a word");
  await page.keyboard.press("Control+z");
  const back = await circle.boundingBox();
  assert(Math.abs(back.width - round.width) < 1, "undo reverts the stretch");

  // resizing a text box scales its font
  const date = page.locator(".item.is-text").filter({ hasText: dateText });
  await date.click();
  const fontBefore = await date.evaluate(el => parseFloat(getComputedStyle(el.querySelector(".mark-text")).fontSize));
  const dh = await page.locator(".item.selected .handle").boundingBox();
  await page.mouse.move(dh.x + dh.width / 2, dh.y + dh.height / 2);
  await page.mouse.down();
  await page.mouse.move(dh.x + dh.width / 2 + 60, dh.y + dh.height / 2, { steps: 5 });
  await page.mouse.up();
  const fontAfter = await date.evaluate(el => parseFloat(getComputedStyle(el.querySelector(".mark-text")).fontSize));
  assert(fontAfter > fontBefore * 1.2, `resizing a text box scales its font (${fontBefore.toFixed(1)} → ${fontAfter.toFixed(1)}px)`);
  assert(await page.locator("#textSize, [data-mark-color]").count() === 0, "no separate size or colour controls");

  // keyboard editing of a selected text: Enter starts editing
  await date.focus();
  await page.keyboard.press("Enter");
  assert(await page.locator(".item.editing").count() === 1, "Enter on a selected text edits it");
  await page.keyboard.press("Escape");

  await page.screenshot({ path: `${S}/desktop.png` });

  // the saved PDF draws text and marks where they were placed
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#saveBtn")]);
  await dl.saveAs(`${S}/marks.pdf`);
  const pdf = fs.readFileSync(`${S}/marks.pdf`);
  const s = pdf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  const jpeg = pdf.subarray(s, pdf.indexOf(Buffer.from([0xff, 0xd9]), s) + 2).toString("base64");
  const ink = await page.evaluate(async ({ b64, regions }) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob());
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    return regions.map(([x, y, w, h]) => {
      const d = ctx.getImageData(Math.round(c.width * x), Math.round(c.height * y), Math.round(c.width * w), Math.round(c.height * h)).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 120) dark++;
      return dark;
    });
  }, { b64: jpeg, regions: [[0.15, 0.28, 0.2, 0.06], [0.15, 0.43, 0.2, 0.04], [0.15, 0.50, 0.12, 0.04], [0.66, 0.28, 0.08, 0.04], [0.45, 0.55, 0.3, 0.1]] });
  assert(ink[0] > 300 && ink[1] > 150 && ink[2] > 100, `saved PDF has the typed text, date and name (${ink.slice(0, 3).join(", ")} dark pixels)`);
  assert(ink[3] > 30, `saved PDF has the cross mark (${ink[3]} dark pixels)`);
  assert(ink[4] < 20, "the removed empty text box left nothing behind");

  // ---------- phone: the tools sit in one row under the signatures, tap to place ----------
  const ctx = await b.newContext({ ...devices["iPhone 13"], defaultBrowserType: undefined });
  const phone = await ctx.newPage();
  phone.on("pageerror", e => errors.push(e.message));
  await phone.goto(url);
  await phone.evaluate(sigs => localStorage.setItem("gakin.signatures", JSON.stringify(sigs)), [SIG]);
  await phone.reload();
  await phone.setInputFiles("#fileInput", `${S}/form.pdf`);
  await phone.waitForSelector(".page canvas");
  const row = await phone.evaluate(() => {
    const r = q => document.querySelector(q).getBoundingClientRect();
    return { tools: r(".mark-tools"), sidebar: r(".sidebar"), scrollW: document.documentElement.scrollWidth, w: innerWidth };
  });
  assert(row.tools.height < 60 && row.tools.bottom <= row.sidebar.bottom && row.scrollW <= row.w, "phone: the tools are one row in the bottom bar");
  assert(await phone.locator('.mark-btn[data-tool="name"]').isDisabled(), "phone: 이름 waits until a name signature exists");
  await phone.click("#moreSigBtn");
  const menu = await phone.locator("#sigMenu").boundingBox();
  const bar = await phone.locator(".sidebar").boundingBox();
  const onTop = await phone.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest("#sigMenu")), { x: menu.x + menu.width / 2, y: menu.y + menu.height / 2 });
  assert(menu.y >= 0 && menu.y < bar.y && menu.x >= 0 && menu.x + menu.width <= row.w && onTop, "phone: the ⋯ menu opens upwards, on screen and on top");
  await phone.click("#moreSigBtn");
  await phone.click('.mark-btn[data-tool="check"]');
  const pp = await phone.locator(".page").first().boundingBox();
  await phone.touchscreen.tap(pp.x + pp.width * 0.5, pp.y + pp.height * 0.4);
  await phone.waitForTimeout(200);
  assert(await phone.locator(".item.is-shape").count() === 1, "phone: a tap places a check mark");
  await phone.click('.mark-btn[data-tool="text"]');
  await phone.touchscreen.tap(pp.x + pp.width * 0.2, pp.y + pp.height * 0.6);
  await phone.waitForTimeout(700);
  assert(await phone.locator(".item.editing").count() === 1 && await phone.evaluate(() => document.activeElement?.classList.contains("mark-text")), "phone: a tap with 글자 opens a box ready for typing");
  await phone.keyboard.type("확인");
  await phone.evaluate(() => document.activeElement.blur());
  await phone.waitForTimeout(100);
  assert(await phone.locator(".item.is-text .mark-text").textContent() === "확인", "phone: typed text stays after finishing");
  await phone.screenshot({ path: `${S}/phone.png` });
  await ctx.close();

  // ---------- iPhone Safari (WebKit): a size-less SVG draws at 0×0 there, so the card thumbnail must be sized ----------
  let wk = null;
  try { wk = await webkit.launch(); } catch { console.log("skip - WebKit not installed (npx playwright install webkit)"); }
  if (wk) {
    const wctx = await wk.newContext({ ...devices["iPhone 13"], defaultBrowserType: undefined });
    const wp = await wctx.newPage();
    await wp.goto(url);
    await wp.evaluate(sigs => localStorage.setItem("gakin.signatures", JSON.stringify(sigs)), [SIG]);
    await wp.reload();
    const t = await wp.evaluate(() => { const r = document.querySelector(".sig-thumb svg").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    assert(t[0] > 40 && t[1] > 20, `iPhone Safari: the signature card shows the signature (${t.join("×")})`);
    await wk.close();
  }

  assert(errors.length === 0, `no page errors ${JSON.stringify(errors)}`);
  console.log("artifacts:", S);
  await b.close();
  server.close();
})();
