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
      {(shortcut || className.split(/\s+/).includes("text-candidate")) && <span className={`edit-toolbar-shortcut${showShortcut && shortcut ? " is-visible" : ""}`} aria-hidden="true">{shortcut ?? "\u00a0"}</span>}
      <span className="edit-toolbar-label">{children}</span>
    </button>
  );
}
