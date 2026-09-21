import type { LogicalPageProvenance } from "./domain";

export type OcrMargins = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  outer: number;
  inner: number;
};
export const defaultOcrMargins: OcrMargins = Object.freeze({
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
  outer: 0,
  inner: 0,
});
export type ResolvedOcrMargins = Pick<
  OcrMargins,
  "top" | "bottom" | "left" | "right"
>;

export function validateOcrMargins(
  value: OcrMargins,
  splitSpread = false,
): OcrMargins {
  const active = splitSpread
    ? (["top", "bottom", "outer", "inner"] as const)
    : (["top", "bottom", "left", "right"] as const);
  const names: Record<keyof OcrMargins, string> = {
    top: "天",
    bottom: "地",
    left: "左",
    right: "右",
    outer: "小口",
    inner: "ノド",
  };
  for (const name of active) {
    const amount = value[name];
    if (!Number.isFinite(amount) || amount < 0 || amount >= 100)
      throw new Error(
        `OCR 禁止範囲の${names[name]}は 0 以上 100 未満の数値にしてください`,
      );
  }
  if (value.top + value.bottom >= 100)
    throw new Error("OCR 禁止範囲の天と地の合計は 100 未満にしてください");
  const [first, second, pairNames] = splitSpread
    ? [value.outer, value.inner, "小口とノド"]
    : [value.left, value.right, "左と右"];
  if (first + second >= 100)
    throw new Error(
      `OCR 禁止範囲の${pairNames}の合計は 100 未満にしてください`,
    );
  return value;
}

export function resolveOcrMargins(
  value: OcrMargins | undefined,
  split: LogicalPageProvenance["split"],
): ResolvedOcrMargins {
  const margins = validateOcrMargins(
    { ...defaultOcrMargins, ...value },
    split !== "single",
  );
  const horizontal =
    split === "left"
      ? { left: margins.outer, right: margins.inner }
      : split === "right"
        ? { left: margins.inner, right: margins.outer }
        : { left: margins.left, right: margins.right };
  return { top: margins.top, bottom: margins.bottom, ...horizontal };
}

/** Returns a full-size white-masked copy for OCR. It never changes the displayed source canvas. */
export function maskOcrCanvas(
  source: HTMLCanvasElement,
  split: LogicalPageProvenance["split"],
  value?: OcrMargins,
): HTMLCanvasElement {
  const margins = resolveOcrMargins(value, split);
  const output = source.ownerDocument.createElement("canvas");
  output.width = source.width;
  output.height = source.height;
  const context = output.getContext("2d");
  if (!context) throw new Error("OCR canvas context is unavailable");
  context.drawImage(source, 0, 0);
  context.fillStyle = "#fff";
  const width = output.width;
  const height = output.height;
  const top = Math.ceil((height * margins.top) / 100);
  const bottom = Math.ceil((height * margins.bottom) / 100);
  const left = Math.ceil((width * margins.left) / 100);
  const right = Math.ceil((width * margins.right) / 100);
  if (top) context.fillRect(0, 0, width, top);
  if (bottom) context.fillRect(0, height - bottom, width, bottom);
  if (left) context.fillRect(0, 0, left, height);
  if (right) context.fillRect(width - right, 0, right, height);
  return output;
}
