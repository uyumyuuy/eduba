// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportHocr, processCanvas, type DocumentPage, type PreprocessOptions } from "./domain";
import { inverse, multiply, type Affine, type HocrSource } from "./coordinates";

const point = (m: Affine, x: number, y: number) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
afterEach(() => vi.restoreAllMocks());

// Reconstruct the transform independently from the actual canvas draw calls.
function recordCanvasTransforms() {
  const drawn = new WeakMap<object, Affine>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function(this: HTMLCanvasElement) {
    const owner = this;
    let c: Affine = [1, 0, 0, 1, 0, 0];
    return {
      fillRect() {},
      translate(x: number, y: number) { c = multiply(c, [1,0,0,1,x,y]); },
      rotate(a: number) { c = multiply(c, [Math.cos(a),Math.sin(a),-Math.sin(a),Math.cos(a),0,0]); },
      drawImage(source: object, ...args: number[]) {
        const [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 8 ? args
          : [0,0,args[2],args[3],args[0],args[1],args[2],args[3]];
        const draw: Affine = [dw/sw,0,0,dh/sh,dx-sx*dw/sw,dy-sy*dh/sh];
        drawn.set(owner, multiply(multiply(c, draw), drawn.get(source) ?? [1,0,0,1,0,0]));
      },
    } as unknown as CanvasRenderingContext2D;
  });
  return drawn;
}

describe("hOCR PDF coordinate contract", () => {
  it.each([
    { rotation: 0, split: "right", deskewAngle: 1.2, preprocessOrder: "split-deskew" },
    { rotation: 90, split: "both", deskewAngle: -2.1, preprocessOrder: "split-deskew" },
    { rotation: 180, split: "left", deskewAngle: 0, preprocessOrder: "split-deskew" },
    { rotation: 270, split: "right", deskewAngle: -1.3, preprocessOrder: "deskew-split" },
    { rotation: 0, split: "none", deskewAngle: 0.5, preprocessOrder: "deskew-split" },
  ] satisfies PreprocessOptions[])("maps actual draw geometry back to PDF: %j", options => {
    const draws = recordCanvasTransforms();
    const canvas = Object.assign(document.createElement("canvas"), { width: 1001, height: 801 });
    const result = processCanvas(canvas, { ...options, crop: { left: -1.2, top: 20.8, right: 350.2, bottom: 500.1 } });
    // Nonzero PDF box origin, intrinsic /Rotate, UserUnit and anisotropic pixels.
    const pdfToSource: Affine = [0, 4, 3, 0, -30, -80];
    for (const page of result.pages) {
      const actual = draws.get(page.canvas)!;
      actual.forEach((value, i) => expect(page.sourceToPage[i]).toBeCloseTo(value, 10));
      const back = inverse(multiply(page.sourceToPage, pdfToSource));
      for (const pdfPoint of [[20,10],[150,200],[80,50]]) {
        const raster = point(multiply(actual, pdfToSource), ...pdfPoint as [number, number]);
        const restored = point(back, ...raster as [number, number]);
        restored.forEach((v,i) => expect(v).toBeCloseTo(pdfPoint[i], 9));
      }
    }
  });

  const page: DocumentPage = { id: "p1", sourcePage: 7, split: "right", rotation: 90, angle: -1.2,
    width: 500, height: 700, blocks: [], figureRegions: [{id:"fig",kind:"figure",bbox:{left:10,top:20,right:30,bottom:40}}] };
  const source: HocrSource = { fingerprint: "abc123", byteLength: 1024, pages: { p1: {
    pageToPdf: [0.24,0,0,-0.24,120,800], pdfBox: [10,20,600,900], pdfRotation: 270, pdfUserUnit: 2,
    sourceWidth: 1001, sourceHeight: 800, dpiX: 300, dpiY: 301, mode: "extract",
  } } };
  it("serializes a self-contained mapping, keeps source page independent of output numbering, and declares properties", () => {
    const xml = new DOMParser().parseFromString(exportHocr([page], source), "application/xml");
    expect(xml.querySelector("parsererror")).toBeNull();
    expect(xml.querySelector('meta[name="eduba-hocr-version"]')?.getAttribute("content")).toBe("1");
    const title = xml.querySelector(".ocr_page")!.getAttribute("title")!;
    expect(title).toContain('x_source "pdf:abc123" "7"');
    expect(title).toContain("ppageno 0");
    expect(title).toContain("x_edubapdfuserunit 2");
    expect(title).toContain("x_edubapreprocessorder deskew-split");
    expect(title).toContain("x_edubacrop none");
    const m = title.match(/x_edubapagetopdf ([^;]+)/)![1].split(" ").map(Number) as Affine;
    expect(point(m,10,20)).toEqual([122.4,795.2]);
    const caps = xml.querySelector('meta[name="ocr-capabilities"]')!.getAttribute("content")!.split(" ");
    title.split("; ").forEach(prop => expect(caps).toContain(`ocrp_${prop.split(" ")[0]}`));
    expect(xml.querySelector(".ocr_image")?.getAttribute("title")).toBe("bbox 10 20 30 40");
  });
  it("exports missing and invalid mappings without inventing PDF coordinates", () => {
    for (const input of [
      {...source, pages:{}},
      {...source, pages:{p1:{...source.pages.p1,pageToPdf:[0,0,0,0,0,0] as Affine}}},
      {...source, fingerprint:""},
    ]) {
      const xml = new DOMParser().parseFromString(exportHocr([page], input), "application/xml");
      expect(xml.querySelector("parsererror")).toBeNull();
      expect(xml.querySelector('meta[name="eduba-hocr-coordinates"]')?.getAttribute("content")).toBe("incomplete");
      const title = xml.querySelector(".ocr_page")!.getAttribute("title")!;
      expect(title).toContain("x_edubacoordinates unavailable");
      expect(title).toContain("x_edubacoordinatereason");
      expect(title).not.toContain("x_edubapagetopdf");
      expect(title).not.toContain("NaN");
      expect(xml.querySelector(".ocr_image")).not.toBeNull();
    }
  });
  it("retains valid mappings for other pages when one page cannot be reconstructed", () => {
    const xml = new DOMParser().parseFromString(exportHocr([page,{...page,id:"p2",sourcePage:8}], {
      ...source, unavailable: {p2:"reconstruction-failed"},
    }), "application/xml");
    const titles = [...xml.querySelectorAll(".ocr_page")].map(element=>element.getAttribute("title")!);
    expect(titles[0]).toContain("x_edubacoordinates complete");
    expect(titles[0]).toContain("x_edubapagetopdf");
    expect(titles[1]).toContain("x_edubacoordinatereason reconstruction-failed");
    expect(titles[1]).not.toContain("x_edubapagetopdf");
  });
});
