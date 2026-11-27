// 更新の確認・ダウンロード・入れ替え（実際の処理は Rust 側の src-tauri/src/update.rs）。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import pkg from "../package.json";
import { L, onLangChange } from "./i18n";
import { IN_TAURI } from "./ipc";
import { alertMsg, ask, hideBusy, showBusy } from "./ui";

const REPO = "https://github.com/quon-kobo/CSVSSE";
const DAY = 24 * 60 * 60 * 1000;

export interface UpdateHooks {
  /** 入れ替える前に、編集中の内容の保存（または破棄）と設定の保存を済ませる。false なら中止 */
  prepare(): Promise<boolean>;
  /** 起動し直したあとに開き直すファイル */
  currentFile(): string | null;
}

let hooks: UpdateHooks | null = null;
let available: string | null = null;

function open(url: string) {
  if (IN_TAURI) void openUrl(url);
  else window.open(url, "_blank", "noopener");
}

const button = () => document.getElementById("btn-update") as HTMLButtonElement;

function showAvailable(version: string) {
  available = version;
  const b = button();
  b.title = L().tbUpdateTip(version);
  b.hidden = false;
}

export function setupUpdater(h: UpdateHooks): void {
  hooks = h;
  const b = button();
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => void offerUpdate());
  onLangChange(() => {
    if (available) b.title = L().tbUpdateTip(available);
  });
}

/** 起動時の確認。1 日 1 回まで、失敗しても何も出さない（オフラインの PC でも邪魔にならないように） */
export async function autoCheck(settings: Record<string, unknown>): Promise<void> {
  if (!IN_TAURI || settings.updateCheck === false) return;
  const last = typeof settings.lastUpdateCheck === "number" ? settings.lastUpdateCheck : 0;
  const now = Date.now();
  if (now >= last && now - last < DAY) return;
  try {
    await invoke("save_settings", { settings: { lastUpdateCheck: now } });
    const v = await invoke<string | null>("check_update");
    if (v) showAvailable(v);
  } catch {
    /* 黙って次回に回す */
  }
}

/** 「今すぐ確認」「最新版を確認」から呼ぶ。結果を必ず知らせる */
export async function checkNow(): Promise<void> {
  if (!IN_TAURI) {
    open(`${REPO}/releases/latest`);
    return;
  }
  const t = L();
  showBusy(t.updateChecking);
  let v: string | null;
  try {
    v = await invoke<string | null>("check_update");
  } catch (e) {
    hideBusy();
    await alertMsg(`${t.updateCheckFailed}\n${e}`);
    return;
  }
  hideBusy();
  if (v) {
    showAvailable(v);
    await offerUpdate();
  } else await alertMsg(t.upToDate(pkg.version));
}

async function offerUpdate(): Promise<void> {
  const v = available;
  if (!v || !hooks) return;
  const t = L();
  const r = await ask(
    t.updateAvailable(v, pkg.version),
    [
      { label: t.updateNow, value: "update", primary: true },
      { label: t.updateNotes, value: "notes" },
      { label: t.updateLater, value: "later" },
    ],
    "later",
    t.updateTitle,
  );
  if (r === "notes") open(`${REPO}/releases/tag/v${v}`);
  if (r !== "update" || !(await hooks.prepare())) return;

  const unlisten = await listen<{ done: number; total: number | null }>("update-progress", (e) => {
    const { done, total } = e.payload;
    const pct = total ? `${Math.floor((done / total) * 100)}%` : `${(done / 1048576).toFixed(1)} MB`;
    showBusy(L().updateDownloading(pct));
  });
  try {
    showBusy(t.updateDownloading("0%"));
    await invoke("download_update");
    showBusy(t.updateInstalling);
    // 成功すると新しい exe が起動し、このプロセスは終了する
    await invoke("install_update", { file: hooks.currentFile() });
  } catch (e) {
    hideBusy();
    if (String(e) === "CANCELLED") {
      await alertMsg(t.updateCancelled);
      return;
    }
    const r2 = await ask(
      `${t.updateFailed}\n\n${e}`,
      [
        { label: t.openReleases, value: "open", primary: true },
        { label: t.close, value: "close" },
      ],
      "close",
      t.updateTitle,
    );
    if (r2 === "open") open(`${REPO}/releases/latest`);
  } finally {
    unlisten();
  }
}
