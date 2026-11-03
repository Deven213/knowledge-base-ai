import "server-only";
import type { LanguageHint, TranscriptContent } from "@/lib/consultations";

/**
 * Speech to text for a consultation. This is deliberately NOT part of the chat provider layer (LLMProvider): that layer carries text and
 * images and nothing else, and adding audio to it would touch every provider. Notes are drafted through the existing provider layer;
 * only the audio step has its own, small interface. A second provider (OpenAI, Google Cloud Speech-to-Text, a self-hosted Whisper) is one
 * new class implementing this.
 */
export interface TranscriptionRequest {
  audio: Buffer;
  mimeType: string;
  languageHint: LanguageHint;
  model: string;
  apiKey: string;
  signal?: AbortSignal;
}

export interface TranscriptionProvider {
  readonly id: "gemini";
  /** Throws ProcessingError for every failure (retryable or not). Never logs the audio or the text. */
  transcribe(request: TranscriptionRequest): Promise<TranscriptContent>;
}
