import { describe, expect, it, vi } from "vitest";
import type { DocumentPage, OcrLine } from "./domain";
import { inferWordStyles, wordStyleSamples } from "./styleDetection";

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
    expect(result.blocks[0].paragraphs[0].lines[0].autoFormatting).toContainEqual({ start: 2, end: 3, kind: "bold" });
    expect(result.blocks[0].paragraphs[0].lines[1].autoFormatting).toBeUndefined();
    expect(result.blocks[0].paragraphs[0].lines[2].autoFormatting).toContainEqual({ start: 0, end: 2, kind: "italic" });
  });
});
