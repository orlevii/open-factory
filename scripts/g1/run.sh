#!/usr/bin/env bash
# Gate G1 (spec section 13): real Claude Code checks for I5's per-agent plugin
# installs, run only inside throwaway containers of the pinned agent image.
#
# Usage: scripts/g1/run.sh [image]
# Optional: G1_ITEMS="3 4 8" runs only those items.
#
#   image  the agent image to test, default open-factory-base:<pin>, where <pin>
#          is images/base/claude-code-version. G1_IMAGE does the same.
#
# Prerequisites:
#   - Docker running, and the image present locally (build it first, or pull it).
#   - `claude --version` inside the image equals images/base/claude-code-version
#     (the script stops otherwise; G1_FLOOR_PROBE=1 allows another version for
#     item 21 only).
#   - CLAUDE_CODE_OAUTH_TOKEN exported in your shell, for the items that start a
#     session. It is handed to those containers by name (docker -e NAME), never
#     written to disk, never printed, never put in the report.
#   - git, jq and the usual tools on the host. Nothing else is installed.
#   - the network (GitHub, the npm registry, Anthropic).
#   - no GitHub account or repo of yours is needed: items 4-9 use the public
#     anthropics/claude-plugins-official and obra/superpowers-marketplace, and
#     the host reads their history with plain git (no credential).
#
# It writes report.md in its temp dir and prints the path. Items 5 and 7 hold
# one session for more than ten minutes each, so the whole run takes about an
# hour. Exit status is 0 when the script ran to the end (read report.md for
# FAILs), non-zero when it could not run.
#
# Written for macOS bash 3.2 and newer. No `set -x` anywhere: it would print the
# credential.
set -eu
case $- in *x*) echo "g1: refusing to run with xtrace on (it would print the credential)" >&2; exit 1 ;; esac

HERE=$(cd "$(dirname "$0")" && pwd -P)
ROOT=$(cd "$HERE/../.." && pwd -P)

die() {
  echo "g1: $*" >&2
  exit 1
}

# ------------------------------------------------------------------ preflight
[ "$#" -le 1 ] || die "usage: scripts/g1/run.sh [image]"
PIN=$(tr -d '[:space:]' < "$ROOT/images/base/claude-code-version")
[ -n "$PIN" ] || die "images/base/claude-code-version is empty"
IMAGE=${1:-${G1_IMAGE:-open-factory-base:$PIN}}

# Never run with HOME pointing into the spike dir. The script mounts no home
# directory and reads nothing from it, so the dir merely existing is fine.
case "${HOME:-}" in *.open-factory-spike*) die "HOME (${HOME:-}) contains .open-factory-spike; refusing to run." ;; esac

for tool in docker jq git find pkill sed awk; do
  command -v "$tool" > /dev/null 2>&1 || die "missing tool: $tool"
done
docker info > /dev/null 2>&1 || die "Docker is not running"
docker image inspect "$IMAGE" > /dev/null 2>&1 || die "image $IMAGE is not present locally"
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || die "export CLAUDE_CODE_OAUTH_TOKEN (the session items need it; it is passed to containers by name only)"
export CLAUDE_CODE_OAUTH_TOKEN # docker -e CLAUDE_CODE_OAUTH_TOKEN reads it from this environment

CLAUDE_VERSION=$(docker run --rm "$IMAGE" claude --version 2> /dev/null | awk '{print $1}')
PROBE_NOTE=""
if [ "$CLAUDE_VERSION" != "$PIN" ]; then
  if [ -n "${G1_FLOOR_PROBE:-}" ]; then
    PROBE_NOTE="
**FLOOR PROBE** (G1_FLOOR_PROBE set): run on ${CLAUDE_VERSION:-an unknown version}, not the pinned $PIN. This is item 21 evidence only; it is not the Gate G1 run.
"
  else
    die "claude in $IMAGE is '${CLAUDE_VERSION:-unknown}' but images/base/claude-code-version pins $PIN. (For item 21 only, G1_FLOOR_PROBE=1 allows another version.)"
  fi
fi
IMAGE_ID=$(docker image inspect -f '{{.Id}} {{join .RepoDigests ","}}' "$IMAGE")

# ------------------------------------------------------------------- layout
T=$(mktemp -d "${TMPDIR:-/tmp}/of-g1.XXXXXX")
T=$(cd "$T" && pwd -P)
S=$T/s                # one dir per item
RES=$T/results        # one file per item, assembled into report.md
FX=$T/fx              # the fixture, built by make-fixture.sh
R=$T/served           # the bare git repos the containers see (read-only)
MARK=$T/mark          # plugin code writes a file here when it runs
EV=$T/evidence.tmp
HUID=$(id -u)
HGID=$(id -g)
PROMPT='Reply with the single word ok.'
mkdir -p "$S" "$RES" "$R" "$MARK"   # MARK up front: set -eu safe
: > "$EV"
: > "$T/summary.tsv"
: > "$T/constants.txt"
AG_KEEP=0                    # 1: reset_ag leaves $AG alone (the item placed files in it)
P="" AG="" W="" HM=""        # the current agent: plugins dir, config dir, workdir, home
XENV=""                      # extra docker -e args (no spaces in any value)
CNET=""                      # docker network args
SYNC_ENV=""                  # set by item 2 for directory marketplaces: -e CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1 if needed
FILE_URL_NOTE="not decided"

cd "$T" # never leave the owner's cwd (maybe a git repo) as the cwd of anything
echo "g1: work dir $T"
echo "g1: claude $CLAUDE_VERSION (pinned $PIN), image $IMAGE"

# ------------------------------------------------------------- small helpers
ev() { printf '%s\n' "$*" >> "$EV"; }

evf() { # <label> <file>: indented, capped excerpt of a file
  ev "$1:"
  if [ -s "$2" ]; then
    sed -n '1,40p' "$2" | cut -c1-300 | sed 's/^/    /' >> "$EV"
  else
    ev "    (empty)"
  fi
}

record() { # <id> <PASS|FAIL|RECORDED|MANUAL|NOT RUN> <title>: file the evidence gathered so far
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$T/summary.tsv"
  {
    printf '### %s. %s\n\nStatus: **%s**\n\n```\n' "$1" "$3" "$2"
    cat "$EV"
    printf '```\n\n'
  } > "$RES/$(printf '%02d' "$1").md"
  : > "$EV"
  printf '[%s] %s: %s\n' "$2" "$1" "$3"
}

const() { printf '%s\n' "$*" >> "$T/constants.txt"; }

mark_clear() {
  mkdir -p "$MARK"
  find "$MARK" -mindepth 1 -delete
}
mark_list() { ls -A "$MARK" | paste -s -d, -; }
# The marks only install-time code writes (marker's npm preinstall/postinstall).
# Session-time marks (hook-sessionstart, mcp-start, bin-x, monitor, and rel-hook
# of the defaultEnabled plugin) don't count.
install_marks() { ls -A "$MARK" | grep -E '^npm-(pre|post)install$' | paste -s -d, - || true; }

# run_limited <seconds> <command...>: a timeout that works without GNU timeout.
# The command keeps the caller's stdin (the <&0).
run_limited() {
  local secs=$1 pid watcher rc=0
  shift
  "$@" <&0 &
  pid=$!
  ( sleep "$secs"; pkill -P "$pid" 2> /dev/null; kill "$pid" 2> /dev/null ) > /dev/null 2>&1 &
  watcher=$!
  wait "$pid" || rc=$?
  kill "$watcher" 2> /dev/null || true
  wait "$watcher" 2> /dev/null || true
  return "$rc"
}

fresh_ws() { # <name>: a new agent: plugins dir P, config dir AG, workdir W, home HM
  P=$T/p/$1
  AG=$T/ag/$1
  W=$T/w/$1
  HM=$T/hm/$1
  rm -rf "$P" "$AG" "$W" "$HM"
  mkdir -p "$P" "$AG/skills" "$W" "$HM"
  XENV=$SYNC_ENV
  CNET=""
  AG_KEEP=0
  mark_clear
}

# Every session gets a fresh config dir $AG (spec 7.3); only the plugins dir $P
# persists across restarts. An item that places files in $AG sets AG_KEEP=1.
reset_ag() {
  if [ "${AG_KEEP:-0}" != 1 ]; then
    rm -rf "$AG"
    mkdir -p "$AG/skills"
  fi
}

# ----------------------------------------------------------------- the fixture
# Only item 0 uses a git fixture: the bare repo, served read-only as
# /fixture/acme.git. Items 4-9 use two public marketplaces and need no account
# or repo of ours.
SRC_FILE='{"source":"git","url":"file:///fixture/acme.git"}'
SRC_DIR='{"source":"directory","path":"/fixture/dir"}'
SRC_OFFICIAL='{"source":"github","repo":"anthropics/claude-plugins-official"}'
SRC_SUPER='{"source":"github","repo":"obra/superpowers-marketplace"}'
OFF_URL=https://github.com/anthropics/claude-plugins-official.git
SUP_URL=https://github.com/obra/superpowers-marketplace.git
# Remote marketplaces need CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1 to have their plugins
# in the first init (a G1 finding); items 4-9 always set it.
SYNC1="-e CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1"

# pick_commits <OFF|SUP> <url> <plugin>: read a public marketplace's history on
# the host with plain git (a blobless bare clone, no credential) and set
# <p>_OLD (a commit 30-60 behind HEAD that still lists <plugin>), <p>_NEW (HEAD),
# <p>_BRANCH, <p>_TAG and <p>_TAGSHA (its newest tag, if any).
pick_commits() {
  local pre=$1 url=$2 plug=$3 bare=$T/bare-$1.git i c new old="" tag tsha="" br
  git clone -q --bare --filter=blob:none "$url" "$bare" > "$T/clone-$1.log" 2>&1 \
    || die "could not clone $url (network?); see $T/clone-$1.log"
  new=$(git -C "$bare" rev-parse HEAD)
  br=$(git -C "$bare" symbolic-ref --short HEAD 2> /dev/null || echo main)
  for i in $(seq 30 60) $(seq 29 -1 1); do
    c=$(git -C "$bare" rev-parse -q --verify "HEAD~$i" 2> /dev/null) || continue
    if git -C "$bare" show "$c:.claude-plugin/marketplace.json" 2> /dev/null \
      | jq -e --arg p "$plug" '.plugins[]? | select(.name == $p)' > /dev/null 2>&1; then
      old=$c
      break
    fi
  done
  [ -n "$old" ] || die "no old commit of $url lists the plugin $plug"
  tag=$(git -C "$bare" tag --sort=-creatordate | sed -n 1p)
  if [ -n "$tag" ]; then tsha=$(git -C "$bare" rev-parse "$tag^{commit}"); fi
  eval "${pre}_OLD=$old ${pre}_NEW=$new ${pre}_BRANCH=$br ${pre}_TAG=$tag ${pre}_TAGSHA=$tsha"
}

mk_name() { case $1 in OFF) echo claude-plugins-official ;; SUP) echo superpowers-marketplace ;; esac; }
mk_src() { case $1 in OFF) echo "$SRC_OFFICIAL" ;; SUP) echo "$SRC_SUPER" ;; esac; }
mk_key() { case $1 in OFF) echo skill-creator@claude-plugins-official ;; SUP) echo superpowers@superpowers-marketplace ;; esac; }
mk_var() { eval "echo \${$1_$2}"; } # mk_var OFF OLD

# set_pm <OFF|SUP>: the marketplace items 5-9 pin (PM_*); the other one is their
# Latest marketplace (OM_*).
set_pm() {
  local o=SUP
  [ "$1" = OFF ] || o=OFF
  PM=$1
  PM_NAME=$(mk_name "$1"); PM_SRC=$(mk_src "$1"); PM_KEY=$(mk_key "$1")
  PM_OLD=$(mk_var "$1" OLD); PM_NEW=$(mk_var "$1" NEW)
  OM_NAME=$(mk_name "$o"); OM_SRC=$(mk_src "$o"); OM_KEY=$(mk_key "$o")
}
pm_decl() { decl "$PM_NAME" "$PM_SRC" "${1:-}" "${2:-false}"; } # <ref> [autoUpdate]
om_decl() { decl "$OM_NAME" "$OM_SRC" "" true; }                 # the Latest one
pm_plugin() { printf '%s' "${PM_KEY%@*}"; }
installed_sha() { jq -r --arg k "$1" '.plugins[$k][0].gitCommitSha // "none"' "$P/installed_plugins.json" 2> /dev/null || echo none; }
fresh_remote() { fresh_ws "$1"; XENV=$SYNC1; }

# --------------------------------------------------------------- the container
# ctr <command...>: one fresh `docker run --rm` of the image, the agent as spec
# 7.3 builds it: CLAUDE_CONFIG_DIR=$AG (an empty skills/), the plugins dir $P
# mounted read-write at the same path as CLAUDE_CODE_PLUGIN_CACHE_DIR,
# DISABLE_AUTOUPDATER=1, and the fixtures mounted read-only. The credential is
# handed over by name (-e NAME) and only when CRED=1.
ctr() {
  local cred="" i=""
  if [ "${CRED:-0}" = 1 ]; then cred="-e CLAUDE_CODE_OAUTH_TOKEN"; fi
  if [ "${CTR_I:-0}" = 1 ]; then i="-i"; fi
  # shellcheck disable=SC2086
  docker run --rm $i $CNET \
    -e HOST_UID="$HUID" -e HOST_GID="$HGID" \
    -e CLAUDE_CONFIG_DIR="$AG" -e CLAUDE_CODE_PLUGIN_CACHE_DIR="$P" -e DISABLE_AUTOUPDATER=1 \
    -e MARK="$MARK" -e GIT_TERMINAL_PROMPT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e 'GIT_CONFIG_VALUE_0=*' \
    $cred $XENV \
    -v "$P:$P" -v "$AG:$AG" -v "$W:$W" -v "$MARK:$MARK" -v "$HM:/home/agent" \
    -v "$FX/dir:/fixture/dir:ro" -v "$FX/evil:/fixture/evil:ro" \
    -v "$R/acme.git:/fixture/acme.git:ro" \
    -w "$W" "$IMAGE" "$@"
}

# pc <outfile> <claude plugin args...>: a plugin command, no credential; never
# fails; the last line is exit=N.
pc() {
  local out=$1 rc=0
  shift
  run_limited 240 ctr claude plugin "$@" > "$out" 2>&1 || rc=$?
  printf 'exit=%s\n' "$rc" >> "$out"
}
pc_rc() { tail -n 1 "$1" | sed 's/^exit=//'; }

# session <dir> <settings-file> <prompt> [claude args...]: a headless session.
# The whole stream is captured (never `head`, which can kill the run before
# hooks and MCP write) and init is selected from it with jq.
session() {
  local dir=$1 sf=$2 prompt=$3 rc=0 CRED=1 t0
  shift 3
  mkdir -p "$dir"
  reset_ag
  t0=$(date +%s)
  run_limited "${SESSION_LIMIT:-300}" ctr claude -p "$prompt" \
    --output-format stream-json --verbose --settings "$(cat "$sf")" "$@" \
    > "$dir/out.jsonl" 2> "$dir/stderr.txt" || rc=$?
  echo "$rc" > "$dir/exit.txt"
  echo $(($(date +%s) - t0)) > "$dir/seconds.txt"
  jq -c 'select(.type=="system" and .subtype=="init")' "$dir/out.jsonl" > "$dir/init.json" 2> /dev/null || true
}

umsg() { jq -n -c --arg t "$1" '{type: "user", message: {role: "user", content: $t}}'; }

# fifo_session <dir> <settings-file> <driver> [claude args...]: a stream-json
# session whose stdin is whatever the shell function <driver> writes, so that
# one session can stay open for a long time or take several messages.
fifo_session() {
  local dir=$1 sf=$2 driver=$3 rc=0 CRED=1 CTR_I=1 dpid t0
  shift 3
  mkdir -p "$dir"
  rm -f "$dir/in"
  reset_ag
  mkfifo "$dir/in"
  "$driver" > "$dir/in" &
  dpid=$!
  t0=$(date +%s)
  run_limited "${SESSION_LIMIT:-300}" ctr claude -p --input-format stream-json \
    --output-format stream-json --verbose --settings "$(cat "$sf")" "$@" \
    < "$dir/in" > "$dir/out.jsonl" 2> "$dir/stderr.txt" || rc=$?
  kill "$dpid" 2> /dev/null || true
  wait "$dpid" 2> /dev/null || true
  echo "$rc" > "$dir/exit.txt"
  echo $(($(date +%s) - t0)) > "$dir/seconds.txt"
  jq -c 'select(.type=="system" and .subtype=="init")' "$dir/out.jsonl" > "$dir/init.json" 2> /dev/null || true
}

# --------------------------------------------------------------- init helpers
plugin_names() { # <init.json> -> sorted comma list, marketplace suffix dropped
  jq -r '.plugins[]? | (if type=="object" then .name else . end) | sub("@.*$";"")' "$1" 2> /dev/null \
    | sort -u | paste -s -d, -
}
plugin_paths() { # <init.json>
  jq -r '.plugins[]? | (if type=="object" then (.path // "") else "" end)' "$1" 2> /dev/null
}
has_plugin() { # <init.json> <name>
  case ",$(plugin_names "$1")," in *",$2,"*) return 0 ;; esac
  return 1
}
loaded_versions() { # <init.json>: name=version for each loaded plugin, read from its manifest
  local p v n out=""
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    case "$p" in /fixture/dir*) p=$FX/dir${p#/fixture/dir} ;; esac
    n=$(jq -r '.name // "?"' "$p/.claude-plugin/plugin.json" 2> /dev/null || echo '?')
    v=$(jq -r '.version // "?"' "$p/.claude-plugin/plugin.json" 2> /dev/null || echo '?')
    out="$out$n=$v,"
  done < <(plugin_paths "$1")
  printf '%s' "${out%,}"
}
loaded_version() { # <init.json> <plugin>: its version, or none
  local v
  v=$(loaded_versions "$1" | tr ',' '\n' | sed -n "s/^$2=//p" | head -n 1)
  printf '%s' "${v:-none}"
}
under_p() { # <init.json>: count of plugin paths under $P, and outside it
  local in=0 out=0 p
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    case "$p" in "$P"/*) in=$((in + 1)) ;; *) out=$((out + 1)) ;; esac
  done < <(plugin_paths "$1")
  printf '%s under P, %s elsewhere' "$in" "$out"
}
order() { # <out.jsonl>: the first stream events, in order
  jq -r 'select(.type != null) | .type + (if .subtype then "/" + .subtype else "" end)' "$1" 2> /dev/null | sed -n '1,8p' | paste -s -d' ' -
}
evi() { # <label> <init.json>: what an init event says about plugins and servers
  ev "$1:"
  if [ -s "$2" ]; then
    ev "    plugins: $(jq -c '.plugins' "$2")"
    ev "    loaded versions: $(loaded_versions "$2")"
    ev "    mcp_servers: $(jq -c '.mcp_servers' "$2")"
    ev "    agents: $(jq -c '.agents' "$2")"
    ev "    slash_commands: $(jq -c '.slash_commands' "$2" | cut -c1-400)"
  else
    ev "    NO init event in the stream (see out.jsonl and stderr.txt under $(dirname "$2"))"
  fi
}
evrun() { # <label> <run dir>: init, event order, time and the head of stderr
  evi "$1" "$2/init.json"
  ev "    events: $(order "$2/out.jsonl"); took $(cat "$2/seconds.txt")s; exit $(cat "$2/exit.txt")"
  evf "    stderr" "$2/stderr.txt"
}

# The agent's plugins dir.
cache_versions() { ls "$P/cache/$1/$2" 2> /dev/null | paste -s -d, - || true; } # <mkt> <plugin>
clone_head() { git -C "$P/marketplaces/$1" rev-parse HEAD 2> /dev/null || echo none; }
p_listing() { (cd "$P" && find . -maxdepth 3 | sort | sed -n '1,70p'); }
p_sum() { (cd "$P" && find cache -maxdepth 3 -type d 2> /dev/null | sort | cksum | awk '{print $1}'); }
inst_sum() { if [ -f "$P/installed_plugins.json" ]; then cksum < "$P/installed_plugins.json" | awk '{print $1}'; else echo none; fi; }
orphans() { find "$P/cache" -name .orphaned_at 2> /dev/null | sed "s#^$P/##" | paste -s -d, - || true; }

# --------------------------------------------------------------- settings
# decl <name> <source-json> [<ref> [<autoUpdate>]]: one extraKnownMarketplaces entry
decl() {
  jq -n -c --arg n "$1" --argjson s "$2" --arg r "${3:-}" --argjson a "${4:-false}" \
    '{($n): {source: ($s + (if $r == "" then {} else {ref: $r} end)), autoUpdate: $a}}'
}
# enabled <key=true|false>...: an enabledPlugins object
enabled() {
  printf '%s\n' "$@" | jq -R -s -c 'split("\n") | map(select(length > 0) | split("=") | {(.[0]): (.[1] == "true")}) | add // {}'
}
# settings <out> <enabled-json> [<decl-json>...]: the inline --settings JSON of spec 7.3 step 5
settings() {
  local out=$1 e=$2 m='{}'
  shift 2
  if [ "$#" -gt 0 ]; then m=$(printf '%s\n' "$@" | jq -s -c 'add'); fi
  jq -n -c --argjson e "$e" --argjson m "$m" \
    '{enabledPlugins: $e, extraKnownMarketplaces: $m, syncClaudeAiPlugins: false}' > "$out"
}
DECL_DIR=""
std_settings() { settings "$1" "$(enabled marker@fixdir=true dep@fixdir=true)" "$DECL_DIR"; } # marker and dep on, directory marketplace
bare_settings() { printf '%s' '{"syncClaudeAiPlugins":false}' > "$1"; }                         # no plugins at all

# --------------------------------------------------------------- the items
# 0: a file-URL git marketplace: RECORDED (2.1.331 refuses it, so nothing else uses it).
item00() {
  local d=$S/00 ok=no add_rc
  fresh_ws z0
  mkdir -p "$d"
  pc "$d/add.txt" marketplace add file:///fixture/acme.git
  add_rc=$(pc_rc "$d/add.txt")
  evf "claude plugin marketplace add file:///fixture/acme.git (exit $add_rc)" "$d/add.txt"
  pc "$d/add-git.txt" marketplace add git+file:///fixture/acme.git
  evf "claude plugin marketplace add git+file:///fixture/acme.git (exit $(pc_rc "$d/add-git.txt"))" "$d/add-git.txt"

  # The way the factory declares it: --settings with a git source.
  fresh_ws z0b
  settings "$d/settings.json" "$(enabled marker@fixture=true dep@fixture=true)" "$(decl fixture "$SRC_FILE")"
  ev "declaration: $(jq -c '.extraKnownMarketplaces' "$d/settings.json")"
  session "$d/run" "$d/settings.json" "$PROMPT"
  evrun "session with the file:// git marketplace declared" "$d/run"
  ev "known_marketplaces.json: $(jq -c . "$P/known_marketplaces.json" 2> /dev/null || echo absent)"
  ev "marketplace clone HEAD: $(clone_head fixture) (first commit $FIX_FIRST)"
  if has_plugin "$d/run/init.json" marker; then ok=yes; fi
  if [ "$ok" = no ]; then
    fresh_ws z0c
    pc "$d/control.txt" marketplace add /fixture/dir
    ev "control: the directory marketplace adds with exit $(pc_rc "$d/control.txt") (so a failure above is about the file:// URL, not the container)"
  fi
  FILE_URL_NOTE="item 0: a file:// git marketplace is $([ "$ok" = yes ] && echo accepted || echo refused) in --settings (CLI add exits $add_rc). Items 4-9 use public marketplaces either way."
  const "file:// git marketplace (item 0): $([ "$ok" = yes ] && echo accepted || echo refused) in --settings; CLI marketplace add of the same URL exits $add_rc."
  record 0 RECORDED "A file-URL git marketplace: accepted in --settings: $ok"
}

# 1: only enabled plugins load; init.plugins entry shape; init before the first message.
item01() {
  local d=$S/01 status=PASS names
  mkdir -p "$d"

  # a. marker and dep true, rel absent from enabledPlugins: does the defaultEnabled plugin load?
  fresh_ws s01a
  std_settings "$d/a.json"
  session "$d/a" "$d/a.json" "$PROMPT"
  evrun "(a) marker and dep true, rel absent" "$d/a"
  if has_plugin "$d/a/init.json" rel; then
    ev "(a) RECORDED: rel LOADS with no enabledPlugins entry (defaultEnabled applies, R14)"
  else
    ev "(a) RECORDED: rel does NOT load without an entry"
  fi

  # b. rel false: it must not load; the loaded set is exactly the true plugins.
  # A directory marketplace's plugins may load in place, so their paths are
  # recorded, not asserted (item 3 asserts the layout on a remote marketplace).
  fresh_ws s01b
  settings "$d/b.json" "$(enabled marker@fixdir=true dep@fixdir=true rel@fixdir=false)" "$DECL_DIR"
  session "$d/b" "$d/b.json" "$PROMPT"
  evrun "(b) marker and dep true, rel false" "$d/b"
  names=$(plugin_names "$d/b/init.json")
  ev "(b) init.plugins names: [$names]; paths: $(under_p "$d/b/init.json") (recorded: directory-marketplace plugins may load in place)"
  if [ "$names" != "dep,marker" ]; then status=FAIL; fi

  # c. dep absent, then dep false: does marker still load? is an auto-installed dependency enabled without an entry?
  fresh_ws s01c
  settings "$d/c.json" "$(enabled marker@fixdir=true)" "$DECL_DIR"
  session "$d/c" "$d/c.json" "$PROMPT"
  evrun "(c) marker true, dep has NO entry" "$d/c"
  ev "(c) RECORDED: dep loads without an entry (an auto-installed dependency): $(has_plugin "$d/c/init.json" dep && echo yes || echo no); installed_plugins.json: $(jq -c '.plugins | map_values(map({version, auto}))' "$P/installed_plugins.json" 2> /dev/null || echo absent)"
  fresh_ws s01d
  settings "$d/d.json" "$(enabled marker@fixdir=true dep@fixdir=false)" "$DECL_DIR"
  session "$d/d" "$d/d.json" "$PROMPT"
  evrun "(d) marker true, dep false" "$d/d"
  if has_plugin "$d/d/init.json" marker; then
    ev "(d) RECORDED: marker LOADS with dep false (dependencies are NOT required to be enabled)"
  else
    ev "(d) RECORDED: marker does NOT load with dep false (dependencies must be enabled, R13)"
  fi
  grep -i -h -m3 'dependenc' "$d/d/stderr.txt" "$d/d/out.jsonl" 2> /dev/null | cut -c1-300 | sed 's/^/    /' >> "$EV" || true

  # e. the init.plugins entry shape: a cached remote plugin and an in-place directory plugin.
  fresh_remote s01e
  settings "$d/e.json" "$(enabled "$(mk_key SUP)=true" rel@fixdir=true)" "$DECL_DIR" "$(decl "$(mk_name SUP)" "$SRC_SUPER" "$SUP_OLD" false)"
  session "$d/e" "$d/e.json" "$PROMPT"
  evrun "(e) entry shape: superpowers (cached, remote) and rel (in place, directory)" "$d/e"
  ev "(e) first entry keys: $(jq -c '[.plugins[]? | if type=="object" then keys else "string" end]' "$d/e/init.json" 2> /dev/null | cut -c1-300)"
  ev "(e) RECORDED: init comes before the first message: events are [$(order "$d/e/out.jsonl")]"
  const "init.plugins entry shape (item 1): $(jq -c '.plugins' "$d/e/init.json" 2> /dev/null | cut -c1-400); events [$(order "$d/e/out.jsonl")]. Fills B3's init matching."
  record 1 "$status" "Only enabled plugins load (b asserts; a, c, d and e are recorded)"
}

# 2: install at start, with and without CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1.
item02() {
  local d=$S/02 mode plain=no sync=no
  mkdir -p "$d"
  std_settings "$d/settings.json"
  for mode in plain sync; do
    fresh_ws "s02$mode"
    if [ "$mode" = sync ]; then XENV="-e CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1"; else XENV=""; fi
    ev "$mode: \$P is empty: $(ls -A "$P" | wc -l | tr -d ' ') entries; marketplace and plugins declared only in --settings"
    session "$d/$mode" "$d/settings.json" "$PROMPT"
    evrun "$mode (CLAUDE_CODE_SYNC_PLUGIN_INSTALL=$([ "$mode" = sync ] && echo 1 || echo unset))" "$d/$mode"
    ev "$mode: marker listed in init (installed before init): $(has_plugin "$d/$mode/init.json" marker && echo yes || echo no); \$P after: $(p_listing | sed -n '1,14p' | paste -s -d' ' -)"
    if has_plugin "$d/$mode/init.json" marker; then
      if [ "$mode" = plain ]; then plain=yes; else sync=yes; fi
    fi
  done
  if [ "$plain" = yes ]; then
    SYNC_ENV=""
    const "CLAUDE_CODE_SYNC_PLUGIN_INSTALL (item 2): NOT needed; a plain start installs before init. Fills §7.3 step 4."
    record 2 PASS "Install at start: a plain headless start installs declared plugins before init (sync variable: $sync)"
  elif [ "$sync" = yes ]; then
    SYNC_ENV="-e CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1"
    const "CLAUDE_CODE_SYNC_PLUGIN_INSTALL (item 2): NEEDED; only CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1 installs before init. §7.3 step 4 adds it."
    record 2 PASS "Install at start: installs before init with CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1 only"
  else
    const "CLAUDE_CODE_SYNC_PLUGIN_INSTALL (item 2): neither variant installs before init. Goes back to Or before PR 2 (fallback: a pre-session claude plugin install)."
    record 2 FAIL "Install at start: neither variant lists the plugins in init (goes to Or, spec P6)"
  fi
}

# Persistence check on the current agent: first start, listing, nothing under $AG
# or $HOME, then a restart with the same $P and a fresh $AG installs nothing.
# Sets PS to PASS or FAIL.
persist_run() { # <label> <settings-file> <dir> [<required file under $P>...]
  local label=$1 sf=$2 dd=$3 f stray a1 b1 n1 a2 b2 n2
  shift 3
  PS=PASS
  session "$dd/first" "$sf" "$PROMPT"
  evrun "$label: first start, empty \$P" "$dd/first"
  ev "$label: \$P after the first start:"
  p_listing | sed 's/^/    /' >> "$EV"
  ev "$label: plugin paths in init: $(under_p "$dd/first/init.json")"
  for f in "$@"; do
    if [ -e "$P/$f" ]; then ev "    present: $f"; else ev "    MISSING: $f"; PS=FAIL; fi
  done
  stray=$(find "$AG" "$HM" \( -name installed_plugins.json -o -name known_marketplaces.json -o -name marketplaces -o -path '*/plugins/cache' \) 2> /dev/null | sed "s#^$T/##" | paste -s -d, - || true)
  ev "$label: plugin-related files under \$AG or \$HOME: [${stray:-none}]"
  if [ -n "$stray" ]; then PS=FAIL; fi
  a1=$(p_sum)
  b1=$(inst_sum)
  n1=$(plugin_names "$dd/first/init.json")
  mark_clear
  session "$dd/second" "$sf" "$PROMPT"
  evrun "$label: restart, same \$P, fresh \$AG" "$dd/second"
  a2=$(p_sum)
  b2=$(inst_sum)
  n2=$(plugin_names "$dd/second/init.json")
  ev "$label: cache dirs cksum: $a1 -> $a2; installed_plugins.json cksum: $b1 -> $b2; plugins loaded: [$n1] -> [$n2]"
  # installed_plugins.json is recorded, not asserted: G1 (2026-11-24) saw the
  # registry still empty when the first headless start exited and written at the
  # restart, with the cache dirs identical. Installs happen iff the cache changes.
  if [ "$a1" != "$a2" ] || [ "$n1" != "$n2" ] || [ -z "$n2" ]; then PS=FAIL; fi
}

# 3: the per-agent plugins dir and persistence.
item03() {
  local d=$S/03 status=PASS
  mkdir -p "$d"
  # (a) The directory marketplace: its plugins may load in place (outside $P), so
  # only persistence is asserted; the layout is recorded.
  fresh_ws s03a
  std_settings "$d/a.json"
  persist_run "(a) directory marketplace" "$d/a.json" "$d/a"
  [ "$PS" = PASS ] || status=FAIL
  # (b) A remote marketplace, pinned: everything lands under $P.
  # obra/superpowers-marketplace: item 4 shows it honours a commit pin; the official
  # marketplace does not (item 4d), and item 4 has not run yet at this point.
  set_pm SUP
  fresh_remote s03b
  settings "$d/b.json" "$(enabled "$PM_KEY=true")" "$(pm_decl "$PM_OLD")"
  persist_run "(b) remote marketplace $PM_NAME at $PM_OLD" "$d/b.json" "$d/b" installed_plugins.json known_marketplaces.json marketplaces cache
  [ "$PS" = PASS ] || status=FAIL
  set_pm OFF
  record 3 "$status" "The per-agent plugins dir holds everything, and a restart installs nothing"
}

# One pin case for item 4: declare <mkt> with <ref>, start, report what Claude Code did.
PIN_OK=no
pin_case() { # <id> <mkt> <source-json> <ref> <plugin-key> <expected clone HEAD or ''>
  local id=$1 mkt=$2 src=$3 ref=$4 key=$5 want=$6 d=$S/04/$1 head loaded=no
  mkdir -p "$d"
  fresh_remote "s04$id"
  settings "$d/settings.json" "$(enabled "$key=true")" "$(decl "$mkt" "$src" "$ref" false)"
  session "$d/run" "$d/settings.json" "$PROMPT"
  head=$(clone_head "$mkt")
  if has_plugin "$d/run/init.json" "${key%@*}"; then loaded=yes; fi
  evrun "($id) $mkt with ref $ref" "$d/run"
  ev "($id) accepted (the plugin loads): $loaded; marketplace clone HEAD: $head (expected ${want:-n/a}); installed sha: $(installed_sha "$key")"
  PIN_OK=no
  if [ "$loaded" = yes ] && { [ -z "$want" ] || [ "$head" = "$want" ]; }; then PIN_OK=yes; fi
}

# 4: pins Claude Code accepts (public marketplaces, commits picked on the host).
item04() {
  local d=$S/04 status=PASS official_ok=no
  mkdir -p "$d"
  ev "commits read on the host (plain git): official OLD $OFF_OLD, NEW $OFF_NEW, tag ${OFF_TAG:-none}; superpowers OLD $SUP_OLD, NEW $SUP_NEW, tag ${SUP_TAG:-none}"
  # (a, f) a non-reserved github source at a commit.
  pin_case a "$(mk_name SUP)" "$SRC_SUPER" "$SUP_OLD" "$(mk_key SUP)" "$SUP_OLD"
  ev "(a, f) PASS needs superpowers-marketplace's clone at the pinned commit: $PIN_OK"
  [ "$PIN_OK" = yes ] || status=FAIL
  # (b) a tag.
  if [ -n "$SUP_TAG" ]; then
    pin_case b "$(mk_name SUP)" "$SRC_SUPER" "$SUP_TAG" "$(mk_key SUP)" "$SUP_TAGSHA"
    ev "(b) PASS needs the tag $SUP_TAG to resolve to $SUP_TAGSHA: $PIN_OK"
    [ "$PIN_OK" = yes ] || status=FAIL
  else
    ev "(b) superpowers-marketplace has no tags: RECORDED, nothing to pin"
  fi
  # (c) a branch name.
  pin_case c "$(mk_name SUP)" "$SRC_SUPER" "$SUP_BRANCH" "$(mk_key SUP)" ""
  ev "(c) RECORDED: the branch $SUP_BRANCH is accepted as a ref: $PIN_OK"
  # (d, e) the reserved-name marketplace: fills OFFICIAL_MARKETPLACES' pin rules.
  pin_case d "$(mk_name OFF)" "$SRC_OFFICIAL" "$OFF_OLD" "$(mk_key OFF)" "$OFF_OLD"
  official_ok=$PIN_OK
  ev "(d) RECORDED: claude-plugins-official accepts and honours a commit ref: $official_ok"
  const "OFFICIAL_MARKETPLACES pin rules (item 4d): a commit ref for claude-plugins-official is accepted and honoured: $official_ok (ref $OFF_OLD). Fills §7.4."
  if [ -n "$OFF_TAG" ]; then
    pin_case e "$(mk_name OFF)" "$SRC_OFFICIAL" "$OFF_TAG" "$(mk_key OFF)" "$OFF_TAGSHA"
    ev "(e) RECORDED: the official marketplace accepts the tag $OFF_TAG: $PIN_OK"
    const "OFFICIAL_MARKETPLACES pin rules (item 4e): tag $OFF_TAG for claude-plugins-official accepted and honoured: $PIN_OK. Fills §7.4."
  else
    ev "(e) the official marketplace has no tags: RECORDED"
    const "OFFICIAL_MARKETPLACES pin rules (item 4e): claude-plugins-official has no tags."
  fi
  # Items 5-9 pin the official marketplace when it honours commit pins, else superpowers.
  if [ "$official_ok" = yes ]; then set_pm OFF; else set_pm SUP; fi
  ev "items 5-9 pin $PM_NAME at $PM_OLD (upstream HEAD $PM_NEW), with $OM_NAME as the Latest marketplace"
  record 4 "$status" "Pins Claude Code accepts (a, f and b assert; c, d and e are recorded)"
}

# stays <label> <run dir>: the pinned marketplace is still at the pin and its plugin loads. Sets V5.
stays() {
  local head
  head=$(clone_head "$PM_NAME")
  ev "$1: $PM_NAME clone HEAD $head (pin $PM_OLD); installed sha $(installed_sha "$PM_KEY"); plugin loaded: $(has_plugin "$2/init.json" "$(pm_plugin)" && echo yes || echo no)"
  [ "$head" = "$PM_OLD" ] || V5=FAIL
  has_plugin "$2/init.json" "$(pm_plugin)" || V5=FAIL
}

# 5: a pinned plugin stays, without and with FORCE_AUTOUPDATE_PLUGINS=1.
drv_long() { umsg "$PROMPT"; sleep 660; }
item05_variant() { # <label> <0|1>: sets V5=PASS|FAIL
  local label=$1 force=$2 d=$S/05/$1 en
  mkdir -p "$d"
  V5=PASS
  fresh_remote "s05$label"
  if [ "$force" = 1 ]; then
    XENV="$XENV -e FORCE_AUTOUPDATE_PLUGINS=1"
    en=$(enabled "$PM_KEY=true" "$OM_KEY=true")
    settings "$d/settings.json" "$en" "$(pm_decl "$PM_OLD")" "$(om_decl)"
  else
    settings "$d/settings.json" "$(enabled "$PM_KEY=true")" "$(pm_decl "$PM_OLD")"
  fi
  [ "$PM_OLD" != "$PM_NEW" ] || { V5=FAIL; ev "$label: the pin equals upstream HEAD, so staying proves nothing"; }
  ev "$label: declarations: $(jq -c '.extraKnownMarketplaces' "$d/settings.json" | cut -c1-400); upstream HEAD is $PM_NEW, ahead of the pin"
  session "$d/s1" "$d/settings.json" "$PROMPT"
  evrun "$label: first start" "$d/s1"
  stays "$label: after the first start" "$d/s1"
  session "$d/s2" "$d/settings.json" "$PROMPT"
  evrun "$label: restart 1" "$d/s2"
  stays "$label: after restart 1" "$d/s2"
  session "$d/s3" "$d/settings.json" "$PROMPT"
  evrun "$label: restart 2" "$d/s3"
  stays "$label: after restart 2" "$d/s3"
  ev "$label: now a session open for more than ten minutes with one message (about 11 minutes)..."
  SESSION_LIMIT=900 fifo_session "$d/long" "$d/settings.json" drv_long
  evrun "$label: ten-minute session" "$d/long"
  stays "$label: after the ten-minute session" "$d/long"
  ev "$label: orphaned: [$(orphans)]"
  if [ "$force" = 1 ]; then
    ev "$label: RECORDED the Latest marketplace $OM_NAME: clone HEAD $(clone_head "$OM_NAME"); its plugin loaded at the end: $(has_plugin "$d/long/init.json" "${OM_KEY%@*}" && echo yes || echo no)"
  fi
  [ "$(cat "$d/long/seconds.txt")" -ge 600 ] || { V5=FAIL; ev "$label: the long session lasted under 600 s, the check is invalid"; }
}
item05() {
  local d=$S/05 status
  mkdir -p "$d"
  item05_variant noforce 0
  status=$V5
  ev "noforce: $V5"
  item05_variant force 1
  ev "force: $V5"
  [ "$V5" = PASS ] || status=FAIL
  record 5 "$status" "A pinned plugin stays, over restarts and a ten-minute session (without and with FORCE_AUTOUPDATE_PLUGINS=1)"
}

# 6: repin.
item06() {
  local d=$S/06 status=PASS head
  mkdir -p "$d"
  fresh_remote s06
  settings "$d/pin1.json" "$(enabled "$PM_KEY=true")" "$(pm_decl "$PM_OLD")"
  settings "$d/pin2.json" "$(enabled "$PM_KEY=true")" "$(pm_decl "$PM_NEW")"
  session "$d/s1" "$d/pin1.json" "$PROMPT"
  evrun "pinned at OLD $PM_OLD" "$d/s1"
  ev "clone HEAD after the first start: $(clone_head "$PM_NAME"); installed sha $(installed_sha "$PM_KEY")"
  mark_clear
  session "$d/s2" "$d/pin2.json" "$PROMPT"
  evrun "repinned to NEW $PM_NEW" "$d/s2"
  head=$(clone_head "$PM_NAME")
  ev "clone HEAD at the repin start: $head (want $PM_NEW); installed sha $(installed_sha "$PM_KEY"); plugin loaded: $(has_plugin "$d/s2/init.json" "$(pm_plugin)" && echo yes || echo no); .orphaned_at: [$(orphans)]; marks: [$(mark_list)]"
  [ "$head" = "$PM_NEW" ] && has_plugin "$d/s2/init.json" "$(pm_plugin)" || status=FAIL
  const "repin (item 6): the new commit is fetched and loaded at the repin start: $([ "$status" = PASS ] && echo yes || echo no); old version orphaned: $([ -n "$(orphans)" ] && echo yes || echo no). Fills B6."
  if [ "$status" = FAIL ]; then
    # The fallback: the same restart with autoUpdate true for that one start.
    fresh_remote s06fb
    session "$d/fb1" "$d/pin1.json" "$PROMPT"
    settings "$d/pin2au.json" "$(enabled "$PM_KEY=true")" "$(pm_decl "$PM_NEW" true)"
    session "$d/fb2" "$d/pin2au.json" "$PROMPT"
    evrun "FALLBACK: repin to NEW with autoUpdate true for that start" "$d/fb2"
    ev "fallback: clone HEAD $(clone_head "$PM_NAME") (want $PM_NEW); plugin loaded: $(has_plugin "$d/fb2/init.json" "$(pm_plugin)" && echo yes || echo no); orphaned [$(orphans)]"
    const "repin fallback (item 6): with autoUpdate true for that one start the clone reaches NEW: $([ "$(clone_head "$PM_NAME")" = "$PM_NEW" ] && echo yes || echo no)."
  fi
  record 6 "$status" "Repin: the new pin is fetched and loads at that start"
}

# 7: pinned at OLD, then switched to Latest: when does it move? No upstream push
# is possible, so this does NOT test an upstream push during a Latest agent's
# life, nor a Latest plugin's autoUpdate across a version bump.
item07_variant() { # <label> <0|1>
  local label=$1 force=$2 d=$S/07/$1 h1 h2 h3 cv1 cv2
  mkdir -p "$d"
  fresh_remote "s07$label"
  if [ "$force" = 1 ]; then XENV="$XENV -e FORCE_AUTOUPDATE_PLUGINS=1"; fi
  settings "$d/pinned.json" "$(enabled "$PM_KEY=true")" "$(pm_decl "$PM_OLD")"
  settings "$d/latest.json" "$(enabled "$PM_KEY=true")" "$(pm_decl "" true)"
  cv1=$(run_limited 60 ctr claude --version 2> /dev/null | awk '{print $1}' || true)
  session "$d/s1" "$d/pinned.json" "$PROMPT"
  evrun "$label: first start, pinned at OLD $PM_OLD" "$d/s1"
  h1=$(clone_head "$PM_NAME")
  session "$d/s2" "$d/latest.json" "$PROMPT"
  evrun "$label: restart 1, declaration switched to Latest (no ref, autoUpdate true)" "$d/s2"
  h2=$(clone_head "$PM_NAME")
  session "$d/s3" "$d/latest.json" "$PROMPT"
  evrun "$label: restart 2" "$d/s3"
  h3=$(clone_head "$PM_NAME")
  cv2=$(run_limited 60 ctr claude --version 2> /dev/null | awk '{print $1}' || true)
  ev "$label: clone HEAD: $h1 (first start) -> $h2 (restart 1) -> $h3 (restart 2); remote HEAD when read $PM_NEW; installed sha $(installed_sha "$PM_KEY"); orphaned [$(orphans)]"
  ev "$label: claude --version in the container: $cv1 -> $cv2 (unchanged: $([ "$cv1" = "$cv2" ] && echo yes || echo NO))"
  if [ "$h2" = "$PM_NEW" ]; then
    ev "$label: RECORDED: the clone moves to the remote HEAD at restart 1, before init"
    const "Latest env rule (item 7, FORCE_AUTOUPDATE_PLUGINS=$force): clone reaches the remote HEAD at restart 1."
  elif [ "$h3" = "$PM_NEW" ]; then
    ev "$label: RECORDED: the clone moves to the remote HEAD at restart 2 (one start later)"
    const "Latest env rule (item 7, FORCE_AUTOUPDATE_PLUGINS=$force): clone reaches the remote HEAD at restart 2."
  else
    ev "$label: RECORDED: the clone did not reach the remote HEAD within two restarts"
    const "Latest env rule (item 7, FORCE_AUTOUPDATE_PLUGINS=$force): clone did NOT reach the remote HEAD within two restarts."
  fi
  ev "$label: NOT TESTED here: an upstream push during a Latest agent's life, and a Latest plugin's autoUpdate across a version bump (no upstream we may push to)."
}
item07() {
  mkdir -p "$S/07"
  item07_variant noforce 0
  item07_variant force 1
  ev "Compare the two variants: the env rule for Latest is FORCE_AUTOUPDATE_PLUGINS=1 when only the force variant moves."
  record 7 RECORDED "Pinned, then Latest, on restart, without and with FORCE_AUTOUPDATE_PLUGINS=1 (no upstream push)"
}

# 8 and 9: the network down. Public remote marketplaces, run with
# CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1. The offline session ends in API retries
# (exit status 1 or 124 is expected), so it is capped at 60 s and judged on
# init.plugins only.
item08() {
  local d=$S/08 status=PASS
  mkdir -p "$d"
  # RECORDED: the online start without SYNC.
  fresh_ws s08n
  XENV=""
  settings "$d/nosync.json" "$(enabled "$PM_KEY=true")" "$(pm_decl "$PM_OLD")"
  session "$d/nosync" "$d/nosync.json" "$PROMPT"
  evrun "online start WITHOUT CLAUDE_CODE_SYNC_PLUGIN_INSTALL" "$d/nosync"
  ev "RECORDED: without SYNC the plugin is in the first init: $(has_plugin "$d/nosync/init.json" "$(pm_plugin)" && echo yes || echo no); installed_plugins.json: $(jq -c '.plugins | keys' "$P/installed_plugins.json" 2> /dev/null || echo absent); cache: [$(ls "$P/cache" 2> /dev/null | paste -s -d, -)]"
  const "remote marketplaces and CLAUDE_CODE_SYNC_PLUGIN_INSTALL (item 8): without SYNC the plugin in the first init: $(has_plugin "$d/nosync/init.json" "$(pm_plugin)" && echo yes || echo no). Remote marketplaces need SYNC=1 for plugins in the first init; without it they install later in a long session or never in a short one."
  # The online start with SYNC=1, then the offline restart.
  fresh_remote s08
  XENV="$XENV -e FORCE_AUTOUPDATE_PLUGINS=1"
  settings "$d/settings.json" "$(enabled "$PM_KEY=true" "$OM_KEY=true")" "$(pm_decl "$PM_OLD")" "$(om_decl)"
  session "$d/online" "$d/settings.json" "$PROMPT"
  evrun "online start with SYNC=1 (installs the pinned plugin and a Latest one)" "$d/online"
  has_plugin "$d/online/init.json" "$(pm_plugin)" || { status=FAIL; ev "the pinned plugin is not in the online init, so the offline check is vacuous"; }
  ev "\$P: $(p_listing | paste -s -d' ' - | cut -c1-300)"
  CNET="--network none"
  SESSION_LIMIT=60 session "$d/offline" "$d/settings.json" "$PROMPT"
  evrun "restart with --network none, same \$P (capped at 60 s; exit 1 or 124 from API retries is expected)" "$d/offline"
  ev "RECORDED: pinned $(pm_plugin) loads offline: $(has_plugin "$d/offline/init.json" "$(pm_plugin)" && echo yes || echo no); Latest ${OM_KEY%@*} loads offline: $(has_plugin "$d/offline/init.json" "${OM_KEY%@*}" && echo yes || echo no)"
  has_plugin "$d/offline/init.json" "$(pm_plugin)" || status=FAIL
  const "plugin_not_loaded copy (item 8): offline with the plugin installed, init lists the pinned plugin: $(has_plugin "$d/offline/init.json" "$(pm_plugin)" && echo yes || echo no); printed: $(tr '\n' ' ' < "$d/offline/stderr.txt" | cut -c1-200)"
  record 8 "$status" "Network down, plugin installed: the pinned plugin still loads from \$P"
}
item09() {
  local d=$S/09
  mkdir -p "$d"
  fresh_remote s09
  CNET="--network none"
  settings "$d/settings.json" "$(enabled "$PM_KEY=true" "$OM_KEY=true" marker@fixdir=true dep@fixdir=true)" \
    "$(pm_decl "$PM_OLD")" "$(om_decl)" "$DECL_DIR"
  SESSION_LIMIT=60 session "$d/run" "$d/settings.json" "$PROMPT"
  evrun "empty \$P, --network none (capped at 60 s; exit 1 or 124 is expected), two remote plugins and one directory plugin declared" "$d/run"
  ev "RECORDED: the session starts: $([ -s "$d/run/init.json" ] && echo yes || echo 'NO init (a failed start)'); loaded: [$(plugin_names "$d/run/init.json")]; exit $(cat "$d/run/exit.txt")"
  const "plugin_not_loaded copy (item 9): with an empty \$P and no network the session $([ -s "$d/run/init.json" ] && echo "starts, loaded [$(plugin_names "$d/run/init.json")]" || echo "does not start (no init)"); printed: $(tr '\n' ' ' < "$d/run/stderr.txt" | cut -c1-200). §7.3 step 8 must match."
  record 9 RECORDED "Network down, plugin missing: what Claude Code does and prints"
}

# 10: the agent's own install is disabled by an explicit false at the next start.
item10() {
  local d=$S/10 mk0 mk1
  mkdir -p "$d"
  fresh_ws s10
  XENV="$XENV -e CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1"
  bare_settings "$d/s1.json"
  session "$d/s1" "$d/s1.json" 'Run these two shell commands with the Bash tool, one after the other: claude plugin marketplace add /fixture/dir   and then   claude plugin install marker@fixdir   . Then reply done.' --allowedTools Bash
  evrun "the agent installs marker@fixdir itself" "$d/s1"
  ev "after: installed_plugins.json keys: $(jq -c '.plugins | keys' "$P/installed_plugins.json" 2> /dev/null || echo absent); known_marketplaces keys: $(jq -c 'keys' "$P/known_marketplaces.json" 2> /dev/null || echo absent)"
  mk0=$(jq -c '.fixdir' "$P/known_marketplaces.json" 2> /dev/null || echo absent)
  mark_clear
  settings "$d/s2.json" "$(enabled marker@fixdir=false)"
  session "$d/s2" "$d/s2.json" "$PROMPT"
  evrun "restart with --settings marker@fixdir: false" "$d/s2"
  mk1=$(jq -c '.fixdir' "$P/known_marketplaces.json" 2> /dev/null || echo absent)
  ev "marketplace fixdir in known_marketplaces.json: before restart $mk0; after $mk1 (stays: $([ "$mk1" != absent ] && echo yes || echo no); refreshed: $([ "$mk0" != "$mk1" ] && echo 'entry changed' || echo 'entry identical'))"
  ev "hook-sessionstart mark written at the restart: $([ -e "$MARK/hook-sessionstart" ] && echo YES || echo no)"
  if [ -n "$(jq -r '.plugins["marker@fixdir"] // empty' "$P/installed_plugins.json" 2> /dev/null)" ] && ! has_plugin "$d/s2/init.json" marker; then
    record 10 PASS "The agent's own install is disabled by an explicit false at the next start"
  elif [ -z "$(jq -r '.plugins["marker@fixdir"] // empty' "$P/installed_plugins.json" 2> /dev/null)" ]; then
    record 10 RECORDED "The agent's own install did not happen in the session (see the first run's stream); the check is vacuous"
  else
    record 10 FAIL "marker@fixdir loaded after the agent installed it and --settings said false"
  fi
}

# 11: skill naming.
item11() {
  local d=$S/11 cmds
  fresh_ws s11
  mkdir -p "$d" "$W/.claude/skills"
  cp -a "$FX/extras/skill-foo" "$W/.claude/skills/foo"
  bare_settings "$d/settings.json"
  session "$d/run" "$d/settings.json" "$PROMPT"
  cmds=$(jq -r '.slash_commands[]?' "$d/run/init.json" 2> /dev/null || true)
  evi ".claude/skills/foo/SKILL.md with name: bar" "$d/run/init.json"
  if printf '%s\n' "$cmds" | grep -q -x -E '/?foo'; then ev "slash_commands has foo"; else ev "slash_commands has no foo"; fi
  if printf '%s\n' "$cmds" | grep -q -x -E '/?bar'; then ev "slash_commands has bar"; else ev "slash_commands has no bar"; fi
  record 11 RECORDED "Skill naming: directory name (foo) or frontmatter name (bar) in slash_commands"
}

# 12: data/ and mcpb/ land under $P.
item12() {
  local d=$S/12 data status=PASS existed=no
  mkdir -p "$d"
  fresh_ws s12
  std_settings "$d/settings.json"
  session "$d/first" "$d/settings.json" "$PROMPT"
  evrun "first run" "$d/first"
  set -- "$P"/data/marker*/x
  data=$1
  if [ -e "$data" ]; then
    ev "marker's MCP server wrote $data under \$P (content: $(tr -d '\n' < "$data"))"
  else
    ev "NO \$P/data/marker*/x after the run; \$P listing:"
    p_listing | sed 's/^/    /' >> "$EV"
    status=FAIL
  fi
  ev "plugin data or MCP bundles under \$AG or \$HOME: [$(find "$AG" "$HM" \( -name data -o -name mcpb \) 2> /dev/null | sed "s#^$T/##" | paste -s -d, - || true)]"
  if [ -d "$P/mcpb" ]; then existed=yes; fi
  ev "\$P/mcpb existed after the first run: $existed (marker's server is a plain .mcp.json server, so Claude may never create it)"
  mark_clear
  session "$d/second" "$d/settings.json" "$PROMPT"
  evrun "restart, same \$P" "$d/second"
  [ -e "$data" ] || { status=FAIL; ev "data/ did not survive the restart"; }
  ev "data survived the restart: $([ -e "$data" ] && echo yes || echo no); mcp-start mark at the restart: $([ -e "$MARK/mcp-start" ] && echo yes || echo no)"
  record 12 "$status" "data/ and mcpb/ land under \$P and survive a restart"
}

# 13: install and update run no plugin code.
item13() {
  local d=$S/13 status=PASS m
  mkdir -p "$d"
  # (a) the CLI install of marker (with its dependency dep and its npm dependency) and of ranged (a dependency by range).
  fresh_ws s13a
  pc "$d/add.txt" marketplace add /fixture/dir
  pc "$d/i1.txt" install marker@fixdir
  m=$(mark_list)
  ev "after plugin install marker@fixdir (npm dependency, plugin dependency dep): MARK=[$m] (exit $(pc_rc "$d/i1.txt"))"
  test -z "$(ls -A "$MARK")" || status=FAIL
  pc "$d/i2.txt" install ranged@fixdir
  ev "after plugin install ranged@fixdir (a dependency by range): MARK=[$(mark_list)] (exit $(pc_rc "$d/i2.txt"))"
  test -z "$(ls -A "$MARK")" || status=FAIL
  ev "node_modules in the installed marker: $(find "$P/cache/fixdir/marker" -maxdepth 3 -name node_modules 2> /dev/null | head -n 1 | grep -c . || true)"
  # (b) the install Claude Code does at start (the marks a session writes are excluded; install-time ones are not).
  fresh_ws s13b
  settings "$d/b.json" "$(enabled marker@fixdir=true dep@fixdir=true ranged@fixdir=true)" "$DECL_DIR"
  session "$d/b" "$d/b.json" "$PROMPT"
  evrun "(b) install at start" "$d/b"
  ev "(b) marks: [$(mark_list)]; install-time marks (npm-preinstall, npm-postinstall): [$(install_marks)]"
  [ -z "$(install_marks)" ] || status=FAIL
  # (c) a repin: the remote plugins carry no code of ours, so item 6 lists the marks after its repin.
  ev "(c) repin: covered by item 6's marks line (no fixture code runs at a repin of a public marketplace)."
  record 13 "$status" "Install and update run no plugin code (MARK empty after the CLI installs; no npm preinstall/postinstall mark at start)"
}

# 14: skills-directory plugins.
item14() {
  local d=$S/14 where flag loaded
  mkdir -p "$d"
  for where in a b c; do
    for flag in default false; do
      fresh_ws "s14$where$flag"
      case "$where" in
        a) mkdir -p "$W/.claude/skills"; cp -a "$FX/extras/sneaky" "$W/.claude/skills/sneaky" ;;
        b) mkdir -p "$AG/skills"; cp -a "$FX/extras/sneaky" "$AG/skills/sneaky" ;;
        c)
          # the target sits under $AG, which is mounted at the same path, so the link resolves
          mkdir -p "$W/.claude/skills" "$AG/outside-$flag"
          cp -a "$FX/extras/sneaky" "$AG/outside-$flag/sneaky"
          ln -s "$AG/outside-$flag/sneaky" "$W/.claude/skills/sneaky"
          ;;
      esac
      AG_KEEP=1
      std_settings "$d/$where-$flag.json"
      if [ "$flag" = false ]; then
        jq -c '.enabledPlugins["sneaky@skills-dir"] = false' "$d/$where-$flag.json" > "$d/tmp.json"
        mv "$d/tmp.json" "$d/$where-$flag.json"
      fi
      session "$d/$where-$flag" "$d/$where-$flag.json" "$PROMPT"
      loaded=no
      if has_plugin "$d/$where-$flag/init.json" sneaky || [ -e "$MARK/sneaky" ]; then loaded=yes; fi
      ev "($where) settings $flag: loaded=$loaded (init lists: [$(plugin_names "$d/$where-$flag/init.json")], hook marker: $([ -e "$MARK/sneaky" ] && echo yes || echo no))  [a = \$W/.claude/skills, b = \$AG/skills (user level), c = a link in \$W/.claude/skills]"
    done
  done
  ev "read: 'loaded' under default settings answers whether each location loads; 'false' stops it when loaded=no there."
  record 14 RECORDED "Skills-directory plugins: where they load, and whether sneaky@skills-dir:false stops them"
}

# 15: project and local settings.
item15() {
  local d=$S/15 winner
  mkdir -p "$d"
  # A. settings.local.json enables marker; --settings says false for the same key.
  fresh_ws s15a
  mkdir -p "$W/.claude"
  printf '%s\n' '{"enabledPlugins":{"marker@fixdir":true}}' > "$W/.claude/settings.local.json"
  settings "$d/a.json" "$(enabled marker@fixdir=false dep@fixdir=true)" "$DECL_DIR"
  session "$d/a" "$d/a.json" "$PROMPT"
  evrun "(A) settings.local.json true vs --settings false" "$d/a"
  if has_plugin "$d/a/init.json" marker; then
    winner="settings.local.json wins: --settings is only a carrier, the 7.3 start check is what enforces the rule"
  else
    winner="--settings wins: it is a second layer behind the 7.3 start check"
  fi
  ev "(A) RECORDED: $winner"
  # B. settings.local.json declares another marketplace and enables x@evil.
  fresh_ws s15b
  mkdir -p "$W/.claude"
  printf '%s\n' '{"extraKnownMarketplaces":{"evil":{"source":{"source":"directory","path":"/fixture/evil"}}},"enabledPlugins":{"x@evil":true}}' > "$W/.claude/settings.local.json"
  std_settings "$d/b.json"
  session "$d/b" "$d/b.json" "$PROMPT"
  evrun "(B) settings.local.json declares marketplace evil and enables x@evil" "$d/b"
  ev "(B) RECORDED: x loaded: $(has_plugin "$d/b/init.json" x && echo yes || echo no); x-hook mark: $([ -e "$MARK/x-hook" ] && echo yes || echo no); evil in known_marketplaces.json: $(jq -c 'has("evil")' "$P/known_marketplaces.json" 2> /dev/null || echo absent); installed: $(jq -c '.plugins | keys' "$P/installed_plugins.json" 2> /dev/null || echo absent)"
  record 15 RECORDED "Project and local settings: which wins for enabledPlugins, and whether an unregistered marketplace is fetched"
}

# 16: a directory marketplace's catalog.
item16() {
  local d=$S/16
  mkdir -p "$d"
  fresh_ws s16
  settings "$d/settings.json" "$(enabled marker@fixdir=true dep@fixdir=true)" "$DECL_DIR"
  ev "rel@fixdir: not installed, not in enabledPlugins; fixdir declared in extraKnownMarketplaces"
  session "$d/run" "$d/settings.json" "$PROMPT"
  evrun "init" "$d/run"
  ev "RECORDED: rel loads: $(has_plugin "$d/run/init.json" rel && echo yes || echo no); rel-hook mark: $([ -e "$MARK/rel-hook" ] && echo yes || echo no)"
  record 16 RECORDED "A directory marketplace's relative defaultEnabled plugin, not installed and not in enabledPlugins"
}

# 17: project hooks and live reload.
write_project_settings() { # <file>
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
drv_reload() {
  umsg "$PROMPT"
  sleep 25
  printf '%s' '{"enabledPlugins":{"marker@fixdir":true}}' > "$W/.claude/settings.local.json"
  umsg '/reload-plugins'
  sleep 25
  umsg 'List the names of the plugins and skills available to you, then stop.'
  sleep 30
}
item17() {
  local d=$S/17 reload
  mkdir -p "$d"
  fresh_ws s17
  XENV="$XENV -e CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1"
  mkdir -p "$W/.claude"
  write_project_settings "$W/.claude/settings.json"
  settings "$d/settings.json" "$(enabled marker@fixdir=false dep@fixdir=true)" "$DECL_DIR"
  session "$d/run" "$d/settings.json" "$PROMPT"
  evrun "project hooks and statusLine, -p mode" "$d/run"
  ev "RECORDED: project-level SessionStart hook ran: $([ -e "$MARK/project-hook" ] && echo yes || echo no)"
  ev "RECORDED: project-level statusLine ran in -p mode: $([ -e "$MARK/project-statusline" ] && echo yes || echo no) (a statusLine usually needs an interactive session, which this script does not drive)"
  mark_clear
  session "$d/reload" "$d/settings.json" '/reload-plugins'
  reload=no
  if jq -e '.slash_commands[]? | select(. == "reload-plugins" or . == "/reload-plugins")' "$d/reload/init.json" > /dev/null 2>&1; then reload=yes; fi
  ev "RECORDED: reload-plugins in -p slash_commands: $reload; result of /reload-plugins with -p: $(jq -r 'select(.type=="result") | .result' "$d/reload/out.jsonl" 2> /dev/null | sed -n '1,3p' | cut -c1-300 | paste -s -d' ' -)"
  # An enabledPlugins change in settings.local.json mid-session, in one stream-json session.
  fresh_ws s17b
  XENV="$XENV -e CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1"
  mkdir -p "$W/.claude"
  SESSION_LIMIT=240 fifo_session "$d/live" "$d/settings.json" drv_reload
  evrun "mid-session: settings.local.json sets marker@fixdir true while the session runs (--settings says false)" "$d/live"
  ev "RECORDED: marker's hook or MCP server ran after the mid-session change: hook-sessionstart $([ -e "$MARK/hook-sessionstart" ] && echo yes || echo no), mcp-start $([ -e "$MARK/mcp-start" ] && echo yes || echo no)"
  ev "RECORDED: results of the three messages: $(jq -r 'select(.type=="result") | .result' "$d/live/out.jsonl" 2> /dev/null | cut -c1-200 | paste -s -d'|' -)"
  record 17 RECORDED "Project hooks and statusLine run (the 7.3 check is needed); /reload-plugins; a mid-session enabledPlugins change"
}

# 18: frontmatter hooks.
item18() {
  local d=$S/18 cmds n tools='Bash,Task,Agent,Skill'
  mkdir -p "$d"
  std_settings "$d/settings.json"
  # (a) a skill with frontmatter hooks in $W/.claude/skills/h.
  fresh_ws s18a
  XENV="$XENV -e CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1"
  mkdir -p "$W/.claude/skills"
  cp -a "$FX/extras/skill-h" "$W/.claude/skills/h"
  session "$d/a" "$d/settings.json" '/h' --allowedTools "$tools"
  evi "(a) skill h with frontmatter hooks, invoked as /h" "$d/a/init.json"
  ev "(a) RECORDED: skill frontmatter SessionStart hook ran: $([ -e "$MARK/skill-h-sessionstart" ] && echo yes || echo no); PreToolUse hook ran: $([ -e "$MARK/skill-h-pretooluse" ] && echo yes || echo no)"
  # (b) a subagent with hooks and mcpServers in $W/.claude/agents/a.md.
  fresh_ws s18b
  XENV="$XENV -e CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1"
  mkdir -p "$W/.claude/agents"
  cp "$FX/extras/agent-a.md" "$W/.claude/agents/a.md"
  session "$d/b" "$d/settings.json" 'Delegate to the subagent named a and have it run echo hi. Then reply done.' --allowedTools "$tools"
  evi "(b) subagent a in \$W/.claude/agents" "$d/b/init.json"
  ev "(b) RECORDED: subagent PreToolUse hook ran: $([ -e "$MARK/agent-a-pretooluse" ] && echo yes || echo no); subagent mcpServers entry started: $([ -e "$MARK/agent-a-mcp" ] && echo yes || echo no)"
  # (c) the same subagent in $AG/agents, plus skills in $AG/commands and $AG/agents.
  fresh_ws s18c
  XENV="$XENV -e CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1"
  AG_KEEP=1
  mkdir -p "$AG/agents" "$AG/commands/cskill" "$AG/agents/askill"
  cp "$FX/extras/agent-a.md" "$AG/agents/a.md"
  printf -- '---\nname: cskill\ndescription: G1 probe skill under commands\n---\nSay hello.\n' > "$AG/commands/cskill/SKILL.md"
  printf -- '---\nname: askill\ndescription: G1 probe skill under agents\n---\nSay hello.\n' > "$AG/agents/askill/SKILL.md"
  printf -- '---\ndescription: G1 probe command\n---\nSay hello.\n' > "$AG/commands/cmd.md"
  session "$d/c" "$d/settings.json" 'Delegate to the subagent named a and have it run echo hi. Then reply done.' --allowedTools "$tools"
  evi "(c) subagent a in \$AG/agents; skills in \$AG/commands and \$AG/agents" "$d/c/init.json"
  ev "(c) RECORDED: subagent PreToolUse hook ran: $([ -e "$MARK/agent-a-pretooluse" ] && echo yes || echo no); subagent mcpServers entry started: $([ -e "$MARK/agent-a-mcp" ] && echo yes || echo no)"
  cmds=$(jq -r '.slash_commands[]?' "$d/c/init.json" 2> /dev/null || true)
  for n in cmd cskill askill; do
    if printf '%s\n' "$cmds" | grep -q -x -E "/?$n"; then ev "(c) RECORDED: $n is in slash_commands"; else ev "(c) RECORDED: $n is NOT in slash_commands"; fi
  done
  ev "(c) RECORDED: agents in init: $(jq -c '.agents' "$d/c/init.json" 2> /dev/null)"
  record 18 RECORDED "Frontmatter hooks of skills and subagents; skills in AG/commands and AG/agents"
}

# 19: required synced plugins: not testable by Or.
item19() {
  ev "UNTESTED, a known gap: no organisation setting marks a plugin as required, so there is nothing to sign an agent into. To be handled if a real case appears."
  record 19 RECORDED "Required synced plugins with syncClaudeAiPlugins: false: UNTESTED, a known gap (handle if a real case appears)"
}

# 20: install and start timing (timing.sh, RECORDED).
item20() {
  local out=$T/timing.md rc=0
  ev "Runs scripts/g1/timing.sh in throwaway containers of $IMAGE. The credential is passed by name for the session-start timings (e)."
  ev "Fixture: the directory marketplace built for this run (marker and ranged); superpowers and the official plugins from GitHub."
  bash "$HERE/timing.sh" --image "$IMAGE" --fixture "$FX" > "$out" 2> "$T/timing.err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    ev "timing.sh exited $rc: $(tail -n 3 "$T/timing.err" | tr '\n' ' ')"
    : > "$out"
  fi
  evf "timing.sh stderr" "$T/timing.err"
  record 20 RECORDED "Install and start timing (table under 'Install and start timing' below)"
}

# 21: the floor.
item21() {
  ev "The pin ($PIN) is the floor unless an older version passes."
  ev "To test an older one, if you can: build or pull an image with it, then run"
  ev "    G1_FLOOR_PROBE=1 scripts/g1/run.sh <older-image>"
  ev "and read items 1-9, 12 and 15 in that report. The lowest version where they all hold is the floor."
  ev "A probe report is not the Gate G1 report (it says so at the top)."
  const "floor (item 21): $PIN (the pin), unless Or probes an older image with G1_FLOOR_PROBE=1 and records it here. Fills B3's MIN_CLAUDE_VERSION."
  record 21 MANUAL "The version floor (lowest version where items 1-9, 12 and 15 hold)"
}

# -------------------------------------------------------------------- report
build_report() {
  local tmpl=$HERE/report-template.md out=$T/report.md line summary details f tab
  [ -s "$T/summary.tsv" ] || return 0
  tab=$(printf '\t')
  summary=$T/summary.md
  {
    printf '| Item | Status | What |\n|---|---|---|\n'
    sort -n -t "$tab" -k1,1 "$T/summary.tsv" | while IFS="$tab" read -r id st title; do
      printf '| %s | %s | %s |\n' "$id" "$st" "$title"
    done
  } > "$summary"
  details=$T/details.md
  : > "$details"
  for f in "$RES"/*.md; do
    [ -e "$f" ] && cat "$f" >> "$details"
  done
  : > "$out"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      @@SUMMARY@@) cat "$summary" >> "$out" ;;
      @@DETAILS@@) cat "$details" >> "$out" ;;
      @@CONSTANTS@@)
        if [ -s "$T/constants.txt" ]; then sed 's/^/- /' "$T/constants.txt" >> "$out"; else echo "(none recorded)" >> "$out"; fi
        ;;
      @@TIMING@@)
        if [ -s "$T/timing.md" ]; then cat "$T/timing.md" >> "$out"; else echo "(item 20 did not produce a table; see its details)" >> "$out"; fi
        ;;
      @@PROBE_NOTE@@) printf '%s\n' "$PROBE_NOTE" >> "$out" ;;
      *)
        line=${line//@@DATE@@/$(date -u +%Y-%m-%dT%H:%M:%SZ)}
        line=${line//@@CLAUDE_VERSION@@/$CLAUDE_VERSION}
        line=${line//@@PINNED_VERSION@@/$PIN}
        line=${line//@@IMAGE@@/$IMAGE}
        line=${line//@@IMAGE_ID@@/$IMAGE_ID}
        line=${line//@@HOST@@/$(uname -sm), docker $(docker version -f '{{.Server.Version}} {{.Server.Arch}}' 2> /dev/null || echo '?')}
        line=${line//@@FILE_URL@@/$FILE_URL_NOTE}
        line=${line//@@SHAS@@/official OLD ${OFF_OLD:-?} NEW ${OFF_NEW:-?}; superpowers OLD ${SUP_OLD:-?} NEW ${SUP_NEW:-?}; item 0 fixture first ${FIX_FIRST:-?}, second ${FIX_SECOND:-?}}
        line=${line//@@WORKDIR@@/$T}
        printf '%s\n' "$line" >> "$out"
        ;;
    esac
  done < "$tmpl"
}

# The credential must be nowhere under the work dir. grep reads the token from
# a process substitution, so it never appears in a process list.
credential_scan() {
  if grep -r -l -F -f <(printf '%s\n' "$CLAUDE_CODE_OAUTH_TOKEN") "$T" > "$T/leaks.txt" 2> /dev/null; then
    echo "g1: THE CREDENTIAL APPEARS IN THESE FILES; the report is withheld. Delete the work dir:" >&2
    sed 's/^/  /' "$T/leaks.txt" >&2
    rm -f "$T/report.md"
    return 1
  fi
  rm -f "$T/leaks.txt"
}

finish() {
  local rc=$?
  trap - EXIT
  build_report || true
  if [ -s "$T/report.md" ] && ! credential_scan; then rc=1; fi
  if [ -s "$T/report.md" ]; then
    echo
    echo "g1: report: $T/report.md"
    if grep -q $'\tFAIL\t' "$T/summary.tsv" 2> /dev/null; then
      echo "g1: FAIL items present: send them to owner-i5 before the design adapts (item 2 goes to Or, spec P6)"
    fi
    echo "g1: post report.md on #153."
    printf 'g1: delete the work dir when done: rm -rf %q\n' "$T"
  fi
  if [ "$rc" -ne 0 ]; then echo "g1: stopped early (exit $rc); the report holds what finished" >&2; fi
  exit "$rc"
}
trap finish EXIT

# ----------------------------------------------------------------------- main
bash "$HERE/fixture/make-fixture.sh" "$FX" > "$T/make-fixture.log" 2>&1 || die "make-fixture.sh failed; see $T/make-fixture.log"
# shellcheck source=/dev/null
. "$FX/SHAS"
DECL_DIR=$(decl fixdir "$SRC_DIR")
cp -a "$FX/src-fixture.git" "$R/acme.git"   # item 0's bare repo, mounted read-only
pick_commits OFF "$OFF_URL" skill-creator
pick_commits SUP "$SUP_URL" superpowers
set_pm OFF                                   # item 4 may switch it to SUP

# G1_ITEMS="3 4 5" runs only those items (default: all). Item 4 chooses the
# marketplace that 5-9 pin, so include it when you run 5-9.
run_item() {
  local n=$((10#$1))
  case " ${G1_ITEMS:-all} " in *" all "*|*" $n "*) "item$1" ;; esac
}
run_item 00
run_item 01
run_item 02
run_item 03
run_item 04
run_item 05
run_item 06
run_item 07
run_item 08
run_item 09
run_item 10
run_item 11
run_item 12
run_item 13
run_item 14
run_item 15
run_item 16
run_item 17
run_item 18
run_item 19
run_item 20
run_item 21

echo
echo "g1: manual steps: item 19 (an organisation) and item 21 (an older image). See report.md."
