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

  return `rtsp://${username}:${password}@${camera.host}:554/Preview_${previewChannel}_${profile}`;
}

export function buildTransportSources(camera: CameraConfig, profile: CameraProfile): string[] {
  const httpFlvUrl = buildHttpFlvUrl(camera, profile);
  const rtspUrl = buildRtspUrl(camera, profile);

  switch (camera.transport) {
    case "auto":
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

  config.cameras.forEach((camera, index) => {
    const streamName = streamNames[index];

    if (!streamName) {
      throw new Error(`Missing generated stream name for camera "${camera.name}".`);
    }

    streams[streamName.main] = buildTransportSources(camera, "main");
    streams[streamName.sub] = buildTransportSources(camera, "sub");
  });

  return {
    api: {
      listen: `127.0.0.1:${config.go2rtc.api_port}`,
    },
    rtsp: {
      listen: "127.0.0.1:8554",
    },
    streams,
  };
}

export function generateGo2RtcYaml(config: ArgusConfig): string {
  return stringifyYaml(generateGo2RtcConfig(config), {
    lineWidth: 0,
  });
}
