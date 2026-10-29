import type { Database, SqlValue } from "@sqlite.org/sqlite-wasm";
import type { StoredHistory, ProjectPageUpdate } from "../editHistory";
import type { BackendCommands } from "../tauri";
import { allLines, type DocumentPage, type OcrLine, type Rect } from "../domain";
import { encodeBase64, gzip, gunzip } from "./bytes";

export const PDF_CHUNK_SIZE = 1024 * 1024;
const HISTORY_BUDGET = 50 * 1024 * 1024;
type Manifest = { pages?: Array<{ id: string; label?: string; completed?: boolean }> };

export function validateManifest(raw: string): Manifest {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Manifest must be a JSON object.");
  return value;
}

function validateHistory(history: StoredHistory) {
  if (history.version !== 1 || !Array.isArray(history.order) || history.order.length > 100 ||
      new Set(history.order).size !== history.order.length || history.order.some(id => !id || id.length > 128) ||
      !Number.isInteger(history.cursor) || history.cursor < 0 || history.cursor > history.order.length) {
    throw new Error("Invalid edit history state.");
  }
}
function validateRecord(raw: string) {
  const record = JSON.parse(raw);
  if (new TextEncoder().encode(raw).length > 128 * 1024 * 1024 || record.version !== 1 ||
      !Array.isArray(record.operation?.changes) || typeof record.operation.targetPageId !== "string") {
    throw new Error("Unsupported edit history record.");
  }
}

/** Uses the desktop schema, including PDF chunks and gzip history records. */
export class ProjectDatabase {
  constructor(readonly db: Database) {}

  private run(sql: string, bind: SqlValue[] = []) { this.db.exec(sql, { bind }); }
  private value(sql: string, bind: SqlValue[] = []) { return this.db.selectValue(sql, bind.length ? bind : undefined); }
  meta(key: string): string | null { return this.value("SELECT value FROM meta WHERE key=?", [key]) as string ?? null; }
  setMeta(key: string, value: string): boolean {
    if (this.meta(key) === value) return false;
    this.run("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]);
    return true;
  }
  workingSummary() {
    const manifest = this.meta("manifest");
    const pages = manifest ? validateManifest(manifest).pages : undefined;
    const modifiedAt = this.meta("browser_modified_at");
    return {
      pageCount: Array.isArray(pages) ? pages.length : null,
      sizeBytes: Number(this.value("PRAGMA page_count")) * Number(this.value("PRAGMA page_size")),
      modifiedAt: modifiedAt && Number.isFinite(Date.parse(modifiedAt)) ? new Date(modifiedAt).toISOString() : null,
    };
  }
  private markModified() { this.setMeta("browser_modified_at", new Date().toISOString()); }
  private saveContent(write: () => boolean): boolean {
    this.run("BEGIN IMMEDIATE");
    try {
      const changed = write();
      if (changed) this.markModified();
      this.run("COMMIT");
      return changed;
    } catch (error) { this.run("ROLLBACK"); throw error; }
  }
  saveManifest(manifest: string): boolean {
    validateManifest(manifest);
    return this.saveContent(() => this.setMeta("manifest", manifest));
  }
  loadPage(id: string): string | null { return this.value("SELECT data FROM pages WHERE page_id=?", [id]) as string ?? null; }
  savePage(id: string, data: string | null): boolean {
    return this.saveContent(() => this.writePage(id, data));
  }
  private writePage(id: string, data: string | null): boolean {
    if (this.loadPage(id) === data) return false;
    if (data === null) this.run("DELETE FROM pages WHERE page_id=?", [id]);
    else {
      if (JSON.parse(data).id !== id) throw new Error("Page ID does not match its data.");
      this.run("INSERT INTO pages(page_id,data) VALUES (?,?) ON CONFLICT(page_id) DO UPDATE SET data=excluded.data", [id, data]);
    }
    return true;
  }

  async initialize(pdf: Blob, manifest?: string): Promise<void> {
    if (manifest) validateManifest(manifest);
    this.run("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; CREATE TABLE meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL); CREATE TABLE pdf_chunks(chunk_index INTEGER PRIMARY KEY NOT NULL,data BLOB NOT NULL); CREATE TABLE pages(page_id TEXT PRIMARY KEY NOT NULL,data TEXT NOT NULL);");
    this.run("BEGIN IMMEDIATE");
    try {
      for (let begin = 0; begin < pdf.size; begin += PDF_CHUNK_SIZE) {
        this.run("INSERT INTO pdf_chunks(chunk_index,data) VALUES (?,?)", [begin / PDF_CHUNK_SIZE, new Uint8Array(await pdf.slice(begin, begin + PDF_CHUNK_SIZE).arrayBuffer())]);
      }
      this.setMeta("schema_version", "1");
      this.setMeta("pdf_size", String(pdf.size));
      if (manifest) this.setMeta("manifest", manifest);
      this.markModified();
      this.run("COMMIT");
    } catch (error) { this.run("ROLLBACK"); throw error; }
  }

  validate(): void {
    if (this.meta("schema_version") !== "1") throw new Error("Unsupported Eduba project schema.");
    for (const table of ["meta", "pdf_chunks", "pages"]) {
      if (!this.value("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [table])) throw new Error(`Project is missing ${table}.`);
    }
    const size = Number(this.meta("pdf_size"));
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid stored PDF size.");
    if (Number(this.value("SELECT coalesce(sum(length(data)),0) FROM pdf_chunks")) !== size) throw new Error("Stored PDF chunks are incomplete.");
    const manifest = this.meta("manifest");
    if (manifest) validateManifest(manifest);
    if (this.value("PRAGMA quick_check") !== "ok") throw new Error("Project database is damaged.");
  }

  readPdf(begin: number, end: number): string {
    const size = Number(this.meta("pdf_size"));
    if (![begin, end].every(Number.isSafeInteger) || begin < 0 || end <= begin || end > size || end - begin > 16 * PDF_CHUNK_SIZE) throw new Error("Invalid PDF range.");
    const bytes = new Uint8Array(end - begin);
    let cursor = 0;
    for (let index = Math.floor(begin / PDF_CHUNK_SIZE); index <= Math.floor((end - 1) / PDF_CHUNK_SIZE); index++) {
      const data = this.value("SELECT data FROM pdf_chunks WHERE chunk_index=?", [index]) as Uint8Array | undefined;
      if (!data) throw new Error("Stored PDF chunks are incomplete.");
      const part = data.subarray(Math.max(0, begin - index * PDF_CHUNK_SIZE), Math.min(data.length, end - index * PDF_CHUNK_SIZE));
      bytes.set(part, cursor); cursor += part.length;
    }
    if (cursor !== bytes.length) throw new Error("Stored PDF chunks are incomplete.");
    return encodeBase64(bytes);
  }

  async loadHistory(): Promise<StoredHistory> {
    const raw = this.meta("edit_history");
    if (!raw) return { version: 1, order: [], cursor: 0, records: [] };
    const history: StoredHistory = JSON.parse(raw);
    validateHistory(history);
    history.records = [];
    for (const id of history.order) {
      const payload = this.value("SELECT payload FROM edit_history_records WHERE id=?", [id]) as Uint8Array | undefined;
      if (!payload) throw new Error("Missing edit history record.");
      const data = await gunzip(payload);
      validateRecord(data);
      history.records.push({ id, data });
    }
    return history;
  }

  async saveState(manifest: string, updates: ProjectPageUpdate[], history: StoredHistory): Promise<{ order: string[]; cursor: number; changed: boolean }> {
    validateManifest(manifest);
    validateHistory(history);
    const ids = new Set<string>();
    for (const update of updates) {
      if (!update.pageId || ids.has(update.pageId) || (update.expectedMissing && update.expectedData !== undefined) ||
          (update.data !== null && JSON.parse(update.data).id !== update.pageId)) throw new Error("Project updates require unique matching page IDs.");
      ids.add(update.pageId);
    }
    const records = new Map<string, { data: string; payload: Uint8Array }>();
    for (const record of history.records) {
      if (!history.order.includes(record.id) || records.has(record.id)) throw new Error("Invalid edit history records.");
      validateRecord(record.data);
      records.set(record.id, { data: record.data, payload: await gzip(record.data) });
    }
    const previousHistory = JSON.parse(this.meta("edit_history") ?? '{"order":[],"cursor":0}');
    if (records.size === 0 && this.meta("manifest") === manifest &&
        JSON.stringify(previousHistory.order) === JSON.stringify(history.order) && previousHistory.cursor === history.cursor &&
        updates.every(update => this.loadPage(update.pageId) === update.data &&
          (!update.expectedMissing || update.data === null) &&
          (update.expectedData === undefined || update.expectedData === update.data))) {
      return { order: history.order, cursor: history.cursor, changed: false };
    }
    // All asynchronous compression completes before acquiring the transaction.
    this.run("BEGIN IMMEDIATE");
    try {
      const completed = this.completed();
      for (const update of updates) {
        const actual = this.loadPage(update.pageId);
        if (update.expectedMissing && actual !== null) throw new Error("History expected an unrecognized page.");
        if (update.expectedData !== undefined && (actual !== update.expectedData || completed.has(update.pageId))) throw new Error("Page changed or is marked proofread.");
      }
      this.run("CREATE TABLE IF NOT EXISTS edit_history_records(id TEXT PRIMARY KEY NOT NULL,payload BLOB NOT NULL)");
      let changed = false;
      // An imported gzip stream need not use the same compression settings.
      for (const [id, record] of records) {
        const existing = this.value("SELECT payload FROM edit_history_records WHERE id=?", [id]) as Uint8Array | undefined;
        if (existing) {
          if (await gunzip(existing) !== record.data) throw new Error("Edit history record IDs are immutable.");
        } else {
          this.run("INSERT INTO edit_history_records(id,payload) VALUES (?,?)", [id, record.payload]);
          changed = true;
        }
      }
      const order = [...history.order];
      let cursor = history.cursor;
      const sizes = new Map(order.map(id => {
        const size = this.value("SELECT length(payload) FROM edit_history_records WHERE id=?", [id]);
        if (typeof size !== "number") throw new Error("Missing edit history record.");
        return [id, size] as const;
      }));
      let bytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
      while (bytes > HISTORY_BUDGET && order.length) {
        const id = cursor > 0 ? (cursor--, order.shift()!) : order.pop()!;
        bytes -= sizes.get(id)!;
      }
      for (const id of this.db.selectValues("SELECT id FROM edit_history_records") as string[]) {
        if (!order.includes(id)) {
          this.run("DELETE FROM edit_history_records WHERE id=?", [id]);
          changed = true;
        }
      }
      for (const update of updates) changed = this.writePage(update.pageId, update.data) || changed;
      changed = this.setMeta("edit_history", JSON.stringify({ version: 1, order, cursor, records: [] })) || changed;
      changed = this.setMeta("manifest", manifest) || changed;
      if (changed) this.markModified();
      this.run("COMMIT");
      return { order, cursor, changed };
    } catch (error) { this.run("ROLLBACK"); throw error; }
  }

  private completed(): Set<string> {
    return new Set((JSON.parse(this.meta("manifest") ?? "{}") as Manifest).pages?.filter(page => page.completed).map(page => page.id));
  }

  search(search: string, page: number, pageSize: number): BackendCommands["search_corrections"]["result"] {
    if (!search || !Number.isInteger(page) || page < 0 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error("Invalid correction search.");
    const manifest: Manifest = JSON.parse(this.meta("manifest") ?? "{}");
    const ordered = (manifest.pages ?? []).map((entry, index) => ({ ...entry, label: entry.label ?? String(index + 1) }));
    const known = new Set(ordered.map(entry => entry.id));
    for (const id of this.db.selectValues("SELECT page_id FROM pages ORDER BY page_id") as string[]) {
      if (!known.has(id)) ordered.push({ id, label: id });
    }
    const results: BackendCommands["search_corrections"]["result"]["results"] = [];
    let total = 0;
    for (const entry of ordered) {
      if (entry.completed) continue;
      const raw = this.loadPage(entry.id);
      if (!raw) continue;
      for (const line of allLines(JSON.parse(raw) as DocumentPage)) {
        let offset = 0, ordinal = 0;
        while ((offset = line.correctedText.indexOf(search, offset)) >= 0) {
          if (total >= page * pageSize && results.length < pageSize) results.push({
            pageId: entry.id, pageLabel: entry.label, lineId: line.id, lineText: line.correctedText,
            formatting: line.formatting ?? null, autoFormatting: line.autoFormatting ?? null,
            bbox: line.bbox, matchBBox: matchBounds(line, offset, offset + search.length), matchOrdinal: ordinal,
          });
          total++; ordinal++; offset += search.length;
        }
      }
    }
    return { results, total, page, pageSize };
  }

  bulk(updates: BackendCommands["apply_bulk_corrections"]["args"]["updates"]): BackendCommands["apply_bulk_corrections"]["result"] {
    const seen = new Set<string>(), completed = this.completed();
    const changes = updates.map(update => {
      if (!update.pageId || seen.has(update.pageId) || completed.has(update.pageId)) throw new Error("Invalid or proofread page in bulk update.");
      seen.add(update.pageId);
      if (JSON.parse(update.data).id !== update.pageId) throw new Error("Page ID does not match its data.");
      const beforeData = this.loadPage(update.pageId);
      if (beforeData === null || beforeData !== update.expectedData) throw new Error("Page changed while preparing bulk replacement.");
      return { pageId: update.pageId, beforeData, afterData: update.data };
    });
    this.saveContent(() => {
      let changed = false;
      for (const change of changes) changed = this.writePage(change.pageId, change.afterData) || changed;
      return changed;
    });
    return changes;
  }
}

/** Use preserved character boxes only when they still describe the edited text. */
export function matchBounds(line: OcrLine, start: number, end: number): Rect {
  if (line.chars.map(char => char.correctedText).join("") !== line.correctedText) return line.bbox;
  let offset = 0;
  const boxes: Rect[] = [];
  for (const char of line.chars) {
    const charStart = offset; offset += char.correctedText.length;
    if (charStart >= end || offset <= start) continue;
    const box = char.bbox;
    if (!box || !Object.values(box).every(Number.isFinite) || box.right <= box.left || box.bottom <= box.top) return line.bbox;
    boxes.push(box);
  }
  return boxes.length ? { left: Math.min(...boxes.map(box => box.left)), top: Math.min(...boxes.map(box => box.top)), right: Math.max(...boxes.map(box => box.right)), bottom: Math.max(...boxes.map(box => box.bottom)) } : line.bbox;
}
