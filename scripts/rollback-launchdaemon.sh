#!/bin/bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/launchd-lib.sh"

if [[ -z "${ARGUS_INSTALL_ROOT:-}" && "$(id -u)" -ne 0 ]]; then
  echo "rollback needs sudo" >&2
  exit 1
fi

home="$(effective_home)"
uid="$(gui_uid)"

launchctl bootout "system/${LABEL}" 2>/dev/null || true
launchctl disable "system/${LABEL}" || true
launchctl bootout "system/${LOGROTATE_LABEL}" 2>/dev/null || true
launchctl disable "system/${LOGROTATE_LABEL}" || true

if launchctl print "system/${LABEL}" >/dev/null 2>&1; then
  echo "system daemon still loaded. Not bootstrapping the gui agent." >&2
  exit 1
fi

restore_disabled() {
  local disabled=$1
  local label=$2
  [[ -f "$disabled" ]] || return 0
  mkdir -p "${home}/Library/LaunchAgents"
  local dest="${home}/Library/LaunchAgents/$(basename "$disabled")"
  mv "$disabled" "$dest"
  launchctl enable "gui/${uid}/${label}" || true
  if ! launchctl print "gui/${uid}/${label}" >/dev/null 2>&1; then
    launchctl bootstrap "gui/${uid}" "$dest"
  fi
}

restore_disabled "${home}/Library/LaunchAgents-disabled/${LABEL}.plist" "$LABEL"

shopt -s nullglob
for plist in "${home}/Library/LaunchAgents-disabled/"*.plist; do
  if grep -q 'argus-logrotate\.sh' "$plist"; then
    restore_disabled "$plist" "$(plist_label "$plist")"
  fi
done

assert_single_argus "$uid"
echo "rolled back ${LABEL}"
