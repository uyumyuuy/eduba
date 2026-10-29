import { exportHocr, type DocumentPage } from "../domain";

/** Text/layout tests use a synthetic PDF frame; geometry contracts have dedicated tests. */
export function exportFixtureHocr(pages: DocumentPage[]): string {
  const numbered = pages.map(page => ({ ...page, sourcePage: Math.max(1, page.sourcePage) }));
  return exportHocr(numbered, {
    fingerprint: "fixture", byteLength: 1,
    pages: Object.fromEntries(numbered.map(page => [page.id, {
      pageToPdf: [1, 0, 0, -1, 0, page.height], pdfBox: [0, 0, page.width, page.height],
      pdfRotation: 0, pdfUserUnit: 1, sourceWidth: page.width, sourceHeight: page.height,
      dpiX: 72, dpiY: 72, mode: "render",
    }])),
  });
}
