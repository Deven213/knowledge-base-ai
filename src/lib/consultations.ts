// Doctor consultations: types and constants shared by the server and the browser. Nothing here touches the server.

export const CONSULTATION_STATUSES = ["ready", "uploading", "processing", "needs_review", "approved", "failed"] as const;
export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];

export const LANGUAGE_HINTS = ["auto", "en", "hi", "gu", "mixed"] as const;
export type LanguageHint = (typeof LANGUAGE_HINTS)[number];
export const LANGUAGE_HINT_LABEL: Record<LanguageHint, string> = {
  auto: "Detect automatically",
  en: "English",
  hi: "Hindi (हिन्दी)",
  gu: "Gujarati (ગુજરાતી)",
  mixed: "Mixed (Gujarati / Hindi / English)",
};

/** Audio formats the browser's recorder produces; the server also checks the bytes themselves. */
export const AUDIO_MIME_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "audio/mpeg"] as const;

/** The recording is uploaded in parts of exactly this size (the last may be smaller). */
export const UPLOAD_PART_BYTES = 2 * 1024 * 1024;
/** The recorder's bitrate: plenty for speech, and a 90-minute visit stays near 30 MB. */
export const RECORDER_BITS_PER_SECOND = 48_000;

// ── Transcript ───────────────────────────────────────────────────────────────

export type Speaker = "doctor" | "patient" | "other" | "unknown";
export type SegmentLanguage = "en" | "hi" | "gu" | "mixed" | "unknown";

export interface TranscriptSegment {
  speaker: Speaker;
  /** Exactly as spoken, in the script of each language used (Gujarati script, Devanagari, Latin). */
  text: string;
  language: SegmentLanguage;
  /** The speech service was not sure of these words: the doctor should listen again. */
  uncertain: boolean;
  /**
   * Where in the recording this line starts, in milliseconds, when the speech service measured it. Never estimated or filled in by this
   * system: a transcript without it has no times, and nothing in the screens pretends otherwise.
   */
  startMs?: number;
}

export interface TranscriptContent {
  segments: TranscriptSegment[];
  /** Short remarks from the speech service about the recording itself (never clinical content). */
  remarks: string[];
  audioQuality: "good" | "fair" | "poor" | "unknown";
  /** Whether the service separated speakers on its own or the roles were inferred from the conversation. */
  speakerLabels: "provider" | "inferred";
}

// ── Clinical note ────────────────────────────────────────────────────────────

export const NOTE_SECTIONS = [
  { key: "chief_complaint", title: "Chief complaint and symptoms" },
  { key: "history", title: "Duration and relevant history" },
  { key: "medications_allergies", title: "Current medications and allergies" },
  { key: "findings", title: "Clinical findings and measurements" },
  { key: "assessment", title: "Doctor's assessment and differential diagnoses" },
  { key: "investigations", title: "Tests and investigations ordered" },
  { key: "medication_decisions", title: "Medication decisions, dosage and instructions" },
  { key: "counselling_followup", title: "Counselling, precautions and follow-up" },
  { key: "open_questions", title: "Unresolved questions to confirm" },
] as const;
export type NoteSectionKey = (typeof NOTE_SECTIONS)[number]["key"];
export const NOTE_SECTION_KEYS = NOTE_SECTIONS.map((s) => s.key) as readonly NoteSectionKey[];

/**
 * What the doctor reads: four headings over the nine stored sections. Storage, the server's rules (all nine sections, always, in order),
 * grounding and the audit trail all stay on the nine; this only decides how they are grouped on screen. Every section is in exactly one group.
 */
export const NOTE_GROUPS = [
  { key: "complaint", title: "Chief complaint and symptoms", sections: ["chief_complaint"], addTo: "chief_complaint" },
  { key: "history", title: "Relevant history", sections: ["history", "medications_allergies"], addTo: "history" },
  { key: "assessment", title: "Assessment", sections: ["findings", "assessment"], addTo: "assessment" },
  { key: "plan", title: "Plan and follow-up", sections: ["investigations", "medication_decisions", "counselling_followup", "open_questions"], addTo: "counselling_followup" },
] as const satisfies readonly { key: string; title: string; sections: readonly NoteSectionKey[]; addTo: NoteSectionKey }[];
export type NoteGroup = (typeof NOTE_GROUPS)[number];

/** A short name for the stored section a line belongs to, shown only inside a group that holds several. */
export const NOTE_SECTION_SHORT: Record<NoteSectionKey, string> = {
  chief_complaint: "Complaint",
  history: "History",
  medications_allergies: "Medications and allergies",
  findings: "Findings",
  assessment: "Assessment",
  investigations: "Tests",
  medication_decisions: "Medication",
  counselling_followup: "Advice and follow-up",
  open_questions: "To confirm",
};

/** Who a statement comes from, so patient-reported information is never presented as the doctor's finding or decision. */
export const NOTE_ORIGINS = ["patient_reported", "clinician_observation", "clinician_assessment", "clinician_decision", "advice_given"] as const;
export type NoteOrigin = (typeof NOTE_ORIGINS)[number];
export const NOTE_ORIGIN_LABEL: Record<NoteOrigin, string> = {
  patient_reported: "Patient reported",
  clinician_observation: "Doctor observed",
  clinician_assessment: "Doctor's assessment",
  clinician_decision: "Doctor decided",
  advice_given: "Advice given",
};

export interface NoteItem {
  id: string;
  text: string;
  origin: NoteOrigin;
  /** 1-based numbers of the transcript segments this statement comes from. Empty only for a line the doctor wrote or changed. */
  evidence: number[];
  /** Written or changed by the doctor (as opposed to drafted by the AI and left as it was). */
  byDoctor: boolean;
}

export const FLAG_KINDS = ["uncertain_transcription", "ambiguity", "needs_confirmation", "unsupported_removed"] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];
export const FLAG_KIND_LABEL: Record<FlagKind, string> = {
  uncertain_transcription: "Uncertain transcription",
  ambiguity: "Needs clarification",
  needs_confirmation: "Please confirm",
  unsupported_removed: "Removed by a safety check",
};

export interface NoteFlag {
  id: string;
  kind: FlagKind;
  text: string;
  evidence: number[];
  /** The doctor has dealt with it (cleared by the doctor; never cleared automatically). */
  resolved: boolean;
}

export interface NoteSection {
  key: NoteSectionKey;
  items: NoteItem[];
}

export interface NoteContent {
  sections: NoteSection[];
  flags: NoteFlag[];
}

export const NOT_DISCUSSED = "Not discussed";

/** What the browser sends to save an edit: only what the doctor can change (the server decides everything else). */
export interface NoteSubmission {
  sections: { key: NoteSectionKey; items: { id: string; text: string; origin: NoteOrigin; evidence: number[] }[] }[];
  flags: { id: string; resolved: boolean }[];
}

/** The note as the browser edits it, turned into what is sent. */
export function toSubmission(note: NoteContent): NoteSubmission {
  return {
    sections: note.sections.map((s) => ({ key: s.key, items: s.items.map((i) => ({ id: i.id, text: i.text, origin: i.origin, evidence: [...i.evidence] })) })),
    flags: note.flags.map((f) => ({ id: f.id, resolved: f.resolved })),
  };
}

export function emptyNote(): NoteContent {
  return { sections: NOTE_SECTION_KEYS.map((key) => ({ key, items: [] })), flags: [] };
}

// ── What the browser gets ────────────────────────────────────────────────────

export type JobStage = "waiting" | "transcribing" | "drafting" | "done" | "failed";

export interface ConsultationSummaryDTO {
  id: string;
  patientLabel: string;
  languageHint: LanguageHint;
  status: ConsultationStatus;
  createdAt: string;
  updatedAt: string;
  /** Present once the audio is stored; never the audio itself. */
  recording: { status: "uploading" | "stored" | "deleted"; durationMs: number | null; sizeBytes: number | null } | null;
  approvedAt: string | null;
}

export interface ConsultationDetailDTO extends ConsultationSummaryDTO {
  consent: { recordedAt: string; givenBy: "patient" | "guardian" | "representative"; method: "verbal" | "written"; language: "en" | "hi" | "gu"; textVersion: string };
  failureMessage: string | null;
  /** What the background worker is doing right now. */
  stage: JobStage;
  /** Why processing is waiting, in words for the doctor (not configuration details). Null when nothing is blocking it. */
  waitingReason: string | null;
  /** Parts already received by an unfinished upload, so an interrupted upload can resume. */
  receivedParts: number[];
  noteVersion: number | null;
  hasTranscript: boolean;
}

export interface ConsultationLimitsDTO {
  maxMinutes: number;
  maxAudioBytes: number;
  partBytes: number;
  bitsPerSecond: number;
  mimeTypes: readonly string[];
}

export interface ConsultationsOverviewDTO {
  consultations: ConsultationSummaryDTO[];
  limits: ConsultationLimitsDTO;
  consentVersion: string;
}

export interface TranscriptDTO {
  consultationId: string;
  version: number;
  provider: string;
  model: string;
  createdAt: string;
  content: TranscriptContent;
}

export interface NoteVersionDTO {
  version: number;
  source: "ai" | "doctor";
  createdAt: string;
  approvedAt: string | null;
}

export interface NoteDTO {
  consultationId: string;
  version: number;
  source: "ai" | "doctor";
  createdAt: string;
  approvedAt: string | null;
  content: NoteContent;
  versions: NoteVersionDTO[];
  /** True while the latest version is a draft the doctor has not approved. */
  needsApproval: boolean;
}
