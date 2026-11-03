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

  describe("Google's quota refusals say what happened (the Gujarati button looked dead because the daily limit was used up)", () => {
    const quota = (id: string, retry: string, extra = "") =>
      err(
        429,
        JSON.stringify({
          error: {
            code: 429,
            message: "You exceeded your current quota, please check your plan and billing details.",
            status: "RESOURCE_EXHAUSTED",
            details: [
              { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: id, quotaDimensions: { model: "gemini-2.5-flash" }, quotaValue: "20" }] },
              { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: retry },
            ],
          },
        }) + extra,
      );

    it("names the daily limit, its size and when it resets, and what to do", () => {
      const e = toLLMError(quota("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "71653s"), "gemini", "gemini-2.5-flash", KEY);
      expect(e.kind).toBe("rate_limit");
      expect(e.message).toBe(
        'Google Gemini\'s daily request limit (20 requests per day) for the model "gemini-2.5-flash" is used up, and resets in about 20 hours. Choose another model or provider in AI Model Settings, or enable billing for the key to remove the limit.',
      );
      expect(e.message).not.toMatch(/no credits/i);
    });

    it("says to wait a moment for a per-minute limit, and gives the wait", () => {
      const e = toLLMError(quota("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "42s"), "gemini", "gemini-2.5-flash", KEY);
      expect(e.message).toBe('Google Gemini is receiving too many requests for the model "gemini-2.5-flash". Wait about 42 seconds and try again.');
    });

    it("still says something useful for a quota it can't classify, and shortens minutes and hours sensibly", () => {
      expect(toLLMError(quota("SomethingElse", "300s"), "gemini", "m", KEY).message).toMatch(/quota for the model "m" is used up, and resets in about 5 minutes/);
      expect(toLLMError(err(429, "You exceeded your current quota"), "gemini", "m", KEY).message).toMatch(/quota for the model "m" is used up\. Choose another model/);
      expect(toLLMError(quota("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "7200s"), "gemini", "m", KEY).message).toMatch(/in about 2 hours/);
    });

    it("leaves other providers' messages alone (OpenAI: no credits left)", () => {
      const e = toLLMError(err(429, "You exceeded your current quota, please check your plan and billing details. insufficient_quota"), "openai", "gpt", KEY);
      expect(e.message).toMatch(/no credits left/);
    });

    it("never prints the key", () => {
      const e = toLLMError(quota("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "10s", ` key=${KEY}`), "gemini", "m", KEY);
      expect(e.message).not.toContain(KEY);
    });
  });

  it("never leaks the key in the message or the log", () => {
    const e = toLLMError(err(400, `bad request for key ${KEY}`), "openai", "m", KEY);
    expect(e.message).not.toContain(KEY);
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });
});

describe("toLLMError for a request that carries health information", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => log.mockClear());
  const QUOTED = "Invalid value: 'Asha Patel takes metformin 500 mg, ડૉક્ટર સાહેબ' at contents[0].parts[0].text";

  it("never logs or repeats what the provider says about a rejected request, because that wording can quote what was sent", () => {
    for (const status of [400, 422, 500, 0]) {
      const e = toLLMError(err(status, QUOTED), "gemini", "m", KEY, undefined, { sensitive: true });
      expect(e.message, `status ${status}`).not.toMatch(/Asha|metformin|ડૉક્ટર|Invalid value/);
      expect(JSON.stringify(log.mock.calls), `status ${status}`).not.toMatch(/Asha|metformin|ડૉક્ટર|Invalid value/);
    }
    // ...but the kind and the status are still logged, so the operator can see what happened.
    toLLMError(err(400, QUOTED), "gemini", "m", KEY, undefined, { sensitive: true });
    expect(JSON.stringify(log.mock.calls)).toMatch(/status=400/);
  });

  it("keeps the wording for a rejected key, an unknown model and a quota: those never quote a request, and the operator needs them", () => {
    toLLMError(err(429, "Quota exceeded for metric: generate_content_free_tier_requests, limit: 20"), "gemini", "m", KEY, undefined, { sensitive: true });
    expect(JSON.stringify(log.mock.calls)).toMatch(/Quota exceeded for metric/);
    const e = toLLMError(err(404, "models/m is not found"), "gemini", "m", KEY, undefined, { sensitive: true });
    expect(e.kind).toBe("model_not_found");
  });

  it("still redacts the key, and still classifies the failure the same way", () => {
    const e = toLLMError(err(400, `bad request ${KEY}`), "gemini", "m", KEY, undefined, { sensitive: true });
    expect(e.kind).toBe("bad_request");
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });

  it("an ordinary chat request is unchanged: its message is still shown (it is the person's own question)", () => {
    expect(toLLMError(err(400, "max_tokens too large"), "openai", "m", KEY).message).toMatch(/max_tokens too large/);
  });
});
