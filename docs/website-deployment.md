# Starlight とブラウザ版の公開

ドキュメントを `/eduba/`、ブラウザ版を `/eduba/app/` で配信する。
Vite で生成したアプリを `website/public/app/` にコピーしてから Astro をビルドし、
`website/dist/` 全体を GitHub Pages に公開する。アプリは Starlight のレイアウトに埋め込まず、独立したページとして開く。

## 固定する OCR モデル

`config/web-model.json` に Release のリポジトリ・タグ・ファイル名・SHA-256・サイズを記録する。
現在の対象は `eng_assyriology_cohen_kramer_r1_600x_20261015`（12,090,677 bytes）。
Assyrian-OCR が2026年10月15日に採用した学習・評価用の基準モデルを取り込んでいる。
元の登録情報は `docs/ocr-model-provenance.json` にそのまま保存する。
配信・Release 用の準備時には、この記録の SHA-256 とモデル ID・モデルハッシュの対応も確認する。
学習側の `scan_candidate_generation` の既定値は別のモデルであり、この取り込みでは変更しない。
`latest` や可変のブランチ URL は使わない。
モデルの由来と配布条件は `docs/ocr-model-notice.txt` に記録する。
派生元は `tesseract-ocr/tessdata_best` の `eng.traineddata`。
追加学習モデルも Apache-2.0 で配布し、独自の用途制限は追加しない。
ライセンス本文は `licenses/ocr-model-Apache-2.0.txt` に保存する。

`npm run fetch:web-model` は GitHub CLI の `gh release download` で指定したファイルを取得する。
取得後にサイズと SHA-256 を照合し、両方が一致したファイルだけを `.cache/ocr-models/<sha256>/` に保存する。
ダウンロード途中のファイルは一時名で扱い、失敗時には削除する。
既存キャッシュも使用前に検証し、不一致の場合は処理を停止する。意図したモデル情報と照合してから、そのキャッシュを削除し、再取得する。

ONNX モデルは Git 管理済みのファイルを使用する。Tesseract.js と WASM は `npm ci` で復元する。
GitHub Actions のキャッシュは npm 用だけで、モデルはジョブごとに取得する。

## 初回のモデル Release

最初の Release が未公開のため、次の準備が必要。

1. `docs/ocr-model-notice.txt` の派生元と追加学習の記載、Apache-2.0 での公開内容を確認する。
2. ローカルにある対象モデルから、検証済みの公開ファイルを準備する。

```powershell
npm run prepare:model-release -- --model 'src-tauri/resources/models/eng_assyriology_cohen_kramer_r1_600x_20261015.traineddata'
```

`.cache/model-release/ocr-model-20261015-r1-600x/` に、モデル、`SHA256SUMS`、
`web-model.json`、`OCR-MODEL-LICENSE.txt`、`OCR-MODEL-NOTICE.txt`、`OCR-MODEL-PROVENANCE.json`、`RELEASE-NOTES.md` が生成される。
通知文を編集した場合は、公開前にこのコマンドを再実行する。
この準備コマンドは GitHub に書き込まない。

3. 配布条件と生成物を確認後、リポジトリのルートから Release を作成する。

```powershell
$releaseDir = '.cache/model-release/ocr-model-20261015-r1-600x'
gh release create ocr-model-20261015-r1-600x `
  "$releaseDir/eng_assyriology_cohen_kramer_r1_600x_20261015.traineddata" `
  "$releaseDir/SHA256SUMS" `
  "$releaseDir/web-model.json" `
  "$releaseDir/OCR-MODEL-LICENSE.txt" `
  "$releaseDir/OCR-MODEL-NOTICE.txt" `
  "$releaseDir/OCR-MODEL-PROVENANCE.json" `
  --repo uyumyuuy/eduba --target main --latest=false `
  --title 'Assyrian-OCR model 20261015 r1 600x for Eduba' `
  --notes-file "$releaseDir/RELEASE-NOTES.md"
```

モデルと通知文は公開資産になる。元 PDF、学習データ、ユーザーのプロジェクトは添付しない。
Release の公開だけではサイトを更新しない。次の main への対象変更の push、または Actions の手動実行で反映する。

## ローカルでサイト全体をビルドする

Node.js 24 と GitHub CLI を使用する。依存パッケージは、ルートと website の両方で復元する。

```powershell
npm ci
npm ci --prefix website
npm run build:website
npm --prefix website run preview -- --host 127.0.0.1
```

`http://127.0.0.1:4321/eduba/` がドキュメント、`/eduba/app/` がアプリ。
`app/` の末尾のスラッシュを含む URL で開く。アプリの相対アセット URL は、この場所を基準に解決される。

Release の公開前でも、次のコマンドで手元のモデルをキャッシュに取り込める。
サイズと SHA-256 の検証はダウンロード時と同じ。

```powershell
npm run fetch:web-model -- --model 'src-tauri/resources/models/eng_assyriology_cohen_kramer_r1_600x_20261015.traineddata'
npm run build:website
```

`build:website` は固定モデルを取得・検証し、`EDUBA_WEB_MODEL` に設定して `build:web` を実行する。
シェルに別のモデルパスが設定されていても、サイト全体のビルドには固定モデルを使用する。
単体の `build:web` では、従来どおり任意のローカルモデルを使用できる。

生成されたアプリは、コピー前にもモデルのハッシュを確認する。
`website/public/app/` は毎回作り直すため、古い JS や WASM を次の公開物に残さない。
このディレクトリ、`.cache/`、両方の `dist/` は Git 管理しない。
配信ファイルにはモデル情報と通知文も含める。

## GitHub Actions

`.github/workflows/deploy-website.yml` は以下を順に実行する。

1. Node.js 24 を用意し、両方の lockfile に従って依存パッケージを復元する。
2. `GH_TOKEN` にジョブの `GITHUB_TOKEN` を渡して、`npm run build:website` を実行する。
3. 成功した `website/dist/` を Pages 用 artifact としてアップロードする。
4. ビルドに成功した場合だけ、別のジョブでデプロイする。

取得処理は同じリポジトリの Release に対する `contents: read` を使用する。
個人用トークンや Release への書き込み権限は不要。
Pages の書き込みと OIDC の権限はデプロイジョブにだけ与える。
リポジトリの Settings → Pages → Source は GitHub Actions に設定する。

アプリ、ビルドスクリプト、モデル情報、モデル通知文、ONNX 資産、サイトの変更を main に push すると実行する。
モデルの取得・検証・ビルドに失敗した場合はデプロイせず、公開済みのサイトを保持する。

## モデルの更新と再現

モデルを変更する場合は別のタグ・ファイルで Release を作り、manifest の対象とハッシュ、サイズ、通知文を同じ変更で更新する。
過去の Release と資産は残す。同じタグのファイルを差し替えると、既存の期待ハッシュと一致せずビルドが失敗する。
旧モデルへ戻す場合は、manifest と通知文を以前の内容へ戻して再公開する。

モデル専用 Release は `--latest=false` で作成し、アプリの最新 Release と区別する。
アプリがブラウザで取得するモデルは、Release の URL ではなく同じサイトの静的資産である。
OCR のために PDF や画像を外部サービスへ送ることはない。

## 保存先と配信条件

HTTPS を使用し、WASM と JavaScript を適切な MIME type で配信する。
現在の構成では COOP/COEP は必須ではない。
ローカル開発 URL と GitHub Pages はオリジンが異なるため、ブラウザ内の作業コピーや独自モデルは移動しない。
移行時は `.eduba` を保存して開き直す。独自モデルも必要に応じて選び直す。
