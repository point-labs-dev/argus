# Fix Summary: Video-Only prepareStream Audio-Waiting Bug

## The Problem

Home received video stream (~900 frames, ~30s) and sent RTCP back, but **never unlocked UI**. Despite:
- ✅ Baseline profile
- ✅ dump_extra (in-band SPS/PPS)
- ✅ Video-only mode (ARGUS_AUDIO=0)
- ✅ Exact padding
- ✅ Bitrate honor
- ✅ Healthy encode

**Still failed with "No Response" after 30s.**

## The Root Cause

In video-only mode, `prepareStream` **advertised audio ports** in the response:

```typescript
// BUG: Always included audio, even when includeAudio=false
const response = {
  video: { port: videoRtcp, ssrc: videoSsrc, ... },
  audio: { port: audioRtcp, ssrc: audioSsrc, ... },  // ❌ Home waits for this!
};
```

**Home interpreted this as**: "Audio will arrive on port `audioRtcp`"

But we never sent audio (`-an` in FFmpeg command).

**Home waited forever for audio packets that never arrived.**

The 30-second timeout was Home giving up on audio sync.

## The Fix (Commit 01dee81)

### 1. Conditional Audio in prepareStream

```typescript
const response: PrepareStreamResponse = {
  video: { port: videoRtcp, ssrc: videoSsrc, ... },
  // Only advertise audio when we'll actually send it
  ...(this.includeAudio
    ? { audio: { port: audioRtcp, ssrc: audioSsrc, ... } }
    : {}),  // Video-only: omit audio
};
```

**Tells Home**: "No audio will be sent, don't wait for it"

### 2. Added Real-Time Transmission Flags

```bash
-fflags +...+flush_packets  # Immediate packet transmission
-max_delay 0                 # Zero muxing delay
```

### 3. Firmware Bump 1.3.1 → 1.3.2

Forces iOS to re-negotiate with new prepareStream behavior.

## Why This Is The Fix

1. **Symptoms matched audio-waiting**: Home receives, responds, waits, times out
2. **Root cause in prepareStream**: Advertised audio we never sent
3. **HAP protocol semantics**: Response = promise of what you'll send
4. **Direct fix**: Stop promising audio in video-only mode

## Changes Made

- `src/homekit.ts`: Conditional audio in prepareStream response
- `src/homekit.ts`: Add flush_packets and max_delay flags
- `src/homekit.ts`: Firmware 1.3.1 → 1.3.2
- `tests/homekit.test.ts`: Add video-only prepareStream test
- `VIDEO-ONLY-PREPARESTREAM-FIX.md`: Full deployment guide

## Tests

✅ All 77 tests pass (added 1 new test)  
✅ Video-only prepareStream correctly omits audio  
✅ Offline verified conditional logic

## Field Test Required

**NOT DONE YET** — needs Mini deployment + Garage Door live tap test.

**Expected**: Video renders without "No Response" hang.

## Commits

- `01dee81` Fix video-only prepareStream to not advertise audio ports
- `6f1c802` Document video-only prepareStream fix and deployment

**Branch**: cursor/fix-live-feed-hang-18ad  
**Pushed to**: origin

## Next: Deploy to Mini

See `VIDEO-ONLY-PREPARESTREAM-FIX.md` for full deployment steps.
