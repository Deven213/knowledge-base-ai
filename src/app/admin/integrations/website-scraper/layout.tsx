import { FeatureGate } from "@/components/features/FeatureGate";

export const dynamic = "force-dynamic";

/** Inside the Integrations gate: also requires the Website Scraper feature. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="website_scraper">{children}</FeatureGate>;
}
