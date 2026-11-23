// Undo/redo, rotation and touch use.
// Desktop: placing, moving, nudging, deleting and rotating can all be undone and
// redone (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y and the toolbar buttons), rotation
// snaps to right angles, resizing a rotated stamp follows its own axis, and the
// saved PDF draws the stamp rotated.
// Phone (iPhone viewport, touch): signatures sit in a bottom bar, a tap places a
// stamp, a swipe scrolls without placing one, a pinch zooms, a finger drags.
const { chromium, devices } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const S = fs.mkdtempSync(path.join(os.tmpdir(), "gakin-editing-"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".wasm": "application/wasm" };
function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok -", msg); }
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// A wide signature (3:1), so a 90° turn is easy to see in the output.
const SIG = { id: "wide", kind: "vector", name: "서명", color: "#000000", size: 6, width: 300, height: 100, strokes: [[[10, 50], [80, 20], [150, 80], [220, 20], [290, 50]]], createdAt: 1 };

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
  await gen.setContent("<p style='font:14px sans-serif'>빈 문서</p>");
  await gen.pdf({ path: `${S}/blank.pdf`, format: "A4" });
  await gen.setContent(Array.from({ length: 3 }, (_, i) => `<div style="height:1000px;page-break-after:always">쪽 ${i + 1}</div>`).join(""));
  await gen.pdf({ path: `${S}/three.pdf`, format: "A4" });
  await gen.close();

  const errors = [];
  const watch = p => {
    p.on("pageerror", e => errors.push(e.message));
    p.on("console", m => m.type() === "error" && errors.push(m.text()));
  };
  const seed = async p => {
    await p.goto(url);
    await p.evaluate(sig => localStorage.setItem("gakin.signatures", JSON.stringify([sig])), SIG);
    await p.reload();
  };
  const items = p => p.evaluate(() => [...document.querySelectorAll(".item")].map(el => ({ left: el.style.left, top: el.style.top, width: el.style.width, transform: el.style.transform })));

  // ---------- desktop ----------
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  watch(page);
  await seed(page);
  await page.setInputFiles("#fileInput", `${S}/blank.pdf`);
  await page.waitForSelector(".page canvas");
  assert(await page.locator("#undoItemBtn").isDisabled() && await page.locator("#redoItemBtn").isDisabled(), "undo and redo start disabled");
  const pg = await page.locator(".page").first().boundingBox();
  await page.mouse.click(pg.x + pg.width * 0.5, pg.y + pg.height * 0.3);
  assert((await items(page)).length === 1 && await page.locator("#undoItemBtn").isEnabled(), "placing a stamp enables undo");

  await page.keyboard.press("Control+z");
  assert((await items(page)).length === 0 && await page.locator("#redoItemBtn").isEnabled(), "Ctrl+Z removes the placed stamp");
  await page.keyboard.press("Control+Shift+z");
  assert((await items(page)).length === 1, "Ctrl+Shift+Z puts it back");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  assert((await items(page)).length === 1, "Ctrl+Y redoes too");

  // move with the mouse, then undo
  const placed = (await items(page))[0];
  let box = await page.locator(".item").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  assert((await items(page))[0].left !== placed.left, "drag moves the stamp");
  await page.click("#undoItemBtn");
  assert((await items(page))[0].left === placed.left && (await items(page))[0].top === placed.top, "undo button returns it to where it was");

  // a quick run of arrow nudges is one step
  await page.locator(".item").focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  assert((await items(page))[0].left !== placed.left, "arrow keys nudge");
  await page.keyboard.press("Control+z");
  assert((await items(page))[0].left === placed.left, "one undo reverts a run of nudges");

  // delete, then undo
  await page.locator(".item").focus();
  await page.keyboard.press("Delete");
  assert((await items(page)).length === 0, "Delete removes the stamp");
  await page.keyboard.press("Control+z");
  assert((await items(page)).length === 1, "undo brings a deleted stamp back");

  // rotation by key
  await page.locator(".item").focus();
  await page.keyboard.press("r");
  await page.keyboard.press("r");
  assert((await items(page))[0].transform === "rotate(30deg)", "R turns by 15° each press");
  await page.keyboard.press("Shift+R");
  assert((await items(page))[0].transform === "rotate(15deg)", "Shift+R turns back");
  await page.keyboard.press("Control+z");
  assert((await items(page))[0].transform === "", "one undo reverts the key rotations");

  // rotation by handle: from above the centre to its right is a quarter turn, snapped to 90°
  box = await page.locator(".item").boundingBox();
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const rot = await page.locator(".item .rotate").boundingBox();
  await page.mouse.move(rot.x + rot.width / 2, rot.y + rot.height / 2);
  await page.mouse.down();
  await page.mouse.move(centre.x + 60, centre.y - 6, { steps: 8 });
  await page.mouse.move(centre.x + 80, centre.y + 2, { steps: 4 });
  await page.mouse.up();
  assert((await items(page))[0].transform === "rotate(90deg)", `rotate handle snaps to a right angle (${(await items(page))[0].transform})`);

  // resizing a 90° stamp: its width now runs downwards on screen
  const before = await page.evaluate(() => document.querySelector(".item").style.width);
  let handle = await page.locator(".item .handle").boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.up();
  const sideways = await page.evaluate(() => document.querySelector(".item").style.width);
  assert(near(parseFloat(sideways), parseFloat(before), 0.5), "dragging across a 90° stamp does not stretch it");
  const centreBefore = await page.locator(".item").boundingBox();
  handle = await page.locator(".item .handle").boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 60, { steps: 5 });
  await page.mouse.up();
  const grown = await page.evaluate(() => document.querySelector(".item").style.width);
  const after = await page.locator(".item").boundingBox();
  assert(parseFloat(grown) > parseFloat(before) + 2, "dragging along a 90° stamp resizes it");
  assert(near(after.x + after.width, centreBefore.x + centreBefore.width, 2) && near(after.y, centreBefore.y, 2), "resize keeps the stamp's own top-left corner in place");

  // the saved PDF draws the stamp turned: a wide signature becomes tall
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#saveBtn")]);
  await dl.saveAs(`${S}/rotated.pdf`);
  await page.setInputFiles("#fileInput", `${S}/rotated.pdf`);
  await page.waitForFunction(() => document.getElementById("docName").textContent === "rotated.pdf" && document.querySelector(".page canvas").width > 0);
  await page.waitForTimeout(300);
  const ink = await page.evaluate(() => {
    const c = document.querySelector(".page canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    // ignore the top strip with the document's own text
    for (let y = Math.round(c.height * 0.15); y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4] < 100) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    return { w: x1 - x0, h: y1 - y0 };
  });
  assert(ink.w > 0 && ink.h > ink.w * 1.8, `saved PDF has the stamp rotated (ink ${ink.w}×${ink.h})`);
  assert(await page.locator("#undoItemBtn").isDisabled(), "opening another document clears the history");
  await page.close();

  // ---------- desktop: unsaved-changes flag, deleting a signature, Korean input ----------
  const d2 = await b.newPage({ viewport: { width: 1280, height: 900 } });
  watch(d2);
  await seed(d2);
  await d2.setInputFiles("#fileInput", `${S}/blank.pdf`);
  await d2.waitForSelector(".page canvas");
  let pb = await d2.locator(".page").first().boundingBox();
  await d2.mouse.click(pb.x + pb.width * 0.5, pb.y + pb.height * 0.4);
  const [saved] = await Promise.all([d2.waitForEvent("download"), d2.click("#saveBtn")]);
  await saved.path();
  await d2.keyboard.press("Control+z");
  await d2.keyboard.press("Control+Shift+z");
  await d2.click("#closeDocBtn");
  await d2.waitForTimeout(200);
  assert(!(await d2.evaluate(() => document.getElementById("confirmation-dialog").open)) && await d2.locator("#docChip").isHidden(),
    "undo then redo back to the saved state closes without an unsaved-changes question");

  // Korean input mode: e.key is "ㄱ", the physical key is still R
  await d2.setInputFiles("#fileInput", `${S}/blank.pdf`);
  await d2.waitForSelector(".page canvas");
  pb = await d2.locator(".page").first().boundingBox();
  await d2.mouse.click(pb.x + pb.width * 0.5, pb.y + pb.height * 0.4);
  await d2.locator(".item").focus();
  await d2.evaluate(() => document.querySelector(".item").dispatchEvent(new KeyboardEvent("keydown", { key: "ㄱ", code: "KeyR", bubbles: true })));
  assert((await items(d2))[0].transform === "rotate(15deg)", "R rotates with the Korean input mode on");
  await d2.evaluate(() => document.querySelector(".item").dispatchEvent(new KeyboardEvent("keydown", { key: "ㅋ", code: "KeyZ", ctrlKey: true, bubbles: true })));
  assert((await items(d2))[0].transform === "", "Ctrl+Z works with the Korean input mode on");

  // deleting the signature takes its stamps out of the history, so no empty undo steps remain
  await d2.hover(".sig-list li");
  await d2.click(".sig-delete");
  await d2.click("#confirmation-confirm");
  await d2.waitForFunction(() => !document.querySelector(".sig-card"));
  assert((await items(d2)).length === 0 && await d2.locator("#undoItemBtn").isDisabled(), "deleting the signature leaves no undo steps that do nothing");
  await d2.click("#closeDocBtn");
  await d2.waitForTimeout(200);
  assert(!(await d2.evaluate(() => document.getElementById("confirmation-dialog").open)), "a document emptied that way closes without asking");

  // nothing changes the stamps while a PDF is being written
  await seed(d2);
  await d2.setInputFiles("#fileInput", `${S}/three.pdf`);
  await d2.waitForSelector(".page canvas");
  pb = await d2.locator(".page").first().boundingBox();
  await d2.mouse.click(pb.x + pb.width * 0.5, pb.y + pb.height * 0.4);
  await d2.selectOption("#dpi", "300");
  const download = d2.waitForEvent("download");
  await d2.click("#saveBtn");
  const during = await d2.evaluate(() => {
    const before = document.querySelectorAll(".item").length;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true }));
    const note = document.getElementById("busyNote");
    return { note: note.hidden ? "" : note.textContent, busy: !document.getElementById("busy").hidden, inert: document.querySelector(".layout").inert && document.querySelector(".topbar").inert, before, after: document.querySelectorAll(".item").length };
  });
  await download;
  assert(during.busy && during.inert && during.after === during.before, "while saving, the page is inert and Ctrl+Z does nothing");
  assert(!(await d2.evaluate(() => document.querySelector(".layout").inert)), "the page is usable again after saving");
  assert(during.note === "프로그램으로 만든 서명은 법적 효력이 보장되는 전자서명(공인·인증 전자서명)이 아니에요.", "while saving, the card shows the legal-effect notice");
  assert(await d2.locator("#busyNote").isHidden(), "the notice goes away with the card");
  await d2.close();

  // ---------- phone ----------
  const ctx = await b.newContext({ ...devices["iPhone 13"], defaultBrowserType: undefined });
  const phone = await ctx.newPage();
  watch(phone);
  await seed(phone);
  await phone.setInputFiles("#fileInput", `${S}/three.pdf`);
  await phone.waitForSelector(".page canvas");
  const layout = await phone.evaluate(() => {
    const r = q => document.querySelector(q).getBoundingClientRect();
    return { top: r(".topbar").top, viewerBottom: r(".viewer").bottom, sidebarTop: r(".sidebar").top, sidebarBottom: r(".sidebar").bottom, scrollW: document.documentElement.scrollWidth, w: innerWidth, h: innerHeight };
  });
  assert(layout.top === 0 && near(layout.viewerBottom, layout.sidebarTop) && near(layout.sidebarBottom, layout.h), "phone: top bar, document, then the signature bar at the bottom");
  assert(layout.scrollW <= layout.w, "phone: nothing scrolls sideways");
  assert((await phone.textContent("#toast")).includes("누르세요"), "phone: the hint says tap, not click or Shift");

  const cdp = await ctx.newCDPSession(phone);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const ppage = await phone.locator(".page").first().boundingBox();

  // a swipe scrolls and does not place a stamp
  const sx = ppage.x + ppage.width / 2, sy = ppage.y + ppage.height * 0.7;
  await touch("touchStart", [[sx, sy]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[sx, sy - i * 25]]);
  await touch("touchEnd", []);
  await phone.waitForTimeout(400);
  assert((await items(phone)).length === 0, "phone: a swipe does not place a stamp");
  assert(await phone.$eval(".viewer", v => v.scrollTop) > 0, "phone: a swipe scrolls the document");
  await phone.$eval(".viewer", v => { v.scrollTop = 0; });
  await phone.waitForTimeout(200);

  // a tap places one
  const tapAt = { x: ppage.x + ppage.width * 0.5, y: ppage.y + ppage.height * 0.4 };
  await phone.touchscreen.tap(tapAt.x, tapAt.y);
  await phone.waitForTimeout(200);
  assert((await items(phone)).length === 1, "phone: a tap places a stamp");
  const big = await phone.locator(".item .handle").boundingBox();
  assert(big.width >= 24, `phone: the resize handle is finger-sized (${big.width}px)`);

  // a finger drags it
  const ib = await phone.locator(".item").boundingBox();
  const from = [ib.x + ib.width / 2, ib.y + ib.height / 2];
  const leftBefore = (await items(phone))[0].left;
  await touch("touchStart", [from]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[from[0] + i * 6, from[1] + i * 4]]);
  await touch("touchEnd", []);
  assert((await items(phone))[0].left !== leftBefore, "phone: dragging a stamp with a finger moves it");
  assert(await phone.locator("#undoItemBtn").isEnabled(), "phone: undo is available on screen");

  // two fingers apart zoom in
  const zoomBefore = await phone.textContent("#zoomLabel");
  const mx = ppage.x + ppage.width / 2, my = ppage.y + ppage.height * 0.8;
  await touch("touchStart", [[mx - 30, my], [mx + 30, my]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[mx - 30 - i * 8, my], [mx + 30 + i * 8, my]]);
  await touch("touchEnd", []);
  await phone.waitForTimeout(300);
  const zoomAfter = await phone.textContent("#zoomLabel");
  assert(parseInt(zoomAfter) > parseInt(zoomBefore), `phone: pinching out zooms in (${zoomBefore} → ${zoomAfter})`);
  assert((await items(phone)).length === 1, "phone: pinching does not place a stamp");
  assert(await phone.evaluate(() => visualViewport.scale) === 1, "phone: the page itself does not zoom");


  // a finger resting on a stamp while pinching does not drag it
  const pinItem = await phone.locator(".item").boundingBox();
  const pinBefore = await items(phone);
  const ox = pinItem.x + pinItem.width / 2, oy = pinItem.y + pinItem.height / 2;
  await touch("touchStart", [[ox, oy]]);
  await touch("touchStart", [[ox, oy], [ox + 60, oy + 80]]);
  for (let i = 1; i <= 6; i++) await touch("touchMove", [[ox - i * 4, oy - i * 3], [ox + 60 + i * 10, oy + 80 + i * 10]]);
  await touch("touchEnd", []);
  await phone.waitForTimeout(300);
  const pinAfter = await items(phone);
  assert(pinAfter[0].left === pinBefore[0].left && pinAfter[0].top === pinBefore[0].top, "phone: a finger on a stamp during a pinch does not move it");

  // settings fold away behind a button
  assert(await phone.locator("#dpi").isHidden(), "phone: settings are folded away");
  await phone.click("#settingsToggle");
  assert(await phone.locator("#dpi").isVisible(), "phone: the settings button shows them");
  await phone.screenshot({ path: `${S}/phone.png` });
  await ctx.close();

  // ---------- small phone (320px) ----------
  const small = await b.newContext({ ...devices["iPhone SE"], defaultBrowserType: undefined });
  const sp = await small.newPage();
  watch(sp);
  await seed(sp);
  const saveRight = () => sp.evaluate(() => Math.round(innerWidth - document.querySelector("#saveGroup").getBoundingClientRect().right));
  const gapBefore = await saveRight();
  fs.copyFileSync(`${S}/blank.pdf`, `${S}/아주-긴-파일-이름의-결재-문서-최종본-수정.pdf`);
  await sp.setInputFiles("#fileInput", `${S}/아주-긴-파일-이름의-결재-문서-최종본-수정.pdf`);
  await sp.waitForSelector(".page canvas");
  const sizes = await sp.evaluate(() => {
    const r = q => document.querySelector(q).getBoundingClientRect();
    return { open: r("#openBtn").width, save: r("#saveGroup").right, list: r("#sigList").width, card: r(".sig-list li").width, w: innerWidth };
  });
  assert(sizes.open >= 40 && sizes.save <= sizes.w, `320px: the open button keeps its size with a long file name (${sizes.open}px)`);
  const gapAfter = await saveRight();
  assert(gapBefore === gapAfter && gapBefore <= 16, `320px: the save buttons stay at the right edge before and after a file opens (${gapBefore}px → ${gapAfter}px)`);
  assert(sizes.list >= sizes.card, `320px: a whole signature card fits in the bar (${sizes.list} ≥ ${sizes.card})`);
  const top = await sp.locator(".page").first().boundingBox();
  await sp.touchscreen.tap(top.x + top.width / 2, top.y + 12);
  await sp.waitForTimeout(200);
  const hit = await sp.evaluate(() => {
    const r = document.querySelector(".item .rotate").getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { below: document.querySelector(".item").classList.contains("rotate-below"), onHandle: Boolean(el?.closest(".rotate")) };
  });
  assert(hit.below && hit.onHandle, "a stamp at the very top of a page gets its rotate handle below, where it can be pressed");
  await small.close();

  assert(errors.length === 0, `no page errors ${JSON.stringify(errors)}`);
  console.log("artifacts:", S);
  await b.close();
  server.close();
})();
