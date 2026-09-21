# EDUBA 初期スライス計画

## 受け入れ済みの要件

- PDF の各ページを画像として扱い、Tesseract hOCR をページ、ブロック、段落、行、語、文字の階層へ変換する。
- 認識文字列 (`originalText`) と校正文字列 (`correctedText`) を分離する。校正で挿入・移動した文字に、存在しない原画像の文字矩形を割り当てない。
- hOCR の `bbox`、`baseline`、`x_size`、`x_ascenders`、`x_descenders`、語・文字の confidence を保持する。
- 読み順をブロック、段落、行の順で保ち、TXT、hOCR、SVG（固定幅フォント、行座標、編集済みテキスト）へ書き出す。
- 左右見開きは、回転、deskew、左右分割、ページごとの crop の順で処理し、論理ページに元ページ番号、split、crop、回転角を記録する。元画像は変更しない。
- 候補文字 JSON は制御文字、過大な入力、無効な confidence を検証し、Unicode grapheme の範囲置換を提供する。

## 実装済みの範囲

`src/domain.ts` に上記のデータ型、hOCR パーサー、校正更新、エクスポーター、候補 JSON 検証、Canvas 前処理をまとめている。前処理は `processCanvas(source, { rotation: 90, split: "both", crop, deskew: true })` の形で呼び出す。deskew は ±5 度以内の水平投影探索で推定し、実際に Canvas を再描画する。

現在の UI は初期スライスとして、英語のスキャン本・論文を対象にする。bundled traineddata の選択、単一 `.eduba` プロジェクト、autosave、行クリック編集、現在ページと全ページの TXT/hOCR/SVG 出力を UI/Tauri 側で接続した。SVG の全ページ出力は ZIP にまとめる。

crop/deskew の操作 UI、OCR 領域の追加・削除・読順変更、候補文字のモデル固有マッピングと選択 UI、リッチな段落書式、1,000 ページ規模の性能確認、配布用インストーラー、非 Windows 対応は次段階である。

## 代表データでの確認

`tmp/ocr/sample-1-upright.hocr` と、回転・分割後の `tmp/ocr/sample-left-300.hocr` をローカル確認に使える。これらは機械的な構造確認用であり、OCR の正解率を保証する gold data ではない。
