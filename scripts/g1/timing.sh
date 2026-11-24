#!/usr/bin/env bash
# Gate G1 item 20 (spec section 13): install timing, RECORDED, never PASS or FAIL.
#
# Usage (from the repo root, with Docker running):
#   scripts/g1/timing.sh [--image open-factory-base:dev] [--runs 3] [--out timing-report.md]
#   scripts/g1/timing.sh --github-owner <owner> [--image ...] [--runs 3] [--out ...]
#
# Standalone: no GitHub account, no credentials, nothing installed on the host.
# The host part only runs `docker run --rm --entrypoint bash <image>` with this
# script mounted read-only and the fixture dir (scripts/g1/fixture) mounted
# read-only, and with exactly two env vars (DISABLE_AUTOUPDATER=1 and a
# CLAUDE_CONFIG_DIR). No host env is forwarded. Inside the container each case
# gets a fresh CLAUDE_CONFIG_DIR and runs plain `claude plugin ...` commands
# only: no agent session, no auth, no credentials.
#
# Default mode: the container builds the fixture itself (make-fixture.sh, which
# needs git, npm, jq and the network once for the lockfile) and adds it as a
# DIRECTORY marketplace from a local path (a git working tree on disk, added
# by path, so it is not a git clone). With --github-owner the fixture
# marketplace is added from <owner>/of-g1-fixture instead (a git clone); that
# is the mode run.sh item 20 uses.
#
# Not measured here: session-start `init` timing (extra time to init with the
# plugin installed, cold start). It needs a credential.
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
  PINNED="" MODE=dir OWNER="" RUNS=3 IMAGE_NAME=unknown
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --image) IMAGE_NAME=$2; shift 2 ;;
      --pinned) PINNED=$2; shift 2 ;;
      --mode) MODE=$2; shift 2 ;;
      --owner) OWNER=$2; shift 2 ;;
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
    export CLAUDE_CONFIG_DIR=$cfg MARK=$mk

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
    if [ -d "$cfg/plugins" ]; then
      kb=$(du -sk "$cfg/plugins" | awk '{print $1}')
      files=$(find "$cfg/plugins" -type f | wc -l | tr -d ' ')
      if [ -n "$(find "$cfg/plugins" -type d -name node_modules -print -quit)" ]; then nm=yes; fi
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

  # ---- environment facts
  CLAUDE_VERSION=$(claude --version 2> /dev/null | awk '{print $1}' || true)
  [ -n "$CLAUDE_VERSION" ] || { echo "timing: claude is not runnable in this image" >&2; exit 1; }
  VERSION_NOTE="matches the pin"
  if [ "$CLAUDE_VERSION" != "$PINNED" ]; then
    VERSION_NOTE="DIFFERS from the pin $PINNED (images/base/claude-code-version); not refused, recorded"
  fi

  # ---- the fixture marketplace
  FIXTURE_NOTE=""
  FIXTURE_OK=yes
  if [ "$MODE" = github ]; then
    FIXTURE_SRC=$OWNER/of-g1-fixture
    FIXTURE_NOTE="GitHub marketplace $FIXTURE_SRC (a git clone made by claude plugin marketplace add)"
  else
    FIXTURE_SRC=$W/fx/of-g1-fixture
    FIXTURE_NOTE="DIRECTORY marketplace at $FIXTURE_SRC (a local git working tree added by path; NOT a git clone, nothing pushed to GitHub)"
    for tool in git npm jq; do
      if ! command -v "$tool" > /dev/null 2>&1; then
        FIXTURE_OK=no
        echo "FAILED fixture cases: the image has no $tool (make-fixture.sh needs git, npm and jq); marker and ranged are not measured" >> "$FAILS"
        break
      fi
    done
    if [ "$FIXTURE_OK" = yes ]; then
      if bash /g1/fixture/make-fixture.sh "$W/fx" local-owner > "$W/make-fixture.log" 2>&1; then
        :
      else
        FIXTURE_OK=no
        echo "FAILED fixture build: make-fixture.sh exited non-zero: $(tail_err "$W/make-fixture.log")" >> "$FAILS"
      fi
    fi
  fi

  # ---- the cases (a failure is recorded and never stops the others)
  LABELS="superpowers skill-creator frontend-design"
  [ "$FIXTURE_OK" = yes ] && LABELS="$LABELS marker ranged"
  for label in $LABELS; do
    n=1
    while [ "$n" -le "$RUNS" ]; do
      case "$label" in
        superpowers) run_case "$label" obra/superpowers-marketplace superpowers-marketplace superpowers "$n" ;;
        skill-creator | frontend-design) run_case "$label" anthropics/claude-plugins-official claude-plugins-official "$label" "$n" ;;
        marker | ranged) run_case "$label" "$FIXTURE_SRC" fixture "$label" "$n" ;;
      esac
      n=$((n + 1))
    done
  done

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
    echo "- Cold cases: $RUNS runs each, fresh CLAUDE_CONFIG_DIR each run, DISABLE_AUTOUPDATER=1, no credentials. Times are min-max wall seconds over the runs that succeeded."
    echo "- Session-start init timing (extra time to init with the plugin installed, cold start): not measured here, it needs a credential."
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
  IMAGE=open-factory-base:dev RUNS=3 OWNER="" OUT=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --image) [ "$#" -ge 2 ] || die "--image needs a value"; IMAGE=$2; shift 2 ;;
      --runs) [ "$#" -ge 2 ] || die "--runs needs a value"; RUNS=$2; shift 2 ;;
      --github-owner) [ "$#" -ge 2 ] || die "--github-owner needs a value"; OWNER=$2; shift 2 ;;
      --out) [ "$#" -ge 2 ] || die "--out needs a value"; OUT=$2; shift 2 ;;
      -h | --help) sed -n '2,25p' "$SELF"; exit 0 ;;
      *) die "unknown argument: $1 (usage: scripts/g1/timing.sh [--image IMG] [--runs N] [--github-owner OWNER] [--out FILE])" ;;
    esac
  done
  case "$RUNS" in '' | *[!0-9]* | 0) die "--runs must be a positive integer" ;; esac
  case "$OWNER" in *[!A-Za-z0-9-]*) die "github owner must be letters, digits and dashes: $OWNER" ;; esac

  command -v docker > /dev/null 2>&1 || die "docker is not installed or not on PATH"
  PINNED=$(tr -d '[:space:]' < "$ROOT/images/base/claude-code-version")
  [ -n "$PINNED" ] || die "images/base/claude-code-version is empty"

  MODE=dir
  [ -n "$OWNER" ] && MODE=github

  # Exactly two env vars, nothing from the host; two read-only mounts.
  run() {
    docker run --rm --entrypoint bash \
      --env DISABLE_AUTOUPDATER=1 \
      --env CLAUDE_CONFIG_DIR=/tmp/g1-config \
      -v "$SELF:/g1/timing.sh:ro" \
      -v "$SELF_DIR/fixture:/g1/fixture:ro" \
      "$IMAGE" /g1/timing.sh --inside --image "$IMAGE" --pinned "$PINNED" --mode "$MODE" --owner "$OWNER" --runs "$RUNS"
  }
  if [ -n "$OUT" ]; then
    run | tee "$OUT"
    echo "timing: copy written to $OUT"
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
