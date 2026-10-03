import { resolveOcrMargins } from "./ocrMargins";
import { allLines, type DocumentPage, type OcrChar, type OcrLine, type PageBlock, type Paragraph, type Rect, type TextFormatRange } from "./domain";

const intersects = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const area = (r: Rect) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
const overlapArea = (a: Rect, b: Rect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const centreX = (r: Rect) => (r.left + r.right) / 2;
const centreY = (r: Rect) => (r.top + r.bottom) / 2;
const height = (r: Rect) => Math.max(1, r.bottom - r.top);
const horizontalGap = (a: Rect, b: Rect) => Math.max(0, a.left - b.right, b.left - a.right);
const union = (rectangles: Rect[]): Rect => ({
  left: Math.min(...rectangles.map(r => r.left)), top: Math.min(...rectangles.map(r => r.top)),
  right: Math.max(...rectangles.map(r => r.right)), bottom: Math.max(...rectangles.map(r => r.bottom)),
});

/** The selected pixels are never enlarged; white padding is added after cropping. */
export function prepareRegionOcrImage(source: HTMLCanvasElement, selection: Rect, page: DocumentPage, padding = 20): HTMLCanvasElement {
  const result = source.ownerDocument.createElement("canvas");
  result.width = selection.right - selection.left + 2 * padding;
  result.height = selection.bottom - selection.top + 2 * padding;
  const context = result.getContext("2d");
  if (!context) throw new Error("OCR canvas context is unavailable");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, result.width, result.height);
  context.drawImage(source, selection.left, selection.top, selection.right - selection.left, selection.bottom - selection.top,
    padding, padding, selection.right - selection.left, selection.bottom - selection.top);
  for (const line of allLines(page)) for (const word of line.words) {
    const b = word.bbox;
    if (!intersects(b, selection)) continue;
    const left = Math.max(b.left, selection.left), top = Math.max(b.top, selection.top);
    const right = Math.min(b.right, selection.right), bottom = Math.min(b.bottom, selection.bottom);
    context.fillRect(padding + left - selection.left, padding + top - selection.top, right - left, bottom - top);
  }
  const margins = resolveOcrMargins(page.ocrMargins, page.split);
  const topMargin = Math.ceil(source.height * margins.top / 100);
  const bottomMargin = Math.ceil(source.height * margins.bottom / 100);
  const leftMargin = Math.ceil(source.width * margins.left / 100);
  const rightMargin = Math.ceil(source.width * margins.right / 100);
  const excluded: Rect[] = [
    { left: 0, top: 0, right: source.width, bottom: topMargin },
    { left: 0, top: source.height - bottomMargin, right: source.width, bottom: source.height },
    { left: 0, top: 0, right: leftMargin, bottom: source.height },
    { left: source.width - rightMargin, top: 0, right: source.width, bottom: source.height },
    ...(page.figureRegions ?? []).map(figure => figure.bbox),
  ];
  for (const bbox of excluded) {
    if (!intersects(bbox, selection)) continue;
    const left = Math.max(bbox.left, selection.left), top = Math.max(bbox.top, selection.top);
    const right = Math.min(bbox.right, selection.right), bottom = Math.min(bbox.bottom, selection.bottom);
    context.fillRect(padding + left - selection.left, padding + top - selection.top, right - left, bottom - top);
  }
  return result;
}

function translated(box: Rect, dx: number, dy: number): Rect {
  return { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy };
}

function translatedLine(line: OcrLine, dx: number, dy: number): OcrLine {
  return {
    ...line, bbox: translated(line.bbox, dx, dy),
    words: line.words.map(word => ({ ...word, bbox: translated(word.bbox, dx, dy), chars: word.chars.map(char => ({ ...char, bbox: char.bbox && translated(char.bbox, dx, dy) })) })),
    chars: line.chars.map(char => ({ ...char, bbox: char.bbox && translated(char.bbox, dx, dy) })),
  };
}

function charsWithSpace(first: OcrChar[], second: OcrChar[]): OcrChar[] {
  return [...first, { index: 0, originalText: " ", correctedText: " ", source: "ocr" as const }, ...second]
    .map((char, index) => ({ ...char, index }));
}

function shifted(ranges: TextFormatRange[] | undefined, offset: number): TextFormatRange[] | undefined {
  return ranges?.map(range => ({ ...range, start: range.start + offset, end: range.end + offset }));
}

function appendToLine(target: OcrLine, addition: OcrLine, side: "before" | "after"): void {
  const oldBottom = target.bbox.bottom;
  const addedText = addition.words.map(word => word.originalText).join(" ");
  if (side === "before") {
    const offset = addedText.length + 1;
    target.originalText = addedText + " " + target.originalText;
    target.correctedText = addedText + " " + target.correctedText;
    target.words = [...addition.words, ...target.words];
    target.chars = charsWithSpace(addition.chars, target.chars);
    target.formatting = shifted(target.formatting, offset);
    target.autoFormatting = shifted(target.autoFormatting, offset);
  } else {
    target.originalText = target.originalText + " " + addedText;
    target.correctedText = target.correctedText + " " + addedText;
    target.words = [...target.words, ...addition.words];
    target.chars = charsWithSpace(target.chars, addition.chars);
  }
  target.bbox = union([target.bbox, addition.bbox]);
  if (target.baseline) target.baseline.intercept += oldBottom - target.bbox.bottom;
}

type Anchor = { blockIndex: number; paragraphIndex: number; lineIndex: number; line: OcrLine };
function anchors(page: DocumentPage): Anchor[] {
  return page.blocks.flatMap((block, blockIndex) => block.paragraphs.flatMap((paragraph, paragraphIndex) =>
    paragraph.lines.map((line, lineIndex) => ({ blockIndex, paragraphIndex, lineIndex, line }))));
}

function mergeTarget(page: DocumentPage, addition: OcrLine, selection: Rect): { line: OcrLine; side: "before" | "after" } | null {
  const candidates = allLines(page).filter(line => line.words.some(word => intersects(word.bbox, selection)))
    .flatMap(line => {
      if (!line.words.length) return [];
      const left = Math.min(...line.words.map(word => word.bbox.left));
      const right = Math.max(...line.words.map(word => word.bbox.right));
      const side: "before" | "after" | null = addition.bbox.right <= left ? "before" : addition.bbox.left >= right ? "after" : null;
      if (!side) return [];
      const scale = Math.max(height(line.bbox), height(addition.bbox));
      const vertical = Math.abs(centreY(line.bbox) - centreY(addition.bbox)) / scale;
      const horizontal = horizontalGap(line.bbox, addition.bbox) / scale;
      if (vertical > 0.85 || horizontal > 4) return [];
      return [{ line, side, score: vertical + horizontal / 4 }];
    }).sort((a, b) => a.score - b.score || a.line.id.localeCompare(b.line.id));
  if (!candidates.length || (candidates[1] && candidates[1].score - candidates[0].score < 0.2)) return null;
  return { line: candidates[0].line, side: candidates[0].side };
}

function blockFromParagraphs(id: string, paragraphs: Paragraph[]): PageBlock {
  return { id, paragraphs, bbox: union(paragraphs.map(p => p.bbox)) };
}

function paragraphsBeforeAfter(block: PageBlock, anchor: Anchor, before: boolean, suffix: string): [Paragraph[], Paragraph[]] {
  const start = anchor.lineIndex + (before ? 0 : 1);
  const prior = block.paragraphs.slice(0, anchor.paragraphIndex);
  const later = block.paragraphs.slice(anchor.paragraphIndex + 1);
  const paragraph = block.paragraphs[anchor.paragraphIndex];
  const a = paragraph.lines.slice(0, start), b = paragraph.lines.slice(start);
  const left = [...prior, ...(a.length ? [{ ...paragraph, lines: a, bbox: union(a.map(line => line.bbox)) }] : [])];
  const right = [...(b.length ? [{ ...paragraph, id: paragraph.id + "--" + suffix, lines: b, bbox: union(b.map(line => line.bbox)) }] : []), ...later];
  return [left, right];
}

function insertIndependent(page: DocumentPage, addition: OcrLine, regionId: string): void {
  const block: PageBlock = { id: regionId + "--block-" + addition.id, bbox: addition.bbox,
    paragraphs: [{ id: regionId + "--paragraph-" + addition.id, bbox: addition.bbox, lines: [addition] }] };
  const choices = anchors(page);
  if (!choices.length) { page.blocks.push(block); return; }
  if (addition.bbox.bottom <= Math.min(...choices.map(item => item.line.bbox.top))) { page.blocks.unshift(block); return; }
  if (addition.bbox.top >= Math.max(...choices.map(item => item.line.bbox.bottom))) { page.blocks.push(block); return; }
  // Preserve established reading order; prefer the same column, then the nearest row.
  const ranked = choices.map((anchor, index) => {
    const scale = Math.max(height(anchor.line.bbox), height(addition.bbox));
    const horizontal = horizontalGap(anchor.line.bbox, addition.bbox) / scale;
    const vertical = Math.abs(centreY(anchor.line.bbox) - centreY(addition.bbox)) / scale;
    return { anchor, index, score: horizontal <= 3 ? vertical + horizontal / 4 : 10 + horizontal + vertical };
  }).sort((a, b) => a.score - b.score || a.index - b.index);
  const target = ranked[0].anchor;
  const sameRow = Math.abs(centreY(target.line.bbox) - centreY(addition.bbox)) <= 0.75 * Math.max(height(target.line.bbox), height(addition.bbox));
  const before = sameRow ? centreX(addition.bbox) < centreX(target.line.bbox) : centreY(addition.bbox) < centreY(target.line.bbox);
  const old = page.blocks[target.blockIndex];
  const [left, right] = paragraphsBeforeAfter(old, target, before, regionId);
  page.blocks.splice(target.blockIndex, 1,
    ...(left.length ? [blockFromParagraphs(old.id, left)] : []), block,
    ...(right.length ? [blockFromParagraphs(left.length ? old.id + "--" + regionId : old.id, right)] : []));
}

/** Integrates region hOCR without replacing existing recognition or corrections. */
export function addOcrRegion(page: DocumentPage, recognized: DocumentPage, selection: Rect, padding: number, regionId: string, psm: 11 | 6 = 11): { page: DocumentPage; addedLines: number; addedWords: number } {
  const next: DocumentPage = JSON.parse(JSON.stringify(page));
  const oldWords = allLines(page).flatMap(line => line.words);
  const dx = selection.left - padding, dy = selection.top - padding;
  const lines = allLines(recognized).map(line => translatedLine(line, dx, dy)).map(line => {
    const words = line.words.filter(word => {
      const box = word.bbox;
      if (centreX(box) < selection.left || centreX(box) > selection.right || centreY(box) < selection.top || centreY(box) > selection.bottom) return false;
      return !oldWords.some(existing => overlapArea(box, existing.bbox) > area(box) * 0.5);
    });
    if (!words.length) return null;
    const text = words.map(word => word.originalText).join(" ");
    return { ...line, words, chars: words.flatMap((word, i) => i ? [{ index: 0, originalText: " ", correctedText: " ", source: "ocr" as const }, ...word.chars] : word.chars).map((char, index) => ({ ...char, index })),
      bbox: union(words.map(word => word.bbox)), originalText: text, correctedText: text };
  }).filter((line): line is OcrLine => line != null)
    .sort((a, b) => centreY(a.bbox) - centreY(b.bbox) || centreX(a.bbox) - centreX(b.bbox));
  if (!lines.length) return { page, addedLines: 0, addedWords: 0 };
  const hasOverlap = oldWords.some(word => intersects(word.bbox, selection));
  const addedLineIds: string[] = [], addedWordIds: string[] = [];
  for (const line of lines) {
    addedWordIds.push(...line.words.map(word => word.id));
    const target = hasOverlap ? mergeTarget(next, line, selection) : null;
    if (target) appendToLine(target.line, line, target.side);
    else { insertIndependent(next, line, regionId); addedLineIds.push(line.id); }
  }
  for (const block of next.blocks) {
    for (const paragraph of block.paragraphs) paragraph.bbox = union(paragraph.lines.map(line => line.bbox));
    block.bbox = union(block.paragraphs.map(paragraph => paragraph.bbox));
  }
  next.manualOcrRegions = [...(next.manualOcrRegions ?? []), { id: regionId, bbox: selection, psm, addedWordIds, addedLineIds }];
  return { page: next, addedLines: lines.length, addedWords: addedWordIds.length };
}

/** Removes complete OCR lines and repairs the page hierarchy and manual-region references. */
export function removeOcrLineIds(page: DocumentPage, ids: Set<string>): { page: DocumentPage; removedLines: number } {
  if (!ids.size) return { page, removedLines: 0 };
  const next: DocumentPage = JSON.parse(JSON.stringify(page));
  for (const block of next.blocks) {
    for (const paragraph of block.paragraphs) {
      paragraph.lines = paragraph.lines.filter(line => !ids.has(line.id));
    }
    block.paragraphs = block.paragraphs.filter(paragraph => paragraph.lines.length > 0);
    for (const paragraph of block.paragraphs) paragraph.bbox = union(paragraph.lines.map(line => line.bbox));
    if (block.paragraphs.length) block.bbox = union(block.paragraphs.map(paragraph => paragraph.bbox));
  }
  next.blocks = next.blocks.filter(block => block.paragraphs.length > 0);
  next.deletedOcrLineIds = [...new Set([...(next.deletedOcrLineIds ?? []), ...ids])];
  if (next.manualOcrRegions) {
    const remainingLines = allLines(next);
    const wordIds = new Set(remainingLines.flatMap(line => line.words.map(word => word.id)));
    const lineIds = new Set(remainingLines.map(line => line.id));
    const regions = next.manualOcrRegions.map(region => ({ ...region,
      addedWordIds: region.addedWordIds.filter(id => wordIds.has(id)),
      addedLineIds: region.addedLineIds.filter(id => lineIds.has(id)),
    })).filter(region => region.addedWordIds.length || region.addedLineIds.length);
    next.manualOcrRegions = regions.length ? regions : undefined;
  }
  return { page: next, removedLines: ids.size };
}

/** A drag on the OCR layout removes each line whose visible line box overlaps it. */
export function removeOcrLinesInRegion(page: DocumentPage, selection: Rect): { page: DocumentPage; removedLines: number } {
  return removeOcrLineIds(page, new Set(allLines(page).filter(line => intersects(line.bbox, selection)).map(line => line.id)));
}

/** A click removes one line. Prefer the smallest line box if OCR boxes overlap. */
export function removeOcrLineAtPoint(page: DocumentPage, x: number, y: number): { page: DocumentPage; removedLines: number } {
  const target = allLines(page).filter(line => x >= line.bbox.left && x <= line.bbox.right && y >= line.bbox.top && y <= line.bbox.bottom)
    .sort((a, b) => area(a.bbox) - area(b.bbox))[0];
  return removeOcrLineIds(page, new Set(target ? [target.id] : []));
}

export type MergeRegionResult = { page: DocumentPage; mergedLines: number; reason?: "tooFew" | "differentRows" | "overlap" | "classes" };

/** Join selected lines on one visual row without discarding edits or OCR boxes. */
export function mergeOcrLinesInRegion(page: DocumentPage, selection: Rect): MergeRegionResult {
  const ordered = allLines(page);
  const selected = ordered.filter(line => intersects(line.bbox, selection));
  if (selected.length < 2) return { page, mergedLines: 0, reason: "tooFew" };
  const byX = selected.slice().sort((a, b) => a.bbox.left - b.bbox.left || a.bbox.top - b.bbox.top);
  const classes = (line: OcrLine) => (line.hocrClasses?.length ? line.hocrClasses : ["ocr_line"]).slice().sort().join(" ");
  if (byX.some(line => classes(line) !== classes(byX[0]))) return { page, mergedLines: 0, reason: "classes" };
  for (let i = 0; i < byX.length; i++) for (let j = i + 1; j < byX.length; j++) {
    const a = byX[i].bbox, b = byX[j].bbox;
    const small = Math.min(height(a), height(b)), large = Math.max(height(a), height(b));
    const verticalOverlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const verticalGap = Math.max(0, a.top - b.bottom, b.top - a.bottom);
    const smallRaisedOrLowered = small / large <= 0.65 && verticalGap <= large * 0.2 &&
      Math.abs(centreY(a) - centreY(b)) <= large * 0.8;
    if (verticalOverlap < small * 0.35 && !smallRaisedOrLowered)
      return { page, mergedLines: 0, reason: "differentRows" };
  }
  for (let i = 1; i < byX.length; i++) {
    const a = byX[i - 1].bbox, b = byX[i].bbox;
    const allowedOverlap = Math.max(2, Math.min(height(a), height(b)) * 0.1);
    if (a.right - b.left > allowedOverlap) return { page, mergedLines: 0, reason: "overlap" };
  }
  const next: DocumentPage = JSON.parse(JSON.stringify(page));
  const selectedIds = new Set(selected.map(line => line.id));
  const primaryId = selected[0].id;
  const mergedBox = union(byX.map(line => line.bbox));
  const originalText = byX.map(line => line.originalText).join(" ");
  const correctedText = byX.map(line => line.correctedText).join(" ");
  const chars: OcrChar[] = [];
  const formatting: TextFormatRange[] = [], autoFormatting: TextFormatRange[] = [];
  let offset = 0;
  for (const [index, line] of byX.entries()) {
    if (index) chars.push({ index: 0, originalText: " ", correctedText: " ", source: "inserted" });
    const sourceChars = line.chars.map(char => char.correctedText).join("") === line.correctedText
      ? line.chars : Array.from(line.correctedText).map(text => ({ index: 0, originalText: "", correctedText: text, source: "inserted" as const }));
    chars.push(...sourceChars);
    formatting.push(...(line.formatting ?? []).map(range => ({ ...range, start: range.start + offset, end: range.end + offset })));
    autoFormatting.push(...(line.autoFormatting ?? []).map(range => ({ ...range, start: range.start + offset, end: range.end + offset })));
    offset += line.correctedText.length + 1;
  }
  const baselineSource = byX.filter(line => line.baseline).sort((a, b) => (b.bbox.right - b.bbox.left) - (a.bbox.right - a.bbox.left))[0];
  const baseline = baselineSource?.baseline && {
    slope: baselineSource.baseline.slope,
    intercept: baselineSource.bbox.bottom + baselineSource.baseline.intercept +
      baselineSource.baseline.slope * (mergedBox.left - baselineSource.bbox.left) - mergedBox.bottom,
  };
  const first = allLines(next).find(line => line.id === primaryId)!;
  Object.assign(first, {
    bbox: mergedBox, baseline,
    fontSize: Math.max(...byX.map(line => line.fontSize ?? 0)) || undefined,
    originalText, correctedText,
    words: byX.flatMap(line => line.words),
    chars: chars.map((char, index) => ({ ...char, index })),
    formatting: formatting.length ? formatting : undefined,
    autoFormatting: autoFormatting.length ? autoFormatting : undefined,
    scriptDetectionManuallyEdited: true,
    geometryApproximate: byX.some(line => line.geometryApproximate),
  });
  for (const block of next.blocks) {
    for (const paragraph of block.paragraphs) paragraph.lines = paragraph.lines.filter(line => line.id === primaryId || !selectedIds.has(line.id));
    block.paragraphs = block.paragraphs.filter(paragraph => paragraph.lines.length);
    for (const paragraph of block.paragraphs) paragraph.bbox = union(paragraph.lines.map(line => line.bbox));
    if (block.paragraphs.length) block.bbox = union(block.paragraphs.map(paragraph => paragraph.bbox));
  }
  next.blocks = next.blocks.filter(block => block.paragraphs.length);
  if (next.manualOcrRegions) {
    const remaining = new Set(allLines(next).map(line => line.id));
    const regions = next.manualOcrRegions.map(region => ({ ...region,
      addedLineIds: region.addedLineIds.filter(id => remaining.has(id)),
    })).filter(region => region.addedLineIds.length || region.addedWordIds.length);
    next.manualOcrRegions = regions.length ? regions : undefined;
  }
  return { page: next, mergedLines: selected.length };
}
