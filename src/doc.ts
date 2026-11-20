// Document model: a jagged string[][] plus an undo/redo history.

export interface Rect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface HistoryResult {
  rect: Rect;
  /** "rows" = whole rows selected, "cols" = whole columns selected */
  whole?: "rows" | "cols";
  /** Column insert (n > 0) or delete (n < 0) so the grid can shift its column widths. */
  colShift?: { at: number; n: number };
}

export interface CellChange {
  r: number;
  c: number;
  a: string;
}

type Op =
  | { t: "set"; r: number; c: number; before: string[][]; after: string[][]; rows: number; cols: number }
  | { t: "list"; cells: { r: number; c: number; b: string; a: string }[]; rows: number; cols: number; rect: Rect }
  | { t: "insRows"; at: number; n: number }
  | { t: "delRows"; at: number; removed: string[][] }
  | { t: "insCols"; at: number; n: number }
  | { t: "delCols"; at: number; n: number; removed: (string[] | null)[]; cols: number; map: number[] };

/** gen = 記録したときの基準の世代（保存をまたいだ元に戻す／やり直しの判定に使う） */
type Entry = Op & { id: number; gen: number };

const MAX_HISTORY = 200;
/** 基準時点の値が分からない（削除済みの列）ことを表す印 */
const UNKNOWN = "\u0000unknown";

function spliceIn<T>(arr: T[], at: number, items: T[]): T[] {
  if (items.length < 10000) {
    arr.splice(at, 0, ...items);
    return arr;
  }
  return arr.slice(0, at).concat(items, arr.slice(at));
}

export class Doc {
  rows: string[][] = [];
  colCount = 0;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private nextId = 1;
  private savedId = 0;

  // ---- 変更したセルの追跡（最後に開いた／保存した時点＝「基準」との比較）
  // 行は配列のまま挿入・削除・復元されるので、行配列そのものをキーにする。
  /** 基準を取り直すたびに増える */
  private gen = 0;
  /** 基準のあとで増えた行（空でないセルはすべて変更扱い） */
  private created = new WeakSet<string[]>();
  /** 初めて書き換えた行の、基準時点の値（基準時点の列番号で並ぶ） */
  private orig = new WeakMap<string[], string[]>();
  /** 今の列 → 基準時点の列（-1 = 基準のあとで増えた列）。null = 列の挿入・削除なし */
  private colMap: number[] | null = null;
  /** 基準時点の列数 */
  private baseCols = 0;

  get rowCount(): number {
    return this.rows.length;
  }
  get dirty(): boolean {
    return this.topId() !== this.savedId;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  private topId(): number {
    const s = this.undoStack;
    return s.length ? s[s.length - 1].id : 0;
  }
  markSaved(): void {
    this.savedId = this.topId();
    this.resetBaseline();
  }

  load(rows: string[][], colCount: number): void {
    this.rows = rows;
    this.colCount = colCount;
    this.undoStack = [];
    this.redoStack = [];
    this.savedId = 0;
    this.resetBaseline();
  }

  private resetBaseline(): void {
    this.gen++;
    this.baseCols = this.colCount;
    this.created = new WeakSet();
    this.orig = new WeakMap();
    this.colMap = null;
  }

  /** 今の列番号を基準時点の列番号にする（-1 = 基準のあとで増えた列） */
  private origCol(c: number): number {
    const m = this.colMap;
    if (!m) return c;
    return c < m.length ? m[c] : -1;
  }

  /** 最後に開いた／保存した時点から値が変わったセルか */
  isChanged(r: number, c: number): boolean {
    const row = this.rows[r];
    if (!row) return false;
    const v = row[c] ?? "";
    if (this.created.has(row)) return v !== "";
    const oc = this.origCol(c);
    if (oc < 0) return v !== "";
    const o = this.orig.get(row);
    if (!o || o[oc] === UNKNOWN) return false;
    return (o[oc] ?? "") !== v;
  }

  /** 行を初めて書き換える前に、基準時点の値を控えておく */
  private keepOriginal(row: string[]): void {
    if (this.created.has(row) || this.orig.has(row)) return;
    let o: string[];
    if (!this.colMap) o = row.slice();
    else {
      // 削除済みの列は値が分からないので UNKNOWN にしておき、列の削除を元に戻したときに埋める
      o = new Array<string>(this.baseCols).fill(UNKNOWN);
      const n = Math.max(row.length, this.colMap.length);
      for (let c = 0; c < n; c++) {
        const oc = this.origCol(c);
        if (oc >= 0) o[oc] = row[c] ?? "";
      }
    }
    this.orig.set(row, o);
  }

  private ensureColMap(len: number): number[] {
    if (!this.colMap) {
      const n = Math.max(this.colCount, len);
      this.colMap = Array.from({ length: n }, (_, i) => i);
    }
    while (this.colMap.length < len) this.colMap.push(-1);
    return this.colMap;
  }

  private mapInsert(at: number, entries: number[]): void {
    this.ensureColMap(at).splice(at, 0, ...entries);
  }

  private mapRemove(at: number, n: number): number[] {
    const removed = this.ensureColMap(at + n).splice(at, n);
    return removed;
  }

  get(r: number, c: number): string {
    const row = this.rows[r];
    if (!row) return "";
    const v = row[c];
    return v === undefined ? "" : v;
  }

  /** Writes one cell, growing the data area only for non-empty values. */
  private put(r: number, c: number, v: string): void {
    if (r >= this.rows.length) {
      if (v === "") return;
      while (this.rows.length <= r) {
        const add: string[] = [];
        this.created.add(add);
        this.rows.push(add);
      }
    }
    const row = this.rows[r];
    if ((row[c] ?? "") === v) return;
    this.keepOriginal(row);
    if (c >= row.length) {
      if (v === "") return;
      while (row.length < c) row.push("");
      row.push(v);
    } else row[c] = v;
    if (v !== "" && c >= this.colCount) this.colCount = c + 1;
  }

  private record(op: Op): void {
    this.undoStack.push({ ...op, id: this.nextId++, gen: this.gen } as Entry);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  private applySet(r0: number, c0: number, vals: string[][]): void {
    for (let i = 0; i < vals.length; i++) {
      const src = vals[i];
      for (let j = 0; j < src.length; j++) this.put(r0 + i, c0 + j, src[j]);
    }
  }

  private shrinkTo(rows: number, cols: number): void {
    if (this.rows.length > rows) this.rows.length = rows;
    this.colCount = cols;
  }

  /** Sets a rectangular block. Returns the affected rect, or null if nothing changed. */
  setCells(r0: number, c0: number, vals: string[][]): Rect | null {
    let changed = false;
    let w = 0;
    const before: string[][] = new Array(vals.length);
    for (let i = 0; i < vals.length; i++) {
      const src = vals[i];
      const b: string[] = new Array(src.length);
      for (let j = 0; j < src.length; j++) {
        b[j] = this.get(r0 + i, c0 + j);
        if (b[j] !== src[j]) changed = true;
      }
      before[i] = b;
      if (src.length > w) w = src.length;
    }
    if (!changed) return null;
    const op: Op = { t: "set", r: r0, c: c0, before, after: vals, rows: this.rows.length, cols: this.colCount };
    this.applySet(r0, c0, vals);
    this.record(op);
    return { r0, c0, r1: r0 + vals.length - 1, c1: c0 + Math.max(w, 1) - 1 };
  }

  /** Sets scattered cells as one undo step (used by Replace All). */
  setList(changes: CellChange[]): number {
    const cells = changes
      .map((ch) => ({ r: ch.r, c: ch.c, b: this.get(ch.r, ch.c), a: ch.a }))
      .filter((x) => x.a !== x.b);
    if (!cells.length) return 0;
    let r0 = Infinity, c0 = Infinity, r1 = 0, c1 = 0;
    for (const x of cells) {
      r0 = Math.min(r0, x.r);
      c0 = Math.min(c0, x.c);
      r1 = Math.max(r1, x.r);
      c1 = Math.max(c1, x.c);
    }
    const op: Op = { t: "list", cells, rows: this.rows.length, cols: this.colCount, rect: { r0, c0, r1, c1 } };
    for (const x of cells) this.put(x.r, x.c, x.a);
    this.record(op);
    return cells.length;
  }

  insertRows(at: number, n: number): boolean {
    if (at >= this.rows.length || n <= 0) return false;
    this.doInsertRows(at, n);
    this.record({ t: "insRows", at, n });
    return true;
  }
  private doInsertRows(at: number, n: number): void {
    const add: string[][] = [];
    for (let i = 0; i < n; i++) {
      const row: string[] = [];
      this.created.add(row);
      add.push(row);
    }
    this.rows = spliceIn(this.rows, at, add);
  }

  deleteRows(at: number, n: number): boolean {
    if (at >= this.rows.length || n <= 0) return false;
    const removed = this.rows.splice(at, n);
    this.record({ t: "delRows", at, removed });
    return true;
  }

  insertCols(at: number, n: number): boolean {
    if (at >= this.colCount || n <= 0) return false;
    this.doInsertCols(at, n);
    this.record({ t: "insCols", at, n });
    return true;
  }
  private doInsertCols(at: number, n: number): void {
    const blank = new Array<string>(n).fill("");
    for (const row of this.rows) if (row.length > at) row.splice(at, 0, ...blank);
    // 列の対応表は colCount を変える前に更新する（null からの作成が今の列数を使うため）
    this.mapInsert(at, new Array<number>(n).fill(-1));
    this.colCount += n;
  }

  deleteCols(at: number, n: number): boolean {
    if (at >= this.colCount || n <= 0) return false;
    const cols = this.colCount;
    const removed = this.rows.map((row) => (row.length > at ? row.splice(at, n) : null));
    const map = this.mapRemove(at, n);
    this.colCount = cols - Math.min(n, cols - at);
    this.record({ t: "delCols", at, n, removed, cols, map });
    return true;
  }

  undo(): HistoryResult | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    const res = this.revert(e);
    this.redoStack.push(e);
    return res;
  }

  redo(): HistoryResult | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    const res = this.forward(e);
    this.undoStack.push(e);
    return res;
  }

  private fullCols(): number {
    return Math.max(this.colCount, 1) - 1;
  }

  private forward(op: Entry): HistoryResult {
    switch (op.t) {
      case "set": {
        this.applySet(op.r, op.c, op.after);
        return { rect: setRect(op) };
      }
      case "list":
        for (const x of op.cells) this.put(x.r, x.c, x.a);
        return { rect: op.rect };
      case "insRows":
        this.doInsertRows(op.at, op.n);
        return { rect: { r0: op.at, c0: 0, r1: op.at + op.n - 1, c1: this.fullCols() }, whole: "rows" };
      case "delRows":
        this.rows.splice(op.at, op.removed.length);
        return { rect: { r0: op.at, c0: 0, r1: op.at, c1: this.fullCols() }, whole: "rows" };
      case "insCols":
        this.doInsertCols(op.at, op.n);
        return { rect: { r0: 0, c0: op.at, r1: 0, c1: op.at + op.n - 1 }, whole: "cols", colShift: { at: op.at, n: op.n } };
      case "delCols":
        for (const row of this.rows) if (row.length > op.at) row.splice(op.at, op.n);
        this.mapRemove(op.at, op.n);
        this.colCount = op.cols - Math.min(op.n, op.cols - op.at);
        return { rect: { r0: 0, c0: op.at, r1: 0, c1: op.at }, whole: "cols", colShift: { at: op.at, n: -op.n } };
    }
  }

  private revert(op: Entry): HistoryResult {
    const sameGen = op.gen === this.gen;
    switch (op.t) {
      case "set":
        this.applySet(op.r, op.c, op.before);
        this.shrinkTo(op.rows, op.cols);
        return { rect: setRect(op) };
      case "list":
        for (const x of op.cells) this.put(x.r, x.c, x.b);
        this.shrinkTo(op.rows, op.cols);
        return { rect: op.rect };
      case "insRows":
        this.rows.splice(op.at, op.n);
        return { rect: { r0: op.at, c0: 0, r1: op.at, c1: this.fullCols() }, whole: "rows" };
      case "delRows":
        this.rows = spliceIn(this.rows, op.at, op.removed);
        // 保存をまたいで復元した行は、保存したファイルにない行なので「増えた行」扱い
        if (!sameGen) for (const row of op.removed) this.created.add(row);
        return {
          rect: { r0: op.at, c0: 0, r1: op.at + op.removed.length - 1, c1: this.fullCols() },
          whole: "rows",
        };
      case "insCols":
        for (const row of this.rows) if (row.length > op.at) row.splice(op.at, op.n);
        this.mapRemove(op.at, op.n);
        this.colCount -= op.n;
        return { rect: { r0: 0, c0: op.at, r1: 0, c1: op.at }, whole: "cols", colShift: { at: op.at, n: -op.n } };
      case "delCols":
        op.removed.forEach((seg, r) => {
          if (seg) this.rows[r].splice(op.at, 0, ...seg);
        });
        {
          // 保存をまたいでいなければ元の列に戻す。またいでいれば「増えた列」扱い
          const map = new Array<number>(op.n).fill(-1);
          if (sameGen) op.map.forEach((oc, j) => j < op.n && (map[j] = oc));
          this.mapInsert(op.at, map);
          this.colCount = op.cols;
          // 列を消したあとで書き換えた行は、消した列の基準値が UNKNOWN なので、戻した値で埋める
          if (sameGen) {
            op.removed.forEach((seg, r) => {
              const o = this.orig.get(this.rows[r]);
              if (!o) return;
              map.forEach((oc, j) => {
                if (oc >= 0 && o[oc] === UNKNOWN) o[oc] = seg?.[j] ?? "";
              });
            });
          }
        }
        return {
          rect: { r0: 0, c0: op.at, r1: 0, c1: op.at + op.n - 1 },
          whole: "cols",
          colShift: { at: op.at, n: op.n },
        };
    }
  }
}

function setRect(op: { r: number; c: number; after: string[][] }): Rect {
  let w = 1;
  for (const row of op.after) if (row.length > w) w = row.length;
  return { r0: op.r, c0: op.c, r1: op.r + op.after.length - 1, c1: op.c + w - 1 };
}
