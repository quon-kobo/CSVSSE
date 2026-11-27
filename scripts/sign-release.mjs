// リリース用の exe に署名し、自動更新が読む latest.json を作る（npm run sign）。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

const version = opt("--version") ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const urlOverride = opt("--url");
const exe = resolve(args[0] ?? join(root, "src-tauri", "target", "release", "CSVSSE.exe"));
const key = process.env.CSVSSE_SIGNING_KEY ?? join(homedir(), ".csvsse", "csvsse-update.key");

if (!existsSync(exe)) throw new Error(`exe が見つかりません: ${exe}`);
if (!existsSync(key)) throw new Error(`署名用の秘密鍵が見つかりません: ${key}`);

const tauri = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const r = spawnSync(process.execPath, [tauri, "signer", "sign", "-f", key, "-p", "", exe], { encoding: "utf8" });
if (r.status !== 0) {
  process.stderr.write(r.stdout + r.stderr);
  throw new Error("署名に失敗しました");
}

const signature = readFileSync(`${exe}.sig`, "utf8").trim();
const manifest = {
  version,
  url: urlOverride ?? `https://github.com/quon-kobo/CSVSSE/releases/download/v${version}/${basename(exe)}`,
  size: statSync(exe).size,
  signature,
};
const out = join(dirname(exe), "latest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`署名しました: ${exe}.sig`);
console.log(`更新情報を書き出しました: ${out}（${version}）`);
