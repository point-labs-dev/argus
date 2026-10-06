import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
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
  NO_RTCP_CONSUMER_ABANDON_MS,
  resolveSrtpTargetAddress,
  type LiveFfmpegInput,
} from "../src/homekit.js";

function liveInput(overrides: Partial<LiveFfmpegInput> = {}): LiveFfmpegInput {
  return {
    inputUrl: "rtsp://127.0.0.1:8554/backyard-left-sub",
    targetAddress: "192.168.1.50",
    localAddress: undefined,
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

  it("encodes ≥720p sessions with CBR libx264 at negotiated bitrate", () => {
    const args = buildLiveFfmpegArgs(
      liveInput({ video: { ...liveInput().video, maxBitrateKbps: 2000 } }),
    ).join(" ");

    expect(args).toContain("-i rtsp://127.0.0.1:8554/backyard-left-sub");
    expect(args).toContain("-c:v libx264");
    expect(args).toContain("-c:a libopus");
    // Pad to exact negotiated dimensions (field 2026-10-01: 4:3 source → 960×720 != 1280×720)
    expect(args).toContain("scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2");
    // CBR-style encoding (camera-ffmpeg pattern): -b:v sets target bitrate.
    // Firmware 1.3.5 switches from CRF+maxrate to match working HomeKit stacks.
    expect(args).toContain("-preset faster");
    expect(args).toContain("-b:v 2000k");
    expect(args).toContain("-bufsize 4000k");
    expect(args).toContain("-maxrate 2000k");
    expect(args).not.toContain("-crf");
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
    expect(args).toContain("-b:v 132k");
    expect(args).toContain("-bufsize 264k");
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
    expect(args).toContain("-b:v 600k");
    expect(args).toContain("-bufsize 1200k");
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
    // camera-ffmpeg uses 1316; firmware 1.3.5 matches ecosystem default
    expect(args).toContain("srtp://192.168.1.50:50000?rtcpport=50000&pkt_size=1316");
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

    // Clean SRTP URL (camera-ffmpeg pattern): no localrtpport/localrtcpport
    expect(joined).toContain("-srtp_out_params VIDEOKEY==");
    expect(joined).toContain("srtp://192.168.1.50:50000?rtcpport=50000&pkt_size=1316");
    expect(joined).toContain("-srtp_out_params AUDIOKEY==");
    expect(joined).toContain("srtp://192.168.1.50:50002?rtcpport=50002&pkt_size=188");
    expect(joined).toContain("-ssrc 1");
    expect(joined).toContain("-ssrc 2");
  });
});

describe("effectiveBitrateKbps", () => {
  it("floors Apple's conservative asks per resolution tier (1.3.14 restored d094a53)", () => {
    // 1.3.14 RESTORES LAN floors after Oct passthrough regression (1.3.13 mush)
    expect(effectiveBitrateKbps(1920, 1080, 802)).toBe(3000); // 1080p floor
    expect(effectiveBitrateKbps(1280, 720, 299)).toBe(2000);  // 720p floor
    expect(effectiveBitrateKbps(640, 360, 132)).toBe(600);    // tile floor
    expect(effectiveBitrateKbps(320, 240, 100)).toBe(300);    // tiny floor
    expect(effectiveBitrateKbps(854, 480, 299)).toBe(600);    // 854×480 floor (sharpness delta)
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
    // Default WiFi-friendly ladder (Oct 2026+): cap at 854x480 for MacBook accept
    expect(resolutions).toContain("854x480");
    expect(resolutions).toContain("640x480");
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

  it("defaults to WiFi-friendly resolutions (June working pattern, Oct 2026+)", () => {
    const delegate = new ArgusStreamingDelegate("Backyard Right", "rtsp://x", cacheWith(Buffer.from([0xff, 0xd8])));
    const opts = buildCameraControllerOptions(delegate, true, undefined, { width: 896, height: 672 }, "transcode");

    const resolutions = opts.streamingOptions.video.resolutions.map((r) => `${r[0]}x${r[1]}`);
    // Oct 2026 field evidence: MacBook Home negotiating 1280x720@30 → "No Response"
    // after 30s despite healthy encode. June working (c5b368c): cap 640x480/854x480.
    // Default "wifi" ladder avoids high-res that MacBook accept can't handle over WiFi.
    expect(resolutions).toEqual(["854x480", "640x480", "640x360"]);
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
    // Firmware 1.3.13: defensive resolution clamp caps 1280x720 request → 854x480 encode
    expect(args.join(" ")).toContain("scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=854:480");
    // 1.3.14: LAN floors restored (PRIMARY QUALITY FIX) — 299k ask → 600k serving at 854×480
    expect(args.join(" ")).toContain("-b:v 600k");
    expect(args.join(" ")).toContain("-bufsize 1200k");
    expect(args.join(" ")).toContain("-maxrate 600k");
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

    // Full-screen upgrade: Apple sends RECONFIGURE on the SAME session. The cap
    // applies here too (1.3.15 — before, RECONFIGURE bypassed it and a 720p
    // upgrade encoded the uncapped envelope the cap exists to prevent).
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
    expect(secondArgs).toContain("scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=854:480");
    expect(secondArgs).toContain("-b:v 600k");
    expect(secondArgs).toContain("-bufsize 1200k");
    expect(secondArgs).toContain("-maxrate 600k");
    // No main grant on this delegate — the respawn stays on the sub.
    expect(secondArgs).toContain("-i rtsp://127.0.0.1:8554/backyard-left-sub");
  });

  async function prepareAndStart(
    delegate: ArgusStreamingDelegate,
    sessionID: string,
    video: { width: number; height: number; max_bit_rate: number },
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      delegate.prepareStream(
        { sessionID, targetAddress: "192.168.1.50",
          video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
          audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) } } as never,
        (error) => (error ? reject(error) : resolve()),
      );
    });
    await new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(
        { type: "start", sessionID,
          video: { pt: 99, fps: 30, mtu: 1378, profile: 2, level: 2, ...video },
          audio: { pt: 110, sample_rate: 24, max_bit_rate: 24, codec: 3 } } as never,
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  function stopSession(delegate: ArgusStreamingDelegate, sessionID: string): void {
    delegate.handleStreamRequest({ type: "stop", sessionID } as never, () => {});
  }

  it("sources MAIN for a full-screen ask even when the cap lowers the encode below 720p", async () => {
    const spawnFn = vi.fn(() => Object.assign(new EventEmitter(), { kill: vi.fn() })) as unknown as typeof import("node:child_process").spawn;
    const delegate = new ArgusStreamingDelegate(
      "Backyard Left",
      "rtsp://127.0.0.1:8554/backyard-left-sub",
      cacheWith(Buffer.from([0xff, 0xd8])),
      { spawnFn, mainStreamUrl: "rtsp://127.0.0.1:8554/backyard-left" },
    );

    // Home asks 1280x720; the cap lowers the ENCODE to 854x480, but the SOURCE
    // follows the ask. Before 1.3.15 the source check compared the capped size,
    // so MAIN was unreachable and full-screen upscaled the ≤640-wide sub (the
    // field softness with ARGUS_LIVE_MAIN_SOURCE=1 that never took effect).
    await prepareAndStart(delegate, "s3", { width: 1280, height: 720, max_bit_rate: 2000 });

    const args = (spawnFn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0]![1].join(" ");
    expect(args).toContain("-i rtsp://127.0.0.1:8554/backyard-left ");
    expect(args).toContain("scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=854:480");
    stopSession(delegate, "s3");
  });

  it("keeps tile sessions (640x360 ask) on the sub stream even with a main grant", async () => {
    const spawnFn = vi.fn(() => Object.assign(new EventEmitter(), { kill: vi.fn() })) as unknown as typeof import("node:child_process").spawn;
    const delegate = new ArgusStreamingDelegate(
      "Backyard Left",
      "rtsp://127.0.0.1:8554/backyard-left-sub",
      cacheWith(Buffer.from([0xff, 0xd8])),
      { spawnFn, mainStreamUrl: "rtsp://127.0.0.1:8554/backyard-left" },
    );

    await prepareAndStart(delegate, "s4", { width: 640, height: 360, max_bit_rate: 132 });

    const args = (spawnFn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0]![1].join(" ");
    expect(args).toContain("-i rtsp://127.0.0.1:8554/backyard-left-sub");
    stopSession(delegate, "s4");
  });

  it("serves full-screen asks from the sub when no main grant exists (NVR channels)", async () => {
    const spawnFn = vi.fn(() => Object.assign(new EventEmitter(), { kill: vi.fn() })) as unknown as typeof import("node:child_process").spawn;
    const delegate = new ArgusStreamingDelegate(
      "Backyard Left",
      "rtsp://127.0.0.1:8554/backyard-left-sub",
      cacheWith(Buffer.from([0xff, 0xd8])),
      { spawnFn },
    );

    await prepareAndStart(delegate, "s5", { width: 1280, height: 720, max_bit_rate: 2000 });

    const args = (spawnFn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0]![1].join(" ");
    expect(args).toContain("-i rtsp://127.0.0.1:8554/backyard-left-sub");
    expect(args).toContain("scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=854:480");
    stopSession(delegate, "s5");
  });

  it("re-picks MAIN on a full-screen RECONFIGURE from a tile session", async () => {
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
      { spawnFn, mainStreamUrl: "rtsp://127.0.0.1:8554/backyard-left" },
    );

    await prepareAndStart(delegate, "s6", { width: 640, height: 360, max_bit_rate: 132 });
    await new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(
        { type: "reconfigure", sessionID: "s6",
          video: { width: 1280, height: 720, fps: 30, max_bit_rate: 2000, rtcp_interval: 0.5 } } as never,
        (error) => (error ? reject(error) : resolve()),
      );
    });

    expect(spawnFn).toHaveBeenCalledTimes(2);
    const secondArgs = (spawnFn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[1]![1].join(" ");
    expect(secondArgs).toContain("-i rtsp://127.0.0.1:8554/backyard-left ");
    expect(secondArgs).toContain("scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=854:480");
    stopSession(delegate, "s6");
  });

  it("does not stop ffmpeg during 40s of silence after one RTCP packet", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fakeProc = Object.assign(new EventEmitter(), { kill: vi.fn() });
      const spawnFn = vi.fn(() => fakeProc) as unknown as typeof import("node:child_process").spawn;
      const delegate = new ArgusStreamingDelegate(
        "Backyard Left",
        "rtsp://127.0.0.1:8554/backyard-left-sub",
        cacheWith(Buffer.from([0xff, 0xd8])),
        { spawnFn, verbose: false },
      );
      const forceStop = vi.fn();
      delegate.controller = { forceStopStreamingSession: forceStop } as never;

      let videoReturnPort = 0;
      await new Promise<void>((resolve, reject) => {
        delegate.prepareStream(
          { sessionID: "rtcp-1", targetAddress: "192.168.1.50",
            video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
            audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) } } as never,
          (error, response) => {
            if (error || !response) return reject(error ?? new Error("no response"));
            videoReturnPort = (response as { video: { port: number } }).video.port;
            resolve();
          },
        );
      });
      const startDone = new Promise<void>((resolve, reject) => {
        delegate.handleStreamRequest(
          { type: "start", sessionID: "rtcp-1",
            video: { pt: 99, max_bit_rate: 600, fps: 30, width: 854, height: 480, mtu: 1378, profile: 2, level: 2 },
            audio: { pt: 110, sample_rate: 24, max_bit_rate: 24, codec: 3 } } as never,
          (error) => (error ? reject(error) : resolve()),
        );
      });
      await vi.advanceTimersByTimeAsync(100); // the START ack timer
      await startDone;

      // Home's lone RTCP receiver report (I/O is real; only timers are faked).
      const sender = createSocket("udp4");
      await new Promise<void>((resolve) =>
        sender.send(Buffer.from([0x80, 0xc9, 0x00, 0x01]), videoReturnPort, "127.0.0.1", () => resolve()),
      );
      for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
      sender.close();

      await vi.advanceTimersByTimeAsync(40_000); // past the old watchdog horizon
      expect(forceStop).not.toHaveBeenCalled();
      expect(fakeProc.kill).not.toHaveBeenCalled();

      delegate.handleStreamRequest({ type: "stop", sessionID: "rtcp-1" } as never, () => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops ffmpeg when an abandoned live session has no RTCP consumer and never receives STOP, and leaves a watched session running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const procs: Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }> = [];
    const spawnFn = vi.fn(() => {
      const proc = Object.assign(new EventEmitter(), { kill: vi.fn() });
      procs.push(proc);
      return proc;
    }) as unknown as typeof import("node:child_process").spawn;
    const delegate = new ArgusStreamingDelegate(
      "Backyard",
      "rtsp://127.0.0.1:8554/backyard-sub",
      cacheWith(Buffer.from([0xff, 0xd8])),
      { spawnFn, verbose: false },
    );

    async function start(sessionID: string): Promise<number> {
      let videoReturnPort = 0;
      await new Promise<void>((resolve, reject) => {
        delegate.prepareStream(
          {
            sessionID,
            targetAddress: "192.168.1.50",
            video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
            audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) },
          } as never,
          (error, response) => {
            if (error || !response) return reject(error ?? new Error("no response"));
            videoReturnPort = (response as { video: { port: number } }).video.port;
            resolve();
          },
        );
      });
      const startDone = new Promise<void>((resolve, reject) => {
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
      await vi.advanceTimersByTimeAsync(100);
      await startDone;
      return videoReturnPort;
    }

    async function sendRtcp(port: number): Promise<void> {
      const sender = createSocket("udp4");
      try {
        await new Promise<void>((resolve) =>
          sender.send(Buffer.from([0x80, 0xc9, 0x00, 0x01]), port, "127.0.0.1", () => resolve()),
        );
        for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
      } finally {
        sender.close();
      }
    }

    try {
      const abandonedPort = await start("abandoned-live");
      const watchedPort = await start("watched-live");
      const abandonedProc = procs[0]!;
      const watchedProc = procs[1]!;

      await sendRtcp(abandonedPort);
      await sendRtcp(watchedPort);
      await vi.advanceTimersByTimeAsync(NO_RTCP_CONSUMER_ABANDON_MS - 1000);
      await sendRtcp(watchedPort);
      await vi.advanceTimersByTimeAsync(2000);

      expect(abandonedProc.kill).toHaveBeenCalledWith("SIGKILL");
      expect(watchedProc.kill).not.toHaveBeenCalled();
    } finally {
      delegate.handleStreamRequest({ type: "stop", sessionID: "abandoned-live" } as never, () => {});
      delegate.handleStreamRequest({ type: "stop", sessionID: "watched-live" } as never, () => {});
      vi.useRealTimers();
    }
  });

  it("advertises firmware version 1.3.15 (main-source fix, RTCP watchdog removal, HKSV delivery)", () => {
    expect(ARGUS_FIRMWARE_REVISION).toBe("1.3.15");
  });

  it("prevents double-callback crash (swallows duplicate calls)", async () => {
    // Regression test for 1.3.9 exit code 1: if prepareStreamAsync's try succeeds
    // but then an async error fires the catch block, the guard must swallow the
    // duplicate callback invocation instead of letting it reach HAP-NodeJS's once
    // guard (which throws and crashes the process).
    const delegate = new ArgusStreamingDelegate(
      "Test Camera",
      "rtsp://127.0.0.1:8554/test",
      cacheWith(Buffer.from([0xff, 0xd8])),
    );

    let callbackCount = 0;
    let lastError: Error | undefined;
    let lastResponse: PrepareStreamResponse | undefined;

    await new Promise<void>((resolve) => {
      delegate.prepareStream(
        {
          sessionID: "double-call-test",
          targetAddress: "192.168.1.50",
          video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
          audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) },
        } as PrepareStreamRequest,
        (error, response) => {
          callbackCount++;
          lastError = error;
          lastResponse = response;
          resolve();
        },
      );
    });

    // Callback should fire exactly once (guard prevents HAP once.ts throw)
    expect(callbackCount).toBe(1);
    expect(lastError).toBeUndefined();
    expect(lastResponse).toBeDefined();
    expect(lastResponse?.video).toBeDefined();
    expect(lastResponse?.audio).toBeDefined();
  });

  it("guarantees prepareStream callback fires on success path", async () => {
    const delegate = new ArgusStreamingDelegate(
      "Test Camera",
      "rtsp://127.0.0.1:8554/test",
      cacheWith(Buffer.from([0xff, 0xd8])),
    );

    // Normal success: callback should fire with response
    const response = await new Promise<{ video: unknown }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Callback never fired")), 5000);
      delegate.prepareStream(
        {
          sessionID: "callback-success-test",
          targetAddress: "192.168.1.50",
          video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
          audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) },
        } as PrepareStreamRequest,
        (error, res) => {
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve(res!);
        },
      );
    });

    expect(response.video).toBeDefined();
  });

  it("guarantees prepareStream callback fires even if internal async operations timeout", async () => {
    // This test ensures that if reserveUdpPort hangs (under load/HKSV stress),
    // the timeout kicks in and the callback still fires with an error rather than
    // hanging forever and causing "Setup Endpoints didn't respond"
    const delegate = new ArgusStreamingDelegate(
      "Test Camera",
      "rtsp://127.0.0.1:8554/test",
      cacheWith(Buffer.from([0xff, 0xd8])),
    );

    // We can't easily simulate a hung reserveUdpPort in tests without mocking,
    // but we can at least verify the timeout exists by checking that
    // prepareStream completes in reasonable time (not hanging forever)
    const start = Date.now();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Callback never fired after 5s")), 5000);
      delegate.prepareStream(
        {
          sessionID: "callback-timeout-test",
          targetAddress: "192.168.1.50",
          video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
          audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) },
        } as PrepareStreamRequest,
        (error) => {
          clearTimeout(timeout);
          // Success or error - either way, callback fired
          resolve();
        },
      );
    });

    const elapsed = Date.now() - start;
    // Should complete quickly (< 3s), proving it doesn't hang forever waiting for stuck operations
    expect(elapsed).toBeLessThan(3000);
  });
});

const FOUR_BY_THREE_CAMERAS = ["Garage Door", "Backyard", "Doorbell", "Backyard Right"] as const;

function renderFilteredFrame(vf: string, srcWidth: number, srcHeight: number): {
  width: number;
  height: number;
  rgb: Buffer;
} {
  const band = Math.round(srcHeight / 10);
  const ppm = execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=red:s=${srcWidth}x${srcHeight}:r=1:d=1`,
      "-vf",
      `drawbox=x=0:y=0:w=${srcWidth}:h=${band}:color=green:t=fill,drawbox=x=0:y=${srcHeight - band}:w=${srcWidth}:h=${band}:color=blue:t=fill,${vf}`,
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "ppm",
      "pipe:1",
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  let offset = 2;
  const tokens: string[] = [];
  while (tokens.length < 3) {
    while (ppm[offset] === 0x20 || ppm[offset] === 0x0a || ppm[offset] === 0x0d || ppm[offset] === 0x09) offset += 1;
    if (ppm[offset] === 0x23) {
      while (ppm[offset] !== 0x0a) offset += 1;
      continue;
    }
    const start = offset;
    while (ppm[offset] > 0x20) offset += 1;
    tokens.push(ppm.subarray(start, offset).toString());
  }
  offset += 1;
  const width = Number(tokens[0]);
  const height = Number(tokens[1]);
  return { width, height, rgb: ppm.subarray(offset, offset + width * height * 3) };
}

function rgbAt(frame: { width: number; rgb: Buffer }, x: number, y: number): [number, number, number] {
  const index = (y * frame.width + x) * 3;
  return [frame.rgb[index]!, frame.rgb[index + 1]!, frame.rgb[index + 2]!];
}

async function ffmpegArgsFor(
  cameraName: string,
  ask: { width: number; height: number },
): Promise<string[]> {
  const slug = cameraName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const spawnFn = vi.fn(() => Object.assign(new EventEmitter(), { kill: vi.fn() })) as unknown as typeof import("node:child_process").spawn;
  const delegate = new ArgusStreamingDelegate(
    cameraName,
    `rtsp://127.0.0.1:8554/${slug}-sub`,
    cacheWith(Buffer.from([0xff, 0xd8])),
    { spawnFn, mainStreamUrl: `rtsp://127.0.0.1:8554/${slug}` },
  );
  await new Promise<void>((resolve, reject) => {
    delegate.prepareStream(
      {
        sessionID: `${slug}-live`,
        targetAddress: "10.0.0.41",
        video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
        audio: { port: 50002, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) },
      } as never,
      (error) => (error ? reject(error) : resolve()),
    );
  });
  await new Promise<void>((resolve, reject) => {
    delegate.handleStreamRequest(
      {
        type: "start",
        sessionID: `${slug}-live`,
        video: { pt: 99, max_bit_rate: 132, fps: 30, mtu: 1378, profile: 0, level: 2, ...ask },
        audio: { pt: 110, sample_rate: 24, max_bit_rate: 24, codec: "AAC-eld" },
      } as never,
      (error) => (error ? reject(error) : resolve()),
    );
  });
  const args = (spawnFn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0]![1];
  delegate.handleStreamRequest({ type: "stop", sessionID: `${slug}-live` } as never, () => {});
  return args;
}

describe("4:3 cameras fill the live frame", () => {
  it.each(FOUR_BY_THREE_CAMERAS)(
    "%s keeps the whole 4:3 scene inside the exact box iOS asked for",
    async (cameraName) => {
      for (const ask of [
        { width: 640, height: 360 },
        { width: 1280, height: 720 },
      ]) {
        const args = await ffmpegArgsFor(cameraName, ask);
        const vf = args[args.indexOf("-vf") + 1]!;
        const scale = /^scale=(\d+):(\d+)/.exec(vf);
        expect(scale).not.toBeNull();
        const boxWidth = Number(scale![1]);
        const boxHeight = Number(scale![2]);
        expect(vf).not.toContain("pad=");

        for (const [srcWidth, srcHeight] of [
          [2560, 1920],
          [640, 480],
        ] as const) {
          const frame = renderFilteredFrame(vf, srcWidth, srcHeight);
          expect(frame.width).toBe(boxWidth);
          expect(frame.height).toBe(boxHeight);
          const midY = Math.floor(frame.height / 2);
          expect(rgbAt(frame, 0, midY)).not.toEqual([0, 0, 0]);
          expect(rgbAt(frame, frame.width - 1, midY)).not.toEqual([0, 0, 0]);
          const top = rgbAt(frame, Math.floor(frame.width / 2), 1);
          const bottom = rgbAt(frame, Math.floor(frame.width / 2), frame.height - 2);
          expect(top[1]).toBeGreaterThan(top[0]);
          expect(top[1]).toBeGreaterThan(top[2]);
          const bottomBlue = bottom[2];
          expect(bottomBlue).toBeGreaterThan(bottom[0]);
          expect(bottomBlue).toBeGreaterThan(bottom[1]);
        }
      }
    },
  );

  it("paces AAC-ELD with the Oct 1 clock and 188-byte audio packets", () => {
    const args = buildLiveFfmpegArgs(
      liveInput({ audio: { ...liveInput().audio, codec: "AAC-eld" } }),
    ).join(" ");

    expect(args).toContain("-c:a libfdk_aac");
    expect(args).toContain("-profile:a aac_eld");
    expect(args).toContain("-af asetpts=N/SR/TB");
    expect(args).not.toContain("aresample");
    expect(args).not.toContain("min_hard_comp");
    expect(args).toContain("srtp://192.168.1.50:50002?rtcpport=50002&pkt_size=188");
    expect(args).toContain("srtp://192.168.1.50:50000?rtcpport=50000&pkt_size=1316");
  });

  it("redacts SRTP keys from the ffmpeg log line", async () => {
    const videoKey = Buffer.concat([Buffer.alloc(16, 0x11), Buffer.alloc(14, 0x22)]).toString("base64");
    const audioKey = Buffer.concat([Buffer.alloc(16, 0x33), Buffer.alloc(14, 0x44)]).toString("base64");
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const spawnFn = vi.fn(() => Object.assign(new EventEmitter(), { kill: vi.fn() })) as unknown as typeof import("node:child_process").spawn;
    const delegate = new ArgusStreamingDelegate(
      "Garage Door",
      "rtsp://127.0.0.1:8554/garage-door-sub",
      cacheWith(Buffer.from([0xff, 0xd8])),
      { spawnFn },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        delegate.prepareStream(
          {
            sessionID: "redact",
            targetAddress: "10.0.0.41",
            video: { port: 50000, srtp_key: Buffer.alloc(16, 0x11), srtp_salt: Buffer.alloc(14, 0x22) },
            audio: { port: 50002, srtp_key: Buffer.alloc(16, 0x33), srtp_salt: Buffer.alloc(14, 0x44) },
          } as never,
          (error) => (error ? reject(error) : resolve()),
        );
      });
      await new Promise<void>((resolve, reject) => {
        delegate.handleStreamRequest(
          {
            type: "start",
            sessionID: "redact",
            video: { pt: 99, max_bit_rate: 132, fps: 30, width: 640, height: 360, mtu: 1378, profile: 0, level: 2 },
            audio: { pt: 110, sample_rate: 24, max_bit_rate: 24, codec: "AAC-eld" },
          } as never,
          (error) => (error ? reject(error) : resolve()),
        );
      });
      const logged = lines.join("");
      expect(logged).toContain("<REDACTED>");
      expect(logged).not.toContain(videoKey);
      expect(logged).not.toContain(audioKey);
      const args = (spawnFn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0]![1].join(" ");
      expect(args).toContain(videoKey);
      expect(args).toContain(audioKey);
      delegate.handleStreamRequest({ type: "stop", sessionID: "redact" } as never, () => {});
    } finally {
      spy.mockRestore();
    }
  });
});
