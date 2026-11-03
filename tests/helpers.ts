import type Database from "better-sqlite3";
import type { AppConfig } from "@/server/config";
import { IdentityRepository } from "@/server/auth/identity";
import { openDatabase } from "@/server/db/client";
import { LEGACY_ORG_ID } from "@/server/db/constants";
import type { Embedder } from "@/server/knowledge/embedder";

/** What a fake translator writes in front of each string: real letters of the language's own script, which translations are now checked for. */
export const SCRIPT_TAG: Record<string, string> = { Hindi: "हिन्दी", Gujarati: "ગુજરાતી" };

export function memoryDb(): Database.Database {
  return openDatabase(":memory:");
}

/** The workspace every single-organization test works in: the Default workspace that migration 10 creates. */
export const TEST_ORG = LEGACY_ORG_ID;

const testUsers = new WeakMap<Database.Database, string>();

/** A person who belongs to the test workspace. Conversations need an author, and chats are private to them. */
export function testUserId(db: Database.Database): string {
  let id = testUsers.get(db);
  if (!id) {
    const identity = new IdentityRepository(db);
    id = identity.createUser({ email: "tester@example.test", passwordHash: "x" }).id;
    identity.addMember(TEST_ORG, id, "owner");
    testUsers.set(db, id);
  }
  return id;
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
    OPENAI_MODEL: undefined,
    ANTHROPIC_MODEL: undefined,
    GEMINI_MODEL: undefined,
    DEFAULT_AI_PROVIDER: "openai",
    EMBEDDING_MODEL: "test-embedder",
    EMBEDDING_POOLING: "cls",
    EMBEDDING_QUERY_PREFIX: "",
    RETRIEVAL_TOP_K: 3,
    RETRIEVAL_MIN_SCORE: 0.1,
    MAX_UPLOAD_MB: 20,
    BOOTSTRAP_OWNER_EMAIL: undefined,
    BOOTSTRAP_OWNER_PASSWORD: undefined,
    BOOTSTRAP_OWNER_NAME: undefined,
    TRUSTED_PROXY_HOPS: 0,
    INVITE_TTL_HOURS: 168,
    OCR_ENABLED: true,
    OCR_LANGUAGES: "eng",
    OCR_MAX_PAGES: 300,
    OCR_WORKERS: undefined,
    APP_BASE_URL: "http://localhost:3000",
    INTEGRATIONS_ENCRYPTION_KEY: undefined,
    GOOGLE_OAUTH_CLIENT_ID: undefined,
    GOOGLE_OAUTH_CLIENT_SECRET: undefined,
    MICROSOFT_OAUTH_CLIENT_ID: undefined,
    MICROSOFT_OAUTH_CLIENT_SECRET: undefined,
    MICROSOFT_OAUTH_TENANT: "common",
    GEMINI_TTS_ENABLED: true,
    GEMINI_TTS_MODEL: "gemini-3.8-flash-lite-tts",
    GEMINI_TTS_VOICE: "Kore",
    TTS_MAX_CHARS: 5000,
    VOICE_INPUT_ENABLED: true,
    GEMINI_STT_MODEL: undefined,
    DEMO_USER_EMAIL: "demo@knowledgebase.ai",
    DEMO_USER_PASSWORD: undefined,
    DEMO_SHOW_CREDENTIALS: false,
    AUTH_SESSION_HOURS: 24,
    TEMPORARY_PASSWORD_HOURS: 72,
    CONSULTATIONS_ENCRYPTION_KEY: undefined,
    CONSULTATIONS_MAX_MINUTES: 45,
    CONSULTATIONS_MAX_STORAGE_GB: 25,
    CONSULTATIONS_MAX_AUDIO_MB: 120,
    CONSULTATIONS_AUDIO_DIR: undefined,
    CONSULTATIONS_TRANSCRIPTION_PROVIDER: undefined,
    CONSULTATIONS_TRANSCRIPTION_MODEL: undefined,
    CONSULTATIONS_NOTE_MODEL: undefined,
    CONSULTATIONS_PROVIDER_REVIEW: undefined,
    CONSULTATIONS_PROVIDER_REGION: undefined,
    CONSULTATIONS_WORKER: true,
    DATA_DIR: "./data-test",
    ...overrides,
  };
}

/**
 * Deterministic bag-of-words embedder: each vocabulary word is one dimension.
 * Good enough to test that retrieval ranks the right chunk first.
 */
export class FakeEmbedder implements Embedder {
  readonly modelId: string;
  constructor(
    private readonly vocab: string[],
    modelId = "test-embedder",
  ) {
    this.modelId = modelId;
  }

  private vec(text: string): Float32Array {
    const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
    const v = new Float32Array(this.vocab.length);
    for (const w of words) {
      const i = this.vocab.indexOf(w);
      if (i >= 0) v[i]! += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }

  async embedDocuments(texts: string[]) {
    return texts.map((t) => this.vec(t));
  }

  async embedQuery(text: string) {
    return this.vec(text);
  }
}

/** All text parts of a provider request, joined (the prompt as the model sees it, minus images). */
export function promptText(req: { content: ({ type: "text"; text: string } | { type: "image" })[] }): string {
  return req.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

/**
 * For vi.mock("@/server/auth/password", ...): hash with cheap scrypt settings unless a test passes its own, because the
 * real cost (about 100 ms per hash) is pointless in tests. Verification reads the parameters from the stored hash, so
 * hashes made either way check normally.
 */
export function withFastPasswords<T extends { hashPassword: (password: string, params?: { N: number; r: number; p: number }) => Promise<string> }>(original: T): T {
  const fast = { N: 1024, r: 8, p: 1 };
  return { ...original, hashPassword: (password: string, params = fast) => original.hashPassword(password, params) };
}
