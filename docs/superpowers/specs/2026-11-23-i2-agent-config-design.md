# I2 Agent config: Technical Design

Task spec: `docs/product/roadmap/v0.0.2/i2-agent-config.md` (gitignored; main checkout). Decision: ADR 0023. Pre-release rules: ADR 0028 (no compatibility code, no data migration). Builds on I4 (form rules), I1 (Chat and Session, notices), U4 (sheets, CodeMirror editor). Consumers: I5 (Library pickers in the form), I7 (`manage_org` tools edit the overlay; restart notices).

Decision log: the GitHub issue "I2: Agent config — design" (one comment lists every question, the alternatives, the proxy's answer and certainty).

## 1. Goal

Configure one agent without forking its template, and configure templates and agents without hand-writing JSON:

- `agents.config` becomes the agent's **overlay**: only its differences from its template, one JSON document. At every start the factory merges the **current** template with the overlay. Template snapshots and Re-sync are deleted.
- Per-agent model and effort, and a per-agent identity colour from a 12-hue palette.
- One Configuration form, plus a Raw JSON tab, for templates (the baseline) and agents (the overlay, with inherited values marked).

## 2. Acceptance criteria

Each criterion names the PR that makes it true (§17).

1. (PR 1) A fresh agent has `config = {}` and runs on its template as written. Its generated `settings.json`, `.mcp.json` and `.claude/skills/` come from the current template merged with the overlay, rebuilt at every start.
2. (PR 1) Adding a host skill to a template (form, raw tab, or an edit on disk noticed on the next read) marks every live agent of that template whose merged config changed "Restarts when idle to apply changes", without any Re-sync. After the restart, the same session resumes with the skill. An agent's own added skill survives the template change. Editing a template's `AGENTS.md` or `files/` restarts nobody.
3. (PR 1) Each effective change writes a `config_changed` event to the agent's Session (who, what), and the agent receives a passive `@factory` notice listing the changes. Neither the event nor the notice ever prints an env, header or secret value.
4. (PR 1) An agent's added deny rule can be removed by a human by editing the overlay. A template deny rule can't be removed per agent: the merge unions arrays, and the form shows it read-only.
5. (PR 1) A template with errors, or a deleted template, fails its agents' next start closed with a message naming the fix. A template can't be deleted while any live or archived agent uses it.
6. (PR 1) Reset persona (AgentMenu, with a confirm dialog) replaces the agent's `AGENTS.md` with the template's and backs up the old file under `state/agents/<slug>/persona/<UTC>/AGENTS.md`.
7. (PR 1) Re-sync, the template copy in `state/agents/<slug>/template/`, `grants_overridden` and the "From the template / Custom" marker are gone from code, API and UI.
8. (PR 2) The avatar palette has 12 hues. Edit agent shows Auto plus 12 swatches. Picking one recolours the agent's avatar everywhere (sidebar, lists, chips, speaker lines, palette, inbox) in both themes. Spawned agents are always Auto.
9. (PR 3) Switching one agent to Opus in its Configuration page leaves its template and siblings unchanged. The agent restarts when idle, resumes the same session, and its `system/init` shows the new model.
10. (PR 3) An MCP server added in the form (stdio or HTTP) whose env or header references a factory secret appears in the generated `.mcp.json` as `${NAME}`, which Claude expands from the process env. The secret is in that env, the raw tab shows the same entry, and no secret value is written to disk or shown in the UI (§5.5).
11. (PR 3) An unknown `settings.json` key added in the Raw JSON tab survives a form save, for templates and agents.
12. (PR 3) Every form follows I4 (reserved note line, `useFieldErrors`, `FormOutcome`, client messages ≤ 40 characters) and works at 390px and at 200% text.

## 3. Scope

In: everything in the task spec's Scope, Tasks 1–6.

Out: agent self-editing; agents removing template items; config history and undo (only activity events); per-agent avatar images; the Library (I5; until then skills come from the host list and plugins are typed as `name@marketplace`); `manage_org` tools (I7); a form for `runtime`, `image`, `permission_mode`, `projects`, `local_skills` (they stay in the `template.yaml` tab).

## 4. Inventory: today → after I2

| Area | Today (code) | After I2 |
|---|---|---|
| `agents.config` | Full `TemplateConfig` snapshot written at create and Re-sync (`agent-service.ts:506,672`; `db/schema/agents.ts`) | `AgentOverlay` (§5.1), default `{}`. Never holds template values |
| Template copy | `state/agents/<slug>/template/{settings,mcp}.json`, written by `copyTargets`/`writeTemplateCopy` (`workspace/files.ts`), read by `prepare` and `readTemplateSettings` | Deleted. `prepare` reads the effective config (§6.1) |
| Re-sync | `AgentService.resync`, `Workspace.resync/applyTargets/applyPending`, `resync-pending/`, `POST /api/agents/:slug/resync`, `resyncResponseSchema`, AgentMenu item, `lifecycle.resyncAgent`, timeline `ResyncFix`, fix code `"resync"` (`safe-fs.ts:22`, `agents/errors.ts:8`), WS `resync` message (`ws/route.ts:121`) | Deleted. `applyTargets` survives only as the backup+write helper for Reset persona (§9) |
| Template-local skills | Copied into `.claude/skills/` at create and Re-sync (`templateTargets`) | Linked live, like host skills (§6.4) |
| `AGENTS.md`, `files/` | Copied at create, again at Re-sync | Copied once at create. Reset persona for `AGENTS.md` (§9) |
| Plugins | Installed per agent at create and Re-sync. A start with a missing plugin fails "Re-sync…" (`workspace.ts:295`) | A start installs listed-but-missing plugins (§6.5) |
| Grants | `agent_project_grants` + `grants_overridden`, which follow the template on Re-sync. `PATCH projects: null` resets to the template | Agent identity: initialised from the template's `projects` at create, then never follows. `grants_overridden` dropped, `projects: null` dropped |
| Config readers | `row.config.*` in `may-spawn.ts`, `app.ts:535`, `spawn-service.ts:65,127,169,172,252`, `runtimes.ts:169`, `agent-runtime.ts:3316,3344`, `routes/agents.ts:103,339`, `agent-service.ts:352`, `start.ts:76,152` | The effective config (§6.1): from the runtime's last start where it describes the running process, else from the resolver |
| Spawn inheritance | Spawner's deny rules from its template copy (`start.ts:83`), secrets from `spawner.config.secrets` | From the spawner's effective config (current template + its overlay). Rules unchanged (S7 §6) |
| Change detection | `templates.content_hash` updated on every scan (`template-index.ts:152`), unused | A changed hash triggers the config-change flow (§7) |
| Restart | `requestRestart(id)`. An `apply_changes` notice only when crons were lost (`notices.restartCrons`) | `requestRestart(id, changes?)`. A `config_changed` notice and event (§7.3) |
| Avatar colour | `botParts(slug).fill` ∈ 1–8 (`lib/factory-bot.ts`), `--avatar-1..8` | `color ?? seeded(1–12)`, `--avatar-1..12` (§11) |
| Edit agent | Name, description, manager, credential, projects with the template marker | Plus Colour swatches and a model summary line linking to Configuration (§12.6). Marker removed |
| Template editor | Tabs per file with CodeMirror (`template-editor.tsx`, `code-editor.tsx`) | A Configuration tab first; the file tabs stay as the raw editors (§12.5) |

## 5. The overlay

### 5.1 Shape

One JSON document, file-shaped (kept so it can move to a file with mindmount later):

```json
{
  "template": { "model": "opus", "skills": ["release"] },
  "settings": { "permissions": { "deny": ["Bash(rm -rf:*)"] }, "env": { "LOG_LEVEL": "debug" } },
  "mcp": { "mcpServers": { "github": { "type": "http", "url": "https://…", "headers": { "Authorization": "Bearer ${GH_TOKEN}" } } } }
}
```

Every part is optional; `{}` means "exactly the template". Shared Zod (`packages/shared/src/config.ts`):

- `overlayTemplateSchema`: a **strict** object in `template.yaml`'s snake_case. Replaceable keys: `model`, `effort`, `warm_window_minutes`, `max_live_spawns`. Additive keys: `skills`, `plugins`, `can_spawn`, `secrets`. Each key reuses the field schema from `templateYamlSchema`. Any other key, including the template-only `name`, `display_name`, `description`, `runtime`, `image`, `permission_mode`, `projects` and `local_skills`, is an "Unknown field" error. `permission_mode` stays template-only so that a per-agent mode can't quietly loosen safety. `runtime` is fixed at creation (§6.6).
- `settings`: any JSON object (Claude Code's settings; unknown keys allowed).
- `mcp`: `{ mcpServers: Record<string, object> }`. A server named `factory` is an error.
- `agentOverlaySchema = z.object({ template?, settings?, mcp? })`, strict at the top level.
- The model schema (template and overlay) becomes: 1–100 characters of `[A-Za-z0-9._\[\]:-]`, not starting with `-` (it goes on a command line).

The overlay stores secret **names** only, never values.

`agents.config` becomes `jsonb … $type<AgentOverlay>().notNull().default({})`. Its **version** is `sha256(canonical JSON)` (sorted keys), derived and never stored.

### 5.2 Merge rules

One pure function in `packages/shared/src/config-merge.ts`, used by the server (generated files, change diffs, validation) and the web (inherited markers, the merged view). There is one source of truth.

```ts
type ConfigDoc = { template: Record<string, unknown>; settings: Record<string, unknown>; mcp: { mcpServers: Record<string, unknown> } };
mergeConfig(base: ConfigDoc, overlay: AgentOverlay): ConfigDoc
```

`base.template` is the template's `template.yaml` object as parsed (snake_case). The effective `TemplateConfig` is `templateYamlSchema.parse(merged.template)`.

The rules apply in this order:

1. **Recursive merge** of `template` and `settings`: objects merge key by key, scalars from the overlay replace, and **arrays union** (base first, then overlay items not already present; items compared by canonical JSON). This covers:
   - *Replace*: `model`, `effort`, `warm_window_minutes`, `max_live_spawns` (scalars).
   - *Add*: `skills`, `plugins`, `can_spawn`, `secrets`, `permissions.allow`, `permissions.deny`, `autoMode.environment`, `autoMode.soft_deny`/`hard_deny`, and any unknown array such as `hooks.PreToolUse`. An overlay can never drop a template hook, rule or trust note.
   - *Env vars*: `env` is an object, so a same-name entry replaces the template's value and new names add.
   - *Unknown keys*: deep-merged by the same rule.
2. **MCP servers**: `mcp.mcpServers` merges by name, and an overlay entry **replaces the whole entry** (a stdio server is never deep-merged into an HTTP one). Other top-level `mcp` keys follow rule 1.
3. **Factory-owned keys**: `permissions.defaultMode` and `enabledPlugins` are validation **errors** in templates and overlays alike (today a template warning; proxy Q3, certainty 3, flagged for Or). `claudeMdExcludes` is appended to (as today), and `"$defaults"` in `autoMode` lists is stripped (as today, `settings.ts`).

Removal: the overlay can only remove what it added. Deleting an entry from the overlay removes it. Template entries change only in the template.

Unit tests, one per rule, in `config-merge.test.ts`:

- replace for each scalar;
- union for each named list, with duplicates dropped and order kept;
- an unknown nested array unioned (a `hooks` entry kept);
- an env name replaced and an env name added;
- an MCP server replaced whole (stdio → http leaves no `command`) and an MCP server added;
- an overlay deny rule added and removed again (back to the template's list);
- unknown settings keys deep-merged;
- `{}` gives exactly the base;
- the merge is idempotent (`merge(merge(b,o),o) = merge(b,o)`).

### 5.3 Validation

`validateEffective(doc, ctx)` takes the semantic rules that `validateTemplate` runs today (host skills exist and don't clash with template-local skill names, the plugin's marketplace is declared in `extraKnownMarketplaces`, the marketplace source type, secrets defined (warning), `can_spawn` templates exist (warning), the reserved MCP name, factory-owned keys) and runs them on a merged document. Templates call it on their own files. An overlay save calls it on `mergeConfig(template, overlay)` and reports only the issues whose path lies in the overlay, or that the overlay caused. Issues carry `path` (`template.skills.2`, `mcp.mcpServers.github.env.TOKEN`), which the form maps to fields and the raw tab maps to lines.

Added rules:

- An MCP env value or header containing `${X}`, where `X` is neither in the effective `secrets` nor a key of the effective `settings.env`, is a warning: "X isn't a secret or env var of this agent."
- A template whose `runtime` differs from that of any of its live or archived agents gets the warning "Existing agents keep their runtime." (§6.6).

### 5.4 What the merged view shows

The merged document holds references, never values: `${GH_TOKEN}` stays literally `${GH_TOKEN}`. Secret names appear in `template.secrets`. The read-only merged view, change lists, events and logs show only these.

### 5.5 Secrets in env and MCP

- **Env from a secret** means the secret's name is in `template.secrets` (template or overlay, unioned). The env var has the secret's name (today's rule, `start.ts:199`).
- **Plain env vars** are `settings.env` (written to `settings.json`, visible as text; never for secrets).
- **MCP env and headers** reference a secret as `${NAME}`, and the form adds `NAME` to `template.secrets` in the same edit. The generated `.mcp.json` keeps the reference, and Claude expands it from the process env, which already holds the secret (verified in S6 for `OPEN_FACTORY_AGENT_TOKEN`).
- **Deviation**: the task spec's acceptance says "with its secret resolved". We resolve it at process start through the env, not by writing the value into `.mcp.json`, so no secret value lands on disk or in the UI (proxy Q5 requirement).

## 6. Effective config at runtime

### 6.1 Resolver

`ConfigResolver` (`apps/server/src/agents/config-resolver.ts`):

```ts
effective(agent: AgentRow): Promise<Effective>
// Effective = { doc: ConfigDoc /* merged */, config: TemplateConfig /* parsed merged.template */ }
```

- It reads the template through `TemplateIndex.loadValid(agent.template)`, a disk read that also runs change detection (§7.1), and merges `agent.config`. A spawned agent's overlay is always `{}`.
- Errors: template missing → `AgentStartError("Template dev no longer exists.")`; template invalid → `AgentStartError("Template dev has errors. Fix it in Templates.", "template")` (new fix code `template`, whose link opens `/templates/<name>`); an invalid overlay → `"The configuration of @ana is invalid. Fix it in Configuration."` with fix `config` (link to `/agents/<slug>/config`). The `config.runtime` used is the agent row's `runtime` (§6.6).

`loadValid` returns, besides `config`, `tplSettings` and `tplMcp`, the parsed `template.yaml` object (`tplYaml`), which `mergeConfig` needs.

### 6.2 Who reads what

The runtime keeps the `Effective` its current process was started with (`PreparedSpec.effective`, stored on the runtime at each start). Config applies at the next start, so everything about the **running process** reads that copy:

- `maySpawn` and the MCP tool list (`app.ts:535`), `spawn_agent`'s `can_spawn` and `max_live_spawns` checks (`spawn-service.ts`), the warm window (`agent-runtime.ts:3316`), and the Docker image (`runtimes.ts:169`). A call from an agent with no running process can't happen for the tools. `spawn-service` falls back to the resolver for safety.
- `start.ts` (`createPrepareStart`), `deriveInheritance` (spawner side: `resolver.effective(spawner)`, replacing the spawner template-copy read; child side: its own effective), `syncChildren` (child template `projects` via the template index), the commands route (`routes/agents.ts:103,339`) and the Configuration API read the resolver.

`templateConfigSchema.safeParse(agent.config)` (`start.ts:152`) is deleted.

### 6.3 Start (`Workspace.prepare`)

`PrepareInput` gains `effective: Effective` and loses `config`. `prepare`:

1. ensures plugins (§6.5);
2. links host skills and template-local skills (§6.4) and projects;
3. writes `settings.json` from `buildSettings({ tpl: effective.doc.settings, … })`; the inherited deny rules for a spawned agent are unchanged;
4. writes `.mcp.json` from `buildMcpJson(effective.doc.mcp, …)`;
5. writes `CLAUDE.md` with `secretNames` from the effective (or inherited) secrets;
6. builds mounts with `declaredMarketplaceDirs(effective.doc.settings)`, so overlay directory marketplaces go through the same per-start allow-check (§6.4).

`applyPending`, `readTemplateJson` and `readTemplateSettings` are deleted. Every input comes from the factory: the template folder (operator input) and the overlay in the database, never the agent's workdir.

### 6.4 Template-local skills linked live

`.claude/skills/<name>` becomes a factory-made link to `<templates>/<template>/skills/<name>` for every folder in the template's `skills/` when `local_skills` is true. Host skills and template skills share `syncLinks`; the "drop unlisted links" pass covers both prefixes. Docker mounts each template skill folder read-only at its real path (like host skill dirs, so a link resolves the same inside the container). The mount allow-check gains one allowed class: the real path of `<FACTORY_HOME>/templates/<agent's template>/skills/<name>`, read-only. Everything else under `FACTORY_HOME` stays refused. A non-link entry with a template skill's name fails the start with "…isn't a link to the template skill; move it away." (this is what an agent created before I2 hits; §15).

Skills an agent writes itself (real folders with other names) are untouched.

### 6.5 Plugins: install at start what is listed and missing

Changes workspace.md's "only at create and re-sync, never at start" (proxy Q8, certainty 3, flagged for Or). The principle stays: a human listing a plugin (template or overlay) is the explicit act, and an installed plugin is never updated without a new listing.

- `prepare` reads `plugins-config/settings.json` `enabledPlugins`. For every effective plugin not in it, it runs today's `installPlugins` through the same hardened path: the factory-owned `plugins-config/`, an empty temp cwd, the env allowlist (`PATH`, host `HOME`, `CLAUDE_CONFIG_DIR`), never the agent-writable config dir or cwd. Marketplace sources come only from the effective settings' `extraKnownMarketplaces` (template + overlay), never from the workdir.
- A failed install fails the start closed: `AgentStartError("Plugin x@y didn't install: <first line>", "config")`, with the redacted output in the event. There is no partial start.
- `materialize` (create) calls the same function. The "Re-sync to reinstall" error goes.
- Spawned agents install at their first start (slow, #56; I5's shared store fixes it).

### 6.6 Runtime fixed at creation

`agents.runtime` keeps the runtime chosen at creation, and a template `runtime` change applies to new agents only (§5.3 warning). `image` and `permission_mode` follow the live template. Switching runtime would move the session, so the same session couldn't resume. Recreate the agent instead. The effective config's `runtime` is overwritten with the row's before use, so the local gate, mounts and container code see one value.

## 7. Live templates and change flow

### 7.1 Detecting a template change

The `templates` index row gains `yaml jsonb`, `settings jsonb` and `mcp jsonb` (the parsed files, null when invalid). In `TemplateIndex.index(name)`, the old row is read before the upsert. When `content_hash` differs and both the old and the new row are valid, `onChange({ name, before: ConfigDoc, after: ConfigDoc, by })` fires after the upsert commits. `by` is the human's `@handle` for a write through the API, otherwise `"file change"`. Reads that scan are: list, open, file save, config save, `loadValid` (create, spawn, every start) and boot.

When a template goes from valid to invalid or missing, no change event fires and running agents keep running. Their next start fails closed (§6.1). The editor shows "N agents can't start until this is fixed." while errors exist (§12.5).

### 7.2 Applying a change

`ConfigChanges` (`apps/server/src/agents/config-changes.ts`) is the one path for template changes and overlay saves:

- **Template change**: for each agent with `template = name` that is neither archived nor terminated (persistent and spawned), it computes `describeChanges(merge(before, overlay), merge(after, overlay))`. If the list is non-empty, it calls `apply(agent, by, changes)`. An empty diff (an `AGENTS.md` or `files/` edit) does nothing.
- **Overlay save**: `apply(agent, "@handle", describeChanges(merge(tpl, old), merge(tpl, new)))`, then restarts the agent's live spawned children whose inherited secrets or deny rules changed (S7 §6.3).
- `apply` writes the `config_changed` event, then calls `runtimes.requestRestart(id, changes)`.

`describeChanges(a, b): string[]` lives in shared, next to the merge, and follows a secret-safe rule (proxy Q10):

- values are shown only for `model` and `effort` ("model: sonnet → opus"), numbers ("warm window: 70 → 30 min") and names: "added skill release", "removed skill tdd", "added plugin x@y", "added allow rule `Bash(git push:*)`", "added deny rule …", "added trust note", "added secret GH_TOKEN", "can spawn: added reviewer";
- env vars, MCP servers, headers and unknown keys show only their name and kind: "env LOG_LEVEL changed", "MCP server github added", "MCP server github changed", "settings key hooks changed";
- lists are sorted and deterministic, with one line per change.

### 7.3 Restart, event and notice

- `requestRestart(id, changes?)` (runtime `requestRestart(changes?)`): with a running process, it appends `changes` to `pendingChanges` (deduplicated) and marks the restart pending as today. Without one, it adds the notice now (below). Other callers (credential, grants, manager) pass none, as today.
- **Event** `config_changed { by: string; changes: string[] }` in `sessionEventSchema`. The Session timeline renders it as a system row: "Configuration changed by @orlevi: model sonnet → opus; added skill release." (`by` "template dev" or "file change in template dev" for template changes). Archived agents get no event.
- **Notice** `config_changed` (`notices.configChanged({ changes })`): "Your configuration changed: model sonnet → opus; added skill release." It is a passive `@factory` notice: it never wakes the agent and arrives with its next batch. For a running agent it is added on the `apply_changes` exit together with the existing `restart_crons` notice, then `pendingChanges` clears. For a stopped agent it is added at once. I7 reuses it.
- **Live state**: `restartChanges: string[]` beside `restartPending`. The UI's line becomes "Restarts when idle to apply: model, 1 skill" (a short summary: kinds with counts, from the lines).

### 7.4 Deleting a template

`TemplateIndex.remove` refuses with 409 `template_in_use` while any non-terminated agent (archived included) has `template = name`: "@ana and 2 more (1 archived) use this template. Archive and recreate them first." `spawn_agent` from a missing or broken template is refused with the §6.1 message.

## 8. Removals (PR 1)

- Server: `AgentService.resync`, `templateProjects`, `containerRunning` (if it has no other caller), `Workspace.resync`, `applyPending`, `readTemplateSettings`, `readTemplateJson`, `writeTemplateCopy`, `copyTargets`' template copy, `stageTargets`, `pendingTargets`, `templateCopyDir`, `resyncPendingDir`, `resyncRoot`; the `resync` route, schema and WS message; fix code `resync`; `grants_overridden` (column, summary field, `PATCH projects: null`). `state-migration.ts` drops its `template`/`resync` moves (they existed only for snapshots).
- Web: AgentMenu "Re-sync from template…", `lifecycle.resyncAgent` and its toasts, `ResyncFix`, the "From the template / Custom" marker in `ProjectGrantPicker`, `api.resyncAgent`, plus their tests.
- Docs (§16) drop Re-sync everywhere.

## 9. Reset persona

`POST /api/agents/:slug/reset-persona` (persistent agents only; archived allowed):

1. Under the workspace lock, it reads the template's `AGENTS.md` (409 `template_missing` or `template_invalid` as in §6.1).
2. If no process is running (Docker: the container isn't running either; the `containerRunning` check moves here), it backs up the current `AGENTS.md` to `state/agents/<slug>/persona/<UTC stamp>/AGENTS.md` and writes the new one through `SafeFs` (symlink-safe; the old `applyTargets` helper, narrowed to one file). Response `{ applied: "now", backupDir }`.
3. Otherwise it stages the file at `state/agents/<slug>/persona-pending/AGENTS.md` (factory state). `prepare` applies it first (backup + SafeFs write) and then removes it, and `requestRestart(id, ["persona reset from template"])` runs. Response `{ applied: "on_restart" }`.

UI: AgentMenu item "Reset persona…" (non-spawned, live or archived) opens a `ConfirmDialog`: title "Reset persona?", body "Replace @ana's AGENTS.md with the template's. The current file is saved in state/agents/ana/persona/." Action "Reset persona" (crimson). The outcome toasts (the menu is gone): "Persona reset. Previous file saved." or "Persona resets when @ana restarts."

## 10. Model and effort

- `packages/shared/src/models.ts`: `MODEL_CHOICES = [{ value: "fable" }, { value: "opus" }, { value: "sonnet" }, { value: "haiku" }, { value: "claude-fable-5-1" }, { value: "claude-opus-5-5" }, { value: "claude-sonnet-5-5" }, { value: "claude-haiku-5-5" }]`. The aliases `fable`, `opus` and `sonnet` are named by `claude --help` (2.1.327, `--model`); `haiku` is a documented alias. The list is maintained by hand. Efforts are today's `EFFORTS` (`low, medium, high, xhigh, max`), which match `claude --help`'s `--effort` values.
- The runtime already passes `--model`/`--effort` from the config (`runtime-spec.ts:72`); it now reads the effective config. Spawned agents use their template's (they have no overlay).
- The picker (§12.3) is part of the Configuration form (PR 3). Before PR 3, the overlay can be set through the API.

## 11. Identity colour

- **Palette**: `--avatar-1` … `--avatar-12`, OKLCH chroma 0.07, L 0.62 light / 0.70 dark, at hues 110, 125, 175, 190, 205, 220, 270, 285, 300, 315, 330, 345 (in this order; index 1 = 110). The warm band 0–100 stays excluded, and every hue stays ≥ 15° from success (150) and info (250). The order is fixed in one shared constant `AVATAR_HUES` (`packages/shared/src/avatar.ts`, with names for accessibility: Olive, Moss, Jade, Teal, Cyan, Sky, Iris, Violet, Purple, Orchid, Mauve, Rose), because stored values depend on it. CSS tokens are written from it by hand and a test compares the two. If two neighbours prove too close at 16px in the evidence pass, the fix is two lightness tiers (alternating L ± 0.06), never wider hue range.
- **Seeding**: `botParts(slug).fill = take(12) + 1`. Auto colours of existing agents change once (accepted).
- **Storage**: `agents.color smallint null` with a CHECK of 1–12. Null means Auto. It is identity, not overlay. `PATCH /api/agents/:slug { color: number | null }`. Spawned agents can't be edited, so they stay Auto. Changing the colour never restarts an agent.
- **Payloads**: every agent-shaped payload that carries `avatarVersion` also carries `color: number | null`: `AgentSummary`, I1's `ChatRow.agent`, mention and people sources, and peer lists used by chips. `AgentAvatar` takes `color` and fills with `var(--avatar-${color ?? seeded})`. The plan lists every call site (7 `<AgentAvatar` uses today plus I1's).
- **Where colour shows**: only inside the avatar (DESIGN.md's rule stays). "Identity accents (speaker lines, chips)" in the task spec is read as the avatar in those places (proxy Q15, certainty 3, flagged for Or).

## 12. Configuration form and raw editor

### 12.1 APIs

- `GET /api/agents/:slug/config` → `{ overlay, version, template: { name, doc: ConfigDoc, valid: boolean }, merged: ConfigDoc | null, issues: TemplateIssue[] }`. Values in `merged` are references only (§5.4).
- `PUT /api/agents/:slug/config { overlay, baseVersion }`:
  - It parses `agentOverlaySchema`; Zod issues become `issues` with paths.
  - 409 `config_changed` "Changed since you opened it. Reload." when `baseVersion` differs.
  - It runs `validateEffective`. Any error → 400 with `issues` (nothing written).
  - On success it writes and runs §7.2, then returns the GET shape plus `changes: string[]` and `restart: boolean`.
  - Persistent agents only (409 `ephemeral_agent`). Archived agents are allowed.
- `GET /api/templates/:name/config` → `{ doc: ConfigDoc, hashes: Record<"template.yaml" | "settings.json" | "mcp.json", string | null>, issues }`.
- `PUT /api/templates/:name/config { doc, baseHashes }`:
  - Validate everything, then write. All three base hashes are checked (409 `changed_on_disk`, today's copy).
  - `template.yaml` is rewritten through the `yaml` Document API: only the configuration keys the form owns are set or deleted, so comments, key order and template-only keys survive. `settings.json` and `mcp.json` are written as `JSON.stringify(doc, null, 2)`.
  - The whole document is validated as it would be written. Errors → 400 with `issues`, nothing written. Then the files are written (temp + rename each) and the template is rescanned once (§7.1 fires once).
- `GET /api/host-skills` → `{ dir, skills: [{ name, description }] }` (description from `SKILL.md` frontmatter, at most 200 characters), read live. It is the skills picker's source until I5's Library replaces it.

### 12.2 One form for both

`features/config/` (new): `ConfigForm` takes `mode: "template" | "agent"`, `value: ConfigDoc` (template) or `AgentOverlay` (agent), `base?: ConfigDoc` (agent mode: the template's doc), and `onChange`. It is controlled; its draft lives in the page (`useConfigDraft`), shared with the Raw JSON tab. Agent mode shows the merged values: each list shows template rows first, marked "From template" (muted, no remove), then this agent's rows, marked "This agent" (with remove). A scalar field shows its inherit choice (§12.3).

Sections, in order, each an `h2` with the form rules of I4 (`field-stack`, `FieldShell` notes):

1. **Model**: Model and Effort (§12.3).
2. **Skills and plugins**:
   - *Skills*: a combobox of host skills (`/api/host-skills`, name + one-line description). Template-local skills are listed read-only ("Template skill").
   - *Plugins*: a text input taking `name@marketplace`, with the help "Like formatter@acme. Declare the marketplace in Raw JSON." I5 replaces both pickers.
3. **MCP servers**:
   - Rows show the name, the kind ("Command" / "URL") and a one-line summary (command + args, or the URL host), plus Edit and Remove.
   - Edit or "Add server" expands an inline editor under the row (no nested sheet over a dirty page) with:
     - Name;
     - Kind as a two-option segmented control;
     - Command: command, args (one per line) and env rows;
     - URL: URL and header rows.
   - Env and header rows are name + value. Each value field has an "Insert secret" ghost button that opens a popover listing factory secrets (with "Add secret", the U4 stacked sheet). It inserts `${NAME}` at the caret and adds `NAME` to `template.secrets`.
   - An inherited server is read-only with "Override", which copies it into the overlay for editing (same name replaces whole).
4. **Permissions**: Allow rules, Deny rules and Trust notes (`autoMode.environment`) as editable lists. The help gives examples: "Like Bash(git push:*)." for rules, and "Facts that help auto mode decide, like 'deploys go through CI'." for notes. In agent mode, template deny rules are read-only ("From template").
5. **Environment**: plain variables (`settings.env`, name + value) and "From secrets" (a list of secret names, picked from the factory's secrets, with "Add secret"). Each secret row says "Available as $GH_TOKEN".
6. **Behavior**: Warm window (minutes), Spawnable templates (a multi-select of template names), Max live spawns.

Lists use one `ConfigList` component:

- rows are 36px (44px on touch), mono values that wrap with `overflow-wrap:anywhere` and are never truncated;
- an add row has an input and a ghost Add button, and Enter adds;
- a duplicate is a field note: "Already in the list.";
- remove is an icon button with `aria-label` "Remove <value>";
- a list longer than 8 rows shows the first 8 and "Show all N" (in place, no scroll region inside the page).

### 12.3 Scalars and inherit

- **Model**: a `Select` whose first item is "Inherit from template (sonnet)" (agent; "Claude Code default" when the template sets none) or "Claude Code default" (template). Then a group "Aliases" (fable, opus, sonnet, haiku), a group "Model ids" (the four ids) and "Custom…". Custom reveals a mono `Input` under the Select, checked by the shared model schema (note: "Use letters, digits and . _ : - [ ]").
- **Effort**: a Select with Inherit/default, then low, medium, high, xhigh, max.
- **Numbers**: an `Input` whose help shows the inherited value ("From template: 70 minutes"). Empty means inherit. "This agent" appears in the label row while the field is set.

### 12.4 Agent Configuration page

Route `/agents/$slug_/config` (beside `usage`), lazy-loaded with the CodeMirror chunk.

- **Header**: the agent avatar, "Configuration" and "@ana · Template dev" (link to the template).
- **Tabs**: **Form** | **Raw JSON**.
  - Raw JSON holds the overlay in the CodeMirror editor (JSON language, the template editor's wrapper `code-editor.tsx`, U4 §12), with issue markers from the server `issues` and client parse errors.
  - A segmented "Overlay | Merged" control above the editor switches to the read-only merged view (references only).
  - Leaving Raw with invalid JSON is blocked: the tab switch is refused and the parse error stays in the editor's note line ("Fix the JSON to switch tabs.").
  - Valid JSON that fails the schema switches fine; the issues show on the form's fields.
- **Footer**: a sticky footer at the bottom of the page column with I4's `FormOutcome` line, "Save changes" (primary) and "Discard" (ghost).
  - While dirty and the agent has a running process, the notice reads "Saving restarts @ana when idle to apply: model, 1 skill." (from a client-side `describeChanges`).
  - Discard resets both tabs to the loaded version without confirmation.
  - Leaving the page while dirty uses the template editor's `useBlocker` confirm.
- **After save**: "Saved." in the line. A 409 shows "Changed since you opened it. Reload." with a Reload action. Server issues land on their fields (form) or as markers (raw).
- **States**:
  - a spawned agent: "Spawned agents use their template's configuration." with a link to the template and a read-only merged view;
  - an unknown slug: "There is no agent @x.";
  - a template with errors: the page loads, the form shows inherited values from the last valid index row if any, and the outcome line notes "Template dev has errors; @ana can't start." with an "Open template" action.
- **Layout**: one column, max-width 44rem, sections 32px apart. At 390px the footer buttons stack under the line. At 200% text the inline MCP editor's fields stack and nothing scrolls horizontally.
- **Entry points**: AgentMenu "Configure" (between Edit and Usage), the Edit agent summary line, and the Agent details panel row "Configuration".

### 12.5 Template Configuration tab

`template-editor.tsx` gains a **Configuration** tab before the file tabs. It is selected by default when the template is valid, else `template.yaml`. It hosts `ConfigForm mode="template"` with the same sticky footer. The file tabs stay the raw editors.

- Saving the form calls `PUT /api/templates/:name/config`. Clean file tabs reload their content and hashes. A dirty file tab keeps its draft and meets today's 409 flow on its own save.
- The header shows "Used by N agents. Saving restarts the ones whose configuration changes, when idle." While the template has errors: "N agents can't start until this is fixed."

### 12.6 Edit agent sheet

- **Colour**: a `FieldShell legend` "Colour" with a radiogroup of 13 swatches: Auto, then the 12 hues. Each swatch is the agent's avatar at 24px in that fill, inside a 44px hit area. The selected one has a 2px ring in `--ring`. The names come from `AVATAR_HUES` (Auto's is "Auto (Jade)"). The swatches wrap (2 rows at 390px). Arrow keys move the selection (roving tabindex).
- **Model summary**: a read-only row under Description: "Model opus (this agent) · Configure" or "Model sonnet (from template) · Configure". "Configure" is a link to the page, which closes the sheet (the draft is kept).
- The projects marker is removed. A colour change alone is not in the restart notice.

## 13. Data model changes

Generated Drizzle migrations only (no data conversion; ADR 0028):

- `agents.config`: type `AgentOverlay`, default `'{}'::jsonb`;
- `agents.color smallint null` with a CHECK of 1–12;
- `agents.grants_overridden` dropped;
- `templates.yaml`, `templates.settings` and `templates.mcp`: jsonb, nullable.

**Reset step** (stated in each PR and the plan): drop the database and recreate agents. Agents created before I2 hold a snapshot in `config`, which fails the overlay schema ("The configuration of @x is invalid…"), and copied template skills collide with the new links. Old `state/agents/<slug>/{template,resync,resync-pending}/` folders are left alone, never read and never deleted.

## 14. DESIGN.md amendments

1. **Agent identity**: "twelve muted identity hues (`--avatar-1` … `--avatar-12`, chroma 0.07: hues 110, 125, 175, 190, 205, 220, 270, 285, 300, 315, 330, 345)", same exclusions. Add: "A human may pick an agent's hue (Edit agent → Colour); Auto is the slug's seeded hue. Spawned agents are always Auto." The colour tokens list grows to 12 + 12 night.
2. **Components**: a "Colour swatches" entry (avatar-faced swatches, ring for selection, 44px targets, radiogroup).
3. **Components**: "Configuration lists" (from-template rows muted and read-only; this-agent rows removable; Show all past 8).

## 15. Product docs to update (PR 1, plus PR 3 for the form)

Docs live in the main checkout's gitignored `docs/product/`. The dev updates them in the main checkout as the last task of PR 1 and PR 3 and lists them in the PR body:

- Agent template: Instantiation, no snapshot, live, Reset persona, overlay;
- Agent: no snapshot, model/effort/colour;
- Workspace: layout without `template/`, `resync*`; skills linked; plugins at start; mounts;
- Context assembly: AGENTS.md copied once;
- Data model: `agents.config` overlay, `color`, no `grants_overridden`, `templates` columns;
- Administration: Configuration page, Reset persona, no Re-sync;
- Agent runtime: requestRestart with changes, `config_changed` notice;
- ADR 0017 note.

## 16. Testing and evidence

- **Unit (shared)**: `config-merge.test.ts` (§5.2, one test per rule), `describeChanges` (each kind, no values for env/MCP/unknown keys, deterministic order), the overlay schema (each allowed key, each template-only key refused, model charset), `AVATAR_HUES` length, order and distance from 150/250.
- **Server**:
  - `prepare` writes merged files (template + overlay) for each rule;
  - template-local skill links and the docker mount allow-check;
  - plugin ensure-install installs only the missing plugin and fails closed on install failure;
  - the index fires `onChange` once per hash change, never on invalid↔valid, never for `AGENTS.md`/`files/`-only edits (empty diff → no restart);
  - overlay PUT: 409 on stale version, 400 with paths, restart and event on change;
  - template config PUT: three hashes, YAML comments kept, validate-all-then-write (an invalid `mcp.json` leaves `template.yaml` untouched);
  - delete refusal with archived agents;
  - Reset persona now and on restart (backup, symlink refusal);
  - spawned inheritance from the spawner's effective deny and secrets;
  - `config_changed` notice is passive and lists changes;
  - no secret value in events, notices or the merged view.
  - DB tests run in CI only (the local Postgres role is unavailable).
- **Web**:
  - `ConfigForm` (inherited rows read-only, add/remove, Override, Insert secret adds the secret, Raw tab blocking on invalid JSON, unknown key survives a form save);
  - the Configuration page states;
  - Edit agent swatches (radiogroup keys, `color` in PATCH);
  - `AgentAvatar` colour precedence;
  - AgentMenu without Re-sync and with Configure and Reset persona.
- **Evidence pass** (real browser, Chromium and WebKit headless, fake Claude only, the U4 harness through its `run.sh` lock, one heavy job at a time on `/tmp/of-v002-heavy.lock`):
  - the 12 hues at 16px and 24px in both themes beside the success and info marks;
  - the Configuration page and the template tab at 1440, 1024 and 390px and at 200% text (a full matrix on these two layout-sensitive views only), with long lists (40 allow rules, 10 MCP servers with long URLs);
  - the Edit agent swatches at 390px;
  - the acceptance flows 2, 4, 9, 10 and 11 end to end.

## 17. Delivery

Three stacked PRs on I1's last branch, linear (`i2/1-overlay` → `i2/2-colour` → `i2/3-config-form`), each linking this spec, the plan and the decision issue. Every intermediate state is a valid product: after PR 1 every overlay is `{}` (settable through the API) and agents run on the live template.

1. **`i2/1-overlay`**: §5–§9, §13 (all but `color`), §15 core docs, the Re-sync UI removal, Reset persona UI, the `config_changed` timeline row.
2. **`i2/2-colour`**: §11, §12.6 Colour, the `color` column, DESIGN.md amendment 1–2.
3. **`i2/3-config-form`**: §10 picker, §12 (APIs, form, page, template tab, model summary line), DESIGN.md amendment 3, the form docs.

## 18. Decisions

The rationale and alternatives for each are in the decision issue. Certainty is on a 1–5 scale.

| # | Decision | Certainty |
|---|---|---|
| Q1 | Overlay is file-shaped `{template, settings, mcp}` | 4 |
| Q2 | Overridable keys: replace model/effort/warm window/max spawns; add skills/plugins/can_spawn/secrets; the rest template-only, unknown keys errors | 4 |
| Q3 | Recursive merge with array union everywhere; MCP servers replaced whole; env replace falls out of the object merge | 4 |
| Q3b | `defaultMode` and `enabledPlugins` become errors in templates and overlays | **3** (flag for Or) |
| Q4 | Grants are agent identity, `grants_overridden` dropped | 4 |
| Q5 | Secrets in the overlay as names (union); values never in files, UI or logs | 4 |
| Q6 | Runtime fixed at creation; image and permission mode live | 4 |
| Q7 | Broken or deleted template fails closed; delete refused while any agent (archived too) uses it | 4 |
| Q8 | Install listed-but-missing plugins at start, hardened path, fail closed | **3** (flag for Or: changes a supply-chain rule) |
| Q9 | Hash-on-read detection; restart only on a non-empty merged diff; spawned agents live too | 4 |
| Q10 | Change list in event, UI line and passive agent notice; secret-safe | 4 |
| Q11 | Reset persona: AGENTS.md only, backup, confirm dialog | 4 |
| Q12 | Stale state untouched; reset step instead | 4 |
| Q13 | Agent Configuration is a page; Edit agent gets colour + a model summary link | 4 |
| Q14 | Template Configuration tab first; one validated three-file save | 4 |
| Q15 | 12 hues, Auto seeded mod 12, `agents.color`, colour only inside avatars | 4; the accent reading **3** (flag for Or) |
| Q16 | Static model list incl. `fable` alias (verified in `claude --help`), Custom with a safe charset | 4 |
| Q17 | One form, sticky footer, derived version + 409, shared draft, invalid JSON blocks leaving Raw | 4 |
| Q18 | Three stacked PRs | 4 |
| T1 | (tech-lead) The running process's config is the copy it started with; MCP tools, spawn limits, warm window and image read that copy | 4 |
| T2 | (tech-lead) MCP secret references stay `${NAME}` in `.mcp.json` (deviation from "resolved") | 4 |
| T3 | (tech-lead) MCP servers edit inline on the page, not in a nested sheet | 3 |

## 19. Follow-ups (separate issues)

- I5 replaces the skills and plugins inputs with Library pickers, and the per-agent plugin installs with the shared store.
- A form for template-only fields (runtime, image, permission mode, projects).
- Template `files/` reset per agent, if wanted.
