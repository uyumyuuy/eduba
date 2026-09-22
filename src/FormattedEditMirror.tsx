import type { CSSProperties, Ref } from "react";
import type { TextFormatRange } from "./domain";
import "./FormattedEditMirror.css";

function segments(value: string, formatting: TextFormatRange[]) {
  const boundaries = new Set([0, value.length]);
  for (const range of formatting) {
    boundaries.add(Math.max(0, Math.min(value.length, range.start)));
    boundaries.add(Math.max(0, Math.min(value.length, range.end)));
  }
  const offsets = [...boundaries].sort((a, b) => a - b);
  return offsets.slice(0, -1).map((start, index) => {
    const end = offsets[index + 1];
    const kinds = new Set(formatting.filter(range => range.start <= start && range.end >= end).map(range => range.kind));
    return { start, text: value.slice(start, end), kinds };
  });
}

export function FormattedEditMirror({ value, formatting, className, style, mirrorRef }: {
  value: string;
  formatting: TextFormatRange[];
  className: string;
  style?: CSSProperties;
  mirrorRef?: Ref<HTMLDivElement>;
}) {
  return <div ref={mirrorRef} aria-hidden="true" className={`formatted-edit-mirror ${className}`} style={style}>
    {segments(value, formatting).map(({ start, text, kinds }) => {
      if (!kinds.size) return <span key={start}>{text}</span>;
      const decoration: CSSProperties = {
        fontWeight: kinds.has("bold") ? 700 : undefined,
        fontStyle: kinds.has("italic") ? "italic" : undefined,
      };
      if (kinds.has("superscript") || kinds.has("subscript")) {
        decoration.fontSize = "0.7em";
        decoration.transform = kinds.has("superscript") ? "translateY(-0.35em)" : "translateY(0.3em)";
      }
      return <span key={start} className="formatted-edit-advance">
        {text}
        <span className="formatted-edit-decoration" style={decoration}>{text}</span>
      </span>;
    })}
  </div>;
}
