# ブラウザ版 Eduba

デスクトップ版と React UI、PDF.js、画像前処理、校正データ、出力生成を共有する。
ブラウザ版は静的ファイルだけで配信でき、PDF・校正内容・推論画像をサーバーへ送信しない。
Tesseract.js、ONNX Runtime Web、SQLite WASM は端末内で動く。

## 開発と配信

初回は `npm install` を実行し、OCR モデルを配置する。
モデルは Git 管理対象外なので、新しい worktree では既存のモデルを明示的に指定できる。

```powershell
npm run prepare:web -- --model 'D:\work\eduba\src-tauri\resources\models\eng_assyriology_scan_candidate_20260920_v1.traineddata'
npm run dev:web
```

開発用 URL は `http://127.0.0.1:1421`。
`EDUBA_WEB_MODEL` にモデルパスを設定することもできる。
モデルを配置した後は `npm run build:web` で配信用の `dist/` を生成する。
`npm run preview:web` で配信用ビルドを確認できる。
HTML、JS、Worker、WASM、traineddata、ONNX、フォント、ライセンスを含む `dist/` 全体を配信する。
ビルド・開発に Node.js が必要だが、配信サーバーに Node.js や Rust は不要。

HTTPS（ローカル確認は localhost/127.0.0.1）を使用する。
WASM の Content-Type は `application/wasm`、JS/MJS は JavaScript の MIME type にする。
相対パスでビルドするためサブディレクトリにも配置できる。
SQLite は OPFS SAH pool、ONNX は WASM 1スレッドを使用し、COOP/COEP ヘッダーを必須にしない。
依存コード、学習モデル、推論モデルの取得先は同一サイト内の静的資産のみ。
この段階では Service Worker によるオフライン起動は実装していない。

## ローカルファイルと自動保存

- PDF、`.eduba`、独自の `.traineddata` をユーザーが選択して読み込む。
- 作業内容は OPFS 上の SQLite に自動保存する。原稿 PDF は1 MiB単位で格納し、必要な範囲だけ読み出す。
- 新規作成時と「プロジェクトを保存」「名前を付けて保存」で、`.eduba` ファイルを書き出す。
- File System Access API 対応ブラウザでは選択したファイルへ上書きする。非対応ブラウザではファイルをダウンロードする。
- Ctrl+S はファイル保存、Ctrl+Shift+S は名前を付けて保存。自動保存の通知はファイル保存の通知と区別する。
- 再読み込み時は直前の作業コピーを復元する。「作業中のプロジェクト」から以前の作業コピーを開ける。
- 再起動後はファイル保存先を再選択する。ブラウザ内の復元とOS上のファイルへの書き込み権限は別に扱う。
- 独自 traineddata は IndexedDB に保存する。モデル自体は `.eduba` に埋め込まず、別端末では選択し直す。

OPFS/IndexedDB はサイトごとに保存される。サイトのURLを変えたりサイトデータを削除したりすると、以前の作業コピーや独自モデルは使えなくなる。
保存容量はブラウザの制限を受け、永続保存の要求が許可される保証はない。持ち運び・バックアップには `.eduba` を保存する。
作業コピーは自動削除しないので、容量を整理するときは必要な `.eduba` を保存してからサイトデータを削除する。
OPFS の競合を避けるため、同じサイトで同時にプロジェクトを扱うタブは1つに限る。

## プロジェクト互換性

`.eduba` はデスクトップ版と同じ SQLite schema version 1。
`meta`、`pdf_chunks`、`pages`、`edit_history_records` と gzip 圧縮の履歴を保持する。
ブラウザ用の表示名は任意の `meta.browser_name` に記録する。
OPFS では DELETE journal を使用し、外部ファイルへはSQLite本体を出力する。
ページ更新、manifest、Undo/Redo の保存は1つのトランザクションにまとめ、古い編集内容を前提にした更新は拒否する。
デスクトップ上の絶対モデルパスはブラウザで利用できないため、ブラウザで開くと既定モデルを使用する。必要なら設定画面で独自モデルを選択する。
ブラウザ側のモデル識別子を含むプロジェクトをデスクトップで開いた場合も、デスクトップ側の既定モデルを使用する。

## OCR と自動判定

Tesseract.js 7.0.0 の Worker を再利用し、OEM 1、PSM、DPI、`hocr_char_boxes=1` を設定して hOCR を取得する。
既存の浮動小数点モデルは自動選択されるSIMDコアで未実装のSSE関数を呼ぶ場合があるため、初期実装では非SIMDのLSTMコアと `dotproduct=generic` を指定する。速度の最適化は今後の課題。
Eduba側で実行済みの画像前処理を再適用しないよう、OCRエンジンの自動回転は無効。
Worker の所有とメッセージ送受信を Eduba が管理し、traineddata の初期化中もキャンセルとエラーを処理する。
Worker プロトコルに依存するため Tesseract.js を固定し、更新時はブラウザの実OCRテストも実行する。

図表検出と単語書式推論は既存の ONNX モデルを Worker で実行する。
図表のフィルター、重複除去、入力のRGB正規化、単語のpadding・白背景・Lanczos3縮小、判定しきい値をデスクトップ実装に合わせる。
浮動小数点演算と画像リサイズの差があるため、全入力で同じ認識・判定結果になるとは保証しない。
推論処理の中断は現在ページの処理の区切りで反映され、Tesseract OCR 実行中は Worker を終了する。

## 検証

```powershell
npm test
npm run build:web
npm run test:browser
```

ブラウザテストは既定でインストール済みの Microsoft Edge を使用する。
別のブラウザを使う場合は `EDUBA_TEST_BROWSER` に Playwright の channel（例: `chrome`）を設定する。
テストは配信用ビルドを使い、PDF読み込み、実OCR・ONNX推論、校正、SQLiteファイル保存、再オープン、Undo/Redo、リロード復元、hOCR座標メタデータを確認する。
ファイル選択・ダウンロードの互換方式と外部ネットワークへのリクエストがないことを確認する。
ファイルハンドルでの直接保存、権限拒否、書き込み失敗からの再試行、名前を付けて保存、別タブとの競合防止、独自traineddataの読み込みも対象にする。
直接保存APIの権限拒否・書き込み失敗はテスト用ファイルハンドルで再現する。PDF.js、Tesseract.js、ONNX、OPFS、ファイル入力とダウンロードは実ブラウザで実行する。

2026-10-14 の実行結果: `npm run build:web` 成功、`npm test` 293件成功、`npm run test:browser` 2件成功（インストール済み Microsoft Edge）。外部サイトへの通信はテスト中に発生しなかった。

1,000ページ規模、モバイル、全ブラウザの性能・互換性は未確認。
外部ファイルへの保存時はSQLite全体のバイト列を一時的にメモリへ取り出すため、大きなプロジェクトでは保存時メモリが課題になる。
