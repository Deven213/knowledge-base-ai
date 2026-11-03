import { z } from "zod";
import { internalError, jsonError, zodMessage } from "@/server/http";
import { credentialsDto, noStoreJson, platformContext, platformErrorResponse, platformService } from "@/server/platform/context";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string; userId: string };
const bodySchema = z.object({ action: z.enum(["reissue", "revoke"]) }).strict();

/**
 * Reissues or revokes the temporary password of a person who has not replaced it yet.
 *  - reissue: a NEW temporary password (shown once); the earlier one stops working and their sessions end;
 *  - revoke: the temporary password stops working right now (they can't sign in until it is reissued).
 * Accounts that have chosen their own password are refused (409): their credentials are theirs.
 */
export const POST = withTenant<Params>("platform:admin", async (request, tenant, ctx) => {
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const { id, userId } = await ctx.params;
    const service = platformService();
    const context = platformContext(request, tenant);
    if (parsed.data.action === "reissue") {
      return noStoreJson({ credentials: credentialsDto(await service.reissueCredentials(context, id, userId)) });
    }
    return noStoreJson({ revoked: true, ...service.revokeCredentials(context, id, userId) });
  } catch (err) {
    return platformErrorResponse(err) ?? internalError("POST /api/platform/organizations/[id]/members/[userId]/credentials", err);
  }
});
