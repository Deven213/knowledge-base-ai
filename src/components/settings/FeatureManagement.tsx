"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CheckCircle2, Link2, ToggleRight, XCircle } from "lucide-react";
import { FEATURE_CATEGORIES, featureDefinition, type FeatureKey, type FeatureState } from "@/lib/features";
import { Badge, PageHeader, Switch } from "../ui";
import { SettingsTabs } from "./SettingsTabs";

function StatusBadge({ f }: { f: FeatureState }) {
  if (f.status === "on") return <Badge tone="green">ON</Badge>;
  if (f.status === "unavailable") return <Badge tone="amber">Unavailable</Badge>;
  return <Badge tone="slate">OFF</Badge>;
}

export function FeatureManagement({ initial }: { initial: FeatureState[] }) {
  const router = useRouter();
  const [features, setFeatures] = useState(initial);
  const [busyKey, setBusyKey] = useState<FeatureKey | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const byKey = (key: FeatureKey) => features.find((f) => f.key === key)!;

  async function toggle(f: FeatureState) {
    const enabled = !f.enabled;
    setBusyKey(f.key);
    try {
      const res = await fetch(`/api/features/${f.key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = (await res.json().catch(() => null)) as { features?: FeatureState[]; error?: string } | null;
      if (!res.ok || !body?.features) throw new Error(body?.error ?? `Request failed (${res.status})`);

      // Mention features that lost (or regained) availability because of this change.
      const changed = body.features.filter((n) => n.key !== f.key && n.available !== byKey(n.key).available).map((n) => n.name);
      setFeatures(body.features);
      setToast({
        ok: true,
        text:
          `${f.name} ${enabled ? "enabled" : "disabled"}.` +
          (changed.length ? ` ${enabled ? "Now available again" : "Now unavailable"}: ${changed.join(", ")}.` : ""),
      });
      router.refresh(); // re-render server components: sidebar, page gates, availability everywhere
    } catch (err) {
      setToast({ ok: false, text: (err as Error).message });
    } finally {
      setBusyKey(null);
    }
  }

  const onCount = features.filter((f) => f.available).length;

  return (
    <>
      <PageHeader
        back
        icon={ToggleRight}
        title="Feature Management"
        subtitle="Control which modules are visible and available in your application."
      />
      <SettingsTabs />
      <p className="mb-4 text-sm text-slate-500">
        {onCount} of {features.length} modules available. Turning a feature off hides it and blocks its pages and API. No data
        is deleted.
      </p>

      <div className="space-y-6">
        {FEATURE_CATEGORIES.map((category) => (
          <section key={category} className="card overflow-hidden" aria-labelledby={`cat-${category}`}>
            <h2 id={`cat-${category}`} className="border-b border-slate-100 bg-slate-50/60 px-5 py-3 text-sm font-semibold text-slate-700">
              {category}
            </h2>
            <ul className="divide-y divide-slate-100">
              {features
                .filter((f) => f.category === category)
                .map((f) => {
                  const dep = f.dependsOn ? byKey(f.dependsOn) : null;
                  const blocked = !!(dep && !dep.available);
                  return (
                    <li key={f.key} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-medium text-slate-900">{f.name}</h3>
                          <StatusBadge f={f} />
                          {f.roadmap && <Badge tone="blue">Roadmap</Badge>}
                        </div>
                        <p className="mt-0.5 text-sm text-slate-500">{f.description}</p>
                        {dep && (
                          <p className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-slate-500">
                            <Link2 className="h-3.5 w-3.5" />
                            Depends on: <span className="font-medium text-slate-700">{dep.name}</span>
                            {blocked && (
                              <span className="text-amber-700">
                                {" "}
                                · {featureDefinition(f.dependsOn!).name} is off, so this can&apos;t be{" "}
                                {f.enabled ? "used. Its setting is kept and applies again when it's turned on." : "enabled."}
                              </span>
                            )}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-3 sm:justify-end">
                        <span className="w-8 text-right text-xs font-medium text-slate-500" aria-hidden="true">
                          {f.enabled ? "ON" : "OFF"}
                        </span>
                        <Switch
                          checked={f.enabled}
                          disabled={blocked}
                          busy={busyKey === f.key}
                          label={`${f.enabled ? "Disable" : "Enable"} ${f.name}`}
                          onChange={() => void toggle(f)}
                        />
                      </div>
                    </li>
                  );
                })}
            </ul>
          </section>
        ))}
      </div>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed right-4 bottom-4 z-50 flex max-w-sm items-start gap-2 rounded-lg px-4 py-3 text-sm text-white shadow-lg ${
            toast.ok ? "bg-slate-900" : "bg-red-600"
          }`}
        >
          {toast.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{toast.text}</span>
        </div>
      )}
    </>
  );
}
