// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPS } from "pdfjs-dist";
import { loadPageImage } from "./pageImage";

function page(
  ops: number[],
  args: unknown[][],
  image?: { width: number; height: number },
) {
  const context = {
    fillRect: vi.fn(),
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
          bitmap: image as unknown as CanvasImageSource,
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

  it("falls back safely when no dominant embedded image exists", async () => {
    const fake = page([], [], undefined);
    const result = await loadPageImage(fake as never, "extract", 72);
    expect(result.modeUsed).toBe("render");
    expect(result.dpiX).toBe(300);
    expect(result.reason).toContain("画像");
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

