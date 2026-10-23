# Firmware census

The census compares the firmware string with the advertised ladder, profiles, and codecs. A bump is churn when those lines stay the same. The prototype record of pull request 3 named that class `pr3_churn`: twelve version steps did not change the advertisement.

An advertisement change that leaves `ARGUS_FIRMWARE_REVISION` in place is `stale`. The census exits 1. The string in this tree stays `1.3.16`.

## Sub-features

- `census-churn` is a firmware string change with the same ladder, profiles, and codecs. The historical case is `6117635239cb0e5bdcbd877160fe877967a1d99e`, 1.3.6 to 1.3.7.
- `census-justified` is a bump that changes the ladder, the profile list, or the codec list.
- `census-stale` is an advertised-ladder change with the same firmware string. The fixture edits the ladder and leaves the string at 1.3.16. The census exits 1.
- `census-recording-offer` is a change to `buildRecordingOptions` in `src/recording.ts` while the live advertisement and the firmware string stay put. The census writes a warning to stderr and exits 0.

## How to get to it (user POV)

- An agent edits `ARGUS_FIRMWARE_REVISION` in `src/homekit.ts`.
- The pull-request census rejects that edit when the advertisement did not change.
- An agent edits the advertised ladder in `buildCameraControllerOptions` and leaves `ARGUS_FIRMWARE_REVISION` at 1.3.16.
- The pull-request census rejects that edit.
- An agent edits the recording offer in `src/recording.ts` and leaves the live advertisement alone.
- The pull-request census warns and exits 0.
- Nobody runs this against the Mini.

## Driving it with the local contract

Preconditions:

- Doctor printed `doctor=ok`.
- `scripts/firmware-census.mjs` is in the tree. That file arrives with the CI change.
- The churn commit object is present. The CI checkout fetches full history.

- **Run the census.** Run `node scripts/firmware-census.mjs --commit 6117635239cb0e5bdcbd877160fe877967a1d99e > .cursor/skills/verify-argus/evidence/firmware-census.txt`. Exit code 1. The file contains `verdict=churn`.
- **Run the stale and recording fixtures.** Run `npx vitest run tests/firmware-census.test.ts`. The ladder fixture that leaves the firmware string at 1.3.16 exits 1. The unchanged tree exits 0. The recording-offer-only diff warns and exits 0.
- **Proof.** Keep that text file. A churn line is not a license to bump the constant. `pr3_churn` is the historical count this gate is here to stop repeating. A stale line is not a license to edit the ladder without a bump.

## Gotchas

- If `scripts/firmware-census.mjs` is absent, the command fails. Report that failure. Do not point the command at a prototype.
- A squash merge hides the intermediate versions on main. The commit named above is one churn step, not the whole pull request.
- Exit 1 on that commit is the passing observation for churn. Exit 0 on a clean tree means the working firmware matches the base.
- `advertisement()` compares filtered source text. A rename inside `buildCameraControllerOptions` changes that text, so the census fails when the firmware string stays the same. That failure stays.
- A recording-offer change in `src/recording.ts` is not a live-ladder change. The warning does not fail CI.
- No Mini command is required. Nothing in this check runs on the Mini.
