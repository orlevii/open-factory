# syntax=docker/dockerfile:1
# ghcr.io/orlevii/open-factory/base — see images/base/README.md and
# docs/superpowers/specs/2026-11-18-s2-base-image-design.md

ARG UV_VERSION=0.13.7
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

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

# 10. entrypoint
COPY --chmod=0755 entrypoint.sh /usr/local/bin/open-factory-entrypoint

# (Task 3 adds layers 11–12 here: Claude Code, labels)

USER root
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/open-factory-entrypoint"]
CMD ["sleep", "infinity"]
