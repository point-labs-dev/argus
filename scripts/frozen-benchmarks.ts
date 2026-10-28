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

const MEASURED_SHA = "eb1ede5e7922b57f5381a77b111050a0bde4fc4e";
const FRAMES = 30;
const FFMPEG_TIMEOUT_MS = 30_000;
const LIVE_SOURCE = "testsrc2=size=640x360:rate=30:duration=1";
const RECORDING_SOURCE = "testsrc2=size=1920x1080:rate=30:duration=1";

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
const LIVE_SSIM_TARGET = "0.989476@1280x720";

const FIXTURE_LOG = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "field-latency.txt");

type Source = "field" | "fixture" | "skip";
type Gate = "ok" | "fail" | "skip";

interface MetricLine {
  id: string;
  current: string;
  baseline: string;
  tolerance: string;
  target: string;
  source: Source;
  gate: Gate;
  reason?: string;
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
    `measured_sha=${MEASURED_SHA}`,
    `gate=${metric.gate}`,
  ].join(" ") + reason;
}

function token(value: string): string {
  return value.includes(" ") ? `"${value}"` : value;
}

function numericGate(current: number, baseline: number, tolerance: number): Gate {
  return Math.abs(current - baseline) > tolerance ? "fail" : "ok";
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
    const width = top[0];
    const rungHeight = top[1];
    const fps = top[2];
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
        maxBitrateKbps: effectiveBitrateKbps(width, rungHeight, 1),
        fps,
        width,
        height: rungHeight,
        mtu: 1378,
        profile: "baseline",
        level: rungHeight >= 720 ? "4.0" : "3.1",
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
    return { height, codec: codecSlice(buildLiveFfmpegArgs(input, false), "-payload_type") };
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

function recordingSpec(args: readonly string[]): string {
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
  const sizeLabel = width === "1920" && height === "1080" ? "1080p" : `${width}x${height}`;
  return `${sizeLabel}${rate} H.264 ${profileLabel} L${level} ${rateLabel}`;
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

function latencyLine(
  id: string,
  samples: number[],
  percentile: number,
  baseline: number,
  tolerance: number,
  target: string,
): MetricLine {
  const value = samples.length === 0 ? undefined : percentileOf(samples, percentile);
  if (value === undefined) {
    return {
      id,
      current: "missing",
      baseline: `${baseline}ms`,
      tolerance: `${tolerance}ms`,
      target,
      source: "field",
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
    source: "field",
    gate: numericGate(current, baseline, tolerance),
  };
}

function overLine(samples: number[]): MetricLine {
  if (samples.length === 0) {
    return {
      id: "live_starts_over_2_5s",
      current: "missing",
      baseline: `${LIVE_OVER_2_5_S.toFixed(1)}%`,
      tolerance: `${LIVE_OVER_TOLERANCE}%`,
      target: "<5%",
      source: "field",
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
    source: "field",
    gate: numericGate(current, LIVE_OVER_2_5_S, LIVE_OVER_TOLERANCE),
  };
}

function ssimLine(id: string, baseline: number, target: string, score: PictureScore | undefined, error: string | undefined): MetricLine {
  if (error !== undefined || score === undefined) {
    return {
      id,
      current: "missing",
      baseline: baseline.toFixed(6),
      tolerance: String(SSIM_TOLERANCE),
      target,
      source: "fixture",
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
    gate: numericGate(current, baseline, SSIM_TOLERANCE),
  };
}

function vmafLine(id: string, score: PictureScore | undefined, filterPresent: boolean): MetricLine {
  if (!filterPresent) {
    return {
      id,
      current: "skip",
      baseline: "unmeasured",
      tolerance: "skip",
      target: "unmeasured",
      source: "skip",
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
    gate: "skip",
    reason: "no frozen vmaf baseline",
  };
}

export function runFrozenBenchmarks(logContents: string): { lines: string[]; failed: boolean } {
  const recordingSamples = samplesForSpan(logContents, "recording_start_to_first_fragment");
  const liveSamples = samplesForSpan(logContents, "live_session_start_to_first_frame");
  const offer = liveOffer();
  const recordingArgs = codecSlice(
    buildRecordingFfmpegArgs("rtsp://127.0.0.1:8554/fixture-main", recordingConfig(), "16:9"),
    "-c:a",
  );
  const spec = recordingSpec(recordingArgs);
  const vmaf = ffmpegHasLibvmaf();

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
    latencyLine("hksv_first_fragment_p50", recordingSamples, 50, HKSV_P50_MS, HKSV_P50_TOLERANCE_MS, "<=2650ms"),
    latencyLine("live_first_frame_p50", liveSamples, 50, LIVE_P50_MS, LIVE_MS_TOLERANCE, "<=650ms"),
    latencyLine("live_first_frame_p95", liveSamples, 95, LIVE_P95_MS, LIVE_MS_TOLERANCE, "<=2100ms"),
    overLine(liveSamples),
    {
      id: "live_picture_height",
      current: `${offer.height}p`,
      baseline: `${LIVE_HEIGHT}p`,
      tolerance: "0p",
      target: ">=720p",
      source: "field",
      gate: offer.height === LIVE_HEIGHT ? "ok" : "fail",
    },
    {
      id: "recording_picture",
      current: spec,
      baseline: RECORDING_SPEC,
      tolerance: "exact",
      target: "beyond 1080p30 H.264 Baseline 2Mbps",
      source: "field",
      gate: spec === RECORDING_SPEC ? "ok" : "fail",
    },
    ssimLine("live_ssim", LIVE_SSIM, LIVE_SSIM_TARGET, liveScore, liveError),
    ssimLine("recording_ssim", RECORDING_SSIM, "beyond 1080p30 H.264 Baseline 2Mbps", recordingScore, recordingError),
    vmafLine("live_vmaf", liveScore, vmaf),
    vmafLine("recording_vmaf", recordingScore, vmaf),
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
      const result = runFrozenBenchmarks(contents);
      process.stdout.write(`${result.lines.join("\n")}\n`);
      if (result.failed) process.exitCode = 1;
    }
  }
}
