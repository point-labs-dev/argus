// A/V clock-drift measurement of the live SRTP session — the iOS lip-sync
// gate's view. Spawns the EXACT production sender (video+audio), then decodes
// each leg with its own receiver and samples both decode clocks every 10s.
// If audio advances slower/faster than video (Reolink timestamp jitter, FLV
// mux skew), the drift trend shows here without any on-device tap.
//
// Usage: node scripts/validate-av-sync.mjs [stream] [--size WxH] [--bitrate K] [--seconds N]
import { createSocket } from "node:dgram";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

import { buildLiveFfmpegArgs } from "../dist/homekit.js";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const streamName = positional[0] ?? "garage-door-sub";
const [width, height] = flag("size", "1280x720").split("x").map(Number);
const bitrate = Number(flag("bitrate", 2000));
const seconds = Number(flag("seconds", 180));

async function freePort() {
  const socket = createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

const videoPort = await freePort();
const audioPort = await freePort();
const videoKey = Buffer.alloc(30, 7).toString("base64");
const audioKey = Buffer.alloc(30, 9).toString("base64");

const sendArgs = buildLiveFfmpegArgs({
  inputUrl: streamName.startsWith("rtsp://") ? streamName : `rtsp://127.0.0.1:8554/${streamName}`,
  targetAddress: "127.0.0.1",
  videoMode: "transcode",
  video: {
    port: videoPort, localRtcpPort: await freePort(), ssrc: 111, payloadType: 99,
    maxBitrateKbps: bitrate, fps: 30, width, height, mtu: 1378,
    profile: "high", level: "4.0", srtpParams: videoKey,
  },
  audio: {
    port: audioPort, localRtcpPort: await freePort(), ssrc: 222, payloadType: 110,
    sampleRateKhz: 24, maxBitrateKbps: 24, srtpParams: audioKey,
  },
});

function sdpFor(kind, port, pt, codecLine, key) {
  return `v=0
o=- 0 0 IN IP4 127.0.0.1
s=argus-${kind}
c=IN IP4 127.0.0.1
t=0 0
m=${kind} ${port} RTP/SAVP ${pt}
a=rtpmap:${pt} ${codecLine}
a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${key}
`;
}
writeFileSync("/tmp/argus-v.sdp", sdpFor("video", videoPort, 99, "H264/90000", videoKey));
// Opus over RTP is declared 48000/2 per RFC 7587 regardless of encode rate.
writeFileSync("/tmp/argus-a.sdp", sdpFor("audio", audioPort, 110, "opus/48000/2", audioKey));

function receiver(sdp) {
  const proc = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning",
    "-protocol_whitelist", "file,udp,rtp,srtp,crypto",
    "-i", sdp,
    "-progress", "pipe:1", "-nostats",
    "-f", "null", "-",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const state = { outTimeUs: 0, err: "" };
  proc.stdout.on("data", (c) => {
    for (const m of String(c).matchAll(/out_time_us=(\d+)/g)) state.outTimeUs = Number(m[1]);
  });
  proc.stderr.on("data", (c) => { state.err += c; });
  return { proc, state };
}

const v = receiver("/tmp/argus-v.sdp");
const a = receiver("/tmp/argus-a.sdp");
await new Promise((r) => setTimeout(r, 500));
const sender = spawn("ffmpeg", sendArgs, { stdio: ["ignore", "ignore", "pipe"] });
let senderErr = "";
sender.stderr.on("data", (c) => { senderErr += c; });

console.log(`stream=${streamName} ${width}x${height}@${bitrate}k for ${seconds}s`);
console.log("t(s)  video_clock(s)  audio_clock(s)  skew(ms)   [skew drifting = lip-sync gate trips]");
const t0 = Date.now();
const samples = [];
const timer = setInterval(() => {
  const t = Math.round((Date.now() - t0) / 1000);
  const vs = v.state.outTimeUs / 1e6;
  const as = a.state.outTimeUs / 1e6;
  const skewMs = Math.round((vs - as) * 1000);
  samples.push({ t, vs, as, skewMs });
  console.log(`${String(t).padStart(4)}  ${vs.toFixed(2).padStart(13)}  ${as.toFixed(2).padStart(13)}  ${String(skewMs).padStart(7)}`);
}, 10_000);

await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(timer);
sender.kill("SIGKILL");
v.proc.kill("SIGKILL");
a.proc.kill("SIGKILL");

const first = samples.find((s) => s.vs > 1 && s.as > 1);
const last = samples[samples.length - 1];
if (first && last && last.t > first.t) {
  const driftMsPerMin = ((last.skewMs - first.skewMs) / (last.t - first.t)) * 60;
  console.log(`\nVERDICT: skew ${first.skewMs}ms -> ${last.skewMs}ms; drift ${driftMsPerMin.toFixed(0)} ms/min`);
  console.log(driftMsPerMin > 100 || Math.abs(last.skewMs) > 1000
    ? "A/V CLOCKS DIVERGE — this is what trips the iOS gate."
    : "A/V clocks track — stream-side sync looks healthy.");
} else {
  console.log("\nVERDICT: insufficient decode on one or both legs", { videoErr: v.state.err.slice(-200), audioErr: a.state.err.slice(-200) });
}
