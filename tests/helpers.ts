import type Database from "better-sqlite3";
import type { AppConfig } from "@/server/config";
import { openDatabase } from "@/server/db/client";
import type { Embedder } from "@/server/knowledge/embedder";

export function memoryDb(): Database.Database {
  return openDatabase(":memory:");
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
    APP_BASE_URL: "http://localhost:3000",
    INTEGRATIONS_ENCRYPTION_KEY: undefined,
    GOOGLE_OAUTH_CLIENT_ID: undefined,
    GOOGLE_OAUTH_CLIENT_SECRET: undefined,
    MICROSOFT_OAUTH_CLIENT_ID: undefined,
    MICROSOFT_OAUTH_CLIENT_SECRET: undefined,
    MICROSOFT_OAUTH_TENANT: "common",
    DEMO_USER_EMAIL: "demo@knowledgebase.ai",
    DEMO_USER_PASSWORD: "Demo@12345",
    DEMO_SHOW_CREDENTIALS: true,
    AUTH_SESSION_HOURS: 24,
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
