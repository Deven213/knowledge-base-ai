// What a browser's MediaRecorder writes, and why a recording needs its length stated before it is kept.
//
// Chrome and Edge write WebM "live": the file is produced while the doctor is still talking, so its header cannot yet say how long it will
// be. The Segment has no size, the Info block has no Duration element, and there is no seek index (Cues). The recording is perfectly good
// audio, but a player that opens it cannot know how long it is. `audio.duration` is Infinity, the timeline has nothing to show, and the
// browser only learns the real length when playback reaches the last part (about eight seconds in, for a ten-second recording), at which
// point the controls suddenly jump to the right state.
//
// The browser recorder knows the length the moment it stops, so this adds the one missing element, a Duration, to the Info block, before the
// recording is checksummed and uploaded. The audio itself (every cluster after the header) is left byte for byte as it was.
//
// This only ever makes a recording more complete. Anything it does not fully understand (a different container, a Segment that already has a
// size, an Info block it cannot read, a file that is not WebM at all) is returned untouched, and the player falls back to the length the
// server stored.

const TAG = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
} as const;

/** The header of a recording is a few hundred bytes; this is far more than it needs. */
const HEAD_BYTES = 64 * 1024;
/** The last cluster of a recording made with a chunk every second or so fits easily in this. */
const TAIL_BYTES = 1024 * 1024;
/** One Opus packet, the shortest stretch of audio a block can hold. The last block's time plus this is where the audio ends. */
const PACKET_MS = 20;
const DEFAULT_TIMECODE_SCALE = 1_000_000; // nanoseconds per tick: ticks are milliseconds unless the file says otherwise

/** Bytes backed by a real ArrayBuffer (what a Blob accepts), as opposed to one that might be shared memory. */
type Bytes = Uint8Array<ArrayBuffer>;

/** An element's ID: one to four bytes, the number of leading zero bits says how many. The length marker is part of the ID. */
function idAt(b: Bytes, pos: number): { id: number; len: number } | null {
  const first = b[pos];
  if (first === undefined || first === 0) return null;
  const len = Math.clz32(first) - 23;
  if (len > 4 || pos + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[pos + i]!;
  return { id, len };
}

/** An element's size (or a track number): one to eight bytes, the length marker is not part of the value. All ones means "unknown". */
function sizeAt(b: Bytes, pos: number): { value: number; len: number; unknown: boolean } | null {
  const first = b[pos];
  if (first === undefined || first === 0) return null;
  const len = Math.clz32(first) - 23;
  if (len > 8 || pos + len > b.length) return null;
  const marker = 0x80 >> (len - 1);
  let value = first & (marker - 1);
  let allOnes = value === marker - 1;
  for (let i = 1; i < len; i++) {
    const byte = b[pos + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  if (allOnes) return { value: -1, len, unknown: true };
  return Number.isSafeInteger(value) ? { value, len, unknown: false } : null;
}

function encodeSize(value: number): Bytes {
  for (let len = 1; len <= 8; len++) {
    if (value < 2 ** (7 * len) - 1) {
      const out = new Uint8Array(len);
      let v = value;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v % 256;
        v = Math.floor(v / 256);
      }
      out[0] = out[0]! | (0x80 >> (len - 1));
      return out;
    }
  }
  throw new RangeError("size too large");
}

const readUint = (b: Bytes, pos: number, len: number): number => {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[pos + i]!;
  return v;
};

interface InfoLayout {
  /** Where the Info element starts (its ID), and how long its ID and size fields are. */
  start: number;
  idLen: number;
  payloadStart: number;
  payloadEnd: number;
  /** Nanoseconds per tick. */
  scale: number;
  /** The Duration the file already states, in ticks, if any. */
  duration: number | null;
}

/** Finds the Info element of a live-written WebM, or null when the file is not shaped the way this understands. */
function findInfo(head: Bytes): InfoLayout | null {
  const ebml = idAt(head, 0);
  if (!ebml || ebml.id !== TAG.EBML) return null;
  const ebmlSize = sizeAt(head, ebml.len);
  if (!ebmlSize || ebmlSize.unknown) return null;
  let pos = ebml.len + ebmlSize.len + ebmlSize.value;

  const segment = idAt(head, pos);
  if (!segment || segment.id !== TAG.SEGMENT) return null;
  const segmentSize = sizeAt(head, pos + segment.len);
  // A Segment that states its size is not live-written, and rewriting it would mean fixing every offset inside it: leave such files alone.
  if (!segmentSize || !segmentSize.unknown) return null;
  pos += segment.len + segmentSize.len;

  while (pos < head.length) {
    const id = idAt(head, pos);
    if (!id || id.id === TAG.CLUSTER) return null; // the audio starts before any Info was found
    const size = sizeAt(head, pos + id.len);
    if (!size || size.unknown) return null;
    const payloadStart = pos + id.len + size.len;
    const payloadEnd = payloadStart + size.value;
    if (id.id === TAG.INFO) {
      if (payloadEnd > head.length) return null;
      let scale = DEFAULT_TIMECODE_SCALE;
      let duration: number | null = null;
      let q = payloadStart;
      while (q < payloadEnd) {
        const child = idAt(head, q);
        const childSize = child && sizeAt(head, q + child.len);
        if (!child || !childSize || childSize.unknown) return null;
        const at = q + child.len + childSize.len;
        if (at + childSize.value > payloadEnd) return null;
        if (child.id === TAG.TIMECODE_SCALE && childSize.value >= 1 && childSize.value <= 8) scale = readUint(head, at, childSize.value);
        if (child.id === TAG.DURATION && (childSize.value === 4 || childSize.value === 8)) {
          const view = new DataView(head.buffer, head.byteOffset + at, childSize.value);
          duration = childSize.value === 4 ? view.getFloat32(0) : view.getFloat64(0);
        }
        q = at + childSize.value;
      }
      if (scale <= 0) return null;
      return { start: pos, idLen: id.len, payloadStart, payloadEnd, scale, duration };
    }
    pos = payloadEnd;
  }
  return null;
}

/** The length the recording's own header states, in milliseconds, or null when it states none (or is not a WebM this can read). */
export async function readWebmDurationMs(blob: Blob): Promise<number | null> {
  try {
    const info = findInfo(new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer()));
    if (!info || info.duration === null || !Number.isFinite(info.duration)) return null;
    return (info.duration * info.scale) / 1_000_000;
  } catch {
    return null;
  }
}

/**
 * The returned recording states its length. The Duration is added to the Info block and nothing else changes: everything from the end of
 * the Info block onwards is the original bytes. A recording that already states a duration, or that this cannot read with certainty, is
 * returned as it is. The result is checked before it is trusted: if reading it back does not give the duration that was written, the
 * original is returned.
 */
export async function addWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return blob;
  try {
    const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
    const info = findInfo(head);
    if (!info || info.duration !== null) return blob;

    const element = new Uint8Array(11); // Duration: ID (2 bytes), size 8, a 64-bit float in ticks
    element.set([0x44, 0x89, 0x88]);
    new DataView(element.buffer).setFloat64(3, (durationMs * 1_000_000) / info.scale);
    const oldPayload = head.subarray(info.payloadStart, info.payloadEnd);
    const payload = new Uint8Array(oldPayload.length + element.length);
    payload.set(oldPayload);
    payload.set(element, oldPayload.length);

    const rebuilt = new Blob([head.subarray(0, info.start + info.idLen), encodeSize(payload.length), payload, blob.slice(info.payloadEnd)], { type: blob.type });
    const written = await readWebmDurationMs(rebuilt);
    return written !== null && Math.abs(written - durationMs) < 1 ? rebuilt : blob;
  } catch {
    return blob;
  }
}

/** Where the audio really ends: the time of the last block of the last cluster, plus one packet. Null when that cannot be read with confidence. */
export async function measureWebmDurationMs(blob: Blob): Promise<number | null> {
  try {
    const info = findInfo(new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer()));
    if (!info) return null;
    const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - TAIL_BYTES)).arrayBuffer());
    for (let i = tail.length - 12; i >= 0; i--) {
      if (tail[i] !== 0x1f || tail[i + 1] !== 0x43 || tail[i + 2] !== 0xb6 || tail[i + 3] !== 0x75) continue;
      const ticks = lastBlockTicks(tail, i);
      if (ticks !== null) return (ticks * info.scale) / 1_000_000 + PACKET_MS;
    }
    return null;
  } catch {
    return null;
  }
}

/** The time (in ticks) of the last block in the cluster that starts at `at`, or null when this is not a real cluster. */
function lastBlockTicks(b: Bytes, at: number): number | null {
  const size = sizeAt(b, at + 4);
  if (!size) return null;
  let p = at + 4 + size.len;
  if (b[p] !== TAG.TIMECODE) return null; // a cluster always starts with its Timecode
  const tcSize = sizeAt(b, p + 1);
  if (!tcSize || tcSize.unknown || tcSize.value < 1 || tcSize.value > 6) return null;
  const clusterTime = readUint(b, p + 1 + tcSize.len, tcSize.value);
  p += 1 + tcSize.len + tcSize.value;
  const end = size.unknown ? b.length : Math.min(b.length, at + 4 + size.len + size.value);
  let last = clusterTime;
  while (p < end) {
    const id = idAt(b, p);
    const sz = id && sizeAt(b, p + id.len);
    if (!id || !sz || sz.unknown || id.id === TAG.CLUSTER) break;
    const payload = p + id.len + sz.len;
    if (payload + sz.value > end) break; // a block cut off by the end of the buffer: ignore it
    let block: number | null = null;
    if (id.id === TAG.SIMPLE_BLOCK) block = payload;
    else if (id.id === TAG.BLOCK_GROUP) block = findBlock(b, payload, payload + sz.value);
    if (block !== null) {
      const track = sizeAt(b, block);
      if (track && block + track.len + 2 <= end) {
        const rel = (b[block + track.len]! << 8) | b[block + track.len + 1]!;
        last = Math.max(last, clusterTime + (rel >= 0x8000 ? rel - 0x10000 : rel));
      }
    }
    p = payload + sz.value;
  }
  return last;
}

function findBlock(b: Bytes, from: number, to: number): number | null {
  let p = from;
  while (p < to) {
    const id = idAt(b, p);
    const sz = id && sizeAt(b, p + id.len);
    if (!id || !sz || sz.unknown) return null;
    if (id.id === TAG.BLOCK) return p + id.len + sz.len;
    p += id.len + sz.len + sz.value;
  }
  return null;
}

/**
 * What to do with a finished recording before it is uploaded. A WebM gets its length written into its header (see the top of this file),
 * using where the audio really ends when that can be read and agrees with the clock, and the recorder's own clock otherwise. Any other
 * format is returned as it is.
 */
export async function finishRecordingBlob(blob: Blob, clockMs: number): Promise<Blob> {
  if (blob.type !== "audio/webm") return blob;
  const measured = await measureWebmDurationMs(blob);
  // The clock can be a little off (it stops when Stop is pressed, the last packet arrives just after), but never wildly: a reading that
  // disagrees a lot is a misreading, and the clock is used instead.
  const agrees = measured !== null && measured > 0 && measured >= clockMs * 0.5 - 2000 && measured <= clockMs * 1.5 + 2000;
  return addWebmDuration(blob, agrees ? measured : clockMs);
}
