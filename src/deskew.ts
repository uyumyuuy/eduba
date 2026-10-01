export type DeskewStatus = "corrected" | "aligned" | "insufficient-text" | "inconsistent-lines" | "low-improvement" | "unavailable" | "disabled";
export type DeskewEstimate = { angle: number; status: DeskewStatus };

type Glyph = { id: number; left: number; right: number; top: number; bottom: number; count: number };
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** Identify connected ink components, rejecting scan rules and large artwork. */
function textComponents(image: { width: number; height: number; data: Uint8ClampedArray }) {
  const { width, height, data } = image;
  const labels = new Int32Array(width * height);
  const ink = new Uint8Array(width * height);
  const borderX = Math.ceil(width * 0.04), borderY = Math.ceil(height * 0.04);
  let totalInk = 0;
  for (let y = borderY; y < height - borderY; y++)
    for (let x = borderX; x < width - borderX; x++) {
      const index = y * width + x, i = index * 4;
      if (data[i + 3] > 128 && (data[i] + data[i + 1] + data[i + 2]) / 3 < 180) {
        ink[index] = 1;
        totalInk++;
      }
    }
  if (totalInk < Math.max(100, width * height * 0.001) || totalInk > width * height * 0.5)
    return { glyphs: [] as Glyph[], labels };
  const queue = new Int32Array(width * height);
  const candidates: Glyph[] = [];
  let id = 0;
  for (let index = 0; index < ink.length; index++) {
    if (!ink[index] || labels[index]) continue;
    id++;
    labels[index] = id;
    queue[0] = index;
    let head = 0, tail = 1;
    let left = width, right = 0, top = height, bottom = 0;
    while (head < tail) {
      const current = queue[head++], x = current % width, y = Math.floor(current / width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < borderX || nx >= width - borderX || ny < borderY || ny >= height - borderY) continue;
          const next = ny * width + nx;
          if (ink[next] && !labels[next]) {
            labels[next] = id;
            queue[tail++] = next;
          }
        }
    }
    const w = right - left + 1, h = bottom - top + 1;
    if (tail >= 4 && h >= 3 && h <= Math.min(60, height * 0.08)
      && w <= Math.min(width * 0.12, h * 4) && w >= h * 0.08
      && (h <= 4 || tail / (w * h) < 0.95))
      candidates.push({ id, left, right, top, bottom, count: tail });
  }
  // Tiny punctuation and unusually large lettering should not dominate analysis.
  const typicalHeight = median(candidates.map(glyph => glyph.bottom - glyph.top + 1));
  const glyphs = candidates.filter(glyph => {
    const h = glyph.bottom - glyph.top + 1;
    return h >= typicalHeight * 0.55 && h <= typicalHeight * 1.8;
  });
  return { glyphs, labels };
}

/** Require several long, spatially distributed lines supporting the same angle. */
function textLineStatus(glyphs: Glyph[], angle: number, width: number, height: number): DeskewStatus | undefined {
  if (glyphs.length < 30) return "insufficient-text";
  const typicalHeight = median(glyphs.map(glyph => glyph.bottom - glyph.top + 1));
  const radians = angle * Math.PI / 180;
  const projected = glyphs.map(glyph => ({
    glyph, y: ((glyph.left + glyph.right) / 2) * Math.sin(radians) + glyph.bottom * Math.cos(radians),
  })).sort((a, b) => a.y - b.y);
  const groups: Glyph[][] = [];
  let group: Glyph[] = [], mean = 0;
  for (const item of projected) {
    if (group.length && item.y - mean > typicalHeight * 0.7) {
      groups.push(group); group = [];
    }
    mean = group.length ? (mean * group.length + item.y) / (group.length + 1) : item.y;
    group.push(item.glyph);
  }
  if (group.length) groups.push(group);
  const lines = groups.flatMap(glyphs => {
    if (glyphs.length < 6) return [];
    const left = Math.min(...glyphs.map(g => g.left)), right = Math.max(...glyphs.map(g => g.right));
    if (right - left < Math.max(width * 0.18, typicalHeight * 8)) return [];
    const xMean = glyphs.reduce((sum, g) => sum + (g.left + g.right) / 2, 0) / glyphs.length;
    const yMean = glyphs.reduce((sum, g) => sum + g.bottom, 0) / glyphs.length;
    let covariance = 0, variance = 0;
    for (const g of glyphs) {
      const dx = (g.left + g.right) / 2 - xMean;
      covariance += dx * (g.bottom - yMean); variance += dx * dx;
    }
    const slope = covariance / Math.max(1, variance);
    const residual = Math.sqrt(glyphs.reduce((sum, g) => {
      const error = g.bottom - yMean - slope * ((g.left + g.right) / 2 - xMean);
      return sum + error * error;
    }, 0) / glyphs.length);
    if (residual > typicalHeight * 0.45) return [];
    return [{ angle: -Math.atan(slope) * 180 / Math.PI, y: yMean, glyphs }];
  });
  if (lines.length < 5) return "insufficient-text";
  const consensus = median(lines.map(line => line.angle));
  const agreeing = lines.filter(line => Math.abs(line.angle - consensus) <= 0.4 && Math.abs(line.angle - angle) <= 0.5);
  const supportedCount = agreeing.reduce((sum, line) => sum + line.glyphs.length, 0);
  const spread = Math.max(...agreeing.map(line => line.y)) - Math.min(...agreeing.map(line => line.y));
  if (agreeing.length < 5 || agreeing.length < lines.length * 0.75) return "inconsistent-lines";
  if (supportedCount < glyphs.length * 0.6 || spread < height * 0.15) return "insufficient-text";
  return undefined;
}

/**
 * Estimate a correction from text-like ink, then require agreement between
 * multiple text lines. Diagram-only or ambiguous pages are left unchanged.
 * Input is a white-backed analysis image, at most 1000 pixels per side.
 */
export function estimateSkew(
  image: { width: number; height: number; data: Uint8ClampedArray },
  maxDegrees = 5,
): DeskewEstimate {
  const { width, height } = image;
  const limit = Math.max(0, Math.min(5, maxDegrees));
  if (!limit) return { angle: 0, status: "disabled" };
  if (width < 20 || height < 20) return { angle: 0, status: "insufficient-text" };
  const { glyphs, labels } = textComponents(image);
  if (glyphs.length < 30) return { angle: 0, status: "insufficient-text" };
  const selected = new Set(glyphs.map(glyph => glyph.id));
  const points: number[] = [];
  for (let index = 0; index < labels.length; index++) {
    if (selected.has(labels[index]))
      points.push(index % width - width / 2, Math.floor(index / width) - height / 2);
  }
  const padding = Math.ceil(width * Math.sin(limit * Math.PI / 180)) + 2;
  const score = (angle: number) => {
    const radians = angle * Math.PI / 180;
    const sin = Math.sin(radians), cos = Math.cos(radians);
    const rows = new Float64Array(height + 2 * padding + 2);
    for (let i = 0; i < points.length; i += 2) {
      const y = points[i] * sin + points[i + 1] * cos + height / 2 + padding;
      const row = Math.floor(y), fraction = y - row;
      rows[row] += 1 - fraction;
      rows[row + 1] += fraction;
    }
    return rows.reduce((sum, value) => sum + value * value, 0);
  };
  const baseline = score(0);
  const evaluated: Array<{ angle: number; score: number }> = [];
  let bestAngle = 0, bestScore = baseline;
  const consider = (angle: number) => {
    const value = score(angle);
    evaluated.push({ angle, score: value });
    if (value > bestScore * (1 + 1e-10)) {
      bestScore = value; bestAngle = angle;
    }
  };
  for (let angle = -limit; angle <= limit + 1e-6; angle += 0.5) consider(angle);
  const coarse = bestAngle;
  for (let angle = Math.max(-limit, coarse - 0.5); angle <= Math.min(limit, coarse + 0.5) + 1e-6; angle += 0.1)
    consider(angle);
  // Two strong, distinct peaks indicate conflicting text/diagram directions.
  const ambiguous = evaluated.some(candidate =>
    Math.abs(candidate.angle - bestAngle) >= 1 && candidate.score >= bestScore * 0.92);
  const lineStatus = textLineStatus(glyphs, bestAngle, width, height);
  if (lineStatus) return { angle: 0, status: lineStatus };
  if (ambiguous) return { angle: 0, status: "inconsistent-lines" };
  if (Math.abs(bestAngle) < 0.1) return { angle: 0, status: "aligned" };
  if (bestScore <= baseline * 1.02) return { angle: 0, status: "low-improvement" };
  return { angle: Math.round(bestAngle * 10) / 10, status: "corrected" };
}


/** Numeric API for callers that only need the applied correction. */
export function estimateSkewAngle(
  image: { width: number; height: number; data: Uint8ClampedArray },
  maxDegrees = 5,
): number {
  return estimateSkew(image, maxDegrees).angle;
}
