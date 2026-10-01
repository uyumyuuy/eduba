// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportModal } from "./ImportModal";

const mocks = vi.hoisted(() => ({ processCanvas: vi.fn(), loadPageImage: vi.fn() }));
vi.mock("./domain", () => ({ processCanvas: mocks.processCanvas }));
vi.mock("./pageImage", () => ({ loadPageImage: mocks.loadPageImage }));


function pdf(pages = 3) {
  return {
    numPages: pages,
    getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 800 * scale, height: 1000 * scale }),
      render: () => ({ promise: Promise.resolve() }),
    })),
  } as never;
}
function canvases(count: number) {
  return Array.from({ length: count }, () => ({ canvas: document.createElement("canvas") }));
}

describe("ImportModal validation", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as never);
    mocks.processCanvas.mockReturnValue({ pages: canvases(1) });
    mocks.loadPageImage.mockResolvedValue({ canvas: document.createElement("canvas"), modeUsed: "extract", dpiX: 299.8, dpiY: 299.7, sourceWidth: 2480, sourceHeight: 3504 });
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.clearAllMocks(); });
  const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const changeInput = async (field: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, value);
    await act(async () => field.dispatchEvent(new Event("input", { bubbles: true })));
  };

  it("does not render or allocate previews for a reversed or huge range, then recovers", async () => {
    const source = pdf();
    await act(async () => root.render(<ImportModal pdfPath="book.pdf" pdf={source} onCancel={vi.fn()} onConfirm={vi.fn()}/>));
    await vi.waitFor(() => expect(mocks.processCanvas).toHaveBeenCalled());
    const baseline = mocks.processCanvas.mock.calls.length;
    await changeInput(input("Start page"), "3");
    await vi.waitFor(() => expect(mocks.processCanvas.mock.calls.length).toBeGreaterThan(baseline));
    const afterValidRange = mocks.processCanvas.mock.calls.length;
    await changeInput(input("End page"), "2");
    expect(container.textContent).toContain("Start and end pages");
    expect(mocks.processCanvas).toHaveBeenCalledTimes(afterValidRange);
    await changeInput(input("End page"), "3");
    await vi.waitFor(() => expect(mocks.processCanvas.mock.calls.length).toBeGreaterThan(baseline));
  });

  it("defaults deskew on, refreshes the preview when disabled, and submits the choice", async () => {
    const confirm = vi.fn();
    await act(async () => root.render(<ImportModal pdfPath="book.pdf" pdf={pdf()} onCancel={vi.fn()} onConfirm={confirm}/>));
    const toggle = input("Automatically correct skew");
    expect(toggle.checked).toBe(true);
    expect(mocks.processCanvas).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ deskew: true }));
    await act(async () => toggle.click());
    expect(mocks.processCanvas).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ deskew: false }));
    await act(async () => container.querySelector<HTMLButtonElement>(".modal-actions .primary")!.click());
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ deskew: false }));
  });

  it("accepts a raw DPI while typing and blocks invalid DPI", async () => {
    await act(async () => root.render(<ImportModal pdfPath="book.pdf" pdf={pdf()} onCancel={vi.fn()} onConfirm={vi.fn()}/>));
    const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Import method"]')!;
    await act(async () => { mode.value = "render"; mode.dispatchEvent(new Event("change", { bubbles: true })); });
    await changeInput(input("DPI"), "2");
    expect(input("DPI").value).toBe("2");
    expect(container.querySelector<HTMLButtonElement>(".modal-actions .primary")!.disabled).toBe(true);
  });

  it("renders two labelled transformed previews for both sides", async () => {
    mocks.processCanvas.mockReturnValue({ pages: canvases(2) });
    await act(async () => root.render(<ImportModal pdfPath="book.pdf" pdf={pdf()} onCancel={vi.fn()} onConfirm={vi.fn()}/>));
    const split = container.querySelector<HTMLInputElement>('input[aria-label="Split spread into left and right"]')!;
    await act(async () => split.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Left"));
    expect(container.textContent).toContain("Right");
    expect(container.querySelectorAll(".preview-canvases canvas")).toHaveLength(2);
  });
  it("shows each side's applied angle with its sign and replaces angles when deskew is off", async () => {
    mocks.processCanvas.mockImplementation((_source, options) => ({
      pages: [-1.3, 0.4].map(angle => ({
        canvas: document.createElement("canvas"),
        provenance: { angle: options.deskew ? angle : 0 },
      })),
    }));
    await act(async () => root.render(<ImportModal pdfPath="book.pdf" pdf={pdf()} onCancel={vi.fn()} onConfirm={vi.fn()}/>));
    await act(async () => input("Split spread into left and right").click());
    const cards = () => Array.from(container.querySelectorAll(".preview-canvases figure"));
    expect(cards()[0].querySelector(".deskew-angle")?.textContent).toBe("Correction: -1.3°");
    expect(cards()[1].querySelector(".deskew-angle")?.textContent).toBe("Correction: +0.4°");
    await act(async () => input("Automatically correct skew").click());
    expect(cards().map(card => card.querySelector(".deskew-angle")?.textContent)).toEqual(["Skew correction: Off", "Skew correction: Off"]);
    mocks.processCanvas.mockReturnValue({ pages: [{ canvas: document.createElement("canvas"), provenance: { angle: 0 } }] });
    await act(async () => input("Automatically correct skew").click());
    expect(cards()[0].querySelector(".deskew-angle")?.textContent).toBe("Correction: 0.0°");
  });

  it.each([
    ["aligned", "No correction needed (0.0°)"],
    ["insufficient-text", "Skipped: not enough reliable text lines"],
    ["inconsistent-lines", "Skipped: text-line angles do not agree"],
    ["low-improvement", "Skipped: correction offers little improvement"],
    ["unavailable", "Skipped: image analysis is unavailable"],
  ])("shows the actual %s reason rather than a zero correction angle", async (status, message) => {
    mocks.processCanvas.mockReturnValue({
      pages: [{ canvas: document.createElement("canvas"), provenance: { angle: 0 }, deskew: { angle: 0, status } }],
    });
    await act(async () => root.render(<ImportModal pdfPath="book.pdf" pdf={pdf()} onCancel={vi.fn()} onConfirm={vi.fn()}/>));
    expect(container.querySelector(".deskew-angle")?.textContent).toBe(message);
    await act(async () => input("Automatically correct skew").click());
    expect(container.querySelector(".deskew-angle")?.textContent).toBe("Skew correction: Off");
  });

  it("mirrors outer and inner exclusion overlays across split previews", async () => {
    mocks.processCanvas.mockReturnValue({ pages: canvases(2) });
    await act(async () => root.render(<ImportModal pdfPath="book.pdf" pdf={pdf()} onCancel={vi.fn()} onConfirm={vi.fn()}/>));
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Split spread into left and right"]')!.click());
    await changeInput(input("Outer"), "12");
    await changeInput(input("Inner"), "7");
    await vi.waitFor(() => expect(container.querySelectorAll(".preview-canvases figure")).toHaveLength(2));
    const [left, right] = Array.from(container.querySelectorAll<HTMLElement>(".preview-canvases figure"));
    expect(left.querySelector<HTMLElement>(".margin-left")!.style.width).toBe("12%");
    expect(left.querySelector<HTMLElement>(".margin-right")!.style.width).toBe("7%");
    expect(right.querySelector<HTMLElement>(".margin-left")!.style.width).toBe("7%");
    expect(right.querySelector<HTMLElement>(".margin-right")!.style.width).toBe("12%");
  });

  it("keeps the modal mounted and disables save for invalid active margins", async () => {
    await act(async () => root.render(<ImportModal pdfPath="book.pdf" pdf={pdf()} onCancel={vi.fn()} onConfirm={vi.fn()}/>));
    await changeInput(input("Top"), "100");
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.querySelector<HTMLButtonElement>(".modal-actions .primary")!.disabled).toBe(true);
  });

  it("defaults to extraction, disables DPI, and recovers from invalid render DPI", async () => {
    await act(async () => root.render(<ImportModal pdfPath="book.pdf" pdf={pdf()} onCancel={vi.fn()} onConfirm={vi.fn()}/>));
    const dpi = input("DPI");
    expect(dpi.disabled).toBe(true);
    const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Import method"]')!;
    await act(async () => { mode.value = "render"; mode.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(dpi.disabled).toBe(false);
    await changeInput(dpi, "2");
    expect(container.querySelector<HTMLButtonElement>(".modal-actions .primary")!.disabled).toBe(true);
    await act(async () => { mode.value = "extract"; mode.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(dpi.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".modal-actions .primary")!.disabled).toBe(false);
  });

  it("shows per-page extraction dimensions and fallback reason", async () => {
    mocks.loadPageImage.mockResolvedValueOnce({ canvas: Object.assign(document.createElement("canvas"), { width: 2480, height: 3504 }), modeUsed: "extract", dpiX: 299.8, dpiY: 299.7, sourceWidth: 2480, sourceHeight: 3504 }).mockResolvedValueOnce({ canvas: Object.assign(document.createElement("canvas"), { width: 1200, height: 1600 }), modeUsed: "render", dpiX: 300, dpiY: 300, reason: "複雑なクリッピング" });
    await act(async () => root.render(<ImportModal pdfPath="book.pdf" pdf={pdf(2)} onCancel={vi.fn()} onConfirm={vi.fn()}/>));
    await vi.waitFor(() => expect(container.textContent).toContain("Original image 2480×3504 px"));
    const next = container.querySelectorAll<HTMLButtonElement>(".preview-nav button")[1];
    await act(async () => next.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Rendered at 300 DPI: 複雑なクリッピング"));
  });
});
