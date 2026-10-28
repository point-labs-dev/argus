#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const MOTION_STAGES = ["motion_detected", "motion_characteristic_set"];
const STREAM_STAGES = ["recording_start", "recording_ffmpeg_spawn", "recording_first_fragment"];
const SESSION_STAGES = [
  "prepare_stream_enter",
  "prepare_stream_answered",
  "live_session_start",
  "live_ffmpeg_spawn",
  "live_first_frame",
];

const STAGE_SPANS = [
  { id: "motion_to_motion_set", from: "motion_detected", to: "motion_characteristic_set", pair: "camera" },
  { id: "recording_start_to_first_fragment", from: "recording_start", to: "recording_first_fragment", pair: "stream" },
  { id: "prepare_stream_to_live_session_start", from: "prepare_stream_enter", to: "live_session_start", pair: "session" },
  { id: "live_session_start_to_first_frame", from: "live_session_start", to: "live_first_frame", pair: "session" },
  { id: "prepare_stream_to_answered", from: "prepare_stream_enter", to: "prepare_stream_answered", pair: "session" },
  { id: "live_session_start_to_ffmpeg_spawn", from: "live_session_start", to: "live_ffmpeg_spawn", pair: "session" },
  { id: "live_ffmpeg_spawn_to_first_frame", from: "live_ffmpeg_spawn", to: "live_first_frame", pair: "session" },
  { id: "recording_start_to_ffmpeg_spawn", from: "recording_start", to: "recording_ffmpeg_spawn", pair: "stream" },
  { id: "recording_ffmpeg_spawn_to_first_fragment", from: "recording_ffmpeg_spawn", to: "recording_first_fragment", pair: "stream" },
];

const MOTION_STAGE_SET = new Set(MOTION_STAGES);
const STREAM_STAGE_SET = new Set(STREAM_STAGES);
const SESSION_STAGE_SET = new Set(SESSION_STAGES);

const TELEMETRY_STAGE = {
  motion_detected: "motion_detected",
  homekit_motion_updated: "motion_characteristic_set",
  hksv_recording_start: "recording_start",
  hksv_first_fragment: "recording_first_fragment",
  live_session_start: "live_session_start",
  live_session_first_frame: "live_first_frame",
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pairFor(stage) {
  if (MOTION_STAGE_SET.has(stage)) return "camera";
  if (STREAM_STAGE_SET.has(stage)) return "stream";
  if (SESSION_STAGE_SET.has(stage)) return "session";
  return undefined;
}

function parseTimingMark(value) {
  if (!isRecord(value)) return undefined;
  const stage = value.stage;
  const camera = value.camera;
  const at = finiteNumber(value.monoMs);
  if (typeof stage !== "string" || typeof camera !== "string" || at === undefined) return undefined;
  const pair = pairFor(stage);
  if (pair === "camera") return { stage, camera, at, pair };
  if (pair === "stream") {
    const streamId = finiteNumber(value.streamId);
    if (streamId === undefined) return undefined;
    return { stage, camera, at, pair, streamId };
  }
  if (pair === "session") {
    const sessionId = value.sessionId;
    if (typeof sessionId !== "string") return undefined;
    return { stage, camera, at, pair, sessionId };
  }
  return undefined;
}

function parseTelemetryMark(value) {
  if (!isRecord(value)) return undefined;
  const event = value.event;
  const camera = value.camera;
  const at = finiteNumber(value.timestamp);
  if (typeof event !== "string" || typeof camera !== "string" || at === undefined) return undefined;
  const stage = TELEMETRY_STAGE[event];
  if (stage === undefined) return undefined;
  if (event === "homekit_motion_updated") {
    if (!isRecord(value.metadata) || value.metadata.detected !== true) return undefined;
  }
  const pair = pairFor(stage);
  if (pair === "camera") return { stage, camera, at, pair };
  if (!isRecord(value.metadata)) return undefined;
  if (pair === "stream") {
    const streamId = finiteNumber(value.metadata.streamId);
    if (streamId === undefined) return undefined;
    return { stage, camera, at, pair, streamId };
  }
  if (pair === "session") {
    const sessionId = value.metadata.sessionId;
    if (typeof sessionId !== "string") return undefined;
    return { stage, camera, at, pair, sessionId };
  }
  return undefined;
}

const TIMING_LINE = /ARGUS_TIMING: (.+)$/;
const TELEMETRY_LINE = /ARGUS_TELEMETRY: (.+)$/;

function parsePrefixed(logContents, linePattern, parseMark) {
  const marks = [];
  for (const line of logContents.split("\n")) {
    const json = line.match(linePattern)?.[1];
    if (!json) continue;
    try {
      const mark = parseMark(JSON.parse(json));
      if (mark) marks.push(mark);
    } catch {
      continue;
    }
  }
  return marks;
}

function epochs(marks) {
  const groups = [];
  let current = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const mark of marks) {
    if (current.length > 0 && mark.at < last) {
      groups.push(current);
      current = [];
    }
    current.push(mark);
    last = mark.at;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function pairKey(mark) {
  if (mark.pair === "stream") return `${mark.camera}\0${mark.streamId}`;
  if (mark.pair === "session") return `${mark.camera}\0${mark.sessionId}`;
  return mark.camera;
}

function samplesFor(marks, from, to, pair) {
  const deltas = [];
  for (const group of epochs(marks)) {
    const used = new Set();
    for (let i = 0; i < group.length; i += 1) {
      const start = group[i];
      if (!start || start.stage !== from || start.pair !== pair) continue;
      const startKey = pairKey(start);
      for (let j = i + 1; j < group.length; j += 1) {
        if (used.has(j)) continue;
        const end = group[j];
        if (!end || end.stage !== to || end.pair !== pair || pairKey(end) !== startKey) continue;
        const delta = end.at - start.at;
        if (delta < 0) continue;
        used.add(j);
        deltas.push(delta);
        break;
      }
    }
  }
  return deltas;
}

function percentile(sorted, p) {
  const last = sorted.length - 1;
  const rank = (p / 100) * last;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const low = sorted[lo];
  const high = sorted[hi];
  if (low === undefined || high === undefined) {
    throw new Error(`missing percentile sample at rank ${rank}`);
  }
  if (lo === hi) return low;
  const weight = rank - lo;
  return low * (1 - weight) + high * weight;
}

function fmt(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatSpan(id, samples) {
  if (samples.length === 0) return `${id} n=0`;
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (min === undefined || max === undefined) return `${id} n=0`;
  return `${id} n=${sorted.length} min=${fmt(min)} p50=${fmt(percentile(sorted, 50))} p90=${fmt(percentile(sorted, 90))} max=${fmt(max)}`;
}

function samplesFromMarks(timingMarks, telemetryMarks, span) {
  const timingSamples = samplesFor(timingMarks, span.from, span.to, span.pair);
  if (timingSamples.length > 0) return timingSamples;
  return samplesFor(telemetryMarks, span.from, span.to, span.pair);
}

export function samplesForSpan(logContents, spanId) {
  const span = STAGE_SPANS.find((item) => item.id === spanId);
  if (!span) return [];
  const timingMarks = parsePrefixed(logContents, TIMING_LINE, parseTimingMark);
  const telemetryMarks = parsePrefixed(logContents, TELEMETRY_LINE, parseTelemetryMark);
  return samplesFromMarks(timingMarks, telemetryMarks, span);
}

export function percentileOf(samples, p) {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  return percentile(sorted, p);
}

export function formatNotificationReport(logContents) {
  const timingMarks = parsePrefixed(logContents, TIMING_LINE, parseTimingMark);
  const telemetryMarks = parsePrefixed(logContents, TELEMETRY_LINE, parseTelemetryMark);
  const lines = STAGE_SPANS.map((span) => formatSpan(span.id, samplesFromMarks(timingMarks, telemetryMarks, span)));
  return `${lines.join("\n")}\n`;
}

export function resolveLatencyLog(inputPath) {
  if (basename(inputPath) !== "serve.log") return inputPath;
  const errPath = join(dirname(inputPath), "serve.err.log");
  return existsSync(errPath) ? errPath : inputPath;
}

const invoked = process.argv[1] && process.argv[1].endsWith("notification-latency.mjs");
if (invoked) {
  const input = process.argv[2];
  const logContents = !input || input === "-"
    ? readFileSync(0, "utf8")
    : readFileSync(resolveLatencyLog(input), "utf8");
  process.stdout.write(formatNotificationReport(logContents));
}
