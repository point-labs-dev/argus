/**
 * Acceptance criteria for live session teardown.
 *
 * 1. STOP, an ffmpeg exit, the abandon timer, and forceStop each tear a
 *    session down. Whichever arrives first does the work. The later three
 *    leave the kill count and the forceStop count unchanged.
 * 2. The first event closes the RTCP window. A packet that arrives after
 *    that event stays out of rtcp_after_first_frame.
 * 3. STOP kills a running ffmpeg with SIGKILL and does not call forceStop.
 *    An exit with code 1 and no signal does not kill ffmpeg and calls
 *    forceStop once. The abandon timer and an external forceStop each kill
 *    a running ffmpeg and call forceStop once.
 * 4. An exit with code 0 does not call forceStop. An exit with SIGKILL does
 *    not call forceStop. Both close the window once.
 * 5. The reconfigure spawn uses the same exit rule. Its code 1 exit calls
 *    forceStop once. Its code 0 exit and its SIGKILL exit do not. The
 *    encoder replaced by reconfigure is killed once with SIGKILL, and that
 *    exit does not call forceStop or close the new spawn's window.
 * 6. prepareStream for an id that is still streaming tears the old session
 *    down once, does not call forceStop, and answers the new prepare.
 */
import { createSocket } from "node:dgram";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseArgusConfig } from "../src/config.js";
import { ArgusStreamingDelegate, NO_RTCP_CONSUMER_ABANDON_MS } from "../src/homekit.js";
import { SnapshotCache } from "../src/snapshot-cache.js";

const TEARDOWN_EVENTS = ["stop", "exit", "abandon", "forceStop"] as const;

type TeardownEvent = (typeof TEARDOWN_EVENTS)[number];

interface Proc extends EventEmitter {
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

interface Live {
  delegate: ArgusStreamingDelegate;
  procs: Proc[];
  videoPort: number;
  audioPort: number;
  sessionID: string;
  forceStop: ReturnType<typeof vi.fn>;
}

interface RtcpReport {
  sessionId: string;
  spawn: string;
  videoPackets: number;
  audioPackets: number;
}

function cache(): SnapshotCache {
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
  const jpeg = Buffer.from([0xff, 0xd8]);
  const fetchFn = (async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength),
  })) as unknown as typeof fetch;
  return new SnapshotCache(config, { fetch: fetchFn });
}

function permutations(events: readonly TeardownEvent[]): TeardownEvent[][] {
  if (events.length === 0) return [[]];
  return events.flatMap((event, index) => {
    const rest = [...events.slice(0, index), ...events.slice(index + 1)];
    return permutations(rest).map((order) => [event, ...order]);
  });
}

function expectedCalls(first: TeardownEvent): { kill: number; forceStop: number } {
  if (first === "stop") return { kill: 1, forceStop: 0 };
  if (first === "exit") return { kill: 0, forceStop: 1 };
  return { kill: 1, forceStop: 1 };
}

function prepareRequest(sessionID: string) {
  return {
    sessionID,
    targetAddress: "192.0.2.10",
    video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
    audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) },
  };
}

function startRequest(sessionID: string) {
  return {
    type: "start",
    sessionID,
    video: { pt: 99, max_bit_rate: 600, fps: 30, width: 854, height: 480, mtu: 1378, profile: 2, level: 2 },
    audio: { pt: 110, sample_rate: 24, max_bit_rate: 24, codec: 3 },
  };
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
    const record = parsed as { event?: unknown; metadata?: unknown };
    if (record.event !== "rtcp_after_first_frame") continue;
    if (typeof record.metadata !== "object" || record.metadata === null) continue;
    const metadata = record.metadata as Record<string, unknown>;
    reports.push({
      sessionId: String(metadata["sessionId"]),
      spawn: String(metadata["spawn"]),
      videoPackets: Number(metadata["videoPackets"]),
      audioPackets: Number(metadata["audioPackets"]),
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

function emitFrame(proc: Proc): void {
  proc.stderr.write("frame=1\n");
}

function stop(delegate: ArgusStreamingDelegate, sessionID: string): void {
  delegate.handleStreamRequest({ type: "stop", sessionID } as never, () => {});
}

function createDelegate(procs: Proc[]): { delegate: ArgusStreamingDelegate; forceStop: ReturnType<typeof vi.fn> } {
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
    cache(),
    { aspect: "16:9", spawnFn, verbose: false },
  );
  const forceStop = vi.fn();
  delegate.controller = { forceStopStreamingSession: forceStop } as never;
  return { delegate, forceStop };
}

async function prepare(delegate: ArgusStreamingDelegate, sessionID: string): Promise<{ videoPort: number; audioPort: number }> {
  return new Promise((resolve, reject) => {
    delegate.prepareStream(prepareRequest(sessionID) as never, (error, response) => {
      if (error || !response) {
        reject(error ?? new Error("prepare failed"));
        return;
      }
      const body = response as { video: { port: number }; audio?: { port: number } };
      resolve({ videoPort: body.video.port, audioPort: body.audio?.port ?? 0 });
    });
  });
}

async function start(delegate: ArgusStreamingDelegate, sessionID: string): Promise<void> {
  const startDone = new Promise<void>((resolve, reject) => {
    delegate.handleStreamRequest(startRequest(sessionID) as never, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(100);
  await startDone;
}

async function startLive(sessionID: string): Promise<Live> {
  const procs: Proc[] = [];
  const { delegate, forceStop } = createDelegate(procs);
  try {
    const ports = await prepare(delegate, sessionID);
    await start(delegate, sessionID);
    const proc = procs[0];
    if (!proc || ports.videoPort === 0 || ports.audioPort === 0) {
      throw new Error("live session did not bind return ports");
    }
    return { delegate, procs, ...ports, sessionID, forceStop };
  } catch (error) {
    stop(delegate, sessionID);
    throw error;
  }
}

async function reconfigure(live: Live): Promise<Proc> {
  await new Promise<void>((resolve, reject) => {
    live.delegate.handleStreamRequest({
      type: "reconfigure",
      sessionID: live.sessionID,
      video: { width: 1280, height: 720, fps: 30, max_bit_rate: 2000, rtcp_interval: 0.5 },
    } as never, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const next = live.procs[1];
  if (!next) throw new Error("reconfigure did not spawn ffmpeg");
  return next;
}

async function apply(live: Live, event: TeardownEvent): Promise<void> {
  if (event === "stop") {
    stop(live.delegate, live.sessionID);
    return;
  }
  if (event === "exit") {
    live.procs[0]!.emit("exit", 1, null);
    return;
  }
  if (event === "abandon") {
    await vi.advanceTimersByTimeAsync(NO_RTCP_CONSUMER_ABANDON_MS);
    return;
  }
  live.delegate.controller?.forceStopStreamingSession(live.sessionID);
}

async function sendAfterClose(port: number): Promise<void> {
  try {
    await sendRtcp(port, 1);
  } catch {
    // The return socket is already closed.
  }
}

const orders = permutations(TEARDOWN_EVENTS).map((order) => ({
  label: order.join(" then "),
  order,
}));

describe("live session teardown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(orders)("tears a session down once when $label arrives", async ({ label, order }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const live = await startLive(label);
    const first = order[0]!;
    const expected = expectedCalls(first);
    try {
      emitFrame(live.procs[0]!);
      await sendRtcp(live.videoPort, 1);
      const log = await capture(async () => {
        for (let index = 0; index < order.length; index += 1) {
          await apply(live, order[index]!);
          if (index === 0) await sendAfterClose(live.videoPort);
        }
      });
      expect(live.procs[0]!.kill).toHaveBeenCalledTimes(expected.kill);
      if (expected.kill === 1) expect(live.procs[0]!.kill).toHaveBeenCalledWith("SIGKILL");
      expect(live.forceStop).toHaveBeenCalledTimes(expected.forceStop);
      if (expected.forceStop === 1) expect(live.forceStop).toHaveBeenCalledWith(label);
      expect(rtcpReports(log)).toEqual([
        { sessionId: label, spawn: "start", videoPackets: 1, audioPackets: 0 },
      ]);
    } finally {
      stop(live.delegate, live.sessionID);
    }
  });

  it("closes the window on exit 0 without forceStop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const live = await startLive("exit-zero");
    try {
      emitFrame(live.procs[0]!);
      await sendRtcp(live.videoPort, 1);
      const log = await capture(async () => {
        live.procs[0]!.emit("exit", 0, null);
        await sendAfterClose(live.videoPort);
        await vi.advanceTimersByTimeAsync(NO_RTCP_CONSUMER_ABANDON_MS);
        stop(live.delegate, live.sessionID);
      });
      expect(live.forceStop).not.toHaveBeenCalled();
      expect(live.procs[0]!.kill).not.toHaveBeenCalled();
      expect(rtcpReports(log)).toEqual([
        { sessionId: "exit-zero", spawn: "start", videoPackets: 1, audioPackets: 0 },
      ]);
    } finally {
      stop(live.delegate, live.sessionID);
    }
  });

  it("closes the window on SIGKILL without forceStop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const live = await startLive("exit-sigkill");
    try {
      emitFrame(live.procs[0]!);
      await sendRtcp(live.videoPort, 1);
      const log = await capture(async () => {
        live.procs[0]!.emit("exit", null, "SIGKILL");
        await sendAfterClose(live.videoPort);
        await vi.advanceTimersByTimeAsync(NO_RTCP_CONSUMER_ABANDON_MS);
        stop(live.delegate, live.sessionID);
      });
      expect(live.forceStop).not.toHaveBeenCalled();
      expect(live.procs[0]!.kill).not.toHaveBeenCalled();
      expect(rtcpReports(log)).toEqual([
        { sessionId: "exit-sigkill", spawn: "start", videoPackets: 1, audioPackets: 0 },
      ]);
    } finally {
      stop(live.delegate, live.sessionID);
    }
  });

  it("forceStops once when the reconfigure ffmpeg exits 1", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const live = await startLive("reconfigure-exit-1");
    try {
      const next = await reconfigure(live);
      emitFrame(next);
      await sendRtcp(live.videoPort, 1);
      const log = await capture(async () => {
        next.emit("exit", 1, null);
        await sendAfterClose(live.videoPort);
        await vi.advanceTimersByTimeAsync(NO_RTCP_CONSUMER_ABANDON_MS);
        stop(live.delegate, live.sessionID);
      });
      expect(live.forceStop).toHaveBeenCalledTimes(1);
      expect(live.forceStop).toHaveBeenCalledWith("reconfigure-exit-1");
      expect(next.kill).not.toHaveBeenCalled();
      expect(live.procs[0]!.kill).toHaveBeenCalledTimes(1);
      expect(live.procs[0]!.kill).toHaveBeenCalledWith("SIGKILL");
      expect(rtcpReports(log)).toEqual([
        { sessionId: "reconfigure-exit-1", spawn: "reconfigure", videoPackets: 1, audioPackets: 0 },
      ]);
    } finally {
      stop(live.delegate, live.sessionID);
    }
  });

  it("does not forceStop when the reconfigure ffmpeg exits 0", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const live = await startLive("reconfigure-exit-0");
    try {
      const next = await reconfigure(live);
      emitFrame(next);
      await sendRtcp(live.videoPort, 1);
      const log = await capture(async () => {
        next.emit("exit", 0, null);
        await sendAfterClose(live.videoPort);
        await vi.advanceTimersByTimeAsync(NO_RTCP_CONSUMER_ABANDON_MS);
        stop(live.delegate, live.sessionID);
      });
      expect(live.forceStop).not.toHaveBeenCalled();
      expect(next.kill).not.toHaveBeenCalled();
      expect(live.procs[0]!.kill).toHaveBeenCalledTimes(1);
      expect(rtcpReports(log)).toEqual([
        { sessionId: "reconfigure-exit-0", spawn: "reconfigure", videoPackets: 1, audioPackets: 0 },
      ]);
    } finally {
      stop(live.delegate, live.sessionID);
    }
  });

  it("does not forceStop when the reconfigure ffmpeg exits with SIGKILL", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const live = await startLive("reconfigure-sigkill");
    try {
      const next = await reconfigure(live);
      emitFrame(next);
      await sendRtcp(live.videoPort, 1);
      const log = await capture(async () => {
        next.emit("exit", null, "SIGKILL");
        await sendAfterClose(live.videoPort);
        await vi.advanceTimersByTimeAsync(NO_RTCP_CONSUMER_ABANDON_MS);
        stop(live.delegate, live.sessionID);
      });
      expect(live.forceStop).not.toHaveBeenCalled();
      expect(next.kill).not.toHaveBeenCalled();
      expect(rtcpReports(log)).toEqual([
        { sessionId: "reconfigure-sigkill", spawn: "reconfigure", videoPackets: 1, audioPackets: 0 },
      ]);
    } finally {
      stop(live.delegate, live.sessionID);
    }
  });

  it("keeps the new spawn after the replaced ffmpeg exits with SIGKILL", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const live = await startLive("replaced-sigkill");
    try {
      const next = await reconfigure(live);
      expect(live.procs[0]!.kill).toHaveBeenCalledTimes(1);
      expect(live.procs[0]!.kill).toHaveBeenCalledWith("SIGKILL");
      live.procs[0]!.emit("exit", null, "SIGKILL");
      emitFrame(next);
      await sendRtcp(live.videoPort, 1);
      const log = await capture(async () => {
        stop(live.delegate, live.sessionID);
      });
      expect(live.forceStop).not.toHaveBeenCalled();
      expect(live.procs[0]!.kill).toHaveBeenCalledTimes(1);
      expect(next.kill).toHaveBeenCalledTimes(1);
      expect(next.kill).toHaveBeenCalledWith("SIGKILL");
      expect(rtcpReports(log)).toEqual([
        { sessionId: "replaced-sigkill", spawn: "reconfigure", videoPackets: 1, audioPackets: 0 },
      ]);
    } finally {
      stop(live.delegate, live.sessionID);
    }
  });

  it("replaces a tracked session when prepareStream reuses its id", async () => {
    const live = await startLive("same-id");
    try {
      emitFrame(live.procs[0]!);
      await sendRtcp(live.videoPort, 1);
      let calls = 0;
      let nextPort = 0;
      const log = await capture(async () => {
        const done = new Promise<void>((resolve) => {
          live.delegate.prepareStream(prepareRequest(live.sessionID) as never, (error, response) => {
            calls += 1;
            if (error || !response) return;
            nextPort = (response as { video: { port: number } }).video.port;
            resolve();
          });
        });
        const outcome = await Promise.race([
          done.then(() => "called" as const),
          new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
        ]);
        expect(outcome).toBe("called");
      });
      expect(calls).toBe(1);
      expect(nextPort).toBeGreaterThan(0);
      expect(live.forceStop).not.toHaveBeenCalled();
      expect(live.procs[0]!.kill).toHaveBeenCalledTimes(1);
      expect(live.procs[0]!.kill).toHaveBeenCalledWith("SIGKILL");
      expect(rtcpReports(log)).toEqual([
        { sessionId: "same-id", spawn: "start", videoPackets: 1, audioPackets: 0 },
      ]);

      await sendAfterClose(live.videoPort);
      await start(live.delegate, live.sessionID);
      const next = live.procs[1];
      if (!next) throw new Error("reconnect did not spawn ffmpeg");
      emitFrame(next);
      await sendRtcp(nextPort, 1);
      live.procs[0]!.emit("exit", null, "SIGKILL");
      const restarted = await capture(async () => {
        stop(live.delegate, live.sessionID);
      });
      expect(live.forceStop).not.toHaveBeenCalled();
      expect(live.procs[0]!.kill).toHaveBeenCalledTimes(1);
      expect(next.kill).toHaveBeenCalledTimes(1);
      expect(next.kill).toHaveBeenCalledWith("SIGKILL");
      expect(rtcpReports(restarted)).toEqual([
        { sessionId: "same-id", spawn: "start", videoPackets: 1, audioPackets: 0 },
      ]);
    } finally {
      stop(live.delegate, live.sessionID);
    }
  });
});
