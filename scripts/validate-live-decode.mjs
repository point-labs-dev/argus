// Receive-side validation of the live SRTP stream: spawns the EXACT production
// sender (buildLiveFfmpegArgs) at a local UDP port, then DECODES what arrives
// with a second ffmpeg fed an SDP describing the session — the same job the
// iPhone's decoder does. bench-live-start counts packets; this proves the
// payload is actually decodable (SPS/PPS present, slices intact, IDR cadence).
//
// Usage: node scripts/validate-live-decode.mjs [stream] [--size WxH] [--bitrate K] [--seconds N]
import { createSocket } from "node:dgram";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

import { buildLiveFfmpegArgs } from "../dist/homekit.js";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const streamName = positional[0] ?? "garage-door";
const [width, height] = flag("size", "1280x720").split("x").map(Number);
const bitrate = Number(flag("bitrate", 2000));
const seconds = Number(flag("seconds", 12));

async function freePort() {
  const socket = createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

const videoPort = await freePort();
const videoRtcp = await freePort();
const audioPort = await freePort();
const audioRtcp = await freePort();

// Fixed, valid SRTP key material shared by sender and receiver.
const videoKey = Buffer.alloc(30, 7).toString("base64");
const audioKey = Buffer.alloc(30, 9).toString("base64");

const sendArgs = buildLiveFfmpegArgs({
  inputUrl: `rtsp://127.0.0.1:8554/${streamName}`,
  targetAddress: "127.0.0.1",
  videoMode: "transcode",
  video: {
    port: videoPort, localRtcpPort: videoRtcp, ssrc: 111, payloadType: 99,
    maxBitrateKbps: bitrate, fps: 30, width, height, mtu: 1378,
    profile: "high", level: "4.0", srtpParams: videoKey,
  },
  audio: {
    port: audioPort, localRtcpPort: audioRtcp, ssrc: 222, payloadType: 110,
    sampleRateKhz: 24, maxBitrateKbps: 24, srtpParams: audioKey,
  },
});

// SDP describing what the phone would have been told (video only — audio is a
// separate RTP session; validate video, the hanging medium).
const sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=argus-validate
c=IN IP4 127.0.0.1
t=0 0
m=video ${videoPort} RTP/SAVP 99
a=rtpmap:99 H264/90000
a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${videoKey}
`;
writeFileSync("/tmp/argus-validate.sdp", sdp);

const receiver = spawn("ffmpeg", [
  "-hide_banner", "-loglevel", "warning",
  "-protocol_whitelist", "file,udp,rtp,srtp,crypto",
  "-i", "/tmp/argus-validate.sdp",
  // Machine-readable frame counter on stdout (-loglevel warning suppresses
  // the human stats line, which silently breaks frame= scraping).
  "-progress", "pipe:1", "-nostats",
  "-f", "null", "-",
], { stdio: ["ignore", "pipe", "pipe"] });
let receiverErr = "";
let receiverProgress = "";
receiver.stderr.on("data", (c) => { receiverErr += c; });
receiver.stdout.on("data", (c) => { receiverProgress += c; });

// Give the receiver a beat to bind before the sender starts.
await new Promise((r) => setTimeout(r, 500));
const sender = spawn("ffmpeg", sendArgs, { stdio: ["ignore", "ignore", "pipe"] });
let senderErr = "";
sender.stderr.on("data", (c) => { senderErr += c; });

await new Promise((r) => setTimeout(r, seconds * 1000));
sender.kill("SIGKILL");
await new Promise((r) => setTimeout(r, 1500));
receiver.kill("SIGKILL");

const frames = [...receiverProgress.matchAll(/frame=(\d+)/g)].map((m) => Number(m[1])).pop();
const decodeErrors = (receiverErr.match(/error|corrupt|missing|invalid/gi) ?? []).length;
console.log(`sender: ${senderErr.trim().split("\n").slice(-2).join(" | ") || "clean"}`);
console.log(`receiver decoded frames=${frames ?? "NONE (no decodable video!)"} over ${seconds}s`);
console.log(`receiver error-ish lines: ${decodeErrors}`);
if (receiverErr.trim()) {
  console.log("--- receiver stderr tail ---");
  console.log(receiverErr.trim().split("\n").slice(-8).join("\n"));
}
