import "server-only";
import { redactSecrets } from "../security/redact";
import { VoiceError } from "../tts/types";

/**
 * Maps Gemini SDK errors from the voice features onto short, safe messages. The redacted detail is
 * logged server-side; the text being spoken or transcribed is never logged.
 */
export function toVoiceError(err: unknown, feature: "speech" | "transcription", apiKey: string, signal?: AbortSignal): VoiceError {
  if (err instanceof VoiceError) return err;
  if (signal?.aborted) return new VoiceError("cancelled", "The request was cancelled.");

  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 0;
  const name = err instanceof Error ? err.name : "";
  const raw = err instanceof Error ? err.message : String(err);
  console.error(`[voice:${feature}] ${name || "Error"} status=${status || "n/a"}: ${redactSecrets(raw, [apiKey]).slice(0, 300)}`);

  const label = feature === "speech" ? "Speech playback" : "Voice transcription";
  if (/timeout|timed out/i.test(name + raw) || name === "AbortError") {
    return new VoiceError("timeout", `${label} took too long. Please try again.`);
  }
  if (status === 401 || status === 403 || /api key not valid|invalid.*api.?key|API_KEY_INVALID/i.test(raw)) {
    return new VoiceError("auth", `${label} is unavailable: the Gemini API key was rejected.`);
  }
  if (status === 429) {
    return new VoiceError("rate_limit", `${label} is busy right now (rate limit or quota reached). Please try again shortly.`);
  }
  if (status === 404) {
    return new VoiceError("not_configured", `${label} is unavailable: the configured Gemini voice model was not found.`);
  }
  return new VoiceError(
    "unavailable",
    feature === "speech" ? "Speech playback is temporarily unavailable." : "Voice transcription failed. Please try again.",
  );
}
