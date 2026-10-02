# Baseline Decision — All Sync Filters Failed

**Date**: 2026-10-02  
**Commit**: c0bd5e6  
**Status**: Reverted to e4cbcc0 baseline (no sync filters) pending investigation

---

## All Sync Attempts Failed

### Timeline of Sync Approaches

**1. Synthetic clock** (`asetpts=N/SR/TB`, before d47c97d):
- Drift: −1458 ms/min
- Issue: Completely independent audio PTS from sample count
- Result: FAIL

**2. No sync** (e4cbcc0 baseline):
- Drift: −360 ms/min (consistent)
- Issue: Audio resampler drifts independently from video CFR
- Result: FAIL but predictable

**3. Start-only correction** (`-async 1`, 0bb31e5):
- Run1: −60 ms/min (PASS)
- Run2: −258 ms/min (FAIL)
- Issue: Unstable, only corrects start offset
- Result: 1/2 FAIL (unstable)

**4. Continuous filter with first_pts** (`aresample=async=1000:first_pts=0`, f517acc):
- Run1: +240 ms/min (FAIL, video clock stalled 16.5s)
- Run2: −1461 ms/min (FAIL)
- Issue: first_pts=0 causes permanent A/V offset (attempt-007 regression)
- Result: 0/2 FAIL (WORST)

---

## Current State: Back to Baseline

### Reverted to e4cbcc0 Audio Path

**No sync filters**:
```typescript
"-vn",
...audioCodecArgs,  // libfdk_aac or libopus
"-ac", "1",
"-ar", `${audio.sampleRateKhz}k`,  // Natural resampling
"-b:a", `${audio.maxBitrateKbps}k`,
```

**What this does**:
- Video: `-r 30` establishes CFR timebase
- Audio: `-ar 24k` resamples naturally without explicit sync
- No manual timestamp surgery
- Consistent −360 ms/min drift (failed but predictable)

**Why revert**:
- All sync attempts made things worse or unstable
- first_pts=0 historically problematic (attempt-007)
- Baseline is at least consistent and doesn't stall video

---

## Investigation Needed

### Hypothesis 1: Codec-Specific Drift

**Observation**:
- Validator uses Opus (hardcoded in SDP)
- Production live uses AAC-ELD (libfdk_aac)
- Drift might be specific to codec/encoder behavior

**Test**:
- Modify validator to test AAC-ELD path
- Compare drift: Opus vs AAC-ELD
- If AAC-ELD passes but Opus fails → validator was misleading

### Hypothesis 2: Camera Clock Fundamentally Mismatched

**Observation**:
- −360 ms/min = −6 ms/sec = 0.025% slower
- Camera audio clock consistently slower than video
- No FFmpeg filter successfully compensated

**Implications**:
- Stream-side sync might be impossible with this camera
- iOS may tolerate the drift in practice (needs field test)
- Or video-only path is the answer

### Hypothesis 3: iOS Tolerates More Than Validator

**Observation**:
- Validator gate: |drift| < 100 ms/min (strict)
- iOS reality: Might tolerate higher drift before gating video
- e4cbcc0 (−360) might work in field despite failing validator

**Test**:
- Deploy e4cbcc0 baseline to Mini
- Field test: Trigger motion → tap notification
- Check if video renders despite −360 ms/min validator reading

---

## Two Paths Forward

### Path A: Stabilize A/V Sync

**Approach**:
1. Test with AAC-ELD in validator (match production codec)
2. Try simpler sync: `-vsync 1` or `-copyts`
3. Investigate camera-specific timing (prebuffer, GOP timing)
4. Field test e4cbcc0 to see if iOS actually tolerates −360

**Pros**:
- Keeps audio (better user experience)
- Matches original goal (fix spinner with A/V)

**Cons**:
- Already tried 4 approaches, all failed
- Might be fundamentally impossible with this camera
- Time-consuming to iterate further

### Path B: Video-Only Interim (Shippable)

**Approach**:
1. Bump `ARGUS_FIRMWARE_REVISION` (e.g., 1.2.0 → 1.3.0)
2. Set `includeAudio: false` in controller options
3. Advertise empty audio codecs array
4. Do NOT prepare/send audio RTP
5. iOS re-reads advertisement, requests video-only

**Implementation**:
```typescript
// Conditional based on env or permanent
const includeAudio = process.env.ARGUS_AUDIO !== "0";

// If disabling audio for A/V issues
const ARGUS_FIRMWARE_REVISION = "1.3.0";  // Bump to invalidate cache

buildCameraControllerOptions({
  ...existing,
  audio: {
    codecs: includeAudio ? [AAC_ELD, OPUS] : [],  // Empty = video-only
  },
});
```

**Pros**:
- Guaranteed no A/V sync issues (no audio to sync)
- Picture > no picture (user can see video)
- Shippable immediately (no more iteration needed)
- Firmware bump prevents cache trap (ARGUS_AUDIO=0 mistake)

**Cons**:
- No audio (degraded experience)
- Feels like giving up on A/V sync
- Might not be what Peter wants

---

## Recommendation

### Immediate: Test e4cbcc0 Baseline in Field

**Deploy current state** (c0bd5e6, same audio path as e4cbcc0):
```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad  # Gets c0bd5e6
npm install && npm run build
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

**Field test**:
1. Trigger motion (Garage Door or any camera)
2. Tap iOS notification
3. Observe: Does video render despite −360 ms/min validator drift?

**If video renders**:
- iOS tolerates −360 ms/min in practice
- Validator gate is too strict
- Ship current state (audio works, spinner resolves)
- ✅ DONE

**If spinner persists**:
- iOS does enforce strict A/V sync
- Need Path A (more sync attempts) or Path B (video-only)

### If Field Test Fails: Implement Video-Only

**Quick path to picture**:
1. Bump firmware to 1.3.0
2. Make `includeAudio: false` default (or env-gated)
3. Ship video-only as interim
4. Investigate A/V sync offline for future restoration

---

## Mini Next Steps

**Current commit**: c0bd5e6 (baseline, no sync filters)

**Run validator** (expect −360 ms/min):
```bash
node scripts/validate-av-sync.mjs garage-door-sub --size 1280x720 --bitrate 299 --seconds 40
```

**Expected**: drift ~−360 ms/min (consistent with e4cbcc0)

**Then field test**:
- Restart Argus
- Trigger motion → tap notification
- Report: Does video render or spinner persist?

**Decision tree**:
- Video renders → ✅ Ship current state (validator too strict)
- Spinner persists → Implement Path B (video-only) or continue Path A

---

## Technical Notes

### Why first_pts=0 Failed

**What it does**:
- Forces audio to start at timestamp 0
- Intended to align initial offset

**What went wrong**:
- Video might not start at 0 (depends on camera/decoder)
- Creates permanent offset if video starts at non-zero
- attempt-007: Caused hung sessions (historical regression)
- f517acc: Video clock stalled 16.5s (blocked encoder?)

**Lesson**: Don't force initial PTS, let FFmpeg manage naturally.

### Why async=1000 Failed

**Theory**: Continuous correction up to 1000 samples/sec

**Reality**:
- Run1: +240 ms/min (wrong direction!)
- Run2: −1461 ms/min (worse than no sync)
- Combined with first_pts=0, created chaos

**Lesson**: Aggressive correction without proper sync point causes instability.

### Why -async 1 Was Best (But Still Failed)

**Results**: 1/2 passing (−60, then −258)

**Why it worked better**:
- Simpler mechanism (start correction only)
- No ongoing interference with encoding
- At least passed sometimes

**Why still failed**:
- Only corrects start, no continuous adjustment
- Camera drift accumulates over session
- Unstable across runs

---

## Summary

**All sync filters failed to achieve stable |drift| < 100 ms/min**.

**Reverted to e4cbcc0 baseline** (no filters, −360 ms/min consistent).

**Next**: Field test baseline to see if iOS tolerates −360 in practice.

**If field test fails**: Implement video-only path (firmware bump, no audio codecs).

**No claim-done**: Awaiting Mini field test result on c0bd5e6.
