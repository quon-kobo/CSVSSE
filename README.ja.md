# CSVSSE

[English](README.md) | **日本語**

Windows 用のシンプルで軽量な CSV エディター（Tauri 2 + TypeScript）。

- exe 1 個で動くポータブルアプリ（インストール不要）
- Excel ライクな操作（セル選択、範囲選択、Ctrl+矢印、F2 編集、Excel とのコピー＆ペースト、オートフィル）
- 文字コード自動判定（UTF-8 / UTF-8 BOM / Shift_JIS / UTF-16）、保存時に元の文字コード・改行コードを維持
- 値を勝手に書き換えない（`0012` が `12` になる、日付の形が変わる、といった Excel のような変換をしない）
- 数十万〜数百万行の CSV でも、表示中の行だけを描画するので軽快に動く
- 日本語 / 英語の画面（Windows の言語に合わせて自動で切り替え）

## 使い方（利用者向け）

[Releases](https://github.com/quon-kobo/CSVSSE/releases/latest) から `CSVSSE.exe` をダウンロードし、好きなフォルダに置いて起動するだけです。

> 初回起動時に Windows の「PC を保護しました」（SmartScreen）が出た場合は、「詳細情報」→「実行」を選んでください（コード署名をしていないため表示されます）。

- CSV ファイルを開く：exe に CSV をドラッグ＆ドロップ、ウィンドウにドロップ、または Ctrl+O
- **設定**（ツールバー右端の「設定」、Ctrl+,）
  - **言語**：自動（Windows が日本語なら日本語、それ以外は英語）／日本語／English
  - **ファイルの関連付け**：「登録する」→ 開いた画面で CSVSSE を選んで「常に使う」。CSV / TSV ファイルをダブルクリックで開けるようになり、専用のアイコンで表示されます（自分のユーザーだけの設定で、管理者権限は不要。「登録を解除」で元に戻せます）
- 設定（言語、ウィンドウの大きさ、1行目の固定、ズーム）は exe と同じフォルダの `csvsse.settings.json` に保存されます
- 動作には Microsoft Edge WebView2 ランタイムが必要です（Windows 10/11 には標準で入っています）

### 主なショートカット

| 操作 | キー |
|---|---|
| 開く / 上書き保存 / 名前を付けて保存 | Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| 新規 / 新しいウィンドウ | Ctrl+N / Ctrl+Shift+N |
| 元に戻す / やり直し | Ctrl+Z / Ctrl+Y |
| コピー / 切り取り / 貼り付け | Ctrl+C / Ctrl+X / Ctrl+V |
| セルを編集 / セル内で改行 | F2・ダブルクリック / Alt+Enter |
| 選択範囲に一括入力 | 入力後 Ctrl+Enter |
| データの端まで移動 | Ctrl+矢印（Shift で範囲選択） |
| 先頭 / 最後のセル | Ctrl+Home / Ctrl+End |
| 列全体 / 行全体を選択 | Ctrl+Space / Shift+Space |
| 行の挿入 / 削除 | Ctrl++ / Ctrl+- |
| 検索 / 置換 | Ctrl+F / Ctrl+H（次を検索 F3） |
| 1行目を固定 | F12 |
| 設定 / このアプリについて | Ctrl+, / F1 |
| オートフィル | 選択範囲の右下の ■ をドラッグ（Excel と同じ：数値1つはコピー、Ctrl+ドラッグで 1,2,3…。1,2,3 を選んで引っ張ると 4,5,6…。ドラッグ中は入る値がプレビューされ、Ctrl でその場で切り替え、Esc で中止。ダブルクリックで隣の列の最終行まで） |
| ズーム | Ctrl+マウスホイール |

文字コード・区切り文字・改行コードは、画面右下のステータスバーをクリックして変更できます。

## 開発

必要なもの：Rust、Node.js、Visual Studio Build Tools（C++）

```powershell
npm install
npm run app         # 開発モードで起動
npm run build:exe   # ポータブル exe を作る → src-tauri\target\release\CSVSSE.exe
npm run icon        # src-tauri\app-icon.svg からアプリのアイコンを再生成
npm run icon:file   # src-tauri\file-icon.svg から CSV ファイル用アイコン（csv-file.ico）を再生成
```

`npm run dev` だけを実行すると、ブラウザーでサンプルデータを使って画面を確認できます（ファイルの保存はできません）。`?lang=en` / `?lang=ja` を付けると言語を切り替えられます。

### 構成

| ファイル | 役割 |
|---|---|
| `src-tauri/src/lib.rs` | ファイル読み書き、文字コード判定・変換、設定の保存、OS の言語の取得 |
| `src-tauri/src/assoc.rs` | ファイルの関連付け（HKCU） |
| `src/grid.ts` | Canvas 描画のグリッド（スクロール、選択、編集、クリップボード） |
| `src/doc.ts` | データと元に戻す / やり直しの履歴 |
| `src/csv.ts` | CSV の解析と書き出し、区切り文字・改行の判定 |
| `src/fill.ts` | オートフィル（連続データ）の計算 |
| `src/i18n.ts` | 画面の文言（日本語 / 英語） |
| `src/about.ts` | 「設定」と「このアプリについて」の画面 |
| `src/main.ts` | 画面全体（ツールバー、検索、ステータスバー、ファイル操作） |

## ライセンス

[MIT License](LICENSE) © 2026 QUON KOBO
