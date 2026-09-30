// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { compactChange, historyPageUpdate, HistoryPersistence, type HistoryOperation } from "./editHistory";
import { allLines, updateLineText, type DocumentPage, type OcrLine } from "./domain";

function page(): DocumentPage {
  const line = (id: string, text: string): OcrLine => ({ id, originalText: text, correctedText: text,
    bbox: { left: 5, top: 10, right: 90, bottom: 30 }, words: [], chars: [], geometryApproximate: false });
  return { id: "p", sourcePage: 1, split: "single", rotation: 0, angle: 0, width: 100, height: 100,
    blocks: [{ id: "b", bbox: { left: 0, top: 0, right: 100, bottom: 100 }, paragraphs: [{ id: "q", bbox: { left: 0, top: 0, right: 100, bottom: 100 }, lines: [line("l", "Before"), line("other", "Unchanged")] }] }] };
}
const stringify = JSON.stringify;
function edit(): HistoryOperation {
  const before = page(), after = updateLineText(before, "l", "After");
  return { targetPageId: "p", changes: [compactChange({ pageId: "p", beforeData: stringify(before), afterData: stringify(after) })] };
}
describe("persistent edit history", () => {
  it("stores only changed lines with formatting and geometry and preserves other lines on replay", () => {
    const operation = edit();
    const change = operation.changes[0];
    expect(change).toHaveProperty("kind", "lines");
    expect(JSON.stringify(change)).not.toContain("Unchanged");
    const current = updateLineText(updateLineText(page(), "l", "After"), "other", "Independent correction");
    const restored = JSON.parse(historyPageUpdate(change, stringify(current), true).data!) as DocumentPage;
    expect(allLines(restored).map(line => line.correctedText)).toEqual(["Before", "Independent correction"]);
    expect(allLines(JSON.parse(historyPageUpdate(change, stringify(restored), false).data!)).map(line => line.correctedText)).toEqual(["After", "Independent correction"]);
    expect(() => historyPageUpdate(change, stringify(page()), true)).toThrow("no longer matches");
  });
  it("uses a full page record for hierarchy or page changes", () => {
    const before = page(), after = page();
    after.blocks[0].paragraphs[0].lines.reverse();
    const full = { pageId: "p", beforeData: stringify(before), afterData: stringify(after) };
    expect(compactChange(full)).toBe(full);
    after.blocks[0].paragraphs[0].lines.reverse();
    after.manualReadingOrder = true;
    expect(compactChange({ ...full, afterData: stringify(after) })).not.toHaveProperty("kind");
  });
  it("can undo initial OCR to an absent page and redo its full snapshot", () => {
    const change = { pageId: "p", beforeData: null, afterData: stringify(page()) };
    expect(compactChange(change)).toBe(change);
    expect(historyPageUpdate(change, change.afterData, true)).toEqual({ pageId: "p", expectedData: change.afterData, data: null });
    expect(historyPageUpdate(change, null, false)).toEqual({ pageId: "p", expectedMissing: true, data: change.afterData });
  });
  it("restores the redo cursor and never resends saved records when moving it", () => {
    const store = new HistoryPersistence(), operation = edit();
    const first = store.capture([operation], []);
    const state = store.pending(first);
    expect(state.records).toHaveLength(1);
    store.confirm(state.order);
    expect(store.pending(store.capture([], [operation])).records).toHaveLength(0);
    const reopened = new HistoryPersistence();
    const restored = reopened.restore({ ...state, cursor: 0 });
    expect(restored.undo).toHaveLength(0);
    expect(restored.redo).toEqual([operation]);
    expect(reopened.pending(reopened.capture(restored.undo, restored.redo)).records).toHaveLength(0);
    const next = edit();
    expect(reopened.pending(reopened.capture([next], [])).records).toHaveLength(1);
  });
  it("bounds history count and omits editor session IDs from saved operations", () => {
    const store = new HistoryPersistence();
    const operations = Array.from({ length: 105 }, () => ({ ...edit(), lineEditSessionId: 1 }));
    const captured = store.capture(operations, []);
    expect(captured.order).toHaveLength(100);
    expect(captured.records[0].data).not.toContain("lineEditSessionId");
    expect(() => store.restore({ version: 1, order: ["missing"], cursor: 1, records: [] })).toThrow("Missing");
  });
});
