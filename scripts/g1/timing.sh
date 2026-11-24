#!/usr/bin/env bash
# Gate G1 item 20 (spec section 13): install and start timing, RECORDED, never
# PASS or FAIL.
#
# Usage (from the repo root, with Docker running):
#   scripts/g1/timing.sh [--image open-factory-base:<pin>] [--runs 3] [--fixture DIR] [--out timing-report.md]
#
# The host part only runs `docker run --rm` of the agent image, with this script
# mounted read-only and the fixture mounted read-only. The version is read from
# images/base/claude-code-version and compared with `claude --version` in the
# image. Inside the container each case gets a fresh CLAUDE_CONFIG_DIR and a fresh
# plugins dir ($P, CLAUDE_CODE_PLUGIN_CACHE_DIR).
#
# Without a credential it runs plain `claude plugin ...` commands only: (a) the
# marketplace add, (b) the install, (c) a second install, (d) the plugins dir.
# With CLAUDE_CODE_OAUTH_TOKEN exported it also measures, per case, the session
# start: (e) the time from spawn to the `initialize` control response and to
# the `init` event, with no plugin, with the plugin already in $P (warm) and
# from an empty $P with the plugin declared (cold), with 1 and 3 plugins. The
# token is passed to the container by name (docker -e NAME), never written
# anywhere and never printed.
#
# --fixture DIR is a directory built by scripts/g1/fixture/make-fixture.sh (run.sh
# passes its own); without it the script builds one in a temp dir (needs git only).
#
# Written for bash 3.2 and newer on the host; the container part is Linux
# (GNU date, awk).
set -eu

SELF_DIR=$(cd "$(dirname "$0")" && pwd -P)
SELF=$SELF_DIR/$(basename "$0")
ROOT=$(cd "$SELF_DIR/../.." && pwd -P)
IN_REPORT=/tmp/g1-timing-report.md

die() {
  echo "timing: $*" >&2
  exit 1
}

# ============================================================ inside container
inside() {
  PINNED="" RUNS=3 IMAGE_NAME=unknown
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --image) IMAGE_NAME=$2; shift 2 ;;
      --pinned) PINNED=$2; shift 2 ;;
      --runs) RUNS=$2; shift 2 ;;
      *) die "inside: unknown argument $1" ;;
    esac
  done

  W=$(mktemp -d /tmp/g1t.XXXXXX)
  ROWS=$W/rows.tsv      # plugin run status add install reinstall kb files nm pre post
  FAILS=$W/fails.txt
  : > "$ROWS"
  : > "$FAILS"
  export DISABLE_AUTOUPDATER=1 GIT_TERMINAL_PROMPT=0 NPM_CONFIG_CACHE=$W/npm-cache

  now() { date +%s.%N; }

  TMO=""
  if command -v timeout >/dev/null 2>&1; then TMO="timeout 300"; fi

  # step <name> <command...>: run it, time it, keep stdout and stderr. Never fails.
  # shellcheck disable=SC2086
  step() {
    S_NAME=$1
    shift
    local t0 t1
    t0=$(now)
    if $TMO "$@" > "$RD/$S_NAME.out" 2> "$RD/$S_NAME.err" < /dev/null; then S_RC=0; else S_RC=$?; fi
    t1=$(now)
    S_T=$(awk -v a="$t0" -v b="$t1" 'BEGIN { printf "%.2f", b - a }')
  }

  tail_err() { # <file>: last lines, one line, capped
    { tail -n 5 "$1" 2> /dev/null || true; } | tr '\n' ' ' | cut -c1-400
  }

  # run_case <label> <marketplace source> <marketplace name> <plugin> <run no>
  run_case() {
    local label=$1 src=$2 mname=$3 plugin=$4 n=$5
    local cfg mk add="" inst="" re="" kb=0 files=0 nm=no pre=no post=no status=OK stage=""
    RD=$W/case-$label-$n
    cfg=$RD/config
    mk=$RD/mark
    mkdir -p "$cfg" "$mk"
    mkdir -p "$cfg/skills" "$RD/p"
    export CLAUDE_CONFIG_DIR=$cfg CLAUDE_CODE_PLUGIN_CACHE_DIR=$RD/p MARK=$mk

    step add claude plugin marketplace add "$src"
    add=$S_T
    if [ "$S_RC" -ne 0 ]; then status=FAILED stage="marketplace add (exit $S_RC)"; fi
    if [ "$status" = OK ]; then
      step install claude plugin install "$plugin@$mname"
      inst=$S_T
      if [ "$S_RC" -ne 0 ]; then status=FAILED stage="install (exit $S_RC)"; fi
    fi
    if [ "$status" = OK ]; then
      step reinstall claude plugin install "$plugin@$mname"
      re=$S_T
      if [ "$S_RC" -ne 0 ]; then status=FAILED stage="second install (exit $S_RC)"; fi
    fi
    if [ "$status" = FAILED ]; then
      printf 'FAILED %s run %s at %s: %s\n' "$label" "$n" "$stage" "$(tail_err "$RD/$S_NAME.err")" >> "$FAILS"
    fi
    if [ -d "$RD/p" ]; then
      kb=$(du -sk "$RD/p" | awk '{print $1}')
      files=$(find "$RD/p" -type f | wc -l | tr -d ' ')
      if [ -n "$(find "$RD/p" -type d -name node_modules -print -quit)" ]; then nm=yes; fi
    fi
    [ -e "$mk/npm-preinstall" ] && pre=yes
    [ -e "$mk/npm-postinstall" ] && post=yes
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$label" "$n" "$status" "${add:--}" "${inst:--}" "${re:--}" "$kb" "$files" "$nm" "$pre" "$post" >> "$ROWS"
  }

  # range <label> <column>: "min-max s" over the OK rows, or "n/a"
  range() {
    awk -F'\t' -v l="$1" -v c="$2" '
      $1 == l && $3 == "OK" { v = $c + 0; if (n == 0 || v < lo) lo = v; if (n == 0 || v > hi) hi = v; n++ }
      END { if (n == 0) print "n/a"; else if (lo == hi) printf "%.2f s", lo; else printf "%.2f-%.2f s", lo, hi }' "$ROWS"
  }
  last_ok() { # <label> <column>
    awk -F'\t' -v l="$1" -v c="$2" '$1 == l && $3 == "OK" { v = $c } END { print (v == "" ? "n/a" : v) }' "$ROWS"
  }
  any_ok() { # <label> <column> <value>: yes when any OK row has it
    awk -F'\t' -v l="$1" -v c="$2" -v w="$3" '$1 == l && $3 == "OK" && $c == w { f = 1 } END { print (f ? "yes" : "no") }' "$ROWS"
  }
  runs_ok() { awk -F'\t' -v l="$1" '$1 == l { t++; if ($3 == "OK") o++ } END { printf "%d/%d", o, t }' "$ROWS"; }

  # ---- session-start timings (e)
  # A throwaway node clock: spawn claude headless, report the ms until the
  # `initialize` control response (stream-json input) or the `init` event.
  cat > "$W/startclock.js" <<'JSEOF'
const { spawn } = require('child_process');
const [mode, settings] = process.argv.slice(2);
const args = mode === 'init'
  ? ['-p', 'ok', '--output-format', 'stream-json', '--verbose', '--settings', settings]
  : ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', settings];
const t0 = process.hrtime.bigint();
const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'ignore'] });
const finish = (text) => { console.log(text); child.kill('SIGKILL'); process.exit(0); };
if (mode === 'initialize') {
  child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'g1-init', request: { subtype: 'initialize' } })}\n`);
}
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
    if (mode === 'init' && o.type === 'system' && o.subtype === 'init') finish(`ms ${ms}`);
    if (mode === 'initialize' && o.type === 'control_response') finish(`ms ${ms}`);
  }
});
child.on('exit', () => { console.log('ms FAILED'); process.exit(0); });
setTimeout(() => finish('ms TIMEOUT'), 120000);
JSEOF

  OFFICIAL='{"claude-plugins-official":{"source":{"source":"github","repo":"anthropics/claude-plugins-official"}}}'
  SUPER='{"superpowers-marketplace":{"source":{"source":"github","repo":"obra/superpowers-marketplace"}}}'
  SET0='{"syncClaudeAiPlugins":false}'
  SET1="{\"enabledPlugins\":{\"skill-creator@claude-plugins-official\":true},\"extraKnownMarketplaces\":$OFFICIAL,\"syncClaudeAiPlugins\":false}"
  SET3="{\"enabledPlugins\":{\"skill-creator@claude-plugins-official\":true,\"frontend-design@claude-plugins-official\":true,\"superpowers@superpowers-marketplace\":true},\"extraKnownMarketplaces\":{\"claude-plugins-official\":{\"source\":{\"source\":\"github\",\"repo\":\"anthropics/claude-plugins-official\"}},\"superpowers-marketplace\":{\"source\":{\"source\":\"github\",\"repo\":\"obra/superpowers-marketplace\"}}},\"syncClaudeAiPlugins\":false}"

  clock() { # <mode> <settings-json> <plugins dir>: ms, or "-"
    local cfg out
    cfg=$(mktemp -d "$W/cfg.XXXXXX")
    mkdir -p "$cfg/skills" "$3"
    out=$(CLAUDE_CONFIG_DIR=$cfg CLAUDE_CODE_PLUGIN_CACHE_DIR=$3 node "$W/startclock.js" "$1" "$2" 2> /dev/null | tail -n 1 || true)
    case "$out" in 'ms '[0-9]*) echo "${out#ms }" ;; *) echo "-" ;; esac
  }
  mm() { # <ms>...: "min-max ms (n)"
    printf '%s\n' "$@" | grep -E '^[0-9]+$' | sort -n | awk 'NR == 1 { lo = $1 } { hi = $1 } END { if (NR == 0) print "n/a"; else if (lo == hi) printf "%s ms (n=%d)", lo, NR; else printf "%s-%s ms (n=%d)", lo, hi, NR }' || true
  }
  prime() { # <plugins dir> <1|3>: install the plugins with the CLI, no session
    local pd=$1 cfg
    cfg=$(mktemp -d "$W/cfg.XXXXXX")
    mkdir -p "$cfg/skills"
    export CLAUDE_CONFIG_DIR=$cfg CLAUDE_CODE_PLUGIN_CACHE_DIR=$pd
    claude plugin marketplace add anthropics/claude-plugins-official > /dev/null 2>&1 || true
    claude plugin install skill-creator@claude-plugins-official > /dev/null 2>&1 || true
    if [ "$2" = 3 ]; then
      claude plugin install frontend-design@claude-plugins-official > /dev/null 2>&1 || true
      claude plugin marketplace add obra/superpowers-marketplace > /dev/null 2>&1 || true
      claude plugin install superpowers@superpowers-marketplace > /dev/null 2>&1 || true
    fi
  }

  session_timing() {
    local label settings n mode i v cold_init cold_initialize warm_init warm_initialize pd
    {
      echo "### (e) Session start, spawn to \`initialize\` response and to \`init\` ($RUNS runs each, min-max)"
      echo
      echo "The harness waits 5 s (COMMANDS_TIMEOUT_MS) for the \`initialize\` response. Cold: an empty plugins dir with the plugins declared in --settings (the cold start). Warm: the plugins already in the plugins dir. Each run kills the session once the event arrives."
      echo
      echo "| Plugins | cold: to initialize | cold: to init | warm: to initialize | warm: to init |"
      echo "|---|---|---|---|---|"
    } > "$SESS_TABLE"
    for label in none 1plugin 3plugins; do
      case "$label" in none) settings=$SET0 n=0 ;; 1plugin) settings=$SET1 n=1 ;; 3plugins) settings=$SET3 n=3 ;; esac
      cold_init="" cold_initialize="" warm_init="" warm_initialize=""
      i=1
      while [ "$i" -le "$RUNS" ]; do
        cold_initialize="$cold_initialize $(clock initialize "$settings" "$W/pc-$label-$i-a")"
        cold_init="$cold_init $(clock init "$settings" "$W/pc-$label-$i-b")"
        i=$((i + 1))
      done
      pd=$W/pw-$label
      if [ "$n" -gt 0 ]; then prime "$pd" "$n"; fi
      i=1
      while [ "$i" -le "$RUNS" ]; do
        warm_initialize="$warm_initialize $(clock initialize "$settings" "$pd")"
        warm_init="$warm_init $(clock init "$settings" "$pd")"
        i=$((i + 1))
      done
      # shellcheck disable=SC2086
      printf '| %s | %s | %s | %s | %s |\n' "$label" "$(mm $cold_initialize)" "$(mm $cold_init)" "$(mm $warm_initialize)" "$(mm $warm_init)" >> "$SESS_TABLE"
    done
    {
      echo
      echo "The extra time to \`init\` with the plugin already in the plugins dir is the warm cell against the \`none\` row; the cold start is the cold \`init\` cell."
    } >> "$SESS_TABLE"
  }

  # ---- environment facts
  CLAUDE_VERSION=$(claude --version 2> /dev/null | awk '{print $1}' || true)
  [ -n "$CLAUDE_VERSION" ] || { echo "timing: claude is not runnable in this image" >&2; exit 1; }
  VERSION_NOTE="matches the pin"
  if [ "$CLAUDE_VERSION" != "$PINNED" ]; then
    VERSION_NOTE="DIFFERS from the pin $PINNED (images/base/claude-code-version); not refused, recorded"
  fi

  # ---- the fixture marketplace: the directory marketplace fixdir, mounted read-only
  FIXTURE_SRC=/g1/fx/dir
  FIXTURE_NOTE="the DIRECTORY marketplace fixdir at $FIXTURE_SRC (read-only mount; its plugins are copied into the cache on install)"
  FIXTURE_OK=yes
  [ -d "$FIXTURE_SRC/.claude-plugin" ] || { FIXTURE_OK=no; echo "FAILED fixture: $FIXTURE_SRC is not mounted" >> "$FAILS"; }

  # ---- the cases (a failure is recorded and never stops the others)
  LABELS="superpowers skill-creator frontend-design"
  [ "$FIXTURE_OK" = yes ] && LABELS="$LABELS marker ranged"
  for label in $LABELS; do
    n=1
    while [ "$n" -le "$RUNS" ]; do
      case "$label" in
        superpowers) run_case "$label" obra/superpowers-marketplace superpowers-marketplace superpowers "$n" ;;
        skill-creator | frontend-design) run_case "$label" anthropics/claude-plugins-official claude-plugins-official "$label" "$n" ;;
        marker | ranged) run_case "$label" "$FIXTURE_SRC" fixdir "$label" "$n" ;;
      esac
      n=$((n + 1))
    done
  done

  # ---- (e) session-start timings (only with a credential, passed in by name)
  SESS_TABLE=$W/session-table.md
  : > "$SESS_TABLE"
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then session_timing; fi

  # ---- the report
  ref_add() {
    case "$1" in
      superpowers) echo "1.4 s" ;;
      skill-creator | frontend-design) echo "2.5 s (29 MB clone)" ;;
      *) echo "-" ;;
    esac
  }
  ref_inst() {
    case "$1" in
      superpowers) echo "1.2-1.4 s" ;;
      skill-creator | frontend-design) echo "0.5 s" ;;
      *) echo "-" ;;
    esac
  }
  ref_re() {
    case "$1" in
      superpowers) echo "0.3 s" ;;
      *) echo "-" ;;
    esac
  }
  ref_size() {
    case "$1" in
      superpowers) echo "2.7 MB, 273 files (v7.0.2)" ;;
      *) echo "-" ;;
    esac
  }

  {
    echo "## Install timing (item 20): RECORDED"
    echo
    echo "- Claude Code: $CLAUDE_VERSION ($VERSION_NOTE)"
    echo "- Image: $IMAGE_NAME; arch $(uname -m); $(nproc 2> /dev/null || echo '?') CPUs"
    echo "- Fixture marketplace: $FIXTURE_NOTE"
    echo "- Cold cases: $RUNS runs each, fresh CLAUDE_CONFIG_DIR each run, DISABLE_AUTOUPDATER=1, no credential for these plugin commands. Times are min-max wall seconds over the runs that succeeded. The plugins dir is a fresh CLAUDE_CODE_PLUGIN_CACHE_DIR per run."
    if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
      echo "- (e) session-start timings: not measured, no credential (export CLAUDE_CODE_OAUTH_TOKEN)."
    fi
    echo "- Network and host: <fill in>"
    echo
    echo "| Plugin | OK runs | (a) marketplace add | (b) install | (c) second install | (d) plugins dir, last run | node_modules | marker preinstall / postinstall ran |"
    echo "|---|---|---|---|---|---|---|---|"
    for label in $LABELS; do
      printf '| %s | %s | %s | %s | %s | %s KB, %s files | %s | %s / %s |\n' \
        "$label" "$(runs_ok "$label")" "$(range "$label" 4)" "$(range "$label" 5)" "$(range "$label" 6)" \
        "$(last_ok "$label" 7)" "$(last_ok "$label" 8)" "$(any_ok "$label" 9 yes)" \
        "$(any_ok "$label" 10 yes)" "$(any_ok "$label" 11 yes)"
    done
    echo
    echo "Or's reference numbers (spec item 20; Claude Code 2.1.327, open-factory-base:dev, no credentials, one run each):"
    echo
    echo "| Plugin | (a) add | (b) install | (c) second install | (d) size |"
    echo "|---|---|---|---|---|"
    for label in $LABELS; do
      printf '| %s | %s | %s | %s | %s |\n' "$label" "$(ref_add "$label")" "$(ref_inst "$label")" "$(ref_re "$label")" "$(ref_size "$label")"
    done
    echo
    echo "Reference notes: no node_modules after install for any official plugin; plain installs do not cost the tens of seconds #56 reports. This item finds whether a real dependency install (marker: package.json with a registry dependency and preinstall/postinstall) does."
    echo
    if [ -s "$SESS_TABLE" ]; then
      cat "$SESS_TABLE"
      echo
    fi
    if [ -s "$FAILS" ]; then
      echo "Failures (recorded, the other cases ran on):"
      echo
      sed 's/^/- /' "$FAILS"
    else
      echo "Failures: none."
    fi
  } > "$IN_REPORT"
  cat "$IN_REPORT"
  echo
  echo "timing: report file inside the container: $IN_REPORT (the container is removed on exit; the table above is the copy)"
}

# ================================================================= host side
host() {
  IMAGE="" RUNS=3 FIXTURE="" OUT=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --image) [ "$#" -ge 2 ] || die "--image needs a value"; IMAGE=$2; shift 2 ;;
      --runs) [ "$#" -ge 2 ] || die "--runs needs a value"; RUNS=$2; shift 2 ;;
      --fixture) [ "$#" -ge 2 ] || die "--fixture needs a value"; FIXTURE=$2; shift 2 ;;
      --out) [ "$#" -ge 2 ] || die "--out needs a value"; OUT=$2; shift 2 ;;
      -h | --help) sed -n '2,24p' "$SELF"; exit 0 ;;
      *) die "unknown argument: $1 (usage: scripts/g1/timing.sh [--image IMG] [--runs N] [--fixture DIR] [--out FILE])" ;;
    esac
  done
  case "$RUNS" in '' | *[!0-9]* | 0) die "--runs must be a positive integer" ;; esac

  command -v docker > /dev/null 2>&1 || die "docker is not installed or not on PATH"
  PINNED=$(tr -d '[:space:]' < "$ROOT/images/base/claude-code-version")
  [ -n "$PINNED" ] || die "images/base/claude-code-version is empty"
  [ -n "$IMAGE" ] || IMAGE=open-factory-base:$PINNED

  if [ -z "$FIXTURE" ]; then
    FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/of-g1-timing.XXXXXX")
    bash "$SELF_DIR/fixture/make-fixture.sh" "$FIXTURE" > /dev/null || die "make-fixture.sh failed"
  fi
  [ -d "$FIXTURE/dir" ] || die "$FIXTURE is not a fixture dir (no dir/)"

  # Read-only mounts of this script and the fixture. The credential, when
  # exported, goes in by name only.
  CRED=""
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then CRED="-e CLAUDE_CODE_OAUTH_TOKEN"; fi
  run() {
    # shellcheck disable=SC2086
    docker run --rm $CRED \
      -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
      -e DISABLE_AUTOUPDATER=1 -e CLAUDE_CONFIG_DIR=/tmp/g1-config \
      -v "$SELF:/g1/timing.sh:ro" \
      -v "$FIXTURE:/g1/fx:ro" \
      "$IMAGE" bash /g1/timing.sh --inside --image "$IMAGE" --pinned "$PINNED" --runs "$RUNS"
  }
  if [ -n "$OUT" ]; then
    run | tee "$OUT"
    echo "timing: copy written to $OUT" >&2
  else
    run
  fi
}

if [ "${1:-}" = "--inside" ]; then
  shift
  inside "$@"
else
  host "$@"
fi
