import { Fragment, forwardRef, useLayoutEffect, useRef, type CSSProperties } from "react";
import type { TextFormatRange } from "./domain";

type Props = {
  value: string;
  formatting: TextFormatRange[];
  selectionStart: number;
  selectionEnd: number;
  caret: number;
  fontSize: number;
  style: CSSProperties;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const ProofingTextMagnifier = forwardRef<HTMLDivElement, Props>(function ProofingTextMagnifier(
  { value, formatting, selectionStart, selectionEnd, caret, fontSize, style }, forwardedRef,
) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<HTMLSpanElement | null>(null);
  const setPanelRef = (node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  };
  const selection = {
    start: clamp(Math.min(selectionStart, selectionEnd), 0, value.length),
    end: clamp(Math.max(selectionStart, selectionEnd), 0, value.length),
  };
  const boundaries = new Set([0, value.length, clamp(caret, 0, value.length), selection.start, selection.end]);
  formatting.forEach(range => {
    boundaries.add(clamp(range.start, 0, value.length));
    boundaries.add(clamp(range.end, 0, value.length));
  });
  const offsets = [...boundaries].sort((a, b) => a - b);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const caretMark = caretRef.current;
    if (!panel || !caretMark) return;
    const inset = 10;
    const available = panel.clientWidth - inset * 2;
    if (available <= 0) return;
    const markerX = caretMark.getBoundingClientRect().left - panel.getBoundingClientRect().left - inset + panel.scrollLeft;
    panel.scrollLeft = clamp(markerX - available / 2, 0, Math.max(0, panel.scrollWidth - panel.clientWidth));
  }, [value, formatting, selectionStart, selectionEnd, caret, fontSize]);

  const marker = <span ref={caretRef} className="proofing-text-caret" aria-hidden="true" />;
  return <div ref={setPanelRef} className="proofing-text-magnifier" style={style} aria-hidden="true">
    <div className="proofing-text-flow" style={{ fontSize, lineHeight: 1.3 }}>
      {value.length === 0 && marker}
      {offsets.slice(0, -1).map((start, index) => {
        const end = offsets[index + 1];
        const kinds = new Set(formatting.filter(range => range.start <= start && range.end >= end).map(range => range.kind));
        const selected = start < selection.end && end > selection.start;
        const decoration: CSSProperties = {
          fontWeight: kinds.has("bold") ? 700 : undefined,
          fontStyle: kinds.has("italic") ? "italic" : undefined,
          fontSize: kinds.has("superscript") || kinds.has("subscript") ? ".7em" : undefined,
          verticalAlign: kinds.has("superscript") ? "super" : kinds.has("subscript") ? "sub" : undefined,
        };
        return <Fragment key={start}>
          {start === clamp(caret, 0, value.length) && marker}
          <span className={selected ? "proofing-text-selection" : undefined} style={decoration}>{value.slice(start, end)}</span>
        </Fragment>;
      })}
      {caret === value.length && value.length > 0 && marker}
    </div>
  </div>;
});
