import { NextResponse } from "next/server";
import { getFeatureFlags } from "@/server/features/service";
import { internalError } from "@/server/http";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** All features with their switch, availability, status and dependency. Readable by any signed-in member. */
export const GET = withTenant(null, async () => {
  try {
    return NextResponse.json({ features: getFeatureFlags() });
  } catch (err) {
    return internalError("GET /api/features", err);
  }
});
