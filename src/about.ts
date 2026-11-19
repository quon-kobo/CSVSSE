// "このアプリについて" (About) dialog.

import { openUrl } from "@tauri-apps/plugin-opener";
import iconUrl from "../src-tauri/app-icon.svg";
import pkg from "../package.json";
import { IN_TAURI } from "./ipc";
import { ask } from "./ui";

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
  row("作成", "© 2026 QUON-KOBO");
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
      { label: "最新版を確認", value: "latest" },
      { label: "閉じる", value: "close", primary: true },
    ],
    "close",
    "このアプリについて",
  );
  if (v === "latest") open(`${REPO}/releases/latest`);
}
