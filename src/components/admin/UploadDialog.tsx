"use client";

import { useRef, useState } from "react";
import { CheckCircle2, CloudUpload, FileText, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { DOCUMENT_ACCEPT } from "@/lib/attachments";
import { formatBytes, Modal, Spinner } from "../ui";

type ItemState = { file: File; status: "queued" | "uploading" | "done" | "failed"; message?: string };

export function UploadDialog({ open, onClose, onUploaded }: { open: boolean; onClose: () => void; onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<ItemState[]>([]);
  const [dragging, setDragging] = useState(false);
  const busy = items.some((i) => i.status === "uploading");

  function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files).map((file) => ({ file, status: "queued" as const }));
    setItems((prev) => [...prev, ...incoming]);
  }

  async function uploadAll() {
    for (let i = 0; i < items.length; i++) {
      if (items[i]!.status !== "queued") continue;
      setItems((prev) => prev.map((it, j) => (j === i ? { ...it, status: "uploading" } : it)));
      let next: ItemState;
      try {
        const doc = await api.uploadDocument(items[i]!.file);
        next =
          doc?.status === "ready"
            ? { file: items[i]!.file, status: "done", message: `Indexed into ${doc.chunkCount} chunk${doc.chunkCount === 1 ? "" : "s"}` }
            : { file: items[i]!.file, status: "failed", message: doc?.error ?? "Processing failed" };
      } catch (err) {
        next = { file: items[i]!.file, status: "failed", message: (err as Error).message };
      }
      setItems((prev) => prev.map((it, j) => (j === i ? next : it)));
      onUploaded();
    }
  }

  function close() {
    if (busy) return;
    setItems([]);
    onClose();
  }

  const queued = items.filter((i) => i.status === "queued").length;

  return (
    <Modal
      open={open}
      title="Upload Files"
      onClose={close}
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={close} disabled={busy}>
            {items.some((i) => i.status === "done" || i.status === "failed") && queued === 0 ? "Done" : "Cancel"}
          </button>
          <button type="button" className="btn btn-dark" onClick={() => void uploadAll()} disabled={busy || queued === 0}>
            {busy ? <Spinner /> : <CloudUpload className="h-4 w-4" />}
            {busy ? "Uploading…" : `Upload ${queued || ""} file${queued === 1 ? "" : "s"}`}
          </button>
        </>
      }
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        className={`flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
          dragging ? "border-brand-500 bg-brand-50" : "border-slate-200 hover:border-brand-500 hover:bg-slate-50"
        }`}
      >
        <CloudUpload className="mb-2 h-8 w-8 text-slate-400" />
        <span className="text-sm font-medium text-slate-800">Drag & drop files here, or click to browse</span>
        <span className="mt-0.5 text-xs text-slate-500">PDF, DOCX, TXT, MD, CSV, XLSX or PPTX · the first upload also downloads the embedding model</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={DOCUMENT_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {items.length > 0 && (
        <ul className="mt-4 max-h-64 space-y-2 overflow-y-auto">
          {items.map((it, i) => (
            <li key={`${it.file.name}-${i}`} className="flex items-center gap-3 rounded-lg border border-slate-100 px-3 py-2">
              <FileText className="h-4 w-4 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{it.file.name}</p>
                <p className={`text-xs ${it.status === "failed" ? "text-red-600" : "text-slate-500"}`}>
                  {it.message ?? formatBytes(it.file.size)}
                </p>
              </div>
              {it.status === "uploading" && <Spinner className="h-4 w-4 text-brand-600" />}
              {it.status === "done" && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
              {it.status === "failed" && <XCircle className="h-4 w-4 text-red-600" />}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
