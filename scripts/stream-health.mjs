#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { parse } from "yaml";

const { buildGo2RtcStreamNames } = await import("../dist/go2rtc.js").catch(() => {
  process.stderr.write("dist/go2rtc.js is missing. Run npm run build.\n");
  process.exit(1);
});

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    process.stderr.write(`Missing value for ${flag}\n`);
    process.exit(1);
  }
  return value;
}

function downReason(probe) {
  if (probe.error) {
    if (probe.error.code === "ENOENT") {
      return "ffprobe-missing";
    }
    return "timeout";
  }
  return `exit=${probe.status}`;
}

const argv = process.argv.slice(2);
const configPath = flagValue(argv, "--config") ?? "argus.yaml";
const timeoutRaw = flagValue(argv, "--timeout-ms") ?? "12000";
const timeoutMs = Number(timeoutRaw);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  process.stderr.write("Invalid --timeout-ms\n");
  process.exit(1);
}

let doc;
try {
  doc = parse(readFileSync(configPath, "utf8"));
} catch {
  process.stderr.write("Cannot read config\n");
  process.exit(1);
}

if (!doc || !Array.isArray(doc.cameras)) {
  process.stderr.write("cameras missing\n");
  process.exit(1);
}

const named = [];
for (const camera of doc.cameras) {
  if (!camera || typeof camera.name !== "string" || camera.name.trim() === "") {
    process.stderr.write("camera name missing\n");
    process.exit(1);
  }
  named.push({ name: camera.name });
}

const targets = [];
for (const item of buildGo2RtcStreamNames(named)) {
  targets.push(item.main, item.sub);
}

process.stdout.write(`stream_count=${targets.length}\n`);
let up = 0;
for (const name of targets) {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-rtsp_transport",
      "tcp",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height",
      "-of",
      "csv=p=0",
      `rtsp://127.0.0.1:8554/${name}`,
    ],
    { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] },
  );
  const line = (probe.stdout || "").trim().split("\n")[0] ?? "";
  if (probe.status === 0 && line) {
    up += 1;
    process.stdout.write(`${name}\tUP\t${line}\n`);
  } else {
    process.stdout.write(`${name}\tDOWN\t${downReason(probe)}\n`);
  }
}
process.stdout.write(`up_count=${up}\n`);
process.exit(up === targets.length && targets.length > 0 ? 0 : 1);
