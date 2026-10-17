# HAP setup contract

The local contract checks a prepareStream answer: the response echoes the controller SRTP key, audio-off omits the audio object, a duplicate prepareStream does not call the HAP callback, and a parsed 4:3 camera crops at 640x480.

## Sub-features

- `hap-echo` checks that an audio-on answer copies the request SRTP key and salt.
- `hap-audio-off` checks that `includeAudio: false` leaves audio off the response.
- `hap-double` checks that a second prepareStream does not answer again.
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
- Audio-on key echo can pass while audio-off still returns an audio object. Read both results.
