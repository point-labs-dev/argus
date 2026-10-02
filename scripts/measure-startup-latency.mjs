#!/usr/bin/env node
/**
 * Measure HomeKit live stream startup latency from telemetry logs.
 *
 * Analyzes ARGUS_TELEMETRY events to calculate:
 * - live_session_start → live_session_first_frame (total startup latency)
 * - Breakdown by camera and session
 * - Statistics: min/max/p50/p95/p99
 *
 * Usage:
 *   node scripts/measure-startup-latency.mjs /path/to/argus.log
 *   tail -1000 /tmp/argus.log | node scripts/measure-startup-latency.mjs
 */

import { readFileSync } from "node:fs";
import { parseTelemetryLog, measureLatency } from "../dist/telemetry.js";

const input = process.argv[2];
const logContents = input && input !== "-"
  ? readFileSync(input, "utf-8")
  : (() => {
      const chunks = [];
      const stdin = process.stdin;
      stdin.setEncoding("utf-8");
      let data;
      while ((data = stdin.read()) !== null) chunks.push(data);
      return chunks.join("");
    })();

const events = parseTelemetryLog(logContents);
console.log(`Parsed ${events.length} telemetry events`);

// Group by camera
const cameras = [...new Set(events.map((e) => e.camera))];
if (cameras.length === 0) {
  console.log("No telemetry events found in log");
  process.exit(0);
}

console.log(`\nCameras: ${cameras.join(", ")}\n`);

// Find all start → first_frame pairs
const sessions = [];
for (const camera of cameras) {
  const cameraEvents = events.filter((e) => e.camera === camera);
  let i = 0;
  while (i < cameraEvents.length) {
    const start = cameraEvents[i];
    if (start?.event === "live_session_start") {
      const sessionId = start.metadata?.sessionId;
      // Find next first_frame for this session
      const firstFrame = cameraEvents
        .slice(i + 1)
        .find((e) => e.event === "live_session_first_frame" && e.metadata?.sessionId === sessionId);
      
      if (firstFrame) {
        const latencyMs = firstFrame.timestamp - start.timestamp;
        sessions.push({
          camera,
          sessionId,
          startTime: new Date(start.timestamp).toISOString(),
          latencyMs,
        });
      }
    }
    i++;
  }
}

if (sessions.length === 0) {
  console.log("No complete live_session_start → live_session_first_frame pairs found");
  process.exit(0);
}

// Statistics
sessions.sort((a, b) => a.latencyMs - b.latencyMs);
const latencies = sessions.map((s) => s.latencyMs);
const sum = latencies.reduce((a, b) => a + b, 0);
const mean = sum / latencies.length;
const min = latencies[0];
const max = latencies[latencies.length - 1];
const p50 = latencies[Math.floor(latencies.length * 0.5)];
const p95 = latencies[Math.floor(latencies.length * 0.95)];
const p99 = latencies[Math.floor(latencies.length * 0.99)];

console.log("=== Startup Latency (live_session_start → live_session_first_frame) ===");
console.log(`Sessions: ${sessions.length}`);
console.log(`Mean: ${mean.toFixed(0)} ms`);
console.log(`Min: ${min} ms`);
console.log(`p50: ${p50} ms`);
console.log(`p95: ${p95} ms`);
console.log(`p99: ${p99} ms`);
console.log(`Max: ${max} ms`);

// Grade against targets
console.log(`\nTarget grades:`);
console.log(`  ≤1000ms (great): ${latencies.filter((l) => l <= 1000).length}/${latencies.length} (${(latencies.filter((l) => l <= 1000).length / latencies.length * 100).toFixed(1)}%)`);
console.log(`  ≤2000ms (good):  ${latencies.filter((l) => l <= 2000).length}/${latencies.length} (${(latencies.filter((l) => l <= 2000).length / latencies.length * 100).toFixed(1)}%)`);
console.log(`  ≤2500ms (floor): ${latencies.filter((l) => l <= 2500).length}/${latencies.length} (${(latencies.filter((l) => l <= 2500).length / latencies.length * 100).toFixed(1)}%)`);
console.log(`  >2500ms (fail):  ${latencies.filter((l) => l > 2500).length}/${latencies.length} (${(latencies.filter((l) => l > 2500).length / latencies.length * 100).toFixed(1)}%)`);

// Per-camera breakdown
console.log(`\n=== Per-Camera Breakdown ===`);
for (const camera of cameras) {
  const cameraSessions = sessions.filter((s) => s.camera === camera);
  if (cameraSessions.length === 0) continue;
  
  const cameraLatencies = cameraSessions.map((s) => s.latencyMs);
  const cameraSum = cameraLatencies.reduce((a, b) => a + b, 0);
  const cameraMean = cameraSum / cameraLatencies.length;
  const cameraMin = Math.min(...cameraLatencies);
  const cameraMax = Math.max(...cameraLatencies);
  
  console.log(`\n${camera}:`);
  console.log(`  Sessions: ${cameraSessions.length}`);
  console.log(`  Mean: ${cameraMean.toFixed(0)} ms`);
  console.log(`  Min: ${cameraMin} ms`);
  console.log(`  Max: ${cameraMax} ms`);
}

// Recent sessions detail
console.log(`\n=== Recent Sessions (last 10) ===`);
const recent = sessions.slice(-10);
for (const s of recent) {
  const grade =
    s.latencyMs <= 1000 ? "✅ GREAT" :
    s.latencyMs <= 2000 ? "✓  GOOD" :
    s.latencyMs <= 2500 ? "~  FLOOR" :
    "❌ FAIL";
  console.log(`${s.camera.padEnd(20)} ${s.latencyMs.toString().padStart(5)}ms  ${grade}  ${s.startTime}`);
}
