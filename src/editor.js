import { openDocument, DocumentError } from "./documentSources.js";
import { exportFlatPdf, exportFlatImages } from "./exporter.js";
import { buildZip } from "./zip.js";
import { SignaturePad, imageToStamp } from "./signaturePad.js";
import { buildVectorSignature, signaturePaths, PEN_SIZES, PEN_COLORS } from "./strokes.js";
import { loadSignatures, saveSignatures, MAX_SIGNATURES } from "./signatureStore.js";
import { createConfirmationDialog } from "./confirmationDialog.js";
import { createPasswordDialog } from "./passwordDialog.js";
import { backupBlob, parseBackup } from "./signatureBackup.js";
import { FONT_CHOICES, loadHandwritingFont, missingCharacters, renderNameSignature } from "./nameSignature.js";
import { applyIcons, iconSvg } from "../vendor/lucide/icons.js";
import { measureText, shapeSvg, todayText, MARK_COLOR, SHAPE_SIZES, TEXT_SIZE } from "./marks.js";

// Refuse to run inside another site's frame, so its page cannot overlay ours
// and trick clicks (a meta CSP cannot set frame-ancestors).
if (window.top !== window.self) {
  document.body.textContent = "이 페이지는 다른 사이트 안에서 열 수 없습니다.";
  throw new Error("framed");
}

// The same page runs as the extension editor and as the GitHub Pages site.
const isExtension = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
document.documentElement.dataset.platform = isExtension ? "extension" : "web";
applyIcons();
const askConfirm = createConfirmationDialog();
const askPassword = createPasswordDialog();
if (matchMedia("(pointer: coarse)").matches) document.getElementById("padPlaceholder").textContent = "여기에 손가락으로 서명하세요";

const $ = id => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_ITEM_WIDTH = 16; // pt
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];
const HISTORY_LIMIT = 100;
// Phones and tablets: tap instead of click, no Shift, no hover preview.
const coarsePointer = matchMedia("(pointer: coarse)");
const tapWord = () => (coarsePointer.matches ? "누르세요" : "클릭하세요");

const state = {
  doc: null,
  pages: [], // { el, canvas, layer, size, rendered, token }
  items: [], // { id, sigId, page, x, y, w, h, rotation? } in PDF points from the page's top-left; rotation in degrees about the centre
  selectedId: null,
  armedId: null,
  armedTool: null, // "text" | "date" | "name" | "check" | "circle" | "cross" while placing one
  signatures: [],
  zoomIndex: ZOOM_STEPS.indexOf(1),
  fitScale: 1,
  dirty: false, // stamps differ from the last saved (or freshly opened) state
  savedItems: "[]", // JSON of the stamps at the last save
  dragging: false,
};

const sigById = id => state.signatures.find(s => s.id === id);
const itemsKey = items => JSON.stringify(items);
function refreshDirty() {
  state.dirty = itemsKey(state.items) !== state.savedItems;
}
const scale = () => state.fitScale * ZOOM_STEPS[state.zoomIndex];

// ---------- toast & busy ----------

let toastTimer;
function toast(message, ms = 3200) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// While a document opens or a PDF is written, the rest of the page is inert:
// no clicks, focus or shortcuts can change the stamps or close the document.
function busy(text, ratio) {
  $("busy").hidden = text == null;
  for (const el of document.querySelectorAll(".topbar, .layout")) el.inert = text != null;
  if (text != null) {
    $("busyText").textContent = text;
    $("busyBar").style.width = `${Math.round((ratio ?? 0) * 100)}%`;
  }
}

// ---------- signature visuals ----------

function signatureVisual(sig) {
  if (sig.kind === "image") {
    const img = document.createElement("img");
    img.src = sig.dataUrl;
    img.alt = "";
    img.draggable = false;
    return img;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${sig.width} ${sig.height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  for (const d of signaturePaths(sig)) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", sig.color);
    svg.append(path);
  }
  return svg;
}

function defaultSize(sig, page) {
  // Stamps are roughly square; a name written in a font is wide like a signature.
  const stamp = sig.kind === "image" && sig.width < sig.height * 1.6;
  const fallback = stamp ? 56 : 120;
  let w = Math.min(sig.lastWidth || fallback, page.size.width * 0.6);
  let h = (w * sig.height) / sig.width;
  if (h > page.size.height * 0.4) {
    h = page.size.height * 0.4;
    w = (h * sig.width) / sig.height;
  }
  return { w, h };
}

// ---------- sidebar ----------

function renderSidebar() {
  const list = $("sigList");
  list.replaceChildren();
  for (const sig of state.signatures) {
    const li = document.createElement("li");
    const card = document.createElement("button");
    card.type = "button";
    card.className = "sig-card";
    card.setAttribute("aria-pressed", String(sig.id === state.armedId));
    const thumb = document.createElement("span");
    thumb.className = "sig-thumb";
    const visual = signatureVisual(sig);
    // The thumbnail SVG fills the box (Safari draws a size-less SVG at 0×0), so keep its proportions here.
    if (visual instanceof SVGElement) visual.setAttribute("preserveAspectRatio", "xMidYMid meet");
    thumb.append(visual);
    const name = document.createElement("span");
    name.className = "sig-name";
    name.textContent = sig.name;
    card.append(thumb, name);
    card.addEventListener("click", () => arm(sig.id === state.armedId ? null : sig.id));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "sig-delete";
    del.innerHTML = iconSvg("trash-2");
    del.setAttribute("aria-label", `${sig.name} 삭제`);
    del.addEventListener("click", () => deleteSignature(sig));
    li.append(card, del);
    list.append(li);
  }
  const full = state.signatures.length >= MAX_SIGNATURES;
  $("newSigBtn").disabled = full;
  $("importStampBtn").disabled = full;
  $("nameSigBtn").disabled = full;
  $("moreSigBtn").disabled = full;
  if (full) closeSigMenu();
  // Only the signature limit needs explaining; the rest is self-evident.
  $("sigHint").textContent = full ? `서명은 ${MAX_SIGNATURES}개까지 저장돼요` : "";
  $("sigHint").hidden = !full;
  updateMarkUi();
}

function arm(id) {
  if (id && !state.doc) {
    toast("먼저 서명할 문서를 열어 주세요.");
    id = null;
  }
  state.armedId = id;
  state.armedTool = null;
  hideGhost();
  for (const page of state.pages) page.el.classList.toggle("armed", Boolean(id));
  renderSidebar();
}

// ---------- text & marks (글자·표시 넣기) ----------

const MARK_NAMES = { check: "체크", circle: "동그라미", cross: "엑스" };
const TEXT_PLACEHOLDER = "글자 입력";

// The name typed in 이름으로 만들기, or else the newest signature made from a name.
function myName() {
  try {
    const saved = localStorage.getItem("gakin.myName");
    if (saved) return saved;
  } catch {}
  const fromName = [...state.signatures].reverse().find(sig => sig.kind === "image" && sig.name !== "도장");
  return fromName?.name ?? "";
}

function armTool(tool) {
  if (!state.doc) {
    toast("먼저 서명할 문서를 열어 주세요.");
    return;
  }
  const next = state.armedTool === tool ? null : tool;
  arm(null);
  state.armedTool = next;
  for (const page of state.pages) page.el.classList.toggle("armed", Boolean(next));
  updateMarkUi();
  if (next) toast(`${next === "text" || next === "date" || next === "name" ? "글자" : "표시"}를 넣을 곳을 ${tapWord()}.`);
}

function updateMarkUi() {
  for (const btn of document.querySelectorAll(".mark-btn")) {
    btn.setAttribute("aria-pressed", String(state.armedTool === btn.dataset.tool));
  }
  const name = myName();
  const nameBtn = document.querySelector('.mark-btn[data-tool="name"]');
  nameBtn.disabled = !name;
  nameBtn.title = name ? `"${name}" 넣기` : "이름으로 만들기에서 이름을 먼저 정해 주세요";
}

for (const btn of document.querySelectorAll(".mark-btn")) {
  btn.addEventListener("click", () => armTool(btn.dataset.tool));
}

const textBox = (text, size) => measureText(text || TEXT_PLACEHOLDER, size);

function placeMark(page, e, keepArmed) {
  const tool = state.armedTool;
  e.preventDefault(); // keep the browser from moving focus away from a new text box
  const p = pagePoint(page, e);
  const color = MARK_COLOR;
  let item;
  if (tool in SHAPE_SIZES) {
    const { w, h } = SHAPE_SIZES[tool];
    item = { id: crypto.randomUUID(), kind: "shape", shape: tool, page: page.index, x: p.x - w / 2, y: p.y - h / 2, w, h, color };
  } else {
    const text = tool === "date" ? todayText() : tool === "name" ? myName() : "";
    const size = TEXT_SIZE;
    const { w, h } = textBox(text, size);
    // Text starts where it was clicked, like a cursor.
    item = { id: crypto.randomUUID(), kind: "text", page: page.index, x: p.x, y: p.y - h / 2, w, h, text, size, color };
  }
  clampItem(item);
  const before = snapshotItems();
  state.items.push(item);
  renderItem(item);
  select(item.id);
  if (!keepArmed) arm(null);
  updateMarkUi();
  if (item.kind === "text" && !item.text) {
    startTextEdit(item, before); // recorded once something is typed
  } else {
    recordHistory(before);
    refreshDirty();
  }
}

// Edits a text item in place. Enter adds a line; Esc, Ctrl+Enter or clicking
// elsewhere finishes. A text left empty is removed.
function startTextEdit(item, before = snapshotItems()) {
  const el = itemElement(item.id);
  const content = el?.querySelector(".mark-text");
  if (!content || el.classList.contains("editing")) return;
  const original = item.text;
  el.classList.add("editing");
  content.contentEditable = "plaintext-only";
  if (content.contentEditable !== "plaintext-only") content.contentEditable = "true";
  content.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(content);
  range.collapse(false);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  const page = state.pages[item.page];
  const onInput = () => {
    item.text = content.innerText.replace(/\n$/, "");
    Object.assign(item, textBox(item.text, item.size));
    placeItemElement(el, page, item);
  };
  const onKey = e => {
    if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      content.blur();
    }
  };
  const finish = () => {
    content.removeEventListener("input", onInput);
    content.removeEventListener("keydown", onKey);
    content.contentEditable = "false";
    el.classList.remove("editing");
    item.text = item.text.replace(/\s+$/, "");
    if (!item.text) {
      state.items = state.items.filter(i => i !== item);
      el.remove();
      if (state.selectedId === item.id) state.selectedId = null;
      if (original) recordHistory(before);
    } else {
      Object.assign(item, textBox(item.text, item.size));
      placeItemElement(el, page, item);
      content.textContent = item.text;
      if (item.text !== original) recordHistory(before);
    }
    refreshDirty();
  };
  content.addEventListener("input", onInput);
  content.addEventListener("keydown", onKey);
  content.addEventListener("blur", finish, { once: true });
}

// Saves the list first and only then makes it current, so a failed save (e.g.
// storage quota) leaves the screen matching what is actually stored.
async function commitSignatures(next) {
  try {
    await saveSignatures(next);
  } catch (error) {
    console.warn("saving signatures failed", error);
    toast("서명을 저장하지 못했습니다. 브라우저 저장 공간이 부족할 수 있습니다.", 6000);
    return false;
  }
  state.signatures = next;
  return true;
}

async function deleteSignature(sig) {
  const used = state.items.filter(item => item.sigId === sig.id).length;
  const ok = await askConfirm({
    title: `'${sig.name}'을(를) 삭제할까요?`,
    description: "저장된 서명이 이 브라우저에서 지워집니다. 되돌릴 수 없습니다.",
    note: used ? `이 문서에 찍힌 ${used}개도 함께 지워집니다.` : "",
    confirmLabel: "삭제",
    tone: "danger",
  });
  if (!ok) return;
  if (!(await commitSignatures(state.signatures.filter(s => s.id !== sig.id)))) return;
  if (used) {
    state.items = state.items.filter(item => item.sigId !== sig.id);
    if (!state.items.some(item => item.id === state.selectedId)) state.selectedId = null;
    renderAllItems();
  }
  // Undo cannot bring the signature back, so its stamps leave the history and
  // the saved state too; steps that only differed by them are merged away.
  const keep = list => list.filter(item => item.sigId !== sig.id);
  const current = itemsKey(state.items);
  const squash = (list, edge) => {
    const out = [];
    let last = edge;
    for (const snapshot of list.map(keep)) {
      const key = itemsKey(snapshot);
      if (key !== last) out.push(snapshot);
      last = key;
    }
    return out;
  };
  itemHistory.past = squash(itemHistory.past.reverse(), current).reverse();
  itemHistory.future = squash(itemHistory.future.reverse(), current).reverse();
  itemHistory.lastNudge = null;
  state.savedItems = itemsKey(keep(JSON.parse(state.savedItems)));
  refreshDirty();
  updateHistoryUi();
  if (state.armedId === sig.id) arm(null);
  renderSidebar();
}

// ---------- signature pad dialog ----------

const dialog = $("padDialog");
const pad = new SignaturePad($("padCanvas"), { onChange: updatePadState });
let penSize = "normal";
let penColor = "black";

function updatePadState() {
  $("padSave").disabled = pad.isEmpty;
  $("padPlaceholder").hidden = !pad.isEmpty;
  $("undoBtn").disabled = pad.isEmpty;
  $("clearBtn").disabled = pad.isEmpty;
}

function nextSignatureName() {
  const used = new Set(state.signatures.map(s => s.name));
  let n = 1;
  while (used.has(`서명 ${n}`)) n++;
  return `서명 ${n}`;
}

function openPad() {
  pad.clear();
  pad.setPen({ size: PEN_SIZES[penSize], color: PEN_COLORS[penColor] });
  $("sigName").value = nextSignatureName();
  dialog.showModal();
  updatePadState();
}

dialog.querySelectorAll("[data-color]").forEach(btn => btn.addEventListener("click", () => {
  penColor = btn.dataset.color;
  dialog.querySelectorAll("[data-color]").forEach(b => b.setAttribute("aria-pressed", String(b === btn)));
  pad.setPen({ color: PEN_COLORS[penColor] });
}));
dialog.querySelectorAll("[data-size]").forEach(btn => btn.addEventListener("click", () => {
  penSize = btn.dataset.size;
  dialog.querySelectorAll("[data-size]").forEach(b => b.setAttribute("aria-pressed", String(b === btn)));
  pad.setPen({ size: PEN_SIZES[penSize] });
}));
$("undoBtn").addEventListener("click", () => pad.undo());
$("clearBtn").addEventListener("click", () => pad.clear());
$("padCancel").addEventListener("click", () => dialog.close());
$("padForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (pad.isEmpty) return;
  const sig = buildVectorSignature(pad.strokes, {
    size: PEN_SIZES[penSize],
    color: PEN_COLORS[penColor],
    name: $("sigName").value.trim() || nextSignatureName(),
  });
  if (!sig) return;
  // Keep the drawing on screen if it could not be stored, so it is not lost.
  if (await addSignature(sig)) dialog.close();
});

async function addSignature(sig) {
  if (!(await commitSignatures([...state.signatures, sig]))) return false;
  if (state.doc) {
    arm(sig.id);
    toast(`저장했습니다. 문서에서 서명할 곳을 ${tapWord()}.`);
  } else {
    renderSidebar();
    toast("저장했습니다. 이제 문서를 열어 찍기만 하면 됩니다.");
  }
  return true;
}

$("newSigBtn").addEventListener("click", openPad);

// A ⋯ button that opens a small menu, closed by Escape, Tab or a click elsewhere.
// With a mouse, resting on ⋯ opens it too, and leaving the button and menu closes it.
const HOVER_CLOSE_MS = 300;
function popupMenu(button, menu, container) {
  let byHover = false;
  let leaveTimer = 0;
  const focusFirst = () => menu.querySelector(".menu-item:not(:disabled)")?.focus();
  const open = ({ focus = true } = {}) => {
    clearTimeout(leaveTimer);
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    if (focus) focusFirst();
  };
  const close = ({ focusButton = false } = {}) => {
    clearTimeout(leaveTimer);
    byHover = false;
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focusButton) button.focus();
  };
  button.addEventListener("click", () => {
    if (menu.hidden) open();
    else if (byHover) { byHover = false; clearTimeout(leaveTimer); focusFirst(); } // hover opened it: the click keeps it open
    else close();
  });
  button.addEventListener("pointerenter", e => {
    if (e.pointerType !== "mouse" || button.disabled) return;
    clearTimeout(leaveTimer);
    if (menu.hidden) { byHover = true; open({ focus: false }); }
  });
  menu.addEventListener("pointerenter", () => clearTimeout(leaveTimer));
  for (const el of [button, menu]) {
    el.addEventListener("pointerleave", e => {
      if (e.pointerType !== "mouse" || !byHover) return;
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => {
        if (!button.matches(":hover") && !menu.matches(":hover")) close();
      }, HOVER_CLOSE_MS);
    });
  }
  menu.addEventListener("keydown", e => {
    const items = [...menu.querySelectorAll(".menu-item:not(:disabled)")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close({ focusButton: true });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") {
      close();
    }
  });
  document.addEventListener("pointerdown", e => {
    if (!container.contains(e.target)) close();
  });
  return close;
}

// ⋯ next to 서명 그리기: the other ways to make a signature.
const closeSigMenu = popupMenu($("moreSigBtn"), $("sigMenu"), document.querySelector(".sig-make"));

// ---------- name signature dialog ----------

const nameDialog = $("nameDialog");
let nameColor = "black";
let nameFontId = FONT_CHOICES[0].id;

function buildFontChoices() {
  const wrap = $("fontChoices");
  wrap.replaceChildren();
  for (const font of FONT_CHOICES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "font-choice";
    btn.dataset.font = font.id;
    btn.setAttribute("role", "radio");
    const preview = document.createElement("canvas");
    preview.className = "font-preview";
    preview.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "font-label";
    const title = document.createElement("span");
    title.textContent = font.system ? `${font.label}(설치됨)` : font.label;
    const note = document.createElement("span");
    note.className = "font-note";
    label.append(title, note);
    btn.append(preview, label);
    btn.addEventListener("click", () => {
      nameFontId = font.id;
      updateNameDialog();
    });
    // System fonts start hidden and appear only once found on this PC.
    btn.hidden = Boolean(font.system);
    wrap.append(btn);
    loadHandwritingFont(font)
      .then(family => {
        btn.dataset.family = family;
        btn.hidden = false;
        drawFontPreview(btn);
      })
      .catch(() => {
        btn.dataset.failed = "true";
        updateNameDialog();
      });
  }
}

// Fonts sit differently on their line (ascent, descent, side bearings), so
// CSS centering leaves them high or low. Draw each preview on a canvas,
// measure the actual ink, scale every font to the same ink height and centre it.
const PREVIEW_INK = 0.56; // ink height as a share of the preview box

function drawFontPreview(btn) {
  const canvas = btn.querySelector(".font-preview");
  const family = btn.dataset.family;
  const { width, height } = canvas.getBoundingClientRect();
  if (!family || !width || !height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const text = canvas.dataset.text;
  if (!text) return;
  const base = 100;
  ctx.font = `${base}px "${family}"`;
  const m = ctx.measureText(text);
  const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  if (inkW <= 0 || inkH <= 0) return;
  const scale = Math.min((height * PREVIEW_INK) / inkH, (width - 24) / inkW);
  ctx.font = `${base * scale}px "${family}"`;
  ctx.fillStyle = canvas.dataset.color;
  // Place the ink box (not the line box) in the middle.
  const x = (width - inkW * scale) / 2 + m.actualBoundingBoxLeft * scale;
  const y = (height - inkH * scale) / 2 + m.actualBoundingBoxAscent * scale;
  ctx.fillText(text, x, y);
}

function updateNameDialog() {
  const text = $("nameText").value.trim();
  let selectable = null;
  for (const btn of $("fontChoices").children) {
    const font = FONT_CHOICES.find(f => f.id === btn.dataset.font);
    const missing = text ? missingCharacters(font, text) : [];
    const failed = btn.dataset.failed === "true";
    const preview = btn.querySelector(".font-preview");
    preview.dataset.text = text || "홍길동";
    preview.dataset.color = text ? PEN_COLORS[nameColor] : "#b4bcc6";
    drawFontPreview(btn);
    btn.querySelector(".font-note").textContent = failed
      ? "불러오지 못함"
      : missing.length ? `'${missing.slice(0, 3).join("")}' 글자 없음` : "";
    btn.disabled = failed || missing.length > 0;
    if (!btn.disabled && (!selectable || font.id === nameFontId)) selectable = font.id;
  }
  // Keep the chosen font unless the name no longer fits it.
  if (selectable) nameFontId = selectable;
  for (const btn of $("fontChoices").children) {
    btn.setAttribute("aria-checked", String(btn.dataset.font === nameFontId && !btn.disabled));
  }
  $("nameSave").disabled = !text || !selectable;
}

function openNameDialog() {
  if (!$("fontChoices").children.length) buildFontChoices();
  $("nameText").value = "";
  nameDialog.showModal();
  updateNameDialog(); // after showModal, so the previews have a size to draw in
  $("nameText").focus();
}

nameDialog.querySelectorAll("[data-name-color]").forEach(btn => btn.addEventListener("click", () => {
  nameColor = btn.dataset.nameColor;
  nameDialog.querySelectorAll("[data-name-color]").forEach(b => b.setAttribute("aria-pressed", String(b === btn)));
  updateNameDialog();
}));
$("nameText").addEventListener("input", updateNameDialog);
$("nameCancel").addEventListener("click", () => nameDialog.close());
$("nameForm").addEventListener("submit", async e => {
  e.preventDefault();
  const text = $("nameText").value.trim();
  const font = FONT_CHOICES.find(f => f.id === nameFontId);
  if (!text || !font || missingCharacters(font, text).length) return;
  $("nameSave").disabled = true;
  let image = null;
  try {
    image = await renderNameSignature(text, font, PEN_COLORS[nameColor]);
  } catch (error) {
    console.error(error);
  }
  if (!image) {
    $("nameSave").disabled = false;
    toast("서명을 만들지 못했습니다. 다른 글씨체로 다시 시도해 주세요.");
    return;
  }
  if (await addSignature({ id: crypto.randomUUID(), kind: "image", name: text.slice(0, 20), createdAt: Date.now(), ...image })) {
    try {
      localStorage.setItem("gakin.myName", text.slice(0, 20));
    } catch {}
    nameDialog.close();
    updateMarkUi();
  }
  else $("nameSave").disabled = false;
});
$("nameSigBtn").addEventListener("click", () => {
  closeSigMenu();
  openNameDialog();
});

// ---------- backup ----------

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

$("exportSigBtn").addEventListener("click", () => {
  if (state.signatures.length === 0) {
    toast("백업할 서명이 없습니다.");
    return;
  }
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  downloadBlob(backupBlob(state.signatures), `서명백업-${stamp}.json`);
});
$("importSigBtn").addEventListener("click", () => $("backupInput").click());

const MAX_BACKUP_BYTES = 30 * 1024 * 1024;

// A stamp image that does not decode would only fail later, when saving.
async function dropUndecodable(list) {
  const ok = await Promise.all(list.map(async sig => {
    if (sig.kind !== "image") return true;
    const img = new Image();
    img.src = sig.dataUrl;
    try {
      await img.decode();
      return img.naturalWidth > 0;
    } catch {
      return false;
    }
  }));
  return list.filter((_, i) => ok[i]);
}
$("backupInput").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > MAX_BACKUP_BYTES) {
    toast("백업 파일이 너무 큽니다.");
    return;
  }
  let incoming;
  try {
    incoming = await dropUndecodable(parseBackup(await file.text()));
  } catch (error) {
    toast(error.message);
    return;
  }
  const known = new Set(state.signatures.map(s => s.id));
  const fresh = incoming.filter(s => !known.has(s.id));
  const room = MAX_SIGNATURES - state.signatures.length;
  const added = fresh.slice(0, Math.max(0, room));
  if (added.length === 0) {
    toast(fresh.length ? `서명은 ${MAX_SIGNATURES}개까지 저장할 수 있습니다.` : "새로 불러올 서명이 없습니다.");
    return;
  }
  if (!(await commitSignatures([...state.signatures, ...added]))) return;
  renderSidebar();
  const skipped = fresh.length - added.length;
  toast(`서명 ${added.length}개를 불러왔습니다.${skipped ? ` 개수 제한으로 ${skipped}개는 건너뛰었습니다.` : ""}`);
});
$("importStampBtn").addEventListener("click", () => {
  closeSigMenu();
  $("stampInput").click();
});
$("stampInput").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const stamp = await imageToStamp(file);
    if (!stamp) {
      toast("이미지에서 도장을 찾지 못했습니다. 흰 배경에 찍힌 도장 사진을 사용해 주세요.");
      return;
    }
    await addSignature({ id: crypto.randomUUID(), kind: "image", name: "도장", createdAt: Date.now(), ...stamp });
  } catch {
    toast("이미지를 불러오지 못했습니다.");
  }
});

// ---------- document ----------

async function loadFile(file) {
  if (state.dirty && !(await askConfirm({
    title: "다른 문서를 열까요?",
    description: "아직 문서를 저장하지 않았어요. 다른 문서를 열까요?",
    confirmLabel: "다른 문서 열기",
    tone: "danger",
  }))) return;
  busy("문서를 여는 중…", 0);
  let doc;
  try {
    doc = await openDocument(file, {
      // Hide the progress overlay while the password dialog is up.
      askPassword: async request => {
        busy(null);
        const pw = await askPassword(request);
        if (pw !== null) busy("문서를 여는 중…", 0);
        return pw;
      },
    });
  } catch (error) {
    busy(null);
    toast(error instanceof DocumentError ? error.message : "문서를 열 수 없습니다.", 6000);
    if (!(error instanceof DocumentError)) console.error(error);
    return;
  }
  busy(null);
  state.doc?.destroy();
  state.doc = doc;
  state.items = [];
  resetHistory();
  state.selectedId = null;
  state.savedItems = "[]";
  state.dirty = false;
  state.zoomIndex = ZOOM_STEPS.indexOf(1);
  $("docName").textContent = doc.name;
  $("docName").title = doc.name;
  $("docChip").hidden = false;
  $("empty").hidden = true;
  $("saveBtn").disabled = $("moreSaveBtn").disabled = false;
  buildPages();
  updateZoomUi();
  $("viewer").scrollTop = 0;
  $("toast").hidden = true;
  if (!state.armedId && state.signatures.length === 1) state.armedId = state.signatures[0].id;
  if (state.armedId) {
    arm(state.armedId);
    toast(coarsePointer.matches ? "서명할 곳을 누르세요." : "서명할 곳을 클릭하세요. Shift를 누른 채 클릭하면 여러 번 찍을 수 있습니다.");
  } else if (state.signatures.length === 0) {
    toast(coarsePointer.matches ? "아래에서 서명을 먼저 그려 주세요." : "왼쪽에서 서명을 먼저 그려 주세요.");
  }
}

async function closeDocument() {
  if (!state.doc) return;
  if (state.dirty && !(await askConfirm({
    title: "문서를 닫을까요?",
    description: "아직 문서를 저장하지 않았어요. 정말 닫을까요?",
    confirmLabel: "닫기",
    tone: "danger",
  }))) return;
  observer.disconnect();
  hideGhost();
  state.doc.destroy();
  state.doc = null;
  state.pages = [];
  state.items = [];
  resetHistory();
  state.selectedId = null;
  state.savedItems = "[]";
  state.dirty = false;
  state.zoomIndex = ZOOM_STEPS.indexOf(1);
  $("pages").replaceChildren();
  $("docName").textContent = "";
  $("docName").title = "";
  $("docChip").hidden = true;
  $("empty").hidden = false;
  closeSaveMenu();
  $("saveBtn").disabled = $("moreSaveBtn").disabled = true;
  $("toast").hidden = true;
  updateZoomUi();
}

$("closeDocBtn").addEventListener("click", closeDocument);

const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const page = state.pages.find(p => p.el === entry.target);
    if (page) {
      page.visible = entry.isIntersecting;
      if (page.visible && !page.rendered) renderPage(page);
      else if (!page.visible && page.rendered) releasePage(page);
    }
  }
}, { root: $("viewer"), rootMargin: "600px 0px" });

function computeFitScale() {
  const viewerWidth = $("viewer").clientWidth - 48;
  let maxWidth = 0;
  for (let i = 0; i < state.doc.pageCount; i++) maxWidth = Math.max(maxWidth, state.doc.pageSize(i).width);
  state.fitScale = Math.min(1.5, Math.max(0.3, viewerWidth / maxWidth));
}

function buildPages() {
  observer.disconnect();
  const container = $("pages");
  container.replaceChildren();
  state.pages = [];
  computeFitScale();
  for (let i = 0; i < state.doc.pageCount; i++) {
    const el = document.createElement("div");
    el.className = "page";
    el.classList.toggle("armed", Boolean(state.armedId));
    const canvas = document.createElement("canvas");
    const layer = document.createElement("div");
    layer.className = "page-layer";
    const num = document.createElement("span");
    num.className = "page-num";
    num.textContent = `${i + 1} / ${state.doc.pageCount}`;
    el.append(canvas, layer, num);
    container.append(el);
    const page = { index: i, el, canvas, layer, size: state.doc.pageSize(i), rendered: false, visible: false, token: 0 };
    attachLayerEvents(page);
    state.pages.push(page);
    observer.observe(el);
  }
  layoutPages();
}

function layoutPages() {
  const s = scale();
  $("pages").style.setProperty("--pt", `${s}px`); // one PDF point on screen
  for (const page of state.pages) {
    page.el.style.width = `${page.size.width * s}px`;
    page.el.style.height = `${page.size.height * s}px`;
    page.rendered = false;
    if (page.visible) renderPage(page);
    else releasePage(page);
  }
  for (const item of state.items) {
    const el = itemElement(item.id);
    if (el) placeRotateHandle(el, item);
  }
}

// Each rendered page holds a full-resolution bitmap, so pages that scroll far
// out of view give theirs back and are drawn again when they return.
function releasePage(page) {
  page.token++;
  page.rendered = false;
  freeCanvas(page.canvas);
}

function freeCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

// One page's bitmap stays under this many pixels (≈64 MB) however far it is
// zoomed; CSS stretches the canvas, so the layout is unchanged.
const MAX_PAGE_PIXELS = 16_000_000;

function renderScale(page) {
  const wanted = scale() * (window.devicePixelRatio || 1);
  const pixels = page.size.width * page.size.height * wanted * wanted;
  return pixels > MAX_PAGE_PIXELS ? wanted * Math.sqrt(MAX_PAGE_PIXELS / pixels) : wanted;
}

async function renderPage(page) {
  const token = ++page.token;
  page.rendered = true;
  const target = document.createElement("canvas");
  const doc = state.doc;
  try {
    await doc.render(page.index, target, renderScale(page));
  } catch (error) {
    freeCanvas(target);
    if (token === page.token) page.rendered = false;
    // Closing the document or replacing the render cancels it mid-way; pdf.js
    // reports that as RenderingCancelledException, which is expected.
    const cancelled = error?.name === "RenderingCancelledException" || state.doc !== doc || token !== page.token;
    if (!cancelled) console.error(error);
    return;
  }
  if (token !== page.token || state.doc !== doc) return freeCanvas(target);
  target.className = page.canvas.className;
  freeCanvas(page.canvas);
  page.canvas.replaceWith(target);
  page.canvas = target;
}

// ---------- zoom ----------

function updateZoomUi() {
  $("zoomLabel").textContent = `${Math.round(ZOOM_STEPS[state.zoomIndex] * 100)}%`;
  $("zoomOut").disabled = !state.doc || state.zoomIndex === 0;
  $("zoomIn").disabled = !state.doc || state.zoomIndex === ZOOM_STEPS.length - 1;
  $("viewerTools").hidden = !state.doc;
}

// anchor: point in the viewer (client px) that should stay put; defaults to the top.
function setZoom(index, anchor) {
  const viewer = $("viewer");
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, index));
  if (!state.doc || next === state.zoomIndex) return;
  const rect = viewer.getBoundingClientRect();
  const ax = anchor ? anchor.x - rect.left : 0;
  const ay = anchor ? anchor.y - rect.top : 0;
  const fx = (viewer.scrollLeft + ax) / Math.max(1, viewer.scrollWidth);
  const fy = (viewer.scrollTop + ay) / Math.max(1, viewer.scrollHeight);
  state.zoomIndex = next;
  layoutPages();
  viewer.scrollLeft = fx * viewer.scrollWidth - ax;
  viewer.scrollTop = fy * viewer.scrollHeight - ay;
  updateZoomUi();
}

// Ctrl + wheel (and trackpad pinch, which arrives as ctrl + wheel) zooms the
// document around the pointer instead of zooming the whole browser page.
let wheelDelta = 0;
$("viewer").addEventListener("wheel", e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  if (!state.doc) return;
  wheelDelta += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  if (Math.abs(wheelDelta) < 40) return;
  const step = wheelDelta < 0 ? 1 : -1;
  wheelDelta = 0;
  setZoom(state.zoomIndex + step, { x: e.clientX, y: e.clientY });
}, { passive: false });

$("zoomIn").addEventListener("click", () => setZoom(state.zoomIndex + 1));
$("zoomOut").addEventListener("click", () => setZoom(state.zoomIndex - 1));

// Two-finger pinch steps through the same zoom levels around the fingers'
// midpoint. The viewer only allows panning (touch-action), so the browser does
// not zoom the whole page instead.
let pinch = null;
const touchGap = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const touchMid = t => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
$("viewer").addEventListener("touchstart", e => {
  if (e.touches.length !== 2 || !state.doc) return;
  pendingTap = null;
  pinch = { gap: touchGap(e.touches) };
}, { passive: true });
$("viewer").addEventListener("touchmove", e => {
  if (!pinch || e.touches.length !== 2) return;
  // Once a one-finger scroll has started the event can no longer be cancelled.
  if (e.cancelable) e.preventDefault();
  const gap = touchGap(e.touches);
  const ratio = gap / pinch.gap;
  // One zoom step per ~35% change in finger distance, so a pinch does not jump
  // straight from 100% to 300%.
  if (ratio > 1.35 || ratio < 1 / 1.35) {
    setZoom(state.zoomIndex + (ratio > 1 ? 1 : -1), touchMid(e.touches));
    pinch.gap = gap;
  }
}, { passive: false });
$("viewer").addEventListener("touchend", e => { if (e.touches.length < 2) pinch = null; });
$("viewer").addEventListener("touchcancel", () => { pinch = null; });
let resizeTimer;
window.addEventListener("resize", () => {
  if (!state.doc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.doc) return;
    computeFitScale();
    layoutPages();
  }, 150);
});

// ---------- placing & editing ----------

function pagePoint(page, e) {
  const rect = page.layer.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * page.size.width,
    y: ((e.clientY - rect.top) / rect.height) * page.size.height,
  };
}

let ghost = null;
function hideGhost() {
  ghost?.remove();
  ghost = null;
}

function positionBox(el, page, box) {
  el.style.left = `${(box.x / page.size.width) * 100}%`;
  el.style.top = `${(box.y / page.size.height) * 100}%`;
  el.style.width = `${(box.w / page.size.width) * 100}%`;
  el.style.height = `${(box.h / page.size.height) * 100}%`;
}

function placeItemElement(el, page, item) {
  positionBox(el, page, item);
  el.style.transform = item.rotation ? `rotate(${item.rotation}deg)` : "";
  placeRotateHandle(el, item);
}

// The rotate handle sits above the stamp; near the top of a page there is no
// room (it would be cut off by the viewer), so it moves below instead.
function placeRotateHandle(el, item) {
  const room = coarsePointer.matches ? 64 : 52; // px the handle needs above the box
  el.classList.toggle("rotate-below", item.y * scale() < room);
}

// ---------- undo / redo ----------
// Every change to the stamps pushes a copy of the list before it, so undo and
// redo just swap whole lists. Items are small plain objects.

const itemHistory = { past: [], future: [], lastNudge: null };

const snapshotItems = () => state.items.map(item => ({ ...item }));

function recordHistory(before = snapshotItems()) {
  itemHistory.past.push(before);
  if (itemHistory.past.length > HISTORY_LIMIT) itemHistory.past.shift();
  itemHistory.future = [];
  itemHistory.lastNudge = null;
  updateHistoryUi();
}

// Arrow-key nudges and key rotations of one item within a second count as one step.
function recordNudge(item) {
  const now = Date.now();
  const last = itemHistory.lastNudge;
  if (!last || last.id !== item.id || now - last.at > 1000) recordHistory();
  itemHistory.lastNudge = { id: item.id, at: now };
}

function resetHistory() {
  itemHistory.past = [];
  itemHistory.future = [];
  itemHistory.lastNudge = null;
  updateHistoryUi();
}

function restoreItems(items) {
  state.items = items;
  if (!items.some(item => item.id === state.selectedId)) state.selectedId = null;
  renderAllItems();
  refreshDirty();
  itemHistory.lastNudge = null;
  updateHistoryUi();
}

function undo() {
  if (!itemHistory.past.length || state.dragging) return;
  itemHistory.future.push(snapshotItems());
  restoreItems(itemHistory.past.pop());
}

function redo() {
  if (!itemHistory.future.length || state.dragging) return;
  itemHistory.past.push(snapshotItems());
  restoreItems(itemHistory.future.pop());
}

function updateHistoryUi() {
  $("undoItemBtn").disabled = !state.doc || itemHistory.past.length === 0;
  $("redoItemBtn").disabled = !state.doc || itemHistory.future.length === 0;
}

// On narrow screens the settings fold away behind a button in the bottom bar.
$("settingsToggle").addEventListener("click", () => {
  const open = $("settingsToggle").getAttribute("aria-expanded") !== "true";
  $("settingsToggle").setAttribute("aria-expanded", String(open));
  document.querySelector(".sidebar").classList.toggle("settings-open", open);
});

$("undoItemBtn").addEventListener("click", undo);
$("redoItemBtn").addEventListener("click", redo);

function placeStamp(page, e, keepArmed) {
  if (state.armedTool) return placeMark(page, e, keepArmed);
  const sig = sigById(state.armedId);
  if (!sig) {
    select(null);
    return;
  }
  const { w, h } = defaultSize(sig, page);
  const p = pagePoint(page, e);
  const item = { id: crypto.randomUUID(), sigId: sig.id, page: page.index, x: p.x - w / 2, y: p.y - h / 2, w, h };
  clampItem(item);
  recordHistory();
  state.items.push(item);
  refreshDirty();
  renderItem(item);
  select(item.id);
  if (!keepArmed) arm(null);
}

// Fingers currently on the screen, so a drag can tell when it became a pinch.
const activeTouches = new Set();
document.addEventListener("pointerdown", e => { if (e.pointerType === "touch") activeTouches.add(e.pointerId); }, true);
for (const type of ["pointerup", "pointercancel"]) {
  document.addEventListener(type, e => activeTouches.delete(e.pointerId), true);
}

// A touch on the page may be the start of a scroll or a pinch, so it places a
// stamp only when it ends as a tap: short, nearly still, never cancelled.
let pendingTap = null;
const TAP_SLOP = 10; // px

function attachLayerEvents(page) {
  page.layer.addEventListener("pointermove", e => {
    if (pendingTap?.pointerId === e.pointerId && Math.hypot(e.clientX - pendingTap.x, e.clientY - pendingTap.y) > TAP_SLOP) pendingTap = null;
    if (e.pointerType !== "mouse") return;
    const sig = sigById(state.armedId);
    if (!sig || e.target !== page.layer) {
      if (e.target !== page.layer) hideGhost();
      return;
    }
    if (!ghost || ghost.parentElement !== page.layer) {
      hideGhost();
      ghost = document.createElement("div");
      ghost.className = "ghost-stamp";
      ghost.append(signatureVisual(sig));
      page.layer.append(ghost);
    }
    const { w, h } = defaultSize(sig, page);
    const p = pagePoint(page, e);
    positionBox(ghost, page, { x: p.x - w / 2, y: p.y - h / 2, w, h });
  });
  page.layer.addEventListener("pointerleave", hideGhost);
  page.layer.addEventListener("pointerdown", e => {
    if (e.target !== page.layer || e.button !== 0) return;
    if (e.pointerType === "mouse") {
      placeStamp(page, e, e.shiftKey);
      return;
    }
    // While a text or mark tool is armed, a tap must not produce the browser's
    // follow-up mouse events: they would move focus out of a new text box.
    // (Panning is governed by touch-action, so scrolling still works.)
    if (state.armedTool) e.preventDefault();
    pendingTap = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, at: Date.now() };
  });
  page.layer.addEventListener("pointerup", e => {
    const tap = pendingTap;
    pendingTap = null;
    if (!tap || tap.pointerId !== e.pointerId || e.target !== page.layer) return;
    if (Date.now() - tap.at > 600 || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP) return;
    placeStamp(page, e, false);
  });
  page.layer.addEventListener("pointercancel", () => { pendingTap = null; });
}

function clampItem(item) {
  const size = state.pages[item.page].size;
  item.x = Math.min(Math.max(item.x, -item.w / 2), size.width - item.w / 2);
  item.y = Math.min(Math.max(item.y, -item.h / 2), size.height - item.h / 2);
}

function itemElement(id) {
  return document.querySelector(`.item[data-id="${id}"]`);
}

function itemVisual(item, sig) {
  if (item.kind === "text") {
    const content = document.createElement("div");
    content.className = "mark-text";
    content.textContent = item.text;
    content.style.setProperty("--size", item.size);
    content.style.color = item.color;
    return content;
  }
  if (item.kind === "shape") {
    const wrap = document.createElement("div");
    wrap.className = "mark-shape-wrap";
    wrap.style.color = item.color;
    wrap.innerHTML = shapeSvg(item.shape);
    return wrap;
  }
  return signatureVisual(sig);
}

function itemLabel(item, sig) {
  const where = `${item.page + 1}쪽`;
  if (item.kind === "text") return `글자 "${item.text || TEXT_PLACEHOLDER}", ${where}`;
  if (item.kind === "shape") return `${MARK_NAMES[item.shape]} 표시, ${where}`;
  return `${sig.name}, ${where}`;
}

function renderItem(item) {
  const sig = item.kind ? null : sigById(item.sigId);
  const page = state.pages[item.page];
  if ((!item.kind && !sig) || !page) return;
  itemElement(item.id)?.remove();
  const el = document.createElement("div");
  el.className = `item${item.kind ? ` is-${item.kind}` : ""}`;
  el.dataset.id = item.id;
  el.tabIndex = 0;
  el.setAttribute("aria-label", itemLabel(item, sig));
  el.classList.toggle("selected", item.id === state.selectedId);
  el.append(itemVisual(item, sig));
  const handle = document.createElement("span");
  handle.className = "handle";
  handle.title = "크기 조절";
  const rotator = document.createElement("span");
  rotator.className = "rotate";
  rotator.title = "회전 (R)";
  rotator.innerHTML = iconSvg("rotate-cw");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.innerHTML = iconSvg("x");
  remove.setAttribute("aria-label", item.kind ? "지우기" : "이 서명 지우기");
  el.append(handle, rotator, remove);
  placeItemElement(el, page, item);
  page.layer.append(el);

  // A tap that places a small mark can end on the new mark's own ✕, and the
  // browser then clicks it; only a press that started on ✕ (or the keyboard,
  // detail 0) removes the item.
  let removePressed = false;
  remove.addEventListener("pointerdown", e => {
    e.stopPropagation();
    removePressed = true;
  });
  remove.addEventListener("click", e => {
    if (e.detail !== 0 && !removePressed) return;
    removePressed = false;
    removeItem(item.id);
  });
  el.addEventListener("focus", () => select(item.id));
  if (item.kind === "text") el.addEventListener("dblclick", () => startTextEdit(item));
  el.addEventListener("pointerdown", e => {
    if (el.classList.contains("editing") && e.target.closest(".mark-text")) return; // placing the caret
    if (e.button !== 0 || state.dragging || activeTouches.size > 1) return;
    const wasSelected = state.selectedId === item.id;
    e.preventDefault();
    e.stopPropagation();
    select(item.id);
    el.focus({ preventScroll: true });
    const mode = e.target === handle ? "resize" : e.target.closest(".rotate") ? "rotate" : "move";
    const before = snapshotItems();
    const start = pagePoint(page, e);
    const orig = { ...item };
    const aspect = item.h / item.w;
    const angle = ((orig.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const centre = { x: orig.x + orig.w / 2, y: orig.y + orig.h / 2 };
    // Resizing keeps the item's own top-left corner in place, even when rotated.
    const anchor = { x: centre.x - (orig.w / 2) * cos + (orig.h / 2) * sin, y: centre.y - (orig.w / 2) * sin - (orig.h / 2) * cos };
    const startAngle = Math.atan2(start.y - centre.y, start.x - centre.x);
    el.setPointerCapture(e.pointerId);
    state.dragging = true;
    const move = ev => {
      if (ev.pointerId !== e.pointerId) return;
      if (activeTouches.size > 1) {
        // A second finger came down: this is a pinch, so put the stamp back.
        Object.assign(item, orig);
        placeItemElement(el, page, item);
        return up(ev, true);
      }
      const p = pagePoint(page, ev);
      if (mode === "resize") {
        // Width follows the pointer along the item's own horizontal axis and
        // proportions are kept; with Shift a mark stretches freely (an oval
        // around a long word, say).
        item.w = Math.max(MIN_ITEM_WIDTH, orig.w + (p.x - start.x) * cos + (p.y - start.y) * sin);
        item.h = item.kind === "shape" && ev.shiftKey
          ? Math.max(MIN_ITEM_WIDTH / 2, orig.h - (p.x - start.x) * sin + (p.y - start.y) * cos)
          : item.w * aspect;
        if (item.kind === "text") item.size = (orig.size * item.w) / orig.w;
        const cx = anchor.x + (item.w / 2) * cos - (item.h / 2) * sin;
        const cy = anchor.y + (item.w / 2) * sin + (item.h / 2) * cos;
        item.x = cx - item.w / 2;
        item.y = cy - item.h / 2;
      } else if (mode === "rotate") {
        const turned = ((Math.atan2(p.y - centre.y, p.x - centre.x) - startAngle) * 180) / Math.PI;
        item.rotation = snapRotation((orig.rotation || 0) + turned, ev.shiftKey);
      } else {
        item.x = orig.x + (p.x - start.x);
        item.y = orig.y + (p.y - start.y);
      }
      clampItem(item);
      placeItemElement(el, page, item);
    };
    const up = (ev, aborted = false) => {
      if (ev && ev.pointerId !== e.pointerId) return;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      state.dragging = false;
      if (aborted) return;
      const changed = item.x !== orig.x || item.y !== orig.y || item.w !== orig.w || item.h !== orig.h || (item.rotation || 0) !== (orig.rotation || 0);
      if (changed) {
        recordHistory(before);
        refreshDirty();
      }
      if (mode === "resize" && item.w !== orig.w && sig) rememberWidth(sig, item.w);
      if (mode === "resize" && item.kind === "text") renderItem(item); // font size follows the box
      // On touch, tapping a text that is already selected edits it.
      if (!changed && wasSelected && item.kind === "text" && ev?.pointerType && ev.pointerType !== "mouse") startTextEdit(item);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}

// Free rotation, pulled to the nearest right angle within 5°; Shift steps by 15°.
function snapRotation(degrees, fine) {
  let d = ((degrees % 360) + 360) % 360;
  if (fine) d = Math.round(d / 15) * 15;
  else {
    const right = Math.round(d / 90) * 90;
    if (Math.abs(d - right) < 5) d = right;
  }
  return (Math.round(d * 10) / 10) % 360;
}

// Saves a copy, so a failed save leaves the remembered width as it was.
function rememberWidth(sig, width) {
  const next = state.signatures.map(s => (s.id === sig.id ? { ...s, lastWidth: Math.round(width * 10) / 10 } : s));
  commitSignatures(next);
}

function renderAllItems() {
  document.querySelectorAll(".item").forEach(el => el.remove());
  for (const item of state.items) renderItem(item);
}

function select(id) {
  state.selectedId = id;
  document.querySelectorAll(".item").forEach(el => el.classList.toggle("selected", el.dataset.id === id));
}

function removeItem(id) {
  recordHistory();
  state.items = state.items.filter(item => item.id !== id);
  itemElement(id)?.remove();
  if (state.selectedId === id) state.selectedId = null;
  refreshDirty();
}

document.addEventListener("keydown", e => {
  if (!$("busy").hidden || document.querySelector("dialog[open]") || e.target.matches("input, select, textarea") || e.target.isContentEditable) return;
  if (state.doc && (e.ctrlKey || e.metaKey) && !e.altKey) {
    const key = { KeyZ: "z", KeyY: "y" }[e.code] ?? e.key.toLowerCase();
    if (key === "z" || key === "y") {
      e.preventDefault();
      if (key === "y" || e.shiftKey) redo();
      else undo();
      return;
    }
  }
  if (e.key === "Escape") {
    arm(null);
    select(null);
    return;
  }
  const item = state.items.find(i => i.id === state.selectedId);
  if (!item) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    removeItem(item.id);
    return;
  }
  // By physical key: with the Korean input mode on, e.key is "ㄱ", not "r".
  if (e.key === "Enter" && item.kind === "text") {
    e.preventDefault();
    startTextEdit(item);
    return;
  }
  if (e.code === "KeyR" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    recordNudge(item);
    item.rotation = snapRotation((item.rotation || 0) + (e.shiftKey ? -15 : 15), true);
    placeItemElement(itemElement(item.id), state.pages[item.page], item);
    refreshDirty();
    return;
  }
  const step = e.shiftKey ? 10 : 1;
  const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (delta) {
    e.preventDefault();
    recordNudge(item);
    item.x += delta[0];
    item.y += delta[1];
    clampItem(item);
    placeItemElement(itemElement(item.id), state.pages[item.page], item);
    refreshDirty();
  }
});

// ---------- save ----------

// 저장 | ⋯ : PDF on computers, JPG images on phones and tablets (they go straight
// to the photo library or a chat app); the ⋯ menu offers PDF, PNG and JPG.
const SAVE_LABELS = { pdf: "PDF로 저장", jpg: "이미지로 저장" };
const IMAGE_FORMATS = { png: { ext: "png", type: "image/png" }, jpg: { ext: "jpg", type: "image/jpeg" } };
const defaultFormat = coarsePointer.matches ? "jpg" : "pdf";
$("saveLabel").textContent = SAVE_LABELS[defaultFormat];
const closeSaveMenu = popupMenu($("moreSaveBtn"), $("saveMenu"), $("saveGroup"));

const savedName = () => `${state.doc.name.replace(/\.[^.]+$/, "")}_서명`;

// Phones: the share sheet (사진에 저장, 카카오톡 …). Computers: a download,
// zipped when there is more than one page.
async function deliverImages(blobs, { ext, type }) {
  const base = savedName();
  const names = blobs.length === 1 ? [`${base}.${ext}`] : blobs.map((_, i) => `${base}_${i + 1}.${ext}`);
  const files = blobs.map((blob, i) => new File([blob], names[i], { type }));
  if (coarsePointer.matches && navigator.canShare?.({ files })) {
    const share = async () => {
      try {
        await navigator.share({ files });
        return "shared";
      } catch (error) {
        return error.name === "AbortError" ? "cancelled" : error.name === "NotAllowedError" ? "blocked" : "failed";
      }
    };
    let result = await share();
    // Rendering can outlast the tap that started it; a second tap lets the browser share.
    if (result === "blocked" && await askConfirm({
      title: "이미지가 준비됐습니다",
      description: `${files.length}장을 사진에 저장하거나 다른 앱으로 보낼 수 있습니다.`,
      confirmLabel: "저장·공유",
    })) result = await share();
    if (result === "shared") return "이미지를 내보냈습니다.";
    if (result === "cancelled" || result === "blocked") return null;
  }
  if (files.length === 1) {
    downloadBlob(files[0], names[0]);
  } else if (coarsePointer.matches) {
    for (const [i, file] of files.entries()) setTimeout(() => downloadBlob(file, names[i]), i * 300);
  } else {
    downloadBlob(await buildZip(files.map((blob, i) => ({ name: names[i], blob }))), `${base}.zip`);
  }
  return "저장했습니다. 다운로드 폴더를 확인하세요.";
}

async function save(format = defaultFormat) {
  if (!state.doc) return;
  const image = IMAGE_FORMATS[format];
  const label = image ? format.toUpperCase() : "PDF";
  if (state.items.length === 0 && !(await askConfirm({
    title: "서명 없이 저장할까요?",
    description: image
      ? "문서에 찍힌 서명이 없습니다. 그대로 이미지로 저장합니다."
      : "문서에 찍힌 서명이 없습니다. 그대로 편집할 수 없는 PDF로 저장합니다.",
    confirmLabel: "그대로 저장",
  }))) return;
  select(null);
  arm(null);
  const dpi = Number($("dpi").value) || 200;
  $("busyNote").hidden = false; // shown only while saving, not while opening
  busy(`${label}로 저장하는 중…`, 0);
  let blobs = null;
  try {
    const signatures = new Map(state.signatures.map(s => [s.id, s]));
    const opts = {
      dpi,
      onProgress: (done, total) => busy(`${label}로 저장하는 중… (${done}/${total}쪽)`, done / total),
    };
    if (image) {
      blobs = await exportFlatImages(state.doc, state.items, signatures, { ...opts, type: image.type });
    } else {
      downloadBlob(await exportFlatPdf(state.doc, state.items, signatures, opts), `${savedName()}.pdf`);
    }
  } catch (error) {
    console.error(error);
    toast(`${label}로 저장하지 못했습니다. 화질을 낮춰 다시 시도해 주세요.`, 6000);
    return;
  } finally {
    $("busyNote").hidden = true;
    busy(null);
  }
  const message = blobs ? await deliverImages(blobs, image) : "저장했습니다. 다운로드 폴더를 확인하세요.";
  if (!message) return;
  state.savedItems = itemsKey(state.items);
  state.dirty = false;
  toast(message);
}

$("saveBtn").addEventListener("click", () => save());
for (const item of $("saveMenu").querySelectorAll(".menu-item")) {
  item.addEventListener("click", () => {
    closeSaveMenu();
    save(item.dataset.format);
  });
}

// ---------- opening files ----------

const openPicker = () => $("fileInput").click();
$("openBtn").addEventListener("click", openPicker);
$("emptyOpenBtn").addEventListener("click", openPicker);
$("fileInput").addEventListener("change", e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) loadFile(file);
});

const viewer = $("viewer");
let dragDepth = 0;
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => e.preventDefault());
viewer.addEventListener("dragenter", e => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  dragDepth++;
  viewer.classList.add("dragging");
});
viewer.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) viewer.classList.remove("dragging");
});
viewer.addEventListener("drop", e => {
  e.preventDefault();
  dragDepth = 0;
  viewer.classList.remove("dragging");
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

window.addEventListener("beforeunload", e => {
  if (state.dirty) e.preventDefault();
});

// ---------- start ----------

state.signatures = await loadSignatures();
renderSidebar();
updateZoomUi();
