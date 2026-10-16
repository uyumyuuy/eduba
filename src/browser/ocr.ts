import type { PSM } from "tesseract.js";
import { loadModel } from "./modelStore";
import { decodeBase64 } from "./bytes";
import { t } from "../i18n";
import { DEFAULT_MODEL } from "../ocrModel";

export { DEFAULT_MODEL };
export function assetUrl(path: string): string {
  return new URL(`${import.meta.env.BASE_URL}browser-assets/${path}`, document.baseURI).href;
}

export function ocrParameters(psm: number, dpi = 300, disableRowNoiseRejection = false) {
  if (!Number.isInteger(psm) || psm < 0 || psm > 13 || !Number.isInteger(dpi) || dpi < 70 || dpi > 2400) throw new Error("Invalid OCR segmentation mode or DPI.");
  // Reset the flag on every request because the worker is reused for full-page OCR.
  return { tessedit_pageseg_mode: String(psm) as PSM, user_defined_dpi: String(dpi), hocr_char_boxes: "1", textord_noise_rejrows: disableRowNoiseRejection ? "0" : "1" };
}

/** Own the native worker so cancellation also interrupts model initialization.
 * The adapter follows the pinned Tesseract.js 7 worker message protocol. */
class TesseractChannel {
  private worker: Worker;
  private next = 0;
  private pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: unknown) => void }>();
  constructor() {
    this.worker = new Worker(assetUrl("tesseract/worker.min.js"));
    this.worker.onmessage = event => {
      const { jobId, status, data } = event.data;
      if (status === "progress") return;
      const job = this.pending.get(jobId);
      if (!job) return;
      this.pending.delete(jobId);
      if (status === "reject") job.reject(new Error(String(data)));
      else if (status === "resolve") job.resolve(data);
    };
    this.worker.onerror = event => this.dispose(new Error(event.message || "OCR worker failed."));
    this.worker.onmessageerror = () => this.dispose(new Error("Could not read the OCR worker response."));
  }
  call<T = unknown>(action: string, payload: object): Promise<T> {
    const jobId = `eduba-${++this.next}`;
    return new Promise((resolve, reject) => {
      this.pending.set(jobId, { resolve: data => resolve(data as T), reject });
      try { this.worker.postMessage({ workerId: "eduba", jobId, action, payload }); }
      catch (error) { this.pending.delete(jobId); reject(error); }
    });
  }
  dispose(error = new Error(t("appErrors.ocrCancelled"))) {
    this.worker.terminate();
    for (const job of this.pending.values()) job.reject(error);
    this.pending.clear();
  }
}

export class BrowserOcr {
  private loaded?: { model: string; channel: TesseractChannel };
  private active?: AbortController;
  private generation = 0;
  async recognize(args: { imageBase64: string; modelPath: string; psm: number; dpi?: number; disableRowNoiseRejection?: boolean }): Promise<string> {
    const parameters = ocrParameters(args.psm, args.dpi, args.disableRowNoiseRejection), image = decodeBase64(args.imageBase64);
    if (!image.length || image.length > 64 * 1024 * 1024) throw new Error("Empty or oversized OCR image.");
    if (this.active) throw new Error("An OCR operation is already running.");
    const controller = new AbortController(), generation = this.generation;
    this.active = controller;
    const model = args.modelPath || DEFAULT_MODEL;
    let channel: TesseractChannel | undefined;
    try {
      if (this.loaded?.model !== model) {
        this.loaded?.channel.dispose(); this.loaded = undefined;
        const stored = model.startsWith("model:") ? await loadModel(model) : undefined;
        if (model.startsWith("model:") && !stored) throw new Error("Select your custom OCR model again in Settings.");
        let bytes: Uint8Array;
        if (stored) bytes = new Uint8Array(await stored.arrayBuffer());
        else {
          const response = await fetch(assetUrl(`models/${DEFAULT_MODEL}`), { signal: controller.signal });
          if (!response.ok) throw new Error("The OCR model is missing from this site. Prepare the web assets before publishing.");
          bytes = new Uint8Array(await response.arrayBuffer());
        }
        if (generation !== this.generation) throw new Error(t("appErrors.ocrCancelled"));
        channel = new TesseractChannel();
        this.loaded = { model, channel };
        await channel.call("load", { options: { lstmOnly: true, corePath: assetUrl("tesseract-core/tesseract-core-lstm.wasm.js") } });
        await channel.call("loadLanguage", { langs: [{ code: "eduba", data: bytes }], options: { cacheMethod: "none", gzip: false, lstmOnly: true } });
        // Native-trained float models must not select missing x86 SSE functions in WASM.
        await channel.call("initialize", { langs: "eduba", oem: 1, config: { dotproduct: "generic" } });
      } else channel = this.loaded.channel;
      if (generation !== this.generation) throw new Error(t("appErrors.ocrCancelled"));
      await channel.call("setParameters", { params: parameters });
      const data = await channel.call<{ hocr: string }>("recognize", { image, options: { rotateAuto: false, rotateRadians: 0 }, output: { text: false, hocr: true } });
      if (generation !== this.generation) throw new Error(t("appErrors.ocrCancelled"));
      if (!data.hocr) throw new Error("OCR did not return hOCR.");
      return data.hocr;
    } catch (error) {
      if (this.loaded?.channel === channel) { channel?.dispose(); this.loaded = undefined; }
      if (generation !== this.generation) throw new Error(t("appErrors.ocrCancelled"));
      throw error;
    } finally { if (this.active === controller) this.active = undefined; }
  }
  async cancel(): Promise<void> {
    this.generation++;
    this.active?.abort();
    this.loaded?.channel.dispose(); this.loaded = undefined;
  }
}
