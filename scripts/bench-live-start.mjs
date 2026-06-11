// Sender-side live-view benchmark: spawns the EXACT FFmpeg command serve uses
// (buildLiveFfmpegArgs from dist/) against the local go2rtc restream, targeting
// local UDP sockets, and measures time from spawn to the first/keyframe-sized
// video SRTP packet plus sustained flow. The on-device number ≈ this + HomeKit
// negotiation (~0.3s) + decode/render.
//
// Usage: node scripts/bench-live-start.mjs [stream-name] [runs]
import { createSocket } from "node:dgram";
import { spawn } from "node:child_process";

import { buildLiveFfmpegArgs } from "../dist/homekit.js";

const streamName = process.argv[2] ?? "garage-door-sub";
const runs = Number(process.argv[3] ?? 5);

async function udpSocket() {
  const socket = createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, resolve));
  return socket;
}

/** Grab a free UDP port number for FFmpeg's localrtcpport (bind+close, as serve does). */
async function reservePort() {
  const socket = await udpSocket();
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function benchOnce() {
  const video = await udpSocket();
  const audio = await udpSocket();
  const videoPort = video.address().port;
  const audioPort = audio.address().port;
  const videoRtcp = await reservePort();
  const audioRtcp = await reservePort();

  const args = buildLiveFfmpegArgs({
    inputUrl: `rtsp://127.0.0.1:8554/${streamName}`,
    targetAddress: "127.0.0.1",
    videoMode: "copy",
    video: {
      port: videoPort, localRtcpPort: videoRtcp, ssrc: 111, payloadType: 99,
      maxBitrateKbps: 299, fps: 30, width: 896, height: 512, mtu: 1378,
      profile: "high", level: "4.0",
      srtpParams: Buffer.alloc(30, 7).toString("base64"),
    },
    audio: {
      port: audioPort, localRtcpPort: audioRtcp, ssrc: 222, payloadType: 110,
      sampleRateKhz: 24, maxBitrateKbps: 24,
      srtpParams: Buffer.alloc(30, 9).toString("base64"),
    },
  });

  const t0 = process.hrtime.bigint();
  let firstVideoMs = null;
  let videoPackets = 0;
  let audioPackets = 0;
  video.on("message", () => {
    videoPackets += 1;
    if (firstVideoMs === null) firstVideoMs = Number(process.hrtime.bigint() - t0) / 1e6;
  });
  audio.on("message", () => { audioPackets += 1; });

  // Optional experiment overrides, e.g. ARGUS_BENCH_ANALYZE=0 ARGUS_BENCH_PROBESIZE=32
  if (process.env.ARGUS_BENCH_ANALYZE !== undefined) {
    args[args.indexOf("-analyzeduration") + 1] = process.env.ARGUS_BENCH_ANALYZE;
  }
  if (process.env.ARGUS_BENCH_PROBESIZE !== undefined) {
    args[args.indexOf("-probesize") + 1] = process.env.ARGUS_BENCH_PROBESIZE;
  }
  if (process.env.ARGUS_BENCH_MAXDELAY !== undefined) {
    args.splice(args.indexOf("-i"), 0, "-max_delay", process.env.ARGUS_BENCH_MAXDELAY);
  }

  const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  ffmpeg.stderr.on("data", (chunk) => { stderr += chunk; });

  // Sample for 6s: long enough to capture start + sustained flow.
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  ffmpeg.kill("SIGKILL");
  video.close();
  audio.close();

  if (firstVideoMs === null) {
    return { ok: false, detail: stderr.trim().slice(0, 300) || "no packets" };
  }
  return { ok: true, firstVideoMs, videoPackets, audioPackets };
}

console.log(`stream=${streamName} runs=${runs} (copy mode, local UDP sink)`);
const times = [];
for (let i = 0; i < runs; i++) {
  const result = await benchOnce();
  if (!result.ok) {
    console.log(`run ${i + 1}: FAILED ${result.detail}`);
    continue;
  }
  times.push(result.firstVideoMs);
  console.log(
    `run ${i + 1}: first video packet ${(result.firstVideoMs / 1000).toFixed(2)}s, ` +
      `${result.videoPackets} video + ${result.audioPackets} audio packets in 6s`,
  );
  await new Promise((resolve) => setTimeout(resolve, 700 + Math.random() * 1500));
}
if (times.length > 0) {
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`avg ${(avg / 1000).toFixed(2)}s, max ${(Math.max(...times) / 1000).toFixed(2)}s over ${times.length} runs`);
}
