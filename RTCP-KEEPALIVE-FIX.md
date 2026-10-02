# RTCP Keepalive Fix (Firmware 1.3.3)

## Problem

**Symptom**: HomeKit live view showed "No Response" after exactly 30 seconds (~900 frames at 30fps), despite:
- ✅ Video encoding healthy (Baseline H.264, dump_extra, 1s IDRs)
- ✅ prepareStream video-only fix applied (no audio advertised)
- ✅ First frame within 1.3s
- ✅ Steady 30fps encoding for full 30 seconds
- ✅ HomeKit receiving video (field evidence showed RTCP packets sent back from iOS)

**Root cause**: HomeKit has a **30-second RTCP timeout**. If the accessory doesn't properly exchange RTCP keepalive packets with HomeKit, the controller kills the stream at exactly 30 seconds.

## Technical Details

### The Bug

Our ffmpeg command used:

```
srtp://192.168.1.50:50000?rtcpport=50000&localrtcpport=60000&pkt_size=564
```

According to [ffmpeg RTP protocol docs](https://ffmpeg.org/ffmpeg-protocols.html#rtp):

> If localrtpport (the local RTP port) is not set any available port will be used for the local RTP and RTCP ports.

With only `localrtcpport` specified:
- **RTP** sent from **random source port** (changes every session)
- **RTCP** sent from our specified port (60000)

HomeKit couldn't correlate RTCP packets with the RTP stream because they came from different source ports. After 30 seconds without valid RTCP, HomeKit killed the stream.

### The Fix

Change `localrtcpport` to `localrtpport`:

```
srtp://192.168.1.50:50000?rtcpport=50000&localrtpport=60000&pkt_size=564
```

Now:
- **RTP** sent from port 60000 (bound)
- **RTCP** sent from port 60001 (RTP port + 1, per ffmpeg default)
- HomeKit can properly correlate and receive RTCP keepalive

## Evidence

### Field Test (2026-10-02)

Mini at `600ca5d` (firmware 1.3.2 with prepareStream fix):

```
live_session_start
live_session_first_frame ~1.3s
ffmpeg: frame=928 fps=30 ...
live_session_stop (30s elapsed)
```

Exactly 30 seconds = 900 frames at 30fps = **RTCP timeout**

### Prior Art

This is a **known issue** fixed by others:

1. **Home Assistant PR #99989**: ["Make homekit RTP/RTCP source ports more deterministic"](https://github.com/home-assistant/core/pull/99989)
   - Changed from `localrtcpport` to `localrtpport`
   - Fix motivation: "Using a randomized RTP port makes it harder to setup firewall"
   - **Same root cause**: RTCP correlation failure

2. **Ring Homebridge issue #479**: ["Camera stream stop in home app after 30 sec"](https://github.com/dgreif/ring/issues/479)
   - Quote: "the RTCP ports aren't properly latching with the media servers, so RTCP from Ring isn't making it back to HomeKit. HomeKit must have a 30 second timeout if it does not receive RTCP"
   - **Same 30-second timeout**

3. **Scrypted issue #228**: ["streaming to HomeKit times out after 30 seconds"](https://github.com/koush/scrypted/issues/228)
   - Error: `[HomeKit]: HomeKit Streaming RTCP timed out. Terminating Streaming.`
   - Fix: Firewall allowing UDP for RTP/RTCP ports

## Implementation

### Code Changes

**`src/homekit.ts`**:

```typescript
// Before (broken):
`srtp://${targetAddress}:${video.port}?rtcpport=${video.port}&localrtcpport=${video.localRtcpPort}&pkt_size=...`

// After (fixed):
`srtp://${targetAddress}:${video.port}?rtcpport=${video.port}&localrtpport=${video.localRtcpPort}&pkt_size=...`
```

Applied to both video and audio SRTP URLs.

### Firmware Version

Bumped to **1.3.3** to force iOS to re-negotiate streaming parameters. HomeKit caches streaming configuration; firmware updates trigger metadata refresh.

## Deployment

### Pre-deploy Checklist

1. ✅ Tests pass (`npm test`)
2. ✅ Firmware version bumped (1.3.2 → 1.3.3)
3. ✅ Code comments explain the fix
4. ✅ ffmpeg command logs show `localrtpport` (not `localrtcpport`)

### Deploy to Mini

```bash
# On Mini
cd argus
git pull origin cursor/fix-live-feed-hang-18ad
npm run build
sudo launchctl unload ~/Library/LaunchAgents/argus.plist
sudo launchctl load ~/Library/LaunchAgents/argus.plist

# Wait ~10s for startup
tail -f ~/.cache/argus/argus-serve.log
```

### Verification (Garage Door camera)

1. **Pair**: Open Home app → "Garage Door" → verify pairing completes
2. **Check firmware**: Settings → verify iOS sees "Firmware 1.3.3"
3. **Test live view**:
   - Open live feed
   - Watch for > 30 seconds
   - ✅ **PASS**: Video renders continuously, no "No Response"
   - ❌ **FAIL**: "No Response" at ~30s (RTCP still broken)

4. **Check logs** (`tail -f ~/.cache/argus/argus-serve.log`):
   ```
   ffmpeg ... srtp://...?rtcpport=50000&localrtpport=60000&pkt_size=564
   live_session_first_frame
   [Stream continues > 30s with no STOP]
   ```

### Expected Behavior

- ✅ Live view opens within 2s
- ✅ Video renders continuously
- ✅ Stream stays alive > 30s (test up to 2 minutes)
- ✅ No "No Response" message
- ✅ Clean teardown when closing Home app

## Rollback

If the fix doesn't work, revert to previous commit:

```bash
git checkout 600ca5d  # Previous known state (firmware 1.3.2)
npm run build
sudo launchctl unload ~/Library/LaunchAgents/argus.plist
sudo launchctl load ~/Library/LaunchAgents/argus.plist
```

## Next Steps After Fix

If video-only with RTCP fix **works**:
1. Ship as production video-only configuration
2. Document as stable interim (audio can be added later if needed)
3. Roll out to all 7 cameras

If still fails:
1. Capture packet dump (`tcpdump -i en0 udp port 60000-60001`)
2. Verify RTCP packets are actually being sent/received
3. Check for firewall/NAT issues on the network
4. Consider whether video-only is fundamentally unsupported by HAP

## References

- [FFmpeg RTP Protocol Docs](https://ffmpeg.org/ffmpeg-protocols.html#rtp)
- [Home Assistant PR #99989](https://github.com/home-assistant/core/pull/99989)
- [Ring issue #479](https://github.com/dgreif/ring/issues/479)
- [Scrypted issue #228](https://github.com/koush/scrypted/issues/228)
