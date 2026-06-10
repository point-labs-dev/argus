# Attempt 001 — Laptop takeover + spine re-validation (2026-06-10)

First run of the goal on Peter's MacBook (10.0.0.46), continuing from the Mini
workspace state. Synced workspace → GitHub (`2278d7c`), `npm ci`/build/test green
(21 tests), go2rtc v1.9.14 darwin/arm64 downloaded
(sha256 `919b78adc759d6b3883d1e1b2ac915ac0985bb903ff1897b4d228527bd64690c`).

## What worked
- The camera spine works end-to-end against real hardware: config → supervised
  go2rtc → SnapshotCache produced a valid 896×512 JPEG (live backyard image,
  correct timestamp) → local RTSP restream probed `h264,896,512`. `scripts/smoke-spine.mjs`
  added as the repeatable spine check (reads gitignored `argus.yaml`).

## Big finding — hardware topology changed since the memory was written
- **10.0.0.5 is no longer the RLN8-410 NVR.** `GetDevInfo` returns model
  `RLC-812A`, name "Backyard left", `channelNum: 1` — a *standalone* camera.
- The goal prompt + `memory/projects/scrypted-cameras.md` describe an 8-channel
  NVR at 10.0.0.5 fronting all 7 cameras as the single ingest point (because
  standalone cams reportedly wouldn't open streaming ports, 2026-02-28). That
  premise no longer holds for at least this camera: it serves streams directly,
  no NVR proxy, no session-limit concern.
- Did NOT sweep the /24 to rediscover the fleet (out of scope / unauthorized
  credentialed probing). Real current topology is unknown and is Peter's call.

## Reolink stream-URL quirks confirmed on a standalone camera (RLC-812A)
These differ from the NVR and matter for the go2rtc URL builder:
- **RTSP paths are codec-prefixed and 1-based:** `h264Preview_01_sub` (H.264
  640×360) and `h265Preview_01_main` (HEVC 3840×2160) WORK. Bare
  `Preview_01_main` / `Preview_07_main` → **404 Stream Not Found**. Argus
  currently generates the bare `Preview_0N` form (correct for the NVR, wrong for
  standalone cams). → URL builder needs a per-source style (NVR vs standalone)
  or codec-prefix probing.
- **HTTP-FLV is 0-based and works for sub:** `channel0_ext.bcs` → H.264
  896×512 + AAC. `channel0_main.bcs` (4K H.265) **timed out** over FLV — main is
  better pulled via RTSP `h265Preview_01_main`. So "HTTP-FLV-first" holds for
  sub, but main may need RTSP for this model.
- Main stream is **H.265 4K** → confirms HomeKit paths need H.265→H.264 transcode.

## Recommendation for next attempt
Do not build the NVR recorder slice on the NVR-ingest assumption until Peter
confirms the real fleet topology (NVR removed/moved? all cameras now standalone?
mix?). The recorder code is topology-agnostic (records a go2rtc stream), but the
config model, channel numbering, and URL builder decisions depend on the answer.
