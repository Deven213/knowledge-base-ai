import { NextResponse } from "next/server";
import { toConversationSummaryDTO } from "@/server/dto";
import { internalError, requireFeature } from "@/server/http";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The caller's own conversations only (chats are private to their author). */
export const GET = withTenant("chat", async (request, tenant) => {
  const featureOff = requireFeature("chat");
  if (featureOff) return featureOff;
  try {
    const q = new URL(request.url).searchParams.get("q")?.slice(0, 200) ?? undefined;
    const { conversations } = getTenantServices(tenant);
    return NextResponse.json({ conversations: conversations.list(q).map(toConversationSummaryDTO) });
  } catch (err) {
    return internalError("GET /api/conversations", err);
  }
});
