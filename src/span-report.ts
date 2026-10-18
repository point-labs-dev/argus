import { SPAN_EVENTS, type SpanEventName } from "./telemetry.js";

const SPANS = [
  { id: "motion_source_to_characteristic_set", from: "motion_source", to: "motion_characteristic_set", pair: "camera", reset: [] },
  { id: "live_prepare_stream_to_start_stream", from: "prepare_stream_enter", to: "live_session_start", pair: "session", reset: [] },
  { id: "live_start_stream_to_ffmpeg_spawn", from: "live_session_start", to: "live_ffmpeg_spawn", pair: "session", reset: [] },
  { id: "live_ffmpeg_spawn_to_first_frame", from: "live_ffmpeg_spawn", to: "live_first_frame", pair: "session", reset: [] },
  { id: "live_first_frame_to_start_ack", from: "live_first_frame", to: "live_start_ack", pair: "session", reset: [] },
  { id: "hksv_start_to_first_fragment", from: "recording_start", to: "recording_first_fragment", pair: "stream", reset: [] },
  { id: "hksv_first_fragment_to_close", from: "recording_first_fragment", to: "hksv_span_close", pair: "stream", reset: ["recording_start"] },
] as const;

type Pair = "camera" | "session" | "stream";

interface SpanMark {
  kind: string;
  camera: string;
  monoMs: number;
  sessionId?: string;
  streamId?: number;
  recId?: string;
  durationMs?: number;
  initial: boolean;
}

const SPAN_EVENT_SET = new Set<string>(SPAN_EVENTS);
const TIMING_STAGES = new Set<string>([
  "motion_characteristic_set",
  "prepare_stream_enter",
  "live_session_start",
  "live_ffmpeg_spawn",
  "live_first_frame",
  "recording_start",
  "recording_first_fragment",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseTelemetryMark(value: unknown): SpanMark | undefined {
  if (!isRecord(value)) return undefined;
  const event = value["event"];
  const camera = value["camera"];
  const monoMs = finiteNumber(value["monoMs"]);
  if (typeof event !== "string" || !SPAN_EVENT_SET.has(event) || typeof camera !== "string" || monoMs === undefined) {
    return undefined;
  }
  const mark: SpanMark = { kind: event as SpanEventName, camera, monoMs, initial: false };
  if (typeof value["sessionId"] === "string") mark.sessionId = value["sessionId"];
  const streamId = finiteNumber(value["streamId"]);
  if (streamId !== undefined) mark.streamId = streamId;
  if (typeof value["recId"] === "string") mark.recId = value["recId"];
  const metadata = value["metadata"];
  if (isRecord(metadata)) {
    const durationMs = finiteNumber(metadata["durationMs"]);
    if (durationMs !== undefined) mark.durationMs = durationMs;
    if (metadata["initial"] === 1) mark.initial = true;
  }
  return mark;
}

function parseTimingMark(value: unknown): SpanMark | undefined {
  if (!isRecord(value)) return undefined;
  const stage = value["stage"];
  const camera = value["camera"];
  const monoMs = finiteNumber(value["monoMs"]);
  if (typeof stage !== "string" || !TIMING_STAGES.has(stage) || typeof camera !== "string" || monoMs === undefined) {
    return undefined;
  }
  const mark: SpanMark = { kind: stage, camera, monoMs, initial: false };
  if (typeof value["sessionId"] === "string") mark.sessionId = value["sessionId"];
  const streamId = finiteNumber(value["streamId"]);
  if (streamId !== undefined) mark.streamId = streamId;
  return mark;
}

function parseSpanLog(logContents: string): SpanMark[] {
  const marks: SpanMark[] = [];
  for (const line of logContents.split("\n")) {
    const telemetry = line.match(/ARGUS_TELEMETRY: (.+)$/)?.[1];
    const timing = line.match(/ARGUS_TIMING: (.+)$/)?.[1];
    const json = telemetry ?? timing;
    if (!json) continue;
    try {
      const parsed: unknown = JSON.parse(json);
      const mark = telemetry ? parseTelemetryMark(parsed) : parseTimingMark(parsed);
      if (mark) marks.push(mark);
    } catch {
      continue;
    }
  }
  return marks;
}

function pairKey(mark: SpanMark, pair: Pair): string | undefined {
  if (pair === "session") {
    if (mark.sessionId === undefined) return undefined;
    return `${mark.camera}\0${mark.sessionId}`;
  }
  if (pair === "stream") {
    if (mark.streamId === undefined) return undefined;
    return `${mark.camera}\0${mark.streamId}`;
  }
  return mark.camera;
}

function linearSamples(
  marks: readonly SpanMark[],
  from: string,
  to: string,
  pair: Pair,
  reset: readonly string[],
): number[] {
  const open = new Map<string, number>();
  const deltas: number[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const mark of marks) {
    if (mark.monoMs < last) open.clear();
    last = mark.monoMs;
    const relevant = mark.kind === from || mark.kind === to || reset.includes(mark.kind);
    if (!relevant) continue;
    const key = pairKey(mark, pair);
    if (key === undefined) continue;
    if (reset.includes(mark.kind)) open.delete(key);
    if (mark.kind === from) {
      open.set(key, mark.monoMs);
    } else if (mark.kind === to) {
      const start = open.get(key);
      if (start === undefined || mark.monoMs < start) continue;
      deltas.push(mark.monoMs - start);
      open.delete(key);
    }
  }
  return deltas;
}

function percentile(sorted: readonly number[], p: number): number {
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

function fmt(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function lineFor(id: string, samples: readonly number[]): string {
  if (samples.length === 0) return `${id} n=0`;
  const sorted = [...samples].sort((a, b) => a - b);
  return `${id} n=${sorted.length} p50=${fmt(percentile(sorted, 50))} p95=${fmt(percentile(sorted, 95))}`;
}

function fragmentDurations(marks: readonly SpanMark[]): number[] {
  return marks
    .filter((mark) => mark.kind === "hksv_span_fragment" && mark.durationMs !== undefined && mark.durationMs >= 0 && !mark.initial)
    .map((mark) => mark.durationMs ?? 0);
}

export function formatSpanReport(logContents: string): string {
  const marks = parseSpanLog(logContents);
  const lines = SPANS.map((span) => lineFor(span.id, linearSamples(marks, span.from, span.to, span.pair, span.reset)));
  lines.push(lineFor("hksv_fragment_duration", fragmentDurations(marks)));
  return `${lines.join("\n")}\n`;
}
