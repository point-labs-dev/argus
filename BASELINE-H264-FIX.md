# Baseline H.264 Fix — Force Baseline Profile for Apple Home

**Date**: 2026-10-02  
**Commit**: (pending)  
**Branch**: cursor/fix-live-feed-hang-18ad  
**Status**: NOT field-confirmed (deploy + test required)

---

## Problem

Field evidence (2026-10-01, Mini firmware 1.3.0, commit `31743d7`):

```
HomeKit negotiated video: 1280x720@30 profile=high level=4.0 ... asked=299k serving=299k ... audio: none (video-only)
ffmpeg ... -profile:v high -level 4.0 ... pad=1280:720 ... -bsf:v dump_extra=freq=keyframe ...
live_session_first_frame ~0.8s, ~30fps, then live_session_stop / SIGKILL (~30s then retry)
```

**Home UI**: "Garage Door • No Response"

**Encode health**: ✅ First frame 0.8s, steady 30fps  
**Bitrate**: ✅ Honored (299k)  
**Dimensions**: ✅ Padded exactly (1280×720)  
**In-band SPS/PPS**: ✅ dump_extra=freq=keyframe active  
**Picture unlock**: ❌ **Still failed**

---

## Hypothesis

Apple Home may **refuse to unlock High profile H.264 streams** from this accessory, even with:
- In-band SPS/PPS on every keyframe
- Fast encode (~0.8s first frame)
- Perfect bitrate/dimension honor

**Baseline profile** is the most compatible H.264 profile — supported by all decoders, including older or constrained devices. **High profile** adds efficiency features (8x8 transform, CABAC) that some implementations may reject or gate more strictly.

---

## Solution

**Force Baseline H.264 encoding** (both advertise + encode):

### 1. HAP Advertisement (Baseline-only)

**Before** (`streamingOptions.video.codec.profiles`):
```typescript
profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH]
```

**After**:
```typescript
// Advertise ONLY Baseline to force Home to negotiate it. Field evidence
// (2026-10-01): Home negotiated High, we encoded High with dump_extra,
// picture still locked ("No Response"). Hypothesis: Home may refuse
// High streams from this accessory even with in-band SPS/PPS. Forcing
// Baseline both sides (advertise + encode) as the Home-friendly path.
profiles: [H264Profile.BASELINE]
```

**What this does**: Home can **only** negotiate Baseline (no High choice available).

### 2. Encoding (Force Baseline)

**Before** (`buildLiveFfmpegArgs`, line 192):
```typescript
"-profile:v", video.profile,  // Uses whatever Home negotiated (usually High)
```

**After**:
```typescript
// Force Baseline profile for Apple Home compatibility. Field evidence
// (2026-10-01): High with dump_extra → "No Response". Baseline is the
// Home-friendly unlock path. We advertise only Baseline in HAP.
"-profile:v", "baseline",
```

**What this does**: Encode with Baseline **regardless** of input (defensive).

### 3. Firmware Bump (Cache Invalidation)

**Before**: `ARGUS_FIRMWARE_REVISION = "1.3.0"` (video-only interim)

**After**: `ARGUS_FIRMWARE_REVISION = "1.3.1"` (Baseline profile)

**Why required**: iOS **caches** the advertised profile list (BASELINE/MAIN/HIGH). Without a firmware bump, iOS continues to see the old 3-profile list and may still negotiate High. Firmware bump → iOS re-reads accessory metadata → sees Baseline-only → negotiates Baseline.

---

## What Stays (Video-Only + Existing Fixes)

✅ **Video-only mode** (`ARGUS_AUDIO=0`, empty audio codecs)  
✅ **In-band SPS/PPS** (`-bsf:v dump_extra=freq=keyframe`)  
✅ **Exact padding** (`pad=1280:720`)  
✅ **Bitrate honor** (serve exactly what Home negotiates)  
✅ **Early IDR** (`-force_key_frames expr:eq(t,0)+...`)

**Rationale**: A/V sync attempts failed (4 tries, all 0/2 or 1/2 unstable). Video-only is the shippable interim. Baseline encoding is an **additional** unlock attempt on top of video-only.

---

## FFmpeg Command (After Fix)

**Example**: Garage Door 1280×720@30fps 299k (video-only, Baseline)

```bash
ffmpeg \
  -hide_banner \
  -loglevel error \
  -progress pipe:2 \
  -fflags +discardcorrupt+genpts+nobuffer \
  -flags low_delay \
  -probesize 100000 \
  -analyzeduration 50000 \
  -rtsp_transport tcp \
  -err_detect ignore_err \
  -i rtsp://127.0.0.1:8554/garage-door-sub \
  \
  -an \
  -c:v libx264 \
  -preset faster \
  -tune zerolatency \
  -profile:v baseline \
  -level 4.0 \
  -pix_fmt yuv420p \
  -color_range tv \
  -r 30 \
  -vf scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2 \
  -bf 0 \
  -g 120 \
  -keyint_min 60 \
  -force_key_frames expr:eq(t,0)+gte(t,n_forced*2) \
  -crf 18 \
  -maxrate 299k \
  -bufsize 299k \
  -bsf:v dump_extra=freq=keyframe \
  \
  -payload_type 99 \
  -ssrc 12345678 \
  -f rtp \
  -srtp_out_suite AES_CM_128_HMAC_SHA1_80 \
  -srtp_out_params AQEBAQEBAQEBAQEBAQEBAQICAgICAgICAgICAgIC \
  srtp://192.168.1.100:50000?rtcpport=50000&localrtcpport=60000&pkt_size=564
```

**Key diff from 31743d7**: `-profile:v high` → `-profile:v baseline`

---

## Tests Updated

### New Tests

1. **Encoding**: Verifies `-profile:v baseline` regardless of input profile (high/main/baseline)
2. **Advertisement**: Verifies HAP advertises only Baseline (not Main/High)
3. **Firmware**: Updated from 1.3.0 → 1.3.1

### All Tests Pass ✅

```
 Test Files  9 passed (9)
      Tests  76 passed (76)
```

**Verified in logs**:
- `profile=baseline` in negotiation log
- `-profile:v baseline` in ffmpeg command
- Firmware version 1.3.1

---

## Deployment (Mini Field Test)

### Prerequisites

1. **ARGUS_AUDIO=0** must be set (video-only mode)
2. **iOS cache invalidation**: Firmware bump 1.3.0 → 1.3.1 triggers iOS re-read

### Deploy Steps

```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad  # Gets Baseline fix commit
npm install && npm run build

# Verify Baseline encoding
grep "profile:v baseline" dist/homekit.js
# Should see: -profile:v baseline (not "high")

# Verify firmware bump
grep "ARGUS_FIRMWARE_REVISION" dist/homekit.js
# Should see: ARGUS_FIRMWARE_REVISION = "1.3.1"

# Restart Argus
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist

# Check boot log
tail -50 /tmp/argus.log
# Look for:
# - ARGUS_AUDIO=0 (video-only active)
# - ARGUS_FIRMWARE_REVISION=1.3.1
# - go2rtc ready
# - All 3 cameras pre-warmed
```

### Field Test

**Trigger**: Open Garage Door or trigger motion on any camera

**Tap notification** → Live view

**Expected (if Baseline fixes it)**:
```
2026-10-02T...Z [argus Garage Door] HomeKit negotiated video: 1280x720@30 profile=baseline level=4.0 ... serving=299k ... audio: none (video-only)
2026-10-02T...Z [argus Garage Door] ffmpeg ... -profile:v baseline ... -bsf:v dump_extra=freq=keyframe ...
2026-10-02T...Z [argus Garage Door] HomeKit first frame ... (elapsed: ~0.8s)
(VIDEO RENDERS — picture unlocks)
(session stays alive, no STOP until user closes)
```

**If still fails**:
```
(spinner hang or "No Response" despite baseline + dump_extra)
→ Baseline was not sufficient
→ Need deeper investigation (HAP compliance? Bitstream analysis?)
```

---

## Success Criteria

**PASS**: Video renders in Home app on notification tap (picture unlock)  
**FAIL**: Spinner hang or "No Response" persists

**If PASS**: Ship this commit (Baseline + video-only working)  
**If FAIL**: Baseline hypothesis rejected → investigate other unlock paths

---

## What This Does NOT Fix

❌ **Audio sync** (still unsolved, 4 attempts all failed)  
❌ **Mini Home integration** (not yet tested with Mini-at-home workflow)

**Video-only is the interim**: User sees picture, no audio. Baseline is an attempt to unlock that picture on the current video-only path.

---

## Rollback (If Needed)

If Baseline causes new issues (e.g., quality degradation, other client breakage):

```bash
git revert <this-commit>
# Restores High profile encoding + [BASELINE, MAIN, HIGH] advertisement
# Firmware stays 1.3.1 (iOS won't re-read on revert, but that's OK — 
# High was already in the list, so iOS will negotiate it again)
```

---

## PR Guidance

**Title**: `Force Baseline H.264 profile for Apple Home live unlock`

**Body**:
```markdown
## Problem
Field evidence (31743d7): High profile + dump_extra + video-only → "No Response"  
Encode healthy (~0.8s first frame, 30fps), bitrate/dimensions honored, in-band SPS/PPS active.  
Picture still locked.

## Hypothesis
Home may refuse High profile streams from this accessory. Baseline is most compatible.

## Changes
- Advertise only Baseline H.264 profile (was: Baseline/Main/High)
- Force Baseline encoding regardless of negotiation
- Firmware bump 1.3.0 → 1.3.1 (iOS cache invalidation for profile list)
- Keep: video-only, dump_extra, pad, bitrate honor, early IDR

## Status
NOT field-confirmed. Deploy + test on Mini required.  
Tests pass ✅ (offline argv shows baseline + dump_extra).

## Risk
If Baseline is not the blocker, picture remains locked. Need field test to confirm.
```

**Do NOT merge** until field-confirmed on Mini Home.

---

## Summary

**Change**: Force Baseline H.264 (advertise + encode), firmware 1.3.1  
**Hypothesis**: Home refuses High profile from this accessory  
**Keeps**: Video-only, dump_extra, pad, bitrate honor  
**Tests**: ✅ Pass (baseline encoding verified)  
**Field**: ⏳ Awaiting Mini deployment + test  
**Claim**: 🚫 NOT DONE (not field-confirmed)
