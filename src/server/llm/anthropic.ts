import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { toLLMError } from "./errors";
import {
  LLM_TIMEOUT_MS,
  LLMError,
  orderedParts,
  type ContentPart,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type ResponseFormat,
} from "./types";

// Anthropic requires an explicit output cap.
const MAX_OUTPUT_TOKENS = 4096;

/** Neutral content → Anthropic Messages content blocks. Images go as base64 sources. */
export function toAnthropicContent(content: ContentPart[]): ContentBlockParam[] {
  return orderedParts(content).map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data.toString("base64") } },
  );
}

export const anthropicProvider: LLMProvider = {
  id: "anthropic",
  async generate({ system, content, model, apiKey, signal, responseFormat, sensitive }: LLMRequest): Promise<LLMResponse> {
    const client = new Anthropic({ apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 1 });
    const base = {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: "user" as const, content: toAnthropicContent(content) }],
    };
    try {
      if (responseFormat) return await structured(client, base, responseFormat, signal);
      const message = await client.messages.create(base, { signal });
      const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
        .trim();
      if (!text) throw new LLMError("empty_response", "Claude returned an empty answer.");
      return { text };
    } catch (err) {
      throw toLLMError(err, "anthropic", model, apiKey, signal, { sensitive });
    }
  },
};

type BaseParams = Omit<Parameters<Anthropic["messages"]["create"]>[0], "stream">;

/**
 * Claude structured output: the native JSON-schema output format; for models that don't support
 * it, a forced tool call whose input must match the same schema. Either way the result is JSON text.
 */
async function structured(client: Anthropic, base: BaseParams, format: ResponseFormat, signal?: AbortSignal): Promise<LLMResponse> {
  try {
    const message = await client.messages.create(
      { ...base, stream: false, output_config: { format: { type: "json_schema", schema: format.schema } } },
      { signal },
    );
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    if (!text) throw new LLMError("empty_response", "Claude returned an empty answer.");
    return { text };
  } catch (err) {
    const status = (err as { status?: number }).status;
    const unsupported = status === 400 && /output_config|output.?format|structured|json_schema/i.test(String((err as Error).message));
    if (!unsupported) throw err;
  }

  const message = await client.messages.create(
    {
      ...base,
      stream: false,
      tools: [{ name: format.name, description: format.description, input_schema: format.schema as Anthropic.Tool.InputSchema }],
      tool_choice: { type: "tool", name: format.name },
    },
    { signal },
  );
  const call = message.content.find((b) => b.type === "tool_use");
  if (!call || call.type !== "tool_use") throw new LLMError("empty_response", "Claude returned an empty answer.");
  return { text: JSON.stringify(call.input) };
}
