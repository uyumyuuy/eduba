# 初期スライス検証

2026-09-21 に Windows の Tauri デバッグ実行で `sample.pdf` を使い、次を確認した。

- ネイティブメニューから読み込み、5 ページの PDF を `.eduba` プロジェクトに保存した。
- 見開きプリセットにより、各ページを 90°時計回りに回転し、10 論理ページへ分割した。
- bundled Tesseract で現在ページの OCR を実行した。
- 先頭行へ `[QA]` を追記し、Undo で除去、Redo で復元した。
- アプリを閉じて再起動し、同じプロジェクトを開いたところ `[QA]` が残っていた。
- 残り 9 ページの OCR を完了し、先頭ページの修正が維持されていることを確認した。
- TXT（24,468 文字）、hOCR（10 個の `ocr_page`）、SVG ZIP（10 個の有効な SVG）を出力し、いずれにも `[QA]` が含まれた。

当時の記録では、Rust のバックエンド単体テスト 2 件、実 Tesseract 統合テスト 1 件、フロントエンド/ドメイン/保存キューの 12 テスト、および最新のネイティブビルドを通過している。これは過去の実行記録であり、2026-09-30 時点の main のテスト実行結果ではない。

## 2026-09-30 時点のソース監査

対象 main は 92732f1。コードと履歴から、OCR 領域の追加・削除・統合、読順編集、候補選択 UI の接続を確認した。詳細なコミットは requirements-plan.md に記載する。

テストソースの棚卸しでは、Vitest のテストファイル 20 個に 129 個の test/it 呼び出しがある（うち 1 個は it.each による複数ケース）。App.test.tsx は 29 呼び出し、ocrRegion.test.ts は 12、readingOrder.test.ts は 3、correctionCandidates.test.ts は 4。Rust の #[test] は 22 件（lib.rs 11、preferences.rs 6、style_classifier_runtime/lib.rs 5）。モデルの CPU 推論テストもソースにある。

package.json には npm test と npm run build があり、cargo test --manifest-path src-tauri/Cargo.toml --lib で Rust ライブラリテストを実行できる。テストコードの存在は実行成功を意味しない。確認時点で GitHub Actions の main の workflow run は 0 件、92732f1 の commit status は空だったため、このリビジョンのテスト通過は確認できない。

2026-09-21 の Windows デバッグ実行は領域・読順機能の 2026-09-23 コミットより前であり、候補選択 UI の手動操作も記録されていない。このため、領域の追加・削除・統合、読順編集、候補 UI と実データでの候補品質は実機未確認である。crop/deskew 操作 UI、1,000 ページ規模の PDF、長時間 OCR の中断復帰、Windows インストーラー・portable 版、非 Windows 環境も未確認。
