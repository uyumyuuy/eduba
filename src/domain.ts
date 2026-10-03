import { identity, inverse, multiply, rotationTransform, type Affine, type HocrSource } from "./coordinates";
import { contentRuns } from "./pageContent";
import { estimateSkew, type DeskewEstimate } from "./deskew";
import type { OcrMargins } from "./ocrMargins";
/**
 * The small, serialisable document model shared by the OCR viewer and its
 * exporters. Coordinates are pixels in the source page (after any logical
 * page transform), with the origin at the top-left.
 */

import { t } from "./i18n";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Baseline {
  /** hOCR baseline intercept and slope, when supplied by Tesseract. */
  slope: number;
  intercept: number;
}

export type CharacterSource = "ocr" | "inserted";
export type HocrLineClass = "ocr_line" | "ocr_header" | "ocr_textfloat" | "ocr_caption";

export interface OcrChar {
  index: number;
  originalText: string;
  correctedText: string;
  /** Missing for inserted characters and any hOCR character without a box. */
  bbox?: Rect;
  confidence?: number;
  source: CharacterSource;
}

export interface OcrWord {
  id: string;
  bbox: Rect;
  confidence?: number;
  originalText: string;
  correctedText: string;
  chars: OcrChar[];
}

export type TextFormatKind = "bold" | "italic" | "superscript" | "subscript";
export interface TextFormatRange { start: number; end: number; kind: TextFormatKind; }

export interface OcrLine {
  id: string;
  /** Recognized hOCR line classes, retained when the corrected line is exported. */
  hocrClasses?: HocrLineClass[];
  bbox: Rect;
  baseline?: Baseline;
  fontSize?: number;
  ascenders?: number;
  descenders?: number;
  confidence?: number;
  originalText: string;
  correctedText: string;
  /** UTF-16 offsets matching textarea selection positions. */
  formatting?: TextFormatRange[];
  /** Script and word styles inferred from OCR. This is replaceable when recognition settings change. */
  autoFormatting?: TextFormatRange[];
  /** Text and script-format edits exclude this line from automatic detection. */
  scriptDetectionManuallyEdited?: boolean;
  words: OcrWord[];
  chars: OcrChar[];
  /** True when the line is rendered from approximate line geometry. */
  geometryApproximate: boolean;
  /** Original hOCR grouping retained when manual reading order splits containers. */
  readingOrderOrigin?: { blockId: string; paragraphId: string };
}

/** Manual script ranges override either inferred script kind; other manual ranges override the same kind. */
export function effectiveFormatting(line: OcrLine): TextFormatRange[] {
  const manual = line.formatting ?? [];
  const automatic = (line.autoFormatting ?? []).flatMap((range) => {
    let pieces = [range];
    // A manual range replaces the inferred value for the same kind.
    const overrides = range.kind === "superscript" || range.kind === "subscript"
      ? manual.filter(item => item.kind === "superscript" || item.kind === "subscript")
      : manual.filter(item => item.kind === range.kind);
    for (const override of overrides) {
      pieces = pieces.flatMap((piece) => {
        if (piece.end <= override.start || piece.start >= override.end) return [piece];
        return [
          ...(piece.start < override.start ? [{ ...piece, end: override.start }] : []),
          ...(piece.end > override.end ? [{ ...piece, start: override.end }] : []),
        ];
      });
    }
    return pieces;
  });
  return [...automatic, ...manual];
}
export interface Paragraph {
  id: string;
  bbox: Rect;
  lines: OcrLine[];
}

export interface PageBlock {
  id: string;
  bbox: Rect;
  paragraphs: Paragraph[];
}

export interface LogicalPageProvenance {
  sourcePage: number;
  split: "single" | "left" | "right";
  crop?: Rect;
  rotation: number;
  angle: number;
  /** Missing on legacy projects, whose deskew preceded spread splitting. */
  preprocessOrder?: "split-deskew" | "deskew-split";
  ocrMargins?: OcrMargins;
  /** Absent on older projects: automatic detection is disabled. */
  autoFigureDetection?: boolean;
}

export interface FigureRegion {
  id: string;
  kind: "figure" | "table";
  bbox: Rect;
}

export interface DocumentPage extends LogicalPageProvenance {
  id: string;
  width: number;
  height: number;
  sourceImage?: string;
  importMode?: "extract" | "render";
  resolvedImportMode?: "extract" | "render";
  sourceDpiX?: number;
  sourceDpiY?: number;
  blocks: PageBlock[];
  figureRegions?: FigureRegion[];
  /** Stable IDs of OCR lines and figures in their shared reading order. */
  readingOrderIds?: string[];
  /** One-shot manually selected OCR regions. Full-page OCR replaces this list. */
  manualOcrRegions?: { id: string; bbox: Rect; psm: 11 | 6; addedWordIds: string[]; addedLineIds: string[] }[];
  /** Removed OCR lines are retained only as a manual-change marker until full-page OCR. */
  deletedOcrLineIds?: string[];
  /** A user has changed the line reading order on this page. */
  manualReadingOrder?: boolean;
}

export interface HocrParseOptions {
  sourcePage?: number;
  pageId?: string;
}

const CLASS_NAMES = {
  page: "ocr_page",
  block: "ocr_carea",
  paragraph: "ocr_par",
  word: "ocrx_word",
  char: "ocrx_cinfo",
} as const;

const LINE_CLASSES = ["ocr_line", "ocr_header", "ocr_textfloat", "ocr_caption"] as const;

function childrenOf(element: Element, className: string): Element[] {
  return Array.from(element.querySelectorAll(`:scope > .${className}`));
}

function classes(element: Element, className: string): boolean {
  return element.classList.contains(className);
}

function titleValue(element: Element, key: string): string | undefined {
  const title = element.getAttribute("title") || "";
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = title.match(new RegExp(`(?:^|;\\s*)${escaped}\\s+([^;]+)`));
  return match?.[1]?.trim();
}

function numbers(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const parsed = value.trim().split(/\s+/).map(Number);
  return parsed.length && parsed.every(Number.isFinite) ? parsed : undefined;
}

function bbox(element: Element): Rect {
  const n = numbers(titleValue(element, "bbox"));
  if (!n || n.length < 4) return { left: 0, top: 0, right: 0, bottom: 0 };
  return { left: n[0], top: n[1], right: n[2], bottom: n[3] };
}

function confidence(element: Element, key = "x_wconf"): number | undefined {
  const n = numbers(titleValue(element, key));
  return n?.[0];
}

function parseBaseline(element: Element): Baseline | undefined {
  const n = numbers(titleValue(element, "baseline"));
  return n && n.length >= 2 ? { slope: n[0], intercept: n[1] } : undefined;
}

function classElements(root: ParentNode, className: string): Element[] {
  return Array.from(root.querySelectorAll(`.${className}`));
}

function normalizedText(element: Element): string {
  return (element.textContent || "").replace(/\s+/g, " ").trim();
}

function parseChars(wordElement: Element, original: string): OcrChar[] {
  const charElements = childrenOf(wordElement, CLASS_NAMES.char);
  if (!charElements.length) {
    return Array.from(original).map((text, index) => ({
      index,
      originalText: text,
      correctedText: text,
      source: "ocr",
    }));
  }
  return charElements.map((element, index) => {
    const raw = normalizedText(element);
    const charBox = numbers(titleValue(element, "x_bboxes"));
    return {
      index,
      originalText: raw,
      correctedText: raw,
      ...(charBox && charBox.length >= 4
        ? {
            bbox: {
              left: charBox[0],
              top: charBox[1],
              right: charBox[2],
              bottom: charBox[3],
            },
          }
        : {}),
      confidence: confidence(element, "x_conf"),
      source: "ocr" as const,
    };
  });
}

function parseWord(element: Element): OcrWord {
  const charElements = childrenOf(element, CLASS_NAMES.char);
  const displayedText = normalizedText(element);
  const chars = parseChars(element, displayedText);
  // XHTML indentation between cinfo spans is formatting, not OCR text. The
  // parent textContent therefore cannot be used when character boxes exist.
  const originalText = charElements.length
    ? chars.map((char) => char.originalText).join("")
    : displayedText;
  return {
    id: element.id || `word-${Math.random().toString(36).slice(2)}`,
    bbox: bbox(element),
    confidence: confidence(element),
    originalText,
    correctedText: originalText,
    chars,
  };
}

function lineText(words: OcrWord[], element: Element): string {
  // A line's text is reconstructed from words so that correction edits do not
  // depend on incidental whitespace/indentation in the XHTML source.
  if (words.length) return words.map((word) => word.originalText).join(" ");
  return normalizedText(element);
}

function charsFromWords(words: OcrWord[]): OcrChar[] {
  return words
    .flatMap((word, wordIndex) => {
      const result: OcrChar[] = word.chars.map((char) => ({
        ...char,
        index: 0,
      }));
      if (wordIndex && result.length)
        result.unshift({
          index: 0,
          originalText: " ",
          correctedText: " ",
          source: "ocr",
        });
      return result;
    })
    .map((char, index) => ({ ...char, index }));
}

function parseLine(element: Element): OcrLine {
  const words = childrenOf(element, CLASS_NAMES.word).map(parseWord);
  const originalText = lineText(words, element);
  const chars = charsFromWords(words);
  return {
    id: element.id || `line-${Math.random().toString(36).slice(2)}`,
    hocrClasses: Array.from(element.classList).filter((name): name is HocrLineClass => LINE_CLASSES.includes(name as HocrLineClass)),
    bbox: bbox(element),
    baseline: parseBaseline(element),
    fontSize: numbers(titleValue(element, "x_size"))?.[0],
    ascenders: numbers(titleValue(element, "x_ascenders"))?.[0],
    descenders: numbers(titleValue(element, "x_descenders"))?.[0],
    confidence: words.length
      ? words.reduce((sum, word) => sum + (word.confidence ?? 0), 0) /
        words.length
      : undefined,
    originalText,
    correctedText: originalText,
    words,
    chars,
    geometryApproximate: false,
  };
}

function parseParagraph(element: Element): Paragraph {
  const lines = Array.from(element.children)
    .filter((child) => LINE_CLASSES.some((name) => child.classList.contains(name)))
    .map(parseLine);
  return {
    id: element.id || `paragraph-${Math.random().toString(36).slice(2)}`,
    bbox: bbox(element),
    lines,
  };
}

function parseBlock(element: Element): PageBlock {
  const paragraphs = childrenOf(element, CLASS_NAMES.paragraph).map(
    parseParagraph,
  );
  return {
    id: element.id || `block-${Math.random().toString(36).slice(2)}`,
    bbox: bbox(element),
    paragraphs,
  };
}

function parsePage(
  element: Element,
  options: HocrParseOptions,
  pageIndex: number,
): DocumentPage {
  const size = numbers(titleValue(element, "bbox"));
  const blocks = childrenOf(element, CLASS_NAMES.block).map(parseBlock);
  const sourcePage = options.sourcePage ?? pageIndex;
  return {
    id: options.pageId || element.id || `page-${sourcePage}`,
    sourcePage,
    split: "single",
    rotation: 0,
    angle: 0,
    width: size?.[2] || 0,
    height: size?.[3] || 0,
    blocks,
  };
}

/** Parse one or more hOCR pages in document reading order. */
export function parseHocr(
  source: string,
  options: HocrParseOptions = {},
): DocumentPage[] {
  if (typeof DOMParser === "undefined")
    throw new Error(t("errors.domParser"));
  const document = new DOMParser().parseFromString(
    source,
    "application/xhtml+xml",
  );
  const pages = classElements(document, CLASS_NAMES.page);
  if (!pages.length) throw new Error(t("errors.hocrPage"));
  return pages.map((page, index) => {
    const parsed = parsePage(page, options, index);
    if (options.pageId && pages.length > 1)
      parsed.id = `${options.pageId}--p${index + 1}`;
    const prefix = parsed.id;
    // hOCR producers commonly restart IDs at page 1. Keep DOM IDs readable
    // while making them unique for React keys and project JSON.
    for (const block of parsed.blocks) {
      block.id = `${prefix}--${block.id}`;
      for (const paragraph of block.paragraphs) {
        paragraph.id = `${prefix}--${paragraph.id}`;
        for (const line of paragraph.lines) {
          line.id = `${prefix}--${line.id}`;
          for (const word of line.words) word.id = `${prefix}--${word.id}`;
        }
      }
    }
    return parsed;
  });
}

export function allLines(page: DocumentPage): OcrLine[] {
  return page.blocks.flatMap((block) =>
    block.paragraphs.flatMap((paragraph) => paragraph.lines),
  );
}


// Split support intentionally keeps OCR boxes only when their source characters have them.
function unionBoxes(boxes: (Rect | undefined)[]): Rect | undefined {
  const present = boxes.filter((box): box is Rect => box != null);
  if (!present.length) return undefined;
  return {
    left: Math.min(...present.map(box => box.left)),
    top: Math.min(...present.map(box => box.top)),
    right: Math.max(...present.map(box => box.right)),
    bottom: Math.max(...present.map(box => box.bottom)),
  };
}

function nextSplitId(base: string, ids: Set<string>): string {
  let number = 1;
  let candidate = base + "--split";
  while (ids.has(candidate)) candidate = base + "--split-" + (++number);
  ids.add(candidate);
  return candidate;
}

function splitFormattingAt(ranges: TextFormatRange[] | undefined, offset: number): [TextFormatRange[] | undefined, TextFormatRange[] | undefined] {
  if (!ranges?.length) return [undefined, undefined];
  const left = ranges.flatMap(range => range.start < offset ? [{ ...range, end: Math.min(range.end, offset) }] : []).filter(range => range.end > range.start);
  const right = ranges.flatMap(range => range.end > offset ? [{ ...range, start: Math.max(0, range.start - offset), end: range.end - offset }] : []).filter(range => range.end > range.start);
  return [left.length ? left : undefined, right.length ? right : undefined];
}

function splitCorrectedChars(chars: OcrChar[], offset: number): [OcrChar[], OcrChar[]] | undefined {
  let position = 0;
  const left: OcrChar[] = [], right: OcrChar[] = [];
  for (const char of chars) {
    const end = position + char.correctedText.length;
    if (position < offset && offset < end) return undefined;
    (end <= offset ? left : right).push(char);
    position = end;
  }
  return [left, right];
}

function codePointOffset(text: string, utf16Offset: number): number | undefined {
  let position = 0;
  let points = 0;
  for (const char of Array.from(text)) {
    if (position === utf16Offset) return points;
    position += char.length;
    points++;
  }
  return position === utf16Offset ? points : undefined;
}

function utf16Offset(text: string[], pointOffset: number): number {
  return text.slice(0, pointOffset).join("").length;
}

/** Maps a corrected caret to original OCR text through exact LCS anchors.
 * A split is rejected if an entirely replaced region has no reliable anchor. */
function alignedOriginalOffset(line: OcrLine, correctedOffset: number): number | undefined {
  if (line.correctedText === line.originalText) return correctedOffset;
  const corrected = Array.from(line.correctedText);
  const original = Array.from(line.originalText);
  const caret = codePointOffset(line.correctedText, correctedOffset);
  if (caret == null || !corrected.length || !original.length || corrected.length * original.length > 1_000_000) return undefined;

  const table = Array.from({ length: corrected.length + 1 }, () => new Uint16Array(original.length + 1));
  for (let c = corrected.length - 1; c >= 0; c--) {
    for (let o = original.length - 1; o >= 0; o--) {
      table[c][o] = corrected[c] === original[o]
        ? table[c + 1][o + 1] + 1
        : Math.max(table[c + 1][o], table[c][o + 1]);
    }
  }

  const matches: Array<[number, number]> = [];
  for (let c = 0, o = 0; c < corrected.length && o < original.length;) {
    if (corrected[c] === original[o]) {
      matches.push([c++, o++]);
    } else if (table[c + 1][o] >= table[c][o + 1]) {
      c++;
    } else {
      o++;
    }
  }
  const previous = [...matches].reverse().find(([correctedIndex]) => correctedIndex < caret);
  const next = matches.find(([correctedIndex]) => correctedIndex >= caret);
  if (!previous && !next) return undefined;
  // Insertions follow their previous unchanged character; leading insertions
  // precede their next unchanged character.
  return utf16Offset(original, previous ? previous[1] + 1 : next![1]);
}

function splitWordAt(word: OcrWord, offset: number, wordIds: Set<string>): [OcrWord | undefined, OcrWord | undefined] | undefined {
  if (offset <= 0) return [undefined, { ...word, chars: word.chars.map((char, index) => ({ ...char, index })) }];
  if (offset >= word.originalText.length) return [{ ...word, chars: word.chars.map((char, index) => ({ ...char, index })) }, undefined];

  let position = 0;
  const leftChars: OcrChar[] = [], rightChars: OcrChar[] = [];
  for (const char of word.chars) {
    const end = position + char.originalText.length;
    if (position < offset && offset < end) return undefined;
    (end <= offset ? leftChars : rightChars).push(char);
    position = end;
  }
  if (position !== word.originalText.length) return undefined;

  const part = (chars: OcrChar[], text: string, id: string, start: number, end: number): OcrWord | undefined => {
    if (!text) return undefined;
    const allBoxed = chars.length > 0 && chars.every(char => char.bbox);
    const width = word.bbox.right - word.bbox.left;
    const proportional = {
      ...word.bbox,
      left: word.bbox.left + width * start / word.originalText.length,
      right: word.bbox.left + width * end / word.originalText.length,
    };
    return {
      ...word,
      id,
      bbox: allBoxed ? unionBoxes(chars.map(char => char.bbox))! : proportional,
      originalText: text,
      correctedText: text,
      chars: chars.map((char, index) => ({ ...char, index })),
    };
  };

  return [
    part(leftChars, word.originalText.slice(0, offset), word.id, 0, offset),
    part(rightChars, word.originalText.slice(offset), nextSplitId(word.id, wordIds), offset, word.originalText.length),
  ];
}

function lineBox(words: OcrWord[], fallback: Rect): { bbox: Rect; approximate: boolean } {
  const chars = words.flatMap(word => word.chars);
  if (chars.length > 0 && chars.every(char => char.bbox)) {
    return { bbox: unionBoxes(chars.map(char => char.bbox))!, approximate: false };
  }
  return { bbox: unionBoxes(words.map(word => word.bbox)) ?? fallback, approximate: true };
}

/** Split a line at a textarea caret. The child lines remain adjacent in the
 * original paragraph, preserving hOCR reading order and exporter order. */
export function splitLineAtCaret(page: DocumentPage, lineId: string, correctedOffset: number): DocumentPage {
  const source = allLines(page).find(line => line.id === lineId);
  if (!source || correctedOffset <= 0 || correctedOffset >= source.correctedText.length || source.chars.map(char => char.correctedText).join("") !== source.correctedText) return page;
  const copy: DocumentPage = JSON.parse(JSON.stringify(page)) as DocumentPage;
  const lineIds = new Set(allLines(copy).map(line => line.id));
  const wordIds = new Set(allLines(copy).flatMap(line => line.words.map(word => word.id)));

  for (const block of copy.blocks) for (const paragraph of block.paragraphs) {
    const index = paragraph.lines.findIndex(line => line.id === lineId);
    if (index < 0) continue;
    const line = paragraph.lines[index];
    if (correctedOffset <= 0 || correctedOffset >= line.correctedText.length) return page;

    const originalOffset = alignedOriginalOffset(line, correctedOffset);
    const leftText = line.correctedText.slice(0, correctedOffset).replace(/\s+$/, "");
    const rightText = line.correctedText.slice(correctedOffset).replace(/^\s+/, "");
    const leftOffset = leftText.length;
    const rightOffset = line.correctedText.length - rightText.length;
    const leftChars = splitCorrectedChars(line.chars, leftOffset);
    const rightChars = splitCorrectedChars(line.chars, rightOffset);
    if (originalOffset == null || originalOffset <= 0 || originalOffset >= line.originalText.length || !leftChars || !rightChars || !leftText || !rightText) return page;

    const leftWords: OcrWord[] = [];
    const rightWords: OcrWord[] = [];
    let position = 0;
    for (const word of line.words) {
      const end = position + word.originalText.length;
      if (end <= originalOffset) {
        leftWords.push({ ...word, chars: word.chars.map((char, charIndex) => ({ ...char, index: charIndex })) });
      } else if (position >= originalOffset) {
        rightWords.push({ ...word, chars: word.chars.map((char, charIndex) => ({ ...char, index: charIndex })) });
      } else {
        const split = splitWordAt(word, originalOffset - position, wordIds);
        if (!split) return page;
        if (split[0]) leftWords.push(split[0]);
        if (split[1]) rightWords.push(split[1]);
      }
      position = end + 1; // Parsed hOCR words are reconstructed with one space.
    }
    // An inserted-only side has no honest OCR geometry to display or export.
    if (!leftWords.length || !rightWords.length) return page;

    const [leftFormatting] = splitFormattingAt(line.formatting, leftOffset);
    const [, rightFormatting] = splitFormattingAt(line.formatting, rightOffset);
    const [leftAutoFormatting] = splitFormattingAt(line.autoFormatting, leftOffset);
    const [, rightAutoFormatting] = splitFormattingAt(line.autoFormatting, rightOffset);
    const makeLine = (right: boolean, words: OcrWord[], chars: OcrChar[], correctedText: string, originalText: string, formatting: TextFormatRange[] | undefined, autoFormatting: TextFormatRange[] | undefined): OcrLine => {
      const geometry = lineBox(words, line.bbox);
      const baselineY = line.baseline
        ? line.bbox.bottom + line.baseline.intercept + line.baseline.slope * (geometry.bbox.left - line.bbox.left)
        : undefined;
      return {
        ...line,
        id: right ? nextSplitId(line.id, lineIds) : line.id,
        bbox: geometry.bbox,
        baseline: line.baseline && baselineY != null ? { ...line.baseline, intercept: baselineY - geometry.bbox.bottom } : undefined,
        confidence: words.length ? words.reduce((sum, word) => sum + (word.confidence ?? 0), 0) / words.length : undefined,
        originalText,
        correctedText,
        formatting,
        autoFormatting,
        words,
        chars: chars.map((char, charIndex) => ({ ...char, index: charIndex })),
        geometryApproximate: line.geometryApproximate || geometry.approximate,
        scriptDetectionManuallyEdited: true,
      };
    };
    paragraph.lines.splice(index, 1,
      makeLine(false, leftWords, leftChars[0], leftText, line.originalText.slice(0, originalOffset).replace(/\s+$/, ""), leftFormatting, leftAutoFormatting),
      makeLine(true, rightWords, rightChars[1], rightText, line.originalText.slice(originalOffset).replace(/^\s+/, ""), rightFormatting, rightAutoFormatting),
    );
    return copy;
  }
  return copy;
}

function remapFormatting(ranges: TextFormatRange[] | undefined, before: string, after: string): TextFormatRange[] | undefined {
  if (!ranges?.length || before === after) return ranges;
  let prefix = 0; while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let beforeEnd = before.length, afterEnd = after.length;
  while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) { beforeEnd--; afterEnd--; }
  const delta = afterEnd - beforeEnd;
  const next = ranges.flatMap(range => {
    if (range.end <= prefix) return [range];
    if (range.start >= beforeEnd) return [{ ...range, start: range.start + delta, end: range.end + delta }];
    const pieces: TextFormatRange[] = [];
    if (range.start < prefix) pieces.push({ ...range, end: prefix });
    if (range.end > beforeEnd) pieces.push({ ...range, start: afterEnd, end: range.end + delta });
    return pieces;
  }).filter(range => range.end > range.start);
  return next.length ? next : undefined;
}

export function updateLineFormatting(page: DocumentPage, lineId: string, start: number, end: number, kind: TextFormatKind): DocumentPage {
  const copy: DocumentPage = JSON.parse(JSON.stringify(page)) as DocumentPage;
  const line = allLines(copy).find(candidate => candidate.id === lineId);
  if (!line || start >= end) return copy;
  // A manual edit takes ownership of all currently rendered formatting on this line.
  const rendered = effectiveFormatting(line);
  line.formatting = rendered.length ? rendered : undefined;
  line.autoFormatting = undefined;
  line.scriptDetectionManuallyEdited = true;
  const opposite = kind === "superscript" ? "subscript" : kind === "subscript" ? "superscript" : undefined;
  const ranges = (line.formatting ?? []).flatMap(range => opposite !== range.kind || range.end <= start || range.start >= end ? [range] : [{ ...range, end: start }, { ...range, start: end }]).filter(range => range.end > range.start);
  const same = ranges.filter(range => range.kind === kind);
  const fullyFormatted = same.some(range => range.start <= start && range.end >= end);
  line.formatting = fullyFormatted ? ranges.flatMap(range => range.kind !== kind || range.end <= start || range.start >= end ? [range] : [{ ...range, end: start }, { ...range, start: end }]).filter(range => range.end > range.start) : [...ranges, { start, end, kind }];
  return copy;
}

/**
 * Sets a formatting range to a known state. Unlike updateLineFormatting this
 * is not a toggle, so it can be replayed over every bulk replacement.
 */
export function setLineFormatting(page: DocumentPage, lineId: string, start: number, end: number, kind: TextFormatKind, enabled: boolean): DocumentPage {
  const copy: DocumentPage = JSON.parse(JSON.stringify(page)) as DocumentPage;
  const line = allLines(copy).find(candidate => candidate.id === lineId);
  if (!line || start >= end) return copy;
  // A manual edit takes ownership of all currently rendered formatting on this line.
  const rendered = effectiveFormatting(line);
  line.formatting = rendered.length ? rendered : undefined;
  line.autoFormatting = undefined;
  line.scriptDetectionManuallyEdited = true;
  const opposite = kind === "superscript" ? "subscript" : kind === "subscript" ? "superscript" : undefined;
  const removed = (line.formatting ?? []).flatMap(range => {
    const remove = range.kind === kind || (enabled && range.kind === opposite);
    if (!remove || range.end <= start || range.start >= end) return [range];
    return [{ ...range, end: start }, { ...range, start: end }];
  }).filter(range => range.end > range.start);
  line.formatting = enabled ? [...removed, { start, end, kind }] : removed;
  return copy;
}

/** Removes every decoration from a replacement range before its editor formatting is applied. */
export function clearLineFormatting(page: DocumentPage, lineId: string, start: number, end: number): DocumentPage {
  let next = page;
  for (const kind of ["bold", "italic", "superscript", "subscript"] as const) next = setLineFormatting(next, lineId, start, end, kind, false);
  return next;
}
export function updateLineText(
  page: DocumentPage,
  lineId: string,
  correctedText: string,
): DocumentPage {
  const copy: DocumentPage = JSON.parse(JSON.stringify(page)) as DocumentPage;
  const line = allLines(copy).find((candidate) => candidate.id === lineId);
  if (!line) throw new Error(t("errors.unknownLine", { id: lineId }));
  line.formatting = remapFormatting(effectiveFormatting(line), line.correctedText, correctedText);
  line.autoFormatting = undefined;
  line.scriptDetectionManuallyEdited = true;
  line.correctedText = correctedText;
  if (correctedText === line.originalText) {
    line.chars = charsFromWords(line.words);
    line.geometryApproximate = false;
    return copy;
  }
  // A positional character mapping becomes incorrect as soon as insertion,
  // deletion, or replacement shifts later graphemes. Preserve recognition
  // geometry in words/originalText, and mark every corrected grapheme as
  // inserted until a deliberate alignment pass can establish safe boxes.
  line.chars = Array.from(correctedText).map((text, index) => ({
    index,
    originalText: "",
    correctedText: text,
    source: "inserted" as const,
  }));
  line.geometryApproximate = true;
  return copy;
}

export function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
}

function paragraphLines(page: DocumentPage): OcrLine[] {
  return page.blocks.flatMap((block) =>
    block.paragraphs.flatMap((paragraph) => paragraph.lines),
  );
}

export function exportText(pages: DocumentPage[]): string {
  return pages
    .map((page) =>
      page.blocks
        .map((block) =>
          block.paragraphs
            .map((paragraph) =>
              paragraph.lines.map((line) => line.correctedText).join("\n"),
            )
            .join("\n\n"),
        )
        .join("\n\n"),
    )
    .join("\n\n\n");
}

function titleBbox(rect: Rect): string {
  return `bbox ${rect.left} ${rect.top} ${rect.right} ${rect.bottom}`;
}

export function formattedSegments(line: OcrLine, svg = false): string {
  const ranges = effectiveFormatting(line);
  if (!ranges.length) return escapeXml(line.correctedText);
  const points = [...new Set([0, line.correctedText.length, ...ranges.flatMap(range => [range.start, range.end])])].sort((a,b)=>a-b);
  return points.slice(0,-1).map((start,index) => { const end=points[index+1]; const active=ranges.filter(range=>range.start<=start&&range.end>=end).map(range=>range.kind); let text=escapeXml(line.correctedText.slice(start,end)); if(svg){const style=[active.includes("bold")?"font-weight=\"bold\"":"",active.includes("italic")?"font-style=\"italic\"":"",active.includes("superscript")?"baseline-shift=\"0.54em\" font-size=\"70%\"":"",active.includes("subscript")?"baseline-shift=\"-0.15em\" font-size=\"70%\"":""].filter(Boolean).join(" ");return style?`<tspan ${style}>${text}</tspan>`:text;} if(active.includes("bold"))text=`<strong>${text}</strong>`;if(active.includes("italic"))text=`<em>${text}</em>`;if(active.includes("superscript"))text=`<sup>${text}</sup>`;if(active.includes("subscript"))text=`<sub>${text}</sub>`;return text; }).join("");
}
function formatHocrRange(line: OcrLine, start: number, end: number): string {
  const ranges = effectiveFormatting(line).filter(range => range.start < end && range.end > start);
  const points = [...new Set([start, end, ...ranges.flatMap(range => [Math.max(start, range.start), Math.min(end, range.end)])])].sort((a,b) => a-b);
  return points.slice(0, -1).map((from, index) => {
    const to = points[index + 1];
    const active = ranges.filter(range => range.start <= from && range.end >= to).map(range => range.kind);
    let text = escapeXml(line.correctedText.slice(from, to));
    if (active.includes("bold")) text = `<strong>${text}</strong>`;
    if (active.includes("italic")) text = `<em>${text}</em>`;
    if (active.includes("superscript")) text = `<sup>${text}</sup>`;
    if (active.includes("subscript")) text = `<sub>${text}</sub>`;
    return text;
  }).join("");
}
function exportHocrBlocks(blocks: PageBlock[]): string {
  return blocks
        .map((block) => {
          const paragraphs = block.paragraphs
            .map((paragraph) => {
              const lines = paragraph.lines
                .map((line) => {
                  const words = line.words
                    .map((word, wordIndex) => {
                      const wordStart = line.words.slice(0, wordIndex).reduce((sum, prior) => sum + prior.correctedText.length, wordIndex);
                      let charOffset = wordStart;
                      const chars = word.chars
                        .filter((char) => char.source === "ocr" || char.bbox)
                        .map((char) => {
                          const title = char.bbox
                            ? `x_bboxes ${char.bbox.left} ${char.bbox.top} ${char.bbox.right} ${char.bbox.bottom}${char.confidence == null ? "" : `; x_conf ${char.confidence}`}`
                            : "";
                          const start = charOffset;
                          charOffset += char.correctedText.length;
                          return `<span class="ocrx_cinfo"${title ? ` title="${escapeXml(title)}"` : ""}>${formatHocrRange(line, start, charOffset)}</span>`;
                        })
                        .join("");
                      const text = chars || formatHocrRange(line, wordStart, wordStart + word.correctedText.length);
                      const confidenceTitle =
                        word.confidence == null
                          ? ""
                          : `; x_wconf ${word.confidence}`;
                      return `<span class="ocrx_word" id="${escapeXml(word.id)}" title="${escapeXml(titleBbox(word.bbox) + confidenceTitle)}">${text}</span>`;
                    })
                    .join(" ");
                  // Once an edit changes a line, old per-word boxes no longer describe
                  // the corrected string. Emit one unboxed word so hOCR remains useful
                  // without inventing character geometry.
                  const lineContent =
                    line.correctedText !== line.originalText
                      ? `<span class="ocrx_word" title="${escapeXml(titleBbox(line.bbox))}">${formattedSegments(line)}</span>`
                      : words || escapeXml(line.correctedText);
                  const details = [
                    titleBbox(line.bbox),
                    line.baseline
                      ? `baseline ${line.baseline.slope} ${line.baseline.intercept}`
                      : "",
                    line.fontSize == null ? "" : `x_size ${line.fontSize}`,
                  ]
                    .filter(Boolean)
                    .join("; ");
                  const lineClasses = line.hocrClasses?.length
                    ? line.hocrClasses.join(" ")
                    : "ocr_line";
                  return `<span class="${escapeXml(lineClasses)}" id="${escapeXml(line.id)}" title="${escapeXml(details)}">${lineContent}</span>`;
                })
                .join("\n");
              return `<p class="ocr_par" id="${escapeXml(paragraph.id)}" title="${escapeXml(titleBbox(paragraph.bbox))}">${lines}</p>`;
            })
            .join("\n");
          return `<div class="ocr_carea" id="${escapeXml(block.id)}" title="${escapeXml(titleBbox(block.bbox))}">${paragraphs}</div>`;
        })
        .join("\n");
}

/** Output contract: docs/hocr-output-spec.md. Update it whenever this format changes. */
export function exportHocr(pages: DocumentPage[], source: HocrSource): string {
  const validFingerprint = !!source && /^[a-zA-Z0-9-]+$/.test(source.fingerprint);
  const validBytes = !!source && Number.isSafeInteger(source.byteLength) && source.byteLength > 0;
  let incomplete = false;
  const body = pages.map((page, index) => {
    const properties = [titleBbox({ left: 0, top: 0, right: page.width, bottom: page.height }), `ppageno ${index}`];
    const validPage = Number.isInteger(page.sourcePage) && page.sourcePage > 0;
    if (validFingerprint) properties.push(`x_edubapdffingerprint "${source.fingerprint}"`);
    if (validBytes) properties.push(`x_edubapdfbytes ${source.byteLength}`);
    if (validPage) properties.push(`x_edubasourcepage ${page.sourcePage}`);
    if (validPage && validFingerprint) properties.push(`x_source "pdf:${source.fingerprint}" "${page.sourcePage}"`);
    if (["single", "left", "right"].includes(page.split)) properties.push(`x_edubasplit ${page.split}`);
    if (Number.isFinite(page.rotation)) properties.push(`x_edubarotation ${page.rotation}`);
    if (Number.isFinite(page.angle)) properties.push(`x_edubadeskew ${page.angle}`);
    properties.push(`x_edubapreprocessorder ${page.preprocessOrder ?? "deskew-split"}`);
    if (!page.crop || Object.values(page.crop).every(Number.isFinite))
      properties.push(`x_edubacrop ${page.crop ? [page.crop.left, page.crop.top, page.crop.right, page.crop.bottom].join(" ") : "none"}`);

    const geometry = source?.pages[page.id];
    let reason = source?.unavailable?.[page.id];
    if (!reason && (!validFingerprint || !validBytes || !validPage)) reason = "missing-source";
    if (!reason && !geometry) reason = "missing-geometry";
    if (!reason && geometry) {
      try {
        const { pageToPdf, pdfBox, pdfRotation, pdfUserUnit, sourceWidth, sourceHeight, dpiX, dpiY, mode } = geometry;
        if (pageToPdf.length !== 6 || pdfBox.length !== 4 ||
          ![...pageToPdf, ...pdfBox, pdfRotation, pdfUserUnit, sourceWidth, sourceHeight, dpiX, dpiY].every(Number.isFinite) ||
          pdfUserUnit <= 0 || sourceWidth <= 0 || sourceHeight <= 0 || dpiX <= 0 || dpiY <= 0 ||
          !["extract", "render"].includes(mode)) throw new Error("Invalid geometry");
        inverse(pageToPdf);
      } catch { reason = "invalid-geometry"; }
    }
    if (reason || !geometry) {
      incomplete = true;
      properties.push("x_edubacoordinates unavailable", `x_edubacoordinatereason ${reason ?? "missing-geometry"}`);
    } else {
      const { pageToPdf, pdfBox, pdfRotation, pdfUserUnit, sourceWidth, sourceHeight, dpiX, dpiY, mode } = geometry;
      properties.push("x_edubacoordinates complete", `x_edubapdfbox ${pdfBox.join(" ")}`,
        `x_edubapdfrotation ${pdfRotation}`, `x_edubapdfuserunit ${pdfUserUnit}`,
        `x_edubasourcesize ${sourceWidth} ${sourceHeight}`, `x_edubasourcedpi ${dpiX} ${dpiY}`,
        `x_edubaimportmode ${mode}`, `x_edubapagetopdf ${pageToPdf.join(" ")}`);
    }
    const content = contentRuns(page).map(run => run.kind === "text"
      ? exportHocrBlocks(run.blocks)
      : `<div class="${run.figure.kind === "table" ? "ocr_table" : "ocr_image"}" id="${escapeXml(run.figure.id)}" title="${escapeXml(titleBbox(run.figure.bbox))}"></div>`).join("\n");
    return `<div class="ocr_page" id="${escapeXml(page.id)}" title="${escapeXml(properties.join("; "))}">${content}</div>`;
  }).join("\n");
  const propertyNames = ["bbox", "ppageno", "baseline", "x_size", "x_wconf", "x_bboxes", "x_conf", "x_source", "x_edubapdffingerprint", "x_edubapdfbytes", "x_edubasourcepage", "x_edubapdfbox", "x_edubapdfrotation", "x_edubapdfuserunit", "x_edubasourcesize", "x_edubasourcedpi", "x_edubaimportmode", "x_edubasplit", "x_edubarotation", "x_edubadeskew", "x_edubapreprocessorder", "x_edubacrop", "x_edubapagetopdf", "x_edubacoordinates", "x_edubacoordinatereason"];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><meta name="eduba-hocr-version" content="1" /><meta name="eduba-hocr-coordinates" content="${incomplete ? "incomplete" : "complete"}" /><meta name="ocr-capabilities" content="ocr_page ocr_carea ocr_par ocr_line ocrx_word ocrx_cinfo ocr_image ocr_table ${propertyNames.map(name => `ocrp_${name}`).join(" ")}" /></head><body>${body}</body></html>`;
}

export function exportSvg(page: DocumentPage, images: Record<string, string> = {}): string {
  const lines = paragraphLines(page)
    .map((line) => {
      const size =
        line.fontSize || Math.max(1, line.bbox.bottom - line.bbox.top);
      const x = line.bbox.left;
      const y = line.bbox.bottom;
      const baseline = line.bbox.bottom + (line.baseline?.intercept || 0);
      return `<text x="${x}" y="${baseline}" font-family="Noto Serif" font-size="${size}" textLength="${Math.max(0, line.bbox.right - line.bbox.left)}" lengthAdjust="spacingAndGlyphs" data-line-id="${escapeXml(line.id)}" data-original="${escapeXml(line.originalText)}">${formattedSegments(line, true)}</text>`;
    })
    .join("\n");
  const figures = (page.figureRegions ?? []).map(figure => {
    const image = images[figure.id];
    if (!image) throw new Error(`Missing image for region ${figure.id}.`);
    const box = figure.bbox;
    return `<image data-region-id="${escapeXml(figure.id)}" data-region-kind="${figure.kind}" x="${box.left}" y="${box.top}" width="${box.right - box.left}" height="${box.bottom - box.top}" href="${escapeXml(image)}" />`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}">${figures}${lines}</svg>`;
}

export interface Candidate {
  text: string;
  confidence?: number;
}

export type CandidateMap = Record<string, Candidate[]>;

function hasUnpairedSurrogate(value: string): boolean {
  return Array.from(value).some(
    (character) =>
      character.length === 1 &&
      character.charCodeAt(0) >= 0xd800 &&
      character.charCodeAt(0) <= 0xdfff,
  );
}

/** Validate a candidate map before it enters the document/editor state. */
export function parseCandidateMap(json: string): CandidateMap {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(t("errors.candidateMap"));
  const result: CandidateMap = Object.create(null) as CandidateMap;
  for (const [key, candidates] of Object.entries(value)) {
    if (
      !key ||
      hasUnpairedSurrogate(key) ||
      /[\u0000-\u001f\u007f]/u.test(key) ||
      Array.from(key).length > 256 ||
      !Array.isArray(candidates) ||
      candidates.length > 100
    )
      throw new Error(t("errors.candidateList", { key }));
    result[key] = candidates.map((candidate) => {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        typeof (candidate as { text?: unknown }).text !== "string"
      )
        throw new Error(t("errors.invalidCandidate", { key }));
      const text = (candidate as { text: string }).text;
      if (
        !text ||
        hasUnpairedSurrogate(text) ||
        Array.from(text).length > 256 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
      )
        throw new Error(t("errors.unsafeCandidate", { key }));
      const confidenceValue = (candidate as { confidence?: unknown })
        .confidence;
      if (
        confidenceValue !== undefined &&
        (typeof confidenceValue !== "number" ||
          !Number.isFinite(confidenceValue))
      )
        throw new Error(t("errors.invalidConfidence", { key }));
      return confidenceValue === undefined
        ? { text }
        : { text, confidence: confidenceValue };
    });
  }
  return result;
}

export function replaceGrapheme(
  text: string,
  start: number,
  end: number,
  replacement: string,
): string {
  const graphemes =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? Array.from(
          new (
            Intl as typeof Intl & {
              Segmenter: new (
                locale?: string,
                options?: { granularity: "grapheme" },
              ) => { segment(value: string): Iterable<{ segment: string }> };
            }
          ).Segmenter(undefined, { granularity: "grapheme" }).segment(text),
          (item) => item.segment,
        )
      : Array.from(text);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > graphemes.length
  )
    throw new RangeError(t("errors.invalidGrapheme"));
  return (
    graphemes.slice(0, start).join("") +
    replacement +
    graphemes.slice(end).join("")
  );
}

export interface PreprocessOptions {
  sourcePage?: number;
  rotation?: 0 | 90 | 180 | 270;
  split?: "none" | "left" | "right" | "both";
  crop?: Rect;
  deskew?: boolean;
  maxDeskewDegrees?: number;
  /** Apply a persisted correction exactly, without estimating it again. */
  deskewAngle?: number;
  preprocessOrder?: "split-deskew" | "deskew-split";
}

export interface ProcessedPage {
  sourceToPage: Affine;
  deskew?: DeskewEstimate;
  canvas: HTMLCanvasElement;
  provenance: LogicalPageProvenance;
}

export interface PreprocessResult {
  pages: ProcessedPage[];
  angle: number;
  /** Missing on legacy projects, whose deskew preceded spread splitting. */
  preprocessOrder?: "split-deskew" | "deskew-split";
  ocrMargins?: OcrMargins;
  sourceWidth: number;
  sourceHeight: number;
}

function canvasFor(width: number, height: number): HTMLCanvasElement {
  if (typeof document === "undefined")
    throw new Error(t("errors.canvasBrowser"));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function rotateCanvas(
  source: CanvasImageSource,
  width: number,
  height: number,
  degrees: number,
  expand = false,
): HTMLCanvasElement {
  const normalized = ((degrees % 360) + 360) % 360;
  const sideways = normalized === 90 || normalized === 270;
  const radians = degrees * Math.PI / 180;
  const canvas = canvasFor(
    expand ? Math.ceil(Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians))) : sideways ? height : width,
    expand ? Math.ceil(Math.abs(height * Math.cos(radians)) + Math.abs(width * Math.sin(radians))) : sideways ? width : height,
  );
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((normalized * Math.PI) / 180);
  context.drawImage(source, -width / 2, -height / 2, width, height);
  return canvas;
}

function cropCanvas(source: HTMLCanvasElement, crop: Rect): HTMLCanvasElement {
  if (
    ![crop.left, crop.top, crop.right, crop.bottom].every(Number.isFinite) ||
    crop.right <= crop.left ||
    crop.bottom <= crop.top
  )
    throw new Error(t("errors.invalidCrop"));
  const left = Math.max(0, Math.floor(crop.left));
  const top = Math.max(0, Math.floor(crop.top));
  const right = Math.min(source.width, Math.ceil(crop.right));
  const bottom = Math.min(source.height, Math.ceil(crop.bottom));
  if (right <= left || bottom <= top)
    throw new Error(t("errors.cropOutside"));
  const width = right - left;
  const height = bottom - top;
  const canvas = canvasFor(width, height);
  canvas
    .getContext("2d")!
    .drawImage(source, left, top, width, height, 0, 0, width, height);
  return canvas;
}

/** Estimate from a bounded analysis image; apply the result at source resolution. */
function estimateDeskew(source: HTMLCanvasElement, maxDegrees: number): DeskewEstimate {
  const limit = Math.max(0, Math.min(5, maxDegrees));
  if (!limit) return { angle: 0, status: "disabled" };
  const scale = Math.min(1, 1000 / Math.max(source.width, source.height));
  const analysis = canvasFor(source.width * scale, source.height * scale);
  const context = analysis.getContext("2d");
  if (!context) return { angle: 0, status: "unavailable" };
  context.fillStyle = "#fff";
  context.fillRect(0, 0, analysis.width, analysis.height);
  context.drawImage(source, 0, 0, analysis.width, analysis.height);
  return estimateSkew(context.getImageData(0, 0, analysis.width, analysis.height), limit);
}

/**
 * Rotate, split, deskew each logical page, then crop. Legacy projects can
 * explicitly request deskew before splitting to retain their coordinates.
 */
export function processCanvas(
  source: CanvasImageSource,
  options: PreprocessOptions = {},
): PreprocessResult {
  const candidate = source as unknown as {
    width?: number; naturalWidth?: number; height?: number; naturalHeight?: number;
  };
  const sourceWidth = candidate.naturalWidth || candidate.width || 0;
  const sourceHeight = candidate.naturalHeight || candidate.height || 0;
  if (!sourceWidth || !sourceHeight) throw new Error(t("errors.sourceDimensions"));
  const rotation = options.rotation ?? 0;
  const order = options.preprocessOrder ?? "split-deskew";
  const correction = (canvas: HTMLCanvasElement) => {
    const deskew: DeskewEstimate = options.deskewAngle !== undefined
      ? { angle: options.deskewAngle, status: options.deskewAngle ? "corrected" : "aligned" }
      : options.deskew ? estimateDeskew(canvas, options.maxDeskewDegrees ?? 5)
      : { angle: 0, status: "disabled" };
    const angle = deskew.angle;
    if (!Number.isFinite(angle) || Math.abs(angle) > 5)
      throw new Error("Invalid deskew angle.");
    return { angle, deskew, canvas: angle
      ? rotateCanvas(canvas, canvas.width, canvas.height, angle, order === "split-deskew")
      : canvas };
  };
  let working = rotateCanvas(source, sourceWidth, sourceHeight, rotation);
  let workingTransform = rotationTransform(sourceWidth, sourceHeight, working.width, working.height, rotation);
  let legacyAngle = 0;
  let legacyDeskew: DeskewEstimate = { angle: 0, status: "disabled" };
  if (order === "deskew-split") {
    const before = working;
    ({ canvas: working, angle: legacyAngle, deskew: legacyDeskew } = correction(working));
    workingTransform = multiply(rotationTransform(before.width, before.height, working.width, working.height, legacyAngle), workingTransform);
  }
  const split = options.split ?? "none";
  const sides: Array<LogicalPageProvenance["split"]> = split === "none"
    ? ["single"] : split === "both" ? ["left", "right"] : [split];
  const half = Math.floor(working.width / 2);
  const pages = sides.map(side => {
    let canvas = side === "single" ? working : cropCanvas(working, {
      left: side === "left" ? 0 : half, top: 0,
      right: side === "left" ? half : working.width, bottom: working.height,
    });
    let sourceToPage = multiply(side === "right" ? [1, 0, 0, 1, -half, 0] : identity, workingTransform);
    let angle = legacyAngle;
    let deskew = legacyDeskew;
    if (order === "split-deskew") {
      const before = canvas;
      ({ canvas, angle, deskew } = correction(canvas));
      sourceToPage = multiply(rotationTransform(before.width, before.height, canvas.width, canvas.height, angle), sourceToPage);
    }
    if (options.crop) {
      canvas = cropCanvas(canvas, options.crop);
      sourceToPage = multiply([1, 0, 0, 1, -Math.max(0, Math.floor(options.crop.left)), -Math.max(0, Math.floor(options.crop.top))], sourceToPage);
    }
    return { canvas, deskew, sourceToPage, provenance: {
      sourcePage: options.sourcePage ?? 0, split: side, crop: options.crop,
      rotation, angle, preprocessOrder: order,
    } };
  });
  // Multiple pages may have different angles; their provenance is authoritative.
  return { sourceWidth, sourceHeight, angle: pages.length === 1 ? pages[0].provenance.angle : 0, pages };
}

// Kept here for existing document callers; settings and detector live in scriptDetection.
export { applyScriptDetection } from './scriptDetection';
