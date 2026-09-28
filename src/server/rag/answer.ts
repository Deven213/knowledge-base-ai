import "server-only";
import { IMAGE_UNSUPPORTED_MESSAGE, supportsImageInput } from "@/lib/capabilities";
import { PROVIDER_ENV_VARS, PROVIDER_LABELS, type CitationDTO, type ProviderId } from "@/lib/types";
import type { Embedder } from "../knowledge/embedder";
import { retrieveContext } from "../knowledge/retrieve";
import type { VectorStore } from "../knowledge/vector-store";
import type { ProviderConfigService } from "../llm/resolve";
import type { ContentPart, LLMProvider } from "../llm/types";
import { EMPTY_ATTACHMENTS, selectAttachmentSources, type PreparedAttachments } from "./attachments";
import type { AIResponse } from "@/lib/ai-response";
import { getLanguage, type AnswerLanguage } from "@/lib/languages";
import { buildCitations, fromSearchHit, type SourceChunk } from "./citations";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import { needsEnglishSearchQuery, toEnglishSearchQuery } from "./query-translation";
import {
  buildSources,
  finalizeAnswer,
  normalizeModelAnswer,
  parseModelJson,
  RESPONSE_FORMAT,
  structuredToText,
} from "./structured";

export interface AnswerDeps {
  embedder: Embedder;
  vectorStore: VectorStore;
  providerConfig: Pick<ProviderConfigService, "resolve">;
  getProvider: (id: ProviderId) => LLMProvider;
  retrieval: { topK: number; minScore: number };
}

export interface AnswerInput {
  question: string;
  provider: ProviderId;
  documentIds?: string[];
  /** Files attached to this message (temporary; not part of the knowledge base). */
  attachments?: PreparedAttachments;
  /** False when the Knowledge Base feature is disabled: no document retrieval (default true). */
  useKnowledgeBase?: boolean;
  /** Answer language code (lib/languages.ts); default English. Does not affect retrieval. */
  language?: string;
  signal?: AbortSignal;
}

export interface AnswerResult {
  answer: string;
  citations: CitationDTO[];
  provider: ProviderId;
  model: string;
  /** True when retrieval found nothing relevant and the LLM was not called. */
  noContext: boolean;
  /** Validated structured answer; null when the model's output couldn't be structured (plain-text fallback). */
  structured: AIResponse | null;
  /** Exactly what the answer was grounded in, so it can be re-generated in another language without searching again. */
  context: AnswerContext;
}

/** Snapshot of an answer's grounding: the question and the numbered sources, in prompt order. */
export interface AnswerContext {
  question: string;
  sources: SourceChunk[];
  imageNames: string[];
}

/** A request problem the user can fix (HTTP 400), as opposed to a server fault. */
export class AnswerInputError extends Error {}

export const KNOWLEDGE_BASE_DISABLED_ANSWER =
  "The Knowledge Base is currently disabled by the administrator, so I can't search your documents. You can still attach files or images to a message and ask about them.";

export const NO_CONTEXT_ANSWER = getLanguage("en").notFound;

/**
 * The only place the knowledge layer and the LLM layer meet:
 *   knowledge-base retrieval (unchanged) + temporary attachment passages + attached images
 *   → one provider-neutral request → the selected provider → answer with citations.
 */
export async function answerQuestion(deps: AnswerDeps, input: AnswerInput): Promise<AnswerResult> {
  const resolved = requireProviderAuth(deps, input.provider);

  const { images, documents } = input.attachments ?? EMPTY_ATTACHMENTS;
  if (images.length > 0 && !supportsImageInput(input.provider, resolved.model)) {
    throw new AnswerInputError(IMAGE_UNSUPPORTED_MESSAGE);
  }

  const language = getLanguage(input.language);
  const provider = deps.getProvider(input.provider);
  const useKnowledgeBase = input.useKnowledgeBase ?? true;

  // The embedding model is English-only: a question in another script gets an English search query
  // for retrieval. The answer still uses the original question and the selected language.
  const searchQuery =
    (useKnowledgeBase || documents.length > 0) && needsEnglishSearchQuery(input.question)
      ? await toEnglishSearchQuery(provider, { model: resolved.model, apiKey: resolved.apiKey, signal: input.signal }, input.question)
      : input.question;

  // 1. Knowledge base: exactly the existing retrieval (embedding → vector search → top-K above threshold).
  // An explicit empty document list (a chat source with no indexed documents) searches nothing.
  const hits =
    useKnowledgeBase && !(input.documentIds && input.documentIds.length === 0)
      ? await retrieveContext(deps, searchQuery, { ...deps.retrieval, documentIds: input.documentIds })
      : [];
  // 2. Temporary attachments: full text if small, otherwise their most relevant chunks (in memory only).
  const attachmentSources = documents.length ? await selectAttachmentSources(deps.embedder, searchQuery, documents) : [];

  // Nothing to answer from: reply directly instead of letting the model guess (and spending tokens).
  if (hits.length === 0 && attachmentSources.length === 0 && images.length === 0) {
    const answer = !useKnowledgeBase ? KNOWLEDGE_BASE_DISABLED_ANSWER : language.code === "en" ? NO_CONTEXT_ANSWER : language.notFound;
    return {
      answer,
      citations: [],
      provider: input.provider,
      model: resolved.model,
      noContext: true,
      structured: { found: false, summary: answer, sections: [], sources: [], language: language.code },
      context: { question: input.question, sources: [], imageNames: [] },
    };
  }

  const sources: SourceChunk[] = [...attachmentSources, ...hits.map(fromSearchHit)];
  const generated = await generateGroundedAnswer(provider, { model: resolved.model, apiKey: resolved.apiKey }, {
    question: input.question,
    sources,
    images: images.map((img): ContentPart => ({ type: "image", mediaType: img.mediaType, data: img.data, name: img.name })),
    imageNames: images.map((i) => i.name),
    language,
    signal: input.signal,
  });
  return {
    ...generated,
    provider: input.provider,
    model: resolved.model,
    noContext: false,
    context: { question: input.question, sources, imageNames: images.map((i) => i.name) },
  };
}

export interface GenerateInput {
  question: string;
  /** The numbered sources, in the order they are cited ([1] = sources[0]). */
  sources: SourceChunk[];
  images?: ContentPart[];
  imageNames?: string[];
  language: AnswerLanguage;
  /**
   * An existing answer to re-express in `language` (same sections, facts and source numbers).
   * Used when a response's language is changed, so the answer stays the same apart from language.
   */
  reference?: string;
  signal?: AbortSignal;
}

/**
 * Steps 3–4 of answering, shared by new answers and language changes (no retrieval here):
 * structured answer via the provider's JSON-schema output, then validation and normalization.
 * If the output can't be structured, the text is returned as a plain answer.
 */
export async function generateGroundedAnswer(
  provider: LLMProvider,
  auth: { model: string; apiKey: string },
  input: GenerateInput,
): Promise<{ answer: string; citations: CitationDTO[]; structured: AIResponse | null }> {
  let prompt = buildUserPrompt(input.question, input.sources, input.imageNames ?? []);
  if (input.reference) {
    prompt += `

<reference_answer>
${input.reference}
</reference_answer>
Rewrite the reference answer in ${input.language.promptName}. Keep the same sections (translate their titles and tabs), the same section kinds and callout types, the same facts and the same source numbers. Use only the sources above: do not add anything that isn't in them, and if the reference says something the sources don't support, leave it out.`;
  }

  const { text } = await provider.generate({
    system: buildSystemPrompt({ structured: true, languageName: input.language.promptName }),
    content: [...(input.images ?? []), { type: "text", text: prompt }],
    model: auth.model,
    apiKey: auth.apiKey,
    signal: input.signal,
    responseFormat: RESPONSE_FORMAT,
  });

  const draft = normalizeModelAnswer(parseModelJson(text), input.sources.length, input.language.notFound);
  if (!draft) return { answer: text, citations: buildCitations(text, input.sources), structured: null };
  const plain = structuredToText(draft);
  const citations = buildCitations(plain, input.sources);
  const structured = finalizeAnswer({ ...draft, sources: draft.found ? buildSources(citations) : [], language: input.language.code });
  return { answer: plain, citations, structured };
}

/** Resolves the provider's key and model, or throws a user-fixable error. */
export function requireProviderAuth(deps: Pick<AnswerDeps, "providerConfig">, provider: ProviderId): { model: string; apiKey: string } {
  const resolved = deps.providerConfig.resolve(provider);
  const label = PROVIDER_LABELS[provider];
  if (!resolved.apiKey) {
    throw new AnswerInputError(`${label} has no API key. Add ${PROVIDER_ENV_VARS[provider].apiKey} to the .env file and restart the server.`);
  }
  if (!resolved.model) {
    throw new AnswerInputError(`${label} has no model configured. Set one in AI Model Settings or ${PROVIDER_ENV_VARS[provider].model} in .env.`);
  }
  return { model: resolved.model, apiKey: resolved.apiKey };
}
