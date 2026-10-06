#!/bin/bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/launchd-lib.sh"

if [[ -z "${ARGUS_INSTALL_ROOT:-}" && "$(id -u)" -ne 0 ]]; then
  echo "cutover needs sudo" >&2
  exit 1
fi

home="$(effective_home)"
uid="$(gui_uid)"
daemon="$(argus_daemon_plist)"
rotate_daemon="$(logrotate_daemon_plist)"

if [[ ! -f "$daemon" || ! -f "$rotate_daemon" ]]; then
  echo "missing system plist. Run sudo bash scripts/install-launchdaemon.sh before cutover." >&2
  exit 1
fi

retire_gui_job "$uid" "$home" "$LABEL" "${home}/Library/LaunchAgents/${LABEL}.plist"

shopt -s nullglob
for plist in "${home}/Library/LaunchAgents/"*.plist; do
  if grep -q 'argus-logrotate\.sh' "$plist"; then
    retire_gui_job "$uid" "$home" "$(plist_label "$plist")" "$plist"
  fi
done

bootstrap_system "$daemon"
bootstrap_system "$rotate_daemon"
assert_single_argus "$uid"
echo "cut over ${LABEL}"
