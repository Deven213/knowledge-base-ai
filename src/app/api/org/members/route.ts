import { NextResponse } from "next/server";
import type { MemberDTO } from "@/lib/types";
import { IdentityRepository } from "@/server/auth/identity";
import { getDb } from "@/server/db/client";
import { internalError } from "@/server/http";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The people in the caller's workspace (administrators and owners only: it lists everyone's email). */
export const GET = withTenant("members:manage", (_request, tenant) => {
  try {
    const members: MemberDTO[] = new IdentityRepository(getDb()).listMembers(tenant.orgId);
    return NextResponse.json({ members });
  } catch (err) {
    return internalError("GET /api/org/members", err);
  }
});
