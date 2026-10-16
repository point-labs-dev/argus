import type { PrepareStreamRequest, PrepareStreamResponse } from "hap-nodejs";
import { AudioStreamingCodecType } from "hap-nodejs";
import { describe, expect, it } from "vitest";

import { ConfigError, parseArgusConfig } from "../src/config.js";
import {
  ArgusStreamingDelegate,
  buildCameraControllerOptions,
  buildLiveFfmpegArgs,
  type LiveFfmpegInput,
} from "../src/homekit.js";
import { prepareAnswer } from "../src/homekit/prepare-answer.js";
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

async function answered(includeAudio: boolean): Promise<{ calls: number; response: PrepareStreamResponse }> {
  const delegate = new ArgusStreamingDelegate(
    "Garage Door",
    "rtsp://127.0.0.1:8554/garage-door-sub",
    cache(),
    { includeAudio, aspect: "4:3", verbose: false },
  );
  let calls = 0;
  const response = await new Promise<PrepareStreamResponse>((resolve, reject) => {
    delegate.prepareStream(
      {
        sessionID: includeAudio ? "audio-on" : "audio-off",
        targetAddress: "10.0.0.41",
        video: { port: 50000, srtp_key: Buffer.alloc(16, 0x11), srtp_salt: Buffer.alloc(14, 0x22) },
        audio: { port: 50002, srtp_key: Buffer.alloc(16, 0x33), srtp_salt: Buffer.alloc(14, 0x44) },
      } as PrepareStreamRequest,
      (error, value) => {
        calls += 1;
        if (error || !value) reject(error ?? new Error("no response"));
        else resolve(value);
      },
    );
  });
  delegate.prepareStream(
    {
      sessionID: includeAudio ? "audio-on" : "audio-off",
      targetAddress: "10.0.0.41",
      video: { port: 50000, srtp_key: Buffer.alloc(16, 0x11), srtp_salt: Buffer.alloc(14, 0x22) },
      audio: { port: 50002, srtp_key: Buffer.alloc(16, 0x33), srtp_salt: Buffer.alloc(14, 0x44) },
    } as PrepareStreamRequest,
    () => {
      calls += 1;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  return { calls, response };
}

describe("HAP setup contract", () => {
  it("rejects a delegate that has no aspect", () => {
    expect(() => new ArgusStreamingDelegate("Garage Door", "rtsp://x", cache(), {} as never)).toThrow(/aspect/);
  });

  it("rejects a camera with no aspect and accepts 4:3", () => {
    expect(() => parseArgusConfig(configBody())).toThrow(ConfigError);
    expect(() => parseArgusConfig(configBody())).toThrow(/aspect/i);
    expect(() => parseArgusConfig(configBody("1:1"))).toThrow(ConfigError);
    expect(parseArgusConfig(configBody("4:3")).cameras[0]?.aspect).toBe("4:3");
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

  it("advertises from aspect, not from the camera name", () => {
    const wideGarage = new ArgusStreamingDelegate("Garage Door", "rtsp://x", cache(), { aspect: "16:9" });
    const wide = buildCameraControllerOptions(wideGarage).streamingOptions.video.resolutions.map(
      (row) => `${row[0]}x${row[1]}`,
    );
    expect(wide).toEqual(["854x480", "640x480", "640x360"]);

    const squareLeft = new ArgusStreamingDelegate("Backyard Left", "rtsp://x", cache(), { aspect: "4:3" });
    expect(buildCameraControllerOptions(squareLeft).streamingOptions.video.resolutions).toEqual([[640, 480, 30]]);
  });

  it("copies the request SRTP key and omits audio when audio is off", async () => {
    const on = await answered(true);
    expect(on.calls).toBe(1);
    expect(on.response.video.srtp_key.equals(Buffer.alloc(16, 0x11))).toBe(true);
    expect(on.response.video.srtp_salt.equals(Buffer.alloc(14, 0x22))).toBe(true);
    expect(on.response.audio?.srtp_key.equals(Buffer.alloc(16, 0x33))).toBe(true);
    expect(on.response.audio?.srtp_salt.equals(Buffer.alloc(14, 0x44))).toBe(true);

    const off = await answered(false);
    expect(off.calls).toBe(1);
    expect(off.response.audio).toBeUndefined();
    expect("audio" in off.response).toBe(false);
  });

  it("returns audio from prepareAnswer only when the session includes audio", () => {
    const videoKey = Buffer.alloc(16, 1);
    const videoSalt = Buffer.alloc(14, 2);
    const audioKey = Buffer.alloc(16, 3);
    const audioSalt = Buffer.alloc(14, 4);
    const withAudio = prepareAnswer({
      includeAudio: true,
      video: { port: 1, ssrc: 2, srtp_key: videoKey, srtp_salt: videoSalt },
      audio: { port: 3, ssrc: 4, srtp_key: audioKey, srtp_salt: audioSalt },
    });
    expect(withAudio.audio?.srtp_key).toBe(audioKey);
    const videoOnly = prepareAnswer({
      includeAudio: false,
      video: { port: 1, ssrc: 2, srtp_key: videoKey, srtp_salt: videoSalt },
    });
    expect(videoOnly.audio).toBeUndefined();
    expect(videoOnly.video.srtp_key).toBe(videoKey);
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
