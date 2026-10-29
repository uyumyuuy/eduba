import type { DocumentPage, FigureRegion, OcrLine, PageBlock, Paragraph } from "./domain";

export type PageItem = { id: string; bbox: OcrLine["bbox"] } & (
  { kind: "line"; line: OcrLine } | { kind: "figure"; figure: FigureRegion }
);

/** Keep the existing text order; insert unplaced images near their vertical position. */
export function pageItems(page: DocumentPage): PageItem[] {
  const lines: PageItem[] = page.blocks.flatMap(block => block.paragraphs.flatMap(paragraph =>
    paragraph.lines.map(line => ({ kind: "line" as const, id: line.id, bbox: line.bbox, line }))));
  const figures: PageItem[] = (page.figureRegions ?? []).map(figure => ({ kind: "figure", id: figure.id, bbox: figure.bbox, figure }));
  const byId = new Map([...lines, ...figures].map(item => [item.id, item]));
  const items: PageItem[] = [];
  for (const id of page.readingOrderIds ?? lines.map(line => line.id)) {
    const item = byId.get(id);
    if (item && !items.some(existing => existing.id === id)) items.push(item);
  }
  for (const item of [...lines, ...figures]) {
    if (items.some(existing => existing.id === item.id)) continue;
    const index = items.findIndex(existing => existing.bbox.top > item.bbox.top);
    items.splice(index < 0 ? items.length : index, 0, item);
  }
  return items;
}

export type ContentRun = { kind: "text"; blocks: PageBlock[] } | { kind: "figure"; figure: FigureRegion };

/** Split containers at images, so an image can occur between two lines of a paragraph. */
export function contentRuns(page: DocumentPage): ContentRun[] {
  if (!page.figureRegions?.length && !page.readingOrderIds) return [{ kind: "text", blocks: page.blocks }];
  const parents = new Map<string, { block: PageBlock; paragraph: Paragraph }>();
  for (const block of page.blocks) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) parents.set(line.id, { block, paragraph });
  const runs: ContentRun[] = [];
  let block: PageBlock | undefined, paragraph: Paragraph | undefined;
  let blockId = "", paragraphId = "";
  let fragment = 0;
  for (const item of pageItems(page)) {
    if (item.kind === "figure") {
      runs.push({ kind: "figure", figure: item.figure });
      block = undefined; paragraph = undefined;
      continue;
    }
    const parent = parents.get(item.id)!;
    let run = runs.at(-1);
    if (!run || run.kind !== "text") { run = { kind: "text", blocks: [] }; runs.push(run); }
    if (!block || blockId !== parent.block.id) {
      blockId = parent.block.id;
      block = { ...parent.block, id: `${blockId}--content-${++fragment}`, paragraphs: [] };
      run.blocks.push(block);
      paragraph = undefined;
    }
    if (!paragraph || paragraphId !== parent.paragraph.id) {
      paragraphId = parent.paragraph.id;
      paragraph = { ...parent.paragraph, id: `${paragraphId}--content-${fragment}-${block.paragraphs.length}`, lines: [] };
      block.paragraphs.push(paragraph);
    }
    paragraph.lines.push(item.line);
  }
  return runs;
}
