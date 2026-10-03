import { allLines, type DocumentPage, type FigureRegion, type Rect } from "./domain";
import { removeOcrLineIds } from "./ocrRegion";
import { pageItems } from "./pageContent";

/** Tight bounds inside the selection; transparent pixels are composited over white. */
export function nonWhiteBounds(image: Pick<ImageData, "data" | "width" | "height">, threshold = 245): Rect | null {
  let left = image.width, top = image.height, right = 0, bottom = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const offset = (y * image.width + x) * 4, alpha = image.data[offset + 3] / 255;
    if ([0, 1, 2].every(channel => image.data[offset + channel] * alpha + 255 * (1 - alpha) >= threshold)) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
  }
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

export function cropFigure(source: HTMLCanvasElement, bbox: Rect): string {
  if (![bbox.left, bbox.top, bbox.right, bbox.bottom].every(Number.isFinite) ||
      bbox.left < 0 || bbox.top < 0 || bbox.right > source.width || bbox.bottom > source.height ||
      bbox.right <= bbox.left || bbox.bottom <= bbox.top) throw new Error("Invalid image region coordinates.");
  const canvas = document.createElement("canvas");
  canvas.width = bbox.right - bbox.left; canvas.height = bbox.bottom - bbox.top;
  if (!canvas.width || !canvas.height) throw new Error("Empty image region.");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create image canvas.");
  context.drawImage(source, bbox.left, bbox.top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

export function addFigureRegion(page: DocumentPage, figure: FigureRegion): DocumentPage {
  return { ...page, figureRegions: [...(page.figureRegions ?? []), figure] };
}

const area = (bbox: Rect) => (bbox.right - bbox.left) * (bbox.bottom - bbox.top);
export function removePageRegions(page: DocumentPage, selection: Rect | { x: number; y: number }): { page: DocumentPage; removedRegions: number } {
  const items = pageItems(page);
  const hits = "x" in selection
    ? items.filter(item => selection.x >= item.bbox.left && selection.x <= item.bbox.right && selection.y >= item.bbox.top && selection.y <= item.bbox.bottom)
      .sort((a, b) => area(a.bbox) - area(b.bbox)).slice(0, 1)
    : items.filter(item => item.bbox.left < selection.right && item.bbox.right > selection.left && item.bbox.top < selection.bottom && item.bbox.bottom > selection.top);
  if (!hits.length) return { page, removedRegions: 0 };
  const ids = new Set(hits.map(item => item.id));
  const next = removeOcrLineIds(page, new Set(allLines(page).filter(line => ids.has(line.id)).map(line => line.id))).page;
  return { page: { ...next, figureRegions: (page.figureRegions ?? []).filter(figure => !ids.has(figure.id)),
    ...(page.readingOrderIds ? { readingOrderIds: page.readingOrderIds.filter(id => !ids.has(id)) } : {}) }, removedRegions: hits.length };
}

export function preserveFiguresAfterOcr(before: DocumentPage | null, after: DocumentPage): DocumentPage {
  const next = { ...after };
  delete next.readingOrderIds;
  delete next.manualReadingOrder;
  const existing = before?.figureRegions ?? [];
  if (existing.length) next.figureRegions = [...existing, ...(after.figureRegions ?? []).filter(figure => !existing.some(old => old.id === figure.id))]
    .map(figure => ({ ...figure, bbox: { ...figure.bbox } }));
  return next;
}
