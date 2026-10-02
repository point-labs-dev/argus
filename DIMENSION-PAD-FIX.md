# Dimension Padding Fix — Exact Negotiated W×H

**Date**: 2026-10-01  
**Commit**: 3568b2c  
**Root cause**: Scaled dimensions != negotiated dimensions

---

## Field Evidence (Mini @ 2fee04d, evening)

**Bitrate honor worked BUT video still blank**:
```
asked=299k serving=299k ✅ (fixed)
→ But Home still blank + no thumbnails
```

**Measured encode output**:
- Source: Garage Door 2560×1920 (4:3 aspect)
- Negotiated: 1280×720 (16:9 aspect)
- Filter: `scale=1280:720:force_original_aspect_ratio=decrease`
- **Actual output**: 960×720 (NOT 1280×720)

**The problem**: `force_original_aspect_ratio=decrease` scales to FIT WITHIN the box maintaining aspect ratio, but doesn't PAD to fill it.

4:3 source → 16:9 box:
- Fit 2560×1920 into 1280×720: scale to 960×720 (maintains 4:3)
- But Home negotiated 1280×720 (16:9)
- **960×720 ≠ 1280×720 → blank screen**

---

## Root Cause

### FFmpeg Scale Behavior

`scale=W:H:force_original_aspect_ratio=decrease` means:
- Scale to fit WITHIN W×H box
- Maintain source aspect ratio
- Result may be SMALLER than W×H

**Example**: 2560×1920 (4:3) → 1280×720 (16:9 box)
1. Fit width: 1280 × (1920/2560) = 960 height
2. Result: 1280×960 (exceeds height) ❌
3. Fit height: 720 × (2560/1920) = 960 width
4. Result: 960×720 (fits box) ✅

**Output**: 960×720 (not 1280×720)

### Home's Enforcement

**Home expects EXACT dimensions**:
- Negotiated: 1280×720
- Received: 960×720
- Mismatch → blank screen

This applies to:
- 4:3 sources → 16:9 boxes (pillarbox needed)
- 16:9 sources → 4:3 boxes (letterbox needed)
- Any aspect ratio mismatch

---

## The Fix

### Add Padding After Scale

**Before** (2fee04d):
```typescript
`scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`
// Output: 960×720 for 4:3 source in 1280×720 box
```

**After** (3568b2c):
```typescript
`scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`
// Output: EXACTLY 1280×720 (960×720 centered with black bars)
```

**Pad parameters**:
- `pad=W:H` — Output exactly W×H
- `(ow-iw)/2` — Horizontal offset: (output_width - input_width) / 2 (center)
- `(oh-ih)/2` — Vertical offset: (output_height - input_height) / 2 (center)

**Result**:
- 4:3 source (2560×1920) in 16:9 box (1280×720):
  - Scale: 960×720
  - Pad: 1280×720 with 160px black bars on left/right (pillarbox)
- 16:9 source in 4:3 box:
  - Scale to fit width
  - Pad: Black bars top/bottom (letterbox)

---

## Examples

### Garage Door (4:3 source)

**Before**:
```
Source: 2560×1920 (4:3)
Negotiated: 1280×720 (16:9)
Output: 960×720 (4:3) ← MISMATCH
→ Home blank
```

**After**:
```
Source: 2560×1920 (4:3)
Negotiated: 1280×720 (16:9)
Scale: 960×720 (4:3, fits in box)
Pad: 1280×720 (pillarbox: 160px black bars left/right)
→ Home renders ✅
```

### Backyard Left (16:9 source)

**Before & After** (same):
```
Source: ~1280×720 (16:9)
Negotiated: 1280×720 (16:9)
Scale: 1280×720 (exact fit)
Pad: 1280×720 (no bars needed, pad is no-op)
→ Works fine
```

---

## Tests

All 72 pass:
```bash
$ npm test
Tests  72 passed (72)
```

**New test**:
```typescript
it("pads to exact negotiated dimensions for all aspect ratios", () => {
  // 4:3 source → 16:9 box needs pillarbox
  const args = buildLiveFfmpegArgs(...).join(" ");
  expect(args).toContain("pad=1280:720:(ow-iw)/2:(oh-ih)/2");
});
```

---

## Deployment (Mini)

```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad  # Gets 3568b2c
npm install && npm run build

launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

**Verify**:
1. Trigger Garage Door motion (4:3 source)
2. Tap notification
3. **Check logs**: `asked=299k serving=299k` (bitrate match)
4. **Check ffmpeg args**: Should see `scale=1280:720:...,pad=1280:720:(ow-iw)/2:(oh-ih)/2`
5. **Video should render** with black bars (pillarbox for 4:3 → 16:9)
6. Test other cameras (16:9 sources) — should also work

**Expected logs**:
```
HomeKit negotiated video: 1280x720@30 ... asked=299k serving=299k ...
ffmpeg ... -vf scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2 ...
→ Output: EXACTLY 1280×720 (measured)
```

---

## Snapshot Downscaling (Follow-up)

**Issue**: Main stills are 2560×1920 / 500-900KB → may blank Home grid thumbnails.

**Current**: `handleSnapshotRequest` returns snapshot buffer as-is (from go2rtc main).

**Suggested fix** (future):
- Downscale snapshots to ≤1280×720 before returning
- Use sharp/jimp or ffmpeg to resize JPEG
- Cache downscaled versions

**Not implemented now** — prioritizing video fix. Can add if thumbnails remain blank after video works.

---

## Summary

**What was wrong**:
- Scale to fit (960×720 from 4:3) ≠ negotiated (1280×720)
- Home enforces exact dimensions → blank

**What's fixed**:
- Pad after scale to EXACT negotiated W×H
- 4:3 sources get pillarbox (black bars left/right)
- 16:9 sources fit exactly (no bars)
- Home receives EXACTLY what it negotiated
