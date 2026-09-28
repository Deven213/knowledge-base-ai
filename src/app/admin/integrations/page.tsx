"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Plug } from "lucide-react";
import { useFeatures } from "@/components/features/FeatureProvider";
import { formatDateTime, INTEGRATION_UI, IntegrationStatusBadge } from "@/components/integrations/parts";
import { Alert, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { INTEGRATION_META, INTEGRATION_TYPES, type IntegrationDTO } from "@/lib/integrations";

/** Overview only: one card per integration, each opening its own page. */
export default function IntegrationsPage() {
  const features = useFeatures();
  const [integrations, setIntegrations] = useState<IntegrationDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listIntegrations()
      .then((r) => setIntegrations(r.integrations))
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader back icon={Plug} title="Integrations" subtitle="Connect external sources to your Knowledge Base." />
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        {INTEGRATION_TYPES.map((type) => {
          const meta = INTEGRATION_META[type];
          const ui = INTEGRATION_UI[type];
          const Icon = ui.icon;
          const available = features[meta.feature];
          const integration = integrations?.find((i) => i.type === type);
          return (
            <section key={type} className="card flex flex-col p-5" aria-labelledby={`int-${type}`}>
              <div className={`${available ? ui.iconClassName : "bg-slate-100 text-slate-400"} mb-3 flex h-10 w-10 items-center justify-center rounded-xl text-white`}>
                <Icon className="h-5 w-5" />
              </div>
              <h2 id={`int-${type}`} className="font-semibold text-slate-900">
                {meta.name}
              </h2>
              <p className="mt-1 flex-1 text-sm text-slate-500">{meta.summary}</p>
              {available ? (
                <>
                  {integration && (
                    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                      <IntegrationStatusBadge integration={integration} />
                      <span>Last sync: {formatDateTime(integration.lastSyncAt)}</span>
                    </div>
                  )}
                  <Link href={meta.href} className="btn btn-dark mt-4">
                    Open <ArrowRight className="h-4 w-4" />
                  </Link>
                </>
              ) : (
                <p className="mt-4 text-sm text-slate-500">
                  Turned off in{" "}
                  <Link href="/settings/features" className="font-medium text-brand-700 hover:underline">
                    Feature Management
                  </Link>
                  .
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
