import type { DocumentPage, OcrLine, Rect, TextFormatRange } from "./domain";
import { allLines } from "./domain";
import type { WordStylePrediction, WordStyleSample } from "./tauri";

function validRect(rect: Rect | undefined): rect is Rect {
  return Boolean(rect && [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite) && rect.right > rect.left && rect.bottom > rect.top);
}

/** Build exact UTF-16 ranges and character-box crops, excluding script characters. */
export function wordStyleSamples(line: OcrLine): Array<{ sample: WordStyleSample; start: number; end: number }> {
  if (line.geometryApproximate || line.correctedText !== line.originalText || line.scriptDetectionManuallyEdited || line.formatting?.length || !validRect(line.bbox)) return [];
  if (!line.chars.length || line.chars.map(char => char.originalText).join("") !== line.originalText || line.chars.some(char => char.originalText.trim() && !validRect(char.bbox))) return [];
  const scripts = (line.autoFormatting ?? []).filter(range => range.kind === "superscript" || range.kind === "subscript");
  const result: Array<{ sample: WordStyleSample; start: number; end: number }> = [];
  let offset = 0;
  let run: Array<{ text: string; bbox: Rect; start: number; end: number }> = [];
  const flush = () => {
    if (!run.length) return;
    const boxes = run.map(item => item.bbox);
    let bbox = { left: Math.min(...boxes.map(box => box.left)), top: Math.min(...boxes.map(box => box.top)), right: Math.max(...boxes.map(box => box.right)), bottom: Math.max(...boxes.map(box => box.bottom)) };
    const start = run[0].start, end = run[run.length - 1].end;
    const wordStartOffsets = new Map<number, typeof line.words[number]>();
    let wordOffset = 0;
    for (const word of line.words) { wordStartOffsets.set(wordOffset, word); wordOffset += word.correctedText.length + 1; }
    const fullWord = wordStartOffsets.get(start);
    if (fullWord?.correctedText === run.map(item => item.text).join("") && validRect(fullWord.bbox)) bbox = fullWord.bbox;
    if (bbox.left < line.bbox.left || bbox.top < line.bbox.top || bbox.right > line.bbox.right || bbox.bottom > line.bbox.bottom) { run = []; return; }
    result.push({ sample: { bbox, lineBbox: line.bbox, text: run.map(item => item.text).join("") }, start, end });
    run = [];
  };
  for (const char of line.chars) {
    const start = offset, end = start + char.originalText.length;
    offset = end;
    const excluded = scripts.some(range => range.start < end && range.end > start);
    if (/^\s+$/u.test(char.originalText) || excluded) { flush(); continue; }
    if (!validRect(char.bbox) || char.originalText.length === 0) { flush(); continue; }
    run.push({ text: char.originalText, bbox: char.bbox, start, end });
  }
  flush();
  return result;
}

export function applyWordStylePredictions(page: DocumentPage, predictionsByLine: Map<string, Array<WordStylePrediction | undefined>>): DocumentPage {
  const copy: DocumentPage = JSON.parse(JSON.stringify(page)) as DocumentPage;
  for (const line of allLines(copy)) {
    if (line.correctedText !== line.originalText || line.scriptDetectionManuallyEdited || line.formatting?.length || line.geometryApproximate) continue;
    const ranges: TextFormatRange[] = [];
    const samples = wordStyleSamples(line);
    const predictions = predictionsByLine.get(line.id) ?? [];
    samples.forEach((entry, index) => {
      const prediction = predictions[index];
      if (!prediction) return;
      if (prediction.italic) ranges.push({ start: entry.start, end: entry.end, kind: "italic" });
      if (prediction.bold) ranges.push({ start: entry.start, end: entry.end, kind: "bold" });
    });
    const scripts = (line.autoFormatting ?? []).filter(range => range.kind === "superscript" || range.kind === "subscript");
    line.autoFormatting = [...scripts, ...ranges].length ? [...scripts, ...ranges] : undefined;
  }
  return copy;
}

/** Clear inferred word styles before reclassifying after script thresholds change. */
export function clearAutoWordStyles(page: DocumentPage): DocumentPage {
  const copy: DocumentPage = JSON.parse(JSON.stringify(page)) as DocumentPage;
  for (const line of allLines(copy)) {
    if (line.correctedText !== line.originalText || line.scriptDetectionManuallyEdited || line.formatting?.length || line.geometryApproximate) continue;
    const remaining = (line.autoFormatting ?? []).filter(range => range.kind !== "italic" && range.kind !== "bold");
    line.autoFormatting = remaining.length ? remaining : undefined;
  }
  return copy;
}
/** Classify only image-contained samples, retaining exact line/sample alignment across batches. */
export async function inferWordStyles(
  page: DocumentPage,
  imageBase64: string,
  width: number,
  height: number,
  classify: (imageBase64: string, samples: WordStyleSample[]) => Promise<WordStylePrediction[]>,
): Promise<DocumentPage> {
  const byLine = new Map<string, ReturnType<typeof wordStyleSamples>>();
  const records: Array<{ lineId: string; sampleIndex: number; sample: WordStyleSample }> = [];
  allLines(page).forEach(line => {
    const entries = wordStyleSamples(line);
    if (entries.length) byLine.set(line.id, entries);
    entries.forEach((entry, sampleIndex) => {
      const box = entry.sample.bbox, lineBox = entry.sample.lineBbox;
      if (box.left < 0 || box.top < 0 || box.right > width || box.bottom > height || lineBox.left < 0 || lineBox.top < 0 || lineBox.right > width || lineBox.bottom > height) return;
      records.push({ lineId: line.id, sampleIndex, sample: entry.sample });
    });
  });
  if (!records.length) return page;
  const predictions: WordStylePrediction[] = [];
  for (let start = 0; start < records.length; start += 1000) {
    predictions.push(...await classify(imageBase64, records.slice(start, start + 1000).map(record => record.sample)));
  }
  const grouped = new Map<string, Array<WordStylePrediction | undefined>>();
  for (const [lineId, entries] of byLine) grouped.set(lineId, Array(entries.length));
  records.forEach((record, index) => grouped.get(record.lineId)![record.sampleIndex] = predictions[index]);
  return applyWordStylePredictions(page, grouped);
}
