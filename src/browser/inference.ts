import type { WordStyleSample } from "../tauri";
import type { Rect } from "../domain";

export type Pixels = { width: number; height: number; data: Uint8ClampedArray };
const SIZE = 480;
function cubic(x: number) {
  x = Math.abs(x); const a = -0.75;
  return x <= 1 ? (a + 2) * x ** 3 - (a + 3) * x ** 2 + 1 : x < 2 ? a * x ** 3 - 5 * a * x ** 2 + 8 * a * x - 4 * a : 0;
}
function axis(length: number) {
  return Array.from({ length: SIZE }, (_, n) => {
    const position = (n + 0.5) * length / SIZE - 0.5, base = Math.floor(position);
    return Array.from({ length: 4 }, (_, k) => ({ index: Math.max(0, Math.min(length - 1, base + k - 1)), weight: cubic(position - (base + k - 1)) }));
  });
}

/** Same cubic kernel, half-pixel placement and RGB normalization as the desktop detector. */
export function figureTensor(image: Pixels): Float32Array {
  const xs = axis(image.width), ys = axis(image.height);
  const data = new Float32Array(3 * SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const color = [0, 0, 0];
    for (const sy of ys[y]) for (const sx of xs[x]) {
      const index = (sy.index * image.width + sx.index) * 4;
      for (let c = 0; c < 3; c++) color[c] += image.data[index + c] * sx.weight * sy.weight;
    }
    for (let c = 0; c < 3; c++) data[c * SIZE * SIZE + y * SIZE + x] =
      (Math.max(0, Math.min(255, Math.round(color[c]))) / 255 - [0.485, 0.456, 0.406][c]) / [0.229, 0.224, 0.225][c];
  }
  return data;
}

export function decodeFigures(rows: ArrayLike<number>, width: number, height: number) {
  const candidates: Array<{ bbox: Rect; score: number }> = [];
  for (let index = 0; index + 5 < rows.length; index += 6) {
    const row = Array.from({ length: 6 }, (_, k) => rows[index + k]);
    if (!row.every(Number.isFinite) || ![0, 2].includes(row[0]) || row[1] < 0.5) continue;
    const bbox = { left: Math.max(0, Math.min(width, Math.floor(row[2]))), top: Math.max(0, Math.min(height, Math.floor(row[3]))), right: Math.max(0, Math.min(width, Math.ceil(row[4]))), bottom: Math.max(0, Math.min(height, Math.ceil(row[5]))) };
    if (bbox.right > bbox.left && bbox.bottom > bbox.top) candidates.push({ bbox, score: row[1] });
  }
  const kept: typeof candidates = [], area = (b: Rect) => (b.right - b.left) * (b.bottom - b.top);
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (!kept.some(({ bbox: b }) => {
      const a = candidate.bbox;
      const intersection = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return intersection / Math.max(1, Math.min(area(a), area(b))) > 0.85;
    })) kept.push(candidate);
  }
  return kept;
}

function pixelBox(box: Rect, width: number, height: number): Rect {
  if (!Object.values(box).every(Number.isFinite) || box.left < 0 || box.top < 0 || box.right <= box.left || box.bottom <= box.top || Math.ceil(box.right) > width || Math.ceil(box.bottom) > height) throw new Error("Style sample is outside the image.");
  return { left: Math.floor(box.left), top: Math.floor(box.top), right: Math.ceil(box.right), bottom: Math.ceil(box.bottom) };
}
export function styleCrop(sample: WordStyleSample, width: number, height: number): Rect {
  const box = pixelBox(sample.bbox, width, height), line = pixelBox(sample.lineBbox, width, height);
  if (box.left < line.left || box.top < line.top || box.right > line.right || box.bottom > line.bottom) throw new Error("Word box must be inside its line.");
  const padX = Math.max(2, (box.right - box.left) * 0.04), padY = Math.max(2, (box.bottom - box.top) * 0.12);
  return { left: Math.max(line.left, Math.floor(box.left - padX)), top: Math.max(line.top, Math.floor(box.top - padY)), right: Math.min(line.right, Math.ceil(box.right + padX)), bottom: Math.min(line.bottom, Math.ceil(box.bottom + padY)) };
}

function lanczos(x: number) {
  x = Math.abs(x);
  return x === 0 ? 1 : x >= 3 ? 0 : Math.sin(Math.PI * x) * Math.sin(Math.PI * x / 3) / (Math.PI ** 2 * x * x / 3);
}
function resampling(length: number, output: number) {
  const ratio = length / output, scale = Math.max(1, ratio), support = 3 * scale;
  return Array.from({ length: output }, (_, n) => {
    const center = (n + 0.5) * ratio;
    const start = Math.max(0, Math.floor(center - support)), end = Math.min(length, Math.ceil(center + support));
    const taps = Array.from({ length: end - start }, (_, k) => ({ index: start + k, weight: lanczos((start + k + 0.5 - center) / scale) }));
    const sum = taps.reduce((sum, tap) => sum + tap.weight, 0);
    return taps.map(tap => ({ ...tap, weight: tap.weight / sum }));
  });
}

/** Aspect preserving Lanczos3 grayscale resize, centered on white at 128 × 32. */
export function styleTensor(image: Pixels, crop: Rect): Float32Array {
  const width = crop.right - crop.left, height = crop.bottom - crop.top;
  const scale = Math.min(128 / width, 32 / height);
  const w = Math.max(1, Math.min(128, Math.round(width * scale))), h = Math.max(1, Math.min(32, Math.round(height * scale)));
  const xs = resampling(width, w), ys = resampling(height, h);
  const vertical = new Float32Array(width * h);
  // Integer Rec.709 grayscale, float vertical pass, rounded final horizontal pass.
  for (let y = 0; y < h; y++) for (let x = 0; x < width; x++) {
    let value = 0;
    for (const tap of ys[y]) {
      const i = ((crop.top + tap.index) * image.width + crop.left + x) * 4;
      const gray = (2126 * image.data[i] + 7152 * image.data[i + 1] + 722 * image.data[i + 2]) / 10000;
      value += Math.floor(gray) * tap.weight;
    }
    vertical[y * width + x] = value;
  }
  const data = new Float32Array(128 * 32).fill(1), x0 = Math.floor((128 - w) / 2), y0 = Math.floor((32 - h) / 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const value = xs[x].reduce((sum, tap) => sum + vertical[y * width + tap.index] * tap.weight, 0);
    data[(y + y0) * 128 + x + x0] = Math.max(0, Math.min(255, Math.round(value))) / 255;
  }
  return data;
}

export function stylePrediction(italicLogit: number, boldLogit: number, text: string) {
  if (![italicLogit, boldLogit].every(Number.isFinite)) throw new Error("Invalid style model output.");
  const sigmoid = (x: number) => x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
  const italic_probability = sigmoid(italicLogit), bold_probability = sigmoid(boldLogit);
  return { italic_probability, bold_probability, italic: italic_probability >= (/^\p{L}$/u.test(text) ? 0.85 : 0.9593396782875061), bold: bold_probability >= 0.9438879489898682 };
}
