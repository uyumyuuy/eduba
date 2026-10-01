/**
 * Horizontal projection of foreground pixels. Ignore scan borders and prefer
 * zero when a correction does not materially improve text-line alignment.
 * Input is a downsampled, white-backed image, at most 1000 pixels per side.
 */
export function estimateSkewAngle(
  image: { width: number; height: number; data: Uint8ClampedArray },
  maxDegrees = 5,
): number {
  const { width, height, data } = image;
  const limit = Math.max(0, Math.min(5, maxDegrees));
  if (!limit || width < 20 || height < 20) return 0;
  const points: number[] = [];
  const borderX = Math.ceil(width * 0.04);
  const borderY = Math.ceil(height * 0.04);
  for (let y = borderY; y < height - borderY; y++) {
    for (let x = borderX; x < width - borderX; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 128 && (data[i] + data[i + 1] + data[i + 2]) / 3 < 180)
        points.push(x - width / 2, y - height / 2);
    }
  }
  const count = points.length / 2;
  // Blank, sparse, and predominantly dark pages offer no reliable text signal.
  if (count < Math.max(100, width * height * 0.001) || count > width * height * 0.5) return 0;
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
  let bestAngle = 0, bestScore = baseline;
  const consider = (angle: number) => {
    const value = score(angle);
    if (value > bestScore * (1 + 1e-10)) {
      bestScore = value; bestAngle = angle;
    }
  };
  for (let angle = -limit; angle <= limit + 1e-6; angle += 0.5) consider(angle);
  const coarse = bestAngle;
  for (let angle = Math.max(-limit, coarse - 0.5); angle <= Math.min(limit, coarse + 0.5) + 1e-6; angle += 0.1)
    consider(angle);
  return bestScore > baseline * 1.02 && Math.abs(bestAngle) >= 0.1
    ? Math.round(bestAngle * 10) / 10 : 0;
}
