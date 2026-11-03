import "server-only";
import { LLMError } from "../llm/types";
import { redactSecrets } from "../security/redact";

/**
 * A background job failed. `message` is safe to show the doctor (it never contains transcript, patient or key text), `code` is stable
 * for the audit log, and `retryable` says whether trying again later could help (a busy or briefly unavailable AI service) or not
 * (a rejected key, a recording with no speech, a transcript the service can't fit).
 */
export class ProcessingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProcessingError";
  }
}

/** Turns whatever the AI SDK threw into a ProcessingError. Only the status and a redacted, truncated message are logged: never the content. */
export function classifyProviderError(err: unknown, stage: "transcription" | "note", apiKey: string, signal?: AbortSignal): ProcessingError {
  if (err instanceof ProcessingError) return err;
  if (signal?.aborted) return new ProcessingError("cancelled", "Processing was cancelled.", false);

  const label = stage === "transcription" ? "Transcription" : "Drafting the note";
  if (err instanceof LLMError) {
    // The note drafting goes through the shared provider layer, which already maps and redacts its errors.
    switch (err.kind) {
      case "rate_limit":
      case "timeout":
      case "unavailable":
      case "empty_response":
        return new ProcessingError(`provider_${err.kind}`, `${label} is busy right now and will be retried automatically.`, true);
      case "auth":
        return new ProcessingError("provider_auth", `${label} can't run: the AI service rejected the server's credentials. Ask your administrator.`, false);
      case "model_not_found":
        return new ProcessingError("provider_model", `${label} can't run: the configured AI model was not found. Ask your administrator.`, false);
      default:
        return new ProcessingError("provider_rejected", `${label} failed because the AI service refused the request.`, false);
    }
  }

  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 0;
  const name = err instanceof Error ? err.name : "";
  const raw = err instanceof Error ? err.message : String(err);
  // What gets logged: the kind of error and its status, and the provider's own words ONLY for quota, key and model problems (which
  // never carry any of the request). A message about a rejected request can quote the request, which here is a conversation.
  const quoting = [429, 401, 403, 404].includes(status) ? `: ${redactSecrets(raw, [apiKey]).slice(0, 200)}` : "";
  console.error(`[consultations:${stage}] ${name || "Error"} status=${status || "n/a"}${quoting}`);

  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network/i.test(name + raw) || name === "AbortError" || status === 408) {
    return new ProcessingError("provider_timeout", `${label} took too long and will be retried automatically.`, true);
  }
  if (status === 429 || status >= 500) return new ProcessingError("provider_busy", `${label} is busy right now and will be retried automatically.`, true);
  if (status === 401 || status === 403 || /api key not valid|API_KEY_INVALID/i.test(raw)) {
    return new ProcessingError("provider_auth", `${label} can't run: the AI service rejected the server's credentials. Ask your administrator.`, false);
  }
  if (status === 404) return new ProcessingError("provider_model", `${label} can't run: the configured AI model was not found. Ask your administrator.`, false);
  return new ProcessingError("provider_rejected", `${label} failed because the AI service refused the request.`, false);
}
