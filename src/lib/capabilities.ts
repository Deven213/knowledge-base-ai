import type { ProviderId } from "./types";

// Best-effort check of whether a model accepts image input. Model IDs are free text, so this
// uses known text-only families rather than a fixed list of models. If it guesses wrong, the
// provider rejects the request and the server reports the same clear error (see llm/errors.ts).
const TEXT_ONLY: Record<ProviderId, RegExp> = {
  // GPT-3.5, the original GPT-4 (not 4o/4.1/4-turbo), o1-mini/o3-mini, and audio/search/embedding models.
  openai:
    /^(gpt-3\.5|gpt-4(-\d{4}|-32k)?(-preview)?$|gpt-4-0\d|o1-mini|o3-mini|text-|davinci|babbage)|(audio|realtime|transcribe|tts|embedding|search)/i,
  // Claude 2 and Claude Instant predate vision; every Claude 3+ model accepts images.
  anthropic: /^claude-(2|instant)/i,
  // Gemini TTS, embedding and AQA models don't take images; the chat models do.
  gemini: /(tts|embedding|aqa|imagen)/i,
};

export function supportsImageInput(provider: ProviderId, model: string | null): boolean {
  if (!model) return false;
  return !TEXT_ONLY[provider].test(model.trim());
}

export const IMAGE_UNSUPPORTED_MESSAGE = "This model does not support image input. Please select a multimodal model.";
