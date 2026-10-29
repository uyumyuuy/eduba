import { describe, it, expect } from "vitest";
import { figureTensor, decodeFigures, styleCrop, styleTensor, stylePrediction } from "./inference";

describe("browser ONNX preprocessing", () => {
  it("uses the desktop figure RGB normalization and excludes tables/duplicates", () => {
    const tensor = figureTensor({ width: 1, height: 1, data: Uint8ClampedArray.of(255, 0, 0, 255) });
    expect(tensor[0]).toBeCloseTo((1 - 0.485) / 0.229, 4);
    expect(tensor[480 * 480]).toBeCloseTo(-0.456 / 0.224, 4);
    expect(decodeFigures([0, 0.9, 10, 20, 100, 150, 0, 0.6, 5, 15, 105, 155, 1, 0.99, 110, 20, 180, 150, 2, 0.8, 130, 30, 180, 80], 200, 200)).toHaveLength(2);
  });
  it("clamps padded word samples to the line and centers them on white", () => {
    const box = { left: 10, top: 10, right: 20, bottom: 20 };
    const crop = styleCrop({ bbox: box, lineBbox: box, text: "A" }, 30, 30);
    expect(crop).toEqual(box);
    const pixels = { width: 30, height: 30, data: new Uint8ClampedArray(30 * 30 * 4) };
    const tensor = styleTensor(pixels, crop);
    expect(tensor[0]).toBe(1);
    expect(tensor[16 * 128 + 64]).toBe(0);
    expect(() => styleCrop({ bbox: box, lineBbox: { ...box, left: 11 }, text: "A" }, 30, 30)).toThrow("inside");
  });
  it("uses the single Unicode letter italic threshold and fixed bold threshold", () => {
    expect(stylePrediction(2, 4, "𒀀").italic).toBe(true);
    expect(stylePrediction(2, 4, "word").italic).toBe(false);
    expect(stylePrediction(2, 4, "a\u0301").italic).toBe(false);
    expect(stylePrediction(2, 4, "word").bold).toBe(true);
  });
});
