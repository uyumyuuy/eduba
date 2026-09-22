// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import i18n from "./i18n";

const mocks = vi.hoisted(() => ({
  dialogOpen: vi.fn(),
  invoke: vi.fn(),
  openProjectPdf: vi.fn(),
  loadPageImage: vi.fn(),
  closeRequested: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.dialogOpen,
  save: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    onCloseRequested: mocks.closeRequested,
    destroy: mocks.destroy,
  })),
}));

vi.mock("./tauri", () => ({
  isTauri: true,
  invokeCommand: mocks.invoke,
}));

vi.mock("./pdf", () => ({
  openProjectPdf: mocks.openProjectPdf,
  canvasToBase64: vi.fn(() => "image"),
}));

vi.mock("./pageImage", () => ({ loadPageImage: mocks.loadPageImage }));
vi.mock("./domain", async importOriginal => {
  const actual = await importOriginal<typeof import("./domain")>();
  return {
    ...actual,
    processCanvas: vi.fn(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 100;
      canvas.height = 80;
      return { pages: [{ canvas }] };
    }),
  };
});

function savedPage(id: string, text: string, sourcePage: number) {
  return JSON.stringify({
    id,
    sourcePage,
    split: "single",
    rotation: 0,
    angle: 0,
    width: 100,
    height: 80,
    blocks: [{
      id: `${id}-block`,
      bbox: { left: 0, top: 0, right: 100, bottom: 80 },
      paragraphs: [{
        id: `${id}-paragraph`,
        bbox: { left: 0, top: 0, right: 100, bottom: 80 },
        lines: [{
          id: `${id}-line`,
          bbox: { left: 5, top: 10, right: 95, bottom: 30 },
          originalText: text,
          correctedText: text,
          words: [],
          chars: [],
          geometryApproximate: false,
        }],
      }],
    }],
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 1_000 });
}

describe("saved project loading", () => {
  let container: HTMLDivElement;
  let root: Root;
  let persistedPages: Map<string, string>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    document.documentElement.lang = "en";
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    persistedPages = new Map([
      ["page-1", savedPage("page-1", "saved page one", 1)],
      ["page-2", savedPage("page-2", "saved page two", 2)],
    ]);

    const canvasContext = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(canvasContext);
    mocks.dialogOpen.mockResolvedValue("D:/projects/reading.eduba");
    mocks.closeRequested.mockResolvedValue(() => undefined);
    mocks.openProjectPdf.mockResolvedValue({
      numPages: 2,
      getPage: vi.fn(async () => ({
        getViewport: () => ({ width: 100, height: 80 }),
        render: () => ({ promise: Promise.resolve() }),
      })),
    });
    mocks.loadPageImage.mockImplementation(async (_page: unknown, mode: string, dpi: number) => { const canvas = document.createElement("canvas"); canvas.width = 100; canvas.height = 80; return { canvas, modeUsed: mode, dpiX: dpi, dpiY: dpi }; });

    const manifest = JSON.stringify({
      version: 1,
      settings: { modelPath: "", psm: 3, dpi: 300 },
      pages: [
        { id: "page-1", label: "1", sourcePage: 1, split: "single", rotation: 0, angle: 0, status: "review" },
        { id: "page-2", label: "2", sourcePage: 2, split: "single", rotation: 0, angle: 0, status: "review" },
      ],
    });
    mocks.invoke.mockImplementation(async (command: string, args?: { pageId?: string; data?: string; search?: string; page?: number; pageSize?: number; updates?: Array<{ pageId: string; expectedData: string; data: string }> }) => {
      if (command === "get_environment") return { modelPath: "", tesseractPath: "" };
      if (command === "get_user_preferences") return { version: 1, language: "auto", osLocale: "en-US" };
      if (command === "open_project") return { path: "D:/projects/reading.eduba", name: "reading.eduba", pdfSize: 256, manifest };
      if (command === "save_page") { persistedPages.set(args?.pageId ?? "", args?.data ?? ""); return undefined; }
      if (command === "load_page") return persistedPages.get(args?.pageId ?? "") ?? null;
      if (command === "search_corrections") {
        const results = [
          { pageId: "page-1", pageLabel: "1", lineId: "page-1-line", lineText: "saved page one", bbox: { left: 5, top: 10, right: 95, bottom: 30 }, matchOrdinal: 0 },
          { pageId: "page-2", pageLabel: "2", lineId: "page-2-line", lineText: "saved page two", bbox: { left: 5, top: 10, right: 95, bottom: 30 }, matchOrdinal: 0 },
        ].filter((result) => result.lineText.includes(args?.search ?? ""));
        return { results, total: results.length, page: args?.page ?? 0, pageSize: args?.pageSize ?? 20 };
      }
      if (command === "apply_bulk_corrections") {
        const changes = (args?.updates ?? []).map((update) => {
          const beforeData = persistedPages.get(update.pageId);
          expect(beforeData).toBe(update.expectedData);
          persistedPages.set(update.pageId, update.data);
          return { pageId: update.pageId, beforeData: beforeData!, afterData: update.data };
        });
        return changes;
      }
      return undefined;
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });


  async function openSavedProject() {
    await act(async () => root.render(<App />));
    await waitFor(() =>
      expect(Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Open"))).toBeTruthy(),
    );
    const openButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Open"));
    await act(async () => openButton?.click());
    await waitFor(() => expect(container.textContent).toContain("saved page one"));
  }

  it("reopens the last project on its saved logical page", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "get_user_preferences") {
        return {
          version: 1,
          language: "auto",
          osLocale: "en-US",
          lastProject: { path: "D:/projects/reading.eduba", pageId: "page-2" },
        };
      }
      return base(command, args as never);
    });
    await act(async () => root.render(<App />));
    await waitFor(() => expect(container.textContent).toContain("saved page two"));
    expect(mocks.invoke).toHaveBeenCalledWith("open_project", { projectPath: "D:/projects/reading.eduba" });
    expect(mocks.invoke).toHaveBeenCalledWith("load_page", {
      projectPath: "D:/projects/reading.eduba",
      pageId: "page-2",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("save_last_opened_project", {
      projectPath: "D:/projects/reading.eduba",
      pageId: "page-2",
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("save_last_opened_project", {
      projectPath: "D:/projects/reading.eduba",
      pageId: "page-1",
    });
  });

  it("leaves the start screen available when the last project cannot be reopened", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_environment") return { modelPath: "", tesseractPath: "" };
      if (command === "get_user_preferences") {
        return {
          version: 1,
          language: "auto",
          osLocale: "en-US",
          lastProject: { path: "D:/projects/missing.eduba", pageId: "page-1" },
        };
      }
      if (command === "open_project") throw new Error("project file not found");
      return undefined;
    });
    await act(async () => root.render(<App />));
    await waitFor(() =>
      expect(Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Open"))).toBeTruthy(),
    );
    expect(mocks.dialogOpen).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("project file not found");
  });

  it("does not let delayed startup restoration override a manual open", async () => {
    let resolvePreferences: ((value: unknown) => void) | undefined;
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "get_user_preferences") {
        return new Promise((resolve) => { resolvePreferences = resolve; });
      }
      if (command === "open_project" && (args as { projectPath?: string } | undefined)?.projectPath === "D:/projects/manual.eduba") {
        const info = await base(command, args as never);
        return { ...(info as object), path: "D:/projects/manual.eduba", name: "manual.eduba" };
      }
      return base(command, args as never);
    });
    mocks.dialogOpen.mockResolvedValue("D:/projects/manual.eduba");
    await act(async () => root.render(<App />));
    await waitFor(() =>
      expect(Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Open"))).toBeTruthy(),
    );
    const openButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Open"))!;
    await act(async () => openButton.click());
    await waitFor(() => expect(container.textContent).toContain("manual.eduba"));
    resolvePreferences!({
      version: 1,
      language: "auto",
      osLocale: "en-US",
      lastProject: { path: "D:/projects/reading.eduba", pageId: "page-2" },
    });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.invoke).not.toHaveBeenCalledWith("open_project", { projectPath: "D:/projects/reading.eduba" });
  });

  it("waits for the final page selection to be persisted before closing", async () => {
    await openSavedProject();
    let finishPageWrite: (() => void) | undefined;
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "save_last_opened_project" && (args as { pageId?: string } | undefined)?.pageId === "page-2") {
        await new Promise<void>((resolve) => { finishPageWrite = resolve; });
        return undefined;
      }
      return base(command, args as never);
    });
    const pageTwo = container.querySelectorAll<HTMLButtonElement>(".page-item")[1];
    await act(async () => pageTwo.click());
    await waitFor(() => expect(finishPageWrite).toBeTypeOf("function"));
    let closeHandler: ((event: { preventDefault: () => void }) => Promise<void>) | undefined;
    mocks.closeRequested.mock.calls.forEach(([handler]) => { closeHandler = handler; });
    const closing = closeHandler!({ preventDefault: vi.fn() });
    await Promise.resolve();
    expect(mocks.destroy).not.toHaveBeenCalled();
    finishPageWrite!();
    await act(async () => { await closing; });
    expect(mocks.destroy).toHaveBeenCalled();
  });

  it("keeps a completed page protected when its edit confirmation is declined", async () => {
    await openSavedProject();
    await act(async () => container.querySelector<HTMLInputElement>(".page-complete-toggle input")!.click());
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const line = container.querySelector<SVGRectElement>(".layout-svg rect")!;
    await act(async () => line.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(window.confirm).toHaveBeenCalled();
    expect(container.querySelector("textarea.line-overlay")).toBeNull();
    expect(container.querySelector<HTMLInputElement>(".page-complete-toggle input")!.checked).toBe(true);
  });

  it("unmarks a completed page before allowing its edit", async () => {
    await openSavedProject();
    await act(async () => container.querySelector<HTMLInputElement>(".page-complete-toggle input")!.click());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const line = container.querySelector<SVGRectElement>(".layout-svg rect")!;
    await act(async () => line.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await waitFor(() => expect(container.querySelector("textarea.line-overlay")).toBeTruthy());
    expect(container.querySelector<HTMLInputElement>(".page-complete-toggle input")!.checked).toBe(false);
  });
  it("requires confirmation before undoing into a completed page", async () => {
    await openSavedProject();
    const line = container.querySelector<SVGRectElement>(".layout-svg rect")!;
    await act(async () => line.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const editor = container.querySelector<HTMLTextAreaElement>("textarea.line-overlay")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(editor, "changed"); editor.dispatchEvent(new Event("input", { bubbles: true })); editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await waitFor(() => expect(container.textContent).toContain("changed"));
    await act(async () => container.querySelector<HTMLInputElement>(".page-complete-toggle input")!.click());
    const undo = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Undo"))!;
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => undo.click());
    expect(window.confirm).toHaveBeenCalled();
    expect(container.textContent).toContain("changed");
    expect(container.querySelector<HTMLInputElement>(".page-complete-toggle input")!.checked).toBe(true);
    vi.mocked(window.confirm).mockReturnValue(true);
    await act(async () => undo.click());
    await waitFor(() => expect(container.textContent).toContain("saved page one"));
    expect(container.querySelector<HTMLInputElement>(".page-complete-toggle input")!.checked).toBe(false);
  });
  it("persists a language choice without writing the open project", async () => {
    await openSavedProject();
    mocks.invoke.mockClear();
    const settings = container.querySelector<HTMLButtonElement>('button[title="Settings"]')!;
    await act(async () => settings.click());
    const language = container.querySelector<HTMLSelectElement>('select[aria-label="Language"]')!;
    await act(async () => {
      language.value = "ja";
      language.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("set_ui_language", { language: "ja" }));
    expect(mocks.invoke).toHaveBeenCalledWith("save_user_preferences", { language: "ja" });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "save_manifest" || command === "save_page")).toBe(false);
    expect(language.value).toBe("ja");
    expect(container.textContent).toContain("saved page one");
    expect(container.textContent).toContain("reading.eduba");
  });

  it("keeps the previous language choice and reports a preference save failure", async () => {
    await openSavedProject();
    mocks.invoke.mockClear();
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "save_user_preferences") throw new Error("settings unavailable");
      return base(command, args as never);
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Settings"]')!.click());
    const language = container.querySelector<HTMLSelectElement>('select[aria-label="Language"]')!;
    await act(async () => {
      language.value = "ja";
      language.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(container.textContent).toContain("Language settings could not be saved"));
    expect(language.value).toBe("auto");
    expect(container.textContent).toContain("saved page one");
  });

  it("shows and consumes a startup language warning without replacing saved content", async () => {
    window.sessionStorage.setItem(
      "eduba-language-error",
      JSON.stringify({ kind: "menu", error: "menu unavailable" }),
    );
    await act(async () => root.render(<App />));
    await waitFor(() => expect(container.textContent).toContain("Language changed, but the native menu could not update"));
    expect(window.sessionStorage.getItem("eduba-language-error")).toBeNull();
    await waitFor(() =>
      expect(Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Open"))).toBeTruthy(),
    );
    const openButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Open"));
    await act(async () => openButton?.click());
    await waitFor(() => expect(container.textContent).toContain("saved page one"));
  });

  it("shows each saved page when reopening a proofread document and navigating", async () => {
    await act(async () => root.render(<App />));

    await waitFor(() =>
      expect(Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Open"))).toBeTruthy(),
    );
    const openButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Open"));
    await act(async () => openButton?.click());

    await waitFor(() => expect(container.textContent).toContain("saved page one"));
    expect(container.textContent).toContain("reading.eduba");

    const pageTwo = container.querySelectorAll<HTMLButtonElement>(".page-item")[1];
    await act(async () => pageTwo.click());
    await waitFor(() => expect(container.textContent).toContain("saved page two"));
    expect(mocks.invoke).toHaveBeenCalledWith("load_page", {
      projectPath: "D:/projects/reading.eduba",
      pageId: "page-2",
    });
  });
  it("does not create history when a line is opened and left unchanged", async () => {
    await openSavedProject();
    await act(async () => container.querySelector<SVGRectElement>("svg rect")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const editor = container.querySelector<HTMLTextAreaElement>("textarea.line-overlay")!;
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await waitFor(() => expect(container.querySelector("textarea.line-overlay")).toBeNull());
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Undo"))!.disabled).toBe(true);
  });

  it("groups more than one hundred line edits from the opening value", async () => {
    await openSavedProject();
    await act(async () => container.querySelector<SVGRectElement>("svg rect")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const editor = container.querySelector<HTMLTextAreaElement>("textarea.line-overlay")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    for (let index = 0; index < 105; index += 1) {
      await act(async () => { setValue.call(editor, `edit ${index}`); editor.dispatchEvent(new Event("input", { bubbles: true })); });
    }
    await waitFor(() => expect(container.textContent).toContain("edit 104"));
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const undoButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Undo"))!;
    await act(async () => undoButton.click());
    await waitFor(() => expect(container.textContent).toContain("saved page one"));
    expect(undoButton.disabled).toBe(true);
    const redoButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Redo"))!;
    await act(async () => redoButton.click());
    await waitFor(() => expect(container.textContent).toContain("edit 104"));
  });
  it("undoes each active line edit, then groups the finished line into one history operation", async () => {
    await openSavedProject();
    await act(async () => container.querySelector<SVGRectElement>("svg rect")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const editor = container.querySelector<HTMLTextAreaElement>("textarea.line-overlay")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    const input = async (value: string) => {
      await act(async () => { setValue.call(editor, value); editor.dispatchEvent(new Event("input", { bubbles: true })); });
      await waitFor(() => expect(container.textContent).toContain(value));
    };
    await input("first");
    await input("second");
    await input("third");
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })));
    await waitFor(() => expect(container.textContent).toContain("second"));
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true })));
    await waitFor(() => expect(container.textContent).toContain("third"));
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await waitFor(() => expect(container.querySelector("textarea.line-overlay")).toBeNull());
    const undoButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Undo"))!;
    await act(async () => undoButton.click());
    await waitFor(() => expect(container.textContent).toContain("saved page one"));
    expect(undoButton.disabled).toBe(true);
    const redoButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Redo"))!;
    await act(async () => redoButton.click());
    await waitFor(() => expect(container.textContent).toContain("third"));
  });
  it("switches the displayed page when undoing and redoing a cross-page edit", async () => {
    await openSavedProject();
    const firstRect = container.querySelector<SVGRectElement>("svg rect")!;
    await act(async () => firstRect.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const editor = container.querySelector<HTMLTextAreaElement>("textarea.line-overlay")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(editor, "edited page one"); editor.dispatchEvent(new Event("input", { bubbles: true })); });
    await waitFor(() => expect(container.textContent).toContain("edited page one"));
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => container.querySelectorAll<HTMLButtonElement>(".page-item")[1].click());
    await waitFor(() => expect(container.textContent).toContain("saved page two"));
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.includes("Undo"))!.click());
    await waitFor(() => expect(container.textContent).toContain("saved page one"));
    expect(container.querySelectorAll<HTMLButtonElement>(".page-item")[0].className).toContain("active");
    expect(container.textContent).not.toContain("edited page one");
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.includes("Redo"))!.click());
    await waitFor(() => expect(container.textContent).toContain("edited page one"));
    expect(container.querySelectorAll<HTMLButtonElement>(".page-item")[0].className).toContain("active");
  });

  it("keeps action labels below shortcut keys while Ctrl is pressed", async () => {
    await openSavedProject();
    const firstRect = container.querySelector<SVGRectElement>("svg rect")!;
    await act(async () => firstRect.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const editor = container.querySelector<HTMLTextAreaElement>("textarea.line-overlay")!;
    const pageWidth = Number.parseFloat(container.querySelector<HTMLElement>(".layout-card")!.style.width);
    const originalLineTop = 10 * pageWidth / 100;
    expect(Number.parseFloat(editor.style.top)).toBeLessThan(originalLineTop);
    expect(Number.parseFloat(editor.style.top) + Number.parseFloat(editor.style.paddingTop)).toBeCloseTo(originalLineTop);
    await act(async () => {
      editor.setSelectionRange(0, 5);
      editor.dispatchEvent(new Event("select", { bubbles: true }));
    });
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true })));
    const toolbar = container.querySelector(".selection-toolbar")!;
    const bold = toolbar.querySelector<HTMLButtonElement>('button[aria-label="Bold"]')!;
    expect(bold.querySelector(".edit-toolbar-shortcut")?.textContent).toBe("B");
    expect(bold.querySelector(".edit-toolbar-label")?.textContent).toBe("Bold");
    expect(bold.textContent).not.toContain("Ctrl+");
    const bulk = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button"))
      .find(button => button.querySelector(".edit-toolbar-shortcut")?.textContent === "G")!;
    expect(bulk.querySelector(".edit-toolbar-label")?.textContent).toBeTruthy();
    await act(async () => bold.click());
    const decoration = container.querySelector<HTMLElement>(".line-edit-mirror .formatted-edit-decoration")!;
    const mirror = container.querySelector<HTMLElement>(".line-edit-mirror")!;
    expect(mirror.style.top).toBe(editor.style.top);
    expect(mirror.style.height).toBe(editor.style.height);
    expect(mirror.style.paddingTop).toBe(editor.style.paddingTop);
    expect(decoration.textContent).toBe("saved");
    expect(decoration.style.fontWeight).toBe("700");
    expect(editor.classList.contains("has-formatting")).toBe(true);
    const superscript = toolbar.querySelector<HTMLButtonElement>('button[aria-label="Superscript"]')!;
    await act(async () => superscript.click());
    const raised = container.querySelector<HTMLElement>(".line-edit-mirror .formatted-edit-decoration")!;
    expect(raised.style.fontSize).toBe("0.7em");
    expect(raised.style.transform).toContain("translateY(-0.35em)");
  });

  it("replaces selected matches across pages and navigates on undo and redo", async () => {
    await openSavedProject();
    const firstRect = container.querySelector<SVGRectElement>("svg rect")!;
    await act(async () => firstRect.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const editor = container.querySelector<HTMLTextAreaElement>("textarea.line-overlay")!;
    await act(async () => {
      editor.setSelectionRange(0, 5);
      editor.dispatchEvent(new Event("select", { bubbles: true }));
      document.dispatchEvent(new Event("selectionchange"));
    });
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true })));
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeTruthy());
    await waitFor(() => expect(container.textContent).toContain("2 results"));
    const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('.bulk-replace-results input[type="checkbox"]'));
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.every((checkbox) => !checkbox.checked)).toBe(true);
    const replacement = container.querySelector<HTMLInputElement>('.bulk-replace-fields input:not([readonly])')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(replacement, "stored");
      replacement.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => checkboxes.forEach((checkbox) => checkbox.click()));
    await waitFor(() => expect(container.querySelector<HTMLButtonElement>('.modal-actions .primary')?.disabled).toBe(false));
    await act(async () => container.querySelector<HTMLButtonElement>('.modal-actions .primary')!.click());
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
    expect(JSON.parse(persistedPages.get("page-1")!).blocks[0].paragraphs[0].lines[0].correctedText).toBe("stored page one");
    expect(JSON.parse(persistedPages.get("page-2")!).blocks[0].paragraphs[0].lines[0].correctedText).toBe("stored page two");
    await act(async () => container.querySelectorAll<HTMLButtonElement>(".page-item")[1].click());
    await waitFor(() => expect(container.textContent).toContain("stored page two"));
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Undo"))!.click());
    await waitFor(() => expect(container.textContent).toContain("saved page one"));
    expect(container.querySelectorAll<HTMLButtonElement>(".page-item")[0].className).toContain("active");
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Redo"))!.click());
    await waitFor(() => expect(container.textContent).toContain("stored page one"));
    expect(container.querySelectorAll<HTMLButtonElement>(".page-item")[0].className).toContain("active");
  });
});
