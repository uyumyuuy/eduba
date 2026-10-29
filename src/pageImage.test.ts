// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageKind, OPS } from "pdfjs-dist";
import { loadPageImage } from "./pageImage";

function page(
  ops: number[],
  args: unknown[][],
  image?: { width: number; height: number; kind?: number; data?: Uint8Array },
) {
  const context = {
    fillRect: vi.fn(),
    createImageData: vi.fn((width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })),
    putImageData: vi.fn(),
    drawImage: vi.fn(),
    setTransform: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    imageSmoothingEnabled: true,
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  return {
    getOperatorList: vi.fn(async () => ({ fnArray: ops, argsArray: args })),
    getViewport: vi.fn(() => ({
      width: 100,
      height: 100,
      transform: [1, 0, 0, -1, 0, 100],
    })),
    objs: {
      get: vi.fn((_id: string, callback?: (value: unknown) => void) => {
        if (!image) throw new Error("unresolved");
        const value = {
          ...image,
          bitmap: image.data ? undefined : image as unknown as CanvasImageSource,
        };
        callback?.(value);
        return value;
      }),
    },
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    context,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("native page-image extraction", () => {
  it("uses intrinsic image pixels and the page viewport coordinate frame", async () => {
    const fake = page(
      [OPS.transform, OPS.paintImageXObject],
      [[100, 0, 0, 100, 0, 0], ["img"]],
      { width: 100, height: 100 },
    );
    const result = await loadPageImage(fake as never, "extract", 72);
    expect(result).toMatchObject({
      modeUsed: "extract",
      pdfToSource: [1, 0, 0, -1, 0, 100],
      sourceWidth: 100,
      sourceHeight: 100,
      dpiX: 72,
      dpiY: 72,
    });
    expect(result.canvas).toMatchObject({ width: 100, height: 100 });
    expect(fake.context.drawImage).toHaveBeenCalled();
    expect(fake.render).not.toHaveBeenCalled();
  });

  it("extracts an image wrapped in nested document structure tags", async () => {
    const fake = page(
      [OPS.beginMarkedContentProps, OPS.beginMarkedContent, OPS.save,
        OPS.transform, OPS.dependency, OPS.paintImageXObject,
        OPS.restore, OPS.endMarkedContent, OPS.endMarkedContent],
      [["Part", 0], ["Figure"], [], [100, 0, 0, 100, 0, 0], ["img"], ["img"], [], [], []],
      { width: 400, height: 400 },
    );
    const result = await loadPageImage(fake as never, "extract");
    expect(result).toMatchObject({ modeUsed: "extract", sourceWidth: 400, sourceHeight: 400, dpiX: 288, dpiY: 288 });
    expect(result.canvas).toMatchObject({ width: 400, height: 400 });
    expect(result.reason).toBeUndefined();
    expect(fake.render).not.toHaveBeenCalled();
  });

  it("ignores optional-content visibility when extracting the scan", async () => {
    const fake = page(
      [OPS.beginMarkedContentProps, OPS.transform, OPS.paintImageXObject, OPS.endMarkedContent],
      [["OC", { id: "layer" }], [100, 0, 0, 100, 0, 0], ["img"], []],
      { width: 400, height: 400 },
    );
    const result = await loadPageImage(fake as never, "extract");
    expect(result.modeUsed).toBe("extract");
    expect(result.pdfToSource).toEqual([4, 0, 0, -4, 0, 400]);
    expect(fake.render).not.toHaveBeenCalled();
  });

  it("ignores visible vector drawing instructions outside the extracted scan", async () => {
    const fake = page(
      [OPS.beginMarkedContentProps, OPS.transform, OPS.paintImageXObject, OPS.stroke, OPS.endMarkedContent],
      [["Part", 0], [100, 0, 0, 100, 0, 0], ["img"], [], []],
      { width: 400, height: 400 },
    );
    const result = await loadPageImage(fake as never, "extract");
    expect(result.modeUsed).toBe("extract");
    expect(fake.render).not.toHaveBeenCalled();
  });

  it("extracts the full-page scan inside a transformed Form while ignoring text and footer paths", async () => {
    const fake=page(
      [OPS.beginText,OPS.moveText,OPS.endText,OPS.paintFormXObjectBegin,OPS.transform,OPS.paintImageXObject,
       OPS.paintFormXObjectEnd,OPS.beginText,OPS.setTextRenderingMode,OPS.showText,OPS.endText,
       OPS.constructPath,OPS.stroke,OPS.beginAnnotation,OPS.transform,OPS.paintImageXObject,OPS.endAnnotation],
      [[],[36,90],[],[[0.5,0,0,0.5,0,0],[0,0,200,200]],[200,0,0,200,0,0],["img"],[],
       [],[3],[[{unicode:"OCR"}]],[],[[OPS.moveTo,OPS.lineTo],[0,0,10,10],[0,0,10,10]],[],[],
       [100,0,0,100,0,0],["annotation-img"],[]], {width:400,height:400});
    const result=await loadPageImage(fake as never,"extract");
    expect(result).toMatchObject({modeUsed:"extract",sourceWidth:400,dpiX:288,pdfToSource:[4,0,0,-4,0,400]});
    expect(fake.render).not.toHaveBeenCalled();
    expect(fake.objs.get).toHaveBeenCalledTimes(1);
  });
  it("renders for an additional image regardless of its size or drawing order", async () => {
    for (const size of [1, 10, 100]) for (const scanFirst of [true, false]) {
      const sizes = scanFirst ? [100, size] : [size, 100];
      const fake = page(
        [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore, OPS.transform, OPS.paintImageXObject],
        [[], [sizes[0], 0, 0, sizes[0], 0, 0], ["first"], [], [sizes[1], 0, 0, sizes[1], 0, 0], ["second"]],
        { width: 100, height: 100 },
      );
      const result = await loadPageImage(fake as never, "extract");
      expect(result).toMatchObject({ modeUsed: "render", dpiX: 300 });
      expect(result.reason).toContain("Multiple");
      expect(fake.objs.get).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it("ignores extra images outside the page or completely clipped away", async () => {
    for (const clipped of [false, true]) {
      const fake = page(
        [OPS.save, OPS.constructPath, OPS.clip, OPS.endPath, OPS.transform, OPS.paintImageXObject,
          OPS.restore, OPS.transform, OPS.paintImageXObject],
        [[], [[OPS.rectangle], [0, 0, 100, 100], [0, 0, 100, 100]], [], [],
          [10, 0, 0, 10, 200, 200], ["outside"], [], [100, 0, 0, 100, 0, 0], ["scan"]],
        { width: 100, height: 100 },
      );
      if (clipped) fake.getOperatorList.mockResolvedValue({
        fnArray: [OPS.save, OPS.constructPath, OPS.clip, OPS.endPath, OPS.transform, OPS.paintImageXObject,
          OPS.restore, OPS.transform, OPS.paintImageXObject],
        argsArray: [[], [[OPS.rectangle], [0, 0, 50, 100], [0, 0, 50, 100]], [], [],
          [10, 0, 0, 10, 70, 0], ["clipped"], [], [100, 0, 0, 100, 0, 0], ["scan"]],
      });
      expect((await loadPageImage(fake as never, "extract")).modeUsed).toBe("extract");
      expect(fake.objs.get).toHaveBeenCalledTimes(1);
      expect(fake.render).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });
  it("does not let an unsupported clipping path in a separate saved scope block a later scan", async () => {
    const fake=page([OPS.save,OPS.constructPath,OPS.clip,OPS.restore,OPS.transform,OPS.paintImageXObject],
      [[],[[OPS.moveTo,OPS.lineTo],[0,0,1,1],[0,0,1,1]],[],[],[100,0,0,100,0,0],["img"]],{width:100,height:100});
    expect((await loadPageImage(fake as never,"extract")).modeUsed).toBe("extract");
  });
  it("counts repeated full-page image placements as multiple candidates", async () => {
    const fake=page([OPS.paintImageXObjectRepeat],[["img",100,100,[0,0,0,0]]],{width:100,height:100});
    expect((await loadPageImage(fake as never,"extract")).modeUsed).toBe("render");
  });

  it("uses transparency-group bounds without applying its matrix twice to child drawing", async () => {
    const fake = page(
      [OPS.beginGroup, OPS.paintFormXObjectBegin, OPS.transform, OPS.paintImageXObject, OPS.paintFormXObjectEnd, OPS.endGroup],
      [[{ matrix: [0.5, 0, 0, 0.5, 0, 0], bbox: [0, 0, 200, 200] }],
        [[0.5, 0, 0, 0.5, 0, 0], [0, 0, 200, 200]], [200, 0, 0, 200, 0, 0], ["scan"], [], []],
      { width: 400, height: 400 },
    );
    const result = await loadPageImage(fake as never, "extract");
    expect(result).toMatchObject({ modeUsed: "extract", pdfToSource: [4, 0, 0, -4, 0, 400] });
    expect(fake.context.rect).toHaveBeenCalledWith(0, 0, 100, 100);
    expect(fake.render).not.toHaveBeenCalled();
  });

  it("extracts a full-page image from an inline-image atlas using the patch resolution", async () => {
    const atlas = { width: 500, height: 400, bitmap: {} };
    const fake = page([OPS.paintInlineImageXObjectGroup], [[atlas, [
      { transform: [10, 0, 0, 10, 200, 200], x: 0, y: 0, w: 100, h: 100 },
      { transform: [100, 0, 0, 100, 0, 0], x: 100, y: 0, w: 400, h: 400 },
    ]]]);
    const result = await loadPageImage(fake as never, "extract");
    expect(result).toMatchObject({ modeUsed: "extract", sourceWidth: 400, sourceHeight: 400, dpiX: 288 });
    expect(fake.context.drawImage).toHaveBeenCalledWith(atlas.bitmap, 100, 0, 400, 400, 0, 0, 400, 400);
    expect(fake.render).not.toHaveBeenCalled();
  });

  it("renders when clipping reduces a full-page image below the coverage threshold", async () => {
    const fake = page(
      [OPS.constructPath, OPS.clip, OPS.endPath, OPS.transform, OPS.paintImageXObject],
      [[[OPS.rectangle], [0, 0, 90, 100], [0, 0, 90, 100]], [], [], [100, 0, 0, 100, 0, 0], ["scan"]],
      { width: 400, height: 400 },
    );
    const result = await loadPageImage(fake as never, "extract");
    expect(result).toMatchObject({ modeUsed: "render", dpiX: 300 });
    expect(fake.objs.get).not.toHaveBeenCalled();
  });

  it("renders a page containing only a small embedded image", async () => {
    const fake = page([OPS.transform, OPS.paintImageXObject], [[10, 0, 0, 10, 0, 0], ["logo"]], { width: 400, height: 400 });
    const result = await loadPageImage(fake as never, "extract");
    expect(result).toMatchObject({ modeUsed: "render", dpiX: 300 });
    expect(fake.objs.get).not.toHaveBeenCalled();
  });

  it("restores packed monochrome pixels including row padding without inversion", async () => {
    const fake = page(
      [OPS.transform, OPS.paintImageXObject],
      [[100, 0, 0, 100, 0, 0], ["img"]],
      { width: 9, height: 2, kind: ImageKind.GRAYSCALE_1BPP, data: new Uint8Array([0xaa, 0x80, 0x55, 0]) },
    );
    const result = await loadPageImage(fake as never, "extract");
    expect(result.modeUsed).toBe("extract");
    expect(result.canvas).toMatchObject({ width: 9, height: 2 });
    const uploaded = vi.mocked(fake.context.putImageData).mock.calls[0][0];
    const pixels = Array.from(uploaded.data);
    expect(pixels.filter((_, i) => i % 4 === 0)).toEqual([
      255, 0, 255, 0, 255, 0, 255, 0, 255,
      0, 255, 0, 255, 0, 255, 0, 255, 0,
    ]);
    expect(pixels.filter((_, i) => i % 4 === 3).every(alpha => alpha === 255)).toBe(true);
    expect(fake.render).not.toHaveBeenCalled();
  });

  it("restores RGB pixels as opaque RGBA", async () => {
    const fake = page(
      [OPS.transform, OPS.paintImageXObject],
      [[100, 0, 0, 100, 0, 0], ["img"]],
      { width: 2, height: 1, kind: ImageKind.RGB_24BPP, data: new Uint8Array([255, 0, 0, 0, 128, 255]) },
    );
    expect((await loadPageImage(fake as never, "extract")).modeUsed).toBe("extract");
    expect(Array.from(vi.mocked(fake.context.putImageData).mock.calls[0][0].data)).toEqual([255, 0, 0, 255, 0, 128, 255, 255]);
  });

  it("renders instead of decoding a truncated packed image", async () => {
    const fake = page(
      [OPS.transform, OPS.paintImageXObject],
      [[100, 0, 0, 100, 0, 0], ["img"]],
      { width: 9, height: 2, kind: ImageKind.GRAYSCALE_1BPP, data: new Uint8Array([0xaa, 0x80, 0x55]) },
    );
    expect((await loadPageImage(fake as never, "extract")).modeUsed).toBe("render");
  });

  it("retains the exact viewport mapping including PDF rotation, UserUnit, box origin and fractional canvas edges", async () => {
    const fake = page([], [], undefined);
    const transform = [0, 2, 2, 0, -40, -20];
    fake.getViewport.mockReturnValue({ width: 200.2, height: 300.2, transform });
    const result = await loadPageImage(fake as never, "render", 144);
    expect(result.pdfToSource).toEqual(transform);
    expect(result.canvas).toMatchObject({ width: 201, height: 301 });
    // Canvas ceil adds white edge pixels, not a rescale of viewport coordinates.
    expect(fake.render).toHaveBeenCalled();
  });

  it("falls back safely when no dominant embedded image exists", async () => {
    const fake = page([], [], undefined);
    const result = await loadPageImage(fake as never, "extract", 72);
    expect(result.modeUsed).toBe("render");
    expect(result.dpiX).toBe(300);
    expect(result.reason).toContain("image");
    expect(fake.render).toHaveBeenCalled();
  });

  it("falls back for a non-rectangular clipping path instead of extracting a misleading bounding box", async () => {
    const fake = page(
      [
        OPS.constructPath,
        OPS.eoClip,
        OPS.endPath,
        OPS.transform,
        OPS.paintImageXObject,
      ],
      [
        [
          [OPS.moveTo, OPS.lineTo, OPS.lineTo, OPS.lineTo, OPS.closePath],
          [0, 0, 100, 0, 50, 100, 0, 0],
          [0, 0, 100, 100],
        ],
        [],
        [],
        [72, 0, 0, 72, 0, 0],
        ["img"],
      ],
      { width: 100, height: 100 },
    );
    const result = await loadPageImage(fake as never, "extract");
    expect(result.modeUsed).toBe("render");
  });
});

