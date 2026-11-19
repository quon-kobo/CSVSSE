// Auto fill (fill handle) series logic, modelled on Excel.
//
//   1          -> 1, 1, 1 ...           (a single number is copied; Ctrl+drag counts up 2, 3, 4 ...)
//   1, 2, 3    -> 4, 5, 6 ...           (linear trend; Ctrl+drag repeats 1, 2, 3 instead)
//   No.001     -> No.002, No.003 ...    (last number in text, zero padding kept)
//   2024/01/31 -> 2024/02/01 ...        (dates by day; same day-of-month -> by month)
//   月, 火     -> 水, 木 ...            (weekday / month lists)
//   anything else is repeated as a pattern

const NUM = /^([-+]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;
const DATE = /^(\d{4})([/\-.])(\d{1,2})\2(\d{1,2})$/;
const TXTNUM = /^(.*?)(\d+)(\D*)$/;

const LISTS: string[][] = [
  ["日", "月", "火", "水", "木", "金", "土"],
  ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"],
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
  ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
  [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ],
];

type NumP = { k: "num"; v: number; dec: number; comma: boolean };
type DateP = { k: "date"; y: number; m: number; d: number; sep: string; padM: boolean; padD: boolean };
type TxtP = { k: "txt"; pre: string; n: number; width: number; post: string };
type P = NumP | DateP | TxtP | { k: "other" };

function parse(s: string): P {
  let m = NUM.exec(s);
  // "0012" is a code, not a number: keep its zero padding by treating it as text.
  if (m && !(m[2].length > 1 && m[2][0] === "0" && !m[3])) {
    return {
      k: "num",
      v: Number(m[1] + m[2].replace(/,/g, "") + (m[3] ? "." + m[3] : "")),
      dec: m[3]?.length ?? 0,
      comma: m[2].includes(","),
    };
  }
  m = DATE.exec(s);
  if (m) {
    const y = +m[1];
    const mo = +m[3];
    const d = +m[4];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) {
      return { k: "date", y, m: mo, d, sep: m[2], padM: m[3].length === 2, padD: m[4].length === 2 };
    }
  }
  m = TXTNUM.exec(s);
  if (m && m[2].length <= 15) {
    return {
      k: "txt",
      pre: m[1],
      n: Number(m[2]),
      width: m[2].length > 1 && m[2][0] === "0" ? m[2].length : 0,
      post: m[3],
    };
  }
  return { k: "other" };
}

/** Least-squares line through (0, v0), (1, v1), ... -> [intercept, slope]. A single value counts up by 1. */
function linear(vals: number[]): [number, number] {
  const n = vals.length;
  if (n === 1) return [vals[0], 1];
  const xm = (n - 1) / 2;
  const ym = vals.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  vals.forEach((y, x) => {
    num += (x - xm) * (y - ym);
    den += (x - xm) * (x - xm);
  });
  const b = num / den;
  return [ym - b * xm, b];
}

function fmtNum(v: number, dec: number, comma: boolean): string {
  const r = Math.round(v * 1e10) / 1e10;
  const frac = (String(r).split(".")[1] ?? "").length;
  const d = Math.max(dec, Math.min(frac, 10));
  const s = comma
    ? Math.abs(r).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
    : Math.abs(r).toFixed(d);
  return r < 0 ? "-" + s : s;
}

const pad = (v: number, w: number) => String(v).padStart(w, "0");

function fmtDate(t: number, f: DateP): string {
  const dt = new Date(t);
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return `${dt.getUTCFullYear()}${f.sep}${f.padM ? pad(m, 2) : m}${f.sep}${f.padD ? pad(d, 2) : d}`;
}

function listOf(src: string[]): string[] | null {
  for (const list of LISTS) if (src.every((s) => list.includes(s.toLowerCase()))) return list;
  return null;
}

function matchCase(sample: string, word: string): string {
  if (sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return word.toUpperCase();
  if (sample[0] === sample[0].toUpperCase() && sample[0] !== sample[0].toLowerCase()) {
    return word[0].toUpperCase() + word.slice(1);
  }
  return word;
}

/**
 * Values for `count` cells next to `src`.
 * Forward: positions n, n+1, ...; backward (fill up/left): positions -1, -2, ... (nearest first).
 * `ctrl` = Ctrl held while dragging. Like Excel, it switches between "copy" and "series":
 * a single number is copied unless Ctrl is held; everything else is a series unless Ctrl is held.
 */
export function fillSeries(src: string[], count: number, backward: boolean, ctrl: boolean): string[] {
  const n = src.length;
  const out: string[] = new Array(count);
  const pos = (i: number) => (backward ? -1 - i : n + i);
  const cyclic = () => {
    for (let i = 0; i < count; i++) out[i] = src[((pos(i) % n) + n) % n];
    return out;
  };
  if (n === 0 || src.every((s) => s === "")) return cyclic();
  const singleNumber = n === 1 && parse(src[0]).k === "num";
  const copy = singleNumber ? !ctrl : ctrl;
  if (copy) return cyclic();

  const list = listOf(src);
  if (list) {
    const idx = src.map((s) => list.indexOf(s.toLowerCase()));
    const step = n === 1 ? 1 : Math.round((idx[n - 1] - idx[0]) / (n - 1));
    const L = list.length;
    for (let i = 0; i < count; i++) {
      out[i] = matchCase(src[0], list[(((idx[0] + step * pos(i)) % L) + L) % L]);
    }
    return out;
  }

  const ps = src.map(parse);
  const k = ps[0].k;
  if (k === "other" || !ps.every((p) => p.k === k)) return cyclic();

  if (k === "num") {
    const nums = ps as NumP[];
    const [a, b] = linear(nums.map((p) => p.v));
    const dec = Math.max(...nums.map((p) => p.dec));
    const comma = nums.some((p) => p.comma);
    for (let i = 0; i < count; i++) out[i] = fmtNum(a + b * pos(i), dec, comma);
    return out;
  }

  if (k === "txt") {
    const ts = ps as TxtP[];
    const f = ts[0];
    if (!ts.every((t) => t.pre === f.pre && t.post === f.post)) return cyclic();
    const step = n === 1 ? 1 : Math.round((ts[n - 1].n - f.n) / (n - 1));
    const width = Math.max(...ts.map((t) => t.width));
    // "1月" .. "12月" wraps around like Excel's month list.
    const months = f.pre === "" && f.post === "月" && ts.every((t) => t.n >= 1 && t.n <= 12);
    for (let i = 0; i < count; i++) {
      let v = f.n + step * pos(i);
      if (months) v = ((((v - 1) % 12) + 12) % 12) + 1;
      out[i] = f.pre + pad(Math.abs(v), width) + f.post;
    }
    return out;
  }

  // Dates
  const ds = ps as DateP[];
  const f = ds[0];
  const mIdx = ds.map((d) => d.y * 12 + d.m - 1);
  const monthly =
    n > 1 &&
    ds.every((d) => d.d === f.d) &&
    mIdx[1] !== mIdx[0] &&
    mIdx.every((v, i) => i === 0 || v - mIdx[i - 1] === mIdx[1] - mIdx[0]);
  if (monthly) {
    const step = mIdx[1] - mIdx[0];
    for (let i = 0; i < count; i++) {
      const mi = mIdx[0] + step * pos(i);
      const y = Math.floor(mi / 12);
      const m = mi - y * 12;
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      out[i] = fmtDate(Date.UTC(y, m, Math.min(f.d, last)), f);
    }
    return out;
  }
  const DAY = 86_400_000;
  const t0 = Date.UTC(f.y, f.m - 1, f.d);
  const tn = Date.UTC(ds[n - 1].y, ds[n - 1].m - 1, ds[n - 1].d);
  const step = n === 1 ? 1 : Math.round((tn - t0) / DAY / (n - 1));
  for (let i = 0; i < count; i++) out[i] = fmtDate(t0 + step * pos(i) * DAY, f);
  return out;
}
