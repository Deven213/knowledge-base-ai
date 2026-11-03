import "server-only";
import { createHash } from "node:crypto";
import { AUDIO_MIME_TYPES, UPLOAD_PART_BYTES } from "@/lib/consultations";
import type { Vault } from "../security/vault";
import { sealContext } from "./aad";
import { newStorageKey, partKey, type AudioStore } from "./audio-store";
import { ConsultationError } from "./errors";
import type { ConsultationRepository, RecordingRow } from "./repository";

// Receiving a recording. The browser sends it in parts of UPLOAD_PART_BYTES to our own authenticated API (no signed URL, no
// third-party origin, nothing public); each part is checked, sealed and stored, and the recording only counts once every part
// is present and the whole-file fingerprint matches what the browser computed. Every step is safe to repeat: a part sent twice
// is stored once, a completion sent twice is accepted once, and an interrupted upload resumes from the parts already received.

export interface RecordingLimits {
  maxBytes: number;
  maxMinutes: number;
  /** The most audio one workspace may hold, so a single tenant can't fill the disk every tenant shares. Omitted = unlimited (tests). */
  quotaBytes?: number;
}

const sha256Hex = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** What the bytes actually are, from their first bytes (the declared type is only a claim). */
export function sniffAudio(head: Buffer): (typeof AUDIO_MIME_TYPES)[number] | null {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "audio/webm"; // EBML (WebM / Matroska)
  if (head.length >= 4 && head.subarray(0, 4).toString("latin1") === "OggS") return "audio/ogg";
  if (head.length >= 12 && head.subarray(4, 8).toString("latin1") === "ftyp") return "audio/mp4";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WAVE") return "audio/wav";
  if (head.length >= 3 && head.subarray(0, 3).toString("latin1") === "ID3") return "audio/mpeg";
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  return null;
}

/** The declared type reduced to one of the allowed ones, or null (parameters such as ;codecs=opus are dropped). */
export function normalizeAudioMime(type: string): (typeof AUDIO_MIME_TYPES)[number] | null {
  const base = type.split(";")[0]!.trim().toLowerCase();
  const aliases: Record<string, (typeof AUDIO_MIME_TYPES)[number]> = { "video/webm": "audio/webm", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/mp3": "audio/mpeg" };
  const mapped = aliases[base] ?? base;
  return (AUDIO_MIME_TYPES as readonly string[]).includes(mapped) ? (mapped as (typeof AUDIO_MIME_TYPES)[number]) : null;
}

/**
 * The byte range a player asked for (`bytes=a-b`, `bytes=a-`, `bytes=-n`), as start and end positions, `"unsatisfiable"` when it lies outside the
 * recording, or null when there is no (single) range to honour: the whole recording is then sent.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const n = Number(m[2]);
    return n === 0 ? "unsatisfiable" : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start >= size || start > end ? "unsatisfiable" : { start, end };
}

export class RecordingService {
  constructor(
    private readonly repo: ConsultationRepository,
    private readonly store: AudioStore,
    private readonly vault: () => Vault,
    private readonly orgId: string,
    private readonly limits: RecordingLimits,
  ) {}

  private get maxParts(): number {
    return Math.ceil(this.limits.maxBytes / UPLOAD_PART_BYTES);
  }

  /** Opens an upload (or returns the one in progress, so an interrupted upload resumes). */
  start(consultationId: string, declaredType: string): { recording: RecordingRow; receivedParts: number[] } {
    const consultation = this.repo.require(consultationId);
    if (!this.repo.hasConsent(consultationId)) throw new ConsultationError(409, "consent_required", "Patient consent has not been recorded for this consultation.");
    const mimeType = normalizeAudioMime(declaredType);
    if (!mimeType) throw new ConsultationError(400, "unsupported_audio", "This browser's recording format isn't supported. Try a current version of Chrome, Edge, Firefox or Safari.");
    const existing = this.repo.recording(consultationId);
    if (existing) {
      if (existing.status !== "uploading") throw new ConsultationError(409, "already_recorded", "This consultation already has a recording. Start a new consultation to record again.");
      return { recording: existing, receivedParts: this.repo.parts(existing.id).map((p) => p.part_number) };
    }
    if (consultation.status !== "ready") throw new ConsultationError(409, "not_ready", "This consultation can't be recorded in its current state.");
    this.requireRoomFor(this.limits.maxBytes, 0);
    const recording = this.repo.startRecording(consultationId, { mimeType, partSize: UPLOAD_PART_BYTES, storageKey: newStorageKey() });
    return { recording, receivedParts: [] };
  }

  /** Refuses when this workspace would hold more audio than its limit. `replacing` is what the new bytes take the place of (a part sent again). */
  private requireRoomFor(adding: number, replacing: number): void {
    const quota = this.limits.quotaBytes;
    if (quota === undefined) return;
    if (this.repo.storedAudioBytes() - replacing + adding > quota) {
      throw new ConsultationError(409, "storage_full", "This workspace's recording storage is full. Delete recordings that are no longer needed, or ask your administrator to raise the limit.");
    }
  }

  private uploading(consultationId: string): RecordingRow {
    this.repo.require(consultationId);
    const recording = this.repo.recording(consultationId);
    if (!recording || recording.status !== "uploading") throw new ConsultationError(409, "not_uploading", "There is no upload in progress for this consultation.");
    return recording;
  }

  /** Stores one part. Sending the same part again is harmless. */
  async putPart(consultationId: string, number: number, bytes: Buffer): Promise<{ received: number }> {
    const recording = this.uploading(consultationId);
    if (!Number.isInteger(number) || number < 1 || number > this.maxParts) throw new ConsultationError(400, "bad_part", "That part number is not valid.");
    if (bytes.length === 0) throw new ConsultationError(400, "empty_part", "That part is empty.");
    if (bytes.length > recording.part_size) throw new ConsultationError(413, "part_too_large", "That part is larger than allowed.");
    if (number === 1) this.checkLooksLike(recording, bytes);
    const existing = this.repo.parts(recording.id);
    const others = existing.filter((p) => p.part_number !== number).reduce((sum, p) => sum + p.size_bytes, 0);
    this.requireRoomFor(bytes.length, existing.find((p) => p.part_number === number)?.size_bytes ?? 0);
    if (others + bytes.length > this.limits.maxBytes) throw new ConsultationError(413, "recording_too_large", "This recording is larger than the limit. Please keep consultations shorter.");

    const sealed = this.vault().seal(bytes, sealContext.audio(this.orgId, recording.storage_key, number));
    await this.store.put(partKey(recording.storage_key, number), sealed);
    this.repo.savePart(recording.id, { part_number: number, size_bytes: bytes.length, sha256: sha256Hex(bytes) });
    return { received: number };
  }

  /** Checks the upload is whole and unaltered, then keeps it and queues the processing. Safe to repeat. */
  async complete(consultationId: string, claimed: { totalBytes: number; partCount: number; durationMs: number; sha256: string }): Promise<{ recording: RecordingRow; alreadyStored: boolean }> {
    this.repo.require(consultationId);
    const current = this.repo.recording(consultationId);
    if (current?.status === "stored" && current.sha256 === claimed.sha256.toLowerCase() && current.size_bytes === claimed.totalBytes) return { recording: current, alreadyStored: true };
    const recording = this.uploading(consultationId);

    const { totalBytes, partCount, durationMs } = claimed;
    const fingerprint = claimed.sha256.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new ConsultationError(400, "bad_fingerprint", "The recording's checksum is not valid.");
    if (!Number.isInteger(partCount) || partCount < 1 || partCount > this.maxParts) throw new ConsultationError(400, "bad_part_count", "The number of parts is not valid.");
    if (!Number.isInteger(totalBytes) || totalBytes < 1) throw new ConsultationError(400, "bad_size", "The recording's size is not valid.");
    if (totalBytes > this.limits.maxBytes) throw new ConsultationError(413, "recording_too_large", "This recording is larger than the limit. Please keep consultations shorter.");
    if (!Number.isFinite(durationMs) || durationMs < 1000) throw new ConsultationError(400, "too_short", "The recording is too short to be a consultation.");
    if (durationMs > this.limits.maxMinutes * 60_000 + 5_000) throw new ConsultationError(413, "too_long", `Recordings can be at most ${this.limits.maxMinutes} minutes long.`);

    // Parts left over from an abandoned earlier attempt (a longer recording that was thrown away) are not part of this one: forget them, rather than
    // refusing every completion for ever.
    const stale = this.repo.parts(recording.id).filter((p) => p.part_number > partCount);
    if (stale.length > 0) {
      for (const p of stale) await this.store.delete(partKey(recording.storage_key, p.part_number));
      this.repo.removeParts(recording.id, stale.map((p) => p.part_number));
    }
    const parts = this.repo.parts(recording.id);
    const missing = Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !parts.some((p) => p.part_number === n));
    if (missing.length > 0 || parts.length !== partCount) throw new ConsultationError(409, "incomplete_upload", "Some parts of the recording have not arrived yet.");
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      if (last ? p.size_bytes > recording.part_size : p.size_bytes !== recording.part_size) throw new ConsultationError(409, "bad_part_size", "The recording's parts don't add up. Please upload it again.");
    });
    if (parts.reduce((sum, p) => sum + p.size_bytes, 0) !== totalBytes) throw new ConsultationError(409, "size_mismatch", "The recording's size doesn't match what was received. Please upload it again.");

    // Read every part back (opening it also proves it wasn't altered in storage) and fingerprint the whole recording.
    const hash = createHash("sha256");
    for (const part of parts) {
      const plain = await this.openPart(recording, part.part_number);
      if (part.part_number === 1) this.checkLooksLike(recording, plain);
      if (sha256Hex(plain) !== part.sha256) throw new ConsultationError(409, "part_changed", "A part of the recording changed in storage. Please upload it again.");
      hash.update(plain);
    }
    if (hash.digest("hex") !== fingerprint) throw new ConsultationError(409, "checksum_mismatch", "The recording arrived damaged. Please upload it again.");

    this.repo.finishRecording(consultationId, recording.id, { sizeBytes: totalBytes, partCount, durationMs: Math.round(durationMs), sha256: fingerprint });
    return { recording: this.repo.recording(consultationId)!, alreadyStored: false };
  }

  /** Throws away an unfinished upload so the doctor can start again. Returns whether there was one. */
  async discard(consultationId: string): Promise<boolean> {
    const storageKey = this.repo.discardUnfinishedRecording(consultationId);
    if (!storageKey) return false;
    await this.store.deletePrefix(storageKey);
    return true;
  }

  /** Deletes a stored recording's audio for good (the transcript and note, if any, are kept). Safe to repeat. */
  async deleteAudio(consultationId: string): Promise<boolean> {
    const recording = this.repo.recordingOf(consultationId);
    if (!recording || recording.status === "deleted") return false;
    if (recording.status === "uploading") return this.discard(consultationId);
    await this.store.deletePrefix(recording.storage_key);
    this.repo.markAudioDeleted(consultationId);
    return true;
  }

  /** What the player needs to know before it asks for bytes. */
  audioMeta(consultationId: string): { size: number; mimeType: string } {
    const recording = this.repo.recordingOf(consultationId);
    if (!recording || recording.status !== "stored" || recording.size_bytes === null) throw new ConsultationError(404, "no_audio", "This consultation has no stored recording.");
    return { size: recording.size_bytes, mimeType: recording.mime_type };
  }

  /**
   * A byte range of the recording (all of it by default) as a stream. Only the sealed parts the range touches are opened, one at a time, so memory
   * stays at about one part however long the recording is and however often the player seeks. The first part is opened before this returns: damaged
   * storage is a clean refusal, not a response that fails half way.
   */
  async audioStream(consultationId: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>> {
    const recording = this.repo.recordingOf(consultationId);
    if (!recording || recording.status !== "stored" || recording.size_bytes === null) throw new ConsultationError(404, "no_audio", "This consultation has no stored recording.");
    const size = recording.size_bytes;
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? size - 1, size - 1);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end) throw new ConsultationError(416, "bad_range", "That part of the recording does not exist.");
    const partSize = recording.part_size;
    const first = Math.floor(start / partSize) + 1;
    const last = Math.floor(end / partSize) + 1;
    const piece = (plain: Buffer, n: number) => plain.subarray(n === first ? start - (n - 1) * partSize : 0, n === last ? end - (n - 1) * partSize + 1 : plain.length);
    const open = (n: number) => this.openPart(recording, n);
    const head = piece(await open(first), first);
    let next = first;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const buffer = next === first ? head : piece(await open(next), next);
          controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length));
          next += 1;
          if (next > last) controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });
  }

  /** The whole recording, opened in memory. For the background worker, which has to send it to the speech service in one piece. */
  async readAudio(consultationId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const recording = this.repo.recordingOf(consultationId);
    if (!recording || recording.status !== "stored") throw new ConsultationError(404, "no_audio", "This consultation has no stored recording.");
    const chunks: Buffer[] = [];
    for (const part of this.repo.parts(recording.id)) chunks.push(await this.openPart(recording, part.part_number));
    return { bytes: Buffer.concat(chunks), mimeType: recording.mime_type };
  }

  /** Opens one stored part. A part that is missing or fails its integrity check (altered, or sealed for another place) is a clear refusal, never a raw crypto error. */
  private async openPart(recording: RecordingRow, number: number): Promise<Buffer> {
    try {
      const sealed = await this.store.get(partKey(recording.storage_key, number));
      return this.vault().open(sealed, sealContext.audio(this.orgId, recording.storage_key, number));
    } catch (err) {
      if (err instanceof ConsultationError) throw err;
      throw new ConsultationError(409, "part_damaged", "A stored part of the recording is missing or damaged. Please record again.");
    }
  }

  private checkLooksLike(recording: RecordingRow, firstBytes: Buffer): void {
    const actual = sniffAudio(firstBytes.subarray(0, 16));
    if (actual !== recording.mime_type) throw new ConsultationError(400, "not_audio", "That file doesn't look like an audio recording.");
  }
}
