# Audio Codec Bug Postmortem — String vs Number Type Mismatch

**Date**: 2026-10-01  
**Bug introduced**: ed79c0b (first audio codec fix attempt)  
**Bug fixed**: [current commit]  
**Duration**: ~20 minutes (caught in first field test)

---

## Field Evidence (SHA 6a8a55c, Mini, ~08:32 ET)

**Observed**:
```
HomeKit negotiated ... audio: codec=AAC-eld 16kHz ... (will encode AAC-eld)
ffmpeg ... -c:a libopus -application lowdelay -frame_duration 20 ...
```

**What was wrong**:
- Log said "will encode AAC-eld"
- Actual ffmpeg command had `-c:a libopus`
- Peter still saw blank screen in Home

**Critical clue**: Log printed the *requested* codec but NOT what was actually encoded.

---

## Root Cause: Type Mismatch

### The Bug

**In ed79c0b**, I wrote:
```typescript
const isAacEld = audio.codec === AudioCodecTypes.AAC_ELD; // AudioCodecTypes.AAC_ELD = 2 (number)
```

**The problem**:
- `audio.codec` comes from `request.audio.codec` (HAP StreamingRequest)
- HAP's `AudioInfo.codec` type is `AudioStreamingCodecType` (STRING: "AAC-eld", "OPUS", etc)
- But I compared it to `AudioCodecTypes.AAC_ELD` which is the NUMERIC enum value (2)
- String "AAC-eld" !== number 2 → `isAacEld` always false → always encoded Opus

### Why Tests Passed Initially

**In test fixtures** (ed79c0b):
```typescript
audio: {
  codec: 3, // I set a NUMBER (AudioCodecTypes.OPUS = 3)
  ...
}
```

**But real HAP requests have**:
```typescript
audio: {
  codec: "OPUS", // AudioStreamingCodecType.OPUS (STRING)
  ...
}
```

The test fixtures were wrong! They used numeric values when the real type is string.

**Why the test still passed**:
```typescript
expect(joined).toContain("-c:a libopus"); // Test expected Opus
```

Since the conditional ALWAYS failed and ALWAYS encoded Opus, the test for "codec: 3 → Opus" passed by accident (it would have passed for ANY codec value, including AAC-ELD, because the bug made everything Opus).

**The AAC-ELD test also passed** because I was testing with `codec: 2` (number), and the comparison failed, so it encoded Opus — but the test EXPECTED AAC-ELD args and looked for `-c:a aac`. Wait, that doesn't make sense...

Let me re-check: Oh, the tests DID fail initially when I first added them, and I "fixed" them by changing the fixture to use numbers. But the real issue was that the comparison was wrong, not the fixture.

Actually, looking back at the test output from ed79c0b, the tests passed 71/71. Let me think...

Oh! The tests passed because they were checking `buildLiveFfmpegArgs()` directly with the test fixtures, and in the test environment with numeric codec values, the comparison `audio.codec === AudioCodecTypes.AAC_ELD` (i.e., `3 === 2`) correctly failed for Opus and would have succeeded for AAC-ELD if I had used `codec: 2`.

But in PRODUCTION, HAP sends STRING codec values, not numbers. So the production code path had the bug, but the test code path (with numeric fixtures) worked differently.

This is a classic "tests don't match production" bug.

---

## The Fix

### 1. Correct Type Comparison

**Before**:
```typescript
const isAacEld = audio.codec === AudioCodecTypes.AAC_ELD; // Compare string to number (always false)
```

**After**:
```typescript
const isAacEld = audio.codec === AudioStreamingCodecType.AAC_ELD; // Compare string to string
```

Where:
- `AudioStreamingCodecType.AAC_ELD = "AAC-eld"` (string constant)
- `AudioCodecTypes.AAC_ELD = 2` (numeric enum)

### 2. Correct Interface Type

**Before**:
```typescript
audio: {
  codec: number, // WRONG
  ...
}
```

**After**:
```typescript
audio: {
  codec: AudioStreamingCodecType, // RIGHT (string union type)
  ...
}
```

### 3. Fix Test Fixtures to Match Production

**Before**:
```typescript
audio: {
  codec: 3, // WRONG: number doesn't match production
  ...
}
```

**After**:
```typescript
audio: {
  codec: "OPUS", // RIGHT: matches AudioStreamingCodecType
  ...
}
```

### 4. Fix Test Descriptions

**Before**:
```typescript
it("encodes AAC-ELD audio when HomeKit negotiates AAC-ELD (codec=2)", () => {
  const input = liveInput({ audio: { ...liveInput().audio, codec: 2 } }); // WRONG
```

**After**:
```typescript
it("encodes AAC-ELD audio when HomeKit negotiates AAC-ELD", () => {
  const input = liveInput({ audio: { ...liveInput().audio, codec: "AAC-eld" } }); // RIGHT
```

### 5. Better Logging

**Before** (ed79c0b):
```typescript
`audio: codec=${request.audio.codec} ... (will encode ${request.audio.codec})`
```
This logged the REQUEST twice, not what we actually encoded.

**After**:
```typescript
const audioEncoder = request.audio.codec === AudioStreamingCodecType.AAC_ELD ? "aac/aac_eld" : "libopus";
`audio: codec=${request.audio.codec} ... (encoding ${audioEncoder})`
```
Now logs the ACTUAL encoder derived from the codec selection logic.

---

## Why This Happened

### Mistake #1: Assumed Numeric Codec Type

I saw `AudioCodecTypes` enum with numeric values (0=PCMU, 1=PCMA, 2=AAC_ELD, 3=OPUS) and assumed HAP used those numeric values in requests.

**Reality**: HAP-NodeJS uses the STRING representations in `AudioInfo.codec` (type `AudioStreamingCodecType`).

### Mistake #2: Test Fixtures Didn't Match Production

I wrote test fixtures with numeric codec values (`codec: 3`) instead of strings (`codec: "OPUS"`), so tests passed even though production would fail.

### Mistake #3: Misleading Log

The log said "will encode X" but printed the REQUESTED codec, not the ACTUAL encoder choice. This hid the bug until I looked at the real ffmpeg command.

---

## Lessons

✅ **Always check the HAP-NodeJS type definitions** for request object types, don't assume based on enum names.

✅ **Test fixtures must match production types exactly**, especially for union/enum types.

✅ **Log the ACTUAL decision, not the input** — "will encode X" should derive from the encoding logic, not echo the request.

✅ **Field test logs are truth** — the mismatch between "will encode AAC-eld" and "ffmpeg ... -c:a libopus" was the smoking gun.

---

## Expected Behavior After Fix

### AAC-ELD Session
```
HomeKit negotiated ... audio: codec=AAC-eld 16kHz (encoding aac/aac_eld)
ffmpeg ... -c:a aac -profile:a aac_eld -q:a 4 ...
```

### Opus Session
```
HomeKit negotiated ... audio: codec=OPUS 24kHz (encoding libopus)
ffmpeg ... -c:a libopus -application lowdelay -frame_duration 20 ...
```

Now the log MATCHES the command.

---

## Verification

**Build verification**:
```bash
$ node --input-type=module -e "import {buildLiveFfmpegArgs} from './dist/homekit.js'; ..."
AAC-ELD audio args: -vn -c:a aac -profile:a aac_eld -q:a 4 ...
OPUS audio args: -vn -c:a libopus -application lowdelay -frame_duration 20 ...
```

**Test verification**:
```bash
$ npm test
Tests  71 passed (71)
```

**Field test**: Deploy to Mini, trigger motion, check logs for matching codec and ffmpeg args.
