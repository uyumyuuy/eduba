type Box = { left: number; top: number; right: number; bottom: number };

/** Prefer the requested position, then try above, below and beside protected content. */
export function overlayPosition(bounds: Box, preferred: { left: number; top: number }, width: number, height: number, obstacles: Box[] = []) {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  if (width > bounds.right - bounds.left || height > bounds.bottom - bounds.top) return null;
  const candidates = [preferred, ...obstacles.flatMap(box => [
    { left: preferred.left, top: box.top - height - 8 },
    { left: preferred.left, top: box.bottom + 8 },
    { left: box.left - width - 8, top: preferred.top },
    { left: box.right + 8, top: preferred.top },
  ])];
  for (const candidate of candidates) {
    const left = clamp(candidate.left, bounds.left, bounds.right - width);
    const top = clamp(candidate.top, bounds.top, bounds.bottom - height);
    if (obstacles.every(box => left + width <= box.left - 4 || left >= box.right + 4 ||
      top + height <= box.top - 4 || top >= box.bottom + 4)) return { left, top };
  }
  // A very small pane may have no free space. Never cover the editor.
  return null;
}
