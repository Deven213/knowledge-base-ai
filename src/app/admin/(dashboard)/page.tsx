"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Database, FileText, LayoutDashboard, MessageSquare, MessagesSquare, type LucideIcon } from "lucide-react";
import { Alert, Badge, formatBytes, formatDate, PageHeader, Spinner } from "@/components/ui";
import { useFeatures } from "@/components/features/FeatureProvider";
import { api } from "@/lib/api";
import { PROVIDER_LABELS, type DocumentDTO, type StatsDTO } from "@/lib/types";

function StatCard({ icon: Icon, label, value, hint }: { icon: LucideIcon; label: string; value: string | number; hint?: string }) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <Icon className="h-4.5 w-4.5" />
        </div>
      </div>
      <p className="mt-2 text-3xl font-bold tracking-tight">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<StatsDTO | null>(null);
  const [recent, setRecent] = useState<DocumentDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const features = useFeatures();
  // The document list belongs to the Knowledge Base; the Recent documents panel links to Documents.
  const showRecent = features.documents;

  useEffect(() => {
    Promise.all([api.stats(), showRecent ? api.listDocuments() : Promise.resolve([])])
      .then(([s, docs]) => {
        setStats(s);
        setRecent(docs.slice(0, 5));
      })
      .catch((err: Error) => setError(err.message));
  }, [showRecent]);

  return (
    <>
      <PageHeader icon={LayoutDashboard} title="Dashboard" subtitle="Overview of your knowledge base" />

      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      {!stats ? (
        !error && (
          <div className="flex justify-center py-14 text-slate-400">
            <Spinner className="h-6 w-6" />
          </div>
        )
      ) : (
        <>
          {!stats.activeProviderReady && (
            <div className="mb-4">
              <Alert tone="amber">
                {PROVIDER_LABELS[stats.activeProvider]} is not fully configured, so chat can&apos;t answer yet.{" "}
                {features.ai_model_settings && (
                  <Link href="/admin/ai-models" className="font-medium underline">
                    Open AI Model Settings
                  </Link>
                )}
              </Alert>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={FileText}
              label="Documents"
              value={stats.documents.ready}
              hint={`${formatBytes(stats.documents.bytes)} total${stats.documents.failed ? ` · ${stats.documents.failed} failed` : ""}`}
            />
            <StatCard icon={Database} label="Indexed chunks" value={stats.documents.chunks} hint={stats.embeddingModel} />
            <StatCard icon={MessagesSquare} label="Conversations" value={stats.conversations} />
            <StatCard icon={MessageSquare} label="Questions asked" value={stats.questions} />
          </div>

          {showRecent && (
            <section className="card mt-6 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold">Recent documents</h2>
                <Link href="/admin/documents" className="flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline">
                  View all <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
              {recent.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-500">
                  No documents yet.{" "}
                  <Link href="/admin/documents" className="font-medium text-brand-600 hover:underline">
                    Upload one
                  </Link>
                </p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {recent.map((d) => (
                    <li key={d.id} className="flex items-center gap-3 py-2.5">
                      <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.filename}</span>
                      <span className="hidden text-xs text-slate-500 sm:inline">{formatDate(d.createdAt)}</span>
                      {d.status === "ready" ? <Badge tone="green">Indexed</Badge> : d.status === "failed" ? <Badge tone="red">Failed</Badge> : <Badge tone="amber">Processing</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}
