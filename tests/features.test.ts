import { describe, expect, it, vi } from "vitest";
import { FEATURES, FEATURE_KEYS, featureDefinition, resolveFeatures, type FeatureKey } from "@/lib/features";
import { ingestDocument } from "@/server/knowledge/ingest";
import { SqliteVectorStore } from "@/server/knowledge/vector-store";
import { FeatureDependencyError, FeatureFlagService } from "@/server/features/service";
import { ProviderConfigService } from "@/server/llm/resolve";
import type { LLMProvider, LLMRequest } from "@/server/llm/types";
import { answerQuestion, KNOWLEDGE_BASE_DISABLED_ANSWER } from "@/server/rag/answer";
import { prepareAttachments } from "@/server/rag/attachments";
import { FakeEmbedder, memoryDb, promptText, testConfig } from "./helpers";

const state = (states: ReturnType<typeof resolveFeatures>, key: FeatureKey) => states.find((s) => s.key === key)!;

describe("feature registry", () => {
  it("defines every key exactly once, with valid, acyclic dependencies", () => {
    expect(FEATURES.map((f) => f.key).sort()).toEqual([...FEATURE_KEYS].sort());
    for (const f of FEATURES) {
      const seen = new Set<FeatureKey>([f.key]);
      for (let dep = f.dependsOn; dep; dep = featureDefinition(dep).dependsOn) {
        expect(FEATURE_KEYS).toContain(dep);
        expect(seen.has(dep), `cycle through ${f.key}`).toBe(false);
        seen.add(dep);
      }
    }
  });

  it("has the required defaults: core ON, roadmap OFF", () => {
    const on = FEATURES.filter((f) => f.defaultEnabled).map((f) => f.key).sort();
    expect(on).toEqual(["ai_model_settings", "chat", "dashboard", "documents", "google_drive", "knowledge_base", "onedrive", "website_scraper"]);
    expect(featureDefinition("sync_integrations").defaultEnabled).toBe(false);
  });

  it("has the required dependencies", () => {
    expect(featureDefinition("ai_agents").dependsOn).toBe("knowledge_base");
    expect(featureDefinition("sync_integrations").dependsOn).toBe("knowledge_base");
    expect(featureDefinition("documents").dependsOn).toBe("knowledge_base");
    expect(featureDefinition("widget_management").dependsOn).toBe("chat");
    expect(featureDefinition("ai_model_settings").dependsOn).toBe("chat");
  });
});

describe("resolveFeatures", () => {
  it("uses safe defaults when switches are missing", () => {
    const s = resolveFeatures({});
    expect(state(s, "chat")).toMatchObject({ enabled: true, available: true, status: "on" });
    expect(state(s, "ai_agents")).toMatchObject({ enabled: false, available: false, status: "off", blockedBy: null });
  });

  it("makes dependents unavailable when Knowledge Base is off, but keeps their switches", () => {
    const s = resolveFeatures({ knowledge_base: false, ai_agents: true, sync_integrations: true });
    for (const key of ["documents", "ai_agents", "sync_integrations", "category_management"] as const) {
      expect(state(s, key).available, key).toBe(false);
      expect(state(s, key).blockedBy, key).toBe("knowledge_base");
    }
    expect(state(s, "ai_agents")).toMatchObject({ enabled: true, status: "unavailable" });
    expect(state(s, "chat").available).toBe(true); // unrelated features are unaffected
  });

  it("restores dependents when the dependency is turned back on", () => {
    const s = resolveFeatures({ knowledge_base: true, ai_agents: true });
    expect(state(s, "ai_agents")).toMatchObject({ available: true, status: "on", blockedBy: null });
  });

  it("follows dependencies transitively (Chat off → AI Model Settings unavailable)", () => {
    const s = resolveFeatures({ chat: false });
    expect(state(s, "ai_model_settings")).toMatchObject({ enabled: true, available: false, blockedBy: "chat" });
  });
});

describe("FeatureFlagService", () => {
  it("seeds a row per feature with defaults and persists switches across instances (restart)", () => {
    const db = memoryDb();
    const svc = new FeatureFlagService(db);
    expect(svc.isFeatureEnabled("ai_agents")).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM feature_flags").get()).toEqual({ n: FEATURES.length });

    svc.setFeatureEnabled("ai_agents", true);
    const restarted = new FeatureFlagService(db); // a fresh service = a server restart
    expect(restarted.isFeatureEnabled("ai_agents")).toBe(true);
    expect(db.prepare("SELECT enabled, depends_on, category FROM feature_flags WHERE key = 'ai_agents'").get()).toEqual({
      enabled: 1,
      depends_on: "knowledge_base",
      category: "AI",
    });
  });

  it("refuses to enable a feature whose dependency is off", () => {
    const svc = new FeatureFlagService(memoryDb());
    svc.setFeatureEnabled("knowledge_base", false);
    expect(() => svc.setFeatureEnabled("ai_agents", true)).toThrow(FeatureDependencyError);
    expect(() => svc.setFeatureEnabled("ai_agents", true)).toThrow(/depends on Knowledge Base/);
    svc.setFeatureEnabled("knowledge_base", true);
    expect(svc.setFeatureEnabled("ai_agents", true).find((f) => f.key === "ai_agents")!.available).toBe(true);
  });

  it("disabling a dependency never deletes data or rewrites dependents' switches", () => {
    const db = memoryDb();
    const svc = new FeatureFlagService(db);
    svc.setFeatureEnabled("ai_agents", true);
    svc.setFeatureEnabled("knowledge_base", false);
    expect(db.prepare("SELECT enabled FROM feature_flags WHERE key = 'ai_agents'").get()).toEqual({ enabled: 1 });
    expect(svc.isFeatureEnabled("ai_agents")).toBe(false);
  });

  it("treats a missing row as its safe default and ignores unknown rows", () => {
    const db = memoryDb();
    const svc = new FeatureFlagService(db);
    svc.getFeatureFlags(); // seed
    db.prepare("DELETE FROM feature_flags WHERE key IN ('chat', 'channels')").run();
    db.prepare("INSERT INTO feature_flags (id, key, name, description, category, enabled) VALUES ('x', 'legacy', 'L', '', 'Core', 1)").run();
    const flags = svc.getFeatureFlags();
    expect(flags.find((f) => f.key === "chat")!.available).toBe(true);
    expect(flags.find((f) => f.key === "channels")!.available).toBe(false);
    expect(flags.map((f) => f.key)).not.toContain("legacy");
  });
});

describe("answering with the Knowledge Base disabled", () => {
  async function setup() {
    const db = memoryDb();
    const embedder = new FakeEmbedder(["battery", "warranty", "months"]);
    const vectorStore = new SqliteVectorStore(db);
    await ingestDocument({ db, embedder, vectorStore }, { filename: "kb.txt", buffer: Buffer.from("Battery warranty: 12 months.") });
    const providerConfig = new ProviderConfigService(db, testConfig({ GEMINI_API_KEY: "AIza-test-key-12345678", GEMINI_MODEL: "g" }));
    const generate = vi.fn(async (_req: LLMRequest) => ({ text: "ok" }));
    const provider: LLMProvider = { id: "gemini", generate };
    return { deps: { embedder, vectorStore, providerConfig, getProvider: () => provider, retrieval: { topK: 3, minScore: 0.1 } }, generate };
  }

  it("does not search documents and explains why", async () => {
    const { deps, generate } = await setup();
    const res = await answerQuestion(deps, { question: "battery warranty?", provider: "gemini", useKnowledgeBase: false });
    expect(res).toMatchObject({ noContext: true, answer: KNOWLEDGE_BASE_DISABLED_ANSWER });
    expect(generate).not.toHaveBeenCalled();
  });

  it("still answers from attachments, without Knowledge Base passages", async () => {
    const { deps, generate } = await setup();
    const attachments = await prepareAttachments([{ name: "note.txt", buffer: Buffer.from("Battery warranty: 24 months.") }]);
    await answerQuestion(deps, { question: "battery warranty?", provider: "gemini", attachments, useKnowledgeBase: false });
    const text = promptText(generate.mock.calls[0]![0]);
    expect(text).toContain("24 months");
    expect(text).not.toContain("12 months");
  });
});
