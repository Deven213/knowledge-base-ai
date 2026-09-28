import "server-only";
import { IMAGE_UNSUPPORTED_MESSAGE } from "@/lib/capabilities";
import { PROVIDER_ENV_VARS, PROVIDER_LABELS, type ProviderId } from "@/lib/types";
import { redactSecrets } from "../security/redact";
import { LLMError } from "./types";

/**
 * Maps SDK errors from any provider onto a small set of user-facing messages.
 * All three SDKs expose an HTTP `status` on API errors.
 */
export function toLLMError(
  err: unknown,
  provider: ProviderId,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): LLMError {
  if (err instanceof LLMError) return err;
  // The user pressed Stop (the request's signal was aborted): not a provider failure.
  if (signal?.aborted) return new LLMError("cancelled", "The request was cancelled.");

  const label = PROVIDER_LABELS[provider];
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 0;
  const name = err instanceof Error ? err.name : "";
  const rawMessage = err instanceof Error ? err.message : String(err);
  const detail = redactSecrets(rawMessage, [apiKey]).slice(0, 300);

  // Log the redacted detail server-side for debugging; never log the key or the request.
  console.error(`[llm:${provider}] ${name || "Error"} status=${status || "n/a"}: ${detail}`);

  if (/timeout|timed out/i.test(name + rawMessage) || name === "AbortError") {
    return new LLMError("timeout", `${label} did not respond in time. Please try again.`);
  }
  if (status === 401 || status === 403 || /api key not valid|invalid.*api.?key|API_KEY_INVALID/i.test(rawMessage)) {
    return new LLMError("auth", `${label} rejected the API key. Check ${PROVIDER_ENV_VARS[provider].apiKey} in the .env file.`);
  }
  if (status === 404 || /model.*(not found|does not exist)|not_found_error/i.test(rawMessage)) {
    return new LLMError(
      "model_not_found",
      `${label} does not recognise the model "${model}", or your key has no access to it. Check the model ID in AI Model Settings.`,
    );
  }
  if (status === 429 && /insufficient_quota|credit|billing|exceeded your current quota/i.test(rawMessage)) {
    return new LLMError(
      "rate_limit",
      `Your ${label} account has no credits left (or has reached its spending limit). Add credits in the provider's billing settings, or switch provider in AI Model Settings.`,
    );
  }
  if (status === 429) {
    return new LLMError("rate_limit", `${label} rate limit or quota exceeded. Wait a moment or check your plan.`);
  }
  if (
    /image|vision|multimodal|inline_?data|input_image/i.test(rawMessage) &&
    /not support|unsupported|does not accept|not enabled|cannot process|can't process/i.test(rawMessage)
  ) {
    return new LLMError("image_unsupported", IMAGE_UNSUPPORTED_MESSAGE);
  }
  if (status === 400 || status === 422) {
    return new LLMError("bad_request", `${label} rejected the request: ${detail}`);
  }
  if (status >= 500 || /ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(rawMessage)) {
    return new LLMError("unavailable", `${label} is unreachable or returned a server error. Please try again.`);
  }
  return new LLMError("unknown", `${label} request failed: ${detail}`);
}
