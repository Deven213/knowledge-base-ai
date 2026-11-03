import "server-only";
import { getConfig } from "../config";
import { getPlatformServices } from "../services";
import type { TenantContext } from "../tenant";
import { resolveVoiceSettings, type VoiceSettings } from "./settings";

export interface VoiceContext {
  tenant: TenantContext;
  settings: VoiceSettings;
  /** Server-side only; never returned to the browser. */
  apiKey: string | undefined;
}

/** The caller's voice settings for this request. The caller is always the already-verified tenant of a signed-in request. */
export function voiceContext(tenant: TenantContext): VoiceContext {
  const gemini = getPlatformServices().providerConfig.resolve("gemini");
  return {
    tenant,
    settings: resolveVoiceSettings(tenant, getConfig(), { apiKey: gemini.apiKey ?? undefined, chatModel: gemini.model ?? undefined }),
    apiKey: gemini.apiKey ?? undefined,
  };
}
