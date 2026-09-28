import "server-only";
import { getLanguage } from "@/lib/languages";
import { parseKnowledgeScope, type KnowledgeScope } from "@/lib/knowledge-scope";
import type { AskResponseDTO, AttachmentDTO, CitationDTO } from "@/lib/types";
import type { ConversationRepository, DocumentRepository } from "../db/repositories";
import { toMessageDTO } from "../dto";
import type { IngestResult } from "../knowledge/ingest";
import { scopeDocumentIds, searchableDocuments } from "../knowledge/scope";
import type { ProviderConfigService } from "../llm/resolve";
import { answerQuestion, AnswerInputError, type AnswerDeps } from "./answer";
import { defaultQuestion, EMPTY_ATTACHMENTS, type PreparedAttachments } from "./attachments";

export interface ChatDeps extends Omit<AnswerDeps, "providerConfig"> {
  providerConfig: Pick<ProviderConfigService, "resolve" | "activeProvider">;
  conversations: ConversationRepository;
  /** Resolves "Chat with" scopes to documents and adds source details to citations. */
  documents?: Pick<DocumentRepository, "list" | "get">;
  /** Permanently indexes a file into the knowledge base (only for attachments the user opted in). */
  addToKnowledgeBase?: (file: { filename: string; buffer: Buffer }) => Promise<IngestResult>;
}

export interface ChatInput {
  question: string;
  conversationId?: string;
  documentIds?: string[];
  /** "Chat with": which data to search. Stored with the conversation; defaults to the conversation's own scope. */
  knowledgeScope?: KnowledgeScope;
  attachments?: PreparedAttachments;
  /** False when the Knowledge Base feature is disabled. */
  useKnowledgeBase?: boolean;
  /** Answer language code. */
  language?: string;
  signal?: AbortSignal;
}

export class ConversationNotFoundError extends Error {}

const TITLE_MAX = 80;

function titleFrom(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * Answers a question with the active provider and records the exchange in a conversation.
 * Nothing is saved if answering fails, so a failed attempt can simply be retried.
 */
export async function askInConversation(deps: ChatDeps, input: ChatInput): Promise<AskResponseDTO> {
  const conversation = input.conversationId ? deps.conversations.get(input.conversationId) : undefined;
  if (input.conversationId && !conversation) {
    throw new ConversationNotFoundError("Conversation not found. It may have been deleted.");
  }

  // The scope of this question: the one sent, else the conversation's stored one. It decides the
  // documents searched, resolved now so newly synced pages are included.
  const storedScope = conversation?.knowledge_scope_json ? parseKnowledgeScope(JSON.parse(conversation.knowledge_scope_json)) : null;
  const scope = input.knowledgeScope ?? storedScope;
  const documentIds =
    scope && deps.documents ? scopeDocumentIds(searchableDocuments(deps.documents.list(), deps.embedder.modelId), scope) : input.documentIds;

  const attachments = input.attachments ?? EMPTY_ATTACHMENTS;
  const hasAttachments = attachments.meta.length > 0;
  const question = input.question.trim() || (hasAttachments ? defaultQuestion(attachments) : "");
  if (!question) throw new AnswerInputError("Type a question or attach a file.");

  const provider = deps.providerConfig.activeProvider();
  const result = await answerQuestion(deps, {
    question,
    provider,
    documentIds,
    attachments,
    useKnowledgeBase: input.useKnowledgeBase,
    language: input.language,
    signal: input.signal,
  });

  // Only after a successful answer: add the documents the user explicitly opted in to the knowledge base.
  const meta: AttachmentDTO[] = attachments.meta.map((m) => ({ ...m }));
  for (const doc of attachments.documents) {
    if (!doc.addToKnowledgeBase || !deps.addToKnowledgeBase) continue;
    const entry = meta.find((m) => m.name === doc.name && m.kind === "document");
    const ingest = await deps.addToKnowledgeBase({ filename: doc.name, buffer: doc.buffer });
    if (entry) {
      entry.knowledgeBaseDocumentId = ingest.status === "ready" ? ingest.documentId : null;
      entry.knowledgeBaseError = ingest.status === "ready" ? null : ingest.error;
    }
  }

  const conversationId = input.conversationId ?? deps.conversations.create(titleFrom(question), input.knowledgeScope);
  if (input.conversationId && input.knowledgeScope && JSON.stringify(input.knowledgeScope) !== JSON.stringify(storedScope)) {
    deps.conversations.setKnowledgeScope(input.conversationId, input.knowledgeScope);
  }
  const [userRow, assistantRow] = deps.conversations.addMessages(conversationId, [
    { role: "user", content: question, attachments: meta },
    {
      role: "assistant",
      content: result.answer,
      citations: withSourceDetails(deps, result.citations),
      structured: result.structured,
      language: result.structured?.language ?? getLanguage(input.language).code,
      context: result.context,
      provider: result.provider,
      model: result.model,
      noContext: result.noContext,
    },
  ]);

  return { conversationId, userMessage: toMessageDTO(userRow!), assistantMessage: toMessageDTO(assistantRow!) };
}

/** Knowledge-base citations also carry where their document came from (website URL, Google Drive…). */
function withSourceDetails(deps: ChatDeps, citations: CitationDTO[]): CitationDTO[] {
  const documents = deps.documents;
  if (!documents) return citations;
  return citations.map((c) => {
    if (c.source === "attachment" || !c.documentId) return c;
    const doc = documents.get(c.documentId);
    if (!doc) return c;
    const sourceType = doc.source_type === "website" || doc.source_type === "google_drive" || doc.source_type === "onedrive" ? doc.source_type : "upload";
    return { ...c, sourceType, sourceUrl: doc.source_url };
  });
}

export { AnswerInputError };
