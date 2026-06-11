// Read-only fleet probe: GetEnc (value + ranges) per camera from argus.yaml.
// Usage: node scripts/probe-enc.mjs [--full]
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const full = process.argv.includes("--full");
const cfg = parse(await readFile("argus.yaml", "utf8"));
const byHost = new Map();
for (const cam of cfg.cameras) {
  if (!byHost.has(cam.host)) byHost.set(cam.host, { username: cam.username, password: cam.password, cams: [] });
  byHost.get(cam.host).cams.push(cam);
}

const fmt = (s) => s ? `${s.size}@${s.frameRate}fps ${s.bitRate}kbps gop=${s.gop ?? "?"} ${s.profile ?? ""}` : "(none)";

for (const [host, { username, password, cams }] of byHost) {
  try {
    const loginRes = await fetch(`http://${host}/cgi-bin/api.cgi?cmd=Login`, {
      method: "POST",
      body: JSON.stringify([{ cmd: "Login", action: 0, param: { User: { userName: username, password } } }]),
    });
    const login = await loginRes.json();
    const token = login[0]?.value?.Token?.name;
    if (!token) { console.log(`${host}: LOGIN FAILED`, JSON.stringify(login[0]?.error)); continue; }
    for (const cam of cams) {
      const encRes = await fetch(`http://${host}/cgi-bin/api.cgi?cmd=GetEnc&token=${token}`, {
        method: "POST",
        body: JSON.stringify([{ cmd: "GetEnc", action: 1, param: { channel: cam.channel } }]),
      });
      const enc = (await encRes.json())[0];
      console.log(`\n===== ${cam.name} (${host} ch${cam.channel}) =====`);
      if (enc?.code !== 0) { console.log("GetEnc failed:", JSON.stringify(enc?.error)); continue; }
      if (full) { console.log(JSON.stringify(enc, null, 1)); continue; }
      const v = enc.value?.Enc ?? {};
      console.log(`value: main ${fmt(v.mainStream)} | sub ${fmt(v.subStream)} | extra keys: ${Object.keys(v).filter(k => !["audio","channel","mainStream","subStream"].includes(k)).join(",") || "-"}`);
      const ranges = enc.range?.Enc;
      const r = Array.isArray(ranges) ? ranges[0] : ranges;
      if (r?.subStream) {
        const ss = r.subStream;
        console.log(`sub range: sizes=${Array.isArray(ranges) ? ranges.map(x => x.subStream?.size).join("/") : ss.size} fps=${JSON.stringify(ss.frameRate)} bitrate=${JSON.stringify(ss.bitRate)} gop=${JSON.stringify(ss.gop)}`);
      }
      if (r?.mainStream) {
        const ms = r.mainStream;
        console.log(`main range: sizes=${Array.isArray(ranges) ? ranges.map(x => x.mainStream?.size).join("/") : ms.size} fps=${JSON.stringify(ms.frameRate).slice(0,60)} bitrate=${JSON.stringify(ms.bitRate)} gop=${JSON.stringify(ms.gop)}`);
      }
      console.log(`range extra keys: ${r ? Object.keys(r).filter(k => !["audio","chnBit","mainStream","subStream"].includes(k)).join(",") || "-" : "?"}`);
    }
    await fetch(`http://${host}/cgi-bin/api.cgi?cmd=Logout&token=${token}`, {
      method: "POST", body: JSON.stringify([{ cmd: "Logout", action: 0, param: {} }]),
    });
  } catch (e) { console.log(`${host}: ERROR ${e.message}`); }
}
