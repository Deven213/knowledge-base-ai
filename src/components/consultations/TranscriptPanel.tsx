"use client";

import { useEffect, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Alert, Badge, Spinner } from "@/components/ui";
import type { SegmentLanguage, Speaker, TranscriptDTO } from "@/lib/consultations";
import { isMockTranscript, mmss } from "./status";

const SPEAKER_LABEL: Record<Speaker, string> = { doctor: "Doctor", patient: "Patient", other: "Other", unknown: "Unknown speaker" };
const SPEAKER_STYLE: Record<Speaker, string> = {
  doctor: "bg-blue-50 text-blue-700 ring-blue-600/15",
  patient: "bg-emerald-50 text-emerald-700 ring-emerald-600/15",
  other: "bg-violet-50 text-violet-700 ring-violet-600/15",
  unknown: "bg-slate-100 text-slate-600 ring-slate-500/15",
};
/** The language of a line, so the browser picks the right font for Gujarati and Devanagari. A line that mixes languages is left unlabelled. */
const LANG_ATTR: Partial<Record<SegmentLanguage, string>> = { en: "en", hi: "hi", gu: "gu" };

/** A line to bring into view, and when it was asked for (so asking for the same line twice brings it into view twice). */
export interface TranscriptHighlight {
  segment: number;
  nonce: number;
}

/**
 * The original transcript, exactly as the speech service returned it. It is never edited: corrections belong in the note.
 *
 * A line can take the doctor to the point in the recording where it starts, but only when the speech service measured a real start time for
 * it. A transcript without times shows none, and says so: nothing here estimates a time.
 */
export function TranscriptPanel({
  transcript,
  error,
  onRetry,
  highlight,
  onSeek,
  player,
}: {
  /** Null while it is being loaded (or if it could not be). */
  transcript: TranscriptDTO | null;
  error?: string | null;
  onRetry?: () => void;
  highlight: TranscriptHighlight | null;
  /** Moves the recording to a point (in milliseconds). Only offered for lines that have a real start time. */
  onSeek?: (ms: number) => void;
  /** The recording's player, shown above the lines and not scrolled away with them. */
  player?: ReactNode;
}) {
  useEffect(() => {
    if (highlight) document.getElementById(`segment-${highlight.segment}`)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [highlight]);
  const mock = !!transcript && isMockTranscript(transcript);

  return (
    <section aria-label="Transcript" className="card flex min-h-0 flex-col lg:overflow-hidden">
      <div className="shrink-0 space-y-3 border-b border-slate-100 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-slate-900">Transcript and recording</h2>
          {mock && <Badge tone="amber">Test data</Badge>}
        </div>
        {player}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {!transcript && !error && (
          <p className="flex items-center gap-2 text-sm text-slate-500" role="status">
            <Spinner /> Loading the transcript…
          </p>
        )}
        {!transcript && error && (
          <div className="space-y-2">
            <Alert>{error}</Alert>
            {onRetry && (
              <button type="button" className="btn btn-outline" onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
        )}
        {transcript && <TranscriptLines transcript={transcript} highlight={highlight} onSeek={onSeek} />}
      </div>
    </section>
  );
}

function TranscriptLines({ transcript, highlight, onSeek }: { transcript: TranscriptDTO; highlight: TranscriptHighlight | null; onSeek?: (ms: number) => void }) {
  const { segments, remarks, audioQuality, speakerLabels } = transcript.content;
  const hasTimes = segments.some((s) => s.startMs !== undefined);
  return (
    <>
      {speakerLabels === "inferred" && <p className="text-xs text-amber-800">The speakers were worked out from the conversation, not detected from their voices. Check who said what where it matters.</p>}
      {!hasTimes && <p className="text-xs text-slate-500">These lines have no times, so they cannot jump to a point in the recording. Use the player to listen.</p>}
      <ol className="space-y-2">
        {segments.map((s, i) => {
          const n = i + 1;
          const picked = highlight?.segment === n;
          return (
            <li key={n} id={`segment-${n}`} className={`rounded-lg px-3 py-2 text-sm ${picked ? "bg-yellow-50 ring-2 ring-yellow-300" : s.uncertain ? "bg-amber-50" : "bg-slate-50"}`}>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-slate-400 tabular-nums">[{n}]</span>
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${SPEAKER_STYLE[s.speaker]}`}>{SPEAKER_LABEL[s.speaker]}</span>
                {s.startMs !== undefined && onSeek && (
                  <button
                    type="button"
                    onClick={() => onSeek(s.startMs!)}
                    className="rounded bg-white px-1.5 py-0.5 text-xs font-medium text-slate-600 tabular-nums ring-1 ring-slate-200 ring-inset hover:bg-slate-100"
                    aria-label={`Go to ${mmss(s.startMs)} in the recording`}
                  >
                    {mmss(s.startMs)}
                  </button>
                )}
                {s.uncertain && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                    <AlertTriangle className="h-3 w-3" /> Not clearly heard
                  </span>
                )}
              </div>
              <p lang={LANG_ATTR[s.language]} className="whitespace-pre-wrap text-slate-900">
                {s.text}
              </p>
            </li>
          );
        })}
      </ol>
      <details className="pt-1 text-xs text-slate-600">
        <summary className="cursor-pointer font-medium">About this transcript</summary>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-slate-500">Made by</dt>
          <dd>
            {transcript.provider} ({transcript.model})
          </dd>
          <dt className="text-slate-500">Audio quality</dt>
          <dd>{audioQuality}</dd>
          <dt className="text-slate-500">Speaker labels</dt>
          <dd>{speakerLabels === "inferred" ? "Worked out from the conversation" : "From the speech service"}</dd>
          {remarks.length > 0 && (
            <>
              <dt className="text-slate-500">Notes</dt>
              <dd>{remarks.join(" ")}</dd>
            </>
          )}
        </dl>
      </details>
    </>
  );
}
