// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { synchronizePageScroll } from "./App";
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

describe("proofing pane scroll synchronization", () => {
  it("maps the page coordinate at the viewport centre across different scales and viewport sizes", () => {
    const element = (dimensions: { left?: number; top?: number; width: number; height: number }) => {
      const value = document.createElement("div");
      Object.defineProperties(value, {
        offsetLeft: { value: dimensions.left ?? 0 }, offsetTop: { value: dimensions.top ?? 0 },
        clientWidth: { value: dimensions.width }, clientHeight: { value: dimensions.height },
      });
      return value;
    };
    const source = element({ width: 400, height: 300 });
    const target = element({ width: 600, height: 200 });
    const sourcePage = element({ left: 27, top: 27, width: 1000, height: 2000 });
    const targetPage = element({ left: 27, top: 27, width: 2000, height: 1000 });
    source.scrollLeft = 260;
    source.scrollTop = 100;
    target.scrollLeft = 50;
    target.scrollTop = 10;

    expect(synchronizePageScroll(source, target, sourcePage, targetPage)).toBe(true);
    expect(target.scrollLeft).toBeCloseTo(593);
    expect(target.scrollTop).toBeCloseTo(38.5);
    expect(synchronizePageScroll(source, target, sourcePage, targetPage)).toBe(false);
  });
});
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

    const canvasContext = { drawImage: vi.fn(), fillRect: vi.fn() } as unknown as CanvasRenderingContext2D;
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


  async function openSavedProject(expectedText = "saved page one") {
    await act(async () => root.render(<App />));
    await waitFor(() =>
      expect(Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Open"))).toBeTruthy(),
    );
    const openButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Open"));
    await act(async () => openButton?.click());
    await waitFor(() => expect(container.textContent).toContain(expectedText));
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

  it("highlights the source scan and moves the magnifier with the edit caret", async () => {
    const saved = JSON.parse(persistedPages.get("page-1")!);
    const line = saved.blocks[0].paragraphs[0].lines[0];
    line.originalText = "ABCD";
    line.correctedText = "ABCD";
    line.bbox = { left: 10, top: 20, right: 60, bottom: 35 };
    const edges = [10, 20, 30, 47, 60];
    const chars = Array.from("ABCD").map((text, index) => ({ index, originalText: text, correctedText: text,
      bbox: { left: edges[index], top: 20, right: edges[index + 1], bottom: 35 }, source: "ocr" }));
    line.words = [{ id: "word", originalText: "ABCD", correctedText: "ABCD", bbox: line.bbox, chars }];
    line.chars = chars;
    persistedPages.set("page-1", JSON.stringify(saved));
    await openSavedProject("ABCD");
    await act(async () => container.querySelector<SVGRectElement>(".layout-svg rect")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const editor = container.querySelector<HTMLTextAreaElement>("textarea.line-overlay")!;
    expect(editor).toBeTruthy();
    expect(container.querySelector(".edit-image-focus-line")?.getAttribute("x")).toBe("10");
    const magnifier = container.querySelector<HTMLCanvasElement>(".edit-image-magnifier")!;
    expect(magnifier).not.toBeNull();
    const source = container.querySelector<HTMLCanvasElement>(".rendered-page")!;
    const draws = () => vi.mocked(magnifier.getContext("2d")!.drawImage).mock.calls.filter(args => args[0] === source);
    expect(draws().length).toBeGreaterThan(0);
    const firstDraw = draws().at(-1)!;
    const initialSize = [magnifier.style.width, magnifier.style.height, magnifier.width, magnifier.height];
    await act(async () => { editor.setSelectionRange(2, 2); editor.dispatchEvent(new Event("select", { bubbles: true })); document.dispatchEvent(new Event("selectionchange")); });
    await waitFor(() => expect(container.querySelector(".edit-image-focus-underline")?.getAttribute("x1")).toBe("30"));
    expect(container.querySelector(".edit-image-focus-underline")?.getAttribute("y1")).toBe("35");
    const nextDraw = draws().at(-1)!;
    expect([magnifier.style.width, magnifier.style.height, magnifier.width, magnifier.height]).toEqual(initialSize);
    expect([nextDraw[3], nextDraw[4], nextDraw[7], nextDraw[8]]).toEqual([firstDraw[3], firstDraw[4], firstDraw[7], firstDraw[8]]);
    expect(nextDraw[1]).not.toBe(firstDraw[1]);
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(container.querySelector(".edit-image-focus")).toBeNull();
    expect(container.querySelector(".edit-image-magnifier")).toBeNull();
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
  it("adds a dragged OCR region with PSM 11 and saves it as one undoable change", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    const regionHocr = '<html xmlns="http://www.w3.org/1999/xhtml"><body><div class="ocr_page" id="page" title="bbox 0 0 80 60"><div class="ocr_carea" id="block" title="bbox 25 25 35 35"><p class="ocr_par" id="par" title="bbox 25 25 35 35"><span class="ocr_line" id="line" title="bbox 25 25 35 35"><span class="ocrx_word" id="word" title="bbox 25 25 35 35">15</span></span></p></div></div></body></html>';
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) =>
      command === "run_ocr" ? regionHocr : base(command, args as never));
    await openSavedProject();
    const canvas = container.querySelector<HTMLCanvasElement>(".rendered-page")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 } as DOMRect);
    const surface = container.querySelector<HTMLDivElement>(".pdf-page")!;
    Object.defineProperties(surface, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.includes("Add OCR region"))!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".ocr-pane.region-inactive")).not.toBeNull();
    const hint = container.querySelector<HTMLElement>(".region-instruction")!;
    expect(hint.textContent).toContain("Drag to select an area");
    vi.spyOn(hint, "getBoundingClientRect").mockReturnValue({ left: 20, top: 20, right: 220, bottom: 70 } as DOMRect);
    await act(async () => surface.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 30, clientY: 30 })));
    expect(hint.classList.contains("hidden")).toBe(true);
    await act(async () => surface.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 400, clientY: 400 })));
    expect(hint.classList.contains("hidden")).toBe(false);
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, "pointerId", { value: 1 });
      return event;
    };
    await act(async () => {
      surface.dispatchEvent(pointer("pointerdown", 10, 20));
      surface.dispatchEvent(pointer("pointermove", 50, 40));
    });
    expect(container.querySelector(".region-selection")).not.toBeNull();
    await act(async () => surface.dispatchEvent(pointer("pointerup", 50, 40)));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("run_ocr", expect.objectContaining({ psm: 11 })));
    await waitFor(() => expect(JSON.parse(persistedPages.get("page-1")!).manualOcrRegions).toHaveLength(1));
    const saved = JSON.parse(persistedPages.get("page-1")!);
    expect(saved.manualOcrRegions[0].bbox).toEqual({ left: 10, top: 20, right: 50, bottom: 40 });
    expect(container.textContent).toContain("15");
    const undoButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.includes("Undo"))!;
    await act(async () => undoButton.click());
    await waitFor(() => expect(JSON.parse(persistedPages.get("page-1")!).manualOcrRegions).toBeUndefined());
  });
  it("deletes a clicked line from the OCR pane and can undo it", async () => {
    await openSavedProject();
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.includes("Delete OCR region"))!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".pdf-pane.region-inactive")).not.toBeNull();
    expect(container.querySelector(".ocr-pane.region-inactive")).toBeNull();
    expect(container.querySelector(".region-instruction")?.textContent).toContain("Click a line");
    const surface = container.querySelector<HTMLDivElement>(".layout-card")!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 } as DOMRect);
    Object.defineProperties(surface, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const pointer = (type: string) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 10, clientY: 20 });
      Object.defineProperty(event, "pointerId", { value: 2 });
      return event;
    };
    await act(async () => surface.dispatchEvent(pointer("pointerdown")));
    await act(async () => surface.dispatchEvent(pointer("pointerup")));
    await act(async () => surface.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 20 })));
    await waitFor(() => expect(JSON.parse(persistedPages.get("page-1")!).blocks).toHaveLength(0));
    expect(container.querySelector("textarea.line-overlay")).toBeNull();
    const undoButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.includes("Undo"))!;
    await act(async () => undoButton.click());
    await waitFor(() => expect(container.textContent).toContain("saved page one"));
  });

  it("deletes every OCR line overlapped by a drag on the recognition layout", async () => {
    const saved = JSON.parse(persistedPages.get("page-1")!);
    saved.blocks[0].paragraphs[0].lines.push({ ...saved.blocks[0].paragraphs[0].lines[0],
      id: "page-1-second-line", bbox: { left: 5, top: 40, right: 95, bottom: 60 },
      originalText: "second OCR line", correctedText: "second OCR line" });
    persistedPages.set("page-1", JSON.stringify(saved));
    await openSavedProject();
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.includes("Delete OCR region"))!;
    await act(async () => button.click());
    const surface = container.querySelector<HTMLDivElement>(".layout-card")!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 } as DOMRect);
    Object.defineProperties(surface, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, "pointerId", { value: 3 });
      return event;
    };
    await act(async () => {
      surface.dispatchEvent(pointer("pointerdown", 10, 15));
      surface.dispatchEvent(pointer("pointermove", 50, 55));
    });
    expect(container.querySelector(".region-selection.deleting")).not.toBeNull();
    await act(async () => surface.dispatchEvent(pointer("pointerup", 50, 55)));
    await waitFor(() => expect(JSON.parse(persistedPages.get("page-1")!).blocks).toHaveLength(0));
    expect(container.textContent).toContain("Deleted 2 OCR line");
  });

  it("merges same-row OCR regions dragged on the recognition layout and can undo", async () => {
    const saved = JSON.parse(persistedPages.get("page-1")!);
    const first = saved.blocks[0].paragraphs[0].lines[0];
    first.bbox = { left: 5, top: 10, right: 40, bottom: 30 };
    first.originalText = "left";
    first.correctedText = "left";
    saved.blocks[0].paragraphs[0].lines.push({ ...first, id: "page-1-right-line",
      bbox: { left: 55, top: 10, right: 95, bottom: 30 }, originalText: "right", correctedText: "right" });
    persistedPages.set("page-1", JSON.stringify(saved));
    await act(async () => root.render(<App />));
    const open = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.includes("Open"))!;
    await act(async () => open.click());
    await waitFor(() => expect(container.textContent).toContain("right"));
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.includes("Merge OCR regions"))!;
    await act(async () => button.click());
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".pdf-pane.region-inactive")).not.toBeNull();
    const surface = container.querySelector<HTMLDivElement>(".layout-card")!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 } as DOMRect);
    Object.defineProperties(surface, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, "pointerId", { value: 4 });
      return event;
    };
    await act(async () => {
      surface.dispatchEvent(pointer("pointerdown", 10, 15));
      surface.dispatchEvent(pointer("pointermove", 90, 25));
    });
    expect(container.querySelector(".region-selection.merging")).not.toBeNull();
    await act(async () => surface.dispatchEvent(pointer("pointerup", 90, 25)));
    await act(async () => surface.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 90, clientY: 25 })));
    await waitFor(() => expect(JSON.parse(persistedPages.get("page-1")!).blocks[0].paragraphs[0].lines).toHaveLength(1));
    expect(container.querySelector("textarea.line-overlay")).toBeNull();
    expect(JSON.parse(persistedPages.get("page-1")!).blocks[0].paragraphs[0].lines[0].correctedText).toBe("left right");
    const undoButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.includes("Undo"))!;
    await act(async () => undoButton.click());
    await waitFor(() => expect(JSON.parse(persistedPages.get("page-1")!).blocks[0].paragraphs[0].lines).toHaveLength(2));
  });

  it("shows an exit button for each active OCR region mode", async () => {
    await openSavedProject();
    for (const [start, finish] of [
      ["Add OCR region", "Finish adding OCR regions"],
      ["Delete OCR region", "Finish deleting OCR regions"],
      ["Merge OCR regions", "Finish merging OCR regions"],
    ]) {
      const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find(item => item.textContent?.includes(start))!;
      await act(async () => button.click());
      expect(button.textContent).toContain(finish);
      expect(button.getAttribute("aria-pressed")).toBe("true");
      await act(async () => button.click());
      expect(button.textContent).toContain(start);
      expect(button.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("shows reading-order badges and arrows, then saves clicks and a drag as undoable steps", async () => {
    const saved = JSON.parse(persistedPages.get("page-1")!);
    const first = saved.blocks[0].paragraphs[0].lines[0];
    first.bbox = { left: 5, top: 10, right: 45, bottom: 20 };
    for (const [id, top] of [["b", 30], ["c", 50], ["d", 65]] as const) {
      saved.blocks[0].paragraphs[0].lines.push({ ...first, id, bbox: { left: 5, top, right: 45, bottom: top + 10 },
        originalText: id, correctedText: id });
    }
    persistedPages.set("page-1", JSON.stringify(saved));
    await openSavedProject();
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.includes("Change reading order"))!;
    await act(async () => button.click());
    expect(container.querySelector(".region-instruction")?.textContent).toContain("Select the first");
    expect(container.querySelector(".region-instruction")?.textContent).toContain("or Esc");
    expect(button.textContent).toContain("Finish changing reading order");
    expect(container.querySelectorAll(".reading-order-overlay circle")).toHaveLength(4);
    expect(container.querySelectorAll(".reading-order-overlay line")).toHaveLength(3);
    const surface = container.querySelector<HTMLDivElement>(".layout-card")!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 } as DOMRect);
    Object.defineProperties(surface, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, "pointerId", { value: 5 });
      return event;
    };
    const clickLine = async (y: number) => {
      await act(async () => { surface.dispatchEvent(pointer("pointerdown", 10, y)); surface.dispatchEvent(pointer("pointerup", 10, y)); });
    };
    await clickLine(15);
    expect(container.querySelector(".region-instruction")?.textContent).toContain("Select the next");
    expect(container.querySelectorAll(".layout-svg rect.reading-order-active")).toHaveLength(1);
    await clickLine(70);
    await waitFor(() => expect(JSON.parse(persistedPages.get("page-1")!).blocks[0].paragraphs[0].lines.map((line: { id: string }) => line.id)).toEqual(["page-1-line", "d", "b", "c"]));
    expect(Array.from(container.querySelectorAll<SVGGElement>(".reading-order-overlay g")).find(group => group.querySelector("circle")?.getAttribute("cy") === "70")?.textContent).toBe("2");
    await act(async () => {
      surface.dispatchEvent(pointer("pointerdown", 10, 55));
      surface.dispatchEvent(pointer("pointermove", 10, 35));
      surface.dispatchEvent(pointer("pointermove", 10, 55));
      surface.dispatchEvent(pointer("pointermove", 10, 35));
    });
    await act(async () => surface.dispatchEvent(pointer("pointerup", 10, 35)));
    await waitFor(() => expect(JSON.parse(persistedPages.get("page-1")!).blocks[0].paragraphs[0].lines.map((line: { id: string }) => line.id)).toEqual(["page-1-line", "d", "c", "b"]));
    expect(Array.from(container.querySelectorAll<SVGGElement>(".reading-order-overlay g")).find(group => group.querySelector("circle")?.getAttribute("cy") === "55")?.textContent).toBe("3");
    const undoButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.includes("Undo"))!;
    await act(async () => undoButton.click());
    await waitFor(() => expect(JSON.parse(persistedPages.get("page-1")!).blocks[0].paragraphs[0].lines.map((line: { id: string }) => line.id)).toEqual(["page-1-line", "d", "b", "c"]));
    await act(async () => button.click());
    expect(container.querySelector(".reading-order-overlay")).toBeNull();
    expect(button.textContent).toContain("Change reading order");
    await act(async () => button.click());
    expect(container.querySelector(".reading-order-overlay")).not.toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector(".reading-order-overlay")).toBeNull();
    expect(button.textContent).toContain("Change reading order");
  });

  it("wires both scroll panes and ignores the reciprocal programmatic scroll", async () => {
    await openSavedProject();
    const pdfStage = container.querySelector<HTMLDivElement>(".pdf-stage")!;
    const ocrStage = container.querySelector<HTMLDivElement>(".ocr-stage")!;
    const sourcePage = container.querySelector<HTMLDivElement>(".pdf-page")!;
    const targetPage = container.querySelector<HTMLDivElement>(".layout-card")!;
    const dimensions = (element: HTMLElement, left: number, top: number, width: number, height: number) => {
      Object.defineProperties(element, {
        offsetLeft: { configurable: true, value: left }, offsetTop: { configurable: true, value: top },
        clientWidth: { configurable: true, value: width }, clientHeight: { configurable: true, value: height },
      });
    };
    dimensions(pdfStage, 0, 0, 400, 300);
    dimensions(ocrStage, 0, 0, 600, 200);
    dimensions(sourcePage, 27, 27, 1000, 2000);
    dimensions(targetPage, 27, 27, 2000, 1000);

    pdfStage.scrollLeft = 260;
    pdfStage.scrollTop = 100;
    await act(async () => pdfStage.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(ocrStage.scrollLeft).toBeCloseTo(593);
    expect(ocrStage.scrollTop).toBeCloseTo(38.5);

    await act(async () => ocrStage.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(pdfStage.scrollLeft).toBe(260);
    expect(pdfStage.scrollTop).toBe(100);

    ocrStage.scrollLeft = 800;
    ocrStage.scrollTop = 120;
    await act(async () => ocrStage.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(pdfStage.scrollLeft).toBeCloseTo(363.5);
    expect(pdfStage.scrollTop).toBeCloseTo(263);
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
    expect(raised.style.transform).toContain("translateY(0.1em)");
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

  it("splits a collapsed caret and supports undo and redo", async () => {
    await act(async () => root.render(<App />));
    const page = JSON.parse(savedPage("page-1", "left right", 1));
    const chars = Array.from("left right").map((character, index) => ({ index, originalText: character, correctedText: character, bbox: { left: 5 + index * 8, top: 10, right: 12 + index * 8, bottom: 30 }, source: "ocr" }));
    page.blocks[0].paragraphs[0].lines[0].words = [
      { id: "left", bbox: { left: 5, top: 10, right: 36, bottom: 30 }, originalText: "left", correctedText: "left", chars: chars.slice(0, 4) },
      { id: "right", bbox: { left: 45, top: 10, right: 95, bottom: 30 }, originalText: "right", correctedText: "right", chars: chars.slice(5) },
    ];
    page.blocks[0].paragraphs[0].lines[0].chars = chars;
    persistedPages.set("page-1", JSON.stringify(page));
    const open = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Open"));
    await act(async () => open?.click());
    await waitFor(() => expect(container.textContent).toContain("left right"));
    await act(async () => container.querySelector<SVGRectElement>("svg rect")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const editor = container.querySelector<HTMLTextAreaElement>("textarea.line-overlay")!;
    await act(async () => { editor.setSelectionRange(5, 5); editor.dispatchEvent(new Event("select", { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)); });
    await waitFor(() => expect(container.querySelector<HTMLButtonElement>(".selection-toolbar button")?.disabled).toBe(false));
    await act(async () => container.querySelector<HTMLButtonElement>(".selection-toolbar button")!.click());
    await waitFor(() => expect(container.querySelectorAll("svg text")).toHaveLength(2));
    const undo = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Undo"))!;
    await act(async () => undo.click());
    await waitFor(() => expect(container.querySelectorAll("svg text")).toHaveLength(1));
    const redo = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Redo"))!;
    await act(async () => redo.click());
    await waitFor(() => expect(container.querySelectorAll("svg text")).toHaveLength(2));
  });
});
