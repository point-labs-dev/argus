# Video-Only prepareStream Fix — The Real Unlock

**Date**: 2026-10-02  
**Commit**: 01dee81  
**Branch**: cursor/fix-live-feed-hang-18ad  
**Status**: Needs Mini field test

---

## Problem

Field evidence (Mini firmware 1.3.1, commit 2312c70):
```
HomeKit negotiated ... audio: none (video-only)
ffmpeg ... -an ... -bsf:v dump_extra=freq=keyframe ... -profile:v baseline ...
live_session_first_frame ~0.8s, ~30fps to ~frame=908
live_session_stop / SIGKILL (~30s)
Home UI: "Garage Door • No Response"
```

**Critical finding from attempt-007.md**:
> "during a 'hanging' session the phone SENT RTCP receiver reports back (nettop: inbound bytes on the RTCP socket) — it receives our stream and answers, then refuses to render."

**Encode health**: ✅ First frame 0.8s, steady 30fps for 30s  
**Home receives stream**: ✅ Sends RTCP back  
**Picture unlock**: ❌ **Never happens**

---

## Root Cause

In video-only mode (`ARGUS_AUDIO=0`, empty audio codecs advertised), `prepareStream` **STILL included audio in the response**:

```typescript
// Before fix (ALL commits through 2312c70):
const response: PrepareStreamResponse = {
  video: { port: videoRtcp, ssrc: videoSsrc, ... },
  audio: { port: audioRtcp, ssrc: audioSsrc, ... },  // ❌ WRONG in video-only!
};
```

This told Home: "I'll send audio on port `audioRtcp` with SSRC `audioSsrc`"

But in `startStream`, we sent **video only** (`-an`, no audio SRTP).

**Home was waiting forever for audio packets that never arrived.**

The 30-second timeout is Home giving up on audio sync. Home receives video, responds with RTCP, but refuses to unlock the UI until audio arrives.

---

## The Fix

### 1. Conditional Audio in prepareStream Response

```typescript
const response: PrepareStreamResponse = {
  video: { port: videoRtcp, ssrc: videoSsrc, ... },
  // Only include audio if we're actually going to send it
  ...(this.includeAudio
    ? { audio: { port: audioRtcp, ssrc: audioSsrc, ... } }
    : {}),  // Video-only: omit audio entirely
};
```

**Before**: Always advertised audio ports, even when empty codecs  
**After**: Only advertise audio when `includeAudio=true`

This tells Home: "No audio will be sent, don't wait for it"

### 2. Real-Time Transmission Flags (Defense-in-depth)

Also added (not the root cause, but ensures immediate transmission):

```bash
-fflags +discardcorrupt+genpts+nobuffer+flush_packets  # Added +flush_packets
-flags low_delay
-max_delay 0  # NEW: Zero muxing delay for RTP
```

Ensures packets sent immediately, no buffering.

### 3. Firmware Bump 1.3.1 → 1.3.2

iOS caches prepareStream behavior. Firmware bump forces re-negotiation.

---

## Tests

### New Test (tests/homekit.test.ts)

```typescript
it("omits audio from prepareStream response in video-only mode", async () => {
  const delegate = new ArgusStreamingDelegate(
    "Garage Door",
    "rtsp://127.0.0.1:8554/garage-door-sub",
    cacheWith(Buffer.from([0xff, 0xd8])),
    { includeAudio: false }, // Video-only mode
  );

  const response = await new Promise<{ video: unknown; audio?: unknown }>(...);

  expect(response.video).toBeDefined();
  expect(response.audio).toBeUndefined();  // ✅ Audio omitted!
});
```

**Result**: All 77 tests pass ✅

---

## Mini Deployment

### Prerequisites

1. `ARGUS_AUDIO=0` must be set (video-only mode)
2. iOS will see firmware 1.3.1 → 1.3.2 and re-negotiate

### Deploy Steps

```bash
cd ~/Projects/argus
git fetch origin cursor/fix-live-feed-hang-18ad
git checkout cursor/fix-live-feed-hang-18ad
git pull  # Gets commit 01dee81

# Verify commit
git log --oneline -1
# Should show: 01dee81 Fix video-only prepareStream to not advertise audio ports

# Build
npm install && npm run build

# Verify fix
grep "includeAudio" dist/homekit.js | head -5
# Should show conditional audio logic

grep "ARGUS_FIRMWARE_REVISION" dist/homekit.js
# Should show: ARGUS_FIRMWARE_REVISION = "1.3.2"

# Restart Argus
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist

# Check boot log
tail -50 /tmp/argus.log
# Look for:
# - ARGUS_AUDIO=0 (video-only active)
# - ARGUS_FIRMWARE_REVISION=1.3.2
# - go2rtc ready
# - All 3 cameras pre-warmed
```

### Field Test

**Trigger**: Open Garage Door or trigger motion

**Tap notification** → Live view

**Expected (if fix works)**:
```
2026-10-02T...Z [argus Garage Door] HomeKit negotiated ... audio: none (video-only)
2026-10-02T...Z [argus Garage Door] ffmpeg ... -fflags +...+flush_packets ... -max_delay 0 ...
2026-10-02T...Z [argus Garage Door] HomeKit first frame (elapsed: ~0.8s)
✅ VIDEO RENDERS (picture unlocks!)
✅ Session stays alive (no 30s timeout)
✅ No "No Response" message
```

**If still fails**:
- Check logs: Is `audio: none (video-only)` shown?
- Verify firmware: iOS sees 1.3.2?
- Check prepareStream response in HAP debug logs
- Capture tcpdump to verify no audio SRTP attempts

---

## Why This Works

### The Audio-Waiting Trap

1. **Advertise empty codecs**: `audio.codecs: []` (iOS knows no audio codec available)
2. **prepareStream STILL advertised audio ports**: iOS interprets this as "audio WILL arrive"
3. **startStream sends video only**: `-an`, no audio SRTP
4. **iOS waits for audio**: Despite empty codecs, the port advertisement takes precedence
5. **30-second timeout**: iOS gives up, kills session

### The Fix

1. **Advertise empty codecs**: `audio.codecs: []` (same)
2. **prepareStream omits audio**: No audio ports/SSRC in response
3. **iOS knows not to wait**: No audio promised, video-only session accepted
4. **startStream sends video only**: `-an` (same)
5. **iOS renders immediately**: Video unlocks, no audio waiting

---

## What's NOT Changed

✅ **Baseline profile**: Still forced (1.3.1 change)  
✅ **dump_extra**: Still injecting SPS/PPS per keyframe  
✅ **Pad filter**: Still exact negotiated dimensions  
✅ **Bitrate honor**: Still using negotiated bitrate  
✅ **Video-only encode**: Still `-an` (no audio RTP)  
✅ **ARGUS_AUDIO=0**: Still required env var

**Only difference**: prepareStream response no longer lies about audio.

---

## Preserved Fixes (All Still Working)

- In-band SPS/PPS (`dump_extra=freq=keyframe`)
- Early IDR (`force_key_frames expr:eq(t,0)+...`)
- Exact padding (`pad=1280:720`)
- Bitrate honor (299k negotiated = 299k served)
- Video-only encode (`-an`)
- Baseline profile forced
- Firmware 1.3.0 → 1.3.1 → **1.3.2**

---

## Evidence This Is The Fix

### 1. Symptoms Match Audio-Waiting

- ✅ Home receives video (RTCP back)
- ✅ Home waits ~30s then kills
- ✅ No UI unlock despite healthy encode
- ✅ "No Response" message

**Classic pattern**: Waiting for stream component that never arrives

### 2. Root Cause Was In prepareStream

- Video-only codecs advertised correctly ✅
- Video-only FFmpeg command correct ✅
- But prepareStream response **advertised audio ports** ❌

**This is the missing piece all previous attempts didn't touch.**

### 3. HAP Protocol Semantics

Per HAP-nodejs and HomeKit protocol:
- prepareStream response = "What I will send"
- If audio included = "Audio will arrive on these ports"
- If audio omitted = "Video-only session, don't wait for audio"

We were advertising audio in a video-only session.

---

## Alternative Hypotheses (Discarded)

❌ **Baseline profile**: Was tried (1.3.1), still failed  
❌ **dump_extra**: Was tried (f22f0eb), still failed  
❌ **Bitrate**: Was honored (299k exact), still failed  
❌ **Padding**: Was exact (1280×720), still failed  
❌ **First frame timing**: Frame=1 telemetry fires, still failed  
❌ **RTP timestamps**: Home sends RTCP back (receives correctly), still failed  
❌ **RTCP setup**: Home responds with RTCP, still failed  

**All those were correct.** The bug was in what we **promised** vs what we **sent**.

---

## Success Criteria

**PASS**: Live view renders video in Home app (picture unlock)  
**FAIL**: "No Response" persists despite video-only prepareStream fix

**If PASS**: Ship firmware 1.3.2 (video-only working)  
**If FAIL**: Video-only prepareStream hypothesis rejected, need deeper investigation

---

## Rollback (If Needed)

```bash
git revert 01dee81
# Restores audio in all prepareStream responses
# Firmware stays 1.3.2 (iOS won't re-read on revert, but that's OK)
```

---

## Next Steps After Field Test

### If Video Unlocks ✅

1. **Confirm**: Video renders without "No Response" hang
2. **Decide**: Keep video-only (ship picture) OR restore audio
3. **Audio restoration path** (if chosen):
   - Solve A/V sync (all previous attempts failed)
   - Test audio + video together
   - Bump firmware again (1.3.3) for iOS to re-read

### If Still Fails ❌

Investigate (in order):
1. Verify prepareStream response actually omits audio (HAP debug logs)
2. Check if iOS still negotiates audio despite omitted response
3. Try sending silent audio packets (dummy SRTP) instead of omitting
4. Deeper HAP protocol investigation (SDP, stream setup sequence)

---

## Summary

**Change**: Omit audio from prepareStream response in video-only mode  
**Root Cause**: Home waited forever for audio we promised but never sent  
**Fix Confidence**: HIGH (directly addresses audio-waiting pattern)  
**Tests**: ✅ 77/77 pass (offline verified)  
**Field**: ⏳ Awaiting Mini deployment + Garage Door test  
**Claim**: 🚫 NOT DONE (not field-confirmed yet)

**This fix targets the unlock path, not audio sync.** Video-only is the interim.
