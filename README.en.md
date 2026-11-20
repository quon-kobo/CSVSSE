# CSVSSE

[日本語](README.md) | **English**

A simple, lightweight CSV editor for Windows (Tauri 2 + TypeScript).

- Portable: a single exe, no installation
- Excel-like editing: cell and range selection, Ctrl+Arrow, F2 to edit, copy & paste with Excel, fill handle
- Detects the encoding (UTF-8 / UTF-8 with BOM / Shift_JIS / UTF-16) and keeps the original encoding and line endings when saving
- Never rewrites your values (no Excel-style conversions such as `0012` becoming `12` or dates changing format)
- Stays fast with hundreds of thousands to millions of rows — only the visible rows are drawn
- English / Japanese UI, chosen automatically from the Windows display language

## Getting started

Download `CSVSSE.exe` from [Releases](https://github.com/quon-kobo/CSVSSE/releases/latest), put it in any folder, and run it.

> If Windows shows "Windows protected your PC" (SmartScreen) the first time, click "More info" → "Run anyway". It appears because the exe is not code-signed.

- Open a CSV file: drop it on the exe or the window, or press Ctrl+O. The ⌄ next to "Open" lists the 10 most recently used files
- Cells you changed are highlighted in yellow until you save, so you can review your edits before sending the file on
- **Settings** (toolbar, top right, or Ctrl+,)
  - **Language**: Auto (Japanese on Japanese Windows, English otherwise) / 日本語 / English
  - **File association**: click "Register", then choose CSVSSE and click "Always" in the window that opens. CSV / TSV files then open in CSVSSE on double-click and get their own icon. This is a per-user setting, needs no admin rights, and "Unregister" undoes it.
- Settings (language, window size, frozen top row, zoom, recent files) are stored in `csvsse.settings.json` next to the exe
- Requires the Microsoft Edge WebView2 Runtime, which is included with Windows 10 / 11

### Keyboard shortcuts

| Action | Keys |
|---|---|
| Open / Save / Save as | Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| New / New window | Ctrl+N / Ctrl+Shift+N |
| Undo / Redo | Ctrl+Z / Ctrl+Y |
| Copy / Cut / Paste | Ctrl+C / Ctrl+X / Ctrl+V |
| Edit cell / New line in a cell | F2 or double-click / Alt+Enter |
| Fill the selection with the typed value | Ctrl+Enter |
| Jump to the edge of the data | Ctrl+Arrow (add Shift to select) |
| First / last cell | Ctrl+Home / Ctrl+End |
| Select column / row | Ctrl+Space / Shift+Space |
| Insert / delete rows | Ctrl++ / Ctrl+- |
| Find / Replace | Ctrl+F / Ctrl+H (find next: F3) |
| Freeze top row | F12 |
| Settings / About | Ctrl+, / F1 |
| Fill handle | Drag the ■ at the bottom-right of the selection. Works like Excel: a single number is copied and Ctrl+drag counts up 1, 2, 3…; selecting 1, 2, 3 continues with 4, 5, 6…. The values are previewed while dragging, Ctrl switches mode on the fly, Esc cancels. Double-click fills down to the last row of the neighbouring column. |
| Zoom | Ctrl+mouse wheel, or − / + at the bottom right (Ctrl+0 for 100%) |

Click the encoding, delimiter or line-ending indicator in the status bar to change them. Click the zoom level to pick 50%–300%. Selecting two or more cells shows their average, count and sum, as in Excel.

## Development

Requirements: Rust, Node.js, Visual Studio Build Tools (C++)

```powershell
npm install
npm run app         # run in development mode
npm run build:exe   # build the portable exe -> src-tauri\target\release\CSVSSE.exe
npm run icon        # regenerate the app icon from src-tauri\app-icon.svg
npm run icon:file   # regenerate the CSV file icon (csv-file.ico) from src-tauri\file-icon.svg
```

`npm run dev` alone opens the UI in a browser with sample data (saving is disabled). Add `?lang=en` or `?lang=ja` to pick the language.

### Project layout

| File | Purpose |
|---|---|
| `src-tauri/src/lib.rs` | File I/O, encoding detection and conversion, settings, OS language |
| `src-tauri/src/assoc.rs` | File association (per-user registry) |
| `src/grid.ts` | Canvas-rendered grid (scrolling, selection, editing, clipboard) |
| `src/doc.ts` | Data model and undo / redo history |
| `src/csv.ts` | CSV parsing and writing, delimiter and line-ending detection |
| `src/fill.ts` | Fill handle series logic |
| `src/i18n.ts` | UI text (English / Japanese) |
| `src/about.ts` | Settings and About dialogs |
| `src/main.ts` | App shell (toolbar, find, status bar, file operations) |

## License

[MIT License](LICENSE) © 2026 QUON KOBO
