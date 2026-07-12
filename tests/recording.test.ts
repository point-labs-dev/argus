import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { ArgusRecordingDelegate, buildRecordingFfmpegArgs, buildRecordingOptions } from "../src/recording.js";
import { readFragmentedMp4 } from "../src/mp4.js";

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
    expect(joined).toContain("scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1");
    expect(joined).toContain("-b:v 2000k");
    expect(joined).toContain("-ar 32000"); // samplerate 3 = KHZ_32
    expect(joined).toContain("expr:gte(t,n_forced*4)"); // 4000ms fragment -> 4s keyframes
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

describe("ArgusRecordingDelegate stderr budget", () => {
  // Minimal fMP4 box stream so the session yields one packet and finishes.
  const box = (type: string, payload: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length, 0);
    header.write(type, 4, "ascii");
    return Buffer.concat([header, payload]);
  };

  function fakeFfmpeg(stderrLines: string[]) {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: (signal?: string) => void;
    };
    child.stdout = Readable.from([
      box("ftyp", Buffer.from("isom")),
      box("moov", Buffer.from("moov")),
      box("moof", Buffer.from("m1")),
      box("mdat", Buffer.from("d1")),
    ]);
    child.stderr = Readable.from(stderrLines.map((l) => `${l}\n`));
    child.kill = () => child.emit("exit", null, "SIGKILL");
    return child;
  }

  it("bounds a decode-error burst to the budget plus start/exit/summary lines", async () => {
    const lines: string[] = [];
    const burst = Array.from({ length: 500 }, (_, i) => `[hevc @ 0x1] Could not find ref with POC ${i}`);
    const delegate = new ArgusRecordingDelegate("Backyard Left", "rtsp://127.0.0.1:8554/backyard-left", {
      spawnFn: (() => fakeFfmpeg(burst)) as never,
      logFn: (line) => lines.push(line),
    });
    delegate.updateRecordingConfiguration({
      prebufferLength: 4000,
      eventTriggerTypes: [1],
      mediaContainerConfiguration: { type: 0, fragmentLength: 4000 },
      videoCodec: { type: 0, parameters: { profile: 2, level: 2, bitRate: 2000, iFrameInterval: 4000 }, resolution: [1280, 720, 30] },
      audioCodec: { type: 0, bitrate: 64, samplerate: 3, audioChannels: 1 },
    } as never);

    const packets = [];
    for await (const packet of delegate.handleRecordingStreamRequest(1)) packets.push(packet);
    // Let the kill->exit handler run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(packets.length).toBeGreaterThan(0);
    const stderrLines = lines.filter((l) => l.includes("hksv-ffmpeg: "));
    expect(stderrLines).toHaveLength(20); // HKSV_STDERR_MAX_LINES
    expect(lines.some((l) => l.includes("HKSV recording start 1280x720x30"))).toBe(true);
    const exitLine = lines.find((l) => l.includes("hksv-ffmpeg exited"));
    expect(exitLine).toContain("suppressed 480 stderr lines");
    // Every forwarded line carries the camera prefix (no raw continuation lines).
    for (const line of stderrLines) expect(line).toContain("[argus Backyard Left]");
  });

  it("verbose forwards the full stderr stream and the arg dump", async () => {
    const lines: string[] = [];
    const delegate = new ArgusRecordingDelegate("Garage Door", "rtsp://127.0.0.1:8554/garage-door", {
      verbose: true,
      spawnFn: (() => fakeFfmpeg(Array.from({ length: 60 }, (_, i) => `err ${i}`))) as never,
      logFn: (line) => lines.push(line),
    });
    delegate.updateRecordingConfiguration(recordingConfig());

    for await (const packet of delegate.handleRecordingStreamRequest(2)) void packet;
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines.filter((l) => l.includes("hksv-ffmpeg: "))).toHaveLength(60);
    expect(lines.some((l) => l.includes("-> ffmpeg"))).toBe(true);
    expect(lines.find((l) => l.includes("hksv-ffmpeg exited"))).not.toContain("suppressed");
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
