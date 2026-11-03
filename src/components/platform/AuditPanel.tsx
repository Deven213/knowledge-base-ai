"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { AuditEntryDTO } from "@/lib/types";
import { Alert, Badge, formatDate, Spinner } from "../ui";

const PAGE = 100;

const ACTION_LABEL: Record<string, string> = {
  "platform.organizations.list": "Viewed the customer list",
  "platform.organization.view": "Viewed a workspace",
  "platform.organization.create": "Created a customer workspace",
  "platform.organization.suspend": "Suspended a workspace",
  "platform.organization.reactivate": "Reactivated a workspace",
  "platform.organization.delete": "Deleted a customer workspace",
  "platform.owner.recover": "Repaired the owner account from the server",
  "platform.customer_admin.add": "Added a Customer Admin",
  "platform.customer_admin.invite": "Issued a Customer Admin invitation link (earlier onboarding)",
  "platform.credentials.reissue": "Issued a new temporary password",
  "platform.credentials.revoke": "Revoked a temporary password",
  "platform.invitation.revoke": "Revoked an invitation",
  "platform.user.disable": "Disabled an account",
  "platform.user.enable": "Enabled an account",
  "platform.audit.view": "Viewed the audit log",
  "platform.access_denied": "Blocked a Super Admin request",
  "auth.platform_admin.login": "Super Admin signed in",
  "auth.invitation.accept": "Accepted an invitation",
  "auth.password.change": "Chose a new password",
  "org.invitation.create": "Invited a person",
  "org.invitation.revoke": "Withdrew an invitation",
  "org.member.role_change": "Changed a role",
  "org.member.remove": "Removed a person",
};

const detailText = (details: AuditEntryDTO["details"]) =>
  Object.entries(details)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(", ");

/** The audit trail (newest first). Append-only on the server: nothing here can be edited or removed. */
export function AuditPanel() {
  const [entries, setEntries] = useState<AuditEntryDTO[] | null>(null);
  const [reload, setReload] = useState(0);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .platformAuditLog({ limit: PAGE })
      .then((e) => {
        if (cancelled) return;
        setEntries(e);
        setMore(e.length === PAGE);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function loadOlder() {
    if (!entries?.length) return;
    setLoadingMore(true);
    try {
      const older = await api.platformAuditLog({ limit: PAGE, before: entries[entries.length - 1]!.id });
      setEntries([...entries, ...older]);
      setMore(older.length === PAGE);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="card" aria-labelledby="audit-heading">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 id="audit-heading" className="text-lg font-semibold">Audit log</h2>
          <p className="text-sm text-slate-500">Super Admin access and administrative changes. Records can&apos;t be edited or deleted, and never contain passwords or setup links.</p>
        </div>
        <button type="button" className="btn btn-outline" onClick={() => { setEntries(null); setError(null); setReload((n) => n + 1); }}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>
      {error && <div className="p-4"><Alert>{error}</Alert></div>}
      {!entries && !error && (
        <div className="flex justify-center py-12 text-slate-400">
          <Spinner className="h-6 w-6" />
        </div>
      )}
      {entries && entries.length === 0 && <p className="px-5 py-6 text-sm text-slate-500">Nothing recorded yet.</p>}
      {entries && entries.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 py-3 text-sm">
              <span className="w-40 shrink-0 text-xs text-slate-500">{formatDate(e.at, true)}</span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-800">
                  {ACTION_LABEL[e.action] ?? e.action}
                  {e.targetLabel ? <span className="font-normal text-slate-600"> · {e.targetLabel}</span> : null}
                </p>
                <p className="truncate text-xs text-slate-500">
                  by {e.actorEmail ?? "unknown"}
                  {e.ip ? ` · ${e.ip}` : ""}
                  {Object.keys(e.details).length > 0 ? ` · ${detailText(e.details)}` : ""}
                </p>
              </div>
              {e.outcome !== "success" && <Badge tone="red">{e.outcome}</Badge>}
            </li>
          ))}
        </ul>
      )}
      {more && (
        <div className="border-t border-slate-100 p-3 text-center">
          <button type="button" className="btn btn-outline" disabled={loadingMore} onClick={() => void loadOlder()}>
            {loadingMore ? <Spinner className="h-4 w-4" /> : null} Load older entries
          </button>
        </div>
      )}
    </section>
  );
}
