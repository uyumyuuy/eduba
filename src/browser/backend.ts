import type { BackendCommands, ProjectInfo } from "../tauri";
import { localFile, forgetFile, dialogSave, writeLocalFile, type LocalFile } from "./files";
import { decodeBase64, encodeBase64 } from "./bytes";
import { BrowserOcr, DEFAULT_MODEL, assetUrl } from "./ocr";
import { workerRpc } from "./rpc";
import { storeModel } from "./modelStore";
import { requestStorageProtection } from "./storage";

const database = workerRpc(() => new Worker(new URL("./database.worker.ts", import.meta.url), { type: "module" }));
const inference = workerRpc(() => new Worker(new URL("./inference.worker.ts", import.meta.url), { type: "module" }));
const ocr = new BrowserOcr();
const destinations = new Map<string, LocalFile>();
const dirty = new Set<string>();
const revisions = new Map<string, number>();
type Preferences = BackendCommands["get_user_preferences"]["result"];
function preferences(): Preferences {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("eduba-browser-preferences") ?? "{}"); } catch { /* Ignore damaged preferences. */ }
  return { version: 1, language: "auto", lastProject: null, imageMagnifierEnabled: true, textMagnifierEnabled: true, ...saved, osLocale: navigator.language };
}
function savePreferences(value: Partial<Preferences>) { localStorage.setItem("eduba-browser-preferences", JSON.stringify({ ...preferences(), ...value })); }
function changed(path: string, changed = true) {
  if (changed) revisions.set(path, (revisions.get(path) ?? 0) + 1);
  if (changed) dirty.add(path); else dirty.delete(path);
  window.dispatchEvent(new Event("eduba-browser-save-state"));
}
function workingProjectsChanged() { window.dispatchEvent(new Event("eduba-browser-projects-changed")); }
export function isProjectDirty(path?: string): boolean { return path ? dirty.has(path) : dirty.size > 0; }
export function markBrowserProjectDirty(path: string): void { changed(path); }
export async function activateBrowserProject(path: string): Promise<void> {
  await database("activate", { projectPath: path });
  void requestStorageProtection();
}
export type WorkingProjectInfo = ProjectInfo & {
  pageCount: number | null;
  sizeBytes: number;
  modifiedAt: string | null;
};
export function workingProjects(): Promise<WorkingProjectInfo[]> { return database("list"); }
export async function createBrowserProject(pdfPath: string, manifest?: string): Promise<ProjectInfo> {
  const source = localFile(pdfPath);
  const file = source.file ?? await source.handle!.getFile();
  const name = `${(source.name || "project.pdf").replace(/\.pdf$/i, "")}.eduba`;
  const info = await database<ProjectInfo>("create", { file, name, manifest });
  // A new working copy has no external destination until the user explicitly saves it.
  changed(info.path);
  workingProjectsChanged();
  return info;
}
export async function deleteWorkingProject(path: string): Promise<void> {
  if (!/^opfs:\/[a-z0-9-]+\.eduba$/.test(path)) throw new Error("Invalid working project identifier.");
  const previous = preferences().lastProject;
  const clearLast = previous?.path === path;
  if (clearLast) savePreferences({ lastProject: null });
  try {
    await database("delete", { projectPath: path });
  } catch (error) {
    if (clearLast && preferences().lastProject === null) {
      try { savePreferences({ lastProject: previous }); } catch { /* Keep the deletion error. */ }
    }
    throw error;
  }
  destinations.delete(path);
  revisions.delete(path);
  changed(path, false);
  workingProjectsChanged();
}

/** Acquire a picker/permission during the save button's user activation, before flushing. */
export async function prepareProjectSave(info: ProjectInfo, saveAs = false): Promise<LocalFile | null> {
  const target = destinations.get(info.path);
  if (!saveAs && target?.handle) {
    if (await target.handle.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("Permission to save the project was not granted.");
    return target;
  }
  const path = await dialogSave({ defaultPath: info.name, filters: [{ name: "Eduba", extensions: ["eduba"] }] });
  if (!path) return null;
  const selected = localFile(path); forgetFile(path);
  return selected;
}
export async function saveBrowserProject(info: ProjectInfo, target: LocalFile): Promise<void> {
  const revision = revisions.get(info.path);
  const bytes = await database<Uint8Array>("export", { projectPath: info.path });
  await writeLocalFile(target, bytes);
  await database("rename", { projectPath: info.path, name: target.name });
  destinations.set(info.path, target);
  if (revisions.get(info.path) === revision) changed(info.path, false);
}
export async function importBrowserModel(path: string): Promise<string> {
  const selected = localFile(path);
  const file = selected.file ?? await selected.handle!.getFile();
  const id = await storeModel(file);
  forgetFile(path);
  return id;
}

type CommandHandler<K extends keyof BackendCommands> = (args: BackendCommands[K]["args"]) => Promise<BackendCommands[K]["result"]>;
const handlers: { [K in keyof BackendCommands]: CommandHandler<K> } = {
  get_user_preferences: async () => preferences(),
  save_user_preferences: async args => savePreferences({ language: args.language }),
  save_magnifier_preferences: async args => savePreferences(args),
  save_last_opened_project: async args => savePreferences({ lastProject: { path: args.projectPath, pageId: args.pageId } }),
  set_ui_language: async () => {},
  get_environment: async () => ({ modelPath: DEFAULT_MODEL, tesseractPath: "Tesseract.js" }),
  inspect_pdf: async args => ({ pdfSize: (localFile(args.pdfPath).file ?? await localFile(args.pdfPath).handle!.getFile()).size }),
  read_source_pdf_range: async args => {
    const source = localFile(args.pdfPath);
    const file = source.file ?? await source.handle!.getFile();
    if (![args.begin, args.end].every(Number.isSafeInteger) || args.begin < 0 || args.end <= args.begin || args.end > file.size || args.end - args.begin > 16 * 1024 * 1024) throw new Error("Invalid PDF range.");
    return encodeBase64(new Uint8Array(await file.slice(args.begin, args.end).arrayBuffer()));
  },
  create_project: args => createBrowserProject(args.pdfPath, args.manifest),
  open_project: async args => {
    if (args.projectPath.startsWith("opfs:")) {
      const info = await database<ProjectInfo>("open_project", args);
      changed(info.path);
      return info;
    }
    const source = localFile(args.projectPath), file = source.file ?? await source.handle!.getFile();
    const info = await database<ProjectInfo>("import", { file, name: source.name });
    destinations.set(info.path, { name: source.name, handle: source.handle, file: source.file });
    // Importing does not write to the source file.
    changed(info.path, false);
    forgetFile(args.projectPath);
    workingProjectsChanged();
    return info;
  },
  read_pdf_range: args => database("read_pdf_range", args),
  load_page: args => database("load_page", args),
  save_page: async args => { await database("save_page", args); changed(args.projectPath); },
  save_manifest: async args => { if (await database<boolean>("save_manifest", args)) changed(args.projectPath); },
  load_edit_history: args => database("load_edit_history", args),
  save_project_state: async args => {
    const result = await database<BackendCommands["save_project_state"]["result"] & { changed: boolean }>("save_project_state", args);
    if (result.changed) changed(args.projectPath);
    return result;
  },
  search_corrections: args => database("search_corrections", args),
  apply_bulk_corrections: async args => {
    const result = await database<BackendCommands["apply_bulk_corrections"]["result"]>("apply_bulk_corrections", args);
    changed(args.projectPath);
    return result;
  },
  run_ocr: args => ocr.recognize(args),
  cancel_ocr: () => ocr.cancel(),
  detect_figures: args => inference("detect_figures", { ...args, root: assetUrl("") }),
  classify_word_styles: args => inference("classify_word_styles", { ...args, root: assetUrl("") }),
  export_file: async args => { await writeLocalFile(localFile(args.path), decodeBase64(args.contentBase64)); forgetFile(args.path); },
};
export function browserInvoke<K extends keyof BackendCommands>(command: K, args: BackendCommands[K]["args"]): Promise<BackendCommands[K]["result"]> {
  return handlers[command](args);
}
