---
name: verify-argus
description: >-
  Local checks for Argus stream setup. Use when a change touches HomeKit
  prepareStream, ffmpeg live args, firmware revision, or camera aspect.
  It typechecks this repo and drives the stream-setup contract. Do not
  contact the Mini.
---

# Verify Argus

This skill drives local checks. It does not open Apple Home and it does not contact the Mini.

## Launch

There is no server to keep up. From the repo root, compile once.

```
npx tsc -p tsconfig.json --noEmit
```

Ready when that command exits 0. Teardown is nothing, because the command exits on its own.

## Doctor

Run `bash .cursor/skills/verify-argus/doctor.sh` from the repo root.

Ready output ends with `doctor=ok` and `mini=not-contacted`. The script exits 1 when `src/timing.ts` differs from `origin/main`. It runs `tsc` on `src` only. It does not open a remote shell, reboot, or install a LaunchAgent.

## Drive

Run the contract test, the firmware census, and the optional-property probe. Do not invent an iPhone result from a log line.

HAP setup, from the repo root:

```
npx vitest run tests/hap-setup-contract.test.ts > .cursor/skills/verify-argus/evidence/hap-setup.txt
```

Firmware census, from the repo root:

```
node scripts/firmware-census.mjs --commit 6117635239cb0e5bdcbd877160fe877967a1d99e > .cursor/skills/verify-argus/evidence/firmware-census.txt
```

Exact optional probe, from the repo root:

```
node .cursor/skills/verify-argus/exact-optional-probe.mjs > .cursor/skills/verify-argus/evidence/exact-optional.json
```

## Evidence

Write proof under `.cursor/skills/verify-argus/evidence/`. Keep the command, the exit code, and the text the command printed. A `live_session_first_frame` line is not a pass for the picture. The iPhone check stays with Peter. A passing local contract is not an iPhone session.

The safe path does not open a socket to a camera and does not load a LaunchAgent. Confirm that by the doctor line `mini=not-contacted`.

## Cleanup

This skill starts no daemon. Cleanup is `echo cleanup=noop`. Do not delete `.cursor/skills/verify-argus/evidence/`.

## Helpers

`.cursor/skills/verify-argus/doctor.sh` is the doctor. Run it as `bash .cursor/skills/verify-argus/doctor.sh` from the repo root.

`.cursor/skills/verify-argus/exact-optional-probe.mjs` compiles the bad assignment and the omitted property. The feature file names the command.
