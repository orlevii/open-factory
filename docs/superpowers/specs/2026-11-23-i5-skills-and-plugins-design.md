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
- "The agent's plugins dir" means `state/agents/<slug>/plugins/`, where Claude Code installs that agent's plugins (§7.2). There is no shared plugin store.
- "Pin" means the commit or tag a declaration fixes; "Latest" means a declaration with no pin, which Claude Code updates at each start (§7.4).
- "Source" means a registered folder or GitHub source of skills.

Web paths are relative to `apps/web/src/` unless they start with `apps/` or `packages/`.

## 1. Goal

Skills and plugins become things you can see, pick and reuse, instead of names typed into YAML and marketplaces declared by hand in `settings.json`.

- **Four skill sources:**
  - host global, live;
  - local folder, linked;
  - GitHub, pinned to a commit;
  - template-local.
- **Plugins** come from factory-wide **marketplaces** that Skills has read at a commit.
- **The Skills page** shows each entry's contents and provenance, and who uses it.
- **Templates** pick a baseline from the Library, and persistent agents add on top (the I2 overlay).
- **Claude Code installs plugins per agent, at start,** into the agent's own plugins dir, at the pin its template declares. Pinned by default; "Latest, auto-update" is an explicit choice. The factory runs no installer (§7, approved by Or on 2026-11-24). #56's "tens of seconds" didn't hold when measured (§7), so #56 is re-scoped rather than closed by a shared store (§18).

### 1.1 Deviations from the task spec (owner-proxy approved; Or can overrule them in one pass)

- **Host-installed plugins aren't selectable as they are** (Q7). They are listed under "On this host", showing their host contents. **Add its marketplace** registers their marketplace, copying the source from the host's own record; the plugin is then pickable from the registered marketplace, at a pin. The task's acceptance criterion still holds: selecting the plugin writes `enabledPlugins` and `extraKnownMarketplaces`.
- **An agent's plugin additions are limited to its template's marketplaces** (Q5; I2 S2 is kept). Agents can still add skills from anywhere in the Library.
- **`plugins:` leaves `template.yaml` and the overlay** (Q4). `settings.json` `enabledPlugins` becomes the only source.
- **No name aliases** (Q3). A taken name is refused when you add the skill.
- **Plugins are pinned by default** (P2). A declaration records the commit Skills read; "Latest, auto-update" is an explicit choice, labelled wherever the plugin shows, and plugins whose catalog entry follows its own source can only be Latest.
- **An update that would drop a skill or plugin in use is refused** (Q18).
- **Skills that are really plugins are refused** (R3). Any folder that has `.claude-plugin/`, wherever it comes from, can't load as a skill, because Claude Code would load it as a plugin with hooks.
- **Uninstall is removing the declaration** (T8). The agent's copy stays on disk, disabled, until Claude Code's own cleanup.

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
   - it shows "Found acme at a1b2c3d" first, with its plugins and whether each can be pinned;
   - a name that is taken or reserved is refused at the preview;
   - Skills keeps a read-only checkout at that commit (`state/library/marketplaces/acme/<sha>/`), and nothing runs Claude Code. Tests use a local fixture repo through `FACTORY_GITHUB_URL`.
9. (PR 2) Selecting a plugin for a template (including a host plugin, after Add its marketplace) writes `enabledPlugins["name@mkt"]: true` and `extraKnownMarketplaces[mkt]` with the registry's source and `ref` set to the commit Skills read (pinned by default). Both are visible in the raw tab. At the agent's first start Claude Code installs the plugin into the agent's plugins dir, and the plugin is listed in its `system/init` (fake Claude in tests).
10. (PR 2) Create and spawn never install, and the factory never runs `claude plugin`. Spawning three agents from a template with a plugin: each `spawn_agent` returns without an install; at each agent's first start fake Claude's log shows one install into **that agent's** plugins dir; a restart with nothing changed installs nothing.
11. (PR 2) The plugin peek lists everything that runs:
    - every hook, with its event, matcher and full command;
    - every MCP server, with its full command and args, or its full URL;
    - dependencies;
    - every other code-running part;
    - "parts Open Factory can't show".
    Then it lists "Needs from the image" (the programs those parts call, with "The agent's image (or this machine, for a local agent) must provide these. Open Factory doesn't install or test them."), skills, commands and agents, and the provenance: marketplace, the commit Skills read, version, and each user's pin. A hook script inside the plugin opens from its first line with View file.
12. (PR 2) Versions:
    - a pinned plugin stays on its pin across restarts (`ref` plus `autoUpdate: false`);
    - moving a template's pin shows the diff of every plugin it changes before the draft changes, and saving restarts the agents that use it, which then run the new pin;
    - "Latest, auto-update" is an explicit choice, with its risk stated, and the "Latest · auto-updates" badge wherever the plugin shows; Claude Code updates it at each start;
    - Claude Code's own self-update is off, and synced plugins are off;
    - a plugin the agent installed itself doesn't load after a restart (explicit `false`).
13. (PR 2) An agent's own plugin, added from its template's marketplaces, is listed under "This agent". The agent picker offers no plugin from any other marketplace.
14. (PR 2) Every local-runtime agent started below the Claude Code version floor (§7.9) fails closed, and so do Docker images below it. The base image pins 2.1.331.
15. (PR 2) A plugin in an agent's closure that isn't in its session's `init` (fake Claude's `install-fail` scenario) leaves the agent running, adds "Plugin x@y didn't load…" to its session, and sends every user one Inbox notice.

## 3. Scope

**In:** the task spec's Scope and Tasks 1–5, the security rules in §11, and Gate G1 (§13).

**Out** (follow-ups in §21):
- a skill authoring studio, ratings or sharing;
- editing a template's `skills/` and `files/` in the UI (#36);
- npm, command, headersHelper and unpinned archive plugin sources (refused, §7.7);
- per-source GitHub tokens;
- garbage collection of old GitHub and marketplace checkouts (old plugin versions in agents' dirs are Claude Code's own cleanup);
- removing a single skill from a source;
- aliases;
- per-plugin pins inside one marketplace (a template pins a marketplace, and its plugins share that pin, §7.4);
- providing or testing the programs plugins call in an agent's image (§7.2);
- testing plugins on the local runtime (supported, not tested);
- I7's MCP tools (I7 wraps the read services in §9).

## 4. Inventory: today → after I5

Today means the I3 branch as specified. The I2 rows describe I2's design, because nothing from I2 or I3 is implemented yet.

| Area | Today (code, or the I2 design) | After I5 |
|---|---|---|
| Host Claude dir | `FACTORY_HOST_SKILLS_DIR` (`config.ts:80`, default `~/.claude/skills`), the README row, `.env.example`, 8 smoke scripts, `config.test.ts` | `FACTORY_HOST_CLAUDE_DIR` (default `~/.claude`). Skills are read from `<dir>/skills`, and host plugins from `<dir>/plugins` (read only). The old variable is deleted everywhere and never read, with no alias (Q11, ADR 0028); like S10's removed variables, it is named in the `REMOVED_ENV` boot warning ("FACTORY_HOST_SKILLS_DIR is no longer read; set FACTORY_HOST_CLAUDE_DIR to the Claude folder.") |
| Skill refs | `skills: [name]`, `hostSkillSchema`, resolved only against the host dir (`links.ts resolveHostSkills`; `validate.ts:158`) | Same field, resolved against the Library: host, folder, GitHub, plus the template's `skills/` (§5) |
| Template-local skills | I2: linked live from `realpath(<tpl>/skills)/<name>`, with a mount exemption (I2 §6.4) | Unchanged, plus the `.claude-plugin/` refusal. Listed in the Library under "Template skills" |
| Host skill list API | I2: `GET /api/host-skills` | Deleted in PR 1. Replaced by `GET /api/library/skills` |
| Plugins key | `template.yaml plugins: [name@mkt]`; overlay `template.plugins` (I2) | Deleted. `settings.json enabledPlugins` is the truth (Q4) |
| `enabledPlugins` | A warning, "ignored: list plugins in template.yaml" (`validate.ts:237`); derived at start from the per-agent install (`settings.ts buildSettings`) | The validated truth: `true` values only, and each marketplace must be declared and registered (§7.4). A factory-owned key in the generated file |
| Marketplaces | Declared by hand in the template's `extraKnownMarketplaces`, with types `directory`, `git` and `github`; `ref`/`path` refused | A factory registry (the `marketplaces` table) with read-only checkouts per commit. Template entries copy the registry's source and add `ref`, the pin (§7.4). `path` stays refused |
| Plugin install | The factory runs `claude plugin install` per agent at create and at start when missing, into `state/agents/<slug>/plugins-config/` (`Workspace.ensurePlugins`, `plugins.ts installPlugins`) | Claude Code installs at agent start into `state/agents/<slug>/plugins/` through `CLAUDE_CODE_PLUGIN_CACHE_DIR` (§7.2). The factory runs no installer. Deleted: `plugins-config/`, `ensurePlugins`, `installPlugins`, `readPluginKeys`, `pluginsConfigDir`, `linkPlugins`, `Effective.templatePlugins`, and the plugin part of `materialize` |
| `.claude-config/plugins` | A symlink to the agent's own `plugins-config/plugins` | Not created. The plugins root is the agent's plugins dir, named by `CLAUDE_CODE_PLUGIN_CACHE_DIR` |
| Docker mounts | The agent's own plugins dir (ro); declared directory marketplaces (ro); host skill dirs (ro) (`mounts.ts`) | The agent's own plugins dir (**rw**); registered directory marketplaces of enabled plugins (ro); every resolved skill dir (ro). Exact-location classes for the GitHub cache (PR 1) and the agent's plugins dir (§6.5) |
| Change flow | I2 `describeChanges(ConfigDoc, ConfigDoc)`; restart check on `started.doc` | Both compare `{doc, library}` (§8); the doc-only part is kept as `describeDocChanges` for the web's pre-save summary |
| UI | I2's combobox over host skills; plugins typed as text | The Skills page (Skills, Plugins, Marketplaces), add sheets, peeks and pickers (§10) |

**Verified on this host** (Claude Code's plugin dir, v2 format):
- `plugins/installed_plugins.json` is `{version: 2, plugins: {"name@mkt": [{scope, installPath, version, installedAt, lastUpdated, gitCommitSha, projectPath?}]}}`;
- `plugins/known_marketplaces.json` is `{name: {source, installLocation, lastUpdated}}`;
- code lives in `cache/<mkt>/<plugin>/<version>/`, and clones in `marketplaces/<name>/`;
- versions can be semver (`6.3.0`) or a 12-hex commit (`0120fb83da5d`);
- one key can have several installs.

**From Claude Code's docs** (code.claude.com/docs/en/plugins/org, /plugins/loading and /plugins/marketplace-reference, read 2026-11-23). Gate G1 (§13) confirms these on the shipped version; G1 still checks each one on the shipped version.
- **`CLAUDE_CODE_PLUGIN_CACHE_DIR`** sets where Claude Code keeps its plugins root (G1 item 3 confirms everything moves with it).
- **The plugins root** holds `data/<plugin-id>/` (`${CLAUDE_PLUGIN_DATA}`) and `mcpb/` (extracted MCP bundles).
- **Auto-update** follows `autoUpdate` on the `extraKnownMarketplaces` entry, then the one in `known_marketplaces.json`, then a default that is on for official marketplaces. `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turn the whole pass off, unless `FORCE_AUTOUPDATE_PLUGINS=1`.
- **A declared marketplace whose source changed in settings is re-fetched**, so a changed `ref` re-fetches at the next start. A SHA `ref` is refused for reserved names such as `claude-plugins-official` (G1 item 4).
- **`command`-source plugins** re-run their command once per session, whatever the auto-update settings.
- **Directory-marketplace plugins** with relative sources load in place.
- **Orphaned versions** are deleted 14 days later, during a later plugin operation.
- **Skills-directory plugins.** A folder under `.claude/skills/` with `.claude-plugin/plugin.json` loads as `<name>@skills-dir`, following the manifest's `defaultEnabled`.
- **Synced plugins** (claude.ai) are on by default, and `syncClaudeAiPlugins: false` stops them.
- **Plugin dependencies.** A plugin can declare dependencies on other plugins.
- **Skill names.** A skill's name "defaults to the directory name", and the frontmatter `name` overrides it.
- An installed plugin with no `enabledPlugins` entry loads by default, following its manifest's `defaultEnabled` (marketplace-reference).
- Dependencies must be enabled, and a dependency with a `version` range resolves to the highest matching git tag (plugins/dependencies).
- A skills-directory plugin also loads from the user-level skills folder, which for an agent is `<workdir>/.claude-config/skills/`.

## 5. The Library model

### 5.1 Tables (Q1)

There are exactly two new tables (`skill_sources` in PR 1, `marketplaces` in PR 2). Host and template-local entries are discovered live and never stored.

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
  source: jsonb,            // {source:"github", repo} | {source:"git", url} | {source:"directory", path}; never a ref or path key
  branch: text null,        // git/github: the branch resolved at preview; Check and fetches use it
  commit: text null,        // the Library's commit (§7.1), what Skills shows and new picks pin to; null only for directory (live)
  committedAt, subject, updateCommit, updateAt, updateSubject, checkedAt, checkError,
  tags: jsonb,              // { [tag]: sha } recorded at preview, Check and Fetch (§7.4); {} for directory
  state: "adding" | "ready", startedAt: timestamptz,  // "adding" while a re-fetch runs (202); boot removes a row still adding
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

`buildMounts` takes `skillPaths` (every resolved skill realpath, read-only) in place of `hostSkillPaths` (PR 1). In PR 2, `pluginsDir` becomes the agent's plugins dir, mounted **read-write**, and `declaredMarketplaceDirs` becomes the registered directory marketplaces of plugins in the closure.

`checkMounts` keeps every refusal it has today, including the I2 template-skill exemption. It gains exactly two classes under `FACTORY_HOME`. Each uses parity targets and must sit at an exact location with every component `lstat`ed from `<FH>/state` down as a directory, never a link:

1. **GitHub skill** (PR 1, read-only). `real` equals `join(realpath(<FH>/state/library/github), <id>, <sha>[, <name>])`.
2. **This agent's plugins dir** (PR 2, **read-write**). `real` equals `realpath(<FH>/state/agents/<slug>/plugins)` for the agent being started, and no other agent's.

Nothing else under `state/` is newly allowed. The refusal message becomes "… isn't this agent's workdir, a registered skill or this agent's plugins dir".

**Tests** (default layout, with `FACTORY_HOME` under `HOME`):
- a GitHub skill mounts;
- `state/library/github` replaced by a link to `~/.ssh` is refused;
- a `<sha>` dir replaced by a link to `state/agents/bob` is refused;
- `…/<id>` (one level up) is refused;
- `state/` is refused, and so are another agent's plugins dir and a plugins dir swapped for a link (PR 2);
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

**The plugin design** (approved by Or on 2026-11-24; it replaces the shared plugin store). Claude Code itself installs and updates plugins, at agent start, into **the agent's own plugins dir**. The factory runs no installer: there is no store, no seed, no store lock, no install journal and no provenance file. The factory owns three things:
- **what is declared:** which plugins, from which registered marketplace, at which pin (§7.4);
- **what Claude Code is told at start:** the factory-owned plugin keys through `--settings` and the plugin env (§7.3);
- **what a human sees before picking:** the plugin's contents, read from the factory's own read-only checkout of the marketplace (§7.8).

Measured on 2026-11-24 (main, G1 item 20, `open-factory-base:dev`, Claude Code 2.1.327, three cold runs each, no credentials): a cold install of a typical plugin costs about 2.5–4 s including the marketplace clone (`superpowers-marketplace` add 1.35–1.48 s plus `superpowers` install 1.04–1.24 s; `claude-plugins-official` add 2.1–2.5 s plus install 0.4–0.5 s; `marker` with a real npm dependency install 0.53–0.61 s, `node_modules/` present). A second install of an installed plugin costs about 0.3–0.4 s. #56's "tens of seconds" doesn't hold for these. Caveat: `marker`'s dependency is tiny; heavy or native dependency trees are unmeasured.

### 7.1 The registry

**Input** (Add marketplace, §10.4):
- GitHub: `owner/repo`, with the §6.2 rules;
- a git URL: `https://` only, with no userinfo, no `?` and no `#` (Claude reads `#` as a ref);
- a local folder: `PathField`, then `resolveHostFolder` and the §6.1 forbidden set.

**Add: a preview, then the add** (T2). Nothing runs Claude Code.

1. **Preview** (`POST /api/library/marketplaces/preview`):
   - git and GitHub: `runGit` resolves the default branch's name and commit and fetches it into a preview (§6.2: shallow, no symlinks, hooks, submodules or LFS, at most 50 MB, read-only). It reads `.claude-plugin/marketplace.json` (`lstat`, at most 1 MB) and returns the name, the commit, its date and subject, and the plugin list, each with whether a pin can hold it (§7.4) or its refused reason (§7.7);
   - a folder: the same, read in place.

   The name is refused if it fails `MARKETPLACE_PATTERN`, is reserved for another source, or is **taken** (a `ready` or `adding` row, or a soft-deleted row inside its Undo window).
2. **Add** (`POST /api/library/marketplaces { previewId }`). Under the Library lock it inserts the row and moves the preview checkout to `state/library/marketplaces/<name>/<sha>/` (read-only, as GitHub skills, §6.2), and returns 201. When the hourly sweep already removed the preview, it re-fetches: the row is `adding` with `startedAt`, the response is 202, and the outcome arrives through `library_changed` (a failure removes the row and sends `addFailed`, as for skill sources). Boot removes a row still `adding`.

**The Library's commit.** `marketplaces.commit` is the commit Skills has read: what the Plugins view and peeks show, and what a new pick pins to (§7.4). It is **not** what agents run; each template's declaration carries its own pin.

**Checkouts by commit.** `state/library/marketplaces/<name>/<sha>/` holds one read-only checkout per commit the factory needs: the Library's commit, and every commit a template or overlay pins. A pin chosen in the form always comes from an existing checkout. A hand-written pin with no checkout shows the warning "Skills hasn't read acme at a1b2c3d." with **Fetch** in the marketplace peek (`POST …/:name/fetch { ref }`, §7.4). Purge removes a checkout only when no declaration and no loaded runtime's `started.library` references it.

**Check and Update** (the Library's commit only):
- Check works as in §6.3: ls-remote on the recorded branch, a preview fetch of a newer commit, and the `update*` columns.
- The update view (§10.3) lists the plugins that change between the two commits: version, `sha` or source changes in the catalog, and, for relative paths, a changed tree (`rev-parse <old>:<path>` against `<new>:<path>`). Plugins whose code-running parts change (hooks, MCP, LSP, status line, monitors, `bin/`, `package.json`, dependencies) are marked "Runs code changed" and listed first.
- **Apply** moves the Library's commit (the preview becomes a checkout). It changes no template's pin and restarts no agent. Templates pinned to an older commit then show "Newer in Skills: e4f5a6b" on their pin (§10.5); moving a template's pin is a reviewed edit in the form.

**Remove.** Refused (409, naming up to three users) while any template or overlay declares the marketplace or enables one of its plugins: "Templates use plugins from acme. Remove them first." Otherwise a soft delete with Undo (§9.4). Agents' own installed copies aren't touched; nothing declares them any more, so they stay disabled (§7.3 step 5).

**Who writes.** Only humans, through REST and the UI, write sources and the registry (Q5). No MCP tool writes them, I7 included (§11.1).

### 7.2 The agent's plugins dir

- **Where.** `state/agents/<slug>/plugins/` (`agentPluginsDir`), created by the factory and outside the workdir. The agent env sets `CLAUDE_CODE_PLUGIN_CACHE_DIR` to it, so Claude Code keeps everything plugin-related there: `installed_plugins.json`, `known_marketplaces.json`, `marketplaces/`, `cache/`, `data/` (`${CLAUDE_PLUGIN_DATA}`) and `mcpb/`. G1 item 3 confirms the whole plugins root moves with the variable.
- **Who writes it.** Claude Code, in the agent's own process, at start (install, update to a new pin, Latest updates) and whenever the agent runs `claude plugin …` itself. The factory never writes it and never reads it except for the two bounded reads in §7.3 (installed keys and manifests, with `lstat` and size caps).
- **It persists.** Installs survive restarts, so a restart with nothing changed installs nothing (about 0.3 s per plugin to confirm, §7 note).
- **Docker.** The dir is mounted **read-write** at its real path, so installs done inside the container persist on the host. It is a new exact-location mount class: this agent's own `state/agents/<slug>/plugins` and nothing else under `state/` (§6.5).
- **Local runtime.** The same dir on the host; Claude Code installs there and **plugin code runs as the host user**. Supported, not tested: no test and no evidence pass installs a plugin on the host (Or's machine included).
- **Create and spawn never install.** `materialize` loses `ensurePlugins`, `rm(pluginsConfigDir)` and the plugin part of `TemplateSource`. `PluginInstallError` leaves `agent-service.ts` and `spawn-service.ts`, and so does `502 plugin_install_failed`. The old `plugins-config/` dir and the `.claude-config/plugins` link are no longer created (reset step, §12).
- **Executables plugins need** (hook commands, `bin/`, MCP server runtimes such as `node`, `npx`, `uvx` and `bun`) must already be in the agent's image for Docker agents, or on the host's `PATH` for local agents. The factory neither provides nor tests them; the plugin peek lists them under "Needs from the image" (§7.8).

### 7.3 What a start does (`Workspace.prepare`)

1. **Version floor** (§7.9).
2. **Enabled set.**
   - `enabled` = the keys of the effective `settings.enabledPlugins` (§7.4).
   - `closure` = `enabled` plus their transitive dependencies, read from the manifests the factory can read: the Library checkout at each declaration's pin (relative-path plugins, and external `sha` sources once fetched, §7.5), and the agent's own installed copies (`installed_plugins.json` → `installPath/.claude-plugin/plugin.json`, inside the agent's plugins dir). The agent can write its installed copies, so **a dependency counts only when its marketplace is one the template declares and Skills has registered**; any other dependency is left out of `closure` and gets the explicit `false`. A dependency first seen after Claude Code installs it is enabled from the next start; G1 item 1 records whether Claude Code needs it enabled.
3. **The agent's own folders** (R12; PR 1, unchanged): `.claude-config/{skills,agents,commands}/` emptied, the `.claude/skills` plugin check, the project and local settings check against `RESERVED_SETTINGS_KEYS` (§7.10), and the frontmatter checks. Nothing in the plugins dir is scrubbed: it is Claude Code's.
4. **Env.** The factory adds:
   - `CLAUDE_CODE_PLUGIN_CACHE_DIR=<agent plugins dir>`;
   - `DISABLE_AUTOUPDATER=1`, so Claude Code never updates itself (the image and host pins stay the truth);
   - `FORCE_AUTOUPDATE_PLUGINS=1` only when a declared marketplace is Latest, because the docs say `DISABLE_AUTOUPDATER` otherwise turns the plugin auto-update pass off too (G1 item 7 confirms the combination);
   - `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` if G1 item 2 shows it makes a headless start install declared plugins before `init`.

   These names, plus `CLAUDE_CODE_PLUGIN_SEED_DIR`, `CLAUDE_CODE_PLUGIN_DIRS` and `DISABLE_UPDATES`, join `FACTORY_ENV_NAMES` (`packages/shared/src/config.ts`), so no template, overlay, secret or project `env` can set them, and `buildAgentEnv` accepts them.
5. **The factory-owned plugin keys** go as an inline JSON string, `--settings '<json>'`, built at each start (carried by `AgentRuntimeSpec.settingsJson`). The file never lands in the workdir or a mount, and holds no secrets. A copy is kept at `state/agents/<slug>/plugin-settings.json` for diagnosis only. Command-line settings outrank local, project and user settings (R11). `buildSettings` drops its plugin inputs. The keys:
   - `enabledPlugins`:
     - `true` for `closure`;
     - an explicit `false` for every other plugin in each declared marketplace's catalog at its pin (relative-path plugins load by `defaultEnabled` otherwise, R14);
     - an explicit `false` for every key in the agent's own `installed_plugins.json` outside `closure`, so a plugin the agent installed itself, or one a template no longer declares, never loads after a restart (G1 item 10);
     - `false` for the manifest name of any skills-directory plugin the factory knows of, as a second layer behind §6.4.

     These are generated, so Q4's "false is an error" doesn't apply.
   - `extraKnownMarketplaces`: **replaces** whatever the template declares. For each marketplace of a plugin in `closure`: the registry `source`, plus `ref` set to the declaration's pin and `"autoUpdate": false` when pinned, or no `ref` and `"autoUpdate": true` when Latest. Nothing else.
   - `syncClaudeAiPlugins: false` (R3).
6. **Docker mounts:**
   - the agent's plugins dir, read-write;
   - the registered **directory** marketplaces of plugins in `closure`, read-only, because their relative-path plugins load in place.
7. **Claude Code installs.** On a cold dir, or after a pin change, Claude Code clones the marketplace at the pin and installs the closure before the session's `init` (G1 items 2 and 6). The factory waits for nothing extra; the start's normal readiness covers it. The harness waits 5 s (`COMMANDS_TIMEOUT_MS`) for the `initialize` response that carries the command list; if G1 item 20(e) shows a cold start exceeds it, starts with an empty plugins dir or a changed pin get a longer wait.
8. **The init check.** When the session's first `init` arrives (with the first turn in stream-json mode, so an agent that never gets a message is never checked), the factory matches each `init.plugins` entry to a closure key by its path: `<P>/cache/<mkt>/<plugin>/<version>/`, or the registered directory marketplace's plugin dir; an entry whose key can't be derived from its path is matched by name within its marketplace (G1 item 1 records the entry shape). For each plugin in `closure` that didn't load (an install that failed, the network down on a cold dir, a pin Claude Code refused):
   - the agent **keeps running** without it;
   - the session gets the event `plugin_not_loaded { key, pin }`, shown in the timeline as "Plugin x@y didn't load. Claude Code's output is in the session log.";
   - every user gets an Inbox `notice` (body "x@y didn't load for @ana."), once per agent start, through `createHumanMessage` (`kind: "system"`, `notice: "plugin_not_loaded"`, `subjectAgentId` the agent, `to: "all"`, no `inboxKind`), so the item is an ordinary notice; then `inbox_changed` to each returned user, as `credentials/expiry-check.ts` does. No new inbox kind.

   The loaded version of each plugin (read from the plugin's manifest at its `init` path) is kept on the runtime as `loadedPlugins: Record<key, version>`, **outside** `started.library`, so it never counts as a config change. The agent config API (`GET /api/agents/:slug/config`) returns it with each plugin's pin (§8.1).

### 7.4 Declarations and pins (`enabledPlugins`; Q4, Q5; amends I2 S1)

- **Shape.** `enabledPlugins` is `Record<string, true>`, with keys matching `PLUGIN_REF_PATTERN`.
  - `false` is an error in templates and overlays: "Remove the plugin instead of turning it off."
  - Any other value is an error.
  - `syncClaudeAiPlugins` in a template or overlay is an error: "The factory sets syncClaudeAiPlugins."
- **Template `settings.json`.** Each key's marketplace must be declared in `extraKnownMarketplaces` ("Marketplace acme isn't declared in settings.json."). **Every** declared marketplace must be added in Skills ("Marketplace acme hasn't been added. Add it in Skills.", with the action **Add from this template**, which opens Add marketplace prefilled), with the same source ("Marketplace acme's source differs from the one in Skills."). Sources compare as exact JSON, with `ref` left out of the comparison. `path` stays refused.
- **The pin** is the declaration's `source.ref`, the one per-declaration pin Claude Code accepts (this reverses R2):
  - a 40-hex commit, or a tag name (the §6.2 ref-format rules; a `refs/heads/…` ref is refused: "Pin acme to a commit or a tag.");
  - absent means **Latest**.

  Offline, a bare name can't be told from a branch, so the factory checks it when it reads the marketplace. Preview, Check and **Fetch** (`POST …/:name/fetch { ref }`, a 40-hex commit or a tag) run `ls-remote <url> refs/tags/<tag> refs/tags/<tag>^{}` and record `tags: { [name]: sha }` on the row. A tag pin resolves through that map to its checkout. A `ref` that is neither 40-hex nor a recorded tag shows "Skills hasn't read acme at <ref>; fetch it in Skills." When Fetch finds that `<ref>` is a branch (`refs/heads/<ref>` exists) and not a tag, it refuses: "Pin acme to a commit or a tag."

  So there is **one pin per marketplace per template**: every plugin from acme in template dev runs at the same commit. A plugin is **held by the pin** when its catalog entry is a relative path, an external `github`, `url` or `git-subdir` source with a `sha`, or an `archive` with a `sha256`, and every dependency is held the same way with no version range (a range resolves to "the highest git tag that satisfies this range"). Otherwise it **follows its source**: it can only be used as Latest, and the picker says "Can't be pinned: it follows its own source."
- **Pin by default.** Picking a plugin in template mode whose marketplace isn't declared yet writes `extraKnownMarketplaces[mkt] = { source: registry.source, ref: <the Library's commit> }`. If the marketplace is already declared, the plugin joins that pin. **Latest** is a separate, explicit choice on the marketplace's pin control (§10.5), with its risk stated next to it.
- **Directory marketplaces** are live (the operator's own files): no `ref`, shown as "Local folder, live", and not a Latest warning.
- **A pin Claude Code refuses.** The docs say a commit `ref` is refused for reserved names such as `claude-plugins-official`. G1 item 4 records exactly which pins Claude Code accepts for which marketplaces; `OFFICIAL_MARKETPLACES` records the result, and a refused pin kind is a validation error, "Claude Code can't pin acme to a commit; use a tag or Latest.", with the picker offering only what works.
- **Default pin when commits are refused.** The first pick writes the newest recorded tag that points at the Library's commit. If no tag points there, the pick is refused in the picker footer with "acme can only be pinned to a tag. Fetch a tag in Skills, or use Latest.", and Latest stays the explicit alternative.
- **Latest is a warning, not an error:** "Plugin x@y follows the latest acme: new code runs at each restart without review."
- **Overlay** (`settings.enabledPlugins`, unioned by I2's object merge). Each key's marketplace must be declared by the **template**: "Marketplace acme isn't declared by template dev." (I2 S2). Overlay plugins run at the template's pin. `extraKnownMarketplaces` stays an error in overlays, so an agent can't repin.
- **Refused sources.** A key whose catalog entry uses a refused source (§7.7) is an error: "Plugin x@y uses a command source, which Open Factory doesn't install."
- **A pin Skills hasn't read** is a warning: "Skills hasn't read acme at a1b2c3d; fetch it in Skills." Saves never touch the network.
- **Schema.** `templateYamlSchema` and `overlayTemplateSchema` drop `plugins`, and `TemplateConfig.plugins` is deleted. Readers call `effectivePlugins(doc)`. The old "enabledPlugins is ignored" warning is deleted.
- **Form writes.** Selecting a plugin in template mode sets `enabledPlugins[key] = true` and, if needed, the pinned declaration above. Removing the last plugin of a marketplace leaves its declaration in place.

### 7.5 Versions and updates

- **Pinned:** the plugin stays at its pin across restarts. Claude Code doesn't update it (`autoUpdate: false` and a `ref`; G1 item 5).
- **Repin.** A template's pin moves only through a reviewed edit in the form (§10.5): "Update pin to e4f5a6b…" shows the diff of every plugin the template uses from that marketplace, then writes the new `ref` into the draft. Saving runs I2's change flow: "plugin x@y repinned a1b2c3d → e4f5a6b", and the agents restart when idle. At the next start Claude Code re-fetches the marketplace at the new `ref` and installs the new versions (G1 item 6). Old versions stay in the agent's dir until Claude Code's own orphan cleanup.
- **Latest:** Claude Code updates the marketplace and its plugins at each start (`autoUpdate: true`, `FORCE_AUTOUPDATE_PLUGINS=1`; G1 item 7 records when, to what, and the output). The factory neither reviews nor records the update in advance. What loaded is read from `init` (§7.3 step 8) and shown as "Latest · running 1.3.0".
- **Diffs** come from the factory's own checkouts, never from running Claude Code. A relative-path plugin is read from the two marketplace checkouts. An external `sha` source is fetched with `runGit` (github, git URL, git-subdir; §6.2 rules and caps) into `state/library/plugin-sources/<hash>/<sha>/`, read-only, on demand when a human opens its peek or a diff. The diff lists hooks, MCP servers, commands, dependencies, code parts and "Needs from the image" added or removed.
- **Uninstall** is removing the plugin from the template or overlay. The agent's copy stays on disk, disabled by the explicit `false` (§7.3 step 5), until Claude Code's orphan cleanup.

### 7.6 Host plugins (Q7)

- `HostPlugins.list()` reads `<FACTORY_HOST_CLAUDE_DIR>/plugins/installed_plugins.json` and `known_marketplaces.json` (`lstat`, size caps).
  - Each distinct key is listed once, with the install whose `lastUpdated` is newest (versions may be hashes).
  - Contents are read from its `installPath`, which must be inside `realpath(<hostdir>/plugins/cache)` or a host directory marketplace. Otherwise the contents read "Can't show: outside the host's plugin folder."
- **A key whose marketplace is registered** isn't listed under "On this host". Its Library peek adds "Also on this host (1.2.0)."
- **Add its marketplace** (a human click, the only action): it validates the host's `known_marketplaces[mkt].source` with the §7.1 input rules (`https://` only, no userinfo, query, fragment, `ref` or `path`; otherwise "The host's record for acme can't be used: …"), then runs the §7.1 preview and add from it. The plugin is then pickable like any other. Nothing is installed, and nothing is read, copied or linked out of the host's plugin folders beyond the two JSON files and the confined contents read.

### 7.7 Auto-update, sync and refused sources (Q6.2, Q21, R3)

**Auto-update**, per declaration:
- pinned: `ref` plus `"autoUpdate": false`;
- Latest: no `ref` plus `"autoUpdate": true`, and `FORCE_AUTOUPDATE_PLUGINS=1` in the env;
- Claude Code's own self-update is always off (`DISABLE_AUTOUPDATER=1`); the reserved env names keep a template or project from changing any of this.

**Sync off:** `syncClaudeAiPlugins: false` in every agent's generated settings. Agents signed in through I3 would otherwise load claude.ai-synced plugins by default.

**Refused plugin sources**, at pick, validation and in the catalog view:
- `npm` (out of scope);
- `command`: the docs say Claude re-runs it once per session, regardless of auto-update settings;
- any entry with `headersHelper`;
- `archive` without `sha256`.

The message is "Plugin x@y uses a <kind> source, which Open Factory doesn't install."

**Refused marketplace sources:** `url`, `file`, `npm` and `settings`. Only `github`, `git` and `directory` are accepted.

### 7.8 Plugin contents (`library/plugin-contents.ts`)

`readContents(root)` reads with `lstat` and never follows a link. Each JSON is at most 256 KB, and the walk stops at 2,000 files. The root is a factory checkout (§7.1, §7.5) or a confined host `installPath` (§7.6), never an agent's plugins dir. Its output:

- **Manifest:** `.claude-plugin/plugin.json`: name, version, description, author, homepage, repository, `dependencies`.
- **Hooks:** `hooks/hooks.json`, plus `plugin.json` `hooks` (inline or a path). Each hook gives its event, matcher (empty shows "All"), type, full command and timeout.
- **MCP servers:** `.mcp.json`, plus `plugin.json` `mcpServers`. Each server gives its name and kind, then either the full command with args and env (names, plus values that aren't `${…}` references, since `NODE_OPTIONS=--require …` is code), or the full URL with header **names** only.
- **Other code-running parts:**
  - `lspServers` / `.lsp.json`;
  - `statusLine`;
  - `monitors/monitors.json`;
  - `bin/` executables (exec bit, top two levels);
  - a `package.json`, shown as "Installs Node dependencies".
- **Needs from the image:** the programs the code-running parts call, so an operator can check the agent's image: the first word of each hook and status-line command (after `bash -c`/`sh -c`, the first word of the script), each stdio MCP server's command, each LSP command, `node` for a `package.json`, and `bin/` itself. It is a best-effort list of names (`node`, `npx`, `uvx`, `bun`, `python3`…), shown with the note "The agent's image (or this machine, for a local agent) must provide these. Open Factory doesn't install or test them." `${CLAUDE_PLUGIN_ROOT}/…` paths are the plugin's own files, not needs.
- **By name:** skills, commands, agents, output styles, plus the custom paths `plugin.json` declares.
- **`unshown`:** every part that couldn't be read is listed in "This plugin has parts Open Factory can't show: <list>" (Q15.1, Break B2). That covers an unknown `plugin.json` key, a link (`hooks/hooks.json (a link)`), JSON over the cap, unparseable JSON, and a walk stopped at 2,000 files. "Runs no hooks or servers." appears only when everything was read and nothing runs. `contentsSummary` carries an `unshown` count.
- **`files`:** each `${CLAUDE_PLUGIN_ROOT}/<rel>` that a hook or MCP command references and that resolves to a regular file inside the root (realpath and `lstat`). This drives **View file**. `GET …/file?path=` returns at most 256 KB of text, refuses links and binaries, and serves only paths in this list.
- **An external source not fetched yet** shows "Contents not read yet" with **Read contents**, which runs the §7.5 fetch.

The result is cached in memory by checkout path, which is immutable per commit.

### 7.9 Claude Code version (Q21)

- **The pin.** The base image pins Claude Code to an exact version in `images/base/claude-code-version`: **2.1.331** (Or's choice, matching Or's local Claude Code). The workflow never resolves "latest", and the image carries the version label. The repo's release-age rule for dependencies doesn't apply to this pin while the project is pre-release.
- **The floor.** One floor, the harness's `MIN_CLAUDE_VERSION` (`packages/harness/src/claude/version.ts`), checked by the server's `assertPluginFloor` on top of the harness check; there is no second constant. It is the lowest version where G1's pass/fail items hold (§13 item 21: per-agent plugins dir, install at start, pins and Latest, settings precedence, and sync off when item 19 was tested). Until G1 item 21 records an older passing version, **the floor is the pin, 2.1.331**.
- **Who is checked:**
  - **every** local-runtime agent at start (the host's `claude`), not only those with plugins, because synced-plugin suppression and the skills-folder rules matter for any agent signed in through I3;
  - Docker images, once per image digest, by `docker run --rm --network none --entrypoint claude <image> --version`, cached.
- **Below the floor**, the start fails closed: "Claude Code {found} is too old; update it to {MIN_CLAUDE_VERSION} or later." Both versions are interpolated. There is no fallback (ADR 0028).

### 7.10 `RESERVED_SETTINGS_KEYS`: the one list (R11)

`packages/shared/src/settings-keys.ts` exports `RESERVED_SETTINGS_KEYS`: the settings keys that are factory-owned or that run commands. It is the **same constant** I2 hands I7 as the `agent` policy's default-deny list (I2 §5.3, §19), so the start check and I7's policy can never drift. It holds:

- **Factory-owned:**
  - `enabledPlugins`, `extraKnownMarketplaces`, `syncClaudeAiPlugins`, `strictKnownMarketplaces`;
  - `permissions.defaultMode`, `permissions.additionalDirectories`, `claudeMdExcludes` (I2's factory keys).
- **Running commands** (every key the settings reference marks "Any file" and describes as running a command or executable, checked against the shipped version's settings reference):
  - `hooks`, `statusLine`, `fileSuggestion`;
  - `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`.
- **`env`:** any entry whose name `isFactoryEnvName` accepts (`FACTORY_ENV_NAMES` or the `OPEN_FACTORY_` prefix), so a project `env` can't redirect `CLAUDE_CODE_PLUGIN_CACHE_DIR` or change the auto-update rules.

Templates and overlays keep I2's rules (templates are trusted operator input; overlays refuse the factory keys). The start check (§7.3) refuses **every** key in this list in agent-writable project and local settings. The plan's first PR 1 task re-reads the shipped version's settings reference and updates the list, and a test pins it.

`permissions.allow` and `autoMode` in project or local settings would let an agent widen its own permissions. That is I2's and I7's territory, so it isn't added here: Or decided to defer it (#162, §21), and I5 adds no start check for them.

## 8. Change flow integration

### 8.1 `Effective.library`

`ConfigResolver.effective` (I2 §6.1) adds:

```ts
library: {
  skills: Record<string, string>;   // name → "host" | "folder" | "template" | "github:<sha>"
  plugins: Record<string, string>;  // key → its pin: "commit:<sha>" (full 40-hex) | "tag:<name>" | "latest" | "live" (directory)
}
```

`plugins` covers the enabled keys plus the dependencies read from the Library checkouts at each pin (the resolver has no agent plugins dir; installed-copy dependencies only feed the start's settings). It is resolved through `LibraryIndex` and the effective declarations, and `started` keeps it. Change lines shorten the sha. The loaded versions live outside it (§7.3 step 8), so a Latest plugin's new version is never a change.

### 8.2 Comparing (self-review M6)

I2's `describeChanges` and the restart check take `{ doc, library }` on both sides:

```ts
describeChanges(a: { doc: ConfigDoc; library: Library }, b: { doc: ConfigDoc; library: Library }): string[]
```

The restart decision is `describeChanges(runtime.started, after)` being non-empty, so a skill or plugin repin restarts the agents that use it.

Today's doc-only body is kept as `describeDocChanges(a: ConfigDoc, b: ConfigDoc)`, and `describeChanges` is `[...describeDocChanges(a.doc, b.doc), ...libraryLines]`, sorted. The web's pre-save summary (`config-page.tsx`) has no library client-side, so it uses the doc-only part. Every server caller (`agent-runtime.ts` `requestRestart`, `config-changes.ts` `templateChanged` and `apply`) moves to `{doc, library}`, through a `currentEffective()` port that replaces `currentDoc()`. A `libraryChanged` also rescans templates, so a template's stored issues don't go stale when a skill it lists goes missing.

New lines, sorted and secret-safe:
- "skill x updated a1b2c3d → e4f5a6b";
- "skill x now from GitHub" (the source kind changed);
- "plugin x@y repinned a1b2c3d → e4f5a6b" (a tag shows by name);
- "plugin x@y now follows the latest acme" / "plugin x@y pinned to a1b2c3d";
- "added plugin x@y" / "removed plugin x@y", from `enabledPlugins`.

`summarizeChanges` counts these under skills and plugins.

### 8.3 Library-driven changes

`ConfigChanges.libraryChanged({ skills?, by })` runs after a GitHub skill update and an Undo that restores a name. It always runs **after** the Library lock is released (§9.6). Plugins never go through it: a marketplace update moves only the Library's commit, and a pin moves only through a template or overlay save, which is I2's change flow.

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
- **`GET /api/library/plugins`** (PR 2) returns `{ marketplaces: { name, commit, plugins: PluginEntry[] }[], host: HostPluginEntry[] }`.
  - A `PluginEntry` is a catalog entry at the Library's commit: `key`, version, `pinnable` (held by a pin, §7.4), `refusedReason?`, `contentsSummary` (counts per kind, plus `unshown` and `needs`), `usedBy` with each user's pin, and a `state`.
- **`GET /api/library/plugins/:key?commit=`** returns the full contents and provenance at that commit (default: the Library's). With `?from=host` it reads the host copy.
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

- **`POST /api/library/marketplaces/preview`**, then **`POST /api/library/marketplaces { previewId }`**, which returns 201, or 202 with an `adding` row when it must re-fetch (§7.1).
- **`POST …/marketplaces/:name/check`**, then **`…/update { commit }`** (moves the Library's commit). **`POST …/:name/fetch { ref }`** reads a pinned commit or tag Skills hasn't read (refusing a branch). **`DELETE …/:name`** removes it, with Undo.
- **`POST /api/library/plugins/:key/diff { from, to }`** returns the contents diff between two commits of its marketplace (§7.5); it may fetch, so it is a POST and a mutation on the web.
- **`POST /api/library/plugins/:key/read { commit }`** fetches an external `sha` source so its contents can be shown (§7.8).
- **`POST /api/library/host-plugins/:key/add-marketplace`** runs §7.6's Add its marketplace and returns 201.

### 9.4 Removal and Undo (Q18, T4)

- **`DELETE /api/library/sources/:id`** (and the marketplace equivalent):
  - refused with 409 `in_use` when the source is used, naming at most 3 users ("Used by template dev, @ana and 188 more.");
  - otherwise it sets `deletedAt` and returns `{ undoUntil }`, 30 s ahead. During the window the entry is gone from pickers and lists.
- **`POST …/:id/restore`** works while `now < undoUntil`. It is refused if another entry has taken one of the names in the meantime.
- **Purge.** A 30 s one-shot, the hourly timer and boot purge the rows past their window (no Undo survives a restart).
  - Purge removes the cache dirs through `SafeFs.removeAll` after a chmod. For a marketplace it removes its checkouts.
  - Purge skips a cache dir that a loaded runtime's `started.library` still references, and retries on the next timer.
- **The toast** carries Undo for exactly `undoUntil − now`; hovering doesn't extend it past what the server can restore. **Undo of an add** calls `DELETE` (a source that was just added is unused).

### 9.5 Live updates

The new WS frame `{ type: "library_changed" }` is published after every Library write and every check result. The web then invalidates the `["library"]` queries. The frame carries an optional `addFailed: "owner/repo"`, sent only when a background (202) GitHub add failed and its row was removed; the web then shows the toast "Couldn't add <repo>." The host and template-local lists have no watcher; they refresh on window focus and on I2's template change event (T5).

### 9.6 Locks (self-review M5)

- **Total order:** workspace (per slug) → Library. Each is its own `KeyedMutex` instance. There is no store lock: the factory never writes plugins.
- Code holding the Library lock never takes a workspace lock and never awaits a runtime job.
- `ConfigChanges.libraryChanged` runs only after the Library lock is released.
- A start reads Library checkouts without the Library lock: checkouts are immutable per commit, and purge skips any a loaded runtime's `started.library` or a declaration references.

## 10. Web

Every task that touches the web names `vercel-react-best-practices` for both implementer and reviewer (§15).

### 10.1 Navigation and header

- **Sidebar.** The `nav` gains **Skills** (icon `Blocks`) between Templates and Schedules. Its shortcut is `g k`, listed in the shortcuts sheet and in the palette's Go to group. `g s` stays Schedules.
- **Routes** (code-split by the router's `autoCodeSplitting`, never a hand-written `lazy()`): `/skills` in PR 1, then `/skills/plugins` and `/skills/marketplaces` in PR 2.
- **`SkillsHeader`** holds:
  - the h1 "Skills";
  - the view switch "Skills | Plugins | Marketplaces" (`SegmentedLinks`). PR 1 has a single view, so it renders no switch until PR 2;
  - **Check for updates** (ghost, `RefreshCw`);
  - **Add skills** on the Skills view, or **Add marketplace** on the Marketplaces view. The Plugins view has no add action, because plugins come from marketplaces and are picked in a template's Configuration form.
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

**Plugins view.** One group per registered marketplace, headed by its name and the commit Skills read ("acme · a1b2c3d", or "Local folder, live"), listing its catalog at that commit; then "On this host" (host plugins whose marketplace isn't registered).
- **Row:** `name@mkt`, then the version (a hex version shows as "commit 0120fb8"), then the contents line, then users ("Used by 3 templates · 12 agents"; "2 use Latest" as its own item when any user is Latest), then state.
- **Contents line:** hooks first, zero kinds left out, "Parts not shown" first when `unshown > 0` (a contents fact with a warning icon, not a row state). When everything is zero: "Nothing to show".
- **Empty view:** "No plugins yet. Add a marketplace to pick plugins." with a link to Marketplaces that opens Add marketplace.

**Marketplaces view.** Each row shows:
- the name (mono);
- the source: repo, or host plus path of the URL, or folder path (mono, `MiddleTruncate`);
- the commit Skills read, or "Live";
- "12 plugins" · "Used by 3 templates";
- the state.

A pending add (a re-fetch, §7.1) is its own row, "Adding acme… 0:42", with a spinner. A failed add removes the row and shows the toast "Couldn't add acme.", as for skill sources.

**States.** One state per row, by precedence; any further state shows in the peek. Each state is a word plus an icon, never colour alone, and never signal orange:

| State | Icon / colour |
|---|---|
| Adding…, Checking… | muted spinner (+ elapsed after 10 s) |
| Missing, Unusable, Couldn't check, Can't use | `CircleAlert`, crimson |
| Update available | `ArrowUpCircle`, info |
| Hidden, Can't be pinned | `TriangleAlert`, warning |

The precedence is Adding… > Checking… > Missing > Unusable > Can't use > Couldn't check > Update available > Hidden > Can't be pinned. "Can't use" is a refused source (§7.7); "Can't be pinned" is a plugin that follows its own source (§7.4). Latest is not a row state: it belongs to a template's declaration and shows as the "Latest · auto-updates" badge (§10.5) and the "2 use Latest" usage item.

Elapsed times come from the server's `since` (`startedAt`), so a reload or navigation doesn't reset them. Elapsed = now − since, and the tick isn't rendered while the tab is hidden (UI r2 M3).

**Empty, loading and error states:**
- Skills empty: "No skills yet. Add some, or put a folder in `<hostDir>/skills`." The path comes from the API.
- Marketplaces empty: "No marketplaces yet. Add one to pick plugins."
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
- **Header:** `name@mkt`, the version at the commit shown, the description, and the contents line (so the scale shows before scrolling). When the peek shows a commit other than the Library's (opened from a pinned row), the header says "At a1b2c3d".
- **Runs code** comes first and never collapses:
  - **hooks:** below a 28rem container (`@max-[28rem]` on `SheetBody`, never the viewport) the event and matcher stack above the command;
  - **MCP servers:** the kind, the full command, args and env, or the full URL with header names;
  - **dependencies;**
  - **LSP, status line, monitors, executables, Node dependencies;**
  - **"This plugin has parts Open Factory can't show: …".**

  With nothing in it, the section reads "Runs no hooks or servers."
- **Needs from the image** (§7.8), right after Runs code when it isn't empty: the program names as a wrapping mono run, then the note "The agent's image (or this machine, for a local agent) must provide these. Open Factory doesn't install or test them."
- **While the detail query loads**, static skeleton rows render at their real heights from `contentsSummary` counts, so the section doesn't jump.
- **Provides:** skills, commands, agents and output styles, in wrapping mono runs. Past 20 per kind: "Show all 34".
- **Provenance:** marketplace, its source, and the commit Skills read (a copy button, as above), or "Local folder, live"; "Can't be pinned: it follows its own source." when that applies; "Also on this host (1.2.0)".
- **Used by:** each template with its pin ("dev · pinned a1b2c3d", "ops · Latest" with the badge), and the agents that add it.
- **Footer:** nothing for a registered plugin (plugins are picked in the form). A host plugin whose marketplace isn't registered has **Add its marketplace** (with "Registers acme from this host's record. Nothing is installed." above it).
- **View file:** one toggle button (`aria-expanded`) whose label flips between View file and Hide file, so focus never moves. The text opens **from its first line** inside a plate with a rule and is clamped at 40 lines with "Show all · N lines". When the server cut the file, it says "Cut at 256 KB."
- **Opened from the Configuration form** (R10), the peek is **read-only** and shows the plugin at that template's pin: no actions and no Used by links. It ends with "Open in Skills", which navigates (the form's leave guard applies) and lands on the item (§10.7).

**Marketplace peek:**
- the source and the commit Skills read, with the copy button, or "Live";
- the update view in place, for the Library's commit: the plugins that change, "Runs code changed" first (§7.1). Its primary is "Update Skills to e4f5a6b", with the note "Templates keep their pins. Move a pin in the template's Configuration.";
- "Pinned by templates": each template and the commit it pins, with "older" when it isn't the Library's commit;
- "Skills hasn't read a1b2c3d" lines for hand-written pins, each with **Fetch**;
- its plugins, each opening in place with **Back**. Back is instant and returns focus to the row it came from; Esc closes the whole peek;
- **Check for updates**, a ghost action in its Source section's label row;
- Remove, with the same in-use rule as a source: "Templates use plugins from acme. Remove them first."

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
- **Step 1, Find marketplace.** The preview shows "Found acme at a1b2c3d · main · <subject>", then its plugins, each with its version, its contents line, and "Can't be pinned" or "Can't use: command source" where those apply.
- **Step 2, Add marketplace.** Usually instant: the sheet closes and the toast reads "Added acme at a1b2c3d." with Undo. When the preview was swept and it must re-fetch, the sheet closes at once, the Marketplaces list shows "Adding acme… 0:42", and the outcome is a toast ("Couldn't add acme." on failure; amendment 6).

### 10.5 Pickers in the Configuration form (replaces I2 §12.2's "Skills and plugins"; R7)

- **Trigger.** A ghost **Add skill** / **Add plugin** action (with a Plus icon) in the label row of the "This agent" group (agent mode) or of the list (template mode). Rows append below it, so the trigger never moves.
- **Popover.** A filter field at a fixed height and two-line options:
  - line 1: the name (mono, wraps);
  - line 2: the description (skills) or the version and contents line (plugins), muted, one line, `truncate`. A plugin that can't be pinned adds "Can't be pinned".

  Skills are grouped by **source**, as on the page: Host, then each folder or GitHub source, with a `MiddleTruncate` heading and no per-option tag. Plugins are grouped by marketplace.

  The list keeps cmdk's single-select listbox semantics; it is never `aria-multiselectable`, because cmdk sets `aria-selected` on the highlight (UI r2 H2). A picked option gets `aria-disabled` and the visible and sr text "Added".
- **Empty states:** "Every skill is already added." / "No skills in Skills yet." / "No plugins in dev's marketplaces." A muted footer line counts what was left out and why: "3 skills can't be used here: hidden or unusable."
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
  - The picker lives in I2's `SkillsSection` (`features/config/skills-section.tsx`). Selected rows are I2 `ConfigList` rows that add their source and pin ("GitHub · a1b2c3d") and any state ("Missing", "Hidden").
  - Template-local skills stay read-only, labelled "Template skill".
- **Plugins:** plugins of **registered** marketplaces, at the Library's commit (Q7). Refused sources are left out (counted in the footer).
  - Template mode lists every registered marketplace's plugins, with the footer "Add marketplaces in Skills".
  - Agent mode lists only plugins from the template's declared marketplaces, with the footer "Only plugins from dev's marketplaces. Add more in the template."
  - Selected rows are grouped by marketplace. Each row shows `name@mkt`, the version at the pin, the contents line, any "Needs from the image" count ("Needs node, uvx"), and **View**, which opens the read-only plugin peek at that pin (R10).
- **The pin control** (template mode; P1, P2), once per marketplace group, in the group's label row:
  - pinned: "Pinned · a1b2c3d" (the copy-button short sha) plus a ghost menu button "Change pin". When Skills has read a newer commit, the label adds "Newer in Skills: e4f5a6b";
  - Latest: a **"Latest · auto-updates"** badge (`TriangleAlert` plus the words, warning tone, never colour alone; the icon is `aria-hidden`, the visible words are the text, and the `·` is an `aria-hidden` span with a visually hidden comma) plus "Change pin";
  - "Change pin" offers "Pin to e4f5a6b (newest in Skills)…", "Use Latest, auto-update…" and, when Latest, "Pin to e4f5a6b…". Each opens its review **in place** under the group (DESIGN.md Provenance), never a dialog:
    - **Pin to …:** the diff of every plugin this template uses from the marketplace between the two commits (`+`/`−` lines, "Runs code changed" first), then the primary "Pin to e4f5a6b", which writes `ref` into the draft. Saving the form applies it (I2's change flow restarts the agents);
    - **Use Latest:** the text "Latest runs acme's newest code at each restart, without review, with each agent's workspace and credentials in reach." and the primary "Use Latest" (crimson ghost), which removes `ref` from the draft (the factory sets `autoUpdate` at start);
  - each review opens with focus on its heading ("Pin acme to e4f5a6b" / "Use Latest for acme", `tabindex=-1`), the rule Add skills' results use. It ends with its primary and a ghost **Cancel**. Cancel, Esc inside the review, or the primary closes it and returns focus to "Change pin". After the primary, the label row shows the new state and the form's dirty footer takes over. While the diff loads, the review shows static skeleton lines and the primary is disabled;
  - a plugin that can't be pinned can only join a Latest declaration; picking it under a pinned one shows "x@y can't be pinned. Switch acme to Latest to add it." in the picker footer, announced in the picker's polite live region, instead of adding it;
  - a directory marketplace's group shows "Local folder, live" and no Change pin;
  - **narrow widths:** line 1 is the marketplace name; the pin facts wrap after it as items; "Change pin" stays the last item and never splits. A review's hook rows use the peek's `@max-[28rem]` stacking.
  - Agent mode shows the template's pin read-only on the "From template dev" group, with the same badge.
- **The badge everywhere.** A Latest plugin shows the "Latest · auto-updates" badge in the form, in the plugin peek's Used by, and on the agent's config page with "running 1.3.0" from `init` (§8.1).
- **Picking writes the draft** (§7.4). Agent mode keeps I2's "From template dev" and "This agent" groups.

### 10.6 Untrusted text (UI r2 M5)

Third-party text comes in two kinds. Neither is ever rendered as markdown or linkified, and both tokenise invisible, control and bidi code points: U+202A–202E, U+2066–2069, zero-width characters and C0 controls show as ⟨U+202E⟩, ⟨ESC⟩ and so on.

- **Code and file text** (commands, hook matchers, args, env, URLs, View file, SKILL.md): mono, `white-space: pre-wrap`, `overflow-wrap: anywhere`, `unicode-bidi: isolate`, `dir="ltr"`. What a human reviews is then exactly what runs (Break B3).
- **Prose** (descriptions, commit subjects, plugin descriptions): Geist, `unicode-bidi: isolate`, `dir="auto"`. Mono is only for identifiers and code (DESIGN.md Typography).

The only links on these surfaces are the GitHub compare link and links to factory routes.

### 10.7 Fix links and arrival (R6)

A `library` fix navigates to the item's view and passes `{ peek: item }` in router state, not in the URL (D11 stands). The view:
1. scrolls the row to the centre;
2. focuses it with the deep-link arrival (a 6% signal tint for 2 s), reusing I3's `lib/use-arrival.ts` (`arrive`, `useArrivalTint`), as the credentials page does;
3. opens its peek. A second arrival on an already-mounted view (a new `location.key`) opens its peek too.

"Open in Skills" from the form does the same.

### 10.8 Motion

- Peeks and sheets follow DESIGN.md. Results, update views, View file and "Show all" appear instantly.
- Spinners appear only beside a pending label, and show elapsed time after 10 s, paused while the tab is hidden.
- At 390px and at 200% text there is no horizontal scroll anywhere.

## 11. Security summary

### 11.1 Who can change what

- **Humans only** write skill sources, the registry and the declarations' pins, through REST in a user session (Q5).
  - Library routes take no agent token, and the MCP server registers no Library tool.
  - PR 1 adds a route test: an agent bearer token gets 401 on every Library route.
- **Agents** reference entries only through overlays, which a human saves (or, from I7 on, a `manage_org` agent saves), and plugins only from their template's marketplaces.
- **I7 note:** assigning `enabledPlugins` adds hooks, so I7's `agent` policy must treat it as a code-running key.

### 11.2 Supply chain

- **GitHub skills** are pinned to a verified commit. Fetches are capped, run without symlinks, hooks, submodules or LFS, and the checkout is read-only.
- **Marketplaces** are read by the factory at a verified commit into read-only checkouts, with the §6.2 hardening; the factory never runs Claude Code for them.
- **Plugins:**
  - Claude Code installs them per agent, at start, from the declared marketplace at the declaration's pin. A template pins by default (the commit Skills read), and Claude Code stays there (`ref`, `autoUpdate: false`; G1 items 4–5).
  - Moving a pin shows the diff first, and goes through a human-saved template.
  - **Latest** is an explicit, labelled choice. Its upstream code runs at the next restart without review, with the workspace and the agent's credentials in reach; the choice says so where it is made (§10.5).
  - A plugin whose catalog entry follows its own source, or has a ranged dependency, can only be Latest.
  - Refused: command, headersHelper, npm, and archives without sha256.
- **Claude Code itself never self-updates** (`DISABLE_AUTOUPDATER=1`); the plugin env names are reserved; synced plugins are off.
- **Provenance** is shown everywhere: the marketplace, the pin or "Latest", and the version that loaded.
- **No tokens in URLs.** Input refuses userinfo, query and fragment, the same rule applies to the host record, logs and events carry only redacted output, and rows store clean URLs.

### 11.3 Mounts, links and the skills folder

- **Skill mounts** are real folders only, read-only, never the home or state dirs (I2). There are two new exact-location classes, each checked with a full `lstat` walk.
- **Folder sources** are refused at add, and their skills are checked again (links, `.claude-plugin/`) at every read and start.
- **Plugin paths into an agent are closed at every start.** Each start:
  - fails on any `.claude/skills/` entry that holds `.claude-plugin/`, following links;
  - empties `.claude-config/skills/`;
  - fails on project or local settings that set plugin keys or `hooks` (R11);
  - passes the factory's plugin keys through `--settings`, which outranks project and local settings, with an explicit `false` for every installed plugin outside the closure.

  So a plugin **loads** in an agent only when a human-saved template or overlay enables it from the template's registered marketplaces. **Hooks** reach it only through such a plugin, the frontmatter of a factory-linked Library or template skill (shown under Runs code), or the human-reviewed template and overlay `settings` (I2).
- **The agent's plugins dir** is the one read-write mount under `state/` (Docker), and only that agent's own.

### 11.4 Residual risk, stated

- **Within a running session**, Claude Code reloads settings files live, and skill hooks register when the skill is invoked. An agent with Bash can already run code as itself, so the start checks are about **persistence and review**, not about containing a running agent: whatever it adds is refused at its next start. This is stated, not solved; the follow-up is the Docker managed-settings mount (§21).
- **An agent can edit its own installed plugins** (P3). The plugins dir is writable by the agent (the same user locally, a read-write mount in Docker), so an agent can change the code of a plugin it runs, and the change persists across restarts until a repin reinstalls it. An agent with Bash can already run code as itself; what this adds is persistence and code that runs from hooks without a prompt. Accepted and stated; the factory doesn't verify installed files against the pin.
- **Latest** runs unreviewed upstream code at each restart, by explicit choice (§7.7).
- **Local-runtime agents** run as the host user, and so does their plugin code. Supported, not tested. This is the accepted local trust decision (S5 Q10), not a new hole.
- **The image provides plugin runtimes.** A plugin that calls a program the image lacks fails inside the session; the peek lists what it needs, and nothing more is checked.
- **External plugin sources with a `sha`** fetch code at install, though that code is fixed by the sha.
- **A tag pin can move** if the upstream moves the tag; a commit pin can't. Pins chosen in the form are commits.
- **A synced plugin an organisation marks as required** "loads regardless" of `syncClaudeAiPlugins` (loading.md). G1 records whether that applies to token-signed-in agents.
- **Defence in depth for Docker** (follow-up): a read-only managed-settings mount, which outranks every other level, holding `strictKnownMarketplaces`, `syncClaudeAiPlugins` and the plugin keys.

## 12. Data model and reset

Generated Drizzle migrations only (ADR 0028):
- **PR 1:** `skill_sources`;
- **PR 2:** `marketplaces`.

There is no change to the `agents` or `templates` columns.

**Reset step**, stated in each PR and in the plan:
- **Everywhere:** drop the database and recreate agents.
- **PR 1:** rename `FACTORY_HOST_SKILLS_DIR` to `FACTORY_HOST_CLAUDE_DIR` in `.env` (pointing at the Claude dir, not its `skills/`). The old name is never read; boot warns once if it is still set.
- **PR 2:**
  - templates listing `plugins:` fail validation ("Unknown field."): move them to `enabledPlugins` in `settings.json`;
  - add their marketplaces in Skills, then pick the plugins again in each template (that writes the pins);
  - recreate agents. Old `plugins-config/` folders and `.claude-config/plugins` links aren't read or cleaned; recreating the agents drops them.

## 13. Gate G1: real Claude Code checks (Or, before PR 2's implementation)

G1 needs real Claude Code, which the design team must not run. It is a **hard gate for PR 2** and runs on the **exact** version the base image pins (§7.9, 2.1.331). A pass/fail item that fails goes back to owner-i5 before the design adapts; a RECORDED item fills a constant or a line of copy. G1 doesn't block PR 1.

The plan's first PR 2 tasks turn this into scripts (`scripts/g1/run.sh`, `scripts/g1/timing.sh`) plus a fixture recipe. This section fixes what they must prove, and how.

**Setup:**
- **Everything runs inside throwaway containers from the pinned agent image** (`open-factory-base` at the pin), never on the host. Nothing is installed on Or's machine. `run.sh` refuses to run on the host, and checks `claude --version` against `images/base/claude-code-version`.
- **Credentials** only for the items that start a session, and only as an env var Or passes (`CLAUDE_CODE_OAUTH_TOKEN`); never a mounted credentials file, never `~/.claude` or `~/.open-factory-spike`. Plugin commands (`claude plugin …`) run with no credential.
- **The agent's plugins dir** is a host temp dir `$P`, mounted read-write at the same path, with `CLAUDE_CODE_PLUGIN_CACHE_DIR=$P`, as §7.2 builds it. Items that test persistence reuse `$P` across `docker run`s; all others start from an empty `$P`.
- **The agent runs exactly as §7.3 builds it:** `CLAUDE_CONFIG_DIR=$AG` (inside the container, fresh per run unless the item says otherwise), an empty `skills/`, `DISABLE_AUTOUPDATER=1`, `FORCE_AUTOUPDATE_PLUGINS=1` only where the item is about Latest, `--settings "$(cat $S/plugin-settings.json)"`, and a workdir with no `.claude/settings*.json`.
- **Fixtures, without a GitHub account where possible:**
  - **A directory marketplace**, built by `make-fixture.sh` and mounted read-only (as `timing.sh` already does). It holds `marker` (every code path writes a marker file into `$MARK`: a SessionStart hook; an MCP server that also writes `${CLAUDE_PLUGIN_DATA}/x`; `bin/x`; a monitors entry; a `package.json` with one real, tiny, exact-pinned registry dependency, a lockfile and `preinstall`/`postinstall` scripts), `dep` (an exact dependency of `marker`), `ranged` (a version-range dependency), and a relative plugin with `defaultEnabled: true`. Used by every item that isn't about git.
  - **A local bare git repo of the same fixture**, with two commits and a tag `v1` on the first, mounted read-only and declared as `{"source": "git", "url": "file:///fixture/acme.git"}`. Item 0 checks that Claude Code accepts it. If it does, every git item (4–9) uses it, and **no GitHub repo is needed**. If it doesn't, those items use a throwaway GitHub repo Or pushes (`<or>/of-g1-fixture`, the README gives the steps); a GitHub account is then needed only for items 4–9.
  - **Real public marketplaces** where their own behaviour is the thing under test: `anthropics/claude-plugins-official` (reserved-name pins, item 4; timing, item 20) and `obra/superpowers-marketplace` (timing).
- **`set -eu` safe markers:** `mkdir -p $MARK` up front, and check with `test -z "$(ls -A $MARK)"`.
- **The whole stream is captured** (`> $S/out.jsonl`) and `init` selected with `jq 'select(.type=="system" and .subtype=="init")'`, never `head`, which can kill the run before hooks and MCP write.
- **"Restart"** means a new `docker run` with the same `$P` (and the same `$AG` where the item says so).

**Items** (old numbers in brackets; old items 2, 3, 4, 10, 11, 14 and 15 tested the shared seed and its runner and are gone):

0. **A file-URL git marketplace** (new, RECORDED). `claude plugin marketplace add` and a `--settings` declaration with `{"source":"git","url":"file:///fixture/acme.git"}`: record whether Claude Code accepts it. Decides whether items 4–9 need GitHub.
1. **Only enabled plugins load** [1].
   - With `marker` and `dep` true and the `defaultEnabled` plugin absent from `enabledPlugins`, record whether the `defaultEnabled` plugin loads; with it `false`, it must not.
   - `init.plugins` lists exactly the `true` plugins, each with a `path` under `$P`.
   - Set `dep: false`: record whether `marker` still loads (dependencies must be enabled, R13), and whether a dependency Claude Code auto-installed is enabled without an entry.
   - Record the exact `init.plugins` entry shape (is `name` `x` or `x@y`? which other fields?) for a cached git plugin and an in-place directory plugin, and whether `init` comes before the first user message.
2. **Install at start** (new). With `$P` empty and the plugins declared only through `--settings` (`enabledPlugins` plus `extraKnownMarketplaces`), a headless `claude -p` session: record whether Claude Code installs them **before** `init` lists them, with and without `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1`, and what it prints. PASS when one of the two installs before `init`. If neither does, it goes back to Or before PR 2 (the fallback would be a pre-session `claude plugin install` in the agent's own env).
3. **The per-agent plugins dir** (new). After item 2, `$P` holds `installed_plugins.json`, `known_marketplaces.json`, `marketplaces/`, `cache/`, and after `marker`'s MCP server ran, `data/`; nothing plugin-related is written under `$AG` or `$HOME`. A restart with the same `$P` installs nothing (no new `cache/` dirs, `installed_plugins.json` unchanged) and loads the same plugins.
4. **Pins Claude Code accepts** (new). Declare the fixture with `ref` set to (a) the 40-hex first commit, (b) the tag `v1`, (c) a branch name; and `claude-plugins-official` with (d) a commit `ref` and (e) a tag if it has one. For each, record whether it is accepted, the marketplace clone's HEAD in `$P/marketplaces/<name>`, and the installed version. Also record whether a catalog entry's own `sha` (an external `git-subdir` source in the fixture) is installed at that `sha`. Also (f): a non-reserved `github` source with a commit `ref` (`obra/superpowers-marketplace` at a fixed sha; no account needed), because that is what pin-by-default writes for GitHub marketplaces. PASS when (a), (b) and (f) install exactly the pinned commit. (d) and (e) fill `OFFICIAL_MARKETPLACES`' pin rules (§7.4).
5. **A pinned plugin stays** (new; absorbs [11]). Pinned at the first commit, start once; push the second commit (and move nothing else); restart twice, and keep one session running for more than ten minutes with one message. `marker` stays on the first commit's version throughout, and `$P` gains no new version. Run it twice: without and with `FORCE_AUTOUPDATE_PLUGINS=1` (a second, Latest marketplace declared alongside, as a template with both would run). PASS needs both.
6. **Repin** (new). Change `ref` to the second commit and restart: record whether Claude Code re-fetches and installs the new version before `init`, what it prints, and whether the old version gets `.orphaned_at`. PASS when the new version loads at that start. If it doesn't, also record the same restart with `autoUpdate: true` for that one start, so a fallback is known before it goes back to owner-i5.
7. **Latest updates on restart** (new). No `ref`, `"autoUpdate": true`, `DISABLE_AUTOUPDATER=1`, with and without `FORCE_AUTOUPDATE_PLUGINS=1`. Start, push a new commit, restart. Record when the update happens (before `init`, in the background, or at the next start), to what version, its output, and that `claude --version` doesn't change (the CLI stays pinned). This fills the env rule in §7.3 step 4.
8. **Network down, plugin installed** (new). After item 3, restart with `--network none`: record whether pinned and Latest plugins still load from `$P`, the time to `init`, and what is printed. PASS when the installed pinned plugin loads.
9. **Network down, plugin missing** (new). With `$P` empty and `--network none`: record what Claude Code does (the session starts without the plugin, an error in `init`, or a failed start) and what is printed, so the §7.3 step 8 check matches it.
10. **The agent's own install** [6, rethought]. Inside a session, have the agent run `claude plugin marketplace add <the directory fixture>` and `claude plugin install marker@<it>`. Restart with the factory's `--settings`, which sets `marker@<it>: false` (§7.3 step 5): `marker` doesn't load. Record whether the marketplace the agent added stays in `known_marketplaces.json`, and whether it is refreshed at start.
11. **Skill naming** [5]. With `$W/.claude/skills/foo/SKILL.md` holding `name: bar`, record whether `/foo` or `/bar` appears in `slash_commands`.
12. **`data/` and `mcpb/`** [7]. Record where `marker`'s MCP server writes `${CLAUDE_PLUGIN_DATA}` and where MCP bundles are extracted: both under `$P` (PASS) and kept across a restart.
13. **Install and update run no plugin code** [8]. `$MARK` is empty after a `claude plugin install`, after the install Claude Code does at start (item 2) before any session hook could run, after a repin (item 6), and after the dependency install. main's timing run (2.1.327) found `preinstall`/`postinstall` didn't run; confirm on the pin. If it isn't empty, it goes back to owner-i5.
14. **Skills-directory plugins** [9]. A plugin folder with a SessionStart hook at (a) `$W/.claude/skills/sneaky/`, (b) `$AG/skills/sneaky/` (user level), (c) behind a link in `$W/.claude/skills/`. For each, record whether it loads and whether `"sneaky@skills-dir": false` in `--settings` stops it.
15. **Project and local settings** [12] (R11). Write `$W/.claude/settings.local.json` with:
    - `{"enabledPlugins": {"marker@fixture": true}}` against the `--settings` `false` for the same key: record which wins. Either way the §7.3 start check is what enforces the rule; the result says whether `--settings` is a second layer or only a carrier;
    - `extraKnownMarketplaces` plus `"x@evil": true` for another marketplace: record whether it is fetched and installed.
16. **A directory marketplace's catalog** [13]. A relative plugin with `defaultEnabled: true` in a declared directory marketplace, not listed in `enabledPlugins`: record whether it loads (R14).
17. **Project hooks and live reload** [16] (R11), extending item 15:
    - a project-level `hooks` entry and a `statusLine` both run, which proves the check is needed;
    - record whether an `enabledPlugins` change in `settings.local.json` mid-session takes effect without a restart, and whether `/reload-plugins` exists in `-p` mode.
18. **Frontmatter hooks** [17] (R12):
    - a skill in `$W/.claude/skills/h/` whose `SKILL.md` frontmatter declares a SessionStart or PreToolUse hook writing a marker. Invoke the skill and record whether the hook runs;
    - the same with a subagent in `$W/.claude/agents/a.md` declaring `hooks` and `mcpServers`, and in `$AG/agents/`;
    - record whether skills in `$AG/commands/` or `$AG/agents/` load.
19. **Required synced plugins** [18]. If Or's claude.ai organisation can mark a plugin required, record whether it loads with `syncClaudeAiPlugins: false` for a token-signed-in agent. If not, mark it untested.
20. **Install and start timing** [20] (RECORDED, never PASS or FAIL). Inside a throwaway container with no credentials and a fresh `$P`, for `superpowers@superpowers-marketplace`, `skill-creator` and `frontend-design@claude-plugins-official`, and the fixture's `marker` and `ranged`, record: (a) the marketplace add, (b) the install, (c) a second install of the same plugin, each as wall time; (d) the plugins dir's size and file count, and whether a `node_modules/` exists. With a credential, also (e) the time from spawn to the `initialize` control response, cold and warm, with 1 and 3 plugins (the harness waits 5 s for it, `COMMANDS_TIMEOUT_MS`); also record the extra time to `init` with the plugin already in `$P` (against no plugins) and the **cold start**, from an empty `$P` with the plugin declared to the plugin listed in `init`. Each cold case runs 3 times (min and max). Record the network and the host. main's first run (2.1.327, no credentials, `open-factory-base:dev`, aarch64) is in §7's note; re-run on the pin, and add the session-start numbers.
21. **The version floor** [19]. The lowest version where items 1–9, 12, 15, and 19 when it was tested, hold, if Or can test an older one. Otherwise the pin (2.1.331) is the floor.

**The report.** `report.md`, from `report-template.md`: the Claude Code version, the image digest, the network and host, whether item 0 made GitHub unnecessary, then each item as PASS, FAIL or RECORDED with its evidence (the relevant `init` lines, file listings of `$P` before and after, HEAD of each clone, printed output, timings). Or posts it on #153. The RECORDED items fill: the env rule for Latest (item 7), `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` (item 2), `OFFICIAL_MARKETPLACES`' pin rules (item 4), the `init.plugins` entry shape (item 1), the `plugin_not_loaded` copy (items 8 and 9), the cold-start command wait (item 20(e)), and the floor (item 21).

## 14. Testing and evidence

**Unit (shared):**
- the `library.ts` schemas and patterns (reserved names, length limits);
- input normalisation: repo, subpath and branch in TS, both good and bad cases (userinfo, `?`, `#`, `..`, `@{`, SSH, other hosts);
- the `enabledPlugins` rules;
- the library lines in `describeChanges` and the summary counts;
- the precedence of row states;
- grapheme-safe cuts.

**Server.** DB tests get their database through `makeTestApp`/`createTestDb` (a copy of a template migrated once, `createMigratedTestDatabase`) and run in CI (a `checks` job plus four test shards); where the local Postgres role is unavailable they run only there. All tests follow AGENTS.md "Testing standards": behaviour, not CSS classes or existence; look and layout are checked in the browser evidence.

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
- **Marketplaces,** against a fixture marketplace repo served through `file://` with `FACTORY_GITHUB_URL` (no Claude Code involved):
  - the preview reads the catalog at the commit, with pinnable and refused reasons; a taken or reserved name is refused;
  - add moves the preview into a read-only checkout; a swept preview re-fetches (202), and boot removes a row left `adding`;
  - check and update move only the Library's commit, list the changed plugins by catalog entry and by tree, "Runs code changed" first, and change no declaration;
  - fetch of a pinned commit; purge keeps checkouts a declaration or a loaded runtime references;
  - remove is refused while a template uses the marketplace;
  - an external `sha` source is fetched read-only on demand;
  - redaction.
- **Starting with plugins,** with fake Claude (its plugin mode installs declared plugins at session start into `CLAUDE_CODE_PLUGIN_CACHE_DIR` from a local fixture marketplace, at the `ref`, and logs each install; scenarios `install-fail` and `slow`):
  - three spawns install nothing; each agent's first start installs into its own plugins dir; a restart installs nothing (AC 10);
  - the env carries `CLAUDE_CODE_PLUGIN_CACHE_DIR`, `DISABLE_AUTOUPDATER=1`, and `FORCE_AUTOUPDATE_PLUGINS=1` only with a Latest declaration;
  - a repin installs the new version at the next start;
  - `install-fail`: the agent keeps running, the session has `plugin_not_loaded`, and every user gets one Inbox notice (AC 15);
  - an installed plugin outside the closure gets an explicit `false`, and so does a dependency an installed manifest names from an undeclared marketplace;
  - Docker: the agent's plugins dir mounts read-write at its real path; another agent's plugins dir and a link there are refused.
- **Start checks** (R11, R12):
  - `.claude/settings.json` or `settings.local.json` setting `enabledPlugins`, `extraKnownMarketplaces`, `syncClaudeAiPlugins` or `hooks` fails the start;
  - a link at either path fails;
  - `.claude-config/skills/` is emptied;
  - a link the agent made in `.claude/skills/` to a plugin folder fails;
  - the start check iterates every key in `RESERVED_SETTINGS_KEYS`, in both files (PR 1);
  - an agent-written skill with frontmatter `hooks`, or a subagent with `hooks` or `mcpServers`, fails the start, and `.claude-config/{skills,agents,commands}` are emptied (PR 1);
  - the plugin JSON is passed with `--settings` (fake Claude records argv) (PR 2).
- **Dependencies:** the closure is enabled from readable manifests, and a ranged dependency makes a plugin unpinnable.
- **Settings.** The `--settings` JSON writer emits `enabledPlugins` (true for the closure; explicit false for the other catalog plugins at the pin, for installed keys outside the closure, and for known skills-dir names), `extraKnownMarketplaces` (registry source plus `ref` and `autoUpdate: false` when pinned, no `ref` and `autoUpdate: true` when Latest), and `syncClaudeAiPlugins: false`. `buildSettings` writes none of these keys. The reserved env names can't be set by a template, an overlay or a secret.
- **Pins in validation:** a commit and a recorded tag pass; a `refs/heads/…` ref is refused, and Fetch refuses a branch name; a pin kind Claude Code refuses for an official marketplace is refused; Latest is a warning; an unpinnable plugin under a pinned declaration is an error; a pin Skills hasn't read is a warning.
- **Version floor:**
  - a local start below the floor fails closed;
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
  - a template save that moves a pin writes "plugin x@y repinned …" and restarts the agents of that template;
  - a marketplace update restarts no agent;
  - `libraryChanged` runs after the lock is released.
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
- Add marketplace: the preview, the re-fetch pending row, the toast outcome;
- the peeks:
  - Runs code first, skeletons from counts, View file from the top (40 lines) as a toggle;
  - untrusted text with a U+202E command, rendered visibly;
  - the update view in place with `+`/`−`; the refusal line;
  - "Needs from the image" with its note;
  - the read-only peek from the form, at the template's pin;
  - Back in the marketplace peek;
- the multi-pick picker: the trigger in the label row, a picked option stays checked and disabled, the highlight moves, the live announcement, left out on the next open, the agent-mode limit and footer copy, virtualisation;
- the pin control: picking pins by default; "Pin to …" shows the diff and writes `ref`; "Use Latest" shows its risk text and removes `ref`; the Latest badge has an accessible name; an unpinnable plugin can't join a pinned declaration; agent mode is read-only;
- `library_changed` invalidation;
- fix-link arrival.

**Evidence pass** (the plan's last tasks). Real browser, Chromium and WebKit headless, through the U4 harness's `run.sh` lock, with fake Claude only. GitHub fetches go to a local fixture repo through `FACTORY_GITHUB_URL=file://…`. Covered: the three views, the peeks, the add sheets and the pickers, at 1440, 1024, 390 and 375px, and 390px at 200% text. Acceptance flows 1–6 run in PR 1, and flows 8–13 and 15 in PR 2 (fake Claude installs into a temp plugins dir; nothing is installed on the host).

**Worst-case fixture:**
- a 40-skill GitHub source;
- a 64-character skill name with underscores, plus two names that differ only at the end;
- a skill used by 1 template and 190 agents, and one used by exactly one;
- a GitHub repo with 0 skills, and one with only unpickable skills;
- a plugin with 12 hooks and long commands, one with a U+202E command and a multi-line `bash -c`, one whose `hooks.json` is a link, one with more than 2,000 files, and one needing `node`, `uvx` and `bun`;
- a template with one pinned and one Latest marketplace;
- `rust-analyzer-lsp@claude-plugins-official` with a 12-hex version;
- two git-URL marketplaces on one host;
- a failing check;
- an empty Plugins view;
- a 200-character subject ending in an emoji;
- a 120-character path;
- the template `platform-infrastructure-reviewer`.

## 15. Web conventions for the plan

- **The skill line.** Every `apps/web` task says: "Implementer and reviewer invoke `vercel-react-best-practices` and follow it." The final review checks the React diff against it; Next-only rules are skipped, and the review notes that.
- **Data:** TanStack Query, with `libraryQueryOptions` (`["library","skills"]`, `staleTime: 0`), `skillQueryOptions(group, name)`, `sourceQueryOptions(id)`, `pluginQueryOptions(key, from, commit)` and `marketplacesQueryOptions`. File text lives under its own `["library-file", …]` key. The plan's Global Constraints pin the exact keys and the React rules from its review.
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
7. **Components, Version pins** (PR 2): "Third-party code that can change under you says so. A pinned entry shows 'Pinned' and its short commit (the copy button). An entry that follows upstream shows a 'Latest · auto-updates' badge (warning icon plus the words, never colour alone) wherever it appears. Pinning is the default; choosing Latest is its own explicit action, reviewed in place, with the risk stated next to its button."

## 17. Delivery

Three stacked PRs on I3's last branch, in a line: `i5/1-library-skills` → `i5/2-plugins` → `i5/3-polish-docs`. Each links this spec, the plan and the decision issue, states its reset step, and deletes what it replaces (Q12).

1. **`i5/1-library-skills`:**
   - §5, §6, §8 for skills, §9.1–§9.2 and §9.4–§9.6, §10 for skills (no view switch until PR 2), §11.1 (route tests), the §6.4 checks (`.claude/skills` plugin check and the `.claude-config/skills` scrub), the §7.3 step 3 checks (project and local settings against §7.10's `RESERVED_SETTINGS_KEYS`, frontmatter hooks on agent-written skills and subagents, and emptying `.claude-config/{agents,commands}`), and §7.10 itself;
   - PR 1 keeps I2's per-agent plugin install and its `pluginsDir` mount class. It adds only §6.5's GitHub-skill mount class (the read-write plugins-dir class comes in PR 2), and `Effective.library.plugins` is `{}`;
   - `FACTORY_HOST_CLAUDE_DIR` across `config.ts`, `config.test.ts`, the README, `.env.example`, the 8 smoke scripts and the test helpers;
   - `/api/host-skills` deleted;
   - DESIGN.md amendments 1, 2, 3 (SKILL.md and files), 4, 5 and 6.
2. **`i5/2-plugins`.** Its implementation starts only after G1 (§13).
   - §7, the plugin parts of §8–§10, §11, DESIGN.md amendment 7;
   - the Plugins and Marketplaces views appear, and the pin control in the form;
   - the base image's Claude Code pinned to 2.1.331 (§7.9), before G1;
   - deleted: `plugins:`, the factory's per-agent installs (`ensurePlugins`, `installPlugins`, `plugins-config/`, `linkPlugins`, `readPluginKeys`, `PluginInstallError`), the read-only plugins mount and the `.claude-config/plugins` symlink.
3. **`i5/3-polish-docs`:** fixes from the evidence pass, plus the product-doc list in §18. Folded into PR 2 if small.

## 18. Product docs and repo follow-ups (a list for the lead; `docs/product` is never edited here)

- **Agent template:**
  - `skills` (Library names, the unusable rules), with `plugins` removed;
  - `enabledPlugins` and `extraKnownMarketplaces` (copied from Skills) and their validation;
  - the factory-owned keys `syncClaudeAiPlugins`;
  - Instantiation.
- **Workspace:**
  - the layout: `state/library/github/`, `state/library/marketplaces/<name>/<sha>/`, `state/library/plugin-sources/`, `state/agents/<slug>/plugins/` (the agent's plugins dir, Claude Code's), no `plugins-config/`, no `.claude-config/plugins`;
  - Library skills and the skills-folder plugin check;
  - plugins installed by Claude Code per agent at start; pins and Latest; Claude Code's self-update off;
  - the mount classes, including the read-write plugins dir;
  - residual risk: an agent can edit its installed plugins; plugin code runs as the host user on the local runtime (supported, not tested); the image must provide plugin runtimes.
- **Administration:** a new **Skills** section (three views, adding, peeks, updates, removal), and the Templates bullets on skills, plugins, the pin control and Latest.
- **ADR 0017:** a note that skills resolve through the Library.
- **ADR 0024:** the I5 consequences: S2 kept (Q5); Add its marketplace for host plugins (Q7); per-agent installs by Claude Code at start, pinned by default, Latest explicit (P1–P6); `ref` is the pin; skills-directory plugins refused (R3).
- **Data model:** the two tables.
- **Agent runtime:** the plugin env (`CLAUDE_CODE_PLUGIN_CACHE_DIR`, `DISABLE_AUTOUPDATER`, `FORCE_AUTOUPDATE_PLUGINS` for Latest), the reserved env names, the version floor, the `plugin_not_loaded` event and notice.
- **Base image:** Claude Code pinned to 2.1.331 in `images/base/claude-code-version` (no release-age wait for this pin while pre-release), and the version label; plugin runtimes (`node`, `npx`, `uvx`, `bun` and whatever a plugin's hooks call) must be baked into an agent image; Open Factory doesn't provide or test them.
- **Issue #56** (plugin install cost): re-scope or close. Measured cold installs are about 2.5–4 s per plugin including the marketplace clone, about 0.3 s when installed (§7 note); heavy or native dependency trees are unmeasured.
- **I6 path help:** the I5 fields now exist. The README replaces `FACTORY_HOST_SKILLS_DIR` with `FACTORY_HOST_CLAUDE_DIR`.
- **Factory MCP (I7 note):** Library tools are read-only, and `enabledPlugins` is a code-running key.

## 19. Reviews: what changed

The full findings are in the decision issue.

- **Plugin redesign** (Or, 2026-11-24). The shared store (a Claude Code seed written by a factory runner, its read/write lock, install journal, provenance file, update-preview copy, the start's store check and install, and background installs on save) is replaced by per-agent installs that Claude Code does at start, pinned per template declaration by default, with Latest as an explicit choice (§7). G1 was rewritten to run in containers from the agent image (§13). Decisions P1–P6 record the new choices; the rows they supersede say so (§20).
- **Plugin redesign review** (fresh reviewer: 1 blocker, 10 majors, 24 minors), all applied: the not-loaded notice uses a `system` message with `subjectAgentId`; tag pins resolve through recorded tags, and commit-refusing official marketplaces default to a tag; dependencies from installed copies count only from declared, registered marketplaces; fake Claude installs `github` sources from the fixture root; loaded versions live outside `started.library`; the init check matches by path on the first `init`; G1 gains the mixed FORCE run, a repin fallback, a GitHub commit pin and the `initialize` wait; the floor is wired into local and Docker starts; the pin reviews get focus, Cancel and narrow-width rules; the plugin query key carries the commit.

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

  Minor 16, which suggested reading the new commit's tree instead of the T7 throwaway install, was kept as T7 at the time; T7 is now superseded by the factory-checkout diffs (§7.5).
- **Taste:** applied H1 (group by source; R4), H2 (picker; R7), H3 (View file from the top), M1 (copy says "Skills"), M2–M6 and L1–L7.
- **Apple:** applied H1 (`g k`), H2 (update in place; R9), M1–M8, M11 (read-only peek; R10), M12 and L1–L7. M9 (`?peek=`) was declined for router state (R6). M10 (rename to Library) was declined by the proxy (R5, for Or).
- **Emil:** applied H1 (R7) and M1–M9, L1–L9.
- **Break UI:** applied B1–B5, U1–U9 and F1–F6, plus the skill Files and SKILL.md gap and the worst-case fixture.
- **Round 2, security re-review** (2 blockers, 10 majors, 14 minors):
  - applied B1 (the user-level skills folder; R12) and B2 (project and local settings; R11);
  - M1 (the check follows every link);
  - M2 and M3 (the dependency closure; R13);
  - M4 (orphan markers and a journal; superseded by the plugin redesign);
  - M5 (a read/write store lock; superseded by the plugin redesign);
  - M6 (taken names include the store and soft-deleted rows; safe boot repair; superseded by the plugin redesign);
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
| Q6 | Superseded by P1 (Or): no store; Claude Code installs per agent at start. Create and spawn never install | – |
| Q7 | Host plugins show their host contents. Add its marketplace registers it; pickers list registered marketplaces' plugins | **3** |
| Q8 | git CLI, hardened; host credentials only; HEAD verified; no submodules or LFS; 50 MB cap; read-only | 4 |
| Q9 | Superseded by P2 (Or): pinned by default; Latest is an explicit choice | – |
| Q10 | Human repins that show a contents diff; one pin per marketplace per template; no GC | 4 |
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
| Q21 | Explicit `false` for other catalog plugins and agent-installed ones. Reserved env names. Command, headersHelper and unpinned archive sources refused. Version floor with no fallback; the pin (2.1.331) is the floor until G1 says otherwise. G1 is a hard gate | 4 |
| T1 | Superseded: no provenance file; provenance is the declaration plus the Library checkout | – |
| T2 | Marketplaces are read through `runGit` into read-only checkouts at exact commits; the factory never runs `claude plugin` | 4 |
| T3 | Superseded: no store | – |
| T4 | Removal is a soft delete with a 30 s Undo; purged at boot after a restart | 4 |
| T5 | One `library_changed` frame; no watchers | 4 |
| T6 | Lock order workspace → Library (§9.6); no background installs | 4 |
| T7 | Superseded: repin diffs come from factory checkouts (§7.5) | – |
| T8 | Uninstall is removing the declaration; the copy stays disabled until Claude Code's cleanup | 4 |
| T9 | Linked subfolders in folder sources are skipped | 4 |
| R1 | Superseded by P1: the per-agent plugins dir is Claude Code's and isn't scrubbed | – |
| R2 | Reversed by P1: the pin is the declaration's `ref` (a commit or a tag) | – |
| R3 | Skills-directory plugins refused everywhere (including agent-written skills); sync off; dependencies pinned; marketplace name previewed | 4 |
| R4 | The Skills list is grouped by source, with a Source peek; the skill peek shows Files and SKILL.md | 4 |
| R5 | The page stays "Skills" (`g k`); user copy never says "Library" | **2** |
| R6 | Fix links land on the item through router state; D11 stands | 4 |
| R7 | Multi-pick picker: trigger in the label row; picked options stay checked and disabled | 4 |
| R8 | Long operations continue after Close, with a pending row and a toast; boot removes a half add | 4 |
| R9 | Repins reviewed in place in the form; marketplace updates in the peek; no dialog anywhere in I5 | 4 |
| R10 | A peek opened from the form is read-only, with "Open in Skills" | 4 |
| R11 | Project and local settings that set any `RESERVED_SETTINGS_KEYS` key (factory-owned, command-running, or reserved env names) fail the start, naming file and key; one constant shared with I7's default-deny; the plugin keys go through `--settings` | 4 |
| R12 | `.claude-config/{skills,agents,commands}/` emptied at every start; the plugin check follows every link; agent-written skills or subagents with frontmatter `hooks` (or subagent `mcpServers`) fail the start; Library skills show their frontmatter hooks | 4; **3** on the frontmatter-hooks handling |
| R13 | Dependencies: a range makes a plugin unpinnable; the closure is enabled from readable manifests | 4 |
| R14 | Every declared marketplace must be registered; the generated marketplaces replace the template's; explicit `false` over every declared marketplace's other plugins | 4 |
| P1 | Claude Code installs and updates plugins at agent start into the agent's own plugins dir (`CLAUDE_CODE_PLUGIN_CACHE_DIR`, read-write mount in Docker). The factory runs no installer. One pin per marketplace per template (`source.ref`), because that is the pin Claude Code accepts; overlays use the template's pin | 5 on the direction (Or); **3** on one pin per marketplace |
| P2 | Pinned by default to the commit Skills read; "Latest, auto-update" is an explicit per-marketplace choice with its risk stated and a badge everywhere; unpinnable plugins are Latest-only | 5 (Or) |
| P3 | An agent can edit its own installed plugins; accepted and stated, not verified (§11.4) | **3** |
| P4 | A plugin that didn't load at start: the agent keeps running, the session shows `plugin_not_loaded`, and every user gets one Inbox notice per start (replaces the failed-install notice to the saver) | **3** |
| P5 | Plugin runtimes come from the image; the peek lists "Needs from the image"; nothing provided or tested. Local runtime supported, not tested | 5 (Or) |
| P6 | If G1 item 2 shows a headless start doesn't install declared plugins, the fallback (a pre-session `claude plugin install` in the agent's own env) goes back to Or before PR 2 | **2** |

## 21. Follow-ups (separate issues)

- Per-source GitHub tokens for private repos (Q8).
- Garbage collection of old GitHub checkouts and marketplace checkouts (Q10). Old plugin versions in agents' dirs are Claude Code's own orphan cleanup.
- Per-plugin pins inside one marketplace, if one shared pin per template proves too coarse (P1).
- Verifying an agent's installed plugin files against the pin at start (P3).
- Re-scope or close #56 with the measured numbers (§18).
- Removing a single skill from a source (R4).
- Aliases, if a real collision shows up (Q3).
- npm-sourced plugins.
- Revisit whether agents may add plugins from any registered marketplace (Q5), with Or.
- Base image docs: describe the pinned Claude Code version and the plugin runtimes an agent image must carry (#160; the pin itself lands in PR 2).
- `permissions.allow` and `autoMode` in agent-written project or local settings let an agent widen its own permissions (#162, §7.10). Or decided to defer it: no start check in I5. Or's idea for later: two settings files, one read-only and one agent-writable that the factory controls and can verify, merged at agent start by policy. Not scheduled.
- Docker defence in depth: a read-only managed-settings mount with `strictKnownMarketplaces`, `syncClaudeAiPlugins` and the plugin keys (§11.4).
