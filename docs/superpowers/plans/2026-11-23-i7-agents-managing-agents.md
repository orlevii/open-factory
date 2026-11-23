# I7 Agents managing agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a human-set `manage_org` permission. It gives an agent MCP tools to read and write templates and persistent agents through the same services humans use, behind a fail-closed agent policy. It also adds `restart_agent` and the human **Restart now**, which share one runtime `restartNow`.

**Architecture:**
- **One path.** Every org tool calls the service the human route calls, passing a required `Actor`. The `Actor` drives attribution (`by`), the agent policy and the self rules.
- **The policy** is two pure functions in `packages/shared/src/agent-policy.ts`:
  - `agentPolicyIssues` judges the change (allowlist byte-equality, add-only restrictions, frozen fields, refused env and `${X}` references, store-only plugins);
  - `touchesLocalRuntime` keeps agents off the host.
- **Visibility** goes through I2's `config_changed` event, peer events with `by`, a passive `report_config_changed` notice to the manager, and an `org_action` WS frame that toasts humans.
- **Restarts.** `AgentRuntime.restartNow` replaces the errored-only `restart()`:
  - a check table refuses with codes;
  - a cut restart holds every write (`restartNowPending`), interrupts, force-stops and makes a resume attempt with a waking `restart_applied`;
  - an idle restart is a hibernate.
  
  Self-edits restart when idle and continue through a waking `config_continue`.

**Tech Stack:** TypeScript pnpm monorepo, Fastify, Postgres with Drizzle, Zod in `packages/shared`, `@modelcontextprotocol/server` (existing), React + Vite + TanStack Router/Query, Vitest, Biome. **No new dependency.**

**Spec:** `docs/superpowers/specs/2026-11-23-i7-agents-managing-agents-design.md` (commit 9176e1d). It is the authority for behaviour and copy. Decision log: #163. Follow-ups: #164–#168. Before each task, read the spec sections it cites, and for anything I1, I2 or I5 defines, read their specs and plans in this folder (`2026-11-23-i1-…`, `i2-…`, `i5-…`).

## Global Constraints

- **Pre-release (ADR 0028).** No backward compatibility, no shims, no aliases, no fallbacks for old shapes, no data migration.
  - Schema changes ship only as the generated Drizzle migration (`pnpm db:generate`).
  - `restart()` and the `not_errored` refusal are **deleted**, not kept beside `restartNow`.
  - `OrgEntry.spawnedBy` is **renamed** to `writtenBy`, with no alias.
  - Any fallback or compatibility branch is a review defect.
- **Reset step**, stated in every PR body: none beyond I2's and I5's. Existing rows get the column defaults (`manage_org = false`, `description_by = null`).
- **Builds on unmerged work.** I1, I2 and I5 must be implemented on the branch below. The names this plan uses from them are:
  - I2: `ConfigDoc`, `AgentOverlay`, `mergeConfig`, `overlayVersion`, `canonicalJson` (`packages/shared/src/config-merge.ts`); `describeChanges` and `summarizeChanges` (`config-changes.ts`); `validateEffective(doc, ctx, policy)` and `overlayIssues` (`templates/validate.ts`); `ConfigResolver.effective` (`agents/config-resolver.ts`); `ConfigChanges.apply` (`agents/config-changes.ts`); `AgentService.putConfig`; `Runtimes.requestRestart(id, opts)` and `recordConfigNotice`; `EventStore.createNotice` merge mode; `FACTORY_ENV_NAMES`; the `templates.last_valid*` columns and the CAS dispatch in `TemplateIndex`.
  - I5: `RESERVED_SETTINGS_KEYS` (`packages/shared/src/settings-keys.ts`); `PluginStore.installed()`; `MarketplacesService` and its `RegistryRow`; `LibraryIndex.skills()`.
  - I1: `sendCommandTool`; the Router's list `send(from, to[], body, urgent, opts)`; `@` handles.
  
  If a name differs in the implemented code, use the implemented name and note it in the PR body. Don't add an adapter.
- **Copy is verbatim from the spec.** Refusal sentences, notice texts, CLAUDE.md lines and help text all come from the spec. Copy them, don't paraphrase.
- **Secret safety.** No tool result, event, notice or log holds a secret or credential value or a host path. `describeChanges` lines only (I2 Q10).
- **No real Claude.** Never run real Claude and never read `~/.open-factory-spike` or the real `~/.claude`. Tests and evidence use fake Claude (`packages/harness/testing/fake-claude.mjs`). The live run of AC 10 is Or's (#166).
- **Database tests run only in CI.** Tests using `createTestDb` / `makeTestApp` (`apps/server/src/test/helpers.ts`) need Postgres, and the local Postgres role is unavailable. Locally run the pure unit tests, the web tests and `pnpm typecheck`; read CI for the DB suites.
- **React.** Every task that touches `apps/web` says: "Implementer and reviewer invoke `vercel-react-best-practices` and follow it." Next-only rules don't apply (this is React + Vite + TanStack). Each PR's final review checks the React diff against the skill.
- **I4 form rules.** Use `FieldShell` / `FieldNote`, `useFieldErrors`, `FormOutcome` and `field-stack`. Client messages live in `MSG` / `FIELD_MSG` / `FORM_MSG` and are at most 40 characters.
- **Heavy jobs.** At most one full suite, build or evidence pass at a time on this machine, under `/tmp/of-v002-heavy.lock`:
  - take it with `mkdir /tmp/of-v002-heavy.lock` and write an `owner` file (your agent name and pid) inside;
  - if it exists, retry later. Never write sleep or wait loops on other agents' processes;
  - remove it when done.
- **Supply chain.** Exact pins, the pnpm minimum release age and `--frozen-lockfile` stay. The lockfile doesn't change.
- **Git.** Merge, never rebase. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never merge a PR.

## Branches

All work happens in the worktree `/Users/orlevi/projects/open-factory/.worktrees/spec-i7`.

- **Part A, `i7/1-manage-org`:** cut from `spec/i7-agents-managing-agents` after merging I5's last branch (`i5/3-polish-docs` if it exists, else `i5/2-plugins`, else `spec/i5-skills-and-plugins`).
- **Part B, `i7/2-template-tools`:** cut from `i7/1-manage-org`.
- **Part C, `i7/3-restart`:** cut from `i7/2-template-tools`.

Before each push, merge the branch below again (never rebase). Each PR is a **draft** stacked on the one below, and must be retargeted after the PR below merges. Say so in each PR body.

```bash
cd /Users/orlevi/projects/open-factory/.worktrees/spec-i7
git fetch origin
git merge --no-edit origin/i5/3-polish-docs 2>/dev/null || git merge --no-edit origin/i5/2-plugins 2>/dev/null || git merge --no-edit origin/spec/i5-skills-and-plugins
git checkout -b i7/1-manage-org
```

**Commands:**
- one file: `pnpm vitest run <path>`;
- the whole suite: `pnpm test` (heavy; take the lock);
- `pnpm typecheck`, `pnpm lint`, `pnpm build`;
- migrations: `pnpm db:generate`.

## File map

**Shared (`packages/shared/src/`)**

| File | Purpose | Part |
|---|---|---|
| `actor.ts` (new) | `Actor`, `actorBy(actor)` | A |
| `agent-policy.ts` (new) | `AGENT_EDITABLE`, `AGENT_REFUSED_ENV`, `isRefusedEnv`, `refusedReferences`, `agentPolicyIssues`, `touchesLocalRuntime`, `LOCAL_RUNTIME_REFUSAL` | A |
| `org-tools.ts` (new) | Zod input schemas for every org tool and `restartAgentToolSchema` (C) | A, B, C |
| `agents.ts` | `AgentSummary.manageOrg`; `patchAgentBodySchema.manageOrg`; restart body `{force?}`, response `{status}` (C) | A, C |
| `ws.ts` | `org_action` frame | A |
| `index.ts` | exports | A, B, C |

**DB (`packages/db/src/schema/agents.ts`)**: `manageOrg`, the CHECK, `descriptionBy` (A).

**Server (`apps/server/src/`)**

| File | Purpose | Part |
|---|---|---|
| `agents/agent-service.ts` | `Actor` on create, update, archive and unarchive; policy and never checks; `description_by`; `create` with `config` | A |
| `agents/config-service.ts` (new) | `ConfigService.saveOverlay(slug, overlay, baseVersion, actor)`, extracted from I2's `putConfig` | A |
| `agents/config-changes.ts` (I2) | `by` from the actor; `report_config_changed`; self `wake` | A |
| `agents/policy-inputs.ts` (new) | `loadPolicyStore()`, `templateRuntimes(names)`, `templateHasLocalAgents(name)` | A |
| `agents/event-store.ts` | `createNotice` merge keyed on `subjectAgentId`, line union under `FOR UPDATE` | A |
| `agents/notices.ts` | `report_config_changed`, `config_continue` (A); `restart_applied` (C) | A, C |
| `agents/agent-runtime.ts` | `isPassive`; `pendingWake` and `config_continue` (A); `restartNow`, `restartNowPending`, the flush guard, `beginRestartNowStop` (C) | A, C |
| `agents/errors.ts` | `RecoveryRefusedError.data`; new codes | C |
| `messaging/router.ts`, `messaging/peer-body.ts` | `PeerChange.by`; recipient-aware text; `LEFT` regex | A |
| `workspace/claude-md.ts` | `manageOrg`, the sections, `writtenBy` | A, B, C |
| `mcp/tools/org-tools.ts` (new) | `orgTools(d)`: agent tools and reads (A); template writes (B) | A, B |
| `mcp/tools/org-errors.ts` (new) | `toolErrorOf(err)`: `FieldError`/`ApiError`/policy issues → one sentence | A |
| `mcp/tools/restart-agent.ts` (new) | `restartAgentTool(d)` | C |
| `templates/template-index.ts` | `KeyedMutex` on every write path; validate-first `writeFile`; `copyFrom`; `templateAuthors` | B |
| `routes/agents.ts` | pass `Actor`; `manageOrg` PATCH; `/restart {force}` (C) | A, C |
| `routes/templates.ts` | pass `Actor` | B |
| `app.ts` | tool registration, ports | A, B, C |

**Web (`apps/web/src/`)**

| File | Purpose | Part |
|---|---|---|
| `features/agents/edit-agent-sheet.tsx` | "Can manage the org" switch | A |
| `features/session/agent-details.tsx` | "Manages the org: Yes" row; Restart now on the restart line (C) | A, C |
| `features/org/org-toasts.ts` (new) | `onOrgAction(frame)`: 2 s merge per actor and action, then `notify` | A |
| `routes/_app.tsx` | Routes `org_action` frames | A |
| `features/agents/agent-menu.tsx`, `features/session/api.ts`, `features/session/recovery-actions.tsx`, `features/session/live-line.tsx` | Restart now and the lost-work dialog | C |
| `features/agents/restart-now.ts` (new) | `useRestartNow(slug)`: POST, 409 `lost_work` → dialog → `force` | C |

---

# Part A: `i7/1-manage-org` (PR 1)

Implements spec §2 AC 1–8 and 15, §5, §6, §7 (except `create_template` and `write_template_file`), §8, §9.5, §10 (PR 1 lines and `writtenBy`), §11 and §12 (the PR 1 docs).

### Task A1: `Actor` and the agent policy (shared)

Spec §5.3, §6.1–§6.3.

**Files:**
- Create: `packages/shared/src/actor.ts`, `packages/shared/src/agent-policy.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/agent-policy.test.ts`

**Interfaces (produces):**

```ts
// actor.ts
export type Actor = { kind: "human"; handle: string } | { kind: "agent"; id: string; slug: string };
export function actorBy(a: Actor): string; // "@handle" | "@slug"

// agent-policy.ts
export const AGENT_EDITABLE: {
  templateYaml: readonly string[];      // spec §6.3 row 1
  frozen: readonly ["runtime", "image", "permission_mode"];
  overlayTemplate: readonly string[];   // model, effort, warm_window_minutes, max_live_spawns, skills, can_spawn, secrets
  settings: readonly string[];          // dotted paths, "*" for map keys: "permissions.allow", "permissions.ask", "permissions.deny",
                                        // "autoMode.environment", "autoMode.soft_deny", "autoMode.hard_deny", "env.*",
                                        // "enabledPlugins.*", "extraKnownMarketplaces.*" (templates only)
  mcp: readonly ["mcpServers.*"];
};
export const ADD_ONLY: readonly string[]; // permissions.deny, permissions.ask, autoMode.soft_deny, autoMode.hard_deny
export const AGENT_REFUSED_ENV: {
  names: readonly string[];      // FACTORY_ENV_NAMES ∪ proxy/TLS ∪ loaders (spec §6.2 rule 4), compared upper-cased
  prefixes: readonly string[];   // "ANTHROPIC_", "CLAUDE_CODE_", "OPEN_FACTORY_"
  suffixes: readonly string[];   // "_HELPER"
};
export function isRefusedEnv(name: string): boolean;                 // case-insensitive
export function refusedReferences(value: unknown): string[];         // every ${X} / ${X:-…} in any nested string where isRefusedEnv(X)
export type PolicyStore = { installed: ReadonlySet<string>; registry: ReadonlyMap<string, unknown> };
export function agentPolicyIssues(i: {
  target: "template" | "overlay";
  before: ConfigDoc | AgentOverlay;
  after: ConfigDoc | AgentOverlay;
  frozen?: { runtime: string; image: string | null; permission_mode: string };
  store: PolicyStore;
}): TemplateIssue[];
export function touchesLocalRuntime(i: {
  templateRuntime?: string; templateHasLocalAgents?: boolean; agentRuntime?: string; canSpawnRuntimes?: string[];
}): boolean;
export const LOCAL_RUNTIME_REFUSAL = "Local-runtime agents and templates can only be changed by a human.";
```

- [ ] **Step 1: Write the failing tests** in `agent-policy.test.ts`, one test per rule (spec §14 Unit). Use a fixture `base: ConfigDoc` whose settings hold `includeCoAuthoredBy: true`, `permissions.deny: ["Bash(rm:*)"]`, `permissions.ask: ["Bash(git push:*)"]` and `autoMode.hard_deny: ["x"]`, and whose `mcp.mcpServers` holds `gh`.
  - **Rule 1:** an unchanged `includeCoAuthoredBy` passes. Setting it to `false`, deleting it, or adding `statusLine` each gives one issue with message "`settings.includeCoAuthoredBy` can only be changed by a human." (use the path given).
  - **Rule 2:** removing `Bash(rm:*)` gives "Deny rules can only be removed by a human."; removing the ask rule gives "Ask rules can only be removed by a human."; removing the `hard_deny` entry gives "Restrictions can only be removed by a human."; adding a deny rule passes.
  - **Rule 3:** `runtime: local`, `image: x` and `permission_mode: bypass` against `frozen` each give "runtime can only be changed by a human." (with that field's name). Equal values pass, and so does an absent value whose schema default equals `frozen`.
  - **Rule 4:** each of these, added in `settings.env`, in `template.secrets` or as an MCP server `env` key, is refused with "X can only be set by a human.":
    - `https_proxy` (lower case);
    - `ANTHROPIC_BASE_URL`;
    - `CLAUDE_CODE_OAUTH_TOKEN`;
    - `GIT_ASKPASS_HELPER`;
    - `NODE_OPTIONS`;
    - `PATH`;
    - `OPEN_FACTORY_AGENT_TOKEN`.
    
    `LOG_LEVEL` passes.
    
    References: `headers.Authorization: "Bearer ${CLAUDE_CODE_OAUTH_TOKEN}"`, `command: "${PATH}/x"` and `url: "https://h/${ANTHROPIC_API_KEY:-x}"` are each refused with "MCP server gh can't reference CLAUDE_CODE_OAUTH_TOKEN." (with that name), while `${GH_TOKEN}` passes.
  - **Rule 5:** `enabledPlugins["fmt@acme"]: true` passes when `installed` has it and fails otherwise ("Plugin fmt@acme isn't installed in the factory. Ask a human to install it in Skills."). An `extraKnownMarketplaces.acme` that differs from `registry.get("acme")` fails ("Marketplace acme must match the factory's registry.").
  - **Rule 6:** a server named `factory` is refused, while adding, changing or removing `gh` passes.
  - **Rule 7:** every entry of `RESERVED_SETTINGS_KEYS` except `enabledPlugins` and `extraKnownMarketplaces` is absent from `AGENT_EDITABLE.settings`.
  - **Rule 8:** `touchesLocalRuntime` is true for each of these, false for an all-docker input:
    - `{templateRuntime: "local"}`;
    - `{templateHasLocalAgents: true}`;
    - `{agentRuntime: "local"}`;
    - `{canSpawnRuntimes: ["docker", "local"]}`.
  - **The overlay target:** `extraKnownMarketplaces` in an overlay is never on the allowlist (template only).
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/agent-policy.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
  - Walk `before` and `after` as flat dotted leaf maps, where arrays are leaves except on `ADD_ONLY` paths and union paths. A path not matched by `AGENT_EDITABLE` must be `canonicalJson`-equal on both sides (rule 1).
  - `ADD_ONLY` checks `before ⊆ after` by canonical JSON.
  - Frozen fields are compared after applying `templateYamlShape` defaults (runtime `docker`, permission_mode `auto`, image optional).
  - `refusedReferences` matches `/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g` over every string reached by a deep walk of a server entry.
  - Issues carry I2's `path` (`settings.permissions.deny.0`, `mcp.mcpServers.gh.headers.Authorization`).
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(shared): agent policy and Actor`.

### Task A2: `manage_org` and `description_by` columns, schemas

Spec §5.1, §10 (`description_by`), §11.

**Files:**
- Modify: `packages/db/src/schema/agents.ts`; the generated migration under `packages/db/drizzle/`; `packages/shared/src/agents.ts`
- Test: `packages/shared/src/agents.test.ts`, `packages/db/src/schema/agents.test.ts` (CI only)

**Interfaces (produces):**
- `agents.manageOrg: boolean` (`manage_org boolean not null default false`), with `CHECK (NOT manage_org OR kind = 'persistent')` named `agents_manage_org_persistent`;
- `agents.descriptionBy: string | null` (`description_by uuid references agents(id) on delete set null`);
- `AgentSummary.manageOrg: boolean`;
- `patchAgentBodySchema` gains `manageOrg: z.boolean()` (still `.strictObject().partial()`).

- [ ] **Step 1: Write the failing tests.**
  - `agents.test.ts`: `patchAgentBodySchema.safeParse({ manageOrg: true }).success === true`, and `createAgentBodySchema` refuses `manageOrg` (it's strict, or the key is stripped; assert that the parsed result has no `manageOrg`).
  - The schema test (CI): inserting an ephemeral row with `manageOrg: true` violates the check.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/agents.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the columns and the CHECK. Run `pnpm db:generate` (generated migration only, ADR 0028). Fill `manageOrg` in `AgentService.summarize`.
- [ ] **Step 4: Run** the test and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): agents.manage_org and description_by`.

### Task A3: Policy inputs and `Actor` in `AgentService`

Spec §5.1, §5.3, §6.1 ("Where it runs"), §6.2 rule 8, §7.2, §7.4, §7.5 (identity), §10 (`description_by`).

**Files:**
- Create: `apps/server/src/agents/policy-inputs.ts`
- Modify: `apps/server/src/agents/agent-service.ts`, `apps/server/src/routes/agents.ts`, `apps/server/src/app.ts`
- Test: `apps/server/src/agents/agent-service.org.test.ts` (CI only)

**Interfaces:**
- Consumes: `Actor`, `agentPolicyIssues`, `touchesLocalRuntime` (A1); I2 `overlayIssues`, `mergeConfig`; I5 `PluginStore.installed()`, `MarketplacesService` registry rows.
- Produces:

```ts
// policy-inputs.ts
export class PolicyInputs {
  store(): Promise<PolicyStore>;                              // installed keys + registry entries, loaded once per call
  templateRuntimes(names: string[]): Promise<string[]>;       // from templates.last_valid (DB index; never takes template locks)
  templateHasLocalAgents(name: string): Promise<boolean>;     // any non-terminated agent row on it with runtime 'local'
}
// agent-service.ts (all take a required actor; no default)
create(b: CreateAgentBody & { config?: AgentOverlay }, actor: Actor): Promise<AgentSummary>;
update(slug: string, b: PatchAgentBody, actor: Actor): Promise<AgentSummary>;
archive(slug: string, actor: Actor): Promise<AgentSummary>;
unarchive(slug: string, actor: Actor): Promise<AgentSummary>;
export class OrgRefusedError extends Error { constructor(message: string) }  // mapped to 403 for REST, a tool error for MCP
```

- [ ] **Step 1: Write the failing tests** (`agent-service.org.test.ts`, DB). Each "never" case is called against the service directly, with `actor = {kind: "agent", …}`:
  - `update(slug, {manageOrg: true}, agentActor)` → `OrgRefusedError("Only a human can grant manage_org.")`, and the same with the caller's own slug;
  - `archive(self.slug, selfActor)` → "Ask a human to archive you.";
  - `unarchive(x, agentActor)` where `x.manageOrg` → "Only a human can unarchive @x: it can manage the org.";
  - `create({template: "localtpl"…}, agentActor)` → `LOCAL_RUNTIME_REFUSAL`, as are `update` of a local agent, `archive`/`unarchive` of a local agent, and `create` with `config.template.can_spawn: ["localtpl"]`;
  - `create` from a docker template with `config: {template: {model: "opus"}}` stores the overlay. With `config.settings.env.HTTPS_PROXY` it creates nothing (no row, no folder);
  - `create` with no `reportsTo` from an agent actor: the tool layer fills the caller (tested in A7). Here, `reportsTo: null` is top level;
  - a human `update` of `description` sets `description_by = null`, and an agent update sets it to the agent id;
  - human actors pass through unchanged: the existing `agent-service.test.ts` keeps passing with `{kind: "human", handle: "or"}`.
- [ ] **Step 2: Run** `pnpm typecheck`. Expected: errors where callers don't pass an actor. The DB tests run in CI.
- [ ] **Step 3: Implement.**
  - Add the `actor` parameter and thread it from `routes/agents.ts` (`{kind: "human", handle: user(req).handle}`). There is no default.
  - The agent-only checks run at the top of each method, before any write.
  - `create` validates `config` before `materialize`: `agentOverlaySchema`, `overlayIssues(tpl.doc, config, ctx)`, then `agentPolicyIssues({target: "overlay", before: {}, after: config, store})`. Store it in the insert's `config`.
  - `manageOrg` in `update` is applied only for human actors, and requests a restart when it changes (spec §5.1).
  - Wire `PolicyInputs` in `app.ts`.
- [ ] **Step 4: Run** `pnpm typecheck` and `pnpm vitest run apps/server/src/agents/agent-service.test.ts` (CI for DB). Expected: PASS in CI.
- [ ] **Step 5: Commit** `feat(server): Actor and the agent policy in AgentService`.

### Task A4: `ConfigService.saveOverlay`, attribution and the self-wake request

Spec §5.3, §7.5, §8.1, §9.5 (the request side).

**Files:**
- Create: `apps/server/src/agents/config-service.ts`
- Modify: `apps/server/src/agents/agent-service.ts` (I2 `putConfig` moves out), `apps/server/src/agents/config-changes.ts`, `apps/server/src/routes/agents.ts`
- Test: `apps/server/src/agents/config-service.test.ts` (CI only)

**Interfaces (produces):**

```ts
export class ConfigService {
  saveOverlay(slug: string, overlay: unknown, baseVersion: string, actor: Actor):
    Promise<{ overlay: AgentOverlay; version: string; changes: string[]; restart: boolean; checked: "full" | "schema" }>;
  validateOverlay(slug: string, overlay: unknown, baseVersion: string, actor: Actor): Promise<ValidatedOverlay>; // no write; used by update_agent (A7)
}
// ConfigChanges.apply(agent, actor: Actor, beforeDoc, afterDoc)   // was `by: string`
```

- [ ] **Step 1: Write the failing tests** (DB):
  - a stale `baseVersion` from an agent actor → `OrgRefusedError("@dev's configuration changed since you read it; call get_agent again.")`; a human actor still gets I2's 409 `config_changed`;
  - an agent actor removing an overlay deny rule is refused with the rule 2 sentence, and nothing is written;
  - a spawned target → "Spawned agents use their template's configuration.";
  - a local target → `LOCAL_RUNTIME_REFUSAL`;
  - a valid agent save writes `config_changed {by: "@hr"}`;
  - a save whose actor is the target calls `requestRestart(id, {changes, wake: true})`, and a save by another calls it without `wake` (spy on `Runtimes`);
  - the route `PUT /api/agents/:slug/config` behaves as before (I2's route tests still pass).
- [ ] **Step 2: Run** `pnpm typecheck`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Move I2's `putConfig` body into `ConfigService.saveOverlay`, adding the policy for agent actors (`before` = the stored overlay), and make the route call it. `ConfigChanges.apply` takes the `Actor` and writes `by: actorBy(actor)`, passing `wake: actor.kind === "agent" && actor.id === agent.id`.
- [ ] **Step 4: Run** the I2 route tests and the new tests (CI). Expected: PASS.
- [ ] **Step 5: Commit** `refactor(server): ConfigService.saveOverlay with Actor and the agent policy`.

### Task A5: Visibility: peer events, `report_config_changed`, `org_action`

Spec §8.

**Files:**
- Modify: `apps/server/src/messaging/router.ts`, `apps/server/src/messaging/peer-body.ts`, `apps/server/src/agents/notices.ts`, `apps/server/src/agents/event-store.ts`, `apps/server/src/agents/agent-runtime.ts` (`isPassive`), `apps/server/src/agents/config-changes.ts`, `apps/server/src/agents/agent-service.ts`, `packages/shared/src/ws.ts`
- Test: `apps/server/src/messaging/peer-body.test.ts`, `apps/server/src/agents/event-store.notice-merge.test.ts` (CI), `apps/server/src/agents/config-changes.org.test.ts` (CI), `packages/shared/src/ws.test.ts`

**Interfaces (produces):**
- `PeerChange` members `joined`, `left: archived` and `moved` gain `by?: string`;
- `peerBody(subject, relation, change, recipientSlug: string)`;
- `NoticeType` gains `"report_config_changed"`;
- `notices.reportConfigChanged({by, report, summary})` → `"@hr changed @dev's configuration: model, 1 skill."`;
- `createNotice(agentId, type, body, { merge?: true, subjectAgentId?: string })`;
- WS: `{ type: "org_action", action: "agent_created" | "agent_archived" | "agent_unarchived" | "template_created", by: string, subject: string }`.

- [ ] **Step 1: Write the failing tests.**
  - `peer-body.test.ts`: the three texts from spec §8.2 for the recipient `lead` and `by: "@hr"`; no suffix when `by` equals the recipient or is absent; and round-trips through the read-back parser for each `left` form, with and without `, by @x`.
  - Notice merge (DB): two `report_config_changed` notices for the same (manager, report) give one pending row whose lines are the sorted union; a different report gives a second row; two concurrent merges (`Promise.all`) lose no line.
  - `config-changes.org.test.ts` (DB):
    - an agent actor changing `@dev` (manager `@lead`, caller `@hr`) gives `@lead` one passive `report_config_changed`;
    - the caller being `@lead` gives none;
    - a self-edit by `@hr` notifies `@hr`'s manager;
    - a top-level target gives none;
    - a human actor gives none.
  - `isPassive` holds for `report_config_changed` (extend `agent-runtime.passive.test.ts`).
  - An `org_action` frame is published for agent-actor create, archive and unarchive only (a spy on the bus).
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/messaging/peer-body.test.ts packages/shared/src/ws.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Extend the `LEFT` regex with `(?:, by (@[^\s.]+))?` before `\.$`.
  - Pass the recipient slug in `persistPeerEvents`.
  - `createNotice` merge: inside a transaction, `SELECT … FOR UPDATE` the pending row matching (agent, type, `subjectAgentId`), then union the parsed lines, sort them and update the body.
  - `AgentService` passes `by` into `peerEvents` and publishes `org_action` (`bus.publishAll`) after the commit, only for agent actors.
- [ ] **Step 4: Run** the tests. Expected: PASS (DB tests in CI).
- [ ] **Step 5: Commit** `feat(server): attribution for agent-made org changes`.

### Task A6: Self-edit wake (`pendingWake`, `config_continue`)

Spec §9.5, AC 15.

**Files:**
- Modify: `apps/server/src/agents/agent-runtime.ts`, `apps/server/src/agents/notices.ts`
- Test: `apps/server/src/agents/agent-runtime.self-wake.test.ts` (CI only; uses the fake transport in `packages/harness/testing/fake-transport.ts`)

**Interfaces (produces):**
- `requestRestart(opts?: { changes?: string[]; wake?: boolean })` sets `pendingWake` when `wake`;
- `NoticeType` gains `"config_continue"`;
- `notices.configContinue({ crons: string[] })` → `"Restarted to apply your config changes. Continue where you left off."`, plus, when crons were stopped, `" These crons were stopped: …; recreate them if you still need them."`.

- [ ] **Step 1: Write the failing tests:**
  - a running agent with a live non-ambient background task, given `requestRestart({changes: ["model: sonnet → opus"], wake: true})` mid-turn, does **not** stop at `turn_end`. It stops once the task finishes (`background_task_finished`);
  - after the exit, the next process's first batch holds the earlier passive `config_changed`, then `config_continue`, and a turn starts with no human message;
  - with an in-session cron, `config_continue` names it and **no** `restart_crons` notice is added;
  - Stop crons taking over the apply hibernate (`stopCrons`) keeps `pendingWake`: the agent continues, and the notice also mentions the stopped crons;
  - `pendingWake` is cleared by any other exit (crash, archive).
- [ ] **Step 2: Run** `pnpm typecheck` (new names). DB/runtime tests run in CI.
- [ ] **Step 3: Implement.** In the hibernate's `exited` job (around `recordLostWork`, `agent-runtime.ts:2934`): when `pendingWake` is set, add `config_continue` instead of `restart_crons`, then `wakeAfterExit("apply_changes")`. Clear `pendingWake` in `onExited` for any other `afterExit`.
- [ ] **Step 4: Run** the tests (CI). Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): self-edit restarts continue on their own`.

### Task A7: Org MCP tools (agents and reads), gating, error mapping

Spec §5.2, §7.1, §7.2, §7.4, §7.5, AC 1, 3, 4, 6, 7.

**Files:**
- Create: `packages/shared/src/org-tools.ts`, `apps/server/src/mcp/tools/org-tools.ts`, `apps/server/src/mcp/tools/org-errors.ts`
- Modify: `apps/server/src/app.ts` (the `tools(caller)` list at ~L519)
- Test: `apps/server/src/mcp/tools/org-tools.test.ts` (CI; uses `apps/server/src/mcp/testing/mcp-client.ts` against the agent listener with a minted token), `packages/shared/src/org-tools.test.ts`

**Interfaces (produces):**

```ts
// org-tools.ts (server)
export function orgTools(d: {
  loadAgent(id: string): Promise<AgentRow | undefined>;
  agents: AgentService; config: ConfigService; resolver: ConfigResolver;
  templates: TemplateIndex; library: LibraryIndex; store: PluginStore;
  credentials: CredentialService; secrets: SecretService; projects: ProjectService;
  policy: PolicyInputs;
}): ToolRegistration[];
// org-errors.ts
export function toolErrorOf(err: unknown): ReturnType<typeof toolError>; // FieldError → "field: message"; ApiError/OrgRefusedError → message; issues → "path: message" lines
```

The tools are `get_agent`, `create_agent`, `update_agent`, `archive_agent`, `unarchive_agent`, `list_templates`, `get_template`, `list_library` and `list_org_resources`, with the shapes in spec §7.1.

- [ ] **Step 1: Write the failing tests** (DB, CI):
  - **Registration:** a caller without the flag lists none of the nine tools; with the flag it lists all nine.
  - **Revoke:** the flag is turned off between `tools/list` and `tools/call`, and the call gets the SDK unknown-tool error. A handler invoked directly with a revoked caller row gets "@hr can't manage the org any more.".
  - **`create_agent`:**
    - omitted `manager` and `"me"` both give `reportsTo = caller`, and `null` is top level;
    - the result note reads "@dev is created and starts when it gets its first message.";
    - a slug that is taken returns the same sentence as the human route, as `name: …`.
  - **`update_agent`:**
    - `config` without `base_hash` is a schema error;
    - a stale hash gives the Q14 sentence;
    - identity and `config` together, with an invalid `config`, write nothing (the row is unchanged);
    - `changed` lists the field names plus `describeChanges` lines.
  - **`get_agent`:** `overlay_hash` equals I2's `overlayVersion`; `effective` keeps `${GH_TOKEN}` literal; `credential` and `projects` are names.
  - **`get_template`:** a linked file returns `{error: "settings.json is a link; ask a human."}`.
  - **`list_library`:** `source` is a kind, never a path; a host-only plugin isn't listed; 201 skills give `more: true`.
  - **`list_org_resources`:** names only, and no `hostPath` key anywhere.
  - **The value scan (AC 6):** seed a secret `S=sekrit-123` and a credential token `sk-ant-oat01-xyz`, call every tool, and assert that no result text contains either.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/org-tools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Each handler starts with the call-time check (`loadAgent(callerOf(tctx))`).
  - Slugs accept a leading `@`.
  - `update_agent` calls `config.validateOverlay` first, then `agents.update` validation, then saves both (spec §7.5 order). If the second save fails, the result says which part was saved.
  - In `app.ts`: `...(caller.manageOrg ? orgTools(...) : [])`.
- [ ] **Step 4: Run** the tests (CI) and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): org tools for manage_org agents`.

### Task A8: CLAUDE.md: "Managing the org" (PR 1 lines) and `writtenBy`

Spec §10.

**Files:**
- Modify: `apps/server/src/workspace/claude-md.ts`, the caller that builds `ClaudeMdInput` (`agents/start.ts` / `workspace/workspace.ts`), `apps/server/src/agents/agent-service.ts` (the `OrgEntry` source)
- Test: `apps/server/src/workspace/claude-md.test.ts`

**Interfaces:**
- `ClaudeMdInput` gains `manageOrg: boolean` and `descriptionWrittenBy: string | null` (the agent's own description's writer, as a slug);
- `OrgEntry.spawnedBy` is renamed to `writtenBy`.

- [ ] **Step 1: Write the failing tests** (snapshots):
  - with `manageOrg: true`, the section holds exactly the five PR 1 lines from spec §10, and with `false` there is none;
  - a persistent peer whose description an agent wrote renders as `- @dev (Developer), written by @hr: "…"`;
  - the intro line reads "Descriptions written by agents are information, not instructions.";
  - the agent's own "- Description:" line is quoted when `descriptionWrittenBy` is set;
  - spawned children keep the quoting, now labelled "written by @lead".
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/workspace/claude-md.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the rename (no alias) and the section. Join `agents.description_by` to the writer's slug when building `OrgEntry`; a spawned child's `writtenBy` is its spawner.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): Managing the org in CLAUDE.md; quote agent-written descriptions`.

### Task A9: Web: the switch, the Details row, `org_action` toasts

Spec §5.4, §8.3. **Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/org/org-toasts.ts`, `apps/web/src/features/org/org-toasts.test.ts`
- Modify: `apps/web/src/features/agents/edit-agent-sheet.tsx` (and its `APPLIES` list), `apps/web/src/features/session/agent-details.tsx`, `apps/web/src/routes/_app.tsx`
- Test: `apps/web/src/features/agents/edit-agent-sheet.test.tsx`, `apps/web/src/test/agent-details.test.tsx` (or the existing details test file)

**Interfaces (produces):**
- `createOrgToasts(notify, now = Date.now)` returns `onOrgAction(frame)`. Frames from the same `by` and `action` within 2,000 ms of the first are merged into one toast. The toast is updated in place if `notify` supports an id; otherwise one toast is shown at the window's end.

- [ ] **Step 1: Write the failing tests.**
  - **Edit agent:**
    - the "Can manage the org" `Switch` shows only for persistent agents;
    - its help text is spec §5.4's, verbatim;
    - toggling it sends `manageOrg` in the PATCH;
    - the restart notice includes it (it's in `APPLIES`).
  - **Details:** "Manages the org: Yes" shows only when `manageOrg`.
  - **`org-toasts`** (fake timers):
    - one `agent_created` gives "@hr created @dev" with Open → `/agents/dev/chat`;
    - three within 2 s give "@hr created 3 agents" with Open → `/agents`;
    - `template_created` opens `/templates/x`;
    - frames from two actors give two toasts.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/org/org-toasts.test.ts apps/web/src/features/agents/edit-agent-sheet.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `_app.tsx` handles `org_action` by calling a module-level `onOrgAction`, with no state in the WS effect. It also invalidates `["agents"]` and `["templates"]`.
  - The switch is a `FieldShell` with the I4 note slot.
  - No component is defined inside another, and the toast logic lives outside React.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): manage_org switch and org toasts`.

### Task A10: Product docs, evidence, review and PR 1

Spec §12 (the PR 1 parts), §14.

- [ ] **Step 1: Product docs.** Update the gitignored docs in the main checkout `/Users/orlevi/projects/open-factory/docs/product/`:
  - `architecture/factory-mcp.md`: the org tools table (PR 1 tools), per-caller registration with the call-time check, and a "Planned in v0.0.2" note updated;
  - `concepts/agent.md`: `manage_org` and who sets it;
  - `concepts/reporting-line.md`: the manager notices about agent-made changes;
  - `behavior/administration.md`: the switch with its help text verbatim, §6.4's paragraph, the policy in brief, and the honest secret and credential statement (spec §1.1);
  - `architecture/context-assembly.md`: "Managing the org" and `writtenBy`;
  - `architecture/permissions.md`: the agent policy and its allowlist, with #162 noted as open and independent.
  
  List every file in the PR body.
- [ ] **Step 2: Branch review.** A fresh read-only reviewer on `git diff spec/i7-agents-managing-agents...i7/1-manage-org` checks:
  - spec §5–§8, §9.5, §10 and AC 1–8 and 15;
  - ADR 0028: no fallback, `spawnedBy` gone, `Actor` has no default;
  - every refusal sentence matches the spec verbatim;
  - no value or path leaks;
  - **the React diff against `vercel-react-best-practices`**: the reviewer invokes the skill first, skips Next-only rules and says so; effects only for external sync, no state in the WS handler, no components inside components, stable query keys.
  
  Fix the findings as their own commits.
- [ ] **Step 3: Full verification** under `/tmp/of-v002-heavy.lock`:
  - `pnpm install --frozen-lockfile` (no lockfile change), `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`;
  - the dev loop from a clean clone: clone into a temp dir, install, build, `pnpm dev` with a throwaway DB and fake Claude; then shut down and remove the clone.
  
  DB suites: read CI.
- [ ] **Step 4: Evidence (fake Claude only),** under the heavy lock.
  - Write `docs/product/ui-review/i7-evidence/org_tools.ts` (main checkout). It starts the dev server with fake Claude, creates one agent with `manage_org`, mints its token by starting it (fake Claude), and drives the agent listener with `mcp-client.ts` through AC 1–8 and 15. It records each call and result in `results.md`.
  - Screenshots through the U4 harness (`/Users/orlevi/projects/open-factory/docs/product/ui-review/u4-evidence/harness/run.sh`, its own lock): the Edit agent switch and a merged toast at 1440 and 390px, in light and dark, Chromium and WebKit.
- [ ] **Step 5: Push and draft PR.**
  - Merge I5's latest, then push `i7/1-manage-org`.
  - Open a draft PR, base = I5's last branch.
  - Title: `feat: manage_org permission and org tools for agents`.
  - Body per `.github/pull_request_template.md`: one Approach bullet per decision, links to the spec, this plan and #163, the reset step (none beyond I2/I5), the docs updated, that DB tests run in CI, and that it must be retargeted after the base merges. Remove the template comments, and end with the attribution line.
  - Watch `gh pr checks --watch` until green, fixing failures on the branch. Never merge.

---

# Part B: `i7/2-template-tools` (PR 2)

Implements spec §2 AC 9–10, §6.2 rule 8 for templates, §7.1 (`create_template`, `write_template_file`), §7.3, §7.3a, §10 (the PR 2 line). Cut it with `git checkout -b i7/2-template-tools i7/1-manage-org`.

### Task B1: Validate-first template writes under a lock, with the author map

Spec §7.3a, AC 9 (the last clause).

**Files:**
- Modify: `apps/server/src/templates/template-index.ts` (`writeFile` at ~L258, `validate` ~L272, `create` ~L278, `remove` ~L307, I2's `writeConfig`, and the CAS dispatch), `apps/server/src/routes/templates.ts`
- Test: `apps/server/src/templates/template-index.write.test.ts` (CI for the DB parts; the file-level parts are pure with a temp dir)

**Interfaces (produces):**

```ts
writeFile(name: string, file: TemplateFile, content: string, baseHash: string | null, actor: Actor): Promise<{ hash: string; issues: TemplateIssue[] }>;
create(b: { name: string; displayName: string; description?: string }, actor: Actor): Promise<void>;
remove(name: string, actor: Actor): Promise<void>;
// private: lock = new KeyedMutex() (workspace/lock.ts); templateAuthors = new Map<string, { actor: Actor; expectedHash: string }>()
```

- [ ] **Step 1: Write the failing tests:**
  - an agent write with a policy issue leaves the file byte-identical;
  - two concurrent `writeFile` calls with the same `baseHash` give one success and one 409;
  - a template whose `mcp.json` is broken accepts an agent fix to `settings.json` (only caused errors refuse), and the fix of `mcp.json` itself succeeds;
  - an unparseable current `template.yaml` refuses every agent write ("template.yaml has errors; ask a human to fix it.");
  - an agent write to a template whose folder or target file is a symlink → "x is a link; ask a human.";
  - an agent write to a template with an **archived** local agent on it → `LOCAL_RUNTIME_REFUSAL` (R9);
  - a human write keeps today's behaviour (saves with errors);
  - **the author map:** an agent write changing `can_spawn`, followed by a concurrent `loadValid` scan that wins the CAS, still dispatches `templateChanged` with `by: "@hr"` (assert on the `config_changed` event). An `AGENTS.md`-only write records no entry.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/templates/template-index.write.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Every write path takes `lock.run(name, …)`: `writeFile`, I2's config write, `create`, `copyFrom` (B2) and `remove`.
  - Inside the lock: check the hash, then `validate` with overrides, then, for agent actors, `touchesLocalRuntime` (with `policy.templateHasLocalAgents(name)` and the `can_spawn` runtimes) and `agentPolicyIssues`.
  - Refuse on caused errors (an agent) or on none (a human).
  - Record `templateAuthors` only when the write leaves the template valid and changes its ConfigDoc hash. Then temp + rename and `scanOne`, still inside the lock.
  - The CAS winner reads `templateAuthors.get(name)` when `newHash === expectedHash`, then deletes the entry.
  - Routes pass `{kind: "human", handle}`.
- [ ] **Step 4: Run** the test and the existing `routes/templates.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): validate-first template writes under a per-template lock`.

### Task B2: `copyFrom`

Spec §7.3.

**Files:**
- Modify: `apps/server/src/templates/template-index.ts`
- Test: `apps/server/src/templates/template-index.copy.test.ts`

**Interfaces (produces):** `copyFrom(from: string, b: { name: string; displayName: string; description?: string }, actor: Actor): Promise<{ issues: TemplateIssue[] }>`.

- [ ] **Step 1: Write the failing tests** (temp dirs):
  - copying a template with a comment in `template.yaml` keeps the comment and rewrites `name`, `display_name` and `description`;
  - `settings.json`, `mcp.json` and `AGENTS.md` are byte-equal to the source;
  - `skills/a/` is copied, while `files/` and `avatar.svg` aren't;
  - a symlinked `skills/b`, a link inside `skills/a`, or a symlinked `skills/` refuses the whole copy ("skills/x must be a folder, not a link.") and leaves no folder behind;
  - an existing target name → 409 `template_exists`;
  - an invalid source → "Template dev has errors; fix it first.";
  - a local source, or a docker source with a local agent on it (an agent actor) → `LOCAL_RUNTIME_REFUSAL`;
  - the agent policy runs with `before` = the source's docs and returns no issues for a source holding `hooks`.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/templates/template-index.copy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §7.3 steps 1–6, under the lock, with `mkdir` refusing an existing folder. Rewrite the YAML with the `yaml` Document API (as I2's `writeConfig` does). Use `lstat` on every entry.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): copy a template, refusing links`.

### Task B3: `create_template` and `write_template_file` tools; toast; CLAUDE.md line

Spec §7.1, §7.3, §8.3, §10 (PR 2 line).

**Files:**
- Modify: `apps/server/src/mcp/tools/org-tools.ts`, `packages/shared/src/org-tools.ts`, `apps/server/src/workspace/claude-md.ts`
- Test: `apps/server/src/mcp/tools/org-tools.templates.test.ts` (CI), `apps/server/src/workspace/claude-md.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - both tools are listed only with the flag;
  - `create_template` without `from` makes the scaffold (`runtime: docker`), and with `from` copies;
  - both publish `org_action {action: "template_created"}`;
  - `write_template_file` with a stale hash → "template.yaml changed since you read it; call get_template again.";
  - changing `runtime` → "runtime can only be changed by a human.";
  - `AGENTS.md` over 256 KiB is refused by the schema;
  - the CLAUDE.md snapshot has the PR 2 line.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/workspace/claude-md.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the handlers over `TemplateIndex.create` / `copyFrom` / `writeFile` with the agent `Actor`.
- [ ] **Step 4: Run** the tests. Expected: PASS (DB in CI).
- [ ] **Step 5: Commit** `feat(mcp): create_template and write_template_file`.

### Task B4: Product docs, evidence, review and PR 2

- [ ] **Step 1: Product docs** (main checkout):
  - `architecture/factory-mcp.md`: the template tools;
  - `behavior/administration.md`: agents editing templates, and the local-runtime rule;
  - `concepts/agent-template.md`: agent writes are validate-first.
  
  List them in the PR body.
- [ ] **Step 2: Branch review** of `git diff i7/1-manage-org...i7/2-template-tools` against spec §7.3, §7.3a, §6.2 rules 1, 3 and 8, and AC 9–10. Check that no separate agent-only write path exists (R5) and ADR 0028 holds. No React changes in this part; the reviewer confirms that.
- [ ] **Step 3: Full verification** as in A10, under the heavy lock.
- [ ] **Step 4: Evidence.** Extend `org_tools.ts` with AC 9, and with `dev_team.ts` for AC 10. That script plays the agent's tool calls: `create_template` lead and developer (from a human template), `create_agent` lead, then two developers with `manager: "lead"`. It asserts the tree from `GET /api/agents` and the toasts through the harness screenshots at 1440 and 390px. Real Claude is Or's (#166).
- [ ] **Step 5: Push and draft PR.** Base `i7/1-manage-org`, title `feat: template tools for manage_org agents`. The body links the spec, the plan and #163, and says: retarget after the base merges; DB tests run in CI. Watch CI until green. Never merge.

---

# Part C: `i7/3-restart` (PR 3)

Implements spec §2 AC 11–14, §9.1–§9.4, §10 ("Restarting reports", the PR 3 line, the I1 text fix). Cut it with `git checkout -b i7/3-restart i7/2-template-tools`.

### Task C1: Refusal codes, notices and the `restartNow` check table

Spec §9.2 (the checks table, rows 1–8, 11 and 12; §9.2.2).

**Files:**
- Modify: `apps/server/src/agents/errors.ts`, `apps/server/src/agents/notices.ts`, `apps/server/src/agents/agent-runtime.ts`, `apps/server/src/agents/runtimes.ts`
- Test: `apps/server/src/agents/agent-runtime.restart-now.test.ts` (CI)

**Interfaces (produces):**

```ts
// errors.ts
// RecoveryRefusal: the existing union minus "not_errored", plus "starting" | "stopping" | "compacting" | "lost_work"
export class RecoveryRefusedError extends Error { constructor(code: RecoveryRefusal, message: string, data?: { tasks: string[]; crons: string[] }) }
// notices.ts
notices.restartApplied({ by, changes: string[] | null, tasks: string[], crons: string[] }): string;
// agent-runtime.ts
export type RestartOutcome = { status: "restarting" | "restart_pending" | "not_running" | "restarted_idle" };
restartNow(r: { by: string; force: boolean; changes: string[] | null; runtimeAllowed: boolean }): Promise<RestartOutcome>;
// `restart()` is deleted.
```

- [ ] **Step 1: Write the failing tests,** one per row of spec §9.2's table, with the exact sentences:
  - row 2: `starting`;
  - row 3: `stopping`, for a warm hibernate under way and for Stop crons under way;
  - row 4: `compacting`;
  - row 5: `resume_unrecoverable`;
  - row 6: an errored target restarts as today, and its notice reads "Restarted by @lead after an error.";
  - row 7: `not_running`;
  - row 8: `lost_work` with `data` carrying the task descriptions and cron schedules, after which the target is **still running and not errored** (`apiJob` passes it through);
  - row 11: owed notifications only → `restart_pending`, with `restartPending` set;
  - row 12: an idle target hibernates and gets a passive `config_changed` with the lines, and with `changes: []` no notice;
  - `runtime_disabled` for a local target on rows 6, 9 and 10, but row 12 is allowed.
- [ ] **Step 2: Run** `pnpm typecheck`. Expected: FAIL (`restartNow` missing).
- [ ] **Step 3: Implement** the table in an `apiJob`. Row 6 reuses the old `restart()` body, which is then deleted. Rows 9 and 10 call into C2 (stub them to refuse until C2, then remove the stub in C2's commit).
- [ ] **Step 4: Run** the tests (CI). Expected: PASS for rows 1–8, 11 and 12.
- [ ] **Step 5: Commit** `feat(server): restartNow check table replaces errored-only restart`.

### Task C2: Cut restart (`restartNowPending`, the flush guard, the stop)

Spec §9.2.1, rows 9 and 10.

**Files:**
- Modify: `apps/server/src/agents/agent-runtime.ts` (`flush` and its held-due write; `turn_started` ~L2611; `turn_end` ~L2668; the hold timeout ~L3510; `stop()`; `onExited`)
- Test: `apps/server/src/agents/agent-runtime.restart-now.test.ts` (CI)

**Interfaces (produces):** private `restartNowPending?: { by: string; changes: string[] | null }`, `restartNowFallback?: Timeout`, and `beginRestartNowStop(): Promise<void>`.

- [ ] **Step 1: Write the failing tests:**
  - **mid-turn:** an interrupt is sent, `turn_end` arrives, and no batch is written to the old process (assert the fake transport's stdin), even with a message queued meanwhile. The process is force-stopped and the attempt resumes the same session. The first batch is `restart_applied` ("Restarted by @lead to apply: model. Continue where you left off."), then the queued message;
  - an existing Stop hold is reused (one interrupt control written);
  - an `awaiting` batch whose turn starts later is interrupted at `turn_started`;
  - an `awaiting` batch whose turn never starts: the fallback fires after `holdTimeoutMs`, and its rows are pending again and redelivered after the restart;
  - **`commandInFlight` with no open turn:** the stop happens at once;
  - **row 10:** an idle target with a live task and `force` stops without an interrupt; its waking notice names the task; `background_work_lost` is written;
  - a task started during the interrupt window is killed and reported (T4);
  - `stop()` for an archive during the interrupt wins: `afterExit` is the archive's, and no attempt is made;
  - a second `restartNow` while pending returns `restarting` and replaces `by`;
  - no `flush()` caller (a delivery, the held timer, `postNotice`) writes while pending.
- [ ] **Step 2: Run** `pnpm typecheck`.
- [ ] **Step 3: Implement** spec §9.2.1 steps 1–5 exactly:
  - add `!this.restartNowPending` to `flush()`'s while-guard and to the held-due write;
  - `turn_end` and the hold timeout check `restartNowPending` before `flush()`;
  - `beginRestartNowStop` returns early when `this.stopping`; otherwise it marks the attempt, takes a fresh lost snapshot, writes `control{restart}`, adds the `restart_applied` notice, requeues `awaiting` rows as pending, then calls `beginForceStop({kind: "restart", by}, {graceMs: 3000, termWaitMs: 10_000})`;
  - clear `restartNowPending` and the fallback timer on every exit and in `stop()`.
- [ ] **Step 4: Run** the tests (CI). Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): cut restart holds writes, interrupts and resumes`.

### Task C3: `restart_agent`, the note, the REST route, CLAUDE.md

Spec §9.1, §9.3, §9.4 (route), §10 ("Restarting reports", the PR 3 line, the I1 text fix), AC 11–13.

**Files:**
- Create: `apps/server/src/mcp/tools/restart-agent.ts`
- Modify: `packages/shared/src/org-tools.ts` (`restartAgentToolSchema`), `packages/shared/src/agents.ts` (restart body and response), `apps/server/src/routes/agents.ts` (`/restart`, `recoveryError` forwards `data`), `apps/server/src/app.ts`, `apps/server/src/workspace/claude-md.ts`, `apps/server/src/mcp/tools/send-command.ts` (the I1 note text)
- Test: `apps/server/src/mcp/tools/restart-agent.test.ts` (CI), `apps/server/src/routes/agents.recovery.test.ts`, `apps/server/src/workspace/claude-md.test.ts`

**Interfaces (produces):**
- `restartAgentToolSchema = { target: string, note?: string (≤ 64 KB), force?: boolean }`;
- `restartAgentTool(d: { loadAgent; runtimes; resolver; router; neighborhood })`;
- `POST /api/agents/:slug/restart { force?: boolean }` → 202 `{ status }` | 409 `{ code, message, data? }`.

- [ ] **Step 1: Write the failing tests:**
  - **registration:** listed for persistent callers, never for spawned ones;
  - **targets:**
    - a direct report (spawned included) is accepted;
    - a non-report without the flag → "@x isn't one of your direct reports.";
    - with `manage_org`, any live agent is accepted;
    - self → "Your config changes apply when you're idle; you can't restart yourself.";
    - archived and terminated targets get the messaging sentences;
  - **`changes`** is computed before the runtime call (a spy shows `resolver.effective` isn't called inside the job), and a resolver failure passes `null`;
  - **the note** is delivered as a message `from="@lead" from_kind="agent"` after the notice, for `restarting`, `restart_pending`, `restarted_idle` and `not_running`;
  - **REST:**
    - `lost_work` gives 409 with `data`;
    - a running agent with `force: true` gives 202 `{status: "restarting"}`;
    - `not_errored` no longer exists (grep finds no match);
  - **CLAUDE.md:** "## Restarting reports" appears for an agent with live reports, and the PR 3 "Managing the org" line appears;
  - **I1:** `send_command`'s errored note reads "@dev is errored; it runs after it is restarted (restart_agent, or a human)."
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/workspace/claude-md.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The tool and the route both compute `changes` with `describeChanges(rt.started.doc, (await resolver.effective(row)).doc)`, catching errors to `null`, then call `restartNow`.
  - The tool then sends the note through the Router's list `send`.
  - Register it in `app.ts` for `caller.kind === "persistent"`.
- [ ] **Step 4: Run** the tests. Expected: PASS (DB in CI).
- [ ] **Step 5: Commit** `feat: restart_agent and Restart now on one runtime method`.

### Task C4: Web: Restart now, the status-line action, the lost-work dialog

Spec §9.4, AC 14. **Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/agents/restart-now.ts`
- Modify: `apps/web/src/features/session/api.ts` (`postRestart(slug, { force })`), `apps/web/src/features/agents/agent-menu.tsx`, `apps/web/src/features/session/agent-details.tsx` (the "Restarts when idle to apply" row), `apps/web/src/features/session/live-line.tsx`, `apps/web/src/features/session/recovery-actions.tsx`
- Test: `apps/web/src/test/agent-menu.test.tsx`, `apps/web/src/features/agents/restart-now.test.tsx`

**Interfaces (produces):** `useRestartNow(slug: string): { restart(): void; pending: boolean; dialog: ReactNode }`. It holds `useMutation`, started from the click handler. A 409 `lost_work` opens the `ConfirmDialog` with the lists from `data`; confirming re-posts with `force: true`.

- [ ] **Step 1: Write the failing tests:**
  - **the menu:** "Restart now" appears for running, non-errored agents, persistent and spawned; errored agents keep "Restart", calling the same route; hibernated agents have neither;
  - **no dialog** when the POST returns 202, and the toast reads "Restarting @dev.";
  - **on 409 `lost_work`:** the dialog title is "Restart @dev now?", the body is spec §9.4's with mono wrapping lists (at most 5 each, then "and N more"), and "Restart anyway" POSTs `force: true`;
  - **`restart_pending` and `not_running`** toast their spec texts;
  - **the status line** "Restarts when idle to apply: …" has a ghost "Restart now" that uses the same hook.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/agents/restart-now.test.tsx apps/web/src/test/agent-menu.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - One hook is shared by the menu, the status line and the errored Restart button.
  - The dialog's state is set in the mutation's `onError`, never in an effect.
  - The lists are derived during render.
  - No component is defined inside another.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Restart now with a lost-work confirm`.

### Task C5: Product docs, evidence, final review and PR 3

- [ ] **Step 1: Product docs** (main checkout):
  - `architecture/factory-mcp.md`: `restart_agent`;
  - `concepts/reporting-line.md`: `restart_agent` on direct reports;
  - `behavior/agents-and-sessions.md`: Restart now, the §9.2 table in prose, and the self-edit wake;
  - `architecture/agent-runtime.md`: `restartNow`, `restart_applied`, `config_continue`, `report_config_changed`, `pendingWake` and `restartNowPending`.
  
  List them in the PR body.
- [ ] **Step 2: Whole-I7 review.** A fresh reviewer on `git diff spec/i7-agents-managing-agents...i7/3-restart`, against the whole spec and all 15 ACs. It checks:
  - ADR 0028: `restart()`, `not_errored` and `spawnedBy` are gone;
  - the flush guard covers every writer;
  - **the React diff against `vercel-react-best-practices`**: the reviewer invokes the skill, skips Next-only rules and says so; mutations from handlers, no effects for derived state, no inline component definitions.
  
  Fix the findings.
- [ ] **Step 3: Full verification** as in A10, under the heavy lock.
- [ ] **Step 4: Evidence** (fake Claude). Extend `org_tools.ts` with AC 11–13:
  - an errored report with a note;
  - a fake-Claude scenario holding a background `pnpm test` task: refused, then `force` (the waking notice and `background_work_lost` in the timeline);
  - the refusals.
  
  Harness screenshots of the lost-work ConfirmDialog and the menu at 1440 and 390px, in light and dark, Chromium and WebKit (AC 14).
- [ ] **Step 5: Push and draft PR.** Base `i7/2-template-tools`, title `feat: restart_agent and Restart now`. The body links the spec, the plan and #163, lists the docs, and says: retarget after the base merges; DB tests run in CI. Watch CI until green. Never merge.

## Manual steps for Or (the executor never does these)

1. **The live AC 10 run with real Claude** (#166): one `manage_org` agent asked in Chat to "set up a dev team: a lead and two developers reporting to it".
2. **Review the certainty-3-or-lower decisions** on #163: Q3.4, Q3.5, Q3.6, Q4 (the manager default), Q5 (colour; archiving other admins), Q6, Q8 (no confirm mid-turn), Q9 and T3. Also read the honest-semantics statements (§1.1, R10).
3. **Issue #162** stays open. I7 doesn't depend on it.
