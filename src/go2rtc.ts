import { stringify as stringifyYaml } from "yaml";

import type { ArgusConfig, CameraConfig } from "./config.js";

export interface Go2RtcConfig {
  api: {
    listen: string;
  };
  rtsp: {
    listen: string;
  };
  streams: Record<string, string[]>;
  /**
   * Streams whose producers go2rtc connects at startup and keeps connected
   * (stream name → probe query; "" = default video&audio). Without this a
   * producer only exists while a consumer is attached, so every HomeKit live
   * tap pays the cold camera connect (~1-3s) before the keyframe wait even
   * starts. Subs AND mains are preloaded: subs feed tiles/<720p live, mains
   * feed ≥720p live + HKSV. Standing LAN load ~40Mbps for 7 cameras —
   * acceptable, and the NVR pulls the mains continuously anyway.
   */
  preload: Record<string, string>;
}

export type CameraProfile = "main" | "sub";

export interface Go2RtcCameraStreamNames {
  cameraName: string;
  main: string;
  sub: string;
}

function encodeCredential(value: string): string {
  return encodeURIComponent(value);
}

function sanitizeStreamName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : "camera";
}

function buildUniqueStreamNames(cameras: readonly CameraConfig[]): string[] {
  const counts = new Map<string, number>();

  return cameras.map((camera) => {
    const baseName = sanitizeStreamName(camera.name);
    const count = counts.get(baseName) ?? 0;
    counts.set(baseName, count + 1);
    return count === 0 ? baseName : `${baseName}-${count + 1}`;
  });
}

export function buildGo2RtcStreamNames(cameras: readonly CameraConfig[]): Go2RtcCameraStreamNames[] {
  const streamNames = buildUniqueStreamNames(cameras);

  return cameras.map((camera, index) => {
    const streamName = streamNames[index];

    if (!streamName) {
      throw new Error(`Missing generated stream name for camera "${camera.name}".`);
    }

    return {
      cameraName: camera.name,
      main: streamName,
      sub: `${streamName}-sub`,
    };
  });
}

export function buildHttpFlvUrl(camera: CameraConfig, profile: CameraProfile): string {
  const streamName = profile === "main" ? "main" : "ext";
  const username = encodeCredential(camera.username);
  const password = encodeCredential(camera.password);

  return `http://${camera.host}/flv?port=1935&app=bcs&stream=channel${camera.channel}_${streamName}.bcs&user=${username}&password=${password}`;
}

export function buildRtspUrl(camera: CameraConfig, profile: CameraProfile): string {
  const previewChannel = String(camera.channel + 1).padStart(2, "0");
  const username = encodeCredential(camera.username);
  const password = encodeCredential(camera.password);
  // Codec-prefixed paths (h264/h265Preview_0N) work on every Reolink device class
  // tested — standalone cams, NVR channels, doorbell. The bare Preview_0N form
  // 404s on newer 4K/H.265 models (RLC-812A), so always prefix. Sub is H.264.
  // On the NVR the prefix is only a path LABEL: its namespace has h264Preview_*
  // names exclusively (h265Preview_* 404s) while the payload follows the channel
  // encoder — the 12MP D1200 channels serve HEVC inside h264Preview_0N_main
  // (probed 2026-06-11). mainCodec stays the TRUE codec (it drives transport
  // selection); NVR-fronted cameras (channel > 0 — standalone Reolink cams are
  // always channel 0) keep the h264 path name regardless.
  const codec =
    profile === "main" && camera.channel === 0 ? camera.mainCodec : "h264";

  return `rtsp://${username}:${password}@${camera.host}:554/${codec}Preview_${previewChannel}_${profile}`;
}

export function buildTransportSources(camera: CameraConfig, profile: CameraProfile): string[] {
  const httpFlvUrl = buildHttpFlvUrl(camera, profile);
  const rtspUrl = buildRtspUrl(camera, profile);

  switch (camera.transport) {
    case "auto":
      // H.265 main streams don't work over Reolink HTTP-FLV (verified: bare and
      // ffmpeg-wrapped FLV both fail on the RLC-812A; the HEVC NVR channels hang
      // the same way) — use RTSP only. H.264 mains keep HTTP-FLV first with RTSP
      // fallback.
      if (profile === "main") {
        return camera.mainCodec === "h265" ? [rtspUrl] : [httpFlvUrl, rtspUrl];
      }
      // Subs: RTSP first. The FLV name for "sub" is actually the EXT profile
      // (896-wide, FIXED ~2s keyframes, not API-configurable) while RTSP serves
      // the true fluent sub whose gop the tuner sets to 1s — measured 2026-06-11,
      // sourcing ext cost tiles ~1s of extra keyframe wait. Now that ≥720p live
      // sessions transcode the main stream, ext's extra width buys nothing.
      return [rtspUrl, httpFlvUrl];
    case "http-flv":
      return [httpFlvUrl];
    case "rtsp":
      return [rtspUrl];
  }
}

export function generateGo2RtcConfig(config: ArgusConfig): Go2RtcConfig {
  const streamNames = buildGo2RtcStreamNames(config.cameras);
  const streams: Record<string, string[]> = {};
  const preload: Record<string, string> = {};

  config.cameras.forEach((camera, index) => {
    const streamName = streamNames[index];

    if (!streamName) {
      throw new Error(`Missing generated stream name for camera "${camera.name}".`);
    }

    streams[streamName.main] = buildTransportSources(camera, "main");
    streams[streamName.sub] = buildTransportSources(camera, "sub");
    preload[streamName.sub] = "";
    preload[streamName.main] = "";
  });

  return {
    api: {
      listen: `127.0.0.1:${config.go2rtc.api_port}`,
    },
    rtsp: {
      listen: "127.0.0.1:8554",
    },
    streams,
    preload,
  };
}

export function generateGo2RtcYaml(config: ArgusConfig): string {
  return stringifyYaml(generateGo2RtcConfig(config), {
    lineWidth: 0,
  });
}
