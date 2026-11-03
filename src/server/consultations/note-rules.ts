import "server-only";
import { z } from "zod";
import { NOTE_ORIGINS, NOTE_SECTION_KEYS, type NoteContent, type NoteFlag, type NoteItem } from "@/lib/consultations";
import { ConsultationError } from "./errors";

// The rules every saved note version must follow, whoever wrote it. The browser's copy of the note is a request, not a fact:
// the server decides what is kept.
//   - the nine sections are always present, in order, each at most MAX_ITEMS long;
//   - an item's "written by the doctor" mark is computed here (new or changed by this save), never taken from the browser;
//   - the safety flags (uncertain transcription, ambiguity, needs confirmation, removed by a safety check) can only be marked
//     reviewed: they can't be deleted, reworded or added, so nothing the checks found can quietly disappear;
//   - evidence can only point at transcript segments that exist.

const MAX_ITEMS = 60;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const evidence = z.array(z.number().int().min(1).max(100_000)).max(20);

export const noteSchema = z
  .object({
    sections: z
      .array(
        z
          .object({
            key: z.enum(NOTE_SECTION_KEYS as [string, ...string[]]),
            items: z
              .array(
                z
                  .object({
                    id: z.string().regex(ID),
                    text: z.string().trim().min(1).max(2000),
                    origin: z.enum(NOTE_ORIGINS),
                    evidence,
                  })
                  .strip(),
              )
              .max(MAX_ITEMS),
          })
          .strict(),
      )
      .length(NOTE_SECTION_KEYS.length),
    flags: z.array(z.object({ id: z.string().regex(ID), resolved: z.boolean() }).strip()).max(200),
  })
  .strict();
export type SubmittedNote = z.infer<typeof noteSchema>;

const invalid = (message: string) => new ConsultationError(400, "invalid_note", message);
const sameNumbers = (a: number[], b: number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

/** Turns the doctor's submitted edit into the note to store, applying the rules above to the previous version. */
export function applyDoctorEdit(previous: NoteContent, submitted: SubmittedNote, segmentCount: number): NoteContent {
  const keys = submitted.sections.map((s) => s.key);
  if (keys.some((k, i) => k !== NOTE_SECTION_KEYS[i])) throw invalid("The note must contain every section, in order.");

  const before = new Map<string, NoteItem>(previous.sections.flatMap((s) => s.items).map((i) => [i.id, i]));
  const seen = new Set<string>();
  const sections = submitted.sections.map((section) => ({
    key: section.key as NoteContent["sections"][number]["key"],
    items: section.items.map((item): NoteItem => {
      if (seen.has(item.id)) throw invalid("Two lines of the note have the same identifier.");
      seen.add(item.id);
      const ev = [...new Set(item.evidence)].sort((a, b) => a - b);
      if (ev.some((n) => n > segmentCount)) throw invalid("A line points at a part of the transcript that doesn't exist.");
      const old = before.get(item.id);
      if (old && old.text === item.text && old.origin === item.origin && sameNumbers(old.evidence, ev)) return old; // untouched: stays exactly as it was
      return { id: item.id, text: item.text, origin: item.origin, evidence: ev, byDoctor: true };
    }),
  }));

  const resolved = new Map(submitted.flags.map((f) => [f.id, f.resolved]));
  if (resolved.size !== submitted.flags.length) throw invalid("Two flags have the same identifier.");
  if (previous.flags.length !== resolved.size || previous.flags.some((f) => !resolved.has(f.id))) throw invalid("Flags can be marked as reviewed, but not added or removed.");
  const flags: NoteFlag[] = previous.flags.map((f) => ({ ...f, resolved: resolved.get(f.id)! }));

  return { sections, flags };
}

/** The flags the doctor has not reviewed yet; approval is refused while there are any. */
export const unresolvedFlags = (note: NoteContent): NoteFlag[] => note.flags.filter((f) => !f.resolved);
