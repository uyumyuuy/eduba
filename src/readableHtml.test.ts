import { describe, expect, it, vi } from "vitest";
import { createReadableHtml } from "./readableHtml";
import { loadReadableFontFaces, notoSerifLicense } from "./readableHtmlFonts";
import type { DocumentPage } from "./domain";

function page(id: string, lines: { text: string; formatting?: { start: number; end: number; kind: "bold" | "italic" | "superscript" | "subscript" }[]; autoFormatting?: { start: number; end: number; kind: "bold" | "italic" | "superscript" | "subscript" }[] }[]): DocumentPage {
  return {
    id, sourcePage: 1, split: "single", rotation: 0, angle: 0, width: 100, height: 100,
    blocks: [{ id: `${id}-b`, bbox: { left: 0, top: 0, right: 100, bottom: 100 }, paragraphs: [{
      id: `${id}-p`, bbox: { left: 0, top: 0, right: 100, bottom: 100 }, lines: lines.map((item, index) => ({
        id: `${id}-${index}`, bbox: { left: 0, top: index, right: 100, bottom: index + 1 }, originalText: item.text,
        correctedText: item.text, words: [], chars: [], geometryApproximate: false,
        formatting: item.formatting, autoFormatting: item.autoFormatting,
      })),
    }] }],
  };
}

describe("readable HTML export", () => {
  it("escapes title and labels, applies manual and automatic formatting, and preserves line order", () => {
    const first = page("first", [
      { text: "A<& B", formatting: [{ start: 0, end: 1, kind: "superscript" }, { start: 1, end: 3, kind: "italic" }], autoFormatting: [{ start: 4, end: 5, kind: "bold" }] },
      { text: "x2", formatting: [{ start: 1, end: 2, kind: "subscript" }], autoFormatting: [{ start: 0, end: 2, kind: "superscript" }] },
      { text: "second line" },
    ]);
    const html = createReadableHtml("<Book & title>", [{ page: first, label: "p<1>&\"" }], "", notoSerifLicense);
    expect(html).toContain("<title>&lt;Book &amp; title&gt;</title>");
    expect(html).toContain('class="page-label">p&lt;1&gt;&amp;&quot;</header>');
    expect(html).toContain("<sup>A</sup><em>&lt;&amp;</em> <strong>B</strong>");
    expect(html).toContain("<sup>x</sup><sub>2</sub>");
    expect(html.indexOf("<sup>A</sup>")).toBeLessThan(html.indexOf("second line"));
    expect(html).toContain("<span class=\"line\">");
  });

  it("keeps page labels and embeds all bundled fonts offline", async () => {
    const emptyProcessed = page("empty", [{ text: "" }]);
    const unprocessed = { ...page("pending", []), blocks: [] };
    const fonts = vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([0, 1, 2, 255]).buffer,
    } as Response));
    const html = createReadableHtml("Book", [
      { page: emptyProcessed, label: "7" }, { page: unprocessed, label: "8" }, { page: page("last", [{ text: "Text" }]), label: "9" },
    ], await loadReadableFontFaces(), notoSerifLicense);
    expect(html.match(/class="page-label"/g)).toHaveLength(3);
    expect(html).toContain(">7</header>");
    expect(html).toContain(">9</header>");
    expect(html).toContain(">8</header>");
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).not.toMatch(/url\(["']?https?:/i);
    expect(html).toContain("SIL OPEN FONT LICENSE");
    expect(fonts).toHaveBeenCalledTimes(4);
    const licenseComment = html.slice(html.indexOf("SIL OPEN FONT LICENSE"), html.indexOf("--></body>"));
    expect(licenseComment).not.toContain("--");
    fonts.mockRestore();
  });
});
