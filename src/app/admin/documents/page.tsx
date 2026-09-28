"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, FileText, Filter, MessageSquare, Plus, Search, Trash2 } from "lucide-react";
import { UploadDialog } from "@/components/admin/UploadDialog";
import { useFeatures } from "@/components/features/FeatureProvider";
import { Alert, Badge, EmptyState, formatBytes, formatDate, PageHeader, RowMenu, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { INTEGRATION_META } from "@/lib/integrations";
import { websiteHost } from "@/lib/knowledge-scope";
import type { DocumentDTO } from "@/lib/types";

type StatusFilter = "all" | "ready" | "failed" | "reindex";

/** Opens Chat with this document's source selected: the document itself, its website, or its cloud drive. */
function chatAction(doc: DocumentDTO): { label: string; href: string } | null {
  if (doc.status !== "ready" || !doc.indexCurrent) return null;
  if (!doc.source) return { label: "Chat with this document", href: `/chat?source=document:${doc.id}` };
  if (doc.source.type === "website") {
    const host = websiteHost(doc.source.url);
    return host ? { label: `Chat with ${host}`, href: `/chat?source=website:${encodeURIComponent(host)}` } : null;
  }
  return { label: `Chat with ${INTEGRATION_META[doc.source.type].name}`, href: `/chat?source=${doc.source.type}` };
}

function extLabel(filename: string): string {
  const ext = filename.split(".").pop() ?? "";
  return ext.charAt(0).toUpperCase() + ext.slice(1).toLowerCase();
}

function StatusBadge({ doc }: { doc: DocumentDTO }) {
  if (doc.status === "failed") return <Badge tone="red">Failed</Badge>;
  if (doc.status === "processing") return <Badge tone="amber">Processing</Badge>;
  if (!doc.indexCurrent) return <Badge tone="amber">Re-index needed</Badge>;
  return <Badge tone="green">Indexed</Badge>;
}

export default function DocumentsPage() {
  const router = useRouter();
  const features = useFeatures();
  const [documents, setDocuments] = useState<DocumentDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");

  const refresh = useCallback(
    () =>
      api
        .listDocuments()
        .then(setDocuments)
        .catch((err: Error) => setError(err.message)),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (documents ?? []).filter((d) => {
      if (q && !d.filename.toLowerCase().includes(q)) return false;
      if (filter === "ready") return d.status === "ready" && d.indexCurrent;
      if (filter === "failed") return d.status === "failed";
      if (filter === "reindex") return d.status === "ready" && !d.indexCurrent;
      return true;
    });
  }, [documents, query, filter]);

  async function remove(doc: DocumentDTO) {
    if (!confirm(`Delete "${doc.filename}"? Its index will be removed and it will no longer be used for answers.`)) return;
    try {
      await api.deleteDocument(doc.id);
    } catch (err) {
      setError((err as Error).message);
    }
    void refresh();
  }

  return (
    <>
      <PageHeader
        back
        icon={FileText}
        title="Documents"
        subtitle="Upload and manage the documents your AI answers from"
        actions={
          <button type="button" className="btn btn-dark" onClick={() => setUploadOpen(true)}>
            <Plus className="h-4 w-4" /> Upload Files
          </button>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold">Documents</h2>
            <p className="text-sm text-slate-500">
              {documents ? `${documents.length} file${documents.length === 1 ? "" : "s"} in your knowledge base` : "Loading…"}
            </p>
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <label className="relative flex-1 sm:w-64 sm:flex-none">
              <span className="sr-only">Search files</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input className="input pl-9" placeholder="Search files..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <label className="relative">
              <span className="sr-only">Filter by status</span>
              <Filter className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <select
                className="input appearance-none pr-3 pl-9"
                value={filter}
                onChange={(e) => setFilter(e.target.value as StatusFilter)}
              >
                <option value="all">All</option>
                <option value="ready">Indexed</option>
                <option value="failed">Failed</option>
                <option value="reindex">Re-index needed</option>
              </select>
            </label>
          </div>
        </div>

        {documents === null ? (
          <div className="flex justify-center py-14 text-slate-400">
            <Spinner className="h-6 w-6" />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState icon={FileText} title={documents.length === 0 ? "No documents yet" : "No matching documents"}>
            {documents.length === 0 ? (
              <button type="button" className="btn btn-dark mt-3" onClick={() => setUploadOpen(true)}>
                <Plus className="h-4 w-4" /> Upload your first file
              </button>
            ) : (
              "Try a different search or filter."
            )}
          </EmptyState>
        ) : (
          <ul className="space-y-3 p-4 sm:p-5">
            {visible.map((doc) => (
              <li
                key={doc.id}
                className="flex items-start gap-3 rounded-xl border border-slate-200 px-4 py-3 transition-shadow hover:shadow-sm"
              >
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                  <FileText className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-slate-800" title={doc.filename}>
                    {doc.filename}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {formatBytes(doc.sizeBytes)} · {formatDate(doc.createdAt)} · {doc.source?.type === "website" ? "Web page" : extLabel(doc.filename)}
                    {doc.pageCount ? ` · ${doc.pageCount} pages` : ""}
                    {doc.status === "ready" ? ` · ${doc.chunkCount} chunk${doc.chunkCount === 1 ? "" : "s"}` : ""}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <StatusBadge doc={doc} />
                    {doc.source && (
                      <Badge tone="blue">
                        {INTEGRATION_META[doc.source.type].sourceLabel}
                        {doc.source.url && (
                          <a href={doc.source.url} target="_blank" rel="noopener noreferrer" aria-label="Open source" className="hover:text-blue-900">
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </Badge>
                    )}
                    {doc.error && <span className="text-xs text-red-600">{doc.error}</span>}
                    {doc.status === "ready" && !doc.indexCurrent && (
                      <span className="text-xs text-amber-700">Embedding model changed. Delete and re-upload to search it.</span>
                    )}
                  </div>
                </div>
                <RowMenu
                  label={`Actions for ${doc.filename}`}
                  items={[
                    ...(features.chat && chatAction(doc)
                      ? [{ label: chatAction(doc)!.label, icon: MessageSquare, onSelect: () => router.push(chatAction(doc)!.href) }]
                      : []),
                    { label: "Delete", icon: Trash2, danger: true, onSelect: () => void remove(doc) },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <UploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} onUploaded={() => void refresh()} />
    </>
  );
}
