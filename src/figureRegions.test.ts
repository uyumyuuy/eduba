import { describe, expect, it } from "vitest";
import { allLines, exportHocr, exportSvg, type DocumentPage } from "./domain";
import { addFigureRegion, nonWhiteBounds, preserveFiguresAfterOcr, removePageRegions } from "./figureRegions";
import { pageItems } from "./pageContent";
import { reorderPageItems } from "./readingOrder";
import { createReadableHtml } from "./readableHtml";

function page(): DocumentPage {
  const lines = ["first", "last"].map((id, index) => ({ id, bbox: { left: 0, top: index * 60, right: 100, bottom: index * 60 + 20 },
    originalText: id, correctedText: id, chars: [], words: [], geometryApproximate: false }));
  return { id: "page", width: 100, height: 100, sourcePage: 1, split: "single", angle: 0, rotation: 0,
    blocks: [{ id: "block", bbox: { left: 0, top: 0, right: 100, bottom: 80 }, paragraphs: [{ id: "paragraph", bbox: { left: 0, top: 0, right: 100, bottom: 80 }, lines }] }],
    figureRegions: [{ id: "figure", kind: "figure", bbox: { left: 10, top: 30, right: 90, bottom: 50 } }] };
}

describe("figure and table regions", () => {
  it("finds tight bounds with near-white and transparent background pixels", () => {
    const data = new Uint8ClampedArray(4 * 4 * 4).fill(255);
    data.set([249, 249, 249, 255], 0);
    data.set([0, 0, 0, 0], 4);
    expect(nonWhiteBounds({ data, width: 4, height: 4 })).toBeNull();
    data.set([0, 0, 0, 255], (1 * 4 + 1) * 4);
    data.set([100, 100, 100, 255], (2 * 4 + 2) * 4);
    expect(nonWhiteBounds({ data, width: 4, height: 4 })).toEqual({ left: 1, top: 1, right: 3, bottom: 3 });
  });

  it("clicks the smallest region across overlapping text and images, deleting only one", () => {
    const initial = page();
    initial.figureRegions![0].bbox = { left: 5, top: 5, right: 15, bottom: 15 };
    const result = removePageRegions(initial, { x: 10, y: 10 });
    expect(result.removedRegions).toBe(1);
    expect(result.page.figureRegions).toEqual([]);
    expect(allLines(result.page)).toHaveLength(2);
    initial.figureRegions![0].bbox = { left: 0, top: 0, right: 100, bottom: 100 };
    const smallerText = removePageRegions(initial, { x: 10, y: 10 });
    expect(allLines(smallerText.page).map(line => line.id)).toEqual(["last"]);
    expect(smallerText.page.figureRegions).toHaveLength(1);
    expect(allLines(initial)).toHaveLength(2);
  });

  it("deletes all intersecting regions and repairs the shared reading order", () => {
    const initial = reorderPageItems(page(), ["last", "figure", "first"]);
    const result = removePageRegions(initial, { left: 11, top: 10, right: 12, bottom: 40 });
    expect(result.removedRegions).toBe(2);
    expect(result.page.figureRegions).toEqual([]);
    expect(allLines(result.page).map(line => line.id)).toEqual(["last"]);
    expect(result.page.readingOrderIds).toEqual(["last"]);
    expect(result.page.deletedOcrLineIds).toEqual(["first"]);
  });

  it("includes every figure once and places new figures into existing text order", () => {
    const initial = page();
    expect(pageItems(initial).map(item => item.id)).toEqual(["first", "figure", "last"]);
    const added = addFigureRegion(initial, { id: "table", kind: "table", bbox: { left: 0, top: 90, right: 100, bottom: 100 } });
    const ordered = reorderPageItems(added, ["table", "last", "figure", "first"]);
    expect(pageItems(ordered).map(item => item.id)).toEqual(["table", "last", "figure", "first"]);
    expect(() => reorderPageItems(added, ["table", "last", "first"])).toThrow();
  });

  it("inserts embedded images between text lines in HTML and records hOCR classes and bounds", () => {
    const initial = page();
    initial.figureRegions!.push({ id: "table", kind: "table", bbox: { left: 0, top: 80, right: 100, bottom: 100 } });
    const ordered = reorderPageItems(initial, ["first", "table", "figure", "last"]);
    const images = { figure: "data:image/png;base64,AAAA", table: "data:image/png;base64,BBBB" };
    const html = createReadableHtml("Book", [{ page: ordered, label: "1" }], "", "", images);
    expect(html.indexOf('class="line">first')).toBeLessThan(html.indexOf('data-region-id="table"'));
    expect(html.indexOf('data-region-id="table"')).toBeLessThan(html.indexOf('data-region-id="figure"'));
    expect(html.indexOf('data-region-id="figure"')).toBeLessThan(html.indexOf('class="line">last'));
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    const hocr = exportHocr([ordered]);
    const document = new DOMParser().parseFromString(hocr, "application/xml");
    expect(document.querySelector("parsererror")).toBeNull();
    expect(document.querySelector(".ocr_table")?.getAttribute("title")).toBe("bbox 0 80 100 100");
    expect(document.querySelector(".ocr_image")?.getAttribute("id")).toBe("figure");
    const ids = [...document.querySelectorAll("[id]")].map(element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(hocr.indexOf('id="first"')).toBeLessThan(hocr.indexOf('id="table"'));
    expect(hocr.indexOf('id="figure"')).toBeLessThan(hocr.indexOf('id="last"'));
  });

  it("embeds images at their original SVG coordinates without dropping OCR text", () => {
    const svg = exportSvg(page(), { figure: "data:image/png;base64,AAAA" });
    expect(svg).toContain('x="10" y="30" width="80" height="20" href="data:image/png;base64,AAAA"');
    expect(svg).toContain('data-line-id="first"');
    expect(svg).toContain('data-line-id="last"');
    expect(() => exportSvg(page())).toThrow("Missing image");
  });

  it("keeps figure-only pages exportable", () => {
    const initial = { ...page(), blocks: [] };
    expect(createReadableHtml("Book", [{ page: initial, label: "1" }], "", "", { figure: "data:image/png;base64,AAAA" })).toContain("<img");
    expect(exportHocr([initial])).toContain('class="ocr_image"');
  });

  it("preserves figure rectangles and types after re-OCR but resets reading order", () => {
    const before = reorderPageItems(page(), ["last", "figure", "first"]);
    const recognized = { ...page(), figureRegions: undefined, readingOrderIds: ["first", "last"], manualReadingOrder: true };
    const after = preserveFiguresAfterOcr(before, recognized);
    expect(after.figureRegions).toEqual(before.figureRegions);
    expect(after.figureRegions![0]).not.toBe(before.figureRegions![0]);
    expect(after.manualReadingOrder).toBeUndefined();
    expect(after.readingOrderIds).toBeUndefined();
    expect(pageItems(after).map(item => item.id)).toEqual(["first", "figure", "last"]);
  });
});
