import { RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TextFormatRange } from "./domain";
import type { ScriptDetectionSettings } from "./scriptDetection";
import "./ScriptCalibrationDialog.css";

export type ScriptCalibrationCandidate = {
  pageId: string;
  lineId: string;
  lineText: string;
  /** Image-space bounds of the entire OCR line. */
  bbox: { left: number; top: number; right: number; bottom: number };
};

export type ScriptCalibrationProgress = { completed: number; total: number };

export type ScriptCalibrationDialogProps = {
  open: boolean;
  initialSettings: ScriptDetectionSettings;
  /** A representative, balanced collection assembled by the project layer. */
  candidates: ScriptCalibrationCandidate[];
  loading?: boolean;
  progress?: ScriptCalibrationProgress | null;
  getSnippet: (candidate: ScriptCalibrationCandidate) => Promise<string | null> | string | null;
  /** Calculates the ranges to show using the draft settings. It never persists a change. */
  detectPreview: (candidate: ScriptCalibrationCandidate, settings: ScriptDetectionSettings) => TextFormatRange[];
  /** Ask the project layer for another small, balanced randomized selection. */
  onReshuffle?: (settings: ScriptDetectionSettings) => void;
  onApply: (settings: ScriptDetectionSettings) => Promise<void> | void;
  onClose: () => void;
};

type NumberSetting = Exclude<keyof ScriptDetectionSettings, "subscriptScope">;

function FormattedText({ text, ranges }: { text: string; ranges: TextFormatRange[] }) {
  const segments = useMemo(() => {
    const points = new Set([0, text.length]);
    ranges.forEach(range => { points.add(Math.max(0, range.start)); points.add(Math.min(text.length, range.end)); });
    const sorted = [...points].sort((a, b) => a - b);
    return sorted.slice(0, -1).map((start, index) => {
      const end = sorted[index + 1];
      const kinds = ranges.filter(range => range.start <= start && range.end >= end).map(range => range.kind);
      return { start, end, kinds };
    });
  }, [ranges, text]);
  return <span className="script-calibration-formatted-text">{segments.map(segment => {
    const kind = segment.kinds.includes("superscript") ? "superscript" : segment.kinds.includes("subscript") ? "subscript" : undefined;
    return <span key={segment.start} className={kind ? `script-calibration-${kind}` : undefined}>{text.slice(segment.start, segment.end)}</span>;
  })}</span>;
}

function CandidateRow({ candidate, settings, getSnippet, detectPreview }: Pick<ScriptCalibrationDialogProps, "getSnippet" | "detectPreview"> & { candidate: ScriptCalibrationCandidate; settings: ScriptDetectionSettings }) {
  const [snippet, setSnippet] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.resolve(getSnippet(candidate)).then(value => { if (active) setSnippet(value); }).catch(() => { if (active) setSnippet(null); });
    return () => { active = false; };
  }, [candidate, getSnippet]);
  const ranges = useMemo(() => detectPreview(candidate, settings), [candidate, detectPreview, settings]);
  return <article className="script-calibration-example">
    <div className="script-calibration-snippet">{snippet ? <img src={snippet} alt="" /> : <span>OCR</span>}</div>
    <div className="script-calibration-preview"><FormattedText text={candidate.lineText} ranges={ranges} /></div>
  </article>;
}

export function ScriptCalibrationDialog({ open, initialSettings, candidates, loading = false, progress, getSnippet, detectPreview, onReshuffle, onApply, onClose }: ScriptCalibrationDialogProps) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<ScriptDetectionSettings>(initialSettings);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setSettings(initialSettings); setError(null); } }, [open, initialSettings]);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !working) onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open, working]);
  if (!open) return null;
  const updateNumber = (key: NumberSetting, value: string) => {
    const number = Number(value);
    if (Number.isFinite(number)) setSettings(previous => ({ ...previous, [key]: Math.min(2, Math.max(0, number)) }));
  };
  const apply = async () => {
    if (working) return;
    setWorking(true); setError(null);
    try { await onApply(settings); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  };
  const control = (key: NumberSetting, label: string, description: string) => <label className="script-calibration-control">
    <span>{label}</span><small>{description}</small>
    <input aria-label={label} type="number" min="0" max="2" step="0.01" value={settings[key]} onChange={event => updateNumber(key, event.currentTarget.value)} />
  </label>;
  return <div className="modal-scrim script-calibration-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !working) onClose(); }}>
    <section className="modal script-calibration-modal" role="dialog" aria-modal="true" aria-labelledby="script-calibration-title" aria-describedby="script-calibration-description">
      <header className="script-calibration-header"><div><span className="eyebrow">OCR</span><h2 id="script-calibration-title">{t("scriptCalibration.title")}</h2></div><button className="icon-button" type="button" aria-label={t("scriptCalibration.close")} onClick={onClose} disabled={working}><X size={16} /></button></header>
      <p id="script-calibration-description" className="script-calibration-intro">{t("scriptCalibration.description")}</p>
      <div className="script-calibration-controls">
        <fieldset><legend>{t("scriptCalibration.superscript")}</legend>
          {control("superscriptMaxHeightRatio", t("scriptCalibration.maxHeight"), t("scriptCalibration.maxHeightHelp"))}
          {control("superscriptMinRiseRatio", t("scriptCalibration.minRise"), t("scriptCalibration.minRiseHelp"))}
        </fieldset>
        <fieldset><legend>{t("scriptCalibration.subscript")}</legend>
          {control("subscriptMaxHeightRatio", t("scriptCalibration.maxHeight"), t("scriptCalibration.maxHeightHelp"))}
          {control("subscriptMinDropRatio", t("scriptCalibration.minDrop"), t("scriptCalibration.minDropHelp"))}
          <label className="script-calibration-scope"><span>{t("scriptCalibration.subscriptScope")}</span><select aria-label={t("scriptCalibration.subscriptScope")} value={settings.subscriptScope} onChange={event => setSettings(previous => ({ ...previous, subscriptScope: event.currentTarget.value as ScriptDetectionSettings["subscriptScope"] }))}><option value="digits-and-x">{t("scriptCalibration.digitsAndX")}</option><option value="all">{t("scriptCalibration.allCharacters")}</option></select></label>
        </fieldset>
      </div>
      <div className="script-calibration-examples-head"><div><strong>{t("scriptCalibration.examples")}</strong><span>{t("scriptCalibration.previewHint")}</span></div><button type="button" className="text-button" onClick={() => onReshuffle?.(settings)} disabled={loading || working || !onReshuffle}><RefreshCw size={14} />{t("scriptCalibration.reshuffle")}</button></div>
      <div className="script-calibration-examples" aria-live="polite">
        {loading ? <p className="script-calibration-loading">{progress ? t("scriptCalibration.loadingProgress", progress) : t("scriptCalibration.loading")}</p> : candidates.map(candidate => <CandidateRow key={`${candidate.pageId}:${candidate.lineId}`} candidate={candidate} settings={settings} getSnippet={getSnippet} detectPreview={detectPreview} />)}
        {!loading && !candidates.length && <p className="script-calibration-loading">{t("scriptCalibration.noExamples")}</p>}
      </div>
      <footer className="script-calibration-footer"><p>{t("scriptCalibration.unsavedHint")}</p><div className="modal-actions"><button className="secondary" type="button" disabled={working} onClick={onClose}>{t("scriptCalibration.cancel")}</button><button className="primary" type="button" disabled={working || loading} onClick={() => void apply()}>{working ? t("scriptCalibration.applying") : t("scriptCalibration.apply")}</button></div></footer>
      {error && <p className="form-error">{error}</p>}
    </section>
  </div>;
}
