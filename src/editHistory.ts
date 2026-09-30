import { allLines, type DocumentPage, type OcrLine } from "./domain";

export type PageHistoryChange = { pageId: string; beforeData: string | null; afterData: string | null };
export type LineHistoryChange = { kind: "lines"; pageId: string; beforeLines: OcrLine[]; afterLines: OcrLine[] };
export type HistoryChange = PageHistoryChange | LineHistoryChange;
export type HistoryOperation<S = unknown, E = unknown> = {
  changes: HistoryChange[];
  targetPageId: string;
  lineEditSessionId?: number;
  beforeSettings?: S;
  afterSettings?: S;
  beforeEntry?: E;
  afterEntry?: E;
};
export type HistoryRecord = { id: string; data: string };
export type StoredHistory = { version: 1; order: string[]; cursor: number; records: HistoryRecord[] };
export type ProjectPageUpdate = { pageId: string; data: string | null; expectedData?: string; expectedMissing?: boolean };
export const MAX_HISTORY_OPERATIONS = 100;

/** Keep line changes only when the page hierarchy and all page-level data are identical. */
export function compactChange(change: PageHistoryChange): HistoryChange {
  if (change.beforeData === null || change.afterData === null) return change;
  const before = JSON.parse(change.beforeData) as DocumentPage;
  const after = JSON.parse(change.afterData) as DocumentPage;
  const structure = (page: DocumentPage) => JSON.stringify({ ...page, blocks: page.blocks.map(block => ({
    ...block, paragraphs: block.paragraphs.map(paragraph => ({ ...paragraph, lines: paragraph.lines.map(line => line.id) })),
  })) });
  if (structure(before) !== structure(after)) return change;
  const beforeLines = allLines(before), afterLines = allLines(after);
  const changed = beforeLines.map((line, index) => JSON.stringify(line) !== JSON.stringify(afterLines[index]) ? index : -1).filter(index => index >= 0);
  return { kind: "lines", pageId: change.pageId, beforeLines: changed.map(index => beforeLines[index]), afterLines: changed.map(index => afterLines[index]) };
}

export function historyPageUpdate(change: HistoryChange, current: string | null, reverse: boolean): ProjectPageUpdate {
  if (!("kind" in change)) {
    const expected = reverse ? change.afterData : change.beforeData;
    return {
      pageId: change.pageId, ...(expected === null ? { expectedMissing: true } : { expectedData: expected }),
      data: reverse ? change.beforeData : change.afterData,
    };
  }
  if (current === null) throw new Error("History page is unavailable.");
  const page = JSON.parse(current) as DocumentPage;
  const expected = reverse ? change.afterLines : change.beforeLines;
  const replacement = reverse ? change.beforeLines : change.afterLines;
  const lines = new Map(allLines(page).map(line => [line.id, line]));
  for (const line of expected) {
    if (JSON.stringify(lines.get(line.id)) !== JSON.stringify(line)) throw new Error(`History no longer matches line ${line.id}.`);
  }
  const replacements = new Map(replacement.map(line => [line.id, line]));
  for (const block of page.blocks) for (const paragraph of block.paragraphs) {
    paragraph.lines = paragraph.lines.map(line => replacements.get(line.id) ?? line);
  }
  return { pageId: change.pageId, expectedData: current, data: JSON.stringify(page) };
}

/** Serializes new operations only. Existing gzip records are referenced by their immutable IDs. */
export class HistoryPersistence<S, E> {
  private records = new WeakMap<HistoryOperation<S, E>, HistoryRecord>();
  private saved = new Set<string>();

  reset() { this.records = new WeakMap(); this.saved.clear(); }

  restore(history: StoredHistory): { undo: HistoryOperation<S, E>[]; redo: HistoryOperation<S, E>[] } {
    this.reset();
    if (history.version !== 1 || !Array.isArray(history.order) || !Number.isInteger(history.cursor) || history.cursor < 0 || history.cursor > history.order.length) throw new Error("Invalid saved edit history.");
    const records = new Map(history.records.map(record => [record.id, record]));
    const operations = history.order.map(id => {
      const record = records.get(id);
      if (!record) throw new Error("Missing saved edit history record.");
      const value = JSON.parse(record.data);
      if (value.version !== 1 || !value.operation || !Array.isArray(value.operation.changes) || typeof value.operation.targetPageId !== "string") throw new Error("Unsupported saved edit history.");
      const operation = value.operation as HistoryOperation<S, E>;
      delete operation.lineEditSessionId;
      this.records.set(operation, record);
      this.saved.add(id);
      return operation;
    });
    return { undo: operations.slice(0, history.cursor), redo: operations.slice(history.cursor) };
  }

  capture(undo: HistoryOperation<S, E>[], redo: HistoryOperation<S, E>[]) {
    const keptUndo = undo.slice(-MAX_HISTORY_OPERATIONS);
    const keptRedo = redo.slice(0, MAX_HISTORY_OPERATIONS - keptUndo.length);
    const operations = [...keptUndo, ...keptRedo];
    const records = operations.map(operation => {
      let record = this.records.get(operation);
      if (!record) {
        // Session IDs belong to the current editor instance, not to the saved project.
        const { lineEditSessionId: _session, ...persisted } = operation;
        record = { id: crypto.randomUUID(), data: JSON.stringify({ version: 1, operation: persisted }) };
        this.records.set(operation, record);
      }
      return record;
    });
    return { order: records.map(record => record.id), cursor: keptUndo.length, records, operations };
  }

  pending(captured: ReturnType<HistoryPersistence<S, E>["capture"]>): StoredHistory {
    return { version: 1, order: captured.order, cursor: captured.cursor, records: captured.records.filter(record => !this.saved.has(record.id)) };
  }

  confirm(order: string[]) { this.saved = new Set(order); }
}
