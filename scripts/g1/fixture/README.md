# Gate G1 fixture

`scripts/g1/run.sh` needs no GitHub account and no repo of yours. `make-fixture.sh`
builds a local fixture from git alone, and `run.sh` mounts it read-only into the
throwaway containers (spec section 13, "Setup"). Items 4 to 9 use two public
marketplaces instead: `anthropics/claude-plugins-official` and
`obra/superpowers-marketplace`. The host reads their history with plain git (a
blobless bare clone, no credential) to pick an OLD commit (30 to 60 behind HEAD,
still listing the plugin) and the NEW one (HEAD). Nothing is pushed anywhere and
nothing is installed on your machine.

```sh
scripts/g1/fixture/make-fixture.sh <outdir>   # run.sh does this itself
```

## What it builds

| Path | What it is |
|---|---|
| `dir/` | The directory marketplace `fixdir`: `marker`, `dep`, `ranged` and `rel` (`defaultEnabled: true`). Mounted as `/fixture/dir`. |
| `src-fixture.git` | A bare git repo of the same tree, as the marketplace `fixture`. Two commits (the second changes `marker`, 1.0.0 to 1.1.0), `main` at the second, tag `v1` and tag `dep--v1.0.0` on the first. Only item 0 uses it, mounted as `/fixture/acme.git`: Claude Code 2.1.331 refuses a `file://` git marketplace, and item 0 records that. |
| `evil/` | A directory marketplace `evil` with the plugin `x` (item 15). |
| `extras/` | `skill-foo` (item 11), `sneaky` (item 14), `skill-h` and `agent-a.md` (item 18). Copied into workdirs by `run.sh`. |
| `SHAS` | The deterministic commit SHAs of `src-fixture.git`. |

`marker` has every code path write a file into `$MARK`: a SessionStart hook, an
MCP server (which also writes `${CLAUDE_PLUGIN_DATA}/x`), `bin/x`, a monitors
entry, and `preinstall`/`postinstall` scripts in `package.json`. A file in
`$MARK` means plugin code ran. Only `npm-preinstall` and `npm-postinstall` count
as install-time code; the marks a session writes are expected.

The npm dependency is **`ms` 2.1.3**: exact-pinned, tiny (one file, no
dependencies of its own) and one of the best-known packages on the registry. The
`package-lock.json` is written by hand (lockfile v3, no integrity hash, which npm
fills in), so building the fixture needs no npm and no network.

## What the public-marketplace items need

Items 4 to 9 declare the remote marketplaces with `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1`
(without it a remote marketplace's plugins are not in the first `init`). Upstream
cannot be pushed to, so item 5 pins OLD and shows it stays although upstream is
ahead, item 6 repins OLD to NEW, and item 7 switches a pin at OLD to Latest. Item 7
does not test an upstream push during a Latest agent's life, nor a Latest plugin's
autoUpdate across a version bump.

## Running it

```sh
export CLAUDE_CODE_OAUTH_TOKEN=...      # for the items that start a session
scripts/g1/run.sh                       # image open-factory-base:<pin>
scripts/g1/run.sh open-factory-base:dev # or the tag you built
```

Prerequisites: Docker running, the image present locally with Claude Code
exactly as `images/base/claude-code-version` says (the script stops otherwise),
`git`, `jq`, and the network. Items 5 and 7 hold sessions open for more than ten
minutes, so the run takes about an hour.

## What `run.sh` touches on your machine

Only its temp dir (`${TMPDIR:-/tmp}/of-g1.XXXXXX`) and `docker run --rm` of the
image, plus read-only `git clone` of the two public repos into that temp dir.
Every container gets its own host-temp plugins dir, config dir, workdir and home
under that temp dir; `~/.claude`, `~/.open-factory-spike` and your keychain are
never read or mounted, and the script refuses to run if `HOME` points into the
spike dir (it mounts no home directory, so the dir merely existing is fine). The
credential goes in by name (`docker run -e CLAUDE_CODE_OAUTH_TOKEN`) only for
session items, and the script scans its temp dir for it before it prints the
report. Delete the temp dir when you are done; `run.sh` prints the command.
