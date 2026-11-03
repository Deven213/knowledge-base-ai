"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Mic, Plus, ShieldCheck, Stethoscope } from "lucide-react";
import { Alert, Badge, EmptyState, formatDate, PageHeader, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import type { ConsultationsOverviewDTO } from "@/lib/consultations";
import { NewConsultationDialog } from "./NewConsultationDialog";
import { STATUS_LABEL, STATUS_TONE } from "./status";

/** The doctor's own consultations, newest first. Nobody else's are ever shown here: the server only returns the signed-in doctor's. */
export function ConsultationsPage() {
  const router = useRouter();
  const [data, setData] = useState<ConsultationsOverviewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.consultations());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading on mount
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        icon={Stethoscope}
        title="Consultations"
        subtitle="Record a visit, review the AI's draft of the clinical note, and approve it"
        actions={
          <button type="button" className="btn btn-dark" onClick={() => setCreating(true)} disabled={!data}>
            <Plus className="h-4 w-4" /> New consultation
          </button>
        }
      />
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-600">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        <span>Only you can open your consultations. Recordings, transcripts and notes are stored encrypted, and each time you open or play one it is recorded in the audit log.</span>
      </div>

      {error && <Alert>{error}</Alert>}
      {!data && !error && (
        <div className="flex items-center gap-2 py-10 text-sm text-slate-500">
          <Spinner /> Loading…
        </div>
      )}
      {data && data.consultations.length === 0 && (
        <div className="card">
          <EmptyState icon={Mic} title="No consultations yet">
            Start one when the patient is with you. You will confirm their consent first, then record.
          </EmptyState>
        </div>
      )}
      {data && data.consultations.length > 0 && (
        <div className="card divide-y divide-slate-100">
          {data.consultations.map((c) => (
            <Link key={c.id} href={`/admin/consultations/${c.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-900">{c.patientLabel}</p>
                <p className="text-xs text-slate-500">{formatDate(c.createdAt, true)}</p>
              </div>
              <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
            </Link>
          ))}
        </div>
      )}

      {creating && (
        <NewConsultationDialog
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            router.push(`/admin/consultations/${c.id}`);
          }}
        />
      )}
    </>
  );
}
