"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { MoreVertical, X, type LucideIcon } from "lucide-react";
import { BackButton } from "./BackButton";

export function PageHeader({
  icon: Icon,
  title,
  subtitle,
  actions,
  back = false,
  iconClassName,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  actions?: ReactNode;
  /** Shows a Back button above the title; a string makes Back always go to that page. */
  back?: boolean | string;
  /** Replaces the default brand gradient behind the icon (e.g. a product's colours). */
  iconClassName?: string;
}) {
  return (
    <>
      {back && <BackButton href={typeof back === "string" ? back : undefined} className="-mt-2 mb-2 -ml-2" />}
      <PageHeaderRow icon={Icon} title={title} subtitle={subtitle} actions={actions} iconClassName={iconClassName} />
    </>
  );
}

function PageHeaderRow({
  icon: Icon,
  title,
  subtitle,
  actions,
  iconClassName = "brand-gradient",
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  actions?: ReactNode;
  iconClassName?: string;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div className={`${iconClassName} flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white shadow-sm`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
          <p className="text-sm text-slate-500">{subtitle}</p>
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

const BADGE_TONES = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/15",
  red: "bg-red-50 text-red-700 ring-red-600/15",
  amber: "bg-amber-50 text-amber-700 ring-amber-600/15",
  blue: "bg-blue-50 text-blue-700 ring-blue-600/15",
  slate: "bg-slate-100 text-slate-600 ring-slate-500/15",
} as const;

export function Badge({ tone = "slate", children }: { tone?: keyof typeof BADGE_TONES; children: ReactNode }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${BADGE_TONES[tone]}`}>
      {children}
    </span>
  );
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} />;
}

export function Alert({ tone = "red", children }: { tone?: "red" | "amber" | "green"; children: ReactNode }) {
  const tones = {
    red: "border-red-200 bg-red-50 text-red-700",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    green: "border-emerald-200 bg-emerald-50 text-emerald-800",
  };
  return (
    <div role={tone === "red" ? "alert" : "status"} className={`rounded-lg border px-3.5 py-2.5 text-sm ${tones[tone]}`}>
      {children}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        <Icon className="h-6 w-6" />
      </div>
      <p className="font-medium text-slate-800">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-slate-500">{children}</div>}
    </div>
  );
}

// While any dialog is open the page behind it must not scroll. Several can be open at once (a confirmation over another dialog), so the
// lock is counted: the page is released only when the last one closes, and goes back exactly as it was.
let pageScrollLocks = 0;
let releasePageScroll: (() => void) | null = null;

function lockPageScroll() {
  if (pageScrollLocks++ > 0) return;
  const html = document.documentElement;
  const body = document.body;
  const before = { overflow: html.style.overflow, paddingRight: body.style.paddingRight };
  // Hiding the scrollbar widens the page; pad by the same amount so nothing behind the dialog shifts sideways.
  const scrollbar = window.innerWidth - html.clientWidth;
  html.style.overflow = "hidden";
  if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
  releasePageScroll = () => {
    html.style.overflow = before.overflow;
    body.style.paddingRight = before.paddingRight;
  };
}

function unlockPageScroll() {
  if (--pageScrollLocks > 0) return;
  pageScrollLocks = 0;
  releasePageScroll?.();
  releasePageScroll = null;
}

/** The dialogs currently open, oldest first: only the newest one pulls keyboard focus back, so two open at once do not fight over it. */
const openDialogs: symbol[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A dialog that always fits the screen. It is never taller than the visible area (see .modal-panel): the header and the action
 * buttons stay in view and the content between them scrolls by itself, so nothing is ever cut off or out of reach, on a small laptop,
 * a phone held either way, or a browser zoomed in. Short dialogs look exactly as before.
 *
 * Also: the page behind does not scroll; keyboard focus moves into the dialog, stays there while it is open and returns to what had it
 * when it closes; and the dialog is named by its visible title for screen readers.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = "default",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** "wide" (560px) is for dialogs with a lot to read; the default is 512px. Both shrink to fit a phone. */
  size?: "default" | "wide";
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    lockPageScroll();
    return unlockPageScroll;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const me = Symbol("dialog");
    openDialogs.push(me);
    const panel = panelRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Start inside the dialog, unless a control in it already asked for focus (autoFocus).
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    // Tabbing, a click or a screen reader can still move focus out to the page behind: bring it back.
    const pullBack = (e: FocusEvent) => {
      if (openDialogs.at(-1) !== me || !panel || panel.contains(e.target as Node)) return;
      (panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel).focus({ preventScroll: true });
    };
    document.addEventListener("focusin", pullBack);
    return () => {
      document.removeEventListener("focusin", pullBack);
      openDialogs.splice(openDialogs.indexOf(me), 1);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  /** Tab at the last control goes to the first, and Shift+Tab at the first goes to the last, so focus cycles inside the dialog. */
  function keepTabInside(e: ReactKeyboardEvent<HTMLDivElement>) {
    const panel = panelRef.current;
    if (e.key !== "Tab" || !panel) return;
    const controls = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) {
      e.preventDefault();
      panel.focus();
    } else if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`card modal-panel flex w-full flex-col overflow-hidden shadow-xl focus:outline-none ${size === "wide" ? "max-w-[560px]" : "max-w-lg"}`}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={keepTabInside}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <h2 id={titleId} className="min-w-0 text-lg font-semibold">
            {title}
          </h2>
          <button type="button" onClick={onClose} className="btn btn-ghost shrink-0 p-1.5" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  danger?: boolean;
  onSelect: () => void;
}

/** Kebab (⋮) menu, as used on list rows. */
export function RowMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="btn btn-ghost p-1.5"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 min-w-40 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {items.map(({ label: itemLabel, icon: Icon, danger, onSelect }) => (
            <button
              key={itemLabel}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSelect();
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 ${danger ? "text-red-600" : "text-slate-700"}`}
            >
              {Icon && <Icon className="h-4 w-4" />}
              {itemLabel}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDate(iso: string, withTime = false): string {
  const d = new Date(iso);
  return withTime
    ? d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Accessible on/off toggle (role="switch"). */
export function Switch({
  checked,
  disabled,
  busy,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  busy: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled || busy}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed ${
        checked ? "bg-brand-600" : "bg-slate-300"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <span
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5.5" : "translate-x-0.5"
        }`}
      >
        {busy && <Spinner className="h-3 w-3 text-slate-400" />}
      </span>
    </button>
  );
}
