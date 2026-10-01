// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { processCanvas } from "./domain";
import { estimateSkew } from "./deskew";
vi.mock("./deskew", () => ({ estimateSkew: vi.fn() }));

let contexts: { owner: HTMLCanvasElement; rotate: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn>; getImageData: ReturnType<typeof vi.fn> }[];
beforeEach(() => {
  contexts = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function(this: HTMLCanvasElement) {
    const context = { owner: this, fillRect: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ width: this.width, height: this.height, data: new Uint8ClampedArray() })) };
    contexts.push(context);
    return context as never;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.mocked(estimateSkew).mockReset(); });
const spread = () => Object.assign(document.createElement("canvas"), { width: 1001, height: 800 });

describe("logical page preprocessing", () => {
  it("estimates each half independently after orientation, expands without clipping, and applies crop last", () => {
    vi.mocked(estimateSkew).mockReturnValueOnce({ angle: -1.2, status: "corrected" }).mockReturnValueOnce({ angle: 0.4, status: "corrected" });
    const result = processCanvas(spread(), { split: "both", deskew: true, sourcePage: 7 });
    expect(vi.mocked(estimateSkew).mock.calls.map(([image]) => [image.width, image.height])).toEqual([[500, 800], [501, 800]]);
    expect(result.pages.map(page => page.provenance.angle)).toEqual([-1.2, 0.4]);
    expect(result.pages.map(page => [page.canvas.width, page.canvas.height])).toEqual([[517, 811], [507, 804]]);
    const cropped = processCanvas(spread(), { split: "right", deskewAngle: 0.4, crop: { left: 10, top: 20, right: 100, bottom: 200 } });
    expect(cropped.pages[0].canvas).toMatchObject({ width: 90, height: 180 });
    expect(cropped.pages[0].provenance).toMatchObject({ angle: 0.4, split: "right", preprocessOrder: "split-deskew" });
  });
  it("applies a saved angle exactly without running estimation", () => {
    const result = processCanvas(spread(), { split: "left", deskewAngle: -1.3 });
    expect(estimateSkew).not.toHaveBeenCalled();
    expect(contexts.flatMap(context => context.rotate.mock.calls).some(([angle]) => angle === 358.7 * Math.PI / 180)).toBe(true);
    expect(result.pages[0].provenance.angle).toBe(-1.3);
  });
  it("preserves legacy deskew-before-split dimensions and coordinates", () => {
    const result = processCanvas(spread(), { split: "right", deskewAngle: -1.3, preprocessOrder: "deskew-split" });
    expect(result.pages[0].canvas).toMatchObject({ width: 501, height: 800 });
    expect(estimateSkew).not.toHaveBeenCalled();
  });
  it("rotates before splitting and leaves deskew disabled at zero", () => {
    const result = processCanvas(spread(), { rotation: 90, split: "both", deskew: false });
    expect(result.pages.map(page => [page.canvas.width, page.canvas.height, page.provenance.angle])).toEqual([[400, 1001, 0], [400, 1001, 0]]);
    expect(estimateSkew).not.toHaveBeenCalled();
  });
});
