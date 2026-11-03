import { describe, expect, it } from "vitest";
import { addWebmDuration, finishRecordingBlob, measureWebmDurationMs, readWebmDurationMs } from "@/lib/webm";
import { sniffAudio } from "@/server/consultations/recording";
import { block, bytesOf, cluster, element, filler, join, recording, REAL_HEADER, sameBytes, uint } from "./webm-fixtures";

// A recording made by the browser (MediaRecorder in Chrome/Edge) is a WebM written live: no Duration, no seek index, a Segment without a
// size. A player cannot know how long it is, so the controls show nothing sensible until playback is nearly over (about eight seconds into
// a ten-second recording). src/lib/webm.ts states the length in the header, before the recording is kept, and leaves the audio untouched.


describe("what a browser-recorded WebM is missing", () => {
  it("the fixture really is the browser's header: a Segment without a size, an Info block of 25 bytes, and no duration anywhere", async () => {
    expect(REAL_HEADER.length).toBe(146); // where the first cluster began in the real file
    expect(sniffAudio(Buffer.from(REAL_HEADER.subarray(0, 16)))).toBe("audio/webm");
    expect(await readWebmDurationMs(recording())).toBeNull();
  });
});

describe("adding the recording's length to its header", () => {
  it("states the length, so a player knows it from the first byte", async () => {
    const original = recording();
    const fixed = await addWebmDuration(original, 10_260);
    expect(await readWebmDurationMs(fixed)).toBe(10_260);
    expect(fixed.type).toBe("audio/webm");
  });

  it("changes nothing else: same header up to Info, same Info contents, and every byte of audio after it exactly as recorded", async () => {
    const original = recording([[0, [0, 20, 40]], [1000, [0, 20, 40]], [2000, [0, 20, 40]], [3000, [0, 20]]]);
    const before = await bytesOf(original);
    const after = await bytesOf(await addWebmDuration(original, 3_050));
    const infoAt = before.indexOf(0x15); // Info element: 15 49 A9 66
    expect([...before.subarray(infoAt, infoAt + 4)]).toEqual([0x15, 0x49, 0xa9, 0x66]);
    expect(sameBytes(before.subarray(0, infoAt + 4), after.subarray(0, infoAt + 4))).toBe(true); // EBML header, Segment header, Info ID
    expect(before[infoAt + 4]).toBe(0x80 | 25); // Info was 25 bytes...
    expect(after[infoAt + 4]).toBe(0x80 | 36); // ...and is now 25 + the 11-byte Duration element
    const infoEnd = infoAt + 5 + 25;
    expect(sameBytes(before.subarray(infoAt + 5, infoEnd), after.subarray(infoAt + 5, infoEnd))).toBe(true); // TimecodeScale, MuxingApp, WritingApp untouched
    expect([...after.subarray(infoEnd, infoEnd + 3)]).toEqual([0x44, 0x89, 0x88]); // the new Duration, 8-byte float
    expect(sameBytes(before.subarray(infoEnd), after.subarray(infoEnd + 11))).toBe(true); // Tracks and every cluster: byte for byte
    expect(after.length).toBe(before.length + 11);
  });

  it("is still the same audio file to everything else: the server's own check of the first bytes still says WebM", async () => {
    const fixed = await bytesOf(await addWebmDuration(recording(), 5_000));
    expect(sniffAudio(Buffer.from(fixed.subarray(0, 16)))).toBe("audio/webm");
  });

  it("writes the length in the file's own time unit when the file does not use milliseconds", async () => {
    const info = element([0x15, 0x49, 0xa9, 0x66], join([0x2a, 0xd7, 0xb1, 0x82, 0x03, 0xe8], [0x4d, 0x80, 0x81, 0x43])); // TimecodeScale = 1000 ns: ticks are microseconds
    const header = join(REAL_HEADER.subarray(0, REAL_HEADER.indexOf(0x15)), info);
    const file = new Blob([header, cluster(0, [0, 20])], { type: "audio/webm" });
    const fixed = await addWebmDuration(file, 2_500);
    expect(await readWebmDurationMs(fixed)).toBeCloseTo(2_500, 6);
    const view = new DataView((await bytesOf(fixed)).buffer);
    const at = (await bytesOf(fixed)).indexOf(0x44);
    expect(view.getFloat64(at + 3)).toBeCloseTo(2_500_000, 3); // 2.5 s is 2,500,000 microsecond ticks
  });

  it("works on a recording of a realistic length (a 40 minute visit is some 15 MB) without disturbing a byte of it", async () => {
    const clusters: [number, number[]][] = Array.from({ length: 40 * 60 }, (_, i) => [i * 1000, [0, 20, 40]]);
    const original = recording(clusters);
    const fixed = await addWebmDuration(original, 40 * 60 * 1000 + 60);
    expect(await readWebmDurationMs(fixed)).toBe(40 * 60 * 1000 + 60);
    expect(fixed.size).toBe(original.size + 11);
    const a = await bytesOf(original);
    const b = await bytesOf(fixed);
    expect(sameBytes(a.subarray(a.indexOf(0x16, 40)), b.subarray(b.indexOf(0x16, 40)))).toBe(true); // from Tracks onwards (one comparison, not 150,000)
  });
});

describe("leaving a recording alone when it should not be touched", () => {
  const mustBeUntouched = async (blob: Blob, durationMs = 5_000) => expect(await addWebmDuration(blob, durationMs)).toBe(blob); // the very same Blob

  it("a recording that already states its length", async () => {
    const fixed = await addWebmDuration(recording(), 4_000);
    await mustBeUntouched(fixed, 9_000);
    expect(await readWebmDurationMs(fixed)).toBe(4_000);
  });

  it("anything that is not a WebM this understands: another audio format, empty, text, random bytes", async () => {
    await mustBeUntouched(new Blob([join([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45], filler(500))], { type: "audio/wav" }));
    await mustBeUntouched(new Blob([], { type: "audio/webm" }));
    await mustBeUntouched(new Blob(["this is not audio"], { type: "audio/webm" }));
    await mustBeUntouched(new Blob([filler(5000)], { type: "audio/webm" }));
  });

  it("a Segment that states its own size (rewriting it would mean fixing every offset in the file)", async () => {
    const header = Uint8Array.from(REAL_HEADER);
    const at = header.indexOf(0x18); // Segment: 18 53 80 67, then its size
    header.set([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00], at + 4);
    await mustBeUntouched(new Blob([header, cluster(0, [0])], { type: "audio/webm" }));
  });

  it("a header cut off in the middle of the Info block, and one with no Info before the audio starts", async () => {
    await mustBeUntouched(new Blob([REAL_HEADER.subarray(0, 60)], { type: "audio/webm" })); // Info runs from byte 53 to 78
    const noInfo = join(REAL_HEADER.subarray(0, REAL_HEADER.indexOf(0x15)), cluster(0, [0, 20]));
    await mustBeUntouched(new Blob([noInfo], { type: "audio/webm" }));
  });

  it("a length that makes no sense", async () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) await mustBeUntouched(recording(), bad);
  });
});

describe("reading where the audio really ends", () => {
  it("is the time of the last block plus one packet: a last cluster at 10.2 s with blocks to +40 ms ends at 10.26 s, as in the real recording", async () => {
    const file = recording([[0, [0, 20, 40]], [5000, [0, 20, 40]], [10_200, [0, 20, 40]]]);
    expect(await measureWebmDurationMs(file)).toBe(10_260);
  });

  it("reads the last cluster even when the file has thousands, and uses only the end of the file", async () => {
    const clusters: [number, number[]][] = Array.from({ length: 3000 }, (_, i) => [i * 1000, [0, 20, 40]]);
    expect(await measureWebmDurationMs(recording(clusters))).toBe(2_999_000 + 40 + 20);
  });

  it("understands a block inside a BlockGroup, and a block's time before the cluster's (negative)", async () => {
    const group = element([0xa0], element([0xa1], join([0x81, 0x00, 0x50, 0x00], filler(60)))); // Block at +80 ms
    const live = join([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], element([0xe7], uint(4000)), block(0), group);
    expect(await measureWebmDurationMs(new Blob([REAL_HEADER, live], { type: "audio/webm" }))).toBe(4_000 + 80 + 20);
    const early = join([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], element([0xe7], uint(4000)), element([0xa3], join([0x81, 0xff, 0xf6, 0x80], filler(40)))); // -10 ms
    expect(await measureWebmDurationMs(new Blob([REAL_HEADER, early], { type: "audio/webm" }))).toBe(4_000 + 20); // the cluster's own time is the floor
  });

  it("is not fooled by audio data that happens to contain a cluster's ID, and says nothing when there is no audio or no header", async () => {
    const trap = element([0xa3], join([0x81, 0x00, 0x14, 0x80], [0x1f, 0x43, 0xb6, 0x75, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09], filler(30)));
    const withTrap = join(cluster(0, [0, 20]), join([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], element([0xe7], uint(1000)), block(0), trap));
    expect(await measureWebmDurationMs(new Blob([REAL_HEADER, withTrap], { type: "audio/webm" }))).toBe(1_000 + 20 + 20);
    expect(await measureWebmDurationMs(new Blob([REAL_HEADER], { type: "audio/webm" }))).toBeNull();
    expect(await measureWebmDurationMs(new Blob([filler(3000)], { type: "audio/webm" }))).toBeNull();
    expect(await measureWebmDurationMs(new Blob([], { type: "audio/webm" }))).toBeNull();
  });
});

describe("finishing a recording before it is uploaded", () => {
  it("writes where the audio really ends when that agrees with the clock (the clock stops at Stop; the last packet arrives just after)", async () => {
    const file = recording([[0, [0, 20, 40]], [10_200, [0, 20, 40]]]);
    expect(await readWebmDurationMs(await finishRecordingBlob(file, 10_400))).toBe(10_260);
  });

  it("uses the clock instead when the reading disagrees with it wildly (a misreading must never become the recording's length)", async () => {
    const file = recording([[0, [0, 20, 40]], [2000, [0, 20, 40]]]);
    expect(await readWebmDurationMs(await finishRecordingBlob(file, 60_000))).toBe(60_000);
  });

  it("uses the clock when the end of the audio cannot be read at all", async () => {
    const headerOnly = new Blob([REAL_HEADER], { type: "audio/webm" });
    expect(await readWebmDurationMs(await finishRecordingBlob(headerOnly, 12_000))).toBe(12_000);
  });

  it("leaves every other format exactly as it is", async () => {
    for (const type of ["audio/ogg", "audio/mp4", "audio/wav", "audio/mpeg"]) {
      const file = new Blob([filler(2000)], { type });
      expect(await finishRecordingBlob(file, 5_000)).toBe(file);
    }
  });

  it("goes by what the recorder says the format is: a file declared as another format is left alone even if it looks like a live WebM", async () => {
    for (const type of ["audio/ogg", "audio/mp4", "audio/wav", ""]) {
      const lookalike = recording([[0, [0, 20, 40]], [1000, [0, 20, 40]]], type);
      expect(await finishRecordingBlob(lookalike, 1_060)).toBe(lookalike);
    }
  });

  it("leaves a webm it cannot read exactly as it is", async () => {
    const odd = new Blob([filler(2000)], { type: "audio/webm" });
    expect(await finishRecordingBlob(odd, 5_000)).toBe(odd);
  });
});
