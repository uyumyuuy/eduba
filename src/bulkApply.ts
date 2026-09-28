import { allLines, clearLineFormatting, effectiveFormatting, setLineFormatting, updateLineText, type DocumentPage, type TextFormatRange } from "./domain";
import type { BulkMatch } from "./BulkReplaceDialog";

export type BulkPageUpdate = {
  pageId: string;
  expectedData: string;
  data: string;
};

export type PrepareBulkUpdatesArgs = {
  selections: BulkMatch[];
  search: string;
  replacement: string;
  replacementFormatting?: TextFormatRange[];
  preserveFormatting?: boolean;
  loadPage: (pageId: string) => Promise<string>;
};

type MatchSpan = { start: number; end: number; ordinal: number };

function nonOverlappingMatches(text: string, search: string): MatchSpan[] {
  const matches: MatchSpan[] = [];
  let start = 0;
  while (start <= text.length - search.length) {
    const found = text.indexOf(search, start);
    if (found === -1) break;
    matches.push({ start: found, end: found + search.length, ordinal: matches.length });
    start = found + search.length;
  }
  return matches;
}

/**
 * Produces complete, validated page replacements for a selected bulk operation.
 * It performs no persistence; callers pass these updates to the atomic backend
 * command only after this function resolves.
 */
export async function prepareBulkUpdates({
  selections,
  search,
  replacement,
  replacementFormatting = [],
  preserveFormatting = false,
  loadPage,
}: PrepareBulkUpdatesArgs): Promise<BulkPageUpdate[]> {
  if (!search) throw new Error("Bulk replacement search text is required.");

  const byPage = new Map<string, BulkMatch[]>();
  for (const selection of selections) {
    const pageSelections = byPage.get(selection.pageId) ?? [];
    pageSelections.push(selection);
    byPage.set(selection.pageId, pageSelections);
  }

  const updates: BulkPageUpdate[] = [];
  for (const [pageId, pageSelections] of byPage) {
    const expectedData = await loadPage(pageId);
    let page: DocumentPage;
    try {
      page = JSON.parse(expectedData) as DocumentPage;
    } catch {
      throw new Error(`Saved OCR data for page ${pageId} is invalid.`);
    }

    const byLine = new Map<string, BulkMatch[]>();
    for (const selection of pageSelections) {
      const lineSelections = byLine.get(selection.lineId) ?? [];
      lineSelections.push(selection);
      byLine.set(selection.lineId, lineSelections);
    }

    for (const [lineId, lineSelections] of byLine) {
      const line = allLines(page).find((candidate) => candidate.id === lineId);
      if (!line) throw new Error(`Line ${lineId} no longer exists on page ${pageId}.`);

      if (lineSelections.some((selection) => selection.lineText !== line.correctedText)) {
        throw new Error(`Line ${lineId} changed before replacement.`);
      }

      const matches = nonOverlappingMatches(line.correctedText, search);
      const selectedOrdinals = new Set<number>();
      const spans: MatchSpan[] = [];
      for (const selection of lineSelections) {
        if (!Number.isInteger(selection.matchOrdinal) || selectedOrdinals.has(selection.matchOrdinal)) continue;
        const match = matches[selection.matchOrdinal];
        if (!match) {
          throw new Error(`The selected match in line ${lineId} changed before replacement.`);
        }
        selectedOrdinals.add(selection.matchOrdinal);
        spans.push(match);
      }

      for (const span of spans.sort((left, right) => right.start - left.start)) {
        const current = allLines(page).find((candidate) => candidate.id === lineId);
        if (!current || current.correctedText.slice(span.start, span.end) !== search) {
          throw new Error(`The selected match in line ${lineId} changed before replacement.`);
        }
        const oldFormatting = preserveFormatting ? effectiveFormatting(current) : [];
        const nextText = current.correctedText.slice(0, span.start)
          + replacement
          + current.correctedText.slice(span.end);
        page = updateLineText(page, lineId, nextText);
        // updateLineText preserves ranges outside the replaced text. Rebuild
        // only the inserted interval from either the source match or editor.
        page = clearLineFormatting(page, lineId, span.start, span.start + replacement.length);
        const formats = preserveFormatting
          ? oldFormatting.flatMap(range => {
              const from = Math.max(range.start, span.start);
              const to = Math.min(range.end, span.end);
              if (from >= to || replacement.length === 0) return [];
              const sourceLength = span.end - span.start;
              const start = Math.floor((from - span.start) * replacement.length / sourceLength);
              const end = Math.max(start + 1, Math.ceil((to - span.start) * replacement.length / sourceLength));
              return [{ ...range, start, end }];
            })
          : replacementFormatting;
        for (const range of formats) {
          const start = Math.max(0, Math.min(replacement.length, range.start));
          const end = Math.max(start, Math.min(replacement.length, range.end));
          page = setLineFormatting(page, lineId, span.start + start, span.start + end, range.kind, true);
        }
      }
    }

    updates.push({ pageId, expectedData, data: JSON.stringify(page) });
  }
  return updates;
}
