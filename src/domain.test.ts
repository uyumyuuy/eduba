import { exportFixtureHocr as exportHocr } from "./testSupport/hocr";
import { describe, expect, it } from "vitest";
import {
  escapeXml,
  effectiveFormatting,
  exportSvg,
  exportText,
  parseCandidateMap,
  parseHocr,
  replaceGrapheme,
  splitLineAtCaret,
  updateLineFormatting,
  updateLineText,
} from "./domain";

const fixture = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>
  <div class="ocr_page" id="page_1" title="bbox 0 0 200 100; ppageno 0">
    <div class="ocr_carea" id="block_1" title="bbox 10 10 190 80"><p class="ocr_par" id="par_1" title="bbox 10 10 190 80">
      <span class="ocr_line" id="line_1" title="bbox 10 20 190 35; baseline 0 32; x_size 15; x_descenders 3; x_ascenders 4">
        <span class="ocrx_word" id="page_1--page_1--word_1" title="bbox 10 20 55 35; x_wconf 91">
          <span class="ocrx_cinfo" title="x_bboxes 10 20 18 35; x_conf 98">A</span>
          <span class="ocrx_cinfo" title="x_bboxes 19 20 27 35; x_conf 95">🙂</span>
        </span>
        <span class="ocrx_word" id="word_2" title="bbox 60 20 100 35; x_wconf 80">book</span>
      </span>
    </p></div>
  </div>
</body></html>`;

describe("hOCR domain model", () => {
  it("retains page hierarchy, reading order, geometry, and character confidence", () => {
    const [page] = parseHocr(fixture);
    const line = page.blocks[0].paragraphs[0].lines[0];
    expect(page.width).toBe(200);
    expect(line.originalText).toBe("A🙂 book");
    expect(line.baseline).toEqual({ slope: 0, intercept: 32 });
    expect(line.fontSize).toBe(15);
    expect(line.words[0].chars[1].bbox).toEqual({ left: 19, top: 20, right: 27, bottom: 35 });
    expect(line.words[0].chars[1].confidence).toBe(95);
  });

  it("imports all Tesseract text-line classes once in document order", () => {
    const variants = [
      ["ocr_textfloat", "first"],
      ["ocr_line", "second"],
      ["ocr_header ocr_line", "third"],
      ["ocr_caption", "fourth"],
    ];
    const lines = variants.map(([className, word], index) =>
      `<span class="${className}" id="line_${index}" title="bbox 10 ${10 + index * 20} 100 ${25 + index * 20}">
        <span class="ocrx_word" id="word_${index}" title="bbox 10 ${10 + index * 20} 100 ${25 + index * 20}">${word}</span>
      </span>`,
    ).join("");
    const hocr = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
      <div class="ocr_page" title="bbox 0 0 200 100">
        <div class="ocr_carea" title="bbox 0 0 200 100">
          <p class="ocr_par" title="bbox 0 0 200 100">${lines}</p>
        </div>
      </div>
    </body></html>`;
    const parsed = parseHocr(hocr)[0].blocks[0].paragraphs[0].lines;
    expect(parsed.map((line) => line.originalText)).toEqual(["first", "second", "third", "fourth"]);
    expect(parsed.map((line) => line.id)).toEqual(["page-0--line_0", "page-0--line_1", "page-0--line_2", "page-0--line_3"]);
    expect(parsed.map((line) => line.bbox.top)).toEqual([10, 30, 50, 70]);
    expect(parsed.map((line) => line.hocrClasses)).toEqual([
      ["ocr_textfloat"],
      ["ocr_line"],
      ["ocr_header", "ocr_line"],
      ["ocr_caption"],
    ]);
    const savedPages = JSON.parse(JSON.stringify(parseHocr(hocr)));
    const exported = exportHocr(savedPages);
    expect(exported).toContain("class=\"ocr_textfloat\"");
    expect(exported).toContain("class=\"ocr_header ocr_line\"");
    expect(exported).toContain("class=\"ocr_caption\"");
  });

  it("exports ocr_line for older saved lines without class metadata", () => {
    const [page] = parseHocr(fixture);
    const line = page.blocks[0].paragraphs[0].lines[0];
    delete line.hocrClasses;
    expect(exportHocr([page])).toContain("class=\"ocr_line\"");
  });

  it("keeps OCR text distinct from Unicode corrections and marks inserted graphemes", () => {
    const [page] = parseHocr(fixture);
    const line = page.blocks[0].paragraphs[0].lines[0];
    const edited = updateLineText(page, line.id, "A🙂 revised");
    expect(line.originalText).toBe("A🙂 book");
    expect(line.correctedText).toBe("A🙂 book");
    const editedLine = edited.blocks[0].paragraphs[0].lines[0];
    expect(editedLine.correctedText).toBe("A🙂 revised");
    expect(editedLine.geometryApproximate).toBe(true);
    expect(editedLine.chars.find(char => char.correctedText === "r")?.source).toBe("inserted");
    expect(editedLine.chars.find(char => char.correctedText === "r")?.bbox).toBeUndefined();
  });

  it("exports escaped text, corrected SVG, and hOCR without false inserted boxes", () => {
    const [page] = parseHocr(fixture);
    const line = page.blocks[0].paragraphs[0].lines[0];
    const edited = updateLineText(page, line.id, "A🙂 <edited>");
    expect(exportText([edited])).toContain("A🙂 <edited>");
    expect(exportSvg(edited)).toContain("&lt;edited&gt;");
    const hocr = exportHocr([edited]);
    expect(hocr).toContain("A🙂 &lt;edited&gt;");
    expect(hocr).not.toContain("x_bboxes 0 0 0 0");
    expect(hocr).not.toContain("x_bboxes 10 20 18 35");
  });

  it("keeps word and character geometry while exporting inferred italic and bold formatting", () => {
    const [page] = parseHocr(fixture);
    const line = page.blocks[0].paragraphs[0].lines[0];
    line.autoFormatting = [
      { start: 0, end: 1, kind: "italic" },
      { start: 4, end: 8, kind: "bold" },
    ];
    const hocr = exportHocr([page]);
    expect(hocr).toMatch(/class="ocrx_word" id="[^"]*word_1" title="bbox 10 20 55 35; x_wconf 91"/);
    expect(hocr).toContain('class="ocrx_cinfo" title="x_bboxes 10 20 18 35; x_conf 98"><em>A</em></span>');
    expect(hocr).toContain('class="ocrx_word" id="page_1--word_2" title="bbox 60 20 100 35; x_wconf 80"><span class="ocrx_cinfo"><strong>b</strong></span>');
    expect(parseHocr(hocr)[0].blocks[0].paragraphs[0].lines[0].words.map(word => word.bbox)).toEqual(line.words.map(word => word.bbox));
  });

  it("lets either manual script choice replace automatic superscript or subscript", () => {
    const [page] = parseHocr(fixture);
    const line = page.blocks[0].paragraphs[0].lines[0];
    line.autoFormatting = [{ start: 1, end: 3, kind: "superscript" }];
    line.formatting = [{ start: 2, end: 4, kind: "subscript" }];
    expect(effectiveFormatting(line)).toEqual([
      { start: 1, end: 2, kind: "superscript" },
      { start: 2, end: 4, kind: "subscript" },
    ]);
  });
  it("exports the complete edited line, including inserted words", () => {
    const [page] = parseHocr(fixture);
    const line = page.blocks[0].paragraphs[0].lines[0];
    const edited = updateLineText(page, line.id, "A cat & dog");
    const hocr = exportHocr([edited]);
    expect(hocr).toContain("A cat &amp; dog");
    expect(exportText([edited])).toContain("A cat & dog");
    expect(parseHocr(hocr)[0].blocks[0].paragraphs[0].lines[0].originalText).toBe("A cat & dog");
  });

  it("does not reuse character boxes when a single-word line is edited", () => {
    const [page] = parseHocr(fixture);
    const line = page.blocks[0].paragraphs[0].lines[0];
    line.words = [line.words[0]];
    const edited = updateLineText(page, line.id, "replaced");
    const hocr = exportHocr([edited]);
    expect(hocr).toContain(">replaced</span>");
    expect(hocr).not.toContain("x_bboxes 10 20 18 35");
  });
});

describe("safe editing helpers", () => {
  it("escapes all XML-sensitive characters", () => {
    expect(escapeXml(`<a x='1'>&"`)).toBe("&lt;a x=&apos;1&apos;&gt;&amp;&quot;");
  });

  it("replaces a grapheme without splitting a surrogate pair", () => {
    expect(replaceGrapheme("a🙂b", 1, 2, "𒀭")).toBe("a𒀭b");
  });

  it("validates candidate JSON and rejects control characters", () => {
    expect(parseCandidateMap('{"a":[{"text":"𒀭","confidence":0.9}]}').a[0].text).toBe("𒀭");
    expect(() => parseCandidateMap('{"a":[{"text":"bad\\u0000"}]}')).toThrow();
  });
});


describe("line formatting", () => {
  it("keeps superscript and subscript mutually exclusive while toggling only the selection", () => {
    const [page] = parseHocr(fixture);
    const line = page.blocks[0].paragraphs[0].lines[0];
    const superscripted = updateLineFormatting(page, line.id, 1, 5, "superscript");
    const formatted = updateLineFormatting(superscripted, line.id, 3, 7, "subscript");

    expect(formatted.blocks[0].paragraphs[0].lines[0].formatting).toEqual([
      { start: 1, end: 3, kind: "superscript" },
      { start: 3, end: 7, kind: "subscript" },
    ]);
    const toggled = updateLineFormatting(formatted, line.id, 3, 7, "subscript");
    expect(toggled.blocks[0].paragraphs[0].lines[0].formatting).toEqual([
      { start: 1, end: 3, kind: "superscript" },
    ]);
  });

  it("remaps formatting around an edit and exports semantic and visual formatting", () => {
    const [page] = parseHocr(fixture);
    const line = page.blocks[0].paragraphs[0].lines[0];
    const bold = updateLineFormatting(page, line.id, 4, 8, "bold");
    const edited = updateLineText(bold, line.id, "A🙂 new book");
    const editedLine = edited.blocks[0].paragraphs[0].lines[0];

    expect(editedLine.formatting).toEqual([{ start: 8, end: 12, kind: "bold" }]);
    expect(exportText([edited])).toBe("A🙂 new book");
    expect(exportHocr([edited])).toContain("<strong>book</strong>");
    expect(exportSvg(edited)).toContain('<tspan font-weight="bold">book</tspan>');
    expect(exportSvg(edited)).toContain('font-family="Noto Serif"');
  });
});

describe("line splitting", () => {
  it("splits a merged two-column line at its separator with distinct boxes and a preserved baseline", () => {
    const [page] = parseHocr(fixture);
    const line = page.blocks[0].paragraphs[0].lines[0];
    line.words[1].bbox.bottom = 40;
    const split = splitLineAtCaret(page, line.id, 4);
    const lines = split.blocks[0].paragraphs[0].lines;
    expect(lines.map(item => item.correctedText)).toEqual(["A🙂", "book"]);
    expect(lines.map(item => item.originalText)).toEqual(["A🙂", "book"]);
    expect(lines[0].bbox.right).toBe(27);
    expect(lines[1].bbox.left).toBe(60);
    expect(lines[0].baseline?.intercept).toBe(32);
    expect(lines[1].baseline?.intercept).toBe(27);
    expect(lines[1].hocrClasses).toEqual(["ocr_line"]);
    expect(exportText([split])).toBe("A🙂\nbook");
  });

  it("splits inside an OCR word, partitions character boxes, and remaps formatting", () => {
    const [page] = parseHocr(fixture);
    const line = page.blocks[0].paragraphs[0].lines[0];
    const formatted = updateLineFormatting(page, line.id, 0, 3, "bold");
    const split = splitLineAtCaret(formatted, line.id, 1);
    const lines = split.blocks[0].paragraphs[0].lines;
    expect(lines.map(item => item.correctedText)).toEqual(["A", "🙂 book"]);
    expect(lines[0].words[0].bbox.right).toBe(18);
    expect(lines[1].words[0].bbox.left).toBe(19);
    expect(lines[0].formatting).toEqual([{ start: 0, end: 1, kind: "bold" }]);
    expect(lines[1].formatting).toEqual([{ start: 0, end: 2, kind: "bold" }]);
  });

  it("uses LCS anchors for an edited line and refuses a split with no reliable alignment", () => {
    const [page] = parseHocr(fixture);
    const line = page.blocks[0].paragraphs[0].lines[0];
    const edited = updateLineText(page, line.id, "A🙂 corrected book");
    const split = splitLineAtCaret(edited, line.id, 12);
    expect(split.blocks[0].paragraphs[0].lines).toHaveLength(2);
    const unaligned = updateLineText(page, line.id, "different");
    expect(splitLineAtCaret(unaligned, line.id, 4)).toEqual(unaligned);
  });
});