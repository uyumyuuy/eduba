// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourcePageThumbnailCache } from "./pdfThumbnail";

const contexts: CanvasRenderingContext2D[] = [];

function page(render: () => Promise<void> = async () => undefined) {
  return {
    getViewport: ({ scale }: { scale: number }) => ({ width: 200 * scale, height: 300 * scale }),
    render: vi.fn(() => ({ promise: render() })),
  };
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
    const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    contexts.push(context);
    return context;
  });
});

afterEach(() => {
  contexts.splice(0);
  vi.restoreAllMocks();
});

describe("SourcePageThumbnailCache", () => {
  it("renders a source page only once when split logical pages request it", async () => {
    const source = page();
    const pdf = { getPage: vi.fn(async () => source) };
    const cache = new SourcePageThumbnailCache(pdf as never);

    const [left, right] = await Promise.all([cache.get(1), cache.get(1)]);

    expect(left).toBe(right);
    expect(pdf.getPage).toHaveBeenCalledTimes(1);
    expect(source.render).toHaveBeenCalledTimes(1);
  });

  it("limits PDF rendering to two concurrent thumbnails", async () => {
    const complete: Array<() => void> = [];
    const pdf = { getPage: vi.fn(async () => page(() => new Promise<void>(resolve => complete.push(resolve)))) };
    const cache = new SourcePageThumbnailCache(pdf as never, 48, 2);
    const first = cache.get(1);
    const second = cache.get(2);
    const third = cache.get(3);

    await vi.waitFor(() => expect(pdf.getPage).toHaveBeenCalledTimes(2));
    complete.splice(0).forEach(resolve => resolve());
    await vi.waitFor(() => expect(pdf.getPage).toHaveBeenCalledTimes(3));
    complete.splice(0).forEach(resolve => resolve());
    await Promise.all([first, second, third]);
  });

  it("keeps an evicted canvas usable by an already-resolved caller", async () => {
    const pdf = { getPage: vi.fn(async () => page()) };
    const cache = new SourcePageThumbnailCache(pdf as never, 1);
    const first = await cache.get(1);
    await cache.get(2);

    expect(first.width).toBeGreaterThan(0);
    expect(first.height).toBeGreaterThan(0);
  });
  it("cancels queued work when the cache is disposed", async () => {
    let release!: () => void;
    const pdf = { getPage: vi.fn(async () => page(() => new Promise<void>(resolve => { release = resolve; }))) };
    const cache = new SourcePageThumbnailCache(pdf as never, 48, 1);
    const first = cache.get(1);
    const queued = cache.get(2);

    await vi.waitFor(() => expect(pdf.getPage).toHaveBeenCalledTimes(1));
    cache.dispose();
    await expect(queued).rejects.toThrow("disposed");
    expect(pdf.getPage).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});
