"use client";

import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { INTEGRATION_META, INTEGRATIONS_HREF, type IntegrationDTO, type IntegrationType } from "@/lib/integrations";
import { Alert, PageHeader, Spinner, Switch } from "../ui";
import { formatDateTime, INTEGRATION_UI, IntegrationStatusBadge, LastSyncCard } from "./parts";
import { SyncHistory } from "./SyncHistory";
import { useIntegration } from "./useIntegration";

export interface IntegrationContext {
  integration: IntegrationDTO;
  /** Pass the updated integration from an API call, or nothing to reload from the server. */
  onChange: (updated?: IntegrationDTO) => void;
  notify: (text: string, ok?: boolean) => void;
}

/**
 * Shared page layout for one integration: header (Back → Integrations), status + on/off switch,
 * the integration's own settings, its last sync and its own sync history.
 */
export function IntegrationPage({ type, children }: { type: IntegrationType; children: (ctx: IntegrationContext) => ReactNode }) {
  const meta = INTEGRATION_META[type];
  const ui = INTEGRATION_UI[type];
  const { integration, runs, error, reload, setIntegration } = useIntegration(type);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // Result of an OAuth redirect back to this page (?connected=… or ?error=…), then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const oauthError = params.get("error");
    if (!connected && !oauthError) return;
    queueMicrotask(() => setNotice(oauthError ? { text: oauthError, ok: false } : { text: `${meta.name} connected. Select a folder to sync.`, ok: true }));
    window.history.replaceState(null, "", window.location.pathname);
  }, [meta.name]);

  const ctx: IntegrationContext | null = integration && {
    integration,
    onChange: (updated) => (updated ? setIntegration(updated) : void reload()),
    notify: (text, ok = true) => setNotice({ text, ok }),
  };

  async function toggle(i: IntegrationDTO) {
    setToggling(true);
    setToggleError(null);
    try {
      const updated = await api.updateIntegration(i.id, { enabled: !i.enabled });
      setIntegration(updated);
      setNotice({ text: `${meta.name} turned ${updated.enabled ? "on" : "off"}.`, ok: true });
    } catch (err) {
      setToggleError((err as Error).message);
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader back={INTEGRATIONS_HREF} icon={ui.icon} iconClassName={ui.iconClassName} title={meta.name} subtitle={meta.description} />

      <div className="space-y-4">
        {notice && <Alert tone={notice.ok ? "green" : "red"}>{notice.text}</Alert>}
        {error && <Alert>{error}</Alert>}

        {!integration || !ctx ? (
          !error && (
            <div className="flex justify-center py-14 text-slate-400">
              <Spinner className="h-6 w-6" />
            </div>
          )
        ) : (
          <>
            <section className="card p-5" aria-label={`${meta.name} status`}>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-700">Status</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <IntegrationStatusBadge integration={integration} />
                    {integration.accountLabel && <span className="truncate">· {integration.accountLabel}</span>}
                    <span>· Last sync: {formatDateTime(integration.lastSyncAt)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-600">{integration.enabled ? "ON" : "OFF"}</span>
                  <Switch
                    checked={integration.enabled}
                    disabled={integration.status === "syncing"}
                    busy={toggling}
                    label={`${integration.enabled ? "Turn off" : "Turn on"} ${meta.name}`}
                    onChange={() => void toggle(integration)}
                  />
                </div>
              </div>
              {!integration.enabled && (
                <p className="mt-3 text-sm text-slate-500">
                  {meta.name} is off. Its settings, connection, imported documents and sync history are kept; syncing is blocked until you turn it on.
                </p>
              )}
              {toggleError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{toggleError}</p>}
            </section>

            <section
              className={`card p-5 ${integration.enabled ? "" : "opacity-60"}`}
              inert={!integration.enabled}
              aria-label={`${meta.name} settings`}
            >
              {children(ctx)}
            </section>

            <LastSyncCard run={integration.lastRun} unit={ui.unit} />
            <SyncHistory runs={runs} unit={ui.unit} />
          </>
        )}
      </div>
    </div>
  );
}
