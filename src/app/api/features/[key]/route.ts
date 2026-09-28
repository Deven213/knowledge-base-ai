import { NextResponse } from "next/server";
import { z } from "zod";
import { isFeatureKey } from "@/lib/features";
import { FeatureDependencyError, getFeatureFlagService } from "@/server/features/service";
import { internalError, jsonError, rejectCrossSite, zodMessage } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ enabled: z.boolean() }).strict();

/** Turns one feature on or off. Enabling is refused (409) while its dependency is unavailable. */
export async function PUT(request: Request, ctx: { params: Promise<{ key: string }> }) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const { key } = await ctx.params;
    if (!isFeatureKey(key)) return jsonError(404, "Unknown feature.");

    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));

    try {
      return NextResponse.json({ features: getFeatureFlagService().setFeatureEnabled(key, parsed.data.enabled) });
    } catch (err) {
      if (err instanceof FeatureDependencyError) return jsonError(409, err.message);
      throw err;
    }
  } catch (err) {
    return internalError("PUT /api/features/[key]", err);
  }
}
