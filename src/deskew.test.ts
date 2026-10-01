import { describe, expect, it } from "vitest";
import { estimateSkewAngle } from "./deskew";

function textLines(angle: number, width = 500, height = 600) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const slope = Math.tan(angle * Math.PI / 180);
  // Broken horizontal text strokes, rather than a single dominant scan border.
  for (let row = 75; row < height - 75; row += 24) {
    for (let x = 45; x < width - 45; x++) {
      if (x % 13 > 8) continue;
      for (let thickness = 0; thickness < 3; thickness++) {
        const y = Math.round(row + (x - width / 2) * slope) + thickness;
        data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
      }
    }
  }
  return { width, height, data };
}
describe("skew angle estimation", () => {
  it.each([-2.3, -0.7, 0, 1.2, 3.4])("corrects %s degree text lines", angle => {
    expect(estimateSkewAngle(textLines(angle))).toBeCloseTo(-angle, 1);
  });
  it("leaves blank, sparse, and predominantly dark images unchanged", () => {
    const white = textLines(0);
    white.data.fill(255);
    expect(estimateSkewAngle(white)).toBe(0);
    white.data.fill(0, 0, 80);
    expect(estimateSkewAngle(white)).toBe(0);
    white.data.fill(0);
    expect(estimateSkewAngle(white)).toBe(0);
  });
  it("ignores dark scan edges", () => {
    const image = textLines(1.2);
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < 10; x++) image.data.fill(0, (y * image.width + x) * 4, (y * image.width + x) * 4 + 3);
    expect(estimateSkewAngle(image)).toBeCloseTo(-1.2, 1);
  });
  it("honours the configured search limit", () => {
    expect(Math.abs(estimateSkewAngle(textLines(3), 1))).toBeLessThanOrEqual(1);
    expect(estimateSkewAngle(textLines(3), 0)).toBe(0);
  });
});
