import "server-only";

// Text-to-speech is a separate concern from the chat LLM providers: its own interface, its own
// provider implementations and its own errors.

export interface SpeechRequest {
  text: string;
  /** Prebuilt voice name for the provider. */
  voice: string;
  /** BCP-47 language of the text, e.g. "en-IN", "hi-IN", "gu-IN". */
  language: string;
  model: string;
  apiKey: string;
  signal?: AbortSignal;
}

export interface SpeechAudio {
  audio: Buffer;
  /** Browser-playable MIME type (e.g. audio/wav). */
  mimeType: string;
}

export interface TextToSpeechProvider {
  id: string;
  generateSpeech(request: SpeechRequest): Promise<SpeechAudio>;
}

export type VoiceErrorKind = "disabled" | "not_configured" | "bad_input" | "auth" | "rate_limit" | "timeout" | "unavailable" | "empty" | "cancelled";

/** A voice failure with a message that is safe to show (never contains keys or raw provider output). */
export class VoiceError extends Error {
  constructor(
    readonly kind: VoiceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "VoiceError";
  }

  get status(): number {
    switch (this.kind) {
      case "bad_input":
        return 400;
      case "disabled":
        return 403;
      case "rate_limit":
        return 429;
      case "cancelled":
        return 499;
      case "not_configured":
      case "unavailable":
        return 503;
      case "timeout":
        return 504;
      default:
        return 502;
    }
  }
}
