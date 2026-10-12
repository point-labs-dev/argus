import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { parseArgusConfig } from "../src/config.js";
import { ArgusStreamingDelegate, createCameraAccessory } from "../src/homekit.js";
import { MotionMonitor } from "../src/motion.js";
import { ArgusRecordingDelegate } from "../src/recording.js";
import { SnapshotCache } from "../src/snapshot-cache.js";
import { emitTiming, formatStageReport } from "../src/timing.js";

function captureTiming(run: () => void | Promise<void>): Promise<string> {
  const writes: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  return Promise.resolve(run()).finally(() => {
    process.stderr.write = original;
  }).then(() => writes.filter((line) => line.includes("ARGUS_TIMING:")).join(""));
}

function mp4Box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

const FIXTURE = `
noise before
ARGUS_TIMING: {"stage":"motion_detected","camera":"Garage Door","monoMs":1000}
ARGUS_TIMING: {"stage":"motion_characteristic_set","camera":"Garage Door","monoMs":1010}
ARGUS_TIMING: {"stage":"motion_detected","camera":"Garage Door","monoMs":2000}
ARGUS_TIMING: {"stage":"motion_characteristic_set","camera":"Garage Door","monoMs":2020}
ARGUS_TIMING: {"stage":"motion_detected","camera":"Garage Door","monoMs":3000}
ARGUS_TIMING: {"stage":"motion_characteristic_set","camera":"Garage Door","monoMs":3040}
ARGUS_TIMING: {"stage":"motion_detected","camera":"Garage Door","monoMs":4000}
ARGUS_TIMING: {"stage":"motion_characteristic_set","camera":"Garage Door","monoMs":4080}
ARGUS_TIMING: {"stage":"recording_start","camera":"Garage Door","monoMs":5000,"streamId":7}
ARGUS_TIMING: {"stage":"recording_ffmpeg_spawn","camera":"Garage Door","monoMs":5005,"streamId":7}
ARGUS_TIMING: {"stage":"recording_first_fragment","camera":"Garage Door","monoMs":9000,"streamId":7}
ARGUS_TIMING: {"stage":"prepare_stream_enter","camera":"Garage Door","monoMs":10000,"sessionId":"s1"}
ARGUS_TIMING: {"stage":"prepare_stream_answered","camera":"Garage Door","monoMs":10012,"sessionId":"s1"}
ARGUS_TIMING: {"stage":"live_session_start","camera":"Garage Door","monoMs":10040,"sessionId":"s1"}
ARGUS_TIMING: {"stage":"live_ffmpeg_spawn","camera":"Garage Door","monoMs":10055,"sessionId":"s1"}
ARGUS_TIMING: {"stage":"live_first_frame","camera":"Garage Door","monoMs":11200,"sessionId":"s1"}
ARGUS_TIMING: {"stage":"motion_detected","camera":"Garage Door","monoMs":1,"url":"rtsp://admin:s3cret-pass@10.0.0.8/main","srtp_key":"AAAA"}
ARGUS_TIMING: {"stage":"motion_characteristic_set","camera":"Garage Door","monoMs":9}
`.trim();

const EXPECTED_REPORT = [
  "motion_to_motion_set n=5 min=8 p50=20 p90=64 max=80",
  "recording_start_to_first_fragment n=1 min=4000 p50=4000 p90=4000 max=4000",
  "prepare_stream_to_live_session_start n=1 min=40 p50=40 p90=40 max=40",
  "live_session_start_to_first_frame n=1 min=1160 p50=1160 p90=1160 max=1160",
  "prepare_stream_to_answered n=1 min=12 p50=12 p90=12 max=12",
  "live_session_start_to_ffmpeg_spawn n=1 min=15 p50=15 p90=15 max=15",
  "live_ffmpeg_spawn_to_first_frame n=1 min=1145 p50=1145 p90=1145 max=1145",
  "recording_start_to_ffmpeg_spawn n=1 min=5 p50=5 p90=5 max=5",
  "recording_ffmpeg_spawn_to_first_fragment n=1 min=3995 p50=3995 p90=3995 max=3995",
].join("\n") + "\n";

describe("formatStageReport", () => {
  it("prints per-stage percentiles and drops secrets from the log", () => {
    const report = formatStageReport(FIXTURE);
    expect(report).toBe(EXPECTED_REPORT);
    expect(report).not.toContain("s3cret-pass");
    expect(report).not.toContain("rtsp");
    expect(report).not.toContain("srtp");
    expect(report).not.toContain("AAAA");
  });

  it("prints n=0 for every stage when the log has no timing marks", () => {
    expect(formatStageReport("no telemetry here\n")).toBe(
      [
        "motion_to_motion_set n=0",
        "recording_start_to_first_fragment n=0",
        "prepare_stream_to_live_session_start n=0",
        "live_session_start_to_first_frame n=0",
        "prepare_stream_to_answered n=0",
        "live_session_start_to_ffmpeg_spawn n=0",
        "live_ffmpeg_spawn_to_first_frame n=0",
        "recording_start_to_ffmpeg_spawn n=0",
        "recording_ffmpeg_spawn_to_first_fragment n=0",
      ].join("\n") + "\n",
    );
  });

  it("does not pair a motion set on a different camera", () => {
    const log = [
      'ARGUS_TIMING: {"stage":"motion_detected","camera":"Garage Door","monoMs":0}',
      'ARGUS_TIMING: {"stage":"motion_characteristic_set","camera":"Backyard","monoMs":20}',
      'ARGUS_TIMING: {"stage":"motion_characteristic_set","camera":"Garage Door","monoMs":35}',
    ].join("\n");
    expect(formatStageReport(log)).toContain("motion_to_motion_set n=1 min=35 p50=35 p90=35 max=35");
  });

  it("does not pair across a backwards monotonic clock", () => {
    const log = [
      'ARGUS_TIMING: {"stage":"motion_detected","camera":"Garage Door","monoMs":50}',
      'ARGUS_TIMING: {"stage":"motion_characteristic_set","camera":"Garage Door","monoMs":10}',
      'ARGUS_TIMING: {"stage":"motion_characteristic_set","camera":"Garage Door","monoMs":90}',
    ].join("\n");
    expect(formatStageReport(log)).toContain("motion_to_motion_set n=0");
  });

  it("does not pair prepareStream with a live start from another session", () => {
    const log = [
      'ARGUS_TIMING: {"stage":"prepare_stream_enter","camera":"Garage Door","monoMs":10,"sessionId":"s1"}',
      'ARGUS_TIMING: {"stage":"live_session_start","camera":"Garage Door","monoMs":80,"sessionId":"s2"}',
    ].join("\n");
    expect(formatStageReport(log)).toContain("prepare_stream_to_live_session_start n=0");
  });
});

describe("emitTiming", () => {
  it("writes a monotonic mark with only stage, camera, and monoMs", () => {
    const writes: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      emitTiming({ stage: "motion_detected", camera: "Garage Door" }, () => 42);
    } finally {
      process.stderr.write = original;
    }
    expect(writes).toEqual([
      'ARGUS_TIMING: {"stage":"motion_detected","camera":"Garage Door","monoMs":42}\n',
    ]);
  });

  it("writes streamId on a recording mark and sessionId on a live mark", () => {
    const writes: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      emitTiming({ stage: "recording_start", camera: "Garage Door", streamId: 7 }, () => 3);
      emitTiming({ stage: "live_session_start", camera: "Garage Door", sessionId: "s1" }, () => 9);
    } finally {
      process.stderr.write = original;
    }
    expect(writes).toEqual([
      'ARGUS_TIMING: {"stage":"recording_start","camera":"Garage Door","monoMs":3,"streamId":7}\n',
      'ARGUS_TIMING: {"stage":"live_session_start","camera":"Garage Door","monoMs":9,"sessionId":"s1"}\n',
    ]);
  });
});

describe("timing call sites", () => {
  it("marks the motion poll edge and the characteristic set, and omits the camera password", async () => {
    const config = parseArgusConfig({
      cameras: [{
        name: "Garage Door",
        host: "10.0.0.7",
        channel: 0,
        mainCodec: "h264",
        username: "admin",
        password: "s3cret-pass",
        transport: "auto",
        streams: { main: "main", sub: "sub" },
      }],
      recording: { path: "./rec", retention: { continuous: 3, motion: 7, alerts: 30 } },
      homekit: { pin: "123-45-678" },
      go2rtc: { binary: "./go2rtc", api_port: 1984 },
      server: { port: 8080 },
    });
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("cmd=Login")) {
        return { ok: true, status: 200, json: async () => [{ cmd: "Login", code: 0, value: { Token: { name: "tok", leaseTime: 3600 } } }] };
      }
      return { ok: true, status: 200, json: async () => [{ cmd: "GetMdState", code: 0, value: { state: 1 } }] };
    }) as unknown as typeof fetch;
    const cache = new SnapshotCache(config, {
      fetch: (async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8]).buffer,
      })) as unknown as typeof fetch,
    });
    const { setMotion } = createCameraAccessory(
      config.cameras[0]!,
      "rtsp://127.0.0.1:8554/garage-door-sub",
      "rtsp://admin:s3cret-pass@10.0.0.8/main",
      cache,
    );
    const monitor = new MotionMonitor(config.cameras, (_name, detected) => {
      if (detected) setMotion(true);
    }, { fetch: fetchFn, now: () => 0 });

    const text = await captureTiming(() => monitor.pollOnce());
    expect(text).not.toContain("s3cret-pass");
    expect(text).not.toContain("rtsp");
    const stages = [...text.matchAll(/"stage":"([^"]+)"/g)].map((match) => match[1]);
    expect(stages).toEqual(["motion_detected", "motion_characteristic_set"]);
  });

  it("marks recording start, ffmpeg spawn, and the first fragment without the stream url", async () => {
    const stdout = new PassThrough();
    const fakeProc = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const spawnFn = vi.fn(() => fakeProc) as unknown as typeof import("node:child_process").spawn;
    const delegate = new ArgusRecordingDelegate("Garage Door", "rtsp://admin:s3cret-pass@10.0.0.8/main", {
      spawnFn,
      verbose: false,
    });
    delegate.updateRecordingConfiguration({
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

    const text = await captureTiming(async () => {
      const generator = delegate.handleRecordingStreamRequest(7);
      stdout.write(mp4Box("ftyp", Buffer.from("isom")));
      stdout.write(mp4Box("moov", Buffer.from("moovdata")));
      await generator.next();
      stdout.write(mp4Box("moof", Buffer.from("moof1")));
      stdout.write(mp4Box("mdat", Buffer.from("mediadata1")));
      await generator.next();
      await generator.return(undefined);
    });

    expect(text).not.toContain("s3cret-pass");
    expect(text).not.toContain("rtsp");
    const stages = [...text.matchAll(/"stage":"([^"]+)"/g)].map((match) => match[1]);
    expect(stages).toEqual(["recording_start", "recording_ffmpeg_spawn", "recording_first_fragment"]);
    expect(text).toContain('"streamId":7');
  });

  it("marks prepareStream, the answered callback, live start, ffmpeg spawn, and the first frame", async () => {
    const stderr = new PassThrough();
    const fakeProc = Object.assign(new EventEmitter(), { stderr, kill: vi.fn() });
    const spawnFn = vi.fn(() => fakeProc) as unknown as typeof import("node:child_process").spawn;
    const config = parseArgusConfig({
      cameras: [{
        name: "Garage Door",
        host: "10.0.0.7",
        channel: 0,
        mainCodec: "h264",
        username: "admin",
        password: "s3cret-pass",
        transport: "auto",
        streams: { main: "main", sub: "sub" },
      }],
      recording: { path: "./rec", retention: { continuous: 3, motion: 7, alerts: 30 } },
      homekit: { pin: "123-45-678" },
      go2rtc: { binary: "./go2rtc", api_port: 1984 },
      server: { port: 8080 },
    });
    const cache = new SnapshotCache(config, {
      fetch: (async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8]).buffer,
      })) as unknown as typeof fetch,
    });
    const delegate = new ArgusStreamingDelegate(
      "Garage Door",
      "rtsp://admin:s3cret-pass@10.0.0.8/sub",
      cache,
      { spawnFn, verbose: false },
    );

    const text = await captureTiming(async () => {
      await new Promise<void>((resolve, reject) => {
        delegate.prepareStream(
          {
            sessionID: "s1",
            targetAddress: "192.168.1.50",
            video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
            audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) },
          } as never,
          (error) => (error ? reject(error) : resolve()),
        );
      });
      const started = new Promise<void>((resolve, reject) => {
        delegate.handleStreamRequest(
          {
            type: "start",
            sessionID: "s1",
            video: { pt: 99, max_bit_rate: 299, fps: 30, width: 1280, height: 720, mtu: 1378, profile: 2, level: 2 },
            audio: { pt: 110, sample_rate: 24, max_bit_rate: 24, codec: 3 },
          } as never,
          (error) => (error ? reject(error) : resolve()),
        );
      });
      stderr.write("frame=1\n");
      await started;
    });

    expect(text).not.toContain("s3cret-pass");
    expect(text).not.toContain("rtsp");
    expect(text).not.toContain("srtp");
    const stages = [...text.matchAll(/"stage":"([^"]+)"/g)].map((match) => match[1]);
    expect(stages).toEqual([
      "prepare_stream_enter",
      "prepare_stream_answered",
      "live_session_start",
      "live_ffmpeg_spawn",
      "live_first_frame",
    ]);
    for (const line of text.split("\n").filter((line) => line.startsWith("ARGUS_TIMING:"))) {
      const mark = JSON.parse(line.slice("ARGUS_TIMING: ".length)) as { sessionId?: string };
      expect(mark.sessionId).toBe("s1");
    }
  });
});
