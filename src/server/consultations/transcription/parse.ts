import "server-only";
import type { SegmentLanguage, Speaker, TranscriptContent, TranscriptSegment } from "@/lib/consultations";
import { ProcessingError } from "../processing-error";

// A speech service's answer is never trusted as-is: it is parsed, bounded and cleaned into exactly the shape the rest of the system
// expects. Anything unexpected becomes a clear failure instead of being stored.

const SPEAKERS: readonly Speaker[] = ["doctor", "patient", "other", "unknown"];
const LANGUAGES: readonly SegmentLanguage[] = ["en", "hi", "gu", "mixed", "unknown"];
const QUALITIES = ["good", "fair", "poor"] as const;

export const MAX_SEGMENTS = 5000;
export const MAX_SEGMENT_CHARS = 4000;
/** A line cannot start later than the longest recording the system accepts (4 hours). */
const MAX_START_MS = 4 * 60 * 60 * 1000;
/** A segment the service itself says it couldn't make out is uncertain, whatever it claimed. */
const INAUDIBLE = /\[(?:inaudible|unclear|अस्पष्ट|અસ્પષ્ટ)[^\]]*\]/i;

const asString = (v: unknown) => (typeof v === "string" ? v : "");

/** Cleans the service's JSON into a TranscriptContent. Throws ProcessingError when there is nothing usable. */
export function normalizeTranscript(raw: unknown): TranscriptContent {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { segments?: unknown }).segments)) {
    throw new ProcessingError("bad_transcript", "The speech service returned something that could not be read. It will be retried automatically.", true);
  }
  const input = raw as { segments: unknown[]; remarks?: unknown; audioQuality?: unknown };
  const segments: TranscriptSegment[] = [];
  for (const entry of input.segments) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const text = asString(e.text).trim();
    if (!text) continue;
    const cut = text.length > MAX_SEGMENT_CHARS;
    segments.push({
      speaker: SPEAKERS.includes(e.speaker as Speaker) ? (e.speaker as Speaker) : "unknown",
      text: cut ? text.slice(0, MAX_SEGMENT_CHARS) : text,
      language: LANGUAGES.includes(e.language as SegmentLanguage) ? (e.language as SegmentLanguage) : "unknown",
      uncertain: e.uncertain === true || cut || INAUDIBLE.test(text),
      // A time is kept only when the service gave a real one. It is never worked out or guessed here: a line without one has none.
      ...(typeof e.startMs === "number" && Number.isFinite(e.startMs) && e.startMs >= 0 && e.startMs <= MAX_START_MS ? { startMs: Math.round(e.startMs) } : {}),
    });
  }
  if (segments.length === 0) throw new ProcessingError("no_speech", "No speech could be heard in this recording, so no note was prepared.", false);
  if (segments.length > MAX_SEGMENTS) throw new ProcessingError("transcript_too_long", "This recording is too long to transcribe in one go. Record shorter consultations.", false);

  const remarks = Array.isArray(input.remarks) ? input.remarks.filter((r): r is string => typeof r === "string" && r.trim() !== "").slice(0, 10).map((r) => r.trim().slice(0, 200)) : [];
  const quality = QUALITIES.find((q) => q === input.audioQuality);
  return { segments, remarks, audioQuality: quality ?? "unknown", speakerLabels: "inferred" };
}
