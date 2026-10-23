import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatStageReport } from "../src/timing.js";

/*
Acceptance criteria for scripts/notification-latency.mjs:

- Real-format ARGUS_TELEMETRY lines, in the JSON shape emitTelemetry writes,
  produce n greater than 0 for each metric those lines contain.
- A serve.log with no telemetry lines stays n=0.
- A path named serve.log reads the sibling serve.err.log when that file exists,
  because stderr is where ARGUS_TELEMETRY lines land.
- The report prints metric lines only. It does not repeat the log.
- ARGUS_TIMING marks still produce the same report as formatStageReport.
  A telemetry twin of a timing pair is not counted twice.
*/

const ZERO_REPORT = [
  "motion_to_motion_set n=0",
  "recording_start_to_first_fragment n=0",
  "prepare_stream_to_live_session_start n=0",
  "live_session_start_to_first_frame n=0",
  "prepare_stream_to_answered n=0",
  "live_session_start_to_ffmpeg_spawn n=0",
  "live_ffmpeg_spawn_to_first_frame n=0",
  "recording_start_to_ffmpeg_spawn n=0",
  "recording_ffmpeg_spawn_to_first_fragment n=0",
].join("\n") + "\n";

const TELEMETRY_REPORT = [
  "motion_to_motion_set n=1 min=40 p50=40 p90=40 max=40",
  "recording_start_to_first_fragment n=1 min=4000 p50=4000 p90=4000 max=4000",
  "prepare_stream_to_live_session_start n=0",
  "live_session_start_to_first_frame n=1 min=1160 p50=1160 p90=1160 max=1160",
  "prepare_stream_to_answered n=0",
  "live_session_start_to_ffmpeg_spawn n=0",
  "live_ffmpeg_spawn_to_first_frame n=0",
  "recording_start_to_ffmpeg_spawn n=0",
  "recording_ffmpeg_spawn_to_first_fragment n=0",
].join("\n") + "\n";

const CONTAINED_METRICS = [
  "motion_to_motion_set",
  "recording_start_to_first_fragment",
  "live_session_start_to_first_frame",
] as const;

function telemetryLine(
  timestamp: number,
  camera: string,
  event: string,
  metadata?: Record<string, unknown>,
): string {
  const entry: Record<string, unknown> = { timestamp, camera, event };
  if (metadata !== undefined) entry.metadata = metadata;
  return `ARGUS_TELEMETRY: ${JSON.stringify(entry)}`;
}

/** JSON shape from emitTelemetry. Fake ids only. */
function telemetryLog(): string {
  const camera = "Garage Door";
  return [
    "[argus Garage Door] motion DETECTED",
    telemetryLine(1_700_000_000_000, camera, "motion_detected"),
    telemetryLine(1_700_000_000_040, camera, "homekit_motion_updated", { detected: true }),
    telemetryLine(1_700_000_001_000, camera, "hksv_recording_start", {
      streamId: 7,
      resolution: [1920, 1080, 30],
    }),
    telemetryLine(1_700_000_001_100, camera, "hksv_first_fragment", { streamId: 9 }),
    telemetryLine(1_700_000_005_000, camera, "hksv_first_fragment", { streamId: 7 }),
    telemetryLine(1_700_000_010_000, camera, "live_session_start", {
      sessionId: "sess-1",
      width: 1280,
      height: 720,
      fps: 30,
    }),
    telemetryLine(1_700_000_010_100, camera, "live_session_first_frame", { sessionId: "sess-2" }),
    telemetryLine(1_700_000_011_160, camera, "live_session_first_frame", { sessionId: "sess-1" }),
    telemetryLine(1_700_000_040_000, camera, "homekit_motion_updated", { detected: false }),
    "ARGUS_TELEMETRY: this is not json",
  ].join("\n");
}

const STDOUT_LOG = [
  "[argus Garage Door] live mode: transcode",
  "[argus Garage Door] motion DETECTED",
  "Argus is live.",
].join("\n") + "\n";

function runScript(logPath: string): string {
  return execFileSync(process.execPath, ["scripts/notification-latency.mjs", logPath], {
    encoding: "utf8",
  });
}

function writeLog(directory: string, name: string, contents: string): string {
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

describe("notification latency log reader", () => {
  it("counts n greater than 0 for each metric present in real ARGUS_TELEMETRY lines", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-latency-"));
    const report = runScript(writeLog(directory, "excerpt.log", telemetryLog()));
    expect(report).toBe(TELEMETRY_REPORT);
    for (const id of CONTAINED_METRICS) {
      const line = report.split("\n").find((item) => item.startsWith(`${id} `));
      const count = Number(line?.match(/n=(\d+)/)?.[1]);
      expect(count).toBeGreaterThan(0);
    }
    expect(report).not.toContain("ARGUS_TELEMETRY");
    expect(report).not.toContain("sess-1");
    expect(report).not.toContain("Garage Door");
  });

  it("keeps every metric at n=0 for a serve.log with no telemetry lines", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-latency-"));
    const report = runScript(writeLog(directory, "serve.log", STDOUT_LOG));
    expect(report).toBe(ZERO_REPORT);
  });

  it("reads serve.err.log when given serve.log and the stderr log is present", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-latency-"));
    writeLog(directory, "serve.log", STDOUT_LOG);
    writeLog(directory, "serve.err.log", telemetryLog());
    const report = runScript(join(directory, "serve.log"));
    expect(report).toBe(TELEMETRY_REPORT);
    expect(runScript(join(directory, "serve.err.log"))).toBe(TELEMETRY_REPORT);
  });

  it("matches formatStageReport on ARGUS_TIMING lines and does not double count a telemetry twin", () => {
    const timing = [
      'ARGUS_TIMING: {"stage":"motion_detected","camera":"Garage Door","monoMs":1000}',
      'ARGUS_TIMING: {"stage":"motion_characteristic_set","camera":"Garage Door","monoMs":1008}',
      'ARGUS_TIMING: {"stage":"recording_start","camera":"Garage Door","monoMs":5000,"streamId":7}',
      'ARGUS_TIMING: {"stage":"recording_ffmpeg_spawn","camera":"Garage Door","monoMs":5005,"streamId":7}',
      'ARGUS_TIMING: {"stage":"recording_first_fragment","camera":"Garage Door","monoMs":9000,"streamId":7}',
      'ARGUS_TIMING: {"stage":"prepare_stream_enter","camera":"Garage Door","monoMs":10000,"sessionId":"s1"}',
      'ARGUS_TIMING: {"stage":"prepare_stream_answered","camera":"Garage Door","monoMs":10012,"sessionId":"s1"}',
      'ARGUS_TIMING: {"stage":"live_session_start","camera":"Garage Door","monoMs":10040,"sessionId":"s1"}',
      'ARGUS_TIMING: {"stage":"live_ffmpeg_spawn","camera":"Garage Door","monoMs":10055,"sessionId":"s1"}',
      'ARGUS_TIMING: {"stage":"live_first_frame","camera":"Garage Door","monoMs":11200,"sessionId":"s1"}',
    ].join("\n");
    const directory = mkdtempSync(join(tmpdir(), "argus-latency-"));
    expect(runScript(writeLog(directory, "timing.log", timing))).toBe(formatStageReport(timing));
    const mixed = `${timing}\n${telemetryLog()}`;
    expect(runScript(writeLog(directory, "mixed.log", mixed))).toBe(formatStageReport(mixed));
    expect(formatStageReport(mixed)).toContain("motion_to_motion_set n=1 min=8 p50=8 p90=8 max=8");
  });
});
