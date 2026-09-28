import type { ProviderId } from "@/lib/types";

/**
 * Provider-neutral message content. Each adapter converts these parts into its own API format.
 * Documents are not a part type: the RAG layer turns them into numbered text sources, which works
 * the same for every provider and keeps citations possible.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp"; data: Buffer; name: string };

/** Everything a provider needs for one completion. It knows nothing about documents. */
export interface LLMRequest {
  system: string;
  /** The user turn, in order. Adapters send images before text, as the providers recommend. */
  content: ContentPart[];
  model: string;
  apiKey: string;
  /** Aborts the provider call (e.g. the user pressed Stop). */
  signal?: AbortSignal;
  /**
   * Ask for JSON matching this schema, using the provider's native structured-output feature.
   * The response text is then that JSON. The caller still validates it (never trusted as-is).
   */
  responseFormat?: ResponseFormat;
}

export interface ResponseFormat {
  /** Identifier (letters, digits, underscores). */
  name: string;
  description: string;
  /** JSON Schema: object at the root, every property required, additionalProperties false. */
  schema: Record<string, unknown>;
}

export interface LLMResponse {
  text: string;
}

export interface LLMProvider {
  readonly id: ProviderId;
  generate(request: LLMRequest): Promise<LLMResponse>;
}

export type LLMErrorKind =
  | "auth"
  | "model_not_found"
  | "rate_limit"
  | "timeout"
  | "cancelled"
  | "image_unsupported"
  | "bad_request"
  | "unavailable"
  | "empty_response"
  | "unknown";

/** Provider failure with a message that is safe to show the user (never contains the key). */
export class LLMError extends Error {
  constructor(
    readonly kind: LLMErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export const LLM_TIMEOUT_MS = 90_000;

/** Convenience for single-text requests (e.g. suggested questions). */
export const textContent = (text: string): ContentPart[] => [{ type: "text", text }];

/** Images first, then text, preserving order within each group. */
export function orderedParts(content: ContentPart[]): ContentPart[] {
  return [...content.filter((p) => p.type === "image"), ...content.filter((p) => p.type === "text")];
}
