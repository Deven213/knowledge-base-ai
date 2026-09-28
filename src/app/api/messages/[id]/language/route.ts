import { NextResponse } from "next/server";
import { z } from "zod";
import { LANGUAGE_CODES } from "@/lib/languages";
import { internalError, jsonError, rejectCrossSite, requireFeature, zodMessage } from "@/server/http";
import { LLMError } from "@/server/llm/types";
import { AnswerInputError } from "@/server/rag/answer";
import { MessageNotFoundError, setAnswerLanguage } from "@/server/rag/answer-language";
import { getServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({ language: z.enum(LANGUAGE_CODES) }).strict();

/** Changes the language of one assistant response in place; returns the updated message. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const featureOff = requireFeature("chat");
  if (featureOff) return featureOff;
  try {
    const { id } = await ctx.params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));

    const message = await setAnswerLanguage(getServices(), id, parsed.data.language, request.signal);
    return NextResponse.json({ message });
  } catch (err) {
    if (err instanceof MessageNotFoundError) return jsonError(404, err.message);
    if (err instanceof AnswerInputError) return jsonError(400, err.message);
    if (err instanceof LLMError) return jsonError(err.kind === "cancelled" ? 499 : 502, err.message);
    return internalError("POST /api/messages/[id]/language", err);
  }
}
