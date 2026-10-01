import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { processCanvas } from "./domain";
import { validateImportRange, type ImportConfig } from "./importConfig";
import { defaultOcrMargins, resolveOcrMargins, validateOcrMargins, type OcrMargins } from "./ocrMargins";
import { loadPageImage, type ImportMode } from "./pageImage";

type Props = {
  pdfPath: string;
  pdf: PDFDocumentProxy;
  onCancel: () => void;
  onConfirm: (config: ImportConfig) => void;
  busy?: boolean;
};

type Preview = { label: string; width: number; height: number; canvas: HTMLCanvasElement; modeUsed: ImportMode; dpiX: number; dpiY: number; reason?: string; sourceWidth?: number; sourceHeight?: number };

function dpiError(raw: string, translate: (key: string) => string): string | null {
  const dpi = Number(raw);
  if (!Number.isInteger(dpi) || dpi < 72 || dpi > 600) return translate("errors.dpi");
  return null;
}

export function ImportModal({ pdfPath, pdf, onCancel, onConfirm, busy = false }: Props) {
  const { t, i18n } = useTranslation();
  const [begin, setBegin] = useState(1);
  const [end, setEnd] = useState(pdf.numPages);
  const [dpiRaw, setDpiRaw] = useState("300");
  const [importMode, setImportMode] = useState<ImportMode>("extract");
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [splitSpread, setSplitSpread] = useState(false);
  const [deskew, setDeskew] = useState(true);
  const [ocrMargins, setOcrMargins] = useState<OcrMargins>({ ...defaultOcrMargins });
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<Preview[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const token = useRef(0);

  const rangeError = validateImportRange(begin, end, pdf.numPages);
  const currentDpiError = importMode === "extract" ? null : dpiError(dpiRaw, key => t(key));
  let marginError: string | null = null; try { validateOcrMargins(ocrMargins, splitSpread); } catch (error) { marginError = error instanceof Error ? error.message : String(error); }
  const valid = !rangeError && !currentDpiError && !marginError;
  const logicalPageCount = valid ? (end - begin + 1) * (splitSpread ? 2 : 1) : 0;

  useEffect(() => {
    if (!rangeError) setPage(previous => Math.max(begin, Math.min(end, previous)));
  }, [begin, end, rangeError]);

  useEffect(() => {
    if (!valid) return;
    const renderToken = ++token.current;
    setRendering(true);
    setPreviewError(null);
    void (async () => {
      const source = await pdf.getPage(page);
      const loaded = await loadPageImage(source, importMode, importMode === "extract" ? 300 : Number(dpiRaw));
      const result = processCanvas(loaded.canvas, {
        sourcePage: page, rotation, split: splitSpread ? "both" : "none", deskew,
      });
      if (renderToken !== token.current) return;
      const cards = result.pages.map((item, index) => {
        const width = item.canvas.width;
        const height = item.canvas.height;
        const scale = Math.min(1, 1200 / Math.max(width, height));
        const display = document.createElement("canvas");
        display.width = Math.max(1, Math.round(width * scale));
        display.height = Math.max(1, Math.round(height * scale));
        display.getContext("2d")!.drawImage(item.canvas, 0, 0, display.width, display.height);
        return {
          label: splitSpread ? (index === 0 ? t("importUi.leftSide") : t("importUi.rightSide")) : t("importUi.whole"),
          width,
          height,
          canvas: display,
          modeUsed: loaded.modeUsed,
          dpiX: loaded.dpiX,
          dpiY: loaded.dpiY,
          reason: loaded.reason,
          sourceWidth: loaded.sourceWidth,
          sourceHeight: loaded.sourceHeight,
        };
      });
      setPreview(cards);    })().catch(error => {
      if (renderToken === token.current) setPreviewError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (renderToken === token.current) setRendering(false);
    });
    return () => { token.current++; };
  }, [pdf, page, dpiRaw, importMode, rotation, splitSpread, deskew, valid, i18n.language]);

  const updateMargin = (key: keyof OcrMargins, value: string) => setOcrMargins(current => ({ ...current, [key]: Number(value) }));
  const submit = () => {
    if (!valid || previewError) return;
    onConfirm({ begin, end, dpi: importMode === "extract" ? 300 : Number(dpiRaw), rotation, splitSpread, deskew, importMode, ocrMargins });
  };

  return <div className="modal-scrim">
    <div className="modal import-modal" role="dialog" aria-label={t("importUi.dialogLabel")}>
      <div className="modal-head">
        <div><div className="eyebrow">{t("importUi.eyebrow")}</div><h2>{t("importUi.title")}</h2></div>
        <button className="icon-btn" onClick={onCancel} disabled={busy} aria-label={t("importUi.close")}><X size={16}/></button>
      </div>
      <p className="source-path">{pdfPath}</p>
      <div className="import-body">
        <div className="import-controls">
          <div className="form-row">
            <label>{t("importUi.startPage")}<input aria-label={t("importUi.startPage")} disabled={busy} type="number" min="1" max={pdf.numPages} value={begin} onChange={event => setBegin(Number(event.target.value))}/></label>
            <label>{t("importUi.endPage")}<input aria-label={t("importUi.endPage")} disabled={busy} type="number" min="1" max={pdf.numPages} value={end} onChange={event => setEnd(Number(event.target.value))}/></label>
          </div>
          <div className="form-row">
            <label>{t("importUi.importMethod")}<select aria-label={t("importUi.importMethod")} disabled={busy} value={importMode} onChange={event => setImportMode(event.target.value as ImportMode)}><option value="extract">{t("importUi.extract")}</option><option value="render">{t("importUi.render")}</option></select></label>
            <label>{t("importUi.dpi")}<input aria-label={t("importUi.dpi")} disabled={busy || importMode === "extract"} inputMode="numeric" value={importMode === "extract" ? t("importUi.sourceImage") : dpiRaw} onChange={event => setDpiRaw(event.target.value)}/></label>
            <label>{t("importUi.rotation")}<select aria-label={t("importUi.rotation")} disabled={busy} value={rotation} onChange={event => setRotation(Number(event.target.value) as 0 | 90 | 180 | 270)}><option value="0">0°</option><option value="90">{t("importUi.clockwise90")}</option><option value="180">180°</option><option value="270">270°</option></select></label>
          </div>
          <label className="split-check"><input aria-label={t("importUi.splitSpread")} disabled={busy} type="checkbox" checked={splitSpread} onChange={event => setSplitSpread(event.target.checked)}/>{t("importUi.splitSpread")}</label><label className="split-check"><input aria-label={t("importUi.deskew")} disabled={busy} type="checkbox" checked={deskew} onChange={event => setDeskew(event.target.checked)}/>{t("importUi.deskew")}</label><p className="settings-note">{t("importUi.deskewNote")}</p><div className="margin-fields"><strong>{t("importUi.ocrMargins")}</strong><div className="form-row"><label>{t("importUi.top")}<input aria-label={t("importUi.top")} disabled={busy} type="number" value={ocrMargins.top} onChange={e=>updateMargin("top",e.target.value)}/></label><label>{t("importUi.bottom")}<input aria-label={t("importUi.bottom")} disabled={busy} type="number" value={ocrMargins.bottom} onChange={e=>updateMargin("bottom",e.target.value)}/></label></div><div className="form-row"><label>{splitSpread ? t("importUi.outer") : t("importUi.left")}<input aria-label={splitSpread ? t("importUi.outer") : t("importUi.left")} disabled={busy} type="number" value={splitSpread?ocrMargins.outer:ocrMargins.left} onChange={e=>updateMargin(splitSpread?"outer":"left",e.target.value)}/></label><label>{splitSpread ? t("importUi.inner") : t("importUi.right")}<input aria-label={splitSpread ? t("importUi.inner") : t("importUi.right")} disabled={busy} type="number" value={splitSpread?ocrMargins.inner:ocrMargins.right} onChange={e=>updateMargin(splitSpread?"inner":"right",e.target.value)}/></label></div></div>
          <p className="settings-note">{t("importUi.settingsNote")}</p>
        </div>
        <div className="import-preview">
          <div className="preview-nav">
            <button className="icon-btn" onClick={() => setPage(value => Math.max(begin, value - 1))} disabled={busy || !valid || page <= begin}><ChevronLeft size={15}/></button>
            <span>{t("importUi.pageOf", { page, total: pdf.numPages })}</span>
            <button className="icon-btn" onClick={() => setPage(value => Math.min(end, value + 1))} disabled={busy || !valid || page >= end}><ChevronRight size={15}/></button>
          </div>
          <div className={`preview-canvases ${splitSpread ? "both" : ""}`}>
            {preview.map((item, index) => { const margins = marginError ? resolveOcrMargins(defaultOcrMargins, "single") : resolveOcrMargins(ocrMargins, splitSpread ? (index === 0 ? "left" : "right") : "single"); return <figure key={`${item.label}-${index}`}><figcaption>{item.label}</figcaption><div className="preview-canvas-wrap"><canvas ref={node => { canvases.current[index] = node; if (node) { node.width = item.canvas.width; node.height = item.canvas.height; node.getContext("2d")!.drawImage(item.canvas, 0, 0); } }}/><i className="margin-top" style={{height:`${margins.top}%`}}/><i className="margin-bottom" style={{height:`${margins.bottom}%`}}/><i className="margin-left" style={{width:`${margins.left}%`}}/><i className="margin-right" style={{width:`${margins.right}%`}}/></div><small>{item.width} × {item.height} px · {(rotation === 90 || rotation === 270 ? item.dpiY : item.dpiX).toFixed(1)} × {(rotation === 90 || rotation === 270 ? item.dpiX : item.dpiY).toFixed(1)} DPI{item.modeUsed === "render" && item.reason ? ` · ${t("importUi.imageFallback", { reason: item.reason })}` : ""}{item.sourceWidth && item.sourceHeight ? ` · ${t("importUi.originalImage", { width: item.sourceWidth, height: item.sourceHeight })}` : ""}</small></figure>; })}</div><p className="margin-legend">{t("importUi.marginLegend")}</p>
          </div>
          {rendering && <small>{t("importUi.previewCreating")}</small>}
        </div>
      {(rangeError || currentDpiError || marginError || previewError) && <p className="form-error">{rangeError || currentDpiError || marginError || previewError}</p>}
      <div className="modal-actions">
        <button className="secondary" onClick={onCancel} disabled={busy}>{t("importUi.cancel")}</button>
        <button className="primary" onClick={submit} disabled={busy || rendering || !valid || Boolean(previewError)}>{busy ? t("importUi.creating") : t("importUi.logicalPages", { count: logicalPageCount })}</button>
      </div>
    </div>
  </div>;
}
