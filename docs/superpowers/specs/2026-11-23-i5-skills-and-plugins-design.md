# I5 Skills and plugins: Technical Design

- **Task spec** (gitignored; read it in the main checkout): `docs/product/roadmap/v0.0.2/i5-skills-and-plugins.md`.
- **Decision:** ADR 0024. Amends ADR 0017. Pre-release rules: ADR 0028 (no compatibility code, no data migration).
- **Builds on:** I2 (overlay, merge, `validateEffective`, the change flow, ConfigForm, `FACTORY_ENV_NAMES`), I6 (`PathField`, `resolveHostFolder`), I4 (form errors) and U4 (sheets, drawers, peeks). I3 sits between I2 and I5 in the stack and is untouched, but its claude.ai sign-in is why §7.7 turns synced plugins off.
- **Consumers:** I7. Its `manage_org` tools read the Library and assign entries by name; they never write it (§11.1).
- **Decision log:** the GitHub issue "I5: Skills and plugins — design".
  - Q1–Q21 and R1–R10 are the owner-proxy's (owner-i5) answers.
  - T1–T9 are tech-lead choices, which the proxy confirmed or changed.
  - Certainties and the items flagged for Or are in §20.
- **Reviews:** self-review, Taste, Apple design, Emil design-eng and Break UI. What they changed is in §19.

**Words.**
- "Library" means the factory's skills, plugins and marketplaces together. It is a word for **code and docs only**; the page and every user-facing message say "Skills" (R5).
- "Store" means the shared plugin store, a Claude Code seed (§7.2).
- "Source" means a registered folder or GitHub source of skills.

Web paths are relative to `apps/web/src/` unless they start with `apps/` or `packages/`.

## 1. Goal

Skills and plugins become things you can see, pick and reuse, instead of names typed into YAML and marketplaces declared by hand in `settings.json`.

- **Four skill sources:**
  - host global, live;
  - local folder, linked;
  - GitHub, pinned to a commit;
  - template-local.
- **Plugins** come from factory-wide **marketplaces**, each pinned to a commit.
- **The Skills page** shows each entry's contents and provenance, and who uses it.
- **Templates** pick a baseline from the Library, and persistent agents add on top (the I2 overlay).
- **One install per version.** Every plugin version is installed once into one factory-owned store that agents only read (closes #56).

### 1.1 Deviations from the task spec (owner-proxy approved; Or can overrule them in one pass)

- **Host-installed plugins aren't selectable as they are** (Q7). They are listed under "On this host", showing their host contents. **Install in factory** does two things: it registers their marketplace, copying the source from the host's own record, and it installs the plugin into the store. Only the store copy is selectable, because that is the code agents run. The task's acceptance criterion still holds: selecting the plugin writes `enabledPlugins` and `extraKnownMarketplaces`.
- **An agent's plugin additions are limited to its template's marketplaces** (Q5; I2 S2 is kept). Agents can still add skills from anywhere in the Library.
- **`plugins:` leaves `template.yaml` and the overlay** (Q4). `settings.json` `enabledPlugins` becomes the only source.
- **No name aliases** (Q3). A taken name is refused when you add the skill.
- **Unpinned plugins are never fetched automatically** (Q9). A plugin whose marketplace doesn't pin its source installs only when a human clicks Install in Skills.
- **An update that would drop a skill or plugin in use is refused** (Q18).
- **Skills that are really plugins are refused** (R3). Any folder that has `.claude-plugin/`, wherever it comes from, can't load as a skill, because Claude Code would load it as a plugin with hooks.
- **No uninstall in I5** (T8). Uninstalling joins version garbage collection in a follow-up.

## 2. Acceptance criteria

Each criterion names the PR that makes it true (§17).

1. (PR 1) A skill folder in the host's `~/.claude/skills` appears on the Skills page with no setup, showing its name, its description, the "Host" group and its users. When the folder is removed while a template lists it, the row stays as "Missing" with its users, and the template gets a validation error.
2. (PR 1) Adding a GitHub skill pins it to a commit:
   - "Find skills" shows "Found at a1b2c3d · main · …";
   - the source then reads "Pinned to a1b2c3d";
   - the checkout lands read-only in `state/library/github/<source>/<sha>/`.
   Tests and evidence fetch from a local fixture repo through `FACTORY_GITHUB_URL`, never from the network.
3. (PR 1) "Check for updates" shows the newer commit and lists the skills it adds, removes or changes, without applying anything. The update view shows the date and subject, and a compare link for GitHub. "Update" repins, and agents using the source restart when idle with the line "skill x updated a1b2c3d → e4f5a6b". An update that would drop a skill in use is refused, and the refusal names its users.
4. (PR 1) A local folder of skills is registered through `PathField`, with `~/` accepted. Edits inside a registered skill show live.
   - The folder is refused if it is the home directory, an ancestor of it, or anything under `FACTORY_HOME`.
   - At every start, a picked skill folder that has become a link, or holds `.claude-plugin/`, makes the skill "Unusable".
5. (PR 1) A template picks skills in its Configuration form:
   - a persistent agent shows them read-only under "From template dev";
   - the agent adds its own under "This agent";
   - template skills can't be removed per agent;
   - each row shows its source and pin.
6. (PR 1) In Docker, a GitHub skill and a folder skill are mounted read-only at their real paths, and the mount allow-check accepts exactly those paths. A symlink planted anywhere in the cache path is refused at start.
7. (PR 1) Any entry in an agent's `.claude/skills/` that holds `.claude-plugin/` fails the start with "skills/x is a plugin, so it can't load as a skill; move it away." This covers factory-linked entries and folders the agent wrote itself.
8. (PR 2) Adding a marketplace works like this:
   - it shows "Found at a1b2c3d" first and checks out exactly that commit;
   - a name that is taken or reserved is refused before the store is touched;
   - a start or install whose store clone isn't at the pin, or isn't clean, fails closed with "Marketplace acme isn't at its pinned commit."
9. (PR 2) Selecting a host-installed plugin for a template (after Install in factory) writes `enabledPlugins["name@mkt"]: true` and `extraKnownMarketplaces[mkt]`. The source is copied from the registry, which holds the host's record. Both entries are visible in the raw tab, and the agent starts with the plugin listed in its `system/init`.
10. (PR 2) Spawning three agents from a template with a plugin installs it at most once. Each `spawn_agent` returns without a plugin install, and fake Claude's plugin log shows one `install` (zero if the plugin was already in the store).
11. (PR 2) The plugin peek lists everything that runs:
    - every hook, with its event, matcher and full command;
    - every MCP server, with its full command and args, or its full URL;
    - dependencies;
    - every other code-running part;
    - "parts Open Factory can't show".
    Then it lists skills, commands and agents, and the provenance: marketplace, pin, version and gitCommitSha. A hook script inside the plugin opens from its first line with View file.
12. (PR 2) Nothing updates by itself:
    - the generated settings and env turn Claude Code's marketplace and plugin auto-update off, for agents and for store runs;
    - the store is a seed, so Claude never writes to it;
    - an agent's own `claude plugin install` doesn't survive a restart;
    - a plugin update shows its diff in place before "Update to 1.3.0".
13. (PR 2) An agent's own plugin, added from its template's marketplaces, is listed under "This agent". The agent picker offers no plugin from any other marketplace.
14. (PR 2) Every local-runtime agent started below the Claude Code version floor (§7.9) fails closed, and so do the store runner and Docker images below it.

## 3. Scope

**In:** the task spec's Scope and Tasks 1–5, the security rules in §11, and Gate G1 (§13).

**Out** (follow-ups in §21):
- a skill authoring studio, ratings or sharing;
- editing a template's `skills/` and `files/` in the UI (#36);
- npm, command, headersHelper and unpinned archive plugin sources (refused, §7.7);
- per-source GitHub tokens;
- uninstalling plugins, and garbage collection of old plugin versions and GitHub checkouts;
- removing a single skill from a source;
- aliases;
- per-template plugin version pins;
- I7's MCP tools (I7 wraps the read services in §9).

## 4. Inventory: today → after I5

Today means the I3 branch as specified. The I2 rows describe I2's design, because nothing from I2 or I3 is implemented yet.

| Area | Today (code, or the I2 design) | After I5 |
|---|---|---|
| Host Claude dir | `FACTORY_HOST_SKILLS_DIR` (`config.ts:80`, default `~/.claude/skills`), the README row, `.env.example`, 8 smoke scripts, `config.test.ts` | `FACTORY_HOST_CLAUDE_DIR` (default `~/.claude`). Skills are read from `<dir>/skills`, and host plugins from `<dir>/plugins` (read only). The old variable is deleted everywhere, with no warning or alias (Q11, ADR 0028) |
| Skill refs | `skills: [name]`, `hostSkillSchema`, resolved only against the host dir (`links.ts resolveHostSkills`; `validate.ts:158`) | Same field, resolved against the Library: host, folder, GitHub, plus the template's `skills/` (§5) |
| Template-local skills | I2: linked live from `realpath(<tpl>/skills)/<name>`, with a mount exemption (I2 §6.4) | Unchanged, plus the `.claude-plugin/` refusal. Listed in the Library under "Template skills" |
| Host skill list API | I2: `GET /api/host-skills` | Deleted in PR 1. Replaced by `GET /api/library/skills` |
| Plugins key | `template.yaml plugins: [name@mkt]` (`templates.ts:16,56,78`); overlay `template.plugins` (I2) | Deleted. `settings.json enabledPlugins` is the truth (Q4) |
| `enabledPlugins` | A warning, "ignored: list plugins in template.yaml" (`validate.ts:237`); derived at start from the per-agent install (`settings.ts buildSettings`) | The validated truth: `true` values only, and each marketplace must be declared and registered (§7.4). A factory-owned key in the generated file |
| Marketplaces | Declared by hand in the template's `extraKnownMarketplaces`, with types `directory`, `git` and `github`; `ref`/`path` refused (`validate.ts:191–216`) | A factory registry (the `marketplaces` table). Template entries are copies of the store's recorded source, validated against the registry (Q5). The `ref`/`path` refusal stays (R2) |
| Plugin install | Per agent at create and re-sync (I2: at start when missing), into `state/agents/<slug>/plugins-config/` (`workspace.ts install`, `plugins.ts installPlugins`) | Once per version into the store `state/plugins/`, a Claude Code seed, written only by the factory (§7.2). Deleted: `plugins-config/`, `readPluginKeys`, `pluginsConfigDir`, `linkPlugins`, and the plugin part of `materialize` |
| `.claude-config/plugins` | A symlink to the agent's own `plugins-config/plugins` | A real folder of the agent's own, scrubbed at every start down to `data/` (R1). Plugins load from the seed through `CLAUDE_CODE_PLUGIN_SEED_DIR` |
| Docker mounts | The agent's own plugins dir (ro); declared directory marketplaces (ro); host skill dirs (ro) (`mounts.ts`) | The store (ro); registered directory marketplaces of enabled plugins (ro); every resolved skill dir (ro). Two new exact-location classes, for the GitHub cache and the store (§6.5) |
| Change flow | I2 `describeChanges(ConfigDoc, ConfigDoc)`; restart check on `started.doc` | Both compare `{doc, library}` (§8) |
| UI | I2's combobox over host skills; plugins typed as text | The Skills page (Skills, Plugins, Marketplaces), add sheets, peeks and pickers (§10) |

**Verified on this host** (Claude Code's plugin dir, v2 format):
- `plugins/installed_plugins.json` is `{version: 2, plugins: {"name@mkt": [{scope, installPath, version, installedAt, lastUpdated, gitCommitSha, projectPath?}]}}`;
- `plugins/known_marketplaces.json` is `{name: {source, installLocation, lastUpdated}}`;
- code lives in `cache/<mkt>/<plugin>/<version>/`, and clones in `marketplaces/<name>/`;
- versions can be semver (`6.3.0`) or a 12-hex commit (`0120fb83da5d`);
- one key can have several installs.

**From Claude Code's docs** (code.claude.com/docs/en/plugins/org, /plugins/loading and /plugins/marketplace-reference, read 2026-11-23). Gate G1 (§13) confirms these on the shipped version; G1 still checks each one on the shipped version.
- **The seed** (`CLAUDE_CODE_PLUGIN_SEED_DIR`): "Claude Code never writes to the seed and forces `autoUpdate` off for seed marketplaces", "The plugins in a seed aren't enabled on their own", and it can be mounted at another path. `CLAUDE_CODE_PLUGIN_CACHE_DIR` builds one.
- **The plugins root** holds `data/<plugin-id>/` (`${CLAUDE_PLUGIN_DATA}`) and `mcpb/` (extracted MCP bundles).
- **Install refreshes.** `claude plugin install name@mkt` refreshes the marketplace first, unless `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set or a seed supplies the marketplace.
- **Auto-update** follows `autoUpdate` on the `extraKnownMarketplaces` entry, then the one in `known_marketplaces.json`, then a default that is on for official marketplaces. `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turn the whole pass off, unless `FORCE_AUTOUPDATE_PLUGINS=1`.
- **A declared marketplace whose source changed in settings is re-fetched.** A SHA `ref` is refused for reserved names such as `claude-plugins-official`.
- **`command`-source plugins** re-run their command once per session, whatever the auto-update settings.
- **Directory-marketplace plugins** with relative sources load in place.
- **Orphaned versions** are deleted 14 days later.
- **Skills-directory plugins.** A folder under `.claude/skills/` with `.claude-plugin/plugin.json` loads as `<name>@skills-dir`, following the manifest's `defaultEnabled`.
- **Synced plugins** (claude.ai) are on by default, and `syncClaudeAiPlugins: false` stops them.
- **Plugin dependencies.** A plugin can declare dependencies on other plugins.
- **Skill names.** A skill's name "defaults to the directory name", and the frontmatter `name` overrides it.
- An installed plugin with no `enabledPlugins` entry loads by default, following its manifest's `defaultEnabled` (marketplace-reference).
- Dependencies must be enabled, and a dependency with a `version` range resolves to the highest matching git tag (plugins/dependencies).
- A skills-directory plugin also loads from the user-level skills folder, which for an agent is `<workdir>/.claude-config/skills/`.

## 5. The Library model

### 5.1 Tables (Q1)

There are exactly two new tables. Host and template-local entries are discovered live and never stored.

```ts
// packages/db/src/schema/library.ts
skill_sources {
  id: uuid pk,
  kind: "folder" | "github",
  path: text null,          // folder: the realpath from resolveHostFolder
  repo: text null,          // github: "owner/repo", lower-cased
  subpath: text null,       // github: "" = repo root; normalised, no leading slash, no "." or ".." segments
  branch: text null,        // github: the branch name, resolved at add (the default branch is recorded by name, never null)
  commit: text null,        // github: the 40-hex pin
  committedAt: timestamptz null, subject: text null,
  trees: jsonb null,        // github: { [skill]: treeSha } at the pin, for "changed" (§6.3)
  updateCommit: text null, updateAt: timestamptz null, updateSubject: text null,
  checkedAt: timestamptz null, checkError: text null,  // the last Check for updates; checkError is the mapped one-line message
  skills: jsonb string[],   // the picked skill folder names (Q17, Q19), sorted, at least 1
  state: "adding" | "ready", startedAt: timestamptz,  // "adding" while a GitHub add re-fetches (§10.4); boot finishes or removes it
  addedBy: text, addedAt: timestamptz,
  deletedAt: timestamptz null,  // soft delete for Undo (§9.4)
}
marketplaces {
  name: text pk,            // the marketplace's own name, MARKETPLACE_PATTERN
  source: jsonb null,       // exactly the source Claude recorded in the store's known_marketplaces.json, set at step 5 of §7.1:
                            // {source:"github", repo} | {source:"git", url} | {source:"directory", path}; never a ref (R2)
  branch: text null,        // git/github: the branch resolved at preview; Check and fetches use it
  previewSource: jsonb, previewCommit: text null,  // what the human reviewed; used by boot repair
  commit: text null,        // the pin; null only for directory (live)
  committedAt, subject, updateCommit, updateAt, updateSubject, checkedAt, checkError,
  state: "adding" | "ready" | "failed", // "adding" while §7.1 runs; "failed" keeps the redacted reason for its peek (§10.2); boot repairs "adding" (R8)
  error: text null, startedAt: timestamptz,
  addedBy, addedAt, deletedAt,
}
```

- **Patterns** (`packages/shared/src/library.ts`):
  - `MARKETPLACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, excluding the names Claude Code never allows (`inline`, `skills-dir`, `synced`, `builtin`, `claude-plugin-test`). The official names Claude reserves for Anthropic sources (`claude-plugins-official` and the others in marketplace-reference, kept in one list, `OFFICIAL_MARKETPLACES`, with their sources) are allowed **only** with their matching Anthropic source, such as `{source: "github", repo: "anthropics/claude-plugins-official"}`; with any other source they are refused (final review H1);
  - `PLUGIN_REF_PATTERN`: a name of at most 64 characters, `@`, then a marketplace name. Today's `pluginRef` in `templates.ts` has no length limit; this replaces it.
- A pin is a set of columns, not a revisions table (Q1).
- Every Library skill name, from any source, must match `HOST_SKILL_PATTERN`; a folder that doesn't is unpickable with "Name has characters skills can't use." (zero-width and bidi characters can't hide in names).
- `skills` holds the picked set (Q19). Each name is unique across live sources (§5.2), which the service enforces under the Library lock.
- Git URLs are stored only in the validated form of §7.1, with no userinfo, query or fragment.

### 5.2 One namespace and its collisions (Q2, Q3, Q20)

Every skill visible to the factory has one **name**, its folder name.

- **Precedence.** Registered entries (folder, GitHub) are in the namespace. A host skill whose name a registered entry already uses shows as "Hidden: the name is used by acme/x" and doesn't resolve.
- **Uniqueness.** Adding a registered skill whose name is taken, whether by a live host skill or by another registered entry, is refused with the reason "Name taken by Host" (or "by acme/x"). There are no aliases.
- **Unusable.** A skill is unusable, and never resolves, when any of these holds:
  - its `SKILL.md` frontmatter `name` differs from the folder name. Claude Code uses the frontmatter name ("defaults to the directory name"), so the agent would see another name than the one templates list. The reason reads "SKILL.md names it y";
  - its folder holds `.claude-plugin/`. Claude would load it as a skills-directory plugin, hooks included (R3). The reason reads "It's a plugin; add it through a marketplace";
  - for folder sources, its picked subfolder is a link (T9). The reason reads "It's a link".

  A registered entry is refused when it is added or updated in any of these states. Live sources (host, folder, template) are checked again on every read and at every start.
- **Template-local skills** belong to their template only. It's an error when a template lists a Library skill named like one of its own `skills/` folders, and when an overlay adds one (Q20). A Library entry that merely shares a name with some template's local skill is fine, and that template's picker hides it.

`LibraryIndex.resolveSkill(name)` returns `{ name, dir: realpath, ref }`, where `ref` is `"host"`, `"folder"` or `"github:<sha>"`. It returns nothing when the name is missing, hidden or unusable.

### 5.3 Discovery (`apps/server/src/library/library-index.ts`)

`LibraryIndex.skills()` reads everything live on every call, with no watcher (like templates):

1. **Host.** The entries of `<FACTORY_HOST_CLAUDE_DIR>/skills` that are directories holding a `SKILL.md` and whose names match `HOST_SKILL_PATTERN`.
   - A top-level symlink is followed, as today, because the dir is the operator's own.
   - Other entries are skipped silently: `*.zip`, folders without `SKILL.md`.
2. **Folder sources.** For each live source and each picked name, the skill is at `path/<name>`, or at `path` itself for a one-skill source (§6.1).
   - Each one is `lstat`ed every time (R3, self-review M8).
   - If it's gone or has no `SKILL.md`, it is "Missing".
   - If it is a link or holds `.claude-plugin/`, it is "Unusable".
3. **GitHub sources.** `state/library/github/<id>/<commit>/<name>`, or the checkout root for a one-skill source. If the cache dir is missing, the skill is "Missing" with "Fetch again".
4. **Template-local.** The real folders under each valid template's `skills/`, grouped by template. Other templates can never resolve them.
5. **Referenced but unresolved.** Any name that a template's `last_valid` doc or an overlay lists, and that resolves nowhere, gets a synthetic row with the source "Unknown", the state "Missing" and its users. This is the only place that says who breaks when a host folder is deleted (Break B5).

**Frontmatter hooks** (R12). A Library skill's `SKILL.md` frontmatter `hooks` is parsed and listed in the skill's contents: event, matcher and the full command. The row shows "Runs hooks" and the update view diffs them.

**Description.** Read from the `SKILL.md` frontmatter with `O_NOFOLLOW`, at most 64 KB. The text is cut to 200 characters on a grapheme boundary (`Intl.Segmenter`) and ends in "…".

**Users** (`usedBy`):
- templates whose `last_valid` doc lists the name;
- agents whose effective skills include it: non-archived, non-terminated agents of those templates, plus overlays that list it.

It is computed in JS from the `templates` and `agents` rows.

## 6. Skills

### 6.1 Folder sources

- **Input.** A `PathField` (I6). The server runs `resolveHostFolder("path", input)`.
- **Folder check.** `checkSkillFolder(real)` shares one forbidden-set function with `checkMounts` (§6.5), so the two can't drift. It refuses:
  - `/`;
  - the host home (both `$HOME` and the user-db home) and its ancestors;
  - `FACTORY_HOME`, anything under it, and its ancestors;
  - a Docker socket and its ancestors.

  The field note reads "This folder can't be shared with agents.", with the reason after it: "It's your home folder." or "It's inside the factory's folder."
- **Shape:**
  - If `path/SKILL.md` exists, the source is **one skill** named `basename(path)`.
  - Otherwise each direct subfolder is a candidate:
    - with a `SKILL.md`, it is pickable;
    - a link, a folder holding `.claude-plugin/`, or a frontmatter mismatch is listed but unpickable, with its reason.
- **Live.** Edits inside a picked skill show at the agent's next read. Docker mounts the realpath.
- **New subfolders** appear only through **Find more skills** in the source peek (Q19).

### 6.2 GitHub fetch (`apps/server/src/library/git-fetch.ts`)

**Input** (validated in TS; `packages/shared/src/library.ts`):
- **Repository:** `owner/repo` or `https://github.com/owner/repo[.git]`, normalised to `owner/repo`. Each part matches `^[A-Za-z0-9_.-]{1,100}$` and is neither `.` nor `..`.
- **Path:** optional. Normalised; segments `.` and `..` are refused, and so is an absolute path.
- **Branch:** optional. The git ref-format rules are implemented in TS: no `..`, `@{`, control characters, `~^:?*[\`, leading `-` or `.lock` suffix. `git check-ref-format --branch` isn't used, because it expands `@{-1}`.

Anything else is refused with "Use owner/repo or a github.com URL.": other hosts, userinfo, `?`, `#`, SSH. The URL is `${FACTORY_GITHUB_URL}/${owner}/${repo}.git`. `FACTORY_GITHUB_URL` defaults to `https://github.com` and is an operator env var that tests and the evidence pass point at a fixture.

**Runner.** `runGit(args, { cwd })`:
- an empty temp cwd;
- the env is exactly `PATH` and the host `HOME`, plus `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_ASKPASS=` (empty) and `GIT_LFS_SKIP_SMUDGE=1`;
- 60 s per command and 180 s per operation;
- output goes through `redactOutput`, which moves to `apps/server/src/redact.ts` and is shared with plugins. The last 20 lines are kept, at most 4 KB.

Every command starts with:

```
-c protocol.allow=never -c protocol.https.allow=always [-c protocol.file.allow=always  // only when FACTORY_GITHUB_URL is file:]
-c core.symlinks=false -c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false
-c fetch.recurseSubmodules=false -c credential.interactive=false
```

**Resolve.** `git ls-remote <url> refs/heads/<branch>` (or `HEAD` plus `--symref HEAD`, to record the default branch's name). Only a line whose ref **equals** the requested ref counts; ls-remote's tail matching is never trusted. No match gives "No branch main in acme/x."

**Fetch.**
1. `git init -q <tmp>/co`
2. `git -C co fetch --depth 1 --no-tags <url> <sha>`
3. `git -C co checkout -q --detach FETCH_HEAD`
4. `rev-parse HEAD` must equal `<sha>`, or fail closed: "acme/x didn't return commit a1b2c3d."
5. `log -1 --format=%cI%x00%s` gives the date and subject.
6. `rev-parse <sha>:<path>` gives each candidate's tree sha, where `<path>` joins the subpath and the skill name with no leading slash (an empty subpath gives `<skill>`).

The only bound on the download itself is the operation's time budget, and the spec says so. After the download:
- the subpath must resolve inside `co`, lexically and by `realpath`;
- the checkout must be at most **50 MB**, counted with `lstat` and no following, else "acme/x is larger than 50 MB.";
- submodules and LFS objects are not fetched (a gitlink is an empty folder), and the help line says so.

**Store.**
- The subtree at the subpath, without `.git`, is copied into `state/library/github/<sourceId>/<sha>/` through a temp name and a rename. Then `chmod -R a-w` (dirs 0555, files 0444, executables 0555).
- **Previews** stage into `state/library/preview/<uuid>/`, keyed server-side to `{repo, subpath, branch, sha}`. The client only ever holds the uuid, which is validated as a uuid before any path join.
- Add moves the preview into place, or re-fetches when the hourly sweep has already removed it. Previews older than an hour are swept.

**Private repos** work only through the host's git credential helpers (Q8). An auth failure shows "Couldn't reach acme/x. If it's private, sign in to GitHub with git on this host."

### 6.3 Updates (Q18)

**Check** (`POST …/check`):
- Runs ls-remote on the recorded branch.
- When the commit differs, fetches it into a preview, which gives the date, subject, skill set and tree shas, and stores the `update*` columns. On failure it stores `checkError` instead.
- "Check for updates" in the page header checks every GitHub source and every git or GitHub marketplace, at most 4 at a time.
- Nothing ever checks automatically.

**Update view** (in the Source peek, §10.3):
- the line "a1b2c3d → e4f5a6b · 2 days ago · <subject>";
- a compare link, `https://github.com/<repo>/compare/<old>...<new>`, shown only when `FACTORY_GITHUB_URL` is the default;
- the changes to the picked skills, found by comparing `trees`:
  - "changed", with frontmatter `hooks` added or removed shown as `+`/`−` lines. A changed skill whose frontmatter hooks or executable files were added or changed is marked "Runs code changed" and listed first;
  - "removed";
  - "New in this commit, not added", for new folders, which are never picked automatically;
  - "Unusable at this commit", for a frontmatter mismatch or `.claude-plugin/`.

**Apply** (`POST …/update { commit }`, where `commit` must equal `updateCommit`):
- **Refused** when a picked skill is removed, or becomes unusable, at the new commit and is in use. The response is 409 `update_drops_used`: "Update would remove skill tdd, used by template dev, @ana and 188 more." At most three users are named.
- A removed skill that nobody uses is dropped from `skills`, and the update view names it.
- If that would leave `skills` empty, the update is refused: "This update removes every skill you picked. Remove the source instead."
- Otherwise the preview moves into the cache, and the pin, `trees` and `update*` are updated.
- §8.3 then runs, **after** the Library lock is released.

### 6.4 Linking and the skills-folder checks (`links.ts`)

- `resolveHostSkills` becomes `resolveSkills(names)`, built on `LibraryIndex.resolveSkill`. `resolveSkill` returns the reason when a name doesn't resolve, and the start fails with §6.6's message for that reason (missing, hidden, unusable, not added) as a `WorkspaceError`. The fix is `template` or `config`, chosen as in I2 §6.5.
- `syncLinks`' "drop unlisted links" pass removes only links that point under one of these: the host skills dir, a folder source path, the GitHub cache root, or the template `skills/` realpath. It never touches a non-link.
- Links point at the realpath.
- **The plugin check** (R3, R12) runs in `prepare` after linking. For **every** entry of `<workdir>/.claude/skills/`, whether a factory link, a link the agent made, or a folder the agent wrote, it `stat`s `<entry>/.claude-plugin`. `stat` follows the entry, as Claude Code does. If that exists, the start fails: "skills/x is a plugin, so it can't load as a skill; move it away."
- **The user-level skills folder** (R12). Agents run with `CLAUDE_CONFIG_DIR=<workdir>/.claude-config`, so `.claude-config/skills/` is their user-level skills folder, and skills-directory plugins load from there too. The factory never writes there, so `prepare` empties it through `SafeFs` at every start.

### 6.5 Docker mounts (`mounts.ts`)

`buildMounts` takes `skillPaths` (every resolved skill realpath, read-only) in place of `hostSkillPaths`, and `storeDir` in place of `pluginsDir`.

`checkMounts` keeps every refusal it has today, including the I2 template-skill exemption. It gains exactly two classes under `FACTORY_HOME`. Each is read-only only, uses parity targets, and must sit at an exact location with every component `lstat`ed from `<FH>/state` down as a directory, never a link:

1. **GitHub skill.** `real` equals `join(realpath(<FH>/state/library/github), <id>, <sha>[, <name>])`.
2. **The store.** `real` equals `realpath(<FH>/state/plugins)`.

Nothing else under `state/` is newly allowed. The refusal message becomes "… isn't this agent's workdir, a registered skill or the plugin store".

**Tests** (default layout, with `FACTORY_HOME` under `HOME`):
- a GitHub skill mounts;
- `state/library/github` replaced by a link to `~/.ssh` is refused;
- a `<sha>` dir replaced by a link to `state/agents/bob` is refused;
- `…/<id>` (one level up) is refused;
- `state/plugins/cache` and `state/` are refused;
- a folder source equal to `~` is refused at add **and** at start;
- a picked folder skill swapped for a link is "Unusable" and isn't mounted.

### 6.6 Validation

`validateEffective` (I2 §5.3) replaces "host skill exists" with these errors on `template.skills`, for templates and overlays:
- "Skill x hasn't been added in Skills."
- "Skill x is hidden: the name is used by acme/x."
- "Skill x is unusable: <reason>."
- "Skill x is missing from its folder."

The collision with template-local skills stays (§5.2).

## 7. Marketplaces and plugins (PR 2, except §7.3 step 3 and §7.10, which land in PR 1)

### 7.1 The registry

**Input** (Add marketplace, §10.4):
- GitHub: `owner/repo`, with the §6.2 rules;
- a git URL: `https://` only, with no userinfo, no `?` and no `#` (Claude reads `#` as a ref);
- a local folder: `PathField`, then `resolveHostFolder` and the §6.1 forbidden set.

**Add: a preview, then the add** (T2, R3). The name must be known before the store is touched.

1. **Preview** (`POST /api/library/marketplaces/preview`):
   - git and GitHub: `runGit` resolves the default branch's name and commit, fetches it into a preview (§6.2) and reads `.claude-plugin/marketplace.json` (`lstat`, at most 1 MB). The preview returns the name, the commit, its date and subject, and the plugin list, each with its pinned state (§7.5) or refused reason (§7.7);
   - a folder: the same, read in place.

   The name is refused here if it fails `MARKETPLACE_PATTERN`, is reserved for another source, or is **taken**. Taken means a `ready` or `adding` row, a soft-deleted row inside its Undo window, or an entry already in the store's `known_marketplaces.json`. A `failed` row isn't taken: a new add replaces it (final review M4).
2. **Add** (`POST /api/library/marketplaces { previewId }`):
   1. Under the Library lock, insert the row with `state: "adding"`, `previewSource`, `previewCommit` and `startedAt`. This reserves the name.
   2. Under `storeLock` (exclusive), check "taken" again against `known_marketplaces.json`. Then run `claude plugin marketplace add <arg>`.
   3. Check that `known_marketplaces.json` gained exactly the previewed name and nothing else.
   4. For git and GitHub, `runGit` checks out exactly the previewed commit in the clone:
      - it fetches from the **canonical https URL** (never the clone's `origin`, which Claude may have recorded as SSH);
      - for GitHub: `fetch --depth 1 <url> <sha>`. For a plain git server, which may refuse a by-sha want: `fetch --depth 1 <url> refs/heads/<branch>`, then `FETCH_HEAD` must equal the sha;
      - then `checkout --detach`, and verify HEAD and a clean tree.
   5. Set `source` to what Claude recorded, `commit`, `committedAt` and `subject` from the preview, `branch` from the preview, and the state to `ready`.

   **On any failure:** remove what this operation created. That is safe because step 2 proved the name was absent from the store. Then set the row to `failed` with its redacted `error`. A failed row shows in the list as "Couldn't add" (§10.2) until the human removes it or tries again; it isn't a registry entry and resolves nothing.
3. **Boot repair** (R8). Under `storeLock`, each row still `adding` is checked. If `known_marketplaces.json` has the name with a source that passes the §7.1 input rules, and the clone is at `previewCommit` and clean, the row completes. Otherwise the store entry is removed (step 2 guarantees this operation created it) and the row becomes `failed` ("The factory restarted while adding acme."). A half-added marketplace is never kept.

**Pin enforcement** (Q9.2, R2). `assertMarketplacePinned(name)` runs before every store install or update, after every one (to detect drift), and in every start's store check (§7.3). For git and GitHub marketplaces it requires:
- `rev-parse HEAD` in the clone equals `marketplaces.commit`;
- `git status --porcelain --ignored --untracked-files=all` is empty, because relative-path installs copy the working tree, ignored files included.

A violation fails closed: "Marketplace acme isn't at its pinned commit." The factory never re-adds or pulls to repair it. For a directory marketplace it is a no-op: those are live, and their provenance reads "Local folder, live". Relative-path plugins of a directory marketplace count as **pinned** for auto-install and as dependencies, because they are the operator's own files (§7.5). There is no `ref` anywhere (R2).

**Check and Update.**
- Check works as in §6.3.
- Update is a human click on the in-place update view (§10.3). The view lists the plugins **in use** that change: their marketplace entry's version, sha, source or dependencies change, **or** their relative path's tree changes (`rev-parse <old>:<path>` against `<new>:<path>`; self-review r2 M7).
- Apply, under `storeLock` (exclusive):
  1. fetch `<updateCommit>` from the canonical URL, as in step 4;
  2. `checkout --detach`;
  3. verify HEAD and a clean tree;
  4. update the pin.

  Claude's own `marketplace update` is never used, because it pulls the branch head rather than the reviewed commit (T2). The commit must equal `updateCommit`.

**Remove.**
- Refused (409, naming up to three users) while any template or overlay declares the marketplace or enables one of its plugins, or any installed plugin comes from it: "Plugins from acme are installed. Uninstalling plugins isn't available yet." Uninstall isn't in I5, so a marketplace with installed plugins stays until the GC follow-up.
- Otherwise it is a soft delete with Undo, as in §9.4. The purge runs under `storeLock` and checks "no installed plugin from it" again before `marketplace remove`.

**Who writes.** Only humans, through REST and the UI, write sources, the registry and the store (Q5). No MCP tool writes them, I7 included (§11.1).

### 7.2 The store is a Claude Code seed (`apps/server/src/library/plugin-store.ts`; Q6, Q21)

Claude Code documents a read-only plugin directory for containers and CI: the **seed** (code.claude.com/docs/en/plugins/org, "Seed containers and CI").
- "Claude Code registers the seed's marketplaces at startup and loads plugin caches from the seed in place, without cloning."
- "Claude Code never writes to the seed and forces `autoUpdate` off for seed marketplaces."
- "The plugins in a seed aren't enabled on their own."

The store is that seed, so the property that agents never write to the store rests on documented behaviour rather than on a symlink trick. G1 confirms it on the shipped version.

**Layout.** `FACTORY_HOME/state/plugins/` holds `known_marketplaces.json`, `installed_plugins.json`, `marketplaces/<name>/`, `cache/<mkt>/<plugin>/<version>/` and the factory's `provenance.json`.

**The only writer** is the factory, through `StoreRunner.run(args)`:
- It runs `claude plugin …` with `CLAUDE_CODE_PLUGIN_CACHE_DIR=<store>` and `CLAUDE_CONFIG_DIR=<FH>/state/plugins-runner/`. The factory owns `settings.json` there and writes it before each run. It holds `extraKnownMarketplaces` (with `autoUpdate: false`) matching exactly the marketplaces in the store's `known_marketplaces.json`, minus any name being removed. `adding`, `failed` and soft-deleted rows aren't declared, so Claude never auto-adds a declared-but-missing marketplace at its branch head. Nothing else goes in, and Claude's own additions are overwritten.
- The cwd is an empty temp dir.
- The env is exactly:
  - `PATH` and the host `HOME`;
  - `DISABLE_AUTOUPDATER=1`;
  - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` for `install` and `update`, so an install doesn't refresh the marketplace off its pin.
- Arguments starting with a dash are refused.
- 120 s per command and 240 s per operation.
- Output is redacted.

**Locks** (self-review r2 M5). `storeLock` is its own **read/write lock**, a separate instance from the workspace mutex (which is keyed by slug and would collide with an agent named `store`).
- Store operations (add, install, update, purge) take it **exclusively**. Building an update preview's copy takes it **shared** (§7.5).
- A start's store check (§7.3 step 4) takes it **shared** for the duration of the check, so it never sees the store mid-operation: writable, a moving checkout, or a half-written `installed_plugins.json`.

A shared hold can't cover Claude's own read of the seed after spawn. Operations are rare human acts, and each leaves the store consistent at the end; that residual window is stated.

**Writable only while locked** (T3):
- Each locked operation runs `chmod -R u+w`, then the work, then `chmod -R a-w` in a `finally`. That is O(files) per operation, stated as a cost.
- Boot re-applies `a-w`.
- A start whose store is writable (the root's mode has `w`) while it holds the shared lock fails: "The plugin store is writable; restart the factory." Under the shared lock no operation is running, so that is drift.
- Docker agents get a read-only mount.
- For local-runtime agents, which run as the same user, non-writable is an accident guard, not a boundary, and the docs say so (Q6.3, Q21).

**Orphans.** Claude marks a replaced version `.orphaned_at` and deletes it 14 days later, during a later plugin operation. Only store runs can do that. A process that has run for more than 14 days on an old version could lose its files. This is accepted: restarts happen far more often, and the change flow restarts every user of an updated plugin.

**Reading.**
- `installed()` parses `installed_plugins.json` and keeps entries whose `installPath` exists, has no `.orphaned_at` marker, and is inside `<store>/cache/` or inside a registered directory marketplace (relative-path plugins load in place). An entry that fails this is "missing", so the start check never passes for a version Claude has marked for deletion.
- `marketplaceIndex(name)` parses the clone's `marketplace.json` (`lstat`, 1 MB).

### 7.3 What a start does (`Workspace.prepare`)

1. **Version floor** (§7.9).
2. **Enabled set.**
   - `enabled` = the keys of the effective `settings.enabledPlugins` (§7.4).
   - `closure` = `enabled` plus their transitive dependencies, read from the installed plugins' manifests (R13).
3. **The agent's own folders** (R1, R12):
   - `.claude-config/plugins/` is a real folder. Through `SafeFs`, every entry is removed except `data/`, and `data/` is kept only when it is a real directory, not a link. `installed_plugins.json`, `known_marketplaces.json`, `cache/`, `marketplaces/` and `mcpb/` all go.
     - A `claude plugin install` the agent runs itself never survives a restart. Within a session, a headless agent has no `/reload-plugins` (G1 item 16).
     - `mcpb/` (extracted MCP bundle code) is scrubbed, so edited bundle code can't run as if it had been reviewed. G1 checks that Claude re-extracts it from the seed; if it doesn't, that goes back to owner-i5.
     - A link at `.claude-config/plugins` is removed as a link and replaced with a folder.
   - `.claude-config/skills/` is emptied (§6.4).
   - **Project and local settings** (R11). `prepare` reads `<workdir>/.claude/settings.json` and `<workdir>/.claude/settings.local.json` with `lstat`; a link at either path fails the start. The start also fails if either file sets a key in **`RESERVED_SETTINGS_KEYS`** (§7.10), naming the file and the key: "….claude/settings.local.json sets hooks, which agents can't set; remove it." The factory fails the start rather than strip the key, so it never silently rewrites the agent's file.
     - Claude Code ranks local and project settings above user settings, and object keys merge across levels, so this check is what actually enforces the rule.
     - Claude Code also reloads settings files live within a session. The check therefore bounds **persistence across restarts**, not what a running agent can do to itself in the meantime (§11.4).
   - **Agent-written skills, subagents and commands** (R12). Skill frontmatter and subagent frontmatter can both declare `hooks`, and subagents can declare `mcpServers` (code.claude.com/docs/en/skills, `hooks` field; /sub-agents, `hooks` and `mcpServers` fields).
     - The start fails on any `.claude/skills/` entry that isn't a factory link and whose `SKILL.md` frontmatter sets `hooks`: "skills/x declares hooks, which agents can't set; remove them."
     - It also fails on any `.claude/agents/*.md` whose frontmatter sets `hooks` or `mcpServers`. Template `files/` can't write under `.claude` (I2), so those files are always agent-written.
     - `.claude-config/agents/` and `.claude-config/commands/` are emptied, like `.claude-config/skills/`, because the factory never writes there.
     - Factory-linked Library and template skills may declare hooks. Those are human-registered and shown under "Runs code" (§10.3).
4. **Store check** (under `storeLock` **shared**):
   - the store isn't writable;
   - every marketplace of a plugin in `closure` is registered, `ready`, and passes `assertMarketplacePinned`;
   - every plugin in `closure` is in `installed()`.
5. **A plugin is missing.** Release the shared hold, take `storeLock` exclusively, **check again** (another start may have installed it), then:
   - **Pinned** (§7.5): install it, then recompute `closure` from the new manifests and repeat step 4. This holds a start slot for at most the 240 s budget, and other starts that need the store wait behind it (stated). A failure gives `AgentStartError("Plugin x@y didn't install.", fix)` with redacted output.
   - **Unpinned:** fail closed with "Plugin x@y isn't installed. Install it in Skills." and fix `library` (§8.4). Nothing is fetched without a human (Q9.1).
6. **Env.** The factory adds `CLAUDE_CODE_PLUGIN_SEED_DIR=<store>` and `DISABLE_AUTOUPDATER=1`. These names join I2's `FACTORY_ENV_NAMES`, so no template, overlay or secret can set them:
   - `CLAUDE_CODE_PLUGIN_SEED_DIR`, `CLAUDE_CODE_PLUGIN_CACHE_DIR`, `CLAUDE_CODE_PLUGIN_DIRS`;
   - `FORCE_AUTOUPDATE_PLUGINS`, `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES`;
   - `CLAUDE_CODE_SYNC_PLUGIN_INSTALL`.
7. **The factory-owned plugin keys** are passed as an **inline JSON string**, `--settings '<json>'`, built at each start. The file never lands in the workdir or in a mount, so Docker needs no new mount class (final review H2). The JSON holds no secrets. A copy is kept at `state/agents/<slug>/plugin-settings.json` for diagnosis only. Command-line settings outrank local, project and user settings (R11). `buildSettings` drops its `pluginKeys` input and no longer writes these keys into `.claude-config/settings.json`. The keys:
   - `enabledPlugins`:
     - `true` for `closure`;
     - an explicit `false` for every other plugin of **every marketplace in the store**, from both its catalog and what is installed, because the seed registers every one of them at startup and relative-path plugins load by `defaultEnabled` (R14);
     - `false` for the manifest name of any skills-directory plugin the factory knows of, as a second layer behind §6.4.

     These are generated, so Q4's "false is an error" doesn't apply.
   - `extraKnownMarketplaces`: **replaces** whatever the template declares. It holds the registry `source` plus `"autoUpdate": false` for each marketplace of a plugin in `closure`, and nothing else (R14). It is the exact source the seed recorded, so Claude sees no source change and doesn't re-fetch (R2).
   - `syncClaudeAiPlugins: false` (R3).
8. **Docker mounts:**
   - the store, read-only;
   - the registered **directory** marketplaces of plugins in `closure`, read-only, because their relative-path plugins load in place.

**Create and spawn never install.** `materialize` loses `install`, `rm(pluginsConfigDir)` and the plugin part of `TemplateSource`. `PluginInstallError` leaves `agent-service.ts` and `spawn-service.ts`, and so does `502 plugin_install_failed`.

### 7.4 `enabledPlugins` (Q4, Q5; amends I2 S1)

- **Shape.** `Record<string, true>`, with keys matching `PLUGIN_REF_PATTERN`.
  - `false` is an error in templates and overlays: "Remove the plugin instead of turning it off."
  - Any other value is an error.
  - `syncClaudeAiPlugins` in a template or overlay is an error: "The factory sets syncClaudeAiPlugins."
- **Template `settings.json`.** Each key's marketplace must be declared in `extraKnownMarketplaces` ("Marketplace acme isn't declared in settings.json."). **Every** declared marketplace, whether or not a plugin uses it, must also be added in Skills (R14) ("Marketplace acme hasn't been added. Add it in Skills.", with the action **Add from this template**, which opens Add marketplace prefilled), with the same source ("Marketplace acme's source differs from the one in Skills."). Sources compare as exact JSON. The `ref`/`path` refusal stays.
- **Overlay** (`settings.enabledPlugins`, unioned by I2's object merge). Each key's marketplace must be declared by the **template**: "Marketplace acme isn't declared by template dev." (I2 S2). `extraKnownMarketplaces` stays an error in overlays.
- **Refused sources.** A key whose marketplace entry uses a refused source (§7.7) is an error: "Plugin x@y uses a command source, which Open Factory doesn't install."
- **Not installed and not pinned.** That is a warning: "Plugin x@y isn't installed and isn't pinned; install it in Skills before agents start." A start fails closed anyway.
- **Schema.** `templateYamlSchema` and `overlayTemplateSchema` drop `plugins`, and `TemplateConfig.plugins` is deleted. Readers call `effectivePlugins(doc)`. The old "enabledPlugins is ignored" warning is deleted.
- **Form writes.** Selecting a plugin in template mode sets `enabledPlugins[key] = true` and `extraKnownMarketplaces[mkt] = registry.source`. Removing the last plugin of a marketplace leaves its declaration in place.

### 7.5 Install and update (`PluginStore`)

**Pinned** (R13) means one of:
- a relative path in a pinned marketplace;
- a relative path in a directory marketplace (the operator's own files);
- a `github`, `url` or `git-subdir` source with a `sha`;
- an `archive` with a `sha256`.

On top of that, every dependency must be pinned the same way, with **no version range**: a range resolves to "the highest git tag that satisfies this range", which can be off the pin. The **pre-install check** covers what can be known before the fetch: the marketplace entries and the `plugin.json` of relative-path plugins at the pin. An external plugin's own dependencies can only be checked **after** the install, by the post-install check.

**`install(key, by)`** (under `storeLock`, exclusive):
1. `assertMarketplacePinned` for the plugin's marketplace and for the marketplace of each dependency known so far. Each must be registered.
2. Refuse the sources in §7.7.
3. **Journal.** Write `state/plugins-journal.json`: a copy of `installed_plugins.json`, `known_marketplaces.json` and the list of cache dirs with their `.orphaned_at` markers. Boot finds a journal left behind by a crash and rolls back to it (self-review r2 m8).
4. `claude plugin install <key>`.
5. `assertMarketplacePinned` again, for every marketplace involved.
6. **Post-install check** (R13), against the expected set: the plugin plus its **transitive** dependencies, each pinned and from a registered marketplace, and no new marketplace. If the clone moved, anything unexpected appeared, or the closure fails the rule, roll back to the journal:
   - restore both JSON files;
   - remove the new cache dirs;
   - delete any `.orphaned_at` marker written during the operation (self-review r2 M4);
   - `checkout --detach <pin>`;
   - fail closed.
7. Write `provenance.json[key] = { marketplace, marketplaceCommit, installedBy, installedAt }` (T1). The version and gitCommitSha are read from `installed_plugins.json`, never copied. If the two disagree, the plugin shows "Provenance unknown".
8. Delete the journal, then publish `library_changed`.

**Triggers:**
- **Install**, clicked by a human in Skills;
- **Install in factory**, for a host plugin (§7.6);
- a template or overlay save that newly enables a **pinned**, missing plugin, enqueued in the background and never awaited;
- a start (§7.3).

Install state (`installing` | `failed`, with `since`) is kept in memory per key. A failed background install shows "Install failed" on the row, with the redacted reason in the peek, and writes the activity event `plugin_install_failed { key, by }` (T6). A save that worked therefore never silently leaves a plugin uninstalled. The state clears on restart, and the start check then speaks for it.

**Update** (Q10, T7, R9):
- **Offer.** The Plugins view shows "Update available" when the plugin's pinned marketplace entry differs from the installed one: in `version`, `sha` or source, or, for a relative-path plugin, in the tree at its path (`rev-parse <pin>:<path>` against the commit recorded at install). Relative entries often have no `version`, and their source never changes, so the tree comparison is what catches them (self-review r2 M7).
- **Preview** (`update-preview`, the human's click on "Update…", which shows "Preparing update…"):
  - Runs `StoreRunner` against a **separate** runner config dir (`state/plugins-preview-runner/<uuid>/`) and a throwaway `CLAUDE_CODE_PLUGIN_CACHE_DIR` under `state/plugins-preview/<uuid>/`.
  - The throwaway dir is built under `storeLock` shared. It copies the store's `known_marketplaces.json`, with every `installLocation` rewritten to point into the copy, plus `marketplaces/<mkt>` for the plugin's marketplace and its dependencies' marketplaces. The real store is never read or written by the preview run (self-review r2 M8).
  - The dirs are factory-owned, never linked or mounted, and deleted in a `finally`.
  - It reads the new version's contents and diffs them against the store copy: hooks, MCP servers, commands, dependencies and code parts added or removed. It returns the diff, the new version and the gitCommitSha.
  - This rests on G1 ("install runs no plugin code"); if that fails, the preview design goes back to owner-i5.
- **Apply.** `update { version, gitCommitSha }` runs under `storeLock`, exclusive, with the same journal:
  1. `claude plugin update <key>`. If G1 item 10 shows `update` can't be pinned, use a fresh install of the new version next to the old one. Never uninstall first, since old versions stay on disk.
  2. `assertMarketplacePinned` and the post-install check.
  3. The installed version and gitCommitSha must equal the preview's. If not, roll back and fail: "x@y changed since you reviewed it. Review the update again."
  4. Old versions stay on disk.
  5. §8.3 runs after the lock is released.

### 7.6 Host plugins (Q7)

- `HostPlugins.list()` reads `<FACTORY_HOST_CLAUDE_DIR>/plugins/installed_plugins.json` and `known_marketplaces.json` (`lstat`, size caps).
  - Each distinct key is listed once, with the install whose `lastUpdated` is newest (versions may be hashes).
  - Contents are read from its `installPath`, which must be inside `realpath(<hostdir>/plugins/cache)` or a host directory marketplace. Otherwise the contents read "Can't show: outside the host's plugin folder."
- **A key already in the store** isn't listed under "On this host". Its factory peek adds "Also installed on this host (1.2.0)."
- **Install in factory** (a human click):
  - The peek shows "Installs x@y 1.3.0 from acme at e4f5a6b" before the click.
  - When that differs from the host copy, the in-place diff (host copy against the new version, the §7.5 preview) shows first.
  - Opening the host plugin's peek runs the marketplace preview (§7.1 step 1) from the host's record, which yields the `previewId` the click uses. If the marketplace is already registered with the same source, registration is skipped; with a different source the action is refused.
  - On click:
    1. Validate the host's `known_marketplaces[mkt].source` with the §7.1 input rules. `https://` only, no userinfo, query or fragment, and no `ref` or `path`; anything else is refused: "The host's record for acme can't be used: …".
    2. Register the marketplace (§7.1).
    3. Install the plugin (§7.5).
  - Nothing else is read from the host's plugin folders, and nothing is copied or linked out of them.

### 7.7 Auto-update off, sync off, refused sources (Q6.2, Q21, R3)

**Auto-update off**, on every path:
- `"autoUpdate": false` on every generated and runner `extraKnownMarketplaces` entry. The default is otherwise **on** for official marketplaces;
- `DISABLE_AUTOUPDATER=1` in the agent env and the runner env;
- `FORCE_AUTOUPDATE_PLUGINS` reserved;
- the seed forces `autoUpdate` off as well.

**Sync off:** `syncClaudeAiPlugins: false` in every agent's generated settings. Agents signed in through I3 would otherwise load claude.ai-synced plugins by default.

**Refused plugin sources**, at Install, Install in factory, update and validation:
- `npm` (out of scope);
- `command`: the docs say Claude re-runs it once per session, regardless of auto-update settings;
- any entry with `headersHelper`;
- `archive` without `sha256`.

The message is "Plugin x@y uses a <kind> source, which Open Factory doesn't install."

**Refused marketplace sources:** `url`, `file`, `npm` and `settings`. Only `github`, `git` and `directory` are accepted.

### 7.8 Plugin contents (`library/plugin-contents.ts`)

`readContents(root)` reads with `lstat` and never follows a link. Each JSON is at most 256 KB, and the walk stops at 2,000 files. Its output:

- **Manifest:** `.claude-plugin/plugin.json`: name, version, description, author, homepage, repository, `dependencies`.
- **Hooks:** `hooks/hooks.json`, plus `plugin.json` `hooks` (inline or a path). Each hook gives its event, matcher (empty shows "All"), type, full command and timeout.
- **MCP servers:** `.mcp.json`, plus `plugin.json` `mcpServers`. Each server gives its name and kind, then either the full command with args and env (names, plus values that aren't `${…}` references, since `NODE_OPTIONS=--require …` is code), or the full URL with header **names** only.
- **Other code-running parts:**
  - `lspServers` / `.lsp.json`;
  - `statusLine`;
  - `monitors/monitors.json`;
  - `bin/` executables (exec bit, top two levels);
  - a `package.json`, shown as "Installs Node dependencies".
- **By name:** skills, commands, agents, output styles, plus the custom paths `plugin.json` declares.
- **`unshown`:** every part that couldn't be read is listed in "This plugin has parts Open Factory can't show: <list>" (Q15.1, Break B2). That covers an unknown `plugin.json` key, a link (`hooks/hooks.json (a link)`), JSON over the cap, unparseable JSON, and a walk stopped at 2,000 files. "Runs no hooks or servers." appears only when everything was read and nothing runs. `contentsSummary` carries an `unshown` count.
- **`files`:** each `${CLAUDE_PLUGIN_ROOT}/<rel>` that a hook or MCP command references and that resolves to a regular file inside the root (realpath and `lstat`). This drives **View file**. `GET …/file?path=` returns at most 256 KB of text, refuses links and binaries, and serves only paths in this list.

The result is cached in memory by `installPath`, which is immutable per version.

### 7.9 Claude Code version floor (Q21)

- **The floor.** `CLAUDE_PLUGIN_FLOOR` (one constant in `library/claude-flags.ts`) is the lowest version with everything G1 verified on the shipped version:
  - the seed;
  - `syncClaudeAiPlugins`;
  - `mcpb/` (2.1.324 in the docs);
  - dependency auto-install (2.1.319).
  
  Until G1 records an older passing version, the floor is the shipped version.
- **The base image** pins Claude Code to an exact version in PR 2, before G1: `images/base/claude-code-version`, at or above the floor and at least 14 days old. The workflow stops resolving "latest", and the image already carries the version label. G1 runs on exactly that version.
- **Who is checked:**
  - the store runner, before each operation;
  - **every** local-runtime agent at start, not only those with plugins, because synced-plugin suppression and the skills-folder rules matter for any agent signed in through I3;
  - Docker images, once per image digest, by `docker run --rm --network none --entrypoint claude <image> --version`, cached.
- **Below the floor**, the start fails closed: "Claude Code {found} is too old; update it to {CLAUDE_PLUGIN_FLOOR} or later." Both versions are interpolated. There is no fallback (ADR 0028).

### 7.10 `RESERVED_SETTINGS_KEYS`: the one list (R11)

`packages/shared/src/settings-keys.ts` exports `RESERVED_SETTINGS_KEYS`: the settings keys that are factory-owned or that run commands. It is the **same constant** I2 hands I7 as the `agent` policy's default-deny list (I2 §5.3, §19), so the start check and I7's policy can never drift. It holds:

- **Factory-owned:**
  - `enabledPlugins`, `extraKnownMarketplaces`, `syncClaudeAiPlugins`, `strictKnownMarketplaces`;
  - `permissions.defaultMode`, `permissions.additionalDirectories`, `claudeMdExcludes` (I2's factory keys).
- **Running commands** (every key the settings reference marks "Any file" and describes as running a command or executable, checked against the shipped version's settings reference):
  - `hooks`, `statusLine`, `fileSuggestion`;
  - `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`.
- **`env`:** any entry whose name is in `FACTORY_ENV_NAMES`, so a project `env` can't redirect `CLAUDE_CODE_PLUGIN_SEED_DIR` or turn auto-update back on.

Templates and overlays keep I2's rules (templates are trusted operator input; overlays refuse the factory keys). The start check (§7.3) refuses **every** key in this list in agent-writable project and local settings. The plan's first PR 1 task re-reads the shipped version's settings reference and updates the list, and a test pins it.

`permissions.allow` and `autoMode` in project or local settings would let an agent widen its own permissions. That is I2's and I7's territory, so it isn't added here; it is flagged in §21 for Or.

## 8. Change flow integration

### 8.1 `Effective.library`

`ConfigResolver.effective` (I2 §6.1) adds:

```ts
library: {
  skills: Record<string, string>;   // name → "host" | "folder" | "template" | "github:<sha>"
  plugins: Record<string, string>;  // key → "<version>/<gitCommitSha7>" | "missing", over the transitive closure (R13)
}
```

It is resolved through `LibraryIndex` and `PluginStore.installed()`, and `started` keeps it.

### 8.2 Comparing (self-review M6)

I2's `describeChanges` and the restart check take `{ doc, library }` on both sides:

```ts
describeChanges(a: { doc: ConfigDoc; library: Library }, b: { doc: ConfigDoc; library: Library }): string[]
```

The restart decision is `describeChanges(runtime.started, after)` being non-empty, so a repin or a plugin update restarts the agents that use it.

New lines, sorted and secret-safe:
- "skill x updated a1b2c3d → e4f5a6b";
- "skill x now from GitHub" (the source kind changed);
- "plugin x@y updated 1.2.0 → 1.3.0" (a hex version shows as "commit 0120fb8 → 9a8b7c6");
- "added plugin x@y" / "removed plugin x@y", from `enabledPlugins`.

`summarizeChanges` counts these under skills and plugins.

### 8.3 Library-driven changes

`ConfigChanges.libraryChanged({ skills?, plugins?, by })` runs after a GitHub update, a marketplace update, a plugin update, and an Undo that restores a name. It always runs **after** the Library and store locks are released (§9.6).

For each non-archived, non-terminated agent whose effective config uses one of those names, it runs I2's `apply(agent, by, before, after)`:
- `before` is `started` when the agent is running, else a resolve captured before the mutation;
- `after` is a fresh resolve.

The event, the passive notice and the restart when idle follow I2 §7.3.

### 8.4 Fix codes

`library` joins the fix unions (`safe-fs.ts`, `agents/errors.ts`, `events.ts`) and carries the item: `{ fix: "library", item: { kind: "skill" | "source" | "plugin" | "marketplace", id } }`, where a skill's id is `<group>/<name>`. The fix link lands on that item (§10.7). `forSpawnedAgent` keeps it.

## 9. APIs (all `requireUser`; humans only; never MCP)

Shared schemas live in `packages/shared/src/library.ts`.

### 9.1 Reads

- **`GET /api/library/skills`** returns `{ hostDir, groups: SkillGroup[] }`, grouped as the list shows them (§10.2):
  - the Host group;
  - each source group, with its `source` summary (kind, path or repo, subpath, branch, pin, state, skill count);
  - Template skills, grouped by template;
  - Unknown.

  Each skill is `{ name, description, state: "ok" | "missing" | "hidden" | "unusable", stateDetail?, usedBy: { templates, agents } }`.
- **`GET /api/library/skills/:group/:name`** (the group is `host`, `source:<id>`, `template:<name>` or `unknown`) returns one skill with its **files** (a list up to 2,000 entries; executables marked) and the `SKILL.md` text, at most 256 KB.
- **`GET /api/library/skills/:group/:name/file?path=`** returns one file's text. It refuses links and binaries, and serves only paths inside the skill.
- **`GET /api/library/sources/:id`** returns the source, its picked skills, update info, `checkError` and users.
- **`GET /api/library/plugins`** (PR 2) returns `{ store: PluginEntry[], host: HostPluginEntry[], available: AvailableEntry[] }`.
  - `available` holds the marketplace entries that aren't installed, each with `pinned` and `refusedReason?`.
  - Every entry has a `contentsSummary` (counts per kind, plus `unshown`) and a `state`.
- **`GET /api/library/plugins/:key`** returns the full contents and provenance. With `?from=host` it reads the host copy.
- **`GET /api/library/plugins/:key/file?path=`** returns View file text (§7.8).
- **`GET /api/library/marketplaces`** returns the registry rows, with each one's plugins and users.

### 9.2 Skill sources

- **`POST /api/library/sources/preview`** takes `{ kind: "folder", path } | { kind: "github", repo, subpath?, branch? }` and returns `{ previewId?, commit?, committedAt?, subject?, branch?, found: [{ name, description, pickable, reason? }] }`. `reason` is one of "taken" (with `takenBy`), "unusable" (with `detail`) or "link". Errors are I4 field errors, redacted.
- **`POST /api/library/sources`** takes `{ kind: "folder", path, skills } | { kind: "github", previewId, skills }` and returns 201. Under the Library lock it re-checks the names and states.
- **`POST /api/library/sources/:id/find`** and **`POST …/:id/add { skills }`** run Find more skills, at the current pin.
- **`POST …/:id/check`**, then **`POST …/:id/update { commit }`**.
- **`POST …/:id/fetch`** re-fetches a missing cache at the same pin.
- **`POST /api/library/check`** runs Check for updates over every GitHub source and git or GitHub marketplace, 4 at a time. It returns 202 at once, and progress arrives through `library_changed`.

### 9.3 Plugins and marketplaces (PR 2)

- **`POST /api/library/marketplaces/preview`**, then **`POST /api/library/marketplaces { previewId }`**, which returns 202. The row shows `adding` until it's done (§7.1).
- **`POST …/marketplaces/:name/check`**, then **`…/update { commit }`**. **`DELETE …/:name`** removes it, with Undo.
- **`POST /api/library/plugins/:key/install`** returns 202.
- **`POST /api/library/plugins/:key/install-in-factory`** returns 202.
- **`POST /api/library/plugins/:key/update-preview`** returns `{ version, gitCommitSha, diff }`. **`POST …/update { version, gitCommitSha }`** returns 202.

### 9.4 Removal and Undo (Q18, T4)

- **`DELETE /api/library/sources/:id`** (and the marketplace equivalent):
  - refused with 409 `in_use` when the source is used, naming at most 3 users ("Used by template dev, @ana and 188 more.");
  - otherwise it sets `deletedAt` and returns `{ undoUntil }`, 30 s ahead. During the window the entry is gone from pickers and lists.
- **`POST …/:id/restore`** works while `now < undoUntil`. It is refused if another entry has taken one of the names in the meantime.
- **Purge.** A 30 s one-shot, the hourly timer and boot purge the rows past their window (no Undo survives a restart).
  - Purge removes the cache dirs through `SafeFs.removeAll` after a chmod. For a marketplace it runs `marketplace remove` under `storeLock`.
  - Purge skips a cache dir that a loaded runtime's `started.library` still references, and retries on the next timer.
- **The toast** carries Undo for exactly `undoUntil − now`; hovering doesn't extend it past what the server can restore. **Undo of an add** calls `DELETE` (a source that was just added is unused).

### 9.5 Live updates

The new WS frame `{ type: "library_changed" }` is published after every Library write, every install-state change and every check result. The web then invalidates the `["library"]` queries. The host and template-local lists have no watcher; they refresh on window focus and on I2's template change event (T5).

### 9.6 Locks (self-review M5)

- **Total order:** workspace (per slug) → Library → store. Each is its own instance: the workspace and Library locks are `KeyedMutex`es, and `storeLock` is a read/write lock (§7.2).
- Code holding the Library or store lock never takes a workspace lock and never awaits a runtime job.
- `ConfigChanges.libraryChanged` runs only after both locks are released.
- A start takes `storeLock` inside `prepare`, under its workspace lock, and checks again after it gets the lock.
- Registering and then installing (Install in factory, §7.6) takes the Library lock, releases it, then takes `storeLock`. The locks are never nested, so they never re-enter.
- A save's background install runs outside the request.

## 10. Web

Every task that touches the web names `vercel-react-best-practices` for both implementer and reviewer (§15).

### 10.1 Navigation and header

- **Sidebar.** The `nav` gains **Skills** (icon `Blocks`) between Templates and Schedules. Its shortcut is `g k`, listed in the shortcuts sheet and in the palette's Go to group. `g s` stays Schedules.
- **Routes** (all lazy): `/skills` in PR 1, then `/skills/plugins` and `/skills/marketplaces` in PR 2.
- **`SkillsHeader`** holds:
  - the h1 "Skills";
  - the view switch "Skills | Plugins | Marketplaces" (`SegmentedLinks`). PR 1 has a single view, so it renders no switch until PR 2;
  - **Check for updates** (ghost, `RefreshCw`);
  - **Add skills** on the Skills view, or **Add marketplace** on the Marketplaces view. The Plugins view has no add action, because plugins come from marketplaces.
- **Narrow widths** (UI r2 H1, L2):
  - below `sm`, both actions are icon-only, with a tooltip and an aria-label;
  - below about 24rem of header, the switch moves to its own line, and the h1 stays visible on line 1;
  - below about 16rem (390px at 200% text), the switch becomes a `Select` listing the three views, the same rule as DESIGN.md Sub-navigation.
  
  The evidence pass measures the exact thresholds at 375 and 390px, at 100% and 200% text.
- **Check for updates** (UI r2 M2) calls `POST /api/library/check`. The server runs every GitHub source and every git or GitHub marketplace, 4 at a time. Each row carries `checking` with `since`, through `library_changed`, so leaving the page loses nothing. The outcome line is derived from server state:
  - while running: "Checking… 0:12", with elapsed time after 10 s;
  - then: "Checked 12 sources · 2 updates · 1 couldn't be reached", or "All up to date · checked just now";
  - "2 updates" scrolls to the first update on the current view, or names the view ("2 updates in Marketplaces") and links there;
  - a source that failed shows the state "Couldn't check".
  
  The line sits beside the button from `sm` up. Below `sm` it is the first line of the page body, because the header has no room. It is never a toast.
- **Loaders** prefetch `libraryQueryOptions` and, without awaiting it, `hostQueryOptions` (I6).

### 10.2 Lists

Rows are **buttons** (`aria-haspopup="dialog"`, `aria-expanded`) that open a peek:
- Enter or Space opens it; Space on the row that's already shown closes it;
- `j`/`k` retarget the peek;
- the shown row takes `steel-selected`;
- at ≥54rem of container, the list keeps 30rem clear while a peek is open (`@container` wrapper, `@[54rem]:data-[open]:pr-[30rem]`, as in `images-section.tsx`);
- **F6** moves focus into the open peek and back (the `task-list.tsx` pattern), because a keyboard opening keeps focus in the list and the peek is portalled;
- `j`/`k` visit source header buttons as well as skill rows; `j`, `k` or a row click clear the peek's Back stack;
- after a source is removed, focus goes to the next source header, else the previous one, else Add skills.

Row anatomy follows the Templates list (`min-h-11`, container queries). Separate facts are spaced with `gap-x-4`, and `·` is used only inside one phrase.
- Only a number and its noun are kept together, with a non-breaking space ("190\u00a0agents"). Phrases wrap between words (UI r2 H5).
- The contents line is a list of items, one per kind, that wraps between kinds. A row shows the first three kinds, then "+N more". The peek shows them all.
- Commit subjects wrap (`[overflow-wrap:anywhere]`) and are clamped at 2 lines. Names (mono) carry `[overflow-wrap:anywhere]`. Plugin keys render as `name` plus a muted `@mkt`, with `<wbr>` before the `@`.

**Each group is its own `ul`,** labelled through `aria-labelledby` by the source **name** span in its header, not the whole header button.

**Skills view (R4)**, grouped by source:
- **Host** header: "Host", then the path `<hostDir>/skills` (mono, `MiddleTruncate`), then "Live", as separate items. It has no peek and no actions.
- **Source** header (folder or GitHub), a button that opens the **Source peek**. It shows:
  - the repo plus subpath, or the path (mono, `MiddleTruncate`);
  - the pin as a short sha (GitHub), or "Live";
  - "40 skills";
  - the source state.
- **Template skills,** one group per template, headed "Template `dev`". No actions.
- **Unknown:** referenced names that resolve nowhere.

Every skill peek has a "From" line:
- Host: "From the host's skills folder";
- Template: "From template `dev`";
- Unknown: "Not found anywhere";
- a source: a link to its Source peek, shown as plain text when you came from that Source peek.
- **Skill row:**
  - the name (mono, wraps);
  - the description (muted, `truncate`, the first thing hidden below 60rem);
  - "Used by 3 templates · 2 agents", with zero kinds left out ("Used by 2 agents"), or "Not used";
  - the per-skill state.

  The source and pin aren't repeated on skill rows.

**Plugins view.** Groups: "In the factory", "On this host" (keys not already in the store), and "In marketplaces, not installed".
- **Row:** `name@mkt`, then the version (a hex version shows as "commit 0120fb8"), then the contents line, then users, then state.
- **Contents line:** hooks first, zero kinds left out, "Parts not shown" first when `unshown > 0` (a contents fact with a warning icon, not a row state). When everything is zero: "Nothing to show".
- **Moving between groups** (UI r2 M9). Install and Install in factory move a row into "In the factory". The move waits until pointer and focus have left the list (DESIGN.md Live lists). An open peek retargets in place to the store entry, and the row keeps `steel-selected` in its new group.
- **Empty view:** "No plugins yet. Add a marketplace to install plugins." with a link to Marketplaces that opens Add marketplace.

**Marketplaces view.** Each row shows:
- the name (mono);
- the source: repo, or host plus path of the URL, or folder path (mono, `MiddleTruncate`);
- the pin or "Live";
- "No plugins installed" / "1 plugin installed" / "4 plugins installed";
- the state.

A pending add is its own row, "Adding acme/x… 0:42", with a spinner. A failed add stays as a row, "Couldn't add" (UI r2 H3). Its peek shows the redacted reason, with **Find again** (which reopens Add marketplace, prefilled) and **Remove**, a hard delete with no Undo, since nothing was registered.

**States.** One state per row, by precedence; any further state shows in the peek. Each state is a word plus an icon, never colour alone, and never signal orange:

| State | Icon / colour |
|---|---|
| Adding…, Installing…, Checking… | muted spinner (+ elapsed after 10 s) |
| Couldn't add, Install failed, Missing, Unusable, Couldn't check | `CircleAlert`, crimson |
| Update available | `ArrowUpCircle`, info |
| Hidden, Not pinned | `TriangleAlert`, warning |
| Not installed | muted, no icon |

The precedence is Adding… > Installing… > Checking… > Couldn't add > Install failed > Missing > Unusable > Couldn't check > Update available > Hidden > Not pinned > Not installed.

Elapsed times come from the server's `since` (`startedAt`), so a reload or navigation doesn't reset them. Elapsed = now − since, and the tick isn't rendered while the tab is hidden (UI r2 M3).

**Empty, loading and error states:**
- Skills empty: "No skills yet. Add some, or put a folder in `<hostDir>/skills`." The path comes from the API.
- Marketplaces empty: "No marketplaces yet. Add one to install plugins."
- Loading: static skeleton rows at their real heights.
- Load failure: "Couldn't load skills." with `CircleAlert` and Retry (the Images pattern).
- Counts use the existing plural helper: "1 template", "Add 1 skill".

### 10.3 Peeks

A peek is a right peek sheet (480px, no scrim), and a bottom drawer below `md`:
- **Opening.** A click opens it with the sheet motion. A keyboard opening, and every retarget, is instant.
- **Sections** are separated by spacing and rules, never by cards.
- **Every action is driven by state.** The footer holds at most three buttons, which stack on phones.
- **All third-party text** follows §10.6: code and file text in mono, prose in Geist.
- **Long titles** use `MiddleTruncate` (keep the end); the full value is selectable below.

**Source peek** (R4):
- **Title:** the repo plus subpath, or the path (mono).
- **Source:**
  - kind, branch;
  - the pin, as a copy button with the short sha: it copies the full commit and carries it in its tooltip and accessible name. The full commit is also shown as selectable mono;
  - date and subject, or "Live";
  - **Check for updates**, a ghost action in this section's label row.
- **Update view:** open in place when an update exists, as in §6.3. Changes are lines with `+`/`−` and the diff tokens. The compare link opens a new tab with an external-link icon. The primary button is "Update to e4f5a6b". A refusal shows in the outcome line, with linked users.
- **Skills:** the picked skills, each opening its skill peek in place with Back.
- **Find more skills** (UI r2 H4) expands the Add skills results step **inline** in this peek, with the source fixed. Its outcome is inline ("Added 2 skills.") because the control is still on screen, and there is **no Undo**: removing one skill from a source is out of scope (§3). The confirm button says "Add 2 skills to this source".
- **Missing cache:** **Fetch again**, on the Missing line.
- **Footer:**
  - "Remove source (40 skills)", a crimson ghost button (the title already names the source);
  - when in use, the reason shows next to it ahead of time ("Used by dev and @ana. Remove it from them first."). The button stays focusable, with `aria-disabled` and `aria-describedby` pointing at that reason;
  - after removal the peek closes, focus moves to the next row, and the toast reads "Removed acme/x and its 40 skills." with Undo.

**Skill peek:**
- **Header:** the name (mono), the description, and "From acme/x · a1b2c3d" as a link to the Source peek.
- **Used by:** grouped by template ("dev · 190 agents"); the list collapses past 8 entries behind "Show all N".
- **Runs code** first, when the frontmatter declares `hooks` (R12): each hook's event, matcher and full command, as in the plugin peek.
- **Files:** a list, with executables marked "Runs code", clamped past 20 with "Show all N". `SKILL.md` and any file open with View file.
- No source actions.

**Plugin peek:**
- **Header:** `name@mkt`, the version, the description, and the contents line (so the scale shows before scrolling).
- **Runs code** comes first and never collapses:
  - **hooks:** below a 28rem container (`@max-[28rem]` on `SheetBody`, never the viewport) the event and matcher stack above the command;
  - **MCP servers:** the kind, the full command, args and env, or the full URL with header names;
  - **dependencies;**
  - **LSP, status line, monitors, executables, Node dependencies;**
  - **"This plugin has parts Open Factory can't show: …".**

  With nothing in it, the section reads "Runs no hooks or servers."
- **While the detail query loads**, static skeleton rows render at their real heights from `contentsSummary` counts, so the section doesn't jump.
- **Provides:** skills, commands, agents and output styles, in wrapping mono runs. Past 20 per kind: "Show all 34".
- **Provenance:** marketplace, its source and pin (or "Local folder, live"), the installed version, gitCommitSha (a copy button, as above), who installed it and when, "Not pinned by its marketplace, installed at 2f634a9", "Provenance unknown", and "Also installed on this host (1.2.0)".
- **Used by.**
- **Update view** (R9, UI r2 M8). "Update…" in the footer is a disclosure (`aria-expanded`), hidden while the view is open. Opening it inserts the view right after the header, scrolls it into view and focuses its heading.
  - It isn't opened automatically, unlike the source update view, because preparing it installs into a throwaway dir (T7).
  - "Preparing update…" is its loading state. The diff of hooks, MCP, commands, dependencies and code parts shows as `+`/`−` lines.
  - The primary is "Update to 1.3.0".
  - A mismatch shows "x@y changed since you reviewed it. Review the update again."
  - It is never a dialog.
- **Footer:** Install, or Install in factory (with "Installs x@y 1.3.0 from acme at e4f5a6b." above it), or Update….
- **View file:** one toggle button (`aria-expanded`) whose label flips between View file and Hide file, so focus never moves. The text opens **from its first line** inside a plate with a rule and is clamped at 40 lines with "Show all · N lines". When the server cut the file, it says "Cut at 256 KB."
- **Opened from the Configuration form** (R10), the peek is **read-only**: no Install, Update or Install in factory, and no Used by links. It ends with "Open in Skills", which navigates (the form's leave guard applies) and lands on the item (§10.7).

**Marketplace peek:**
- the source and pin, with the copy button;
- the update view in place: "Plugins in use that change: x@y 1.2.0 → 1.3.0; z@y source changes";
- its plugins, each opening in place with **Back**. Back is instant and returns focus to the row it came from; Esc closes the whole peek;
- **Check for updates**, a ghost action in its Source section's label row;
- Remove, with the same in-use rule as a source. When plugins from it are installed, the reason reads "Plugins from acme are installed. Uninstalling plugins isn't available yet."

### 10.4 Add sheets

Both sheets use `FormFrame`, I4's `useFieldErrors`, `FormOutcome` and `field-stack`. On phones there is **one scroller**, the drawer body; the list grows inside it, and the footer stays pinned.

**Add skills** (header action and sheet title are plural; the form's picker keeps "Add skill"):
- **Source:** a segmented control, Folder | GitHub.
- **Folder:** Path, a `PathField` with the help "A skill folder, or a folder of skills, on the factory's machine."
- **GitHub:**
  - Repository, with the help "owner/repo or a github.com URL. Private repos use this host's git sign-in.";
  - Path (optional), "The folder inside the repo. Empty means the whole repo.";
  - Branch (optional), "Empty means the default branch. Submodules and LFS files aren't fetched."
- **Step 1, Find skills** (primary; "Finding… 0:14" after 10 s). Errors land on their fields. Field messages follow I4: one rule, at most 40 characters, and never the user's input (UI r2 M7).
  - Path: "Can't share your home folder.", "Can't share the factory's folder.", "Can't share this folder."
  - Repository: "Use owner/repo or a github.com URL.", "Couldn't reach this repo." (the help covers private repos)
  - Branch: "No such branch."
  - Path in repo: "Not a folder in this repo."
  - Form-level outcome: "Folder is over 50 MB.", "The repo returned another commit."

  The longer messages in §6 are the server's log and peek wording. The API's field errors carry the short forms.
- **On success:**
  - focus moves to the results label ("Found 12 skills", `tabindex=-1`), which is scrolled into view. The focus is the announcement, so there is no live region as well;
  - the primary stays inert for 300 ms after its label changes;
  - the button width is stable, with tabular numbers.
- **Results:**
  - The line "Found at a1b2c3d · main · 2 days ago · <subject>".
  - A checkbox list: name (mono, wraps), then the description, clamped at 2 lines.
  - Pickable rows start checked.
  - Unpickable rows are disabled, with their reason at full `ink-muted`: "Name taken by Host", "SKILL.md names it y", "It's a plugin; add it through a marketplace", "It's a link".
  - Disabled checkboxes keep their shape. The change is made in `checkbox.tsx` itself, following decision 21, not as a one-off: disabled unchecked is a rule-coloured box with a muted border, and disabled checked is an `ink-muted` fill, so a stale checked box never looks enabled. No opacity fade.
  - One ghost toggle in the list's label row reads "Select all", or "Select none" when every visible pickable row is ticked. It acts on the filtered rows only.
  - With more than 20 results, a filter field sits above the list.
- **Zero found:** "No skills in acme/x at a1b2c3d. A skill is a folder with a SKILL.md." Add stays disabled. If every found skill is unpickable: "None of these can be added."
- **Editing a source field afterwards** marks the results stale rather than clearing them:
  - the checkboxes are disabled;
  - the line reads "The source changed. Find skills again.";
  - the primary returns to "Find skills";
  - a new Find keeps the ticks for names that are still found.
- **Step 2:** "Add 3 skills". It is disabled at 0, with the note "Pick at least one skill."
- **After Add:** "Adding… 0:03". For a GitHub source whose preview was swept, this re-fetches and can take up to 180 s, and it continues on the server if the sheet closes: the source then appears as a pending header "Adding acme/x… 0:42" and the outcome is a toast (amendment 6). `POST /api/library/sources` returns 202 for a GitHub add that must re-fetch, and 201 otherwise. The sheet closes on success, and the toast reads "Added 3 skills." with Undo (§9.4).
- **Close during Find** cancels the request and keeps the draft (R8).

**Add marketplace:**
- **Source:** GitHub | Git URL | Folder, then the matching field.
- **Step 1, Find marketplace.** The preview shows "Found acme at a1b2c3d · main · <subject>", then its plugins, each with its version and "Not pinned" or "Can't install: command source" where those apply.
- **Step 2, Add marketplace.** The sheet closes at once. The Marketplaces list shows the pending row "Adding acme… 0:42". The outcome is a toast: "Added acme, pinned to a1b2c3d.", or "Couldn't add acme." with **Show details**, which opens the failed row's peek (R8, UI r2 H3). The add continues on the server whatever the sheet does, and reopening the sheet while it runs shows "Adding acme…", disabled.

### 10.5 Pickers in the Configuration form (replaces I2 §12.2's "Skills and plugins"; R7)

- **Trigger.** A ghost **Add skill** / **Add plugin** action (with a Plus icon) in the label row of the "This agent" group (agent mode) or of the list (template mode). Rows append below it, so the trigger never moves.
- **Popover.** A filter field at a fixed height and two-line options:
  - line 1: the name (mono, wraps);
  - line 2: the description (skills) or the version and contents line (plugins), muted, one line, `truncate`.

  Skills are grouped by **source**, as on the page: Host, then each folder or GitHub source, with a `MiddleTruncate` heading and no per-option tag. Plugins are grouped by marketplace.

  The list keeps cmdk's single-select listbox semantics; it is never `aria-multiselectable`, because cmdk sets `aria-selected` on the highlight (UI r2 H2). A picked option gets `aria-disabled` and the visible and sr text "Added".
- **Empty states:** "Every skill is already added." / "No skills in Skills yet." / "No plugins from dev's marketplaces are installed." A muted footer line counts what was left out and why: "3 skills can't be used here: hidden or unusable."
- **Picking.**
  - Enter or a click adds the option. The option **stays where it is**, checked and disabled, marked "Added".
  - The highlight moves to the next enabled option, and "Added tdd" is announced in a polite live region that lives **outside** the popover, so it survives the close.
  - Placement locks at the first pick, the page doesn't scroll while the popover is open, and the filter text is kept.
  - Picked options are left out the next time the popover opens. On close, the last added row scrolls into view.
- **Left out:**
  - hidden, unusable and missing skills;
  - skills that share a name with this template's local skills;
  - already-selected entries.
- **No virtualisation in I5.** cmdk handles hundreds of options, and its DOM-based keyboard navigation works badly with virtual rows. Options are keyed by name, and the filter is a pure function over the loaded list. If a factory ever reaches about 1,000 skills, a sibling component with `aria-activedescendant` replaces this (§15).
- **Skills.**
  - Selected rows are I2 `ConfigList` rows that add their source and pin ("GitHub · a1b2c3d") and any state ("Missing", "Hidden").
  - Template-local skills stay read-only, labelled "Template skill".
- **Plugins:** **store** plugins only (Q7).
  - Template mode lists every store plugin, with the footer "Install more in Skills".
  - Agent mode lists only plugins from the template's declared marketplaces, with the footer "Only plugins from dev's marketplaces. Add more in the template."
  - Selected rows show the contents line and **View**, which opens the read-only plugin peek (R10).
- **Picking writes the draft** (§7.4). Agent mode keeps I2's "From template dev" and "This agent" groups.

### 10.6 Untrusted text (UI r2 M5)

Third-party text comes in two kinds. Neither is ever rendered as markdown or linkified, and both tokenise invisible, control and bidi code points: U+202A–202E, U+2066–2069, zero-width characters and C0 controls show as ⟨U+202E⟩, ⟨ESC⟩ and so on.

- **Code and file text** (commands, hook matchers, args, env, URLs, View file, SKILL.md): mono, `white-space: pre-wrap`, `overflow-wrap: anywhere`, `unicode-bidi: isolate`, `dir="ltr"`. What a human reviews is then exactly what runs (Break B3).
- **Prose** (descriptions, commit subjects, plugin descriptions): Geist, `unicode-bidi: isolate`, `dir="auto"`. Mono is only for identifiers and code (DESIGN.md Typography).

The only links on these surfaces are the GitHub compare link and links to factory routes.

### 10.7 Fix links and arrival (R6)

A `library` fix navigates to the item's view and passes `{ peek: item }` in router state, not in the URL (D11 stands). The view:
1. scrolls the row to the centre;
2. focuses it with the deep-link arrival (a 6% signal tint for 2 s);
3. opens its peek.

"Open in Skills" from the form does the same.

### 10.8 Motion

- Peeks and sheets follow DESIGN.md. Results, update views, View file and "Show all" appear instantly.
- Spinners appear only beside a pending label, and show elapsed time after 10 s, paused while the tab is hidden.
- At 390px and at 200% text there is no horizontal scroll anywhere.

## 11. Security summary

### 11.1 Who can change what

- **Humans only** write skill sources, the registry and the store, through REST in a user session (Q5).
  - Library routes take no agent token, and the MCP server registers no Library tool.
  - PR 1 adds a route test: an agent bearer token gets 401 on every Library route.
- **Agents** reference entries only through overlays, which a human saves (or, from I7 on, a `manage_org` agent saves), and plugins only from their template's marketplaces.
- **I7 note:** assigning `enabledPlugins` adds hooks, so I7's `agent` policy must treat it as a code-running key.

### 11.2 Supply chain

- **GitHub skills** are pinned to a verified commit. Fetches are capped, run without symlinks, hooks, submodules or LFS, and the checkout is read-only.
- **Marketplaces** are pinned to a verified, enforced and clean commit. The name is known before the store is touched, and a half add is repaired at boot.
- **Plugins:**
  - A plugin with a pinned source installs automatically. An unpinned one installs only on a human click and shows "Not pinned".
  - Dependencies must come from pinned, registered marketplaces.
  - An install that brings anything unexpected rolls back.
  - Refused: command, headersHelper, npm, and archives without sha256.
- **Nothing auto-updates:**
  - `autoUpdate: false` and `DISABLE_AUTOUPDATER=1`;
  - the env names are reserved;
  - the seed is never written;
  - synced plugins are off;
  - updates show what changes first, and the applied update must match the reviewed one.
- **Provenance** is shown everywhere.
- **No tokens in URLs.** Input refuses userinfo, query and fragment, the same rule applies to the host record, logs and events carry only redacted output, and rows store clean URLs.

### 11.3 Mounts, links and the skills folder

- **Skill mounts** are real folders only, read-only, never the home or state dirs (I2). There are two new exact-location classes, each checked with a full `lstat` walk.
- **Folder sources** are refused at add, and their skills are checked again (links, `.claude-plugin/`) at every read and start.
- **Plugin paths into an agent are closed at every start.** Each start:
  - fails on any `.claude/skills/` entry that holds `.claude-plugin/`, following links;
  - empties `.claude-config/skills/`;
  - scrubs the plugins root to `data/`;
  - fails on project or local settings that set plugin keys or `hooks` (R11);
  - passes the factory's plugin keys through `--settings`, which outranks project and local settings.

  So a plugin reaches an agent only as a reviewed store plugin, from its template's approved marketplaces, enabled by a human-saved template or overlay. **Hooks** reach it only through a store plugin, the frontmatter of a factory-linked Library or template skill (shown under Runs code), or the human-reviewed template and overlay `settings` (I2).
- **The store** is a read-only mount in Docker, and non-writable between operations on disk.

### 11.4 Residual risk, stated

- **Within a running session**, Claude Code reloads settings files live, and skill hooks register when the skill is invoked. An agent with Bash can already run code as itself, so the start checks are about **persistence and review**, not about containing a running agent: whatever it adds is refused at its next start. This is stated, not solved; the follow-up is the Docker managed-settings mount (§21).
- **Local-runtime agents** run as the host user. Between starts they can chmod and write the store and cache, edit `state/`, and write anything under their workdir. Every start re-checks what it can. This is the accepted local trust decision (S5 Q10), not a new hole.
- **`data/` persists by design**, and plugins can keep dependencies there (the docs suggest it). Code an agent edits under `data/` runs as that plugin's code at the next start. That is the same class as `mcpb/`, but scrubbing `data/` would break every stateful plugin, so it is accepted and stated.
- **The 14-day orphan cleanup** (§7.2).
- **The seed read after spawn.** Claude's read of the seed after spawn isn't covered by the store lock (§7.2).
- **External plugin sources with a `sha`** still fetch code at install, though that code is fixed by the sha.
- **A synced plugin an organisation marks as required** "loads regardless" of `syncClaudeAiPlugins` (loading.md). G1 records whether that applies to token-signed-in agents.
- **Defence in depth for Docker** (follow-up): a read-only managed-settings mount, which outranks every other level, holding `strictKnownMarketplaces`, `syncClaudeAiPlugins` and the plugin keys.

## 12. Data model and reset

Generated Drizzle migrations only (ADR 0028):
- **PR 1:** `skill_sources`;
- **PR 2:** `marketplaces`.

There is no change to the `agents` or `templates` columns.

**Reset step**, stated in each PR and in the plan:
- **Everywhere:** drop the database and recreate agents.
- **PR 1:** rename `FACTORY_HOST_SKILLS_DIR` to `FACTORY_HOST_CLAUDE_DIR` in `.env` (pointing at the Claude dir, not its `skills/`). The old name is simply ignored, with no warning.
- **PR 2:**
  - templates listing `plugins:` fail validation ("Unknown field."): move them to `enabledPlugins` in `settings.json`;
  - add their marketplaces in Skills;
  - recreate agents.

  Old `state/agents/<slug>/plugins-config/` folders and old `.claude-config/plugins` links are left alone. The start replaces the link with a real folder (§7.3).

## 13. Gate G1: real Claude Code checks (Or, before PR 2's implementation)

G1 needs real Claude Code, which the design team must not run. It is a **hard gate for PR 2** and runs on the **exact** version the base image ships (Q21). If any item fails, it goes back to owner-i5 before the design adapts. G1 doesn't block PR 1.

The plan's first PR 2 task turns this into a script (`scripts/g1/run.sh`) plus a fixture recipe. This section fixes what it must prove, and how.

**Setup:**
- a scratch dir, never `~/.open-factory-spike`; any credential; `claude --version` recorded.
- **The fixture marketplace is a throwaway GitHub repo** Or creates, such as `<or>/of-g1-fixture`, so it is a real git marketplace. A plain path would make a directory marketplace and test no clone at all. It holds:
  - `marker`, a plugin whose every code path writes a marker file into `$MARK`:
    - a SessionStart hook;
    - an MCP server that also writes `${CLAUDE_PLUGIN_DATA}/x`;
    - `bin/x`;
    - a monitors entry;
    - a `package.json` with one real registry dependency, a lockfile, and `preinstall`/`postinstall` scripts;
  - `dep`, a plugin that `marker` depends on (exact, no range);
  - `ranged`, a plugin with a version-range dependency.
  
  Then make a second commit that changes `marker`.
- **A local directory marketplace** with a relative plugin whose manifest has `defaultEnabled: true`.
- **Every pinned clone is detached BEHIND its origin** (`checkout --detach HEAD~1` after the add), as the factory pins it. A "doesn't pull" check can then actually fail.
- **`set -eu` safe markers:** `mkdir -p $MARK` up front, and check with `test -z "$(ls -A $MARK)"`.
- **The whole stream is captured** (`> $S/out.jsonl`) and `init` selected with `jq 'select(.type=="system" and .subtype=="init")'`, never `head`, which can kill the run before hooks and MCP write.
- **The agent runs exactly as §7.3 builds it:**
  - `CLAUDE_CONFIG_DIR=$AG`, a scrubbed plugins root and an empty `skills/`;
  - `CLAUDE_CODE_PLUGIN_SEED_DIR=$SEED`;
  - `DISABLE_AUTOUPDATER=1`;
  - `--settings "$(cat $S/plugin-settings.json)"`, the inline JSON §7.3 step 7 passes;
  - a workdir with no `.claude/settings*.json`.

**Items:**

1. **Only enabled plugins load.**
   - With `marker` and `dep` true and `skill-creator` false, `init.plugins` lists exactly `marker` and `dep`, each with a `path` under `$SEED`.
   - Remove `skill-creator`'s entry (no explicit `false`) and record whether it loads (`defaultEnabled`).
   - Set `dep: false`: record that `marker` fails to load (dependencies must be enabled, R13).
2. **The seed is never written.**
   - Run once with the seed read-only and once with it **writable**, as it is during a store operation.
   - `find $SEED -newer $S/t0` is empty both times.
3. **Install doesn't pull.**
   - The clone stays at its detached HEAD across `install` runs with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
   - Repeat without the variable and record whether it moves.
   - Record whether an external source with a `sha` still installs with the variable set.
4. **A ref-less declaration doesn't refetch.** On the agent side, a declaration without `ref` causes no re-fetch or pull of the detached-behind clone, for the official marketplace and the fixture. Check HEAD and stderr. For the official marketplace, also run with the network blocked.
5. **Skill naming.** With `$W/.claude/skills/foo/SKILL.md` holding `name: bar`, record whether `/foo` or `/bar` appears in `slash_commands`.
6. **An agent's own install doesn't persist.**
   - In the agent env, run `claude plugin install skill-creator@claude-plugins-official` and `claude plugin marketplace add <another repo>`.
   - Scrub as §7.3 does, then run again.
   - Neither shows, and only seed marketplaces load.
7. **`data/` and `mcpb/`.**
   - `marker`'s MCP server wrote `$AG/plugins/data/marker*/x`, so the data dir is per-agent and writable.
   - Delete `$AG/plugins/mcpb`, run again, and record whether the MCP server still starts (re-extracted).
8. **Install and update run no plugin code.** `$MARK` is empty after `install`, after `update`, and after a dependency install. If it isn't, T7 changes.
9. **Skills-directory plugins.** A plugin folder with a SessionStart hook at:
   - (a) `$W/.claude/skills/sneaky/`;
   - (b) `$AG/skills/sneaky/` (user level);
   - (c) behind a link in `$W/.claude/skills/`.
   
   For each, record whether it loads and whether `"sneaky@skills-dir": false` in `--settings` stops it.
10. **The plugin update path.** With the store writable and the fixture's second commit pinned, run `update marker@fixture`. Record:
    - whether it pulls (HEAD);
    - where the new version lands;
    - whether the old one gets `.orphaned_at`.
    
    This decides `update` against uninstall plus install.
11. **Auto-update stays off for the official marketplace.** A session longer than ten minutes, run interactively in the agent env with one message: the seed and `$AG/plugins` gain no new versions.
12. **Project and local settings** (R11). Write `$W/.claude/settings.local.json` with:
    - `{"enabledPlugins": {"skill-creator@claude-plugins-official": true}}` against the `--settings` `false` for the same key: record which wins. Either way the §7.3 start check is what enforces the rule; the result says whether `--settings` is a second layer or only a carrier;
    - `extraKnownMarketplaces` plus `"x@evil": true` for an external plugin: record whether it is fetched.
13. **A directory marketplace's catalog.** A relative plugin with `defaultEnabled: true` in a declared directory marketplace, not installed and not listed in `enabledPlugins`: record whether it loads (R14).
14. **The preview copy** (T7). Install into a copied plugins root with rewritten `installLocation`s. The original store gets no writes.
15. **The runner auto-add.** A runner whose `settings.json` declares a marketplace that is absent from `known_marketplaces.json`: record whether `claude plugin …` auto-adds it.
16. **Project hooks and live reload** (R11), extending item 12:
   - a project-level `hooks` entry and a `statusLine` both run, which proves the check is needed;
   - record whether an `enabledPlugins` change in `settings.local.json` mid-session takes effect without a restart, and whether `/reload-plugins` exists in `-p` mode.
17. **Frontmatter hooks** (R12):
   - a skill in `$W/.claude/skills/h/` whose `SKILL.md` frontmatter declares a SessionStart or PreToolUse hook writing a marker. Invoke the skill and record whether the hook runs;
   - the same with a subagent in `$W/.claude/agents/a.md` declaring `hooks` and `mcpServers`, and in `$AG/agents/`;
   - record whether skills in `$AG/commands/` or `$AG/agents/` load.
18. **Required synced plugins.** If Or's claude.ai organisation can mark a plugin required, record whether it loads with `syncClaudeAiPlugins: false` for a token-signed-in agent. If not, mark it untested.
19. **The version floor.** The lowest version where items 1–4, 7, 12 and 18 hold (the seed, `mcpb/`, settings precedence and sync), if Or can test an older one. Otherwise the shipped version is the floor.

## 14. Testing and evidence

**Unit (shared):**
- the `library.ts` schemas and patterns (reserved names, length limits);
- input normalisation: repo, subpath and branch in TS, both good and bad cases (userinfo, `?`, `#`, `..`, `@{`, SSH, other hosts);
- the `enabledPlugins` rules;
- the library lines in `describeChanges` and the summary counts;
- the precedence of row states;
- grapheme-safe cuts.

**Server.** DB tests run in CI only, because the local Postgres role is unavailable.

- **`git-fetch`,** against a fixture repo built in the test (`git init`, commits, a symlink, a gitlink, a 51 MB blob, a `.claude-plugin/` skill, a mismatched frontmatter) and served through `file://` with `FACTORY_GITHUB_URL`:
  - resolve: exact-match ls-remote (a decoy `refs/heads/x/refs/heads/main` is ignored) and the default branch's name;
  - fetch: HEAD equals the sha (a fake `git` returning another commit fails closed); a symlink arrives as a file; a gitlink as an empty dir; the 50 MB cap; a subpath escape is refused;
  - the checkout is read-only, and `trees` is recorded;
  - the runner: env and `-c` flags exact (a fake `git` on `PATH` records argv and env, and host `GIT_*` doesn't pass); errors redacted.
- **`LibraryIndex`:**
  - host discovery and skips;
  - hidden, unusable (frontmatter, `.claude-plugin/`, link) and missing;
  - registered names win over host ones;
  - synthetic "Unknown / Missing" rows with users;
  - `usedBy`.
- **Sources service:**
  - add refuses taken names and unusable skills;
  - the folder forbidden set (`~`, an ancestor of home, under `FACTORY_HOME`);
  - Find more;
  - update: refused when it drops a used skill, refused when it would empty the source, and "changed" comes from `trees`;
  - Undo inside the window, refused after it and after a name is taken; boot purge;
  - purge skips a dir a runtime still references.
- **Links, mounts and the skills folder:**
  - §6.5's list;
  - the drop-unlisted pass;
  - an agent-written `.claude/skills/x/.claude-plugin/` fails the start;
  - a picked folder skill swapped for a link is unusable.
- **`validateEffective`:**
  - each skill message;
  - the template-local collision, for templates and overlays;
  - `enabledPlugins` cases: false, undeclared, unregistered, source mismatch, an overlay plugin from a non-template marketplace, a refused source kind, and `syncClaudeAiPlugins` in a template.
- **Marketplace add,** with fake Claude (extended so `marketplace add` writes `known_marketplaces.json` and a git clone of a fixture marketplace, `install` writes `installed_plugins.json` and a cache dir, and scenarios can "pull the marketplace", "install an extra dependency" or "install an unexpected marketplace"):
  - preview before touching the store;
  - a taken or reserved name is refused;
  - a failure removes only what the add created (a pre-existing marketplace with the same name survives);
  - boot repair of `adding`.
- **`PluginStore`:**
  - one install for three spawns (AC 10);
  - a start installs a pinned missing plugin, re-checking after the lock;
  - a start refuses an unpinned one;
  - pin drift and an unclean tree fail closed;
  - an install that pulled, or that brought an unexpected plugin or marketplace, rolls back;
  - dependencies must be pinned and registered;
  - the store is non-writable between operations, boot re-applies it, and a start refuses a writable store;
  - locks serialise, and a slug named `store` doesn't collide;
  - the provenance sidecar holds only its fields;
  - update: the preview diff, an apply whose sha doesn't match rolls back, and the throwaway dir is removed;
  - a failed background install writes `plugin_install_failed` and the row state;
  - redaction.
- **The agent's plugins root.** The scrub keeps `data/` only, and an old link at that path is replaced by a folder.
- **Start checks** (R11, R12):
  - `.claude/settings.json` or `settings.local.json` setting `enabledPlugins`, `extraKnownMarketplaces`, `syncClaudeAiPlugins` or `hooks` fails the start;
  - a link at either path fails;
  - `.claude-config/skills/` is emptied;
  - a link the agent made in `.claude/skills/` to a plugin folder fails;
  - the start check iterates every key in `RESERVED_SETTINGS_KEYS`, in both files (PR 1);
  - an agent-written skill with frontmatter `hooks`, or a subagent with `hooks` or `mcpServers`, fails the start, and `.claude-config/{skills,agents,commands}` are emptied (PR 1);
  - the plugin JSON is passed with `--settings` (fake Claude records argv) (PR 2).
- **Store lock:** a start during an install waits on the shared hold and never sees a writable store.
- **Journal:** a crash mid-install rolls back at boot, and orphan markers written during a failed install are removed.
- **Dependencies:** the closure is enabled, and a ranged dependency counts as unpinned.
- **Marketplace updates:** detected by tree for relative plugins.
- **Preview:** runs against an isolated copy (the store is untouched).
- **Settings.** The `--settings` JSON writer emits `enabledPlugins` (true for the closure, explicit false for every other store marketplace plugin), the registry sources with `autoUpdate: false` (no `ref`), and `syncClaudeAiPlugins: false`. `buildSettings` writes none of these keys. The reserved env names can't be set by a template, an overlay or a secret.
- **Version floor:**
  - the runner and a local start below the floor fail closed;
  - a Docker image check is cached per digest.
- **Contents:**
  - hooks inline and from a file;
  - MCP stdio with env, and http with header names only;
  - LSP, status line, monitors, `bin/`, `package.json`;
  - dependencies;
  - `unshown` for a link, an oversized file, bad JSON, a stopped walk and an unknown key;
  - View file refuses a path it doesn't reference and a symlink;
  - host `installPath` is confined.
- **Change flow:**
  - a GitHub update writes "skill x updated …" and restarts only the agents that use the skill, compared against `started.library`;
  - a plugin update does the same;
  - `libraryChanged` runs after the locks are released.
- **Routes:** every Library route returns 401 to an agent token and without a session (PR 1 for skills, PR 2 for plugins).

**Web** (each task with `vercel-react-best-practices`):
- `SkillsHeader`: views, icon-only actions, and the Check outcome line;
- the lists:
  - grouping by source, the Source peek, rows as buttons with `aria-expanded`, `j`/`k`;
  - state precedence and icons, "Not used", zero kinds left out, hex versions, `<wbr>` keys;
  - empty, loading and error states;
- Add skills:
  - the two steps, focus to the results label, the 300 ms inert, stale results that keep picks;
  - disabled rows with reasons, the filter past 20, zero found;
  - Close cancels the Find;
  - the toast with Undo, capped at `undoUntil`;
- Add marketplace: the preview, the pending row, the toast outcome;
- the peeks:
  - Runs code first, skeletons from counts, View file from the top (40 lines) as a toggle;
  - untrusted text with a U+202E command, rendered visibly;
  - the update view in place with `+`/`−`; the refusal line;
  - the read-only peek from the form;
  - Back in the marketplace peek;
- the multi-pick picker: the trigger in the label row, a picked option stays checked and disabled, the highlight moves, the live announcement, left out on the next open, the agent-mode limit and footer copy, virtualisation;
- `library_changed` invalidation;
- fix-link arrival.

**Evidence pass** (the plan's last tasks). Real browser, Chromium and WebKit headless, through the U4 harness's `run.sh` lock, with fake Claude only. GitHub fetches go to a local fixture repo through `FACTORY_GITHUB_URL=file://…`. At most one heavy job at a time, on `/tmp/of-v002-heavy.lock`. Covered: the three views, the peeks, the add sheets and the pickers, at 1440, 1024, 390 and 375px, and 390px at 200% text. Acceptance flows 1–6 run in PR 1, and flows 8–13 in PR 2.

**Worst-case fixture:**
- a 40-skill GitHub source;
- a 64-character skill name with underscores, plus two names that differ only at the end;
- a skill used by 1 template and 190 agents, and one used by exactly one;
- a GitHub repo with 0 skills, and one with only unpickable skills;
- a plugin with 12 hooks and long commands, one with a U+202E command and a multi-line `bash -c`, one whose `hooks.json` is a link, and one with more than 2,000 files;
- `rust-analyzer-lsp@claude-plugins-official` with a 12-hex version;
- two git-URL marketplaces on one host;
- a failing check;
- an empty Plugins view;
- a 200-character subject ending in an emoji;
- a 120-character path;
- the template `platform-infrastructure-reviewer`.

## 15. Web conventions for the plan

- **The skill line.** Every `apps/web` task says: "Implementer and reviewer invoke `vercel-react-best-practices` and follow it." The final review checks the React diff against it; Next-only rules are skipped, and the review notes that.
- **Data:** TanStack Query, with `libraryQueryOptions` (`["library","skills"]`, `staleTime: 0`), `skillQueryOptions(group, name)`, `sourceQueryOptions(id)`, `pluginQueryOptions(key, from)` and `marketplacesQueryOptions`. File text lives under its own `["library-file", …]` key. The plan's Global Constraints pin the exact keys and the React rules from its review.
  - Loaders prefetch.
  - No effect fetches data, and no derived state lives in an effect.
  - A peek renders from the list's cached row first and refines from the detail query (skeletons from the counts).
- **The multi-pick picker** is a new mode of `components/ui/combobox.tsx` (`multiple`), or a sibling component. Today's single-value Combobox closes on commit and keeps its Select-shaped trigger.

## 16. DESIGN.md amendments

1. **Navigation:** "Nav order: Inbox, Tasks, Templates, Skills, Schedules, Usage, Settings, then Agents." **Keyboard shortcuts:** "`g k` Skills."
2. **Components, Provenance:** "Anything fetched from outside the factory shows where it came from and what it is pinned to: the source, a short commit in mono that is a copy button for the full commit (also in its tooltip and accessible name, and shown in full, selectable, in a peek), or 'Live' for host and folder sources. Updates are never automatic: an update view expands in place under the section it changes, lists what changes as + and − lines, and ends in its action. It is never a dialog."
3. **Components, Untrusted text:** "Third-party code and file text (commands, hooks, files, SKILL.md) is shown in full as mono text that is pre-wrap, wraps anywhere, isolates bidi and shows invisible, bidi and control characters as visible tokens, under 'Runs code' first. Third-party prose (descriptions, commit subjects) is Geist with the same bidi isolation and tokens. Neither is ever markdown or links. File text opens at its first line with the message clamp (40 lines, Show all)."
4. **Components, Multi-pick Combobox:** "A picker that adds to a list opens from a ghost Add action in the list's label row, not a Select-shaped trigger. Its popover stays open after each pick; a picked option stays where it is, disabled and marked Added (single-select listbox semantics, never aria-multiselectable), until the popover closes, and is left out the next time it opens. The popover doesn't move while open, and a polite live region outside the popover announces each addition. A footer line says when a rule limits the options."
5. **Components, Peeks:** "A list whose items have no page of their own opens them in a peek: its rows are buttons with aria-expanded, the shown row takes steel-selected, F6 moves focus into the peek and back, and the list keeps the peek's width clear (≥54rem of container) so the shown row stays visible. A peek may step into a related item in place with Back; Back is instant and returns focus to the row it came from; Esc closes the peek."
6. **Components, Long operations:** "A pending label shows elapsed time after 10 s. An operation that can outlast its sheet continues on the server after Close, shows a pending row in its list, and reports its outcome as a toast."

## 17. Delivery

Three stacked PRs on I3's last branch, in a line: `i5/1-library-skills` → `i5/2-plugins` → `i5/3-polish-docs`. Each links this spec, the plan and the decision issue, states its reset step, and deletes what it replaces (Q12).

1. **`i5/1-library-skills`:**
   - §5, §6, §8 for skills, §9.1–§9.2 and §9.4–§9.6, §10 for skills (no view switch until PR 2), §11.1 (route tests), the §6.4 checks (`.claude/skills` plugin check and the `.claude-config/skills` scrub), the §7.3 step 3 checks (project and local settings against §7.10's `RESERVED_SETTINGS_KEYS`, frontmatter hooks on agent-written skills and subagents, and emptying `.claude-config/{agents,commands}`), and §7.10 itself;
   - PR 1 keeps I2's per-agent plugin install and its `pluginsDir` mount class. It adds only §6.5's GitHub-skill mount class (the store class and `storeDir` come in PR 2), and `Effective.library.plugins` is `{}`;
   - `FACTORY_HOST_CLAUDE_DIR` across `config.ts`, `config.test.ts`, the README, `.env.example`, the 8 smoke scripts and the test helpers;
   - `/api/host-skills` deleted;
   - DESIGN.md amendments 1, 2, 3 (SKILL.md and files), 4, 5 and 6.
2. **`i5/2-plugins`.** Starts only after G1 (§13).
   - §7, the plugin parts of §8–§10, §11;
   - the Plugins and Marketplaces views appear;
   - the base image's Claude Code pinned to an exact version (§7.9), before G1;
   - saves enqueue background installs of pinned, missing plugins (§7.5);
   - deleted: `plugins:`, per-agent installs, `plugins-config/`, `linkPlugins`, `readPluginKeys`, the per-agent plugin mounts and the `.claude-config/plugins` symlink.
3. **`i5/3-polish-docs`:** fixes from the evidence pass, plus the product-doc list in §18. Folded into PR 2 if small.

## 18. Product docs and repo follow-ups (a list for the lead; `docs/product` is never edited here)

- **Agent template:**
  - `skills` (Library names, the unusable rules), with `plugins` removed;
  - `enabledPlugins` and `extraKnownMarketplaces` (copied from Skills) and their validation;
  - the factory-owned keys `syncClaudeAiPlugins`;
  - Instantiation.
- **Workspace:**
  - the layout: `state/plugins/` (seed), `state/plugins-runner/`, `state/library/github/`, `.claude-config/plugins/` scrubbed to `data/`, no `plugins-config/`;
  - Library skills and the skills-folder plugin check;
  - plugins installed once and the auto-update stance;
  - the mount classes;
  - residual local risk.
- **Administration:** a new **Skills** section (three views, adding, peeks, updates, removal), and the Templates bullets on skills and plugins.
- **ADR 0017:** a note that skills resolve through the Library.
- **ADR 0024:** the I5 consequences: S2 kept (Q5); Install in factory (Q7); unpinned plugins (Q9); the seed (Q21); no ref (R2); skills-directory plugins refused (R3).
- **Data model:** the two tables.
- **Agent runtime:** the seed env, the reserved env names, the version floor.
- **Base image:** pin Claude Code at or above `CLAUDE_PLUGIN_FLOOR` instead of "latest at build time", and record its version as an image label.
- **I6 path help:** the I5 fields now exist. The README replaces `FACTORY_HOST_SKILLS_DIR` with `FACTORY_HOST_CLAUDE_DIR`.
- **Factory MCP (I7 note):** Library tools are read-only, and `enabledPlugins` is a code-running key.

## 19. Reviews: what changed

The full findings are in the decision issue.

- **Self-review** (2 blockers, 11 major, 17 minor). Applied:
  - B1 (skills-directory plugins; R3);
  - B2 (marketplace name preview);
  - M1 (per-agent plugins root; R1);
  - M2 (no ref; R2);
  - M3 (sync off, reserved env);
  - M4 (dependencies);
  - M5 (lock order);
  - M6 (library in the restart check);
  - M7 (`trees`);
  - M8 (link re-checks);
  - M9 (URL validation for host records);
  - M10 (shallow fetch, clean tree);
  - M11 (G1 rewritten);
  - every minor.

  Minor 16, which suggested reading the new commit's tree instead of the T7 throwaway install, is kept as T7 because external sources need a fetch either way.
- **Taste:** applied H1 (group by source; R4), H2 (picker; R7), H3 (View file from the top), M1 (copy says "Skills"), M2–M6 and L1–L7.
- **Apple:** applied H1 (`g k`), H2 (update in place; R9), M1–M8, M11 (read-only peek; R10), M12 and L1–L7. M9 (`?peek=`) was declined for router state (R6). M10 (rename to Library) was declined by the proxy (R5, for Or).
- **Emil:** applied H1 (R7) and M1–M9, L1–L9.
- **Break UI:** applied B1–B5, U1–U9 and F1–F6, plus the skill Files and SKILL.md gap and the worst-case fixture.
- **Round 2, security re-review** (2 blockers, 10 majors, 14 minors):
  - applied B1 (the user-level skills folder; R12) and B2 (project and local settings; R11);
  - M1 (the check follows every link);
  - M2 and M3 (the dependency closure; R13);
  - M4 (orphan markers and a journal);
  - M5 (a read/write store lock);
  - M6 (taken names include the store and soft-deleted rows; safe boot repair);
  - M7 (tree-based update detection);
  - M8 (an isolated preview);
  - M9 (generated marketplaces replace the template's; every declared marketplace registered; R14);
  - M10 (G1 rewritten);
  - every minor.
- **Round 2, UI re-review** (5 high, 12 medium, 10 low): applied all of them. The view switch becomes a Select at narrow widths. The picker keeps single-select semantics. A failed add keeps a row. Find more skills is inline with no Undo. Wrapping rules, a server-run check-all, server-side elapsed times, the full precedence, prose versus code text, I4-length field copy, the update disclosure, the group move rule, the Marketplace peek check and remove copy, container-query stacking, F6, and every low.

## 20. Decisions

Certainty is on a 1–5 scale. **Bold** marks the decisions for Or's review.

| # | Decision | Certainty |
|---|---|---|
| Q1 | Library in two DB tables (skill sources, marketplaces). Host and template-local are live; pins are columns | 4 |
| Q2 | `skills: [name]` in one factory-wide namespace | 4 |
| Q3 | No aliases. Taken names are refused, and registered entries beat later host skills ("Hidden"). A frontmatter name mismatch makes an entry unusable | **3** |
| Q4 | `enabledPlugins` is the truth and `plugins:` is deleted; `false` is an error in templates and overlays (amends I2 S1) | 4 |
| Q5 | The registry is the runtime truth for sources, and templates carry validated copies. Overlays add only from template marketplaces (I2 S2 kept). Only humans write the Library | 4, **flagged** (overrode the tech-lead's loosening) |
| Q6 | One factory-owned store, read-only to agents. Install on save, from Skills, or at start. Create and spawn never install. Auto-update off | 4; **3** on local read-only |
| Q7 | Host plugins show their host contents. Install in factory registers the marketplace and installs; pickers list store plugins only | **3** |
| Q8 | git CLI, hardened; host credentials only; HEAD verified; no submodules or LFS; 50 MB cap; read-only | 4 |
| Q9 | Never fetch silently: unpinned plugins install only on a click, and the marketplace pin is enforced at install and start | **3** |
| Q10 | Human updates that show a contents diff; no per-template pins; no GC | 4 |
| Q11 | `FACTORY_HOST_CLAUDE_DIR` replaces `FACTORY_HOST_SKILLS_DIR` | 4 |
| Q12 | Three stacked PRs, each with its UI; the reset step and deletions land in the same PR | **3** |
| Q13 | A Skills page with Skills, Plugins and Marketplaces views; peeks; create sheets | 4 |
| Q14 | Row anatomy and states, "Not used", hooks first, zero kinds left out | 4 |
| Q15 | Full hooks and MCP commands; every code-running part; unknown parts named; View file for plugin scripts | 4; **3** on View file |
| Q16 | Pickers without a confirm; agent mode limited to template marketplaces; source and pin on rows | 4 |
| Q17 | Add in two steps (Find, then pick); one source, one pin; inline redacted errors | 4 |
| Q18 | Update views list the changes, with a compare link; check-all runs 4 at a time; updates that drop used entries are refused; removal is refused while in use, else Undo | 4; **3** on refusing updates |
| Q19 | Folder sources keep a fixed picked set; edits show live; new folders come in only through Find more skills | 4 |
| Q20 | A Library skill named like a template-local skill is an error when listed, by a template or an overlay; otherwise that template's picker hides it | 4 |
| Q21 | The store is a Claude Code seed. Explicit `false` for other store plugins. Store installs skip the refresh. Reserved env names. Command, headersHelper and unpinned archive sources refused. Version floor with no fallback. G1 is a hard gate | 4 |
| T1 | The provenance sidecar holds only what `installed_plugins.json` doesn't (marketplace, its commit, who, when) | **3** |
| T2 | Marketplace add and update check out exactly the reviewed commit through `runGit`, never Claude's `marketplace update` | 4 |
| T3 | The store is writable only inside its lock; boot re-applies read-only; a start refuses a writable store | 4 |
| T4 | Removal is a soft delete with a 30 s Undo; purged at boot after a restart | 4 |
| T5 | One `library_changed` frame; no watchers | 4 |
| T6 | Lock order (extended in §9.6); background installs; a failed install is shown and logged | 4 |
| T7 | Update preview installs into a throwaway dir; the applied update must match it, or roll back | **3** |
| T8 | Uninstall is cut from I5 | **3** |
| T9 | Linked subfolders in folder sources are skipped | 4 |
| R1 | A per-agent plugins root, scrubbed to `data/` at start (`mcpb/` too, unless G1 says otherwise) | 4 |
| R2 | No marketplace `ref`; the pin is HEAD plus a clean tree, enforced | 4 |
| R3 | Skills-directory plugins refused everywhere (including agent-written skills); sync off; dependencies pinned; marketplace name previewed | 4 |
| R4 | The Skills list is grouped by source, with a Source peek; the skill peek shows Files and SKILL.md | 4 |
| R5 | The page stays "Skills" (`g k`); user copy never says "Library" | **2** |
| R6 | Fix links land on the item through router state; D11 stands | 4 |
| R7 | Multi-pick picker: trigger in the label row; picked options stay checked and disabled | 4 |
| R8 | Long operations continue after Close, with a pending row and a toast; boot repairs a half add | 4 |
| R9 | Plugin update reviewed in place in the peek; no dialog anywhere in I5 | 4 |
| R10 | A peek opened from the form is read-only, with "Open in Skills" | 4 |
| R11 | Project and local settings that set any `RESERVED_SETTINGS_KEYS` key (factory-owned, command-running, or reserved env names) fail the start, naming file and key; one constant shared with I7's default-deny; the plugin keys go through `--settings` | 4 |
| R12 | `.claude-config/{skills,agents,commands}/` emptied at every start; the plugin check follows every link; agent-written skills or subagents with frontmatter `hooks` (or subagent `mcpServers`) fail the start; Library skills show their frontmatter hooks | 4; **3** on the frontmatter-hooks handling |
| R13 | Dependencies: ranges count as unpinned; post-install closure check; the closure is enabled and tracked | 4 |
| R14 | Every declared marketplace must be registered; the generated marketplaces replace the template's; explicit `false` over every store marketplace's plugins outside the closure | 4 |

## 21. Follow-ups (separate issues)

- Per-source GitHub tokens for private repos (Q8).
- Plugin uninstall, plus garbage collection of old plugin versions and old GitHub checkouts (Q10, T8).
- Removing a single skill from a source (R4).
- Aliases, if a real collision shows up (Q3).
- npm-sourced plugins.
- Revisit whether agents may add plugins from any registered marketplace (Q5), with Or.
- Base image docs: describe the pinned Claude Code version (#160; the pin itself lands in PR 2).
- `permissions.allow` and `autoMode` in agent-written project or local settings let an agent widen its own permissions. That belongs to I2/I7; for Or (§7.10).
- Docker defence in depth: a read-only managed-settings mount with `strictKnownMarketplaces`, `syncClaudeAiPlugins` and the plugin keys (§11.4).
