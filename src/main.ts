import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Doc } from "./doc";
import { Grid, colName, isNumeric, parseRef } from "./grid";
import { detectDelimiter, detectNewline, parseCsv, serializeCsv } from "./csv";
import { IN_TAURI, readFile, writeFile } from "./ipc";
import { showAbout } from "./about";
import { alertMsg, ask, hideBusy, isModalOpen, showBusy, showMenu, yieldToPaint, type MenuItem } from "./ui";

const APP = "CSVSSE";
const SAVE_ENCODINGS = ["UTF-8", "UTF-8 BOM", "Shift_JIS", "UTF-16LE"];
const OPEN_ENCODINGS = ["UTF-8", "Shift_JIS", "UTF-16LE", "EUC-JP"];
const DELIMS: { v: string; label: string }[] = [
  { v: ",", label: "カンマ" },
  { v: "\t", label: "タブ" },
  { v: ";", label: "セミコロン" },
];
const NEWLINES: { v: string; label: string }[] = [
  { v: "\r\n", label: "CRLF" },
  { v: "\n", label: "LF" },
  { v: "\r", label: "CR" },
];
const FILE_FILTERS = [
  { name: "CSV / TSV", extensions: ["csv", "tsv", "txt"] },
  { name: "すべてのファイル", extensions: ["*"] },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const encLabel = (e: string) =>
  e === "UTF-8 BOM" ? "UTF-8 (BOM付き)" : e === "UTF-16LE" ? "UTF-16 LE" : e === "UTF-16BE" ? "UTF-16 BE" : e;
const delimLabel = (d: string) => DELIMS.find((x) => x.v === d)?.label ?? JSON.stringify(d);
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
  const name = state.path ? baseName(state.path) : "無題";
  const title = `${isDirty() ? "*" : ""}${name} - ${APP}`;
  document.title = title;
  if (IN_TAURI) void getCurrentWindow().setTitle(title);
}

function updateStatus() {
  $("st-size").textContent = `${doc.rowCount.toLocaleString()} 行 × ${doc.colCount.toLocaleString()} 列`;
  $("st-delim").textContent = delimLabel(state.delimiter);
  $("st-nl").textContent = nlLabel(state.newline);
  $("st-enc").textContent = encLabel(state.encoding);
  $("st-zoom").textContent = grid.zoom === 1 ? "" : `${Math.round(grid.zoom * 100)}%`;
}

function updateButtons() {
  $<HTMLButtonElement>("btn-undo").disabled = !doc.canUndo;
  $<HTMLButtonElement>("btn-redo").disabled = !doc.canRedo;
  $("btn-freeze").setAttribute("aria-pressed", String(grid.freezeTop));
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
  if (cells > 2_000_000) return `${cells.toLocaleString()} セル`;
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
  if (nums) parts.push(`平均: ${fmt(sum / nums)}`);
  parts.push(`データの個数: ${count.toLocaleString()}`);
  if (nums) parts.push(`合計: ${fmt(sum)}`);
  return parts.join("　");
}

// ------------------------------------------------------------------ file operations

async function confirmDiscard(): Promise<boolean> {
  grid.commitEdit();
  if (!isDirty()) return true;
  const name = state.path ? baseName(state.path) : "無題";
  const v = await ask(`「${name}」への変更を保存しますか？`, [
    { label: "保存する", value: "save", primary: true },
    { label: "保存しない", value: "discard" },
    { label: "キャンセル", value: "cancel" },
  ]);
  if (v === "save") return save(false);
  return v === "discard";
}

async function loadPath(path: string, opts: { encoding?: string; delimiter?: string } = {}) {
  showBusy("読み込み中…");
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
    setMessage(`${rows.length.toLocaleString()} 行を読み込みました`);
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
  const p = await openDialog({ multiple: false, directory: false, filters: FILE_FILTERS });
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
    setMessage("ブラウザープレビューでは保存できません");
    return false;
  }
  let path = state.path;
  if (!path || saveAs) {
    const p = await saveDialog({ defaultPath: state.path ?? "新規.csv", filters: FILE_FILTERS });
    if (!p) return false;
    path = p;
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext === "tsv" && state.delimiter !== "\t") state.delimiter = "\t";
    else if (ext === "csv" && state.delimiter === "\t") state.delimiter = ",";
  }
  showBusy("保存中…");
  await yieldToPaint();
  try {
    const text = serializeCsv(doc.rows, doc.colCount, state.delimiter, state.newline, state.trailingNewline);
    let res = await writeFile(path, text, state.encoding, false);
    if (res.unmappable) {
      hideBusy();
      const v = await ask(
        `文字コード「${encLabel(state.encoding)}」では保存できない文字があります。\n\n` +
          `${res.unmappable.join("　")}\n\n` +
          `UTF-8 (BOM付き) で保存すると、文字はそのまま残り Excel でも開けます。`,
        [
          { label: "UTF-8 (BOM付き) で保存", value: "utf8", primary: true },
          { label: "「?」に置き換えて保存", value: "force" },
          { label: "キャンセル", value: "cancel" },
        ],
      );
      if (v === "cancel") return false;
      showBusy("保存中…");
      if (v === "utf8") {
        state.encoding = "UTF-8 BOM";
        res = await writeFile(path, text, state.encoding, false);
      } else res = await writeFile(path, text, state.encoding, true);
    }
    state.path = path;
    state.metaDirty = false;
    doc.markSaved();
    refreshAll();
    setMessage(`保存しました（${encLabel(state.encoding)}）`);
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

async function reopen(opts: { encoding?: string; delimiter?: string }) {
  if (!state.path) return;
  if (isDirty()) {
    const v = await ask("変更内容は失われます。開き直しますか？", [
      { label: "開き直す", value: "ok", primary: true },
      { label: "キャンセル", value: "cancel" },
    ]);
    if (v !== "ok") return;
  }
  await loadPath(state.path, opts);
}

// ------------------------------------------------------------------ menus

function openContextMenu(x: number, y: number) {
  showMenu(
    [
      { label: "切り取り", shortcut: "Ctrl+X", action: () => void grid.copy(true) },
      { label: "コピー", shortcut: "Ctrl+C", action: () => void grid.copy(false) },
      { label: "貼り付け", shortcut: "Ctrl+V", action: () => void grid.paste() },
      { sep: true },
      { label: "上に行を挿入", shortcut: "Ctrl++", action: () => grid.insertRows(false) },
      { label: "下に行を挿入", action: () => grid.insertRows(true) },
      { label: "行を削除", shortcut: "Ctrl+-", action: () => grid.deleteRows() },
      { sep: true },
      { label: "左に列を挿入", action: () => grid.insertCols(false) },
      { label: "右に列を挿入", action: () => grid.insertCols(true) },
      { label: "列を削除", action: () => grid.deleteCols() },
      { sep: true },
      { label: "内容をクリア", shortcut: "Delete", action: () => grid.clear() },
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
    { header: "保存するときの文字コード" },
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
      { header: "文字コードを指定して開き直す" },
      ...OPEN_ENCODINGS.map((enc) => ({ label: encLabel(enc), action: () => void reopen({ encoding: enc }) })),
    );
  }
  statusMenu(e.currentTarget as HTMLElement, items);
});

$("st-delim").addEventListener("click", (e) => {
  const items: MenuItem[] = [
    { header: "保存するときの区切り文字" },
    ...DELIMS.map((d) => ({
      label: d.label,
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
      { header: "区切り文字を指定して開き直す" },
      ...DELIMS.map((d) => ({
        label: d.label,
        action: () => void reopen({ delimiter: d.v, encoding: state.encoding }),
      })),
    );
  }
  statusMenu(e.currentTarget as HTMLElement, items);
});

$("st-nl").addEventListener("click", (e) => {
  statusMenu(e.currentTarget as HTMLElement, [
    { header: "保存するときの改行コード" },
    ...NEWLINES.map((n) => ({
      label: `${n.label}${n.v === "\r\n" ? "（Windows）" : n.v === "\n" ? "（Mac / Linux）" : ""}`,
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
  setMessage(`「${findQ.value}」は見つかりませんでした`);
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
    $("find-count").textContent = n ? `${n.toLocaleString()} 件` : "0 件";
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
  setMessage(n ? `${n.toLocaleString()} 件のセルを置換しました` : "置換する文字列が見つかりませんでした");
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
formula.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && e.altKey) {
    e.preventDefault();
    formula.setRangeText("\n", formula.selectionStart, formula.selectionEnd, "end");
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    commitFormula();
    grid.focus();
    if (e.key === "Enter") grid.move(e.shiftKey ? -1 : 1, 0);
    else grid.move(0, e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    formula.value = doc.get(grid.sel.ar, grid.sel.ac);
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
      setMessage("セル番地は「B12」や「A1:C5」の形で入力してください");
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

function toggleFreeze() {
  grid.setFreeze(!grid.freezeTop);
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
  about: () => void showAbout(),
};

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
    await invoke("save_settings", { settings: { freezeTop: grid.freezeTop, zoom: grid.zoom } });
  } catch {
    /* settings are best-effort */
  }
}

async function initTauri() {
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
}

async function setupTauri() {
  const win = getCurrentWindow();
  try {
    const s = await invoke<Record<string, unknown>>("load_settings");
    if (typeof s.freezeTop === "boolean") grid.setFreeze(s.freezeTop);
    if (typeof s.zoom === "number") grid.setZoom(s.zoom, true);
  } catch {
    /* defaults */
  }

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

/** Browser preview (npm run dev without Tauri): sample data so the grid can be tried out. */
function initBrowserPreview() {
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
  grid.reset();
  refreshAll();
  grid.focus();
}

if (IN_TAURI) void initTauri();
else initBrowserPreview();
