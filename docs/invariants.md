# Stream setup invariants

These are the rules a change to live view has to keep. This note is not a deploy procedure.

## Firmware

Bump `ARGUS_FIRMWARE_REVISION` in `src/homekit.ts` only when the advertised ladder, profile list, or codec list changes. The census rejects a firmware-only bump. This file does not assign that constant.

## Answer

`prepareStream` copies the controller SRTP key and salt into the answer. When audio is on, the answer includes audio. When audio is off, the answer omits audio.

## Picture shape

A camera aspect is `16:9` or `4:3`. `16:9` pads into Home's box. `4:3` crops into it.

## What a log line is not

A `live_session_first_frame` log line is not the painted picture. The iPhone check stays with Peter.
