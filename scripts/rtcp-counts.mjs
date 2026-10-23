#!/usr/bin/env node
import { readFileSync } from "node:fs";

const MARKER = "ARGUS_TELEMETRY:";

function integer(value) {
  return Number.isInteger(value) ? value : 0;
}

function metadataOf(event) {
  return event.metadata !== null && typeof event.metadata === "object" ? event.metadata : {};
}

function sessionId(metadata) {
  return typeof metadata.sessionId === "string" ? metadata.sessionId : "";
}

function summarize(text) {
  let events = 0;
  let startEvents = 0;
  let reconfigureEvents = 0;
  let videoPackets = 0;
  let audioPackets = 0;
  let zeroEvents = 0;
  const open = new Map();
  for (const line of text.split("\n")) {
    const index = line.indexOf(MARKER);
    if (index < 0) continue;
    let event;
    try {
      event = JSON.parse(line.slice(index + MARKER.length));
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") continue;
    const metadata = metadataOf(event);
    const id = sessionId(metadata);
    if (event.event === "live_session_first_frame") {
      open.set(id, (open.get(id) ?? 0) + 1);
      continue;
    }
    if (event.event !== "rtcp_after_first_frame") continue;
    const current = open.get(id) ?? 0;
    if (current > 0) open.set(id, current - 1);
    const video = integer(metadata.videoPackets);
    const audio = integer(metadata.audioPackets);
    events += 1;
    videoPackets += video;
    audioPackets += audio;
    if (metadata.spawn === "start") startEvents += 1;
    else if (metadata.spawn === "reconfigure") reconfigureEvents += 1;
    if (video === 0 && audio === 0) zeroEvents += 1;
  }
  let leaked = 0;
  for (const count of open.values()) {
    if (count > 0) leaked += count;
  }
  return {
    leaked,
    report: [
      `events=${events}`,
      `start_events=${startEvents}`,
      `reconfigure_events=${reconfigureEvents}`,
      `video_packets=${videoPackets}`,
      `audio_packets=${audioPackets}`,
      `zero_events=${zeroEvents}`,
      `leaked_sessions=${leaked}`,
    ].join("\n") + "\n",
  };
}

const path = process.argv[2];
if (!path) {
  process.stdout.write("log=missing\n");
  process.exit(1);
}

let text;
try {
  text = readFileSync(path, "utf8");
} catch (error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  process.stdout.write(code === "ENOENT" ? "log=missing\n" : "log=unreadable\n");
  process.exit(1);
}

const { report, leaked } = summarize(text);
process.stdout.write(report);
if (leaked > 0) process.exitCode = 2;
