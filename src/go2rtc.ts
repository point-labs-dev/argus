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
   * starts. Sub streams are preloaded; mains stay on-demand (HKSV only).
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
  const codec = profile === "main" ? camera.mainCodec : "h264";

  return `rtsp://${username}:${password}@${camera.host}:554/${codec}Preview_${previewChannel}_${profile}`;
}

export function buildTransportSources(camera: CameraConfig, profile: CameraProfile): string[] {
  const httpFlvUrl = buildHttpFlvUrl(camera, profile);
  const rtspUrl = buildRtspUrl(camera, profile);

  switch (camera.transport) {
    case "auto":
      // H.265 main streams don't work over Reolink HTTP-FLV (verified: bare and
      // ffmpeg-wrapped FLV both fail on the RLC-812A) — use RTSP only. Everything
      // else (all subs, H.264 mains) keeps HTTP-FLV first with RTSP fallback.
      if (profile === "main" && camera.mainCodec === "h265") {
        return [rtspUrl];
      }
      return [httpFlvUrl, rtspUrl];
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
