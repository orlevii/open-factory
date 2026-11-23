# I2 Agent config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agents.config` a per-agent overlay that is merged with the current template at every start. Delete snapshots and Re-sync. Add per-agent model, effort and identity colour, and a Configuration form plus a Raw JSON editor for templates and agents.

**Architecture:** One pure merge function and one change describer live in `packages/shared`, used by both server and web. On the server, a `ConfigResolver` computes the effective config at each start. `ConfigChanges` is the single path that turns a template change or an overlay save into an event, a passive notice and a restart-when-idle. The template index detects changes by compare-and-set on a hash of the last valid parse. The web gets one `ConfigForm` (under `features/config/`), hosted by a new `/agents/$slug_/config` page and by a new first tab in the template editor.

**Tech Stack:** TypeScript pnpm monorepo, Fastify, Postgres with Drizzle, Zod in `packages/shared`, React + Vite + TanStack Router/Query, CodeMirror 6 (the existing wrapper), Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-23-i2-agent-config-design.md` (commit a8b4ea0). Decision log: issue #142. Read the spec section each task cites before starting the task. The spec is the authority for copy and behaviour.

## Global Constraints

- **Pre-release, ADR 0028.** No backward compatibility, no shims, no data migration. Schema changes ship only as the generated Drizzle migration (`pnpm db:generate`). **Reset step**, stated in every PR body: drop the database and recreate agents. Agents created before I2 fail the overlay schema, and their copied template skills collide with the new links.
- **No real Claude.** Never run real Claude. Never read `~/.open-factory-spike`. Tests and evidence use fake Claude only.
- **Database tests run only in CI.** Server tests that need Postgres (`createTestDb` in `apps/server/src/test/helpers.ts`) run in CI only, because the local Postgres role is unavailable. Locally, run the pure tests and the web tests. Push and read CI for the DB suites.
- **React.** Every task that touches `apps/web`: the implementer and the reviewer invoke `vercel-react-best-practices` and follow it. Next-only rules don't apply (this is React + Vite + TanStack).
- **I4 form rules.** Use the reserved `FieldNote` line, `useFieldErrors`, `FormOutcome` and `field-stack`. Client field and form messages are at most 40 characters, held in the exported constants (`MSG` / `FIELD_MSG` / `FORM_MSG`), and the length tests cover them.
- **Secret safety.** No secret value in files, the UI, events, notices or logs. Change lines never print env values, header values, MCP command, args or URL, or unknown-key values (spec §7.2).
- **Model charset:** `^[A-Za-z0-9._\[\]:-]{1,100}$` and not starting with `-`.
- **Overlay limits** (also applied to templates on these keys):
  - overlay JSON ≤ 256 KB;
  - list item ≤ 1,000 characters;
  - env name `^[A-Za-z_][A-Za-z0-9_]*$`;
  - value ≤ 32 KB;
  - ≤ 200 items per list;
  - ≤ 50 MCP servers.
- **`FACTORY_ENV_NAMES`:** `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, plus the prefix `OPEN_FACTORY_`.
- **I5 owns the `enabledPlugins` rule (S1).** I2 keeps it a warning: it is ignored and derived from `plugins`. Only `permissions.defaultMode` becomes an error.
- **I7 inputs (spec §19).** These are recorded, not built:
  - the `agent` caller policy for `validateEffective`: deny rules add-only, and a default-deny key list (`hooks`, `apiKeyHelper`, `additionalDirectories`, `statusLine`-style commands; unknown keys refused until allowed);
  - `requestRestart({ wake })` for a waking self-restart notice.
- **Heavy jobs.** At most one evidence pass or full suite at a time on this machine, under `/tmp/of-v002-heavy.lock`. Take it with `mkdir /tmp/of-v002-heavy.lock` (wait and retry while it exists; write your pid inside) and remove it when done. Never write sleep loops on other agents' processes.
- **Git.** Merge, never rebase. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Branches

All work happens in the worktree `/Users/orlevi/projects/open-factory/.worktrees/spec-i2`.

- **Part A**, `i2/1-overlay`: cut from `spec/i2-agent-config`. Before cutting, merge the latest I1 branch on origin into the spec branch (`i1/4-send-command` if it exists, else `spec/i1-chat-and-session`).
- **Part B**, `i2/2-colour`: cut from `i2/1-overlay`.
- **Part C**, `i2/3-config-form`: cut from `i2/2-colour`.

Before pushing each part, merge in the branch below it (and I1's latest).

```bash
cd /Users/orlevi/projects/open-factory/.worktrees/spec-i2
git fetch origin
git merge --no-edit origin/i1/4-send-command 2>/dev/null || git merge --no-edit origin/spec/i1-chat-and-session
git checkout -b i2/1-overlay
```

Commands used throughout:
- one test file: `pnpm vitest run <path>`;
- the whole suite: `pnpm test` (heavy; take the lock);
- `pnpm typecheck`, `pnpm lint`, `pnpm build`;
- migrations: `pnpm db:generate`.

## File map

**Shared (`packages/shared/src/`)**

| File | Purpose |
|---|---|
| `config.ts` (new) | `templateYamlShape`, `overlayTemplateSchema`, `agentOverlaySchema`, `AgentOverlay`, `ConfigDoc`, limits, `FACTORY_ENV_NAMES` re-export |
| `config-merge.ts` (new) | `mergeConfig`, `canonicalJson`, `overlayVersion` |
| `config-changes.ts` (new) | `describeChanges`, `summarizeChanges` |
| `models.ts` (new) | `MODEL_ALIASES`, `MODEL_IDS`, `modelSchema` |
| `avatar.ts` (new, Part B) | `AVATAR_HUES` |
| `templates.ts` (modify) | Uses `templateYamlShape` and the new model schema; the agent config API schemas |
| `agents.ts` (modify) | `AgentSummary`: `color`, `restartChanges`, no `grantsOverridden`; `PatchAgentBody`: `color`, no `projects: null`; resync schema deleted; reset-persona response |
| `events.ts` (modify) | `config_changed` event; fix codes `template` and `config` |

**DB (`packages/db/src/schema/`)**

| File | Purpose |
|---|---|
| `agents.ts` | `config` typed `AgentOverlay` with default `{}`; `grants_overridden` dropped; `color` (Part B) |
| `factory.ts` | `templates.last_valid`, `last_valid_hash`, `valid` |

**Server (`apps/server/src/`)**

| File | Purpose |
|---|---|
| `templates/validate.ts` | Split out `validateEffective(doc, ctx, policy)`; new rules |
| `templates/template-index.ts` | `loadValid` returns `tplYaml`; CAS detection and `onChange` dispatch; delete refusal; `readConfig`/`writeConfig` (Part C) |
| `agents/config-resolver.ts` (new) | `ConfigResolver.effective(agent)` |
| `agents/config-changes.ts` (new) | `ConfigChanges` (template change, overlay save) |
| `agents/start.ts` | Uses the resolver; `deriveInheritance` takes the stricter config; `nextImage` check |
| `agents/runtime-spec.ts` | `FACTORY_ENV_NAMES` |
| `agents/agent-runtime.ts` | `started`, `pendingChanges`, `requestRestart({changes, wake})`, passive `config_changed`, the batch hold |
| `agents/runtimes.ts` | `requestRestart(id, opts)`, `recordConfigNotice`, `nextImage`, `refOf` |
| `agents/event-store.ts` | `createNotice` merge mode |
| `agents/notices.ts` | `config_changed` |
| `agents/agent-service.ts` | Resync and `grantsOverridden` removed; `getConfig`/`putConfig`; `resetPersona`; colour PATCH (Part B) |
| `agents/errors.ts`, `workspace/safe-fs.ts` | Fix codes |
| `workspace/workspace.ts`, `files.ts`, `paths.ts`, `links.ts`, `mounts.ts`, `plugins.ts`, `state-migration.ts` (deleted) | Prepare from the effective config; live skill links; plugin install at start; mount rule |
| `secrets/secret-service.ts` | `usedBy` reads effective secrets |
| `spawning/spawn-service.ts`, `may-spawn.ts`, `app.ts` | Read `started` / effective |
| `routes/agents.ts`, `routes/templates.ts`, `routes/host-skills.ts` (new, Part C) | API |

**Web (`apps/web/src/`)**

| File | Purpose |
|---|---|
| `features/agents/agent-menu.tsx`, `lifecycle.ts`, `api.ts`, `project-grant-picker.tsx`, `features/session/timeline-row.tsx`, `features/settings/factory-section.tsx` | Removals; Reset persona; Configure |
| `components/agent-avatar.tsx`, `lib/factory-bot.ts`, `styles.css`, `features/agents/colour-field.tsx` (new), `edit-agent-sheet.tsx` | Part B |
| `features/config/*` (new), `routes/_app/agents.$slug_.config.tsx` (new), `features/templates/template-editor.tsx` | Part C |

---

# Part A: `i2/1-overlay` (PR 1)

Covers spec §4–§9 and §13, except `color`.

### Task A1: Overlay schema, model schema and factory env names (shared)

Implements spec §5.1 and §10 (schemas only).

**Files:**
- Create: `packages/shared/src/config.ts`, `packages/shared/src/models.ts`, `packages/shared/src/config.test.ts`, `packages/shared/src/models.test.ts`
- Modify: `packages/shared/src/templates.ts` (extract `templateYamlShape`, use `modelSchema`), `packages/shared/src/index.ts` (exports)

**Interfaces:**
- Produces:
  - `templateYamlShape` (a Zod raw shape, no defaults);
  - `overlayTemplateSchema`;
  - `agentOverlaySchema`;
  - `type AgentOverlay = z.infer<typeof agentOverlaySchema>`;
  - `type ConfigDoc = { template: Record<string, unknown>; settings: Record<string, unknown>; mcp: { mcpServers: Record<string, unknown> } }`;
  - `OVERLAY_LIMITS = { bytes: 256*1024, item: 1000, value: 32*1024, listItems: 200, mcpServers: 50 }`;
  - `ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/`;
  - `FACTORY_ENV_NAMES: readonly string[]` and `isFactoryEnvName(name): boolean` (true for the listed names and any `OPEN_FACTORY_*`);
  - `MODEL_ALIASES`, `MODEL_IDS`, `modelSchema`.

- [ ] **Step 1: Write failing tests** in `config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { agentOverlaySchema, isFactoryEnvName } from "./config.ts";
import { modelSchema } from "./models.ts";

describe("agentOverlaySchema", () => {
  it("accepts {} and keeps it {} (no defaults)", () => {
    expect(agentOverlaySchema.parse({})).toEqual({});
    expect(agentOverlaySchema.parse({ template: {} })).toEqual({ template: {} });
  });
  it.each(["model", "effort", "warm_window_minutes", "max_live_spawns", "skills", "plugins", "can_spawn", "secrets"])(
    "accepts template.%s", (k) => {
      const v = { model: "opus", effort: "high", warm_window_minutes: 30, max_live_spawns: 2,
        skills: ["release"], plugins: ["x@y"], can_spawn: ["dev"], secrets: ["GH_TOKEN"] } as Record<string, unknown>;
      expect(agentOverlaySchema.safeParse({ template: { [k]: v[k] } }).success).toBe(true);
    });
  it.each(["name", "display_name", "description", "runtime", "image", "permission_mode", "projects", "local_skills", "bogus"])(
    "refuses template.%s", (k) => {
      expect(agentOverlaySchema.safeParse({ template: { [k]: "x" } }).success).toBe(false);
    });
  it("refuses unknown top-level keys and extra mcp keys", () => {
    expect(agentOverlaySchema.safeParse({ other: {} }).success).toBe(false);
    expect(agentOverlaySchema.safeParse({ mcp: { mcpServers: {}, x: 1 } }).success).toBe(false);
  });
  it("refuses extraKnownMarketplaces and permissions.defaultMode in settings", () => {
    expect(agentOverlaySchema.safeParse({ settings: { extraKnownMarketplaces: {} } }).success).toBe(false);
    expect(agentOverlaySchema.safeParse({ settings: { permissions: { defaultMode: "auto" } } }).success).toBe(false);
  });
  it("refuses factory env names in settings.env and secrets", () => {
    expect(agentOverlaySchema.safeParse({ settings: { env: { ANTHROPIC_API_KEY: "x" } } }).success).toBe(false);
    expect(agentOverlaySchema.safeParse({ template: { secrets: ["OPEN_FACTORY_X"] } }).success).toBe(false);
  });
  it("refuses an MCP server named factory and more than 50 servers", () => {
    expect(agentOverlaySchema.safeParse({ mcp: { mcpServers: { factory: {} } } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`s${i}`, { command: "x" }]));
    expect(agentOverlaySchema.safeParse({ mcp: { mcpServers: many } }).success).toBe(false);
  });
  it("isFactoryEnvName", () => {
    expect(isFactoryEnvName("CLAUDE_CONFIG_DIR")).toBe(true);
    expect(isFactoryEnvName("OPEN_FACTORY_URL")).toBe(true);
    expect(isFactoryEnvName("GH_TOKEN")).toBe(false);
  });
});

describe("modelSchema", () => {
  it.each(["opus", "fable", "claude-sonnet-5-5[1m]", "claude-opus-5-5"])("accepts %s", (m) =>
    expect(modelSchema.safeParse(m).success).toBe(true));
  it.each(["-x", "opus model", "a;b", "", "x".repeat(101)])("refuses %j", (m) =>
    expect(modelSchema.safeParse(m).success).toBe(false));
});
```

- [ ] **Step 2: Run and confirm they fail.** `pnpm vitest run packages/shared/src/config.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement.**
  - In `templates.ts`, move the field schemas of `templateYamlSchema` into `export const templateYamlShape = { model: modelSchema.optional(), effort: z.enum(EFFORTS).optional(), skills: z.array(hostSkillSchema).max(200), … }` with **no** `.default()`.
  - Rebuild `templateYamlSchema` as `z.strictObject({ ...templateYamlShape, description: templateYamlShape.description.default(""), runtime: ….default("docker"), … }).transform(...)`. Keep today's defaults and transform byte-for-byte.
  - `overlayTemplateSchema = z.strictObject(pick(templateYamlShape, [the 8 keys]))`, with every field `.optional()`.
  - `settings` is `z.record(z.string(), z.unknown())` with a `superRefine` that:
    - refuses `extraKnownMarketplaces` and `permissions.defaultMode`;
    - refuses `settings.env` keys that fail `ENV_NAME` or pass `isFactoryEnvName`;
    - refuses values over the limits.
  - `secrets` items refine on `isFactoryEnvName`.
  - `mcp = z.strictObject({ mcpServers: z.record(...).refine(no "factory", ≤ 50) })`.
  - In `agentOverlaySchema`, `superRefine` on `JSON.stringify(v).length ≤ 256 KB`.
  - `models.ts`: `modelSchema = z.string().regex(/^[A-Za-z0-9._\[\]:-]{1,100}$/).refine((v) => !v.startsWith("-"))`, with constant messages ≤ 40 characters (e.g. `"Use letters, digits and . _ : - [ ]"`); `MODEL_ALIASES = ["fable","opus","sonnet","haiku"] as const`; `MODEL_IDS = ["claude-fable-5-1","claude-opus-5-5","claude-sonnet-5-5","claude-haiku-5-5"] as const`.
- [ ] **Step 4: Run.** `pnpm vitest run packages/shared/src` → PASS, including the existing `templates.test.ts`. Defaults are unchanged.
- [ ] **Step 5: Commit.** `git commit -m "feat(shared): agent overlay and model schemas"`

### Task A2: `mergeConfig` with one test per rule (shared)

Implements spec §5.2.

**Files:** Create `packages/shared/src/config-merge.ts` and `config-merge.test.ts`.

**Interfaces:**
- Produces:
  - `mergeConfig(base: ConfigDoc, overlay: AgentOverlay): ConfigDoc`;
  - `canonicalJson(v: unknown): string` (sorted keys);
  - `overlayVersion(o: AgentOverlay): string`: the sha256 hex of `canonicalJson`, from a synchronous **pure JS** sha256 in `packages/shared/src/sha256.ts` (~40 lines). Shared code imports no `node:*` module; `node:crypto` appears only in the test that checks the pure implementation against it. The web needs `overlayVersion` only for the client-side dirty and rebase checks; the server returns `version` and the web sends it back unchanged as `baseVersion`. If C2 doesn't use it on the web, keep it server-only and say so in the commit;
  - `emptyDoc(): ConfigDoc`.

- [ ] **Step 1: Write the failing tests.** One `it` per spec §5.2 rule:

```ts
const base: ConfigDoc = {
  template: { name: "dev", model: "sonnet", effort: "medium", warm_window_minutes: 70, max_live_spawns: 5,
    skills: ["tdd"], plugins: ["a@m"], can_spawn: ["rev"], secrets: ["GH_TOKEN"] },
  settings: { permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] }, env: { A: "1" },
    autoMode: { environment: ["ci"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }] }, x: { y: 1 } },
  mcp: { mcpServers: { gh: { command: "npx", args: ["gh"] } } },
};
it.each([["model","opus"],["effort","high"],["warm_window_minutes",30],["max_live_spawns",1]])("replaces %s", (k, v) =>
  expect(mergeConfig(base, { template: { [k]: v } }).template[k]).toEqual(v));
it.each(["skills","plugins","can_spawn","secrets"])("unions %s keeping order, dropping duplicates", (k) => {
  const own = (base.template[k] as string[])[0];
  expect(mergeConfig(base, { template: { [k]: [own, "new"] } }).template[k]).toEqual([own, "new"]);
});
it("unions permissions.allow/deny and autoMode lists", …);
it("unions an unknown nested array (keeps the template hook)", () => {
  const m = mergeConfig(base, { settings: { hooks: { PreToolUse: [{ matcher: "Edit", hooks: [] }] } } });
  expect((m.settings.hooks as any).PreToolUse).toHaveLength(2);
});
it("replaces an env value by name and adds a new name", …);
it("replaces an MCP server whole (stdio → http leaves no command) and adds one", () => {
  const m = mergeConfig(base, { mcp: { mcpServers: { gh: { type: "http", url: "https://x" }, pg: { command: "pg" } } } });
  expect(m.mcp.mcpServers.gh).toEqual({ type: "http", url: "https://x" });
  expect(Object.keys(m.mcp.mcpServers)).toEqual(["gh", "pg"]);
});
it("an overlay deny rule added then removed gives the template list back", …);
it("deep-merges unknown settings keys", () => expect(mergeConfig(base, { settings: { x: { z: 2 } } }).settings.x).toEqual({ y: 1, z: 2 }));
it("{} gives exactly the base", () => expect(mergeConfig(base, {})).toEqual(base));
it("is idempotent", () => { const o = { template: { skills: ["r"] }, settings: { env: { B: "2" } } }; expect(mergeConfig(mergeConfig(base, o), o)).toEqual(mergeConfig(base, o)); });
it("never mutates its inputs", …);
it("overlayVersion ignores key order", () => expect(overlayVersion({ template: { model: "a", effort: "low" } })).toBe(overlayVersion({ template: { effort: "low", model: "a" } })));
```

Write out every `…` with real assertions, in the same style.

- [ ] **Step 2: Run.** `pnpm vitest run packages/shared/src/config-merge.test.ts` → FAIL.
- [ ] **Step 3: Implement.**

```ts
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function deepMerge(a: unknown, b: unknown): unknown {
  if (b === undefined) return structuredClone(a);
  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set(a.map(canonicalJson));
    return [...structuredClone(a), ...structuredClone(b).filter((x) => !seen.has(canonicalJson(x)) && seen.add(canonicalJson(x)))];
  }
  if (isObj(a) && isObj(b)) {
    const out: Record<string, unknown> = structuredClone(a);
    for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : structuredClone(v);
    return out;
  }
  return structuredClone(b);
}
export function mergeConfig(base: ConfigDoc, o: AgentOverlay): ConfigDoc {
  return {
    template: deepMerge(base.template, o.template) as Record<string, unknown>,
    settings: deepMerge(base.settings, o.settings) as Record<string, unknown>,
    mcp: { mcpServers: { ...structuredClone(base.mcp.mcpServers), ...structuredClone(o.mcp?.mcpServers ?? {}) } },
  };
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `feat(shared): config merge with one test per rule`

### Task A3: `describeChanges` and `summarizeChanges` (shared)

Implements spec §7.2. Must be secret-safe.

**Files:** Create `packages/shared/src/config-changes.ts` and `config-changes.test.ts`.

**Interfaces:**
- Produces:
  - `describeChanges(a: ConfigDoc, b: ConfigDoc): string[]` (sorted, deterministic);
  - `summarizeChanges(lines: string[]): string` (e.g. `"model, 1 skill, 2 rules and 3 more"`);
  - `CONFIG_NOTICE_HEADER = "Your configuration changed:"`;
  - `renderConfigNotice(lines): string`;
  - `parseConfigNotice(body): string[]`.

- [ ] **Step 1: Failing tests.**
  - `model: sonnet → opus` and `effort: …`.
  - `warm window: 70 → 30 min` and `max live spawns: …`.
  - Added/removed skill, plugin, secret, allow rule (value in backticks), deny rule, trust note; `can spawn: added x`.
  - `env LOG_LEVEL changed` / `added` / `removed` with **no value**. The assertion: no line contains `"debug"` when `env.LOG_LEVEL` goes `"info"→"debug"`.
  - `MCP server github added` / `changed` / `removed`, with no URL, args or header text. Assert that no line contains `https`, `--token` or `Bearer`.
  - `settings key hooks changed`.
  - `image: a → b`, `permission mode: auto → bypass`, `template skills off`, `added template skill x`.
  - A change in only `name`, `display_name`, `description`, `projects` or `runtime` gives `[]`.
  - Identical docs give `[]`.
  - Output is sorted and stable.
  - `summarizeChanges` on 7 kinds gives `"…and 4 more"`.
  - `parseConfigNotice(renderConfigNotice(x))` equals `x`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - Compare scalars by key from a fixed table: `model`, `effort`, `warm_window_minutes` → "warm window", `max_live_spawns` → "max live spawns", `image`, `permission_mode` → "permission mode", `local_skills` → "template skills on/off".
  - List keys use set difference with these labels: `skills`→"skill", `plugins`→"plugin", `secrets`→"secret", `can_spawn`→"can spawn", `local_skill_names`→"template skill", `settings.permissions.allow`→"allow rule", `settings.permissions.deny`→"deny rule", `settings.autoMode.environment`→"trust note" (no value), `soft_deny`/`hard_deny`→"deny rule".
  - `settings.env` and `mcp.mcpServers` are compared by name, with `canonicalJson` used for "changed".
  - Every other top-level settings key (minus `permissions`, `autoMode` and `env`, which are handled above) gives `settings key <k> changed` when its `canonicalJson` differs.
  - Ignored: `name`, `display_name`, `description`, `projects`, `runtime`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `feat(shared): secret-safe config change lines`

### Task A4: DB schema and generated migration

Implements spec §13, except `color`.

**Files:**
- Modify: `packages/db/src/schema/agents.ts`
  - `config: jsonb("config").$type<AgentOverlay>().notNull().default({})`;
  - delete `grantsOverridden`.
- Modify: `packages/db/src/schema/factory.ts`
  - `templates`: add `lastValid: jsonb("last_valid").$type<ConfigDoc>()`, `lastValidHash: text("last_valid_hash")`, `valid: boolean("valid").notNull().default(false)`.
- Generated: `packages/db/migrations/0015_*.sql` and `meta`.

- [ ] **Step 1:** Edit the schema.
- [ ] **Step 2:** Run `pnpm db:generate`. Inspect the SQL: it must contain only `ALTER` statements (default, drop column, add columns) and **no** `UPDATE` (ADR 0028).
- [ ] **Step 3:** Run `pnpm typecheck`. Expect errors at every `row.config.*` and `grantsOverridden` use. Leave them for A5–A12, but list them in the commit body so the later tasks can tick them off.
- [ ] **Step 4: Commit.** `feat(db): agents.config is an overlay; templates keep the last valid parse`

(Typecheck stays red until A12. Every later Part A task must leave the touched files type-correct.)

### Task A5: `validateEffective` and the new template rules (server)

Implements spec §5.3.

**Files:**
- Modify: `apps/server/src/templates/validate.ts`, `validate.test.ts`
- Modify: `apps/server/src/agents/runtime-spec.ts` (import `FACTORY_ENV_NAMES` / `isFactoryEnvName` from shared; `buildAgentEnv` asserts that the names it sets are in the list)

**Interfaces:**
- Produces:
  - `validateEffective(doc: ConfigDoc, ctx: ValidationContext & { templateDir?: string; agentRuntimes?: ("local"|"docker")[] }, policy: "human"): TemplateIssue[]`, where issue paths are rooted at `template.` / `settings.` / `mcp.`;
  - `overlayIssues(base: ConfigDoc, overlay: AgentOverlay, ctx): TemplateIssue[]`: the Zod issues of `agentOverlaySchema`, plus `validateEffective(merge)` minus `validateEffective(base)`, compared by `message|path`.
  - `validateTemplate` returns `tplYaml` as well (the parsed YAML object) and calls `validateEffective` for its semantic rules.

- [ ] **Step 1: Failing tests** in `validate.test.ts`:
  - `permissions.defaultMode` in a template's settings.json is now an **error**;
  - `enabledPlugins` stays a warning;
  - `settings.env.ANTHROPIC_API_KEY` is an error ("ANTHROPIC_API_KEY is set by the factory.", ≤ 40 characters with a short name; the constant lives in `FIELD_MSG`);
  - a `secrets` entry `OPEN_FACTORY_X` is an error;
  - a symlinked `skills/x` is an error ("skills/x must be a folder, not a link.");
  - a symlinked `skills/` folder is an error;
  - `${X}` in an MCP env with X not in secrets or env gives a warning;
  - "Existing agents keep their runtime." when `agentRuntimes` holds a different runtime;
  - `overlayIssues`: an overlay plugin whose marketplace the template doesn't declare gives "Marketplace acme isn't declared by template dev.";
  - `overlayIssues` reports nothing that already fails on the base.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/templates/validate.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Move the semantic block of `validateTemplate` (validate.ts:157–240) into `validateEffective` over a `ConfigDoc`, and add the new rules. `validateTemplate` builds a `ConfigDoc` from its parsed files and calls it.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `feat(server): validateEffective for templates and overlays`

### Task A6: Template index — last valid parse, CAS change detection, delete refusal

Implements spec §7.1 and §7.4. **Its tests are DB tests and run in CI only.**

**Files:**
- Modify: `apps/server/src/templates/template-index.ts`
- Test: `template-index.test.ts` (DB)

**Interfaces:**
- Produces:
  - `TemplateIndex.loadValid(name)` returns `{ dir, config, tplYaml, tplSettings, tplMcp, doc: ConfigDoc }`;
  - `TemplateIndex.onChange(listener: (e: { name: string; before: ConfigDoc | null; after: ConfigDoc; by: string }) => void)`;
  - writes through the API take `by` (`writeFile(name, file, content, baseHash, by)`);
  - `TemplateIndex.lastValid(name): Promise<ConfigDoc | null>` (a DB read only);
  - `configDocHash(doc) = sha256(canonicalJson(doc))`.

- [ ] **Step 1: Failing DB tests (CI only):**
  - an edit to `template.yaml` that changes `skills` fires `onChange` once, with `before` and `after`;
  - five concurrent `scanOne` calls after one edit fire exactly once;
  - an edit to `AGENTS.md` only changes `content_hash` but not `last_valid_hash`, so no event fires;
  - valid → invalid (no event, `valid=false`, `last_valid` kept) → valid with a new skill fires with `before` = the old doc;
  - a folder deleted and restored fires with `before: null`;
  - `onChange` listeners are invoked through `queueMicrotask` and never awaited by `scanOne` (assert `scanOne` resolves while a listener's promise is pending);
  - `remove` refuses with 409 `template_in_use` while an archived agent uses the template, with the message "@ana and 2 more (1 archived) use this template. Archive and recreate them first.";
  - terminated spawned agents don't block deletion.
- [ ] **Step 2: Implement.**
  - In `index()`, after the upsert (which never touches `last_valid*`), when the parse is valid, compute `h = configDocHash(doc)`.
  - If `h !== row.lastValidHash`: `UPDATE templates SET last_valid=$doc, last_valid_hash=$h, valid=true WHERE name=$n AND last_valid_hash IS NOT DISTINCT FROM $old RETURNING name`. If a row returns, enqueue the listener on a per-name promise chain (`this.queues.get(name)`), started with `queueMicrotask`, catching errors with `log.error`.
  - When the parse is invalid: `UPDATE … SET valid=false`.
  - `scan()`/`scanOneFull` keep deleting rows for removed folders (`last_valid` goes with the row, so `before: null` on return).
- [ ] **Step 3:** Push the branch and check the CI DB suite for `template-index.test.ts` (it can't run locally).
- [ ] **Step 4: Commit.** `feat(server): template change detection by compare-and-set`

### Task A7: `ConfigResolver` and start from the effective config

Implements spec §6.1, §6.2 and §6.3.

**Files:**
- Create: `apps/server/src/agents/config-resolver.ts`, `config-resolver.test.ts`
- Modify:
  - `apps/server/src/agents/start.ts` (deleting `start.ts:152`'s safeParse; `deriveInheritance`; `maySpawn` on the prepared effective config);
  - `apps/server/src/workspace/workspace.ts` (`PrepareInput.effective`; delete `readTemplateJson`, `readTemplateSettings`, `applyPending`);
  - `apps/server/src/agents/errors.ts`, `apps/server/src/workspace/safe-fs.ts`, `packages/shared/src/events.ts` (fix codes `template` and `config`; `forSpawnedAgent` drops `config`);
  - `apps/server/src/spawning/may-spawn.ts` (`maySpawn(agent, config: TemplateConfig)`).

**Interfaces:**
- Produces:
  - `type Effective = { doc: ConfigDoc; config: TemplateConfig }`;
  - `class ConfigResolver { constructor(d: { templates: TemplateIndex }); effective(agent: AgentRow): Promise<Effective> }`, which throws `AgentStartError` with the three spec §6.1 messages;
  - `PreparedSpec.effective: Effective`.

- [ ] **Step 1: Failing tests** (`config-resolver.test.ts`, using a fake TemplateIndex, no DB):
  - it merges the overlay;
  - `runtime` is overwritten from the row;
  - missing / invalid template / invalid overlay → the three messages and fix codes;
  - a spawned agent ignores `config`.
- [ ] **Step 2:** In `start.test.ts` (DB, CI only):
  - `prepare` writes `settings.json` with an overlay deny rule appended and `.mcp.json` with an overlay server;
  - `deriveInheritance` takes `started` ∩ current for secrets and ∪ for deny rules when the spawner is loaded, and the current config alone when it isn't;
  - `spawning` is computed from the effective config being prepared.
- [ ] **Step 3: Implement.** Write the resolver, wire it into `createPrepareStart` (dependency `resolver`), and pass `effective` to `prepare`. In `prepare`:
  - `buildSettings({ tpl: effective.doc.settings, … })`;
  - `buildMcpJson(effective.doc.mcp, …)`;
  - `declaredMarketplaceDirs(effective.doc.settings)`.
  
  `buildRuntimeSpec` reads `effective.config`.
- [ ] **Step 4:** Run `pnpm vitest run apps/server/src/agents/config-resolver.test.ts apps/server/src/workspace` → PASS. The DB parts run in CI.
- [ ] **Step 5: Commit.** `feat(server): start agents from the current template plus overlay`

### Task A8: Template-local skills linked live, and the mount rule

Implements spec §6.4.

**Files:**
- Modify:
  - `apps/server/src/workspace/links.ts` (`syncLinks` `onlyUnder` becomes `string[]`; new `resolveTemplateSkills(tplDir)` and `linkSkills(workdir, host, template)`);
  - `apps/server/src/workspace/files.ts` (`templateTargets` no longer copies `skills/`);
  - `apps/server/src/workspace/mounts.ts` (the new allowed class);
  - `apps/server/src/workspace/workspace.ts`.
- Test: `links.test.ts`, `mounts.test.ts`, `hardening.test.ts`

**Interfaces:**
- Produces: `resolveTemplateSkills(templateDir: string): Promise<{ name: string; realDir: string }[]>`, which throws `WorkspaceError("skills/x must be a folder, not a link.", "template")` or the `skills/` variant.

- [ ] **Step 1: Failing tests:**
  - template skills become links to `realpath(tpl/skills)/<name>`;
  - a removed template skill's link is dropped while the agent's own real folders stay;
  - a non-link entry with a template skill's name fails with "…isn't a link to the template skill; move it away.";
  - a symlinked entry is refused;
  - a symlinked `skills/` pointing into `state/agents/bob` is refused, both by `resolveTemplateSkills` and by `checkMounts`;
  - a real skill folder under `FACTORY_HOME/templates/t/skills/x` is allowed as a ro mount;
  - a source under `FACTORY_HOME/state`, an agent workdir or the host home stays refused even within the exemption.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/workspace/links.test.ts apps/server/src/workspace/mounts.test.ts` → FAIL.
- [ ] **Step 3: Implement** as spec §6.4. In `checkMounts`, the new class applies only when the source equals `join(realpath(templatesDir/<tpl>/skills), name)`, `lstat` of the entry and of `skills/` show directories, and the source is not under `FACTORY_HOME/state`, any workdir or the home directory.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `feat(server): link template-local skills live`

### Task A9: Plugins installed at start when missing

Implements spec §6.5.

**Files:** Modify `apps/server/src/workspace/workspace.ts` and `plugins.ts`. Test: `plugins.test.ts`, `workspace.test.ts`.

- [ ] **Step 1: Failing tests** (fake `claude` binary as in today's `plugins.test.ts`):
  - with `enabledPlugins` holding `a@m`, an effective list `[a@m, b@m]` installs only `b@m`, through the hardened env allowlist and an empty temp cwd;
  - a failed install throws `AgentStartError("Plugin b@m didn't install.", fix)`, with fix `template` when the template lists it and `config` when only the overlay does;
  - marketplace sources come from `effective.doc.settings.extraKnownMarketplaces` only.
- [ ] **Step 2: Implement.**
  - Replace the "Re-sync to reinstall" throw (`workspace.ts:295`) with the ensure-install.
  - `materialize` calls the same function.
  - Delete `linkPlugins`' legacy move-aside: a real `plugins` dir now throws `WorkspaceError("….claude-config/plugins isn't a link; move it away.")`.
- [ ] **Step 3: Run** `pnpm vitest run apps/server/src/workspace/plugins.test.ts apps/server/src/workspace/workspace.test.ts` → PASS.
- [ ] **Step 4: Commit.** `feat(server): install listed plugins at start`

### Task A10: Runtime — started config, change notice, restart with changes

Implements spec §6.2 and §7.3. **Its runtime tests are DB-backed and run in CI only.**

**Files:**
- Modify: `apps/server/src/agents/agent-runtime.ts`, `runtimes.ts`, `event-store.ts`, `notices.ts`, `packages/shared/src/events.ts`, `packages/shared/src/agents.ts` (`restartChanges`)
- Modify: `apps/server/src/supervisor/*` (`refOf` reads `nextImage`)
- Test: `agent-runtime.restart.test.ts` and `notices.test.ts` (both DB, CI)

**Interfaces:**
- Produces:
  - `AgentRuntime.started?: Effective`;
  - `AgentRuntime.requestRestart(opts?: { changes?: string[]; wake?: boolean })`; `wake` is accepted and ignored in I2, for I7;
  - `Runtimes.requestRestart(id, opts?)`;
  - `Runtimes.recordConfigNotice(id, lines: string[]): Promise<void>`, which awaits a loading runtime;
  - `Runtimes.setNextImage(id, ref | undefined)`;
  - `EventStore.createNotice(agentId, type, body, { merge?: boolean })`;
  - `NoticeType` gains `"config_changed"`;
  - session event `{ type: "config_changed", by: string, changes: string[] }`;
  - live field `restartChanges: string[]`.

- [ ] **Step 1: Failing tests** (CI):
  - `isPassive` holds for `config_changed`, so the notice never wakes a hibernated agent;
  - two `recordConfigNotice` calls before delivery give one pending row whose parsed lines are the union, sorted;
  - a `config_changed` row created after the process started is **not** in that process's batches: a message sent between the change and the restart doesn't carry it, and the first batch after the restart does;
  - an unloaded agent gets the row;
  - after a crons-takeover exit, a shutdown and a crash, the row is still pending and is delivered on the next start;
  - lost crons on an `apply_changes` exit still add a **non-passive** `restart_crons` that wakes the agent;
  - `restartChanges` appears in `liveFields` while restart is pending and clears on exit;
  - `refOf` returns `nextImage`, which is kept only for **loaded** runtimes and is undefined when the template was invalid at load;
  - `prepareStart` with a resolved image ≠ `nextImage` updates it and fails through the image-missing path.
- [ ] **Step 2: Implement.**
  - `isPassive`: `notice === "crons_stopped" || notice === "config_changed"`.
  - The flush filter: skip `config_changed` rows with `createdAt > this.procStartedAt`.
  - Store `started` at `launchWith` from `PreparedSpec.effective`.
  - `pendingChanges` sits beside `restartPending` and is cleared in `onExited`.
  - `notices.configChanged = renderConfigNotice`.
  - `createNotice` merge mode: parse the pending body, union the lines, re-render.
- [ ] **Step 3:** Push and read CI.
- [ ] **Step 4: Commit.** `feat(server): passive config_changed notice and restart with a change list`

### Task A11: `ConfigChanges` and wiring

Implements spec §7.2, §6.2 (`started` readers) and §6.7.

**Files:**
- Create: `apps/server/src/agents/config-changes.ts` and `config-changes.test.ts` (DB, CI)
- Modify:
  - `apps/server/src/app.ts` (construct it, subscribe to `templates.onChange`; the MCP tool list uses `runtime.started?.config`);
  - `spawning/spawn-service.ts` (`can_spawn` and `max_live_spawns` from `started`, refusing "@x isn't running." without it; the template copy read at ~156 is replaced by the resolver);
  - `agents/agent-runtime.ts:3316,3344` (warm window from `started`);
  - `routes/agents.ts:103,339` (skills from `started`, with the resolver as fallback);
  - `agents/agent-service.ts:352` `syncChildren` (child projects from `templates.lastValid`);
  - `secrets/secret-service.ts:40` (`usedBy` per spec §6.7, using SQL on `templates.last_valid->'template'->'secrets'` and `agents.config->'template'->'secrets'`, plus the live children).

**Interfaces:**
- Produces: `class ConfigChanges { templateChanged(e): Promise<void>; overlaySaved(agent: AgentRow, by: string, before: ConfigDoc, after: ConfigDoc): Promise<{ changes: string[]; restart: boolean }> }`. It is never awaited by scans, and its restart requests are never awaited by HTTP.

- [ ] **Step 1: Failing tests** (CI):
  - a template change with a new skill writes `config_changed` on each live agent of that template, persistent and spawned, records the notice and requests a restart for running ones only when `describeChanges(started.doc, after)` is non-empty;
  - an `AGENTS.md`-only change does nothing;
  - archived agents are skipped;
  - `before: null` writes no event but still runs the restart check;
  - a spawner whose secrets or deny rules changed restarts its live children;
  - an overlay save on an archived agent writes the event only;
  - `nextImage` is refreshed for loaded runtimes;
  - `usedBy("GH_TOKEN")`, where only the template lists it, returns its non-archived agents and their live children, and rotate restarts them.
- [ ] **Step 2: Implement** per spec §7.2. The event goes through `runtime.append` when loaded (so it publishes), else `store.append`. `ConfigChanges` also publishes a global WS frame `{ type: "config_changed", agent?: slug, template?: name }`: one per affected agent, plus one for the template on a template change. Add it to `packages/shared/src/ws.ts` and the server WS bus (`apps/server/src/ws/route.ts`).
- [ ] **Step 3:** Run `pnpm typecheck`. It must now be green for server and shared, except for the web, which is fixed in A12.
- [ ] **Step 4: Commit.** `feat(server): one change path for template and overlay edits`

### Task A12: Remove Re-sync, snapshots, `grants_overridden` and S4 compatibility code (server and web)

Implements spec §8. **Web part:** the implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Delete: `apps/server/src/workspace/state-migration.ts` (+test) and its boot call; the resync route in `routes/agents.ts:119-123`; `AgentService.resync`, `templateProjects`; `Workspace.resync`, `applyTargets` (kept as the one-file helper in A13), `applyPending`; `files.ts` `writeTemplateCopy`, `stageTargets`, `pendingTargets`; `paths.ts` `templateCopyDir`, `resyncPendingDir`, `resyncRoot`; `resyncResponseSchema`; fix code `resync`.
- Modify: `agent-service.ts`: `create` stops writing `config: tpl.config` (it writes `{}`) and `grantsOverridden`; `update` drops `projects: null`.
- **Keep** the WS `resync` frame (`ws/route.ts:121`): it is session replay.
- Web:
  - delete `lifecycle.resyncAgent` and its toasts, the AgentMenu item, `ResyncFix` in `timeline-row.tsx`, `api.resyncAgent`, and the `ProjectGrantPicker` "From the template / Custom" marker;
  - remove the Re-sync copy in `features/settings/factory-section.tsx:49` and `features/templates/template-editor.tsx:648`;
  - update their tests (`agent-menu.test.tsx`, `timeline-row.test.tsx`, `session-view.test.tsx`, `agent-form-state.test.ts`).

- [ ] **Step 1:** Delete, then make `pnpm typecheck` and `pnpm lint` green.
- [ ] **Step 2:** Run `pnpm vitest run apps/web` → PASS (updated tests). Run `rg -n "resync|Re-sync|grantsOverridden|templateCopyDir" apps packages`; the only hits allowed are the WS replay frame and its client.
- [ ] **Step 3: Commit.** `refactor: delete template snapshots and Re-sync`

### Task A13: Reset persona (server and web)

Implements spec §9. **Web part:** the implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Server: `agent-service.ts` `resetPersona(slug, by)`; `workspace.ts` `resetPersona(slug, tplAgentsMd, { canWriteNow })`, which reuses the narrowed `applyTargets`; `prepare` applies `state/agents/<slug>/persona-pending/AGENTS.md` first; route `POST /api/agents/:slug/reset-persona`; schema `resetPersonaResponseSchema = { applied: "now"|"on_restart", backupDir? }`.
- Web: `features/agents/lifecycle.ts` `resetPersona`; the AgentMenu item "Reset persona…" with a `ConfirmDialog` (spec §9 copy); toasts.
- Tests: `agent-service.test.ts` (DB, CI); `workspace.test.ts` (backup path `state/agents/<slug>/persona/<UTC>/AGENTS.md`, symlink refusal through SafeFs, pending applied at `prepare`); `agent-menu.test.tsx` (item, dialog, toast copy).

- [ ] **Step 1:** Failing tests.
- [ ] **Step 2:** Implement. The notice line "- AGENTS.md reset from template dev; the previous file is saved." goes through `recordConfigNotice`, and the restart through `requestRestart(id, { changes: ["persona reset from template"] })` when staged.
- [ ] **Step 3:** Run the tests → PASS.
- [ ] **Step 4: Commit.** `feat: reset persona from template`

### Task A14: `config_changed` timeline row, restart line, fix links, overlay API (no form yet)

Implements spec §7.3 UI and §12.1 (agent GET/PUT). **Web:** the implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Server:
  - `routes/agents.ts`: `GET` and `PUT /api/agents/:slug/config` per spec §12.1. The PUT runs in one transaction: `SELECT … FOR NO KEY UPDATE`, a JS version compare, then `UPDATE`. A stale version gives 409 `config_changed`. Errors come back as `issues`. With a broken template, `checked: "schema"`. The response doesn't await restarts.
  - `agent-service.ts` `getConfig` and `putConfig`.
  - Shared schemas `agentConfigResponseSchema` and `putAgentConfigBodySchema`.
  - `AgentDetail` gains `model: { value: string | null; source: "agent" | "template" | "default" }` from the resolver (or `started`), so the Edit agent summary row (C4) needs no config query.
- Web:
  - `features/session/timeline-row.tsx` renders `config_changed`: "Configuration changed by @x · N changes". The list is clamped to 2 lines with CSS `line-clamp-2` (no measuring in JS), then Show all, with `overflow-wrap:anywhere`.
  - The restart line uses `summarizeChanges(restartChanges)`, with the full list in a tooltip and in Agent details.
  - The fix links `template` → `/templates/<name>` and `config` → `/agents/<slug>/config` (a placeholder route until C4: link to the template page for `config` until then and note it in the commit).
- Tests:
  - server (DB, CI): PUT 409 on a concurrent update, 400 with paths, success with `changes`, schema-only with a broken template;
  - web: the timeline row with 43 changes clamps; the live line shows at most 3 kinds.

- [ ] Steps: failing tests → implement → run → commit `feat: overlay API and config change rows`.

### Task A15: Product docs (main checkout) and PR 1

- [ ] **Step 1:** Update the gitignored product docs in `/Users/orlevi/projects/open-factory/docs/product/`, per spec §15:
  - `concepts/agent-template.md`, `concepts/agent.md`;
  - `architecture/workspace.md` (including the rewritten plugins paragraph), `context-assembly.md`, `data-model.md`, `agent-runtime.md`;
  - `behavior/administration.md`;
  - the `decisions/0017-templates-on-disk.md` note.
  
  These are not committed (gitignored). List them in the PR body.
- [ ] **Step 2: Branch review.** Dispatch a fresh reviewer on `git diff spec/i2-agent-config...i2/1-overlay` against spec §4–§9 and §13, ADR 0028 and the secret-safety rule. For the React diff, the reviewer invokes `vercel-react-best-practices` first and reports by rule. Fix findings, then commit.
- [ ] **Step 3: Verification.** Take `/tmp/of-v002-heavy.lock`, then:
  - `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build`;
  - the dev loop from a clean clone: `git clone` the branch to a temp dir, `pnpm install --frozen-lockfile`, `pnpm dev` with a throwaway DB and fake Claude (the harness `env.sh`), confirm the server and web boot, and create an agent from a template;
  - release the lock.
- [ ] **Step 4: Browser check.** Use the U4 harness through its lock, Chromium and WebKit headless, fake Claude only, the 1440 and 390 desktop views (no full matrix; PR 1 has no layout-sensitive new view). Check:
  - AgentMenu without Re-sync and with Reset persona (the dialog);
  - the `config_changed` row (43-line clamp);
  - the restart line;
  - acceptance criteria 2 and 4, end to end: overlay set through the API; template skill added on disk; the agent restarts; a message wakes it; the new `system/init` shows the skill.
  
  Command: `cd /Users/orlevi/projects/open-factory/docs/product/ui-review/u4-evidence/harness && ./run.sh <check.py>` (write the check scripts under `docs/product/ui-review/i2-evidence/`, beside the harness's style). Hold `/tmp/of-v002-heavy.lock` for the run.
- [ ] **Step 5:** Merge in the latest I1 branch. Push `i2/1-overlay`. Open a **draft** PR with base = I1's last branch (`i1/4-send-command`, else `spec/i1-chat-and-session`) and title `feat: agent config overlay on live templates`.
  - The body follows `.github/pull_request_template.md` (What, Why, Approach bullets "X, rather than Y, because Z", Changes by area), with the HTML comments removed.
  - It links the spec, this plan and #142, states the **reset step**, and lists the product docs updated.
  - The body ends with "🤖 Generated with [Claude Code](https://claude.com/claude-code)".
- [ ] **Step 6:** Watch CI (`gh pr checks --watch`) until green, fixing failures, especially the DB suites that couldn't run locally.

---

# Part B: `i2/2-colour` (PR 2)

`git checkout -b i2/2-colour i2/1-overlay`

### Task B1: Palette and `AVATAR_HUES`, with the ΔE gate (shared and web)

Implements spec §11 and R1. **Web:** the implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `packages/shared/src/avatar.ts` and `avatar.test.ts`
- Modify: `apps/web/src/styles.css` (`--avatar-1..12`, light and dark, and the `--color-avatar-*` theme map), `apps/web/src/lib/factory-bot.ts` (`fill: take(12) + 1`, type `1..12`)
- Test: `apps/web/src/lib/factory-bot.test.ts`, plus a web token-parity test that reads `styles.css`

**Interfaces:**
- Produces:
  - `AVATAR_HUES: readonly { index: number; hue: number; tier: "deep"|"light"; name: string }[]` (12 entries);
  - `avatarL(theme: "light"|"dark", tier)`, giving 0.56/0.68 light and 0.64/0.76 dark;
  - `oklchDistance(a, b)` (ΔE_ok);
  - `AVATAR_COUNT = 12`.

- [ ] **Step 1: Failing tests:**
  - 12 entries, hues in the spec order, odd indexes deep and even light;
  - every hue ≥ 15° from 150 and 250 and outside 0–100;
  - for each theme, the **minimum pairwise ΔE_ok over all 12 fills ≥ 0.030**;
  - ink (L 0.2) contrast ≥ 3:1 on every fill;
  - the `styles.css` tokens equal `AVATAR_HUES` (parse `oklch(` lines);
  - `botParts` gives the same head, eyes, mouth and accessory as before for a fixed set of slugs, with only `fill` changing.
- [ ] **Step 2: Run.** If the ΔE gate fails with the 12-hue set, switch `AVATAR_HUES` to the **6 × 2 fallback** (hues 120, 175, 210, 280, 315, 345, each in deep and light, interleaved) without asking again. Note which set shipped in the PR body (R1).
- [ ] **Step 3: Implement** until the tests pass.
- [ ] **Step 4:** Write the measured min-ΔE table (light and dark, against today's 0.030) to `docs/product/ui-review/i2-evidence/palette.md` (main checkout) for the PR body.
- [ ] **Step 5: Commit.** `feat: twelve identity colours in two lightness tiers`

### Task B2: `agents.color`, PATCH without restart, colour in every payload

Implements spec §11. **Web:** the implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- DB: `packages/db/src/schema/agents.ts` (`color: smallint("color")`, with `check("agents_color", sql\`${t.color} IS NULL OR ${t.color} BETWEEN 1 AND 12\`)`), then `pnpm db:generate` (ALTER only).
- Shared: `AgentSummary.color: number | null`; `PatchAgentBody.color?: number | null` (int 1–12 or null); I1's `ChatRow.agent.color`; the mention, people and peer payloads that carry `avatarVersion`.
- Server: `agent-service.ts` `update` (a colour-only change never calls `requestRestart`; it is refused for spawned agents as today) and every summary builder.
- Web:
  - `components/agent-avatar.tsx` takes `color?: number | null` and passes it into `BotSvg` (memo), which uses `fill = color ?? parts.fill`, so a colour change re-renders only the SVG;
  - every `<AgentAvatar` call site passes `color`. Run `rg -n "<AgentAvatar" apps/web/src` to get the list: today `address-line.tsx` (New agent: Auto, so `null`), `sidebar-tree.tsx` ×2, `session-view.tsx`, `agent-chip.tsx`, `composer/caret-menu.tsx`, plus I1's chat and inbox views.
- Tests:
  - server (DB, CI): a colour PATCH doesn't restart; a spawned agent is refused; the CHECK rejects 13;
  - web: `AgentAvatar` uses the `color` fill over the seed; the template `avatar.svg` still wins.

- [ ] Steps: failing tests → implement → run → commit `feat: per-agent identity colour`.

### Task B3: Colour field in Edit agent

Implements spec §12.6 (Colour) and DESIGN.md amendments 2 and 3. **Web:** the implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/agents/colour-field.tsx` and `colour-field.test.tsx`
- Modify: `edit-agent-sheet.tsx`:
  - the field goes after Display name, with `color` in the form state and body;
  - at **both** sites (`:320` restart flag and `:362` toast), use `const restartFields = changes.filter((f) => f !== "color")`;
  - `color` is left out of `APPLIES`.
- Modify: `agent-form-state.ts`, `DESIGN.md` (amendments 2 and 3, from spec §14)

**Details (spec §12.6):**
- `FieldShell legend`, with "Colour · Teal" or "Colour · Auto (Jade)" visible.
- A radiogroup with roving tabindex. Auto comes first, set off by an 8px gap and a dashed 1px field-edge outline. Then a 2 × 6 grid.
- Each swatch shows the agent's face at 24px. The pitch is 32px (40px on touch, via `hit-touch`).
- Selected: `ring-2 ring-foreground ring-offset-2`. Focus-visible: the signal ring at offset 4px.
- The swatch options (Auto plus `AVATAR_HUES`) are hoisted to a module constant.
- Roving tabindex and arrow, Home and End keys are handled in one `onKeyDown` on the group, never in effects.
- A tooltip with the hue name (400ms rule), which is also the accessible name.
- No transitions. Arrow keys move and select.
- When the agent's template has `avatarVersion`, render the muted line "This template's avatar.svg sets the avatar." instead.

- [ ] **Step 1: Failing tests:**
  - arrow keys move the selection and set `color`;
  - Home and End;
  - the visible name updates;
  - with `avatarVersion` the line replaces the group;
  - saving colour alone shows "Saved @slug." with no "Restarts when idle";
  - the PATCH body contains `color`.
- [ ] **Step 2:** Implement, then run `pnpm vitest run apps/web/src/features/agents`.
- [ ] **Step 3: Commit.** `feat(web): colour swatches in Edit agent`

### Task B4: Verification and PR 2

- [ ] **Step 1: Branch review.** A fresh reviewer on `git diff i2/1-overlay...i2/2-colour` checks spec §11, §12.6 and §14. For the React diff, the reviewer invokes `vercel-react-best-practices` first and reports by rule. Fix findings.
- [ ] **Step 2: Full verification** under `/tmp/of-v002-heavy.lock`: `pnpm install --frozen-lockfile`, typecheck, lint, test, build, and the clean-clone dev loop.
- [ ] **Step 3: Browser evidence.** Chromium and WebKit headless, through the harness `run.sh` lock and the heavy lock, fake Claude only:
  - all 12 fills at 16px and 24px in light and dark, beside the success, info and rate-limited marks;
  - an avatar at index 1 (115) with the rate-limited badge;
  - the Edit agent swatches at 1440 and 390;
  - acceptance criterion 9: pick a swatch and check the sidebar, list, chip, speaker line, palette and inbox in both themes, and that a template with `avatar.svg` offers no colour.
  
  Attach the R1 ΔE table and say which palette set shipped.
- [ ] **Step 4:** Merge `i2/1-overlay` and I1's latest. Push. Open a draft PR with base `i2/1-overlay`, title `feat: per-agent identity colour`, the template body, links to the spec, plan and #142, and the reset step. Watch CI until green.

---

# Part C: `i2/3-config-form` (PR 3)

`git checkout -b i2/3-config-form i2/2-colour`

### Task C1: Template config API, YAML Document writes, and host-skills API (server)

Implements spec §12.1 (template config, host skills). **Its tests are DB tests and run in CI only.**

**Files:**
- Modify: `apps/server/src/templates/template-index.ts` (`readConfig(name)` and `writeConfig(name, doc, baseHashes, by)`), `routes/templates.ts`
- Create: `apps/server/src/routes/host-skills.ts` and its test; `apps/server/src/templates/yaml-write.ts` and `yaml-write.test.ts` (pure)
- Shared: `templateConfigResponseSchema`, `putTemplateConfigBodySchema`, `hostSkillsResponseSchema`

**Interfaces:**
- Produces:
  - `applyConfigToYaml(text: string, template: Record<string, unknown>): string`, which sets or deletes only the form-owned keys (`model`, `effort`, `warm_window_minutes`, `max_live_spawns`, `skills`, `plugins`, `can_spawn`, `secrets`) through `parseDocument`, keeping comments and order;
  - `GET`/`PUT /api/templates/:name/config`;
  - `GET /api/host-skills`.

- [ ] **Step 1: Failing pure tests** (`yaml-write.test.ts`):
  - comments, key order and `display_name` survive;
  - deleting `model` removes only that key;
  - an unknown key survives.
- [ ] **Step 2: Failing DB tests (CI):**
  - a stale base hash gives 409 `changed_on_disk`;
  - an invalid `mcp.json` in the doc gives a 400 and leaves `template.yaml` untouched (validate all, then write);
  - only changed files are written, and an absent `mcp.json` isn't created when `mcpServers` is empty;
  - one save fires `onChange` once;
  - `agents: { live, archived, cantStart }` counts.
- [ ] **Step 3: Failing host-skills test:**
  - lists folders with a `SKILL.md` frontmatter description cut to 200 characters;
  - a missing dir gives an empty list.
- [ ] **Step 4:** Implement, run locally what is pure, push for CI. A successful `writeConfig` publishes the WS `config_changed {template: name}` frame (A11) right away, without waiting for the change flow.
- [ ] **Step 5: Commit.** `feat(server): template configuration API`

### Task C2: `ConfigForm` core — draft, lists, scalars, model picker

Implements spec §12.2, §12.3 and §10. **Web:** the implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create in `apps/web/src/features/config/`:
  - `use-config-draft.ts`: draft state, the loaded base, dirty flag, discard and undo, rebase;
  - `config-form.tsx`;
  - `config-list.tsx`;
  - `model-field.tsx`, `effort-field.tsx`, `number-field.tsx`;
  - `section.tsx`;
  - `tolerant.ts`: tolerant readers;
  - `rebase.ts`: a three-way rebase, with lists as sets and named entries by name;
  - tests for each.

**Interfaces:**
- Produces:
  - `useConfigDraft<T>(loaded: { value: T; version: string })` → `{ draft, setDraft, dirty, drift, discard(), undoDiscard(), conflicts }`;
    - **State:** one `useState<{ edits: T; base: { value: T; version: string } } | null>(null)`. `null` means "no edits": `draft = s?.edits ?? loaded.value`, `dirty = s !== null`, and `drift = s !== null && s.base.version !== loaded.version`. All three are derived in render.
    - **`setDraft(updater)`** is functional. On the first edit it snapshots `base = loaded` inside the updater, so there is never a separate "initialize" step.
    - **`discard()`** sets the state to `null` and keeps the previous `edits` in a ref for `undoDiscard()`, until the next edit.
    - **Rebase** after a 409 or a refetch with `drift`: `rebase(s.base.value, s.edits, loaded.value)` gives the new edits and the conflicts, then the state becomes `{ edits, base: loaded }`.
    - **`use-config-draft.ts` contains no `useEffect`.**
  - Config queries (`["agent-config", slug]`, `["template-config", name]`) use `staleTime: 0`.
  - `<ConfigForm mode value base? onChange readOnly? issues />`;
  - `rebase(base, mine, theirs): { value, conflicts: string[] }`.

**Rules:**
- **Hooks and state.** Derive values during render, keep no effect-driven state sync, and add no new dependencies.
- **Expensive derivations (M2).** `mergeConfig`, `describeChanges`/`summarizeChanges` and `canonicalJson` run on `useDeferredValue(draft)` inside `useMemo`, so typing never waits on them.
- **Lists (M3).**
  - Rows are keyed by value; template rows are additionally keyed by group.
  - Row elements are held in a `Map` ref (value → element).
  - Add and remove use functional updates. Focus moves in the handler, after `flushSync` commits the change, never in an effect.
  - Rows are memoized components with stable callbacks.
- **Lists:**
  - two groups, each labelled once with a count;
  - only the template group collapses past 8 ("Show all 40" / "Show fewer", instant, focus moving to the first revealed row);
  - "This agent" rows and the add row are always visible, and a new row is scrolled into view;
  - a duplicate gives "Already in the list." and expands the group to the match;
  - the remove label is "Remove allow rule 3", and focus then moves to the next remove button, else to the add input;
  - rows have min-h 32px (40px on touch), wrap, never truncate, and switch to `items-start`;
  - rules are mono, trust notes Geist.
- **Model Select:**
  - first item "Inherit from template" or "Claude Code default", with the help line "From template: <value>";
  - groups "Aliases" (`MODEL_ALIASES`) and "Model ids" (`MODEL_IDS`), then "Custom…";
  - Custom reveals a focused mono Input checked by `modelSchema`;
  - an overridden scalar shows "This agent" and a ghost "Use template's" button.
- **Numbers:** the placeholder is the inherited value; empty means inherit.
- **Tolerant render:** a wrongly typed value shows "Edit this in Raw JSON." and the form never throws. Unmapped issues go in a top block with "Show in Raw JSON".

- [ ] **Step 1: Failing tests:**
  - `rebase`: a set add/remove re-applied; a scalar conflict; an MCP entry by name; an index-shifted remote list still applies the user's adds;
  - `ConfigList`: collapse rules, duplicate expand, focus after remove;
  - the model field: inherit/custom/use template's;
  - the tolerant render: `skills: "release"` doesn't throw;
  - an unknown settings key survives a form edit (`onChange` output keeps it).
- [ ] **Step 2:** Implement; run `pnpm vitest run apps/web/src/features/config`.
- [ ] **Step 3: Commit.** `feat(web): configuration form core`

### Task C3: Form sections — skills/plugins, MCP servers, permissions, environment, behavior

Implements spec §12.2 sections 2–6. **Web:** the implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:** Create `apps/web/src/features/config/{skills-section,mcp-section,mcp-editor,permissions-section,environment-section,behavior-section,insert-secret}.tsx`, plus tests.

**Details:**
- **Skills:** a combobox over `/api/host-skills` (query `["host-skills"]`, `staleTime` 5 minutes). Template-local skills are read-only ("Template skill").
- **Shared queries (M8):** reuse the existing `secretsQueryOptions` (settings `api.ts`) and `templatesQueryOptions`; never define new keys for the same data.
- **Plugins:** a text input checked by the `name@marketplace` regex. The help is "Like formatter@acme. The marketplace must be declared in the template's settings.json." (template mode: "…declared in settings.json."). I5 replaces these pickers.
- **MCP rows:**
  - line 1: name (wrapping) and kind;
  - line 2: "npx · 3 args" or the URL host;
  - never the args, the full URL or the headers;
  - Edit and Remove are icon buttons with labels.
- **MCP inline editor:** appears instantly with focus on Name. Kind is a segmented control, and switching kind keeps the other kind's typed fields until save. Env and header rows stack below `md`. "Insert secret" sits in the value's label row:
  - it saves the caret on blur, in a ref (never in state);
  - picking a secret inserts `${NAME}` and returns focus after it;
  - "Add secret" opens the U4 sheet and inserts on return;
  - it adds `NAME` to `template.secrets`, with the note "Adds GH_TOKEN to this agent's secrets.";
  - removing the reference keeps the secret.
- **Inherited servers:** read-only, with "Override", which copies the server into the overlay.
- **Permissions:** allow, deny and trust notes, with the help examples. In agent mode, template deny rules sit in the read-only group.
- **Environment:** plain `settings.env` rows, and "From secrets" rows reading "Available as $NAME". Names that fail `ENV_NAME` or `isFactoryEnvName` show a field error.
- **Behavior:** warm window, a spawnable-templates multi-select, max live spawns.

- [ ] **Step 1: Failing tests:**
  - the MCP row never renders args or URL text;
  - the kind switch keeps fields;
  - Insert secret puts `${GH_TOKEN}` at the caret, adds the secret and shows the note;
  - Override copies the server;
  - template deny rules can't be removed in agent mode;
  - a factory env name is refused.
- [ ] **Step 2:** Implement and run.
- [ ] **Step 3: Commit.** `feat(web): configuration form sections`

### Task C4: Agent Configuration page and Raw JSON tab

Implements spec §12.4 and DESIGN.md amendments 1, 4 and 5. **Web:** the implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/routes/_app/agents.$slug_.config.tsx`, `apps/web/src/features/config/{config-page,raw-json-tab,page-footer,config-states}.tsx`, `features/config/api.ts` (query options plus the PUT mutation), and tests.
- Create: `apps/web/src/features/templates/code-surface.tsx`. Extract `LazyCodeEditor`, `TextareaEditor` and the Suspense fallback surface from `template-editor.tsx` into it, and use it on both pages. `features/config` **never imports `code-editor.tsx` statically**.
- Modify: `features/templates/code-editor.tsx` and `features/templates/code-editor-setup.ts`. Add a `readOnly` prop (a CodeMirror compartment, reconfigured, never a remount) and a `scrollMarginBottom` prop.
- Create: `features/config/json-path-line.ts` with a pure, tested `jsonPathToLine(text, path): number | undefined`. The raw tab memoizes the markers on `[text, issues]`.
- Modify: `routes/_app.tsx`. Handle the global WS frame `config_changed` (A11) by invalidating exactly `["agent-config", slug]` and/or `["template-config", name]`.
- Modify: `features/agents/agent-menu.tsx` ("Configure" between Edit and Usage), the Agent details row "Configuration", `edit-agent-sheet.tsx` (the model summary row at the end, "Model opus (this agent) · Open configuration", read from `AgentDetail.model` (A14) with no extra query), `features/session/timeline-row.tsx` (fix link `config` to the real route), `DESIGN.md` (amendments 1, 4 and 5 from spec §14).

**Details (spec §12.4):**
- **Route and header.** Shares the Usage page's header component.
  - The route loader preloads the CodeMirror chunk like `templates.$name.tsx:15`, then `await Promise.all([ensureQueryData(agentDetail), ensureQueryData(agentConfig)])`, then `void prefetchQuery` for host skills, `secretsQueryOptions` and `templatesQueryOptions`.
  - Query keys: `["agent-config", slug]`, `staleTime: 0`. After a successful PUT, `setQueryData` with the response; no refetch.
- **Panels (M1).** The Configuration panel stays mounted when hidden (`forceMount` plus `hidden`, React `<Activity>` where available), so the form's local state (expanded MCP editor, Show all) survives a visit to Raw. A test covers it.
- **Tab change (M4).** Raw-tab work (parse check, serialization) runs in `onValueChange`, not in an effect. The raw text and `EditorState` are kept in a page-owned `Map` keyed by `fileKey` (`agent:<slug>` / `template:<name>:<file>`).
- **Tabs.** "Configuration | Raw JSON" with Radix `activationMode="manual"`.
- **Raw tab:**
  - uses the existing `code-editor.tsx` wrapper with JSON, markers from issues and parse errors, and `scrollMargins.bottom` equal to the footer height;
  - a "This agent | Combined" segmented control, with Combined read-only;
  - the raw text and `EditorState` are kept across switches, re-serialized only when the form changed the draft (canonical JSON differs).
- **Invalid JSON:**
  - a switch is refused, focus moves to the first error, and a polite live region says "Fix the JSON to switch tabs.";
  - "Revert raw edits" restores the last valid draft;
  - Save keeps its shape but is disabled ("Fix the JSON to save."); Discard always works.
- **Footer:**
  - one row (Discard ghost, "Save changes" primary) with the `FormOutcome` line above;
  - sticky only while dirty or while an outcome shows, else in flow;
  - plate background, top rule, no blur;
  - the restart notice sits in the page flow above it, while running ("Saving restarts @ana when idle to apply: …").
- **Discard:** instant, then "Discarded." with Undo until the next edit.
- **Leaving dirty:** `useBlocker`.
- **409:** "Changed since you opened it." with Reload, which rebases and marks conflicts with "Also changed elsewhere."; no Overwrite.
- **Save outcomes:** "Saved.", "Saved. Restarts @ana when idle.", "Saved. Checked fully once dev is fixed."
- **States:**
  - spawned: read-only Combined, from `started`, else labelled "Next start", with links;
  - archived: a persistent block;
  - unknown slug;
  - broken template: a persistent block with "Open template", a read-only form and Raw editable;
  - restart pending: a top line.
- **Refetch** on window focus and on the WS agent and template events.
- **Layout:** max-width 44rem, sections 32px apart, no horizontal scroll at 390px or at 200% text.

- [ ] **Step 1: Failing tests:**
  - the invalid-JSON block (focus, live region text, revert, Save disabled, Discard works);
  - raw text and key order preserved across a visit to the form with no edit;
  - Discard and Undo;
  - the 409 rebase keeps the user's added skill when the remote added another;
  - each state renders;
  - an unknown settings key added in Raw survives a form save (acceptance criterion 12);
  - the footer is sticky only while dirty;
  - the Edit agent summary row links to the page.
- [ ] **Step 2:** Implement and run `pnpm vitest run apps/web`.
- [ ] **Step 3: Commit.** `feat(web): agent configuration page`

### Task C5: Template Configuration tab

Implements spec §12.5 and DESIGN.md amendment 6. **Web:** the implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:** Modify `apps/web/src/features/templates/template-editor.tsx` (it uses `code-surface.tsx` from C4). Create `features/templates/template-config-tab.tsx` and tests.

**Ownership (H4):**
- `TemplateEditor` owns the `["template-config", name]` query and the `useConfigDraft`, and passes them to a `memo`'d `TemplateConfigTab`.
- The locks (form read-only, file tabs read-only) are derived in render from the file-tab dirty flags and `draft.dirty`.
- The "silent reload" is `invalidateQueries(["template-config", name])` in the file tab's `save()` success handler, never an effect.
- The default tab comes from a lazy `useState` initializer: Configuration when valid, else `template.yaml`.

**Details:**
- **Tab strip:**
  - the Configuration tab comes first, labelled in Geist with a 1px rule before the mono file tabs;
  - it is the default when the template is valid, else `template.yaml`;
  - below 40rem the strip becomes a `Select` that lists every tab with its dirty and error marks;
  - the file tabs adopt the page-footer rule.
- **One draft per file:**
  - while `template.yaml`, `settings.json` or `mcp.json` is dirty, the form is read-only, with "settings.json has unsaved edits. Save or discard them first." and a jump;
  - while the form is dirty, those three tabs are read-only, with "Unsaved changes in Configuration.";
  - after a file-tab save while the form is clean, the form reloads silently;
  - the dirty dot shows on the Configuration tab.
- **Header line:** "Used by 3 agents. Saving restarts the ones whose configuration changes, when idle.", using the existing plural helpers (`template-editor.tsx:845`). With errors: "3 agents can't start until this is fixed."
- **Broken template:** the form is read-only.

- [ ] **Step 1: Failing tests:** mutual read-only both ways, the silent reload, the Select below 40rem with marks, the plurals, the broken-template read-only form.
- [ ] **Step 2:** Implement and run.
- [ ] **Step 3: Commit.** `feat(web): template configuration tab`

### Task C6: Product docs, final review and verification, PR 3

- [ ] **Step 1:** Update the gitignored product docs in the main checkout (`behavior/administration.md`: the Configuration page and the template tab; `concepts/agent-template.md`, `concepts/agent.md`: the form). List them in the PR body.
- [ ] **Step 2: Whole-branch review.** A fresh reviewer on `git diff spec/i2-agent-config...i2/3-config-form` covers every spec section, acceptance criteria 1–13, ADR 0028 (no compatibility code, no data migration), secret safety (no values in events, notices, the combined view, logs, or MCP rows), I4 form rules, DESIGN.md amendments, and **the whole React diff against `vercel-react-best-practices`** (the reviewer invokes the skill first and reports by rule). Fix the findings and commit.
- [ ] **Step 3: Full verification** under `/tmp/of-v002-heavy.lock`:
  - `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`;
  - the dev loop from a clean clone (temp dir, frozen install, `pnpm dev` with the harness env and fake Claude, open the Configuration page, save an overlay);
  - release the lock.
- [ ] **Step 4: Real-browser check of the UI acceptance criteria.** Chromium and WebKit headless, through `/Users/orlevi/projects/open-factory/docs/product/ui-review/u4-evidence/harness/run.sh` (its lock) **and** `/tmp/of-v002-heavy.lock`, fake Claude only, never real agents. Write the check scripts under `docs/product/ui-review/i2-evidence/`.
  - **Full matrix** (1440, 1024, 390, and 200% text) **only** on the agent Configuration page and the template Configuration tab, with worst-case data:
    - 40 template allow rules plus 3 on the agent;
    - 10 MCP servers with long names, URLs and commands;
    - custom model `claude-sonnet-5-5[1m]`;
    - template `platform-infrastructure-reviewer`;
    - a raw paste with 40+ changes.
    
    Check: no horizontal scroll, the footer behaviour, the collapsed groups, the tab Select below 40rem, and the invalid-JSON block.
  - **Single viewport (1440 and 390)** for everything else: Edit agent (summary row), AgentMenu, the timeline row.
  - **End-to-end acceptance criteria 10, 11 and 12:**
    - switch to Opus → the agent restarts → send a message → `system/init` shows the model, and the siblings and template are unchanged;
    - an MCP server with a secret reference → `.mcp.json` has `${NAME}`, no value on disk or in the UI, and the raw tab shows the entry;
    - an unknown key in Raw survives a form save.
- [ ] **Step 5:** Merge `i2/2-colour` and I1's latest. Push. Open a draft PR with base `i2/2-colour` and title `feat(web): configuration form and raw JSON editor`, using the template body (Approach bullets per decision), links to the spec, plan and #142, the reset step, and the product docs updated. Watch CI until green.
- [ ] **Step 6:** Report to the tech-lead: the three PR URLs, the CI status, the palette set shipped with its ΔE table, and any spec deviation found during implementation.
