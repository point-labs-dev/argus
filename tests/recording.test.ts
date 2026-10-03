import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { ArgusRecordingDelegate, buildRecordingFfmpegArgs, buildRecordingOptions } from "../src/recording.js";
import { readFragmentedMp4 } from "../src/mp4.js";

function mp4Box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

// A CameraRecordingConfiguration as HomeKit would select it (enum values inlined).
function recordingConfig() {
  return {
    prebufferLength: 4000,
    eventTriggerTypes: [1],
    mediaContainerConfiguration: { type: 0, fragmentLength: 4000 },
    videoCodec: { type: 0, parameters: { profile: 2, level: 2, bitRate: 2000, iFrameInterval: 4000 }, resolution: [1280, 720, 30] },
    audioCodec: { type: 0, bitrate: 64, samplerate: 3, audioChannels: 1 },
  } as never;
}

describe("buildRecordingFfmpegArgs", () => {
  it("produces ONE fMP4 output with BOTH video and audio (no -an/-vn)", () => {
    const args = buildRecordingFfmpegArgs("rtsp://127.0.0.1:8554/garage-door", recordingConfig());
    const joined = args.join(" ");

    // The classic bug: -an + -vn on a single output yields an empty mux ("Invalid argument").
    expect(args).not.toContain("-an");
    expect(args).not.toContain("-vn");
    expect(joined).toContain("-c:v libx264");
    expect(joined).toContain("-c:a aac");
    expect(joined).toContain("-f mp4");
    expect(joined).toContain("frag_keyframe+empty_moov+default_base_moof");
    expect(args[args.length - 1]).toBe("pipe:1");
  });

  it("maps the negotiated profile/level/resolution and fragment keyframes", () => {
    const joined = buildRecordingFfmpegArgs("rtsp://x/main", recordingConfig()).join(" ");
    expect(joined).toContain("-profile:v high"); // profile 2
    expect(joined).toContain("-level 4.0"); // level 2
    expect(joined).toContain("scale=1280:720");
    expect(joined).toContain("-b:v 2000k");
    expect(joined).toContain("-ar 32000"); // samplerate 3 = KHZ_32
    expect(joined).toContain("expr:gte(t,n_forced*4)"); // 4000ms fragment -> 4s keyframes
  });

  it("caps input analysis at the measured 200ms floor (recording-start latency)", () => {
    const joined = buildRecordingFfmpegArgs("rtsp://x/main", recordingConfig()).join(" ");
    expect(joined).toContain("-analyzeduration 200000");
    expect(joined).toContain("-probesize 500000");
  });
});

describe("ArgusRecordingDelegate", () => {
  it("delivers each fragment the moment it completes (no one-fragment hold-back)", async () => {
    // Pre-1.3.15 the delegate held one segment back to flag the final one
    // isLast, so with the init segment and fragment 1 available it had yielded
    // only the init — every packet reached the Home Hub one 4s fragment late.
    const stdout = new PassThrough();
    const fakeProc = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), kill: vi.fn() });
    const spawnFn = vi.fn(() => fakeProc) as unknown as typeof import("node:child_process").spawn;
    const delegate = new ArgusRecordingDelegate("Cam", "rtsp://x/main", { spawnFn, verbose: false });
    delegate.updateRecordingConfiguration(recordingConfig() as never);

    stdout.write(mp4Box("ftyp", Buffer.from("isom")));
    stdout.write(mp4Box("moov", Buffer.from("moovdata")));
    stdout.write(mp4Box("moof", Buffer.from("moof1")));
    stdout.write(mp4Box("mdat", Buffer.from("mediadata1")));
    // The stream stays OPEN (a live recording): fragment 2 does not exist yet.

    const received: Array<{ head: string; isLast: boolean | undefined }> = [];
    for await (const packet of delegate.handleRecordingStreamRequest(7)) {
      received.push({ head: packet.data.toString("ascii", 4, 8), isLast: packet.isLast });
      if (received.length === 2) break;
    }

    expect(received).toEqual([
      { head: "ftyp", isLast: false },
      { head: "moof", isLast: false },
    ]);
  });
});

describe("buildRecordingOptions", () => {
  it("offers fragmented MP4, the required resolutions, and AAC-LC audio", () => {
    const opts = buildRecordingOptions();
    expect(opts.prebufferLength).toBeGreaterThanOrEqual(4000);
    expect(opts.mediaContainerConfiguration.type).toBe(0); // FRAGMENTED_MP4
    const resolutions = opts.video.resolutions.map((r) => `${r[0]}x${r[1]}`);
    expect(resolutions).toContain("1920x1080");
    expect(resolutions).toContain("1280x720");
  });
});

describe("readFragmentedMp4 (unit)", () => {
  it("splits a synthetic box stream into one init segment then fragments", async () => {
    const box = (type: string, payload: Buffer): Buffer => {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(8 + payload.length, 0);
      header.write(type, 4, "ascii");
      return Buffer.concat([header, payload]);
    };
    const stream = Readable.from([
      box("ftyp", Buffer.from("isom")),
      box("moov", Buffer.from("moovdata")),
      box("moof", Buffer.from("moof1")),
      box("mdat", Buffer.from("mediadata1")),
      box("moof", Buffer.from("moof2")),
      box("mdat", Buffer.from("mediadata2")),
    ]);

    const segments: Array<{ isInit: boolean; head: string }> = [];
    for await (const seg of readFragmentedMp4(stream)) {
      segments.push({ isInit: seg.isInit, head: seg.data.toString("ascii", 4, 8) });
    }
    expect(segments).toEqual([
      { isInit: true, head: "ftyp" },
      { isInit: false, head: "moof" },
      { isInit: false, head: "moof" },
    ]);
  });
});
