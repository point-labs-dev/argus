# A/V Sync Fix — Final: aresample Filter for Continuous Sync

**Date**: 2026-10-02  
**Root cause**: Deprecated `-async 1` flag broke decode; need modern continuous sync filter  
**Evidence**: Mini @ 0bb31e5: "insufficient decode on one or both legs" (no video/audio output)

---

## What Happened at 0bb31e5

### The `-async 1` Failure

**Theory**: `-async 1` syncs audio resampler to video PTS

**Implementation** (commit 877bef3):
```typescript
"-async", "1",  // Deprecated flag
```

**Mini reality** (authoritative @ 0bb31e5):
```
validate-av-sync garage-door-sub 1280x720@299k 40s:
Verdict: insufficient decode on one or both legs
Samples: 0.00/0.00 clocks; skew 0 ms at 10/20/30s
No drift ms/min (neither leg decoded)
Errors: no output video stream; audio output empty
```

**Worse than e4cbcc0**: Previous tip at least decoded and reported −360 ms/min. `-async 1` broke everything.

---

## Root Cause: Deprecated Flag Incompatibility

### Why `-async 1` Failed

**From FFmpeg documentation**:
> `-async samples_per_second` (deprecated)  
> Audio sync method. Use `-af aresample=async=...` filter instead.

**What went wrong**:
1. `-async` is deprecated flag from old FFmpeg versions
2. May not work with modern filter graphs
3. Interaction with `-ar` resampling and codec args caused decode failure
4. Filter-based approach (`-af aresample`) is the modern replacement

**Comparison**:
- **e4cbcc0** (no sync): Decoded, drift −360 ms/min (failing but working)
- **0bb31e5** (`-async 1`): No decode (broken)
- **This fix** (`-af aresample`): Decode + sync (expected working)

---

## The Fix: Modern aresample Filter

### Code Change

**File**: `src/homekit.ts` line ~291

**Before** (0bb31e5, broke decode):
```typescript
"-async", "1",  // Deprecated flag
"-ac", "1",
"-ar", `${audio.sampleRateKhz}k`,
```

**After** (modern filter):
```typescript
"-af", "aresample=async=1000:first_pts=0",  // Modern continuous sync
"-ac", "1",
"-ar", `${audio.sampleRateKhz}k`,
```

### What It Does

**`-af aresample=async=1000:first_pts=0`**:

**`async=1000`**:
- Continuously adjust audio sampling to match video PTS
- Allows up to 1000 samples/sec correction (aggressive but safe for ambient audio)
- Unlike `-async 1` (start-only), this provides **continuous** correction
- Compensates for camera clock drift throughout session

**`first_pts=0`**:
- Align initial audio timestamp to video
- Avoids startup offset
- Ensures A/V start synchronized

**Why continuous correction**:
- `-async 1` only corrected start (if it had worked)
- Camera clock drift is continuous (−360 ms/min = −6 ms/sec)
- Need ongoing adjustment, not just startup fix

---

## Expected Outcome

**Before any sync** (e4cbcc0, asetpts removed):
- Decode: ✓ (video + audio decoded)
- Drift: −360 ms/min (FAIL, 3.6× threshold)

**After `-async 1`** (0bb31e5, deprecated flag):
- Decode: ✗ (no output)
- Drift: N/A (couldn't measure, broken)

**After `aresample` filter** (this fix):
- **Decode: ✓** (expected working like e4cbcc0)
- **Drift: < 100 ms/min** (expected PASS with continuous sync)

---

## Verification Command (Mini — Authoritative)

**Must run on Mini**:

```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad
npm install && npm run build

# THE AUTHORITATIVE TEST
node scripts/validate-av-sync.mjs garage-door-sub --size 1280x720 --bitrate 299 --seconds 40
```

**Expected output**:
```
stream=garage-door-sub 1280x720@299k for 40s
t(s)  video_clock(s)  audio_clock(s)  skew(ms)
  10         10.XX         10.XX         ±X
  20         20.XX         20.XX         ±Y
  30         30.XX         30.XX         ±Z
  40         40.XX         40.XX         ±W

VERDICT: skew Xms -> Yms; drift Z ms/min
A/V clocks track — stream-side sync looks healthy.
```

**Acceptance**:
- ✅ **Both legs decode** (video_clock > 0, audio_clock > 0)
- ✅ **|drift| < 100 ms/min**
- ✅ Verdict: "A/V clocks track"

**Comparison baselines**:
- e4cbcc0 (no sync): decode OK, drift −360 ms/min (FAIL but working)
- 0bb31e5 (`-async 1`): no decode (broken)
- This fix: decode OK, drift < 100 (expected PASS)

---

## Technical Deep Dive

### Why Modern Filter vs Deprecated Flag

**Old approach** (`-async`):
```bash
ffmpeg -i input.rtsp -async 1 -ar 24k output.mp4
```
- Global flag, applied before filter chain
- Deprecated since FFmpeg 4.x
- May conflict with modern filter graphs
- Start-correction only (special case =1)

**Modern approach** (`-af aresample`):
```bash
ffmpeg -i input.rtsp -af aresample=async=1000:first_pts=0 -ar 24k output.mp4
```
- Audio filter, part of filter chain
- Official replacement for `-async`
- Continuous correction (async=N allows N samples/sec adjustment)
- Explicit timestamp alignment (first_pts=0)

### Filter Chain Ordering

**Current full audio path**:
```
Camera RTSP
  ↓
[Audio decoder]
  ↓
[aresample filter] ← async=1000:first_pts=0 (sync to video PTS)
  ↓
[-ar 24k resample] ← final sample rate
  ↓
[Audio encoder] ← libfdk_aac or libopus
  ↓
SRTP output
```

**Key**: `aresample` filter with `async` param comes BEFORE final `-ar` resampling, syncing the audio stream to video timebase.

### Why async=1000 Specifically

**Values**:
- `async=1`: Would be equivalent to old `-async 1` (start-only)
- `async=1000`: Allows up to 1000 samples/sec correction (continuous)
- Higher values: More aggressive, may degrade quality

**For −360 ms/min drift**:
- −360 ms/min = −6 ms/sec
- At 24 kHz: −6 ms = 144 samples
- `async=1000` provides 6.9× headroom (1000 > 144)
- More than enough to compensate

**Quality impact**:
- Continuous stretching by <0.6% (144/24000)
- Imperceptible for ambient security audio
- No pitch shift artifacts at this level

---

## Tests & Regressions

### Test Status

**All 73 tests pass** ✅

**No test changes needed**:
- Tests don't validate specific `-af` filter content
- Command structure unchanged

### Regression Checks

**Should NOT affect**:
- ✅ Dimensions (pad still works)
- ✅ Bitrate (honor negotiated still works)
- ✅ Audio codec (libfdk_aac AAC-ELD still works)
- ✅ Video encoding (no changes)

**Should ONLY affect**:
- ✅ A/V clock drift (−360 → < 100 ms/min expected)
- ✅ Decode reliability (broken @ 0bb31e5 → working)

---

## Deployment (Mini)

### 1. Pull & Build

```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad
npm install && npm run build
```

**Verify aresample in dist**:
```bash
grep "aresample=async" dist/homekit.js
```

Should see: `"-af", "aresample=async=1000:first_pts=0",`

### 2. Run Validator

**Same command as before**:
```bash
node scripts/validate-av-sync.mjs garage-door-sub --size 1280x720 --bitrate 299 --seconds 40
```

**Expected**: Both legs decode + |drift| < 100 ms/min

### 3. If Passing, Test Live

**After validator passes**:
```bash
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

**Field test**:
- Trigger motion → tap notification
- Spinner should leave (~1-2s)
- Video renders continuously
- Audio present

---

## If Still Failing

### Symptom 1: Still No Decode

**Check**: FFmpeg command in logs, ensure `-af aresample=async=1000:first_pts=0` present

**Debug**: Run FFmpeg manually with same args, check stderr

**Possible issue**: Filter syntax error or incompatibility

**Fallback**: Try simpler filter `-af aresample=async=1:first_pts=0` (less aggressive)

### Symptom 2: Decode Works But Drift Still High

**Check**: Drift value (e.g., still −200 ms/min)

**Possible**: `async=1000` not aggressive enough for this camera

**Fallback**: Increase to `-af aresample=async=10000:first_pts=0` (10× more correction)

### Symptom 3: Audio Quality Degraded

**Check**: Crackling, pitch shifts, artifacts

**Possible**: `async=1000` too aggressive for this codec

**Fallback**: Reduce to `-af aresample=async=100:first_pts=0`

---

## Evolution Summary

**1. Original** (before d47c97d): `asetpts=N/SR/TB`
- Synthetic audio clock from sample count
- Drift: −1458 ms/min (broken)

**2. asetpts removal** (d47c97d → e4cbcc0): "Natural sync"
- No explicit sync, audio resampler independent
- Drift: −360 ms/min (improved but still failing, 3.6× threshold)

**3. `-async 1` attempt** (877bef3 → 0bb31e5): Deprecated flag
- Tried old FFmpeg flag for sync
- Result: **No decode** (broken, worse than e4cbcc0)

**4. `aresample` filter** (this fix): Modern continuous sync
- Proper filter-based approach
- **Expected**: Decode works + |drift| < 100 ms/min

---

## Summary

**Root cause**: Deprecated `-async 1` flag broke decode completely.

**Evidence**: Mini @ 0bb31e5: no video/audio output (worse than e4cbcc0).

**Fix**: Replace with modern `-af aresample=async=1000:first_pts=0` filter for continuous A/V sync.

**Expected**: 
- Decode works (like e4cbcc0)
- |drift| < 100 ms/min (unlike e4cbcc0's −360)

**Verification required**: Mini must run authoritative validate-av-sync and confirm:
1. Both legs decode (video/audio clocks > 0)
2. |drift| < 100 ms/min
3. Verdict "A/V clocks track"

**No claim-done** until Mini evidence matches expected.

**Tests**: 73/73 pass, no regressions.

**Ready for Mini verification.**
