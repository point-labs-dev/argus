import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
  `recording_picture current="1080p30 H.264 Baseline L4.0 2Mbps" baseline="1080p30 H.264 Baseline L4.0 2Mbps" tolerance=exact target="beyond 1080p30 H.264 Baseline 2Mbps" source=fixture measured_sha=${recordingSha} gate=ok`,
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

function expectNoField(stdout: string): void {
  expect(stdout).not.toContain("source=field");
  expect(stdout).not.toMatch(/srtp|unused|\d{3}-\d{2}-\d{3}/);
}

describe("frozen benchmarks", () => {
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
    expect(lines).toHaveLength(10);
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
