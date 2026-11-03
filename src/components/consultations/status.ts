import type { ConsultationStatus, JobStage } from "@/lib/consultations";

export const STATUS_LABEL: Record<ConsultationStatus, string> = {
  ready: "Ready to record",
  uploading: "Uploading",
  processing: "Processing",
  needs_review: "Ready for your review",
  approved: "Approved",
  failed: "Needs attention",
};

export const STATUS_TONE: Record<ConsultationStatus, "slate" | "amber" | "blue" | "green" | "red"> = {
  ready: "slate",
  uploading: "amber",
  processing: "amber",
  needs_review: "blue",
  approved: "green",
  failed: "red",
};

/** What the background worker is doing, in words for the doctor. */
export const STAGE_TEXT: Record<JobStage, string> = {
  waiting: "Waiting to start",
  transcribing: "Turning the recording into text",
  drafting: "Drafting the clinical note",
  done: "Done",
  failed: "Stopped",
};

/**
 * Whether a transcript came from the mock AI of the isolated test setup (scripts/fake-gemini.mjs) rather than a real speech service. The mock
 * names its models "mock-…" and says so in the transcript's own remarks, and its text is fixed: it has nothing to do with what was recorded.
 * Anything that shows a transcript must make that unmistakable, so a test result cannot be taken for a real transcription.
 */
export const isMockTranscript = (transcript: { model: string; content: { remarks: string[] } }): boolean =>
  /^mock[-_]/i.test(transcript.model) || transcript.content.remarks.some((r) => /^MOCK AI\b/.test(r));

export const mmss = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
