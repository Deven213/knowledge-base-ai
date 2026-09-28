"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink, FolderOpen, KeyRound, Link2Off, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { INTEGRATION_META } from "@/lib/integrations";
import { Spinner } from "../ui";
import type { IntegrationContext } from "./IntegrationPage";
import { FolderPicker } from "./parts";

const CONNECT_PATH = { google_drive: "/api/integrations/google-drive/connect", onedrive: "/api/integrations/onedrive/connect" } as const;
const ACCOUNT_LABEL = { google_drive: "Google Drive Account", onedrive: "Microsoft Account" } as const;
const FILE_TYPES = ["PDF", "DOCX", "TXT", "MD"];

/** Connection, folder, file types, Sync Now and Disconnect for Google Drive or OneDrive (same backend). */
export function CloudDriveSettings({ integration: i, onChange, notify }: IntegrationContext) {
  const type = i.type as keyof typeof CONNECT_PATH;
  const name = INTEGRATION_META[type].name;
  const [busy, setBusy] = useState<"sync" | "folder" | "disconnect" | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const syncing = i.status === "syncing";
  const off = !i.enabled;

  async function act<T>(action: "sync" | "folder" | "disconnect", fn: () => Promise<T>, done?: (r: T) => void) {
    setBusy(action);
    setError(null);
    try {
      done?.(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // Server not configured: say exactly what is missing. Never a fake connection.
  if (i.oauth && !i.oauth.configured) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="flex items-center gap-1.5 font-semibold">
          <KeyRound className="h-4 w-4" /> {name} is not configured.
        </p>
        <p className="mt-2">Missing:</p>
        <ul className="mt-1 space-y-0.5">
          {i.oauth.missingConfig.map((v) => (
            <li key={v}>
              <code className="font-mono text-xs">{v}</code>
            </li>
          ))}
        </ul>
        <p className="mt-2">
          Add them to <code className="font-mono text-xs">.env</code> and restart the server.
        </p>
        <p className="mt-2 text-xs break-all">
          Redirect URI to register: <code className="font-mono">{i.oauth.redirectUri}</code>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="label">Connection</p>
        <p className="flex items-center gap-2 text-sm">
          <span className={`h-2.5 w-2.5 rounded-full ${i.connected ? "bg-emerald-500" : "bg-slate-300"}`} aria-hidden />
          <span className={i.connected ? "font-medium text-emerald-700" : "text-slate-600"}>{i.connected ? "Connected" : "Not connected"}</span>
        </p>
      </div>

      {!i.connected ? (
        <a
          href={CONNECT_PATH[type]}
          onClick={() => setConnecting(true)}
          className={`btn btn-dark w-full sm:w-auto ${off || connecting ? "pointer-events-none opacity-60" : ""}`}
          aria-disabled={off || connecting}
        >
          {connecting ? <Spinner /> : <ExternalLink className="h-4 w-4" />}
          {connecting ? "Connecting…" : `Connect ${name}`}
        </a>
      ) : (
        <>
          <div>
            <p className="label">{ACCOUNT_LABEL[type]}</p>
            <p className="text-sm text-slate-700">
              Connected{i.accountLabel ? <span className="text-slate-500"> · {i.accountLabel}</span> : null}
            </p>
          </div>

          <div>
            <span className="label">Folder</span>
            <button
              type="button"
              className="btn btn-outline w-full justify-between"
              disabled={off || syncing || !!busy}
              onClick={() => setPickerOpen(true)}
            >
              <span className="flex min-w-0 items-center gap-2">
                {busy === "folder" ? <Spinner /> : <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />}
                <span className="truncate">{i.configuration.folderName ?? "Select folder"}</span>
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
            </button>
          </div>

          <div>
            <p className="label">File types</p>
            <div className="flex flex-wrap gap-1.5">
              {FILE_TYPES.map((t) => (
                <span key={t} className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                  {t}
                </span>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">Files directly in the selected folder are synced. Sync is manual.</p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              className="btn btn-dark"
              disabled={off || syncing || !!busy || !i.configuration.folderId}
              onClick={() =>
                void act("sync", () => api.syncIntegration(i.id), () => {
                  notify(`${name} sync started.`);
                  onChange();
                })
              }
            >
              {syncing || busy === "sync" ? <Spinner /> : <RefreshCw className="h-4 w-4" />}
              {syncing || busy === "sync" ? "Syncing files…" : "Sync Now"}
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={syncing || !!busy}
              onClick={() => {
                if (confirm(`Disconnect ${name}? Imported documents and sync history are kept.`)) {
                  void act("disconnect", () => api.disconnectIntegration(i.id), (u) => {
                    onChange(u);
                    notify(`${name} disconnected.`);
                  });
                }
              }}
            >
              {busy === "disconnect" ? <Spinner /> : <Link2Off className="h-4 w-4" />}
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>

          <FolderPicker
            integration={i}
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            onSelect={(f) => {
              setPickerOpen(false);
              void act("folder", () => api.updateIntegration(i.id, { configuration: { folderId: f.id, folderName: f.name } }), (u) => onChange(u));
            }}
          />
        </>
      )}

      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
