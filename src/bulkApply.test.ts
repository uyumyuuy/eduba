import { describe, expect, it } from "vitest";
import { allLines, parseHocr, updateLineFormatting } from "./domain";
import { prepareBulkUpdates } from "./bulkApply";
import type { BulkMatch } from "./BulkReplaceDialog";

function pageData(text: string) {
  const [page] = parseHocr(`<html xmlns="http://www.w3.org/1999/xhtml"><body><div class="ocr_page" id="page" title="bbox 0 0 100 20"><div class="ocr_carea" id="block" title="bbox 0 0 100 20"><p class="ocr_par" id="paragraph" title="bbox 0 0 100 20"><span class="ocr_line" id="line" title="bbox 0 0 100 20"><span class="ocrx_word" id="word" title="bbox 0 0 100 20">${text}</span></span></p></div></div></body></html>`);
  return page;
}

function selection(pageId: string, lineId: string, lineText: string, ordinal: number): BulkMatch {
  return { pageId, pageLabel: "1", lineId, lineText, matchOrdinal: ordinal };
}

describe("prepareBulkUpdates", () => {
  it("updates only the selected occurrence", async () => {
    const page = pageData("cat cat cat");
    const line = allLines(page)[0];
    const expectedData = JSON.stringify(page);

    const [update] = await prepareBulkUpdates({
      selections: [selection(page.id, line.id, line.correctedText, 1)],
      search: "cat",
      replacement: "X",
      loadPage: async () => expectedData,
    });

    expect(update.expectedData).toBe(expectedData);
    expect(allLines(JSON.parse(update.data))[0].correctedText).toBe("cat X cat");
  });

  it("applies multiple selections in one line from right to left and preserves formatting", async () => {
    const page = pageData("cat cat cat");
    const line = allLines(page)[0];
    const formatted = updateLineFormatting(page, line.id, 4, 7, "bold");
    const expectedData = JSON.stringify(formatted);

    const [update] = await prepareBulkUpdates({
      selections: [selection(page.id, line.id, line.correctedText, 0), selection(page.id, line.id, line.correctedText, 2)],
      search: "cat",
      replacement: "doggy",
      loadPage: async () => expectedData,
    });

    const updated = allLines(JSON.parse(update.data))[0];
    expect(updated.correctedText).toBe("doggy cat doggy");
    expect(updated.formatting).toEqual([{ start: 6, end: 9, kind: "bold" }]);
  });

  it("applies replacement-editor formatting to every selected occurrence", async () => {
    const page = pageData("cat cat");
    const line = allLines(page)[0];
    const [update] = await prepareBulkUpdates({
      selections: [selection(page.id, line.id, line.correctedText, 0), selection(page.id, line.id, line.correctedText, 1)],
      search: "cat", replacement: "dog", replacementFormatting: [{ start: 0, end: 3, kind: "bold" }],
      loadPage: async () => JSON.stringify(page),
    });
    const updated = allLines(JSON.parse(update.data))[0];
    expect(updated.correctedText).toBe("dog dog");
    expect(updated.formatting).toEqual(expect.arrayContaining([
      { start: 0, end: 3, kind: "bold" }, { start: 4, end: 7, kind: "bold" },
    ]));
  });
  it("rejects a stale selected match without producing updates", async () => {
    const page = pageData("cat cat");
    const line = allLines(page)[0];
    const staleData = JSON.stringify(pageData("cat x cat"));

    await expect(prepareBulkUpdates({
      selections: [selection(page.id, line.id, line.correctedText, 1)],
      search: "cat",
      replacement: "X",
      loadPage: async () => staleData,
    })).rejects.toThrow("Line");
  });
});
