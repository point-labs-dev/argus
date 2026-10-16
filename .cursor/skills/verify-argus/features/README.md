# Argus local verification map

This map covers local stream-setup checks. It does not cover a live picture on an iPhone.

## Baseline preconditions

- Run from the Argus repo root.
- `bash .cursor/skills/verify-argus/doctor.sh` prints `doctor=ok` and `mini=not-contacted`.
- Do not reboot or edit the Mini plist.
- Leave `src/timing.ts` matching `origin/main`.

## Driving conventions

- Start from the repo root.
- Run the command in the feature file and keep the stdout file named there.
- Treat a log line as a log line. The painted picture is a separate check that this map does not perform.

## Proof and skip reporting

- Save the command output under `.cursor/skills/verify-argus/evidence/`.
- Record the feature id and the git SHA from the doctor line `head=`.
- If a feature needs the Mini, report it skipped and name the command you did not run.

## Feature entry contract

Each feature file uses the four headings `Sub-features`, `How to get to it (user POV)`, `Driving it with the local contract`, and `Gotchas`.

## Features

- `hap-setup` checks the prepareStream answer, the second callback guard, and the pad versus crop filters.
- `firmware-census` classifies firmware bumps against the advertised ladder.
- `exact-optional` shows the compile error for an optional property set to undefined.
