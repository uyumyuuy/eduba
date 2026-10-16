import { cp, lstat, mkdir, readFile, realpath, rm, stat, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root, manifest, verifyModel, readModelProvenance } from "./web-model.mjs";

const source = join(root, "dist");
const parent = join(root, "website/public");
const destination = join(parent, "app");
const bundledModel = manifest.asset;
// Check inputs before replacing the previous generated app.
for (const path of ["index.html", "assets", "browser-assets/tesseract/worker.min.js",
  "browser-assets/tesseract-core/tesseract-core-lstm.wasm",
  "browser-assets/onnx/ort-wasm-simd-threaded.wasm",
  "browser-assets/models/style_word_cnn.onnx", "browser-assets/models/picodet-s-layout-3cls.onnx"]) {
  await stat(join(source, path));
}
await verifyModel(join(source, "browser-assets/models", bundledModel));
await readFile(join(root, manifest.notice));
await readFile(join(root, manifest.licenseFile));
const provenance = await readModelProvenance();
await mkdir(parent, { recursive: true });
// Never remove a symlink or a generated directory whose parent resolves outside this checkout.
if (await realpath(parent) !== join(await realpath(root), "website/public")) {
  throw new Error("website/public must be a real directory inside this checkout.");
}
try {
  if ((await lstat(destination)).isSymbolicLink()) throw new Error("website/public/app must not be a symlink.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
await copyFile(join(root, "config/web-model.json"), join(destination, "browser-assets/models/web-model.json"));
await mkdir(join(destination, "browser-assets/licenses"), { recursive: true });
await copyFile(join(root, manifest.notice), join(destination, "browser-assets/licenses/OCR-MODEL-NOTICE.txt"));
await copyFile(join(root, manifest.licenseFile), join(destination, "browser-assets/licenses/OCR-MODEL-LICENSE.txt"));
await writeFile(join(destination, "browser-assets/models/OCR-MODEL-PROVENANCE.json"), provenance);
console.log(`Staged the browser app in ${destination}`);
