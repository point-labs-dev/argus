import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

import {
  Accessory,
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
// FFmpeg transcode to the resolution/bitrate HomeKit negotiates. Audio is Opus
// (HomeKit-supported, and libopus avoids the libfdk_aac/AAC-ELD build dependency).

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
    sampleRateKhz: number;
    maxBitrateKbps: number;
    srtpParams: string;
  };
}

/**
 * What we actually encode at, given HomeKit's ask. Apple clients negotiate
 * absurdly conservative bitrates (measured 2026-06-11 on Peter's iPhone, LAN:
 * 299k for 1280x720, 802k for 1920x1080 — mush at those sizes) and mature
 * bridges (homebridge-camera-ffmpeg videoBitrate, Scrypted) override them as a
 * matter of course. Floors are conventional IP-camera rates per tier; the ask
 * is still honored when it EXCEEDS the floor.
 */
export function effectiveBitrateKbps(width: number, height: number, negotiatedKbps: number): number {
  const pixels = width * height;
  // 2000k@720p / 3000k@1080p are the community-proven LAN rates (Scrypted
  // defaults): 3500k+ with 2x VBV burst headroom hung real iPhone sessions on
  // WiFi (2026-06-12: tiles at 600k always rendered, 720p at 3500k hung on
  // most attempts — delivery, not negotiation; the sender was healthy).
  const floor =
    pixels >= 1920 * 1080 ? 3000 :
    pixels >= 1280 * 720 ? 2000 :
    pixels >= 640 * 360 ? 600 : 300;
  return Math.max(negotiatedKbps, floor);
}

/**
 * Pure builder for the FFmpeg live-streaming command (video + Opus audio over SRTP).
 * Kept side-effect free so it can be unit-tested without spawning anything.
 */
export function buildLiveFfmpegArgs(input: LiveFfmpegInput, includeAudio = true): string[] {
  const { inputUrl, targetAddress, videoMode, video, audio } = input;

  const hiResSession = video.width >= 1280 || video.height >= 720;

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
        "-force_key_frames", `expr:gte(t,n_forced*${idrSeconds})`,
      ];

  // Starved sessions (hub-relayed remote viewers obeying Apple's 132-300k
  // asks) get fewer pixels per bit: encoding a full 1280x720 at 132k is
  // pulsating mush, 854x480 in the same negotiated box is merely soft.
  // Controllers accept smaller-than-negotiated dimensions (the fit-within
  // scale below already relies on that).
  const starved = hiResSession && video.maxBitrateKbps < 800;
  const boxWidth = starved ? Math.min(854, video.width) : video.width;
  const boxHeight = starved ? Math.min(480, video.height) : video.height;

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
          "-profile:v", video.profile,
          "-level", video.level,
          "-pix_fmt", "yuv420p",
          "-color_range", "tv",
          "-r", String(video.fps),
          "-vf", `scale=${boxWidth}:${boxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
          "-bf", "0",
          ...keyframeArgs,
          "-crf", hiResSession ? "18" : "20",
          "-maxrate", `${video.maxBitrateKbps}k`,
          // 1x VBV: momentary bursts toward 2x maxrate were part of what WiFi
          // delivery choked on; a tight buffer keeps the wire rate honest.
          "-bufsize", `${video.maxBitrateKbps}k`,
        ];

  // Cap RTSP stream analysis: FFmpeg's default ~5s runs past HomeKit's stream-start
  // window (spinner → "No Response"). 0.2s is enough for transcode too — codec
  // params come from go2rtc's SDP, and every analysis millisecond delays the first
  // frame out (bench 2026-06-11: trimming 1s → 0.2s took the 720p-from-main start
  // from 2.8s to 1.8s; AAC detection stayed reliable on subs AND mains, 13/13
  // runs). probesize 32 was the value that flaked ("no stream" aborts) — keep 100k.
  const analyzeArgs = ["-probesize", "100000", "-analyzeduration", "200000"];

  const videoArgs = [
    "-hide_banner",
    "-loglevel", "error",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
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
    `srtp://${targetAddress}:${video.port}?rtcpport=${video.port}&localrtcpport=${video.localRtcpPort}&pkt_size=${hiResSession ? Math.min(564, video.mtu) : video.mtu}`,
  ];

  if (!includeAudio) {
    return videoArgs;
  }

  return [
    ...videoArgs,
    // --- audio: transcode to Opus, SRTP out ---
    "-vn",
    "-c:a", "libopus",
    "-application", "lowdelay",
    "-frame_duration", "20",
    // Heal source timestamp gaps by stretching/padding samples — Reolink RTSP
    // audio timing is jittery, and every input gap otherwise becomes an
    // audible freeze on the controller (reported on-device 2026-06-12).
    "-af", "aresample=async=1:first_pts=0",
    "-ac", "1",
    "-ar", `${audio.sampleRateKhz}k`,
    "-b:a", `${audio.maxBitrateKbps}k`,
    "-payload_type", String(audio.payloadType),
    "-ssrc", String(audio.ssrc),
    "-f", "rtp",
    "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
    "-srtp_out_params", audio.srtpParams,
    `srtp://${targetAddress}:${audio.port}?rtcpport=${audio.port}&localrtcpport=${audio.localRtcpPort}&pkt_size=188`,
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
  prepared: {
    targetAddress: string;
    /** The controller's requested address BEFORE any loopback rewrite — identity, not routing. */
    controllerAddress: string;
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
          targetAddress: resolveSrtpTargetAddress(request.targetAddress),
          controllerAddress: request.targetAddress,
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
      callback(undefined, response);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    if (request.type === StreamRequestTypes.START) {
      this.startStream(request, callback);
      return;
    }
    if (request.type === StreamRequestTypes.STOP) {
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
      session.prepared.controllerAddress,
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

    const profile = H264_PROFILE_TO_X264[request.video.profile] ?? "high";
    const level = H264_LEVEL_TO_X264[request.video.level] ?? "4.0";
    const bitrate = this.liveBitrateKbps(
      request.video.width,
      request.video.height,
      request.video.max_bit_rate,
      session.prepared.controllerAddress,
    );
    this.logLine(
      `HomeKit negotiated video: ${request.video.width}x${request.video.height}@${request.video.fps} ` +
        `profile=${profile} level=${level} ptype=${request.video.pt} asked=${request.video.max_bit_rate}k serving=${bitrate}k mtu=${request.video.mtu} ` +
        `mode=${this.videoMode} source=${this.pickInputUrl(request.video.width, request.video.height)}; ` +
        `audio: codec=${request.audio.codec} ${request.audio.sample_rate}kHz ptype=${request.audio.pt}`,
    );

    const liveInput: LiveFfmpegInput = {
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
        sampleRateKhz: request.audio.sample_rate,
        maxBitrateKbps: request.audio.max_bit_rate,
        srtpParams: session.prepared.audio.srtpParams,
      },
    };

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

    // Drain stderr both to surface failures and to avoid the pipe filling and
    // stalling FFmpeg (a silent cause of a stream that "starts" but never flows).
    ffmpeg.stderr?.on("data", (chunk: Buffer) => log(`ffmpeg: ${chunk.toString().trimEnd()}`));

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

    // Give FFmpeg a beat to fail fast (bad args / unreachable source) before we
    // tell HomeKit the stream is live; otherwise report success so it starts pulling.
    setTimeout(() => answer(), 500);
  }

  private stopStream(sessionID: string): void {
    const session = this.sessions.get(sessionID);
    session?.ffmpeg?.kill("SIGKILL");
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
  // ARGUS_LIVE_LADDER=compat restores the small tiers (rollback if some client
  // — Apple Watch, CarPlay, remote relay — refuses hi-res-only; needs a
  // configVersion bump to be seen, see the controller-cache trap).
  const hiResSet: [number, number, number][] = [
    [1920, 1080, 30],
    [1280, 720, 30],
  ];
  const compatSet: [number, number, number][] = [
    ...hiResSet,
    [640, 480, 30],
    [640, 360, 30],
    [480, 270, 30],
    [320, 240, 15],
  ];
  const resolutions: [number, number, number][] =
    videoMode === "copy" && liveResolution
      ? [[liveResolution.width, liveResolution.height, 30]]
      : process.env.ARGUS_LIVE_LADDER === "compat"
        ? compatSet
        : hiResSet;

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
          profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
          levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
        },
        resolutions,
      },
      // Omitting audio entirely makes HomeKit treat this as a video-only camera —
      // useful for isolating whether audio negotiation is what stalls a session.
      audio: {
        codecs: includeAudio
          ? [{ type: AudioStreamingCodecType.OPUS, samplerate: AudioStreamingSamplerate.KHZ_24 }]
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
 */
export const ARGUS_FIRMWARE_REVISION = "1.1.0";

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
    .setCharacteristic(Characteristic.Model, "Argus")
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
