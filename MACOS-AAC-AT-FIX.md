# macOS AAC-ELD Fix — Use AudioToolbox (aac_at)

**Date**: 2026-10-01  
**Commit**: [current]  
**Issue**: FFmpeg native `aac` encoder doesn't support AAC-ELD profile

---

## Field Evidence (Mini @ 03107c4, ~10:16 ET)

**String/codec fix WORKED**:
```
HomeKit negotiated ... audio: codec=AAC-eld 24kHz (encoding aac/aac_eld)
ffmpeg ... -c:a aac -profile:a aac_eld ...
```

**But encoder open FAILED**:
```
[aac ...] Profile not supported!
Error while opening encoder...
Task finished with error code: -22 (Invalid argument)
ffmpeg exited code=234
```

**Root cause**: FFmpeg's built-in `aac` encoder doesn't support AAC-ELD profile. Most ffmpeg builds omit `libfdk_aac` (the encoder that properly supports AAC-ELD).

---

## Mini FFmpeg Encoders

From `/opt/homebrew/bin/ffmpeg -encoders`:
- ✅ `aac_at` (Apple AudioToolbox) — **macOS native, supports AAC-ELD**
- ✅ `aac` (native) — basic AAC-LC only, **no ELD support**
- ✅ `libopus` / `opus` — works everywhere
- ❌ `libfdk_aac` — not in Homebrew ffmpeg

---

## The Fix

### Use `aac_at` for AAC-ELD on macOS

**Before** (03107c4):
```typescript
"-c:a", "aac",
"-profile:a", "aac_eld",  // ❌ Fails: "Profile not supported!"
"-q:a", "4",
```

**After**:
```typescript
"-c:a", "aac_at",           // ✅ Apple AudioToolbox encoder
"-aac_at_mode", "aac_eld",  // ✅ AAC-ELD mode
"-b:a", `${audio.maxBitrateKbps}k`,
```

### Why aac_at

- **Native macOS encoder** via AudioToolbox framework
- **Proper AAC-ELD support** (Apple's preferred camera audio codec)
- **Ships with Homebrew ffmpeg** on macOS (no custom build required)
- **Hardware-accelerated** on Apple Silicon

### Cross-Platform Notes

- **macOS**: Use `aac_at` (this fix)
- **Linux without libfdk_aac**: Should only advertise Opus (AAC-ELD not available)
- **Linux with libfdk_aac**: Could use `libfdk_aac` with `-profile:a aac_eld`

For now, this codebase assumes macOS deployment (Mini). A Linux deployment would need either:
1. Only advertise Opus (remove AAC-ELD from controller options)
2. Build ffmpeg with libfdk_aac support
3. Runtime detection of available encoders (future enhancement)

---

## Verification

### Build
```bash
$ npm run build
# No errors
```

### Tests
```bash
$ npm test
Tests  71 passed (71)
```

### Args
```bash
# AAC-ELD session
-c:a aac_at -aac_at_mode aac_eld -b:a 24k

# Opus session
-c:a libopus -application lowdelay -frame_duration 20
```

### Logging
```
HomeKit negotiated ... audio: codec=AAC-eld 24kHz (encoding aac_at/aac_eld)
ffmpeg ... -c:a aac_at -aac_at_mode aac_eld -b:a 24k ...
```

Now the log correctly shows `aac_at/aac_eld` (not `aac/aac_eld`).

---

## Expected Behavior After Fix

### AAC-ELD Session on Mini
1. HomeKit negotiates AAC-ELD
2. Args: `-c:a aac_at -aac_at_mode aac_eld -b:a 24k`
3. Encoder opens successfully (no "Profile not supported!")
4. FFmpeg encodes AAC-ELD audio
5. Home receives matching codec → **video renders**

### Session Lifecycle
```
live_session_start
  ↓
FFmpeg spawns with aac_at encoder
  ↓
Encoder opens (no error)
  ↓
live_session_first_frame (~1-2s)
  ↓
Video renders in Home app
```

---

## Mini Deployment

No brew formula changes required! The existing Homebrew ffmpeg on Mini already has `aac_at`.

```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad
npm install && npm run build
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

**Verify**:
1. Trigger motion
2. Tap notification
3. Check logs: `(encoding aac_at/aac_eld)` and no encoder errors
4. **Video should render** in Home app
5. Measure: `live_session_first_frame` should fire (~1-2s)

---

## References

- [FFmpeg AudioToolbox encoder docs](https://ffmpeg.org/ffmpeg-codecs.html#toc-audiotoolbox)
- Apple AudioToolbox supports: AAC-LC, AAC-HE, AAC-ELD, AAC-HE v2
- Homebrew ffmpeg includes aac_at on macOS (not on Linux)
