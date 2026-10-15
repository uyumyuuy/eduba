import { copyFile, mkdir, access } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "public/browser-assets");
const modelName = "eng_assyriology_scan_candidate_20260920_v1.traineddata";
const explicitIndex = process.argv.indexOf("--model");
if (explicitIndex >= 0 && !process.argv[explicitIndex + 1]) throw new Error("--model requires a traineddata file path.");
let model = process.argv[explicitIndex + 1] && explicitIndex >= 0 ? resolve(process.argv[explicitIndex + 1]) : process.env.EDUBA_WEB_MODEL;
if (!model) {
  for (const path of [join(root, "src-tauri/resources/models", modelName), join(output, "models", modelName)]) {
    try { await access(path); model = path; break; } catch { /* Try the next bundled location. */ }
  }
}
if (!model) throw new Error("OCR model not found. Run npm run prepare:web -- --model <path-to-traineddata> or set EDUBA_WEB_MODEL.");
await access(model);

async function copy(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  if (resolve(source) !== resolve(destination)) await copyFile(source, destination);
}
await copy(model, join(output, "models", modelName));
await copy(join(root, "src-tauri/resources/models/style_word_cnn.onnx"), join(output, "models/style_word_cnn.onnx"));
await copy(join(root, "src-tauri/resources/figure-detection/picodet-s-layout-3cls.onnx"), join(output, "models/picodet-s-layout-3cls.onnx"));
await copy(join(root, "node_modules/tesseract.js/dist/worker.min.js"), join(output, "tesseract/worker.min.js"));
for (const name of ["tesseract-core-lstm.wasm.js", "tesseract-core-lstm.wasm"]) {
  await copy(join(root, "node_modules/tesseract.js-core", name), join(output, "tesseract-core", name));
}
for (const name of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
  await copy(join(root, "node_modules/onnxruntime-web/dist", name), join(output, "onnx", name));
}
for (const [source, name] of [
  ["src-tauri/resources/figure-detection/LICENSE", "PicoDet-LICENSE"],
  ["src-tauri/resources/figure-detection/MODEL-NOTICE.txt", "PicoDet-NOTICE.txt"],
  ["node_modules/tesseract.js/LICENSE.md", "Tesseract-js-LICENSE.md"],
  ["node_modules/tesseract.js-core/LICENSE", "Tesseract-core-LICENSE"],
]) await copy(join(root, source), join(output, "licenses", name));
console.log(`Prepared browser OCR and inference assets in ${output}`);
