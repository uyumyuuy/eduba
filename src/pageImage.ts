import { OPS, type PDFPageProxy } from "pdfjs-dist";
import { t } from "./i18n";

export type ImportMode = "extract" | "render";
export type PageImageResult = {
  canvas: HTMLCanvasElement;
  modeUsed: ImportMode;
  dpiX: number;
  dpiY: number;
  sourceWidth?: number;
  sourceHeight?: number;
  reason?: string;
};
type M = [number, number, number, number, number, number];
type Box = { left: number; bottom: number; right: number; top: number };
type ImageObject = {
  width?: number;
  height?: number;
  bitmap?: CanvasImageSource;
  data?: Uint8ClampedArray | Uint8Array;
};
const I: M = [1, 0, 0, 1, 0, 0];
const MAX_PIXELS = 100_000_000;
const EXTRACT_FALLBACK_DPI = 300;
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const p = (m: M, x: number, y: number) => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
});
const bounds = (m: M): Box => {
  const q = [p(m, 0, 0), p(m, 1, 0), p(m, 0, 1), p(m, 1, 1)];
  return {
    left: Math.min(...q.map((v) => v.x)),
    bottom: Math.min(...q.map((v) => v.y)),
    right: Math.max(...q.map((v) => v.x)),
    top: Math.max(...q.map((v) => v.y)),
  };
};
const hit = (a: Box, b: Box): Box | null => {
  const v = {
    left: Math.max(a.left, b.left),
    bottom: Math.max(a.bottom, b.bottom),
    right: Math.min(a.right, b.right),
    top: Math.min(a.top, b.top),
  };
  return v.right > v.left && v.top > v.bottom ? v : null;
};
const area = (v: Box) => (v.right - v.left) * (v.top - v.bottom);
const length = (x: number, y: number) => Math.hypot(x, y);
const finite = (v: number) => Number.isFinite(v) && v > 0;
const orthogonal = (m: M) =>
  (Math.abs(m[0]) < 0.0001 || Math.abs(m[1]) < 0.0001) &&
  (Math.abs(m[2]) < 0.0001 || Math.abs(m[3]) < 0.0001);
function canvas(w: number, h: number) {
  if (!finite(w) || !finite(h) || w * h > MAX_PIXELS)
    throw new Error(t("errors.imageTooLarge", { pixels: MAX_PIXELS }));
  const c = document.createElement("canvas");
  c.width = Math.ceil(w);
  c.height = Math.ceil(h);
  return c;
}
async function fallback(
  page: PDFPageProxy,
  dpi: number,
  reason: string,
): Promise<PageImageResult> {
  const v = page.getViewport({ scale: dpi / 72 }),
    c = canvas(v.width, v.height),
    x = c.getContext("2d");
  if (!x) throw new Error(t("errors.canvasContext"));
  await page.render({ canvasContext: x, viewport: v }).promise;
  return { canvas: c, modeUsed: "render", dpiX: dpi, dpiY: dpi, reason };
}
function source(i: ImageObject): CanvasImageSource | null {
  if (i.bitmap) return i.bitmap;
  if (
    !finite(i.width ?? 0) ||
    !finite(i.height ?? 0) ||
    !i.data ||
    i.data.length !== i.width! * i.height! * 4 ||
    typeof ImageData === "undefined"
  )
    return null;
  const c = canvas(i.width!, i.height!),
    x = c.getContext("2d");
  if (!x) return null;
  x.putImageData(
    new ImageData(new Uint8ClampedArray(i.data), i.width!, i.height!),
    0,
    0,
  );
  return c;
}
async function object(
  page: PDFPageProxy,
  id: unknown,
): Promise<ImageObject | undefined> {
  if (id && typeof id === "object") return id as ImageObject;
  const key = String(id);
  const any = page as unknown as {
    objs?: ObjectStore;
    commonObjs?: ObjectStore;
  };
  const stores = key.startsWith("g_")
    ? [any.commonObjs, any.objs]
    : [any.objs, any.commonObjs];
  for (const store of stores) {
    if (!store) continue;
    try {
      const value = await new Promise<ImageObject>((resolve, reject) => {
        let settled = false;
        const done = (image: ImageObject) => {
          if (!settled) {
            settled = true;
            resolve(image);
          }
        };
        try {
          const immediate = store.get(key, done);
          if (immediate) done(immediate);
        } catch (error) {
          reject(error);
        }
      });
      if (value) return value;
    } catch {
      /* try the alternate PDF.js object store */
    }
  }
  return undefined;
}
type ObjectStore = {
  get(
    key: string,
    callback?: (value: ImageObject) => void,
  ): ImageObject | undefined;
};
function rectFromPath(
  codes: number[] | undefined,
  values: number[] | undefined,
  boundsArg: number[] | undefined,
): Box | null {
  if (
    codes?.length === 1 &&
    codes[0] === OPS.rectangle &&
    values &&
    values.length >= 4
  ) {
    const [x, y, w, h] = values;
    return finite(Math.abs(w)) && finite(Math.abs(h))
      ? {
          left: Math.min(x, x + w),
          bottom: Math.min(y, y + h),
          right: Math.max(x, x + w),
          top: Math.max(y, y + h),
        }
      : null;
  }
  if (
    codes?.length !== 5 ||
    codes[0] !== OPS.moveTo ||
    !codes.slice(1, 4).every((v) => v === OPS.lineTo) ||
    codes[4] !== OPS.closePath ||
    !values ||
    values.length < 8 ||
    !boundsArg ||
    boundsArg.length !== 4
  )
    return null;
  const points = [
    [values[0], values[1]],
    [values[2], values[3]],
    [values[4], values[5]],
    [values[6], values[7]],
  ];
  if (new Set(points.map(([x, y]) => `${x},${y}`)).size !== 4) return null;
  if (
    points.some((point, index) => {
      const next = points[(index + 1) % 4];
      return (point[0] === next[0]) === (point[1] === next[1]);
    })
  )
    return null;
  const left = Math.min(...points.map((v) => v[0])),
    right = Math.max(...points.map((v) => v[0])),
    bottom = Math.min(...points.map((v) => v[1])),
    top = Math.max(...points.map((v) => v[1]));
  if (
    !finite(right - left) ||
    !finite(top - bottom) ||
    left !== boundsArg[0] ||
    bottom !== boundsArg[1] ||
    right !== boundsArg[2] ||
    top !== boundsArg[3]
  )
    return null;
  const expected = new Set([
    `${left},${bottom}`,
    `${left},${top}`,
    `${right},${bottom}`,
    `${right},${top}`,
  ]);
  return points.every(([x, y]) => expected.has(`${x},${y}`))
    ? { left, bottom, right, top }
    : null;
}
/** Extracts one dominant embedded image at native pixels; any ambiguous page falls back to PDF.js rendering. */
export async function loadPageImage(
  page: PDFPageProxy,
  mode: ImportMode,
  dpi = 300,
): Promise<PageImageResult> {
  if (mode === "render") {
    if (!Number.isInteger(dpi) || dpi < 72 || dpi > 600)
      throw new Error(t("errors.renderDpi"));
    return fallback(page, dpi, "");
  }
  const fallbackDpi = EXTRACT_FALLBACK_DPI;
  const ops = await page.getOperatorList(),
    view = page.getViewport({ scale: 1 }),
    vm = view.transform as M,
    pageBox: Box = { left: 0, bottom: 0, right: view.width, top: view.height };
  let m = I,
    clip: Box | undefined,
    pending: Box | undefined,
    candidate: { image: ImageObject; m: M; clip?: Box } | undefined;
  const stack: Array<{ m: M; clip?: Box }> = [];
  for (let n = 0; n < ops.fnArray.length; n++) {
    const op = ops.fnArray[n],
      args = ops.argsArray[n] ?? [];
    if (op === OPS.save) {
      stack.push({ m, clip });
      continue;
    }
    if (op === OPS.restore) {
      const s = stack.pop();
      if (!s) return fallback(page, fallbackDpi, t("errors.pdfState"));
      m = s.m;
      clip = s.clip;
      continue;
    }
    if (op === OPS.transform) {
      if (!(args as number[]).every(Number.isFinite))
        return fallback(page, fallbackDpi, t("errors.imageTransform"));
      m = mul(m, args as M);
      continue;
    }
    if (op === OPS.constructPath) {
      const r = rectFromPath(
        args[0] as number[],
        args[1] as number[],
        args[2] as number[],
      );
      if (!r)
        return fallback(
          page,
          fallbackDpi,
          t("errors.unsupportedClip"),
        );
      pending = r;
      continue;
    }
    if (op === OPS.clip || op === OPS.eoClip) {
      if (!pending)
        return fallback(page, fallbackDpi, t("errors.pdfState"));
      const cm = mul(
        vm,
        mul(m, [
          pending.right - pending.left,
          0,
          0,
          pending.top - pending.bottom,
          pending.left,
          pending.bottom,
        ]),
      );
      if (!orthogonal(cm))
        return fallback(
          page,
          fallbackDpi,
          t("errors.clippedRotation"),
        );
      const b = bounds(cm);
      clip = clip
        ? (hit(clip, b) ?? { left: 0, bottom: 0, right: 0, top: 0 })
        : b;
      pending = undefined;
      continue;
    }
    if (op === OPS.endPath || op === OPS.dependency) continue;
    if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject) {
      const image = await object(page, args[0]),
        src = image && source(image),
        im = mul(vm, m);
      if (
        !image?.width ||
        !image.height ||
        !src ||
        !finite(image.width) ||
        !finite(image.height) ||
        !orthogonal(im)
      )
        return fallback(
          page,
          fallbackDpi,
          t("errors.imageRestore"),
        );
      const imageBounds = hit(bounds(im), pageBox);
      const visible =
        imageBounds && (clip ? hit(imageBounds, clip) : imageBounds);
      if (!visible || area(visible) / area(pageBox) < 0.95)
        return fallback(
          page,
          fallbackDpi,
          t("errors.pageCoverage"),
        );
      if (candidate)
        return fallback(
          page,
          fallbackDpi,
          t("errors.multipleImages"),
        );
      candidate = { image, m, clip };
      continue;
    }
    if (
      [
        OPS.showText,
        OPS.showSpacedText,
        OPS.nextLineShowText,
        OPS.nextLineSetSpacingShowText,
        OPS.fill,
        OPS.stroke,
        OPS.fillStroke,
        OPS.eoFill,
        OPS.shadingFill,
      ].includes(op)
    )
      return fallback(
        page,
        fallbackDpi,
        t("errors.visibleElements"),
      );
    return fallback(
      page,
      fallbackDpi,
      t("errors.unsupportedOperator"),
    );
  }
  if (!candidate)
    return fallback(page, fallbackDpi, t("errors.noEmbeddedImage"));
  const im = mul(vm, candidate.m),
    w = candidate.image.width!,
    h = candidate.image.height!,
    xAxis = length(im[0], im[1]),
    yAxis = length(im[2], im[3]);
  if (!finite(xAxis) || !finite(yAxis))
    return fallback(page, fallbackDpi, t("errors.imageResolution"));
  let sx: number, sy: number;
  if (Math.abs(im[0]) >= Math.abs(im[1])) {
    sx = w / xAxis;
    sy = h / yAxis;
  } else {
    sx = h / yAxis;
    sy = w / xAxis;
  }
  if (!finite(sx) || !finite(sy))
    return fallback(page, fallbackDpi, t("errors.imageResolution"));
  let out: HTMLCanvasElement;
  try {
    out = canvas(view.width * sx, view.height * sy);
  } catch {
    return fallback(page, fallbackDpi, t("errors.extractedTooLarge"));
  }
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error(t("errors.extractionCanvas"));
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = false;
  const scale: M = [sx, 0, 0, sy, 0, 0];
  if (candidate.clip) {
    const c = candidate.clip;
    ctx.save();
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.beginPath();
    ctx.rect(c.left, c.bottom, c.right - c.left, c.top - c.bottom);
    ctx.clip();
  }
  ctx.setTransform(
    ...mul(mul(mul(scale, vm), candidate.m), [1 / w, 0, 0, -1 / h, 0, 1]),
  );
  ctx.drawImage(source(candidate.image)!, 0, 0);
  if (candidate.clip) ctx.restore();
  return {
    canvas: out,
    modeUsed: "extract",
    dpiX: 72 * sx,
    dpiY: 72 * sy,
    sourceWidth: w,
    sourceHeight: h,
  };
}
