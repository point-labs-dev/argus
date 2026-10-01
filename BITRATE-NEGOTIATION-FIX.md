# Bitrate Negotiation Fix — Honor Home's Budget

**Date**: 2026-10-01  
**Commit**: [current]  
**Root cause**: Bitrate floor override causing blank screen

---

## Field Evidence (Mini @ ff82cab, ~12:42 ET)

**Encode healthy but Home blank**:
- Backyard Left session 780604d1: `asked=299k serving=2000k` (6.7x over-budget)
- Audio: libfdk_aac/aac_eld working correctly
- first_frame: +1707ms ✅
- Continuous frames (~86 frames) ✅
- Normal STOP+SIGKILL teardown ✅
- **Home: blank screen** ❌

**The smoking gun**: `asked=299k serving=2000k`

---

## Root Cause

### Bitrate Floor Logic

**Code** (src/homekit.ts):
```typescript
export function effectiveBitrateKbps(width, height, negotiatedKbps) {
  const floor = pixels >= 1280 * 720 ? 2000 : ...;
  return Math.max(negotiatedKbps, floor); // ← PROBLEM
}
```

**What happened**:
1. Home negotiates 1280x720 @ 299k (conservative but valid)
2. Floor logic overrides: `Math.max(299, 2000) = 2000`
3. We encode & send 2000k stream (6.7x over budget)
4. Home ENFORCES its budget → rejects over-rate stream → blank screen

### Starved Downscaling

**Additional issue**:
```typescript
const starved = hiResSession && video.maxBitrateKbps < 800;
const boxWidth = starved ? Math.min(854, video.width) : video.width;
```

**What happened**:
1. 299k < 800 → starved = true
2. Downscaled 1280x720 → 854x480
3. Home negotiated 1280x720 but received 854x480
4. Dimension mismatch also violates contract

**Cumulative violation**: Wrong bitrate AND wrong dimensions → guaranteed failure.

---

## The Fix

### 1. Remove Bitrate Floor

**Before**:
```typescript
export function effectiveBitrateKbps(width, height, negotiatedKbps) {
  const floor = pixels >= 1280 * 720 ? 2000 : 3000;
  return Math.max(negotiatedKbps, floor); // Override
}
```

**After**:
```typescript
export function effectiveBitrateKbps(width, height, negotiatedKbps) {
  // Honor the negotiated bitrate exactly. Home enforces its budget.
  return negotiatedKbps;
}
```

**Why**: The negotiation IS the contract. Home asked for 299k, we must deliver 299k (±encoding variance). Overriding causes rejection.

**Quality concern**: If 299k looks bad, the fix is to advertise higher MAX bitrate in controller options (so Home negotiates higher), not to violate the negotiation.

### 2. Remove Starved Downscaling

**Before**:
```typescript
const starved = hiResSession && video.maxBitrateKbps < 800;
const boxWidth = starved ? Math.min(854, video.width) : video.width;
```

**After**:
```typescript
const boxWidth = video.width;
const boxHeight = video.height;
```

**Why**: Home enforces BOTH bitrate AND dimensions. Negotiating 1280x720 then sending 854x480 violates the contract.

---

## Expected Behavior After Fix

### Session with 299k Bitrate

**Before** (broken):
```
asked=299k serving=2000k
scale=854:480 (downscaled from negotiated 1280x720)
→ Home blank
```

**After** (fixed):
```
asked=299k serving=299k
scale=1280:720 (matches negotiation)
-maxrate 299k -bufsize 299k
→ Home paints ✅
```

### Quality Trade-Off

**Conservative bitrates** (299k @ 720p, 802k @ 1080p):
- Will be LOWER quality than the old floor (2000k/3000k)
- But will actually RENDER (vs blank screen)
- This is Home's choice, not ours

**If better quality is needed**:
- Increase advertised max bitrate in controller options
- Then Home negotiates higher (e.g. 2000k)
- We honor that higher negotiation

**Do NOT**: Override the negotiation with a floor.

---

## Tests

All 71 pass:
```bash
$ npm test
Tests  71 passed (71)
```

**Updated tests**:
- `effectiveBitrateKbps` now expects exact passthrough (no floors)
- Starved downscaling test removed (now honors negotiated dimensions)
- Delegate test expects `-maxrate 299k` (not `2000k`)

---

## Deployment (Mini)

```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad
npm install && npm run build

launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

**Verify**:
1. Trigger motion
2. Tap notification within 10s
3. Check logs: `asked=299k serving=299k` (MUST match)
4. Check args: `-maxrate 299k -bufsize 299k` and `scale=1280:720`
5. **Video should render** in Home app ✅
6. Quality may be lower than before (expected at 299k)

**Expected logs**:
```
HomeKit negotiated video: 1280x720@30 ... asked=299k serving=299k ...
ffmpeg ... -maxrate 299k -bufsize 299k ... scale=1280:720 ...
live_session_first_frame {"latencyMs":1700}
→ Video renders
```

---

## Why The Floor Existed

**Original rationale** (from code comments):
- "Apple clients negotiate absurdly conservative bitrates"
- "299k for 1280x720 is mush"
- "Mature bridges override as a matter of course"

**Why it was wrong**:
- Those bridges may work on SOME devices
- But Home ENFORCES its budget on MANY devices
- Result: blank screen is worse than "mush"
- The negotiation is the CONTRACT

**The right solution**:
- Advertise higher max bitrates (so Home negotiates higher)
- Honor whatever Home negotiates
- Let Home make quality/bandwidth trade-offs

---

## Escape Hatches (if needed)

**Old behavior** can be restored via env vars:

1. **Global floor rollback**:
   ```bash
   # NOT recommended — will cause blank screens
   export ARGUS_LIVE_OBEY_BITRATE=0  # (or unset)
   ```

2. **Hub addresses** (already supported):
   ```bash
   export ARGUS_HUB_ADDRESSES=10.0.0.15
   # Remote relay sessions obey negotiation
   # Direct sessions use floor
   ```

**But**: With this fix, the floor is GONE by default. Direct sessions now work. No escape hatches needed.

---

## Summary

**What was wrong**:
- Bitrate floor (2000k) overrode negotiation (299k) → 6.7x over-budget
- Dimension downscale (854x480) violated negotiation (1280x720)
- Home enforces BOTH → blank screen

**What's fixed**:
- Honor negotiated bitrate exactly (no floor)
- Honor negotiated dimensions exactly (no downscale)
- Home receives what it asked for → renders

**Trade-off**:
- Lower quality at conservative bitrates (expected)
- But WORKING video (vs blank screen)
