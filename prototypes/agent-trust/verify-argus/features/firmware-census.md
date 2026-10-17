# Firmware census

The census walks PR 3 and the firmware commits on `src/homekit.ts`. A step is churn when the ladder, profiles, and codecs at the start of the next version match the start of the previous version.

## Sub-features

- `census-pr3` prints `pr3_churn` and `pr3_justified`.
- `census-main` prints `AD_SAME` or `AD_CHANGED` for each firmware commit on main.

## How to get to it (user POV)

- An agent edits `ARGUS_FIRMWARE_REVISION` in `src/homekit.ts`.
- The same edit is what a later CI gate will reject when the advertisement did not change.
- Nobody runs this against the Mini.

## Driving it with the local contract

Preconditions:

- Doctor printed `doctor=ok`.
- `gh` can read `point-labs-dev/argus` pull 3 commits, and the PR 3 commit objects are present locally.

- **Run the census.** Run `python3 prototypes/agent-trust/firmware-census.py > prototypes/agent-trust/evidence/firmware-census.txt`. Exit code 0. The file contains `pr3_churn` and `pr3_justified`.
- **Proof.** Keep that text file. Do not treat a churn line as a license to bump the constant.

## Gotchas

- A squash merge hides the intermediate versions on main. The PR 3 list is the record of those field rounds.
- `AD_CHANGED` on the squash commit compares 1.1.0 with 1.3.13. It does not make the intermediate churn justified.
