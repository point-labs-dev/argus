#!/bin/bash

LABEL="dev.point-labs.argus"
LOGROTATE_LABEL="dev.point-labs.argus.logrotate"
CANONICAL_DAEMON_PLIST="/Library/LaunchDaemons/${LABEL}.plist"

user_home_dir() {
  local name=$1
  local home=""
  if command -v dscl >/dev/null 2>&1; then
    home="$(dscl . -read "/Users/${name}" NFSHomeDirectory 2>/dev/null | awk '/NFSHomeDirectory/ { print $2; exit }' || true)"
  fi
  if [[ -z "$home" ]] && command -v getent >/dev/null 2>&1; then
    home="$(getent passwd "$name" 2>/dev/null | awk -F: 'NR==1 { print $6; exit }' || true)"
  fi
  if [[ -z "$home" ]]; then
    home="$(python3 -c 'import pwd,sys; print(pwd.getpwnam(sys.argv[1]).pw_dir)' "$name" 2>/dev/null || true)"
  fi
  if [[ -z "$home" || "$home" == "/" ]]; then
    return 1
  fi
  printf '%s' "$home"
}

effective_home() {
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    local home=""
    if ! home="$(user_home_dir "${SUDO_USER}")"; then
      echo "cannot resolve home for SUDO_USER=${SUDO_USER}. Pass ARGUS_AGENT_PLIST." >&2
      exit 1
    fi
    printf '%s' "$home"
    return
  fi
  printf '%s' "${HOME}"
}

gui_uid() {
  local uid
  uid="$(id -u)"
  if [[ -n "${SUDO_UID:-}" && "${SUDO_USER:-}" != "root" ]]; then
    uid="${SUDO_UID}"
  fi
  printf '%s' "$uid"
}

plist_under_root() {
  local label=$1
  if [[ -n "${ARGUS_INSTALL_ROOT:-}" ]]; then
    printf '%s' "${ARGUS_INSTALL_ROOT}/Library/LaunchDaemons/${label}.plist"
  else
    printf '%s' "/Library/LaunchDaemons/${label}.plist"
  fi
}

argus_daemon_plist() {
  plist_under_root "$LABEL"
}

logrotate_daemon_plist() {
  plist_under_root "$LOGROTATE_LABEL"
}

plist_label() {
  python3 -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb")).get("Label",""))' "$1"
}

retire_gui_job() {
  local uid=$1
  local home=$2
  local label=$3
  local plist=$4
  launchctl bootout "gui/${uid}/${label}" 2>/dev/null || true
  launchctl disable "gui/${uid}/${label}" || true
  if [[ -n "$plist" && -f "$plist" ]]; then
    mkdir -p "${home}/Library/LaunchAgents-disabled"
    mv "$plist" "${home}/Library/LaunchAgents-disabled/"
  fi
}

bootstrap_system() {
  local plist=$1
  local label
  label="$(plist_label "$plist")"
  launchctl enable "system/${label}" || true
  if launchctl print "system/${label}" >/dev/null 2>&1; then
    return 0
  fi
  launchctl bootstrap system "$plist"
}

assert_single_argus() {
  local uid=$1
  if launchctl print "gui/${uid}/${LABEL}" >/dev/null 2>&1 \
    && launchctl print "system/${LABEL}" >/dev/null 2>&1; then
    echo "two Argus instances are loaded (gui/${uid}/${LABEL} and system/${LABEL})" >&2
    exit 1
  fi
}
