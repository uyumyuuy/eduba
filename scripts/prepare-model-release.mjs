import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireModel, manifest, root } from "./web-model.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--model" || !args[1])) {
  throw new Error("Usage: npm run prepare:model-release [-- --model <local-traineddata>]");
}
const model = await acquireModel(args[1]);
const output = join(root, ".cache/model-release", manifest.tag);
await mkdir(output, { recursive: true });
await copyFile(model, join(output, manifest.asset));
await copyFile(join(root, manifest.notice), join(output, "OCR-MODEL-NOTICE.txt"));
await copyFile(join(root, manifest.licenseFile), join(output, "OCR-MODEL-LICENSE.txt"));
await copyFile(join(root, "config/web-model.json"), join(output, "web-model.json"));
await writeFile(join(output, "SHA256SUMS"), `${manifest.sha256}  ${manifest.asset}\n`);
await writeFile(join(output, "RELEASE-NOTES.md"), `# Eduba OCR model: ${manifest.id}\n\nPinned model asset for the Eduba browser edition.\n\n- License: ${manifest.license}\n- Base model: eng.traineddata from tesseract-ocr/tessdata_best\n- Further trained by the Eduba maintainer for English and Assyriological transliteration.\n- Size: ${manifest.size} bytes\n- SHA-256: \`${manifest.sha256}\`\n- See OCR-MODEL-LICENSE.txt and OCR-MODEL-NOTICE.txt for the license and provenance.\n\nKeep this release and its assets available to reproduce earlier site builds.\n`);
console.log(`Prepared release files in ${output}. Review distribution terms before publishing; see docs/website-deployment.md.`);
