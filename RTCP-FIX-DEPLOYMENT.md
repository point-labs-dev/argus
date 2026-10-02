# RTCP Keepalive Fix Deployment (Firmware 1.3.3)

**Target**: Mini (Garage Door camera)  
**Commit**: `91e9693` (Fix HomeKit RTCP keepalive timeout)  
**Date**: 2026-10-02

## What This Fixes

HomeKit's 30-second RTCP timeout that was killing video-only streams. Changed ffmpeg from `localrtcpport` to `localrtpport` so HomeKit can properly receive RTCP keepalive packets.

**Previous failure pattern**:
- Stream starts, first frame at ~1.3s
- Encodes steadily for exactly 30 seconds (~900 frames at 30fps)
- HomeKit kills stream: "No Response"
- Same as Home Assistant PR #99989 and Ring issue #479

## Pre-Deployment Verification

On development machine:

```bash
cd /workspace
git log --oneline -1
# Should show: 91e9693 Fix HomeKit RTCP keepalive timeout (firmware 1.3.3)

npm test
# All 77 tests should pass

grep "ARGUS_FIRMWARE_REVISION" src/homekit.ts
# Should show: export const ARGUS_FIRMWARE_REVISION = "1.3.3";

grep "localrtpport" src/homekit.ts | head -2
# Should show ffmpeg SRTP URLs using localrtpport (not localrtcpport)
```

✅ **Checklist**:
- [ ] Commit SHA matches `91e9693`
- [ ] Tests pass (77/77)
- [ ] Firmware version is 1.3.3
- [ ] Code uses `localrtpport` in SRTP URLs

## Deployment Steps

### 1. Deploy to Mini

SSH to Mini (192.168.1.9):

```bash
ssh mac-mini-admin@192.168.1.9

cd ~/Documents/argus
git fetch origin
git checkout cursor/fix-live-feed-hang-18ad
git pull origin cursor/fix-live-feed-hang-18ad

# Verify commit
git log --oneline -1
# Should show: 91e9693 Fix HomeKit RTCP keepalive timeout (firmware 1.3.3)

# Build
npm run build

# Check build artifacts
ls -lh dist/homekit.js
grep "1.3.3" dist/homekit.js
```

✅ **Verify**:
- [ ] Git SHA is `91e9693`
- [ ] Build succeeded (dist/ populated)
- [ ] dist/homekit.js contains "1.3.3"

### 2. Restart Argus Service

```bash
sudo launchctl unload ~/Library/LaunchAgents/argus.plist
sleep 2
sudo launchctl load ~/Library/LaunchAgents/argus.plist
sleep 10

# Verify service started
tail -20 ~/.cache/argus/argus-serve.log
```

✅ **Verify logs show**:
- [ ] `go2rtc ready`
- [ ] `Argus server listening on port 52839`
- [ ] `Garage Door paired` (or `published`)
- [ ] Firmware 1.3.3 in startup logs

### 3. Test Pairing (if needed)

If Garage Door shows "Not Responding" after restart:

**Remove from Home app**:
1. Open Home app on iPhone/Mac
2. Long-press Garage Door tile
3. Settings → Remove Accessory → Remove

**Re-pair**:
```bash
# On Mini, check logs for pairing code
tail -f ~/.cache/argus/argus-serve.log | grep -i "setup"
```

In Home app:
1. Add Accessory → More Options
2. Select "Garage Door"
3. Enter pairing code from logs
4. Accept security warning (uncertified)

### 4. Field Test

**Live view test** (main validation):

1. Open Home app on iPhone
2. Tap Garage Door camera
3. Live view should open within 2 seconds
4. **Watch for > 60 seconds**
   - ✅ **PASS**: Video renders continuously, no "No Response"
   - ❌ **FAIL**: "No Response" at ~30 seconds (RTCP still broken)

**Check firmware**:
- Settings → Firmware → Should show "1.3.3"
- If still shows 1.3.2, iOS hasn't detected the update yet (wait 30s and check again)

**Monitor logs during test**:

```bash
tail -f ~/.cache/argus/argus-serve.log
```

Look for:
```
HomeKit negotiated video: ... profile=baseline ...
ffmpeg ... srtp://...?rtcpport=50000&localrtpport=XXXXX&pkt_size=564
live_session_first_frame
[Stream continues > 30 seconds with no live_session_stop]
```

✅ **Expected telemetry**:
- `live_session_start` when opening live view
- `live_session_first_frame` within 2 seconds
- **NO** `live_session_stop` until you close the Home app
- Stream should stay alive 60+ seconds

### 5. Extended Soak Test

Leave live view open for 5 minutes to verify stability:

```bash
# Monitor CPU/memory during long stream
top -pid $(pgrep -f argus-serve) -stats pid,command,cpu,mem

# Check ffmpeg is still running
ps aux | grep ffmpeg | grep -v grep
```

✅ **Success criteria**:
- [ ] Stream renders for 5+ minutes without "No Response"
- [ ] CPU usage stable (ffmpeg ~30-50% typical for transcoding)
- [ ] No ffmpeg crashes in logs
- [ ] Clean teardown when closing Home app (live_session_stop)

## Expected vs. Previous Behavior

### Before (firmware 1.3.2, commit 600ca5d)

```
[22:26:45] live_session_start
[22:26:46] live_session_first_frame (~1.3s latency)
[22:26:46] ffmpeg ... localrtcpport=60000 ...  ← WRONG
[22:27:15] ffmpeg: frame=928 fps=30 ...
[22:27:16] live_session_stop  ← 30 seconds elapsed
[Home app: spinner → "No Response"]
```

### After (firmware 1.3.3, commit 91e9693)

```
[HH:MM:SS] live_session_start
[HH:MM:SS] live_session_first_frame (~1.3s latency)
[HH:MM:SS] ffmpeg ... localrtpport=60000 ...  ← FIXED
[Stream continues > 60 seconds]
[live_session_stop only when user closes Home app]
[Home app: video renders continuously]
```

## Rollback Plan

If test **fails** (still "No Response" at 30s):

```bash
cd ~/Documents/argus
git checkout 600ca5d  # Previous commit (firmware 1.3.2)
npm run build
sudo launchctl unload ~/Library/LaunchAgents/argus.plist
sudo launchctl load ~/Library/LaunchAgents/argus.plist
```

## Troubleshooting

### "No Response" still occurs at 30s

**Possible causes**:
1. **iOS didn't detect firmware update**: Wait 60s, check Settings → Firmware
2. **Firewall blocking RTCP**: Check firewall rules on Mini or router
3. **Network issue**: Try from different iOS device or network
4. **HAP doesn't support video-only**: May need to restore audio path

**Debug steps**:
```bash
# Capture RTCP packets during test
sudo tcpdump -i en0 'udp and (portrange 50000-65000)' -w rtcp-test.pcap

# Check for RTCP traffic in both directions
tcpdump -r rtcp-test.pcap -n | grep "192.168.1.50"  # iOS controller
```

### Stream never starts (timeout before first frame)

- Check go2rtc is serving RTSP: `curl http://127.0.0.1:1984/api/streams`
- Verify camera reachable: `ffmpeg -i rtsp://... -frames:v 1 test.jpg`
- Check Argus logs for `live_session_start` → `live_session_first_frame`

### Firmware still shows 1.3.2 after deploy

iOS caches firmware. Force refresh:
1. Remove Garage Door from Home app
2. Wait 30 seconds
3. Re-pair (will read new firmware during pairing)

## Success Criteria Summary

✅ **Fix is working if**:
1. Live view opens within 2 seconds
2. Video renders continuously for 60+ seconds
3. No "No Response" message at 30-second mark
4. Firmware shows 1.3.3 in Home app
5. Logs show `localrtpport` in ffmpeg command
6. `live_session_stop` only when user closes app

❌ **Fix failed if**:
1. "No Response" at ~30 seconds (same as before)
2. Stream dies before 30 seconds (new regression)
3. Firmware still shows 1.3.2 (iOS didn't detect update)

## Next Steps After Successful Deploy

If RTCP fix **works** (stream > 60s without "No Response"):

1. **Document as stable**: Update main README with video-only as production config
2. **Roll out to other cameras**: Apply to all 7 cameras if they're also video-only
3. **PR ready**: This fix is mergeable once field-validated

If RTCP fix **fails**:

1. Investigate with packet capture (tcpdump)
2. Test with audio restored (ARGUS_AUDIO=1) to validate RTCP path works with audio
3. Consider whether video-only is unsupported by HAP spec
4. Look at alternative RTCP implementations (manual RTCP sender?)

## Reference Documentation

- [RTCP-KEEPALIVE-FIX.md](./RTCP-KEEPALIVE-FIX.md) - Technical details
- [VIDEO-ONLY-PREPARESTREAM-FIX.md](./VIDEO-ONLY-PREPARESTREAM-FIX.md) - Previous fix
- [Home Assistant PR #99989](https://github.com/home-assistant/core/pull/99989)
- [Ring issue #479](https://github.com/dgreif/ring/issues/479)
- [FFmpeg RTP docs](https://ffmpeg.org/ffmpeg-protocols.html#rtp)
