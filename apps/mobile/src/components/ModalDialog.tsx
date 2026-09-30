import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalDialogProps {
  children: ReactNode;
  labelledBy: string;
  describedBy?: string;
  onClose: () => void;
  busy?: boolean;
  className?: string;
  backdropClassName?: string;
}

interface ExcludedElement {
  count: number;
  inert: string | null;
  hidden: string | null;
}

// Keep prior attributes and reference counts so stacked dialogs restore the
// background only when its last modal owner closes.
const excludedElements = new Map<Element, ExcludedElement>();
const activeDialogs: HTMLElement[] = [];
function exclude(element: Element): () => void {
  let entry = excludedElements.get(element);
  if (!entry) {
    entry = {
      count: 0,
      inert: element.getAttribute("inert"),
      hidden: element.getAttribute("aria-hidden"),
    };
    excludedElements.set(element, entry);
  }
  entry.count += 1;
  element.setAttribute("inert", "");
  element.setAttribute("aria-hidden", "true");
  return () => {
    entry.count -= 1;
    if (entry.count > 0) return;
    if (entry.inert === null) element.removeAttribute("inert");
    else element.setAttribute("inert", entry.inert);
    if (entry.hidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", entry.hidden);
    excludedElements.delete(element);
  };
}

function tabbableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]"),
  ).filter((element) => {
    if (
      element.tabIndex < 0 ||
      element.matches(":disabled") ||
      element.closest('[inert], [hidden], [aria-hidden="true"]')
    )
      return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

/** Portal outside the app root so inert excludes the scene without hiding the dialog. */
export function ModalDialog({
  children,
  labelledBy,
  describedBy,
  onClose,
  busy = false,
  className = "modal",
  backdropClassName = "",
}: ModalDialogProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const latest = useRef({ onClose, busy });
  latest.current = { onClose, busy };

  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;
    const previousFocus = document.activeElement;
    const previousAncestors: HTMLElement[] = [];
    for (
      let ancestor = previousFocus?.parentElement;
      ancestor && ancestor !== document.body;
      ancestor = ancestor.parentElement
    )
      previousAncestors.push(ancestor);
    activeDialogs.push(backdrop);
    // Focusing the container announces its title and description without opening
    // the phone keyboard or scrolling a long dialog to its first form field.
    dialog.focus({ preventScroll: true });
    const restoreBackground = Array.from(document.body.children)
      .filter((element) => element !== backdrop)
      .map(exclude);

    const active = () => activeDialogs.at(-1) === backdrop;
    const containFocus = (event: FocusEvent) => {
      if (active() && event.target instanceof Node && !dialog.contains(event.target))
        dialog.focus({ preventScroll: true });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!active()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!latest.current.busy) latest.current.onClose();
      } else if (event.key === "Tab") {
        const items = tabbableElements(dialog);
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (items.length === 0) {
          event.preventDefault();
          dialog.focus({ preventScroll: true });
        } else if (event.shiftKey ? index <= 0 : index < 0 || index === items.length - 1) {
          event.preventDefault();
          const target = event.shiftKey ? items.at(-1) : items[0];
          target?.focus();
        }
      }
    };
    document.addEventListener("focusin", containFocus);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("focusin", containFocus);
      document.removeEventListener("keydown", onKeyDown, true);
      activeDialogs.splice(activeDialogs.indexOf(backdrop), 1);
      restoreBackground.forEach((restore) => restore());
      // React may remove the trigger later in this same commit (Delete shot).
      // Choose a surviving target after the commit's DOM work has finished.
      queueMicrotask(() => {
        if (
          previousFocus instanceof HTMLElement &&
          previousFocus.isConnected &&
          !previousFocus.matches(":disabled") &&
          !previousFocus.closest('[inert], [hidden], [aria-hidden="true"]')
        )
          previousFocus.focus({ preventScroll: true });
        else {
          // Deleting a shot also removes its Edit button. Return to the nearest
          // surviving control group (the shot tray), rather than the document body.
          for (const ancestor of previousAncestors) {
            if (
              !ancestor.isConnected ||
              ancestor.closest('[inert], [hidden], [aria-hidden="true"]')
            )
              continue;
            const target = tabbableElements(ancestor)[0];
            if (target) {
              target.focus({ preventScroll: true });
              break;
            }
          }
        }
      });
    };
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    // Authentication and confirmation steps can remove the focused control.
    // Keep focus in the same open dialog when its content is replaced.
    if (
      dialog &&
      activeDialogs.at(-1) === backdropRef.current &&
      !dialog.contains(document.activeElement)
    )
      dialog.focus({ preventScroll: true });
  });

  return createPortal(
    <div
      ref={backdropRef}
      className={`modal-backdrop ${backdropClassName}`.trim()}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !latest.current.busy) latest.current.onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={`${className} modal-dialog`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        {children}
      </section>
    </div>,
    document.body,
  );
}
