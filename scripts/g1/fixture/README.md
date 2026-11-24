# Gate G1 fixture

`scripts/g1/run.sh` needs no GitHub account in the normal case. `make-fixture.sh`
builds everything from git alone, and `run.sh` mounts it read-only into the
throwaway containers (spec section 13, "Setup"). Nothing is pushed anywhere and
nothing is installed on your machine.

```sh
scripts/g1/fixture/make-fixture.sh <outdir>   # run.sh does this itself
```

## What it builds

| Path | What it is |
|---|---|
| `dir/` | The directory marketplace `fixdir`: `marker`, `dep`, `ranged`, `rel` (`defaultEnabled: true`) and `shaext-ext`, an external `git-subdir` entry with a `sha` that points into `src-fixture.git` (`file:///fixture/acme.git`). Mounted as `/fixture/dir`. |
| `src-fixture.git` | A bare git repo of the same tree, as the marketplace `fixture`. Two commits (the second changes `marker`, 1.0.0 to 1.1.0), `main` at the second, tag `v1` and tag `dep--v1.0.0` on the first. |
| `src-latest.git` | The same, as the marketplace `fixlatest`: the "Latest" marketplace of items 5 and 7. |
| `evil/` | A directory marketplace `evil` with the plugin `x` (item 15). |
| `extras/` | `skill-foo` (item 11), `sneaky` (item 14), `skill-h` and `agent-a.md` (item 18). Copied into workdirs by `run.sh`. |
| `SHAS` | The deterministic commit SHAs, read by `run.sh`. |

`run.sh` does not mount `src-*.git` directly. It serves a copy that holds only
the first commit (plus tag `v1` and branch `stable`) as `/fixture/acme.git`
and `/fixture/acme-latest.git`, and "pushes" the second commit between runs
(`git push` of `main`), so items 5 to 7 see a real update arrive.

`marker` has every code path write a file into `$MARK`: a SessionStart hook, an
MCP server (which also writes `${CLAUDE_PLUGIN_DATA}/x`), `bin/x`, a monitors
entry, and `preinstall`/`postinstall` scripts in `package.json`. A file in
`$MARK` means plugin code ran. The marks a session writes (`hook-sessionstart`,
`mcp-start`, `bin-x`, `monitor`) are told apart from the install-time ones
(`npm-preinstall`, `npm-postinstall`).

The npm dependency is **`ms` 2.1.3**: exact-pinned, tiny (one file, no
dependencies of its own) and one of the best-known packages on the registry. The
`package-lock.json` is written by hand (lockfile v3, no integrity hash, which npm
fills in), so building the fixture needs no npm and no network.

## When item 0 says GitHub is needed

Item 0 tries `{"source":"git","url":"file:///fixture/acme.git"}` in `--settings`.
If Claude Code refuses it, items 4 to 7 need real GitHub repos:

1. Create two **public**, empty repos under your account (no README, no licence):
   `<you>/of-g1-fixture` and `<you>/of-g1-fixture-latest`. They are throwaway;
   delete them after G1.
2. Rerun with `G1_GITHUB_REPO=<you>/of-g1-fixture scripts/g1/run.sh`.

`run.sh` then pushes the fixture itself with your own git credentials
(`git push --force` of `main`, `stable` and the tags, and of the second commit
between runs), so the repos must be ones you may force-push to. The commit SHAs
are deterministic. Items 8 and 9 never use these repos; they use the real
`obra/superpowers-marketplace` and `anthropics/claude-plugins-official`, because
a `file://` repo would still clone with the network down.

## Running it

```sh
export CLAUDE_CODE_OAUTH_TOKEN=...      # for the items that start a session
scripts/g1/run.sh                       # image open-factory-base:<pin>
scripts/g1/run.sh open-factory-base:dev # or the tag you built
```

Prerequisites: Docker running, the image present locally with Claude Code
exactly as `images/base/claude-code-version` says (the script stops otherwise),
`git`, `jq`, and the network. Items 5 and 7 each hold one session open for more
than ten minutes, so the run takes about an hour.

## What `run.sh` touches on your machine

Only its temp dir (`${TMPDIR:-/tmp}/of-g1.XXXXXX`), `docker run --rm` of the image,
and (only with `G1_GITHUB_REPO`, only if item 0 fails) pushes to your two repos.
Every container gets its own host-temp plugins dir, config dir, workdir and home
under that temp dir; `~/.claude`, `~/.open-factory-spike` and your keychain are
never read or mounted, and the script refuses to run if `HOME` holds the spike
dir. The credential goes in by name (`docker run -e CLAUDE_CODE_OAUTH_TOKEN`)
only for session items, and the script scans its temp dir for it before it
prints the report. Delete the temp dir when you are done; `run.sh` prints the
command.
