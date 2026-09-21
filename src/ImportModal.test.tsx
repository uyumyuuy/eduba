// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportModal } from "./ImportModal";

const processCanvas = vi.hoisted(() => vi.fn());
vi.mock("./domain", () => ({ processCanvas }));

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
    processCanvas.mockReturnValue({ pages: canvases(1) });
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
    await vi.waitFor(() => expect(processCanvas).toHaveBeenCalled());
    const baseline = processCanvas.mock.calls.length;
    await changeInput(input("開始ページ"), "3");
    await vi.waitFor(() => expect(processCanvas.mock.calls.length).toBeGreaterThan(baseline));
    const afterValidRange = processCanvas.mock.calls.length;
    await changeInput(input("終了ページ"), "2");
    expect(container.textContent).toContain("開始・終了ページ");
    expect(processCanvas).toHaveBeenCalledTimes(afterValidRange);
    await changeInput(input("終了ページ"), "3");
    await vi.waitFor(() => expect(processCanvas.mock.calls.length).toBeGreaterThan(baseline));
  });

  it("accepts a raw DPI while typing and blocks invalid DPI", async () => {
    await act(async () => root.render(<ImportModal pdfPath="book.pdf" pdf={pdf()} onCancel={vi.fn()} onConfirm={vi.fn()}/>));
    await changeInput(input("DPI"), "2");
    expect(input("DPI").value).toBe("2");
    expect(container.querySelector<HTMLButtonElement>(".modal-actions .primary")!.disabled).toBe(true);
  });

  it("renders two labelled transformed previews for both sides", async () => {
    processCanvas.mockReturnValue({ pages: canvases(2) });
    await act(async () => root.render(<ImportModal pdfPath="book.pdf" pdf={pdf()} onCancel={vi.fn()} onConfirm={vi.fn()}/>));
    const split = container.querySelector<HTMLInputElement>("input[aria-label=見開きを左右に分割]")!;
    await act(async () => split.click());
    await vi.waitFor(() => expect(container.textContent).toContain("左"));
    expect(container.textContent).toContain("右");
    expect(container.querySelectorAll(".preview-canvases canvas")).toHaveLength(2);
  });
  it("mirrors outer and inner exclusion overlays across split previews", async () => {
    processCanvas.mockReturnValue({ pages: canvases(2) });
    await act(async () => root.render(<ImportModal pdfPath="book.pdf" pdf={pdf()} onCancel={vi.fn()} onConfirm={vi.fn()}/>));
    await act(async () => container.querySelector<HTMLInputElement>("input[aria-label=見開きを左右に分割]")!.click());
    await changeInput(input("小口"), "12");
    await changeInput(input("ノド"), "7");
    await vi.waitFor(() => expect(container.querySelectorAll(".preview-canvases figure")).toHaveLength(2));
    const [left, right] = Array.from(container.querySelectorAll<HTMLElement>(".preview-canvases figure"));
    expect(left.querySelector<HTMLElement>(".margin-left")!.style.width).toBe("12%");
    expect(left.querySelector<HTMLElement>(".margin-right")!.style.width).toBe("7%");
    expect(right.querySelector<HTMLElement>(".margin-left")!.style.width).toBe("7%");
    expect(right.querySelector<HTMLElement>(".margin-right")!.style.width).toBe("12%");
  });

  it("keeps the modal mounted and disables save for invalid active margins", async () => {
    await act(async () => root.render(<ImportModal pdfPath="book.pdf" pdf={pdf()} onCancel={vi.fn()} onConfirm={vi.fn()}/>));
    await changeInput(input("天"), "100");
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.querySelector<HTMLButtonElement>(".modal-actions .primary")!.disabled).toBe(true);
  });
});
