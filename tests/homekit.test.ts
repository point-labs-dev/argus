import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { parseArgusConfig } from "../src/config.js";
import { SnapshotCache } from "../src/snapshot-cache.js";
import {
  ArgusStreamingDelegate,
  buildCameraControllerOptions,
  buildLiveFfmpegArgs,
  type LiveFfmpegInput,
} from "../src/homekit.js";

function liveInput(overrides: Partial<LiveFfmpegInput> = {}): LiveFfmpegInput {
  return {
    inputUrl: "rtsp://127.0.0.1:8554/backyard-left-sub",
    targetAddress: "192.168.1.50",
    video: {
      port: 50000,
      localRtcpPort: 60000,
      ssrc: 1,
      payloadType: 99,
      maxBitrateKbps: 299,
      fps: 30,
      width: 1280,
      height: 720,
      mtu: 1378,
      profile: "high",
      level: "4.0",
      srtpParams: "VIDEOKEY==",
    },
    audio: {
      port: 50002,
      localRtcpPort: 60002,
      ssrc: 2,
      payloadType: 110,
      sampleRateKhz: 24,
      maxBitrateKbps: 24,
      srtpParams: "AUDIOKEY==",
    },
    ...overrides,
  };
}

function cacheWith(jpeg: Buffer): SnapshotCache {
  const config = parseArgusConfig({
    cameras: [{ name: "Backyard Left", host: "10.0.0.5", channel: 0, mainCodec: "h265",
      username: "admin", password: "x", transport: "auto", streams: { main: "main", sub: "sub" } }],
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

describe("buildLiveFfmpegArgs", () => {
  it("transcodes video to libx264 and audio to libopus over SRTP", () => {
    const args = buildLiveFfmpegArgs(liveInput()).join(" ");

    expect(args).toContain("-i rtsp://127.0.0.1:8554/backyard-left-sub");
    expect(args).toContain("-c:v libx264");
    expect(args).toContain("-c:a libopus");
    expect(args).toContain("scale=1280:720");
    expect(args).toContain("-b:v 299k");
  });

  it("caps RTSP input analysis so the stream starts fast (else HomeKit times out)", () => {
    const args = buildLiveFfmpegArgs(liveInput());
    // Low-latency flags must come BEFORE -i to apply to the input.
    const inputIndex = args.indexOf("-i");
    const head = args.slice(0, inputIndex).join(" ");
    expect(head).toContain("-fflags nobuffer");
    expect(head).toContain("-probesize 500000");
    expect(head).toContain("-analyzeduration 1000000");
  });

  it("targets the device address with matching SRTP params and SSRCs", () => {
    const args = buildLiveFfmpegArgs(liveInput());
    const joined = args.join(" ");

    // video SRTP out
    expect(joined).toContain("-srtp_out_params VIDEOKEY==");
    expect(joined).toContain("srtp://192.168.1.50:50000?rtcpport=50000&localrtcpport=60000&pkt_size=1378");
    // audio SRTP out
    expect(joined).toContain("-srtp_out_params AUDIOKEY==");
    expect(joined).toContain("srtp://192.168.1.50:50002?rtcpport=50002&localrtcpport=60002");
    expect(joined).toContain("-ssrc 1");
    expect(joined).toContain("-ssrc 2");
  });
});

describe("buildCameraControllerOptions", () => {
  it("advertises the HomeKit-required crypto suite, H.264 levels, and Opus audio", () => {
    const delegate = new ArgusStreamingDelegate("Backyard Left", "rtsp://x", cacheWith(Buffer.from([0xff, 0xd8])));
    const opts = buildCameraControllerOptions(delegate);

    expect(opts.cameraStreamCount).toBe(2);
    expect(opts.streamingOptions.supportedCryptoSuites).toContain(0); // AES_CM_128_HMAC_SHA1_80
    const resolutions = opts.streamingOptions.video.resolutions.map((r) => `${r[0]}x${r[1]}`);
    // Live view is capped at <=640x480 for WiFi reliability (large keyframes drop).
    expect(resolutions).toContain("640x480");
    expect(resolutions.some((r) => r.startsWith("1280"))).toBe(false);
    expect(opts.streamingOptions.audio?.codecs?.[0]?.type).toBe("OPUS");
  });
});

describe("ArgusStreamingDelegate", () => {
  it("serves snapshots straight from the SnapshotCache buffer", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xaa, 0xbb]); // valid JPEG/JFIF signature
    const delegate = new ArgusStreamingDelegate("Backyard Left", "rtsp://x", cacheWith(jpeg));

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      delegate.handleSnapshotRequest({ width: 1280, height: 720 } as never, (error, data) => {
        if (error || !data) reject(error ?? new Error("no data"));
        else resolve(data);
      });
    });

    expect(buffer.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("spawns FFmpeg with the negotiated stream params on START", async () => {
    const fakeProc = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const spawnFn = vi.fn(() => fakeProc) as unknown as typeof import("node:child_process").spawn;
    const delegate = new ArgusStreamingDelegate(
      "Backyard Left",
      "rtsp://127.0.0.1:8554/backyard-left-sub",
      cacheWith(Buffer.from([0xff, 0xd8])),
      { spawnFn },
    );

    // prepareStream reserves real UDP ports and stores the session.
    await new Promise<void>((resolve, reject) => {
      delegate.prepareStream(
        { sessionID: "s1", targetAddress: "192.168.1.50",
          video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
          audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) } } as never,
        (error) => (error ? reject(error) : resolve()),
      );
    });

    await new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(
        { type: "start", sessionID: "s1",
          video: { pt: 99, max_bit_rate: 299, fps: 30, width: 1280, height: 720, mtu: 1378, profile: 2, level: 2 },
          audio: { pt: 110, sample_rate: 24, max_bit_rate: 24, codec: 3 } } as never,
        (error) => (error ? reject(error) : resolve()),
      );
    });

    expect(spawnFn).toHaveBeenCalledOnce();
    const [bin, args] = (spawnFn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0]!;
    expect(bin).toBe("ffmpeg");
    expect(args.join(" ")).toContain("-i rtsp://127.0.0.1:8554/backyard-left-sub");
    expect(args.join(" ")).toContain("srtp://192.168.1.50:50000");
    // FFmpeg must encrypt with the CONTROLLER's key from the request (not a
    // generated one), or the device can't decrypt — the forever-spinner bug.
    const expectedVideoSrtp = Buffer.concat([Buffer.alloc(16, 1), Buffer.alloc(14, 2)]).toString("base64");
    expect(args.join(" ")).toContain(`-srtp_out_params ${expectedVideoSrtp}`);
  });
});
