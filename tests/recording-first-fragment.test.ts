import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ARGUS_FIRMWARE_REVISION } from "../src/homekit.js";
import {
  ArgusRecordingDelegate,
  buildRecordingFfmpegArgs,
  buildRecordingOptions,
} from "../src/recording.js";

/*
Acceptance criteria:

- On realtime synthetic A/V, the median time from the recording spawn to the
  first media fragment is under 2000ms. The same input with a 4s first
  interval measured 4220ms.
- The next fragment still arrives about one negotiated 4000ms fragment later.
- Each of those fragments starts on an IDR, carries H.264 and AAC, and decodes.
- The offered fragment length stays 4000 and prebufferLength stays at least 4000.
- Firmware stays 1.3.16. A 4:3 1920x1080 recording still uses the pad filter.
- scripts/recording-first-fragment.mjs prints n, p50, and p90 for that metric
  and nothing from the log.
*/

const PAD_1920 =
  "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2";

function recordingConfig(resolution: [number, number, number] = [640, 360, 30]) {
  return {
    prebufferLength: 4000,
    eventTriggerTypes: [1],
    mediaContainerConfiguration: { type: 0, fragmentLength: 4000 },
    videoCodec: {
      type: 0,
      parameters: { profile: 2, level: 2, bitRate: 800, iFrameInterval: 4000 },
      resolution,
    },
    audioCodec: { type: 0, bitrate: 32, samplerate: 3, audioChannels: 1 },
  } as never;
}

function syntheticSpawn(bin: string, args: readonly string[], opts: Parameters<typeof spawn>[2]): ChildProcess {
  const at = args.indexOf("-rtsp_transport");
  if (at < 0) throw new Error("recording args have no rtsp input");
  const patched = [
    ...args.slice(0, at),
    "-re", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-re", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=32000",
    ...args.slice(at + 4),
  ];
  return spawn(bin, patched, opts);
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const low = sorted[lo];
  const high = sorted[hi];
  if (low === undefined || high === undefined) throw new Error("empty samples");
  if (lo === hi) return low;
  const weight = rank - lo;
  return low * (1 - weight) + high * weight;
}

interface Captured {
  firstMs: number;
  secondMs: number | undefined;
  init: Buffer;
  first: Buffer;
  second: Buffer | undefined;
}

async function capture(stopAt: 1 | 2): Promise<Captured> {
  const delegate = new ArgusRecordingDelegate("harness", "rtsp://unused", {
    spawnFn: syntheticSpawn as typeof spawn,
    verbose: false,
    aspect: "16:9",
  });
  delegate.updateRecordingConfiguration(recordingConfig());
  const started = performance.now();
  let init: Buffer | undefined;
  let first: Buffer | undefined;
  let second: Buffer | undefined;
  let firstMs = 0;
  let secondMs: number | undefined;
  for await (const packet of delegate.handleRecordingStreamRequest(1)) {
    const head = packet.data.toString("ascii", 4, 8);
    const elapsed = performance.now() - started;
    if (head === "ftyp" && init === undefined) init = packet.data;
    if (head === "moof" && first === undefined) {
      first = packet.data;
      firstMs = elapsed;
      if (stopAt === 1) break;
    } else if (head === "moof" && second === undefined) {
      second = packet.data;
      secondMs = elapsed;
      break;
    }
  }
  if (init === undefined || first === undefined) throw new Error("ffmpeg produced no media fragment");
  return { firstMs, secondMs, init, first, second };
}

function writeFragment(dir: string, name: string, init: Buffer, media: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([init, media]));
  return path;
}

function codecs(file: string): string[] {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_name",
    "-of", "compact",
    file,
  ], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().split("\n").map((line) => line.match(/codec_name=([^|\s]+)/)?.[1] ?? "");
}

function firstVideoFrame(file: string): { key: boolean; pts: number; pict: string } {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_frames",
    "-show_entries", "frame=key_frame,pict_type,best_effort_timestamp_time",
    "-of", "compact",
    file,
  ], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const line = result.stdout.trim().split("\n")[0] ?? "";
  const pts = Number(line.match(/best_effort_timestamp_time=([0-9.]+)/)?.[1]);
  return {
    key: line.includes("key_frame=1"),
    pts,
    pict: line.match(/pict_type=([A-Z])/)?.[1] ?? "",
  };
}

function decodes(file: string): void {
  const result = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

describe("recording first fragment", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("cuts spawn-to-first-fragment on synthetic input and keeps later fragments valid", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 4; i += 1) samples.push((await capture(1)).firstMs);
    const held = await capture(2);
    samples.push(held.firstMs);
    const median = percentile(samples, 50);
    expect(median).toBeGreaterThan(900);
    expect(median).toBeLessThan(2000);
    expect(held.secondMs).toBeDefined();
    const gap = (held.secondMs ?? 0) - held.firstMs;
    expect(gap).toBeGreaterThan(3500);
    expect(gap).toBeLessThan(4800);

    const directory = mkdtempSync(join(tmpdir(), "argus-first-fragment-"));
    directories.push(directory);
    const firstFile = writeFragment(directory, "first.mp4", held.init, held.first);
    const secondFile = writeFragment(directory, "second.mp4", held.init, held.second ?? Buffer.alloc(0));
    for (const file of [firstFile, secondFile]) {
      expect(codecs(file)).toEqual(["h264", "aac"]);
      const frame = firstVideoFrame(file);
      expect(frame.key).toBe(true);
      expect(frame.pict).toBe("I");
      decodes(file);
    }
    expect(firstVideoFrame(secondFile).pts).toBeGreaterThan(0.8);
    expect(firstVideoFrame(secondFile).pts).toBeLessThan(1.4);
  }, 40_000);

  it("leaves the recording offer, firmware, and 4:3 pad alone", () => {
    const options = buildRecordingOptions();
    expect(options.prebufferLength).toBeGreaterThanOrEqual(4000);
    const container = options.mediaContainerConfiguration;
    const fragmentLength = Array.isArray(container) ? container[0]?.fragmentLength : container.fragmentLength;
    expect(fragmentLength).toBe(4000);
    expect(ARGUS_FIRMWARE_REVISION).toBe("1.3.16");
    const args = buildRecordingFfmpegArgs(
      "rtsp://x/main",
      recordingConfig([1920, 1080, 30]),
      "4:3",
    );
    expect(args[args.indexOf("-vf") + 1]).toBe(PAD_1920);
    expect(args.join(" ")).toContain("expr:gte(t,if(eq(n_forced,0),0,1+(n_forced-1)*4))");
  });
});

function runScript(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["scripts/recording-first-fragment.mjs", ...args], {
    encoding: "utf8",
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("recording first fragment field script", () => {
  it("prints n, p50, and p90 and does not print the log", () => {
    const secret = "rtsp://admin:s3cret@10.9.8.7:554/main";
    const log = [
      `[argus] recording ${secret}`,
      "password=s3cret",
      'ARGUS_TIMING: {"stage":"recording_start","camera":"Yard","monoMs":0,"streamId":3}',
      'ARGUS_TIMING: {"stage":"recording_ffmpeg_spawn","camera":"Yard","monoMs":2,"streamId":3}',
      'ARGUS_TIMING: {"stage":"recording_first_fragment","camera":"Yard","monoMs":1000,"streamId":3}',
      'ARGUS_TIMING: {"stage":"recording_start","camera":"Yard","monoMs":10000,"streamId":3}',
      'ARGUS_TIMING: {"stage":"recording_ffmpeg_spawn","camera":"Yard","monoMs":10002,"streamId":3}',
      'ARGUS_TIMING: {"stage":"recording_first_fragment","camera":"Yard","monoMs":15000,"streamId":3}',
      'ARGUS_TIMING: {"stage":"recording_start","camera":"Yard","monoMs":20000,"streamId":3}',
      'ARGUS_TIMING: {"stage":"recording_ffmpeg_spawn","camera":"Yard","monoMs":20002,"streamId":3}',
      'ARGUS_TIMING: {"stage":"recording_first_fragment","camera":"Yard","monoMs":26000,"streamId":3}',
      "https://example.invalid/clip",
    ].join("\n");
    const directory = mkdtempSync(join(tmpdir(), "argus-fragment-log-"));
    const path = join(directory, "serve.err.log");
    writeFileSync(path, log);
    const result = runScript([path]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("recording_start_to_first_fragment n=3 p50=5000 p90=5800\n");
    expect(result.stdout).not.toContain("min=");
    expect(result.stdout).not.toContain("max=");
    expect(result.stdout).not.toContain("s3cret");
    expect(result.stdout).not.toContain("rtsp://");
    expect(result.stdout).not.toContain("10.9.8.7");
    expect(result.stdout).not.toContain("https://");
    expect(result.stdout).not.toContain("Yard");
    expect(result.stderr).toBe("");
    rmSync(directory, { recursive: true, force: true });
  });

  it("prints n=0 for an empty log and does not echo a missing path", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-fragment-empty-"));
    const path = join(directory, "serve.err.log");
    writeFileSync(path, "no timing here\nrtsp://user:pw@10.0.0.1/x\n");
    const empty = runScript([path]);
    expect(empty.status).toBe(0);
    expect(empty.stdout).toBe("recording_start_to_first_fragment n=0\n");
    expect(empty.stdout).not.toContain("10.0.0.1");
    const missing = runScript([join(directory, "missing.err.log")]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toBe("recording-first-fragment: cannot read log\n");
    expect(missing.stderr).not.toContain(directory);
    rmSync(directory, { recursive: true, force: true });
  });

  it("does not restart anything", () => {
    const source = readFileSync("scripts/recording-first-fragment.mjs", "utf8");
    expect(source).not.toMatch(/\bspawn\b|\blaunchctl\b|\breboot\b|\bkill\b/);
    expect(execFileSync("node", ["--check", "scripts/recording-first-fragment.mjs"], { encoding: "utf8" })).toBe("");
  });
});
