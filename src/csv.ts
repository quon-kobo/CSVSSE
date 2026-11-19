// CSV parsing / serialization (RFC 4180, lenient on malformed quotes).

const QUOTE = 34;
const LF = 10;
const CR = 13;

/** Parses delimited text into rows. A trailing newline does not create an empty last row. */
export function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  const n = text.length;
  if (n === 0) return rows;
  const d = delim.charCodeAt(0);
  let row: string[] = [];
  let i = 0;
  for (;;) {
    let field: string;
    if (text.charCodeAt(i) === QUOTE) {
      let parts = "";
      let start = i + 1;
      let j = start;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q === -1) {
          // Unterminated quote: take the rest of the file.
          parts += text.slice(start);
          i = n;
          break;
        }
        if (text.charCodeAt(q + 1) === QUOTE) {
          parts += text.slice(start, q + 1);
          j = q + 2;
          start = j;
          continue;
        }
        parts += text.slice(start, q);
        i = q + 1;
        break;
      }
      // Anything between the closing quote and the next delimiter is kept as-is.
      let k = i;
      while (k < n) {
        const c = text.charCodeAt(k);
        if (c === d || c === LF || c === CR) break;
        k++;
      }
      if (k > i) parts += text.slice(i, k);
      i = k;
      field = parts;
    } else {
      let k = i;
      while (k < n) {
        const c = text.charCodeAt(k);
        if (c === d || c === LF || c === CR) break;
        k++;
      }
      field = text.slice(i, k);
      i = k;
    }
    row.push(field);
    if (i >= n) {
      rows.push(row);
      break;
    }
    const c = text.charCodeAt(i);
    if (c === d) {
      i++;
      continue;
    }
    i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
    rows.push(row);
    row = [];
    if (i >= n) break;
  }
  return rows;
}

function quoteCsv(v: string, delim: string): string {
  if (v === "") return v;
  if (v.indexOf('"') >= 0) return '"' + v.replace(/"/g, '""') + '"';
  if (v.indexOf(delim) >= 0 || v.indexOf("\n") >= 0 || v.indexOf("\r") >= 0) return '"' + v + '"';
  return v;
}

/** Every row is written with `colCount` fields so the file stays rectangular. */
export function serializeCsv(
  rows: string[][],
  colCount: number,
  delim: string,
  newline: string,
  trailingNewline: boolean,
): string {
  const out: string[] = new Array(rows.length);
  const cells: string[] = new Array(colCount);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < colCount; c++) cells[c] = quoteCsv(row[c] ?? "", delim);
    out[r] = cells.join(delim);
  }
  let s = out.join(newline);
  if (trailingNewline && rows.length) s += newline;
  return s;
}

/** Tab-separated text in the shape Excel puts on the clipboard. */
export function toTsv(cells: string[][]): string {
  const lines = cells.map((row) =>
    row
      .map((v) =>
        v.indexOf("\t") >= 0 || v.indexOf("\n") >= 0 || v.indexOf("\r") >= 0 || v.startsWith('"')
          ? '"' + v.replace(/"/g, '""') + '"'
          : v,
      )
      .join("\t"),
  );
  return lines.join("\r\n") + "\r\n";
}

export function detectNewline(text: string): string {
  const i = text.indexOf("\n");
  if (i > 0 && text.charCodeAt(i - 1) === CR) return "\r\n";
  if (i >= 0) return "\n";
  if (text.indexOf("\r") >= 0) return "\r";
  return "\r\n";
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch === d) n++;
  }
  return n;
}

const CANDIDATES = [",", "\t", ";"];

/** Picks the delimiter that splits the first lines most consistently. */
export function detectDelimiter(text: string, fileName = ""): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsv") || lower.endsWith(".tab")) return "\t";
  const sample = text.slice(0, 64 * 1024);
  const lines: string[] = [];
  let inQ = false;
  let start = 0;
  for (let i = 0; i < sample.length && lines.length < 30; i++) {
    const ch = sample.charCodeAt(i);
    if (ch === QUOTE) inQ = !inQ;
    else if (!inQ && ch === LF) {
      lines.push(sample.slice(start, i));
      start = i + 1;
    }
  }
  if (lines.length < 30 && start < sample.length) lines.push(sample.slice(start));
  let best = ",";
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    let modeCount = 0;
    let mode = 0;
    for (const [k, v] of freq) if (v > modeCount || (v === modeCount && k > mode)) [mode, modeCount] = [k, v];
    if (!modeCount) continue;
    const score = modeCount * 100 + Math.min(mode, 99);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}
