# Eduba hOCR 出力仕様

仕様バージョン: **1**（2026-10-03）

## 適用範囲と変更ルール

この文書は Eduba の画面から出力する hOCR ファイルの契約を定義する。
基礎仕様は [hOCR 1.2](https://kba.github.io/hocr-spec/1.2/) であり、独自情報は同仕様の `x_` 拡張属性として `title` に記録する。
復元情報が完全なページでは、元 PDF とこのファイルだけで、出力された座標を元 PDF のページ座標へ変換できることを必須とする。不完全なページも OCR テキスト・図表領域を出力し、復元不可の状態と理由を明記する。`.eduba`、外部画像、インポート設定を復元のために要求しない。

**今後 hOCR 出力を変更するときは、同じ変更で必ずこの仕様書を更新する。** 対象は要素、属性、メタデータ、書式、読み順、前処理、座標系とその復元方法を含む。対応するテストも更新する。
公開済みの仕様に対して既存属性の意味・座標系・必須条件を変える場合は `eduba-hocr-version` を増やす。互換性を保つ任意属性の追加や説明の訂正ではバージョンを維持できるが、更新履歴を追加する。未公開の仕様を改訂する段階ではバージョンを上げず、初版にまとめる。

出力関数 `exportHocr` は元 PDF 情報を必須引数とする。ただし、復元情報が不足・不正であっても hOCR 出力は継続する。推測した変換行列を出力しない。

## ファイル構造

UTF-8、XML 宣言付き XHTML（名前空間 `http://www.w3.org/1999/xhtml`）として `.html` に保存する。
`head` に `eduba-hocr-version`（値 `1`）と `ocr-capabilities` を記録する。
さらに `eduba-hocr-coordinates` を記録し、全ページ復元可能なら `complete`、1 ページでも復元不可なら `incomplete` とする。
`ocr-capabilities` は出力し得る OCR クラス、および全プロパティの `ocrp_` 宣言を列挙する。独自名は `x_eduba` の後に小文字英数字のみを使う。
プロパティは `title` 内の `; ` 区切り。数値はロケールに依存しない十進表記（小数・負数・指数表記を許す）。XML の特殊文字はエスケープする。文字列値は二重引用符で囲む。

## 座標系

- hOCR の `bbox`、文字の `x_bboxes` は前処理済み論理ページのピクセル座標。原点は左上、X は右、Y は下。矩形値の順は `left top right bottom`。ページ境界は `0 0 width height`。
- 元 PDF 座標は `/Rotate` 適用前の PDF デフォルトユーザー空間。X は右、Y は上。原点を CropBox 左下へ移し替えない。非ゼロ・負のボックス原点をそのまま保つ。
- PDF 座標の 1 単位は `pdfUserUnit / 72` インチ。`x_edubapagetopdf` はこの PDF ユーザー単位を返す。物理ポイントへの変換が必要なら結果に `pdfUserUnit` を掛ける。
- PDF.js の viewport が扱うページの回転、可視ボックス、UserUnit、画像抽出時の異なる X/Y スケールは変換行列に含まれる。[PDF.js API](https://mozilla.github.io/pdf.js/api/draft/api.js.html)

## 各論理ページの必須属性

`ocr_page` は `bbox`、`ppageno`、`x_edubacoordinates` を必ず持つ。`x_edubacoordinates complete` のページは以下の復元属性をすべて持つ。不完全なページは確認できる属性だけを保持し、不正な数値や推測した行列は出力しない。分割した左右ページは同じ元 PDF ページを参照し、それぞれ独立した行列を持つ。

| プロパティ | 値と意味 |
| --- | --- |
| `bbox` | 前処理済み画像のピクセル境界 `0 0 width height` |
| `ppageno` | この出力ファイル内での論理ページ番号。0 始まり、重複なし。現在ページのみの出力では 0 |
| `x_edubacoordinates` | `complete`（復元可能）または `unavailable`（元 PDF 座標への復元不可） |
| `x_edubacoordinatereason` | `unavailable` 時に必須の理由コード。下記参照 |
| `x_source` | `"pdf:<fingerprint>" "<sourcePage>"`。元 PDF 識別子と 1 始まりの物理ページ番号 |
| `x_edubapdffingerprint` | PDF.js の最初の fingerprint を引用文字列として記録。PDF 識別の補助であり暗号学的な同一性保証ではない |
| `x_edubapdfbytes` | 元 PDF ファイルのバイト数 |
| `x_edubasourcepage` | 元 PDF の 1 始まりの物理ページ番号。印刷されたページ番号ではない |
| `x_edubapdfbox` | PDF.js `page.view` の `xMin yMin xMax yMax`。通常は有効な MediaBox/CropBox の可視範囲 |
| `x_edubapdfrotation` | PDF のページ回転 `/Rotate`（度）。Eduba の追加回転とは別 |
| `x_edubapdfuserunit` | PDF ページの UserUnit（指定がなければ 1） |
| `x_edubasourcesize` | Eduba の追加前処理前のページキャンバス `width height`（ピクセル）。埋め込み画像単体の画素数ではない |
| `x_edubasourcedpi` | 前処理前の実効 X/Y DPI（小数）。追加回転前の軸を使用 |
| `x_edubaimportmode` | 実際に使用した `extract` または `render`。フォールバック後の値 |
| `x_edubasplit` | `single`、`left`、`right`。Eduba 追加回転後の見開きの側 |
| `x_edubarotation` | Eduba の追加回転角（度、画像座標で正は時計回り） |
| `x_edubadeskew` | 保存済みの適用角（度、画像座標で正は時計回り）。再推定しない |
| `x_edubapreprocessorder` | `split-deskew` または `deskew-split`。追加回転は常に先、crop は常に最後 |
| `x_edubacrop` | 指定なしは `none`。指定ありは分割・deskew 後の座標で `left top right bottom`（指定値） |
| `x_edubapagetopdf` | hOCR ピクセルから元 PDF ユーザー空間へのアフィン変換 `a b c d e f`（小数を丸めず記録） |

`image` は出力に対応する外部画像を保存しないため省略する。`lpageno` は印刷ページ番号の認識を保証できないため省略する。適用済みの回転履歴を `textangle` として出力しない。PDF 本体・画像データは hOCR に埋め込まない。

## 座標の復元手順

1. `eduba-hocr-version` が対応可能な値であることを確認する。バージョン 1 はページ単位の復元状態を記録する。
2. fingerprint とバイト数を元 PDF と照合する。fingerprint は識別補助なので、信頼できる元 PDF を使用する。
3. 各 `ocr_page` の `x_edubacoordinates` を確認する。`unavailable` のページは元 PDF 座標に変換せず、OCR のページ座標だけを使用する。`complete` のページは `x_edubasourcepage` で PDF ページを選ぶ。
4. `x_edubapagetopdf` の 6 数値を読み、任意の hOCR 点 `(x,y)` を以下で変換する。

```text
pdfX = a*x + c*y + e
pdfY = b*x + d*y + f
```

例: `0.24 0 0 -0.24 120 800` なら `(10,20)` は PDF 座標 `(122.4,795.2)` になる。
矩形は左上・右上・右下・左下の **4 隅すべて** を変換する。deskew がある場合、結果は四角形となる。PDF 上の軸平行な矩形が必要なら、変換後の 4 隅の min/max を取る。
逆変換が必要なら行列を反転する。determinant は `a*d-b*c`。行の baseline なども、そのピクセル座標上の点を求めてから変換する。

**復元は行列を正とし、角度・DPI から再計算しない。** 行列にはキャンバス寸法の丸め、中央回転、拡張余白、右半分の平行移動、crop の実際の切り出し原点をすべて含める。
余白上の点は PDF の可視領域外に対応する場合がある。必要なら `x_edubapdfbox` でクリップする。切り落とされた文字や画像の欠落部分、編集で失われた文字別座標は復元できない。

## 前処理の定義と既存プロジェクト

元 PDF を render または extract で左上原点のページキャンバスへ写す。extract は画像の PDF 内配置、回転・反転・対応可能な clip をページ上へ再現するため、その埋め込み画像の行列を別途適用する必要はない。
その後、Eduba の追加回転をキャンバス中心に適用する。90/270 度は寸法を交換する。

`split-deskew` は追加回転 → 分割 → 各半分の deskew → crop。
分割は `floor(width/2)` を境界とし、奇数幅の余りは右へ渡す。deskew 時は回転後の画像が入るよう幅・高さを ceil で拡張し、中心を移動する。
`deskew-split` は追加回転 → deskew → 分割 → crop。旧形式との互換性のため deskew 時のキャンバスは拡張しない。
プロジェクトに処理順がない場合は `deskew-split` とする。

crop は left/top を floor して 0 以上に、right/bottom を ceil してキャンバス境界以下に制限する。行列にはこの実際の left/top を使う。指定値は監査用に別途記録する。
OCR 禁止範囲は白くマスクするだけで座標を移動しないため、復元行列に影響しない。

出力時は元 PDF と保存済みの前処理条件から実際のキャンバスと行列を計算する。既存プロジェクトでも前処理履歴の既定値を反映する。描画 DPI が論理ページ情報にない場合は、保存済み OCR の X/Y DPI から復元を試みる。保存済み hOCR の幅・高さと一致しない場合、抽出モードを再現できない場合、元 PDF・変換情報がない場合も、当該ページの復元情報を不完全として出力を継続する。他のページの正しい変換情報は保持する。

## 不完全な復元情報

`x_edubacoordinates unavailable` のページでは `x_edubapagetopdf` を必ず省略し、`x_edubacoordinatereason` を記録する。復元不可のページでも OCR テキスト、書式、既存 bbox、図表、読み順は保持する。

| 理由コード | 意味 |
| --- | --- |
| `missing-source` | 元 PDF、その識別情報、元ページ番号、または論理ページ情報が不足 |
| `missing-geometry` | 座標変換情報が未提供 |
| `invalid-geometry` | 非有限数、不正な寸法・解像度、反転できない行列など |
| `coordinate-mismatch` | 前処理済み画像の寸法が保存済み OCR 座標系と一致しない |
| `reconstruction-failed` | PDF 描画・画像抽出・前処理の再現処理に失敗 |

これらはページ単位の復元能力を表す。ファイル全体の出力失敗を意味しない。不完全なページがある場合は、出力後の画面にもその旨を通知する。ファイルへの書き込みエラー、保存済み OCR データ自体の読み取りエラーなどは従来どおり出力失敗となる。

## 本文、図表、読み順、書式

- ページは選択した出力対象の論理ページ順。保存済み OCR データのないページは出力対象外。
- テキストは `ocr_carea` → `ocr_par` → 行（通常 `ocr_line`、保存されている行クラスを維持）→ `ocrx_word` → `ocrx_cinfo`。ブロック・段落・行・語の bbox を出力する。要素 ID は XML エスケープする。
- ページ内のテキスト行と図表は、保存された読み順に従う。図表が段落途中にある場合はテキストのコンテナを分割する。コンテナ ID に断片識別子が付く場合がある。
- 図は空の `div.ocr_image`、表は空の `div.ocr_table`。ID と bbox を持つ。画像は hOCR に埋め込まず、元 PDF と変換行列から切り出せる。図表中の OCR 文字の重複を許す。
- 語の信頼度は `x_wconf`、文字の信頼度は拡張 `x_conf`（存在する場合）。文字 bbox は `x_bboxes`（存在する場合）。文字座標がない場合は座標を捏造しない。
- 行の baseline は保存された `slope intercept`、行の文字サイズは保存された `x_size`（存在する場合）。baseline の intercept は行 bbox 底辺からの相対値。
- 校正で行テキストが変わった場合は、行 bbox を持つ単一 `ocrx_word` に校正後文字列を出力する。元の語・文字 bbox は校正後文字列に対応しないため出力しない。
- 書式は `em`（斜体）、`strong`（太字）、`sup`、`sub`。XML 特殊文字をエスケープする。未校正語間には空白を挿入する。

## 更新履歴

- 2026-10-03: 未公開の初版（バージョン 1）を定義。元 PDF ページ情報、前処理履歴、PDF 座標復元行列、文書・ページ単位の復元状態と理由、capabilities 宣言を含む。復元不可のページも出力を継続する。
