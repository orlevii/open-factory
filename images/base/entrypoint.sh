#!/usr/bin/env bash
# open-factory base image entrypoint (spec §5.2):
# remap `agent` to HOST_UID/HOST_GID, write the ready marker, then run the command as agent.
set -euo pipefail

readonly AGENT=agent
readonly AGENT_HOME=/home/agent
readonly READY_DIR=/run/open-factory
readonly READY="$READY_DIR/ready"
readonly MAX_ID=2147483647

log() { echo "open-factory-entrypoint: $*" >&2; }
die() {
  log "$*"
  exit 64
}

# 1. Not root: we cannot remap.
if [ "$(id -u)" -ne 0 ]; then
  if [ -n "${HOST_UID:-}" ] || [ -n "${HOST_GID:-}" ]; then
    die 'must start as root to remap agent to HOST_UID/HOST_GID; do not end your user image with "USER agent"'
  fi
  log "not running as root; skipping the UID/GID remap"
  exec "$@"
fi

# 2. A partial run must never look complete.
mkdir -p "$READY_DIR"
rm -f "$READY"

valid_id() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] && [ "${#1}" -le 10 ] && ((10#$1 <= MAX_ID))
}

# 3–6. Validate and remap.
if [ -z "${HOST_UID:-}" ] && [ -z "${HOST_GID:-}" ]; then
  log "HOST_UID/HOST_GID not set; running as agent with the built-in 1000:1000"
  uid="$(id -u "$AGENT")"
  gid="$(id -g "$AGENT")"
else
  if [ -z "${HOST_UID:-}" ] || [ -z "${HOST_GID:-}" ]; then
    die "set both HOST_UID and HOST_GID, or neither"
  fi
  valid_id "$HOST_UID" || die "HOST_UID must be an integer in 1..$MAX_ID (got '$HOST_UID'); 0 (root) is refused"
  valid_id "$HOST_GID" || die "HOST_GID must be an integer in 1..$MAX_ID (got '$HOST_GID'); 0 (root) is refused"
  uid="$HOST_UID"
  gid="$HOST_GID"
  changed=0

  if [ "$gid" -ne "$(id -g "$AGENT")" ]; then
    if getent group "$gid" >/dev/null; then
      usermod -g "$gid" "$AGENT" # adopt the existing group (e.g. 20/dialout for macOS hosts)
    else
      groupmod -g "$gid" "$AGENT" # also updates agent's primary GID; does not chown
    fi
    changed=1
  fi

  if [ "$uid" -ne "$(id -u "$AGENT")" ]; then
    if getent passwd "$uid" >/dev/null; then
      usermod -o -u "$uid" "$AGENT" # duplicate UID; agent's passwd line is first, so names resolve to agent
    else
      usermod -u "$uid" "$AGENT"
    fi
    changed=1
  fi

  if [ "$changed" -eq 1 ]; then
    chown -R "$uid:$gid" "$AGENT_HOME"
  fi
fi

# 7. Remap done.
touch "$READY"

# 8. Drop privileges. Explicit IDs and group list: --init-groups would look the name up by UID.
groups="$(id -G "$AGENT" | tr ' ' ',')"
exec setpriv --reuid="$uid" --regid="$gid" --groups="$groups" \
  env HOME="$AGENT_HOME" USER="$AGENT" LOGNAME="$AGENT" SHELL=/usr/bin/zsh "$@"
