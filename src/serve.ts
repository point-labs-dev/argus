#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Categories, HAPStorage } from "hap-nodejs";

import { loadArgusConfig, type ArgusConfig } from "./config.js";
import { buildGo2RtcStreamNames } from "./go2rtc.js";
import { startGo2Rtc, type Go2RtcSupervisor } from "./go2rtc-supervisor.js";
import { createCameraAccessory } from "./homekit.js";
import { MotionMonitor } from "./motion.js";
import { parseJpegDimensions, SnapshotCache } from "./snapshot-cache.js";

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

export async function startArgusServer(config: ArgusConfig, configDir = process.cwd()): Promise<ArgusServer> {
  HAPStorage.setCustomStoragePath(path.join(configDir, ".homekit"));

  const supervisor: Go2RtcSupervisor = await startGo2Rtc(config, {
    configPath: path.join(configDir, "go2rtc.generated.yaml"),
    forceConfigOverwrite: true,
    binaryPath: config.go2rtc.binary,
    stdio: "ignore",
  });

  const cache = new SnapshotCache(config, { defaultProfile: "sub" });
  // Home-app grid stills come from the MAIN streams (2560x1920–4512x2512 —
  // go2rtc decodes a JPEG per request, HEVC included, verified fleet-wide
  // 2026-06-12). The poll loop is sequential, so one decode at a time: a full
  // 7-camera sweep takes ~5-8s, giving each tile a fresh still every ~15s —
  // about Apple's own grid refresh cadence — at a bounded go2rtc cost. The sub
  // profile stays available for on-demand consumers (boot resolution probe).
  cache.startPolling(10_000, ["main"]);

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
  const setMotionByCamera = new Map<string, (detected: boolean) => void>();
  const published = config.cameras.map((camera, index) => {
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
    process.stdout.write(
      `[argus ${camera.name}] live mode: ${videoMode}${videoMode === "transcode" ? ` (≥720p source: ${standalone ? "main" : "sub"})` : ""}\n`,
    );
    const { accessory, setMotion } = createCameraAccessory(camera, liveUrl, mainUrl, cache, {
      includeAudio,
      videoMode,
      // HomeKit snapshot requests serve the full-res main-stream stills the
      // cache polls — the 640-wide sub stills read as "pixelated" on the grid.
      snapshotProfile: "main",
      // Main-source live is PARKED (2026-06-12 night): every on-device
      // session class that rendered with audio used SUB video; main-sourced
      // sessions hung at iOS's A/V gate regardless of bitrate/packets/
      // keyframes/audio filters (see progress/attempt-007). Re-grant per
      // camera once the main restream's A/V timing is proven by the
      // offline validator. ARGUS_LIVE_MAIN_SOURCE=1 re-enables for tests.
      ...(standalone && process.env.ARGUS_LIVE_MAIN_SOURCE === "1" ? { mainStreamUrl: mainUrl } : {}),
      ...(liveResolution ? { liveResolution } : {}),
    });
    setMotionByCamera.set(camera.name, setMotion);
    const username = macFromName(camera.name);
    const port = HOMEKIT_PORT_BASE + index;

    accessory.publish({ username, pincode: config.homekit.pin, port, category: Categories.IP_CAMERA });

    process.stdout.write(
      `\n  📷 ${camera.name}\n     pair code: ${config.homekit.pin}\n     setup URI: ${accessory.setupURI()}\n     (port ${port}, id ${username})\n`,
    );
    return accessory;
  });

  // Drive the HomeKit motion sensors from the Reolink motion API.
  const motion = new MotionMonitor(
    config.cameras,
    (cameraName, detected) => {
      setMotionByCamera.get(cameraName)?.(detected);
      process.stdout.write(`[argus ${cameraName}] motion ${detected ? "DETECTED" : "cleared"}\n`);
    },
    { onError: (cameraName, error) => process.stderr.write(`[argus ${cameraName}] motion poll error: ${error.message}\n`) },
  );
  motion.start();

  process.stdout.write(`\nArgus is live. Add each camera in the Home app → Add Accessory → "More options" → enter the pair code above.\n`);

  return {
    async stop() {
      motion.stop();
      for (const accessory of published) {
        accessory.unpublish();
      }
      await cache.stopPolling();
      await supervisor.stop();
    },
  };
}

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? "argus.yaml";
  const config = await loadArgusConfig(configPath);
  const server = await startArgusServer(config, path.dirname(path.resolve(configPath)));

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
