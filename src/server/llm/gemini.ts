import "server-only";
import { GoogleGenAI, ThinkingLevel, type Part, type ThinkingConfig } from "@google/genai";
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

/**
 * Thinking settings that keep a call fast when the task needs no reasoning. Gemini models think by default, and the
 * thinking is invisible but is generated (and waited for) before the answer. Measured on gemini-3-flash-preview with a short
 * translation: 4,409 and 9,396 thinking tokens took 19 s and 40 s; with minimal thinking, 0 tokens and 4.1 s and 4.8 s. How to
 * ask differs by generation; models not listed here get no hint.
 */
export function minimalThinking(model: string): ThinkingConfig | undefined {
  const m = model.toLowerCase().replace(/^models\//, "");
  if (/^gemini-3/.test(m)) return { thinkingLevel: /pro/.test(m) ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL }; // the Pro models have no "minimal"
  if (/^gemini-2\.5-pro/.test(m)) return { thinkingBudget: 128 }; // 2.5 Pro can't switch thinking off; 128 is its smallest budget
  if (/^gemini-2\.5-flash/.test(m)) return { thinkingBudget: 0 }; // 0 = thinking off
  return undefined;
}

/** Models that refused the hint once: later calls skip it instead of failing and retrying every time. */
const refusedHint = new Set<string>();

const refusesThinking = (err: unknown) => (err as { status?: number })?.status === 400 && /think/i.test(String((err as Error)?.message));

export const geminiProvider: LLMProvider = {
  id: "gemini",
  async generate({ system, content, model, apiKey, signal, responseFormat, reasoning, sensitive }: LLMRequest): Promise<LLMResponse> {
    const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: LLM_TIMEOUT_MS } });
    const run = async (thinking: ThinkingConfig | undefined): Promise<LLMResponse> => {
      const response = await client.models.generateContent({
        model,
        contents: [{ role: "user", parts: toGeminiParts(content) }],
        config: {
          systemInstruction: system,
          abortSignal: signal,
          ...(thinking && { thinkingConfig: thinking }),
          // Gemini structured output: JSON constrained by the JSON Schema.
          ...(responseFormat && { responseMimeType: "application/json", responseJsonSchema: responseFormat.schema }),
        },
      });
      const text = response.text?.trim();
      if (!text) throw new LLMError("empty_response", "Gemini returned an empty answer (it may have been blocked).");
      return { text };
    };
    const hint = reasoning === "minimal" && !refusedHint.has(model) ? minimalThinking(model) : undefined;
    try {
      try {
        return await run(hint);
      } catch (err) {
        if (!hint || !refusesThinking(err)) throw err;
        refusedHint.add(model); // this model doesn't take the setting: ask again plainly (and remember it)
        return await run(undefined);
      }
    } catch (err) {
      throw toLLMError(err, "gemini", model, apiKey, signal, { sensitive });
    }
  },
};
