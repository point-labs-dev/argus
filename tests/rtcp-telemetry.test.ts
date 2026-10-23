/**
 * Acceptance criteria for RTCP after the first frame.
 *
 * 1. After live_session_first_frame on the start spawn, stop writes one
 *    rtcp_after_first_frame telemetry event. videoPackets equals the RTCP
 *    packets on the video socket after that frame. audioPackets equals the
 *    RTCP packets on the audio socket after that frame. Packets that arrived
 *    before the frame are excluded. videoLastAt and audioLastAt are the epoch
 *    milliseconds of the last counted packet on that socket, or null when the
 *    count is zero.
 * 2. The reconfigure spawn writes the same event with spawn "reconfigure" and
 *    the packet counts after that spawn's own first frame.
 * 3. A session that reaches a first frame and then receives no RTCP records
 *    videoPackets 0, audioPackets 0, videoLastAt null, and audioLastAt null.
 * 4. The first packet on a socket still logs one "RTCP arrived" line. Later
 *    packets do not log that line again. Every packet still emits "packet".
 * 5. The abandon timer stays 900000 ms. Firmware stays 1.3.16. A counted
 *    packet does not stop ffmpeg. Stop still uses SIGKILL.
 * 6. scripts/rtcp-counts.mjs prints log=missing and exits 1 when the log
 *    path is absent. That output does not contain events=0. When the file
 *    exists and has no rtcp_after_first_frame lines, the script exits 0 and
 *    prints events=0. The summary ends with leaked_sessions. Each
 *    live_session_first_frame opens one window for its session id. Each
 *    rtcp_after_first_frame closes one. leaked_sessions is the number still
 *    open. A non-integer videoPackets or audioPackets adds 0. leaked_sessions
 *    of 0 exits 0. leaked_sessions above 0 exits 2.
 * 7. After START is answered, an ffmpeg exit with code 1 and no signal, and
 *    no STOP request, calls forceStopStreamingSession once, writes one
 *    rtcp_after_first_frame line, and does not kill the process. A later
 *    STOP does not kill the process or call forceStop again.
 */
import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { parseArgusConfig } from "../src/config.js";
import {
  ARGUS_FIRMWARE_REVISION,
  ArgusStreamingDelegate,
  NO_RTCP_CONSUMER_ABANDON_MS,
} from "../src/homekit.js";
import { ObservableRtcpSocket, type RtcpPacketEvent } from "../src/homekit/observable-rtcp.js";
import { SnapshotCache } from "../src/snapshot-cache.js";

const METADATA_KEYS = [
  "audioLastAt",
  "audioPackets",
  "sessionId",
  "spawn",
  "videoLastAt",
  "videoPackets",
];

interface RtcpReport {
  camera: string;
  sessionId: string;
  spawn: string;
  videoPackets: number;
  audioPackets: number;
  videoLastAt: number | null;
  audioLastAt: number | null;
}

interface FakeProc {
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

interface Started {
  delegate: ArgusStreamingDelegate;
  procs: Array<EventEmitter & FakeProc>;
  videoPort: number;
  audioPort: number;
  sessionID: string;
}

function cacheWith(jpeg: Buffer): SnapshotCache {
  const config = parseArgusConfig({
    cameras: [{
      name: "Garage Door",
      aspect: "16:9",
      host: "10.0.0.5",
      channel: 0,
      mainCodec: "h265",
      username: "admin",
      password: "x",
      transport: "auto",
      streams: { main: "main", sub: "sub" },
    }],
    recording: { path: "./rec", retention: { continuous: 3, motion: 7, alerts: 30 } },
    homekit: { pin: "123-45-678" },
    go2rtc: { binary: "./go2rtc", api_port: 1984 },
    server: { port: 8080 },
  });
  const fetchFn = (async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength),
  })) as unknown as typeof fetch;
  return new SnapshotCache(config, { fetch: fetchFn });
}

function rtcpReports(log: string): RtcpReport[] {
  const reports: RtcpReport[] = [];
  for (const line of log.split("\n")) {
    const json = line.match(/ARGUS_TELEMETRY: (.+)$/)?.[1];
    if (!json) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as { event?: unknown; camera?: unknown; metadata?: unknown };
    if (record.event !== "rtcp_after_first_frame") continue;
    if (typeof record.metadata !== "object" || record.metadata === null) continue;
    const metadata = record.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual(METADATA_KEYS);
    const videoLastAt = metadata["videoLastAt"];
    const audioLastAt = metadata["audioLastAt"];
    reports.push({
      camera: String(record.camera),
      sessionId: String(metadata["sessionId"]),
      spawn: String(metadata["spawn"]),
      videoPackets: Number(metadata["videoPackets"]),
      audioPackets: Number(metadata["audioPackets"]),
      videoLastAt: typeof videoLastAt === "number" ? videoLastAt : null,
      audioLastAt: typeof audioLastAt === "number" ? audioLastAt : null,
    });
  }
  return reports;
}

async function capture(run: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return writes.join("");
}

async function sendRtcp(port: number, times: number): Promise<void> {
  const sender = createSocket("udp4");
  try {
    for (let i = 0; i < times; i += 1) {
      await new Promise<void>((resolve, reject) => {
        sender.send(Buffer.from([0x80, 0xc9, 0x00, 0x01]), port, "127.0.0.1", (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
    for (let i = 0; i < 25; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    sender.close();
  }
}

function emitFrame(proc: EventEmitter & FakeProc): void {
  proc.stderr.write("frame=1\n");
}

async function startLive(sessionID: string): Promise<Started> {
  const procs: Array<EventEmitter & FakeProc> = [];
  const spawnFn = vi.fn(() => {
    const proc = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    procs.push(proc);
    return proc;
  }) as unknown as typeof import("node:child_process").spawn;
  const delegate = new ArgusStreamingDelegate(
    "Garage Door",
    "rtsp://127.0.0.1:8554/garage-sub",
    cacheWith(Buffer.from([0xff, 0xd8])),
    { aspect: "16:9", spawnFn, verbose: false },
  );
  let videoPort = 0;
  let audioPort = 0;
  await new Promise<void>((resolve, reject) => {
    delegate.prepareStream(
      {
        sessionID,
        targetAddress: "192.0.2.10",
        video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
        audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) },
      } as never,
      (error, response) => {
        if (error || !response) {
          reject(error ?? new Error("prepare failed"));
          return;
        }
        const body = response as { video: { port: number }; audio?: { port: number } };
        videoPort = body.video.port;
        audioPort = body.audio?.port ?? 0;
        resolve();
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    delegate.handleStreamRequest(
      {
        type: "start",
        sessionID,
        video: { pt: 99, max_bit_rate: 600, fps: 30, width: 854, height: 480, mtu: 1378, profile: 2, level: 2 },
        audio: { pt: 110, sample_rate: 24, max_bit_rate: 24, codec: 3 },
      } as never,
      (error) => (error ? reject(error) : resolve()),
    );
  });
  const proc = procs[0];
  if (!proc || videoPort === 0 || audioPort === 0) {
    throw new Error("live session did not bind return ports");
  }
  return { delegate, procs, videoPort, audioPort, sessionID };
}

function stop(delegate: ArgusStreamingDelegate, sessionID: string): void {
  delegate.handleStreamRequest({ type: "stop", sessionID } as never, () => {});
}

function expectLast(packets: number, lastAt: number | null): void {
  if (packets === 0) {
    expect(lastAt).toBeNull();
    return;
  }
  expect(lastAt).toEqual(expect.any(Number));
  expect(Number.isFinite(lastAt)).toBe(true);
  expect(lastAt).toBeGreaterThan(0);
}

describe("RTCP after the first frame", () => {
  it("keeps the abandon timer and firmware where they are", () => {
    expect(NO_RTCP_CONSUMER_ABANDON_MS).toBe(15 * 60 * 1000);
    expect(ARGUS_FIRMWARE_REVISION).toBe("1.3.16");
  });

  it("logs the first packet once and emits every packet", () => {
    const socket = new EventEmitter();
    const logs: string[] = [];
    const packets: RtcpPacketEvent[] = [];
    const rtcp = new ObservableRtcpSocket(socket as never, "video", (msg) => logs.push(msg));
    rtcp.on("packet", (event: RtcpPacketEvent) => packets.push(event));
    socket.emit("message", Buffer.from([0x80, 0xc9, 0x00, 0x01]));
    socket.emit("message", Buffer.from([0x80, 0xc9, 0x00, 0x01, 0x00]));
    expect(logs).toEqual(["RTCP arrived on video return port (4 bytes)"]);
    expect(packets.map((event) => event.size)).toEqual([4, 5]);
    expect(rtcp.packetsSeen()).toBe(2);
    expect(rtcp.lastPacketAt()).toEqual(expect.any(Number));
    expect(rtcp.socketLabel()).toBe("video");
  });

  it("counts packets after the first frame on the start spawn", async () => {
    const log = await capture(async () => {
      const started = await startLive("start-packets");
      try {
        await sendRtcp(started.videoPort, 1);
        emitFrame(started.procs[0]!);
        await sendRtcp(started.videoPort, 2);
        await sendRtcp(started.audioPort, 1);
        expect(started.procs[0]!.kill).not.toHaveBeenCalled();
        stop(started.delegate, started.sessionID);
        expect(started.procs[0]!.kill).toHaveBeenCalledTimes(1);
        expect(started.procs[0]!.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        stop(started.delegate, started.sessionID);
      }
    });

    const reports = rtcpReports(log);
    expect(reports).toEqual([
      expect.objectContaining({
        camera: "Garage Door",
        sessionId: "start-packets",
        spawn: "start",
        videoPackets: 2,
        audioPackets: 1,
      }),
    ]);
    expectLast(reports[0]!.videoPackets, reports[0]!.videoLastAt);
    expectLast(reports[0]!.audioPackets, reports[0]!.audioLastAt);
  });

  it("counts packets after the first frame on the reconfigure spawn", async () => {
    const log = await capture(async () => {
      const started = await startLive("reconfigure-packets");
      try {
        emitFrame(started.procs[0]!);
        await sendRtcp(started.videoPort, 1);
        await new Promise<void>((resolve, reject) => {
          started.delegate.handleStreamRequest(
            {
              type: "reconfigure",
              sessionID: started.sessionID,
              video: { width: 1280, height: 720, fps: 30, max_bit_rate: 2000, rtcp_interval: 0.5 },
            } as never,
            (error) => (error ? reject(error) : resolve()),
          );
        });
        const respawned = started.procs[1];
        if (!respawned) throw new Error("reconfigure did not spawn ffmpeg");
        emitFrame(respawned);
        await sendRtcp(started.videoPort, 2);
        await sendRtcp(started.audioPort, 1);
        expect(started.procs[0]!.kill).toHaveBeenCalledWith("SIGKILL");
        expect(respawned.kill).not.toHaveBeenCalled();
        stop(started.delegate, started.sessionID);
        expect(respawned.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        stop(started.delegate, started.sessionID);
      }
    });

    const reports = rtcpReports(log);
    expect(reports.map((report) => ({
      camera: report.camera,
      sessionId: report.sessionId,
      spawn: report.spawn,
      videoPackets: report.videoPackets,
      audioPackets: report.audioPackets,
    }))).toEqual([
      {
        camera: "Garage Door",
        sessionId: "reconfigure-packets",
        spawn: "start",
        videoPackets: 1,
        audioPackets: 0,
      },
      {
        camera: "Garage Door",
        sessionId: "reconfigure-packets",
        spawn: "reconfigure",
        videoPackets: 2,
        audioPackets: 1,
      },
    ]);
    expectLast(reports[0]!.videoPackets, reports[0]!.videoLastAt);
    expectLast(reports[0]!.audioPackets, reports[0]!.audioLastAt);
    expectLast(reports[1]!.videoPackets, reports[1]!.videoLastAt);
    expectLast(reports[1]!.audioPackets, reports[1]!.audioLastAt);
  });

  it("records zero when no RTCP arrives after the first frame", async () => {
    const log = await capture(async () => {
      const started = await startLive("start-quiet");
      try {
        await sendRtcp(started.videoPort, 1);
        await sendRtcp(started.audioPort, 1);
        emitFrame(started.procs[0]!);
        expect(started.procs[0]!.kill).not.toHaveBeenCalled();
        stop(started.delegate, started.sessionID);
      } finally {
        stop(started.delegate, started.sessionID);
      }
    });

    expect(rtcpReports(log)).toEqual([
      {
        camera: "Garage Door",
        sessionId: "start-quiet",
        spawn: "start",
        videoPackets: 0,
        audioPackets: 0,
        videoLastAt: null,
        audioLastAt: null,
      },
    ]);
  });

  it("tells a missing log apart from a log with zero RTCP events", () => {
    const missing = runCounts([join(mkdtempSync(join(tmpdir(), "argus-rtcp-missing-")), "serve.err.log")]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("log=missing\n");
    expect(missing.stdout).not.toContain("events=0");

    const directory = mkdtempSync(join(tmpdir(), "argus-rtcp-"));
    const empty = join(directory, "serve.err.log");
    writeFileSync(empty, [
      "noise rtsp://admin:s3cret@10.9.9.9/main",
      'ARGUS_TELEMETRY: {"timestamp":1,"camera":"Garage Door","event":"live_session_stop","metadata":{"sessionId":"s"}}',
      "",
    ].join("\n"));
    const quiet = runCounts([empty]);
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe([
      "events=0",
      "start_events=0",
      "reconfigure_events=0",
      "video_packets=0",
      "audio_packets=0",
      "zero_events=0",
      "leaked_sessions=0",
      "",
    ].join("\n"));
    expect(quiet.stdout).not.toContain("s3cret");
    expect(quiet.stdout).not.toContain("rtsp://");
    expect(quiet.stdout).not.toContain("10.9.9.9");

    const counted = join(directory, "counted.log");
    writeFileSync(counted, [
      'ARGUS_TELEMETRY: {"event":"rtcp_after_first_frame","metadata":{"spawn":"start","videoPackets":2,"audioPackets":0}}',
      'ARGUS_TELEMETRY: {"event":"rtcp_after_first_frame","metadata":{"spawn":"reconfigure","videoPackets":0,"audioPackets":0}}',
      'ARGUS_TELEMETRY: {"event":"rtcp_after_first_frame","metadata":{"spawn":"reconfigure","videoPackets":1,"audioPackets":3}}',
      "",
    ].join("\n"));
    expect(runCounts([counted]).stdout).toBe([
      "events=3",
      "start_events=1",
      "reconfigure_events=2",
      "video_packets=3",
      "audio_packets=3",
      "zero_events=1",
      "leaked_sessions=0",
      "",
    ].join("\n"));
  });

  it("counts only integers and shows an open RTCP window as a leak", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-rtcp-leak-"));
    const log = join(directory, "serve.err.log");
    writeFileSync(log, [
      "noise rtsp://admin:s3cret@10.9.9.9/main",
      'ARGUS_TELEMETRY: {"event":"live_session_first_frame","metadata":{"sessionId":"s1"}}',
      'ARGUS_TELEMETRY: {"event":"live_session_first_frame","metadata":{"sessionId":"s1"}}',
      'ARGUS_TELEMETRY: {"event":"rtcp_after_first_frame","metadata":{"spawn":"start","sessionId":"s1","videoPackets":1.5,"audioPackets":"4"}}',
      'ARGUS_TELEMETRY: {"event":"live_session_first_frame","metadata":{"sessionId":"s2"}}',
      'ARGUS_TELEMETRY: {"event":"rtcp_after_first_frame","metadata":{"spawn":"reconfigure","sessionId":"s2","videoPackets":2,"audioPackets":1}}',
      'ARGUS_TELEMETRY: {"event":"live_session_first_frame","metadata":{"sessionId":"s3"}}',
      "",
    ].join("\n"));
    const counted = runCounts([log]);
    expect(counted.status).toBe(2);
    expect(counted.stdout).toBe([
      "events=2",
      "start_events=1",
      "reconfigure_events=1",
      "video_packets=2",
      "audio_packets=1",
      "zero_events=1",
      "leaked_sessions=2",
      "",
    ].join("\n"));
    expect(counted.stdout).not.toContain("s3cret");
    expect(counted.stdout).not.toContain("rtsp://");
    expect(counted.stdout).not.toContain("10.9.9.9");
    expect(counted.stdout).not.toContain("s1");
    expect(counted.stdout).not.toContain("s2");
    expect(counted.stdout).not.toContain("s3");
  });

  it("exits 2 when a session leaks and 0 when every window is closed", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-rtcp-gate-"));
    const leaky = join(directory, "leaky.log");
    writeFileSync(leaky, [
      'ARGUS_TELEMETRY: {"event":"live_session_first_frame","metadata":{"sessionId":"open"}}',
      "",
    ].join("\n"));
    const leaked = runCounts([leaky]);
    expect(leaked.status).toBe(2);
    expect(leaked.stdout).toContain("leaked_sessions=1\n");

    const clean = join(directory, "clean.log");
    writeFileSync(clean, [
      'ARGUS_TELEMETRY: {"event":"live_session_first_frame","metadata":{"sessionId":"closed"}}',
      'ARGUS_TELEMETRY: {"event":"rtcp_after_first_frame","metadata":{"spawn":"start","sessionId":"closed","videoPackets":1,"audioPackets":0}}',
      "",
    ].join("\n"));
    const closed = runCounts([clean]);
    expect(closed.status).toBe(0);
    expect(closed.stdout).toContain("leaked_sessions=0\n");
    expect(closed.stdout).not.toContain("closed");
    expect(leaked.stdout).not.toContain("open");
  });

  it("calls forceStop when ffmpeg exits and nobody sent STOP", async () => {
    const forceStop = vi.fn();
    const started = await startLive("exit-no-stop");
    started.delegate.controller = { forceStopStreamingSession: forceStop } as never;
    try {
      emitFrame(started.procs[0]!);
      expect(forceStop).not.toHaveBeenCalled();
      expect(started.procs[0]!.kill).not.toHaveBeenCalled();
      const log = await capture(async () => {
        started.procs[0]!.emit("exit", 1, null);
        stop(started.delegate, started.sessionID);
      });
      expect(forceStop).toHaveBeenCalledTimes(1);
      expect(forceStop).toHaveBeenCalledWith("exit-no-stop");
      expect(started.procs[0]!.kill).not.toHaveBeenCalled();
      expect(rtcpReports(log)).toEqual([
        {
          camera: "Garage Door",
          sessionId: "exit-no-stop",
          spawn: "start",
          videoPackets: 0,
          audioPackets: 0,
          videoLastAt: null,
          audioLastAt: null,
        },
      ]);
    } finally {
      stop(started.delegate, started.sessionID);
    }
  });
});

function runCounts(args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, ["scripts/rtcp-counts.mjs", ...args], { encoding: "utf8" });
    return { status: 0, stdout };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string };
    return { status: failed.status ?? 1, stdout: failed.stdout ?? "" };
  }
}
