import { FeatureManagement } from "@/components/settings/FeatureManagement";
import { getFeatureFlags } from "@/server/features/service";

export const dynamic = "force-dynamic";

// Server-rendered with the current flags; toggles then update via /api/features/[key].
export default function FeatureManagementPage() {
  return <FeatureManagement initial={getFeatureFlags()} />;
}
