# Field Deployment Notes — A/V Sync Fix

**Date**: 2026-10-02  
**Commit**: [latest]  
**Target**: Princeton Mac Mini  
**PR**: https://github.com/point-labs-dev/argus/pull/3

---

## Root Cause Summary

**Synthetic audio clock drifted −1458 ms/min from CFR video, tripping iOS A/V sync gate.**

**Offline validation proved**:
- With `asetpts=N/SR/TB`: skew −207→−693 ms over 40s, drift −1458 ms/min
- Video-only decode: PASS (29.4 fps, 0 errors) on both sub and main
- iOS gates video on audio sync at ≥720p; drift beyond ~100 ms/min stalls decoder

**Fix**: Remove synthetic audio clock, let FFmpeg naturally sync audio to video CFR grid.

---

## ~~Firmware Cache Theory~~ (Ruled Out)

Initial hypothesis was iOS cached old audio advertisement despite ARGUS_AUDIO=0 test. Firmware bump to 1.2.0 was attempted but offline validation revealed the actual root cause before field test. Keeping firmware at 1.2.0 for cache hygiene but **A/V clock drift was the blocker.**

When Mini was set to `ARGUS_AUDIO=0` (video-only diagnostic mode), the code correctly advertised empty audio codecs `[]`, but iOS Home retained the cached advertisement from before (`[AAC-ELD, Opus]`). This caused:

1. **iOS negotiation**: "I want video + AAC-ELD audio" (from cache)
2. **Argus sends**: Video only (no audio RTP, correct per ARGUS_AUDIO=0)
3. **iOS waits**: For audio RTP that never arrives
4. **Result**: Endless loading spinner

iOS pins camera streaming profiles to AccessoryInfo cache and **only refreshes on firmware version change**. HAP-NodeJS auto-bumps `configVersion` (c# in mDNS) when `ARGUS_FIRMWARE_REVISION` increases, triggering iOS to re-read accessory metadata.

**The fix**: Bump firmware `1.1.0` → `1.2.0` to invalidate iOS cache and force re-read of current audio codec advertisement.

---

## Redeploy Instructions (Mini)

### 1. Pull & Build

```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad
npm install && npm run build
```

**Expected output**:
```
Already up to date.
or
Updating 3568b2c..35a4316
Fast-forward
 DIMENSION-PAD-FIX.md     | ...
 FIRMWARE-CACHE-FIX.md    | ...
 src/homekit.ts           | ...
 tests/homekit.test.ts    | ...
```

### 2. Check LaunchAgent Environment (CRITICAL)

**Check for ARGUS_AUDIO=0**:
```bash
cat ~/Library/LaunchAgents/dev.point-labs.argus.plist | grep -A1 ARGUS_AUDIO
```

**If output shows**:
```xml
<key>ARGUS_AUDIO</key>
<string>0</string>
```

**Action**: **Remove those lines** if video-only mode is NOT intended. Video-only mode was for diagnostic isolation; the default (audio enabled) should now work with the firmware cache cleared.

**To remove**: Edit the plist and delete the ARGUS_AUDIO key/value pair.

**Check for ARGUS_LIVE_MAIN_SOURCE=1**:
```bash
cat ~/Library/LaunchAgents/dev.point-labs.argus.plist | grep -A1 ARGUS_LIVE_MAIN_SOURCE
```

**If present and causing issues**: This forces live streams to use main (full-res) source. Field evidence showed main source "often hung" on 2026-10-01. Consider removing or setting to `0` to use sub-stream source (default behavior).

### 3. Restart Argus

```bash
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

**Expected**: Argus starts with firmware 1.2.0.

### 4. Verify iOS Detection

**iOS will automatically detect**:
```
Firmware: 1.1.0 → 1.2.0
→ Refresh accessory metadata
→ Cache cleared
→ Current audio codec list applied
```

**This happens in background**. No manual action needed on iOS side (no re-pairing, no accessory removal).

**Check Home app** (optional):
1. Open Home app
2. Long-press on Garage Door camera accessory
3. Tap settings (gear icon)
4. Scroll to bottom: Firmware version should show **1.2.0**

If firmware still shows 1.1.0, Argus may not have restarted yet. Wait ~30s and check again.

---

## Success Criteria: One Home Tap

**Test**: Trigger motion on Garage Door camera, tap notification in iOS Home.

**Expected behavior**:
1. ✅ **Spinner appears** (normal, brief)
2. ✅ **Spinner leaves** (~2-5 seconds)
3. ✅ **Video renders** (Garage Door live view, 1280×720 padded 4:3)
4. ✅ **Audio present** (if ARGUS_AUDIO=0 removed; optional if still set)
5. ✅ **No hang**: Video plays continuously, no infinite spinner

**Failure symptoms** (if still broken):
- Spinner stays indefinitely
- Black screen after spinner leaves
- Video stutters or freezes immediately

**If failure**: Capture logs and report. Unlikely after firmware bump unless:
1. Argus didn't restart with new firmware (check logs for `firmware=1.2.0`)
2. iOS didn't detect firmware change (rare; may need 5-10 minutes or re-pair as last resort)
3. Different root cause (A/V sync, network, etc.)

---

## Offline Verification

**Before deploying to Mini**, you can verify the code changes locally:

### Check Firmware Version

```bash
cd ~/Projects/argus
grep ARGUS_FIRMWARE_REVISION src/homekit.ts
```

**Expected output**:
```typescript
export const ARGUS_FIRMWARE_REVISION = "1.2.0";
```

### Run Tests

```bash
npm test
```

**Expected**:
```
Test Files  9 passed (9)
     Tests  73 passed (73)
```

**New test**: `advertises firmware version 1.2.0 for iOS cache invalidation` verifies the constant is set correctly.

### Verify Audio Codec Advertisement Logic

**Code location**: `src/homekit.ts` line 790

```typescript
audio: {
  codecs: includeAudio
    ? [
        { type: AudioStreamingCodecType.AAC_ELD, samplerate: AudioStreamingSamplerate.KHZ_24 },
        { type: AudioStreamingCodecType.OPUS, samplerate: AudioStreamingSamplerate.KHZ_24 },
      ]
    : [],  // ← Empty when ARGUS_AUDIO=0
}
```

**Correct behavior**:
- `ARGUS_AUDIO=0`: Advertises empty codecs, FFmpeg spawns video-only
- `ARGUS_AUDIO` unset (default): Advertises AAC-ELD + Opus, FFmpeg spawns with libfdk_aac

**Both should work after firmware bump** because iOS cache will match current advertisement.

---

## Expected Post-Deploy State

### Healthy Logs (with audio, default)

**Negotiation**:
```
HomeKit negotiated ... video: 1280x720@30 299kbps audio: codec=AAC-eld 24kHz
(will encode libfdk_aac/aac_eld)
```

**FFmpeg spawn**:
```
ffmpeg ... -i rtsp://... -c:v libx264 -tune zerolatency -r 30 -maxrate 299k -bufsize 299k -c:a libfdk_aac -profile:a aac_eld -flags +global_header ...
```

**Session lifecycle**:
```
live_session_first_frame: first_frame_ms=1700 session_id=...
[steady ~30fps frames]
[Home STOP → SIGKILL after ~30s]
live_session_end: session_id=... frames=900
```

### Healthy Logs (video-only, ARGUS_AUDIO=0)

**Negotiation**:
```
HomeKit negotiated ... video: 1280x720@30 299kbps
(no audio line)
```

**FFmpeg spawn**:
```
ffmpeg ... -i rtsp://... -c:v libx264 -tune zerolatency -r 30 -maxrate 299k -bufsize 299k -f rawvideo ...
(no -c:a args)
```

**Session lifecycle**: Same as audio-enabled (first_frame, frames, STOP, end).

**Key**: Negotiation must match what we send. Cache fix ensures this.

---

## Alternative: Re-pair Accessory (Last Resort)

**If firmware bump doesn't work** (should not be necessary):

```bash
# On Mini
# 1. Remove from Home app
#    - Open Home app
#    - Long-press Garage Door camera
#    - Settings → Remove Accessory

# 2. Delete persist/ directory to reset pairing state
rm -rf ~/Projects/argus/persist/

# 3. Restart Argus
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist

# 4. Re-add to Home app
#    - Scan QR code (displayed in Argus logs on first boot without persist/)
#    - Complete pairing flow
```

**This is a LAST RESORT**. Firmware bump should work. Only re-pair if:
- Firmware shows 1.2.0 in Home app
- AND spinner still persists after 5-10 minutes
- AND logs show negotiation still mismatched with what we send

---

## Summary Checklist

- [ ] **Pull commit 35a4316** from `cursor/fix-live-feed-hang-18ad`
- [ ] **Build**: `npm install && npm run build`
- [ ] **Check LaunchAgent**: Remove `ARGUS_AUDIO=0` if present (unless video-only intended)
- [ ] **Restart Argus**: `launchctl unload/load`
- [ ] **Verify firmware**: Check Home app shows 1.2.0 (may take 30s)
- [ ] **Test one tap**: Motion notification → tap → video should render, no spinner hang
- [ ] **Check logs**: Negotiation matches what we send (audio or video-only)

**Expected outcome**: ✅ Garage Door live feed leaves spinner and shows video on first Home tap.

**If still broken**: Capture logs (full negotiation + FFmpeg spawn + session lifecycle) and report. Re-pair as last resort.
