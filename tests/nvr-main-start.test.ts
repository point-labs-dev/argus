import { spawn, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioStreamingCodecType } from "hap-nodejs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildLiveFfmpegArgs, type LiveFfmpegInput } from "../src/homekit.js";
import { accessUnits, sliceAfterFirstVcl, type AnnexBCodec } from "./helpers/annexb.js";

const RATE = 25;
const NVR_GOP_SECONDS = 4;
const FRAME_MS = 1000 / RATE;
/** The join lands one frame after a keyframe, so the next one is a full GOP away. */
const KEYFRAME_AT_MS = (RATE * NVR_GOP_SECONDS - 1) * FRAME_MS;
/** HomeKit's stream-start window (progress/attempt-001.md). iOS gives up near 30s (attempt-007.md). */
const START_WINDOW_MS = 5000;

interface Start {
  firstPacketMs: number;
  /** When serve logs live_session_first_frame. ffmpeg prints progress every 0.5s, so it trails the packet. */
  firstFrameMs: number;
}

function run(args: string[]): void {
  const result = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg exited ${result.status}\n${result.stderr}`);
}

function liveInput(tier: "main" | "sub", port: number, width: number, height: number, kbps: number): LiveFfmpegInput {
  return {
    inputUrl: "pipe:0",
    sourceTier: tier,
    targetAddress: "127.0.0.1",
    videoMode: "transcode",
    aspect: "16:9",
    video: {
      port,
      localRtcpPort: port,
      ssrc: 1,
      payloadType: 99,
      maxBitrateKbps: kbps,
      fps: 30,
      width,
      height,
      mtu: 1378,
      profile: "baseline",
      level: "4.0",
      srtpParams: Buffer.alloc(30, 7).toString("base64"),
    },
    audio: {
      port: 1,
      localRtcpPort: 1,
      ssrc: 2,
      payloadType: 110,
      codec: AudioStreamingCodecType.OPUS,
      sampleRateKhz: 24,
      maxBitrateKbps: 24,
      srtpParams: Buffer.alloc(30, 9).toString("base64"),
    },
  };
}

/**
 * Serve's video args, fed like a live restream: one picture every frame
 * interval from spawn, so ffmpeg cannot read ahead to the next keyframe.
 */
async function measureStart(
  tier: "main" | "sub",
  codec: AnnexBCodec,
  units: Buffer[],
  box: { width: number; height: number; kbps: number },
): Promise<Start> {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
  const port = (socket.address() as { port: number }).port;
  const args = buildLiveFfmpegArgs(liveInput(tier, port, box.width, box.height, box.kbps), false);
  args.splice(args.indexOf("-rtsp_transport"), 2);
  args.splice(args.indexOf("-i"), 0, "-f", codec);

  const started = performance.now();
  const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  child.stdin.on("error", () => {});
  let firstFrameMs = Number.NaN;
  child.stderr.on("data", (chunk: Buffer) => {
    if (Number.isNaN(firstFrameMs) && /^frame=([1-9]\d*)$/m.test(chunk.toString())) {
      firstFrameMs = performance.now() - started;
    }
  });
  const timers = units.map((unit, index) =>
    setTimeout(() => child.stdin.write(unit), Math.max(0, started + index * FRAME_MS - performance.now())),
  );

  try {
    const firstPacketMs = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`no ${tier} packet within 15s`)), 15_000);
      socket.once("message", () => {
        clearTimeout(timeout);
        resolve(performance.now() - started);
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { firstPacketMs, firstFrameMs };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    child.kill("SIGKILL");
    socket.close();
  }
}

describe("Front R main start", () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-nvr-start-"));
  let main: Start;
  let sub: Start;

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeAll(async () => {
    const keyint = String(RATE * NVR_GOP_SECONDS);
    const duration = String(NVR_GOP_SECONDS + 1);
    const mainFile = join(dir, "front-r.hevc");
    const subFile = join(dir, "front-r-sub.h264");
    run([
      "-f", "lavfi", "-i", `testsrc2=size=4512x2512:rate=${RATE}:duration=${duration}`,
      "-vf", "noise=alls=12:allf=t",
      "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-x265-params", `keyint=${keyint}:min-keyint=${keyint}:scenecut=0:bframes=0:open-gop=0:repeat-headers=1:bitrate=8000:vbv-maxrate=8000:vbv-bufsize=16000:log-level=error`,
      "-f", "hevc", mainFile,
    ]);
    run([
      "-f", "lavfi", "-i", `testsrc2=size=896x512:rate=${RATE}:duration=${duration}`,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-b:v", "768k",
      "-g", keyint, "-keyint_min", keyint, "-sc_threshold", "0", "-bf", "0",
      "-f", "h264", subFile,
    ]);
    const mainUnits = accessUnits(sliceAfterFirstVcl(readFileSync(mainFile), "hevc"), "hevc");
    const subUnits = accessUnits(sliceAfterFirstVcl(readFileSync(subFile), "h264"), "h264");
    main = await measureStart("main", "hevc", mainUnits, { width: 1920, height: 1080, kbps: 3000 });
    sub = await measureStart("sub", "h264", subUnits, { width: 854, height: 480, kbps: 600 });
    console.log(
      `front_r_main_first_packet_ms=${Math.round(main.firstPacketMs)} front_r_main_first_frame_ms=${Math.round(main.firstFrameMs)} ` +
        `front_r_sub_first_packet_ms=${Math.round(sub.firstPacketMs)} keyframe_at_ms=${KEYFRAME_AT_MS}`,
    );
  }, 120_000);

  it("delivers the first 1920x1080 MAIN packet within HomeKit's start window on a worst-case 4s GOP join", () => {
    expect(main.firstPacketMs).toBeGreaterThanOrEqual(KEYFRAME_AT_MS - 50);
    expect(main.firstPacketMs).toBeLessThan(START_WINDOW_MS);
  });

  it("costs under half a second more than the NVR sub it replaces on the same join", () => {
    expect(sub.firstPacketMs).toBeGreaterThanOrEqual(KEYFRAME_AT_MS - 50);
    expect(main.firstPacketMs - sub.firstPacketMs).toBeLessThan(500);
  });
});
