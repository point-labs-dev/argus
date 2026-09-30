import { describe, it, expect } from "vitest";
import {
  emitTelemetry,
  parseTelemetryLog,
  measureLatency,
  type TelemetryEvent,
} from "../src/telemetry.js";

describe("telemetry", () => {
  describe("emitTelemetry", () => {
    it("writes JSON to stderr", () => {
      const writes: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        writes.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        emitTelemetry("Front Door", "motion_detected");
        expect(writes).toHaveLength(1);
        const line = writes[0]!;
        expect(line).toMatch(/^ARGUS_TELEMETRY: /);
        const json = line.replace(/^ARGUS_TELEMETRY: /, "").trim();
        const event = JSON.parse(json) as TelemetryEvent;
        expect(event.camera).toBe("Front Door");
        expect(event.event).toBe("motion_detected");
        expect(event.timestamp).toBeGreaterThan(0);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("includes metadata when provided", () => {
      const writes: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        writes.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        emitTelemetry("Front Door", "live_session_start", {
          sessionId: "abc123",
          width: 1920,
          height: 1080,
        });
        const line = writes[0]!;
        const json = line.replace(/^ARGUS_TELEMETRY: /, "").trim();
        const event = JSON.parse(json) as TelemetryEvent;
        expect(event.metadata).toEqual({
          sessionId: "abc123",
          width: 1920,
          height: 1080,
        });
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  describe("parseTelemetryLog", () => {
    it("extracts events from mixed log output", () => {
      const log = `
[argus Front Door] motion detected
ARGUS_TELEMETRY: {"timestamp":1000,"camera":"Front Door","event":"motion_detected"}
[argus Front Door] some other message
ARGUS_TELEMETRY: {"timestamp":1050,"camera":"Front Door","event":"homekit_motion_updated","metadata":{"detected":true}}
[argus] more output
ARGUS_TELEMETRY: {"timestamp":1100,"camera":"Back Yard","event":"motion_detected"}
      `.trim();

      const events = parseTelemetryLog(log);
      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({
        timestamp: 1000,
        camera: "Front Door",
        event: "motion_detected",
      });
      expect(events[1]).toEqual({
        timestamp: 1050,
        camera: "Front Door",
        event: "homekit_motion_updated",
        metadata: { detected: true },
      });
      expect(events[2]).toEqual({
        timestamp: 1100,
        camera: "Back Yard",
        event: "motion_detected",
      });
    });

    it("ignores malformed JSON", () => {
      const log = `
ARGUS_TELEMETRY: {"timestamp":1000,"camera":"Front Door","event":"motion_detected"}
ARGUS_TELEMETRY: this is not json
ARGUS_TELEMETRY: {"timestamp":1100,"camera":"Back Yard","event":"motion_detected"}
      `.trim();

      const events = parseTelemetryLog(log);
      expect(events).toHaveLength(2);
      expect(events[0]!.timestamp).toBe(1000);
      expect(events[1]!.timestamp).toBe(1100);
    });

    it("returns empty array for logs with no telemetry", () => {
      const log = "[argus] normal log output\n[argus] more output";
      expect(parseTelemetryLog(log)).toEqual([]);
    });
  });

  describe("measureLatency", () => {
    it("calculates time delta between events", () => {
      const events: TelemetryEvent[] = [
        { timestamp: 1000, camera: "Front Door", event: "motion_detected" },
        { timestamp: 1050, camera: "Front Door", event: "homekit_motion_updated" },
        { timestamp: 1200, camera: "Front Door", event: "live_session_start" },
      ];

      const latency = measureLatency(
        events,
        "Front Door",
        "motion_detected",
        "homekit_motion_updated"
      );
      expect(latency).toBe(50);
    });

    it("finds first occurrence of each event", () => {
      const events: TelemetryEvent[] = [
        { timestamp: 1000, camera: "Front Door", event: "motion_detected" },
        { timestamp: 1050, camera: "Front Door", event: "homekit_motion_updated" },
        { timestamp: 1100, camera: "Front Door", event: "motion_detected" },
        { timestamp: 1150, camera: "Front Door", event: "homekit_motion_updated" },
      ];

      const latency = measureLatency(
        events,
        "Front Door",
        "motion_detected",
        "homekit_motion_updated"
      );
      expect(latency).toBe(50); // First pair
    });

    it("filters by camera name", () => {
      const events: TelemetryEvent[] = [
        { timestamp: 1000, camera: "Front Door", event: "motion_detected" },
        { timestamp: 1025, camera: "Back Yard", event: "motion_detected" },
        { timestamp: 1050, camera: "Front Door", event: "homekit_motion_updated" },
        { timestamp: 1075, camera: "Back Yard", event: "homekit_motion_updated" },
      ];

      expect(
        measureLatency(events, "Front Door", "motion_detected", "homekit_motion_updated")
      ).toBe(50);
      expect(
        measureLatency(events, "Back Yard", "motion_detected", "homekit_motion_updated")
      ).toBe(50);
    });

    it("returns undefined if from event not found", () => {
      const events: TelemetryEvent[] = [
        { timestamp: 1000, camera: "Front Door", event: "homekit_motion_updated" },
      ];

      expect(
        measureLatency(events, "Front Door", "motion_detected", "homekit_motion_updated")
      ).toBeUndefined();
    });

    it("returns undefined if to event not found", () => {
      const events: TelemetryEvent[] = [
        { timestamp: 1000, camera: "Front Door", event: "motion_detected" },
      ];

      expect(
        measureLatency(events, "Front Door", "motion_detected", "homekit_motion_updated")
      ).toBeUndefined();
    });

    it("returns undefined if to event occurs before from event", () => {
      const events: TelemetryEvent[] = [
        { timestamp: 1000, camera: "Front Door", event: "homekit_motion_updated" },
        { timestamp: 1050, camera: "Front Door", event: "motion_detected" },
      ];

      expect(
        measureLatency(events, "Front Door", "motion_detected", "homekit_motion_updated")
      ).toBeUndefined();
    });
  });
});
