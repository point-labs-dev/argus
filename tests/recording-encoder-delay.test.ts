import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { buildRecordingFfmpegArgs } from "../src/recording.js";

/*
Acceptance criteria:

- x264 holds 4 fewer frames before the first recording packet. That is 17
  frames at 6 threads (main: 21) and 26 frames at 15 threads (main: 30). At
  1080p, x264 picks 1.5 threads per core, so a 4-core runner gets 6 and the
  10-core Mac mini M4 gets 15.
- On the synthetic Front L harness (HEVC 4512x2512 at 25 fps, 4 s GOP, through
  go2rtc 1.9.14), the median from recording start to the first fragment drops
  by at least 100 ms against main. Each side runs at least 5 times, the sides
  alternate, and no fragment is invalid.
- Every fragment still starts on an IDR, carries H.264 and AAC, and decodes
  alone. tests/recording-first-fragment.test.ts checks that end to end.
*/

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
  it("holds 17 frames at 6 threads and 26 frames at 15 threads before the first packet", () => {
    expect(framesBeforeFirstPacket(6)).toBe(17);
    expect(framesBeforeFirstPacket(15)).toBe(26);
  }, 30_000);
});
