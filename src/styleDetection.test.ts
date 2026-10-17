import { describe, expect, it, vi } from "vitest";
import type { DocumentPage, OcrLine } from "./domain";
import { applyWordStylePredictions, inferWordStyles, wordStyleSamples } from "./styleDetection";
import { exportFixtureHocr } from "./testSupport/hocr";

function makeLine(id: string, text: string, x: number, autoFormatting?: OcrLine["autoFormatting"]): OcrLine {
  const chars = Array.from(text).map((character, index) => ({
    index,
    originalText: character,
    correctedText: character,
    source: "ocr" as const,
    bbox: { left: x + index * 8, top: 2, right: x + index * 8 + 6, bottom: 10 },
  }));
  return {
    id,
    bbox: { left: x, top: 0, right: x + text.length * 8 + 2, bottom: 14 },
    originalText: text,
    correctedText: text,
    words: [{
      id: `${id}-word`, bbox: { left: x, top: 1, right: x + text.length * 8, bottom: 11 },
      originalText: text, correctedText: text, chars,
    }],
    chars,
    geometryApproximate: false,
    autoFormatting,
  };
}

function pageWithLines(lines: OcrLine[], width = 100): DocumentPage {
  return {
    id: "page", sourcePage: 0, split: "single", rotation: 0, angle: 0, width, height: 30,
    blocks: [{ id: "block", bbox: { left: 0, top: 0, right: width, bottom: 30 }, paragraphs: [{
      id: "paragraph", bbox: { left: 0, top: 0, right: width, bottom: 30 }, lines,
    }] }],
  };
}

describe("word style inference", () => {
  const italicPrediction = { italic: true, italic_probability: 1, bold: false, bold_probability: 0 };

  it.each([
    { text: "[(alpha-beta)]", spans: [[2, 7], [8, 12]] },
    { text: "«can't_stop»", spans: [[1, 4], [5, 6], [7, 11]] },
    { text: "（a—b−c＋d）", spans: [[1, 2], [3, 4], [5, 6], [7, 8]] },
    { text: "(𒀭-e\u0301🙂2)", spans: [[1, 3], [4, 6], [8, 9]] },
    { text: "()--+🙂", spans: [] },
  ])("keeps punctuation and symbols upright in $text", ({ text, spans }) => {
    const line = makeLine("line", text, 0);
    expect(wordStyleSamples(line).map(entry => entry.sample.text)).toEqual([text]);
    const page = applyWordStylePredictions(pageWithLines([line]), new Map([[line.id, [italicPrediction]]]));
    expect(page.blocks[0].paragraphs[0].lines[0].autoFormatting ?? []).toEqual(
      spans.map(([start, end]) => ({ start, end, kind: "italic" })),
    );
    expect(line.autoFormatting).toBeUndefined();
  });

  it("keeps line offsets and scripts when splitting italic ranges around symbols", () => {
    const line = makeLine("line", "(a) [b2-c]", 0, [{ start: 6, end: 7, kind: "superscript" }]);
    const samples = wordStyleSamples(line);
    expect(samples.map(entry => entry.sample.text)).toEqual(["(a)", "[b", "-c]"]);
    const page = applyWordStylePredictions(pageWithLines([line]), new Map([[line.id, samples.map(() => italicPrediction)]]));
    expect(page.blocks[0].paragraphs[0].lines[0].autoFormatting).toEqual([
      { start: 6, end: 7, kind: "superscript" },
      { start: 1, end: 2, kind: "italic" },
      { start: 5, end: 6, kind: "italic" },
      { start: 8, end: 9, kind: "italic" },
    ]);
  });

  it("exports inferred italic letters with upright symbols and unchanged hOCR geometry", () => {
    const line = makeLine("line", "(a-b)", 0);
    const original = pageWithLines([line]);
    const page = applyWordStylePredictions(original, new Map([[line.id, [italicPrediction]]]));
    const document = new DOMParser().parseFromString(exportFixtureHocr([page]), "application/xhtml+xml");
    expect(document.querySelector("parsererror")).toBeNull();
    const chars = Array.from(document.querySelectorAll(".ocrx_cinfo"));
    expect(chars.map(char => char.textContent)).toEqual(["(", "a", "-", "b", ")"]);
    expect(chars.map(char => Boolean(char.querySelector("em")))).toEqual([false, true, false, true, false]);
    expect(chars.map(char => char.getAttribute("title"))).toEqual(line.chars.map(char => {
      const box = char.bbox!;
      return `x_bboxes ${box.left} ${box.top} ${box.right} ${box.bottom}`;
    }));
    const box = line.words[0].bbox;
    expect(document.querySelector(".ocrx_word")?.getAttribute("title")).toBe(`bbox ${box.left} ${box.top} ${box.right} ${box.bottom}`);

    line.formatting = [{ start: 0, end: line.originalText.length, kind: "italic" }];
    const manual = applyWordStylePredictions(original, new Map([[line.id, [italicPrediction]]]));
    const manualDocument = new DOMParser().parseFromString(exportFixtureHocr([manual]), "application/xhtml+xml");
    expect(Array.from(manualDocument.querySelectorAll(".ocrx_cinfo em")).map(em => em.textContent)).toEqual(["(", "a", "-", "b", ")"]);
  });

  it("uses regular-height text runs and keeps predictions aligned when a later sample is outside the image", async () => {
    const scriptLine = makeLine("script", "A2B", 5, [{ start: 1, end: 2, kind: "superscript" }]);
    const outsideLine = makeLine("outside", "XX", 105);
    const regularLine = makeLine("regular", "CD", 45);
    const page = pageWithLines([scriptLine, outsideLine, regularLine]);
    expect(wordStyleSamples(scriptLine).map(entry => [entry.sample.text, entry.start, entry.end])).toEqual([
      ["A", 0, 1], ["B", 2, 3],
    ]);
    const classify = vi.fn(async (_image: string, samples: Array<{ text: string }>) => samples.map(sample => ({
      italic_probability: sample.text === "CD" ? 0.99 : 0.01,
      bold_probability: sample.text === "B" ? 0.99 : 0.01,
      italic: sample.text === "CD",
      bold: sample.text === "B",
    })));
    const result = await inferWordStyles(page, "png", 100, 30, classify);
    expect(classify.mock.calls[0][1].map(sample => sample.text)).toEqual(["A", "B", "CD"]);
    expect(result.blocks[0].paragraphs[0].lines[0].autoFormatting).toContainEqual({ start: 1, end: 2, kind: "superscript" });
    expect(result.blocks[0].paragraphs[0].lines[0].autoFormatting).toEqual([{ start: 1, end: 2, kind: "superscript" }]);
    expect(result.blocks[0].paragraphs[0].lines[1].autoFormatting).toBeUndefined();
    expect(result.blocks[0].paragraphs[0].lines[2].autoFormatting).toContainEqual({ start: 0, end: 2, kind: "italic" });
  });

  it("ignores confident bold predictions while retaining italic, scripts and manual bold", () => {
    const automatic = makeLine("automatic", "AB", 5, [{ start: 0, end: 1, kind: "bold" }]);
    const manual = makeLine("manual", "CD", 35);
    manual.formatting = [{ start: 0, end: 2, kind: "bold" }];
    const page = pageWithLines([automatic, manual]);
    const prediction = { italic: true, italic_probability: 1, bold: true, bold_probability: 1 };
    const result = applyWordStylePredictions(page, new Map([["automatic", [prediction]], ["manual", [prediction]]]));
    const lines = result.blocks[0].paragraphs[0].lines;
    expect(lines[0].autoFormatting).toEqual([{ start: 0, end: 2, kind: "italic" }]);
    expect(lines[1].formatting).toEqual(manual.formatting);
    expect(lines[1].autoFormatting).toBeUndefined();
    expect(automatic.autoFormatting).toEqual([{ start: 0, end: 1, kind: "bold" }]);
  });
});
