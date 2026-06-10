#!/usr/bin/env node
// Real-hardware smoke for the camera spine: config -> go2rtc supervisor ->
// stream health -> snapshot cache -> RTSP restream probe. Needs ./argus.yaml
// (private) and the ./go2rtc binary. Run after `npm run build`.

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

import {
  buildGo2RtcStreamNames,
  loadArgusConfig,
  SnapshotCache,
  startGo2Rtc,
} from "../dist/index.js";

const configPath = process.argv[2] ?? "argus.yaml";

function fail(step, detail) {
  console.error(`FAIL [${step}] ${detail}`);
  process.exitCode = 1;
}

function ffprobe(url, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      ["-v", "error", "-rtsp_transport", "tcp", "-select_streams", "v:0",
       "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", url],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
  });
}

const config = await loadArgusConfig(configPath);
console.log(`OK   [config] ${config.cameras.length} camera(s) loaded from ${configPath}`);

const supervisor = await startGo2Rtc(config, {
  configPath: "go2rtc.generated.yaml",
  forceConfigOverwrite: true,
  stdio: "ignore",
});
console.log(`OK   [go2rtc] healthy at http://127.0.0.1:${config.go2rtc.api_port}`);

try {
  const cache = new SnapshotCache(config);
  for (const names of buildGo2RtcStreamNames(config.cameras)) {
    const snapshot = await cache.refresh(names.cameraName, "sub");
    const isJpeg = snapshot.buffer[0] === 0xff && snapshot.buffer[1] === 0xd8;
    if (!isJpeg) {
      fail("snapshot", `${names.cameraName}: not a JPEG`);
      continue;
    }
    const outPath = `/tmp/argus-smoke-${names.sub}.jpg`;
    await writeFile(outPath, snapshot.buffer);
    console.log(`OK   [snapshot] ${names.cameraName} sub -> ${outPath} (${snapshot.bytes} bytes)`);

    const probe = await ffprobe(`rtsp://127.0.0.1:8554/${names.sub}`);
    if (probe.code === 0 && probe.out) {
      console.log(`OK   [rtsp] ${names.sub} restream: ${probe.out}`);
    } else {
      fail("rtsp", `${names.sub}: exit=${probe.code} ${probe.err || probe.out}`);
    }
  }
} finally {
  const stop = await supervisor.stop();
  console.log(`OK   [stop] go2rtc stopped (exitCode=${stop.exitCode}, timedOut=${stop.timedOut})`);
}

console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
