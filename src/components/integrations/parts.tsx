"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Cloud, ExternalLink, Folder, FolderOpen, Globe, HardDrive, Home, XCircle, type LucideIcon } from "lucide-react";
import { api } from "@/lib/api";
import type {
  CloudFolderDTO,
  IntegrationDTO,
  IntegrationStatus,
  IntegrationType,
  SyncItemCategory,
  SyncItemStage,
  SyncRunItemDTO,
  SyncRunSummaryDTO,
} from "@/lib/integrations";
import { Badge, formatDate, Modal, Spinner } from "../ui";

/** Icon, icon background (product colours) and item unit per integration. */
export const INTEGRATION_UI: Record<IntegrationType, { icon: LucideIcon; iconClassName: string; unit: "pages" | "files" }> = {
  website: { icon: Globe, iconClassName: "brand-gradient", unit: "pages" },
  google_drive: { icon: HardDrive, iconClassName: "bg-[linear-gradient(135deg,#1a73e8_0%,#34a853_65%,#fbbc04_100%)]", unit: "files" },
  onedrive: { icon: Cloud, iconClassName: "bg-[linear-gradient(135deg,#0364b8,#28a8ea)]", unit: "files" },
};

export function formatDateTime(iso: string | null): string {
  return iso ? formatDate(iso, true) : "Never";
}

/** Status shown on a card. A configured website reads "Ready" rather than "Connected". */
export function IntegrationStatusBadge({ integration }: { integration: IntegrationDTO }) {
  const s: IntegrationStatus = integration.status;
  if (s === "disabled") return <Badge tone="slate">Disabled</Badge>;
  if (s === "syncing")
    return (
      <Badge tone="blue">
        <Spinner className="h-3 w-3" /> Syncing…
      </Badge>
    );
  if (s === "error") return <Badge tone="red">Error</Badge>;
  if (s === "success") return integration.lastRun?.status === "partial" ? <Badge tone="amber">Partly failed</Badge> : <Badge tone="green">Success</Badge>;
  if (integration.type === "website") return s === "connected" ? <Badge tone="green">Ready</Badge> : <Badge tone="amber">Not configured</Badge>;
  return integration.connected ? <Badge tone="green">Connected</Badge> : <Badge tone="slate">Not connected</Badge>;
}

export function RunStatusBadge({ status }: { status: SyncRunSummaryDTO["status"] }) {
  if (status === "running") return <Badge tone="blue"><Spinner className="h-3 w-3" /> Running</Badge>;
  if (status === "success") return <Badge tone="green"><CheckCircle2 className="h-3 w-3" /> Success</Badge>;
  if (status === "partial") return <Badge tone="amber"><AlertTriangle className="h-3 w-3" /> Partly failed</Badge>;
  return <Badge tone="red"><XCircle className="h-3 w-3" /> Failed</Badge>;
}

/** "Found 10 · Added 6 · Updated 3 · Skipped 1 · Failed 0" */
export function RunCounts({ run, unit = "files" }: { run: SyncRunSummaryDTO; unit?: string }) {
  const items: [string, number, string][] = [
    [`${unit[0]!.toUpperCase()}${unit.slice(1)} found`, run.filesFound, "text-slate-800"],
    ["Added", run.filesAdded, "text-emerald-700"],
    ["Updated", run.filesUpdated, "text-sky-700"],
    ["Skipped", run.filesSkipped, "text-slate-600"],
    ["Failed", run.filesFailed, run.filesFailed ? "text-red-600" : "text-slate-600"],
  ];
  return (
    <dl className="grid grid-cols-3 gap-2 text-center sm:grid-cols-5">
      {items.map(([label, value, tone]) => (
        <div key={label} className="rounded-lg bg-white px-1 py-1.5 ring-1 ring-slate-100">
          <dt className="text-[10px] font-medium tracking-wide text-slate-500 uppercase">{label}</dt>
          <dd className={`text-base font-semibold ${tone}`}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const OUTCOME_TONE = { added: "green", updated: "blue", skipped: "slate", failed: "red" } as const;

const STAGE_LABEL: Record<SyncItemStage, string> = {
  fetch: "Loading page",
  parse: "Reading page",
  extract: "Reading file",
  index: "Indexing",
};

const CATEGORY_LABEL: Record<SyncItemCategory, string> = {
  http_error: "HTTP error",
  network: "Network",
  timeout: "Timeout",
  redirect: "Redirect",
  too_large: "Too large",
  unsupported_content: "Unsupported content",
  no_content: "No content",
  unchanged: "Unchanged",
  extraction: "Extraction",
  ingestion: "Ingestion",
  other: "Other",
};

/** One page or file of a sync run: its outcome, the reason, and (when recorded) where and why it ended that way. */
export function RunItem({ item }: { item: SyncRunItemDTO }) {
  const category = item.category && CATEGORY_LABEL[item.category];
  const meta = [
    item.stage && STAGE_LABEL[item.stage],
    category !== item.message ? category : null, // "Unchanged" would otherwise appear twice
    item.httpStatus ? `HTTP ${item.httpStatus}` : null,
    item.at ? formatDateTime(item.at) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <Badge tone={OUTCOME_TONE[item.outcome]}>{item.outcome}</Badge>
        <span className="min-w-0 flex-1 truncate" title={item.name}>{item.name}</span>
        {item.url && (
          <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-slate-700" aria-label={`Open ${item.name}`}>
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
      {item.url && <p className="mt-0.5 truncate text-xs text-slate-400" title={item.url}>{item.url}</p>}
      {item.message && <p className={`mt-0.5 text-xs ${item.outcome === "failed" ? "text-red-600" : "text-slate-500"}`}>{item.message}</p>}
      {meta && <p className="mt-0.5 text-[11px] text-slate-400">{meta}</p>}
      {item.detail && (
        <details className="mt-1 text-xs text-slate-500">
          <summary className="cursor-pointer select-none">Technical details</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-slate-50 px-2 py-1.5 text-[11px] text-slate-600">{item.detail}</pre>
        </details>
      )}
    </li>
  );
}

/** The items of a run that failed, loaded from the run's details, so the reason is visible without opening the history. */
function FailedItems({ run }: { run: SyncRunSummaryDTO }) {
  const [items, setItems] = useState<SyncRunItemDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .syncRunDetail(run.integrationId, run.id)
      .then((detail) => !cancelled && setItems(detail.items.filter((i) => i.outcome === "failed")))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [run.integrationId, run.id]);

  if (error) return <p role="alert" className="mt-2 text-xs text-slate-500">Could not load the failed items: {error}</p>;
  if (items === null) return <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500" role="status"><Spinner className="h-3 w-3" /> Loading failed items…</p>;
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="mb-1 text-xs font-medium text-slate-600">Failed items</p>
      <ul aria-label="Failed items" className="max-h-60 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 bg-white">
        {items.map((item, idx) => (
          <RunItem key={idx} item={item} />
        ))}
      </ul>
    </div>
  );
}

/** The most recent run of one integration, with its counts. */
export function LastSyncCard({ run, unit }: { run: SyncRunSummaryDTO | null; unit: string }) {
  return (
    <section className="card p-5" aria-labelledby="last-sync" aria-live="polite">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="last-sync" className="font-semibold text-slate-800">Last Sync</h2>
        {run && <RunStatusBadge status={run.status} />}
      </div>
      {run ? (
        <>
          <RunCounts run={run} unit={unit} />
          <p className="mt-2 text-xs text-slate-500">
            {run.status === "running" ? `Started ${formatDateTime(run.startedAt)}` : `Finished ${formatDateTime(run.completedAt ?? run.startedAt)}`}
          </p>
          {run.status === "running" && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-slate-200">
              <div className="h-full w-1/3 animate-[pulse_1.2s_ease-in-out_infinite] rounded-full bg-brand-500" />
            </div>
          )}
          {run.errorMessage && <p className="mt-2 text-sm text-red-600">{run.errorMessage}</p>}
          {run.status !== "running" && run.filesFailed > 0 && <FailedItems key={run.id} run={run} />}
        </>
      ) : (
        <p className="text-sm text-slate-500">No syncs yet. Click Sync Now to import content.</p>
      )}
    </section>
  );
}

/** Browse the connected drive and pick the folder to sync. */
export function FolderPicker({
  integration,
  open,
  onClose,
  onSelect,
}: {
  integration: IntegrationDTO;
  open: boolean;
  onClose: () => void;
  onSelect: (folder: { id: string; name: string }) => void;
}) {
  const [path, setPath] = useState<CloudFolderDTO[]>([]);
  const [folders, setFolders] = useState<CloudFolderDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = path.at(-1);
  const rootLabel = integration.type === "google_drive" ? "My Drive" : "OneDrive";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .integrationFolders(integration.id, current?.id)
      .then((r) => !cancelled && (setFolders(r.folders), setError(null)))
      .catch((err: Error) => !cancelled && (setFolders([]), setError(err.message)));
    return () => {
      cancelled = true;
    };
  }, [open, integration.id, current?.id]);

  const go = (next: CloudFolderDTO[]) => {
    setFolders(null);
    setPath(next);
  };
  const displayPath = [rootLabel, ...path.map((p) => p.name)].join(" / ");

  return (
    <Modal
      open={open}
      title="Select folder"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-dark"
            onClick={() => onSelect({ id: current?.id ?? "root", name: displayPath })}
          >
            Use “{current?.name ?? rootLabel}”
          </button>
        </>
      }
    >
      <nav aria-label="Folder path" className="mb-3 flex flex-wrap items-center gap-1 text-sm">
        <button type="button" onClick={() => go([])} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-100">
          <Home className="h-3.5 w-3.5" /> {rootLabel}
        </button>
        {path.map((p, i) => (
          <span key={p.id} className="inline-flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
            <button type="button" onClick={() => go(path.slice(0, i + 1))} className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-100">
              {p.name}
            </button>
          </span>
        ))}
      </nav>
      {error && <p role="alert" className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {folders === null ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500" role="status"><Spinner /> Loading folders…</div>
      ) : folders.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">No subfolders here. You can select this folder.</p>
      ) : (
        <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
          {folders.map((f) => (
            <li key={f.id}>
              <button type="button" onClick={() => go([...path, f])} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50">
                <Folder className="h-4 w-4 text-amber-500" />
                <span className="flex-1 truncate">{f.name}</span>
                <ChevronRight className="h-4 w-4 text-slate-300" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
        <FolderOpen className="h-3.5 w-3.5" /> Files directly in the selected folder are synced (PDF, DOCX, TXT, MD).
      </p>
    </Modal>
  );
}
