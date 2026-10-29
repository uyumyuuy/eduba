import { spawnSync } from "node:child_process";
import { acquireModel, root } from "./web-model.mjs";

const model = await acquireModel();
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this script with npm run build:website.");
for (const args of [["run", "build:web"], ["run", "stage:web"], ["--prefix", "website", "run", "build"]]) {
  const result = spawnSync(process.execPath, [npm, ...args], {
    cwd: root, stdio: "inherit", env: { ...process.env, EDUBA_WEB_MODEL: model },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
