# Firmware Cache Fix — Force iOS Re-read After Config Changes

**Date**: 2026-10-02  
**Commit**: [current]  
**Root cause**: iOS cached old audio advertisement despite ARGUS_AUDIO=0

---

## Field Evidence (Mini @ 3568b2c, evening 2026-10-01)

**After pad/bitrate fixes**:
- ✅ Thumbnails: OK (padding worked)
- ✅ Logs: asked=299k serving=299k, pad, first_frame, 30fps
- ❌ Live: **Endless spinner**

**ARGUS_AUDIO=0 diagnostic test**:
```
Set ARGUS_AUDIO=0 (video-only mode)
→ FFmpeg spawned with video-only (no audio RTP)
→ Negotiation logs STILL showed: audio: codec=AAC-eld
→ Spinner unchanged
```

**The smoking gun**: Home negotiated audio even though we advertised empty audio codecs array.

---

## Root Cause: iOS Firmware Cache

### How iOS Caches Accessories

When an accessory pairs with iOS Home:
1. iOS reads advertised capabilities (resolutions, codecs, etc.)
2. iOS **caches this in AccessoryInfo**
3. iOS **only re-reads on firmware version change**

**From HAP-NodeJS docs & code comments**:
> "iOS pins camera streaming profiles hard: a manual configVersion bump alone did NOT make a paired iPhone re-read... Controllers DO refresh accessory metadata on a firmware update"

### What Happened

**Timeline**:
1. **Before**: Argus advertised audio codecs [AAC-ELD, Opus]
   - iOS cached: "This camera has audio"
   - Firmware: 1.1.0
   
2. **ARGUS_AUDIO=0 set**: Code correctly advertised empty audio codecs `[]`
   - But firmware stayed: 1.1.0
   - iOS cache: Still "This camera has audio" (cached from before)
   
3. **Session start**:
   - iOS negotiates: "I want video + AAC-ELD audio" (from cache)
   - Argus sends: Video only (no audio RTP, correct per ARGUS_AUDIO=0)
   - iOS waits: For audio that never arrives
   - Result: **Endless spinner**

### Why This Applies Even With ARGUS_AUDIO Unset

**Current state** (likely):
- Mini may have `ARGUS_AUDIO=0` in LaunchAgent from diagnostic test
- OR iOS cached the "no audio" state from that test
- Now even with audio re-enabled, iOS cache is stale

**Either direction breaks**:
- Cached "has audio" + send video-only → spinner (waiting for audio)
- Cached "no audio" + send audio → possibly ignored/rejected

**Solution**: Bump firmware version → iOS re-reads → cache invalidated.

---

## The Fix

### Bump Firmware Version

**Before** (all commits through 3568b2c):
```typescript
export const ARGUS_FIRMWARE_REVISION = "1.1.0";
```

**After**:
```typescript
export const ARGUS_FIRMWARE_REVISION = "1.2.0";
```

**What this does**:
1. HAP-NodeJS sees firmware increased
2. HAP-NodeJS auto-bumps `configVersion` (c# in mDNS)
3. iOS sees c# change
4. iOS **re-reads all accessory metadata**
5. iOS cache refreshed with current audio codec advertisement

### Ensure Audio Works By Default

**Code already correct** (line 790):
```typescript
audio: {
  codecs: includeAudio
    ? [AudioStreamingCodecType.AAC_ELD, AudioStreamingCodecType.OPUS]
    : [],  // Empty when ARGUS_AUDIO=0
}
```

**Default** (`ARGUS_AUDIO` not set):
- `includeAudio = true`
- Advertises: AAC-ELD + Opus
- Sends: Audio RTP matching negotiation
- **This should work after firmware bump**

---

## Expected Behavior After Fix

### On Mini Redeploy (Firmware 1.2.0)

**iOS detects firmware change**:
1. Sees "Garage Door firmware updated: 1.1.0 → 1.2.0"
2. Re-reads streaming capabilities
3. Sees current audio codec list (depends on ARGUS_AUDIO setting)
4. Cache refreshed

**If ARGUS_AUDIO=0 still set** (video-only):
- iOS sees: Empty audio codecs
- iOS negotiates: Video only
- Argus sends: Video only
- **Works** (both sides agree)

**If ARGUS_AUDIO unset** (default, audio enabled):
- iOS sees: [AAC-ELD, Opus]
- iOS negotiates: Video + AAC-ELD (or Opus)
- Argus sends: Video + libfdk_aac (AAC-ELD)
- **Works** (both sides agree)

---

## Deployment (Mini)

```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad
npm install && npm run build

# CRITICAL: Remove ARGUS_AUDIO=0 if still set (unless intentionally video-only)
# Check LaunchAgent plist for <key>ARGUS_AUDIO</key><string>0</string>
# If present and unintended, remove that key/value pair

launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

**iOS will detect**:
```
Firmware: 1.1.0 → 1.2.0
→ Refresh accessory metadata
→ Cache cleared
```

**Then test**:
1. Trigger motion (any camera)
2. Tap notification
3. **Video should leave spinner and render** ✅
4. Audio should be present (unless ARGUS_AUDIO=0 intentionally set)

---

## Verification Steps

### Check LaunchAgent Config

```bash
# On Mini
cat ~/Library/LaunchAgents/dev.point-labs.argus.plist | grep -A1 ARGUS_AUDIO
```

**If output shows**:
```xml
<key>ARGUS_AUDIO</key>
<string>0</string>
```

**Action**: Remove those lines if video-only mode is NOT intended.

### Check Logs After Deploy

**Expected with audio** (default):
```
HomeKit negotiated ... audio: codec=AAC-eld 24kHz (encoding libfdk_aac/aac_eld)
ffmpeg ... -c:a libfdk_aac -profile:a aac_eld ...
```

**Expected without audio** (ARGUS_AUDIO=0):
```
HomeKit negotiated ... (no audio line)
ffmpeg ... (no -c:a args)
```

**Critical**: Negotiation must match what we send.

### iOS Home App

**After firmware bump**:
- Open Home app
- May see "Updating accessories..." or similar
- Firmware version visible in accessory details: 1.2.0
- **Test live feed**: Should leave spinner and show video

---

## Why This Happened

**Diagnostic test artifacts**:
- `ARGUS_AUDIO=0` was set for diagnostic isolation (2026-10-01)
- This correctly changed advertisement to video-only
- But firmware version wasn't bumped
- iOS kept cached "has audio" state
- Mismatch caused spinner

**The fix ensures**:
- Firmware bump invalidates iOS cache
- Current advertisement (with or without audio) takes effect
- No more stale cache causing mismatches

---

## Alternative: Re-pair Accessory

**If firmware bump doesn't work** (shouldn't happen but possible):

```bash
# On Mini
# 1. Remove from Home app (tap accessory > settings > Remove)
# 2. Delete persist/ directory to reset pairing state
rm -rf ~/Projects/argus/persist/

# 3. Restart Argus
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist

# 4. Re-add to Home app (scan QR code)
```

**This is a LAST RESORT**. Firmware bump should work.

---

## Summary

**Root cause**: iOS cached old audio advertisement despite config change (ARGUS_AUDIO=0 test).

**Why spinner**: Home negotiated audio (from cache) while we sent video-only → waits forever.

**Fix**: Bump firmware 1.1.0 → 1.2.0 → iOS refreshes cache → current config takes effect.

**Expected**: Video leaves spinner and renders after firmware bump + redeploy.
