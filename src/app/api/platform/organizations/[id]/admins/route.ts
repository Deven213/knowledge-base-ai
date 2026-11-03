import { z } from "zod";
import { internalError, jsonError, zodMessage } from "@/server/http";
import { credentialsDto, noStoreJson, platformContext, platformErrorResponse, platformService } from "@/server/platform/context";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };
const bodySchema = z.object({ email: z.email().max(320) }).strict();

/**
 * Adds another Customer Admin (owner) to the workspace with a random temporary password, returned once. An email that
 * already has an account is refused (409): this never reuses, resets or reveals an existing account.
 */
export const POST = withTenant<Params>("platform:admin", async (request, tenant, ctx) => {
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const { id } = await ctx.params;
    const credentials = await platformService().addCustomerAdmin(platformContext(request, tenant), id, parsed.data.email);
    return noStoreJson({ credentials: credentialsDto(credentials) }, 201);
  } catch (err) {
    return platformErrorResponse(err) ?? internalError("POST /api/platform/organizations/[id]/admins", err);
  }
});
