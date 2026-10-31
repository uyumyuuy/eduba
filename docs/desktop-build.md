# GitHub Actions で Windows 版をビルドする

`.github/workflows/build-desktop.yml` は、手動実行で Windows x64 用の NSIS（`.exe`）と MSI（`.msi`）インストーラーを作る。Web サイトの公開ワークフローとは独立しており、push 時の自動実行や GitHub Releases への公開は行わない。

## 実行とダウンロード

ワークフローを main に反映した後、GitHub の **Actions → Build Windows desktop app → Run workflow** から対象のブランチを選んで実行する。

成功した実行の **Artifacts** にある `eduba-windows-x64-<実行番号>` をダウンロードする。保存期間は30日。中には次のファイルが入る。

- `Eduba_<version>_x64-setup.exe`：通常のインストール用
- `Eduba_<version>_x64_en-US.msi`：MSI を使う環境向け
- `BUILDINFO.json`：ソースのコミット、未コミット変更の有無、対象アーキテクチャ、モデル・候補表・ランタイムの識別情報
- `SHA256SUMS`：各成果物の SHA-256
- 基準モデルの通知文、Apache-2.0 のライセンス、元の provenance、モデル専用の校正候補表、`web-model.json`
- Tesseract のライセンスと取得元・ハッシュの記録

インストーラーは署名なしの確認用ビルド。起動時に Windows の警告が出る場合がある。インストール後は開発サーバーや別途インストールした Tesseract を必要としない。WebView2 が未導入の場合はインストーラーの標準処理で取得するため、初回インストールにネットワーク接続が必要になる場合がある。

## ビルドの構成

1. `windows-2022` ランナーに Node.js 24 と Rust 1.89.0、`x86_64-pc-windows-msvc` を用意する。
2. `npm ci` で lockfile に従ってフロントエンド依存関係を復元する。
3. Git 管理された traineddata・元の provenance・モデル専用校正候補表を `config/web-model.json` と照合する。モデルと候補表を組み合わせ、ライセンス・通知文とともにパッケージ用に準備する。
4. `config/windows-runtime.json` が指定する Tesseract 5.5.3 の Windows インストーラーを取得し、サイズと SHA-256 を検証する。ランナーにある 7-Zip で展開し、実行ファイル・DLL・付属ドキュメントを準備する。取得したインストーラー自体は実行しない。
5. `tauri build --no-bundle` で配布用の実行ファイルをコンパイルする。Cargo は `--locked` で実行する。
6. ONNX Runtime に付随する `DirectML.dll` などを明示的なリソースに加え、`tauri bundle` で NSIS と MSI を生成する。DLL はインストール先の実行ファイルと同じ階層に置く。traineddata は固定した基準モデルだけを列挙し、ローカルに残っている実験用モデルを混入させない。
7. インストーラー、識別情報、ライセンス、ハッシュをまとめ、Actions の Artifact に保存する。

フロントエンドと Tauri のビルドでもモデル・provenance・候補表を検証する。候補表だけが別モデルのものになっている場合も停止する。キャッシュは npm と Rust のビルド用で、Tesseract の取得物は使用前に必ずハッシュを照合する。

必要な GitHub 権限は `contents: read` のみ。個人用トークン、署名鍵、Release への書き込み権限は不要。公開サイト用の Analytics はブラウザ専用ビルドに限定され、デスクトップ版には挿入しない。

## モデルとランタイムの更新

基準モデルは `src-tauri/resources/models/<モデル名>.traineddata`、校正候補表は `src/assets/scan-candidate-character-confusions.json` として Git 管理する。モデル更新時は、元の provenance・通知文・`config/web-model.json`・既定モデル名と一緒に更新し、`.gitignore` の traineddata の許可対象も切り替える。置き換えた旧モデルは Git 管理から外す。

Tesseract を更新するときは `config/windows-runtime.json` のリポジトリ・タグ・ファイル名・サイズ・SHA-256・バージョンを同じ変更で更新する。取得元は [Tesseract 公式リリース](https://github.com/tesseract-ocr/tesseract/releases)。ハッシュは GitHub のリリース資産の digest と取得ファイルを照合する。

## ローカルで同じ手順を使う

Node.js、Rust、Visual Studio の C++ ビルド環境、7-Zip が必要。リポジトリのルートで実行する。

```powershell
npm ci
npm run prepare:desktop-model
./scripts/prepare-windows-runtime.ps1
npm run tauri -- build --ci --no-bundle --no-sign --target x86_64-pc-windows-msvc -- --locked
node scripts/desktop-artifacts.mjs prepare
npm run tauri -- bundle --ci --no-sign --target x86_64-pc-windows-msvc --bundles nsis,msi --config .cache/windows-build/tauri.bundle.json
node scripts/desktop-artifacts.mjs collect
```

成果物は `.cache/windows-build/artifacts/` に保存する。収集時は前回の成果物を混ぜないよう、空の出力ディレクトリを要求する。通常の `npm run tauri build` とは別の、CI と同じ DLL 明示同梱手順である。
