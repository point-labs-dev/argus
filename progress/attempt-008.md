# Attempt 008 — AAC-ELD live audio: the research-backed fix for the ≥720p audio-gates-video hang (2026-06-19)

Picks up the parked state from attempt-007 (the direct-WiFi 720p hang where
**audio gates video**). A `/last30days` + web research sweep on 2026-06-19
turned the open question ("WHAT about our audio trips iOS's ≥720p lip-sync
gate") into a concrete, externally-corroborated hypothesis and a staged fix.
This file is the plan + implementation log; the fix is wired behind a flag and
default-OFF, awaiting one prerequisite (an ELD-capable ffmpeg) and Peter's
on-device test.

## What the research established (2026-06-19)

Sources: `/last30days` engine (r/Scrypted, r/HomeKit, GitHub) + targeted web
(go2rtc docs, go2rtc/home-assistant/scrypted issue trackers, Apple dev forums).
Raw saved at `~/Documents/Last30Days/reolink-cameras-in-apple-homekit-live-video-reliability-and-audio-sync-raw-v3.md`.

1. **"Audio gates ≥720p video" is an iOS-WIDE behavior, not an Argus bug.**
   home-assistant/core #127790 ("Camera Stream Issues in HomeKit with Audio
   Enabled"): with audio on, the stream "either doesn't work at all or
   stutters"; the standing community workaround is to disable audio. Apple dev
   forums #807818: an iOS/iPadOS 26 decode bug where MP4 "video image frozen,
   audio goes on." This independently reproduces attempt-007's two findings
   (audio gates video; video-only renders).

2. **The codec is the prime suspect, and it has a name: AAC-ELD.** go2rtc's
   HomeKit docs: "HomeKit audio uses a very non-standard AAC-ELD codec with very
   non-standard params and specification violations." go2rtc issues #1829/#1401/
   #667 trace choppy/dead HomeKit audio to AAC↔Opus transcoding + timestamp
   drift: "watching direct from go2rtc the sound is flawless, exported to
   HomeKit it's choppy." **Argus feeds Apple Opus@24kHz. Every mature bridge
   (go2rtc native HomeKit, Scrypted, homebridge-camera-ffmpeg) feeds AAC-ELD@16kHz
   instead.** This is the single highest-signal lead in the sweep and matches
   attempt-007's own step-5 note (try AAC-ELD).

3. **Scrypted's reliability comes from a per-destination quality ladder +
   prebuffer.** Scrypted serves High (LAN HomeKit) / Medium (cellular) / Low
   (Apple Watch), and its prebuffer holds persistent connections + a recent-video
   buffer for instant HKSV replay AND faster live start. This is the documented
   answer to attempt-007's open Apple-Watch-on-hi-res-ladder question — relay/
   Watch differ because reliable setups serve them different rungs ON PURPOSE.
   (Follow-on slice; see "Not done this attempt".)

4. **Reolink specifics:** RTMP > RTSP for stability on Reolink; H.264-native
   strongly preferred for the live path (lines up with our H.265-main / NVR-HEVC
   pain). Reolink→go2rtc→Scrypted→HomeKit is the community-standard pipeline.

## The blocker found this attempt: this machine's ffmpeg CANNOT encode AAC-ELD

Empirically verified 2026-06-19 on the dev MacBook (ffmpeg 8.0.1, Homebrew):
- **No `libfdk_aac`** — Homebrew's default ffmpeg drops it (license). libfdk is
  the encoder homebridge-camera-ffmpeg uses for ELD.
- **`aac_at` (Apple AudioToolbox) is present but rejects the ELD profile** —
  `-c:a aac_at -profile:a aac_eld` → "Undefined constant ... 'aac_eld' ... Error
  setting option profile". Its only AVOptions are `aac_at_mode`/`aac_at_quality`;
  no ELD profile selector in this build.
- **Native `aac`** does not do ELD at all.

So AAC-ELD requires a libfdk_aac-enabled ffmpeg. How the ecosystem solves it:
go2rtc ships its own in-process Go AAC-ELD encoder (that's why "direct from
go2rtc" works); homebridge ships a prebuilt `ffmpeg-for-homebridge` static
binary with libfdk_aac. Argus uses ffmpeg for transcode, so it needs one of:
- `ffmpeg-for-homebridge` (prebuilt static, easiest), OR
- a brew tap build (`brew install homebrew-ffmpeg/ffmpeg/ffmpeg --with-fdk-aac`), OR
- build ffmpeg from source `--enable-libfdk-aac --enable-nonfree`.

## What was implemented this attempt (flag-gated, default OFF, tests green)

All in `src/homekit.ts`; 4 small edits + 4 tests (56 pass, build clean). Nothing
changes until BOTH `ARGUS_LIVE_AAC_ELD=1` is set AND `ARGUS_FFMPEG` points at a
libfdk build — the running daemon is byte-identical today.

1. **`LiveFfmpegInput.audio.audioCodec?: "opus" | "aac_eld"`** — optional, defaults
   to opus (back-compat; existing tests untouched).
2. **`buildLiveFfmpegArgs` audio block branches** — `aac_eld` emits
   `-c:a libfdk_aac -profile:a aac_eld -flags +global_header` (homebridge-camera-
   ffmpeg's proven args); opus keeps `libopus -application lowdelay
   -frame_duration 20`. The synthetic audio clock (`asetpts=N/SR/TB`) stays on
   both legs — it heals Reolink RTSP wobble regardless of codec.
3. **Call site derives `audioCodec` from the NEGOTIATED `request.audio.codec`** —
   the builder always encodes exactly what the controller asked for, even if a
   client picks the other codec.
4. **Advertisement gated by `ARGUS_LIVE_AAC_ELD=1`** — advertises
   `AAC_ELD@KHZ_16` instead of `OPUS@KHZ_24` (HomeKit's ELD is 16kHz mono; the
   negotiated sample rate then flows through `request.audio.sample_rate`
   automatically).
5. **`ARGUS_FFMPEG` env** — `ffmpegPath` now defaults to
   `options.ffmpegPath ?? process.env.ARGUS_FFMPEG ?? "ffmpeg"`, so a libfdk
   binary can be used without replacing the system ffmpeg or editing code.

## Prerequisite before any on-device test (Peter, one-time)

1. Get a libfdk_aac ffmpeg. Fastest: `npm i -g ffmpeg-for-homebridge` (or grab
   its binary) and note the path; or `brew install homebrew-ffmpeg/ffmpeg/ffmpeg
   --with-fdk-aac`.
2. Verify: `<that-ffmpeg> -hide_banner -encoders | grep libfdk_aac` shows the
   encoder, and `<that-ffmpeg> -f lavfi -i sine=r=16000 -c:a libfdk_aac
   -profile:a aac_eld -ar 16000 -ac 1 -t1 -f null -` exits 0.

## Install log (2026-06-19) — prerequisite DONE, blocker cleared

- Installed `ffmpeg-for-homebridge` standalone at `~/.local/lib/ffmpeg-for-homebridge`;
  binary symlinked to **`~/.local/bin/ffmpeg-homebridge`** (ffmpeg 8.0-homebridge-darwin-arm64,
  ships `libfdk_aac`).
- **AAC-ELD encode VERIFIED** on that binary: `libfdk_aac -profile:a aac_eld -ar 16000
  -ac 1 -b:a 24k` → exit 0, real `aac (ELD) 16000 Hz mono 24 kb/s` packets (RTP muxer too).
- **GOTCHA (do not remove `-b:a`):** ELD with libfdk REQUIRES an explicit bitrate.
  VBR / no `-b:a` fails with `Terminating thread with return code -22 (Invalid argument)`.
  The builder already emits `-b:a ${maxBitrateKbps}k` from the negotiated ask, so this
  is fine — just never "simplify" it away.
- `scripts/install-launchd.sh` env forward-list was stale; added `ARGUS_FFMPEG`,
  `ARGUS_LIVE_AAC_ELD`, `ARGUS_LIVE_MAIN_SOURCE`, `ARGUS_LIVE_INTRA`.
- Daemon reinstalled with `ARGUS_FFMPEG=~/.local/bin/ffmpeg-homebridge` (existing
  `ARGUS_HUB_ADDRESSES=10.0.0.15` + `ARGUS_LIVE_LADDER=compat` preserved).
  **`ARGUS_LIVE_AAC_ELD` left OFF** — daemon still serves Opus, now via the libfdk
  binary (identical output). Note: `launchctl bootstrap` threw a transient
  `5: Input/output error` immediately after bootout; a second bootout+bootstrap
  succeeded (pid healthy, all 7 cameras published). If it recurs, just re-run.
- So the ONLY remaining steps for the on-device test are: flip `ARGUS_LIVE_AAC_ELD=1`,
  bump `ARGUS_FIRMWARE_REVISION`, reboot the hub, test Garage Door.

**FLIPPED (2026-06-19, same session):** `ARGUS_FIRMWARE_REVISION` 1.1.0 → **1.2.0**;
daemon reinstalled with `ARGUS_LIVE_AAC_ELD=1` (pid healthy, env verified, all 7
published). The daemon now ADVERTISES AAC-ELD@16kHz fleet-wide and will spawn the
libfdk binary for the next live session. **Blast radius is fleet-wide** (the flag
is a process env, not per-camera) — the 6 cameras still on cached 640x360 will also
move to AAC-ELD once their controllers refresh. **Remaining: Peter reboots the
Apple TV hub** (the only thing that flushes the controller streaming-config cache;
a firmware bump alone did NOT force a re-read in attempt-007's measurements), then
tests Garage Door (≥10-min cooldown). **Rollback if audio regresses:** reinstall
without `ARGUS_LIVE_AAC_ELD` (bump firmware again) — back to Opus instantly.

## Next-session protocol (resume here)

1. Set `ARGUS_FFMPEG=<libfdk-ffmpeg>` and `ARGUS_LIVE_AAC_ELD=1` in the launchd
   plist envs (installer already forwards ARGUS_*). Stop daemon, bump
   `configVersion` / `ARGUS_FIRMWARE_REVISION` (currently 1.1.0) so iOS re-reads
   the codec advert, restart.
2. **Garage Door ONLY first** (the only re-paired camera; the other six stay on
   the stable cached 640x360 profile — do NOT re-pair them until this is proven).
3. Honor attempt-007's iOS PENALTY WINDOW: ≥10 min cool-down between on-device
   attempts; a hub (Apple TV) reboot is what actually flushes the controller
   streaming-config cache.
4. Watch `logs/serve.err.log` for `audio: codec=AAC-eld 16kHz` on the negotiated
   line and a sustained ffmpeg (no early STOP). Then the real test: does a
   720p+audio session RENDER on the iPhone (vs the attempt-007 hang)?
5. If ELD renders 720p+audio: re-pair the fleet onto the ELD profile and retire
   the parked sub-source/video-only workarounds. If it still hangs: audio is not
   the sole gate — fall back to the offline A/V-drift validator path (attempt-007
   step 1-3) and the per-destination ladder (below).

## Not done this attempt (deliberately scoped out)

- **Per-destination quality ladder** (High LAN / Medium cellular / Low Watch) —
  the Scrypted-proven reliability pattern and the answer to the Watch-compat
  question. Bigger change; do after the ELD codec result is known.
- **Persistent prebuffer for faster start / instant HKSV replay** — go2rtc warm
  producers are the partial equivalent already; a true prebuffer is a follow-on.
- **Installing the libfdk ffmpeg / restarting the daemon / on-device test** —
  needs Peter's hardware + the ≥10-min-cooldown protocol; left staged.
- **Architectural option** (logged for the Mini-deploy decision, item 5): the
  whole ecosystem assumes go2rtc or Scrypted OWNS the HomeKit audio/AAC-ELD path,
  whereas Argus hand-rolls it in HAP-NodeJS. The ELD swap (move #1, this attempt)
  is the small reversible step; letting go2rtc's native HomeKit server own audio
  is the larger alternative if ELD-via-ffmpeg proves fiddly.
