# Deployment Checklist — Video-Only prepareStream Fix

**Branch**: `cursor/fix-live-feed-hang-18ad`  
**Latest commit**: `01dee81` (plus docs: a2ec6ad)  
**Firmware**: 1.3.2 (was 1.3.1)  
**Status**: Ready for Mini field test

---

## ✅ Pre-Deployment Verification (Completed)

- [x] All 77 tests pass
- [x] Video-only prepareStream omits audio in response
- [x] flush_packets and max_delay flags added
- [x] Firmware version updated to 1.3.2
- [x] Changes committed and pushed to origin
- [x] Documentation created (VIDEO-ONLY-PREPARESTREAM-FIX.md)

---

## 📋 Mini Deployment Steps

### 1. Pull Latest Code

```bash
cd ~/Projects/argus
git fetch origin cursor/fix-live-feed-hang-18ad
git checkout cursor/fix-live-feed-hang-18ad
git pull

# Verify you're on the right commit
git log --oneline -1
# Should show: 01dee81 Fix video-only prepareStream to not advertise audio ports
```

### 2. Build

```bash
npm install && npm run build
```

### 3. Verify Build

```bash
# Check for conditional audio logic
grep "includeAudio" dist/homekit.js | head -3

# Check firmware version
grep "ARGUS_FIRMWARE_REVISION" dist/homekit.js
# Should show: "1.3.2"
```

### 4. Verify Configuration

```bash
# Check that ARGUS_AUDIO=0 is set
cat ~/Library/LaunchAgents/dev.point-labs.argus.plist | grep -A 1 ARGUS_AUDIO
# Should show:
# <key>ARGUS_AUDIO</key>
# <string>0</string>
```

### 5. Restart Argus

```bash
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

### 6. Check Boot Log

```bash
tail -50 /tmp/argus.log

# Look for:
# - ARGUS_AUDIO=0 (confirms video-only mode)
# - ARGUS_FIRMWARE_REVISION=1.3.2 (confirms new firmware)
# - go2rtc ready
# - All 3 cameras pre-warmed
```

---

## 🧪 Field Test

### Trigger Live View

1. **Open Garage Door** OR **trigger motion** on any camera
2. **Tap notification** in Home app
3. **Observe live view behavior**

### Expected Success ✅

```
[argus Garage Door] HomeKit negotiated ... audio: none (video-only)
[argus Garage Door] ffmpeg ... -fflags +...+flush_packets ... -max_delay 0 ...
[argus Garage Door] HomeKit first frame (elapsed: ~0.8s)
```

**In Home app**:
- ✅ Spinner appears briefly (<2s)
- ✅ **Spinner leaves** (picture unlocks!)
- ✅ **Video renders** (live feed visible)
- ✅ No audio (expected in video-only mode)
- ✅ Session stays alive (no 30s timeout)
- ✅ No "No Response" message

### If Still Fails ❌

1. **Capture logs**: Full session from START to STOP
2. **Check negotiation**: Does log show `audio: none (video-only)`?
3. **Verify firmware**: Did iOS see 1.3.1 → 1.3.2 transition?
4. **Check prepareStream**: HAP debug logs should show audio omitted from response
5. **Investigate**: See "Next Steps After Field Test" in VIDEO-ONLY-PREPARESTREAM-FIX.md

---

## 📊 What Changed

### Code Changes

1. **prepareStream response**: Conditionally includes audio only when `includeAudio=true`
2. **FFmpeg flags**: Added `+flush_packets` and `-max_delay 0` for immediate transmission
3. **Firmware**: Bumped 1.3.1 → 1.3.2 for iOS cache invalidation

### What Stayed the Same

- ✅ Baseline profile (still forced)
- ✅ dump_extra (still active)
- ✅ Padding (still exact)
- ✅ Bitrate honor (still exact)
- ✅ Video-only encode (`-an`)
- ✅ ARGUS_AUDIO=0 environment variable

---

## 🎯 Success Criteria

**PASS**: Live view renders video without "No Response" hang  
**FAIL**: "No Response" persists despite prepareStream fix

---

## 🔍 Why This Should Work

**Root cause identified**: prepareStream advertised audio ports even in video-only mode, causing Home to wait forever for audio packets that never arrived.

**Fix applied**: Omit audio from prepareStream response when includeAudio=false, telling Home explicitly: "No audio will be sent, don't wait for it."

**Evidence basis**: 
- Home was receiving video (RTCP back confirms)
- Home was timing out at exactly 30s (audio-waiting pattern)
- All other fixes (Baseline, dump_extra, padding, etc.) were correct
- The bug was in what we **promised** vs what we **sent**

---

## 📝 Documentation

- **Full details**: `VIDEO-ONLY-PREPARESTREAM-FIX.md`
- **Quick summary**: `FIX-SUMMARY.md`
- **This checklist**: `DEPLOYMENT-CHECKLIST.md`

---

## ✋ Important Notes

1. **No false claims**: This is NOT confirmed working until field tested
2. **Video-only interim**: Audio sync still unsolved, this is picture-only
3. **Do NOT merge** until Mini field test confirms video unlock
4. **Tests pass**: 77/77 offline, but real Mini is the proof

---

## Next Actions

1. ✅ Code complete (commit 01dee81)
2. ✅ Tests pass (77/77)
3. ✅ Documentation complete
4. ⏳ **→ Mini deployment** (you are here)
5. ⏳ Field test (tap Garage Door notification)
6. ⏳ Confirm video unlock or investigate further

---

**Ready for deployment and field test.**
