// @vitest-environment node
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm";
import { ProjectDatabase, PDF_CHUNK_SIZE } from "./projectDatabase";
import { decodeBase64, gzip, gunzip } from "./bytes";
import type { StoredHistory } from "../editHistory";

let sqlite: Awaited<ReturnType<typeof sqlite3InitModule>>;
const opened: Database[] = [];
const history: StoredHistory = { version: 1, order: [], cursor: 0, records: [] };
const manifest = JSON.stringify({ version: 1, pages: [{ id: "p1", label: "1" }, { id: "p2", label: "2", completed: true }] });
beforeAll(async () => { sqlite = await sqlite3InitModule(); });
afterEach(() => { opened.splice(0).forEach(db => db.close()); });
async function project(pdf: Blob = new Blob(["%PDF-1.4\nfixture"])) {
  const db = new sqlite.oo1.DB(":memory:"); opened.push(db);
  const value = new ProjectDatabase(db);
  await value.initialize(pdf, manifest);
  return value;
}

describe("browser .eduba storage", () => {
  it("reads bounded PDF ranges across native 1 MiB chunk boundaries", async () => {
    const pdf = Uint8Array.from({ length: PDF_CHUNK_SIZE + 137 }, (_, index) => index % 251);
    const value = await project(new Blob([pdf]));
    value.validate();
    const begin = PDF_CHUNK_SIZE - 17, end = PDF_CHUNK_SIZE + 123;
    expect(decodeBase64(value.readPdf(begin, end))).toEqual(pdf.subarray(begin, end));
    expect(() => value.readPdf(0, pdf.length + 1)).toThrow("range");
    value.db.exec("DELETE FROM pdf_chunks WHERE chunk_index=1");
    expect(() => value.readPdf(begin, end)).toThrow("incomplete");
  });

  it("rolls back manifest, pages and history together on a stale update", async () => {
    const value = await project();
    const first = JSON.stringify({ id: "p1", blocks: [] });
    const second = JSON.stringify({ id: "p2", blocks: [] });
    value.savePage("p1", first); value.savePage("p2", second);
    await expect(value.saveState("{}", [
      { pageId: "p1", data: JSON.stringify({ id: "p1", blocks: [], changed: true }), expectedData: first },
      { pageId: "p2", data: second, expectedData: "stale" },
    ], history)).rejects.toThrow();
    expect(value.loadPage("p1")).toBe(first);
    expect(value.meta("manifest")).toBe(manifest);
    expect(await value.loadHistory()).toEqual(history);
  });

  it("retains compressed undo/redo through SQLite export and reopening", async () => {
    const value = await project();
    const record = { id: "history-1", data: JSON.stringify({ version: 1, operation: { targetPageId: "p1", changes: [] } }) };
    await value.saveState(manifest, [{ pageId: "p1", data: '{"id":"p1","blocks":[]}', expectedMissing: true }], { version: 1, order: [record.id], cursor: 0, records: [record] });
    const bytes = sqlite.capi.sqlite3_js_db_export(value.db.pointer!);
    expect(new TextDecoder().decode(bytes.subarray(0, 15))).toBe("SQLite format 3");
    const name = `/roundtrip-${crypto.randomUUID()}.eduba`;
    sqlite.capi.sqlite3_js_posix_create_file(name, bytes);
    const db = new sqlite.oo1.DB(name); opened.push(db);
    const restored = new ProjectDatabase(db);
    restored.validate();
    expect(await restored.loadHistory()).toEqual({ version: 1, order: [record.id], cursor: 0, records: [record] });
    // Compression implementations may emit different gzip headers. Compare the record text.
    db.exec("UPDATE edit_history_records SET payload=? WHERE id=?", { bind: [await gzip(record.data), record.id] });
    await restored.saveState(manifest, [], { version: 1, order: [record.id], cursor: 1, records: [record] });
    expect((await restored.loadHistory()).cursor).toBe(1);
    await expect(restored.saveState(manifest, [], { version: 1, order: [record.id], cursor: 1, records: [{ ...record, data: record.data.replace('"p1"', '"different"') }] })).rejects.toThrow("immutable");
    expect((await restored.loadHistory()).records[0]).toEqual(record);
  });

  it("searches Unicode occurrences in manifest order and excludes proofread pages", async () => {
    const value = await project();
    const line = { id: "line", correctedText: "𒀀 cat 𒀀 cat", originalText: "𒀀 cat 𒀀 cat", chars: [], words: [], bbox: { left: 0, top: 0, right: 100, bottom: 20 } };
    const raw = (id: string) => JSON.stringify({ id, blocks: [{ paragraphs: [{ lines: [line] }] }] });
    value.savePage("p1", raw("p1")); value.savePage("p2", raw("p2"));
    expect(value.search("cat", 1, 1)).toMatchObject({ total: 2, results: [{ pageId: "p1", matchOrdinal: 1, matchBBox: line.bbox }] });
    expect(value.search("𒀀", 0, 20).results).toHaveLength(2);
    expect(() => value.bulk([{ pageId: "p2", expectedData: raw("p2"), data: raw("p2") }])).toThrow("proofread");
  });

  it("does not mark an unchanged flush as a new file edit", async () => {
    const value = await project();
    expect((await value.saveState(manifest, [], history)).changed).toBe(false);
  });

  it("rejects invalid schemas and gzip payloads", async () => {
    const value = await project();
    value.setMeta("schema_version", "999");
    expect(() => value.validate()).toThrow("schema");
    await expect(gunzip(new TextEncoder().encode("not gzip"))).rejects.toThrow();
  });
});
