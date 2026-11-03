import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TranscriptContent } from "@/lib/consultations";
import { getConfig } from "@/server/config";
import { processingGate } from "@/server/consultations/gate";
import { draftNote } from "@/server/consultations/note-ai";
import { geminiTranscriber } from "@/server/consultations/transcription/gemini";
import { getProvider } from "@/server/llm/registry";
import { ProviderConfigService } from "@/server/llm/resolve";
import { memoryDb } from "./helpers";
import { charErrorRate, numberRecall, percent, scriptDrift, scriptMix, termRecall, wordErrorRate } from "./consultation-eval-metrics";

// THE CHECK TO RUN BEFORE ANY REAL PATIENT: how well does the configured speech service handle YOUR clinic's real conversations in Gujarati, Hindi
// and English, including mixing them in one sentence? It is skipped unless asked for, because it sends audio to the AI provider.
//
// What it needs, in a folder of your choosing (CONSULT_EVAL_DIR):
//   visit-01.webm            a recording (also .wav .mp3 .m4a .mp4 .ogg) of a CONSENTED visit, or of staff acting one out
//   visit-01.reference.txt   (optional but needed for accuracy figures) what was actually said, written out by a person who speaks the languages,
//                            in each language's own script (Gujarati script, Devanagari, Latin for English words)
//   visit-01.terms.txt       (optional) the drug names and doses that matter most, one per line, e.g. "metformin" or "500 mg"
//
//   CONSULT_EVAL_DIR=D:\samples CONSULT_EVAL_CONFIRM_CONSENTED=yes npx vitest run tests/consultation-eval.live.test.ts
//
// It refuses to run unless CONSULT_EVAL_CONFIRM_CONSENTED=yes (you are confirming the people in the recordings consented to this use) AND the same privacy
// gate the application uses is open (a provider, a model, and the recorded review of who checked its data handling). It prints NUMBERS ONLY to the
// console. The transcripts and drafted notes (which contain what was said) are written to <dir>/eval-report/, which is YOUR folder: keep it as private as
// the recordings, and delete it when you are done. Set CONSULT_EVAL_NOTE=1 to also draft a note from each transcript and check it against the transcript.
//
// What the figures mean, and what they do not: WER/CER say how close the text is to your reference; script drift says how far the mix of Gujarati,
// Hindi and Latin letters is from the reference (a large number means a language came back in the wrong script); number and term recall say how many of
// the doses and drug names were captured. A handful of recordings cannot prove the service is safe: they show where it is weak. Do not rely on a
// transcript, or a note, without a doctor's review: the application never approves anything on its own.

const DIR = process.env.CONSULT_EVAL_DIR;
const CONFIRMED = process.env.CONSULT_EVAL_CONFIRM_CONSENTED === "yes";
const WITH_NOTE = process.env.CONSULT_EVAL_NOTE === "1";
const TYPES: Record<string, string> = { ".webm": "audio/webm", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".ogg": "audio/ogg" };

describe.skipIf(!DIR)("speech service on real consented recordings (live provider)", () => {
  it("transcribes each recording and measures the result", async () => {
    expect(CONFIRMED, "Set CONSULT_EVAL_CONFIRM_CONSENTED=yes to confirm that the people in these recordings agreed to this use.").toBe(true);
    const config = getConfig();
    const providers = new ProviderConfigService(memoryDb(), config);
    const gemini = providers.resolve("gemini");
    const gate = processingGate(config, gemini.apiKey ?? undefined);
    expect(gate.open, `The privacy gate is closed: ${gate.reason}`).toBe(true);

    const dir = DIR!;
    const files = fs.readdirSync(dir).filter((f) => TYPES[path.extname(f).toLowerCase()]).sort();
    expect(files.length, `No recordings found in ${dir}`).toBeGreaterThan(0);
    const out = path.join(dir, "eval-report");
    fs.mkdirSync(out, { recursive: true });

    const report: Record<string, unknown>[] = [];
    const lines: string[] = [];
    for (const file of files) {
      const base = path.basename(file, path.extname(file));
      const audio = fs.readFileSync(path.join(dir, file));
      const refPath = path.join(dir, `${base}.reference.txt`);
      const termsPath = path.join(dir, `${base}.terms.txt`);
      const reference = fs.existsSync(refPath) ? fs.readFileSync(refPath, "utf8") : null;
      const terms = fs.existsSync(termsPath) ? fs.readFileSync(termsPath, "utf8").split(/\r?\n/).map((t) => t.trim()).filter(Boolean) : [];

      const started = Date.now();
      let transcript: TranscriptContent;
      try {
        transcript = await geminiTranscriber.transcribe({ audio, mimeType: TYPES[path.extname(file).toLowerCase()]!, languageHint: "mixed", model: config.CONSULTATIONS_TRANSCRIPTION_MODEL!, apiKey: gemini.apiKey!, signal: undefined });
      } catch (err) {
        const code = (err as { code?: string }).code ?? "error";
        lines.push(`${file}: FAILED (${code}) after ${Math.round((Date.now() - started) / 1000)} s`);
        report.push({ file, failed: code });
        continue;
      }
      const seconds = (Date.now() - started) / 1000;
      const text = transcript.segments.map((s) => s.text).join(" ");
      const mix = scriptMix(text);
      const speakers = Object.fromEntries(["doctor", "patient", "other", "unknown"].map((s) => [s, transcript.segments.filter((x) => x.speaker === s).length]));
      const uncertain = transcript.segments.filter((s) => s.uncertain).length;
      const row: Record<string, unknown> = { file, audioKB: Math.round(audio.length / 1024), seconds: Math.round(seconds), segments: transcript.segments.length, uncertainSegments: uncertain, speakers, scriptShare: { gujarati: percent(mix.share.gujarati), devanagari: percent(mix.share.devanagari), latin: percent(mix.share.latin) }, audioQuality: transcript.audioQuality };
      let line = `${file}: ${transcript.segments.length} segments, ${uncertain} uncertain, ${Math.round(seconds)} s; scripts gu ${percent(mix.share.gujarati)} / hi ${percent(mix.share.devanagari)} / latin ${percent(mix.share.latin)}; speakers ${JSON.stringify(speakers)}`;
      if (reference) {
        const wer = wordErrorRate(reference, text);
        const cer = charErrorRate(reference, text);
        const numbers = numberRecall(reference, text);
        const drift = scriptDrift(reference, text);
        Object.assign(row, { wer: percent(wer), cer: percent(cer), scriptDriftPoints: drift, numberRecall: percent(numbers.recall), numbersMissing: numbers.missing.length });
        line += `; WER ${percent(wer)}, CER ${percent(cer)}, script drift ${drift} points, numbers ${percent(numbers.recall)} (${numbers.missing.length} missing)`;
        if (terms.length > 0) {
          const t = termRecall(terms, text);
          Object.assign(row, { termRecall: percent(t.recall), termsMissing: t.missing.length });
          line += `, terms ${percent(t.recall)} (${t.missing.length} missing)`;
        }
      } else {
        line += "  [no reference text: no accuracy figures]";
      }
      let note = null;
      if (WITH_NOTE) {
        const drafted = await draftNote({ provider: getProvider("gemini"), model: config.CONSULTATIONS_NOTE_MODEL ?? gemini.model!, apiKey: gemini.apiKey!, transcript });
        const kinds = drafted.note.flags.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }), {});
        note = drafted.note;
        Object.assign(row, { noteLines: drafted.note.sections.reduce((n, s) => n + s.items.length, 0), noteFlags: kinds, statementsRemoved: drafted.dropped });
        line += `; note: ${drafted.note.sections.reduce((n, s) => n + s.items.length, 0)} lines, flags ${JSON.stringify(kinds)}, ${drafted.dropped} removed by the safety check`;
      }
      lines.push(line);
      report.push(row);
      // The transcript and note go to the doctor's own folder, never to the console.
      fs.writeFileSync(path.join(out, `${base}.transcript.json`), JSON.stringify({ transcript, note }, null, 2));
    }
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(out, "report.md"), ["# Speech service evaluation", "", ...lines.map((l) => `- ${l}`), "", "Figures only measure these recordings. A doctor must review every transcript and note."].join("\n"));
    process.stdout.write(`\n${lines.join("\n")}\n\nFull report (it contains what was said): ${out}\n`);
    expect(report.length).toBe(files.length);
  }, 60 * 60_000);
});
