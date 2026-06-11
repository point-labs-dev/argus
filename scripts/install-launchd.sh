#!/bin/bash
# Install (or reinstall) Argus serve as a macOS LaunchAgent so it survives
# reboots and terminal closes, and runs unsandboxed (LAN peers must be able to
# connect to the HAP ports — see progress/ "No Response" trap).
#
# Usage: bash scripts/install-launchd.sh          # from the repo root
#        bash scripts/install-launchd.sh --uninstall
set -euo pipefail

LABEL="dev.point-labs.argus"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled $LABEL"
  exit 0
fi

NODE_BIN="$(command -v node)"
FFMPEG_BIN="$(command -v ffmpeg)"
[[ -x "$NODE_BIN" ]] || { echo "node not found in PATH" >&2; exit 1; }
[[ -x "$FFMPEG_BIN" ]] || { echo "ffmpeg not found in PATH" >&2; exit 1; }
[[ -f "$REPO_DIR/dist/serve.js" ]] || { echo "dist/serve.js missing — run npm run build first" >&2; exit 1; }
[[ -f "$REPO_DIR/argus.yaml" ]] || { echo "argus.yaml missing in $REPO_DIR" >&2; exit 1; }

mkdir -p "$REPO_DIR/logs" "$HOME/Library/LaunchAgents"

# PATH for the daemon: node's dir + ffmpeg's dir + system basics. launchd does
# NOT source shell profiles, so spawn("ffmpeg") only works if this is right.
DAEMON_PATH="$(dirname "$NODE_BIN"):$(dirname "$FFMPEG_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${REPO_DIR}/dist/serve.js</string>
    <string>${REPO_DIR}/argus.yaml</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${DAEMON_PATH}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <!-- Streaming server: keep it out of background QoS so timers (1s motion
       poll, snapshot refresh) aren't coalesced/throttled. -->
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${REPO_DIR}/logs/serve.log</string>
  <key>StandardErrorPath</key>
  <string>${REPO_DIR}/logs/serve.err.log</string>
</dict>
</plist>
PLIST

# Reinstall cleanly if already loaded.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl print "$DOMAIN/$LABEL" | grep -E "state|pid" | head -3
echo "installed $LABEL (logs: $REPO_DIR/logs/serve.log)"
