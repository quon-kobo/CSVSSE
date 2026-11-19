// "このアプリについて" (About) dialog.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import iconUrl from "../src-tauri/app-icon.svg";
import fileIconUrl from "../src-tauri/file-icon.svg";
import pkg from "../package.json";
import { IN_TAURI } from "./ipc";
import { alertMsg, ask } from "./ui";

const REPO = "https://github.com/quon-kobo/CSVSSE";

function open(url: string) {
  if (IN_TAURI) void openUrl(url);
  else window.open(url, "_blank", "noopener");
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export async function showAbout(): Promise<void> {
  const box = el("div", "about");
  const head = el("div", "about-head");
  const img = el("img", "about-icon");
  img.src = iconUrl;
  img.alt = "";
  const names = el("div", "about-names");
  names.append(el("div", "about-name", "CSVSSE"), el("div", "about-version", `バージョン ${pkg.version}`));
  head.append(img, names);

  const desc = el("p", "about-desc", "Windows 用のシンプルで軽量な CSV エディター");

  const info = el("dl", "about-info");
  const row = (k: string, v: string | HTMLElement) => {
    const dd = el("dd", "");
    dd.append(v);
    info.append(el("dt", "", k), dd);
  };
  row("作成", "© 2026 QUON KOBO");
  row("ライセンス", "MIT License（無保証）");
  const link = el("a", "about-link", "github.com/quon-kobo/CSVSSE");
  link.href = REPO;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    open(REPO);
  });
  row("Web", link);

  box.append(head, desc, info);

  const v = await ask(
    box,
    [
      { label: "ファイルの関連付け…", value: "assoc" },
      { label: "最新版を確認", value: "latest" },
      { label: "閉じる", value: "close", primary: true },
    ],
    "close",
    "このアプリについて",
  );
  if (v === "latest") open(`${REPO}/releases/latest`);
  else if (v === "assoc") await showAssociation();
}

/** Lets the user register CSVSSE for .csv / .tsv files (per-user, reversible). */
export async function showAssociation(): Promise<void> {
  if (!IN_TAURI) {
    await alertMsg("ファイルの関連付けは、アプリ版（CSVSSE.exe）でのみ設定できます。");
    return;
  }
  const registered = await invoke<boolean>("association_status");

  const box = el("div", "assoc");
  const head = el("div", "about-head");
  const img = el("img", "about-icon");
  img.src = fileIconUrl;
  img.alt = "";
  const txt = el("div", "");
  txt.append(
    el("div", "assoc-title", "CSV / TSV ファイルを CSVSSE で開く"),
    el("div", registered ? "assoc-state on" : "assoc-state", registered ? "● 登録済み" : "○ 未登録"),
  );
  head.append(img, txt);
  const steps = el("ol", "assoc-steps");
  steps.append(
    el("li", "", "「登録する」で、Windows に CSVSSE を登録します（管理者権限は不要）"),
    el("li", "", "続けて開く画面で「CSVSSE」を選び、「常に使う」を押します"),
    el("li", "", "CSV ファイルが左のアイコンで表示され、ダブルクリックで CSVSSE が開きます"),
  );
  const note = el(
    "p",
    "assoc-note",
    "exe を別のフォルダに移動したときは、もう一度「登録する」を押してください。「登録を解除」で元に戻せます。",
  );
  box.append(head, steps, note);

  const buttons = registered
    ? [
        { label: "登録を解除", value: "off" },
        { label: "既定のアプリを選ぶ", value: "choose" },
        { label: "閉じる", value: "close", primary: true },
      ]
    : [
        { label: "閉じる", value: "close" },
        { label: "登録する", value: "on", primary: true },
      ];
  const v = await ask(box, buttons, "close", "ファイルの関連付け");
  try {
    if (v === "on") {
      await invoke("set_association", { enable: true });
      await invoke("choose_default_app");
    } else if (v === "choose") {
      await invoke("choose_default_app");
    } else if (v === "off") {
      await invoke("set_association", { enable: false });
      await alertMsg(
        "登録を解除しました。\n\nCSV ファイルを開くアプリは、Windows の「設定」→「アプリ」→「既定のアプリ」で選び直せます。",
      );
    }
  } catch (e) {
    await alertMsg(String(e));
  }
}
