import "server-only";
import OpenAI from "openai";
import type { ResponseInputContent } from "openai/resources/responses/responses";
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

/** Neutral content → OpenAI Responses API input parts. Images go as base64 data URLs. */
export function toOpenAIContent(content: ContentPart[]): ResponseInputContent[] {
  return orderedParts(content).map((part) =>
    part.type === "text"
      ? { type: "input_text", text: part.text }
      : { type: "input_image", detail: "auto", image_url: `data:${part.mediaType};base64,${part.data.toString("base64")}` },
  );
}

export const openaiProvider: LLMProvider = {
  id: "openai",
  async generate({ system, content, model, apiKey, signal, responseFormat, sensitive }: LLMRequest): Promise<LLMResponse> {
    const client = new OpenAI({ apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 1 });
    try {
      // No temperature/max token settings: some models (e.g. reasoning models) reject them.
      const response = await client.responses.create(
        {
          model,
          instructions: system,
          input: [{ role: "user", content: toOpenAIContent(content) }],
          // Structured Outputs: the model's text is guaranteed to match the JSON schema (strict mode).
          ...(responseFormat && {
            text: {
              format: {
                type: "json_schema" as const,
                name: responseFormat.name,
                description: responseFormat.description,
                schema: responseFormat.schema,
                strict: true,
              },
            },
          }),
        },
        { signal },
      );
      const text = response.output_text?.trim();
      if (!text) throw new LLMError("empty_response", "OpenAI returned an empty answer.");
      return { text };
    } catch (err) {
      throw toLLMError(err, "openai", model, apiKey, signal, { sensitive });
    }
  },
};
