import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INLINE_AUDIO_LIMIT_BYTES, geminiTranscriber, TRANSCRIPT_SCHEMA, TRANSCRIPTION_SYSTEM_PROMPT } from "@/server/consultations/transcription/gemini";
import type { TranscriptionRequest } from "@/server/consultations/transcription/types";
import { audioBytes, MIXED_TRANSCRIPT } from "./consultation-helpers";

const h = vi.hoisted(() => ({ generateContent: vi.fn(), upload: vi.fn(), get: vi.fn(), remove: vi.fn(), constructed: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@google/genai")>();
  class GoogleGenAI {
    models = { generateContent: h.generateContent };
    files = { upload: h.upload, get: h.get, delete: h.remove };
    constructor(options: unknown) {
      h.constructed(options);
    }
  }
  return { ...real, GoogleGenAI };
});

const KEY = "AIzaSyTESTKEYTESTKEYTESTKEYTESTKEY12345";
let output: string[];
const request = (overrides: Partial<TranscriptionRequest> = {}): TranscriptionRequest => ({ audio: audioBytes(4000), mimeType: "audio/webm", languageHint: "mixed", model: "gemini-2.5-flash", apiKey: KEY, ...overrides });
const answer = (content: unknown = MIXED_TRANSCRIPT, extra: Record<string, unknown> = {}) => ({ text: typeof content === "string" ? content : JSON.stringify(content), candidates: [{ finishReason: "STOP" }], ...extra });
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status, name: "ApiError" });

beforeEach(() => {
  h.generateContent.mockReset().mockResolvedValue(answer());
  h.upload.mockReset().mockResolvedValue({ name: "files/abc", uri: "https://example.test/files/abc", state: "ACTIVE" });
  h.get.mockReset().mockResolvedValue({ name: "files/abc", uri: "https://example.test/files/abc", state: "ACTIVE" });
  h.remove.mockReset().mockResolvedValue({});
  h.constructed.mockReset();
  output = [];
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("transcribing a short recording", () => {
  it("sends the audio inline with strict instructions and a fixed answer shape, and returns the cleaned transcript", async () => {
    const audio = audioBytes(4000, 3);
    const result = await geminiTranscriber.transcribe(request({ audio }));
    expect(h.upload).not.toHaveBeenCalled(); // nothing is left at the provider
    const call = h.generateContent.mock.calls[0]![0];
    expect(call.model).toBe("gemini-2.5-flash");
    const parts = call.contents[0].parts;
    expect(parts[1].inlineData).toEqual({ mimeType: "audio/webm", data: audio.toString("base64") });
    expect(parts[0].text).toMatch(/Transcribe the recording below/);
    expect(call.config).toMatchObject({ systemInstruction: TRANSCRIPTION_SYSTEM_PROMPT, temperature: 0, responseMimeType: "application/json", responseJsonSchema: TRANSCRIPT_SCHEMA });
    expect(result).toMatchObject({ speakerLabels: "inferred", audioQuality: "fair" });
    expect(result.segments).toHaveLength(6);
    expect(result.segments[4]!.text).toContain("Paracetamol 650 mg"); // a drug and a dose, in the middle of Gujarati
  });

  it("tells the service what to expect from the doctor's language choice, without ever excluding the others", async () => {
    for (const [hint, expected] of [["gu", /mostly in Gujarati, but Hindi or English may appear/], ["hi", /mostly in Hindi/], ["en", /mostly in English/], ["mixed", /switching between Gujarati, Hindi and English/], ["auto", /English, Hindi, Gujarati, or any mix/]] as const) {
      h.generateContent.mockClear();
      await geminiTranscriber.transcribe(request({ languageHint: hint }));
      expect(h.generateContent.mock.calls[0]![0].contents[0].parts[0].text, hint).toMatch(expected);
    }
  });

  it("the instructions say what matters for a clinical record: exact words, each language in its own script, digits for doses, roles from context, honesty about uncertainty", () => {
    const prompt = TRANSCRIPTION_SYSTEM_PROMPT;
    expect(prompt).toMatch(/Transcribe exactly what was said/);
    expect(prompt).toMatch(/Never invent speech/);
    expect(prompt).toMatch(/Gujarati words in Gujarati script, Hindi words in Devanagari, English words in Latin letters/);
    expect(prompt).toMatch(/keep each word in its own language and script/);
    expect(prompt).toMatch(/Never translate/);
    expect(prompt).toMatch(/numbers, doses and measurements as digits/i);
    expect(prompt).toMatch(/Keep drug names exactly as said/);
    expect(prompt).toMatch(/use "unknown": never guess/);
    expect(prompt).toMatch(/"uncertain" to true/);
    expect(prompt).toMatch(/\[inaudible\]/);
    expect(prompt).toMatch(/Never put medical content in remarks/);
  });

  it("asks for as little deliberation as the model allows, and tries again plainly if the model refuses the setting", async () => {
    await geminiTranscriber.transcribe(request({ model: "gemini-2.5-flash" }));
    expect(h.generateContent.mock.calls[0]![0].config.thinkingConfig).toEqual({ thinkingBudget: 0 });
    h.generateContent.mockClear();
    await geminiTranscriber.transcribe(request({ model: "some-unknown-model" }));
    expect(h.generateContent.mock.calls[0]![0].config.thinkingConfig).toBeUndefined();

    h.generateContent.mockClear();
    h.generateContent.mockRejectedValueOnce(httpError(400, "This model does not support thinking_budget"));
    await geminiTranscriber.transcribe(request({ model: "gemini-2.5-flash" }));
    expect(h.generateContent).toHaveBeenCalledTimes(2);
    expect(h.generateContent.mock.calls[1]![0].config.thinkingConfig).toBeUndefined();
  });

  it("passes the cancellation signal through", async () => {
    const controller = new AbortController();
    await geminiTranscriber.transcribe(request({ signal: controller.signal }));
    expect(h.generateContent.mock.calls[0]![0].config.abortSignal).toBe(controller.signal);
  });
});

describe("transcribing a long recording", () => {
  const long = () => audioBytes(INLINE_AUDIO_LIMIT_BYTES + 1, 4);

  it("uploads it, waits until it is ready, uses it, and ALWAYS removes the uploaded copy afterwards", async () => {
    h.upload.mockResolvedValue({ name: "files/abc", uri: "https://example.test/files/abc", state: "PROCESSING" });
    h.get.mockResolvedValueOnce({ name: "files/abc", uri: "https://example.test/files/abc", state: "PROCESSING" }).mockResolvedValueOnce({ name: "files/abc", uri: "https://example.test/files/abc", state: "ACTIVE" });
    vi.useFakeTimers();
    try {
      const pending = geminiTranscriber.transcribe(request({ audio: long() }));
      await vi.advanceTimersByTimeAsync(5000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.upload.mock.calls[0]![0].config.mimeType).toBe("audio/webm");
    expect(h.get).toHaveBeenCalledTimes(2);
    const parts = h.generateContent.mock.calls[0]![0].contents[0].parts;
    expect(parts[1]).toEqual({ fileData: { fileUri: "https://example.test/files/abc", mimeType: "audio/webm" } });
    expect(parts[1].inlineData).toBeUndefined();
    expect(h.remove).toHaveBeenCalledWith({ name: "files/abc" });
  });

  it("removes the uploaded copy even when the transcription fails", async () => {
    h.generateContent.mockRejectedValue(httpError(500, "internal"));
    await expect(geminiTranscriber.transcribe(request({ audio: long() }))).rejects.toMatchObject({ retryable: true });
    expect(h.remove).toHaveBeenCalledWith({ name: "files/abc" });
  });

  it("a failure to remove the copy never hides the result", async () => {
    h.remove.mockRejectedValue(new Error("network"));
    const result = await geminiTranscriber.transcribe(request({ audio: long() }));
    expect(result.segments).toHaveLength(6);
  });

  it("a recording the service can't prepare is retried later, and its copy is still removed", async () => {
    h.upload.mockResolvedValue({ name: "files/abc", uri: "https://example.test/files/abc", state: "FAILED" });
    await expect(geminiTranscriber.transcribe(request({ audio: long() }))).rejects.toMatchObject({ code: "provider_timeout", retryable: true });
    expect(h.generateContent).not.toHaveBeenCalled();
    expect(h.remove).toHaveBeenCalled();
  });

  it("a recording at the inline limit is still sent inline (nothing is uploaded needlessly)", async () => {
    await geminiTranscriber.transcribe(request({ audio: audioBytes(INLINE_AUDIO_LIMIT_BYTES) }));
    expect(h.upload).not.toHaveBeenCalled();
  });
});

describe("what can go wrong", () => {
  it("a transcript cut off at the model's limit is reported as too long and is not retried", async () => {
    h.generateContent.mockResolvedValue({ text: '{"segments": [', candidates: [{ finishReason: "MAX_TOKENS" }] });
    await expect(geminiTranscriber.transcribe(request())).rejects.toMatchObject({ code: "transcript_too_long", retryable: false });
  });

  it("an empty or unreadable answer is retried, and the unreadable text is never quoted", async () => {
    h.generateContent.mockResolvedValue({ text: "   ", candidates: [{ finishReason: "STOP" }] });
    await expect(geminiTranscriber.transcribe(request())).rejects.toMatchObject({ code: "provider_empty", retryable: true });
    h.generateContent.mockResolvedValue(answer("Sorry, I heard Asha Patel say she takes metformin but cannot format it as JSON"));
    const err = await geminiTranscriber.transcribe(request()).catch((e) => e);
    expect(err).toMatchObject({ code: "bad_transcript", retryable: true });
    expect(err.message).not.toMatch(/Asha|metformin/);
    expect(output.join("\n")).not.toMatch(/Asha|metformin/);
  });

  it("silence ends the job for good (there is nothing to retry)", async () => {
    h.generateContent.mockResolvedValue(answer({ segments: [], remarks: ["silence"], audioQuality: "poor" }));
    await expect(geminiTranscriber.transcribe(request())).rejects.toMatchObject({ code: "no_speech", retryable: false });
  });

  it("separates temporary trouble (retry) from a rejected key or model (don't retry)", async () => {
    const cases: [number, string, boolean][] = [[429, "provider_busy", true], [500, "provider_busy", true], [503, "provider_busy", true], [401, "provider_auth", false], [403, "provider_auth", false], [404, "provider_model", false], [400, "provider_rejected", false]];
    for (const [status, code, retryable] of cases) {
      h.generateContent.mockRejectedValue(httpError(status, `status ${status}`));
      await expect(geminiTranscriber.transcribe(request()), String(status)).rejects.toMatchObject({ code, retryable });
    }
    for (const name of ["AbortError", "TimeoutError"]) {
      h.generateContent.mockRejectedValue(Object.assign(new Error("request timed out"), { name }));
      await expect(geminiTranscriber.transcribe(request())).rejects.toMatchObject({ retryable: true });
    }
  });

  it("a cancelled job stops without a retry", async () => {
    const controller = new AbortController();
    controller.abort();
    h.generateContent.mockRejectedValue(new Error("aborted"));
    await expect(geminiTranscriber.transcribe(request({ signal: controller.signal }))).rejects.toMatchObject({ code: "cancelled", retryable: false });
  });

  it("never lets the key reach the doctor or the log, even when the provider's own message contains it", async () => {
    h.generateContent.mockRejectedValue(httpError(403, `API key not valid. Please pass a valid API key. key=${KEY}`));
    const err = await geminiTranscriber.transcribe(request()).catch((e) => e);
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toMatch(/AIza/);
    expect(output.join("\n")).not.toContain(KEY);
    expect(output.join("\n")).toMatch(/status=403/); // the operator still learns what happened
  });

  it("does not log what a rejected request says (it could quote the conversation)", async () => {
    h.generateContent.mockRejectedValue(httpError(400, "Invalid value at contents[0].parts[1]: 'Asha Patel takes metformin 500 mg'"));
    await geminiTranscriber.transcribe(request()).catch(() => undefined);
    expect(output.join("\n")).toMatch(/status=400/);
    expect(output.join("\n")).not.toMatch(/Asha|metformin|Invalid value/);
  });
});
