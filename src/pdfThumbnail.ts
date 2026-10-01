import type { PDFDocumentProxy } from "pdfjs-dist";

type CachedThumbnail = { promise: Promise<HTMLCanvasElement>; canvas?: HTMLCanvasElement };
const sourceScales = new WeakMap<HTMLCanvasElement, number>();

/**
 * A small, bounded cache for raw PDF-page thumbnails.  It deliberately works
 * from the PDF page rather than the OCR canvas: logical spread halves can
 * therefore share the same source-page image.
 */
export class SourcePageThumbnailCache {
  private readonly entries = new Map<number, CachedThumbnail>();
  private readonly pending: Array<() => void> = [];
  private running = 0;
  private disposed = false;

  constructor(
    private readonly pdf: Pick<PDFDocumentProxy, "getPage">,
    private readonly maximumEntries = 48,
    private readonly maximumConcurrentRenders = 2,
  ) {}

  get(sourcePage: number): Promise<HTMLCanvasElement> {
    if (this.disposed) return Promise.reject(new Error("Thumbnail cache was disposed."));
    const existing = this.entries.get(sourcePage);
    if (existing) {
      // Map insertion order is our LRU order.
      this.entries.delete(sourcePage);
      this.entries.set(sourcePage, existing);
      return existing.promise;
    }

    const entry: CachedThumbnail = { promise: Promise.resolve(document.createElement("canvas")) };
    entry.promise = this.schedule(async () => {
      const page = await this.pdf.getPage(sourcePage);
      const full = page.getViewport({ scale: 1 });
      const scale = Math.min(112 / full.width, 140 / full.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not create thumbnail canvas.");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      sourceScales.set(canvas, scale);
      entry.canvas = canvas;
      return canvas;
    });
    this.entries.set(sourcePage, entry);
    void entry.promise.then(() => this.trim(), () => this.entries.delete(sourcePage));
    return entry.promise;
  }

  dispose(): void {
    this.disposed = true;
    this.pending.splice(0).forEach(resolve => resolve());
    this.entries.forEach(entry => {
      if (entry.canvas) {
        entry.canvas.width = 0;
        entry.canvas.height = 0;
      }
    });
    this.entries.clear();
  }

  private schedule<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        if (this.disposed) {
          reject(new Error("Thumbnail cache was disposed."));
          return;
        }
        this.running += 1;
        work().then(resolve, reject).finally(() => {
          this.running -= 1;
          this.pending.shift()?.();
        });
      };
      if (this.running < this.maximumConcurrentRenders) run();
      else this.pending.push(run);
    });
  }

  private trim(): void {
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.entries().next().value as [number, CachedThumbnail] | undefined;
      if (!oldest) return;
      const [sourcePage, entry] = oldest;
      // Keep a pending entry: its work is already in the bounded queue and it
      // may be requested again before it completes.
      if (!entry.canvas) return;
      // Consumers may still be copying this canvas after its promise resolves.
      // Removing it from the cache is sufficient; do not blank their image.
      this.entries.delete(sourcePage);
    }
  }
}


/**
 * Bounded cache for the logical pages shown in the page list. Source PDF
 * renders remain in SourcePageThumbnailCache, so spread halves and different
 * logical transformations of one source page never render the PDF twice.
 */
export type LogicalThumbnail = {
  sourcePage: number;
  rotation: number;
  /** The deskew angle that was recorded while the page was imported. */
  angle: number;
  preprocessOrder?: "split-deskew" | "deskew-split";
  split: "single" | "left" | "right";
  crop?: { left: number; top: number; right: number; bottom: number };
  /** Native source resolution, used to scale persisted crop coordinates. */
  sourceDpiX?: number;
  sourceDpiY?: number;
  /** Render DPI before a page has been processed and its source DPI recorded. */
  dpi?: number;
};

export class LogicalPageThumbnailCache {
  private readonly source: SourcePageThumbnailCache;
  private readonly entries = new Map<string, CachedThumbnail>();
  private disposed = false;

  constructor(
    pdf: Pick<PDFDocumentProxy, "getPage">,
    sourceMaximumEntries = 48,
    private readonly maximumEntries = 96,
    maximumConcurrentRenders = 2,
  ) {
    this.source = new SourcePageThumbnailCache(pdf, sourceMaximumEntries, maximumConcurrentRenders);
  }

  get(page: LogicalThumbnail): Promise<HTMLCanvasElement> {
    if (this.disposed) return Promise.reject(new Error("Thumbnail cache was disposed."));
    const key = logicalThumbnailKey(page);
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.promise;
    }
    const entry: CachedThumbnail = { promise: Promise.resolve(document.createElement("canvas")) };
    entry.promise = this.source.get(page.sourcePage).then(source => {
      if (this.disposed) throw new Error("Thumbnail cache was disposed.");
      const canvas = transformThumbnail(source, page);
      entry.canvas = canvas;
      return canvas;
    });
    this.entries.set(key, entry);
    void entry.promise.then(() => this.trim(), () => this.entries.delete(key));
    return entry.promise;
  }

  dispose(): void {
    this.disposed = true;
    this.source.dispose();
    this.entries.clear();
  }

  private trim(): void {
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.entries().next().value as [string, CachedThumbnail] | undefined;
      if (!oldest || !oldest[1].canvas) return;
      this.entries.delete(oldest[0]);
    }
  }
}

function logicalThumbnailKey(page: LogicalThumbnail): string {
  const crop = page.crop;
  return [
    page.sourcePage,
    page.rotation,
    page.angle,
    page.preprocessOrder ?? "deskew-split",
    page.split,
    crop?.left ?? "",
    crop?.top ?? "",
    crop?.right ?? "",
    crop?.bottom ?? "",
    page.sourceDpiX ?? "",
    page.sourceDpiY ?? "",
    page.dpi ?? "",
  ].join(":");
}

function canvas(width: number, height: number): HTMLCanvasElement {
  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.round(width));
  output.height = Math.max(1, Math.round(height));
  return output;
}

function rotate(source: HTMLCanvasElement, degrees: number, expand = false): HTMLCanvasElement {
  const normalized = ((degrees % 360) + 360) % 360;
  const sideways = normalized === 90 || normalized === 270;
  const radians = degrees * Math.PI / 180;
  const output = canvas(
    expand ? Math.ceil(Math.abs(source.width * Math.cos(radians)) + Math.abs(source.height * Math.sin(radians))) : sideways ? source.height : source.width,
    expand ? Math.ceil(Math.abs(source.height * Math.cos(radians)) + Math.abs(source.width * Math.sin(radians))) : sideways ? source.width : source.height,
  );
  const context = output.getContext("2d");
  if (!context) throw new Error("Could not create thumbnail canvas.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, output.width, output.height);
  context.translate(output.width / 2, output.height / 2);
  context.rotate((normalized * Math.PI) / 180);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return output;
}

function crop(source: HTMLCanvasElement, left: number, top: number, right: number, bottom: number): HTMLCanvasElement {
  const x1 = Math.max(0, Math.floor(left));
  const y1 = Math.max(0, Math.floor(top));
  const x2 = Math.min(source.width, Math.ceil(right));
  const y2 = Math.min(source.height, Math.ceil(bottom));
  if (x2 <= x1 || y2 <= y1) return source;
  const output = canvas(x2 - x1, y2 - y1);
  const context = output.getContext("2d");
  if (!context) throw new Error("Could not create thumbnail canvas.");
  context.drawImage(source, x1, y1, x2 - x1, y2 - y1, 0, 0, output.width, output.height);
  return output;
}

function transformThumbnail(source: HTMLCanvasElement, page: LogicalThumbnail): HTMLCanvasElement {
  // Match the persisted preprocessing order, then crop. The source
  // thumbnail is rendered at PDF points (72 DPI), while saved crop rectangles
  // use the imported image's pixels, so scale the latter before applying it.
  let working = rotate(source, page.rotation);
  const perPage = page.preprocessOrder === "split-deskew";
  if (page.angle && !perPage) working = rotate(working, page.angle);
  const normalized = ((page.rotation % 360) + 360) % 360;
  const sideways = normalized === 90 || normalized === 270;
  const fallbackDpi = page.dpi ?? 300;
  const dpiX = page.sourceDpiX ?? fallbackDpi;
  const dpiY = page.sourceDpiY ?? fallbackDpi;
  const thumbnailScale = sourceScales.get(source) ?? 1;
  const scaleX = thumbnailScale * 72 / (sideways && !perPage ? dpiY : dpiX);
  const scaleY = thumbnailScale * 72 / (sideways && !perPage ? dpiX : dpiY);

  if (page.split !== "single") {
    const half = Math.floor(working.width / 2);
    working = page.split === "left"
      ? crop(working, 0, 0, half, working.height)
      : crop(working, half, 0, working.width, working.height);
  }
  if (page.angle && perPage) working = rotate(working, page.angle, true);
  if (!page.crop) return working;
  return crop(
    working,
    page.crop.left * scaleX,
    page.crop.top * scaleY,
    page.crop.right * scaleX,
    page.crop.bottom * scaleY,
  );
}
