import { describe, expect, it } from "vitest";
import { candidatesForSelection, convert, convertIndexToAccent } from "./correctionCandidates";

describe("transliteration candidates", () => {
  it("ports the legacy transliteration and index accent conversion", () => {
    expect(convert("s, t_ g^ a~ '")).toBe("ṣ ṯ ĝ ā ʿ");
    expect(convertIndexToAccent("ama2 e3 gu4")).toBe("áma è gu₄");
  });

  it("keeps transliteration conversions ahead of OCR candidates", () => {
    expect(candidatesForSelection("c")[0]).toBe("š");
    expect(candidatesForSelection("a2")[0]).toBe("á");
  });

  it("ranks OCR candidates by observed count and keeps tied candidates in source order", () => {
    const candidates = candidatesForSelection("g");

    expect(candidates.slice(0, 6)).toEqual(["G", "ṣ", "q", "8", "ç", "3"]);
    expect(candidates).toEqual(["G", "ṣ", "q", "8", "ç", "3", ":", "i", "t", "ē", "ĝ", "Ḫ"]);
    expect(candidates).not.toContain("g");
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("does not apply one-character OCR mappings to a multi-grapheme selection", () => {
    expect(candidatesForSelection("a2")).toEqual(["á"]);
    expect(candidatesForSelection("🙂a")).toEqual([]);
  });
});
