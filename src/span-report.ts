import { SPAN_EVENTS, type SpanEventName } from "./telemetry.js";

const SPANS = [
  { id: "motion_source_to_characteristic_set", from: "motion_source", to: "motion_characteristic_set" },
  { id: "live_prepare_stream_to_start_stream", from: "live_prepare_stream", to: "live_start_stream" },
  { id: "live_start_stream_to_ffmpeg_spawn", from: "live_start_stream", to: "live_ffmpeg_spawn" },
  { id: "live_ffmpeg_spawn_to_first_frame", from: "live_ffmpeg_spawn", to: "live_first_frame" },
  { id: "live_first_frame_to_start_ack", from: "live_first_frame", to: "live_start_ack" },
  { id: "hksv_start_to_first_fragment", from: "hksv_span_start", to: "hksv_span_first_fragment" },
  { id: "hksv_first_fragment_to_close", from: "hksv_span_first_fragment", to: "hksv_span_close" },
] as const;

interface SpanMark {
  event: SpanEventName;
  camera: string;
  monoMs: number;
  motionId?: string;
  sessionId?: string;
  streamId?: number;
  durationMs?: number;
}

const SPAN_EVENT_SET = new Set<string>(SPAN_EVENTS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseMark(value: unknown): SpanMark | undefined {
  if (!isRecord(value)) return undefined;
  const event = value["event"];
  const camera = value["camera"];
  const monoMs = finiteNumber(value["monoMs"]);
  if (typeof event !== "string" || !SPAN_EVENT_SET.has(event) || typeof camera !== "string" || monoMs === undefined) {
    return undefined;
  }
  const mark: SpanMark = { event: event as SpanEventName, camera, monoMs };
  if (typeof value["motionId"] === "string") mark.motionId = value["motionId"];
  if (typeof value["sessionId"] === "string") mark.sessionId = value["sessionId"];
  const streamId = finiteNumber(value["streamId"]);
  if (streamId !== undefined) mark.streamId = streamId;
  const metadata = value["metadata"];
  if (isRecord(metadata)) {
    const durationMs = finiteNumber(metadata["durationMs"]);
    if (durationMs !== undefined) mark.durationMs = durationMs;
  }
  return mark;
}

function parseSpanLog(logContents: string): SpanMark[] {
  const marks: SpanMark[] = [];
  for (const line of logContents.split("\n")) {
    const match = line.match(/ARGUS_TELEMETRY: (.+)$/);
    const json = match?.[1];
    if (!json) continue;
    try {
      const parsed: unknown = JSON.parse(json);
      const mark = parseMark(parsed);
      if (mark) marks.push(mark);
    } catch {
      continue;
    }
  }
  return marks;
}

function epochs(marks: readonly SpanMark[]): SpanMark[][] {
  const groups: SpanMark[][] = [];
  let current: SpanMark[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const mark of marks) {
    if (current.length > 0 && mark.monoMs < last) {
      groups.push(current);
      current = [];
    }
    current.push(mark);
    last = mark.monoMs;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function pairKey(mark: SpanMark): string {
  if (mark.motionId !== undefined) return `${mark.camera}\0${mark.motionId}`;
  if (mark.sessionId !== undefined) return `${mark.camera}\0${mark.sessionId}`;
  if (mark.streamId !== undefined) return `${mark.camera}\0${mark.streamId}`;
  return mark.camera;
}

function samplesFor(marks: readonly SpanMark[], from: SpanEventName, to: SpanEventName): number[] {
  const deltas: number[] = [];
  for (const group of epochs(marks)) {
    const used = new Set<number>();
    for (let i = 0; i < group.length; i += 1) {
      const start = group[i];
      if (!start || start.event !== from) continue;
      const startKey = pairKey(start);
      for (let j = i + 1; j < group.length; j += 1) {
        if (used.has(j)) continue;
        const end = group[j];
        if (!end || end.event !== to || pairKey(end) !== startKey) continue;
        const delta = end.monoMs - start.monoMs;
        if (delta < 0) continue;
        used.add(j);
        deltas.push(delta);
        break;
      }
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

export function formatSpanReport(logContents: string): string {
  const marks = parseSpanLog(logContents);
  const lines = SPANS.map((span) => lineFor(span.id, samplesFor(marks, span.from, span.to)));
  const durations = marks
    .filter((mark) => mark.event === "hksv_span_fragment" && mark.durationMs !== undefined && mark.durationMs >= 0)
    .map((mark) => mark.durationMs ?? 0);
  lines.push(lineFor("hksv_fragment_duration", durations));
  return `${lines.join("\n")}\n`;
}
