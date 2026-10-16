# Exact optional properties

`tsconfig.json` sets `exactOptionalPropertyTypes`. A property that may be absent cannot be set to `undefined`. The probe compiles a bad sample and a good sample outside `src`.

## Sub-features

- `optional-bad` assigns `localAddress: bindAddress` when `bindAddress` is `string | undefined`.
- `optional-good` omits the property when the address is absent.

## How to get to it (user POV)

- An agent adds an optional field on `LiveFfmpegInput` or on the prepareStream response.
- `npm run build` runs `tsc` on `src` only. The probe is the check that does not require the Mini.

## Driving it with the local contract

Preconditions:

- Doctor printed `doctor=ok`.
- `npx tsc` resolves in this repo.

- **Run the probe.** Run `mkdir -p .cursor/skills/verify-argus/evidence && node .cursor/skills/verify-argus/exact-optional-probe.mjs > .cursor/skills/verify-argus/evidence/exact-optional.json`. Exit code 0. `bad_exit` is 2, `bad_has_ts2375` is true, and `good_exit` is 0.
- **Proof.** Keep the JSON. A green `npm test` does not replace this probe, because Vitest does not run the project `tsc` program.

## Gotchas

- The probe writes temporary files under the system temp directory and does not edit `src`.
- `good_exit` 0 means the omitted property compiles. It is not a Home session.
