#!/usr/bin/env node
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoDir = resolve(new URL("..", import.meta.url).pathname);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const camera = arg("camera", "Garage Door");
const errLog = resolve(arg("err-log", resolve(repoDir, "logs/serve.err.log")));
const jsonOut = arg("json-out", "");
const timeoutSeconds = Number(arg("timeout-seconds", "180"));
const pollMs = Number(arg("poll-ms", "250"));
const startAtBeginning = process.argv.includes("--from-start");
const ignoreControllers = new Set(
  (arg("ignore-controller", "") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function emit(result) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (jsonOut) writeFileSync(resolve(jsonOut), json);
  process.stdout.write(json);
}

function timestampOf(line) {
  const token = line.match(/^\d{4}-\d{2}-\d{2}T\S+/)?.[0];
  if (!token) return undefined;
  const timestamp = Date.parse(token);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function liveEventKind(line) {
  if (line.includes("HomeKit negotiated")) return "negotiated";
  if (line.includes("HomeKit reconfigure")) return "reconfigure";
  if (line.includes("ffmpeg exited")) return "ffmpeg exited";
  if (line.includes("ffmpeg spawn error")) return "ffmpeg spawn error";
  if (line.includes("RTCP monitor")) return "RTCP monitor";
  if (line.includes(" ffmpeg ")) return "ffmpeg command";
  return "live event";
}

function parseNegotiated(line) {
  const video = line.match(/HomeKit negotiated video: (\d+)x(\d+)@(\d+)/);
  return {
    width: video ? Number(video[1]) : undefined,
    height: video ? Number(video[2]) : undefined,
    fps: video ? Number(video[3]) : undefined,
    profile: line.match(/profile=([^ ]+)/)?.[1],
    level: line.match(/level=([^ ]+)/)?.[1],
    payloadType: Number(line.match(/ptype=(\d+)/)?.[1]),
    askedKbps: Number(line.match(/asked=(\d+)k/)?.[1]),
    servingKbps: Number(line.match(/serving=(\d+)k/)?.[1]),
    mtu: Number(line.match(/mtu=(\d+)/)?.[1]),
    mode: line.match(/mode=([^ ]+)/)?.[1],
    source: line.match(/source=([^ ]+)/)?.[1],
    controller: line.match(/controller=([^ ]+)/)?.[1],
    target: line.match(/target=([^ ]+)/)?.[1],
    rtcp: line.match(/rtcp=([^;]+)/)?.[1],
    audio: line.match(/audio: (.+)$/)?.[1],
  };
}

function summarize(lines, startedAtMs, observedAtMs) {
  const negotiatedLine = lines.find((line) => line.includes("HomeKit negotiated"));
  const ffmpegLine = lines.find((line) => line.includes(" ffmpeg ") && !line.includes("ffmpeg exited"));
  const exitLine = [...lines].reverse().find((line) => line.includes("ffmpeg exited"));
  const spawnErrorLine = [...lines].reverse().find((line) => line.includes("ffmpeg spawn error"));
  const rtcpLine = [...lines].reverse().find((line) => line.includes("RTCP monitor video packets="));
  const negotiatedAt = negotiatedLine ? timestampOf(negotiatedLine) : undefined;
  const exitAt = exitLine ? timestampOf(exitLine) : undefined;
  const rtcpVideoPackets = Number(rtcpLine?.match(/video packets=(\d+)/)?.[1]);
  const negotiated = negotiatedLine ? parseNegotiated(negotiatedLine) : undefined;

  return {
    ok: Boolean(negotiatedLine),
    camera,
    errLog,
    startedAt: new Date(startedAtMs).toISOString(),
    observedAt: new Date(observedAtMs).toISOString(),
    negotiatedAt: negotiatedAt ? new Date(negotiatedAt).toISOString() : undefined,
    exitedAt: exitAt ? new Date(exitAt).toISOString() : undefined,
    sessionDurationMs: negotiatedAt && exitAt ? exitAt - negotiatedAt : undefined,
    controllerSelectedAudio: Boolean(negotiatedLine?.includes("audio:")),
    argusAudioDisabled: Boolean(negotiatedLine?.includes("audio: disabled")),
    ffmpegAudioLeg: Boolean(ffmpegLine?.includes(" -c:a ")),
    aacEld: Boolean(negotiatedLine?.includes("AAC-eld") || ffmpegLine?.includes("aac_eld")),
    exited: Boolean(exitLine),
    spawnError: Boolean(spawnErrorLine),
    rtcpVideoPackets: Number.isFinite(rtcpVideoPackets) ? rtcpVideoPackets : undefined,
    negotiated,
    exitLine,
    spawnErrorLine,
    lines: lines.map((line) => ({ kind: liveEventKind(line), line })),
  };
}

function isCameraLiveLine(line) {
  return line.includes(`[argus ${camera}] HomeKit negotiated`)
    || line.includes(`[argus ${camera}] HomeKit reconfigure`)
    || line.includes(`[argus ${camera}] RTCP monitor`)
    || line.includes(`[argus ${camera}] ffmpeg `)
    || line.includes(`[argus ${camera}] ffmpeg exited`)
    || line.includes(`[argus ${camera}] ffmpeg spawn error`);
}

async function main() {
  if (!existsSync(errLog)) {
    throw new Error(`log file does not exist: ${errLog}`);
  }

  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 180000);
  let offset = startAtBeginning ? 0 : statSync(errLog).size;
  let activeLines = [];
  let sawNegotiated = false;

  while (Date.now() < deadlineMs) {
    const text = readFileSync(errLog, "utf8");
    if (text.length < offset) offset = 0;
    const chunk = text.slice(offset);
    offset = text.length;

    for (const line of chunk.split("\n").filter(Boolean)) {
      if (!isCameraLiveLine(line)) continue;

      if (line.includes("HomeKit negotiated")) {
        const negotiated = parseNegotiated(line);
        if (negotiated.controller && ignoreControllers.has(negotiated.controller)) {
          activeLines = [];
          sawNegotiated = false;
          continue;
        }
        activeLines = [line];
        sawNegotiated = true;
        continue;
      }

      if (!sawNegotiated) continue;
      activeLines.push(line);
      if (line.includes("ffmpeg exited") || line.includes("ffmpeg spawn error")) {
        emit(summarize(activeLines, startedAtMs, Date.now()));
        return;
      }
    }

    await sleep(Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 250);
  }

  emit({
    ok: false,
    camera,
    errLog,
    startedAt: new Date(startedAtMs).toISOString(),
    timedOutAt: new Date().toISOString(),
    timeoutSeconds,
    ignoredControllers: [...ignoreControllers],
    error: sawNegotiated
      ? "Timed out waiting for the active live session to exit."
      : "Timed out waiting for a matching HomeKit live negotiation.",
    partialLines: activeLines,
  });
  process.exitCode = 1;
}

main().catch((error) => {
  emit({
    ok: false,
    camera,
    errLog,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
