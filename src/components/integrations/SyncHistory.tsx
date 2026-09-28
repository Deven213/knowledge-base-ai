"use client";

import { useState } from "react";
import { ExternalLink, History } from "lucide-react";
import { api } from "@/lib/api";
import type { SyncRunDetailDTO, SyncRunSummaryDTO } from "@/lib/integrations";
import { Badge, EmptyState, Modal, Spinner } from "../ui";
import { formatDateTime, RunCounts, RunStatusBadge } from "./parts";

const OUTCOME_TONE = { added: "green", updated: "blue", skipped: "slate", failed: "red" } as const;

/** One integration's sync runs (newest first), with a per-run details view. */
export function SyncHistory({ runs, unit }: { runs: SyncRunSummaryDTO[]; unit: string }) {
  const [detail, setDetail] = useState<SyncRunDetailDTO | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function open(run: SyncRunSummaryDTO) {
    setLoading(run.id);
    setError(null);
    try {
      setDetail(await api.syncRunDetail(run.integrationId, run.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(null);
    }
  }

  return (
    <section className="card" aria-labelledby="sync-history">
      <h2 id="sync-history" className="flex items-center gap-2 border-b border-slate-100 px-5 py-3 font-semibold text-slate-800">
        <History className="h-4 w-4 text-slate-400" /> Sync History
      </h2>
      {error && <p role="alert" className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {runs.length === 0 ? (
        <EmptyState icon={History} title="No syncs yet">Runs appear here after you click Sync Now.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100">
          {runs.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm">
              <p className="min-w-40 flex-1 font-medium text-slate-800">{formatDateTime(r.startedAt)}</p>
              <RunStatusBadge status={r.status} />
              <p className="text-xs text-slate-600">
                {r.filesFound} {unit} · {r.filesAdded} added · {r.filesUpdated} updated · {r.filesSkipped} skipped
                {r.filesFailed > 0 && <span className="text-red-600"> · {r.filesFailed} failed</span>}
              </p>
              <button type="button" className="btn btn-ghost px-2 py-1 text-xs" disabled={r.status === "running" || loading === r.id} onClick={() => void open(r)}>
                {loading === r.id ? <Spinner className="h-3.5 w-3.5" /> : null} Details
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal open={!!detail} title={detail ? `Sync — ${formatDateTime(detail.startedAt)}` : ""} onClose={() => setDetail(null)}>
        {detail && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <RunStatusBadge status={detail.status} />
              {detail.completedAt && <span className="text-xs text-slate-500">Finished {formatDateTime(detail.completedAt)}</span>}
            </div>
            <RunCounts run={detail} unit={unit} />
            {detail.errorMessage && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{detail.errorMessage}</p>}
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
              {detail.items.length === 0 && <li className="px-3 py-4 text-center text-sm text-slate-500">No items.</li>}
              {detail.items.map((item, idx) => (
                <li key={idx} className="px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge tone={OUTCOME_TONE[item.outcome]}>{item.outcome}</Badge>
                    <span className="min-w-0 flex-1 truncate" title={item.name}>{item.name}</span>
                    {item.url && (
                      <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-slate-700" aria-label={`Open ${item.name}`}>
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                  {item.message && <p className={`mt-0.5 text-xs ${item.outcome === "failed" ? "text-red-600" : "text-slate-500"}`}>{item.message}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>
    </section>
  );
}
