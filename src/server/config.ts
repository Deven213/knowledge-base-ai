import "server-only";
import path from "node:path";
import { z } from "zod";
import { PROVIDER_IDS } from "@/lib/types";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const envSchema = z.object({
  OPENAI_API_KEY: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  GEMINI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString,
  ANTHROPIC_MODEL: optionalString,
  GEMINI_MODEL: optionalString,
  // Provider used for chat until one is chosen in AI Model Settings.
  DEFAULT_AI_PROVIDER: z.enum(PROVIDER_IDS).optional().default("openai"),

  EMBEDDING_MODEL: optionalString.transform((v) => v ?? "Xenova/bge-small-en-v1.5"),
  EMBEDDING_POOLING: z.enum(["cls", "mean"]).optional().default("cls"),
  // Not trimmed: the trailing space is part of the prefix.
  EMBEDDING_QUERY_PREFIX: z
    .string()
    .optional()
    .default("Represent this sentence for searching relevant passages: "),
  RETRIEVAL_TOP_K: z.coerce.number().int().min(1).max(20).default(6),
  RETRIEVAL_MIN_SCORE: z.coerce.number().min(-1).max(1).default(0.5),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(200).default(20),

  // ── Sync Integrations ──
  /** Public origin of this app; OAuth redirect URIs are built from it. */
  APP_BASE_URL: optionalString.transform((v) => (v ?? "http://localhost:3000").replace(/\/+$/, "")),
  /** 32-byte base64 key that encrypts OAuth tokens at rest. Required to connect Google Drive / OneDrive. */
  INTEGRATIONS_ENCRYPTION_KEY: optionalString.refine((v) => v === undefined || Buffer.from(v, "base64").length === 32, {
    message: "INTEGRATIONS_ENCRYPTION_KEY must be 32 bytes encoded as base64 (generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\").",
  }),
  GOOGLE_OAUTH_CLIENT_ID: optionalString,
  GOOGLE_OAUTH_CLIENT_SECRET: optionalString,
  MICROSOFT_OAUTH_CLIENT_ID: optionalString,
  MICROSOFT_OAUTH_CLIENT_SECRET: optionalString,
  /** "common" (work + personal accounts), "consumers", "organizations", or a tenant ID. */
  MICROSOFT_OAUTH_TENANT: optionalString.transform((v) => v ?? "common"),
  // ── Demo sign-in (application login only; unrelated to the AI provider API keys) ──
  DEMO_USER_EMAIL: optionalString.transform((v) => (v ?? "demo@knowledgebase.ai").toLowerCase()),
  DEMO_USER_PASSWORD: optionalString.transform((v) => v ?? "Demo@12345"),
  /** Show the demo credentials and the one-click "Use Demo Account" button on the login page. */
  DEMO_SHOW_CREDENTIALS: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v !== "false"),
  /** How long a sign-in lasts. */
  AUTH_SESSION_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24),
  // Runtime-only path; tell the bundler's file tracer not to follow it.
  DATA_DIR: optionalString.transform((v) => path.resolve(/*turbopackIgnore: true*/ v ?? "./data")),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

/** Parsed, validated environment. Throws a readable error on misconfiguration. */
export function getConfig(): AppConfig {
  if (cached) return cached;
  // Treat empty strings from .env as unset so zod defaults apply.
  const raw = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${details}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test hook: forget the cached config so tests can change process.env. */
export function resetConfigForTests(): void {
  cached = undefined;
}
