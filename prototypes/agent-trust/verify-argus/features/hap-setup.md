# HAP setup contract

The local contract builds a prepareStream answer for Garage Door and prints whether the response echoes the controller SRTP key, whether audio-off still attaches an audio object, and which ffmpeg filter a 1280 by 720 ask gets.

## Sub-features

- `hap-echo` checks that an audio-on answer copies the request SRTP key and salt.
- `hap-audio-off` records whether `includeAudio: false` still puts audio on the response while ffmpeg drops `-c:a`.
- `hap-double` records that the state machine rejects a second answer and that the existing test calls `prepareStream` once.
- `hap-filter` records the crop filter and the default pad filter for a 1280 by 720 box.

## How to get to it (user POV)

- A Home session calls `prepareStream` on the camera delegate, then START.
- An agent changing `src/homekit.ts` hits the same function the script calls.
- There is no local UI. The iPhone is not an entry point for this feature.

## Driving it with the local contract

Preconditions:

- Doctor printed `doctor=ok`.
- The worktree does not need a camera or the Mini.

- **Run the contract.** Run `npx tsx prototypes/agent-trust/hap-setup-contract.ts > prototypes/agent-trust/evidence/hap-setup.json`. Exit code 0. The JSON file contains `prototype: true`, `audio_on_key_echo`, `audio_off_has_audio`, `state_machine_second_answer`, and both filter strings.
- **Proof.** Leave that JSON file in place. Do not replace it with a sentence that says the picture painted.

## Gotchas

- `ARGUS_TIMING` lines on stderr come from the delegate. They are not the picture and they are not a failure of this script.
- Audio-on key echo can pass while audio-off still returns an audio object. Read both fields.
- The default filter pads. The crop filter runs only when `cropToFill` is true. A named camera and that flag can disagree today.
