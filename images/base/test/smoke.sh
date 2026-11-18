#!/usr/bin/env bash
# Smoke tests for ghcr.io/orlevii/open-factory/base (spec §7).
# Usage: smoke.sh IMAGE_REF CLAUDE_VERSION
#   IMAGE_REF            local tag, or repo@sha256:... (pulled first)
#   SMOKE_SKIP_OWNERSHIP=1   skip host-side bind-mount ownership checks (macOS Docker Desktop)
#   SMOKE_SECTIONS="..."     subset of: tools contract entrypoint ownership (default: all)
set -euo pipefail

image="${1:?usage: smoke.sh IMAGE_REF CLAUDE_VERSION}"
claude_version="${2:?usage: smoke.sh IMAGE_REF CLAUDE_VERSION}"
sections="${SMOKE_SECTIONS:-tools contract entrypoint ownership}"

# Never let a Claude credential reach a container: CI must not talk to a live model.
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN

host_uid="$(id -u)"
host_gid="$(id -g)"
containers=()
dirs=()

cleanup() {
  local c d
  for c in "${containers[@]+"${containers[@]}"}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  for d in "${dirs[@]+"${dirs[@]}"}"; do rm -rf "$d" 2>/dev/null || true; done
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
fail() {
  echo "SMOKE FAIL: $*" >&2
  exit 1
}
want() { # want LABEL PATTERN TEXT  -> TEXT has a line matching extended regex PATTERN
  grep -Eq -- "$2" <<<"$3" || fail "$1: expected /$2/ in output:"$'\n'"$3"
}
reject() { # reject LABEL PATTERN TEXT -> TEXT has no line matching PATTERN
  if grep -Eq -- "$2" <<<"$3"; then fail "$1: unexpected /$2/ in output:"$'\n'"$3"; fi
}

# Run a bash snippet as agent through the entrypoint, with the host's IDs.
run_agent() {
  docker run --rm -e HOST_UID="$host_uid" -e HOST_GID="$host_gid" "$image" bash -c "$1"
}

wait_ready() {
  local c="$1" _
  for _ in $(seq 1 60); do
    if docker exec "$c" test -f /run/open-factory/ready 2>/dev/null; then return 0; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$c")" != true ]; then
      docker logs "$c" >&2 || true
      fail "$c exited before the ready marker appeared"
    fi
    sleep 0.5
  done
  docker logs "$c" >&2 || true
  fail "$c: no ready marker after 30s"
}

check_tools() {
  step "tools (as agent, via the entrypoint)"
  local out
  # shellcheck disable=SC2016 # the snippet must expand inside the container, not on the host
  out="$(run_agent '
    set -e
    node -v; npm -v; npx -v; pnpm -v
    python3.12 -V
    python3 -c "import sys; print(\"prefix=\" + sys.prefix)"
    uv --version; poetry --version
    rustc -V; cargo -V; rustup -V 2>/dev/null
    claude --dangerously-skip-permissions --version
    gh --version; git --version; rg --version; fd --version; jq --version; yq --version
    zsh --version; tmux -V; setpriv --version
    echo "uid=$(id -u)"
  ')"
  echo "$out"
  want "node 24" '^v24\.' "$out"
  want "python3 is uv-managed" '^prefix=/opt/uv/' "$out"
  want "python3.12" '^Python 3\.12\.' "$out"
  want "claude version" "$claude_version" "$out"
  want "yq is mikefarah's" 'mikefarah' "$out"
  want "runs as host uid" "^uid=${host_uid}\$" "$out"
  reject "not root" '^uid=0$' "$out"
  out="$(docker run --rm --network none -e HOST_UID="$host_uid" -e HOST_GID="$host_gid" "$image" pnpm -v 2>&1)" ||
    fail "pnpm native binary pre-warm is broken: pnpm -v failed offline:"$'\n'"$out"
  want "pnpm native binary pre-warm is broken (no version line offline)" '^[0-9]+\.[0-9]+\.[0-9]+' "$out"
  reject "pnpm native binary pre-warm is broken (downloads at runtime)" 'Downloading' "$out"
}

check_contract() {
  step "runtime contract (detached + docker exec -u agent, the S5 path)"
  local c="open-factory-smoke-$$" out agent_out root_out before after
  docker run -d --name "$c" --tmpfs /run/open-factory \
    -e HOST_UID="$host_uid" -e HOST_GID="$host_gid" "$image" >/dev/null
  containers+=("$c")
  wait_ready "$c"

  out="$(docker exec -u agent "$c" bash -c '
    node -v
    echo "uid=$(id -u)"
    echo "user=$(id -un)"
    sudo -n true && echo sudo=ok
    claude --dangerously-skip-permissions --version
  ')"
  echo "$out"
  want "non-interactive node" '^v24\.' "$out"
  want "exec uid" "^uid=${host_uid}\$" "$out"
  reject "exec not root" '^uid=0$' "$out"
  want "exec user name" '^user=agent$' "$out"
  want "passwordless sudo" '^sudo=ok$' "$out"
  want "claude --version as agent" "$claude_version" "$out"
  [ "$(docker exec "$c" cat /proc/1/comm)" = tini ] || fail "PID 1 is not tini"

  step "non-root proof (Claude's own root check)"
  agent_out="$(timeout 120 docker exec -u agent "$c" claude --dangerously-skip-permissions -p x 2>&1 || true)"
  root_out="$(timeout 120 docker exec -u 0 "$c" claude --dangerously-skip-permissions -p x 2>&1 || true)"
  echo "agent: $agent_out"
  echo "root:  $root_out"
  reject "agent is not refused as root (Claude Code output may have changed wording; check the root-refusal text)" 'cannot be used with root' "$agent_out"
  want "agent reached the auth check (Claude Code output may have changed wording; check the 'Not logged in' text)" 'Not logged in' "$agent_out"
  want "root is refused, so the probe is real (Claude Code output may have changed wording; check the root-refusal text)" 'cannot be used with root' "$root_out"

  step "restart clears and recreates the ready marker"
  before="$(docker exec "$c" date -r /run/open-factory/ready +%s%N)"
  docker stop -t 2 "$c" >/dev/null
  docker start "$c" >/dev/null
  wait_ready "$c"
  after="$(docker exec "$c" date -r /run/open-factory/ready +%s%N)"
  [ "$after" -gt "$before" ] || fail "marker not recreated on restart ($before -> $after)"
}

expect_refusal() { # expect_refusal DESC docker-run-args...
  local desc="$1" out rc=0
  shift
  out="$(docker run --rm "$@" "$image" true 2>&1)" || rc=$?
  [ "$rc" -eq 64 ] || fail "$desc: expected exit 64, got $rc: $out"
  want "$desc message" '^open-factory-entrypoint: ' "$out"
  echo "refused ($desc): $out"
}

check_entrypoint() {
  step "unset IDs run as 1000:1000 with a warning"
  local out
  out="$(docker run --rm "$image" bash -c 'echo "ids=$(id -u):$(id -g)"' 2>&1)"
  echo "$out"
  want "default ids" '^ids=1000:1000$' "$out"
  want "warning" 'HOST_UID/HOST_GID not set' "$out"

  step "refusals"
  expect_refusal "HOST_UID=0" -e HOST_UID=0 -e HOST_GID=1000
  expect_refusal "HOST_GID=0" -e HOST_UID=1000 -e HOST_GID=0
  expect_refusal "only HOST_UID" -e HOST_UID=1000
  expect_refusal "only HOST_GID" -e HOST_GID=1000
  expect_refusal "non-numeric" -e HOST_UID=abc -e HOST_GID=1000
  expect_refusal "too large" -e HOST_UID=99999999999 -e HOST_GID=1000
  expect_refusal "--user with IDs" --user 1000:1000 -e HOST_UID=1000 -e HOST_GID=1000
}

check_ownership() {
  if [ "${SMOKE_SKIP_OWNERSHIP:-}" = 1 ]; then
    step "bind-mount ownership: SKIPPED (SMOKE_SKIP_OWNERSHIP=1)"
    return 0
  fi
  local ids d out
  for ids in "${host_uid}:${host_gid}" 501:20 1000:1000 65534:65534; do
    step "bind-mount ownership ${ids}"
    d="$(mktemp -d)"
    dirs+=("$d")
    chmod 0777 "$d"
    out="$(docker run --rm -e HOST_UID="${ids%%:*}" -e HOST_GID="${ids##*:}" -v "$d:$d" "$image" \
      bash -c 'touch "$0/f"; id -un; sudo -n true && echo sudo=ok' "$d")"
    echo "$out"
    want "$ids user name" '^agent$' "$out"
    want "$ids sudo" '^sudo=ok$' "$out"
    [ "$(stat -c %u:%g "$d/f")" = "$ids" ] || fail "$ids: host sees $(stat -c %u:%g "$d/f")"
  done
}

if [[ "$image" == *@sha256:* ]]; then
  step "pull $image"
  docker pull "$image"
fi

for s in $sections; do
  case "$s" in
  tools) check_tools ;;
  contract) check_contract ;;
  entrypoint) check_entrypoint ;;
  ownership) check_ownership ;;
  *) fail "unknown section: $s" ;;
  esac
done
step "all smoke checks passed"
