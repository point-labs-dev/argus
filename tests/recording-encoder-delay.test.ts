import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { buildRecordingFfmpegArgs } from "../src/recording.js";

function recordingConfig() {
  return {
    prebufferLength: 4000,
    eventTriggerTypes: [1],
    mediaContainerConfiguration: { type: 0, fragmentLength: 4000 },
    videoCodec: {
      type: 0,
      parameters: { profile: 2, level: 2, bitRate: 2000, iFrameInterval: 4000 },
      resolution: [1920, 1080, 30],
    },
    audioCodec: { type: 0, bitrate: 64, samplerate: 3, audioChannels: 1 },
  } as never;
}

function framesBeforeFirstPacket(threads: number): number {
  const args = buildRecordingFfmpegArgs("rtsp://x/main", recordingConfig(), "16:9");
  const video = args.slice(args.indexOf("-c:v"), args.indexOf("-c:a"));
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "info", "-debug_ts",
    "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=2",
    ...video,
    "-threads", String(threads),
    "-f", "null", "-",
  ], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stderr.split("\n");
  const firstPacket = lines.findIndex((line) => line.includes("encoder -> type:video"));
  expect(firstPacket).toBeGreaterThan(0);
  return lines.slice(0, firstPacket).filter((line) => line.includes("encoder <- type:video")).length;
}

describe("recording encoder delay", () => {
  it("holds 12 frames before the first packet at 6 threads and at 15 threads", () => {
    expect(framesBeforeFirstPacket(6)).toBe(12);
    expect(framesBeforeFirstPacket(15)).toBe(12);
  }, 30_000);
});
