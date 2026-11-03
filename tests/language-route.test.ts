import type Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationRepository } from "@/server/db/repositories";
import { body, call, seedMember, seedOrganization, type Seeded } from "./harness";
import { memoryDb } from "./helpers";

// The HTTP side of changing an answer's language: who may ask, what is refused, and that a refused request neither
// reaches the AI provider nor changes anything.

const h = vi.hoisted(() => ({ db: undefined as unknown as Database.Database }));
vi.mock("@/server/db/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/db/client")>()), getDb: () => h.db }));
vi.mock("@/server/auth/password", async (importOriginal) => (await import("./helpers")).withFastPasswords(await importOriginal<typeof import("@/server/auth/password")>()));
vi.mock("@/server/features/service", async () => {
  const { FEATURES } = await import("@/lib/features");
  return {
    getFeatureFlags: () => FEATURES.map((f) => ({ key: f.key, name: f.name, available: true })),
    isFeatureEnabled: () => true,
    getFeatureAvailability: () => ({}),
    getFeatureFlagService: () => ({}),
    defaultFeatureFlags: () => [],
  };
});
const provider = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@/server/llm/registry", () => ({ getProvider: () => ({ id: "gemini", generate: provider.generate }) }));

import * as languageRoute from "@/app/api/messages/[id]/language/route";

let db: Database.Database;
let acme: string;
let globex: string;
let owner: Seeded; // owner of Acme: the author of the answer
let member: Seeded; // another person in Acme
let intruder: Seeded; // owner of Globex
let messageId: string;

const post = (cookie: string | undefined, id: string, json: unknown) => call(languageRoute.POST, `/api/messages/${id}/language`, { method: "POST", cookie, json, params: { id } });

beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  provider.generate.mockReset();
  db = memoryDb();
  h.db = db;
  acme = seedOrganization(db, "Acme");
  globex = seedOrganization(db, "Globex");
  owner = seedMember(db, acme, "owner@acme.test", "owner");
  member = seedMember(db, acme, "member@acme.test", "member");
  intruder = seedMember(db, globex, "owner@globex.test", "owner");
  const conversations = new ConversationRepository(db, acme, owner.userId);
  const id = conversations.create("chat");
  const [, assistant] = conversations.addMessages(id, [
    { role: "user", content: "Q?" },
    { role: "assistant", content: "A [1].", citations: [], structured: { found: true, title: "T", summary: "Avoid X [1].", sections: [], sources: [], language: "en" }, language: "en", provider: "gemini", model: "g", noContext: false },
  ]);
  messageId = assistant!.id;
});

describe("POST /api/messages/[id]/language", () => {
  it("is refused without a session (401), and for a bad body or an unknown language (400), without touching the provider", async () => {
    expect((await post(undefined, messageId, { language: "hi" })).status).toBe(401);
    for (const json of [undefined, {}, { language: "xx" }, { language: 5 }, { language: "hi", extra: true }]) {
      expect((await post(owner.cookie, messageId, json)).status, JSON.stringify(json)).toBe(400);
    }
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("answers 404 for another workspace's and a colleague's message (and for unknown ids), changing nothing and calling no provider", async () => {
    const before = JSON.stringify(db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId));
    for (const caller of [intruder, member]) {
      const res = await post(caller.cookie, messageId, { language: "hi" });
      expect(res.status, caller.email).toBe(404);
    }
    expect((await post(owner.cookie, "00000000-0000-4000-8000-000000000000", { language: "hi" })).status).toBe(404);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(JSON.stringify(db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId))).toBe(before);
  });

  it("answers 502 with a clear message, and changes nothing, when the AI keeps answering in the wrong script", async () => {
    provider.generate.mockImplementation(async (req: { system: string; content: { text: string }[] }) => {
      if (/^You translate/.test(req.system)) return { text: JSON.stringify({ t: (JSON.parse(req.content[0]!.text) as string[]).map((s) => `मेटफॉर्मिन के बारे में ${s}`) }) };
      return { text: JSON.stringify({ found: true, title: "मेटफॉर्मिन", summary: "मेटफॉर्मिन के बारे में जानकारी", sections: [] }) };
    });
    process.env.GEMINI_API_KEY = "AIza-test-key-12345678";
    db.prepare("INSERT INTO provider_settings (provider, model) VALUES ('gemini', 'g')").run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('active_provider', 'gemini')").run();
    const { resetConfigForTests } = await import("@/server/config");
    resetConfigForTests();
    const before = JSON.stringify(db.prepare("SELECT language, content, structured_json FROM messages WHERE id = ?").get(messageId));

    const res = await post(owner.cookie, messageId, { language: "gu" });

    expect(res.status).toBe(502);
    expect((await body<{ error: string }>(res)).error).toMatch(/did not return a reliable Gujarati translation.*Your answer is unchanged: please try again\./);
    expect(JSON.stringify(db.prepare("SELECT language, content, structured_json FROM messages WHERE id = ?").get(messageId))).toBe(before);
    delete process.env.GEMINI_API_KEY;
    resetConfigForTests();
  });

  it("translates for the author: one model call with only the answer's text, the message updated in place, and a repeat costs nothing", async () => {
    provider.generate.mockImplementation(async (req: { content: { text: string }[] }) => ({ text: JSON.stringify({ t: (JSON.parse(req.content[0]!.text) as string[]).map((s) => `हिन्दी ${s}`) }) }));
    // The provider needs a key and model: set the active provider's model in the database, and the key in the environment.
    process.env.GEMINI_API_KEY = "AIza-test-key-12345678";
    db.prepare("INSERT INTO provider_settings (provider, model) VALUES ('gemini', 'g')").run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('active_provider', 'gemini')").run();
    const { resetConfigForTests } = await import("@/server/config");
    resetConfigForTests();

    const res = await post(owner.cookie, messageId, { language: "hi" });

    expect(res.status).toBe(200);
    const { message } = await body<{ message: { id: string; language: string; structured: { title: string; summary: string } } }>(res);
    expect(message).toMatchObject({ id: messageId, language: "hi" });
    expect(message.structured.summary).toBe("हिन्दी Avoid X [1].");
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(provider.generate.mock.calls[0]![0].content[0].text)).toEqual(["T", "Avoid X [1]."]);

    expect((await post(owner.cookie, messageId, { language: "en" })).status).toBe(200);
    expect((await post(owner.cookie, messageId, { language: "hi" })).status).toBe(200);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    delete process.env.GEMINI_API_KEY;
    resetConfigForTests();
  });
});
