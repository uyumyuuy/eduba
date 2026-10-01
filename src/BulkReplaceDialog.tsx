import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { invokeCommand } from "./tauri";
import { useTranslation } from "react-i18next";
import { candidatesForSelection } from "./correctionCandidates";
import { EditToolbarButton } from "./EditToolbarButton";
import { FormattedEditMirror } from "./FormattedEditMirror";
import type { TextFormatKind, TextFormatRange } from "./domain";
import "./BulkReplaceDialog.css";

export type BulkMatch = {
  pageId: string;
  pageLabel: string;
  lineId: string;
  lineText: string;
  formatting?: TextFormatRange[];
  autoFormatting?: TextFormatRange[];
  bbox?: { left: number; top: number; right: number; bottom: number };
  matchBBox?: { left: number; top: number; right: number; bottom: number };
  matchOrdinal: number;
};

type SearchPage = { results: BulkMatch[]; total: number; page: number; pageSize: number };

export type BulkReplaceRequest = {
  search: string;
  replacement: string;
  replacementFormatting: TextFormatRange[];
  preserveFormatting: boolean;
  selections: BulkMatch[];
};

export type BulkReplaceDialogProps = {
  open: boolean;
  projectPath: string;
  initialSearch: string;
  initialMatch?: BulkMatch;
  getSnippet?: (match: BulkMatch) => Promise<string | null>;
  onApply: (request: BulkReplaceRequest) => Promise<void> | void;
  onClose: () => void;
};

const PAGE_SIZE = 20;
const keyOf = (match: BulkMatch) => `${match.pageId}\u0000${match.lineId}\u0000${match.matchOrdinal}`;

function remapFormatting(ranges: TextFormatRange[], before: string, after: string): TextFormatRange[] {
  if (!ranges.length || before === after) return ranges;
  let prefix = 0; while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let beforeEnd = before.length, afterEnd = after.length;
  while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) { beforeEnd--; afterEnd--; }
  const delta = afterEnd - beforeEnd;
  return ranges.flatMap(range => {
    if (range.end <= prefix) return [range];
    if (range.start >= beforeEnd) return [{ ...range, start: range.start + delta, end: range.end + delta }];
    const pieces: TextFormatRange[] = [];
    if (range.start < prefix) pieces.push({ ...range, end: prefix });
    if (range.end > beforeEnd) pieces.push({ ...range, start: afterEnd, end: range.end + delta });
    return pieces;
  }).filter(range => range.end > range.start);
}

function toggleFormatting(ranges: TextFormatRange[], start: number, end: number, kind: TextFormatKind): TextFormatRange[] {
  if (start >= end) return ranges;
  const opposite = kind === "superscript" ? "subscript" : kind === "subscript" ? "superscript" : undefined;
  const withoutOpposite = ranges.flatMap(range => {
    if (range.kind !== opposite || range.end <= start || range.start >= end) return [range];
    return [{ ...range, end: start }, { ...range, start: end }];
  }).filter(range => range.end > range.start);
  const same = withoutOpposite.filter(range => range.kind === kind);
  const fullyFormatted = same.some(range => range.start <= start && range.end >= end);
  if (!fullyFormatted) return [...withoutOpposite, { start, end, kind }];
  return withoutOpposite.flatMap(range => {
    if (range.kind !== kind || range.end <= start || range.start >= end) return [range];
    return [{ ...range, end: start }, { ...range, start: end }];
  }).filter(range => range.end > range.start);
}

function ReplacementEditor({ value, formatting, onChange, onFormattingChange }: {
  value: string; formatting: TextFormatRange[]; onChange: (value: string) => void; onFormattingChange: (ranges: TextFormatRange[]) => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  useEffect(() => {
    if (mirrorRef.current && inputRef.current) mirrorRef.current.scrollLeft = inputRef.current.scrollLeft;
  }, [formatting, value]);

  const [ctrl, setCtrl] = useState(false);
  const selected = value.slice(selection.start, selection.end);
  const candidates = selected ? candidatesForSelection(selected) : [];
  const capture = () => { const input = inputRef.current; if (input) setSelection({ start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 }); };
  const changeText = (next: string) => { onFormattingChange(remapFormatting(formatting, value, next)); onChange(next); };
  const replace = (text: string) => {
    const next = value.slice(0, selection.start) + text + value.slice(selection.end);
    changeText(next);
    setSelection({ start: selection.start, end: selection.start + text.length });
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(selection.start, selection.start + text.length));
  };
  const format = (kind: TextFormatKind) => { if (selection.start < selection.end) onFormattingChange(toggleFormatting(formatting, selection.start, selection.end, kind)); };
  return <div className="bulk-replace-editor">
    <div className="bulk-toolbar-slot">
      {selected && <div className="bulk-selection-toolbar" onMouseDown={event => event.preventDefault()} role="toolbar" aria-label="Selected text tools">
        <EditToolbarButton label={t("toolbar.bold")} shortcut="B" showShortcut={ctrl} onClick={() => format("bold")}>{t("toolbar.bold")}</EditToolbarButton>
        <EditToolbarButton label={t("toolbar.italic")} shortcut="I" showShortcut={ctrl} onClick={() => format("italic")}>{t("toolbar.italic")}</EditToolbarButton>
        <EditToolbarButton label={t("toolbar.superscript")} shortcut="↑" showShortcut={ctrl} onClick={() => format("superscript")}>{t("toolbar.superscript")}</EditToolbarButton>
        <EditToolbarButton label={t("toolbar.subscript")} shortcut="↓" showShortcut={ctrl} onClick={() => format("subscript")}>{t("toolbar.subscript")}</EditToolbarButton>
        {candidates.map((candidate, index) => <EditToolbarButton className="text-candidate" key={candidate} label={candidate} shortcut={index < 9 ? String(index + 1) : undefined} showShortcut={ctrl} onClick={() => replace(candidate)}>{candidate}</EditToolbarButton>)}
      </div>}
    </div>
    <div className="bulk-replace-input-wrap">
      {formatting.length > 0 && <FormattedEditMirror mirrorRef={mirrorRef} className="bulk-edit-mirror" value={value} formatting={formatting} />}
      <input ref={inputRef} className={formatting.length ? "has-formatting" : undefined} value={value} onChange={event => changeText(event.currentTarget.value)} onSelect={capture} onScroll={event => { if (mirrorRef.current) mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft; }} onKeyDown={event => {
      setCtrl(event.ctrlKey); const key = event.key.toLowerCase();
      if (!event.ctrlKey || event.nativeEvent.isComposing || selection.start >= selection.end) return;
      const kind = key === "b" ? "bold" : key === "i" ? "italic" : event.key === "ArrowUp" ? "superscript" : event.key === "ArrowDown" ? "subscript" : null;
      if (kind) { event.preventDefault(); format(kind); }
      else if (/^[1-9]$/.test(key) && candidates[Number(key) - 1]) { event.preventDefault(); replace(candidates[Number(key) - 1]); }
    }} onKeyUp={event => setCtrl(event.ctrlKey)} onBlur={() => setCtrl(false)} />
    </div>
  </div>;
}

function effectiveMatchFormatting(match: BulkMatch): TextFormatRange[] {
  const manual = match.formatting ?? [];
  const automatic = (match.autoFormatting ?? []).flatMap(range => {
    const overrides = range.kind === "superscript" || range.kind === "subscript"
      ? manual.filter(item => item.kind === "superscript" || item.kind === "subscript")
      : manual.filter(item => item.kind === range.kind);
    let pieces = [range];
    for (const override of overrides) {
      pieces = pieces.flatMap(piece => {
        if (piece.end <= override.start || piece.start >= override.end) return [piece];
        return [
          ...(piece.start < override.start ? [{ ...piece, end: override.start }] : []),
          ...(piece.end > override.end ? [{ ...piece, start: override.end }] : []),
        ];
      });
    }
    return pieces;
  });
  return [...automatic, ...manual];
}

function HighlightedMatch({ match, search }: { match: BulkMatch; search: string }) {
  const { lineText: text, matchOrdinal: ordinal } = match;
  let start = -1;
  let cursor = 0;
  for (let occurrence = 0; occurrence <= ordinal; occurrence++) {
    start = text.indexOf(search, cursor);
    if (start < 0) return <>{text}</>;
    cursor = start + search.length;
  }
  const end = start + search.length;
  const formatting = effectiveMatchFormatting(match);
  const boundaries = [...new Set([0, text.length, start, end, ...formatting.flatMap(range => [Math.max(0, Math.min(text.length, range.start)), Math.max(0, Math.min(text.length, range.end))])])].sort((a, b) => a - b);
  return <>{boundaries.slice(0, -1).map((from, index) => {
    const to = boundaries[index + 1];
    if (from === to) return null;
    const active = new Set(formatting.filter(range => range.start < to && range.end > from).map(range => range.kind));
    const style: React.CSSProperties = {};
    if (active.has("bold")) style.fontWeight = 700;
    if (active.has("italic")) style.fontStyle = "italic";
    if (active.has("superscript")) { style.verticalAlign = "super"; style.fontSize = "0.75em"; }
    if (active.has("subscript")) { style.verticalAlign = "sub"; style.fontSize = "0.75em"; }
    const content = text.slice(from, to);
    return from < end && to > start
      ? <mark key={from} className="bulk-replace-match" style={style}>{content}</mark>
      : <span key={from} style={style}>{content}</span>;
  })}</>;
}

function MatchRow({ match, search, checked, getSnippet, onToggle }: {
  match: BulkMatch; search: string; checked: boolean; getSnippet?: BulkReplaceDialogProps["getSnippet"]; onToggle: () => void;
}) {
  const [snippet, setSnippet] = useState<string | null>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let active = true;
    if (!getSnippet) return;
    void getSnippet(match).then(value => { if (active) setSnippet(value); }).catch(() => { if (active) setSnippet(null); });
    return () => { active = false; };
  }, [getSnippet, match]);
  useEffect(() => {
    const viewport = textRef.current;
    const highlighted = viewport?.querySelector<HTMLElement>(".bulk-replace-match");
    if (!viewport || !highlighted) return;
    viewport.scrollLeft = Math.max(0, highlighted.offsetLeft - viewport.offsetLeft - (viewport.clientWidth - highlighted.offsetWidth) / 2);
  }, [match.lineText, match.matchOrdinal, search]);
  return <label className="bulk-replace-result">
    <input type="checkbox" checked={checked} onChange={onToggle} />
    <span className="bulk-replace-snippet">{snippet ? <img src={snippet} alt="" /> : <span>OCR</span>}</span>
    <span className="bulk-replace-result-copy"><strong>{match.pageLabel} · {match.lineId} · #{match.matchOrdinal + 1}</strong><span ref={textRef} title={match.lineText}><HighlightedMatch match={match} search={search} /></span></span>
  </label>;
}

export function BulkReplaceDialog({ open, projectPath, initialSearch, initialMatch, getSnippet, onApply, onClose }: BulkReplaceDialogProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState(initialSearch);
  const [replacement, setReplacement] = useState(initialSearch);
  const [replacementFormatting, setReplacementFormatting] = useState<TextFormatRange[]>([]);
  const [resultPage, setResultPage] = useState(0);
  const [data, setData] = useState<SearchPage>({ results: [], total: 0, page: 0, pageSize: PAGE_SIZE });
  const [selected, setSelected] = useState<Map<string, BulkMatch>>(() => new Map());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSearch(initialSearch); setReplacement(initialSearch); setReplacementFormatting([]); setResultPage(0); setSelected(new Map(initialMatch ? [[keyOf(initialMatch), initialMatch]] : [])); setError(null);
  }, [open, initialSearch, initialMatch]);

  useEffect(() => {
    if (!open || !projectPath || !search) { setData({ results: [], total: 0, page: resultPage, pageSize: PAGE_SIZE }); return; }
    let active = true; setError(null);
    void invokeCommand("search_corrections", { projectPath, search, page: resultPage, pageSize: PAGE_SIZE })
      .then(next => { if (active) setData(next as SearchPage); })
      .catch(reason => { if (active) { setData({ results: [], total: 0, page: resultPage, pageSize: PAGE_SIZE }); setError(reason instanceof Error ? reason.message : String(reason)); } });
    return () => { active = false; };
  }, [open, projectPath, search, resultPage]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !working) onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose, working]);

  const pageCount = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const allPageSelected = data.results.length > 0 && data.results.every(result => selected.has(keyOf(result)));
  const selectedCount = selected.size;
  const selection = useMemo(() => [...selected.values()], [selected]);
  if (!open) return null;
  const toggle = (result: BulkMatch) => setSelected(previous => { const next = new Map(previous); const key = keyOf(result); if (next.has(key)) next.delete(key); else next.set(key, result); return next; });
  const togglePage = () => setSelected(previous => { const next = new Map(previous); for (const result of data.results) { const key = keyOf(result); if (allPageSelected) next.delete(key); else next.set(key, result); } return next; });
  const submit = async (preserveFormatting: boolean) => {
    if (!selectedCount || working) return;
    setWorking(true); setError(null);
    try { await onApply({ search, replacement, replacementFormatting, preserveFormatting, selections: selection }); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  };

  return <div className="modal-scrim bulk-replace-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !working) onClose(); }}>
    <section className="modal bulk-replace-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-replace-title">
      <header className="bulk-replace-header"><div><span className="eyebrow">CORRECTION</span><h2 id="bulk-replace-title">{t("bulkReplace.title")}</h2></div><button className="icon-button" type="button" aria-label={t("bulkReplace.close")} onClick={onClose} disabled={working}><X size={16} /></button></header>
      <div className="bulk-replace-fields"><label>{t("bulkReplace.source")}<input value={search} readOnly /></label><label>{t("bulkReplace.replacement")}<ReplacementEditor value={replacement} formatting={replacementFormatting} onChange={setReplacement} onFormattingChange={setReplacementFormatting} /></label></div>
      <div className="bulk-replace-results-head"><strong>{t("bulkReplace.results", { count: data.total })}</strong><button type="button" className="text-button" onClick={togglePage} disabled={!data.results.length}>{allPageSelected ? t("bulkReplace.clearPage") : t("bulkReplace.selectPage")}</button></div>
      <div className="bulk-replace-results" aria-live="polite">{data.results.map(result => <MatchRow key={keyOf(result)} match={result} search={search} checked={selected.has(keyOf(result))} getSnippet={getSnippet} onToggle={() => toggle(result)} />)}{!data.results.length && <p className="bulk-replace-empty"><Search size={15} />{t("bulkReplace.noResults")}</p>}</div>
      <footer className="bulk-replace-footer"><div className="bulk-replace-pagination"><button type="button" className="icon-button" aria-label={t("bulkReplace.previous")} disabled={resultPage === 0} onClick={() => setResultPage(page => page - 1)}><ChevronLeft size={16} /></button><span>{resultPage + 1} / {pageCount}</span><button type="button" className="icon-button" aria-label={t("bulkReplace.next")} disabled={resultPage + 1 >= pageCount} onClick={() => setResultPage(page => page + 1)}><ChevronRight size={16} /></button></div><div className="modal-actions"><button className="secondary" type="button" disabled={working} onClick={onClose}>{t("bulkReplace.cancel")}</button><button className="secondary" type="button" disabled={working || !selectedCount} onClick={() => void submit(false)}>{working ? t("bulkReplace.applying") : t("bulkReplace.applyFormatting", { count: selectedCount })}</button><button className="primary" type="button" disabled={working || !selectedCount} onClick={() => void submit(true)}>{working ? t("bulkReplace.applying") : t("bulkReplace.preserveFormatting", { count: selectedCount })}</button></div></footer>
      {error && <p className="form-error">{error}</p>}
    </section>
  </div>;
}
