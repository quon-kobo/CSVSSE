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
  | { t: "delCols"; at: number; n: number; removed: (string[] | null)[]; cols: number };

type Entry = Op & { id: number };

const MAX_HISTORY = 200;

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
  }

  load(rows: string[][], colCount: number): void {
    this.rows = rows;
    this.colCount = colCount;
    this.undoStack = [];
    this.redoStack = [];
    this.savedId = 0;
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
      while (this.rows.length <= r) this.rows.push([]);
    }
    const row = this.rows[r];
    if (c >= row.length) {
      if (v === "") return;
      while (row.length < c) row.push("");
      row.push(v);
    } else row[c] = v;
    if (v !== "" && c >= this.colCount) this.colCount = c + 1;
  }

  private record(op: Op): void {
    this.undoStack.push({ ...op, id: this.nextId++ } as Entry);
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
    for (let i = 0; i < n; i++) add.push([]);
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
    this.colCount += n;
  }

  deleteCols(at: number, n: number): boolean {
    if (at >= this.colCount || n <= 0) return false;
    const cols = this.colCount;
    const removed = this.rows.map((row) => (row.length > at ? row.splice(at, n) : null));
    this.colCount = cols - Math.min(n, cols - at);
    this.record({ t: "delCols", at, n, removed, cols });
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

  private forward(op: Op): HistoryResult {
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
        this.colCount = op.cols - Math.min(op.n, op.cols - op.at);
        return { rect: { r0: 0, c0: op.at, r1: 0, c1: op.at }, whole: "cols", colShift: { at: op.at, n: -op.n } };
    }
  }

  private revert(op: Op): HistoryResult {
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
        return {
          rect: { r0: op.at, c0: 0, r1: op.at + op.removed.length - 1, c1: this.fullCols() },
          whole: "rows",
        };
      case "insCols":
        for (const row of this.rows) if (row.length > op.at) row.splice(op.at, op.n);
        this.colCount -= op.n;
        return { rect: { r0: 0, c0: op.at, r1: 0, c1: op.at }, whole: "cols", colShift: { at: op.at, n: -op.n } };
      case "delCols":
        op.removed.forEach((seg, r) => {
          if (seg) this.rows[r].splice(op.at, 0, ...seg);
        });
        this.colCount = op.cols;
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
