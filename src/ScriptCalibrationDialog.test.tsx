// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptCalibrationDialog } from "./ScriptCalibrationDialog";
import { DEFAULT_SCRIPT_DETECTION_SETTINGS } from "./scriptDetection";
import i18n from "./i18n";

describe("ScriptCalibrationDialog example sampling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("keeps separate current-page and all-pages actions with the draft settings", async () => {
    const currentPage = vi.fn();
    const allPages = vi.fn();
    await act(async () => root.render(<ScriptCalibrationDialog
      open
      initialSettings={DEFAULT_SCRIPT_DETECTION_SETTINGS}
      candidates={[]}
      getSnippet={() => null}
      detectPreview={() => []}
      onReshuffleCurrentPage={currentPage}
      onReshuffleAllPages={allPages}
      onApply={vi.fn()}
      onClose={vi.fn()}
    />));

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".script-calibration-reshuffle-actions button")];
    expect(buttons.map(button => button.textContent)).toEqual([
      "Reshuffle examples (from current page)",
      "Reshuffle examples (from all pages)",
    ]);
    await act(async () => buttons[0].click());
    await act(async () => buttons[1].click());
    expect(currentPage).toHaveBeenCalledWith(DEFAULT_SCRIPT_DETECTION_SETTINGS);
    expect(allPages).toHaveBeenCalledWith(DEFAULT_SCRIPT_DETECTION_SETTINGS);
  });

  it("uses the requested Japanese labels", async () => {
    await i18n.changeLanguage("ja");
    await act(async () => root.render(<ScriptCalibrationDialog
      open
      initialSettings={DEFAULT_SCRIPT_DETECTION_SETTINGS}
      candidates={[]}
      getSnippet={() => null}
      detectPreview={() => []}
      onReshuffleCurrentPage={vi.fn()}
      onReshuffleAllPages={vi.fn()}
      onApply={vi.fn()}
      onClose={vi.fn()}
    />));
    expect([...container.querySelectorAll<HTMLButtonElement>(".script-calibration-reshuffle-actions button")].map(button => button.textContent)).toEqual([
      "例を入れ替える（編集中ページから）",
      "例を入れ替える（全ページから）",
    ]);
  });
});
