# Attempt 010 — Home live verifier and video-only diagnostic cleanup (2026-06-21)

Goal: stop relying on hand verification in the Home app and make Garage Door live
tests reproducible from the repo.

## Changes

- Added `npm run verify:home`, backed by `scripts/verify-home-live.mjs`.
  - Activates Home, clicks the Garage Door tile, captures before/during/after
    screenshots, and slices new Garage Door stream lines out of
    `logs/serve.err.log`.
  - Reports structured JSON: screenshot paths, click coordinates, negotiated
    stream, whether Argus disabled audio, whether FFmpeg actually sent an audio
    leg, AAC-ELD detection, exit line, and session duration.
  - Detects the macOS lock screen/loginwindow case explicitly and fails early
    instead of producing misleading black/irrelevant captures.
- Added `ARGUS_SRTP_LOOPBACK=0` as a launchd-pass-through diagnostic switch.
  Default behavior still rewrites self-addressed local Home viewers to loopback;
  `0` leaves the controller-requested LAN address untouched.
- Live negotiation logs now include both `controller=<requested>` and
  `target=<actual>`, so loopback vs requested-address runs are unambiguous.
- Fixed `ARGUS_AUDIO=0` to be a real HAP video-only diagnostic:
  - no advertised microphone/audio service in `buildCameraControllerOptions`
  - no `PrepareStreamResponse.audio`
  - no FFmpeg `-c:a`/audio SRTP output leg
- Added unit coverage for requested-address diagnostics and video-only
  PrepareStream/FFmpeg shape. Build passes; test suite is 59/59 green.

## Live findings

- AAC-ELD with default local loopback target still failed in Home:
  `target=127.0.0.1`, AAC-ELD 16kHz, Home viewer reached the live UI but stayed
  spinner/No Response, FFmpeg was killed at Home's timeout.
- AAC-ELD with `ARGUS_SRTP_LOOPBACK=0` also failed:
  `controller=10.0.0.46 target=10.0.0.46`, same spinner/No Response pattern.
  That makes the loopback rewrite unlikely to be the primary remaining live
  failure.
- The earlier video-only attempt at `c#=11` was not a clean isolation: FFmpeg had
  no audio leg, but Argus still returned an audio endpoint in PrepareStream and
  Home killed the session after ~0.5s.
- After the cleanup, the diagnostic profile advanced to `c#=12` and should be
  re-tested with:

  `ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/peterpine/.local/bin/ffmpeg-homebridge ARGUS_HAP_BIND=en0 ARGUS_AUDIO=0 bash scripts/install-launchd.sh`

  then, after the Home cooldown:

  `npm run verify:home -- --hold-seconds 35`

## Current blocker

The verifier now works when the Mac GUI is unlocked, but the latest run stopped
before clicking Home because the foreground click hit `loginwindow`. That is a
machine-state blocker, not an Argus stream result. Unlock the Mac and leave Home
visible before rerunning the verifier.

## Restore normal AAC-ELD mode

After diagnostics, restore the intended Garage Door profile with:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/peterpine/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_HAP_BIND=en0 bash scripts/install-launchd.sh`

If launchd returns the transient `Bootstrap failed: 5: Input/output error`, run
the same command a second time.
