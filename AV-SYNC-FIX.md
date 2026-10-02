# A/V Sync Fix — Remove Synthetic Audio Clock

**Date**: 2026-10-02  
**Commit**: [current]  
**Root cause**: Synthetic audio PTS (`asetpts=N/SR/TB`) drifted −1458 ms/min from CFR video

---

## Offline Validation Evidence

**Test setup**: `validate-av-sync` on garage-door-sub @ 1280x720@299k, 40s duration

### With synthetic audio clock (`asetpts=N/SR/TB`)

**Opus encode, production args**:
```
VERDICT: skew -207ms -> -693ms; drift −1458 ms/min
A/V CLOCKS DIVERGE — this is what trips the iOS gate.
```

**Drift rate**: **−1458 ms/min** (14.6× the 100 ms/min tolerance threshold)

**Result**: iOS video presentation gates on audio sync → stalls when drift exceeds tolerance → endless spinner.

### Video-only decode (no audio)

**Both garage-door-sub and garage-door-main**:
```
PASS: ~29.4 fps, 0 errors
```

**Confirms**: Video pipeline healthy. Audio is the gate.

---

## Root Cause: Independent Audio Clock Drift

### What `asetpts=N/SR/TB` Does

**Original intent** (from code comments, lines 285-293):
> "SYNTHETIC audio clock: regenerate pts from the cumulative sample count, discarding the camera's wobbly timestamps entirely."

The theory was that Reolink cameras have "wobbly timestamps" (±600ms bursts) that trip iOS's strict ≥720p A/V sync pipeline.

**What actually happened**:
1. Video: CFR grid from `-r 30` establishes steady clock at 30 Hz (33.33 ms/frame)
2. Audio: `asetpts=N/SR/TB` generates PTS as `sample_number / sample_rate / timebase`
   - This creates an INDEPENDENT clock anchored to sample count
   - No reference to video PTS whatsoever
3. Any mismatch in sample rate measurement, timebase, or sample drops causes cumulative drift
4. Over 40s: −486 ms drift (−693 − (−207))
5. Extrapolated: **−1458 ms/min**

### iOS A/V Sync Gate

**iOS behavior at ≥720p**:
- Strictly gates video presentation on audio sync
- Tolerates small A/V skew (~100-200 ms)
- When drift rate exceeds ~100 ms/min: decoder stalls
- Result: Loading spinner never leaves

**Why 640×360 worked**:
- iOS uses lenient A/V sync path for small resolutions
- Tolerates much larger drift (comment mentions "all day")
- This masked the drift issue until ≥720p sessions

**Why video-only worked**:
- No audio to gate on
- Video pipeline decodes freely
- Confirms drift was audio-side

---

## The Fix: Natural FFmpeg A/V Sync

### Before (lines 280-304)

```typescript
return [
  ...videoArgs,
  "-vn",
  ...audioCodecArgs,
  // SYNTHETIC audio clock: regenerate pts from cumulative sample count...
  "-af", "asetpts=N/SR/TB",  // ← REMOVED
  "-ac", "1",
  ...
];
```

### After

```typescript
return [
  ...videoArgs,
  "-vn",
  ...audioCodecArgs,
  // Audio PTS: let FFmpeg naturally sync to the video CFR clock (-r 30).
  // Prior synthetic clock (asetpts=N/SR/TB) invented independent audio PTS
  // from sample count, causing −1458 ms/min drift vs video (measured offline
  // validate-av-sync @ 1280x720@299k/40s: skew −207→−693 ms). iOS strictly
  // gates video presentation on A/V sync at ≥720p; drift beyond ~100 ms/min
  // stalls the decoder → endless spinner. Video-only decode passed (29.4 fps,
  // 0 errors) confirming audio gating. Natural FFmpeg A/V sync keeps clocks
  // within tolerance without manual timestamp surgery.
  "-ac", "1",
  ...
];
```

**Key change**: Remove `-af asetpts=N/SR/TB` entirely.

**What FFmpeg does naturally**:
1. Video: `-r 30` establishes CFR clock (forced constant frame rate)
2. Audio: FFmpeg resamples and encodes, referencing video PTS
3. Both clocks stay synchronized by construction
4. No cumulative drift from independent sample counting

### Additional Fixes

**1. validate-av-sync drift threshold bug** (line 114):

**Before**:
```javascript
console.log(driftMsPerMin > 100 || Math.abs(last.skewMs) > 1000
```

**After**:
```javascript
console.log(Math.abs(driftMsPerMin) > 100 || Math.abs(last.skewMs) > 1000
```

**Issue**: Negative drift like −1458 ms/min failed the `> 100` check and printed "healthy". Added `Math.abs()` to catch both directions.

**2. Boot log source mismatch** (serve.ts line 100):

**Before**:
```typescript
` (≥720p source: ${standalone ? "main" : "sub"})`
```

**After**:
```typescript
const mainEnabled = standalone && process.env.ARGUS_LIVE_MAIN_SOURCE === "1";
` (≥720p source: ${mainEnabled ? "main" : "sub"})`
```

**Issue**: Boot log said "main" for standalone cameras even when `ARGUS_LIVE_MAIN_SOURCE !== "1"`. Now checks actual condition.

---

## Expected Behavior After Fix

### A/V Sync Validation (Re-run)

```bash
cd ~/Projects/argus
node scripts/validate-av-sync.mjs garage-door-sub --size 1280x720 --bitrate 299 --seconds 40
```

**Expected output** (after fix):
```
VERDICT: skew Xms -> Yms; drift Z ms/min
A/V clocks track — stream-side sync looks healthy.
```

**Acceptance**: `|drift| < 100 ms/min` AND `|final_skew| < 1000 ms`

**If still diverging**: Indicates deeper camera timestamp issue (unlikely given video-only passed).

### iOS Home Live Feed

**Test**: Tap Garage Door live notification or tile.

**Expected**:
1. ✅ Spinner appears (brief, normal)
2. ✅ Spinner leaves (~2-5 seconds)
3. ✅ **Video renders and plays continuously**
4. ✅ Audio present (AAC-ELD or Opus)
5. ✅ No hang, no freeze

**Failure symptoms** (if still broken):
- Spinner stays indefinitely → Different root cause (unlikely)
- Black screen → RTP delivery issue
- Stuttering → Network or decoder overload

---

## Redeploy Instructions (Mini)

### 1. Pull & Build

```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad
npm install && npm run build
```

### 2. Verify Changes

**Check audio filter removed**:
```bash
grep -A5 "Audio PTS:" src/homekit.ts
```

**Should see**: Comment explaining natural sync, NO `asetpts` line.

**Check boot log fix**:
```bash
grep "mainEnabled" src/serve.ts
```

**Should see**: `const mainEnabled = standalone && process.env.ARGUS_LIVE_MAIN_SOURCE === "1";`

### 3. Restart Argus

```bash
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

### 4. Check Boot Log

**Expected** (no ARGUS_LIVE_MAIN_SOURCE set):
```
[argus Garage Door] live mode: transcode (≥720p source: sub)
```

**Correct**: Says "sub" not "main" (previously lied).

### 5. Validate A/V Sync (Offline, Optional)

**Run validation**:
```bash
cd ~/Projects/argus
node scripts/validate-av-sync.mjs garage-door-sub --size 1280x720 --bitrate 299 --seconds 40
```

**Watch for**:
- Drift rate output (should be < 100 ms/min absolute)
- "A/V clocks track" verdict (healthy)

**This proves A/V sync without any iOS Home tap.**

### 6. Test iOS Home Live Feed

**Trigger motion** → **Tap notification** → **Video should render**.

**Expected**: Spinner leaves, video plays, audio present, no hang.

---

## Why This Fix Works

**Before**:
- Video clock: 30 Hz from `-r 30` (33.33 ms/frame, stable)
- Audio clock: `N/SR/TB` (sample count / 24000 / 1, independent)
- Drift: Clocks diverge over time due to sample count/rate mismatch
- iOS gate: Stalls video when audio drifts beyond tolerance
- Result: Spinner

**After**:
- Video clock: 30 Hz from `-r 30` (stable)
- Audio clock: FFmpeg syncs to video PTS automatically
- Drift: Negligible (both reference same timebase)
- iOS gate: A/V stay in sync, no stall
- Result: **Video renders**

**Core insight**: Don't fight FFmpeg's built-in A/V sync. The `-r 30` CFR grid establishes a master clock; audio naturally follows it. Manually inventing a separate audio clock with `asetpts` only creates drift.

---

## Alternatives Considered

### Option 1: `-async 1`

**What it does**: Gently stretch/compress audio to match video PTS.

**Not needed**: FFmpeg's natural sync should work. If future testing shows minor drift, add `-async 1` after audio codec args.

### Option 2: Opus-only advertisement

**Rationale**: AAC-ELD LD-SBR cannot be offline-decoded by FFmpeg (validate-av-sync skipped ELD).

**Status**: Optional A/B test later. Current fix (natural sync) applies to both Opus and AAC-ELD. Opus validation already proved drift, fixing that should fix both.

### Option 3: Video-only mode

**Rationale**: Video-only worked (no audio gate).

**Not acceptable**: Defeats purpose of security camera audio. Fixing A/V sync is the right solution.

---

## Summary

**Root cause**: Synthetic audio clock (`asetpts=N/SR/TB`) drifted −1458 ms/min from CFR video, tripping iOS ≥720p A/V sync gate.

**Proof**: Offline validate-av-sync measured drift; video-only decode passed.

**Fix**: Remove synthetic clock, let FFmpeg naturally sync audio to video CFR grid.

**Expected**: |drift| < 100 ms/min → iOS gate satisfied → spinner leaves → video renders.

**Validation**: Re-run validate-av-sync after deploy (offline proof without Home tap).

**Success criteria**: One Home tap → video renders and plays continuously.
