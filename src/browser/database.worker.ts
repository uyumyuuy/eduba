import sqlite3InitModule, { type SAHPoolUtil } from "@sqlite.org/sqlite-wasm";
import { ProjectDatabase, validateManifest } from "./projectDatabase";

type Request = { id: number; command: string; args: Record<string, unknown> };
const projects = new Map<string, ProjectDatabase>();
let pool: SAHPoolUtil;
let initialization: Promise<void> | undefined;
function initialize(): Promise<void> {
  return initialization ??= new Promise<void>((resolve, reject) => {
    if (!navigator.storage?.getDirectory || !navigator.locks) {
      reject(new Error("This browser cannot save working projects. Use a current desktop browser with OPFS support.")); return;
    }
    void navigator.locks.request("eduba-project-storage", { ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error("Eduba is already open in another tab. Close that tab before opening a project here.")); return; }
      try {
        const sqlite = await sqlite3InitModule();
        pool = await sqlite.installOpfsSAHPoolVfs({ name: "eduba-sahpool", directory: "/eduba-projects", initialCapacity: 6 });
        resolve();
        // Keep the storage lock for this worker's lifetime.
        await new Promise(() => {});
      } catch (error) { reject(error); }
    }).catch(reject);
  }).catch(error => { initialization = undefined; throw error; });
}

function filename(path: unknown): string {
  if (typeof path !== "string" || !/^opfs:\/[a-z0-9-]+\.eduba$/.test(path)) throw new Error("Invalid working project identifier.");
  return path.slice(5);
}
function project(path: unknown): ProjectDatabase {
  const name = filename(path);
  let value = projects.get(name);
  if (!value) {
    if (!pool.getFileNames().includes(name)) throw new Error("The working project is no longer available. Open your saved .eduba file.");
    value = new ProjectDatabase(new pool.OpfsSAHPoolDb(name));
    try { value.validate(); } catch (error) { value.db.close(); throw error; }
    projects.set(name, value);
  }
  return value;
}
function info(path: string, value: ProjectDatabase) {
  return { path, name: value.meta("browser_name") ?? "project.eduba", pdfSize: Number(value.meta("pdf_size")), manifest: value.meta("manifest") };
}

async function dispatch(command: string, args: Record<string, unknown>): Promise<unknown> {
  await initialize();
  if (command === "list") {
    return pool.getFileNames().filter(name => /^\/[a-z0-9-]+\.eduba$/.test(name)).flatMap(name => {
      const path = `opfs:${name}`;
      try { return [info(path, project(path))]; } catch { return []; }
    });
  }
  if (command === "delete") {
    const name = filename(args.projectPath);
    const value = projects.get(name);
    if (value) {
      try { value.db.close(); } finally { projects.delete(name); }
    }
    // The request queue drains earlier writes before closing and unlinking this DB.
    // Later requests cannot recreate it: project() requires an existing pool file.
    return pool.unlink(name);
  }
  if (command === "create" || command === "import") {
    const name = `/${crypto.randomUUID()}.eduba`, path = `opfs:${name}`;
    await pool.reserveMinimumCapacity(pool.getFileCount() + 4);
    let value: ProjectDatabase | undefined;
    try {
      const file = args.file as File;
      if (command === "import") {
        let begin = 0;
        await pool.importDb(name, async () => {
          if (begin >= file.size) return undefined;
          const chunk = await file.slice(begin, begin + 1024 * 1024).arrayBuffer();
          begin += chunk.byteLength; return chunk;
        });
      }
      value = new ProjectDatabase(new pool.OpfsSAHPoolDb(name));
      if (command === "create") await value.initialize(file, args.manifest as string | undefined);
      value.validate();
      value.setMeta("browser_name", args.name as string);
      projects.set(name, value);
      return info(path, value);
    } catch (error) { value?.db.close(); pool.unlink(name); throw error; }
  }
  const value = project(args.projectPath);
  switch (command) {
    case "open_project": return info(args.projectPath as string, value);
    case "activate": {
      const current = filename(args.projectPath);
      for (const [name, previous] of projects) if (name !== current) {
        previous.db.close(); projects.delete(name);
      }
      return;
    }
    case "export": return pool.exportFile(filename(args.projectPath));
    case "rename": return value.setMeta("browser_name", args.name as string);
    case "read_pdf_range": return value.readPdf(args.begin as number, args.end as number);
    case "load_page": return value.loadPage(args.pageId as string);
    case "save_page": return value.savePage(args.pageId as string, args.data as string);
    case "save_manifest": validateManifest(args.manifest as string); return value.setMeta("manifest", args.manifest as string);
    case "load_edit_history": return value.loadHistory();
    case "save_project_state": return value.saveState(args.manifest as string, args.updates as Parameters<ProjectDatabase["saveState"]>[1], args.history as Parameters<ProjectDatabase["saveState"]>[2]);
    case "search_corrections": return value.search(args.search as string, args.page as number, args.pageSize as number);
    case "apply_bulk_corrections": return value.bulk(args.updates as Parameters<ProjectDatabase["bulk"]>[0]);
    default: throw new Error(`Unknown browser database operation: ${command}`);
  }
}

// Save transactions and import reads must never interleave, even across awaited compression.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent<Request>) => {
  const { id, command, args } = event.data;
  queue = queue.then(async () => {
    try {
      const result = await dispatch(command, args);
      if (result instanceof Uint8Array) self.postMessage({ id, result }, { transfer: [result.buffer] });
      else self.postMessage({ id, result });
    } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
  });
};
