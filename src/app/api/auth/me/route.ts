import { NextResponse } from "next/server";
import { sessionDto } from "@/server/auth/session-dto";
import { getDb } from "@/server/db/client";
import { internalError } from "@/server/http";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is signed in, which workspace they are in, the workspaces they can switch to, and what they may do. */
export const GET = withTenant(
  null,
  (_request, tenant) => {
    try {
      return NextResponse.json(sessionDto(getDb(), tenant));
    } catch (err) {
      return internalError("GET /api/auth/me", err);
    }
  },
  { allowWhilePasswordChangeRequired: true }, // the page needs to know that a change is required
);
