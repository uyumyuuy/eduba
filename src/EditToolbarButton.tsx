import type { ReactNode } from "react";
import "./EditToolbarButton.css";

type EditToolbarButtonProps = {
  children: ReactNode;
  label: string;
  shortcut?: string;
  showShortcut?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
};

export function EditToolbarButton({
  children,
  label,
  shortcut,
  showShortcut = false,
  disabled = false,
  onClick,
  className = "",
}: EditToolbarButtonProps) {
  return (
    <button
      type="button"
      className={`edit-toolbar-button ${className}`.trim()}
      onClick={onClick}
      aria-label={label}
      disabled={disabled}
    >
      {shortcut && <span className={`edit-toolbar-shortcut${showShortcut ? " is-visible" : ""}`} aria-hidden="true">{shortcut}</span>}
      <span className="edit-toolbar-label">{children}</span>
    </button>
  );
}
