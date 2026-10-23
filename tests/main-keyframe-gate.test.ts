import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioStreamingCodecType } from "hap-nodejs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ARGUS_FIRMWARE_REVISION,
  ArgusStreamingDelegate,
  buildLiveFfmpegArgs,
  type LiveFfmpegInput,
} from "../src/homekit.js";
import { buildAspectScaleFilter, MAIN_KEYFRAME_GATE } from "../src/video-filter.js";

const RATE = 20;
const GOP_SECONDS = 2;
const GOP_FRAMES = RATE * GOP_SECONDS;
const CLEAN_SAT = 80;

function input(options: {
  tier?: "main" | "sub";
  aspect?: "16:9" | "4:3";
  width?: number;
  height?: number;
  videoMode?: "copy" | "transcode";
} = {}): LiveFfmpegInput {
  const aspect = options.aspect ?? "16:9";
  const live: LiveFfmpegInput = {
    inputUrl: "rtsp://127.0.0.1:8554/camera",
    targetAddress: "192.168.1.50",
    videoMode: options.videoMode ?? "transcode",
    aspect,
    video: {
      port: 50000,
      localRtcpPort: 60000,
      ssrc: 1,
      payloadType: 99,
      maxBitrateKbps: 600,
      fps: 30,
      width: options.width ?? 640,
      height: options.height ?? 360,
      mtu: 1378,
      profile: "baseline",
      level: "3.1",
      srtpParams: "VIDEOKEY==",
    },
    audio: {
      port: 50002,
      localRtcpPort: 60002,
      ssrc: 2,
      payloadType: 110,
      codec: AudioStreamingCodecType.OPUS,
      sampleRateKhz: 24,
      maxBitrateKbps: 24,
      srtpParams: "AUDIOKEY==",
    },
  };
  if (options.tier !== undefined) live.sourceTier = options.tier;
  return live;
}

function videoFilter(options: Parameters<typeof input>[0]): string {
  const args = buildLiveFfmpegArgs(input(options));
  const at = args.indexOf("-vf");
  if (at < 0) throw new Error("transcode args have no -vf");
  return args[at + 1]!;
}

describe("MAIN keyframe gate", () => {
  it("keeps the sub scale filter and gates only MAIN", () => {
    const scale = buildAspectScaleFilter({ width: 640, height: 360, aspect: "16:9", fit: "pad" });
    expect(videoFilter({})).toBe(scale);
    expect(videoFilter({ tier: "sub" })).toBe(scale);
    expect(videoFilter({ tier: "main" })).toBe(`${MAIN_KEYFRAME_GATE},${scale}`);
    expect(MAIN_KEYFRAME_GATE).not.toContain("setpts");

    const wide = buildAspectScaleFilter({ width: 854, height: 480, aspect: "16:9", fit: "pad" });
    expect(videoFilter({ tier: "sub", width: 854, height: 480 })).toBe(wide);
    expect(videoFilter({ tier: "main", width: 854, height: 480 })).toBe(`${MAIN_KEYFRAME_GATE},${wide}`);

    const crop = buildAspectScaleFilter({ width: 640, height: 480, aspect: "4:3", fit: "crop" });
    expect(videoFilter({ tier: "sub", aspect: "4:3", width: 640, height: 480 })).toBe(crop);
    expect(videoFilter({ tier: "main", aspect: "4:3", width: 640, height: 480 })).toBe(`${MAIN_KEYFRAME_GATE},${crop}`);

    const copy = buildLiveFfmpegArgs(input({ tier: "main", videoMode: "copy" }));
    expect(copy.join(" ")).not.toContain("select=");
    expect(copy).not.toContain("-vf");
    expect(ARGUS_FIRMWARE_REVISION).toBe("1.3.16");
  });

  it("adds the gate for MAIN and removes it when the session returns to the sub", async () => {
    const subUrl = "rtsp://127.0.0.1:8554/backyard-left-sub";
    const mainUrl = "rtsp://127.0.0.1:8554/backyard-left";
    const spawnFn = vi.fn((_command: string, args: string[]) => Object.assign(new EventEmitter(), { kill: vi.fn() }));
    const delegate = new ArgusStreamingDelegate(
      "Backyard Left",
      subUrl,
      { getOrRefresh: async () => ({ buffer: Buffer.from([0xff, 0xd8]) }) } as never,
      { aspect: "16:9", spawnFn: spawnFn as never, verbose: false, mainStreamUrl: mainUrl },
    );
    const sessionID = "gate";
    const joined = (index: number): string => {
      const args = spawnFn.mock.calls[index]?.[1];
      if (!args) throw new Error(`ffmpeg was not spawned at ${index}`);
      return args.join(" ");
    };

    try {
      await new Promise<void>((resolve, reject) => {
        delegate.prepareStream(
          {
            sessionID,
            targetAddress: "192.168.1.50",
            video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
            audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) },
          } as never,
          (error) => (error ? reject(error) : resolve()),
        );
      });
      await new Promise<void>((resolve, reject) => {
        delegate.handleStreamRequest(
          {
            type: "start",
            sessionID,
            video: { pt: 99, fps: 30, mtu: 1378, profile: 0, level: 2, width: 640, height: 360, max_bit_rate: 132 },
            audio: { pt: 110, sample_rate: 24, max_bit_rate: 24, codec: 3 },
          } as never,
          (error) => (error ? reject(error) : resolve()),
        );
      });
      expect(joined(0)).toContain(`-i ${subUrl}`);
      expect(joined(0)).not.toContain("select=");

      delegate.handleStreamRequest(
        {
          type: "reconfigure",
          sessionID,
          video: { width: 1280, height: 720, fps: 30, max_bit_rate: 2000, rtcp_interval: 0.5 },
        } as never,
        () => {},
      );
      expect(joined(1)).toContain(`-i ${mainUrl} `);
      expect(joined(1)).toContain(MAIN_KEYFRAME_GATE);

      delegate.handleStreamRequest(
        {
          type: "reconfigure",
          sessionID,
          video: { width: 640, height: 360, fps: 30, max_bit_rate: 132, rtcp_interval: 0.5 },
        } as never,
        () => {},
      );
      expect(spawnFn).toHaveBeenCalledTimes(3);
      expect(joined(2)).toContain(`-i ${subUrl}`);
      expect(joined(2)).not.toContain("select=");
    } finally {
      delegate.handleStreamRequest({ type: "stop", sessionID } as never, () => {});
    }
  });
});

interface FrameStats {
  sats: number[];
  pts: number[];
}

function run(command: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}\n${result.stderr}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function frameStats(text: string): FrameStats {
  return {
    sats: [...text.matchAll(/SATAVG=([0-9.]+)/g)].map((match) => Number(match[1])),
    pts: [...text.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1])),
  };
}

function nalStarts(buf: Buffer): number[] {
  const starts: number[] = [];
  for (let i = 0; i < buf.length - 3; i += 1) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      starts.push(i > 0 && buf[i - 1] === 0 ? i - 1 : i);
      i += 2;
    }
  }
  starts.push(buf.length);
  return starts;
}

function sliceAfterFirstVcl(buf: Buffer, nalType: (buf: Buffer, offset: number) => number, isVcl: (type: number) => boolean): Buffer {
  const starts = nalStarts(buf);
  const nals = [];
  for (let i = 0; i < starts.length - 1; i += 1) {
    const start = starts[i]!;
    const end = starts[i + 1]!;
    let offset = start;
    while (offset < end && buf[offset] === 0) offset += 1;
    if (buf[offset] === 1) offset += 1;
    nals.push({ start, end, type: nalType(buf, offset) });
  }
  const vcl = nals.filter((nal) => isVcl(nal.type));
  const first = vcl[0];
  const second = vcl[1];
  if (!first || !second) throw new Error("bitstream has fewer than two video frames");
  const parts = nals.filter((nal) => nal.start < first.start).map((nal) => buf.subarray(nal.start, nal.end));
  parts.push(buf.subarray(second.start));
  return Buffer.concat(parts);
}

function assertHeld(ungated: FrameStats, gated: FrameStats): void {
  expect(gated.sats.length).toBeGreaterThan(ungated.sats.length / 2);
  expect(gated.sats[0]).toBeGreaterThanOrEqual(CLEAN_SAT);
  expect(Math.min(...gated.sats)).toBeGreaterThanOrEqual(CLEAN_SAT);
  const dropped = ungated.sats.length - gated.sats.length;
  expect(dropped).toBeGreaterThanOrEqual(0);
  expect(dropped).toBeLessThan(GOP_FRAMES);
  expect(gated.pts[0]).toBeLessThanOrEqual(GOP_SECONDS);
  if ((ungated.sats[0] ?? CLEAN_SAT) < CLEAN_SAT / 2) {
    const firstClean = ungated.sats.findIndex((value) => value >= CLEAN_SAT);
    const lead = ungated.sats.slice(0, Math.max(firstClean, 0));
    const detail = `n=${ungated.sats.length} gated=${gated.sats.length} dropped=${dropped} firstClean=${firstClean} pts=${gated.pts[0]} leadMax=${lead.length ? Math.max(...lead).toFixed(1) : "none"}`;
    expect(firstClean, detail).toBeGreaterThan(0);
    expect(Math.max(...lead), detail).toBeLessThan(CLEAN_SAT / 2);
    expect(dropped, detail).toBe(firstClean);
    expect(gated.pts[0]).toBeGreaterThan(0);
    return;
  }
  expect(dropped).toBe(0);
}

describe("MAIN keyframe gate pictures", () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-gray-"));
  let ungated: FrameStats;
  let gated: FrameStats;
  let onKeyUngated: FrameStats;
  let onKeyGated: FrameStats;
  let sub: FrameStats;
  let encodedSats: number[] = [];
  let encodedFrames: string[] = [];

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeAll(() => {
    const hevc = join(dir, "main.hevc");
    const h264 = join(dir, "sub.h264");
    const midHevc = join(dir, "main-mid.hevc");
    const midH264 = join(dir, "sub-mid.h264");
    const onKey = join(dir, "main.mp4");
    const encoded = join(dir, "delivered.ts");
    run("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=${RATE}:duration=5`,
      "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-x265-params", `keyint=${GOP_FRAMES}:min-keyint=${GOP_FRAMES}:scenecut=0:bframes=0:open-gop=0:repeat-headers=1`,
      "-f", "hevc", hevc,
    ]);
    run("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=${RATE}:duration=5`,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-g", String(GOP_FRAMES), "-keyint_min", String(GOP_FRAMES), "-sc_threshold", "0", "-bf", "0",
      "-f", "h264", h264,
    ]);
    writeFileSync(midHevc, sliceAfterFirstVcl(readFileSync(hevc), (buf, offset) => (buf[offset]! >> 1) & 0x3f, (type) => type <= 1 || (type >= 19 && type <= 21)));
    writeFileSync(midH264, sliceAfterFirstVcl(readFileSync(h264), (buf, offset) => buf[offset]! & 0x1f, (type) => type === 1 || type === 5));
    run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", hevc, "-c", "copy", "-tag:v", "hvc1", onKey]);

    const mainArgs = buildLiveFfmpegArgs(input({ tier: "main" }));
    const subArgs = buildLiveFfmpegArgs(input({ tier: "sub" }));
    expect(mainArgs).toContain("+discardcorrupt+genpts+nobuffer+flush_packets");
    expect(mainArgs).toContain("ignore_err");
    expect(mainArgs).toContain("-rtsp_transport");
    const fileHead = (args: string[]): string[] => {
      const head = args.slice(0, args.indexOf("-i"));
      const kept: string[] = [];
      for (let i = 0; i < head.length; i += 1) {
        const arg = head[i]!;
        if (arg === "-rtsp_transport" || arg === "-progress") {
          i += 1;
          continue;
        }
        kept.push(arg);
      }
      return kept;
    };
    const mainHead = fileHead(mainArgs);
    const subHead = fileHead(subArgs);
    const mainVf = mainArgs[mainArgs.indexOf("-vf") + 1]!;
    const subVf = subArgs[subArgs.indexOf("-vf") + 1]!;
    const measure = (head: string[], file: string, vf: string): FrameStats => {
      const { stdout } = run("ffmpeg", [
        ...head,
        "-i", file,
        "-vf", `${vf},signalstats,metadata=print:file=-:key=lavfi.signalstats.SATAVG`,
        "-f", "null", "-",
      ]);
      const stats = frameStats(stdout);
      if (stats.sats.length < 2 || stats.pts.length !== stats.sats.length) {
        throw new Error(`expected paired frames from ${file}, got ${stats.sats.length} sats and ${stats.pts.length} pts`);
      }
      return stats;
    };
    ungated = measure(subHead, midHevc, subVf);
    gated = measure(mainHead, midHevc, mainVf);
    onKeyUngated = measure(subHead, onKey, subVf);
    onKeyGated = measure(mainHead, onKey, mainVf);
    sub = measure(subHead, midH264, subVf);

    const an = mainArgs.indexOf("-an");
    const format = mainArgs.indexOf("-f", an);
    run("ffmpeg", [...mainHead, "-i", midHevc, ...mainArgs.slice(an, format), "-f", "mpegts", encoded]);
    const decoded = run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", encoded,
      "-vf", "signalstats,metadata=print:file=-:key=lavfi.signalstats.SATAVG",
      "-f", "null", "-",
    ]);
    encodedSats = frameStats(decoded.stdout).sats;
    encodedFrames = run("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "frame=key_frame,pts_time", "-of", "csv=p=0", encoded,
    ]).stdout.trim().split("\n").filter(Boolean);
  }, 60_000);

  it("withholds fewer than one 2s GOP and the first MAIN frame is a real picture", () => {
    assertHeld(ungated, gated);
    assertHeld(onKeyUngated, onKeyGated);
  });

  it("leaves an H.264 mid-GOP sub picture clean from the first frame", () => {
    expect(sub.sats[0]).toBeGreaterThanOrEqual(CLEAN_SAT);
    expect(Math.min(...sub.sats)).toBeGreaterThanOrEqual(CLEAN_SAT);
  });

  it("encodes that first picture as a keyframe at 30 fps", () => {
    expect(encodedSats[0]).toBeGreaterThanOrEqual(CLEAN_SAT);
    expect(Math.min(...encodedSats)).toBeGreaterThanOrEqual(CLEAN_SAT);
    expect(encodedSats.length).toBeGreaterThan(gated.sats.length);
    expect(encodedSats.length).toBeLessThan(ungated.sats.length * 1.2);
    expect(encodedFrames[0]?.startsWith("1,")).toBe(true);
    const pts = encodedFrames.map((row) => Number(row.split(",")[1]));
    const first = pts[0] ?? 0;
    const last = pts[pts.length - 1] ?? 0;
    const fps = (pts.length - 1) / (last - first);
    expect(fps).toBeGreaterThan(29);
    expect(fps).toBeLessThan(31);
  });
});
