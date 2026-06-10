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

## Peter's call + "treat docs as legacy" research pass (2026-06-10)
Peter: the NVR still exists (may need a reset); treat the existing impl/docs as
legacy and verify we're on the most up-to-date implementation before building more.

Research verdict (web + this hardware) — see LEARNINGS.md 2026-06-10 section:
- **Architecture still current, keep it:** go2rtc (latest v1.9.14, 2026-01-19, I'm
  on it) + HAP-NodeJS for HKSV + standalone accessories. Frigate STILL has no
  native HKSV (live-only via go2rtc's HAP server), so Argus's niche is intact.
  Incumbent to beat is still Scrypted (HKSV plugin now $19 one-time).
- **Implementation details to rework (verified on the RLC-812A):** go2rtc URL
  generation is the main legacy gap. 4K H.265 main works over **RTSP
  `h265Preview_01_main`**, NOT bare FLV and NOT even the community
  `ffmpeg:`-prefixed FLV (both failed here). Sub is fine over bare FLV. RTSP path
  style is per-device (NVR `Preview_0N` vs standalone `h264/h265Preview_0N`).
  → Rework `go2rtc.ts` into a per-device/per-codec source strategy.

Next attempt should START by reworking `go2rtc.ts` URL generation (+ tests) against
this evidence, THEN resume the recorder slice once Peter settles the NVR reset/topology.

## Topology resolved — fleet is hybrid (2026-06-10, post-NVR-reset, authorized sweep)
The old "NVR fronts all cameras" model is dead. Two device classes coexist (Peter's
specific IP/name map lives in private memory, not here):
- **Standalone cameras** — each on its own IP, `channel 0`. Includes newer 4K/H.265
  models (RLC-812A) and older H.264 models (RLC-520A), plus a standalone PoE doorbell.
- **NVR-fronted cameras** — reached via the NVR host on channels N (older D-series
  cams that don't serve their own IP).

Verified URL rule across the whole fleet (RLC-812A, RLC-520A, doorbell, NVR):
- **Always emit codec-prefixed RTSP** (`h264Preview_0N_sub`, `h264/h265Preview_0N_main`).
  It works everywhere. The **bare** `Preview_0N_*` form is the trap — 404s on the
  RLC-812A even though it works on the RLC-520A and the NVR. Codec-prefixed is the
  strictly-safer universal default.
- Channel numbering: FLV 0-based (`channelN`), RTSP 1-based (`Preview_0{N+1}`).
- H.265 4K main → RTSP only (FLV main fails). H.264 sub → bare FLV is fine.

→ `go2rtc.ts` rework: take a per-camera `{ kind: "standalone" | "nvr-channel", host,
channel, mainCodec }` and generate codec-prefixed RTSP for main + FLV-sub, with the
NVR cases pointed at the NVR host. The doorbell is a standalone camera that also needs
the HomeKit Doorbell service later (feature #9).
