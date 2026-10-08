/** Find a grapheme boundary near a clicked SVG line, including textLength and styled tspans. */
export function clickedLineCaret(text: SVGTextElement | null, value: string, clientX: number, fallback: {left:number;width:number}): number {
  if (!value) return 0;
  const boundaries = [...new Intl.Segmenter(undefined, {granularity:"grapheme"}).segment(value)].map(item=>item.index);
  boundaries.push(value.length);
  try {
    const matrix = text?.getScreenCTM();
    const count = text?.getNumberOfChars();
    if (text && matrix && count && (count === value.length || count === Array.from(value).length)) {
      let nearest = 0, distance = Infinity;
      for (const offset of boundaries) {
        const index = count === value.length ? offset : Array.from(value.slice(0,offset)).length;
        const point = index === count ? text.getEndPositionOfChar(count-1) : text.getStartPositionOfChar(index);
        const x = matrix.a*point.x + matrix.c*point.y + matrix.e;
        const candidateDistance = Math.abs(x-clientX);
        if (candidateDistance < distance) { nearest = offset; distance = candidateDistance; }
      }
      if (Number.isFinite(distance)) return nearest;
    }
  } catch { /* Missing browser geometry: use the line bounds without splitting a grapheme. */ }
  const rect = text?.getBoundingClientRect();
  const bounds = rect?.width ? rect : fallback;
  const fraction = bounds.width > 0 ? Math.max(0,Math.min(1,(clientX-bounds.left)/bounds.width)) : 0;
  return boundaries[Math.round(fraction*(boundaries.length-1))];
}
