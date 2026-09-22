import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

export type CorrectionMatch = {
  pageId: string;
  pageLabel: string;
  lineId: string;
  lineText: string;
  bbox: { left: number; top: number; right: number; bottom: number } | null;
  matchBBox: { left: number; top: number; right: number; bottom: number } | null;
  matchOrdinal: number;
};

export type CorrectionSearchPage = {
  results: CorrectionMatch[];
  total: number;
  page: number;
  pageSize: number;
};

export type BulkPageUpdate = {
  pageId: string;
  expectedData: string;
  data: string;
};

export type BulkPageChange = {
  pageId: string;
  beforeData: string;
  afterData: string;
};

export type BackendCommands = {
  get_user_preferences: { args: undefined; result: { version: 1; language: string; osLocale: string | null } };
  save_user_preferences: { args: { language: string }; result: void };
  set_ui_language: { args: { language: string }; result: void };
  get_environment: { args: undefined; result: { modelPath: string; tesseractPath: string } };
  inspect_pdf: { args: { pdfPath: string }; result: { pdfSize: number } };
  create_project: { args: { pdfPath: string; projectPath: string; manifest?: string }; result: ProjectInfo };
  open_project: { args: { projectPath: string }; result: ProjectInfo };
  read_pdf_range: { args: { projectPath: string; begin: number; end: number }; result: string };
  read_source_pdf_range: { args: { pdfPath: string; begin: number; end: number }; result: string };
  save_manifest: { args: { projectPath: string; manifest: string }; result: void };
  load_page: { args: { projectPath: string; pageId: string }; result: string | null };
  save_page: { args: { projectPath: string; pageId: string; data: string }; result: void };
  run_ocr: { args: { imageBase64: string; modelPath: string; psm: number; dpi?: number }; result: string };
  cancel_ocr: { args: undefined; result: void };
  export_file: { args: { path: string; contentBase64: string }; result: void };
  search_corrections: { args: { projectPath: string; search: string; page: number; pageSize: number }; result: { results: Array<{ pageId: string; pageLabel: string; lineId: string; lineText: string; bbox?: { left: number; top: number; right: number; bottom: number }; matchBBox?: { left: number; top: number; right: number; bottom: number }; matchOrdinal: number }>; total: number; page: number; pageSize: number } };
  apply_bulk_corrections: { args: { projectPath: string; updates: Array<{ pageId: string; expectedData: string; data: string }> }; result: Array<{ pageId: string; beforeData: string; afterData: string }> };
};

export type ProjectInfo = { path: string; name: string; pdfSize: number; manifest: string | null };

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function invokeCommand<K extends keyof BackendCommands>(
  command: K,
  ...args: BackendCommands[K]["args"] extends undefined ? [] : [BackendCommands[K]["args"]]
): Promise<BackendCommands[K]["result"]> {
  if (!isTauri) throw new Error(t("appErrors.desktopOnly"));
  return tauriInvoke(command as string, (args[0] ?? undefined) as Record<string, unknown>);
}
