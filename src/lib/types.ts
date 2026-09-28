// DTOs shared between the browser and the API. Nothing here may carry secrets.
import type { AIResponse } from "./ai-response";
import type { KnowledgeScope } from "./knowledge-scope";

export const PROVIDER_IDS = ["openai", "anthropic", "gemini"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
  gemini: "Google Gemini",
};

/** The .env variables each provider reads. Shown in the UI so users know where to put keys. */
export const PROVIDER_ENV_VARS: Record<ProviderId, { apiKey: string; model: string }> = {
  openai: { apiKey: "OPENAI_API_KEY", model: "OPENAI_MODEL" },
  anthropic: { apiKey: "ANTHROPIC_API_KEY", model: "ANTHROPIC_MODEL" },
  gemini: { apiKey: "GEMINI_API_KEY", model: "GEMINI_MODEL" },
};

export type DocumentStatus = "processing" | "ready" | "failed";

export interface DocumentDTO {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  pageCount: number | null;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  /** False when the document was indexed with a different embedding model than the current one. */
  indexCurrent: boolean;
  /** Where the document came from; null = uploaded directly. */
  source: { type: "website" | "google_drive" | "onedrive"; url: string | null; integrationId: string | null } | null;
  createdAt: string;
}

export type ValueSource = "ui" | "env" | "none";

export interface ProviderStatusDTO {
  provider: ProviderId;
  label: string;
  /** API keys come only from .env; the browser only learns whether one is set. */
  key: { configured: boolean; last4: string | null; envVar: string };
  model: { value: string | null; source: ValueSource; envValue: string | null; envVar: string };
  /** Best-effort: whether the configured model accepts image input (see lib/capabilities.ts). */
  capabilities: { imageInput: boolean };
  ready: boolean;
}

export interface AISettingsDTO {
  activeProvider: ProviderId;
  providers: ProviderStatusDTO[];
}

export interface CitationDTO {
  /** The [n] marker used in the answer text. */
  index: number;
  /** Where the passage came from. Missing on messages saved before attachments existed = knowledge base. */
  source?: "knowledge_base" | "attachment";
  /** Knowledge-base document ID; null for temporary chat attachments. */
  documentId: string | null;
  filename: string;
  pageStart: number | null;
  pageEnd: number | null;
  excerpt: string;
  /** Knowledge-base passages: where the document came from (upload when missing). */
  sourceType?: "upload" | "website" | "google_drive" | "onedrive";
  /** Web page URL for website sources. */
  sourceUrl?: string | null;
  /** Similarity to the question; null when a small attachment was included in full. */
  score: number | null;
  /** Whether the model actually referenced this source in its answer. */
  cited: boolean;
}

/** Metadata about a file attached to a chat message. File contents are never stored. */
export interface AttachmentDTO {
  name: string;
  kind: "document" | "image";
  mediaType: string;
  sizeBytes: number;
  /** Set when the user chose "Add to Knowledge Base" and ingestion succeeded. */
  knowledgeBaseDocumentId?: string | null;
  /** Set when "Add to Knowledge Base" was requested but failed. */
  knowledgeBaseError?: string | null;
}

export interface MessageDTO {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: CitationDTO[];
  attachments: AttachmentDTO[];
  /** Structured (sectioned) answer for assistant messages; null = render `content` as text. */
  structured: AIResponse | null;
  /** Assistant messages: the language this response is currently shown in (changeable per response). */
  language: string;
  provider: ProviderId | null;
  model: string | null;
  noContext: boolean;
  createdAt: string;
}

export interface ConversationSummaryDTO {
  id: string;
  title: string;
  /** "Chat with" scope; null = All Knowledge Base (also for chats created before scopes existed). */
  knowledgeScope: KnowledgeScope | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDTO extends ConversationSummaryDTO {
  messages: MessageDTO[];
}

export interface AskRequestDTO {
  question: string;
  /** Answer language code (lib/languages.ts). */
  language?: string;
  /** Omit to start a new conversation. */
  conversationId?: string;
  documentIds?: string[];
  /** Which data to search ("Chat with"); stored with the conversation. */
  knowledgeScope?: KnowledgeScope;
}

export interface AskResponseDTO {
  conversationId: string;
  userMessage: MessageDTO;
  assistantMessage: MessageDTO;
}

export interface StatsDTO {
  documents: { total: number; ready: number; failed: number; chunks: number; bytes: number };
  conversations: number;
  questions: number;
  activeProvider: ProviderId;
  activeProviderReady: boolean;
  activeModel: string | null;
  embeddingModel: string;
}

export interface ApiErrorDTO {
  error: string;
}
