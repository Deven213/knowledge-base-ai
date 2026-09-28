import { NextResponse } from "next/server";
import { z } from "zod";
import { knowledgeScopeSchema } from "@/lib/knowledge-scope";
import type { ConversationDTO } from "@/lib/types";
import { toConversationSummaryDTO, toMessageDTO } from "@/server/dto";
import { internalError, jsonError, rejectCrossSite, requireFeature, zodMessage } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  const featureOff = requireFeature("chat");
  if (featureOff) return featureOff;
  try {
    const { id } = await ctx.params;
    const { conversations } = getServices();
    const row = conversations.get(id);
    if (!row) return jsonError(404, "Conversation not found.");
    const body: ConversationDTO = {
      ...toConversationSummaryDTO(row),
      messages: conversations.messages(id).map(toMessageDTO),
    };
    return NextResponse.json(body);
  } catch (err) {
    return internalError("GET /api/conversations/[id]", err);
  }
}

const patchSchema = z.object({ knowledgeScope: knowledgeScopeSchema }).strict();

/** Changes the conversation's "Chat with" source (the user confirmed the change). */
export async function PATCH(request: Request, ctx: Ctx) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const featureOff = requireFeature("chat");
  if (featureOff) return featureOff;
  try {
    const parsed = patchSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const { id } = await ctx.params;
    const { conversations } = getServices();
    if (!conversations.setKnowledgeScope(id, parsed.data.knowledgeScope)) return jsonError(404, "Conversation not found.");
    return NextResponse.json(toConversationSummaryDTO(conversations.get(id)!));
  } catch (err) {
    return internalError("PATCH /api/conversations/[id]", err);
  }
}

export async function DELETE(_request: Request, ctx: Ctx) {
  const featureOff = requireFeature("chat");
  if (featureOff) return featureOff;
  try {
    const { id } = await ctx.params;
    if (!getServices().conversations.delete(id)) return jsonError(404, "Conversation not found.");
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return internalError("DELETE /api/conversations/[id]", err);
  }
}
