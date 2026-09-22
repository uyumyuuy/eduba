import { describe, expect, it } from "vitest";
import { candidatesForSelection, convert, convertIndexToAccent } from "./correctionCandidates";

describe("transliteration candidates", () => {
  it("ports the legacy transliteration and index accent conversion", () => {
    expect(convert("s, t_ g^ a~ '")).toBe("ṣ ṯ ĝ ā ʿ");
    expect(convertIndexToAccent("ama2 e3 gu4")).toBe("áma è gu₄");
  });

  it("puts a converted selection first, followed by ordered OCR candidates", () => {
    expect(candidatesForSelection("c").slice(0, 5)).toEqual(["š", "C", "e", "Ç", "Ĝ"]);
  });

  it("uses the bundled output-to-GT order and excludes the selected character", () => {
    expect(candidatesForSelection("g").slice(0, 5)).toEqual(["3", "8", ":", "G", "i"]);
    expect(candidatesForSelection("g")).not.toContain("g");
  });

  it("does not apply one-character OCR mappings to a multi-grapheme selection", () => {
    expect(candidatesForSelection("a2")).toEqual(["á"]);
    expect(candidatesForSelection("🙂a")).toEqual([]);
  });
});
