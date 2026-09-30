# Testing Argus Alert Latency Improvements

This guide explains how to verify the alert→action latency improvements on the Mac Mini.

## Prerequisites

- Argus running on Mac Mini as `dev.point-labs.argus` LaunchAgent
- At least one paired camera
- iPhone or iPad on the same network
- Terminal access to Mac Mini

## Setup: Enable Telemetry Logging

The LaunchAgent logs to the system log. Capture telemetry with:

```bash
# Stream live logs (keep this running in one terminal)
log stream --predicate 'subsystem == "dev.point-labs.argus"' --style compact | tee argus-test.log

# Or collect existing logs from the last hour
log show --predicate 'subsystem == "dev.point-labs.argus"' --last 1h > argus-test.log
```

If running Argus manually (not as launchd service):

```bash
npm run serve -- ./argus.yaml 2>&1 | tee argus-test.log
```

## Test 1: Motion Detection Latency

**Goal:** Measure time from Reolink motion detection to HomeKit notification.

1. **Start logging** (see above)
2. **Trigger motion** — Walk in front of a camera
3. **Note when iOS notification arrives** on your iPhone (write down the timestamp)
4. **Wait 30 seconds** for the event to complete
5. **Stop logging** (Ctrl+C the log stream)

### Analysis

Extract telemetry events:

```bash
grep 'ARGUS_TELEMETRY:' argus-test.log > telemetry.jsonl
```

Check the event sequence for your camera (replace `"Front Door"` with your camera name):

```bash
cat telemetry.jsonl | jq -r 'select(.camera == "Front Door") | "\(.timestamp) \(.event)"'
```

Expected output:
```
1727640123456 motion_detected
1727640123478 homekit_motion_updated
1727640123520 go2rtc_stream_warmed
```

**Key Metrics:**

| Metric | Command | Expected |
|--------|---------|----------|
| **Motion → HomeKit** | `echo "scale=0; ($(jq -r 'select(.camera=="Front Door" and .event=="homekit_motion_updated") | .timestamp' telemetry.jsonl | head -1) - $(jq -r 'select(.camera=="Front Door" and .event=="motion_detected") | .timestamp' telemetry.jsonl | head -1)) / 1" \| bc` | <1100ms |
| **Motion → Stream warmed** | `echo "scale=0; ($(jq -r 'select(.camera=="Front Door" and .event=="go2rtc_stream_warmed") | .timestamp' telemetry.jsonl | head -1) - $(jq -r 'select(.camera=="Front Door" and .event=="motion_detected") | .timestamp' telemetry.jsonl | head -1)) / 1" \| bc` | <500ms |
| **HomeKit → iOS notification** | Manual: compare `homekit_motion_updated` timestamp to when notification appeared on iPhone | Unknown (Apple controlled) |

If **HomeKit → iOS notification** is consistently >5 seconds, the bottleneck is Apple's push infrastructure, not Argus.

## Test 2: Live View Startup Latency

**Goal:** Measure time from tapping notification to first frame appearing.

1. **Start logging**
2. **Trigger motion** and wait for iOS notification
3. **Tap the notification** on iPhone
4. **Measure time to first frame** (stopwatch or video recording)
5. **Stop logging** after 30 seconds

### Analysis

```bash
grep 'ARGUS_TELEMETRY:' argus-test.log | jq -r 'select(.camera == "Front Door") | "\(.timestamp) \(.event)"'
```

Expected sequence:
```
1727640123456 motion_detected
1727640123478 homekit_motion_updated
1727640123520 go2rtc_stream_warmed
1727640128000 live_session_start       <- user tapped notification
```

**Key Metrics:**

| Metric | Expected | Notes |
|--------|----------|-------|
| **Motion → Live session start** | User-dependent | How long until user tapped |
| **Live session start → First frame** | <2000ms | With pre-warming |
| **Without pre-warming (baseline)** | ~3-4s | For comparison |

The improvement from pre-warming is the difference between a cold start (~3-4s) and a warm start (~1-2s).

## Test 3: HKSV Recording Trigger

**Goal:** Verify HKSV recording starts on motion.

1. **Enable HKSV** in Home app for the camera (requires Apple TV or HomePod)
2. **Start logging**
3. **Trigger motion**
4. **Wait 30 seconds**
5. **Check Home app** — recording should appear in timeline

### Analysis

```bash
grep 'ARGUS_TELEMETRY:' argus-test.log | jq -r 'select(.camera == "Front Door") | "\(.timestamp) \(.event)"'
```

Expected sequence:
```
1727640123456 motion_detected
1727640123478 homekit_motion_updated
1727640123520 go2rtc_stream_warmed
1727640123600 hksv_recording_start     <- Home Hub requested clip
...
1727640135000 hksv_recording_stop      <- Recording ended
```

If `hksv_recording_start` never appears, check:
- Home Hub is on the same network
- HKSV is enabled in Home app for this camera
- Apple Home app settings → [Camera] → "Record" is not "Off"

## Test 4: Multi-Camera Stress Test

**Goal:** Verify pre-warming works with multiple simultaneous motion events.

1. **Start logging**
2. **Trigger motion on all cameras** (walk through the house)
3. **Wait 30 seconds**
4. **Stop logging**

### Analysis

Count events per camera:

```bash
cat telemetry.jsonl | jq -r .camera | sort | uniq -c
```

Each camera should show:
- 1x `motion_detected`
- 1x `homekit_motion_updated`
- 1x `go2rtc_stream_warmed`
- Optional: `live_session_start`, `hksv_recording_start`

If any camera is missing `go2rtc_stream_warmed`, pre-warming may have failed (check error logs).

## Baseline: Measure Without Pre-Warming

To compare before/after, disable pre-warming:

1. Edit `src/serve.ts`
2. Comment out the pre-warming snapshot refresh block (lines ~140-150)
3. Rebuild: `npm run build`
4. Restart Argus
5. Run Test 2 again and measure live session startup

**Expected result:** Without pre-warming, first frame takes ~3-4s (vs ~1-2s with pre-warming).

## Common Issues

### "No telemetry events in logs"

- Check LaunchAgent is actually running: `launchctl list | grep argus`
- Verify logs are being captured: `log show --predicate 'subsystem == "dev.point-labs.argus"' --last 1m`
- If running manually, ensure stderr isn't redirected away

### "go2rtc_stream_warmed never appears"

- Check go2rtc is running: `curl http://127.0.0.1:1984/api/streams`
- Verify snapshot cache is working: `curl http://127.0.0.1:1984/api/frame.jpeg?src=<stream-name>`
- Check for errors in Argus logs (not just telemetry)

### "iOS notification arrives 10+ seconds after homekit_motion_updated"

This is Apple's push notification infrastructure (iCloud relay). Not fixable by Argus. Factors:
- WiFi vs cellular on iPhone
- Home Hub on LAN vs relayed through iCloud
- Apple's server load

Try:
- Ensure Home Hub (Apple TV/HomePod) is on same LAN as Argus
- Ensure iPhone is on same WiFi network
- Check iPhone Settings → Home → [Your Home] → Home Hub Status

### "Live session starts but no video appears"

This is not a latency issue — check:
- FFmpeg logs in Argus output (look for errors)
- Camera stream health: `curl http://127.0.0.1:1984/api/streams`
- Network connectivity between Mac Mini and camera

## Success Criteria

After these tests, you should see:

| Metric | Target | Achieved? |
|--------|--------|-----------|
| Motion → HomeKit updated | <1100ms | ☐ |
| Motion → Stream warmed | <500ms | ☐ |
| Live session start → First frame | <2000ms | ☐ |
| HKSV recording triggered | Yes | ☐ |

If all metrics are met, the latency improvements are working as designed. The remaining unknown is Apple's push notification delivery, which is outside Argus's control.

## Reporting Results

When reporting test results, include:

1. Camera model(s) tested
2. Telemetry log excerpt (motion_detected → live_session_start)
3. Measured latencies for each metric
4. Whether improvement from cold start was observed
5. Any errors encountered

Example:

```
Camera: RLC-812A (standalone, main=h265, sub=h264)
Motion → HomeKit: 42ms
Motion → Stream warmed: 220ms
Live session start → First frame: ~1.5s (measured with stopwatch)
Improvement: Yes — cold start was ~3.5s before pre-warming
Errors: None
```
