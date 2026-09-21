# EDUBA

EDUBA は、スキャンした英語の本・論文を Tauri 2 と React で OCR 校正するデスクトップアプリです。初期スライスでは、PDF の画像化、Tesseract hOCR の階層化、左右見開きの前処理、行単位の校正、TXT/hOCR/SVG 出力を対象にします。

## 現在の状態

実装済みのドメイン層は [src/domain.ts](src/domain.ts) です。hOCR のページ、ブロック、段落、行、語、文字と座標・confidence を保持し、認識文字列と校正文字列を分離します。編集で追加された Unicode grapheme には元画像の bbox を付けません。Canvas 前処理は回転、deskew、左右分割、crop の順に実行します。

現在の初期スライスは、`.eduba` 単一ファイルの保存・再オープン、遅延 PDF 読み込み、回転/見開き分割、行単位の校正、現在ページの Undo/Redo、bundled Tesseract 実行、TXT/hOCR/SVG 出力を実装しています。Undo/Redo はそのページを開いている間の履歴です。実機確認の結果は [docs/validation.md](docs/validation.md) にあります。

Crop/deskew の操作 UI、OCR 領域の追加・削除・読順変更、候補選択 UI と候補データ、1,000 ページ規模の性能確認、配布用インストーラー、非 Windows 対応は今後の作業です。要件の対応表は [docs/requirements-plan.md](docs/requirements-plan.md) にあります。

## 開発

```powershell
npm install
./scripts/setup-runtime.ps1 -TesseractRoot 'C:\Program Files\Tesseract-OCR' -ModelPath 'C:\path\to\traineddata'
npm run tauri dev
```

`setup-runtime.ps1` は Tesseract の実行ファイル、DLL、選択した traineddata を `src-tauri/resources/` にコピーします。テストを実行する場合は、プロジェクト依存関係のインストール後に `npm test` を使います。初期セットアップで Tauri の Rust 環境が必要です。代表的な hOCR は `tmp/ocr/` にあります。

デバッグ実行ファイルは、`src-tauri/target/debug/eduba.exe` と同じ階層にある `models/` と `tesseract/` ディレクトリを必要とします。実行ファイルだけを別の場所へコピーしても OCR は動作しません。

### PDF import

**PDF を読み込む** では、プロジェクトを作成する前に元 PDF を確認できます。新規読み込みの既定は **画像抽出** です。安全に主要画像を復元できるページでは元画像の画素数と実効 DPI を使用し、DPI 指定はできません。必要なら **ページを画像化** に切り替え、DPI と回転を指定できます。抽出できないページだけは固定 300 DPI の画像化にフォールバックし、プレビューに理由を表示します。開始・終了ページ（両端を含む）と「見開きを左右に分割」はどちらの方式でも指定できます。保存すると、その範囲の論理ページだけを作成し、元 PDF 全体は `.eduba` プロジェクト内に保持します。既存プロジェクトは互換性のためページ画像化として開きます。

OCR 禁止範囲は各論理ページに百分率で保存されます。天・地と、通常ページでは左・右、見開き分割では小口・ノドを設定できます。表示画像とその全画面の provenance は変えず、OCR 時だけ複製画像の該当領域をマスクします。抽出の安全条件、PDF 配置・clip・回転の復元、フォールバックの詳細は [PDF 画像抽出](docs/pdf-image-extraction.md) を参照してください。
