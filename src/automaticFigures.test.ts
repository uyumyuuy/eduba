// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareFigureOcr } from "./automaticFigures";
import { defaultOcrMargins } from "./ocrMargins";
import type { LogicalPageProvenance } from "./domain";
function fixture() {
  const source=document.createElement("canvas");source.width=200;source.height=100;
  const context={ drawImage:vi.fn(),fillRect:vi.fn(),fillStyle:"" };
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(context as never);
  const entry:LogicalPageProvenance={sourcePage:1,split:"single",rotation:0,angle:0,autoFigureDetection:true,ocrMargins:{...defaultOcrMargins,left:10,top:10}};
  return {source,context,entry};
}
afterEach(()=>vi.restoreAllMocks());
describe("automatic figure OCR preparation",()=>{
  it("masks exclusions before detecting and masks accepted figures before OCR without changing source",async()=>{
    const {source,context,entry}=fixture();
    const detect=vi.fn(async(canvas:HTMLCanvasElement)=>{
      expect(canvas).not.toBe(source);expect(context.fillRect).toHaveBeenCalledWith(0,0,20,100);
      return [{score:.9,bbox:{left:30,top:20,right:90,bottom:60}}];
    });
    const result=await prepareFigureOcr(source,entry,[],detect);
    expect(result.figures).toHaveLength(1);expect(result.figures[0].kind).toBe("figure");
    expect(context.fillRect).toHaveBeenCalledWith(30,20,60,40);expect([source.width,source.height]).toEqual([200,100]);
  });
  it("drops fully excluded regions, clips border bleed and ignores low-confidence/invalid output",async()=>{
    const {source,entry}=fixture();
    const result=await prepareFigureOcr(source,entry,[],async()=>[
      {score:.9,bbox:{left:0,top:0,right:10,bottom:8}},
      {score:.9,bbox:{left:10,top:5,right:60,bottom:40}},
      {score:.49,bbox:{left:90,top:30,right:110,bottom:80}},
      {score:.9,bbox:{left:NaN,top:20,right:90,bottom:80}},
    ]);
    expect(result.figures.map(f=>f.bbox)).toEqual([{left:20,top:10,right:60,bottom:40}]);
  });
  it("legacy/off skips inference but preserves and masks manual regions",async()=>{
    const {source,context,entry}=fixture();delete entry.autoFigureDetection;
    const existing=[{id:"manual",kind:"table" as const,bbox:{left:30,top:20,right:80,bottom:60}}];const detect=vi.fn();
    const result=await prepareFigureOcr(source,entry,existing,detect);
    expect(detect).not.toHaveBeenCalled();expect(result.figures).toEqual(existing);expect(result.figures[0]).not.toBe(existing[0]);
    expect(context.fillRect).toHaveBeenCalledWith(30,20,50,40);
  });
  it("keeps manual regions without duplicates and propagates failures instead of unmasked OCR",async()=>{
    const {source,entry}=fixture();const existing=[{id:"manual",kind:"figure" as const,bbox:{left:30,top:20,right:80,bottom:60}}];
    const result=await prepareFigureOcr(source,entry,existing,async()=>[{score:.9,bbox:{left:31,top:21,right:79,bottom:59}}]);expect(result.figures).toEqual(existing);
    await expect(prepareFigureOcr(source,entry,[],async()=>{throw new Error("model missing");})).rejects.toThrow("model missing");
  });
});
