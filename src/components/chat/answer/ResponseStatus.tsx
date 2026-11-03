"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { ResponseHeader } from "./ResponseHeader";

const shell = "max-w-3xl rounded-xl border border-slate-200 bg-white shadow-sm";

/** While an answer is generated: ONE placeholder shaped like the real note (summary line, a few points, references). */
export function ResponseSkeleton() {
  return (
    <article aria-busy="true" aria-label="AI is preparing your answer" className={`${shell} pb-4`}>
      <ResponseHeader title="Preparing your answer…" lang="en" />
      <div className="animate-pulse space-y-4 px-4 sm:px-5" aria-hidden>
        <div className="space-y-2 border-l-4 border-slate-200 pl-3">
          <div className="h-2.5 w-24 rounded bg-slate-200" />
          <div className="h-4 w-5/6 rounded bg-slate-200" />
        </div>
        <div className="space-y-2">
          <div className="h-2.5 w-20 rounded bg-slate-200" />
          {[92, 78, 85].map((w, i) => (
            <div key={i} className="flex items-center gap-2.5">
              <div className="h-1.5 w-1.5 rounded-full bg-slate-300" />
              <div className="h-3.5 rounded bg-slate-200" style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
        <div className="flex gap-1.5">
          <div className="h-6 w-40 rounded-full bg-slate-200" />
          <div className="h-6 w-28 rounded-full bg-slate-200" />
        </div>
      </div>
    </article>
  );
}

/** A failed answer: ONE response container with the reason and a retry. */
export function ResponseError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <article role="alert" aria-label="AI response failed" className={`${shell} pb-4`}>
      <ResponseHeader title="Unable to generate this response." lang="en" />
      <div className="mx-4 flex flex-wrap items-center gap-3 rounded-lg border border-red-300 bg-red-50 px-3.5 py-3 sm:mx-5">
        <AlertTriangle className="h-4.5 w-4.5 shrink-0 text-red-700" aria-hidden />
        <p className="min-w-0 flex-1 text-sm leading-relaxed text-red-950">{message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Try again
          </button>
        )}
      </div>
    </article>
  );
}
