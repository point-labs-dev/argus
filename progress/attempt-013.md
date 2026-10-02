# Attempt 013 - Preserve HKSV recording aspect ratio (2026-06-23)

Goal: fix weird-looking HKSV recordings caused by stretching camera mains into
HomeKit's negotiated recording frame.

## Change

- Updated `buildRecordingFfmpegArgs` so HKSV recordings use:

  ```text
  scale=<w>:<h>:force_original_aspect_ratio=decrease:force_divisible_by=2,
  pad=<w>:<h>:(ow-iw)/2:(oh-ih)/2,
  setsar=1
  ```

- Live view was left unchanged. The live path still uses the stable per-camera
  `854x480` fit-only profile.

## Why

Several Reolink mains are 4:3. The previous recording filter used plain
`scale=<w>:<h>`, so a 4:3 source could be stretched into 16:9 HKSV clips. The
new filter preserves all source pixels and fits them inside HomeKit's selected
recording frame without distortion.

## Verification

- Local `npm run build` passed.
- Local `npm test` passed: 8 files, 81 tests.
- Mini `npm run build` passed.
- Mini `npm test` passed: 8 files, 81 tests.
- Mini `dist/recording.js` contains the aspect-preserving filter.
- Mini launchd was restarted and is registered/running as `dev.point-labs.argus`
  with the steady-state env:
  - `ARGUS_HAP_BIND=en0`
  - `ARGUS_HUB_ADDRESSES=10.0.0.15`
  - `ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge`
  - `ARGUS_LIVE_MAIN_SOURCE=1`
  - `ARGUS_LIVE_AAC_ELD=1`
  - `ARGUS_RTCP_MONITOR=1`

## Expected user-facing result

New HKSV clips should no longer look horizontally stretched. A 4:3 camera
recorded into a 16:9 HomeKit envelope may show padding, but it should preserve
the full field of view and match the camera geometry.
