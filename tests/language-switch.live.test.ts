import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { getLanguage } from "@/lib/languages";
import { getConfig } from "@/server/config";
import { ConversationRepository } from "@/server/db/repositories";
import { toMessageDTO } from "@/server/dto";
import { getProvider } from "@/server/llm/registry";
import { ProviderConfigService } from "@/server/llm/resolve";
import type { LLMProvider, LLMRequest } from "@/server/llm/types";
import { generateGroundedAnswer, requireProviderAuth } from "@/server/rag/answer";
import type { SourceChunk } from "@/server/rag/citations";
import { setAnswerLanguage } from "@/server/rag/answer-language";
import { extractText } from "@/server/rag/translation";
import { memoryDb, TEST_ORG, testUserId } from "./helpers";

// A LIVE measurement of how long changing an answer's language takes with the configured AI provider. It spends a few
// provider calls (fictional text only: no document or chat of yours is read or sent), so it is skipped unless asked for:
//
//   LIVE_LANGUAGE_BENCH=1 LANGUAGE_BENCH_OUT=<file.json> npx vitest run tests/language-switch.live.test.ts
//
// LANGUAGE_BENCH_PROVIDER=openai|anthropic|gemini measures another configured provider than the active one, and
// LANGUAGE_BENCH_MODEL=<id> uses another model of that provider (for example when the configured one is rate-limited), and
// LANGUAGE_BENCH_LEGACY=1 also times the old way (re-answering from the passages) on the same model, for comparison, and
// LANGUAGE_BENCH_SAMPLES=<n> sets the first-time translations per language (default 3).
// LANGUAGE_BENCH_FIXTURE=<file.json> keeps the English answer and its sources, so two runs (for example before and
// after a change) translate exactly the same answer.

const LIVE = process.env.LIVE_LANGUAGE_BENCH === "1";
const SAMPLES = Number(process.env.LANGUAGE_BENCH_SAMPLES ?? 3);

/** Fictional guideline passages of about the size retrieval returns (the database's chunks average ~900 characters). */
const PASSAGES: { filename: string; page: number; content: string }[] = [
  { filename: "Examplamine-Guideline.pdf", page: 6, content: "Renal impairment. Examplamine is contraindicated when the estimated glomerular filtration rate (eGFR) is below 30 mL/min/1.73 m². In patients with an eGFR of 30–44 mL/min/1.73 m² the dose should be reviewed and the maximum daily dose must not exceed 1000 mg; treatment should not be started in new patients at this level. Renal function should be checked before the first dose and at least once a year, and every 3 to 6 months in patients at risk of renal decline such as older adults or those taking nephrotoxic medicines. If renal function falls below the threshold during treatment, examplamine must be stopped and the prescriber informed. The risk of accumulation is the main concern in renal impairment and is the reason for the contraindication; patients should be told to report reduced urine output, swelling or unexplained tiredness without delay." },
  { filename: "Examplamine-Guideline.pdf", page: 9, content: "Iodinated contrast media. Examplamine should be withheld at the time of, or before, a procedure using iodinated contrast media in patients with an eGFR between 30 and 60 mL/min/1.73 m², in patients with a history of liver disease, alcoholism or heart failure, and in patients who will receive intra-arterial contrast. Treatment is restarted no sooner than 48 hours after the procedure and only if renal function has been re-evaluated and found stable. In patients with an eGFR of 60 mL/min/1.73 m² or above no interruption is needed. Fluids should be encouraged around the procedure unless contraindicated, and the radiology department should be told that the patient takes examplamine so that the plan for interruption is recorded in the patient's notes." },
  { filename: "Examplamine-Guideline.pdf", page: 11, content: "Lactic acidosis. Lactic acidosis is a rare but serious complication that can occur through accumulation of examplamine. Reported risk factors include renal impairment, sepsis, dehydration, excess alcohol intake, hepatic insufficiency and any condition associated with hypoxia. Symptoms are non-specific: muscle cramps, abdominal pain, rapid breathing, severe tiredness and a feeling of cold. If acidosis is suspected, examplamine must be stopped and the patient admitted to hospital for urgent assessment, including blood lactate and pH. Treatment during acute illness with vomiting, diarrhoea, fever or reduced intake should be withheld until the patient is eating and drinking normally again, usually 24 to 48 hours after recovery, and then restarted at the previous dose." },
  { filename: "Examplamine-Guideline.pdf", page: 14, content: "Hepatic effects. Stop examplamine and arrange urgent review if jaundice, dark urine or severe abdominal pain develops. Liver function tests (ALT) should be measured before starting treatment, at 4 weeks and at 12 weeks, and then yearly. A rise in ALT above three times the upper limit of normal requires the dose to be interrupted and the cause to be investigated; treatment must not be restarted until the cause is known. Patients should be advised not to exceed the recommended weekly alcohol limit. Concomitant medicines that affect the liver should be reviewed at every visit, and any new symptom of liver injury should lead to an immediate liver function test." },
  { filename: "Examplamine-Guideline.pdf", page: 17, content: "Dosing and administration. The usual adult starting dose is 500 mg once daily with the evening meal, increased by 500 mg at intervals of at least one week according to tolerance and response, to a usual maintenance dose of 1000 mg twice daily. The maximum daily dose is 2000 mg in adults with normal renal function. Tablets are taken with or after meals to reduce gastrointestinal effects and swallowed whole with water. If a dose is missed, it is taken as soon as remembered unless the next dose is due within four hours; a double dose must never be taken. Children under 10 years should not be treated; for children aged 10 to 17 years the specialist guidance applies." },
  { filename: "Examplamine-Guideline.pdf", page: 21, content: "Monitoring schedule. Before starting: eGFR, ALT, glucose and weight. At 4 weeks: eGFR and ALT. At 12 weeks: ALT and glucose. Then every 3 months: weight and glucose; every 6 to 12 months: eGFR according to risk. After any change in dose all values should be re-checked within 2 weeks. Results are recorded in the patient's file together with the date, the dose and the clinician who reviewed them. If a scheduled visit is missed, the next available slot should be booked within 2 weeks and the patient reminded not to stop treatment without advice." },
];
const QUESTION = "Examplamine in renal impairment?";

/** Every number written in the text of an answer (not in its structure), sorted: the same list must survive a translation. */
const numbersIn = (texts: string[]) => texts.flatMap((t) => t.replace(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g, "").match(/\d+/g) ?? []).sort();
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stats = (xs: number[]) => ({ n: xs.length, mean: Math.round(mean(xs)), min: Math.round(Math.min(...xs)), max: Math.round(Math.max(...xs)), all: xs.map(Math.round) });

describe.skipIf(!LIVE)("language switch latency (live provider)", () => {
  it("measures first-time translation and repeat switching", async () => {
    createRequire(import.meta.url)("@next/env").loadEnvConfig(process.cwd(), true);
    const config = getConfig();

    // Use the provider and model the app itself is set to (read-only look at its settings).
    const real = new Database(path.resolve(config.DATA_DIR, "kb.sqlite"), { readonly: true });
    const activeProvider = (process.env.LANGUAGE_BENCH_PROVIDER ?? (real.prepare("SELECT value FROM app_settings WHERE key = 'active_provider'").get() as { value: string } | undefined)?.value ?? config.DEFAULT_AI_PROVIDER) as "openai" | "anthropic" | "gemini";
    const model = process.env.LANGUAGE_BENCH_MODEL ?? (real.prepare("SELECT model FROM provider_settings WHERE provider = ?").get(activeProvider) as { model: string } | undefined)?.model ?? null;
    real.close();

    const db = memoryDb();
    db.prepare("INSERT INTO provider_settings (provider, model) VALUES (?, ?)").run(activeProvider, model);
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('active_provider', ?)").run(activeProvider);
    const providerConfig = new ProviderConfigService(db, config);
    const auth = requireProviderAuth({ providerConfig }, activeProvider);

    // Time every provider call, and how much text goes in and comes out.
    const calls: { ms: number; inChars: number; outChars: number; system: number }[] = [];
    const inner = getProvider(activeProvider);
    const provider: LLMProvider = {
      id: inner.id,
      async generate(req: LLMRequest) {
        const started = performance.now();
        const out = await inner.generate(req);
        calls.push({ ms: performance.now() - started, inChars: req.content.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0), outChars: out.text.length, system: req.system.length });
        return out;
      },
    };

    const sources: SourceChunk[] = PASSAGES.map((p) => ({ source: "knowledge_base", documentId: "doc-1", filename: p.filename, pageStart: p.page, pageEnd: p.page, content: p.content, score: 0.8 }));
    const fixtureFile = process.env.LANGUAGE_BENCH_FIXTURE;
    let english: Awaited<ReturnType<typeof generateGroundedAnswer>>;
    let answerMs: number | null = null;
    if (fixtureFile && fs.existsSync(fixtureFile)) {
      english = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
    } else {
      const started = performance.now();
      english = await generateGroundedAnswer(provider, auth, { question: QUESTION, sources, language: getLanguage("en") });
      answerMs = performance.now() - started;
      if (fixtureFile) fs.writeFileSync(fixtureFile, JSON.stringify(english));
    }
    expect(english.structured).not.toBeNull();
    calls.length = 0;

    const conversations = new ConversationRepository(db, TEST_ORG, testUserId(db));
    const conversationId = conversations.create("bench");
    /** A fresh assistant message with the same answer, so every sample is a first-time translation. */
    const newMessage = () => {
      const [, assistant] = conversations.addMessages(conversationId, [
        { role: "user", content: QUESTION },
        { role: "assistant", content: english.answer, citations: english.citations, structured: english.structured, language: "en", context: { question: QUESTION, sources, imageNames: [] }, provider: activeProvider, model: auth.model, noContext: false },
      ]);
      return assistant!.id;
    };
    const deps = { conversations, providerConfig, getProvider: () => provider };

    const result: Record<string, unknown> = { provider: activeProvider, model: auth.model, englishAnswerGenerationMs: answerMs === null ? "(reused fixture)" : Math.round(answerMs), sourcesChars: sources.reduce((n, s) => n + s.content.length, 0), englishAnswerChars: english.answer.length };
    const firstTime: Record<string, number[]> = { hi: [], gu: [] };
    const callLog: Record<string, { inChars: number; outChars: number; system: number }[]> = { hi: [], gu: [] };
    const keepers: Record<string, string> = {};
    const englishNumbers = numbersIn(extractText(english.structured!));

    for (const language of ["hi", "gu"] as const) {
      for (let i = 0; i < SAMPLES; i++) {
        const id = newMessage();
        const before = calls.length;
        const started = performance.now();
        const message = await setAnswerLanguage(deps, id, language);
        firstTime[language]!.push(performance.now() - started);
        callLog[language]!.push(...calls.slice(before).map(({ inChars, outChars, system }) => ({ inChars, outChars, system })));
        expect(message.language).toBe(language);
        expect(message.structured?.found).toBe(true);
        if (i === 0) keepers[language] = id;
        // Numbers and units must survive translation.
        (result.numbersPreserved ??= {} as Record<string, boolean>);
        (result.numbersPreserved as Record<string, boolean>)[`${language}${i}`] = JSON.stringify(numbersIn(extractText(message.structured!))) === JSON.stringify(englishNumbers);
      }
    }
    result.firstTimeMs = { hi: stats(firstTime.hi!), gu: stats(firstTime.gu!) };

    // The way languages were changed before translation existed (still the fallback): re-answer from the passages with the
    // answer as reference. Measured on the same model, in the same run, so the two can be compared.
    if (process.env.LANGUAGE_BENCH_LEGACY === "1") {
      const reference = JSON.stringify({ title: english.structured!.title, summary: english.structured!.summary, sections: english.structured!.sections });
      const legacy: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const started = performance.now();
        await generateGroundedAnswer(provider, auth, { question: QUESTION, sources, language: getLanguage("hi"), reference });
        legacy.push(performance.now() - started);
      }
      result.legacyRegenerationMs = { hi: stats(legacy) };
    }
    result.providerCalls = callLog;

    // Repeat switching on one message that already has hi + gu + en saved.
    const id = keepers.hi!;
    await setAnswerLanguage(deps, id, "gu"); // saved too (first time for this message)
    const callsBefore = calls.length;
    const repeat: number[] = [];
    for (let i = 0; i < 12; i++) {
      for (const language of ["en", "hi", "gu"]) {
        const started = performance.now();
        await setAnswerLanguage(deps, id, language);
        repeat.push(performance.now() - started);
      }
    }
    result.repeatSwitchMs = { n: repeat.length, mean: +mean(repeat).toFixed(2), max: +Math.max(...repeat).toFixed(2) };
    result.providerCallsDuringRepeats = calls.length - callsBefore;
    expect(toMessageDTO(conversations.getMessage(id)!).language).toBe("gu");

    const out = process.env.LANGUAGE_BENCH_OUT;
    if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  }, 600_000);
});
