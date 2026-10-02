# Video-Only Interim Path — Unlock Picture Without A/V Sync

**Date**: 2026-10-02  
**Firmware**: 1.3.0 (bumped from 1.2.0)  
**Purpose**: Shippable interim that unlocks picture while A/V sync remains unsolved

---

## Why Video-Only

### All Audio Sync Attempts Failed Mini's 2/2 Gate

**Goal**: |drift| < 100 ms/min across 2 consecutive 40s validator soaks

**Attempts** (all failed):
1. **e4cbcc0** (asetpts removed): −360 ms/min (inconsistent across soaks)
2. **0bb31e5** (`-async 1`): Run1 −60 PASS, Run2 −258 FAIL (1/2 unstable)
3. **f517acc** (`aresample=async=1000:first_pts=0`): Run1 −261, Run2 −1380 (0/2, degradation)
4. **9bdaf46** (`aresample=async=1:min_hard_comp=0.01`): Run1 −120, Run2 +1101 (0/2, FAIL)

**Result**: 4 attempts, 0 durable passes. Stream-side audio filter tuning cannot stabilize drift.

**Decision**: Video-only path unlocks picture as shippable interim. Audio restoration later when sync solved.

---

## Implementation

### Changes Made

**1. Firmware Bump** (CRITICAL):
```typescript
// src/homekit.ts
export const ARGUS_FIRMWARE_REVISION = "1.3.0";  // Was 1.2.0
```

**Why required**: iOS caches streaming profiles. Field evidence (ARGUS_AUDIO=0 test):
- Empty codecs alone → iOS still negotiated audio (cached 1.2.0 profile)
- Firmware bump → iOS re-reads metadata → honors video-only

**2. Video-Only Path** (already working):
```typescript
// buildLiveFfmpegArgs line 252
if (!includeAudio) {
  return videoArgs;  // Only video, no audio RTP
}
```

**3. Logging Correctness**:
```typescript
// No longer logs fake "encoding audioCodec" when includeAudio=false
const audioLog = this.includeAudio
  ? `audio: codec=... (encoding libfdk_aac)`
  : "audio: none (video-only)";
```

**4. Advertisement** (already working via serve.ts):
```typescript
// src/serve.ts line 87
const includeAudio = process.env.ARGUS_AUDIO !== "0";

// buildCameraControllerOptions line 790
audio: {
  codecs: includeAudio
    ? [AAC_ELD, OPUS]  // Normal path
    : [],              // Video-only: empty array
}
```

---

## Deployment (Mini)

### 1. Pull & Build

```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad
npm install && npm run build
```

**Expected SHA**: Contains firmware 1.3.0 + video-only fixes

**Verify firmware**:
```bash
grep "ARGUS_FIRMWARE_REVISION" dist/homekit.js
# Should see: ARGUS_FIRMWARE_REVISION = "1.3.0"
```

### 2. Set ARGUS_AUDIO=0 (Video-Only Mode)

**Edit LaunchAgent plist**:
```bash
# Edit the file
nano ~/Library/LaunchAgents/dev.point-labs.argus.plist

# Add to <dict> section under EnvironmentVariables:
<key>ARGUS_AUDIO</key>
<string>0</string>
```

**Or if already present**: Verify it's set to `0`

**Why**: Enables video-only mode (includeAudio=false, empty audio codecs)

### 3. Restart Argus

```bash
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

### 4. iOS Will Detect Firmware Change

**Automatic process**:
- iOS sees "Garage Door firmware updated: 1.2.0 → 1.3.0"
- iOS refreshes accessory metadata (re-reads c# config)
- iOS sees empty audio codecs array
- iOS requests video-only sessions

**No full re-pair needed** (firmware bump should be sufficient)

**If iOS shows old firmware** after ~1 minute:
- Long-press accessory in Home app
- Settings → check firmware version
- If still 1.2.0, iOS may need to poll again (wait 5-10 min)
- Last resort: Remove accessory + re-pair (should not be needed)

### 5. Field Test

**Trigger motion** → **Tap notification**

**Expected**:
- ✅ Spinner appears (brief)
- ✅ **Spinner leaves** (1-2s)
- ✅ **Video renders** (Garage Door live feed)
- ✅ **No audio** (expected, video-only mode)
- ✅ **No hang** (picture works!)

**Success criteria**: Video renders without spinner hang (picture > no picture)

---

## Verification Steps

### Check Boot Log

```bash
tail -100 /tmp/argus.log | grep "live mode"
```

**Expected**:
```
[argus Garage Door] live mode: transcode (≥720p source: sub)
```

### Check Session Negotiation

**Trigger live session**, then check logs:

```bash
tail -200 /tmp/argus.log | grep "HomeKit negotiated"
```

**Expected**:
```
HomeKit negotiated video: 1280x720@30 ... audio: none (video-only)
```

**Should NOT see**: "audio: codec=AAC-eld" or "encoding libfdk_aac" (that would mean iOS cached old profile)

### Check FFmpeg Command

**Expected**:
```
ffmpeg ... -c:v libx264 ... -f rtp srtp://...  (no -c:a, no audio section)
```

**Should NOT see**: `-c:a libfdk_aac` or `-af aresample` (that would be audio)

---

## Restoring Audio (Future)

**When durable A/V sync solution exists**:

1. **Remove ARGUS_AUDIO=0**:
   ```bash
   # Edit LaunchAgent plist, delete:
   <key>ARGUS_AUDIO</key>
   <string>0</string>
   ```

2. **Bump firmware again** (e.g., 1.3.0 → 1.4.0):
   ```typescript
   export const ARGUS_FIRMWARE_REVISION = "1.4.0";
   ```

3. **Deploy + restart**:
   - iOS sees firmware change
   - iOS re-reads metadata
   - iOS sees audio codecs restored
   - Audio sessions resume

**Why firmware bump needed again**: iOS caches "video-only" state at 1.3.0. Bump forces re-read of restored audio.

---

## Technical Details

### Why Firmware Bump Required

**iOS caching behavior** (field evidence):
- Accessories have firmware version + config version (c#)
- iOS caches streaming profiles (resolutions, codecs) per firmware version
- HAP-NodeJS auto-bumps c# when firmware version increases
- iOS only re-reads metadata on firmware change

**ARGUS_AUDIO=0 test without bump** (historical):
- Code advertised empty audio codecs
- iOS still negotiated audio (cached from 1.2.0)
- Result: iOS waited for audio RTP we never sent → spinner

**With firmware bump**:
- iOS sees 1.2.0 → 1.3.0
- iOS invalidates cached 1.2.0 profile
- iOS re-reads streaming capabilities
- iOS sees empty codecs → requests video-only

### Video-Only vs Audio Attempts

**Video-only advantages**:
- No A/V sync issues (no audio to sync)
- Guaranteed picture (unlocks core functionality)
- Shippable immediately (no more filter experiments)
- Reversible (restore audio later with firmware bump)

**Disadvantages**:
- No audio (degraded experience)
- Feels like giving up (but 4 attempts all failed)

**Reality**: Picture > no picture. Users can see video, investigate issues, test cameras.

### Why Audio Sync Failed

**Root cause unknown** (hypotheses):
- Camera audio/video clocks fundamentally mismatched (−360 ms/min = 0.025% drift)
- FFmpeg filters cannot compensate (all attempts: worse or unstable)
- Codec-specific (Opus validator vs AAC-ELD production path)?
- iOS gate (< 100 ms/min) too strict for this hardware?

**Needs investigation**:
- Test AAC-ELD in validator (match production codec)
- Field test baseline (e4cbcc0) to see if iOS tolerates −360 in practice
- Different camera hardware with better clocks?

---

## Tests

**All 73 tests pass** ✅

**New test**:
```typescript
it("advertises firmware version 1.3.0 for iOS cache invalidation", () => {
  expect(ARGUS_FIRMWARE_REVISION).toBe("1.3.0");
});
```

**Video-only path**:
- When `includeAudio=false`: `buildLiveFfmpegArgs` returns video-only args
- Controller options: `audio.codecs: []` (empty array)
- Logging: Shows "audio: none (video-only)"

---

## Summary

**Problem**: All audio sync attempts failed Mini's 2/2 gate (4 attempts, 0 passes)

**Solution**: Video-only interim path (firmware 1.3.0 + ARGUS_AUDIO=0)

**Deployment**:
1. Pull latest code
2. Set ARGUS_AUDIO=0 in LaunchAgent
3. Restart Argus
4. iOS detects firmware 1.3.0 → refreshes metadata
5. Field test: Motion → tap → video renders (no audio, no spinner)

**Success criteria**: Video renders without spinner hang

**Future**: Restore audio when durable sync solution exists (bump firmware again)

**Tests**: 73/73 pass ✅

**Ready for Mini deployment.**
