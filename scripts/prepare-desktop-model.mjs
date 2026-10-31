import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bundledModelPath, manifest, root, readModelProvenance, readModelCandidates, verifyModel } from "./web-model.mjs";

await verifyModel(bundledModelPath);
const [provenance, candidates] = await Promise.all([readModelProvenance(), readModelCandidates()]);
const output = dirname(bundledModelPath);
await mkdir(output, { recursive: true });
await copyFile(join(root, manifest.notice), join(output, "OCR-MODEL-NOTICE.txt"));
await copyFile(join(root, manifest.licenseFile), join(output, "OCR-MODEL-LICENSE.txt"));
await writeFile(join(output, "OCR-MODEL-PROVENANCE.json"), provenance);
await writeFile(join(output, "OCR-MODEL-CANDIDATES.json"), candidates);
await copyFile(join(root, "config/web-model.json"), join(output, "web-model.json"));
console.log(`Prepared verified desktop OCR baseline and notices: ${manifest.id}`);
