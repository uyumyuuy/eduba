import type { OcrMargins } from "./ocrMargins";
/**
 * The small, serialisable document model shared by the OCR viewer and its
 * exporters. Coordinates are pixels in the source page (after any logical
 * page transform), with the origin at the top-left.
 */

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

export interface OcrLine {
  id: string;
  bbox: Rect;
  baseline?: Baseline;
  fontSize?: number;
  ascenders?: number;
  descenders?: number;
  confidence?: number;
  originalText: string;
  correctedText: string;
  words: OcrWord[];
  chars: OcrChar[];
  /** True when the line is rendered from approximate line geometry. */
  geometryApproximate: boolean;
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
  ocrMargins?: OcrMargins;
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
}

export interface HocrParseOptions {
  sourcePage?: number;
  pageId?: string;
}

const CLASS_NAMES = {
  page: "ocr_page",
  block: "ocr_carea",
  paragraph: "ocr_par",
  line: "ocr_line",
  word: "ocrx_word",
  char: "ocrx_cinfo",
} as const;

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
  const lines = childrenOf(element, CLASS_NAMES.line).map(parseLine);
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
    throw new Error("DOMParser is required to parse hOCR");
  const document = new DOMParser().parseFromString(
    source,
    "application/xhtml+xml",
  );
  const pages = classElements(document, CLASS_NAMES.page);
  if (!pages.length) throw new Error("hOCR contains no .ocr_page element");
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

export function updateLineText(
  page: DocumentPage,
  lineId: string,
  correctedText: string,
): DocumentPage {
  const copy: DocumentPage = JSON.parse(JSON.stringify(page)) as DocumentPage;
  const line = allLines(copy).find((candidate) => candidate.id === lineId);
  if (!line) throw new Error(`Unknown OCR line: ${lineId}`);
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

export function exportHocr(pages: DocumentPage[]): string {
  const body = pages
    .map((page) => {
      const blocks = page.blocks
        .map((block) => {
          const paragraphs = block.paragraphs
            .map((paragraph) => {
              const lines = paragraph.lines
                .map((line) => {
                  const words = line.words
                    .map((word) => {
                      const chars = word.chars
                        .filter((char) => char.source === "ocr" || char.bbox)
                        .map((char) => {
                          const title = char.bbox
                            ? `x_bboxes ${char.bbox.left} ${char.bbox.top} ${char.bbox.right} ${char.bbox.bottom}${char.confidence == null ? "" : `; x_conf ${char.confidence}`}`
                            : "";
                          return `<span class="ocrx_cinfo"${title ? ` title="${escapeXml(title)}"` : ""}>${escapeXml(char.correctedText)}</span>`;
                        })
                        .join("");
                      const text = chars || escapeXml(word.correctedText);
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
                      ? `<span class="ocrx_word" title="${escapeXml(titleBbox(line.bbox))}">${escapeXml(line.correctedText)}</span>`
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
                  return `<span class="ocr_line" id="${escapeXml(line.id)}" title="${escapeXml(details)}">${lineContent}</span>`;
                })
                .join("\n");
              return `<p class="ocr_par" id="${escapeXml(paragraph.id)}" title="${escapeXml(titleBbox(paragraph.bbox))}">${lines}</p>`;
            })
            .join("\n");
          return `<div class="ocr_carea" id="${escapeXml(block.id)}" title="${escapeXml(titleBbox(block.bbox))}">${paragraphs}</div>`;
        })
        .join("\n");
      return `<div class="ocr_page" id="${escapeXml(page.id)}" title="${escapeXml(titleBbox({ left: 0, top: 0, right: page.width, bottom: page.height }))}">${blocks}</div>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;
}

export function exportSvg(page: DocumentPage): string {
  const lines = paragraphLines(page)
    .map((line) => {
      const size =
        line.fontSize || Math.max(1, line.bbox.bottom - line.bbox.top);
      const x = line.bbox.left;
      const y = line.bbox.bottom;
      const baseline = line.bbox.bottom + (line.baseline?.intercept || 0);
      return `<text x="${x}" y="${baseline}" font-family="monospace" font-size="${size}" textLength="${Math.max(0, line.bbox.right - line.bbox.left)}" lengthAdjust="spacingAndGlyphs" data-line-id="${escapeXml(line.id)}" data-original="${escapeXml(line.originalText)}">${escapeXml(line.correctedText)}</text>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}">${lines}</svg>`;
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
    throw new Error("Candidate map must be an object");
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
      throw new Error(`Invalid candidate list for ${key}`);
    result[key] = candidates.map((candidate) => {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        typeof (candidate as { text?: unknown }).text !== "string"
      )
        throw new Error(`Invalid candidate for ${key}`);
      const text = (candidate as { text: string }).text;
      if (
        !text ||
        hasUnpairedSurrogate(text) ||
        Array.from(text).length > 256 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
      )
        throw new Error(`Unsafe candidate text for ${key}`);
      const confidenceValue = (candidate as { confidence?: unknown })
        .confidence;
      if (
        confidenceValue !== undefined &&
        (typeof confidenceValue !== "number" ||
          !Number.isFinite(confidenceValue))
      )
        throw new Error(`Invalid confidence for ${key}`);
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
    throw new RangeError("Invalid grapheme range");
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
}

export interface ProcessedPage {
  canvas: HTMLCanvasElement;
  provenance: LogicalPageProvenance;
}

export interface PreprocessResult {
  pages: ProcessedPage[];
  angle: number;
  ocrMargins?: OcrMargins;
  sourceWidth: number;
  sourceHeight: number;
}

function canvasFor(width: number, height: number): HTMLCanvasElement {
  if (typeof document === "undefined")
    throw new Error("Canvas preprocessing requires a browser document");
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
): HTMLCanvasElement {
  const normalized = ((degrees % 360) + 360) % 360;
  const sideways = normalized === 90 || normalized === 270;
  const canvas = canvasFor(
    sideways ? height : width,
    sideways ? width : height,
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
    throw new Error("Invalid crop rectangle");
  const left = Math.max(0, Math.floor(crop.left));
  const top = Math.max(0, Math.floor(crop.top));
  const right = Math.min(source.width, Math.ceil(crop.right));
  const bottom = Math.min(source.height, Math.ceil(crop.bottom));
  if (right <= left || bottom <= top)
    throw new Error("Crop rectangle is outside the source");
  const width = right - left;
  const height = bottom - top;
  const canvas = canvasFor(width, height);
  canvas
    .getContext("2d")!
    .drawImage(source, left, top, width, height, 0, 0, width, height);
  return canvas;
}

function estimateDeskew(
  source: HTMLCanvasElement,
  maxDegrees: number,
): { canvas: HTMLCanvasElement; angle: number } {
  const context = source.getContext("2d");
  if (!context) return { canvas: source, angle: 0 };
  const limit = Math.max(0, Math.min(5, maxDegrees));
  if (!limit) return { canvas: source, angle: 0 };
  const scale = Math.min(1, 1000 / Math.max(source.width, source.height));
  const analysisSource =
    scale < 1 ? canvasFor(source.width * scale, source.height * scale) : source;
  if (analysisSource !== source)
    analysisSource
      .getContext("2d")!
      .drawImage(source, 0, 0, analysisSource.width, analysisSource.height);
  let bestAngle = 0;
  let bestScore = -Infinity;
  for (let candidate = -limit; candidate <= limit + 0.001; candidate += 0.5) {
    const rotated = rotateCanvas(
      analysisSource,
      analysisSource.width,
      analysisSource.height,
      candidate,
    );
    const pixels = rotated
      .getContext("2d")
      ?.getImageData(0, 0, rotated.width, rotated.height).data;
    if (!pixels) continue;
    const rows = new Float64Array(rotated.height);
    for (let y = 0; y < rotated.height; y++)
      for (let x = 0; x < rotated.width; x++) {
        const i = (y * rotated.width + x) * 4;
        if ((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 < 180) rows[y]++;
      }
    const mean =
      rows.reduce((sum, value) => sum + value, 0) / Math.max(1, rows.length);
    const score = rows.reduce((sum, value) => sum + (value - mean) ** 2, 0);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = candidate;
    }
  }
  if (bestScore <= 1e-6) return { canvas: source, angle: 0 };
  return {
    canvas: bestAngle
      ? rotateCanvas(source, source.width, source.height, bestAngle)
      : source,
    angle: bestAngle,
  };
}

/**
 * Rotate, split, and crop a scan while retaining a provenance record. The
 * operation is deliberately nondestructive: every returned canvas is newly
 * rendered and the source is untouched. Deskew uses a bounded horizontal
 * projection search when requested.
 */
export function processCanvas(
  source: CanvasImageSource,
  options: PreprocessOptions = {},
): PreprocessResult {
  const candidate = source as unknown as {
    width?: number;
    naturalWidth?: number;
    height?: number;
    naturalHeight?: number;
  };
  const sourceWidth = candidate.naturalWidth || candidate.width || 0;
  const sourceHeight = candidate.naturalHeight || candidate.height || 0;
  if (!sourceWidth || !sourceHeight)
    throw new Error("Source image has no dimensions");
  const rotation = options.rotation ?? 0;
  let working = rotateCanvas(source, sourceWidth, sourceHeight, rotation);
  let angle = 0;
  if (options.deskew)
    ({ canvas: working, angle } = estimateDeskew(
      working,
      options.maxDeskewDegrees ?? 5,
    ));
  const split = options.split ?? "none";
  if (split === "none") {
    if (options.crop) working = cropCanvas(working, options.crop);
    return {
      sourceWidth,
      sourceHeight,
      angle,
      pages: [
        {
          canvas: working,
          provenance: {
            sourcePage: options.sourcePage ?? 0,
            split: "single",
            crop: options.crop,
            rotation,
            angle,
          },
        },
      ],
    };
  }
  const half = Math.floor(working.width / 2);
  const sides: Array<"left" | "right"> =
    split === "left"
      ? ["left"]
      : split === "right"
        ? ["right"]
        : ["left", "right"];
  const pages = sides.map((side) => {
    const left = side === "left" ? 0 : half;
    let canvas = cropCanvas(working, {
      left,
      top: 0,
      right: side === "left" ? half : working.width,
      bottom: working.height,
    });
    if (options.crop) canvas = cropCanvas(canvas, options.crop);
    return {
      canvas,
      provenance: {
        sourcePage: options.sourcePage ?? 0,
        split: side,
        crop: options.crop,
        rotation,
        angle,
      },
    };
  });
  return { sourceWidth, sourceHeight, angle, pages };
}
