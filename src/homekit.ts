import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";

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
import type { SnapshotCache, SnapshotProfile } from "./snapshot-cache.js";

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
  /** go2rtc local restream, e.g. rtsp://127.0.0.1:8554/backyard-left-sub */
  inputUrl: string;
  targetAddress: string;
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
 * Pure builder for the FFmpeg live-streaming command (video + Opus audio over SRTP).
 * Kept side-effect free so it can be unit-tested without spawning anything.
 */
export function buildLiveFfmpegArgs(input: LiveFfmpegInput): string[] {
  const { inputUrl, targetAddress, video, audio } = input;

  return [
    "-hide_banner",
    "-loglevel", "error",
    // Low-latency input: cap RTSP stream analysis so FFmpeg starts emitting within
    // ~1s. Without these, its default ~5s analysis runs past HomeKit's stream-start
    // window and the iOS client spins forever then drops to "No Response".
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-probesize", "500000",
    "-analyzeduration", "1000000",
    "-rtsp_transport", "tcp",
    "-i", inputUrl,

    // --- video: transcode to the negotiated H.264 params, SRTP out ---
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-color_range", "tv",
    "-r", String(video.fps),
    "-vf", `scale=${video.width}:${video.height}`,
    // HomeKit needs frequent keyframes and no B-frames, or the iOS client waits
    // forever for a decodable IDR (the "spinner that never resolves" symptom).
    "-bf", "0",
    "-g", String(video.fps * 2),
    "-keyint_min", String(video.fps),
    "-force_key_frames", "expr:gte(t,n_forced*1)",
    "-b:v", `${video.maxBitrateKbps}k`,
    "-maxrate", `${video.maxBitrateKbps}k`,
    "-bufsize", `${2 * video.maxBitrateKbps}k`,
    "-payload_type", String(video.payloadType),
    "-ssrc", String(video.ssrc),
    "-f", "rtp",
    "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
    "-srtp_out_params", video.srtpParams,
    `srtp://${targetAddress}:${video.port}?rtcpport=${video.port}&localrtcpport=${video.localRtcpPort}&pkt_size=${video.mtu}`,

    // --- audio: transcode to Opus, SRTP out ---
    "-vn",
    "-c:a", "libopus",
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
  prepared: {
    targetAddress: string;
    video: { port: number; localRtcpPort: number; ssrc: number; srtpParams: string };
    audio: { port: number; localRtcpPort: number; ssrc: number; srtpParams: string };
  };
}

export interface StreamingDelegateOptions {
  /** Which profile to pull for live view. Default "sub" (H.264, light). */
  liveProfile?: SnapshotProfile;
  /** Override FFmpeg binary path (default "ffmpeg"). */
  ffmpegPath?: string;
  /** Log the FFmpeg command + stderr to the console. Default true. */
  verbose?: boolean;
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
  private readonly liveProfile: SnapshotProfile;
  private readonly ffmpegPath: string;
  private readonly verbose: boolean;
  private readonly spawnFn: typeof spawn;

  public constructor(
    private readonly cameraName: string,
    /** go2rtc local restream base name resolver, e.g. () => "rtsp://127.0.0.1:8554/backyard-left-sub" */
    private readonly liveUrl: string,
    private readonly snapshots: SnapshotCache,
    options: StreamingDelegateOptions = {},
  ) {
    this.liveProfile = options.liveProfile ?? "sub";
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.verbose = options.verbose ?? true;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  public handleSnapshotRequest(_request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    this.snapshots
      .getOrRefresh(this.cameraName, this.liveProfile)
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
    // RECONFIGURE: accept without re-spawning for v1.
    callback();
  }

  private startStream(request: Extract<StreamingRequest, { type: StreamRequestTypes.START }>, callback: StreamRequestCallback): void {
    const session = this.sessions.get(request.sessionID);
    if (!session) {
      callback(new Error(`No prepared session ${request.sessionID} for ${this.cameraName}`));
      return;
    }

    const args = buildLiveFfmpegArgs({
      inputUrl: this.liveUrl,
      targetAddress: session.prepared.targetAddress,
      video: {
        port: session.prepared.video.port,
        localRtcpPort: session.prepared.video.localRtcpPort,
        ssrc: session.prepared.video.ssrc,
        payloadType: request.video.pt,
        maxBitrateKbps: request.video.max_bit_rate,
        fps: request.video.fps,
        width: request.video.width,
        height: request.video.height,
        mtu: request.video.mtu,
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
    });

    const log = (msg: string): void => {
      if (this.verbose) process.stderr.write(`[argus ${this.cameraName}] ${msg}\n`);
    };
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
      callback(error);
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
      if (code !== 0 && signal !== "SIGKILL") {
        this.controller?.forceStopStreamingSession(request.sessionID);
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
export function buildCameraControllerOptions(delegate: ArgusStreamingDelegate): CameraControllerOptions {
  return {
    cameraStreamCount: 2, // allow two concurrent viewers
    delegate,
    streamingOptions: {
      supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
      video: {
        codec: {
          profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
          levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
        },
        resolutions: [
          [1920, 1080, 30],
          [1280, 720, 30],
          [640, 480, 30],
          [640, 360, 30],
          [320, 240, 15],
        ],
      },
      audio: {
        codecs: [
          {
            type: AudioStreamingCodecType.OPUS,
            samplerate: AudioStreamingSamplerate.KHZ_24,
          },
        ],
      },
    },
  };
}

export interface CameraAccessoryHandle {
  accessory: Accessory;
  delegate: ArgusStreamingDelegate;
}

/**
 * Build a standalone HAP camera accessory (own pairing identity) for one camera.
 * `liveUrl` is the go2rtc restream; snapshots come from the shared cache.
 */
export function createCameraAccessory(
  camera: CameraConfig,
  liveUrl: string,
  snapshots: SnapshotCache,
  options: StreamingDelegateOptions = {},
): CameraAccessoryHandle {
  const accessory = new Accessory(camera.name, uuid.generate(`argus:camera:${camera.name}`));
  accessory.category = Categories.IP_CAMERA;

  accessory
    .getService(Service.AccessoryInformation)!
    .setCharacteristic(Characteristic.Manufacturer, "Point Labs")
    .setCharacteristic(Characteristic.Model, "Argus")
    .setCharacteristic(Characteristic.SerialNumber, `argus-${camera.host}-${camera.channel}`);

  const delegate = new ArgusStreamingDelegate(camera.name, liveUrl, snapshots, options);
  const controller = new CameraController(buildCameraControllerOptions(delegate));
  delegate.controller = controller;
  accessory.configureController(controller);

  return { accessory, delegate };
}
