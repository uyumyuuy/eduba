// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { allLines, exportHocr, exportText, type DocumentPage, type OcrChar, type OcrLine, type OcrWord, type Rect } from "./domain";
import { addOcrRegion, prepareRegionOcrImage, removeOcrLineAtPoint, removeOcrLinesInRegion, mergeOcrLinesInRegion } from "./ocrRegion";

function word(id: string, text: string, bbox: Rect): OcrWord {
  const chars: OcrChar[] = Array.from(text).map((value, index) => ({ index, originalText: value, correctedText: value, bbox: { ...bbox }, source: "ocr" }));
  return { id, bbox, originalText: text, correctedText: text, chars };
}
function line(id: string, text: string, bbox: Rect): OcrLine {
  const words = [word(id + "-word", text, bbox)];
  return { id, hocrClasses: ["ocr_line"], bbox, originalText: text, correctedText: text, words, chars: words[0].chars.map(char => ({ ...char })), geometryApproximate: false };
}
function page(lines: OcrLine[]): DocumentPage {
  return { id: "page-1", sourcePage: 1, split: "single", rotation: 0, angle: 0, width: 300, height: 300,
    blocks: [{ id: "block", bbox: { left: 80, top: 100, right: 220, bottom: 160 },
      paragraphs: [{ id: "paragraph", bbox: { left: 80, top: 100, right: 220, bottom: 160 }, lines }] }] };
}
const body = () => line("body", "Dies", { left: 80, top: 100, right: 130, bottom: 120 });
const marker = () => line("region-line", "15", { left: 31, top: 26, right: 44, bottom: 35 });
const selection = { left: 50, top: 90, right: 100, bottom: 135 };

describe("manual OCR region", () => {
  it("crops exactly the selected pixels, pads outside, and masks only intersecting OCR words", () => {
    const context = { fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: "" } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    const source = document.createElement("canvas");
    source.width = 300; source.height = 300;
    const input = prepareRegionOcrImage(source, selection, page([body()]), 20);
    expect([input.width, input.height]).toEqual([90, 85]);
    expect(context.drawImage).toHaveBeenCalledWith(source, 50, 90, 50, 45, 20, 20, 50, 45);
    expect(context.fillRect).toHaveBeenCalledWith(50, 30, 20, 20);
    vi.restoreAllMocks();
  });

  it("masks figure regions and import exclusions during manual region OCR", () => {
    const context={fillRect:vi.fn(),drawImage:vi.fn(),fillStyle:""};
    vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(context as never);
    const source=document.createElement("canvas");source.width=300;source.height=300;
    const initial=page([]);initial.figureRegions=[{id:"fig",kind:"figure",bbox:{left:70,top:100,right:90,bottom:120}}];
    initial.ocrMargins={top:0,bottom:0,left:20,right:0,inner:0,outer:0};
    prepareRegionOcrImage(source,selection,initial,20);
    expect(context.fillRect).toHaveBeenCalledWith(40,30,20,20);
    expect(context.fillRect).toHaveBeenCalledWith(20,20,10,45);
    vi.restoreAllMocks();
  });

  it("attaches a recognized margin number to the matching existing line and preserves page coordinates", () => {
    const initial = page([body()]);
    const result = addOcrRegion(initial, page([marker()]), selection, 20, "region-a");
    expect(result.addedLines).toBe(1);
    expect(allLines(initial)[0].correctedText).toBe("Dies");
    const merged = allLines(result.page)[0];
    expect(merged.correctedText).toBe("15 Dies");
    expect(merged.words[0].bbox).toEqual({ left: 61, top: 96, right: 74, bottom: 105 });
    expect(merged.words[0].chars[0].bbox?.left).toBe(61);
    expect(merged.bbox.left).toBe(61);
    expect(result.page.blocks[0].bbox.left).toBe(61);
    expect(result.page.manualOcrRegions?.[0].addedWordIds).toContain("region-line-word");
    expect(exportHocr([result.page])).toContain("bbox 61 96 74 105");
  });

  it("keeps existing corrections and shifts formatting when the new text is prefixed", () => {
    const edited = body();
    edited.correctedText = "Corrected";
    edited.formatting = [{ start: 0, end: 9, kind: "italic" }];
    const result = addOcrRegion(page([edited]), page([marker()]), selection, 20, "region-b");
    const merged = allLines(result.page)[0];
    expect(merged.originalText).toBe("15 Dies");
    expect(merged.correctedText).toBe("15 Corrected");
    expect(merged.formatting).toEqual([{ start: 3, end: 12, kind: "italic" }]);
  });

  it("inserts an unconnected result before the nearest line without changing existing reading order", () => {
    const isolated = { left: 50, top: 90, right: 75, bottom: 135 };
    const result = addOcrRegion(page([body()]), page([marker()]), isolated, 20, "region-c");
    expect(result.page.blocks).toHaveLength(2);
    expect(allLines(result.page).map(item => item.correctedText)).toEqual(["15", "Dies"]);
    expect(exportText([result.page])).toBe("15\n\nDies");
    expect(exportHocr([result.page]).indexOf("region-line-word")).toBeLessThan(exportHocr([result.page]).indexOf("body-word"));
  });

  it("keeps an ambiguous match independent and places it between nearby lines", () => {
    const second = line("second", "Other", { left: 150, top: 100, right: 200, bottom: 120 });
    const between = line("between", "X", { left: 40, top: 26, right: 55, bottom: 35 });
    const result = addOcrRegion(page([body(), second]), page([between]),
      { left: 110, top: 90, right: 170, bottom: 135 }, 20, "region-ambiguous");
    expect(allLines(result.page).map(item => item.correctedText)).toEqual(["Dies", "X", "Other"]);
    expect(result.page.manualOcrRegions?.[0].addedLineIds).toHaveLength(1);
  });

  it("places a region below all existing columns at the end of reading order", () => {
    const result = addOcrRegion(page([body()]), page([marker()]),
      { left: 50, top: 230, right: 75, bottom: 270 }, 20, "region-footer");
    expect(allLines(result.page).map(item => item.correctedText)).toEqual(["Dies", "15"]);
  });

  it("deletes entire overlapping lines and repairs empty paragraphs and boxes", () => {
    const first = body();
    const second = line("second", "Remains", { left: 80, top: 140, right: 165, bottom: 160 });
    const initial = page([first, second]);
    first.correctedText = "Edited text";
    const result = removeOcrLinesInRegion(initial, { left: 100, top: 110, right: 108, bottom: 115 });
    expect(result.removedLines).toBe(1);
    expect(allLines(result.page).map(item => item.id)).toEqual(["second"]);
    expect(result.page.blocks[0].bbox).toEqual(second.bbox);
    expect(exportText([result.page])).toBe("Remains");
    expect(exportHocr([result.page])).not.toContain("Edited text");
    expect(result.page.deletedOcrLineIds).toEqual(["body"]);
    expect(allLines(initial)).toHaveLength(2);
    expect(removeOcrLinesInRegion(initial, { left: 200, top: 100, right: 220, bottom: 120 }).page).toBe(initial);
  });

  it("clicks only one overlapping line and prunes deleted manual-region references", () => {
    const large = line("large", "Large", { left: 10, top: 10, right: 80, bottom: 40 });
    const small = line("small", "Small", { left: 20, top: 15, right: 35, bottom: 25 });
    const initial = page([large, small]);
    initial.manualOcrRegions = [{ id: "manual", bbox: small.bbox, psm: 11, addedWordIds: ["small-word"], addedLineIds: ["small"] }];
    const result = removeOcrLineAtPoint(initial, 25, 20);
    expect(result.removedLines).toBe(1);
    expect(allLines(result.page).map(item => item.id)).toEqual(["large"]);
    expect(result.page.manualOcrRegions).toBeUndefined();
    expect(removeOcrLineAtPoint(initial, 200, 200).page).toBe(initial);
  });

  it("joins adjacent same-row regions left to right and retains corrections and formatting", () => {
    const right = line("right", "text", { left: 100, top: 100, right: 140, bottom: 120 });
    const left = line("left", "15", { left: 60, top: 102, right: 75, bottom: 112 });
    right.correctedText = "corrected";
    right.formatting = [{ start: 0, end: 9, kind: "italic" }];
    const initial = page([right, left]);
    const result = mergeOcrLinesInRegion(initial, { left: 55, top: 95, right: 145, bottom: 125 });
    expect(result.mergedLines).toBe(2);
    const merged = allLines(result.page)[0];
    expect(allLines(result.page)).toHaveLength(1);
    expect(merged.id).toBe("right");
    expect(merged.originalText).toBe("15 text");
    expect(merged.correctedText).toBe("15 corrected");
    expect(merged.formatting).toEqual([{ start: 3, end: 12, kind: "italic" }]);
    expect(merged.bbox).toEqual({ left: 60, top: 100, right: 140, bottom: 120 });
    expect(merged.words.map(word => word.id)).toEqual(["left-word", "right-word"]);
    expect(merged.scriptDetectionManuallyEdited).toBe(true);
    expect(exportHocr([result.page])).toContain('id="right"');
    expect(allLines(initial)).toHaveLength(2);
  });

  it("merges lines across independent blocks and removes the empty block", () => {
    const a = line("a", "15", { left: 20, top: 100, right: 35, bottom: 115 });
    const b = line("b", "Text", { left: 45, top: 100, right: 100, bottom: 120 });
    const initial = page([a]);
    initial.blocks.push({ id: "manual-block", bbox: b.bbox, paragraphs: [{ id: "manual-paragraph", bbox: b.bbox, lines: [b] }] });
    initial.manualOcrRegions = [{ id: "manual", bbox: b.bbox, psm: 11, addedWordIds: ["b-word"], addedLineIds: ["b"] }];
    const result = mergeOcrLinesInRegion(initial, { left: 15, top: 95, right: 105, bottom: 125 });
    expect(result.page.blocks).toHaveLength(1);
    expect(allLines(result.page)[0].correctedText).toBe("15 Text");
    expect(result.page.manualOcrRegions?.[0].addedWordIds).toEqual(["b-word"]);
    expect(result.page.manualOcrRegions?.[0].addedLineIds).toEqual([]);
    expect(exportHocr([result.page])).toContain('id="b-word"');
  });

  it("rejects different rows and overlapping OCR, but merges nonconsecutive same-row lines", () => {
    const a = line("a", "A", { left: 10, top: 10, right: 40, bottom: 30 });
    const b = line("b", "B", { left: 50, top: 50, right: 80, bottom: 70 });
    const row = page([a, b]);
    expect(mergeOcrLinesInRegion(row, { left: 0, top: 0, right: 90, bottom: 75 }).reason).toBe("differentRows");
    const nearNextRow = line("next", "Next", { left: 50, top: 25, right: 80, bottom: 45 });
    expect(mergeOcrLinesInRegion(page([a, nearNextRow]), { left: 0, top: 0, right: 90, bottom: 50 }).reason).toBe("differentRows");
    const raisedNumber = line("raised", "15", { left: 50, top: 2, right: 62, bottom: 10 });
    expect(mergeOcrLinesInRegion(page([a, raisedNumber]), { left: 0, top: 0, right: 70, bottom: 35 }).mergedLines).toBe(2);
    const c = line("c", "C", { left: 30, top: 10, right: 60, bottom: 30 });
    expect(mergeOcrLinesInRegion(page([a, c]), { left: 0, top: 0, right: 70, bottom: 35 }).reason).toBe("overlap");
    const differentClass = line("header", "Heading", { left: 50, top: 10, right: 90, bottom: 30 });
    differentClass.hocrClasses = ["ocr_header"];
    expect(mergeOcrLinesInRegion(page([a, differentClass]), { left: 0, top: 0, right: 95, bottom: 35 }).reason).toBe("classes");
    const between = line("between", "Middle", { left: 0, top: 50, right: 10, bottom: 70 });
    const d = line("d", "D", { left: 70, top: 10, right: 90, bottom: 30 });
    const nonconsecutive = mergeOcrLinesInRegion(page([a, between, d]), { left: 0, top: 0, right: 95, bottom: 35 });
    expect(nonconsecutive.mergedLines).toBe(2);
    expect(allLines(nonconsecutive.page).map(item => item.id)).toEqual(["a", "between"]);
    expect(allLines(nonconsecutive.page)[0].correctedText).toBe("A D");
    expect(exportHocr([nonconsecutive.page]).indexOf('id="a"')).toBeLessThan(exportHocr([nonconsecutive.page]).indexOf('id="between"'));
  });

  it("leaves the page untouched when Tesseract returns no new words", () => {
    const initial = page([body()]);
    const result = addOcrRegion(initial, page([]), selection, 20, "region-d");
    expect(result.page).toBe(initial);
    expect(result.addedWords).toBe(0);
  });
});
