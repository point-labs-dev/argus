const MOTION_STAGES = ["motion_detected", "motion_characteristic_set"] as const;
const STREAM_STAGES = ["recording_start", "recording_ffmpeg_spawn", "recording_first_fragment"] as const;
const SESSION_STAGES = [
  "prepare_stream_enter",
  "prepare_stream_answered",
  "live_session_start",
  "live_ffmpeg_spawn",
  "live_first_frame",
] as const;

type MotionStage = (typeof MOTION_STAGES)[number];
type StreamStage = (typeof STREAM_STAGES)[number];
type SessionStage = (typeof SESSION_STAGES)[number];
type TimingStage = MotionStage | StreamStage | SessionStage;

export type TimingEmit =
  | { stage: MotionStage; camera: string }
  | { stage: StreamStage; camera: string; streamId: number }
  | { stage: SessionStage; camera: string; sessionId: string };

type TimingMark =
  | { stage: MotionStage; camera: string; monoMs: number; pair: "camera" }
  | { stage: StreamStage; camera: string; monoMs: number; pair: "stream"; streamId: number }
  | { stage: SessionStage; camera: string; monoMs: number; pair: "session"; sessionId: string };

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
] as const;

const MOTION_STAGE_SET = new Set<string>(MOTION_STAGES);
const STREAM_STAGE_SET = new Set<string>(STREAM_STAGES);
const SESSION_STAGE_SET = new Set<string>(SESSION_STAGES);

function isMotionStage(stage: string): stage is MotionStage {
  return MOTION_STAGE_SET.has(stage);
}

function isStreamStage(stage: string): stage is StreamStage {
  return STREAM_STAGE_SET.has(stage);
}

function isSessionStage(stage: string): stage is SessionStage {
  return SESSION_STAGE_SET.has(stage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function emitTiming(mark: TimingEmit, now: () => number = () => performance.now()): void {
  try {
    const monoMs = Math.round(now());
    process.stderr.write(`ARGUS_TIMING: ${serialize(mark, monoMs)}\n`);
  } catch {
    return;
  }
}

function serialize(mark: TimingEmit, monoMs: number): string {
  switch (mark.stage) {
    case "recording_start":
    case "recording_ffmpeg_spawn":
    case "recording_first_fragment":
      return JSON.stringify({ stage: mark.stage, camera: mark.camera, monoMs, streamId: mark.streamId });
    case "prepare_stream_enter":
    case "prepare_stream_answered":
    case "live_session_start":
    case "live_ffmpeg_spawn":
    case "live_first_frame":
      return JSON.stringify({ stage: mark.stage, camera: mark.camera, monoMs, sessionId: mark.sessionId });
    case "motion_detected":
    case "motion_characteristic_set":
      return JSON.stringify({ stage: mark.stage, camera: mark.camera, monoMs });
    default: {
      const unreachable: never = mark;
      return unreachable;
    }
  }
}

function parseMark(value: unknown): TimingMark | undefined {
  if (!isRecord(value)) return undefined;
  const stage = value["stage"];
  const camera = value["camera"];
  const monoMs = finiteNumber(value["monoMs"]);
  if (typeof stage !== "string" || typeof camera !== "string" || monoMs === undefined) return undefined;
  if (isMotionStage(stage)) return { stage, camera, monoMs, pair: "camera" };
  if (isStreamStage(stage)) {
    const streamId = finiteNumber(value["streamId"]);
    if (streamId === undefined) return undefined;
    return { stage, camera, monoMs, pair: "stream", streamId };
  }
  if (isSessionStage(stage)) {
    const sessionId = value["sessionId"];
    if (typeof sessionId !== "string") return undefined;
    return { stage, camera, monoMs, pair: "session", sessionId };
  }
  return undefined;
}

function parseTimingLog(logContents: string): TimingMark[] {
  const marks: TimingMark[] = [];
  for (const line of logContents.split("\n")) {
    const match = line.match(/ARGUS_TIMING: (.+)$/);
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

function epochs(marks: readonly TimingMark[]): TimingMark[][] {
  const groups: TimingMark[][] = [];
  let current: TimingMark[] = [];
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

function pairKey(mark: TimingMark): string {
  if (mark.pair === "stream") return `${mark.camera}\0${mark.streamId}`;
  if (mark.pair === "session") return `${mark.camera}\0${mark.sessionId}`;
  return mark.camera;
}

function samplesFor(
  marks: readonly TimingMark[],
  from: TimingStage,
  to: TimingStage,
  pair: TimingMark["pair"],
): number[] {
  const deltas: number[] = [];
  for (const group of epochs(marks)) {
    const used = new Set<number>();
    for (let i = 0; i < group.length; i += 1) {
      const start = group[i];
      if (!start || start.stage !== from || start.pair !== pair) continue;
      const startKey = pairKey(start);
      for (let j = i + 1; j < group.length; j += 1) {
        if (used.has(j)) continue;
        const end = group[j];
        if (!end || end.stage !== to || end.pair !== pair || pairKey(end) !== startKey) continue;
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

export function formatStageReport(logContents: string): string {
  const marks = parseTimingLog(logContents);
  const lines = STAGE_SPANS.map((span) => {
    const samples = samplesFor(marks, span.from, span.to, span.pair);
    if (samples.length === 0) return `${span.id} n=0`;
    const sorted = [...samples].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    if (min === undefined || max === undefined) return `${span.id} n=0`;
    return `${span.id} n=${sorted.length} min=${fmt(min)} p50=${fmt(percentile(sorted, 50))} p90=${fmt(percentile(sorted, 90))} max=${fmt(max)}`;
  });
  return `${lines.join("\n")}\n`;
}
