import "server-only";
import { buildSources, type AIResponse } from "@/lib/ai-response";
import { getLanguage } from "@/lib/languages";
import type { CitationDTO, MessageDTO, ProviderId } from "@/lib/types";
import type { AnswerVariant, ConversationRepository, MessageRow } from "../db/repositories";
import { toMessageDTO } from "../dto";
import type { ProviderConfigService } from "../llm/resolve";
import type { LLMProvider } from "../llm/types";
import { generateGroundedAnswer, KNOWLEDGE_BASE_DISABLED_ANSWER, requireProviderAuth, type AnswerContext } from "./answer";
import type { SourceChunk } from "./citations";

export interface AnswerLanguageDeps {
  conversations: ConversationRepository;
  providerConfig: Pick<ProviderConfigService, "resolve" | "activeProvider">;
  getProvider: (id: ProviderId) => LLMProvider;
}

export class MessageNotFoundError extends Error {}

function parse<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * The grounding for an answer. Messages saved before snapshots existed fall back to their stored
 * citation excerpts (shorter, but still the same passages) and the preceding user question.
 */
function contextOf(deps: AnswerLanguageDeps, row: MessageRow, citations: CitationDTO[]): AnswerContext {
  const saved = parse<AnswerContext>(row.context_json);
  if (saved?.question && Array.isArray(saved.sources)) return saved;
  const sources: SourceChunk[] = citations.map((c) => ({
    source: c.source ?? "knowledge_base",
    documentId: c.documentId,
    filename: c.filename,
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
    content: c.excerpt,
    score: c.score,
  }));
  return { question: deps.conversations.questionFor(row)?.content ?? "", sources, imageNames: [] };
}

/**
 * Shows an assistant answer in another language, updating the SAME message in place.
 * - No new retrieval: the answer is re-generated from the exact passages it was grounded in,
 *   using the current answer as the reference (same sections, facts and source numbers).
 * - Citations and sources never change; only the answer text does.
 * - Each language version is saved, so switching back is instant and costs nothing.
 */
export async function setAnswerLanguage(
  deps: AnswerLanguageDeps,
  messageId: string,
  languageCode: string,
  signal?: AbortSignal,
): Promise<MessageDTO> {
  const row = deps.conversations.getMessage(messageId);
  if (!row || row.role !== "assistant") throw new MessageNotFoundError("Message not found.");

  const target = getLanguage(languageCode);
  const current = toMessageDTO(row);
  if (current.language === target.code) return current;

  const variants = parse<Record<string, AnswerVariant>>(row.variants_json) ?? {};
  // Keep the version being replaced (messages saved before variants existed have none yet).
  variants[current.language] ??= { content: row.content, structured: current.structured, provider: row.provider, model: row.model };

  let variant = variants[target.code];
  if (!variant) {
    variant = await generateVariant(deps, row, current, target.code, signal);
    variants[target.code] = variant;
  }
  return toMessageDTO(deps.conversations.setAnswerLanguage(messageId, target.code, variant, variants));
}

async function generateVariant(
  deps: AnswerLanguageDeps,
  row: MessageRow,
  current: MessageDTO,
  languageCode: string,
  signal?: AbortSignal,
): Promise<AnswerVariant> {
  const language = getLanguage(languageCode);

  // Answers where nothing was found (no model call was made) have a fixed message per language.
  if (row.no_context === 1) {
    const content = row.content === KNOWLEDGE_BASE_DISABLED_ANSWER ? KNOWLEDGE_BASE_DISABLED_ANSWER : language.notFound;
    const structured: AIResponse = { found: false, summary: content, sections: [], sources: [], language: language.code };
    return { content, structured, provider: row.provider, model: row.model };
  }

  const context = contextOf(deps, row, current.citations);
  const providerId = deps.providerConfig.activeProvider();
  const auth = requireProviderAuth(deps, providerId);
  const reference = current.structured
    ? JSON.stringify({ title: current.structured.title, summary: current.structured.summary, sections: current.structured.sections })
    : current.content;

  const generated = await generateGroundedAnswer(deps.getProvider(providerId), auth, {
    question: context.question,
    sources: context.sources,
    imageNames: context.imageNames,
    language,
    reference,
    signal,
  });

  // Sources stay exactly as they were: only the text is in the new language.
  const structured = generated.structured
    ? { ...generated.structured, sources: generated.structured.found ? buildSources(current.citations) : [] }
    : null;
  return { content: generated.answer, structured, provider: providerId, model: auth.model };
}
