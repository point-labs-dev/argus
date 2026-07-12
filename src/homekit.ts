import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
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

import { createStderrBudget, envFlag } from "./child-log.js";
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
  /** Optional per-camera content box for aspect-preserved transcodes. Env override still wins. */
  liveContentResolution?: { width: number; height: number };
  /** Whether to pad to Home's negotiated frame. Env override still wins. */
  liveExactFrame?: boolean;
  video: {
    port: number;
    localRtcpPort?: number;
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
    localRtcpPort?: number;
    ssrc: number;
    payloadType: number;
    sampleRateKhz: number;
    maxBitrateKbps: number;
    srtpParams: string;
    /**
     * HomeKit audio codec to encode. "opus" (default) is what Argus has always
     * shipped; "aac_eld" is Apple's canonical camera codec (HomeKit negotiates
     * AAC-ELD at 16kHz mono). Set from the NEGOTIATED codec at the call site, so
     * the builder always produces exactly what the controller asked for. AAC-ELD
     * requires a libfdk_aac-enabled ffmpeg (Homebrew's default build lacks it) —
     * see ARGUS_FFMPEG and progress/attempt-008.md.
     */
    audioCodec?: "opus" | "aac_eld";
    /**
     * Audio samples to feed HomeKit. "input" uses the camera/restream audio.
     * "silence" keeps a real, steady audio RTP leg while removing camera audio
     * timing/stall risk from the live-start path.
     */
    audioSource?: "input" | "silence";
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
function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function liveBitrateFloorKbps(
  width: number,
  height: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const pixels = width * height;
  // 2000k@720p / 3000k@1080p are the community-proven LAN rates (Scrypted
  // defaults): 3500k+ with 2x VBV burst headroom hung real iPhone sessions on
  // WiFi (2026-06-12: tiles at 600k always rendered, 720p at 3500k hung on
  // most attempts — delivery, not negotiation; the sender was healthy).
  if (pixels >= 1920 * 1080) return positiveInt(env.ARGUS_LIVE_1080P_BITRATE_KBPS) ?? 3000;
  if (pixels >= 1280 * 720) return positiveInt(env.ARGUS_LIVE_720P_BITRATE_KBPS) ?? 2000;
  if (pixels >= 640 * 360) return positiveInt(env.ARGUS_LIVE_360P_BITRATE_KBPS) ?? 600;
  return positiveInt(env.ARGUS_LIVE_LOW_BITRATE_KBPS) ?? 300;
}

export function effectiveBitrateKbps(
  width: number,
  height: number,
  negotiatedKbps: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const floor = liveBitrateFloorKbps(width, height, env);
  return Math.max(negotiatedKbps, floor);
}

export function keepNegotiatedLiveSize(value = process.env.ARGUS_LIVE_KEEP_NEGOTIATED_SIZE): boolean {
  return value === "1";
}

function parseResolution(value: string | undefined): { width: number; height: number } | undefined {
  const match = value?.trim().match(/^(\d+)x(\d+)$/i);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function parseMaxLiveResolution(value = process.env.ARGUS_LIVE_MAX_RESOLUTION): { width: number; height: number } | undefined {
  return parseResolution(value);
}

function forcedLiveContentResolution(value = process.env.ARGUS_LIVE_CONTENT_RESOLUTION): { width: number; height: number } | undefined {
  return parseResolution(value);
}

function capResolutions(resolutions: [number, number, number][]): [number, number, number][] {
  const cap = parseMaxLiveResolution();
  if (!cap) return resolutions;
  const capped = resolutions.filter(([width, height]) => width <= cap.width && height <= cap.height);
  return capped.length > 0 ? capped : resolutions;
}

export function liveStartAckDelayMs(value = process.env.ARGUS_START_ACK_DELAY_MS): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

export function liveVideoPacketSize(
  mtu: number,
  hiResSession: boolean,
  value = process.env.ARGUS_LIVE_PACKET_SIZE,
): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.floor(parsed), mtu);
  }
  return hiResSession ? Math.min(564, mtu) : mtu;
}

export function exactLiveFrameEnabled(value = process.env.ARGUS_LIVE_EXACT_FRAME): boolean {
  return value !== "0";
}

function exactLiveFrameFor(inputExactFrame: boolean | undefined): boolean {
  return process.env.ARGUS_LIVE_EXACT_FRAME !== undefined
    ? exactLiveFrameEnabled(process.env.ARGUS_LIVE_EXACT_FRAME)
    : inputExactFrame ?? true;
}

export function liveVideoFilter(
  contentWidth: number,
  contentHeight: number,
  frameWidth: number,
  frameHeight: number,
  exactFrame = exactLiveFrameEnabled(),
): string {
  const scale = `scale=${contentWidth}:${contentHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  if (!exactFrame) {
    return `${scale},setsar=1`;
  }
  return `${scale},pad=${frameWidth}:${frameHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
}

function rtpUrl(targetAddress: string, port: number, remoteRtcpPort: number, localRtcpPort: number | undefined, packetSize: number): string {
  const params = [`rtcpport=${remoteRtcpPort}`];
  if (localRtcpPort !== undefined) {
    params.push(`localrtcpport=${localRtcpPort}`);
  }
  params.push(`pkt_size=${packetSize}`);
  return `srtp://${targetAddress}:${port}?${params.join("&")}`;
}

/**
 * Pure builder for the FFmpeg live-streaming command (video + Opus audio over SRTP).
 * Kept side-effect free so it can be unit-tested without spawning anything.
 */
export function buildLiveFfmpegArgs(input: LiveFfmpegInput, includeAudio = true): string[] {
  const { inputUrl, targetAddress, videoMode, video, audio } = input;

  const hiResSession = video.width >= 1280 || video.height >= 720;
  const silentAudio = includeAudio && audio.audioSource === "silence";

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
  // asks) get fewer content pixels per bit: encoding a full 1280x720 at 132k is
  // pulsating mush, 854x480 content padded back into the negotiated frame is
  // merely soft while preserving the exact HomeKit stream dimensions.
  const forcedContent = videoMode === "transcode"
    ? (forcedLiveContentResolution() ?? input.liveContentResolution)
    : undefined;
  const starved = hiResSession && video.maxBitrateKbps < 800 && !keepNegotiatedLiveSize();
  const contentWidth = forcedContent?.width ?? (starved ? Math.min(854, video.width) : video.width);
  const contentHeight = forcedContent?.height ?? (starved ? Math.min(480, video.height) : video.height);
  const exactFrame = exactLiveFrameFor(input.liveExactFrame);
  const cbrVideo = process.env.ARGUS_LIVE_CBR === "1";

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
  //   negotiated dimensions, then pad to the exact negotiated frame. This keeps
  //   the H.264 SPS/output dimensions aligned with what Home asked for while
  //   avoiding distortion. ARGUS_LIVE_EXACT_FRAME=0 restores the older
  //   fit-within-only behavior for rollback diagnostics.
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
          "-vf", liveVideoFilter(contentWidth, contentHeight, video.width, video.height, exactFrame),
          "-bf", "0",
          ...keyframeArgs,
          "-crf", hiResSession ? "18" : "20",
          ...(cbrVideo ? ["-b:v", `${video.maxBitrateKbps}k`] : []),
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
    ...(silentAudio
      ? ["-re", "-f", "lavfi", "-i", `anullsrc=channel_layout=mono:sample_rate=${audio.sampleRateKhz}000`]
      : []),

    // --- video: SRTP out ---
    "-an",
    ...(silentAudio ? ["-map", "0:v:0"] : []),
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
    rtpUrl(
      targetAddress,
      video.port,
      video.port,
      video.localRtcpPort,
      liveVideoPacketSize(video.mtu, hiResSession),
    ),
  ];

  if (!includeAudio) {
    return videoArgs;
  }

  // Audio codec: Opus (Argus's long-time default) or AAC-ELD. AAC-ELD is
  // Apple's canonical HomeKit camera codec; the research sweep (2026-06-19,
  // progress/attempt-008.md) found the "audio gates ≥720p video" hang is an
  // iOS-wide behavior tied to non-standard audio, and that go2rtc/Scrypted/
  // homebridge all feed HomeKit AAC-ELD rather than Opus. AAC-ELD needs a
  // libfdk_aac-enabled ffmpeg (Homebrew's default build has neither libfdk_aac
  // nor an ELD-capable aac_at) — point ARGUS_FFMPEG at one (e.g.
  // ffmpeg-for-homebridge). homebridge-camera-ffmpeg's proven ELD args are
  // `libfdk_aac -profile:a aac_eld -flags +global_header`.
  const audioCodecArgs =
    audio.audioCodec === "aac_eld"
      ? ["-c:a", "libfdk_aac", "-profile:a", "aac_eld", "-flags", "+global_header"]
      : ["-c:a", "libopus", "-application", "lowdelay", "-frame_duration", "20"];

  return [
    ...videoArgs,
    // --- audio: transcode (Opus or AAC-ELD), SRTP out ---
    "-vn",
    ...(silentAudio ? ["-map", "1:a:0"] : []),
    ...audioCodecArgs,
    // SYNTHETIC audio clock: regenerate pts from the cumulative sample count,
    // discarding the camera's wobbly timestamps entirely. The video leg
    // already gets a steady clock from the -r CFR grid; audio passing the
    // Reolink wobble (±600ms bursts, measured by validate-av-sync) through
    // was what tripped iOS's STRICT ≥720p A/V sync pipeline — 640x360 uses a
    // lenient path and tolerated it all day, video-only sessions rendered,
    // and every "fluke" 720p render matched a clean stretch between wobble
    // bursts. Trade-off: lip-sync accuracy to reality can drift if the
    // camera truly gaps samples — irrelevant for ambient security audio.
    "-af", "asetpts=N/SR/TB",
    "-ac", "1",
    "-ar", `${audio.sampleRateKhz}k`,
    "-b:a", `${audio.maxBitrateKbps}k`,
    "-payload_type", String(audio.payloadType),
    "-ssrc", String(audio.ssrc),
    "-f", "rtp",
    "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
    "-srtp_out_params", audio.srtpParams,
    rtpUrl(targetAddress, audio.port, audio.port, audio.localRtcpPort, 188),
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
  loopbackLocal = process.env.ARGUS_SRTP_LOOPBACK !== "0",
): string {
  if (!loopbackLocal) {
    return requested;
  }
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

async function bindUdpSocket(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, () => {
      socket.off("error", reject);
      socket.unref();
      resolve(socket);
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
  rtcpMonitor?: {
    videoSocket: Socket;
    videoPort: number;
    videoPackets: number;
  };
  prepared: {
    targetAddress: string;
    /** The controller's requested address BEFORE any loopback rewrite — identity, not routing. */
    controllerAddress: string;
    video: { port: number; returnPort: number; localRtcpPort?: number; ssrc: number; srtpParams: string };
    audio?: { port: number; returnPort: number; localRtcpPort?: number; ssrc: number; srtpParams: string };
  };
}

/** First raw ffmpeg stderr lines forwarded per live session before suppression. */
const LIVE_STDERR_MAX_LINES = 40;

export interface StreamingDelegateOptions {
  /** Which stream's stills to serve for HomeKit snapshot requests. Default "sub". */
  snapshotProfile?: SnapshotProfile;
  /** Override FFmpeg binary path (default: ARGUS_FFMPEG env, else "ffmpeg"). */
  ffmpegPath?: string;
  /**
   * Log session lifecycle lines (negotiation, ffmpeg command, exit) to the
   * console. Default true. Raw ffmpeg stderr passthrough is budgeted
   * separately per session; ARGUS_LIVE_FFMPEG_VERBOSE=1 lifts that budget.
   */
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
   * Per-camera content box for aspect-preserved transcodes. Used to keep the
   * encoded H.264 frame inside a known Home-accepted geometry while retaining a
   * higher bitrate. ARGUS_LIVE_CONTENT_RESOLUTION overrides globally for tests.
   */
  liveContentResolution?: { width: number; height: number };
  /** Per-camera override for exact-frame padding; ARGUS_LIVE_EXACT_FRAME overrides globally. */
  liveExactFrame?: boolean;
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
  private readonly liveContentResolution?: { width: number; height: number };
  private readonly liveExactFrame?: boolean;
  private readonly spawnFn: typeof spawn;

  public constructor(
    private readonly cameraName: string,
    /** go2rtc local restream base name resolver, e.g. () => "rtsp://127.0.0.1:8554/backyard-left-sub" */
    private readonly liveUrl: string,
    private readonly snapshots: SnapshotCache,
    options: StreamingDelegateOptions = {},
  ) {
    this.snapshotProfile = options.snapshotProfile ?? "sub";
    // ARGUS_FFMPEG lets the daemon point at a libfdk_aac-enabled ffmpeg (needed
    // for AAC-ELD live audio) without replacing the system binary — explicit
    // option still wins. See progress/attempt-008.md.
    this.ffmpegPath = options.ffmpegPath ?? process.env.ARGUS_FFMPEG ?? "ffmpeg";
    this.verbose = options.verbose ?? true;
    this.includeAudio = options.includeAudio ?? true;
    this.videoMode = options.videoMode ?? "transcode";
    if (options.mainStreamUrl !== undefined) this.mainStreamUrl = options.mainStreamUrl;
    if (options.liveContentResolution !== undefined) this.liveContentResolution = options.liveContentResolution;
    if (options.liveExactFrame !== undefined) this.liveExactFrame = options.liveExactFrame;
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
      const useRtcpMonitor = process.env.ARGUS_RTCP_MONITOR === "1";
      const videoRtcpMonitor = useRtcpMonitor ? await bindUdpSocket() : undefined;
      const videoReturnPort = videoRtcpMonitor
        ? (videoRtcpMonitor.address() as { port: number }).port
        : await reserveUdpPort();
      // Encrypt outbound with the controller's own key material (from the request),
      // and echo it back in the response. Generating fresh keys here is the classic
      // "stream sends but the device shows a forever-spinner" bug.
      const videoSrtpParams = srtpParamsFromRequest(request.video.srtp_key, request.video.srtp_salt);
      const audioReturnPort = this.includeAudio ? await reserveUdpPort() : undefined;
      const audioPrepared = this.includeAudio && audioReturnPort !== undefined
        ? {
            port: request.audio.port,
            returnPort: audioReturnPort,
            ...(!useRtcpMonitor ? { localRtcpPort: audioReturnPort } : {}),
            ssrc: randomBytes(4).readUInt32BE(0) >>> 1,
            srtpParams: srtpParamsFromRequest(request.audio.srtp_key, request.audio.srtp_salt),
          }
        : undefined;
      const rtcpMonitor = videoRtcpMonitor
        ? {
            videoSocket: videoRtcpMonitor,
            videoPort: videoReturnPort,
            videoPackets: 0,
          }
        : undefined;
      if (rtcpMonitor) {
        rtcpMonitor.videoSocket.on("message", () => {
          rtcpMonitor.videoPackets += 1;
        });
        rtcpMonitor.videoSocket.on("error", (error) => {
          this.logLine(`RTCP monitor error on video return port ${videoReturnPort}: ${error.message}`);
        });
      }

      this.sessions.set(request.sessionID, {
        ...(rtcpMonitor ? { rtcpMonitor } : {}),
        prepared: {
          targetAddress: resolveSrtpTargetAddress(request.targetAddress),
          controllerAddress: request.targetAddress,
          video: {
            port: request.video.port,
            returnPort: videoReturnPort,
            ...(useRtcpMonitor ? {} : { localRtcpPort: videoReturnPort }),
            ssrc: videoSsrc,
            srtpParams: videoSrtpParams,
          },
          ...(audioPrepared ? { audio: audioPrepared } : {}),
        },
      });

      const response: PrepareStreamResponse = {
        video: {
          port: videoReturnPort,
          ssrc: videoSsrc,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
      };
      if (audioPrepared) {
        response.audio = {
          port: audioPrepared.returnPort,
          ssrc: audioPrepared.ssrc,
          srtp_key: request.audio.srtp_key,
          srtp_salt: request.audio.srtp_salt,
        };
      }
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
    const audioSource = process.env.ARGUS_LIVE_AUDIO_SOURCE === "silence" ? "silence" : "input";
    const rtcpMode = session.rtcpMonitor ? `node-monitor:${session.rtcpMonitor.videoPort}` : "ffmpeg-localrtcpport";
    const audioLog = this.includeAudio
      ? `audio: codec=${request.audio.codec} ${request.audio.sample_rate}kHz ptype=${request.audio.pt} source=${audioSource}`
      : `audio: disabled (controller selected codec=${request.audio.codec} ${request.audio.sample_rate}kHz ptype=${request.audio.pt})`;
    this.logLine(
      `HomeKit negotiated video: ${request.video.width}x${request.video.height}@${request.video.fps} ` +
        `profile=${profile} level=${level} ptype=${request.video.pt} asked=${request.video.max_bit_rate}k serving=${bitrate}k mtu=${request.video.mtu} ` +
        `mode=${this.videoMode} source=${this.pickInputUrl(request.video.width, request.video.height)} ` +
        `controller=${session.prepared.controllerAddress} target=${session.prepared.targetAddress} rtcp=${rtcpMode}; ` +
        audioLog,
    );
    const preparedAudio: {
      port: number;
      localRtcpPort?: number;
      ssrc: number;
      srtpParams: string;
    } = session.prepared.audio ?? {
      port: 0,
      ssrc: 0,
      srtpParams: "",
    };

    const liveInput: LiveFfmpegInput = {
      inputUrl: this.pickInputUrl(request.video.width, request.video.height),
      targetAddress: session.prepared.targetAddress,
      videoMode: this.videoMode,
      ...(this.liveContentResolution ? { liveContentResolution: this.liveContentResolution } : {}),
      ...(this.liveExactFrame !== undefined ? { liveExactFrame: this.liveExactFrame } : {}),
      video: {
        port: session.prepared.video.port,
        ...(session.prepared.video.localRtcpPort !== undefined
          ? { localRtcpPort: session.prepared.video.localRtcpPort }
          : {}),
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
        port: preparedAudio.port,
        ...(preparedAudio.localRtcpPort !== undefined
          ? { localRtcpPort: preparedAudio.localRtcpPort }
          : {}),
        ssrc: preparedAudio.ssrc,
        payloadType: request.audio.pt,
        sampleRateKhz: request.audio.sample_rate,
        maxBitrateKbps: request.audio.max_bit_rate,
        srtpParams: preparedAudio.srtpParams,
        // Encode whatever HomeKit negotiated. The advertised codec (Opus vs
        // AAC-ELD) is gated by ARGUS_LIVE_AAC_ELD in buildCameraControllerOptions;
        // deriving from the actual ask keeps the encoder correct even if a
        // controller picks the other codec.
        audioCodec:
          request.audio.codec === AudioStreamingCodecType.AAC_ELD ? "aac_eld" : "opus",
        audioSource,
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
    // Drained ≠ logged: passthrough is budgeted per session (42 GB log incident,
    // 2026-07-12) — ARGUS_LIVE_FFMPEG_VERBOSE=1 restores the full stream.
    const stderrBudget = createStderrBudget({
      maxLines: LIVE_STDERR_MAX_LINES,
      verbose: envFlag(process.env.ARGUS_LIVE_FFMPEG_VERBOSE),
      log: (line) => log(`ffmpeg: ${line}`),
    });
    ffmpeg.stderr?.on("data", (chunk: Buffer) => stderrBudget.onChunk(chunk));

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
      stderrBudget.flush();
      const suppressed = stderrBudget.summary();
      log(`ffmpeg exited code=${code} signal=${signal}${suppressed ? `; ${suppressed}` : ""}`);
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
    // tell HomeKit the stream is live; otherwise report success so it starts
    // pulling. ARGUS_START_ACK_DELAY_MS is a diagnostic knob for Home's spinner
    // path: HAP-NodeJS's example acks only after FFmpeg has produced output.
    setTimeout(() => answer(), liveStartAckDelayMs());
  }

  private stopStream(sessionID: string): void {
    const session = this.sessions.get(sessionID);
    if (session?.rtcpMonitor) {
      this.logLine(
        `RTCP monitor video packets=${session.rtcpMonitor.videoPackets} port=${session.rtcpMonitor.videoPort}`,
      );
      session.rtcpMonitor.videoSocket.close();
    }
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
    capResolutions(videoMode === "copy" && liveResolution
      ? [[liveResolution.width, liveResolution.height, 30]]
      : process.env.ARGUS_LIVE_LADDER === "compat"
        ? compatSet
        : hiResSet);

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
      // Omitting audio puts HAP-NodeJS into its videoOnly fallback: the library
      // still advertises a fake OPUS capability because HomeKit needs one to
      // start the video stream, but Argus omits PrepareStreamResponse.audio and
      // sends no FFmpeg audio leg. Useful for isolating whether RTP audio output
      // is what stalls a session.
      // ARGUS_LIVE_AAC_ELD=1 advertises Apple's canonical AAC-ELD codec (16kHz)
      // instead of Opus (24kHz) — the experimental fix for the ≥720p audio-gates-
      // video hang (progress/attempt-008.md). Requires ARGUS_FFMPEG pointed at a
      // libfdk_aac build, or the live audio leg fails to start.
      ...(includeAudio
        ? {
            audio: {
              codecs: [
                process.env.ARGUS_LIVE_AAC_ELD === "1"
                  ? { type: AudioStreamingCodecType.AAC_ELD, samplerate: AudioStreamingSamplerate.KHZ_16 }
                  : { type: AudioStreamingCodecType.OPUS, samplerate: AudioStreamingSamplerate.KHZ_24 },
              ],
            },
          }
        : {}),
    },
  };
}

/**
 * Advertised accessory firmware metadata. This is useful visible accessory
 * metadata, but it is NOT a reliable streaming-profile cache-buster in
 * HAP-NodeJS 0.14.3: AccessoryInfo tracks the HAP-NodeJS package version for
 * its own config hash, and streaming TLVs did not move c# in attempt 011. Use
 * ARGUS_HAP_CONFIG_BUMP when a paired controller must see a new stream profile.
 */
export const ARGUS_FIRMWARE_REVISION = "1.2.1";

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
