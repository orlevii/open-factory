#!/usr/bin/env bash
# Starts the built server (production mode), then drives the built `open-factory` CLI against it:
# status (version line), sign-up via curl, non-interactive login, status, logout.
# The server runs on a throwaway database created next to DATABASE_URL's (and dropped at the end), so the
# sign-up is always the first one, which needs no invite (S10), whatever DATABASE_URL already holds.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to a Postgres server; the smoke creates and drops its own database there}"

PORT="${PORT:-3000}"
BASE="http://localhost:${PORT}" # PUBLIC_URL is set to this explicitly below
CLI="node apps/cli/dist/open-factory.js"
expected="$(node -p "require('./package.json').version")"

log="$(mktemp)"
cfg="$(mktemp -d)"
pid=""
db_created=""
suffix="$(date +%s)$$"
smoke_db="smoke_cli_${suffix}"
handle="smoke-${suffix}"
email="smoke-${suffix}@example.com"
password="smoke-password-123"

# Runs one SQL statement on DATABASE_URL's database (the `postgres` client is a dependency of packages/db).
pg_admin() {
  (cd packages/db && SQL="$1" node --input-type=module -e '
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  await sql.unsafe(process.env.SQL);
} finally {
  await sql.end();
}')
}

cleanup() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  if [ -n "$db_created" ]; then
    pg_admin "drop database if exists \"${smoke_db}\" with (force)" ||
      echo "cleanup: dropping the throwaway database ${smoke_db} failed" >&2
  fi
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

pg_admin "create database \"${smoke_db}\"" || fail "could not create the throwaway database ${smoke_db}"
db_created=1
smoke_url="$(node -e 'const u = new URL(process.env.DATABASE_URL); u.pathname = `/${process.argv[1]}`; console.log(u.toString())' "$smoke_db")"

DATABASE_URL="$smoke_url" FACTORY_HOME="${cfg}/home" NODE_ENV=production PORT="$PORT" PUBLIC_URL="$BASE" \
  node apps/server/dist/index.js > "$log" 2>&1 &
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
