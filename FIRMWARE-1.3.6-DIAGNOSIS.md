# Firmware 1.3.6 — iOS Cache Refresh for Audio

**Commit**: `7fce38a`  
**Date**: 2026-10-02  
**Issue**: MacBook Home shows "No Response" after 1.3.5 deployment

---

## Root Cause Analysis

### Evidence Discrepancy

**Field logs (10:33 ET)** show:
- `pkt_size=564` (old value)
- `audio: none (video-only)`
- `-an` flag in ffmpeg

**Firmware 1.3.5 code** has:
- `pkt_size=1316` (changed)
- Audio support with `includeAudio=true`
- No `-an` when ARGUS_AUDIO=1

**Timeline**:
- 10:33 ET: Session with old code (pkt_size=564)
- 10:51 ET: **LaunchAgent restarted** with firmware 1.3.5
- Sessions shown are from **BEFORE restart** = old code

### Actual Issue

After 10:51 deployment of 1.3.5, **iOS Home cached accessory as video-only** from earlier test builds. Even though 1.3.5 advertises audio codecs:

```typescript
audio: {
  codecs: includeAudio
    ? [
        { type: AudioStreamingCodecType.AAC_ELD, ... },
        { type: AudioStreamingCodecType.OPUS, ... },
      ]
    : [],
},
```

iOS may not re-query accessory capabilities until:
1. Firmware version bumps (triggers iOS refresh)
2. Accessory is removed and re-added in Home app
3. Cache expires naturally (~hours/days)

---

## Fix (Firmware 1.3.6)

### Changes

1. **Bump ARGUS_FIRMWARE_REVISION**: `1.3.5` → **`1.3.6`**
2. **Change Model**: `"Argus"` → **`"Argus 1.3.6"`** (additional metadata change)
3. **Document**: iOS cache issue in firmware history

### Why This Works

HAP-NodeJS auto-increments `configVersion` (c#) in mDNS when `FirmwareRevision` increases. iOS Home sees:
- New firmware version (1.3.6)
- New model string
- Higher c# in mDNS

Triggers iOS to:
1. Re-query accessory `Service.AccessoryInformation`
2. Re-read streaming options (audio codecs)
3. Invalidate cached "video-only" metadata

---

## Mini Redeploy (Home Manager)

### 1. Pull + Build + Restart

```bash
cd ~/Projects/argus
git fetch origin
git checkout cursor/fix-live-feed-hang-18ad
git pull  # Should show tip 7fce38a
npm install && npm run build
```

**Verify firmware**:
```bash
grep "ARGUS_FIRMWARE_REVISION" dist/homekit.js
# Expect: ARGUS_FIRMWARE_REVISION = "1.3.6"
```

**Restart LaunchAgent**:
```bash
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

### 2. Verify LaunchAgent Environment

Check that `ARGUS_AUDIO=1` is in the plist:

```bash
cat ~/Library/LaunchAgents/dev.point-labs.argus.plist | grep -A5 EnvironmentVariables
```

**Expected**:
```xml
<key>EnvironmentVariables</key>
<dict>
  <key>ARGUS_AUDIO</key>
  <string>1</string>
  ...
</dict>
```

If missing, add it and reload.

### 3. Check Boot Logs

```bash
tail -50 /tmp/argus.log | grep -E "HAP bind|live mode|Argus"
```

**Expected**:
```
[argus] HAP bind address: 10.0.0.48
[argus Garage Door] live mode: transcode (≥720p source: sub)
```

### 4. Trigger Live Session from MacBook Home

Open Garage Door live view. Check logs in **real-time**:

```bash
tail -f /tmp/argus.log | grep -E "negotiated|Bound|RTCP|first_frame"
```

**Expected SUCCESS indicators**:

✅ **Audio negotiated** (NOT video-only):
```
HomeKit negotiated video: ... audio: codec=AAC-eld 24kHz ptype=110 (encoding libfdk_aac/aac_eld)
```

✅ **pkt_size=1316** (firmware 1.3.6 active):
```
srtp://10.0.0.X:XXXXX?rtcpport=XXXXX&pkt_size=1316&localaddr=10.0.0.48
```

✅ **RTCP return bound**:
```
Bound video return RTCP: port 60123 addr 10.0.0.48
Bound audio return RTCP: port 60456 addr 10.0.0.48
```

✅ **RTCP arrival** (proves bidirectional):
```
RTCP arrived on video return port (48 bytes)
```

✅ **First frame**:
```
live_session_first_frame: first_frame_ms=1270
```

✅ **No early SIGKILL** (session runs >60s)

### 5. Success Criteria

MacBook Home app:
- ✅ Spinner appears briefly
- ✅ Spinner disappears (~2-5s)
- ✅ **Video renders with audio**
- ✅ Stream plays continuously (≥60s, no "No Response")

---

## If Still Video-Only After 1.3.6

### Option A: Remove and Re-Add Accessory (Nuclear)

1. MacBook Home app → Garage Door settings → Remove Accessory
2. Re-add using pairing code from Argus boot log
3. iOS will query fresh metadata (no cache)

### Option B: Check iOS Firmware Cache

On MacBook, check Home app's cached accessory info:
```bash
defaults read com.apple.Home | grep -i argus
```

Look for cached `supportsAudio` or similar flags.

### Option C: Verify ARGUS_AUDIO=1 Actually Took Effect

Force a clear log marker:

```bash
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
# Edit plist to add diagnostic log
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

Check first session after restart shows audio.

---

## Residual Risks

1. **iOS still caches despite firmware bump**: Firmware 1.3.6 might not be "different enough" from 1.3.5 to trigger refresh. Model string change ("Argus 1.3.6") helps but not guaranteed.
   - **Mitigation**: If still video-only, bump to 1.4.0 (major version change).

2. **ARGUS_AUDIO=1 not actually set**: LaunchAgent plist might be missing or overridden.
   - **Verification**: Check plist EnvironmentVariables.

3. **Audio codec not available**: If `ffmpeg` binary lacks `libfdk_aac`, AAC-ELD will fail and might fall back to video-only.
   - **Verification**: `ffmpeg -encoders | grep libfdk_aac` should show `libfdk_aac`.

4. **Audio negotiation works but RTCP still broken**: Even with audio, Home might SIGKILL if RTCP return path fails.
   - **Diagnosis**: Check for "RTCP arrived" in logs. If missing, RTCP path still broken.

---

## Logs to Capture (If Still Fails)

From a **FRESH session after 1.3.6 restart**:

```bash
# Full session log
tail -200 /tmp/argus.log > ~/argus-1.3.6-session.log

# Specifically check:
grep "negotiated video" ~/argus-1.3.6-session.log  # Should show audio codec
grep "pkt_size=" ~/argus-1.3.6-session.log          # Should be 1316
grep "Bound.*RTCP" ~/argus-1.3.6-session.log       # Should show bound sockets
grep "RTCP arrived" ~/argus-1.3.6-session.log      # Should fire when Home sends RR
grep "SIGKILL" ~/argus-1.3.6-session.log           # Should NOT appear early
```

Share `argus-1.3.6-session.log` if issue persists.

---

## Summary

**Firmware 1.3.6** forces iOS to refresh cached accessory metadata showing the camera as video-only. Pair with `ARGUS_AUDIO=1` in LaunchAgent plist. If iOS still negotiates video-only, re-pair accessory or bump to 1.4.0.

**Ready for Mini redeploy + MacBook Home Garage Door retest.**

Do NOT claim success until field retest shows:
1. Audio negotiated (logs show codec, NOT "video-only")
2. pkt_size=1316 (proves 1.3.6 active)
3. RTCP arrived (proves return path works)
4. Video renders with audio in Home app
