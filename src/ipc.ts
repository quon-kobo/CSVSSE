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
