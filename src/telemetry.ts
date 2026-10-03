/**
 * Structured telemetry for Argus alert→action latency instrumentation.
 *
 * Machine-readable JSON logs for measuring the path: Reolink motion detection →
 * HomeKit notification → live session start. Each event is timestamped (epoch ms)
 * and tagged by camera. The events are written to stderr in JSON Lines format
 * (one object per line) so they can be collected/analyzed independently of the
 * rest of the server's human-readable output.
 */

export type TelemetryEventType =
  | "motion_detected"
  | "motion_cleared"
  | "homekit_motion_updated"
  | "go2rtc_stream_warmed"
  | "live_session_start"
  | "live_session_stop"
  | "live_session_first_frame"
  | "hksv_recording_start"
  | "hksv_first_fragment"
  | "hksv_recording_stop";

export interface TelemetryEvent {
  timestamp: number;
  camera: string;
  event: TelemetryEventType;
  /** Additional event-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Emit a structured telemetry event. Written to stderr as JSON Lines so it can
 * be filtered/parsed independently of the human-readable stdout logs.
 * 
 * Boundary discipline: telemetry must never throw into critical paths (motion
 * detection, stream start, HKSV recording). All failures are silently swallowed.
 */
export function emitTelemetry(camera: string, event: TelemetryEventType, metadata?: Record<string, unknown>): void {
  try {
    const entry: TelemetryEvent = {
      timestamp: Date.now(),
      camera,
      event,
      ...(metadata ? { metadata } : {}),
    };
    process.stderr.write(`ARGUS_TELEMETRY: ${JSON.stringify(entry)}\n`);
  } catch {
    // Telemetry failures must never break the hot path
  }
}

/**
 * Parse Argus telemetry events from a log file. Filters for lines starting with
 * "ARGUS_TELEMETRY:" and parses each as JSON. Returns parsed events, ignoring
 * any malformed lines.
 */
export function parseTelemetryLog(logContents: string): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  const lines = logContents.split("\n");
  
  for (const line of lines) {
    const match = line.match(/ARGUS_TELEMETRY: (.+)$/);
    if (match?.[1]) {
      try {
        const event = JSON.parse(match[1]) as TelemetryEvent;
        events.push(event);
      } catch {
        // Ignore malformed JSON
      }
    }
  }
  
  return events;
}

/**
 * Analyze latency between events for a camera. Returns the time delta (ms) between
 * the first occurrence of `fromEvent` and the first occurrence of `toEvent` after it.
 * Returns undefined if either event is missing or they are out of order.
 */
export function measureLatency(
  events: TelemetryEvent[],
  camera: string,
  fromEvent: TelemetryEventType,
  toEvent: TelemetryEventType,
): number | undefined {
  const cameraEvents = events.filter((e) => e.camera === camera);
  const fromIdx = cameraEvents.findIndex((e) => e.event === fromEvent);
  if (fromIdx === -1) return undefined;
  
  const fromTimestamp = cameraEvents[fromIdx]!.timestamp;
  const toIdx = cameraEvents.slice(fromIdx + 1).findIndex((e) => e.event === toEvent);
  if (toIdx === -1) return undefined;
  
  const toTimestamp = cameraEvents[fromIdx + 1 + toIdx]!.timestamp;
  return toTimestamp - fromTimestamp;
}
