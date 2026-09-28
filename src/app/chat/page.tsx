"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, FileUp, Info, LayoutDashboard, Menu, MessageCircle, Sparkles, Upload, X } from "lucide-react";
import { BackButton } from "@/components/BackButton";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { useFeatures } from "@/components/features/FeatureProvider";
import { Composer, useAttachments } from "@/components/chat/Composer";
import { describeSource, KnowledgeSourcePicker, SourceIcon } from "@/components/chat/KnowledgeSourcePicker";
import { AssistantBubble, FailedAssistantBubble, PendingAssistantBubble, UserBubble } from "@/components/chat/MessageBubble";
import { APP_NAME } from "@/components/Logo";
import { Alert, Modal, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { ALL_SCOPE, scopeKey, sourceCountLabel, type KnowledgeScope, type KnowledgeSourceDTO } from "@/lib/knowledge-scope";
import { DEFAULT_LANGUAGE, LANGUAGE_CODES } from "@/lib/languages";
import type { AISettingsDTO, AttachmentDTO, ConversationSummaryDTO, MessageDTO } from "@/lib/types";

/** A question whose answer failed: shown once, as the question plus ONE failed response with Try again. */
interface FailedMessage {
  question: string;
  createdAt: string;
  attachments: AttachmentDTO[];
  error: string;
}

interface PendingMessage {
  question: string;
  createdAt: string;
  attachments: AttachmentDTO[];
  previews: Record<string, string>;
}

const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

const LANGUAGE_PREF = "kb.language";

/**
 * `/chat?source=…` (from an integration page, the sidebar or Documents): "all", "website",
 * "website:<host>", "google_drive", "onedrive" or "document:<id>". Returns the matching source.
 */
function sourceFromHint(hint: string, sources: KnowledgeSourceDTO[]): KnowledgeSourceDTO | undefined {
  const [type, value] = [hint.split(":")[0], hint.slice(hint.indexOf(":") + 1)];
  const hasValue = hint.includes(":");
  return sources
    .filter((s) => s.scope.type === type)
    .filter((s) => {
      if (!hasValue) return true;
      if (s.scope.type === "website") return s.scope.host === value.toLowerCase().replace(/^www\./, "");
      if (s.scope.type === "document") return s.scope.documentId === value;
      return true;
    })
    .sort((a, b) => b.count - a.count)[0];
}

const HINT_NAMES: Record<string, string> = { website: "This website", google_drive: "Google Drive", onedrive: "OneDrive", document: "This document" };

export default function ChatPage() {
  /** "Chat with" options (null until loaded) and the current conversation's source. */
  const [sources, setSources] = useState<KnowledgeSourceDTO[] | null>(null);
  const [scope, setScope] = useState<KnowledgeScope>(ALL_SCOPE);
  const [scopeChange, setScopeChange] = useState<KnowledgeScope | null>(null);
  const [changingScope, setChangingScope] = useState(false);
  const hintApplied = useRef(false);
  const [ai, setAi] = useState<AISettingsDTO | null>(null);
  const [conversations, setConversations] = useState<ConversationSummaryDTO[]>([]);
  const [search, setSearch] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [failed, setFailed] = useState<FailedMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Session-only image thumbnails for sent messages (images themselves are never stored). */
  const [previews, setPreviews] = useState<Record<string, Record<string, string>>>({});
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const attachments = useAttachments();
  const features = useFeatures();
  const kbAvailable = features.knowledge_base;
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);

  // New answers start in the language last chosen on any response (per browser; English by default).
  // Read after mount to keep server and client HTML identical.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LANGUAGE_PREF);
      if (saved && LANGUAGE_CODES.includes(saved)) queueMicrotask(() => setLanguage(saved));
    } catch {
      /* storage unavailable */
    }
  }, []);

  function changeLanguage(code: string) {
    setLanguage(code);
    try {
      localStorage.setItem(LANGUAGE_PREF, code);
    } catch {
      /* non-essential */
    }
  }
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const refreshConversations = useCallback(
    (q: string) =>
      api
        .listConversations(q)
        .then(setConversations)
        .catch(() => {}),
    [],
  );

  // Initial load: documents (only with the Knowledge Base on), AI settings, then suggestions (may call the LLM once).
  useEffect(() => {
    Promise.all([kbAvailable ? api.knowledgeSources() : Promise.resolve([]), api.getAISettings()])
      .then(([list, settings]) => {
        setSources(list);
        setAi(settings);
        // Opened for a specific source (?source=…): select it, once.
        const hint = new URLSearchParams(window.location.search).get("source");
        if (hint && !hintApplied.current) {
          hintApplied.current = true;
          const match = sourceFromHint(hint, list);
          if (match) setScope(match.scope);
          else if (hint !== "all") setNotice(`${HINT_NAMES[hint.split(":")[0]!] ?? "That source"} has no indexed content yet, so this chat uses All Knowledge Base.`);
          window.history.replaceState(null, "", window.location.pathname);
        }
      })
      .catch((err: Error) => setError(err.message));
    (kbAvailable ? api.suggestions() : Promise.resolve([]))
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
  }, [kbAvailable]);

  // Debounced server-side chat search.
  useEffect(() => {
    const t = setTimeout(() => void refreshConversations(search), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [search, refreshConversations]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending]);

  function releasePreviews() {
    Object.values(previews).forEach((byName) => Object.values(byName).forEach((url) => URL.revokeObjectURL(url)));
    setPreviews({});
  }

  function newChat() {
    releasePreviews();
    setFailed(null);
    setScope(ALL_SCOPE); // a new chat starts with All Knowledge Base; the selector can change it before asking
    setActiveId(null);
    setMessages([]);
    setError(null);
    setNotice(null);
    setSidebarOpen(false);
    document.getElementById("chat-input")?.focus();
  }

  async function openConversation(id: string) {
    setSidebarOpen(false);
    if (id === activeId) return;
    releasePreviews();
    setFailed(null);
    setActiveId(id);
    setError(null);
    setNotice(null);
    setLoadingConversation(true);
    try {
      const conversation = await api.getConversation(id);
      setMessages(conversation.messages);
      setScope(conversation.knowledgeScope ?? ALL_SCOPE); // restore the chat's own source
    } catch (err) {
      setError((err as Error).message);
      setMessages([]);
    } finally {
      setLoadingConversation(false);
    }
  }

  async function deleteConversation(c: ConversationSummaryDTO) {
    if (!confirm(`Delete the chat "${c.title}"?`)) return;
    try {
      await api.deleteConversation(c.id);
      if (c.id === activeId) newChat();
      void refreshConversations(search);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function ask(text: string) {
    const question = text.trim();
    const items = attachments.items;
    if ((!question && items.length === 0) || pending) return;

    const sentPreviews = Object.fromEntries(items.filter((i) => i.previewUrl).map((i) => [i.file.name, i.previewUrl!]));
    setError(null);
    setFailed(null);
    setNotice(null);
    setInput("");
    attachments.clear(); // keeps preview URLs alive for the message bubble
    setPending({
      question,
      createdAt: new Date().toISOString(),
      attachments: items.map((i) => ({ name: i.file.name, kind: i.kind, mediaType: i.file.type, sizeBytes: i.file.size })),
      previews: sentPreviews,
    });

    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const res = await api.ask(
        {
          question,
          language,
          conversationId: activeId ?? undefined,
          knowledgeScope: kbAvailable ? scope : undefined,
          files: items.map((i) => i.file),
          addToKnowledgeBase: items.flatMap((i, index) => (i.addToKnowledgeBase ? [index] : [])),
        },
        controller.signal,
      );
      setActiveId(res.conversationId);
      setMessages((prev) => [...prev, res.userMessage, res.assistantMessage]);
      if (Object.keys(sentPreviews).length) setPreviews((p) => ({ ...p, [res.userMessage.id]: sentPreviews }));
      void refreshConversations(search);
      if (kbAvailable && items.some((i) => i.addToKnowledgeBase)) void api.knowledgeSources().then(setSources);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") setNotice("Stopped. Your message is back in the box below.");
      else
        setFailed({
          question,
          createdAt: new Date().toISOString(),
          attachments: items.map((i) => ({ name: i.file.name, kind: i.kind, mediaType: i.file.type, sizeBytes: i.file.size })),
          error: (err as Error).message,
        });
      // Let the user retry without retyping or re-attaching.
      setInput(question);
      attachments.restore(items);
    } finally {
      controllerRef.current = null;
      setPending(null);
    }
  }

  /** A new chat just switches source; a chat with messages asks first, so sources are never mixed silently. */
  function selectScope(next: KnowledgeScope) {
    if (activeId && messages.length > 0) setScopeChange(next);
    else setScope(next);
  }

  async function confirmScopeChange() {
    if (!scopeChange || !activeId) return;
    setChangingScope(true);
    try {
      await api.setConversationScope(activeId, scopeChange);
      setScope(scopeChange);
      setScopeChange(null);
    } catch (err) {
      setError((err as Error).message);
      setScopeChange(null);
    } finally {
      setChangingScope(false);
    }
  }

  // The selected source, always shown; a source whose documents were removed stays visible (0 documents).
  const allSource: KnowledgeSourceDTO = sources?.[0] ?? { key: "all", scope: ALL_SCOPE, label: "All Knowledge Base", count: 0 };
  const selectedSource: KnowledgeSourceDTO = sources?.find((s) => s.key === scopeKey(scope)) ?? {
    key: scopeKey(scope),
    scope,
    label: scope.type === "website" ? scope.host : scope.type === "google_drive" ? "Google Drive" : scope.type === "onedrive" ? "OneDrive" : scope.type === "all" ? "All Knowledge Base" : "Removed document",
    count: 0,
  };
  const pendingSource = scopeChange ? sources?.find((s) => s.key === scopeKey(scopeChange)) : undefined;
  const sourceText = describeSource(selectedSource);
  const totalDocuments = allSource.count;

  const activeProvider = ai?.providers.find((p) => p.provider === ai.activeProvider);
  const showWelcome = messages.length === 0 && !pending && !loadingConversation;

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* History sidebar */}
      <aside className="hidden w-72 shrink-0 border-r border-slate-200 lg:block">
        <ChatSidebar
          conversations={conversations}
          activeId={activeId}
          search={search}
          onSearch={setSearch}
          onSelect={(id) => void openConversation(id)}
          onNew={newChat}
          onDelete={(c) => void deleteConversation(c)}
        />
      </aside>
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-80 max-w-[85vw] shadow-xl">
            <button
              type="button"
              className="btn btn-ghost absolute top-4 right-3 z-10 p-1.5"
              aria-label="Close chat history"
              onClick={() => setSidebarOpen(false)}
            >
              <X className="h-4 w-4" />
            </button>
            <ChatSidebar
              conversations={conversations}
              activeId={activeId}
              search={search}
              onSearch={setSearch}
              onSelect={(id) => void openConversation(id)}
              onNew={newChat}
              onDelete={(c) => void deleteConversation(c)}
            />
          </aside>
        </div>
      )}

      {/* Conversation */}
      <main
        className="relative flex min-w-0 flex-1 flex-col"
        onDragEnter={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (hasFiles(e)) e.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (!pending) attachments.addFiles([...e.dataTransfer.files]);
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-white/80 p-6 backdrop-blur-sm">
            <div className="flex h-full w-full flex-col items-center justify-center rounded-3xl border-2 border-dashed border-blue-400 bg-blue-50/60 text-center">
              <FileUp className="mb-3 h-10 w-10 text-blue-500" />
              <p className="text-lg font-semibold text-slate-800">Drop files here</p>
              <p className="mt-1 text-sm text-slate-500">Documents or images · attached to this message only</p>
            </div>
          </div>
        )}
        <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 sm:px-5">
          <button type="button" className="btn btn-ghost p-2 lg:hidden" aria-label="Open chat history" onClick={() => setSidebarOpen(true)}>
            <Menu className="h-5 w-5" />
          </button>
          <BackButton className="shrink-0" labelClassName="hidden sm:inline" />
          <div className="h-5 w-px shrink-0 bg-slate-200" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {kbAvailable && sources && (
              <>
                <span className="hidden shrink-0 text-sm font-medium text-slate-500 sm:inline">Chat with:</span>
                <KnowledgeSourcePicker sources={sources} selected={selectedSource} onSelect={selectScope} disabled={!!pending} />
              </>
            )}
          </div>
          {activeProvider && (
            <Link
              href={features.ai_model_settings ? "/admin/ai-models" : "#"}
              aria-disabled={!features.ai_model_settings}
              onClick={(e) => !features.ai_model_settings && e.preventDefault()}
              title={features.ai_model_settings ? "AI model that writes the answers (click to change)" : "AI model that writes the answers"}
              className={`hidden shrink-0 items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 sm:flex ${features.ai_model_settings ? "hover:bg-slate-50" : "cursor-default"}`}
            >
              <Bot className="h-3.5 w-3.5" />
              <span className="text-slate-400">Model:</span>
              {activeProvider.label}
              <span className={`h-1.5 w-1.5 rounded-full ${activeProvider.ready ? "bg-emerald-500" : "bg-amber-500"}`} />
            </Link>
          )}
          <Link href="/app" className="btn btn-outline shrink-0 px-2.5 py-1.5 text-xs" title="Open the admin panel">
            <LayoutDashboard className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Admin</span>
          </Link>
        </header>

        {kbAvailable && sources && (
          <div className="border-b border-slate-100 bg-slate-50/80 px-3 py-1.5 sm:px-5" role="status">
            <p className="mx-auto flex max-w-5xl items-start gap-1.5 text-xs text-slate-600">
              <Info className="mt-px h-3.5 w-3.5 shrink-0 text-blue-500" />
              <span className="min-w-0">
                You are chatting with: <span className="font-semibold break-all text-slate-800">{selectedSource.label}</span>. {sourceText.banner}
                {selectedSource.count === 0 && " It has no indexed content right now, so answers can't use it."}
              </span>
            </p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
            {activeProvider && !activeProvider.ready && (
              <Alert tone="amber">
                {activeProvider.label} isn&apos;t configured yet (
                {!activeProvider.key.configured ? `add ${activeProvider.key.envVar} to .env` : "set a model ID"}).{" "}
                {features.ai_model_settings && (
                  <Link href="/admin/ai-models" className="font-medium underline">
                    Open AI Model Settings
                  </Link>
                )}
              </Alert>
            )}

            {showWelcome && !kbAvailable && (
              <div className="card flex flex-col items-center px-6 py-10 text-center">
                <Upload className="mb-3 h-8 w-8 text-slate-400" />
                <p className="font-medium">The Knowledge Base is turned off</p>
                <p className="mt-1 max-w-md text-sm text-slate-500">
                  Chat can&apos;t search your documents right now. You can still attach files or images to a message and ask about them.
                </p>
              </div>
            )}

            {showWelcome && kbAvailable && sources && totalDocuments === 0 && ai && (
              <div className="card flex flex-col items-center px-6 py-10 text-center">
                <Upload className="mb-3 h-8 w-8 text-slate-400" />
                <p className="font-medium">No documents yet</p>
                <p className="mt-1 text-sm text-slate-500">Upload PDF, DOCX or TXT files to start asking questions.</p>
                {features.documents && (
                  <Link href="/admin/documents" className="btn btn-dark mt-4">
                    Go to Documents
                  </Link>
                )}
              </div>
            )}

            {showWelcome && kbAvailable && totalDocuments > 0 && (
              <section className="rounded-xl border border-blue-100 bg-blue-50/60 p-5">
                <h2 className="flex items-center gap-2 font-semibold text-slate-800">
                  <Sparkles className="h-4.5 w-4.5 text-blue-600" /> Suggested Questions
                </h2>
                <p className="mt-1 mb-3 text-sm text-slate-600">
                  Here are some questions you might want to ask about your uploaded documents:
                </p>
                {suggestions === null ? (
                  <div className="flex items-center gap-2 py-2 text-sm text-slate-500">
                    <Spinner /> Generating suggestions…
                  </div>
                ) : suggestions.length === 0 ? (
                  <p className="text-sm text-slate-500">Ask anything about your documents below.</p>
                ) : (
                  <ul className="space-y-2">
                    {suggestions.map((q) => (
                      <li key={q}>
                        <button
                          type="button"
                          onClick={() => void ask(q)}
                          className="flex w-full items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-left text-sm text-slate-700 transition-colors hover:border-blue-300 hover:bg-blue-50"
                        >
                          <MessageCircle className="h-4 w-4 shrink-0 text-slate-400" />
                          {q}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-center text-xs text-slate-500">Click on any question to start a conversation about your documents</p>
              </section>
            )}

            {loadingConversation && (
              <div className="flex justify-center py-10 text-slate-400">
                <Spinner className="h-6 w-6" />
              </div>
            )}

            {messages.map((m) =>
              m.role === "user" ? (
                <UserBubble key={m.id} message={m} previews={previews[m.id]} />
              ) : (
                <AssistantBubble
                  key={m.id}
                  message={m}
                  // A language change updates this same message in place; nothing is added to the chat.
                  onMessageUpdate={(updated) => setMessages((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))}
                  onLanguageChosen={changeLanguage}
                />
              ),
            )}

            {pending && (
              <>
                <UserBubble
                  message={{ content: pending.question, createdAt: pending.createdAt, attachments: pending.attachments }}
                  previews={pending.previews}
                />
                <PendingAssistantBubble />
              </>
            )}

            {failed && !pending && (
              <>
                <UserBubble message={{ content: failed.question, createdAt: failed.createdAt, attachments: failed.attachments }} />
                {/* The question and its attachments are also back in the composer, so it can be edited instead. */}
                <FailedAssistantBubble message={failed.error} onRetry={() => void ask(failed.question)} />
              </>
            )}

            {notice && <Alert tone="amber">{notice}</Alert>}
            {error && <Alert>{error}</Alert>}
            <div ref={endRef} />
          </div>
        </div>

        <Modal
          open={!!scopeChange}
          title="Change knowledge source for this chat?"
          onClose={() => !changingScope && setScopeChange(null)}
          footer={
            <>
              <button type="button" className="btn btn-outline" disabled={changingScope} onClick={() => setScopeChange(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-dark" disabled={changingScope} onClick={() => void confirmScopeChange()}>
                {changingScope && <Spinner />} Change
              </button>
            </>
          }
        >
          <p className="text-sm text-slate-600">
            This chat uses <span className="font-semibold text-slate-800">{selectedSource.label}</span>. After the change, new questions will use only{" "}
            <span className="font-semibold text-slate-800">{pendingSource?.label ?? "the new source"}</span>
            {pendingSource ? ` (${sourceCountLabel(pendingSource)})` : ""}. Earlier answers keep their original sources.
          </p>
          <p className="mt-2 text-sm text-slate-500">To keep this chat as it is, cancel and start a new chat instead.</p>
        </Modal>

        <Composer
          value={input}
          onChange={setInput}
          attachments={attachments}
          onSend={() => void ask(input)}
          onStop={() => controllerRef.current?.abort()}
          busy={!!pending}
          imageInputSupported={activeProvider?.capabilities.imageInput ?? true}
          placeholder={kbAvailable ? sourceText.placeholder : undefined}
          header={
            kbAvailable && sources ? (
              <p className="mb-1.5 flex min-w-0 items-center gap-1.5 px-1 text-xs text-slate-500" aria-live="polite">
                <SourceIcon type={selectedSource.scope.type} size="sm" />
                <span className="truncate">{sourceText.indicator}</span>
              </p>
            ) : undefined
          }
          footer={
            <p className="mt-1.5 text-center text-[11px] text-slate-400">
              {APP_NAME} · Answers are generated from your documents and may contain mistakes. Check the cited sources.
            </p>
          }
        />
      </main>
    </div>
  );
}
