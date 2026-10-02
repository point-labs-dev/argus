# QA Code Verification — Argus 1.3.14

**Branch:** `cursor/restore-homekit-av-quality-1-3-14-d56a`  
**Commit:** `dd16cb1` (on top of 1.3.13 main `dafd2d9`)  
**Date:** 2026-10-02

---

## ✅ QA PASS — All 7 Checkboxes Verified

### 1. ✅ AAC-ELD path preserved from 1.3.13

```bash
$ grep -n "AAC.ELD\|isAacEld\|libfdk_aac" src/homekit.ts | head -5
93:// FFmpeg transcode to the resolution/bitrate HomeKit negotiates. Audio: AAC-ELD when
94:// negotiated (requires libfdk_aac — use ffmpeg-homebridge via ARGUS_FFMPEG), else Opus.
331:  // Audio codec: encode what HomeKit negotiated. AAC-ELD requires libfdk_aac
336:  const isAacEld = audio.codec === AudioStreamingCodecType.AAC_ELD;
337:  const audioCodecArgs = isAacEld
```

**Status:** PRESENT (lines 93, 94, 331, 336, 337, 711, 983, 988)

---

### 2. ✅ once-safe prepareStream guard preserved

```bash
$ grep -n "answered.*false\|answered.*true" src/homekit.ts | head -5
567:    let answered = false;
573:      answered = true;
858:    let answered = false;
861:      answered = true;
```

**Status:** PRESENT (prepareStream line 567, reconfigureStream line 858)

---

### 3. ✅ getHapBindAddress + ARGUS_HAP_BIND preserved

```bash
$ grep -n "getHapBindAddress\|ARGUS_HAP_BIND" src/homekit.ts | head -5
8: * Prefers ARGUS_HAP_BIND env var, else first non-internal IPv4 (typically en0 on Mac).
15:export function getHapBindAddress(): string | undefined {
16:  if (process.env.ARGUS_HAP_BIND) {
17:    const envValue = process.env.ARGUS_HAP_BIND;
30:      console.warn(`[argus] ARGUS_HAP_BIND="${envValue}" is not a valid IP and interface not found; using auto-detect`);
```

**Status:** PRESENT (lines 8, 15, 16, 17, 30)

---

### 4. ✅ wifi ladder + ARGUS_LIVE_CAP=854 preserved

```bash
$ grep -n "wifi.*854\|ARGUS_LIVE_CAP.*854\|maxWidth.*854" src/homekit.ts | head -5
703:    // Force cap here even if Home asks 720p. ARGUS_LIVE_CAP env var overrides (default 854).
704:    const maxWidth = process.env.ARGUS_LIVE_CAP ? parseInt(process.env.ARGUS_LIVE_CAP, 10) : 854;
936:  // - "wifi" (default Oct+): [854x480, 640x480, 640x360] WiFi-friendly June pattern
1128: * buildCameraControllerOptions now defaults to "wifi" ladder [854x480, 640x480, 640x360] instead
1140: * maxWidth=854 (June Garage Door working pattern) regardless of negotiation. ARGUS_LIVE_CAP env
```

**Status:** PRESENT (lines 703, 704, 936, 1128, 1140)

---

### 5. ✅ localaddr RTCP preserved

```bash
$ grep -n "localaddr\|localAddress" src/homekit.ts | head -5
9: * Scrypted/homebridge pattern: HAP advertise + ffmpeg localaddr + RTCP bind must match
111:   * Local IP address for ffmpeg SRTP egress (localaddr=). On dual-NIC systems,
113:   * Scrypted/homebridge pattern: HAP bind + ffmpeg localaddr + RTCP bind = same IP.
115:  localAddress?: string;
159: * 854×480 (mush). Research confirms: floors are the QUALITY fix, localaddr+RTCP
```

**Status:** PRESENT (lines 9, 111, 113, 115, 159, 318, 370)  
**Pattern:** `localaddr=<en0_IPv4>` in SRTP URLs (NOT localrtpport — that was field-failed 1.3.3)

---

### 6. ✅ LAN bitrate floors restored (NEW)

```bash
$ grep -n "pixels >= 1920\|pixels >= 1280\|pixels >= 640" src/homekit.ts
170:    pixels >= 1920 * 1080 ? 3000 :
171:    pixels >= 1280 * 720 ? 2000 :
172:    pixels >= 640 * 360 ? 600 : 300;
```

**Status:** ADDED (lines 170-172 in `effectiveBitrateKbps`)  
**Floors:**
- 1080p: 3000k
- 720p: 2000k
- ≥640×360: 600k
- else: 300k

**Delta:** 600k@854×480 >> 299k@854×480 (1.3.13 mush fix)

---

### 7. ✅ Tests pass + Firmware bumped

```bash
$ npm test
 Test Files  9 passed (9)
      Tests  79 passed (79)

$ grep "ARGUS_FIRMWARE_REVISION" src/homekit.ts
export const ARGUS_FIRMWARE_REVISION = "1.3.14";
```

**Status:** 79/79 tests PASS (updated for floors behavior)  
**Firmware:** 1.3.13 → 1.3.14

---

## Build Status

```bash
$ npm run build
✔ tsc -p tsconfig.json
```

**Status:** CLEAN (no errors)

---

## Summary

**All 1.3.13 unlocks preserved:**
- AAC-ELD encoding path ✅
- once-safe prepareStream callback guard ✅
- getHapBindAddress / ARGUS_HAP_BIND en0→IP ✅
- wifi ladder + ARGUS_LIVE_CAP=854 defensive clamp ✅
- localaddr RTCP pattern (NO localrtpport) ✅

**New 1.3.14 changes:**
- Restored LAN bitrate floors (PRIMARY QUALITY FIX) ✅
- Firmware 1.3.13 → 1.3.14 ✅

**Expected outcome:**
- Sharpness improvement: 600k@854×480 >> 299k@854×480
- Audio smooth (AAC-ELD at sufficient bitrate)
- Mac paint ≥16s preserved (1.3.13 localaddr+RTCP longevity)

---

## Deployment Notes

**Required env vars for Mini plist:**
- `ARGUS_LIVE_MAIN_SOURCE=1` (standalone ≥720p sources main stream)
- `ARGUS_AUDIO=1` (if not already enabled)
- `ARGUS_HAP_BIND=en0` (wired IP for dual-NIC systems)

**Field test criteria:**
1. iPhone/iPad: Sharp video + smooth audio at 854×480 (vs 1.3.13 mush)
2. MacBook: Paint ≥16s continuous (preserve 1.3.13 longevity)

**Rollback:** If Mac paint <16s, revert to 1.3.13 `dafd2d9`

---

**QA Status:** ✅ PASS — All unlocks present, floors restored, tests pass, clean build
