import { describe, expect, it } from "vitest";
import { last4, redactSecrets, safeErrorMessage } from "@/server/security/redact";

describe("last4", () => {
  it("reveals nothing for short values", () => {
    expect(last4("sk-abcdefghijklmnop")).toBe("mnop");
    expect(last4("short")).toBe("");
  });
});

describe("redactSecrets", () => {
  it.each([
    ["Incorrect API key provided: sk-proj-abcDEF1234567890abcdef", "sk-proj-"],
    ["invalid x-api-key sk-ant-api03-AbCdEf0123456789", "sk-ant-api03"],
    ["API key not valid: AIzaSyA1234567890abcdefghijk", "AIzaSy"],
    ["GET https://x.googleapis.com/v1/models?key=abc123secret&alt=json", "abc123secret"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig", "eyJhbGci"],
  ])("removes key-like values: %s", (input, leaked) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(leaked);
    expect(out).toContain("[REDACTED]");
  });

  it("removes explicitly known secrets of any shape", () => {
    expect(redactSecrets("failed with custom-token-9f8e7d", ["custom-token-9f8e7d"])).toBe("failed with [REDACTED]");
  });

  it("handles non-Error values", () => {
    expect(safeErrorMessage({})).toBe("Unknown error");
    expect(safeErrorMessage(new Error("bad key sk-abcdefghijklmnopqrstu"))).toBe("bad key [REDACTED]");
  });
});
