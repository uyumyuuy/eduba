import { bundledModelPath, manifest, readModelCandidates, readModelProvenance, verifyModel } from "./web-model.mjs";

await Promise.all([verifyModel(bundledModelPath), readModelProvenance(), readModelCandidates()]);
console.log(`Verified OCR baseline and correction table: ${manifest.id}`);
