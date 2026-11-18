# S2 Base Image and CI — Technical Design

- **Date:** 2026-11-18
- **Status:** approved by owner-proxy (s2-owner), pending Or's review on the low-confidence items (see §14)
- **Roadmap spec:** `docs/product/roadmap/v0.1/s02-base-image.md`
- **Product sources of truth:** `docs/product/architecture/base-image.md`, `docs/product/decisions/0018-base-image.md`, `docs/product/architecture/workspace.md`, `docs/product/decisions/0009-runtimes-and-workspace.md`, `docs/product/architecture/agent-runtime.md`, `docs/product/roadmap/v0.1/s05-supervisor-docker.md`
- **Decision log:** GitHub issue "S2 Base image: design decisions" (orlevii/open-factory)

> Note: `docs/product/` is ignored by git, so the product docs exist only in local checkouts. Paths above are relative to the repo root.

## 1. Goal

Publish `ghcr.io/orlevii/open-factory/base`, a multi-arch (linux/amd64 + linux/arm64) Ubuntu 24.04 image with the full developer toolchain and Claude Code, running as a non-root `agent` user whose UID/GID is remapped at start to the host user. The image contains **no factory code**: the `open-factory` CLI is bind-mounted by the factory (S5) and the factory MCP is reached over HTTP. Upgrading Claude Code means rebuilding the image; factory updates never do (ADR 0018).

Out of scope: launching agent containers (S5), the `open-factory images build` command and image status UI (later spec), user image builds, image signing/SBOM/provenance (follow-up issue, §13).

## 2. Acceptance criteria

1. A run of `.github/workflows/base-image.yml` on `main` publishes `ghcr.io/orlevii/open-factory/base:latest` as a manifest list with `linux/amd64` and `linux/arm64` (`docker buildx imagetools inspect` shows both).
2. `docker pull ghcr.io/orlevii/open-factory/base:latest` and `docker run --rm -it ghcr.io/orlevii/open-factory/base:latest zsh` work on an Apple Silicon Mac and on an x86 Linux host. The x86 Linux case is covered by CI; the Mac case is checked manually once and noted in the PR.
3. A file created inside the container through a bind mount is owned by the host user, checked **from the host side** with `stat`. CI covers it on both arches for: the runner's own UID/GID, `501:20` (macOS default, GID collides with `dialout`), `1000:1000` (no remap), and `65534:65534` (UID collides with `nobody`).
4. `claude --dangerously-skip-permissions --version` runs as `agent` (non-root) on both arches, both through the entrypoint and through `docker exec -u agent`.
5. `bash -c 'node -v'` works as `agent` through `docker exec -u agent` (the S5 path), proving Node is on `PATH` for non-interactive shells.
6. The digest pushed for each arch is the image that passed the smoke tests (asserted in CI, §7.4). `:latest` only moves after both arches pass.
7. Pull requests touching the image build and smoke-test both arches without pushing anything.

## 3. Files

```
images/base/Dockerfile
images/base/entrypoint.sh          UID/GID remap, ready marker, privilege drop
images/base/README.md              contents, runtime contract, extending, tags
images/base/test/smoke.sh          smoke tests, takes the image ref as $1
.github/workflows/base-image.yml   triggers, lint, version resolve, publish + merge jobs
.github/workflows/base-image-build.yml   reusable (workflow_call): per-arch build, test, optional push
.github/dependabot.yml             github-actions ecosystem, with cooldown
README.md                          one-line link to images/base/README.md
```

`images/base/` is the Docker build context. No `.dockerignore` is needed beyond excluding `test/` and `README.md` (add a two-line `.dockerignore`).

## 4. Image contents (Dockerfile)

Layers are ordered slowest-changing first. `ARG DEBIAN_FRONTEND=noninteractive` is a build ARG only, never `ENV`.

| #   | Layer        | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Base         | `FROM ubuntu:24.04` by tag (not digest), so the weekly no-cache build picks up base fixes                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | apt packages | build-essential, ca-certificates, curl, wget, git, ripgrep, fd-find, jq, unzip, zip, less, vim, htop, openssh-client, gnupg, tmux, locales, tzdata, sudo, zsh, tini, plus what installers need (`xz-utils`, `zstd`). `fd` symlinked to `fdfind` in `/usr/local/bin`. `locale-gen en_US.UTF-8`. `/etc/localtime` is UTC; a runtime `TZ` env var is honored. apt lists removed                                                                                   |
| 3   | gh           | From GitHub's official apt repository (`cli.github.com/packages`) with its keyring; Ubuntu's `gh` is outdated                                                                                                                                                                                                                                                                                                                                                  |
| 4   | yq           | mikefarah's `yq` binary from its GitHub release at pinned `ARG YQ_VERSION`, verified against the release's checksum file, installed to `/usr/local/bin/yq`. (Ubuntu's `yq` package is a different tool.)                                                                                                                                                                                                                                                       |
| 5   | User         | Delete the `ubuntu` user (UID/GID 1000) and its group. Create group `agent` (1000) and user `agent` (1000:1000, home `/home/agent`, shell `/usr/bin/zsh`). Move `agent`'s line to directly after `root` in `/etc/passwd` and `/etc/group` (see §5.3). `/etc/sudoers.d/agent` (mode 0440): `agent ALL=(ALL:ALL) NOPASSWD: ALL`. Create empty `/opt/factory/bin` (mode 0755) and `/run/open-factory`                                                             |
| 6   | oh-my-zsh    | `git clone` of ohmyzsh at pinned `ARG OHMYZSH_COMMIT` into `/home/agent/.oh-my-zsh`, `.zshrc` from its template (default theme). No `curl \| sh`. `chown -R agent:agent /home/agent`                                                                                                                                                                                                                                                                           |
| 7   | Rust         | rustup with `RUSTUP_HOME=/opt/rustup`, `CARGO_HOME=/opt/cargo`, `--default-toolchain stable --profile minimal`, then `rustup component add rustfmt clippy`. No `rust-docs`                                                                                                                                                                                                                                                                                     |
| 8   | Python       | `COPY --from=ghcr.io/astral-sh/uv:${UV_VERSION} /uv /uvx /usr/local/bin/`. `uv python install 3.12 --default` with `UV_PYTHON_INSTALL_DIR=/opt/uv/python` and `UV_PYTHON_BIN_DIR=/opt/uv/bin`, giving `python`, `python3`, `python3.12` in `/opt/uv/bin`. `uv tool install poetry` with `UV_TOOL_DIR=/opt/uv/tools`, `UV_TOOL_BIN_DIR=/opt/uv/bin`. If the pinned uv lacks `--default`, fall back to explicit symlinks in `/opt/uv/bin` (verify, don't assume) |
| 9   | Node         | nvm at pinned `ARG NVM_VERSION` (git tag) into `NVM_DIR=/opt/nvm`; `nvm install 24` (latest 24.x at build time), `nvm alias default 24`; symlink `/opt/nvm/current` → the installed version dir. `COREPACK_HOME=/opt/corepack`; `corepack enable pnpm` and `corepack install -g pnpm@latest` so pnpm is available without a first-use download. pnpm's own settings (e.g. minimum release age) are left at their defaults                                      |
| 10  | Permissions  | `chmod -R a+rwX /opt/rustup /opt/cargo /opt/uv /opt/nvm /opt/corepack` (the official `rust` image does the same), so a remapped `agent` can `rustup component add`, `cargo install`, `npm i -g`, `uv tool install` without `chown`                                                                                                                                                                                                                             |
| 11  | Entrypoint   | `COPY entrypoint.sh /usr/local/bin/open-factory-entrypoint` (0755)                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | Claude Code  | `ARG CLAUDE_CODE_VERSION` (required; build fails if empty). Run the official installer `curl -fsSL https://claude.ai/install.sh \| bash -s "$CLAUDE_CODE_VERSION"` as root with a temporary `HOME`, then `cp -L "$tmp_home/.local/bin/claude" /usr/local/bin/claude` and delete the temporary home. The installer's sha256 check against the release manifest stays in force; no flags that skip it. Last layer, so it rebuilds only when the version changes  |
| 13  | Metadata     | `LABEL org.opencontainers.image.source=https://github.com/orlevii/open-factory`, `org.opencontainers.image.description`, `org.opencontainers.image.licenses`, `io.open-factory.claude-code.version=$CLAUDE_CODE_VERSION`                                                                                                                                                                                                                                       |

Pinned versions (`UV_VERSION`, `NVM_VERSION`, `YQ_VERSION`, `OHMYZSH_COMMIT`) are bumped by hand. When pinning, pick a release at least 7 days old.

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

`/opt/uv/bin` comes before `/usr/bin`, so `python3` is the uv-managed 3.12 for agents. apt tools keep `/usr/bin/python3` through their shebangs. nvm's shell function is not needed for `node`/`npm`/`npx`/`pnpm`/mounted `open-factory`, because `/opt/nvm/current/bin` is on `PATH` via `ENV`.

## 5. Runtime contract and entrypoint

### 5.1 Contract (consumed by S5 and humans)

| Item                   | Contract                                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST_UID`, `HOST_GID` | Passed by the factory. Both or neither. Integers > 0                                                                                                                                                                         |
| PID 1                  | `tini`, reaping zombies from Claude's background shells regardless of launcher flags                                                                                                                                         |
| Default command        | `sleep infinity`: keeps the container alive for `docker exec`                                                                                                                                                                |
| Ready marker           | `/run/open-factory/ready` exists **and** its mtime is ≥ the container's `State.StartedAt` ⇒ the remap for this start finished. S5 waits for it with a timeout and, on timeout or container exit, surfaces the container logs |
| Running Claude         | `docker exec -i -u agent -w <workdir> <container> claude ...`. `-u agent` resolves to the remapped UID via `/etc/passwd`; Docker sets `HOME` from it                                                                         |
| CLI mount              | The `open-factory` CLI bundle is bind-mounted read-only at `/opt/factory/bin/open-factory`; `/opt/factory/bin` is already on `PATH`                                                                                          |
| Humans                 | `docker run --rm -it -e HOST_UID=$(id -u) -e HOST_GID=$(id -g) IMAGE zsh` runs zsh as `agent`                                                                                                                                |
| User images            | Must not end with `USER agent`; the entrypoint needs root to remap and drops privileges itself                                                                                                                               |

### 5.2 Entrypoint algorithm (`entrypoint.sh`, bash, `set -euo pipefail`)

1. If not running as root (someone passed `--user`): print a warning that no remap is done, then `exec "$@"`. No marker is written.
2. `rm -f /run/open-factory/ready` (before anything else, so a failed restart never leaves an old marker).
3. Validate: if both `HOST_UID` and `HOST_GID` are unset, warn on stderr and keep `1000:1000`. If only one is set, or either is not a positive integer, or either is `0`, print a clear error and exit `64`.
4. Group: if `HOST_GID` ≠ agent's primary GID:
   - if a group with `HOST_GID` exists (e.g. `20`/`dialout`), make it agent's primary group (`usermod -g`);
   - otherwise renumber the `agent` group (`groupmod -g`).
5. User: if `HOST_UID` ≠ agent's UID:
   - if a user with `HOST_UID` exists (e.g. `65534`/`nobody`), `usermod -o -u` (non-unique UID);
   - otherwise `usermod -u`.
6. If anything changed in steps 4–5: `chown -R HOST_UID:HOST_GID /home/agent`. Nothing else is chowned (toolchains are world-writable under `/opt`, §4 layer 10). On a restart of the same container the IDs already match, so steps 4–6 are no-ops.
7. Write `/run/open-factory/ready`.
8. `exec setpriv --reuid="$uid" --regid="$gid" --groups="$(id -G agent | tr ' ' ,)" env HOME=/home/agent USER=agent LOGNAME=agent SHELL=/usr/bin/zsh "$@"`.

Any failing command aborts with a non-zero exit before step 7, so no marker is written.

### 5.3 Duplicate-UID edge case

With `usermod -o`, two passwd entries share a UID, and `getpwuid()` returns the first one in `/etc/passwd`. Because the build places `agent` directly after `root` (§4 layer 5), `id -un`, `whoami`, `sudo` and Docker's name resolution all see `agent`. `setpriv` gets explicit numeric IDs and an explicit group list instead of `--init-groups` (which would look the name up by UID).

## 6. Workflow

### 6.1 Triggers and tags (`base-image.yml`)

| Event                                        | Filter                                                | Pushes                     | Tags                     |
| -------------------------------------------- | ----------------------------------------------------- | -------------------------- | ------------------------ |
| `push` to `main`                             | `images/base/**`, `.github/workflows/base-image*.yml` | yes                        | `latest`, `sha-<short>`  |
| `push` of tag `base-v*` (e.g. `base-v0.1.0`) | —                                                     | yes                        | `0.1.0`, `0.1`, `latest` |
| `schedule` (weekly)                          | —                                                     | yes, built with `no-cache` | `latest` only            |
| `workflow_dispatch`                          | —                                                     | yes                        | `latest` only            |
| `pull_request`                               | same paths as `main`                                  | no                         | —                        |

- `sha-<short>` tags are never overwritten: only `main` pushes produce them, and scheduled/dispatch rebuilds of the same commit publish `latest` plus the (pinnable) digest only.
- Image versions (`base-v*`) are independent of the app version: images contain no factory code.
- Tags are computed with `docker/metadata-action`.
- `concurrency: base-image-${{ github.ref }}`, `cancel-in-progress` only for `pull_request` (publish runs are never cancelled midway).
- Cache: `type=gha`, `scope=base-<arch>`, `mode=max`. The scheduled run sets `no-cache: true` (so apt, Node 24.x and rust stable are refreshed) but still writes the cache.

### 6.2 Jobs

1. **lint** (`ubuntu-24.04`, `contents: read`): `shellcheck images/base/entrypoint.sh images/base/test/smoke.sh` (shellcheck is preinstalled on GitHub's Ubuntu runners).
2. **resolve** (`contents: read`): outputs
   - `claude_version`: `curl -fsSL https://downloads.claude.ai/claude-code-releases/latest`, must match `^[0-9]+\.[0-9]+\.[0-9]+$`, otherwise the job fails (no unpinned fallback);
   - `source_date_epoch`: `git log -1 --format=%ct`.
     Both arches use the same resolved Claude version.
3. **build-test** (`pull_request` only): calls `base-image-build.yml` with `push: false`, `permissions: contents: read`.
4. **build-publish** (all other events): calls `base-image-build.yml` with `push: true`, `permissions: contents: read, packages: write`.
5. **merge** (non-PR, needs `build-publish`, `packages: write`): downloads the digest artifacts, runs `docker buildx imagetools create` with the metadata-action tags over `ghcr.io/orlevii/open-factory/base@<amd64-digest>` and `@<arm64-digest>`, then `imagetools inspect` to print the result.

Only jobs that push hold `packages: write`. The reusable workflow keeps the build steps in one place for both PR and publish.

### 6.3 Per-arch build (`base-image-build.yml`)

Matrix: `{ platform: linux/amd64, runner: ubuntu-24.04 }`, `{ platform: linux/arm64, runner: ubuntu-24.04-arm }`. Native builds, no QEMU. Steps:

1. Checkout; `docker/setup-buildx-action`; `docker/login-action` to `ghcr.io` with `GITHUB_TOKEN` (push only).
2. Build #1: `docker/build-push-action` with `load: true`, tag `open-factory-base:test`, build-arg `CLAUDE_CODE_VERSION`, env `SOURCE_DATE_EPOCH`, GHA cache, `provenance: false`, `sbom: false`.
3. `images/base/test/smoke.sh open-factory-base:test "$CLAUDE_CODE_VERSION"`.
4. (push only) Build #2: the same `build-push-action` inputs, on the same builder, with `outputs: type=image,name=ghcr.io/orlevii/open-factory/base,push-by-digest=true,name-canonical=true,push=true`. All layers come from the builder cache.
5. (push only) **Tested == pushed assertion** (§7.4).
6. (push only) Upload the digest as an artifact named `digest-<arch>`.

Actions are pinned to full commit SHAs with a version comment. `.github/dependabot.yml` covers the `github-actions` ecosystem weekly with `cooldown: default-days: 7`.

## 7. Smoke tests (`images/base/test/smoke.sh IMAGE CLAUDE_VERSION`)

Bash, `set -euo pipefail`, prints each check, fails on the first error, cleans up containers and temp dirs on exit.

### 7.1 Tools (as `agent`, via the entrypoint and via `docker exec -u agent`)

`node -v` starts with `v24.`; `npm -v`; `npx -v`; `pnpm -v`; `python3.12 -V`; `python3 -c 'import sys; print(sys.prefix)'` is under `/opt/uv/`; `uv --version`; `poetry --version`; `rustc -V`; `cargo -V`; `rustup -V`; `claude --version` contains `CLAUDE_VERSION`; `gh --version`; `git`, `rg`, `fd`, `jq`, `yq --version` (mentions mikefarah), `zsh`, `tmux`, `setpriv`; `id -u` ≠ 0; `claude --dangerously-skip-permissions --version`.

### 7.2 Runtime contract

- Start detached with the runner's `HOST_UID`/`HOST_GID`, wait (timeout 30 s) for the ready marker, then via `docker exec -u agent`: `bash -c 'node -v'`, `claude --dangerously-skip-permissions --version`, `id -un` = `agent`, `sudo -n true`. `/proc/1/comm` is `tini`.
- Restart: `docker stop` then `docker start` the same container; the marker's mtime is ≥ the new `State.StartedAt`.
- Unset IDs: runs as `1000:1000`, with a warning on stderr.
- Refusals, each with a non-zero exit and a clear message: `HOST_UID=0`, `HOST_GID=0`, only one of the two set, `HOST_UID=abc`.

### 7.3 Bind-mount ownership (host-side `stat`)

For each `uid:gid` in `$(id -u):$(id -g)`, `501:20`, `1000:1000`, `65534:65534`:

1. `mktemp -d`, `chmod 0777` it (so an unrelated UID can write).
2. `docker run --rm -e HOST_UID=uid -e HOST_GID=gid -v "$dir:$dir" IMAGE bash -c 'touch "$0/f"; id -un; sudo -n true' "$dir"`; `id -un` prints `agent`.
3. On the host, `stat -c %u:%g "$dir/f"` equals `uid:gid`.

`65534:65534` covers the duplicate-UID path (`nobody`) and the existing-group path (`nogroup`); `501:20` covers the existing-group path (`dialout`) with a new UID.

### 7.4 Tested == pushed

After build #2, compare the tested image with the pushed manifest. Which field `docker inspect --format '{{.Id}}'` returns depends on the runner's Docker image store: the **config digest** with the classic store, the **manifest digest** with the containerd store. The step detects the store (`docker info --format '{{.DriverStatus}}'` mentions `io.containerd.snapshotter` for the containerd store) and compares against the matching field of `docker buildx imagetools inspect --raw ghcr.io/...@<digest>` (`.config.digest`, or the manifest digest itself). Mismatch fails the job. The implementer confirms the runner's actual store on the first run rather than assuming it.

## 8. Documentation

`images/base/README.md`, short and limited to what is built:

- what is in the image (the §4 table, condensed) and that it contains no factory code;
- the runtime contract (§5.1), with the "do not end with `USER agent`" warning prominent;
- extending: `FROM ghcr.io/orlevii/open-factory/base`, with two short examples (Postgres client via apt, Playwright with its browser deps), each switching to `USER root` for apt;
- tags: `latest`, `sha-<short>`, `X.Y.Z`/`X.Y` from `base-vX.Y.Z` tags; Claude Code version is the `io.open-factory.claude-code.version` label; upgrading Claude = rebuilding.

Root `README.md` gets one line linking to it.

## 9. Manual steps

1. **First publish:** a GHCR package created by a workflow push is private. Or flips `ghcr.io/orlevii/open-factory/base` to public once, in the package settings (no `GITHUB_TOKEN` API for this). Until then, AC2 pulls need `docker login ghcr.io`.
2. Check AC2 on an Apple Silicon Mac once and note the result in the PR.

## 10. Error handling summary

| Situation                                           | Behaviour                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| Claude version lookup fails or is not a version     | `resolve` job fails; nothing is built or pushed                  |
| `CLAUDE_CODE_VERSION` empty                         | Docker build fails                                               |
| Installer checksum mismatch                         | Installer exits non-zero; build fails                            |
| Smoke test fails on either arch                     | That arch never pushes; `merge` does not run; `latest` unchanged |
| Tested ≠ pushed                                     | Job fails; `merge` does not run                                  |
| Bad `HOST_UID`/`HOST_GID` (0, partial, non-numeric) | Entrypoint exits 64 with a message; no ready marker              |
| Remap command fails                                 | Entrypoint exits non-zero; no ready marker                       |
| Container started with `--user`                     | Warning; command runs without remap; no ready marker             |

## 11. Testing

All testing is the smoke script run in CI on both arches against the image built in the same job, plus shellcheck. There is no unit-test harness for the entrypoint; its cases are covered end to end by §7.2–7.3. Locally: `docker build -t open-factory-base:test --build-arg CLAUDE_CODE_VERSION=$(curl -fsSL https://downloads.claude.ai/claude-code-releases/latest) images/base && images/base/test/smoke.sh open-factory-base:test <version>` (Linux host; on macOS Docker Desktop host-side `stat` ownership checks are not meaningful, so §7.3 may be skipped there with `SMOKE_SKIP_OWNERSHIP=1`).

## 12. Product doc drift (not edited by S2; for Or)

The CLI is named `open-factory`, not `of`. These product-doc lines still say `of`:

- `architecture/workspace.md`: "user images (FROM of-base)"; "The `of` CLI bundle is bind-mounted read-only at `/opt/factory/bin/of`". This spec uses `/opt/factory/bin/open-factory`.
- `architecture/base-image.md`: heading/text "of-base"; "the mounted `of`"; "`of images build`".
- `decisions/0018-base-image.md`: "of-base" in the description.
- `roadmap/v0.1/scope.md`: "`of` CLI"; "`of-base` multi-arch image".
- `roadmap/v0.1/s02-base-image.md` and `roadmap/v0.1/index.md`: "of-base".

The image name stays `ghcr.io/orlevii/open-factory/base`; "of-base" only appears as a nickname in prose.

## 13. Follow-up issues (not S2 work)

1. Image provenance, SBOM and signing (cosign/attestations) are off in v0.1.
2. Product doc `of` → `open-factory` drift (§12).
3. S1's `ci.yml` pins actions by tag; align it with the SHA-pinning used here.
4. GHCR untagged digests accumulate from weekly builds; consider a retention policy later.
5. S5 must implement the §5.1 contract (marker mtime vs `StartedAt`, `docker exec -u agent`, CLI mount path).

## 14. Decisions needing Or's call (owner-proxy certainty 3/5)

- Q1 (sub-decision): `agent` has passwordless sudo.
- Q2: default `CMD sleep infinity` plus the `/run/open-factory/ready` marker as the S5 readiness signal.
- Q6: uv-managed Python 3.12 shadows the system `python3` on `PATH`.
- Q7 (sub-decision): `sha-<short>` tags only from `main` pushes and never overwritten; scheduled/dispatch builds push `latest` only.

Full question/option/rationale log: the GitHub issue "S2 Base image: design decisions".
