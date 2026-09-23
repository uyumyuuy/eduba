// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BulkReplaceDialog } from "./BulkReplaceDialog";
import i18n from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("./tauri", () => ({ invokeCommand: invoke }));

describe("BulkReplaceDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    invoke.mockResolvedValue({
      results: [
        { pageId: "page", pageLabel: "1", lineId: "line", lineText: "old old value", matchOrdinal: 0 },
        { pageId: "page", pageLabel: "1", lineId: "line", lineText: "old old value", matchOrdinal: 1 },
      ], total: 2, page: 0, pageSize: 20,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows shortcut keys above the unchanged button labels", async () => {
    await act(async () => root.render(<BulkReplaceDialog open projectPath="project" initialSearch="c" onApply={vi.fn()} onClose={vi.fn()} />));
    const editor = container.querySelector<HTMLInputElement>(".bulk-replace-editor input")!;
    const toolbarSlot = container.querySelector<HTMLElement>(".bulk-toolbar-slot")!;
    expect(toolbarSlot).not.toBeNull();
    expect(toolbarSlot.nextElementSibling).toBe(editor.parentElement);
    expect(toolbarSlot.querySelector(".bulk-selection-toolbar")).toBeNull();
    await act(async () => {
      editor.focus();
      editor.setSelectionRange(0, 1);
      editor.dispatchEvent(new Event("select", { bubbles: true }));
      document.dispatchEvent(new Event("selectionchange"));
    });
    const toolbar = container.querySelector(".bulk-selection-toolbar")!;
    expect(toolbar.parentElement).toBe(toolbarSlot);
    expect(toolbarSlot.nextElementSibling).toBe(editor.parentElement);
    const bold = toolbar.querySelector<HTMLButtonElement>('button[aria-label="Bold"]')!;
    const reservedShortcut = bold.querySelector(".edit-toolbar-shortcut")!;
    expect(reservedShortcut.classList.contains("is-visible")).toBe(false);
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true })));
    expect(bold.querySelector(".edit-toolbar-shortcut")).toBe(reservedShortcut);
    expect(reservedShortcut.classList.contains("is-visible")).toBe(true);
    expect(reservedShortcut.textContent).toBe("B");
    expect(bold.querySelector(".edit-toolbar-label")?.textContent).toBe("Bold");
    expect(bold.textContent).not.toContain("Ctrl+");
    const candidate = toolbar.querySelector<HTMLButtonElement>('button[aria-label="š"]')!;
    expect(candidate.querySelector(".edit-toolbar-shortcut")?.textContent).toBe("1");
    expect(candidate.querySelector(".edit-toolbar-label")?.textContent).toBe("š");
    await act(async () => bold.click());
    const decoration = container.querySelector<HTMLElement>(".bulk-edit-mirror .formatted-edit-decoration")!;
    expect(decoration.textContent).toBe("c");
    expect(decoration.style.fontWeight).toBe("700");
    expect(editor.classList.contains("has-formatting")).toBe(true);
  });

  it("keeps the selection toolbar outside the formatting mirror after script changes", async () => {
    await act(async () => root.render(<BulkReplaceDialog open projectPath="project" initialSearch="old" onApply={vi.fn()} onClose={vi.fn()} />));
    const editor = container.querySelector<HTMLInputElement>(".bulk-replace-editor input")!;
    await act(async () => {
      editor.focus();
      editor.setSelectionRange(1, 2);
      editor.dispatchEvent(new Event("select", { bubbles: true }));
      document.dispatchEvent(new Event("selectionchange"));
    });
    for (const label of ["Superscript", "Subscript"]) {
      const button = container.querySelector<HTMLButtonElement>(`.bulk-selection-toolbar button[aria-label="${label}"]`)!;
      await act(async () => button.click());
      const mirror = container.querySelector<HTMLElement>(".bulk-edit-mirror")!;
      const toolbar = container.querySelector<HTMLElement>(".bulk-selection-toolbar")!;
      expect(mirror).not.toBeNull();
      expect(toolbar).not.toBeNull();
      expect(mirror.parentElement).toBe(editor.parentElement);
      expect(toolbar.parentElement).toBe(editor.parentElement?.previousElementSibling);
      expect(mirror.parentElement?.contains(toolbar)).toBe(false);
    }
  });

  it("highlights the exact non-overlapping occurrence in every one-line result", async () => {
    await act(async () => root.render(<BulkReplaceDialog open projectPath="project" initialSearch="old" onApply={vi.fn()} onClose={vi.fn()} />));
    await vi.waitFor(() => expect(container.querySelectorAll(".bulk-replace-match")).toHaveLength(2));
    const rows = container.querySelectorAll(".bulk-replace-result-copy > span");
    expect(rows[0].innerHTML).toContain("<mark");
    expect(rows[0].textContent).toBe("old old value");
    expect(rows[1].getAttribute("title")).toBe("old old value");
    expect(rows[1].innerHTML.indexOf("<mark")).toBeGreaterThan(rows[1].innerHTML.indexOf("old "));
  });
});