"use client";

import { useEffect, useState } from "react";
import { Building2, Plus, ScrollText } from "lucide-react";
import { api } from "@/lib/api";
import type { CreatedCustomerDTO, PlatformOrganizationDTO, SessionDTO } from "@/lib/types";
import { Alert, Badge, EmptyState, formatDate, Spinner } from "../ui";
import { AuditPanel } from "./AuditPanel";
import { CredentialsCard } from "./CredentialsCard";
import { OrganizationPanel } from "./OrganizationPanel";

type Tab = "customers" | "audit";

function activationBadge(o: PlatformOrganizationDTO) {
  switch (o.activation.status) {
    case "pending":
      return <Badge tone="amber">Waiting for first sign-in</Badge>;
    case "expired":
      return <Badge tone="red">Temporary password expired</Badge>;
    case "none":
      return <Badge tone="red">No Customer Admin</Badge>;
    default:
      return null;
  }
}

/** One identifier per customer being created: if the same request is sent twice (a retry), the server creates nothing new. */
const newRequestId = () => globalThis.crypto.randomUUID();

/**
 * The Super Admin's console: every customer workspace, creating a customer with its first Customer Admin,
 * suspending workspaces, managing people, and the audit trail. Customer content is never shown. The page
 * is only a convenience: each request is checked on the server (platform:admin).
 */
export function PlatformConsole() {
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [organizations, setOrganizations] = useState<PlatformOrganizationDTO[] | null>(null);
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState<Tab>("customers");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [reference, setReference] = useState("");
  const [requestId, setRequestId] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedCustomerDTO | null>(null);
  const [deletedName, setDeletedName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.me(), api.platformListOrganizations()])
      .then(([me, orgs]) => {
        if (cancelled) return;
        setSession(me);
        setOrganizations(orgs);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function createCustomer(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.platformCreateCustomer({ name, adminEmail, reference, requestId });
      setCreated(result);
      setName("");
      setAdminEmail("");
      setReference("");
      setRequestId(newRequestId()); // the next customer is a new request; a failed attempt keeps its id so a retry is recognised
      setCreating(false);
      setReload((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const tabClass = (active: boolean) =>
    `inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium ${active ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800"}`;

  return (
    <div className="space-y-5">
      <div className="flex gap-1 border-b border-slate-200" role="tablist" aria-label="Super Admin sections">
        <button type="button" role="tab" aria-selected={tab === "customers"} className={tabClass(tab === "customers")} onClick={() => setTab("customers")}>
          <Building2 className="h-4 w-4" /> Customers
        </button>
        <button type="button" role="tab" aria-selected={tab === "audit"} className={tabClass(tab === "audit")} onClick={() => setTab("audit")}>
          <ScrollText className="h-4 w-4" /> Audit log
        </button>
      </div>

      {tab === "audit" ? (
        <AuditPanel />
      ) : selected && session ? (
        <OrganizationPanel
          id={selected}
          session={session}
          onBack={() => setSelected(null)}
          onChanged={() => setReload((n) => n + 1)}
          onDeleted={(deleted) => {
            // Back to the list, which is refreshed so the deleted customer is gone from it.
            setSelected(null);
            setCreated(null);
            setDeletedName(deleted);
            setReload((n) => n + 1);
          }}
        />
      ) : (
        <>
          {error && <Alert>{error}</Alert>}
          {deletedName && (
            <Alert tone="green">
              <strong>{deletedName}</strong> was deleted, together with its data. The audit log keeps a record of it.{" "}
              <button type="button" className="font-medium underline" onClick={() => setDeletedName(null)}>
                Dismiss
              </button>
            </Alert>
          )}
          {created?.credentials && <CredentialsCard title={`${created.workspaceName} was created.`} credentials={created.credentials} onDismiss={() => setCreated(null)} />}
          {created && !created.credentials && (
            <Alert tone="amber">
              <strong>{created.workspaceName}</strong> had already been created by this request, so nothing new was made. Its temporary password was shown once and can&apos;t be shown again: open the
              workspace and use <strong>Reissue temporary password</strong> if it was lost.{" "}
              <button type="button" className="font-medium underline" onClick={() => setCreated(null)}>
                Dismiss
              </button>
            </Alert>
          )}

          <section className="card" aria-labelledby="customers-heading">
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
              <div className="min-w-0 flex-1">
                <h2 id="customers-heading" className="text-lg font-semibold">Customer workspaces</h2>
                <p className="text-sm text-slate-500">{organizations ? `${organizations.length} workspace${organizations.length === 1 ? "" : "s"}` : "Loading…"}</p>
              </div>
              <button type="button" className="btn btn-dark" onClick={() => setCreating(!creating)} aria-expanded={creating}>
                <Plus className="h-4 w-4" /> New customer
              </button>
            </div>

            {creating && (
              <form onSubmit={(e) => void createCustomer(e)} className="flex flex-wrap items-end gap-3 border-b border-slate-100 bg-slate-50 px-5 py-4">
                <label className="min-w-48 flex-1">
                  <span className="label">Company / workspace name</span>
                  <input className="input" required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="min-w-56 flex-1">
                  <span className="label">Customer Admin&apos;s email (their login ID)</span>
                  <input className="input" type="email" required placeholder="admin@customer.com" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
                </label>
                <label className="min-w-40 flex-1">
                  <span className="label">Customer reference ID (optional)</span>
                  <input className="input" maxLength={40} placeholder="e.g. CUST-0042" value={reference} onChange={(e) => setReference(e.target.value)} />
                </label>
                <button type="submit" className="btn btn-dark" disabled={busy}>
                  {busy ? <Spinner className="h-4 w-4" /> : <Plus className="h-4 w-4" />} Create customer
                </button>
                <p className="w-full text-xs text-slate-500">
                  Creates an isolated workspace and the Customer Admin&apos;s account with a random temporary password, which is shown once on the next screen. You send the login page, login ID and
                  temporary password to the customer yourself; they must choose their own password at their first sign-in. The reference is for your own records and is never used to sign in.
                </p>
              </form>
            )}

            {!organizations && !error && (
              <div className="flex justify-center py-12 text-slate-400">
                <Spinner className="h-6 w-6" />
              </div>
            )}
            {organizations && organizations.length === 0 && <EmptyState icon={Building2} title="No customers yet" />}
            {organizations && organizations.length > 0 && (
              <ul className="divide-y divide-slate-100">
                {organizations.map((o) => (
                  <li key={o.id}>
                    <button type="button" className="flex w-full flex-wrap items-center gap-3 px-5 py-3 text-left hover:bg-slate-50" onClick={() => setSelected(o.id)} aria-label={`Open ${o.name}`}>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-slate-800">
                          {o.name} {o.reference && <span className="ml-1 text-xs font-normal text-slate-500">{o.reference}</span>}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          {o.memberCount} {o.memberCount === 1 ? "person" : "people"} · created {formatDate(o.createdAt)} · {o.lastLoginAt ? `last sign-in ${formatDate(o.lastLoginAt)}` : "no sign-ins yet"}
                          {o.activation.loginId ? ` · login ID ${o.activation.loginId}` : ""}
                        </p>
                      </div>
                      {activationBadge(o)}
                      <Badge tone={o.status === "suspended" ? "red" : "green"}>{o.status === "suspended" ? "Suspended" : "Active"}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
