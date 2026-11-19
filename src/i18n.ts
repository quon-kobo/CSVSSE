// UI text in Japanese and English.
//
// Static HTML uses data-i18n / data-i18n-title / data-i18n-placeholder / data-i18n-aria
// attributes holding a key of `ja`; dynamic text calls L().key or L().key(args).

export type Lang = "ja" | "en";
export type LangPref = "auto" | Lang;

const ja = {
  // toolbar
  toolbar: "ツールバー",
  tbNew: "新規",
  tbNewTip: "新規作成 (Ctrl+N)",
  tbOpen: "開く",
  tbOpenTip: "開く (Ctrl+O)",
  tbSave: "保存",
  tbSaveTip: "上書き保存 (Ctrl+S)",
  tbUndo: "元に戻す",
  tbUndoTip: "元に戻す (Ctrl+Z)",
  tbRedo: "やり直し",
  tbRedoTip: "やり直し (Ctrl+Y)",
  tbFind: "検索",
  tbFindTip: "検索 (Ctrl+F)",
  tbReplace: "置換",
  tbReplaceTip: "置換 (Ctrl+H)",
  tbFreeze: "1行目を固定",
  tbFreezeTip: "1行目（見出し）を固定して表示 (F12)",
  tbSettings: "設定",
  tbSettingsTip: "設定（言語・ファイルの関連付け）",
  tbAbout: "情報",
  tbAboutTip: "このアプリについて (F1)",
  // formula bar / status bar
  nameboxAria: "セル番地",
  nameboxTip: "セル番地（例: B12 と入力して Enter で移動）",
  formulaAria: "セルの内容",
  stDelimTip: "区切り文字",
  stNewlineTip: "改行コード",
  stEncodingTip: "文字コード",
  // find bar
  findToggleTip: "置換の表示/非表示",
  findPlaceholder: "検索",
  findAria: "検索する文字列",
  findPrevTip: "前を検索 (Shift+Enter)",
  findNextTip: "次を検索 (Enter)",
  findCloseTip: "閉じる (Esc)",
  replacePlaceholder: "置換後の文字列",
  replaceOne: "置換",
  replaceAll: "すべて置換",
  dropHere: "ここにファイルをドロップして開く",
  // file / status
  untitled: "無題",
  newFileName: "新規.csv",
  allFiles: "すべてのファイル",
  comma: "カンマ",
  tab: "タブ",
  semicolon: "セミコロン",
  utf8Bom: "UTF-8 (BOM付き)",
  size: (rows: string, cols: string) => `${rows} 行 × ${cols} 列`,
  cells: (n: string) => `${n} セル`,
  average: "平均",
  count: "データの個数",
  sum: "合計",
  statSep: "　",
  saveChanges: (name: string) => `「${name}」への変更を保存しますか？`,
  doSave: "保存する",
  dontSave: "保存しない",
  cancel: "キャンセル",
  close: "閉じる",
  loading: "読み込み中…",
  saving: "保存中…",
  loadedRows: (n: string) => `${n} 行を読み込みました`,
  previewNoSave: "ブラウザープレビューでは保存できません",
  unmappable: (enc: string, chars: string) =>
    `文字コード「${enc}」では保存できない文字があります。\n\n${chars}\n\n` +
    `UTF-8 (BOM付き) で保存すると、文字はそのまま残り Excel でも開けます。`,
  saveAsUtf8: "UTF-8 (BOM付き) で保存",
  saveReplacing: "「?」に置き換えて保存",
  saved: (enc: string) => `保存しました（${enc}）`,
  reopenConfirm: "変更内容は失われます。開き直しますか？",
  reopen: "開き直す",
  // menus
  cut: "切り取り",
  copy: "コピー",
  paste: "貼り付け",
  insertRowAbove: "上に行を挿入",
  insertRowBelow: "下に行を挿入",
  deleteRow: "行を削除",
  insertColLeft: "左に列を挿入",
  insertColRight: "右に列を挿入",
  deleteCol: "列を削除",
  clearContents: "内容をクリア",
  saveEncoding: "保存するときの文字コード",
  reopenEncoding: "文字コードを指定して開き直す",
  saveDelimiter: "保存するときの区切り文字",
  reopenDelimiter: "区切り文字を指定して開き直す",
  saveNewline: "保存するときの改行コード",
  nlWindows: "（Windows）",
  nlUnix: "（Mac / Linux）",
  // find
  notFound: (q: string) => `「${q}」は見つかりませんでした`,
  matches: (n: string) => `${n} 件`,
  replacedCells: (n: string) => `${n} 件のセルを置換しました`,
  nothingToReplace: "置換する文字列が見つかりませんでした",
  badRef: "セル番地は「B12」や「A1:C5」の形で入力してください",
  // grid
  editCellAria: "セルの編集",
  fillSeries: "連続データ",
  fillCopy: "コピー",
  fillSwitch: (to: string) => `　Ctrl で${to}に切り替え`,
  blank: "（空白）",
  rangeTooLarge: "範囲が大きすぎます",
  rangeTooLargeToCopy: "範囲が大きすぎてコピーできません",
  clipboardFailed: "クリップボードにコピーできませんでした",
  cannotInsertOutside: "データの範囲外には挿入できません",
  // about
  aboutTitle: "このアプリについて",
  version: (v: string) => `バージョン ${v}`,
  appDescription: "Windows 用のシンプルで軽量な CSV エディター",
  author: "作成",
  license: "ライセンス",
  licenseValue: "MIT License（無保証）",
  web: "Web",
  checkLatest: "最新版を確認",
  // settings
  settingsTitle: "設定",
  language: "言語 / Language",
  langAuto: (detected: string) => `自動（Windows の言語に合わせる：${detected}）`,
  assocHeading: "ファイルの関連付け",
  assocTitle: "CSV / TSV ファイルを CSVSSE で開く",
  assocOn: "● 登録済み",
  assocOff: "○ 未登録",
  assocStep1: "「登録する」で、Windows に CSVSSE を登録します（管理者権限は不要）",
  assocStep2: "続けて開く画面で「CSVSSE」を選び、「常に使う」を押します",
  assocStep3: "CSV ファイルが左のアイコンで表示され、ダブルクリックで CSVSSE が開きます",
  assocNote: "exe を別のフォルダに移動したときは、もう一度「登録する」を押してください。「登録を解除」で元に戻せます。",
  register: "登録する",
  unregister: "登録を解除",
  chooseDefault: "既定のアプリを選ぶ",
  assocAppOnly: "ファイルの関連付けは、アプリ版（CSVSSE.exe）でのみ設定できます。",
  unregistered:
    "登録を解除しました。\n\nCSV ファイルを開くアプリは、Windows の「設定」→「アプリ」→「既定のアプリ」で選び直せます。",
};

type Dict = typeof ja;

const en: Dict = {
  toolbar: "Toolbar",
  tbNew: "New",
  tbNewTip: "New (Ctrl+N)",
  tbOpen: "Open",
  tbOpenTip: "Open (Ctrl+O)",
  tbSave: "Save",
  tbSaveTip: "Save (Ctrl+S)",
  tbUndo: "Undo",
  tbUndoTip: "Undo (Ctrl+Z)",
  tbRedo: "Redo",
  tbRedoTip: "Redo (Ctrl+Y)",
  tbFind: "Find",
  tbFindTip: "Find (Ctrl+F)",
  tbReplace: "Replace",
  tbReplaceTip: "Replace (Ctrl+H)",
  tbFreeze: "Freeze top row",
  tbFreezeTip: "Keep the first row (header) visible (F12)",
  tbSettings: "Settings",
  tbSettingsTip: "Settings (language, file association)",
  tbAbout: "About",
  tbAboutTip: "About CSVSSE (F1)",
  nameboxAria: "Cell address",
  nameboxTip: "Cell address (type e.g. B12 and press Enter to jump)",
  formulaAria: "Cell contents",
  stDelimTip: "Delimiter",
  stNewlineTip: "Line ending",
  stEncodingTip: "Encoding",
  findToggleTip: "Show/hide replace",
  findPlaceholder: "Find",
  findAria: "Text to find",
  findPrevTip: "Find previous (Shift+Enter)",
  findNextTip: "Find next (Enter)",
  findCloseTip: "Close (Esc)",
  replacePlaceholder: "Replace with",
  replaceOne: "Replace",
  replaceAll: "Replace all",
  dropHere: "Drop a file here to open it",
  untitled: "Untitled",
  newFileName: "New.csv",
  allFiles: "All files",
  comma: "Comma",
  tab: "Tab",
  semicolon: "Semicolon",
  utf8Bom: "UTF-8 with BOM",
  size: (rows, cols) => `${rows} rows × ${cols} cols`,
  cells: (n) => `${n} cells`,
  average: "Average",
  count: "Count",
  sum: "Sum",
  statSep: "   ",
  saveChanges: (name) => `Do you want to save changes to "${name}"?`,
  doSave: "Save",
  dontSave: "Don't save",
  cancel: "Cancel",
  close: "Close",
  loading: "Loading…",
  saving: "Saving…",
  loadedRows: (n) => `Loaded ${n} rows`,
  previewNoSave: "Saving is not available in the browser preview",
  unmappable: (enc, chars) =>
    `Some characters cannot be saved in "${enc}".\n\n${chars}\n\n` +
    `Saving as UTF-8 with BOM keeps them, and Excel can still open the file.`,
  saveAsUtf8: "Save as UTF-8 with BOM",
  saveReplacing: 'Replace with "?" and save',
  saved: (enc) => `Saved (${enc})`,
  reopenConfirm: "Your changes will be lost. Reopen the file?",
  reopen: "Reopen",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  insertRowAbove: "Insert row above",
  insertRowBelow: "Insert row below",
  deleteRow: "Delete row",
  insertColLeft: "Insert column left",
  insertColRight: "Insert column right",
  deleteCol: "Delete column",
  clearContents: "Clear contents",
  saveEncoding: "Encoding for saving",
  reopenEncoding: "Reopen with encoding",
  saveDelimiter: "Delimiter for saving",
  reopenDelimiter: "Reopen with delimiter",
  saveNewline: "Line ending for saving",
  nlWindows: " (Windows)",
  nlUnix: " (Mac / Linux)",
  notFound: (q) => `"${q}" was not found`,
  matches: (n) => (n === "1" ? "1 match" : `${n} matches`),
  replacedCells: (n) => (n === "1" ? "Replaced 1 cell" : `Replaced ${n} cells`),
  nothingToReplace: "Nothing to replace",
  badRef: 'Enter a cell address like "B12" or "A1:C5"',
  editCellAria: "Edit cell",
  fillSeries: "Fill series",
  fillCopy: "Copy cells",
  fillSwitch: (to) => `   Ctrl: switch to ${to.toLowerCase()}`,
  blank: "(blank)",
  rangeTooLarge: "The range is too large",
  rangeTooLargeToCopy: "The range is too large to copy",
  clipboardFailed: "Could not copy to the clipboard",
  cannotInsertOutside: "Cannot insert outside the data",
  aboutTitle: "About CSVSSE",
  version: (v) => `Version ${v}`,
  appDescription: "A simple, lightweight CSV editor for Windows",
  author: "Author",
  license: "License",
  licenseValue: "MIT License (no warranty)",
  web: "Web",
  checkLatest: "Check for updates",
  settingsTitle: "Settings",
  language: "Language / 言語",
  langAuto: (detected) => `Auto (follow Windows: ${detected})`,
  assocHeading: "File association",
  assocTitle: "Open CSV / TSV files with CSVSSE",
  assocOn: "● Registered",
  assocOff: "○ Not registered",
  assocStep1: 'Click "Register" to register CSVSSE with Windows (no admin rights needed)',
  assocStep2: 'In the window that opens, choose "CSVSSE" and click "Always"',
  assocStep3: "CSV files then show the icon on the left and open in CSVSSE on double-click",
  assocNote: 'If you move the exe to another folder, click "Register" again. "Unregister" undoes everything.',
  register: "Register",
  unregister: "Unregister",
  chooseDefault: "Choose default app",
  assocAppOnly: "File association can only be set up in the app (CSVSSE.exe).",
  unregistered:
    "CSVSSE has been unregistered.\n\nYou can choose the app for CSV files again in Windows Settings > Apps > Default apps.",
};

const dicts: Record<Lang, Dict> = { ja, en };
let current: Lang = "ja";
const listeners: (() => void)[] = [];

/** Current UI text. */
export function L(): Dict {
  return dicts[current];
}

export function lang(): Lang {
  return current;
}

/** Japanese Windows -> Japanese, anything else -> English. */
export function resolveLang(pref: LangPref, osLang: string | null): Lang {
  if (pref === "ja" || pref === "en") return pref;
  const s = (osLang ?? navigator.language ?? "").toLowerCase();
  return s.startsWith("ja") ? "ja" : "en";
}

export function setLang(l: Lang): void {
  current = l;
  document.documentElement.lang = l;
  applyStatic();
  for (const f of listeners) f();
}

export function onLangChange(f: () => void): void {
  listeners.push(f);
}

type Key = keyof Dict;

/** Fills in text for elements marked with data-i18n* attributes. */
export function applyStatic(root: ParentNode = document): void {
  const d = L() as Record<Key, unknown>;
  const str = (k: string | undefined) => (k && typeof d[k as Key] === "string" ? (d[k as Key] as string) : null);
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const s = str(el.dataset.i18n);
    if (s !== null) el.textContent = s;
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const s = str(el.dataset.i18nTitle);
    if (s !== null) el.title = s;
  });
  root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => {
    const s = str(el.dataset.i18nPlaceholder);
    if (s !== null) el.placeholder = s;
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => {
    const s = str(el.dataset.i18nAria);
    if (s !== null) el.setAttribute("aria-label", s);
  });
}
