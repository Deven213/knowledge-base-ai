"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";

// Counts page views inside this app (client-side navigations), so Back knows whether the
// previous history entry is one of our pages or somewhere else (another site, a new tab).
let inAppViews = 0;
let lastPath: string | null = null;

/** Mounted once in the root layout. */
export function NavigationTracker() {
  const pathname = usePathname();
  useEffect(() => {
    // Count page changes, not effect runs (React may run effects twice in development).
    if (pathname !== lastPath) {
      lastPath = pathname;
      inAppViews += 1;
    }
  }, [pathname]);
  return null;
}

/**
 * Goes back to the previous page in the app, like the browser's Back button.
 * If the app was opened directly on this page, goes to `fallbackHref` instead of leaving the app.
 */
export function BackButton({
  href,
  fallbackHref = "/app",
  label = "Back",
  className = "",
  compact = false,
  labelClassName = "",
}: {
  /** Always go to this page (a fixed parent) instead of the previous history entry. */
  href?: string;
  fallbackHref?: string;
  label?: string;
  className?: string;
  /** Icon only (the label stays available to screen readers). */
  compact?: boolean;
  /** Extra classes for the text label, e.g. "hidden sm:inline" to show it only on wider screens. */
  labelClassName?: string;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => (href ? router.push(href) : inAppViews > 1 ? router.back() : router.push(fallbackHref))}
      title={label}
      aria-label={label}
      className={`btn btn-ghost gap-1.5 px-2 py-1.5 text-sm ${className}`}
    >
      <ArrowLeft className="h-4 w-4" />
      {!compact && <span className={labelClassName}>{label}</span>}
    </button>
  );
}
