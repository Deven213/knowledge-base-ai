import "server-only";
import { GoogleGenAI, type Part } from "@google/genai";
import { toLLMError } from "./errors";
import {
  LLM_TIMEOUT_MS,
  LLMError,
  orderedParts,
  type ContentPart,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from "./types";

/** Neutral content → Gemini parts. Images go as inline base64 data. */
export function toGeminiParts(content: ContentPart[]): Part[] {
  return orderedParts(content).map((part) =>
    part.type === "text"
      ? { text: part.text }
      : { inlineData: { mimeType: part.mediaType, data: part.data.toString("base64") } },
  );
}

export const geminiProvider: LLMProvider = {
  id: "gemini",
  async generate({ system, content, model, apiKey, signal, responseFormat }: LLMRequest): Promise<LLMResponse> {
    const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: LLM_TIMEOUT_MS } });
    try {
      const response = await client.models.generateContent({
        model,
        contents: [{ role: "user", parts: toGeminiParts(content) }],
        config: {
          systemInstruction: system,
          abortSignal: signal,
          // Gemini structured output: JSON constrained by the JSON Schema.
          ...(responseFormat && { responseMimeType: "application/json", responseJsonSchema: responseFormat.schema }),
        },
      });
      const text = response.text?.trim();
      if (!text) throw new LLMError("empty_response", "Gemini returned an empty answer (it may have been blocked).");
      return { text };
    } catch (err) {
      throw toLLMError(err, "gemini", model, apiKey, signal);
    }
  },
};
