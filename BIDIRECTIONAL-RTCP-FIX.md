# Bidirectional RTCP Fix (Firmware 1.3.4)

**Commit**: `4cb1d5c`  
**Date**: 2026-10-02  
**Status**: Ready for field test

## Problem

HomeKit Garage Door live view shows **no live feed** from first open (not even the 30s reported in 1.3.3 hypothesis).

**Field evidence (2026-10-02 ~05:20 ET)**:
- Peter tested tip `2d7f6de` (firmware 1.3.3, RTCP localrtpport fix) on iPhone
- Result: **no live feed** - spinner → No Response
- Encode path confirmed healthy: ffmpeg ~30fps, live_session_first_frame ~0.7-1.3s
- HomeKit STOP/SIGKILL → UI never unlocks

The 1.3.3 "30s RTCP timeout" hypothesis was **wrong**. The stream never unlocks at all.

## Root Cause

The `localrtpport` parameter created a **port conflict that broke bidirectional RTCP**:

### What We Were Doing (1.3.3)

1. **prepareStream**: Tell HomeKit "I'm listening on port X" (response.video.port = videoRtcp)
2. **startStream**: Configure ffmpeg with `localrtpport=X` (bind local RTP sender to port X)
3. **Conflict**: ffmpeg binds port X for SENDING, but HomeKit thinks we're LISTENING on port X

### Why This Breaks HomeKit

- HomeKit expects **bidirectional RTCP**: it needs to send Receiver Reports, NACKs, and other control packets BACK to the accessory
- When HomeKit tries to send RTCP to port X, the port is bound by ffmpeg's sender (not a listening socket)
- HomeKit can't establish bidirectional RTCP → kills the stream

### The Wrong Analogy

Home Assistant PR #99989 was about **firewall configuration** (making source ports deterministic), NOT fixing HomeKit stream unlock. We misapplied their fix to a different problem.

## Fix

**Remove `localrtpport` entirely** - follow homebridge-camera-ffmpeg pattern:

### Before (1.3.3)
```typescript
srtp://address:50000?rtcpport=50000&localrtpport=60000&pkt_size=564
```

### After (1.3.4)
```typescript
srtp://address:50000?rtcpport=50000&pkt_size=564
```

Let ffmpeg choose random source ports. This allows:
- ffmpeg to send RTP/RTCP from ephemeral ports
- The port we advertise in prepareStream to remain unused (or could be used for actual listening in the future)
- HomeKit to send RTCP back to ffmpeg's actual source port (tracked via RTP/RTCP flow)

## Changes

**Files**:
- `src/homekit.ts`: Removed `localrtpport` from video and audio SRTP URLs
- `src/homekit.ts`: Firmware 1.3.3 → 1.3.4 (with field test note on 1.3.3 failure)
- `tests/homekit.test.ts`: Updated test expectations

**Preserved wins** (all kept):
- Video-only mode (ARGUS_AUDIO=0)
- Baseline H.264 profile (forced)
- In-band SPS/PPS (dump_extra=freq=keyframe)
- Exact dimension padding
- Honor negotiated bitrate
- Small packet sizes for hi-res (564 bytes)

## Why This Should Work

1. **Standard pattern**: homebridge-camera-ffmpeg (most widely deployed HomeKit camera implementation) does NOT use `localrtpport`
2. **Proper protocol**: RTP/RTCP is designed to be bidirectional - HomeKit needs to send feedback
3. **Port logic**: Binding the advertised port for sending prevents listening
4. **Minimal change**: Only removes the problematic parameter, preserves all other fixes

## Field Test Deployment (Mac Mini)

### 1. Fetch and Build

```bash
cd ~/argus-workspace  # or wherever the repo lives
git fetch origin
git reset --hard 4cb1d5c
npm install
npm run build
```

### 2. Verify Firmware Version

```bash
grep "ARGUS_FIRMWARE_REVISION" src/homekit.ts
# Should show: export const ARGUS_FIRMWARE_REVISION = "1.3.4";
```

### 3. Restart Service

```bash
launchctl kickstart -k gui/$(id -u)/dev.point-labs.argus
```

### 4. Check Logs

```bash
tail -f ~/Library/Logs/argus/argus.log
```

**What to look for**:
- No `localrtpport` in ffmpeg command (should see `srtp://...?rtcpport=...&pkt_size=...` only)
- Example expected:
  ```
  ffmpeg ... srtp://192.168.x.x:50000?rtcpport=50000&pkt_size=564 ...
  ```
- NO `&localrtpport=60000` or similar

### 5. Test on iPhone Home App

**Expected behavior** (if fix works):
- Open Garage Door live view
- Video unlocks **within 2 seconds**
- Picture renders **continuously** (no timeout)
- No "No Response" message

**Verify in logs**:
- `HomeKit negotiated video:` line shows the session details
- `live_session_first_frame` telemetry fires (~0.7-1.3s typical)
- No ffmpeg exit/SIGKILL after a few seconds
- Stream runs as long as Home app is open

### 6. Confirm iOS Sees New Firmware

In iOS Home app:
- Tap Garage Door camera
- Settings (gear icon)
- Scroll down
- **Firmware Version** should show `1.3.4`

(iOS may need a few seconds after service restart to query the new version)

## Residual Risks

1. **If this still doesn't unlock**: The issue might be deeper in the SRTP/encryption handshake or RTP timestamp synchronization
2. **Firewall/NAT**: If the Mini sits behind NAT/firewall that tracks port mappings, random source ports might not traverse it (but this is local LAN testing, should be fine)
3. **iOS cache**: Even with firmware bump, iOS might cache something about the accessory - may need to remove and re-add the camera to Home (nuclear option only if needed)

## Next Steps if Fix Fails

If 1.3.4 still shows no live feed:
1. Capture ffmpeg stderr during a failed unlock attempt (full log, not just first frame telemetry)
2. Capture Wireshark/tcpdump of the SRTP session (both directions) to see:
   - Are RTP packets arriving at HomeKit?
   - Is HomeKit sending RTCP back?
   - Are there packet loss / timing issues?
3. Test with a different HomeKit client (Mac Home app, not just iPhone) to see if it's device-specific
4. Consider if we need to actually LISTEN on the port we advertise (add a UDP receiver)

## Why Prior Fixes Failed

### 1.3.1 (Baseline Profile)
- **Hypothesis**: High profile rejected by Home decoder
- **Reality**: Profile probably fine; issue was network/protocol, not codec

### 1.3.2 (Video-only prepareStream)
- **Hypothesis**: Home waiting for audio packets
- **Reality**: Correctly fixed audio wait, but didn't unlock video (issue elsewhere)

### 1.3.3 (localrtpport RTCP)
- **Hypothesis**: "30s RTCP timeout" from Home Assistant analogy
- **Reality**: Misapplied fix; actually CREATED port conflict that breaks bidirectional RTCP
- **Field test**: Confirmed NO unlock (not even 30s)

### Common thread
All focused on encoding/advertising parameters, missed the **bidirectional protocol requirement**.

## References

- homebridge-camera-ffmpeg: No `localrtpport` in their SRTP URLs (proven pattern)
- HAP-NodeJS PrepareStreamResponse: Port in response is for RECEIVING, not binding sender
- RTP/RTCP protocol: Bidirectional by design (RFC 3550)
