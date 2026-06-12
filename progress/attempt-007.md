# Attempt 007 — The direct-WiFi 720p hang: evidence matrix + parked state (2026-06-12 night)

After the Garage Door re-pair proved the hi-res ladder (1280x720 negotiated,
served from main), Peter's direct-WiFi sessions mostly HUNG (spinner → iOS
gives up at ~30s → repeated failures escalate to "Camera Not Responding").
Six systematic fixes did not change it. This file is the canonical evidence
matrix so nobody re-walks this maze.

## What rendered on Peter's iPhone (direct WiFi unless noted)

| time | config | outcome |
|---|---|---|
| all day | 640x360@600k, SUB video, raw audio, 1s IDR | stable for hours (the morning config) |
| 21:53–21:58Z | 720p@3500k MAIN, intra-refresh, rebased audio | ONE "really good" session |
| 23:39Z | 720p@299k, MAIN, **video-only** (ARGUS_AUDIO=0) | rendered, watched 58s |
| 23:42Z | 720p@2000k MAIN, async-audio (no rebase) | rendered ~1min, then picture died mid-stream |
| evening | RELAY (cellular): 854x480-in-720p@299k | rendered repeatedly, audio SILENT |
| 21:06Z | Apple TV grid: six cameras 720p simultaneously | rendered (its own reboot refreshed its cache) |

## What hung (all direct WiFi, all ~30s teardown or instant)

Every other 720p attempt, across ALL of: bitrate 3500k / 2000k / 299k
(spec-obedient); pkt_size 1378 / 564; periodic IDR / intra-refresh; audio
rebased / async-only / raw; MAIN / SUB source. Notably the last several
"hangs" (raw-audio, then sub-source) were tested in a RAPID-RETRY STORM —
see the penalty-window finding below, which may invalidate them.

## Eliminated with hard evidence
- **Negotiation/pairing**: every session negotiated 720p correctly post-re-pair.
- **Payload validity**: `scripts/validate-live-decode.mjs` (built tonight)
  decodes the exact production SRTP stream at 29fps, zero errors, all tiers.
- **Delivery**: during a "hanging" session the phone SENT RTCP receiver
  reports back (nettop: inbound bytes on the RTCP socket) — it receives our
  stream and answers, then refuses to render.
- **Routes** (en0 to both phone and hub), **CPU** (15%, 4 encoders), **VT
  decoder pool** (removed from live path entirely after it zero-framed a real
  session — finite session pool, no mid-stream software fallback).
- **Bitrate overshoot**: spec-obedient 299k sessions hung identically.

## The two load-bearing positive findings
1. **AUDIO GATES VIDEO.** Video-only rendered immediately when everything
   with audio hung (and relay sessions render with SILENT audio — the hub
   drops what it can't sync). iOS's lip-sync gate is the mechanism; WHAT
   exactly about our audio/clock relationship trips it at 720p but not at
   the morning 640x360 sessions is THE open question. The rebase
   (`first_pts=0`) provably created a permanent offset (its own bug); plain
   `async=1` died mid-stream ~1min; raw audio hung in the retry storm
   (possibly invalid test).
2. **iOS PENALTY WINDOW.** Renders happened after quiet periods; rapid
   retries after a failure hang REGARDLESS of config, and force-quit does
   not clear it. Any on-device A/B needs ≥10min cool-down between failures
   or it tests the penalty state, not the config.

## Parked state (deployed @ `b559f7e`)
- Live = SUB-sourced at all sizes, 2000k@720p capped-CRF, raw audio, 564-pkt
  hi-res, periodic IDRs, hi-res ladder (c#=9). Grid stills = full-res mains.
- Main-source live is behind `ARGUS_LIVE_MAIN_SOURCE=1`.
- Spec-obedient bitrate behind `ARGUS_LIVE_OBEY_BITRATE=1`;
  `ARGUS_HUB_ADDRESSES=10.0.0.15` active (relay obeys asks).
- Garage Door is the only re-paired camera; the other six stay on the cached
  640x360 profile (STABLE for them) until this is solved — do NOT re-pair
  them into the unsolved state.

## Next session protocol (no Peter taps until instrumented)
1. Long-run A/V validator soak (running as this is written): decode video
   AND audio legs for 10min, watch for drift/stall — reproduces the
   mid-stream death offline if it's stream-borne.
2. Extend validator to AUDIO decode + A/V timestamp delta tracking (the
   lip-sync gate's view). Compare sub vs main sources over minutes.
3. If drift confirmed: fix at source (RTSP-ingest mains; or video=main +
   audio=sub dual-input; or server-side audio re-clocking against wall time).
4. Only then ONE on-device tap per candidate, ≥10min apart.
5. Consider AAC-ELD instead of Opus (Apple's preferred camera audio codec;
   needs ffmpeg libfdk_aac — check the installed build) if Opus timing is
   implicated.
