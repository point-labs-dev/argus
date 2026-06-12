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

## Addendum — research workstream findings (same day)
1. **go2rtc keyframe replay: confirmed impossible in v1.9.14.** RTSP consumers
   always wait for the camera's next IDR (`pkg/rtsp/consumer.go` has no
   keyframe sync; preload only warms the producer). The GOP-cache PR
   [AlexxIT/go2rtc#1887] (`#gop=1` per stream) would eliminate the wait but is
   open/unmerged ("doubt" label). **We are at the achievable start-time floor**
   (camera gop=1 + preload + 0.2s analysis): ~0.6-1.3s. WATCH #1887 — when it
   merges, one config line shaves the remaining ~0.5s avg.
2. **Bitrate-overshoot upgrade-suppression: plausible, unconfirmed upstream.**
   No direct issue report, but consistent with RTCP-driven congestion logic;
   132k is documented as iOS's low-bandwidth profile ask. The hi-res-only
   ladder sidesteps the upgrade path entirely, BUT the research flagged the
   relay risk hard: remote sessions + Apple Watch negotiate low bitrates, and
   flooring them through the hub would hurt. **Mitigation shipped: installer
   now passes ARGUS_* envs into the plist and the daemon runs with
   `ARGUS_HUB_ADDRESSES=10.0.0.15`** — hub-relayed sessions obey Apple's ask,
   LAN sessions keep the floors.
3. **Apple Watch on hi-res-only ladder is the open compat question** (HAP
   examples advertise 320x240 "for Watch"; no reliable community data either
   way). Watch sessions ride the relay → they'll obey the negotiated bitrate;
   if the Watch refuses 720p-only entirely, `ARGUS_LIVE_LADDER=compat` + c#
   bump is the rollback.

## Round 5 (same day) — intra-refresh + audio healing + starved-session downscale
Peter's post-force-quit report decoded: his sessions were STILL 640x360 — the
phone/hub serve streaming params from their CACHED accessory DB; a force-quit
doesn't flush it (c#=8 is in mDNS but homed lags). **The flush is rebooting
the Apple TV hub.** Meanwhile his symptoms (WiFi: periodic "sharpen" pulse +
audio freezing every few seconds; cellular at obeyed 132k: pulsating mush, no
audio) are all keyframe-burst pathologies — so fixed at the encoder:
- **x264 intra-refresh replaces periodic IDRs** (all transcode tiers): one IDR
  at session start, then refresh columns inside P-frames — flat bitrate, no
  burst to pulse the quality or trample the 20ms Opus packets. Verified
  stream shape: 1 I + 119 P over 4s. Loss recovery = the 1s refresh cycle.
  Rollback: ARGUS_LIVE_INTRA=0 (periodic IDRs return).
- **Audio timestamp healing**: `-af aresample=async=1:first_pts=0` — Reolink
  RTSP audio timing is jittery; gaps were becoming audible freezes.
- **Starved-session downscale**: relay-obeyed sessions (<800k at ≥720p) encode
  854x480 inside the negotiated box — fewer pixels per bit beats pulsating
  720p at 132k. Controllers accept smaller-than-negotiated (fit-within
  precedent).
- Bench post-change: 720p 0.87s avg start, sustained flow + steady audio. 53
  tests green. c# stays 8 (no advertised-config change).

## RESOLUTION (2026-06-12 evening) — re-pair is the only controller flush
Empirical ladder, all measured on Peter's devices:
- c# bump alone (7→8): phone ignored for 12h.
- Apple TV (hub) restart: flushed the APPLE TV (it grid-streamed six cameras
  at 1280x720 at 21:06Z — first wild proof of the hi-res ladder) but NOT the
  phone.
- App force-quit: nothing. iPhone reboot: nothing. FirmwareRevision 1.1.0 +
  c#9: nothing — the phone kept requesting the long-removed 640x360@132k.
- **Remove + re-pair (Garage Door, ~1 min): immediate.** First session
  21:53Z: 1280x720 asked=299k serving=3500k source=main. The iPhone's
  per-accessory camera stream profile lives in the home's iCloud config
  record and is rebuilt ONLY at pairing.
Remaining: Peter re-pairs the other 6 at his leisure (codes 123-45-678,
re-enable Stream & Allow Recording each). The doorbell will need ONE more
re-pair when the Doorbell service (execution order #4) lands — sequence that
slice before any future fleet-wide re-pair event.

Also fixed this session: ~/code → ~/Projects symlink move broke the daemon's
main-module guard (silent exit-0 loop, ~10 min outage) — realpath compare now.
