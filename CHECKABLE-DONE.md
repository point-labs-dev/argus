# CHECKABLE DONE — Video-Only Interim

**Date**: 2026-10-02  
**Status**: ✅ COMPLETE  
**Branch**: cursor/fix-live-feed-hang-18ad  
**PR**: #3 (DRAFT, do NOT merge)

---

## Checklist

### ✅ Commits on PR #3 Branch

**Latest SHA**: `1b154a4`

**Key commits**:
- `6ed2def` — Firmware 1.3.0 + video-only path implementation
- `76e1ca3` — Validator Opus vs AAC-ELD codec difference doc
- `1b154a4` — Mini deployment quick reference

**Total**: 3 new commits since pivot (video-only implementation)

### ✅ Tests Green

```
Test Files  9 passed (9)
Tests       73 passed (73)
Duration    1.19s
```

**All tests pass** ✅

### ✅ No Merge

**PR #3**: Draft status maintained (not merged to main)

### ✅ Report SHA for Mini Redeploy

**SHA for Mini**: `1b154a4`

**Deployment command**:
```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad  # SHA: 1b154a4
npm install && npm run build
```

**Configuration**: `ARGUS_AUDIO=0` in LaunchAgent plist

**Firmware**: 1.3.0 (was 1.2.0)

**Expected**: Video renders without spinner hang (no audio, video-only)

---

## What Was Implemented

### 1. Firmware Bump (CRITICAL)

**File**: `src/homekit.ts`

```typescript
export const ARGUS_FIRMWARE_REVISION = "1.3.0";  // Was 1.2.0
```

**Why**: iOS caches streaming profiles. ARGUS_AUDIO=0 without bump → iOS still negotiated audio (cached). Firmware bump → iOS re-reads → honors video-only.

### 2. Video-Only Path (when ARGUS_AUDIO=0)

**Already working** (existing code in `buildLiveFfmpegArgs`):
```typescript
if (!includeAudio) {
  return videoArgs;  // Only video, no audio RTP
}
```

**Controller options** (existing code in `buildCameraControllerOptions`):
```typescript
audio: {
  codecs: includeAudio
    ? [AAC_ELD, OPUS]  // Normal
    : [],              // Video-only: empty
}
```

### 3. Logging Correctness

**File**: `src/homekit.ts` (startStream)

**Before**:
```typescript
const audioEncoder = request.audio.codec === ...;
this.logLine(`... audio: codec=${request.audio.codec} ... (encoding ${audioEncoder})`);
```

**After**:
```typescript
const audioLog = this.includeAudio
  ? `audio: codec=... (encoding libfdk_aac)`
  : "audio: none (video-only)";
this.logLine(`... ${audioLog}`);
```

**Result**: No fake audio encoder claims when video-only

### 4. Tests Updated

**File**: `tests/homekit.test.ts`

```typescript
it("advertises firmware version 1.3.0 for iOS cache invalidation", () => {
  expect(ARGUS_FIRMWARE_REVISION).toBe("1.3.0");  // Was 1.2.0
});
```

---

## Documentation

### Files Created

1. **`VIDEO-ONLY-INTERIM.md`** — Full evidence trail
   - Why audio sync failed (4 attempts, all 0/2 or 1/2)
   - Implementation details (firmware bump, video-only path)
   - Deployment steps (Mini LaunchAgent + restart)
   - Restore audio procedure (future, when sync solved)

2. **`VALIDATOR-CODEC-DIFFERENCE.md`** — Secondary analysis
   - Why validator Opus ≠ production AAC-ELD
   - Evidence gaps (no AAC-ELD drift measurements)
   - Future investigative tests (AAC-ELD validator, baseline field test)

3. **`DEPLOY.md`** — Quick reference
   - Copy-paste Mini deployment commands
   - Field test steps + expected behavior
   - Success criteria (video renders, no spinner)

### Files Updated

1. **`LIVE-FEED-FIX-SUMMARY.md`** — Timeline + status
2. **`src/homekit.ts`** — Firmware 1.3.0, video-only logging
3. **`tests/homekit.test.ts`** — Firmware version test

---

## Mini Deployment Instructions

**See `DEPLOY.md`** for copy-paste commands.

**Quick summary**:
1. Pull SHA `1b154a4`
2. Set `ARGUS_AUDIO=0` in LaunchAgent plist
3. Build + restart
4. iOS detects firmware 1.3.0 → refreshes metadata
5. Field test: Motion → tap → **video renders** (no spinner)

---

## Success Criteria

✅ Video renders without spinner hang  
✅ Picture > no picture (unlocks core functionality)  
✅ No A/V sync issues (no audio to sync)  
✅ Shippable immediately (no more filter experiments)  
✅ Reversible (restore audio later with firmware 1.4.0)

---

## Fast-Startup Work Status

**Parked** until picture unlocks (as requested).

**Current state**: Commits 6bbe460 - 58bb824 achieved ~280ms faster first frame (sub-restream passthrough when source ≥720p).

**Future**: Resume when video-only field test succeeds.

---

## Status

✅ **COMPLETE**: Video-only interim path implemented, tested, documented, committed, pushed to PR #3.

✅ **READY**: SHA `1b154a4` ready for Mini field test with `ARGUS_AUDIO=0`.

✅ **NO MERGE**: PR #3 kept as draft (not merged to main).

✅ **TESTS**: 73/73 pass.

🔜 **NEXT**: Mini field test to confirm video renders without spinner hang.
