# Span latency

`scripts/span-latency.mjs` reads a log excerpt and prints p50 and p95 for each Argus-side span. It does not open a socket.

Build first. The script imports `dist/span-report.js`.

```bash
npm run build
node scripts/span-latency.mjs path/to/excerpt.log
```

A missing `dist/span-report.js` prints `span-latency: build first. Missing dist/span-report.js. Run npm run build.` and exits 1.

## New lines

These are `ARGUS_TELEMETRY` lines. Each has `monoMs` from a monotonic clock, the camera, and an id that already existed or a new id used only on these lines.

| Event | When | Id |
| --- | --- | --- |
| `motion_source` | Motion edge | `motionId`. `metadata.via` is `md` or `ai`. |
| `live_start_ack` | START callback | `sessionId` |
| `hksv_span_fragment` | Each media fragment | `streamId` and `recId`. `metadata` has `durationMs` and `size`. The first fragment of a recording also has `initial: 1`. |
| `hksv_span_close` | Recording close | `streamId` and `recId` |

`via` names the API that fired. `md` is GetMdState. `ai` is GetAiState. The camera field separates NVR channels from standalone cameras.

`recId` is one recording attempt. A later recording can reuse the same `streamId` and still gets a new `recId`. The report resets an unmatched start when the next `recording_start` for that camera and stream arrives, so an old start does not pair with a new fragment.

## Reused marks

These points already have an `ARGUS_TIMING` line. The report reads that line. Argus does not write a second line with the same name.

| Span point | Timing stage |
| --- | --- |
| Motion characteristic set | `motion_characteristic_set` |
| prepareStream | `prepare_stream_enter` |
| startStream request | `live_session_start` |
| FFmpeg spawn | `live_ffmpeg_spawn` |
| First frame | `live_first_frame` |
| HKSV recording start | `recording_start` |
| HKSV first fragment | `recording_first_fragment` |

Existing `ARGUS_TIMING` lines stay as they are.

## Report

`live_first_frame_to_start_ack` is usually empty. The START ack fires at 100ms, and the first frame often arrives after that, so there is no ack after the frame. The ack delay stays 100ms.

`hksv_fragment_duration` skips the first fragment of each recording. That gap is `hksv_start_to_first_fragment`, not a fragment-to-fragment wait.
