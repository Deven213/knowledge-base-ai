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

  // ── OCR (scanned PDFs): pages without a text layer are read with local Tesseract OCR ──
  OCR_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v !== "false"),
  /** Tesseract language codes joined with "+", e.g. "eng" or "eng+hin". Language data downloads on first use. */
  OCR_LANGUAGES: optionalString
    .refine((v) => v === undefined || /^[a-z]{3}(_[a-z]+)?(\+[a-z]{3}(_[a-z]+)?)*$/i.test(v), {
      message: 'OCR_LANGUAGES must be Tesseract language codes joined with "+", e.g. "eng" or "eng+hin".',
    })
    .transform((v) => v ?? "eng"),
  /** Most pages OCR'd per document. Larger scans are refused instead of tying the server up for hours. */
  OCR_MAX_PAGES: z.coerce.number().int().min(1).max(5000).default(300),
  /** Pages recognized in parallel. Unset = scales with the CPU (at most 4). */
  OCR_WORKERS: z.coerce.number().int().min(1).max(8).optional(),

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
  // ── Voice (uses GEMINI_API_KEY; both features are only used when the user asks) ──
  /** "Listen" on answers (Gemini text-to-speech). */
  GEMINI_TTS_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v !== "false"),
  /** Gemini TTS model (see https://ai.google.dev/gemini-api/docs/speech-generation). */
  GEMINI_TTS_MODEL: optionalString.transform((v) => v ?? "gemini-3.8-flash-lite-tts"),
  /** Prebuilt Gemini voice name, e.g. Kore, Puck, Charon, Aoede. */
  GEMINI_TTS_VOICE: optionalString.transform((v) => v ?? "Kore"),
  /** Longest answer text (characters) that may be turned into speech in one request. */
  TTS_MAX_CHARS: z.coerce.number().int().min(100).max(20000).default(5000),
  /** Microphone input (speech → text in the chat box). */
  VOICE_INPUT_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v !== "false"),
  /** Gemini model used to transcribe voice input; defaults to the Gemini chat model. */
  GEMINI_STT_MODEL: optionalString,
  // ── Doctor consultations (recording → transcript → clinical note) ──
  // Health information. Nothing here is on by default: the feature flag, the key and the provider review below all have to be set.
  /** 32-byte base64 key that seals patient labels, transcripts, notes and the stored audio. Required to use consultations. */
  CONSULTATIONS_ENCRYPTION_KEY: optionalString.refine((v) => v === undefined || Buffer.from(v, "base64").length === 32, {
    message: "CONSULTATIONS_ENCRYPTION_KEY must be 32 bytes encoded as base64 (generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\").",
  }),
  /**
   * Longest recording (minutes) the recorder will make and the server will accept. 45 by default, on purpose: the speech service writes the
   * whole transcript in one answer, which has an output limit, and Gujarati takes many more tokens per word than English. Raise it only after
   * testing recordings of that length (a transcript cut off at the limit is reported as "too long", never saved half-finished).
   */
  CONSULTATIONS_MAX_MINUTES: z.coerce.number().int().min(1).max(240).default(45),
  /** The most recorded audio ONE workspace may hold (GB). Recordings are kept until deleted, and every workspace shares this server's disk, so one tenant must not be able to fill it. */
  CONSULTATIONS_MAX_STORAGE_GB: z.coerce.number().positive().max(100000).default(25),
  /** Largest recording the server will accept (MB). */
  CONSULTATIONS_MAX_AUDIO_MB: z.coerce.number().positive().max(500).default(120),
  /** Where audio is stored for now: a private folder on this server (sealed). Defaults to DATA_DIR/consultation-audio. */
  CONSULTATIONS_AUDIO_DIR: optionalString.transform((v) => (v ? path.resolve(/*turbopackIgnore: true*/ v) : undefined)),
  /** Which AI service may transcribe recordings. Unset = no recording is ever sent to an AI service. */
  CONSULTATIONS_TRANSCRIPTION_PROVIDER: z.enum(["gemini"]).optional(),
  CONSULTATIONS_TRANSCRIPTION_MODEL: optionalString,
  /** Model that drafts the clinical note from the transcript; defaults to GEMINI_MODEL. */
  CONSULTATIONS_NOTE_MODEL: optionalString,
  /** The privacy review: WHO reviewed the provider's data handling, WHEN, and where the data is processed. Required before anything is sent. */
  CONSULTATIONS_PROVIDER_REVIEW: optionalString,
  CONSULTATIONS_PROVIDER_REGION: optionalString,
  /** Run the background worker inside this server process (default true). */
  CONSULTATIONS_WORKER: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v !== "false"),
  // ── First owner (created once at startup; adopts the data that existed before organizations) ──
  BOOTSTRAP_OWNER_EMAIL: optionalString.transform((v) => v?.toLowerCase()),
  BOOTSTRAP_OWNER_PASSWORD: optionalString,
  BOOTSTRAP_OWNER_NAME: optionalString,
  // ── Public demo account (application login only; unrelated to the AI provider API keys) ──
  // The demo exists ONLY when DEMO_USER_PASSWORD is set: there is no built-in default password.
  // It signs in to its own separate "Demo workspace", never to a customer's.
  DEMO_USER_EMAIL: optionalString.transform((v) => (v ?? "demo@knowledgebase.ai").toLowerCase()),
  DEMO_USER_PASSWORD: optionalString,
  /** Show the demo credentials and the one-click "Use Demo Account" button on the login page (default: hidden). */
  DEMO_SHOW_CREDENTIALS: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  /** How many reverse proxies sit in front of the app (0 = none). Only then is X-Forwarded-For used for per-IP limits. */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** How long an invitation link stays valid. */
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
  // ── Customer onboarding ──
  /** How long a temporary password (given to a new Customer Admin by the Super Admin) works before it expires. */
  TEMPORARY_PASSWORD_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
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
