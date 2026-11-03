"use client";

import type { AttachmentDTO, MessageDTO } from "@/lib/types";
import { formatBytes } from "../ui";
import { FileTypeIcon } from "./Composer";
import { ResponseError, ResponseSkeleton } from "./answer/ResponseStatus";
import { StructuredAIResponse } from "./answer/StructuredAIResponse";

function time(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Files sent with a user message. Image thumbnails exist only in this browser session (files aren't stored). */
function MessageAttachments({ attachments, previews }: { attachments: AttachmentDTO[]; previews?: Record<string, string> }) {
  if (attachments.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap justify-end gap-2">
      {attachments.map((a) => {
        const preview = a.kind === "image" ? previews?.[a.name] : undefined;
        return preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
          <img key={a.name} src={preview} alt={a.name} title={a.name} className="h-24 w-24 rounded-xl border border-slate-200 object-cover" />
        ) : (
          <div key={a.name} className="flex max-w-60 items-center gap-2 rounded-xl border border-slate-200 bg-white py-1.5 pr-3 pl-1.5 text-left">
            <FileTypeIcon name={a.name} className="h-8 w-8" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-800" title={a.name}>
                {a.name}
              </p>
              <p className="text-[11px] text-slate-500">
                {formatBytes(a.sizeBytes)}
                {a.knowledgeBaseDocumentId && <span className="text-emerald-700"> · Added to Knowledge Base</span>}
                {a.knowledgeBaseError && <span className="text-red-600"> · Not added: {a.knowledgeBaseError}</span>}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function UserBubble({
  message,
  previews,
}: {
  message: Pick<MessageDTO, "content" | "createdAt"> & { attachments?: AttachmentDTO[] };
  previews?: Record<string, string>;
}) {
  return (
    <div className="flex flex-col items-end">
      <MessageAttachments attachments={message.attachments ?? []} previews={previews} />
      {message.content && (
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-blue-600 px-4 py-2.5 text-white shadow-sm sm:max-w-[70%]">
          <p className="text-[15px] whitespace-pre-wrap">{message.content}</p>
          <p className="mt-1 text-right text-[11px] text-blue-100">{time(message.createdAt)}</p>
        </div>
      )}
    </div>
  );
}

/**
 * One assistant message = one StructuredAIResponse container (a compact clinical note: title, language menu, summary,
 * key points, caution, reference, "More details", footer). Nothing inside it is rendered as a separate chat message.
 */
export function AssistantBubble({
  message,
  onMessageUpdate,
  onLanguageChosen,
  ttsEnabled,
}: {
  message: MessageDTO;
  onMessageUpdate: (updated: MessageDTO) => void;
  onLanguageChosen?: (code: string) => void;
  ttsEnabled?: boolean;
}) {
  return (
    <div className="min-w-0">
      <StructuredAIResponse message={message} onMessageUpdate={onMessageUpdate} onLanguageChosen={onLanguageChosen} ttsEnabled={ttsEnabled} />
    </div>
  );
}

/** While the answer is generated: one skeleton response (not a separate message per part). */
export function PendingAssistantBubble() {
  return (
    <div className="min-w-0">
      <ResponseSkeleton />
    </div>
  );
}

/** A failed answer: one response container with the reason and Try again. */
export function FailedAssistantBubble({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="min-w-0">
      <ResponseError message={message} onRetry={onRetry} />
    </div>
  );
}
