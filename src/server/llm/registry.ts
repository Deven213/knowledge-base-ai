import "server-only";
import type { ProviderId } from "@/lib/types";
import { anthropicProvider } from "./anthropic";
import { geminiProvider } from "./gemini";
import { openaiProvider } from "./openai";
import type { LLMProvider } from "./types";

const PROVIDERS: Record<ProviderId, LLMProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
};

export function getProvider(id: ProviderId): LLMProvider {
  return PROVIDERS[id];
}
