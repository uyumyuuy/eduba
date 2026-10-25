import { describe, expect, it } from "vitest";
import { candidatesForSelection, convert, convertIndexToAccent } from "./correctionCandidates";
import { choicesForSelection } from "./ocrChoices";
import { allLines, parseHocr, updateLineText } from "./domain";
import { exportFixtureHocr } from "./testSupport/hocr";

describe("correction candidate sources", () => {
  it("retains transliteration without using the static confusion table", () => {
    expect(convert("s, t_ g^ a~ '")).toBe("ṣ ṯ ĝ ā ʿ");
    expect(convertIndexToAccent("ama2 e3 gu4")).toBe("áma è gu₄");
    expect(candidatesForSelection("[[k, sz]]")).toEqual(["⸢ḳ š⸣"]);
    expect(candidatesForSelection("g")).toEqual([]);
  });
  it.each([["k,", "ḳ"], ["K,", "Ḳ"], ["[[", "⸢"], ["]]", "⸣"]])("converts %s to %s", (selection, expected) => {
    expect(candidatesForSelection(selection)).toEqual([expected]);
  });
  it("ranks LSTM scores stably, excluding self, blank, invalid and duplicate choices", () => {
    const choices = [
      { text: "m", confidence: 99 }, { text: "rn", confidence: 5 },
      { text: "n", confidence: 20 }, { text: "r", confidence: 20 },
      { text: "n", confidence: 2 }, { text: " ", confidence: 30 },
      { text: "?", confidence: NaN },
    ];
    expect(candidatesForSelection("m", choices)).toEqual(["n", "r", "rn"]);
    expect(choices[1].text).toBe("rn");
    expect(candidatesForSelection("c", [{ text: "š", confidence: 10 }, { text: "C", confidence: 20 }])).toEqual(["š", "C"]);
    expect(candidatesForSelection("a2", choices)).toEqual(["á"]);
  });
});

const word = (text: string) => `<span class="ocrx_word" id="word" title="bbox 0 0 100 30">${text}</span>`;
function character(text: string, index: number, nested = false) {
  const choices = `<span class="ocrx_cinfo" id="lstm_choices_1_1_${index}"><span class="ocrx_cinfo" title="x_confs 90">${text}</span><span class="ocr_glyph" title="x_confs 12.5">X</span><span class="ocrx_cinfo" title="x_confs invalid">?</span></span>`;
  const span = `<span class="ocrx_cinfo" title="x_bboxes ${index * 10} 0 ${index * 10 + 10} 30; x_conf 98">${text}${nested ? choices : ""}</span>`;
  return nested ? span : span + choices;
}
function pageWith(content: string) {
  return parseHocr(`<html><body><div class="ocr_page" title="bbox 0 0 200 50"><div class="ocr_carea"><p class="ocr_par"><span class="ocr_line" id="line" title="bbox 0 0 100 30">${content}</span></p></div></div></body></html>`)[0];
}

describe("choice-aware hOCR contract", () => {
  it.each([false, true])("keeps choices out of recognized/exported text (nested=%s)", nested => {
    const page = pageWith(word(`<strong>${character("m", 0, nested)}${character("𒀀", 1, nested)}</strong>`));
    const line = allLines(page)[0];
    expect(line.correctedText).toBe("m𒀀");
    expect(line.chars).toHaveLength(2);
    expect(line.chars[0]).toMatchObject({ choices: [{ text: "m", confidence: 90 }, { text: "X", confidence: 12.5 }], confidence: 98, bbox: { left: 0, top: 0, right: 10, bottom: 30 } });
    const restored = JSON.parse(JSON.stringify(page));
    expect(choicesForSelection(allLines(restored)[0], 1, 3).map(choice => choice.text)).toEqual(["𒀀", "X"]);
    const exported = exportFixtureHocr([restored]);
    expect(exported).not.toContain("lstm_choices");
    expect(exported).not.toContain("x_confs");
    expect(allLines(parseHocr(exported)[0])[0].correctedText).toBe("m𒀀");
  });
  it("ignores unmappable choices without character boxes and legacy timesteps", () => {
    const page = pageWith(word('m<span class="ocrx_cinfo" id="lstm_choices_1_1_1"><span class="ocrx_cinfo" title="x_confs 20">X</span></span><span class="ocr_symbol"><span class="ocrx_cinfo" title="x_confs 10">Z</span></span>'));
    expect(allLines(page)[0].correctedText).toBe("m");
    expect(choicesForSelection(allLines(page)[0], 0, 1)).toEqual([]);
  });
  it("keeps escaped alternatives out of body text", () => {
    const line = allLines(pageWith(word(character("&amp;", 0))))[0];
    expect(line.correctedText).toBe("&");
    expect(choicesForSelection(line, 0, 1)[0].text).toBe("&");
  });
});

describe("choice positions after editing", () => {
  const page = pageWith(word([..."book"].map((text, index) => character(text, index)).join("")));
  const original = allLines(page)[0];
  const edited = (text: string) => allLines(updateLineText(page, original.id, text))[0];
  it("maps unchanged symbols and rejects new or replaced symbols", () => {
    expect(choicesForSelection(edited("a book"), 2, 3)[0].text).toBe("b");
    expect(choicesForSelection(edited("boox"), 0, 1)[0].text).toBe("b");
    expect(choicesForSelection(edited("boox"), 3, 4)).toEqual([]);
    expect(choicesForSelection(edited("a book"), 0, 1)).toEqual([]);
  });
  it("rejects ambiguous repeated symbols and multi-grapheme selections", () => {
    expect(choicesForSelection(edited("bok"), 1, 2)).toEqual([]);
    expect(choicesForSelection(edited("bok"), 2, 3)[0].text).toBe("k");
    expect(choicesForSelection(original, 1, 3)).toEqual([]);
  });
  it("supports a grapheme with separately recognized combining marks", () => {
    const line = allLines(pageWith(word(character("g", 0) + character("&#x303;", 1))))[0];
    expect(line.correctedText).toBe("g̃");
    expect(choicesForSelection(line, 0, 2).map(choice => choice.text)).toEqual(["g̃", "X̃", "g̃", "gX"]);
  });
  it("ignores invalid offsets and excessively long edited lines", () => {
    expect(choicesForSelection(original, -1, 1)).toEqual([]);
    expect(choicesForSelection(original, 0, 99)).toEqual([]);
    expect(choicesForSelection({ ...original, correctedText: "x".repeat(100_000) }, 0, 1)).toEqual([]);
  });
});
