import type { DocumentPage, OcrChar, OcrLine, Rect, TextFormatRange } from "./domain";
import { allLines } from "./domain";

export type SubscriptScope = "digits-and-x" | "all";

/** Thresholds are expressed relative to estimated ordinary capital height. */
export interface ScriptDetectionSettings {
  superscriptMaxHeightRatio: number;
  superscriptMinRiseRatio: number;
  subscriptMaxHeightRatio: number;
  subscriptMinDropRatio: number;
  subscriptScope: SubscriptScope;
}

export const SCRIPT_HEIGHT_REFERENCE_VERSION = 2;
export const DEFAULT_SCRIPT_DETECTION_SETTINGS: ScriptDetectionSettings = {
  // Project-specific values override these starting points. Older
  // mixed-height settings are migrated by their corresponding default ratios.
  superscriptMaxHeightRatio: 0.7,
  superscriptMinRiseRatio: 0.3,
  subscriptMaxHeightRatio: 0.8,
  subscriptMinDropRatio: 0.2,
  subscriptScope: "digits-and-x",
};

const LEGACY_DEFAULTS = {
  superscriptMaxHeightRatio: 0.7,
  superscriptMinRiseRatio: 0.45,
  subscriptMaxHeightRatio: 0.7,
  subscriptMinDropRatio: 0.35,
} as const;

export function migrateLegacyScriptSettings(
  old: Partial<ScriptDetectionSettings>,
): ScriptDetectionSettings {
  const scale = (key: keyof typeof LEGACY_DEFAULTS) => {
    const value = old[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value * DEFAULT_SCRIPT_DETECTION_SETTINGS[key] / LEGACY_DEFAULTS[key] * 1_000_000) / 1_000_000
      : DEFAULT_SCRIPT_DETECTION_SETTINGS[key];
  };
  return {
    superscriptMaxHeightRatio: scale("superscriptMaxHeightRatio"),
    superscriptMinRiseRatio: scale("superscriptMinRiseRatio"),
    subscriptMaxHeightRatio: scale("subscriptMaxHeightRatio"),
    subscriptMinDropRatio: scale("subscriptMinDropRatio"),
    subscriptScope: old.subscriptScope === "all" ? "all" : "digits-and-x",
  };
}

/** Observed lowercase ink-height / capital-height ratios for this project. */
export interface ScriptHeightProfile {
  version: 1;
  ratios: Record<string, number>;
}

interface CharacterGeometry {
  char: OcrChar;
  start: number;
  end: number;
  bbox: Rect;
  height: number;
  baseline: number;
}

interface LineMetrics {
  provisionalHeight: number;
  characters: CharacterGeometry[];
}

const coreSuperscript = /^[\p{L}\p{N}]$/u;
const subscriptDigitOrX = /^[0-9xX]$/;
const capital = /^[A-Z]$/;
const attachedSymbols = new Set(["(", ")", "[", "]", "{", "}", "+", "-", "−", "=", "*", "/", "×", "÷"]);
// Descenders need a separate above-baseline measurement. Excluding them is
// safer than treating the full ink box as an x-height.
const xHeightLetters = "acemnorsuvwxz";
const ascenderLetters = "bdfhkli";
const shortAscenders = "t";
const lowercaseAnchors = new Set(xHeightLetters + ascenderLetters + shortAscenders);

function defaultLowercaseRatio(letter: string): number | undefined {
  if (xHeightLetters.includes(letter)) return 0.73;
  if (ascenderLetters.includes(letter)) return 1.0;
  if (shortAscenders.includes(letter)) return 0.82;
  return undefined;
}

function lowercaseRatio(letter: string, profile?: ScriptHeightProfile): number | undefined {
  const fallback = defaultLowercaseRatio(letter);
  if (fallback == null) return undefined;
  const observed = profile?.version === 1 ? profile.ratios?.[letter] : undefined;
  return typeof observed === "number" && Number.isFinite(observed) && observed >= 0.5 && observed <= 1.35
    ? observed : fallback;
}

function finiteRect(rect: Rect | undefined): rect is Rect {
  return Boolean(rect && [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite) &&
    rect.right > rect.left && rect.bottom > rect.top);
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function eligibleLine(line: OcrLine): boolean {
  return !line.scriptDetectionManuallyEdited && !line.formatting?.length &&
    !line.geometryApproximate && line.correctedText === line.originalText &&
    Boolean(line.baseline) && finiteRect(line.bbox) &&
    !line.chars.some(char => char.correctedText.trim() && !finiteRect(char.bbox));
}

function baselineAt(line: OcrLine, x: number, scale: number): number | undefined {
  const baseline = line.baseline;
  if (!baseline || !Number.isFinite(baseline.slope) || !Number.isFinite(baseline.intercept)) return undefined;
  // hOCR stores the intercept relative to the line box bottom.
  const y = line.bbox.bottom + baseline.intercept + baseline.slope * (x - line.bbox.left);
  if (!Number.isFinite(y) || Math.abs(baseline.slope) > 1 ||
    y < line.bbox.top - scale || y > line.bbox.bottom + scale) return undefined;
  return y;
}

function lineMetrics(line: OcrLine): LineMetrics | undefined {
  if (!eligibleLine(line)) return undefined;
  const heights = line.chars
    .filter(char => finiteRect(char.bbox) && /^[A-Za-z]$/.test(char.correctedText))
    .map(char => char.bbox!.bottom - char.bbox!.top);
  const provisionalHeight = median(heights);
  if (!provisionalHeight || heights.length < 3) return undefined;
  let offset = 0;
  const characters: CharacterGeometry[] = [];
  for (const char of line.chars) {
    const text = char.correctedText;
    if (!text || line.correctedText.slice(offset, offset + text.length) !== text) return undefined;
    const start = offset;
    offset += text.length;
    if (!finiteRect(char.bbox)) continue; // hOCR word spaces have no box.
    const baseline = baselineAt(line, (char.bbox.left + char.bbox.right) / 2, provisionalHeight);
    if (baseline == null) return undefined;
    characters.push({ char, start, end: offset, bbox: char.bbox,
      height: char.bbox.bottom - char.bbox.top, baseline });
  }
  return offset === line.correctedText.length ? { provisionalHeight, characters } : undefined;
}

function baselineAligned(entry: CharacterGeometry, provisionalHeight: number): boolean {
  return Math.abs(entry.bbox.bottom - entry.baseline) <= 0.22 * provisionalHeight;
}

/** A trustworthy cap-height estimate requires three baseline-aligned A-Z. */
function capitalHeight(metrics: LineMetrics): number | undefined {
  const heights = metrics.characters
    .filter(entry => capital.test(entry.char.correctedText) && baselineAligned(entry, metrics.provisionalHeight))
    .map(entry => entry.height);
  if (heights.length < 3) return undefined;
  const center = median(heights)!;
  const inliers = heights.filter(height => height >= center * 0.75 && height <= center * 1.25);
  return inliers.length >= 3 ? median(inliers) : undefined;
}

function lowercaseHeight(metrics: LineMetrics, profile?: ScriptHeightProfile): number | undefined {
  const estimates = metrics.characters.flatMap(entry => {
    const letter = entry.char.correctedText;
    if (!lowercaseAnchors.has(letter) || !baselineAligned(entry, metrics.provisionalHeight)) return [];
    const ratio = lowercaseRatio(letter, profile);
    return ratio == null ? [] : [entry.height / ratio];
  });
  if (estimates.length < 3) return undefined;
  const center = median(estimates)!;
  const inliers = estimates.filter(height => height >= center * 0.72 && height <= center * 1.28);
  return inliers.length >= 3 ? median(inliers) : undefined;
}

export class ScriptHeightTrainer {
  private readonly samples = new Map<string, number[]>();

  addPage(page: DocumentPage): void {
    for (const line of allLines(page)) {
      const metrics = lineMetrics(line);
      if (!metrics) continue;
      const cap = capitalHeight(metrics);
      if (!cap) continue;
      for (const entry of metrics.characters) {
        const letter = entry.char.correctedText;
        if (!lowercaseAnchors.has(letter) || !baselineAligned(entry, metrics.provisionalHeight)) continue;
        const ratio = entry.height / cap;
        if (ratio < 0.5 || ratio > 1.35) continue;
        const samples = this.samples.get(letter) ?? [];
        samples.push(ratio);
        this.samples.set(letter, samples);
      }
    }
  }

  finish(): ScriptHeightProfile {
    const ratios: Record<string, number> = {};
    for (const letter of lowercaseAnchors) {
      const fallback = defaultLowercaseRatio(letter)!;
      const samples = this.samples.get(letter) ?? [];
      // Shrink sparse character evidence toward its shape-group prior.
      const observed = samples.length >= 5 ? median(samples)! : fallback;
      const weight = samples.length / (samples.length + 12);
      ratios[letter] = Math.max(0.5, Math.min(1.35, weight * observed + (1 - weight) * fallback));
    }
    return { version: 1, ratios };
  }
}

export function learnScriptHeightProfile(pages: Iterable<DocumentPage>): ScriptHeightProfile {
  const trainer = new ScriptHeightTrainer();
  for (const page of pages) trainer.addPage(page);
  return trainer.finish();
}

function approximateLineHeight(line: OcrLine): number | undefined {
  return median(line.chars.filter(char => finiteRect(char.bbox) && /^[A-Za-z]$/.test(char.correctedText))
    .map(char => char.bbox!.bottom - char.bbox!.top));
}

/**
 * Choose a capital-height reference for each line. A reliable same-block cap
 * anchor outranks a lowercase estimate only when their sizes agree; this keeps
 * adjacent footnotes or headings from lending the wrong font size.
 */
export function referenceHeightsForPage(
  page: DocumentPage,
  profile?: ScriptHeightProfile,
): Map<string, number> {
  const resolved = profile ?? learnScriptHeightProfile([page]);
  const result = new Map<string, number>();
  for (const block of page.blocks) {
    const items = block.paragraphs.flatMap((paragraph, paragraphIndex) =>
      paragraph.lines.map(line => ({ line, paragraphIndex })));
    const observations = items.map(({ line }) => {
      const metrics = lineMetrics(line);
      return metrics ? { cap: capitalHeight(metrics), lower: lowercaseHeight(metrics, resolved) } : {};
    });
    const anchors = observations.flatMap((item, index) =>
      item.cap ? [{ index, height: item.cap, paragraphIndex: items[index].paragraphIndex }] : []);
    items.forEach(({ line, paragraphIndex }, index) => {
      const own = observations[index];
      if (own.cap) {
        result.set(line.id, own.cap);
        return;
      }
      const nearby = anchors
        .filter(anchor => Math.abs(anchor.index - index) <= 6)
        .filter(anchor => {
          if (own.lower && Math.abs(anchor.height - own.lower) / own.lower > 0.25) return false;
          const anchorLine = items[anchor.index].line;
          if (line.fontSize && anchorLine.fontSize &&
            Math.abs(line.fontSize - anchorLine.fontSize) / line.fontSize > 0.22) return false;
          if (!own.lower && !(line.fontSize && anchorLine.fontSize)) {
            const raw = approximateLineHeight(line);
            const anchorRaw = approximateLineHeight(anchorLine);
            if (!raw || !anchorRaw || Math.abs(raw - anchorRaw) / anchorRaw > 0.25) return false;
          }
          return true;
        })
        .sort((a, b) =>
          (a.paragraphIndex === paragraphIndex ? 0 : 3) + Math.abs(a.index - index) -
          ((b.paragraphIndex === paragraphIndex ? 0 : 3) + Math.abs(b.index - index)));
      const reference = nearby[0]?.height ?? own.lower;
      if (reference && Number.isFinite(reference) && reference > 0) result.set(line.id, reference);
    });
  }
  return result;
}

function safeSettings(settings: ScriptDetectionSettings): ScriptDetectionSettings {
  const number = (value: number, fallback: number) => Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    superscriptMaxHeightRatio: number(settings.superscriptMaxHeightRatio, DEFAULT_SCRIPT_DETECTION_SETTINGS.superscriptMaxHeightRatio),
    superscriptMinRiseRatio: number(settings.superscriptMinRiseRatio, DEFAULT_SCRIPT_DETECTION_SETTINGS.superscriptMinRiseRatio),
    subscriptMaxHeightRatio: number(settings.subscriptMaxHeightRatio, DEFAULT_SCRIPT_DETECTION_SETTINGS.subscriptMaxHeightRatio),
    subscriptMinDropRatio: number(settings.subscriptMinDropRatio, DEFAULT_SCRIPT_DETECTION_SETTINGS.subscriptMinDropRatio),
    subscriptScope: settings.subscriptScope === "all" ? "all" : "digits-and-x",
  };
}

function rangesForKind(
  geometries: CharacterGeometry[],
  referenceHeight: number,
  kind: "superscript" | "subscript",
  settings: ScriptDetectionSettings,
): TextFormatRange[] {
  const isSuperscript = kind === "superscript";
  const maxHeight = isSuperscript ? settings.superscriptMaxHeightRatio : settings.subscriptMaxHeightRatio;
  const minDisplacement = isSuperscript ? settings.superscriptMinRiseRatio : settings.subscriptMinDropRatio;
  const matchesGeometry = (entry: CharacterGeometry) =>
    entry.height / referenceHeight <= maxHeight &&
    (isSuperscript ? entry.baseline - entry.bbox.bottom : entry.bbox.bottom - entry.baseline) / referenceHeight >= minDisplacement;
  const isCore = (entry: CharacterGeometry) =>
    isSuperscript ? coreSuperscript.test(entry.char.correctedText) :
      settings.subscriptScope === "all" ? entry.char.correctedText.trim().length > 0 :
        subscriptDigitOrX.test(entry.char.correctedText);
  const selected = new Set<number>();
  geometries.forEach((entry, index) => {
    if (isCore(entry) && matchesGeometry(entry)) selected.add(index);
  });
  // A punctuation mark can join a raised/lowered alphanumeric run but cannot
  // independently start one. This avoids common hyphen/quote false positives.
  let changed = true;
  while (changed) {
    changed = false;
    geometries.forEach((entry, index) => {
      if (selected.has(index) || !attachedSymbols.has(entry.char.correctedText) || !matchesGeometry(entry)) return;
      const adjacent = [index - 1, index + 1].some(other =>
        selected.has(other) && Boolean(geometries[other]) &&
        (geometries[other].end === entry.start || entry.end === geometries[other].start));
      if (adjacent) { selected.add(index); changed = true; }
    });
  }
  const chosen = [...selected].sort((a, b) => geometries[a].start - geometries[b].start).map(index => geometries[index]);
  return chosen.reduce<TextFormatRange[]>((ranges, entry) => {
    const previous = ranges[ranges.length - 1];
    if (previous && previous.end === entry.start) previous.end = entry.end;
    else ranges.push({ start: entry.start, end: entry.end, kind });
    return ranges;
  }, []);
}

export function detectScriptRanges(
  line: OcrLine,
  settings: ScriptDetectionSettings = DEFAULT_SCRIPT_DETECTION_SETTINGS,
  referenceHeight?: number,
  profile?: ScriptHeightProfile,
): TextFormatRange[] {
  const metrics = lineMetrics(line);
  if (!metrics) return [];
  const height = referenceHeight ?? capitalHeight(metrics) ?? lowercaseHeight(metrics, profile);
  if (!height || !Number.isFinite(height) || height <= 0) return [];
  const resolved = safeSettings(settings);
  return [
    ...rangesForKind(metrics.characters, height, "superscript", resolved),
    ...rangesForKind(metrics.characters, height, "subscript", resolved),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Replace only automatic script ranges; manual edits remain untouched. */
export function applyScriptDetection(
  page: DocumentPage,
  settings: ScriptDetectionSettings = DEFAULT_SCRIPT_DETECTION_SETTINGS,
  profile?: ScriptHeightProfile,
): DocumentPage {
  const copy: DocumentPage = JSON.parse(JSON.stringify(page)) as DocumentPage;
  const resolved = profile ?? learnScriptHeightProfile([copy]);
  const references = referenceHeightsForPage(copy, resolved);
  for (const line of allLines(copy)) {
    if (!eligibleLine(line)) continue;
    const ranges = detectScriptRanges(line, settings, references.get(line.id), resolved);
    const styles = (line.autoFormatting ?? []).filter(range => range.kind === "italic" || range.kind === "bold").flatMap(style => {
      let pieces = [style];
      for (const script of ranges) pieces = pieces.flatMap(piece => piece.end <= script.start || piece.start >= script.end ? [piece] : [
        ...(piece.start < script.start ? [{ ...piece, end: script.start }] : []),
        ...(piece.end > script.end ? [{ ...piece, start: script.end }] : []),
      ]);
      return pieces;
    });
    line.autoFormatting = [...ranges, ...styles].length ? [...ranges, ...styles] : undefined;
  }
  return copy;
}
