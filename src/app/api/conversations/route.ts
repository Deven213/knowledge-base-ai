import { NextResponse } from "next/server";
import { toConversationSummaryDTO } from "@/server/dto";
import { internalError, requireFeature } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const featureOff = requireFeature("chat");
  if (featureOff) return featureOff;
  try {
    const q = new URL(request.url).searchParams.get("q")?.slice(0, 200) ?? undefined;
    const { conversations } = getServices();
    return NextResponse.json({ conversations: conversations.list(q).map(toConversationSummaryDTO) });
  } catch (err) {
    return internalError("GET /api/conversations", err);
  }
}
