import { NextResponse } from "next/server";
import { z } from "zod";
import { internalError, jsonError, zodMessage } from "@/server/http";
import { platformContext, platformErrorResponse, platformService } from "@/server/platform/context";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { userId: string };
const patchSchema = z.object({ status: z.enum(["active", "disabled"]) }).strict();

/** Disables or re-enables a person's account everywhere. Disabling signs them out at once. */
export const PATCH = withTenant<Params>("platform:admin", async (request, tenant, ctx) => {
  try {
    const parsed = patchSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const { userId } = await ctx.params;
    const user = platformService().setUserStatus(platformContext(request, tenant), userId, parsed.data.status);
    return NextResponse.json({ user });
  } catch (err) {
    return platformErrorResponse(err) ?? internalError("PATCH /api/platform/users/[userId]", err);
  }
});
