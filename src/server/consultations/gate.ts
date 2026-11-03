import "server-only";
import type { AppConfig } from "../config";

// The privacy gate. A recording is never sent to an AI service (and neither is its transcript) until the operator has set up
// BOTH a provider and a record of who reviewed that provider's data handling, and where the data is processed. Until then
// recordings are accepted and kept (sealed, on this server) and processing simply waits: nothing is lost, nothing is sent.
//
// The reasons below are for the operator (logs, README). The doctor only ever sees `DOCTOR_WAITING_MESSAGE`.

export interface Gate {
  open: boolean;
  /** For the operator. Null when open. */
  reason: string | null;
}

export const DOCTOR_WAITING_MESSAGE =
  "Your recording is stored safely. AI processing hasn't been approved for this workspace yet, so nothing has been sent anywhere. It will start once your administrator completes the setup.";

const MIN_REVIEW_LENGTH = 12;

export function processingGate(config: AppConfig, geminiApiKey: string | undefined): Gate {
  if (!config.CONSULTATIONS_ENCRYPTION_KEY) return { open: false, reason: "CONSULTATIONS_ENCRYPTION_KEY is not set." };
  if (!config.CONSULTATIONS_TRANSCRIPTION_PROVIDER) return { open: false, reason: "CONSULTATIONS_TRANSCRIPTION_PROVIDER is not set: no AI service has been chosen." };
  if (!config.CONSULTATIONS_TRANSCRIPTION_MODEL) return { open: false, reason: "CONSULTATIONS_TRANSCRIPTION_MODEL is not set." };
  if (!config.CONSULTATIONS_NOTE_MODEL && !config.GEMINI_MODEL) return { open: false, reason: "No model is set for drafting notes (CONSULTATIONS_NOTE_MODEL or GEMINI_MODEL)." };
  if (!geminiApiKey) return { open: false, reason: "GEMINI_API_KEY is not set." };
  if ((config.CONSULTATIONS_PROVIDER_REVIEW ?? "").length < MIN_REVIEW_LENGTH) {
    return { open: false, reason: "CONSULTATIONS_PROVIDER_REVIEW is not set: record who reviewed the AI provider's data handling and when." };
  }
  if (!config.CONSULTATIONS_PROVIDER_REGION) return { open: false, reason: "CONSULTATIONS_PROVIDER_REGION is not set: record where the provider processes the data." };
  return { open: true, reason: null };
}

/** Whether consultations can be used at all (recording and storing): needs the key that seals the data. */
export function consultationsConfigured(config: AppConfig): boolean {
  return !!config.CONSULTATIONS_ENCRYPTION_KEY;
}
