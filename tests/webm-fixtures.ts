// Builders for WebM recordings like the one a browser's MediaRecorder writes live (no Duration, no Cues, Segment and Clusters without a size),
// used by the tests of src/lib/webm.ts and of the recorder. The header is the real one; the audio after it is made up.

/** The first 146 bytes of a recording made by Chromium's real MediaRecorder: EBML header, Segment (size unknown), Info (no Duration), Tracks. */
export const REAL_HEADER = Uint8Array.from(
  Buffer.from(
    "1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878104428581021853806701ffffffffffffff1549a966992ad7b1830f42404d80864368726f6d655741864368726f6d651654ae6bbfaebdd7810173c587568b15d8daa8a98381028686415f4f50555363a2934f707573486561640101000080bb0000000000e18db584473b80009f810162648120",
    "hex",
  ),
);

export const join = (...parts: ArrayLike<number>[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
export const size = (n: number) => (n < 127 ? [0x80 | n] : [0x40 | (n >> 8), n & 0xff]);
export const element = (id: number[], payload: ArrayLike<number>) => join(id, size(payload.length), payload);
/** The shortest big-endian bytes of a whole number. */
export const uint = (n: number): number[] => (n > 0xff ? [...uint(Math.floor(n / 256)), n % 256] : [n]);
export const filler = (n: number, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

/** A SimpleBlock for track 1, `rel` ticks after the start of its cluster. */
export const block = (rel: number, bytes = 120) => element([0xa3], join([0x81, (rel >> 8) & 0xff, rel & 0xff, 0x80], filler(bytes, rel)));
/** A cluster written live: its size is unknown. */
export const cluster = (timecode: number, rels: number[]) => join([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], element([0xe7], uint(timecode)), ...rels.map((r) => block(r)));

/** A live WebM like the browser's: the real header, then clusters one second apart that end at `lastCluster` + `lastRels`. */
export function recording(clusters: [number, number[]][] = [[0, [0, 20, 40]], [1000, [0, 20, 40]], [2000, [0, 20, 40]]], type = "audio/webm") {
  return new Blob([REAL_HEADER, ...clusters.map(([t, rels]) => cluster(t, rels))], { type });
}
export const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
