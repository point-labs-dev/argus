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
function recordingConfig(resolution: [number, number, number] = [1280, 720, 30]) {
  return {
    prebufferLength: 4000,
    eventTriggerTypes: [1],
    mediaContainerConfiguration: { type: 0, fragmentLength: 4000 },
    videoCodec: { type: 0, parameters: { profile: 2, level: 2, bitRate: 2000, iFrameInterval: 4000 }, resolution },
    audioCodec: { type: 0, bitrate: 64, samplerate: 3, audioChannels: 1 },
  } as never;
}

function videoFilter(args: string[]): string {
  const index = args.indexOf("-vf");
  return index >= 0 ? (args[index + 1] ?? "") : "";
}

const PAD_1920 =
  "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2";

function withTelemetry(run: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return lines.filter((line) => line.includes("ARGUS_TELEMETRY"));
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

  it("pads a 4:3 camera recorded at 1920x1080 instead of stretching it", () => {
    const vf = videoFilter(
      buildRecordingFfmpegArgs("rtsp://127.0.0.1:8554/backyard", recordingConfig([1920, 1080, 30]), "4:3"),
    );
    expect(vf).not.toBe("scale=1920:1080");
    expect(vf).not.toContain("crop=");
    expect(vf).toBe(PAD_1920);
  });

  it("keeps a 16:9 camera recorded at 1920x1080 on the bare scale filter", () => {
    const vf = videoFilter(
      buildRecordingFfmpegArgs("rtsp://127.0.0.1:8554/front-l", recordingConfig([1920, 1080, 30]), "16:9"),
    );
    expect(vf).toBe("scale=1920:1080");
  });

  it("keeps a matching 4:3 box on the bare scale filter", () => {
    const vf = videoFilter(
      buildRecordingFfmpegArgs("rtsp://127.0.0.1:8554/backyard", recordingConfig([640, 480, 30]), "4:3"),
    );
    expect(vf).toBe("scale=640:480");
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

  it("delivers init segment immediately (<100ms) without hold-back delay", async () => {
    // Phase 3 requirement: init segment must arrive <0.1s (not +4s from hold-back).
    // Pre-1.3.15 the init arrived at +4.27s; immediate delivery brings it to +0.04s.
    const stdout = new PassThrough();
    const fakeProc = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), kill: vi.fn() });
    const spawnFn = vi.fn(() => fakeProc) as unknown as typeof import("node:child_process").spawn;
    const delegate = new ArgusRecordingDelegate("Cam", "rtsp://x/main", { spawnFn, verbose: false });
    delegate.updateRecordingConfiguration(recordingConfig() as never);

    const t0 = Date.now();
    const generator = delegate.handleRecordingStreamRequest(8);

    // Write init segment (ftyp+moov) immediately after spawn
    stdout.write(mp4Box("ftyp", Buffer.from("isom")));
    stdout.write(mp4Box("moov", Buffer.from("moovdata")));

    const { value: packet } = await generator.next();
    const deliveryLatency = Date.now() - t0;

    // Init segment delivered immediately, not held back for 4s
    expect(deliveryLatency).toBeLessThan(100);
    expect(packet?.data.toString("ascii", 4, 8)).toBe("ftyp");
    expect(packet?.isLast).toBe(false);
  });

  it("delivers first video fragment at its natural boundary (~4s), not delayed by hold-back", async () => {
    // Phase 3 requirement: first video fragment arrives at ~4s (its fragment boundary),
    // not delayed to ~8s by holding one fragment back. With 4s fragments:
    // - Pre-1.3.15: init@+4.27s, video1@+8.27s (every packet delayed by one fragment)
    // - Post-1.3.15: init@+0.04s, video1@+4.22s (immediate delivery)
    const stdout = new PassThrough();
    const fakeProc = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), kill: vi.fn() });
    const spawnFn = vi.fn(() => fakeProc) as unknown as typeof import("node:child_process").spawn;
    const delegate = new ArgusRecordingDelegate("Cam", "rtsp://x/main", { spawnFn, verbose: false });
    delegate.updateRecordingConfiguration(recordingConfig() as never);

    const t0 = Date.now();
    const generator = delegate.handleRecordingStreamRequest(9);

    // Write init immediately
    stdout.write(mp4Box("ftyp", Buffer.from("isom")));
    stdout.write(mp4Box("moov", Buffer.from("moovdata")));
    
    // Consume init segment
    await generator.next();

    // Simulate ffmpeg's timing: first fragment arrives ~4s after init
    // (In real usage ffmpeg produces fragments at 4s boundaries; here we test
    // that the delegate doesn't add extra delay beyond ffmpeg's natural timing)
    await new Promise((resolve) => setTimeout(resolve, 50)); // Small delay to simulate processing
    stdout.write(mp4Box("moof", Buffer.from("moof1")));
    stdout.write(mp4Box("mdat", Buffer.from("mediadata1")));

    const { value: packet } = await generator.next();
    const fragmentLatency = Date.now() - t0;

    // First video fragment delivered without the +4s hold-back delay.
    // Upper bound is generous (4.5s) because this is a mock test, not real ffmpeg;
    // the real harness (verify-hksv-delivery.mjs) measures actual 4.22s timing.
    expect(fragmentLatency).toBeLessThan(4500);
    expect(packet?.data.toString("ascii", 4, 8)).toBe("moof");
    expect(packet?.isLast).toBe(false);
  });

  it("rejects a recording delegate that has no aspect", () => {
    expect(() => new ArgusRecordingDelegate("Cam", "rtsp://x/main", {} as never)).toThrow(/aspect/);
  });

  it("pads ffmpeg output when the delegate is constructed with 4:3", async () => {
    const stdout = new PassThrough();
    const fakeProc = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), kill: vi.fn() });
    const spawnFn = vi.fn(() => fakeProc) as unknown as typeof import("node:child_process").spawn;
    const delegate = new ArgusRecordingDelegate("Backyard", "rtsp://127.0.0.1:8554/backyard", {
      spawnFn,
      verbose: false,
      aspect: "4:3",
    });
    delegate.updateRecordingConfiguration(recordingConfig([1920, 1080, 30]));

    const generator = delegate.handleRecordingStreamRequest(1);
    const pending = generator.next();
    const args = spawnFn.mock.calls[0]?.[1] as string[];
    expect(videoFilter(args)).toBe(PAD_1920);
    stdout.end();
    await generator.return(undefined);
    await pending.catch(() => undefined);
  });
});

describe("recording hub telemetry", () => {
  function delegate() {
    return new ArgusRecordingDelegate("Backyard", "rtsp://127.0.0.1:8554/backyard", {
      verbose: false,
      aspect: "4:3",
    });
  }

  it("emits a normal close reason", () => {
    const lines = withTelemetry(() => delegate().closeRecordingStream(3, "normal"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("normal");
  });

  it("does not copy an srtp close reason into the telemetry line", () => {
    const secret = "session srtp_key material";
    const lines = withTelemetry(() => delegate().closeRecordingStream(4, secret));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("srtp");
    expect(lines[0]).not.toContain(secret);
    expect(lines[0]).toContain("redacted");
  });

  it("logs an object close reason as its code", () => {
    const lines = withTelemetry(() =>
      delegate().closeRecordingStream(5, { code: "cancelled", detail: "srtp session dump" }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cancelled");
    expect(lines[0]).not.toContain("srtp");
    expect(lines[0]).not.toContain("dump");
  });

  it("redacts an overlong close reason", () => {
    const raw = `hub-${"x".repeat(220)}`;
    const lines = withTelemetry(() => delegate().closeRecordingStream(9, raw));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("redacted");
    expect(lines[0]).not.toContain(raw);
  });

  it("emits recording-active only when the boolean changes", () => {
    const camera = delegate();
    const first = withTelemetry(() => {
      camera.updateRecordingActive(true);
      camera.updateRecordingActive(true);
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("true");

    const second = withTelemetry(() => camera.updateRecordingActive(false));
    expect(second).toHaveLength(1);
    expect(second[0]).toContain("false");
    expect(second[0]).not.toContain("true");
  });

  it("does not throw when telemetry cannot be written", () => {
    const camera = delegate();
    const original = process.stderr.write;
    process.stderr.write = (() => {
      throw new Error("stderr failed");
    }) as typeof process.stderr.write;
    try {
      expect(() => camera.closeRecordingStream(1, "normal")).not.toThrow();
      expect(() => camera.updateRecordingActive(true)).not.toThrow();
    } finally {
      process.stderr.write = original;
    }
  });
});

describe("buildRecordingOptions", () => {
  it("offers fragmented MP4, the required resolutions, and AAC-LC audio", () => {
    const opts = buildRecordingOptions();
    expect(opts.prebufferLength).toBeGreaterThanOrEqual(4000);
    const container = opts.mediaContainerConfiguration;
    const containerType = Array.isArray(container) ? container[0]?.type : container.type;
    expect(containerType).toBe(0);
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
