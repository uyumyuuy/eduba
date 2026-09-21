import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { invokeCommand } from "./tauri";

GlobalWorkerOptions.workerSrc = workerUrl;

type RangeReader = (begin: number, end: number) => Promise<string>;

function decodeBase64(value: string): Uint8Array {
  const clean = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

class RangeTransport extends PDFDataRangeTransport {
  rangeError: unknown;
  private onFailure?: (error: unknown) => void;

  constructor(length: number, private readonly readRange: RangeReader) {
    super(length, new Uint8Array(), false);
  }

  setFailureHandler(handler: (error: unknown) => void): void {
    this.onFailure = handler;
  }

  override requestDataRange(begin: number, end: number): void {
    this.readRange(begin, end)
      .then(base64 => this.onDataRange(begin, decodeBase64(base64)))
      .catch(error => {
        this.rangeError = error;
        this.onFailure?.(error);
      });
  }
}

async function openRangedPdf(size: number, readRange: RangeReader): Promise<PDFDocumentProxy> {
  const transport = new RangeTransport(size, readRange);
  const task = getDocument({
    range: transport,
    length: size,
    disableAutoFetch: true,
    disableStream: true,
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  let rejectRange!: (reason: unknown) => void;
  const rangeFailure = new Promise<never>((_, reject) => { rejectRange = reject; });
  transport.setFailureHandler(error => {
    rejectRange(error);
    void task.destroy();
  });
  try {
    return await Promise.race([task.promise, rangeFailure]);
  } catch (error) {
    throw transport.rangeError ?? error;
  }
}

export function openProjectPdf(projectPath: string, pdfSize: number): Promise<PDFDocumentProxy> {
  return openRangedPdf(pdfSize, (begin, end) => invokeCommand("read_pdf_range", { projectPath, begin, end }));
}

/** Preview an external PDF through bounded source reads without creating a project. */
export function openSourcePdf(pdfPath: string, pdfSize: number): Promise<PDFDocumentProxy> {
  return openRangedPdf(pdfSize, (begin, end) => invokeCommand("read_source_pdf_range", { pdfPath, begin, end }));
}

export function rotateCanvas(source: HTMLCanvasElement, degrees: number, split: boolean): HTMLCanvasElement[] {
  const rotation = ((degrees % 360) + 360) % 360;
  const rotated = document.createElement("canvas");
  const sideways = rotation === 90 || rotation === 270;
  rotated.width = sideways ? source.height : source.width;
  rotated.height = sideways ? source.width : source.height;
  const context = rotated.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, rotated.width, rotated.height);
  context.translate(rotated.width / 2, rotated.height / 2);
  context.rotate(rotation * Math.PI / 180);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  if (!split) return [rotated];
  const half = Math.floor(rotated.width / 2);
  return [0, 1].map(part => {
    const output = document.createElement("canvas");
    output.width = part === 0 ? half : rotated.width - half;
    output.height = rotated.height;
    output.getContext("2d")!.drawImage(rotated, part * half, 0, output.width, rotated.height, 0, 0, output.width, output.height);
    return output;
  });
}

export function canvasToBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png").split(",")[1] ?? "";
}