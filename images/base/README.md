# Open Factory base image

`ghcr.io/orlevii/open-factory/base` — Ubuntu 24.04 with a full developer toolchain and Claude Code, for linux/amd64 and linux/arm64. It contains **no factory code**: the factory bind-mounts the `open-factory` CLI and reaches its MCP server over HTTP, so factory updates never need a rebuild. Upgrading Claude Code means rebuilding the image.

## Contents

- **System:** build-essential, curl, wget, git, gh, ripgrep, fd, jq, yq (mikefarah), unzip, zip, less, vim, htop, openssh-client, gnupg, tmux, sudo, tini; zsh + oh-my-zsh; `en_US.UTF-8`; UTC (set `TZ` to change)
- **Python:** uv with Python 3.12 as `python`/`python3`, poetry. Install packages with uv (`uv add`, `uv tool install`, `uv pip install` into a venv); `python3 -m pip install` into the managed Python is refused (externally managed; there is no bare `pip`)
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
