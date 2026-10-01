import type { PDFDocumentProxy } from "pdfjs-dist";
import { processCanvas } from "./domain";
import { loadPageImage } from "./pageImage";
import type { LogicalPageProvenance } from "./domain";
import { t } from "./i18n";
import { defaultOcrMargins, type OcrMargins } from "./ocrMargins";
import type { ImportMode } from "./pageImage";

export type ImportConfig = { begin: number; end: number; dpi: number; rotation: 0 | 90 | 180 | 270; splitSpread: boolean; deskew?: boolean; importMode: ImportMode; ocrMargins: OcrMargins };
export type ImportEntry = LogicalPageProvenance & { id: string; label: string; status: "pending"; dpi: number; importMode: ImportMode; ocrMargins: OcrMargins };

export function validateImportRange(begin: number, end: number, numPages: number): string | null {
  if (!Number.isInteger(begin) || !Number.isInteger(end)) return t("errors.pageRangeInteger");
  if (begin < 1 || end < begin || end > numPages) return t("errors.pageRangeBounds", { count: numPages });
  return null;
}

export function importEntries(config: ImportConfig): ImportEntry[] {
  const entries: ImportEntry[] = [];
  for (let sourcePage = config.begin; sourcePage <= config.end; sourcePage++) {
    const sides = config.splitSpread ? ["left", "right"] as const : ["single"] as const;
    for (const split of sides) entries.push({ id: `page-${sourcePage}-${split}`, label: split === "single" ? String(sourcePage) : `${sourcePage}${split === "left" ? "L" : "R"}`, sourcePage, split, rotation: config.rotation, angle: 0, preprocessOrder: "split-deskew", status: "pending", dpi: config.importMode === "extract" ? 300 : config.dpi, importMode: config.importMode, ocrMargins: { ...defaultOcrMargins, ...config.ocrMargins } });
  }
  return entries;
}

/** Resolve correction angles once, before saving the new project's manifest. */
export async function prepareImportEntries(pdf: PDFDocumentProxy, config: ImportConfig) {
  const entries = importEntries(config);
  const prepared = [];
  for (let page = config.begin; page <= config.end; page++) {
    const source = await pdf.getPage(page);
    const loaded = await loadPageImage(source, config.importMode, config.dpi);
    const processed = processCanvas(loaded.canvas, {
      sourcePage: page, rotation: config.rotation,
      split: config.splitSpread ? "both" : "none", deskew: config.deskew !== false,
    });
    for (const item of processed.pages) {
      const entry = entries.find(entry => entry.sourcePage === page && entry.split === item.provenance.split)!;
      prepared.push({
        ...entry, ...item.provenance,
        width: item.canvas.width, height: item.canvas.height,
        resolvedImportMode: loaded.modeUsed,
        sourceDpiX: config.rotation === 90 || config.rotation === 270 ? loaded.dpiY : loaded.dpiX,
        sourceDpiY: config.rotation === 90 || config.rotation === 270 ? loaded.dpiX : loaded.dpiY,
      });
    }
    // Release large raster buffers and allow the busy indicator to repaint.
    for (const item of processed.pages) { item.canvas.width = 1; item.canvas.height = 1; }
    loaded.canvas.width = 1; loaded.canvas.height = 1;
    source.cleanup();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return prepared;
}
