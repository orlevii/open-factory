# S2 Base Image and CI — Technical Design

- **Date:** 2026-11-18
- **Status:** approved by owner-proxy (s2-owner), reviewed by an independent reviewer (findings applied), pending Or's review on the low-confidence items (see §14)
- **Roadmap spec:** `docs/product/roadmap/v0.1/s02-base-image.md`
- **Product sources of truth:** `docs/product/architecture/base-image.md`, `docs/product/decisions/0018-base-image.md`, `docs/product/architecture/workspace.md`, `docs/product/decisions/0009-runtimes-and-workspace.md`, `docs/product/architecture/agent-runtime.md`, `docs/product/roadmap/v0.1/s05-supervisor-docker.md`
- **Decision log:** GitHub issue #5 "S2 Base image: design decisions" (orlevii/open-factory)

> Note: `docs/product/` is ignored by git, so the product docs exist only in local checkouts. Paths above are relative to the repo root.

## 1. Goal

Publish `ghcr.io/orlevii/open-factory/base`, a multi-arch (linux/amd64 + linux/arm64) Ubuntu 24.04 image with the full developer toolchain and Claude Code, running as a non-root `agent` user whose UID/GID is remapped at start to the host user. The image contains **no factory code**: the `open-factory` CLI is bind-mounted by the factory (S5) and the factory MCP is reached over HTTP. Upgrading Claude Code means rebuilding the image; factory updates never do (ADR 0018).

Out of scope: launching agent containers (S5), the `open-factory images build` command and image status UI (later spec), user image builds, image signing/SBOM/provenance (follow-up issue, §13).

## 2. Acceptance criteria

1. A run of `.github/workflows/base-image.yml` on `main` publishes `ghcr.io/orlevii/open-factory/base:latest` as a manifest list with `linux/amd64` and `linux/arm64` (`docker buildx imagetools inspect` shows both).
2. `docker pull ghcr.io/orlevii/open-factory/base:latest` and `docker run --rm -it ghcr.io/orlevii/open-factory/base:latest zsh` work on an Apple Silicon Mac and on an x86 Linux host. The x86 Linux case is covered by CI; the Mac case is checked manually once and noted in the PR.
3. A file created inside the container through a bind mount is owned by the host user, checked **from the host side** with `stat`. CI covers it on both arches for: the runner's own UID/GID, `501:20` (macOS default, GID collides with `dialout`), `1000:1000` (no remap), and `65534:65534` (UID collides with `nobody`).
4. Claude runs as non-root `agent` on both arches, through the entrypoint and through `docker exec -u agent`: `id -u` ≠ 0, `claude --dangerously-skip-permissions --version` works, and `claude --dangerously-skip-permissions -p x` does **not** print Claude's root refusal, while the same command run as root **does** (§7.2). This replaces the roadmap's `--version`-only check, which passes even as root (§12).
5. `bash -c 'node -v'` works as `agent` through `docker exec -u agent` (the S5 path), proving Node is on `PATH` for non-interactive shells.
6. Only digests that passed the smoke tests are ever tagged: each arch smoke-tests the exact digest it pushed, pulled back by `@sha256` (§6.3). `:latest` only moves after both arches pass, and only from `main`.
7. Pull requests touching the image build and smoke-test both arches without pushing anything.

## 3. Files

```
images/base/Dockerfile
images/base/.dockerignore          excludes test/ and README.md from the build context
images/base/entrypoint.sh          UID/GID remap, ready marker, privilege drop
images/base/README.md              contents, runtime contract, extending, tags
images/base/test/smoke.sh          smoke tests: smoke.sh IMAGE_REF CLAUDE_VERSION
.github/workflows/base-image.yml   triggers, lint, version resolve, build/publish + merge jobs
.github/workflows/base-image-build.yml   reusable (workflow_call): per-arch build, optional push, test
.github/dependabot.yml             github-actions ecosystem, with cooldown
README.md                          one-line link to images/base/README.md
```

`images/base/` is the Docker build context.

## 4. Image contents (Dockerfile)

Layers are ordered slowest-changing first. `ARG DEBIAN_FRONTEND=noninteractive` is a build ARG only, never `ENV`. The Dockerfile sets `SHELL ["/bin/bash", "-o", "pipefail", "-c"]`.

**Permission rule:** toolchain dirs under `/opt` must be world-writable (`a+rwX`) so a remapped `agent` can `rustup component add`, `cargo install`, `npm i -g`, `uv tool install` without `chown` (the official `rust` image does the same). The `chmod` runs **inside the same `RUN` that installs** each toolchain (never as a separate layer, which would copy every file again: measured +400 MB for uv+Node alone). Each install `RUN` also deletes its own caches (uv cache, npm cache, rustup downloads/tmp, apt lists).

| #   | Layer        | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Base         | `FROM ubuntu:24.04` by tag (not digest), so the weekly no-cache build picks up base fixes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2   | apt packages | build-essential, ca-certificates, curl, wget, git, ripgrep, fd-find, jq, unzip, zip, less, vim, htop, openssh-client, gnupg, tmux, locales, tzdata, sudo, zsh, tini, xz-utils. `fd` symlinked to `fdfind` in `/usr/local/bin`. `locale-gen en_US.UTF-8`. `/etc/localtime` is UTC; a runtime `TZ` env var is honored                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 3   | gh           | From GitHub's official apt repository (`cli.github.com/packages`) with its keyring; Ubuntu's `gh` is outdated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 4   | yq           | mikefarah's `yq` binary from its GitHub release at pinned `ARG YQ_VERSION`, verified against the release's checksum file, installed to `/usr/local/bin/yq`. (Ubuntu's `yq` package is a different tool.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 5   | User         | Delete the `ubuntu` user (UID/GID 1000) and its group. Create group `agent` (1000) and user `agent` (1000:1000, home `/home/agent`, shell `/usr/bin/zsh`). Move `agent`'s line to directly after `root` in `/etc/passwd` and `/etc/group` (see §5.3). `/etc/sudoers.d/agent` (mode 0440): `agent ALL=(ALL:ALL) NOPASSWD: ALL`. Create empty `/opt/factory/bin` (mode 0755) and `/run/open-factory`                                                                                                                                                                                                                                                                                                                                                           |
| 6   | oh-my-zsh    | ohmyzsh fetched at pinned `ARG OHMYZSH_COMMIT` into `/home/agent/.oh-my-zsh` via `git init`, `git remote add origin https://github.com/ohmyzsh/ohmyzsh.git`, `git fetch --depth 1 origin "$OHMYZSH_COMMIT"`, `git checkout FETCH_HEAD` (a plain shallow clone cannot check out an older commit); `.zshrc` from its template (default theme), plus a line sourcing `$NVM_DIR/nvm.sh` so the `nvm` command works in interactive zsh. No `curl \| sh`. `chown -R agent:agent /home/agent`                                                                                                                                                                                                                                                                       |
| 7   | Rust         | `rustup-init` downloaded for the arch (`x86_64-unknown-linux-gnu` / `aarch64-unknown-linux-gnu`) at pinned `ARG RUSTUP_VERSION` and verified against `https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/<target>/rustup-init.sha256` (its content is `<hash> *./rustup-init`, so the binary is saved as `./rustup-init` in the cwd before `sha256sum -c`, or the hash field is compared explicitly); run with `RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo -y --no-modify-path --profile minimal --default-toolchain stable`, then `rustup component add rustfmt clippy`. No `rust-docs`                                                                                                                                                       |
| 8   | Python       | `COPY --from=ghcr.io/astral-sh/uv:${UV_VERSION} /uv /uvx /usr/local/bin/`. `uv python install 3.12 --default` with `UV_PYTHON_INSTALL_DIR=/opt/uv/python` and `UV_PYTHON_BIN_DIR=/opt/uv/bin`, giving `python`, `python3`, `python3.12` in `/opt/uv/bin` (verified on uv 0.13.9). `uv tool install poetry` with `UV_TOOL_DIR=/opt/uv/tools`, `UV_TOOL_BIN_DIR=/opt/uv/bin`. uv's Python is marked EXTERNALLY-MANAGED, so `pip install` into it fails; agents use uv (README says so)                                                                                                                                                                                                                                                                         |
| 9   | Node         | nvm at pinned `ARG NVM_VERSION`, `git clone --depth 1 --branch "$NVM_VERSION"` into `NVM_DIR=/opt/nvm`. The `RUN` sources `$NVM_DIR/nvm.sh`, then `nvm install 24` (latest 24.x at build time), `nvm alias default 24`, and an explicit `ln -s` of `/opt/nvm/current` → the installed version dir (nvm does not create it). `COREPACK_HOME=/opt/corepack`; `corepack enable pnpm`; `corepack install -g "pnpm@${PNPM_VERSION}+sha512.${PNPM_SHA512}"` from pinned `ARG PNPM_VERSION` and `ARG PNPM_SHA512` (the same descriptor form as `packageManager`; the hash is the npm registry `dist.integrity` of that version). The implementer confirms during implementation that a wrong hash makes the build fail; `COREPACK_INTEGRITY_KEYS` is not overridden |
| 10  | Entrypoint   | `COPY entrypoint.sh /usr/local/bin/open-factory-entrypoint` (0755)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 11  | Claude Code  | `ARG CLAUDE_CODE_VERSION` (required; build fails if empty). Platform is `linux-x64` or `linux-arm64` from `uname -m`. Fetch `https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/manifest.json`, read `.platforms["<platform>"].checksum` with `jq` (fail if empty or not 64 hex chars), download `.../${CLAUDE_CODE_VERSION}/<platform>/claude`, verify with `sha256sum -c`, `install -m0755` to `/usr/local/bin/claude`. These are the official installer's own source and checksum, applied to the exact pinned binary; no bootstrap binary, no temporary `HOME`. Last layer, so it rebuilds only when the version changes                                                                                                            |
| 12  | Metadata     | `LABEL org.opencontainers.image.source=https://github.com/orlevii/open-factory`, `org.opencontainers.image.description`, `org.opencontainers.image.licenses`, `io.open-factory.claude-code.version=$CLAUDE_CODE_VERSION`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Pinned versions (`UV_VERSION`, `NVM_VERSION`, `YQ_VERSION`, `RUSTUP_VERSION`, `PNPM_VERSION` + `PNPM_SHA512`, `OHMYZSH_COMMIT`) are bumped by hand. When pinning, pick a release at least 7 days old. Floating by policy: apt packages, Node 24.x, Rust stable, Claude Code (resolved per build, §6.2).

Final settings:

```
USER root
ENV PATH=/opt/factory/bin:/opt/uv/bin:/opt/nvm/current/bin:/opt/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NVM_DIR=/opt/nvm RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_PYTHON_BIN_DIR=/opt/uv/bin \
    UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/opt/uv/bin \
    COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    DISABLE_AUTOUPDATER=1 LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/open-factory-entrypoint"]
CMD ["sleep", "infinity"]
```

`/opt/uv/bin` comes before `/usr/bin`, so `python3` is the uv-managed 3.12 for agents. apt tools keep `/usr/bin/python3` through their shebangs. `node`/`npm`/`npx`/`pnpm`/the mounted `open-factory` need no nvm shell function, because `/opt/nvm/current/bin` is on `PATH` via `ENV`.

## 5. Runtime contract and entrypoint

### 5.1 Contract (consumed by S5 and humans)

| Item                   | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST_UID`, `HOST_GID` | Passed by the factory. Both or neither. Integers in `1..2147483647`                                                                                                                                                                                                                                                                                                                                                                                            |
| PID 1                  | `tini`, reaping zombies from Claude's background shells regardless of launcher flags                                                                                                                                                                                                                                                                                                                                                                           |
| Default command        | `sleep infinity`: keeps the container alive for `docker exec`                                                                                                                                                                                                                                                                                                                                                                                                  |
| Ready marker           | S5 creates the container with a tmpfs at `/run/open-factory` (`HostConfig.Tmpfs`), so a stop clears it. `/run/open-factory/ready` existing ⇒ the remap for this start finished. S5 waits for it with a timeout and, on timeout or container exit, surfaces the container logs. (Plain `docker run` without the tmpfs: the entrypoint still deletes the marker first, but a stale one can be visible for a few ms after a restart; only S5's contract matters.) |
| Running Claude         | `docker exec -i -u agent -w <workdir> <container> claude ...`. `-u agent` resolves to the remapped UID via `/etc/passwd`; Docker sets `HOME` from it. A plain `docker exec` without `-u` runs as **root** (the image's `USER` is root)                                                                                                                                                                                                                         |
| CLI mount              | The `open-factory` CLI bundle is bind-mounted read-only at `/opt/factory/bin/open-factory`; `/opt/factory/bin` is already on `PATH`                                                                                                                                                                                                                                                                                                                            |
| Humans                 | `docker run --rm -it -e HOST_UID=$(id -u) -e HOST_GID=$(id -g) IMAGE zsh` runs zsh as `agent`                                                                                                                                                                                                                                                                                                                                                                  |
| User images            | Must not end with `USER agent`; the entrypoint needs root to remap and drops privileges itself                                                                                                                                                                                                                                                                                                                                                                 |

### 5.2 Entrypoint algorithm (`entrypoint.sh`, bash, `set -euo pipefail`)

1. If not running as root:
   - if `HOST_UID` or `HOST_GID` is set: print `open-factory-entrypoint: must start as root to remap agent to HOST_UID/HOST_GID; do not end your user image with "USER agent"` and exit `64`;
   - otherwise warn that no remap is done and `exec "$@"`. No marker is written.
2. `mkdir -p /run/open-factory && rm -f /run/open-factory/ready`.
3. Validate: if both `HOST_UID` and `HOST_GID` are unset, warn on stderr and keep `1000:1000`. If only one is set, or either does not match `^[1-9][0-9]*$`, or either exceeds `2147483647`, print a clear error and exit `64`. (This rejects `0`, i.e. root.)
4. Group: if `HOST_GID` ≠ agent's primary GID:
   - if a group with `HOST_GID` exists (e.g. `20`/`dialout`), make it agent's primary group (`usermod -g`);
   - otherwise renumber the `agent` group (`groupmod -g`; this updates agent's primary GID in `/etc/passwd` but does not chown files).
5. User: if `HOST_UID` ≠ agent's UID:
   - if a user with `HOST_UID` exists (e.g. `65534`/`nobody`), `usermod -o -u` (non-unique UID);
   - otherwise `usermod -u`.
     `usermod` keeps the passwd line order, so `agent` stays right after `root`.
6. If anything changed in steps 4–5: `chown -R HOST_UID:HOST_GID /home/agent` (required: `groupmod` does not chown). Nothing else is chowned (toolchains are world-writable under `/opt`). On a restart of the same container the IDs already match, so steps 4–6 are no-ops.
7. `touch /run/open-factory/ready`.
8. `exec setpriv --reuid="$uid" --regid="$gid" --groups="$(id -G agent | tr ' ' ,)" env HOME=/home/agent USER=agent LOGNAME=agent SHELL=/usr/bin/zsh "$@"`. (`setpriv --regid` requires one of the group options; `--init-groups` is not used, §5.3.)

Any failing command aborts with a non-zero exit before step 7, so no marker is written.

### 5.3 Duplicate-UID edge case

With `usermod -o`, two passwd entries share a UID, and `getpwuid()` returns the first one in `/etc/passwd`. Because the build places `agent` directly after `root` (§4 layer 5), `id -un`, `whoami`, `sudo` and Docker's name resolution all see `agent` (verified: without the move, `whoami` prints `nobody`). `setpriv` gets explicit numeric IDs and an explicit group list instead of `--init-groups` (which would look the name up by UID).

## 6. Workflow

### 6.1 Triggers and tags (`base-image.yml`)

| Event                                                                    | Filter                                                | Pushes                     | Tags                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------- | -------------------------- | --------------------------------- |
| `push` to `main`                                                         | `images/base/**`, `.github/workflows/base-image*.yml` | yes                        | `latest`, `sha-<short>`           |
| `push` of tag matching `base-v[0-9]+.[0-9]+.[0-9]+` (e.g. `base-v0.1.0`) | —                                                     | yes                        | `0.1.0`, `0.1` (**not** `latest`) |
| `schedule` (weekly; runs on `main`)                                      | —                                                     | yes, built with `no-cache` | `latest`                          |
| `workflow_dispatch` on `main`                                            | —                                                     | yes                        | `latest`                          |
| `workflow_dispatch` on another ref                                       | —                                                     | no (build + test only)     | —                                 |
| `pull_request`                                                           | same paths as `main` push                             | no (build + test only)     | —                                 |

- `latest` means "newest tested build of `main`". Only `main` moves it; a `base-v*` tag on an older commit never moves it backwards.
- `sha-<short>` tags are never overwritten: only `main` pushes produce them; scheduled/dispatch rebuilds of the same commit publish `latest` plus the (pinnable) digest only.
- Image versions (`base-v*`) are independent of the app version: images contain no factory code.
- Tags are computed with `docker/metadata-action`, `flavor: latest=false`, and these rules:
  - `type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main' }}`
  - `type=sha,prefix=sha-,format=short,enable=${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}`
  - `type=match,pattern=base-v(\d+\.\d+\.\d+),group=1`
  - `type=match,pattern=base-v(\d+\.\d+)\.\d+,group=1`
- `concurrency: base-image-${{ github.ref }}`, `cancel-in-progress` only for `pull_request` (publish runs are never cancelled midway).
- Cache: `type=gha`, `scope=base-<arch>`, `mode=max`. All runs read it; only runs on `main` (push, schedule, dispatch) write it. The scheduled run sets `no-cache: true` (so apt, Node 24.x and Rust stable are refreshed) and still writes the cache.

The tag trigger uses the filter `tags: ['base-v[0-9]+.[0-9]+.[0-9]+']`, so a non-semver `base-v*` tag never starts a publish that would produce no tags. In the workflow, `if:` expressions are written inside `${{ }}` (an expression starting with `!` must not be a bare YAML scalar).

**Publish condition** (used below): `github.event_name != 'pull_request' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/base-v'))`.

### 6.2 Jobs

1. **lint** (`ubuntu-24.04`, `contents: read`): `shellcheck images/base/entrypoint.sh images/base/test/smoke.sh` (shellcheck is preinstalled on the x64 runner).
2. **resolve** (`contents: read`): output `claude_version` = `curl -fsSL https://downloads.claude.ai/claude-code-releases/latest`, which must match `^[0-9]+\.[0-9]+\.[0-9]+$`, otherwise the job fails (no unpinned fallback). Both arches use this one version.
3. **build-test** (`if:` not the publish condition; needs lint, resolve): calls `base-image-build.yml` with `push: false`; `permissions: contents: read`.
4. **build-publish** (`if:` the publish condition; needs lint, resolve): calls `base-image-build.yml` with `push: true`; `permissions: contents: read, packages: write`.
5. **merge** (`if:` the publish condition; needs build-publish; `packages: write`): downloads the `digest-*` artifacts, runs `docker buildx imagetools create` with the metadata-action tags over `ghcr.io/orlevii/open-factory/base@<amd64-digest>` and `@<arm64-digest>`, then `imagetools inspect` to print the result.

Only jobs that push hold `packages: write`. The reusable workflow keeps the build steps in one place for both modes.

### 6.3 Per-arch build (`base-image-build.yml`)

Matrix: `{ arch: amd64, platform: linux/amd64, runner: ubuntu-24.04 }`, `{ arch: arm64, platform: linux/arm64, runner: ubuntu-24.04-arm }`. Native builds, no QEMU. One build per arch. Steps:

1. Checkout; `docker/setup-buildx-action`; (push mode) `docker/login-action` to `ghcr.io` with `GITHUB_TOKEN`.
2. `docker/build-push-action`, context `images/base`, build-arg `CLAUDE_CODE_VERSION`, GHA cache per §6.1, `provenance: false`, `sbom: false`, and:
   - **test mode:** `load: true`, tag `open-factory-base:test`; image ref = `open-factory-base:test`.
   - **push mode:** `outputs: type=image,name=ghcr.io/orlevii/open-factory/base,push-by-digest=true,name-canonical=true,push=true`; image ref = `ghcr.io/orlevii/open-factory/base@<digest from the step output>`.
3. `images/base/test/smoke.sh "<image ref>" "$CLAUDE_CODE_VERSION"`. In push mode, smoke.sh's first action is `docker pull` of the `@sha256` ref, so the test runs on exactly the pushed bytes.
4. (push mode, only if step 3 passed) Upload the digest as artifact `digest-<arch>`.

A failed smoke test leaves an untagged digest in GHCR; it is never tagged and no cleanup is added for it.

Actions are pinned to full commit SHAs with a version comment. `.github/dependabot.yml` covers the `github-actions` ecosystem weekly with `cooldown: default-days: 7`.

## 7. Smoke tests (`images/base/test/smoke.sh IMAGE_REF CLAUDE_VERSION`)

Bash, `set -euo pipefail`. Pulls `IMAGE_REF` if it contains `@sha256:`. Prints each check, fails on the first error, cleans up containers and temp dirs on exit. Every `docker run`/`docker exec` runs with no Claude credentials: the script `unset`s `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` and never passes them into containers, so CI never reaches a live model.

### 7.1 Tools (as `agent`, via the entrypoint)

`node -v` starts with `v24.`; `npm -v`; `npx -v`; `pnpm -v`; `python3.12 -V`; `python3 -c 'import sys; print(sys.prefix)'` is under `/opt/uv/`; `uv --version`; `poetry --version`; `rustc -V`; `cargo -V`; `rustup -V`; `claude --version` contains `CLAUDE_VERSION`; `gh --version`; `git`, `rg`, `fd`, `jq`, `yq --version` (mentions mikefarah), `zsh`, `tmux`, `setpriv`; `id -u` ≠ 0.

### 7.2 Runtime contract

- Start detached with the runner's `HOST_UID`/`HOST_GID` and `--tmpfs /run/open-factory`; wait (timeout 30 s) for the ready marker. Then via `docker exec -u agent`: `bash -c 'node -v'`, `id -u` ≠ 0, `id -un` = `agent`, `sudo -n true`, `claude --dangerously-skip-permissions --version`. `/proc/1/comm` is `tini`.
- **Non-root proof:** via `docker exec -u agent`, `claude --dangerously-skip-permissions -p x 2>&1` output does **not** contain `cannot be used with root` **and does** contain `Not logged in` (so a crash or empty output cannot pass); via `docker exec -u 0`, the same command's output **does** contain it. Matched on text, not exit code (without credentials both exit non-zero).
- Restart: `docker stop` then `docker start` the same container (with the tmpfs); record the marker's mtime before the stop; after `docker start` the marker is present again within the timeout with a newer mtime (the tmpfs was cleared and the entrypoint recreated it).
- Unset IDs: runs as `1000:1000`, with a warning on stderr.
- Refusals, each exiting `64` with a clear message: `HOST_UID=0`, `HOST_GID=0`, only one of the two set, `HOST_UID=abc`, `HOST_UID=99999999999`, and `--user 1000:1000` with `HOST_UID`/`HOST_GID` set.

### 7.3 Bind-mount ownership (host-side `stat`)

For each `uid:gid` in `$(id -u):$(id -g)`, `501:20`, `1000:1000`, `65534:65534`:

1. `mktemp -d`, `chmod 0777` it (so an unrelated UID can write).
2. `docker run --rm -e HOST_UID=uid -e HOST_GID=gid -v "$dir:$dir" IMAGE bash -c 'touch "$0/f"; id -un; sudo -n true' "$dir"`; `id -un` prints `agent`.
3. On the host, `stat -c %u:%g "$dir/f"` equals `uid:gid`.

`65534:65534` covers the duplicate-UID path (`nobody`) and the existing-group path (`nogroup`); `501:20` covers the existing-group path (`dialout`) with a new UID.

## 8. Documentation

`images/base/README.md`, short and limited to what is built:

- what is in the image (the §4 table, condensed) and that it contains no factory code; Python packages via uv (`pip install` into the managed Python is refused);
- the runtime contract (§5.1), with the "do not end with `USER agent`" warning prominent;
- extending: `FROM ghcr.io/orlevii/open-factory/base`, with two short examples (Postgres client via apt, Playwright with its browser deps); the image's `USER` is already root, so apt works directly;
- tags: `latest` (newest tested `main` build), `sha-<short>`, `X.Y.Z`/`X.Y` from `base-vX.Y.Z` tags; the Claude Code version is the `io.open-factory.claude-code.version` label; upgrading Claude = rebuilding.

Root `README.md` gets one line linking to it.

## 9. Manual steps

1. **First publish:** a GHCR package created by a workflow push is private. Or flips `ghcr.io/orlevii/open-factory/base` to public once, in the package settings (no `GITHUB_TOKEN` API for this). Until then, AC2 pulls need `docker login ghcr.io`.
2. Check AC2 on an Apple Silicon Mac once and note the result in the PR.

## 10. Error handling summary

| Situation                                                                        | Behaviour                                                                         |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Claude version lookup fails or is not a version                                  | `resolve` job fails; nothing is built or pushed                                   |
| `CLAUDE_CODE_VERSION` empty, manifest missing the platform, or checksum mismatch | Docker build fails                                                                |
| Smoke test fails on either arch                                                  | That digest is never uploaded or tagged; `merge` does not run; `latest` unchanged |
| Bad `HOST_UID`/`HOST_GID` (0, partial, non-numeric, too large)                   | Entrypoint exits 64 with a message; no ready marker                               |
| `HOST_UID`/`HOST_GID` set but container not started as root                      | Entrypoint exits 64 telling the user not to end the image with `USER agent`       |
| Remap command fails                                                              | Entrypoint exits non-zero; no ready marker                                        |
| Started with `--user` and no IDs                                                 | Warning; command runs without remap; no ready marker                              |

## 11. Testing

All testing is the smoke script run in CI on both arches, plus shellcheck. There is no unit-test harness for the entrypoint; its cases are covered end to end by §7.2–7.3. Locally: `v=$(curl -fsSL https://downloads.claude.ai/claude-code-releases/latest) && docker build -t open-factory-base:test --build-arg CLAUDE_CODE_VERSION=$v images/base && images/base/test/smoke.sh open-factory-base:test $v` (Linux host; on macOS Docker Desktop host-side `stat` ownership checks are not meaningful, so §7.3 is skipped with `SMOKE_SKIP_OWNERSHIP=1`).

## 12. Product doc drift (not edited by S2; for Or)

The CLI is named `open-factory`, not `of`. These product-doc lines still say `of`:

- `architecture/workspace.md`: "user images (FROM of-base)"; "The `of` CLI bundle is bind-mounted read-only at `/opt/factory/bin/of`". This spec uses `/opt/factory/bin/open-factory`.
- `architecture/base-image.md`: heading/text "of-base"; "the mounted `of`"; "`of images build`".
- `decisions/0018-base-image.md`: "of-base" in the description.
- `roadmap/v0.1/scope.md`: "`of` CLI"; "`of-base` multi-arch image".
- `roadmap/v0.1/s02-base-image.md` and `roadmap/v0.1/index.md`: "of-base".

The image name stays `ghcr.io/orlevii/open-factory/base`; "of-base" only appears as a nickname in prose.

Other roadmap drift: `s02-base-image.md`'s AC "`claude --dangerously-skip-permissions --version` runs, which proves the user isn't root" is false (it succeeds as root too); this spec's AC4 replaces it. The roadmap also says the merge job tags "the version and `latest`"; here version tags do not move `latest` (§6.1).

## 13. Follow-up issues (not S2 work)

1. Image provenance, SBOM and signing (cosign/attestations) are off in v0.1; also verify the Claude release manifest's signature if Anthropic publishes one. (#6)
2. Product doc and roadmap drift (§12). (#7)
3. S1's `ci.yml` pins actions by tag; align it with the SHA-pinning used here. (#8)
4. GHCR untagged digests accumulate from weekly builds and failed smoke runs; consider a retention policy later. (#9)
5. S5 must implement the §5.1 contract (tmpfs at `/run/open-factory`, wait for the marker with a timeout, `docker exec -u agent`, CLI mount path). (#10)

## 14. Decisions needing Or's call (owner-proxy certainty 3/5)

- Q1 (sub-decision): `agent` has passwordless sudo.
- Q2: default `CMD sleep infinity` plus the `/run/open-factory/ready` marker as the S5 readiness signal (refined in Q17 to a tmpfs-backed marker).
- Q6: uv-managed Python 3.12 shadows the system `python3` on `PATH`.
- Q7 (sub-decision): `sha-<short>` tags only from `main` pushes and never overwritten; scheduled/dispatch builds push `latest` only.

Full question/option/rationale log: GitHub issue #5.
