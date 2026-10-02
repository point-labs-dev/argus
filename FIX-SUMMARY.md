# HomeKit Live Feed Fix - Implementation Report

**Date**: 2026-10-02  
**Branch**: `cursor/fix-live-feed-hang-18ad`  
**PR**: [#3](https://github.com/point-labs-dev/argus/pull/3) (remains DRAFT, not merged)  
**Commit**: `e045386`  
**Firmware**: 1.3.4

---

## Summary

Removed `localrtpport` parameter from ffmpeg SRTP URLs to enable proper bidirectional RTCP communication between HomeKit and the accessory. Prior fix (1.3.3) **failed field test** - this addresses the actual root cause.

---

## What Changed

### Code Changes

**`src/homekit.ts`**:
- **Line 271** (video): Removed `&localrtpport=${video.localRtcpPort}` from SRTP URL
- **Line 323** (audio): Removed `&localrtpport=${audio.localRtcpPort}` from SRTP URL  
- **Firmware**: Bumped `1.3.3` → `1.3.4` with field test notes

**`tests/homekit.test.ts`**:
- Updated test expectations to match new SRTP URL format (no `localrtpport`)
- Updated firmware version assertion `1.3.3` → `1.3.4`

**New file**: `BIDIRECTIONAL-RTCP-FIX.md` - Complete technical documentation

### Build Status

✅ **All 77 tests pass**  
✅ **Build succeeds** (`npm run build`)  
✅ **TypeScript compilation clean**

---

## Root Cause Analysis

### What Was Wrong (1.3.3)

The `localrtpport` parameter created a **port binding conflict**:

1. **prepareStream** told HomeKit: "I'm listening on port X" (for RTCP from HomeKit to us)
2. **ffmpeg** bound port X as its **sending** port via `localrtpport=X`
3. **Conflict**: Port X was bound for outbound RTP, NOT listening for inbound RTCP
4. **Result**: HomeKit couldn't send RTCP back → killed stream as "non-responsive"

### Why Prior Hypothesis Failed

**1.3.3 claimed**: "30-second RTCP timeout" (based on Home Assistant PR #99989)

**Field reality**: Stream never unlocked **from first open** (not after 30s)

**Misunderstanding**: Home Assistant's fix was about firewall/NAT port tracking, NOT fixing HomeKit unlock. We misapplied their solution to a different problem.

### The Actual Issue

HomeKit requires **bidirectional RTP/RTCP** (RFC 3550):
- Accessory → HomeKit: RTP data + RTCP sender reports
- HomeKit → Accessory: RTCP receiver reports, NACKs, feedback

When `localrtpport` bound our advertised listening port for sending, HomeKit couldn't send its half of the RTCP exchange → stream considered dead → no unlock.

---

## The Fix

### Before (1.3.3)
```typescript
srtp://192.168.x.x:50000?rtcpport=50000&localrtpport=60000&pkt_size=564
```
- Sends RTP FROM port 60000 TO port 50000
- Sends RTCP FROM port 60001 TO port 50000
- HomeKit can't send back (port 60000 bound, not listening)

### After (1.3.4)
```typescript
srtp://192.168.x.x:50000?rtcpport=50000&pkt_size=564
```
- Sends RTP FROM random port TO port 50000
- Sends RTCP FROM random+1 TO port 50000
- HomeKit CAN send back to ffmpeg's actual source port (tracked via RTP/RTCP flow)

**Pattern source**: homebridge-camera-ffmpeg (most widely deployed HomeKit camera)

---

## Files Modified

```
src/homekit.ts               - Core fix (removed localrtpport)
tests/homekit.test.ts        - Updated test expectations
BIDIRECTIONAL-RTCP-FIX.md    - Technical documentation (NEW)
```

---

## Mini Deployment Checklist

### 1. Fetch & Build
```bash
cd ~/argus-workspace  # or wherever repo lives
git fetch origin
git reset --hard e045386
npm install
npm run build
```

### 2. Verify Firmware
```bash
grep "ARGUS_FIRMWARE_REVISION" src/homekit.ts
# Should show: export const ARGUS_FIRMWARE_REVISION = "1.3.4";
```

### 3. Restart Service
```bash
launchctl kickstart -k gui/$(id -u)/dev.point-labs.argus
```

### 4. Check Logs for New Command
```bash
tail -f ~/Library/Logs/argus/argus.log
```

**Critical verification**: ffmpeg command should show:
```
srtp://192.168.x.x:50000?rtcpport=50000&pkt_size=564
```

**NO `localrtpport` parameter** - if you see `&localrtpport=`, deployment failed.

### 5. Test on iPhone

Open Garage Door in Home app:
- **Expected**: Live picture within 2s
- **Expected**: Video runs continuously (no timeout)
- **Expected**: No "No Response" message

Check iOS Settings → Home → Garage Door:
- **Firmware Version** should show `1.3.4`

### 6. Verification Logs

What to look for in `argus.log`:

```
HomeKit negotiated video: 1280x720@30 profile=baseline ...
ffmpeg ffmpeg ... srtp://192.168.x.x:50000?rtcpport=50000&pkt_size=564 ...
live_session_first_frame: ~0.7-1.3s
```

**Should NOT see**: ffmpeg exit/SIGKILL within a few seconds of start

---

## Residual Risks

### If Fix Still Doesn't Unlock

1. **Issue might be deeper**: SRTP key negotiation, RTP timestamp sync, or codec compatibility
2. **Need packet capture**: Wireshark/tcpdump to see actual RTP/RTCP exchange
3. **iOS cache**: May need to remove/re-add camera (nuclear option)

### If Firewall/NAT is Involved

Random source ports MIGHT not traverse NAT (but local LAN testing should be fine). If deployment is behind NAT, monitor for any port mapping issues.

### Prior Fixes Preserved

All these wins are **kept** (not regressed):
- ✅ Video-only mode (ARGUS_AUDIO=0)
- ✅ Baseline H.264 profile (forced)
- ✅ In-band SPS/PPS (dump_extra)
- ✅ Exact dimension padding
- ✅ Honor negotiated bitrate
- ✅ Small packets for hi-res (564 bytes)

---

## Why This Should Work

1. **Standard pattern**: homebridge-camera-ffmpeg uses this exact approach (no `localrtpport`)
2. **Protocol compliance**: Allows proper bidirectional RTCP (RFC 3550)
3. **Port logic fix**: Stops binding the advertised listening port for sending
4. **Minimal change**: Only removes the problematic parameter

---

## Next Steps if This Fails

If 1.3.4 still shows no live feed:

1. **Capture detailed logs**: Full ffmpeg stderr during failed attempt
2. **Packet capture**: tcpdump/Wireshark of SRTP session (both directions)
   - Are RTP packets arriving at HomeKit?
   - Is HomeKit sending RTCP back?
   - Packet loss / timing issues?
3. **Test alternate client**: Mac Home app (not just iPhone) to isolate device-specific behavior
4. **Consider listening socket**: May need to actually LISTEN on advertised port (add UDP receiver)
5. **Check RTP timestamps**: Verify timing/synchronization in packets

---

## Historical Context (Why We're Here)

### Field Test Progression

| Version | Change | Result |
|---------|--------|--------|
| 1.3.1 | Force Baseline H.264 | No unlock |
| 1.3.2 | Video-only prepareStream | No unlock |
| 1.3.3 | Add localrtpport (RTCP fix) | **Field test: NO unlock** |
| 1.3.4 | Remove localrtpport | **Testing now** |

### What We Learned

- **Thumbnails work** → Camera access is fine
- **Encode path healthy** → ffmpeg produces frames (~30fps, first frame <1.3s)
- **HomeKit kills quickly** → Not a timeout, something fundamentally wrong with stream
- **Issue is protocol-level** → Not codec/encoding/bitrate

---

## Deployment Summary

**SHA**: `e045386`  
**Firmware**: `1.3.4`  
**PR**: #3 (draft)  
**Tests**: ✅ 77/77 pass  
**Build**: ✅ Clean  

**Files**: `src/homekit.ts`, `tests/homekit.test.ts`, `BIDIRECTIONAL-RTCP-FIX.md`

**Key change**: Removed `localrtpport` from SRTP URLs (video + audio)

**Hypothesis**: Enables bidirectional RTCP → HomeKit can send feedback → stream stays alive → picture unlocks

**Field test required**: Deploy to Mini, test with iPhone Home app, verify in logs

---

*See `BIDIRECTIONAL-RTCP-FIX.md` for complete technical details and protocol analysis.*
