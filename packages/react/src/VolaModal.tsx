import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import { useVolaT } from "./i18n.js";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface VolaModalProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  /** `alertdialog` for a confirmation (delete, reset). Default `dialog`. */
  role?: "dialog" | "alertdialog";
  /** Called on Escape, on the overlay, on the close button. */
  onClose: () => void;
  /** `false`: Escape and the overlay do nothing (an operation in flight). */
  dismissable?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * A modal dialog without a dependency: `role="dialog"`, `aria-modal`, labelled by its
 * title, the focus trapped inside (Tab cycles), Escape and the overlay close it, and the
 * element that opened it gets the focus back.
 */
export function VolaModal({
  open,
  title,
  description,
  role = "dialog",
  onClose,
  dismissable = true,
  children,
  footer,
  className,
}: VolaModalProps) {
  const { t } = useVolaT();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    // The first field of the body, else the first control (the close button), else the panel.
    const body = panel.current?.querySelector<HTMLElement>(".vola-modal__body");
    const first =
      body?.querySelector<HTMLElement>(FOCUSABLE) ??
      panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    // Escape closes even when the focus fell out of the panel (an element under it was removed).
    const onDocumentKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dismissable) return;
      if (panel.current?.contains(event.target as Node)) return; // the panel's own handler
      onClose();
    };
    document.addEventListener("keydown", onDocumentKey);
    return () => {
      document.removeEventListener("keydown", onDocumentKey);
      const previous = opener.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open, dismissable, onClose]);

  if (!open) return null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (dismissable) onClose();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onOverlay = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && dismissable) onClose();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the overlay only catches a click outside the panel; the panel handles the keyboard.
    <div className="vola vola-modal-overlay" onClick={onOverlay} onKeyDown={onKeyDown}>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: `role` is `dialog` or `alertdialog`; both take aria-modal. */}
      <div
        ref={panel}
        className={`vola-modal${className ? ` ${className}` : ""}`}
        role={role}
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        tabIndex={-1}
      >
        <header className="vola-modal__header">
          <h2 id={`${id}-title`} className="vola-modal__title">
            {title}
          </h2>
          <button
            type="button"
            className="vola-btn vola-btn--ghost vola-modal__close"
            onClick={onClose}
            aria-label={t("CLOSE")}
          >
            ×
          </button>
        </header>
        {description ? (
          <p id={`${id}-desc`} className="vola-modal__description">
            {description}
          </p>
        ) : null}
        <div className="vola-modal__body">{children}</div>
        {footer ? <footer className="vola-modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
