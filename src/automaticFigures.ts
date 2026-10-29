import type { FigureRegion, LogicalPageProvenance, Rect } from "./domain";
import { maskOcrCanvas, resolveOcrMargins } from "./ocrMargins";

export type FigureDetection = { bbox: Rect; score: number };

function overlapsExisting(bbox: Rect, figures: FigureRegion[]): boolean {
  const area = (rect: Rect) => (rect.right - rect.left) * (rect.bottom - rect.top);
  return figures.some(({ bbox: other }) => {
    const intersection = Math.max(0, Math.min(other.right, bbox.right) - Math.max(other.left, bbox.left))
      * Math.max(0, Math.min(other.bottom, bbox.bottom) - Math.max(other.top, bbox.top));
    return intersection / Math.min(area(other), area(bbox)) > 0.85;
  });
}

/** Mask exclusions before detection; keep source pixels intact for display and export. */
export async function prepareFigureOcr(
  source: HTMLCanvasElement,
  entry: LogicalPageProvenance,
  existing: FigureRegion[],
  detect: (canvas: HTMLCanvasElement) => Promise<FigureDetection[]>,
): Promise<{ canvas: HTMLCanvasElement; figures: FigureRegion[] }> {
  const figures = existing.map(figure => ({ ...figure, bbox: { ...figure.bbox } }));
  const canvas = maskOcrCanvas(source, entry.split, entry.ocrMargins, figures.map(figure => figure.bbox));
  if (entry.autoFigureDetection) {
    const margins = resolveOcrMargins(entry.ocrMargins, entry.split);
    const allowed = {
      left: Math.ceil(source.width * margins.left / 100),
      top: Math.ceil(source.height * margins.top / 100),
      right: source.width - Math.ceil(source.width * margins.right / 100),
      bottom: source.height - Math.ceil(source.height * margins.bottom / 100),
    };
    const detections = await detect(canvas);
    for (const { bbox: detected, score } of detections) {
      if (!Number.isFinite(score) || score < 0.5 || score > 1
        || !Object.values(detected).every(Number.isFinite)) continue;
      const bbox = {
        left: Math.max(allowed.left, Math.floor(detected.left)),
        top: Math.max(allowed.top, Math.floor(detected.top)),
        right: Math.min(allowed.right, Math.ceil(detected.right)),
        bottom: Math.min(allowed.bottom, Math.ceil(detected.bottom)),
      };
      if (bbox.right <= bbox.left || bbox.bottom <= bbox.top || overlapsExisting(bbox, figures)) continue;
      figures.push({ id: `auto-figure-${crypto.randomUUID()}`, kind: "figure", bbox });
    }
  }
  const context = canvas.getContext("2d");
  if (!context) throw new Error("OCR canvas context is unavailable");
  context.fillStyle = "#fff";
  for (const { bbox } of figures) {
    context.fillRect(bbox.left, bbox.top, bbox.right - bbox.left, bbox.bottom - bbox.top);
  }
  return { canvas, figures };
}
