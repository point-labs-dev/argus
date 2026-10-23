import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CHURN = "6117635239cb0e5bdcbd877160fe877967a1d99e";
const JUSTIFIED = "2312c702ccedb8d0587fff0bebe3f269765143b6";
const LADDER_BEFORE = "96174fd3a6839b67eaa266c2a2c03b88d9a95f32";
const LADDER_AFTER = "87fe4edf22e25a9f15b17ae705bcdd7b98901944";

function census(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("node", ["scripts/firmware-census.mjs", ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function show(spec: string): string {
  return execFileSync("git", ["show", spec], { encoding: "utf8" });
}

function censusSource(
  firmware: string,
  patch: { samplerate?: string; aac?: string; opus?: string; profiles?: string; count?: string } = {},
): string {
  const samplerate = patch.samplerate ?? "KHZ_24";
  const aac = patch.aac ?? "AAC_ELD";
  const opus = patch.opus ?? "OPUS";
  const profiles = patch.profiles ?? "BASELINE";
  const count = patch.count ?? "2";
  return [
    "export function buildCameraControllerOptions() {",
    `  samplerate: AudioStreamingSamplerate.${samplerate},`,
    `  AudioStreamingCodecType.${aac},`,
    `  AudioStreamingCodecType.${opus},`,
    `  profiles: [${profiles}],`,
    `  cameraStreamCount: ${count},`,
    "}",
    `export const ARGUS_FIRMWARE_REVISION = "${firmware}";`,
    "",
  ].join("\n");
}

describe("firmware census", () => {
  it("fails the firmware-only bump from 1.3.6 to 1.3.7", () => {
    const result = census(["--commit", CHURN]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("verdict=churn");
    expect(result.stdout).toContain("before_firmware=1.3.6");
    expect(result.stdout).toContain("after_firmware=1.3.7");
  });

  it("passes the profile-list change from 1.3.0 to 1.3.1", () => {
    const result = census(["--commit", JUSTIFIED]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("verdict=justified");
    expect(result.stdout).toContain("before_firmware=1.3.0");
    expect(result.stdout).toContain("after_firmware=1.3.1");
  });

  it("passes the ladder change from 1.3.15 to 1.3.16", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-census-"));
    const before = join(directory, "before.ts");
    const after = join(directory, "after.ts");
    writeFileSync(before, show(`${LADDER_BEFORE}:src/homekit.ts`));
    writeFileSync(after, show(`${LADDER_AFTER}:src/homekit.ts`));
    const result = census(["--before", before, "--after", after]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("verdict=justified");
  });

  it("fails a scratch firmware bump and passes a scratch ladder edit", () => {
    const source = readFileSync("src/homekit.ts", "utf8");
    const directory = mkdtempSync(join(tmpdir(), "argus-census-scratch-"));
    const before = join(directory, "before.ts");
    const churn = join(directory, "churn.ts");
    const ladder = join(directory, "ladder.ts");
    writeFileSync(before, source);
    writeFileSync(
      churn,
      source.replace(
        'export const ARGUS_FIRMWARE_REVISION = "1.3.16"',
        'export const ARGUS_FIRMWARE_REVISION = "1.3.17"',
      ),
    );
    writeFileSync(ladder, readFileSync(churn, "utf8").replace("[854, 480, 30]", "[854, 450, 30]"));

    const churnResult = census(["--before", before, "--after", churn]);
    expect(churnResult.status).toBe(1);
    expect(churnResult.stdout).toContain("verdict=churn");

    const ladderResult = census(["--before", before, "--after", ladder]);
    expect(ladderResult.status).toBe(0);
    expect(ladderResult.stdout).toContain("verdict=justified");
  });

  it("treats codec, profile, and stream-count edits as a real ladder change", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-census-keys-"));
    const before = join(directory, "before.ts");
    writeFileSync(before, censusSource("1.3.16"));
    const cases = [
      ["samplerate", censusSource("1.3.17", { samplerate: "KHZ_16" })],
      ["AAC_ELD", censusSource("1.3.17", { aac: "AAC_LC" })],
      ["OPUS", censusSource("1.3.17", { opus: "MP3" })],
      ["profiles", censusSource("1.3.17", { profiles: "MAIN" })],
      ["cameraStreamCount", censusSource("1.3.17", { count: "1" })],
    ] as const;
    for (const [name, afterSource] of cases) {
      const after = join(directory, `${name}.ts`);
      writeFileSync(after, afterSource);
      const result = census(["--before", before, "--after", after]);
      expect(result.status, name).toBe(0);
      expect(result.stdout, name).toContain("verdict=justified");
    }
    const churn = join(directory, "churn.ts");
    writeFileSync(churn, censusSource("1.3.17"));
    const churnResult = census(["--before", before, "--after", churn]);
    expect(churnResult.status).toBe(1);
    expect(churnResult.stdout).toContain("verdict=churn");
  });

  it("passes when the working tree firmware matches the base", () => {
    const result = census([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("verdict=unchanged");
    expect(result.stdout).toContain("before_firmware=1.3.16");
    expect(result.stdout).toContain("after_firmware=1.3.16");
    expect(result.stderr).not.toContain("warning:");
  });

  it("fails when the advertised ladder changes and the firmware string stays 1.3.16", () => {
    const source = readFileSync("src/homekit.ts", "utf8");
    const directory = mkdtempSync(join(tmpdir(), "argus-census-stale-"));
    const before = join(directory, "before.ts");
    const after = join(directory, "after.ts");
    const changed = source.replace("[854, 480, 30]", "[854, 450, 30]");
    writeFileSync(before, source);
    writeFileSync(after, changed);
    expect(changed).toContain('export const ARGUS_FIRMWARE_REVISION = "1.3.16"');

    const result = census(["--before", before, "--after", after]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("verdict=stale");
    expect(result.stdout).toContain("before_firmware=1.3.16");
    expect(result.stdout).toContain("after_firmware=1.3.16");
    expect(result.stderr).not.toContain("warning:");
  });

  it("fails a rename inside buildCameraControllerOptions when the firmware string stays 1.3.16", () => {
    const source = readFileSync("src/homekit.ts", "utf8");
    const directory = mkdtempSync(join(tmpdir(), "argus-census-rename-"));
    const before = join(directory, "before.ts");
    const after = join(directory, "after.ts");
    const renamed = source.replaceAll("wifiSet", "lanSet");
    writeFileSync(before, source);
    writeFileSync(after, renamed);
    expect(renamed).toContain("lanSet");
    expect(renamed).toContain('export const ARGUS_FIRMWARE_REVISION = "1.3.16"');

    const result = census(["--before", before, "--after", after]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("verdict=stale");
    expect(result.stdout).toContain("before_firmware=1.3.16");
    expect(result.stdout).toContain("after_firmware=1.3.16");
  });

  it("warns and exits zero when only the recording offer changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-census-recording-"));
    const before = join(directory, "before.ts");
    const after = join(directory, "after.ts");
    const beforeRecording = join(directory, "before-recording.ts");
    const afterRecording = join(directory, "after-recording.ts");
    const homekit = readFileSync("src/homekit.ts", "utf8");
    const recording = readFileSync("src/recording.ts", "utf8");
    const offered = recording.replace("fragmentLength: 4000", "fragmentLength: 2000");
    writeFileSync(before, homekit);
    writeFileSync(after, homekit);
    writeFileSync(beforeRecording, recording);
    writeFileSync(afterRecording, offered);
    expect(homekit).toContain('export const ARGUS_FIRMWARE_REVISION = "1.3.16"');
    expect(offered).toContain("fragmentLength: 2000");

    const quiet = census([
      "--before",
      before,
      "--after",
      after,
      "--before-recording",
      beforeRecording,
      "--after-recording",
      beforeRecording,
    ]);
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toContain("verdict=unchanged");
    expect(quiet.stderr).not.toContain("warning:");

    const result = census([
      "--before",
      before,
      "--after",
      after,
      "--before-recording",
      beforeRecording,
      "--after-recording",
      afterRecording,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("verdict=unchanged");
    expect(result.stdout).toContain("before_firmware=1.3.16");
    expect(result.stdout).toContain("after_firmware=1.3.16");
    expect(result.stderr).toContain(
      "warning: recording offer changed in src/recording.ts. A recording-offer change is not a live-ladder change.",
    );
  });

  it("exits zero without a warning when recording.ts changes outside the offer", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-census-recording-filter-"));
    const before = join(directory, "before.ts");
    const after = join(directory, "after.ts");
    const beforeRecording = join(directory, "before-recording.ts");
    const afterRecording = join(directory, "after-recording.ts");
    const homekit = readFileSync("src/homekit.ts", "utf8");
    const recording = readFileSync("src/recording.ts", "utf8");
    const outside = recording.replace(
      "return `scale=${width}:${height}`;",
      "return `scale=${width}:${height}:flags=neighbor`;",
    );
    writeFileSync(before, homekit);
    writeFileSync(after, homekit);
    writeFileSync(beforeRecording, recording);
    writeFileSync(afterRecording, outside);
    expect(outside).toContain("flags=neighbor");

    const result = census([
      "--before",
      before,
      "--after",
      after,
      "--before-recording",
      beforeRecording,
      "--after-recording",
      afterRecording,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("verdict=unchanged");
    expect(result.stderr).not.toContain("warning:");
  });

  it("fails a ladder change at 1.3.16 when the recording offer also changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-census-both-"));
    const before = join(directory, "before.ts");
    const after = join(directory, "after.ts");
    const beforeRecording = join(directory, "before-recording.ts");
    const afterRecording = join(directory, "after-recording.ts");
    const homekit = readFileSync("src/homekit.ts", "utf8");
    const recording = readFileSync("src/recording.ts", "utf8");
    writeFileSync(before, homekit);
    writeFileSync(after, homekit.replace("[854, 480, 30]", "[854, 450, 30]"));
    writeFileSync(beforeRecording, recording);
    writeFileSync(afterRecording, recording.replace("fragmentLength: 4000", "fragmentLength: 2000"));

    const result = census([
      "--before",
      before,
      "--after",
      after,
      "--before-recording",
      beforeRecording,
      "--after-recording",
      afterRecording,
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("verdict=stale");
    expect(result.stdout).toContain("before_firmware=1.3.16");
    expect(result.stdout).toContain("after_firmware=1.3.16");
    expect(result.stderr).toContain("warning: recording offer changed in src/recording.ts");
  });
});
