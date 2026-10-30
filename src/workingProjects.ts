import { invokeCommand, isTauri, type ProjectInfo } from "./tauri";

export type WorkingProjectInfo = ProjectInfo & {
  pageCount: number | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  pageId?: string | null;
  lastUsedAt?: number;
  status?: "available" | "missing" | "unavailable" | "invalid";
};

export type DesktopWorkingProject = Omit<WorkingProjectInfo, "pdfSize" | "manifest" | "modifiedAt"> & {
  modifiedAt: number | null;
  pageId: string | null;
  lastUsedAt: number;
  status: NonNullable<WorkingProjectInfo["status"]>;
};

export async function listWorkingProjects(): Promise<WorkingProjectInfo[]> {
  if (!isTauri) return (await import("./browser/backend")).workingProjects();
  return (await invokeCommand("list_working_projects")).map(info => ({ ...info, pdfSize: 0, manifest: null,
    modifiedAt: info.modifiedAt === null ? null : new Date(info.modifiedAt).toISOString() }));
}

export function workingProjectsChanged() {
  window.dispatchEvent(new Event("eduba-working-projects-changed"));
}
