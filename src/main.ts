import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Doc } from "./doc";
import { Grid, colName, isNumeric, parseRef } from "./grid";
import { detectDelimiter, detectNewline, parseCsv, serializeCsv } from "./csv";
import { IN_TAURI, byteLength, fastByteLength, readFile, writeFile } from "./ipc";
import { showAbout, showSettings } from "./about";
import { L, onLangChange, resolveLang, setLang, type LangPref } from "./i18n";
import { alertMsg, ask, hideBusy, isModalOpen, showBusy, showMenu, yieldToPaint, type MenuItem } from "./ui";
import { autoCheck, setupUpdater } from "./update";

const APP = "CSVSSE";
const SAVE_ENCODINGS = ["UTF-8", "UTF-8 BOM", "Shift_JIS", "UTF-16LE"];
const OPEN_ENCODINGS = ["UTF-8", "Shift_JIS", "UTF-16LE", "EUC-JP"];
const DELIMS: { v: string; label: () => string }[] = [
  { v: ",", label: () => L().comma },
  { v: "\t", label: () => L().tab },
  { v: ";", label: () => L().semicolon },
];
const NEWLINES: { v: string; label: string }[] = [
  { v: "\r\n", label: "CRLF" },
  { v: "\n", label: "LF" },
  { v: "\r", label: "CR" },
];
/** Grid.setZoom の範囲と同じ */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200, 300];
const RECENT_MAX = 10;
const fileFilters = () => [
  { name: "CSV / TSV", extensions: ["csv", "tsv", "txt"] },
  { name: L().allFiles, extensions: ["*"] },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const encLabel = (e: string) =>
  e === "UTF-8 BOM" ? L().utf8Bom : e === "UTF-16LE" ? "UTF-16 LE" : e === "UTF-16BE" ? "UTF-16 BE" : e;
const delimLabel = (d: string) => DELIMS.find((x) => x.v === d)?.label() ?? JSON.stringify(d);
const nlLabel = (n: string) => NEWLINES.find((x) => x.v === n)?.label ?? "CRLF";
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

// ------------------------------------------------------------------ state

const doc = new Doc();
const state = {
  path: null as string | null,
  encoding: "UTF-8 BOM", // new files: Excel opens UTF-8 with BOM without garbling
  delimiter: ",",
  newline: "\r\n",
  trailingNewline: true,
  metaDirty: false,
};
const isDirty = () => doc.dirty || state.metaDirty;

const formula = $<HTMLTextAreaElement>("formula");
const namebox = $<HTMLInputElement>("namebox");

let msgTimer = 0;
function setMessage(text: string) {
  const el = $("st-msg");
  el.textContent = text;
  clearTimeout(msgTimer);
  msgTimer = window.setTimeout(() => (el.textContent = ""), 6000);
}

const grid = new Grid($("grid"), doc, {
  changed: () => refreshAll(),
  selectionChanged: () => refreshSelection(),
  editing: (text) => {
    if (document.activeElement !== formula) formula.value = text;
    updateCellBytes(text);
  },
  contextMenu: (x, y) => openContextMenu(x, y),
  writeClipboard: (t) => (IN_TAURI ? writeText(t) : navigator.clipboard.writeText(t)),
  readClipboard: async () => {
    try {
      return (IN_TAURI ? await readText() : await navigator.clipboard.readText()) ?? "";
    } catch {
      return "";
    }
  },
  zoomChanged: () => updateStatus(),
  message: setMessage,
});

// ------------------------------------------------------------------ refresh

function updateTitle() {
  const name = state.path ? baseName(state.path) : L().untitled;
  const title = `${isDirty() ? "*" : ""}${name} - ${APP}`;
  document.title = title;
  if (IN_TAURI) void getCurrentWindow().setTitle(title);
}

function updateStatus() {
  $("st-size").textContent = L().size(doc.rowCount.toLocaleString(), doc.colCount.toLocaleString());
  $("st-delim").textContent = delimLabel(state.delimiter);
  $("st-nl").textContent = nlLabel(state.newline);
  $("st-enc").textContent = encLabel(state.encoding);
  $("st-zoom").textContent = `${Math.round(grid.zoom * 100)}%`;
  $<HTMLButtonElement>("zoom-out").disabled = grid.zoom <= ZOOM_MIN;
  $<HTMLButtonElement>("zoom-in").disabled = grid.zoom >= ZOOM_MAX;
}

function updateButtons() {
  $<HTMLButtonElement>("btn-undo").disabled = !doc.canUndo;
  $<HTMLButtonElement>("btn-redo").disabled = !doc.canRedo;
  $("btn-freeze").setAttribute("aria-pressed", String(grid.frozenRows > 0 || grid.frozenCols > 0));
}

let bytesSeq = 0;
function updateCellBytes(text: string | null) {
  const seq = ++bytesSeq;
  const el = $("st-bytes");
  if (text === null) {
    el.textContent = "";
    return;
  }
  const fast = fastByteLength(text, state.encoding);
  if (fast !== null) {
    el.textContent = L().bytes(fast.toLocaleString());
    return;
  }
  void byteLength(text, state.encoding).then((n) => {
    if (seq === bytesSeq) el.textContent = L().bytes(n.toLocaleString());
  });
}

let statsTimer = 0;
function refreshSelection() {
  const s = grid.sel;
  const R = grid.selRect();
  const single = R.r0 === R.r1 && R.c0 === R.c1 && !s.allRows && !s.allCols;
  if (document.activeElement !== namebox) {
    namebox.value = single
      ? `${colName(s.ac)}${s.ar + 1}`
      : `${colName(R.c0)}${R.r0 + 1}:${colName(R.c1)}${R.r1 + 1}`;
  }
  if (document.activeElement !== formula && grid.mode === "nav") formula.value = doc.get(s.ar, s.ac);
  if (single) {
    const text =
      grid.mode !== "nav"
        ? grid.editor.value
        : document.activeElement === formula
          ? formula.value
          : doc.get(s.ar, s.ac);
    updateCellBytes(text);
  } else {
    updateCellBytes(null);
  }
  clearTimeout(statsTimer);
  statsTimer = window.setTimeout(() => ($("st-sel").textContent = selectionStats()), 60);
}

function refreshAll() {
  updateTitle();
  updateStatus();
  updateButtons();
  refreshSelection();
}

function toNumber(v: string): number | null {
  const t = v.trim();
  if (!isNumeric(t)) return null;
  const n = parseFloat(t.replace(/[,%]/g, ""));
  if (!isFinite(n)) return null;
  return t.endsWith("%") ? n / 100 : n;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/** Excel-style summary of the selection for the status bar. */
function selectionStats(): string {
  const R = grid.selRect();
  const cells = (R.r1 - R.r0 + 1) * (R.c1 - R.c0 + 1);
  if (cells <= 1) return "";
  if (cells > 2_000_000) return L().cells(cells.toLocaleString());
  let count = 0;
  let nums = 0;
  let sum = 0;
  const r1 = Math.min(R.r1, doc.rowCount - 1);
  for (let r = R.r0; r <= r1; r++) {
    const row = doc.rows[r];
    const c1 = Math.min(R.c1, row.length - 1);
    for (let c = R.c0; c <= c1; c++) {
      const v = row[c];
      if (!v) continue;
      count++;
      const n = toNumber(v);
      if (n !== null) {
        nums++;
        sum += n;
      }
    }
  }
  const parts: string[] = [];
  const t = L();
  if (nums) parts.push(`${t.average}: ${fmt(sum / nums)}`);
  parts.push(`${t.count}: ${count.toLocaleString()}`);
  if (nums) parts.push(`${t.sum}: ${fmt(sum)}`);
  return parts.join(t.statSep);
}

// ------------------------------------------------------------------ file operations

async function confirmDiscard(): Promise<boolean> {
  grid.commitEdit();
  if (!isDirty()) return true;
  const t = L();
  const name = state.path ? baseName(state.path) : t.untitled;
  const v = await ask(t.saveChanges(name), [
    { label: t.doSave, value: "save", primary: true },
    { label: t.dontSave, value: "discard" },
    { label: t.cancel, value: "cancel" },
  ]);
  if (v === "save") return save(false);
  return v === "discard";
}

async function loadPath(path: string, opts: { encoding?: string; delimiter?: string } = {}) {
  showBusy(L().loading);
  await yieldToPaint();
  try {
    const { text, encoding } = await readFile(path, opts.encoding);
    const delimiter = opts.delimiter ?? detectDelimiter(text, path);
    const rows = parseCsv(text, delimiter);
    let cols = 0;
    for (const r of rows) if (r.length > cols) cols = r.length;
    doc.load(rows, cols);
    Object.assign(state, {
      path,
      encoding,
      delimiter,
      newline: detectNewline(text),
      trailingNewline: text.length === 0 || /[\r\n]$/.test(text),
      metaDirty: false,
    });
    grid.reset();
    refreshAll();
    setMessage(L().loadedRows(rows.length.toLocaleString()));
    void addRecent(path);
  } catch (e) {
    hideBusy();
    await alertMsg(String(e));
  } finally {
    hideBusy();
    grid.focus();
  }
}

async function cmdOpen() {
  if (!IN_TAURI || !(await confirmDiscard())) return;
  const p = await openDialog({ multiple: false, directory: false, filters: fileFilters() });
  if (typeof p === "string") await loadPath(p);
}

async function cmdNew() {
  if (!(await confirmDiscard())) return;
  doc.load([], 0);
  Object.assign(state, {
    path: null,
    encoding: "UTF-8 BOM",
    delimiter: ",",
    newline: "\r\n",
    trailingNewline: true,
    metaDirty: false,
  });
  grid.reset();
  refreshAll();
  grid.focus();
}

async function save(saveAs: boolean): Promise<boolean> {
  grid.commitEdit();
  if (!IN_TAURI) {
    setMessage(L().previewNoSave);
    return false;
  }
  let path = state.path;
  if (!path || saveAs) {
    const p = await saveDialog({ defaultPath: state.path ?? L().newFileName, filters: fileFilters() });
    if (!p) return false;
    path = p;
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext === "tsv" && state.delimiter !== "\t") state.delimiter = "\t";
    else if (ext === "csv" && state.delimiter === "\t") state.delimiter = ",";
  }
  const t = L();
  showBusy(t.saving);
  await yieldToPaint();
  try {
    const text = serializeCsv(doc.rows, doc.colCount, state.delimiter, state.newline, state.trailingNewline);
    let res = await writeFile(path, text, state.encoding, false);
    if (res.unmappable) {
      hideBusy();
      const v = await ask(t.unmappable(encLabel(state.encoding), res.unmappable.join("　")), [
        { label: t.saveAsUtf8, value: "utf8", primary: true },
        { label: t.saveReplacing, value: "force" },
        { label: t.cancel, value: "cancel" },
      ]);
      if (v === "cancel") return false;
      showBusy(t.saving);
      if (v === "utf8") {
        state.encoding = "UTF-8 BOM";
        res = await writeFile(path, text, state.encoding, false);
      } else res = await writeFile(path, text, state.encoding, true);
    }
    state.path = path;
    state.metaDirty = false;
    doc.markSaved(); // 変更セルの色付けもここで消える
    grid.render();
    refreshAll();
    setMessage(t.saved(encLabel(state.encoding)));
    void addRecent(path);
    return true;
  } catch (e) {
    hideBusy();
    await alertMsg(String(e));
    return false;
  } finally {
    hideBusy();
    grid.focus();
  }
}

// ------------------------------------------------------------------ recent files
// 一覧は設定ファイルの "recent" に入れる。ウィンドウが複数あっても食い違わないよう、毎回読み直す。

let recentPreview: string[] = []; // ブラウザープレビュー用

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const dirName = (p: string) => p.slice(0, Math.max(0, p.length - baseName(p).length)).replace(/[\\/]$/, "");

async function loadRecent(): Promise<string[]> {
  if (!IN_TAURI) return recentPreview;
  try {
    const r = (await invoke<Record<string, unknown>>("load_settings")).recent;
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function saveRecent(list: string[]) {
  if (!IN_TAURI) {
    recentPreview = list;
    return;
  }
  try {
    await invoke("save_settings", { settings: { recent: list } });
  } catch {
    /* 設定は保存できなくても困らない */
  }
}

async function addRecent(path: string) {
  const list = (await loadRecent()).filter((p) => !samePath(p, path));
  list.unshift(path);
  await saveRecent(list.slice(0, RECENT_MAX));
}

async function removeRecent(path: string) {
  await saveRecent((await loadRecent()).filter((p) => !samePath(p, path)));
}

async function openRecent(path: string) {
  if (IN_TAURI && !(await invoke<boolean>("path_exists", { path }))) {
    const t = L();
    const v = await ask(t.recentMissing(path), [
      { label: t.recentRemove, value: "remove", primary: true },
      { label: t.cancel, value: "cancel" },
    ]);
    if (v === "remove") await removeRecent(path);
    grid.focus();
    return;
  }
  if (!(await confirmDiscard())) return;
  if (IN_TAURI) await loadPath(path);
  else setMessage(L().previewNoSave);
}

async function showRecentMenu(btn: HTMLElement) {
  const list = await loadRecent();
  const t = L();
  const items: MenuItem[] = [{ header: t.recentHeader }];
  if (!list.length) items.push({ label: t.recentEmpty, disabled: true });
  for (const p of list) {
    items.push({
      label: baseName(p),
      detail: dirName(p),
      title: p,
      checked: state.path !== null && samePath(state.path, p) ? true : undefined,
      action: () => void openRecent(p),
    });
  }
  if (list.length) items.push({ sep: true }, { label: t.recentClear, action: () => void saveRecent([]) });
  const r = btn.getBoundingClientRect();
  showMenu(items, r.left, r.bottom + 2, { restoreFocus: grid.editor });
}

const recentBtn = $("btn-recent");
recentBtn.addEventListener("mousedown", (e) => e.preventDefault()); // グリッドのフォーカスを保つ
recentBtn.addEventListener("click", () => void showRecentMenu(recentBtn));

async function reopen(opts: { encoding?: string; delimiter?: string }) {
  if (!state.path) return;
  if (isDirty()) {
    const v = await ask(L().reopenConfirm, [
      { label: L().reopen, value: "ok", primary: true },
      { label: L().cancel, value: "cancel" },
    ]);
    if (v !== "ok") return;
  }
  await loadPath(state.path, opts);
}

// ------------------------------------------------------------------ menus

function openContextMenu(x: number, y: number) {
  const t = L();
  showMenu(
    [
      { label: t.cut, shortcut: "Ctrl+X", action: () => void grid.copy(true) },
      { label: t.copy, shortcut: "Ctrl+C", action: () => void grid.copy(false) },
      { label: t.paste, shortcut: "Ctrl+V", action: () => void grid.paste() },
      { sep: true },
      { label: t.insertRowAbove, shortcut: "Ctrl++", action: () => grid.insertRows(false) },
      { label: t.insertRowBelow, action: () => grid.insertRows(true) },
      { label: t.deleteRow, shortcut: "Ctrl+-", action: () => grid.deleteRows() },
      { sep: true },
      { label: t.insertColLeft, action: () => grid.insertCols(false) },
      { label: t.insertColRight, action: () => grid.insertCols(true) },
      { label: t.deleteCol, action: () => grid.deleteCols() },
      { sep: true },
      { label: t.clearContents, shortcut: "Delete", action: () => grid.clear() },
    ],
    x,
    y,
    { restoreFocus: grid.editor },
  );
}

function statusMenu(btn: HTMLElement, items: MenuItem[]) {
  const r = btn.getBoundingClientRect();
  showMenu(items, r.left, r.top, { above: true, restoreFocus: grid.editor });
}

$("st-enc").addEventListener("click", (e) => {
  const list = SAVE_ENCODINGS.includes(state.encoding) ? SAVE_ENCODINGS : [state.encoding, ...SAVE_ENCODINGS];
  const items: MenuItem[] = [
    { header: L().saveEncoding },
    ...list.map((enc) => ({
      label: encLabel(enc),
      checked: state.encoding === enc,
      action: () => {
        if (state.encoding === enc) return;
        state.encoding = enc;
        state.metaDirty = true;
        refreshAll();
      },
    })),
  ];
  if (state.path) {
    items.push(
      { sep: true },
      { header: L().reopenEncoding },
      ...OPEN_ENCODINGS.map((enc) => ({ label: encLabel(enc), action: () => void reopen({ encoding: enc }) })),
    );
  }
  statusMenu(e.currentTarget as HTMLElement, items);
});

$("st-delim").addEventListener("click", (e) => {
  const items: MenuItem[] = [
    { header: L().saveDelimiter },
    ...DELIMS.map((d) => ({
      label: d.label(),
      checked: state.delimiter === d.v,
      action: () => {
        if (state.delimiter === d.v) return;
        state.delimiter = d.v;
        state.metaDirty = true;
        refreshAll();
      },
    })),
  ];
  if (state.path) {
    items.push(
      { sep: true },
      { header: L().reopenDelimiter },
      ...DELIMS.map((d) => ({
        label: d.label(),
        action: () => void reopen({ delimiter: d.v, encoding: state.encoding }),
      })),
    );
  }
  statusMenu(e.currentTarget as HTMLElement, items);
});

$("st-nl").addEventListener("click", (e) => {
  statusMenu(e.currentTarget as HTMLElement, [
    { header: L().saveNewline },
    ...NEWLINES.map((n) => ({
      label: `${n.label}${n.v === "\r\n" ? L().nlWindows : n.v === "\n" ? L().nlUnix : ""}`,
      checked: state.newline === n.v,
      action: () => {
        if (state.newline === n.v) return;
        state.newline = n.v;
        state.metaDirty = true;
        refreshAll();
      },
    })),
  ]);
});

// ------------------------------------------------------------------ zoom（右下に常時表示）

/** −／＋ボタン：Excel と同じく 10% 刻み */
function stepZoom(dir: 1 | -1) {
  const p = Math.round(grid.zoom * 100);
  const next = dir > 0 ? Math.floor(p / 10) * 10 + 10 : Math.ceil(p / 10) * 10 - 10;
  grid.setZoom(next / 100);
}

for (const id of ["zoom-out", "st-zoom", "zoom-in"]) {
  $(id).addEventListener("mousedown", (e) => e.preventDefault()); // グリッドのフォーカスを保つ
}
$("zoom-out").addEventListener("click", () => stepZoom(-1));
$("zoom-in").addEventListener("click", () => stepZoom(1));
$("st-zoom").addEventListener("click", (e) => {
  const cur = Math.round(grid.zoom * 100);
  statusMenu(e.currentTarget as HTMLElement, [
    { header: L().zoomHeader },
    ...ZOOM_PRESETS.map((p) => ({
      label: `${p}%`,
      checked: cur === p,
      shortcut: p === 100 ? "Ctrl+0" : undefined,
      action: () => grid.setZoom(p / 100),
    })),
  ]);
});

// ------------------------------------------------------------------ find & replace

const findbar = $("findbar");
const findQ = $<HTMLInputElement>("find-q");
const repQ = $<HTMLInputElement>("rep-q");

function openFind(replace: boolean) {
  grid.commitEdit();
  findbar.hidden = false;
  if (replace) setReplaceVisible(true);
  findQ.focus();
  findQ.select();
  updateFindCount();
}

function closeFind() {
  findbar.hidden = true;
  grid.focus();
}

function setReplaceVisible(on: boolean) {
  $("rep-row").hidden = !on;
  $("find-expand").setAttribute("aria-expanded", String(on));
}

function cellMatches(v: string, q: string) {
  return v !== "" && v.toLowerCase().includes(q);
}

function findNext(dir: 1 | -1): boolean {
  const q = findQ.value.toLowerCase();
  if (!q) return false;
  const rows = doc.rowCount;
  const cols = doc.colCount;
  const total = rows * cols;
  if (!total) return false;
  const { ar, ac } = grid.sel;
  const start = Math.min(ar, rows - 1) * cols + Math.min(ac, cols - 1);
  for (let i = 1; i <= total; i++) {
    const p = (((start + dir * i) % total) + total) % total;
    const r = Math.floor(p / cols);
    const c = p % cols;
    if (cellMatches(doc.rows[r][c] ?? "", q)) {
      grid.select(r, c);
      return true;
    }
  }
  setMessage(L().notFound(findQ.value));
  return false;
}

let countTimer = 0;
function updateFindCount() {
  clearTimeout(countTimer);
  countTimer = window.setTimeout(() => {
    const q = findQ.value.toLowerCase();
    if (!q) {
      $("find-count").textContent = "";
      return;
    }
    let n = 0;
    for (const row of doc.rows) for (let c = 0; c < row.length; c++) if (cellMatches(row[c], q)) n++;
    $("find-count").textContent = L().matches(n.toLocaleString());
  }, 150);
}

function replaceRegex() {
  return new RegExp(findQ.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
}

function replaceOne() {
  const q = findQ.value.toLowerCase();
  if (!q) return;
  const { ar, ac } = grid.sel;
  const v = doc.get(ar, ac);
  if (cellMatches(v, q)) {
    grid.setCellValue(ar, ac, v.replace(replaceRegex(), () => repQ.value));
    refreshAll();
  }
  findNext(1);
  updateFindCount();
}

function replaceAll() {
  const q = findQ.value.toLowerCase();
  if (!q) return;
  const re = replaceRegex();
  const changes: { r: number; c: number; a: string }[] = [];
  doc.rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (cellMatches(row[c], q)) changes.push({ r, c, a: row[c].replace(re, () => repQ.value) });
    }
  });
  const n = doc.setList(changes);
  grid.render();
  refreshAll();
  updateFindCount();
  setMessage(n ? L().replacedCells(n.toLocaleString()) : L().nothingToReplace);
}

findQ.addEventListener("input", updateFindCount);
findQ.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "Enter") {
    e.preventDefault();
    findNext(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});
repQ.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "Enter") {
    e.preventDefault();
    replaceOne();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});
$("find-next").addEventListener("click", () => findNext(1));
$("find-prev").addEventListener("click", () => findNext(-1));
$("find-close").addEventListener("click", closeFind);
$("find-expand").addEventListener("click", () =>
  setReplaceVisible($("find-expand").getAttribute("aria-expanded") !== "true"),
);
$("rep-one").addEventListener("click", replaceOne);
$("rep-all").addEventListener("click", replaceAll);

// ------------------------------------------------------------------ formula bar & name box

function commitFormula() {
  const { ar, ac } = grid.sel;
  if (formula.value !== doc.get(ar, ac)) grid.setCellValue(ar, ac, formula.value);
}

formula.addEventListener("focus", () => {
  if (grid.mode !== "nav") grid.commitEdit();
});
formula.addEventListener("input", () => updateCellBytes(formula.value));
formula.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && e.altKey) {
    e.preventDefault();
    formula.setRangeText("\n", formula.selectionStart, formula.selectionEnd, "end");
    updateCellBytes(formula.value);
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    commitFormula();
    grid.focus();
    if (e.key === "Enter") grid.move(e.shiftKey ? -1 : 1, 0);
    else grid.move(0, e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    formula.value = doc.get(grid.sel.ar, grid.sel.ac);
    updateCellBytes(formula.value);
    grid.focus();
  }
});
formula.addEventListener("blur", () => {
  if (document.hasFocus()) commitFormula();
});

namebox.addEventListener("focus", () => namebox.select());
namebox.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "Enter") {
    e.preventDefault();
    const R = parseRef(namebox.value, grid.sel.ac);
    grid.focus();
    if (R) grid.select(R.r0, R.c0, R.r1, R.c1);
    else {
      setMessage(L().badRef);
      refreshSelection();
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    grid.focus();
    refreshSelection();
  }
});
namebox.addEventListener("blur", () => refreshSelection());

// ------------------------------------------------------------------ toolbar & shortcuts

/**
 * Excel の「ウィンドウ枠の固定」：選択中のセルより上の行と左の列を固定する。
 * A1 のときは 1 行目だけを固定（見出し行の固定がいちばんよく使われるため）。固定中なら解除。
 */
function toggleFreeze() {
  grid.commitEdit();
  const t = L();
  if (grid.frozenRows || grid.frozenCols) {
    grid.setFreeze(0, 0);
    setMessage(t.unfrozen);
  } else {
    const { ar, ac } = grid.sel;
    const [rows, cols] = ar === 0 && ac === 0 ? [1, 0] : [ar, ac];
    if (grid.setFreeze(rows, cols)) {
      const parts: string[] = [];
      if (rows) parts.push(t.frozenRowsDesc(rows));
      if (cols) parts.push(t.frozenColsDesc(colName(cols - 1)));
      setMessage(t.frozeDone(parts.join(t.frozenJoin)));
    } else setMessage(t.freezeTooLarge);
  }
  updateButtons();
  grid.focus();
}

const commands: Record<string, () => void> = {
  new: () => void cmdNew(),
  open: () => void cmdOpen(),
  save: () => void save(false),
  undo: () => grid.undo(),
  redo: () => grid.redo(),
  find: () => openFind(false),
  replace: () => openFind(true),
  freeze: toggleFreeze,
  settings: () => void openSettings(),
  about: () => void showAbout(),
};

// ------------------------------------------------------------------ language

let langPref: LangPref = "auto";
let updateCheck = true;
let osLang: string | null = null;

function applyLanguage() {
  const l = resolveLang(langPref, osLang);
  setLang(l);
  if (IN_TAURI) void invoke("set_language", { lang: l }).catch(() => {});
}

onLangChange(() => {
  grid.editor.setAttribute("aria-label", L().editCellAria);
  refreshAll();
  updateFindCount();
});

async function openSettings() {
  await showSettings({
    pref: langPref,
    osLang,
    onLanguage: (p) => {
      langPref = p;
      applyLanguage();
      void persistSettings();
    },
    updateCheck,
    onUpdateCheck: (on) => {
      updateCheck = on;
      void persistSettings();
    },
  });
  grid.focus();
}

document.querySelectorAll<HTMLButtonElement>("[data-cmd]").forEach((b) => {
  b.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the grid
  b.addEventListener("click", () => {
    commands[b.dataset.cmd!]();
    if (b.dataset.cmd !== "find" && b.dataset.cmd !== "replace") grid.focus();
  });
});

window.addEventListener(
  "keydown",
  (e) => {
    if (isModalOpen()) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    let handled = true;
    if (ctrl && !e.altKey && k === "o") void cmdOpen();
    else if (ctrl && !e.altKey && k === "s") void save(e.shiftKey);
    else if (ctrl && !e.altKey && k === "n") {
      if (e.shiftKey && IN_TAURI) void invoke("new_window", { path: null });
      else if (!e.shiftKey) void cmdNew();
    } else if (ctrl && !e.altKey && k === "f") openFind(false);
    else if (ctrl && !e.altKey && k === "h") openFind(true);
    else if (e.key === "F3") findNext(e.shiftKey ? -1 : 1);
    else if (e.key === "F12") toggleFreeze();
    else if (e.key === "F1") void showAbout();
    else if (ctrl && e.key === ",") void openSettings();
    else if (ctrl && !e.altKey && !e.shiftKey && (e.key === "0" || e.code === "Numpad0")) grid.setZoom(1);
    // Swallow browser shortcuts that make no sense in a desktop app.
    else if (e.key === "F5" || (ctrl && (k === "r" || k === "p" || k === "g" || k === "u" || k === "j"))) {
      /* ignore */
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!(t instanceof HTMLInputElement || (t instanceof HTMLTextAreaElement && t !== grid.editor))) e.preventDefault();
});

// ------------------------------------------------------------------ window integration

async function persistSettings() {
  try {
    await invoke("save_settings", { settings: { freezeRows: grid.frozenRows, freezeCols: grid.frozenCols, zoom: grid.zoom, language: langPref, updateCheck } });
  } catch {
    /* settings are best-effort */
  }
}

let startupSettings: Record<string, unknown> = {};

async function initTauri() {
  setupUpdater({
    prepare: async () => {
      if (!(await confirmDiscard())) return false;
      await persistSettings();
      return true;
    },
    currentFile: () => state.path,
  });
  const win = getCurrentWindow();
  try {
    await setupTauri();
  } catch (e) {
    console.error(e);
  } finally {
    // The window starts hidden (to avoid a white flash); always show it.
    refreshAll();
    await win.show();
    grid.focus();
  }
  try {
    const initial = await invoke<string | null>("initial_file");
    if (initial) await loadPath(initial);
  } catch (e) {
    await alertMsg(String(e));
  }
  // 起動の邪魔をしないよう、少し待ってから新しいバージョンを確認する
  setTimeout(() => void autoCheck({ ...startupSettings, updateCheck }), 3000);
}

async function setupTauri() {
  const win = getCurrentWindow();
  try {
    osLang = await invoke<string>("os_language");
  } catch {
    osLang = null;
  }
  try {
    const s = await invoke<Record<string, unknown>>("load_settings");
    startupSettings = s;
    if (s.updateCheck === false) updateCheck = false;
    // 0.1.8 までの「1行目を固定」（freezeTop）からも引き継ぐ
    if (typeof s.freezeRows === "number" || typeof s.freezeCols === "number") {
      grid.setFreeze(Number(s.freezeRows) || 0, Number(s.freezeCols) || 0, true);
    } else if (s.freezeTop === true) grid.setFreeze(1, 0, true);
    if (typeof s.zoom === "number") grid.setZoom(s.zoom, true);
    if (s.language === "ja" || s.language === "en" || s.language === "auto") langPref = s.language;
  } catch {
    /* defaults */
  }
  applyLanguage();

  await win.onCloseRequested(async (e) => {
    grid.commitEdit();
    if (isDirty()) {
      e.preventDefault();
      if (await confirmDiscard()) {
        await persistSettings();
        await win.destroy();
      }
      return;
    }
    await persistSettings();
  });

  await getCurrentWebview().onDragDropEvent(async (ev) => {
    const p = ev.payload;
    if (p.type === "enter" || p.type === "over") $("drop").hidden = false;
    else if (p.type === "leave") $("drop").hidden = true;
    else if (p.type === "drop") {
      $("drop").hidden = true;
      const [first, ...rest] = p.paths;
      for (const path of rest) void invoke("new_window", { path });
      if (first && (await confirmDiscard())) await loadPath(first);
    }
  });
}

/**
 * Browser preview (npm run dev without Tauri): sample data so the grid can be tried out.
 * `?csv=<url>` loads that CSV instead (used for the website's screenshots).
 */
async function initBrowserPreview() {
  const csvUrl = new URLSearchParams(location.search).get("csv");
  if (csvUrl) {
    try {
      const text = await (await fetch(csvUrl)).text();
      const rows = parseCsv(text, detectDelimiter(text, csvUrl));
      doc.load(rows, Math.max(0, ...rows.map((r) => r.length)));
      state.path = csvUrl.split("/").pop() ?? csvUrl;
      grid.reset();
      refreshAll();
      grid.focus();
      return;
    } catch (e) {
      console.error(e);
    }
  }
  const sample = [
    "社員番号,氏名,部署,入社日,売上,メモ",
    '1001,山田 太郎,営業部,2019/04/01,"1,250,000",',
    "1002,佐藤 花子,総務部,2020/10/15,830000,",
    '1003,鈴木 一郎,営業部,2018/07/01,2140000,"複数行の\nメモです"',
    "1004,高橋 美咲,開発部,2021/01/12,0,",
    '1005,田中 健,営業部,2017/03/21,1730500,"カンマ, を含む値"',
  ];
  for (let i = 1006; i < 1300; i++) sample.push(`${i},社員 ${i},部署${i % 7},2022/0${(i % 9) + 1}/01,${(i * 7919) % 3000000},`);
  const rows = parseCsv(sample.join("\r\n"), ",");
  doc.load(rows, 6);
  state.path = "C:\\sample\\社員一覧.csv";
  recentPreview = [state.path, "D:\\共有\\在庫\\商品マスタ.csv", "C:\\Users\\user\\Documents\\data\\2026\\11月\\売上集計_最終版.csv"];
  grid.reset();
  refreshAll();
  grid.focus();
}

// Browser preview: ?lang=en / ?lang=ja forces a language; otherwise follow the browser.
if (!IN_TAURI) {
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "ja" || q === "en") langPref = q;
}
applyLanguage();

if (IN_TAURI) void initTauri();
else void initBrowserPreview();
