# In-Band SPS/PPS Fix for HomeKit Video Unlock

**Commit**: f22f0eb  
**Branch**: cursor/fix-live-feed-hang-18ad  
**Status**: Offline verified, needs Mini field test  
**Date**: 2026-10-02

---

## Problem

Even with video-only + pad + bitrate honor + fast encode, Apple Home showed endless spinner.

**Field evidence** (Mini on 72a041a + ARGUS_AUDIO=0, ~21:38 ET Oct 1 2026):
- ✅ Negotiated: `audio: none (video-only)`, 1280×720@30, asked=299k serving=299k
- ✅ Fast encode: `live_session_first_frame` ~0.7s, ~30fps
- ✅ Correct source: `garage-door-sub`, pad filter active
- ✅ Video-only path: `-an`, no audio RTP
- ❌ Home UI: Spinner never unlocked → STOP/SIGKILL ~10-12s
- ❌ Two sessions same pattern

**Conclusion**: Audio SDP cache hypothesis **falsified**. Encode is healthy. Problem is **video bitstream / codec profile unlock path**.

---

## Hypothesis

HomeKit may refuse to unlock video when H.264 parameter sets (SPS/PPS) are only in out-of-band extradata:

1. **Dropped initial packets**: If SPS/PPS are only sent at stream start, network drops during socket ramp → device can't decode any frames
2. **Strict in-band requirement**: Some Apple devices may require in-band SPS/PPS on every IDR for decode to proceed
3. **Profile compatibility**: High profile without in-band params may be more sensitive than Baseline with in-band

---

## Solution

Add `-bsf:v dump_extra=freq=keyframe` to inject SPS/PPS before every keyframe.

### Code Change (src/homekit.ts)

```typescript
const videoCodecArgs =
  videoMode === "copy"
    ? ["-c:v", "copy"]
    : [
        "-c:v", "libx264",
        // ... existing encoder params ...
        "-bufsize", `${video.maxBitrateKbps}k`,
        // NEW: Inject SPS/PPS before every keyframe (in-band parameter sets)
        "-bsf:v", "dump_extra=freq=keyframe",
      ];
```

### What This Does

**Before** (72a041a):
- SPS/PPS only in initial extradata (out-of-band, sent once at stream start)
- Keyframes at t=0 and periodic (every 2s for ≥720p)
- If initial packets drop → no parameter sets → decoder can't start

**After** (f22f0eb):
- SPS/PPS injected **before every keyframe** (in-band, repeated per IDR)
- Keyframes still at t=0 and periodic
- If initial packets drop → next keyframe has params → decoder can recover
- Satisfies strict in-band requirements if device enforces them

### FFmpeg Argument Example

```bash
ffmpeg ... \
  -c:v libx264 \
  -profile:v high -level 4.0 \
  -force_key_frames expr:eq(t,0)+gte(t,n_forced*2) \
  -maxrate 299k -bufsize 299k \
  -bsf:v dump_extra=freq=keyframe \  # ← NEW
  -f rtp srtp://...
```

---

## Offline Verification

### Test 1: Video + Audio Mode

```bash
node /tmp/test_dump_extra.mjs
```

**Result**:
```
✅ -bsf:v dump_extra=freq=keyframe present
✅ -force_key_frames expr:eq(t,0)+gte(t,n_forced*2) present
✅ -profile:v high (honors negotiated)
✅ scale=1280:720:...,pad=1280:720:... present
✅ -maxrate 299k -bufsize 299k
```

### Test 2: Video-Only Mode (ARGUS_AUDIO=0)

```bash
node /tmp/test_dump_extra.mjs
```

**Result**:
```
✅ -bsf:v dump_extra=freq=keyframe present
✅ -an (no audio args, video-only)
✅ Same video params as audio mode
✅ Pad + bitrate honored
```

### Test 3: Unit Tests

```bash
npm test -- homekit.test.ts
```

**Result**: `24/24 tests pass ✅`

**New test**:
```typescript
it("injects in-band SPS/PPS on every keyframe for reliable HomeKit unlock", () => {
  const args = buildLiveFfmpegArgs(liveInput()).join(" ");
  expect(args).toContain("-bsf:v dump_extra=freq=keyframe");
});
```

---

## Preserved Fixes (All Still Working)

✅ **In-band SPS/PPS**: `dump_extra=freq=keyframe` on every keyframe  
✅ **Early IDR**: `force_key_frames expr:eq(t,0)+...` (unescaped, t=0 fires)  
✅ **Pad filter**: `scale=...:decrease:force_divisible_by=2,pad=...` (exact dims)  
✅ **Bitrate honor**: Use negotiated bitrate directly (no starved downscaling)  
✅ **Video-only**: When `ARGUS_AUDIO=0`, empty codecs + `-an` (no audio RTP)  
✅ **Profile honor**: Still uses negotiated Baseline/Main/High (not forcing Baseline)  
✅ **Firmware 1.3.0**: No bump needed (HAP advertisement unchanged)

---

## Mini Deployment (Field Test)

### Current State

**SHA on Mini**: 72a041a (video-only baseline, no in-band SPS/PPS)  
**Next SHA to test**: f22f0eb (adds in-band parameter sets)  
**Configuration**: ARGUS_AUDIO=0 in LaunchAgent plist  
**Firmware**: 1.3.0 (no bump needed for this change)

### Redeploy Steps

```bash
# 1. Fetch and checkout latest branch tip
cd ~/Projects/argus
git fetch origin cursor/fix-live-feed-hang-18ad
git checkout cursor/fix-live-feed-hang-18ad
git pull
# Should land on f22f0eb

# 2. Verify commit
git log --oneline -1
# f22f0eb Add in-band SPS/PPS on every keyframe for HomeKit video unlock

# 3. Build
npm run build

# 4. Restart service
launchctl unload ~/Library/LaunchAgents/com.example.argus.plist
launchctl load ~/Library/LaunchAgents/com.example.argus.plist

# 5. Verify boot
tail -100 /tmp/argus.log
# Should see:
# - ARGUS_AUDIO=0 (video-only mode active)
# - ARGUS_FIRMWARE_REVISION=1.3.0
# - go2rtc ready
# - All 3 cameras pre-warmed
```

### Field Test Procedure

**Trigger**: Tap Garage Door motion notification in Home app

**Expected** (if fix works):
1. ✅ Spinner appears (brief, <2s)
2. ✅ **Spinner leaves** (video unlocks)
3. ✅ **Live picture renders** (1280×720)
4. ✅ No audio (expected with ARGUS_AUDIO=0)
5. ✅ No endless spinner hang

**If spinner still hangs** (needs more investigation):
1. Capture `/tmp/argus.log` from session start to STOP
2. Look for:
   - Negotiated profile/level (should be baseline/main/high + 3.1/3.2/4.0)
   - FFmpeg argv includes `-bsf:v dump_extra=freq=keyframe`
   - `live_session_first_frame` event (~0.7s expected)
   - Any FFmpeg stderr errors
   - Session lifecycle: START → first_frame → STOP timing

---

## What's NOT Changed

This is a **minimal bitstream path fix**, not a full refactor:

❌ **No profile forcing**: Still honors negotiated Baseline/Main/High (doesn't force Baseline)  
❌ **No firmware bump**: 1.3.0 unchanged (HAP advertisement not modified)  
❌ **No audio path changes**: Audio disabled anyway (ARGUS_AUDIO=0)  
❌ **No RTP packetization changes**: MTU, SRTP params unchanged  
❌ **No false field claims**: This document states "needs field test", not "Mini PASS"

---

## Rationale for dump_extra

### Why Not Just Force Baseline Profile?

**Option A**: Force Baseline profile (most compatible)
- ✅ Simpler decode path
- ❌ Wastes bandwidth at ≥720p (Baseline lacks CABAC, worse compression)
- ❌ Doesn't address dropped-packet robustness

**Option B**: Add in-band SPS/PPS (this change)
- ✅ Works with any profile (Baseline/Main/High)
- ✅ Robust to dropped initial packets
- ✅ Satisfies strict in-band requirements
- ✅ No bandwidth penalty
- ❌ Slightly larger overhead per keyframe (~100 bytes per IDR)

**Chosen**: Option B. Test in-band params first; if still broken, force Baseline in next commit.

### Why freq=keyframe?

**FFmpeg dump_extra modes**:
- `freq=keyframe` — inject before every keyframe (IDR)
- `all` — inject before every packet (wasteful)
- (none) — only in initial extradata

**Chosen**: `freq=keyframe`. Balances robustness (params before each IDR) with efficiency (not every packet).

---

## Next Steps

### If Field Test Shows Picture Unlock ✅

1. **Confirm**: Video renders without spinner hang (ARGUS_AUDIO=0 + in-band SPS/PPS)
2. **Document**: Update VIDEO-ONLY-INTERIM.md with field success timestamp
3. **Decide**: Keep video-only interim (ship picture-only) OR investigate audio restoration
4. **Merge**: PR #3 becomes merge candidate (still draft until decision)

### If Spinner Still Hangs ❌

**Next investigation steps** (in order):

1. **Check FFmpeg stderr**: Any decode/encode warnings? RTP errors?
2. **Verify bitstream**: Is dump_extra actually inserting SPS/PPS? (tcpdump + parse NALUs)
3. **Try Baseline profile**: Force `"-profile:v", "baseline"` regardless of negotiation
4. **Check level**: Try level 3.1 instead of 4.0 (some old devices reject 4.0)
5. **RTP packetization**: Investigate AVCC vs Annex-B (ffmpeg outputs Annex-B by default)
6. **HAP video params**: Check if HAP is advertising correct profile/level constraints

---

## Evidence Summary

**What we know works** (72a041a field evidence):
- ✅ Video-only negotiation (empty audio codecs, iOS honors it)
- ✅ Fast encode (~0.7s first frame, ~30fps)
- ✅ Correct source selection (garage-door-sub)
- ✅ Pad filter active (1280×720 exact)
- ✅ Bitrate honored (299k)

**What doesn't work yet** (72a041a field evidence):
- ❌ Home UI unlock (spinner never leaves, STOP after 10-12s)

**What changed** (f22f0eb):
- ✅ In-band SPS/PPS on every keyframe (`dump_extra=freq=keyframe`)

**Status**: Offline verified, needs Mini field test to confirm picture unlock.

---

**Tests**: 24/24 pass ✅  
**Build**: Clean  
**Firmware**: 1.3.0 (unchanged)  
**Audio**: Disabled (ARGUS_AUDIO=0)  
**Ready for**: Mini deployment + Garage Door live tap test
