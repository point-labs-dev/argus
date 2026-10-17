import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrepareStreamRequest, PrepareStreamResponse } from "hap-nodejs";
import { AudioStreamingCodecType } from "hap-nodejs";
import { parse as parseYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";

import { ConfigError, loadArgusConfig, parseArgusConfig } from "../src/config.js";
import {
  ArgusStreamingDelegate,
  buildCameraControllerOptions,
  buildLiveFfmpegArgs,
  createCameraAccessory,
  type LiveFfmpegInput,
} from "../src/homekit.js";
import { SessionStateMachine } from "../src/homekit/session-state-machine.js";
import { SnapshotCache } from "../src/snapshot-cache.js";

function configBody(aspect?: string, name = "Garage Door") {
  const camera: Record<string, unknown> = {
    name,
    host: "10.0.0.7",
    channel: 0,
    mainCodec: "h264",
    username: "admin",
    password: "x",
    transport: "auto",
    streams: { main: "main", sub: "sub" },
  };
  if (aspect !== undefined) camera.aspect = aspect;
  return {
    cameras: [camera],
    recording: { path: "./rec", retention: { continuous: 3, motion: 7, alerts: 30 } },
    homekit: { pin: "123-45-678" },
    go2rtc: { binary: "./go2rtc", api_port: 1984 },
    server: { port: 8080 },
  };
}

function cache(): SnapshotCache {
  const config = parseArgusConfig(configBody("4:3"));
  const fetchFn = (async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([0xff, 0xd8]).buffer,
  })) as unknown as typeof fetch;
  return new SnapshotCache(config, { fetch: fetchFn });
}

function live(aspect: "16:9" | "4:3"): LiveFfmpegInput {
  return {
    inputUrl: "rtsp://127.0.0.1:8554/cam-sub",
    targetAddress: "192.168.1.50",
    videoMode: "transcode",
    aspect,
    video: {
      port: 50000,
      localRtcpPort: 60000,
      ssrc: 1,
      payloadType: 99,
      maxBitrateKbps: 2000,
      fps: 30,
      width: 1280,
      height: 720,
      mtu: 1378,
      profile: "baseline",
      level: "4.0",
      srtpParams: "VIDEOKEY==",
    },
    audio: {
      port: 50002,
      localRtcpPort: 60002,
      ssrc: 2,
      payloadType: 110,
      codec: AudioStreamingCodecType.OPUS,
      sampleRateKhz: 24,
      maxBitrateKbps: 24,
      srtpParams: "AUDIOKEY==",
    },
  };
}

function streamRequest(sessionID: string): PrepareStreamRequest {
  return {
    sessionID,
    targetAddress: "10.0.0.41",
    video: { port: 50000, srtp_key: Buffer.alloc(16, 0x11), srtp_salt: Buffer.alloc(14, 0x22) },
    audio: { port: 50002, srtp_key: Buffer.alloc(16, 0x33), srtp_salt: Buffer.alloc(14, 0x44) },
  } as PrepareStreamRequest;
}

async function answered(includeAudio: boolean): Promise<PrepareStreamResponse> {
  const delegate = new ArgusStreamingDelegate(
    "Garage Door",
    "rtsp://127.0.0.1:8554/garage-door-sub",
    cache(),
    { includeAudio, aspect: "4:3", verbose: false },
  );
  return new Promise<PrepareStreamResponse>((resolve, reject) => {
    delegate.prepareStream(streamRequest(includeAudio ? "audio-on" : "audio-off"), (error, value) => {
      if (error || !value) reject(error ?? new Error("no response"));
      else resolve(value);
    });
  });
}

function sourceLeg(leg: PrepareStreamResponse["video"] | NonNullable<PrepareStreamResponse["audio"]>) {
  if (!leg || !("srtp_key" in leg) || !("srtp_salt" in leg) || !leg.srtp_key || !leg.srtp_salt) {
    throw new Error("expected source SRTP leg");
  }
  return leg;
}

describe("HAP setup contract", () => {
  it("defaults a delegate with no aspect to 16:9", () => {
    const delegate = new ArgusStreamingDelegate("Garage Door", "rtsp://x", cache());
    expect(delegate.aspect).toBe("16:9");
    expect(buildCameraControllerOptions(delegate).streamingOptions.video.resolutions.map((row) => `${row[0]}x${row[1]}`)).toEqual([
      "854x480",
      "640x480",
      "640x360",
    ]);
  });

  it("rejects a camera with no aspect and accepts 4:3", () => {
    expect(() => parseArgusConfig(configBody())).toThrow(ConfigError);
    expect(() => parseArgusConfig(configBody())).toThrow(/aspect/i);
    expect(() => parseArgusConfig(configBody("1:1"))).toThrow(ConfigError);
    expect(parseArgusConfig(configBody("4:3")).cameras[0]?.aspect).toBe("4:3");
  });

  it("parses argus.example.yaml and fails when aspect is removed", async () => {
    const examplePath = join(dirname(fileURLToPath(import.meta.url)), "../argus.example.yaml");
    const config = await loadArgusConfig(examplePath);
    expect(config.cameras.map((camera) => `${camera.name}=${camera.aspect}`)).toEqual([
      "Backyard Left=16:9",
      "Front L=16:9",
    ]);
    const stripped = readFileSync(examplePath, "utf8").replace(/^\s*aspect:.*$/gm, "");
    expect(stripped).not.toMatch(/^\s*aspect:/m);
    expect(() => parseArgusConfig(parseYaml(stripped))).toThrow(ConfigError);
    expect(() => parseArgusConfig(parseYaml(stripped))).toThrow(/aspect/i);
  });

  it("crops 4:3 and pads 16:9, including a Garage Door marked 16:9", () => {
    const crop = buildLiveFfmpegArgs(live("4:3"), false).join(" ");
    expect(crop).toContain("crop=1280:720");
    expect(crop).not.toContain("pad=");
    expect(crop).not.toContain("-c:a");

    const pad = buildLiveFfmpegArgs(live("16:9"), true).join(" ");
    expect(pad).toContain("pad=1280:720:(ow-iw)/2:(oh-ih)/2");
    expect(pad).not.toContain("crop=");
    expect(pad).toContain("-c:a");
  });

  it("wires a parsed 4:3 camera into a 640x480 crop", async () => {
    const camera = parseArgusConfig(configBody("4:3", "Garage Door")).cameras[0];
    if (!camera) throw new Error("missing camera");
    const spawnFn = vi.fn(() => Object.assign(new EventEmitter(), { kill: vi.fn() }));
    const { delegate } = createCameraAccessory(
      camera,
      "rtsp://127.0.0.1:8554/garage-door-sub",
      "rtsp://127.0.0.1:8554/garage-door",
      cache(),
      {
        spawnFn: spawnFn as never,
        verbose: false,
        mainStreamUrl: "rtsp://127.0.0.1:8554/garage-door",
      },
    );
    await new Promise<void>((resolve, reject) => {
      delegate.prepareStream(streamRequest("garage-wire"), (error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(
        {
          type: "start",
          sessionID: "garage-wire",
          video: { pt: 99, max_bit_rate: 132, fps: 30, mtu: 1378, profile: 0, level: 2, width: 640, height: 480 },
          audio: { pt: 110, sample_rate: 24, max_bit_rate: 24, codec: AudioStreamingCodecType.AAC_ELD },
        } as never,
        (error) => (error ? reject(error) : resolve()),
      );
    });
    const args = (spawnFn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0]?.[1];
    if (!args) throw new Error("ffmpeg was not spawned");
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("crop=640:480");
    expect(vf).not.toContain("pad=");
    delegate.handleStreamRequest({ type: "stop", sessionID: "garage-wire" } as never, () => {});
  });

  it("wires a parsed 16:9 camera into an 854x480 pad", async () => {
    const camera = parseArgusConfig(configBody("16:9", "Front L")).cameras[0];
    if (!camera) throw new Error("missing camera");
    const spawnFn = vi.fn(() => Object.assign(new EventEmitter(), { kill: vi.fn() }));
    const { delegate } = createCameraAccessory(
      camera,
      "rtsp://127.0.0.1:8554/front-l-sub",
      "rtsp://127.0.0.1:8554/front-l",
      cache(),
      {
        spawnFn: spawnFn as never,
        verbose: false,
        mainStreamUrl: "rtsp://127.0.0.1:8554/front-l",
      },
    );
    const ladder = buildCameraControllerOptions(delegate).streamingOptions.video.resolutions.map(
      (row) => `${row[0]}x${row[1]}`,
    );
    expect(ladder).toEqual(["854x480", "640x480", "640x360"]);
    await new Promise<void>((resolve, reject) => {
      delegate.prepareStream(streamRequest("front-l-wire"), (error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(
        {
          type: "start",
          sessionID: "front-l-wire",
          video: { pt: 99, max_bit_rate: 132, fps: 30, mtu: 1378, profile: 0, level: 2, width: 854, height: 480 },
          audio: { pt: 110, sample_rate: 24, max_bit_rate: 24, codec: AudioStreamingCodecType.AAC_ELD },
        } as never,
        (error) => (error ? reject(error) : resolve()),
      );
    });
    const args = (spawnFn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0]?.[1];
    if (!args) throw new Error("ffmpeg was not spawned");
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("pad=854:480");
    expect(vf).not.toContain("crop=");
    delegate.handleStreamRequest({ type: "stop", sessionID: "front-l-wire" } as never, () => {});
  });

  it("advertises from aspect, not from the camera name", () => {
    const wideGarage = new ArgusStreamingDelegate("Garage Door", "rtsp://x", cache(), { aspect: "16:9" });
    const wide = buildCameraControllerOptions(wideGarage).streamingOptions.video.resolutions.map(
      (row) => `${row[0]}x${row[1]}`,
    );
    expect(wide).toEqual(["854x480", "640x480", "640x360"]);

    const squareLeft = new ArgusStreamingDelegate("Backyard Left", "rtsp://x", cache(), { aspect: "4:3" });
    expect(buildCameraControllerOptions(squareLeft).streamingOptions.video.resolutions).toEqual([[640, 480, 30]]);
  });

  it("copies the request SRTP key and keeps audio when audio is off", async () => {
    const on = await answered(true);
    const onVideo = sourceLeg(on.video);
    const onAudio = sourceLeg(on.audio);
    expect(onVideo.srtp_key.equals(Buffer.alloc(16, 0x11))).toBe(true);
    expect(onVideo.srtp_salt.equals(Buffer.alloc(14, 0x22))).toBe(true);
    expect(onAudio.srtp_key.equals(Buffer.alloc(16, 0x33))).toBe(true);
    expect(onAudio.srtp_salt.equals(Buffer.alloc(14, 0x44))).toBe(true);

    const off = await answered(false);
    expect(off.audio).toBeDefined();
    expect(sourceLeg(off.audio).srtp_key.equals(Buffer.alloc(16, 0x33))).toBe(true);
  });

  it("calls the HAP callback for a second prepareStream", async () => {
    const delegate = new ArgusStreamingDelegate("Garage Door", "rtsp://x", cache(), {
      aspect: "4:3",
      verbose: false,
    });
    await new Promise<void>((resolve, reject) => {
      delegate.prepareStream(streamRequest("twice"), (error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("second prepareStream did not call the HAP callback")), 5000);
      delegate.prepareStream(streamRequest("twice"), () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  });

  it("allows the first prepare answer and rejects the second", () => {
    const machine = new SessionStateMachine("contract");
    expect(
      machine.prepare({
        targetAddress: "10.0.0.1",
        video: { port: 1, localRtcpPort: 2, ssrc: 3, srtpParams: "v" },
        audio: { port: 4, localRtcpPort: 5, ssrc: 6, srtpParams: "a" },
      }),
    ).toBe(true);
    expect(machine.answerPrepareCallback()).toBe(true);
    expect(machine.answerPrepareCallback()).toBe(false);
  });
});
