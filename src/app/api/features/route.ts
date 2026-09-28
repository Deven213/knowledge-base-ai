import { NextResponse } from "next/server";
import { getFeatureFlags } from "@/server/features/service";
import { internalError } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** All features with their switch, availability, status and dependency. Always available. */
export async function GET() {
  try {
    return NextResponse.json({ features: getFeatureFlags() });
  } catch (err) {
    return internalError("GET /api/features", err);
  }
}
