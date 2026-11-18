# S4 Templates, workspace and context: Technical Design

- **Date:** 2026-11-19
- **Status:** approved by owner-proxy (owner-s4), pending Or's review on the low-certainty items (§22)
- **Roadmap spec:** `docs/product/roadmap/v0.1/s04-templates-workspace-context.md`
- **UI design:** [`docs/superpowers/designs/2026-11-19-s4-templates-agents-settings-ui-design.md`](../designs/2026-11-19-s4-templates-agents-settings-ui-design.md)
- **Product sources of truth:** `docs/product/concepts/agent-template.md`, `agent.md`, `credential.md`, `project.md`; `docs/product/architecture/workspace.md`, `context-assembly.md`, `permissions.md`, `agent-runtime.md`, `harness-driver.md`, `data-model.md`; `docs/product/behavior/administration.md`, `agents-and-sessions.md`; ADRs 0009, 0010, 0011, 0012, 0017; `docs/product/open-questions.md` ("Verified during design").
- **Builds on:** S3 ([spec](2026-11-18-s3-walking-skeleton-design.md)): the harness driver, `AgentRuntime`, the event store, the session view and the agents API.
- **Evidence:** the S0 fixtures in `packages/harness/fixtures/`, plus the traces this design adds (§19).
- **Decision log:** #28 ("S4 Templates, workspace and context: design decisions").
- **Stacked on:** `spec/s3-walking-skeleton` (PR #27).

> `docs/product/` is gitignored, so the product docs exist only in local checkouts. Paths above are relative to the repo root.

## 1. Goal

Humans create real persistent agents from templates. Each agent gets its own isolated working dir, Claude config dir, granted projects, named credential, secrets and factory-generated context, and runs with auto-mode permissions whose denials show in its session. The S3 dev agent, its seed script and the server-wide token go away.

## 2. Acceptance criteria

From the roadmap, made testable:

1. **Isolation.** Two agents created from two different `runtime: local` templates run with different `settings.json`, plugins and skills. Neither sees the host user's `~/.claude` CLAUDE.md, settings, hooks, skills or plugins: each `system/init` lists its own template's plugins and skills, and none of the host's (Claude Code's bundled skills and `cc-plugin-*@builtin` plugins are always there and vary by account, so tests assert "listed present, host ones absent", §19 V4).
2. **What an agent sees.** An agent sees its `AGENTS.md` persona, the factory CLAUDE.md (identity and protocol, §10), its linked host skills, its template-local skills, its MCP servers, and `./projects/<name>` for each granted project, and nothing else from the factory. Edit and Write through `./projects/<name>` are approved (S0: `project-edits-with-additional-directories`).
3. **Independent credentials.** Two agents with different named credentials each authenticate with their own (asserted in tests on the child env; recorded once live in the PR). Changing an agent's credential takes effect through the apply-restart (§13).
4. **Visible denials.** A `permissions.deny` rule in a template produces a `permission_denied` row in the session, for Bash rules (system event) and for Read/Edit/Write rules (derived from `tool_result_meta`, with `result.permission_denials` as the fallback, §15), and the agent keeps working.
5. **Templates on disk.** Editing a template in the UI writes the file on disk; editing it on disk shows in the UI on the next view; validation errors (§5.3) show inline and block agent creation; warnings don't.
6. **Credential verification.** Adding a credential with a bad token is refused with "Claude rejected this token" and nothing is stored; a good one is stored encrypted (§11).
7. CI is green. The live check (§18.4) has been run once and its output, plus a manual pass through ACs 1–6 in the browser, are recorded in the PR.

## 3. Scope

**In:**
- the template loader, validator and DB index, with rescan on demand;
- the Templates UI (list, raw editors, create, delete);
- the agent creation service: working-dir materialization, config-dir install, skill links, project symlinks;
- edit, re-sync, archive and unarchive;
- projects, credentials and secrets (encrypted storage, the verification turn, env injection) and their Settings sections;
- the CLAUDE.md, `settings.json` and `.mcp.json` generators;
- the `AgentRuntimeSpec` builder (env, args, cwd, permission mode, mounts for S5);
- the apply-restart seam;
- deny-rule visibility in the mapper;
- the org tree v0 (indented list);
- the session strip additions.

**Out:**
- **The Docker launcher.** `runtime: docker` agents are created but can't start yet (§12.4).
- The `allow_local_runtime` gate (#18) and hibernation, both S5.
- The factory MCP server and its `.mcp.json` entry (S6).
- The org block, peers and messaging tools in CLAUDE.md (S6).
- Spawning and ephemeral agents (S7).
- Starter templates (none ship in v0.1).
- Editing `skills/` and `files/` in the UI (edit on disk).
- A manual Restart button (S5).
- An editable git identity.
- Credential rename and key rotation.
- Settings for users, factory config and usage (S10).
- Image status (S10).

## 4. Architecture

```
web: Templates · Agents (tree, new, edit) · Settings (projects, credentials, secrets) · session strip
  │ HTTP
  ▼
routes/{templates,agents,projects,credentials,secrets}.ts
  │
  ├─ TemplateIndex (scan FACTORY_HOME/templates/*, validate, upsert `templates`)
  ├─ AgentService (create, edit, resync, archive, unarchive; DB + Workspace)
  │     └─ Workspace (materialize at create/resync; prepare at every start)
  │           ├─ generators: buildSettings, buildMcpJson, buildClaudeMd (pure)
  │           ├─ resolveHostSkills, linkProjects, installPlugins (claude plugin CLI)
  │           └─ buildMounts (pure, for S5)
  ├─ Vault (seal/open with the HKDF subkey) ── credentials, secrets tables
  ├─ CredentialVerifier (one-shot turn through the HarnessDriver)
  └─ AgentRuntimes / AgentRuntime (S3) ── ensureStarted → Workspace.prepare → buildRuntimeSpec → driver.start
                                          requestRestart(agentId)  (apply seam, §13)
```

| Unit | Location | Owns |
|---|---|---|
| Template schema | `packages/shared/src/templates.ts` | Zod `templateYamlSchema`, `TemplateConfig`, the issue type, API schemas |
| Settings API schemas | `packages/shared/src/settings.ts` | Projects, credentials and secrets request and response schemas, name rules |
| `TemplateIndex` | `apps/server/src/templates/` | `scan()`, `get(name)`, `validateTemplate(dir, ctx)` (the one validator, §5.3), file read/write with hash checks, create, delete |
| `Workspace` | `apps/server/src/workspace/` | `materialize`, `resync`, `prepare` (per start), and the pure generators, each in its own file |
| `AgentService` | `apps/server/src/agents/agent-service.ts` | Create, edit, resync, archive, unarchive: validation, transactions, rollback of a half-made workdir |
| `Vault` | `apps/server/src/crypto/vault.ts` | `seal(plaintext, aad)` and `open(blob, aad)` |
| `CredentialVerifier` | `apps/server/src/credentials/verify.ts` | The verification turn and failure classification |
| Runtime spec builder | `apps/server/src/agents/runtime-spec.ts` (S3's file, extended) | `buildAgentEnv`, `buildRuntimeSpec` |
| `AgentRuntime` changes | `apps/server/src/agents/agent-runtime.ts` | `ensureStarted` calls `Workspace.prepare`; `requestRestart`; a live background-task set; refusing archived agents |

Removed or replaced:
- `apps/server/src/agents/seed-dev.ts`, `apps/server/scripts/seed-dev-agent.ts` and the `seed:dev-agent` script.
- `resolveClaudeToken`, and `CLAUDE_CODE_OAUTH_TOKEN` / `FACTORY_DEV_MODEL` from `config.ts`, `.env.example` and the README's env table and run steps (the README's "run an agent" steps become: add a credential, create a template, create an agent).
- `apps/server/scripts/smoke-harness.ts` builds its agent with the new test helper instead of `seedDevAgent`, and takes the model from the template snapshot.
- `makeTestApp().seed` in `apps/server/src/test/helpers.ts`, which every server test uses, is replaced by `seedTestAgent(app, opts?)`: it inserts a credential (a dummy value, sealed), an agent row with a minimal `runtime: local` snapshot, and a minimal workdir (`AGENTS.md`, `.claude-config/`, `.factory/template/*`), without plugin installs or the template index.
- The S3 session copy that tells the user to run `pnpm seed:dev-agent --reset-session` (`apps/web/src/features/session/timeline-row.tsx`) now says: "To start a new session: stop the server, run `pnpm agent:reset-session <slug>`, then start it again."

Added: **`pnpm agent:reset-session <slug>`** (`apps/server/scripts/reset-session.ts`), the interim recovery from a failed resume ("No conversation found"). It generalizes S3's `--reset-session`: it refuses with "Stop the server first" if `GET <PUBLIC_URL>/api/status` answers; otherwise it clears the agent's `session_id`, sets `hibernated` and appends `session_reset{by:"reset-session script"}`. Its help text calls it interim; S5 (#19) replaces it with an automatic or UI path.

New config: `FACTORY_HOST_SKILLS_DIR` (default `~/.claude/skills`, expanded like `FACTORY_HOME`), so tests use a temp dir.

## 5. Templates

### 5.1 Folder layout

```
FACTORY_HOME/templates/<name>/
├── template.yaml   required
├── AGENTS.md       required
├── settings.json   optional: Claude Code settings (permissions, hooks, env, autoMode, extraKnownMarketplaces)
├── mcp.json        optional: {"mcpServers": {…}} in Claude Code's .mcp.json format
├── skills/<skill>/ optional: template-local skills
└── files/…         optional: seeded into the working dir root
```

A template is any directory directly under `templates/` that contains a `template.yaml`. Entries whose name starts with `.` are ignored. `FACTORY_HOME/templates/` is created at boot if missing.

### 5.2 `template.yaml` schema (`templateYamlSchema`, strict: unknown keys are errors)

| Field | Type | Default | S4 use |
|---|---|---|---|
| `name` | `^[a-z][a-z0-9-]{0,38}[a-z0-9]$`, equal to the folder name | required | index key |
| `display_name` | string 1–80 | required | default display name in New agent |
| `description` | string ≤ 500 | `""` | default description |
| `runtime` | `docker` \| `local` | `docker` | §12.4 |
| `image` | string | unset | stored; used by S5 |
| `permission_mode` | `auto` \| `bypass` | `auto` | runtime spec (§12.2) |
| `model` | string | unset (Claude's default) | `--model` |
| `effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` (Claude Code 2.1.327 `--effort`) | unset | `--effort` |
| `projects` | project names | `[]` | default grants |
| `skills` | host skill names (`^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$`, so never `.` or `..`) | `[]` | linked from the host skills dir |
| `local_skills` | boolean | `true` | copy `skills/` |
| `plugins` | `name@marketplace` strings | `[]` | installed into the config dir |
| `secrets` | env var names (§11.3 rules) | `[]` | injected into the env |
| `can_spawn` | template names | `[]` | stored; S7 |
| `max_live_spawns` | int 0–50 | `5` | stored; S7 |
| `warm_window_minutes` | int 1–1440 | `70` | stored; S5 |

The parsed, defaulted object is `TemplateConfig`. Agent creation and re-sync copy it onto the agent row as the agent's **config snapshot** (§6), validated by the same schema.

### 5.3 Validation (`validateTemplate`, the one validator)

It returns `{config?: TemplateConfig, issues: TemplateIssue[]}` with `TemplateIssue = {severity: "error"|"warning", file: "template.yaml"|"AGENTS.md"|"settings.json"|"mcp.json"|"skills"|"files", message, line?, column?, path?}`. **Errors block agent creation and re-sync; warnings don't.** The same function serves the index, the editor's validate-on-blur (with the unsaved content substituted for that file), creation and re-sync.

Errors:
- `template.yaml` or `AGENTS.md` missing.
- YAML or JSON syntax (with line and column). YAML is parsed with the `yaml` package (new dependency of `apps/server`, added through the lockfile under the existing `minimumReleaseAge` policy), whose `LineCounter` gives line and column for syntax and schema errors. JSON line and column come from Node 24's `JSON.parse` error message (`line X column Y`).
- A schema violation (with the YAML path and line).
- `name` differs from the folder name.
- An unknown host skill (`<hostSkillsDir>/<name>` is missing).
- A host skill with the same name as a folder in `skills/`.
- An unknown project (not registered).
- `permission_mode: bypass` with `runtime: local`.
- A plugin whose `@marketplace` isn't declared in `settings.json` `extraKnownMarketplaces`.
- `mcp.json` without a top-level `mcpServers` object, or with a server named `factory` (reserved for S6).
- `files/` containing a top-level entry named `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `.claude`, `.claude-config`, `.mcp.json`, `.factory` or `projects` (a `CLAUDE.md` in the workdir would also stop Claude Code from loading `AGENTS.md`, V10).
- A marketplace in `extraKnownMarketplaces` with a source type other than `directory` (`path`), `git` (`url`) or `github` (`repo`), or with `ref`/`path` sub-fields: the factory can only pass those three to `claude plugin marketplace add`.

Warnings (`autoMode` lists need no warning: the factory always keeps Claude's defaults, §9.1):
- A secret that isn't defined in Settings ("Secret GH_TOKEN isn't set").
- A `can_spawn` entry that isn't a known template.
- `settings.json` setting `permissions.defaultMode` ("Ignored: the factory sets the permission mode").
- `settings.json` setting `enabledPlugins` ("Ignored: list plugins in template.yaml").

### 5.4 Index and rescan (no watcher)

Table `templates` (§7) is a cache of the folders, keyed by **folder name** (also for a template whose `template.yaml` doesn't parse; `name` ≠ folder is a validation error). `content_hash` is the sha256 over the sorted list of (relative path, bytes) of every file in the folder, so any change, including `skills/` and `files/`, changes it. A template folder may be a symlink (e.g. into a git checkout); it is indexed through the link, and deleting it removes only the link. `TemplateIndex.scan()` reads every template folder, validates it, upserts `{name, path, config, issues, contentHash, scannedAt}`, and deletes rows whose folder is gone. It runs:
- on boot;
- on `GET /api/templates` and `GET /api/templates/:name`;
- after every write through the API;
- right before agent creation and re-sync.

A scan of a handful of folders takes milliseconds, so there's no watcher and no new dependency. Invalid templates stay in the index with their issues, so the UI shows them instead of silently dropping them. The validation context (registered projects, defined secrets, known template names, host skills dir) is loaded once per scan.

### 5.5 Editing through the API

Every route param (`:name`, `:slug`, `:file`) is parsed with its shared Zod schema (the name and slug regexes, the four file names) **before** any filesystem access, so `..`, `%2F` and absolute paths never reach a `path.join` (a traversal test covers DELETE and PUT). Paths are then built only from validated names.


- **Read.** `GET /api/templates/:name` returns the four editable files' contents (absent optional files are `null`), a `hash` per file (sha256 of the bytes on disk), the issues, and the non-archived agents created from it.
- **Write.** `PUT /api/templates/:name/files/:file` with `{content, baseHash}` writes the file atomically (temp file plus rename) **even when the content is invalid**: files on disk are the source of truth, and a half-edited template simply can't be used until it validates. It returns `409 changed_on_disk` with `{currentHash}` when the file's current hash differs from `baseHash` ("Changed on disk since you opened it. Reload to see the changes."), so the UI can offer Overwrite (resend with `baseHash: currentHash`). `baseHash: null` means "create this optional file". `:file` is one of the four names.
- **Validate.** `POST /api/templates/:name/validate` with `{file, content}` is the blur check: it runs the validator with that content substituted and writes nothing.
- **Create.** `POST /api/templates` with `{name, displayName, description?}` creates the folder with a skeleton `template.yaml` (name, display_name, description, `runtime: docker`) and an `AGENTS.md` heading. The skeleton keeps the documented default; New agent warns for docker templates ("Agents from this template can't start yet: the Docker runtime isn't available."). It returns `409 template_exists` when the folder exists.
- **Delete.** `DELETE /api/templates/:name` removes the folder recursively (or only the link, for a symlinked folder). The UI confirms first ("Delete <name>", noting that existing agents keep their copies). Agents are unaffected, because their snapshot and files are their own.

## 6. Agents: identity and lifecycle

### 6.1 Rules

- **Slug.** Matches `^[a-z][a-z0-9-]{1,38}[a-z0-9]$`. It is unique across all agents including archived ones (one namespace, which S7's ephemeral agents share), immutable. Reserved: the shared `RESERVED_HANDLES` (`humans`, `me`, `scheduler`) plus `all`, `system` and `factory` (one list in `packages/shared`). A slug may currently equal a human `@handle`; cross-uniqueness is deferred to S6, which owns `@` addressing (follow-up issue).
- **Display name** is 1–80 chars. **Description** is ≤ 500.
- **Manager** (`reports_to`) is null or a non-archived agent other than itself. A cycle is rejected: "That would make @a report to itself through @b".
- **Credential** is required and must exist.
- **Projects:** each must be registered.
- `kind` is always `persistent` in S4.

### 6.2 Create (`POST /api/agents`)

Body: `{template, slug, displayName, description, reportsTo: slug|null, credential: name, projects?: string[]}`. `projects` omitted means the template default (`grants_overridden = false`); present means an explicit set (`true`).

Steps, in one request (the UI shows "Creating…"; plugin installs can take a while, and the route timeout is 5 minutes):
1. Rescan the template. It must exist and have no errors.
2. Validate the body (§6.1), including a slug already in the DB (`409 slug_taken`). Then **claim the folder** with a non-recursive `mkdir FACTORY_HOME/agents/<slug>`: `EEXIST` means `409 folder_exists` ("A folder already exists at <path>. Move it away or pick another slug."), which also covers the folder an old S3 `dev` agent left behind. `FACTORY_HOME/agents/` is created at boot. Concurrent creates of the same slug are serialized by an in-process per-slug lock held across steps 2–4, so the second create sees `slug_taken`, not a misleading `folder_exists`. A unique violation on insert (another server process) also maps to `409 slug_taken`. Rollback (below) only ever removes a folder **this request** created.
3. `Workspace.materialize` (§8.1). On any failure the agent folder is removed recursively and the error is returned. Plugin failures include the CLI's last stderr lines.
4. One DB transaction inserts the `agents` row (with the config snapshot) and its `agent_project_grants`. If it fails, the folder is removed.
5. Return `201 {agent: AgentSummary}`.

The agent is `hibernated` and starts on its first message, as in S3.

### 6.3 Edit (`PATCH /api/agents/:slug`)

Body: any of `{displayName, description, reportsTo, credential, projects: string[] | null}`. `projects: null` resets to the template default (`grants_overridden = false`, grants recomputed from the snapshot). Template and slug can't be changed. PATCH works on archived agents too. If the credential, grants, manager, display name or description changed (all of them feed the CLAUDE.md, the settings or the env), it calls `requestRestart(agentId)` (§13). A changed display name or description also calls `requestRestart` for each non-archived direct report, whose CLAUDE.md names its manager.

After every mutation (create, edit, re-sync, archive, unarchive) `AgentService` calls `runtimes.refresh(agentId)` (a no-op when no runtime exists yet), which reloads the row into the runtime (`AgentRuntime.agent` becomes mutable) in a job on that agent's serial queue and republishes `agent_status`. `AgentSummary` is built from a DB query (agent, credential name, grants, `grantsOverridden`, tree `depth`) merged with each runtime's live fields (`status`, `turnOpen`, `lastError`, `restartPending`, `restartWaitingOn`). The runtime never trusts a row captured earlier: `ensureStarted` reloads the agent row, grants, credential and manager from the DB inside its job (§13).

### 6.4 Re-sync (`POST /api/agents/:slug/resync`)

1. Refuse an archived agent (`409 agent_archived`; restore it first). Rescan the template. If it's missing: `409 template_missing` ("Template x no longer exists."). If it has errors: `409 template_invalid`.
2. `Workspace.resync` (§8.2), holding the agent's **workspace lock** (§8.3) through step 3: back up the differing files, overwrite the template-owned files, install the listed plugins.
3. Update the snapshot and the `runtime` column. If `grants_overridden` is false, recompute the grants from the new `projects`.
4. Call `requestRestart`.
5. Return `200 {agent, backupDir?}`. The UI says "Re-synced. Previous files saved in .factory/resync/<ts>." when a backup was made.

A plugin install failure returns `502 plugin_install_failed` with stderr. Files already copied stay (the backup covers them), there's no rollback, and the snapshot isn't updated.

### 6.5 Archive and unarchive

- **`POST /api/agents/:slug/archive`.** Rejected with `409 has_reports` ("@x reports to this agent. Change their manager first.") while non-archived agents report to it. Otherwise it sets `archived_at`, stops a running process now (`stop({graceMs: 3000, termWaitMs: 10_000})`), and returns `200`. The UI shows an inline **Undo**.
- **What an archived agent keeps and loses.** It keeps its workdir, session, grants and credential reference. It is hidden from the default list, its session view is read-only (no composer or actions), and messages, compact and interrupt to it return `409 agent_archived`. The check runs in the route and **at the top of** the runtime's `sendMessage`, `compact` and `interrupt` jobs (against an in-memory `archived` flag that the archive route sets synchronously before stopping, and that `refresh` reloads), and in `ensureStarted`. `sendMessage` creates the message row only after that check, so a refused message is never stored. Messages still pending at archive time stay `pending`; after unarchive they go out with the next start, which the next message, compact or a restart triggers (unarchive itself doesn't start the process, and the UI says "Pending messages are sent with the next message." when there are any). Queued compacts are dropped. `restartPending` is cleared. It still references its credential, so that credential can't be deleted until the agent is edited (§11.2).
- **`POST /api/agents/:slug/unarchive`.** Rejected with `409 manager_archived` ("Its manager @m is archived. Change its manager first.") when its manager is archived. That needs an edit first, so `PATCH` is allowed on archived agents. Otherwise it clears `archived_at`. The credential is always still there (§11.2).

### 6.6 Org tree v0

`GET /api/agents?archived=include|only` (default excludes archived) returns agents in **tree order**: depth-first from the roots (an agent whose manager is not in the listed set: no manager, or, when listing archived agents, an active manager), siblings by display name, each with `depth`. The ordering is a pure function in `packages/shared`, so the web can reuse it on `agent_status` updates.

## 7. Database (`packages/db`), one migration

```
templates
  name text pk, path text not null, config jsonb null (TemplateConfig when it parses), issues jsonb not null default '[]',
  content_hash text not null, scanned_at timestamptz not null
projects
  id text pk, name text unique not null, host_path text unique not null, created_at, updated_at
credentials
  id text pk, name text unique not null, kind text not null ('oauth_token' | 'api_key'),
  value_enc bytea not null, last_verified_at timestamptz null, last_error text null, created_at, updated_at
secrets
  id text pk, name text unique not null, value_enc bytea not null, created_at, updated_at
agents (+ columns)
  kind text not null default 'persistent', template text not null, config jsonb not null,
  runtime text not null ('local' | 'docker'), reports_to text null fk → agents (on delete restrict),
  credential_id text not null fk → credentials (on delete restrict), grants_overridden boolean not null default false,
  archived_at timestamptz null
agent_project_grants
  agent_id text fk → agents on delete cascade, project_id text fk → projects on delete restrict, pk (agent_id, project_id)
```

- `agents.template` is the template name as text, not a foreign key: templates can be deleted, and the agent keeps its snapshot.
- `runtime` is copied out of `config` because S5 and the UI filter on it.
- **Clean cutover for S3 data** (v0.1 is unreleased; the only rows are seeded dev agents): the migration **deletes every existing `agents` row** before adding the NOT NULL columns. `drizzle-kit generate` emits `ADD COLUMN … NOT NULL` without a default, so the generated SQL is hand-edited to start with `DELETE FROM agents;` (a comment says why), and a migration test runs it against a DB holding an S3 agent with events. Their `session_events`, `turns` and `messages` cascade. The PR's rollout notes say so and mention that `FACTORY_HOME/agents/dev/` stays on disk until removed by hand. There's no code path for template-less agents.

## 8. Workspace (`apps/server/src/workspace/`)

### 8.1 Layout and materialization (create)

```
FACTORY_HOME/agents/<slug>/            = process cwd (never moves: resume requires the same cwd)
├── AGENTS.md                          copied from the template; agent-owned
├── .claude/skills/<local>/            copied from the template's skills/ (when local_skills)
├── .claude/skills/<host> -> <hostSkillsDir>/<host>   symlink, recreated at every start
├── .claude-config/                    CLAUDE_CONFIG_DIR
│   ├── CLAUDE.md                      generated at every start (§10)
│   ├── settings.json                  rebuilt at every start (§9.1)
│   └── plugins/ …, projects/ …        plugin install output; the session JSONL
├── .mcp.json                          rebuilt at every start (§9.2)
├── .factory/template/settings.json    the agent's copy of the template's settings.json ({} when absent)
├── .factory/template/mcp.json         the agent's copy of the template's mcp.json ({"mcpServers":{}} when absent)
├── .factory/resync/<timestamp>/       re-sync backups, never pruned
├── projects/<name> -> <host path>     symlink per grant, reconciled at every start
└── … files/ contents from the template
```

`materialize(agent, template)`:
1. Create the workdir and copy `AGENTS.md`, `skills/*` (when `local_skills`), `files/**` (keeping modes; template symlinks are copied as symlinks) and the two `.factory/template/*` files.
2. Create `.claude-config/`.
3. `installPlugins` (§8.4).
4. Run `prepare` once in check-only mode, so a broken host skill or project fails creation, not the first message (§16).

It builds in place at the final path, never in a staging dir that's then renamed, because plugin install records absolute `installPath`s in `plugins/installed_plugins.json` (V9).

### 8.2 Re-sync

`resync(agent, template)` computes what the template would write: `AGENTS.md`, each `skills/<name>/**`, each `files/**` path, and the two `.factory/template/*` files.
- **Backup.** Every existing target whose bytes differ is copied first to `.factory/resync/<UTC timestamp, e.g. 2026-11-19T10-22-31Z (dashes, no colons)>/<same relative path>`. Identical files aren't backed up, and nothing is backed up when nothing differs.
- **Overwrite.** It then overwrites. Entries that exist in the workdir but not in the template (agent-made skills or files) are **left alone**: re-sync never deletes.
- **Plugins.** It runs `installPlugins` for the new list. Plugins dropped from the list stop loading, because `settings.json` keeps only the listed ones in `enabledPlugins` (§9.1, V8). Their files stay in the config dir.

### 8.3 Prepare (every process start)

Called by `AgentRuntime.ensureStarted` before spawning. Every workspace operation on an agent (materialize, re-sync, prepare) holds that agent's **workspace lock**, an in-process async mutex keyed by agent id and shared by `AgentService` and `AgentRuntime`, so a message that wakes an agent during a re-sync waits for it instead of reading a half-written `settings.json`. A running process never calls `prepare`, so the lock never blocks a live agent's event jobs. **Rule:** code holding a workspace lock never awaits a runtime job (`requestRestart`, `refresh`), because `ensureStarted` runs inside a job and waits for the lock. Re-sync therefore holds the lock through steps 2 and 3 of §6.4 (files, plugins, snapshot, grants) and calls `requestRestart`/`refresh` after releasing it, so a start never sees new files with an old snapshot. A message that wakes an agent during a re-sync can wait up to the 240 s plugin budget. All writes are idempotent:
1. **`resolveHostSkills(config.skills)`.** For each name (already restricted by the schema, so never `.` or `..`), `<hostSkillsDir>/<name>` must be a directory directly inside `hostSkillsDir` (it may itself be a symlink; its realpath is what S5 mounts), or the start fails with "Host skill grilling is missing from ~/.claude/skills.". It (re)creates the symlink `.claude/skills/<name>`. If a non-symlink entry already has that name, the start fails ("<path> isn't a link to the host skill; move it away."). It removes symlinks in `.claude/skills/` that point into the host skills dir but are no longer listed. The same function runs at creation.
2. **`linkProjects(grants)`.** For each grant, the project's `host_path` must exist, or the start fails with "Project app's folder /x is missing.". It creates or retargets the symlink `projects/<name>` and removes symlinks in `projects/` that are no longer granted. It never touches a non-symlink entry, and a non-symlink entry at a granted name fails the start.
3. Write `settings.json` (§9.1), `.mcp.json` (§9.2) and `CLAUDE.md` (§10), each atomically (temp file plus rename).
4. Resolve the env (§12.1): decrypt the credential and secrets. A missing credential or secret fails the start.

Failures go through S3's start-failure path: `error{source:"spawn"}`, `errored` status, `503 agent_start_failed`, and messages stay pending.

### 8.4 Plugins (`installPlugins`)

1. For each `extraKnownMarketplaces` entry of the agent's template settings that a listed plugin uses, run `claude plugin marketplace add <source>`.
2. Then run `claude plugin install <name@marketplace>` for each plugin.

- **Source argument.** The source is the CLI argument form of the settings entry: a directory path, a git URL, or `owner/repo` for GitHub.
- **Process.** Commands run with `FACTORY_CLAUDE_BIN`, cwd the workdir, and an env of exactly `PATH`, `HOME` and `CLAUDE_CONFIG_DIR`. No credential is needed (V9). Each has a 120 s timeout, and the whole install has a **240 s budget**, so a create or re-sync request always answers before Node's default 300 s `requestTimeout`. Exceeding the budget is a `plugin_install_failed` ("Plugin install took longer than 4 minutes."). The CLI output is passed through a redactor (URL credentials `https://user:pass@` and anything token-shaped) before it is returned or logged. Exit code ≠ 0 is a failure, carrying the last 20 stderr/stdout lines.
- **Idempotent.** Both commands are idempotent (V9: re-add and re-install exit 0).
- **When.** Only at creation and re-sync, never at start: plugins are third-party code, and updating them is an explicit human act.

### 8.5 Mounts for S5 (`buildMounts`, pure)

`Mount = {source, target, readOnly}`, every target equal to its source (path parity):
- the workdir (rw);
- each granted project path (rw);
- each host skill directory (ro);
- each directory-sourced marketplace path (ro; S0: otherwise the plugin is silently missing in docker).

The S5 CLI bundle mount is added by S5. Carried on `AgentRuntimeSpec.mounts` and ignored by the local launcher. Unit-tested.

## 9. Generated Claude configuration

### 9.1 `settings.json` (`buildSettings`, pure, rebuilt at every start)

Inputs:
- `tpl`: the parsed `.factory/template/settings.json`;
- `prev`: the existing config-dir `settings.json` (`{}` if absent or unparseable, which is logged);
- the snapshot;
- the grants;
- the workdir.

Output:
- **The base:** a deep copy of `tpl`, without `enabledPlugins`.
- **`extraKnownMarketplaces`:** `{...prev.extraKnownMarketplaces, ...tpl.extraKnownMarketplaces}` (plugin install writes there too; the template wins when a source changed).
- **`enabledPlugins`:** the entries of `prev.enabledPlugins` whose key is in `snapshot.plugins`. A listed plugin that failed to install simply stays absent.
- **`permissions.defaultMode`:** `"auto"` (or `"bypassPermissions"` when `permission_mode: bypass`). This is defence in depth behind the CLI flag, which wins anyway (V3).
- **`permissions.additionalDirectories`:** `[...(tpl.permissions?.additionalDirectories ?? []), ...grantedHostPaths]`, de-duplicated. Without it, edits through `./projects/<name>` are denied by the safety check (S0).
- **`autoMode`:** for each of `environment`, `allow`, `soft_deny`, `hard_deny`, the list is `"$defaults"` first, then the template's entries without any `"$defaults"`, then (environment only) the factory entries:
  1. "This is an Open Factory agent named @<slug>, run headless for the humans who operate this factory."
  2. "Its working directory <workdir> and the granted project repositories (<paths, comma-separated, or 'none'>) are trusted local workspaces."
  3. "The git remotes configured in the granted project repositories are trusted source control for this agent's branches and pull requests."

  A list is written only when it has entries beyond `"$defaults"`, except environment, which always has the factory entries. Setting a list without `"$defaults"` would replace Claude's defaults, including the default `hard_deny` Data Exfiltration rule (V6, V7). Templates can only add to Claude's rules, never replace them (decision Q23). The template docs say it once: "autoMode lists extend Claude's defaults; they can't replace them."
- **`claudeMdExcludes`** (factory-owned, V10): the absolute paths of `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` and `AGENTS.md` in **every ancestor directory** of the workdir up to `/`, plus the workdir's own `CLAUDE.md` and `CLAUDE.local.md`, appended to any template entries. Without it, a `~/CLAUDE.md` or `FACTORY_HOME/CLAUDE.md` loads into every agent **and stops the built-in agents-md plugin from loading the agent's `AGENTS.md`** (its persona); an ancestor `AGENTS.md` loads too. Nothing under `./projects/` is excluded: a repo's own `CLAUDE.md` carries its conventions and loads when the agent works there. `AGENTS.md` is where the agent keeps its own notes, and the CLAUDE.md protocol (§10) says so.
- Everything else the agent may have added to its `settings.json` is dropped at the next start. Template rules and factory keys are re-asserted every time.

**Caveat (stated in the CLAUDE.md docs and the PR).** In the local runtime the agent runs as the host user and can edit `.factory/template/settings.json`, so the re-assertion protects against drift, not against a hostile local agent. That trust decision is S5's `allow_local_runtime` gate and the Unsandboxed badge.

### 9.2 `.mcp.json` (`buildMcpJson`, pure, rebuilt at every start)

`{"mcpServers": {...tpl.mcpServers}}` from `.factory/template/mcp.json`. S6 adds the `factory` server here. It loads headless without `enableAllProjectMcpServers` (V1). The factory does **not** pass `--mcp-config`/`--strict-mcp-config`, because strict mode drops plugin-provided MCP servers (V2; closes #25).

## 10. Global CLAUDE.md (`buildClaudeMd`, pure)

Regenerated at every start into `.claude-config/CLAUDE.md`. Deterministic: no timestamps, statuses or other volatile values, so its bytes only change when the inputs do (prompt-cache stability). It holds only what is true in S4. The persona stays in `AGENTS.md` and nothing from it is repeated. Each rule appears once, with a one-line reason where it changes behaviour.

```markdown
# Open Factory

You are @<slug> (<display name>), a persistent agent in an Open Factory: a team of Claude Code agents and the humans who run them. Your role and working style are in AGENTS.md.

## Who you are
- Description: <description>
- Manager: @<manager slug> (<manager display name>)   | No manager: you report directly to the humans.
- Template: <template>

## How messages reach you
Every message arrives in a `<factory-message from="…" kind="…" urgent="…" id="…">` envelope. `from` is the sender (`@handle` for a human). Several envelopes in one turn are separate messages, in order. Urgent messages interrupted what you were doing, so read them first.

Your whole session is visible to the humans who run this factory, so work in the open: say what you are doing and why.

## Your workspace
- Your working directory is <workdir>. It is yours; files you create there persist. Keep notes you want to carry forward in AGENTS.md: a CLAUDE.md you create in the working directory is not loaded.
- Granted projects (read and write):
  - `./projects/<name>` → <host path>
  (or: "No projects are granted to you.")
- To change code in a project, create your own git worktree under `<repo>/.worktrees/<slug>-<branch>` instead of editing the main checkout, so you never disturb the humans' or other agents' work.
- Environment variables provided to you: <SECRET names, comma-separated> (or omitted when none). Use them; never print their values.
```

Snapshot tests assert the structure (sections present or absent per input: manager or none, projects or none, secrets or none), not the prose. S6 adds "Your org" and the messaging tools, and S7 and S9 add their guidance.

## 11. Credentials and secrets

### 11.1 Encryption (`Vault`)

- **Algorithm.** AES-256-GCM with the existing HKDF subkey `deriveKey(FACTORY_SECRET_KEY, "secret-encryption")`.
- **Blob layout.** `[version 0x01][12-byte random nonce][ciphertext][16-byte tag]`.
- **AAD.** `"<table>:<row id>"`, so a ciphertext can't be moved between rows. The version byte is the seam for key rotation, which is out of scope.
- **Never exposed.** Values are never returned by any API, logged, or put in an event or error. Code never logs a runtime spec or an env object. The logger keeps S3's redact paths (`*.CLAUDE_CODE_OAUTH_TOKEN`, `*.env.CLAUDE_CODE_OAUTH_TOKEN`, `*.*.CLAUDE_CODE_OAUTH_TOKEN`) minus `config.claudeToken`, and adds the same three shapes for `ANTHROPIC_API_KEY`, plus `*.value`, `*.*.value`, `*.token` and `*.env`. A logger test asserts that a credential value, a secret value and a plugin stderr containing `https://user:pass@host` never appear in the output.

### 11.2 Credentials

- **Name** matches `^[a-z][a-z0-9-]{0,38}[a-z0-9]$`. **Kind** is `oauth_token`, injected as `CLAUDE_CODE_OAUTH_TOKEN`, or `api_key`, injected as `ANTHROPIC_API_KEY`. The value is trimmed and at most 4 KiB.
- **API.**
  - `GET /api/credentials` returns `[{name, kind, lastVerifiedAt, lastError, usedBy: slug[] (non-archived), archivedUsedBy: slug[]}]`.
  - `POST /api/credentials {name, kind, value}`: verify, then store.
  - `PUT /api/credentials/:name/value {value}`: verify, then replace; calls `requestRestart` for every non-archived agent using it.
  - `POST /api/credentials/:name/verify` re-verifies the stored value and records `last_verified_at` or `last_error`.
  - `DELETE /api/credentials/:name` returns `409 credential_in_use` while **any** agent row references it, archived ones included: "Used by @a, @b. Change their credential first." plus "Archived agents @c still reference it. Edit them first." `credential_id` is a NOT NULL foreign key with ON DELETE RESTRICT, so every agent always has a credential; PATCH works on archived agents, and unarchive never meets a missing credential (§22 Q24).
- **No rename** (delete and add again).

### 11.3 Secrets

- **Name** matches `^[A-Z_][A-Z0-9_]{0,63}$`. Reserved, and rejected: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, `NODE_OPTIONS`, `LC_*`, `LD_*`, `DYLD_*`, `CLAUDE_*`, `ANTHROPIC_*`, `GIT_AUTHOR_*` and `GIT_COMMITTER_*`. The value is at most 64 KiB.
- **API.**
  - `GET /api/secrets` returns `[{name, updatedAt, usedBy: slug[]}]`. `usedBy` is the non-archived agents whose snapshot lists the secret.
  - `PUT /api/secrets/:name {value}` upserts and calls `requestRestart` for every agent in `usedBy`.
  - `DELETE /api/secrets/:name` deletes and calls `requestRestart` for every agent in `usedBy`, so a revoked (maybe leaked) value leaves live processes. It is irreversible, so the UI confirms ("Delete GH_TOKEN"), naming the agents that receive it. Those agents then fail to start until it's re-added.
- **Values are write-only.** The UI shows "Set" and an update field, never the value.

### 11.4 The verification turn (`CredentialVerifier`)

- **The run.** A one-shot run through the real `HarnessDriver` with a throwaway temp dir as both cwd and `CLAUDE_CONFIG_DIR`. The env is exactly `PATH`, `HOME`, `CLAUDE_CONFIG_DIR` and the credential var, never the server env. It uses `model: "haiku"` and `permissionMode: "auto"`, and sends one message: "Reply with the single word OK." It waits for `turn_end` or `exited` (60 s timeout), then `stop()`s and removes the temp dir. It costs about $0.002 and takes 3–5 s (V6).
- **Classification.** It relies on a small mapper extension. The API error arrives in two lines: the synthetic assistant message carries `error:"authentication_failed"` and becomes the turn's one `error` event, now with an optional `code`; the later `result` carries `api_error_status:401`, which goes on `turn_end` as an optional `apiErrorStatus` (the second error stays suppressed). The verifier reads both:
  - success is `turn_end{isError:false}`;
  - an auth failure is `error.code === "authentication_failed"` or `turn_end.apiErrorStatus` 401/403: "Claude rejected this token. Create a new one with `claude setup-token`." (for API keys: "Claude rejected this API key.");
  - anything else (no session, network, 5xx, timeout) is transient: "Couldn't reach Claude to verify. Try again.".
- **Outcome.** Neither failure stores anything on add or replace.
- **Fixture.** `error-invalid-oauth-token` (§19).

## 12. Runtime spec and environment

### 12.1 `buildAgentEnv`

S3's allowlist, unchanged: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM` and `TMPDIR` are copied from the server env when set. On top of it the factory sets:
- `CLAUDE_CONFIG_DIR`;
- the credential var (one of `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`);
- each snapshot secret by name;
- `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME` = `<slug>`;
- `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL` = `<slug>@open-factory.local`.

Nothing is spread from `process.env`. A test asserts that `DATABASE_URL`, `FACTORY_SECRET_KEY`, the server's own `ANTHROPIC_*` / `CLAUDE_*` and an unknown var never reach an agent or a verification run, and that two agents with different credentials get their own values. In the local runtime `HOME` is the host user's, so the host's `~/.gitconfig` and git credential helpers apply (only the name and email are overridden). `SSH_AUTH_SOCK` is deliberately **not** passed (decision R4): the host's ssh-agent would hand every local agent all of the host's keys. Agents push over HTTPS with a token secret (e.g. `GH_TOKEN`), an explicit per-template grant. Both points are documented.

### 12.2 `AgentRuntimeSpec` (packages/harness, extended)

```ts
interface AgentRuntimeSpec {
  agentId: string; slug: string;
  cwd: string; env: Record<string, string>; claudeBin: string;
  runtime: "local" | "docker";
  model?: string; effort?: string;
  permissionMode: "auto" | "bypass";
  mounts: Mount[];              // §8.5; the local launcher ignores them
}
```

`buildClaudeArgs`: `auto` → `--permission-mode auto`; `bypass` → `--dangerously-skip-permissions`. Only reachable with docker, so it isn't run in S4.

### 12.3 `buildRuntimeSpec(agent, ctx)`

This is where the snapshot's model, effort and permission mode, the env, the mounts and the runtime are assembled. `FACTORY_DEV_MODEL` is gone.

### 12.4 Docker agents

`ensureStarted` fails before spawn for `runtime: docker`: "The Docker runtime isn't available yet." It takes S3's start-failure path. The log line and a code comment name S5. The workspace is still prepared, so creating a docker agent exercises everything except the launcher.

## 13. Applying changes: `requestRestart(agentId)` (the seam)

One function on `AgentRuntimes`, called by every edit path:
- an agent edit;
- re-sync;
- a credential value replace;
- a secret value change (for each receiving agent);
- a project path change (for each granted agent).

S5 replaces its body with hibernate or re-create, and no caller changes.

S4 body. Everything below runs **as jobs on the agent's S3 serial queue**, so it is ordered against starts, deliveries and events. `requestRestart` is a no-op when no runtime exists for the agent (runtimes are created lazily); it awaits its job, so a PATCH response already shows `restartPending`.

- **`requestRestart` enqueues a job** that sets `restartPending` (published in `agent_status` with `restartWaitingOn: number`, the count of live non-ambient background tasks, shown as "Restarts when idle to apply changes" plus "(waiting on 1 background task)" when non-zero; it waits indefinitely, and S5 owns forcing a restart) and calls `maybeRestart()`. If no process is running, the next start's `prepare` reloads everything from the DB anyway. A start is itself one job, so `requestRestart`'s job runs either before it (the start reads the new values) or after it (the process is running and is restarted below).
- **`maybeRestart()`** runs inside that job and again **at the end of every `turn_end` and `exited` job** and after the urgent hold or a compact in flight is released (not after `background_tasks`, see below). It acts only when all of these hold:
  - `restartPending`, a process is running, and it is not the dead process of a failed job (`proc !== deadProc`), not `errored`, not already `restarting`, not `stopping`;
  - no turn is open; no batch is in flight or awaiting its turn; no compact is in flight; no urgent hold is active;
  - the live **non-ambient** background-task set is empty. `AgentRuntime` tracks that set from `background_tasks` events and resets it on `process_started`; ambient tasks don't count, per S3's event contract (no fixture shows `ambient` yet, so this is tested with synthetic events);
  - **no notification turn is owed:** a counter goes up on each `background_task_finished` and down on each `turn_end` with `originKind: "task-notification"` (floored at 0, reset on `process_started` and `exited`). The empty `background_tasks_changed` arrives about 100 ms **before** the notification turn's `system/init` (`background-bash-start-finish`), so without the counter a restart would close stdin just before that turn.
- **Restart.** At a safe moment the job sets `restarting = true` and calls `proc.stop({graceMs: 3000, termWaitMs: 10_000})` **without awaiting it inside the job**. It must not await `AgentRuntime.stop()`: that waits for the job queue to drain, and the `exited` event that ends the stop is itself a job queued behind the caller (a deadlock). The stop's promise is observed outside the job. If it resolves `{timedOut: true}` (no `exited` ever came, per S3's `stop()`), a job clears `restarting`, marks the agent `errored` ("Couldn't restart the agent: the process didn't stop."), and logs it. While `restarting` is set, `flush()` writes nothing, so a message arriving during the stop grace stays `pending` and no spurious `delivery_failed` appears.
- **`stop()` and archive** (and `stopAll` on shutdown) set `stopping = true` synchronously before stopping, which also clears `restarting` and `restartPending`. Archive stops the process the same way as shutdown (`AgentRuntime.stop({graceMs: 3000, termWaitMs: 10_000})`, awaited by the route, outside any job).
- **`exited`** (any exit) clears `restarting` and `restartPending` and resets the counters. If the exit ended a restart (`restarting && !stopping && !archived`) and the delivery queue holds pending items, the same job runs `try { await ensureStarted(); await flush(); }`. An `AgentStartError` or an archived refusal is swallowed there, because it is already recorded as an `error` event and `errored` with its real message and `fix`. Any other error goes to `onJobFailure` for the **new** process, which is stopped. **S3 rule 5 changes here:** besides the send and compact API jobs, a deliberate restart may start the process; crash exits still never do. Otherwise the next message starts the process with `--resume`, and the session is kept.
- Tests (fake driver): a restart waits for an open turn, an in-flight or awaiting batch, a compact in flight, an urgent hold, a live non-ambient task and an owed notification turn (the `background-bash-start-finish` ordering), and ignores an ambient one; a message during the stop grace is delivered after the restart with no `delivery_failed`; `requestRestart` racing a start; pending items trigger the restart's own start and are flushed; a start failure inside the restart keeps its real error; shutdown or archive during a restart grace never respawns; a timed-out stop marks `errored`; an unexpected exit or an archive clears `restartPending`; the same session id is resumed.

Known loss, stated in the UI copy's tooltip and the docs: live session crons (`CronCreate`) die on restart. Pinning is S9.

## 14. HTTP API summary

All routes require a signed-in user (S3's `onRequest` hook) and use the S1 error shape. Schemas live in `packages/shared`.

| Method & path | Result |
|---|---|
| `GET /api/templates` | `{dir, templates: TemplateSummary[]}` (`dir` = the templates folder path; summary: `name, errors, warnings, agentCount`, and `displayName, description, runtime` only when the template parses) |
| `GET /api/templates/:name` | `{template: TemplateDetail}` (`path`, the parsed `config` when it parses (runtime, model, effort, skills, plugins, secrets, projects), files with `content` and `hash`, `issues`, `agents`) · `404 template_not_found` |
| `POST /api/templates` | `201` · `409 template_exists` |
| `PUT /api/templates/:name/files/:file` | `200 {hash, issues}` · `409 changed_on_disk {currentHash}` · `404 template_not_found` (folder gone) |
| `POST /api/templates/:name/validate` | `{issues}` (the whole template's issues, with the content substituted) · `404 template_not_found` |
| `DELETE /api/templates/:name` | `204` |
| `GET /api/agents`, `GET /api/agents/:slug` | S3 shape (`runtime` widened to `local \| docker`) plus `kind, template, reportsTo, credential, projects, grantsOverridden, depth, archivedAt, restartPending, restartWaitingOn`; `description` was already there |
| `POST /api/agents` · `PATCH /api/agents/:slug` | `201/200 {agent}` · `400 validation_error` (field errors) · `409 slug_taken`, `folder_exists`, `template_invalid` · `502 plugin_install_failed` |
| `POST /api/agents/:slug/resync` · `/archive` · `/unarchive` | §6.4–6.5 |
| `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:name` | §14.1; DELETE: `204` · `409 project_in_use {grantedTo, archivedGrantedTo}`; the `200` of POST/PATCH and every list row carry `templates` |
| `GET/POST /api/credentials`, `PUT /:name/value`, `POST /:name/verify`, `DELETE /:name` | §11.2 |
| `GET /api/secrets`, `PUT/DELETE /api/secrets/:name` | §11.3 |

Field-level validation errors use `400 {error:{code:"validation_error", message, fields:{<field>: message}}}` so long forms can place them under their fields. The S1 error handler (`apps/server/src/errors.ts`) gains the mapping: for a Fastify body-validation error, each Zod issue's first path segment becomes the field key and its message the value (the first issue per field wins). Service-level checks (slug taken, cycle, unknown project) throw a `FieldError(field, message)` that the handler renders the same way.

### 14.1 Projects

- **Name** matches `^[a-z][a-z0-9-]{0,38}[a-z0-9]$` and is immutable. **`host_path`** must be absolute, is stored as its realpath, must be an existing readable directory (not required to be a git repo), and must be unique.
- **`PATCH {hostPath}`** calls `requestRestart` for each granted non-archived agent (its symlink and `additionalDirectories` change at the next start).
- **`DELETE`** returns `409 project_in_use` ("Granted to @a, @b. Remove the grant first.", archived agents listed separately as for credentials) while **any** agent, archived ones included, holds a grant (`agent_project_grants.project_id` is ON DELETE RESTRICT). Templates that list the project show "unknown project" after the next scan; the response includes `templates: name[]` that list it, so the UI can say so.
- **List.** `GET` lists projects with `grantedTo` (non-archived), `archivedGrantedTo` and `templates` (template names listing it).

## 15. Harness changes (`packages/harness`)

- **Deny-rule visibility.** A `permissions.deny` rule on Read/Edit/Write emits no `system/permission_denied`, only an error `tool_result` and an entry in `result.permission_denials[]`. A Bash rule does emit the system event, with `decision_reason_type:"subcommandResults"` and no `decision_reason` (V5). Both cases also carry `tool_result_meta[{id, permission_decision:{decision:"reject", source, reason_type}}]` on the `user` line holding the tool result (the Read rule: `reason_type:"rule"`, `source:"user_reject"`).
  - **Live.** On a `user` line, for each `tool_result_meta` entry with `permission_decision.decision === "reject"` whose id has not been reported, the mapper emits `permission_denied{toolName (from a tool-use-id → name map it keeps), toolUseId, reasonType: permission_decision.reason_type ?? "rule", reason: <the tool_result text with <tool_use_error> tags stripped>}` before the `tool_result`. In every fixture the system event, when there is one, comes before the user line. Hook rejections that carry the same meta are reported too, which is intended: they are denials the human should see.
  - **Fallback.** On `result`, before `usage`/`turn_end`, it emits the same for any `permission_denials[]` entry still unreported (`reasonType:"rule"`, reason "Denied by a permission rule").
  - The mapper tracks reported ids **per process** (whether `permission_denials` is cumulative across turns is unverified), so nothing is emitted twice. The UI pairs a denial under its tool call by `toolUseId`, as it does for results.
  - Fixture: `permission-deny-rules` (two denials, one each way, no duplicates); `permission-denied` (classifier) yields no derived duplicate.
- **`error` events** gain an optional `code`, and **`turn_end`** an optional `apiErrorStatus` (§11.4). Start-failure `error` events gain an optional `fix: "credentials" | "secrets" | "projects" | "edit_agent"` (set by the runtime, never by the mapper), which the UI turns into a link.
- **`system/api_retry`** (emitted while Claude retries a failed API call, e.g. twice on a 401) is dropped and asserted to yield nothing. The fixture `error-invalid-oauth-token` sits in `fixtures/pending/` on the design branch, because the all-fixtures test fails on an unmapped type. The implementation moves it next to the others in the same commit as the drop.
- `AgentRuntimeSpec` and `buildClaudeArgs` change as in §12.2.

## 16. Failures

| Failure | What happens |
|---|---|
| Template has errors | Create or re-sync `409 template_invalid` with the issues; the UI shows them. |
| Plugin install fails at create | The workdir is removed; `502 plugin_install_failed` with stderr; no DB row. |
| Plugin install fails at re-sync | `502`; copied files stay (backed up), and the snapshot is unchanged. |
| Host skill, project folder, credential or secret missing at start | `error{source:"spawn", message}` → `errored`, `503 agent_start_failed`; messages stay pending. Messages name the fix ("Add it in Settings → Secrets."). |
| Docker agent started | Same path: "The Docker runtime isn't available yet." |
| Resume of a missing session | As in S3 (`errored`, messages pending); the error row names `pnpm agent:reset-session <slug>`. |
| `settings.json` in the config dir unparseable | Logged; treated as `{}` (plugin keys lost, so plugins don't load until re-sync). |
| Verification can't reach Claude | "Couldn't reach Claude to verify. Try again."; nothing stored. |
| Template file changed on disk during an edit | `409 changed_on_disk`; the UI offers Reload. |
| Archive with active reports / unarchive under an archived manager | `409` naming them. |
| `FACTORY_SECRET_KEY` changed | `open()` fails the GCM tag check; the start fails with "Can't decrypt credential x. Was FACTORY_SECRET_KEY changed?". Rotation is out of scope. |

## 17. UI (summary; details in the UI design doc)

- **Templates** (`/templates`, `/templates/$name`, `/templates/new`):
  - a list with plain-language validation state ("2 errors", "1 warning");
  - a template page with tabs for `template.yaml`, `AGENTS.md`, `settings.json` and `mcp.json` (mono textarea editors, validated on blur and on save, issues with line and column under the editor);
  - "Create agent" (a link to New agent with the template preselected) and "Delete <name>" (confirmation).
- **Agents** (`/agents`, `/agents/new`, `/agents/$slug/edit`):
  - the org tree v0 (indented rows, an "Archived" filter);
  - the New agent and Edit pages (validated on blur and on submit; grants preselected from the template, with "Use template default");
  - Re-sync, and Archive with inline Undo.
- **Settings** (`/settings`): one page, three sections in this order: Credentials (add with "Verifying…", Verify, Replace, delete with confirmation), Secrets (write-only, delete with confirmation), Projects.
- **Session view:**
  - the agent strip gains the template, the manager, the credential and the runtime (Unsandboxed for local), plus "Restarts when idle to apply changes";
  - archived agents are read-only;
  - denials pair under their tool call.
- The S3 empty-state copy about `pnpm seed:dev-agent` becomes "No agents yet. Create one from a template." with links.

## 18. Testing

No automated test calls a live model or the network.

### 18.1 Unit (pure functions)

- **Validator:** every error and warning in §5.3, line and column for YAML and JSON errors, unknown keys, and the substituted-content validate path.
- **Generators** (`buildSettings`, `buildMcpJson`, `buildClaudeMd`, `buildMounts`, the tree order):
  - `buildSettings`: `$defaults` placement in all four lists, template arrays concatenated, plugin keys carried and filtered, agent-added keys dropped, `defaultMode`;
  - `buildClaudeMd`: structural snapshots, and identical bytes for identical inputs.
- **Vault:** round trip, a tampered blob, the wrong AAD, the version byte.
- **Names and slugs:** the slug, name and secret rules, plus cycle detection.

### 18.2 Harness

- The mapper over the new fixtures:
  - `permission-deny-rules` yields two `permission_denied` events (one system, one derived with `reasonType:"rule"`) and no duplicates;
  - the existing `permission-denied` fixture yields no derived duplicate;
  - `error-invalid-oauth-token` yields `error{code:"authentication_failed", status:401}`.
- Args for `bypass`.

### 18.3 Server (real Postgres, temp `FACTORY_HOME`, temp host skills dir, fake `claude`)

- **Fake `claude` extensions.** `plugin marketplace add|install` subcommands (they record their args and write `enabledPlugins` / `extraKnownMarketplaces` like the real CLI; one scenario fails with exit 1), and a scenario that replays `error-invalid-oauth-token`.
- **Create:** the full layout on disk, the DB rows, rollback on a plugin failure and on a DB failure, an existing-folder refusal, an invalid template, missing credential or project.
- **Prepare:** symlinks created, retargeted and removed (never non-symlinks), a missing host skill or project, `settings.json` and `.mcp.json` rebuilt with agent edits dropped, a deterministic CLAUDE.md, docker fails closed.
- **Env:** the allowlist plus credential, secrets and git identity; the negative assertions in §12.1; two agents with different credentials.
- **Re-sync:** backup only of differing files, no deletion, the grants follow the template unless overridden, a plugin failure, the plugin budget, the `runtime` column updated, refused for archived agents.
- **Races:** two creates of the same slug (one wins, the loser leaves the winner's folder intact); a message waking an agent during a re-sync waits for the workspace lock; a queued send to an agent archived meanwhile is refused inside the runtime job.
- **Security:** route params with `..`, `%2F` and absolute paths are rejected before any fs call (DELETE and PUT templates, agent slugs); host skill names `.`/`..` rejected; a symlinked template folder is deleted as a link only.
- **Edit, archive, unarchive:** the rules, Undo, 409s, refusing messages to archived agents.
- **`requestRestart`:** with the fake driver, a restart waits for an open turn, an in-flight batch, an urgent hold and live background tasks; it resumes the same session; pending messages trigger the restart; not running is a no-op.
- **Credentials:** verification success, auth failure and transient failure (fake driver), nothing stored on failure, never returned or logged (assert on the logger output), delete blocked while in use. **Secrets:** upsert marks recipients, delete.
- **Templates API:** hashes and `409 changed_on_disk`, writes of invalid content, rescan picking up on-disk edits and deletions.
- **Migration:** existing agents deleted, columns added.

### 18.4 Live check (`pnpm smoke:workspace`, not part of `pnpm test`)

Uses only the token file from the environment and `--model haiku`. It creates two temp templates (`runtime: local`) with different settings, a template-local skill, a host skill from a temp host skills dir, a `permissions.deny` on `Read(./secret.txt)` and on `Bash(curl:*)`, and one granted temp git repo. It creates two agents through `AgentService` with two credentials (the same token stored twice is fine for this check), runs one turn each, and asserts:
- each `system/init` lists only its own skills and no host skills or plugins;
- an Edit through `./projects/<name>` succeeds;
- both denials appear as `permission_denied` events and the turn continues;
- the CLAUDE.md identity is quoted back correctly.

The PR records its output.

### 18.5 Web

The Templates list, editor and blur validation; the New agent form (field errors, grants default and override); the tree order and indentation; archive and Undo; the Settings sections (verifying state, write-only secrets, delete confirmations); the strip additions. Details are in the UI doc.

## 19. Verified for this design (Claude Code 2.1.327, haiku, `CLAUDE_CODE_OAUTH_TOKEN`, fresh `CLAUDE_CONFIG_DIR`)

Traces scrubbed with S0's `spikes/scrub.mjs` and added to `packages/harness/fixtures/` with README entries.

| # | Claim | Fixture | If wrong |
|---|---|---|---|
| V1 | A project `.mcp.json` in the cwd loads headless **without** `enableAllProjectMcpServers` (`source:"project"`, connected, tool callable). | `mcp-project-without-enable-all` | Add `enableAllProjectMcpServers: true` in `buildSettings`. |
| V2 | `--mcp-config <f> --strict-mcp-config` **drops plugin-provided MCP servers** (the plugin still loads). Without strict, both plugin and project servers load. | `mcp-plugin-and-project`, `mcp-strict-drops-plugin-servers` | Revisit #25. |
| V3 | The CLI `--permission-mode auto` overrides `permissions.defaultMode: "dontAsk"` in the config-dir settings (init `permissionMode:"auto"`); without the flag the mode is `dontAsk`. | `permission-mode-flag-overrides-dontask` | `buildSettings` already writes `defaultMode` explicitly. |
| V4 | With a fresh config dir, none of the host's `~/.claude/skills` or plugins appear in `system/init` (only built-ins). | in `mcp-project-without-enable-all` (init) | AC1 would need a different isolation mechanism. |
| V5 | A `permissions.deny` Bash rule emits `system/permission_denied{decision_reason_type:"subcommandResults"}` with only `message`. A Read rule emits **no** system event, only an error `tool_result` and `result.permission_denials[]`. | `permission-deny-rules` | §15 derivation unnecessary or insufficient. |
| V6 | Setting any `autoMode` list **replaces** Claude's defaults for it (defaults: environment 21, allow 16, soft_deny 72, hard_deny 1 = Data Exfiltration). | `auto-mode-defaults-merge.txt` | — |
| V7 | `"$defaults"` as a list entry keeps the defaults and appends; a custom `hard_deny` was enforced by the classifier. | `auto-mode-defaults-merge.txt`, `auto-mode-hard-deny-custom` | `buildSettings` must merge the defaults itself (from `claude auto-mode defaults`). |
| V8 | A plugin installed in the config dir but absent from `enabledPlugins` doesn't load (nor its MCP server). | timeline note in the fixtures README | Re-sync must `claude plugin uninstall` dropped plugins. |
| V9 | `claude plugin marketplace add` / `install` need no credential, re-runs exit 0, and a failure exits 1 with a message. `installed_plugins.json` records absolute `installPath`s. | fixtures README note | Install with the credential; never move a config dir. |
| V10 | A `CLAUDE.md` in an **ancestor** of the cwd loads into the session **and the built-in agents-md plugin then doesn't load the cwd's `AGENTS.md`** (2 of 2 runs). With no ancestor `CLAUDE.md`, an ancestor `AGENTS.md` loads too. `claudeMdExcludes` with the absolute paths of the ancestor files removes them, and the cwd's `AGENTS.md` loads again. Version-sensitive: re-check on Claude Code upgrades. | `ancestor-claude-md-suppresses-agents-md`, `ancestor-agents-md-loads`, `claude-md-excludes-ancestors` | Without excludes, AC2 fails on any host with a `~/CLAUDE.md`. |
| — | Verification turn: about $0.002 and 3–5 s on haiku. A bogus OAuth token: two `api_retry` (401), a synthetic assistant message with `error:"authentication_failed"`, then `result{is_error:true, terminal_reason:"api_error", api_error_status:401}`, exit 1, about 4 s. | `pending/error-invalid-oauth-token` (§15) | §11.4 classification. |

## 20. Issues consumed from S3

- **#25 (`--mcp-config` / `--strict-mcp-config`):** decided against, with V1 and V2. Closed.
- **#18 (allow_local_runtime gate):** stays S5. S4 agents are local and show Unsandboxed.
- **#19, #20, #24:** S5. #21, #22, #23, #26 are untouched.
- The S3 known gap "resume works only from the same cwd": S4 never moves a workdir (§8.1).

## 21. Known gaps and follow-ups (issues to open)

- Live session crons die on an apply-restart; S9 pinning will have to make `requestRestart` wait for them, or S5's version must (#31).
- Re-sync never deletes stale skills or files, and plugins dropped from a template stay installed (disabled) in the config dir (#33).
- An unparseable config-dir `settings.json` loses its plugin keys until re-sync.
- There's no in-app restore from a re-sync backup (manual copy) (#33).
- Credential and secret key rotation (the version byte is the seam) (#34).
- An editable per-agent git identity (#35).
- Template `skills/` and `files/` aren't editable in the UI (#36).
- The `image` field is stored but unused until S5/S10.
- S6: a slug may equal a human `@handle`; decide cross-uniqueness with `@` addressing (#29).
- S7: credential and project deletes are RESTRICTed by every agent row, so a credential ever used by a (retained) terminated ephemeral agent can never be deleted; S7 must exempt terminated agents or re-point them (#30).
- The `api_key` credential kind is unverified live (no fixture); its 401 classification assumes the same `authentication_failed` shape (#32).
- `pnpm agent:reset-session` is interim; S5 (#19) replaces it.

## 22. Decisions needing Or's call (owner-proxy certainty 3/5)

- **Q4 template delete:** delete with a confirmation dialog, not a `.trash` folder and Undo. Fallback: no delete in S4.
- **Q5 re-sync:** immediate, with a backup of differing files to `.factory/resync/<ts>/` (never pruned), and no in-app undo.
- **Q6 `settings.json`:** fully rebuilt at every start from the template copy, plus the carried plugin keys and the factory keys. Agent-added keys don't survive.
- **Q8 grants:** a `grants_overridden` flag; re-sync follows the template only when not overridden.
- **Q9 apply-restart:** a graceful restart when idle (no turn, no background tasks), resuming the session; `requestRestart` is the S5 seam.
- **Q10 S3 leftovers:** the migration deletes every pre-S4 agent row (clean cutover) instead of archiving them.
- **R1 (part) own-workdir CLAUDE.md excluded:** the agent's own `<workdir>/CLAUDE.md` and `CLAUDE.local.md` are excluded too, rather than documented.
- **R2 resume recovery:** the interim `pnpm agent:reset-session <slug>` CLI (server must be stopped), to be replaced by S5 (#19).
- **R7 apply-restart timing:** ambient tasks don't block; other live background tasks block indefinitely; a secret delete restarts its receivers; a rename restarts the reports.
- **Q24 credential delete:** blocked while any agent, archived ones included, references the credential (NOT NULL foreign key, RESTRICT). Archiving doesn't free a credential.
