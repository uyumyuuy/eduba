import { describe, expect, it } from "vitest";
import { allLines, parseHocr, replaceLineSelection, type TextFormatKind, type TextFormatRange } from "./domain";
import { exportFixtureHocr } from "./testSupport/hocr";

function fixture(text: string, formatting: TextFormatRange[] = [], automatic = false) {
  const page = parseHocr(`<html><body><div class="ocr_page" title="bbox 0 0 100 80"><div class="ocr_carea" title="bbox 0 0 100 80"><p class="ocr_par" title="bbox 0 0 100 80"><span class="ocr_line" id="line" title="bbox 0 0 90 20"><span class="ocrx_word" title="bbox 0 0 90 20">${text}</span></span></p></div></div></body></html>`)[0];
  const line = allLines(page)[0];
  line.id = "line";
  line.correctedText = text;
  line.originalText = text;
  line[automatic ? "autoFormatting" : "formatting"] = formatting;
  return page;
}
const kinds: TextFormatKind[] = ["bold", "italic", "superscript", "subscript"];
describe("candidate formatting inheritance", () => {
  it.each(kinds)("inherits %s by non-whitespace majority and leaves replacement whitespace undecorated", kind => {
    const page = fixture("a   bc", [{start:4,end:6,kind}]);
    const next = replaceLineSelection(page,"line",0,6,"X Y\tZ");
    expect(allLines(next)[0].formatting).toEqual([{start:0,end:1,kind},{start:2,end:3,kind},{start:4,end:5,kind}]);
    expect(allLines(page)[0].correctedText).toBe("a   bc");
  });
  it.each(kinds)("does not inherit %s when undecorated characters win or tie", kind => {
    for (const text of ["abc","a b"]) {
      const page = fixture(text,[{start:0,end:1,kind}]);
      expect(allLines(replaceLineSelection(page,"line",0,text.length,"X"))[0].formatting).toBeUndefined();
    }
  });
  it("counts Unicode graphemes once and overlapping ranges once", () => {
    const page = fixture("á🙂x",[{start:0,end:2,kind:"bold"},{start:0,end:4,kind:"bold"}]);
    expect(allLines(replaceLineSelection(page,"line",0,5,"Y"))[0].formatting).toEqual([{start:0,end:1,kind:"bold"}]);
  });
  it("preserves formatting outside the exact selection even when the replacement shares its prefix", () => {
    const page = fixture("L aaa R",[{start:0,end:7,kind:"italic"},{start:6,end:7,kind:"bold"}]);
    const next = replaceLineSelection(page,"line",2,5,"a a");
    expect(allLines(next)[0].formatting).toEqual([
      {start:0,end:2,kind:"italic"},{start:5,end:7,kind:"italic"},{start:6,end:7,kind:"bold"},
      {start:2,end:3,kind:"italic"},{start:4,end:5,kind:"italic"},
    ]);
  });
  it("inherits inferred styles independently and exports them without decorating spaces", () => {
    const page = fixture("abcd",[{start:0,end:4,kind:"italic"},{start:0,end:3,kind:"superscript"},{start:0,end:1,kind:"bold"}],true);
    const next = replaceLineSelection(page,"line",0,4,"X Y");
    const line = allLines(next)[0];
    expect(line.autoFormatting).toBeUndefined();
    expect(line.formatting).toEqual([{start:0,end:1,kind:"italic"},{start:0,end:1,kind:"superscript"},{start:2,end:3,kind:"italic"},{start:2,end:3,kind:"superscript"}]);
    expect(exportFixtureHocr([next])).toContain("<sup><em>X</em></sup> <sup><em>Y</em></sup>");
  });
  it("preserves and shifts trailing ranges after a shorter replacement", () => {
    const page = fixture("L sz R",[{start:2,end:4,kind:"subscript"},{start:5,end:6,kind:"bold"}]);
    expect(allLines(replaceLineSelection(page,"line",2,4,"š"))[0].formatting).toEqual([{start:4,end:5,kind:"bold"},{start:2,end:3,kind:"subscript"}]);
  });
});
