import model from "../config/web-model.json";

export const DEFAULT_MODEL = model.asset;
// Older browser projects contain these bare filenames.
export const BROWSER_DEFAULT_MODELS: readonly string[] = [
  DEFAULT_MODEL,
  "eng_assyriology_cohen_kramer_r1_600x_20261015.traineddata",
  "eng_assyriology_scan_candidate_20260920_v1.traineddata",
];
