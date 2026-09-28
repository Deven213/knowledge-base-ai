import { FeatureGate } from "@/components/features/FeatureGate";

export const dynamic = "force-dynamic";

/** Inside the Integrations gate: also requires the Google Drive feature. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="google_drive">{children}</FeatureGate>;
}
