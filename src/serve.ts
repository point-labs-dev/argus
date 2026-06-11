#!/usr/bin/env node

import { createHash } from "node:crypto";
import * as path from "node:path";

import { Categories, HAPStorage } from "hap-nodejs";

import { loadArgusConfig, type ArgusConfig } from "./config.js";
import { buildGo2RtcStreamNames } from "./go2rtc.js";
import { startGo2Rtc, type Go2RtcSupervisor } from "./go2rtc-supervisor.js";
import { createCameraAccessory } from "./homekit.js";
import { MotionMonitor } from "./motion.js";
import { SnapshotCache } from "./snapshot-cache.js";

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
  cache.startPolling(5_000, ["sub"]);

  const streamNames = buildGo2RtcStreamNames(config.cameras);
  const setMotionByCamera = new Map<string, (detected: boolean) => void>();
  const published = config.cameras.map((camera, index) => {
    const names = streamNames[index]!;
    const liveUrl = `${RTSP_RESTREAM_BASE}/${names.sub}`; // live view = light sub stream
    const mainUrl = `${RTSP_RESTREAM_BASE}/${names.main}`; // HKSV recording = full-res main stream
    // ARGUS_AUDIO=0 publishes video-only accessories (diagnostic isolation).
    const includeAudio = process.env.ARGUS_AUDIO !== "0";
    const { accessory, setMotion } = createCameraAccessory(camera, liveUrl, mainUrl, cache, { includeAudio });
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

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
