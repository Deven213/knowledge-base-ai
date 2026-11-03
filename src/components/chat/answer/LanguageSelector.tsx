"use client";

import { useRef } from "react";
import { LANGUAGES } from "@/lib/languages";
import { Spinner } from "../../ui";

/**
 * Per-response language switch: EN | हिन्दी | ગુજરાતી (radio group; arrow keys move between options).
 * Changing it updates THIS response in place; it never adds a message. It stays usable while a language is being prepared:
 * the newest choice wins.
 */
export function LanguageSelector({
  value,
  onChange,
  busy,
}: {
  value: string;
  onChange: (code: string) => void;
  /** Language currently being generated (shows a spinner and blocks further changes). */
  busy: string | null;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    const last = LANGUAGES.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? (index === last ? 0 : index + 1)
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (index === 0 ? last : index - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label="Response language" className="inline-flex shrink-0 rounded-full border border-slate-300 bg-slate-100 p-0.5">
      {LANGUAGES.map((l, i) => {
        const selected = l.code === value;
        const loading = busy === l.code;
        return (
          <button
            key={l.code}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-busy={loading || undefined}
            aria-label={l.label}
            lang={l.htmlLang}
            tabIndex={selected ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, i)}
            onClick={() => (!selected || busy) && onChange(l.code)} // while one is preparing, another choice (even the language shown) replaces it
            className={`inline-flex min-w-11 items-center justify-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-brand-600 disabled:cursor-wait ${
              selected ? "bg-brand-700 text-white" : "text-slate-700 hover:bg-slate-200 hover:text-slate-900"
            }`}
          >
            {loading && <Spinner className="h-3 w-3" />}
            {l.shortLabel}
          </button>
        );
      })}
    </div>
  );
}
