import { vi } from "vitest";
import {
  NOTE_SECTION_KEYS,
  type ConsultationDetailDTO,
  type ConsultationLimitsDTO,
  type ConsultationSummaryDTO,
  type NoteContent,
  type NoteDTO,
  type TranscriptDTO,
} from "@/lib/consultations";
import { MIXED_TRANSCRIPT } from "./consultation-helpers";

/** The calls the consultation screens make; each test sets what the server would answer. */
export const consultationApi = {
  consultations: vi.fn(),
  createConsultation: vi.fn(),
  consultation: vi.fn(),
  deleteConsultation: vi.fn(),
  startRecordingUpload: vi.fn(),
  uploadRecordingPart: vi.fn(),
  completeRecording: vi.fn(),
  deleteRecordingAudio: vi.fn(),
  consultationTranscript: vi.fn(),
  consultationNote: vi.fn(),
  saveConsultationNote: vi.fn(),
  approveConsultationNote: vi.fn(),
  reopenConsultationNote: vi.fn(),
  retryConsultation: vi.fn(),
  consultationAudioUrl: (id: string) => `/api/consultations/${id}/audio`,
};

export const LIMITS: ConsultationLimitsDTO = { maxMinutes: 45, maxAudioBytes: 120 * 1024 * 1024, partBytes: 1000, bitsPerSecond: 48_000, mimeTypes: ["audio/webm"] };

export const summary = (over: Partial<ConsultationSummaryDTO> = {}): ConsultationSummaryDTO => ({
  id: "11111111-1111-4111-8111-111111111111",
  patientLabel: "Asha Patel, record 4471",
  languageHint: "mixed",
  status: "ready",
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
  recording: null,
  approvedAt: null,
  ...over,
});

export const detail = (over: Partial<ConsultationDetailDTO> = {}): ConsultationDetailDTO => ({
  ...summary(),
  consent: { recordedAt: "2026-10-20T09:00:00.000Z", givenBy: "patient", method: "verbal", language: "gu", textVersion: "2026-10-draft-1" },
  failureMessage: null,
  stage: "waiting",
  waitingReason: null,
  receivedParts: [],
  noteVersion: null,
  hasTranscript: false,
  ...over,
});

export const noteContent = (over: Partial<NoteContent> = {}): NoteContent => ({
  sections: NOTE_SECTION_KEYS.map((key) => ({ key, items: [] })).map((s) => {
    if (s.key === "chief_complaint") return { ...s, items: [{ id: "i1", text: "Fever and headache for three days.", origin: "patient_reported" as const, evidence: [2], byDoctor: false }] };
    if (s.key === "medication_decisions") return { ...s, items: [{ id: "i2", text: "Paracetamol 650 mg twice a day for three days.", origin: "clinician_decision" as const, evidence: [5], byDoctor: false }] };
    return s;
  }),
  flags: [{ id: "f1", kind: "uncertain_transcription", text: "The speech service was not sure of the words in transcript segment [6].", evidence: [6], resolved: false }],
  ...over,
});

export const noteDto = (over: Partial<NoteDTO> = {}): NoteDTO => ({
  consultationId: "11111111-1111-4111-8111-111111111111",
  version: 1,
  source: "ai",
  createdAt: "2026-10-20T09:30:00.000Z",
  approvedAt: null,
  content: noteContent(),
  versions: [{ version: 1, source: "ai", createdAt: "2026-10-20T09:30:00.000Z", approvedAt: null }],
  needsApproval: true,
  ...over,
});

export const transcriptDto = (over: Partial<TranscriptDTO> = {}): TranscriptDTO => ({
  consultationId: "11111111-1111-4111-8111-111111111111",
  version: 1,
  provider: "gemini",
  model: "test-model",
  createdAt: "2026-10-20T09:20:00.000Z",
  content: MIXED_TRANSCRIPT,
  ...over,
});
