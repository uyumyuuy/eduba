import { effectiveFormatting, type DocumentPage, type OcrLine, type TextFormatKind } from "./domain";

export type ReadableHtmlPage = { page: DocumentPage; label: string };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

const tagFor: Record<TextFormatKind, string> = {
  bold: "strong", italic: "em", superscript: "sup", subscript: "sub",
};
const order: TextFormatKind[] = ["superscript", "subscript", "bold", "italic"];

function formatLine(line: OcrLine): string {
  const text = line.correctedText ?? "";
  const ranges = effectiveFormatting(line);
  let active: TextFormatKind[] = [];
  let result = "";
  for (let offset = 0; offset < text.length;) {
    const point = text.codePointAt(offset)!;
    const character = String.fromCodePoint(point);
    const nextOffset = offset + character.length;
    const next = order.filter(kind => ranges.some(range => range.kind === kind && range.start < nextOffset && range.end > offset));
    let common = 0;
    while (common < active.length && common < next.length && active[common] === next[common]) common++;
    for (let i = active.length - 1; i >= common; i--) result += `</${tagFor[active[i]]}>`;
    for (let i = common; i < next.length; i++) result += `<${tagFor[next[i]]}>`;
    active = next;
    result += escapeHtml(character);
    offset = nextOffset;
  }
  for (let i = active.length - 1; i >= 0; i--) result += `</${tagFor[active[i]]}>`;
  return result;
}

export function createReadableHtml(title: string, pages: ReadableHtmlPage[], fontFaces: string, license: string): string {
  const renderedPages = pages.flatMap(({ page, label }) => {
    const paragraphs = page.blocks.flatMap(block => block.paragraphs);
    return [`<section class="page"><header class="page-label">${escapeHtml(label)}</header>${paragraphs.map(paragraph => `<p>${paragraph.lines.map(line => `<span class="line">${formatLine(line)}</span>`).join("\n")}</p>`).join("\n")}</section>`];
  });
  const safeLicense = license.replace(/--/g, "—").replace(/-\s*$/gm, "—");
  return `<!doctype html>
<html lang="und"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>${fontFaces}
*{box-sizing:border-box}body{margin:0;background:#f4f1eb;color:#29251f;font-family:"Noto Serif",Georgia,serif;font-size:18px;line-height:1.9}.document{max-width:48rem;margin:3rem auto;padding:0 2rem}.page{margin:0 0 3rem;padding:1.5rem 0 0;border-top:1px solid #c9c3b8}.page-label{text-align:right;color:#827b70;font:12px/1.4 system-ui,sans-serif;letter-spacing:.04em;margin-bottom:1.5rem}.page p{margin:0 0 1.35em}.line{display:block;white-space:pre-wrap}sup{font-size:.75em}sub{font-size:.75em}@media print{body{background:white;color:black;font-size:12pt}.document{max-width:none;margin:0;padding:0 1.5cm}.page{break-before:page;border-top:1px solid #bbb;margin:0;padding:1cm 0 0}.page:first-child{break-before:auto}.page-label{margin:0 0 1cm;color:#777}.page p{orphans:2;widows:2}}</style></head><body><main class="document">${renderedPages.join("\n")}</main>
<!-- Noto Serif font license (SIL Open Font License 1.1):\n${safeLicense}\n--></body></html>`;
}
