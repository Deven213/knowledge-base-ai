import "server-only";
import { createHash } from "node:crypto";
import { getLanguage } from "@/lib/languages";
import { cleanForSpeech } from "@/lib/speech-text";
import type { TenantContext } from "../tenant";

/** The part of a caller that voice settings and the speech cache depend on. */
type VoiceTenant = Pick<TenantContext, "tenantId" | "userEmail">;
import type { VoiceSettings } from "../voice/settings";
import { VoiceError, type SpeechAudio, type TextToSpeechProvider } from "./types";

/** BCP-47 speech language for each answer language (the text is already in that language). */
const SPEECH_LANGUAGE: Record<string, string> = { en: "en-IN", hi: "hi-IN", gu: "gu-IN" };

/**
 * Small in-memory LRU of generated audio. Keys are hashes of (tenant, model, voice, language, text),
 * so a tenant only ever hits its own entries; nothing is stored on disk or served publicly.
 */
export class SpeechCache {
  private readonly entries = new Map<string, SpeechAudio>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = 100,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {}

  static key(parts: { tenantId: string; model: string; voice: string; language: string; text: string }): string {
    return createHash("sha256").update(JSON.stringify([parts.tenantId, parts.model, parts.voice, parts.language, parts.text])).digest("hex");
  }

  get(key: string): SpeechAudio | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key); // refresh recency
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: SpeechAudio): void {
    if (value.audio.length > this.maxBytes) return;
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.audio.length;
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.bytes += value.audio.length;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [oldestKey, oldest] = this.entries.entries().next().value as [string, SpeechAudio];
      this.entries.delete(oldestKey);
      this.bytes -= oldest.audio.length;
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

const globalCache = globalThis as unknown as { __kbSpeechCache?: SpeechCache };
const sharedCache = (globalCache.__kbSpeechCache ??= new SpeechCache());

export interface SpeechResult extends SpeechAudio {
  cached: boolean;
}

/** Turns answer text into speech for one tenant, honouring its settings, limits and cache. */
export async function synthesizeSpeech(
  deps: { provider: TextToSpeechProvider; apiKey: string | undefined; cache?: SpeechCache },
  tenant: VoiceTenant,
  settings: VoiceSettings,
  input: { text: string; language: string; voice?: string; signal?: AbortSignal },
): Promise<SpeechResult> {
  if (!settings.geminiConfigured || !deps.apiKey) {
    throw new VoiceError("not_configured", "Speech playback is unavailable: Gemini is not configured on the server.");
  }
  if (!settings.tts.enabled) throw new VoiceError("disabled", "Speech playback is turned off.");

  const text = cleanForSpeech(input.text);
  if (!text) throw new VoiceError("bad_input", "There is no answer text to read aloud.");
  if (text.length > settings.tts.maxChars) {
    throw new VoiceError("bad_input", `This answer is too long to read aloud (limit ${settings.tts.maxChars.toLocaleString()} characters).`);
  }
  const language = SPEECH_LANGUAGE[getLanguage(input.language).code] ?? "en-IN";
  // Only the tenant's configured voice (or an explicitly allowed one) is used; no free-form names.
  const voice = input.voice && /^[A-Za-z]{2,24}$/.test(input.voice) ? input.voice : settings.tts.voice;

  const cache = deps.cache ?? sharedCache;
  const key = SpeechCache.key({ tenantId: tenant.tenantId, model: settings.tts.model, voice, language, text });
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  const audio = await deps.provider.generateSpeech({ text, voice, language, model: settings.tts.model, apiKey: deps.apiKey, signal: input.signal });
  cache.set(key, audio);
  return { ...audio, cached: false };
}
