import { afterEach, describe, expect, it, vi } from "vitest";
import candidateData from "./assets/scan-candidate-character-confusions.json";
import { candidatesForSelection, convert, convertIndexToAccent } from "./correctionCandidates";

describe("transliteration candidates", () => {
  it("ports the legacy transliteration and index accent conversion", () => {
    expect(convert("s, t_ g^ a~ '")).toBe("ṣ ṯ ĝ ā ʿ");
    expect(convertIndexToAccent("ama2 e3 gu4")).toBe("áma è gu₄");
  });

  it.each([
    ["k,", "ḳ"], ["K,", "Ḳ"], ["[[", "⸢"], ["]]", "⸣"],
  ])("offers the added transliteration %s as %s", (selection, expected) => {
    expect(convert(selection)).toBe(expected);
    expect(candidatesForSelection(selection)).toEqual([expected]);
  });

  it("converts the new patterns together with existing transliteration rules", () => {
    expect(convert("k, K, [[text]]")).toBe("ḳ Ḳ ⸢text⸣");
    expect(candidatesForSelection("[[k, sz]]")).toEqual(["⸢ḳ š⸣"]);
  });

  it("keeps transliteration conversions ahead of OCR candidates", () => {
    expect(candidatesForSelection("c")[0]).toBe("š");
    expect(candidatesForSelection("a2")[0]).toBe("á");
  });

  it("does not apply one-character OCR mappings to a multi-grapheme selection", () => {
    expect(candidatesForSelection("a2")).toEqual(["á"]);
    expect(candidatesForSelection("🙂a")).toEqual([]);
  });

  it("retains the bundled candidates without fixing their counts or order", () => {
    for (const [selection, entry] of Object.entries(candidateData.output_to_gt)) {
      const converted = convertIndexToAccent(convert(selection));
      const candidates = candidatesForSelection(selection);
      const expected = new Set(converted !== selection ? [converted] : []);
      if ([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(selection)].length === 1) {
        for (const candidate of entry.gt_candidates) {
          if (candidate.gt_character !== selection) expected.add(candidate.gt_character);
        }
      }
      expect(new Set(candidates), selection).toEqual(expected);
      expect(candidates.length, selection).toBe(expected.size);
      expect(candidates, selection).not.toContain(selection);
    }
  });
});

describe("OCR candidate ranking with fixed test data", () => {
  const fixture = {
    output_to_gt: {
      g: { gt_candidates: [
        { gt_character: "8", count: 2 },
        { gt_character: "g", count: 999 },
        { gt_character: "ṣ", count: 7 },
        { gt_character: "Ĝ", count: 3 },
        { gt_character: "q", count: 7 },
        { gt_character: "ç", count: 3 },
        { gt_character: "ç", count: 1 },
        { gt_character: "Ḫ", count: 1 },
        { gt_character: "Ĝ", count: 3 },
      ] },
      c: { gt_candidates: [
        { gt_character: "C", count: 50 },
        { gt_character: "š", count: 1 },
        { gt_character: "c", count: 100 },
      ] },
      a2: { gt_candidates: [{ gt_character: "unexpected", count: 100 }] },
    },
  };

  afterEach(() => {
    vi.doUnmock("./assets/scan-candidate-character-confusions.json");
    vi.resetModules();
  });

  async function fixtureCandidates() {
    vi.resetModules();
    vi.doMock("./assets/scan-candidate-character-confusions.json", () => ({ default: fixture }));
    return (await import("./correctionCandidates")).candidatesForSelection;
  }

  it("ranks by count, keeps source order for ties, and excludes self and duplicates", async () => {
    const candidates = await fixtureCandidates();
    expect(candidates("g")).toEqual(["ṣ", "q", "Ĝ", "ç", "8", "Ḫ"]);
    // Ranking must not mutate the shared source order across calls.
    expect(candidates("g")).toEqual(["ṣ", "q", "Ĝ", "ç", "8", "Ḫ"]);
    expect(fixture.output_to_gt.g.gt_candidates[0].gt_character).toBe("8");
  });

  it("prioritizes transliteration and excludes its duplicate OCR candidate", async () => {
    const candidates = await fixtureCandidates();
    expect(candidates("c")).toEqual(["š", "C"]);
  });

  it("ignores OCR mappings for multi-grapheme selections", async () => {
    const candidates = await fixtureCandidates();
    expect(candidates("a2")).toEqual(["á"]);
  });
});
