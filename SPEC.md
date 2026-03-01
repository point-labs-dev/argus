# Argus MVP Specification

## Overview

Argus connects Reolink IP cameras to Apple HomeKit with live streaming, HomeKit Secure Video (HKSV) recording, and local NVR recording. It uses go2rtc as the stream proxy and HAP-NodeJS for HomeKit integration.

## System Behavior

### 1. Startup

When Argus starts:
1. Load YAML config (`argus.yaml`)
2. Start go2rtc as a managed child process with generated config
3. For each configured camera:
   a. Probe camera via Reolink HTTP API (model, firmware, capabilities)
   b. Verify RTSP stream is accessible via go2rtc
   c. Start snapshot cache (grab frame every 5 seconds from go2rtc)
   d. Create standalone HAP accessory (own mDNS + TCP port)
   e. Expose: Camera, MotionSensor, CameraOperatingMode, CameraEventRecordingManagement
   f. Start NVR recording (raw RTSP → MP4 segments via go2rtc)
   g. Start motion event listener (Reolink API polling or ONVIF events)
4. Start REST API server
5. Log system health summary

### 2. HomeKit Live Streaming

When an Apple device requests a live stream:
1. HomeKit sends SRTP session request to HAP accessory
2. Argus requests stream from go2rtc (RTSP URL for the camera)
3. FFmpeg transcodes (if needed) and sends RTP/SRTP to the Apple device
4. Stream ends when HomeKit closes the session

**Verification:**
- Camera appears in Apple Home app
- Live stream loads in < 3 seconds
- Stream is stable for > 5 minutes without drops
- Multiple simultaneous viewers work (go2rtc handles fan-out)

### 3. Snapshots

HomeKit requests snapshots for the Home app grid, notifications, and widgets.

1. Snapshot cache runs per camera: grabs a JPEG frame from go2rtc every 5s
2. On HomeKit snapshot request → return cached frame immediately
3. If cache is stale (> 30s) → grab fresh frame, update cache, return

**Verification:**
- Snapshot appears in Home app camera grid
- Response time < 200ms (cached)
- Snapshot updates reflect current camera view (not frozen)

### 4. Motion Detection

When camera detects motion:
1. Reolink API event fires (via polling every 1s or ONVIF subscription)
2. Argus sets `motionDetected = true` on HAP MotionSensor
3. After motion stops + 30s cooldown → set `motionDetected = false`
4. HomeKit receives event → triggers HKSV recording if enabled

**Verification:**
- Walk in front of camera → motion event appears in Home app
- Notification sent to iOS devices
- Motion indicator clears after person leaves + cooldown

### 5. HKSV Recording

When HomeKit Home Hub requests recording (triggered by motion):
1. Home Hub opens HomeKit Data Stream connection
2. Argus captures prebuffer (last 4-8 seconds of video from go2rtc)
3. Generates fragmented MP4: H.264 video + AAC audio
4. Each fragment aligned to IDR keyframe
5. Delivers fragments via HomeKit Data Stream until motion ends
6. Home Hub processes recording (person/vehicle/package detection happens on the Home Hub)

**Verification:**
- Motion event triggers HKSV recording
- Recording appears in Home app timeline
- Person/vehicle detection labels appear (Apple Home Hub analysis)
- Prebuffer captures activity before motion trigger
- Recording plays back smoothly in Home app

### 6. Local NVR Recording

Continuous recording independent of HomeKit:
1. go2rtc provides RTSP stream
2. Argus recorder writes raw stream to MP4 segments (no re-encoding)
3. Segments: 1 minute each, stored at `recordings/YYYY-MM-DD/HH/camera-name/MM.SS.mp4`
4. SQLite tracks: segment path, start/end time, camera, has_motion flag, file size
5. Retention engine runs hourly:
   - Continuous: keep N days (configurable, default 3)
   - Motion: keep N days (configurable, default 7)
   - Alerts: keep N days (configurable, default 30)
6. Emergency prune: if disk < 10GB free → delete oldest segments until 20GB free

**Verification:**
- Recordings appear on disk in correct folder structure
- SQLite contains metadata for each segment
- Segments play in VLC/mpv without errors
- Retention engine deletes old segments on schedule
- Emergency prune triggers when disk is low
- No re-encoding (verify with `ffprobe` — codec matches camera output)

### 7. Camera Reconnection

When a camera goes offline:
1. go2rtc detects connection drop
2. Argus marks camera as offline (HAP StatusFault)
3. Retry with exponential backoff: 5s, 10s, 30s, 60s, 120s, max 300s
4. On reconnection: resume recording, clear fault, log event
5. Recording gap tracked in SQLite (gap_start, gap_end)

**Verification:**
- Unplug camera → Home app shows "Not Responding" within 30s
- Plug camera back in → streams resume within reconnection interval
- No crash or resource leak during offline period
- Recording gap is logged

### 8. Configuration

`argus.yaml`:
```yaml
cameras:
  - name: "Front Door"
    host: 192.168.1.100
    username: admin
    password: secret
    streams:
      main: /h264Preview_01_main    # 4K for recording
      sub: /h264Preview_01_sub      # 720p for remote/analysis

recording:
  path: ./recordings
  retention:
    continuous: 3    # days
    motion: 7        # days
    alerts: 30       # days

homekit:
  pin: "123-45-678"  # Default, user should change

go2rtc:
  binary: ./go2rtc   # Path to go2rtc binary
  api_port: 1984     # go2rtc API port

server:
  port: 8080         # REST API port
```

**Verification:**
- Config loads and validates on startup
- Missing required fields → clear error message
- Invalid camera credentials → clear error message (not crash)
- Config changes picked up on restart

## Technical Requirements

### Dependencies
- Node.js 20+
- go2rtc binary (downloaded or provided)
- FFmpeg (for transcoding, bundled or system)

### TypeScript + Effect.ts Patterns
- Each camera lifecycle managed as an Effect Fiber
- Errors typed: `CameraOfflineError`, `StreamError`, `DiskFullError`, `ConfigError`
- Resources (streams, HAP instances) managed via Effect Scope
- Retry/backoff via Effect Schedule
- go2rtc managed as an Effect-supervised process

### HAP-NodeJS Integration
- One `Accessory` per camera (standalone, not bridged)
- Each accessory gets unique port and mDNS name
- Implement: `CameraController` with streaming + recording delegates
- Persist HAP pairing data to `.homekit/` directory

### go2rtc Integration
- Generate `go2rtc.yaml` from Argus config on startup
- Start as child process, monitor health via API (GET /api)
- Consume streams via RTSP URLs: `rtsp://localhost:8554/{camera-name}`

## Non-Goals (MVP)

- Two-way audio
- Web UI
- PTZ controls
- Doorbell support
- Siren/spotlight control
- Docker image
- Multi-brand camera support
- Object detection (Apple Home Hub handles this for HKSV)

## Success Criteria

The MVP is done when:
1. A Reolink camera appears in Apple Home app after pairing
2. Live stream plays reliably from Home app
3. Motion triggers HKSV recording that appears in Home app timeline
4. Local NVR records continuously to disk
5. Recordings survive a restart (persistence)
6. Camera reconnects automatically after going offline
7. Disk space is managed with tiered retention
8. System runs stable for 24+ hours without intervention
