# attempt-016: interim soak receipts + live views back on standalone mains

Date: 2026-08-08 (~21:30–21:45Z). No code changes — Mini plist flip + receipts
closing attempt-015 open items. Branch `hksv-log-hygiene` @ 40baa46.

## Interim soak (deploy 12:35Z → 21:27Z, ~9 h)

- `serve.err.log` growth since deploy: **~325 KB** (≈0.85 MB/day extrapolated)
  vs DoD budget ≤10 MB/day and the incident's 10–14 GB/day. Logrotate guard
  self-log silent.
- **171 HKSV sessions**, all main-sourced (BL 72, FL 48, GD 26, FR 12, DB 10,
  BY 3) — zero `-sub` sources, zero safety fallbacks, zero watchdog restarts.
- 109 bounded stderr summaries (`suppressed N lines`) — limiter working as
  designed.
- Note: the `safety fallback` lines visible earlier in the log all predate the
  12:35Z deploy (boots while `ARGUS_HKSV_FORCE_SUB=h265` was still in the
  plist). No post-deploy fallbacks.
- 24 h checkpoint lands ~2026-08-09T12:35Z; re-measure growth then.

## Live views: standalone cameras back on mains

Peter approved flipping `ARGUS_LIVE_MAIN_SOURCE` 0→1 now that the firmware
fix removed the mislock risk. Applied to the Mini plist (backup
`dev.point-labs.argus.plist.bak-20260808b`), service rebootstrapped ~21:33Z.

Verified after restart:

- Env in process (`ps eww`): `ARGUS_LIVE_MAIN_SOURCE=1`.
- Live-mode lines: **main** for the four standalone cameras (Backyard Left,
  Garage Door, Doorbell, Backyard); **sub** for the three NVR channels
  (Front L, Front R, Backyard Right) — by design (`serve.ts:186`): NVR mains
  keyframe every 4 s and the D1200s are 12MP HEVC, both blow the live
  start-time budget.
- Codec watchdog: "NVR HEVC mains healthy after 0 restart(s)" on the new boot.
- Hub 10.0.0.15 re-established all 7 accessory connections (51200–51206).
- Pending real-eyes check: a ≥720p live view on a standalone camera should now
  render from the main. Not yet exercised (needs a Home-app session).

## Attribution resolved

The 2026-07-20 Mini hot-patch (force-sub override, go2rtc 0600 config +
localhost WebRTC bind, `ARGUS_LIVE_MAIN_SOURCE=0`) was applied by **Peter** —
confirmed 2026-08-08. attempt-015's open item closed; production edits now
have an owner and the patches live in git (5adc729).

## Remaining

- 24 h soak re-measure (~2026-08-09T12:35Z).
- Peter: clip-sharpness co-check in the Home timeline (fronts + Backyard Left
  vs sub-era clips).
- Peter: eyeball a standalone-camera live view (quality + start latency) with
  mains re-enabled.
