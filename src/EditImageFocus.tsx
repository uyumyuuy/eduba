import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { OcrLine, Rect } from "./domain";

type Glyph = { text: string; bbox: Rect };
const width = (box: Rect) => box.right - box.left;
const valid = (box: Rect | undefined): box is Rect => Boolean(box &&
  [box.left, box.top, box.right, box.bottom].every(Number.isFinite) && box.right > box.left && box.bottom > box.top);
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function sourceGlyphs(line: OcrLine): Glyph[] {
  const glyphs: Glyph[] = [];
  for (const [wordIndex, word] of line.words.entries()) {
    if (wordIndex) {
      const previous = line.words[wordIndex - 1].bbox;
      glyphs.push({ text: " ", bbox: { left: previous.right, right: Math.max(previous.right + 1, word.bbox.left),
        top: Math.min(previous.top, word.bbox.top), bottom: Math.max(previous.bottom, word.bbox.bottom) } });
    }
    const chars = Array.from(word.originalText);
    let charIndex = 0;
    for (const char of word.chars) {
      const points = Array.from(char.originalText);
      for (const point of points) {
        const fallback = { ...word.bbox,
          left: word.bbox.left + width(word.bbox) * charIndex / Math.max(1, chars.length),
          right: word.bbox.left + width(word.bbox) * (charIndex + 1) / Math.max(1, chars.length) };
        glyphs.push({ text: point, bbox: valid(char.bbox) ? char.bbox : fallback });
        charIndex++;
      }
    }
    // Some hOCR producers omit character boxes entirely.
    if (!word.chars.length) chars.forEach((point, index) => glyphs.push({ text: point, bbox: {
      ...word.bbox, left: word.bbox.left + width(word.bbox) * index / chars.length,
      right: word.bbox.left + width(word.bbox) * (index + 1) / chars.length,
    } }));
  }
  return glyphs;
}

/** Position a UTF-16 textarea caret on the original scan, using OCR boxes where available. */
export function caretImagePosition(line: OcrLine, offset: number): { x: number; bbox: Rect } {
  const corrected = Array.from(line.correctedText);
  const source = Array.from(line.originalText);
  const glyphs = sourceGlyphs(line);
  const caret = Array.from(line.correctedText.slice(0, clamp(offset, 0, line.correctedText.length))).length;
  const proportional = (index: number) => line.bbox.left + width(line.bbox) * index / Math.max(1, corrected.length);
  if (!glyphs.length || glyphs.map(glyph => glyph.text).join("") !== line.originalText ||
    corrected.length * source.length > 600_000) {
    const x = proportional(caret);
    const step = width(line.bbox) / Math.max(1, corrected.length);
    return { x, bbox: { ...line.bbox, left: clamp(x, line.bbox.left, line.bbox.right - 1),
      right: clamp(x + Math.max(1, step), line.bbox.left + 1, line.bbox.right) } };
  }
  if (line.correctedText === line.originalText) {
    const glyph = glyphs[Math.min(caret, glyphs.length - 1)];
    return { x: caret === glyphs.length ? glyph.bbox.right : glyph.bbox.left, bbox: glyph.bbox };
  }
  // Match unchanged code points, then interpolate only inside edited spans.
  const table = Array.from({ length: corrected.length + 1 }, () => new Uint16Array(source.length + 1));
  for (let i = corrected.length - 1; i >= 0; i--) for (let j = source.length - 1; j >= 0; j--)
    table[i][j] = corrected[i] === source[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const matches: Array<[number, number]> = [];
  let i = 0, j = 0;
  while (i < corrected.length && j < source.length) {
    if (corrected[i] === source[j]) { matches.push([i++, j++]); }
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  const following = matches.find(([correctedIndex]) => correctedIndex >= caret);
  const preceding = [...matches].reverse().find(([correctedIndex]) => correctedIndex < caret);
  const beforeX = preceding ? glyphs[preceding[1]].bbox.right : glyphs[0].bbox.left;
  const afterX = following ? glyphs[following[1]].bbox.left : glyphs.at(-1)!.bbox.right;
  const span = (following?.[0] ?? corrected.length) - (preceding?.[0] ?? -1);
  const fraction = (caret - (preceding?.[0] ?? -1)) / Math.max(1, span);
  const x = following?.[0] === caret ? afterX : beforeX + (afterX - beforeX) * fraction;
  const glyph = following ? glyphs[following[1]] : preceding ? glyphs[preceding[1]] : glyphs[Math.min(caret, glyphs.length - 1)];
  return { x: clamp(x, line.bbox.left, line.bbox.right), bbox: glyph.bbox };
}

export function EditImageFocus({ line, caret, zoom, pageWidth, sourceRef }: {
  line: OcrLine; caret: number; zoom: number; pageWidth: number; sourceRef: RefObject<HTMLCanvasElement | null>;
}) {
  const magnifierRef = useRef<HTMLCanvasElement>(null);
  const focus = useMemo(() => caretImagePosition(line, caret), [line, caret]);
  const image = sourceRef.current;
  const lineHeight = Math.max(1, line.bbox.bottom - line.bbox.top);
  // Keep both the viewport and magnification constant as the caret moves.
  const magnification = 3;
  const displayWidth = Math.min(250, Math.max(1, pageWidth * zoom - 8));
  const displayHeight = 84;
  const cropWidth = displayWidth / (zoom * magnification);
  const cropHeight = displayHeight / (zoom * magnification);
  const imageWidth = image?.width ?? pageWidth;
  const imageHeight = image?.height ?? line.bbox.bottom;
  const visibleWidth = Math.min(cropWidth, imageWidth);
  const visibleHeight = Math.min(cropHeight, imageHeight);
  const cropLeft = clamp(focus.x - cropWidth / 2, 0, Math.max(0, imageWidth - visibleWidth));
  const cropTop = clamp((line.bbox.top + line.bbox.bottom) / 2 - cropHeight / 2, 0, Math.max(0, imageHeight - visibleHeight));
  const left = clamp(focus.x * zoom - displayWidth / 2, 0, Math.max(0, pageWidth * zoom - displayWidth));
  const top = Math.max(0, line.bbox.top * zoom - displayHeight - 10);
  useLayoutEffect(() => {
    const target = magnifierRef.current, source = sourceRef.current;
    if (!target || !source?.width || !source.height) return;
    target.width = Math.max(1, Math.round(displayWidth * 2));
    target.height = Math.max(1, Math.round(displayHeight * 2));
    const context = target.getContext("2d");
    if (!context) return;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, target.width, target.height);
    context.imageSmoothingEnabled = true;
    const drawnWidth = visibleWidth / cropWidth * target.width;
    const drawnHeight = visibleHeight / cropHeight * target.height;
    context.drawImage(source, cropLeft, cropTop, visibleWidth, visibleHeight,
      (target.width - drawnWidth) / 2, (target.height - drawnHeight) / 2, drawnWidth, drawnHeight);
  }, [cropHeight, cropLeft, cropTop, cropWidth, displayHeight, displayWidth, sourceRef, visibleHeight, visibleWidth]);
  return <>
    <svg className="edit-image-focus" viewBox={`0 0 ${image?.width ?? pageWidth} ${image?.height ?? 1}`} aria-hidden="true">
      <rect className="edit-image-focus-line" x={line.bbox.left} y={line.bbox.top}
        width={Math.max(1, width(line.bbox))} height={lineHeight} />
      <line className="edit-image-focus-underline" x1={focus.bbox.left} x2={focus.bbox.right}
        y1={line.bbox.bottom} y2={line.bbox.bottom} />
    </svg>
    <canvas ref={magnifierRef} className="edit-image-magnifier" aria-hidden="true"
      style={{ left, top, width: displayWidth, height: displayHeight }} />
  </>;
}
