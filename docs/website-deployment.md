# Starlight とブラウザ版の公開

ドキュメントを `/eduba/`、ブラウザ版を `/eduba/app/` で配信する。
Vite で生成したアプリを `website/public/app/` にコピーしてから Astro をビルドし、
`website/dist/` 全体を GitHub Pages に公開する。アプリは Starlight のレイアウトに埋め込まず、独立したページとして開く。

## 固定する OCR モデル

`config/web-model.json` に Release のリポジトリ・タグ・ファイル名・SHA-256・サイズを記録する。
現在の対象は `eng_assyriology_charset_expanded_250x_20261023`（12,091,049 bytes）。
Assyrian-OCR が2026年10月24日に採用した学習・評価用の基準モデルを取り込んでいる。
文字集合拡張実験の250回/行チェックポイントで、モデル名の日付は実験開始日（10月23日）。最終300回/行チェックポイントは使用しない。
元の登録情報は `docs/ocr-model-provenance.json` にそのまま保存する。
配信・Release 用の準備時には、この記録の SHA-256 とモデル ID・モデルハッシュの対応も確認する。
学習側の `scan_candidate_generation` の既定値は別のモデルであり、この取り込みでは変更しない。
`latest` や可変のブランチ URL は使わない。
モデルの由来と配布条件は `docs/ocr-model-notice.txt` に記録する。
モデル専用の校正候補表も `src/assets/scan-candidate-character-confusions.json` に取り込む。Assyrian-OCR の現在の取り込み元は `data/eng_assyriology_charset_expanded_250x_20261023/scan-candidate-character-confusions.json`（173,482 bytes、SHA-256 `bd6b3836ccbf05313fdb9559f35fd23189087f63cca18c0cfd984d453ead0737`）。共通の `artifacts/scan-candidate-character-confusions.json` は別のモデル用なので使用しない。
`config/web-model.json` の `correctionCandidates` に保存先・取り込み元・サイズ・ハッシュを固定する。`npm run verify:model-pair` は候補表のバイト列・スキーマ・モデル key/SHA と、モデル出典の対応を確認する。モデルの取得時、アプリのビルド時、配布準備時にも照合し、不一致なら停止する。モデル本体のバイト列は取得・キャッシュ利用時に別途照合する。
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
npm run prepare:model-release -- --model 'src-tauri/resources/models/eng_assyriology_charset_expanded_250x_20261023.traineddata'
```

`.cache/model-release/ocr-model-20261023-charset-expanded-250x-candidates-20261027/` に、モデル、`SHA256SUMS`、
`web-model.json`、`OCR-MODEL-LICENSE.txt`、`OCR-MODEL-NOTICE.txt`、`OCR-MODEL-PROVENANCE.json`、`OCR-MODEL-CANDIDATES.json`、`RELEASE-NOTES.md` が生成される。`SHA256SUMS` にモデル本体と候補表の両方を記録する。
通知文を編集した場合は、公開前にこのコマンドを再実行する。
この準備コマンドは GitHub に書き込まない。

3. 配布条件と生成物を確認後、リポジトリのルートから Release を作成する。

```powershell
$releaseDir = '.cache/model-release/ocr-model-20261023-charset-expanded-250x-candidates-20261027'
gh release create ocr-model-20261023-charset-expanded-250x-candidates-20261027 `
  "$releaseDir/eng_assyriology_charset_expanded_250x_20261023.traineddata" `
  "$releaseDir/SHA256SUMS" `
  "$releaseDir/web-model.json" `
  "$releaseDir/OCR-MODEL-LICENSE.txt" `
  "$releaseDir/OCR-MODEL-NOTICE.txt" `
  "$releaseDir/OCR-MODEL-PROVENANCE.json" `
  "$releaseDir/OCR-MODEL-CANDIDATES.json" `
  --repo uyumyuuy/eduba --target main --latest=false `
  --title 'Assyrian-OCR model 20261023 charset-expanded 250x with candidates 20261027' `
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
npm run fetch:web-model -- --model 'src-tauri/resources/models/eng_assyriology_charset_expanded_250x_20261023.traineddata'
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

基準モデルの更新では traineddata・元の provenance・そのモデル専用の候補表を必ずセットで取り込む。Assyrian-OCR の `config/ocr-models.json` の `training_baseline` と `evaluation_baseline` を確認し、対応する `data/<model-key>/` から取得する。モデル key とハッシュを照合してから、manifest のモデル情報・出典ハッシュ・`correctionCandidates` の取り込み元とハッシュ/サイズ、通知文を同じ変更で更新する。デスクトップ版の既定モデル名とセットアップ用パスも合わせて更新する。
`npm run verify:model-pair`、ローカル traineddata を指定した `npm run fetch:web-model -- --model <path>`、`npm run prepare:model-release -- --model <path>` の順に対応を確認し、配信用ビルドを行う。
モデルまたは候補表を変更して公開する場合は別の Release タグを使用する。候補表だけを更新する場合も同様。
過去の Release と資産は残す。同じタグのファイルを差し替えると、既存の期待ハッシュと一致せずビルドが失敗する。
旧モデルへ戻す場合は、モデル・候補表・出典・manifest・通知文を対応する以前の組み合わせへ戻して再公開する。

モデル専用 Release は `--latest=false` で作成し、アプリの最新 Release と区別する。
アプリがブラウザで取得するモデルは、Release の URL ではなく同じサイトの静的資産である。
OCR のために PDF や画像を外部サービスへ送ることはない。

## 保存先と配信条件

HTTPS を使用し、WASM と JavaScript を適切な MIME type で配信する。
現在の構成では COOP/COEP は必須ではない。
ローカル開発 URL と GitHub Pages はオリジンが異なるため、ブラウザ内の作業コピーや独自モデルは移動しない。
移行時は `.eduba` を保存して開き直す。独自モデルも必要に応じて選び直す。
