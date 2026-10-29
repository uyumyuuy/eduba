import { exportFixtureHocr as exportHocr } from "./testSupport/hocr";
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { allLines, exportText, type DocumentPage, type OcrLine, type Rect } from "./domain";
import { lineIdsCrossed, moveLineAfter, reorderPageLines } from "./readingOrder";

function line(id: string, bbox: Rect): OcrLine {
  return { id, bbox, hocrClasses: ["ocr_line"], originalText: id, correctedText: id,
    words: [], chars: [], geometryApproximate: false };
}
function page(): DocumentPage {
  const a = line("a", { left: 10, top: 10, right: 40, bottom: 25 });
  const b = line("b", { left: 10, top: 30, right: 40, bottom: 45 });
  const c = line("c", { left: 60, top: 10, right: 90, bottom: 25 });
  return { id: "page", width: 100, height: 100, sourcePage: 1, split: "single", rotation: 0, angle: 0,
    blocks: [
      { id: "block-a", bbox: { left: 10, top: 10, right: 40, bottom: 45 },
        paragraphs: [{ id: "paragraph-a", bbox: { left: 10, top: 10, right: 40, bottom: 45 }, lines: [a, b] }] },
      { id: "block-c", bbox: c.bbox,
        paragraphs: [{ id: "paragraph-c", bbox: c.bbox, lines: [c] }] },
    ] };
}

describe("reading order", () => {
  it("moves each chosen line immediately after the active anchor", () => {
    const initial = ["a", "b", "c", "d"];
    const afterC = moveLineAfter(initial, "a", "c");
    expect(afterC).toEqual(["a", "c", "b", "d"]);
    expect(moveLineAfter(afterC, "c", "d")).toEqual(["a", "c", "d", "b"]);
    expect(initial).toEqual(["a", "b", "c", "d"]);
  });

  it("reorders across blocks while preserving line IDs, classes, coordinates, and hOCR order", () => {
    const initial = page();
    const result = reorderPageLines(initial, ["a", "c", "b"]);
    expect(allLines(result).map(item => item.id)).toEqual(["a", "c", "b"]);
    expect(result.blocks.map(block => block.id)).toEqual(["block-a", "block-c", "block-a--order-2"]);
    expect(allLines(result)[2].bbox).toEqual(allLines(initial)[1].bbox);
    expect(allLines(result)[2].hocrClasses).toEqual(["ocr_line"]);
    expect(exportText([result])).toBe("a\n\nc\n\nb");
    const hocr = exportHocr([result]);
    expect(hocr.indexOf('id="a"')).toBeLessThan(hocr.indexOf('id="c"'));
    expect(hocr.indexOf('id="c"')).toBeLessThan(hocr.indexOf('id="b"'));
    expect(allLines(initial).map(item => item.id)).toEqual(["a", "b", "c"]);
    expect(reorderPageLines(result, ["a", "b", "c"]).blocks.map(block => block.id)).toEqual(["block-a", "block-c"]);
  });

  it("detects narrow regions crossed between pointer events in path order", () => {
    const lines = allLines(page());
    expect(lineIdsCrossed(lines, { x: 20, y: 0 }, { x: 20, y: 55 })).toEqual(["a", "b"]);
    expect(lineIdsCrossed(lines, { x: 99, y: 20 }, { x: 0, y: 20 })).toEqual(["c", "a"]);
    expect(lineIdsCrossed(lines, { x: 0, y: 70 }, { x: 99, y: 70 })).toEqual([]);
  });
});
