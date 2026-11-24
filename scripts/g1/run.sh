#!/usr/bin/env bash
# Gate G1 (spec section 13): real Claude Code checks for I5's plugin design.
#
# Usage: scripts/g1/run.sh <github-owner>
#
# Run it with the exact Claude Code version in images/base/claude-code-version,
# with ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set, after pushing the
# fixture (scripts/g1/fixture/README.md). It writes report.md in its temp dir.
#
# Everything lives in one temp dir with a throwaway HOME and npm cache. The
# script runs real `claude` and uses the network (GitHub, the npm registry,
# Anthropic). It is written for macOS bash 3.2 and newer.
#
# Exit status is 0 when the script ran to the end (read report.md for FAILs),
# non-zero when it could not run.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd -P)
ROOT=$(cd "$HERE/../.." && pwd -P)

die() {
  echo "g1: $*" >&2
  exit 1
}

# ------------------------------------------------------------------ preflight
[ "$#" -eq 1 ] || die "usage: scripts/g1/run.sh <github-owner>"
OWNER=$1
case "$OWNER" in
  '' | *[!A-Za-z0-9-]*) die "github owner must be letters, digits and dashes: $OWNER" ;;
esac

# Never run against a HOME that holds the spike dir. Only its existence is
# tested; it is never read.
if [ -n "${HOME:-}" ] && [ -e "$HOME/.open-factory-spike" ]; then
  die "HOME ($HOME) contains .open-factory-spike; refusing to run. Use another HOME."
fi

for tool in claude jq git node npm find pkill sed awk; do
  command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool"
done
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  die "set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (item 18 needs a token-signed-in agent)"
fi

PINNED=$(tr -d '[:space:]' < "$ROOT/images/base/claude-code-version")
[ -n "$PINNED" ] || die "images/base/claude-code-version is empty"

# From here on nothing touches the real HOME or the real npm cache.
T=$(mktemp -d "${TMPDIR:-/tmp}/of-g1.XXXXXX")
T=$(cd "$T" && pwd -P)
export HOME=$T/home
export npm_config_cache=$T/npm-cache
export GIT_TERMINAL_PROMPT=0
mkdir -p "$HOME" "$npm_config_cache"

CLAUDE_VERSION=$(claude --version | awk '{print $1}')
PROBE_NOTE=""
if [ "$CLAUDE_VERSION" != "$PINNED" ]; then
  if [ -n "${G1_FLOOR_PROBE:-}" ]; then
    # Item 19 only: an older version, to find the floor. Not an authoritative run.
    PROBE_NOTE="
**FLOOR PROBE** (G1_FLOOR_PROBE set): run on $CLAUDE_VERSION, not the pinned $PINNED. This is item 19 evidence only; it is not the Gate G1 run.
"
  else
    die "claude is $CLAUDE_VERSION but images/base/claude-code-version pins $PINNED; install that exact version. (For item 19 only, G1_FLOOR_PROBE=1 allows another version.)"
  fi
fi

# ------------------------------------------------------------------- layout
S=$T/s                       # one dir per item
RES=$T/results               # one file per item, assembled into report.md
FX=$T/fx                     # the fixture, built by make-fixture.sh
MARK=$T/mark                 # plugin code writes a file here when it runs
SEED=$T/store                # the plugin store, a Claude Code seed (read-only)
PRISTINE=$T/store-pristine   # copy of the store as built; restored between items
RUNNER=$T/runner-config      # CLAUDE_CONFIG_DIR of the store runner
EMPTY=$T/empty               # cwd of the store runner
EV=$T/evidence.tmp
PROMPT='Reply with the single word ok.'
mkdir -p "$S" "$RES" "$MARK" "$RUNNER" "$EMPTY"   # MARK up front: set -eu safe
: > "$EV"
: > "$T/summary.tsv"
: > "$T/constants.txt"
AG=""
W=""

echo "g1: work dir $T"
echo "g1: claude $CLAUDE_VERSION (pinned $PINNED)"

# ------------------------------------------------------------- small helpers
ev() { printf '%s\n' "$*" >> "$EV"; }

evf() { # <label> <file>: indented, capped excerpt of a file
  ev "$1:"
  if [ -s "$2" ]; then
    head -n 40 "$2" | cut -c1-300 | sed 's/^/    /' >> "$EV"
  else
    ev "    (empty)"
  fi
}

record() { # <id> <PASS|FAIL|RECORDED|MANUAL> <title>: file the evidence gathered so far
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$T/summary.tsv"
  {
    printf '### %s. %s\n\nStatus: **%s**\n\n```\n' "$1" "$3" "$2"
    cat "$EV"
    printf '```\n\n'
  } > "$RES/$1.md"
  : > "$EV"
  printf '[%s] %s: %s\n' "$2" "$1" "$3"
}

const() { printf '%s\n' "$*" >> "$T/constants.txt"; }

mark_clear() {
  mkdir -p "$MARK"
  find "$MARK" -mindepth 1 -delete
}

mark_list() { ls -A "$MARK" | paste -s -d, -; }

stamp() { # <file>: an mtime that every later write is newer than
  sleep 1
  touch "$1"
  sleep 1
}

# run_limited <seconds> <command...>: a timeout that works without GNU timeout.
run_limited() {
  local secs=$1 pid watcher rc=0
  shift
  "$@" &
  pid=$!
  ( sleep "$secs"; pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  watcher=$!
  wait "$pid" || rc=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  return "$rc"
}

seed_rw() { chmod -R u+w "$SEED"; }
seed_ro() { chmod -R a-w "$SEED"; }

reset_seed() { # back to the store as built, read-only
  chmod -R u+w "$SEED" 2>/dev/null || true
  rm -rf "$SEED"
  cp -a "$PRISTINE" "$SEED"
  seed_ro
}

clone_dir() { jq -r --arg n "$1" '.[$n].installLocation' "$SEED/known_marketplaces.json"; }
clone_head() { git -C "$(clone_dir "$1")" rev-parse HEAD; }

fresh_ws() { # <name>: new workdir W (no .claude settings) and agent config dir AG
  W=$T/w/$1
  AG=$T/ag/$1
  chmod -R u+w "$W" "$AG" 2>/dev/null || true
  rm -rf "$W" "$AG"
  mkdir -p "$W" "$AG/plugins" "$AG/skills"
  mark_clear
}

# What spec 7.3 step 3 does at every start: the agent's plugins folder is
# emptied except data/, and its skills, agents and commands folders are emptied.
scrub_agent() { # <ag>
  mkdir -p "$1/plugins" "$1/skills" "$1/agents" "$1/commands"
  find "$1/plugins" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
  find "$1/skills" "$1/agents" "$1/commands" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
}

# --------------------------------------------------------------- claude runs
# The store runner, as spec 7.2 runs it: CLAUDE_CODE_PLUGIN_CACHE_DIR is the
# store, its own CLAUDE_CONFIG_DIR, an empty cwd, an env of exactly PATH, HOME
# and DISABLE_AUTOUPDATER (plus MARK and the npm cache, so a leak of plugin
# code is visible and nothing writes to the real npm cache), and
# CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 for install and update.
# STORE and RCFG may be set per call to point at a preview copy.
runner_cmd() { # <traffic-off|traffic-on> <claude args...>
  local mode=$1
  shift
  local -a e=(
    PATH="$PATH" HOME="$HOME" MARK="$MARK" npm_config_cache="$npm_config_cache"
    CLAUDE_CODE_PLUGIN_CACHE_DIR="${STORE:-$SEED}"
    CLAUDE_CONFIG_DIR="${RCFG:-$RUNNER}"
    DISABLE_AUTOUPDATER=1
  )
  if [ "$mode" = traffic-off ]; then
    e+=(CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1)
  fi
  env -i "${e[@]}" sh -c 'cd "$0" && exec claude "$@"' "$EMPTY" "$@"
}

rr() { # <outfile> <mode> <claude args...>: run, log, never fail; last line is exit=N
  local out=$1 rc=0
  shift
  run_limited 240 runner_cmd "$@" > "$out" 2>&1 || rc=$?
  printf 'exit=%s\n' "$rc" >> "$out"
}

rr_rc() { tail -n 1 "$1" | sed 's/^exit=//'; }

# The agent, as spec 7.3 builds it: CLAUDE_CONFIG_DIR=$AG (read from AG),
# CLAUDE_CODE_PLUGIN_SEED_DIR, DISABLE_AUTOUPDATER=1, an env of PATH and HOME
# plus MARK and the caller's credential. G1_EXTRA ("A=1 B=2") adds variables.
# This function is copied into $T/agent.sh for the manual items.
agent_cmd() { # <workdir> <claude args...>
  local w=$1
  shift
  local -a e=(
    PATH="$PATH" HOME="$HOME" MARK="$MARK"
    CLAUDE_CONFIG_DIR="${AG:?AG is not set}"
    CLAUDE_CODE_PLUGIN_SEED_DIR="$SEED"
    DISABLE_AUTOUPDATER=1
  )
  local v
  for v in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN; do
    if [ -n "${!v:-}" ]; then
      e+=("$v=${!v}")
    fi
  done
  # shellcheck disable=SC2086
  for v in ${G1_EXTRA:-}; do
    e+=("$v")
  done
  env -i "${e[@]}" sh -c 'cd "$0" && exec claude "$@"' "$w" "$@"
}

{
  printf '#!/usr/bin/env bash\n# usage: AG=<agent config dir> agent.sh <workdir> <claude args...>\nset -eu\n'
  declare -p HOME SEED MARK
  declare -f agent_cmd
  printf 'agent_cmd "$@"\n'
} > "$T/agent.sh"
chmod +x "$T/agent.sh"

# agent_run <dir> <workdir> <settings.json> <prompt> [claude args...]
# Captures the whole stream (never `head`, which can kill the run before hooks
# and MCP write) and selects init from it with jq.
agent_run() {
  local dir=$1 w=$2 settings=$3 prompt=$4 rc=0
  shift 4
  mkdir -p "$dir"
  rm -f "$dir/exit.txt"
  run_limited "${AGENT_LIMIT:-300}" agent_cmd "$w" -p "$prompt" \
    --output-format stream-json --verbose --settings "$(cat "$settings")" "$@" \
    > "$dir/out.jsonl" 2> "$dir/stderr.txt" || rc=$?
  echo "$rc" > "$dir/exit.txt"
  jq -c 'select(.type=="system" and .subtype=="init")' "$dir/out.jsonl" > "$dir/init.json" 2>/dev/null || true
}

# --------------------------------------------------------------- init helpers
plugin_names() { # <init.json> -> sorted comma list, marketplace suffix dropped
  jq -r '.plugins[]? | (if type=="object" then .name else . end) | sub("@.*$";"")' "$1" 2>/dev/null \
    | sort -u | paste -s -d, -
}

plugin_paths() { # <init.json>
  jq -r '.plugins[]? | (if type=="object" then (.path // "") else "" end)' "$1" 2>/dev/null
}

has_plugin() { # <init.json> <name>
  case ",$(plugin_names "$1")," in
    *",$2,"*) return 0 ;;
  esac
  return 1
}

evi() { # <label> <init.json>: what an init event says about plugins and servers
  ev "$1:"
  if [ -s "$2" ]; then
    ev "    plugins: $(jq -c '.plugins' "$2")"
    ev "    mcp_servers: $(jq -c '.mcp_servers' "$2")"
    ev "    agents: $(jq -c '.agents' "$2")"
    ev "    slash_commands: $(jq -c '.slash_commands' "$2" | cut -c1-400)"
  else
    ev "    NO init event in the stream (see out.jsonl and stderr.txt under $(dirname "$2"))"
  fi
}

# --------------------------------------------------------------- settings
# enabled_json <true-key...>: the enabledPlugins object of spec 7.3 step 7:
# true for the keys given, an explicit false for every other plugin of every
# marketplace in the store (from each catalog and from what is installed).
enabled_json() {
  local trues all
  trues=$(printf '%s\n' "$@" | jq -R . | jq -s -c .)
  all=$(
    jq -r 'to_entries[] | "\(.key)\t\(.value.installLocation)"' "$SEED/known_marketplaces.json" |
      while IFS="$(printf '\t')" read -r mkt loc; do
        jq -r --arg m "$mkt" '.plugins[]?.name | "\(.)@\($m)"' "$loc/.claude-plugin/marketplace.json"
      done
    jq -r '.plugins | keys[]' "$SEED/installed_plugins.json"
  )
  printf '%s\n%s\n' "$all" "$(printf '%s\n' "$@")" |
    jq -R -s -c --argjson t "$trues" '
      split("\n") | map(select(length > 0)) | unique
      | map(. as $k | {($k): ($t | index($k) != null)}) | add'
}

# make_settings <outfile> <enabledPlugins json> <marketplace name...>: the inline
# --settings JSON of spec 7.3 step 7. extraKnownMarketplaces holds, for each
# marketplace named, the exact source the seed recorded plus autoUpdate: false.
make_settings() {
  local out=$1 enabled=$2 mk='{}' name
  shift 2
  for name in "$@"; do
    mk=$(jq -c --arg n "$name" --slurpfile k "$SEED/known_marketplaces.json" \
      '. + {($n): {source: $k[0][$n].source, autoUpdate: false}}' <<< "$mk")
  done
  jq -n -c --argjson e "$enabled" --argjson m "$mk" \
    '{enabledPlugins: $e, extraKnownMarketplaces: $m, syncClaudeAiPlugins: false}' > "$out"
}

# marker and dep true, everything else false, the fixture marketplace declared.
base_settings() { make_settings "$1" "$(enabled_json marker@fixture dep@fixture)" fixture; }

# ---------------------------------------------------------------- the seed
detach_behind() { # <clone>: as the factory pins it, one commit behind origin
  local d=$1
  if ! git -C "$d" rev-parse -q --verify 'HEAD~1' > /dev/null 2>&1; then
    git -C "$d" fetch -q --deepen=2 # a shallow clone has no parent yet
  fi
  git -C "$d" checkout -q --detach 'HEAD~1'
}

verify_remote() { # <owner/repo> <sha>
  local got
  got=$(git ls-remote "https://github.com/$1.git" refs/heads/main | awk '{print $1}')
  [ "$got" = "$2" ] || die "origin/main of $1 is '${got:-missing}', expected $2. Push the fixture (scripts/g1/fixture/README.md)."
}

build_seed() {
  local d=$S/00
  mkdir -p "$d"
  chmod -R u+w "$SEED" 2>/dev/null || true
  rm -rf "$SEED" "$PRISTINE"
  mkdir -p "$SEED"
  mark_clear
  rr "$d/add-fixture.txt" traffic-on plugin marketplace add "$OWNER/of-g1-fixture"
  rr "$d/add-localdir.txt" traffic-on plugin marketplace add "$FX/localdir"
  rr "$d/add-official.txt" traffic-on plugin marketplace add anthropics/claude-plugins-official
  [ -s "$SEED/known_marketplaces.json" ] || die "no $SEED/known_marketplaces.json after marketplace add; see $d"
  for m in fixture localdir claude-plugins-official; do
    jq -e --arg m "$m" 'has($m)' "$SEED/known_marketplaces.json" > /dev/null || die "marketplace $m was not registered; see $d"
  done
  # Pin every clone one commit behind origin, so "doesn't pull" can fail.
  detach_behind "$(clone_dir fixture)"
  detach_behind "$(clone_dir claude-plugins-official)"
  rr "$d/install-marker.txt" traffic-off plugin install marker@fixture
  rr "$d/install-dep.txt" traffic-off plugin install dep@fixture
  rr "$d/install-skill-creator.txt" traffic-off plugin install skill-creator@claude-plugins-official
  for k in marker@fixture dep@fixture skill-creator@claude-plugins-official; do
    jq -e --arg k "$k" '.plugins | has($k)' "$SEED/installed_plugins.json" > /dev/null || die "$k did not install; see $d"
  done
  mark_list > "$d/mark-after-build.txt"
  cp -a "$SEED" "$PRISTINE"
  seed_ro
}

# --------------------------------------------------------------- the items
# Control (not a spec item): proves the markers can fire, so an empty $MARK
# elsewhere means something.
item00() {
  local d=$S/00/control
  fresh_ws c00
  reset_seed
  base_settings "$d.json"
  agent_run "$d" "$W" "$d.json" 'Run the shell command x with the Bash tool, then reply ok.' --allowedTools Bash
  evi "init" "$d/init.json"
  ev "markers written: $(mark_list)"
  ev "expected when everything works: hook-sessionstart, mcp-start, bin-x, monitor"
  evf "stderr" "$d/stderr.txt"
  case ",$(mark_list)," in
    *,hook-sessionstart,*) record 00 RECORDED "Control: marker plugin code can write to MARK (not a spec item)" ;;
    *) record 00 FAIL "Control: the SessionStart hook wrote nothing, so empty-MARK checks prove nothing" ;;
  esac
}

item01() {
  local d=$S/01 bad=0 n=0 p names status=PASS
  fresh_ws s01
  reset_seed
  mkdir -p "$d"

  # a. marker and dep true, skill-creator explicitly false.
  base_settings "$d/a.json"
  agent_run "$d/a" "$W" "$d/a.json" "$PROMPT"
  names=$(plugin_names "$d/a/init.json")
  while IFS= read -r p; do
    n=$((n + 1))
    case "$p" in "$SEED"/*) ;; *) bad=$((bad + 1)) ;; esac
  done < <(plugin_paths "$d/a/init.json")
  evi "(a) marker+dep true, skill-creator false" "$d/a/init.json"
  ev "(a) plugin names: [$names]; plugin paths: $n, outside \$SEED: $bad"
  if [ "$names" != "dep,marker" ] || [ "$n" -ne 2 ] || [ "$bad" -ne 0 ]; then
    status=FAIL
  fi

  # b. skill-creator's entry removed (no explicit false): does it load?
  fresh_ws s01b
  enabled_json marker@fixture dep@fixture | jq -c 'del(.["skill-creator@claude-plugins-official"])' > "$d/b-enabled.json"
  make_settings "$d/b.json" "$(cat "$d/b-enabled.json")" fixture
  agent_run "$d/b" "$W" "$d/b.json" "$PROMPT"
  evi "(b) skill-creator entry removed" "$d/b/init.json"
  if has_plugin "$d/b/init.json" skill-creator; then
    ev "(b) RECORDED: skill-creator LOADS without an enabledPlugins entry (defaultEnabled applies)"
  else
    ev "(b) RECORDED: skill-creator does NOT load without an entry"
  fi

  # c. dep false: marker should fail to load (dependencies must be enabled, R13).
  fresh_ws s01c
  make_settings "$d/c.json" "$(enabled_json marker@fixture)" fixture
  agent_run "$d/c" "$W" "$d/c.json" "$PROMPT"
  evi "(c) dep false" "$d/c/init.json"
  if has_plugin "$d/c/init.json" marker; then
    ev "(c) RECORDED: marker LOADS with dep false (dependencies are NOT required to be enabled)"
  else
    ev "(c) RECORDED: marker does NOT load with dep false (dependencies must be enabled)"
  fi
  grep -i -h -m3 'dependenc' "$d/c/stderr.txt" "$d/c/out.jsonl" 2>/dev/null | cut -c1-300 | sed 's/^/    /' >> "$EV" || true
  record 01 "$status" "Only enabled plugins load (a asserts; b and c are recorded)"
}

item02() {
  local d=$S/02 mode newer status=PASS
  fresh_ws s02
  mkdir -p "$d"
  base_settings "$d/settings.json"
  for mode in readonly writable; do
    reset_seed
    if [ "$mode" = writable ]; then seed_rw; fi # as during a store operation
    stamp "$d/t0-$mode"
    agent_run "$d/$mode" "$W" "$d/settings.json" "$PROMPT"
    newer=$(find "$SEED" -newer "$d/t0-$mode" 2>/dev/null || true)
    evi "seed $mode" "$d/$mode/init.json"
    if [ -n "$newer" ]; then
      status=FAIL
      ev "seed $mode: FILES NEWER THAN t0:"
      printf '%s\n' "$newer" | head -n 20 | sed 's/^/    /' >> "$EV"
    else
      ev "seed $mode: find \$SEED -newer t0 is empty"
    fi
  done
  reset_seed
  record 02 "$status" "The seed is never written (read-only and writable)"
}

item03() {
  local d=$S/03 clone h0 h1 h2 shaext_rc status=PASS
  reset_seed
  seed_rw
  mkdir -p "$d"
  clone=$(clone_dir fixture)
  h0=$(git -C "$clone" rev-parse HEAD)
  ev "fixture clone starts detached at $h0 (first commit is $FIXTURE_FIRST, tip is $FIXTURE_HEAD)"

  # With CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 (as the factory runs install).
  stamp "$d/t0-off"
  rr "$d/off-1.txt" traffic-off plugin install ranged@fixture
  rr "$d/off-2.txt" traffic-off plugin install marker@fixture
  rr "$d/off-3.txt" traffic-off plugin uninstall ranged@fixture
  rr "$d/off-4.txt" traffic-off plugin install ranged@fixture
  h1=$(git -C "$clone" rev-parse HEAD)
  ev "with the variable: HEAD after four install/uninstall runs = $h1"
  ev "with the variable: .git files newer than t0: $(find "$clone/.git" -newer "$d/t0-off" -type f 2>/dev/null | wc -l | tr -d ' ')"
  evf "install ranged (variable set)" "$d/off-1.txt"
  if [ "$h1" != "$h0" ]; then status=FAIL; fi

  # Without the variable: record whether it moves.
  stamp "$d/t0-on"
  rr "$d/on-1.txt" traffic-on plugin uninstall ranged@fixture
  rr "$d/on-2.txt" traffic-on plugin install ranged@fixture
  h2=$(git -C "$clone" rev-parse HEAD)
  if [ "$h2" = "$h0" ]; then
    ev "without the variable: RECORDED HEAD did NOT move ($h2)"
  else
    ev "without the variable: RECORDED HEAD MOVED to $h2"
  fi
  ev "without the variable: .git files newer than t0: $(find "$clone/.git" -newer "$d/t0-on" -type f 2>/dev/null | wc -l | tr -d ' ')"
  evf "install ranged (variable unset)" "$d/on-2.txt"

  # An external source with a sha, with the variable set.
  rr "$d/shaext.txt" traffic-off plugin install shaext@fixture
  shaext_rc=$(rr_rc "$d/shaext.txt")
  ev "external source with sha (shaext@fixture), variable set: exit=$shaext_rc, installed=$(jq -r '.plugins | has("shaext@fixture")' "$SEED/installed_plugins.json")"
  evf "install shaext" "$d/shaext.txt"
  reset_seed
  record 03 "$status" "Install doesn't pull (variable set asserts; the rest is recorded)"
}

item04() {
  local d=$S/04 fh fo fh2 fo2 fnew onew status=PASS
  reset_seed
  seed_rw # worst case: a pull could succeed
  fresh_ws s04
  mkdir -p "$d"
  fh=$(clone_head fixture)
  fo=$(clone_head claude-plugins-official)
  make_settings "$d/settings.json" "$(enabled_json marker@fixture dep@fixture)" fixture claude-plugins-official
  ev "declaration without ref: $(jq -c '.extraKnownMarketplaces' "$d/settings.json" | cut -c1-300)"
  stamp "$d/t0"
  agent_run "$d/net" "$W" "$d/settings.json" "$PROMPT"
  fh2=$(clone_head fixture)
  fo2=$(clone_head claude-plugins-official)
  fnew=$(find "$(clone_dir fixture)/.git" -newer "$d/t0" -type f 2>/dev/null | wc -l | tr -d ' ')
  onew=$(find "$(clone_dir claude-plugins-official)/.git" -newer "$d/t0" -type f 2>/dev/null | wc -l | tr -d ' ')
  ev "network on: fixture HEAD $fh -> $fh2 (.git files newer: $fnew); official HEAD $fo -> $fo2 (.git files newer: $onew)"
  grep -i -h -m10 -E 'clon|fetch|pull|refresh|updat' "$d/net/stderr.txt" 2>/dev/null | cut -c1-300 | sed 's/^/    stderr: /' >> "$EV" || true
  if [ "$fh" != "$fh2" ] || [ "$fo" != "$fo2" ] || [ "$fnew" != 0 ] || [ "$onew" != 0 ]; then status=FAIL; fi

  # The official marketplace again with the network blocked (a dead proxy).
  stamp "$d/t0-blocked"
  AGENT_LIMIT=120 G1_EXTRA="HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 NO_PROXY=" \
    agent_run "$d/blocked" "$W" "$d/settings.json" "$PROMPT"
  fo2=$(clone_head claude-plugins-official)
  onew=$(find "$(clone_dir claude-plugins-official)/.git" -newer "$d/t0-blocked" -type f 2>/dev/null | wc -l | tr -d ' ')
  ev "network blocked (dead proxy): official HEAD -> $fo2 (.git files newer: $onew); init event present: $([ -s "$d/blocked/init.json" ] && echo yes || echo no)"
  grep -i -h -m10 -E 'clon|fetch|pull|refresh|updat|network|ECONN' "$d/blocked/stderr.txt" 2>/dev/null | cut -c1-300 | sed 's/^/    stderr: /' >> "$EV" || true
  if [ "$fo" != "$fo2" ] || [ "$onew" != 0 ]; then status=FAIL; fi
  reset_seed
  record 04 "$status" "A ref-less declaration doesn't refetch (fixture and official, network on and blocked)"
}

item05() {
  local d=$S/05 cmds
  fresh_ws s05
  reset_seed
  mkdir -p "$d" "$W/.claude/skills"
  cp -a "$FX/extras/skill-foo" "$W/.claude/skills/foo"
  base_settings "$d/settings.json"
  agent_run "$d/run" "$W" "$d/settings.json" "$PROMPT"
  cmds=$(jq -r '.slash_commands[]?' "$d/run/init.json" 2>/dev/null || true)
  evi ".claude/skills/foo/SKILL.md with name: bar" "$d/run/init.json"
  if printf '%s\n' "$cmds" | grep -q -x -E '/?foo'; then ev "slash_commands has foo"; else ev "slash_commands has no foo"; fi
  if printf '%s\n' "$cmds" | grep -q -x -E '/?bar'; then ev "slash_commands has bar"; else ev "slash_commands has no bar"; fi
  record 05 RECORDED "Skill naming: directory name (foo) or frontmatter name (bar) in slash_commands"
}

item06() {
  local d=$S/06 pre_visible=no post_dirty=no
  fresh_ws s06
  reset_seed # read-only, as an agent sees it
  mkdir -p "$d"
  base_settings "$d/settings.json"

  # The agent installs and adds a marketplace itself, in its own config dir.
  AG=$AG agent_cmd "$W" plugin install skill-creator@claude-plugins-official > "$d/agent-install.txt" 2>&1 || echo "exit=$?" >> "$d/agent-install.txt"
  AG=$AG agent_cmd "$W" plugin marketplace add "$OWNER/of-g1-other" > "$d/agent-mkt-add.txt" 2>&1 || echo "exit=$?" >> "$d/agent-mkt-add.txt"
  AG=$AG agent_cmd "$W" plugin list > "$d/pre-list.txt" 2>&1 || true
  AG=$AG agent_cmd "$W" plugin marketplace list > "$d/pre-mkt.txt" 2>&1 || true
  find "$AG/plugins" -maxdepth 3 | sed "s#^$AG/##" | sort > "$d/pre-find.txt"
  evf "agent: plugin install skill-creator" "$d/agent-install.txt"
  evf "agent: marketplace add other repo" "$d/agent-mkt-add.txt"
  evf "before scrub: marketplace list" "$d/pre-mkt.txt"
  evf "before scrub: files under AG/plugins" "$d/pre-find.txt"
  if grep -q 'evil' "$d/pre-mkt.txt" || [ -n "$(find "$AG/plugins/cache" -type f 2>/dev/null | head -n 1)" ]; then pre_visible=yes; fi

  # Scrub as 7.3 does, then run again.
  scrub_agent "$AG"
  agent_run "$d/run" "$W" "$d/settings.json" "$PROMPT"
  AG=$AG agent_cmd "$W" plugin list > "$d/post-list.txt" 2>&1 || true
  AG=$AG agent_cmd "$W" plugin marketplace list > "$d/post-mkt.txt" 2>&1 || true
  find "$AG/plugins" -maxdepth 3 | sed "s#^$AG/##" | sort > "$d/post-find.txt"
  evf "after scrub: plugin list" "$d/post-list.txt"
  evf "after scrub: marketplace list" "$d/post-mkt.txt"
  evf "after scrub: files under AG/plugins" "$d/post-find.txt"
  evi "after scrub: init" "$d/run/init.json"
  if grep -q 'evil' "$d/post-mkt.txt" || grep -q "$AG/plugins/cache" "$d/post-list.txt" \
    || [ -n "$(find "$AG/plugins/cache" -type f 2>/dev/null | head -n 1)" ]; then
    post_dirty=yes
  fi
  ev "agent's own install visible before the scrub: $pre_visible; anything of it after: $post_dirty"
  if [ "$post_dirty" = yes ]; then
    record 06 FAIL "An agent's own install and marketplace add persisted past the scrub"
  elif [ "$pre_visible" = no ]; then
    record 06 RECORDED "An agent's own install: nothing was visible even before the scrub (check is vacuous; see evidence)"
  else
    record 06 PASS "An agent's own install doesn't persist (neither shows after the scrub)"
  fi
}

# Used by items 7 and 8's evidence.
item07() {
  local d=$S/07 data existed=no status=PASS
  fresh_ws s07
  reset_seed
  mkdir -p "$d"
  base_settings "$d/settings.json"
  agent_run "$d/first" "$W" "$d/settings.json" "$PROMPT"
  evi "first run" "$d/first/init.json"
  set -- "$AG"/plugins/data/marker*/x
  data=$1
  if [ -e "$data" ]; then
    ev "marker's MCP server wrote $data (content: $(tr -d '\n' < "$data")); the data dir is per-agent and writable"
  else
    ev "NO \$AG/plugins/data/marker*/x after the run: find output:"
    find "$AG/plugins" -maxdepth 4 | sed "s#^$AG/##" | head -n 20 | sed 's/^/    /' >> "$EV"
    status=FAIL
  fi
  # Delete mcpb/ and run again: does the MCP server still start?
  if [ -d "$AG/plugins/mcpb" ]; then existed=yes; fi
  ev "AG/plugins/mcpb existed after the first run: $existed (marker's server is a plain .mcp.json server, so Claude may never create it; see the report's note)"
  rm -rf "$AG/plugins/mcpb"
  mark_clear
  agent_run "$d/second" "$W" "$d/settings.json" "$PROMPT"
  evi "second run, after deleting AG/plugins/mcpb" "$d/second/init.json"
  ev "RECORDED: mcp-start marker after the second run: $([ -e "$MARK/mcp-start" ] && echo yes || echo no); AG/plugins/mcpb exists again: $([ -d "$AG/plugins/mcpb" ] && echo yes || echo no)"
  const "mcpb/ (item 7): existed=$existed; marker's MCP server started again after deleting mcpb/: $([ -e "$MARK/mcp-start" ] && echo yes || echo no); mcpb/ recreated: $([ -d "$AG/plugins/mcpb" ] && echo yes || echo no). Decides whether R1's scrub of mcpb/ is safe (B7)."
  record 07 "$status" "data/ is per-agent and writable (asserts); mcpb/ deletion recorded"
}

item10() {
  local d=$S/10 clone before_ver after_ver
  reset_seed
  seed_rw
  mkdir -p "$d"
  clone=$(clone_dir fixture)
  git -C "$clone" checkout -q --detach "$FIXTURE_HEAD" # the second commit, pinned
  ev "clone pinned to the second commit $FIXTURE_HEAD (was $FIXTURE_FIRST)"
  before_ver=$(ls "$SEED/cache/fixture/marker" 2>/dev/null | paste -s -d, -)
  ev "before: cache/fixture/marker versions: [$before_ver]"
  ev "before: installed marker: $(jq -c '.plugins["marker@fixture"]' "$SEED/installed_plugins.json")"
  mark_clear
  stamp "$d/t0"
  rr "$d/update.txt" traffic-off plugin update marker@fixture
  mark_list > "$d/mark-after-update.txt"
  after_ver=$(ls "$SEED/cache/fixture/marker" 2>/dev/null | paste -s -d, -)
  ev "after: clone HEAD $(git -C "$clone" rev-parse HEAD) (pinned $FIXTURE_HEAD; pulls: $([ "$(git -C "$clone" rev-parse HEAD)" = "$FIXTURE_HEAD" ] && echo no || echo YES))"
  ev "after: cache/fixture/marker versions: [$after_ver]"
  ev "after: installed marker: $(jq -c '.plugins["marker@fixture"]' "$SEED/installed_plugins.json")"
  ev ".orphaned_at markers: $(find "$SEED/cache" -name .orphaned_at 2>/dev/null | sed "s#^$SEED/##" | paste -s -d, -)"
  ev "new files since t0 (cache): $(find "$SEED/cache" -newer "$d/t0" -maxdepth 4 2>/dev/null | sed "s#^$SEED/##" | head -n 12 | paste -s -d, -)"
  evf "claude plugin update output" "$d/update.txt"
  const "update path (item 10): versions before [$before_ver] after [$after_ver]; orphaned: $(find "$SEED/cache" -name .orphaned_at 2>/dev/null | wc -l | tr -d ' ') marker(s); update with the second commit pinned and the traffic variable set: see item 10. Decides update vs uninstall plus install (B6)."
  reset_seed
  record 10 RECORDED "The plugin update path (pull, where the new version lands, .orphaned_at)"
}

item08() {
  local d=$S/08 status=PASS list
  reset_seed
  seed_rw
  mkdir -p "$d"
  list=$(cat "$S/00/mark-after-build.txt")
  ev "after the seed build (marketplace adds, installs of marker with its dependency dep, and skill-creator): MARK=[$list]"
  [ -z "$list" ] || status=FAIL

  rr "$d/u1.txt" traffic-off plugin uninstall ranged@fixture
  rr "$d/u2.txt" traffic-off plugin uninstall marker@fixture
  rr "$d/u3.txt" traffic-off plugin uninstall dep@fixture
  mark_clear
  rr "$d/i1.txt" traffic-off plugin install marker@fixture # installs dep as a dependency
  test -z "$(ls -A "$MARK")" || status=FAIL
  ev "after install marker@fixture (and its dependency dep): MARK=[$(mark_list)] (exit $(rr_rc "$d/i1.txt"))"
  rr "$d/i2.txt" traffic-off plugin install ranged@fixture # a dependency install by range
  test -z "$(ls -A "$MARK")" || status=FAIL
  ev "after install ranged@fixture (dependency by range): MARK=[$(mark_list)] (exit $(rr_rc "$d/i2.txt"))"
  ev "installed: $(jq -c '.plugins | keys' "$SEED/installed_plugins.json")"
  list=$(cat "$S/10/mark-after-update.txt" 2>/dev/null || echo "item 10 did not run")
  ev "after update marker@fixture (item 10): MARK=[$list]"
  [ -z "$list" ] || status=FAIL
  ev "(if FAIL: T7 changes; the markers show which code path ran)"
  reset_seed
  record 08 "$status" "Install and update run no plugin code (MARK empty)"
}

item09() {
  local d=$S/09 where flag loaded
  reset_seed
  mkdir -p "$d"
  for where in a b c; do
    for flag in default false; do
      fresh_ws "s09$where$flag"
      case "$where" in
        a) mkdir -p "$W/.claude/skills"; cp -a "$FX/extras/sneaky" "$W/.claude/skills/sneaky" ;;
        b) mkdir -p "$AG/skills"; cp -a "$FX/extras/sneaky" "$AG/skills/sneaky" ;;
        c)
          mkdir -p "$W/.claude/skills" "$d/outside-$flag"
          cp -a "$FX/extras/sneaky" "$d/outside-$flag/sneaky"
          ln -s "$d/outside-$flag/sneaky" "$W/.claude/skills/sneaky"
          ;;
      esac
      base_settings "$d/$where-$flag-settings.json"
      if [ "$flag" = false ]; then
        jq -c '.enabledPlugins["sneaky@skills-dir"] = false' "$d/$where-$flag-settings.json" > "$d/tmp.json"
        mv "$d/tmp.json" "$d/$where-$flag-settings.json"
      fi
      agent_run "$d/$where-$flag" "$W" "$d/$where-$flag-settings.json" "$PROMPT"
      loaded=no
      if has_plugin "$d/$where-$flag/init.json" sneaky || [ -e "$MARK/sneaky" ]; then loaded=yes; fi
      case "$where" in
        a) ev "(a) \$W/.claude/skills/sneaky, settings $flag: loaded=$loaded (init lists: [$(plugin_names "$d/$where-$flag/init.json")], hook marker: $([ -e "$MARK/sneaky" ] && echo yes || echo no))" ;;
        b) ev "(b) \$AG/skills/sneaky (user level), settings $flag: loaded=$loaded (init lists: [$(plugin_names "$d/$where-$flag/init.json")], hook marker: $([ -e "$MARK/sneaky" ] && echo yes || echo no))" ;;
        c) ev "(c) link in \$W/.claude/skills, settings $flag: loaded=$loaded (init lists: [$(plugin_names "$d/$where-$flag/init.json")], hook marker: $([ -e "$MARK/sneaky" ] && echo yes || echo no))" ;;
      esac
    done
  done
  ev "read: for each of a, b, c, 'loaded' under default settings answers whether it loads; 'false' stops it when loaded=no there."
  record 09 RECORDED "Skills-directory plugins: where they load, and whether sneaky@skills-dir:false stops them"
}

item11() {
  local d=$S/11 start end dur=0 newer clones_ok=yes new_versions
  fresh_ws s11
  reset_seed
  mkdir -p "$d"
  base_settings "$d/settings.json"
  # Item 16's project-level hooks and statusLine live in this workdir too, so
  # the one interactive session also covers item 16b.
  mkdir -p "$W/.claude"
  write_project_settings "$W/.claude/settings.json"
  cat > "$d/session.sh" <<EOF
#!/usr/bin/env bash
# The interactive agent session for items 11 and 16b. Run it in a real terminal.
date +%s > "$d/times.txt"
AG="$AG" "$T/agent.sh" "$W" --settings "\$(cat "$d/settings.json")" || true
date +%s >> "$d/times.txt"
EOF
  chmod +x "$d/session.sh"

  cat > "$d/instructions.txt" <<EOF
ITEMS 11 and 16b (manual, interactive): in a second terminal run

    bash $d/session.sh

It starts Claude Code interactively in the agent env (seed read-only,
--settings from plugin-settings, workdir $W with project-level hooks and a
statusLine).

 1. Send one message (for example "hi") and keep the session open for MORE than 10
    minutes (item 11: auto-update must stay off for the official marketplace).
 2. Item 16b, while it is open:
    a. Check that the project statusLine ran: ls $MARK  (expect project-statusline).
    b. Create $W/.claude/settings.local.json containing
       {"enabledPlugins":{"skill-creator@claude-plugins-official":true}}
       (the --settings value for that key is false). Without restarting, run
       /reload-plugins (note whether the command exists) and /plugin (or ask
       "list your skills"), and note whether skill-creator now loads.
 3. Exit with /exit. Write down the answers to 2a and 2b in the report.
EOF
  cat "$d/instructions.txt"

  stamp "$d/t0"
  if [ -t 0 ] && [ -z "${G1_NO_PROMPT:-}" ]; then
    printf '\nPress Enter here after the session has ended (or type skip to leave items 11 and 16b MANUAL): '
    read -r answer || answer=skip
  else
    answer=skip
  fi
  if [ "${answer:-}" = skip ] || [ ! -s "$d/times.txt" ] || [ "$(wc -l < "$d/times.txt" | tr -d ' ')" -lt 2 ]; then
    ev "Not run by run.sh (no interactive session finished). Instructions for Or:"
    sed 's/^/    /' "$d/instructions.txt" >> "$EV"
    ev "Then compare (the session start time is in $d/times.txt):"
    ev "    find $SEED -newer $d/t0   (empty)"
    ev "    ls $SEED/cache/*/*/ $AG/plugins/cache/*/*/   (no new versions)"
    record 11 MANUAL "Auto-update stays off for the official marketplace (a >10 minute interactive session)"
    ev "See the instructions under item 11, step 2: answer 2a (statusLine ran?) and 2b (mid-session enabledPlugins change effective? /reload-plugins interactively?)."
    record 16b MANUAL "Live reload: statusLine runs, enabledPlugins change mid-session, /reload-plugins interactive (Or fills in)"
    return 0
  fi
  start=$(sed -n 1p "$d/times.txt")
  end=$(sed -n 2p "$d/times.txt")
  dur=$((end - start))
  newer=$(find "$SEED" -newer "$d/t0" 2>/dev/null || true)
  new_versions=$(find "$SEED/cache" "$AG/plugins/cache" -mindepth 3 -maxdepth 3 -type d -newer "$d/t0" 2>/dev/null || true)
  [ "$(clone_head claude-plugins-official)" = "$(git -C "$PRISTINE/marketplaces/claude-plugins-official" rev-parse HEAD)" ] || clones_ok=no
  ev "session length: ${dur}s (needs at least 600)"
  ev "seed files newer than t0: $(printf '%s\n' "$newer" | grep -c . || true)"
  ev "new version dirs in the seed or AG/plugins/cache: [$(printf '%s\n' "$new_versions" | paste -s -d, -)]"
  ev "official clone HEAD unchanged: $clones_ok"
  if [ "$dur" -lt 600 ]; then
    record 11 RECORDED "Auto-update off for the official marketplace: session was ${dur}s, shorter than ten minutes, so the check is invalid"
  elif [ -z "$newer" ] && [ -z "$new_versions" ] && [ "$clones_ok" = yes ]; then
    record 11 PASS "Auto-update stays off for the official marketplace (interactive session over ten minutes)"
  else
    record 11 FAIL "Auto-update ran for the official marketplace (new files or versions after the session)"
  fi
  ev "Or: write down the answers to 2a and 2b of item 11's instructions here (statusLine ran? mid-session enabledPlugins change effective? /reload-plugins exists interactively?). MARK now: [$(mark_list)]"
  record 16b MANUAL "Live reload: statusLine runs, enabledPlugins change mid-session, /reload-plugins interactive (Or fills in)"
}

write_project_settings() { # <file>: item 16's project-level hooks and statusLine
  cat > "$1" <<'EOF'
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "mkdir -p \"$MARK\" && echo x >> \"$MARK/project-hook\"" } ] }
    ]
  },
  "statusLine": { "type": "command", "command": "mkdir -p \"$MARK\" && echo x >> \"$MARK/project-statusline\"; echo g1" }
}
EOF
}

item12() {
  local d=$S/12 winner fetched
  reset_seed
  mkdir -p "$d"

  # A. settings.local.json enables skill-creator; --settings says false.
  fresh_ws s12a
  mkdir -p "$W/.claude"
  printf '%s\n' '{"enabledPlugins":{"skill-creator@claude-plugins-official":true}}' > "$W/.claude/settings.local.json"
  base_settings "$d/a.json"
  agent_run "$d/a" "$W" "$d/a.json" "$PROMPT"
  evi "(A) settings.local.json true vs --settings false" "$d/a/init.json"
  if has_plugin "$d/a/init.json" skill-creator; then
    winner="settings.local.json wins: --settings is only a carrier, the 7.3 start check is what enforces the rule"
  else
    winner="--settings wins: it is a second layer behind the 7.3 start check"
  fi
  ev "(A) RECORDED: $winner"

  # B. settings.local.json declares a marketplace and enables x@evil.
  fresh_ws s12b
  mkdir -p "$W/.claude"
  jq -n -c --arg repo "$OWNER/of-g1-other" \
    '{extraKnownMarketplaces: {evil: {source: {source: "github", repo: $repo}}}, enabledPlugins: {"x@evil": true}}' \
    > "$W/.claude/settings.local.json"
  base_settings "$d/b.json"
  agent_run "$d/b" "$W" "$d/b.json" "$PROMPT"
  evi "(B) settings.local.json declares marketplace evil and enables x@evil" "$d/b/init.json"
  fetched=$(find "$AG" "$SEED" -iname '*evil*' 2>/dev/null | sed "s#^$T/##" | head -n 5 | paste -s -d, -)
  ev "(B) RECORDED: x loaded: $(has_plugin "$d/b/init.json" x && echo yes || echo no); x-hook marker: $([ -e "$MARK/x-hook" ] && echo yes || echo no); evil paths on disk (fetched?): [${fetched:-none}]"
  grep -i -h -m5 -E 'evil|marketplace|clon' "$d/b/stderr.txt" 2>/dev/null | cut -c1-300 | sed 's/^/    stderr: /' >> "$EV" || true
  record 12 RECORDED "Project and local settings: which wins for enabledPlugins, and whether an unregistered marketplace is fetched"
}

item13() {
  local d=$S/13
  fresh_ws s13
  reset_seed
  mkdir -p "$d"
  enabled_json marker@fixture dep@fixture | jq -c 'del(.["rel@localdir"])' > "$d/enabled.json"
  make_settings "$d/settings.json" "$(cat "$d/enabled.json")" fixture localdir
  ev "rel@localdir: not installed, not in enabledPlugins; localdir declared in extraKnownMarketplaces"
  agent_run "$d/run" "$W" "$d/settings.json" "$PROMPT"
  evi "init" "$d/run/init.json"
  ev "RECORDED: rel loads: $(has_plugin "$d/run/init.json" rel && echo yes || echo no); rel-hook marker: $([ -e "$MARK/rel-hook" ] && echo yes || echo no)"
  record 13 RECORDED "A directory marketplace's relative defaultEnabled plugin, not installed and not in enabledPlugins"
}

item14() {
  local d=$S/14 preview=$S/14/preview status=PASS diffs
  reset_seed
  mkdir -p "$d"
  cp -a "$SEED" "$preview"
  chmod -R u+w "$preview"
  for f in known_marketplaces.json installed_plugins.json; do
    sed "s#$SEED#$preview#g" "$preview/$f" > "$preview/$f.new"
    mv "$preview/$f.new" "$preview/$f"
  done
  ev "preview copy with installLocations rewritten: $(jq -c 'map_values(.installLocation)' "$preview/known_marketplaces.json" | cut -c1-300)"
  stamp "$d/t0"
  STORE=$preview rr "$d/install.txt" traffic-off plugin install ranged@fixture
  evf "install into the preview" "$d/install.txt"
  ev "preview installed keys: $(jq -c '.plugins | keys' "$preview/installed_plugins.json")"
  ev "preview paths outside the preview: $(jq -r '.plugins[][]?.installPath' "$preview/installed_plugins.json" | grep -c -v "^$preview" || true)"
  if ! jq -e '.plugins | has("ranged@fixture")' "$preview/installed_plugins.json" > /dev/null; then
    status=FAIL
    ev "ranged was not installed into the preview"
  fi
  diffs=$(diff -rq "$PRISTINE" "$SEED" 2>&1 | head -n 10 || true)
  ev "original store: files newer than t0: $(find "$SEED" -newer "$d/t0" 2>/dev/null | wc -l | tr -d ' '); diff -r against the pristine copy: [${diffs:-identical}]"
  if [ -n "$(find "$SEED" -newer "$d/t0" 2>/dev/null)" ] || [ -n "$diffs" ]; then status=FAIL; fi
  chmod -R u+w "$preview"
  rm -rf "$preview"
  record 14 "$status" "The preview copy installs into a copied plugins root and the original store gets no writes"
}

item15() {
  local d=$S/15 cfg=$S/15/cfg cache=$S/15/cache auto=no
  mkdir -p "$d" "$cfg" "$cache"
  jq -n -c --arg repo "$OWNER/of-g1-other" \
    '{extraKnownMarketplaces: {evil: {source: {source: "github", repo: $repo}, autoUpdate: false}}}' > "$cfg/settings.json"
  ev "runner settings.json declares marketplace evil; the runner's known_marketplaces.json starts absent"
  STORE=$cache RCFG=$cfg rr "$d/mkt-list.txt" traffic-on plugin marketplace list
  STORE=$cache RCFG=$cfg rr "$d/list.txt" traffic-on plugin list
  evf "claude plugin marketplace list" "$d/mkt-list.txt"
  evf "claude plugin list" "$d/list.txt"
  if [ -s "$cache/known_marketplaces.json" ] && jq -e 'has("evil")' "$cache/known_marketplaces.json" > /dev/null 2>&1; then auto=yes; fi
  if [ -d "$cache/marketplaces/evil" ]; then auto=yes; fi
  ev "RECORDED: files in the runner's cache dir: $(find "$cache" -maxdepth 2 | sed "s#^$cache/##" | head -n 10 | paste -s -d, -)"
  ev "RECORDED: the declared-but-missing marketplace was auto-added: $auto"
  record 15 RECORDED "The runner auto-add: does claude plugin ... add a declared marketplace absent from known_marketplaces.json"
}

item16() {
  local d=$S/16 reload
  fresh_ws s16
  reset_seed
  mkdir -p "$d" "$W/.claude"
  write_project_settings "$W/.claude/settings.json"
  base_settings "$d/settings.json"
  agent_run "$d/run" "$W" "$d/settings.json" "$PROMPT"
  evi "project hooks and statusLine, -p mode" "$d/run/init.json"
  ev "RECORDED: project-level SessionStart hook ran: $([ -e "$MARK/project-hook" ] && echo yes || echo no)"
  ev "RECORDED: project-level statusLine ran in -p mode: $([ -e "$MARK/project-statusline" ] && echo yes || echo no) (a statusLine usually needs an interactive session; item 16b asks Or to check it there)"
  # /reload-plugins in -p mode.
  mark_clear
  agent_run "$d/reload" "$W" "$d/settings.json" '/reload-plugins'
  reload=no
  if jq -e '.slash_commands[]? | select(. == "reload-plugins" or . == "/reload-plugins")' "$d/reload/init.json" > /dev/null 2>&1; then reload=yes; fi
  ev "RECORDED: reload-plugins in -p slash_commands: $reload"
  ev "RECORDED: result of running /reload-plugins with -p: $(jq -r 'select(.type=="result") | .result' "$d/reload/out.jsonl" 2>/dev/null | head -n 3 | cut -c1-300 | paste -s -d' ' -)"
  record 16a RECORDED "Project hooks and statusLine run (the 7.3 check is needed); /reload-plugins in -p mode"
}

item17() {
  local d=$S/17 cmds
  reset_seed
  mkdir -p "$d"
  base_settings "$d/settings.json"
  local tools='Bash,Task,Agent,Skill'

  # (a) skill with frontmatter hooks in $W/.claude/skills/h.
  fresh_ws s17a
  mkdir -p "$W/.claude/skills"
  cp -a "$FX/extras/skill-h" "$W/.claude/skills/h"
  agent_run "$d/a" "$W" "$d/settings.json" '/h' --allowedTools "$tools"
  evi "(a) skill h with frontmatter hooks, invoked as /h" "$d/a/init.json"
  ev "(a) RECORDED: skill frontmatter SessionStart hook ran: $([ -e "$MARK/skill-h-sessionstart" ] && echo yes || echo no); PreToolUse hook ran: $([ -e "$MARK/skill-h-pretooluse" ] && echo yes || echo no)"

  # (b) subagent with hooks and mcpServers in $W/.claude/agents/a.md.
  fresh_ws s17b
  mkdir -p "$W/.claude/agents"
  cp "$FX/extras/agent-a.md" "$W/.claude/agents/a.md"
  agent_run "$d/b" "$W" "$d/settings.json" 'Delegate to the subagent named a and have it run echo hi. Then reply done.' --allowedTools "$tools"
  evi "(b) subagent a in \$W/.claude/agents" "$d/b/init.json"
  ev "(b) RECORDED: subagent PreToolUse hook ran: $([ -e "$MARK/agent-a-pretooluse" ] && echo yes || echo no); subagent mcpServers entry started: $([ -e "$MARK/agent-a-mcp" ] && echo yes || echo no)"

  # (c) the same subagent in $AG/agents, plus skills in $AG/commands and $AG/agents.
  fresh_ws s17c
  mkdir -p "$AG/agents" "$AG/commands/cskill" "$AG/agents/askill"
  cp "$FX/extras/agent-a.md" "$AG/agents/a.md"
  printf -- '---\nname: cskill\ndescription: G1 probe skill under commands\n---\nSay hello.\n' > "$AG/commands/cskill/SKILL.md"
  printf -- '---\nname: askill\ndescription: G1 probe skill under agents\n---\nSay hello.\n' > "$AG/agents/askill/SKILL.md"
  printf -- '---\ndescription: G1 probe command\n---\nSay hello.\n' > "$AG/commands/cmd.md"
  agent_run "$d/c" "$W" "$d/settings.json" 'Delegate to the subagent named a and have it run echo hi. Then reply done.' --allowedTools "$tools"
  evi "(c) subagent a in \$AG/agents; skills in \$AG/commands and \$AG/agents" "$d/c/init.json"
  ev "(c) RECORDED: subagent PreToolUse hook ran: $([ -e "$MARK/agent-a-pretooluse" ] && echo yes || echo no); subagent mcpServers entry started: $([ -e "$MARK/agent-a-mcp" ] && echo yes || echo no)"
  cmds=$(jq -r '.slash_commands[]?' "$d/c/init.json" 2>/dev/null || true)
  for n in cmd cskill askill; do
    if printf '%s\n' "$cmds" | grep -q -x -E "/?$n"; then ev "(c) RECORDED: $n is in slash_commands"; else ev "(c) RECORDED: $n is NOT in slash_commands"; fi
  done
  ev "(c) RECORDED: agents in init: $(jq -c '.agents' "$d/c/init.json" 2>/dev/null)"
  record 17 RECORDED "Frontmatter hooks of skills and subagents; skills in AG/commands and AG/agents"
}

item18() {
  ev "Needs a claude.ai organisation that can mark a plugin required, and an agent signed in with a token."
  ev "Steps for Or:"
  ev "  1. In the claude.ai organisation settings, mark one plugin as required (if the organisation can)."
  ev "  2. Create a throwaway agent dir: mkdir -p $T/ag/s18/plugins $T/ag/s18/skills $T/w/s18"
  ev "  3. Run with a token sign-in and syncClaudeAiPlugins false (the same --settings as the other items):"
  ev "       CLAUDE_CODE_OAUTH_TOKEN=<your token> AG=$T/ag/s18 $T/agent.sh $T/w/s18 -p ok --output-format stream-json --verbose --settings '{\"syncClaudeAiPlugins\":false}' > $T/s/18-out.jsonl"
  ev "     (ANTHROPIC_API_KEY alone is not a claude.ai sign-in; use the token.)"
  ev "  4. jq 'select(.type==\"system\" and .subtype==\"init\") | .plugins' $T/s/18-out.jsonl"
  ev "  5. Write down in the report: does the required plugin load with syncClaudeAiPlugins false? If the organisation cannot mark a plugin required, write UNTESTED."
  record 18 MANUAL "Required synced plugins with syncClaudeAiPlugins: false (token-signed-in agent)"
}

item19() {
  ev "The shipped version ($CLAUDE_VERSION) is the floor unless an older version passes."
  ev "To test an older version, if you can: install it, then run"
  ev "    G1_FLOOR_PROBE=1 scripts/g1/run.sh $OWNER"
  ev "and read items 1, 2, 3, 4, 7, 12 and (if testable) 18 in that report. The lowest version where they all hold is the floor."
  ev "A probe report is not the Gate G1 report (it says so at the top)."
  const "floor (item 19): $CLAUDE_VERSION (the shipped version), unless Or probes an older version with G1_FLOOR_PROBE=1 and records it here. Fills B3's MIN_CLAUDE_VERSION."
  record 19 MANUAL "The version floor (lowest version where items 1-4, 7, 12 and 18 hold)"
}

# -------------------------------------------------------------------- report
build_report() {
  local tmpl=$HERE/report-template.md out=$T/report.md line summary details f
  [ -s "$T/summary.tsv" ] || return 0
  summary=$T/summary.md
  {
    printf '| Item | Status | What |\n|---|---|---|\n'
    sort "$T/summary.tsv" | while IFS="$(printf '\t')" read -r id st title; do
      printf '| %s | %s | %s |\n' "$id" "$st" "$title"
    done
  } > "$summary"
  details=$T/details.md
  : > "$details"
  for f in "$RES"/*.md; do
    cat "$f" >> "$details"
  done
  : > "$out"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      @@SUMMARY@@) cat "$summary" >> "$out" ;;
      @@DETAILS@@) cat "$details" >> "$out" ;;
      @@CONSTANTS@@)
        if [ -s "$T/constants.txt" ]; then sed 's/^/- /' "$T/constants.txt" >> "$out"; else echo "(none recorded)" >> "$out"; fi
        echo "- update against fresh install (B6): read item 10." >> "$out"
        echo "- whether mcpb/ is scrubbed (B7): read item 7 and the mcpb constant above." >> "$out"
        ;;
      @@PROBE_NOTE@@) printf '%s\n' "$PROBE_NOTE" >> "$out" ;;
      *)
        line=${line//@@DATE@@/$(date -u +%Y-%m-%dT%H:%M:%SZ)}
        line=${line//@@CLAUDE_VERSION@@/$CLAUDE_VERSION}
        line=${line//@@PINNED_VERSION@@/$PINNED}
        line=${line//@@HOST@@/$(uname -sm)}
        line=${line//@@FIXTURE_REPO@@/$OWNER/of-g1-fixture and $OWNER/of-g1-other}
        line=${line//@@SHAS@@/first ${FIXTURE_FIRST:-?}, tip ${FIXTURE_HEAD:-?}, other ${OTHER_HEAD:-?}}
        line=${line//@@WORKDIR@@/$T}
        printf '%s\n' "$line" >> "$out"
        ;;
    esac
  done < "$tmpl"
}

finish() {
  local rc=$?
  trap - EXIT
  build_report || true
  if [ -s "$T/report.md" ]; then
    echo
    echo "g1: report: $T/report.md"
    if grep -q $'\tFAIL\t' "$T/summary.tsv" 2>/dev/null; then
      echo "g1: FAIL items present: send them to owner-i5 before the design adapts"
    fi
    echo "g1: post report.md on #153. Delete the work dir with: chmod -R u+w $T && rm -rf $T"
  fi
  if [ "$rc" -ne 0 ]; then echo "g1: stopped early (exit $rc); the report holds what finished" >&2; fi
  exit "$rc"
}
trap finish EXIT

# ----------------------------------------------------------------------- main
bash "$HERE/fixture/make-fixture.sh" "$FX" "$OWNER" > "$T/make-fixture.log" 2>&1 || die "make-fixture.sh failed; see $T/make-fixture.log"
# shellcheck source=/dev/null
. "$FX/SHAS"
verify_remote "$OWNER/of-g1-fixture" "$FIXTURE_HEAD"
verify_remote "$OWNER/of-g1-other" "$OTHER_HEAD"

build_seed
test -z "$(ls -A "$MARK")" || echo "g1: note: MARK is not empty after the seed build (item 8 will say FAIL)"

item00
item01
item02
item03
item04
item05
item06
item07
item10   # before 8: item 8 reads item 10's MARK listing
item08
item09
item12
item13
item14
item15
item16
item17
item18
item19
item11   # last: it waits for Or's interactive session; also records 16b

echo
echo "g1: manual steps: item 11 and 16b (an interactive session), item 18 (an organisation), item 19 (an older version). See report.md."
