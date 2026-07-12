# Attempt 014 - Bounded child logging + NVR codec-lock watchdog (2026-07-12)

Goal: stop Argus from ever refilling a disk with ffmpeg stderr (the Mini's
`serve.err.log` hit 42 GB on 2026-07-12 and took the disk to 100%), and fix
the real source of the flood — which turned out to be broken Front L/R HKSV
recording, not the known mid-GOP join spew.

## Root-cause chain (all measured on the Mini)

1. The 42 GB was NOT mostly mid-GOP join noise. A clean HKSV join of the
   honest h265 main (Backyard Left) produces only ~12 stderr lines;
   `-fflags +discardcorrupt` changes nothing (A/B tested, 12 lines both ways).
2. The flood came from Front L: every HKSV session decode-errored on EVERY
   packet (`Error submitting packet to decoder: Invalid data`) at ~1,600
   lines/sec with ZERO decodable frames — ffmpeg's `-t` never advances, the
   session hangs until the hub gives up, the hub retries, repeat.
3. Why: the NVR's RTSP SDP lies. `h264Preview_03/04_main` declare
   `a=rtpmap:96 H264/90000` but the fmtp carries **HEVC** sprop-vps/sps/pps
   (VPS does not exist in H264). `h265Preview_*` still 404s (re-probed).
   Payload is HEVC; consumers that trust the SDP depacketize garbage at the
   RTP layer — forcing the ffmpeg *decoder* (`-c:v hevc`) cannot fix it.
4. go2rtc v1.9.14 sometimes detects the real codec from the bitstream and
   serves consumers a corrected (H265) track — and sometimes locks in the SDP
   lie. Observed live: front-r served `hevc,4512,2512` before an argus
   restart and h264-garbage after it; front-l was locked wrong all day.
   Detection is a per-producer-start coin flip, sticky until the next
   producer start. Consumer-side `?video=h265` 404s against a mislocked
   producer (go2rtc filters by its locked codec), so no query bypasses it.
5. Upstream: GOP cache / keyframe replay (AlexxIT/go2rtc#1887) is still an
   OPEN PR; 1.9.14 (2026-01-19) is still the latest release. No source-side
   codec override exists for RTSP sources.

## Changes

- `src/child-log.ts` (new): `createStderrBudget` — line-oriented bounded
  forwarding of child stderr; first N lines pass through, the rest are
  counted; `summary()` reports the suppressed count. Splitting per line also
  fixes the old unprefixed continuation-line problem.
- `src/recording.ts`: HKSV ffmpeg stderr budgeted at 20 lines/session,
  verbose default now **false** (`ARGUS_HKSV_VERBOSE=1` restores the
  firehose + arg dump). Every session now logs a timestamped start line
  (resolution + source) and an exit line (code/signal + duration + suppressed
  count) — the 42 GB log had neither timestamps nor exits, which made the
  incident hard to attribute.
- `src/homekit.ts`: live-session ffmpeg stderr budgeted at 40 lines/session
  (`ARGUS_LIVE_FFMPEG_VERBOSE=1` restores). Lifecycle logLine forensics
  (negotiation, exit) unchanged — the verifier scripts' grep contracts hold.
- `src/codec-watchdog.ts` (new) + `src/serve.ts`: before accessories publish,
  read go2rtc's DETECTED receiver codec for every NVR-fronted h265 main via
  `/api/streams` (producer `medias` just echo the lying SDP; `receivers`
  carry the detected codec) and restart go2rtc until all detect hevc. Max 3
  restarts, loud give-up, `undefined` info never restarts (an offline NVR
  must not crashloop boot). `ARGUS_CODEC_WATCHDOG=0` disables.

## Verification

- `npm run build` green; `npm test` green: 10 files, 98 tests (7 new
  child-log, 2 new recording-delegate, 6 new codec-watchdog).
- Deployed to the Mini (dist rsync; rollback copy at
  `~/Projects/argus/dist.bak-20260712`), `launchctl kickstart`.
- Watchdog fired on real hardware at first boot: caught front-l AND front-r
  mislocked as h264 and re-rolled go2rtc 3 times — ALL FOUR boot-time producer
  starts locked wrong, so boot-time preload seems biased to the SDP lie (the
  morning's correct front-r lock likely came from an on-demand,
  consumer-attached producer start; per-stream API re-add + consumer did NOT
  reproduce it). Hence the sub-stream fallback commit: when the watchdog gives
  up, HKSV for the mislocked cameras records from the honest h264 sub restream
  (896-wide, upscaled by the recorder to the negotiated frame) instead of
  recording nothing.
- Bounded HKSV logging verified in unit tests (500-line burst → exactly 20
  forwarded + summary); on-hardware session receipts accumulate in the new
  timestamped format.
- Ops guard independent of this code: hourly logrotate LaunchAgent on the
  Mini (`dev.point-labs.argus-logrotate`, >500 MB truncate, keep 50 MB).

## Open

- 24 h soak: serve.err.log growth should be ≤~10 MB/day; check
  `ls -lh ~/Projects/argus/logs/` and the rotate self-log tomorrow.
- Peter co-check: Front L / Front R HKSV clips actually appearing in the Home
  timeline again (they have likely been missing since ~the Mini deploy),
  now sub-sourced at 896-wide until go2rtc detection heals.
- Getting the MAINS back for the fronts (in preference order):
  1. NVR firmware update — a fixed SDP removes the whole class.
  2. go2rtc upgrade once AlexxIT/go2rtc#1887 (GOP cache) or a codec-override
     lands upstream; 1.9.14 (2026-01-19) is still latest as of today.
  3. Deeper study of when go2rtc's bitstream detection wins (the morning's
     front-r=hevc lock happened somehow) — maybe a mid-consumption NVR
     reconnect; could be forced by dropping the NVR TCP connection while a
     consumer is attached.
- The Home-grid MAIN snapshots for the fronts (SnapshotCache polls
  frame.jpeg on mains) may also be degraded while mislocked — go2rtc can't
  decode a JPEG from a track it mislabeled. Nobody has verified front tiles
  lately; check the grid stills after detection heals.
