import { NextResponse } from "next/server";
import { z } from "zod";
import { isFeatureKey } from "@/lib/features";
import { FeatureDependencyError, getFeatureFlagService } from "@/server/features/service";
import { internalError, jsonError, zodMessage } from "@/server/http";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ enabled: z.boolean() }).strict();

/**
 * Turns one feature on or off. Feature switches are platform-wide (they change what EVERY customer sees),
 * so only a platform administrator may change them. Enabling is refused (409) while its dependency is unavailable.
 */
export const PUT = withTenant<{ key: string }>("platform:admin", async (request, _tenant, ctx) => {
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
});
