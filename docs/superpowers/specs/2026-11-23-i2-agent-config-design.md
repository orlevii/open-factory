# I2 Agent config: Technical Design

Task spec: `docs/product/roadmap/v0.0.2/i2-agent-config.md` (gitignored; main checkout). Decision: ADR 0023. Pre-release rules: ADR 0028 (no compatibility code, no data migration). Builds on I4 (form rules), I1 (Chat and Session, notices) and U4 (sheets, CodeMirror editor). Consumers: I5 (Library pickers in the form) and I7 (`manage_org` tools edit the overlay; restart notices).

Decision log: the GitHub issue "I2: Agent config — design". One comment lists every question, the alternatives, the proxy's answer and its certainty. Reviews: self-review, Taste, Apple design, Emil design-eng, Break UI (§18).

## 1. Goal

Configure one agent without forking its template. Configure templates and agents without hand-writing JSON.

- `agents.config` becomes the agent's **overlay**: only its differences from its template, kept as one JSON document. At every start the factory merges the **current** template with the overlay. Template snapshots and Re-sync are deleted.
- Each agent can override its model and effort, and can have an identity colour.
- One Configuration form, plus a Raw JSON tab, serves templates (the baseline) and agents (the overlay, with inherited values marked).

### 1.1 Deviations from the task spec

- **Model picker.** The task spec puts it in Edit agent. Here Edit agent shows a summary line, "Model opus (this agent) · Open configuration", and the picker lives on the Configuration page, so model has one editing surface (Q13).
- **Reset persona** lives in AgentMenu, with a confirm dialog, not inside the Edit agent form (Q11).
- **MCP secrets.** The task spec says an MCP secret "appears … with its secret resolved". Here it is resolved through the process env at start: `.mcp.json` keeps `${NAME}`, and no secret value is ever written to disk or shown (Q5, T2).
- **`extraKnownMarketplaces`** is template-only. An overlay can add plugins only from marketplaces the template declares (S2).

## 2. Acceptance criteria

Each criterion names the PR that makes it true (§17).

1. (PR 1) A fresh agent has `config = {}` and runs on its template as written. Its generated `settings.json`, `.mcp.json` and `.claude/skills/` come from the current template merged with its overlay, rebuilt at every start.
2. (PR 1) Adding a host skill to a template (by form, raw tab, or an edit on disk noticed on the next read) marks every running agent of that template "Restarts when idle to apply changes", with no Re-sync. The agent restarts and resumes the same session; on its next wake (a message), it has the skill. An agent's own added skill survives the template change. Editing a template's `AGENTS.md` or `files/` restarts nobody.
3. (PR 1) Each effective change writes a `config_changed` event to the agent's Session and leaves the agent one passive `@factory` notice listing the changes. This holds whether the agent was running, hibernated or not loaded, and whatever ended the old process. Neither the event nor the notice ever prints an env value, a header value, an MCP argument or a secret value.
4. (PR 1) A human can remove a deny rule that was added to an agent by editing the overlay. A template deny rule can't be removed per agent: the merge unions arrays, and the form shows it read-only.
5. (PR 1) A template with errors, or a deleted template, makes its agents' next start fail closed, with a message naming the fix. A template can't be deleted while any live or archived agent uses it.
6. (PR 1) Rotating or deleting a secret still restarts every agent whose **effective** secrets include it, plus their live spawned children.
7. (PR 1) Reset persona (in AgentMenu, with a confirm dialog) replaces the agent's `AGENTS.md` with the template's, after backing up the old file to `state/agents/<slug>/persona/<UTC>/AGENTS.md`.
8. (PR 1) Template Re-sync, the template copy in `state/agents/<slug>/template/`, `grants_overridden` and the "From the template / Custom" marker are gone from code, API and UI.
9. (PR 2) The avatar palette has 12 identity colours. No two of them are closer (ΔE_ok) than today's closest pair (0.030), in either theme. Edit agent shows Auto plus 12 swatches. Picking one recolours the agent's generated avatar everywhere (sidebar, lists, chips, speaker lines, palette, inbox) in both themes, and never restarts the agent. Spawned agents are always Auto. An agent whose template ships `avatar.svg` is offered no colour.
10. (PR 3) Switching one agent to Opus on its Configuration page leaves its template and its siblings unchanged. The agent restarts when idle and resumes the same session, and the `system/init` of its next process shows the new model.
11. (PR 3) An MCP server added in the form (stdio or HTTP), whose env or header references a factory secret, appears in the generated `.mcp.json` with `${NAME}`. Claude expands it from the process env, which holds the secret. The raw tab shows the same entry, and no secret value is written to disk or shown in the UI.
12. (PR 3) An unknown `settings.json` key added in the Raw JSON tab survives a form save, for both templates and agents.
13. (PR 3) Every form follows I4: a reserved note line, `useFieldErrors`, `FormOutcome`, and client messages of at most 40 characters. Every form works at 390px and at 200% text.

## 3. Scope

In: everything in the task spec's Scope and Tasks 1–6.

Out:
- agent self-editing and agent callers of the overlay (I7);
- agents removing template items;
- config history and undo (activity events only);
- per-agent avatar images;
- the Library (I5). Until it lands, skills come from the host list and plugins are typed as `name@marketplace`;
- a form for `runtime`, `image`, `permission_mode`, `projects` and `local_skills`. These stay in the `template.yaml` tab.

## 4. Inventory: today → after I2

| Area | Today (code) | After I2 |
|---|---|---|
| `agents.config` | Full `TemplateConfig` snapshot written at create and at Re-sync (`agent-service.ts:506,672`; `db/schema/agents.ts`) | `AgentOverlay` (§5.1), default `{}`. Never holds template values |
| Template copy | `state/agents/<slug>/template/{settings,mcp}.json`. Written by `copyTargets`/`writeTemplateCopy` (`workspace/files.ts`); read by `prepare`, `readTemplateSettings`, `deriveInheritance` and `spawn-service.ts:~156` | Deleted. Readers use the effective config (§6.1) |
| Template Re-sync | `AgentService.resync`, `Workspace.resync/applyTargets/applyPending`, `resync-pending/`, `POST /api/agents/:slug/resync`, `resyncResponseSchema`, AgentMenu item, `lifecycle.resyncAgent`, timeline `ResyncFix`, fix code `"resync"` (`safe-fs.ts:22`, `agents/errors.ts:8`), copy in `factory-section.tsx:49`, `template-editor.tsx:648`, `show-output.tsx` | Deleted. `applyTargets` survives only as the one-file backup+write helper for Reset persona (§9). The WS `resync` frame (`ws/route.ts:121`) is session-replay overflow, not this, and stays |
| Boot state migration | `state-migration.ts`: moves old `.factory/{template,resync}` (S4 compatibility) | Deleted with its boot call (ADR 0028) |
| Plugins dir move-aside | `linkPlugins` moves a real `plugins/` folder to `plugins-legacy-<ts>` (S4 compatibility) | Deleted. A non-link `plugins` entry fails the start ("…isn't a link; move it away.") |
| Template-local skills | Copied into `.claude/skills/` at create and Re-sync (`templateTargets`) | Linked live, like host skills (§6.4) |
| `AGENTS.md`, `files/` | Copied at create and again at Re-sync | Copied once at create. Reset persona covers `AGENTS.md` (§9) |
| Plugins | Installed per agent at create and Re-sync. A start with a missing plugin fails with "Re-sync…" (`workspace.ts:295`) | Installed at create/spawn, and a start installs any listed plugin that is missing (§6.5) |
| Grants | `agent_project_grants` + `grants_overridden`, which follow the template on Re-sync. `PATCH projects: null` resets to the template | Agent identity: initialised from the template's `projects` at create, then never follow it. `grants_overridden` and `projects: null` dropped |
| Secret users | `secret-service.ts:40` `usedBy()`: SQL `agents.config->'secrets' ? name`. Drives restart-on-rotate (:92), restart-on-delete (:98) and the Secrets page's "used by" | Computed from **effective** secrets (§6.7) |
| Config readers | `row.config.*` in `may-spawn.ts`, `app.ts:535`, `spawn-service.ts:65,127,169,172,252`, `runtimes.ts:169`, `agent-runtime.ts:3316,3344`, `routes/agents.ts:103,339`, `agent-service.ts:352`, `start.ts:76,152` | Effective config from §6.2 |
| Spawn inheritance | The spawner's deny rules come from its template copy (`start.ts:83`); secrets from `spawner.config.secrets` | The stricter of the spawner's started and current effective config (§6.2). The rules themselves are unchanged (S7 §6) |
| Change detection | `templates.content_hash` updated on every scan (`template-index.ts:152`) and never used | A changed hash triggers the config-change flow (§7) |
| Restart | `requestRestart(id)`. A notice only when crons were lost (`notices.restartCrons`, not passive) | `requestRestart(id, changes?)` and a passive `config_changed` notice that survives every exit (§7.3) |
| Avatar colour | `botParts(slug).fill` ∈ 1–8 (`lib/factory-bot.ts`), `--avatar-1..8` | `color ?? seeded(1–12)`, `--avatar-1..12` (§11) |
| Edit agent | Name, description, manager, credential, projects with the template marker | Adds Colour and a model summary line; the marker is removed (§12.6) |
| Template editor | One tab per file, with CodeMirror (`template-editor.tsx`, `code-editor.tsx`) | A Configuration tab first. The file tabs stay as the raw editors (§12.5) |

## 5. The overlay

### 5.1 Shape

One JSON document, file-shaped so it can become a file under mindmount later:

```json
{
  "template": { "model": "opus", "skills": ["release"] },
  "settings": { "permissions": { "deny": ["Bash(rm -rf:*)"] }, "env": { "LOG_LEVEL": "debug" } },
  "mcp": { "mcpServers": { "github": { "type": "http", "url": "https://…", "headers": { "Authorization": "Bearer ${GH_TOKEN}" } } } }
}
```

Every part is optional, and `{}` means "exactly the template". The Zod schemas live in `packages/shared/src/config.ts`:

- **`templateYamlShape`.** The raw field schemas of `template.yaml`, with no `.default()` and no transform, extracted so both schemas can use it. `templateYamlSchema` = `strictObject(shape with defaults).transform(...)`, as today.
- **`overlayTemplateSchema`.** `strictObject` with **optional, default-free** fields taken from `templateYamlShape`. A default would fill `skills: []` into every overlay and break both "`{}` is the template" and the version hash.
  - Replace: `model`, `effort`, `warm_window_minutes`, `max_live_spawns`.
  - Add: `skills`, `plugins`, `can_spawn`, `secrets`.
  - Any other key is an "Unknown field." error. That includes the template-only `name`, `display_name`, `description`, `runtime`, `image`, `permission_mode`, `projects` and `local_skills`. `permission_mode` stays template-only, so a per-agent mode can't quietly loosen safety; `runtime` is fixed at creation (§6.6).
- **`settings`.** A JSON object (Claude Code settings; unknown keys allowed), except:
  - `extraKnownMarketplaces` is an error in an overlay (S2): no overlay-driven mounts or marketplace redirects;
  - `permissions.defaultMode` is an error in templates and overlays (Q3b);
  - `enabledPlugins` stays a warning, ignored and derived from `plugins` (S1). I5 owns this rule once it starts writing that key.
  - **Factory-owned env names** are errors in `settings.env` and in `secrets` names, in templates and overlays alike, for any caller (S2). The names are `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, and any name starting `OPEN_FACTORY_`. They live in one exported constant, `FACTORY_ENV_NAMES`, next to `buildAgentEnv` (`runtime-spec.ts`), which also reads it, so the list can't drift. Message: "GH_X is set by the factory." An overlay can never override a credential, the factory token or the agent's identity.
- **`mcp`.** `strictObject({ mcpServers: record })`, the only key. A server named `factory` is an error.
- **Limits.** Overlay JSON at most 256 KB. A list item (rule, note, skill, plugin) at most 1,000 characters. An env name matches `^[A-Za-z_][A-Za-z0-9_]*$`. A value at most 32 KB. At most 200 items per list and 50 MCP servers. Templates get the same limits on these keys.
- **Model.** For templates and overlays: 1–100 characters of `[A-Za-z0-9._\[\]:-]`, not starting with `-` (it goes on a command line).

The overlay stores secret **names**, never values.

`agents.config` becomes `jsonb … $type<AgentOverlay>().notNull().default({})`. Its **version** is `sha256` of the canonical JSON (sorted keys). It is derived, never stored.

### 5.2 Merge rules

One pure function in `packages/shared/src/config-merge.ts`, used by the server (generated files, change diffs, validation) and by the web (inherited markers, the combined view):

```ts
type ConfigDoc = { template: Record<string, unknown>; settings: Record<string, unknown>; mcp: { mcpServers: Record<string, unknown> } };
mergeConfig(base: ConfigDoc, overlay: AgentOverlay): ConfigDoc
```

`base.template` is the template's parsed `template.yaml` object, in snake_case. The effective `TemplateConfig` is `templateYamlSchema.parse(merged.template)`.

1. **Recursive merge** of `template` and of `settings`. Objects merge key by key, scalars from the overlay replace, and **arrays union**: base first, then the overlay items not already present, compared by canonical JSON. This gives:
   - *Replace*: `model`, `effort`, `warm_window_minutes` and `max_live_spawns` are scalars.
   - *Add*: `skills`, `plugins`, `can_spawn`, `secrets`, `permissions.allow`, `permissions.deny`, `autoMode.environment`, `autoMode.soft_deny`, `autoMode.hard_deny`, and any unknown array such as `hooks.PreToolUse`. An overlay can never drop a template hook, rule or trust note.
   - *Env vars*: `env` is an object, so an overlay entry with the same name replaces the template's value, and a new name adds.
   - *Unknown keys*: deep-merged by the same rule.
2. **MCP servers** merge by name, and an overlay entry **replaces the whole entry**, so a stdio server is never deep-merged into an HTTP one.
3. **Factory-owned keys** are checked in validation (§5.1). `claudeMdExcludes` is appended to, and `"$defaults"` in `autoMode` lists is stripped, both as today (`settings.ts`).

The overlay can only remove what it added: delete the entry from the overlay. Template entries change only in the template.

Tests (`config-merge.test.ts`), one per rule:
- replace, for each scalar;
- union for each named list, with duplicates dropped and order kept;
- an unknown nested array unioned (a `hooks` entry is kept);
- an env name replaced, and one added;
- an MCP server replaced whole (stdio → http leaves no `command`), and one added;
- an overlay deny rule added and then removed, giving back the template's list;
- unknown settings keys deep-merged;
- `{}` gives exactly the base;
- idempotence: `merge(merge(b, o), o) = merge(b, o)`.

### 5.3 Validation

`validateEffective(doc, ctx, policy)` holds the semantic rules `validateTemplate` runs today, moved out to run on any merged document:
- host skills exist and don't share a name with a template-local skill;
- a plugin's marketplace is declared;
- the marketplace source type is valid;
- secrets are defined (a warning);
- `can_spawn` templates exist (a warning);
- the reserved MCP name;
- the factory-owned keys.

New rules:
- `${X}` in an MCP env value or header, where `X` is neither in the effective `secrets` nor a key of the effective `settings.env`, is a warning: "X isn't a secret or env var here."
- A template-local skill entry that is a symlink, or isn't a directory, is a template error: "skills/x must be a folder, not a link." A `skills/` folder that is itself a symlink is an error too: "skills/ must be a folder, not a link." (§6.4)
- A template whose `runtime` differs from that of any of its live or archived agents gets the warning "Existing agents keep their runtime." (§6.6)

`policy` is `"human"` in I2. I7 adds `"agent"` and decides its rules. The I7 input (§19): deny rules can be added but never removed, and a **default-deny** list of keys to forbid, including `hooks`, `apiKeyHelper`, `additionalDirectories` and command-running keys such as `statusLine`. Unknown keys are refused until I7 allows them.

Overlay plugins must come from a marketplace the template declares. The error names the missing marketplace: "Marketplace acme isn't declared by template dev."

How callers use it:
- A template calls it on its own files.
- An overlay save calls it on `mergeConfig(template, overlay)` and reports only the issues the overlay **caused**: issues in `validateEffective(merged)` that are absent from `validateEffective(base)`. These are compared by `message` and `path`, with paths rebased to the overlay.

Issues carry a `path` (`template.skills.2`, `mcp.mcpServers.github.env.TOKEN`). The form maps it to a field, and the raw tab maps it to a line.

### 5.4 What the combined view shows

The merged document holds references, never values: `${GH_TOKEN}` stays literally `${GH_TOKEN}`, and secret names appear in `template.secrets`. The read-only combined view, change lists, events and logs show only these.

### 5.5 Secrets in env and MCP

- **Env from a secret.** The secret's name is in `template.secrets` (template or overlay, unioned), and the env var carries the secret's name (today's rule, `start.ts:199`).
- **Plain env vars** live in `settings.env`. They are written to `settings.json` and visible as text, so they are never for secrets.
- **MCP env and headers** reference a secret as `${NAME}`, and the form adds `NAME` to `template.secrets` in the same edit. The generated `.mcp.json` keeps the reference, and Claude expands it from the process env, which already holds the secret (verified in S6 for `OPEN_FACTORY_AGENT_TOKEN`).

## 6. Effective config at runtime

### 6.1 Resolver

`ConfigResolver` (`apps/server/src/agents/config-resolver.ts`):

```ts
effective(agent: AgentRow): Promise<Effective>
// Effective = { doc: ConfigDoc /* merged */; config: TemplateConfig /* parsed merged.template, runtime = agent.runtime */ }
```

- It reads the template with `TemplateIndex.loadValid(agent.template)`: a disk read, which also schedules change detection (§7.1, never awaited). It then merges `agent.config`. A spawned agent's overlay is always `{}`.
- `loadValid` also returns `tplYaml`, the parsed `template.yaml` object.

Errors:

| Case | Message | Fix code |
|---|---|---|
| Template missing | "Template dev no longer exists." | none |
| Template invalid | "Template dev has errors. Fix it in Templates." | `template` (opens `/templates/<name>`) |
| Overlay invalid | "The configuration of @ana is invalid. Fix it in Configuration." | `config` (opens `/agents/<slug>/config`) |

The new fix codes `template` and `config` go into `events.ts:144`, `agents/errors.ts` and the timeline's fix links.

### 6.2 Who reads what

The runtime keeps the `Effective` its current process started with (`PreparedSpec.effective`, stored at each start as `started`). Config applies at the next start, so whatever describes the **running process** reads `started`:

- `maySpawn` and the MCP tool list (`app.ts:535`);
- `spawn_agent`'s `can_spawn` and `max_live_spawns` checks (`spawn-service.ts`; with no `started`, the call is refused: "@x isn't running.", which can't happen from a tool call);
- the warm window (`agent-runtime.ts:3316`);
- the slash-commands route's skill list (`routes/agents.ts:103,339`), with the resolver as fallback when nothing is running.

Whatever describes the **next start** reads the resolver:

- `createPrepareStart`, including its `spawning: maySpawn(...)` (`start.ts:281`), which reads the `Effective` being prepared, not `started`;
- the Configuration API;
- the Supervisor's image check. `images.refOf` is synchronous and runs before a start, so each **loaded** runtime keeps `nextImage`, set from the resolver when it loads and refreshed by `ConfigChanges` on every change (§7.2). It is undefined when the template is invalid at load, and that start then fails closed (§6.1). If `prepareStart` finds the resolved image differs from `nextImage` (a disk edit no scan has seen yet), it updates `nextImage` and fails this attempt through the existing image-missing path, which pulls and retries.

`syncChildren` runs inside a transaction that holds row locks (`agent-service.ts:330`). It reads the child template's `projects` from the templates **DB row** (`last_valid`), never through `loadValid`, which would read the disk and start detection inside the transaction.

`deriveInheritance` takes the **stricter** of the spawner's `started` and its current effective config: secrets intersected, deny rules unioned. When the spawner isn't loaded (no `started`), it uses the current config only. A child never holds more than either. A child restarted after its spawner **gained** a secret still gets it, because the intersection is recomputed at that start; until it restarts, it runs with less, which is safe. `templateConfigSchema.safeParse(agent.config)` (`start.ts:152`) is deleted.

### 6.3 Start (`Workspace.prepare`)

`PrepareInput` gains `effective: Effective` and loses `config`. `prepare`:

1. installs plugins that are listed and missing (§6.5);
2. links the host skills, template-local skills (§6.4) and projects;
3. writes `settings.json` from `buildSettings({ tpl: effective.doc.settings, … })` (inherited deny rules for a spawned agent as today);
4. writes `.mcp.json` from `buildMcpJson(effective.doc.mcp, …)`;
5. writes `CLAUDE.md`, with `secretNames` taken from the effective (or inherited) secrets;
6. builds mounts with `declaredMarketplaceDirs(effective.doc.settings)`. These are template-declared only (§5.1) and still go through the per-start allow-check.

`applyPending`, `readTemplateJson` and `readTemplateSettings` are deleted. Every input comes from the factory side, never from the agent's workdir: the template folder (operator input) and the overlay in the database.

### 6.4 Template-local skills linked live

For each entry of the template's `skills/` that is a real directory, when `local_skills` is true, `.claude/skills/<name>` is a factory-made link to `realpath(<templates>/<template>/skills)/<name>`. It is the resolved path, because `TemplateIndex.names()` accepts symlinked template folders and Docker mounts only real paths.

- Host and template skills share `syncLinks`. Its "drop unlisted links" pass covers both target prefixes.
- **Docker:** each template skill folder is mounted read-only at that real path. The mount allow-check gains one allowed source class, accepted only when both hold:
  - `lstat(<templates>/<template>/skills/<name>)` is a directory, not a link;
  - `realpath` of the source equals `join(realpath(<templates>/<template>/skills), <name>)`.
  
  - `lstat(<templates>/<template>/skills)` is a directory, not a link, and `realpath` of it equals `join(realpath(<templates>/<template>), "skills")`.
  
  Even when the exemption applies, a source under `FACTORY_HOME/state`, under any agent workdir, or under the host home is still refused. Everything else under `FACTORY_HOME`, and every other refused path, stays refused. Symlinked skill entries and a symlinked `skills/` folder are validation errors (§5.3) and are refused again at start, so the exemption can't reach another workdir, `state/` or `~/.ssh`. Tests cover a symlinked entry and a symlinked `skills/` folder pointing into `state/agents/bob`.
- A non-link entry with a template skill's name in the workdir fails the start with "…isn't a link to the template skill; move it away." An agent created before I2 hits this; see the reset step in §13.
- Skills an agent writes itself (real folders with other names) are left alone.

### 6.5 Plugins: listed and missing are installed

This changes workspace.md's "only at create and re-sync, never at start" (Q8). The principle stays the same: a human listing a plugin, in a template or an overlay, is the explicit act. An installed plugin is never updated without a new listing.

- **Create and spawn** (`materialize`) install the effective plugins, as today.
- **Every start.** `prepare` reads the `enabledPlugins` of `plugins-config/settings.json`, and every effective plugin missing there is installed with today's `installPlugins` through the same hardened path:
  - into the factory-owned `plugins-config/`;
  - with an empty temp cwd;
  - with the env allowlist (`PATH`, host `HOME`, `CLAUDE_CONFIG_DIR`);
  - never into the agent-writable config dir or cwd.
  
  Marketplace sources come only from the effective `extraKnownMarketplaces`, which is template-declared, never from the workdir.
- **Cost.** This runs inside the start, under the workspace lock and holding a slot, for at most the existing install timeout. It is a one-time cost after a plugin is added. I5's shared store removes it.
- **Failure.** A failed install fails the start closed with `AgentStartError("Plugin x@y didn't install.", fix)`; the redacted output goes into the error event. The fix is `template` when the template lists the plugin, else `config`. A process never starts without its plugins. The fix codes `template` and `config` join the unions in `safe-fs.ts:22`, `agents/errors.ts` and `events.ts:144`. `forSpawnedAgent` (`errors.ts:30`) drops `config` for spawned agents, as it drops `edit_agent` today.

### 6.6 Runtime fixed at creation

`agents.runtime` keeps the runtime chosen at creation. A template `runtime` change applies to new agents only (the §5.3 warning). `image` and `permission_mode` follow the live template. Switching runtime would move the session, so the same session couldn't resume; the honest path is to recreate the agent. The resolver overwrites `config.runtime` with the row's, so the local gate, the mounts and the container code all see one value.

### 6.7 Secret users

`secretService.usedBy(name)` returns the agents whose **effective** secrets include `name`: agents that are not archived and not terminated (today's `isNull(archivedAt)` filter), where either
- the template's last valid parse lists it, `templates.last_valid->'template'->'secrets' ? name`, joined on `agents.template`, or
- the overlay lists it, `agents.config->'template'->'secrets' ? name`.

It also returns their live spawned children. Rotate and delete restart exactly those agents, and the Secrets page lists the same set (non-archived, as today). Test: a secret listed only in a template still restarts its agents on rotate and on delete.

## 7. Live templates and the change flow

### 7.1 Detecting a template change

The `templates` index row gains three columns:
- `last_valid jsonb`, the `ConfigDoc` of the last **valid** parse. It is used only as the "before" of a diff, by `usedBy` (§6.7) and by `syncChildren` (§6.2). It is never run on or offered as config (Q7).
- `last_valid_hash`: `sha256` of the canonical `ConfigDoc`, not `content_hash`, so `AGENTS.md` and `files/` edits never move it.
- `valid boolean`.

`index(name)` upserts as today, then:

1. **Compare-and-set.** When the new parse is valid and its hash differs from `last_valid_hash`: `UPDATE templates SET last_valid = $new, last_valid_hash = $newHash WHERE name = $n AND last_valid_hash IS NOT DISTINCT FROM $old RETURNING`. Only the caller whose update returns a row continues, so concurrent scans (a list and several starts at boot) fire once.
2. **Dispatch.** That caller enqueues `ConfigChanges.templateChanged({ name, before: old last_valid, after: new, by })` on a per-template serial queue. It is **never awaited** by the scan. Scans run inside starts (`loadValid` in `prepareStart`, inside the runtime's own job), and awaiting a restart there would deadlock. Errors are logged.
   - `by` is the human's `@handle` for a write through the API, otherwise `"file change"`.
   - With no `before` (a first parse, or a folder that was removed and came back, which deletes the row), there is no event or notice. Running agents of that template still get the restart check: restart when `describeChanges(runtime.started.doc, merge(after, overlay))` is non-empty.
   - The queue is in memory, so a factory crash right after the compare-and-set loses that dispatch. That is accepted: every process restarts with the factory and starts on the current template.

valid → invalid → valid works: `last_valid` keeps the old docs, so the diff when the template is valid again is correct. While a template is invalid, running agents keep running; their next start fails closed (§6.1).

### 7.2 Applying changes

`ConfigChanges` (`apps/server/src/agents/config-changes.ts`) is the one path for template changes and overlay saves. For one agent:

```
apply(agent, by, beforeDoc, afterDoc)
  changes = describeChanges(beforeDoc, afterDoc)          // for the event and the notice
  if empty → return
  write the event (§7.3) and record the notice (§7.3)
  runtime: if a process runs, restart when idle only if describeChanges(runtime.started.doc, afterDoc) is non-empty
  runtime.nextImage = resolve(afterDoc).image
  if the agent spawns: when its effective secrets or deny rules changed, restart its live children (S7 §6.3)
```

- **Template change.** For each agent with `template = name` that is neither archived nor terminated (persistent and spawned): `apply(agent, by, merge(before, overlay), merge(after, overlay))`. An `AGENTS.md` or `files/` edit gives an empty diff and does nothing.
- **Overlay save.** `apply(agent, "@handle", merge(tpl, old), merge(tpl, new))`.
- **Archived agents.** An overlay save on an archived agent writes the event (who changed what), with no notice and no restart: its next start after unarchive reads everything fresh. A template change skips archived agents.
- **The restart compares against what the process started with,** not against the previous version. A start already running on the new config doesn't restart again, and two quick edits that cancel out restart nothing.
- **Never blocking the caller.** The overlay PUT doesn't await the restart request (`runtime.run` may queue behind a start that is installing a plugin): it records the event and notice, schedules the restart and returns. `recordConfigNotice` for a runtime that is still loading awaits the load first, so it can't race the store write.

`describeChanges(a, b): string[]` lives in shared, next to the merge, and follows the secret-safe rule (Q10):

- **Values are shown only for** `model` and `effort` ("model: sonnet → opus"), numbers ("warm window: 70 → 30 min") and names:
  - "added skill release" / "removed skill tdd"
  - "added plugin x@y"
  - "added allow rule `Bash(git push:*)`" / "added deny rule …"
  - "added trust note"
  - "added secret GH_TOKEN"
  - "can spawn: added reviewer"
- **Only a name and a kind are shown for** env vars, MCP servers (never their command, args, URL or headers) and unknown keys: "env LOG_LEVEL changed", "MCP server github added", "MCP server github changed", "settings key hooks changed".
- **Template-only keys that follow the live template** produce lines: "image: a → b", "permission mode: auto → bypass", "template skills on" / "template skills off", and "added template skill x" / "removed template skill x" (the folders under `skills/`, part of the merged doc as `template.local_skill_names`).
- **Keys that never reach a running agent produce nothing,** so editing them restarts nobody: `name`, `display_name`, `description` (the agent has its own), `projects` (grants are identity, Q4) and `runtime` (fixed, Q6). Tests cover both groups.
- The output is sorted and deterministic, one line per change.
- `summarizeChanges(lines)` gives the short form "model, 1 skill, 2 rules and 3 more" (at most three kinds, then "and N more").

### 7.3 Event, notice and live state

- **Event.** `config_changed { by: string; changes: string[] }` is added to `sessionEventSchema`.
  - It is appended **through the runtime** when the agent is loaded (`runtime.append` publishes to the bus, so an open Session shows it live), and through the store otherwise.
  - The timeline row reads "Configuration changed by @orlevi · 3 changes" (or "by template dev", "by a file change in template dev"). The list below it is clamped to two muted lines, with "Show all" (the factory-notice pattern) and `overflow-wrap: anywhere`.
- **Notice.** `config_changed` is added to `NoticeType`, and `isPassive` (`agent-runtime.ts:238`) becomes `crons_stopped | config_changed`, so it never wakes the agent.
  - **Format.** A fixed header line, "Your configuration changed:", then one change per line as "- …". The body can be parsed back. Reset persona's line ("- AGENTS.md reset from template dev; the previous file is saved.") is a line of this same notice, not its own type.
  - **Accumulating.** `EventStore.createNotice` gains a `merge` mode for this type: it parses the pending body's lines and writes back their union, sorted, instead of replacing the body (`event-store.ts:1063`).
  - **Written at change time** for every non-archived agent, whatever its state, through `Runtimes.recordConfigNotice(id, lines)`. That works for an unloaded runtime (store) and a loaded one (runtime). It survives every kind of exit (hibernate, crons takeover, shutdown, archive, crash, stop failure), because it is already a pending row.
  - **Only the next process reads it.** A `config_changed` row created after the current process started is held out of that process's batches (the flush filter compares the row's `createdAt` with the process's start time). So a message arriving between the change and the restart never carries "Your configuration changed…" to the old process. The next process gets it with its first batch, ahead of the other items (`addNotice` ordering). Test: a message between a change and its restart doesn't carry the notice, and the first batch after the restart does.
  - **Lost crons stay their own notice.** `restart_crons` remains a separate, **non-passive** notice, as today, because its wake (`wakeAfterExit("apply_changes")` needs a deliverable item, `hasDeliverable`, `agent-runtime.ts:1444`) is what lets the agent recreate its crons.
- **Restart.** `Runtimes.requestRestart(id, changes?)` → `runtime.requestRestart(changes?)` keeps `pendingChanges` (the short summary source) beside `restartPending`, and it is cleared on any exit. Live state gains `restartChanges: string[]`. The UI line reads "Restarts when idle to apply: model, 1 skill" (`summarizeChanges`). The full list goes in its tooltip and in Agent details. Other callers (credential, grants, manager) pass nothing, as today.
- **I7 room.** `requestRestart` takes `{ changes?, wake? }`. `wake` is unused in I2 and lets I7 deliver its waking "Restarted to apply your config changes…" notice.

### 7.4 Deleting a template

`TemplateIndex.remove` refuses with 409 `template_in_use` while any non-terminated agent (archived included) has `template = name`: "@ana and 2 more (1 archived) use this template. Archive and recreate them first." `spawn_agent` from a missing or broken template is refused with the §6.1 message.

## 8. Removals (PR 1)

- **Server.**
  - `AgentService.resync`, `templateProjects`;
  - `Workspace.resync`, `applyPending`, `readTemplateSettings`, `readTemplateJson`;
  - from `files.ts`: `writeTemplateCopy`, `stageTargets`, `pendingTargets`, and the template-copy part of `copyTargets`;
  - from `paths.ts`: `templateCopyDir`, `resyncPendingDir`, `resyncRoot`;
  - the `resync` route and its schema;
  - fix code `resync`;
  - `grants_overridden`: the column, the summary field and `PATCH projects: null`;
  - `state-migration.ts` and its boot call;
  - `linkPlugins`' legacy move-aside.
- **Kept.** The WS `resync` frame (session replay).
- **Web.**
  - AgentMenu "Re-sync from template…", `lifecycle.resyncAgent` and its toasts, `ResyncFix`;
  - the "From the template / Custom" marker in `ProjectGrantPicker`;
  - `api.resyncAgent`;
  - the Re-sync copy in `factory-section.tsx:49` and `template-editor.tsx:648`;
  - the tests for all of the above.
- **Docs.** §15 drops Re-sync everywhere.

## 9. Reset persona

`POST /api/agents/:slug/reset-persona` is for persistent agents only; archived agents are allowed.

1. Under the workspace lock it reads the template's `AGENTS.md`. A missing or broken template gives 409 `template_missing` or `template_invalid`, as in §6.1.
2. **Write now** when no process is running, and for Docker no container is running either (`containerRunning` moves here). It backs up the current `AGENTS.md` to `state/agents/<slug>/persona/<UTC stamp>/AGENTS.md`, then writes the new one through `SafeFs`, symlink-safe; this is the old `applyTargets` narrowed to one file. Response: `{ applied: "now", backupDir }`. It adds the line "- AGENTS.md reset from template dev; the previous file is saved." to the pending `config_changed` notice (§7.3).
3. **Otherwise** it stages the file at `state/agents/<slug>/persona-pending/AGENTS.md` (factory state). `prepare` applies it first (backup and SafeFs write), then removes it. It calls `requestRestart(id, { changes: ["persona reset from template"] })` and adds the same notice line. Response: `{ applied: "on_restart" }`.

**UI.** AgentMenu gets "Reset persona…" for agents that aren't spawned, live or archived. It opens a `ConfirmDialog`:
- title: "Reset persona?"
- body: "Replace @ana's AGENTS.md with the template's. The current file is saved in state/agents/ana/persona/."
- action: "Reset persona" (crimson)

The outcome toasts, because the menu has closed: "Persona reset. Previous file saved." or "Persona resets when @ana restarts."

## 10. Model and effort

- **Choices.** `packages/shared/src/models.ts`:

  ```ts
  MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"]
  MODEL_IDS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
  ```

  `claude --help` (Claude Code 2.1.327) names `fable`, `opus` and `sonnet` as `--model` aliases; `haiku` is a documented alias. The list is kept by hand. The efforts are today's `EFFORTS`: `low, medium, high, xhigh, max`, the same values `claude --help` lists for `--effort`.
- **Runtime.** It already passes `--model` and `--effort` (`runtime-spec.ts:72`) and now reads them from the effective config. Spawned agents use their template's, since they have no overlay.
- **Picker.** It is part of the Configuration form in PR 3 (§12.3). Before PR 3, the overlay can be set through the API.

## 11. Identity colour

- **Palette.** `--avatar-1` … `--avatar-12`, OKLCH chroma 0.07, at hues **115, 130, 175, 190, 205, 220, 270, 285, 300, 315, 330, 345** in this order (index 1 = 115).
  - Lightness alternates by index: odd = deep, even = light. Light theme L 0.56 / 0.68, dark theme L 0.64 / 0.76.
  - Neighbours then differ by ΔE_ok ≥ 0.12 (reviews' measurement), where single-L 15° steps sit at about 0.018.
  - The warm band 0–100 stays excluded, and every hue keeps ≥ 15° from success (150) and info (250). Hue 115 keeps clear of the warning ochre.
  - Avatar ink stays ≥ 3:1 on every fill (≈ 3.75:1 at L 0.56).
- **Required evidence (R1).** The PR records, for light and dark separately, the minimum pairwise ΔE_ok over all 12 fills, against today's 8 (0.030). No pair may be closer than 0.030.
  - If the 12 can't meet that, PR 2 ships Taste's **6 hues × 2 tiers** instead (hues 120, 175, 210, 280, 315, 345; same L tiers), without another round of review. The PR says which set shipped and why.
- **Single source.** The order is fixed in one shared constant, `AVATAR_HUES` (`packages/shared/src/avatar.ts`), because stored values depend on it. Each entry is `{ hue, tier, name }`, with names for the visible label and screen readers: Olive, Moss, Jade, Teal, Cyan, Sky, Indigo, Violet, Plum, Orchid, Rose, Ruby; the final names are settled in the PR. The CSS tokens are written by hand, and a test compares them with the constant (including ΔE_ok ≥ 0.030 for every pair, and the distance to 150/250).
- **Seeding.** `botParts(slug).fill = take(12) + 1`. Fill is the last draw, so only the colour changes, never the face. The Auto colour of existing agents changes once, which is accepted.
- **Storage.** `agents.color smallint null`, with a CHECK of 1–12; null means Auto. It is identity, not overlay. Set with `PATCH /api/agents/:slug { color: number | null }`. Spawned agents can't be edited, so they stay Auto.
  - A colour-only PATCH never calls `requestRestart`. The Edit agent sheet's restart flag and toast leave `color` out (`edit-agent-sheet.tsx:320,362`, `APPLIES`).
- **Payloads.** Every agent-shaped payload that carries `avatarVersion` also carries `color: number | null`: `AgentSummary`, I1's `ChatRow.agent`, the mention and people sources, and the peer lists used by chips. `AgentAvatar` takes `color` and fills with `var(--avatar-${color ?? seeded})`. The plan lists every call site.
- **`avatar.svg` wins.** A template's `avatar.svg` replaces the generated face and keeps its own colours (DESIGN.md), so for such agents Edit agent shows no Colour field (§12.6).
- **Where colour shows.** Only inside the avatar; DESIGN.md's rule stays. The task spec's "Identity accents (speaker lines, chips)" is read as the avatar in those places (Q15, certainty 3, flagged for Or).

## 12. Configuration form and raw editor

### 12.1 APIs

- **`GET /api/agents/:slug/config`** → `{ overlay, version, template: { name, doc: ConfigDoc | null, valid: boolean }, merged: ConfigDoc | null, issues: TemplateIssue[] }`. `doc` and `merged` are null while the template is invalid or missing. `merged` holds references only (§5.4).
- **`PUT /api/agents/:slug/config { overlay, baseVersion }`.** For persistent agents only (409 `ephemeral_agent`); archived agents are allowed.
  - Parses `agentOverlaySchema`. Zod issues become `issues` with paths, and a 400.
  - Writes in one transaction: `SELECT config … FOR NO KEY UPDATE`, compare its JS-computed version with `baseVersion`, then `UPDATE`. A Postgres `jsonb::text` doesn't sort keys the way the JS canonical form does, so the version is never computed in SQL. A miss is 409 `config_changed`, "Changed since you opened it."
  - If the template is valid, runs `validateEffective`; any error gives a 400 with `issues` and nothing is written. If the template is invalid or missing, it does schema-only validation and returns `checked: "schema"` (R5).
  - On success it runs §7.2 and returns the GET shape plus `changes: string[]`, `restart: boolean` and `checked: "full" | "schema"`.
- **`GET /api/templates/:name/config`** → `{ doc: ConfigDoc | null, hashes: Record<"template.yaml" | "settings.json" | "mcp.json", string | null>, issues, agents: { live: number; archived: number; cantStart: number } }`.
- **`PUT /api/templates/:name/config { doc, baseHashes }`.**
  - Checks all three base hashes (409 `changed_on_disk`, today's copy).
  - Builds the three new texts:
    - `template.yaml` through the `yaml` Document API, setting or deleting only the configuration keys the form owns, so comments, key order and template-only keys survive;
    - `settings.json` and `mcp.json` as `JSON.stringify(doc, null, 2)`.
  - **Writes only the files whose content changed.** An absent `mcp.json` is created only when `doc.mcp.mcpServers` is non-empty.
  - Validates the whole template as it would be written (`validateTemplate` with overrides). Errors give a 400 with `issues`, and nothing is written.
  - Then writes the changed files (temp + rename each) and rescans once, so §7.1 fires once.
- **`GET /api/host-skills`** → `{ dir, skills: [{ name, description }] }`. The description comes from the `SKILL.md` frontmatter, at most 200 characters. It is read live and feeds the skills picker until I5's Library replaces it.

### 12.2 One form for both

`features/config/` (new) holds `ConfigForm`:

- **Props:** `mode: "template" | "agent"`, `value: ConfigDoc` (template) or `AgentOverlay` (agent), `base?: ConfigDoc` (agent mode: the template's doc), `onChange`, `readOnly?`.
- It is controlled. Its draft lives in the page (`useConfigDraft`), shared with the Raw JSON tab.
- It renders from a **tolerant read**: a field whose value has the wrong type (for example `skills: "release"` typed in Raw) shows "Edit this in Raw JSON." with a jump to the line, and never throws.
- Issues whose path maps to no field are listed in an issues block at the top of the form (the template editor's `IssuesBlock` pattern), each with "Show in Raw JSON".

Agent mode shows the merged values:
- Each list has two groups, each labelled once:
  - **"From template dev · 40"**: full-contrast text, no remove button, read-only;
  - **"This agent · 3"**: rows with remove, plus the add row.
- Scalars show an inherit choice (§12.3).

The sections come in this order, each an `h2`, following I4's form rules (`field-stack`, `FieldShell` notes):

1. **Model**: Model and Effort (§12.3).
2. **Skills and plugins.**
   - *Skills*: a combobox over the host skills (`/api/host-skills`, name and a one-line description). Template-local skills are listed read-only as "Template skill".
   - *Plugins*: a text input taking `name@marketplace`. The help reads "Like formatter@acme. The marketplace must be declared in the template's settings.json." (template mode: "…declared in settings.json.").
   - I5 replaces both pickers.
3. **MCP servers.**
   - **Rows.** Line 1: the name (wraps) and the kind ("Command" / "URL"). Line 2, muted: the command and an argument count ("npx · 3 args"), or the URL's host. The args, the full URL and the headers are never shown in a row, because tokens hide in them. Edit and Remove are `shrink-0` icon buttons with labels ("Edit github", "Remove github").
   - **Editor.** Edit or "Add server" expands an inline editor under the row, with no nested sheet over a dirty page. It appears instantly and focus moves to Name. It holds Name, Kind (a two-option segmented control), then:
     - Command: command, args (one per line) and env rows;
     - URL: URL and header rows.
     
     Switching kind keeps what was typed in the other kind's fields until save.
   - **Env and header rows.** Name and value. Below `md` the name sits above the value. Each value has an "Insert secret" ghost action in its label row (FieldShell `action`). It opens a popover from its trigger that lists factory secrets, with "Add secret" (the U4 Add secret sheet).
     - The caret position is saved when the field blurs, which also covers touch.
     - Picking a secret inserts `${NAME}` there, else at the end, and returns focus after the insertion. After "Add secret", it inserts on return.
     - It adds `NAME` to `template.secrets`. The note says so: "Adds GH_TOKEN to this agent's secrets." Removing the reference later does not remove the secret.
   - **Inherited servers** (agent mode) are read-only and offer "Override". It copies the server into the overlay for editing; the same name replaces the template's entry whole.
4. **Permissions.** Allow rules, Deny rules and Trust notes (`autoMode.environment`), each an editable list.
   - Help: "Like Bash(git push:*)." for rules; "Facts that help auto mode decide, like 'deploys go through CI'." for notes.
   - Rules are mono. Trust notes are prose, so they are set in Geist.
   - In agent mode, template deny rules sit in the read-only "From template" group.
5. **Environment.**
   - Plain variables: `settings.env`, name and value.
   - From secrets: a list of secret names picked from the factory's secrets, with "Add secret". Each row reads "Available as $GH_TOKEN".
6. **Behavior.** Warm window (minutes), Spawnable templates (a multi-select of template names), Max live spawns.

`ConfigList` serves every list:

- **Rows.** Minimum 32px on fine pointers and 40px on touch, never a fixed height. Values wrap with `overflow-wrap: anywhere` and are never truncated; rows switch to `items-start` once text wraps. Rules, names and commands are mono; prose is Geist.
- **Add row.** An input with a ghost Add button; Enter adds. A new row is always visible and scrolled into view.
- **Duplicates.** The field note reads "Already in the list." If the match is a collapsed template row, that group expands and scrolls to it.
- **Remove.** An icon button labelled "Remove allow rule 3", never the full value. Afterwards focus moves to the next row's remove button, else to the add input.
- **Collapsing.** Only the **template group** collapses, past 8 rows: "Show all 40" expands in place, instantly, then "Show fewer", and focus moves to the first revealed row. "This agent" rows and the add row are never hidden.

### 12.3 Scalars and inherit

- **Model.** A `Select`.
  - The first item is "Inherit from template" (agent mode) or "Claude Code default" (template mode). The inherited value is in the help line ("From template: claude-sonnet-5-5[1m]"), which wraps, so the trigger never truncates it.
  - Then a group "Aliases" (fable, opus, sonnet, haiku), a group "Model ids" (the four ids), and "Custom…".
  - Custom reveals a mono `Input` under the Select, instantly, focused, and checked by the shared model schema. Its note: "Use letters, digits and . _ : - [ ]".
- **Effort.** A `Select`: Inherit (or "Claude Code default"), then low, medium, high, xhigh, max. The help line works the same way.
- **Numbers.** An `Input` whose placeholder is the inherited value (muted). The help reads "From template: 70 minutes". Empty means inherit.
- **Back to inherit.** While a scalar is overridden, its label row shows "This agent" and a ghost "Use template's" action that clears the override.

### 12.4 Agent Configuration page

- **Route.** `/agents/$slug_/config` (beside `usage`). It shares that page's header component, with a way back to the agent. It is lazy-loaded with the CodeMirror chunk.
- **Header.** The agent's avatar, "Configuration", and "@ana · Template dev" (a link to the template).
- **Tabs.** **Configuration** | **Raw JSON**, with Radix `activationMode="manual"`.
- **Raw JSON tab.**
  - The overlay is in the CodeMirror editor, with the JSON language and the template editor's wrapper (`code-editor.tsx`, U4 §12). Markers come from server `issues` and from client parse errors, and `scrollMargins.bottom` equals the footer's height.
  - A segmented "This agent | Combined" control above the editor switches to the read-only combined view (references only).
  - The raw text and its `EditorState` are kept across tab switches. The text is re-serialized from the draft only when the form changed the draft (canonical JSON differs), so key order, spacing and undo survive a visit to the form.
- **Invalid JSON (R3).** Switching to Configuration or Combined is refused, and the click responds:
  - focus moves to the first parse error in the editor;
  - the note "Fix the JSON to switch tabs." is announced through a polite live region;
  - the note offers "Revert raw edits", which restores the last valid draft.
  
  While the JSON is invalid, Save keeps its shape but is disabled, with "Fix the JSON to save."; Discard always works. Valid JSON that fails the schema switches normally, and the form renders tolerantly (§12.2).
- **Footer (R6).** One row at the bottom of the page column: the I4 `FormOutcome` line above Discard (ghost) and "Save changes" (primary), side by side at every width. It is **sticky only while the form is dirty or an outcome shows**; otherwise it sits in the flow at the end of the form. It has a plate background and a top rule, and no blur. The restart notice sits **in the page flow above the footer**, not in it: "Saving restarts @ana when idle to apply: model, 1 skill." (client-side `summarizeChanges`), shown only while the agent is running.
- **Discard (R4).** Instant, with no confirm. Both tabs reset to the loaded version. The outcome line reads "Discarded." with Undo, which restores the discarded draft (kept in memory) until the next edit.
- **Leaving dirty.** Leaving the page with unsaved changes uses the template editor's `useBlocker` confirm.
- **After a save.** "Saved." Or, when a restart is pending, "Saved. Restarts @ana when idle." With `checked: "schema"`: "Saved. Checked fully once dev is fixed."
- **409, changed since opened.** The line reads "Changed since you opened it." with **Reload**. There is no Overwrite.
  - Reload re-bases: it fetches the new version and re-applies the user's edits, from the loaded base to the draft, over it.
    - Objects and scalars re-apply as leaf-path changes.
    - Union lists (skills, plugins, can_spawn, secrets, rules, notes) re-apply as **sets**: the items the user added are added, and the items the user removed are removed. Index paths are never used.
    - MCP servers and env entries re-apply by name.
  - A conflict is the same scalar path, the same named entry, or the same list item changed on both sides. The user's value is kept, and the field's note reads "Also changed elsewhere." (or a marker in Raw).
  - The re-based draft is still unsaved.
- **Server issues** land on their fields (Configuration) or as markers (Raw).
- **States.**
  - Spawned agent: "Spawned agents use their template's configuration, plus @lead's deny rules and secret limits." with links to the template and the spawner. Below it, the combined view of the process's started config, read-only. If it isn't running, the current resolve, labelled "Next start".
  - Archived agent: a persistent block, "@ana is archived. Changes apply when it's restored." The form stays editable.
  - Unknown slug: "There is no agent @x."
  - Broken or missing template (R5): a **persistent block** above the form, "Template dev has errors. @ana can't start." with "Open template". The Configuration tab is read-only, with no inherited base. Raw stays editable, and a save does schema-only validation.
  - Restart pending: a top line, "Restarts when idle to apply: …".
  - The page refetches on window focus, and on the WS agent and template change events, so "From template" rows and the client summary stay current.
- **Layout.** One column, max-width 44rem, sections 32px apart. At 390px and at 200% text nothing scrolls horizontally, and the inline MCP editor's fields stack.
- **Motion.** The inline MCP editor, "Show all", the Custom input and a picked swatch appear instantly. Nothing on this page animates except I4's note swap.
- **Entry points.** AgentMenu "Configure" (between Edit and Usage), the Edit agent summary line, and the Agent details row "Configuration".

### 12.5 Template Configuration tab

- **The tab.** `template-editor.tsx` gains a **Configuration** tab before the file tabs. Its label is in Geist, while the file tabs stay mono because they are filenames, and a 1px rule separates the two. It is selected by default when the template is valid, else `template.yaml` is. It hosts `ConfigForm mode="template"` with the §12.4 footer. The file tabs stay the raw editors and adopt the same footer rule, so the page has one footer pattern.
- **Below 40rem** the tab strip becomes a `Select` listing every tab with its dirty and error marks, because the strip already clips at 390px (U4 evidence).
- **One draft per file (R2).**
  - While `template.yaml`, `settings.json` or `mcp.json` has a dirty tab, the Configuration form is read-only, with "settings.json has unsaved edits. Save or discard them first." and a jump.
  - While the form is dirty, those three file tabs are read-only, with "Unsaved changes in Configuration."
  - After a file-tab save while the form is clean, the form reloads silently.
  - The dirty dot shows on the Configuration tab too.
- **Header line.** "Used by 3 agents. Saving restarts the ones whose configuration changes, when idle." Plurals come from the existing helpers ("1 agent", "No agents", `template-editor.tsx:845`). While the template has errors: "3 agents can't start until this is fixed."
- **Broken template.** The Configuration tab is read-only (there is no valid doc), and the file tabs are the way to fix it.

### 12.6 Edit agent sheet

The order is Display name, **Colour**, Description, Manager, Credential, Projects, **Model summary**.

- **Colour.** A `FieldShell legend`, with the selected name visible in the legend row: "Colour · Teal", or "Colour · Auto (Jade)".
  - A radiogroup with roving tabindex: **Auto** first, set apart by an 8px gap and drawn with a 1px dashed field-edge outline, then the 12 hues as a 2 × 6 grid.
  - Each swatch is the agent's avatar at 24px in that fill. The pitch is 32px on fine pointers and 40px on touch, so the group fits a 390px sheet.
  - Selected: a 2px `--foreground` ring (graphite in light, light steel in dark) at offset 2px. Focus-visible: the standard signal ring outside it, at offset 4px. Decision 12 holds: a choice is graphite.
  - A hue's name shows as a tooltip on hover and focus (the 400ms tooltip rule) and is the accessible name.
  - There is no transition and no press scale; a keyboard selection takes the ring at once.
  - When the agent's template has an `avatar.svg` (`avatarVersion` set), the field is replaced by one muted line: "This template's avatar.svg sets the avatar."
- **Model summary.** A read-only row at the end of the form, after Projects: "Model opus (this agent) · Open configuration" or "Model sonnet (from template) · Open configuration". The link goes to the page and closes the sheet, keeping the draft.
- The projects marker is removed. A colour change is not in the restart notice and doesn't restart (§11).

## 13. Data model changes

Generated Drizzle migrations only, with no data conversion (ADR 0028):

- `agents.config`: type `AgentOverlay`, default `'{}'::jsonb`;
- `agents.color smallint null`, with a CHECK of 1–12;
- `agents.grants_overridden` dropped;
- `templates.last_valid jsonb`, `templates.last_valid_hash text` and `templates.valid boolean not null default false`.

**Reset step**, stated in every PR and in the plan: drop the database and recreate agents. Agents created before I2 hold a snapshot in `config`, which fails the overlay schema ("The configuration of @x is invalid…"), and their copied template skills collide with the new links (§6.4). Old `state/agents/<slug>/{template,resync,resync-pending}/` folders are left alone: never read and never deleted.

## 14. DESIGN.md amendments

1. **Overlays:** "Exception: a Configuration (agent, template) is a page. It is long, has several sections and a raw editor, and is deep-linked. Create and identity edits stay sheets."
2. **Agent identity:** "twelve muted identity colours (`--avatar-1` … `--avatar-12`, chroma 0.07, hues 115, 130, 175, 190, 205, 220, 270, 285, 300, 315, 330, 345) in two lightness tiers that alternate by index (light L 0.56/0.68, dark 0.64/0.76), so no two are closer than ΔE_ok 0.03; ink ≥ 3:1 on every fill. A human may pick an agent's colour (Edit agent → Colour); Auto is the slug's seeded colour; spawned agents are always Auto; a template `avatar.svg` wins and Colour isn't offered." The tokens list grows to 12 + 12 night. If PR 2 ships the 6 × 2 fallback, it writes that set here.
3. **Components, Colour swatches:** "Avatar-faced swatches at 24px; 32px pitch on fine pointers, 40px on touch; a radiogroup with roving tabindex; selected = 2px graphite (foreground) ring at offset 2, focus = the standard signal ring outside it at offset 4; the selected name shows in the legend row; Auto first, set apart, with a dashed outline; no transition."
4. **Components, Configuration lists:** "Two groups, each labelled once with a count: From template (full-contrast, read-only, collapses past 8 with Show all) and This agent (removable, never collapsed, with the add row). Rows min 32px / 40px on touch, never fixed height; values wrap, never truncate; rules mono, prose Geist."
5. **Components, Page forms:** "A page with one save has a footer at the bottom of its column: the outcome line above Discard (ghost) and Save changes (primary), side by side at every width; sticky only while dirty or an outcome shows; plate background and top rule, no blur. Discard is instant with an inline Undo. Leaving dirty asks first. One draft per file: a form and a raw tab never hold drafts of the same file at once."
6. **Template editor:** "A Configuration tab (Geist) before the file tabs (mono); below 40rem the tabs are a Select with dirty and error marks."

## 15. Product docs to update (PR 1, plus PR 3 for the form)

The docs live in the main checkout's gitignored `docs/product/`. As the last task of PR 1 and of PR 3, the developer updates them in the main checkout and lists them in the PR body:

- **Agent template:** Instantiation (no snapshot, live, Reset persona, overlay).
- **Agent:** no snapshot; model, effort and colour.
- **Workspace:** the layout without `template/` and `resync*`; skills linked; plugins at start; mounts; the plugins paragraph rewritten (Q8).
- **Context assembly:** `AGENTS.md` copied once.
- **Data model:** `agents.config` as overlay, `color`, no `grants_overridden`, the `templates` columns.
- **Administration:** the Configuration page, Reset persona, no Re-sync.
- **Agent runtime:** `requestRestart` with changes; the passive `config_changed` notice.
- **ADR 0017:** a note.

## 16. Testing and evidence

**Unit (shared).**
- `config-merge.test.ts` (§5.2, one test per rule).
- `describeChanges` and `summarizeChanges`: each kind; no values for env, MCP or unknown keys; no MCP args; deterministic order.
- The overlay schema: each allowed key, each template-only key refused, no defaults filled in, the model charset, the limits.
- `AVATAR_HUES`: length 12, order, every pair ΔE_ok ≥ 0.030 per theme, distance from 150 and 250, and the CSS token parity test.

**Server.** DB tests run in CI only, because the local Postgres role is unavailable.
- `prepare` writes the merged files for each rule.
- Template-local skill links, and the Docker allow-check: a symlinked skill entry is refused, a real one is allowed.
- Plugin install installs only the missing plugin, and fails closed on an install failure.
- Change detection:
  - concurrent scans fire once (compare-and-set);
  - valid → invalid → valid fires with the right diff;
  - an `AGENTS.md`/`files/`-only edit gives an empty diff and no restart;
  - a scan inside a start never awaits the change flow, and a start already on the new config doesn't restart again.
- Notices:
  - the `config_changed` notice is passive;
  - lines merge across two changes;
  - it survives a crons takeover, a shutdown and a crash;
  - an unloaded agent gets it;
  - it is folded with lost crons.
- Overlay PUT: a stale version gets 409 (with a concurrent conditional update); a 400 carries paths; a valid save restarts and writes an event; an invalid template gives a schema-only save.
- Template config PUT:
  - three hashes;
  - YAML comments kept;
  - only changed files written;
  - validate-all-then-write: an invalid `mcp.json` leaves `template.yaml` untouched.
- Delete refused while an archived agent uses the template.
- Reset persona, now and on restart: the backup, symlink refusal, the notice.
- Spawned inheritance takes the stricter of started and current; a template change to a spawner restarts its children.
- `usedBy` reads effective secrets (template-only secret rotate and delete).
- A colour-only PATCH doesn't restart.
- No secret value in events, notices, the combined view or logs.

**Web.**
- `ConfigForm`:
  - inherited groups read-only;
  - only the template group collapses;
  - add, remove and focus;
  - Override;
  - Insert secret adds the secret and its note;
  - the tolerant render of schema-invalid values;
  - an unknown key survives a form save.
- The Raw tab: blocking with focus and live region, Revert raw edits, raw text kept across switches.
- Discard with Undo, and the 409 re-base with conflict notes.
- The template page's mutual exclusion.
- The Configuration page states.
- Edit agent: the swatches (radiogroup keys, rings, `color` in PATCH, no restart notice for colour, hidden with `avatar.svg`).
- `AgentAvatar` colour precedence.
- AgentMenu: no Re-sync; Configure and Reset persona present.
- Every web task: the implementer and the reviewer invoke `vercel-react-best-practices`.

**Evidence pass.** In a real browser, Chromium and WebKit headless, with fake Claude only, using the U4 harness through its `run.sh` lock. One heavy job at a time, on `/tmp/of-v002-heavy.lock`.
- **Colour.** The 12 fills at 16px and 24px in both themes, beside the success, info and rate-limited marks. A 115/Olive avatar with the rate-limited badge. The measured minimum ΔE_ok table (R1).
- **Full matrix,** only on the two layout-sensitive views: the Configuration page and the template Configuration tab, at 1440, 1024 and 390px and at 200% text. Use worst-case data:
  - 40 template allow rules plus 3 on the agent;
  - 10 MCP servers with long names, URLs and commands;
  - a custom model `claude-sonnet-5-5[1m]`;
  - template `platform-infrastructure-reviewer`;
  - a raw paste with 40+ changes (timeline clamp, live line).
- **Edit agent** swatches at 390px.
- **Acceptance flows** 2, 4, 10, 11 and 12 end to end. A restart is a hibernate, so each flow sends a message to wake the agent and checks the new `system/init`.

## 17. Delivery

Three stacked PRs on I1's last branch, in a line: `i2/1-overlay` → `i2/2-colour` → `i2/3-config-form`. Each links this spec, the plan and the decision issue. Every intermediate state is a valid product: after PR 1 every overlay is `{}` (settable through the API) and agents run on the live template.

1. **`i2/1-overlay`**: §5–§9, §13 (except `color`), the §15 core docs, the removal of the Re-sync UI, the Reset persona UI, and the `config_changed` timeline row.
2. **`i2/2-colour`**: §11, the Colour part of §12.6, the `color` column, DESIGN.md amendments 2 and 3.
3. **`i2/3-config-form`**: the §10 picker, §12 (APIs, form, page, template tab, model summary line), DESIGN.md amendments 1, 4, 5 and 6, and the form docs.

## 18. Decisions

Rationale and alternatives are in the decision issue. Certainty is on a 1–5 scale; **bold** marks the ones flagged for Or.

| # | Decision | Certainty |
|---|---|---|
| Q1 | The overlay is file-shaped: `{template, settings, mcp}` | 4 |
| Q2 | Overridable keys: replace model, effort, warm window, max spawns; add skills, plugins, can_spawn, secrets. The rest are template-only, and unknown keys are errors | 4 |
| Q3 | Recursive merge with array union everywhere; MCP servers replaced whole; env replace falls out of the object merge | 4 |
| Q3b/S1 | `permissions.defaultMode` is an error in templates and overlays; `enabledPlugins` stays a warning, owned by I5 | 4 |
| Q4 | Grants are agent identity; `grants_overridden` dropped | 4 |
| Q5 | Secrets in the overlay are names (unioned); values never reach files, UI or logs | 4 |
| Q6 | Runtime fixed at creation; image and permission mode follow the template live | 4 |
| Q7 | A broken or deleted template fails closed; delete refused while any agent (archived too) uses it | 4 |
| Q8 | Install listed-but-missing plugins at start, on the hardened path, failing closed | **3** (changes a supply-chain rule) |
| Q9 | Hash-on-read detection; restart only on a non-empty diff; spawned agents are live too | 4 |
| Q10 | The change list goes to the event, the UI line and a passive agent notice; it is secret-safe and never shows MCP args | 4 |
| Q11 | Reset persona: `AGENTS.md` only, with a backup and a confirm dialog | 4 |
| Q12 | Stale state left untouched; a reset step instead | 4 |
| Q13 | Agent Configuration is a page; Edit agent gets colour and a model summary link | 4 |
| Q14 | The template Configuration tab comes first; one validated save for the three files | 4 |
| Q15 | `agents.color`; colour only inside avatars | 4; the accent reading **3** |
| Q16 | A static model list including the `fable` alias (verified); Custom with a safe charset | 4 |
| Q17 | One form, a derived version and 409, a shared draft | 4 |
| Q18 | Three stacked PRs | 4 |
| R1 | 12 hues in alternating lightness tiers, never closer than today's closest pair; 6 × 2 fallback | **3** |
| R2 | One draft per file on the template page (mutual read-only) | 4 |
| R3 | Invalid JSON blocks leaving Raw, but responds (focus, live region, Revert raw edits); tolerant form for schema errors | 4 |
| R4 | Discard is instant with an inline Undo | 4 |
| R5 | Broken template: read-only form, editable Raw, schema-only save, no last-valid copy offered | 4 |
| R6 | DESIGN.md exception for Configuration pages; a one-row footer, sticky only while dirty | 4 |
| R7 | A 409 offers Reload, which re-bases the draft and marks conflicts; no Overwrite | **3** |
| S2 | `extraKnownMarketplaces` is template-only; overlay plugins only from template marketplaces; factory-owned env names rejected everywhere; `validateEffective` takes a caller policy, and I7 defines `agent` default-deny | 4 |
| T1 | The running process's config is its started copy; restarts compare against it; the next start's image comes from the resolver | 4 |
| T2 | MCP secret references stay `${NAME}` in `.mcp.json` | 4 |
| T3 | MCP servers are edited inline on the page, not in a nested sheet | 4 |
| T4 | Change detection is never awaited inside a scan, and is compare-and-set | 5 |

## 19. Follow-ups (separate issues)

- I5: Library pickers replace the skills and plugins inputs; the shared store replaces per-agent plugin installs; revisit `enabledPlugins` (S1).
- I7: the `agent` caller policy for `validateEffective`: deny rules add-only, and a default-deny key list (hooks, `apiKeyHelper`, `additionalDirectories`, `statusLine`-style commands; unknown keys refused until allowed). Also a waking self-restart notice (`requestRestart({ wake })`).
- A form for template-only fields (runtime, image, permission mode, projects).
- Reset `files/` per agent, if wanted.
