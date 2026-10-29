// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useVisibleOverlay } from "./useVisibleOverlay";

it("keeps overlays in the pane on scroll and resize, then restores their preferred position", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let scroll = 0;
  const bounds = (left: number, top: number, width: number, height: number) =>
    ({ left, top, right: left + width, bottom: top + height, width, height } as DOMRect);
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.className === "pane") return bounds(100, 100, 300, 200);
    if (this.className === "overlay") return bounds(100 + Number.parseFloat(this.style.left),
      100 + Number.parseFloat(this.style.top) - scroll, 120, 40);
    return bounds(0, 0, 1024, 768);
  });
  const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  function Overlay() {
    const ref = useRef<HTMLDivElement>(null);
    useVisibleOverlay(ref, 260, 120, true);
    return <div className="pane" style={{ overflowX: "auto", overflowY: "auto" }}>
      <div className="overlay" ref={ref} />
    </div>;
  }
  try {
    act(() => root.render(<Overlay />));
    const overlay = host.querySelector<HTMLElement>(".overlay")!;
    expect(overlay.style.left).toBe("176px");
    expect(overlay.style.top).toBe("120px");
    scroll = 300;
    act(() => document.dispatchEvent(new Event("scroll")));
    expect(overlay.style.top).toBe("304px");
    scroll = -200;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(overlay.style.top).toBe("-44px");
    scroll = 0;
    act(() => document.dispatchEvent(new Event("scroll")));
    expect(overlay.style.top).toBe("120px");
  } finally {
    act(() => root.unmount());
    host.remove();
    rect.mockRestore();
    clientWidth.mockRestore();
    clientHeight.mockRestore();
  }
});
