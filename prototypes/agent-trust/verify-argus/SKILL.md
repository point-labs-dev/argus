---
name: verify-argus
description: >-
  Prototype local checks for Argus stream setup. Use when a change touches
  HomeKit prepareStream, ffmpeg live args, firmware revision, or camera aspect.
  It checks TypeScript in this repo and the contract script. Do not deploy,
  SSH, or drive the Mini.
---

# Verify Argus

Prototype. Not the change to merge. This skill drives local checks. It does not open Apple Home and it does not contact the Mini.

## Launch

There is no server to keep up. From the repo root, compile once.

```
npx tsc -p tsconfig.json --noEmit
```

Ready when that command exits 0. Teardown is nothing, because the command exits on its own.

## Doctor

Run `prototypes/agent-trust/verify-argus/doctor.sh` from the repo root.

Ready output ends with `doctor=ok` and `mini=not-contacted`. The script exits 1 when `src/timing.ts` differs from `origin/main`. It runs `tsc` on `src` only. It does not SSH, reboot, or deploy.

## Drive

Run `npx tsx` on the contract script, and `python3` on the firmware census. Do not invent an iPhone result from a log line.

HAP setup, from the repo root:

```
npx tsx prototypes/agent-trust/hap-setup-contract.ts > prototypes/agent-trust/evidence/hap-setup.json
```

Firmware census, from the repo root:

```
python3 prototypes/agent-trust/firmware-census.py > prototypes/agent-trust/evidence/firmware-census.txt
```

Exact optional probe, from the repo root:

```
node prototypes/agent-trust/exact-optional-probe.mjs > prototypes/agent-trust/evidence/exact-optional.json
```

## Evidence

Write proof under `prototypes/agent-trust/evidence/`. Keep the command, the exit code, and the JSON or text the command printed. A `live_session_first_frame` line is not a painted picture. A passing local contract is not an iPhone session. Do not mark a picture check passed from logs alone.

The safe path does not open a socket to a camera and does not load a LaunchAgent. Confirm that by the doctor line `mini=not-contacted` and by the absence of any `ssh` invocation in this skill.

## Cleanup

This skill starts no daemon. Cleanup is `echo cleanup=noop`. Do not delete `prototypes/agent-trust/evidence/`.

## Helpers

`prototypes/agent-trust/verify-argus/doctor.sh` is the doctor. Run it as `bash prototypes/agent-trust/verify-argus/doctor.sh` from the repo root.
