# Attempt 004 — Quality round 2: serve real bits + hardware codec (2026-06-12)

Trigger: Peter's iPhone verdict on 1b ("faster and better quality") + his ask for
more. His session logs supplied the smoking gun: **Apple negotiates starvation
bitrates — 1280x720 at 299kbps, 1920x1080 at 802kbps — and we were obeying.**
The ladder/main-sourcing worked exactly as designed (720p sessions, a 1080p
RECONFIGURE, doorbell sourced from main), so bits were the remaining ceiling.

50 tests green. Deployed via kickstart (no configVersion bump — advertised
config unchanged; only encoder internals and served bitrate).

## What landed

### Bitrate floor policy (`effectiveBitrateKbps`, src/homekit.ts)
- Per-tier floors, never below the ask: **1080p→4000k, 720p→2500k,
  360p+→600k, below→300k.** The standard homebridge/Scrypted move
  (videoBitrate override) — Apple's asks are tuned for worst-case remote links.
- Escape hatches: `ARGUS_LIVE_OBEY_BITRATE=1` (global rollback) and
  `ARGUS_HUB_ADDRESSES=ip[,ip]` (spec-obedient for hub-relayed REMOTE viewers
  whose uplink we can't see — set to 10.0.0.15 if away-from-home viewing ever
  stutters; the controller address is kept pre-loopback-rewrite for this check).
- Logs now show `asked=299k serving=2500k` per session.

### Encoder split (both still within the negotiated envelope)
- **≥720p: `h264_videotoolbox -realtime 1`** (Apple Silicon hardware encoder).
  Verified I/P-frames-only on this machine (90-frame probe: 8 I + 82 P, zero B
  — B-frames break HomeKit). ~Zero CPU at 1080p@4Mbps → headroom for
  concurrent viewers + the Mac mini deploy.
- **<720p: libx264 capped-CRF** (`-crf 20 -maxrate <floor>`) — visibly better
  per bit at low rates than CBR, and easy scenes undershoot the cap.
- **`-hwaccel videotoolbox` on the transcode input** — the ≥720p sources are
  2560x1920–4K (H.265 on Backyard Left); plain -hwaccel silently falls back to
  software when unsupported, so it is strictly headroom.

### Bench (production args through go2rtc, warm, local UDP sink)
| path | first video packet | note |
|---|---|---|
| tile 640x360 @600k (x264-CRF) | **avg 0.65s** | was 0.91s — CRF starts cleaner than CBR |
| 720p @2500k (VT, main) | avg 1.47s | +0.4s vs x264 (VT session init); still ≪2s bar |
| 1080p @4000k (VT, main) | avg 1.20s | ≈ x264 (1.13s) at 5x the bitrate |

If Peter ever feels full-screen start regressed, an `ARGUS_LIVE_SW_ENCODE`
switch back to x264 for ≥720p is a 5-line follow-up — quality at these
bitrates is comparable; VT is about CPU.

## Walls / probes
- **D1200 sub bitrate ceiling = 1024k** (2048 → `param error` rspCode -4,
  probed via tuner). The 896-wide sub is the NVR channels' full-screen source,
  so their ceiling stands: 896 upscale @1024k, ~2-4s starts (4s GOP). The real
  fix remains replacing the 3 add-on cams with standalone models.
- go2rtc idle: ~17% CPU with all 14 producers warm; node ~2%. Fine here and
  for the Mini.

## Next quality/speed ideas if Peter still wants more (descending value)
1. Snapshots from MAIN on standalone cams (grid stills 2560-wide vs 640 — the
   one visible regression from 1b's fluent swap; needs HEVC-snapshot check for
   go2rtc frame.jpeg before including Backyard Left).
2. Full zero-copy VT pipeline (`-hwaccel_output_format videotoolbox` +
   `scale_vt`) — Mini-deploy optimization, shaves decode→encode copies.
3. go2rtc buffered-keyframe replay research (would cut the ~0.5s avg keyframe
   wait — the remaining start-time floor).
4. Copy mode on iPhone — now plausibly DEAD: no camera profile matches an
   Apple-ladder size exactly (mains 2560x1920+, subs 640, ext 896), and
   oversize copy is what controllers kill. Transcode-with-floors is the path.
