import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserOcr, ocrParameters } from "./ocr";
import { allLines, parseHocr } from "../domain";
import { exportFixtureHocr } from "../testSupport/hocr";

const hocr = '<html><body><div class="ocr_page" title="bbox 0 0 100 50"><div class="ocr_carea"><p class="ocr_par"><span class="ocr_line" title="bbox 10 10 30 20; baseline 0 -2"><span class="ocrx_word" title="bbox 10 10 30 20; x_wconf 91"><span class="ocrx_cinfo" title="x_bboxes 10 10 20 20; x_conf 98">A</span><span class="ocrx_cinfo" title="x_bboxes 20 10 30 20; x_conf 97">𒀀</span></span></span></p></div></div></body></html>';
type Job = { action: string; jobId: string; payload: Record<string, unknown> };
class FakeWorker {
  static instances: FakeWorker[] = [];
  static hold?: string;
  static reject?: string;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string }) => void;
  onmessageerror?: () => void;
  jobs: Job[] = [];
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  postMessage(job: Job) {
    this.jobs.push(job);
    if (job.action === FakeWorker.hold) return;
    queueMicrotask(() => this.onmessage?.({ data: { jobId: job.jobId, status: job.action === FakeWorker.reject ? "reject" : "resolve", data: job.action === FakeWorker.reject ? "Invalid traineddata" : job.action === "recognize" ? { hocr } : {} } }));
  }
}
beforeEach(() => {
  FakeWorker.instances = []; FakeWorker.hold = undefined; FakeWorker.reject = undefined;
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })));
});
afterEach(() => { vi.unstubAllGlobals(); });
const args = { imageBase64: btoa("png"), modelPath: "", psm: 3, dpi: 600 };

describe("browser OCR contract", () => {
  it("preserves character coordinates/confidence and disables engine image rotation", async () => {
    const ocr = new BrowserOcr();
    const output = await ocr.recognize(args);
    const worker = FakeWorker.instances[0];
    expect(worker.jobs.find(job => job.action === "setParameters")!.payload).toEqual({ params: { tessedit_pageseg_mode: "3", user_defined_dpi: "600", hocr_char_boxes: "1", textord_noise_rejrows: "1" } });
    expect(worker.jobs.find(job => job.action === "recognize")!.payload).toMatchObject({ options: { rotateAuto: false, rotateRadians: 0 }, output: { text: false, hocr: true } });
    expect(worker.jobs.find(job => job.action === "initialize")!.payload.langs).toBe("eduba");
    expect(worker.jobs.find(job => job.action === "initialize")!.payload.config).toEqual({ dotproduct: "generic" });
    const page = parseHocr(output)[0], line = allLines(page)[0];
    expect(line.originalText).toBe("A𒀀");
    expect(line.chars[1]).toMatchObject({ bbox: { left: 20, top: 10, right: 30, bottom: 20 }, confidence: 97 });
    expect(exportFixtureHocr([page])).toContain("x_bboxes 20 10 30 20; x_conf 97");
    await ocr.recognize(args);
    expect(FakeWorker.instances).toHaveLength(1);
    await ocr.cancel();
  });

  it("cancels during model initialization and can start a fresh worker", async () => {
    const ocr = new BrowserOcr(); FakeWorker.hold = "loadLanguage";
    const request = ocr.recognize(args);
    const rejection = expect(request).rejects.toThrow(/cancel/i);
    await vi.waitFor(() => expect(FakeWorker.instances[0]?.jobs.at(-1)?.action).toBe("loadLanguage"));
    await ocr.cancel(); await rejection;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalled();
    FakeWorker.hold = undefined;
    expect(await ocr.recognize(args)).toBe(hocr);
    expect(FakeWorker.instances).toHaveLength(2);
    await ocr.cancel();
  });

  it("turns row noise rejection off for a region and restores it on the reused worker for normal OCR", async () => {
    const ocr = new BrowserOcr();
    await ocr.recognize({ ...args, psm: 7, disableRowNoiseRejection: true });
    await ocr.recognize(args);
    await ocr.recognize({ ...args, psm: 6, disableRowNoiseRejection: true });
    await ocr.recognize({ ...args, psm: 7, disableRowNoiseRejection: false });
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].jobs.filter(job => job.action === "setParameters").map(job => job.payload.params)).toEqual([
      { tessedit_pageseg_mode: "7", user_defined_dpi: "600", hocr_char_boxes: "1", textord_noise_rejrows: "0" },
      { tessedit_pageseg_mode: "3", user_defined_dpi: "600", hocr_char_boxes: "1", textord_noise_rejrows: "1" },
      { tessedit_pageseg_mode: "6", user_defined_dpi: "600", hocr_char_boxes: "1", textord_noise_rejrows: "0" },
      { tessedit_pageseg_mode: "7", user_defined_dpi: "600", hocr_char_boxes: "1", textord_noise_rejrows: "1" },
    ]);
    await ocr.cancel();
  });

  it("reports invalid model data and terminates the failed worker", async () => {
    const ocr = new BrowserOcr(); FakeWorker.reject = "initialize";
    await expect(ocr.recognize(args)).rejects.toThrow("Invalid traineddata");
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalled();
  });

  it("rejects invalid segmentation/DPI before creating a worker", () => {
    expect(() => ocrParameters(3, 69)).toThrow();
    expect(() => ocrParameters(14, 300)).toThrow();
    expect(ocrParameters(7, 2400)).toMatchObject({ tessedit_pageseg_mode: "7", user_defined_dpi: "2400" });
  });
});
