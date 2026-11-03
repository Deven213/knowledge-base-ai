import { NextResponse } from "next/server";
import { z } from "zod";
import { knowledgeScopeSchema } from "@/lib/knowledge-scope";
import type { ConversationDTO } from "@/lib/types";
import { toConversationSummaryDTO, toMessageDTO } from "@/server/dto";
import { internalError, jsonError, requireFeature, zodMessage } from "@/server/http";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

// A conversation that isn't the caller's own (another person's, or another organization's) is reported
// exactly like one that doesn't exist.

export const GET = withTenant<Params>("chat", async (_request, tenant, ctx) => {
  const featureOff = requireFeature("chat");
  if (featureOff) return featureOff;
  try {
    const { id } = await ctx.params;
    const { conversations } = getTenantServices(tenant);
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
});

const patchSchema = z.object({ knowledgeScope: knowledgeScopeSchema }).strict();

/** Changes the conversation's "Chat with" source (the user confirmed the change). */
export const PATCH = withTenant<Params>("chat", async (request, tenant, ctx) => {
  const featureOff = requireFeature("chat");
  if (featureOff) return featureOff;
  try {
    const parsed = patchSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const { id } = await ctx.params;
    const { conversations } = getTenantServices(tenant);
    if (!conversations.setKnowledgeScope(id, parsed.data.knowledgeScope)) return jsonError(404, "Conversation not found.");
    return NextResponse.json(toConversationSummaryDTO(conversations.get(id)!));
  } catch (err) {
    return internalError("PATCH /api/conversations/[id]", err);
  }
});

export const DELETE = withTenant<Params>("chat", async (_request, tenant, ctx) => {
  const featureOff = requireFeature("chat");
  if (featureOff) return featureOff;
  try {
    const { id } = await ctx.params;
    if (!getTenantServices(tenant).conversations.delete(id)) return jsonError(404, "Conversation not found.");
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return internalError("DELETE /api/conversations/[id]", err);
  }
});
