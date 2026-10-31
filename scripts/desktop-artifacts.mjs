import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { bundledModelPath, manifest, root, readModelProvenance, readModelCandidates, verifyModel } from "./web-model.mjs";

const target = "x86_64-pc-windows-msvc";
const release = join(root, "src-tauri/target", target, "release");
const output = join(root, ".cache/windows-build");
const runtime = JSON.parse(await readFile(join(root, "config/windows-runtime.json"), "utf8"));
const config = JSON.parse(await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const mode = process.argv[2];
if (process.argv.length !== 3 || !["prepare", "collect"].includes(mode)) {
  throw new Error("Usage: node scripts/desktop-artifacts.mjs <prepare|collect>");
}
await Promise.all([verifyModel(bundledModelPath), readModelProvenance(), readModelCandidates()]);

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

if (mode === "prepare") {
  await stat(join(release, "eduba.exe"));
  // A restored Cargo cache may contain older installer output. Remove only this
  // target's generated bundle directory after checking its resolved location.
  const realRelease = await realpath(release);
  const relativeRelease = relative(await realpath(root), realRelease);
  if (relativeRelease.startsWith("..") || isAbsolute(relativeRelease)) throw new Error("Release directory must stay inside this checkout.");
  const bundles = join(release, "bundle");
  try {
    if ((await lstat(bundles)).isSymbolicLink() || await realpath(bundles) !== join(realRelease, "bundle")) {
      throw new Error("Bundle output must be a real directory inside the release directory.");
    }
    await rm(bundles, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const libraries = (await readdir(release)).filter(name => /\.dll$/i.test(name) && name !== "eduba_lib.dll").sort();
  // ort currently supplies DirectML.dll next to the executable. NSIS does not
  // automatically include arbitrary DLLs; add every dependency explicitly.
  if (!libraries.length) throw new Error("Expected native runtime DLLs next to the release executable.");
  // RFC 7396 config merging removes the broad directory mapping. Enumerate the
  // model resources so local experimental traineddata files cannot enter a build.
  const resources = { "resources/models": null };
  for (const name of [manifest.asset, "style_word_cnn.onnx", "style-thresholds.json", "style-model-provenance.json",
    "OCR-MODEL-NOTICE.txt", "OCR-MODEL-LICENSE.txt", "OCR-MODEL-PROVENANCE.json", "OCR-MODEL-CANDIDATES.json", "web-model.json"]) {
    const path = join(root, "src-tauri/resources/models", name);
    await stat(path);
    resources[resolve(path)] = `models/${name}`;
  }
  const metadata = [];
  for (const name of libraries) {
    const path = join(release, name);
    resources[resolve(path)] = name;
    metadata.push({ name, sha256: await sha256(path), size: (await stat(path)).size });
  }
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "tauri.bundle.json"), JSON.stringify({ bundle: { resources } }, null, 2) + "\n");
  await writeFile(join(output, "native-runtime.json"), JSON.stringify(metadata, null, 2) + "\n");
  console.log(`Prepared explicit installer resources: ${libraries.join(", ")}`);
} else {
  const artifacts = join(output, "artifacts");
  await mkdir(artifacts, { recursive: true });
  if ((await readdir(artifacts)).length) throw new Error("Artifact output must be empty to avoid including a previous build.");
  for (const [format, extension] of [["nsis", ".exe"], ["msi", ".msi"]]) {
    const directory = join(release, "bundle", format);
    const files = (await readdir(directory)).filter(name => name.endsWith(extension));
    if (files.length !== 1) throw new Error(`Expected exactly one ${format} installer, found ${files.length}.`);
    await copyFile(join(directory, files[0]), join(artifacts, files[0]));
  }
  const nativeRuntime = JSON.parse(await readFile(join(output, "native-runtime.json"), "utf8"));
  for (const file of nativeRuntime) {
    if (await sha256(join(release, file.name)) !== file.sha256) throw new Error(`Native runtime changed while bundling: ${file.name}`);
  }
  const modelNotices = ["OCR-MODEL-NOTICE.txt", "OCR-MODEL-LICENSE.txt", "OCR-MODEL-PROVENANCE.json", "OCR-MODEL-CANDIDATES.json", "web-model.json"];
  for (const name of modelNotices) await copyFile(join(root, "src-tauri/resources/models", name), join(artifacts, name));
  await copyFile(join(root, "src-tauri/resources/tesseract/doc/LICENSE"), join(artifacts, "TESSERACT-LICENSE.txt"));
  await copyFile(join(root, "config/windows-runtime.json"), join(artifacts, "TESSERACT-RUNTIME.json"));
  const commit = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const sourceDirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim().length > 0;
  await writeFile(join(artifacts, "BUILDINFO.json"), JSON.stringify({
    version: config.version, commit, sourceDirty, target, builtAt: new Date().toISOString(),
    runUrl: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    signed: false,
    ocrModel: { id: manifest.id, sha256: manifest.sha256, provenanceSha256: manifest.sourceProject.provenanceSha256,
      candidatesSha256: manifest.correctionCandidates.sha256, candidatesSource: manifest.correctionCandidates.sourcePath },
    tesseract: runtime, nativeRuntime,
  }, null, 2) + "\n");
  const names = (await readdir(artifacts)).sort();
  const hashes = [];
  for (const name of names) hashes.push(`${await sha256(join(artifacts, name))}  ${name}`);
  await writeFile(join(artifacts, "SHA256SUMS"), hashes.join("\n") + "\n");
  console.log(`Collected ${names.length} files and SHA256SUMS in ${artifacts}`);
}
