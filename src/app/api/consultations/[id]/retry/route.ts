import { NextResponse } from "next/server";
import { consultationRoute } from "@/server/consultations/api";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

/** Tries processing again after a failure. It queues a new round of work (earlier attempts stay as history) and answers at once. */
export const POST = withTenant<Params>("consultations:use", async (request, tenant, ctx) => {
  const { id } = await ctx.params;
  return consultationRoute("POST /api/consultations/[id]/retry", tenant, request, id, ({ services, gate, audit }) => {
    services.consultations.retry(id);
    audit("consultation.retry", id);
    return NextResponse.json({ consultation: services.consultations.detail(id, gate) }, { headers: { "Cache-Control": "no-store" } });
  });
});
