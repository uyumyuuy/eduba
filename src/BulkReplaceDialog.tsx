import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { invokeCommand } from "./tauri";
import { useTranslation } from "react-i18next";
import "./BulkReplaceDialog.css";

export type BulkMatch = {
  pageId: string;
  pageLabel: string;
  lineId: string;
  lineText: string;
  bbox?: { left: number; top: number; right: number; bottom: number };
  matchOrdinal: number;
};

type SearchPage = { results: BulkMatch[]; total: number; page: number; pageSize: number };

export type BulkReplaceRequest = {
  search: string;
  replacement: string;
  selections: BulkMatch[];
};

export type BulkReplaceDialogProps = {
  open: boolean;
  projectPath: string;
  initialSearch: string;
  getSnippet?: (pageId: string, bbox?: BulkMatch["bbox"]) => Promise<string | null>;
  onApply: (request: BulkReplaceRequest) => Promise<void> | void;
  onClose: () => void;
};

const PAGE_SIZE = 20;
const keyOf = (match: BulkMatch) => `${match.pageId}\u0000${match.lineId}\u0000${match.matchOrdinal}`;

function MatchRow({ match, checked, getSnippet, onToggle }: {
  match: BulkMatch; checked: boolean; getSnippet?: BulkReplaceDialogProps["getSnippet"]; onToggle: () => void;
}) {
  const [snippet, setSnippet] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!getSnippet) return;
    void getSnippet(match.pageId, match.bbox).then((value) => { if (active) setSnippet(value); }).catch(() => { if (active) setSnippet(null); });
    return () => { active = false; };
  }, [getSnippet, match.pageId, match.bbox?.left, match.bbox?.top, match.bbox?.right, match.bbox?.bottom]);

  return <label className="bulk-replace-result">
    <input type="checkbox" checked={checked} onChange={onToggle} />
    <span className="bulk-replace-snippet">{snippet ? <img src={snippet} alt="" /> : <span>OCR</span>}</span>
    <span className="bulk-replace-result-copy"><strong>{match.pageLabel} · {match.lineId}</strong><span>{match.lineText}</span></span>
  </label>;
}

export function BulkReplaceDialog({ open, projectPath, initialSearch, getSnippet, onApply, onClose }: BulkReplaceDialogProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState(initialSearch);
  const [replacement, setReplacement] = useState("");
  const [resultPage, setResultPage] = useState(0);
  const [data, setData] = useState<SearchPage>({ results: [], total: 0, page: 0, pageSize: PAGE_SIZE });
  const [selected, setSelected] = useState<Map<string, BulkMatch>>(() => new Map());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSearch(initialSearch); setReplacement(""); setResultPage(0); setSelected(new Map()); setError(null);
  }, [open, initialSearch]);

  useEffect(() => {
    if (!open || !projectPath || !search) { setData({ results: [], total: 0, page: resultPage, pageSize: PAGE_SIZE }); return; }
    let active = true; setError(null);
    void invokeCommand("search_corrections", { projectPath, search, page: resultPage, pageSize: PAGE_SIZE })
      .then((next) => { if (active) setData(next as SearchPage); })
      .catch((reason) => { if (active) { setData({ results: [], total: 0, page: resultPage, pageSize: PAGE_SIZE }); setError(reason instanceof Error ? reason.message : String(reason)); } });
    return () => { active = false; };
  }, [open, projectPath, search, resultPage]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !working) onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose, working]);

  const pageCount = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const allPageSelected = data.results.length > 0 && data.results.every((result) => selected.has(keyOf(result)));
  const selectedCount = selected.size;
  const selection = useMemo(() => [...selected.values()], [selected]);

  if (!open) return null;
  const toggle = (result: BulkMatch) => setSelected((previous) => {
    const next = new Map(previous); const key = keyOf(result);
    if (next.has(key)) next.delete(key); else next.set(key, result);
    return next;
  });
  const togglePage = () => setSelected((previous) => {
    const next = new Map(previous);
    for (const result of data.results) { const key = keyOf(result); if (allPageSelected) next.delete(key); else next.set(key, result); }
    return next;
  });
  const submit = async () => {
    if (!selectedCount || working) return;
    setWorking(true); setError(null);
    try { await onApply({ search, replacement, selections: selection }); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  };

  return <div className="modal-scrim bulk-replace-scrim" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !working) onClose();
  }}>
    <section className="modal bulk-replace-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-replace-title">
      <header className="bulk-replace-header"><div><span className="eyebrow">CORRECTION</span><h2 id="bulk-replace-title">{t("bulkReplace.title")}</h2></div>
        <button className="icon-button" type="button" aria-label={t("bulkReplace.close")} onClick={onClose} disabled={working}><X size={16} /></button></header>
      <div className="bulk-replace-fields"><label>{t("bulkReplace.source")}<input value={search} readOnly /></label>
        <label>{t("bulkReplace.replacement")}<input value={replacement} onChange={(event) => setReplacement(event.target.value)} /></label></div>
      <div className="bulk-replace-results-head"><strong>{t("bulkReplace.results", { count: data.total })}</strong><button type="button" className="text-button" onClick={togglePage} disabled={!data.results.length}>
        {allPageSelected ? t("bulkReplace.clearPage") : t("bulkReplace.selectPage")}</button></div>
      <div className="bulk-replace-results" aria-live="polite">{data.results.map((result) => <MatchRow key={keyOf(result)} match={result} checked={selected.has(keyOf(result))} getSnippet={getSnippet} onToggle={() => toggle(result)} />)}
        {!data.results.length && <p className="bulk-replace-empty"><Search size={15} />{t("bulkReplace.noResults")}</p>}</div>
      <footer className="bulk-replace-footer"><div className="bulk-replace-pagination"><button type="button" className="icon-button" aria-label={t("bulkReplace.previous")} disabled={resultPage === 0} onClick={() => setResultPage((page) => page - 1)}><ChevronLeft size={16} /></button>
        <span>{resultPage + 1} / {pageCount}</span><button type="button" className="icon-button" aria-label={t("bulkReplace.next")} disabled={resultPage + 1 >= pageCount} onClick={() => setResultPage((page) => page + 1)}><ChevronRight size={16} /></button></div>
        <div className="modal-actions"><button className="secondary" type="button" disabled={working} onClick={onClose}>{t("bulkReplace.cancel")}</button><button className="primary" type="button" disabled={working || !selectedCount} onClick={() => void submit()}>{working ? t("bulkReplace.applying") : t("bulkReplace.apply", { count: selectedCount })}</button></div></footer>
      {error && <p className="form-error">{error}</p>}
    </section>
  </div>;
}
