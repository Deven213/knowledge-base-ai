// Removes anything that looks like an API key from text before it is logged or returned.

const KEY_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g, // OpenAI
  /AIza[0-9A-Za-z_-]{20,}/g, // Google
  /(?<=[?&](?:key|api_key|apikey)=)[^&\s"']+/gi, // keys in query strings
  /(?<=Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, // bearer tokens
];

export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[REDACTED]");
  }
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

/** Safe, redacted message from an unknown thrown value. */
export function safeErrorMessage(err: unknown, knownSecrets: readonly string[] = []): string {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
  return redactSecrets(message, knownSecrets);
}

/** Last four characters for display, e.g. "…a1B2". Short values reveal nothing. */
export function last4(secret: string): string {
  return secret.length >= 12 ? secret.slice(-4) : "";
}
