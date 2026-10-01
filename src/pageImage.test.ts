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

  it("preserves rendering fallback for optional-content groups that may hide images", async () => {
    const fake = page(
      [OPS.beginMarkedContentProps, OPS.transform, OPS.paintImageXObject, OPS.endMarkedContent],
      [["OC", { id: "layer" }], [100, 0, 0, 100, 0, 0], ["img"], []],
      { width: 400, height: 400 },
    );
    const result = await loadPageImage(fake as never, "extract");
    expect(result.modeUsed).toBe("render");
    expect(fake.render).toHaveBeenCalled();
  });

  it("still renders visible drawing instructions inside structure tags", async () => {
    const fake = page(
      [OPS.beginMarkedContentProps, OPS.transform, OPS.paintImageXObject, OPS.stroke, OPS.endMarkedContent],
      [["Part", 0], [100, 0, 0, 100, 0, 0], ["img"], [], []],
      { width: 400, height: 400 },
    );
    const result = await loadPageImage(fake as never, "extract");
    expect(result.modeUsed).toBe("render");
    expect(fake.render).toHaveBeenCalled();
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

