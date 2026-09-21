// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const mocks = vi.hoisted(() => ({
  dialogOpen: vi.fn(),
  invoke: vi.fn(),
  openProjectPdf: vi.fn(),
  loadPageImage: vi.fn(),
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
    onCloseRequested: vi.fn(async () => () => undefined),
    destroy: vi.fn(),
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

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    const canvasContext = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(canvasContext);
    mocks.dialogOpen.mockResolvedValue("D:/projects/reading.eduba");
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
    mocks.invoke.mockImplementation(async (command: string, args?: { pageId?: string }) => {
      if (command === "get_environment") return { modelPath: "", tesseractPath: "" };
      if (command === "open_project") return { path: "D:/projects/reading.eduba", name: "reading.eduba", pdfSize: 256, manifest };
      if (command === "load_page") return args?.pageId === "page-1" ? savedPage("page-1", "saved page one", 1) : savedPage("page-2", "saved page two", 2);
      return undefined;
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("shows each saved page when reopening a proofread document and navigating", async () => {
    await act(async () => root.render(<App />));

    const openButton = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("開く"));
    expect(openButton).toBeTruthy();
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
});
