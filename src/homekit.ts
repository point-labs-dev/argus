import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

/**
 * Get the primary LAN IPv4 address for HAP advertising and RTP source binding.
 * Prefers ARGUS_HAP_BIND env var, else first non-internal IPv4 (typically en0 on Mac).
 * Scrypted/homebridge pattern: HAP advertise + ffmpeg localaddr + RTCP bind must match
 * to prevent iOS "Drop RTP from unknown source" on dual-NIC systems.
 * 
 * CRITICAL: Returns IP ADDRESS (e.g. "10.0.0.46"), NEVER interface name (e.g. "en0").
 * Interface names cause DNS getaddrinfo ENOTFOUND errors when passed to socket.bind().
 */
export function getHapBindAddress(): string | undefined {
  if (process.env.ARGUS_HAP_BIND) {
    const envValue = process.env.ARGUS_HAP_BIND;
    // If env var looks like an interface name (not dotted-decimal IP), resolve it
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(envValue)) {
      const ifaces = networkInterfaces();
      const ifaceAddrs = ifaces[envValue];
      if (ifaceAddrs) {
        for (const addr of ifaceAddrs) {
          if (addr.family === "IPv4" && !addr.internal) {
            return addr.address;
          }
        }
      }
      // If interface name not found or no IPv4, log warning and fall through
      console.warn(`[argus] ARGUS_HAP_BIND="${envValue}" is not a valid IP and interface not found; using auto-detect`);
    } else {
      return envValue;
    }
  }
  
  const ifaces = networkInterfaces();
  for (const addresses of Object.values(ifaces)) {
    for (const addr of addresses ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return undefined;
}

import {
  Accessory,
  AudioCodecTypes,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  type CameraControllerOptions,
  type CameraStreamingDelegate,
  Categories,
  Characteristic,
  H264Level,
  H264Profile,
  type PrepareStreamCallback,
  type PrepareStreamRequest,
  type PrepareStreamResponse,
  Service,
  type SnapshotRequest,
  type SnapshotRequestCallback,
  SRTPCryptoSuites,
  type StreamingRequest,
  type StreamRequestCallback,
  StreamRequestTypes,
  uuid,
} from "hap-nodejs";

import type { CameraConfig } from "./config.js";
import { ArgusRecordingDelegate, buildRecordingOptions } from "./recording.js";
import type { SnapshotCache, SnapshotProfile } from "./snapshot-cache.js";
import { emitTelemetry } from "./telemetry.js";

// HomeKit negotiates ONE H.264 profile/level during stream setup and rejects video
// encoded outside it (the device receives SRTP but can't decode → forever-spinner).
// Map its choice to the matching libx264 strings.
const H264_PROFILE_TO_X264: Record<number, string> = {
  [H264Profile.BASELINE]: "baseline",
  [H264Profile.MAIN]: "main",
  [H264Profile.HIGH]: "high",
};
const H264_LEVEL_TO_X264: Record<number, string> = {
  [H264Level.LEVEL3_1]: "3.1",
  [H264Level.LEVEL3_2]: "3.2",
  [H264Level.LEVEL4_0]: "4.0",
};

// Argus serves HomeKit live view from go2rtc's local RTSP restream. We pull the
// H.264 sub stream (light, always H.264 on Reolink — no H.265 transcode) and let
// FFmpeg transcode to the resolution/bitrate HomeKit negotiates. Audio: AAC-ELD when
// negotiated (requires libfdk_aac — use ffmpeg-homebridge via ARGUS_FFMPEG), else Opus.

export interface SrtpParameters {
  /** base64 of the 16-byte key + 14-byte salt that FFmpeg encrypts the outbound stream with. */
  videoParams: string;
  audioParams: string;
}

export interface LiveFfmpegInput {
  /**
   * go2rtc local restream, e.g. rtsp://127.0.0.1:8554/backyard-left-sub.
   * ≥720p transcode sessions get the camera's MAIN restream instead — the
   * 896-wide ext stream has no pixels to fill 1280x720 (see pickInputUrl).
   */
  inputUrl: string;
  targetAddress: string;
  /**
   * Local IP address for ffmpeg SRTP egress (localaddr=). On dual-NIC systems,
   * must match HAP advertised address so iOS doesn't drop RTP from unknown source.
   * Scrypted/homebridge pattern: HAP bind + ffmpeg localaddr + RTCP bind = same IP.
   */
  localAddress?: string;
  /**
   * "transcode" (default) re-encodes to the negotiated envelope — the validated
   * path on real devices. "copy" passes the camera's H.264 sub stream through
   * untouched (no encode latency, native quality, ~zero CPU) but EXPERIMENTAL:
   * macOS Home negotiates 640x360 regardless of what is advertised, receives the
   * native-size stream, renders one frame and stops the session (2026-06-11).
   * Enable via ARGUS_LIVE_COPY=1 to test against other clients (iPhone).
   */
  videoMode: "copy" | "transcode";
  video: {
    port: number;
    localRtcpPort: number;
    ssrc: number;
    payloadType: number;
    maxBitrateKbps: number;
    fps: number;
    width: number;
    height: number;
    mtu: number;
    /** libx264 profile string HomeKit negotiated: "baseline" | "main" | "high". */
    profile: string;
    /** libx264 level string HomeKit negotiated: e.g. "3.1", "4.0". */
    level: string;
    srtpParams: string;
  };
    audio: {
      port: number;
      localRtcpPort: number;
      ssrc: number;
      payloadType: number;
      /** Codec HomeKit negotiated: AudioStreamingCodecType string ("AAC-eld", "OPUS", etc). */
      codec: AudioStreamingCodecType;
      sampleRateKhz: number;
      maxBitrateKbps: number;
      srtpParams: string;
    };
}

/**
 * What we actually encode at, given HomeKit's ask. Apple clients negotiate
 * conservative bitrates (299k for 1280x720, 802k for 1920x1080 on LAN) but
 * field evidence (2026-10-01) shows HONORING the ask is critical: serving
 * 2000k when Home negotiated 299k (6.7x over-budget) caused blank screen
 * despite healthy encode. Home enforces its budget and rejects over-rate streams.
 * Floors removed — the negotiation IS the contract.
 */
export function effectiveBitrateKbps(width: number, height: number, negotiatedKbps: number): number {
  // Honor the negotiated bitrate exactly. The old floor logic (2000k@720p,
  // 3000k@1080p) was causing blank screens when Home enforced its budget.
  // If users need higher quality on fast networks, they should increase the
  // ADVERTISED max bitrate in controller options, not override the negotiation.
  return negotiatedKbps;
}

/**
 * Pure builder for the FFmpeg live-streaming command (video + Opus audio over SRTP).
 * Kept side-effect free so it can be unit-tested without spawning anything.
 */
export function buildLiveFfmpegArgs(input: LiveFfmpegInput, includeAudio = true): string[] {
  const { inputUrl, targetAddress, localAddress, videoMode, video, audio } = input;

  const hiResSession = video.width >= 1280 || video.height >= 720;

  // Progress reporting to stderr (pipe:2) for first-frame telemetry. Works with
  // -loglevel error: progress is always emitted regardless of loglevel, letting us
  // detect frame=1 without switching to a noisier log level.
  const progressArgs = ["-progress", "pipe:2"];

  // Keyframe strategy: periodic IDRs (1s tiles / 2s hi-res). Intra-refresh
  // was tried 2026-06-12 (flat bitrate — no keyframe burst pulse, no trampled
  // audio) and reverted the same evening: a session's ONLY IDR is its first
  // frame, and when those packets drop during the controller's socket ramp
  // there is never another keyframe to lock onto — on-device pattern was
  // "first view perfect, re-entry hangs". At the floored bitrates the burst
  // pathology that motivated it is minor anyway (a 720p IDR ≈ 11% of a 2s
  // budget at 3500k, vs >50% at the old 600k). ARGUS_LIVE_INTRA=1 re-enables
  // the experiment.
  const intraRefresh = process.env.ARGUS_LIVE_INTRA === "1";
  const idrSeconds = hiResSession ? 2 : 1;
  const keyframeArgs = intraRefresh
    ? ["-g", String(video.fps), "-x264opts", "intra-refresh=1"]
    : [
        "-g", String(video.fps * 2 * idrSeconds),
        "-keyint_min", String(video.fps * idrSeconds),
        // Force IDR at t=0 for fast startup (eliminates waiting for camera keyframe),
        // then periodic every idrSeconds. Expr: eq(t,0) fires at start, gte(t,n*idr) is periodic.
        "-force_key_frames", `expr:eq(t,0)+gte(t,n_forced*${idrSeconds})`,
      ];

  // Honor the negotiated dimensions exactly. Earlier logic downscaled starved
  // sessions (<800k) to 854×480, but field evidence (2026-10-01) shows this
  // violates Home's expectations: negotiating 1280×720 then receiving 854×480
  // contributes to blank screen. Home enforces BOTH bitrate AND dimensions.
  const boxWidth = video.width;
  const boxHeight = video.height;

  // Everything transcoded goes through libx264 capped-CRF: constant visual
  // quality up to the bitrate cap, easy scenes undershoot, motion gets the
  // full budget — steadier-looking than chasing a CBR target. (The
  // h264_videotoolbox hardware encoder was tried 2026-06-12 and reverted same
  // day: its -realtime rate control visibly pulses at 2.5-4Mbps. Revisit a
  // zero-copy VT pipeline on the Mac mini only if CPU becomes the constraint.)
  //
  // Output shaping:
  // - Fit within the negotiated box, preserving aspect (homebridge-camera-ffmpeg
  //   pattern). A plain WxH scale would stretch the 4:3 sources (RLC-520A main is
  //   2560x1920) into the 16:9 sizes Apple negotiates. Never exceeds the
  //   negotiated dimensions — oversize is what controllers kill sessions over.
  // - HomeKit needs periodic IDRs and no B-frames, or the iOS client waits
  //   forever for a decodable keyframe (the "spinner that never resolves" symptom).
  // - HomeKit also needs in-band SPS/PPS on every keyframe for reliable decode/unlock.
  //   dump_extra=freq=keyframe injects parameter sets before each IDR so dropped initial
  //   packets or strict in-band requirements don't prevent picture unlock.
  const videoCodecArgs =
    videoMode === "copy"
      ? ["-c:v", "copy"]
      : [
          "-c:v", "libx264",
          // ≥720p is now EVERY session (hi-res-only ladder): spend more encoder
          // effort and quality there — "faster" buys ~10% bitrate efficiency
          // over veryfast and an M-series core does 1080p30 several times over.
          "-preset", hiResSession ? "faster" : "veryfast",
          "-tune", "zerolatency",
          // Force Baseline profile for Apple Home compatibility. Field evidence
          // (2026-10-01): High with dump_extra → "No Response". Baseline is the
          // Home-friendly unlock path. We advertise only Baseline in HAP.
          "-profile:v", "baseline",
          "-level", video.level,
          "-pix_fmt", "yuv420p",
          "-color_range", "tv",
          "-r", String(video.fps),
          // Scale to fit then pad to EXACT negotiated dimensions. Field 2026-10-01:
          // 4:3 source (2560×1920) scaled to 960×720 != negotiated 1280×720 → Home blank.
          // Home enforces exact W×H. Pad centers with black bars (pillarbox/letterbox).
          "-vf", `scale=${boxWidth}:${boxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${boxWidth}:${boxHeight}:(ow-iw)/2:(oh-ih)/2`,
          "-bf", "0",
          ...keyframeArgs,
          // CBR-style encoding (camera-ffmpeg pattern): -b:v sets target bitrate.
          // Firmware 1.3.5 switches from CRF+maxrate to match working HomeKit stacks.
          // CRF+cap can produce burstier NAL timing at 299k/720p than CBR recipes
          // HomeKit ecosystems validate against. Field evidence: CRF failed unlock.
          "-b:v", `${video.maxBitrateKbps}k`,
          "-bufsize", `${video.maxBitrateKbps * 2}k`,
          "-maxrate", `${video.maxBitrateKbps}k`,
          // Inject SPS/PPS before every keyframe (in-band parameter sets). HomeKit may
          // need this to unlock picture: if initial extradata packets drop or device
          // requires in-band params per IDR, out-of-band-only SPS/PPS → forever spinner.
          "-bsf:v", "dump_extra=freq=keyframe",
        ];

  // Cap RTSP stream analysis: FFmpeg's default ~5s runs past HomeKit's stream-start
  // window (spinner → "No Response"). REDUCED to 50ms (from 100ms, originally 200ms):
  // with go2rtc prebuffer, SDP is immediately available and codec params are in the first
  // few packets. 50ms is standard for low-latency transcoding and measured stable on warm
  // starts. Cuts ~50ms from startup path. Still fails fast on cold/missing streams.
  const analyzeArgs = ["-probesize", "100000", "-analyzeduration", "50000"];

  const videoArgs = [
    "-hide_banner",
    "-loglevel", "error",
    ...progressArgs,
    // Resilience flags for corrupt/incomplete input from go2rtc RTSP. Field evidence
    // (2026-10-01): "Error submitting packet to decoder: Invalid data" floods during
    // live sessions — go2rtc RTSP sends bad h264 mid-stream. These flags let FFmpeg
    // discard corrupt packets and regenerate timestamps rather than aborting.
    // +flush_packets ensures immediate transmission (critical for HomeKit real-time).
    "-fflags", "+discardcorrupt+genpts+nobuffer+flush_packets",
    "-flags", "low_delay",
    // Zero muxing delay for real-time RTP streaming (no buffering).
    "-max_delay", "0",
    ...analyzeArgs,
    // SOFTWARE decode only. -hwaccel videotoolbox was tried 2026-06-12 and
    // killed the first real ≥720p phone session: VideoToolbox decode sessions
    // are a finite pool, and with the Apple TV grid (6 concurrent sessions) +
    // HKSV recordings competing, per-picture decode fails continuously — and
    // ffmpeg only falls back to software when INIT fails, not mid-stream — so
    // the viewer gets zero frames (spinner → "not responding", controller
    // STOP at 30s). Software decode of a 2560x1920 main is ~0.3 core and
    // never exhausts.
    "-rtsp_transport", "tcp",
    "-err_detect", "ignore_err",
    "-i", inputUrl,

    // --- video: SRTP out ---
    "-an",
    ...videoCodecArgs,
    "-payload_type", String(video.payloadType),
    "-ssrc", String(video.ssrc),
    "-f", "rtp",
    "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
    "-srtp_out_params", video.srtpParams,
    // Hi-res sessions ship SMALL packets (564 ≤ negotiated MTU): on-device
    // 2026-06-12, 720p at full 1378-byte packets hung direct-WiFi sessions
    // (relay + tile sessions rendered; payload decode-validated locally) —
    // smaller datagrams lose less per WiFi drop and aggregate better. The
    // documented mitigation rung from the goal prompt's WiFi ladder.
    //
    // HomeKit uses RTP/RTCP multiplexing (same port for both). Clean SRTP URL
    // matches camera-ffmpeg: NO localrtpport/localrtcpport (ffmpeg picks source).
    // PRIMARY: Node dgram binds video.localRtcpPort for return RTCP (spawnLive).
    // Belt-and-suspenders: localaddr pins egress to HAP-advertised IP (dual-NIC safety).
    // pkt_size: camera-ffmpeg default 1316; firmware 1.3.5 matches ecosystem.
    `srtp://${targetAddress}:${video.port}?rtcpport=${video.port}&pkt_size=1316${localAddress ? `&localaddr=${localAddress}` : ""}`,
  ];

  if (!includeAudio) {
    return videoArgs;
  }

  // Audio codec: encode what HomeKit negotiated. AAC-ELD requires libfdk_aac
  // (Homebrew ffmpeg-for-homebridge has it; stock builds don't). Opus works
  // everywhere. Critical to match negotiation or Home waits forever (field
  // 2026-10-01: negotiated AAC-eld, sent Opus → spinner despite video frames).
  // request.audio.codec is AudioStreamingCodecType string: "AAC-eld", "OPUS", etc.
  const isAacEld = audio.codec === AudioStreamingCodecType.AAC_ELD;
  const audioCodecArgs = isAacEld
    ? [
        // libfdk_aac is the only reliable AAC-ELD encoder (native aac fails
        // "Profile not supported!", aac_at doesn't expose ELD cleanly). Needs
        // +global_header for RTP streaming. Mini uses ffmpeg-homebridge binary
        // with libfdk_aac via ARGUS_FFMPEG env var.
        "-c:a", "libfdk_aac",
        "-profile:a", "aac_eld",
        "-flags", "+global_header",
        "-b:a", `${audio.maxBitrateKbps}k`,
      ]
    : [
        "-c:a", "libopus",
        "-application", "lowdelay",
        "-frame_duration", "20",
      ];

  return [
    ...videoArgs,
    // --- audio: transcode to negotiated codec, SRTP out ---
    "-vn",
    ...audioCodecArgs,
    // Audio sync: Use aresample with gentle async compensation. Mini f517acc evidence:
    // async=1000:first_pts=0 showed Run1 −261 (better than baseline −360!) but Run2
    // −1380 (much worse, degradation). High async value + first_pts causes instability.
    // Trying minimal compensation async=1 (1 sample/sec max, not deprecated flag) without
    // first_pts. Lets video CFR (-r 30) lead; audio resampler makes micro-adjustments
    // without aggressive stretching or forced initial offset. Gentler than async=1000,
    // more stable than no sync (baseline −360 consistent but failing).
    "-af", "aresample=async=1:min_hard_comp=0.01",
    "-ac", "1",
    "-ar", `${audio.sampleRateKhz}k`,
    "-b:a", `${audio.maxBitrateKbps}k`,
    "-payload_type", String(audio.payloadType),
    "-ssrc", String(audio.ssrc),
    "-f", "rtp",
    "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
    "-srtp_out_params", audio.srtpParams,
    // Same SRTP pattern as video (clean URL + localaddr + Node return-bind)
    `srtp://${targetAddress}:${audio.port}?rtcpport=${audio.port}&pkt_size=1316${localAddress ? `&localaddr=${localAddress}` : ""}`,
  ];
}

/**
 * Where to actually send SRTP for a controller-requested target address.
 * When the controller is THIS host (someone watching in the Mac's own Home app),
 * it asks for media at the host's LAN IP — but macOS VPN/relay setups add
 * self-addressed ipsec interfaces that hijack the route to one's own LAN IP and
 * silently swallow the packets (verified 2026-06-11: UDP to own 10.0.0.x never
 * arrives, loopback does). Deliver locally via loopback instead; non-local
 * controllers are untouched.
 */
export function resolveSrtpTargetAddress(
  requested: string,
  interfaces: () => ReturnType<typeof networkInterfaces> = networkInterfaces,
): string {
  for (const addresses of Object.values(interfaces())) {
    for (const address of addresses ?? []) {
      if (address.address === requested) {
        return requested.includes(":") ? "::1" : "127.0.0.1";
      }
    }
  }
  return requested;
}

/** Reserve a free UDP port by briefly binding an ephemeral socket. */
async function reserveUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, () => {
      const port = socket.address() as { port: number };
      socket.close(() => resolve(port.port));
    });
  });
}

/**
 * FFmpeg srtp_out_params for the stream WE send to the controller. Critically,
 * HomeKit encrypts/decrypts each direction with the controller's OWN key material
 * (supplied in the prepareStream request) — we must encrypt outbound with that
 * exact key, not a freshly generated one, or the iOS client can't decrypt and the
 * live view spins forever. We echo the same key back in the response.
 */
function srtpParamsFromRequest(key: Buffer, salt: Buffer): string {
  return Buffer.concat([key, salt]).toString("base64");
}

interface ActiveSession {
  ffmpeg?: ChildProcess;
  /** The input used for the running FFmpeg — kept so RECONFIGURE can respawn with new video params. */
  liveInput?: LiveFfmpegInput;
  /** UDP socket bound to videoReturnPort to receive RTCP from Home (camera-ffmpeg pattern). */
  videoReturnSocket?: ReturnType<typeof createSocket>;
  audioReturnSocket?: ReturnType<typeof createSocket>;
  /** Watchdog cleared when RTCP arrives; fires on stale stream. */
  rtcpWatchdog?: NodeJS.Timeout;
  prepared: {
    targetAddress: string;
    video: { port: number; localRtcpPort: number; ssrc: number; srtpParams: string };
    audio: { port: number; localRtcpPort: number; ssrc: number; srtpParams: string };
  };
}

export interface StreamingDelegateOptions {
  /** Which stream's stills to serve for HomeKit snapshot requests. Default "sub". */
  snapshotProfile?: SnapshotProfile;
  /** Override FFmpeg binary path (default "ffmpeg"). */
  ffmpegPath?: string;
  /** Log the FFmpeg command + stderr to the console. Default true. */
  verbose?: boolean;
  /** Send audio (Opus) alongside video. Default true; set false for a video-only stream. */
  includeAudio?: boolean;
  /** Live video handling. Default "transcode" (see LiveFfmpegInput.videoMode on why copy is experimental). */
  videoMode?: "copy" | "transcode";
  /**
   * go2rtc restream of the camera's full-res MAIN stream. When set, transcode
   * sessions negotiated at ≥720p source from it instead of the light sub/ext
   * stream (896-wide — upscaling it is why full-screen looked the same as the
   * tile). Sub remains the source below 720p: cheaper to decode, and its
   * 1s keyframes start faster than the NVR mains' 4s.
   */
  mainStreamUrl?: string;
  /**
   * The live source's native resolution (probed from a snapshot at startup).
   * Used by COPY mode only, where it is the single advertised size — what
   * arrives IS this stream, so the advertisement must match. Transcode mode
   * ignores it: Apple clients only ever negotiate their own standard ladder
   * (measured 2026-06-11 — non-standard sizes are dead weight).
   */
  liveResolution?: { width: number; height: number };
  /**
   * Local IP address for HAP advertising, prepareStream addressOverride, ffmpeg
   * localaddr, and RTCP return socket binding. On dual-NIC systems, must be the
   * LAN IP Home can reach (typically en0 on Mac). Scrypted/homebridge pattern.
   */
  bindAddress?: string;
  /** Injectable spawn for tests. */
  spawnFn?: typeof spawn;
}

/**
 * HAP streaming delegate for one camera: snapshots come straight from the warm
 * SnapshotCache; live view spawns FFmpeg to push SRTP from the go2rtc restream.
 */
export class ArgusStreamingDelegate implements CameraStreamingDelegate {
  public controller?: CameraController;

  private readonly sessions = new Map<string, ActiveSession>();
  private readonly snapshotProfile: SnapshotProfile;
  private readonly ffmpegPath: string;
  private readonly verbose: boolean;
  private readonly includeAudio: boolean;
  private readonly videoMode: "copy" | "transcode";
  private readonly mainStreamUrl?: string;
  private readonly bindAddress?: string;
  private readonly spawnFn: typeof spawn;

  public constructor(
    private readonly cameraName: string,
    /** go2rtc local restream base name resolver, e.g. () => "rtsp://127.0.0.1:8554/backyard-left-sub" */
    private readonly liveUrl: string,
    private readonly snapshots: SnapshotCache,
    options: StreamingDelegateOptions = {},
  ) {
    this.snapshotProfile = options.snapshotProfile ?? "sub";
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.verbose = options.verbose ?? true;
    this.includeAudio = options.includeAudio ?? true;
    this.videoMode = options.videoMode ?? "transcode";
    if (options.mainStreamUrl !== undefined) this.mainStreamUrl = options.mainStreamUrl;
    if (options.bindAddress !== undefined) this.bindAddress = options.bindAddress;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  /** Timestamped stderr line — session forensics without timestamps kept hurting. */
  private logLine(msg: string): void {
    if (this.verbose) {
      process.stderr.write(`${new Date().toISOString()} [argus ${this.cameraName}] ${msg}\n`);
    }
  }

  /**
   * Live input per negotiated size: ≥720p transcode sessions pull the full-res
   * MAIN restream (the sub/ext source tops out 896-wide — no pixels for 720p+);
   * everything else stays on the light sub. Copy mode always passes the sub
   * through (mains can be H.265, which copy can't deliver to HomeKit).
   */
  private pickInputUrl(width: number, height: number): string {
    if (this.videoMode === "transcode" && this.mainStreamUrl && (width >= 1280 || height >= 720)) {
      return this.mainStreamUrl;
    }
    return this.liveUrl;
  }

  /**
   * Encode bitrate for a session: the per-resolution floor policy
   * (effectiveBitrateKbps), except spec-obedient for controllers listed in
   * ARGUS_HUB_ADDRESSES — those are home-hub RELAYS fronting remote viewers
   * whose uplink we can't see, so Apple's conservative ask wins there — or
   * globally with ARGUS_LIVE_OBEY_BITRATE=1 (rollback switch).
   */
  private liveBitrateKbps(width: number, height: number, negotiated: number, controllerAddress: string): number {
    if (process.env.ARGUS_LIVE_OBEY_BITRATE === "1") return negotiated;
    const hubs = (process.env.ARGUS_HUB_ADDRESSES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hubs.includes(controllerAddress)) return negotiated;
    return effectiveBitrateKbps(width, height, negotiated);
  }

  public handleSnapshotRequest(_request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    this.snapshots
      .getOrRefresh(this.cameraName, this.snapshotProfile)
      .then((snapshot) => callback(undefined, snapshot.buffer))
      .catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
  }

  public prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    void this.prepareStreamAsync(request, callback);
  }

  private async prepareStreamAsync(
    request: PrepareStreamRequest,
    callback: PrepareStreamCallback,
  ): Promise<void> {
    // Guard against double-calling (HAP-NodeJS throws if callback invoked twice).
    // Field 1.3.9: removing guard caused double-callback → process crash exit 1.
    let answered = false;
    const answer = (error?: Error, response?: PrepareStreamResponse): void => {
      if (answered) {
        this.logLine(`prepareStream: callback already answered, ignoring duplicate call`);
        return;
      }
      answered = true;
      if (error) {
        callback(error);
      } else if (response) {
        callback(undefined, response);
      } else {
        callback(new Error("prepareStreamAsync: answer called with no error or response"));
      }
    };

    try {
      const videoSsrc = randomBytes(4).readUInt32BE(0) >>> 1;
      const audioSsrc = randomBytes(4).readUInt32BE(0) >>> 1;
      const videoRtcp = await reserveUdpPort();
      const audioRtcp = await reserveUdpPort();
      // Encrypt outbound with the controller's own key material (from the request),
      // and echo it back in the response. Generating fresh keys here is the classic
      // "stream sends but the device shows a forever-spinner" bug.
      const videoSrtpParams = srtpParamsFromRequest(request.video.srtp_key, request.video.srtp_salt);
      const audioSrtpParams = srtpParamsFromRequest(request.audio.srtp_key, request.audio.srtp_salt);

      this.sessions.set(request.sessionID, {
        prepared: {
          targetAddress: request.targetAddress,
          video: { port: request.video.port, localRtcpPort: videoRtcp, ssrc: videoSsrc, srtpParams: videoSrtpParams },
          audio: { port: request.audio.port, localRtcpPort: audioRtcp, ssrc: audioSsrc, srtpParams: audioSrtpParams },
        },
      });

      const response: PrepareStreamResponse = {
        video: {
          port: videoRtcp,
          ssrc: videoSsrc,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
        audio: {
          port: audioRtcp,
          ssrc: audioSsrc,
          srtp_key: request.audio.srtp_key,
          srtp_salt: request.audio.srtp_salt,
        },
      };
      answer(undefined, response);
    } catch (error) {
      answer(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    if (request.type === StreamRequestTypes.START) {
      emitTelemetry(this.cameraName, "live_session_start", {
        sessionId: request.sessionID,
        width: request.video.width,
        height: request.video.height,
        fps: request.video.fps,
      });
      this.startStream(request, callback);
      return;
    }
    if (request.type === StreamRequestTypes.STOP) {
      emitTelemetry(this.cameraName, "live_session_stop", { sessionId: request.sessionID });
      this.stopStream(request.sessionID);
      callback();
      return;
    }
    this.reconfigureStream(request, callback);
  }

  /**
   * Apple clients START small (the tile player: 640x360@132k) and upgrade the
   * SAME session via RECONFIGURE when the viewer goes full screen. Ignoring it
   * (the old v1 behavior) is why full-screen live view stayed soft. Transcode
   * respawns FFmpeg at the new resolution/bitrate; copy mode just acks — the
   * passthrough stream is whatever the camera sends.
   */
  private reconfigureStream(
    request: Extract<StreamingRequest, { type: StreamRequestTypes.RECONFIGURE }>,
    callback: StreamRequestCallback,
  ): void {
    const session = this.sessions.get(request.sessionID);
    callback(); // ack immediately; the respawn proceeds on its own

    if (!session?.liveInput || this.videoMode !== "transcode") {
      return;
    }
    const bitrate = this.liveBitrateKbps(
      request.video.width,
      request.video.height,
      request.video.max_bit_rate,
      session.prepared.targetAddress,
    );
    const next: LiveFfmpegInput = {
      ...session.liveInput,
      // Re-pick the source: a full-screen upgrade to ≥720p moves to the main stream.
      inputUrl: this.pickInputUrl(request.video.width, request.video.height),
      video: {
        ...session.liveInput.video,
        width: request.video.width,
        height: request.video.height,
        fps: request.video.fps,
        maxBitrateKbps: bitrate,
      },
    };
    this.logLine(
      `HomeKit reconfigure: ${request.video.width}x${request.video.height}@${request.video.fps} ` +
        `asked=${request.video.max_bit_rate}k serving=${bitrate}k source=${next.inputUrl} — respawning encoder`,
    );
    // SIGKILL is the teardown signal the exit handler ignores (no forceStop).
    session.ffmpeg?.kill("SIGKILL");
    this.spawnLive(request.sessionID, session, next);
  }

  private startStream(request: Extract<StreamingRequest, { type: StreamRequestTypes.START }>, callback: StreamRequestCallback): void {
    const session = this.sessions.get(request.sessionID);
    if (!session) {
      callback(new Error(`No prepared session ${request.sessionID} for ${this.cameraName}`));
      return;
    }

    // Force Baseline encoding for Apple Home compatibility. We advertise only
    // Baseline (streamingOptions), so Home should negotiate it, but we enforce
    // it here defensively. Field evidence (2026-10-01): High profile with
    // dump_extra still caused "No Response"; Baseline is the Home-friendly path.
    const profile = "baseline";
    const level = H264_LEVEL_TO_X264[request.video.level] ?? "4.0";
    const bitrate = this.liveBitrateKbps(
      request.video.width,
      request.video.height,
      request.video.max_bit_rate,
      session.prepared.targetAddress,
    );
    // Log negotiation details
    const audioLog = this.includeAudio
      ? (() => {
          const audioEncoder = request.audio.codec === AudioStreamingCodecType.AAC_ELD ? "libfdk_aac/aac_eld" : "libopus";
          return `audio: codec=${request.audio.codec} ${request.audio.sample_rate}kHz ptype=${request.audio.pt} (encoding ${audioEncoder})`;
        })()
      : "audio: none (video-only)";
    
    this.logLine(
      `HomeKit negotiated video: ${request.video.width}x${request.video.height}@${request.video.fps} ` +
        `profile=${profile} level=${level} ptype=${request.video.pt} ssrc=${session.prepared.video.ssrc} ` +
        `suite=AES_CM_128_HMAC_SHA1_80 asked=${request.video.max_bit_rate}k serving=${bitrate}k mtu=${request.video.mtu} ` +
        `mode=${this.videoMode} source=${this.pickInputUrl(request.video.width, request.video.height)}; ` +
        audioLog,
    );

    const liveInputBase = {
      inputUrl: this.pickInputUrl(request.video.width, request.video.height),
      targetAddress: session.prepared.targetAddress,
      videoMode: this.videoMode,
      video: {
        port: session.prepared.video.port,
        localRtcpPort: session.prepared.video.localRtcpPort,
        ssrc: session.prepared.video.ssrc,
        payloadType: request.video.pt,
        maxBitrateKbps: bitrate,
        fps: request.video.fps,
        width: request.video.width,
        height: request.video.height,
        mtu: request.video.mtu,
        profile,
        level,
        srtpParams: session.prepared.video.srtpParams,
      },
      audio: {
        port: session.prepared.audio.port,
        localRtcpPort: session.prepared.audio.localRtcpPort,
        ssrc: session.prepared.audio.ssrc,
        payloadType: request.audio.pt,
        codec: request.audio.codec,
        sampleRateKhz: request.audio.sample_rate,
        maxBitrateKbps: request.audio.max_bit_rate,
        srtpParams: session.prepared.audio.srtpParams,
      },
    };
    
    const liveInput: LiveFfmpegInput = this.bindAddress
      ? { ...liveInputBase, localAddress: this.bindAddress }
      : liveInputBase;

    this.spawnLive(request.sessionID, session, liveInput, callback);
  }

  /** Spawn (or respawn, for RECONFIGURE) the live FFmpeg for a prepared session. */
  private spawnLive(
    sessionID: string,
    session: ActiveSession,
    liveInput: LiveFfmpegInput,
    callback?: StreamRequestCallback,
  ): void {
    const args = buildLiveFfmpegArgs(liveInput, this.includeAudio);
    session.liveInput = liveInput;

    const log = (msg: string): void => this.logLine(msg);
    log(`ffmpeg ${this.ffmpegPath} ${args.join(" ")}`);

    const ffmpeg = this.spawnFn(this.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    session.ffmpeg = ffmpeg;

    // PRIMARY: Bind UDP return socket for RTCP (camera-ffmpeg pattern). Home sends
    // RTCP RR/NACKs to the port we advertised in prepareStream. Without a listener,
    // Home may refuse to unlock video. Firmware 1.3.5 adds this missing half.
    try {
      const videoSocket = createSocket("udp4");
      if (this.bindAddress) {
        videoSocket.bind(liveInput.video.localRtcpPort, this.bindAddress);
      } else {
        videoSocket.bind(liveInput.video.localRtcpPort);
      }
      videoSocket.on("message", (msg) => {
        // Home sent RTCP (Receiver Report / NACK). Log first arrival.
        if (!session.rtcpWatchdog) {
          log(`RTCP arrived on video return port (${msg.length} bytes)`);
        }
        // Reset watchdog (30s idle → forceStop, camera-ffmpeg pattern)
        if (session.rtcpWatchdog) clearTimeout(session.rtcpWatchdog);
        session.rtcpWatchdog = setTimeout(() => {
          log("RTCP watchdog fired (30s idle) — forcing stop");
          this.controller?.forceStopStreamingSession(sessionID);
        }, 30_000);
      });
      session.videoReturnSocket = videoSocket;
      log(`Bound video return RTCP: port ${liveInput.video.localRtcpPort}${this.bindAddress ? ` addr ${this.bindAddress}` : ""}`);

      if (this.includeAudio) {
        const audioSocket = createSocket("udp4");
        if (this.bindAddress) {
          audioSocket.bind(liveInput.audio.localRtcpPort, this.bindAddress);
        } else {
          audioSocket.bind(liveInput.audio.localRtcpPort);
        }
        audioSocket.on("message", () => {
          // Audio RTCP keepalive (same watchdog as video)
          if (session.rtcpWatchdog) clearTimeout(session.rtcpWatchdog);
          session.rtcpWatchdog = setTimeout(() => {
            log("RTCP watchdog fired (30s idle) — forcing stop");
            this.controller?.forceStopStreamingSession(sessionID);
          }, 30_000);
        });
        session.audioReturnSocket = audioSocket;
        log(`Bound audio return RTCP: port ${liveInput.audio.localRtcpPort}${this.bindAddress ? ` addr ${this.bindAddress}` : ""}`);
      }
    } catch (error) {
      log(`RTCP socket bind failed: ${error instanceof Error ? error.message : String(error)}`);
      // Non-fatal: continue without return RTCP (may still work if Home doesn't require it)
    }

    // Detect first frame from FFmpeg progress output (pipe:2 → stderr). Progress format:
    // "frame=N\nfps=...\n..." with frame=0 first, then frame=1 when first encode completes.
    // This works with -loglevel error (progress always emitted) unlike the frame= STATUS
    // lines which require info/verbose. Emit telemetry on frame≥1 (measures negotiate →
    // first SRTP packet sent — the "hang" Peter sees is before this event).
    let firstFrameEmitted = false;
    const stderrBuffer: string[] = [];
    ffmpeg.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuffer.push(text);
      // Keep last ~5 lines for forensics (avoid unbounded memory)
      if (stderrBuffer.length > 5) stderrBuffer.shift();
      
      log(`ffmpeg: ${text.trimEnd()}`);
      
      // Parse progress format: "frame=N" on its own line. Detect frame≥1 (frame=0 is the
      // pre-encode state; frame=1 means first packet encoded and sent).
      if (!firstFrameEmitted && /^frame=([1-9]\d*)$/m.test(text)) {
        firstFrameEmitted = true;
        emitTelemetry(this.cameraName, "live_session_first_frame", { sessionId: sessionID });
      }
    });

    let answered = false;
    const answer = (error?: Error): void => {
      if (answered) return;
      answered = true;
      callback?.(error);
    };

    ffmpeg.on("error", (error: Error) => {
      log(`ffmpeg spawn error: ${error.message}`);
      answer(error);
    });
    ffmpeg.once("exit", (code, signal) => {
      log(`ffmpeg exited code=${code} signal=${signal}`);
      if (!answered) {
        // Died before we acknowledged START — report failure to HomeKit.
        answer(new Error(`ffmpeg exited code=${code} signal=${signal}`));
        return;
      }
      // A non-zero exit that isn't from our SIGKILL teardown means the stream broke.
      // (SIGKILL is how stopStream and reconfigure respawns retire an encoder.)
      if (code !== 0 && signal !== "SIGKILL") {
        this.controller?.forceStopStreamingSession(sessionID);
      }
    });

    // Give FFmpeg 100ms to fail fast (bad args / unreachable source) before we tell
    // HomeKit the stream is live. Reduced from 300ms (previously 500ms): with pre-warming,
    // go2rtc's RTSP producer is already connected and FFmpeg succeeds immediately. First
    // frame typically arrives 150-300ms after spawn on warm starts. Acknowledging at 100ms
    // cuts perceived latency while still catching immediate failures. If cold (no pre-warm),
    // FFmpeg hangs >100ms and we answer before first frame — but that's fine, the error
    // telemetry arrives shortly after and controller can STOP cleanly.
    setTimeout(() => answer(), 100);
  }

  private stopStream(sessionID: string): void {
    const session = this.sessions.get(sessionID);
    session?.ffmpeg?.kill("SIGKILL");
    // Clean up RTCP return sockets and watchdog
    if (session?.rtcpWatchdog) clearTimeout(session.rtcpWatchdog);
    session?.videoReturnSocket?.close();
    session?.audioReturnSocket?.close();
    this.sessions.delete(sessionID);
  }
}

/**
 * HomeKit streaming/recording option block for a camera. Extracted so the codec
 * envelope is unit-testable. Video resolutions cover HomeKit's mandatory set.
 */
export function buildCameraControllerOptions(
  delegate: ArgusStreamingDelegate,
  includeAudio = true,
  recordingDelegate?: ArgusRecordingDelegate,
  liveResolution?: { width: number; height: number },
  videoMode: "copy" | "transcode" = "transcode",
): CameraControllerOptions {
  // Copy mode advertises ONLY the probed native resolution (a negotiation/stream
  // mismatch is fatal: macOS rendered one frame and stopped the session).
  // Transcode mode advertises HIGH RESOLUTIONS ONLY (1080p/720p). Two measured
  // findings drive this (2026-06-11/12):
  // - Apple clients pick exclusively from their OWN ladder and the TILE player
  //   takes 640x360 whenever it is offered. With grid live tiles always running,
  //   iOS then REUSES that small session for full-screen and (since the bitrate
  //   floors) never reconfigures up — every "full screen" was an upscaled
  //   640x360. No small sizes on offer = every session starts ≥720p, sourced
  //   from the camera main, with no upgrade moment at all.
  // - The probed non-standard sizes (896-wide) were advertised for a day and
  //   never once negotiated — only Apple-ladder entries matter.
  // 
  // UPDATE 2026-10-02: Field evidence shows MacBook Home negotiating 1280x720@30
  // leads to "No Response" after ~30s spinner even with healthy encode/first_frame.
  // June working path (c5b368c) capped at 640x480 for WiFi, then Garage Door 854x480.
  // RTCP starvation observed: one video pkt, no audio, nothing after first_frame.
  // Theory: 720p over WiFi to MacBook exceeds accept threshold; Home kills session.
  // 
  // ARGUS_LIVE_LADDER:
  // - "hires" (default pre-Oct): [1920x1080, 1280x720] only
  // - "wifi" (default Oct+): [854x480, 640x480, 640x360] WiFi-friendly June pattern
  // - "compat": full ladder [1920x1080 down to 320x240]
  const hiResSet: [number, number, number][] = [
    [1920, 1080, 30],
    [1280, 720, 30],
  ];
  const wifiSet: [number, number, number][] = [
    [854, 480, 30],   // June Garage Door working resolution
    [640, 480, 30],   // June WiFi unlock ceiling (c5b368c)
    [640, 360, 30],
  ];
  const compatSet: [number, number, number][] = [
    ...hiResSet,
    ...wifiSet,
    [480, 270, 30],
    [320, 240, 15],
  ];
  const resolutions: [number, number, number][] =
    videoMode === "copy" && liveResolution
      ? [[liveResolution.width, liveResolution.height, 30]]
      : process.env.ARGUS_LIVE_LADDER === "hires"
        ? hiResSet
        : process.env.ARGUS_LIVE_LADDER === "compat"
          ? compatSet
          : wifiSet;  // Default to WiFi-friendly caps (Oct 2026+)

  return {
    cameraStreamCount: 2, // allow two concurrent viewers
    delegate,
    // The controller-managed motion sensor is what links motion to HKSV recording
    // (EventTriggerOption.MOTION). A manually-added MotionSensor would NOT trigger it.
    ...(recordingDelegate
      ? {
          sensors: { motion: true },
          recording: { options: buildRecordingOptions(), delegate: recordingDelegate },
        }
      : {}),
    streamingOptions: {
      supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
      video: {
        codec: {
          // Advertise ONLY Baseline to force Home to negotiate it. Field evidence
          // (2026-10-01): Home negotiated High, we encoded High with dump_extra,
          // picture still locked ("No Response"). Hypothesis: Home may refuse
          // High streams from this accessory even with in-band SPS/PPS. Forcing
          // Baseline both sides (advertise + encode) as the Home-friendly path.
          profiles: [H264Profile.BASELINE],
          levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
        },
        resolutions,
      },
      // Omitting audio entirely makes HomeKit treat this as a video-only camera —
      // useful for isolating whether audio negotiation is what stalls a session.
      // Advertise both AAC-ELD and Opus (Apple's preferred + our original). HomeKit
      // picks based on device/network: AAC-ELD often chosen by iOS, Opus by others.
      audio: {
        codecs: includeAudio
          ? [
              { type: AudioStreamingCodecType.AAC_ELD, samplerate: AudioStreamingSamplerate.KHZ_24 },
              { type: AudioStreamingCodecType.OPUS, samplerate: AudioStreamingSamplerate.KHZ_24 },
            ]
          : [],
      },
    },
  };
}

/**
 * Advertised accessory firmware version — the controller cache-buster. iOS
 * pins camera streaming profiles hard: a manual configVersion bump alone did
 * NOT make a paired iPhone re-read the resolution list (measured 2026-06-12:
 * c#=8 visible in mDNS for 12h, phone still requested the long-removed
 * 640x360). Controllers DO refresh accessory metadata on a firmware update,
 * and HAP-NodeJS auto-bumps c# when this increases (it tracks
 * lastFirmwareVersion in AccessoryInfo for exactly that). BUMP THIS whenever
 * the advertised streaming configuration changes.
 * 
 * 2026-10-02 (1.3.0): Video-only interim path. A/V sync attempts failed.
 * Video-only unlocks picture. ARGUS_AUDIO=0 needs firmware bump for iOS
 * to honor video-only (empty codecs).
 * 
 * 2026-10-02 (1.3.1): Force Baseline H.264 profile. Changed advertised profiles
 * from [BASELINE, MAIN, HIGH] to [BASELINE] only. Field evidence: High with
 * dump_extra → "No Response"; forcing Baseline as Home-friendly unlock path.
 * Firmware bump required: iOS caches profile list, won't re-read without it.
 * 
 * 2026-10-02 (1.3.2): Fix video-only prepareStream response. In video-only mode,
 * omit audio from prepareStream response so Home doesn't wait for audio packets
 * that will never arrive. This was causing "No Response" despite healthy video.
 * Also add flush_packets and max_delay for immediate RTP transmission.
 * 
 * 2026-10-02 (1.3.3): Fix RTCP keepalive for HomeKit stream liveness. Changed
 * ffmpeg SRTP URL from localrtcpport to localrtpport. HomeKit requires RTCP
 * packets to keep streams alive (30-second timeout). localrtcpport alone left
 * RTP on a random port, breaking RTCP correlation. Field evidence: video-only
 * streams ran exactly 30s (~900 frames) then "No Response" — HomeKit's RTCP
 * timeout. Same root cause as Home Assistant PR #99989 and Ring issue #479.
 * FIELD TEST RESULT (2026-10-02 ~05:20 ET): Fix did NOT unlock picture.
 * 
 * 2026-10-02 (1.3.4): Remove localrtpport for bidirectional RTCP. The localrtpport
 * parameter bound the port we told HomeKit we're listening on (prepareStream response),
 * preventing HomeKit from sending RTCP back to us. Removed localrtpport entirely,
 * following homebridge-camera-ffmpeg pattern (let ffmpeg choose random source ports).
 * This allows proper bidirectional RTCP communication. Field hypothesis: HomeKit
 * expects to send Receiver Reports / NACKs back and kills streams when it can't.
 * FIELD TEST RESULT (2026-10-02 ~05:35 ET): Fix did NOT unlock picture.
 * 
 * 2026-10-02 (1.3.5): Complete camera-ffmpeg return-port pattern + CBR encoding.
 * PRIMARY: Node dgram binds advertised prepareStream video/audio return ports and
 * handles incoming RTCP from Home (Receiver Reports, NACKs). 1.3.4 had clean SRTP
 * URL but no socket owner → Home's RTCP targeted dead port. Field evidence: route
 * lookup + UDP probe → en0 (dual-NIC weakened); still no picture. Switch encoder
 * from CRF+maxrate to CBR (-b:v) matching camera-ffmpeg/HA stacks. Belt-and-suspenders:
 * localaddr pins ffmpeg egress to HAP-advertised IP; prepareStream addressOverride.
 * FIELD TEST RESULT (2026-10-02 ~10:51 ET): iOS Home shows "No Response" but logs
 * from BEFORE restart (10:33) show old pkt_size=564 + video-only. Suspected: iOS
 * cached accessory as video-only from earlier firmware; needs cache refresh.
 * 
 * 2026-10-02 (1.3.6): Force iOS cache refresh for audio advertisement. Firmware bump
 * triggers iOS to re-query accessory capabilities. Previous deploys set ARGUS_AUDIO=1
 * but iOS negotiated video-only (cached metadata from video-only test builds). This
 * bump + accessory info change forces re-read of audio codec advertisement.
 * FIELD TEST RESULT (2026-10-02 ~11:02 ET): Firmware bump alone did NOT unlock. Field
 * logs show "This callback function has already been called" in prepareStreamAsync →
 * no live_session_start → "No Response". Root cause: async error after callback.
 * 
 * 2026-10-02 (1.3.7): Fix prepareStreamAsync double-callback race. prepareStreamAsync
 * called HAP callback on success (line 588), but if async error (e.g., delayed promise
 * rejection from reserveUdpPort) occurred afterward, catch block called callback again
 * → HAP-NodeJS "already called" guard → prepareStream fails → no session → "No Response".
 * Fix: Guard callback with answered flag (pattern from spawnLive). Prevents double-call
 * even if async errors fire after initial success. Field evidence: KeepAlive restart
 * concurrent with Home open likely triggered the race.
 * FIELD TEST RESULT (2026-10-02 ~11:18 ET): 1.3.7 fixed double-callback but NO
 * live_session_start still. HAP warning: "Setup Endpoints didn't respond at all" +
 * "was slow to respond". Root cause: answered flag correct but callback never invoked.
 * 
 * 2026-10-02 (1.3.8): Fix Setup Endpoints callback never-called paths. Two bugs:
 * (1) reserveUdpPort() can hang forever if socket bind/close callbacks stall under
 * load (HEVC/HKSV noise) → prepareStreamAsync awaits forever → HAP callback never
 * invoked → "didn't respond at all". Fix: 2s timeout on reserveUdpPort rejects promise
 * → catch block fires → callback(error) properly invoked. (2) answer() guard had silent
 * path: if called with (undefined, undefined), neither if branch fires → callback never
 * called. Fix: else clause invokes callback(error) explaining the logic bug. Together
 * these ensure HAP callback ALWAYS fires (success, error, or timeout) within 2s.
 * FIELD TEST RESULT (2026-10-02 ~11:37 ET): 1.3.8 timeout/guard did NOT fix hang.
 * "Setup Endpoints didn't respond" still appears. Critically: timeout NEVER logged in
 * field → reserveUdpPort completes within 2s → hang is elsewhere. Root cause clarified:
 * Setup Endpoints hang is NEW (Oct 1.3.7-1.3.8 only) — zero prior OpenClaw docs before
 * this line. June working path had NO callback guard. Theory: guard/wrapper itself blocks.
 * 
 * 2026-10-02 (1.3.9): Revert to pre-1.3.7 direct callback pattern. Root cause: 1.3.7-1.3.8
 * callback guard/timeout introduced the Setup Endpoints hang (NEW bug, not in June working
 * code or firmware 1.3.6). Reverting to firmware 1.3.6 prepareStreamAsync pattern: direct
 * callback invocation in try/catch, NO answered flag guard, NO reserveUdpPort timeout.
 * June 2026 (917bc8e) had this simple pattern + Garage Door confirmed working. Matches
 * historical proven HAP live path: controller SRTP key/salt echoed, simple callback semantics.
 * FIELD TEST RESULT (2026-10-02 ~11:54 ET): Process CRASHED exit 1. Double-callback error
 * returned in HKSV path → HAP-NodeJS throws → process dies → MacBook click hit dead/restarting
 * process → instant "No Response". Reverting guard brought back the race that 1.3.7 fixed.
 * 
 * 2026-10-02 (1.3.10): Guard + June simple pattern. Root cause: need BOTH (1) callback guard
 * to prevent double-call crash AND (2) June simple logic without complex spreads/conditionals
 * that might throw. 1.3.7-1.3.8 had guard but complex response building (addressOverride spread,
 * conditional audio, resolveSrtpTargetAddress) that likely threw before reaching callback →
 * Setup Endpoints silent. 1.3.9 had simple logic but no guard → double-callback crash. Fix:
 * restore guard (answered flag with logging) + keep June 917bc8e simple pattern (always audio,
 * plain targetAddress, no spreads). Theory: simple code reaches callback; guard prevents crash.
 * FIELD TEST RESULT (2026-10-02 ~12:04 ET): prepareStream/once-safe WORKS! live_session_start,
 * AAC-eld 24kHz negotiated, pkt_size=1316, RTCP bound. Then crash: getaddrinfo ENOTFOUND en0.
 * Root cause: socket.bind(port, "en0") tries DNS lookup on interface name → ENOTFOUND.
 * 
 * 2026-10-02 (1.3.11): Resolve interface names to IP addresses. Root cause: socket.bind() second
 * parameter must be IP address (e.g. "10.0.0.46"), NOT interface name (e.g. "en0"). Node.js
 * dgram.bind(port, address) treats address as hostname and does DNS getaddrinfo → ENOTFOUND if
 * given interface name. Fix: getHapBindAddress() now validates ARGUS_HAP_BIND; if it looks like
 * interface name (not dotted-decimal IP), resolves to IP via networkInterfaces()[name]. Field
 * evidence: "addr en0" in logs → socket.bind(port, "en0") → DNS lookup → ENOTFOUND → exit 1.
 * Preserves 1.3.10 once-safe guard + June simple pattern that proved AAC-eld/1316/live_session_start.
 * FIELD TEST RESULT (2026-10-02 ~12:13 ET): Crash/ENOTFOUND FIXED! PID stable, Bound RTCP with IP,
 * live_session_start, first_frame +1.3s, AAC-eld, pkt_size=1316, clean encode on Mini. BUT MacBook
 * Home still "No Response" after 16-20s spinner. Root cause: post-negotiate Mac accept failure —
 * 1280x720@30 negotiated but Home never unlocks. RTCP bidirectional BROKEN: one video pkt at +0.5s,
 * NO audio RTCP, nothing after first_frame. Home waits ~30s then kills session. This is the June
 * WiFi spinner problem (c5b368c working: cap 640x480; then Garage Door 854x480).
 * 
 * 2026-10-02 (1.3.12): Cap live resolution for WiFi accept (June working pattern). Root cause:
 * MacBook Home negotiates 1280x720@30 but never unlocks picture despite healthy encode/first_frame/
 * AAC-eld. RTCP starvation observed: one video return pkt, no audio RTCP, nothing after first_frame
 * → Home waits 30s → kills session → "No Response". June working path (c5b368c) capped resolution
 * at 640x480 for WiFi reliability, then Garage Door at 854x480. Theory: 720p over WiFi to MacBook
 * exceeds Home's accept threshold for RTCP/delivery; caps force lower bandwidth negotiation. Fix:
 * buildCameraControllerOptions now defaults to "wifi" ladder [854x480, 640x480, 640x360] instead
 * of "hires" [1920x1080, 1280x720]. ARGUS_LIVE_LADDER env var overrides: "hires" (pre-Oct behavior),
 * "wifi" (default Oct+), "compat" (full ladder down to 320x240). Preserves once-safe + iface→IP.
 */
export const ARGUS_FIRMWARE_REVISION = "1.3.12";

export interface CameraAccessoryHandle {
  accessory: Accessory;
  delegate: ArgusStreamingDelegate;
  /** Update the camera's HomeKit MotionSensor (triggers HKSV recording). */
  setMotion: (detected: boolean) => void;
}

/**
 * Build a standalone HAP camera accessory (own pairing identity) for one camera.
 * `liveUrl` is the go2rtc restream; snapshots come from the shared cache.
 */
export function createCameraAccessory(
  camera: CameraConfig,
  liveUrl: string,
  mainUrl: string,
  snapshots: SnapshotCache,
  options: StreamingDelegateOptions = {},
): CameraAccessoryHandle {
  const accessory = new Accessory(camera.name, uuid.generate(`argus:camera:${camera.name}`));
  accessory.category = Categories.IP_CAMERA;

  accessory
    .getService(Service.AccessoryInformation)!
    .setCharacteristic(Characteristic.Manufacturer, "Point Labs")
    .setCharacteristic(Characteristic.Model, "Argus 1.3.12")
    .setCharacteristic(Characteristic.SerialNumber, `argus-${camera.host}-${camera.channel}`)
    .setCharacteristic(Characteristic.FirmwareRevision, ARGUS_FIRMWARE_REVISION);

  // Whether live ≥720p sessions may source the main restream is the caller's call
  // (serve grants it to standalone cameras only — the NVR mains' 4s GOP + 12MP
  // HEVC decode cannot meet the live start-time bar; recording still uses them).
  const delegate = new ArgusStreamingDelegate(camera.name, liveUrl, snapshots, options);
  // HKSV recording delegate records the full-res MAIN stream on motion.
  const recordingDelegate = new ArgusRecordingDelegate(camera.name, mainUrl, {
    ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
    ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
  });
  const controller = new CameraController(
    buildCameraControllerOptions(
      delegate,
      options.includeAudio ?? true,
      recordingDelegate,
      options.liveResolution,
      options.videoMode ?? "transcode",
    ),
  );
  delegate.controller = controller;
  accessory.configureController(controller);

  // The controller (sensors.motion) created the MotionSensor service and linked it
  // to HKSV recording. Argus drives it from the Reolink motion API (MotionMonitor).
  const motionSensor = accessory.getService(Service.MotionSensor);

  return {
    accessory,
    delegate,
    setMotion: (detected: boolean) => {
      motionSensor?.updateCharacteristic(Characteristic.MotionDetected, detected);
    },
  };
}
