import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { buildRecordingFfmpegArgs } from "../src/recording.js";
import { frozenGate, recordingHolds, recordingSpec } from "../scripts/frozen-benchmarks.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", ".bin", "tsx");
const script = join(root, "scripts", "frozen-benchmarks.ts");

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function commitOf(path: string): string {
  const result = spawnSync("git", ["log", "-1", "--format=%H", "--", path], {
    cwd: root,
    encoding: "utf8",
  });
  const sha = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`no commit for ${path}`);
  }
  return sha;
}

const fixtureSha = commitOf("scripts/fixtures/field-latency.txt");
const liveSha = commitOf("src/homekit.ts");
const recordingSha = commitOf("src/recording.ts");

function metric(id: string, current: string, baseline: string, tolerance: string, target: string, sha: string): string {
  return `${id} current=${current} baseline=${baseline} tolerance=${tolerance} target=${target} source=fixture measured_sha=${sha} gate=ok`;
}

const FROZEN_HEAD = [
  metric("hksv_first_fragment_p50", "5300ms", "5300ms", "0ms", "<=2650ms", fixtureSha),
  metric("live_first_frame_p50", "1281ms", "1281ms", "0ms", "<=650ms", fixtureSha),
  metric("live_first_frame_p95", "4265ms", "4265ms", "0ms", "<=2100ms", fixtureSha),
  metric("live_starts_over_2_5s", "28.4%", "28.4%", "0.05%", "<5%", fixtureSha),
  metric("live_picture_height", "480p", "480p", "0p", ">=720p", liveSha),
  `recording_picture current="1080p30 H.264 Baseline L4.0 2Mbps" baseline="1080p30 H.264 Baseline L4.0 2Mbps" tolerance=not-worse target="beyond 1080p30 H.264 Baseline 2Mbps" source=fixture measured_sha=${recordingSha} gate=ok`,
].join("\n");

const RECORDING_SSIM =
  `recording_ssim current=0.985117 baseline=0.985117 tolerance=0.002 target="beyond 1080p30 H.264 Baseline 2Mbps" source=fixture measured_sha=${recordingSha} gate=ok`;

function vmafSkip(id: string, sha: string): string {
  return `${id} current=skip baseline=unmeasured tolerance=skip target=unmeasured source=skip measured_sha=${sha} gate=skip reason="ffmpeg has no libvmaf"`;
}

function ffmpegHasLibvmaf(): boolean {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
  return /(^|\s)libvmaf(\s|$)/m.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

function run(args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(tsx, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function telemetry(event: string, timestamp: number, metadata: { streamId: number } | { sessionId: string }): string {
  return `ARGUS_TELEMETRY: ${JSON.stringify({ timestamp, camera: "Fixture", event, metadata })}`;
}

function writeLog(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-bench-log-"));
  dirs.push(dir);
  const path = join(dir, "latency.log");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function span(eventStart: string, eventEnd: string, key: "streamId" | "sessionId", deltas: number[]): string[] {
  const lines: string[] = [];
  let timestamp = 1_000_000;
  deltas.forEach((delta, index) => {
    const metadata = key === "streamId" ? { streamId: index + 1 } : { sessionId: `s${index}` };
    lines.push(telemetry(eventStart, timestamp, metadata));
    timestamp += delta;
    lines.push(telemetry(eventEnd, timestamp, metadata));
    timestamp += 1;
  });
  return lines;
}

function expectLiveSsim(line: string | undefined): void {
  expect(line).toMatch(
    new RegExp(
      `^live_ssim current=0\\.981368 baseline=0\\.981368 tolerance=0\\.002 target=([0-9]+\\.[0-9]{6})@1280x720 source=fixture measured_sha=${liveSha} gate=ok$`,
    ),
  );
  const target = Number(line?.match(/target=([0-9.]+)@1280x720/)?.[1]);
  expect(Math.abs(target - 0.989476)).toBeLessThanOrEqual(0.00005);
}

function encoderLine(threads: number, frames: number, baselineFrames: number): string {
  const current = Math.round((frames * 1000) / 30);
  const baseline = Math.round((baselineFrames * 1000) / 30);
  return `recording_encoder_delay_t${threads} current=${current}ms baseline=${baseline}ms tolerance=0ms target=<=${current}ms source=encode measured_sha=${recordingSha} gate=ok reason="${threads} x264 threads, ${frames} frames at 30fps"`;
}

function expectNoField(stdout: string): void {
  expect(stdout).not.toContain("source=field");
  expect(stdout).not.toMatch(/srtp|unused|\d{3}-\d{2}-\d{3}/);
}

function pictureArgs(width: number, height: number, kbps: number): string[] {
  return [
    "-profile:v", "high",
    "-level", "4.0",
    "-r", "30",
    "-b:v", `${kbps}k`,
    "-vf", `scale=${width}:${height}`,
  ];
}

describe("frozen benchmarks", () => {
  it("keeps sync-lookahead=0 and sets sliced-threads on the recording encode", () => {
    const args = buildRecordingFfmpegArgs("rtsp://127.0.0.1:8554/fixture-main", {
      prebufferLength: 4000,
      eventTriggerTypes: [],
      mediaContainerConfiguration: { type: 0, fragmentLength: 4000 },
      videoCodec: {
        type: 0,
        parameters: { profile: 0, level: 2, bitRate: 2000, iFrameInterval: 4000 },
        resolution: [1920, 1080, 30],
      },
      audioCodec: { type: 0, audioChannels: 1, samplerate: 3, bitrate: 64 },
    }, "16:9");
    expect(args[args.indexOf("-x264-params") + 1]).toBe("sync-lookahead=0:sliced-threads=1");
  });

  it("keeps a recording spec that matches or beats the frozen picture", () => {
    const specs = [
      "1080p30 H.264 Baseline L4.0 2Mbps",
      "1080p30 H.264 Main L4.0 2Mbps",
      "1080p30 H.264 High L4.0 4Mbps",
      "1080p30 H.264 Baseline L4.0 2500k",
      "1080p30 H.264 Baseline L4.0 1Mbps",
      "1280x720@30 H.264 High L4.0 8Mbps",
      "1080p15 H.264 High L4.0 4Mbps",
      "not a spec",
    ];
    expect(specs.map((spec) => recordingHolds(spec) ? "1" : "0").join("")).toBe("11110000");
  });

  it("accepts a better non-1080p spec", () => {
    const label = recordingSpec(pictureArgs(3840, 2160, 20000));
    expect(label).toBe("3840x2160@30 H.264 High L4.0 20Mbps");
    expect(recordingHolds(label)).toBe(true);
    expect(recordingHolds("2560x1440@30 H.264 High L4.0 8Mbps")).toBe(true);
  });

  it("rejects 720p High at 8 Mbps for fewer pixels", () => {
    const label = recordingSpec(pictureArgs(1280, 720, 8000));
    expect(label).toBe("1280x720@30 H.264 High L4.0 8Mbps");
    expect(recordingHolds(label)).toBe(false);
  });

  it("rejects 1080p30 Baseline at 1999k for a lower bitrate", () => {
    const label = recordingSpec([
      "-profile:v", "baseline",
      "-level", "4.0",
      "-r", "30",
      "-b:v", "1999k",
      "-vf", "scale=1920:1080",
    ]);
    expect(label).toBe("1080p30 H.264 Baseline L4.0 1999k");
    expect(recordingHolds("1080p30 H.264 Baseline L4.0 2Mbps")).toBe(true);
    expect(recordingHolds("1080p30 H.264 Baseline L4.0 2000k")).toBe(true);
    expect(recordingHolds(label)).toBe(false);
  });

  it("fails a higher-is-better score that drops past tolerance", () => {
    const gate = (current: number) => frozenGate({
      current,
      baseline: 480,
      tolerance: 0,
      better: "higher",
      target: 720,
    });
    expect(gate(720)).toBe("ok");
    expect(gate(480)).toBe("ok");
    expect(gate(479)).toBe("fail");
  });

  it("passes an encoder delay below the frozen baseline", () => {
    const gate = (current: number) => frozenGate({
      current,
      baseline: 867,
      tolerance: 0,
      better: "lower",
      target: 400,
    });
    expect(gate(200)).toBe("ok");
    expect(gate(500)).toBe("ok");
    expect(gate(868)).toBe("fail");
  });

  it("exits 1 when git is not on PATH", () => {
    const bin = mkdtempSync(join(tmpdir(), "argus-nogit-"));
    dirs.push(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    const result = spawnSync(tsx, [script], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, PATH: bin },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("frozen-benchmarks: git is not on PATH\n");
  });

  it("exits 1 on a depth-1 clone", () => {
    for (const depth of ["1", "2"]) {
      const dir = mkdtempSync(join(tmpdir(), "argus-shallow-"));
      dirs.push(dir);
      const repo = join(dir, "repo");
      const cloned = spawnSync(
        "git",
        ["clone", "--depth", depth, `file://${root}`, repo],
        { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      );
      expect(cloned.status, cloned.stderr).toBe(0);
      copyFileSync(script, join(repo, "scripts", "frozen-benchmarks.ts"));
      symlinkSync(join(root, "node_modules"), join(repo, "node_modules"));
      const result = spawnSync(tsx, [join(repo, "scripts", "frozen-benchmarks.ts")], {
        cwd: repo,
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(
        /^frozen-benchmarks: a shallow clone cannot name the commit for (?:scripts\/fixtures\/field-latency\.txt|src\/homekit\.ts|src\/recording\.ts)\n$/,
      );
    }
  });

  it("prints the fixture baseline and exits 0 while every 2x target is still missed", () => {
    const result = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines.slice(0, 6).join("\n")).toBe(FROZEN_HEAD);
    expectLiveSsim(lines.find((line) => line.startsWith("live_ssim ")));
    expect(lines.find((line) => line.startsWith("recording_ssim "))).toBe(RECORDING_SSIM);
    const liveVmaf = lines.find((line) => line.startsWith("live_vmaf "));
    const recordingVmaf = lines.find((line) => line.startsWith("recording_vmaf "));
    if (ffmpegHasLibvmaf()) {
      expect(liveVmaf).toContain("baseline=unmeasured");
      expect(liveVmaf).toContain("gate=skip");
      expect(liveVmaf).toContain(`measured_sha=${liveSha}`);
      expect(recordingVmaf).toContain("baseline=unmeasured");
      expect(recordingVmaf).toContain("gate=skip");
      expect(recordingVmaf).toContain(`measured_sha=${recordingSha}`);
    } else {
      expect(liveVmaf).toBe(vmafSkip("live_vmaf", liveSha));
      expect(recordingVmaf).toBe(vmafSkip("recording_vmaf", recordingSha));
    }
    expect(lines).toHaveLength(12);
    expect(lines.find((line) => line.startsWith("recording_encoder_delay_t15 "))).toBe(
      encoderLine(15, 12, 26),
    );
    expect(lines.find((line) => line.startsWith("recording_encoder_delay_t6 "))).toBe(
      encoderLine(6, 12, 17),
    );
    expectNoField(result.stdout);
  }, 60_000);

  it("exits 0 when a log meets the 2x latency targets", () => {
    const path = writeLog([
      ...span("hksv_recording_start", "hksv_first_fragment", "streamId", [2650, 2650, 2650, 2650, 2650]),
      ...span("live_session_start", "live_session_first_frame", "sessionId", [600, 600, 600, 600, 600]),
    ]);
    const result = run(["--log", path]);
    expect(result.status).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines.find((line) => line.startsWith("hksv_first_fragment_p50 "))).toBe(
      metric("hksv_first_fragment_p50", "2650ms", "5300ms", "0ms", "<=2650ms", fixtureSha),
    );
    expect(lines.find((line) => line.startsWith("live_first_frame_p50 "))).toBe(
      metric("live_first_frame_p50", "600ms", "1281ms", "0ms", "<=650ms", fixtureSha),
    );
    expect(lines.find((line) => line.startsWith("live_first_frame_p95 "))).toBe(
      metric("live_first_frame_p95", "600ms", "4265ms", "0ms", "<=2100ms", fixtureSha),
    );
    expect(lines.find((line) => line.startsWith("live_starts_over_2_5s "))).toBe(
      metric("live_starts_over_2_5s", "0.0%", "28.4%", "0.05%", "<5%", fixtureSha),
    );
    expectNoField(result.stdout);
  }, 60_000);

  it("exits 0 when latency improves and still misses the 2x targets", () => {
    const live = [
      1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000,
      1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500,
      3000, 3000,
    ];
    const path = writeLog([
      ...span("hksv_recording_start", "hksv_first_fragment", "streamId", [4000, 4000, 4000]),
      ...span("live_session_start", "live_session_first_frame", "sessionId", live),
    ]);
    const result = run(["--log", path]);
    expect(result.status).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines.find((line) => line.startsWith("hksv_first_fragment_p50 "))).toBe(
      metric("hksv_first_fragment_p50", "4000ms", "5300ms", "0ms", "<=2650ms", fixtureSha),
    );
    expect(lines.find((line) => line.startsWith("live_first_frame_p50 "))).toBe(
      metric("live_first_frame_p50", "1000ms", "1281ms", "0ms", "<=650ms", fixtureSha),
    );
    expect(lines.find((line) => line.startsWith("live_first_frame_p95 "))).toBe(
      metric("live_first_frame_p95", "3000ms", "4265ms", "0ms", "<=2100ms", fixtureSha),
    );
    expect(lines.find((line) => line.startsWith("live_starts_over_2_5s "))).toBe(
      metric("live_starts_over_2_5s", "9.5%", "28.4%", "0.05%", "<5%", fixtureSha),
    );
    expectNoField(result.stdout);
  }, 60_000);

  it("exits 1 when latency is worse than the frozen baseline", () => {
    const path = writeLog([
      ...span("hksv_recording_start", "hksv_first_fragment", "streamId", [5300, 5300, 5300]),
      ...span("live_session_start", "live_session_first_frame", "sessionId", [2000, 2000, 2000]),
    ]);
    const result = run(["--log", path]);
    expect(result.status).toBe(1);
    const lines = result.stdout.split("\n");
    expect(lines.find((line) => line.startsWith("live_first_frame_p50 "))).toBe(
      `live_first_frame_p50 current=2000ms baseline=1281ms tolerance=0ms target=<=650ms source=fixture measured_sha=${fixtureSha} gate=fail`,
    );
    expect(lines.find((line) => line.startsWith("hksv_first_fragment_p50 "))).toBe(
      metric("hksv_first_fragment_p50", "5300ms", "5300ms", "0ms", "<=2650ms", fixtureSha),
    );
    expectLiveSsim(lines.find((line) => line.startsWith("live_ssim ")));
    expectNoField(result.stdout);
  }, 60_000);
});
