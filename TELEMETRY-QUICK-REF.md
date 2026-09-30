# Argus Telemetry Quick Reference

One-page cheat sheet for reading telemetry on the Mac Mini.

## Capture Logs (Pick One)

```bash
# Live stream from LaunchAgent
log stream --predicate 'subsystem == "dev.point-labs.argus"' | tee argus.log

# Last hour from LaunchAgent
log show --predicate 'subsystem == "dev.point-labs.argus"' --last 1h > argus.log

# If running manually
npm run serve -- ./argus.yaml 2>&1 | tee argus.log
```

## Extract Telemetry

```bash
# All events
grep 'ARGUS_TELEMETRY:' argus.log | jq -s '.'

# Events for one camera
grep 'ARGUS_TELEMETRY:' argus.log | jq 'select(.camera == "Front Door")'

# Just timestamps and event names
grep 'ARGUS_TELEMETRY:' argus.log | jq -r '"\(.timestamp) \(.event) \(.camera)"'
```

## Measure Latency

### Motion → HomeKit Updated
```bash
cat argus.log | grep 'ARGUS_TELEMETRY:' | jq -r 'select(.camera == "Front Door") | select(.event == "motion_detected" or .event == "homekit_motion_updated") | .timestamp' | awk 'NR==1{a=$1} NR==2{print ($1-a) "ms"}'
```

### Motion → Stream Warmed
```bash
cat argus.log | grep 'ARGUS_TELEMETRY:' | jq -r 'select(.camera == "Front Door") | select(.event == "motion_detected" or .event == "go2rtc_stream_warmed") | .timestamp' | awk 'NR==1{a=$1} NR==2{print ($1-a) "ms"}'
```

### Motion → Live Session
```bash
cat argus.log | grep 'ARGUS_TELEMETRY:' | jq -r 'select(.camera == "Front Door") | select(.event == "motion_detected" or .event == "live_session_start") | .timestamp' | awk 'NR==1{a=$1} NR==2{print ($1-a) "ms"}'
```

## Event Types

| Event | When | Good Value |
|-------|------|------------|
| `motion_detected` | Reolink reports motion | Start of pipeline |
| `homekit_motion_updated` | HomeKit characteristic updated | <1100ms after motion |
| `go2rtc_stream_warmed` | Pre-warm snapshot complete | <500ms after motion |
| `live_session_start` | User tapped tile/notification | User-dependent |
| `live_session_stop` | User closed view | — |
| `hksv_recording_start` | Home Hub requested clip | Shortly after motion |
| `hksv_recording_stop` | HKSV clip complete | — |
| `motion_cleared` | Motion cooldown expired | 30s after motion stops |

## Expected Timeline

```
0ms:    motion_detected          <- Reolink API
50ms:   homekit_motion_updated   <- Argus → HomeKit
200ms:  go2rtc_stream_warmed     <- Snapshot refresh complete
???:    (iOS notification)        <- Apple push (0.5-15s, not measurable)
???:    live_session_start        <- User tapped notification
+1-2s:  (first frame)             <- With pre-warming
```

## Common Patterns

### Successful Alert Flow
```json
{"timestamp":1000,"camera":"Front Door","event":"motion_detected"}
{"timestamp":1042,"camera":"Front Door","event":"homekit_motion_updated","metadata":{"detected":true}}
{"timestamp":1220,"camera":"Front Door","event":"go2rtc_stream_warmed"}
{"timestamp":5300,"camera":"Front Door","event":"live_session_start","metadata":{"sessionId":"abc","width":1280,"height":720,"fps":30}}
```
**Good:** Motion→HomeKit=42ms, Motion→Warmed=220ms, User tapped at 5.3s

### HKSV Recording
```json
{"timestamp":1000,"camera":"Front Door","event":"motion_detected"}
{"timestamp":1042,"camera":"Front Door","event":"homekit_motion_updated","metadata":{"detected":true}}
{"timestamp":1220,"camera":"Front Door","event":"go2rtc_stream_warmed"}
{"timestamp":1500,"camera":"Front Door","event":"hksv_recording_start","metadata":{"streamId":1,"resolution":[1920,1080,30]}}
{"timestamp":15000,"camera":"Front Door","event":"hksv_recording_stop","metadata":{"streamId":1}}
```
**Good:** HKSV triggered 500ms after motion, recorded for ~13s

### Missing Pre-Warm (Problem)
```json
{"timestamp":1000,"camera":"Front Door","event":"motion_detected"}
{"timestamp":1042,"camera":"Front Door","event":"homekit_motion_updated","metadata":{"detected":true}}
{"timestamp":5300,"camera":"Front Door","event":"live_session_start"}
```
**Missing:** No `go2rtc_stream_warmed` event
**Check:** Argus stderr for snapshot refresh errors

## Troubleshooting

| Problem | Check |
|---------|-------|
| No telemetry events | LaunchAgent running? `launchctl list \| grep argus` |
| No `go2rtc_stream_warmed` | go2rtc healthy? `curl http://127.0.0.1:1984/api/streams` |
| HomeKit→iOS >10s | Apple push delay (iCloud relay, WiFi) — not fixable |
| No `hksv_recording_start` | HKSV enabled? Home Hub on LAN? |
| Multiple `motion_detected` | Flapping — increase cooldown (motion.ts) |

## Save for Reporting

When sharing results, capture:

```bash
# Telemetry for one motion event
grep 'ARGUS_TELEMETRY:' argus.log | \
  jq -r 'select(.camera == "Front Door")' | \
  jq -s 'sort_by(.timestamp) | .[]' > front-door-event.json

# Summary stats
echo "Motion → HomeKit: $(your-latency-command)ms"
echo "Motion → Warmed: $(your-latency-command)ms"
```

Include camera model, network setup, and whether improvement from cold start was observed.
