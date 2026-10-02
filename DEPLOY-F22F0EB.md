# Mini Redeploy Quick Reference — f22f0eb In-Band SPS/PPS

**What**: Add in-band H.264 parameter sets to fix HomeKit video unlock  
**Commit**: f22f0eb  
**Branch**: cursor/fix-live-feed-hang-18ad  
**Change**: `-bsf:v dump_extra=freq=keyframe` in video encode path

---

## Redeploy (Copy-Paste)

```bash
cd ~/Projects/argus
git fetch origin cursor/fix-live-feed-hang-18ad
git checkout cursor/fix-live-feed-hang-18ad
git pull  # Should land on f22f0eb
npm run build
launchctl unload ~/Library/LaunchAgents/com.example.argus.plist
launchctl load ~/Library/LaunchAgents/com.example.argus.plist
```

## Verify Boot

```bash
tail -100 /tmp/argus.log
```

**Look for**:
- `ARGUS_AUDIO=0` (video-only mode)
- `ARGUS_FIRMWARE_REVISION=1.3.0` (no bump needed)
- `go2rtc ready`
- All 3 cameras pre-warmed

## Field Test

**Trigger**: Tap Garage Door motion notification

**Expected** (if fix works):
- Spinner appears briefly (<2s)
- **Spinner leaves** (video unlocks)
- **Live picture renders**
- No audio (expected, ARGUS_AUDIO=0)
- No endless spinner hang

**If still hangs**: Capture `/tmp/argus.log` session (START → STOP), look for:
- FFmpeg argv includes `-bsf:v dump_extra=freq=keyframe`
- `live_session_first_frame` event (~0.7s)
- Negotiated profile/level
- Any FFmpeg stderr errors

---

## What Changed (f22f0eb)

**Before** (72a041a):
```bash
ffmpeg ... -c:v libx264 -profile:v high -maxrate 299k ...
```

**After** (f22f0eb):
```bash
ffmpeg ... -c:v libx264 -profile:v high -maxrate 299k \
  -bsf:v dump_extra=freq=keyframe ...  # ← NEW: in-band SPS/PPS
```

**Why**: HomeKit may need in-band H.264 parameter sets on every keyframe to unlock video. If initial SPS/PPS packets drop or device enforces strict in-band decode, out-of-band-only → forever spinner.

---

## Environment Check

**LaunchAgent plist** (`~/Library/LaunchAgents/com.example.argus.plist`):
```xml
<key>EnvironmentVariables</key>
<dict>
  <key>ARGUS_AUDIO</key>
  <string>0</string>  <!-- MUST be 0 for video-only -->
  ...
</dict>
```

**Firmware** (no bump needed):
- Current: 1.3.0
- Required: 1.3.0 (unchanged, HAP advertisement not modified)

**Configuration stays**:
- `ARGUS_AUDIO=0` (video-only, audio sync unsolved)
- `ARGUS_FIRMWARE_REVISION=1.3.0` (iOS cache bust for video-only)

---

## Success Criteria

✅ **Spinner unlocks** (picture renders within 1-2s)  
✅ **Video plays** (live feed, 1280×720)  
✅ **No audio** (expected with ARGUS_AUDIO=0)  
✅ **No hang** (no STOP/SIGKILL after 10-12s)

**If success**: Update VIDEO-ONLY-INTERIM.md with field timestamp, consider merge.

**If still fails**: Capture logs, investigate:
1. Bitstream verification (tcpdump + parse NALUs)
2. Force Baseline profile (next commit)
3. RTP packetization (AVCC vs Annex-B)
4. HAP profile/level advertisement

---

**Tests**: 24/24 pass ✅  
**Build**: Clean  
**Ready**: Deploy + tap Garage Door notification
