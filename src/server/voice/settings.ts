import "server-only";
import type { AppConfig } from "../config";
import type { TenantContext } from "../tenant";

/** The part of a caller that voice settings and the speech cache depend on. */
type VoiceTenant = Pick<TenantContext, "tenantId" | "userEmail">;

/** Voice settings in effect for one tenant. */
export interface VoiceSettings {
  tts: { enabled: boolean; model: string; voice: string; maxChars: number };
  stt: { enabled: boolean; model: string | null };
  /** Whether a Gemini API key is available on the server. */
  geminiConfigured: boolean;
}

/** Per-tenant overrides (none stored yet). Returning values here changes only that tenant. */
export type TenantVoiceOverrides = (tenantId: string) => Partial<{ ttsEnabled: boolean; ttsModel: string; ttsVoice: string; sttEnabled: boolean }> | undefined;

const noOverrides: TenantVoiceOverrides = () => undefined;

/**
 * Resolves voice settings for a tenant: environment defaults, then that tenant's overrides. There is
 * no global mutable state, so one tenant's settings can never change another's.
 */
export function resolveVoiceSettings(
  tenant: VoiceTenant,
  config: Pick<AppConfig, "GEMINI_TTS_ENABLED" | "GEMINI_TTS_MODEL" | "GEMINI_TTS_VOICE" | "TTS_MAX_CHARS" | "VOICE_INPUT_ENABLED" | "GEMINI_STT_MODEL">,
  gemini: { apiKey: string | undefined; chatModel: string | undefined },
  overrides: TenantVoiceOverrides = noOverrides,
): VoiceSettings {
  const o = overrides(tenant.tenantId) ?? {};
  const geminiConfigured = !!gemini.apiKey;
  return {
    tts: {
      enabled: (o.ttsEnabled ?? config.GEMINI_TTS_ENABLED) && geminiConfigured,
      model: o.ttsModel ?? config.GEMINI_TTS_MODEL,
      voice: o.ttsVoice ?? config.GEMINI_TTS_VOICE,
      maxChars: config.TTS_MAX_CHARS,
    },
    stt: {
      enabled: (o.sttEnabled ?? config.VOICE_INPUT_ENABLED) && geminiConfigured && !!(config.GEMINI_STT_MODEL ?? gemini.chatModel),
      model: config.GEMINI_STT_MODEL ?? gemini.chatModel ?? null,
    },
    geminiConfigured,
  };
}
