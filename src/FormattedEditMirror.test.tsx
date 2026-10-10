import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FormattedEditMirror } from "./FormattedEditMirror";

describe("FormattedEditMirror", () => {
  it.each(["superscript", "subscript", "italic", "bold"] as const)("places the caret within the visible %s text", kind => {
    const markup = renderToStaticMarkup(<FormattedEditMirror className="line-edit-mirror"
      value="A126 B" formatting={[{ start: 1, end: 4, kind }]} caret={3} />);
    expect(markup).toContain('>12<span class="formatted-edit-caret"></span>6</span>');
    expect(markup.match(/class="formatted-edit-caret"/g)).toHaveLength(1);
  });

  it("places the caret after a superscript run rather than within its regular-width spacer", () => {
    const markup = renderToStaticMarkup(<FormattedEditMirror className="line-edit-mirror"
      value="A126 B" formatting={[{ start: 1, end: 4, kind: "superscript" }]} caret={4} />);
    expect(markup).toContain('>126<span class="formatted-edit-caret"></span></span>');
    expect(markup.match(/class="formatted-edit-caret"/g)).toHaveLength(1);
  });

  it("can show the caret at the end of a decorated line", () => {
    const markup = renderToStaticMarkup(<FormattedEditMirror className="line-edit-mirror"
      value="A126" formatting={[{ start: 1, end: 4, kind: "superscript" }]} caret={4} />);
    expect(markup).toContain('>126<span class="formatted-edit-caret"></span></span>');
  });

  it("anchors italic decorations to the advance span baseline", () => {
    const markup = renderToStaticMarkup(
      <FormattedEditMirror
        className="line-edit-mirror"
        value="normal italic"
        formatting={[{ start: 7, end: 13, kind: "italic" }]}
      />,
    );

    expect(markup).toContain('font-style:italic;top:auto;bottom:0.14em');
    expect(markup).not.toContain('translateY(0.08em)');
  });

  it("positions superscript separately from the normal baseline anchor", () => {
    const markup = renderToStaticMarkup(
      <FormattedEditMirror
        className="line-edit-mirror"
        value="raised"
        formatting={[{ start: 0, end: 6, kind: "superscript" }]}
      />,
    );

    expect(markup).toContain('top:0.1em;bottom:auto;font-size:0.7em');
  });
});
