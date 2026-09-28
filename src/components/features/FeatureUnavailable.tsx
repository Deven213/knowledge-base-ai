import Link from "next/link";
import { ArrowLeft, Ban, Settings } from "lucide-react";
import { FEATURE_DISABLED_MESSAGE } from "@/lib/features";

/** Shown instead of a page whose feature is disabled (rendered on the server). */
export function FeatureUnavailable({
  featureName,
  blockedByName,
  dashboardAvailable,
}: {
  featureName: string;
  /** Set when the feature is switched on but depends on a disabled feature. */
  blockedByName?: string | null;
  dashboardAvailable: boolean;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <section className="card w-full max-w-md px-6 py-10 text-center" role="alert">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <Ban className="h-7 w-7" />
        </div>
        <h1 className="text-xl font-semibold text-slate-900">Feature unavailable</h1>
        <p className="mt-1 text-sm text-slate-600">{FEATURE_DISABLED_MESSAGE}</p>
        <p className="mt-3 text-xs text-slate-500">
          {featureName}
          {blockedByName ? ` requires ${blockedByName}, which is turned off.` : " is turned off."}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {dashboardAvailable ? (
            <Link href="/admin" className="btn btn-dark">
              <ArrowLeft className="h-4 w-4" /> Back to Dashboard
            </Link>
          ) : (
            <Link href="/app" className="btn btn-dark">
              <ArrowLeft className="h-4 w-4" /> Back to home
            </Link>
          )}
          <Link href="/settings/features" className="btn btn-outline">
            <Settings className="h-4 w-4" /> Feature Management
          </Link>
        </div>
      </section>
    </div>
  );
}
