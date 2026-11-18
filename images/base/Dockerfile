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
