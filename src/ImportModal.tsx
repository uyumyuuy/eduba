import { useEffect, useRef, useState } from "react";
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

function dpiError(raw: string): string | null {
  const dpi = Number(raw);
  if (!Number.isInteger(dpi) || dpi < 72 || dpi > 600) return "DPI は 72〜600 の整数で入力してください。";
  return null;
}

export function ImportModal({ pdfPath, pdf, onCancel, onConfirm, busy = false }: Props) {
  const [begin, setBegin] = useState(1);
  const [end, setEnd] = useState(pdf.numPages);
  const [dpiRaw, setDpiRaw] = useState("300");
  const [importMode, setImportMode] = useState<ImportMode>("extract");
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [splitSpread, setSplitSpread] = useState(false);
  const [ocrMargins, setOcrMargins] = useState<OcrMargins>({ ...defaultOcrMargins });
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<Preview[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const token = useRef(0);

  const rangeError = validateImportRange(begin, end, pdf.numPages);
  const currentDpiError = importMode === "extract" ? null : dpiError(dpiRaw);
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
      const full = { width: loaded.canvas.width, height: loaded.canvas.height };
      const previewScale = Math.min(1, 1200 / Math.max(full.width, full.height));
      const raw = document.createElement("canvas");
      raw.width = Math.max(1, Math.ceil(full.width * previewScale));
      raw.height = Math.max(1, Math.ceil(full.height * previewScale));
      raw.getContext("2d")!.drawImage(loaded.canvas, 0, 0, raw.width, raw.height);
      const split = splitSpread ? "both" : "none";
      const result = processCanvas(raw, { sourcePage: page, rotation, split });
      if (renderToken !== token.current) return;
      const rotated = rotation === 90 || rotation === 270
        ? { width: Math.ceil(full.height), height: Math.ceil(full.width) }
        : { width: Math.ceil(full.width), height: Math.ceil(full.height) };
      const cards = result.pages.map((item, index) => {
        const half = Math.floor(rotated.width / 2);
        const width = splitSpread ? (index === 0 ? half : rotated.width - half) : rotated.width;
        return {
          label: splitSpread ? (index === 0 ? "左" : "右") : "全体",
          width,
          height: rotated.height,
          canvas: item.canvas,
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
  }, [pdf, page, dpiRaw, importMode, rotation, splitSpread, valid]);

  const updateMargin = (key: keyof OcrMargins, value: string) => setOcrMargins(current => ({ ...current, [key]: Number(value) }));
  const submit = () => {
    if (!valid || previewError) return;
    onConfirm({ begin, end, dpi: importMode === "extract" ? 300 : Number(dpiRaw), rotation, splitSpread, importMode, ocrMargins });
  };

  return <div className="modal-scrim">
    <div className="modal import-modal" role="dialog" aria-label="PDF import">
      <div className="modal-head">
        <div><div className="eyebrow">IMPORT PDF</div><h2>読み込み設定</h2></div>
        <button className="icon-btn" onClick={onCancel} disabled={busy} aria-label="閉じる"><X size={16}/></button>
      </div>
      <p className="source-path">{pdfPath}</p>
      <div className="import-body">
        <div className="import-controls">
          <div className="form-row">
            <label>開始ページ<input aria-label="開始ページ" disabled={busy} type="number" min="1" max={pdf.numPages} value={begin} onChange={event => setBegin(Number(event.target.value))}/></label>
            <label>終了ページ<input aria-label="終了ページ" disabled={busy} type="number" min="1" max={pdf.numPages} value={end} onChange={event => setEnd(Number(event.target.value))}/></label>
          </div>
          <div className="form-row">
            <label>読み込み方法<select aria-label="読み込み方法" disabled={busy} value={importMode} onChange={event => setImportMode(event.target.value as ImportMode)}><option value="extract">画像抽出</option><option value="render">ページを画像化</option></select></label>
            <label>DPI<input aria-label="DPI" disabled={busy || importMode === "extract"} inputMode="numeric" value={importMode === "extract" ? "元画像を使用" : dpiRaw} onChange={event => setDpiRaw(event.target.value)}/></label>
            <label>回転<select aria-label="回転" disabled={busy} value={rotation} onChange={event => setRotation(Number(event.target.value) as 0 | 90 | 180 | 270)}><option value="0">0°</option><option value="90">90° 時計回り</option><option value="180">180°</option><option value="270">270°</option></select></label>
          </div>
          <label className="split-check"><input aria-label="見開きを左右に分割" disabled={busy} type="checkbox" checked={splitSpread} onChange={event => setSplitSpread(event.target.checked)}/>見開きを左右に分割</label><div className="margin-fields"><strong>OCR 禁止範囲（%）</strong><div className="form-row"><label>天<input aria-label="天" disabled={busy} type="number" value={ocrMargins.top} onChange={e=>updateMargin("top",e.target.value)}/></label><label>地<input aria-label="地" disabled={busy} type="number" value={ocrMargins.bottom} onChange={e=>updateMargin("bottom",e.target.value)}/></label></div><div className="form-row"><label>{splitSpread?"小口":"左"}<input aria-label={splitSpread?"小口":"左"} disabled={busy} type="number" value={splitSpread?ocrMargins.outer:ocrMargins.left} onChange={e=>updateMargin(splitSpread?"outer":"left",e.target.value)}/></label><label>{splitSpread?"ノド":"右"}<input aria-label={splitSpread?"ノド":"右"} disabled={busy} type="number" value={splitSpread?ocrMargins.inner:ocrMargins.right} onChange={e=>updateMargin(splitSpread?"inner":"right",e.target.value)}/></label></div></div>
          <p className="settings-note">範囲内だけを論理ページにします。元の PDF 全体はそのまま保存されます。</p>
        </div>
        <div className="import-preview">
          <div className="preview-nav">
            <button className="icon-btn" onClick={() => setPage(value => Math.max(begin, value - 1))} disabled={busy || !valid || page <= begin}><ChevronLeft size={15}/></button>
            <span>原稿 {page} / {pdf.numPages}</span>
            <button className="icon-btn" onClick={() => setPage(value => Math.min(end, value + 1))} disabled={busy || !valid || page >= end}><ChevronRight size={15}/></button>
          </div>
          <div className={`preview-canvases ${splitSpread ? "both" : ""}`}>
            {preview.map((item, index) => { const margins = marginError ? resolveOcrMargins(defaultOcrMargins, "single") : resolveOcrMargins(ocrMargins, splitSpread ? (index === 0 ? "left" : "right") : "single"); return <figure key={`${item.label}-${index}`}><figcaption>{item.label}</figcaption><div className="preview-canvas-wrap"><canvas ref={node => { canvases.current[index] = node; if (node) { node.width = item.canvas.width; node.height = item.canvas.height; node.getContext("2d")!.drawImage(item.canvas, 0, 0); } }}/><i className="margin-top" style={{height:`${margins.top}%`}}/><i className="margin-bottom" style={{height:`${margins.bottom}%`}}/><i className="margin-left" style={{width:`${margins.left}%`}}/><i className="margin-right" style={{width:`${margins.right}%`}}/></div><small>{item.width} × {item.height} px · {(rotation === 90 || rotation === 270 ? item.dpiY : item.dpiX).toFixed(1)} × {(rotation === 90 || rotation === 270 ? item.dpiX : item.dpiY).toFixed(1)} DPI{item.modeUsed === "render" && item.reason ? ` · 画像化 300 DPI: ${item.reason}` : ""}{item.sourceWidth && item.sourceHeight ? ` · 元画像 ${item.sourceWidth}×${item.sourceHeight}px` : ""}</small></figure>; })}</div><p className="margin-legend">色付き部分は OCR しません。画像は切り取りません。</p>
          </div>
          {rendering && <small>プレビューを作成中…</small>}
        </div>
      {(rangeError || currentDpiError || marginError || previewError) && <p className="form-error">{rangeError || currentDpiError || marginError || previewError}</p>}
      <div className="modal-actions">
        <button className="secondary" onClick={onCancel} disabled={busy}>キャンセル</button>
        <button className="primary" onClick={submit} disabled={busy || rendering || !valid || Boolean(previewError)}>{busy ? "作成中…" : `${logicalPageCount} 論理ページで保存…`}</button>
      </div>
    </div>
  </div>;
}
