import type { OpenDialogOptions, SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import { open, save } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../tauri";

export type LocalFileHandle = {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob | Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
  queryPermission(options: { mode: "readwrite" }): Promise<string>;
  requestPermission(options: { mode: "readwrite" }): Promise<string>;
};
type PickerWindow = Window & {
  showOpenFilePicker?: (options: unknown) => Promise<LocalFileHandle[]>;
  showSaveFilePicker?: (options: unknown) => Promise<LocalFileHandle>;
};
export type LocalFile = { name: string; file?: File; handle?: LocalFileHandle };
const files = new Map<string, LocalFile>();

export function registerFile(value: LocalFile): string {
  const path = `browser:/${crypto.randomUUID()}/${value.name}`;
  files.set(path, value);
  return path;
}
export function localFile(path: string): LocalFile {
  const value = files.get(path);
  if (!value) throw new Error("Select the local file again.");
  return value;
}
export function forgetFile(path: string): void { files.delete(path); }
export function fileName(path: string): string { return path.replace(/\\/g, "/").split("/").at(-1) || "project.eduba"; }

function types(filters: OpenDialogOptions["filters"]) {
  return filters?.map(filter => ({ description: filter.name, accept: { "application/octet-stream": filter.extensions.map(extension => `.${extension}`) } }));
}

export async function dialogOpen(options: OpenDialogOptions): Promise<string | null> {
  if (isTauri) {
    const path = await open(options);
    return typeof path === "string" ? path : null;
  }
  const picker = (window as PickerWindow).showOpenFilePicker;
  try {
    if (picker) {
      const [handle] = await picker.call(window, { multiple: false, types: types(options.filters) });
      return registerFile({ name: handle.name, handle, file: await handle.getFile() });
    }
    return await new Promise(resolve => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = options.filters?.flatMap(filter => filter.extensions.map(extension => `.${extension}`)).join(",") ?? "";
      input.style.display = "none";
      const finish = (file?: File) => { input.remove(); resolve(file ? registerFile({ name: file.name, file }) : null); };
      input.onchange = () => finish(input.files?.[0]);
      input.oncancel = () => finish();
      document.body.append(input);
      input.click();
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

export async function dialogSave(options: SaveDialogOptions): Promise<string | null> {
  if (isTauri) return save(options);
  const name = fileName(options.defaultPath ?? "project.eduba");
  const picker = (window as PickerWindow).showSaveFilePicker;
  try {
    if (picker) {
      const handle = await picker.call(window, { suggestedName: name, types: types(options.filters) });
      return registerFile({ name: handle.name, handle });
    }
    return registerFile({ name });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

export async function writeLocalFile(destination: LocalFile, bytes: Uint8Array): Promise<void> {
  if (destination.handle) {
    if (destination.file) {
      const current = await destination.handle.getFile();
      if (current.size !== destination.file.size || current.lastModified !== destination.file.lastModified) {
        throw new Error("The project file changed outside Eduba. Use Save as to choose a destination.");
      }
    }
    const stream = await destination.handle.createWritable();
    try { await stream.write(bytes); await stream.close(); destination.file = await destination.handle.getFile(); }
    catch (error) { await stream.abort().catch(() => undefined); throw error; }
  } else {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = destination.name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}
