import "server-only";
import { GoogleGenAI, ThinkingLevel, type ThinkingConfig } from "@google/genai";
import type { LanguageHint } from "@/lib/consultations";
import { classifyProviderError, ProcessingError } from "../processing-error";
import { normalizeTranscript } from "./parse";
import type { TranscriptionProvider, TranscriptionRequest } from "./types";

// Gemini transcribes the recording and says who spoke. It has no true speaker diarization: the roles are worked out from the
// conversation (the doctor asks, examines, advises; the patient describes), and anything it can't tell is labelled "unknown". The
// transcript records that (speakerLabels: "inferred") so the doctor knows.
//
// The recording is sent only when the privacy gate is open (gate.ts). Small recordings go inline in the request; larger ones go through
// the Files API, and the uploaded copy is deleted again as soon as the call ends, success or failure, so Google isn't left holding it.

const TIMEOUT_MS = 10 * 60_000;
/** Inline audio is base64 inside a request that is capped at 20 MB; stay well under it. */
export const INLINE_AUDIO_LIMIT_BYTES = 12 * 1024 * 1024;
const FILE_READY_TIMEOUT_MS = 90_000;

export const TRANSCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["segments", "remarks", "audioQuality"],
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["speaker", "text", "language", "uncertain"],
        properties: {
          speaker: { type: "string", enum: ["doctor", "patient", "other", "unknown"] },
          text: { type: "string" },
          language: { type: "string", enum: ["en", "hi", "gu", "mixed"] },
          uncertain: { type: "boolean" },
        },
      },
    },
    remarks: { type: "array", items: { type: "string" } },
    audioQuality: { type: "string", enum: ["good", "fair", "poor"] },
  },
} as const;

export const TRANSCRIPTION_SYSTEM_PROMPT = `You transcribe the recording of a conversation between a doctor and a patient (sometimes a relative, nurse or interpreter is also present). The speakers use English, Hindi, Gujarati, or a mix of them, often switching language in the middle of a sentence.

Rules:
1. Transcribe exactly what was said. Do not summarise, correct, translate, tidy up, add or leave anything out. Never invent speech: if the recording is silent or unintelligible, return no segments.
2. Write every word in the language and script it was spoken in: Gujarati words in Gujarati script, Hindi words in Devanagari, English words in Latin letters. When a speaker mixes languages in one sentence, keep each word in its own language and script (medical terms and drug names that were said in English stay in English letters). Never translate, and never write a whole utterance in another script.
3. Write numbers, doses and measurements as digits with their unit as it was said ("500 mg", "120/80"). Keep drug names exactly as said. If you are not sure of a drug name, write it as it sounds and set "uncertain" to true.
4. Start a new segment at each change of speaker. Label the speaker "doctor", "patient", "other" (a relative, nurse or interpreter) or "unknown". Decide the roles from the conversation: the doctor asks clinical questions, examines, explains, advises and prescribes; the patient describes symptoms and history. If you cannot tell, use "unknown": never guess.
5. Set "uncertain" to true on any segment where words are unclear, partly inaudible, or a guess (names, numbers, drug names, unfamiliar dialect). Write [inaudible] where words cannot be made out.
6. Set each segment's "language" to "en", "hi" or "gu", or "mixed" when it combines languages.
7. In "remarks" put short notes about the recording itself (background noise, overlapping speech, one speaker barely audible). Never put medical content in remarks.
8. Set "audioQuality" to "good", "fair" or "poor".`;

const HINT_TEXT: Record<LanguageHint, string> = {
  auto: "The speakers may use English, Hindi, Gujarati, or any mix of them.",
  en: "The conversation is expected to be mostly in English, but Hindi or Gujarati may appear.",
  hi: "The conversation is expected to be mostly in Hindi, but English or Gujarati may appear.",
  gu: "The conversation is expected to be mostly in Gujarati, but Hindi or English may appear.",
  mixed: "Expect frequent switching between Gujarati, Hindi and English, including inside sentences.",
};

/** Same idea as the chat adapter: a transcription needs no long deliberation, so ask for as little thinking as the model allows. */
function minimalThinking(model: string): ThinkingConfig | undefined {
  const m = model.toLowerCase().replace(/^models\//, "");
  if (/^gemini-3/.test(m)) return { thinkingLevel: /pro/.test(m) ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL };
  if (/^gemini-2\.5-pro/.test(m)) return { thinkingBudget: 128 };
  if (/^gemini-2\.5-flash/.test(m)) return { thinkingBudget: 0 };
  return undefined;
}
const refusesThinking = (err: unknown) => (err as { status?: number })?.status === 400 && /think/i.test(String((err as Error)?.message));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const geminiTranscriber: TranscriptionProvider = {
  id: "gemini",
  async transcribe(request: TranscriptionRequest) {
    const { audio, mimeType, languageHint, model, apiKey, signal } = request;
    const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: TIMEOUT_MS } });
    let uploaded: string | undefined;
    try {
      let audioPart: { inlineData: { mimeType: string; data: string } } | { fileData: { fileUri: string; mimeType: string } };
      if (audio.length <= INLINE_AUDIO_LIMIT_BYTES) {
        audioPart = { inlineData: { mimeType, data: audio.toString("base64") } };
      } else {
        let file = await client.files.upload({ file: new Blob([new Uint8Array(audio)], { type: mimeType }), config: { mimeType, abortSignal: signal } });
        uploaded = file.name;
        const until = Date.now() + FILE_READY_TIMEOUT_MS;
        while (file.state && String(file.state) !== "ACTIVE") {
          if (String(file.state) === "FAILED" || Date.now() > until) throw new ProcessingError("provider_timeout", "The speech service could not prepare the recording. It will be retried automatically.", true);
          await sleep(1500);
          file = await client.files.get({ name: file.name! });
        }
        audioPart = { fileData: { fileUri: file.uri!, mimeType } };
      }

      const run = (thinking: ThinkingConfig | undefined) =>
        client.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: `${HINT_TEXT[languageHint]} Transcribe the recording below.` }, audioPart] }],
          config: {
            systemInstruction: TRANSCRIPTION_SYSTEM_PROMPT,
            abortSignal: signal,
            temperature: 0,
            responseMimeType: "application/json",
            responseJsonSchema: TRANSCRIPT_SCHEMA,
            ...(thinking && { thinkingConfig: thinking }),
          },
        });
      const hint = minimalThinking(model);
      let response;
      try {
        response = await run(hint);
      } catch (err) {
        if (!hint || !refusesThinking(err)) throw err;
        response = await run(undefined);
      }

      if (String(response.candidates?.[0]?.finishReason) === "MAX_TOKENS") {
        throw new ProcessingError("transcript_too_long", "This recording is too long for the speech service to transcribe in one go. Record shorter consultations.", false);
      }
      const text = response.text?.trim();
      if (!text) throw new ProcessingError("provider_empty", "The speech service returned nothing. It will be retried automatically.", true);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ProcessingError("bad_transcript", "The speech service returned something that could not be read. It will be retried automatically.", true);
      }
      return normalizeTranscript(parsed);
    } catch (err) {
      throw classifyProviderError(err, "transcription", apiKey, signal);
    } finally {
      // Never leave the recording at Google: remove the uploaded copy whether or not the call worked.
      if (uploaded) await client.files.delete({ name: uploaded }).catch(() => undefined);
    }
  },
};
