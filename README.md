# CSVSSE

Windows 用のシンプルで軽量な CSV エディター（Tauri 2 + TypeScript）。

- exe 1 個で動くポータブルアプリ（インストール不要）
- Excel ライクな操作（セル選択、範囲選択、Ctrl+矢印、F2 編集、Excel とのコピー＆ペースト）
- 文字コード自動判定（UTF-8 / UTF-8 BOM / Shift_JIS / UTF-16）、保存時に元の文字コード・改行コードを維持
- 数十万〜数百万行の CSV でも、表示中の行だけを描画するので軽快に動く

## 使い方（利用者向け）

[Releases](https://github.com/quon-kobo/CSVSSE/releases/latest) から次のどちらかをダウンロードし、好きなフォルダに置いて起動するだけです。

| ファイル | サイズ | こんなときに |
|---|---|---|
| `CSVSSE.exe`（通常版） | 約 4MB | 普通の Windows 10 / 11 の PC（ほとんどの場合はこちら） |
| `CSVSSE-<バージョン>-webview2-x64.zip`（WebView2 同梱版） | 約 300MB | 通常版が起動しない PC（Windows 10 IoT / LTSC など、WebView2 が入っていない PC）。zip を展開し、中の `CSVSSE.exe` を起動。`webview2` フォルダは exe と同じ場所に置いたままにしてください |

> 初回起動時に Windows の「PC を保護しました」（SmartScreen）が出た場合は、「詳細情報」→「実行」を選んでください（コード署名をしていないため表示されます）。

- CSV ファイルを開く：exe に CSV をドラッグ＆ドロップ、ウィンドウにドロップ、または Ctrl+O
- 設定（ウィンドウの大きさ、1行目の固定、ズーム）は exe と同じフォルダの `csvsse.settings.json` に保存されます
- CSV をダブルクリックで開けるようにするには：「情報」→「ファイルの関連付け…」→「登録する」→ 開いた画面で CSVSSE を選んで「常に使う」。CSV ファイルが専用のアイコンで表示されます（自分のユーザーだけの設定で、管理者権限は不要。「登録を解除」で元に戻せます）
- 通常版の動作には Microsoft Edge WebView2 ランタイムが必要です（Windows 10/11 には標準で入っています）。同梱版は不要です

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
| このアプリについて（バージョン・作成者・ライセンス） | F1、またはツールバー右端の「情報」 |
| オートフィル | 選択範囲の右下の ■ をドラッグ（Excel と同じ：数値1つはコピー、Ctrl+ドラッグで 1,2,3…。1,2,3 を選んで引っ張ると 4,5,6…。ドラッグ中は入る値がプレビューされ、Ctrl でその場で切り替え、Esc で中止。ダブルクリックで隣の列の最終行まで） |
| ズーム | Ctrl+マウスホイール |

文字コード・区切り文字・改行コードは、画面右下のステータスバーをクリックして変更できます。

## 開発

必要なもの：Rust、Node.js、Visual Studio Build Tools（C++）

```powershell
npm install
npm run app         # 開発モードで起動
npm run build:exe   # ポータブル exe を作る → src-tauri\target\release\CSVSSE.exe

# WebView2 同梱版の zip を作る → release-out\CSVSSE-<バージョン>-webview2-x64.zip
# （Microsoft の WebView2 ページの「Fixed Version」から x64 の .cab を入手し、expand.exe で展開したフォルダを指定）
npm run build:webview2 -- -Runtime "C:\path\to\Microsoft.WebView2.FixedVersionRuntime.<版>.x64"
npm run icon        # src-tauri\app-icon.svg からアプリのアイコンを再生成
npm run icon:file   # src-tauri\file-icon.svg から CSV ファイル用アイコン（csv-file.ico）を再生成
```

`npm run dev` だけを実行すると、ブラウザーでサンプルデータを使って画面を確認できます（ファイルの保存はできません）。

### 構成

| ファイル | 役割 |
|---|---|
| `src-tauri/src/lib.rs` | ファイル読み書き、文字コード判定・変換、設定の保存 |
| `src/grid.ts` | Canvas 描画のグリッド（スクロール、選択、編集、クリップボード） |
| `src/doc.ts` | データと元に戻す / やり直しの履歴 |
| `src/csv.ts` | CSV の解析と書き出し、区切り文字・改行の判定 |
| `src/main.ts` | 画面全体（ツールバー、検索、ステータスバー、ファイル操作） |
| `src/fill.ts` | オートフィル（連続データ）の計算 |

## ライセンス

[MIT License](LICENSE) © 2026 QUON KOBO
