// Tune the fleet's streams for fast HomeKit live-view starts (Execution order #1/#1b):
//   - standalone subs:  gop=1 (keyframe every ~1s), 15 fps, 512 kbps (max), keep size
//   - standalone mains: gop=1 only (≥720p live sessions + HKSV source these; a 1s
//                       keyframe cadence is what bounds their start time)
//   - NVR channels:     try gop=1 (the NVR strips gop — expect refusal, 4s hard
//                       limit), sub 20 fps / 1024 kbps, raise size where accepted
// Bitrate/size/fps of mains are untouched (NVR + HKSV record those). Reads
// gitignored argus.yaml.
//
// Usage: node scripts/tune-substreams.mjs          # dry run (GetEnc + planned changes)
//        node scripts/tune-substreams.mjs --apply  # apply via SetEnc + verify via GetEnc
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const apply = process.argv.includes("--apply");
const cfg = parse(await readFile("argus.yaml", "utf8"));

// 1024k is the D1200 sub-encoder ceiling (2048 → param error, probed
// 2026-06-12); it matters because the 896-wide sub IS those channels'
// full-screen live source. The D500 (ch6) rejects anything above 640*480@15/512.
const NVR_SUB_TARGET = { size: "896*512", frameRate: 20, bitRate: 1024 };
const STANDALONE_SUB_TARGET = { frameRate: 15, bitRate: 512, gop: 1 };

async function api(host, cmd, body, token) {
  const query = token ? `?cmd=${cmd}&token=${token}` : `?cmd=${cmd}`;
  const res = await fetch(`http://${host}/cgi-bin/api.cgi${query}`, {
    method: "POST",
    body: JSON.stringify([body]),
  });
  return (await res.json())[0];
}

const byHost = new Map();
for (const cam of cfg.cameras) {
  if (!byHost.has(cam.host)) byHost.set(cam.host, { username: cam.username, password: cam.password, cams: [] });
  byHost.get(cam.host).cams.push(cam);
}

const fmt = (s) => (s ? `${s.size}@${s.frameRate}fps ${s.bitRate}kbps gop=${s.gop ?? "?"}` : "(none)");

for (const [host, { username, password, cams }] of byHost) {
  const login = await api(host, "Login", { cmd: "Login", action: 0, param: { User: { userName: username, password } } });
  const token = login?.value?.Token?.name;
  if (!token) {
    console.log(`${host}: LOGIN FAILED ${JSON.stringify(login?.error)}`);
    continue;
  }

  for (const cam of cams) {
    const isNvr = cam.channel > 0 || cams.length > 1; // NVR fronts multiple channels
    const before = await api(host, "GetEnc", { cmd: "GetEnc", action: 0, param: { channel: cam.channel } }, token);
    const enc = before?.value?.Enc;
    if (!enc) {
      console.log(`${cam.name}: GetEnc failed ${JSON.stringify(before?.error)}`);
      continue;
    }

    const target = isNvr ? { ...NVR_SUB_TARGET, gop: 1 } : { ...STANDALONE_SUB_TARGET };
    const desired = { ...enc.subStream, ...target };
    // Main: 1s keyframes only (sources for ≥720p live + HKSV). The NVR strips
    // gop from GetEnc/SetEnc entirely — leave its mains untouched.
    const desiredMain =
      enc.mainStream?.gop !== undefined ? { ...enc.mainStream, gop: 1 } : enc.mainStream;
    console.log(`\n${cam.name} (${host} ch${cam.channel})`);
    console.log(`  sub  before: ${fmt(enc.subStream)}`);
    console.log(`  sub  target: ${fmt(desired)}`);
    console.log(`  main before: ${fmt(enc.mainStream)}`);
    console.log(`  main target: ${fmt(desiredMain)}${desiredMain === enc.mainStream ? " (no gop exposed — skipping)" : ""}`);
    if (!apply) continue;

    // SetEnc writes the whole Enc block; keep audio exactly as-is.
    const trySet = async (subStream, mainStream = desiredMain) =>
      api(host, "SetEnc", { cmd: "SetEnc", action: 0, param: { Enc: { ...enc, subStream, mainStream } } }, token);

    let result = await trySet(desired);
    if (result?.code !== 0 && desired.gop !== undefined && enc.subStream.gop === undefined) {
      console.log(`  SetEnc with gop rejected (${JSON.stringify(result?.error)}); retrying without gop`);
      const { gop: _gop, ...noGop } = desired;
      result = await trySet(noGop, enc.mainStream);
    }
    if (result?.code !== 0 && isNvr && desired.size !== enc.subStream.size) {
      console.log(`  SetEnc with size ${desired.size} rejected (${JSON.stringify(result?.error)}); retrying with original size`);
      const { gop: _gop, ...noGop } = { ...desired, size: enc.subStream.size };
      result = await trySet(noGop, enc.mainStream);
    }
    if (result?.code !== 0) {
      console.log(`  SetEnc FAILED: ${JSON.stringify(result?.error)}`);
      continue;
    }

    const after = await api(host, "GetEnc", { cmd: "GetEnc", action: 0, param: { channel: cam.channel } }, token);
    console.log(`  sub  after:  ${fmt(after?.value?.Enc?.subStream)}`);
    console.log(`  main after:  ${fmt(after?.value?.Enc?.mainStream)}`);
  }

  await api(host, "Logout", { cmd: "Logout", action: 0, param: {} }, token);
}
