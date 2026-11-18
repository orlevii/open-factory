# S2 Base Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish `ghcr.io/orlevii/open-factory/base`, a multi-arch Ubuntu 24.04 image with the full dev toolchain and Claude Code, running as non-root `agent` remapped to `HOST_UID`/`HOST_GID`, with CI that only tags images that passed smoke tests.

**Architecture:** One Dockerfile in `images/base/` (toolchains under world-writable `/opt`, Claude Code as a checksum-verified binary in `/usr/local/bin`), a bash entrypoint behind `tini` that remaps the `agent` user and drops privileges with `setpriv`, and a bash smoke-test script. GitHub Actions builds natively per arch through a reusable workflow, pushes by digest, smoke-tests the pulled digest, and a merge job tags only tested digests.

**Tech Stack:** Docker (BuildKit, Dockerfile heredocs), bash, util-linux `setpriv`, tini, nvm, uv, rustup, corepack, GitHub Actions (`docker/build-push-action`, `docker/metadata-action`, reusable workflows), Dependabot, shellcheck, Biome (markdown formatting).

**Spec:** `docs/superpowers/specs/2026-11-18-s2-base-image-design.md` (read it first; it wins over this plan on any conflict). Decision log: https://github.com/orlevii/open-factory/issues/5. Follow-ups that are NOT S2 work: #6 (provenance/SBOM/signing), #7 (product doc drift), #8 (SHA-pin `ci.yml`), #9 (GHCR retention), #10 (S5 consumes the contract).

## Global Constraints

- Image name: `ghcr.io/orlevii/open-factory/base`. The CLI is `open-factory`, never `of`. Its mount point is `/opt/factory/bin/open-factory`.
- No factory code in the image.
- `FROM ubuntu:24.04` by tag, not digest.
- Hand-pinned versions (each released at least 7 days before pinning; values chosen 2026-11-18, see Task 2 Step 1): `YQ_VERSION=v4.54.3`, `RUSTUP_VERSION=1.29.3`, `UV_VERSION=0.13.7`, `NVM_VERSION=v0.41.0`, `PNPM_VERSION=12.19.0`, `PNPM_SHA512=87327b6619853205834e4be59ba3a231e303d9f5e435912ede3312b7539b79af890942f6513b05a4690745666888045c09b33fc420c2cd2d3bd95c01ba21dbeb`, `OHMYZSH_COMMIT=6010fb6260f359e71d99ba25f05f9215809b3ed2`.
- Floating by policy: apt packages, Node 24.x, Rust stable, Claude Code (resolved per build from `https://downloads.claude.ai/claude-code-releases/latest`).
- `DEBIAN_FRONTEND=noninteractive` is a build `ARG` only, never `ENV`.
- Toolchain `chmod -R a+rwX` happens inside the same `RUN` that installs the toolchain. Never add a separate chmod/chown layer.
- Each install `RUN` deletes its own caches.
- Final `USER root`, `ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/open-factory-entrypoint"]`, `CMD ["sleep", "infinity"]`.
- Entrypoint exit code for every refusal: `64`. Every message is prefixed `open-factory-entrypoint:`.
- Ready marker: `/run/open-factory/ready`.
- Smoke tests never pass Claude credentials into a container. They unset `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`.
- GitHub Actions are pinned to full commit SHAs with a `# vX.Y.Z` comment. Only jobs that push hold `packages: write`.
- `latest` moves only from `main`. `base-v*` tags never move `latest`. `sha-<short>` comes only from `main` pushes.
- Markdown files are formatted with Biome (`pnpm lint:ci` must pass).
- Commit after every task with a conventional message ending in the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Out of scope: S5 launcher code, `open-factory images build`, provenance/SBOM/signing, GHCR retention, editing `docs/product/`, changing `ci.yml`.

## File Structure

```
images/base/Dockerfile                    the image (layers in spec §4 order)
images/base/.dockerignore                 keeps test/ and README.md out of the build context
images/base/entrypoint.sh                 remap agent → HOST_UID/HOST_GID, ready marker, setpriv drop
images/base/test/smoke.sh                 smoke.sh IMAGE_REF CLAUDE_VERSION (spec §7)
images/base/README.md                     contents, runtime contract, extending, tags
.github/workflows/base-image.yml          triggers, lint, resolve, build-test / build-publish, merge
.github/workflows/base-image-build.yml    reusable per-arch build (+ optional push by digest) + smoke
.github/dependabot.yml                    github-actions updates, 7-day cooldown
README.md                                 one line linking images/base/README.md
```

Local development happens on macOS with Docker Desktop (native arm64 builds). There, host-side `stat` ownership checks don't mean anything (and macOS `stat` has a different syntax), so local runs use `SMOKE_SKIP_OWNERSHIP=1`. The ownership checks run in CI on both Linux arches. shellcheck isn't installed locally; run it with `docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:stable <files>`.

---

### Task 1: Entrypoint, smoke script, and the minimal image (base, apt, gh, yq, user)

**Files:**

- Create: `images/base/test/smoke.sh`
- Create: `images/base/entrypoint.sh`
- Create: `images/base/Dockerfile` (layers 1–5 and 10 of spec §4, final settings)
- Create: `images/base/.dockerignore`

**Interfaces:**

- Produces:
  - `smoke.sh IMAGE_REF CLAUDE_VERSION`, with env `SMOKE_SKIP_OWNERSHIP=1` and `SMOKE_SECTIONS` (space-separated subset of `tools contract entrypoint ownership`, default all four). `SMOKE_SECTIONS` exists only so tasks can run the sections the image can already pass. CI never sets it.
  - Entrypoint at `/usr/local/bin/open-factory-entrypoint`.
  - The final ENV/ENTRYPOINT/CMD block, which later tasks don't change.

- [ ] **Step 1: Write the smoke script (the failing test)**

Create `images/base/test/smoke.sh` (mode 0755):

```bash
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
  for c in "${containers[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  for d in "${dirs[@]}"; do rm -rf "$d" 2>/dev/null || true; done
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
  local c="$1" i
  for i in $(seq 1 60); do
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
  out="$(run_agent '
    set -e
    node -v; npm -v; npx -v; pnpm -v
    python3.12 -V
    python3 -c "import sys; print(\"prefix=\" + sys.prefix)"
    uv --version; poetry --version
    rustc -V; cargo -V; rustup -V 2>/dev/null
    claude --version
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
  reject "agent is not refused as root" 'cannot be used with root' "$agent_out"
  want "agent reached the auth check" 'Not logged in' "$agent_out"
  want "root is refused (probe is real)" 'cannot be used with root' "$root_out"

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
```

- [ ] **Step 2: Run it against a stock image to verify it fails**

Run: `chmod +x images/base/test/smoke.sh && SMOKE_SECTIONS=entrypoint SMOKE_SKIP_OWNERSHIP=1 images/base/test/smoke.sh ubuntu:24.04 0.0.0`
Expected: `SMOKE FAIL: default ids: expected /^ids=1000:1000$/ ...` (stock ubuntu runs as root, `ids=0:0`).

- [ ] **Step 3: Write the entrypoint**

Create `images/base/entrypoint.sh`:

```bash
#!/usr/bin/env bash
# open-factory base image entrypoint (spec §5.2):
# remap `agent` to HOST_UID/HOST_GID, write the ready marker, then run the command as agent.
set -euo pipefail

readonly AGENT=agent
readonly AGENT_HOME=/home/agent
readonly READY_DIR=/run/open-factory
readonly READY="$READY_DIR/ready"
readonly MAX_ID=2147483647

log() { echo "open-factory-entrypoint: $*" >&2; }
die() {
  log "$*"
  exit 64
}

# 1. Not root: we cannot remap.
if [ "$(id -u)" -ne 0 ]; then
  if [ -n "${HOST_UID:-}" ] || [ -n "${HOST_GID:-}" ]; then
    die 'must start as root to remap agent to HOST_UID/HOST_GID; do not end your user image with "USER agent"'
  fi
  log "not running as root; skipping the UID/GID remap"
  exec "$@"
fi

# 2. A partial run must never look complete.
mkdir -p "$READY_DIR"
rm -f "$READY"

valid_id() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] && [ "${#1}" -le 10 ] && ((10#$1 <= MAX_ID))
}

# 3–6. Validate and remap.
if [ -z "${HOST_UID:-}" ] && [ -z "${HOST_GID:-}" ]; then
  log "HOST_UID/HOST_GID not set; running as agent with the built-in 1000:1000"
  uid="$(id -u "$AGENT")"
  gid="$(id -g "$AGENT")"
else
  if [ -z "${HOST_UID:-}" ] || [ -z "${HOST_GID:-}" ]; then
    die "set both HOST_UID and HOST_GID, or neither"
  fi
  valid_id "$HOST_UID" || die "HOST_UID must be an integer in 1..$MAX_ID (got '$HOST_UID'); 0 (root) is refused"
  valid_id "$HOST_GID" || die "HOST_GID must be an integer in 1..$MAX_ID (got '$HOST_GID'); 0 (root) is refused"
  uid="$HOST_UID"
  gid="$HOST_GID"
  changed=0

  if [ "$gid" -ne "$(id -g "$AGENT")" ]; then
    if getent group "$gid" >/dev/null; then
      usermod -g "$gid" "$AGENT" # adopt the existing group (e.g. 20/dialout for macOS hosts)
    else
      groupmod -g "$gid" "$AGENT" # also updates agent's primary GID; does not chown
    fi
    changed=1
  fi

  if [ "$uid" -ne "$(id -u "$AGENT")" ]; then
    if getent passwd "$uid" >/dev/null; then
      usermod -o -u "$uid" "$AGENT" # duplicate UID; agent's passwd line is first, so names resolve to agent
    else
      usermod -u "$uid" "$AGENT"
    fi
    changed=1
  fi

  if [ "$changed" -eq 1 ]; then
    chown -R "$uid:$gid" "$AGENT_HOME"
  fi
fi

# 7. Remap done.
touch "$READY"

# 8. Drop privileges. Explicit IDs and group list: --init-groups would look the name up by UID.
groups="$(id -G "$AGENT" | tr ' ' ',')"
exec setpriv --reuid="$uid" --regid="$gid" --groups="$groups" \
  env HOME="$AGENT_HOME" USER="$AGENT" LOGNAME="$AGENT" SHELL=/usr/bin/zsh "$@"
```

- [ ] **Step 4: Write `.dockerignore`**

Create `images/base/.dockerignore`:

```
test/
README.md
```

- [ ] **Step 5: Write the minimal Dockerfile (layers 1–5, 10, final settings)**

Create `images/base/Dockerfile`. Tasks 2 and 3 insert the remaining layers at the marked places.

```dockerfile
# syntax=docker/dockerfile:1
# ghcr.io/orlevii/open-factory/base — see images/base/README.md and
# docs/superpowers/specs/2026-11-18-s2-base-image-design.md

# (Task 2 adds: ARG UV_VERSION + FROM ghcr.io/astral-sh/uv stage here)

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV PATH=/opt/factory/bin:/opt/uv/bin:/opt/nvm/current/bin:/opt/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NVM_DIR=/opt/nvm RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_PYTHON_BIN_DIR=/opt/uv/bin \
    UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/opt/uv/bin \
    COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    DISABLE_AUTOUPDATER=1 LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# 2. apt packages, locale, timezone
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl wget git ripgrep fd-find jq unzip zip less vim htop \
      openssh-client gnupg tmux locales tzdata sudo zsh tini xz-utils \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && locale-gen en_US.UTF-8 \
 && ln -sf /usr/share/zoneinfo/Etc/UTC /etc/localtime && echo Etc/UTC > /etc/timezone \
 && rm -rf /var/lib/apt/lists/*

# 3. gh from GitHub's official apt repository
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# 4. yq (mikefarah), checksum-verified
ARG YQ_VERSION=v4.54.3
RUN <<'EOF'
set -euo pipefail
arch="$(dpkg --print-architecture)"
base="https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}"
tmp="$(mktemp -d)"
cd "$tmp"
curl -fsSL "$base/yq_linux_${arch}" -o "yq_linux_${arch}"
curl -fsSL "$base/checksums" -o checksums
curl -fsSL "$base/checksums_hashes_order" -o checksums_hashes_order
# checksums lines are "<file> <hash1> <hash2> ..."; the hash order is listed one per line.
idx="$(grep -nx 'SHA-256' checksums_hashes_order | cut -d: -f1)"
want="$(awk -v f="yq_linux_${arch}" -v n="$((idx + 1))" '$1 == f { print $n }' checksums)"
[[ "$want" =~ ^[0-9a-f]{64}$ ]] || { echo "no SHA-256 for yq_linux_${arch}" >&2; exit 1; }
echo "${want}  yq_linux_${arch}" | sha256sum -c -
install -m 0755 "yq_linux_${arch}" /usr/local/bin/yq
cd /
rm -rf "$tmp"
EOF

# 5. agent user (1000:1000), first after root in passwd/group (spec §5.3), passwordless sudo
RUN <<'EOF'
set -euo pipefail
userdel --remove ubuntu
if getent group ubuntu >/dev/null; then groupdel ubuntu; fi
groupadd --gid 1000 agent
useradd --uid 1000 --gid 1000 --create-home --home-dir /home/agent --shell /usr/bin/zsh agent
for f in /etc/passwd /etc/group; do
  line="$(grep '^agent:' "$f")"
  { grep '^root:' "$f"; echo "$line"; grep -v -e '^root:' -e '^agent:' "$f"; } > "$f.new"
  cat "$f.new" > "$f"   # keep the original file's mode and owner
  rm "$f.new"
done
[ "$(sed -n 2p /etc/passwd | cut -d: -f1)" = agent ]
echo 'agent ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/agent
chmod 0440 /etc/sudoers.d/agent
visudo -cf /etc/sudoers.d/agent
install -d -m 0755 /opt/factory/bin /run/open-factory
EOF

# (Task 2 adds layers 6–9 here: oh-my-zsh, Rust, Python, Node)

# 10. entrypoint
COPY --chmod=0755 entrypoint.sh /usr/local/bin/open-factory-entrypoint

# (Task 3 adds layers 11–12 here: Claude Code, labels)

USER root
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/open-factory-entrypoint"]
CMD ["sleep", "infinity"]
```

- [ ] **Step 6: Build and run the entrypoint section**

Run:

```bash
docker build -t open-factory-base:dev images/base
SMOKE_SECTIONS=entrypoint SMOKE_SKIP_OWNERSHIP=1 images/base/test/smoke.sh open-factory-base:dev 0.0.0
```

Expected: every refusal prints `refused (...)`, then `== all smoke checks passed`.

- [ ] **Step 7: Manual remap checks (Mac host IDs 501:20 are themselves the GID-collision case)**

Run:

```bash
docker run --rm -e HOST_UID=501 -e HOST_GID=20 open-factory-base:dev bash -c 'id; stat -c %u:%g ~; sudo -n true && echo sudo-ok'
docker run --rm -e HOST_UID=65534 -e HOST_GID=65534 open-factory-base:dev bash -c 'id -un; whoami; stat -c %u:%g ~'
docker run --rm open-factory-base:dev bash -c 'gh --version | head -1; yq --version; fd --version; locale | head -1; date +%Z'
```

Expected:

- `uid=501(agent) gid=20(dialout) groups=20(dialout),...`, `501:20`, `sudo-ok`.
- `agent`, `agent`, `65534:65534`.
- A gh version line, `yq (https://github.com/mikefarah/yq/) version v4.54.3`, an fd version, `LANG=en_US.UTF-8`, `UTC`.

- [ ] **Step 8: shellcheck**

Run: `docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:stable images/base/entrypoint.sh images/base/test/smoke.sh`
Expected: no output, exit 0. Fix any finding; don't add `# shellcheck disable` unless the finding is a false positive, and if so, explain why in the comment.

- [ ] **Step 9: Commit**

```bash
git add images/base
git commit -m "feat(image): base image entrypoint, smoke tests and minimal Dockerfile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Toolchains (oh-my-zsh, Rust, Python, Node)

**Files:**

- Modify: `images/base/Dockerfile` (add the uv stage at the top and layers 6–9 at the Task 2 marker)

**Interfaces:**

- Consumes: the Task 1 Dockerfile, its ENV block, and `smoke.sh`.
- Produces:
  - `/opt/rustup`, `/opt/cargo`, `/opt/uv/{python,tools,bin}`, `/opt/nvm` (with `/opt/nvm/current`) and `/opt/corepack`, all world-writable;
  - `python`, `python3`, `python3.12` and `poetry` in `/opt/uv/bin`;
  - `node`, `npm`, `npx`, `corepack` and `pnpm` in `/opt/nvm/current/bin`.

- [ ] **Step 1: Re-verify the pins (at least 7 days old) and their hashes**

Run:

```bash
for r in astral-sh/uv nvm-sh/nvm mikefarah/yq; do gh api "repos/$r/releases?per_page=6" --jq '.[] | .tag_name + " " + .published_at'; done
gh api repos/rust-lang/rustup/commits/1.29.3 --jq .commit.committer.date
gh api repos/ohmyzsh/ohmyzsh/commits/6010fb6260f359e71d99ba25f05f9215809b3ed2 --jq .commit.committer.date
npm view pnpm time --json | grep '"12.19.0"'
npm view pnpm@12.19.0 dist.integrity | sed 's/^sha512-//' | base64 -d | xxd -p -c 256
```

Expected:

- uv 0.13.7 (2026-11-03), nvm v0.41.0 (2026-11-04), yq v4.54.3 (2026-11-09), rustup 1.29.3 (2026-11-02), ohmyzsh commit 2026-11-09, pnpm 12.19.0 (2026-11-10).
- The last command prints exactly the `PNPM_SHA512` hex from Global Constraints.

If you're implementing on a later date, the pins are still valid (they only get older). Don't bump them in this task.

- [ ] **Step 2: Add the uv stage at the top of the Dockerfile**

Replace the line `# (Task 2 adds: ARG UV_VERSION + FROM ghcr.io/astral-sh/uv stage here)` with:

```dockerfile
ARG UV_VERSION=0.13.7
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv
```

(`COPY --from` can't expand a build arg in an image reference, so the pinned uv image is a named stage.)

- [ ] **Step 3: Add layers 6–9**

Replace the line `# (Task 2 adds layers 6–9 here: oh-my-zsh, Rust, Python, Node)` with:

```dockerfile
# 6. oh-my-zsh at a pinned commit (fetch by SHA: a shallow clone can't check out an older commit)
ARG OHMYZSH_COMMIT=6010fb6260f359e71d99ba25f05f9215809b3ed2
RUN <<'EOF'
set -euo pipefail
git init -q /home/agent/.oh-my-zsh
cd /home/agent/.oh-my-zsh
git remote add origin https://github.com/ohmyzsh/ohmyzsh.git
git fetch -q --depth 1 origin "$OHMYZSH_COMMIT"
git checkout -q FETCH_HEAD
cp templates/zshrc.zsh-template /home/agent/.zshrc
# No self-update from inside agent containers; the image is rebuilt instead.
sed -i "s/^# zstyle ':omz:update' mode disabled/zstyle ':omz:update' mode disabled/" /home/agent/.zshrc
grep -q "^zstyle ':omz:update' mode disabled" /home/agent/.zshrc
cat >> /home/agent/.zshrc <<'ZSHRC'

# nvm command for interactive shells (node itself is on PATH via the image ENV)
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
ZSHRC
chown -R agent:agent /home/agent
EOF

# 7. Rust: rustup-init verified by sha256, minimal profile + rustfmt + clippy
ARG RUSTUP_VERSION=1.29.3
RUN <<'EOF'
set -euo pipefail
case "$(uname -m)" in
  x86_64) target=x86_64-unknown-linux-gnu ;;
  aarch64) target=aarch64-unknown-linux-gnu ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac
base="https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${target}"
tmp="$(mktemp -d)"
cd "$tmp"
# The .sha256 file reads "<hash> *./rustup-init", so the binary must be ./rustup-init in the cwd.
curl -fsSL "$base/rustup-init" -o rustup-init
curl -fsSL "$base/rustup-init.sha256" -o rustup-init.sha256
sha256sum -c rustup-init.sha256
chmod +x rustup-init
./rustup-init -y --no-modify-path --profile minimal --default-toolchain stable
rustup component add rustfmt clippy
cd /
rm -rf "$tmp" "$RUSTUP_HOME/downloads" "$RUSTUP_HOME/tmp"
chmod -R a+rwX "$RUSTUP_HOME" "$CARGO_HOME"
EOF

# 8. Python: uv-managed 3.12 as python/python3/python3.12, poetry via uv tool
COPY --from=uv /uv /uvx /usr/local/bin/
RUN <<'EOF'
set -euo pipefail
uv python install 3.12 --default
uv tool install poetry
uv cache clean
rm -rf /root/.cache/uv
for b in python python3 python3.12 poetry; do test -x "/opt/uv/bin/$b"; done
chmod -R a+rwX /opt/uv
EOF

# 9. Node: nvm + Node 24 (latest 24.x), /opt/nvm/current, pnpm pinned via corepack with sha512
ARG NVM_VERSION=v0.41.0
ARG PNPM_VERSION=12.19.0
ARG PNPM_SHA512=87327b6619853205834e4be59ba3a231e303d9f5e435912ede3312b7539b79af890942f6513b05a4690745666888045c09b33fc420c2cd2d3bd95c01ba21dbeb
RUN <<'EOF'
set -euo pipefail
git clone -q --depth 1 --branch "$NVM_VERSION" https://github.com/nvm-sh/nvm.git "$NVM_DIR"
# nvm.sh may return non-zero when no default exists yet; check for the function instead.
. "$NVM_DIR/nvm.sh" || true
command -v nvm >/dev/null
nvm install 24
nvm alias default 24
ln -s "$(dirname "$(dirname "$(nvm which default)")")" "$NVM_DIR/current"
corepack enable pnpm
corepack install -g "pnpm@${PNPM_VERSION}+sha512.${PNPM_SHA512}"
nvm cache clear
npm cache clean --force
rm -rf /root/.npm /root/.cache
chmod -R a+rwX "$NVM_DIR" "$COREPACK_HOME"
EOF
```

- [ ] **Step 4: Build and check the toolchains as a remapped agent**

Run:

```bash
docker build -t open-factory-base:dev images/base
docker run --rm -e HOST_UID=501 -e HOST_GID=20 open-factory-base:dev bash -c '
  set -e
  node -v; npm -v; npx -v; pnpm -v
  python3.12 -V; python3 -c "import sys; print(sys.prefix)"; poetry --version; uv --version
  rustc -V; cargo -V; rustup -V 2>/dev/null; cargo fmt --version; cargo clippy --version
  pip install requests 2>&1 | grep -q externally-managed && echo pip-refused
  npm i -g cowsay >/dev/null && command -v cowsay
  uv tool install ruff >/dev/null 2>&1 && command -v ruff
  ls -ld /opt/nvm/current
'
docker run --rm -e HOST_UID=501 -e HOST_GID=20 open-factory-base:dev zsh -ic 'nvm --version; echo $ZSH'
docker image ls open-factory-base:dev
```

Expected:

- `v24.x`, pnpm `12.19.0`, `Python 3.12.x`, a prefix under `/opt/uv/python/`, rustfmt and clippy versions, `pip-refused`, and paths for cowsay (under `/opt/nvm/versions/node/...`) and ruff (`/opt/uv/bin/ruff`). This proves the world-writable `/opt` works for a remapped UID.
- The `zsh -i` command prints the nvm version (`0.41.0`) and `/home/agent/.oh-my-zsh`.
- Note the image size in the PR description. A separate permissions layer would show up as about +1 GB; there must not be one.

- [ ] **Step 5: Verify that the pnpm hash is enforced**

Run: `docker build --build-arg PNPM_SHA512=$(printf '0%.0s' {1..128}) -t open-factory-base:badhash images/base`
Expected: the build FAILS in layer 9 with a corepack hash/integrity mismatch error. If it succeeds, STOP and report it: the spec's pnpm pinning assumption (§4 layer 9) is wrong and needs an owner decision. Delete any `badhash` image afterwards.

- [ ] **Step 6: Commit**

```bash
git add images/base/Dockerfile
git commit -m "feat(image): add oh-my-zsh, Rust, uv Python and Node toolchains

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Claude Code layer, labels, full local smoke

**Files:**

- Modify: `images/base/Dockerfile` (layers 11–12 at the Task 3 marker)

**Interfaces:**

- Consumes: the Task 2 image and `smoke.sh`.
- Produces:
  - the required build-arg `CLAUDE_CODE_VERSION`;
  - `/usr/local/bin/claude`;
  - the label `io.open-factory.claude-code.version`.

- [ ] **Step 1: Run the full smoke against the current image to see it fail**

Run: `v=$(curl -fsSL https://downloads.claude.ai/claude-code-releases/latest); SMOKE_SKIP_OWNERSHIP=1 images/base/test/smoke.sh open-factory-base:dev "$v"`
Expected: `SMOKE FAIL`, because `claude` isn't found in the tools section.

- [ ] **Step 2: Add layers 11–12**

Replace the line `# (Task 3 adds layers 11–12 here: Claude Code, labels)` with:

```dockerfile
# 11. Claude Code: exact pinned binary, verified against the release manifest's sha256
ARG CLAUDE_CODE_VERSION
RUN <<'EOF'
set -euo pipefail
if [[ ! "${CLAUDE_CODE_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "build-arg CLAUDE_CODE_VERSION is required (e.g. 2.1.327), got '${CLAUDE_CODE_VERSION:-}'" >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) platform=linux-x64 ;;
  aarch64) platform=linux-arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac
base="https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}"
checksum="$(curl -fsSL "$base/manifest.json" | jq -r --arg p "$platform" '.platforms[$p].checksum // empty')"
if [[ ! "$checksum" =~ ^[0-9a-f]{64}$ ]]; then
  echo "no valid checksum for $platform in $base/manifest.json" >&2
  exit 1
fi
tmp="$(mktemp -d)"
curl -fsSL "$base/$platform/claude" -o "$tmp/claude"
echo "${checksum}  $tmp/claude" | sha256sum -c -
install -m 0755 "$tmp/claude" /usr/local/bin/claude
rm -rf "$tmp"
EOF

# 12. metadata
LABEL org.opencontainers.image.source="https://github.com/orlevii/open-factory" \
      org.opencontainers.image.description="Open Factory agent base image: Ubuntu 24.04, developer toolchain and Claude Code" \
      org.opencontainers.image.licenses="MIT" \
      io.open-factory.claude-code.version="${CLAUDE_CODE_VERSION}"
```

- [ ] **Step 3: Check that the build fails without the build-arg**

Run: `docker build -t open-factory-base:noarg images/base`
Expected: FAILS with `build-arg CLAUDE_CODE_VERSION is required`.

- [ ] **Step 4: Build with the resolved version and run the full smoke**

Run:

```bash
v=$(curl -fsSL https://downloads.claude.ai/claude-code-releases/latest)
docker build -t open-factory-base:dev --build-arg CLAUDE_CODE_VERSION="$v" images/base
SMOKE_SKIP_OWNERSHIP=1 images/base/test/smoke.sh open-factory-base:dev "$v"
docker inspect -f '{{ index .Config.Labels "io.open-factory.claude-code.version" }}' open-factory-base:dev
docker run --rm open-factory-base:dev claude doctor 2>&1 | head -20 || true
```

Expected:

- smoke ends with `== all smoke checks passed`. The non-root proof shows `Not logged in` for agent and `cannot be used with root` for root.
- The label equals `$v`.
- `claude doctor` reports a native install at `/usr/local/bin/claude` with auto-updates disabled by env. That last check is informational; record it in the PR.

- [ ] **Step 5: Commit**

```bash
git add images/base/Dockerfile
git commit -m "feat(image): install pinned Claude Code binary with manifest checksum

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Workflows and Dependabot

**Files:**

- Create: `.github/workflows/base-image.yml`
- Create: `.github/workflows/base-image-build.yml`
- Create: `.github/dependabot.yml`

**Interfaces:**

- Consumes:
  - `images/base/test/smoke.sh IMAGE_REF CLAUDE_VERSION`;
  - the Dockerfile build-arg `CLAUDE_CODE_VERSION`.
- Produces:
  - the reusable workflow `./.github/workflows/base-image-build.yml`, with inputs `push` (bool), `claude_version` (string), `write_cache` (bool) and `no_cache` (bool);
  - artifacts `digest-amd64` and `digest-arm64`, each holding one empty file named by the hex digest.

- [ ] **Step 1: Resolve the action SHAs (each release at least 7 days old)**

Run:

```bash
for a in actions/checkout docker/setup-buildx-action docker/login-action docker/build-push-action docker/metadata-action actions/upload-artifact actions/download-artifact; do
  t=$(gh api "repos/$a/releases?per_page=10" --jq "[.[] | select(.prerelease==false and .published_at < \"$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)\")][0].tag_name")
  echo "$a $t $(gh api repos/$a/commits/$t --jq .sha)"
done
```

Expected (as of 2026-11-18; use the SHAs your run prints if they differ, and keep the version comment in sync):

```
actions/checkout v7.0.1 3d3c42e5aac5ba805825da76410c181273ba90b1
docker/setup-buildx-action v4.4.1 f87e5991a6d7451dcb8d9637bfbc97413f497069
docker/login-action v4.8.0 8aa5831fb8d48d8f76594c7ddde61ae58019f550
docker/build-push-action v7.4.0 c3c9e263c25d99ce0380d002d59b67737d91b0dc
docker/metadata-action v6.2.0 dc802804100637a589fabce1cb79ff13a1411302
actions/upload-artifact v7.0.2 cf430e030ddbb5b0abf93d22962f4752f3646cd9
actions/download-artifact v8.0.2 9000827ccba6bdab643e8b6fd33ac0654aef8333
```

For each pinned action, read its README for the input names used below (`load`, `outputs`, `no-cache`, `cache-from`, `cache-to`, `provenance`, `sbom`, `flavor`, `pattern`, `merge-multiple`). If a major version renamed an input, adapt the YAML; don't change the behavior.

- [ ] **Step 2: Write the reusable per-arch workflow**

Create `.github/workflows/base-image-build.yml`:

```yaml
name: Base image build

# Reusable: one native build per arch. Test mode loads the image locally; push mode pushes
# by digest (untagged), pulls that digest back for the smoke test, and only then uploads the
# digest for the merge job. Nothing untested is ever tagged (spec §6.3).
on:
  workflow_call:
    inputs:
      push:
        type: boolean
        required: true
      claude_version:
        type: string
        required: true
      write_cache:
        type: boolean
        required: true
      no_cache:
        type: boolean
        required: true

permissions:
  contents: read

env:
  IMAGE: ghcr.io/orlevii/open-factory/base

jobs:
  build:
    name: build (${{ matrix.arch }})
    strategy:
      fail-fast: false
      matrix:
        include:
          - arch: amd64
            platform: linux/amd64
            runner: ubuntu-24.04
          - arch: arm64
            platform: linux/arm64
            runner: ubuntu-24.04-arm
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1

      - name: Log in to GHCR
        if: ${{ inputs.push }}
        uses: docker/login-action@8aa5831fb8d48d8f76594c7ddde61ae58019f550 # v4.8.0
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ github.token }}

      - name: Build (test mode, load locally)
        if: ${{ !inputs.push }}
        uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: images/base
          platforms: ${{ matrix.platform }}
          build-args: CLAUDE_CODE_VERSION=${{ inputs.claude_version }}
          load: true
          tags: open-factory-base:test
          provenance: false
          sbom: false
          no-cache: ${{ inputs.no_cache }}
          cache-from: type=gha,scope=base-${{ matrix.arch }}
          cache-to: ${{ inputs.write_cache && format('type=gha,scope=base-{0},mode=max', matrix.arch) || '' }}

      - name: Build and push by digest
        id: push
        if: ${{ inputs.push }}
        uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: images/base
          platforms: ${{ matrix.platform }}
          build-args: CLAUDE_CODE_VERSION=${{ inputs.claude_version }}
          outputs: type=image,name=${{ env.IMAGE }},push-by-digest=true,name-canonical=true,push=true
          provenance: false
          sbom: false
          no-cache: ${{ inputs.no_cache }}
          cache-from: type=gha,scope=base-${{ matrix.arch }}
          cache-to: ${{ inputs.write_cache && format('type=gha,scope=base-{0},mode=max', matrix.arch) || '' }}

      - name: Smoke test
        env:
          PUSH: ${{ inputs.push }}
          DIGEST: ${{ steps.push.outputs.digest }}
          CLAUDE_VERSION: ${{ inputs.claude_version }}
        run: |
          if [ "$PUSH" = true ]; then
            [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::bad digest '$DIGEST'"; exit 1; }
            ref="${IMAGE}@${DIGEST}"
          else
            ref=open-factory-base:test
          fi
          images/base/test/smoke.sh "$ref" "$CLAUDE_VERSION"

      - name: Export digest
        if: ${{ inputs.push }}
        env:
          DIGEST: ${{ steps.push.outputs.digest }}
        run: |
          mkdir -p "$RUNNER_TEMP/digests"
          touch "$RUNNER_TEMP/digests/${DIGEST#sha256:}"

      - name: Upload digest
        if: ${{ inputs.push }}
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: digest-${{ matrix.arch }}
          path: ${{ runner.temp }}/digests/*
          if-no-files-found: error
          retention-days: 1
```

- [ ] **Step 3: Write the entry workflow**

Create `.github/workflows/base-image.yml`:

```yaml
name: Base image

on:
  push:
    branches: [main]
    paths:
      - images/base/**
      - .github/workflows/base-image.yml
      - .github/workflows/base-image-build.yml
    # Only semver image tags; a non-matching base-v* tag never starts a publish with no tags.
    # (Path filters are not evaluated for tag pushes.)
    tags:
      - "base-v[0-9]+.[0-9]+.[0-9]+"
  pull_request:
    paths:
      - images/base/**
      - .github/workflows/base-image.yml
      - .github/workflows/base-image-build.yml
  schedule:
    # Weekly no-cache rebuild: new Claude Code, apt, Node 24.x and Rust stable.
    - cron: "17 4 * * 1"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: base-image-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

# Publish condition (spec §6.1):
#   github.event_name != 'pull_request' &&
#   (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/base-v'))
jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: shellcheck
        run: shellcheck images/base/entrypoint.sh images/base/test/smoke.sh

  resolve:
    runs-on: ubuntu-24.04
    outputs:
      claude_version: ${{ steps.claude.outputs.version }}
    steps:
      - name: Resolve latest Claude Code version
        id: claude
        run: |
          v="$(curl -fsSL https://downloads.claude.ai/claude-code-releases/latest)"
          if [[ ! "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            echo "::error::unexpected Claude Code version response: '$v'"
            exit 1
          fi
          echo "Claude Code $v"
          echo "version=$v" >> "$GITHUB_OUTPUT"

  build-test:
    if: ${{ !(github.event_name != 'pull_request' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/base-v'))) }}
    needs: [lint, resolve]
    permissions:
      contents: read
    uses: ./.github/workflows/base-image-build.yml
    with:
      push: false
      claude_version: ${{ needs.resolve.outputs.claude_version }}
      write_cache: false
      no_cache: false

  build-publish:
    if: ${{ github.event_name != 'pull_request' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/base-v')) }}
    needs: [lint, resolve]
    permissions:
      contents: read
      packages: write
    uses: ./.github/workflows/base-image-build.yml
    with:
      push: true
      claude_version: ${{ needs.resolve.outputs.claude_version }}
      write_cache: ${{ github.ref == 'refs/heads/main' }}
      no_cache: ${{ github.event_name == 'schedule' }}

  merge:
    if: ${{ github.event_name != 'pull_request' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/base-v')) }}
    needs: [build-publish]
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      packages: write
    env:
      IMAGE: ghcr.io/orlevii/open-factory/base
    steps:
      - name: Download tested digests
        uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          path: ${{ runner.temp }}/digests
          pattern: digest-*
          merge-multiple: true

      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1

      - uses: docker/login-action@8aa5831fb8d48d8f76594c7ddde61ae58019f550 # v4.8.0
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ github.token }}

      - name: Compute tags
        id: meta
        uses: docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302 # v6.2.0
        with:
          images: ${{ env.IMAGE }}
          flavor: latest=false
          tags: |
            type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main' }}
            type=sha,prefix=sha-,format=short,enable=${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}
            type=match,pattern=base-v(\d+\.\d+\.\d+),group=1
            type=match,pattern=base-v(\d+\.\d+)\.\d+,group=1

      - name: Create and push the manifest list
        working-directory: ${{ runner.temp }}/digests
        run: |
          [ "$(ls | wc -l)" -eq 2 ] || { echo "::error::expected 2 tested digests, got: $(ls)"; exit 1; }
          tags="$(jq -cr '.tags | map("-t " + .) | join(" ")' <<< "$DOCKER_METADATA_OUTPUT_JSON")"
          [ -n "$tags" ] || { echo "::error::no tags computed for $GITHUB_REF"; exit 1; }
          # shellcheck disable=SC2046,SC2086 # word splitting is intended for the tag and digest lists
          docker buildx imagetools create $tags $(printf "${IMAGE}@sha256:%s " *)

      - name: Inspect
        env:
          FIRST_TAG: ${{ fromJSON(steps.meta.outputs.json).tags[0] }}
        run: docker buildx imagetools inspect "$FIRST_TAG"
```

- [ ] **Step 4: Write Dependabot config**

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 7
```

- [ ] **Step 5: Lint the workflows**

Run: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color .github/workflows/base-image.yml .github/workflows/base-image-build.yml`
Expected: no errors. actionlint also runs shellcheck on the `run:` blocks. Fix real findings. If actionlint can't resolve the pinned SHAs offline, warnings about that are acceptable. Then run `pnpm lint:ci` (it must still pass; Biome ignores YAML it doesn't support).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/base-image.yml .github/workflows/base-image-build.yml .github/dependabot.yml
git commit -m "ci: multi-arch base image workflow with digest-tested publishing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Image README and root README link

**Files:**

- Create: `images/base/README.md`
- Modify: `README.md` (one line)

**Interfaces:**

- Consumes: the contract from Tasks 1–4. Document only what is built.

- [ ] **Step 1: Write `images/base/README.md`**

````markdown
# Open Factory base image

`ghcr.io/orlevii/open-factory/base` — Ubuntu 24.04 with a full developer toolchain and Claude Code, for linux/amd64 and linux/arm64. It contains **no factory code**: the factory bind-mounts the `open-factory` CLI and reaches its MCP server over HTTP, so factory updates never need a rebuild. Upgrading Claude Code means rebuilding the image.

## Contents

- **System:** build-essential, curl, wget, git, gh, ripgrep, fd, jq, yq (mikefarah), unzip, zip, less, vim, htop, openssh-client, gnupg, tmux, sudo, tini; zsh + oh-my-zsh; `en_US.UTF-8`; UTC (set `TZ` to change)
- **Python:** uv with Python 3.12 as `python`/`python3`, poetry. Install packages with uv (`uv add`, `uv tool install`, `uv pip install` into a venv); `pip install` into the managed Python is refused (externally managed)
- **Node:** nvm + Node 24 (`/opt/nvm/current/bin` on `PATH`, so non-interactive shells find `node`), pnpm via corepack
- **Rust:** rustup stable (minimal profile + rustfmt, clippy)
- **Claude Code:** `/usr/local/bin/claude`, auto-updater disabled. The version is the `io.open-factory.claude-code.version` label
- **User:** non-root `agent` (zsh). Toolchains live in world-writable `/opt` dirs, so `agent` can `npm i -g`, `cargo install`, `uv tool install` and `rustup component add`. `agent` has passwordless `sudo` for apt

## Runtime contract

> **Do not end a user image with `USER agent`.** The entrypoint must start as root to remap `agent`; it drops privileges itself. With `HOST_UID`/`HOST_GID` set and a non-root start, the container exits with code 64.

| Item                   | Contract                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HOST_UID`, `HOST_GID` | Both or neither, integers ≥ 1. `agent` is remapped to them at start, so files written through bind mounts are owned by the host user. Unset: runs as `1000:1000` with a warning. `0`, partial or invalid values: exit 64 |
| PID 1                  | `tini`                                                                                                                                                                                                                   |
| Default command        | `sleep infinity` (keeps the container alive for `docker exec`)                                                                                                                                                           |
| Ready marker           | `/run/open-factory/ready` appears once the remap for this start has finished. Launchers mount a tmpfs at `/run/open-factory` so a stop clears it                                                                         |
| Running commands       | `docker exec -u agent -w <dir> <container> <cmd>`. A plain `docker exec` without `-u` runs as **root**                                                                                                                   |
| CLI mount              | The factory mounts the CLI read-only at `/opt/factory/bin/open-factory` (already on `PATH`)                                                                                                                              |

Interactive use:

```
docker run --rm -it -e HOST_UID=$(id -u) -e HOST_GID=$(id -g) ghcr.io/orlevii/open-factory/base:latest zsh
```

## Extending

The image's `USER` is root, so `apt-get` works directly. Leave `USER` as root at the end.

```dockerfile
FROM ghcr.io/orlevii/open-factory/base:latest
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*
```

```dockerfile
FROM ghcr.io/orlevii/open-factory/base:latest
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npx -y playwright install --with-deps chromium && chmod -R a+rwX /opt/playwright
```

## Tags

- `latest`: the newest build of `main` that passed the smoke tests on both arches (also rebuilt weekly)
- `sha-<short>`: the build of that `main` commit; never overwritten
- `X.Y.Z`, `X.Y`: from `base-vX.Y.Z` git tags (these never move `latest`)

Every tag is a manifest list for linux/amd64 and linux/arm64. Pin a digest for full reproducibility.

## Development

```
v=$(curl -fsSL https://downloads.claude.ai/claude-code-releases/latest)
docker build -t open-factory-base:test --build-arg CLAUDE_CODE_VERSION=$v images/base
images/base/test/smoke.sh open-factory-base:test $v   # on macOS add SMOKE_SKIP_OWNERSHIP=1
```

Hand-pinned versions (`YQ_VERSION`, `RUSTUP_VERSION`, `UV_VERSION`, `NVM_VERSION`, `PNPM_VERSION` + `PNPM_SHA512`, `OHMYZSH_COMMIT`) are `ARG`s in the Dockerfile. When bumping, pick a release at least 7 days old; `PNPM_SHA512` is the hex form of `npm view pnpm@<version> dist.integrity`.
````

- [ ] **Step 2: Verify the Playwright example once**

Run: `printf 'FROM open-factory-base:dev\nENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright\nRUN npx -y playwright install --with-deps chromium && chmod -R a+rwX /opt/playwright\n' | docker build -t of-pw-check -`
Expected: the build succeeds. If it doesn't, fix the README example (don't add Playwright to the base image), then `docker rmi of-pw-check`.

- [ ] **Step 3: Link from the root README**

In `README.md`, directly after the line `Self-hosted workspace where people and agents build software together. Design: [S1 foundation spec](docs/superpowers/specs/2026-11-18-s1-foundation-design.md).`, add a blank line and:

```markdown
Agent containers use the [base image](images/base/README.md) (`ghcr.io/orlevii/open-factory/base`).
```

- [ ] **Step 4: Format and lint**

Run: `pnpm exec biome format --write images/base/README.md README.md && pnpm lint:ci`
Expected: `biome ci` passes.

- [ ] **Step 5: Commit**

```bash
git add images/base/README.md README.md
git commit -m "docs: base image README and root link

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: CI verification on the PR, and the manual checklist

**Files:** none (this task produces verification evidence, recorded in the PR description).

- [ ] **Step 1: Push and open the PR**

```bash
git push
gh pr create --base spec/s1-foundation --head spec/s2-base-image --title "S2: Base image and CI" --body "Implements docs/superpowers/specs/2026-11-18-s2-base-image-design.md. Decision log #5."
```

(Stacked on S1's PR #4. The PR body must end with the attribution line from the current session's instructions.)

- [ ] **Step 2: Watch the PR run**

Run: `gh run watch "$(gh run list --workflow base-image.yml --branch spec/s2-base-image --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status`
Expected:

- `lint`, `resolve` and `build-test / build (amd64)` / `build (arm64)` are green;
- `build-publish` and `merge` are skipped;
- in each arch log, the four ownership cases pass on the Linux host and the non-root proof prints both messages.

If a check fails, debug it with superpowers:systematic-debugging, fix it, push, and watch again. Paste the smoke summary lines for both arches into the PR description.

- [ ] **Step 3: Verify a dispatch run on a non-main ref doesn't publish**

Run: `gh workflow run base-image.yml --ref spec/s2-base-image`, then watch it as in Step 2.
Expected: `build-test` runs, and `build-publish` and `merge` are skipped.

- [ ] **Step 4: Spec self-check before asking for review**

Go through spec §2 AC1–AC7 and, in the PR description, write down for each one: "verified by <CI step / local command>", or "post-merge manual (see checklist)".

- [ ] **Step 5: Manual checklist (post-merge to `main`; record the results in the PR or as a comment)**

- [ ] The `Base image` workflow on `main` is green, including `merge`. `docker buildx imagetools inspect ghcr.io/orlevii/open-factory/base:latest` lists `linux/amd64` and `linux/arm64` (AC1).
- [ ] **Or:** set the GHCR package `ghcr.io/orlevii/open-factory/base` to **public** in its package settings (one-time, spec §9.1).
- [ ] An anonymous `docker pull ghcr.io/orlevii/open-factory/base:latest` works after logging out of ghcr.io.
- [ ] On an Apple Silicon Mac: `docker run --rm -it -e HOST_UID=$(id -u) -e HOST_GID=$(id -g) -v "$PWD:$PWD" -w "$PWD" ghcr.io/orlevii/open-factory/base:latest zsh`, then `touch from-container && exit`, and `ls -l from-container` on the host shows your user (AC2). Delete the file afterwards.
- [ ] On an x86 Linux host: the same pull and run (AC2; CI already covers it).
- [ ] `sha-<short>` and `latest` tags exist for the merge commit.
