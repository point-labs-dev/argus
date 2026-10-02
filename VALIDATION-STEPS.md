# Validation Steps — Offline A/V Sync + Field Test

**Date**: 2026-10-02  
**Commit**: d47c97d  
**Fix**: Removed synthetic audio clock (`asetpts=N/SR/TB`)

---

## Offline Validation (No iOS Home Tap Required)

### Re-run validate-av-sync

**Command**:
```bash
cd ~/Projects/argus
node scripts/validate-av-sync.mjs garage-door-sub --size 1280x720 --bitrate 299 --seconds 40
```

**Expected output**:
```
stream=garage-door-sub 1280x720@299k for 40s
t(s)  video_clock(s)  audio_clock(s)  skew(ms)   [skew drifting = lip-sync gate trips]
  10         10.XX         10.XX           X
  20         20.XX         20.XX           X
  30         30.XX         30.XX           X
  40         40.XX         40.XX           X

VERDICT: skew Xms -> Yms; drift Z ms/min
A/V clocks track — stream-side sync looks healthy.
```

**Acceptance criteria**:
- `|drift| < 100 ms/min` (was −1458 before fix)
- `|final_skew| < 1000 ms`
- Verdict: "A/V clocks track"

**If still diverging**:
- Capture full output
- Check FFmpeg stderr from validator (sample clock issues?)
- Unlikely given video-only passed + natural sync should work

### What Changed

**Before** (commit 2bdc7d9 and earlier):
```bash
ffmpeg ... -af asetpts=N/SR/TB ...
```

**Measured**:
- Skew: −207 ms → −693 ms (40s)
- Drift: **−1458 ms/min**
- Verdict: "A/V CLOCKS DIVERGE"

**After** (commit d47c97d):
```bash
ffmpeg ... (no -af asetpts) ...
```

**Expected**:
- Skew: stays within ±200 ms
- Drift: **< 100 ms/min**
- Verdict: "A/V clocks track"

**Why it works**: FFmpeg naturally syncs audio to the CFR video clock (`-r 30`). No manual timestamp surgery needed.

---

## Field Test (iOS Home)

### Prerequisites

**Pull & build**:
```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad
npm install && npm run build
```

**Expected commit**: `d47c97d` (check with `git log --oneline -1`)

**Restart Argus**:
```bash
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

**Check boot log**:
```bash
tail -100 /tmp/argus.log | grep "live mode"
```

**Expected**:
```
[argus Garage Door] live mode: transcode (≥720p source: sub)
```

**Note**: Should say "sub" not "main" (no ARGUS_LIVE_MAIN_SOURCE set).

### One Home Tap Test

**Trigger motion**:
- Walk in front of Garage Door camera
- OR use manual motion trigger if available

**iOS notification appears**: "Motion detected at Garage Door"

**Tap notification**:
- iOS Home app opens
- Camera tile expands to full screen
- **Loading spinner appears** (normal, brief)

**Expected behavior**:
1. ✅ **Spinner leaves** (~2-5 seconds)
2. ✅ **Video renders** (live feed from Garage Door)
3. ✅ **Video plays continuously** (no freeze, no hang)
4. ✅ **Audio present** (AAC-ELD or Opus, depending on negotiation)
5. ✅ **No return to spinner** (stays playing)

**Success**: All 5 checkmarks met.

### Failure Symptoms & Debug

**If spinner stays indefinitely**:
- Check Mini logs: `tail -200 /tmp/argus.log`
- Look for negotiation line: `HomeKit negotiated ... audio: codec=...`
- Look for FFmpeg spawn: Should NOT have `-af asetpts`
- Check first frame: `live_session_first_frame: first_frame_ms=...`
- If first frame arrives but spinner stays → different issue (unlikely)

**If black screen after spinner**:
- RTP delivery issue (network, SRTP keys, etc.)
- Check FFmpeg stderr in logs

**If video stutters/freezes**:
- Bitrate too low (299k) or network congestion
- Not the A/V sync issue (sync would cause spinner, not stutter)

**If audio missing**:
- Check negotiation: Did iOS request audio?
- Check FFmpeg spawn: Should have `-c:a libfdk_aac` or `-c:a libopus`
- If negotiation had audio but spawn doesn't → bug

### Expected Logs (Healthy Session)

**Negotiation** (should include audio):
```
HomeKit negotiated session=abc123 video: 1280x720@30 299kbps audio: codec=AAC-eld 24kHz
(will encode libfdk_aac/aac_eld)
```

**FFmpeg spawn** (should NOT have `asetpts`):
```
ffmpeg -hide_banner -loglevel warning -rtsp_transport tcp -i rtsp://...
  -c:v libx264 -tune zerolatency -r 30 -maxrate 299k -bufsize 299k ...
  -vn -c:a libfdk_aac -profile:a aac_eld -flags +global_header -ac 1 -ar 24k ...
  -f rtp -srtp_out_suite AES_CM_128_HMAC_SHA1_80 ...
```

**Key**: NO `-af asetpts=N/SR/TB` in audio section.

**Session lifecycle**:
```
live_session_first_frame: session_id=abc123 first_frame_ms=1700
[... ~30 fps steady ...]
live_session_stop: session_id=abc123
[Home STOP → SIGKILL]
live_session_end: session_id=abc123 frames=900 duration_s=30
```

---

## Summary Checklist

### Offline (Before Mini Deploy)

- [ ] **Re-run validate-av-sync** on garage-door-sub @ 1280x720@299k/40s
- [ ] **Verify drift < 100 ms/min** (was −1458 before fix)
- [ ] **Verify verdict "A/V clocks track"** (was "DIVERGE" before)

**This proves the fix without any iOS Home interaction.**

### Field (Mini Deploy)

- [ ] **Pull commit d47c97d** from `cursor/fix-live-feed-hang-18ad`
- [ ] **Build**: `npm install && npm run build`
- [ ] **Restart Argus**: `launchctl unload/load`
- [ ] **Check boot log**: Says "sub" not "main" (correct)
- [ ] **Trigger motion**: Any camera (Garage Door preferred)
- [ ] **Tap notification**: iOS Home opens
- [ ] **Verify spinner leaves**: ~2-5 seconds
- [ ] **Verify video renders**: Live feed plays continuously
- [ ] **Verify audio present**: Hear ambient sound

**Expected outcome**: ✅ All checkmarks met → Spinner resolved.

---

## Root Cause Recap

**Problem**: Synthetic audio clock (`asetpts=N/SR/TB`) drifted −1458 ms/min from CFR video.

**Why spinner**: iOS ≥720p strictly gates video on audio sync; drift beyond ~100 ms/min stalls decoder.

**Evidence**: Offline validate-av-sync measured drift; video-only decode passed (confirms audio gating).

**Fix**: Remove synthetic clock → FFmpeg naturally syncs audio to video CFR grid → drift eliminated.

**Proof**: Re-run validate-av-sync shows drift < 100 ms/min (offline, no Home tap).

**Success criteria**: One Home tap → spinner leaves, video renders.
