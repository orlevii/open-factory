#!/usr/bin/env bash
# Starts the built server (production mode), then drives the built `open-factory` CLI against it:
# status (version line), sign-up via curl, non-interactive login, status, logout.
set -euo pipefail

PORT="${PORT:-3000}"
BASE="http://localhost:${PORT}" # must equal PUBLIC_URL's origin (default http://localhost:$PORT)
CLI="node apps/cli/dist/open-factory.js"
expected="$(node -p "require('./package.json').version")"

log="$(mktemp)"
cfg="$(mktemp -d)"
suffix="$(date +%s)$$"
handle="smoke-${suffix}"
email="smoke-${suffix}@example.com"
password="smoke-password-123"

NODE_ENV=production PORT="$PORT" node apps/server/dist/index.js > "$log" 2>&1 &
pid=$!
cleanup() {
  kill "$pid" 2>/dev/null || true
  rm -rf "$cfg" "$log"
}
trap cleanup EXIT
fail() {
  echo "smoke failed: $1" >&2
  echo "--- server log ---" >&2
  cat "$log" >&2
  exit 1
}

for _ in $(seq 1 60); do
  curl -sf "${BASE}/api/status" > /dev/null && break
  sleep 0.5
done

export XDG_CONFIG_HOME="$cfg"

out="$(OPEN_FACTORY_URL="$BASE" $CLI status)"
echo "$out"
echo "$out" | grep -qx "Server version: ${expected}" || fail "server version line mismatch"

curl -sf -X POST "${BASE}/api/auth/sign-up/email" \
  -H "Content-Type: application/json" -H "Origin: ${BASE}" \
  -d "{\"name\":\"Smoke User\",\"handle\":\"${handle}\",\"email\":\"${email}\",\"password\":\"${password}\"}" \
  > /dev/null || fail "sign-up request failed"

out="$(printf '%s\n%s\n%s\n' "$BASE" "$email" "$password" | $CLI login)"
echo "$out"
echo "$out" | grep -q "Logged in as @${handle}" || fail "login did not report the handle"

out="$($CLI status)"
echo "$out"
echo "$out" | grep -qx "Logged in as @${handle}" || fail "status after login is not logged in"

$CLI logout
out="$($CLI status)"
echo "$out" | grep -qx "Not logged in" || fail "status after logout still logged in"
echo "smoke ok"
