import { manifest, readModelCandidates, readModelProvenance } from "./web-model.mjs";

await Promise.all([readModelProvenance(), readModelCandidates()]);
console.log(`Verified OCR baseline and correction table: ${manifest.id}`);
