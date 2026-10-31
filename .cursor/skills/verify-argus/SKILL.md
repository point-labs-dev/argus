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

`./verify` is the entry point. From the repo root it runs this skill's doctor, the exact-optional drive, both typechecks, the test suite, and lint.

Keep this map honest with the maintain-verification-skill pass.

## Launch

There is no server to keep up. From the repo root, install dependencies once with `npm ci`. Then compile.

```
npx tsc -p tsconfig.json --noEmit
```

Ready when that command exits 0. Teardown is nothing, because the command exits on its own. Each drive is a new process.

## Doctor

Run `bash .cursor/skills/verify-argus/doctor.sh` from the repo root.

Ready output ends with `doctor=ok` and `mini=not-contacted`. The script exits 1 when the timing file differs from `origin/main:src/timing.ts`. `ARGUS_TIMING_FILE` selects that file and defaults to `src/timing.ts`. It checks `argus.example.yaml` for `aspect` and `host` on every camera (`ARGUS_DOCTOR_CONFIG` selects another file). A removed host does not print `doctor=ok`. It checks that audio-off advertises no codecs and omits audio from the prepareStream answer (`ARGUS_HOMEKIT_FILE` selects the source, default `src/homekit.ts`). It runs `npx tsc -p tsconfig.json --noEmit`. It does not open a remote shell, a camera socket, or a LaunchAgent.

## Drive

Run the contract test, the firmware census, and the optional-property probe. Do not invent an iPhone result from a log line.

HAP setup, from the repo root:

```
mkdir -p .cursor/skills/verify-argus/evidence
npx vitest run tests/hap-setup-contract.test.ts > .cursor/skills/verify-argus/evidence/hap-setup.txt
```

The firmware census script is `scripts/firmware-census.mjs` in this tree. CI runs that script against the pull request base. This skill does not vendor a second copy.

Firmware census, from the repo root:

```
mkdir -p .cursor/skills/verify-argus/evidence
node scripts/firmware-census.mjs --commit 6117635239cb0e5bdcbd877160fe877967a1d99e > .cursor/skills/verify-argus/evidence/firmware-census.txt
```

That commit is the churn step from 1.3.6 to 1.3.7. Exit 1 and `verdict=churn` are the passing observation for that step.

Exact optional probe, from the repo root:

```
mkdir -p .cursor/skills/verify-argus/evidence
node .cursor/skills/verify-argus/exact-optional-probe.mjs > .cursor/skills/verify-argus/evidence/exact-optional.json
```

`./verify` runs this probe as its one mapped drive.

## Evidence

Write proof under `.cursor/skills/verify-argus/evidence/`. Keep the command, the exit code, and the text the command printed. A `live_session_first_frame` line is not a pass for the picture. The iPhone check stays with Peter. A passing local contract is not an iPhone session.

The safe path does not open a socket to a camera and does not load a LaunchAgent. Confirm that by the doctor line `mini=not-contacted`.

## Cleanup

This skill starts no daemon. Cleanup is `echo cleanup=noop`. Do not delete `.cursor/skills/verify-argus/evidence/`.

## Helpers

`.cursor/skills/verify-argus/doctor.sh` is the doctor. Run it as `bash .cursor/skills/verify-argus/doctor.sh` from the repo root.

`.cursor/skills/verify-argus/exact-optional-probe.mjs` compiles the bad assignment and the omitted property. The feature file names the command.
