import { NextResponse } from "next/server";
import { consultationRoute } from "@/server/consultations/api";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

/** Reopens an approved note for changes. The approved version stays exactly as approved; a new editable version starts as its copy. */
export const POST = withTenant<Params>("consultations:use", async (request, tenant, ctx) => {
  const { id } = await ctx.params;
  return consultationRoute("POST /api/consultations/[id]/note/reopen", tenant, request, id, ({ services, audit }) => {
    const version = services.consultations.reopen(id);
    audit("consultation.note.reopen", id, { version });
    return NextResponse.json({ version }, { headers: { "Cache-Control": "no-store" } });
  });
});
