"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Lock, Plus, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert, Badge, Spinner, formatDate } from "@/components/ui";
import { api } from "@/lib/api";
import {
  FLAG_KIND_LABEL,
  NOTE_GROUPS,
  NOTE_ORIGINS,
  NOTE_ORIGIN_LABEL,
  NOTE_SECTION_SHORT,
  NOT_DISCUSSED,
  toSubmission,
  type NoteContent,
  type NoteDTO,
  type NoteGroup,
  type NoteItem,
  type NoteOrigin,
  type NoteSectionKey,
} from "@/lib/consultations";

/** Where a line a doctor adds most likely comes from: only a starting point, they can change it. */
const DEFAULT_ORIGIN: Record<NoteSectionKey, NoteOrigin> = {
  chief_complaint: "patient_reported",
  history: "patient_reported",
  medications_allergies: "patient_reported",
  findings: "clinician_observation",
  assessment: "clinician_assessment",
  investigations: "clinician_decision",
  medication_decisions: "clinician_decision",
  counselling_followup: "advice_given",
  open_questions: "advice_given",
};

/** The transcript lines a statement was taken from, as small links (the screen reader hears "Show transcript line 5"). */
function Evidence({ numbers, onOpen }: { numbers: number[]; onOpen: (n: number) => void }) {
  if (numbers.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1" aria-label="From the transcript">
      {numbers.map((n) => (
        <button key={n} type="button" onClick={() => onOpen(n)} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600 tabular-nums hover:bg-slate-200" aria-label={`Show transcript line ${n}`}>
          [{n}]
        </button>
      ))}
    </span>
  );
}

let counter = 0;
const newItemId = () => `new-${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * The draft note, for the doctor to read, correct and approve: four headings (chief complaint and symptoms, relevant history, assessment, plan and
 * follow-up) over the nine sections the system stores. Every line says who it came from (what the patient reported, what the doctor observed or
 * decided) and links to the part of the transcript it was taken from; a heading with nothing under it says "Not discussed". Saving keeps a new
 * version and never overwrites an earlier one. Approving is a deliberate act and is only possible once every safety flag has been marked as
 * reviewed. An approved note can't be edited: reopening it starts a new version and leaves the approved one as it was.
 *
 * The header and the actions stay where they are while the note scrolls between them, so Save draft and Approve note are never out of reach.
 */
export function NoteEditor({
  consultationId,
  note,
  onChanged,
  onEvidence,
}: {
  consultationId: string;
  note: NoteDTO;
  /** The saved version changed (saved, approved, reopened): reload everything. */
  onChanged: () => void;
  onEvidence: (segment: number) => void;
}) {
  const approved = note.approvedAt !== null;
  const [content, setContent] = useState<NoteContent>(note.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"approve" | "reopen" | null>(null);
  const [openLines, setOpenLines] = useState<ReadonlySet<string>>(() => new Set());
  const [flagsOpen, setFlagsOpen] = useState(() => note.content.flags.some((f) => !f.resolved));

  const original = useMemo(() => JSON.stringify(toSubmission(note.content)), [note.content]);
  const dirty = JSON.stringify(toSubmission(content)) !== original;
  const unresolved = content.flags.filter((f) => !f.resolved);
  const hasBlankLine = content.sections.some((s) => s.items.some((i) => i.text.trim() === ""));
  const canApprove = !saving && unresolved.length === 0 && !hasBlankLine;

  const setItems = (key: NoteSectionKey, change: (items: NoteItem[]) => NoteItem[]) =>
    setContent((c) => ({ ...c, sections: c.sections.map((s) => (s.key === key ? { ...s, items: change(s.items) } : s)) }));
  const toggleLine = (id: string) =>
    setOpenLines((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  /** The lines under one heading, in the order of the sections it covers, each remembering which stored section it belongs to. */
  const linesOf = (group: NoteGroup) => group.sections.flatMap((key) => (content.sections.find((s) => s.key === key)?.items ?? []).map((item) => ({ item, key: key as NoteSectionKey })));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.saveConsultationNote(consultationId, note.version, toSubmission(content));
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Clinical note" className="card flex min-h-0 flex-col lg:overflow-hidden">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-slate-900">Clinical note</h2>
          <p className="text-xs text-slate-500">
            {approved ? `Version ${note.version}, approved ${formatDate(note.approvedAt!, true)}` : `Draft, version ${note.version}. The AI wrote it from the transcript. Check it before you approve.`}
          </p>
        </div>
        {approved ? (
          <Badge tone="green">
            <Lock className="h-3 w-3" /> Approved
          </Badge>
        ) : (
          <Badge tone="amber">Not approved</Badge>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {content.flags.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50" role="group" aria-label="Items to review">
            <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-amber-900" aria-expanded={flagsOpen} onClick={() => setFlagsOpen((o) => !o)}>
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span className="flex-1">{unresolved.length === 0 ? "Everything flagged has been reviewed" : `${unresolved.length} ${unresolved.length === 1 ? "item needs" : "items need"} your review`}</span>
              <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${flagsOpen ? "rotate-180" : ""}`} aria-hidden />
            </button>
            {flagsOpen && (
              <ul className="space-y-1.5 border-t border-amber-200 px-3 py-2">
                {content.flags.map((f) => (
                  <li key={f.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={f.resolved}
                      disabled={approved}
                      aria-label={`Reviewed: ${f.text}`}
                      onChange={(e) => setContent((c) => ({ ...c, flags: c.flags.map((x) => (x.id === f.id ? { ...x, resolved: e.target.checked } : x)) }))}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-slate-800">
                        <span className="mr-1.5 text-xs font-semibold tracking-wide text-amber-800 uppercase">{FLAG_KIND_LABEL[f.kind]}</span>
                        {f.text}
                      </p>
                      <Evidence numbers={f.evidence} onOpen={onEvidence} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="divide-y divide-slate-100">
          {NOTE_GROUPS.map((group) => {
            const lines = linesOf(group);
            return (
              <div key={group.key} className="py-3 first:pt-0" role="group" aria-label={group.title}>
                <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">{group.title}</h3>
                {lines.length === 0 && <p className="mb-1.5 text-sm text-slate-400 italic">{NOT_DISCUSSED}</p>}
                <ul className="space-y-2.5">
                  {lines.map(({ item, key }) => (
                    <li key={item.id}>
                      {approved ? (
                        <p className="text-sm whitespace-pre-wrap text-slate-900">{item.text}</p>
                      ) : (
                        <textarea
                          aria-label={`${group.title}: line`}
                          className="input field-sizing-content min-h-[2.5rem] resize-y"
                          rows={Math.max(1, Math.ceil(item.text.length / 60))}
                          maxLength={2000}
                          value={item.text}
                          onChange={(e) => setItems(key, (list) => list.map((i) => (i.id === item.id ? { ...i, text: e.target.value } : i)))}
                        />
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                        {group.sections.length > 1 && <span className="font-medium text-slate-600">{NOTE_SECTION_SHORT[key]}</span>}
                        <span>{NOTE_ORIGIN_LABEL[item.origin]}</span>
                        {item.byDoctor && <span>· Edited by you</span>}
                        <Evidence numbers={item.evidence} onOpen={onEvidence} />
                        {!approved && (
                          <button type="button" className="ml-auto rounded px-1 text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline" aria-expanded={openLines.has(item.id)} onClick={() => toggleLine(item.id)}>
                            Details
                          </button>
                        )}
                      </div>
                      {!approved && openLines.has(item.id) && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-2 text-xs text-slate-600">
                          <label className="flex items-center gap-1.5">
                            Who this came from
                            <select
                              aria-label="Who this came from"
                              className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-700"
                              value={item.origin}
                              onChange={(e) => setItems(key, (list) => list.map((i) => (i.id === item.id ? { ...i, origin: e.target.value as NoteOrigin } : i)))}
                            >
                              {NOTE_ORIGINS.map((o) => (
                                <option key={o} value={o}>
                                  {NOTE_ORIGIN_LABEL[o]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button type="button" className="btn btn-ghost ml-auto px-2 py-1 text-xs text-red-700" aria-label="Remove this line" onClick={() => setItems(key, (list) => list.filter((i) => i.id !== item.id))}>
                            <Trash2 className="h-3.5 w-3.5" /> Remove
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                {!approved && (
                  <button
                    type="button"
                    className="btn btn-ghost mt-2 px-2 py-1 text-xs"
                    onClick={() => setItems(group.addTo, (list) => [...list, { id: newItemId(), text: "", origin: DEFAULT_ORIGIN[group.addTo], evidence: [], byDoctor: true }])}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add a line
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {note.versions.length > 1 && (
          <details className="text-sm text-slate-600">
            <summary className="cursor-pointer font-medium">Earlier versions ({note.versions.length - 1})</summary>
            <ul className="mt-1 space-y-0.5 pl-4">
              {note.versions.map((v) => (
                <li key={v.version}>
                  Version {v.version}, {v.source === "ai" ? "AI draft" : "your edit"}, {formatDate(v.createdAt, true)}
                  {v.approvedAt ? " (approved)" : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="sticky bottom-0 z-10 shrink-0 border-t border-slate-200 bg-white px-4 py-2.5">
        {error && (
          <div className="mb-2">
            <Alert>{error}</Alert>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {approved ? (
            <button type="button" className="btn btn-outline" onClick={() => setConfirming("reopen")}>
              Reopen to make changes
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-outline" disabled={!dirty || saving || hasBlankLine} onClick={() => void save()}>
                {saving && <Spinner />} Save draft
              </button>
              <button type="button" className="btn btn-dark" disabled={!canApprove} onClick={() => setConfirming("approve")}>
                <Check className="h-4 w-4" /> {dirty ? "Save and approve" : "Approve note"}
              </button>
              <span className="min-w-0 flex-1 basis-40 text-xs text-amber-700">
                {dirty && <span className="block">You have unsaved changes.</span>}
                {unresolved.length > 0 && <span className="block">Mark every flagged item as reviewed to approve.</span>}
                {hasBlankLine && <span className="block">Fill in or remove the empty line first.</span>}
              </span>
            </>
          )}
        </div>
      </div>

      {confirming === "approve" && (
        <ConfirmDialog
          key="approve"
          title="Approve this note?"
          confirmLabel={dirty ? "Save and approve" : "Approve note"}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            let version = note.version;
            if (dirty) version = await api.saveConsultationNote(consultationId, note.version, toSubmission(content));
            try {
              await api.approveConsultationNote(consultationId, version);
            } catch (err) {
              if (dirty) onChanged(); // the edits WERE saved as a new version: show that version, so the next try starts from it
              throw err;
            }
            setConfirming(null);
            onChanged();
          }}
        >
          <p className="text-sm text-slate-700">
            By approving, you confirm that you have read this note and that it correctly reflects the consultation. The approved version cannot be changed. If something needs to change later, you can reopen it and a new version will be made.
            {dirty ? " Your changes will be saved first, as the version that is approved." : ""}
          </p>
        </ConfirmDialog>
      )}
      {confirming === "reopen" && (
        <ConfirmDialog
          key="reopen"
          title="Reopen this note?"
          confirmLabel="Reopen"
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            await api.reopenConsultationNote(consultationId);
            setConfirming(null);
            onChanged();
          }}
        >
          <p className="text-sm text-slate-700">The approved version stays exactly as it is. A new copy opens for editing, and it will need to be approved again.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
