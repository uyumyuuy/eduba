// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { OcrLine, OcrWord } from "./domain";
import { caretImagePosition } from "./EditImageFocus";

function line(correctedText = "ABCD"): OcrLine {
  const chars = Array.from("ABCD").map((text, index) => ({ index, originalText: text, correctedText: text,
    bbox: { left: 10 + 10 * index, top: 20, right: 20 + 10 * index, bottom: 35 }, source: "ocr" as const }));
  const word: OcrWord = { id: "word", originalText: "ABCD", correctedText: "ABCD",
    bbox: { left: 10, top: 20, right: 50, bottom: 35 }, chars };
  return { id: "line", bbox: { left: 5, top: 18, right: 55, bottom: 38 }, originalText: "ABCD",
    correctedText, words: [word], chars: correctedText === "ABCD" ? chars : [], geometryApproximate: correctedText !== "ABCD" };
}

describe("edit image focus", () => {
  it("uses OCR character boxes for a caret and the last character at line end", () => {
    expect(caretImagePosition(line(), 2)).toEqual({ x: 30, bbox: { left: 30, top: 20, right: 40, bottom: 35 } });
    expect(caretImagePosition(line(), 4).x).toBe(50);
  });

  it("keeps scan position aligned after corrected characters are inserted", () => {
    const edited = line("ABxxCD");
    expect(caretImagePosition(edited, 4)).toEqual({ x: 30, bbox: { left: 30, top: 20, right: 40, bottom: 35 } });
    const inserted = caretImagePosition(edited, 3);
    expect(inserted.x).toBe(30);
  });

  it("falls back to the line width when OCR glyphs are unavailable", () => {
    const missing = line();
    missing.words = [];
    const position = caretImagePosition(missing, 2);
    expect(position.x).toBe(30);
    expect(position.bbox.left).toBe(30);
  });
});
