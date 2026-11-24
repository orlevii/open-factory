# Gate G1 fixture

`scripts/g1/run.sh` needs a real git marketplace on GitHub, because a plain path
makes a directory marketplace and tests no clone at all (spec section 13,
"Setup"). `make-fixture.sh` builds it; you push it once.

## What it builds

| Directory | What it is |
|---|---|
| `of-g1-fixture/` | Marketplace `fixture` with `marker`, `dep`, `ranged` and `shaext`. Two commits: the second changes `marker` (1.0.0 to 1.1.0). Tag `dep--v1.0.0` sits on the first commit. |
| `of-g1-other/` | Marketplace `evil` with the plugin `x`, and at its root the plugin `shaext`. One commit. Used as "another repo" (items 6, 12, 15) and as an external source with a `sha`. |
| `localdir/` | A directory marketplace `localdir` with the relative plugin `rel` (`defaultEnabled: true`). Not pushed. |
| `extras/` | `skill-foo`, `sneaky`, `skill-h`, `agent-a.md`. Not pushed. |

`marker` has every code path write a file into `$MARK`: a SessionStart hook, an
MCP server (which also writes `${CLAUDE_PLUGIN_DATA}/x`), `bin/x`, a monitors
entry, and `preinstall`/`postinstall` scripts in `package.json`. A file in
`$MARK` means plugin code ran.

The npm dependency is **`ms` 2.1.3**: exact-pinned (no range), tiny (one file,
no dependencies of its own) and one of the best-known packages on the registry.
`make-fixture.sh` uses it only to write a real `package-lock.json`
(`npm install --package-lock-only --ignore-scripts`); nothing is installed.

## Push steps (once)

1. Create two **public**, empty GitHub repos under your account (no README, no
   licence): `<or>/of-g1-fixture` and `<or>/of-g1-other`. They are throwaway;
   delete them after G1.
2. Build the fixture (needs the network once, for the lockfile):

   ```sh
   scripts/g1/fixture/make-fixture.sh /tmp/of-g1-out <or>
   ```

3. Push both repos, with tags:

   ```sh
   cd /tmp/of-g1-out/of-g1-fixture
   git remote add origin https://github.com/<or>/of-g1-fixture.git
   git push -u origin main --tags

   cd /tmp/of-g1-out/of-g1-other
   git remote add origin https://github.com/<or>/of-g1-other.git
   git push -u origin main
   ```

   The commit SHAs are deterministic, so rebuilding and pushing again is a
   no-op.
4. Run the gate with the exact Claude Code version in
   `images/base/claude-code-version`, and a credential in the environment
   (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`):

   ```sh
   scripts/g1/run.sh <or>
   ```

`run.sh` rebuilds the fixture into its own temp dir and refuses to run unless
`origin/main` of both GitHub repos matches the SHAs it built.

## What `run.sh` touches on your machine

Only its temp dir (`${TMPDIR:-/tmp}/of-g1.XXXXXX`). It uses a throwaway `HOME`
and a throwaway npm cache inside it, so `~/.claude` and `~/.npm` are never read
or written, and it never reads `~/.open-factory-spike`. Delete the dir when you
are done (`chmod -R u+w <dir> && rm -rf <dir>`, since the seed is read-only).
It clones from GitHub and Claude Code talks to the network.
