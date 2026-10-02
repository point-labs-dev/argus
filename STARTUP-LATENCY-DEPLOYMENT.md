# Startup Latency Optimization — Field Deployment

**Date**: 2026-10-02  
**Branch**: `cursor/fix-live-feed-hang-18ad`  
**Expected improvement**: ~280ms reduction in time-to-first-frame

---

## Changes Made

### 1. Reduce answer() Delay: 300ms → 100ms

**File**: `src/homekit.ts` line ~709

**Impact**: ~200ms saved on warm starts

**Rationale**: With pre-warming, go2rtc's RTSP producer is already connected and FFmpeg succeeds immediately. First frame typically arrives 150-300ms after spawn. Acknowledging at 100ms (vs 300ms) cuts perceived latency while still catching immediate failures.

**Risk**: Low. If FFmpeg fails >100ms after spawn, user sees brief spinner before error. But with pre-warming this is rare.

### 2. Reduce RTSP Analysis: 100ms → 50ms

**File**: `src/homekit.ts` line ~212

**Change**: `-analyzeduration 100000` → `-analyzeduration 50000` (100ms → 50ms)

**Impact**: ~50ms saved

**Rationale**: With go2rtc prebuffer, SDP is immediately available and codec params are in the first few packets. 50ms is standard for low-latency transcoding. Still fails fast on cold/missing streams.

**Risk**: Very low. 50ms is plenty for codec detection when stream is warm.

### 3. Force IDR at t=0

**File**: `src/homekit.ts` line ~153

**Change**: `-force_key_frames expr:gte(t,n_forced*2)` → `-force_key_frames expr:eq(t\\,0)+gte(t\\,n_forced*2)`

**Impact**: ~30ms saved (average, eliminates waiting for camera keyframe)

**Rationale**: Guarantees first encoded frame is an IDR. Without this, FFmpeg might wait up to one GOP duration (~33-66ms @ 30fps) for the camera's next keyframe.

**Risk**: Very low. Might generate an extra IDR if camera already sending one at t=0. Minor bitrate impact (~20KB), absorbed by VBV buffer.

---

## Expected Outcome

**Before optimization** (warm start):
- Typical latency: ~500-800ms (live_session_start → live_session_first_frame)
- answer() delay: 300ms
- analyzeduration: 100ms

**After optimization** (warm start):
- **Expected latency: ~220-520ms** (~280ms improvement)
- answer() delay: 100ms (−200ms)
- analyzeduration: 50ms (−50ms)
- IDR at t=0 (−30ms avg)

**Target achievement**:
- ≤1000ms (great): ✅ High confidence
- ≤2000ms (good): ✅ Already met
- ≤2500ms (floor): ✅ Already met

**Cold start** (no pre-warm):
- Before: ~650-2150ms
- After: ~370-1870ms
- Improvement helps but camera wake dominates (pre-warming is the real solution)

---

## Deployment (Mini)

### 1. Measure Baseline FIRST

**Before pulling new code**, capture current latency:

```bash
# On Mini
tail -1000 /tmp/argus.log > ~/latency-baseline-before.log
node ~/Projects/argus/scripts/measure-startup-latency.mjs ~/latency-baseline-before.log
```

**Trigger 5-10 live sessions** (motion → tap notification) to get baseline data.

**Expected baseline**: p50 ~600-800ms, p95 ~1000-1500ms (estimate, needs measurement)

### 2. Pull & Build

```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad
npm install && npm run build
```

**Expected commit**: Includes startup optimizations (check `git log -1` for "startup latency")

### 3. Restart Argus

```bash
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

### 4. Trigger Test Sessions

**Trigger 5-10 live sessions** (same as baseline):
- Motion detected → tap iOS notification
- Let video play ~5-10 seconds each
- Repeat for multiple cameras if available

**Why 5-10**: Need enough samples for statistical confidence (p50/p95)

### 5. Measure After Optimization

```bash
# After test sessions
tail -1000 /tmp/argus.log > ~/latency-after-optimization.log
node ~/Projects/argus/scripts/measure-startup-latency.mjs ~/latency-after-optimization.log
```

**Expected improvement**:
- p50: −200-300ms (e.g., 700ms → 400ms)
- p95: −200-300ms (e.g., 1200ms → 900ms)
- Mean: −200-300ms

### 6. Verify No Regressions

**Check logs** for:
- ✅ **First frame telemetry**: `live_session_first_frame` events present (FFmpeg succeeds)
- ✅ **No early errors**: No FFmpeg failures <200ms after spawn (answer() at 100ms is safe)
- ✅ **A/V sync still healthy**: Re-run validate-av-sync (should still be |drift| < 100 ms/min)
- ✅ **Video renders**: Spinner leaves quickly, video plays continuously

**Red flags** (if seen, report):
- FFmpeg errors <150ms after spawn → answer() too early (fallback: increase to 150ms)
- "Invalid data" codec errors → analyzeduration too short (fallback: increase to 75ms)
- Video stutters/freezes → bitrate issue (unlikely, unrelated to these changes)

---

## Measurement Script

**Tool**: `scripts/measure-startup-latency.mjs`

**Usage**:
```bash
# Analyze log file
node scripts/measure-startup-latency.mjs /tmp/argus.log

# Or pipe from tail
tail -1000 /tmp/argus.log | node scripts/measure-startup-latency.mjs -
```

**Sample output**:
```
Parsed 87 telemetry events
Cameras: Garage Door, Front Door

=== Startup Latency (live_session_start → live_session_first_frame) ===
Sessions: 8
Mean: 420 ms
Min: 310 ms
p50: 410 ms
p95: 580 ms
p99: 640 ms
Max: 680 ms

Target grades:
  ≤1000ms (great): 8/8 (100.0%)
  ≤2000ms (good):  8/8 (100.0%)
  ≤2500ms (floor): 8/8 (100.0%)
  >2500ms (fail):  0/8 (0.0%)

=== Per-Camera Breakdown ===

Garage Door:
  Sessions: 5
  Mean: 390 ms
  Min: 310 ms
  Max: 480 ms

Front Door:
  Sessions: 3
  Mean: 480 ms
  Min: 420 ms
  Max: 680 ms

=== Recent Sessions (last 10) ===
Garage Door          310ms  ✅ GREAT  2026-10-02T00:45:12.345Z
Garage Door          380ms  ✅ GREAT  2026-10-02T00:46:23.456Z
Front Door           420ms  ✅ GREAT  2026-10-02T00:47:34.567Z
...
```

**Interpretation**:
- **✅ GREAT** (≤1000ms): Target achieved
- **✓ GOOD** (≤2000ms): Acceptable
- **~ FLOOR** (≤2500ms): Just meeting bar
- **❌ FAIL** (>2500ms): Below expectations (investigate)

---

## Success Criteria

### Offline Measurement

- [ ] **p50 ≤ 500ms** (improved from ~700ms baseline)
- [ ] **p95 ≤ 1000ms** (great target met)
- [ ] **Mean ≤ 600ms** (comfortable margin under 1s "great")
- [ ] **All sessions ≤ 2500ms** (no fails)

### Field Experience

- [ ] **Spinner leaves quickly** (perceived ≤1s)
- [ ] **Video renders immediately** after spinner
- [ ] **No early errors** (FFmpeg doesn't fail <200ms after spawn)
- [ ] **A/V sync still healthy** (|drift| < 100 ms/min on validate-av-sync)

### Regression Checks

- [ ] **First frame events present** in logs (FFmpeg succeeds)
- [ ] **No "Invalid data" codec errors** (analyzeduration sufficient)
- [ ] **Dimensions still exact** (padding still works)
- [ ] **Bitrate still honored** (no overshoot)

---

## Rollback Plan

**If regressions detected**, revert individual changes:

### Rollback #1: answer() delay 100ms → 150ms

**Symptom**: FFmpeg errors <150ms after spawn, user sees "No Response"

**Fix**:
```typescript
// Line ~709
setTimeout(() => answer(), 150);  // Was 100ms, compromise between 300ms and 100ms
```

**Impact**: Still saves ~150ms vs baseline 300ms

### Rollback #2: analyzeduration 50ms → 75ms or 100ms

**Symptom**: "Invalid data found when processing input" errors

**Fix**:
```typescript
// Line ~212
const analyzeArgs = ["-probesize", "100000", "-analyzeduration", "75000"];  // Was 50ms
```

**Impact**: Still saves ~25ms vs baseline 100ms

### Rollback #3: Remove IDR at t=0

**Symptom**: Bitrate spikes at start (unlikely)

**Fix**:
```typescript
// Line ~153
"-force_key_frames", `expr:gte(t\\,n_forced*${idrSeconds})`,  // Remove eq(t,0)
```

**Impact**: Lose ~30ms improvement, but still have answer() + analyzeduration wins

---

## Next Steps After Verification

**If optimizations succeed**:
1. ✅ Keep changes (already on PR branch)
2. ✅ Document results (update this file with actual measurements)
3. Consider: Further optimization (dynamic answer() based on pre-warm state)

**If regressions found**:
1. Apply rollback (see above)
2. Commit rollback to PR branch
3. Report findings (which change caused regression)

---

## How to Re-run A/V Sync Validation

**After deploying startup optimizations**, verify A/V drift still healthy:

```bash
cd ~/Projects/argus
node scripts/validate-av-sync.mjs garage-door-sub --size 1280x720 --bitrate 299 --seconds 40
```

**Expected** (unchanged from A/V sync fix):
```
VERDICT: skew Xms -> Yms; drift Z ms/min
A/V clocks track — stream-side sync looks healthy.
```

**Acceptance**: `|drift| < 100 ms/min` (was 42 ms/min after A/V sync fix)

**These startup optimizations do NOT affect A/V sync** (no changes to audio/video encoding, only startup parameters). But good to verify no unexpected interactions.

---

## Summary

**Three low-risk optimizations**:
1. answer() 300ms → 100ms (−200ms)
2. analyzeduration 100ms → 50ms (−50ms)
3. Force IDR at t=0 (−30ms avg)

**Total expected**: ~280ms improvement on warm starts

**Measurement**: Use measure-startup-latency.mjs on Mini logs before/after

**Success**: p50 ≤ 500ms, p95 ≤ 1000ms, all ≤ 2500ms

**Rollback**: Increase answer() to 150ms and/or analyzeduration to 75ms if issues arise

**A/V sync**: Should remain healthy (|drift| < 100 ms/min)

**Ready for Mini deployment and measurement.**
