import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { invokeCommand } from "./tauri";

GlobalWorkerOptions.workerSrc = workerUrl;

function decodeBase64(value: string): Uint8Array {
  const clean = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class ProjectRangeTransport extends PDFDataRangeTransport {
  rangeError: unknown;
  private onFailure?: (error: unknown) => void;
  constructor(length: number, private readonly projectPath: string) {
    super(length, new Uint8Array(), false);
  }

  setFailureHandler(handler: (error: unknown) => void): void { this.onFailure = handler; }

  override requestDataRange(begin: number, end: number): void {
    invokeCommand("read_pdf_range", { projectPath: this.projectPath, begin, end })
      .then((base64) => this.onDataRange(begin, decodeBase64(base64)))
      .catch((error) => {
        // Tell the owning loading task to abort. An empty byte range alone
        // can leave PDF.js waiting for more data indefinitely.
        this.rangeError = error;
        this.onFailure?.(error);
      });
  }
}

export async function openProjectPdf(projectPath: string, pdfSize: number): Promise<PDFDocumentProxy> {
  const transport = new ProjectRangeTransport(pdfSize, projectPath);
  const task = getDocument({
    range: transport,
    length: pdfSize,
    disableAutoFetch: true,
    disableStream: true,
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  let rejectRange!: (reason: unknown) => void;
  const rangeFailure = new Promise<never>((_, reject) => { rejectRange = reject; });
  transport.setFailureHandler((error) => { rejectRange(error); void task.destroy(); });
  try { return await Promise.race([task.promise, rangeFailure]); }
  catch (error) { throw transport.rangeError ?? error; }
}

export function rotateCanvas(source: HTMLCanvasElement, degrees: number, split: boolean): HTMLCanvasElement[] {
  const rotation = ((degrees % 360) + 360) % 360;
  const rotated = document.createElement("canvas");
  const sideways = rotation === 90 || rotation === 270;
  rotated.width = sideways ? source.height : source.width;
  rotated.height = sideways ? source.width : source.height;
  const ctx = rotated.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, rotated.width, rotated.height);
  ctx.translate(rotated.width / 2, rotated.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  if (!split) return [rotated];
  const half = Math.floor(rotated.width / 2);
  return [0, 1].map((part) => {
    const out = document.createElement("canvas");
    out.width = part === 0 ? half : rotated.width - half;
    out.height = rotated.height;
    out.getContext("2d")!.drawImage(rotated, part * half, 0, out.width, rotated.height, 0, 0, out.width, rotated.height);
    return out;
  });
}

export function canvasToBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png").split(",")[1] ?? "";
}
