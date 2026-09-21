import type { LogicalPageProvenance } from "./domain";
import { defaultOcrMargins, type OcrMargins } from "./ocrMargins";
import type { ImportMode } from "./pageImage";

export type ImportConfig = { begin: number; end: number; dpi: number; rotation: 0 | 90 | 180 | 270; splitSpread: boolean; importMode: ImportMode; ocrMargins: OcrMargins };
export type ImportEntry = LogicalPageProvenance & { id: string; label: string; status: "pending"; dpi: number; importMode: ImportMode; ocrMargins: OcrMargins };

export function validateImportRange(begin: number, end: number, numPages: number): string | null {
  if (!Number.isInteger(begin) || !Number.isInteger(end)) return "ページ番号は整数で入力してください。";
  if (begin < 1 || end < begin || end > numPages) return `開始・終了ページは 1〜${numPages} の範囲で指定してください。`;
  return null;
}

export function importEntries(config: ImportConfig): ImportEntry[] {
  const entries: ImportEntry[] = [];
  for (let sourcePage = config.begin; sourcePage <= config.end; sourcePage++) {
    const sides = config.splitSpread ? ["left", "right"] as const : ["single"] as const;
    for (const split of sides) entries.push({ id: `page-${sourcePage}-${split}`, label: split === "single" ? String(sourcePage) : `${sourcePage}${split === "left" ? "L" : "R"}`, sourcePage, split, rotation: config.rotation, angle: 0, status: "pending", dpi: config.importMode === "extract" ? 300 : config.dpi, importMode: config.importMode, ocrMargins: { ...defaultOcrMargins, ...config.ocrMargins } });
  }
  return entries;
}