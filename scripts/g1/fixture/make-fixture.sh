#!/usr/bin/env bash
# Builds the Gate G1 fixture (spec section 13, "Setup") under <outdir>.
#
# Usage: make-fixture.sh <outdir>
#
# It needs only git. Everything is rebuilt from scratch on each call, and the
# git history is deterministic, so the commit SHAs are identical every time.
# It runs no plugin code, never runs `claude` and never touches the network.
#
# Output:
#   <outdir>/dir/                directory marketplace "fixdir": marker, dep,
#                                ranged, rel (defaultEnabled) and shaext-ext, an
#                                external git-subdir entry with a sha that points
#                                into src-fixture.git (file:///fixture/acme.git).
#   <outdir>/src-fixture.git     bare repo, marketplace "fixture": the same tree
#   <outdir>/src-latest.git      bare repo, marketplace "fixlatest": the same tree
#                                (Both have two commits, main at the second, tag
#                                v1 and tag dep--v1.0.0 on the first. run.sh serves
#                                them read-only as /fixture/acme.git and
#                                /fixture/acme-latest.git, first commit only, and
#                                "pushes" the second commit between runs.)
#   <outdir>/evil/               directory marketplace "evil" with the plugin x
#   <outdir>/extras/             skill-foo (item 11), sneaky (item 14), skill-h and
#                                agent-a.md (item 18), copied into workdirs by run.sh
#   <outdir>/SHAS                shell-sourceable commit SHAs, read by run.sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <outdir>" >&2
  exit 2
fi
command -v git >/dev/null 2>&1 || { echo "missing tool: git" >&2; exit 2; }

mkdir -p "$1"
OUT=$(cd "$1" && pwd -P)
rm -rf "$OUT/dir" "$OUT/evil" "$OUT/extras" "$OUT/work-fixture" "$OUT/work-latest" \
  "$OUT/src-fixture.git" "$OUT/src-latest.git" "$OUT/SHAS"

# Fixed identity and dates make the commit SHAs reproducible.
export GIT_AUTHOR_NAME="G1 fixture" GIT_AUTHOR_EMAIL="g1@example.invalid"
export GIT_COMMITTER_NAME="G1 fixture" GIT_COMMITTER_EMAIL="g1@example.invalid"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
DATE1="2026-01-01T00:00:00Z"
DATE2="2026-01-02T00:00:00Z"

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

# The plugins of the fixture, under <root>/plugins. marker's manifest carries
# <marker-version>, which is how the second commit differs from the first.
write_plugins() { # <root> <marker-version>
  local root=$1 D R M X P
  # dep: an exact dependency of marker.
  D=$root/plugins/dep
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
  R=$root/plugins/ranged
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

  # shaext: the target of the external git-subdir entry with a sha.
  X=$root/plugins/shaext
  mkdir -p "$X/.claude-plugin" "$X/skills/shaext-hello"
  cat > "$X/.claude-plugin/plugin.json" <<'EOF'
{ "name": "shaext", "version": "1.0.0", "description": "G1: external plugin pinned by sha" }
EOF
  cat > "$X/skills/shaext-hello/SKILL.md" <<'EOF'
---
name: shaext-hello
description: G1 external plugin skill. Never needed.
---
Say hello.
EOF

  # rel: a relative plugin that is on by default (R14).
  P=$root/plugins/rel
  mkdir -p "$P/.claude-plugin" "$P/hooks"
  cat > "$P/.claude-plugin/plugin.json" <<'EOF'
{ "name": "rel", "version": "1.0.0", "description": "G1: loads by default", "defaultEnabled": true }
EOF
  cat > "$P/hooks/hooks.json" <<'EOF'
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "sh \"${CLAUDE_PLUGIN_ROOT}/mark.sh\" rel-hook" } ] } ] } }
EOF
  put_mark_sh "$P"

  # marker: every code path writes to $MARK.
  M=$root/plugins/marker
  mkdir -p "$M/.claude-plugin" "$M/hooks" "$M/bin" "$M/monitors"
  put_mark_sh "$M/scripts"
  cat > "$M/.claude-plugin/plugin.json" <<EOF
{
  "name": "marker",
  "version": "$2",
  "description": "G1: every code path writes a marker into \$MARK",
  "dependencies": [ "dep" ]
}
EOF

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
  #    The lockfile is written by hand (lockfile v3, ms 2.1.3) so that building
  #    the fixture needs no npm and no network; it has no integrity hash, which
  #    npm accepts and fills in.
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
  cat > "$M/package-lock.json" <<'EOF'
{
  "name": "g1-marker",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "g1-marker",
      "version": "1.0.0",
      "hasInstallScript": true,
      "dependencies": { "ms": "2.1.3" }
    },
    "node_modules/ms": {
      "version": "2.1.3",
      "resolved": "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz"
    }
  }
}
EOF
}

# The catalog. $3 (optional) is the sha of src-fixture.git's first commit and
# adds the external git-subdir entry (the directory marketplace only).
write_catalog() { # <root> <name> [<ext-sha>]
  local ext=""
  mkdir -p "$1/.claude-plugin"
  if [ -n "${3:-}" ]; then
    ext=$(printf ',\n    { "name": "shaext-ext", "source": { "source": "git-subdir", "url": "file:///fixture/acme.git", "path": "plugins/shaext", "sha": "%s" }, "description": "G1: external source with a sha" }' "$3")
  fi
  cat > "$1/.claude-plugin/marketplace.json" <<EOF
{
  "name": "$2",
  "owner": { "name": "G1" },
  "plugins": [
    { "name": "marker", "source": "./plugins/marker", "description": "G1: every code path writes a marker" },
    { "name": "dep", "source": "./plugins/dep", "description": "G1: exact dependency of marker" },
    { "name": "ranged", "source": "./plugins/ranged", "description": "G1: depends on dep with a version range" },
    { "name": "rel", "source": "./plugins/rel", "description": "G1: relative plugin, defaultEnabled" }$ext
  ]
}
EOF
}

# A bare git repo of the tree: two commits, main at the second, tag v1 and tag
# dep--v1.0.0 (the form Claude Code resolves a dependency range against) on the
# first. Sets <PREFIX>_FIRST and <PREFIX>_SECOND.
build_repo() { # <name> <marketplace> <prefix>
  local w=$OUT/work-$1 first second
  mkdir -p "$w"
  git -C "$w" init -q
  git -C "$w" checkout -q -b main
  write_catalog "$w" "$2"
  write_plugins "$w" 1.0.0
  git_commit "$w" "$DATE1" "g1: $2 first commit"
  first=$(git -C "$w" rev-parse HEAD)
  git -C "$w" tag v1
  git -C "$w" tag dep--v1.0.0
  # The second commit changes marker (new version, new content).
  write_plugins "$w" 1.1.0
  echo "changed in the second commit" > "$w/plugins/marker/CHANGED"
  git_commit "$w" "$DATE2" "g1: $2 marker changes"
  second=$(git -C "$w" rev-parse HEAD)
  git clone -q --bare "$w" "$OUT/src-$1.git"
  git -C "$OUT/src-$1.git" config --remove-section remote.origin
  rm -rf "$w"
  eval "$3_FIRST=$first $3_SECOND=$second"
}

build_repo fixture fixture FIX
build_repo latest fixlatest LAT

# The directory marketplace: the same plugins at the first commit's content,
# plus the external entry whose sha is the fixture repo's first commit.
write_catalog "$OUT/dir" fixdir "$FIX_FIRST"
write_plugins "$OUT/dir" 1.0.0

# A directory marketplace of another name (item 15): plugin x writes a marker
# if it ever loads.
X=$OUT/evil/plugins/x
mkdir -p "$OUT/evil/.claude-plugin" "$X/.claude-plugin" "$X/hooks"
cat > "$OUT/evil/.claude-plugin/marketplace.json" <<'EOF'
{
  "name": "evil",
  "owner": { "name": "G1" },
  "plugins": [ { "name": "x", "source": "./plugins/x", "description": "G1: plugin of an unregistered marketplace" } ]
}
EOF
cat > "$X/.claude-plugin/plugin.json" <<'EOF'
{ "name": "x", "version": "1.0.0", "description": "G1: x@evil, writes a marker if it ever loads" }
EOF
cat > "$X/hooks/hooks.json" <<'EOF'
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "sh \"${CLAUDE_PLUGIN_ROOT}/mark.sh\" x-hook" } ] } ] } }
EOF
put_mark_sh "$X"

# --------------------------------------------------------------------- extras
mkdir -p "$OUT/extras"

# Item 11: the directory is "foo", the frontmatter name is "bar".
mkdir -p "$OUT/extras/skill-foo"
cat > "$OUT/extras/skill-foo/SKILL.md" <<'EOF'
---
name: bar
description: G1 skill-naming probe. The directory is foo and the frontmatter name is bar.
---
Say hello.
EOF

# Item 14: the sneaky skills-directory plugin: a plugin manifest inside a skill
# folder, with a SessionStart hook.
S=$OUT/extras/sneaky
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

# Item 18: a skill whose frontmatter declares hooks.
mkdir -p "$OUT/extras/skill-h"
cat > "$OUT/extras/skill-h/SKILL.md" <<'EOF'
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

# Item 18: a subagent whose frontmatter declares hooks and mcpServers.
cat > "$OUT/extras/agent-a.md" <<'EOF'
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
FIX_FIRST=$FIX_FIRST
FIX_SECOND=$FIX_SECOND
LAT_FIRST=$LAT_FIRST
LAT_SECOND=$LAT_SECOND
EOF

echo "fixture built in $OUT"
echo "  src-fixture.git: $FIX_FIRST (first), $FIX_SECOND (second)"
echo "  src-latest.git:  $LAT_FIRST (first), $LAT_SECOND (second)"
