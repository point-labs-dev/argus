# Attempt 012 - Fleet pairing live-profile rollout (2026-06-23)

Goal: after the remaining six cameras were paired, stop the new accessories from
spinning by giving them the same live profile that made Garage Door stable on
the Mini.

## Trigger

Peter paired the remaining cameras into Apple Home. They advertised and paired,
but live view showed the spinner and then failed instead of rendering.

## Findings

- All seven Argus accessories advertised over HomeKit mDNS with `sf=0`.
- The six newly paired cameras were still on the default live frame shape.
  Garage Door was the only camera with:

  ```yaml
  liveContentResolution: 854x480
  liveExactFrame: false
  ```

- Mini logs from the failed post-pairing attempts showed HomeKit live
  negotiations for Backyard, Backyard Right, Garage Door, and Front L. The
  controller reached Argus and Argus sent RTP/RTCP, but sessions were killed
  after short spinner windows.

## Change

- Updated the private, gitignored `argus.yaml` on the MacBook and on the Mini so
  all seven cameras use `liveContentResolution: 854x480` and
  `liveExactFrame: false`.
- Kept the steady-state Mini launchd runtime profile:
  - `ARGUS_HAP_BIND=en0`
  - `ARGUS_HUB_ADDRESSES=10.0.0.15`
  - `ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge`
  - `ARGUS_LIVE_MAIN_SOURCE=1`
  - `ARGUS_LIVE_AAC_ELD=1`
  - `ARGUS_RTCP_MONITOR=1`
- Ran a one-time `ARGUS_HAP_CONFIG_BUMP=all` restart so Home refetches the stream
  profile, then reinstalled launchd without the bump env.

## Verification

- Local `npm run build` passed.
- Local `npm test` passed: 8 files, 81 tests.
- Mini `npm run build` passed.
- Mini `npm test` passed: 8 files, 81 tests.
- Mini launchd is active as `dev.point-labs.argus`.
- Final plist no longer includes `ARGUS_HAP_CONFIG_BUMP`.
- Fresh Mini startup logs confirm:
  - standalone cameras: `source: main, content=854x480, fit-only`
  - NVR-fronted cameras: `source: sub, content=854x480, fit-only`
- mDNS after the bump:
  - Backyard Left: `sf=0`, `c#=17`
  - Doorbell: `sf=0`, `c#=17`
  - Backyard: `sf=0`, `c#=17`
  - Front L: `sf=0`, `c#=17`
  - Front R: `sf=0`, `c#=17`
  - Backyard Right: `sf=0`, `c#=17`
  - Garage Door: `sf=0`, `c#=21`

## Open live test

Started a passive watcher for `Backyard` after the cooldown window:

```sh
npm run watch:home:mini -- --camera Backyard --timeout-seconds 300 \
  --json-out /tmp/argus-backyard-after-854-20260623T1844Z.json \
  --mirror-log /tmp/argus-backyard-after-854-20260623T1844Z.log
```

It timed out without any matching live negotiation:

```json
{
  "ok": false,
  "camera": "Backyard",
  "error": "Timed out waiting for a matching HomeKit live negotiation.",
  "partialLines": []
}
```

Interpretation: no fresh iPhone/Home live request reached Argus during that
watch window. The next step is to run the watcher again and have Peter tap one
specific camera while it is active. If the stream still spins and the watcher
captures a negotiation, compare the new `source`, filter shape, RTCP packet
count, audio leg, and session duration against the Garage Door successful run.
