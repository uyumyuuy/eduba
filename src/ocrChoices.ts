import type { OcrChoice, OcrLine } from "./domain";

function distances(a: string[], b: string[]): Uint32Array {
  const stride = b.length + 1;
  const values = new Uint32Array((a.length + 1) * stride);
  for (let i = 0; i <= a.length; i++) values[i * stride] = i;
  for (let j = 0; j <= b.length; j++) values[j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    values[i * stride + j] = Math.min(
      values[(i - 1) * stride + j] + 1,
      values[i * stride + j - 1] + 1,
      values[(i - 1) * stride + j - 1] + Number(a[i - 1] !== b[j - 1]),
    );
  }
  return values;
}

/** Map only unchanged symbols whose source is the same in every minimum-edit alignment. */
function originalRange(original: string, corrected: string, start: number, end: number): [number, number] | undefined {
  if (original === corrected) return [start, end];
  const a = Array.from(original), b = Array.from(corrected);
  // Long or corrupt lines must not freeze the editor while selecting text.
  if ((a.length + 1) * (b.length + 1) > 250_000) return undefined;
  const targetStart = Array.from(corrected.slice(0, start)).length;
  const targetEnd = targetStart + Array.from(corrected.slice(start, end)).length;
  if (b.slice(0, targetStart).join("").length !== start || b.slice(0, targetEnd).join("").length !== end) return undefined;
  const forward = distances(a, b), reverse = distances([...a].reverse(), [...b].reverse());
  const stride = b.length + 1, cost = forward[a.length * stride + b.length];
  let first = -1, last = -1;
  for (let j = targetStart; j < targetEnd; j++) {
    let match = -1;
    for (let i = 0; i <= a.length; i++) {
      const prefix = forward[i * stride + j];
      if (prefix + 1 + reverse[(a.length - i) * stride + b.length - j - 1] === cost) return undefined;
      if (i < a.length && prefix + Number(a[i] !== b[j]) + reverse[(a.length - i - 1) * stride + b.length - j - 1] === cost) {
        if (a[i] !== b[j] || (match !== -1 && match !== i)) return undefined;
        match = i;
      }
    }
    if (match === -1 || (last !== -1 && match !== last + 1)) return undefined;
    if (first === -1) first = match;
    last = match;
  }
  return first === -1 ? undefined : [a.slice(0, first).join("").length, a.slice(0, last + 1).join("").length];
}

export function choicesForSelection(line: Pick<OcrLine, "originalText" | "correctedText" | "words">, start: number, end: number): OcrChoice[] {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > line.correctedText.length || start >= end) return [];
  const selected = line.correctedText.slice(start, end);
  if ([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(selected)].length !== 1) return [];
  let offset = 0;
  const cells = line.words.flatMap((word, index) => [
    ...(index ? [{ originalText: " ", choices: undefined }] : []), ...word.chars,
  ]).map(char => {
    const cell = { text: char.originalText, choices: char.choices, start: offset, end: offset + char.originalText.length };
    offset = cell.end;
    return cell;
  });
  if (!cells.some(cell => cell.choices?.length) || cells.map(cell => cell.text).join("") !== line.originalText) return [];
  const range = originalRange(line.originalText, line.correctedText, start, end);
  if (!range) return [];
  const [from, to] = range;
  const symbols = cells.filter(cell => cell.start >= from && cell.end <= to && cell.end > cell.start);
  if (symbols[0]?.start !== from || symbols.at(-1)?.end !== to) return [];
  // A grapheme may contain separate base-letter and combining-mark OCR symbols.
  return symbols.flatMap(cell => (cell.choices ?? []).map(choice => ({
    text: selected.slice(0, cell.start - from) + choice.text + selected.slice(cell.end - from),
    confidence: choice.confidence,
  })));
}
