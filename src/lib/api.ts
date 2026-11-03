// Thin typed client for the app's own API routes.
import type {
  AISettingsDTO,
  AskRequestDTO,
  AskResponseDTO,
  ClearFailedDocumentsDTO,
  ConversationDTO,
  ConversationSummaryDTO,
  AuditEntryDTO,
  CreatedCustomerDTO,
  CreatedInvitationDTO,
  DeletedCustomerDTO,
  DocumentDTO,
  InvitationDTO,
  MemberDTO,
  OrgRole,
  MessageDTO,
  PlatformOrganizationDetailDTO,
  PlatformOrganizationDTO,
  ProviderId,
  SessionDTO,
  IssuedCredentialsDTO,
  StatsDTO,
  WorkspaceStatus,
} from "./types";
import type { ConsentLanguage } from "./consultation-consent";
import type { ConsultationDetailDTO, ConsultationsOverviewDTO, LanguageHint, NoteDTO, NoteSubmission, TranscriptDTO } from "./consultations";
import type { CloudFolderDTO, IntegrationDTO, SyncRunDetailDTO, SyncRunSummaryDTO } from "./integrations";
import { loginUrlFor, PASSWORD_CHANGE_PATH } from "./auth-routes";
import type { KnowledgeScope, KnowledgeSourceDTO } from "./knowledge-scope";

/** A failed request to the app's own API, with the HTTP status and the stable error code (when the server sent one), so callers can tell what is worth retrying. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init?: RequestInit, options: { keepPage?: boolean } = {}): Promise<T> {
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
    // (Not while a recording is being sent: leaving the page would lose it. The caller shows what to do instead.)
    if (res.status === 401 && body && (body as { code?: string }).code === "unauthenticated" && typeof window !== "undefined" && !options.keepPage) {
      window.location.assign(loginUrlFor(`${window.location.pathname}${window.location.search}`));
    }
    // Still on a temporary password: the server refuses everything else, so go where a new one is chosen.
    if (res.status === 403 && body && (body as { code?: string }).code === "password_change_required" && typeof window !== "undefined") {
      window.location.assign(PASSWORD_CHANGE_PATH);
    }
    // Upload failures return the failed document along with a 422.
    if (res.status === 422 && body && "document" in body) return body;
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status, (body as { code?: string } | null)?.code);
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

  /** Removes every failed document on the server (the server decides which rows are failed). */
  clearFailedDocuments: () => request<ClearFailedDocumentsDTO>("/api/documents/failed", { method: "DELETE" }),

  // ── Accounts, workspaces and team ──

  me: () => request<SessionDTO>("/api/auth/me"),

  /** Chooses a new password (the one thing allowed while a temporary password is still in use). */
  changePassword: (input: { currentPassword: string; newPassword: string }) => request<{ changed: true; redirect: string }>("/api/auth/change-password", json("POST", input)),

  switchWorkspace: (orgId: string) => request<SessionDTO>("/api/auth/switch-org", json("POST", { orgId })),

  listMembers: () => request<{ members: MemberDTO[] }>("/api/org/members").then((r) => r.members),

  changeMemberRole: (userId: string, role: OrgRole) =>
    request<{ members: MemberDTO[] }>(`/api/org/members/${encodeURIComponent(userId)}`, json("PATCH", { role })).then((r) => r.members),

  removeMember: (userId: string) =>
    request<{ members: MemberDTO[] }>(`/api/org/members/${encodeURIComponent(userId)}`, { method: "DELETE" }).then((r) => r.members),

  listInvitations: () => request<{ invitations: InvitationDTO[] }>("/api/org/invitations").then((r) => r.invitations),

  createInvitation: (email: string, role: Exclude<OrgRole, "owner">) => request<CreatedInvitationDTO>("/api/org/invitations", json("POST", { email, role })),

  revokeInvitation: (id: string) => request<void>(`/api/org/invitations/${encodeURIComponent(id)}`, { method: "DELETE" }),

  peekInvitation: (token: string) =>
    request<{ organization: string; email: string; role: string; hasAccount: boolean }>(`/api/auth/accept-invite?token=${encodeURIComponent(token)}`),

  acceptInvitation: (input: { token: string; password?: string; name?: string }) =>
    request<{ redirect: string; organization: string }>("/api/auth/accept-invite", json("POST", input)),

  // ── Super Admin console (platform administrators only; the server enforces it) ──

  platformListOrganizations: () => request<{ organizations: PlatformOrganizationDTO[] }>("/api/platform/organizations").then((r) => r.organizations),

  /** `requestId` is chosen once per customer by the form, so a retry of the same request creates nothing new. */
  platformCreateCustomer: (input: { name: string; adminEmail: string; reference?: string; requestId: string }) =>
    request<CreatedCustomerDTO>(
      "/api/platform/organizations",
      json("POST", { name: input.name, adminEmail: input.adminEmail, requestId: input.requestId, ...(input.reference?.trim() ? { reference: input.reference.trim() } : {}) }),
    ),

  platformGetOrganization: (id: string) => request<PlatformOrganizationDetailDTO>(`/api/platform/organizations/${encodeURIComponent(id)}`),

  platformSetOrganizationStatus: (id: string, status: WorkspaceStatus) =>
    request<{ organization: PlatformOrganizationDTO }>(`/api/platform/organizations/${encodeURIComponent(id)}`, json("PATCH", { status })).then((r) => r.organization),

  /** Permanently deletes a customer. `confirmName` must repeat the workspace's name (the server checks it). */
  platformDeleteOrganization: (id: string, confirmName: string) =>
    request<{ deleted: DeletedCustomerDTO }>(`/api/platform/organizations/${encodeURIComponent(id)}`, json("DELETE", { confirmName })).then((r) => r.deleted),

  platformAddCustomerAdmin: (id: string, email: string) =>
    request<{ credentials: IssuedCredentialsDTO }>(`/api/platform/organizations/${encodeURIComponent(id)}/admins`, json("POST", { email })).then((r) => r.credentials),

  platformReissueCredentials: (orgId: string, userId: string) =>
    request<{ credentials: IssuedCredentialsDTO }>(
      `/api/platform/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}/credentials`,
      json("POST", { action: "reissue" }),
    ).then((r) => r.credentials),

  platformRevokeCredentials: (orgId: string, userId: string) =>
    request<{ revoked: true; loginId: string }>(
      `/api/platform/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}/credentials`,
      json("POST", { action: "revoke" }),
    ),

  platformRevokeInvitation: (id: string, invitationId: string) =>
    request<void>(`/api/platform/organizations/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE" }),

  platformSetUserStatus: (userId: string, status: "active" | "disabled") =>
    request<{ user: { userId: string; email: string; status: "active" | "disabled" } }>(`/api/platform/users/${encodeURIComponent(userId)}`, json("PATCH", { status })).then((r) => r.user),

  platformAuditLog: (options: { limit?: number; before?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.limit) query.set("limit", String(options.limit));
    if (options.before) query.set("before", String(options.before));
    return request<{ entries: AuditEntryDTO[] }>(`/api/platform/audit?${query}`).then((r) => r.entries);
  },

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

  // ── Voice ──
  /** Which voice features are available to this workspace. */
  voiceSettings: () => request<{ tts: { enabled: boolean; maxChars: number }; stt: { enabled: boolean } }>("/api/voice"),

  /** Answer text → audio (only when the user clicks Listen). */
  speech: async (text: string, language: string, signal?: AbortSignal): Promise<Blob> => {
    const res = await fetch("/api/tts", { ...json("POST", { text, language }), signal }).catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new Error("Speech playback is temporarily unavailable. Check your connection.");
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      if (res.status === 401 && body?.code === "unauthenticated") window.location.assign(loginUrlFor(`${window.location.pathname}${window.location.search}`));
      throw new Error(body?.error ?? "Speech playback is temporarily unavailable.");
    }
    return res.blob();
  },

  /** Recorded speech → text for the chat box (never sends the question). */
  transcribe: (audio: Blob, language: string) => {
    const form = new FormData();
    form.append("audio", new File([audio], "voice-question", { type: audio.type }));
    form.append("language", language);
    return request<{ text: string }>("/api/stt", { method: "POST", body: form }).then((r) => r.text);
  },

  /** "Chat with" options built from the indexed documents. */
  knowledgeSources: () => request<{ sources: KnowledgeSourceDTO[] }>("/api/knowledge-sources").then((r) => r.sources),

  /** Changes which data a conversation searches (after the user confirms). */
  setConversationScope: (id: string, knowledgeScope: KnowledgeScope) =>
    request<ConversationSummaryDTO>(`/api/conversations/${encodeURIComponent(id)}`, json("PATCH", { knowledgeScope })),

  /**
   * Shows an assistant response in another language, updating that message in place. `signal` abandons the request (the
   * server then stops the translation too), for example when another language is chosen before this one is ready.
   */
  setMessageLanguage: (id: string, language: string, signal?: AbortSignal) =>
    request<{ message: MessageDTO }>(`/api/messages/${encodeURIComponent(id)}/language`, { ...json("POST", { language }), signal }).then(
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

  // ── Doctor consultations (Doctor role only; the server enforces it, and every call is scoped to the signed-in doctor) ──

  consultations: () => request<ConsultationsOverviewDTO>("/api/consultations"),

  createConsultation: (input: {
    patientLabel: string;
    languageHint: LanguageHint;
    consent: { version: string; language: ConsentLanguage; givenBy: string; method: string; confirmed: true };
  }) => request<{ consultation: ConsultationDetailDTO }>("/api/consultations", json("POST", input)).then((r) => r.consultation),

  consultation: (id: string) => request<{ consultation: ConsultationDetailDTO }>(`/api/consultations/${encodeURIComponent(id)}`).then((r) => r.consultation),

  deleteConsultation: (id: string) => request<void>(`/api/consultations/${encodeURIComponent(id)}`, json("DELETE", { confirm: true })),

  startRecordingUpload: (id: string, mimeType: string) =>
    request<{ recordingId: string; partBytes: number; receivedParts: number[] }>(`/api/consultations/${encodeURIComponent(id)}/recording`, json("POST", { mimeType }), { keepPage: true }),

  uploadRecordingPart: (id: string, number: number, bytes: Blob, signal?: AbortSignal) =>
    request<{ received: number }>(`/api/consultations/${encodeURIComponent(id)}/recording/parts/${number}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: bytes, signal }, { keepPage: true }),

  completeRecording: (id: string, info: { totalBytes: number; partCount: number; durationMs: number; sha256: string }) =>
    request<{ consultation: ConsultationDetailDTO }>(`/api/consultations/${encodeURIComponent(id)}/recording/complete`, json("POST", info), { keepPage: true }).then((r) => r.consultation),

  deleteRecordingAudio: (id: string) => request<void>(`/api/consultations/${encodeURIComponent(id)}/recording`, { method: "DELETE" }),

  consultationTranscript: (id: string) => request<TranscriptDTO>(`/api/consultations/${encodeURIComponent(id)}/transcript`),

  consultationNote: (id: string) => request<NoteDTO>(`/api/consultations/${encodeURIComponent(id)}/note`),

  saveConsultationNote: (id: string, baseVersion: number, note: NoteSubmission) =>
    request<{ version: number }>(`/api/consultations/${encodeURIComponent(id)}/note`, json("PUT", { baseVersion, note })).then((r) => r.version),

  approveConsultationNote: (id: string, version: number) =>
    request<{ approved: true; version: number }>(`/api/consultations/${encodeURIComponent(id)}/note/approve`, json("POST", { version, confirm: true })),

  reopenConsultationNote: (id: string) => request<{ version: number }>(`/api/consultations/${encodeURIComponent(id)}/note/reopen`, { method: "POST" }).then((r) => r.version),

  retryConsultation: (id: string) => request<{ consultation: ConsultationDetailDTO }>(`/api/consultations/${encodeURIComponent(id)}/retry`, { method: "POST" }).then((r) => r.consultation),

  /** Where the player loads the doctor's own recording from (an authenticated, never-cached route). */
  consultationAudioUrl: (id: string) => `/api/consultations/${encodeURIComponent(id)}/audio`,
};
