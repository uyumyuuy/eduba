import { describe, expect, it } from "vitest";
import { overlayPosition } from "./overlayPosition";

const bounds = { left: 8, top: 8, right: 392, bottom: 292 };
describe("overlay placement around the editor", () => {
  it("moves below the editing line near the top instead of covering it", () => {
    expect(overlayPosition(bounds, { left: 20, top: -60 }, 250, 60, [
      { left: 20, top: 12, right: 360, bottom: 40 },
      { left: 20, top: 48, right: 360, bottom: 78 },
    ])).toEqual({ left: 20, top: 86 });
  });
  it("moves above the editing line near the bottom", () => {
    expect(overlayPosition(bounds, { left: 300, top: 280 }, 250, 60, [
      { left: 20, top: 250, right: 380, bottom: 280 },
    ])).toEqual({ left: 142, top: 182 });
  });
  it("hides the overlay when no space can avoid the editor", () => {
    expect(overlayPosition(bounds, { left: 20, top: 8 }, 250, 60, [bounds])).toBeNull();
  });
});
