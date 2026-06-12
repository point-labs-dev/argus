# Attempt 006 — Hi-res-only ladder: every session sharp from frame one (2026-06-12)

Peter's report: tiles now "really good", but full-screen live STILL pixelated;
wants start "as fast as possible" and live quality "as high as possible".

**Root cause from his logs: every session that day — including his full-screen
taps — ran 640x360 from the sub.** With grid live tiles always running, iOS
REUSES the active 640x360 tile session when the user expands it, and (since
the bitrate floors overshoot Apple's 132k tile ask) it never sent a single
RECONFIGURE upgrade. Yesterday's 720p sessions happened only when no tile
session pre-existed. So "full screen" was an upscaled 640x360 every time —
that's the pixelation, and the upgrade-wait was the start lag.

## The fix: stop offering small sizes at all
- Transcode ladder is now **[1920x1080, 1280x720] only.** The tile player takes
  640x360 whenever it's offered; when it isn't, every session — grid tile AND
  full-screen — negotiates ≥720p from its FIRST frame, sourced from the camera
  main on standalone cams. There is no upgrade moment left to wait for: tap =
  the already-sharp stream.
- `ARGUS_LIVE_LADDER=compat` restores the small tiers (rollback if Apple
  Watch / CarPlay / remote relay refuse hi-res-only; needs a c# bump).
- **configVersion 7→8** (advertised set changed), mDNS-verified c#=8 + sf=0.

## Quality knobs raised at the same time (hi-res tier)
- Floors: 720p 2500→**3500k**, 1080p 4000→**5500k** (capped-CRF, so easy
  scenes undershoot; ARGUS_HUB_ADDRESSES still spec-obeys for relays).
- `-crf 18` (was 20) and `-preset faster` (was veryfast) for ≥720p sessions;
  tiles tier (now only reachable via compat ladder) keeps veryfast/20.
- Delegate logs now carry ISO timestamps (forensics without them kept hurting).

## Verification (51 tests green; deployed)
- **Grid-burst sim: 7 PARALLEL 720p sessions** (4 main-sourced + 3 NVR-sub):
  standalone starts 0.63–1.30s, NVR fronts ~3.2s (their 4s-keyframe ceiling),
  ~2.5 cores total during the burst, go2rtc steady. The full grid at 720p is
  comfortably within budget — and the Mac mini is the same silicon class.
- c#=8 + sf=0 fleet-wide via dns-sd; hub 10 ESTABLISHED; snapshots 200.

## On-device check for Peter
Force-quit the Home app first (drops its cached accessory config; c#=8 makes
it refetch), then: tiles should come up AT 720p+ (watch
`grep "negotiated video" logs/serve.err.log` — expect `1280x720 ...
source=...8554/garage-door` with `serving=3500k`), and tapping into a camera
should be sharp IMMEDIATELY with no focus-hunt moment.

## Open research (workstream running)
1. go2rtc buffered-keyframe replay for RTSP consumers (would cut the ~0.5s
   avg keyframe wait — the remaining start-time floor).
2. Whether bitrate-overshoot suppresses iOS RECONFIGURE upgrades (we sidestep
   it entirely with the hi-res ladder, but worth knowing for the record).

## Risks / rollback
- Some Apple client classes (Watch, CarPlay, low-bandwidth remote relay) may
  want small streams. If anything refuses to load live: set
  `ARGUS_LIVE_LADDER=compat` in the plist, rebuild not needed, bump
  configVersion to 9, restart.
- 7 concurrent hi-res tiles ≈ 25–40Mbps to the viewing device on LAN — fine
  on AC/AX WiFi; remote grid over a thin uplink will be the first place to
  look if reports of stalling grids appear (then: hub-obey list or compat).
