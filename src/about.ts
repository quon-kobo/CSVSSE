// "About" and "Settings" dialogs.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import iconUrl from "../src-tauri/app-icon.svg";
import fileIconUrl from "../src-tauri/file-icon.svg";
import pkg from "../package.json";
import { L, lang, resolveLang, type LangPref } from "./i18n";
import { IN_TAURI } from "./ipc";
import { alertMsg, ask } from "./ui";

const REPO = "https://github.com/quon-kobo/CSVSSE";
/** English README is the repository's front page; Japanese users get README.ja.md. */
const homepage = () => (lang() === "ja" ? `${REPO}/blob/main/README.ja.md` : REPO);

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

// ------------------------------------------------------------------ about

export async function showAbout(): Promise<void> {
  const t = L();
  const box = el("div", "about");
  const head = el("div", "about-head");
  const img = el("img", "about-icon");
  img.src = iconUrl;
  img.alt = "";
  const names = el("div", "about-names");
  names.append(el("div", "about-name", "CSVSSE"), el("div", "about-version", t.version(pkg.version)));
  head.append(img, names);

  const desc = el("p", "about-desc", t.appDescription);

  const info = el("dl", "about-info");
  const row = (k: string, v: string | HTMLElement) => {
    const dd = el("dd", "");
    dd.append(v);
    info.append(el("dt", "", k), dd);
  };
  row(t.author, "© 2026 QUON KOBO");
  row(t.license, t.licenseValue);
  const link = el("a", "about-link", "github.com/quon-kobo/CSVSSE");
  link.href = homepage();
  link.addEventListener("click", (e) => {
    e.preventDefault();
    open(homepage());
  });
  row(t.web, link);

  box.append(head, desc, info);

  const v = await ask(
    box,
    [
      { label: t.checkLatest, value: "latest" },
      { label: t.close, value: "close", primary: true },
    ],
    "close",
    t.aboutTitle,
  );
  if (v === "latest") open(`${REPO}/releases/latest`);
}

// ------------------------------------------------------------------ settings

export interface SettingsOptions {
  pref: LangPref;
  osLang: string | null;
  /** Called immediately when the language choice changes. */
  onLanguage(pref: LangPref): void;
}

export async function showSettings(opts: SettingsOptions): Promise<void> {
  let pref = opts.pref;
  let registered = IN_TAURI ? await invoke<boolean>("association_status").catch(() => false) : false;
  const box = el("div", "settings");

  const render = () => {
    const t = L();
    box.replaceChildren();

    // Language
    const langSec = el("section", "set-section");
    const label = el("label", "set-heading", t.language);
    const sel = el("select", "set-select");
    sel.id = "set-language";
    label.htmlFor = sel.id;
    const autoName = resolveLang("auto", opts.osLang) === "ja" ? "日本語" : "English";
    for (const [value, text] of [
      ["auto", t.langAuto(autoName)],
      ["ja", "日本語"],
      ["en", "English"],
    ] as const) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      o.selected = pref === value;
      sel.append(o);
    }
    sel.addEventListener("change", () => {
      pref = sel.value as LangPref;
      opts.onLanguage(pref);
      render();
      retitle();
      box.querySelector<HTMLSelectElement>("#set-language")?.focus();
    });
    langSec.append(label, sel);

    // File association
    const assocSec = el("section", "set-section");
    assocSec.append(el("div", "set-heading", t.assocHeading));
    const head = el("div", "about-head");
    const img = el("img", "about-icon");
    img.src = fileIconUrl;
    img.alt = "";
    const txt = el("div", "");
    txt.append(
      el("div", "assoc-title", t.assocTitle),
      el("div", registered ? "assoc-state on" : "assoc-state", registered ? t.assocOn : t.assocOff),
    );
    head.append(img, txt);
    const steps = el("ol", "assoc-steps");
    steps.append(el("li", "", t.assocStep1), el("li", "", t.assocStep2), el("li", "", t.assocStep3));
    const note = el("p", "assoc-note", t.assocNote);
    const actions = el("div", "set-actions");
    const button = (text: string, primary: boolean, fn: () => Promise<void>) => {
      const b = el("button", primary ? "btn primary small" : "btn small", text);
      b.addEventListener("click", async () => {
        if (!IN_TAURI) {
          await alertMsg(L().assocAppOnly);
          return;
        }
        try {
          await fn();
        } catch (e) {
          await alertMsg(String(e));
        }
        registered = await invoke<boolean>("association_status").catch(() => false);
        render();
      });
      return b;
    };
    if (registered) {
      actions.append(
        button(t.unregister, false, async () => {
          await invoke("set_association", { enable: false });
          await alertMsg(L().unregistered);
        }),
        button(t.chooseDefault, true, () => invoke("choose_default_app")),
      );
    } else {
      actions.append(
        button(t.register, true, async () => {
          await invoke("set_association", { enable: true });
          await invoke("choose_default_app");
        }),
      );
    }
    assocSec.append(head, steps, note, actions);

    box.append(langSec, assocSec);
  };

  // The dialog frame (title, Close button) is built by ask(); keep it in the current language too.
  const retitle = () => {
    const modal = box.closest(".modal");
    const title = modal?.querySelector(".modal-title");
    const close = modal?.querySelector(".modal-buttons button");
    if (title) title.textContent = L().settingsTitle;
    if (close) close.textContent = L().close;
  };

  render();
  await ask(box, [{ label: L().close, value: "close", primary: true }], "close", L().settingsTitle);
}
