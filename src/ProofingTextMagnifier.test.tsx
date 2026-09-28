// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProofingTextMagnifier } from "./ProofingTextMagnifier";

describe("proofreading text magnifier", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it("renders selection and formatting in the same text flow with a caret at its boundary", () => {
    act(() => root.render(<ProofingTextMagnifier value="ABCD" formatting={[
      { start: 0, end: 2, kind: "bold" }, { start: 0, end: 2, kind: "italic" }, { start: 2, end: 4, kind: "superscript" },
    ]} selectionStart={1} selectionEnd={3} caret={1} fontSize={30} style={{ left: 10, top: 10 }} />));
    const flow = container.querySelector(".proofing-text-flow")!;
    expect(flow.textContent).toBe("ABCD");
    expect(flow.children[0].getAttribute("style")).toContain("font-weight: 700");
    expect(flow.children[0].getAttribute("style")).toContain("font-style: italic");
    expect(Array.from(flow.querySelectorAll(".proofing-text-selection")).map(span => span.textContent).join("")).toBe("BC");
    expect(flow.querySelector(".proofing-text-caret")?.nextElementSibling?.textContent).toBe("B");
    expect(flow.children[flow.children.length - 1].getAttribute("style")).toContain("vertical-align: super");
  });
});
