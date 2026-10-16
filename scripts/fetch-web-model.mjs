import { acquireModel } from "./web-model.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--model" || !args[1])) {
  throw new Error("Usage: npm run fetch:web-model [-- --model <local-traineddata>]");
}
await acquireModel(args[1]);
