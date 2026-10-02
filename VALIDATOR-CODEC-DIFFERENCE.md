# Validator Opus vs Production AAC-ELD: Why Drift May Differ

**Date**: 2026-10-02  
**Context**: All audio sync attempts used validator with Opus, but production uses AAC-ELD

---

## The Difference

### Validator Setup

**From `scripts/validate-av-sync.mjs`**:

```javascript
audio: {
  ssrc: 1,
  payloadType: 111,
  codec: 3,  // Opus
  sampleRateKhz: 24,
  maxBitrateKbps: 24,
  srtpParams: Buffer.alloc(40).toString("base64url"),
}
```

**FFmpeg encoding** (in `buildLiveFfmpegArgs`):
```bash
-c:a libopus
-application lowdelay
-frame_duration 20
-ac 1
-ar 24k
```

**Audio filters tested** (all on Opus path):
- e4cbcc0: No filters (baseline)
- 0bb31e5: `-async 1` flag (deprecated)
- f517acc: `-af aresample=async=1000:first_pts=0`
- 9bdaf46: `-af aresample=async=1:min_hard_comp=0.01`

### Production (iOS HomeKit)

**From field logs** (Mini deployment):

```
HomeKit negotiated ... audio: codec=AAC-eld 24kHz ptype=110 (encoding libfdk_aac/aac_eld)
```

**FFmpeg encoding**:
```bash
-c:a libfdk_aac
-profile:a aac_eld
-flags +global_header
-b:a 24k
```

**Audio filters** (same as validator attempts):
- Same filter values (`aresample=async=...`)
- But applied to AAC-ELD encoder, not Opus

---

## Why This Matters

### Codec Differences

**Opus**:
- Encoder: `libopus` (built-in FFmpeg)
- Frame duration: 20ms packets
- Sample processing: Variable-bitrate, adaptive
- Latency: ~22.5ms algorithmic
- Filter interaction: Opus tolerates timestamp adjustments well

**AAC-ELD** (Enhanced Low Delay):
- Encoder: `libfdk_aac` (external library, Mini has ffmpeg-homebridge)
- Frame duration: Configurable (typically 480 samples @ 24kHz = 20ms)
- Sample processing: Constant-bitrate
- Latency: ~15ms algorithmic
- Filter interaction: AAC-ELD may be more timestamp-sensitive

### Validator May Not Match Production

**Potential divergence**:
1. **Encoder clock handling**: `libopus` vs `libfdk_aac` internal timing
2. **Frame boundaries**: Opus adapts, AAC-ELD fixed-size blocks
3. **Resampler behavior**: `aresample=async=...` may interact differently with AAC-ELD codec
4. **RTP packetization**: Different payload types (111 vs 110), different MTU behavior

**Hypothesis**: Opus validator shows −360 ms/min drift (or −120 / +1101 with async=1). Production AAC-ELD path may differ:
- **Better**: AAC-ELD's fixed framing might stabilize timestamps
- **Worse**: AAC-ELD's stricter timing might amplify drift
- **Same**: Drift is upstream (camera clock mismatch), codec doesn't matter

---

## Evidence Gaps

### What We Know (Opus Validator)

**Baseline** (e4cbcc0, no filters):
- Consistent −360 ms/min (Run1 −360, Run2 −360)
- **Fails gate** (|drift| < 100 ms/min)

**All async attempts** (0bb31e5, f517acc, 9bdaf46):
- Unstable or worse (−258, +240, −1461, −120, +1101)
- **0/2 or 1/2 pass rate**

**Video-only**:
- No drift (no audio to sync)
- **100% pass rate** (guaranteed picture)

### What We Don't Know (AAC-ELD Production)

**No field measurements** of AAC-ELD drift:
- Validator harness can't test AAC-ELD easily (iOS RTP receiver required)
- iOS live stream doesn't report drift (just spinner or picture)
- No telemetry from iOS HomeKit client

**Questions**:
1. Does AAC-ELD production path have same −360 ms/min baseline drift?
2. Do `aresample=async=...` filters behave differently with AAC-ELD?
3. Does iOS tolerate drift better than validator gate (< 100 ms/min)?
4. Is spinner caused by drift magnitude or iOS-specific A/V sync gates?

---

## Actionable Next Steps

### 1. Test AAC-ELD in Validator (Future)

**Challenge**: Validator uses two FFmpeg decoder processes (sender + two receivers). AAC-ELD playback requires:
- `libfdk_aac` decoder (same binary, `ffmpeg-homebridge`)
- RTP demuxing with correct depayloader
- Timestamp extraction from AAC-ELD frames

**Possible**:
```bash
ffmpeg -i srtp://... -c:a copy -f adts pipe:1 | ffmpeg -c:a libfdk_aac -i pipe:0 -f null -
```

**If feasible**: Run baseline (no filters) + async=1 with AAC-ELD to see if drift differs

### 2. Field Test Baseline (e4cbcc0) Without Validator

**Why**: iOS may tolerate −360 ms/min drift (validator gate is arbitrary < 100 ms/min)

**Test**:
1. Deploy e4cbcc0 (no audio filters, baseline −360 drift in validator)
2. Field test Mini: Motion → tap → live stream
3. Observe: Does spinner leave? Does video render?
4. Duration: 2-3 minutes continuous (longer than 40s validator soak)

**Expected**:
- If iOS tolerates drift: **Video renders** (drift exists but iOS doesn't care)
- If iOS gates on drift: **Spinner hangs** (same as original issue)

**Value**: Separates "drift exists" from "drift causes spinner" (validator assumed they're linked)

### 3. iOS Telemetry (If Available)

**Check iOS Console logs**:
```bash
# On Mac with iOS device plugged in
log stream --predicate 'subsystem == "com.apple.Home"' --level debug
```

**Look for**:
- Video/audio RTP arrival timestamps
- Decoder sync warnings
- Buffer underrun / A/V skew messages

**Value**: Direct evidence of iOS A/V sync behavior (vs validator proxy)

---

## Why Video-Only Is Still Right Choice

### Codec Difference Doesn't Change Failure Pattern

**4 attempts, all failed**:
- Baseline: consistent −360 (Opus)
- Async filters: unstable or worse (0/2 or 1/2 pass)

**Even if AAC-ELD differs**:
- Unlikely to be dramatically better (same camera clock mismatch root cause)
- Still unproven (no field measurements)
- More filter experiments = more time without picture

**Video-only**:
- No drift (no audio to sync)
- Guaranteed picture (shippable now)
- Reversible (restore audio later when sync solved)

### Validator Opus Path Was Best Available Proxy

**Why we used Opus**:
- FFmpeg-to-FFmpeg path (repeatable, measurable)
- No iOS device required (automatable harness)
- Same filter logic as AAC-ELD (just different encoder)

**Limitations**:
- Codec difference (Opus vs AAC-ELD)
- No iOS behavior (spinner vs picture is iOS-specific)
- Arbitrary gate (< 100 ms/min is validator choice, not iOS spec)

**Conclusion**: Validator gave us directional evidence (filters don't stabilize drift), but field test is needed to confirm iOS behavior.

---

## Summary

**Validator used Opus**, production uses AAC-ELD. Codecs may handle timestamps differently:
- Opus: adaptive, tolerant
- AAC-ELD: fixed-frame, stricter

**Evidence gaps**:
- No AAC-ELD drift measurements
- No iOS field test of baseline drift (e4cbcc0)
- No iOS telemetry of A/V sync behavior

**Action**:
- Video-only path ships now (unlocks picture)
- Future: Test AAC-ELD in validator OR field test baseline to measure actual drift
- If drift is tolerable: restore audio without filters
- If drift causes spinner: need different sync mechanism (PTS rewrite? Hardware?)

**Video-only still correct**: 4 attempts failed, picture > no picture, shippable now.
