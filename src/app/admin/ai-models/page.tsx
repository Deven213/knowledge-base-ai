"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Check, KeyRound, RefreshCw } from "lucide-react";
import { Alert, Badge, PageHeader, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import type { AISettingsDTO, ProviderId, ProviderStatusDTO } from "@/lib/types";

const DESCRIPTIONS: Record<ProviderId, string> = {
  openai: "OpenAI GPT models via the OpenAI API.",
  anthropic: "Anthropic Claude models via the Anthropic API.",
  gemini: "Google Gemini models via the Gemini API.",
};

function ProviderCard({ status, onSaved }: { status: ProviderStatusDTO; onSaved: (s: AISettingsDTO) => void }) {
  const [model, setModel] = useState(status.model.source === "ui" ? (status.model.value ?? "") : "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(value: string | null) {
    setBusy(true);
    setMessage(null);
    try {
      onSaved(await api.updateAISettings({ models: { [status.provider]: value } }));
      setMessage({ ok: true, text: value ? "Model saved." : "Override cleared. Using .env value." });
      if (!value) setModel("");
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card flex flex-col p-5">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{status.label}</h3>
          <p className="text-xs text-slate-500">{DESCRIPTIONS[status.provider]}</p>
        </div>
        {status.ready ? <Badge tone="green">Ready</Badge> : <Badge tone="amber">Not configured</Badge>}
      </div>

      <div className="mb-4 rounded-lg bg-slate-50 px-3 py-2.5">
        <div className="flex items-center gap-2 text-sm">
          <KeyRound className="h-4 w-4 text-slate-400" />
          <span className="font-medium text-slate-700">API key</span>
          {status.key.configured ? (
            <span className="ml-auto font-mono text-xs text-emerald-700">••••{status.key.last4 ?? ""} · from .env</span>
          ) : (
            <span className="ml-auto text-xs text-amber-700">Missing</span>
          )}
        </div>
        {!status.key.configured && (
          <p className="mt-1.5 text-xs text-slate-500">
            Add <code className="rounded bg-white px-1 py-0.5 font-mono text-slate-700">{status.key.envVar}=…</code> to the{" "}
            <code className="font-mono">.env</code> file and restart the server.
          </p>
        )}
      </div>

      <form
        className="mt-auto"
        onSubmit={(e) => {
          e.preventDefault();
          void save(model.trim() || null);
        }}
      >
        <label htmlFor={`model-${status.provider}`} className="label">
          Model ID
        </label>
        <div className="flex gap-2">
          <input
            id={`model-${status.provider}`}
            className="input font-mono"
            spellCheck={false}
            placeholder={status.model.envValue ?? `Set ${status.model.envVar} or enter here`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <button type="submit" className="btn btn-outline" disabled={busy}>
            {busy ? <Spinner /> : model.trim() ? "Save" : "Clear"}
          </button>
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          {status.model.value ? (
            <>
              Using <span className="font-mono text-slate-700">{status.model.value}</span>{" "}
              {status.model.source === "ui" ? "(set here, overrides .env)" : `(from ${status.model.envVar})`}
            </>
          ) : (
            "No model set. Answers need a model ID."
          )}
        </p>
        {message && <p className={`mt-1 text-xs ${message.ok ? "text-emerald-700" : "text-red-600"}`}>{message.text}</p>}
      </form>
    </div>
  );
}

export default function AIModelSettingsPage() {
  const [settings, setSettings] = useState<AISettingsDTO | null>(null);
  const [selected, setSelected] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api
        .getAISettings()
        .then((s) => {
          setSettings(s);
          setSelected(s.activeProvider);
          setError(null);
        })
        .catch((err: Error) => setError(err.message)),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function updateActive() {
    if (!selected) return;
    setSaving(true);
    setNotice(null);
    try {
      const s = await api.updateAISettings({ activeProvider: selected });
      setSettings(s);
      setNotice(`Chat now uses ${s.providers.find((p) => p.provider === s.activeProvider)?.label}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const active = settings?.providers.find((p) => p.provider === settings.activeProvider);
  const chosen = settings?.providers.find((p) => p.provider === selected);

  return (
    <>
      <PageHeader
        back
        icon={Bot}
        title="AI Model Settings"
        subtitle="Choose which AI provider answers questions, and configure models"
        actions={
          <button type="button" className="btn btn-outline" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      {!settings ? (
        <div className="flex justify-center py-14 text-slate-400">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <>
          <section className="card mb-6 p-5">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Bot className="h-5 w-5 text-slate-500" /> Current AI Model
            </h2>
            <p className="mb-4 text-sm text-slate-500">The provider used for every chat answer</p>

            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-4 py-3">
              <div>
                <p className="font-medium">{active?.label}</p>
                <p className="text-xs text-slate-500">
                  Model: <span className="font-mono">{active?.model.value ?? "not set"}</span>
                </p>
              </div>
              {active?.ready ? <Badge tone="green">Active · Ready</Badge> : <Badge tone="amber">Active · Needs setup</Badge>}
            </div>

            <fieldset>
              <legend className="label">Select provider</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {settings.providers.map((p) => (
                  <label
                    key={p.provider}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                      selected === p.provider ? "border-brand-500 bg-brand-50" : "border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="radio"
                      name="provider"
                      className="accent-teal-600"
                      checked={selected === p.provider}
                      onChange={() => setSelected(p.provider)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{p.label}</span>
                      <span className="block truncate font-mono text-xs text-slate-500">{p.model.value ?? "no model"}</span>
                    </span>
                    {p.ready && <Check className="h-4 w-4 text-emerald-600" aria-label="ready" />}
                  </label>
                ))}
              </div>
            </fieldset>

            {chosen && !chosen.ready && (
              <p className="mt-3 text-sm text-amber-700">
                {chosen.label} isn&apos;t ready yet: {!chosen.key.configured && `add ${chosen.key.envVar} to .env`}
                {!chosen.key.configured && !chosen.model.value && " and "}
                {!chosen.model.value && "set a model ID below"}.
              </p>
            )}

            <button
              type="button"
              className="btn btn-dark mt-4 w-full"
              disabled={saving || selected === settings.activeProvider}
              onClick={() => void updateActive()}
            >
              {saving && <Spinner />}
              Update AI Model
            </button>
            {notice && <p className="mt-2 text-center text-sm text-emerald-700">{notice}</p>}
          </section>

          <h2 className="mb-3 text-lg font-semibold">Provider configuration</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {settings.providers.map((p) => (
              <ProviderCard key={p.provider} status={p} onSaved={setSettings} />
            ))}
          </div>
          <p className="mt-4 text-xs text-slate-500">
            API keys are read only from the server&apos;s <code className="font-mono">.env</code> file. They are never stored in
            the database or sent to the browser; only the last four characters are shown.
          </p>
        </>
      )}
    </>
  );
}
