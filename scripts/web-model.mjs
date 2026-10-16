import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const manifest = JSON.parse(await readFile(join(root, "config/web-model.json"), "utf8"));
if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(manifest.repository)
  || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(manifest.tag)
  || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.traineddata$/.test(manifest.asset)
  || !/^[a-f0-9]{64}$/.test(manifest.sha256)
  || !Number.isSafeInteger(manifest.size) || manifest.size <= 0) {
  throw new Error("Invalid config/web-model.json.");
}

export const modelPath = join(root, ".cache/ocr-models", manifest.sha256, manifest.asset);

export async function verifyModel(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size !== manifest.size) {
    throw new Error(`OCR model size mismatch: ${path} (expected ${manifest.size} bytes).`);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== manifest.sha256) {
    throw new Error(`OCR model SHA-256 mismatch: ${path}. Expected ${manifest.sha256}.`);
  }
}

export async function readModelProvenance() {
  const bytes = await readFile(join(root, manifest.provenanceFile));
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sourceProject.provenanceSha256) {
    throw new Error("OCR model provenance SHA-256 mismatch.");
  }
  const record = JSON.parse(bytes.toString("utf8"));
  if (record.model_key !== manifest.id || record.snapshot_artifacts.traineddata.sha256 !== manifest.sha256) {
    throw new Error("OCR model provenance does not identify the pinned model.");
  }
  return bytes;
}

/** Acquire exactly the pinned release asset. A local file can seed the same verified cache. */
export async function acquireModel(source) {
  if (source) await verifyModel(resolve(source));
  try {
    await verifyModel(modelPath);
    console.log(`Using verified OCR model ${manifest.id}`);
    return modelPath;
  } catch (error) {
    // A present but invalid cache is an error; never silently use a different model.
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(modelPath), { recursive: true });
  const temporary = `${modelPath}.${randomUUID()}.partial`;
  try {
    if (source) await copyFile(resolve(source), temporary);
    else {
      console.log(`Downloading ${manifest.repository}@${manifest.tag}/${manifest.asset}`);
      try {
        await promisify(execFile)("gh", [
          "release", "download", manifest.tag, "--repo", manifest.repository,
          "--pattern", manifest.asset, "--output", temporary,
        ], { timeout: 180_000, maxBuffer: 1024 * 1024 });
      } catch (error) {
        throw new Error(`Could not download the pinned OCR model. Publish the ${manifest.tag} release asset first; see docs/website-deployment.md. ${error.stderr || error.message}`);
      }
    }
    await verifyModel(temporary);
    await rename(temporary, modelPath);
    console.log(`Verified OCR model ${manifest.id} (${manifest.sha256})`);
    return modelPath;
  } finally {
    await rm(temporary, { force: true });
  }
}
