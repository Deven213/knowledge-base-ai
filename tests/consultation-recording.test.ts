import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UPLOAD_PART_BYTES } from "@/lib/consultations";
import { CONSENT_VERSION } from "@/lib/consultation-consent";
import { LocalAudioStore, newStorageKey, partKey } from "@/server/consultations/audio-store";
import { ConsultationError } from "@/server/consultations/errors";
import { normalizeAudioMime, parseRange, RecordingService, sniffAudio } from "@/server/consultations/recording";
import { ConsultationRepository } from "@/server/consultations/repository";
import { Vault } from "@/server/security/vault";
import { seedMember, seedOrganization } from "./harness";
import { audioBytes, CONSULT_KEY, partsOf, sha256 } from "./consultation-helpers";
import { memoryDb } from "./helpers";
import os from "node:os";

const PART = UPLOAD_PART_BYTES;

let db: Database.Database;
let dir: string;
let store: LocalAudioStore;
const vault = new Vault(CONSULT_KEY);

function setup(orgName = "Acme", email = "doc@acme.test", limits = { maxBytes: 20 * 1024 * 1024, maxMinutes: 60 }) {
  const org = seedOrganization(db, orgName);
  const doctor = seedMember(db, org, email, "doctor");
  const repo = new ConsultationRepository(db, org, doctor.userId, () => vault);
  const recordings = new RecordingService(repo, store, () => vault, org, limits);
  const consultation = repo.create({ patientLabel: "Asha Patel", languageHint: "mixed", consent: { textVersion: CONSENT_VERSION, textSha256: "h", language: "gu", givenBy: "patient", method: "verbal" } });
  return { org, doctor, repo, recordings, consultation };
}

const claimed = (bytes: Buffer, parts: Buffer[], durationMs = 60_000) => ({ totalBytes: bytes.length, partCount: parts.length, durationMs, sha256: sha256(bytes) });
const refusal = async (promise: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof promise === "function" ? promise() : promise);
    return undefined;
  } catch (err) {
    return err as ConsultationError;
  }
};
const filesUnder = (root: string): string[] => (fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).map(String) : []);

beforeEach(() => {
  db = memoryDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-audio-"));
  store = new LocalAudioStore(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the private audio store", () => {
  it("keeps what it is given and gives it back, and removing something twice is harmless", async () => {
    const key = partKey(newStorageKey(), 1);
    await store.put(key, Buffer.from("sealed bytes"));
    expect((await store.get(key)).toString()).toBe("sealed bytes");
    await store.delete(key);
    await store.delete(key);
    await expect(store.get(key)).rejects.toThrow();
  });

  it("removes a recording's whole folder and reports how much it removed", async () => {
    const folder = newStorageKey();
    await store.put(partKey(folder, 1), Buffer.from("a"));
    await store.put(partKey(folder, 2), Buffer.from("b"));
    expect(await store.deletePrefix(folder)).toBe(2);
    expect(await store.deletePrefix(folder)).toBe(0);
    expect(filesUnder(dir)).toEqual([]);
  });

  it("refuses any key that isn't exactly the shape it writes, so no path can reach outside its folder", async () => {
    for (const bad of ["../escape", "..\\escape", "/etc/passwd", "C:\\Windows\\win.ini", `${newStorageKey()}/../../x`, `${newStorageKey()}/part-1`, "plain", `${newStorageKey()}/part-000001/extra`]) {
      await expect(store.put(bad, Buffer.from("x")), bad).rejects.toThrow(/Invalid audio/);
      await expect(store.get(bad), bad).rejects.toThrow(/Invalid audio/);
    }
    await expect(store.deletePrefix("..")).rejects.toThrow(/Invalid audio/);
    await expect(store.deletePrefix(`${newStorageKey()}/..`)).rejects.toThrow(/Invalid audio/);
  });

  it("never leaves a half-written part behind", async () => {
    const key = partKey(newStorageKey(), 1);
    await store.put(key, randomBytes(4096));
    expect(filesUnder(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("telling what a recording really is", () => {
  it("reads the type from the bytes, not from what the browser claims", () => {
    expect(sniffAudio(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))).toBe("audio/webm");
    expect(sniffAudio(Buffer.from("OggS\0\0\0\0"))).toBe("audio/ogg");
    expect(sniffAudio(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]))).toBe("audio/mp4");
    expect(sniffAudio(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]))).toBe("audio/wav");
    expect(sniffAudio(Buffer.from("ID3\u0004\0\0"))).toBe("audio/mpeg");
    expect(sniffAudio(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe("audio/mpeg");
    for (const notAudio of [Buffer.from("%PDF-1.7"), Buffer.from("<html>"), Buffer.from("MZ\x90\0"), Buffer.alloc(16), Buffer.from("PK\x03\x04"), randomBytes(0)]) {
      expect(sniffAudio(notAudio)).toBeNull();
    }
  });

  it("normalises the type the browser declares (parameters dropped, common aliases mapped) and refuses the rest", () => {
    expect(normalizeAudioMime("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(normalizeAudioMime("video/webm")).toBe("audio/webm");
    expect(normalizeAudioMime("AUDIO/X-WAV")).toBe("audio/wav");
    for (const bad of ["application/pdf", "text/html", "image/png", "", "audio/flac"]) expect(normalizeAudioMime(bad)).toBeNull();
  });
});

describe("receiving a recording", () => {
  it("opens an upload and, if asked again, resumes the same one with the parts already received", async () => {
    const { recordings, consultation } = setup();
    const first = recordings.start(consultation, "audio/webm;codecs=opus");
    expect(first.receivedParts).toEqual([]);
    await recordings.putPart(consultation, 1, audioBytes(PART));
    const again = recordings.start(consultation, "audio/webm");
    expect(again.recording.id).toBe(first.recording.id);
    expect(again.receivedParts).toEqual([1]);
  });

  it("refuses to start without a recorded consent, and refuses a format that isn't audio", () => {
    const { recordings, consultation } = setup();
    expect(() => recordings.start(consultation, "application/pdf")).toThrow(expect.objectContaining({ code: "unsupported_audio" }));
    db.prepare("DELETE FROM consultation_consents").run(); // the record is gone: whatever happened, no recording may start
    expect(() => recordings.start(consultation, "audio/webm")).toThrow(expect.objectContaining({ code: "consent_required", status: 409 }));
    expect(filesUnder(dir)).toEqual([]);
  });

  it("stores every part sealed: the file on disk reveals neither the audio nor who it belongs to", async () => {
    const { recordings, consultation, org } = setup();
    recordings.start(consultation, "audio/webm");
    const bytes = audioBytes(5000, 7);
    await recordings.putPart(consultation, 1, bytes);
    const files = filesUnder(dir).filter((f) => f.includes("part-"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{32}[\\/]part-000001$/); // an opaque folder: no organization, doctor, patient or consultation in the path
    expect(files[0]).not.toContain(org);
    expect(files[0]).not.toContain(consultation);
    const onDisk = fs.readFileSync(path.join(dir, files[0]!));
    expect(onDisk.includes(bytes.subarray(100, 140))).toBe(false); // none of the audio appears in the clear
    expect(onDisk.length).toBeGreaterThan(bytes.length); // plus the format byte, IV and tag
  });

  it("accepts the same part twice (a retry) as one part", async () => {
    const { recordings, repo, consultation } = setup();
    const { recording } = recordings.start(consultation, "audio/webm");
    const bytes = audioBytes(PART);
    await recordings.putPart(consultation, 1, bytes);
    await recordings.putPart(consultation, 1, bytes);
    expect(repo.parts(recording.id)).toHaveLength(1);
    expect(filesUnder(dir).filter((f) => f.includes("part-"))).toHaveLength(1);
  });

  it("refuses an empty part, an oversized part, a bad part number, and a first part that isn't audio", async () => {
    const { recordings, consultation } = setup();
    recordings.start(consultation, "audio/webm");
    expect(await refusal(recordings.putPart(consultation, 1, Buffer.alloc(0)))).toMatchObject({ code: "empty_part" });
    expect(await refusal(recordings.putPart(consultation, 1, audioBytes(PART + 1)))).toMatchObject({ code: "part_too_large", status: 413 });
    for (const n of [0, -1, 1.5, 999_999, Number.NaN]) expect(await refusal(recordings.putPart(consultation, n, audioBytes(100))), String(n)).toMatchObject({ code: "bad_part" });
    expect(await refusal(recordings.putPart(consultation, 1, Buffer.from("%PDF-1.7 not audio at all")))).toMatchObject({ code: "not_audio" });
    expect(await refusal(recordings.putPart(consultation, 1, Buffer.concat([Buffer.from("OggS"), randomBytes(100)])))).toMatchObject({ code: "not_audio" }); // real audio, but not the type it declared
  });

  it("stops accepting parts once the recording would exceed the size limit", async () => {
    const { recordings, consultation } = setup("Acme", "doc@acme.test", { maxBytes: PART + 1000, maxMinutes: 60 });
    recordings.start(consultation, "audio/webm");
    await recordings.putPart(consultation, 1, audioBytes(PART));
    expect(await refusal(recordings.putPart(consultation, 2, audioBytes(2000)))).toMatchObject({ code: "recording_too_large", status: 413 });
    await recordings.putPart(consultation, 2, audioBytes(900)); // within the limit
  });

  it("refuses a part when no upload is in progress", async () => {
    const { recordings, consultation } = setup();
    expect(await refusal(recordings.putPart(consultation, 1, audioBytes(100)))).toMatchObject({ code: "not_uploading" });
  });
});

describe("finishing a recording", () => {
  async function upload(bytes: Buffer) {
    const s = setup();
    s.recordings.start(s.consultation, "audio/webm");
    const parts = partsOf(bytes);
    for (const [i, p] of parts.entries()) await s.recordings.putPart(s.consultation, i + 1, p);
    return { ...s, parts };
  }

  it("keeps a whole, unaltered recording, hands the consultation to processing and queues exactly one job", async () => {
    const bytes = audioBytes(PART * 2 + 12345, 3);
    const { recordings, repo, consultation, parts } = await upload(bytes);
    expect(parts).toHaveLength(3);
    const done = await recordings.complete(consultation, claimed(bytes, parts, 125_000));
    expect(done.alreadyStored).toBe(false);
    expect(done.recording).toMatchObject({ status: "stored", size_bytes: bytes.length, part_count: 3, duration_ms: 125_000, sha256: sha256(bytes) });
    expect(repo.require(consultation).status).toBe("processing");
    const jobs = db.prepare("SELECT kind, status, generation FROM consultation_jobs").all();
    expect(jobs).toEqual([{ kind: "transcribe", status: "queued", generation: 1 }]);
  });

  it("is safe to repeat: a second completion changes nothing and queues nothing", async () => {
    const bytes = audioBytes(PART + 500);
    const { recordings, consultation, parts } = await upload(bytes);
    await recordings.complete(consultation, claimed(bytes, parts));
    const again = await recordings.complete(consultation, claimed(bytes, parts));
    expect(again.alreadyStored).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultation_jobs").get()).toEqual({ n: 1 });
  });

  it("refuses a recording whose checksum doesn't match what was received, and keeps nothing as complete", async () => {
    const bytes = audioBytes(PART + 500);
    const { recordings, repo, consultation, parts } = await upload(bytes);
    const err = await refusal(recordings.complete(consultation, { ...claimed(bytes, parts), sha256: sha256("something else") }));
    expect(err).toMatchObject({ code: "checksum_mismatch", status: 409 });
    expect(repo.recordingOf(consultation)!.status).toBe("uploading");
    expect(repo.require(consultation).status).toBe("uploading");
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultation_jobs").get()).toEqual({ n: 0 });
  });

  it("refuses when a part is missing, the total is wrong, a middle part is short, or the numbers are nonsense", async () => {
    const bytes = audioBytes(PART * 2 + 100);
    const { recordings, consultation, parts } = await upload(bytes);
    const ok = claimed(bytes, parts);
    expect(await refusal(recordings.complete(consultation, { ...ok, partCount: 4 }))).toMatchObject({ code: "incomplete_upload" });
    expect(await refusal(recordings.complete(consultation, { ...ok, totalBytes: ok.totalBytes + 1 }))).toMatchObject({ code: "size_mismatch" });
    expect(await refusal(recordings.complete(consultation, { ...ok, sha256: "nothex" }))).toMatchObject({ code: "bad_fingerprint" });
    expect(await refusal(recordings.complete(consultation, { ...ok, partCount: 0 }))).toMatchObject({ code: "bad_part_count" });
    expect(await refusal(recordings.complete(consultation, { ...ok, totalBytes: 0 }))).toMatchObject({ code: "bad_size" });
    // Claiming fewer parts than were sent treats the extra one as left over from an earlier attempt and forgets it (so it must come last here).
    expect(await refusal(recordings.complete(consultation, { ...ok, partCount: 2 }))).toMatchObject({ code: "size_mismatch" });

    const s = setup();
    s.recordings.start(s.consultation, "audio/webm");
    await s.recordings.putPart(s.consultation, 1, audioBytes(1000)); // a short part that is not the last
    await s.recordings.putPart(s.consultation, 2, audioBytes(1000, 2));
    const short = Buffer.concat([audioBytes(1000), audioBytes(1000, 2)]);
    expect(await refusal(s.recordings.complete(s.consultation, { totalBytes: 2000, partCount: 2, durationMs: 5000, sha256: sha256(short) }))).toMatchObject({ code: "bad_part_size" });
  });

  it("refuses a recording that is too short or longer than the limit allows", async () => {
    const bytes = audioBytes(3000);
    const { recordings, consultation, parts } = await upload(bytes);
    const ok = claimed(bytes, parts);
    expect(await refusal(recordings.complete(consultation, { ...ok, durationMs: 400 }))).toMatchObject({ code: "too_short" });
    expect(await refusal(recordings.complete(consultation, { ...ok, durationMs: 61 * 60_000 }))).toMatchObject({ code: "too_long", status: 413 });
    expect(await refusal(recordings.complete(consultation, { ...ok, durationMs: Number.NaN }))).toMatchObject({ code: "too_short" });
    await recordings.complete(consultation, { ...ok, durationMs: 60 * 60_000 }); // exactly at the limit is fine
  });

  it("notices a part that was altered after it arrived, rather than processing damaged audio", async () => {
    const bytes = audioBytes(PART + 500);
    const { recordings, repo, consultation, parts } = await upload(bytes);
    const recording = repo.recordingOf(consultation)!;
    const file = path.join(dir, partKey(recording.storage_key, 2));
    const stored = fs.readFileSync(file);
    stored[stored.length - 1] = stored[stored.length - 1]! ^ 0xff; // one flipped bit in storage
    fs.writeFileSync(file, stored);
    expect(await refusal(recordings.complete(consultation, claimed(bytes, parts)))).toMatchObject({ code: "part_damaged", status: 409 });
    expect(repo.require(consultation).status).toBe("uploading");
  });

  it("notices a part that was swapped for one from another recording", async () => {
    const a = setup("A", "a@a.test");
    const b = setup("B", "b@b.test");
    const bytesA = audioBytes(3000, 1);
    const bytesB = audioBytes(3000, 2);
    for (const [s, bytes] of [[a, bytesA], [b, bytesB]] as const) {
      s.recordings.start(s.consultation, "audio/webm");
      await s.recordings.putPart(s.consultation, 1, bytes);
    }
    // An attacker with access to the files copies B's sealed part over A's.
    const keyA = a.repo.recordingOf(a.consultation)!.storage_key;
    const keyB = b.repo.recordingOf(b.consultation)!.storage_key;
    fs.copyFileSync(path.join(dir, partKey(keyB, 1)), path.join(dir, partKey(keyA, 1)));
    expect(await refusal(a.recordings.complete(a.consultation, claimed(bytesA, [bytesA])))).toMatchObject({ code: "part_damaged" });
  });

  it("returns exactly the recording that was uploaded", async () => {
    const bytes = audioBytes(PART * 2 + 777, 9);
    const { recordings, consultation, parts } = await upload(bytes);
    await recordings.complete(consultation, claimed(bytes, parts));
    const audio = await recordings.readAudio(consultation);
    expect(audio.mimeType).toBe("audio/webm");
    expect(audio.bytes.equals(bytes)).toBe(true);
  });
});

describe("discarding and deleting", () => {
  it("abandoning an unfinished upload deletes its pieces and lets the doctor start again", async () => {
    const { recordings, repo, consultation } = setup();
    recordings.start(consultation, "audio/webm");
    await recordings.putPart(consultation, 1, audioBytes(PART));
    expect(await recordings.discard(consultation)).toBe(true);
    expect(filesUnder(dir)).toEqual([]);
    expect(repo.recordingOf(consultation)).toBeUndefined();
    expect(repo.require(consultation).status).toBe("ready");
    expect(await recordings.discard(consultation)).toBe(false);
    recordings.start(consultation, "audio/webm"); // a fresh start works
  });

  it("deleting a stored recording removes the audio for good but keeps the record that it existed", async () => {
    const bytes = audioBytes(PART + 10);
    const { recordings, repo, consultation } = setup();
    recordings.start(consultation, "audio/webm");
    const parts = partsOf(bytes);
    for (const [i, p] of parts.entries()) await recordings.putPart(consultation, i + 1, p);
    await recordings.complete(consultation, claimed(bytes, parts));
    expect(await recordings.deleteAudio(consultation)).toBe(true);
    expect(filesUnder(dir)).toEqual([]);
    expect(repo.recordingOf(consultation)).toMatchObject({ status: "deleted" });
    expect(repo.parts(repo.recordingOf(consultation)!.id)).toEqual([]);
    expect(await refusal(recordings.readAudio(consultation))).toMatchObject({ code: "no_audio" });
    expect(await recordings.deleteAudio(consultation)).toBe(false); // twice is harmless
  });

  it("deleting the audio while it is still waiting to be processed cancels the work and tells the doctor why nothing will arrive", async () => {
    const bytes = audioBytes(4000);
    const { recordings, repo, consultation } = setup();
    recordings.start(consultation, "audio/webm");
    await recordings.putPart(consultation, 1, bytes);
    await recordings.complete(consultation, claimed(bytes, [bytes]));
    await recordings.deleteAudio(consultation);
    expect(db.prepare("SELECT status FROM consultation_jobs").all()).toEqual([{ status: "cancelled" }]);
    expect(repo.require(consultation)).toMatchObject({ status: "failed", failure_code: "audio_deleted" });
  });

  it("a recording can't be started again after it was stored, even after its audio was deleted", async () => {
    const bytes = audioBytes(4000);
    const { recordings, consultation } = setup();
    recordings.start(consultation, "audio/webm");
    await recordings.putPart(consultation, 1, bytes);
    await recordings.complete(consultation, claimed(bytes, [bytes]));
    expect(() => recordings.start(consultation, "audio/webm")).toThrow(expect.objectContaining({ code: "already_recorded" }));
    await recordings.deleteAudio(consultation);
    expect(() => recordings.start(consultation, "audio/webm")).toThrow(expect.objectContaining({ code: "already_recorded" }));
  });
});

describe("listening: only the parts a request needs are opened", () => {
  class CountingStore extends LocalAudioStore {
    opened: string[] = [];
    override async get(key: string): Promise<Buffer> {
      this.opened.push(key.split("/")[1]!);
      return super.get(key);
    }
  }
  /** A stored three-part recording (2 MiB + 2 MiB + 777 bytes) in a store that notes which parts are opened. */
  async function stored() {
    const counting = new CountingStore(dir);
    const org = seedOrganization(db, "Acme");
    const doctor = seedMember(db, org, "doc@acme.test", "doctor");
    const repo = new ConsultationRepository(db, org, doctor.userId, () => vault);
    const recordings = new RecordingService(repo, counting, () => vault, org, { maxBytes: 20 * 1024 * 1024, maxMinutes: 60 });
    const consultation = repo.create({ patientLabel: "A", languageHint: "auto", consent: { textVersion: CONSENT_VERSION, textSha256: "h", language: "en", givenBy: "patient", method: "verbal" } });
    const bytes = audioBytes(PART * 2 + 777, 4);
    const parts = partsOf(bytes);
    recordings.start(consultation, "audio/webm");
    for (const [i, p] of parts.entries()) await recordings.putPart(consultation, i + 1, p);
    await recordings.complete(consultation, claimed(bytes, parts));
    counting.opened = [];
    return { recordings, repo, consultation, bytes, counting };
  }
  const readAll = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  };

  it("reads a range exactly, including one that crosses the boundary between parts, and opens only the parts it touches", async () => {
    const { recordings, consultation, bytes, counting } = await stored();
    expect((await readAll(await recordings.audioStream(consultation, { start: 100, end: 199 }))).equals(bytes.subarray(100, 200))).toBe(true);
    expect(counting.opened).toEqual(["part-000001"]); // one part, not the whole recording

    counting.opened = [];
    const across = await readAll(await recordings.audioStream(consultation, { start: PART - 50, end: PART + 49 }));
    expect(across.equals(bytes.subarray(PART - 50, PART + 50))).toBe(true);
    expect(counting.opened).toEqual(["part-000001", "part-000002"]);

    counting.opened = [];
    const tail = await readAll(await recordings.audioStream(consultation, { start: bytes.length - 10, end: bytes.length - 1 }));
    expect(tail.equals(bytes.subarray(bytes.length - 10))).toBe(true);
    expect(counting.opened).toEqual(["part-000003"]);
  });

  it("reads the whole recording one part at a time, in order, and it is exactly what was recorded", async () => {
    const { recordings, consultation, bytes, counting } = await stored();
    const stream = await recordings.audioStream(consultation);
    expect(counting.opened).toEqual(["part-000001"]); // only the first is opened before anyone reads
    expect((await readAll(stream)).equals(bytes)).toBe(true);
    expect(counting.opened).toEqual(["part-000001", "part-000002", "part-000003"]);
  });

  it("refuses a range outside the recording, and says which recordings have no audio", async () => {
    const { recordings, consultation, bytes } = await stored();
    for (const bad of [{ start: bytes.length, end: bytes.length + 5 }, { start: 10, end: 5 }, { start: -1, end: 5 }, { start: 1.5, end: 9 }]) {
      expect(await refusal(recordings.audioStream(consultation, bad)), JSON.stringify(bad)).toMatchObject({ status: 416 });
    }
    await recordings.deleteAudio(consultation);
    expect(await refusal(recordings.audioStream(consultation))).toMatchObject({ code: "no_audio" });
    expect(() => recordings.audioMeta(consultation)).toThrow(expect.objectContaining({ code: "no_audio" }));
  });

  it("damaged storage is refused cleanly when it is the first part, and errors the stream (it is never silently cut short) when it is a later one", async () => {
    const { recordings, repo, consultation } = await stored();
    const key = repo.recordingOf(consultation)!.storage_key;
    const damage = (n: number) => {
      const file = path.join(dir, partKey(key, n));
      const sealed = fs.readFileSync(file);
      sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 1;
      fs.writeFileSync(file, sealed);
    };
    damage(3);
    const stream = await recordings.audioStream(consultation); // the first part is fine, so this starts...
    await expect(readAll(stream)).rejects.toMatchObject({ code: "part_damaged" }); // ...and fails loudly at the damaged part
    damage(1);
    expect(await refusal(recordings.audioStream(consultation))).toMatchObject({ code: "part_damaged", status: 409 }); // refused before any byte is sent
  });

  it("knows what a player asked for", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=500-5000", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=9-5", 1000)).toBe("unsatisfiable");
    for (const ignored of [null, "", "bytes=", "bytes=-", "items=0-5", "bytes=0-5,10-15", "garbage"]) expect(parseRange(ignored, 1000)).toBeNull();
  });
});

describe("an abandoned earlier attempt can't get in the way of a new recording", () => {
  it("leftover parts beyond the new recording's length are forgotten (files and records), and the shorter recording completes", async () => {
    const { recordings, repo, consultation } = setup();
    recordings.start(consultation, "audio/webm");
    const long = audioBytes(PART * 4 + 10, 1); // a 5-part attempt that was thrown away in the browser without telling the server
    for (const [i, p] of partsOf(long).entries()) await recordings.putPart(consultation, i + 1, p);
    expect(filesUnder(dir).filter((f) => f.includes("part-"))).toHaveLength(5);

    const short = audioBytes(PART + 300, 2); // the next visit: two parts
    const parts = partsOf(short);
    const { receivedParts } = recordings.start(consultation, "audio/webm"); // resumes the same upload...
    expect(receivedParts).toEqual([1, 2, 3, 4, 5]); // ...which still lists the old parts
    for (const [i, p] of parts.entries()) await recordings.putPart(consultation, i + 1, p); // the browser sends its own two (overwriting 1 and 2)
    const done = await recordings.complete(consultation, claimed(short, parts));
    expect(done.recording.status).toBe("stored");
    expect(filesUnder(dir).filter((f) => f.includes("part-"))).toHaveLength(2); // the three stale parts are gone from storage
    expect(repo.parts(done.recording.id).map((p) => p.part_number)).toEqual([1, 2]);
    expect((await recordings.readAudio(consultation)).bytes.equals(short)).toBe(true);
  });
});

describe("a workspace can't fill the disk every workspace shares", () => {
  const quota = (bytes: number) => ({ maxBytes: 5000, maxMinutes: 60, quotaBytes: bytes });
  const another = (s: ReturnType<typeof setup>) => s.repo.create({ patientLabel: "B", languageHint: "auto", consent: { textVersion: CONSENT_VERSION, textSha256: "h", language: "en", givenBy: "patient", method: "verbal" } });
  async function record(s: ReturnType<typeof setup>, consultation: string, seed: number) {
    const bytes = audioBytes(4000, seed);
    s.recordings.start(consultation, "audio/webm");
    await s.recordings.putPart(consultation, 1, bytes);
    await s.recordings.complete(consultation, claimed(bytes, [bytes]));
  }

  it("refuses a new recording when the workspace would go over its limit, counting what is stored, and allows it again after something is deleted", async () => {
    const s = setup("Acme", "d@acme.test", quota(12_000));
    await record(s, s.consultation, 1); // 4000 stored; a new recording needs room for up to 5000 more
    const second = another(s);
    await record(s, second, 2); // 8000 stored
    const third = another(s);
    expect(await refusal(Promise.resolve().then(() => s.recordings.start(third, "audio/webm")))).toMatchObject({ code: "storage_full", status: 409 });
    expect((await refusal(Promise.resolve().then(() => s.recordings.start(third, "audio/webm"))))!.message).toMatch(/storage is full/);
    await s.recordings.deleteAudio(s.consultation); // frees 4000
    expect(() => s.recordings.start(third, "audio/webm")).not.toThrow();
  });

  it("counts the parts of uploads still in progress, so unfinished uploads can't be used to get round it", async () => {
    const s = setup("Acme", "d@acme.test", quota(8000));
    s.recordings.start(s.consultation, "audio/webm");
    await s.recordings.putPart(s.consultation, 1, audioBytes(4000));
    const other = another(s);
    expect(() => s.recordings.start(other, "audio/webm")).toThrow(expect.objectContaining({ code: "storage_full" })); // 4000 held + room for 5000 more > 8000
  });

  it("a part that would push the workspace over its limit is refused, even if every upload was allowed to start when there was room", async () => {
    // Two uploads each start while the workspace is empty (each needs room for up to 2 parts); then the first fills most of the space.
    const limits = { maxBytes: PART * 2, maxMinutes: 60, quotaBytes: PART * 3 + 100 };
    const s = setup("Tight", "t@tight.test", limits);
    const other = another(s);
    s.recordings.start(s.consultation, "audio/webm");
    s.recordings.start(other, "audio/webm");
    await s.recordings.putPart(s.consultation, 1, audioBytes(PART, 1));
    await s.recordings.putPart(s.consultation, 2, audioBytes(PART, 2)); // the workspace now holds 2 parts of audio
    await s.recordings.putPart(other, 1, audioBytes(PART, 3)); // 3 parts: exactly within the limit
    expect(await refusal(s.recordings.putPart(other, 2, audioBytes(PART, 4)))).toMatchObject({ code: "storage_full", status: 409 });
    await s.recordings.putPart(other, 1, audioBytes(PART, 5)); // sending a part again replaces it, it does not add to it
  });

  it("is per workspace: another customer's recordings don't count against this one", async () => {
    const big = setup("Big", "d@big.test", quota(1_000_000));
    await record(big, big.consultation, 1);
    const small = setup("Small", "d@small.test", quota(6000));
    expect(() => small.recordings.start(small.consultation, "audio/webm")).not.toThrow();
  });
});

describe("nobody else's consultation can be reached", () => {
  it("another doctor in the same workspace, and a doctor in another workspace, get 'not found' for every step", async () => {
    const mine = setup("Acme", "me@acme.test");
    const bytes = audioBytes(4000);
    mine.recordings.start(mine.consultation, "audio/webm");
    await mine.recordings.putPart(mine.consultation, 1, bytes);

    const colleagueDoctor = seedMember(db, mine.org, "colleague@acme.test", "doctor");
    const colleagueRepo = new ConsultationRepository(db, mine.org, colleagueDoctor.userId, () => vault);
    const colleague = new RecordingService(colleagueRepo, store, () => vault, mine.org, { maxBytes: 1e8, maxMinutes: 60 });
    const stranger = setup("Beta", "stranger@beta.test");

    for (const [who, service] of [["colleague", colleague], ["stranger", stranger.recordings]] as const) {
      const attempts: [string, () => Promise<unknown> | unknown][] = [
        ["start", () => service.start(mine.consultation, "audio/webm")],
        ["putPart", () => service.putPart(mine.consultation, 2, audioBytes(100))],
        ["complete", () => service.complete(mine.consultation, claimed(bytes, [bytes]))],
        ["discard", () => service.discard(mine.consultation)],
        ["deleteAudio", () => service.deleteAudio(mine.consultation)],
        ["readAudio", () => service.readAudio(mine.consultation)],
      ];
      for (const [name, run] of attempts) expect(await refusal(Promise.resolve().then(run)), `${who}.${name}`).toMatchObject({ status: 404, code: "not_found" });
    }
    // ...and nothing of mine was touched.
    expect(mine.repo.parts(mine.repo.recordingOf(mine.consultation)!.id)).toHaveLength(1);
    expect(mine.repo.require(mine.consultation).status).toBe("uploading");
  });
});
