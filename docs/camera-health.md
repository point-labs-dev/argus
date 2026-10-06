# Argus camera health

Read-only runbook for the house Mac Mini. It checks whether Argus is loaded, whether each camera restream answers, and whether the go2rtc API still requires auth.

Do not run installers, `scripts/cutover-launchdaemon.sh`, `scripts/rollback-launchdaemon.sh`, `launchctl bootstrap` / `bootout` / `load` / `unload` / `kickstart`, `scripts/smoke-spine.mjs` (it starts and then stops go2rtc), or `scripts/tune-substreams.mjs` (it changes camera encoder settings). Do not delete anything under `.homekit/` or `recordings/`.

Before sharing output: if any line contains `rtsp://`, a password, a pair code, or a setup URI, delete that line.

## Stream check (use this, not `/api/streams`)

Since PR #11 the go2rtc API requires local auth. An unauthenticated `curl http://127.0.0.1:1984/api/streams` returns **401**. That is the expected auth check, not a stream failure. Do not treat 401 as "cameras are down." Do not print the response body: if auth were off, that body would contain camera passwords inside source URLs.

Check restreams with the repo command from PR #15:

```bash
node scripts/stream-health.mjs
```

It reads camera names from `argus.yaml`, builds the go2rtc stream names (main and sub), and runs one `ffprobe` per stream against `rtsp://127.0.0.1:8554/<name>`. It does not send credentials and does not call the API.

Options:

- `--config <path>` — YAML to read (default `argus.yaml`)
- `--timeout-ms <ms>` — per-stream `ffprobe` timeout (default `12000`)

It needs `dist/go2rtc.js` from the last `npm run build`.

Stdout looks like:

```text
stream_count=14
garage-door	UP	h264,2560,1440
garage-door-sub	UP	h264,640,480
…
up_count=14
```

Each stream line is `name`, `UP` or `DOWN`, then either `codec,width,height` or a down reason (`exit=<n>`, `timeout`, `ffprobe-missing`). The script never prints the RTSP URL or camera passwords.

Exit codes:

- `0` — at least one stream is configured and every main and sub is UP
- `1` — any stream is DOWN, there are zero streams, the config cannot be read, or `dist/go2rtc.js` is missing

On the house Mini a healthy fleet prints `stream_count=14` and `up_count=14` and exits 0.

## Last field reading (2026-10-06)

Home Manager ran the read-only check on the Mini against `git b1de4c4` (firmware `1.3.15`). All 7 cameras were live in Argus and HomeKit. `scripts/stream-health.mjs` reported `stream_count=14 up_count=14` and exited 0. That morning Argus was the `gui/501` LaunchAgent. The repo now has `scripts/cutover-launchdaemon.sh`; after that script the live job is `system/dev.point-labs.argus`. Check both domains.

| Camera | Role confirmed 2026-10-06 | Status |
|---|---|---|
| Garage Door | Direct camera. No SD card. Not on the NVR | up |
| Backyard Left | Direct camera. No SD card. Not on the NVR | up |
| Backyard | Direct camera. No SD card. Not on the NVR | up |
| Doorbell | Direct camera. No SD card. Not on the NVR | up |
| Front L | NVR RLN8-410 channel, recorded 24/7 | up |
| Front R | NVR RLN8-410 channel, recorded 24/7 | up |
| Backyard Right | NVR RLN8-410 channel, recorded 24/7 | up |

Expect 14 go2rtc names if those seven names are unchanged: `garage-door` and `garage-door-sub`, and the same `name` / `name-sub` pair for the other six (lowercase, spaces become hyphens). A different `argus.yaml` produces different names. The script prints the live names.

## LaunchAgent or LaunchDaemon

Label is `dev.point-labs.argus` in both domains.

- **LaunchAgent:** `gui/<uid>/dev.point-labs.argus` (on the house Mini that uid is `501`). Plist: `$HOME/Library/LaunchAgents/dev.point-labs.argus.plist`. Needs a GUI session (`gui/<uid>`), including one created by automatic login. A reboot with nobody logged in does not start this job.
- **LaunchDaemon:** `system/dev.point-labs.argus` after `scripts/cutover-launchdaemon.sh`. Plist: `/Library/LaunchDaemons/dev.point-labs.argus.plist`. This is the boot-level job. FileVault still has to be unlocked before any job can start.

`scripts/install-launchd.sh` writes the agent plist and, when run with sudo as the Mini user, also writes the daemon plist. Cutover retires the gui job and bootstraps the system job. This runbook only *reads* both domains. It does not install, cut over, or kickstart.

## Commands for Peter (via Chief of Staff)

Run these on the Mini, in Terminal, while logged in. They only read launchd, the plist, `argus.yaml` names (not secrets), the local go2rtc restream, the unauthenticated API status code, and the existing log files.

Paste the whole block. It prints one section at a time.

```bash
set -u
LABEL="dev.point-labs.argus"
AGENT="$HOME/Library/LaunchAgents/${LABEL}.plist"
DAEMON="/Library/LaunchDaemons/${LABEL}.plist"
UID_NUM="$(id -u)"

echo "===== 1. who and when ====="
date
scutil --get ComputerName 2>/dev/null || true
echo "user=$(id -un) uid=${UID_NUM}"
echo "gui_session=$(who | awk '{print $2}' | tr '\n' ' ')"

echo "===== 2. which plist exists ====="
# Prints: path and size, or "No such file". Does not load or unload anything.
ls -l "$AGENT" 2>&1
ls -l "$DAEMON" 2>&1

echo "===== 3. agent job (read-only) ====="
# Running job looks like: state = running / pid = <n> / runs = <n>
# Not loaded looks like: Could not find service "dev.point-labs.argus"
# After cutover this domain is empty and section 4 is the live job.
launchctl print "gui/${UID_NUM}/${LABEL}" 2>&1 \
  | grep -E 'state =|pid =|runs =|last exit|path =|program =|stdout path|stderr path|working directory|Could not find|Bad request|service' \
  || true

echo "===== 4. boot daemon job (read-only) ====="
# After cutover-launchdaemon.sh the live job is system/dev.point-labs.argus.
# "Could not find service" means this domain has no Argus daemon.
launchctl print "system/${LABEL}" 2>&1 \
  | grep -E 'state =|pid =|runs =|last exit|path =|program =|stdout path|stderr path|working directory|Could not find|Bad request|service' \
  || true

echo "===== 5. plist keys (no environment dump) ====="
# Read whichever plists exist. Do not dump EnvironmentVariables (credentials).
for PLIST in "$AGENT" "$DAEMON"; do
  if [[ -f "$PLIST" ]]; then
    echo "-- ${PLIST} --"
    plutil -p "$PLIST" | grep -E 'Label|UserName|WorkingDirectory|RunAtLoad|KeepAlive|StandardOutPath|StandardErrorPath|ARGUS_AUDIO|ARGUS_LIVE_MAIN_SOURCE|ARGUS_HUB_ADDRESSES|ARGUS_FFMPEG' || true
  else
    echo "missing ${PLIST}"
  fi
done

echo "===== 6. process ====="
# node dist/serve.js and a go2rtc child. Empty means the bridge process is not running.
ps aux | grep -E '[d]ist/serve.js|[g]o2rtc' || true

echo "===== 7. camera inventory (names only) ====="
# Prefer the loaded job's plist, then whichever plist exists.
# Prints name, host, channel, mainCodec. Does not print username, password, or PIN.
PLIST=""
if [[ -f "$DAEMON" ]] && launchctl print "system/${LABEL}" >/dev/null 2>&1; then
  PLIST="$DAEMON"
elif [[ -f "$AGENT" ]] && launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1; then
  PLIST="$AGENT"
elif [[ -f "$DAEMON" ]]; then
  PLIST="$DAEMON"
elif [[ -f "$AGENT" ]]; then
  PLIST="$AGENT"
fi
WD=""
if [[ -n "$PLIST" ]]; then
  WD="$(plutil -extract WorkingDirectory raw -o - "$PLIST" 2>/dev/null || true)"
fi
echo "plist=${PLIST:-missing}"
echo "working_directory=${WD:-unknown}"
if [[ -n "$WD" && -f "$WD/argus.yaml" ]]; then
  (cd "$WD" && node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { parse } from "yaml";
    const doc = parse(readFileSync("argus.yaml", "utf8"));
    const cams = Array.isArray(doc.cameras) ? doc.cameras : [];
    console.log("camera_count=" + cams.length);
    console.log("go2rtc_api_port=" + (doc.go2rtc && doc.go2rtc.api_port ? doc.go2rtc.api_port : "missing"));
    for (const c of cams) {
      console.log([c.name, c.host, "ch" + c.channel, c.mainCodec || "h264"].join("\t"));
    }
  ')
  echo "git=$(git -C "$WD" log -1 --oneline 2>/dev/null || echo "not a git checkout")"
  echo "firmware=$(grep -m1 ARGUS_FIRMWARE_REVISION "$WD/src/homekit.ts" 2>/dev/null || echo "src/homekit.ts not found")"
else
  echo "argus.yaml not found via plist WorkingDirectory"
fi

echo "===== 8. go2rtc stream health (local restream) ====="
# node scripts/stream-health.mjs: one ffprobe per main and sub on 127.0.0.1:8554.
# Prints stream_count, name + UP/DOWN, up_count. Exit 0 when every stream is UP.
# Does not print the URL or the camera password. Does not call /api/streams.
# Needs dist/go2rtc.js from the last build.
if [[ -z "${WD:-}" || ! -f "$WD/argus.yaml" ]]; then
  echo "DOWN argus.yaml missing"
else
  (cd "$WD" && node scripts/stream-health.mjs --config argus.yaml)
  echo "stream_health_exit=$?"
fi

echo "===== 8b. go2rtc API auth (expected 401) ====="
# Unauthenticated GET must 401 after PR #11. That is an auth check, not a stream failure.
# Status code only. Do not print the body (camera passwords if auth were off).
PORT=1984
if [[ -n "${WD:-}" && -f "$WD/argus.yaml" ]]; then
  PARSED="$(cd "$WD" && node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { parse } from "yaml";
    const doc = parse(readFileSync("argus.yaml", "utf8"));
    process.stdout.write(String(doc.go2rtc && doc.go2rtc.api_port || 1984));
  ' 2>/dev/null || true)"
  [[ -n "$PARSED" ]] && PORT="$PARSED"
fi
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${PORT}/api/streams" || true)"
if [[ -z "$code" ]]; then
  echo "api_streams_http=unreachable"
  echo "auth_check=unreachable"
elif [[ "$code" == "401" ]]; then
  echo "api_streams_http=401"
  echo "auth_check=expected"
elif [[ "$code" == "200" ]]; then
  echo "api_streams_http=200"
  echo "auth_check=unexpected_open_api"
else
  echo "api_streams_http=${code}"
  echo "auth_check=unexpected"
fi

echo "===== 9. one JPEG per sub stream (local restream) ====="
# Python 3.9-safe: the Mini's /usr/bin/python3 is 3.9.6. Do not put a backslash
# inside an f-string expression (that is a SyntaxError before 3.12).
# ffmpeg against 127.0.0.1:8554. Does not call /api/frame.jpeg or /api/streams.
# Does not print the RTSP URL.
if [[ -z "${WD:-}" || ! -f "$WD/argus.yaml" ]]; then
  echo "skip snapshots; argus.yaml missing"
else
  ARGUS_SUBS="$(cd "$WD" && node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { parse } from "yaml";
    const { buildGo2RtcStreamNames } = await import("./dist/go2rtc.js");
    const doc = parse(readFileSync("argus.yaml", "utf8"));
    const cameras = Array.isArray(doc.cameras) ? doc.cameras : [];
    for (const item of buildGo2RtcStreamNames(cameras)) {
      console.log(item.sub);
    }
  ')" || true
  export ARGUS_SUBS
  python3 -c '
import os
import subprocess

JPEG_START = b"\xff\xd8"
names = [line for line in os.environ.get("ARGUS_SUBS", "").split("\n") if line]
if not names:
    print("no sub streams in argus.yaml")
    raise SystemExit
for name in names:
    url = "rtsp://127.0.0.1:8554/" + name
    try:
        proc = subprocess.run(
            [
                "ffmpeg",
                "-v", "error",
                "-rtsp_transport", "tcp",
                "-i", url,
                "-frames:v", "1",
                "-f", "image2",
                "-c:v", "mjpeg",
                "pipe:1",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
    except subprocess.TimeoutExpired:
        print("%s\tDOWN\ttimeout" % name)
        continue
    except OSError:
        print("%s\tDOWN\tffmpeg-missing" % name)
        continue
    body = proc.stdout or b""
    kind = "jpeg" if body[:2] == JPEG_START else "not-jpeg"
    if proc.returncode == 0 and kind == "jpeg":
        print("%s\t%s\tbytes=%d" % (name, kind, len(body)))
    else:
        print("%s\tDOWN\texit=%s" % (name, proc.returncode))
'
fi

echo "===== 10. recent bridge logs ====="
# "live source WxH" = startup snapshot worked.
# "live-resolution probe failed" = that camera did not answer during the last start.
# "motion poll error" = Reolink motion API failing for that camera.
# hksv_recording_start / hksv_recording_stop = Home Hub asked for a clip. Zero of these in the tail only means no recording in the tail, not that HKSV is off.
OUT=""; ERR=""
if [[ -n "$PLIST" ]]; then
  OUT="$(plutil -extract StandardOutPath raw -o - "$PLIST" 2>/dev/null || true)"
  ERR="$(plutil -extract StandardErrorPath raw -o - "$PLIST" 2>/dev/null || true)"
fi
echo "stdout=${OUT:-missing}"
echo "stderr=${ERR:-missing}"
if [[ -n "$OUT" && -f "$OUT" ]]; then
  echo "-- stdout matches --"
  grep -E 'live source |live mode: |HAP bind address|live-resolution probe failed|Argus is live' "$OUT" | tail -n 40
else
  echo "stdout log missing"
fi
if [[ -n "$ERR" && -f "$ERR" ]]; then
  echo "-- probe and motion errors (last 30) --"
  grep -E 'live-resolution probe failed|motion poll error|pre-warm' "$ERR" | tail -n 30
  echo "-- telemetry event counts in last 8000 lines --"
  tail -n 8000 "$ERR" | grep 'ARGUS_TELEMETRY:' | sed 's/^.*ARGUS_TELEMETRY: //' \
    | python3 -c '
import json,sys,collections
c=collections.Counter()
cams=collections.defaultdict(collections.Counter)
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: ev=json.loads(line)
    except Exception: continue
    c[ev.get("event","?")] += 1
    cams[ev.get("camera","?")][ev.get("event","?")] += 1
print("events", dict(c))
for cam in sorted(cams):
    print(cam, dict(cams[cam]))
'
else
  echo "stderr log missing"
fi
```

### What each section prints

| Section | Healthy | Down or wrong install |
|---|---|---|
| 1 | Mini’s computer name, console user, a GUI session (`console`) | No `console` in `who` means nobody is in the GUI. A LaunchAgent is not running across a headless boot |
| 2 | Agent plist, daemon plist, or both. After cutover the daemon plist exists and the agent plist may be gone | Neither plist is a missing install. Send the `ls` lines |
| 3 | `state = running` **or** `Could not find service` after cutover (then section 4 must be running) | `Could not find service` here **and** in section 4 means Argus is not loaded |
| 4 | `state = running` after `cutover-launchdaemon.sh`, **or** `Could not find service` while the gui agent is still the live job | `Could not find service` here **and** in section 3 means Argus is not loaded |
| 5 | `RunAtLoad` true, `KeepAlive` true, log paths under the repo | `ARGUS_AUDIO = 0` is video-only mode. Send the line if present |
| 6 | One `dist/serve.js` and one `go2rtc` | No matching lines means the bridge is not running |
| 7 | `camera_count=7` and seven name/host/channel rows; firmware line contains `1.3.15` | A count other than 7, or a missing `argus.yaml`, is the inventory mismatch |
| 8 | `stream_count=14`, `up_count=14`, every line `UP` plus codec/width/height, `stream_health_exit=0` | A `DOWN` line is that restream failing. Exit 1 is unhealthy. This is not an API call |
| 8b | `api_streams_http=401` and `auth_check=expected` | `200` means the API is open (do not dump the body). Unreachable means go2rtc is not listening |
| 9 | Each `*-sub` line is `jpeg` | `DOWN` or `not-jpeg` is that camera’s sub restream failing. Mains are separate rows in section 8 |
| 10 | A `live source WxH` line per camera from the latest start; motion errors not repeating; some `hksv_recording_start` if there has been motion | `live-resolution probe failed` or repeating `motion poll error` names the camera that is down. No HKSV events in the last 8000 stderr lines is inconclusive unless section 8 shows the main stream down |

### What to send back

Send the full script output, after the redaction check above. The useful measurements are:

- Section 3 and 4 `state` and `pid` (which domain is live)
- Section 7 camera table and `firmware=` / `git=`
- Section 8 every stream line and `stream_health_exit`
- Section 8b `api_streams_http` (401 is expected)
- Section 9 every snapshot line
- Section 10 any `probe failed` or `motion poll error` lines, plus the telemetry counts

That is enough to mark each camera up or down and to say whether Argus is the gui LaunchAgent or the system LaunchDaemon. It does not require opening Home, re-pairing, or restarting anything.

Optional, only if Peter is already looking at the Home app: for each camera, note whether the tile shows a still and whether live view opens. Do not remove accessories, reset pairings, or change recording settings.
