"use client";

import { useId, useState } from "react";
import { Alert, Modal, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import {
  CONSENT_GIVEN_BY,
  CONSENT_LANGUAGES,
  CONSENT_METHODS,
  CONSENT_TEXT,
  CONSENT_VERSION,
  type ConsentGivenBy,
  type ConsentLanguage,
  type ConsentMethod,
} from "@/lib/consultation-consent";
import { LANGUAGE_HINT_LABEL, LANGUAGE_HINTS, type ConsultationDetailDTO, type LanguageHint } from "@/lib/consultations";

const LANGUAGE_NAME: Record<ConsentLanguage, string> = { en: "English", hi: "हिन्दी", gu: "ગુજરાતી" };

/**
 * Starting a consultation. Nothing can be recorded until the person who will be recorded (or their parent or guardian) has been told, in a
 * language they understand, what will happen, and the doctor has said that they agreed. The server stores who agreed, how, in which language
 * and exactly which wording, and refuses to create the consultation without it.
 */
export function NewConsultationDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (consultation: ConsultationDetailDTO) => void }) {
  const uid = useId();
  const [patient, setPatient] = useState("");
  const [hint, setHint] = useState<LanguageHint>("auto");
  const [language, setLanguage] = useState<ConsentLanguage>("en");
  const [givenBy, setGivenBy] = useState<ConsentGivenBy | null>(null);
  const [method, setMethod] = useState<ConsentMethod | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = CONSENT_TEXT[language];
  const ready = patient.trim() !== "" && givenBy !== null && method !== null && confirmed;

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createConsultation({ patientLabel: patient.trim(), languageHint: hint, consent: { version: CONSENT_VERSION, language, givenBy: givenBy!, method: method!, confirmed: true } }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title="New consultation"
      size="wide"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button type="button" className="btn btn-outline" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-dark" disabled={!ready || busy} onClick={() => void submit()}>
            {busy && <Spinner />} Start consultation
          </button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div>
          <label className="label" htmlFor={`${uid}-patient`}>
            Patient (name or record number)
          </label>
          <input id={`${uid}-patient`} className="input" value={patient} maxLength={120} autoComplete="off" onChange={(e) => setPatient(e.target.value)} />
          <p className="mt-1 text-xs text-slate-500">Only you can see this. It is stored encrypted.</p>
        </div>

        <div>
          <label className="label" htmlFor={`${uid}-language`}>
            Language of the conversation
          </label>
          <select id={`${uid}-language`} className="input" value={hint} onChange={(e) => setHint(e.target.value as LanguageHint)}>
            {LANGUAGE_HINTS.map((h) => (
              <option key={h} value={h}>
                {LANGUAGE_HINT_LABEL[h]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">A hint only. Gujarati, Hindi and English can be mixed in the same visit.</p>
        </div>

        <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-sm font-semibold text-slate-800">Consent to record</legend>
          <div role="radiogroup" aria-label="Language to read the consent in" className="inline-flex rounded-lg bg-slate-100 p-0.5 text-sm">
            {CONSENT_LANGUAGES.map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={language === l}
                onClick={() => setLanguage(l)}
                className={`rounded-md px-3 py-1 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${language === l ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
              >
                {LANGUAGE_NAME[l]}
              </button>
            ))}
          </div>
          <div lang={language} className="rounded-lg bg-slate-50 p-3 text-sm text-slate-800">
            <p className="font-semibold">{text.title}</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              {text.statements.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
          <Alert tone="amber">This wording is a draft. Your clinical and legal lead should review it before it is used with real patients.</Alert>

          <div role="radiogroup" aria-label="Who agreed" className="space-y-1">
            <p className="text-sm font-medium text-slate-700">Who agreed?</p>
            {CONSENT_GIVEN_BY.map((g) => (
              <label key={g.value} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" name={`${uid}-by`} checked={givenBy === g.value} onChange={() => setGivenBy(g.value)} /> {g.label}
              </label>
            ))}
          </div>
          <div role="radiogroup" aria-label="How consent was given" className="space-y-1">
            <p className="text-sm font-medium text-slate-700">How was it given?</p>
            {CONSENT_METHODS.map((m) => (
              <label key={m.value} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" name={`${uid}-how`} checked={method === m.value} onChange={() => setMethod(m.value)} /> {m.label}
              </label>
            ))}
          </div>
          <label className="flex items-start gap-2 text-sm font-medium text-slate-900">
            <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I have explained this to the patient (or their parent or legal guardian) and they agreed to the recording.</span>
          </label>
        </fieldset>

        {error && <Alert>{error}</Alert>}
      </form>
    </Modal>
  );
}
