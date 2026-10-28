import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", ".bin", "tsx");
const script = join(root, "scripts", "frozen-benchmarks.ts");
const sha = "eb1ede5e7922b57f5381a77b111050a0bde4fc4e";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function field(id: string, current: string, baseline: string, tolerance: string, target: string): string {
  return `${id} current=${current} baseline=${baseline} tolerance=${tolerance} target=${target} source=field measured_sha=${sha} gate=ok`;
}

const FROZEN_BODY = [
  field("hksv_first_fragment_p50", "5300ms", "5300ms", "0ms", "<=2650ms"),
  field("live_first_frame_p50", "1281ms", "1281ms", "0ms", "<=650ms"),
  field("live_first_frame_p95", "4265ms", "4265ms", "0ms", "<=2100ms"),
  field("live_starts_over_2_5s", "28.4%", "28.4%", "0.05%", "<5%"),
  field("live_picture_height", "480p", "480p", "0p", ">=720p"),
  `recording_picture current="1080p30 H.264 Baseline L4.0 2Mbps" baseline="1080p30 H.264 Baseline L4.0 2Mbps" tolerance=exact target="beyond 1080p30 H.264 Baseline 2Mbps" source=field measured_sha=${sha} gate=ok`,
  `live_ssim current=0.981368 baseline=0.981368 tolerance=0.002 target=0.989476@1280x720 source=fixture measured_sha=${sha} gate=ok`,
  `recording_ssim current=0.985117 baseline=0.985117 tolerance=0.002 target="beyond 1080p30 H.264 Baseline 2Mbps" source=fixture measured_sha=${sha} gate=ok`,
].join("\n");

const VMAF_SKIP = (id: string) =>
  `${id} current=skip baseline=unmeasured tolerance=skip target=unmeasured source=skip measured_sha=${sha} gate=skip reason="ffmpeg has no libvmaf"`;

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

describe("frozen benchmarks", () => {
  it("prints current, baseline, and target, and exits 0 while every 2x target is still missed", () => {
    const result = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines.slice(0, 8).join("\n")).toBe(FROZEN_BODY);
    const liveVmaf = lines.find((line) => line.startsWith("live_vmaf "));
    const recordingVmaf = lines.find((line) => line.startsWith("recording_vmaf "));
    if (ffmpegHasLibvmaf()) {
      expect(liveVmaf).toContain("baseline=unmeasured");
      expect(liveVmaf).toContain("gate=skip");
      expect(recordingVmaf).toContain("baseline=unmeasured");
      expect(recordingVmaf).toContain("gate=skip");
    } else {
      expect(liveVmaf).toBe(VMAF_SKIP("live_vmaf"));
      expect(recordingVmaf).toBe(VMAF_SKIP("recording_vmaf"));
    }
    expect(lines).toHaveLength(10);
    expect(result.stdout).not.toMatch(/srtp|unused|\d{3}-\d{2}-\d{3}/);
  }, 60_000);

  it("exits 1 when a log moves a frozen latency past its tolerance", () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-bench-log-"));
    dirs.push(dir);
    const path = join(dir, "shifted.log");
    let timestamp = 1;
    const lines: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      lines.push(telemetry("hksv_recording_start", timestamp, { streamId: index }));
      timestamp += 5300;
      lines.push(telemetry("hksv_first_fragment", timestamp, { streamId: index }));
      timestamp += 1;
    }
    for (let index = 0; index < 3; index += 1) {
      lines.push(telemetry("live_session_start", timestamp, { sessionId: `b${index}` }));
      timestamp += 2000;
      lines.push(telemetry("live_session_first_frame", timestamp, { sessionId: `b${index}` }));
      timestamp += 1;
    }
    writeFileSync(path, `${lines.join("\n")}\n`);

    const result = run(["--log", path]);
    expect(result.status).toBe(1);
    const live = result.stdout.split("\n").find((line) => line.startsWith("live_first_frame_p50 "));
    const recording = result.stdout.split("\n").find((line) => line.startsWith("hksv_first_fragment_p50 "));
    const ssim = result.stdout.split("\n").find((line) => line.startsWith("live_ssim "));
    expect(live).toBe(
      `live_first_frame_p50 current=2000ms baseline=1281ms tolerance=0ms target=<=650ms source=field measured_sha=${sha} gate=fail`,
    );
    expect(recording).toBe(
      `hksv_first_fragment_p50 current=5300ms baseline=5300ms tolerance=0ms target=<=2650ms source=field measured_sha=${sha} gate=ok`,
    );
    expect(ssim).toBe(
      `live_ssim current=0.981368 baseline=0.981368 tolerance=0.002 target=0.989476@1280x720 source=fixture measured_sha=${sha} gate=ok`,
    );
    expect(result.stdout).not.toMatch(/srtp|\d{3}-\d{2}-\d{3}/);
  }, 60_000);
});
