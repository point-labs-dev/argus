#!/usr/bin/env node
import { readFileSync } from "node:fs";

const MARKER = "ARGUS_TELEMETRY:";

function integer(value) {
  return Number.isInteger(value) ? value : 0;
}

function summarize(text) {
  let events = 0;
  let startEvents = 0;
  let reconfigureEvents = 0;
  let videoPackets = 0;
  let audioPackets = 0;
  let zeroEvents = 0;
  for (const line of text.split("\n")) {
    const index = line.indexOf(MARKER);
    if (index < 0) continue;
    let event;
    try {
      event = JSON.parse(line.slice(index + MARKER.length));
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object" || event.event !== "rtcp_after_first_frame") continue;
    const metadata = event.metadata !== null && typeof event.metadata === "object" ? event.metadata : {};
    const video = integer(metadata.videoPackets);
    const audio = integer(metadata.audioPackets);
    events += 1;
    videoPackets += video;
    audioPackets += audio;
    if (metadata.spawn === "start") startEvents += 1;
    else if (metadata.spawn === "reconfigure") reconfigureEvents += 1;
    if (video === 0 && audio === 0) zeroEvents += 1;
  }
  return [
    `events=${events}`,
    `start_events=${startEvents}`,
    `reconfigure_events=${reconfigureEvents}`,
    `video_packets=${videoPackets}`,
    `audio_packets=${audioPackets}`,
    `zero_events=${zeroEvents}`,
  ].join("\n") + "\n";
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

process.stdout.write(summarize(text));
