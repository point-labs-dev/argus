import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { parseArgusConfig } from "../src/config.js";
import { SnapshotCache } from "../src/snapshot-cache.js";
import {
  ArgusStreamingDelegate,
  ARGUS_FIRMWARE_REVISION,
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
      codec: "OPUS", // AudioStreamingCodecType.OPUS
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
  it("encodes AAC-ELD audio when HomeKit negotiates AAC-ELD", () => {
    const input = liveInput({ audio: { ...liveInput().audio, codec: "AAC-eld" } });
    const args = buildLiveFfmpegArgs(input, true);
    const joined = args.join(" ");

    // AAC-ELD encoder (libfdk_aac)
    expect(joined).toContain("-c:a libfdk_aac");
    expect(joined).toContain("-profile:a aac_eld");
    expect(joined).toContain("-flags +global_header");
    // Opus NOT used
    expect(joined).not.toContain("libopus");
    expect(joined).not.toContain("-application lowdelay");
    expect(joined).not.toContain("-frame_duration");
  });

  it("encodes Opus audio when HomeKit negotiates Opus", () => {
    const input = liveInput({ audio: { ...liveInput().audio, codec: "OPUS" } });
    const args = buildLiveFfmpegArgs(input, true);
    const joined = args.join(" ");

    // Opus encoder
    expect(joined).toContain("-c:a libopus");
    expect(joined).toContain("-application lowdelay");
    expect(joined).toContain("-frame_duration 20");
    // AAC-ELD NOT used
    expect(joined).not.toContain("-c:a libfdk_aac");
    expect(joined).not.toContain("-profile:a aac_eld");
  });

  it("encodes ≥720p sessions with capped-CRF libx264 and intra-refresh", () => {
    // 3500k = the post-floor bitrate a LAN 720p session actually arrives with
    // (the delegate floors before building args; sub-800k here means a
    // relay-obeyed session and triggers the starved downscale instead).
    const args = buildLiveFfmpegArgs(
      liveInput({ video: { ...liveInput().video, maxBitrateKbps: 2000 } }),
    ).join(" ");

    expect(args).toContain("-i rtsp://127.0.0.1:8554/backyard-left-sub");
    expect(args).toContain("-c:v libx264");
    expect(args).toContain("-c:a libopus");
    // Pad to exact negotiated dimensions (field 2026-10-01: 4:3 source → 960×720 != 1280×720)
    expect(args).toContain("scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2");
    // Capped-CRF: easy scenes undershoot the cap, motion gets the full budget.
    // Hi-res sessions get the extra encoder effort and quality target.
    expect(args).toContain("-preset faster");
    expect(args).toContain("-crf 18");
    expect(args).toContain("-maxrate 2000k");
    expect(args).not.toContain("-b:v");
    expect(args).toContain("-bf 0");
    // Periodic IDRs (2s at hi-res): intra-refresh was reverted — its single
    // start-of-session IDR made re-entry hang whenever those packets dropped.
    expect(args).toContain("-force_key_frames expr:eq(t,0)+gte(t,n_forced*2)");
    expect(args).not.toContain("intra-refresh");
  });

  it("honors negotiated dimensions at any bitrate (no starved downscaling)", () => {
    // Field 2026-10-01: downscaling 1280x720 to 854x480 at low bitrate caused
    // blank screen. Home enforces BOTH bitrate AND dimensions — honor the ask.
    const args = buildLiveFfmpegArgs(
      liveInput({ video: { ...liveInput().video, width: 1280, height: 720, maxBitrateKbps: 132 } }),
    ).join(" ");

    expect(args).toContain("scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720");
    expect(args).toContain("-maxrate 132k");
  });

  it("pads to exact negotiated dimensions for all aspect ratios", () => {
    // Field 2026-10-01: 4:3 source (2560×1920) scaled to fit 1280×720 (16:9) becomes
    // 960×720 without padding. Home expects EXACT 1280×720 → blank. Pad fills the gap.
    const input720p = liveInput({ video: { ...liveInput().video, width: 1280, height: 720 } });
    const args720p = buildLiveFfmpegArgs(input720p).join(" ");
    
    // Should scale to fit then pad to exact 1280×720
    expect(args720p).toContain("scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2");
    
    // Same for other resolutions
    const input1080p = liveInput({ video: { ...liveInput().video, width: 1920, height: 1080 } });
    const args1080p = buildLiveFfmpegArgs(input1080p).join(" ");
    expect(args1080p).toContain("pad=1920:1080:(ow-iw)/2:(oh-ih)/2");
  });

  it("enables the intra-refresh experiment with ARGUS_LIVE_INTRA=1", () => {
    process.env.ARGUS_LIVE_INTRA = "1";
    try {
      const args = buildLiveFfmpegArgs(liveInput()).join(" ");
      expect(args).toContain("-x264opts intra-refresh=1");
      expect(args).not.toContain("-force_key_frames");
    } finally {
      delete process.env.ARGUS_LIVE_INTRA;
    }
  });

  it("keeps 1s periodic IDRs at the tile tier", () => {
    const args = buildLiveFfmpegArgs(
      liveInput({ video: { ...liveInput().video, width: 640, height: 360, maxBitrateKbps: 600 } }),
    ).join(" ");

    expect(args).toContain("-c:v libx264");
    expect(args).toContain("-tune zerolatency");
    expect(args).toContain("-crf 20");
    expect(args).toContain("-maxrate 600k");
    expect(args).toContain("-force_key_frames expr:eq(t,0)+gte(t,n_forced*1)");
    expect(args).toContain("scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=640:360");
            expect(args).not.toContain("-hwaccel");
  });

  it("injects in-band SPS/PPS on every keyframe for reliable HomeKit unlock", () => {
    // Field 2026-10-02: even with fast encode (~0.7s first frame) and periodic keyframes,
    // Home showed endless spinner. dump_extra=freq=keyframe ensures parameter sets are
    // in-band on every IDR so dropped initial extradata or strict in-band requirements
    // don't prevent picture unlock.
    const args = buildLiveFfmpegArgs(liveInput()).join(" ");
    expect(args).toContain("-bsf:v dump_extra=freq=keyframe");
  });

  it("encodes with Baseline H.264 profile for Apple Home compatibility", () => {
    // Field 2026-10-01: High profile with dump_extra still caused "No Response"
    // on video-only live. Force Baseline encoding as the Home-friendly path.
    const argsHigh = buildLiveFfmpegArgs(liveInput({ video: { ...liveInput().video, profile: "high" } })).join(" ");
    const argsMain = buildLiveFfmpegArgs(liveInput({ video: { ...liveInput().video, profile: "main" } })).join(" ");
    const argsBaseline = buildLiveFfmpegArgs(liveInput({ video: { ...liveInput().video, profile: "baseline" } })).join(" ");
    
    // All should encode with baseline regardless of input profile
    expect(argsHigh).toContain("-profile:v baseline");
    expect(argsMain).toContain("-profile:v baseline");
    expect(argsBaseline).toContain("-profile:v baseline");
    
    // Should NOT encode with high or main
    expect(argsHigh).not.toContain("-profile:v high");
    expect(argsMain).not.toContain("-profile:v main");
  });

  it("passes video through untouched in copy mode (no encode, no scaling, no keyframe forcing)", () => {
    const args = buildLiveFfmpegArgs(liveInput({ videoMode: "copy" })).join(" ");

    expect(args).toContain("-c:v copy");
    expect(args).not.toContain("libx264");
    expect(args).not.toContain("scale=");
    expect(args).not.toContain("-force_key_frames");
    expect(args).not.toContain("-b:v");
    // Copy trims input analysis to 100ms — when stream is pre-warmed, faster analysis
    // means faster first frame out. Fails fast when stream is cold (bench 2026-10-01).
    expect(args).toContain("-analyzeduration 50000");
    expect(args).toContain("-probesize 100000");
    // Audio is still transcoded to Opus, and SRTP targeting is unchanged.
    expect(args).toContain("-c:a libopus");
    expect(args).toContain("-srtp_out_params VIDEOKEY==");
    // hi-res sessions (copy included) ship small packets for WiFi resilience
    expect(args).toContain("srtp://192.168.1.50:50000?rtcpport=50000&localrtcpport=60000&pkt_size=564");
    expect(args).toContain("-payload_type 99");
  });

  it("caps RTSP input analysis so the stream starts fast (else HomeKit times out)", () => {
    const args = buildLiveFfmpegArgs(liveInput());
    // Low-latency flags must come BEFORE -i to apply to the input. Reduced to 100ms
    // (2026-10-01): when pre-warming works, go2rtc's producer is ready and codec detection
    // is instant. Faster analysis = faster first frame when warm, faster failure when cold.
    // Also includes error resilience flags (+discardcorrupt+genpts) for corrupt go2rtc input.
    const inputIndex = args.indexOf("-i");
    const head = args.slice(0, inputIndex).join(" ");
    expect(head).toContain("-progress pipe:2");
    expect(head).toContain("-fflags +discardcorrupt+genpts+nobuffer");
    expect(head).toContain("-probesize 100000");
    expect(head).toContain("-analyzeduration 50000");
    expect(head).toContain("-err_detect ignore_err");
  });

  it("targets the device address with matching SRTP params and SSRCs", () => {
    const args = buildLiveFfmpegArgs(liveInput());
    const joined = args.join(" ");

    // video SRTP out
    expect(joined).toContain("-srtp_out_params VIDEOKEY==");
    expect(joined).toContain("srtp://192.168.1.50:50000?rtcpport=50000&localrtcpport=60000&pkt_size=564");
    // audio SRTP out
    expect(joined).toContain("-srtp_out_params AUDIOKEY==");
    expect(joined).toContain("srtp://192.168.1.50:50002?rtcpport=50002&localrtcpport=60002");
    expect(joined).toContain("-ssrc 1");
    expect(joined).toContain("-ssrc 2");
  });
});

describe("effectiveBitrateKbps", () => {
  it("honors the negotiated bitrate exactly (no floors)", () => {
    // Field 2026-10-01: asked=299k serving=2000k (6.7x over) → Home blank despite
    // healthy encode. Home ENFORCES its budget; we must honor the negotiation.
    expect(effectiveBitrateKbps(1920, 1080, 802)).toBe(802);
    expect(effectiveBitrateKbps(1280, 720, 299)).toBe(299);
    expect(effectiveBitrateKbps(640, 360, 132)).toBe(132);
    expect(effectiveBitrateKbps(320, 240, 100)).toBe(100);
  });

  it("still honors higher negotiated bitrates when Home allows them", () => {
    expect(effectiveBitrateKbps(1280, 720, 4500)).toBe(4500);
    expect(effectiveBitrateKbps(1920, 1080, 5000)).toBe(5000);
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
  it("advertises the HomeKit-required crypto suite, H.264 levels, and AAC-ELD + Opus audio", () => {
    const delegate = new ArgusStreamingDelegate("Backyard Left", "rtsp://x", cacheWith(Buffer.from([0xff, 0xd8])));
    const opts = buildCameraControllerOptions(delegate);

    expect(opts.cameraStreamCount).toBe(2);
    expect(opts.streamingOptions.supportedCryptoSuites).toContain(0); // AES_CM_128_HMAC_SHA1_80
    const resolutions = opts.streamingOptions.video.resolutions.map((r) => `${r[0]}x${r[1]}`);
    expect(resolutions).toContain("1280x720");
    // Advertise both AAC-ELD (Apple's preference) and Opus
    expect(opts.streamingOptions.audio?.codecs).toHaveLength(2);
    expect(opts.streamingOptions.audio?.codecs?.[0]?.type).toBe("AAC-eld");
    expect(opts.streamingOptions.audio?.codecs?.[1]?.type).toBe("OPUS");
  });

  it("advertises ONLY Baseline H.264 profile for Apple Home compatibility", () => {
    // Field 2026-10-01: High profile with dump_extra → "No Response". Force
    // Baseline advertisement so Home negotiates it (iOS caches profile list).
    const delegate = new ArgusStreamingDelegate("Backyard Left", "rtsp://x", cacheWith(Buffer.from([0xff, 0xd8])));
    const opts = buildCameraControllerOptions(delegate);

    const profiles = opts.streamingOptions.video.codec.profiles;
    expect(profiles).toHaveLength(1);
    expect(profiles).toContain(0); // H264Profile.BASELINE
    expect(profiles).not.toContain(1); // H264Profile.MAIN
    expect(profiles).not.toContain(2); // H264Profile.HIGH
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
    expect(args.join(" ")).toContain("scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720");
    // Honor the negotiated bitrate exactly (field 2026-10-01: floor caused blank screen).
    expect(args.join(" ")).toContain("-maxrate 299k");
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
    expect(secondArgs).toContain("scale=896:672:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=896:672");
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

  it("advertises firmware version 1.3.2 for video-only prepareStream fix", () => {
    expect(ARGUS_FIRMWARE_REVISION).toBe("1.3.2");
  });

  it("omits audio from prepareStream response in video-only mode", async () => {
    const delegate = new ArgusStreamingDelegate(
      "Garage Door",
      "rtsp://127.0.0.1:8554/garage-door-sub",
      cacheWith(Buffer.from([0xff, 0xd8])),
      { includeAudio: false }, // Video-only mode
    );

    const response = await new Promise<{ video: unknown; audio?: unknown }>((resolve, reject) => {
      delegate.prepareStream(
        {
          sessionID: "video-only-test",
          targetAddress: "192.168.1.50",
          video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
          audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) },
        } as PrepareStreamRequest,
        (error, res) => (error ? reject(error) : resolve(res!)),
      );
    });

    // Video-only mode: response should NOT include audio
    // This tells Home not to wait for audio packets that will never arrive
    expect(response.video).toBeDefined();
    expect(response.audio).toBeUndefined();
  });
});
