import { NextResponse } from "next/server";
import { z } from "zod";
import { LANGUAGE_CODES } from "@/lib/languages";
import { internalError, jsonError, requireFeature, zodMessage } from "@/server/http";
import { LLMError } from "@/server/llm/types";
import { AnswerInputError } from "@/server/rag/answer";
import { MessageNotFoundError, setAnswerLanguage } from "@/server/rag/answer-language";
import { TranslationRejectedError } from "@/server/rag/translation";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({ language: z.enum(LANGUAGE_CODES) }).strict();

/**
 * Changes the language of one assistant response in place; returns the updated message. The message
 * is looked up through the caller's own conversations, so any other message ID is "not found".
 */
export const POST = withTenant<{ id: string }>("chat", async (request, tenant, ctx) => {
  const featureOff = requireFeature("chat");
  if (featureOff) return featureOff;
  try {
    const { id } = await ctx.params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));

    const message = await setAnswerLanguage(getTenantServices(tenant), id, parsed.data.language, request.signal);
    return NextResponse.json({ message });
  } catch (err) {
    if (err instanceof MessageNotFoundError) return jsonError(404, err.message);
    if (err instanceof AnswerInputError) return jsonError(400, err.message);
    if (err instanceof LLMError) return jsonError(err.kind === "cancelled" ? 499 : 502, err.message);
    if (err instanceof TranslationRejectedError) return jsonError(502, err.message); // the AI answered, but not in the language asked for
    return internalError("POST /api/messages/[id]/language", err);
  }
});
