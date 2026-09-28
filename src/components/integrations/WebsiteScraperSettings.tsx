"use client";

import { useState } from "react";
import { CheckCircle2, RefreshCw, Search } from "lucide-react";
import { api } from "@/lib/api";
import { CRAWL_DEPTHS, MAX_PAGE_OPTIONS } from "@/lib/integrations";
import { Spinner } from "../ui";
import type { IntegrationContext } from "./IntegrationPage";

/** Website URL, test, crawl depth, page limit and Sync Now (website-only controls). */
export function WebsiteScraperSettings({ integration: i, onChange, notify }: IntegrationContext) {
  const [url, setUrl] = useState(i.configuration.url ?? "");
  const [busy, setBusy] = useState<"test" | "save" | "sync" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const syncing = i.status === "syncing";
  const off = !i.enabled;
  const running = i.lastRun?.status === "running" ? i.lastRun : null;

  async function act<T>(name: "test" | "save" | "sync", fn: () => Promise<T>, done?: (r: T) => void) {
    setBusy(name);
    setError(null);
    try {
      done?.(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const save = (patch: Record<string, unknown>) =>
    act("save", () => api.updateIntegration(i.id, { configuration: patch }), (u) => {
      onChange(u);
      setUrl(u.configuration.url ?? "");
    });

  const test = () =>
    act("test", () => api.testWebsite(url), (r) =>
      setTestResult(`Reachable: “${r.title || r.finalUrl}” (${r.textLength.toLocaleString()} characters, ${r.linkCount} links).`),
    );

  const sync = () =>
    act(
      "sync",
      async () => {
        // Save an edited URL first so the sync uses what the user sees.
        if (url.trim() !== (i.configuration.url ?? "")) {
          const u = await api.updateIntegration(i.id, { configuration: { url: url.trim() } });
          setUrl(u.configuration.url ?? "");
        }
        return api.syncIntegration(i.id);
      },
      () => {
        notify("Website sync started.");
        onChange();
      },
    );

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="website-url" className="label">Website URL</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="website-url"
            type="url"
            inputMode="url"
            className="input"
            placeholder="https://example.com/docs"
            value={url}
            disabled={off || syncing}
            onChange={(e) => {
              setUrl(e.target.value);
              setTestResult(null);
            }}
            onBlur={() => url.trim() !== (i.configuration.url ?? "") && void save({ url: url.trim() })}
          />
          <button type="button" className="btn btn-outline shrink-0" disabled={off || !url.trim() || !!busy} onClick={() => void test()}>
            {busy === "test" ? <Spinner /> : <Search className="h-4 w-4" />}
            {busy === "test" ? "Testing URL…" : "Test"}
          </button>
        </div>
        {testResult && (
          <p className="mt-1 flex items-start gap-1 text-xs text-emerald-700">
            <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" /> {testResult}
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="crawl-depth" className="label">Crawl depth</label>
          <select id="crawl-depth" className="input" disabled={off || syncing} value={i.configuration.depth ?? 1} onChange={(e) => void save({ depth: Number(e.target.value) })}>
            {CRAWL_DEPTHS.map((d) => (
              <option key={d} value={d}>
                {d} {d === 1 ? "(page + its links)" : "levels of links"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="max-pages" className="label">Max pages</label>
          <select id="max-pages" className="input" disabled={off || syncing} value={i.configuration.maxPages ?? 25} onChange={(e) => void save({ maxPages: Number(e.target.value) })}>
            {MAX_PAGE_OPTIONS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-xs text-slate-500">Only pages on the same website are followed. Linked PDF, DOCX, TXT and MD files are imported too.</p>

      <button type="button" className="btn btn-dark w-full sm:w-auto" disabled={off || syncing || !!busy || !url.trim()} onClick={() => void sync()}>
        {syncing || busy === "sync" ? <Spinner /> : <RefreshCw className="h-4 w-4" />}
        {syncing || busy === "sync" ? "Syncing website…" : "Sync Now"}
      </button>
      {running && (
        <p className="text-sm text-slate-500" role="status">
          Fetching pages… {running.filesFound} processed so far.
        </p>
      )}
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
