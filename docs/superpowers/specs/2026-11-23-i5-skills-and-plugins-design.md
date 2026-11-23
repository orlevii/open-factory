# I5 Skills and plugins: Technical Design

- **Task spec** (gitignored; read it in the main checkout): `docs/product/roadmap/v0.0.2/i5-skills-and-plugins.md`.
- **Decision:** ADR 0024. Amends ADR 0017. Pre-release rules: ADR 0028 (no compatibility code, no data migration).
- **Builds on:** I2 (overlay, merge, `validateEffective`, the change flow, ConfigForm), I6 (`PathField`, `resolveHostFolder`), I4 (form errors) and U4 (sheets, drawers). I3 sits between I2 and I5 in the stack and is untouched.
- **Consumers:** I7. Its `manage_org` tools read the Library and assign entries; they never write it (§11.1).
- **Decision log:** the GitHub issue "I5: Skills and plugins — design". Q1–Q20 are the owner-proxy's (owner-i5) answers. T1–T9 are tech-lead decisions (§20). Reviews: §19.

> Web paths are relative to `apps/web/src/` unless they start with `apps/` or `packages/`. "Store" always means the shared plugin store (§7.2). "Library" means the factory's skills, plugins and marketplaces together.

## 1. Goal

Skills and plugins become things you can see, pick and reuse, instead of names typed into YAML and marketplaces hand-declared in `settings.json`.

- A **Library** with four skill sources:
  - host global, live;
  - local folder, linked;
  - GitHub, pinned to a commit;
  - template-local.
- Plugins come from factory-wide **marketplaces**, each pinned to a commit.
- A **Skills** page shows each entry's contents and provenance, and who uses it.
- Templates pick a baseline from the Library, and persistent agents add on top (the I2 overlay).
- Every plugin version is installed **once** into one factory-owned store that agents only read (closes #56).

### 1.1 Deviations from the task spec (owner-proxy approved; Or can overrule them in one pass)

- **Host-installed plugins aren't selectable as they are** (Q7). They are listed with their host contents under "On this host". **Use in factory** registers their marketplace (its source copied from the host's own record) and installs the plugin into the store. Only the store copy is selectable, because that is the code agents run. The task's acceptance criterion still holds: selecting the plugin writes `enabledPlugins` and `extraKnownMarketplaces`.
- **An agent's plugin additions are limited to its template's marketplaces** (Q5, I2 S2 kept). The task's "add more" holds for skills without limit, and for plugins within the template's marketplaces.
- **`plugins:` leaves `template.yaml` and the overlay** (Q4). `settings.json` `enabledPlugins` is the one source.
- **No name aliases** (Q3). A taken name is refused at add time.
- **Unpinned plugins are never fetched automatically** (Q9). A plugin whose marketplace doesn't pin its source installs only on a human click in Skills.
- **An update that would drop a skill or plugin in use is refused** (Q18).

## 2. Acceptance criteria

Each criterion names the PR that makes it true (§17).

1. (PR 1) A skill folder in the host's `~/.claude/skills` appears on the Skills page with no setup, with its name, description, the source tag "Host" and its users. When the folder is removed, the row shows "Missing", and templates that list it get a validation error.
2. (PR 1) Adding a GitHub skill pins it to a commit. "Find skills" shows "Pinned to a1b2c3d (main, …)", and the fetch lands in `state/library/github/<source>/<sha>/` read-only. Fetches use a local fixture repo through `FACTORY_GITHUB_URL`, never the network.
3. (PR 1) "Check for updates" shows the newer commit, its date, its subject and the skills it adds, removes or changes, without applying anything. "Update" repins, and agents using the source restart when idle with "skill x updated a1b2c3d → e4f5a6b". An update that would drop a skill that is in use is refused, naming its users.
4. (PR 1) A local folder of skills is registered through `PathField` with `~/` accepted. Edits to a registered skill show live. The folder is refused when it is the home directory, an ancestor of it, or anything under `FACTORY_HOME`.
5. (PR 1) A template picks Library skills in its Configuration form. A persistent agent shows them read-only under "From template dev" and adds its own under "This agent", and template skills can't be removed per agent. Each row shows its source tag and pin.
6. (PR 1) In Docker, a GitHub skill and a folder skill are mounted read-only at their real paths, and the mount allow-check accepts exactly those paths. A symlink planted anywhere in the cache path is refused at start.
7. (PR 2) Adding a marketplace pins it to the store clone's commit. A start or install whose store clone isn't at the pin fails closed with "Marketplace acme isn't at its pinned commit."
8. (PR 2) Selecting a host-installed plugin for a template (after Use in factory) writes `enabledPlugins["name@mkt"]: true` and `extraKnownMarketplaces[mkt]`, copied from the registry, which is the host's record. Both are visible in the raw tab, and the agent starts with the plugin listed in its `system/init`.
9. (PR 2) Spawning three agents from a template with a plugin installs it at most once, and each `spawn_agent` returns without a plugin install. Fake Claude's plugin log shows one `install` (zero if it was already in the store).
10. (PR 2) The plugin peek lists every hook (event, matcher, full command), every MCP server (full command and args, or full URL), the other code-running parts, skills, commands and agents. It also shows provenance: marketplace, pin, version and gitCommitSha. A hook script inside the plugin opens with View file.
11. (PR 2) Nothing updates by itself:
    - the generated settings and env turn Claude Code's marketplace and plugin auto-update off, for agents and for store runs;
    - the store is read-only to Docker agents, and non-writable on disk for local ones;
    - a plugin update shows the hooks, MCP servers and commands it adds or removes before you confirm.
12. (PR 2) An agent's own plugin, added from its template's marketplaces, is listed under "This agent". The agent picker offers no plugin from another marketplace.

## 3. Scope

**In:** the task spec's Scope and Tasks 1–5, the security conditions in §11, and Gate G1 (§13).

**Out:**
- a skill authoring studio, ratings or sharing;
- editing a template's `skills/` and `files/` in the UI (#36);
- npm-sourced plugins (refused, §7.6);
- per-source GitHub tokens (follow-up);
- garbage collection of old plugin versions and old GitHub checkouts (follow-up);
- aliases (Q3);
- per-template plugin version pins (Q10);
- I7's MCP tools for reading the Library (I7 wraps the services in §9).

## 4. Inventory: today → after I5

Today is the I3 branch as specified. The I2 rows describe I2's design, because nothing from I2 or I3 is implemented yet.

| Area | Today (code, or the I2 design) | After I5 |
|---|---|---|
| Host skills dir | `FACTORY_HOST_SKILLS_DIR` (`config.ts:80`, default `~/.claude/skills`), README row, every smoke script | `FACTORY_HOST_CLAUDE_DIR` (default `~/.claude`). Skills are read from `<dir>/skills` and host plugins (read only) from `<dir>/plugins`. The old variable is deleted (Q11) |
| Skill refs | `skills: [name]`, `hostSkillSchema`, resolved only against the host dir (`links.ts resolveHostSkills`; `validate.ts:158`) | Same field, resolved against the Library: host, folder, GitHub, plus the template's `skills/` (§5.3) |
| Template-local skills | I2: linked live from `realpath(<tpl>/skills)/<name>`, with a mount exemption (I2 §6.4) | Unchanged. Listed in the Library as source "Template" |
| Host skill list API | I2: `GET /api/host-skills` | Deleted in PR 1. Replaced by `GET /api/library/skills` |
| Plugins key | `template.yaml plugins: [name@mkt]` (`templates.ts:16,56,78`); overlay `template.plugins` (I2) | Deleted. `settings.json enabledPlugins` is the truth (Q4) |
| `enabledPlugins` | A warning: "ignored: list plugins in template.yaml" (`validate.ts:237`); derived at start from the per-agent install (`settings.ts buildSettings`) | Validated truth: values `true` only, each marketplace declared and registered (§7.4) |
| Marketplaces | Hand-declared in template `settings.json` `extraKnownMarketplaces`; types `directory`, `git`, `github`; `ref`/`path` refused (`validate.ts:191–216`) | Factory registry (`marketplaces` table). The template's entries are copies, validated against the registry (Q5) |
| Plugin install | Per agent, at create and re-sync (I2: at start when missing), into `state/agents/<slug>/plugins-config/` (`workspace.ts install`, `plugins.ts installPlugins`) | Once per version into the store `state/plugins/`, by the factory only (§7.2). `plugins-config/`, `readPluginKeys`, `linkPlugins`' target and `pluginsConfigDir` are deleted |
| `.claude-config/plugins` | Symlink to the agent's own `plugins-config/plugins` | Link to an empty, non-writable `state/plugins-empty/`; plugins come from the store as a Claude Code **seed** (`CLAUDE_CODE_PLUGIN_SEED_DIR`, §7.2–§7.3) |
| Docker mounts | Agent's own plugins dir (ro); declared directory marketplaces (ro); host skill dirs (ro) (`mounts.ts`) | The store (ro) and `state/plugins-empty` (ro); registered directory marketplaces used by enabled plugins (ro); every resolved skill dir (ro), with two new exact-location classes for the GitHub cache and the store (§6.5) |
| Change flow | I2 `describeChanges(ConfigDoc, ConfigDoc)` | `Effective` gains `library` (resolved pins and versions). Library updates run the same flow (§8) |
| UI | I2 combobox over host skills; plugins as typed text | Skills page (Skills, Plugins, Marketplaces), add sheets, peeks, Library pickers (§10) |

**Verified on this host** (Claude Code's plugin dir, v2 format):
- `plugins/installed_plugins.json` is `{version: 2, plugins: {"name@mkt": [{scope, installPath, version, installedAt, lastUpdated, gitCommitSha, projectPath?}]}}`;
- `plugins/known_marketplaces.json` is `{name: {source, installLocation, lastUpdated}}`;
- code lives in `plugins/cache/<mkt>/<plugin>/<version>/` (with `.claude-plugin/plugin.json`, `hooks/hooks.json`, `skills/`, …), and clones in `plugins/marketplaces/<name>/` (with `.claude-plugin/marketplace.json`);
- marketplace plugin sources include relative paths, `{source: "url", url, sha?}`, `{source: "git-subdir", url, path, ref?, sha?}` and `github` (some with a `sha`, some without).

**From Claude Code's docs** (code.claude.com/docs/en/plugins/org and /plugins/loading, read 2026-11-23), confirmed by Gate G1 (§13) on the shipped version:
- the **seed** (`CLAUDE_CODE_PLUGIN_SEED_DIR`) is read-only, never written, has auto-update forced off, and its plugins aren't enabled on their own;
- `CLAUDE_CODE_PLUGIN_CACHE_DIR` builds a seed;
- an installed plugin with no `enabledPlugins` entry loads by default;
- `claude plugin install name@mkt` refreshes the marketplace unless `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set;
- auto-update is off with `DISABLE_AUTOUPDATER=1` unless `FORCE_AUTOUPDATE_PLUGINS=1`, and on by default for official marketplaces;
- a 40-hex SHA is a valid marketplace `ref` (from 2.1.324);
- `command`-source plugins re-run their command every session;
- directory-marketplace plugins load in place;
- replaced versions are deleted 14 days after being orphaned;
- a skill's `/` name defaults to its folder but the frontmatter `name` overrides it.

## 5. The Library model

### 5.1 Tables (Q1)

Exactly two new tables. Host and template-local entries are discovered live and never stored.

```ts
// packages/db/src/schema/library.ts
skill_sources {
  id: uuid pk,
  kind: "folder" | "github",
  // folder: the realpath from resolveHostFolder. github: null.
  path: text null,
  // github only
  repo: text null,          // "owner/repo", lower-cased
  subpath: text null,       // "" = repo root; normalised, no leading slash, no "..", no "."
  branch: text null,        // null = the default branch (HEAD) at add time
  commit: text null,        // 40-hex pin
  committedAt: timestamptz null, subject: text null,
  // the last "Check for updates" (null = never checked, or up to date)
  updateCommit: text null, updateAt: timestamptz null, updateSubject: text null, checkedAt: timestamptz null,
  skills: jsonb string[],   // the picked skill folder names (Q17, Q19), sorted; ≥1
  addedBy: text, addedAt: timestamptz,
  deletedAt: timestamptz null,  // soft delete for Undo (§9.4)
}
marketplaces {
  name: text pk,            // the marketplace's own name (marketplace.json "name"), MARKETPLACE_PATTERN
  source: jsonb,            // Claude Code source object: {source:"github", repo} | {source:"git", url} | {source:"directory", path}
  commit: text null,        // pin; null only for directory (live, Q9)
  committedAt, subject,     // as above
  updateCommit, updateAt, updateSubject, checkedAt,
  addedBy, addedAt, deletedAt,
}
```

- A pin is columns, not a revisions table (Q1).
- `skills` is the picked set (Q19 A). Each name is unique across live rows (§5.2), enforced in the service under the Library lock, and the column check is `HOST_SKILL_PATTERN`.
- A git `url` source is stored without userinfo. URLs with credentials are refused at input (§11.2).
- `marketplaces.source.path` for `directory` is the realpath from `resolveHostFolder`.

### 5.2 One namespace and its collisions (Q2, Q3, Q20)

Every skill visible to the factory has one **name**, which is its folder name.

- **Precedence.** Registered entries (folder, GitHub) are in the namespace. A host skill whose name a registered entry already uses is shown as "Hidden: the name is used by <entry>" and doesn't resolve.
- **Uniqueness.** Adding a registered skill whose name is taken, by a live host skill or by another registered entry, is refused: "A skill named tdd already exists (host). Remove or rename it first." There are no aliases.
- **Frontmatter name.** `SKILL.md` frontmatter `name`, when present and different from the folder name, makes the entry unusable:
  - registered: refused at add;
  - host: the row's state is "Unusable: SKILL.md names it x", and it doesn't resolve.
  
  Claude Code's docs say the `/` name defaults to the folder and the frontmatter `name` overrides it (G1 item 5 records it), so without this rule the agent would see another name than the one templates list.
- **Template-local skills** belong to their template only. A template that lists a Library skill with the same name as one of its `skills/` folders gets an error, and so does an overlay that adds one (Q20 A). A Library entry that merely shares a name with some template's local skill is fine; that template's picker hides it.

`LibraryIndex.resolveSkill(name)` returns `{ name, source: SkillSourceRef, dir: string /* realpath */, ref: string }`, where `ref` is `"host"`, `"folder"` or `"github:<sha>"`. It returns no result when the name is missing, hidden or unusable.

### 5.3 Discovery (`apps/server/src/library/library-index.ts`)

`LibraryIndex.skills()` reads, live, on every call (no watcher, like templates):

1. **Host.** The entries of `<FACTORY_HOST_CLAUDE_DIR>/skills`. An entry is a directory (a symlink is followed, as today: it's the operator's own dir) that holds a `SKILL.md`, and its name matches `HOST_SKILL_PATTERN`. Other entries are skipped silently (`*.zip`, a folder without `SKILL.md`).
2. **Folder sources.** For each live `skill_sources` row of kind folder and each picked name, the skill is at `path/<name>`, or at `path` itself when the source is one skill (§6.1). If it's gone or has no `SKILL.md`, its state is "Missing".
3. **GitHub sources.** `state/library/github/<id>/<commit>/<name>` (or the root for a one-skill source). If that is missing (someone deleted the cache), the state is "Missing" with "Fetch again", which re-runs §6.2 at the same commit.
4. **Template-local.** For each valid template, the real folders under its `skills/`, with source `{kind: "template", template}`. Listed, never resolvable by another template.

- **Description:** the `SKILL.md` frontmatter `description`, read with `O_NOFOLLOW`. That means a symlinked `SKILL.md` gives no description; host skills follow their top folder link only. At most 64 KB is read, and the description is cut to 200 characters.
- **Users** (`usedBy`):
  - templates whose `last_valid` doc lists the name;
  - agents whose effective skills include it: the non-archived, non-terminated agents of those templates, plus overlays that list it.
  
  Computed in JS from the `templates` rows and `agents` rows, both small.

## 6. Skills

### 6.1 Folder sources

- **Input.** A `PathField` (I6). The server runs `resolveHostFolder("path", input)`, which handles `~/`, the shape check, realpath and is-a-folder.
- **The folder check.** `checkSkillFolder(real)` is new, and shares the forbidden set with `checkMounts` (§6.5), so the rules can't drift. It refuses:
  - `/`;
  - the host home (both `$HOME` and the user-db home) and any ancestor of it;
  - `FACTORY_HOME`, anything under it, and any ancestor of it;
  - a Docker socket, or an ancestor of one.
  
  Message: "This folder can't be shared with agents." in the field note, with the reason beside it: "It's your home folder." / "It's inside the factory's folder."
- **Shape.**
  - If `path/SKILL.md` exists, the source is **one skill** named `basename(path)`.
  - Otherwise each direct subfolder with a `SKILL.md` is a candidate. A subfolder that is a symlink is listed as "Skipped: a link", unpickable, because a link inside a registered folder could point anywhere, and the realpath is what gets mounted.
- **Live.** Edits inside a picked skill show at the agent's next read. Docker mounts the realpath.
- **New subfolders** never appear by themselves. The source peek has **Find more skills**, which runs the pick step again and adds to the same source (Q19 A).

### 6.2 GitHub fetch (`apps/server/src/library/git-fetch.ts`)

**Input.**
- **Repository:** `owner/repo` or `https://github.com/owner/repo[.git]`, normalised to `owner/repo`. Owner and repo match `^[A-Za-z0-9_.-]{1,100}$`.
- **Path:** optional, normalised (no `..`, no absolute path).
- **Branch:** optional, matching `git check-ref-format --branch`.

Anything else is refused: "Use owner/repo or a github.com URL." That covers other hosts, userinfo, query strings and SSH. The URL is built as `${FACTORY_GITHUB_URL}/${owner}/${repo}.git`, where `FACTORY_GITHUB_URL` defaults to `https://github.com`. It is an operator env var, used by tests and the evidence pass to point at a local fixture.

**Process.** Every git command uses the hardened runner `runGit(args, { cwd })`:
- the binary is `git`;
- the cwd is a fresh empty temp dir (never anything an agent can write);
- the env is exactly `PATH` and the host `HOME`, plus `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_ASKPASS=` (empty) and `GIT_LFS_SKIP_SMUDGE=1`;
- each command gets 60 s, and the whole operation 180 s;
- output passes through `redactOutput` (moved to `apps/server/src/redact.ts`, shared with plugins), keeping the last 20 lines, at most 4 KB.

Every command starts with these `-c` flags:

```
-c protocol.allow=never -c protocol.https.allow=always [-c protocol.file.allow=always  // only when FACTORY_GITHUB_URL is file:]
-c core.symlinks=false -c core.hooksPath=/dev/null -c submodule.recurse=false
-c fetch.recurseSubmodules=false -c credential.interactive=false
```

**Resolve.** `git ls-remote <url> <refs/heads/<branch> | HEAD>`. The first matching line's sha is the commit. No match gives "No branch main in acme/x."

**Fetch:**
1. `git init -q <tmp>/co`
2. `git -C co fetch --depth 1 --no-tags <url> <sha>`
3. `git -C co checkout -q --detach FETCH_HEAD`
4. `git -C co rev-parse HEAD` must equal `<sha>`, or fail closed: "acme/x didn't return commit a1b2c3d." (Q8)
5. `git -C co log -1 --format=%cI%x00%s` gives the date and subject (the subject is cut to 200 characters).

**Check.**
- The subpath must resolve (lexically and by `realpath`) inside `co`.
- The checkout's total file size must be at most **50 MB**, else "acme/x is larger than 50 MB." It is counted with `lstat` and never follows anything; with `core.symlinks=false` there are no links.
- No submodules and no LFS objects are fetched. A gitlink entry is simply an empty folder. The help line says so.

**Store.** Copy only the subtree at the subpath, without `.git`, into `state/library/github/<sourceId>/<sha>/`, through a temp name plus rename. Then `chmod -R a-w` (dirs 0555, files 0444; executables keep 0555).
- Previews (§9.2) stage into `state/library/preview/<random>/<sha>/`. Add moves the staged dir into place, and a preview older than an hour is swept by the existing hourly timer.
- The cache is keyed by `<sourceId>/<sha>`, so a repin never overwrites a checkout a running agent may be reading.

**Private repos** work through the host's git credential helpers only (Q8 A). An auth failure maps to "Couldn't reach acme/x. If it's private, sign in to GitHub with git on this host."

### 6.3 Updates (Q18)

- **Check** (`POST …/check`): ls-remote of the source's branch (or HEAD).
  - When the sha differs, it fetches that commit into the preview area as in §6.2 (to read the date, subject and skill set) and stores the `update*` columns.
  - "Check all" in the page header runs every GitHub source and every git or GitHub marketplace with at most **4 at once**.
  - Nothing ever checks automatically.
- **Update view** (in the peek):
  - "a1b2c3d → e4f5a6b · 2 days ago · <subject>";
  - a GitHub compare link, `https://github.com/<repo>/compare/<old>...<new>` (an `<a>` with `rel="noreferrer"`, only when `FACTORY_GITHUB_URL` is the default);
  - the changes to the picked skills: "added" (new folders aren't auto-picked: they list as "New in this commit, not added"), "removed", and "changed" (a different tree hash, from `git rev-parse <sha>:<path>` read during the fetch).
- **Apply** (`POST …/update { commit }`, where the commit must equal `updateCommit`):
  - **Refused** when any picked skill is missing at the new commit and is in use: 409 `update_drops_used`, "Update would remove skill tdd, used by template dev and @ana." A missing picked skill that is unused is dropped from `skills`, and the confirm names it.
  - Otherwise it moves the staged checkout into the cache, updates the pin and clears `update*`.
  - Then it runs §8.3 for the source's skills.

### 6.4 Linking (`links.ts`)

- `resolveHostSkills` becomes `resolveSkills(names, ctx)` over `LibraryIndex.resolveSkill`. It returns `{ name, dir: realpath }[]`. A missing name fails with `WorkspaceError("Skill x isn't in the Library.", "template" | "config")`, choosing the fix the way I2 §6.5 does.
- `syncLinks`' "drop unlisted links" pass takes the set of **allowed target prefixes**: the host skills dir, each folder source path, the GitHub cache root and the template `skills/` realpath. It removes only links pointing under one of them, as today, and never touches a non-link.
- Links point at the realpath (Docker mounts real paths only).

### 6.5 Docker mounts (`mounts.ts`)

`buildMounts` takes `skillPaths` (every resolved skill realpath, all read-only) in place of `hostSkillPaths`, and `storePluginsDir` in place of `pluginsDir`.

`checkMounts` keeps every existing refusal, including the I2 template-skill exemption. Paths outside `FACTORY_HOME`, such as host and folder skills, pass the existing forbidden-set rules. It gains exactly two allowed classes under `FACTORY_HOME`, each accepted only at an exact location with no link on the way:

1. **GitHub skill.** `real` equals `join(realpath(<FH>/state/library/github), <id>, <sha>, <name>)` (or `…/<sha>` for a one-skill source), and every component from `<FH>/state/library/github` down is `lstat`ed and is a directory, not a link. That includes `state`, `state/library` and `state/library/github` themselves.
2. **The store.** `real` equals `realpath(<FH>/state/plugins)` or `realpath(<FH>/state/plugins-empty)`, with the same lstat walk from `<FH>/state`.

Both are read-only only, with parity targets. Nothing else under `state/` is newly allowed. The existing "inside `FACTORY_HOME` and isn't this agent's workdir" refusal now reads "… isn't this agent's workdir, a Library skill or the plugin store".

**Tests**, using the default layout (`FACTORY_HOME` under `HOME`):
- a GitHub skill mounts;
- `state/library/github` replaced by a link to `~/.ssh` is refused;
- a `<sha>` dir replaced by a link to `state/agents/bob` is refused;
- a skill path one level up (`…/<id>`) is refused;
- `state/plugins/cache` (a sub-path of the store) and `state/` itself are refused;
- a folder source equal to `~` is refused at add **and** at start.

### 6.6 Validation

`validateEffective` (I2 §5.3) replaces "host skill exists" with these rules, on `template.skills` (template and overlay):
- "Skill x isn't in the Library." (error);
- "Skill x is hidden: the name is used by <entry>." (error);
- "Skill x is unusable: SKILL.md names it y." (error);
- "Skill x is missing from its folder." (error).

The collision rule with template-local skills stays (§5.2).

## 7. Marketplaces and plugins (PR 2)

### 7.1 The registry

**Add marketplace** (sheet; §10.4) takes one of:
- GitHub `owner/repo` (the same input rules as §6.2);
- a git URL: `https://` only, no userinfo, built into `{source: "git", url}`;
- a local folder: `PathField`, then `resolveHostFolder` and `checkSkillFolder`'s forbidden set.

The add itself:
1. Under the store lock (§7.2), run `claude plugin marketplace add <arg>` against the store. `<arg>` is the repo, the URL or the path (today's `marketplaceSourceArg`).
2. Read the new `known_marketplaces.json` entry, whose name is the marketplace's own. Refuse when that name is already registered: "A marketplace named acme already exists."
3. For git and GitHub, read `git -C <installLocation> rev-parse HEAD` through `runGit` and store it as the pin, with its date and subject. The registry's `source` then gains `ref: <pin>`. The docs accept a full 40-hex SHA as a github or git marketplace `ref` from Claude Code 2.1.324; record the version in G1. That `ref` is what every generated `extraKnownMarketplaces` copy carries, and an Update rewrites it.
4. Insert the row.

On any failure, run `claude plugin marketplace remove <name>` and report the redacted reason.

**Pin enforcement (Q9.2).** `assertMarketplacePinned(name)` runs:
- before every store install or update;
- when a start checks the store (§7.3).

It compares `rev-parse HEAD` in the clone with `marketplaces.commit`. On a mismatch it fails closed: "Marketplace acme isn't at its pinned commit." It never re-adds or pulls to repair. Directory marketplaces have no pin (live, "Local folder, live").

**Check and Update.**
- Check: ls-remote, as §6.3.
- Update (a human click):
  1. Under the lock: `git -C <clone> fetch` plus `checkout --detach <updateCommit>` through `runGit`. Claude's own `marketplace update` isn't used, because it would pull the branch head, not the reviewed commit.
  2. Verify HEAD.
  3. Update the pin.
  
  The confirm lists the plugins **in use** whose marketplace entry changes version or source (Q10). The contents change of each installed plugin shows when that plugin is updated (§7.5).

**Remove:**
- refused while any template's or overlay's `enabledPlugins` names a plugin of it, or any installed plugin comes from it ("Uninstall its plugins first");
- otherwise a soft delete with Undo;
- `claude plugin marketplace remove` runs when the Undo window ends.

**Who writes.** Only humans, through REST and the UI, write the registry and skill sources. No MCP tool, I7's `manage_org` tools included, adds, repins, updates or removes them (Q5). The Library routes are `requireUser` only, and §9 says so in each route's doc comment and in a route test.

### 7.2 The store is a Claude Code plugin seed (`apps/server/src/library/plugin-store.ts`, Q6)

Claude Code documents a read-only, shared plugin directory for containers and CI: the **seed** (code.claude.com/docs/en/plugins/org, "Seed containers and CI"). In its words:
- "pre-populate a plugins directory at build time and point `CLAUDE_CODE_PLUGIN_SEED_DIR` at it. Claude Code registers the seed's marketplaces at startup and loads plugin caches from the seed in place, without cloning";
- "Claude Code never writes to the seed and forces `autoUpdate` off for seed marketplaces";
- "The plugins in a seed aren't enabled on their own";
- "You can mount the seed at a different path than you built it at."

The store is that seed. Using the documented mechanism, rather than symlinking every agent's `plugins/` to one shared folder, settles G1's main risk (startup writes to a shared folder) by contract. G1 still confirms it (§13).

**Building the store:**
- The store is `FACTORY_HOME/state/plugins/`. Its layout is Claude's plugins layout: `known_marketplaces.json`, `installed_plugins.json`, `marketplaces/<name>/` and `cache/<mkt>/<plugin>/<version>/`.
- The factory is the only writer, through `StoreRunner.run(args)`. That is today's `installPlugins` path generalised:
  - it runs `claude plugin …` with `CLAUDE_CODE_PLUGIN_CACHE_DIR=<store>` (so the install lands in the seed) and `CLAUDE_CONFIG_DIR=<FACTORY_HOME>/state/plugins-runner/`, a factory-owned config dir holding only a factory-written `settings.json`;
  - it uses an empty temp cwd;
  - the env allowlist is `PATH` and host `HOME`, plus `DISABLE_AUTOUPDATER=1`, plus `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` on `install` and `update`. The docs say an install otherwise refreshes the marketplace first, which would move it off its pin;
  - arguments starting with a dash are refused;
  - budgets are 120 s per command and 240 s per operation;
  - output is redacted.
- One in-process **store lock** (`KeyedMutex` key `"store"`) serialises every store write: add, install, update, uninstall, chmod.
- **Writable only while locked.** Each locked operation does `chmod -R u+w`, runs, then `chmod -R a-w` in a `finally` (T3). Docker agents get the store as a read-only mount. For local agents, which run as the same user, this guards against accidents and isn't a boundary, and the docs say so (Q6.3).
- **Orphan cleanup.** Claude marks a replaced version `.orphaned_at` and deletes it 14 days later, during a later plugin operation. Only store runs can delete, because agents never write the seed. A process that has run for more than 14 days on an old version could lose its files at a later store operation. That is accepted and stated: restarts happen far more often than that, and the I2 change flow restarts every user of an updated plugin.

**Reading.**
- `installed()` parses `installed_plugins.json` and keeps only entries whose `installPath` is inside `<store>/cache/`. Directory-marketplace plugins load in place (docs) and are kept when their path is inside a registered directory marketplace.
- `marketplaceIndex(name)` parses the clone's `.claude-plugin/marketplace.json` with `lstat` and size caps (1 MB).

### 7.3 What a start does (`Workspace.prepare`)

1. Resolve `enabled` = the keys of the effective `settings.enabledPlugins` (§7.4).
2. **The agent's own plugins dir.** `.claude-config/plugins` becomes a factory-made link to `state/plugins-empty/`, an empty folder that the factory creates and makes non-writable (and that Docker mounts read-only).
   - Today, `claude plugin install` run by the agent itself (an agent can run anything in Bash) would install into its own config dir. An installed plugin with no `enabledPlugins` entry loads by default (`defaultEnabled`), so it would survive every restart.
   - With an empty, read-only plugins dir that install has nowhere to go, and a fresh start can't load it. S5 V7 verified that Claude starts normally when its plugins dir is read-only.
   - If the entry is a link elsewhere, the start re-creates it through `SafeFs`. A non-link fails the start: "….claude-config/plugins isn't a link; move it away." (I2's rule).
3. **Store check**, read-only and without the lock:
   - every marketplace of an enabled plugin is registered and passes `assertMarketplacePinned`;
   - every enabled plugin is in `installed()`.
4. **Missing plugin:**
   - **Pinned source** (a relative path in its pinned marketplace, or a `sha`): take the store lock and install it (§7.5). This holds a start slot for at most the 240 s budget, as I2's start install did. A failure gives `AgentStartError("Plugin x@y didn't install.", fix)` with redacted output.
   - **Unpinned:** fail closed with "Plugin x@y isn't installed. Install it in Skills." and fix `library` (§8.4). It is never fetched without a human (Q9.1).
5. **Env.** `CLAUDE_CODE_PLUGIN_SEED_DIR=<store>` and `DISABLE_AUTOUPDATER=1` are added to the agent env. Both go into I2's `FACTORY_ENV_NAMES`, together with `CLAUDE_CODE_PLUGIN_CACHE_DIR`, `CLAUDE_CODE_PLUGIN_DIRS` and `FORCE_AUTOUPDATE_PLUGINS`. No template, overlay or secret can set them.
6. **`buildSettings` writes:**
   - `enabledPlugins`: `true` for the effective set, plus an explicit `false` for every other plugin in the store. The docs only say seed plugins "aren't enabled on their own"; the explicit `false` costs nothing and doesn't depend on that;
   - `extraKnownMarketplaces`: the **registry's** source (with `ref: <pin>`) and `"autoUpdate": false`, for each marketplace of an enabled plugin. The docs say a seed marketplace declared in settings must be built "from that source and `ref`", which the registry guarantees.
   
   Its `pluginKeys` input is deleted.
7. **Docker mounts:**
   - the store, read-only, at the same path;
   - `state/plugins-empty`, read-only;
   - the registered **directory** marketplaces of enabled plugins, read-only. Their relative-path plugins load in place from the source folder (docs), so the mount stays.

**Create and spawn never install.** `materialize` loses `install`, `rm(pluginsConfigDir)` and the plugin part of `TemplateSource`. `PluginInstallError` leaves `agent-service.ts` and `spawn-service.ts`, and so does `502 plugin_install_failed` on create.

### 7.4 `enabledPlugins` (Q4, Q5; amends I2 S1)

- **Shape:** `Record<string, true>`. The key matches `^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$` (today's `pluginRef`). A `false` value is an error in templates and overlays: "Remove the plugin instead of turning it off." Any other value is an error.
- **Template `settings.json`.** For each key, `extraKnownMarketplaces[mkt]` must be declared ("Marketplace acme isn't declared in settings.json.") and registered:
  - not registered: "Marketplace acme isn't in the Library. Add it in Skills.", with the action "Add from this template", which opens Add marketplace prefilled from the declaration;
  - registered with a different source: "Marketplace acme's source differs from the Library's."
- **Overlay** (`settings.enabledPlugins`, unioned by I2's object merge): each key's marketplace must be declared by the **template**: "Marketplace acme isn't declared by template dev." (I2 S2, unchanged). `extraKnownMarketplaces` stays an error in overlays.
- **The plugin must be in the store or have a pinned source.** A selected plugin that is neither installed nor pinned gives the warning "Plugin x@y isn't installed and isn't pinned; install it in Skills before agents start." A warning, because a template on disk may be ahead of the store, and the start fails closed anyway.
- `templateYamlSchema` and `overlayTemplateSchema` drop `plugins`. `TemplateConfig.plugins` is deleted. Readers use `effectivePlugins(doc) = Object.keys(doc.settings.enabledPlugins ?? {})`. The old "enabledPlugins is ignored" warning and the `ref`/`path` refusal are deleted (the registry owns sources).
- **Writes from the form.** Selecting a plugin (template mode) sets `settings.enabledPlugins[key] = true` and `settings.extraKnownMarketplaces[mkt] = registry.source`. Removing the last plugin of a marketplace leaves its declaration, which is harmless and visible in the raw tab, so a hand-added declaration is never deleted behind the user's back.

### 7.5 Install and update (`PluginStore`)

**`install(key, by)`:**
1. Take the store lock.
2. Run `assertMarketplacePinned`.
3. Refuse npm sources: "npm plugins aren't supported."
4. Run `claude plugin install <key>`.
5. Run `assertMarketplacePinned` again. If the clone moved anyway (G1 item 3; the install runs with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` so it shouldn't), `claude plugin uninstall <key>`, roll the clone back with `checkout --detach <pin>`, and fail closed.
6. Read the new `installed_plugins.json` entry.
7. Record the provenance in an in-store sidecar, `state/plugins/provenance.json`, factory-written: `{key: {marketplace, marketplaceCommit, version, gitCommitSha, installedBy, installedAt}}`. It is a sidecar in the seed root, which Claude ignores (unverified; G1 item 1 also checks the run isn't disturbed by it), rather than a DB table, because the store is the truth of what is installed. It is factory-owned and non-writable like the store, and the Library flags a mismatch with `installed_plugins.json` ("Provenance unknown").
8. Publish `library_changed`.

**Triggers:**
- a human's **Install** in Skills;
- **Use in factory** for a host plugin (§7.6);
- a template or overlay save whose effective `enabledPlugins` gains a pinned plugin that isn't installed (enqueued in the background after the save, never awaited by the request);
- a start (§7.3).

Install state (`installing | failed: <redacted reason>`) is kept in memory per key and shown on the Plugins view.

**`update(key)`** is a human click.
- The Plugins view shows "Update available 1.2.0 → 1.3.0" when the pinned marketplace's entry for the plugin has a different `version` (or `sha`) than the installed one.
- The confirm shows the **contents diff** (Q10): hooks, MCP servers, commands and code-running parts added or removed, computed by parsing the new version in a scratch copy. The diff is computed by `claude plugin install` into a throwaway config dir that is a copy of the store's `marketplaces/<mkt>` at the pin. It is then shown and discarded.
- Apply: `claude plugin update <key>` (or `uninstall` plus `install`, per G1) under the lock. Old version folders stay (no GC). Then run §8.3.

**Uninstall** (Plugins peek): refused while any template or overlay enables the plugin. Otherwise `claude plugin uninstall <key>`, immediate, without Undo, because re-installing fetches again. A confirm dialog explains this: "Uninstall x@y? Installing it again fetches it again."

### 7.6 Host plugins (Q7)

- `HostPlugins.list()` reads `<FACTORY_HOST_CLAUDE_DIR>/plugins/installed_plugins.json` and `known_marketplaces.json`, read-only, with `lstat` and size caps. Each distinct key is listed with its newest install's version, gitCommitSha and contents, read from its `installPath`. The source tag is "On this host".
- A row whose key is already in the store says so ("Also in the factory"), and the store copy wins everywhere.
- **Use in factory** (a human click):
  1. Register the marketplace from the host's `known_marketplaces[mkt].source`, refused when the name is registered with a different source.
  2. Install the plugin into the store (§7.5).
  
  Nothing is read from, linked to or copied out of the host's plugin folders except that source record.
- Host directory marketplaces go through `checkSkillFolder`'s forbidden set.

### 7.7 Auto-update off and refused source types (Q6.2)

The docs give the switches.

**Marketplace auto-update** follows the first of these that is set:
1. `autoUpdate` on the `extraKnownMarketplaces` entry;
2. `autoUpdate` in `known_marketplaces.json`;
3. a default that is **on** for Anthropic's official marketplaces.

`DISABLE_AUTOUPDATER=1` (or `DISABLE_UPDATES`, or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) turns the whole pass off "unless you also set `FORCE_AUTOUPDATE_PLUGINS=1`".

So the factory sets:
- `"autoUpdate": false` on every generated `extraKnownMarketplaces` entry;
- `DISABLE_AUTOUPDATER=1` in the agent env and in the store-run env (the base image already sets it);
- `FORCE_AUTOUPDATE_PLUGINS` reserved (§7.3).

On top of that, seed marketplaces have `autoUpdate` forced off, and the store is read-only to agents.

**Refused plugin sources**, at Install, Use in factory and validation:
- **`npm`:** out of scope.
- **`command`:** the docs say Claude re-runs its command "once per session for each enabled command-sourced plugin … This run doesn't depend on the marketplace's auto-update setting or on `DISABLE_AUTOUPDATER`". That is code running at every session start, outside any hook a human reviewed.
- **Entries with `headersHelper`.**

`archive` is accepted only with `sha256`. The message is "Plugin x@y uses a <kind> source, which Open Factory doesn't install."

**Refused marketplace sources:** `url`, `file`, `npm` and `settings`. Only `github`, `git` and `directory` are accepted, as today.

### 7.8 Plugin contents (`library/plugin-contents.ts`)

`readContents(root)` reads, with `lstat`, no link following, each JSON at most 256 KB and at most 2,000 files walked:

- **Manifest:** `.claude-plugin/plugin.json`: name, version, description, author, homepage, repository.
- **Hooks:** `hooks/hooks.json`, plus `plugin.json` `hooks` (inline or a relative path). For each, the event, matcher, type, the full command and its timeout.
- **MCP servers:** `.mcp.json`, plus `plugin.json` `mcpServers` (inline or a path). For each, the name, the kind, and the full command with its args, or the full URL with its header **names** (values hidden: headers can hold `${TOKEN}` references, but never show values).
- **Other code-running parts:** `plugin.json` `lspServers` (or `.lsp.json`), `statusLine`, and any `bin/` executables (files with an exec bit at the plugin's top two levels).
- **By name:** `skills/*/SKILL.md`, `commands/*.md`, `agents/*.md`, plus custom paths in `plugin.json` (`commands`, `agents`, `skills`).
- **Unknown:** any `plugin.json` key outside the known set lists as "This plugin has parts Open Factory can't show: <keys>" (Q15.1).
- **`files`:** for hook and MCP commands, every `${CLAUDE_PLUGIN_ROOT}/<rel>` reference that resolves to a regular file inside the root (by realpath and lstat). This drives **View file** (Q15.2). `GET …/file?path=` returns at most 256 KB of text, refuses links and binaries, and checks the path is in that list, so the endpoint can't read anything else.

The result is cached in memory by `installPath`, which is immutable per version.

## 8. Change flow integration

### 8.1 `Effective.library`

`ConfigResolver.effective` (I2 §6.1) adds:

```ts
library: {
  skills: Record<string, string>;   // name → "host" | "folder" | "template" | "github:<sha>"
  plugins: Record<string, string>;  // key → "<version>@<gitCommitSha7>" | "missing"
}
```

It is resolved through `LibraryIndex` and `PluginStore.installed()`. `started` keeps it, so restarts compare against what the process started with.

### 8.2 `describeChanges` lines

These lines are new, sorted with the others and secret-safe:
- "skill x updated a1b2c3d → e4f5a6b";
- "skill x now from GitHub" (a source kind change);
- "plugin x@y updated 1.2.0 → 1.3.0";
- "added plugin x@y" / "removed plugin x@y" (from `enabledPlugins`; I2's "added plugin" now reads this key).

`summarizeChanges` counts them as skills and plugins.

### 8.3 Library-driven changes

`ConfigChanges.libraryChanged({ skills?: string[]; plugins?: string[]; by })` runs after a GitHub update, a marketplace update, a plugin update, and a removal Undo that restores a name. For each non-archived, non-terminated agent whose effective config uses one of those names, it runs I2's `apply(agent, by, before, after)`. `before` is the agent's last resolution: `started` when running, else a resolve computed before the mutation. `after` is a fresh resolve. The event, the passive notice and the restart when idle follow I2 §7.3 unchanged.

### 8.4 Fix codes

`library` joins the fix unions (`safe-fs.ts`, `agents/errors.ts`, `events.ts`) and opens `/skills` (or `/skills/plugins`). `forSpawnedAgent` keeps it.

## 9. APIs (all `requireUser`; humans only; never MCP)

Shared schemas live in `packages/shared/src/library.ts`.

### 9.1 Reads
- `GET /api/library/skills` returns `{ hostDir, skills: SkillEntry[] }`, where `SkillEntry = { name, description, source: {kind: "host"} | {kind: "folder", id, path} | {kind: "github", id, repo, subpath, branch, commit, committedAt} | {kind: "template", template}, state: "ok" | "missing" | "hidden" | "unusable" | "update", stateDetail?, usedBy: { templates: string[]; agents: string[] } }`.
- `GET /api/library/sources/:id` returns the source with its picked skills, its update info and its users.
- `GET /api/library/plugins` (PR 2) returns `{ store: PluginEntry[], host: HostPluginEntry[], available: AvailableEntry[] }`:
  - `available` holds the marketplace entries not installed, with `pinned: boolean`;
  - each entry carries `contentsSummary` (counts per kind) and `state`.
- `GET /api/library/plugins/:key` returns the full contents (§7.8) and provenance. `?from=host` reads the host copy.
- `GET /api/library/plugins/:key/file?path=` returns the View file text (§7.8).
- `GET /api/library/marketplaces` returns the registry rows, each with its plugins and users.

### 9.2 Skill sources
- `POST /api/library/sources/preview` takes `{ kind: "folder", path } | { kind: "github", repo, subpath?, branch? }` and returns `{ previewId?, commit?, committedAt?, subject?, found: [{ name, description, pickable: boolean, reason?: "taken" | "unusable" | "link", takenBy? }] }`. Errors are field errors (I4), redacted.
- `POST /api/library/sources` takes `{ kind, path | previewId, skills: string[] }` and returns 201 with the source. Under the Library lock it re-checks the names, then moves the preview into the cache.
- `POST /api/library/sources/:id/find` (Find more skills, folder and GitHub at the current pin) and `POST …/:id/add { skills }` add to the same source.
- `POST /api/library/sources/:id/check`, then `POST /api/library/sources/:id/update { commit }` (§6.3).
- `POST /api/library/sources/:id/fetch` re-fetches a missing cache at the same pin.

### 9.3 Plugins and marketplaces (PR 2)
- `POST /api/library/marketplaces { kind, repo | url | path }` returns 201, or 409 for a name taken or a different source.
- `POST /api/library/marketplaces/:name/check`, then `…/update { commit }`. `DELETE …/:name`, with Undo.
- `POST /api/library/plugins/:key/install` returns 202, and progress arrives through `library_changed`.
- `POST /api/library/plugins/:key/use-in-factory` returns 202.
- `POST /api/library/plugins/:key/update-preview` returns the contents diff. `POST /api/library/plugins/:key/update { version }` returns 202.
- `DELETE /api/library/plugins/:key` uninstalls.

### 9.4 Removal and Undo (Q18)

- `DELETE /api/library/sources/:id` is refused with 409 `in_use` and the users named ("Used by template dev and @ana."). Otherwise it sets `deletedAt` and returns `{ undoUntil }`, 30 s from now.
- `POST …/:id/restore` clears `deletedAt` while `now < undoUntil`, and is refused once a name it held has been taken by another entry.
- The hourly timer and a 30 s one-shot purge soft-deleted rows past the window: the row goes, and so do their cache dirs (`SafeFs.removeAll`, after the chmod). A marketplace's purge runs `marketplace remove` under the store lock.

### 9.5 Live updates

The new WS frame `{ type: "library_changed" }` is published after every Library write, every install-state change, and every check result. The web invalidates the `["library"]` queries. The host and template-local lists aren't watched; they refresh on focus and on `templates_changed`.

### 9.6 Locks

- One in-process **Library lock** serialises source and registry writes, so name uniqueness holds.
- The store lock (§7.2) serialises the store.
- Neither lock is ever held while awaiting a runtime job. A save's background install runs outside the request. A start takes the store lock only inside `prepare`, which already runs under the agent's workspace lock. The order is always workspace lock, then store lock, never the reverse.

## 10. Web

Every web task names `vercel-react-best-practices` for implementer and reviewer (§15).

### 10.1 Navigation and routes

- The sidebar `nav` gains **Skills** (icon `Blocks`) between Templates and Schedules, with `g s` in the shortcuts.
- Routes, all lazy-loaded:
  - `/skills` (skills),
  - `/skills/plugins`,
  - `/skills/marketplaces`.
- `SkillsHeader` follows `TemplatesHeader`: the h1 "Skills", a `SegmentedLinks` switch "Skills | Plugins | Marketplaces", and the actions "Check for updates" (ghost) and "Add skill" or "Add marketplace" (on the matching view; ghost with an icon, icon-only below sm).
- Loaders prefetch `libraryQueryOptions` and `hostQueryOptions` (I6), without awaiting the host one.

### 10.2 Lists

- Lists use the Templates row anatomy (`of-row`, `min-h-11`, container queries) in a `ul` with dividers. Rows are links that open the peek.
- **Skill row:**
  - name (mono), then the description (muted, `truncate`, hidden first below the 60rem container);
  - a meta line: source tag ("Host" / "Folder" / "GitHub" / "Template" plus the mono template name), the pin (a mono short sha, GitHub only) and "Used by 3 templates · 2 agents" or "Not used";
  - the state at the end, as a word plus an icon: "Update available", "Missing", "Hidden", "Unusable".
- **Order:**
  - registered and host skills by name;
  - then a group "Template skills" (the heading is a small muted label, not a heading level), grouped by template;
  - a list never reorders while it is hovered (DESIGN.md Live lists).
- **Plugin row:** `name@mkt` (mono), the version (mono, muted), and the contents line with hooks first and zero kinds omitted ("2 hooks · 1 MCP server · 4 skills"; Q14). Then the users and the state:
  - "Not installed";
  - "Not pinned" (Q9, with an icon; plain row);
  - "Installing…" (with a spinner);
  - "Install failed";
  - "Update available".
  
  Three groups with small labels: "In the factory", "On this host", "In marketplaces, not installed". Empty groups are omitted.
- **Marketplace row:** name (mono), a source line (the repo, a URL host or a path, mono and middle-truncated), the pin, "4 plugins installed", and the state.
- **Empty states** are one muted line:
  - "No skills yet. Add one, or put a folder in ~/.claude/skills.";
  - "No marketplaces yet. Add one to install plugins."
- **Loading** shows static skeleton rows at the real heights.

### 10.3 Peeks

A right peek sheet (480px, no scrim; a bottom drawer below md), one per kind. Opening one from a list with the keyboard keeps focus in the list, so `j`/`k` retarget it. Its sections are separated by spacing and rules, never cards inside cards.

- **Skill peek:**
  - title = the name (mono), then the description;
  - **Source:** kind, path or repo (`overflow-wrap: anywhere`), branch, the pin with its date and subject, "Live" for host and folder;
  - **Used by:** links to templates and agents;
  - actions in the footer (ghost, except the primary update): Check for updates, Update…, Find more skills, Fetch again, Remove (crimson ghost).
  
  The update view expands in place under Source: the commit line, the compare link and the skill changes list, with "Update to e4f5a6b" as the primary action. A refusal (409 `update_drops_used`) shows in the outcome line.
- **Plugin peek (Q15):**
  - a header: `name@mkt`, the version and the description;
  - **Runs code**, the first section, always shown. It holds:
    - hooks as rows of the event (Geist), the matcher (mono) and the command (mono, wrapping, untrusted text), each with **View file** when it references a plugin file;
    - MCP servers with the kind, and the full command and args or the full URL;
    - LSP servers, status line, executables;
    - "This plugin has parts Open Factory can't show: …".
    
    The section never collapses. With nothing in it, it reads "Runs no hooks or servers."
  - **Provides:** skills, commands and agents by name, in wrapping mono runs. Past 20 per kind: "Show all 34", which expands in place.
  - **Provenance:** marketplace, its source and pin (or "Local folder, live"), the installed version, the gitCommitSha (mono, short, with the full value in its tooltip), installed by and when, and "Not pinned by its marketplace, installed at <sha7>" when that applies.
  - **Used by.**
  - Footer: Install / Use in factory / Update… / Uninstall, as they apply.
  - **View file** opens the file text in place below its hook row, inside a plate with a rule. It uses the tool-output clamp (last 12 lines, then "Show all") and never syntax colour. The "Close file" action returns focus to View file.
- **Marketplace peek:** the source, the pin, the update view (Q10: "Plugins in use that change: x@y 1.2.0 → 1.3.0, z@y source changes"), its plugins (each opens its peek in place, with Back) and Remove.

All of this text is untrusted: rendered as text, never as markdown, never linkified. The only links are the compare link and links to factory routes.

### 10.4 Add sheets

Both use `FormFrame`, I4's `useFieldErrors`, `FormOutcome` and `field-stack`.

- **Add skill:**
  - **Source:** a segmented control, Folder | GitHub.
  - **Folder:** Path (`PathField`, help "A skill folder, or a folder of skills, on the factory's machine.").
  - **GitHub:**
    - Repository, help "owner/repo or a github.com URL. Private repos use this host's git sign-in.";
    - Path (optional), help "The folder inside the repo. Empty means the whole repo.";
    - Branch (optional), help "Empty means the default branch. Submodules and LFS files aren't fetched."
  - **Step 1, "Find skills"** (primary; "Finding…" with a spinner):
    - Errors land on their fields: the repo can't be reached, no branch, larger than 50 MB, path outside the repo.
    - Success replaces nothing above it. It reveals, below the fields, the pin line "Pinned to a1b2c3d · main · 2 days ago · <subject>" (GitHub) and a **checkbox list**:
      - each found skill as name (mono) and description;
      - all pickable ones checked;
      - unpickable ones disabled with their reason ("Name taken by GitHub acme/x", "SKILL.md names it y", "Skipped: a link");
      - a "Select all / none" ghost action in the list's label row.
    - Editing any source field afterwards clears the result and returns the action to "Find skills".
  - **Step 2:** the primary becomes "Add 3 skills" (disabled at 0: "Pick at least one skill."). Success closes the sheet with a toast, "Added 3 skills.", with Undo (the control is gone, DESIGN.md Toasts).
  - **Phone:** the list scrolls inside the drawer body, and the buttons are full-width and stacked.
- **Add marketplace:**
  - Source: GitHub | Git URL | Folder;
  - the matching field;
  - one step, "Add marketplace" ("Adding…"; it can take up to 4 minutes, and the note says "Cloning can take a minute.");
  - the outcome toast: "Added acme, pinned to a1b2c3d."

### 10.5 Pickers in the Configuration form (replaces I2 §12.2's "Skills and plugins")

- **Skills.** "Add skill" is a `Combobox` (DESIGN.md Combobox), with a filter field at a fixed height. Options are grouped by source (Host, Folders, GitHub), each showing the name (mono), the description (muted, one line) and the source tag. Enter or a click adds the option and keeps the popover open for the next pick; Esc closes it.
  - Left out: hidden, unusable and already-selected skills, and Library skills that share a name with this template's local ones.
  - Selected rows are I2 `ConfigList` rows with the source tag and pin appended ("GitHub · a1b2c3d"; Q16).
  - Template-local skills stay read-only, as "Template skill".
- **Plugins.** The same Combobox over **store** plugins only (Q7).
  - Each option shows `name@mkt`, the version and the contents line.
  - Template mode lists every store plugin, with the footer link "Install more in Skills".
  - Agent mode lists only plugins from the template's declared marketplaces, with the footer "Only plugins from dev's marketplaces. Add more in the template." (Q16).
  - Selected rows show the contents line and **View**, which opens the plugin peek over the page. A peek, not a stacked sheet, so the form's draft stays put.
- Picking writes the draft (§7.4). Agent mode keeps I2's "From template dev" and "This agent" groups.
- The Combobox's option list is virtualised past 100 options. Options are keyed by name; the filter is a pure function over the loaded list.

### 10.6 States and motion

- Peeks, Find results, update views and View file appear instantly. Sheets and drawers use the standard motion.
- The only spinners are next to "Finding…", "Adding…", "Installing…", "Checking…" and "Updating…".
- Nothing on these pages animates beyond DESIGN.md's defaults. Every layout works at 390px and at 200% text with no horizontal scroll: long paths, URLs and commands wrap with `overflow-wrap: anywhere`.

## 11. Security summary

### 11.1 Who can change what
- Humans, through REST and UI sessions, are the only writers of skill sources, the registry and the store (Q5). Library routes take no agent token, and the MCP server registers no Library tool. A route test asserts that an agent bearer token gets 401.
- Agents can only reference Library entries, through overlays that a human (or, from I7, a `manage_org` agent) saves, and only from their template's marketplaces.

### 11.2 Supply chain
- Pinned: GitHub skills to a verified commit; marketplaces to a verified, enforced commit.
- Plugins: those with pinned sources install automatically; unpinned ones only on a human click, with "Not pinned" shown.
- Nothing auto-updates. Updates show what changes first: the skill diff, the contents diff, and the plugins in use that change.
- Provenance is shown everywhere: source, pin, version and gitCommitSha.
- No tokens in URLs: input refuses userinfo, logs and events carry only redacted output, and rows store credential-free URLs.
- Hardened runners for `git` and `claude plugin`:
  - an empty temp cwd;
  - an env allowlist;
  - protocol allowlist;
  - no hooks, symlinks, submodules or LFS;
  - budgets;
  - redaction.

### 11.3 Mounts and links
- Skill mounts are real folders only, read-only, never the home or state dirs (I2's rule). Two new exact-location classes, each with a full `lstat` walk.
- Folder sources are refused at add and again at every start.
- GitHub checkouts have no symlinks (`core.symlinks=false`) and are non-writable.
- The store is read-only (Docker) and non-writable between locked operations (local; an accident guard only).
- Hooks and mounts stay unsettable by agents (I2). A plugin's hooks reach an agent only through a human-approved template marketplace and a human-installed or pinned plugin.

### 11.4 Residual risk, stated
- Local-runtime agents run as the host user. They can chmod and write the store and the cache, and edit `state/`. This is the accepted local trust decision (S5 Q10), not a new hole.
- A plugin pinned only by its marketplace commit can still pull code at install from an external source that has a `sha`. That code is fixed by the sha.

## 12. Data model and reset

These are generated Drizzle migrations only (ADR 0028):
- the new tables `skill_sources` and `marketplaces` (PR 1 adds `skill_sources`; PR 2 adds `marketplaces`).

There is no change to `agents` or `templates` columns: overlays and `last_valid` docs simply stop holding `plugins`.

**Reset step**, stated in each PR and in the plan: drop the database and recreate agents.
- PR 1: a template whose `skills:` names a host skill keeps working.
- PR 2: templates listing `plugins:` fail validation ("Unknown field."). Move them to `enabledPlugins` in `settings.json`, register their marketplaces in Skills, and recreate agents.
- Old `state/agents/<slug>/plugins-config/` folders are left alone, never read and never deleted.
- `FACTORY_HOST_SKILLS_DIR` in a `.env` is now ignored. Boot logs a warning naming `FACTORY_HOST_CLAUDE_DIR`: a one-line notice, not a compatibility path.

## 13. Gate G1: real Claude Code checks (Or, before PR 2's implementation)

G1 needs real Claude Code, which the design team must not run. Most of §7 now rests on documented behaviour (the seed, auto-update switches, install refresh, `ref` SHAs, in-place directory plugins; code.claude.com/docs/en/plugins/org and /plugins/loading, read 2026-11-23). G1 confirms it on the version the base image ships, because the facts came from docs, not runs. If item 1 or 2 fails, §7.2–§7.3 change before PR 2 starts, and the change goes back to owner-i5. It blocks PR 2, not PR 1.

Use a scratch dir (never `~/.open-factory-spike`), any credential, and record `claude --version`.

```sh
S=$(mktemp -d); SEED=$S/seed; RUN=$S/runner; AG=$S/agent; EMPTY=$S/empty; W=$S/work
mkdir -p $SEED $RUN $AG $EMPTY $W
export DISABLE_AUTOUPDATER=1
# Build the seed (the store) the way §7.2 does.
CLAUDE_CONFIG_DIR=$RUN CLAUDE_CODE_PLUGIN_CACHE_DIR=$SEED claude plugin marketplace add anthropics/claude-plugins-official
H0=$(git -C $SEED/marketplaces/claude-plugins-official rev-parse HEAD)
CLAUDE_CONFIG_DIR=$RUN CLAUDE_CODE_PLUGIN_CACHE_DIR=$SEED CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  claude plugin install frontend-design@claude-plugins-official
CLAUDE_CONFIG_DIR=$RUN CLAUDE_CODE_PLUGIN_CACHE_DIR=$SEED CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  claude plugin install skill-creator@claude-plugins-official
git -C $SEED/marketplaces/claude-plugins-official rev-parse HEAD   # item 3: must equal $H0
echo '{}' > $SEED/provenance.json
# The agent: an empty read-only plugins dir, the seed read-only, one plugin enabled.
ln -s $EMPTY $AG/plugins; chmod -R a-w $SEED $EMPTY
cat > $AG/settings.json <<EOF
{"enabledPlugins":{"frontend-design@claude-plugins-official":true,"skill-creator@claude-plugins-official":false},
 "extraKnownMarketplaces":{"claude-plugins-official":{"source":{"source":"github","repo":"anthropics/claude-plugins-official","ref":"$H0"},"autoUpdate":false}}}
EOF
touch $S/t0
(cd $W && CLAUDE_CONFIG_DIR=$AG CLAUDE_CODE_PLUGIN_SEED_DIR=$SEED claude -p --output-format stream-json --verbose "say ok" | head -1) > $S/init.json
find $SEED $EMPTY -newer $S/t0 | head                              # item 2: must be empty
```

Record these items:
1. `init.json`'s `plugins` lists `frontend-design`, with a `path` under `$SEED/cache/…`, and not `skill-creator`. Repeat with the `skill-creator` entry deleted from `enabledPlugins` (no explicit `false`): is it still absent? (Seed plugins "aren't enabled on their own".)
2. The run succeeds with the seed and `$EMPTY` read-only, and `find` lists nothing. Note any warning in stderr.
3. HEAD is unchanged across the two installs with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Then repeat one install without it and note whether HEAD moves (it should: the docs say the install refreshes).
4. The `ref` with a 40-hex SHA is accepted in `extraKnownMarketplaces` (no re-fetch and no error in stderr). `claude --version` is at least 2.1.324.
5. Skill naming: in `$W/.claude/skills/foo/SKILL.md`, set the frontmatter `name: bar`. Which of `/foo` and `/bar` appear in `init.json`'s `slash_commands`? (§5.2 refuses mismatches either way; this records the fact.)
6. Inside the agent (`CLAUDE_CONFIG_DIR=$AG`), run `claude plugin install skill-creator@claude-plugins-official`. It must fail, because `$EMPTY` is read-only, and a following `-p` run must still not list it.

## 14. Testing and evidence

**Unit (shared):**
- the `library.ts` schemas;
- the `enabledPlugins` rules (`true` only, key shape);
- the `describeChanges` library lines and the summary counts;
- repo, subpath and branch input normalisation (good and bad cases, including userinfo, `..`, SSH and other hosts).

**Server.** DB tests run only in CI, because the local Postgres role is unavailable.
- **`git-fetch`** against a fixture repo created in the test (`git init`, commits, a symlink, a gitlink, a 51 MB blob; served through `file://` with `FACTORY_GITHUB_URL`):
  - resolve a branch and HEAD;
  - verify HEAD equals the sha (a fake that returns another commit fails closed);
  - a symlink arrives as a file;
  - a gitlink arrives as an empty folder;
  - the size cap;
  - a subpath escape is refused;
  - the checkout is read-only;
  - the env and the `-c` flags are exactly as listed (a fake `git` on `PATH` records argv and env; the host's `GIT_*` variables don't pass);
  - errors are redacted.
- **`LibraryIndex`:**
  - host discovery (skips `.zip`, non-skill folders);
  - hidden and unusable states;
  - registered names win;
  - "Missing";
  - `usedBy` from templates and overlays.
- **Sources service:**
  - add refuses taken names;
  - folder forbidden set: `~`, an ancestor of home, under `FACTORY_HOME`;
  - Find more;
  - update refused when it drops a used skill;
  - Undo within the window and refused after it;
  - the purge removes the cache.
- **Links and mounts:** §6.5's list, and the drop-unlisted pass across every prefix.
- **`validateEffective`:**
  - each new skill message;
  - the template-local collision for templates and overlays;
  - `enabledPlugins` false, an undeclared or unregistered marketplace, a source mismatch, and an overlay plugin from a non-template marketplace;
  - the unpinned, not-installed warning.
- **`PluginStore`** with fake Claude (extended: `marketplace add` writes `known_marketplaces.json` and a git clone of a fixture marketplace; `install` writes `installed_plugins.json` and a cache dir; a scenario "pulls the marketplace"):
  - installs once for three spawns (AC 9);
  - a start installs a pinned missing plugin;
  - a start refuses an unpinned missing one;
  - pin drift fails closed, and so does an install that pulled (with rollback);
  - the store is non-writable between operations;
  - the lock serialises concurrent installs;
  - provenance is recorded;
  - redaction.
- **Settings:** `buildSettings` writes `enabledPlugins`, the registry's `extraKnownMarketplaces` and the auto-update-off keys, and drops nothing else from I2's rules.
- **Contents:**
  - hooks inline and from a file;
  - MCP stdio and http with header names only;
  - LSP, statusLine and `bin/`;
  - unknown keys listed;
  - link refusal and size caps;
  - View file refuses a path not referenced and a symlink.
- **Change flow:** a GitHub update writes "skill x updated …" and restarts only the agents using it; a plugin update does the same.
- **Routes:** every Library route returns 401 to an agent token and 401 without a session.

**Web** (each task with `vercel-react-best-practices`):
- `SkillsHeader` views;
- rows (states, "Not used", contents line with zero kinds omitted, source tags);
- the Add skill two-step: field errors, editing a field clears results, disabled rows with reasons, "Add 3 skills" count, toast with Undo;
- Add marketplace;
- the peeks: the Runs code section first, View file clamp, the update view, the 409 refusal line;
- the Combobox pickers: grouping, exclusions, multi-pick keeps open, agent-mode marketplace limit and footer copy;
- `library_changed` invalidation.

**Evidence pass** (the plan's last tasks):
- In a real browser, Chromium and WebKit headless, through the U4 harness's `run.sh` lock. Fake Claude only. GitHub fetches go to a local fixture repo through `FACTORY_GITHUB_URL=file://…`. At most one heavy job at a time, on `/tmp/of-v002-heavy.lock`.
- The three Skills views, the peeks and the add sheets at 1440, 1024 and 390px, and at 200% text. Worst-case data:
  - a 40-skill GitHub source;
  - a plugin with 12 hooks and long commands;
  - a 120-character path;
  - a template named `platform-infrastructure-reviewer`.
- Acceptance flows 1–5 and 8–12 end to end.

## 15. Web conventions for the plan

- Every task that touches `apps/web` says: "Implementer and reviewer invoke `vercel-react-best-practices` and follow it."
- The final review task checks the React diff against it. Next-only rules are skipped, with a note.
- Data comes from TanStack Query: `libraryQueryOptions`, `pluginQueryOptions(key)`, `sourceQueryOptions(id)`.
  - Route loaders prefetch.
  - No effects fetch, and no derived state is held in effects.
  - Peeks render from the list's cached row first and refine from the detail query.

## 16. DESIGN.md amendments

1. **Navigation:** "Nav order: Inbox, Tasks, Templates, Skills, Schedules, Usage, Settings, then Agents."
2. **Components, Provenance:** "Anything fetched from outside the factory shows where it came from and what it is pinned to: source, a short commit in mono (full in its tooltip), and 'Live' for host and folder sources. Updates are never automatic; an update view shows what changes before its action."
3. **Components, Untrusted code text:** "A third-party command, hook or file is shown in full as mono text that wraps, never as markdown or links, under 'Runs code' first; file text uses the tool-output clamp."
4. **Components, Multi-pick Combobox:** "A picker that adds to a list keeps its popover open after each pick, leaves out what is already picked, and shows a footer line when its options are limited by a rule."

## 17. Delivery

Three stacked PRs on I3's last branch, in a line: `i5/1-library-skills` → `i5/2-plugins` → `i5/3-polish-docs`. Each links this spec, the plan and the decision issue, states its reset step, and deletes what it replaces (Q12).

1. **`i5/1-library-skills`:**
   - §5, §6, §8.1–§8.4 (skills parts), §9.1–§9.2, §9.4–§9.6, §10.1–§10.4 for skills, and §10.5 for skills;
   - `FACTORY_HOST_CLAUDE_DIR`;
   - `/api/host-skills` deleted;
   - DESIGN.md amendments 1, 2 and 4.
2. **`i5/2-plugins`:**
   - §7, the plugin parts of §8–§10, and §11;
   - `plugins:`, per-agent installs and `plugins-config/` deleted;
   - DESIGN.md amendment 3.
   
   Starts only after G1 (§13).
3. **`i5/3-polish-docs`:** the evidence pass fixes and the product docs listed in §18. Folded into PR 2 if small.

## 18. Product docs to update (a list for the lead; docs/product is never edited here)

- **Agent template:** the `skills` field (Library names), `plugins` removed, `enabledPlugins` and `extraKnownMarketplaces` (copied from the registry), validation messages, and the Instantiation paragraph on skills and plugins.
- **Workspace:** the layout (`state/plugins/`, `state/library/github/`, no `plugins-config/`); Host skills becomes Library skills; plugins installed once into the store; the auto-update stance; the mount classes; residual local risk.
- **Administration:** a new **Skills** section (three views, add, peeks, updates, removal) and the Templates bullets about skills and plugins.
- **ADR 0017:** a note that skills resolve through the Library.
- **ADR 0024:** consequences, I5 specifics: Q5 S2 kept, Q7 Use in factory, Q9 unpinned plugins.
- **Data model:** the two tables.
- **Agent runtime / base image:** the auto-update env.
- **I6 path help:** the I5 fields now exist. README: `FACTORY_HOST_CLAUDE_DIR` replaces `FACTORY_HOST_SKILLS_DIR`.
- **Factory MCP (I7 note):** Library tools are read-only and assign by name.

## 19. Reviews

The reviews are self-review, Taste, Apple design, Emil design-eng and Break UI. Their outcomes are recorded in the decision issue, and this section lists what changed after them.

## 20. Decisions

Certainty is on a 1–5 scale. **Bold** marks the ones for Or's review.

| # | Decision | Certainty |
|---|---|---|
| Q1 | Library in two DB tables (skill sources, marketplaces). Host and template-local are live; pins are columns | 4 |
| Q2 | `skills: [name]` in one factory-wide namespace | 4 |
| Q3 | No aliases. Taken names are refused; registered entries beat later host skills ("Hidden"); a frontmatter name mismatch makes an entry unusable | **3** |
| Q4 | `enabledPlugins` is the truth; `plugins:` deleted; `false` is an error everywhere (amends I2 S1) | 4 |
| Q5 | The registry is the runtime truth for sources; templates carry validated copies; overlays only from template marketplaces (I2 S2 kept); only humans write the Library | 4, **flagged** (overrode the tech-lead's loosening) |
| Q6 | One factory-owned store, read-only to agents, non-writable between ops; install on save, Library or start; create and spawn never install; auto-update off | 4; **3** on local read-only and Claude's startup writes (G1) |
| Q7 | Host plugins show their host contents; Use in factory registers and installs; pickers list store plugins only | **3** |
| Q8 | git CLI, hardened; host credentials only; HEAD verified; no submodules or LFS; 50 MB; read-only | 4 |
| Q9 | Never fetch silently: unpinned plugins only on a click; the marketplace pin is enforced at install and start | **3** |
| Q10 | Human updates with a contents diff; no per-template pins; no GC | 4 |
| Q11 | `FACTORY_HOST_CLAUDE_DIR` replaces `FACTORY_HOST_SKILLS_DIR` | 4 |
| Q12 | Three stacked PRs, each with its UI; reset step and deletions in the same PR | **3** |
| Q13 | Skills page with Skills, Plugins and Marketplaces views; peeks; create sheets | 4 |
| Q14 | Row anatomy, states, "Not used", hooks first, zero kinds omitted | 4 |
| Q15 | Full hooks and MCP commands; every code-running part; unknown parts named; View file for plugin scripts | 4; **3** on View file |
| Q16 | Combobox pickers, no confirm; agent mode limited to template marketplaces; source and pin on rows | 4 |
| Q17 | Add skill in two steps (Find, then pick); one source, one pin; inline redacted errors | 4 |
| Q18 | Update views list changes, with a compare link; check-all with 4 at once; refuse updates that drop used entries; removal refused when used, else Undo | 4; **3** on refusing updates |
| Q19 | Folder sources keep a fixed picked set; edits show live; new folders come only through Find more skills | 4 |
| Q20 | A Library skill named like a template-local skill is an error when listed (template or overlay); otherwise it is hidden in that template's picker | 4 |

Tech-lead decisions (sent to owner-i5 for confirmation):

| # | Decision | Certainty |
|---|---|---|
| T1 | Provenance lives in a factory-written sidecar, `state/plugins/provenance.json`, beside Claude's own `installed_plugins.json`, not in a DB table, so the store stays the one truth of what is installed | 4 |
| T2 | A marketplace Update checks out the reviewed commit with `runGit` (fetch, then `checkout --detach <sha>`) rather than `claude plugin marketplace update`, which would pull the branch head instead of the commit the human saw | 4 |
| T3 | The store is made writable only inside the store lock and made non-writable again in a `finally` | 4 |
| T4 | Removal is a soft delete with a 30 s Undo. The cache and `marketplace remove` are purged after the window | 4 |
| T5 | One `library_changed` WS frame for every Library change; host and template-local lists refresh on focus | 4 |
| T6 | Lock order is workspace lock, then store lock. A save's install runs in the background, never awaited by the request | 5 |
| T7 | The plugin update preview installs the new version into a throwaway config dir, diffs its contents against the store copy, then discards it | 3 |
| T8 | Uninstalling a plugin has no Undo (reinstalling fetches again), so it gets a confirm dialog, the one irreversible action here | 4 |
| T9 | A symlinked subfolder inside a folder source is listed as "Skipped: a link" and can't be picked | 4 |

## 21. Follow-ups (separate issues)

- Per-source GitHub tokens for private repos (Q8 B).
- Garbage collection of old plugin versions and GitHub checkouts.
- Aliases, if a real collision shows up (Q3).
- npm-sourced plugins.
- Revisit whether agents may add plugins from any registered marketplace (Q5), raised with Or.
