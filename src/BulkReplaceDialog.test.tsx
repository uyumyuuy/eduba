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