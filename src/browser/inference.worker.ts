import * as ort from "onnxruntime-web/wasm";
import type { WordStyleSample } from "../tauri";
import { decodeBase64 } from "./bytes";
import { figureTensor, decodeFigures, styleCrop, styleTensor, stylePrediction, type Pixels } from "./inference";

const sessions = new Map<string, Promise<ort.InferenceSession>>();
function session(root: string, path: string) {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = `${root}onnx/`;
  let value = sessions.get(path);
  if (!value) {
    value = ort.InferenceSession.create(`${root}${path}`, { executionProviders: ["wasm"] });
    sessions.set(path, value);
    void value.catch(() => sessions.delete(path));
  }
  return value;
}
async function decodeImage(encoded: string): Promise<Pixels> {
  const bytes = decodeBase64(encoded);
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error("Empty or oversized inference image.");
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 20000 || bitmap.height > 20000 || bitmap.width * bitmap.height * 4 > 256 * 1024 * 1024) throw new Error("Inference image is too large.");
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d");
    if (!context) throw new Error("Inference canvas is unavailable.");
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
  } finally { bitmap.close(); }
}

async function dispatch(command: string, args: { root: string; imageBase64: string; samples?: WordStyleSample[] }) {
  if (command === "classify_word_styles" && !args.samples?.length) return [];
  const image = await decodeImage(args.imageBase64);
  if (command === "detect_figures") {
    const model = await session(args.root, "models/picodet-s-layout-3cls.onnx");
    const result = await model.run({ image: new ort.Tensor("float32", figureTensor(image), [1, 3, 480, 480]), scale_factor: new ort.Tensor("float32", Float32Array.of(480 / image.height, 480 / image.width), [1, 2]) });
    const output = result[model.outputNames[0]];
    if (output.dims.length !== 2 || output.dims[1] !== 6 || output.type !== "float32") throw new Error("Unexpected figure model output.");
    return decodeFigures(output.data as Float32Array, image.width, image.height);
  }
  if (command === "classify_word_styles") {
    const samples = args.samples!;
    if (samples.length > 1000) throw new Error("At most 1000 style samples are allowed.");
    const input = new Float32Array(samples.length * 128 * 32);
    samples.forEach((sample, index) => input.set(styleTensor(image, styleCrop(sample, image.width, image.height)), index * 128 * 32));
    const model = await session(args.root, "models/style_word_cnn.onnx");
    const result = await model.run({ images: new ort.Tensor("float32", input, [samples.length, 1, 32, 128]) });
    const logits = result.logits;
    if (logits.dims.length !== 2 || logits.dims[0] !== samples.length || logits.dims[1] !== 2 || logits.type !== "float32") throw new Error("Unexpected style model output.");
    const data = logits.data as Float32Array;
    return samples.map((sample, index) => stylePrediction(data[index * 2], data[index * 2 + 1], sample.text));
  }
  throw new Error(`Unknown inference operation: ${command}`);
}
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<{ id: number; command: string; args: Parameters<typeof dispatch>[1] }>) => {
  const { id, command, args } = event.data;
  queue = queue.then(async () => {
    try { self.postMessage({ id, result: await dispatch(command, args) }); }
    catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
  });
};
