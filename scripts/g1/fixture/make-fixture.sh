#!/usr/bin/env bash
# Builds the Gate G1 fixture (spec section 13, "Setup") under <outdir>.
#
# Usage: make-fixture.sh <outdir> <github-owner>
#
# Output (everything is rebuilt from scratch on each call, and the git history
# is deterministic, so the commit SHAs are identical every time):
#   <outdir>/of-g1-fixture/   git marketplace "fixture": marker, dep, ranged, shaext.
#                             Two commits; the second changes marker. Push this.
#   <outdir>/of-g1-other/     git marketplace "evil" (plugin x) that is also the
#                             plugin "shaext" at its root. One commit. Push this.
#   <outdir>/localdir/        plain directory marketplace "localdir" with the
#                             relative plugin "rel" (defaultEnabled: true).
#   <outdir>/extras/          skill-foo (item 5), sneaky (item 9), skill-h and
#                             agent-a.md (item 17). Copied into workdirs by run.sh.
#   <outdir>/SHAS             shell-sourceable commit SHAs, read by run.sh.
#
# It needs the network once, for `npm install --package-lock-only` (the
# lockfile of marker's one dependency). It runs no plugin code and never runs
# `claude`.
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <outdir> <github-owner>" >&2
  exit 2
fi
OUT=$1
OWNER=$2
case "$OWNER" in
  '' | *[!A-Za-z0-9-]*)
    echo "github owner must be letters, digits and dashes: $OWNER" >&2
    exit 2
    ;;
esac
for tool in git npm jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool" >&2; exit 2; }
done

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd -P)
FX=$OUT/of-g1-fixture
OTHER=$OUT/of-g1-other
LOCALDIR=$OUT/localdir
EXTRAS=$OUT/extras
rm -rf "$FX" "$OTHER" "$LOCALDIR" "$EXTRAS" "$OUT/SHAS" "$OUT/.npm-cache"

# Fixed identity and dates make the commit SHAs reproducible.
export GIT_AUTHOR_NAME="G1 fixture" GIT_AUTHOR_EMAIL="g1@example.invalid"
export GIT_COMMITTER_NAME="G1 fixture" GIT_COMMITTER_EMAIL="g1@example.invalid"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
DATE1="2026-01-01T00:00:00Z"
DATE2="2026-01-02T00:00:00Z"

git_init() {
  git -C "$1" init -q
  git -C "$1" checkout -q -b main
}

git_commit() { # <repo> <date> <message>
  git -C "$1" add -A
  GIT_AUTHOR_DATE=$2 GIT_COMMITTER_DATE=$2 git -C "$1" commit -q --no-gpg-sign -m "$3"
}

# The one code path every plugin shares: it leaves a file named after the
# caller in $MARK. A file there means "plugin code ran".
put_mark_sh() { # <dir>
  mkdir -p "$1"
  cat > "$1/mark.sh" <<'EOF'
#!/bin/sh
# Records that a code path ran: appends one line to $MARK/<name>.
set -eu
mkdir -p "${MARK:?MARK is not set}"
printf '%s %s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$MARK/$1"
EOF
  chmod +x "$1/mark.sh"
}

# ---------------------------------------------------------------- of-g1-other
mkdir -p "$OTHER/.claude-plugin" "$OTHER/plugins/x/.claude-plugin" "$OTHER/plugins/x/hooks"
git_init "$OTHER"
# The repo root is the plugin "shaext" (used as an external source with a sha).
cat > "$OTHER/.claude-plugin/plugin.json" <<'EOF'
{ "name": "shaext", "version": "1.0.0", "description": "G1: external plugin pinned by sha" }
EOF
# The repo is also the marketplace "evil" with the plugin "x" (items 6, 12, 15).
cat > "$OTHER/.claude-plugin/marketplace.json" <<'EOF'
{
  "name": "evil",
  "owner": { "name": "G1" },
  "plugins": [ { "name": "x", "source": "./plugins/x", "description": "G1: plugin of an unregistered marketplace" } ]
}
EOF
cat > "$OTHER/plugins/x/.claude-plugin/plugin.json" <<'EOF'
{ "name": "x", "version": "1.0.0", "description": "G1: x@evil, writes a marker if it ever loads" }
EOF
cat > "$OTHER/plugins/x/hooks/hooks.json" <<'EOF'
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "sh \"${CLAUDE_PLUGIN_ROOT}/mark.sh\" x-hook" } ] } ] } }
EOF
put_mark_sh "$OTHER/plugins/x"
git_commit "$OTHER" "$DATE1" "g1: other marketplace"
OTHER_HEAD=$(git -C "$OTHER" rev-parse HEAD)

# --------------------------------------------------------------- of-g1-fixture
mkdir -p "$FX/.claude-plugin"
git_init "$FX"

cat > "$FX/.claude-plugin/marketplace.json" <<EOF
{
  "name": "fixture",
  "owner": { "name": "G1" },
  "plugins": [
    { "name": "marker", "source": "./plugins/marker", "description": "G1: every code path writes a marker" },
    { "name": "dep", "source": "./plugins/dep", "description": "G1: exact dependency of marker" },
    { "name": "ranged", "source": "./plugins/ranged", "description": "G1: depends on dep with a version range" },
    { "name": "shaext", "source": { "source": "github", "repo": "$OWNER/of-g1-other", "sha": "$OTHER_HEAD" }, "description": "G1: external source with a sha" }
  ]
}
EOF

# dep: an exact dependency of marker.
D=$FX/plugins/dep
mkdir -p "$D/.claude-plugin" "$D/skills/dep-hello"
cat > "$D/.claude-plugin/plugin.json" <<'EOF'
{ "name": "dep", "version": "1.0.0", "description": "G1: dependency of marker" }
EOF
cat > "$D/skills/dep-hello/SKILL.md" <<'EOF'
---
name: dep-hello
description: G1 dependency plugin skill. Never needed.
---
Say hello.
EOF

# ranged: depends on dep through a version range (resolved against git tags).
R=$FX/plugins/ranged
mkdir -p "$R/.claude-plugin" "$R/skills/ranged-hello"
cat > "$R/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "ranged",
  "version": "1.0.0",
  "description": "G1: dependency with a version range",
  "dependencies": [ { "name": "dep", "version": "~1.0.0" } ]
}
EOF
cat > "$R/skills/ranged-hello/SKILL.md" <<'EOF'
---
name: ranged-hello
description: G1 ranged plugin skill. Never needed.
---
Say hello.
EOF

# marker: every code path writes to $MARK.
M=$FX/plugins/marker
mkdir -p "$M/.claude-plugin" "$M/hooks" "$M/bin" "$M/monitors"
put_mark_sh "$M/scripts"

write_marker_manifest() { # <version>
  cat > "$M/.claude-plugin/plugin.json" <<EOF
{
  "name": "marker",
  "version": "$1",
  "description": "G1: every code path writes a marker into \$MARK",
  "dependencies": [ "dep" ]
}
EOF
}
write_marker_manifest 1.0.0

# 1. SessionStart hook.
cat > "$M/hooks/hooks.json" <<'EOF'
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "sh \"${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh\" hook-sessionstart" } ] } ] } }
EOF

# 2. MCP server; it also writes ${CLAUDE_PLUGIN_DATA}/x (passed as DATA).
cat > "$M/.mcp.json" <<'EOF'
{
  "mcpServers": {
    "marker": {
      "command": "node",
      "args": [ "${CLAUDE_PLUGIN_ROOT}/server.js" ],
      "env": { "MARK": "${MARK}", "DATA": "${CLAUDE_PLUGIN_DATA}" }
    }
  }
}
EOF
cat > "$M/server.js" <<'EOF'
// Minimal MCP stdio server for G1. On start it leaves $MARK/mcp-start and
// ${CLAUDE_PLUGIN_DATA}/x, then answers the handshake and an empty tool list.
const fs = require('fs');
const path = require('path');

const mark = process.env.MARK;
const data = process.env.DATA;
if (!mark || !data) {
  console.error('marker server: MARK and DATA must be set');
  process.exit(1);
}
fs.mkdirSync(mark, { recursive: true });
fs.appendFileSync(path.join(mark, 'mcp-start'), `${new Date().toISOString()}\n`);
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'x'), 'x\n');

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue; // a notification
    let result = {};
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'marker', version: '1.0.0' },
      };
    } else if (message.method === 'tools/list') {
      result = { tools: [] };
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  }
});
EOF

# 3. bin/x (on the Bash tool's PATH while the plugin is enabled).
cat > "$M/bin/x" <<'EOF'
#!/bin/sh
exec sh "$(dirname "$0")/../scripts/mark.sh" bin-x
EOF
chmod +x "$M/bin/x"

# 4. A monitors entry.
cat > "$M/monitors/monitors.json" <<'EOF'
[
  {
    "name": "marker-monitor",
    "command": "sh \"${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh\" monitor",
    "description": "G1: writes a marker if the monitor starts"
  }
]
EOF

# 5. package.json: one real registry dependency (exact), a lockfile, and
#    preinstall/postinstall scripts that write markers if anything runs npm.
cat > "$M/package.json" <<'EOF'
{
  "name": "g1-marker",
  "version": "1.0.0",
  "private": true,
  "dependencies": { "ms": "2.1.3" },
  "scripts": {
    "preinstall": "sh scripts/mark.sh npm-preinstall",
    "postinstall": "sh scripts/mark.sh npm-postinstall"
  }
}
EOF
(
  cd "$M"
  NPM_CONFIG_CACHE="$OUT/.npm-cache" npm install --package-lock-only --ignore-scripts \
    --no-audit --no-fund --loglevel=error
)
test -s "$M/package-lock.json" || { echo "npm did not write package-lock.json" >&2; exit 1; }
rm -rf "$OUT/.npm-cache"

git_commit "$FX" "$DATE1" "g1: fixture marketplace, first commit"
FIXTURE_FIRST=$(git -C "$FX" rev-parse HEAD)
# dep--v<version> is the tag form Claude Code resolves a dependency range against.
git -C "$FX" tag dep--v1.0.0

# The second commit changes marker (new version, new content).
write_marker_manifest 1.1.0
echo "changed in the second commit" > "$M/CHANGED"
git_commit "$FX" "$DATE2" "g1: marker changes"
FIXTURE_HEAD=$(git -C "$FX" rev-parse HEAD)

# ------------------------------------------------------------------- localdir
# A directory marketplace (not a git repo) with a relative plugin that is on by
# default.
P=$LOCALDIR/plugins/rel
mkdir -p "$LOCALDIR/.claude-plugin" "$P/.claude-plugin" "$P/hooks"
cat > "$LOCALDIR/.claude-plugin/marketplace.json" <<'EOF'
{
  "name": "localdir",
  "owner": { "name": "G1" },
  "plugins": [ { "name": "rel", "source": "./plugins/rel", "description": "G1: relative plugin, defaultEnabled" } ]
}
EOF
cat > "$P/.claude-plugin/plugin.json" <<'EOF'
{ "name": "rel", "version": "1.0.0", "description": "G1: loads by default", "defaultEnabled": true }
EOF
cat > "$P/hooks/hooks.json" <<'EOF'
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "sh \"${CLAUDE_PLUGIN_ROOT}/mark.sh\" rel-hook" } ] } ] } }
EOF
put_mark_sh "$P"

# --------------------------------------------------------------------- extras
mkdir -p "$EXTRAS"

# Item 5: the directory is "foo", the frontmatter name is "bar".
mkdir -p "$EXTRAS/skill-foo"
cat > "$EXTRAS/skill-foo/SKILL.md" <<'EOF'
---
name: bar
description: G1 skill-naming probe. The directory is foo and the frontmatter name is bar.
---
Say hello.
EOF

# Item 9: the sneaky skills-directory plugin: a plugin manifest inside a skill
# folder, with a SessionStart hook.
S=$EXTRAS/sneaky
mkdir -p "$S/.claude-plugin" "$S/hooks"
cat > "$S/.claude-plugin/plugin.json" <<'EOF'
{ "name": "sneaky", "version": "1.0.0", "description": "G1: a plugin inside the skills folder", "defaultEnabled": true }
EOF
cat > "$S/SKILL.md" <<'EOF'
---
name: sneaky
description: G1 skills-directory plugin probe. Never needed.
---
Say hello.
EOF
cat > "$S/hooks/hooks.json" <<'EOF'
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "sh \"${CLAUDE_PLUGIN_ROOT}/mark.sh\" sneaky" } ] } ] } }
EOF
put_mark_sh "$S"

# Item 17: a skill whose frontmatter declares hooks.
mkdir -p "$EXTRAS/skill-h"
cat > "$EXTRAS/skill-h/SKILL.md" <<'EOF'
---
name: h
description: G1 frontmatter-hooks probe. Use it when asked to run /h.
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: 'mkdir -p "$MARK" && echo x >> "$MARK/skill-h-sessionstart"'
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: 'mkdir -p "$MARK" && echo x >> "$MARK/skill-h-pretooluse"'
---
Run `echo hi` with the Bash tool, then reply with the word done.
EOF

# Item 17: a subagent whose frontmatter declares hooks and mcpServers.
cat > "$EXTRAS/agent-a.md" <<'EOF'
---
name: a
description: G1 frontmatter probe subagent. Use it when asked to delegate to the subagent named a.
tools: Bash
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: 'mkdir -p "$MARK" && echo x >> "$MARK/agent-a-pretooluse"'
mcpServers:
  amcp:
    command: sh
    args: ['-c', 'mkdir -p "$MARK" && echo x >> "$MARK/agent-a-mcp"; cat']
    env:
      MARK: '${MARK}'
---
Run `echo hi` with the Bash tool and report its output.
EOF

# ----------------------------------------------------------------------- SHAS
cat > "$OUT/SHAS" <<EOF
FIXTURE_FIRST=$FIXTURE_FIRST
FIXTURE_HEAD=$FIXTURE_HEAD
OTHER_HEAD=$OTHER_HEAD
EOF

echo "fixture built in $OUT"
echo "  of-g1-fixture: $FIXTURE_FIRST (first), $FIXTURE_HEAD (second)"
echo "  of-g1-other:   $OTHER_HEAD"
