# Firmware census

The census compares the firmware string with the advertised ladder, profiles, and codecs. A bump is churn when those lines stay the same. The prototype record of pull request 3 named that class `pr3_churn`: twelve version steps did not change the advertisement.

## Sub-features

- `census-churn` is a firmware string change with the same ladder, profiles, and codecs. The historical case is `6117635239cb0e5bdcbd877160fe877967a1d99e`, 1.3.6 to 1.3.7.
- `census-justified` is a bump that changes the ladder, the profile list, or the codec list.

## How to get to it (user POV)

- An agent edits `ARGUS_FIRMWARE_REVISION` in `src/homekit.ts`.
- The pull-request census rejects that edit when the advertisement did not change.
- Nobody runs this against the Mini.

## Driving it with the local contract

Preconditions:

- Doctor printed `doctor=ok`.
- `scripts/firmware-census.mjs` is in the tree. That file arrives with the CI change.
- The churn commit object is present. The CI checkout fetches full history.

- **Run the census.** Run `node scripts/firmware-census.mjs --commit 6117635239cb0e5bdcbd877160fe877967a1d99e > .cursor/skills/verify-argus/evidence/firmware-census.txt`. Exit code 1. The file contains `verdict=churn`.
- **Proof.** Keep that text file. A churn line is not a license to bump the constant. `pr3_churn` is the historical count this gate is here to stop repeating.

## Gotchas

- If `scripts/firmware-census.mjs` is absent, the command fails. Report that failure. Do not point the command at a prototype.
- A squash merge hides the intermediate versions on main. The commit named above is one churn step, not the whole pull request.
- Exit 1 on that commit is the passing observation for churn. Exit 0 on a clean tree means the working firmware matches the base.
