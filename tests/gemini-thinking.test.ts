import { beforeEach, describe, expect, it, vi } from "vitest";

// Translating needs no reasoning, and Gemini's hidden "thinking" is most of the waiting time (measured: 4,400-9,400
// thinking tokens = 19-40 s for a short translation; none = 4-5 s). The adapter asks for minimal thinking only when a
// request says it is a mechanical task, only for models whose settings are known, and never lets the hint break a request.

const sdk = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = { generateContent: sdk.generateContent };
  },
}));

import { geminiProvider, minimalThinking } from "@/server/llm/gemini";
import { TRANSLATION_FORMAT } from "@/server/rag/translation";
import type { LLMRequest } from "@/server/llm/types";

const request = (model: string, over: Partial<LLMRequest> = {}): LLMRequest => ({ system: "s", content: [{ type: "text", text: "hello" }], model, apiKey: "AIza-test-key-12345678", ...over });
const config = (call = 0) => sdk.generateContent.mock.calls[call]![0].config as Record<string, unknown>;
const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  sdk.generateContent.mockReset();
  sdk.generateContent.mockResolvedValue({ text: "{}" });
});

describe("which thinking setting each model family gets", () => {
  it("asks each generation the way it understands, and says nothing about models it doesn't know", () => {
    expect(minimalThinking("gemini-3-flash-preview")).toEqual({ thinkingLevel: "MINIMAL" });
    expect(minimalThinking("gemini-3.5-flash")).toEqual({ thinkingLevel: "MINIMAL" });
    expect(minimalThinking("gemini-3.1-flash-lite")).toEqual({ thinkingLevel: "MINIMAL" });
    expect(minimalThinking("gemini-3.1-pro-preview")).toEqual({ thinkingLevel: "LOW" }); // the Pro models have no "minimal"
    expect(minimalThinking("gemini-2.5-flash")).toEqual({ thinkingBudget: 0 });
    expect(minimalThinking("gemini-2.5-flash-lite")).toEqual({ thinkingBudget: 0 });
    expect(minimalThinking("models/Gemini-2.5-Flash")).toEqual({ thinkingBudget: 0 });
    expect(minimalThinking("gemini-2.5-pro")).toEqual({ thinkingBudget: 128 }); // can't be switched off
    for (const unknown of ["gemini-flash-latest", "gemini-1.5-flash", "gemma-3", "", "my-tuned-model"]) expect(minimalThinking(unknown), unknown).toBeUndefined();
  });
});

describe("the request to Gemini", () => {
  it("is exactly as before unless the caller says the task needs no reasoning", async () => {
    await geminiProvider.generate(request("gemini-2.5-flash", { responseFormat: TRANSLATION_FORMAT }));
    expect(config()).not.toHaveProperty("thinkingConfig");
    expect(config()).toMatchObject({ systemInstruction: "s", responseMimeType: "application/json", responseJsonSchema: TRANSLATION_FORMAT.schema });
  });

  it("carries minimal thinking for a mechanical task, next to the structured-output settings", async () => {
    await geminiProvider.generate(request("gemini-2.5-flash", { reasoning: "minimal", responseFormat: TRANSLATION_FORMAT }));
    expect(config()).toMatchObject({ thinkingConfig: { thinkingBudget: 0 }, responseMimeType: "application/json", responseJsonSchema: TRANSLATION_FORMAT.schema });
    await geminiProvider.generate(request("gemini-3-flash-preview", { reasoning: "minimal" }));
    expect(config(1)).toMatchObject({ thinkingConfig: { thinkingLevel: "MINIMAL" } });
  });

  it("sends no setting for a model it knows nothing about", async () => {
    await geminiProvider.generate(request("gemini-flash-latest", { reasoning: "minimal" }));
    expect(config()).not.toHaveProperty("thinkingConfig");
  });
});

describe("a model that refuses the setting", () => {
  it("is asked again without it, once, and remembered, so the hint can never make a request fail", async () => {
    sdk.generateContent.mockRejectedValueOnce(apiError(400, "Thinking budget 0 is invalid for this model. Thinking cannot be disabled."));

    const out = await geminiProvider.generate(request("gemini-2.5-flash-refusing", { reasoning: "minimal" }));

    expect(out).toEqual({ text: "{}" });
    expect(sdk.generateContent).toHaveBeenCalledTimes(2);
    expect(config(0)).toHaveProperty("thinkingConfig");
    expect(config(1)).not.toHaveProperty("thinkingConfig");

    await geminiProvider.generate(request("gemini-2.5-flash-refusing", { reasoning: "minimal" }));
    expect(sdk.generateContent).toHaveBeenCalledTimes(3); // not 4: it doesn't try the refused setting again
    expect(config(2)).not.toHaveProperty("thinkingConfig");
  });

  it("is not retried for any other problem: a bad key, a bad request, an overloaded service, a cancellation", async () => {
    for (const [status, message, kind] of [
      [401, "API key not valid", "auth"],
      [400, "Unsupported schema", "bad_request"],
      [503, "This model is currently experiencing high demand.", "unavailable"],
    ] as const) {
      sdk.generateContent.mockReset();
      sdk.generateContent.mockRejectedValueOnce(apiError(status, message));
      await expect(geminiProvider.generate(request("gemini-3-flash-preview", { reasoning: "minimal" }))).rejects.toMatchObject({ kind });
      expect(sdk.generateContent).toHaveBeenCalledTimes(1);
    }
  });
});
