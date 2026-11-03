import "server-only";
import { GoogleGenAI } from "@google/genai";
import { getLanguage } from "@/lib/languages";
import { VoiceError } from "../tts/types";
import { toVoiceError } from "../voice/errors";

// Voice input → text. A plain transcription request (no documents, no chat history, no RAG): the
// text only lands in the chat box, where the user reviews it and sends it like typed text.

const STT_TIMEOUT_MS = 60_000;
export const MAX_RECORDING_BYTES = 10 * 1024 * 1024;
export const ALLOWED_AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac"] as const;

const NO_SPEECH = "NO_SPEECH";

export function normalizeAudioType(type: string): string | null {
  const base = type.split(";")[0]!.trim().toLowerCase();
  return (ALLOWED_AUDIO_TYPES as readonly string[]).includes(base) ? base : null;
}

export async function transcribeSpeech(input: {
  audio: Buffer;
  mimeType: string;
  /** Answer language code; a hint only (the speaker may use another language). */
  language: string;
  model: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<string> {
  const client = new GoogleGenAI({ apiKey: input.apiKey, httpOptions: { timeout: STT_TIMEOUT_MS } });
  const hint = getLanguage(input.language).label;
  try {
    const response = await client.models.generateContent({
      model: input.model,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Transcribe this voice recording of a question exactly as spoken. The speaker most likely uses ${hint}. Write it in the language and script that was spoken. Output only the transcript text, with no quotes, labels or commentary. If there is no intelligible speech, output exactly ${NO_SPEECH}.`,
            },
            { inlineData: { mimeType: input.mimeType, data: input.audio.toString("base64") } },
          ],
        },
      ],
      config: { abortSignal: input.signal, temperature: 0 },
    });
    const text = (response.text ?? "").trim().replace(/^["“]|["”]$/g, "");
    if (!text || text === NO_SPEECH) throw new VoiceError("empty", "No speech was detected. Please try again and speak clearly.");
    return text.slice(0, 2000);
  } catch (err) {
    throw toVoiceError(err, "transcription", input.apiKey, input.signal);
  }
}
