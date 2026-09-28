"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { ResponseHeader } from "./ResponseHeader";

const shell = "rounded-2xl border border-navy-700 bg-navy-950 px-4 text-slate-100 shadow-lg sm:px-6";

/** While an answer is generated: ONE placeholder response shaped like the real one. */
export function ResponseSkeleton() {
  return (
    <article aria-busy="true" aria-label="AI is preparing your answer" className={`${shell} pb-5`}>
      <ResponseHeader title={undefined} lang="en" eyebrow="AI is preparing your answer…" />
      <div className="animate-pulse space-y-4" aria-hidden>
        <div className="h-5 w-2/3 rounded bg-navy-700" />
        <div className="flex gap-1.5">
          {[16, 24, 20, 18].map((w, i) => (
            <div key={i} className="h-6 rounded-full bg-navy-800" style={{ width: `${w * 4}px` }} />
          ))}
        </div>
        {[0, 1].map((i) => (
          <div key={i} className="rounded-2xl border border-navy-700 bg-navy-850 p-4">
            <div className="flex items-center gap-3">
              <div className="h-7 w-7 rounded-full bg-orange-500/40" />
              <div className="h-4 w-1/3 rounded bg-navy-700" />
            </div>
            <div className="mt-3 space-y-2 sm:pl-10">
              <div className="h-3 w-full rounded bg-navy-700" />
              <div className="h-3 w-5/6 rounded bg-navy-700" />
              <div className="h-3 w-2/3 rounded bg-navy-700" />
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

/** A failed answer: ONE response container with the reason and a retry. */
export function ResponseError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <article role="alert" aria-label="AI response failed" className={`${shell} pb-5`}>
      <ResponseHeader title="Unable to generate this response." lang="en" eyebrow="AI answer" />
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-red-500/40 bg-red-600/10 px-4 py-3">
        <AlertTriangle className="h-4.5 w-4.5 shrink-0 text-red-300" aria-hidden />
        <p className="min-w-0 flex-1 text-sm leading-relaxed text-red-100">{message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 rounded-full bg-orange-500 px-3.5 py-1.5 text-xs font-semibold text-navy-950 hover:bg-orange-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-300"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Try again
          </button>
        )}
      </div>
    </article>
  );
}
