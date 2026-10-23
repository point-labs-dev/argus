#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Categories, HAPStorage } from "hap-nodejs";

import { formatError } from "./cli.js";
import { warnShortPasswords } from "./reolink.js";
import { loadArgusConfig, type ArgusConfig } from "./config.js";
import { buildGo2RtcStreamNames } from "./go2rtc.js";
import { startGo2Rtc, type Go2RtcSupervisor } from "./go2rtc-supervisor.js";
import { createCameraAccessory, getHapBindAddress } from "./homekit.js";
import { MotionMonitor, writeMotionPollError, type MotionEdge } from "./motion.js";
import { parseJpegDimensions, SnapshotCache } from "./snapshot-cache.js";
import { emitTelemetry } from "./telemetry.js";

const HOMEKIT_PORT_BASE = 51200;
const RTSP_RESTREAM_BASE = "rtsp://127.0.0.1:8554";

/** Stable, locally-administered MAC for a camera accessory, derived from its name. */
function macFromName(name: string): string {
  const bytes = [...createHash("sha256").update(`argus:camera:${name}`).digest().subarray(0, 6)];
  bytes[0] = (bytes[0]! & 0xfe) | 0x02; // locally administered, unicast
  return bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

export interface ArgusServer {
  stop(): Promise<void>;
}

export interface ArgusServerDeps {
  afterGo2Rtc?: (passwords: readonly string[]) => void;
}

export async function startArgusServer(
  config: ArgusConfig,
  configDir = process.cwd(),
  deps?: ArgusServerDeps,
): Promise<ArgusServer> {
  HAPStorage.setCustomStoragePath(path.join(configDir, ".homekit"));

  const passwords = config.cameras.map((camera) => camera.password);
  const supervisor: Go2RtcSupervisor = await startGo2Rtc(config, {
    configPath: path.join(configDir, "go2rtc.generated.yaml"),
    forceConfigOverwrite: true,
    binaryPath: config.go2rtc.binary,
    stdio: "pipe",
  });

  const cache = new SnapshotCache(config, {
    defaultProfile: "sub",
    apiCredentials: supervisor.apiCredentials,
  });
  // Home-app grid stills come from the MAIN streams (2560x1920–4512x2512 —
  // go2rtc decodes a JPEG per request, HEVC included, verified fleet-wide
  // 2026-06-12). The poll loop is sequential, so one decode at a time: a full
  // 7-camera sweep takes ~5-8s, giving each tile a fresh still every ~15s —
  // about Apple's own grid refresh cadence — at a bounded go2rtc cost. The sub
  // profile stays available for on-demand consumers (boot resolution probe).
  let motion: MotionMonitor | undefined;
  const published: { unpublish(): void }[] = [];
  try {
    cache.startPolling(10_000, ["main"]);
    deps?.afterGo2Rtc?.(passwords);

    // Probe each camera's live (sub) resolution from a snapshot so the accessory
    // advertises the native size copy-mode live view will deliver. Retries through
    // the startup window: go2rtc's preloaded producers are still connecting (and the
    // camera HTTP servers briefly refuse under the parallel connect burst), so the
    // first attempts routinely fail. Cameras that never answer fall back to the
    // standard ≤640x480 set.
    const liveResolutions = new Map<string, { width: number; height: number }>();
    await Promise.all(
      config.cameras.map(async (camera) => {
        const deadline = Date.now() + 25_000;
        let lastError: unknown;
        while (Date.now() < deadline) {
          try {
            const snapshot = await cache.refresh(camera.name, "sub");
            const dims = parseJpegDimensions(snapshot.buffer);
            if (!dims) throw new Error("snapshot JPEG has no parseable dimensions");
            liveResolutions.set(camera.name, dims);
            process.stdout.write(`[argus ${camera.name}] live source ${dims.width}x${dims.height}\n`);
            return;
          } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 1_500));
          }
        }
        const message = lastError instanceof Error ? lastError.message : String(lastError);
        process.stderr.write(`[argus ${camera.name}] live-resolution probe failed (${message}); advertising defaults\n`);
      }),
    );

    const streamNames = buildGo2RtcStreamNames(config.cameras);
    const setMotionByCamera = new Map<string, (detected: boolean, edge?: MotionEdge) => void>();
  
    // Get HAP bind address for interface pinning (dual-NIC safety + prepareStream addressOverride).
    // camera-ffmpeg pattern: HAP advertise + ffmpeg localaddr + RTCP bind = same IP.
    const bindAddress = getHapBindAddress();
    if (bindAddress) {
      process.stdout.write(`[argus] HAP bind address: ${bindAddress}\n`);
    }
  
    config.cameras.forEach((camera, index) => {
      const names = streamNames[index]!;
      const liveUrl = `${RTSP_RESTREAM_BASE}/${names.sub}`; // live view = light sub stream
      const mainUrl = `${RTSP_RESTREAM_BASE}/${names.main}`; // HKSV recording = full-res main stream
      // ARGUS_AUDIO=0 publishes video-only accessories (diagnostic isolation).
      const includeAudio = process.env.ARGUS_AUDIO !== "0";
      const liveResolution = liveResolutions.get(camera.name);
      // Transcode is the validated live path: tiles/<720p transcode the sub stream,
      // ≥720p sessions (Apple's standard ladder, advertised up to 1080p) transcode
      // the full-res main. ARGUS_LIVE_COPY=1 opts into the experimental passthrough
      // (needs the probed resolution; macOS Home kills mismatched copy sessions).
      const videoMode =
        process.env.ARGUS_LIVE_COPY === "1" && liveResolution ? "copy" : "transcode";
      // Standalone cameras (their own host) source ≥720p live from the main stream.
      // NVR-fronted channels don't: their mains keyframe every 4s (hard limit) and
      // the D1200s encode 12MP HEVC — both blow the live start-time budget. Their
      // ≥720p sessions upscale the 896-wide sub source instead.
      const standalone = config.cameras.filter((c) => c.host === camera.host).length === 1;
      const mainEnabled = standalone && process.env.ARGUS_LIVE_MAIN_SOURCE === "1";
      process.stdout.write(
        `[argus ${camera.name}] live mode: ${videoMode}${videoMode === "transcode" ? ` (≥720p source: ${mainEnabled ? "main" : "sub"})` : ""}\n`,
      );
      const { accessory, setMotion } = createCameraAccessory(camera, liveUrl, mainUrl, cache, {
        includeAudio,
        videoMode,
        ...(process.env.ARGUS_FFMPEG ? { ffmpegPath: process.env.ARGUS_FFMPEG } : {}),
        ...(bindAddress ? { bindAddress } : {}),
        // HomeKit snapshot requests serve the full-res main-stream stills the
        // cache polls — the 640-wide sub stills read as "pixelated" on the grid.
        snapshotProfile: "main",
        ...(standalone && process.env.ARGUS_LIVE_MAIN_SOURCE === "1" ? { mainStreamUrl: mainUrl } : {}),
        ...(liveResolution ? { liveResolution } : {}),
      });
      setMotionByCamera.set(camera.name, setMotion);
      const username = macFromName(camera.name);
      const port = HOMEKIT_PORT_BASE + index;

      published.push(accessory);
      accessory.publish({ username, pincode: config.homekit.pin, port, category: Categories.IP_CAMERA });

      process.stdout.write(
        `\n  📷 ${camera.name}\n     pair code: ${config.homekit.pin}\n     setup URI: ${accessory.setupURI()}\n     (port ${port}, id ${username})\n`,
      );
    });

    // Drive the HomeKit motion sensors from the Reolink motion API.
    motion = new MotionMonitor(
      config.cameras,
      (cameraName, detected, edge?: MotionEdge) => {
        const setMotion = setMotionByCamera.get(cameraName);
        if (setMotion) {
          if (edge) setMotion(detected, edge);
          else setMotion(detected);
        }
        emitTelemetry(cameraName, "homekit_motion_updated", { detected });
        process.stdout.write(`[argus ${cameraName}] motion ${detected ? "DETECTED" : "cleared"}\n`);
      
        // Pre-warm streams on motion detection: immediately refresh both main and sub
        // snapshots WITH RETRIES so go2rtc's prebuffer has recent frames when a live
        // session opens. Retries handle transient go2rtc 500s (stream briefly cold,
        // camera slow to respond). Both profiles warm in parallel; telemetry waits for
        // the sub (live source for tiles/<720p) to confirm readiness.
        if (detected) {
          void cache.warmStream(cameraName, "main", 3, 150).then((result) => {
            if (!result.success) {
              const message = result.error?.message ?? "unknown error";
              process.stderr.write(
                `[argus ${cameraName}] stream pre-warm (main) failed after ${result.attempts} attempts: ${message}\n`,
              );
            }
          });
          void cache.warmStream(cameraName, "sub", 3, 150).then((result) => {
            if (result.success) {
              emitTelemetry(cameraName, "go2rtc_stream_warmed");
            } else {
              const message = result.error?.message ?? "unknown error";
              process.stderr.write(
                `[argus ${cameraName}] stream pre-warm (sub) failed after ${result.attempts} attempts: ${message}\n`,
              );
            }
          });
        }
      },
      {
        onError: (cameraName, error) => {
          writeMotionPollError(cameraName, error, passwords);
        },
      },
    );
    motion.start();

    process.stdout.write(`\nArgus is live. Add each camera in the Home app → Add Accessory → "More options" → enter the pair code above.\n`);

    return {
      async stop() {
        motion?.stop();
        for (const accessory of published) {
          accessory.unpublish();
        }
        await cache.stopPolling();
        await supervisor.stop();
      },
    };
  } catch (error) {
    motion?.stop();
    for (const accessory of published) {
      try {
        accessory.unpublish();
      } catch {
        // The accessory may already be unpublished.
      }
    }
    try {
      await cache.stopPolling();
    } catch {
      // The poll is already stopped.
    }
    try {
      await supervisor.stop();
    } catch {
      // The child is already gone.
    }
    throw error;
  }
}

export async function serveConfig(configPath: string, deps?: ArgusServerDeps): Promise<void> {
  const secrets: string[] = [];
  try {
    await runServer(secrets, configPath, deps);
  } catch (error) {
    process.stderr.write(`${formatError(error, secrets)}\n`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  await serveConfig(process.argv[2] ?? "argus.yaml");
}

async function runServer(secrets: string[], configPath: string, deps?: ArgusServerDeps): Promise<void> {
  const config = await loadArgusConfig(configPath);
  for (const camera of config.cameras) secrets.push(camera.password);
  warnShortPasswords(config.cameras.map((camera) => camera.password));
  const server = await startArgusServer(config, path.dirname(path.resolve(configPath)), deps);

  const shutdown = (): void => {
    process.stdout.write("\nShutting down…\n");
    server
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run only when invoked directly (not when imported by tests). Compare REAL
// paths: launchd invokes dist/serve.js through whatever path is baked into the
// plist, and if any segment is a symlink (2026-06-12: ~/code became a symlink
// to ~/Projects mid-day) a naive string compare silently no-ops and the
// daemon exit-0 loops with the cameras down.
const invokedDirectly = ((): boolean => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  void main();
}
