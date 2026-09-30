import { useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { ModalDialog } from "../components/ModalDialog";

interface SheetProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  className?: string;
  /** Pinned below the scrolling body, inside the thumb zone. */
  footer?: ReactNode;
  describedBy?: string;
  hideTitle?: boolean;
  closeLabel?: string;
}

const DISMISS_DISTANCE = 96;

/** Bottom sheet: drag the grabber or header down to dismiss. */
export function Sheet({
  title,
  children,
  onClose,
  busy = false,
  className = "",
  footer,
  describedBy,
  hideTitle = false,
  closeLabel,
}: SheetProps) {
  const titleId = useId();
  const drag = useRef<{ id: number; y: number; dy: number } | null>(null);
  const setOffset = (element: HTMLElement, dy: number | null) => {
    const sheet = element.closest<HTMLElement>(".sheet");
    if (!sheet) return;
    if (dy === null) {
      sheet.style.removeProperty("--sheet-drag");
      delete sheet.dataset.dragging;
    } else {
      sheet.dataset.dragging = "true";
      sheet.style.setProperty("--sheet-drag", `${dy}px`);
    }
  };
  return (
    <ModalDialog
      labelledBy={titleId}
      {...(describedBy ? { describedBy } : {})}
      onClose={onClose}
      busy={busy}
      className={`modal sheet ${className}`.trim()}
    >
      <header
        className="bsheet-header"
        onPointerDown={(event) => {
          if (busy || (event.target as Element).closest("button")) return;
          drag.current = { id: event.pointerId, y: event.clientY, dy: 0 };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          current.dy = Math.max(0, event.clientY - current.y);
          setOffset(event.currentTarget, current.dy);
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          drag.current = null;
          setOffset(event.currentTarget, null);
          if (current && current.dy > DISMISS_DISTANCE) onClose();
        }}
        onPointerCancel={(event) => {
          drag.current = null;
          setOffset(event.currentTarget, null);
        }}
      >
        <span className="bsheet-grabber" aria-hidden="true" />
        <h2 id={titleId} className={hideTitle ? "visually-hidden" : undefined}>
          {title}
        </h2>
        <button
          className="icon-btn"
          disabled={busy}
          onClick={onClose}
          aria-label={closeLabel ?? `Close ${title.toLowerCase()}`}
        >
          <X size={18} />
        </button>
      </header>
      <div className="modal-body bsheet-body">{children}</div>
      {footer && <div className="bsheet-footer">{footer}</div>}
    </ModalDialog>
  );
}

export interface SheetAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

/** iOS-style action list anchored to the bottom edge. */
export function ActionSheet({
  title,
  actions,
  onClose,
}: {
  title: string;
  actions: SheetAction[];
  onClose: () => void;
}) {
  return (
    <Sheet title={title} onClose={onClose} className="action-sheet">
      <div className="action-list" role="menu" aria-label={title}>
        {actions.map((action) => (
          <button
            key={action.label}
            role="menuitem"
            className={`action-row${action.destructive ? " is-destructive" : ""}`}
            disabled={action.disabled}
            onClick={() => {
              onClose();
              action.onSelect();
            }}
          >
            {action.icon}
            <span>{action.label}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/** Confirmation for irreversible actions, with the safe choice as the easy thumb target. */
export function ConfirmSheet({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  busy = false,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <div className="button-stack">
          <button className="btn btn--danger" disabled={busy} onClick={onConfirm}>
            {busy ? "Working…" : confirmLabel}
          </button>
          <button className="btn btn--secondary" disabled={busy} onClick={onClose}>
            {cancelLabel}
          </button>
        </div>
      }
    >
      <p className="sheet-message">{message}</p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
