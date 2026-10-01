# libfdk_aac Field-Proven Fix

**Date**: 2026-10-01  
**Commit**: [current]  
**Source**: Mini hot-patch + field test

---

## Field Evidence

### aac_at Attempt (b294e9b)
```
ffmpeg ... -c:a aac_at -aac_at_mode aac_eld ...
(Encoder issues — aac_at doesn't expose ELD cleanly on this build)
```

### libfdk_aac Success (hot-patched)
```
ffmpeg ... -c:a libfdk_aac -profile:a aac_eld -flags +global_header ...
Audio: aac (ELD) ... successfully encoded to RTP/null
```

**Verified working**: Mini's `/Users/pointlabs/.local/bin/ffmpeg-homebridge` (ffmpeg-for-homebridge) with libfdk_aac.

---

## The Fix

### 1. Use libfdk_aac for AAC-ELD

**Args**:
```typescript
"-c:a", "libfdk_aac",
"-profile:a", "aac_eld",
"-flags", "+global_header",  // Required for RTP streaming
"-b:a", `${audio.maxBitrateKbps}k`,
```

**Why libfdk_aac**:
- Only reliable AAC-ELD encoder
- Native `aac`: fails "Profile not supported!"
- `aac_at` (AudioToolbox): doesn't expose ELD cleanly on this ffmpeg build
- Ships with ffmpeg-for-homebridge (Homebrew formula)

**Why +global_header**:
- Required for RTP/SRTP streaming
- Moves codec extradata to global headers (not per-packet)
- Without it, RTP stream may not initialize properly

### 2. Wire ARGUS_FFMPEG Through

**serve.ts**:
```typescript
createCameraAccessory(camera, liveUrl, mainUrl, cache, {
  includeAudio,
  videoMode,
  ffmpegPath: process.env.ARGUS_FFMPEG,  // ← Added
  ...
});
```

**Why**: Mini's LaunchAgent sets `ARGUS_FFMPEG=/Users/pointlabs/.local/bin/ffmpeg-homebridge` but serve.ts wasn't passing it to the delegate.

**Result**: Delegate uses the ffmpeg-homebridge binary with libfdk_aac support.

---

## Mini Deployment

**No changes required!** Mini already has:
- ffmpeg-homebridge at `/Users/pointlabs/.local/bin/ffmpeg-homebridge`
- LaunchAgent sets `ARGUS_FFMPEG` env var
- Now wired through to encoder spawn

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
3. Check logs: `(encoding libfdk_aac/aac_eld)` with NO encoder errors
4. **Video should render** in Home app
5. Verify: `live_session_first_frame` fires (~1-2s)

---

## Expected Behavior

### AAC-ELD Session
```
HomeKit negotiated ... audio: codec=AAC-eld 24kHz (encoding libfdk_aac/aac_eld)
ffmpeg ... -c:a libfdk_aac -profile:a aac_eld -flags +global_header -b:a 24k ...
(Encoder opens successfully)
Audio: aac (ELD), 24000 Hz, mono, s16, 24 kb/s
live_session_first_frame fires
→ Video renders
```

### Opus Session
```
HomeKit negotiated ... audio: codec=OPUS 24kHz (encoding libopus)
ffmpeg ... -c:a libopus -application lowdelay -frame_duration 20 ...
→ Video renders
```

---

## Cross-Platform Notes

### macOS (Mini)
✅ Use ffmpeg-homebridge with libfdk_aac (this fix)
- Homebrew: `brew install ffmpeg-for-homebridge`
- Binary: `/Users/[user]/.local/bin/ffmpeg-homebridge`
- Set `ARGUS_FFMPEG` env var pointing to it

### Linux
Options:
1. Build ffmpeg with `--enable-libfdk-aac` (requires fdk-aac library)
2. Only advertise Opus (remove AAC-ELD from controller options)
3. Runtime detection: probe for libfdk_aac, advertise codecs accordingly

For now, this codebase assumes ffmpeg-homebridge on macOS.

---

## Tests

All pass (71/71):
```bash
$ npm test
Tests  71 passed (71)
```

Tests verify:
- AAC-ELD: `-c:a libfdk_aac -profile:a aac_eld -flags +global_header`
- Opus: `-c:a libopus -application lowdelay -frame_duration 20`

---

## Why Not aac_at?

**Attempted** (b294e9b): `-c:a aac_at -aac_at_mode aac_eld`

**Field result**: Encoder issues on Mini's ffmpeg build. AudioToolbox encoder exists but doesn't cleanly expose AAC-ELD mode with the expected flags.

**Conclusion**: libfdk_aac is the reliable path for AAC-ELD across ffmpeg builds.
