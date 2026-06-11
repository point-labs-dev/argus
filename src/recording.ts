import { type ChildProcess, spawn } from "node:child_process";

import {
  type CameraRecordingConfiguration,
  type CameraRecordingDelegate,
  type CameraRecordingOptions,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  H264Level,
  H264Profile,
  MediaContainerType,
  type RecordingPacket,
  VideoCodecType,
} from "hap-nodejs";

import { readFragmentedMp4 } from "./mp4.js";

const PROFILE_TO_X264: Record<number, string> = {
  [H264Profile.BASELINE]: "baseline",
  [H264Profile.MAIN]: "main",
  [H264Profile.HIGH]: "high",
};
const LEVEL_TO_X264: Record<number, string> = {
  [H264Level.LEVEL3_1]: "3.1",
  [H264Level.LEVEL3_2]: "3.2",
  [H264Level.LEVEL4_0]: "4.0",
};
const SAMPLERATE_TO_HZ: Record<number, number> = {
  [AudioRecordingSamplerate.KHZ_8]: 8000,
  [AudioRecordingSamplerate.KHZ_16]: 16000,
  [AudioRecordingSamplerate.KHZ_24]: 24000,
  [AudioRecordingSamplerate.KHZ_32]: 32000,
  [AudioRecordingSamplerate.KHZ_44_1]: 44100,
  [AudioRecordingSamplerate.KHZ_48]: 48000,
};

/** Recording options Argus offers to HomeKit (resolutions cover the required set). */
export function buildRecordingOptions(): CameraRecordingOptions {
  return {
    prebufferLength: 4000,
    mediaContainerConfiguration: {
      type: MediaContainerType.FRAGMENTED_MP4,
      fragmentLength: 4000,
    },
    video: {
      type: VideoCodecType.H264,
      parameters: {
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
          type: AudioRecordingCodecType.AAC_LC,
          audioChannels: 1,
          samplerate: [
            AudioRecordingSamplerate.KHZ_32,
            AudioRecordingSamplerate.KHZ_24,
            AudioRecordingSamplerate.KHZ_16,
          ],
        },
      ],
    },
  };
}

/**
 * Pure builder for the FFmpeg fragmented-MP4 command HKSV records from. Unlike live
 * view, recording uses the full-res MAIN stream (transcoded H.264 + AAC-LC), with
 * keyframes aligned to the fragment length so each fragment starts on an IDR.
 */
export function buildRecordingFfmpegArgs(mainUrl: string, config: CameraRecordingConfiguration): string[] {
  const [width, height, fps] = config.videoCodec.resolution;
  const params = config.videoCodec.parameters;
  const profile = PROFILE_TO_X264[params.profile] ?? "high";
  const level = LEVEL_TO_X264[params.level] ?? "4.0";
  const fragmentSec = Math.max(config.mediaContainerConfiguration.fragmentLength / 1000, 1);
  const audioHz = SAMPLERATE_TO_HZ[config.audioCodec.samplerate] ?? 32000;

  return [
    "-hide_banner",
    "-loglevel", "error",
    "-fflags", "nobuffer",
    "-probesize", "500000",
    "-analyzeduration", "1000000",
    "-rtsp_transport", "tcp",
    "-i", mainUrl,

    // ONE output carrying BOTH streams (unlike live view's two separate SRTP outputs,
    // so no -an/-vn here). Video: transcode the main stream to the negotiated H.264
    // envelope; keyframes every fragment so each fMP4 fragment begins with an IDR.
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-profile:v", profile,
    "-level", level,
    "-pix_fmt", "yuv420p",
    "-color_range", "tv",
    "-r", String(fps),
    "-vf", `scale=${width}:${height}`,
    "-b:v", `${params.bitRate}k`,
    "-maxrate", `${params.bitRate}k`,
    "-bufsize", `${2 * params.bitRate}k`,
    "-force_key_frames", `expr:gte(t,n_forced*${fragmentSec})`,

    // audio: AAC-LC (ffmpeg native — no libfdk needed) at the negotiated rate.
    "-c:a", "aac",
    "-ac", "1",
    "-ar", String(audioHz),
    "-b:a", `${config.audioCodec.bitrate}k`,

    // fragmented MP4 to stdout for the box parser.
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "pipe:1",
  ];
}

export interface RecordingDelegateOptions {
  ffmpegPath?: string;
  verbose?: boolean;
  spawnFn?: typeof spawn;
}

/**
 * HKSV recording delegate for one camera. When the Home Hub requests a recording
 * (on motion), spawns FFmpeg on the main stream and streams the parsed fMP4
 * fragments back as RecordingPackets. The Home Hub does the person/vehicle/animal
 * classification on the delivered clip.
 */
export class ArgusRecordingDelegate implements CameraRecordingDelegate {
  private configuration: CameraRecordingConfiguration | undefined;
  private active = false;
  private readonly processes = new Map<number, ChildProcess>();
  private readonly ffmpegPath: string;
  private readonly verbose: boolean;
  private readonly spawnFn: typeof spawn;

  public constructor(
    private readonly cameraName: string,
    private readonly mainUrl: string,
    options: RecordingDelegateOptions = {},
  ) {
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.verbose = options.verbose ?? true;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  public updateRecordingActive(active: boolean): void {
    this.active = active;
  }

  public updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.configuration = configuration;
  }

  public async *handleRecordingStreamRequest(streamId: number, signal?: AbortSignal): AsyncGenerator<RecordingPacket> {
    const config = this.configuration;
    if (!config) {
      return;
    }

    const args = buildRecordingFfmpegArgs(this.mainUrl, config);
    if (this.verbose) {
      process.stderr.write(`[argus ${this.cameraName}] HKSV recording ${config.videoCodec.resolution.join("x")} -> ffmpeg ${args.join(" ")}\n`);
    }
    const ffmpeg = this.spawnFn(this.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.processes.set(streamId, ffmpeg);
    ffmpeg.stderr?.on("data", (chunk: Buffer) => {
      if (this.verbose) process.stderr.write(`[argus ${this.cameraName}] hksv-ffmpeg: ${chunk.toString().trimEnd()}\n`);
    });

    // Hold one segment back so the final one can be flagged isLast.
    let pending: Buffer | undefined;
    try {
      for await (const segment of readFragmentedMp4(ffmpeg.stdout!)) {
        if (signal?.aborted) {
          break;
        }
        if (pending !== undefined) {
          yield { data: pending, isLast: false };
        }
        pending = segment.data;
      }
      if (pending !== undefined) {
        yield { data: pending, isLast: true };
      }
    } finally {
      ffmpeg.kill("SIGKILL");
      this.processes.delete(streamId);
    }
  }

  public closeRecordingStream(streamId: number, _reason: unknown): void {
    this.processes.get(streamId)?.kill("SIGKILL");
    this.processes.delete(streamId);
  }
}
