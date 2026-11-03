import "server-only";
import { GoogleGenAI } from "@google/genai";
import { toVoiceError } from "../voice/errors";
import { VoiceError, type SpeechAudio, type SpeechRequest, type TextToSpeechProvider } from "./types";

const TTS_TIMEOUT_MS = 90_000;

/** Raw 16-bit little-endian mono PCM (audio/l16) → a WAV file browsers can play. */
export function pcmToWav(pcm: Buffer, sampleRate = 24_000, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Normalizes the audio returned by the API into a browser-playable file. */
export function toPlayableAudio(data: string | undefined, mimeType: string | undefined, sampleRate?: number, channels?: number): SpeechAudio {
  const bytes = data ? Buffer.from(data, "base64") : Buffer.alloc(0);
  if (bytes.length === 0) throw new VoiceError("empty", "No audio was produced for this answer. Please try again.");
  const type = (mimeType ?? "audio/wav").toLowerCase();
  if (type.startsWith("audio/l16") || type.startsWith("audio/pcm")) {
    const rate = Number(/rate=(\d+)/.exec(type)?.[1]) || sampleRate || 24_000;
    return { audio: pcmToWav(bytes, rate, channels ?? 1), mimeType: "audio/wav" };
  }
  return { audio: bytes, mimeType: type.split(";")[0]! };
}

/**
 * Gemini text-to-speech through the official Interactions API (as documented at
 * https://ai.google.dev/gemini-api/docs/speech-generation). Kept separate from the Gemini chat
 * provider. Unary requests return a WAV file (24 kHz, mono, 16-bit).
 */
export const geminiTts: TextToSpeechProvider = {
  id: "gemini",
  async generateSpeech({ text, voice, language, model, apiKey, signal }: SpeechRequest): Promise<SpeechAudio> {
    const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: TTS_TIMEOUT_MS } });
    try {
      const interaction = await client.interactions.create(
        {
          model,
          input: [{ type: "user_input", content: [{ type: "text", text }] }],
          response_format: { type: "audio", mime_type: "audio/wav" },
          generation_config: { speech_config: [{ voice, language }] },
        },
        { signal },
      );
      const out = interaction.output_audio;
      return toPlayableAudio(out?.data, out?.mime_type, out?.sample_rate, out?.channels);
    } catch (err) {
      throw toVoiceError(err, "speech", apiKey, signal);
    }
  },
};
