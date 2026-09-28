import { FeatureGate } from "@/components/features/FeatureGate";

export const dynamic = "force-dynamic";

/** Inside the Integrations gate: also requires the OneDrive feature. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="onedrive">{children}</FeatureGate>;
}
