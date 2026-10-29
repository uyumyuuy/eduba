import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FigureRegion, Rect } from "./domain";
import { cropFigure } from "./figureRegions";

export function FigureRegionDialog({ source, selection, tight, working, onConfirm, onClose }: {
  source: HTMLCanvasElement; selection: Rect; tight: Rect; working: boolean;
  onConfirm: (kind: FigureRegion["kind"], bbox: Rect) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<FigureRegion["kind"]>("figure");
  const [original, setOriginal] = useState(false);
  const bbox = original ? selection : tight;
  const image = useMemo(() => cropFigure(source, bbox), [source, bbox]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !working) { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose, working]);
  return <div className="modal-scrim" role="presentation">
    <section className="modal figure-region-modal" role="dialog" aria-modal="true" aria-labelledby="figure-region-title">
      <h2 id="figure-region-title">{t("ui.addFigureRegion")}</h2>
      <img className="figure-region-preview" src={image} alt={t("ui.figurePreview")} />
      <p className="figure-region-coordinates">{bbox.left}, {bbox.top} — {bbox.right}, {bbox.bottom} · {bbox.right - bbox.left} × {bbox.bottom - bbox.top} px</p>
      <label>{t("ui.figureKind")} <select value={kind} disabled={working} onChange={event => setKind(event.target.value as FigureRegion["kind"])}>
        <option value="figure">{t("ui.figure")}</option><option value="table">{t("ui.table")}</option>
      </select></label>
      <label className="figure-original-option"><input type="checkbox" checked={original} disabled={working} onChange={event => setOriginal(event.target.checked)} /> {t("ui.useOriginalFigureSelection")}</label>
      <div className="modal-actions"><button className="secondary" disabled={working} onClick={onClose}>{t("ui.cancelFigureRegion")}</button><button className="primary" disabled={working} onClick={() => onConfirm(kind, bbox)}>{t("ui.confirmFigureRegion")}</button></div>
    </section>
  </div>;
}
