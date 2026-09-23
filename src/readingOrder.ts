import { allLines, type DocumentPage, type OcrLine, type PageBlock, type Paragraph, type Rect } from "./domain";

export type Point = { x: number; y: number };
const area = (box: Rect) => Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
const union = (boxes: Rect[]): Rect => ({
  left: Math.min(...boxes.map(box => box.left)), top: Math.min(...boxes.map(box => box.top)),
  right: Math.max(...boxes.map(box => box.right)), bottom: Math.max(...boxes.map(box => box.bottom)),
});

/** Move one previously unchosen line immediately after the current anchor. */
export function moveLineAfter(ids: string[], anchorId: string, nextId: string): string[] {
  const from = ids.indexOf(nextId), anchor = ids.indexOf(anchorId);
  if (from < 0 || anchor < 0 || from === anchor || from === anchor + 1) return ids;
  const result = ids.slice();
  result.splice(from, 1);
  result.splice(result.indexOf(anchorId) + 1, 0, nextId);
  return result;
}

/** Rebuild hOCR containers in reading order, splitting them only when needed. */
export function reorderPageLines(page: DocumentPage, ids: string[]): DocumentPage {
  const oldIds = allLines(page).map(line => line.id);
  if (ids.length !== oldIds.length || new Set(ids).size !== ids.length || ids.some(id => !oldIds.includes(id)))
    throw new Error("Reading order must contain every OCR line exactly once.");
  if (ids.every((id, index) => id === oldIds[index])) return page;
  type Entry = { line: OcrLine; blockId: string; paragraphId: string };
  const entries = new Map<string, Entry>();
  for (const block of page.blocks) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
    entries.set(line.id, { line,
      blockId: line.readingOrderOrigin?.blockId ?? block.id,
      paragraphId: line.readingOrderOrigin?.paragraphId ?? paragraph.id });
  }
  const next: DocumentPage = JSON.parse(JSON.stringify(page));
  const blocks: PageBlock[] = [];
  const blockCounts = new Map<string, number>(), paragraphCounts = new Map<string, number>();
  const usedBlockIds = new Set<string>(), usedParagraphIds = new Set<string>();
  const uniqueId = (origin: string, counts: Map<string, number>, used: Set<string>) => {
    let count = counts.get(origin) ?? 0;
    let candidate: string;
    do { count++; candidate = count === 1 ? origin : `${origin}--order-${count}`; } while (used.has(candidate));
    counts.set(origin, count);
    used.add(candidate);
    return candidate;
  };
  let currentBlockOrigin = "", currentParagraphOrigin = "";
  let block: PageBlock | null = null, paragraph: Paragraph | null = null;
  for (const id of ids) {
    const entry = entries.get(id)!;
    if (!block || currentBlockOrigin !== entry.blockId) {
      block = { id: uniqueId(entry.blockId, blockCounts, usedBlockIds), bbox: entry.line.bbox, paragraphs: [] };
      blocks.push(block);
      currentBlockOrigin = entry.blockId;
      currentParagraphOrigin = "";
      paragraph = null;
    }
    if (!paragraph || currentParagraphOrigin !== entry.paragraphId) {
      paragraph = { id: uniqueId(entry.paragraphId, paragraphCounts, usedParagraphIds), bbox: entry.line.bbox, lines: [] };
      block.paragraphs.push(paragraph);
      currentParagraphOrigin = entry.paragraphId;
    }
    paragraph.lines.push({ ...entry.line, readingOrderOrigin: { blockId: entry.blockId, paragraphId: entry.paragraphId } });
  }
  for (const resultBlock of blocks) {
    for (const resultParagraph of resultBlock.paragraphs) resultParagraph.bbox = union(resultParagraph.lines.map(line => line.bbox));
    resultBlock.bbox = union(resultBlock.paragraphs.map(item => item.bbox));
  }
  next.blocks = blocks;
  next.manualReadingOrder = true;
  return next;
}

/** Entry point along a pointer segment, including segments too fast for intermediate pointer events. */
function segmentEntry(from: Point, to: Point, box: Rect): number | null {
  let earliest = 0, latest = 1;
  for (const [start, end, low, high] of [
    [from.x, to.x, box.left, box.right], [from.y, to.y, box.top, box.bottom],
  ]) {
    const delta = end - start;
    if (delta === 0) { if (start < low || start > high) return null; continue; }
    const first = Math.min((low - start) / delta, (high - start) / delta);
    const last = Math.max((low - start) / delta, (high - start) / delta);
    earliest = Math.max(earliest, first);
    latest = Math.min(latest, last);
    if (earliest > latest) return null;
  }
  return earliest;
}

/** The first region at an overlap wins; order follows the pointer path, not page order. */
export function lineIdsCrossed(lines: OcrLine[], from: Point, to: Point): string[] {
  const hits = lines.map((line, index) => ({ id: line.id, index, t: segmentEntry(from, to, line.bbox), size: area(line.bbox) }))
    .filter((item): item is { id: string; index: number; t: number; size: number } => item.t !== null)
    .sort((a, b) => a.t - b.t || a.size - b.size || a.index - b.index);
  return hits.filter((item, index) => !index || Math.abs(item.t - hits[index - 1].t) > 1e-7).map(item => item.id);
}
