"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Cloud, FileText, Globe, HardDrive, Library, type LucideIcon } from "lucide-react";
import { scopeKey, sourceCountLabel, type KnowledgeScope, type KnowledgeScopeType, type KnowledgeSourceDTO } from "@/lib/knowledge-scope";

const ICONS: Record<KnowledgeScopeType, { icon: LucideIcon; className: string; kind: string }> = {
  all: { icon: Library, className: "bg-teal-50 text-teal-700", kind: "All sources" },
  website: { icon: Globe, className: "bg-emerald-50 text-emerald-700", kind: "Website" },
  google_drive: { icon: HardDrive, className: "bg-blue-50 text-blue-700", kind: "Google Drive" },
  onedrive: { icon: Cloud, className: "bg-sky-50 text-sky-700", kind: "OneDrive" },
  document: { icon: FileText, className: "bg-orange-50 text-orange-600", kind: "Document" },
};

export function SourceIcon({ type, size = "md" }: { type: KnowledgeScopeType; size?: "sm" | "md" }) {
  const { icon: Icon, className } = ICONS[type];
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-md ${className} ${size === "sm" ? "h-5 w-5" : "h-7 w-7"}`} aria-hidden>
      <Icon className={size === "sm" ? "h-3 w-3" : "h-4 w-4"} />
    </span>
  );
}

/**
 * "Chat with": which data the conversation searches. Single choice; the selected source is always
 * shown on the button. Keyboard: ↑/↓/Home/End to move, Enter/Space to choose, Esc to close.
 */
export function KnowledgeSourcePicker({
  sources,
  selected,
  onSelect,
  disabled,
}: {
  sources: KnowledgeSourceDTO[];
  /** The current source (may be one that no longer has documents; it is still shown). */
  selected: KnowledgeSourceDTO;
  onSelect: (scope: KnowledgeScope) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function openList() {
    const current = sources.findIndex((s) => s.key === selected.key);
    setActive(current >= 0 ? current : 0);
    setOpen(true);
  }

  function choose(index: number) {
    const source = sources[index];
    setOpen(false);
    buttonRef.current?.focus();
    if (source && source.key !== selected.key) onSelect(source.scope);
  }

  function onListKey(e: React.KeyboardEvent) {
    const last = sources.length - 1;
    const moves: Record<string, () => number> = {
      ArrowDown: () => Math.min(active + 1, last),
      ArrowUp: () => Math.max(active - 1, 0),
      Home: () => 0,
      End: () => last,
    };
    if (moves[e.key]) {
      e.preventDefault();
      setActive(moves[e.key]!());
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    }
  }

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            openList();
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={`Chat with: ${selected.label}, ${sourceCountLabel(selected)}. Change knowledge source`}
        className="flex max-w-full min-w-0 items-center gap-2 rounded-xl border border-slate-200 bg-white py-1 pr-2 pl-1.5 text-left shadow-xs transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-60"
      >
        <SourceIcon type={selected.scope.type} />
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-sm font-semibold text-slate-800">{selected.label}</span>
          <span className="block truncate text-[11px] text-slate-500">{sourceCountLabel(selected)}</span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        // Phones: full width under the header (never past the screen edge); larger screens: under the button.
        <div className="fixed inset-x-3 top-14 z-30 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg sm:absolute sm:inset-x-auto sm:top-auto sm:left-0 sm:mt-1.5 sm:w-80">

          <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-slate-500" id={`${id}-label`}>
            Chat with
          </p>
          <ul
            ref={listRef}
            id={`${id}-list`}
            role="listbox"
            tabIndex={-1}
            aria-labelledby={`${id}-label`}
            aria-activedescendant={`${id}-opt-${active}`}
            onKeyDown={onListKey}
            className="max-h-80 overflow-y-auto focus:outline-none"
          >
            {sources.map((s, i) => {
              const isSelected = s.key === selected.key;
              return (
                <li
                  key={s.key}
                  id={`${id}-opt-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 ${i === active ? "bg-slate-100" : ""}`}
                >
                  <SourceIcon type={s.scope.type} />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className={`block truncate text-sm ${isSelected ? "font-semibold text-slate-900" : "text-slate-700"}`}>{s.label}</span>
                    <span className="block truncate text-[11px] text-slate-500">
                      {s.scope.type === "all" ? sourceCountLabel(s) : `${ICONS[s.scope.type].kind} · ${sourceCountLabel(s)}`}
                    </span>
                  </span>
                  {isSelected && <Check className="h-4 w-4 shrink-0 text-brand-600" aria-hidden />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One-line description of what a source means for the conversation (banner, indicator, placeholder). */
export function describeSource(source: KnowledgeSourceDTO) {
  const count = sourceCountLabel(source);
  switch (source.scope.type) {
    case "all":
      return {
        banner: "This conversation can use all indexed documents.",
        indicator: `Using ${count} from Knowledge Base`,
        placeholder: "Ask anything about your documents...",
      };
    case "website":
      return {
        banner: `This conversation will use only content from this website (${count}).`,
        indicator: `Using ${count} from ${source.label}`,
        placeholder: `Ask about ${source.label}...`,
      };
    case "document":
      return {
        banner: "This conversation will use only content from this document.",
        indicator: `Using ${source.label}`,
        placeholder: `Ask about ${source.label}...`,
      };
    default:
      return {
        banner: `This conversation will use only your ${source.label} documents (${count}).`,
        indicator: `Using ${count} from ${source.label}`,
        placeholder: `Ask about your ${source.label} documents...`,
      };
  }
}
