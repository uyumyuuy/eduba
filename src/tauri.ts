import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export type BackendCommands = {
  get_environment: { args: undefined; result: { modelPath: string; tesseractPath: string } };
  create_project: { args: { pdfPath: string; projectPath: string }; result: ProjectInfo };
  open_project: { args: { projectPath: string }; result: ProjectInfo };
  read_pdf_range: { args: { projectPath: string; begin: number; end: number }; result: string };
  save_manifest: { args: { projectPath: string; manifest: string }; result: void };
  load_page: { args: { projectPath: string; pageId: string }; result: string | null };
  save_page: { args: { projectPath: string; pageId: string; data: string }; result: void };
  run_ocr: { args: { imageBase64: string; modelPath: string; psm: number; dpi?: number }; result: string };
  cancel_ocr: { args: undefined; result: void };
  export_file: { args: { path: string; contentBase64: string }; result: void };
};

export type ProjectInfo = { path: string; name: string; pdfSize: number; manifest: string | null };

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function invokeCommand<K extends keyof BackendCommands>(
  command: K,
  ...args: BackendCommands[K]["args"] extends undefined ? [] : [BackendCommands[K]["args"]]
): Promise<BackendCommands[K]["result"]> {
  if (!isTauri) throw new Error("Eduba のデスクトップ機能は Tauri アプリで利用できます。");
  return tauriInvoke(command as string, (args[0] ?? undefined) as Record<string, unknown>);
}
