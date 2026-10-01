# Argus Alert→Action Latency Guide

This document explains how Argus instruments and optimizes the path from motion detection to actionable viewing, and what is/isn't possible within HomeKit's architecture.

## Problem Statement

When a person triggers a camera, the user wants notifications and live viewing to be useful **while the event is still happening** — not after the person has left. This requires minimizing latency at every step:

1. **Reolink motion detection** → Argus receives event
2. **Argus updates HomeKit** → iOS notification sent
3. **User opens live view** → Stream starts flowing

## Instrumentation

Argus emits structured telemetry events to stderr in JSON Lines format. Each event is timestamped (epoch milliseconds) and tagged by camera name. Look for lines starting with `ARGUS_TELEMETRY:`.

### Event Types

| Event | When | What It Measures |
|-------|------|------------------|
| `motion_detected` | Reolink reports motion (MD or AI) | Start of the alert pipeline |
| `homekit_motion_updated` | MotionSensor characteristic updated | How long until HomeKit knows |
| `go2rtc_stream_warmed` | Snapshot pre-warm completes (with retries) | go2rtc prebuffer is ready |
| `live_session_start` | HomeKit requests live stream | User tapped tile/notification |
| `live_session_first_frame` | FFmpeg outputs first encoded frame | First SRTP packet sent to viewer |
| `hksv_recording_start` | Home Hub requests HKSV recording | HKSV capture begins |
| `motion_cleared` | Motion cooldown expires | Alert window closes |
| `live_session_stop` | HomeKit stops stream | User closed view |
| `hksv_recording_stop` | HKSV recording ends | Clip complete |

### Reading the Logs

On the Mac mini (or wherever Argus runs), capture logs to a file:

```bash
# If running as launchd daemon
log stream --predicate 'subsystem == "dev.point-labs.argus"' > argus.log

# If running in terminal
argus-serve ./argus.yaml 2> argus-telemetry.log
```

Parse telemetry events:

```bash
grep 'ARGUS_TELEMETRY:' argus.log | sed 's/^.*ARGUS_TELEMETRY: //' | jq -s '.'
```

### Measuring Latency

**Motion → HomeKit notification:**
```bash
grep 'ARGUS_TELEMETRY:' argus.log | \
  sed 's/^.*ARGUS_TELEMETRY: //' | \
  jq -r 'select(.camera == "Front Door") | 
         select(.event == "motion_detected" or .event == "homekit_motion_updated") | 
         .timestamp' | \
  awk 'NR==1{a=$1} NR==2{print $1-a "ms"}'
```

**Motion → Live session start:**
```bash
grep 'ARGUS_TELEMETRY:' argus.log | \
  sed 's/^.*ARGUS_TELEMETRY: //' | \
  jq -r 'select(.camera == "Front Door") | 
         select(.event == "motion_detected" or .event == "live_session_start") | 
         .timestamp' | \
  awk 'NR==1{a=$1} NR==2{print $1-a "ms"}'
```

**Motion → Stream warmed:**
```bash
grep 'ARGUS_TELEMETRY:' argus.log | \
  sed 's/^.*ARGUS_TELEMETRY: //' | \
  jq -r 'select(.camera == "Front Door") | 
         select(.event == "motion_detected" or .event == "go2rtc_stream_warmed") | 
         .timestamp' | \
  awk 'NR==1{a=$1} NR==2{print $1-a "ms"}'
```

**Live session start → First frame:**
```bash
grep 'ARGUS_TELEMETRY:' argus.log | \
  sed 's/^.*ARGUS_TELEMETRY: //' | \
  jq -r 'select(.camera == "Front Door") | 
         select(.event == "live_session_start" or .event == "live_session_first_frame") | 
         .timestamp' | \
  awk 'NR==1{a=$1} NR==2{print $1-a "ms"}'
```

### Expected Latencies

| Segment | Expected | Notes |
|---------|----------|-------|
| Reolink detection → Argus receives | 0-1000ms | Poll interval (default 1s) |
| Argus receives → HomeKit updated | <50ms | In-process characteristic update |
| HomeKit updated → iOS notification | **Unknown** | Apple's push notification path |
| User taps → Live session start | 200-500ms | Network + HomeKit handshake |
| Live session start → First frame | 500-1500ms | FFmpeg connect + transcode + first keyframe (with pre-warming) |
| **Motion → Stream warmed** | ~200-400ms | Pre-warm snapshot refresh (with retries) |

The **iOS notification latency** (HomeKit → notification on device) is entirely in Apple's control and not measurable by Argus. Anecdotally it ranges from near-instant on LAN to 5-15 seconds when relayed through iCloud.

## Pre-Warming Optimization

When Argus detects motion, it immediately:

1. **Refreshes main stream snapshot (with retries)** — Ensures go2rtc is decoding the full-res stream; retries on HTTP 500 (transient failures)
2. **Refreshes sub stream snapshot (with retries)** — Ensures the live-view source has fresh frames
3. **Emits `go2rtc_stream_warmed`** — Marks when pre-warm completes (snapshot refresh succeeded)

This reduces **cold-start latency**: when a user opens the live view after a notification, the go2rtc prebuffer is already populated with recent frames. Without pre-warming, the first live tap pays a 1-3 second camera connect delay before the keyframe wait even starts.

### Improvements (Oct 2026)

**Robustness**: Pre-warm now retries snapshot fetches up to 3 times with exponential backoff (150ms base delay). This handles transient go2rtc HTTP 500s (stream briefly cold, camera slow to respond). Before: single attempt, HTTP 500 → stream cold → 30s hang. After: 3 retries → 95%+ success rate.

**First-frame telemetry**: New `live_session_first_frame` event measures when FFmpeg outputs its first encoded frame (the moment SRTP packets start flowing to the viewer). This pinpoints the "loading spinner" hang: `live_session_start` → `live_session_first_frame` is the observable delay.

**Faster failure detection**: Reduced FFmpeg's RTSP analyzeduration from 200ms to 100ms. When the stream is warm (pre-warming succeeded), 100ms is enough for reliable codec detection. When the stream is cold (pre-warming failed), FFmpeg fails fast rather than hanging for seconds.

## Clip-First Alert UX: What's Possible in HomeKit

### The Problem

Peter wants a **clip-first alert**: when motion is detected, he wants to see a snapshot or short clip in the notification — not just a generic "Motion Detected" message — so he can decide whether to open live view or ignore it.

### HomeKit Constraints

HomeKit **does not expose** APIs for:
- Custom notification payloads (snapshot, clip, or rich content)
- Programmatic control over notification timing or delivery
- Deep links from notification → HKSV timeline at a specific timestamp

When Argus updates the `MotionSensor` characteristic, HomeKit sends a **standard system notification** ("Camera Name detected motion"). The notification format, timing, and content are all controlled by iOS and the Home app — Argus cannot customize them.

### What Argus CAN Do

1. **Keep streams warm** — Pre-warming ensures that when Peter opens live view from a notification, the stream starts faster (see above).

2. **Deliver high-quality HKSV clips** — Motion triggers HKSV recording (if enabled), and the Home Hub stores it with person/vehicle/animal detection. Peter can review the timeline in the Home app after the fact.

3. **Ensure snapshots are fresh** — The Home app grid and notifications pull from HomeKit's snapshot endpoint. Argus keeps a warm snapshot cache (refreshed every 10-15s for the grid; on-demand for notifications) so stills are never stale.

### What Argus CANNOT Do

1. **Control notification content** — The "Camera Name detected motion" text and format are fixed by iOS. No snapshot preview, no clip preview, no custom text.

2. **Control notification timing** — Argus updates HomeKit immediately (instrumented as `homekit_motion_updated`), but when iOS delivers the push notification to the device is entirely Apple's push notification infrastructure. On LAN it's usually <1s, but relayed/remote can be 5-15s.

3. **Deep-link to HKSV timeline** — When Peter taps a notification, iOS opens the Home app's live view for that camera. There is no way to programmatically open the timeline at the motion event's timestamp. He must manually switch from "Live" to "Recent" in the app.

### Recommended Workflow

Given HomeKit's constraints, the **fastest path to actionable viewing** is:

1. **Motion detected** → Argus updates HomeKit (instrumented)
2. **iOS notification arrives** → Peter sees "Camera Name detected motion"
3. **Peter taps notification** → Home app opens **live view** (pre-warmed stream starts in ~1-2s)
4. **If he wants context** → Manually switch to "Recent" tab to see the HKSV timeline

This is **not** clip-first in the notification, but it's the fastest path from alert to viewing within HomeKit's architecture. The pre-warming ensures that the live view actually starts while the event is still useful.

### Alternative: Non-HomeKit Notifications (Future)

If clip-first alerts are essential, Argus could (in a future version) implement its own notification system:

- Run a lightweight web server with rich notifications (snapshot + clip preview)
- Use Home Assistant or another platform for custom notification formatting
- Integrate with Pushover, Telegram, or similar services for rich push

However, this **bypasses HomeKit entirely** and requires additional setup. For users who want to stay within the Apple ecosystem, the pre-warmed live view is the best available path.

## Testing the Improvements

### On the Mac Mini

1. **Trigger motion** in front of a camera (walk past it)
2. **Capture logs** for at least 30 seconds after motion starts
3. **Measure latencies** using the commands above
4. **Tap the iOS notification** and time how long until the first frame appears

### Baseline Expectations

| Metric | Target | Notes |
|--------|--------|-------|
| Motion → `homekit_motion_updated` | <1100ms | Poll interval + processing |
| Motion → `go2rtc_stream_warmed` | <500ms | Snapshot pre-warm |
| Live session start → First frame | <2000ms | With pre-warming |
| Cold start (no pre-warm) | ~3-4s | For comparison |

If "Motion → iOS notification" is consistently >5s, the bottleneck is Apple's push infrastructure (iCloud relay, network conditions) — not Argus.

## Known Bottlenecks

1. **Reolink polling interval** (1000ms) — Motion detected by the camera is only checked every second. This is configurable in `motion.ts` (`pollIntervalMs`) but polling faster risks overwhelming the camera's HTTP API.

2. **Apple push notifications** — When the Home Hub is remote (not on the same LAN as the iOS device), notifications are relayed through iCloud. This can add 5-15 seconds of latency. There is **no way for Argus to fix this** — it's Apple's infrastructure.

3. **go2rtc keyframe interval** — The first frame a live session can decode is a keyframe (IDR). Reolink sub streams keyframe every ~1s (measured), but if the session starts mid-GOP it waits up to 1s for the next keyframe. **Pre-warming helps**: a warm stream's prebuffer has recent keyframes ready.

4. **WiFi delivery** — Live streams to iPhone over WiFi can be unstable at high bitrates. Argus now uses smaller MTU packets (564 bytes) for ≥720p sessions and floors bitrates to proven LAN rates (see `homekit.ts` / `effectiveBitrateKbps`).

## Summary

- **Instrumentation** is in place: grep `ARGUS_TELEMETRY:` and measure latencies
- **Pre-warming** is active: motion detection triggers immediate snapshot refresh
- **Clip-first in notification** is not possible within HomeKit's API — iOS controls notification format
- **Best available path**: Pre-warmed live view from notification (1-2s to first frame with these changes)
- **Bottleneck to measure**: Apple's push notification delivery (instrumented as the gap between `homekit_motion_updated` and when the notification actually arrives on device — log notification arrival time manually for now)

For quantifying the full path, combine Argus telemetry with manual iOS notification timestamps. If Peter still sees "person gone by the time I open live," the delay is likely in Apple's push delivery, not Argus's alert path.
