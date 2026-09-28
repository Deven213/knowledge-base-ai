import "server-only";
import { featureDefinition, type FeatureKey } from "@/lib/features";
import { getFeatureFlags } from "@/server/features/service";
import { FeatureUnavailable } from "./FeatureUnavailable";

/**
 * Server-side page protection: renders the page only if the feature is available, otherwise the
 * "Feature unavailable" screen. Because this runs on the server, typing the URL can't bypass it.
 */
export function FeatureGate({ feature, children }: { feature: FeatureKey; children: React.ReactNode }) {
  const flags = getFeatureFlags();
  const state = flags.find((f) => f.key === feature)!;
  if (state.available) return <>{children}</>;
  return (
    <FeatureUnavailable
      featureName={state.name}
      blockedByName={state.enabled && state.blockedBy ? featureDefinition(state.blockedBy).name : null}
      dashboardAvailable={flags.find((f) => f.key === "dashboard")!.available}
    />
  );
}
