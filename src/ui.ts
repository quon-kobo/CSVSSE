// Small UI helpers: popup menu, modal dialog, busy overlay.

export type MenuItem =
  | { label: string; action?: () => void; checked?: boolean; disabled?: boolean; shortcut?: string }
  | { sep: true }
  | { header: string };

let closeCurrentMenu: (() => void) | null = null;
let modalCount = 0;

export function isModalOpen(): boolean {
  return modalCount > 0;
}

export function closeMenu(): void {
  const f = closeCurrentMenu;
  closeCurrentMenu = null;
  f?.();
}

export function showMenu(
  items: MenuItem[],
  x: number,
  y: number,
  opts: { above?: boolean; restoreFocus?: HTMLElement } = {},
): void {
  closeMenu();
  const el = document.createElement("div");
  el.className = "menu";
  el.setAttribute("role", "menu");
  for (const it of items) {
    if ("sep" in it) {
      const d = document.createElement("div");
      d.className = "menu-sep";
      el.append(d);
    } else if ("header" in it) {
      const d = document.createElement("div");
      d.className = "menu-header";
      d.textContent = it.header;
      el.append(d);
    } else {
      const b = document.createElement("button");
      b.className = "menu-item";
      b.setAttribute("role", it.checked !== undefined ? "menuitemradio" : "menuitem");
      if (it.checked !== undefined) b.setAttribute("aria-checked", String(it.checked));
      b.disabled = !!it.disabled;
      const check = document.createElement("span");
      check.className = "menu-check";
      check.textContent = it.checked ? "✓" : "";
      const label = document.createElement("span");
      label.className = "menu-label";
      label.textContent = it.label;
      const sc = document.createElement("span");
      sc.className = "menu-shortcut";
      sc.textContent = it.shortcut ?? "";
      b.append(check, label, sc);
      b.addEventListener("click", () => {
        closeMenu();
        it.action?.();
      });
      el.append(b);
    }
  }
  document.body.append(el);
  const r = el.getBoundingClientRect();
  let left = Math.min(x, window.innerWidth - r.width - 4);
  let top = opts.above ? y - r.height - 4 : y;
  if (top + r.height > window.innerHeight - 4) top = Math.max(4, y - r.height);
  left = Math.max(4, left);
  top = Math.max(4, top);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  const buttons = () => Array.from(el.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) closeMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const bs = buttons();
      const i = bs.indexOf(document.activeElement as HTMLButtonElement);
      const n = e.key === "ArrowDown" ? (i + 1) % bs.length : (i - 1 + bs.length) % bs.length;
      bs[n]?.focus();
    }
  };
  const onBlur = () => closeMenu();
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
  });
  document.addEventListener("keydown", onKey, true);
  closeCurrentMenu = () => {
    el.remove();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
    opts.restoreFocus?.focus({ preventScroll: true });
  };
  buttons()[0]?.focus({ preventScroll: true });
}

export interface DialogButton {
  label: string;
  value: string;
  primary?: boolean;
}

/** Modal dialog; resolves with the clicked button's value (or `cancelValue` on Esc). */
export function ask(
  message: string | Node,
  buttons: DialogButton[],
  cancelValue = "cancel",
  title = "CSVSSE",
): Promise<string> {
  closeMenu();
  return new Promise((resolve) => {
    modalCount++;
    const prev = document.activeElement as HTMLElement | null;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const box = document.createElement("div");
    box.className = "modal";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const h = document.createElement("div");
    h.className = "modal-title";
    h.textContent = title;
    const msg = document.createElement("div");
    msg.className = "modal-msg";
    msg.append(message);
    const row = document.createElement("div");
    row.className = "modal-buttons";
    let primary: HTMLButtonElement | null = null;
    const done = (v: string) => {
      modalCount--;
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      prev?.focus({ preventScroll: true });
      resolve(v);
    };
    for (const b of buttons) {
      const el = document.createElement("button");
      el.className = b.primary ? "btn primary" : "btn";
      el.textContent = b.label;
      el.addEventListener("click", () => done(b.value));
      if (b.primary) primary = el;
      row.append(el);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done(cancelValue);
      } else if (e.key === "Tab") {
        const bs = Array.from(row.querySelectorAll("button"));
        const i = bs.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        bs[(i + (e.shiftKey ? -1 : 1) + bs.length) % bs.length]?.focus();
      }
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    box.append(h, msg, row);
    overlay.append(box);
    document.body.append(overlay);
    (primary ?? row.querySelector("button"))?.focus();
  });
}

export async function alertMsg(message: string): Promise<void> {
  await ask(message, [{ label: "OK", value: "ok", primary: true }], "ok");
}

export function showBusy(text: string): void {
  const el = document.getElementById("busy")!;
  el.querySelector(".busy-text")!.textContent = text;
  el.hidden = false;
}

export function hideBusy(): void {
  document.getElementById("busy")!.hidden = true;
}

/** Lets the browser paint (e.g. the busy overlay) before a long synchronous task. */
export function yieldToPaint(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30));
}
