import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireModel, manifest, root, readModelProvenance, readModelCandidates } from "./web-model.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--model" || !args[1])) {
  throw new Error("Usage: npm run prepare:model-release [-- --model <local-traineddata>]");
}
const model = await acquireModel(args[1]);
const provenance = await readModelProvenance();
const candidates = await readModelCandidates();
const output = join(root, ".cache/model-release", manifest.tag);
await mkdir(output, { recursive: true });
await copyFile(model, join(output, manifest.asset));
await copyFile(join(root, manifest.notice), join(output, "OCR-MODEL-NOTICE.txt"));
await copyFile(join(root, manifest.licenseFile), join(output, "OCR-MODEL-LICENSE.txt"));
await writeFile(join(output, "OCR-MODEL-PROVENANCE.json"), provenance);
await writeFile(join(output, "OCR-MODEL-CANDIDATES.json"), candidates);
await copyFile(join(root, "config/web-model.json"), join(output, "web-model.json"));
await writeFile(join(output, "SHA256SUMS"), `${manifest.sha256}  ${manifest.asset}\n${manifest.correctionCandidates.sha256}  OCR-MODEL-CANDIDATES.json\n`);
await writeFile(join(output, "RELEASE-NOTES.md"), `# Eduba OCR model: ${manifest.id}\n\nPinned model and matching correction table for Eduba.\n\n- Model license: ${manifest.license}\n- Training project: ${manifest.sourceProject.name}\n- Base model: eng.traineddata from tesseract-ocr/tessdata_best\n- Further trained in Assyrian-OCR for English and Assyriological transliteration.\n- Model size: ${manifest.size} bytes\n- Model SHA-256: \`${manifest.sha256}\`\n- Paired table: OCR-MODEL-CANDIDATES.json (${manifest.correctionCandidates.size} bytes)\n- Table SHA-256: \`${manifest.correctionCandidates.sha256}\`\n- The table records this model's key/hash and the evaluation cohort provenance.\n- See OCR-MODEL-LICENSE.txt, OCR-MODEL-NOTICE.txt, and OCR-MODEL-PROVENANCE.json for the model license and training provenance.\n\nKeep this release and its assets available to reproduce earlier site builds.\n`);
console.log(`Prepared release files in ${output}. Review distribution terms before publishing; see docs/website-deployment.md.`);
