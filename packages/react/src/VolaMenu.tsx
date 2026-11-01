import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

export interface VolaMenuItem {
  key: string;
  label: ReactNode;
  onSelect: () => void;
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
}

export interface VolaMenuProps {
  /** The trigger's accessible name. */
  label: string;
  /** The trigger's content. Default `⋯`. */
  trigger?: ReactNode;
  items: readonly VolaMenuItem[];
  className?: string | undefined;
}

/**
 * A small action menu without a dependency: a `menu` of `menuitem`s opened by its button,
 * closed by Escape, a selection or a click elsewhere; arrows move between items.
 */
export function VolaMenu({ label, trigger = "⋯", items, className }: VolaMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    const first = root.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not([disabled])',
    );
    first?.focus();
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const list = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ??
        []),
    ];
    if (list.length === 0) return;
    event.preventDefault();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % list.length
        : (index - 1 + list.length) % list.length;
    list[next]?.focus();
  };

  return (
    <span ref={root} className={`vola-menu${className ? ` ${className}` : ""}`}>
      <button
        ref={button}
        onKeyDown={onKeyDown}
        type="button"
        className="vola-btn vola-btn--ghost vola-menu__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open ? (
        <div
          id={`${id}-menu`}
          className="vola-menu__list"
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={`vola-menu__item${item.danger ? " vola-menu__item--danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
