import { describe, expect, it } from "vitest";
import { clickedLineCaret } from "./clickCaret";
const bounds = {left:100,width:200};
function text(positions: number[], count = positions.length-1) {
  return {
    getScreenCTM:()=>({a:2,c:0,e:100}), getNumberOfChars:()=>count,
    getStartPositionOfChar:(index:number)=>({x:positions[index],y:0}),
    getEndPositionOfChar:(index:number)=>({x:positions[index+1],y:0}),
  } as unknown as SVGTextElement;
}
describe("click position caret", () => {
  it("uses actual glyph widths and screen scale rather than equal character spacing", () => {
    const svg = text([0,30,35,40]);
    expect(clickedLineCaret(svg,"Wii",158,bounds)).toBe(1);
    expect(clickedLineCaret(svg,"Wii",169,bounds)).toBe(2);
    expect(clickedLineCaret(svg,"Wii",500,bounds)).toBe(3);
    expect(clickedLineCaret(svg,"Wii",0,bounds)).toBe(0);
  });
  it("never splits an emoji or combining sequence and returns UTF-16 offsets", () => {
    expect(clickedLineCaret(text([0,10,20,30,40],4),"á🙂x",158,bounds)).toBe(4);
    expect(clickedLineCaret(text([0,10,20,30,40,50],5),"á🙂x",161,bounds)).toBe(4);
  });
  it("falls back to line bounds on grapheme boundaries when geometry is unavailable", () => {
    expect(clickedLineCaret(null,"á🙂x",240,bounds)).toBe(4);
    expect(clickedLineCaret(null,"á🙂x",90,bounds)).toBe(0);
    expect(clickedLineCaret(null,"",200,bounds)).toBe(0);
  });
});
