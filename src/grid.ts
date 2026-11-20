// Canvas-rendered, virtualized spreadsheet grid with Excel-style keyboard and mouse handling.

import type { Doc, HistoryResult, Rect } from "./doc";
import { parseCsv, toTsv } from "./csv";
import { fillSeries } from "./fill";
import { L } from "./i18n";

const MAX_SCROLL_PX = 8_000_000; // browsers cap element height; beyond this we scale scrolling
const EXTRA_ROWS = 100;
const EXTRA_COLS = 26;
const DEFAULT_COL_W = 96;
const MAX_ROW = 9_999_999;
const MAX_COL = 16_383;
const MAX_CELLS = 5_000_000; // copy / fill / paste-tile limit
const PREVIEW_CELLS = 200_000; // fill-handle drag preview limit
const FONT_FAMILY = '"Segoe UI", "Yu Gothic UI", "Meiryo UI", sans-serif';

const NUM_RE = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?%?$/;
const HAS_DIGIT = /\d/;

export function isNumeric(v: string): boolean {
  return v.length < 32 && HAS_DIGIT.test(v) && NUM_RE.test(v);
}

export function colName(c: number): string {
  let s = "";
  c += 1;
  while (c > 0) {
    const m = (c - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}

function colIndex(s: string): number {
  let n = 0;
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Parses "B12", "A1:C5" or a bare row number. */
export function parseRef(s: string, curCol: number): Rect | null {
  const row = /^\s*(\d{1,8})\s*$/.exec(s);
  if (row) {
    const r = +row[1] - 1;
    return r >= 0 ? { r0: r, c0: curCol, r1: r, c1: curCol } : null;
  }
  const m = /^\s*([A-Za-z]{1,3})(\d{1,8})\s*(?::\s*([A-Za-z]{1,3})(\d{1,8}))?\s*$/.exec(s);
  if (!m) return null;
  const c0 = colIndex(m[1]);
  const r0 = +m[2] - 1;
  if (r0 < 0 || c0 > MAX_COL) return null;
  if (!m[3]) return { r0, c0, r1: r0, c1: c0 };
  const c1 = colIndex(m[3]);
  const r1 = +m[4] - 1;
  if (r1 < 0 || c1 > MAX_COL) return null;
  return { r0, c0, r1, c1 };
}

export interface GridCallbacks {
  changed(): void;
  selectionChanged(): void;
  editing(text: string): void;
  contextMenu(x: number, y: number): void;
  writeClipboard(text: string): Promise<void>;
  readClipboard(): Promise<string>;
  zoomChanged(zoom: number): void;
  message(text: string): void;
}

interface Theme {
  bg: string;
  text: string;
  line: string;
  hdrBg: string;
  hdrText: string;
  hdrLine: string;
  hdrSelBg: string;
  accent: string;
  accentText: string;
  selFill: string;
  freezeLine: string;
  changedFill: string;
}

type Mode = "nav" | "enter" | "edit";
type HitKind = "corner" | "col" | "row" | "cell";
type DragKind = HitKind | "fill";
type FillDir = "down" | "up" | "right" | "left";
interface Hit {
  kind: HitKind;
  r: number;
  c: number;
}
interface View {
  sx: number;
  sy: number;
  cA: number;
  cB: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export class Grid {
  readonly editor: HTMLTextAreaElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scroller: HTMLDivElement;
  private spacer: HTMLDivElement;
  private theme!: Theme;

  zoom = 1;
  freezeTop = false;
  mode: Mode = "nav";
  /** active cell (ar, ac), anchor (anR, anC), moving corner (fR, fC) */
  sel = { ar: 0, ac: 0, anR: 0, anC: 0, fR: 0, fC: 0, allRows: false, allCols: false };

  private baseW: (number | undefined)[] = [];
  private wVersion = 0;
  private xs: number[] = [0];
  private xsKey = "";
  private reachR = 0;
  private reachC = 0;
  private W = 0;
  private H = 0;
  private dpr = 1;
  private rowHdrW = 44;
  private spacerKey = "";
  private queued = false;
  private copyRect: Rect | null = null;
  private drag: DragKind | null = null;
  /** Fill-handle drag in progress: source range and the cells it will fill. */
  private fill: {
    src: Rect;
    target: Rect | null;
    dir: FillDir;
    ctrl: boolean;
    /** Values that will be written into `target` (null when too large to preview). */
    preview: string[][] | null;
  } | null = null;
  private fillTip: HTMLDivElement;
  private resizing: { c: number; startX: number; startW: number } | null = null;
  private mouse = { x: 0, y: 0 };
  private autoTimer = 0;
  private composing = false;

  constructor(
    host: HTMLElement,
    public doc: Doc,
    private cb: GridCallbacks,
  ) {
    host.classList.add("grid-host");
    this.canvas = document.createElement("canvas");
    this.canvas.className = "grid-canvas";
    this.scroller = document.createElement("div");
    this.scroller.className = "grid-scroller";
    this.spacer = document.createElement("div");
    this.spacer.className = "grid-spacer";
    this.scroller.append(this.spacer);
    this.editor = document.createElement("textarea");
    this.editor.className = "grid-editor ghost";
    this.editor.spellcheck = false;
    this.editor.wrap = "off";
    this.editor.setAttribute("autocomplete", "off");
    this.editor.setAttribute("aria-label", L().editCellAria);
    this.fillTip = document.createElement("div");
    this.fillTip.className = "fill-tip";
    this.fillTip.hidden = true;
    host.append(this.canvas, this.scroller, this.editor, this.fillTip);
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;

    this.readTheme();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.readTheme();
      this.render();
    });
    new ResizeObserver(() => this.layout()).observe(host);
    window.addEventListener("resize", () => this.layout());

    this.scroller.addEventListener("scroll", () => {
      this.positionEditor();
      this.render();
    });
    this.scroller.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.scroller.addEventListener("mousemove", (e) => this.onHover(e));
    this.scroller.addEventListener("dblclick", (e) => this.onDblClick(e));
    this.scroller.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const { x, y } = this.local(e);
      if (x < this.W && y < this.H) this.cb.contextMenu(e.clientX, e.clientY);
    });
    this.scroller.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      },
      { passive: false },
    );

    const ed = this.editor;
    ed.addEventListener("keydown", (e) => this.onKeyDown(e));
    ed.addEventListener("input", () => this.onInput());
    ed.addEventListener("compositionstart", () => {
      this.composing = true;
      if (this.mode === "nav") this.beginEdit("enter");
    });
    ed.addEventListener("compositionend", () => {
      this.composing = false;
      this.autosizeEditor();
    });
    ed.addEventListener("blur", () => {
      if (this.mode !== "nav" && document.hasFocus()) this.commitEdit();
    });
    this.layout();
  }

  // ------------------------------------------------------------ metrics

  private get rowH() {
    return Math.round(24 * this.zoom);
  }
  private get hdrH() {
    return Math.round(24 * this.zoom);
  }
  private get fontPx() {
    return 13 * this.zoom;
  }
  private font(weight = 400) {
    return `${weight} ${this.fontPx}px ${FONT_FAMILY}`;
  }
  private get s0() {
    return this.freezeTop ? 1 : 0;
  }
  private get top() {
    return this.hdrH + (this.freezeTop ? this.rowH : 0);
  }
  private get dispRows() {
    return Math.max(this.doc.rowCount, this.reachR + 1) + EXTRA_ROWS;
  }
  private get dispCols() {
    return Math.max(this.doc.colCount, this.reachC + 1) + EXTRA_COLS;
  }
  private colW(c: number) {
    return Math.round((this.baseW[c] ?? DEFAULT_COL_W) * this.zoom);
  }
  private get lw() {
    return Math.max(1, Math.round(this.dpr)) / this.dpr;
  }
  private snap(v: number) {
    return Math.round(v * this.dpr) / this.dpr;
  }

  private ensureXs() {
    const n = this.dispCols;
    const key = `${n}:${this.zoom}:${this.wVersion}`;
    if (key === this.xsKey) return;
    this.xsKey = key;
    const xs = new Array<number>(n + 1);
    xs[0] = 0;
    for (let c = 0; c < n; c++) xs[c + 1] = xs[c] + this.colW(c);
    this.xs = xs;
  }

  private colAt(x: number): number {
    const xs = this.xs;
    if (x <= 0) return 0;
    let lo = 0;
    let hi = xs.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private realH() {
    return this.top + (this.dispRows - this.s0) * this.rowH;
  }
  private get scaled() {
    return this.realH() > MAX_SCROLL_PX;
  }

  /** Logical vertical scroll offset of the scrollable rows (in px at the current zoom). */
  private scrollY(): number {
    const st = this.scroller.scrollTop;
    if (!this.scaled) return st;
    const maxSt = this.scroller.scrollHeight - this.scroller.clientHeight;
    const realMax = this.realH() - this.scroller.clientHeight;
    return maxSt > 0 ? (st / maxSt) * realMax : 0;
  }

  private setScrollY(y: number) {
    const realMax = Math.max(0, this.realH() - this.H);
    y = clamp(y, 0, realMax);
    if (!this.scaled) {
      this.scroller.scrollTop = y;
      return;
    }
    const maxSt = this.scroller.scrollHeight - this.scroller.clientHeight;
    this.scroller.scrollTop = realMax > 0 ? (y / realMax) * maxSt : 0;
  }

  private updateSpacer() {
    this.ensureXs();
    this.ctx.font = this.font();
    const digits = String(this.dispRows).length;
    this.rowHdrW = Math.max(
      Math.round(40 * this.zoom),
      Math.ceil(this.ctx.measureText("0".repeat(digits)).width + 18 * this.zoom),
    );
    const w = this.rowHdrW + this.xs[this.xs.length - 1];
    const h = Math.min(this.realH(), MAX_SCROLL_PX);
    const key = `${w}x${h}`;
    if (key !== this.spacerKey) {
      this.spacerKey = key;
      this.spacer.style.width = `${w}px`;
      this.spacer.style.height = `${h}px`;
    }
  }

  private rowY(r: number, frozen: boolean, sy: number) {
    return frozen ? this.hdrH + r * this.rowH : this.top + (r - this.s0) * this.rowH - sy;
  }
  private colX(c: number, sx: number) {
    return this.rowHdrW + this.xs[Math.min(c, this.xs.length - 1)] - sx;
  }

  // ------------------------------------------------------------ public API

  focus() {
    this.editor.focus({ preventScroll: true });
  }

  layout() {
    this.dpr = window.devicePixelRatio || 1;
    this.updateSpacer();
    this.W = this.scroller.clientWidth;
    this.H = this.scroller.clientHeight;
    const cw = Math.round(this.W * this.dpr);
    const ch = Math.round(this.H * this.dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
      this.canvas.style.width = `${this.W}px`;
      this.canvas.style.height = `${this.H}px`;
    }
    this.positionEditor();
    this.draw();
  }

  render() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => this.draw());
  }

  readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    this.theme = {
      bg: v("--cell-bg"),
      text: v("--cell-text"),
      line: v("--cell-line"),
      hdrBg: v("--hdr-bg"),
      hdrText: v("--hdr-text"),
      hdrLine: v("--hdr-line"),
      hdrSelBg: v("--hdr-sel-bg"),
      accent: v("--accent"),
      accentText: v("--accent-text"),
      selFill: v("--sel-fill"),
      freezeLine: v("--freeze-line"),
      changedFill: v("--changed-fill"),
    };
  }

  /** Call after loading a new document. */
  reset() {
    this.mode = "nav";
    this.editor.value = "";
    this.editor.classList.add("ghost");
    this.sel = { ar: 0, ac: 0, anR: 0, anC: 0, fR: 0, fC: 0, allRows: false, allCols: false };
    this.reachR = 0;
    this.reachC = 0;
    this.copyRect = null;
    this.autoFitAll();
    this.spacerKey = "";
    this.updateSpacer();
    this.scroller.scrollTop = 0;
    this.scroller.scrollLeft = 0;
    this.layout();
    this.cb.selectionChanged();
  }

  setFreeze(on: boolean) {
    this.freezeTop = on;
    this.spacerKey = "";
    this.layout();
  }

  setZoom(z: number, silent = false) {
    z = Math.round(clamp(z, 0.5, 3) * 100) / 100;
    if (z === this.zoom) return;
    const topRow = this.s0 + Math.floor(this.scrollY() / this.rowH);
    const leftCol = this.colAt(this.scroller.scrollLeft);
    this.zoom = z;
    this.spacerKey = "";
    this.updateSpacer();
    this.setScrollY((topRow - this.s0) * this.rowH);
    this.scroller.scrollLeft = this.xs[leftCol];
    this.layout();
    if (!silent) this.cb.zoomChanged(z);
  }

  /** Selection rectangle clipped to the data area when whole rows/columns are selected. */
  selRect(): Rect {
    const s = this.sel;
    let r0 = Math.min(s.anR, s.fR);
    let r1 = Math.max(s.anR, s.fR);
    let c0 = Math.min(s.anC, s.fC);
    let c1 = Math.max(s.anC, s.fC);
    if (s.allRows) {
      r0 = 0;
      r1 = Math.max(this.doc.rowCount, 1) - 1;
    }
    if (s.allCols) {
      c0 = 0;
      c1 = Math.max(this.doc.colCount, 1) - 1;
    }
    return { r0, c0, r1, c1 };
  }

  select(r0: number, c0: number, r1 = r0, c1 = c0, whole?: "rows" | "cols") {
    const s = this.sel;
    s.ar = s.anR = r0;
    s.ac = s.anC = c0;
    s.fR = r1;
    s.fC = c1;
    s.allCols = whole === "rows";
    s.allRows = whole === "cols";
    this.touch();
    this.scrollIntoView(r0, c0);
    this.positionEditor();
    this.render();
    this.cb.selectionChanged();
  }

  selectAll() {
    const s = this.sel;
    s.allRows = s.allCols = true;
    s.anR = s.fR = s.ar = 0;
    s.anC = s.fC = s.ac = 0;
    this.positionEditor();
    this.render();
    this.cb.selectionChanged();
  }

  setCellValue(r: number, c: number, v: string) {
    if (this.doc.setCells(r, c, [[v]])) this.cb.changed();
    this.render();
  }

  // ------------------------------------------------------------ drawing

  private draw() {
    this.queued = false;
    this.updateSpacer();
    const { ctx, W, H, dpr, theme: t } = this;
    if (W <= 0 || H <= 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, W, H);

    const rh = this.rowH;
    const hh = this.hdrH;
    const rw = this.rowHdrW;
    const top = this.top;
    const sx = this.scroller.scrollLeft;
    const sy = this.scrollY();
    const xs = this.xs;
    const nCols = xs.length - 1;
    const nRows = this.dispRows;

    const cA = this.colAt(sx);
    let cB = cA;
    while (cB + 1 < nCols && xs[cB + 1] - sx < W - rw) cB++;
    const rA = Math.min(nRows - 1, this.s0 + Math.floor(sy / rh));
    let rB = rA;
    while (rB + 1 < nRows && this.rowY(rB + 1, false, sy) < H) rB++;

    const v: View = { sx, sy, cA, cB };
    this.drawBody(v, false, top, H, rA, rB);
    if (this.freezeTop) this.drawBody(v, true, hh, top, 0, 0);
    this.drawFillHandle();
    this.drawColHeader(v);
    this.drawRowHeader(v, false, top, H, rA, rB);
    if (this.freezeTop) {
      this.drawRowHeader(v, true, hh, top, 0, 0);
      ctx.fillStyle = t.freezeLine;
      ctx.fillRect(0, this.snap(top) - this.lw, W, this.lw * 2);
    }

    // Corner (select all)
    const lw = this.lw;
    ctx.fillStyle = t.hdrBg;
    ctx.fillRect(0, 0, rw, hh);
    ctx.fillStyle = t.hdrLine;
    ctx.fillRect(this.snap(rw) - lw, 0, lw, hh);
    ctx.fillRect(0, this.snap(hh) - lw, rw, lw);
    const z = this.zoom;
    ctx.beginPath();
    ctx.moveTo(rw - 4 * z, hh - 4 * z - 10 * z);
    ctx.lineTo(rw - 4 * z, hh - 4 * z);
    ctx.lineTo(rw - 4 * z - 10 * z, hh - 4 * z);
    ctx.closePath();
    ctx.fill();
  }

  private drawBody(v: View, frozen: boolean, y0: number, y1: number, rA: number, rB: number) {
    const { ctx, theme: t, W } = this;
    const rw = this.rowHdrW;
    const rh = this.rowH;
    if (y1 <= y0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rw, y0, W - rw, y1 - y0);
    ctx.clip();

    const s = this.sel;
    const R = this.selRect();
    const r1 = s.allRows ? this.dispRows - 1 : R.r1;
    const c1 = s.allCols ? this.xs.length - 2 : R.c1;
    const px0 = this.colX(R.c0, v.sx);
    const px1 = this.colX(c1 + 1, v.sx);
    const py0 = this.rowY(R.r0, frozen, v.sy);
    const py1 = this.rowY(r1 + 1, frozen, v.sy);
    // 最後に開いた／保存した時点から変わったセルの背景
    ctx.fillStyle = t.changedFill;
    for (let r = rA; r <= rB; r++) {
      if (!this.doc.rows[r]) continue;
      for (let c = v.cA; c <= v.cB; c++) {
        if (this.doc.isChanged(r, c)) {
          ctx.fillRect(this.colX(c, v.sx), this.rowY(r, frozen, v.sy), this.colW(c), rh);
        }
      }
    }

    const multi = R.r0 !== r1 || R.c0 !== c1;
    if (multi) {
      ctx.fillStyle = t.selFill;
      ctx.fillRect(px0, py0, px1 - px0, py1 - py0);
      // アクティブセルは選択の色を付けない（変更セルならその色に戻す）
      const ax = this.colX(s.ac, v.sx);
      const ay = this.rowY(s.ar, frozen, v.sy);
      ctx.fillStyle = t.bg;
      ctx.fillRect(ax, ay, this.colW(s.ac), rh);
      if (this.doc.isChanged(s.ar, s.ac)) {
        ctx.fillStyle = t.changedFill;
        ctx.fillRect(ax, ay, this.colW(s.ac), rh);
      }
    }

    // Grid lines
    const lw = this.lw;
    ctx.fillStyle = t.line;
    for (let c = v.cA; c <= v.cB; c++) {
      ctx.fillRect(this.snap(this.colX(c + 1, v.sx)) - lw, y0, lw, y1 - y0);
    }
    for (let r = rA; r <= rB; r++) {
      ctx.fillRect(rw, this.snap(this.rowY(r + 1, frozen, v.sy)) - lw, W - rw, lw);
    }

    // Fill-handle drag: tint the cells that will be filled and show their future values.
    const P = this.fill?.target && this.fill.preview ? this.fill : null;
    const PT = P?.target;
    if (PT) {
      ctx.fillStyle = t.selFill;
      const x0 = this.colX(PT.c0, v.sx);
      const yA = this.rowY(PT.r0, frozen, v.sy);
      ctx.fillRect(x0, yA, this.colX(PT.c1 + 1, v.sx) - x0, this.rowY(PT.r1 + 1, frozen, v.sy) - yA);
    }

    // Text
    ctx.font = this.font();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = t.text;
    const pad = Math.round(5 * this.zoom);
    const minChar = this.fontPx * 0.28;
    for (let r = rA; r <= rB; r++) {
      const row = this.doc.rows[r];
      const inT = !!PT && r >= PT.r0 && r <= PT.r1;
      if (!row && !inT) continue;
      const y = this.rowY(r, frozen, v.sy);
      const ty = y + rh / 2 + 1;
      for (let c = v.cA; c <= v.cB; c++) {
        const isPreview = inT && c >= PT!.c0 && c <= PT!.c1;
        let str = isPreview ? P!.preview![r - PT!.r0][c - PT!.c0] : row?.[c];
        if (!str) continue;
        ctx.fillStyle = isPreview ? t.accent : t.text;
        const x = this.colX(c, v.sx);
        const w = this.colW(c);
        const avail = w - pad * 2;
        if (avail <= 0) continue;
        const maxChars = Math.ceil(avail / minChar) + 2;
        if (str.length > maxChars) str = str.slice(0, maxChars);
        if (str.indexOf("\n") >= 0 || str.indexOf("\r") >= 0) str = str.replace(/\r\n|\r|\n/g, " ↵ ");
        const clip = str.length * minChar > avail && ctx.measureText(str).width > avail;
        if (clip) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x + 1, y, w - 2, rh);
          ctx.clip();
          ctx.fillText(str, x + pad, ty);
          ctx.restore();
        } else if (isNumeric(str)) {
          ctx.textAlign = "right";
          ctx.fillText(str, x + w - pad, ty);
          ctx.textAlign = "left";
        } else {
          ctx.fillText(str, x + pad, ty);
        }
      }
    }

    // Copy marquee
    if (this.copyRect) {
      const C = this.copyRect;
      const x0 = this.colX(C.c0, v.sx);
      const x1 = this.colX(C.c1 + 1, v.sx);
      const yA = this.rowY(C.r0, frozen, v.sy);
      const yB = this.rowY(C.r1 + 1, frozen, v.sy);
      ctx.setLineDash([5, 3]);
      ctx.strokeStyle = t.accent;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 + 1, yA + 1, x1 - x0 - 3, yB - yA - 3);
      ctx.setLineDash([]);
    }

    // Selection border
    ctx.strokeStyle = t.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(this.snap(px0), this.snap(py0), this.snap(px1 - px0) - 1, this.snap(py1 - py0) - 1);

    // Fill-handle drag preview: dashed outline of source + cells to be filled
    if (this.fill?.target) {
      const S = this.fill.src;
      const T = this.fill.target;
      const x0 = this.colX(Math.min(S.c0, T.c0), v.sx);
      const x1 = this.colX(Math.max(S.c1, T.c1) + 1, v.sx);
      const yA = this.rowY(Math.min(S.r0, T.r0), frozen, v.sy);
      const yB = this.rowY(Math.max(S.r1, T.r1) + 1, frozen, v.sy);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = t.hdrText;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 + 1, yA + 1, x1 - x0 - 3, yB - yA - 3);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  /** Bottom-right corner of the selection, where the fill handle sits (null if hidden). */
  private handlePos(): { x: number; y: number; frozen: boolean } | null {
    const s = this.sel;
    if (s.allRows || s.allCols || this.mode !== "nav") return null;
    const R = this.selRect();
    const frozen = this.freezeTop && R.r1 === 0;
    const x = this.colX(R.c1 + 1, this.scroller.scrollLeft) - 1;
    const y = this.rowY(R.r1 + 1, frozen, this.scrollY()) - 1;
    const minY = frozen ? this.hdrH : this.top;
    if (x < this.rowHdrW || x > this.W + 4 || y < minY || y > this.H + 4) return null;
    return { x, y, frozen };
  }

  private drawFillHandle() {
    const p = this.handlePos();
    if (!p) return;
    const { ctx, theme: t } = this;
    const z = Math.max(1, this.zoom);
    ctx.save();
    ctx.beginPath();
    if (p.frozen) ctx.rect(this.rowHdrW, this.hdrH, this.W - this.rowHdrW, this.rowH);
    else ctx.rect(this.rowHdrW, this.top, this.W - this.rowHdrW, this.H - this.top);
    ctx.clip();
    const outer = 8 * z;
    const inner = 6 * z;
    ctx.fillStyle = t.bg;
    ctx.fillRect(this.snap(p.x - outer / 2), this.snap(p.y - outer / 2), outer, outer);
    ctx.fillStyle = t.accent;
    ctx.fillRect(this.snap(p.x - inner / 2), this.snap(p.y - inner / 2), inner, inner);
    ctx.restore();
  }

  private onFillHandle(x: number, y: number): boolean {
    const p = this.handlePos();
    const r = 5 * Math.max(1, this.zoom);
    return !!p && Math.abs(x - p.x) <= r && Math.abs(y - p.y) <= r;
  }

  private drawColHeader(v: View) {
    const { ctx, theme: t, W } = this;
    const rw = this.rowHdrW;
    const hh = this.hdrH;
    const lw = this.lw;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rw, 0, W - rw, hh);
    ctx.clip();
    ctx.fillStyle = t.hdrBg;
    ctx.fillRect(rw, 0, W - rw, hh);
    ctx.fillStyle = t.hdrLine;
    ctx.fillRect(rw, this.snap(hh) - lw, W - rw, lw);
    const s = this.sel;
    const R = this.selRect();
    const c1 = s.allCols ? Infinity : R.c1;
    ctx.font = this.font();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let c = v.cA; c <= v.cB; c++) {
      const x = this.colX(c, v.sx);
      const w = this.colW(c);
      const inSel = c >= R.c0 && c <= c1;
      if (inSel) {
        if (s.allRows) {
          ctx.fillStyle = t.accent;
          ctx.fillRect(x, 0, w, hh);
        } else {
          ctx.fillStyle = t.hdrSelBg;
          ctx.fillRect(x, 0, w, hh);
          ctx.fillStyle = t.accent;
          ctx.fillRect(x, hh - 2, w, 2);
        }
      }
      ctx.fillStyle = inSel ? (s.allRows ? t.accentText : t.accent) : t.hdrText;
      ctx.fillText(colName(c), x + w / 2, hh / 2 + 1);
      ctx.fillStyle = t.hdrLine;
      ctx.fillRect(this.snap(x + w) - lw, 0, lw, hh);
    }
    ctx.restore();
  }

  private drawRowHeader(v: View, frozen: boolean, y0: number, y1: number, rA: number, rB: number) {
    const { ctx, theme: t } = this;
    const rw = this.rowHdrW;
    const rh = this.rowH;
    const lw = this.lw;
    if (y1 <= y0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y0, rw, y1 - y0);
    ctx.clip();
    ctx.fillStyle = t.hdrBg;
    ctx.fillRect(0, y0, rw, y1 - y0);
    ctx.fillStyle = t.hdrLine;
    ctx.fillRect(this.snap(rw) - lw, y0, lw, y1 - y0);
    const s = this.sel;
    const R = this.selRect();
    const r1 = s.allRows ? Infinity : R.r1;
    ctx.font = this.font();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let r = rA; r <= rB; r++) {
      const y = this.rowY(r, frozen, v.sy);
      const inSel = r >= R.r0 && r <= r1;
      if (inSel) {
        if (s.allCols) {
          ctx.fillStyle = t.accent;
          ctx.fillRect(0, y, rw, rh);
        } else {
          ctx.fillStyle = t.hdrSelBg;
          ctx.fillRect(0, y, rw, rh);
          ctx.fillStyle = t.accent;
          ctx.fillRect(rw - 2, y, 2, rh);
        }
      }
      ctx.fillStyle = inSel ? (s.allCols ? t.accentText : t.accent) : t.hdrText;
      ctx.fillText(String(r + 1), rw / 2, y + rh / 2 + 1);
      ctx.fillStyle = t.hdrLine;
      ctx.fillRect(0, this.snap(y + rh) - lw, rw, lw);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ mouse

  private local(e: MouseEvent) {
    const b = this.scroller.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  private hit(x: number, y: number): Hit {
    const hh = this.hdrH;
    const rw = this.rowHdrW;
    const c = this.colAt(x - rw + this.scroller.scrollLeft);
    let r: number;
    if (y < hh) r = 0;
    else if (this.freezeTop && y < this.top) r = 0;
    else r = this.s0 + Math.floor((y - this.top + this.scrollY()) / this.rowH);
    r = clamp(r, 0, this.dispRows - 1);
    const kind: HitKind = y < hh ? (x < rw ? "corner" : "col") : x < rw ? "row" : "cell";
    return { kind, r, c };
  }

  /** Column whose right border is under the pointer in the header, or -1. */
  private resizeHit(x: number, y: number): number {
    if (y >= this.hdrH || x < this.rowHdrW) return -1;
    const dataX = x - this.rowHdrW + this.scroller.scrollLeft;
    const c = this.colAt(dataX);
    if (this.xs[c + 1] - dataX <= 4) return c;
    if (dataX - this.xs[c] <= 4 && c > 0) return c - 1;
    return -1;
  }

  private firstVisibleRow() {
    return this.s0 + Math.floor(this.scrollY() / this.rowH);
  }

  private onMouseDown(e: MouseEvent) {
    const { x, y } = this.local(e);
    if (x >= this.W || y >= this.H) {
      // Scrollbar: keep keyboard focus on the grid.
      requestAnimationFrame(() => this.focus());
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    this.focus();
    if (this.mode !== "nav") this.commitEdit();
    const h = this.hit(x, y);

    if (e.button === 2) {
      const s = this.sel;
      const R = this.selRect();
      const r1 = s.allRows ? Infinity : R.r1;
      const c1 = s.allCols ? Infinity : R.c1;
      const inside =
        h.kind === "corner" ||
        (h.kind === "cell" && h.r >= R.r0 && h.r <= r1 && h.c >= R.c0 && h.c <= c1) ||
        (h.kind === "col" && s.allRows && h.c >= R.c0 && h.c <= c1) ||
        (h.kind === "row" && s.allCols && h.r >= R.r0 && h.r <= r1);
      if (!inside) this.selectByHit(h, false);
      return;
    }

    const rc = this.resizeHit(x, y);
    if (this.onFillHandle(x, y)) {
      this.copyRect = null;
      this.fill = { src: this.selRect(), target: null, dir: "down", ctrl: e.ctrlKey, preview: null };
      this.drag = "fill";
      this.mouse = { x, y };
      this.autoTimer = window.setInterval(() => this.autoScroll(), 40);
      window.addEventListener("keydown", this.onFillKey, true);
      window.addEventListener("keyup", this.onFillKey, true);
    } else if (rc >= 0) {
      this.resizing = { c: rc, startX: x, startW: this.baseW[rc] ?? DEFAULT_COL_W };
    } else {
      this.selectByHit(h, e.shiftKey);
      if (h.kind === "corner") return;
      this.drag = h.kind;
      this.mouse = { x, y };
      this.autoTimer = window.setInterval(() => this.autoScroll(), 40);
    }
    window.addEventListener("mousemove", this.onWinMove);
    window.addEventListener("mouseup", this.onWinUp);
  }

  private onWinMove = (e: MouseEvent) => {
    this.mouse = this.local(e);
    if (this.fill) this.fill.ctrl = e.ctrlKey;
    if (this.resizing) {
      const R = this.resizing;
      this.baseW[R.c] = Math.max(16, R.startW + (this.mouse.x - R.startX) / this.zoom);
      this.wVersion++;
      this.positionEditor();
      this.render();
      return;
    }
    if (this.drag) this.updateDrag();
  };

  private onWinUp = (e: MouseEvent) => {
    const F = this.drag === "fill" ? this.fill : null;
    this.endDrag();
    // Ctrl switches between copy and series (see fillSeries).
    if (F?.target) this.applyFill(F.src, F.target, F.dir, e.ctrlKey);
  };

  private endDrag() {
    this.drag = null;
    this.resizing = null;
    this.fill = null;
    this.fillTip.hidden = true;
    clearInterval(this.autoTimer);
    window.removeEventListener("mousemove", this.onWinMove);
    window.removeEventListener("mouseup", this.onWinUp);
    window.removeEventListener("keydown", this.onFillKey, true);
    window.removeEventListener("keyup", this.onFillKey, true);
    this.render();
  }

  /** While dragging the fill handle: Ctrl switches copy/series immediately, Esc cancels. */
  private onFillKey = (e: KeyboardEvent) => {
    if (!this.fill) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.endDrag();
      return;
    }
    if (e.key === "Control") {
      e.preventDefault();
      if (this.fill.ctrl !== e.ctrlKey) {
        this.fill.ctrl = e.ctrlKey;
        this.refreshFillPreview();
      }
    }
  };

  private selectByHit(h: Hit, shift: boolean) {
    const s = this.sel;
    switch (h.kind) {
      case "corner":
        this.selectAll();
        return;
      case "col":
        if (shift) s.fC = h.c;
        else {
          const r = this.firstVisibleRow();
          s.ar = s.anR = s.fR = r;
          s.ac = s.anC = s.fC = h.c;
        }
        s.allRows = true;
        s.allCols = false;
        break;
      case "row":
        if (shift) s.fR = h.r;
        else {
          const c = this.colAt(this.scroller.scrollLeft);
          s.ar = s.anR = s.fR = h.r;
          s.ac = s.anC = s.fC = c;
        }
        s.allCols = true;
        s.allRows = false;
        break;
      case "cell":
        if (shift) {
          s.fR = h.r;
          s.fC = h.c;
        } else this.setActiveRaw(h.r, h.c);
        break;
    }
    this.touch();
    this.positionEditor();
    this.render();
    this.cb.selectionChanged();
  }

  private updateDrag() {
    const { x, y } = this.mouse;
    const s = this.sel;
    const cx = clamp(x, this.rowHdrW, this.W - 1);
    const cy = clamp(y, this.freezeTop ? this.hdrH : this.top, this.H - 1);
    const h = this.hit(cx, cy);
    if (this.drag === "fill") {
      this.updateFill(h.r, h.c);
      return;
    }
    if (this.drag === "cell") {
      s.fR = h.r;
      s.fC = h.c;
    } else if (this.drag === "col") s.fC = h.c;
    else if (this.drag === "row") s.fR = h.r;
    this.touch();
    this.render();
    this.cb.selectionChanged();
  }

  private updateFill(r: number, c: number) {
    const F = this.fill;
    if (!F) return;
    const S = F.src;
    const dr = r > S.r1 ? r - S.r1 : r < S.r0 ? r - S.r0 : 0;
    const dc = c > S.c1 ? c - S.c1 : c < S.c0 ? c - S.c0 : 0;
    if (!dr && !dc) F.target = null;
    else if (Math.abs(dr) >= Math.abs(dc)) {
      F.dir = dr > 0 ? "down" : "up";
      F.target = dr > 0 ? { r0: S.r1 + 1, r1: r, c0: S.c0, c1: S.c1 } : { r0: r, r1: S.r0 - 1, c0: S.c0, c1: S.c1 };
    } else {
      F.dir = dc > 0 ? "right" : "left";
      F.target = dc > 0 ? { r0: S.r0, r1: S.r1, c0: S.c1 + 1, c1: c } : { r0: S.r0, r1: S.r1, c0: c, c1: S.c0 - 1 };
    }
    if (F.target) {
      // Let the grid grow while dragging past the last row/column.
      this.reachR = Math.max(this.reachR, F.target.r1);
      this.reachC = Math.max(this.reachC, F.target.c1);
      this.updateSpacer();
    }
    this.refreshFillPreview();
  }

  /** Recomputes the values shown in the cells being filled, and the tooltip next to the pointer. */
  private refreshFillPreview() {
    const F = this.fill;
    if (!F) return;
    const T = F.target;
    F.preview = T && (T.r1 - T.r0 + 1) * (T.c1 - T.c0 + 1) <= PREVIEW_CELLS ? this.computeFill(F.src, T, F.dir, F.ctrl) : null;
    const tip = this.fillTip;
    if (!T) {
      tip.hidden = true;
      this.render();
      return;
    }
    // Excel-style tooltip: the value that will land in the farthest cell.
    const last = F.preview
      ? F.dir === "down"
        ? F.preview[F.preview.length - 1][0]
        : F.dir === "right"
          ? F.preview[0][F.preview[0].length - 1]
          : F.preview[0][0]
      : "";
    // Does holding/releasing Ctrl change anything for this source?
    const S = F.src;
    const vertical = F.dir === "down" || F.dir === "up";
    const src: string[] = [];
    if (vertical) for (let r = S.r0; r <= S.r1; r++) src.push(this.doc.get(r, S.c0));
    else for (let c = S.c0; c <= S.c1; c++) src.push(this.doc.get(S.r0, c));
    const now = fillSeries(src, 1, false, F.ctrl)[0];
    const other = fillSeries(src, 1, false, !F.ctrl)[0];
    const series = now !== src[0];
    const t = L();
    const mode = series ? t.fillSeries : t.fillCopy;
    const hint = now !== other ? t.fillSwitch(series ? t.fillCopy : t.fillSeries) : "";
    tip.replaceChildren();
    const v = document.createElement("b");
    v.textContent = last === "" ? t.blank : last;
    const m = document.createElement("small");
    m.textContent = `${mode}${hint}`;
    tip.append(v, m);
    tip.hidden = false;
    const x = Math.min(this.mouse.x + 16, this.W - tip.offsetWidth - 4);
    const y = this.mouse.y + 20 + tip.offsetHeight > this.H ? this.mouse.y - tip.offsetHeight - 8 : this.mouse.y + 20;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
    this.render();
  }

  /** Values for the target range `T` when filling from `S`. */
  private computeFill(S: Rect, T: Rect, dir: FillDir, ctrl: boolean): string[][] {
    const th = T.r1 - T.r0 + 1;
    const tw = T.c1 - T.c0 + 1;
    const vals: string[][] = [];
    for (let i = 0; i < th; i++) vals.push(new Array<string>(tw));
    if (dir === "down" || dir === "up") {
      for (let j = 0; j < tw; j++) {
        const src: string[] = [];
        for (let r = S.r0; r <= S.r1; r++) src.push(this.doc.get(r, S.c0 + j));
        const out = fillSeries(src, th, dir === "up", ctrl);
        for (let i = 0; i < th; i++) vals[dir === "down" ? i : th - 1 - i][j] = out[i];
      }
    } else {
      for (let i = 0; i < th; i++) {
        const src: string[] = [];
        for (let c = S.c0; c <= S.c1; c++) src.push(this.doc.get(S.r0 + i, c));
        const out = fillSeries(src, tw, dir === "left", ctrl);
        for (let j = 0; j < tw; j++) vals[i][dir === "right" ? j : tw - 1 - j] = out[j];
      }
    }
    return vals;
  }

  /** Fills `T` from the source range `S` (Excel's auto fill). */
  private applyFill(S: Rect, T: Rect, dir: FillDir, ctrl: boolean) {
    if ((T.r1 - T.r0 + 1) * (T.c1 - T.c0 + 1) > MAX_CELLS) {
      this.cb.message(L().rangeTooLarge);
      this.render();
      return;
    }
    const vals = this.computeFill(S, T, dir, ctrl);
    const changed = this.doc.setCells(T.r0, T.c0, vals);
    // Select source + filled cells, keeping the active cell where it was.
    const s = this.sel;
    s.anR = Math.min(S.r0, T.r0);
    s.anC = Math.min(S.c0, T.c0);
    s.fR = Math.max(S.r1, T.r1);
    s.fC = Math.max(S.c1, T.c1);
    s.allRows = s.allCols = false;
    this.touch();
    this.positionEditor();
    this.render();
    this.cb.selectionChanged();
    if (changed) this.cb.changed();
  }

  /** Double-click on the fill handle: fill down as far as the neighbouring column has data. */
  private autoFillDown() {
    const S = this.selRect();
    const has = (r: number, c: number) => this.doc.get(r, c) !== "";
    for (const col of [S.c0 - 1, S.c1 + 1]) {
      if (col < 0 || !has(S.r1 + 1, col)) continue;
      let end = S.r1 + 1;
      while (end + 1 < this.doc.rowCount && has(end + 1, col)) end++;
      this.applyFill(S, { r0: S.r1 + 1, r1: end, c0: S.c0, c1: S.c1 }, "down", false);
      this.scrollIntoView(end, S.c0);
      this.render();
      return;
    }
  }

  private autoScroll() {
    if (!this.drag) return;
    const { x, y } = this.mouse;
    let moved = false;
    if (this.drag !== "row") {
      if (x < this.rowHdrW) {
        this.scroller.scrollLeft -= 24;
        moved = true;
      } else if (x > this.W) {
        this.scroller.scrollLeft += 24;
        moved = true;
      }
    }
    if (this.drag !== "col") {
      if (y < (this.freezeTop ? this.hdrH : this.top)) {
        this.setScrollY(this.scrollY() - this.rowH);
        moved = true;
      } else if (y > this.H) {
        this.setScrollY(this.scrollY() + this.rowH);
        moved = true;
      }
    }
    if (moved) this.updateDrag();
  }

  private onDblClick(e: MouseEvent) {
    const { x, y } = this.local(e);
    if (x >= this.W || y >= this.H) return;
    if (this.onFillHandle(x, y)) {
      this.autoFillDown();
      return;
    }
    const rc = this.resizeHit(x, y);
    if (rc >= 0) {
      this.autoFit(rc);
      return;
    }
    if (this.hit(x, y).kind === "cell") this.beginEdit("edit", this.doc.get(this.sel.ar, this.sel.ac));
  }

  private onHover(e: MouseEvent) {
    if (this.drag || this.resizing) return;
    const { x, y } = this.local(e);
    let cur = "default";
    if (this.onFillHandle(x, y)) cur = "crosshair";
    else if (this.resizeHit(x, y) >= 0) cur = "col-resize";
    else if (y >= this.hdrH && x >= this.rowHdrW && x < this.W && y < this.H) cur = "cell";
    if (this.scroller.style.cursor !== cur) this.scroller.style.cursor = cur;
  }

  // ------------------------------------------------------------ selection / movement

  private setActiveRaw(r: number, c: number) {
    const s = this.sel;
    s.ar = s.anR = s.fR = r;
    s.ac = s.anC = s.fC = c;
    s.allRows = s.allCols = false;
  }

  /** Grow the displayed area so the selection is always inside it. */
  private touch() {
    const s = this.sel;
    this.reachR = Math.max(this.reachR, s.ar, s.allRows ? 0 : s.fR);
    this.reachC = Math.max(this.reachC, s.ac, s.allCols ? 0 : s.fC);
    this.updateSpacer();
  }

  private scrollIntoView(r: number, c: number) {
    this.updateSpacer();
    const rh = this.rowH;
    if (!(this.freezeTop && r === 0)) {
      const viewH = this.H - this.top;
      const yTop = (r - this.s0) * rh;
      const sy = this.scrollY();
      if (yTop < sy) this.setScrollY(yTop);
      else if (yTop + rh > sy + viewH) this.setScrollY(yTop + rh - viewH);
    }
    const viewW = this.W - this.rowHdrW;
    const x0 = this.xs[c];
    const x1 = this.xs[c + 1];
    const sx = this.scroller.scrollLeft;
    if (x0 < sx) this.scroller.scrollLeft = x0;
    else if (x1 > sx + viewW) this.scroller.scrollLeft = Math.min(x0, x1 - viewW);
  }

  private moveTo(r: number, c: number, shift: boolean) {
    r = clamp(r, 0, MAX_ROW);
    c = clamp(c, 0, MAX_COL);
    const s = this.sel;
    if (shift) {
      s.fR = r;
      s.fC = c;
    } else this.setActiveRaw(r, c);
    this.touch();
    this.scrollIntoView(r, c);
    this.positionEditor();
    this.render();
    this.cb.selectionChanged();
  }

  move(dr: number, dc: number, shift = false, ctrl = false) {
    const s = this.sel;
    let r = shift ? s.fR : s.ar;
    let c = shift ? s.fC : s.ac;
    if (ctrl) [r, c] = this.jump(r, c, dr, dc);
    else {
      r += dr;
      c += dc;
    }
    this.moveTo(r, c, shift);
  }

  /** Ctrl+Arrow: jump to the edge of the current data block, like Excel. */
  private jump(r: number, c: number, dr: number, dc: number): [number, number] {
    const d = this.doc;
    const has = (rr: number, cc: number) => d.get(rr, cc) !== "";
    const limR = Math.max(d.rowCount - 1, r);
    const limC = Math.max(d.colCount - 1, c);
    const inb = (rr: number, cc: number) => rr >= 0 && cc >= 0 && rr <= limR && cc <= limC;
    let nr = r + dr;
    let nc = c + dc;
    if (!inb(nr, nc)) return [r, c];
    if (has(r, c) && has(nr, nc)) {
      while (inb(nr + dr, nc + dc) && has(nr + dr, nc + dc)) {
        nr += dr;
        nc += dc;
      }
      return [nr, nc];
    }
    while (!has(nr, nc) && inb(nr + dr, nc + dc)) {
      nr += dr;
      nc += dc;
    }
    return [nr, nc];
  }

  private page(dir: number, shift: boolean) {
    const n = Math.max(1, Math.floor((this.H - this.top) / this.rowH) - 1);
    this.setScrollY(this.scrollY() + dir * n * this.rowH);
    this.move(dir * n, 0, shift);
  }

  // ------------------------------------------------------------ keyboard

  private onKeyDown(e: KeyboardEvent) {
    if (e.isComposing || e.keyCode === 229) return;
    if (this.mode !== "nav") {
      this.editKey(e);
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const s = this.sel;
    let handled = true;
    switch (e.key) {
      case "ArrowUp":
        this.move(-1, 0, shift, ctrl);
        break;
      case "ArrowDown":
        this.move(1, 0, shift, ctrl);
        break;
      case "ArrowLeft":
        this.move(0, -1, shift, ctrl);
        break;
      case "ArrowRight":
        this.move(0, 1, shift, ctrl);
        break;
      case "Enter":
        if (e.altKey) handled = false;
        else this.move(shift ? -1 : 1, 0);
        break;
      case "Tab":
        this.move(0, shift ? -1 : 1);
        break;
      case "Home":
        this.moveTo(ctrl ? 0 : shift ? s.fR : s.ar, 0, shift);
        break;
      case "End":
        if (ctrl) this.moveTo(Math.max(this.doc.rowCount - 1, 0), Math.max(this.doc.colCount - 1, 0), shift);
        else handled = false;
        break;
      case "PageDown":
        this.page(1, shift);
        break;
      case "PageUp":
        this.page(-1, shift);
        break;
      case "F2":
        this.beginEdit("edit", this.doc.get(s.ar, s.ac));
        break;
      case "Delete":
        this.clear();
        break;
      case "Backspace":
        this.beginEdit("enter", "");
        break;
      case "Escape":
        if (this.copyRect) {
          this.copyRect = null;
          this.render();
        }
        break;
      default:
        handled = false;
        if (ctrl && !e.altKey) {
          handled = true;
          const k = e.key.toLowerCase();
          if (e.code === "Space") this.selectByHit({ kind: "col", r: s.ar, c: s.ac }, false);
          else if (k === "c") void this.copy(false);
          else if (k === "x") void this.copy(true);
          else if (k === "v") void this.paste();
          else if (k === "z") shift ? this.redo() : this.undo();
          else if (k === "y") this.redo();
          else if (k === "a") this.selectAll();
          else if (k === "+" || (k === ";" && shift) || (k === "=" && shift)) this.insertByKey();
          else if (k === "-") this.deleteByKey();
          else handled = false;
        } else if (shift && e.code === "Space" && !ctrl) {
          this.selectByHit({ kind: "row", r: s.ar, c: s.ac }, false);
          handled = true;
        }
    }
    if (handled) e.preventDefault();
  }

  private editKey(e: KeyboardEvent) {
    const ctrl = e.ctrlKey || e.metaKey;
    const ed = this.editor;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        this.cancelEdit();
        return;
      case "Enter":
        e.preventDefault();
        if (e.altKey) {
          ed.setRangeText("\n", ed.selectionStart, ed.selectionEnd, "end");
          this.onInput();
        } else if (ctrl) this.fillSelection(ed.value);
        else {
          this.commitEdit();
          this.move(e.shiftKey ? -1 : 1, 0);
        }
        return;
      case "Tab":
        e.preventDefault();
        this.commitEdit();
        this.move(0, e.shiftKey ? -1 : 1);
        return;
      case "F2":
        e.preventDefault();
        this.mode = this.mode === "enter" ? "edit" : "enter";
        return;
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight":
        if (this.mode === "enter") {
          // Started by typing: arrows confirm and move, like Excel's "Enter" mode.
          e.preventDefault();
          this.commitEdit();
          const d: Record<string, [number, number]> = {
            ArrowUp: [-1, 0],
            ArrowDown: [1, 0],
            ArrowLeft: [0, -1],
            ArrowRight: [0, 1],
          };
          const [dr, dc] = d[e.key];
          this.move(dr, dc);
        }
        return;
    }
  }

  private onInput() {
    if (this.mode === "nav") {
      if (!this.composing && this.editor.value !== "") this.beginEdit("enter");
      return;
    }
    this.autosizeEditor();
    this.cb.editing(this.editor.value);
  }

  // ------------------------------------------------------------ editing

  beginEdit(mode: "enter" | "edit", value?: string) {
    if (this.mode !== "nav") return;
    this.copyRect = null;
    this.mode = mode;
    const ed = this.editor;
    if (value !== undefined) ed.value = value;
    ed.classList.remove("ghost");
    this.scrollIntoView(this.sel.ar, this.sel.ac);
    this.positionEditor();
    if (mode === "edit") {
      const n = ed.value.length;
      ed.setSelectionRange(n, n);
    }
    this.cb.editing(ed.value);
    this.render();
  }

  commitEdit() {
    if (this.mode === "nav") return;
    const v = this.editor.value;
    this.endEdit();
    const { ar, ac } = this.sel;
    if (v !== this.doc.get(ar, ac)) {
      this.doc.setCells(ar, ac, [[v]]);
      this.cb.changed();
    }
  }

  cancelEdit() {
    if (this.mode === "nav") return;
    this.endEdit();
  }

  private endEdit() {
    this.mode = "nav";
    this.editor.value = "";
    this.editor.classList.add("ghost");
    this.positionEditor();
    this.render();
    this.cb.selectionChanged();
  }

  private positionEditor() {
    const s = this.sel;
    const ed = this.editor;
    const rh = this.rowH;
    const sx = this.scroller.scrollLeft;
    const sy = this.scrollY();
    const frozen = this.freezeTop && s.ar === 0;
    let x = this.colX(s.ac, sx);
    let y = this.rowY(s.ar, frozen, sy);
    const w = this.colW(s.ac);
    if (this.mode === "nav") {
      // Keep the hidden input on screen so the IME candidate window appears near the cell.
      x = clamp(x, this.rowHdrW, Math.max(this.rowHdrW, this.W - w));
      y = clamp(y, this.hdrH, Math.max(this.hdrH, this.H - rh));
    }
    ed.style.font = this.font();
    ed.style.lineHeight = `${rh - 4}px`;
    ed.style.padding = `0 ${Math.max(1, Math.round(5 * this.zoom) - 2)}px`;
    ed.style.left = `${x - 1}px`;
    ed.style.top = `${y - 1}px`;
    ed.style.width = `${w + 1}px`;
    ed.style.height = `${rh + 1}px`;
    if (this.mode !== "nav") this.autosizeEditor();
  }

  private autosizeEditor() {
    if (this.mode === "nav") return;
    const ed = this.editor;
    const rh = this.rowH;
    const left = parseFloat(ed.style.left) || 0;
    const topPx = parseFloat(ed.style.top) || 0;
    const lines = ed.value.split("\n");
    this.ctx.font = this.font();
    let maxW = 0;
    for (let i = 0; i < Math.min(lines.length, 200); i++) maxW = Math.max(maxW, this.ctx.measureText(lines[i]).width);
    const cellW = this.colW(this.sel.ac) + 1;
    const avail = Math.max(cellW, this.W - left - 2);
    ed.style.width = `${Math.min(Math.max(cellW, Math.ceil(maxW + 18 * this.zoom)), avail)}px`;
    const availH = Math.max(rh + 1, this.H - topPx - 2);
    ed.style.height = `${Math.min(lines.length * (rh - 4) + 5, availH)}px`;
  }

  private fillSelection(v: string) {
    this.endEdit();
    const R = this.selRect();
    const h = R.r1 - R.r0 + 1;
    const w = R.c1 - R.c0 + 1;
    if (h * w > MAX_CELLS) {
      this.cb.message(L().rangeTooLarge);
      return;
    }
    const vals: string[][] = [];
    for (let i = 0; i < h; i++) vals.push(new Array<string>(w).fill(v));
    if (this.doc.setCells(R.r0, R.c0, vals)) this.cb.changed();
    this.render();
  }

  /** Clears the selected cells (Delete key). */
  clear() {
    this.commitEdit();
    const R = this.selRect();
    const r1 = Math.min(R.r1, this.doc.rowCount - 1);
    const c1 = Math.min(R.c1, this.doc.colCount - 1);
    if (r1 < R.r0 || c1 < R.c0) return;
    const w = c1 - R.c0 + 1;
    const vals: string[][] = [];
    for (let r = R.r0; r <= r1; r++) vals.push(new Array<string>(w).fill(""));
    if (this.doc.setCells(R.r0, R.c0, vals)) this.cb.changed();
    this.render();
  }

  // ------------------------------------------------------------ clipboard

  async copy(cut: boolean) {
    this.commitEdit();
    const R = this.selRect();
    const h = R.r1 - R.r0 + 1;
    const w = R.c1 - R.c0 + 1;
    if (h * w > MAX_CELLS) {
      this.cb.message(L().rangeTooLargeToCopy);
      return;
    }
    const cells: string[][] = [];
    for (let r = R.r0; r <= R.r1; r++) {
      const row: string[] = new Array(w);
      for (let c = 0; c < w; c++) row[c] = this.doc.get(r, R.c0 + c);
      cells.push(row);
    }
    try {
      await this.cb.writeClipboard(toTsv(cells));
    } catch {
      this.cb.message(L().clipboardFailed);
      return;
    }
    if (cut) {
      this.copyRect = null;
      this.clear();
    } else {
      this.copyRect = { ...R };
      this.render();
    }
  }

  async paste() {
    this.commitEdit();
    let text = "";
    try {
      text = await this.cb.readClipboard();
    } catch {
      text = "";
    }
    if (!text) return;
    const block = parseCsv(text, "\t");
    if (!block.length) return;
    let bw = 1;
    for (const row of block) if (row.length > bw) bw = row.length;
    for (const row of block) while (row.length < bw) row.push("");
    const bh = block.length;
    const s = this.sel;
    const R = this.selRect();
    const selH = R.r1 - R.r0 + 1;
    const selW = R.c1 - R.c0 + 1;
    let vals = block;
    // Like Excel: a block that fits the selection an exact number of times is repeated.
    if (
      !s.allRows &&
      !s.allCols &&
      (selH > 1 || selW > 1) &&
      selH % bh === 0 &&
      selW % bw === 0 &&
      selH * selW <= MAX_CELLS
    ) {
      vals = [];
      for (let i = 0; i < selH; i++) {
        const src = block[i % bh];
        const row: string[] = new Array(selW);
        for (let j = 0; j < selW; j++) row[j] = src[j % bw];
        vals.push(row);
      }
    }
    const changed = this.doc.setCells(R.r0, R.c0, vals);
    this.copyRect = null;
    this.select(R.r0, R.c0, R.r0 + vals.length - 1, R.c0 + vals[0].length - 1);
    if (changed) this.cb.changed();
  }

  // ------------------------------------------------------------ history / structure

  undo() {
    if (this.mode !== "nav") {
      this.cancelEdit();
      return;
    }
    const r = this.doc.undo();
    if (r) this.applyHistory(r);
  }

  redo() {
    this.commitEdit();
    const r = this.doc.redo();
    if (r) this.applyHistory(r);
  }

  private applyHistory(h: HistoryResult) {
    if (h.colShift) this.shiftWidths(h.colShift.at, h.colShift.n);
    const R = h.rect;
    this.copyRect = null;
    this.select(R.r0, R.c0, R.r1, R.c1, h.whole);
    this.cb.changed();
  }

  private shiftWidths(at: number, n: number) {
    if (at < this.baseW.length) {
      if (n > 0) this.baseW.splice(at, 0, ...new Array<number | undefined>(n).fill(undefined));
      else this.baseW.splice(at, -n);
    }
    this.wVersion++;
  }

  private rowSpan(): [number, number] {
    const s = this.sel;
    if (s.allRows) return [s.ar, 1];
    const R = this.selRect();
    return [R.r0, R.r1 - R.r0 + 1];
  }
  private colSpan(): [number, number] {
    const s = this.sel;
    if (s.allCols) return [s.ac, 1];
    const R = this.selRect();
    return [R.c0, R.c1 - R.c0 + 1];
  }

  insertRows(below: boolean) {
    this.commitEdit();
    const [r0, n] = this.rowSpan();
    const at = below ? r0 + n : r0;
    if (!this.doc.insertRows(at, n)) {
      this.cb.message(L().cannotInsertOutside);
      return;
    }
    this.copyRect = null;
    this.select(at, this.sel.ac, at + n - 1, this.sel.ac, "rows");
    this.cb.changed();
  }

  deleteRows() {
    this.commitEdit();
    const [r0, n] = this.rowSpan();
    if (!this.doc.deleteRows(r0, n)) return;
    this.copyRect = null;
    this.select(r0, this.sel.ac, r0, this.sel.ac, "rows");
    this.cb.changed();
  }

  insertCols(right: boolean) {
    this.commitEdit();
    const [c0, n] = this.colSpan();
    const at = right ? c0 + n : c0;
    if (!this.doc.insertCols(at, n)) {
      this.cb.message(L().cannotInsertOutside);
      return;
    }
    this.shiftWidths(at, n);
    this.copyRect = null;
    this.select(this.sel.ar, at, this.sel.ar, at + n - 1, "cols");
    this.cb.changed();
  }

  deleteCols() {
    this.commitEdit();
    const [c0, n] = this.colSpan();
    if (!this.doc.deleteCols(c0, n)) return;
    this.shiftWidths(c0, -n);
    this.copyRect = null;
    this.select(this.sel.ar, c0, this.sel.ar, c0, "cols");
    this.cb.changed();
  }

  private insertByKey() {
    if (this.sel.allRows) this.insertCols(false);
    else this.insertRows(false);
  }
  private deleteByKey() {
    if (this.sel.allRows) this.deleteCols();
    else this.deleteRows();
  }

  // ------------------------------------------------------------ column widths

  private autoFit(c: number) {
    const ctx = this.ctx;
    ctx.font = `400 13px ${FONT_FAMILY}`;
    let max = ctx.measureText(colName(c)).width;
    const n = Math.min(this.doc.rowCount, 5000);
    for (let r = 0; r < n; r++) {
      const v = this.doc.rows[r]?.[c];
      if (v) max = Math.max(max, ctx.measureText(firstLine(v)).width);
    }
    this.baseW[c] = clamp(Math.ceil(max + 16), 32, 800);
    this.wVersion++;
    this.positionEditor();
    this.render();
  }

  /** Initial column widths from a sample of rows. */
  private autoFitAll() {
    this.baseW = [];
    this.wVersion++;
    const cols = this.doc.colCount;
    if (!cols) return;
    const ctx = this.ctx;
    ctx.font = `400 13px ${FONT_FAMILY}`;
    const n = Math.min(this.doc.rowCount, Math.max(30, Math.min(500, Math.floor(60000 / cols))));
    const w = new Array<number>(cols).fill(0);
    for (let r = 0; r < n; r++) {
      const row = this.doc.rows[r];
      for (let c = 0; c < row.length && c < cols; c++) {
        const v = row[c];
        if (v) w[c] = Math.max(w[c], ctx.measureText(firstLine(v)).width);
      }
    }
    for (let c = 0; c < cols; c++) this.baseW[c] = clamp(Math.ceil(w[c] + 18), 56, 320);
  }
}

function firstLine(v: string): string {
  const s = v.length > 300 ? v.slice(0, 300) : v;
  const i = s.search(/[\r\n]/);
  return i >= 0 ? s.slice(0, i) : s;
}
