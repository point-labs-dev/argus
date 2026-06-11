# Attempt 002 — Live-feed overhaul + launchd daemon + fleet re-pair prep (2026-06-11)

Goal items this session (from the standing goal prompt): (1) live-feed start
time / resolution / reliability, (2) daemonize via launchd, (3) re-pair prep for
the 6 outstanding cameras. 44 tests green; daemon running; hub connected.

## What landed

### Camera-side tuning (the #1 start-time lever) — `scripts/tune-substreams.mjs`
- Probed the whole fleet with `GetEnc action:1` (`scripts/probe-enc.mjs`): Reolink
  exposes `gop` (the "Interframe Space" 1X–4X multiplier) for main+sub on
  standalone cameras; ALL subs were at gop=4 @10fps = **keyframe every 4s** — that
  was the dominant live-view lag.
- Standalone cams (.5/.7/.9/.10): sub now **gop=1 (1s keyframes), 15fps, 512kbps**
  (verified via GetEnc readback).
- NVR channels: D1200s (ch2/ch3) accepted 896x512@20fps/1024kbps; the D500 (ch6)
  rejected everything above 640x480@15fps/512kbps (the NVR's advertised ranges are
  a union template — don't trust them per-channel). **The NVR strips/ignores `gop`
  and its channels keyframe every 4.0s, fps-independent — hard limit**, measured
  before/after. NVR-fronted cams will always start ~2s slower than standalone.
- Stream cartography (measured, ffprobe 12s samples): Reolink **ext** (balanced)
  = 896x512 (16:9 models) / 896x672 (4:3 models) at ~2.0s keyframes, NOT
  API-configurable, FLV-only on standalone cams; **sub/fluent** = ≤640x480,
  gop-configurable. On NVR channels ext==sub (same encoder). go2rtc's `-sub`
  streams consume FLV-ext first → live source is 896-wide everywhere except
  nothing (even the D500's NVR-side ext serves 896x672).

### go2rtc warm streams (the #2 lever) — `preload:` in the generated config
- Producers used to exist only while a consumer was attached; every live tap paid
  a cold FLV connect (~1–3s) before the keyframe wait even started (measured
  1.6–5.3s to first decodable frame, cold). go2rtc v1.9.14 supports `preload:`
  (verified in the binary); all 7 sub producers now connect at startup and stay up.
- serve now probes each camera's live resolution from a snapshot at startup
  (`parseJpegDimensions`, retry loop through the boot window) and logs
  `live source WxH` per camera.

### Live FFmpeg path
- **Transcode is the shipped default**, now improved: HomeKit RECONFIGURE is
  honored by respawning the encoder at the upgraded resolution/bitrate (Apple
  clients START at 640x360 for the tile and reconfigure up when full-screened —
  ignoring it was why full-screen stayed soft). The probed native size
  (896x512/896x672) is advertised on top of the standard set, so full-screen can
  negotiate >640x480. The old blanket ≤640x480 cap is gone.
- **Copy (`-c:v copy`) is implemented but EXPERIMENTAL** (`ARGUS_LIVE_COPY=1`),
  with mode-specific input analysis (0.2s vs 1s — every analysis ms delays the
  keyframe stream-copy waits for). Sender-side it is excellent (see bench). What
  blocked making it default: macOS Home **negotiates 640x360 no matter what is
  advertised** (verified: native-only advertisement + c# bump + fresh
  /accessories fetches → still 640x360), and a session whose delivered resolution
  mismatches the negotiated one dies after one frame. Re-test on iPhone later;
  iOS is reportedly laxer.
- `scripts/bench-live-start.mjs` (committable benchmark, spawns the EXACT
  production FFmpeg args against local UDP sinks): copy mode, warm producers —
  garage avg **1.19s / max 1.57s** to first video packet; doorbell avg 1.71s;
  NVR ch2 avg 2.41s (4s-GOP bound). Sustained 6s flow verified (≈450–700 video +
  ~240 audio packets).

### Daemonized via launchd (goal item 2 — DONE)
- `scripts/install-launchd.sh` → `~/Library/LaunchAgents/dev.point-labs.argus.plist`:
  absolute node path, PATH incl. ffmpeg (launchd sources no profile),
  WorkingDirectory=repo, KeepAlive, RunAtLoad, ProcessType=Interactive, logs to
  `logs/serve.{log,err.log}` (gitignored). `--uninstall` flag included.
- Verified: `launchctl print gui/$UID/dev.point-labs.argus` → state running;
  Home Hub 10.0.0.15 holds ESTABLISHED connections (HAP port 51201 + HKSV data
  stream); HKSV recordings fired repeatedly all session; no cmux dependency.
- Startup burst: the first ~30s after boot, camera HTTP servers refuse some
  connections (7 preloads + 7 logins + probes at once) → motion "fetch failed"
  noise that self-heals. The resolution probe retries through it. Don't panic on
  early-boot errors; check whether they're still growing.
- ReolinkClient now surfaces undici fetch-failure causes (ECONNREFUSED etc.) —
  "fetch failed" alone was undebuggable.

## Walls hit (written up per working rules)

1. **NVR 4s GOP**: not settable via NVR HTTP API (gop stripped from SetEnc, absent
   from GetEnc). Options if it ever matters: Reolink fw update, or replace the 3
   add-on cams with standalone models (also unblocks direct-IP).
2. **Copy mode vs controller resolution negotiation** (3 attempts: plain copy,
   native-only advertising, c# bump): macOS Home requests 640x360 regardless of
   the advertised list and kills mismatched streams after the first IDR. Don't
   re-grind this on the Mac; next data point should be an iPhone test of
   `ARGUS_LIVE_COPY=1`.
3. **THE big one — this MacBook cannot receive its own live streams.** All
   on-Mac live-view tests (copy AND transcode) showed one frame then freeze →
   controller STOP. Root cause (decisive experiment): `route get 10.0.0.46` →
   **ipsec1** (VPN/relay self-addressed interface); `nc -u 10.0.0.46 <port>` from
   the same host never arrives while loopback delivers. The local Home app asks
   for SRTP at 10.0.0.46 → packets enter ipsec1 and vanish. Mitigation landed:
   `resolveSrtpTargetAddress` rewrites a controller address that belongs to this
   host to loopback (helps clients bound to 0.0.0.0; harmless otherwise) — but
   this Mac's Home app appears to bind the specific address, so **the Mac is NOT
   a valid live-view verification instrument on this machine**. Live-view
   verification belongs to Peter's iPhone (worked there yesterday on weaker
   settings) or any non-MacBook client. Snapshots/motion/HKSV verify fine from
   the Mac (TCP/HAP paths unaffected).
4. **HomeKit config caching**: changing advertised streaming config does NOT bump
   the HAP config number; controllers keep their cached copy. Bump
   `configVersion` in `.homekit/AccessoryInfo.<id>.json` (daemon stopped — it's
   at 6 now) or re-pair. Needed whenever resolutions/codecs change.

## Debug methods that worked (reusable)
- Per-stream keyframe cartography: ffprobe `-show_frames -read_intervals %+12`,
  diff I-frame pts (`/tmp/measure-gop.sh` pattern).
- `launchctl submit` one-shot vs same command in agent shell — isolates
  launchd-context problems (it exonerated TCC/local-network here).
- Frozen-video detection without OCR: hash (`md5`) the cropped video region of
  repeated window captures — identical/oscillating hashes = static frames, video
  cannot produce repeats.
- UDP self-delivery probe: `nc -u -l PORT` + send to the candidate address —
  found the ipsec blackhole in 30 seconds.

## State for the next session
- Daemon healthy on the MacBook; all 7 accessories advertising (suffixes:
  Garage Door 3B20 paired ✓; Backyard 4060, Front L 7508, Front R 1B78 to
  re-pair; Doorbell 8F41, Backyard Left 21E9, Backyard Right DF1A first-pair).
  Peter's GUI steps + codes: memory `runbook_repair_cameras.md` (private — codes
  stay out of this public repo).
- Peter's 5-minute iPhone checklist: live tile loads fast at 896-wide
  (full-screen should trigger RECONFIGURE → watch `logs/serve.err.log`), then
  optionally flip `ARGUS_LIVE_COPY=1` in the plist env and compare.
- Next code work: doorbell service (#4), then Mac-mini deploy (#5; no ipsec
  there, and re-check `route get <self-ip>` before trusting local tests).
