import { describe, expect, it } from "vitest";
import type { OcrLine } from "./domain";
import { effectiveFormatting, updateLineFormatting, updateLineText } from "./domain";
import {
  DEFAULT_SCRIPT_DETECTION_SETTINGS,
  detectScriptRanges,
  learnScriptHeightProfile,
  migrateLegacyScriptSettings,
  referenceHeightsForPage,
} from "./scriptDetection";

function lineFor(text: string, altered: Record<number, { top: number; bottom: number }>): OcrLine {
  let offset = 0;
  const chars = Array.from(text).map((character, index) => {
    const start = offset;
    offset += character.length;
    const box = altered[start] ?? { top: 8, bottom: 18 };
    return {
      index,
      originalText: character,
      correctedText: character,
      source: "ocr" as const,
      bbox: { left: index * 10, right: index * 10 + 8, ...box },
    };
  });
  return {
    id: "line",
    bbox: { left: 0, top: 0, right: 200, bottom: 20 },
    baseline: { slope: 0, intercept: -2 },
    originalText: text,
    correctedText: text,
    chars,
    words: [],
    geometryApproximate: false,
  };
}

function pageFor(lines: OcrLine[]) {
  return {
    id: "page", width: 200, height: 20, sourcePage: 0, split: "single" as const,
    rotation: 0, angle: 0,
    blocks: [{ id: "block", bbox: { left: 0, top: 0, right: 200, bottom: 20 },
      paragraphs: [{ id: "paragraph", bbox: { left: 0, top: 0, right: 200, bottom: 20 }, lines }] }],
  };
}

describe("script detection", () => {
  it("uses the requested initial thresholds", () => {
    expect(DEFAULT_SCRIPT_DETECTION_SETTINGS).toEqual({
      superscriptMaxHeightRatio: 0.7,
      superscriptMinRiseRatio: 0.3,
      subscriptMaxHeightRatio: 0.8,
      subscriptMinDropRatio: 0.2,
      subscriptScope: "digits-and-x",
    });
  });
  it("uses UTF-16 offsets and includes attached raised parentheses", () => {
    // The raised parenthesized 2 begins after A, an astral character, and a space: offset 4.
    const line = lineFor("A🙂 (2)BC", {
      4: { top: 6, bottom: 11 },
      5: { top: 6, bottom: 11 },
      6: { top: 6, bottom: 11 },
    });
    expect(detectScriptRanges(line, DEFAULT_SCRIPT_DETECTION_SETTINGS)).toEqual([
      { start: 4, end: 7, kind: "superscript" },
    ]);
  });

  it("recognizes default digit/x subscripts but not ordinary punctuation", () => {
    const subscript = lineFor("CO2AB", { 2: { top: 17, bottom: 22 } });
    expect(detectScriptRanges(subscript)).toEqual([
      { start: 2, end: 3, kind: "subscript" },
    ]);
    const hyphen = lineFor("a-bc", { 1: { top: 5, bottom: 11 } });
    expect(detectScriptRanges(hyphen)).toEqual([]);
  });

  it("returns no annotation when a box, baseline, or line geometry is untrustworthy", () => {
    const line = lineFor("AB2C", { 2: { top: 5, bottom: 11 } });
    line.chars[2].bbox = undefined;
    expect(detectScriptRanges(line)).toEqual([]);
    line.chars[2].bbox = { left: 20, top: 5, right: 28, bottom: 11 };
    line.baseline = undefined;
    expect(detectScriptRanges(line)).toEqual([]);
    line.baseline = { slope: 0, intercept: -2 };
    line.scriptDetectionManuallyEdited = true;
    expect(detectScriptRanges(line)).toEqual([]);
  });



  it("uses three baseline-aligned capitals rather than the lowercase majority", () => {
    const lowered = Object.fromEntries([3, 4, 5, 6, 7].map(index => [index, { top: 11, bottom: 18 }]));
    const line = lineFor("ABCaaaaa2", { ...lowered, 8: { top: 6, bottom: 11 } });
    expect(detectScriptRanges(line)).toEqual([{ start: 8, end: 9, kind: "superscript" }]);
  });

  it("falls back to lowercase shape ratios and learns ratios from cap-rich lines", () => {
    const lowercase = lineFor("aaat2", {
      0: { top: 11, bottom: 18 }, 1: { top: 11, bottom: 18 },
      2: { top: 11, bottom: 18 }, 3: { top: 10, bottom: 18 },
      4: { top: 7, bottom: 11 },
    });
    expect(detectScriptRanges(lowercase)).toEqual([{ start: 4, end: 5, kind: "superscript" }]);
    const rich = lineFor("ABCaaaaaaaaaa", Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [index + 3, { top: 12, bottom: 18 }]),
    ));
    const profile = learnScriptHeightProfile([pageFor([rich])]);
    expect(profile.ratios.a).toBeGreaterThan(0.6);
    expect(profile.ratios.a).toBeLessThan(0.73);
  });

  it("borrows a compatible capital height from a nearby line in the same block", () => {
    const caps = lineFor("ABC", {});
    caps.id = "caps";
    const lower = lineFor("aaa2", {
      0: { top: 11, bottom: 18 }, 1: { top: 11, bottom: 18 },
      2: { top: 11, bottom: 18 }, 3: { top: 7, bottom: 11 },
    });
    lower.id = "lower";
    const heights = referenceHeightsForPage(pageFor([caps, lower]), { version: 1, ratios: { a: 0.8 } });
    expect(heights.get("caps")).toBe(10);
    expect(heights.get("lower")).toBe(10);
  });

  it("migrates legacy thresholds to the capital-height scale", () => {
    const migrated = migrateLegacyScriptSettings({
      superscriptMaxHeightRatio: 0.7, superscriptMinRiseRatio: 0.45,
      subscriptMaxHeightRatio: 0.7, subscriptMinDropRatio: 0.35,
      subscriptScope: "all",
    });
    expect(migrated).toEqual({ ...DEFAULT_SCRIPT_DETECTION_SETTINGS, subscriptScope: "all" });
  });

  it("preserves automatic scripts as manual formatting when text is corrected", () => {
    const source = lineFor("AB2C", { 2: { top: 5, bottom: 11 } });
    source.autoFormatting = [{ start: 2, end: 3, kind: "superscript" }];
    const page = {
      id: "page", width: 200, height: 20, sourcePage: 0, split: "single" as const,
      rotation: 0, angle: 0,
      blocks: [{ id: "block", bbox: source.bbox, paragraphs: [{ id: "paragraph", bbox: source.bbox, lines: [source] }] }],
    };
    const edited = updateLineText(page, "line", "A!B2C");
    const line = edited.blocks[0].paragraphs[0].lines[0];
    expect(line.autoFormatting).toBeUndefined();
    expect(line.formatting).toEqual([{ start: 3, end: 4, kind: "superscript" }]);
  });
  it("lets a manual formatting change take ownership of automatic formatting", () => {
    const source = lineFor("AB2C", { 2: { top: 5, bottom: 11 } });
    source.autoFormatting = [{ start: 2, end: 3, kind: "superscript" }];
    const page = {
      id: "page", width: 200, height: 20, sourcePage: 0, split: "single" as const,
      rotation: 0, angle: 0,
      blocks: [{ id: "block", bbox: source.bbox, paragraphs: [{ id: "paragraph", bbox: source.bbox, lines: [source] }] }],
    };
    const edited = updateLineFormatting(page, "line", 2, 3, "superscript");
    const line = edited.blocks[0].paragraphs[0].lines[0];
    expect(line.autoFormatting).toBeUndefined();
    expect(line.scriptDetectionManuallyEdited).toBe(true);
    expect(effectiveFormatting(line)).toEqual([]);
  });
});