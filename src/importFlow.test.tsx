// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const mocks = vi.hoisted(() => ({
  dialogOpen: vi.fn(),
  dialogSave: vi.fn(),
  invoke: vi.fn(),
  openSourcePdf: vi.fn(),
  openProjectPdf: vi.fn(),
  destroy: vi.fn(async () => undefined),
  canvasToBase64: vi.fn(() => "image"),
  processCanvas: vi.fn(),
  loadPageImage: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.dialogOpen,
  save: mocks.dialogSave,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    onCloseRequested: vi.fn(async () => () => undefined),
    destroy: vi.fn(),
  })),
}));
vi.mock("./tauri", () => ({ isTauri: true, invokeCommand: mocks.invoke }));
vi.mock("./pdf", () => ({
  openSourcePdf: mocks.openSourcePdf,
  openProjectPdf: mocks.openProjectPdf,
  canvasToBase64: mocks.canvasToBase64,
}));
vi.mock("./pageImage", () => ({ loadPageImage: mocks.loadPageImage }));
vi.mock("./domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./domain")>();
  return { ...actual, processCanvas: mocks.processCanvas };
});

const sourcePath = "D:/input/book.pdf";
const projectPath = "D:/projects/book.eduba";

function pdf() {
  return {
    numPages: 4,
    destroy: mocks.destroy,
    getPage: vi.fn(async () => ({
      getViewport: () => ({ width: 100, height: 80 }),
      render: () => ({ promise: Promise.resolve() }),
    })),
  };
}

function button(container: HTMLElement, text: string) {
  const found = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((value) => value.textContent?.includes(text));
  expect(found).toBeTruthy();
  return found!;
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 1_000 });
}

function setField(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("PDF import configuration", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    mocks.dialogOpen.mockResolvedValue(sourcePath);
    mocks.dialogSave.mockResolvedValue(projectPath);
    mocks.openSourcePdf.mockResolvedValue(pdf());
    mocks.openProjectPdf.mockResolvedValue(pdf());
    mocks.loadPageImage.mockImplementation(async (_page: unknown, mode: string, dpi: number) => { const canvas = document.createElement("canvas"); canvas.width = 100; canvas.height = 80; return { canvas, modeUsed: mode, dpiX: dpi, dpiY: dpi }; });
    mocks.processCanvas.mockImplementation(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 100;
      canvas.height = 80;
      return { pages: [{ canvas }] };
    });
    mocks.invoke.mockImplementation(
      async (command: string, args?: { manifest?: string }) => {
        if (command === "get_environment")
          return { modelPath: "", tesseractPath: "" };
        if (command === "get_user_preferences")
          return { version: 1, language: "auto", osLocale: "en-US" };
        if (command === "inspect_pdf") return { pdfSize: 1234 };
        if (command === "create_project")
          return {
            path: projectPath,
            name: "book.eduba",
            pdfSize: 1234,
            manifest: args?.manifest ?? null,
          };
        return undefined;
      },
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function selectPdf() {
    await act(async () => root.render(<App />));
    await act(async () => button(container, "Import PDF").click());
    await waitFor(() =>
      expect(
        container.querySelector('[role="dialog"][aria-label="PDF import"]'),
      ).toBeTruthy(),
    );
  }

  it("opens import settings after selecting a PDF without creating a project", async () => {
    await selectPdf();
    expect(mocks.invoke).toHaveBeenCalledWith("inspect_pdf", {
      pdfPath: sourcePath,
    });
    expect(mocks.openSourcePdf).toHaveBeenCalledWith(sourcePath, 1234);
    expect(mocks.loadPageImage).toHaveBeenCalledWith(expect.anything(), "extract", 300);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "create_project",
      expect.anything(),
    );
  });

  it("cancelling discards the preview PDF without creating a project", async () => {
    await selectPdf();
    await act(async () => button(container, "Cancel").click());
    await waitFor(() => expect(mocks.destroy).toHaveBeenCalledTimes(1));
    expect(
      mocks.invoke.mock.calls.some(([command]) => command === "create_project"),
    ).toBe(false);
  });

  it("creates a subset spread manifest using the selected DPI without rewriting logical pages", async () => {
    await selectPdf();
    const dialog = container.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="PDF import"]',
    )!;
    await act(async () => {
      setField(
        dialog.querySelector<HTMLInputElement>('[aria-label="Start page"]')!,
        "2",
      );
      setField(
        dialog.querySelector<HTMLInputElement>('[aria-label="End page"]')!,
        "3",
      );
      setField(
        dialog.querySelector<HTMLInputElement>('[aria-label="DPI"]')!,
        "200",
      );
      setField(
        dialog.querySelector<HTMLSelectElement>('[aria-label="Rotation"]')!,
        "90",
      );
      dialog
        .querySelector<HTMLInputElement>('[aria-label="Split spread into left and right"]')!
        .click();
    });
    await act(async () => button(dialog, "4 logical pages").click());
    await waitFor(() =>
      expect(
        mocks.invoke.mock.calls.some(
          ([command]) => command === "create_project",
        ),
      ).toBe(true),
    );
    const call = mocks.invoke.mock.calls.find(
      ([command]) => command === "create_project",
    )!;
    expect(call[1]).toMatchObject({ pdfPath: sourcePath, projectPath });
    const manifest = JSON.parse((call[1] as { manifest: string }).manifest);
    expect(manifest.settings.dpi).toBe(300);
    expect(
      manifest.pages.map((page: { ocrMargins: unknown }) => page.ocrMargins),
    ).toEqual([
      { top: 0, bottom: 0, left: 0, right: 0, outer: 0, inner: 0 },
      { top: 0, bottom: 0, left: 0, right: 0, outer: 0, inner: 0 },
      { top: 0, bottom: 0, left: 0, right: 0, outer: 0, inner: 0 },
      { top: 0, bottom: 0, left: 0, right: 0, outer: 0, inner: 0 },
    ]);
    expect(
      manifest.pages.map(
        (page: {
          sourcePage: number;
          label: string;
          dpi: number;
          rotation: number;
        }) => [page.sourcePage, page.label, page.dpi, page.rotation],
      ),
    ).toEqual([
      [2, "2L", 300, 90],
      [2, "2R", 300, 90],
      [3, "3L", 300, 90],
      [3, "3R", 300, 90],
    ]);
    expect(
      mocks.invoke.mock.calls.some(([command]) => command === "save_page"),
    ).toBe(false);
  });

  it("releases the import lock when the file picker is cancelled so a later selection works", async () => {
    mocks.dialogOpen
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sourcePath);
    await act(async () => root.render(<App />));
    await act(async () => button(container, "Import PDF").click());
    await waitFor(() => expect(mocks.dialogOpen).toHaveBeenCalledTimes(1));
    await act(async () => button(container, "Import PDF").click());
    await waitFor(() =>
      expect(
        container.querySelector('[role="dialog"][aria-label="PDF import"]'),
      ).toBeTruthy(),
    );

    expect(mocks.dialogOpen).toHaveBeenCalledTimes(2);
  });
  it("masks OCR input while saving full-page hOCR coordinates and margin provenance", async () => {
    const original = document.createElement("canvas");
    original.width = 100;
    original.height = 80;
    mocks.processCanvas.mockImplementation(() => ({
      pages: [{ canvas: original }],
    }));
    let ocrCanvas: HTMLCanvasElement | undefined;
    mocks.canvasToBase64.mockImplementation((...values: unknown[]) => {
      ocrCanvas = values[0] as HTMLCanvasElement;
      return "masked-image";
    });
    const manifest = JSON.stringify({
      version: 1,
      settings: { modelPath: "", psm: 3, dpi: 200 },
      pages: [
        {
          id: "page-1-left",
          label: "1L",
          sourcePage: 1,
          split: "left",
          rotation: 90,
          angle: 0,
          dpi: 200,
          ocrMargins: {
            top: 10,
            bottom: 0,
            left: 0,
            right: 0,
            outer: 15,
            inner: 5,
          },
          status: "pending",
        },
      ],
    });
    const hocr =
      '<html><body><div class="ocr_page" id="page_1" title="bbox 0 0 100 80"><div class="ocr_carea" title="bbox 20 20 90 60"><p class="ocr_par" title="bbox 20 20 90 60"><span class="ocr_line" id="line_1" title="bbox 20 20 90 40">text</span></p></div></div></body></html>';
    mocks.dialogOpen.mockResolvedValue("D:/projects/margins.eduba");
    mocks.invoke.mockImplementation(
      async (command: string, args?: { pageId?: string }) => {
        if (command === "get_environment")
          return { modelPath: "", tesseractPath: "" };
        if (command === "get_user_preferences")
          return { version: 1, language: "auto", osLocale: "en-US" };
        if (command === "open_project")
          return {
            path: "D:/projects/margins.eduba",
            name: "margins.eduba",
            pdfSize: 1234,
            manifest,
          };
        if (command === "run_ocr") return hocr;
        return undefined;
      },
    );
    await act(async () => root.render(<App />));
    await act(async () => button(container, "Open").click());
    await waitFor(() =>
      expect(button(container, "OCR current").disabled).toBe(false),
    );
    await act(async () => button(container, "OCR current").click());
    await waitFor(() =>
      expect(
        mocks.invoke.mock.calls.some(([command]) => command === "save_page"),
      ).toBe(true),
    );
    expect(ocrCanvas).not.toBe(original);
    expect(ocrCanvas).toMatchObject({ width: 100, height: 80 });
    const saved = mocks.invoke.mock.calls.find(
      ([command]) => command === "save_page",
    )![1] as { data: string };
    const page = JSON.parse(saved.data);
    expect(page).toMatchObject({
      width: 100,
      height: 80,
      ocrMargins: { top: 10, outer: 15, inner: 5 },
    });
    expect(page.blocks[0].paragraphs[0].lines[0].bbox).toEqual({
      left: 20,
      top: 20,
      right: 90,
      bottom: 40,
    });
  });
  it("keeps source-import controls out of the current OCR settings modal", async () => {
    await act(async () => root.render(<App />));
    const settings =
      container.querySelector<HTMLButtonElement>('button[title="Settings"]')!;
    await act(async () => settings.click());
    const modal = container.querySelector<HTMLElement>(".settings-modal")!;
    expect(modal.textContent).not.toContain("DPI");

    expect(modal.textContent).not.toContain("Rotation");
    expect(modal.textContent).not.toContain("面");
    expect(modal.textContent).not.toContain("spread preset");
  });
});
