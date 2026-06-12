import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { parseArgusConfig } from "../src/config.js";
import { SnapshotCache } from "../src/snapshot-cache.js";
import {
  ArgusStreamingDelegate,
  buildCameraControllerOptions,
  buildLiveFfmpegArgs,
  effectiveBitrateKbps,
  resolveSrtpTargetAddress,
  type LiveFfmpegInput,
} from "../src/homekit.js";

function liveInput(overrides: Partial<LiveFfmpegInput> = {}): LiveFfmpegInput {
  return {
    inputUrl: "rtsp://127.0.0.1:8554/backyard-left-sub",
    targetAddress: "192.168.1.50",
    videoMode: "transcode",
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
  it("encodes ≥720p sessions with capped-CRF libx264 and relaxed 2s IDRs", () => {
    const args = buildLiveFfmpegArgs(liveInput()).join(" ");

    expect(args).toContain("-i rtsp://127.0.0.1:8554/backyard-left-sub");
    expect(args).toContain("-c:v libx264");
    expect(args).toContain("-c:a libopus");
    expect(args).toContain("scale=1280:720");
    // Capped-CRF: easy scenes undershoot the cap, motion gets the full budget.
    // Hi-res sessions get the extra encoder effort and quality target.
    expect(args).toContain("-preset faster");
    expect(args).toContain("-crf 18");
    expect(args).toContain("-maxrate 299k");
    expect(args).not.toContain("-b:v");
    expect(args).toContain("-bf 0");
    // A 720p+ IDR every 1s starved the in-between P-frames into a visible
    // sharp→soft pulse; 2s cadence steadies it (first frame is an IDR anyway).
    expect(args).toContain("-force_key_frames expr:gte(t,n_forced*2)");
    // The big sources (2560x1920/4K, some H.265) decode in hardware.
    expect(args).toContain("-hwaccel videotoolbox");
  });

  it("keeps 1s IDRs at the tile tier (cheap there, fast loss recovery)", () => {
    const args = buildLiveFfmpegArgs(
      liveInput({ video: { ...liveInput().video, width: 640, height: 360, maxBitrateKbps: 600 } }),
    ).join(" ");

    expect(args).toContain("-c:v libx264");
    expect(args).toContain("-tune zerolatency");
    expect(args).toContain("-crf 20");
    expect(args).toContain("-maxrate 600k");
    expect(args).toContain("-force_key_frames expr:gte(t,n_forced*1)");
    expect(args).toContain("scale=640:360");
    // VT decode is ≥720p-only: pointless for 640-wide subs, and the VT decoder
    // noisily rejects pre-IDR packets at every session join.
    expect(args).not.toContain("-hwaccel");
  });

  it("passes video through untouched in copy mode (no encode, no scaling, no keyframe forcing)", () => {
    const args = buildLiveFfmpegArgs(liveInput({ videoMode: "copy" })).join(" ");

    expect(args).toContain("-c:v copy");
    expect(args).not.toContain("libx264");
    expect(args).not.toContain("scale=");
    expect(args).not.toContain("-force_key_frames");
    expect(args).not.toContain("-b:v");
    // Copy trims input analysis to ~0.2s — every analysis ms delays the keyframe
    // that stream-copy waits for (bench 2026-06-11: 1s analysis ≈ +1s start).
    expect(args).toContain("-analyzeduration 200000");
    expect(args).toContain("-probesize 100000");
    // Audio is still transcoded to Opus, and SRTP targeting is unchanged.
    expect(args).toContain("-c:a libopus");
    expect(args).toContain("-srtp_out_params VIDEOKEY==");
    expect(args).toContain("srtp://192.168.1.50:50000?rtcpport=50000&localrtcpport=60000&pkt_size=1378");
    expect(args).toContain("-payload_type 99");
  });

  it("caps RTSP input analysis so the stream starts fast (else HomeKit times out)", () => {
    const args = buildLiveFfmpegArgs(liveInput());
    // Low-latency flags must come BEFORE -i to apply to the input. 0.2s analysis
    // is bench-validated for transcode too (2026-06-11: 1s of analysis was 1s of
    // start latency; AAC detection stayed reliable at 0.2s/100k).
    const inputIndex = args.indexOf("-i");
    const head = args.slice(0, inputIndex).join(" ");
    expect(head).toContain("-fflags nobuffer");
    expect(head).toContain("-probesize 100000");
    expect(head).toContain("-analyzeduration 200000");
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

describe("effectiveBitrateKbps", () => {
  it("floors Apple's conservative asks per resolution tier", () => {
    // Measured asks from a real iPhone session (2026-06-11): 299k @720p, 802k
    // @1080p — visibly starved. Floors are generous LAN rates: every session
    // is now hi-res (hi-res-only ladder) and quality is the stated goal.
    expect(effectiveBitrateKbps(1920, 1080, 802)).toBe(5500);
    expect(effectiveBitrateKbps(1280, 720, 299)).toBe(3500);
    expect(effectiveBitrateKbps(640, 360, 132)).toBe(600);
    expect(effectiveBitrateKbps(320, 240, 100)).toBe(300);
  });

  it("honors the negotiated bitrate when it exceeds the floor", () => {
    expect(effectiveBitrateKbps(1280, 720, 4500)).toBe(4500);
  });
});

describe("resolveSrtpTargetAddress", () => {
  const fakeInterfaces = (() => ({
    en0: [{ address: "10.0.0.46" }],
    ipsec1: [{ address: "10.0.0.46" }],
  })) as never;

  it("rewrites a controller address that belongs to this host to loopback", () => {
    // Self-addressed ipsec interfaces hijack the route to one's own LAN IP and
    // swallow the UDP — local viewers must be fed via loopback.
    expect(resolveSrtpTargetAddress("10.0.0.46", fakeInterfaces)).toBe("127.0.0.1");
  });

  it("leaves external controller addresses untouched", () => {
    expect(resolveSrtpTargetAddress("10.0.0.15", fakeInterfaces)).toBe("10.0.0.15");
  });
});

describe("buildCameraControllerOptions", () => {
  it("advertises the HomeKit-required crypto suite, H.264 levels, and Opus audio", () => {
    const delegate = new ArgusStreamingDelegate("Backyard Left", "rtsp://x", cacheWith(Buffer.from([0xff, 0xd8])));
    const opts = buildCameraControllerOptions(delegate);

    expect(opts.cameraStreamCount).toBe(2);
    expect(opts.streamingOptions.supportedCryptoSuites).toContain(0); // AES_CM_128_HMAC_SHA1_80
    const resolutions = opts.streamingOptions.video.resolutions.map((r) => `${r[0]}x${r[1]}`);
    expect(resolutions).toContain("1280x720");
    expect(opts.streamingOptions.audio?.codecs?.[0]?.type).toBe("OPUS");
  });

  it("advertises ONLY the native resolution in copy mode (mismatch kills the session)", () => {
    const delegate = new ArgusStreamingDelegate("Backyard Left", "rtsp://x", cacheWith(Buffer.from([0xff, 0xd8])));
    const opts = buildCameraControllerOptions(delegate, true, undefined, { width: 896, height: 512 }, "copy");

    expect(opts.streamingOptions.video.resolutions).toEqual([[896, 512, 30]]);
  });

  it("advertises ONLY high resolutions in transcode mode (small sizes invite 640x360 sessions)", () => {
    const delegate = new ArgusStreamingDelegate("Backyard Right", "rtsp://x", cacheWith(Buffer.from([0xff, 0xd8])));
    const opts = buildCameraControllerOptions(delegate, true, undefined, { width: 896, height: 672 }, "transcode");

    const resolutions = opts.streamingOptions.video.resolutions.map((r) => `${r[0]}x${r[1]}`);
    // Measured 2026-06-12: whenever 640x360 is on offer, the iOS tile player
    // takes it AND full-screen reuses that session without upgrading — every
    // "full screen" was an upscaled 640x360. Offering only 1080p/720p makes
    // every session high-res from its first frame.
    expect(resolutions).toEqual(["1920x1080", "1280x720"]);
    // Non-standard probed sizes are dead weight — never advertised.
    expect(resolutions).not.toContain("896x672");
  });

  it("restores the small tiers with ARGUS_LIVE_LADDER=compat (client-compat rollback)", () => {
    const delegate = new ArgusStreamingDelegate("Backyard Right", "rtsp://x", cacheWith(Buffer.from([0xff, 0xd8])));
    process.env.ARGUS_LIVE_LADDER = "compat";
    try {
      const opts = buildCameraControllerOptions(delegate, true, undefined, undefined, "transcode");
      const resolutions = opts.streamingOptions.video.resolutions.map((r) => `${r[0]}x${r[1]}`);
      expect(resolutions).toContain("1920x1080");
      expect(resolutions).toContain("640x360");
      expect(resolutions).toContain("320x240");
    } finally {
      delete process.env.ARGUS_LIVE_LADDER;
    }
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
    // Transcode is the default live mode (validated on real devices).
    expect(args.join(" ")).toContain("-c:v libx264");
    expect(args.join(" ")).toContain("scale=1280:720");
    // Apple asked 299k for 720p (its asks are mush); the floor policy serves 3500k.
    expect(args.join(" ")).toContain("-maxrate 3500k");
    // FFmpeg must encrypt with the CONTROLLER's key from the request (not a
    // generated one), or the device can't decrypt — the forever-spinner bug.
    const expectedVideoSrtp = Buffer.concat([Buffer.alloc(16, 1), Buffer.alloc(14, 2)]).toString("base64");
    expect(args.join(" ")).toContain(`-srtp_out_params ${expectedVideoSrtp}`);
  });

  it("respawns the encoder at the upgraded resolution on RECONFIGURE", async () => {
    const procs: Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }> = [];
    const spawnFn = vi.fn(() => {
      const proc = Object.assign(new EventEmitter(), { kill: vi.fn() });
      procs.push(proc);
      return proc;
    }) as unknown as typeof import("node:child_process").spawn;
    const delegate = new ArgusStreamingDelegate(
      "Backyard Left",
      "rtsp://127.0.0.1:8554/backyard-left-sub",
      cacheWith(Buffer.from([0xff, 0xd8])),
      { spawnFn },
    );

    await new Promise<void>((resolve, reject) => {
      delegate.prepareStream(
        { sessionID: "s2", targetAddress: "192.168.1.50",
          video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
          audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) } } as never,
        (error) => (error ? reject(error) : resolve()),
      );
    });
    await new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(
        { type: "start", sessionID: "s2",
          video: { pt: 99, max_bit_rate: 132, fps: 30, width: 640, height: 360, mtu: 1378, profile: 2, level: 2 },
          audio: { pt: 110, sample_rate: 24, max_bit_rate: 24, codec: 3 } } as never,
        (error) => (error ? reject(error) : resolve()),
      );
    });

    // Full-screen upgrade: Apple sends RECONFIGURE on the SAME session.
    await new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(
        { type: "reconfigure", sessionID: "s2",
          video: { width: 896, height: 672, fps: 30, max_bit_rate: 600, rtcp_interval: 0.5 } } as never,
        (error) => (error ? reject(error) : resolve()),
      );
    });

    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(procs[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    const secondArgs = (spawnFn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[1]![1].join(" ");
    expect(secondArgs).toContain("scale=896:672");
    expect(secondArgs).toContain("-maxrate 600k");
  });

  it("sources ≥720p sessions from the main restream and returns to sub below 720p", async () => {
    const spawnFn = vi.fn(() => Object.assign(new EventEmitter(), { kill: vi.fn() })) as unknown as typeof import("node:child_process").spawn;
    const delegate = new ArgusStreamingDelegate(
      "Backyard Left",
      "rtsp://127.0.0.1:8554/backyard-left-sub",
      cacheWith(Buffer.from([0xff, 0xd8])),
      { spawnFn, mainStreamUrl: "rtsp://127.0.0.1:8554/backyard-left" },
    );

    await new Promise<void>((resolve, reject) => {
      delegate.prepareStream(
        { sessionID: "s3", targetAddress: "192.168.1.50",
          video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
          audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) } } as never,
        (error) => (error ? reject(error) : resolve()),
      );
    });
    // Full-screen-sized START: the 896-wide sub has no pixels for 720p — the
    // session must transcode the full-res main instead.
    await new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(
        { type: "start", sessionID: "s3",
          video: { pt: 99, max_bit_rate: 2000, fps: 30, width: 1280, height: 720, mtu: 1378, profile: 2, level: 2 },
          audio: { pt: 110, sample_rate: 24, max_bit_rate: 24, codec: 3 } } as never,
        (error) => (error ? reject(error) : resolve()),
      );
    });
    // Downgrade RECONFIGURE (e.g. backgrounding to the tile) returns to the sub.
    await new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(
        { type: "reconfigure", sessionID: "s3",
          video: { width: 640, height: 360, fps: 30, max_bit_rate: 132, rtcp_interval: 0.5 } } as never,
        (error) => (error ? reject(error) : resolve()),
      );
    });

    const calls = (spawnFn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls;
    expect(calls[0]![1].join(" ")).toContain("-i rtsp://127.0.0.1:8554/backyard-left ");
    expect(calls[1]![1].join(" ")).toContain("-i rtsp://127.0.0.1:8554/backyard-left-sub");
  });
});
