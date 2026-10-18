import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: (size: number) => Buffer.alloc(size, 0x2a),
  };
});

vi.mock("node:dgram", () => {
  const { EventEmitter: Emitter } = require("node:events") as typeof import("node:events");
  return {
    createSocket() {
      const socket = new Emitter();
      let port = 0;
      return Object.assign(socket, {
        bind(requested?: number, address?: unknown, done?: unknown) {
          const callback = typeof address === "function" ? address : typeof done === "function" ? done : undefined;
          const state = globalThis as { __argusFakePort?: number };
          const explicit = typeof requested === "number" ? requested : 0;
          if (explicit === 0) {
            const next = state.__argusFakePort ?? 40000;
            state.__argusFakePort = next + 1;
            port = next;
          } else {
            port = explicit;
          }
          if (typeof callback === "function") callback();
        },
        address() {
          return { port, address: "0.0.0.0", family: "IPv4" };
        },
        close(callback?: () => void) {
          socket.emit("close");
          if (callback) callback();
        },
      });
    },
  };
});

import { parseArgusConfig } from "../src/config.js";
import { createCameraAccessory } from "../src/homekit.js";
import { MotionMonitor, type MotionEdge } from "../src/motion.js";
import { SnapshotCache } from "../src/snapshot-cache.js";
import { formatSpanReport } from "../src/span-report.js";
import { SPAN_EVENTS } from "../src/telemetry.js";

const SENTINEL_PASSWORD = "s3cret-pass";
const SENTINEL_TOKEN = "s3cret-token";
const SENTINEL_HOST = "10.9.9.9";
const LIVE_URL = `rtsp://admin:${SENTINEL_PASSWORD}@${SENTINEL_HOST}/sub`;
const MAIN_URL = `rtsp://admin:${SENTINEL_PASSWORD}@${SENTINEL_HOST}/main`;

function mp4Box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function isSpanLine(line: string): boolean {
  return SPAN_EVENTS.some((event) => line.includes(`"event":"${event}"`));
}

function stripSpanLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isSpanLine(line))
    .join("\n");
}

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

interface FetchCall {
  cmd: string;
  channel: number | null;
}

function installFetch(mdState: () => number, aiAlarm: number): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const cmd = url.includes("cmd=") ? (url.split("cmd=")[1]?.split("&")[0] ?? "") : "";
    let channel: number | null = null;
    if (init?.body) {
      try {
        const parsed = JSON.parse(String(init.body)) as Array<{ param?: { channel?: number } }>;
        channel = parsed[0]?.param?.channel ?? null;
      } catch {
        channel = null;
      }
    }
    calls.push({ cmd, channel });
    if (cmd === "Login") {
      return jsonResponse([{ cmd: "Login", code: 0, value: { Token: { name: SENTINEL_TOKEN, leaseTime: 3600 } } }]);
    }
    if (cmd === "GetMdState") {
      return jsonResponse([{ cmd: "GetMdState", code: 0, value: { state: mdState() } }]);
    }
    if (cmd === "GetAiState") {
      if (aiAlarm < 0) {
        return jsonResponse([{ cmd: "GetAiState", code: 1, error: { detail: "not supported", rspCode: -99 } }]);
      }
      return jsonResponse([{
        cmd: "GetAiState",
        code: 0,
        value: { people: { alarm_state: aiAlarm, support: 1 }, vehicle: { alarm_state: 0 }, dog_cat: { alarm_state: 0 } },
      }]);
    }
    return jsonResponse([{ cmd, code: 1, error: { detail: "unknown" } }]);
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

function motionTo(
  setMotion: (detected: boolean, edge?: MotionEdge) => void,
): (cameraName: string, detected: boolean, edge?: MotionEdge) => void {
  return (_cameraName, detected, edge) => {
    if (edge) setMotion(detected, edge);
    else setMotion(detected);
  };
}

function camera(name: string, channel: number) {
  return {
    name,
    aspect: "4:3" as const,
    host: SENTINEL_HOST,
    channel,
    mainCodec: "h264" as const,
    username: "admin",
    password: SENTINEL_PASSWORD,
    transport: "auto" as const,
    streams: { main: "main", sub: "sub" },
  };
}

function configFor(cameras: ReturnType<typeof camera>[]) {
  return parseArgusConfig({
    cameras,
    recording: { path: "./rec", retention: { continuous: 3, motion: 7, alerts: 30 } },
    homekit: { pin: "123-45-678" },
    go2rtc: { binary: "./go2rtc", api_port: 1984 },
    server: { port: 8080 },
  });
}

function describeLeg(leg: { port: number; ssrc: number; srtp_key: Buffer; srtp_salt: Buffer } | undefined) {
  if (!leg) return null;
  return {
    port: leg.port,
    ssrc: leg.ssrc,
    srtp_key: Buffer.from(leg.srtp_key).toString("base64"),
    srtp_salt: Buffer.from(leg.srtp_salt).toString("base64"),
  };
}

async function runScenario(): Promise<{
  stderr: string;
  stripped: string;
  spanLines: string[];
  liveArgs: string[];
  recordingArgs: string[];
  hap: unknown;
  packets: Array<{ bytes: number; isLast: boolean }>;
  fetchCalls: FetchCall[];
}> {
  (globalThis as { __argusFakePort?: number }).__argusFakePort = 40000;
  const writes: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;

  const nvrMd = { state: 1 };
  const nvrFetch = installFetch(() => nvrMd.state, -1);
  const directFetch = installFetch(() => 0, 1);
  const nvrConfig = configFor([camera("Front L", 2)]);
  const directConfig = configFor([camera("Garage Door", 0)]);
  const cache = new SnapshotCache(directConfig, {
    fetch: (async () => {
      throw new Error("snapshot fetch is out of bounds");
    }) as typeof fetch,
  });
  const stderr = new PassThrough();
  const stdout = new PassThrough();
  let spawnCount = 0;
  const spawnFn = vi.fn(() => {
    spawnCount += 1;
    const proc = Object.assign(new EventEmitter(), {
      stderr: spawnCount === 1 ? stderr : new PassThrough(),
      stdout: spawnCount === 2 ? stdout : undefined,
      kill: vi.fn(),
    });
    return proc;
  }) as unknown as typeof import("node:child_process").spawn;

  try {
    const nvrAccessory = createCameraAccessory(nvrConfig.cameras[0]!, LIVE_URL, MAIN_URL, cache, {
      spawnFn,
      verbose: true,
    });
    const directAccessory = createCameraAccessory(directConfig.cameras[0]!, LIVE_URL, MAIN_URL, cache, {
      spawnFn,
      verbose: true,
    });
    const nvrMonitor = new MotionMonitor(nvrConfig.cameras, motionTo(nvrAccessory.setMotion), {
      fetch: nvrFetch.fetch,
      now: () => Date.now(),
      cooldownMs: 30_000,
    });
    const directMonitor = new MotionMonitor(directConfig.cameras, motionTo(directAccessory.setMotion), {
      fetch: directFetch.fetch,
      now: () => Date.now(),
      cooldownMs: 30_000,
    });

    await nvrMonitor.pollOnce();
    await vi.advanceTimersByTimeAsync(40_000);
    nvrMd.state = 0;
    await nvrMonitor.pollOnce();
    await directMonitor.pollOnce();

    const delegate = directAccessory.delegate;
    let hap: { video: ReturnType<typeof describeLeg>; audio: ReturnType<typeof describeLeg> } | undefined;
    await new Promise<void>((resolve, reject) => {
      delegate.prepareStream(
        {
          sessionID: "sess-1",
          targetAddress: "192.0.2.10",
          video: { port: 50000, srtp_key: Buffer.alloc(16, 0x11), srtp_salt: Buffer.alloc(14, 0x22) },
          audio: { port: 50002, srtp_key: Buffer.alloc(16, 0x33), srtp_salt: Buffer.alloc(14, 0x44) },
        } as never,
        (error, response) => {
          if (error || !response) {
            reject(error ?? new Error("prepare failed"));
            return;
          }
          const body = response as {
            video: { port: number; ssrc: number; srtp_key: Buffer; srtp_salt: Buffer };
            audio?: { port: number; ssrc: number; srtp_key: Buffer; srtp_salt: Buffer };
          };
          hap = { video: describeLeg(body.video), audio: describeLeg(body.audio) };
          resolve();
        },
      );
    });

    let ackedAt: number | null = null;
    const started = new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(
        {
          type: "start",
          sessionID: "sess-1",
          video: { pt: 99, max_bit_rate: 299, fps: 30, width: 640, height: 480, mtu: 1378, profile: 0, level: 2 },
          audio: { pt: 110, sample_rate: 24, max_bit_rate: 24, codec: 3 },
        } as never,
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          ackedAt = Date.now();
          resolve();
        },
      );
    });
    const startRequestedAt = Date.now();
    expect(ackedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(99);
    expect(ackedAt).toBeNull();
    stderr.write("frame=1\n");
    await vi.advanceTimersByTimeAsync(1);
    await started;
    expect(ackedAt).toBe(startRequestedAt + 100);
    delegate.handleStreamRequest({ type: "stop", sessionID: "sess-1" } as never, () => {});

    const recording = directAccessory.recordingDelegate;
    recording.updateRecordingConfiguration({
      prebufferLength: 4000,
      eventTriggerTypes: [1],
      mediaContainerConfiguration: { type: 0, fragmentLength: 4000 },
      videoCodec: {
        type: 0,
        parameters: { profile: 2, level: 2, bitRate: 2000, iFrameInterval: 4000 },
        resolution: [1280, 720, 30],
      },
      audioCodec: { type: 0, bitrate: 64, samplerate: 3, audioChannels: 1 },
    } as never);
    const packets: Array<{ bytes: number; isLast: boolean }> = [];
    const generator = recording.handleRecordingStreamRequest(7);
    stdout.write(mp4Box("ftyp", Buffer.from("isom")));
    stdout.write(mp4Box("moov", Buffer.from("moovdata")));
    const init = await generator.next();
    if (!init.done && init.value) packets.push({ bytes: init.value.data.length, isLast: init.value.isLast });
    await vi.advanceTimersByTimeAsync(15);
    stdout.write(mp4Box("moof", Buffer.from("moof1")));
    stdout.write(mp4Box("mdat", Buffer.from("mediadata1")));
    const first = await generator.next();
    if (!first.done && first.value) packets.push({ bytes: first.value.data.length, isLast: first.value.isLast });
    await vi.advanceTimersByTimeAsync(25);
    stdout.write(mp4Box("moof", Buffer.from("moof2")));
    stdout.write(mp4Box("mdat", Buffer.from("mediadata2")));
    const second = await generator.next();
    if (!second.done && second.value) packets.push({ bytes: second.value.data.length, isLast: second.value.isLast });
    await generator.return(undefined);
    recording.closeRecordingStream(7, undefined);

    const calls = (spawnFn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls;
    const stderrText = writes.join("");
    const spanLines = stderrText.split("\n").filter((line) => isSpanLine(line));
    return {
      stderr: stderrText,
      stripped: stripSpanLines(stderrText),
      spanLines,
      liveArgs: calls[0]?.[1] ?? [],
      recordingArgs: calls[1]?.[1] ?? [],
      hap,
      packets,
      fetchCalls: [...nvrFetch.calls, ...directFetch.calls],
    };
  } finally {
    process.stderr.write = originalWrite;
  }
}

describe("span telemetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("diffs ffmpeg args and logs against main and allows only span telemetry lines", async () => {
    vi.useFakeTimers({
      now: Date.parse("2026-10-18T00:00:00.000Z"),
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    const result = await runScenario();
    expect({
      stripped: result.stripped,
      liveArgs: result.liveArgs,
      recordingArgs: result.recordingArgs,
      hap: result.hap,
      packets: result.packets,
      fetchCalls: result.fetchCalls,
    }).toEqual(MAIN_BEHAVIOR);
    expect(result.spanLines.map((line) => JSON.parse(line.slice("ARGUS_TELEMETRY: ".length)).event)).toEqual([
      "motion_source",
      "motion_characteristic_set",
      "motion_source",
      "motion_characteristic_set",
      "live_prepare_stream",
      "live_start_stream",
      "live_ffmpeg_spawn",
      "live_first_frame",
      "live_start_ack",
      "hksv_span_start",
      "hksv_span_first_fragment",
      "hksv_span_fragment",
      "hksv_span_fragment",
      "hksv_span_close",
    ]);
    const spanText = result.spanLines.join("\n");
    expect(spanText.split(SENTINEL_PASSWORD).length - 1).toBe(0);
    expect(spanText.split(SENTINEL_TOKEN).length - 1).toBe(0);
    expect(spanText.split(SENTINEL_HOST).length - 1).toBe(0);
    expect(spanText).not.toContain("rtsp://");
    const parsed = result.spanLines.map((line) => JSON.parse(line.slice("ARGUS_TELEMETRY: ".length)) as {
      timestamp: number;
      camera: string;
      monoMs: number;
      event: string;
      motionId?: string;
      sessionId?: string;
      streamId?: number;
      metadata?: { durationMs?: number; size?: number; via?: string };
    });
    for (const event of parsed) {
      expect(event.monoMs).not.toBe(event.timestamp);
      expect(event.monoMs).toBeLessThan(1_000_000);
    }
    const byEvent = (name: string) => parsed.find((event) => event.event === name);
    const sources = parsed.filter((event) => event.event === "motion_source");
    const sets = parsed.filter((event) => event.event === "motion_characteristic_set");
    expect(sources.map((event) => ({ camera: event.camera, via: event.metadata?.via }))).toEqual([
      { camera: "Front L", via: "md" },
      { camera: "Garage Door", via: "ai" },
    ]);
    expect(sets.map((event) => ({ camera: event.camera, motionId: event.motionId, via: event.metadata?.via }))).toEqual(
      sources.map((event) => ({ camera: event.camera, motionId: event.motionId, via: event.metadata?.via })),
    );
    expect(new Set(sources.map((event) => event.motionId)).size).toBe(2);
    expect(spanText).not.toContain("motion_nvr_");
    expect(spanText).not.toContain("motion_direct_");
    expect(spanText).not.toContain('"via":"nvr"');
    expect(spanText).not.toContain('"via":"direct"');
    expect(result.fetchCalls.filter((call) => call.cmd === "GetMdState").map((call) => call.channel)).toEqual([2, 2, 0]);
    expect(result.fetchCalls.filter((call) => call.cmd === "GetAiState").map((call) => call.channel)).toEqual([2, 0]);
    for (const name of ["live_prepare_stream", "live_start_stream", "live_ffmpeg_spawn", "live_first_frame", "live_start_ack"]) {
      expect(byEvent(name)?.sessionId).toBe("sess-1");
    }
    for (const name of ["hksv_span_start", "hksv_span_first_fragment", "hksv_span_close"]) {
      expect(byEvent(name)?.streamId).toBe(7);
    }
    expect(parsed.filter((event) => event.event === "hksv_span_fragment").map((event) => event.metadata)).toEqual([
      { durationMs: 15, size: 31 },
      { durationMs: 25, size: 31 },
    ]);
    expect(formatSpanReport(result.stderr)).toBe([
      "motion_source_to_characteristic_set n=2 p50=0 p95=0",
      "live_prepare_stream_to_start_stream n=1 p50=0 p95=0",
      "live_start_stream_to_ffmpeg_spawn n=1 p50=0 p95=0",
      "live_ffmpeg_spawn_to_first_frame n=1 p50=99 p95=99",
      "live_first_frame_to_start_ack n=1 p50=1 p95=1",
      "hksv_start_to_first_fragment n=1 p50=15 p95=15",
      "hksv_first_fragment_to_close n=1 p50=25 p95=25",
      "hksv_fragment_duration n=2 p50=20 p95=24.5",
    ].join("\n") + "\n");
    expect(formatSpanReport(result.stderr)).not.toContain(SENTINEL_PASSWORD);
    expect(formatSpanReport(result.stderr)).not.toContain(SENTINEL_HOST);
  });

  it("prints n=0 and drops a sentinel from a log excerpt", () => {
    const log = [
      `ARGUS_TELEMETRY: {"timestamp":1,"camera":"Front L","event":"motion_detected","url":"rtsp://admin:${SENTINEL_PASSWORD}@${SENTINEL_HOST}/main"}`,
      "noise",
    ].join("\n");
    const report = formatSpanReport(log);
    expect(report).toBe([
      "motion_source_to_characteristic_set n=0",
      "live_prepare_stream_to_start_stream n=0",
      "live_start_stream_to_ffmpeg_spawn n=0",
      "live_ffmpeg_spawn_to_first_frame n=0",
      "live_first_frame_to_start_ack n=0",
      "hksv_start_to_first_fragment n=0",
      "hksv_first_fragment_to_close n=0",
      "hksv_fragment_duration n=0",
    ].join("\n") + "\n");
    expect(report).not.toContain(SENTINEL_PASSWORD);
    expect(report).not.toContain(SENTINEL_HOST);
  });
});

const MAIN_BEHAVIOR: {
  stripped: string;
  liveArgs: string[];
  recordingArgs: string[];
  hap: unknown;
  packets: Array<{ bytes: number; isLast: boolean }>;
  fetchCalls: FetchCall[];
} = JSON.parse(readFileSync(new URL("./fixtures/span-main-behavior.json", import.meta.url), "utf8"));
