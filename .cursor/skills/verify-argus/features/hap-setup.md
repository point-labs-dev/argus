# HAP setup contract

The local contract checks a prepareStream answer on this stack: the response echoes the controller SRTP key, audio stays on the answer, a second prepareStream still calls the callback, and a parsed 4:3 camera crops at 640x480. Omitting audio when audio is off is the later behavior-change pull request.

## Sub-features

- `hap-echo` checks that an answer copies the request SRTP key and salt, including when audio is off.
- `hap-callback` checks that a second prepareStream still calls the HAP callback.
- `hap-filter` checks the crop filter for `4:3` and the pad filter for `16:9`.
- `hap-wire` checks that `createCameraAccessory` passes the parsed aspect into the crop.

## How to get to it (user POV)

- A Home session calls `prepareStream` on the camera delegate, then START.
- An agent changing `src/homekit.ts` hits the same function the test calls.
- There is no local UI. The iPhone is not an entry point for this feature.

## Driving it with the local contract

Preconditions:

- Doctor printed `doctor=ok`.
- The worktree does not need a camera or the Mini.
- `tests/hap-setup-contract.test.ts` is in the tree. That file arrives with the stream-setup change.

- **Run the contract.** Run `npx vitest run tests/hap-setup-contract.test.ts > .cursor/skills/verify-argus/evidence/hap-setup.txt`. Exit code 0. The text file is the proof.
- **Proof.** Leave that file in place. Do not replace it with a sentence that says the picture painted.

## Gotchas

- A `live_session_first_frame` line is not a pass for the picture. The iPhone check stays with Peter.
- If `tests/hap-setup-contract.test.ts` is absent, the command fails. Report that failure. Do not point the command at a different file.
- Audio-off still returns an audio object on this stack. The omission check is not here.
