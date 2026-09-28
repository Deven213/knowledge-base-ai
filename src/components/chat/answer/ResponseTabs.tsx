"use client";

import { useEffect, useRef } from "react";

export interface ResponseTab {
  /** Element id of the section this tab jumps to. */
  target: string;
  label: string;
}

/**
 * Topic tabs for ONE response, generated from its own sections. Clicking scrolls smoothly to the
 * section inside the same response; the active tab follows reading position.
 */
export function ResponseTabs({ id, tabs, active, onSelect }: { id: string; tabs: ResponseTab[]; active: string | null; onSelect: (target: string) => void }) {
  const barRef = useRef<HTMLDivElement>(null);

  // Keep the active tab visible in the horizontally scrolling bar (mobile). Only the bar scrolls,
  // never the chat.
  useEffect(() => {
    const bar = barRef.current;
    if (!active || !bar) return;
    const el = bar.querySelector<HTMLElement>(`[data-target="${CSS.escape(active)}"]`);
    if (!el) return;
    if (el.offsetLeft < bar.scrollLeft || el.offsetLeft + el.offsetWidth > bar.scrollLeft + bar.clientWidth) {
      bar.scrollTo({ left: el.offsetLeft - 16, behavior: "smooth" });
    }
  }, [active]);

  if (tabs.length < 2) return null;
  return (
    <nav id={id} aria-label="Answer topics" className="sticky top-0 z-10 -mx-4 border-b border-navy-700 bg-navy-950/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6">
      <div ref={barRef} className="relative flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const isActive = t.target === active;
          return (
            <button
              key={t.target}
              type="button"
              data-target={t.target}
              aria-current={isActive ? "true" : undefined}
              onClick={() => onSelect(t.target)}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold whitespace-nowrap transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-orange-400 ${
                isActive
                  ? "border-orange-400 bg-orange-500/15 text-orange-200"
                  : "border-navy-600 bg-navy-900 text-slate-300 hover:border-slate-400/60 hover:text-white"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
