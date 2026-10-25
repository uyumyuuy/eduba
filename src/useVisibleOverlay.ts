import { useLayoutEffect, type RefObject } from "react";
import { overlayPosition } from "./overlayPosition";

/** Keep an absolutely positioned overlay inside its scroll pane and the window. */
export function useVisibleOverlay(ref: RefObject<HTMLElement | null>, left: number, top: number, content: unknown, avoid?: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const ancestors: HTMLElement[] = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
    const place = () => {
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
      let minX = 0, minY = 0, maxX = window.innerWidth, maxY = window.innerHeight;
      for (const parent of ancestors) {
        const style = getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          minX = Math.max(minX, rect.left + parent.clientLeft);
          maxX = Math.min(maxX, rect.left + parent.clientLeft + parent.clientWidth);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          minY = Math.max(minY, rect.top + parent.clientTop);
          maxY = Math.min(maxY, rect.top + parent.clientTop + parent.clientHeight);
        }
      }
      element.style.boxSizing = "border-box";
      element.style.maxWidth = `${Math.max(0, maxX - minX - 8)}px`;
      element.style.maxHeight = `${Math.max(0, maxY - minY - 8)}px`;
      const rect = element.getBoundingClientRect();
      const position = overlayPosition({ left: minX + 4, top: minY + 4, right: maxX - 4, bottom: maxY - 4 },
        rect, rect.width, rect.height, avoid?.current ? [avoid.current.getBoundingClientRect()] : []);
      element.style.visibility = position ? "" : "hidden";
      const x = position?.left ?? rect.left, y = position?.top ?? rect.top;
      element.style.left = `${left + x - rect.left}px`;
      element.style.top = `${top + y - rect.top}px`;
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    ancestors.forEach(parent => observer?.observe(parent));
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      observer?.disconnect();
    };
  }, [ref, left, top, content, avoid]);
}
