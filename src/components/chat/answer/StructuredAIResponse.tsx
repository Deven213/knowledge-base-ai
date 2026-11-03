"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Copy, RotateCcw } from "lucide-react";
import { buildSources } from "@/lib/ai-response";
import { buildClinicalNote } from "@/lib/clinical-note";
import { getLanguage } from "@/lib/languages";
import { PROVIDER_LABELS, type MessageDTO } from "@/lib/types";
import { api } from "@/lib/api";
import { speechTextForAnswer } from "@/lib/speech-text";
import { Markdown } from "../Markdown";
import { TTSButton } from "../TTSButton";
import { BlockHeading, CautionBox, ClinicalSummary, KeyPoints, NoSourceNotice, NotEstablished } from "./NoteBlocks";
import { Spinner } from "../../ui";
import { LanguageSelector } from "./LanguageSelector";
import { clinicalNoteToText } from "./note-text";
import { ResponseHeader } from "./ResponseHeader";
import { noteTextRenderer, ResponseSection } from "./ResponseSection";
import { pageLabel, ReferenceList } from "./ResponseSources";

// ONE assistant message = ONE compact clinical note: header (title, language), a short italic Clinical summary, Key
// points, an always-visible Important / Caution box when the sources state one, the Reference (clickable sources) and a
// "More details" control that holds everything else, including the retrieved passages. The model only supplied the
// text; document names, pages and excerpts come from the existing citations. What goes where is decided by
// lib/clinical-note.ts, which only arranges the answer and never rewrites or drops any of it.

function time(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * One assistant response. Its language can be changed on its own: the SAME message is updated in
 * place (same question, same sources); other responses are unaffected.
 */
export function StructuredAIResponse({
  message,
  onMessageUpdate,
  onLanguageChosen,
  ttsEnabled = false,
}: {
  message: MessageDTO;
  /** Receives the updated message (same id) after a language change. */
  onMessageUpdate: (updated: MessageDTO) => void;
  /** Remembers the last chosen language as the default for new answers. */
  onLanguageChosen?: (code: string) => void;
  /** Show "Listen" (speech is generated only when clicked). */
  ttsEnabled?: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  /** The language being prepared (null = none). The answer shown stays as it is until that one is ready. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ language: string; text: string } | null>(null);

  const response = message.structured;
  const { citations } = message;
  const sources = response ? response.sources : buildSources(citations);
  const language = getLanguage(message.language);
  const ui = language.ui;
  const italic = language.italic;
  const base = `resp-${message.id}`;
  const notFound = response ? !response.found : message.noContext;
  const note = useMemo(() => (response ? buildClinicalNote(response) : null), [response]);

  // Opening a source (a reference chip or an inline marker) opens "More details" at that passage.
  function cite(n: number) {
    setShowDetails(true);
    setHighlighted(n);
    requestAnimationFrame(() => document.getElementById(`src-${message.id}-${n}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  // Another language can be chosen while one is still being prepared. Every choice gets a number; only the newest may
  // change what is shown, and the older request is abandoned (the server stops translating it).
  const choice = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const pendingLanguage = useRef<string | null>(null); // the language being prepared, so repeated clicks on it don't start it over
  useEffect(
    () => () => {
      choice.current++;
      pending.current?.abort(); // leaving the page abandons the request
    },
    [],
  );

  async function changeLanguage(code: string) {
    if (code === pendingLanguage.current) return; // already on its way: clicking again must not send it twice or restart it
    const mine = ++choice.current;
    pending.current?.abort();
    setError(null);
    if (code === message.language) {
      pendingLanguage.current = null;
      setBusy(null); // back to the language already shown: nothing to fetch, and an older choice no longer applies
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    pendingLanguage.current = code;
    setBusy(code);
    try {
      const updated = await api.setMessageLanguage(message.id, code, controller.signal);
      if (mine !== choice.current) return; // a newer choice was made while this one was working
      onMessageUpdate(updated);
      onLanguageChosen?.(code);
    } catch (err) {
      if (mine !== choice.current || controller.signal.aborted) return;
      setError({ language: code, text: (err as Error).message });
    } finally {
      if (mine === choice.current) {
        pendingLanguage.current = null;
        setBusy(null);
      }
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(response && note ? clinicalNoteToText(response, note, sources, citations, ui) : message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  const render = noteTextRenderer(citations, cite, italic);
  const hasDetails = (note?.details.length ?? 0) > 0;
  const hasPassages = citations.length > 0;
  const detailsLabel = hasDetails ? ui.note.moreDetails : `${ui.note.sourcePassages} (${citations.length})`;

  return (
    <article aria-label="AI response" aria-busy={!!busy} className="max-w-3xl rounded-xl border border-slate-200 bg-white text-slate-900 shadow-sm">
      <ResponseHeader
        title={response?.title}
        lang={language.htmlLang}
        actions={<LanguageSelector value={message.language} onChange={(code) => void changeLanguage(code)} busy={busy} />}
      />
      {busy && (
        <>
          {/* Small, quiet progress: the answer below stays readable until the new language replaces it. */}
          <div className="mx-4 mb-1.5 h-0.5 overflow-hidden rounded bg-slate-100 sm:mx-5" aria-hidden>
            <div className="h-full w-1/3 rounded bg-brand-600 motion-safe:animate-[language-progress_1.1s_ease-in-out_infinite]" />
          </div>
          <p className="mb-2 flex items-center gap-1.5 px-4 text-xs text-slate-600 sm:px-5" role="status">
            <Spinner className="h-3 w-3" /> Translating to {getLanguage(busy).nativeName}…
          </p>
        </>
      )}

      {/* Content, in the response language (fixed labels follow it too). It fades in when a new language replaces the old one. */}
      <div
        key={message.language}
        lang={language.htmlLang}
        className={`space-y-3.5 px-4 pb-3 transition-opacity duration-200 motion-safe:animate-[fade-in_250ms_ease-out] sm:px-5 ${busy ? "opacity-70" : ""}`}
      >
        {notFound ? (
          <NotEstablished ui={ui} text={response ? response.summary : message.content} italic={italic} render={render} />
        ) : note ? (
          <>
            {note.summary && <ClinicalSummary id={`${base}-summary`} label={ui.note.clinicalSummary} text={note.summary} italic={italic} render={render} />}
            <KeyPoints id={`${base}-points`} note={note} label={ui.note.keyPoints} italic={italic} render={render} />
            <CautionBox id={`${base}-caution`} cautions={note.cautions} ui={ui} render={render} />
          </>
        ) : (
          // Plain-text answers (older messages or unstructured output) in the same card.
          <div className="text-slate-800">
            <Markdown text={message.content} maxCitation={citations.length} onCite={cite} />
          </div>
        )}

        {/* Language change failed: shown here, the current answer stays */}
        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3.5 py-2.5 text-sm text-red-950">
            <span className="min-w-0 flex-1">
              Unable to generate the {getLanguage(error.language).label} response. {error.text}
            </span>
            <button
              type="button"
              onClick={() => void changeLanguage(error.language)}
              className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Try again
            </button>
          </div>
        )}

        {/* Reference: always visible, so the evidence is one click away. An answer with no source says so. */}
        {sources.length > 0 ? (
          <section aria-labelledby={`${base}-reference`}>
            <BlockHeading id={`${base}-reference`}>{ui.note.reference}</BlockHeading>
            <ReferenceList sources={sources} citations={citations} onCite={cite} />
          </section>
        ) : (
          !notFound && <NoSourceNotice ui={ui} />
        )}

        {(hasDetails || hasPassages) && (
          <div>
            <button
              type="button"
              onClick={() => setShowDetails((s) => !s)}
              aria-expanded={showDetails}
              aria-controls={`${base}-details`}
              className="-ml-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-brand-700 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600"
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${showDetails ? "rotate-180" : ""}`} aria-hidden />
              {showDetails ? ui.note.hideDetails : detailsLabel}
            </button>
            <div id={`${base}-details`} hidden={!showDetails} className="mt-2 space-y-4 border-t border-slate-200 pt-3">
              {note?.details.map((section, i) => (
                <ResponseSection key={i} id={`${base}-d${i}`} section={section} citations={citations} ui={ui} italic={italic} onCite={cite} />
              ))}
              {hasPassages && (
                <section aria-labelledby={`${base}-passages`}>
                  <BlockHeading id={`${base}-passages`}>
                    {ui.note.sourcePassages} ({citations.length})
                  </BlockHeading>
                  <ul className="space-y-2">
                    {citations.map((c) => (
                      <li
                        key={c.index}
                        id={`src-${message.id}-${c.index}`}
                        className={`rounded-lg border p-2.5 text-[13px] transition-colors ${highlighted === c.index ? "border-brand-600 bg-brand-50" : "border-slate-200 bg-slate-50"} ${
                          c.cited ? "" : "opacity-80"
                        }`}
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded bg-slate-700 px-1 text-[11px] font-semibold text-white">{c.index}</span>
                          <span className="min-w-0 truncate font-medium text-slate-900">{c.filename}</span>
                          {pageLabel(c.pageStart, c.pageEnd) && <span className="shrink-0 text-slate-600">{pageLabel(c.pageStart, c.pageEnd)}</span>}
                          {c.source === "attachment" && <span className="shrink-0 rounded bg-violet-100 px-1 py-px text-[11px] font-medium text-violet-900">Attachment</span>}
                          <span className="ml-auto shrink-0 text-slate-600" title={c.score === null ? undefined : "Similarity score"}>
                            {c.cited ? "cited" : ""}
                            {c.cited && c.score !== null ? " · " : ""}
                            {c.score !== null && c.score.toFixed(2)}
                          </span>
                        </div>
                        <p className="leading-relaxed text-slate-700">{c.excerpt}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer: actions and provenance, then the one-line reminder */}
      <footer className="rounded-b-xl border-t border-slate-100 bg-slate-50/70 px-3 py-2 text-slate-600 sm:px-4">
        <div className="flex items-center gap-1">
          {ttsEnabled && !busy && <TTSButton messageId={message.id} text={speechTextForAnswer(response, message.content)} language={message.language} />}
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium hover:bg-slate-200 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-brand-600"
            aria-label="Copy answer"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-700" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
          </button>
          <span className="ml-auto truncate pl-2 text-[11px]">
            {message.provider ? `${PROVIDER_LABELS[message.provider]} · ${message.model} · ` : ""}
            {time(message.createdAt)}
          </span>
        </div>
        <p lang={language.htmlLang} className="mt-1 text-[11px] leading-snug">
          {ui.note.disclaimer}
        </p>
      </footer>
    </article>
  );
}
