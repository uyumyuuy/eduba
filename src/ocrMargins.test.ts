import { describe, expect, it, vi } from "vitest";
import {
  defaultOcrMargins,
  maskOcrCanvas,
  resolveOcrMargins,
  validateOcrMargins,
} from "./ocrMargins";

function canvas(width = 200, height = 100) {
  const context = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: "",
  } as unknown as CanvasRenderingContext2D;
  const output = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
  const source = {
    width,
    height,
    ownerDocument: { createElement: vi.fn(() => output) },
  } as unknown as HTMLCanvasElement;
  return { source, output, context };
}

describe("OCR exclusion margins", () => {
  it("maps outer and inner margins asymmetrically for spread sides", () => {
    const margins = {
      ...defaultOcrMargins,
      outer: 12,
      inner: 4,
      top: 3,
      bottom: 5,
    };
    expect(resolveOcrMargins(margins, "left")).toEqual({
      top: 3,
      bottom: 5,
      left: 12,
      right: 4,
    });
    expect(resolveOcrMargins(margins, "right")).toEqual({
      top: 3,
      bottom: 5,
      left: 4,
      right: 12,
    });
    expect(
      resolveOcrMargins({ ...margins, left: 7, right: 8 }, "single"),
    ).toEqual({ top: 3, bottom: 5, left: 7, right: 8 });
  });

  it("masks only an OCR copy and preserves the full coordinate frame", () => {
    const { source, output, context } = canvas(201, 101);
    const result = maskOcrCanvas(source, "left", {
      ...defaultOcrMargins,
      top: 10,
      bottom: 20,
      outer: 15,
      inner: 5,
    });
    expect(result).toBe(output);
    expect(source.width).toBe(201);
    expect(source.height).toBe(101);
    expect(output.width).toBe(201);
    expect(output.height).toBe(101);
    expect(context.drawImage).toHaveBeenCalledWith(source, 0, 0);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 201, 11);
    expect(context.fillRect).toHaveBeenCalledWith(0, 80, 201, 21);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 31, 101);
    expect(context.fillRect).toHaveBeenCalledWith(190, 0, 11, 101);
  });

  it("rejects margins that remove the whole active dimension", () => {
    expect(() =>
      validateOcrMargins({ ...defaultOcrMargins, left: 50, right: 50 }, false),
    ).toThrow();
    expect(() =>
      validateOcrMargins({ ...defaultOcrMargins, top: Number.NaN }),
    ).toThrow();
  });
});
