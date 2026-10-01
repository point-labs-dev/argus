# Field Test Fix — First-Frame Telemetry + Corrupt Input Resilience

**Branch**: `cursor/fix-live-feed-hang-18ad`  
**PR**: https://github.com/point-labs-dev/argus/pull/3 (draft)  
**Latest commit**: dba40c8

---

## Field Evidence (Mini SHA 12f28ca)

Peter's phone: "still not loading" after PR #3 first deployment.

**Logs showed**:
- ✅ HAP negotiate succeeds every time
- ✅ `live_session_start` fires
- ❌ `live_session_first_frame` **NEVER** (0 events across all sessions)
- ❌ Every session STOP after 1.3-30s without first frame + SIGKILL
- ❌ Flood of `Error submitting packet to decoder: Invalid data` during Backyard Right live

---

## Root Causes Verified

### 1. Broken First-Frame Telemetry ⚠️

**Hypothesis**: First-frame hook regex `/frame=\s*[1-9]/` searches for FFmpeg status lines, but `-loglevel error` suppresses them.

**Verified**: 
```bash
# With -loglevel error (no frame status)
$ ffmpeg -loglevel error -f lavfi -i testsrc=duration=1 -f null - 2>&1
(empty)

# With -progress pipe:2 (structured progress output)
$ ffmpeg -progress pipe:2 -loglevel error -f lavfi -i testsrc=duration=1 -f null - 2>&1
frame=0
fps=0.00
...
frame=1    <- DETECTABLE
```

**Fix**: 
- Added `-progress pipe:2` to FFmpeg args (outputs progress to stderr regardless of loglevel)
- Updated regex to `/^frame=([1-9]\d*)$/m` to match progress format (`frame=N` on its own line)

### 2. Corrupt Input from go2rtc RTSP ⚠️

**Evidence**: Logs show `Error submitting packet to decoder: Invalid data` — go2rtc sends bad h264 packets, FFmpeg aborts decode.

**Fix**: Added error resilience flags:
- `-fflags +discardcorrupt+genpts` — discard corrupt packets, regenerate timestamps
- `-err_detect ignore_err` — don't abort on decode errors

### 3. Pre-Warm Failures ✅

Already fixed in f59705e with `warmStream()` retry logic (3× exponential backoff).

---

## What Changed

### FFmpeg Args (Before → After)

```diff
- -loglevel error -fflags nobuffer -flags low_delay
+ -loglevel error -progress pipe:2 \
+ -fflags +discardcorrupt+genpts+nobuffer -flags low_delay \
+ -err_detect ignore_err
```

### First-Frame Detection (Before → After)

```diff
- // Broken: searches for status line "frame= 42 fps=..." which -loglevel error suppresses
- if (/frame=\s*[1-9]/.test(text)) { ... }

+ // Fixed: matches progress format "frame=1" (always emitted via -progress pipe:2)
+ if (/^frame=([1-9]\d*)$/m.test(text)) { ... }
```

---

## How -progress Works

**FFmpeg progress output** (to stderr via pipe:2):
```
frame=0           <- Pre-encode state
fps=0.00
bitrate=N/A
...
progress=continue

frame=1           <- First encoded frame (DETECT THIS)
fps=0.00
bitrate=2048.0kbits/s
...
progress=continue
```

**Key**: Progress is emitted **regardless of -loglevel** (unlike frame status lines which require info/verbose).

---

## Expected Behavior After Fix

### Good Session
```
ARGUS_TELEMETRY: {"event":"live_session_start"}
(~500-1500ms later)
ARGUS_TELEMETRY: {"event":"live_session_first_frame"}
```

### Corrupt Input Handling
```
ffmpeg: Error submitting packet to decoder: Invalid data
(stream continues instead of aborting)
```

### Progress in Logs
```
ffmpeg: frame=0
ffmpeg: fps=0.00
ffmpeg: progress=continue
ffmpeg: frame=1
```

---

## Tests

All pass (69/69):
```bash
$ npm test
Test Files  9 passed (9)
Tests  69 passed (69)
```

Updated `tests/homekit.test.ts` expectations for:
- `-progress pipe:2` in args
- `-fflags +discardcorrupt+genpts+nobuffer` instead of `-fflags nobuffer`
- `-err_detect ignore_err` in args

---

## Verification Steps (Mini)

```bash
cd ~/Projects/argus
git pull origin cursor/fix-live-feed-hang-18ad
npm install && npm run build

launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist
```

**Test**:
1. Trigger motion
2. Tap notification within 10s
3. Check logs for `live_session_first_frame` event (should now appear)
4. Measure latency: `live_session_start` → `live_session_first_frame`

**Expected**: 500-1500ms (was never — broken hook)

---

## Discarded Hypotheses

❌ **Dual-homed routing** — Field logs showed ESTABLISHED TCP to all HAP ports; not a routing issue  
❌ **Pre-warm still failing** — Already fixed with retry logic; HTTP 500s handled  
❌ **Need producer verification** — Removed as no-op; snapshot success = prebuffer ready

---

## Summary for Peter/Home Manager

**What was wrong**:
1. First-frame telemetry hook was broken (never fired because it searched for output FFmpeg doesn't emit at loglevel error)
2. FFmpeg aborted on corrupt input from go2rtc RTSP

**What's fixed**:
1. First-frame detection now uses `-progress pipe:2` (works with any loglevel)
2. Error resilience flags let FFmpeg discard corrupt packets and continue

**What to measure**:
- Does `live_session_first_frame` now appear in telemetry? (should be yes)
- What's the latency? (target: 500-1500ms)
- Do sessions still hang? (should be no, or much less frequent)

**PR remains draft** — awaiting field test confirmation.
