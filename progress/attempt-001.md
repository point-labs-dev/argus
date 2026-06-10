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

## go2rtc.ts rework DONE + full-fleet validation (2026-06-10, commit 239e6d3)
Landed the rework. Kept it minimal/honest: the standalone-vs-NVR distinction is
already expressed by `host`+`channel` (standalone = cam IP + ch0; NVR = NVR IP + chN),
so no `kind` field was added — the only NEW config field is `mainCodec` (h264|h265,
default h264), which the verified RTSP-prefix finding actually requires.
- RTSP paths now codec-prefixed (`h264/h265Preview_0N`); H.265 mains go RTSP-only in
  auto mode; subs + H.264 mains keep FLV-first → RTSP fallback. 22 unit tests green.
- **Validated against ALL 7 real cameras** via `scripts/smoke-spine.mjs`: live
  snapshot + clean RTSP sub-restream for each — 4 standalone (Backyard Left H.265,
  Garage Door, Doorbell, Backyard) and 3 NVR-fronted through 10.0.0.13 (Front L ch2→
  Preview_03, Front R ch3→Preview_04, Backyard Right ch6→Preview_07). SMOKE PASSED.

### Recording architecture decided (Peter, 2026-06-10) — Argus recorder DROPPED
Path A: recording/retention = HKSV/iCloud (all 7, Apple One Premier = unlimited HKSV
cams, Home Hub does detection) + the Reolink NVR (continuous, all 7 once the 4
standalone are re-added as NVR IP channels). Argus is the HomeKit BRIDGE only — it does
not build its own NVR recorder. The "unified all-7-direct" topology is blocked by the 3
D-series being Reolink add-on cameras (no UID, can't do RTSP off the NVR) — so it's
unified in software (one per-camera host code path), hybrid in wiring. Goal is detection
quality (replace Reolink's noisy AI with Apple HKSV), not recording.

### HomeKit live-streaming slice DONE (commit 2374cfa)
- `src/homekit.ts`: standalone HAP camera accessory per camera. Snapshots from the warm
  SnapshotCache; live via FFmpeg SRTP from the go2rtc **sub** restream, transcoded to
  H.264 (libx264) + Opus (libopus — avoids AAC-ELD/libfdk). SRTP key/salt advertised to
  the device == the bytes FFmpeg encrypts with.
- `src/serve.ts`: `argus serve` — starts go2rtc + snapshot polling, publishes one
  standalone accessory per camera with pair codes; `.homekit/` pairing store gitignored.
- 27 tests green (+5). Verified: runtime accessory construction; real-camera H.264+Opus
  transcode (~6× realtime). NOT yet verified on-device (needs Peter to pair in Home app).

### Next attempt
1. **On-device pairing** (Peter): `npm run serve` → add each camera in Home app via pair
   code → confirm live view + snapshot. This validates the SRTP path end-to-end.
2. **Motion events** → HAP MotionSensor (Reolink API poll; direct for standalone, via NVR
   for the 3 D-series).
3. **HKSV** — the payoff: prebuffer → IDR-aligned fMP4 (main stream, transcode H.265) →
   HomeKit Data Stream on motion; verify Apple's person/vehicle/animal labels in the Home
   timeline. Confirm a Home Hub (Apple TV/HomePod) is present first.
4. **Doorbell** service for .9. Ops: re-add 4 standalone to NVR; DHCP-reserve; rotate password.
