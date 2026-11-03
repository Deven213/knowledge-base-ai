import { NextResponse } from "next/server";
import { z } from "zod";
import type { CreatedCustomerDTO } from "@/lib/types";
import { internalError, jsonError, zodMessage } from "@/server/http";
import { credentialsDto, loginUrl, noStoreJson, platformContext, platformErrorResponse, platformService } from "@/server/platform/context";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    adminEmail: z.email().max(320),
    /** Optional label for the customer (metadata only). */
    reference: z.string().trim().max(40).optional(),
    /** Chosen by the form once per customer: a retry of the same request is recognised and creates nothing new. */
    requestId: z.uuid().optional(),
  })
  .strict();

/** Every customer workspace (Super Admin only). Metadata and counts: never documents, chats or integrations. */
export const GET = withTenant("platform:admin", (request, tenant) => {
  try {
    const organizations = platformService().listOrganizations(platformContext(request, tenant));
    return NextResponse.json({ organizations });
  } catch (err) {
    return platformErrorResponse(err) ?? internalError("GET /api/platform/organizations", err);
  }
});

/**
 * Creates a customer: an isolated workspace, its Customer Admin account (owner) and a random TEMPORARY PASSWORD that
 * is returned in this response only (never stored in clear, never logged, never audited). The customer must replace
 * it at their first sign-in. A retry with the same requestId returns the existing customer WITHOUT any password.
 */
export const POST = withTenant("platform:admin", async (request, tenant) => {
  try {
    const parsed = createSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const created = await platformService().createOrganization(platformContext(request, tenant), parsed.data);
    const body: CreatedCustomerDTO = {
      organization: created.organization,
      workspaceName: created.organization.name,
      loginId: created.credentials?.loginId ?? created.organization.activation.loginId ?? "",
      loginUrl: loginUrl(),
      alreadyCreated: created.alreadyCreated,
      credentials: created.credentials ? credentialsDto(created.credentials) : null,
    };
    return noStoreJson(body, created.alreadyCreated ? 200 : 201);
  } catch (err) {
    return platformErrorResponse(err) ?? internalError("POST /api/platform/organizations", err);
  }
});
