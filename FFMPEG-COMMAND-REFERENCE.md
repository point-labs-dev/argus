# FFmpeg Command Reference — f22f0eb In-Band SPS/PPS

**What HomeKit will see**: Live H.264 stream with in-band SPS/PPS on every keyframe

---

## Example: Garage Door 1280×720@30fps 299k (Video-Only)

```bash
ffmpeg \
  -hide_banner \
  -loglevel error \
  -progress pipe:2 \
  -fflags +discardcorrupt+genpts+nobuffer \
  -flags low_delay \
  -probesize 100000 \
  -analyzeduration 50000 \
  -rtsp_transport tcp \
  -err_detect ignore_err \
  -i rtsp://127.0.0.1:8554/garage-door-sub \
  \
  -an \
  -c:v libx264 \
  -preset faster \
  -tune zerolatency \
  -profile:v high \
  -level 4.0 \
  -pix_fmt yuv420p \
  -color_range tv \
  -r 30 \
  -vf scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2 \
  -bf 0 \
  -g 120 \
  -keyint_min 60 \
  -force_key_frames expr:eq(t,0)+gte(t,n_forced*2) \
  -crf 18 \
  -maxrate 299k \
  -bufsize 299k \
  -bsf:v dump_extra=freq=keyframe \
  \
  -payload_type 99 \
  -ssrc 12345678 \
  -f rtp \
  -srtp_out_suite AES_CM_128_HMAC_SHA1_80 \
  -srtp_out_params AQEBAQEBAQEBAQEBAQEBAQICAgICAgICAgICAgIC \
  srtp://192.168.1.100:50000?rtcpport=50000&localrtcpport=60000&pkt_size=564
```

---

## Key Arguments (What Fixes the Spinner)

### In-Band Parameter Sets (NEW in f22f0eb)

```bash
-bsf:v dump_extra=freq=keyframe
```

**What it does**: Injects H.264 SPS/PPS before every keyframe (IDR)

**Why it matters**:
- **Before**: SPS/PPS only in initial extradata → if packets drop, decoder stuck
- **After**: SPS/PPS before every IDR → decoder can recover from drops

**Overhead**: ~100 bytes per keyframe (every 2s @ ≥720p = ~50 bytes/s = 0.4 kbps)

### Early IDR (Already Present)

```bash
-force_key_frames expr:eq(t,0)+gte(t,n_forced*2)
```

**What it does**: Force IDR at t=0, then every 2s (for ≥720p)

**Why it matters**: HomeKit needs immediate decodable frame, can't wait for natural keyframe

### Exact Dimensions (Already Present)

```bash
-vf scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2
```

**What it does**: Scale 4:3 source (2560×1920) to fit 16:9 box (1280×720), pad with black bars

**Why it matters**: Home enforces exact negotiated dimensions (field 2026-10-01: 960×720 ≠ 1280×720 → blank)

### Bitrate Honor (Already Present)

```bash
-maxrate 299k -bufsize 299k
```

**What it does**: Cap bitrate to negotiated 299k (VBV 1x)

**Why it matters**: Home enforces bitrate limit (exceeding causes session kill)

### Video-Only (Already Present, ARGUS_AUDIO=0)

```bash
-an  # No audio input
(no -vn, no -c:a, no audio RTP destination)
```

**What it does**: Video-only mode (no audio encoding, no audio RTP)

**Why it matters**: Audio sync unsolved (4 attempts, all failed); video-only ships picture

---

## What Each Argument Does

### Input Handling

```bash
-fflags +discardcorrupt+genpts+nobuffer  # Resilience for corrupt go2rtc input
-flags low_delay                         # Low-latency mode (no buffering)
-probesize 100000                        # Fast codec detection (100KB)
-analyzeduration 50000                   # Fast stream analysis (50ms)
-rtsp_transport tcp                      # TCP for reliable RTSP (no UDP drops)
-err_detect ignore_err                   # Don't abort on minor decode errors
-i rtsp://127.0.0.1:8554/garage-door-sub # Sub stream (1296p/H.264, always available)
```

### Video Encoding

```bash
-an                       # No audio input (video-only mode)
-c:v libx264              # Software H.264 encoder (compatible, quality)
-preset faster            # Encoder effort (faster = 10% better than veryfast @ ≥720p)
-tune zerolatency         # No B-frames, immediate encode (HomeKit requirement)
-profile:v high           # H.264 profile (honors negotiated, usually High @ 720p)
-level 4.0                # H.264 level (honors negotiated)
-pix_fmt yuv420p          # Pixel format (HomeKit requirement)
-color_range tv           # TV color range (16-235 vs full 0-255)
-r 30                     # Frame rate (negotiated, usually 30fps)
```

### Scaling and Padding

```bash
-vf scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2
#   scale to fit within 1280×720 (preserves aspect, never exceeds)
#   force_divisible_by=2 (H.264 requirement: even dimensions)
#   pad to exact 1280×720 (centers with black bars)
```

**Example** (4:3 source → 16:9 box):
- Input: 2560×1920 (4:3)
- Scale: 960×720 (fits height, preserves 4:3)
- Pad: 1280×720 (adds 160px black bars left/right)

### Keyframe Strategy

```bash
-bf 0                                    # No B-frames (HomeKit requirement)
-g 120                                   # GOP size 120 frames (4s @ 30fps)
-keyint_min 60                           # Min keyframe interval 60 frames (2s @ 30fps)
-force_key_frames expr:eq(t,0)+gte(t,n_forced*2)
#   eq(t,0) → IDR at t=0 (immediate decodable frame)
#   gte(t,n_forced*2) → IDR every 2s (periodic recovery points)
```

### Rate Control

```bash
-crf 18                  # Quality target (18 = high quality for ≥720p)
-maxrate 299k            # Max bitrate (negotiated, honors Home's request)
-bufsize 299k            # VBV buffer (1x maxrate, tight control)
```

**Capped-CRF behavior**:
- Easy scenes → undershoot 299k (higher quality)
- Motion → use full 299k (maintain quality)
- Never exceed 299k (Home enforces limit)

### Bitstream Filter (NEW)

```bash
-bsf:v dump_extra=freq=keyframe
```

**Injects SPS/PPS before every keyframe**:
- SPS (Sequence Parameter Set) — frame dimensions, profile, level
- PPS (Picture Parameter Set) — entropy coding, slice groups
- freq=keyframe — inject before every IDR (not every packet)

**Before** (out-of-band only):
```
[extradata: SPS+PPS]
[IDR frame 1 @ t=0]    ← If these packets drop, decoder stuck
[P frame 2]
[P frame 3]
...
[IDR frame 61 @ t=2s]  ← Still no SPS/PPS if initial dropped
```

**After** (in-band per keyframe):
```
[IDR frame 1 @ t=0 with SPS+PPS]  ← Decoder can start
[P frame 2]
[P frame 3]
...
[IDR frame 61 @ t=2s with SPS+PPS] ← Decoder can recover
```

### RTP Output

```bash
-payload_type 99                         # RTP payload type (negotiated with Home)
-ssrc 12345678                           # RTP SSRC (session identifier)
-f rtp                                   # RTP output format
-srtp_out_suite AES_CM_128_HMAC_SHA1_80  # SRTP encryption suite
-srtp_out_params AQ...IC                 # SRTP key+salt (base64, negotiated)
srtp://192.168.1.100:50000?rtcpport=50000&localrtcpport=60000&pkt_size=564
#   192.168.1.100:50000 → Home device IP + video RTP port
#   rtcpport=50000 → RTCP port (usually same as RTP for NAT)
#   localrtcpport=60000 → Our RTCP port
#   pkt_size=564 → Small packets for ≥720p (WiFi resilience)
```

---

## Comparison: Before vs After

### 72a041a (Before In-Band SPS/PPS)

```bash
ffmpeg ... \
  -c:v libx264 -profile:v high -level 4.0 \
  -force_key_frames expr:eq(t,0)+gte(t,n_forced*2) \
  -maxrate 299k -bufsize 299k \
  -f rtp srtp://...
# SPS/PPS only in initial extradata → spinner hang
```

### f22f0eb (After In-Band SPS/PPS)

```bash
ffmpeg ... \
  -c:v libx264 -profile:v high -level 4.0 \
  -force_key_frames expr:eq(t,0)+gte(t,n_forced*2) \
  -maxrate 299k -bufsize 299k \
  -bsf:v dump_extra=freq=keyframe \  # ← NEW
  -f rtp srtp://...
# SPS/PPS before every IDR → robust unlock
```

---

## Field Verification (What to Check)

### Boot Log (/tmp/argus.log)

```
2026-10-02T...Z [argus Garage Door] HomeKit negotiated video: 1280x720@30 profile=high level=4.0 ptype=99 asked=299k serving=299k mtu=1378 mode=transcode source=rtsp://127.0.0.1:8554/garage-door-sub; audio: none (video-only)

2026-10-02T...Z [argus Garage Door] ffmpeg ffmpeg -hide_banner -loglevel error -progress pipe:2 ... -bsf:v dump_extra=freq=keyframe ... srtp://...
```

**Look for**:
- ✅ `audio: none (video-only)` — ARGUS_AUDIO=0 working
- ✅ `profile=high` (or baseline/main) — negotiated profile
- ✅ `asked=299k serving=299k` — bitrate honored
- ✅ `source=...garage-door-sub` — correct sub stream
- ✅ `-bsf:v dump_extra=freq=keyframe` — in-band SPS/PPS active

### First Frame Timing

```
2026-10-02T...Z [argus Garage Door] HomeKit START session abc123
2026-10-02T...Z [argus Garage Door] HomeKit negotiated ...
2026-10-02T...Z [argus Garage Door] ffmpeg ...
2026-10-02T...Z [argus Garage Door] HomeKit first frame session abc123 (elapsed: 0.7s)
```

**Expected**: `first frame ... (elapsed: 0.7s)` — fast encode working

### Success Path

```
2026-10-02T...Z [argus Garage Door] HomeKit START session abc123
2026-10-02T...Z [argus Garage Door] HomeKit first frame ... (elapsed: 0.7s)
(user sees video render)
(session stays alive, no STOP until user closes)
```

### Failure Path (If Still Hangs)

```
2026-10-02T...Z [argus Garage Door] HomeKit START session abc123
2026-10-02T...Z [argus Garage Door] HomeKit first frame ... (elapsed: 0.7s)
(user sees spinner hang)
2026-10-02T...Z [argus Garage Door] HomeKit STOP session abc123 (reason: controller closed)
```

**Capture**: Full session log from START → first frame → STOP

---

**Ready**: Copy-paste this command into Mini logs verification  
**Next**: Deploy f22f0eb, tap Garage Door, check if picture unlocks
