# PDF image extraction research

Eduba currently renders source pages through PDF.js. Direct extraction of a dominant embedded image may preserve the source image resolution, but is only proposed for a future path. It must first establish that one image covers at least 95% of the visible page and safely reproduce PDF placement, transforms, clipping paths, and overlays; otherwise it must fall back to page rendering. The sample research PDF uses a dominant FlateDecode image but also has clipping and an x offset, so raw image extraction would not reproduce the visible page by itself. DPI remains relevant to the render fallback.

References: [pypdf image extraction](https://pypdf.readthedocs.io/en/stable/user/extract-images.html) and [PDF.js API](https://mozilla.github.io/pdf.js/api/).