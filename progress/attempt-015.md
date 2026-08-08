# attempt-015: NVR firmware fix + all cameras on main-stream HKSV

Date: 2026-08-08. Branch `hksv-log-hygiene` (d9b4c4d → 5adc729), deployed to the
Mini via dist rsync. Goal: Peter asked for "the same quality on all the cameras"
after confirming the post-firmware front clips looked good.

## Root-cause chain closed

- 2026-08-08 morning: flashed the Reolink RLN8-410 NVR (10.0.0.13, hardware
  N7MB01) from v3.0.0.211_22102113 (Oct 2022) to v3.6.4.473_26021143 (Feb 2026)
  via the NVR's own chunked HTTP Upgrade API (`UpgradePrepare {restoreCfg:0}` +
  902 × 40960-byte multipart chunks, flow extracted from the NVR web client's
  `accountLogin.*.js`). SHA-256 of the `.paks` verified against
  AT0myks/reolink-fw-archive before upload. Config survived; ~2 min downtime.
- Post-flash the SDP lie is gone: `h264Preview_0X_main` truthfully declares
  `a=rtpmap:96 H265/90000` (fmtp sprop-vps intact) and `h265Preview_*` paths
  exist (previously 404). go2rtc's per-producer-start codec coin flip is
  therefore unexploitable; the codec watchdog has verified
  `front-l=hevc front-r=hevc` with 0 restarts on every boot since.

## Why quality was still uneven after the flash

HKSV for the three h265-main cameras (Front L, Front R, Backyard Left) was
pinned to their subs by `ARGUS_HKSV_FORCE_SUB=h265` in the Mini's launchd
plist — part of a hot-patch applied directly to the deployed `dist/` on
2026-07-20 (author unconfirmed; not in git; see below). Sub sources: fronts
896×512@20 1 Mbps, Backyard Left 640×360@15 512 kbps — upscaled to the
negotiated 1080p envelope. The four h264 cameras already recorded from their
2560×1920 mains. Fleet encoder audit (GetEnc, 2026-08-08):

| Camera | main | sub |
|---|---|---|
| Front L / Front R (D1200, NVR ch2/3) | 4512×2512 @20 8192k h265 | 896×512 @20 1024k h264 |
| Backyard Left (RLC-812A) | 3840×2160 @25 6144k h265 | 640×360 @15 512k |
| Garage Door / Backyard (RLC-520A) | 2560×1920 @30 6144k h264 | 640×480 @15 512k |
| Doorbell (PoE) | 2560×1920 @20 4096k h264 | 640×480 @15 512k |
| Backyard Right (D500, NVR ch6) | 2560×1920 @30 6144k h264 | 640×480 @15 512k |

`buildRecordingFfmpegArgs` always transcodes to libx264, so pointing HKSV at
HEVC mains is purely a source swap — no pipeline change.

## The 2026-07-20 Mini hot-patch (now ported: commit 5adc729)

Three in-place edits to `dist/serve.js`, `dist/go2rtc-supervisor.js`,
`dist/go2rtc.js` existed only on the Mini; any rsync deploy would have erased
them. Ported verbatim into src (my build compiles byte-equivalent modulo
declaration order):

1. `ARGUS_HKSV_FORCE_SUB` — env override ("1"/"all", "h265"/"hevc", or camera
   names) forcing HKSV to the sub restream. Kept as an emergency lever;
   removed from the production plist now that the firmware fix landed
   (plist backup: `dev.point-labs.argus.plist.bak-20260808`).
2. go2rtc.generated.yaml written with mode 0600 (embeds camera creds).
3. go2rtc WebRTC listener bound to 127.0.0.1:8555 (nothing on the LAN).

The same intervention set `ARGUS_LIVE_MAIN_SOURCE=0` in the plist (live views
sub-sourced). Left as-is — out of scope for the clips ask; flipping it back is
a one-line plist change if Peter wants ≥720p live from standalone mains again.

Tests: +2 (webrtc localhost bind, 0600 config mode); suite 100/100 green.

## Verification (production, 2026-08-08)

- Boot after env removal + rebootstrap: watchdog "NVR HEVC mains healthy after
  0 restart(s)", zero "safety fallback" lines, 8 hub connections.
- HKSV sessions since the 12:35Z restart (counted 21:12Z): Backyard Left 72,
  Front L 48, Front R 12, Garage Door 24, Doorbell 10, Backyard 3 — **every
  session sourced from the main restream; zero `-sub` sources**.
- h265-main sessions exit normally (hub-closed SIGKILL after 40–350 s) with
  bounded stderr (75–135 suppressed lines/session — the known mid-GOP HEVC
  join noise, capped by attempt-014's budget).

## Context: the Aug 3–8 HKSV gap

serve.err.log shows zero HKSV sessions 2026-08-03T13:18Z → 2026-08-08. Cause
(per ops/mini): the Aug 3 unattended macOS staged-update reboot left the Mini
at loginwindow for 5 days — all user-session services dead until Peter's
console login on Aug 8. Not an Argus defect; prevention decisions tracked in
ops/mini AGENTS.

## Open items

- 24 h soak of log growth with mains feeding HKSV (expect the per-session
  75–135 suppressed-line summaries, i.e. a few hundred lines/day).
- Peter: co-check clip sharpness in the Home timeline (fronts + Backyard Left
  should be visibly crisper than the sub-era clips).
- Optional: restore `ARGUS_LIVE_MAIN_SOURCE=1` for standalone-camera live
  quality (Peter's call).
- Jul-20 hot-patch author still unconfirmed (Peter? Ceph?) — worth resolving
  so production edits have an owner.
