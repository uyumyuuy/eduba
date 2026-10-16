import model from "../config/web-model.json";

export const DEFAULT_MODEL = model.asset;
// Projects from the first browser edition contain this bare filename.
export const BROWSER_DEFAULT_MODELS: readonly string[] = [
  DEFAULT_MODEL,
  "eng_assyriology_scan_candidate_20260920_v1.traineddata",
];
