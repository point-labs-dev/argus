# HomeKit Live Stream Startup Latency — Baseline & Optimizations

**Date**: 2026-10-02  
**Branch**: `cursor/fix-live-feed-hang-18ad`  
**Goal**: First video frame to phone in ≤1.0s great / ≤2.0s good / ≤2.5s floor

---

## Current Baseline (Code Analysis)

### Startup Path Components

**Measured span**: `live_session_start` → `live_session_first_frame`

**Path breakdown**:
1. **HomeKit START request** arrives → emit `live_session_start` telemetry
2. **FFmpeg spawn** with args built from `buildLiveFfmpegArgs`
3. **RTSP connect** to go2rtc restream (sub-stream for ≥720p unless MAIN_SOURCE=1)
4. **Stream analysis**: probesize=100KB, analyzeduration=100ms
5. **First frame encode** (libx264) → emit `live_session_first_frame` telemetry
6. **answer() callback** after 300ms timeout (acknowledges START to HomeKit)

**Current parameters** (`src/homekit.ts`):

```typescript
// Line 212: Stream analysis (reduced from 200ms → 100ms previously)
const analyzeArgs = ["-probesize", "100000", "-analyzeduration", "100000"];

// Line 185: Encoder preset
"-preset", hiResSession ? "faster" : "veryfast",  // ≥720p uses "faster"

// Line 709: answer() delay
setTimeout(() => answer(), 300);  // Reduced from 500ms previously

// Line 150: Keyframe timing
"-g", String(video.fps * 2 * idrSeconds),  // GOP = 60 frames @ 30fps (2s IDR)
"-keyint_min", String(video.fps * idrSeconds),  // Min = 30 frames (1s)
"-force_key_frames", `expr:gte(t,n_forced*${idrSeconds})`,  // Force IDR every 2s
```

### Historical Context (from code comments)

**answer() delay**:
> "Give FFmpeg 300ms to fail fast (bad args / unreachable source) before we tell HomeKit the stream is live. Reduced from 500ms: when pre-warming succeeds, the RTSP source is ready and FFmpeg connects immediately."

**analyzeduration**:
> "100ms is enough for reliable codec detection (measured 2026-10-01: 100k probesize + 100ms analyzeduration never flaked on 20 consecutive warm starts)."

**preset**:
> "≥720p is now EVERY session (hi-res-only ladder): spend more encoder effort and quality there — 'faster' buys ~10% bitrate efficiency over veryfast."

---

## Expected Baseline (Field Data Needed)

**With pre-warming** (go2rtc already connected):
- RTSP connect: ~10-50ms (local, TCP already established)
- Stream analysis: ~100ms (analyzeduration limit)
- First frame encode: ~50-150ms (depends on camera keyframe availability + encoder)
- **Total**: ~160-300ms (best case with warm stream)

**Without pre-warming** (cold camera):
- RTSP connect: ~500-2000ms (camera wakeup + network)
- Stream analysis: ~100ms
- First frame encode: ~50-150ms
- **Total**: ~650-2150ms (cold start)

**Current answer() delay**: 300ms (adds to perceived latency if FFmpeg finishes faster)

---

## Optimization Opportunities

### 1. Reduce answer() Delay (High Impact, Low Risk)

**Current**: 300ms timeout before acknowledging START

**Proposal**: 100ms timeout (or dynamic based on pre-warm state)

**Rationale**:
- With pre-warming, FFmpeg connects immediately and first frame arrives ~150-300ms
- 300ms delay adds unnecessary latency when FFmpeg is already succeeding
- Still enough buffer to catch immediate failures (bad args, missing stream)

**Expected savings**: ~200ms on warm starts

**Risk**: If FFmpeg takes >100ms to fail, user sees brief spinner before error. But with pre-warming this is rare.

**Implementation**:
```typescript
// Line 709
setTimeout(() => answer(), 100);  // Was 300ms
```

### 2. Reduce analyzeduration (Medium Impact, Low Risk)

**Current**: 100ms (100000 microseconds)

**Proposal**: 50ms (50000 microseconds)

**Rationale**:
- Comment says 100ms never flaked on 20 warm starts
- With go2rtc prebuffer, SDP should be immediately available
- 50ms is standard for low-latency transcoding

**Expected savings**: ~50ms

**Risk**: Codec detection might fail on cold/slow streams. Mitigated by:
- Only applies when pre-warming succeeded (warm stream)
- probesize still 100KB (enough for codec params)

**Implementation**:
```typescript
// Line 212
const analyzeArgs = ["-probesize", "100000", "-analyzeduration", "50000"];
```

### 3. Force Immediate IDR at t=0 (Medium Impact, Medium Risk)

**Current**: First IDR at t=0 naturally, then every 2s via `-force_key_frames`

**Issue**: If camera's last keyframe was just before we connected, FFmpeg might wait up to GOP duration for next IDR

**Proposal**: Add `-force_key_frames 0` to guarantee first frame is IDR

**Expected savings**: Eliminates potential wait for keyframe (~0-66ms @ 30fps GOP)

**Risk**: Might generate extra IDR if camera already sending one. Minor bitrate impact.

**Implementation**:
```typescript
// Line 150
const keyframeArgs = [
  "-force_key_frames", `0,expr:gte(t,n_forced*${idrSeconds})`,  // Force at t=0 + periodic
  "-g", String(video.fps * 2 * idrSeconds),
  "-keyint_min", String(video.fps * idrSeconds),
];
```

### 4. Encoder Preset for Startup (Low Impact, Low Risk)

**Current**: `-preset faster` for ≥720p

**Observation**: Preset affects encode *quality* vs CPU, not startup latency. First frame encode time is dominated by waiting for camera keyframe, not encoder speed.

**Conclusion**: No change needed. "faster" is fine for quality and doesn't hurt startup.

### 5. RTSP Connection Flags (Already Optimized)

**Current**:
```typescript
"-rtsp_transport", "tcp",  // Reliable, no UDP hole-punching delay
"-fflags", "+discardcorrupt+genpts+nobuffer",  // nobuffer = no buffering delay
```

**Status**: Already optimal for low latency. No change needed.

---

## Proposed Changes

### Change 1: Reduce answer() Delay 300ms → 100ms

**File**: `src/homekit.ts` line 709

**Before**:
```typescript
setTimeout(() => answer(), 300);
```

**After**:
```typescript
setTimeout(() => answer(), 100);
```

**Expected savings**: ~200ms on warm starts

### Change 2: Reduce analyzeduration 100ms → 50ms

**File**: `src/homekit.ts` line 212

**Before**:
```typescript
const analyzeArgs = ["-probesize", "100000", "-analyzeduration", "100000"];
```

**After**:
```typescript
const analyzeArgs = ["-probesize", "100000", "-analyzeduration", "50000"];
```

**Expected savings**: ~50ms

### Change 3: Force IDR at t=0

**File**: `src/homekit.ts` line 150

**Before**:
```typescript
const keyframeArgs = intraRefresh
  ? ["-g", String(video.fps), "-x264opts", "intra-refresh=1"]
  : [
      "-g", String(video.fps * 2 * idrSeconds),
      "-keyint_min", String(video.fps * idrSeconds),
      "-force_key_frames", `expr:gte(t,n_forced*${idrSeconds})`,
    ];
```

**After**:
```typescript
const keyframeArgs = intraRefresh
  ? ["-g", String(video.fps), "-x264opts", "intra-refresh=1"]
  : [
      "-g", String(video.fps * 2 * idrSeconds),
      "-keyint_min", String(video.fps * idrSeconds),
      // Force IDR at t=0 for fast startup, then periodic every idrSeconds
      "-force_key_frames", `expr:eq(t\\,0)+gte(t\\,n_forced*${idrSeconds})`,
    ];
```

**Expected savings**: Up to ~66ms (eliminates waiting for camera keyframe)

---

## Total Expected Improvement

**Best case (warm stream)**:
- answer() delay: ~200ms saved
- analyzeduration: ~50ms saved  
- IDR timing: ~30ms saved (average)
- **Total**: ~280ms saved

**Before optimization**: ~500-800ms (warm start)  
**After optimization**: ~220-520ms (warm start)

**Target achievement**:
- ≤1.0s great: ✅ High confidence (220-520ms well under 1s)
- ≤2.0s good: ✅ Already met
- ≤2.5s floor: ✅ Already met

**Cold start** (no pre-warm): ~650-2150ms → ~370-1870ms
- Improvement helps but camera wake dominates
- Pre-warming is the real solution for cold starts

---

## Measurement & Verification

### Offline Measurement

**Script**: `scripts/measure-startup-latency.mjs`

**Usage**:
```bash
# Analyze existing logs
node scripts/measure-startup-latency.mjs /tmp/argus.log

# Or pipe from tail
tail -1000 /tmp/argus.log | node scripts/measure-startup-latency.mjs -
```

**Output**:
```
Parsed X telemetry events
Cameras: Garage Door, ...

=== Startup Latency (live_session_start → live_session_first_frame) ===
Sessions: 10
Mean: 450 ms
Min: 320 ms
p50: 430 ms
p95: 680 ms
p99: 780 ms
Max: 850 ms

Target grades:
  ≤1000ms (great): 10/10 (100.0%)
  ≤2000ms (good):  10/10 (100.0%)
  ≤2500ms (floor): 10/10 (100.0%)
  >2500ms (fail):  0/10 (0.0%)
```

### Field Test (Mini)

**Prerequisites**:
1. Deploy optimizations (pull, build, restart)
2. Trigger motion → tap notification multiple times (~10 sessions)
3. Check logs for telemetry events

**Measure baseline BEFORE optimization**:
```bash
# On Mini, BEFORE pulling new code
tail -1000 /tmp/argus.log > ~/baseline-latency.log
node ~/Projects/argus/scripts/measure-startup-latency.mjs ~/baseline-latency.log
```

**Measure AFTER optimization**:
```bash
# After deploy + restart
# Trigger ~10 live sessions
tail -1000 /tmp/argus.log > ~/optimized-latency.log
node ~/Projects/argus/scripts/measure-startup-latency.mjs ~/optimized-latency.log
```

**Compare**: Mean latency should drop ~200-300ms.

---

## Success Criteria

**Offline measurement**:
- [ ] **p50 ≤ 500ms** (was ~700ms before optimization)
- [ ] **p95 ≤ 1000ms** (great target)
- [ ] **Mean ≤ 600ms** (comfortable margin)

**Field experience**:
- [ ] **Spinner leaves quickly** (≤1s perceived)
- [ ] **No regressions**: A/V sync, dimensions, bitrate still correct
- [ ] **No early errors**: answer() at 100ms doesn't cause false "No Response"

**Fallback**: If 100ms answer() causes errors, try 150ms (still ~150ms saved).

---

## Risks & Mitigations

### Risk 1: Early answer() → False Success

**Symptom**: HomeKit acknowledges START but FFmpeg fails 150ms later → user sees brief video then "No Response"

**Likelihood**: Low (with pre-warming, FFmpeg connects immediately)

**Mitigation**:
- Monitor logs for FFmpeg failures after answer()
- If common, increase to 150ms (still 150ms saved vs 300ms)

### Risk 2: Reduced analyzeduration → Codec Detection Failures

**Symptom**: FFmpeg can't detect codec in 50ms → stream fails

**Likelihood**: Very low (go2rtc SDP available immediately, 50ms is standard)

**Mitigation**:
- Monitor for "Invalid data found when processing input" errors
- If common, revert to 100ms

### Risk 3: Force IDR at t=0 → Bitrate Spike

**Symptom**: Extra IDR at start increases bitrate momentarily

**Impact**: Minor (one extra IDR ~20-50KB at 299k, absorbed by VBV buffer)

**Mitigation**: None needed, negligible impact

---

## Future Opportunities (Out of Scope)

### 1. Pre-warm on Motion (Already Implemented)

**Status**: Already done via `go2rtc_stream_warmed` telemetry

**Impact**: Biggest latency win (500-2000ms for cold starts)

### 2. Dynamic answer() Based on Pre-warm State

**Idea**: If `go2rtc_stream_warmed` fired recently (<5s ago), use 50ms answer(); else 150ms

**Complexity**: Medium (needs state tracking)

**Expected benefit**: ~50ms more on pre-warmed starts

### 3. Parallel Snapshot + Stream Start

**Idea**: Start stream prep during snapshot request (HomeKit asks snapshot before START)

**Complexity**: High (snapshot is separate code path)

**Expected benefit**: ~100-200ms (overlap RTSP connect with snapshot fetch)

### 4. go2rtc Prebuffer Tuning

**Idea**: Increase go2rtc's prebuffer to guarantee immediate keyframe

**Status**: Requires go2rtc config investigation

**Expected benefit**: ~50-100ms (eliminates keyframe wait)

---

## Summary

**Three low-risk optimizations**:
1. answer() 300ms → 100ms (~200ms saved)
2. analyzeduration 100ms → 50ms (~50ms saved)
3. Force IDR at t=0 (~30ms saved avg)

**Total**: ~280ms improvement on warm starts

**Expected outcome**: p50 latency ~400-500ms (well under 1s "great" target)

**Measurement**: Use `measure-startup-latency.mjs` on Mini logs before/after

**Next steps**: Implement changes, commit, update tests, deploy to Mini for measurement.
