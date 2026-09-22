import type { PDFDocumentProxy } from "pdfjs-dist";

type CachedThumbnail = { promise: Promise<HTMLCanvasElement>; canvas?: HTMLCanvasElement };

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
