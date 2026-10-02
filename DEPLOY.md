# Mini Deployment — Video-Only Interim

**Date**: 2026-10-02  
**Branch**: cursor/fix-live-feed-hang-18ad  
**SHA**: 76e1ca3  
**PR**: #3 (DRAFT, do NOT merge)

---

## Quick Deploy

```bash
cd ~/Projects/argus
git fetch origin
git checkout cursor/fix-live-feed-hang-18ad
git pull origin cursor/fix-live-feed-hang-18ad
npm install && npm run build

# Verify firmware
grep "ARGUS_FIRMWARE_REVISION" dist/homekit.js
# Should see: ARGUS_FIRMWARE_REVISION = "1.3.0"

# Edit LaunchAgent plist
nano ~/Library/LaunchAgents/dev.point-labs.argus.plist

# Add to <dict> section under EnvironmentVariables:
# <key>ARGUS_AUDIO</key>
# <string>0</string>

# Restart
launchctl unload ~/Library/LaunchAgents/dev.point-labs.argus.plist
launchctl load ~/Library/LaunchAgents/dev.point-labs.argus.plist

# Check logs
tail -100 /tmp/argus.log | grep -E "live mode|HomeKit negotiated"
```

---

## Field Test

**Trigger motion** → **Tap notification**

**Expected**:
- ✅ Spinner appears briefly
- ✅ Spinner leaves (1-2s)
- ✅ Video renders (Garage Door live feed)
- ✅ No audio (expected, video-only mode)
- ✅ No spinner hang (picture works!)

---

## Success Criteria

✅ Video renders without spinner hang  
✅ Picture > no picture (unlocks core functionality)

---

## What Changed

**Firmware**: 1.2.0 → **1.3.0** (forces iOS to re-read metadata)  
**ARGUS_AUDIO**: 0 (video-only mode)  
**Result**: Empty audio codecs → iOS requests video-only → no A/V sync issues → picture renders

---

## Full Documentation

- `VIDEO-ONLY-INTERIM.md` — Evidence trail, deployment, restore audio procedure
- `VALIDATOR-CODEC-DIFFERENCE.md` — Why validator Opus ≠ production AAC-ELD
- PR #3: https://github.com/point-labs-dev/argus/pull/3

---

**Ready for field test. Tests: 73/73 pass. Keep PR draft.**
