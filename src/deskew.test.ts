import { describe, expect, it } from "vitest";
import { estimateSkew, estimateSkewAngle } from "./deskew";

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
  it("does not rotate a page of long diagonal illustration strokes", () => {
    const image = textLines(0);
    image.data.fill(255);
    for (let row = 50; row < image.height - 50; row += 25)
      for (let x = 30; x < image.width - 30; x++)
        for (let thickness = 0; thickness < 3; thickness++) {
          const y = Math.round(row + x * Math.tan(3 * Math.PI / 180)) + thickness;
          const offset = (y * image.width + x) * 4;
          image.data.fill(0, offset, offset + 3);
        }
    expect(estimateSkewAngle(image)).toBe(0);
  });

  it("does not use just two caption lines as evidence for a whole illustration page", () => {
    const image = textLines(2);
    for (let y = 130; y < image.height; y++)
      image.data.fill(255, y * image.width * 4, (y + 1) * image.width * 4);
    expect(estimateSkewAngle(image)).toBe(0);
  });

  it("rejects equally sized text regions with conflicting slopes", () => {
    const image = textLines(2);
    const other = textLines(-2);
    image.data.set(other.data.slice(image.width * 300 * 4), image.width * 300 * 4);
    expect(estimateSkewAngle(image)).toBe(0);
  });

  it("retains text correction when large diagonal drawing strokes are present", () => {
    const image = textLines(1.2);
    for (let row = 450; row < 555; row += 15)
      for (let x = 30; x < image.width - 30; x++)
        for (let thickness = 0; thickness < 3; thickness++) {
          const y = Math.round(row - x * Math.tan(3 * Math.PI / 180)) + thickness;
          const offset = (y * image.width + x) * 4;
          image.data.fill(0, offset, offset + 3);
        }
    expect(estimateSkewAngle(image)).toBeCloseTo(-1.2, 1);
  });

  it("distinguishes reliable horizontal text from insufficient text and conflicting directions", () => {
    expect(estimateSkew(textLines(0))).toEqual({ angle: 0, status: "aligned" });
    const blank = textLines(0);
    blank.data.fill(255);
    expect(estimateSkew(blank)).toEqual({ angle: 0, status: "insufficient-text" });
    const conflicting = textLines(2), other = textLines(-2);
    conflicting.data.set(other.data.slice(conflicting.width * 300 * 4), conflicting.width * 300 * 4);
    expect(estimateSkew(conflicting)).toEqual({ angle: 0, status: "inconsistent-lines" });
    expect(estimateSkew(textLines(1.2))).toEqual({ angle: -1.2, status: "corrected" });
  });

});
