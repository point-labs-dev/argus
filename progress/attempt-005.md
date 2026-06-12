# Attempt 005 — "Focus hunting / pixelated" fix: grid stills + steady encode (2026-06-12)

Peter's on-device report after round 2: picture "trying to focus" and
"pixelated". His session logs showed ALL sessions at 640x360 (tile tier) — he
was judging the GRID, whose surface was the weak one: 640-wide sub stills +
600k tile streams upscaled on a Retina grid. Plus an encoder smoothness issue
at ≥720p. Both fixed; 50 tests green; deployed.

## What landed

### Grid stills from the MAIN streams (the visible fix)
- HomeKit snapshot requests now serve full-res main-stream JPEGs
  (2560x1920–4512x2512), not the 640-wide sub stills. go2rtc's frame.jpeg
  decodes every main INCLUDING the HEVC ones (verified fleet-wide; occasional
  one-off 500 at an unlucky moment — absorbed by the cache, which keeps
  serving the last good frame).
- Poll: `startPolling(10s, ["main"])`. The loop is sequential (one decode at a
  time), a 7-camera sweep takes ~5–8s → each tile refreshes ~15s, matching
  Apple's own grid cadence. go2rtc CPU unchanged (~15%).
- The delegate option is renamed honestly: `liveProfile` → `snapshotProfile`
  (it only ever fed snapshots).

### Steady ≥720p encode (the "focus hunting" fix)
- **Reverted h264_videotoolbox ENCODE same-day**: its -realtime rate control
  visibly pulses at 2.5–4Mbps (sharp at each IDR, softening between). All
  transcode tiers now use libx264 capped-CRF (`-crf 20 -maxrate <floor>`).
- **IDR cadence 1s → 2s for ≥720p only**: a 720p/1080p IDR eats a big slice of
  each second's budget; at 1s cadence the starved P-frames between IDRs read
  as the sharp→soft→sharp pulse. Tiles keep 1s (cheap, fast loss recovery).
  First frame is an IDR regardless — start time unaffected (it IMPROVED).
- **VT DECODE kept but scoped to ≥720p sessions**: the VT decoder noisily
  rejects pre-IDR packets at session join ("hardware accelerator failed to
  decode picture" bursts, seen live during Peter's grid session); software
  decode of 640-wide subs is free anyway. ≥720p keeps hardware decode for the
  2560x1920–4K (incl. H.265) mains.

### Bench (production args, warm)
| path | first video packet |
|---|---|
| 720p @2500k capped-CRF | **avg 0.73s** (VT was 1.47s, CBR-x264 1.05s) |
| 1080p @4000k capped-CRF | **avg 0.97s** |

Capped-CRF emits first frames faster than CBR (no rate-control warmup) — the
quality fix was also the latest start-time win. Sender-side start is now
sub-second across all tiers.

## The NVR question (Peter asked: do the 3 have to go through it?)
Yes — hardware, not configuration. Front L, Front R, Backyard Right are
Reolink "add-on" (NVR-kit, D-series) cameras: no UID, no direct RTSP/HTTP
network identity (verified 2026-06-10: empty-UID signature + subnet sweep
found no direct IPs). The NVR is irreducibly their source, and its limits are
their ceiling: 896x512 sub @1024k max (probed), keyframe every 4s (gop
stripped), mains 12MP HEVC — so their full-screen is an upscaled 896 and
always ~2–4s slower to start. **The unification path is replacing those 3
with standalone Reolink models (RLC-5xx/8xx class, anything with a UID);**
the NVR can still RECORD them as IP channels afterwards, same as the plan for
the other 4. Until then, expect the front cameras + Backyard Right to look a
tier below the standalone four.

## Watch items
- 4K/12MP main stills every ~15s: bigger HomeKit snapshot payloads (0.5–1.3MB
  JPEG). If the Home app ever balks at payload size, downscale via go2rtc
  frame.jpeg params or sips-style recompress in the cache.
- If Peter still sees softness at FULL-SCREEN on standalone cams after this,
  next knobs: crf 20→18, 720p floor 2500→3500k, `-preset veryfast→faster`
  (in that order; all cheap to try once there's a confirmed full-screen
  session in the logs to judge against).
