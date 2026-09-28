import { afterEach, describe, expect, it, vi } from "vitest";
import { toLLMError } from "@/server/llm/errors";

const KEY = "sk-proj-SECRETSECRETSECRET1234";
const err = (status: number, message: string) => Object.assign(new Error(message), { status });

describe("toLLMError", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => log.mockClear());

  it.each([
    [err(401, `Incorrect API key provided: ${KEY}`), "auth"],
    [err(404, "The model `foo` does not exist"), "model_not_found"],
    [err(429, "Rate limit reached"), "rate_limit"],
    [err(400, "max_tokens too large"), "bad_request"],
    [err(503, "overloaded"), "unavailable"],
    [Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }), "timeout"],
    [new Error("API key not valid. Please pass a valid API key."), "auth"],
  ])("maps %s → %s", (input, kind) => {
    expect(toLLMError(input, "openai", "foo", KEY).kind).toBe(kind);
  });

  it("never leaks the key in the message or the log", () => {
    const e = toLLMError(err(400, `bad request for key ${KEY}`), "openai", "m", KEY);
    expect(e.message).not.toContain(KEY);
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });
});
