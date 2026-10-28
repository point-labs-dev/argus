import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  AudioStreamingCodecType,
  H264Level,
  H264Profile,
  MediaContainerType,
  VideoCodecType,
  type CameraRecordingConfiguration,
} from "hap-nodejs";

import {
  buildCameraControllerOptions,
  buildLiveFfmpegArgs,
  effectiveBitrateKbps,
  type LiveFfmpegInput,
} from "../src/homekit.js";
import { buildRecordingFfmpegArgs } from "../src/recording.js";
import { percentileOf, samplesForSpan } from "./notification-latency.mjs";

const FRAMES = 30;
const FFMPEG_TIMEOUT_MS = 30_000;
const LIVE_SOURCE = "testsrc2=size=640x360:rate=30:duration=1";
const RECORDING_SOURCE = "testsrc2=size=1920x1080:rate=30:duration=1";
const P720_SOURCE = "testsrc2=size=1280x720:rate=30:duration=1";

const HKSV_P50_MS = 5300;
const HKSV_P50_TOLERANCE_MS = 0;
const LIVE_P50_MS = 1281;
const LIVE_P95_MS = 4265;
const LIVE_MS_TOLERANCE = 0;
const LIVE_OVER_2_5_S = 28.4;
const LIVE_OVER_TOLERANCE = 0.05;
const LIVE_HEIGHT = 480;
const RECORDING_SPEC = "1080p30 H.264 Baseline L4.0 2Mbps";
const LIVE_SSIM = 0.981368;
const RECORDING_SSIM = 0.985117;
const SSIM_TOLERANCE = 0.002;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_LOG = join(SCRIPT_DIR, "fixtures", "field-latency.txt");

type Source = "fixture" | "encode" | "skip";
type Gate = "ok" | "fail" | "skip";

interface MetricLine {
  id: string;
  current: string;
  baseline: string;
  tolerance: string;
  target: string;
  source: Source;
  measuredSha: string;
  gate: Gate;
  reason?: string;
}

class StampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StampError";
  }
}

function isEnoent(error: Error | undefined): boolean {
  return error !== undefined && "code" in error && error.code === "ENOENT";
}

function gitResult(args: readonly string[]): { status: number | null; stdout: string; missing: boolean } {
  const result = spawnSync("git", [...args], { cwd: ROOT, encoding: "utf8" });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    missing: isEnoent(result.error),
  };
}

function commitTouches(sha: string, path: string): boolean {
  const diff = gitResult(["diff-tree", "--no-commit-id", "--name-only", "-r", sha, "--", path]);
  if (diff.missing) throw new StampError("frozen-benchmarks: git is not on PATH");
  return diff.status === 0 && diff.stdout.split("\n").includes(path);
}

function commitOf(path: string): string {
  const log = gitResult(["log", "-1", "--format=%H", "--", path]);
  if (log.missing) throw new StampError("frozen-benchmarks: git is not on PATH");
  if (log.status !== 0 || !/^[0-9a-f]{40}$/.test(log.stdout)) {
    throw new StampError(`frozen-benchmarks: no commit for ${path}`);
  }
  if (commitTouches(log.stdout, path)) return log.stdout;
  const shallow = gitResult(["rev-parse", "--is-shallow-repository"]);
  if (shallow.missing) throw new StampError("frozen-benchmarks: git is not on PATH");
  if (shallow.stdout === "true") {
    throw new StampError(`frozen-benchmarks: a shallow clone cannot name the commit for ${path}`);
  }
  throw new StampError(`frozen-benchmarks: no commit for ${path}`);
}

export function frozenGate(input: {
  current: number;
  baseline: number;
  tolerance: number;
  better: "lower" | "higher";
  target: number;
  targetExclusive?: boolean;
}): Gate {
  const meets = input.better === "lower"
    ? (input.targetExclusive === true ? input.current < input.target : input.current <= input.target)
    : input.current >= input.target;
  if (meets) return "ok";
  const regressed = input.better === "lower"
    ? input.current > input.baseline + input.tolerance
    : input.current < input.baseline - input.tolerance;
  return regressed ? "fail" : "ok";
}

interface PictureScore {
  ssim: number;
  vmaf?: number;
  vmafReason?: string;
}

export function formatMetric(metric: MetricLine): string {
  const reason = metric.reason === undefined ? "" : ` reason="${metric.reason}"`;
  return [
    metric.id,
    `current=${token(metric.current)}`,
    `baseline=${token(metric.baseline)}`,
    `tolerance=${metric.tolerance}`,
    `target=${token(metric.target)}`,
    `source=${metric.source}`,
    `measured_sha=${metric.measuredSha}`,
    `gate=${metric.gate}`,
  ].join(" ") + reason;
}

function token(value: string): string {
  return value.includes(" ") ? `"${value}"` : value;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 160);
}

function flagValue(args: readonly string[], flag: string): string {
  const at = args.indexOf(flag);
  const value = at >= 0 ? args[at + 1] : undefined;
  if (value === undefined) {
    throw new Error(`frozen-benchmarks: missing ${flag}`);
  }
  return value;
}

function codecSlice(args: readonly string[], endFlag: string): string[] {
  const start = args.indexOf("-c:v");
  const end = args.indexOf(endFlag);
  if (start < 0 || end <= start) {
    throw new Error("frozen-benchmarks: codec args missing");
  }
  return args.slice(start, end);
}

function pinThreads(args: readonly string[]): string[] {
  const pinned = [...args];
  const paramsAt = pinned.indexOf("-x264-params");
  const params = paramsAt >= 0 ? pinned[paramsAt + 1] : undefined;
  if (params !== undefined && !params.includes("threads=")) {
    pinned[paramsAt + 1] = `${params}:threads=1`;
  }
  if (!pinned.includes("-threads")) {
    pinned.push("-threads", "1");
  }
  return pinned;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function withDefaultLiveEnv<T>(fn: () => T): T {
  const ladder = process.env.ARGUS_LIVE_LADDER;
  const intra = process.env.ARGUS_LIVE_INTRA;
  delete process.env.ARGUS_LIVE_LADDER;
  delete process.env.ARGUS_LIVE_INTRA;
  try {
    return fn();
  } finally {
    restoreEnv("ARGUS_LIVE_LADDER", ladder);
    restoreEnv("ARGUS_LIVE_INTRA", intra);
  }
}

function liveCodecArgs(width: number, height: number, fps: number, negotiatedKbps: number): string[] {
  const input: LiveFfmpegInput = {
    inputUrl: "rtsp://127.0.0.1:8554/fixture-sub",
    targetAddress: "127.0.0.1",
    videoMode: "transcode",
    aspect: "16:9",
    video: {
      port: 1,
      localRtcpPort: 2,
      ssrc: 1,
      payloadType: 99,
      maxBitrateKbps: effectiveBitrateKbps(width, height, negotiatedKbps),
      fps,
      width,
      height,
      mtu: 1378,
      profile: "baseline",
      level: height >= 720 ? "4.0" : "3.1",
      srtpParams: "unused",
    },
    audio: {
      port: 3,
      localRtcpPort: 4,
      ssrc: 2,
      payloadType: 110,
      codec: AudioStreamingCodecType.OPUS,
      sampleRateKhz: 24,
      maxBitrateKbps: 24,
      srtpParams: "unused",
    },
  };
  return codecSlice(buildLiveFfmpegArgs(input, false), "-payload_type");
}

function liveOffer(): { height: number; codec: string[] } {
  return withDefaultLiveEnv(() => {
    const wide = buildCameraControllerOptions({ aspect: "16:9" } as never);
    const square = buildCameraControllerOptions({ aspect: "4:3" } as never);
    const heights = [
      ...wide.streamingOptions.video.resolutions,
      ...square.streamingOptions.video.resolutions,
    ].map((row) => row[1]);
    const height = heights.reduce((best, value) => Math.max(best, value), 0);
    const top = wide.streamingOptions.video.resolutions[0];
    if (!top || height === 0) {
      throw new Error("frozen-benchmarks: no live rung");
    }
    return { height, codec: liveCodecArgs(top[0], top[1], top[2], 1) };
  });
}

function p720Target(): string {
  return withDefaultLiveEnv(() => {
    const score = scoreRecipe(P720_SOURCE, liveCodecArgs(1280, 720, 30, 2000), false);
    return `${score.ssim.toFixed(6)}@1280x720`;
  });
}

function recordingConfig(): CameraRecordingConfiguration {
  return {
    prebufferLength: 4000,
    eventTriggerTypes: [],
    mediaContainerConfiguration: {
      type: MediaContainerType.FRAGMENTED_MP4,
      fragmentLength: 4000,
    },
    videoCodec: {
      type: VideoCodecType.H264,
      parameters: {
        profile: H264Profile.BASELINE,
        level: H264Level.LEVEL4_0,
        bitRate: 2000,
        iFrameInterval: 4000,
      },
      resolution: [1920, 1080, 30],
    },
    audioCodec: {
      type: AudioRecordingCodecType.AAC_LC,
      audioChannels: 1,
      samplerate: AudioRecordingSamplerate.KHZ_32,
      bitrate: 64,
    },
  };
}

const PROFILE_RANK: Record<string, number> = { Baseline: 1, Main: 2, High: 3 };

function parsePictureSpec(spec: string): { pixels: number; fps: number; rank: number; kbps: number } | undefined {
  const match = spec.match(/^(?:1080p(\d+)|(\d+)x(\d+)@(\d+)) H\.264 (Baseline|Main|High) L[\d.]+ (\d+(?:Mbps|k))$/);
  const profile = match?.[5];
  const rateToken = match?.[6];
  const fpsToken = match?.[1] ?? match?.[4];
  if (match === null || profile === undefined || rateToken === undefined || fpsToken === undefined) return undefined;
  const fps = Number(fpsToken);
  const rank = PROFILE_RANK[profile] ?? 0;
  const kbps = rateToken.endsWith("Mbps") ? Number(rateToken.slice(0, -4)) * 1000 : Number(rateToken.slice(0, -1));
  if (!Number.isFinite(fps) || rank === 0 || !Number.isFinite(kbps)) return undefined;
  if (match[2] === undefined) return { pixels: 1920 * 1080, fps, rank, kbps };
  return { pixels: Number(match[2]) * Number(match[3]), fps, rank, kbps };
}

export function recordingHolds(spec: string): boolean {
  const base = parsePictureSpec(RECORDING_SPEC);
  const next = parsePictureSpec(spec);
  if (base === undefined || next === undefined) return false;
  return next.pixels >= base.pixels && next.fps >= base.fps && next.rank >= base.rank && next.kbps >= base.kbps;
}

export function recordingSpec(args: readonly string[]): string {
  const profile = flagValue(args, "-profile:v");
  const level = flagValue(args, "-level");
  const rate = flagValue(args, "-r");
  const bitrate = flagValue(args, "-b:v");
  const size = flagValue(args, "-vf").match(/scale=(\d+):(\d+)/);
  const width = size?.[1];
  const height = size?.[2];
  if (width === undefined || height === undefined) {
    throw new Error("frozen-benchmarks: no recording scale");
  }
  const kbps = bitrate.endsWith("k") ? Number(bitrate.slice(0, -1)) : Number.NaN;
  const rateLabel = Number.isInteger(kbps) && kbps % 1000 === 0 ? `${kbps / 1000}Mbps` : bitrate;
  const profileLabel = profile === "baseline" ? "Baseline" : profile === "main" ? "Main" : profile === "high" ? "High" : profile;
  const sizeAndFps = width === "1920" && height === "1080" ? `1080p${rate}` : `${width}x${height}@${rate}`;
  return `${sizeAndFps} H.264 ${profileLabel} L${level} ${rateLabel}`;
}

function ffmpegHasLibvmaf(): boolean {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8", timeout: FFMPEG_TIMEOUT_MS });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /(^|\s)libvmaf(\s|$)/m.test(text);
}

function ffmpeg(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: FFMPEG_TIMEOUT_MS });
  if (result.error) {
    throw new Error(oneLine(result.error.message));
  }
  if (result.status !== 0) {
    const detail = oneLine(result.stderr || "");
    throw new Error(detail || `ffmpeg exited ${result.status}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function parseSsim(text: string): number {
  const match = text.match(/All:([0-9.]+)/);
  const raw = match?.[1];
  if (raw === undefined) {
    throw new Error("ssim score missing");
  }
  return Number(raw);
}

function scoreRecipe(source: string, codecArgs: readonly string[], withVmaf: boolean): PictureScore {
  const dir = mkdtempSync(join(tmpdir(), "argus-bench-"));
  try {
    const ref = join(dir, "ref.y4m");
    const out = join(dir, "out.mp4");
    const vf = flagValue(codecArgs, "-vf");
    const pinned = pinThreads(codecArgs);
    ffmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", source,
      "-vf", vf,
      "-frames:v", String(FRAMES),
      "-pix_fmt", "yuv420p",
      ref,
    ]);
    ffmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", source,
      ...pinned,
      "-frames:v", String(FRAMES),
      "-an",
      out,
    ]);
    const ssimRun = ffmpeg([
      "-hide_banner",
      "-i", out,
      "-i", ref,
      "-lavfi", "[0:v][1:v]ssim",
      "-f", "null", "-",
    ]);
    const ssim = parseSsim(ssimRun.stdout + ssimRun.stderr);
    if (!withVmaf) return { ssim };
    try {
      const vmafRun = ffmpeg([
        "-hide_banner",
        "-i", out,
        "-i", ref,
        "-lavfi", "[0:v][1:v]libvmaf",
        "-f", "null", "-",
      ]);
      const score = (vmafRun.stdout + vmafRun.stderr).match(/VMAF score:\s*([0-9.]+)/);
      const raw = score?.[1];
      if (raw === undefined) return { ssim, vmafReason: "libvmaf returned no score" };
      return { ssim, vmaf: Number(raw) };
    } catch {
      return { ssim, vmafReason: "libvmaf failed" };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function encoderDelayMs(frames: number): number {
  return Math.round((frames * 1000) / 30);
}

function framesBeforeFirstPacket(codecArgs: readonly string[], threads: number): number {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "info", "-debug_ts",
    "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=2",
    ...codecArgs,
    "-threads", String(threads),
    "-an",
    "-f", "null", "-",
  ], { encoding: "utf8", timeout: FFMPEG_TIMEOUT_MS });
  if (result.error) throw new Error(oneLine(result.error.message));
  if (result.status !== 0) {
    throw new Error(oneLine(result.stderr || "") || `ffmpeg exited ${result.status}`);
  }
  const lines = (result.stderr ?? "").split("\n");
  const firstPacket = lines.findIndex((line) => line.includes("encoder -> type:video"));
  if (firstPacket < 0) throw new Error("encoder produced no packet");
  const frames = lines.slice(0, firstPacket).filter((line) => line.includes("encoder <- type:video")).length;
  if (frames === 0) throw new Error("encoder took no frames");
  return frames;
}

function encoderDelayLine(
  threads: 6 | 15,
  baselineFrames: number,
  codecArgs: readonly string[],
  measuredSha: string,
): MetricLine {
  const id = `recording_encoder_delay_t${threads}`;
  const baseline = encoderDelayMs(baselineFrames);
  const targetMs = encoderDelayMs(12);
  const target = `<=${targetMs}ms`;
  try {
    const frames = framesBeforeFirstPacket(codecArgs, threads);
    const current = encoderDelayMs(frames);
    return {
      id,
      current: `${current}ms`,
      baseline: `${baseline}ms`,
      tolerance: "0ms",
      target,
      source: "encode",
      measuredSha,
      gate: frozenGate({ current, baseline, tolerance: 0, better: "lower", target: targetMs }),
      reason: `${threads} x264 threads, ${frames} frames at 30fps`,
    };
  } catch (error) {
    return {
      id,
      current: "missing",
      baseline: `${baseline}ms`,
      tolerance: "0ms",
      target,
      source: "encode",
      measuredSha,
      gate: "fail",
      reason: oneLine(error instanceof Error ? error.message : "encode failed"),
    };
  }
}

function latencyLine(
  id: string,
  samples: number[],
  percentile: number,
  baseline: number,
  tolerance: number,
  targetMs: number,
  measuredSha: string,
): MetricLine {
  const target = `<=${targetMs}ms`;
  if (samples.length === 0) {
    return {
      id,
      current: "missing",
      baseline: `${baseline}ms`,
      tolerance: `${tolerance}ms`,
      target,
      source: "fixture",
      measuredSha,
      gate: "fail",
    };
  }
  const value = percentileOf(samples, percentile);
  if (value === undefined) {
    return {
      id,
      current: "missing",
      baseline: `${baseline}ms`,
      tolerance: `${tolerance}ms`,
      target,
      source: "fixture",
      measuredSha,
      gate: "fail",
    };
  }
  const current = Math.round(value);
  return {
    id,
    current: `${current}ms`,
    baseline: `${baseline}ms`,
    tolerance: `${tolerance}ms`,
    target,
    source: "fixture",
    measuredSha,
    gate: frozenGate({ current, baseline, tolerance, better: "lower", target: targetMs }),
  };
}

function overLine(samples: number[], measuredSha: string): MetricLine {
  if (samples.length === 0) {
    return {
      id: "live_starts_over_2_5s",
      current: "missing",
      baseline: `${LIVE_OVER_2_5_S.toFixed(1)}%`,
      tolerance: `${LIVE_OVER_TOLERANCE}%`,
      target: "<5%",
      source: "fixture",
      measuredSha,
      gate: "fail",
    };
  }
  const over = samples.filter((sample) => sample > 2500).length;
  const current = Math.round((over / samples.length) * 1000) / 10;
  return {
    id: "live_starts_over_2_5s",
    current: `${current.toFixed(1)}%`,
    baseline: `${LIVE_OVER_2_5_S.toFixed(1)}%`,
    tolerance: `${LIVE_OVER_TOLERANCE}%`,
    target: "<5%",
    source: "fixture",
    measuredSha,
    gate: frozenGate({
      current,
      baseline: LIVE_OVER_2_5_S,
      tolerance: LIVE_OVER_TOLERANCE,
      better: "lower",
      target: 5,
      targetExclusive: true,
    }),
  };
}

function ssimLine(
  id: string,
  baseline: number,
  target: string,
  score: PictureScore | undefined,
  error: string | undefined,
  measuredSha: string,
): MetricLine {
  if (error !== undefined || score === undefined) {
    return {
      id,
      current: "missing",
      baseline: baseline.toFixed(6),
      tolerance: String(SSIM_TOLERANCE),
      target,
      source: "fixture",
      measuredSha,
      gate: "fail",
      reason: oneLine(error ?? "ssim failed"),
    };
  }
  const current = Number(score.ssim.toFixed(6));
  return {
    id,
    current: current.toFixed(6),
    baseline: baseline.toFixed(6),
    tolerance: String(SSIM_TOLERANCE),
    target,
    source: "fixture",
    measuredSha,
    gate: frozenGate({ current, baseline, tolerance: SSIM_TOLERANCE, better: "higher", target: baseline }),
  };
}

function vmafLine(id: string, score: PictureScore | undefined, filterPresent: boolean, measuredSha: string): MetricLine {
  if (!filterPresent) {
    return {
      id,
      current: "skip",
      baseline: "unmeasured",
      tolerance: "skip",
      target: "unmeasured",
      source: "skip",
      measuredSha,
      gate: "skip",
      reason: "ffmpeg has no libvmaf",
    };
  }
  if (score?.vmaf === undefined) {
    return {
      id,
      current: "skip",
      baseline: "unmeasured",
      tolerance: "skip",
      target: "unmeasured",
      source: "skip",
      measuredSha,
      gate: "skip",
      reason: score?.vmafReason ?? "libvmaf returned no score",
    };
  }
  return {
    id,
    current: score.vmaf.toFixed(3),
    baseline: "unmeasured",
    tolerance: "skip",
    target: "unmeasured",
    source: "skip",
    measuredSha,
    gate: "skip",
    reason: "no frozen vmaf baseline",
  };
}

export function runFrozenBenchmarks(logContents: string): { lines: string[]; failed: boolean } {
  const fixtureSha = commitOf("scripts/fixtures/field-latency.txt");
  const liveSha = commitOf("src/homekit.ts");
  const recordingSha = commitOf("src/recording.ts");
  const recordingSamples = samplesForSpan(logContents, "recording_start_to_first_fragment");
  const liveSamples = samplesForSpan(logContents, "live_session_start_to_first_frame");
  const offer = liveOffer();
  const recordingArgs = codecSlice(
    buildRecordingFfmpegArgs("rtsp://127.0.0.1:8554/fixture-main", recordingConfig(), "16:9"),
    "-c:a",
  );
  const spec = recordingSpec(recordingArgs);
  const vmaf = ffmpegHasLibvmaf();
  const liveTarget = p720Target();

  let liveScore: PictureScore | undefined;
  let liveError: string | undefined;
  let recordingScore: PictureScore | undefined;
  let recordingError: string | undefined;
  try {
    liveScore = scoreRecipe(LIVE_SOURCE, offer.codec, vmaf);
  } catch (error) {
    liveError = error instanceof Error ? error.message : "ssim failed";
  }
  try {
    recordingScore = scoreRecipe(RECORDING_SOURCE, recordingArgs, vmaf);
  } catch (error) {
    recordingError = error instanceof Error ? error.message : "ssim failed";
  }

  const metrics: MetricLine[] = [
    latencyLine("hksv_first_fragment_p50", recordingSamples, 50, HKSV_P50_MS, HKSV_P50_TOLERANCE_MS, 2650, fixtureSha),
    latencyLine("live_first_frame_p50", liveSamples, 50, LIVE_P50_MS, LIVE_MS_TOLERANCE, 650, fixtureSha),
    latencyLine("live_first_frame_p95", liveSamples, 95, LIVE_P95_MS, LIVE_MS_TOLERANCE, 2100, fixtureSha),
    overLine(liveSamples, fixtureSha),
    {
      id: "live_picture_height",
      current: `${offer.height}p`,
      baseline: `${LIVE_HEIGHT}p`,
      tolerance: "0p",
      target: ">=720p",
      source: "fixture",
      measuredSha: liveSha,
      gate: frozenGate({ current: offer.height, baseline: LIVE_HEIGHT, tolerance: 0, better: "higher", target: 720 }),
    },
    {
      id: "recording_picture",
      current: spec,
      baseline: RECORDING_SPEC,
      tolerance: "not-worse",
      target: "beyond 1080p30 H.264 Baseline 2Mbps",
      source: "fixture",
      measuredSha: recordingSha,
      gate: recordingHolds(spec) ? "ok" : "fail",
    },
    ssimLine("live_ssim", LIVE_SSIM, liveTarget, liveScore, liveError, liveSha),
    ssimLine("recording_ssim", RECORDING_SSIM, "beyond 1080p30 H.264 Baseline 2Mbps", recordingScore, recordingError, recordingSha),
    vmafLine("live_vmaf", liveScore, vmaf, liveSha),
    vmafLine("recording_vmaf", recordingScore, vmaf, recordingSha),
    encoderDelayLine(15, 26, recordingArgs, recordingSha),
    encoderDelayLine(6, 17, recordingArgs, recordingSha),
  ];
  return {
    lines: metrics.map(formatMetric),
    failed: metrics.some((metric) => metric.gate === "fail"),
  };
}

function readLog(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    process.stderr.write("frozen-benchmarks: cannot read log\n");
    process.exitCode = 1;
    return undefined;
  }
}

const invoked = process.argv[1]?.endsWith("frozen-benchmarks.ts") === true;
if (invoked) {
  const flag = process.argv.indexOf("--log");
  const requested = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (flag >= 0 && (requested === undefined || requested.startsWith("-"))) {
    process.stderr.write("frozen-benchmarks: --log needs a path\n");
    process.exitCode = 2;
  } else {
    const contents = readLog(requested ?? FIXTURE_LOG);
    if (contents !== undefined) {
      try {
        const result = runFrozenBenchmarks(contents);
        process.stdout.write(`${result.lines.join("\n")}\n`);
        if (result.failed) process.exitCode = 1;
      } catch (error) {
        if (error instanceof StampError) {
          process.stderr.write(`${error.message}\n`);
          process.exitCode = 1;
        } else {
          throw error;
        }
      }
    }
  }
}
