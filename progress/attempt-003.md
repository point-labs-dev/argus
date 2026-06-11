# Attempt 003 — Live-view quality ceiling round 2 (Execution order 1b) (2026-06-11 evening)

Goal item: **1b — the 640x360 quality ceiling + start time round 2.** Premise from
the goal prompt (measured in attempt-002's session): Apple clients negotiate only
from their own resolution ladder; the probed 896-wide advertisements were dead
weight and every session sat at 640x360@132k.

47 tests green (was 44). Daemon redeployed, configVersion 6→7 fleet-wide.

## What landed

### Apple-standard ladder + main-stream sourcing (src/homekit.ts)
- Transcode mode now advertises **1920x1080 + 1280x720 + the old standard set**
  and nothing non-standard (copy mode still advertises only the probed native).
- The delegate picks the FFmpeg input per negotiated size: **≥720p sessions
  transcode the camera's full-res MAIN restream** (2560x1920/4K); smaller
  sessions stay on the light sub. Applies on START and re-applies on RECONFIGURE
  respawn (full-screen upgrade moves to main, backgrounding returns to sub).
- Granting is per camera (serve): **standalone cams only.** NVR channels keep the
  sub source at every size — their mains are 4s-GOP (hard limit) and the D1200s
  are 12MP HEVC; both blow the live start budget.
- Scale filter is now aspect-preserving (`force_original_aspect_ratio=decrease:
  force_divisible_by=2`, homebridge-camera-ffmpeg pattern) — a plain WxH scale
  would stretch the 4:3 mains (2560x1920) into 16:9. Output never exceeds the
  negotiated box (oversize is what controllers kill sessions over).

### THE session's discovery — NVR D1200 mains are HEVC behind h264-named paths
- `h264Preview_03/04_main` deliver **hevc 4512x2512**; `h265Preview_*` 404s. On
  the NVR the RTSP path prefix is a NAME, not the codec. ch6 (D500) is true h264.
- Config said `mainCodec: h264` → transport "auto" put HTTP-FLV first → the FLV
  main of an HEVC channel **hangs forever delivering nothing** (same class as the
  known RLC-812A FLV failure) → go2rtc never failed over → **Front L / Front R
  HKSV recordings had a dead source** (their recording ffmpegs launched and read
  nothing). Motion events still fired, so the breakage was silent.
- Fix: argus.yaml records the TRUE codec (`mainCodec: h265` for both D1200s,
  drives the FLV skip); `buildRtspUrl` keeps the h264 path label for NVR channels
  (`channel > 0`) regardless of codec. Verified: front-l restream now delivers
  hevc+aac through go2rtc; producer warm via preload.

### Start-time levers (bench-verified, scripts/bench-live-start.mjs grew
### --mode/--size/--bitrate/--window flags)
- **Sub source swap (go2rtc.ts): RTSP fluent first, FLV fallback.** The FLV "sub"
  name is really the EXT profile — 896-wide but a FIXED ~2s keyframe interval,
  so attempt-002's gop=1 sub tuning never reached the live path. RTSP serves the
  true fluent sub (gop=1). Tile starts: **avg 3.1-3.5s → 0.91s.**
- **Main gop 2→1** on the 4 standalone cams via extended tune-substreams.mjs
  (GetEnc readback verified; NVR strips gop as known). Also sharpens HKSV starts.
- **Input analysis trimmed to 0.2s/100k for transcode too** (was 1s/500k):
  720p-from-main 2.81s → 1.82s in the A/B; AAC detection stayed reliable
  (13/13 runs incl. subs + 4K HEVC main).
- **Mains preloaded in go2rtc** alongside subs (≥720p live + HKSV pull warm
  producers; ~40Mbps standing LAN, NVR records mains continuously anyway).

### Bench results (production args, warm producers, local UDP sink)
| path | first video packet | sustained 6s |
|---|---|---|
| tile 640x360 (fluent sub) | **avg 0.91s** max 1.25s | ✓ |
| Garage 720p (2560x1920 main) | **avg 1.05s** max 1.39s | 1548+ pkts |
| Backyard Left 720p (4K HEVC main) | **avg 1.07s** max 1.47s | 1591+ pkts |
| Garage 1080p | **avg 1.13s** max 1.28s | 2280+ pkts |

4K HEVC software decode is a non-issue on this hardware. NVR cams keep ~2-4s
starts (4s GOP, hard limit, documented).

## Deploy + verification state
- configVersion bumped 6→7 with the daemon stopped (backup in
  `.homekit.bak-cv6-20260611/`, now gitignore-guarded); **mDNS TXT shows c#=7 +
  sf=0 on all 7 accessories** → controllers will refetch the new ladder, no
  re-pair needed (unless proven otherwise — see goal prompt's cache trap).
- Daemon healthy post-restart: hub 10.0.0.15 holds 9 ESTABLISHED, snapshots 200
  @ ~1s, motion firing, organic HKSV recordings launching (Garage Door,
  Backyard Left observed live during the session).
- **Mac GUI negotiation check was impossible: the Mac sat at the lock screen**
  (and renders no live video anyway — ipsec self-route). The negotiated-line
  proof (`HomeKit negotiated video: 1280x720...source=...<main>` in
  serve.err.log) lands the moment Peter next opens a camera; checklist below.

## Trade-offs / watch items
1. **Tile snapshots are now fluent-sized (640-wide, was 896)** on the 4
   standalone cams — snapshots come from the go2rtc sub restream
   (`frame.jpeg`). Grid tiles don't need more; if Peter notices softness,
   point SnapshotCache at the (now warm) mains.
2. Backyard Left HKSV logs spam `hevc ... RPS/POC` decode noise at stream-join
   (pre-existing, recovers, recordings verified working). Cosmetic; trim with
   recording-side loglevel if it bothers.
3. Copy mode (`ARGUS_LIVE_COPY=1`) now delivers the FLUENT sub (640-wide), and
   the probe advertises that honestly. Still experimental, still macOS-hostile.
4. WiFi keyframe-burst mitigation ladder (goal prompt 1b) stands by if iPhone
   full-screen spins at 720p+: relax 1s IDRs → `-g` only → intra-refresh →
   smaller pkt_size → drop 1080p.

## Peter's ~10-min iPhone co-test (the only missing verification)
1. Open any camera tile — should start ~1s faster than yesterday.
2. Full-screen Garage Door; within ~2s it should go visibly SHARP (real 720p+).
   Agent-side proof: `grep "negotiated video" logs/serve.err.log` →
   `1280x720` (or 1920x1080) `@1000-3000k ... source=rtsp://127.0.0.1:8554/garage-door`
   with no early `exited`/forceStop after it.
3. Front L/R full-screen: starts a couple seconds slower (NVR 4s GOP), picture =
   upscaled 896 (hardware limit of the add-on cams).
4. Check the Home timeline for NEW Front L / Front R HKSV clips with labels —
   these were silently broken before today's codec fix.
5. Optional A/B: `ARGUS_LIVE_COPY=1` in the plist env (native passthrough,
   now 640-wide fluent) — iOS tolerance unknown, macOS kills it.

## Debug methods that worked (new this session)
- `ffprobe -rw_timeout` against go2rtc restreams: a producer that "exists" but
  delivers nothing (dead FLV source) is invisible in /api/streams — probe the
  actual delivery, not the config.
- Probing the NVR's RTSP namespace with both codec prefixes per channel exposed
  the name-vs-payload decoupling in minutes.
