// Thin typed client for the app's own API routes.
import type {
  AISettingsDTO,
  AskRequestDTO,
  AskResponseDTO,
  ConversationDTO,
  ConversationSummaryDTO,
  DocumentDTO,
  MessageDTO,
  ProviderId,
  StatsDTO,
} from "./types";
import type { CloudFolderDTO, IntegrationDTO, SyncRunDetailDTO, SyncRunSummaryDTO } from "./integrations";
import { loginUrlFor } from "./auth-routes";
import type { KnowledgeScope, KnowledgeSourceDTO } from "./knowledge-scope";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Let callers tell "user pressed Stop" apart from network failures.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new Error("Could not reach the server.");
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    // Session ended (signed out elsewhere or expired): back to sign-in, then to this page.
    if (res.status === 401 && body && (body as { code?: string }).code === "unauthenticated" && typeof window !== "undefined") {
      window.location.assign(loginUrlFor(`${window.location.pathname}${window.location.search}`));
    }
    // Upload failures return the failed document along with a 422.
    if (res.status === 422 && body && "document" in body) return body;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

const json = (method: string, data: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

export const api = {
  listDocuments: () => request<{ documents: DocumentDTO[] }>("/api/documents").then((r) => r.documents),

  uploadDocument: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ document: DocumentDTO | null }>("/api/documents", { method: "POST", body: form }).then(
      (r) => r.document,
    );
  },

  deleteDocument: (id: string) => request<void>(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" }),

  getAISettings: () => request<AISettingsDTO>("/api/settings/ai"),

  updateAISettings: (update: { activeProvider?: ProviderId; models?: Partial<Record<ProviderId, string | null>> }) =>
    request<AISettingsDTO>("/api/settings/ai", json("PUT", update)),

  listConversations: (q?: string) =>
    request<{ conversations: ConversationSummaryDTO[] }>(
      `/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`,
    ).then((r) => r.conversations),

  getConversation: (id: string) => request<ConversationDTO>(`/api/conversations/${encodeURIComponent(id)}`),

  deleteConversation: (id: string) =>
    request<void>(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Sends a question with optional attachments as multipart/form-data. The server validates every file. */
  ask: (
    body: AskRequestDTO & { files?: File[]; addToKnowledgeBase?: number[] },
    signal?: AbortSignal,
  ) => {
    const form = new FormData();
    form.append("question", body.question);
    if (body.language) form.append("language", body.language);
    if (body.conversationId) form.append("conversationId", body.conversationId);
    if (body.documentIds?.length) form.append("documentIds", JSON.stringify(body.documentIds));
    if (body.knowledgeScope) form.append("knowledgeScope", JSON.stringify(body.knowledgeScope));
    for (const file of body.files ?? []) form.append("files", file, file.name);
    if (body.addToKnowledgeBase?.length) form.append("addToKnowledgeBase", JSON.stringify(body.addToKnowledgeBase));
    return request<AskResponseDTO>("/api/ask", { method: "POST", body: form, signal });
  },

  /** "Chat with" options built from the indexed documents. */
  knowledgeSources: () => request<{ sources: KnowledgeSourceDTO[] }>("/api/knowledge-sources").then((r) => r.sources),

  /** Changes which data a conversation searches (after the user confirms). */
  setConversationScope: (id: string, knowledgeScope: KnowledgeScope) =>
    request<ConversationSummaryDTO>(`/api/conversations/${encodeURIComponent(id)}`, json("PATCH", { knowledgeScope })),

  /** Shows an assistant response in another language, updating that message in place. */
  setMessageLanguage: (id: string, language: string) =>
    request<{ message: MessageDTO }>(`/api/messages/${encodeURIComponent(id)}/language`, json("POST", { language })).then(
      (r) => r.message,
    ),

  // ── Integrations ──
  listIntegrations: () => request<{ integrations: IntegrationDTO[]; runs: SyncRunSummaryDTO[] }>("/api/integrations"),
  updateIntegration: (id: string, patch: { enabled?: boolean; configuration?: Record<string, unknown> }) =>
    request<{ integration: IntegrationDTO }>(`/api/integrations/${encodeURIComponent(id)}`, json("PATCH", patch)).then((r) => r.integration),
  syncIntegration: (id: string) =>
    request<{ run: SyncRunSummaryDTO }>(`/api/integrations/${encodeURIComponent(id)}/sync`, { method: "POST" }).then((r) => r.run),
  integrationRuns: (id: string) =>
    request<{ runs: SyncRunSummaryDTO[] }>(`/api/integrations/${encodeURIComponent(id)}/sync-runs`).then((r) => r.runs),
  syncRunDetail: (id: string, runId: string) =>
    request<{ run: SyncRunDetailDTO }>(`/api/integrations/${encodeURIComponent(id)}/sync-runs/${encodeURIComponent(runId)}`).then((r) => r.run),
  integrationFolders: (id: string, parent?: string) =>
    request<{ parentId: string; folders: CloudFolderDTO[] }>(
      `/api/integrations/${encodeURIComponent(id)}/folders${parent ? `?parent=${encodeURIComponent(parent)}` : ""}`,
    ),
  disconnectIntegration: (id: string) =>
    request<{ integration: IntegrationDTO }>(`/api/integrations/${encodeURIComponent(id)}/disconnect`, { method: "POST" }).then((r) => r.integration),
  testWebsite: (url: string) =>
    request<{ result: { finalUrl: string; title: string; textLength: number; linkCount: number } }>("/api/integrations/website/test", json("POST", { url })).then((r) => r.result),

  suggestions: () => request<{ questions: string[] }>("/api/suggestions").then((r) => r.questions),

  stats: () => request<StatsDTO>("/api/stats"),
};
