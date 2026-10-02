# RTCP Keepalive Fix - Implementation Complete

**Date**: 2026-10-02  
**Branch**: `cursor/fix-live-feed-hang-18ad`  
**Commits**: `91e9693`, `5fa17fc`  
**Status**: ✅ **Code complete, ready for field test**

## Problem Solved

HomeKit live view showed "No Response" after **exactly 30 seconds** (~900 frames), despite healthy video encoding. The prepareStream audio hypothesis was **falsified** — video-only configuration was correct, but the 30-second timeout persisted.

## Root Cause Found

**HomeKit's 30-second RTCP timeout**. The accessory wasn't properly exchanging RTCP keepalive packets with HomeKit's controller.

### Technical Details

Our ffmpeg command used:
```bash
srtp://...?rtcpport=50000&localrtcpport=60000&pkt_size=564
```

According to [ffmpeg RTP protocol documentation](https://ffmpeg.org/ffmpeg-protocols.html#rtp):
> If localrtpport (the local RTP port) is not set any available port will be used for the local RTP and RTCP ports.

With only `localrtcpport` specified:
- RTP packets sent from **random source port** (changes every session)
- RTCP packets sent from our specified port (60000)
- HomeKit couldn't correlate RTCP with RTP because they came from different source ports
- After 30 seconds without valid RTCP, HomeKit killed the stream

## The Fix

Changed `localrtcpport` to `localrtpport` in ffmpeg SRTP URLs:

```typescript
// Before (broken):
`srtp://${targetAddress}:${video.port}?rtcpport=${video.port}&localrtcpport=${video.localRtcpPort}&pkt_size=564`

// After (fixed):
`srtp://${targetAddress}:${video.port}?rtcpport=${video.port}&localrtpport=${video.localRtcpPort}&pkt_size=564`
```

Now:
- RTP sent from bound port (60000)
- RTCP sent from RTP port + 1 (60001, per ffmpeg default)
- HomeKit can properly receive and correlate RTCP keepalive packets

## Evidence & Prior Art

### Field Evidence
Mini at commit `600ca5d` (firmware 1.3.2):
- Stream starts, first frame ~1.3s
- Steady encoding at 30fps
- Kills at frame 928, exactly 30 seconds
- **Exactly** the RTCP timeout interval

### Known Issue
This **same bug** was fixed by others:

1. **Home Assistant PR #99989**: ["Make homekit RTP/RTCP source ports more deterministic"](https://github.com/home-assistant/core/pull/99989)
   - Changed from `localrtcpport` to `localrtpport`
   - Same symptom: random RTP port breaking RTCP correlation

2. **Ring Homebridge issue #479**: ["Camera stream stop in home app after 30 sec"](https://github.com/dgreif/ring/issues/479)
   - Quote: "HomeKit must have a 30 second timeout if it does not receive RTCP"
   - Same 30-second timeout

3. **Scrypted issue #228**: ["streaming times out after 30 seconds"](https://github.com/koush/scrypted/issues/228)
   - Error: `[HomeKit]: HomeKit Streaming RTCP timed out. Terminating Streaming.`
   - Explicit RTCP timeout message

## Changes Made

### Code (`91e9693`)

**`src/homekit.ts`**:
1. Changed `localrtcpport` → `localrtpport` in video SRTP URL
2. Changed `localrtcpport` → `localrtpport` in audio SRTP URL
3. Added detailed comments explaining the fix and referencing prior art
4. Bumped firmware 1.3.2 → **1.3.3** (forces iOS to re-negotiate)

**`tests/homekit.test.ts`**:
1. Updated tests to expect `localrtpport` in ffmpeg commands
2. Updated firmware test to expect 1.3.3

**Documentation**:
- `RTCP-KEEPALIVE-FIX.md`: Technical explanation, evidence, references
- `RTCP-FIX-DEPLOYMENT.md`: Field test checklist for Mini (commit `5fa17fc`)

### Test Results

```
✓ tests/homekit.test.ts (27 tests)
✓ All other test suites
Test Files  9 passed (9)
Tests  77 passed (77)
```

Build succeeded, all tests pass.

## Next Step: Field Test

Deploy to Mini (Garage Door camera) and verify:

**Success criteria**:
1. Live view opens within 2 seconds
2. Video renders continuously for **60+ seconds** (not 30s)
3. No "No Response" message
4. Firmware shows 1.3.3 in Home app
5. Logs show `localrtpport` in ffmpeg command

**If PASS**: Video-only with RTCP fix is production-ready  
**If FAIL**: Investigate with packet capture, consider audio restore path

## Deployment Instructions

See [RTCP-FIX-DEPLOYMENT.md](./RTCP-FIX-DEPLOYMENT.md) for complete checklist.

Quick deploy:
```bash
# On Mini
cd ~/Documents/argus
git pull origin cursor/fix-live-feed-hang-18ad
npm run build
sudo launchctl unload ~/Library/LaunchAgents/argus.plist
sudo launchctl load ~/Library/LaunchAgents/argus.plist

# Test: Open Garage Door live view, watch for > 60 seconds
```

## Commit History

```
5fa17fc Add RTCP fix deployment checklist for Mini field test
91e9693 Fix HomeKit RTCP keepalive timeout (firmware 1.3.3)
600ca5d Add deployment checklist for Mini field test
a2ec6ad Add fix summary for video-only prepareStream bug
6f1c802 Document video-only prepareStream fix and deployment
01dee81 Fix video-only prepareStream to not advertise audio ports
2312c70 Force Baseline H.264 profile for Apple Home live unlock
```

## Why This Should Work

1. **Matches successful implementations**: Home Assistant and others fixed the exact same issue with this change
2. **Addresses observed symptom**: 30-second timeout is the documented RTCP keepalive interval
3. **ffmpeg protocol spec compliance**: Using `localrtpport` is the correct way to bind RTP source port
4. **Field evidence aligns**: Exactly 30s = ~900 frames = RTCP timeout, not random failure
5. **Small, targeted change**: Single parameter change in SRTP URL, low risk

## Rollback Plan

If field test fails:
```bash
git checkout 600ca5d  # Previous state (firmware 1.3.2)
npm run build
sudo launchctl restart argus.plist
```

## References

- **Technical docs**: [RTCP-KEEPALIVE-FIX.md](./RTCP-KEEPALIVE-FIX.md)
- **Deployment**: [RTCP-FIX-DEPLOYMENT.md](./RTCP-FIX-DEPLOYMENT.md)
- **FFmpeg protocol**: https://ffmpeg.org/ffmpeg-protocols.html#rtp
- **Home Assistant fix**: https://github.com/home-assistant/core/pull/99989
- **Ring issue**: https://github.com/dgreif/ring/issues/479
- **Scrypted issue**: https://github.com/koush/scrypted/issues/228

---

**Status**: ✅ Code complete, tests pass, documentation written  
**Next**: Field test on Mini (Garage Door camera)  
**Goal**: Live view > 60 seconds without "No Response"
