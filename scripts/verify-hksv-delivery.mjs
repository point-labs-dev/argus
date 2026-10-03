// Measures HKSV fragment DELIVERY latency end to end with a real ffmpeg:
// spawns the EXACT recording command buildRecordingFfmpegArgs produces (input
// swapped for a realtime lavfi A/V source) and times when each RecordingPacket
// leaves ArgusRecordingDelegate.handleRecordingStreamRequest — the moment
// HAP-NodeJS would put it on the wire to the Home Hub.
//
// What to look for: the init segment (ftyp+moov) should leave as soon as ffmpeg
// emits it (sub-second), and fragment N should leave at its own fragment
// boundary (~N*4s), NOT one fragment later. The pre-1.3.15 hold-one-back
// pattern delayed every packet by a full 4s fragment.
//
// Usage: npm run build && node scripts/verify-hksv-delivery.mjs
import { spawn } from "node:child_process";

import { ArgusRecordingDelegate } from "../dist/recording.js";

const config = {
  prebufferLength: 4000,
  eventTriggerTypes: [1],
  mediaContainerConfiguration: { type: 0, fragmentLength: 4000 },
  videoCodec: { type: 0, parameters: { profile: 2, level: 2, bitRate: 2000, iFrameInterval: 4000 }, resolution: [640, 360, 30] },
  audioCodec: { type: 0, bitrate: 64, samplerate: 3, audioChannels: 1 },
};

// Swap the RTSP input for realtime synthetic A/V (-re paces lavfi at wall
// clock, like a live camera). Everything downstream of -i is untouched.
const spawnFn = (bin, args, opts) => {
  const i = args.indexOf("-rtsp_transport");
  const patched = [
    ...args.slice(0, i),
    "-re", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-re", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=32000",
    ...args.slice(i + 4),
  ];
  return spawn(bin, patched, opts);
};

const delegate = new ArgusRecordingDelegate("harness", "rtsp://unused", { spawnFn, verbose: false });
delegate.updateRecordingConfiguration(config);

const t0 = Date.now();
let count = 0;
for await (const packet of delegate.handleRecordingStreamRequest(1)) {
  count += 1;
  const seconds = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`packet ${count}: +${seconds}s  ${packet.data.length} bytes  isLast=${packet.isLast}`);
  if (count >= 3) break;
}
if (count === 0) {
  console.error("no packets delivered — ffmpeg failed to produce fMP4");
  process.exit(1);
}
