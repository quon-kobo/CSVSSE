// "About" and "Settings" dialogs.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import iconUrl from "../src-tauri/app-icon.svg";
import fileIconUrl from "../src-tauri/file-icon.svg";
import pkg from "../package.json";
import { L, lang, resolveLang, type LangPref } from "./i18n";
import { IN_TAURI } from "./ipc";
import { alertMsg, ask } from "./ui";
import { checkNow } from "./update";

/** Product page on the QUON KOBO site: English is the default page, Japanese is under ja/. */
const SITE = "https://quon-kobo.com/csvsse/";
const homepage = () => (lang() === "ja" ? `${SITE}ja/index.html` : `${SITE}index.html`);

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
  const link = el("a", "about-link", "quon-kobo.com/csvsse");
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
  if (v === "latest") await checkNow();
}

// ------------------------------------------------------------------ settings

export interface SettingsOptions {
  pref: LangPref;
  osLang: string | null;
  /** Called immediately when the language choice changes. */
  onLanguage(pref: LangPref): void;
  /** Check for a new version at startup. */
  updateCheck: boolean;
  onUpdateCheck(on: boolean): void;
}

export async function showSettings(opts: SettingsOptions): Promise<void> {
  let pref = opts.pref;
  let updateCheck = opts.updateCheck;
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
    assocSec.append(head, note, actions);

    // Updates
    const updSec = el("section", "set-section");
    updSec.append(el("div", "set-heading", t.updateHeading));
    const chkLabel = el("label", "set-check");
    const chk = el("input", "");
    chk.type = "checkbox";
    chk.checked = updateCheck;
    chk.addEventListener("change", () => {
      updateCheck = chk.checked;
      opts.onUpdateCheck(updateCheck);
    });
    chkLabel.append(chk, t.updateAuto);
    const updActions = el("div", "set-actions");
    const nowBtn = el("button", "btn small", t.updateCheckNow);
    nowBtn.addEventListener("click", () => void checkNow());
    updActions.append(nowBtn);
    updSec.append(chkLabel, el("p", "assoc-note", t.updateNote), updActions);

    box.append(langSec, assocSec, updSec);
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
