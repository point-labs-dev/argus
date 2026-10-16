import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const KEPT = [
  "README.md",
  "SPEC.md",
  "LEARNINGS.md",
  "PROJECT.md",
  "LATENCY.md",
  "TESTING.md",
  "TELEMETRY-QUICK-REF.md",
  "docs/camera-health.md",
  "docs/invariants.md",
  "progress/README.md",
  "scenarios/README.md",
];

const REMOVED = [
  "AUDIO-CODEC-BUG-POSTMORTEM.md",
  "AUDIO-CODEC-FIX-NOTES.md",
  "AV-SYNC-ARESAMPLE-FIX.md",
  "AV-SYNC-ASYNC-FIX.md",
  "AV-SYNC-FIX-FINAL.md",
  "AV-SYNC-FIX.md",
  "BASELINE-DECISION.md",
  "BASELINE-H264-FIX.md",
  "BIDIRECTIONAL-RTCP-FIX.md",
  "BITRATE-NEGOTIATION-FIX.md",
  "CHECKABLE-DONE.md",
  "DEPLOY-F22F0EB.md",
  "DEPLOY.md",
  "DEPLOYMENT-CHECKLIST.md",
  "DIMENSION-PAD-FIX.md",
  "FFMPEG-COMMAND-REFERENCE.md",
  "FIELD-DEPLOYMENT-NOTES.md",
  "FIELD-TEST-FIX-NOTES.md",
  "FIRMWARE-1.3.6-DIAGNOSIS.md",
  "FIRMWARE-CACHE-FIX.md",
  "FIX-SUMMARY.md",
  "IN-BAND-SPS-PPS-FIX.md",
  "LIBFDK-AAC-FIELD-FIX.md",
  "LIVE-FEED-FIX-SUMMARY.md",
  "MACOS-AAC-AT-FIX.md",
  "QA-VERIFICATION-1.3.14.md",
  "RTCP-FIX-COMPLETE.md",
  "RTCP-FIX-DEPLOYMENT.md",
  "RTCP-KEEPALIVE-FIX.md",
  "STARTUP-LATENCY-BASELINE.md",
  "STARTUP-LATENCY-DEPLOYMENT.md",
  "STARTUP-OPTIMIZATION-SUMMARY.md",
  "TASK-COMPLETE.md",
  "VALIDATION-STEPS.md",
  "VALIDATOR-CODEC-DIFFERENCE.md",
  "VIDEO-ONLY-INTERIM.md",
  "VIDEO-ONLY-PREPARESTREAM-FIX.md",
];

function invariantsProblems(source: string): string[] {
  const lineCount = source.endsWith("\n") ? source.split("\n").length - 1 : source.split("\n").length;
  const problems: string[] = [];
  if (lineCount >= 80) {
    problems.push("too long");
  }
  if (!source.includes("ARGUS_FIRMWARE_REVISION")) {
    problems.push("missing constant");
  }
  if (source.includes("ARGUS_FIRMWARE_REVISION =")) {
    problems.push("assigns a version");
  }
  if (!source.includes("live_session_first_frame") || !source.includes("not the painted picture")) {
    problems.push("missing picture rule");
  }
  return problems;
}

describe("stream setup invariants", () => {
  it("rejects a note that assigns a firmware version", () => {
    const sample = [
      "# Stream setup invariants",
      "",
      "Bump ARGUS_FIRMWARE_REVISION when the ladder changes.",
      'export const ARGUS_FIRMWARE_REVISION = "1.3.0";',
      "",
      "A live_session_first_frame log line is not the painted picture.",
      "",
    ].join("\n");
    expect(invariantsProblems(sample)).toContain("assigns a version");
  });

  it("accepts docs/invariants.md and keeps the durable notes", () => {
    const source = readFileSync("docs/invariants.md", "utf8");
    expect(invariantsProblems(source)).toEqual([]);
    for (const path of KEPT) {
      expect(existsSync(path), path).toBe(true);
    }
    for (const path of REMOVED) {
      expect(existsSync(path), path).toBe(false);
    }
  });
});
