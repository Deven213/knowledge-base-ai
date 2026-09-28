"use client";

import { createContext, useContext } from "react";
import { resolveFeatures, toAvailability, type FeatureAvailability, type FeatureKey } from "@/lib/features";

// Availability computed on the server for this request. Client components use it only to hide or
// show UI; the server still enforces every flag on pages and API routes.
const FeatureContext = createContext<FeatureAvailability>(toAvailability(resolveFeatures({})));

export function FeatureProvider({ availability, children }: { availability: FeatureAvailability; children: React.ReactNode }) {
  return <FeatureContext.Provider value={availability}>{children}</FeatureContext.Provider>;
}

export function useFeatures(): FeatureAvailability {
  return useContext(FeatureContext);
}

export function useFeature(key: FeatureKey): boolean {
  return useContext(FeatureContext)[key];
}
