import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NoteContent, TranscriptContent } from "@/lib/consultations";
import { UPLOAD_PART_BYTES } from "@/lib/consultations";
import { CONSENT_VERSION } from "@/lib/consultation-consent";
import { resetConfigForTests } from "@/server/config";

// Shared fixtures for the consultation tests: the environment a configured deployment has, audio that really looks like a recording,
// and the cast of a two-customer system.

export const CONSULT_KEY = randomBytes(32).toString("base64");

/** The environment of a deployment that has set everything up (privacy review included), plus a private folder for the audio. */
export function consultationEnv(overrides: Record<string, string | undefined> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-consult-"));
  const values: Record<string, string | undefined> = {
    CONSULTATIONS_ENCRYPTION_KEY: CONSULT_KEY,
    CONSULTATIONS_AUDIO_DIR: path.join(dir, "audio"),
    CONSULTATIONS_TRANSCRIPTION_PROVIDER: "gemini",
    CONSULTATIONS_TRANSCRIPTION_MODEL: "test-transcription-model",
    CONSULTATIONS_NOTE_MODEL: "test-note-model",
    CONSULTATIONS_PROVIDER_REVIEW: "Reviewed by Dr. Test on 2026-10-20 (ticket 1)",
    CONSULTATIONS_PROVIDER_REGION: "test-region",
    GEMINI_API_KEY: "test-key-not-real-1234",
    GEMINI_MODEL: "test-chat-model",
    DEFAULT_AI_PROVIDER: "gemini",
    ...overrides,
  };
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(values)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigForTests();
  return {
    dir,
    audioDir: values.CONSULTATIONS_AUDIO_DIR!,
    restore() {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetConfigForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Bytes that really begin like a WebM recording (the EBML header the recorder writes), then deterministic noise. */
export function audioBytes(size: number, seed = 1): Buffer {
  const out = Buffer.alloc(size);
  const header = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
  header.copy(out, 0, 0, Math.min(header.length, size));
  let x = seed >>> 0 || 1;
  for (let i = header.length; i < size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

export const sha256 = (data: Buffer | Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** The parts a browser would send for a recording. */
export function partsOf(bytes: Buffer, partBytes = UPLOAD_PART_BYTES): Buffer[] {
  const parts: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += partBytes) parts.push(bytes.subarray(at, Math.min(at + partBytes, bytes.length)));
  return parts;
}

/** What the create-consultation endpoint expects, with consent given. */
export const validCreate = (overrides: Record<string, unknown> = {}) => ({
  patientLabel: "Asha Patel, record 4471",
  languageHint: "mixed",
  consent: { version: CONSENT_VERSION, language: "gu", givenBy: "patient", method: "verbal", confirmed: true },
  ...overrides,
});

// ── What the speech service and the note drafter would return ────────────────

/** A consultation in Gujarati, Hindi and English, as a speech service would return it (and the way it is meant to: each word in its own script). */
export const MIXED_TRANSCRIPT: TranscriptContent = {
  segments: [
    { speaker: "doctor", text: "નમસ્તે, કહો, શું તકલીફ છે?", language: "gu", uncertain: false },
    { speaker: "patient", text: "ડૉક્ટર સાહેબ, ત્રણ દિવસથી બહુ fever છે અને માથું દુખે છે.", language: "mixed", uncertain: false },
    { speaker: "patient", text: "मुझे sugar की दवा भी चल रही है, metformin 500 mg.", language: "mixed", uncertain: false },
    { speaker: "doctor", text: "ઠીક છે. Temperature 101 છે, BP 120/80 છે.", language: "mixed", uncertain: false },
    { speaker: "doctor", text: "Paracetamol 650 mg twice a day for three days લો, અને ખૂબ પાણી પીઓ.", language: "mixed", uncertain: false },
    { speaker: "doctor", text: "પાંચ દિવસ પછી ફરી બતાવજો. [inaudible] ના લેતા.", language: "gu", uncertain: true },
  ],
  remarks: ["Some background noise."],
  audioQuality: "fair",
  speakerLabels: "inferred",
};

/** What a well-behaved model returns for MIXED_TRANSCRIPT. */
export function goodDraft(): Record<string, unknown> {
  return {
    sections: [
      { key: "chief_complaint", items: [{ text: "Fever and headache for three days.", origin: "patient_reported", evidence: [2], quote: "" }] },
      { key: "history", items: [{ text: "Fever for 3 days.", origin: "patient_reported", evidence: [2], quote: "" }] },
      { key: "medications_allergies", items: [{ text: "Takes metformin 500 mg for diabetes.", origin: "patient_reported", evidence: [3], quote: "" }] },
      { key: "findings", items: [{ text: "Temperature 101. BP 120/80.", origin: "clinician_observation", evidence: [4], quote: "" }] },
      { key: "assessment", items: [] },
      { key: "investigations", items: [] },
      { key: "medication_decisions", items: [{ text: "Paracetamol 650 mg twice a day for three days.", origin: "clinician_decision", evidence: [5], quote: "Paracetamol 650 mg twice a day for three days" }] },
      { key: "counselling_followup", items: [{ text: "Drink plenty of water. Review after five days.", origin: "advice_given", evidence: [5, 6], quote: "" }] },
      { key: "open_questions", items: [] },
    ],
    flags: [],
  };
}

export const emptyDraft = (): NoteContent => ({ sections: [], flags: [] });
