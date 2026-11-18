#!/usr/bin/env bash
# Starts the built server (production mode), then drives the built `open-factory` CLI against it:
# status (version line), sign-up via curl, non-interactive login, status, logout.
# Note: each run leaves one smoke user in the database.
set -euo pipefail

PORT="${PORT:-3000}"
BASE="http://localhost:${PORT}" # PUBLIC_URL is set to this explicitly below
CLI="node apps/cli/dist/open-factory.js"
expected="$(node -p "require('./package.json').version")"

log="$(mktemp)"
cfg="$(mktemp -d)"
pid=""
suffix="$(date +%s)$$"
handle="smoke-${suffix}"
email="smoke-${suffix}@example.com"
password="smoke-password-123"

cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  rm -rf "$cfg" "$log"
}
trap cleanup EXIT
fail() {
  echo "smoke failed: $1" >&2
  echo "--- server log ---" >&2
  cat "$log" >&2
  exit 1
}

if curl -sf "${BASE}/api/status" > /dev/null 2>&1; then
  fail "something is already listening on port ${PORT}"
fi

NODE_ENV=production PORT="$PORT" PUBLIC_URL="$BASE" node apps/server/dist/index.js > "$log" 2>&1 &
pid=$!

ready=""
for _ in $(seq 1 60); do
  kill -0 "$pid" 2>/dev/null || fail "server exited during startup"
  if curl -sf "${BASE}/api/status" > /dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
[ -n "$ready" ] || fail "server did not start"

export XDG_CONFIG_HOME="$cfg"

out="$(OPEN_FACTORY_URL="$BASE" $CLI status)" || fail "status failed"
echo "$out"
echo "$out" | grep -qx "Server version: ${expected}" || fail "server version line mismatch"

curl -sf -X POST "${BASE}/api/auth/sign-up/email" \
  -H "Content-Type: application/json" -H "Origin: ${BASE}" \
  -d "{\"name\":\"Smoke User\",\"handle\":\"${handle}\",\"email\":\"${email}\",\"password\":\"${password}\"}" \
  > /dev/null || fail "sign-up request failed"

out="$(printf '%s\n%s\n%s\n' "$BASE" "$email" "$password" | $CLI login)" || fail "login failed"
echo "$out"
echo "$out" | grep -q "Logged in as @${handle}" || fail "login did not report the handle"

out="$($CLI status)" || fail "status after login failed"
echo "$out"
echo "$out" | grep -qx "Logged in as @${handle}" || fail "status after login is not logged in"

$CLI logout || fail "logout failed"
out="$($CLI status)" || fail "status after logout failed"
echo "$out" | grep -qx "Not logged in" || fail "status after logout still logged in"
echo "smoke ok"
