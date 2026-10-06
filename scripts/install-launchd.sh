#!/bin/bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/launchd-lib.sh"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_ROOT="${ARGUS_INSTALL_ROOT:-}"
RENDER_ONLY="${ARGUS_INSTALL_RENDER_ONLY:-}"

job_user() {
  local name="${SUDO_USER:-}"
  if [[ -z "$name" || "$name" == "root" ]]; then
    name="$(id -un)"
  fi
  if [[ "$name" == "root" ]]; then
    echo "refusing UserName root" >&2
    exit 1
  fi
  printf '%s' "$name"
}

DOMAIN="gui/$(gui_uid)"

if [[ -n "$INSTALL_ROOT" ]]; then
  AGENT_PLIST="${INSTALL_ROOT}/Library/LaunchAgents/${LABEL}.plist"
  DAEMON_PLIST="${INSTALL_ROOT}${CANONICAL_DAEMON_PLIST}"
else
  AGENT_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
  DAEMON_PLIST="${CANONICAL_DAEMON_PLIST}"
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "${HOME}/Library/LaunchAgents/${LABEL}.plist"
  echo "uninstalled $LABEL"
  exit 0
fi

if [[ "$RENDER_ONLY" != "1" ]]; then
  if [[ -z "${SUDO_USER:-}" || "${SUDO_USER}" == "root" ]]; then
    if [[ -f "$DAEMON_PLIST" ]] || launchctl print "system/${LABEL}" >/dev/null 2>&1; then
      echo "system daemon already exists. Refusing to bootstrap the gui agent. Use scripts/cutover-launchdaemon.sh or scripts/rollback-launchdaemon.sh." >&2
      exit 1
    fi
  fi
fi

xml_escape() {
  local s=$1
  s=${s//&/&amp;}
  s=${s//</&lt;}
  s=${s//>/&gt;}
  s=${s//\"/&quot;}
  printf '%s' "$s"
}

build_argus_xml() {
  local src_plist=$1
  local tmp var
  tmp="$(mktemp "${TMPDIR:-/tmp}/argus-env.XXXXXX")"
  if [[ -n "$src_plist" && -f "$src_plist" ]]; then
    awk '
      /<key>ARGUS_[^<]+<\/key>/ {
        key = $0
        sub(/.*<key>/, "", key)
        sub(/<\/key>.*/, "", key)
        if (getline <= 0) next
        if ($0 ~ /<string>.*<\/string>/) {
          val = $0
          sub(/.*<string>/, "", val)
          sub(/<\/string>.*/, "", val)
          print key "=" val
        }
      }
    ' "$src_plist" > "$tmp"
  fi
  while IFS= read -r var; do
    case "$var" in
      ARGUS_INSTALL_*|ARGUS_AGENT_PLIST) continue ;;
    esac
    if [[ -n "${!var:-}" ]]; then
      printf '%s=%s\n' "$var" "${!var}" >> "$tmp"
    fi
  done < <(compgen -v ARGUS_ || true)
  ARGUS_XML="$(awk '
    function esc(s) {
      gsub(/&/, "\\&amp;", s)
      gsub(/</, "\\&lt;", s)
      gsub(/>/, "\\&gt;", s)
      gsub(/"/, "\\&quot;", s)
      return s
    }
    {
      eq = index($0, "=")
      if (eq < 2) next
      k = substr($0, 1, eq - 1)
      v = substr($0, eq + 1)
      if (!(k in ord)) {
        ord[k] = ++n
        order[n] = k
      }
      val[k] = v
    }
    END {
      for (i = 1; i <= n; i++) {
        k = order[i]
        printf "    <key>%s</key>\n    <string>%s</string>\n", k, esc(val[k])
      }
    }
  ' "$tmp")"
  rm -f "$tmp"
}

write_job_plist() {
  local dest=$1
  local user_name=${2:-}
  mkdir -p "$(dirname "$dest")"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0">'
    printf '%s\n' '<dict>'
    printf '%s\n' '  <key>Label</key>'
    printf '%s\n' "  <string>${LABEL}</string>"
    if [[ -n "$user_name" ]]; then
      printf '%s\n' '  <key>UserName</key>'
      printf '%s\n' "  <string>$(xml_escape "$user_name")</string>"
    fi
    printf '%s\n' '  <key>ProgramArguments</key>'
    printf '%s\n' '  <array>'
    printf '%s\n' "    <string>${NODE_BIN}</string>"
    printf '%s\n' "    <string>${REPO_DIR}/dist/serve.js</string>"
    printf '%s\n' "    <string>${REPO_DIR}/argus.yaml</string>"
    printf '%s\n' '  </array>'
    printf '%s\n' '  <key>WorkingDirectory</key>'
    printf '%s\n' "  <string>${REPO_DIR}</string>"
    printf '%s\n' '  <key>EnvironmentVariables</key>'
    printf '%s\n' '  <dict>'
    printf '%s\n' '    <key>PATH</key>'
    printf '%s\n' "    <string>${DAEMON_PATH}</string>"
    if [[ -n "${ARGUS_XML:-}" ]]; then
      printf '%s\n' "$ARGUS_XML"
    fi
    printf '%s\n' '  </dict>'
    printf '%s\n' '  <key>Umask</key>'
    printf '%s\n' '  <integer>63</integer>'
    printf '%s\n' '  <key>RunAtLoad</key>'
    printf '%s\n' '  <true/>'
    printf '%s\n' '  <key>KeepAlive</key>'
    printf '%s\n' '  <true/>'
    printf '%s\n' '  <key>ProcessType</key>'
    printf '%s\n' '  <string>Interactive</string>'
    printf '%s\n' '  <key>StandardOutPath</key>'
    printf '%s\n' "  <string>${REPO_DIR}/logs/serve.log</string>"
    printf '%s\n' '  <key>StandardErrorPath</key>'
    printf '%s\n' "  <string>${REPO_DIR}/logs/serve.err.log</string>"
    printf '%s\n' '</dict>'
    printf '%s\n' '</plist>'
  } > "$dest"
}

write_logrotate_plist() {
  local dest=$1
  local user_name=$2
  local home=$3
  local program="${home}/bin/argus-logrotate.sh"
  mkdir -p "$(dirname "$dest")"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0">'
    printf '%s\n' '<dict>'
    printf '%s\n' '  <key>Label</key>'
    printf '%s\n' "  <string>${LOGROTATE_LABEL}</string>"
    printf '%s\n' '  <key>UserName</key>'
    printf '%s\n' "  <string>$(xml_escape "$user_name")</string>"
    printf '%s\n' '  <key>ProgramArguments</key>'
    printf '%s\n' '  <array>'
    printf '%s\n' "    <string>$(xml_escape "$program")</string>"
    printf '%s\n' '  </array>'
    printf '%s\n' '  <key>EnvironmentVariables</key>'
    printf '%s\n' '  <dict>'
    printf '%s\n' '    <key>HOME</key>'
    printf '%s\n' "    <string>$(xml_escape "$home")</string>"
    printf '%s\n' '  </dict>'
    printf '%s\n' '  <key>StartInterval</key>'
    printf '%s\n' '  <integer>3600</integer>'
    printf '%s\n' '</dict>'
    printf '%s\n' '</plist>'
  } > "$dest"
}

NODE_BIN="$(command -v node)"
FFMPEG_BIN="$(command -v ffmpeg)"
[[ -x "$NODE_BIN" ]] || { echo "node not found in PATH" >&2; exit 1; }
[[ -x "$FFMPEG_BIN" ]] || { echo "ffmpeg not found in PATH" >&2; exit 1; }
[[ -f "$REPO_DIR/dist/serve.js" ]] || { echo "dist/serve.js missing. Run npm run build first." >&2; exit 1; }
[[ -f "$REPO_DIR/argus.yaml" ]] || { echo "argus.yaml missing in $REPO_DIR" >&2; exit 1; }

DAEMON_PATH="$(dirname "$NODE_BIN"):$(dirname "$FFMPEG_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"

SOURCE_PLIST=""
if [[ -n "${ARGUS_AGENT_PLIST:-}" ]]; then
  if [[ ! -f "$ARGUS_AGENT_PLIST" ]]; then
    echo "ARGUS_AGENT_PLIST does not exist: ${ARGUS_AGENT_PLIST}" >&2
    exit 1
  fi
  SOURCE_PLIST="$ARGUS_AGENT_PLIST"
else
  CANDIDATE="$(effective_home)/Library/LaunchAgents/${LABEL}.plist"
  if [[ -f "$CANDIDATE" ]]; then
    SOURCE_PLIST="$CANDIDATE"
  fi
fi
ARGUS_XML=""
build_argus_xml "$SOURCE_PLIST"
if [[ -z "${ARGUS_XML}" ]]; then
  echo "refusing to write the daemon plist with no ARGUS_* keys. Pass ARGUS_AGENT_PLIST, or run sudo from the account whose LaunchAgent plist has those keys." >&2
  exit 1
fi

if [[ "$RENDER_ONLY" != "1" ]]; then
  mkdir -p "$REPO_DIR/logs"
fi

USER_NAME="$(job_user)"
USER_HOME="$(effective_home)"
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" && -z "$INSTALL_ROOT" ]]; then
  write_job_plist "$DAEMON_PLIST" "$USER_NAME"
else
  write_job_plist "$AGENT_PLIST" ""
  write_job_plist "$DAEMON_PLIST" "$USER_NAME"
fi
write_logrotate_plist "$(dirname "$DAEMON_PLIST")/${LOGROTATE_LABEL}.plist" "$USER_NAME" "$USER_HOME"
echo "$CANONICAL_DAEMON_PLIST"

if [[ "$RENDER_ONLY" == "1" ]]; then
  exit 0
fi

if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  exit 0
fi

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$AGENT_PLIST"
launchctl print "$DOMAIN/$LABEL" | grep -E "state|pid" | head -3
echo "installed $LABEL (logs: $REPO_DIR/logs/serve.log)"
