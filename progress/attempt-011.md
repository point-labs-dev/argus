# Attempt 011 — Verifier stabilized; AAC-ELD/RTCP diagnostics still fail Mac Home live (2026-06-22)

Goal: make the Garage Door live-view path measurable and determine whether the
remaining high-res Home spinner is caused by missing/unstable audio RTP.

## Code changes

- Hardened `scripts/verify-home-live.mjs` into the default live verifier:
  - opens/activates Home, filters out the 500x500 auxiliary windows, and clicks
    Home-window-relative coordinates;
  - samples the Home window once per second for the first 8 seconds, plus
    before/during/after screenshots;
  - emits a `visual` receipt block by cropping the Home content area, hashing
    each crop, computing luma diffs between samples, and reporting
    `firstVisualChangeMs` plus `firstMotionCandidateMs` so click-to-render
    evidence can be compared across Mac/iPhone/Mini runs instead of relying on
    manual screenshot inspection;
  - slices timestamped Garage Door live lines from `logs/serve.err.log`;
  - reports click-to-negotiation latency, negotiated video/audio shape, FFmpeg
    audio-leg presence, AAC-ELD detection, exit line, and session duration.
  - supports `--json-out <path>` for clean machine-readable receipts without
    npm's script banner.
  - enforces the 10-minute Home live cooldown before activating Home by default;
    pass `--ignore-cooldown` only for an explicitly untrusted diagnostic.
  - prefers Home app capture before full-screen `screencapture` fallback and
    excludes mismatched/full-screen samples from visual metrics, so black
    fallback frames do not become false motion evidence.
  - summarizes `negotiated`/`ffmpeg`/exit metrics from post-click log lines, so
    a Home auto-start on app activation cannot be misattributed to the scripted
    tile click.
  - wraps external verifier commands with a default 15s timeout
    (`--command-timeout-ms`) so a stuck Peekaboo command produces an error
    instead of hanging the verification process.
  - reports command failure metadata (`status`, `signal`, `code`, `killed`) and
    targets clicks by the selected Home `window_id` rather than ambiguous
    `--app Home` resolution.
  - checks `loginwindow` before activating Home. If the Mac GUI is locked, the
    verifier now fails before opening Home, preventing the preflight itself from
    starting a new camera live session.
  - uses two reset clicks by default (`--reset-clicks`, default `2`) because a
    camera timeline surface can require one click to reveal controls and a
    second click on the close button before Home returns to the tile grid.
  - supports `--err-log <path>` so the same verifier can summarize a mirrored
    remote Argus log when Argus is running on the Mini instead of the MacBook.
- Added `scripts/watch-home-live.mjs` plus `npm run watch:home`, a passive
  log-only verifier for iPhone/Home Hub evidence. It watches a local or mirrored
  `serve.err.log`, emits JSON for the next matching HomeKit live negotiation +
  FFmpeg exit, and supports `--ignore-controller <ip>` so Mac Home controller
  attempts can be filtered out while waiting for Peter's iPhone/Home app.
- Added `scripts/watch-mini-home-live.mjs` plus `npm run watch:home:mini`, a
  one-command wrapper that starts an SSH `tail -F` from the Mini log into a temp
  mirror file and then runs the passive watcher against it. Default is
  `host=mini`, remote log `/Users/pointlabs/Projects/argus/logs/serve.err.log`,
  and `--ignore-controller 10.0.0.46`. The wrapper tears down the SSH tail in a
  `finally` path so timeout/error runs do not leave a background log stream.
- Added `npm run verify:home`.
- Added `ARGUS_SRTP_LOOPBACK=0` pass-through for local-target diagnostics.
- Cleaned up `ARGUS_AUDIO=0` so Argus omits `PrepareStreamResponse.audio` and
  the FFmpeg audio leg when audio is disabled.
  - Important HAP-NodeJS detail discovered: even with no advertised audio option,
    HAP-NodeJS inserts a fake OPUS capability and sets `videoOnly=true` because
    HomeKit needs an audio config before it will start video. So this is not a
    pure protocol-level no-audio camera; it is "no Argus audio response/output".
- Added `ARGUS_LIVE_AUDIO_SOURCE=silence`, a diagnostic switch that feeds
  HomeKit a real AAC-ELD/Opus RTP audio leg from real-time `anullsrc` instead
  of camera/restream audio. Default remains camera input audio.
- Added `ARGUS_LIVE_MAX_RESOLUTION=WxH`, an env-gated advertised-resolution cap
  for stable fallback testing.
- Added `ARGUS_HAP_CONFIG_BUMP`, an env-gated operational cache-buster that
  increments the persisted HAP `c#` for one camera (`ARGUS_HAP_CONFIG_BUMP="Garage Door"`)
  or all cameras (`all`/`1`). HAP-NodeJS does not include streaming TLV values in
  its configuration hash, so stream-profile changes otherwise keep the same `c#`.
- Added `ARGUS_RTCP_MONITOR=1`, a diagnostic mode that binds a Node UDP socket
  to the advertised video return port and omits FFmpeg's `localrtcpport`,
  matching the return-port shape used by `homebridge-camera-ffmpeg`.
- Added `ARGUS_START_ACK_DELAY_MS`, a diagnostic START-callback timing knob.
  Default remains the existing 500ms; higher values test whether Home needs
  FFmpeg to produce packets longer before Argus acknowledges START (HAP-NodeJS's
  example acks after FFmpeg begins output).
- Added `ARGUS_LIVE_PACKET_SIZE`, a rollback-safe video RTP packet-size
  diagnostic. Default behavior is unchanged: hi-res sessions use the existing
  564-byte packets and smaller sessions use the negotiated MTU. The override is
  capped by Home's negotiated MTU and lets Argus test the
  `homebridge-camera-ffmpeg`-style 1316-byte payload shape without rewriting the
  stream builder.
- Added rollback-safe live bitrate/shape diagnostics for testing lower-wire-rate
  720p without falling back to a soft 480p box:
  `ARGUS_LIVE_1080P_BITRATE_KBPS`, `ARGUS_LIVE_720P_BITRATE_KBPS`,
  `ARGUS_LIVE_360P_BITRATE_KBPS`, `ARGUS_LIVE_LOW_BITRATE_KBPS`,
  `ARGUS_LIVE_KEEP_NEGOTIATED_SIZE=1`, and `ARGUS_LIVE_CBR=1`. Defaults are
  unchanged.
- Added exact-frame padding for transcoded live video. Garage Door's Mini
  restreams are 4:3 (`garage-door-sub` is 640x480 and `garage-door` main is
  2560x1920), while Apple commonly negotiates 16:9 1280x720. Argus now preserves
  source aspect, pads to the exact negotiated frame, and sets SAR to 1 so Home
  receives the dimensions it asked for without stretching the camera. Rollback:
  `ARGUS_LIVE_EXACT_FRAME=0` restores the old fit-within-only filter.
- Fixed the startup `live mode` log in `src/serve.ts`: main-source live remains
  parked unless `ARGUS_LIVE_MAIN_SOURCE=1`, so standalone cameras now correctly
  report `≥720p source: sub` under the normal deployed profile.
- Fixed `scripts/validate-av-sync.mjs` so negative drift counts as drift.

## Verification

- `npm run build` passed.
- `npm test` passed: 8 files, 61 tests.
- `node --check scripts/verify-home-live.mjs` passed after adding visual metrics.
- `npm run build` passed again after visual metrics (`2026-06-22T13:19Z`).
- `npm test` passed again after visual metrics: 8 files, 61 tests
  (`2026-06-22T13:19Z`).
- `node --check scripts/verify-home-live.mjs` passed after `--json-out`.
- `npm run build` passed after `--json-out` and the firmware/cache-buster
  comment correction (`2026-06-22T13:29Z`).
- `npm test` passed after `--json-out` and the comment correction: 8 files,
  61 tests (`2026-06-22T13:29Z`).
- `node --check scripts/verify-home-live.mjs` passed after RTCP monitor parsing.
- `npm run build` passed after RTCP monitor support (`2026-06-22T13:37Z`).
- `npm test` passed after RTCP monitor support: 8 files, 63 tests
  (`2026-06-22T13:37Z`).
- Final fresh check after restoring launchd/profile docs: `npm run build` passed
  and `npm test` passed: 8 files, 63 tests (`2026-06-22T13:44Z`).
- Final mDNS check after launchd restore: `Garage Door 3B20` resolves with
  `sf=0`, `c#=16`, `ci=17`, port `51201` (`2026-06-22T13:46Z`).
- `node --check scripts/verify-home-live.mjs` passed after cooldown/sample
  quality hardening (`2026-06-22T13:53Z`).
- `node --check scripts/verify-home-live.mjs` passed after post-click log
  filtering (`2026-06-22T13:55Z`).
- `npm run build` passed and `npm test` passed: 8 files, 63 tests
  (`2026-06-22T13:56Z`).
- `node --check scripts/verify-home-live.mjs` passed after adding verifier
  command timeouts (`2026-06-22T14:06Z`).
- Cooldown guard receipt: `/tmp/argus-cooldown-guard-20260622T1407Z.json`
  refused to activate Home because the latest Garage Door `ffmpeg exited` line
  was `2026-06-22T14:03:52.885Z`; next trusted run after
  `2026-06-22T14:13:52.885Z`.
- `npm run build` passed and `npm test` passed: 8 files, 63 tests
  (`2026-06-22T14:07Z`).
- `node --check scripts/verify-home-live.mjs` passed after command-failure
  metadata and window-scoped click targeting (`2026-06-22T14:16Z`).
- Cooldown guard receipt: `/tmp/argus-cooldown-guard-20260622T1418Z.json`
  refused to activate Home because the latest Garage Door `ffmpeg exited` line
  was `2026-06-22T14:15:10.166Z`; next trusted run after
  `2026-06-22T14:25:10.166Z`.
- `npm run build` passed and `npm test` passed: 8 files, 63 tests
  (`2026-06-22T14:17Z`).
- `node --check scripts/verify-home-live.mjs` passed after adding the
  loginwindow preflight (`2026-06-22T14:31Z`).
- Loginwindow guard receipt:
  `/tmp/argus-loginwindow-guard-20260622T1431Z.json` with
  `--min-cooldown-seconds 0` failed before Home activation:
  `macOS GUI is locked or loginwindow is frontmost (window 8644 "Login")`.
  No new Garage Door live session was logged.
- Final fresh check after the loginwindow preflight: `npm run build` passed and
  `npm test` passed: 8 files, 63 tests (`2026-06-22T14:31Z`).
- `node --check scripts/verify-home-live.mjs` passed after adding
  `--reset-clicks` (`2026-06-22T14:49Z`).
- `npm run build` passed and `npm test` passed: 8 files, 63 tests after the
  reset-click verifier hardening (`2026-06-22T14:49Z`).
- `npm run build` passed and `npm test` passed: 8 files, 65 tests after adding
  `ARGUS_START_ACK_DELAY_MS` (`2026-06-22T14:55Z`).
- `git diff --check` passed, `node --check scripts/verify-home-live.mjs`
  passed, `npm run build` passed, and `npm test` passed: 8 files, 67 tests
  after adding `ARGUS_LIVE_PACKET_SIZE` (`2026-06-22T15:09Z`).
- `git diff --check` passed, `npm run build` passed, and `npm test` passed:
  8 files, 67 tests after the startup source-log fix (`2026-06-22T15:14Z`).
- Final local closeout check passed on the current MacBook worktree:
  `git diff --check`, `node --check scripts/verify-home-live.mjs`,
  `npm run build`, and `npm test` with 8 files / 67 tests
  (`2026-06-22T15:30Z`).
- After adding the lower-bitrate 720p/CBR diagnostics, local checks passed:
  `git diff --check`, `node --check scripts/verify-home-live.mjs`,
  `npm run build`, and `npm test` with 8 files / 72 tests
  (`2026-06-22T15:34Z`).
- Watcher checks passed:
  - `node --check scripts/watch-home-live.mjs`
  - existing-log self-test:
    `/tmp/argus-watch-home-selftest.json`
  - ignore-Mac-controller self-test against the Mini CBR mirror:
    `/tmp/argus-watch-home-ignore-mac-mini-selftest.json` timed out as
    expected with only controller `10.0.0.46` present
- Mini watcher wrapper checks passed:
  - `node --check scripts/watch-mini-home-live.mjs`
  - expected-timeout self-test:
    `/tmp/argus-watch-mini-wrapper-selftest.json`
  - mirror log:
    `/tmp/argus-watch-mini-wrapper-selftest.log`
- Final local check after the passive watcher: `git diff --check`,
  `node --check scripts/verify-home-live.mjs`,
  `node --check scripts/watch-home-live.mjs`, `npm run build`, and
  `npm test` with 8 files / 72 tests (`2026-06-22T15:42Z`).
- Final local check after the Mini watcher wrapper: `git diff --check`,
  `node --check scripts/verify-home-live.mjs`,
  `node --check scripts/watch-home-live.mjs`,
  `node --check scripts/watch-mini-home-live.mjs`, `npm run build`, and
  `npm test` with 8 files / 72 tests (`2026-06-22T15:47Z`).
- Fresh local check after the passive iPhone/Home watcher timeout: `npm run
  build` passed and `npm test` passed with 8 files / 72 tests
  (`2026-06-22T15:55Z`).
- Final wrapper cleanup check passed: `git diff --check`,
  `node --check scripts/verify-home-live.mjs`,
  `node --check scripts/watch-home-live.mjs`,
  `node --check scripts/watch-mini-home-live.mjs`, and a 2-second
  `npm run watch:home:mini` expected-timeout self-test with no persistent
  watcher/tail process. `npm run build` and `npm test` passed with 8 files /
  72 tests (`2026-06-22T17:15Z`).
- Exact-frame padding checks passed locally: focused `tests/homekit.test.ts`
  passed with 40 tests, then `npm run build` and `npm test` passed with 8 files /
  74 tests (`2026-06-22T17:18Z`).
- Exact-frame padding was staged to the Mini; Mini `npm run build` and `npm test`
  passed with 8 files / 74 tests, then launchd was restarted. Mini launchd
  stayed on the normal AAC-ELD profile with no diagnostic envs:
  `ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge`,
  `ARGUS_LIVE_LADDER=compat`, `ARGUS_HUB_ADDRESSES=10.0.0.15`,
  `ARGUS_HAP_BIND=en0`, `ARGUS_LIVE_AAC_ELD=1` (`2026-06-22T17:19Z`).
- Mini staging checks passed after copying the current worktree and the
  libfdk-enabled ffmpeg-homebridge binary:
  - `ssh mini 'cd ~/Projects/argus && npm ci && npm run build'` passed.
  - `ssh mini 'cd ~/Projects/argus && npm test'` passed: 8 files, 67 tests
    (`2026-06-22T15:22Z`).
  - Mini runtime has AAC-ELD-capable `/Users/pointlabs/.local/bin/ffmpeg-homebridge`
    with `libfdk_aac`.
- Mini checks also passed after staging the lower-bitrate 720p/CBR diagnostics:
  `PATH=/opt/homebrew/bin:$PATH npm run build` and `npm test` with 8 files /
  72 tests (`2026-06-22T15:34Z`).
- Mini checks passed again after staging the passive watcher:
  `node --check scripts/watch-home-live.mjs`, `npm run build`, and `npm test`
  with 8 files / 72 tests (`2026-06-22T15:43Z`).
- Mini checks passed again after staging the Mini watcher wrapper:
  `node --check scripts/watch-home-live.mjs`,
  `node --check scripts/watch-mini-home-live.mjs`, `npm run build`, and
  `npm test` with 8 files / 72 tests (`2026-06-22T15:47Z`).
- Cooldown guard receipt: `/tmp/argus-cooldown-guard-20260622T1355Z.json`
  refused to activate Home because the latest Garage Door `ffmpeg exited` line
  was `2026-06-22T13:52:24.003Z`; next trusted run after
  `2026-06-22T14:02:24.003Z`.
- Local SRTP decode validator:
  - `node scripts/validate-live-decode.mjs garage-door-sub --size 1280x720 --bitrate 2000 --seconds 10`
  - result: sender clean, receiver decoded 277 frames in 10s, 0 decode-ish lines.
- Local sender-side source-start comparison, no Home app involved:
  - `node scripts/bench-live-start.mjs garage-door-sub 5 --mode transcode --size 1280x720 --bitrate 2000 --window 6000`
  - result: first video packet avg 0.80s, max 1.27s over 5 runs.
  - `node scripts/bench-live-start.mjs garage-door 5 --mode transcode --size 1280x720 --bitrate 2000 --window 6000`
  - result: first video packet avg 1.06s, max 1.36s over 5 runs.
  - Interpretation: Garage Door main-source live is locally decodable and only
    about 260ms slower on average, but it is still parked because Home
    acceptance must be proven first and sub-source is the faster alert path.
- Local SRTP decode validator, main-vs-sub after the source-start comparison:
  - `node scripts/validate-live-decode.mjs garage-door --size 1280x720 --bitrate 2000 --seconds 10`
  - result: sender clean, receiver decoded 282 frames in 10s, 0 decode-ish lines.
  - `node scripts/validate-live-decode.mjs garage-door-sub --size 1280x720 --bitrate 2000 --seconds 10`
  - result: sender clean, receiver decoded 277 frames in 10s, 0 decode-ish lines.
- Local A/V clock validator, default Opus path:
  - `node scripts/validate-av-sync.mjs garage-door-sub --size 1280x720 --bitrate 2000 --seconds 60`
  - result: skew -140ms -> -200ms, drift -90 ms/min; validator verdict says the
    local stream-side clocks track.

## Network receipts

- Routes to Home hub `10.0.0.15` and Garage Door `10.0.0.7` both use `en0`.
- Fresh ping to hub: 20/20 received, min/avg/max/stddev =
  `3.498/20.910/86.115/25.314 ms`.
- Fresh ping to Garage Door: 20/20 received, min/avg/max/stddev =
  `3.654/30.038/99.347/31.890 ms`.
- This is still a jittery MacBook WiFi diagnostic environment, not final proof.

## Home verifier results

### Video-only diagnostic

Profile:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/peterpine/.local/bin/ffmpeg-homebridge ARGUS_HAP_BIND=en0 ARGUS_AUDIO=0`

Receipt:

- verifier JSON: `/tmp/argus-videoonly-20260622T1223Z.json`
- screenshots: `/tmp/argus-homekit-videoonly-20260622T1223Z`
- negotiated: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `controller=10.0.0.46`, `target=127.0.0.1`
- audio: disabled by Argus; controller selected OPUS 24kHz
- click-to-negotiation: 230ms
- outcome: Home killed FFmpeg after 16.457s (`SIGKILL`); not stable live.

### AAC-ELD camera-audio profile

Profile:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/peterpine/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_HAP_BIND=en0`

Receipt:

- verifier JSON: `/tmp/argus-aaceld-20260622T1235Z.json`
- screenshots: `/tmp/argus-homekit-aaceld-20260622T1235Z`
- negotiated: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `controller=10.0.0.46`, `target=127.0.0.1`
- audio: AAC-ELD 16kHz, FFmpeg `libfdk_aac`, `aac_eld`
- click-to-negotiation: 284ms
- outcome: Home killed FFmpeg after 30.533s (`SIGKILL`); not stable live.

### AAC-ELD camera-audio profile, post-cooldown visual metrics

Profile:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/peterpine/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_HAP_BIND=en0`

Receipt:

- verifier JSON: `/tmp/argus-aaceld-visual-20260622T1328Z.clean.json`
- raw tee output: `/tmp/argus-aaceld-visual-20260622T1328Z.json`
- screenshots: `/tmp/argus-homekit-aaceld-visual-20260622T1328Z`
- negotiated: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `controller=10.0.0.46`, `target=127.0.0.1`
- audio: AAC-ELD 16kHz, source=input, FFmpeg audio leg present
- click-to-negotiation: 232ms
- visual metrics:
  - first visual change: 1002ms after click
  - crop diff from pre-click Home grid: 51.04% on every 1s sample
  - sample-to-sample diff: 0.01%; no `firstMotionCandidateMs` above the 3%
    threshold
  - unique sample crop hashes: 7, consistent with small spinner/overlay changes
    over a mostly static camera frame
- visual inspection: sample 1 shows a sharp Garage Door frame under the dim live
  overlay with Home's spinner still visible; final screenshot shows `No Response`.
- outcome: Home killed FFmpeg after 30.029s (`SIGKILL`). Current restored
  AAC-ELD profile has fast first frame but does not transition to accepted Mac
  Home live playback.

### AAC-ELD camera-audio profile, two-click reset verifier

The first post-cooldown run after the loginwindow fix did not start a stream:

- verifier JSON: `/tmp/argus-aaceld-postcooldown-20260622T1445Z.json`
- screenshots: `/tmp/argus-homekit-aaceld-postcooldown-20260622T1445Z`
- outcome: `negotiated=false`; no new Garage Door live lines landed in
  `logs/serve.err.log`
- screenshot inspection showed the reset click only revealed the camera timeline
  controls and did not close back to the Home tile grid. This led to the
  verifier `--reset-clicks` hardening above.

Clean run after the reset hardening:

- verifier JSON: `/tmp/argus-aaceld-reset2-20260622T1450Z.json`
- screenshots: `/tmp/argus-homekit-aaceld-reset2-20260622T1450Z`
- before screenshot: Home was back on the main grid, with the Garage Door tile
  visible and fresh
- negotiated: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `controller=10.0.0.46`, `target=127.0.0.1`,
  `rtcp=ffmpeg-localrtcpport`
- audio: AAC-ELD 16kHz, source=input, FFmpeg audio leg present
- click-to-negotiation: 231ms
- visual metrics:
  - first visual change: 1001ms after click
  - crop diff from pre-click Home grid: 51.28% on every 1s sample
  - sample-to-sample diff: 0.01%; no `firstMotionCandidateMs` above the 3%
    threshold
  - unique sample crop hashes: 4, matching Home spinner/overlay cycling over a
    mostly static camera frame
- visual inspection: sample 1 shows a sharp Garage Door 720p frame under Home's
  dim live overlay and spinner; the final screenshot shows `No Response`.
- outcome: Home killed FFmpeg after 30.028s (`SIGKILL`). This is a clean
  post-cooldown Mac Home repro of the current high-res failure mode, with fast
  first render but no accepted live playback.

### AAC-ELD camera-audio profile, delayed START ACK diagnostic

Profile:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/peterpine/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_HAP_BIND=en0 ARGUS_START_ACK_DELAY_MS=2000`

Receipt:

- launchd plist was written with `ARGUS_START_ACK_DELAY_MS=2000`; `install-launchd.sh`
  again hit macOS `Bootstrap failed: 5`, then direct `launchctl bootstrap` +
  `kickstart` started pid `47233` with the diagnostic env.
- verifier JSON: `/tmp/argus-aaceld-ack2000-20260622T1458Z.json`
- screenshots: `/tmp/argus-homekit-aaceld-ack2000-20260622T1458Z`
- negotiated: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `controller=10.0.0.46`, `target=127.0.0.1`,
  `rtcp=ffmpeg-localrtcpport`
- audio: AAC-ELD 16kHz, source=input, FFmpeg audio leg present
- click-to-negotiation: 241ms
- visual metrics:
  - first visual change: 1001ms after click
  - crop diff from pre-click Home grid: 51.8%
  - sample-to-sample diff: 0.01-0.02%; no `firstMotionCandidateMs` above the
    3% threshold
  - unique sample crop hashes: 5, again matching spinner/overlay cycling over a
    mostly static camera frame
- outcome: Home killed FFmpeg after 30.017s (`SIGKILL`). Delaying START ACK to
  2000ms did not improve Mac Home acceptance.
- rollback/restore: launchd was restored to the intended AAC-ELD camera-audio
  profile with no `ARGUS_START_ACK_DELAY_MS`; direct `launchctl bootstrap` +
  `kickstart` started pid `54146`.

### AAC-ELD camera-audio profile, 1316-byte video RTP packet diagnostic

Profile:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/peterpine/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_HAP_BIND=en0 ARGUS_LIVE_PACKET_SIZE=1316`

Reason:

`homebridge-camera-ffmpeg`'s maintained streaming delegate uses no
`localrtcpport`, binds the video return port itself, and defaults video RTP
`pkt_size` to 1316. Argus had already tested the return-port shape via
`ARGUS_RTCP_MONITOR=1`; this run isolated the packet-size delta while leaving
the normal AAC-ELD profile otherwise unchanged.

Receipt:

- launchd plist was written with `ARGUS_LIVE_PACKET_SIZE=1316`; `install-launchd.sh`
  again hit macOS `Bootstrap failed: 5`, then direct `launchctl bootstrap` +
  `kickstart` applied the diagnostic env.
- verifier JSON: `/tmp/argus-pkt1316-20260622T1510Z.json`
- screenshots: `/tmp/argus-homekit-pkt1316-20260622T1510Z`
- negotiated: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `controller=10.0.0.46`, `target=127.0.0.1`,
  `rtcp=ffmpeg-localrtcpport`
- FFmpeg video RTP URL used `pkt_size=1316`
- audio: AAC-ELD 16kHz, source=input, FFmpeg audio leg present
- click-to-negotiation: 226ms
- visual metrics:
  - first visual change: 1001ms after click
  - crop diff from pre-click Home grid: 50.72-50.73%
  - sample-to-sample diff: 0.01%; no `firstMotionCandidateMs` above the 3%
    threshold
  - unique sample crop hashes: 5, again matching spinner/overlay cycling over a
    mostly static camera frame
- outcome: Home killed FFmpeg after 30.010s (`SIGKILL`). Matching the
  camera-ffmpeg packet size did not improve Mac Home acceptance.
- rollback/restore: launchd was restored again to the intended AAC-ELD
  camera-audio profile with no `ARGUS_LIVE_PACKET_SIZE`.

### Mini-hosted same-identity AAC-ELD profile

Profile:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_HAP_BIND=en0`

Setup:

- Mini host: `Points-Mac-mini.local`, LAN `10.0.0.48`, wired `en0`
  (`1000baseT <full-duplex>`). Routes from the Mini to Home Hub `10.0.0.15`
  and MacBook `10.0.0.46` both use `en0`.
- Staged current worktree to `mini:~/Projects/argus`, excluding `node_modules`,
  `logs`, `recordings`, and `.homekit` during the first copy.
- Copied `/Users/peterpine/.local/lib/ffmpeg-for-homebridge` to the Mini and
  symlinked `/Users/pointlabs/.local/bin/ffmpeg-homebridge`.
- Stopped the MacBook launchd service, then copied `.homekit/` to the Mini so
  the same Garage Door accessory identity was preserved.
- Installed Mini launchd service via `scripts/install-launchd.sh`; pid `52472`
  started `dist/serve.js` with go2rtc child `52477`.
- mDNS resolved `Garage Door 3B20` / `6E_6D_C2_E7_44_E3.local` to
  `10.0.0.48`, port `51201`, `sf=0`, `c#=16`.

Receipt:

- verifier JSON: `/tmp/argus-mini-live-20260622T1524Z.json`
- screenshots: `/tmp/argus-homekit-mini-live-20260622T1524Z`
- Mini log mirror: `/tmp/argus-mini-serve-tail-20260622T1524Z.log`
- negotiated: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `controller=10.0.0.46`, `target=10.0.0.46`,
  `rtcp=ffmpeg-localrtcpport`
- FFmpeg RTP URL sent over LAN from Mini to MacBook:
  `srtp://10.0.0.46:58436?...&pkt_size=564`
- audio: AAC-ELD 16kHz, source=input, FFmpeg audio leg present
- click-to-negotiation: 358ms
- visual metrics:
  - first visual change: 1002ms after click
  - crop diff from pre-click Home grid: 50.94-50.95%
  - sample-to-sample diff: 0.01%; no `firstMotionCandidateMs` above the 3%
    threshold
  - unique sample crop hashes: 6, again matching spinner/overlay cycling over a
    mostly static camera frame
- outcome: Home killed FFmpeg after 31.535s (`SIGKILL`). Moving Argus to the
  wired Mini and removing MacBook-local loopback did **not** make Mac Home accept
  Garage Door live playback.

### Mini-hosted AAC-ELD, 720p preserved at 1000k CBR diagnostic

Profile:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_HAP_BIND=en0 ARGUS_LIVE_720P_BITRATE_KBPS=1000 ARGUS_LIVE_KEEP_NEGOTIATED_SIZE=1 ARGUS_LIVE_CBR=1`

Reason:

`ARGUS_LIVE_OBEY_BITRATE=1` previously tested Apple's 299k ask, but Argus'
starved-session policy downscaled the encoded box to 854x480. This diagnostic
kept Home's negotiated 1280x720 box while cutting the LAN wire target from
2000k to 1000k and adding `-b:v 1000k` CBR shaping.

Receipt:

- verifier JSON: `/tmp/argus-mini-1000cbr-20260622T1535Z.json`
- screenshots: `/tmp/argus-homekit-mini-1000cbr-20260622T1535Z`
- Mini log mirror: `/tmp/argus-mini-1000cbr-tail-20260622T1535Z.log`
- negotiated: `1280x720@30`, `asked=299k`, `serving=1000k`,
  `controller=10.0.0.46`, `target=10.0.0.46`,
  `rtcp=ffmpeg-localrtcpport`
- FFmpeg used the intended preserved-720p CBR shape:
  `scale=1280:720:force_original_aspect_ratio=decrease`, `-crf 18`,
  `-b:v 1000k`, `-maxrate 1000k`, `-bufsize 1000k`
- audio: AAC-ELD 16kHz, source=input, FFmpeg audio leg present
- click-to-negotiation: 355ms
- visual metrics:
  - first visual change: 1001ms after click
  - sample-to-sample diff: 0.01%; no `firstMotionCandidateMs` above the 3%
    threshold
  - unique sample crop hashes: 6, again matching spinner/overlay cycling over a
    mostly static camera frame
- visual inspection: first sample shows a clear Garage Door frame under Home's
  dim overlay/spinner; final screenshot shows `No Response`.
- outcome: Home killed FFmpeg after 31.591s (`SIGKILL`). Lowering preserved
  720p to 1000k with CBR shaping did **not** make Mac Home accept Garage Door
  live playback.
- rollback/restore: launchd was restored to the normal Mini AAC-ELD profile with
  no `ARGUS_LIVE_720P_BITRATE_KBPS`, no `ARGUS_LIVE_KEEP_NEGOTIATED_SIZE`, and
  no `ARGUS_LIVE_CBR`.

### Mini-hosted exact-frame padding diagnostic

Garage Door's Mini restream dimensions:

- `garage-door-sub`: H.264 High, `640x480`, 30fps
- `garage-door` main: H.264 High, `2560x1920`, 30fps

The prior 1280x720 HomeKit sessions were therefore sourced from 4:3 video and
scaled with fit-within semantics. The exact-frame diagnostic pads the aspect-
preserved content to the negotiated output size:

`-vf scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1`

Receipt:

- verifier JSON: `/tmp/argus-mini-exact-frame-20260622T1719Z.json`
- screenshots: `/tmp/argus-homekit-mini-exact-frame-20260622T1719Z`
- mirrored Mini log: `/tmp/argus-mini-exact-frame-20260622T1719Z.log`
- negotiated: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `controller=10.0.0.46`, `target=10.0.0.46`, AAC-ELD camera audio
- click-to-negotiation: 380ms
- first visual change: 1001ms
- first motion candidate: none
- FFmpeg exited via `SIGKILL` after 23.578s
- visual inspection: sample 1 shows the sharp Garage Door frame under Home's
  spinner; after screenshot remains on the blurred Home timeline/live surface.

Interpretation: exact-frame padding is the correct stream shape for these 4:3
cameras and should stay as the default, but it does **not** by itself make Mac
Home accept Garage Door live playback. It rules out frame-size mismatch as the
sole root cause.

### Main-source exact-frame diagnostic attempt

Because Garage Door main-source startup is only about 260ms slower locally than
sub-source startup, the Mini was temporarily switched to:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_HAP_BIND=en0 ARGUS_LIVE_MAIN_SOURCE=1`

The first launchd reinstall hit the known transient `Bootstrap failed: 5:
Input/output error`; the immediate retry succeeded. Mini startup confirmed
Garage Door `live mode: transcode (≥720p source: main)`.

After the cooldown expired, the verifier was attempted:

- verifier JSON: `/tmp/argus-mini-main-source-20260622T1730Z.json`
- mirrored Mini log: `/tmp/argus-mini-main-source-20260622T1730Z.log`
- result: verifier failed before activating Home because macOS was locked:
  `macOS GUI is locked or loginwindow is frontmost (window 8899)`

Interpretation: this is a machine-state blocker for the main-source diagnostic,
not an Argus stream result. The Mini was restored immediately afterward to the
normal AAC-ELD profile with no `ARGUS_LIVE_MAIN_SOURCE`; fresh startup logs
confirmed Garage Door returned to `≥720p source: sub`.

### AAC-ELD synthetic-silence profile

Profile:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/peterpine/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_LIVE_AUDIO_SOURCE=silence ARGUS_HAP_BIND=en0`

Receipt:

- verifier JSON: `/tmp/argus-silence-aaceld-20260622T1247Z.json`
- screenshots: `/tmp/argus-homekit-silence-aaceld-20260622T1247Z`
- negotiated: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `controller=10.0.0.46`, `target=127.0.0.1`
- audio: AAC-ELD 16kHz from `anullsrc`, FFmpeg includes
  `-re -f lavfi -i anullsrc=channel_layout=mono:sample_rate=16000`
- click-to-negotiation: 249ms
- visual result: first sample at 1.001s showed a sharp Garage Door image under
  Home's dim live overlay, but the spinner remained; the 8.001s sample still had
  the same spinner/static camera content.
- outcome: Home killed FFmpeg after 30.025s (`SIGKILL`) and the final screenshot
  showed Home's `No Response` state. Synthetic audio did not fix Mac Home live.

### AAC-ELD synthetic-silence, spec-obedient bitrate

Profile:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/peterpine/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_LIVE_AUDIO_SOURCE=silence ARGUS_LIVE_OBEY_BITRATE=1 ARGUS_HAP_BIND=en0`

Receipt:

- verifier JSON: `/tmp/argus-obey-silence-aaceld-20260622T1258Z.json`
- screenshots: `/tmp/argus-homekit-obey-silence-aaceld-20260622T1258Z`
- negotiated: `1280x720@30`, `asked=299k`, `serving=299k`,
  `controller=10.0.0.46`, `target=127.0.0.1`
- FFmpeg scaled the starved video to `854x480` inside the negotiated box and
  sent AAC-ELD silence.
- click-to-negotiation: 248ms
- visual result: sample hashes repeated in a four-frame spinner cycle, indicating
  Home UI/spinner changes but no accepted moving camera content.
- outcome: Home killed FFmpeg after 30.014s (`SIGKILL`). Spec-obedient bitrate
  did not fix Mac Home live.

### AAC-ELD camera audio with advertised max 640x360

Profile:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_LIVE_MAX_RESOLUTION=640x360 ARGUS_FFMPEG=/Users/peterpine/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_HAP_BIND=en0 ARGUS_HAP_CONFIG_BUMP="Garage Door"`

Receipt:

- verifier JSON: `/tmp/argus-cap640-aaceld-20260622T1309Z.json`
- screenshots: `/tmp/argus-homekit-cap640-aaceld-20260622T1309Z`
- mDNS before run: Garage Door moved to `c#=16`, `sf=0`
- local options check with the same env produced advertised resolutions:
  `[[640,360,30],[480,270,30],[320,240,15]]`
- Home still negotiated `1280x720@30`, `asked=299k`, `serving=2000k`
- click-to-negotiation: 255ms
- outcome: Home killed FFmpeg after 21.108s (`SIGKILL`). This did not prove
  640x360 fallback quality because the Mac Home controller did not refresh its
  cached streaming ladder despite the forced `c#` bump.

### AAC-ELD camera audio with RTCP monitor diagnostic

Profile:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/peterpine/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_HAP_BIND=en0 ARGUS_RTCP_MONITOR=1`

Receipt:

- verifier JSON: `/tmp/argus-rtcp-monitor-20260622T1339Z.json`
- screenshots: `/tmp/argus-homekit-rtcp-monitor-20260622T1339Z`
- negotiated: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `controller=10.0.0.46`, `target=127.0.0.1`, `rtcp=node-monitor:62108`
- FFmpeg RTP URL omitted `localrtcpport`:
  `srtp://127.0.0.1:59868?rtcpport=59868&pkt_size=564`
- RTCP monitor receipt: `RTCP monitor video packets=55 port=62108`
- audio: AAC-ELD 16kHz, source=input, FFmpeg audio leg present
- verifier caveat: Home did not negotiate until 39.552s after the scripted
  click, and screenshots switched from `peekaboo-window-id` to black full-screen
  `screencapture` frames after the third sample. Treat the verifier visual
  metrics in this run as untrustworthy.
- visual inspection: the final screenshot contained a sharp Garage Door frame
  with Home's spinner still visible.
- outcome: Home killed FFmpeg after 30.020s (`SIGKILL`). Receiving RTCP on the
  advertised return port did not by itself make Mac Home accept the stream.

An accidental second Home negotiation fired while the diagnostic process was
still live, likely because Home was still on the camera view:

- negotiated at `2026-06-22T13:42:06Z`, again with `rtcp=node-monitor`
- RTCP monitor receipt: `RTCP monitor video packets=37 port=55329`
- service reload interrupted the attempt before a normal FFmpeg exit line landed.
  Do not use this as a trusted pass/fail datapoint.

Another accidental Home negotiation fired when a precheck woke/activated Home
while the Home app was still sitting on the Garage Door live surface:

- negotiated at `2026-06-22T13:51:53Z` in the restored normal AAC-ELD profile
  (`rtcp=ffmpeg-localrtcpport`)
- FFmpeg was killed at `2026-06-22T13:52:24.003Z`
- this started 31 seconds before the full 10-minute cooldown from the previous
  diagnostic, so it is not a trusted stream result; it only resets the next
  cooldown boundary.

A trusted post-cooldown verifier command started at `2026-06-22T14:03Z`, but the
verifier hung in `peekaboo hotkey cmd+[ --app Home --foreground` before it could
write screenshots/JSON. The stream log itself is still useful:

- negotiated at `2026-06-22T14:03:22.866Z` in the restored normal AAC-ELD profile
  (`rtcp=ffmpeg-localrtcpport`)
- `1280x720@30`, `asked=299k`, `serving=2000k`, `target=127.0.0.1`,
  source `garage-door-sub`, AAC-ELD 16kHz source=input
- FFmpeg was killed at `2026-06-22T14:03:52.885Z` after 30.019s
- no visual receipt exists for this run because the verifier hung before
  capturing screenshots; do not use it as a full verifier result.

A second post-cooldown verifier command started at `2026-06-22T14:14Z` after the
command-timeout hardening. It failed fast instead of hanging:

- verifier JSON: `/tmp/argus-aaceld-timeoutfix-20260622T1414Z.json`
- error: `peekaboo click --app Home --coords 22,74 --foreground failed`
- Home activation still auto-started a Garage Door session before the reset click:
  negotiated at `2026-06-22T14:14:40.142Z`
- normal AAC-ELD profile: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `target=127.0.0.1`, `rtcp=ffmpeg-localrtcpport`
- FFmpeg was killed at `2026-06-22T14:15:10.166Z` after 30.024s
- no visual receipt exists; this is a GUI reset failure plus stream-log failure,
  not a full verifier result. The verifier was then changed to click the selected
  `window_id` instead of ambiguous `--app Home`.

A third post-cooldown verifier command started at `2026-06-22T14:25Z` after
window-id click targeting. It also failed fast:

- verifier JSON: `/tmp/argus-aaceld-windowid-20260622T1425Z.json`
- error: `peekaboo click --window-id 7836 --coords 22,74 --foreground failed:
  status=null signal=SIGTERM code=ETIMEDOUT`
- Home activation again auto-started a Garage Door session before the reset
  could complete: negotiated at `2026-06-22T14:25:30.565Z`
- normal AAC-ELD profile: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `target=127.0.0.1`, `rtcp=ffmpeg-localrtcpport`
- FFmpeg was killed at `2026-06-22T14:26:00.569Z` after 30.004s
- no visual receipt exists. A follow-up non-foreground Peekaboo click identified
  the machine-state cause: frontmost/focused app was `loginwindow` (`Login`
  window 8644), so coordinate input would land on the lock/login surface instead
  of Home. Further Mac Home verifier runs require unlocking/resetting the GUI
  first; this is not an Argus stream-code failure.

After the loginwindow preflight test, Home still produced another Garage Door
session at `2026-06-22T14:31:24Z`:

- normal AAC-ELD profile: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `controller=10.0.0.46`, `target=127.0.0.1`, `rtcp=ffmpeg-localrtcpport`
- FFmpeg was killed at `2026-06-22T14:31:54.494Z` after 30.015s
- no verifier screenshot/JSON for this session. Treat it as another Home
  auto-start while the Mac GUI was locked, not as a clean verifier result.

A separate Garage Door session started from a non-local controller at
`2026-06-22T14:34:06Z`:

- normal AAC-ELD profile: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `controller=10.0.0.41`, `target=10.0.0.41`, `rtcp=ffmpeg-localrtcpport`
- FFmpeg was killed at `2026-06-22T14:34:12.422Z` after 6.344s
- route to `10.0.0.41` uses `en0`; ARP saw `10.0.0.41` on `en0`
- quick ping to `10.0.0.41`: 5/5 received, min/avg/max/stddev =
  `10.070/68.038/152.257/54.558 ms`
- This is useful because it is not Mac-local loopback, but the network jitter is
  bad enough that the 6s failure is not decisive iPhone/Home proof.

One more Mac-local Home auto-start appeared at `2026-06-22T14:35:08Z`:

- normal AAC-ELD profile: `1280x720@30`, `asked=299k`, `serving=2000k`,
  `controller=10.0.0.46`, `target=127.0.0.1`, `rtcp=ffmpeg-localrtcpport`
- FFmpeg exited at `2026-06-22T14:35:09.139Z` after 1.100s
- no verifier screenshot/JSON. Treat it as another locked-GUI/Home-state
  auto-start, not a clean verifier result.

## Current deployed profile

After the Mini-hosted proof, the active Argus service is on the Mini, not the
MacBook. The MacBook launchd service was stopped before copying `.homekit/` and
starting the Mini service, to avoid duplicate HAP identities.

Mini profile:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_HAP_BIND=en0`

Mini `launchctl print` confirms no `ARGUS_LIVE_AUDIO_SOURCE` and no
`ARGUS_AUDIO`. It also confirms no `ARGUS_LIVE_MAX_RESOLUTION`, no
`ARGUS_HAP_CONFIG_BUMP`, no `ARGUS_RTCP_MONITOR`, no
`ARGUS_START_ACK_DELAY_MS`, no `ARGUS_LIVE_PACKET_SIZE`, no
`ARGUS_LIVE_720P_BITRATE_KBPS`, no `ARGUS_LIVE_KEEP_NEGOTIATED_SIZE`, and no
`ARGUS_LIVE_CBR`.
Garage Door mDNS remains paired/reachable from the MacBook: `sf=0`, `c#=16`,
host `6E_6D_C2_E7_44_E3.local` resolves to `10.0.0.48`, port `51201`.

Latest Mini service check at `2026-06-22T15:51Z`: launchd label
`dev.point-labs.argus` is running with `dist/serve.js` pid `54598`; go2rtc is
pid `54602`. `launchctl print` confirms only the normal profile env is active:
`ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge`,
`ARGUS_LIVE_LADDER=compat`, `ARGUS_HUB_ADDRESSES=10.0.0.15`,
`ARGUS_HAP_BIND=en0`, and `ARGUS_LIVE_AAC_ELD=1`.

Rollback to MacBook, if needed: boot out the Mini service, copy `.homekit/` back
if the Mini has newer pair state, then reinstall/kickstart the MacBook service
with the same AAC-ELD profile.

## Passive iPhone/Home watcher receipt

The one-command Mini watcher was run at `2026-06-22T15:51Z`:

`npm run watch:home:mini -- --timeout-seconds 180 --json-out /tmp/argus-iphone-live-20260622T1551Z.json --mirror-log /tmp/argus-iphone-live-20260622T1551Z.log`

Result:

- timeout after 180s, from `2026-06-22T15:51:34.249Z` to
  `2026-06-22T15:54:34.430Z`
- ignored Mac controller: `10.0.0.46`
- matching HomeKit live negotiations: none
- `partialLines: []`
- mirror log was empty

Interpret this as "no iPhone/Home Garage Door live request reached Argus during
the watcher window", not as a stream failure. It also confirms the passive
watcher can wait without activating Mac Home or changing HomeKit cooldown state.

A second normal-profile Mini watcher was run at `2026-06-22T20:17Z`:

`npm run watch:home:mini -- --timeout-seconds 240 --json-out /tmp/argus-iphone-live-normal-20260622T2017Z.json --mirror-log /tmp/argus-iphone-live-normal-20260622T2017Z.log`

Result:

- timeout after 240s, from `2026-06-22T20:17:03.929Z` to
  `2026-06-22T20:21:04.013Z`
- ignored Mac controller: `10.0.0.46`
- matching HomeKit live negotiations: none
- `partialLines: []`
- mirror log was empty

Interpret this the same way: no non-Mac/iPhone live request reached Argus during
the watcher window. If the Garage Door tile was tapped from iPhone during this
window, the next investigation is Home/iPhone targeting or cached accessory
state, not RTP payload tuning.

The next Mini watcher was run at `2026-06-22T20:22Z`:

`npm run watch:home:mini -- --timeout-seconds 300 --json-out /tmp/argus-iphone-live-normal-20260622T2022Z.json --mirror-log /tmp/argus-iphone-live-normal-20260622T2022Z.log`

Result:

- matched iPhone/Home controller `10.0.0.41`
- negotiated at `2026-06-22T20:24:28.521Z`
- exited at `2026-06-22T20:24:58.562Z`, session duration `30041ms`
- negotiated `1280x720@30`, H.264 high level 4.0, payload type `99`
- Home asked `299k`, Argus served the normal 720p floor of `2000k`
- source `rtsp://127.0.0.1:8554/garage-door-sub`, mode `transcode`
- target/controller both `10.0.0.41`, RTCP via `ffmpeg-localrtcpport`
- controller selected audio, Argus audio enabled, FFmpeg audio leg present,
  AAC-ELD true (`codec=AAC-eld 16kHz ptype=110 source=input`)
- exact-frame padding was active in the FFmpeg command:
  `pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1`
- FFmpeg exit line:
  `2026-06-22T20:24:58.562Z [argus Garage Door] ffmpeg exited code=null signal=SIGKILL`
- visible iPhone result, reported by Peter: spinner for the full 30-second
  session, no live render

Additional Mini log context: before the 20:22 watcher began, the iPhone
controller also opened Garage Door at `2026-06-22T20:13:45.110Z` and was killed
after `30371ms`, then opened two short sessions at `20:14:29.404Z` (`2144ms`)
and `20:14:34.853Z` (`4245ms`). All three selected the same
`1280x720@30` / AAC-ELD / `serving=2000k` profile.

An early iPhone tap occurred before the next cooldown/test profile was ready:
`2026-06-22T20:26:11.760Z` negotiated the same normal
`1280x720@30` / AAC-ELD / `serving=2000k` profile for controller `10.0.0.41`
and was killed at `2026-06-22T20:26:42.180Z` after `30420ms`.

After that, the Mini launchd plist was rewritten for a temporary constrained
720p profile:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_HAP_BIND=en0 ARGUS_LIVE_720P_BITRATE_KBPS=1000 ARGUS_LIVE_KEEP_NEGOTIATED_SIZE=1 ARGUS_LIVE_CBR=1`

Install detail: the first install attempt failed because the non-interactive SSH
shell did not have Homebrew `node` on `PATH`; the retry with
`PATH=/opt/homebrew/bin:$PATH` wrote the plist, then hit the known transient
`Bootstrap failed: 5: Input/output error`. Direct `launchctl bootstrap` of the
written plist succeeded. `launchctl print` then showed pid `99769`, Garage Door
still `live mode: transcode (≥720p source: sub)`, and active envs
`ARGUS_LIVE_720P_BITRATE_KBPS=1000`, `ARGUS_LIVE_KEEP_NEGOTIATED_SIZE=1`,
`ARGUS_LIVE_CBR=1`, `ARGUS_HAP_BIND=en0`, and `ARGUS_LIVE_AAC_ELD=1`.

After the cooldown, the constrained-profile Mini watcher was run at
`2026-06-22T20:36Z`:

`npm run watch:home:mini -- --timeout-seconds 180 --json-out /tmp/argus-iphone-live-1000cbr-20260622T2036Z.json --mirror-log /tmp/argus-iphone-live-1000cbr-20260622T2036Z.log`

Result:

- matched iPhone/Home controller `10.0.0.41`
- negotiated at `2026-06-22T20:37:19.599Z`
- exited at `2026-06-22T20:37:50.026Z`, session duration `30427ms`
- negotiated `1280x720@30`, H.264 high level 4.0, payload type `99`
- Home asked `299k`, Argus served constrained `1000k`
- FFmpeg command confirmed CBR-style shaping:
  `-b:v 1000k -maxrate 1000k -bufsize 1000k`
- exact-frame padding remained active:
  `pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1`
- source `rtsp://127.0.0.1:8554/garage-door-sub`, mode `transcode`
- target/controller both `10.0.0.41`, RTCP via `ffmpeg-localrtcpport`
- controller selected audio, Argus audio enabled, FFmpeg audio leg present,
  AAC-ELD true (`codec=AAC-eld 16kHz ptype=110 source=input`)
- FFmpeg exit line:
  `2026-06-22T20:37:50.026Z [argus Garage Door] ffmpeg exited code=null signal=SIGKILL`
- visible iPhone result, reported by Peter: spinner for the full session, no
  live feed

After the `1000k` CBR spinner result, the Mini launchd plist was rewritten for a
strict Home-ask bitrate test:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_HAP_BIND=en0 ARGUS_LIVE_OBEY_BITRATE=1 ARGUS_LIVE_CBR=1`

The first reinstall again hit the known `Bootstrap failed: 5: Input/output
error` after writing the plist. Direct `launchctl bootstrap` succeeded.
`launchctl print` showed pid `2206`, active envs `ARGUS_LIVE_OBEY_BITRATE=1`,
`ARGUS_LIVE_CBR=1`, `ARGUS_HAP_BIND=en0`, and `ARGUS_LIVE_AAC_ELD=1`, with no
`ARGUS_LIVE_KEEP_NEGOTIATED_SIZE`. Garage Door startup remained
`live mode: transcode (≥720p source: sub)`. This should serve Home's `299k`
ask exactly and let the starved-content fallback send 854x480 content padded
into the negotiated 1280x720 frame.

After the cooldown, the strict-bitrate Mini watcher was run at
`2026-06-22T20:48Z`:

`npm run watch:home:mini -- --timeout-seconds 180 --json-out /tmp/argus-iphone-live-obey-20260622T2048Z.json --mirror-log /tmp/argus-iphone-live-obey-20260622T2048Z.log`

Result:

- matched iPhone/Home controller `10.0.0.41`
- negotiated at `2026-06-22T20:48:37.121Z`
- exited at `2026-06-22T20:49:03.327Z`, session duration `26206ms`
- negotiated `1280x720@30`, H.264 high level 4.0, payload type `99`
- Home asked `299k`, Argus served exactly `299k`
- FFmpeg command confirmed strict CBR-style shaping:
  `-b:v 299k -maxrate 299k -bufsize 299k`
- starved-content fallback was active inside the negotiated frame:
  `scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1`
- source `rtsp://127.0.0.1:8554/garage-door-sub`, mode `transcode`
- target/controller both `10.0.0.41`, RTCP via `ffmpeg-localrtcpport`
- controller selected audio, Argus audio enabled, FFmpeg audio leg present,
  AAC-ELD true (`codec=AAC-eld 16kHz ptype=110 source=input`)
- FFmpeg exit line:
  `2026-06-22T20:49:03.327Z [argus Garage Door] ffmpeg exited code=null signal=SIGKILL`
- visible iPhone result, reported by Peter: spinner only, no live video

## Interpretation

- The fastest path metrics are good up to negotiation: 226-284ms
  click-to-negotiation across the tested profiles.
- The stream payload is locally decodable, and the default Opus A/V receive-side
  validator does not show stream-side clock divergence over 60s.
- The Mac Home verifier still never reaches accepted live playback at 720p; it
  remains stuck at Home's spinner and tears down around the HomeKit 30s timeout,
  even when Argus obeys Home's 299kbps ask.
- The RTCP monitor proves Home is sending video RTCP to Argus's advertised return
  port, but that does not resolve the spinner/timeout behavior.
- Delaying the START callback to 2000ms also did not resolve the spinner/timeout
  behavior; keep the default 500ms for fastest normal operation.
- Matching camera-ffmpeg's 1316-byte video RTP packet size also did not resolve
  the spinner/timeout behavior; keep the default 564-byte hi-res packet size for
  the current jittery WiFi path unless a wired/Mini or iPhone test proves
  otherwise.
- Running the same paired identity from the wired Mini also did not resolve the
  Mac Home spinner/timeout behavior. This removes MacBook-local SRTP loopback and
  host-networking as the sole explanation for the Mac Home failure: the Mini sent
  SRTP over LAN to `10.0.0.46`, and Mac Home still killed the session after
  31.535s.
- Preserving 1280x720 while lowering the Mini-hosted LAN stream to 1000k and
  adding CBR shaping also did not resolve the Mac Home spinner/timeout behavior.
  This makes "2000k capped-CRF is simply too heavy for Mac Home" unlikely as the
  sole root cause.
- Padding Garage Door's 4:3 source to the exact negotiated 1280x720 frame also
  did not resolve the Mac Home spinner/timeline behavior, so frame-size mismatch
  is not the sole root cause either.
- A 640x360 advertised cap is implemented and locally verified, but Mac Home did
  not refresh to that ladder after a `c#` bump. Testing a true capped profile may
  require iPhone/Home refresh behavior, re-pairing Garage Door, or a fresh
  accessory identity. Do not apply that to the other six cameras yet.
- Because video-only, real AAC-ELD, and synthetic-silence AAC-ELD all fail in the
  Mac Home verifier, do not re-pair the other six cameras yet.
- The iPhone/Home path is now confirmed to reach Argus (`10.0.0.41`) and selects
  the same 720p/AAC-ELD shape as Mac Home. If the visible iPhone result was a
  30-second spinner/no-render, the next useful test is a cooldown-respecting
  iPhone run with 720p preserved but bitrate constrained by the existing
  rollback envs, because Home asked for only `299k` while Argus served `2000k`.
- The constrained `1000k` CBR iPhone run also spun for the full 30 seconds, so
  the next useful bitrate test is strict Home-ask obedience (`~299k`) with
  CBR and the starved-content fallback: 854x480 content padded into the
  negotiated 1280x720 frame.
- The strict-bitrate iPhone run successfully exercised that fallback and served
  exactly Home's `299k` ask. If the visible result was still spinner/no-render,
  the next variable to isolate is audio at the iPhone controller path:
  `ARGUS_AUDIO=0`, not another bitrate rung.
- The strict-bitrate iPhone run also spun with no live video, so bitrate and
  720p frame size are not sufficient explanations. Next run should keep strict
  bitrate and remove Argus's audio response/RTP leg with `ARGUS_AUDIO=0`, plus a
  Garage Door `ARGUS_HAP_CONFIG_BUMP` so the iPhone has a chance to refresh the
  changed audio shape.

After that, the Mini launchd plist was rewritten for video-only strict bitrate:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge ARGUS_HAP_BIND=en0 ARGUS_AUDIO=0 ARGUS_LIVE_OBEY_BITRATE=1 ARGUS_LIVE_CBR=1 ARGUS_HAP_CONFIG_BUMP="Garage Door"`

As before, the first reinstall hit `Bootstrap failed: 5: Input/output error`
after writing the plist. Direct `launchctl bootstrap` succeeded. `launchctl
print` then showed pid `3686` with active envs `ARGUS_AUDIO=0`,
`ARGUS_LIVE_OBEY_BITRATE=1`, `ARGUS_LIVE_CBR=1`, `ARGUS_HAP_BIND=en0`, and
`ARGUS_HAP_CONFIG_BUMP=Garage Door`. Startup log confirmed Garage Door stayed
`live mode: transcode (≥720p source: sub)` and forced
`HomeKit configVersion=18`.

After the cooldown, the video-only strict-bitrate Mini watcher was run at
`2026-06-22T20:59Z`:

`npm run watch:home:mini -- --timeout-seconds 180 --json-out /tmp/argus-iphone-live-videoonly-obey-20260622T2059Z.json --mirror-log /tmp/argus-iphone-live-videoonly-obey-20260622T2059Z.log`

Result:

- matched iPhone/Home controller `10.0.0.41`
- negotiated at `2026-06-22T20:59:52.224Z`
- exited at `2026-06-22T21:00:17.982Z`, session duration `25758ms`
- negotiated `1280x720@30`, H.264 high level 4.0, payload type `99`
- Home asked `299k`, Argus served exactly `299k`
- Argus omitted `PrepareStreamResponse.audio`/audio RTP:
  `argusAudioDisabled=true`, `ffmpegAudioLeg=false`, `aacEld=false`
- Home/HAP still selected its fallback audio shape:
  `audio: disabled (controller selected codec=OPUS 24kHz ptype=110)`
- FFmpeg command had no audio leg and strict CBR-style shaping:
  `-b:v 299k -maxrate 299k -bufsize 299k`
- starved-content fallback was active:
  `scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1`
- source `rtsp://127.0.0.1:8554/garage-door-sub`, mode `transcode`
- target/controller both `10.0.0.41`, RTCP via `ffmpeg-localrtcpport`
- FFmpeg exit line:
  `2026-06-22T21:00:17.982Z [argus Garage Door] ffmpeg exited code=null signal=SIGKILL`
- visible iPhone result, reported by Peter: same spinner behavior, no live video

This rules out the AAC-ELD RTP leg as the direct iPhone blocker for this
failure mode. The next high-signal source/profile test is main-source
video-only strict bitrate, because attempt 007's one known 720p iPhone render
was `720p@299k`, main source, video-only, while all current iPhone runs above
were sub-source.

### Last30days research and main-source follow-up

Peter asked whether to research before spending another Home cooldown. Ran the
`last30days` engine with a targeted HomeKit/HAP-NodeJS/FFmpeg/go2rtc plan:

`python3 /Users/peterpine/.agents/skills/last30days/scripts/last30days.py "HomeKit camera live view spinner HAP-NodeJS FFmpeg RTP go2rtc homebridge-camera-ffmpeg" --emit=compact --save-dir="$HOME/Documents/Last30Days" --save-suffix=v3 --plan /tmp/<plan> --auto-resolve --subreddits=homebridge,HomeKit,homeassistant,Scrypted,reolinkcam,selfhosted --github-repo=homebridge/HAP-NodeJS,homebridge-plugins/homebridge-camera-ffmpeg,AlexxIT/go2rtc,koush/scrypted --web-backend auto`

Receipt:

- raw file: `/Users/peterpine/Documents/Last30Days/homekit-camera-live-view-spinner-hap-nodejs-ffmpeg-rtp-go2rtc-homebridge-camera-ffmpeg-raw-v3.md`
- result: thin current community evidence; 6 Reddit threads, 2 X posts, 1
  GitHub project result, no YouTube/HN/Polymarket matches
- appended primary-source supplements from `homebridge-camera-ffmpeg` issues,
  go2rtc HomeKit docs/issues, and HAP-NodeJS docs

High-signal findings:

- `homebridge-camera-ffmpeg` 3.1.4 uses the controller request SRTP key/salt
  for `-srtp_out_params` and echoes those same values in `PrepareStreamResponse`.
  Argus already matches that, so SRTP key direction is not the likely blocker.
- The maintained `homebridge-camera-ffmpeg` streaming delegate sends SRTP with
  `rtcpport=<controller port>&pkt_size=<mtu>` and no FFmpeg `localrtcpport`.
  Argus' iPhone tests above still used `ffmpeg-localrtcpport`, so the iPhone
  path had not yet tested the camera-ffmpeg-style RTCP return-port shape.
- go2rtc HomeKit examples/issues reinforce the same broad shape: H.264 video,
  OPUS audio, Home-selected 1280x720/30 at ~299k, max MTU around 1378, and
  packetization-mode 0 in HAP-NodeJS terms (`NON_INTERLEAVED`).

While the research ran, the staged main-source video-only strict-bitrate profile
was exercised by real Home traffic:

- active env at the time: `ARGUS_AUDIO=0`, `ARGUS_LIVE_OBEY_BITRATE=1`,
  `ARGUS_LIVE_CBR=1`, `ARGUS_LIVE_MAIN_SOURCE=1`
- Home Hub `10.0.0.15` negotiated `640x360@30` at `132k`, then reconfigured to
  `1280x720@30` at `299k` using source `rtsp://127.0.0.1:8554/garage-door`,
  then reconfigured back to `640x360`
- iPhone `10.0.0.41` then negotiated `1280x720@30`, asked/served `299k`,
  source `rtsp://127.0.0.1:8554/garage-door`, video-only, RTCP via
  `ffmpeg-localrtcpport`
- FFmpeg exit:
  `2026-06-22T21:02:29.903Z [argus Garage Door] ffmpeg exited code=null signal=SIGKILL`
- visual result was not reported for this opportunistic session, so treat it as
  transport evidence, not as a trusted pass/fail render verdict

This weakens the theory that attempt 007's known render was explained only by
main-source video. The next test should isolate RTCP return-port shape on the
iPhone path.

### Main-source video-only strict bitrate, Node RTCP monitor

Mini was switched to:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge ARGUS_HAP_BIND=en0 ARGUS_AUDIO=0 ARGUS_LIVE_OBEY_BITRATE=1 ARGUS_LIVE_CBR=1 ARGUS_LIVE_MAIN_SOURCE=1 ARGUS_RTCP_MONITOR=1`

The install wrote the plist but hit the known transient `Bootstrap failed: 5:
Input/output error`; direct `launchctl bootstrap` succeeded. `launchctl print`
confirmed pid `9041` with `ARGUS_RTCP_MONITOR=1`, `ARGUS_LIVE_MAIN_SOURCE=1`,
`ARGUS_AUDIO=0`, strict bitrate, CBR, and `ARGUS_HAP_BIND=en0`.

Started a watcher after the cooldown:

`npm run watch:home:mini -- --timeout-seconds 210 --json-out /tmp/argus-iphone-live-rtcpmonitor-main-videoonly-20260622T2113Z.json --mirror-log /tmp/argus-iphone-live-rtcpmonitor-main-videoonly-20260622T2113Z.log`

Result:

- started `2026-06-22T21:13:00.954Z`
- timed out `2026-06-22T21:16:31.154Z`
- ignored Mac controller `10.0.0.46`
- `partialLines: []`
- error: timed out waiting for a matching HomeKit live negotiation

Interpretation: no non-Mac/iPhone live request reached Argus during that
watcher window. This is a no-trigger receipt, not a live-render failure.

On `2026-06-23T12:31Z`, the same RTCP-monitor profile was tested again with
Peter watching the iPhone:

`npm run watch:home:mini -- --timeout-seconds 210 --json-out /tmp/argus-iphone-live-rtcpmonitor-main-videoonly-20260623T1231Z.json --mirror-log /tmp/argus-iphone-live-rtcpmonitor-main-videoonly-20260623T1231Z.log`

Result:

- matched iPhone/Home controller `10.0.0.41`
- negotiated at `2026-06-23T12:31:12.413Z`
- exited at `2026-06-23T12:31:30.263Z`, session duration `17850ms`
- negotiated `1280x720@30`, H.264 high level 4.0, payload type `99`
- Home asked `299k`, Argus served exactly `299k`
- Argus omitted `PrepareStreamResponse.audio`/audio RTP:
  `argusAudioDisabled=true`, `ffmpegAudioLeg=false`, `aacEld=false`
- source `rtsp://127.0.0.1:8554/garage-door`, mode `transcode`
- RTCP mode was `node-monitor:62973`
- FFmpeg RTP URL omitted `localrtcpport`:
  `srtp://10.0.0.41:53578?rtcpport=53578&pkt_size=564`
- RTCP monitor receipt:
  `RTCP monitor video packets=63 port=62973`
- FFmpeg exit line:
  `2026-06-23T12:31:30.263Z [argus Garage Door] ffmpeg exited code=null signal=SIGKILL`
- visible iPhone result, reported by Peter: no live video, spinner, then No
  Response screen

Home immediately retried once more outside the watcher capture:

- negotiated at `2026-06-23T12:31:34.282Z`
- same profile: `1280x720@30`, source `rtsp://127.0.0.1:8554/garage-door`,
  video-only, asked/served `299k`, `rtcp=node-monitor:54053`
- RTCP monitor receipt:
  `RTCP monitor video packets=110 port=54053`
- exited at `2026-06-23T12:32:04.866Z`, normal ~30s timeout

This rules out the camera-ffmpeg-style RTCP return-port shape as the direct
blocker. The iPhone receives enough media to send RTCP receiver reports, but
still refuses to render the transcoded H.264 stream.

### Copy-mode diagnostic staged

After the RTCP-monitor failure, Mini was switched during cooldown to:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge ARGUS_HAP_BIND=en0 ARGUS_AUDIO=0 ARGUS_LIVE_COPY=1 ARGUS_RTCP_MONITOR=1 ARGUS_HAP_CONFIG_BUMP="Garage Door"`

The install again wrote the plist but hit the known transient `Bootstrap failed:
5: Input/output error`; direct `launchctl bootstrap` succeeded.
`launchctl print` confirmed pid `35133` with active envs
`ARGUS_LIVE_COPY=1`, `ARGUS_AUDIO=0`, `ARGUS_RTCP_MONITOR=1`,
`ARGUS_HAP_CONFIG_BUMP=Garage Door`, and `ARGUS_HAP_BIND=en0`. Startup logs
confirmed Garage Door `live mode: copy` and forced HomeKit `configVersion=19`.

After the cooldown, the copy-mode watcher was run at `2026-06-23T12:42Z`:

`npm run watch:home:mini -- --timeout-seconds 210 --json-out /tmp/argus-iphone-live-copy-videoonly-20260623T1242Z.json --mirror-log /tmp/argus-iphone-live-copy-videoonly-20260623T1242Z.log`

Result:

- matched iPhone/Home controller `10.0.0.41`
- negotiated at `2026-06-23T12:44:13.914Z`
- exited at `2026-06-23T12:44:15.188Z`, session duration `1274ms`
- Home still selected cached `1280x720@30`, H.264 high level 4.0, payload type
  `99`, despite copy mode forcing Garage Door `configVersion=19`
- mode `copy`, source `rtsp://127.0.0.1:8554/garage-door-sub`
- Home asked `299k`, Argus log's effective floor still said `serving=2000k`
  because copy mode does not control camera bitrate
- Argus omitted `PrepareStreamResponse.audio`/audio RTP:
  `argusAudioDisabled=true`, `ffmpegAudioLeg=false`, `aacEld=false`
- FFmpeg command used H.264 passthrough:
  `-c:v copy`
- FFmpeg RTP URL omitted `localrtcpport`:
  `srtp://10.0.0.41:65375?rtcpport=65375&pkt_size=564`
- RTCP monitor receipt:
  `RTCP monitor video packets=2 port=62087`
- FFmpeg exit line:
  `2026-06-23T12:44:15.188Z [argus Garage Door] ffmpeg exited code=null signal=SIGKILL`
- visible iPhone result, reported by Peter: live video appeared pretty quickly

The first copy-mode watcher ended after 1.274s because Home stopped that
session, but Peter confirmed video rendered quickly. A second copy-mode hold
watcher was started:

`npm run watch:home:mini -- --timeout-seconds 120 --json-out /tmp/argus-iphone-live-copy-hold-20260623T1245Z.json --mirror-log /tmp/argus-iphone-live-copy-hold-20260623T1245Z.log`

Result:

- matched iPhone/Home controller `10.0.0.41`
- negotiated at `2026-06-23T12:46:05.987Z`
- watcher timed out at `2026-06-23T12:47:37.302Z` waiting for the active live
  session to exit, which is positive: Home did not kill the copy-mode stream
  inside the 120s watcher window
- follow-up Mini log showed the session ended at `2026-06-23T12:48:03.245Z`,
  for about `117s` of active FFmpeg runtime
- RTCP monitor receipt:
  `RTCP monitor video packets=234 port=54325`
- visible result, reported by Peter while active: "I have had the live stream
  going for a while now"
- Peter later confirmed he backed out manually; Home did not end the long-hold
  copy-mode stream on its own.

Interpretation: copy mode is a valid live-render path for Garage Door. It is
not the intended final high-resolution profile because it copies the 640x480
substream while Home still requests the cached 1280x720 profile, but it proves
HAP pairing, SRTP delivery, iPhone routing, RTCP, and HomeKit live plumbing are
all viable. The remaining blocker is specifically Argus's transcoded H.264
output shape.

### Main-source transcode without exact-frame padding

After copy mode proved the HomeKit path, Mini was switched to a main-source
video-only transcode that preserved the 4:3 camera aspect ratio instead of
padding the output into Home's cached 1280x720 frame:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge ARGUS_HAP_BIND=en0 ARGUS_AUDIO=0 ARGUS_LIVE_MAIN_SOURCE=1 ARGUS_RTCP_MONITOR=1 ARGUS_LIVE_EXACT_FRAME=0 ARGUS_LIVE_OBEY_BITRATE=1 ARGUS_LIVE_CBR=1`

Watcher:

`npm run watch:home:mini -- --timeout-seconds 120 --json-out /tmp/argus-iphone-live-transcode-fitonly-videoonly-20260623T1250Z.json --mirror-log /tmp/argus-iphone-live-transcode-fitonly-videoonly-20260623T1250Z.log`

Result:

- matched iPhone/Home controller `10.0.0.41`
- negotiated at `2026-06-23T12:52:18.907Z`
- Mini log later showed exit at `2026-06-23T12:53:52.125Z`
- negotiated `1280x720@30`, H.264 high level 4.0, payload type `99`
- Home asked `299k`, Argus served exactly `299k`
- mode `transcode`, source `rtsp://127.0.0.1:8554/garage-door`
- FFmpeg filter omitted the 1280x720 pad:
  `scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`
- Argus omitted `PrepareStreamResponse.audio`/audio RTP:
  `argusAudioDisabled=true`, `ffmpegAudioLeg=false`, `aacEld=false`
- RTCP monitor receipt:
  `RTCP monitor video packets=186 port=64771`
- visible iPhone result, reported by Peter: live video rendered, but the image
  was softer than before and the pixels appeared to pulse/focus on a regular
  cadence

Interpretation: removing exact-frame 1280x720 padding makes Argus's x264 output
render in Home. The pulsing is likely the strict `299k` CBR cap and/or long
keyframe cadence starving a 4:3 main-stream transcode, not the HAP/SRTP path.

### Main-source fit-only transcode at LAN floor

To isolate bitrate starvation from geometry, Mini was then switched to the same
main-source fit-only video path but without `ARGUS_LIVE_OBEY_BITRATE=1` or
`ARGUS_LIVE_CBR=1`, leaving Argus at the LAN quality floor while still omitting
exact-frame padding:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge ARGUS_HAP_BIND=en0 ARGUS_AUDIO=0 ARGUS_LIVE_MAIN_SOURCE=1 ARGUS_RTCP_MONITOR=1 ARGUS_LIVE_EXACT_FRAME=0`

Watcher:

`npm run watch:home:mini -- --timeout-seconds 120 --json-out /tmp/argus-iphone-live-transcode-fitonly-2000k-20260623T1300Z.json --mirror-log /tmp/argus-iphone-live-transcode-fitonly-2000k-20260623T1300Z.log`

Result:

- matched iPhone/Home controller `10.0.0.41`
- negotiated at `2026-06-23T12:57:53.286Z`
- exited at `2026-06-23T12:58:03.462Z`, session duration `10176ms`
- negotiated `1280x720@30`, H.264 high level 4.0, payload type `99`
- Home asked `299k`, Argus served `2000k`
- mode `transcode`, source `rtsp://127.0.0.1:8554/garage-door`
- FFmpeg filter again omitted exact-frame padding:
  `scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`
- Argus omitted `PrepareStreamResponse.audio`/audio RTP:
  `argusAudioDisabled=true`, `ffmpegAudioLeg=false`, `aacEld=false`
- RTCP monitor receipt:
  `RTCP monitor video packets=37 port=53924`
- visible iPhone result, reported by Peter: no live stream, just spinner

Home immediately retried outside the watcher capture:

- negotiated at `2026-06-23T12:58:08.035Z`
- same profile: main-source fit-only video, `1280x720@30`, asked `299k`,
  served `2000k`, `rtcp=node-monitor:57009`, audio disabled
- RTCP monitor receipt:
  `RTCP monitor video packets=110 port=57009`
- exited at `2026-06-23T12:58:38.643Z`, the normal ~30s spinner timeout

This is the high-signal comparison against the previous 299k fit-only run. If
the `299k` run rendered but pulsed while the uncapped `2000k` run spun, the
important variable is actual output geometry: the `299k` starved path used an
`854x480` content box and produced a roughly `640x480` 4:3 stream, while the
uncapped path used a full `1280x720` content box and produced a roughly
`960x720` 4:3 stream. The next test should force the previously-rendering
content geometry while keeping the higher LAN bitrate floor.

### Forced-content-resolution diagnostic

Added a narrow rollback/diagnostic env:

- `ARGUS_LIVE_CONTENT_RESOLUTION=WxH` forces the live transcode content scale
  independently from bitrate, before the existing exact-frame/fit-only filter.
- `scripts/install-launchd.sh` now passes it through to launchd.
- New unit coverage confirms `ARGUS_LIVE_CONTENT_RESOLUTION=854x480` can
  coexist with a `2000k` maxrate and does not force CBR.

Verification:

- local `npm run build`: passed
- local `npm test -- tests/homekit.test.ts`: passed, 41 tests
- local `npm test`: passed, 75 tests
- Mini `npm test -- tests/homekit.test.ts`: passed, 41 tests
- Mini `npm run build`: passed

After the failed `2000k` large-frame attempt, Mini was staged for the next
cooldown-safe test:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge ARGUS_HAP_BIND=en0 ARGUS_AUDIO=0 ARGUS_LIVE_MAIN_SOURCE=1 ARGUS_RTCP_MONITOR=1 ARGUS_LIVE_EXACT_FRAME=0 ARGUS_LIVE_CONTENT_RESOLUTION=854x480`

The install wrote the plist but hit the recurring `Bootstrap failed: 5:
Input/output error`; direct `launchctl bootstrap` of
`~/Library/LaunchAgents/dev.point-labs.argus.plist` succeeded. `launchctl
print` confirmed active envs including `ARGUS_LIVE_CONTENT_RESOLUTION=854x480`,
`ARGUS_LIVE_EXACT_FRAME=0`, `ARGUS_LIVE_MAIN_SOURCE=1`, `ARGUS_AUDIO=0`,
`ARGUS_RTCP_MONITOR=1`, and `ARGUS_HAP_BIND=en0`.

Cooldown note: the latest failed Home retry ended at
`2026-06-23T12:58:38.643Z`; do not trust another iPhone/Home result before
`2026-06-23T13:08:38Z`.

After cooldown, the forced-content watcher was run:

`npm run watch:home:mini -- --timeout-seconds 150 --json-out /tmp/argus-iphone-live-transcode-forced854-2000k-20260623T1309Z.json --mirror-log /tmp/argus-iphone-live-transcode-forced854-2000k-20260623T1309Z.log`

First session:

- matched iPhone/Home controller `10.0.0.41`
- negotiated at `2026-06-23T13:09:57.665Z`
- exited at `2026-06-23T13:09:58.713Z`, session duration `1048ms`
- negotiated `1280x720@30`, H.264 high level 4.0, payload type `99`
- Home asked `299k`, Argus served `2000k`
- mode `transcode`, source `rtsp://127.0.0.1:8554/garage-door`
- FFmpeg filter forced the previously-rendering content geometry without
  exact-frame padding:
  `scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`
- Argus omitted `PrepareStreamResponse.audio`/audio RTP:
  `argusAudioDisabled=true`, `ffmpegAudioLeg=false`, `aacEld=false`
- RTCP monitor receipt:
  `RTCP monitor video packets=2 port=61476`

Home immediately retried:

- negotiated at `2026-06-23T13:09:59.772Z`
- same profile: forced `854x480` content, `serving=2000k`, main source,
  video-only, `rtcp=node-monitor:51172`
- visible iPhone result, reported by Peter: "it is back"
- follow-up process check at `2026-06-23T13:12:10Z` showed the FFmpeg process
  still active, so the second forced-content transcode held for more than two
  minutes at that point
- Mini log later showed the session ended at `2026-06-23T13:12:26.412Z`
  with `RTCP monitor video packets=293 port=51172`, for about `146.6s` of
  active runtime

Peter then clicked back into Garage Door:

- negotiated at `2026-06-23T13:12:30.708Z`
- same forced `854x480` content / `2000k` / main-source / video-only profile
- visible iPhone result, reported by Peter: live stream came up fast
- follow-up process check at `2026-06-23T13:14:18Z` showed the new FFmpeg
  session still active, so fast re-entry also held for at least `~108s`
- Peter later closed the stream after it ran the full time. Mini log showed
  exit at `2026-06-23T13:15:42.909Z` with
  `RTCP monitor video packets=384 port=50541`, for about `192.2s` of active
  runtime.

Interpretation: forced `854x480` content at the LAN bitrate floor is the first
stable main-source transcode profile observed on the iPhone in this attempt.
This confirms the large actual H.264 output frame (`~960x720`) was the spinner
trigger, while the smaller actual frame can render and hold when it is not
starved to `299k`.

## Next steps

1. Capture Peter's quality report for the forced `854x480` / `2000k` run,
   especially whether the regular pulsing/focus cadence is gone.
2. If it renders cleanly, treat forced `854x480` content at the LAN floor as the
   current best Garage Door video-only profile and then restore AAC-ELD audio on
   that geometry.
3. If it still pulses, test the same geometry with a shorter keyframe interval
   or stricter x264 compatibility flags before restoring audio.
4. If it starts spinning again, restore copy mode as the rollback-good live profile and
   test stricter x264 compatibility settings at the known-rendering geometry. Do
   not re-pair the other six cameras yet.
5. The Mac-local failures now cover video-only, AAC-ELD camera audio,
   AAC-ELD silence at the LAN floor, AAC-ELD silence obeying Home's bitrate,
   1316-byte video RTP packets, a Mini-hosted LAN SRTP run, Mini-hosted
   preserved-720p 1000k CBR, and an attempted 640x360 advertised cap that Mac
   Home ignored by continuing to request cached 720p. Further Mac retries are
   lower value than iPhone/Home Hub evidence.
6. Only after Garage Door passes stable high-res live should the other six
   cameras be re-paired and verified.

### Forced-content profile with AAC-ELD audio

Mini was switched from video-only to the same forced-content video geometry with
AAC-ELD audio restored:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge ARGUS_HAP_BIND=en0 ARGUS_LIVE_MAIN_SOURCE=1 ARGUS_RTCP_MONITOR=1 ARGUS_LIVE_EXACT_FRAME=0 ARGUS_LIVE_CONTENT_RESOLUTION=854x480 ARGUS_LIVE_AAC_ELD=1`

The install wrote the plist but again hit `Bootstrap failed: 5: Input/output
error`; direct `launchctl bootstrap` succeeded. `launchctl print` confirmed no
`ARGUS_AUDIO=0`, plus active `ARGUS_LIVE_AAC_ELD=1`,
`ARGUS_LIVE_CONTENT_RESOLUTION=854x480`, `ARGUS_LIVE_EXACT_FRAME=0`,
`ARGUS_LIVE_MAIN_SOURCE=1`, and `ARGUS_HAP_BIND=en0`.

Watcher:

`npm run watch:home:mini -- --timeout-seconds 150 --json-out /tmp/argus-iphone-live-transcode-forced854-aaceld-20260623T1317Z.json --mirror-log /tmp/argus-iphone-live-transcode-forced854-aaceld-20260623T1317Z.log`

Result:

- matched iPhone/Home controller `10.0.0.41`
- negotiated at `2026-06-23T13:17:22.743Z`
- watcher timed out at `2026-06-23T13:19:25.787Z` waiting for the active
  session to exit, which is positive: Home did not kill the audio-enabled stream
  inside the 150s watcher window
- negotiated `1280x720@30`, H.264 high level 4.0, payload type `99`
- Home asked `299k`, Argus served `2000k`
- mode `transcode`, source `rtsp://127.0.0.1:8554/garage-door`
- FFmpeg filter forced the same stable content geometry:
  `scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`
- audio was restored and negotiated as AAC-ELD:
  `audio: codec=AAC-eld 16kHz ptype=110 source=input`
- FFmpeg command used `libfdk_aac -profile:a aac_eld -flags +global_header`
- visible iPhone result, reported by Peter: video came up fast with audio
- Peter closed the session; Mini log showed exit at
  `2026-06-23T13:19:43.118Z` with
  `RTCP monitor video packets=280 port=58763`, for about `140.4s` of active
  runtime

Interpretation: Garage Door live now has a stable audio-enabled Argus transcode
profile on iPhone/Home: main source, forced `854x480` content, fit-only output,
`2000k` cap, AAC-ELD input audio. This should be treated as the current
rollback-good Garage Door live profile while deciding whether to turn the
diagnostic envs into product defaults or a per-camera tuned setting.

### Config-driven Garage Door tuning

Converted the two previously global live-geometry knobs into per-camera config
options so Garage Door can keep the proven profile without constraining every
camera that will be re-paired later:

- `cameras[].liveContentResolution: "854x480"` parses to
  `{ width: 854, height: 480 }`
- `cameras[].liveExactFrame: false` disables exact-frame padding for that camera
- `ARGUS_LIVE_CONTENT_RESOLUTION` and `ARGUS_LIVE_EXACT_FRAME` remain global
  env overrides for rollback/diagnostics
- startup now logs the per-camera live mode as
  `content=854x480, fit-only`

Added tests for config parsing, per-camera FFmpeg content scale, per-camera
fit-only output, and env override precedence.

Garage Door was updated in the gitignored `argus.yaml` on both the working repo
and Mini with:

```yaml
liveContentResolution: 854x480
liveExactFrame: false
```

Mini was restarted without global `ARGUS_LIVE_CONTENT_RESOLUTION` or
`ARGUS_LIVE_EXACT_FRAME` envs:

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge ARGUS_HAP_BIND=en0 ARGUS_LIVE_MAIN_SOURCE=1 ARGUS_RTCP_MONITOR=1 ARGUS_LIVE_AAC_ELD=1`

Receipts:

- `launchctl print` env showed no global content/exact-frame envs
- startup log confirmed:
  `[argus Garage Door] live mode: transcode (≥720p source: main, content=854x480, fit-only)`
- Mini config parse confirmed Garage Door:
  `{"liveContentResolution":{"width":854,"height":480},"liveExactFrame":false}`

First config-based watcher:

`npm run watch:home:mini -- --timeout-seconds 150 --json-out /tmp/argus-iphone-live-config-forced854-aaceld-20260623T1328Z.json --mirror-log /tmp/argus-iphone-live-config-forced854-aaceld-20260623T1328Z.log`

Result: timed out after 150s with `partialLines: []`. No iPhone live request
reached Argus; treat this as a no-trigger receipt, not a stream failure.

Second config-based watcher:

`npm run watch:home:mini -- --timeout-seconds 180 --json-out /tmp/argus-iphone-live-config-forced854-aaceld-20260623T1330Z.json --mirror-log /tmp/argus-iphone-live-config-forced854-aaceld-20260623T1330Z.log`

Result:

- matched iPhone/Home controller `10.0.0.41`
- negotiated at `2026-06-23T13:31:02.185Z`
- exited at `2026-06-23T13:32:18.207Z`, session duration `76022ms`
- negotiated `1280x720@30`, H.264 high level 4.0, payload type `99`
- Home asked `299k`, Argus served `2000k`
- mode `transcode`, source `rtsp://127.0.0.1:8554/garage-door`
- FFmpeg command confirmed config-driven fit-only content geometry:
  `scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`
- audio enabled and negotiated as AAC-ELD:
  `audio: codec=AAC-eld 16kHz ptype=110 source=input`
- FFmpeg command used `libfdk_aac -profile:a aac_eld -flags +global_header`
- RTCP monitor receipt:
  `RTCP monitor video packets=152 port=62731`
- visible iPhone result, reported by Peter: pretty fast; about two or three
  spinner revolutions, then the live feed came in

Interpretation: the config-driven Garage Door profile preserves the proven
behavior without depending on global content/exact-frame envs. Garage Door live
view is now stable enough to stop geometry debugging and move to production
cleanup: decide whether to keep RTCP monitor enabled or return to FFmpeg-managed
local RTCP, then re-run a final hold on the chosen launchd profile before
re-pairing the other six cameras.

## Current Garage Door Profile

Garage Door is currently running on Mini with:

- gitignored camera config:
  `liveContentResolution: 854x480`, `liveExactFrame: false`
- launchd env:
  `ARGUS_HUB_ADDRESSES=10.0.0.15`
  `ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge`
  `ARGUS_HAP_BIND=en0`
  `ARGUS_LIVE_MAIN_SOURCE=1`
  `ARGUS_RTCP_MONITOR=1`
  `ARGUS_LIVE_AAC_ELD=1`
- no global `ARGUS_LIVE_CONTENT_RESOLUTION`
- no global `ARGUS_LIVE_EXACT_FRAME`

Verification after the per-camera config work:

- local `npm run build`: passed
- local `npm test`: passed, 81 tests
- Mini `npm run build`: passed
- Mini `npm test -- tests/config.test.ts tests/homekit.test.ts`: passed, 50 tests
- Mini config parse confirmed:
  `{"name":"Garage Door","liveContentResolution":{"width":854,"height":480},"liveExactFrame":false}`
- startup log confirmed:
  `[argus Garage Door] live mode: transcode (≥720p source: main, content=854x480, fit-only)`

Next operational step: keep Garage Door on this profile as the rollback-good
daily-driver live path. If no further Garage Door issues appear, the next phase
is to re-pair the other six cameras one at a time and verify snapshot, fast live
open, motion/HKSV clip, and Apple labels per camera.
