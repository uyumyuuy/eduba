import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FormattedEditMirror } from "./FormattedEditMirror";

describe("FormattedEditMirror", () => {
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
