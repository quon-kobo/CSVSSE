// Bridge to the Rust side. File contents travel as raw bytes, not JSON:
// [u32 LE header length][header JSON][payload]

import { invoke } from "@tauri-apps/api/core";

export const IN_TAURI = "__TAURI_INTERNALS__" in window;

const enc = new TextEncoder();
const dec = new TextDecoder();

function pack(header: unknown, payload: Uint8Array): Uint8Array {
  const h = enc.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + payload.length);
  new DataView(out.buffer).setUint32(0, h.length, true);
  out.set(h, 4);
  out.set(payload, 4 + h.length);
  return out;
}

export async function readFile(path: string, encoding?: string): Promise<{ text: string; encoding: string }> {
  const res = await invoke<ArrayBuffer | number[]>("read_file", { path, encoding: encoding ?? null });
  const bytes = res instanceof ArrayBuffer ? new Uint8Array(res) : Uint8Array.from(res);
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const header = JSON.parse(dec.decode(bytes.subarray(4, 4 + n))) as { encoding: string };
  return { text: dec.decode(bytes.subarray(4 + n)), encoding: header.encoding };
}

export interface WriteResult {
  ok?: boolean;
  /** Characters that the chosen encoding cannot represent. */
  unmappable?: string[];
}

export function writeFile(path: string, text: string, encoding: string, force: boolean): Promise<WriteResult> {
  return invoke<WriteResult>("write_file", pack({ path, encoding, force }, enc.encode(text)));
}

/** Synchronous byte length for Unicode encodings, or null when the Rust encoder is needed. */
export function fastByteLength(text: string, encoding: string): number | null {
  if (text === "") return 0;
  if (encoding === "UTF-8" || encoding === "UTF-8 BOM") return enc.encode(text).length;
  if (encoding === "UTF-16LE" || encoding === "UTF-16BE") return text.length * 2;
  return null;
}

/** Fallback estimate for browser preview when Tauri is unavailable. */
function fallbackByteLength(text: string, encoding: string): number {
  if (encoding === "Shift_JIS") {
    let n = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      n += cp <= 0x7f || (cp >= 0xff61 && cp <= 0xff9f) ? 1 : 2;
    }
    return n;
  }
  return enc.encode(text).length;
}

export async function byteLength(text: string, encoding: string): Promise<number> {
  const fast = fastByteLength(text, encoding);
  if (fast !== null) return fast;
  if (!IN_TAURI) return fallbackByteLength(text, encoding);
  return invoke<number>("byte_length", { text, encoding });
}
