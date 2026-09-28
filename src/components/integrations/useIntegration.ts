"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { IntegrationDTO, IntegrationType, SyncRunSummaryDTO } from "@/lib/integrations";

/** Loads one integration and its own sync history; polls while it is syncing. */
export function useIntegration(type: IntegrationType) {
  const [integration, setIntegration] = useState<IntegrationDTO | null>(null);
  const [runs, setRuns] = useState<SyncRunSummaryDTO[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const { integrations } = await api.listIntegrations();
      const found = integrations.find((i) => i.type === type) ?? null;
      setIntegration(found);
      if (found) setRuns(await api.integrationRuns(found.id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [type]);

  useEffect(() => {
    queueMicrotask(() => void reload());
  }, [reload]);

  // Syncs run in the background on the server: poll for progress until the run finishes.
  const syncing = integration?.status === "syncing";
  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(() => void reload(), 2000);
    return () => clearInterval(t);
  }, [syncing, reload]);

  return { integration, runs, error, reload, setIntegration };
}
