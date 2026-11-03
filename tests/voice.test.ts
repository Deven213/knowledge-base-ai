import { describe, expect, it, vi } from "vitest";
import type { AIResponse } from "@/lib/ai-response";
import { cleanForSpeech, speechTextForAnswer } from "@/lib/speech-text";
import { normalizeAudioType } from "@/server/stt/gemini-stt";
import { pcmToWav, toPlayableAudio } from "@/server/tts/gemini-tts";
import { SpeechCache, synthesizeSpeech } from "@/server/tts/service";
import { VoiceError, type SpeechRequest, type TextToSpeechProvider } from "@/server/tts/types";
import { resolveVoiceSettings } from "@/server/voice/settings";
import { testConfig } from "./helpers";

const tenantA = { tenantId: "tenant-a", userEmail: "a@example.com" };
const tenantB = { tenantId: "tenant-b", userEmail: "b@example.com" };
const settings = (over: Partial<ReturnType<typeof testConfig>> = {}) =>
  resolveVoiceSettings(tenantA, testConfig(over), { apiKey: "AIza-test", chatModel: "gemini-chat" });

function fakeProvider() {
  const generateSpeech = vi.fn(async (_request: SpeechRequest) => ({ audio: Buffer.from("RIFFfake-audio"), mimeType: "audio/wav" }));
  return { provider: { id: "fake", generateSpeech } as TextToSpeechProvider, generateSpeech };
}

describe("what Listen reads aloud", () => {
  it("speaks the structured answer without source markers, markup or the question", () => {
    const answer: AIResponse = {
      found: true,
      title: "Common Side Effects",
      summary: "Diarrhea and nausea are common [1].",
      sections: [
        { title: "Most common", bullets: ["**Diarrhea** [1]", "Nausea [2]"], callout: { type: "important", text: "Take with food [3]" }, citations: [1] },
        { title: "Doses", table: { headers: ["Group", "Dose"], rows: [["Adults", "500 mg"]] } },
      ],
      sources: [],
      language: "en",
    };
    const text = speechTextForAnswer(answer, "ignored");
    expect(text).toBe("Common Side Effects.\nDiarrhea and nausea are common.\nMost common.\nDiarrhea.\nNausea.\nTake with food.\nDoses.\nGroup Adults, Dose 500 mg.");
    expect(text).not.toMatch(/\[\d\]|\*\*/);
  });

  it("falls back to the plain answer, dropping on-screen-only source lines", () => {
    expect(speechTextForAnswer(null, "Answer text [1].\nSources: [1][2]")).toBe("Answer text.");
    expect(cleanForSpeech("- item\n## Heading\n`code`")).toBe("item\nHeading\ncode");
  });

  it("keeps Hindi/Gujarati text as-is (no translation)", () => {
    expect(speechTextForAnswer(null, "मेटफॉर्मिन भोजन के साथ लें। [2]")).toBe("मेटफॉर्मिन भोजन के साथ लें।");
    expect(speechTextForAnswer(null, "ભોજન સાથે લો [1]")).toBe("ભોજન સાથે લો");
  });
});

describe("Gemini TTS audio handling", () => {
  it("wraps raw 16-bit PCM in a playable WAV header", () => {
    const wav = pcmToWav(Buffer.alloc(48_000), 24_000, 1);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.length).toBe(48_044);
  });

  it("returns WAV as-is, converts L16, and rejects empty audio", () => {
    const wav = Buffer.from("RIFF....WAVE").toString("base64");
    expect(toPlayableAudio(wav, "audio/wav").mimeType).toBe("audio/wav");
    const pcm = toPlayableAudio(Buffer.alloc(10).toString("base64"), "audio/l16;rate=24000");
    expect(pcm.mimeType).toBe("audio/wav");
    expect(pcm.audio.subarray(0, 4).toString()).toBe("RIFF");
    expect(() => toPlayableAudio(undefined, "audio/wav")).toThrow(VoiceError);
    expect(() => toPlayableAudio("", "audio/wav")).toThrow(/No audio/);
  });
});

describe("synthesizeSpeech (server)", () => {
  it("calls the provider once per unique text/language/voice/model and caches the result", async () => {
    const { provider, generateSpeech } = fakeProvider();
    const cache = new SpeechCache();
    const deps = { provider, apiKey: "AIza-test", cache };
    const first = await synthesizeSpeech(deps, tenantA, settings(), { text: "Hello [1]", language: "en" });
    const second = await synthesizeSpeech(deps, tenantA, settings(), { text: "Hello", language: "en" });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true); // same cleaned text
    expect(generateSpeech).toHaveBeenCalledTimes(1);
    expect(generateSpeech.mock.calls[0]![0]).toMatchObject({ text: "Hello", voice: "Kore", language: "en-IN", model: "gemini-3.8-flash-lite-tts" });

    await synthesizeSpeech(deps, tenantA, settings(), { text: "Hello", language: "gu" });
    expect(generateSpeech.mock.calls[1]![0]).toMatchObject({ language: "gu-IN" });
    expect(generateSpeech).toHaveBeenCalledTimes(2); // different language → different audio
  });

  it("never serves one tenant's cached audio to another", async () => {
    const { provider, generateSpeech } = fakeProvider();
    const cache = new SpeechCache();
    await synthesizeSpeech({ provider, apiKey: "k", cache }, tenantA, settings(), { text: "Same text", language: "en" });
    const b = await synthesizeSpeech({ provider, apiKey: "k", cache }, tenantB, settings(), { text: "Same text", language: "en" });
    expect(b.cached).toBe(false);
    expect(generateSpeech).toHaveBeenCalledTimes(2);
    expect(SpeechCache.key({ tenantId: "a", model: "m", voice: "v", language: "l", text: "t" })).not.toBe(
      SpeechCache.key({ tenantId: "b", model: "m", voice: "v", language: "l", text: "t" }),
    );
  });

  it("enforces limits and configuration before calling the provider", async () => {
    const { provider, generateSpeech } = fakeProvider();
    const deps = { provider, apiKey: "k", cache: new SpeechCache() };
    await expect(synthesizeSpeech(deps, tenantA, settings({ TTS_MAX_CHARS: 100 }), { text: "a".repeat(101), language: "en" })).rejects.toMatchObject({ kind: "bad_input" });
    await expect(synthesizeSpeech(deps, tenantA, settings(), { text: " [1] ", language: "en" })).rejects.toMatchObject({ kind: "bad_input" });
    await expect(synthesizeSpeech(deps, tenantA, settings({ GEMINI_TTS_ENABLED: false }), { text: "hi", language: "en" })).rejects.toMatchObject({ kind: "disabled" });
    await expect(synthesizeSpeech({ ...deps, apiKey: undefined }, tenantA, settings(), { text: "hi", language: "en" })).rejects.toMatchObject({ kind: "not_configured" });
    // Unknown voice names are ignored in favour of the configured voice.
    await synthesizeSpeech(deps, tenantA, settings(), { text: "hi", language: "en", voice: "../../etc" });
    expect(generateSpeech.mock.calls[0]![0]).toMatchObject({ voice: "Kore" });
  });

  it("keeps the cache bounded", () => {
    const cache = new SpeechCache(2, 1000);
    const audio = (n: number) => ({ audio: Buffer.alloc(n), mimeType: "audio/wav" });
    cache.set("a", audio(10));
    cache.set("b", audio(10));
    cache.set("c", audio(10));
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    cache.set("big", audio(2000)); // larger than the whole cache: not stored
    expect(cache.get("big")).toBeUndefined();
  });
});

describe("voice settings per tenant", () => {
  it("comes from the environment and is off without a Gemini key", () => {
    const s = settings();
    expect(s.tts).toMatchObject({ enabled: true, model: "gemini-3.8-flash-lite-tts", voice: "Kore" });
    expect(s.stt).toEqual({ enabled: true, model: "gemini-chat" });
    const noKey = resolveVoiceSettings(tenantA, testConfig(), { apiKey: undefined, chatModel: "x" });
    expect(noKey.tts.enabled || noKey.stt.enabled).toBe(false);
    expect(resolveVoiceSettings(tenantA, testConfig({ GEMINI_STT_MODEL: "stt-model" }), { apiKey: "k", chatModel: "x" }).stt.model).toBe("stt-model");
  });

  it("a tenant override changes only that tenant", () => {
    const overrides = (id: string) => (id === "tenant-b" ? { ttsVoice: "Puck", sttEnabled: false } : undefined);
    const a = resolveVoiceSettings(tenantA, testConfig(), { apiKey: "k", chatModel: "m" }, overrides);
    const b = resolveVoiceSettings(tenantB, testConfig(), { apiKey: "k", chatModel: "m" }, overrides);
    expect(a.tts.voice).toBe("Kore");
    expect(a.stt.enabled).toBe(true);
    expect(b.tts.voice).toBe("Puck");
    expect(b.stt.enabled).toBe(false);
  });
});

describe("voice input formats", () => {
  it("accepts browser recording formats only", () => {
    expect(normalizeAudioType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(normalizeAudioType("audio/mp4")).toBe("audio/mp4");
    expect(normalizeAudioType("application/json")).toBeNull();
    expect(normalizeAudioType("video/webm")).toBeNull();
  });
});
