"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUp, FileText, ImageIcon, Paperclip, Plus, Square, X } from "lucide-react";
import {
  ATTACHMENT_LIMITS,
  DOCUMENT_ACCEPT,
  IMAGE_ACCEPT,
  attachmentKindFromName,
  checkAttachment,
  extensionOf,
  type AttachmentKind,
} from "@/lib/attachments";
import { IMAGE_UNSUPPORTED_MESSAGE } from "@/lib/capabilities";
import { useFeatures } from "../features/FeatureProvider";
import { formatBytes } from "../ui";

// ── Pending attachments (client-side state; nothing is uploaded until Send) ──

export interface PendingAttachment {
  id: string;
  file: File;
  kind: AttachmentKind;
  /** Object URL for image thumbnails. */
  previewUrl?: string;
  addToKnowledgeBase: boolean;
}

const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

export function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const itemsRef = useRef(items);
  useLayoutEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const addFiles = useCallback((files: File[]) => {
    const current = itemsRef.current;
    const next = [...current];
    const problems: string[] = [];
    for (const file of files) {
      const problem = checkAttachment(file);
      if (problem) {
        problems.push(problem);
        continue;
      }
      if (next.some((i) => sameFile(i.file, file))) {
        problems.push(`${file.name} is already attached.`);
        continue;
      }
      if (next.length >= ATTACHMENT_LIMITS.maxFiles) {
        problems.push(`You can attach up to ${ATTACHMENT_LIMITS.maxFiles} files per message.`);
        break;
      }
      const kind = attachmentKindFromName(file.name)!;
      next.push({
        id: crypto.randomUUID(),
        file,
        kind,
        previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
        addToKnowledgeBase: false,
      });
    }
    const total = next.reduce((s, i) => s + i.file.size, 0);
    if (total > ATTACHMENT_LIMITS.maxTotalBytes) {
      next.splice(current.length).forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl));
      problems.push(`Attachments can total at most ${ATTACHMENT_LIMITS.maxTotalBytes / 1024 / 1024} MB per message.`);
    }
    setItems(next);
    setErrors(problems);
  }, []);

  const remove = useCallback((id: string) => {
    const item = itemsRef.current.find((i) => i.id === id);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const toggleKnowledgeBase = useCallback(
    (id: string) => setItems((prev) => prev.map((i) => (i.id === id ? { ...i, addToKnowledgeBase: !i.addToKnowledgeBase } : i))),
    [],
  );

  /** Empties the composer. Preview URLs are kept alive for the sent message's bubble unless `revoke` is set. */
  const clear = useCallback((revoke = false) => {
    if (revoke) itemsRef.current.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl));
    setItems([]);
    setErrors([]);
  }, []);

  return { items, errors, addFiles, remove, toggleKnowledgeBase, clear, restore: setItems, dismissErrors: () => setErrors([]) };
}

// ── File type icon ──────────────────────────────────────────────────────────

const FILE_TONES: Record<string, string> = {
  ".pdf": "bg-red-50 text-red-600",
  ".docx": "bg-blue-50 text-blue-600",
  ".xlsx": "bg-emerald-50 text-emerald-600",
  ".csv": "bg-emerald-50 text-emerald-600",
  ".pptx": "bg-orange-50 text-orange-600",
};

export function FileTypeIcon({ name, className = "h-9 w-9" }: { name: string; className?: string }) {
  const ext = extensionOf(name);
  const isImage = attachmentKindFromName(name) === "image";
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-lg ${isImage ? "bg-violet-50 text-violet-600" : (FILE_TONES[ext] ?? "bg-slate-100 text-slate-500")} ${className}`}>
      {isImage ? <ImageIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
    </span>
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

function AttachmentChip({
  item,
  onRemove,
  onToggleKnowledgeBase,
  disabled,
  allowKnowledgeBase,
}: {
  item: PendingAttachment;
  onRemove: () => void;
  onToggleKnowledgeBase: () => void;
  disabled: boolean;
  /** "Add to Knowledge Base" needs the Documents feature. */
  allowKnowledgeBase: boolean;
}) {
  const removeButton = (
    <button
      type="button"
      onClick={onRemove}
      disabled={disabled}
      aria-label={`Remove ${item.file.name}`}
      className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-white shadow hover:bg-slate-700 disabled:opacity-50"
    >
      <X className="h-3 w-3" />
    </button>
  );

  if (item.kind === "image") {
    return (
      <div className="group relative" title={`${item.file.name} · ${formatBytes(item.file.size)}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
        <img src={item.previewUrl} alt={item.file.name} className="h-16 w-16 rounded-xl border border-slate-200 object-cover" />
        <div className="absolute -top-1.5 -right-1.5">{removeButton}</div>
      </div>
    );
  }

  return (
    <div className="relative flex max-w-64 items-center gap-2 rounded-xl border border-slate-200 bg-white py-1.5 pr-3 pl-1.5">
      <FileTypeIcon name={item.file.name} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-800" title={item.file.name}>
          {item.file.name}
        </p>
        {allowKnowledgeBase ? (
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-500 select-none">
            <input
              type="checkbox"
              className="h-3 w-3 accent-teal-600"
              checked={item.addToKnowledgeBase}
              onChange={onToggleKnowledgeBase}
              disabled={disabled}
            />
            Add to Knowledge Base
          </label>
        ) : (
          <p className="text-[11px] text-slate-500">{formatBytes(item.file.size)} · this message only</p>
        )}
      </div>
      <div className="absolute -top-1.5 -right-1.5">{removeButton}</div>
    </div>
  );
}

function AttachMenu({ onPick, disabled }: { onPick: (kind: AttachmentKind) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const item = (kind: AttachmentKind, Icon: typeof Paperclip, label: string, hint: string) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setOpen(false);
        onPick(kind);
      }}
      className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-slate-50"
    >
      <Icon className="mt-0.5 h-4 w-4 text-slate-500" />
      <span>
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
    </button>
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-label="Add attachments"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-9 w-9 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50 ${open ? "bg-slate-100" : ""}`}
      >
        <Plus className={`h-5 w-5 transition-transform ${open ? "rotate-45" : ""}`} />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
          {item("document", Paperclip, "Upload files", "PDF, Word, Excel, PowerPoint, TXT, Markdown, CSV")}
          {item("image", ImageIcon, "Add photos & images", "PNG, JPG or WEBP · up to 5 MB each")}
        </div>
      )}
    </div>
  );
}

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  attachments: ReturnType<typeof useAttachments>;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  /** Whether the active provider/model accepts images (best-effort). */
  imageInputSupported: boolean;
  /** Input hint; reflects the selected "Chat with" source. */
  placeholder?: string;
  /** Shown just above the input (e.g. which source the question will use). */
  header?: React.ReactNode;
  footer?: React.ReactNode;
}

export function Composer({
  value,
  onChange,
  attachments,
  onSend,
  onStop,
  busy,
  imageInputSupported,
  placeholder = "Ask anything about your documents...",
  header,
  footer,
}: ComposerProps) {
  const features = useFeatures();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const docInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  // Auto-grow up to ~8 lines; also shrinks back after the message is sent.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const hasImages = attachments.items.some((i) => i.kind === "image");
  const imageBlocked = hasImages && !imageInputSupported;
  const canSend = !busy && !imageBlocked && (value.trim().length > 0 || attachments.items.length > 0);

  function pick(kind: AttachmentKind) {
    (kind === "image" ? imageInput : docInput).current?.click();
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) attachments.addFiles([...e.target.files]);
    e.target.value = ""; // allow picking the same file again after removing it
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files];
    if (files.length === 0) return;
    e.preventDefault();
    // Clipboard images are usually all called "image.png": give each a unique name.
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    attachments.addFiles(
      files.map((f, i) =>
        f.type.startsWith("image/") && /^image\.\w+$/.test(f.name)
          ? new File([f], `pasted-image-${stamp}${files.length > 1 ? `-${i + 1}` : ""}${extensionOf(f.name) || ".png"}`, { type: f.type, lastModified: f.lastModified })
          : f,
      ),
    );
  }

  return (
    <div className="border-t border-slate-200 bg-white px-3 pt-3 pb-2 sm:px-6">
      <div className="mx-auto max-w-3xl">
        {attachments.errors.length > 0 && (
          <div role="alert" className="mb-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <ul className="flex-1 space-y-0.5">
              {attachments.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
            <button type="button" onClick={attachments.dismissErrors} aria-label="Dismiss" className="rounded p-0.5 hover:bg-red-100">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {imageBlocked && (
          <div role="alert" className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {IMAGE_UNSUPPORTED_MESSAGE}{" "}
            {features.ai_model_settings && (
              <Link href="/admin/ai-models" className="font-medium underline">
                AI Model Settings
              </Link>
            )}
          </div>
        )}

        {header}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) onSend();
          }}
          className="rounded-3xl border border-slate-200 bg-white shadow-sm transition-shadow focus-within:border-slate-300 focus-within:shadow-md"
        >
          {attachments.items.length > 0 && (
            <div className="flex flex-wrap gap-3 px-3 pt-3" aria-label="Attachments">
              {attachments.items.map((item) => (
                <AttachmentChip
                  key={item.id}
                  item={item}
                  disabled={busy}
                  onRemove={() => attachments.remove(item.id)}
                  onToggleKnowledgeBase={() => attachments.toggleKnowledgeBase(item.id)}
                  allowKnowledgeBase={features.documents}
                />
              ))}
            </div>
          )}

          <div className="flex items-end gap-1.5 p-2">
            <AttachMenu onPick={pick} disabled={busy} />
            <label htmlFor="chat-input" className="sr-only">
              Message
            </label>
            <textarea
              id="chat-input"
              ref={textareaRef}
              rows={1}
              maxLength={2000}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onPaste={onPaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (canSend) onSend();
                }
              }}
              placeholder={placeholder}
              className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-1 py-1.5 text-[15px] leading-6 placeholder:text-slate-400 focus:outline-none"
            />
            {busy ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop generating"
                title="Stop"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white hover:bg-slate-700"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                aria-label="Send"
                title="Send (Enter)"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white transition-colors hover:bg-slate-700 disabled:bg-slate-200 disabled:text-slate-400"
              >
                <ArrowUp className="h-4.5 w-4.5" />
              </button>
            )}
          </div>
        </form>

        <input ref={docInput} type="file" multiple accept={DOCUMENT_ACCEPT} className="hidden" onChange={onFileInput} />
        <input ref={imageInput} type="file" multiple accept={IMAGE_ACCEPT} className="hidden" onChange={onFileInput} />
        {footer}
      </div>
    </div>
  );
}
