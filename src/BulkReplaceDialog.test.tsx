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

  it("renders OCR formatting around the highlighted match and submits both format choices", async () => {
    invoke.mockResolvedValueOnce({ results: [{ pageId: "p", pageLabel: "1", lineId: "l", lineText: "old word", matchOrdinal: 0, formatting: [{ start: 0, end: 3, kind: "italic" }, { start: 4, end: 8, kind: "superscript" }] }], total: 1, page: 0, pageSize: 20 });
    const onApply = vi.fn();
    await act(async () => root.render(<BulkReplaceDialog open projectPath="project" initialSearch="old" onApply={onApply} onClose={vi.fn()} />));
    await vi.waitFor(() => expect(container.querySelector(".bulk-replace-match")?.getAttribute("style")).toContain("italic"));
    expect(container.querySelector(".bulk-replace-match")?.textContent).toBe("old");
    expect([...container.querySelectorAll<HTMLElement>(".bulk-replace-result-copy > span > span")].some(node => node.getAttribute("style")?.includes("vertical-align: super"))).toBe(true);
    const checkbox = container.querySelector<HTMLInputElement>(".bulk-replace-result input[type=checkbox]")!;
    await act(async () => { checkbox.click(); });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".modal-actions button")];
    const replaceWithFormatting = buttons.find(button => button.textContent?.includes("with formatting"))!;
    await act(async () => replaceWithFormatting.click());
    await vi.waitFor(() => expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ preserveFormatting: false })));
    const keepFormatting = [...container.querySelectorAll<HTMLButtonElement>(".modal-actions button")].find(button => button.textContent?.includes("keep formatting"))!;
    await act(async () => keepFormatting.click());
    await vi.waitFor(() => expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ preserveFormatting: true })));
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

  it("checks only the originating occurrence and respects manual deselection", async () => {
    const initialMatch = { pageId: "page", pageLabel: "1", lineId: "line", lineText: "old old value", matchOrdinal: 1 };
    const onApply = vi.fn();
    await act(async () => root.render(<BulkReplaceDialog open projectPath="project" initialSearch="old" initialMatch={initialMatch} onApply={onApply} onClose={vi.fn()} />));
    const checkboxes = [...container.querySelectorAll<HTMLInputElement>('.bulk-replace-result input[type="checkbox"]')];
    expect(checkboxes.map(checkbox => checkbox.checked)).toEqual([false, true]);
    const apply = container.querySelector<HTMLButtonElement>(".modal-actions .primary")!;
    await act(async () => apply.click());
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ selections: [initialMatch] }));
    await act(async () => checkboxes[1].click());
    expect(checkboxes[1].checked).toBe(false);
    expect(apply.disabled).toBe(true);
  });

  it("retains the originating selection when its result is on another page", async () => {
    const initialMatch = { pageId: "later", pageLabel: "22", lineId: "later-line", lineText: "old", matchOrdinal: 0 };
    invoke.mockImplementation(async (_command, args) => ({
      results: args.page === 0 ? [{ pageId: "page", pageLabel: "1", lineId: "line", lineText: "old", matchOrdinal: 0 }] : [initialMatch],
      total: 21, page: args.page, pageSize: 20,
    }));
    const onApply = vi.fn();
    await act(async () => root.render(<BulkReplaceDialog open projectPath="project" initialSearch="old" initialMatch={initialMatch} onApply={onApply} onClose={vi.fn()} />));
    expect(container.querySelector<HTMLInputElement>('.bulk-replace-result input')!.checked).toBe(false);
    expect(container.querySelector<HTMLButtonElement>(".modal-actions .primary")!.disabled).toBe(false);
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.bulk-replace-pagination button')[1].click());
    expect(container.querySelector<HTMLInputElement>('.bulk-replace-result input')!.checked).toBe(true);
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.bulk-replace-pagination button')[0].click());
    await act(async () => container.querySelector<HTMLButtonElement>(".modal-actions .primary")!.click());
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ selections: [initialMatch] }));
  });
});
