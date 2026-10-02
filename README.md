# EDUBA

EDUBA は、スキャンした英語の本・論文を Tauri 2 と React で OCR 校正するデスクトップアプリです。初期スライスでは、PDF の画像化、Tesseract hOCR の階層化、左右見開きの前処理、行単位の校正、TXT/hOCR/SVG 出力を対象にします。

## 現在の状態

実装済みのドメイン層は [src/domain.ts](src/domain.ts) です。hOCR のページ、ブロック、段落、行、語、文字と座標・confidence を保持し、認識文字列と校正文字列を分離します。編集で追加された Unicode grapheme には元画像の bbox を付けません。Canvas 前処理は回転、deskew、左右分割、crop の順に実行します。

現在の初期スライスは、`.eduba` 単一ファイルの保存・再オープン、遅延 PDF 読み込み、回転/見開き分割、行単位の校正、選択範囲の候補置換と一括置換、bundled Tesseract 実行、TXT/hOCR/SVG 出力を実装しています。Undo/Redo はページをまたぐ履歴に対応し、復元対象のページへ自動で移動します。行を編集中は入力ごとに取り消せ、編集を終えるとその行の変更全体が一つの操作にまとまります。一括置換も一つの操作としてまとめて取り消せます。実機確認の結果は [docs/validation.md](docs/validation.md) にあります。

手動 OCR 領域の追加・削除・同一行の統合、読順編集、および候補選択 UI は main に実装済みです。実装、テストの存在、テストの実行結果、実機確認は別の状態として [docs/validation.md](docs/validation.md) に記録しています。crop/deskew の操作 UI、1,000 ページ規模の性能確認、非 Windows 対応は今後の作業です。要件の対応表は [docs/requirements-plan.md](docs/requirements-plan.md) にあります。

「図表領域を追加」では画像ペインを範囲選択し、非白ピクセルを囲む最小矩形を確認して「図」または「表」を指定します。白に近い画素（各RGB成分が245以上）は背景として扱い、必要なら元の選択範囲も使用できます。図表はOCRテキストペインの元の位置に画像として表示され、OCR行と同じ読み順指定・Undo/Redoの対象になります。「領域を削除」は範囲選択に交差するOCR行・図表をすべて削除し、クリックでは直下の最小面積の領域を1つ削除します。

HTML出力では読み順に沿って図表を配置し、SVGでは元の座標に配置します。どちらも切り出したPNGを埋め込み、外部画像ファイルは不要です。hOCRには図を`ocr_image`、表を`ocr_table`として座標と読み順を記録します。図表内のOCR文字は保持するため画像との重複を許します。再OCR時は図表領域の範囲と区分を保持し、指定済みの読み順は復元しません。

## 開発

```powershell
npm install
./scripts/setup-runtime.ps1 -TesseractRoot 'C:\Program Files\Tesseract-OCR' -ModelPath 'C:\path\to\traineddata'
npm run tauri dev
```

`setup-runtime.ps1` は Tesseract の実行ファイル、DLL、選択した traineddata を `src-tauri/resources/` にコピーします。テストを実行する場合は、プロジェクト依存関係のインストール後に `npm test` を使います。初期セットアップで Tauri の Rust 環境が必要です。代表的な hOCR は `tmp/ocr/` にあります。

`src-tauri/target/debug/eduba.exe` は開発用です。単独では起動せず、`npm run dev` が起動する `http://127.0.0.1:1420` を読み込みます。日常利用ではこのファイルを直接開かないでください。

開発中は、次のコマンドでアプリと開発サーバーを同時に起動します。

```powershell
npm run tauri dev
```

Windows 向けの配布版を作るには、次を実行します。

```powershell
npm run tauri build
```

生成される `src-tauri/target/release/bundle/nsis/Eduba_<version>_x64-setup.exe` を実行してインストールし、スタートメニューの **Eduba** を起動してください。インストーラーにはアプリ本体と OCR 用の Tesseract・モデルが含まれ、開発サーバーは不要です。MSI が必要な環境では、同じビルドで `src-tauri/target/release/bundle/msi/` にも生成されます。
インストールせずに確認する場合は、`src-tauri/target/release/bundle/portable/Eduba_<version>_x64-portable.zip` を展開し、展開先の `Eduba_<version>_x64-portable/Eduba.exe` を実行してください。`models/` と `tesseract/` は実行ファイルと同じフォルダに置いたままにしてください。開発サーバーは不要です。

### PDF import

**PDF を読み込む** では、プロジェクトを作成する前に元 PDF を確認できます。新規読み込みの既定は **画像抽出** です。安全に主要画像を復元できるページでは元画像の画素数と実効 DPI を使用し、DPI 指定はできません。必要なら **ページを画像化** に切り替え、DPI と回転を指定できます。抽出できないページだけは固定 300 DPI の画像化にフォールバックし、プレビューに理由を表示します。開始・終了ページ（両端を含む）と「見開きを左右に分割」はどちらの方式でも指定できます。保存すると、その範囲の論理ページだけを作成し、元 PDF 全体は `.eduba` プロジェクト内に保持します。既存プロジェクトは互換性のためページ画像化として開きます。

OCR 禁止範囲は各論理ページに百分率で保存されます。天・地と、通常ページでは左・右、見開き分割では小口・ノドを設定できます。表示画像とその全画面の provenance は変えず、OCR 時だけ複製画像の該当領域をマスクします。抽出の安全条件、PDF 配置・clip・回転の復元、フォールバックの詳細は [PDF 画像抽出](docs/pdf-image-extraction.md) を参照してください。

## Language preferences

The interface and native menu support English, Japanese, Simplified Chinese, and Traditional Chinese. Selecting **Automatic (system setting)** follows the Windows display language when available through `sys-locale`; unsupported or unavailable OS locales fall back to English. For Chinese, an explicit Hans/Hant script takes precedence; TW/HK/MO use Traditional, while CN/SG and bare `zh` use Simplified. The fallback is also used when a translation key is missing.

The preference is stored per user in the Tauri app configuration directory at `settings.json`, separately from each `.eduba` project. Saving it uses a versioned atomic replacement, so opening or saving a project does not overwrite the user preference. A language selection applies to the React interface and native menu immediately; a native menu error remains visible in the status area while the selected interface language is preserved.

Translation resources, the PDF worker, and OCR model are local assets. Normal use does not require a network connection. Run `npm run build` for the web bundle, `npm test` for the frontend tests, and `cargo test --manifest-path src-tauri/Cargo.toml --lib` for the preference and menu backend tests.
