# S4 Templates, Workspace and Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Humans create persistent agents from templates on disk. Each agent gets its own working dir, Claude config dir, granted projects, named credential, secrets and generated context. It runs in auto mode with deny rules visible in its session, and config edits apply through a graceful restart that keeps the session.

**Architecture:**
- `packages/shared` gains the template, settings and name schemas.
- `packages/harness` gains the deny-rule derivation, `error.code` / `turn_end.apiErrorStatus`, and a wider `AgentRuntimeSpec`.
- `apps/server` gains:
  - a `TemplateIndex` (folders → DB cache, one validator);
  - a `Workspace` module (pure generators plus filesystem steps under a per-agent lock);
  - a `Vault` (AES-256-GCM);
  - an `AgentService` (create, edit, re-sync, archive);
  - credential, secret and project services, and a `CredentialVerifier`.
- S3's `AgentRuntime` now gets its spec from an injected `prepareStart`, and gains `requestRestart` (the S5 seam).
- The web gains the Templates, Agents (tree, new, edit) and Settings screens, plus additions to the session view.

**Tech Stack:** Node 24, TypeScript 7, Fastify 5, Drizzle + postgres.js, Zod 4, React 19 + TanStack Router/Query, Tailwind 4 + shadcn/ui, Vitest + Testing Library, Biome. The only new runtime dependency is `yaml` (server). The web adds shadcn `alert-dialog` (Radix comes from the installed `radix-ui`).

**Spec:** `docs/superpowers/specs/2026-11-19-s4-templates-workspace-design.md` (it wins over this plan on any conflict) and the UI design `docs/superpowers/designs/2026-11-19-s4-templates-agents-settings-ui-design.md`. Decision log: https://github.com/orlevii/open-factory/issues/28. Follow-ups that are NOT S4 work: #29–#36 and #18–#24, #26. Evidence: `packages/harness/fixtures/README.md`, section "Added in S4 design". Read it first.

## Global Constraints

- **Dependencies:**
  - Add a dependency with `pnpm --filter <pkg> add <name>@latest`, then check `npm view <name> version`. Never hand-pin.
  - **Never loosen the pnpm supply-chain policy** (`minimumReleaseAge` and friends). If an install is blocked by it, pick an older release that passes, or stop and report.
  - Never `pnpm dlx <tool>@latest`. shadcn components are added with the locked CLI: `pnpm --filter @open-factory/web exec shadcn add <component>`.
- **Package layout:**
  - All packages are ESM, Node >= 24, scope `@open-factory/*`.
  - `packages/*` have no build step; `exports` point at `.ts` source.
  - Biome is the only lint and format tool (`pnpm lint`, `pnpm lint:fix`, `pnpm lint:ci`).
- **Error shape:** `{ error: { code, message, fields? } }`. Codes added in S4:
  - `400 validation_error` with `fields`;
  - `404` `template_not_found`;
  - `409` `template_exists`, `changed_on_disk`, `slug_taken`, `folder_exists`, `template_invalid`, `template_missing`, `agent_archived`, `has_reports`, `manager_archived`, `credential_in_use`, `secret_name_reserved`, `project_in_use`, `credential_exists`, `secret_exists`, `project_exists`;
  - `422` `credential_rejected` and `credential_unverifiable`;
  - `502 plugin_install_failed`;
  - S3's `503 agent_start_failed` is reused.
- **Names:**
  - slug `^[a-z][a-z0-9-]{1,38}[a-z0-9]$`, reserved: `humans`, `me`, `scheduler`, `all`, `system`, `factory`;
  - template, project and credential name `^[a-z][a-z0-9-]{0,38}[a-z0-9]$`;
  - secret `^[A-Z_][A-Z0-9_]{0,63}$`, with reserved names per spec §11.3;
  - host skill `^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$`;
  - effort `low|medium|high|xhigh|max`.
- **Child env is an allowlist. This is a blocking requirement.**
  - Copied from the server env if set: `PATH HOME USER SHELL LANG LC_ALL LC_CTYPE TERM TMPDIR`.
  - Set by the factory: `CLAUDE_CONFIG_DIR`, exactly one of `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, each snapshot secret, and `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME` = slug, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL` = `<slug>@open-factory.local`.
  - Never `SSH_AUTH_SOCK`, `DATABASE_URL`, `FACTORY_SECRET_KEY`, or the server's own `ANTHROPIC_*` / `CLAUDE_*`.
  - Plugin CLI env: exactly `PATH HOME CLAUDE_CONFIG_DIR`.
  - Verification env: exactly `PATH HOME CLAUDE_CONFIG_DIR` plus the credential var.
- **Timings:**
  - stop = close stdin, `graceMs` 3000, SIGTERM, `termWaitMs` 10000;
  - plugin command timeout 120 s, whole install budget 240 s;
  - verification turn timeout 60 s, `model: "haiku"`, prompt `Reply with the single word OK.`.
- **Generated files:** `settings.json`, `.mcp.json` and the config-dir `CLAUDE.md` are rebuilt at every process start, written atomically (temp file plus rename). `CLAUDE.md` output is deterministic (no timestamps).
- **`autoMode`:** every list (`environment`, `allow`, `soft_deny`, `hard_deny`) starts with `"$defaults"`. Templates only add to it.
- **Command line:** `<claudeBin> -p --input-format stream-json --output-format stream-json --verbose (--permission-mode auto | --dangerously-skip-permissions) [--resume <id>] [--model <m>] [--effort <e>]`. Never `--mcp-config`/`--strict-mcp-config`.
- **No automated test calls a live model or the network.** The live check is `pnpm smoke:workspace`, run by hand with the token file `~/.open-factory-spike/oauth-token` read into the env at run time. Never print or commit it.
- **UI rules (DESIGN.md):**
  - orange only for live, focused or selected;
  - never `transition-all`;
  - type in rem;
  - status is always colour plus label;
  - no toasts;
  - confirmation dialogs only for Delete template, Delete credential and Delete secret;
  - long forms validate on blur and on submit;
  - UI copy never mentions roadmap IDs.
- `docs/product/` is gitignored and read-only: never edit it.
- **Commits:** commit after every task with a conventional message ending in `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Decisions this plan makes where the spec is silent

Each one is marked `PLAN DECISION:` where it's used and is listed again at the end.

1. **Runtime gets its spec through an injected `prepareStart(agent)`.** `AgentRuntime` stays decoupled from templates, the vault and the filesystem, and runtime tests stub it.
2. **The snapshot is stored as camelCase `TemplateConfig`.** `template.yaml` (snake_case) is parsed by `templateYamlSchema`, which transforms to `TemplateConfig`. The jsonb column is validated with `templateConfigSchema`.
3. **Credential, secret and project name collisions** return `409 credential_exists` / `secret_exists` (only POST credential; secret PUT is an upsert) / `project_exists`.
4. **Verification errors use `422`:** `credential_rejected` for an auth failure, `credential_unverifiable` for a transient one.
5. **The agents list** comes from `AgentService.list()` (a DB query merged with live runtime fields). `AgentRuntimes.list()` is removed.
6. **`agent_status` frames** gain `restartPending` and `restartWaitingOn`. The web folds them in the same way as `status`.
7. **`PUT /api/templates/:name/files/:file` with empty `content` for an optional file is still a write.** There's no "delete optional file" action in S4.
8. **The server's own `ANTHROPIC_API_KEY`** in the logger redact list covers the S3 shapes as well (`*.ANTHROPIC_API_KEY`, `*.env.ANTHROPIC_API_KEY`, `*.*.ANTHROPIC_API_KEY`).

## File Structure

```
packages/shared/src/
  names.ts            (new) patterns, reserved lists, Zod name schemas
  templates.ts        (new) templateYamlSchema → TemplateConfig, templateConfigSchema, issues, template API schemas
  settings.ts         (new) credentials, secrets, projects API schemas
  tree.ts             (new) treeOrder()
  agents.ts           (modify) AgentSummary fields, create/patch/resync bodies, list query
  events.ts           (modify) error.code/fix, turn_end.apiErrorStatus
  ws.ts               (modify) agent_status restartPending/restartWaitingOn
  index.ts            (modify) re-exports

packages/harness/
  src/types.ts        (modify) AgentRuntimeSpec runtime/permissionMode/mounts, Mount
  src/claude/args.ts  (modify) bypass flag
  src/claude/mapper.ts (modify) api_retry drop, error.code, apiErrorStatus, permission_decision derivation
  testing/fake-claude.mjs (modify) `plugin marketplace add|install` subcommands
  fixtures/pending/error-invalid-oauth-token.jsonl → fixtures/ (moved in Task 2)

packages/db/
  src/schema/agents.ts   (modify) agents columns
  src/schema/factory.ts  (new) templates, projects, credentials, secrets, agentProjectGrants
  src/schema/index.ts    (modify)
  migrations/0002_*.sql  generated, hand-edited (DELETE FROM agents first)

apps/server/src/
  config.ts                 (modify) drop claudeToken/devModel, add hostSkillsDir
  app.ts                    (modify) wiring, redact paths
  errors.ts                 (modify) ApiError, FieldError, validation fields
  crypto/vault.ts           (new) Vault
  templates/parse.ts        (new) YAML/JSON parse with line/column
  templates/validate.ts     (new) validateTemplate (the one validator)
  templates/template-index.ts (new) TemplateIndex
  workspace/paths.ts        (new) agentWorkdir, agentConfigDir, templateCopyDir, resyncDir
  workspace/settings.ts     (new) buildSettings, claudeMdExcludes, FACTORY_ENV entries
  workspace/mcp.ts          (new) buildMcpJson
  workspace/claude-md.ts    (new) buildClaudeMd
  workspace/mounts.ts       (new) buildMounts
  workspace/links.ts        (new) resolveHostSkills, linkProjects
  workspace/plugins.ts      (new) installPlugins, redactOutput
  workspace/files.ts        (new) copyTemplateFiles, writeAtomic, backupDiffering
  workspace/lock.ts         (new) KeyedMutex
  workspace/workspace.ts    (new) Workspace (materialize, resync, prepare)
  agents/runtime-spec.ts    (modify) buildAgentEnv extended, buildRuntimeSpec(ctx)
  agents/start.ts           (new) createPrepareStart()
  agents/errors.ts          (modify) AgentStartError.fix, AgentArchivedError
  agents/agent-runtime.ts   (modify) prepareStart, reload, archived, restart machinery
  agents/runtimes.ts        (modify) refresh, requestRestart, liveFields; list removed
  agents/agent-service.ts   (new) AgentService
  agents/seed-dev.ts        (delete)
  credentials/verify.ts     (new) CredentialVerifier
  credentials/credential-service.ts (new)
  secrets/secret-service.ts (new)
  projects/project-service.ts (new)
  routes/templates.ts, routes/credentials.ts, routes/secrets.ts, routes/projects.ts (new)
  routes/agents.ts          (modify) create/patch/resync/archive/unarchive, list query
  test/helpers.ts           (modify) seedTestAgent replaces seed
apps/server/scripts/
  seed-dev-agent.ts (delete), reset-session.ts (new), smoke-harness.ts (modify), smoke-workspace.ts (new)

apps/web/src/
  components/field-shell.tsx, form-field.tsx (modify), native-select.tsx, password-input.tsx,
  inline-outcome.tsx, confirm-dialog.tsx, middle-truncate.tsx, ui/alert-dialog.tsx (shadcn)
  features/templates/{api.ts, template-list.tsx, template-editor.tsx, code-textarea.tsx, issue-list.tsx}
  features/agents/{api.ts, agent-tree.tsx, agent-form.tsx, project-grant-picker.tsx, agent-actions.tsx, prerequisites.tsx}
  features/settings/{api.ts, credentials-section.tsx, secrets-section.tsx, projects-section.tsx}
  features/session/{agent-strip.tsx, timeline-row.tsx, tool-call-row.tsx, session-view.tsx, use-agent-status.ts} (modify)
  routes/_app/templates.index.tsx, templates.new.tsx, templates.$name.tsx (templates.tsx removed),
  agents.new.tsx, agents.$slug.edit.tsx, agents.index.tsx (modify), settings.tsx (modify)
```

---

### Task 1: Shared names, templates, settings and agent schemas

**Files:**
- Create: `packages/shared/src/names.ts`, `packages/shared/src/templates.ts`, `packages/shared/src/settings.ts`, `packages/shared/src/tree.ts`
- Modify: `packages/shared/src/agents.ts`, `packages/shared/src/events.ts`, `packages/shared/src/ws.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/names.test.ts`, `packages/shared/src/templates.test.ts`, `packages/shared/src/tree.test.ts`, `packages/shared/src/events.test.ts` (extend)

**Interfaces:**
- Produces:
  - `SLUG_PATTERN`, `NAME_PATTERN`, `SECRET_NAME_PATTERN`, `HOST_SKILL_PATTERN`, `RESERVED_SLUGS`, `isReservedSecretName(name): boolean`, `slugSchema`, `nameSchema`, `secretNameSchema`;
  - `EFFORTS`, `TEMPLATE_FILES`, `type TemplateFile`, `templateYamlSchema` (input snake_case → output `TemplateConfig`), `templateConfigSchema`, `type TemplateConfig`, `templateIssueSchema`, `type TemplateIssue`, the template API schemas;
  - the settings API schemas;
  - `treeOrder(rows: {slug; displayName; reportsTo: string | null}[]): {slug: string; depth: number}[]`;
  - `agentSummarySchema` with the new fields;
  - `createAgentBodySchema`, `patchAgentBodySchema`, `agentResponseSchema`, `resyncResponseSchema`, `agentListQuerySchema`;
  - `error` events with optional `code` and `fix`, and `turn_end` with optional `apiErrorStatus`.

- [ ] **Step 1: Write the failing tests**

`packages/shared/src/names.test.ts`:

```ts
import { expect, test } from "vitest";
import { isReservedSecretName, nameSchema, RESERVED_SLUGS, secretNameSchema, slugSchema } from "./names.ts";

test("slug rules", () => {
  for (const ok of ["ab", "team-lead", "a1-b2"]) expect(slugSchema.safeParse(ok).success).toBe(true);
  for (const bad of ["a", "-ab", "ab-", "Ab", "a_b", "a".repeat(41), "humans", "me", "scheduler", "all", "system", "factory"])
    expect(slugSchema.safeParse(bad).success).toBe(false);
  expect(RESERVED_SLUGS).toEqual(["humans", "me", "scheduler", "all", "system", "factory"]);
});

test("names and secret names", () => {
  expect(nameSchema.safeParse("app").success).toBe(true);
  expect(nameSchema.safeParse("x").success).toBe(false);
  expect(secretNameSchema.safeParse("GH_TOKEN").success).toBe(true);
  for (const bad of ["gh_token", "1A", "PATH", "HOME", "LC_ALL", "LD_PRELOAD", "DYLD_X", "CLAUDE_X", "ANTHROPIC_API_KEY", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "NODE_OPTIONS"])
    expect(secretNameSchema.safeParse(bad).success).toBe(false);
  expect(isReservedSecretName("TMPDIR")).toBe(true);
  expect(isReservedSecretName("GH_TOKEN")).toBe(false);
});
```

`packages/shared/src/templates.test.ts`:

```ts
import { expect, test } from "vitest";
import { templateConfigSchema, templateYamlSchema } from "./templates.ts";

test("defaults and camelCase output", () => {
  const c = templateYamlSchema.parse({ name: "tech-lead", display_name: "Tech Lead" });
  expect(c).toEqual({
    name: "tech-lead", displayName: "Tech Lead", description: "", runtime: "docker",
    permissionMode: "auto", projects: [], skills: [], localSkills: true, plugins: [], secrets: [],
    canSpawn: [], maxLiveSpawns: 5, warmWindowMinutes: 70,
  });
  expect(templateConfigSchema.parse(c)).toEqual(c);
});

test("strict: unknown keys and bad values are errors", () => {
  expect(templateYamlSchema.safeParse({ name: "x1", display_name: "X", modle: "opus" }).success).toBe(false);
  expect(templateYamlSchema.safeParse({ name: "x1", display_name: "X", effort: "huge" }).success).toBe(false);
  expect(templateYamlSchema.safeParse({ name: "x1", display_name: "X", skills: [".."] }).success).toBe(false);
  expect(templateYamlSchema.safeParse({ name: "x1", display_name: "X", plugins: ["nomarket"] }).success).toBe(false);
  expect(templateYamlSchema.safeParse({ name: "x1", display_name: "X", secrets: ["PATH"] }).success).toBe(false);
});
```

`packages/shared/src/tree.test.ts`:

```ts
import { expect, test } from "vitest";
import { treeOrder } from "./tree.ts";

test("depth-first, siblings by display name, unknown managers are roots", () => {
  const rows = [
    { slug: "dev", displayName: "Dev", reportsTo: "lead" },
    { slug: "lead", displayName: "Lead", reportsTo: null },
    { slug: "alpha", displayName: "Alpha", reportsTo: "lead" },
    { slug: "orphan", displayName: "Orphan", reportsTo: "archived-boss" },
  ];
  expect(treeOrder(rows)).toEqual([
    { slug: "lead", depth: 0 }, { slug: "alpha", depth: 1 }, { slug: "dev", depth: 1 }, { slug: "orphan", depth: 0 },
  ]);
});
```

Append to `packages/shared/src/events.test.ts`:

```ts
test("S4 additions: error code/fix and turn_end apiErrorStatus", () => {
  expect(anyEventSchema.safeParse({ type: "error", source: "api", message: "x", code: "authentication_failed" }).success).toBe(true);
  expect(anyEventSchema.safeParse({ type: "error", source: "spawn", message: "x", fix: "secrets" }).success).toBe(true);
  expect(anyEventSchema.safeParse({ type: "error", source: "spawn", message: "x", fix: "nope" }).success).toBe(false);
  expect(anyEventSchema.safeParse({ type: "turn_end", isError: true, numTurns: 1, apiErrorStatus: 401 }).success).toBe(true);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run packages/shared`
Expected: FAIL, because the `names.ts`, `templates.ts` and `tree.ts` modules don't exist and the new event fields are rejected.

- [ ] **Step 3: Implement**

`packages/shared/src/names.ts`:

```ts
import { z } from "zod";
import { RESERVED_HANDLES } from "./handle.ts";

export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
export const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const HOST_SKILL_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
export const RESERVED_SLUGS = [...RESERVED_HANDLES, "all", "system", "factory"] as const;

const RESERVED_SECRET_EXACT = new Set(["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR", "NODE_OPTIONS"]);
const RESERVED_SECRET_PREFIXES = ["LC_", "LD_", "DYLD_", "CLAUDE_", "ANTHROPIC_", "GIT_AUTHOR_", "GIT_COMMITTER_"];
export const isReservedSecretName = (n: string) =>
  RESERVED_SECRET_EXACT.has(n) || RESERVED_SECRET_PREFIXES.some((p) => n.startsWith(p));

export const slugSchema = z
  .string()
  .regex(SLUG_PATTERN, "Use 3–40 lowercase letters, numbers and inner hyphens, starting with a letter.")
  .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), "That slug is reserved.");
export const nameSchema = z
  .string()
  .regex(NAME_PATTERN, "Use 2–40 lowercase letters, numbers and inner hyphens, starting with a letter.");
export const secretNameSchema = z
  .string()
  .regex(SECRET_NAME_PATTERN, "Use uppercase letters, numbers and underscores, like GH_TOKEN.")
  .refine((n) => !isReservedSecretName(n), "That name is reserved for the agent's environment.");
export const hostSkillSchema = z.string().regex(HOST_SKILL_PATTERN, "Not a valid skill folder name.");
```

`packages/shared/src/templates.ts`:

```ts
import { z } from "zod";
import { hostSkillSchema, nameSchema, secretNameSchema } from "./names.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const TEMPLATE_FILES = ["template.yaml", "AGENTS.md", "settings.json", "mcp.json"] as const;
export type TemplateFile = (typeof TEMPLATE_FILES)[number];
export const templateFileSchema = z.enum(TEMPLATE_FILES);

const pluginRef = z.string().regex(/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/, "Use name@marketplace.");

export const templateConfigSchema = z.object({
  name: nameSchema,
  displayName: z.string().min(1).max(80),
  description: z.string().max(500),
  runtime: z.enum(["docker", "local"]),
  image: z.string().min(1).optional(),
  permissionMode: z.enum(["auto", "bypass"]),
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORTS).optional(),
  projects: z.array(nameSchema),
  skills: z.array(hostSkillSchema),
  localSkills: z.boolean(),
  plugins: z.array(pluginRef),
  secrets: z.array(secretNameSchema),
  canSpawn: z.array(nameSchema),
  maxLiveSpawns: z.number().int().min(0).max(50),
  warmWindowMinutes: z.number().int().min(1).max(1440),
});
export type TemplateConfig = z.infer<typeof templateConfigSchema>;

/** template.yaml as written (snake_case, strict), transformed into TemplateConfig. */
export const templateYamlSchema = z
  .strictObject({
    name: nameSchema,
    display_name: z.string().min(1).max(80),
    description: z.string().max(500).default(""),
    runtime: z.enum(["docker", "local"]).default("docker"),
    image: z.string().min(1).optional(),
    permission_mode: z.enum(["auto", "bypass"]).default("auto"),
    model: z.string().min(1).optional(),
    effort: z.enum(EFFORTS).optional(),
    projects: z.array(nameSchema).default([]),
    skills: z.array(hostSkillSchema).default([]),
    local_skills: z.boolean().default(true),
    plugins: z.array(pluginRef).default([]),
    secrets: z.array(secretNameSchema).default([]),
    can_spawn: z.array(nameSchema).default([]),
    max_live_spawns: z.number().int().min(0).max(50).default(5),
    warm_window_minutes: z.number().int().min(1).max(1440).default(70),
  })
  .transform(
    (y): TemplateConfig => ({
      name: y.name,
      displayName: y.display_name,
      description: y.description,
      runtime: y.runtime,
      ...(y.image ? { image: y.image } : {}),
      permissionMode: y.permission_mode,
      ...(y.model ? { model: y.model } : {}),
      ...(y.effort ? { effort: y.effort } : {}),
      projects: y.projects,
      skills: y.skills,
      localSkills: y.local_skills,
      plugins: y.plugins,
      secrets: y.secrets,
      canSpawn: y.can_spawn,
      maxLiveSpawns: y.max_live_spawns,
      warmWindowMinutes: y.warm_window_minutes,
    }),
  );

export const templateIssueSchema = z.object({
  severity: z.enum(["error", "warning"]),
  file: z.enum([...TEMPLATE_FILES, "skills", "files"]),
  message: z.string(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  path: z.string().optional(),
});
export type TemplateIssue = z.infer<typeof templateIssueSchema>;

export const templateSummarySchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  runtime: z.enum(["docker", "local"]).optional(),
  errors: z.number().int(),
  warnings: z.number().int(),
  agentCount: z.number().int(),
});
export const templatesListSchema = z.object({ dir: z.string(), templates: z.array(templateSummarySchema) });
export const templateFileStateSchema = z.object({
  file: templateFileSchema,
  content: z.string().nullable(),
  hash: z.string().nullable(),
});
export const templateDetailSchema = z.object({
  name: z.string(),
  path: z.string(),
  config: templateConfigSchema.optional(),
  files: z.array(templateFileStateSchema),
  issues: z.array(templateIssueSchema),
  agents: z.array(z.string()),
});
export type TemplateDetail = z.infer<typeof templateDetailSchema>;
export const templateDetailResponseSchema = z.object({ template: templateDetailSchema });
export const createTemplateBodySchema = z.object({
  name: nameSchema,
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
});
export const putTemplateFileBodySchema = z.object({
  content: z.string().max(512 * 1024),
  baseHash: z.string().nullable(),
});
export const putTemplateFileResponseSchema = z.object({ hash: z.string(), issues: z.array(templateIssueSchema) });
export const validateTemplateBodySchema = z.object({ file: templateFileSchema, content: z.string().max(512 * 1024) });
export const issuesResponseSchema = z.object({ issues: z.array(templateIssueSchema) });
```

`packages/shared/src/settings.ts`:

```ts
import { z } from "zod";
import { nameSchema, secretNameSchema } from "./names.ts";

export const credentialKindSchema = z.enum(["oauth_token", "api_key"]);
export type CredentialKind = z.infer<typeof credentialKindSchema>;
const secretValue = (max: number) => z.string().trim().min(1, "Enter a value.").max(max);

export const credentialSummarySchema = z.object({
  name: z.string(),
  kind: credentialKindSchema,
  lastVerifiedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  usedBy: z.array(z.string()),
  archivedUsedBy: z.array(z.string()),
});
export type CredentialSummary = z.infer<typeof credentialSummarySchema>;
export const credentialsListSchema = z.object({ credentials: z.array(credentialSummarySchema) });
export const createCredentialBodySchema = z.object({ name: nameSchema, kind: credentialKindSchema, value: secretValue(4096) });
export const replaceCredentialValueBodySchema = z.object({ value: secretValue(4096) });
export const credentialResponseSchema = z.object({ credential: credentialSummarySchema });

export const secretSummarySchema = z.object({ name: z.string(), updatedAt: z.string(), usedBy: z.array(z.string()) });
export type SecretSummary = z.infer<typeof secretSummarySchema>;
export const secretsListSchema = z.object({ secrets: z.array(secretSummarySchema) });
export const putSecretBodySchema = z.object({ value: z.string().min(1, "Enter a value.").max(64 * 1024) });
export const secretParamsSchema = z.object({ name: secretNameSchema });

export const projectSummarySchema = z.object({
  name: z.string(),
  hostPath: z.string(),
  grantedTo: z.array(z.string()),
  archivedGrantedTo: z.array(z.string()),
  templates: z.array(z.string()),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export const projectsListSchema = z.object({ projects: z.array(projectSummarySchema) });
export const createProjectBodySchema = z.object({ name: nameSchema, hostPath: z.string().trim().min(1) });
export const patchProjectBodySchema = z.object({ hostPath: z.string().trim().min(1) });
export const projectResponseSchema = z.object({ project: projectSummarySchema });
```

`packages/shared/src/tree.ts`:

```ts
export interface TreeRow { slug: string; displayName: string; reportsTo: string | null }

/** Depth-first from the roots (agents whose manager isn't in `rows`), siblings by display name. */
export function treeOrder(rows: TreeRow[]): { slug: string; depth: number }[] {
  const bySlug = new Set(rows.map((r) => r.slug));
  const children = new Map<string | null, TreeRow[]>();
  for (const r of rows) {
    const parent = r.reportsTo && bySlug.has(r.reportsTo) ? r.reportsTo : null;
    children.set(parent, [...(children.get(parent) ?? []), r]);
  }
  const out: { slug: string; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    const kids = [...(children.get(parent) ?? [])].sort((a, b) =>
      a.displayName.localeCompare(b.displayName) || a.slug.localeCompare(b.slug),
    );
    for (const k of kids) {
      out.push({ slug: k.slug, depth });
      walk(k.slug, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
```

In `packages/shared/src/agents.ts`, replace `agentSummarySchema` and add the bodies:

```ts
export const agentSummarySchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  status: agentStatusSchema,
  turnOpen: z.boolean(),
  runtime: z.enum(["local", "docker"]),
  lastError: z.string().optional(),
  kind: z.literal("persistent"),
  template: z.string(),
  reportsTo: z.string().nullable(),
  credential: z.string(),
  projects: z.array(z.string()),
  grantsOverridden: z.boolean(),
  depth: z.number().int().nonnegative(),
  archivedAt: z.string().nullable(),
  restartPending: z.boolean(),
  restartWaitingOn: z.number().int().nonnegative(),
});

export const agentListQuerySchema = z.object({ archived: z.enum(["exclude", "include", "only"]).default("exclude") });
export const createAgentBodySchema = z.object({
  template: nameSchema,
  slug: slugSchema,
  displayName: z.string().trim().min(1, "Enter a display name.").max(80),
  description: z.string().trim().max(500),
  reportsTo: slugSchema.nullable(),
  credential: nameSchema,
  projects: z.array(nameSchema).optional(),
});
export const patchAgentBodySchema = z
  .object({
    displayName: z.string().trim().min(1, "Enter a display name.").max(80),
    description: z.string().trim().max(500),
    reportsTo: slugSchema.nullable(),
    credential: nameSchema,
    projects: z.array(nameSchema).nullable(),
  })
  .partial();
export const agentResponseSchema = z.object({ agent: agentSummarySchema });
export const resyncResponseSchema = z.object({ agent: agentSummarySchema, backupDir: z.string().optional() });
```

(Import `nameSchema`, `slugSchema` from `./names.ts`.)

In `packages/shared/src/events.ts`:
- Extend the `error` object with `code: z.string().optional()` and `fix: z.enum(["credentials", "secrets", "projects", "edit_agent"]).optional()`.
- Extend `turn_end` with `apiErrorStatus: z.number().int().optional()`.

In `packages/shared/src/ws.ts`, add `restartPending: z.boolean()` and `restartWaitingOn: z.number().int().nonnegative()` to `agentStatusFrameSchema`.

In `packages/shared/src/index.ts`, re-export `names.ts`, `templates.ts`, `settings.ts` and `tree.ts`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm vitest run packages/shared && pnpm -r --filter @open-factory/shared exec tsc --noEmit`
Expected: PASS. The server and web won't typecheck yet (the new `AgentSummary` fields); later tasks fix that. Don't run the root typecheck until Task 13.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): template, settings and name schemas for S4

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Mapper — api_retry, error code, apiErrorStatus and deny-rule derivation

**Files:**
- Modify: `packages/harness/src/claude/mapper.ts`
- Move: `packages/harness/fixtures/pending/error-invalid-oauth-token.jsonl` → `packages/harness/fixtures/error-invalid-oauth-token.jsonl` (and remove the empty `pending/` dir); update `packages/harness/fixtures/README.md` (drop the `pending/` prefix and its note)
- Test: `packages/harness/src/claude/mapper.test.ts`

**Interfaces:**
- Consumes: the Task 1 event fields.
- Produces:
  - `error{code?}` from a synthetic assistant `error`;
  - `turn_end{apiErrorStatus?}` from `result.api_error_status`;
  - `permission_denied{reasonType}` derived from `tool_result_meta` (live) and `result.permission_denials` (fallback);
  - `system/api_retry` dropped.

- [ ] **Step 1: Move the fixture and write the failing tests**

```bash
git mv packages/harness/fixtures/pending/error-invalid-oauth-token.jsonl packages/harness/fixtures/error-invalid-oauth-token.jsonl
rmdir packages/harness/fixtures/pending
```

In the README's S4 table, rename the row to `error-invalid-oauth-token` and delete the sentence "Kept in `pending/` … next to the others".

Append to `packages/harness/src/claude/mapper.test.ts` (it uses the file's existing `mapFixture` and `ofType` helpers):

```ts
test("error-invalid-oauth-token: api_retry dropped; error code and apiErrorStatus", () => {
  const { events, unmapped } = mapFixture("error-invalid-oauth-token");
  expect(unmapped).toEqual([]);
  const errors = ofType(events, "error");
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ source: "api", code: "authentication_failed" });
  expect(ofType(events, "turn_end")[0]).toMatchObject({ isError: true, apiErrorStatus: 401 });
});

test("permission-deny-rules: one system denial, one derived from tool_result_meta, no duplicates", () => {
  const { events } = mapFixture("permission-deny-rules");
  const denials = ofType(events, "permission_denied");
  expect(denials).toHaveLength(2);
  expect(denials[0]).toMatchObject({ toolName: "Bash", reasonType: "subcommandResults" });
  expect(denials[1]).toMatchObject({
    toolName: "Read",
    reasonType: "rule",
    reason: "File is in a directory that is denied by your permission settings.",
  });
  // the derived denial precedes its tool_result
  const types = events.map((e) => e.type);
  const readDenial = types.indexOf("permission_denied", types.indexOf("permission_denied") + 1);
  expect(types[readDenial + 1]).toBe("tool_result");
});

test("permission-denied (classifier): no derived duplicate", () => {
  const { events } = mapFixture("permission-denied");
  const ids = ofType(events, "permission_denied").map((d) => d.toolUseId);
  expect(new Set(ids).size).toBe(ids.length);
});

test("permission_denials fallback on result for an unreported id", () => {
  const s = createMapperState({ resumed: false });
  mapLine({ type: "system", subtype: "init", session_id: "s", model: "m" }, s);
  mapLine({ type: "assistant", message: { model: "m", content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }] } }, s);
  const out = mapLine({ type: "result", is_error: false, num_turns: 1, permission_denials: [{ tool_name: "Edit", tool_use_id: "t1" }] }, s);
  expect(out[0]).toEqual({ type: "permission_denied", toolName: "Edit", toolUseId: "t1", reasonType: "rule", reason: "Denied by a permission rule" });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run packages/harness/src/claude/mapper.test.ts`
Expected:
- FAIL: `system/api_retry` is unmapped (the all-fixtures test now includes the moved fixture);
- the `error` event has no `code`;
- there's one denial instead of two in `permission-deny-rules`.

- [ ] **Step 3: Implement in `mapper.ts`**

1. Add `"api_retry"` to `DROPPED_SYSTEM`.
2. Extend `MapperState` and `createMapperState` with `toolNames: Map<string, string>` and `deniedIds: Set<string>` (per process, never reset).
3. In the `system` switch's `permission_denied` case, add `s.deniedIds.add(String(e.tool_use_id ?? ""))` before returning.
4. In `assistant()`, record `s.toolNames.set(String(b.id), String(b.name))` for every `tool_use` block. Pass the code into the synthetic error:

```ts
  if (msg.model === "<synthetic>") {
    if (e.local_command_source) return [];
    if (e.error || msg.stop_reason === "refusal")
      return errorOnce(
        s,
        msg.stop_reason === "refusal" ? "refusal" : "api",
        textOf(msg.content) || String(e.error),
        undefined,
        typeof e.error === "string" ? e.error : undefined,
      );
    return [];
  }
```

and give `errorOnce` a fifth parameter `code?: string`, which adds `...(code ? { code } : {})`.

5. In `user()`, before pushing each `tool_result`, derive a live denial:

```ts
const stripToolUseError = (t: string) => t.replace(/<\/?tool_use_error>/g, "").trim();

    const meta = Array.isArray(e.tool_result_meta)
      ? e.tool_result_meta.find((m: Json) => String(m?.id) === String(b.tool_use_id))
      : undefined;
    const id = String(b.tool_use_id);
    if (meta?.permission_decision?.decision === "reject" && !s.deniedIds.has(id)) {
      s.deniedIds.add(id);
      out.push({
        type: "permission_denied",
        toolName: s.toolNames.get(id) ?? "",
        toolUseId: id,
        reasonType: String(meta.permission_decision.reason_type ?? "rule"),
        reason: stripToolUseError(textOf(b.content)) || "Denied by a permission rule",
      });
    }
```

6. In `result()`, after the `!s.sawInit` branch and before the `api_error` push, emit the fallback denials:

```ts
  for (const d of Array.isArray(e.permission_denials) ? e.permission_denials : []) {
    const id = String(d?.tool_use_id ?? "");
    if (!id || s.deniedIds.has(id)) continue;
    s.deniedIds.add(id);
    out.push({
      type: "permission_denied",
      toolName: String(d.tool_name ?? s.toolNames.get(id) ?? ""),
      toolUseId: id,
      reasonType: "rule",
      reason: "Denied by a permission rule",
    });
  }
```

And in the `turn_end` push, add `...(typeof e.api_error_status === "number" ? { apiErrorStatus: e.api_error_status } : {})`.

- [ ] **Step 4: Run all harness tests**

Run: `pnpm vitest run packages/harness`
Expected: PASS. If an inline snapshot of an existing fixture changes only because of new `permission_denied` events, re-read it, confirm the new event is one of the fallback or live cases above, and update it with `-u`.

- [ ] **Step 5: Commit**

```bash
git add packages/harness
git commit -m "feat(harness): derive deny-rule denials, error code and api error status

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: AgentRuntimeSpec runtime, permission mode and mounts

**Files:**
- Modify: `packages/harness/src/types.ts`, `packages/harness/src/claude/args.ts`
- Test: `packages/harness/src/claude/args.test.ts` (create if absent; otherwise extend `process.test.ts`'s arg assertions)

**Interfaces:**
- Produces:

```ts
export interface Mount { source: string; target: string; readOnly: boolean }
export interface AgentRuntimeSpec {
  agentId: string; slug: string; cwd: string; env: Record<string, string>; claudeBin: string;
  runtime: "local" | "docker";
  model?: string; effort?: string;
  permissionMode: "auto" | "bypass";
  mounts: Mount[];
}
```

- [ ] **Step 1: Write the failing test** (`packages/harness/src/claude/args.test.ts`)

```ts
import { expect, test } from "vitest";
import type { AgentRuntimeSpec } from "../types.ts";
import { buildClaudeArgs } from "./args.ts";

const spec = (p: Partial<AgentRuntimeSpec> = {}): AgentRuntimeSpec => ({
  agentId: "a", slug: "a", cwd: "/w", env: {}, claudeBin: "claude", runtime: "local",
  permissionMode: "auto", mounts: [], ...p,
});

test("auto mode", () => {
  expect(buildClaudeArgs(spec({ model: "haiku", effort: "high" }), { resumeSessionId: "s1" })).toEqual([
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "auto", "--resume", "s1", "--model", "haiku", "--effort", "high",
  ]);
});
test("bypass uses --dangerously-skip-permissions and no --permission-mode", () => {
  const a = buildClaudeArgs(spec({ permissionMode: "bypass" }), {});
  expect(a).toContain("--dangerously-skip-permissions");
  expect(a).not.toContain("--permission-mode");
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run packages/harness/src/claude/args.test.ts`
Expected: a TypeScript or assertion FAIL (`runtime`/`mounts` aren't in the type; `bypass` isn't handled).

- [ ] **Step 3: Implement**

Update `types.ts` as in **Produces** (export `Mount`). In `args.ts`:

```ts
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  if (spec.permissionMode === "bypass") args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", "auto");
```

Fix the other harness call sites and tests that build an `AgentRuntimeSpec` (`process.test.ts`, `fake-claude.test.ts`) by adding `runtime: "local", mounts: []`.

- [ ] **Step 4: Run the harness tests**

Run: `pnpm vitest run packages/harness`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/harness
git commit -m "feat(harness): runtime, bypass mode and mounts on the runtime spec

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Database tables and the clean-cutover migration

**Files:**
- Create: `packages/db/src/schema/factory.ts`
- Modify: `packages/db/src/schema/agents.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/index.ts` (row types)
- Generate: `packages/db/migrations/0002_*.sql` (then hand-edit)
- Test: `packages/db/src/migrate.test.ts` (extend)

**Interfaces:**
- Produces:
  - tables `templates`, `projects`, `credentials`, `secrets`, `agentProjectGrants`;
  - `agents` columns `kind`, `template`, `config` (jsonb `TemplateConfig`), `runtime`, `reportsTo`, `credentialId`, `grantsOverridden`, `archivedAt`;
  - row types `TemplateRow`, `ProjectRow`, `CredentialRow`, `SecretRow`.

- [ ] **Step 1: Write the failing migration test** (append to `packages/db/src/migrate.test.ts`, which already creates throwaway databases)

```ts
test("0002 deletes pre-S4 agents (with their events) and adds the S4 tables", async () => {
  const tdb = await createTestDatabase();
  try {
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"));
    // migrate to 0001 only, using a temp folder with the first two migrations
    const tmp = mkdtempSync(path.join(tmpdir(), "mig-"));
    mkdirSync(path.join(tmp, "meta"));
    for (const e of journal.entries.slice(0, 2)) copyFileSync(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(tmp, `${e.tag}.sql`));
    writeFileSync(path.join(tmp, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 2) }));
    await migrate(tdb.url, tmp);
    const { sql, close } = createDb(tdb.url);
    await sql`insert into agents (id, slug, display_name) values ('a1', 'dev', 'Dev agent')`;
    await sql`insert into session_events (agent_id, seq, type, payload) values ('a1', 1, 'process_started', '{}')`;
    await close();
    await migrate(tdb.url, MIGRATIONS_DIR);
    const h = createDb(tdb.url);
    expect(await h.sql`select count(*)::int as n from agents`).toEqual([{ n: 0 }]);
    expect(await h.sql`select count(*)::int as n from session_events`).toEqual([{ n: 0 }]);
    const tables = await h.sql`select table_name from information_schema.tables where table_schema = 'public'`;
    for (const t of ["templates", "projects", "credentials", "secrets", "agent_project_grants"])
      expect(tables.map((r) => r.table_name)).toContain(t);
    await h.close();
  } finally {
    await tdb.drop();
  }
});
```

(Add the needed imports: `copyFileSync`, `mkdirSync`, `mkdtempSync`, `readFileSync`, `writeFileSync` from `node:fs`; `tmpdir` from `node:os`; `path`; `createDb`, `MIGRATIONS_DIR`, `migrate`; `createTestDatabase` from `./testing.ts`. Check the existing test's import style first.)

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run packages/db/src/migrate.test.ts`
Expected: FAIL (there's no third migration and the tables are missing).

- [ ] **Step 3: Implement the schema**

`packages/db/src/schema/factory.ts`:

```ts
import { boolean, customType, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { TemplateConfig, TemplateIssue } from "@open-factory/shared";
import { agents } from "./agents.ts";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const ts = (n: string) => timestamp(n, { withTimezone: true });

export const templates = pgTable("templates", {
  name: text("name").primaryKey(),
  path: text("path").notNull(),
  config: jsonb("config").$type<TemplateConfig>(),
  issues: jsonb("issues").$type<TemplateIssue[]>().notNull().default([]),
  contentHash: text("content_hash").notNull(),
  scannedAt: ts("scanned_at").notNull(),
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  hostPath: text("host_path").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
});

export const credentials = pgTable("credentials", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  kind: text("kind").notNull().$type<"oauth_token" | "api_key">(),
  valueEnc: bytea("value_enc").notNull(),
  lastVerifiedAt: ts("last_verified_at"),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
});

export const secrets = pgTable("secrets", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  valueEnc: bytea("value_enc").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
});

export const agentProjectGrants = pgTable(
  "agent_project_grants",
  {
    agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.projectId] })],
);

export type TemplateRow = typeof templates.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type CredentialRow = typeof credentials.$inferSelect;
export type SecretRow = typeof secrets.$inferSelect;
```

`packages/db` needs `@open-factory/shared` as a dependency for the two types. Add it with `pnpm --filter @open-factory/db add @open-factory/shared@workspace:*`.

In `agents.ts`, add to `agents`:

```ts
  kind: text("kind").notNull().default("persistent"),
  template: text("template").notNull(),
  config: jsonb("config").$type<TemplateConfig>().notNull(),
  runtime: text("runtime").notNull().$type<"local" | "docker">(),
  reportsTo: text("reports_to").references((): AnyPgColumn => agents.id, { onDelete: "restrict" }),
  credentialId: text("credential_id").notNull().references(() => credentials.id, { onDelete: "restrict" }),
  grantsOverridden: boolean("grants_overridden").notNull().default(false),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
```

(Import `credentials` from `./factory.ts` and `AnyPgColumn`. If the circular import trips drizzle-kit, move `credentials` into `agents.ts` and re-export it from `factory.ts`.)

Export everything from `schema/index.ts` and the row types from `src/index.ts`.

- [ ] **Step 4: Generate and hand-edit the migration**

Run: `pnpm db:generate`.

Open the new `packages/db/migrations/0002_*.sql` and put this at the very top, before the first `ALTER TABLE "agents" ADD COLUMN … NOT NULL`:

```sql
-- S4 clean cutover: pre-S4 agents (the S3 dev seed) have no template or credential, and v0.0.1 is unreleased.
-- Their session_events, turns and messages cascade. FACTORY_HOME/agents/<slug>/ folders stay on disk.
DELETE FROM "agents";--> statement-breakpoint
```

Keep drizzle's `--> statement-breakpoint` separators intact. Check that `meta/0002_snapshot.json` was written.

- [ ] **Step 5: Run the DB tests**

Run: `pnpm vitest run packages/db`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db pnpm-lock.yaml
git commit -m "feat(db): templates, projects, credentials, secrets and agent grants

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Config, vault and API errors

**Files:**
- Create: `apps/server/src/crypto/vault.ts`, `apps/server/src/crypto/vault.test.ts`
- Modify:
  - `apps/server/src/config.ts`, `apps/server/src/config.test.ts`;
  - `apps/server/src/errors.ts`, plus a new `apps/server/src/errors.test.ts`;
  - `apps/server/src/app.ts` (redact paths only);
  - `.env.example`.

**Interfaces:**
- Produces:
  - `Config.hostSkillsDir: string`; `Config.claudeToken` and `Config.devModel` are **removed**;
  - `class Vault { constructor(rootKey: string); seal(plaintext: string, aad: string): Buffer; open(blob: Buffer, aad: string): string }` and `class VaultError extends Error`;
  - `class ApiError extends Error { constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) }`;
  - `class FieldError extends ApiError { constructor(field: string, message: string, code = "validation_error") }` (status 400, `fields: {[field]: message}`). The error handler renders `extra` keys next to `code`/`message`.

> Removing `claudeToken` breaks `runtime-spec.ts`, `agent-runtime.ts`, `seed-dev.ts` and their tests until Task 12. Keep them compiling in this task with a local stand-in: in `runtime-spec.ts`, change `resolveClaudeToken(config)` to `return process.env.CLAUDE_CODE_OAUTH_TOKEN`, with the comment `// removed in Task 12`. In `smoke-harness.ts`, stop passing `FACTORY_DEV_MODEL`; the runtime's `config.devModel` read becomes `undefined`. Task 12 deletes all of it.

- [ ] **Step 1: Write the failing tests**

`apps/server/src/crypto/vault.test.ts`:

```ts
import { expect, test } from "vitest";
import { Vault, VaultError } from "./vault.ts";

const v = new Vault("k".repeat(40));
test("round trip, version byte and random nonce", () => {
  const a = v.seal("sk-ant-oat01-secret", "credentials:c1");
  const b = v.seal("sk-ant-oat01-secret", "credentials:c1");
  expect(a[0]).toBe(1);
  expect(a.equals(b)).toBe(false);
  expect(v.open(a, "credentials:c1")).toBe("sk-ant-oat01-secret");
  expect(a.includes(Buffer.from("sk-ant"))).toBe(false);
});
test("wrong AAD, tampering, wrong key, unknown version fail", () => {
  const a = v.seal("x", "secrets:s1");
  expect(() => v.open(a, "secrets:s2")).toThrow(VaultError);
  const t = Buffer.from(a); t[t.length - 1] ^= 1;
  expect(() => v.open(t, "secrets:s1")).toThrow(VaultError);
  expect(() => new Vault("z".repeat(40)).open(a, "secrets:s1")).toThrow(VaultError);
  const w = Buffer.from(a); w[0] = 2;
  expect(() => v.open(w, "secrets:s1")).toThrow(VaultError);
});
```

Append to `apps/server/src/config.test.ts`:

```ts
test("host skills dir defaults to ~/.claude/skills and expands ~", () => {
  const c = loadConfig({ DATABASE_URL: "x", FACTORY_SECRET_KEY: "k".repeat(40) });
  expect(c.hostSkillsDir).toBe(path.join(os.homedir(), ".claude", "skills"));
  expect(loadConfig({ DATABASE_URL: "x", FACTORY_SECRET_KEY: "k".repeat(40), FACTORY_HOST_SKILLS_DIR: "~/s" }).hostSkillsDir)
    .toBe(path.join(os.homedir(), "s"));
  expect("claudeToken" in c).toBe(false);
});
```

Delete the existing config assertions about `claudeToken` and `devModel`.

`apps/server/src/errors.test.ts`:

```ts
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { expect, test } from "vitest";
import { z } from "zod";
import { ApiError, FieldError, registerErrorHandlers } from "./errors.ts";

test("validation errors carry fields; ApiError extras are rendered", async () => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandlers(app);
  app.post("/v", { schema: { body: z.object({ slug: z.string().min(3, "Too short"), name: z.string() }) } }, async () => ({}));
  app.post("/f", async () => { throw new FieldError("slug", "That slug is taken.", "slug_taken"); });
  app.post("/e", async () => { throw new ApiError(409, "credential_in_use", "Used by @a.", { usedBy: ["a"] }); });
  const v = await app.inject({ method: "POST", url: "/v", payload: { slug: "a" } });
  expect(v.statusCode).toBe(400);
  expect(v.json().error.fields).toEqual({ slug: "Too short", name: expect.any(String) });
  const f = await app.inject({ method: "POST", url: "/f" });
  expect(f.statusCode).toBe(409);
  expect(f.json()).toEqual({ error: { code: "slug_taken", message: "That slug is taken.", fields: { slug: "That slug is taken." } } });
  const e = await app.inject({ method: "POST", url: "/e" });
  expect(e.json()).toEqual({ error: { code: "credential_in_use", message: "Used by @a.", usedBy: ["a"] } });
});
```

PLAN DECISION: a `FieldError` keeps the status of its code: 409 for `slug_taken` and `folder_exists`, 400 for `validation_error`. The UI places both under the field.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/src/crypto apps/server/src/config.test.ts apps/server/src/errors.test.ts`
Expected: FAIL (the modules are missing, there's no `hostSkillsDir`, and no `fields`).

- [ ] **Step 3: Implement**

`apps/server/src/crypto/vault.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deriveKey } from "./keys.ts";

const VERSION = 1;
export class VaultError extends Error {
  constructor(message = "Can't decrypt this value. Was FACTORY_SECRET_KEY changed?") {
    super(message);
    this.name = "VaultError";
  }
}

/** AES-256-GCM. Blob: [version 0x01][12-byte nonce][ciphertext][16-byte tag]. AAD binds a blob to its row. */
export class Vault {
  private readonly key: Buffer;
  constructor(rootKey: string) {
    this.key = deriveKey(rootKey, "secret-encryption");
  }
  seal(plaintext: string, aad: string): Buffer {
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, nonce);
    c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return Buffer.concat([Buffer.from([VERSION]), nonce, body, c.getAuthTag()]);
  }
  open(blob: Buffer, aad: string): string {
    if (blob.length < 1 + 12 + 16 || blob[0] !== VERSION) throw new VaultError();
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, blob.subarray(1, 13));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(blob.subarray(blob.length - 16));
      return Buffer.concat([d.update(blob.subarray(13, blob.length - 16)), d.final()]).toString("utf8");
    } catch {
      throw new VaultError();
    }
  }
}
```

`config.ts`:
- remove `claudeToken`, `devModel` and their env keys;
- add `FACTORY_HOST_SKILLS_DIR: z.string().min(1).default("~/.claude/skills")`;
- add `hostSkillsDir: expandHome(e.FACTORY_HOST_SKILLS_DIR)`.

`.env.example`:
- remove the `CLAUDE_CODE_OAUTH_TOKEN` and `FACTORY_DEV_MODEL` lines;
- add `# Where host skills named in templates live\n# FACTORY_HOST_SKILLS_DIR=~/.claude/skills`.

`errors.ts`:

```ts
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
  }
}
const FIELD_STATUS: Record<string, number> = { slug_taken: 409, folder_exists: 409 };
export class FieldError extends ApiError {
  constructor(field: string, message: string, code = "validation_error") {
    super(FIELD_STATUS[code] ?? 400, code, message, { fields: { [field]: message } });
  }
}
```

In `registerErrorHandlers`:
- **First**, `if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...err.extra } });`.
- **For Zod validation**, build `fields` from `err.validation`: each item's `instancePath` is `/slug`, or use `params.issue.path`. Take the first segment, first issue per field wins. Send `{ error: { code: "validation_error", message: err.message, fields } }`.
- Check which shape `fastify-type-provider-zod` v7 puts on `err.validation` by logging one in the test before writing the mapping.

`app.ts` `loggerOptions` redact paths:
- remove the `config.claudeToken`/`claudeToken` entries;
- keep the three `CLAUDE_CODE_OAUTH_TOKEN` shapes;
- add `"*.ANTHROPIC_API_KEY"`, `"*.env.ANTHROPIC_API_KEY"`, `"*.*.ANTHROPIC_API_KEY"`, `"*.value"`, `"*.*.value"`, `"*.token"`, `"*.env"`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/server/src/crypto apps/server/src/config.test.ts apps/server/src/errors.test.ts apps/server/src/agents`
Expected: PASS. The agent tests still pass through the Task 5 stand-in.

- [ ] **Step 5: Commit**

```bash
git add apps/server .env.example
git commit -m "feat(server): vault, host skills dir config and field-level API errors

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Template parsing and the one validator

**Files:**
- Create: `apps/server/src/templates/parse.ts`, `apps/server/src/templates/validate.ts`
- Test: `apps/server/src/templates/parse.test.ts`, `apps/server/src/templates/validate.test.ts`
- Dependency: `pnpm --filter @open-factory/server add yaml@latest`

**Interfaces:**
- Produces:
  - `parseYaml(text): { value?: unknown; error?: { message: string; line?: number; column?: number }; lineOf(path: (string | number)[]): number | undefined }`;
  - `parseJson(text): { value?: unknown; error?: { message: string; line?: number; column?: number } }`;
  - `interface ValidationContext { projects: Set<string>; secrets: Set<string>; templates: Set<string>; hostSkillsDir: string }`;
  - `validateTemplate(dir: string, folderName: string, ctx: ValidationContext, override?: { file: TemplateFile; content: string }): Promise<{ config?: TemplateConfig; issues: TemplateIssue[]; tplSettings: Record<string, unknown>; tplMcp: { mcpServers: Record<string, unknown> } }>`.

- [ ] **Step 1: Write the failing tests**

`parse.test.ts`:

```ts
import { expect, test } from "vitest";
import { parseJson, parseYaml } from "./parse.ts";

test("yaml syntax error has line and column; paths map to lines", () => {
  expect(parseYaml("name: a\n  bad: [").error).toMatchObject({ line: 2 });
  const ok = parseYaml("name: a\nskills:\n  - x\n  - y\n");
  expect(ok.value).toEqual({ name: "a", skills: ["x", "y"] });
  expect(ok.lineOf(["skills", 1])).toBe(4);
});
test("json syntax error has line and column", () => {
  expect(parseJson('{\n  "a": 1,\n}').error).toMatchObject({ line: 3 });
  expect(parseJson('{"a":1}').value).toEqual({ a: 1 });
});
```

`validate.test.ts` builds temp template folders. Use a helper in the test file:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { type ValidationContext, validateTemplate } from "./validate.ts";

const hostSkills = mkdtempSync(path.join(tmpdir(), "skills-"));
mkdirSync(path.join(hostSkills, "grilling"));
const ctx: ValidationContext = { projects: new Set(["app"]), secrets: new Set(["GH_TOKEN"]), templates: new Set(["tech-lead", "dev"]), hostSkillsDir: hostSkills };

function tpl(files: Record<string, string>, name = "tech-lead") {
  const root = mkdtempSync(path.join(tmpdir(), "tpl-"));
  const dir = path.join(root, name);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c);
  }
  return dir;
}
const base = { "template.yaml": "name: tech-lead\ndisplay_name: Tech Lead\nruntime: local\n", "AGENTS.md": "# TL\n" };
const msgs = async (files: Record<string, string>, sev: "error" | "warning" = "error") =>
  (await validateTemplate(tpl({ ...base, ...files }), "tech-lead", ctx)).issues.filter((i) => i.severity === sev).map((i) => i.message);

test("a clean template", async () => {
  const r = await validateTemplate(tpl(base), "tech-lead", ctx);
  expect(r.issues).toEqual([]);
  expect(r.config?.runtime).toBe("local");
  expect(r.tplSettings).toEqual({});
  expect(r.tplMcp).toEqual({ mcpServers: {} });
});
test("errors", async () => {
  expect(await msgs({ "AGENTS.md": undefined as unknown as string })).toEqual([]); // placeholder replaced below
});
```

Replace the placeholder `errors` test with one case per error rule in spec §5.3. Each case asserts that the message list contains a string matching `expect.stringMatching(<regex>)`:

```ts
test.each([
  ["missing AGENTS.md", { "AGENTS.md": null }, /AGENTS\.md is missing/],
  ["yaml syntax", { "template.yaml": "name: [" }, /YAML/],
  ["schema", { "template.yaml": "name: tech-lead\ndisplay_name: X\nmodle: opus\n" }, /modle/],
  ["name != folder", { "template.yaml": "name: other\ndisplay_name: X\n" }, /doesn't match the folder/],
  ["unknown host skill", { "template.yaml": "name: tech-lead\ndisplay_name: X\nskills: [nope]\n" }, /Host skill nope/],
  ["host skill vs local skill", { "template.yaml": "name: tech-lead\ndisplay_name: X\nskills: [grilling]\n", "skills/grilling/SKILL.md": "x" }, /same name/],
  ["unknown project", { "template.yaml": "name: tech-lead\ndisplay_name: X\nprojects: [web]\n" }, /Project web isn't registered/],
  ["bypass + local", { "template.yaml": "name: tech-lead\ndisplay_name: X\nruntime: local\npermission_mode: bypass\n" }, /bypass/],
  ["undeclared marketplace", { "template.yaml": "name: tech-lead\ndisplay_name: X\nplugins: [p@m]\n" }, /Marketplace m/],
  ["mcp without mcpServers", { "mcp.json": "{}" }, /mcpServers/],
  ["reserved mcp server", { "mcp.json": '{"mcpServers":{"factory":{}}}' }, /factory/],
  ["reserved files entry", { "files/CLAUDE.md": "x" }, /files\/CLAUDE\.md/],
  ["bad marketplace source", { "settings.json": '{"extraKnownMarketplaces":{"m":{"source":{"source":"npm","package":"x"}}}}', "template.yaml": "name: tech-lead\ndisplay_name: X\nplugins: [p@m]\n" }, /source/],
  ["marketplace ref field", { "settings.json": '{"extraKnownMarketplaces":{"m":{"source":{"source":"github","repo":"o/r","ref":"v1"}}}}', "template.yaml": "name: tech-lead\ndisplay_name: X\nplugins: [p@m]\n" }, /ref/],
])("error: %s", async (_n, files, re) => {
  const dir = tpl(Object.fromEntries(Object.entries({ ...base, ...files }).filter(([, v]) => v !== null)) as Record<string, string>);
  const issues = (await validateTemplate(dir, "tech-lead", ctx)).issues;
  expect(issues.filter((i) => i.severity === "error").map((i) => i.message)).toContainEqual(expect.stringMatching(re));
});

test.each([
  ["undefined secret", { "template.yaml": "name: tech-lead\ndisplay_name: X\nsecrets: [NPM_TOKEN]\n" }, /Secret NPM_TOKEN isn't set/],
  ["unknown can_spawn", { "template.yaml": "name: tech-lead\ndisplay_name: X\ncan_spawn: [ghost]\n" }, /ghost/],
  ["defaultMode ignored", { "settings.json": '{"permissions":{"defaultMode":"dontAsk"}}' }, /defaultMode/],
  ["enabledPlugins ignored", { "settings.json": '{"enabledPlugins":{"a@b":true}}' }, /enabledPlugins/],
])("warning: %s", async (_n, files, re) => {
  const issues = (await validateTemplate(tpl({ ...base, ...files }), "tech-lead", ctx)).issues;
  expect(issues.filter((i) => i.severity === "warning").map((i) => i.message)).toContainEqual(expect.stringMatching(re));
  expect(issues.filter((i) => i.severity === "error")).toEqual([]);
});

test("schema issue carries the yaml line; json issue carries line and column", async () => {
  const r = await validateTemplate(tpl({ ...base, "template.yaml": "name: tech-lead\ndisplay_name: X\nskills:\n  - ..\n" }), "tech-lead", ctx);
  expect(r.issues[0]).toMatchObject({ file: "template.yaml", line: 4 });
  const j = await validateTemplate(tpl({ ...base, "settings.json": '{\n "a": 1,\n}' }), "tech-lead", ctx);
  expect(j.issues[0]).toMatchObject({ file: "settings.json", line: 3 });
});

test("override substitutes unsaved content for one file", async () => {
  const dir = tpl(base);
  const r = await validateTemplate(dir, "tech-lead", ctx, { file: "template.yaml", content: "name: tech-lead\ndisplay_name: X\nprojects: [web]\n" });
  expect(r.issues.map((i) => i.message)).toContainEqual(expect.stringMatching(/web/));
});
```

Delete the placeholder test before running.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/src/templates`
Expected: FAIL (the modules are missing).

- [ ] **Step 3: Implement**

`parse.ts`:

```ts
import { isMap, isSeq, LineCounter, parseDocument } from "yaml";

export function parseYaml(text: string) {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false });
  const err = doc.errors[0];
  const lineOf = (p: (string | number)[]) => {
    let node: unknown = doc.contents;
    for (const k of p) {
      if (isMap(node)) node = node.get(k, true);
      else if (isSeq(node)) node = node.get(Number(k), true);
      else return undefined;
    }
    const range = (node as { range?: [number, number, number] } | undefined)?.range;
    return range ? lc.linePos(range[0]).line : undefined;
  };
  if (err) {
    const pos = err.linePos?.[0];
    return { error: { message: `YAML: ${err.message.split("\n")[0]}`, line: pos?.line, column: pos?.col }, lineOf };
  }
  return { value: doc.toJS() as unknown, lineOf };
}

export function parseJson(text: string) {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (e) {
    const m = /line (\d+) column (\d+)/.exec(String((e as Error).message));
    return { error: { message: `JSON: ${(e as Error).message}`, line: m ? Number(m[1]) : undefined, column: m ? Number(m[2]) : undefined } };
  }
}
```

(If Node 24's message lacks `line X column Y` and only has `at position N`, compute line and column from `N` over `text` instead. The test pins the behaviour.)

`validate.ts` (one function, rules in this order, issues pushed with `file`, `line`, `column`, `path`). Messages, verbatim:

| Rule | Severity | Message |
|---|---|---|
| no `template.yaml` | error | `template.yaml is missing.` |
| no `AGENTS.md` | error | `AGENTS.md is missing.` |
| YAML or JSON syntax | error | the parser message (prefixed `YAML:` or `JSON:`) |
| schema issue | error | `<path>: <zod message>` (path dotted, e.g. `skills.0`); `line` from `lineOf(issue.path)`. A strict unknown key: `Unknown field <key>.` |
| `name` ≠ folder | error | `name "<name>" doesn't match the folder name "<folder>".` |
| host skill missing (`lstat(path.join(hostSkillsDir, n))` is not a dir, following one symlink level via `stat`) | error | `Host skill <n> is missing from <hostSkillsDir>.` |
| host skill equals a `skills/<n>` folder | error | `Host skill <n> has the same name as a template skill in skills/.` |
| unknown project | error | `Project <p> isn't registered. Add it in Settings → Projects.` |
| bypass + local | error | `permission_mode: bypass needs runtime: docker.` |
| plugin marketplace not in `settings.extraKnownMarketplaces` | error | `Marketplace <m> (for plugin <p>) isn't declared in settings.json extraKnownMarketplaces.` |
| marketplace `source.source` not in `directory`/`git`/`github` | error | `Marketplace <m>: source type <t> isn't supported; use directory, git or github.` |
| marketplace with `ref` or `path` sub-field | error | `Marketplace <m>: ref and path aren't supported.` |
| `mcp.json` not `{mcpServers: object}` | error | `mcp.json needs a top-level "mcpServers" object.` |
| server named `factory` | error | `The MCP server name "factory" is reserved.` |
| reserved `files/` top-level entry (`AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `.claude`, `.claude-config`, `.mcp.json`, `.factory`, `projects`) | error | `files/<entry> would overwrite a file the factory manages.` |
| secret not in `ctx.secrets` | warning | `Secret <S> isn't set. Add it in Settings → Secrets.` |
| `can_spawn` not in `ctx.templates` | warning | `can_spawn lists <t>, which isn't a template.` |
| `settings.permissions.defaultMode` set | warning | `permissions.defaultMode is ignored: the factory sets the permission mode.` |
| `settings.enabledPlugins` set | warning | `enabledPlugins is ignored: list plugins in template.yaml.` |

`tplSettings` is the parsed `settings.json` (`{}` when absent or invalid). `tplMcp` is the parsed `mcp.json` (`{mcpServers: {}}` when absent or invalid). The `override` replaces the on-disk content of one of the four files.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/server/src/templates`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server pnpm-lock.yaml
git commit -m "feat(server): template parsing with positions and the one validator

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: TemplateIndex (scan, read, write, create, delete)

**Files:**
- Create: `apps/server/src/templates/template-index.ts`
- Test: `apps/server/src/templates/template-index.test.ts`

**Interfaces:**
- Consumes: `validateTemplate`, `ValidationContext` (Task 6); `schema.templates`, `schema.projects`, `schema.secrets` (Task 4).
- Produces:

```ts
export class TemplateIndex {
  constructor(d: { db: Db; config: Config });
  readonly dir: string;                                   // FACTORY_HOME/templates
  scan(): Promise<TemplateRow[]>;                          // all folders; upserts and prunes rows
  scanOne(name: string): Promise<TemplateRow | undefined>; // one folder (undefined when gone; row deleted)
  context(): Promise<ValidationContext>;
  detail(name: string): Promise<TemplateDetail>;           // throws ApiError 404 template_not_found
  writeFile(name: string, file: TemplateFile, content: string, baseHash: string | null): Promise<{ hash: string; issues: TemplateIssue[] }>;
  validate(name: string, file: TemplateFile, content: string): Promise<TemplateIssue[]>;
  create(b: { name: string; displayName: string; description?: string }): Promise<void>;
  remove(name: string): Promise<void>;
  /** For agent creation and re-sync: the validated template, its folder and the two JSON copies. */
  loadValid(name: string): Promise<{ dir: string; config: TemplateConfig; tplSettings: Record<string, unknown>; tplMcp: { mcpServers: Record<string, unknown> } }>;
}
export const fileHash = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
```

- [ ] **Step 1: Write the failing tests** (real Postgres through `createTestDb`, temp `FACTORY_HOME`)

```ts
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadConfig } from "../config.ts";
import { ApiError } from "../errors.ts";
import { createTestDb } from "../test/helpers.ts";
import { fileHash, TemplateIndex } from "./template-index.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let idx: TemplateIndex;
let home: string;
beforeAll(async () => {
  t = await createTestDb();
  home = mkdtempSync(path.join(tmpdir(), "of-"));
  const config = loadConfig({ DATABASE_URL: t.url, FACTORY_SECRET_KEY: "k".repeat(40), FACTORY_HOME: home, FACTORY_HOST_SKILLS_DIR: mkdtempSync(path.join(tmpdir(), "hs-")) });
  idx = new TemplateIndex({ db: t.db, config });
});
afterAll(() => t.close());

test("create → scan → detail; on-disk edits and deletions show on the next scan", async () => {
  await idx.create({ name: "tech-lead", displayName: "Tech Lead" });
  expect(readFileSync(path.join(home, "templates/tech-lead/template.yaml"), "utf8")).toContain("runtime: docker");
  let rows = await idx.scan();
  expect(rows.map((r) => r.name)).toEqual(["tech-lead"]);
  writeFileSync(path.join(home, "templates/tech-lead/template.yaml"), "name: tech-lead\ndisplay_name: TL2\n");
  expect((await idx.detail("tech-lead")).config?.displayName).toBe("TL2");
  mkdirSync(path.join(home, "templates/.hidden"));
  mkdirSync(path.join(home, "templates/not-a-template"));
  rows = await idx.scan();
  expect(rows.map((r) => r.name)).toEqual(["tech-lead"]);
  await expect(idx.create({ name: "tech-lead", displayName: "X" })).rejects.toMatchObject({ code: "template_exists" });
});

test("writeFile: hash check, invalid content still written, optional file creation", async () => {
  await idx.create({ name: "w1", displayName: "W" });
  const d = await idx.detail("w1");
  const yaml = d.files.find((f) => f.file === "template.yaml");
  const res = await idx.writeFile("w1", "template.yaml", "name: w1\ndisplay_name: W\nmodle: x\n", yaml?.hash ?? null);
  expect(res.issues.some((i) => i.severity === "error")).toBe(true);
  await expect(idx.writeFile("w1", "template.yaml", "x", yaml?.hash ?? null)).rejects.toMatchObject({ code: "changed_on_disk", extra: { currentHash: res.hash } });
  await idx.writeFile("w1", "mcp.json", '{"mcpServers":{}}', null);
  expect(existsSync(path.join(home, "templates/w1/mcp.json"))).toBe(true);
});

test("validate substitutes content without writing", async () => {
  await idx.create({ name: "v1", displayName: "V" });
  const issues = await idx.validate("v1", "template.yaml", "name: v1\ndisplay_name: V\nprojects: [nope]\n");
  expect(issues.map((i) => i.message)).toContainEqual(expect.stringMatching(/nope/));
  expect(readFileSync(path.join(home, "templates/v1/template.yaml"), "utf8")).not.toContain("nope");
});

test("remove deletes a folder, and only the link for a symlinked folder; 404 for gone templates", async () => {
  await idx.create({ name: "r1", displayName: "R" });
  await idx.remove("r1");
  expect(existsSync(path.join(home, "templates/r1"))).toBe(false);
  const outside = mkdtempSync(path.join(tmpdir(), "ext-"));
  writeFileSync(path.join(outside, "template.yaml"), "name: linked\ndisplay_name: L\n");
  writeFileSync(path.join(outside, "AGENTS.md"), "# L\n");
  symlinkSync(outside, path.join(home, "templates/linked"));
  expect((await idx.scan()).map((r) => r.name)).toContain("linked");
  await idx.remove("linked");
  expect(existsSync(outside)).toBe(true);
  await expect(idx.detail("linked")).rejects.toBeInstanceOf(ApiError);
});

test("content hash covers skills/ and files/", async () => {
  await idx.create({ name: "h1", displayName: "H" });
  const before = (await idx.scanOne("h1"))?.contentHash;
  mkdirSync(path.join(home, "templates/h1/files"), { recursive: true });
  writeFileSync(path.join(home, "templates/h1/files/x.txt"), "x");
  expect((await idx.scanOne("h1"))?.contentHash).not.toBe(before);
  expect(fileHash(Buffer.from("a"))).toHaveLength(64);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/src/templates/template-index.test.ts`
Expected: FAIL (the module is missing).

- [ ] **Step 3: Implement**

- **Scan.** `scan()` reads `readdir(dir, {withFileTypes: true})`, skips names starting with `.`, follows symlinked folders (`stat`), and keeps entries containing `template.yaml`. For each it runs `validateTemplate(path, folderName, ctx)` and computes `contentHash`: sha256 over the sorted list of `relativePath + "\0" + bytes` of every file under the folder, recursively (following no symlinks inside). It then upserts `{name: folderName, path, config, issues, contentHash, scannedAt: new Date()}` and deletes rows whose name isn't in the set. `context()` reads project names, secret names and template names (from `readdir`), plus `config.hostSkillsDir`.
- **Files.** `detail(name)`: `scanOne(name)` (404 `template_not_found` when gone). For each of the four `TEMPLATE_FILES`, read `content` and `hash` (`null` when absent). Add `agents` = slugs of non-archived agents with `template = name` (a Drizzle query on `schema.agents`).
- **Write.**
  - `writeFile`: 404 when the folder is gone. The current hash is that of the file on disk, `null` when absent. If it differs from `baseHash`, throw `new ApiError(409, "changed_on_disk", "Changed on disk since you opened it. Reload to see the changes.", { currentHash })`.
  - Write atomically (`writeFile(tmp)`, then `rename`).
  - `scanOne`, then return `{hash, issues}` with the whole template's issues.
- **Validate.** `validate`: 404 when gone. Return `validateTemplate(dir, name, ctx, {file, content}).issues`.
- **Create.** `create`: the folder is created with a non-recursive `mkdir` (`EEXIST` → `409 template_exists`, "A template named <name> already exists."). Then write:
  - `template.yaml` = `name: <n>\ndisplay_name: <yaml-quoted display name>\ndescription: <quoted or "">\nruntime: docker\n` (use `yaml`'s `stringify` for the values);
  - `AGENTS.md` = `# <display name>\n`.
- **Remove.** `remove`: `lstat`. If it's a symlink, `unlink`; otherwise `rm(dir, {recursive: true})`. Then delete the row.
- **Load for create and re-sync.** `loadValid(name)`: `scanOne`. Missing → `ApiError(409, "template_missing", "Template <n> no longer exists.")`. Errors → `ApiError(409, "template_invalid", "Template <n> has errors.", { issues })`. Otherwise return the folder, config, `tplSettings` and `tplMcp` from the validator.
- **Paths.** All paths come from `path.join(this.dir, name)`. Names reaching this class are already validated by route schemas (Task 14). Add a guard anyway: `if (!NAME_PATTERN.test(name)) throw new ApiError(404, "template_not_found", …)`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/server/src/templates`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): template index with rescan, hashed writes, create and delete

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Workspace generators (settings, .mcp.json, CLAUDE.md, mounts)

**Files:**
- Create: `apps/server/src/workspace/paths.ts`, `apps/server/src/workspace/settings.ts`, `apps/server/src/workspace/mcp.ts`, `apps/server/src/workspace/claude-md.ts`, `apps/server/src/workspace/mounts.ts`
- Test: `apps/server/src/workspace/settings.test.ts`, `apps/server/src/workspace/claude-md.test.ts`, `apps/server/src/workspace/mounts.test.ts`

**Interfaces:**
- Produces:

```ts
// paths.ts
export const agentWorkdir = (factoryHome: string, slug: string) => path.join(factoryHome, "agents", slug);
export const agentConfigDir = (workdir: string) => path.join(workdir, ".claude-config");
export const templateCopyDir = (workdir: string) => path.join(workdir, ".factory", "template");
export const resyncRoot = (workdir: string) => path.join(workdir, ".factory", "resync");

// settings.ts
export interface SettingsInput {
  tpl: Record<string, unknown>; prev: Record<string, unknown>;
  slug: string; workdir: string; permissionMode: "auto" | "bypass";
  plugins: string[]; grantedPaths: string[];
}
export function factoryEnvironment(slug: string, workdir: string, grantedPaths: string[]): string[];
export function claudeMdExcludes(workdir: string): string[];
export function buildSettings(i: SettingsInput): Record<string, unknown>;

// mcp.ts
export function buildMcpJson(tplMcp: { mcpServers: Record<string, unknown> }): { mcpServers: Record<string, unknown> };

// claude-md.ts
export interface ClaudeMdInput {
  slug: string; displayName: string; description: string; template: string;
  manager: { slug: string; displayName: string } | null;
  workdir: string; projects: { name: string; hostPath: string }[]; secretNames: string[];
}
export function buildClaudeMd(i: ClaudeMdInput): string;

// mounts.ts
export function buildMounts(i: { workdir: string; grantedPaths: string[]; hostSkillPaths: string[]; tplSettings: Record<string, unknown> }): Mount[];
```

- [ ] **Step 1: Write the failing tests**

`settings.test.ts`:

```ts
import { expect, test } from "vitest";
import { buildSettings, claudeMdExcludes, factoryEnvironment } from "./settings.ts";

const base = { slug: "lead", workdir: "/h/of/agents/lead", permissionMode: "auto" as const, plugins: ["p@m"], grantedPaths: ["/code/app"] };

test("rebuild: template base, plugin keys carried and filtered, agent keys dropped", () => {
  const s = buildSettings({
    ...base,
    tpl: { hooks: { Stop: [] }, permissions: { deny: ["Bash(curl:*)"], additionalDirectories: ["/data"] }, extraKnownMarketplaces: { m: { source: { source: "directory", path: "/new" } } }, enabledPlugins: { "x@y": true } },
    prev: { enabledPlugins: { "p@m": true, "old@m": true }, extraKnownMarketplaces: { m: { source: { source: "directory", path: "/old" } }, other: { source: { source: "git", url: "u" } } }, agentAdded: true },
  });
  expect(s.hooks).toEqual({ Stop: [] });
  expect(s.enabledPlugins).toEqual({ "p@m": true });
  expect(s.extraKnownMarketplaces).toEqual({ m: { source: { source: "directory", path: "/new" } }, other: { source: { source: "git", url: "u" } } });
  expect(s).not.toHaveProperty("agentAdded");
  expect(s.permissions).toEqual({ deny: ["Bash(curl:*)"], defaultMode: "auto", additionalDirectories: ["/data", "/code/app"] });
});

test("autoMode: $defaults first in every list, deduped; factory environment appended", () => {
  const s = buildSettings({ ...base, prev: {}, tpl: { autoMode: { hard_deny: ["$defaults", "Never X."], soft_deny: ["Y"], environment: ["Team env."] } } });
  const am = s.autoMode as Record<string, string[]>;
  expect(am.hard_deny).toEqual(["$defaults", "Never X."]);
  expect(am.soft_deny).toEqual(["$defaults", "Y"]);
  expect(am.environment).toEqual(["$defaults", "Team env.", ...factoryEnvironment("lead", base.workdir, ["/code/app"])]);
  expect(am).not.toHaveProperty("allow");
});

test("bypass sets bypassPermissions; no grants → 'none' in the environment entry", () => {
  const s = buildSettings({ ...base, permissionMode: "bypass", grantedPaths: [], prev: {}, tpl: {} });
  expect((s.permissions as { defaultMode: string }).defaultMode).toBe("bypassPermissions");
  expect(factoryEnvironment("lead", "/w", [])[1]).toContain("(none)");
});

test("claudeMdExcludes: every ancestor's four files plus the workdir's own CLAUDE.md files", () => {
  const ex = claudeMdExcludes("/h/of/agents/lead");
  for (const dir of ["/", "/h", "/h/of", "/h/of/agents"])
    for (const f of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md"])
      expect(ex).toContain(`${dir === "/" ? "" : dir}/${f}`);
  expect(ex).toContain("/h/of/agents/lead/CLAUDE.md");
  expect(ex).toContain("/h/of/agents/lead/CLAUDE.local.md");
  expect(ex).not.toContain("/h/of/agents/lead/AGENTS.md");
  const s = buildSettings({ ...base, prev: {}, tpl: { claudeMdExcludes: ["/x/CLAUDE.md"] } });
  expect((s.claudeMdExcludes as string[])[0]).toBe("/x/CLAUDE.md");
});
```

`claude-md.test.ts`:

```ts
import { expect, test } from "vitest";
import { buildClaudeMd, type ClaudeMdInput } from "./claude-md.ts";

const input: ClaudeMdInput = {
  slug: "lead", displayName: "Team Lead", description: "Owns delivery.", template: "team-lead",
  manager: { slug: "cto", displayName: "CTO" }, workdir: "/h/of/agents/lead",
  projects: [{ name: "app", hostPath: "/code/app" }], secretNames: ["GH_TOKEN"],
};
const sections = (md: string) => md.split("\n").filter((l) => l.startsWith("#"));

test("structure with everything present; deterministic", () => {
  const md = buildClaudeMd(input);
  expect(sections(md)).toEqual(["# Open Factory", "## Who you are", "## How messages reach you", "## Your workspace"]);
  expect(md).toContain("@lead");
  expect(md).toContain("@cto");
  expect(md).toContain("./projects/app");
  expect(md).toContain("GH_TOKEN");
  expect(buildClaudeMd(input)).toBe(md);
  expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
});
test("no manager, no projects, no secrets", () => {
  const md = buildClaudeMd({ ...input, manager: null, projects: [], secretNames: [] });
  expect(md).toContain("No manager");
  expect(md).toContain("No projects are granted to you.");
  expect(md).not.toContain("Environment variables provided to you");
});
```

`mounts.test.ts`:

```ts
import { expect, test } from "vitest";
import { buildMounts } from "./mounts.ts";

test("path parity; directory marketplaces read-only; others ignored", () => {
  expect(buildMounts({
    workdir: "/w", grantedPaths: ["/code/app"], hostSkillPaths: ["/real/skills/grilling"],
    tplSettings: { extraKnownMarketplaces: { a: { source: { source: "directory", path: "/mk" } }, b: { source: { source: "github", repo: "o/r" } } } },
  })).toEqual([
    { source: "/w", target: "/w", readOnly: false },
    { source: "/code/app", target: "/code/app", readOnly: false },
    { source: "/real/skills/grilling", target: "/real/skills/grilling", readOnly: true },
    { source: "/mk", target: "/mk", readOnly: true },
  ]);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/src/workspace`
Expected: FAIL (the modules are missing).

- [ ] **Step 3: Implement**

`settings.ts`:

```ts
import path from "node:path";

const LISTS = ["environment", "allow", "soft_deny", "hard_deny"] as const;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function factoryEnvironment(slug: string, workdir: string, grantedPaths: string[]): string[] {
  return [
    `This is an Open Factory agent named @${slug}, run headless for the humans who operate this factory.`,
    `Its working directory ${workdir} and the granted project repositories (${grantedPaths.length ? grantedPaths.join(", ") : "none"}) are trusted local workspaces.`,
    "The git remotes configured in the granted project repositories are trusted source control for this agent's branches and pull requests.",
  ];
}

export function claudeMdExcludes(workdir: string): string[] {
  const out: string[] = [];
  let dir = path.dirname(workdir);
  for (;;) {
    for (const f of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md"]) out.push(path.join(dir, f));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  out.push(path.join(workdir, "CLAUDE.md"), path.join(workdir, "CLAUDE.local.md"));
  return out;
}

export function buildSettings(i: SettingsInput): Record<string, unknown> {
  const tpl = structuredClone(i.tpl);
  delete tpl.enabledPlugins;
  const prevPlugins = obj(i.prev.enabledPlugins);
  const enabledPlugins = Object.fromEntries(Object.entries(prevPlugins).filter(([k]) => i.plugins.includes(k)));
  const extraKnownMarketplaces = { ...obj(i.prev.extraKnownMarketplaces), ...obj(i.tpl.extraKnownMarketplaces) };
  const perms = obj(tpl.permissions);
  const permissions = {
    ...perms,
    defaultMode: i.permissionMode === "bypass" ? "bypassPermissions" : "auto",
    additionalDirectories: [...new Set([...strs(perms.additionalDirectories), ...i.grantedPaths])],
  };
  const tplAuto = obj(tpl.autoMode);
  const autoMode: Record<string, unknown> = { ...tplAuto };
  for (const k of LISTS) {
    const own = strs(tplAuto[k]).filter((x) => x !== "$defaults");
    const extra = k === "environment" ? factoryEnvironment(i.slug, i.workdir, i.grantedPaths) : [];
    if (own.length || extra.length) autoMode[k] = ["$defaults", ...own, ...extra];
    else delete autoMode[k];
  }
  return {
    ...tpl,
    extraKnownMarketplaces,
    enabledPlugins,
    permissions,
    autoMode,
    claudeMdExcludes: [...strs(tpl.claudeMdExcludes), ...claudeMdExcludes(i.workdir)],
  };
}
```

`mcp.ts`: `return { mcpServers: { ...tplMcp.mcpServers } }`. Add the comment `// S6 adds the "factory" server here.`

`claude-md.ts`: build the exact text from spec §10. Each line below is literal, joined with `\n`, and the file ends with a single trailing newline:
- the title and intro paragraph;
- `## Who you are` with the Description, the Manager line (`- Manager: @<slug> (<name>)` or `- No manager: you report directly to the humans.`) and the Template line;
- `## How messages reach you` with the two paragraphs from spec §10;
- `## Your workspace` with:
  - the working-dir line including the AGENTS.md note;
  - the project list (`  - \`./projects/<name>\` → <hostPath>`) or `- No projects are granted to you.`;
  - the worktree rule;
  - the env-var line only when `secretNames.length`.

`mounts.ts`: workdir rw, each granted path rw, each host skill path ro, then each `extraKnownMarketplaces[*].source` with `source === "directory"` → its `path`, ro. De-duplicate by target, keeping the first.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/server/src/workspace`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): settings, mcp, CLAUDE.md and mount generators

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Workspace filesystem steps (links, plugins, files, lock) and the fake plugin CLI

**Files:**
- Create: `apps/server/src/workspace/links.ts`, `apps/server/src/workspace/plugins.ts`, `apps/server/src/workspace/files.ts`, `apps/server/src/workspace/lock.ts`
- Modify: `packages/harness/testing/fake-claude.mjs` (plugin subcommands)
- Test: `apps/server/src/workspace/links.test.ts`, `apps/server/src/workspace/plugins.test.ts`, `apps/server/src/workspace/files.test.ts`, `apps/server/src/workspace/lock.test.ts`

**Interfaces:**
- Produces:

```ts
// links.ts — both throw WorkspaceError(message, fix?) on a violation
export class WorkspaceError extends Error { constructor(message: string, readonly fix?: "projects" | "edit_agent") }
export function resolveHostSkills(hostSkillsDir: string, names: string[]): Promise<{ name: string; dir: string; realDir: string }[]>;
export function linkHostSkills(workdir: string, hostSkillsDir: string, skills: { name: string; dir: string }[], opts?: { checkOnly?: boolean }): Promise<void>;
export function linkProjects(workdir: string, grants: { name: string; hostPath: string }[], opts?: { checkOnly?: boolean }): Promise<void>;
// plugins.ts
export class PluginInstallError extends Error { constructor(message: string, readonly output: string) }
export function marketplaceSourceArg(entry: unknown): string; // directory → path, git → url, github → repo
export function redactOutput(s: string): string;
export function installPlugins(o: { claudeBin: string; configDir: string; cwd: string; plugins: string[]; tplSettings: Record<string, unknown>; serverEnv: NodeJS.ProcessEnv; commandTimeoutMs?: number; budgetMs?: number }): Promise<void>;
// files.ts
export function writeAtomic(file: string, data: string): Promise<void>;
export function templateTargets(tplDir: string, cfg: { localSkills: boolean }): Promise<{ from: string; to: string }[]>; // relative `to` paths in the workdir
export function copyTargets(tplDir: string, workdir: string, targets: { from: string; to: string }[], tplSettings: Record<string, unknown>, tplMcp: unknown): Promise<void>;
export function backupDiffering(workdir: string, incoming: { to: string; data: Buffer }[], stamp: string): Promise<string | undefined>;
export function resyncStamp(d?: Date): string; // 2026-11-19T10-22-31Z
// lock.ts
export class KeyedMutex { run<T>(key: string, fn: () => Promise<T>): Promise<T> }
```

- [ ] **Step 1: Extend the fake claude**

At the top of `packages/harness/testing/fake-claude.mjs`, before the scenario is read, handle `plugin` subcommands. These don't need a scenario: the wrapper still sets one, and it's simply unused.

```js
const argv0 = process.argv.slice(2);
if (argv0[0] === "plugin") {
  const { readFileSync: rf, writeFileSync: wf, existsSync: ex, mkdirSync: mk, appendFileSync: af } = await import("node:fs");
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  af(`${process.env.FAKE_CLAUDE_DIR}/plugin.log`, `${JSON.stringify({ argv: argv0, env: Object.keys(process.env).sort() })}\n`);
  mk(cfg, { recursive: true });
  const f = `${cfg}/settings.json`;
  const s = ex(f) ? JSON.parse(rf(f, "utf8")) : {};
  if (argv0[1] === "marketplace" && argv0[2] === "add") {
    const src = argv0[3];
    const name = src.split("/").pop();
    s.extraKnownMarketplaces = { ...s.extraKnownMarketplaces, [name]: { source: { source: "directory", path: src } } };
  } else if (argv0[1] === "install") {
    const ref = argv0[2];
    if ((process.env.FAKE_CLAUDE_PLUGIN_FAIL ?? "").split(",").includes(ref)) {
      process.stderr.write(`✘ Failed to install plugin "${ref}": Plugin not found in marketplace\n`);
      process.exit(1);
    }
    if (process.env.FAKE_CLAUDE_PLUGIN_SLEEP_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_PLUGIN_SLEEP_MS)));
    s.enabledPlugins = { ...s.enabledPlugins, [ref]: true };
  }
  wf(f, JSON.stringify(s, null, 2));
  process.stdout.write("✔ ok\n");
  process.exit(0);
}
```

`FAKE_CLAUDE_PLUGIN_FAIL` and `FAKE_CLAUDE_PLUGIN_SLEEP_MS` must reach the fake through the wrapper, because the plugin env is `PATH HOME CLAUDE_CONFIG_DIR` only. Add an optional `env?: Record<string, string>` to `createFakeClaude(opts)` that the wrapper script exports.

- [ ] **Step 2: Write the failing tests**

`links.test.ts`:

```ts
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { linkHostSkills, linkProjects, resolveHostSkills, WorkspaceError } from "./links.ts";

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));

test("host skills: resolved, linked, stale links removed, non-links never touched", async () => {
  const hs = tmp("hs-"); mkdirSync(path.join(hs, "grilling")); mkdirSync(path.join(hs, "old"));
  const real = tmp("real-"); symlinkSync(real, path.join(hs, "linked"));
  const wd = tmp("wd-"); mkdirSync(path.join(wd, ".claude/skills"), { recursive: true });
  symlinkSync(path.join(hs, "old"), path.join(wd, ".claude/skills/old"));
  mkdirSync(path.join(wd, ".claude/skills/local-one"));
  const skills = await resolveHostSkills(hs, ["grilling", "linked"]);
  expect(skills.find((s) => s.name === "linked")?.realDir).toBe(real);
  await linkHostSkills(wd, hs, skills);
  expect(readlinkSync(path.join(wd, ".claude/skills/grilling"))).toBe(path.join(hs, "grilling"));
  expect(existsSync(path.join(wd, ".claude/skills/old"))).toBe(false);
  expect(lstatSync(path.join(wd, ".claude/skills/local-one")).isDirectory()).toBe(true);
  await expect(resolveHostSkills(hs, ["missing"])).rejects.toThrow(`Host skill missing is missing from ${hs}.`);
  mkdirSync(path.join(wd, ".claude/skills/grilling2"));
  mkdirSync(path.join(hs, "grilling2"));
  await expect(linkHostSkills(wd, hs, await resolveHostSkills(hs, ["grilling2"]))).rejects.toBeInstanceOf(WorkspaceError);
});

test("projects: created, retargeted, revoked removed; missing folder fails; checkOnly writes nothing", async () => {
  const a = tmp("a-"); const b = tmp("b-"); const wd = tmp("wd-");
  await linkProjects(wd, [{ name: "app", hostPath: a }, { name: "web", hostPath: b }]);
  await linkProjects(wd, [{ name: "app", hostPath: b }]);
  expect(readlinkSync(path.join(wd, "projects/app"))).toBe(b);
  expect(existsSync(path.join(wd, "projects/web"))).toBe(false);
  await expect(linkProjects(wd, [{ name: "gone", hostPath: path.join(a, "nope") }])).rejects.toThrow(/Project gone's folder .* is missing/);
  const wd2 = tmp("wd2-");
  await linkProjects(wd2, [{ name: "app", hostPath: a }], { checkOnly: true });
  expect(existsSync(path.join(wd2, "projects"))).toBe(false);
  writeFileSync(path.join(wd, "projects/real"), "x");
  await expect(linkProjects(wd, [{ name: "real", hostPath: a }])).rejects.toBeInstanceOf(WorkspaceError);
});
```

`plugins.test.ts` (uses `createFakeClaude` from `@open-factory/harness/testing`):

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeClaude } from "@open-factory/harness/testing";
import { expect, test } from "vitest";
import { installPlugins, marketplaceSourceArg, PluginInstallError, redactOutput } from "./plugins.ts";

const tplSettings = { extraKnownMarketplaces: { mk: { source: { source: "directory", path: "/x/mk" } } } };
test("adds marketplaces then installs, with a minimal env", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const cfg = mkdtempSync(path.join(tmpdir(), "cfg-"));
  await installPlugins({ claudeBin: fake.bin, configDir: cfg, cwd: cfg, plugins: ["p@mk"], tplSettings, serverEnv: { PATH: process.env.PATH, HOME: "/h", DATABASE_URL: "x" } });
  const s = JSON.parse(readFileSync(path.join(cfg, "settings.json"), "utf8"));
  expect(s.enabledPlugins).toEqual({ "p@mk": true });
  const log = readFileSync(path.join(fake.dir, "plugin.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(log.map((l) => l.argv.slice(0, 3))).toEqual([["plugin", "marketplace", "add"], ["plugin", "install", "p@mk"]]);
  for (const l of log) expect(l.env).not.toContain("DATABASE_URL");
});
test("failure carries redacted output; budget enforced", async () => {
  const fake = createFakeClaude({ scenario: "reply", env: { FAKE_CLAUDE_PLUGIN_FAIL: "p@mk" } });
  const cfg = mkdtempSync(path.join(tmpdir(), "cfg-"));
  await expect(installPlugins({ claudeBin: fake.bin, configDir: cfg, cwd: cfg, plugins: ["p@mk"], tplSettings, serverEnv: process.env }))
    .rejects.toBeInstanceOf(PluginInstallError);
  const slow = createFakeClaude({ scenario: "reply", env: { FAKE_CLAUDE_PLUGIN_SLEEP_MS: "2000" } });
  await expect(installPlugins({ claudeBin: slow.bin, configDir: cfg, cwd: cfg, plugins: ["p@mk"], tplSettings, serverEnv: process.env, budgetMs: 300 }))
    .rejects.toThrow("Plugin install took longer than 4 minutes.");
});
test("source args and redaction", () => {
  expect(marketplaceSourceArg({ source: { source: "git", url: "https://h/r.git" } })).toBe("https://h/r.git");
  expect(marketplaceSourceArg({ source: { source: "github", repo: "o/r" } })).toBe("o/r");
  expect(redactOutput("clone https://user:pw@host/x sk-ant-oat01-abc")).toBe("clone https://[redacted]@host/x [redacted]");
});
```

`files.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { backupDiffering, copyTargets, resyncStamp, templateTargets, writeAtomic } from "./files.ts";

test("targets: AGENTS.md, skills (when localSkills), files/ contents at the root", async () => {
  const t = mkdtempSync(path.join(tmpdir(), "t-"));
  writeFileSync(path.join(t, "AGENTS.md"), "# A");
  mkdirSync(path.join(t, "skills/s1"), { recursive: true }); writeFileSync(path.join(t, "skills/s1/SKILL.md"), "s");
  mkdirSync(path.join(t, "files/docs"), { recursive: true }); writeFileSync(path.join(t, "files/docs/x.md"), "x");
  expect((await templateTargets(t, { localSkills: true })).map((x) => x.to).sort()).toEqual([".claude/skills/s1/SKILL.md", "AGENTS.md", "docs/x.md"]);
  expect((await templateTargets(t, { localSkills: false })).map((x) => x.to)).not.toContain(".claude/skills/s1/SKILL.md");
  const wd = mkdtempSync(path.join(tmpdir(), "wd-"));
  await copyTargets(t, wd, await templateTargets(t, { localSkills: true }), { a: 1 }, { mcpServers: {} });
  expect(readFileSync(path.join(wd, ".factory/template/settings.json"), "utf8")).toContain('"a": 1');
  expect(existsSync(path.join(wd, "docs/x.md"))).toBe(true);
});
test("backup only differing files; none when nothing differs; stamp has no colons", async () => {
  const wd = mkdtempSync(path.join(tmpdir(), "wd-"));
  writeFileSync(path.join(wd, "AGENTS.md"), "edited");
  writeFileSync(path.join(wd, "same.md"), "same");
  const stamp = resyncStamp(new Date("2026-11-19T10:22:31.123Z"));
  expect(stamp).toBe("2026-11-19T10-22-31Z");
  const dir = await backupDiffering(wd, [{ to: "AGENTS.md", data: Buffer.from("template") }, { to: "same.md", data: Buffer.from("same") }, { to: "new.md", data: Buffer.from("n") }], stamp);
  expect(dir).toBe(".factory/resync/2026-11-19T10-22-31Z");
  expect(readFileSync(path.join(wd, dir as string, "AGENTS.md"), "utf8")).toBe("edited");
  expect(existsSync(path.join(wd, dir as string, "same.md"))).toBe(false);
  expect(await backupDiffering(wd, [{ to: "same.md", data: Buffer.from("same") }], "s2")).toBeUndefined();
  await writeAtomic(path.join(wd, "a.json"), "{}");
  expect(readFileSync(path.join(wd, "a.json"), "utf8")).toBe("{}");
});
```

`lock.test.ts`:

```ts
import { expect, test } from "vitest";
import { KeyedMutex } from "./lock.ts";

test("serializes per key, not across keys, and releases on error", async () => {
  const m = new KeyedMutex(); const order: string[] = [];
  const slow = m.run("a", async () => { await new Promise((r) => setTimeout(r, 30)); order.push("a1"); });
  const fast = m.run("a", async () => { order.push("a2"); });
  const other = m.run("b", async () => { order.push("b1"); });
  await Promise.all([slow, fast, other]);
  expect(order).toEqual(["b1", "a1", "a2"]);
  await expect(m.run("a", async () => { throw new Error("x"); })).rejects.toThrow("x");
  expect(await m.run("a", async () => 1)).toBe(1);
});
```

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm vitest run apps/server/src/workspace`
Expected: FAIL (the modules are missing).

- [ ] **Step 4: Implement**

- **`links.ts`**
  - `resolveHostSkills`: for each name, `p = path.join(hostSkillsDir, name)`. The name is pattern-checked again with `HOST_SKILL_PATTERN`. `stat(p)` must be a directory, else `WorkspaceError("Host skill <n> is missing from <hostSkillsDir>.", "edit_agent")`. Return `realDir = await realpath(p)`.
  - `linkHostSkills`:
    - ensure `.claude/skills` exists;
    - for each skill, if an entry exists and isn't a symlink, throw `WorkspaceError("<path> isn't a link to the host skill; move it away.")`; if it's a symlink, `unlink` it; then `symlink(dir, entry)`;
    - then, for every symlink in `.claude/skills` whose `readlink` starts with `hostSkillsDir + path.sep` and whose name isn't listed, `unlink` it;
    - `checkOnly` does all the checks but no writes.
  - `linkProjects` follows the same pattern for `projects/<name>`:
    - `stat(hostPath)` must be a directory, else `WorkspaceError("Project <n>'s folder <hostPath> is missing.", "projects")`;
    - a non-symlink entry at a granted name fails;
    - symlinks in `projects/` that aren't granted are removed.
- **`plugins.ts`**
  - `run(cmd, args)` uses `execFile` with `env` = `{PATH, HOME}` (only if set, from `serverEnv`) `+ {CLAUDE_CONFIG_DIR: configDir}`, the given `cwd`, and `timeout: commandTimeoutMs ?? 120_000`. It collects stdout and stderr. A non-zero exit throws `PluginInstallError("Plugin install failed: <first stderr line>", redactOutput(last 20 lines))`.
  - `installPlugins`:
    - the marketplaces used are `new Set(plugins.map((p) => p.split("@")[1]))`;
    - for each, `run("plugin", "marketplace", "add", marketplaceSourceArg(tplSettings.extraKnownMarketplaces[m]))`;
    - then `run("plugin", "install", p)` for each plugin;
    - the whole sequence is wrapped in a `budgetMs ?? 240_000` race that throws `PluginInstallError("Plugin install took longer than 4 minutes.", "")` and kills the running child.
  - `redactOutput` replaces `/(https?:\/\/)[^\s/@]+@/g` with `$1[redacted]@` and `/sk-ant-[A-Za-z0-9_-]+/g` with `[redacted]`.
- **`files.ts`**
  - `templateTargets` walks `AGENTS.md`, `skills/**` → `.claude/skills/**` (only when `localSkills`) and `files/**` → `**`. Symlinks inside the template are reported with `from` and copied as symlinks.
  - `copyTargets` copies each target (`mkdir -p` the parent, `copyFile` keeping the mode via `chmod` from `stat`, and `symlink` for links). It writes `.factory/template/settings.json` (`JSON.stringify(tplSettings, null, 2)`) and `.factory/template/mcp.json` via `writeAtomic`.
  - `backupDiffering`, for each incoming target that exists in the workdir with different bytes, copies the existing file to `.factory/resync/<stamp>/<to>`. It returns the relative backup dir, or `undefined` when nothing was copied.
  - `writeAtomic` writes `file + ".tmp-" + randomUUID()`, then `rename`s it.
- **`lock.ts`:** a `Map<string, Promise<unknown>>` chain. `run` awaits the previous promise (ignoring its error), runs `fn`, and deletes the key when it is the last.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run apps/server/src/workspace packages/harness`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server packages/harness
git commit -m "feat(server): workspace links, plugin installs, template copies and the workspace lock

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The Workspace module (materialize, resync, prepare)

**Files:**
- Create: `apps/server/src/workspace/workspace.ts`
- Test: `apps/server/src/workspace/workspace.test.ts`

**Interfaces:**
- Consumes: Tasks 8 and 9.
- Produces:

```ts
export interface PrepareInput {
  slug: string; displayName: string; description: string; template: string; config: TemplateConfig;
  manager: { slug: string; displayName: string } | null;
  grants: { name: string; hostPath: string }[];
}
export class Workspace {
  constructor(d: { factoryHome: string; hostSkillsDir: string; claudeBin: string; serverEnv?: NodeJS.ProcessEnv; lock: KeyedMutex });
  workdir(slug: string): string;
  /** Claims the folder (non-recursive mkdir; EEXIST → FieldError("slug", …, "folder_exists")), copies, installs, checks. */
  materialize(agentKey: string, slug: string, tpl: { dir: string; config: TemplateConfig; tplSettings: Record<string, unknown>; tplMcp: unknown }, check: PrepareInput): Promise<void>;
  /** Removes a folder this process created (only call after a successful materialize claim). */
  discard(slug: string): Promise<void>;
  /** Under the caller-held lock: backup + overwrite + install. Returns the relative backup dir. */
  resync(slug: string, tpl: { dir: string; config: TemplateConfig; tplSettings: Record<string, unknown>; tplMcp: unknown }): Promise<string | undefined>;
  /** Every start, under the lock (the caller takes it): links, settings, .mcp.json, CLAUDE.md. Returns the mounts. */
  prepare(i: PrepareInput): Promise<{ workdir: string; configDir: string; mounts: Mount[] }>;
}
```

PLAN DECISION: the lock key is the slug, which is unique and immutable, so it can be taken before the row exists. Put a one-line code comment on the lock saying exactly that (normally locks key on stable ids).

- [ ] **Step 1: Write the failing tests**

```ts
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeClaude } from "@open-factory/harness/testing";
import { templateYamlSchema } from "@open-factory/shared";
import { expect, test } from "vitest";
import { FieldError } from "../errors.ts";
import { KeyedMutex } from "./lock.ts";
import { Workspace } from "./workspace.ts";

function setup(fakeEnv: Record<string, string> = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "of-"));
  const hs = mkdtempSync(path.join(tmpdir(), "hs-")); mkdirSync(path.join(hs, "grilling"));
  const repo = mkdtempSync(path.join(tmpdir(), "repo-"));
  const tdir = path.join(home, "templates/lead"); mkdirSync(path.join(tdir, "skills/local"), { recursive: true });
  writeFileSync(path.join(tdir, "AGENTS.md"), "# Lead\n");
  writeFileSync(path.join(tdir, "skills/local/SKILL.md"), "s");
  const config = templateYamlSchema.parse({ name: "lead", display_name: "Lead", runtime: "local", skills: ["grilling"], plugins: ["p@mk"], projects: ["app"] });
  const tplSettings = { extraKnownMarketplaces: { mk: { source: { source: "directory", path: "/mk" } } }, permissions: { deny: ["Bash(curl:*)"] } };
  const fake = createFakeClaude({ scenario: "reply", env: fakeEnv });
  const ws = new Workspace({ factoryHome: home, hostSkillsDir: hs, claudeBin: fake.bin, lock: new KeyedMutex() });
  const tpl = { dir: tdir, config, tplSettings, tplMcp: { mcpServers: { x: { command: "x" } } } };
  const prep = { slug: "lead", displayName: "Lead", description: "d", template: "lead", config, manager: null, grants: [{ name: "app", hostPath: repo }] };
  return { home, hs, repo, ws, tpl, prep };
}

test("materialize then prepare: the full layout", async () => {
  const { ws, tpl, prep, repo, hs } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  expect(readFileSync(path.join(wd, "AGENTS.md"), "utf8")).toBe("# Lead\n");
  expect(existsSync(path.join(wd, ".claude/skills/local/SKILL.md"))).toBe(true);
  expect(existsSync(path.join(wd, "projects"))).toBe(false); // check-only at creation
  const out = await ws.prepare(prep);
  expect(lstatSync(path.join(wd, "projects/app")).isSymbolicLink()).toBe(true);
  expect(lstatSync(path.join(wd, ".claude/skills/grilling")).isSymbolicLink()).toBe(true);
  const s = JSON.parse(readFileSync(path.join(wd, ".claude-config/settings.json"), "utf8"));
  expect(s.enabledPlugins).toEqual({ "p@mk": true });
  expect(s.permissions.additionalDirectories).toEqual([repo]);
  expect(s.permissions.deny).toEqual(["Bash(curl:*)"]);
  expect(JSON.parse(readFileSync(path.join(wd, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { x: { command: "x" } } });
  expect(readFileSync(path.join(wd, ".claude-config/CLAUDE.md"), "utf8")).toContain("@lead");
  expect(out.mounts.map((m) => m.target)).toEqual([wd, repo, path.join(hs, "grilling"), "/mk"]);
});

test("prepare drops agent-added settings keys and re-asserts template rules", async () => {
  const { ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  await ws.prepare(prep);
  const f = path.join(ws.workdir("lead"), ".claude-config/settings.json");
  const s = JSON.parse(readFileSync(f, "utf8")); s.permissions.deny = []; s.mine = 1;
  writeFileSync(f, JSON.stringify(s));
  await ws.prepare(prep);
  const again = JSON.parse(readFileSync(f, "utf8"));
  expect(again.permissions.deny).toEqual(["Bash(curl:*)"]);
  expect(again).not.toHaveProperty("mine");
  expect(again.enabledPlugins).toEqual({ "p@mk": true });
});

test("materialize: existing folder → folder_exists; plugin failure → caller can discard", async () => {
  const { ws, tpl, prep, home } = setup({ FAKE_CLAUDE_PLUGIN_FAIL: "p@mk" });
  mkdirSync(path.join(home, "agents/taken"), { recursive: true });
  await expect(ws.materialize("taken", "taken", tpl, { ...prep, slug: "taken" })).rejects.toBeInstanceOf(FieldError);
  expect(existsSync(path.join(home, "agents/taken"))).toBe(true);
  await expect(ws.materialize("lead", "lead", tpl, prep)).rejects.toThrow(/Plugin install failed/);
  await ws.discard("lead");
  expect(existsSync(path.join(home, "agents/lead"))).toBe(false);
});

test("resync backs up differing files and never deletes", async () => {
  const { ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  writeFileSync(path.join(wd, "AGENTS.md"), "# Lead\nlearned things\n");
  writeFileSync(path.join(wd, "mine.md"), "keep");
  const dir = await ws.resync("lead", tpl);
  expect(dir).toMatch(/^\.factory\/resync\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  expect(readFileSync(path.join(wd, dir as string, "AGENTS.md"), "utf8")).toContain("learned");
  expect(readFileSync(path.join(wd, "AGENTS.md"), "utf8")).toBe("# Lead\n");
  expect(existsSync(path.join(wd, "mine.md"))).toBe(true);
  expect(await ws.resync("lead", tpl)).toBeUndefined();
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/src/workspace/workspace.test.ts`
Expected: FAIL (the module is missing).

- [ ] **Step 3: Implement `workspace.ts`**

- **`materialize`.** Calls `mkdir(path.join(factoryHome, "agents"), { recursive: true })`, then a **non-recursive** `mkdir(workdir)`. `EEXIST` throws `new FieldError("slug", `A folder already exists at ${workdir}. Move it away or pick another slug.`, "folder_exists")`. It then runs, in order:
  1. `copyTargets(tpl.dir, workdir, await templateTargets(tpl.dir, tpl.config), tpl.tplSettings, tpl.tplMcp)`;
  2. `mkdir(configDir)`;
  3. `installPlugins` when `config.plugins.length`;
  4. `resolveHostSkills` plus `linkHostSkills(…, { checkOnly: true })`;
  5. `linkProjects(…, { checkOnly: true })`.
- **`discard(slug)`:** `rm(workdir, { recursive: true, force: true })`.
- **`resync`.** Computes the incoming targets, including the two `.factory/template/*` JSON files as bytes. It calls `backupDiffering(workdir, incoming, resyncStamp())`, then `copyTargets(...)`, then `installPlugins` (all listed plugins; idempotent), and returns the backup dir.
- **`prepare(i)`.** Under no lock of its own: the caller (`prepareStart`, Task 11) holds `lock.run(slug, …)`.
  - It reads `.factory/template/settings.json` and `mcp.json`, and the previous `.claude-config/settings.json` (`{}` and a `warn` log when it doesn't parse).
  - It resolves host skills and links them, then links the projects.
  - It writes `settings.json` with `buildSettings({ tpl, prev, slug, workdir, permissionMode, plugins: config.plugins, grantedPaths })`, `.mcp.json` with `buildMcpJson`, and `.claude-config/CLAUDE.md` with `buildClaudeMd({ …, secretNames: config.secrets })`, all through `writeAtomic` with 2-space JSON.
  - It returns `{ workdir, configDir, mounts: buildMounts({ workdir, grantedPaths, hostSkillPaths: skills.map((s) => s.realDir), tplSettings: tpl }) }`.

PLAN DECISION: `prepare` doesn't take the lock itself, so `materialize` and `resync` callers holding it can't deadlock. Every caller wraps it in `lock.run(slug, …)`. Give `prepare` a one-line doc comment: "Callers must hold the agent's workspace lock."

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/server/src/workspace`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): workspace materialize, re-sync and per-start prepare

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Agent env, runtime spec and prepareStart

**Files:**
- Modify: `apps/server/src/agents/runtime-spec.ts`, `apps/server/src/agents/runtime-spec.test.ts`, `apps/server/src/agents/errors.ts`
- Create: `apps/server/src/agents/start.ts`, `apps/server/src/agents/start.test.ts`

**Interfaces:**
- Consumes: `Vault` (Task 5), `Workspace` and `KeyedMutex` (Tasks 9 and 10), the DB tables (Task 4).
- Produces:

```ts
// errors.ts
export type StartFix = "credentials" | "secrets" | "projects" | "edit_agent";
export class AgentStartError extends Error { constructor(message: string, readonly fix?: StartFix) }
export class AgentArchivedError extends Error { constructor(slug: string) } // "@<slug> is archived. Restore it first."
// runtime-spec.ts
export const ENV_ALLOWLIST: readonly string[]; // unchanged list
export function buildAgentEnv(serverEnv: NodeJS.ProcessEnv, extra: {
  configDir: string; slug: string; credential: { kind: "oauth_token" | "api_key"; value: string }; secrets: Record<string, string>;
}): Record<string, string>;
export function buildRuntimeSpec(i: { agentId: string; slug: string; workdir: string; env: Record<string, string>; claudeBin: string; config: TemplateConfig; mounts: Mount[] }): AgentRuntimeSpec;
// start.ts
export type PrepareStart = (agent: AgentRow) => Promise<AgentRuntimeSpec>;
export function createPrepareStart(d: { db: Db; config: Config; vault: Vault; workspace: Workspace; lock: KeyedMutex; serverEnv?: NodeJS.ProcessEnv }): PrepareStart;
```

- [ ] **Step 1: Write the failing tests**

Replace `runtime-spec.test.ts` with:

```ts
import { expect, test } from "vitest";
import { templateYamlSchema } from "@open-factory/shared";
import { buildAgentEnv, buildRuntimeSpec } from "./runtime-spec.ts";

const serverEnv = {
  PATH: "/usr/bin", HOME: "/home/u", USER: "u", SHELL: "/bin/zsh", LANG: "en_US.UTF-8", TERM: "xterm", TMPDIR: "/tmp",
  DATABASE_URL: "postgres://secret", FACTORY_SECRET_KEY: "s".repeat(40), ANTHROPIC_API_KEY: "server-own",
  CLAUDE_CODE_OAUTH_TOKEN: "server-own", CLAUDE_CONFIG_DIR: "/home/u/.claude", SSH_AUTH_SOCK: "/tmp/ssh", RANDOM_NEW_VAR: "x",
};

test("env is the allowlist plus config dir, credential, secrets and git identity — nothing else", () => {
  const env = buildAgentEnv(serverEnv, {
    configDir: "/w/.claude-config", slug: "lead",
    credential: { kind: "oauth_token", value: "agent-token" }, secrets: { GH_TOKEN: "gh" },
  });
  expect(env).toEqual({
    PATH: "/usr/bin", HOME: "/home/u", USER: "u", SHELL: "/bin/zsh", LANG: "en_US.UTF-8", TERM: "xterm", TMPDIR: "/tmp",
    CLAUDE_CONFIG_DIR: "/w/.claude-config", CLAUDE_CODE_OAUTH_TOKEN: "agent-token", GH_TOKEN: "gh",
    GIT_AUTHOR_NAME: "lead", GIT_COMMITTER_NAME: "lead",
    GIT_AUTHOR_EMAIL: "lead@open-factory.local", GIT_COMMITTER_EMAIL: "lead@open-factory.local",
  });
});
test("api_key credentials set ANTHROPIC_API_KEY and never the OAuth var", () => {
  const env = buildAgentEnv(serverEnv, { configDir: "/c", slug: "a1", credential: { kind: "api_key", value: "k" }, secrets: {} });
  expect(env.ANTHROPIC_API_KEY).toBe("k");
  expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  for (const k of ["DATABASE_URL", "FACTORY_SECRET_KEY", "SSH_AUTH_SOCK", "RANDOM_NEW_VAR"]) expect(env).not.toHaveProperty(k);
});
test("two agents with different credentials get their own values", () => {
  const a = buildAgentEnv({}, { configDir: "/a", slug: "aa", credential: { kind: "oauth_token", value: "A" }, secrets: {} });
  const b = buildAgentEnv({}, { configDir: "/b", slug: "bb", credential: { kind: "oauth_token", value: "B" }, secrets: {} });
  expect([a.CLAUDE_CODE_OAUTH_TOKEN, b.CLAUDE_CODE_OAUTH_TOKEN]).toEqual(["A", "B"]);
});
test("runtime spec from the snapshot", () => {
  const config = templateYamlSchema.parse({ name: "lead", display_name: "L", runtime: "local", model: "haiku", effort: "high" });
  expect(buildRuntimeSpec({ agentId: "1", slug: "lead", workdir: "/w", env: {}, claudeBin: "claude", config, mounts: [] })).toEqual({
    agentId: "1", slug: "lead", cwd: "/w", env: {}, claudeBin: "claude", runtime: "local", model: "haiku", effort: "high", permissionMode: "auto", mounts: [],
  });
});
```

`start.test.ts` (real DB, real `Workspace` with the fake claude, a seeded agent row): a helper inserts a credential sealed with the `Vault` (`aad = credentials:<id>`), a project, a secret, and an agent row with `config` (`runtime: "local"`, `secrets: ["GH_TOKEN"]`, `skills: []`, `plugins: []`), then materializes the workdir with `workspace.materialize`. Cases:

```ts
test("assembles the spec: env has the decrypted credential and secret; files prepared", async () => {
  const spec = await prepareStart(agent);
  expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-1");
  expect(spec.env.GH_TOKEN).toBe("gh-1");
  expect(spec.cwd).toBe(path.join(home, "agents", agent.slug));
  expect(existsSync(path.join(spec.cwd, ".claude-config/CLAUDE.md"))).toBe(true);
});
test.each([
  ["missing secret", async () => t.sql`delete from secrets`, "Secret GH_TOKEN isn't set. Add it in Settings → Secrets.", "secrets"],
  ["docker", async () => t.sql`update agents set runtime = 'docker', config = jsonb_set(config, '{runtime}', '"docker"')`, "The Docker runtime isn't available yet.", undefined],
  ["bad key", async () => t.sql`update credentials set value_enc = ${Buffer.from([1, 2, 3])}`, "Can't decrypt credential work. Was FACTORY_SECRET_KEY changed?", "credentials"],
])("fails closed: %s", async (_n, mutate, message, fix) => {
  await mutate();
  const row = await reload(agent.id);
  await expect(prepareStart(row)).rejects.toMatchObject({ name: "AgentStartError", message, fix });
});
test("archived agents never start", async () => {
  await t.sql`update agents set archived_at = now()`;
  await expect(prepareStart(await reload(agent.id))).rejects.toMatchObject({ name: "AgentArchivedError" });
});
```

(Each case resets its fixture in a `beforeEach` that recreates the rows; write `seedStartFixture()` in the test file and call it from `beforeEach`.)

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/src/agents/runtime-spec.test.ts apps/server/src/agents/start.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`buildAgentEnv`: the allowlist loop as in S3, plus:

```ts
  env.CLAUDE_CONFIG_DIR = extra.configDir;
  env[extra.credential.kind === "api_key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN"] = extra.credential.value;
  for (const [k, v] of Object.entries(extra.secrets)) env[k] = v;
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = extra.slug;
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = `${extra.slug}@open-factory.local`;
```

Delete `resolveClaudeToken`, `agentWorkdir` and `agentConfigDir` from this file (Task 8 moved the path helpers to `workspace/paths.ts`). Callers import from there.

`buildRuntimeSpec` maps the snapshot: `model`/`effort` only when set, `permissionMode: config.permissionMode`, `runtime: config.runtime`.

`createPrepareStart` returns `async (agent) => lock.run(agent.slug, async () => { … })`:
1. **Reload.** Reload the agent row by id. If `archivedAt` is set, throw `new AgentArchivedError(agent.slug)`.
2. **Credential.** Load the credential row by `credentialId`. Missing: `AgentStartError("Credential <id> no longer exists. Edit the agent and choose a credential.", "edit_agent")` (can't happen with RESTRICT; defensive). Decrypt with `vault.open(row.valueEnc, \`credentials:${row.id}\`)`. A `VaultError` becomes `AgentStartError("Can't decrypt credential <name>. Was FACTORY_SECRET_KEY changed?", "credentials")`.
3. **Secrets.** For each `config.secrets`, load the row by name. Missing: `AgentStartError("Secret <S> isn't set. Add it in Settings → Secrets.", "secrets")`. Decrypt with `aad = secrets:<id>`. A `VaultError` becomes `AgentStartError("Can't decrypt secret <S>. Was FACTORY_SECRET_KEY changed?", "secrets")`.
4. **Manager and grants.** The manager is the `reportsTo` row's `{slug, displayName}`, or null. Grants are a join of `agent_project_grants` and `projects`, ordered by name.
5. **Prepare.** `workspace.prepare({ …, grants })`. A `WorkspaceError` becomes `AgentStartError(message, fix)`.
6. **Docker.** If `config.runtime === "docker"`, throw `new AgentStartError("The Docker runtime isn't available yet.")`, with the code comment `// The Docker launcher arrives in S5; prepare above still ran so the workspace is exercised.`
7. **Spec.** Return `buildRuntimeSpec({ agentId, slug, workdir, env: buildAgentEnv(serverEnv, …), claudeBin: config.claudeBin, config: agent.config, mounts })`.

Never log `spec` or `env`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/server/src/agents/runtime-spec.test.ts apps/server/src/agents/start.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): allowlisted agent env with credentials, secrets and git identity; prepareStart

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: AgentRuntime on prepareStart; test helper; seed removed; reset-session

**Files:**
- Modify:
  - `apps/server/src/agents/agent-runtime.ts`;
  - `apps/server/src/agents/runtimes.ts`;
  - `apps/server/src/app.ts` (wire `Vault`, `KeyedMutex`, `Workspace`, `prepareStart`; decorate `app.vault`, `app.workspace`, `app.lock`);
  - `apps/server/src/test/helpers.ts`;
  - every server test that used `seed()` / `seedDevAgent` / `CLAUDE_CODE_OAUTH_TOKEN` (`assembled.test.ts`, `runtimes.test.ts`, `routes/agents.test.ts`, `ws/ws.test.ts`, `agent-runtime.*.test.ts`);
  - `apps/server/scripts/smoke-harness.ts`;
  - root `package.json` scripts.
- Delete: `apps/server/src/agents/seed-dev.ts`, `apps/server/src/agents/seed-dev.test.ts`, `apps/server/scripts/seed-dev-agent.ts`
- Create: `apps/server/scripts/reset-session.ts`, `apps/server/src/agents/reset-session.ts` (logic), `apps/server/src/agents/reset-session.test.ts`
- Test: `apps/server/src/agents/agent-runtime.lifecycle.test.ts` (adapt and extend)

**Interfaces:**
- Consumes: `PrepareStart`, `AgentStartError.fix`, `AgentArchivedError` (Task 11).
- Produces:
  - `RuntimeDeps` loses `config` and `serverEnv` and gains `prepareStart: PrepareStart`;
  - `AgentRuntime.agent` becomes mutable;
  - `AgentRuntime.reload(): Promise<void>` (refreshes the row and the archived flag);
  - `AgentRuntime.markArchived(): void` (synchronous);
  - `AgentRuntime.live(): { status; turnOpen; lastError?; restartPending; restartWaitingOn }`;
  - `seedTestAgent(app: { db; config; vault; workspace }, opts?: { slug?: string; config?: Partial<TemplateConfig>; credentialValue?: string }): Promise<AgentRow>`;
  - `resetSession(db, slug): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

In `agent-runtime.lifecycle.test.ts`, change `makeRuntime` so it:
- inserts a credential row (a dummy blob) plus an agent row with the new NOT NULL columns, via a small `insertAgent(t.sql, {...})` helper in `apps/server/src/agents/testing/rows.ts` (new);
- passes `prepareStart: async (a) => { if (opts.startError) throw opts.startError; return { agentId: a.id, slug: a.slug, cwd: "/w", env: { TOKEN_SEEN: "yes" }, claudeBin: "claude", runtime: "local", permissionMode: "auto", mounts: [] }; }` instead of `config`.

Replace the old "missing token" test with:

```ts
test("a prepareStart failure is an error event with its fix, errored, 503-style AgentStartError, message pending", async () => {
  await makeRuntime({ startError: new AgentStartError("Secret GH_TOKEN isn't set. Add it in Settings → Secrets.", "secrets") });
  await expect(send("hi")).rejects.toBeInstanceOf(AgentStartError);
  const evs = await store.after(agentId, 0, 100);
  expect(evs.at(-1)?.event).toEqual({ type: "error", source: "spawn", message: "Secret GH_TOKEN isn't set. Add it in Settings → Secrets.", fix: "secrets" });
  expect(rt.live().status).toBe("errored");
  expect(rt.queueItems()).toHaveLength(1);
});

test("archived: send, compact and interrupt refuse inside the job; a refused message is not stored", async () => {
  await makeRuntime();
  rt.markArchived();
  await expect(send("hi")).rejects.toBeInstanceOf(AgentArchivedError);
  await expect(rt.compact({ byHandle: "or" })).rejects.toBeInstanceOf(AgentArchivedError);
  expect(await t.sql`select count(*)::int as n from messages where to_agent_id = ${agentId}`).toEqual([{ n: 0 }]);
});

test("reload picks up a renamed agent for summaries", async () => {
  await makeRuntime();
  await t.sql`update agents set display_name = 'Renamed' where id = ${agentId}`;
  await rt.reload();
  expect(rt.agent.displayName).toBe("Renamed");
});
```

`reset-session.test.ts`:

```ts
test("clears the session id, sets hibernated and appends session_reset", async () => {
  // insertAgent with session_id 's1' and status 'errored'
  await resetSession(t.db, "lead");
  const [row] = await t.sql`select session_id, status from agents where slug = 'lead'`;
  expect(row).toEqual({ session_id: null, status: "hibernated" });
  const evs = await new EventStore(t.db).after(row.id ?? agentId, 0, 10);
  expect(evs.at(-1)?.event).toEqual({ type: "session_reset", by: "reset-session script" });
  await expect(resetSession(t.db, "nobody")).rejects.toThrow("No agent named nobody");
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/src/agents`
Expected: FAIL (`prepareStart`, `markArchived`, `reload`, `live` and `resetSession` are missing).

- [ ] **Step 3: Implement the runtime changes**

In `agent-runtime.ts`:
- `RuntimeDeps`: remove `config` and `serverEnv`; add `prepareStart: PrepareStart`.
- `agent` becomes `agent: AgentRow` (no `readonly`); add `private archived: boolean` (from `agent.archivedAt`).
- `reload()`: `this.run(async () => { const r = await this.d.store.agentById(this.agent.id); if (r) { this.agent = r; this.archived = Boolean(r.archivedAt); } this.publishStatus(); })`.
- `markArchived()`: `this.archived = true` (synchronous; called by the archive route before it stops the process).
- `sendMessage`: run `if (this.archived) throw new AgentArchivedError(this.agent.slug)` as an **API job first**, then create the row:

```ts
  async sendMessage(m: {...}): Promise<QueueItem> {
    return this.apiJob(async () => {
      if (this.archived) throw new AgentArchivedError(this.agent.slug);
      const row = await this.d.store.createMessage({ fromUserId: m.fromUserId, toAgentId: this.agent.id, body: m.body, urgent: m.urgent });
      const entry: MessageEntry = { kind: "message", row, fromHandle: m.fromHandle };
      this.queue.push(entry);
      this.publishQueue();
      await this.ensureStarted();
      if (m.urgent) await this.urgentInterrupt(m.fromHandle);
      await this.flush();
      return this.itemOf(entry);
    });
  }
```

  Moving `createMessage` inside the job is safe: jobs are serial and the row id is only used inside the job. Add the same archived check at the top of `compact` and `interrupt`.
- `apiJob` treats `AgentArchivedError` like `AgentStartError` (no `onJobFailure`).
- `ensureStarted`:

```ts
  private async ensureStarted() {
    if (this.proc) return;
    if (this.archived) throw new AgentArchivedError(this.agent.slug);
    let spec: AgentRuntimeSpec;
    try {
      spec = await this.d.prepareStart(this.agent);
    } catch (err) {
      if (err instanceof AgentArchivedError) { this.archived = true; throw err; }
      const message = err instanceof AgentStartError ? err.message : "The agent couldn't be prepared to start.";
      if (!(err instanceof AgentStartError)) this.d.log.error({ err, agent: this.agent.slug }, "prepareStart failed");
      await this.append(null, { type: "error", source: "spawn", message, ...(err instanceof AgentStartError && err.fix ? { fix: err.fix } : {}) });
      await this.setErrored(message);
      this.publishStatus();
      throw err instanceof AgentStartError ? err : new AgentStartError(message);
    }
    // … from `if (!this.firstStartDone)` on, unchanged (version check, resume id, driver.start, pump, process_started)
  }
```

  Drop the `mkdir(agentConfigDir…)` line (`prepare` creates the directory).
- `summary()` is replaced by `live()`, which returns `{ status, turnOpen, lastError?, restartPending: false, restartWaitingOn: 0 }`. Task 13 fills in the restart fields. `statusFrame()` builds from `live()` plus `agent: this.agent.slug`.

In `runtimes.ts`:
- `RuntimesDeps` replaces `config`/`serverEnv` with `prepareStart`.
- Remove `list()`.
- Add `get(agentId)`, which returns the runtime only if it already exists (no lazy creation), `refresh(agentId)`, which calls `get(agentId)?.reload()` (and is a no-op otherwise), and `liveFields(agentId)`, which returns `get(agentId)?.live()` or the defaults `{status: row.status === "errored" ? "errored" : "hibernated", turnOpen: false, restartPending: false, restartWaitingOn: 0}`. Keep `bySlug` for routes.

In `app.ts`:
- construct `const vault = new Vault(config.secretKey); const lock = new KeyedMutex(); const workspace = new Workspace({ factoryHome: config.factoryHome, hostSkillsDir: config.hostSkillsDir, claudeBin: config.claudeBin, lock });`;
- construct `prepareStart = createPrepareStart({ db: deps.db, config, vault, workspace, lock })`;
- decorate `vault`, `lock` and `workspace`;
- create `FACTORY_HOME/agents` and `FACTORY_HOME/templates` at boot (`mkdir -p`).

In `routes/agents.ts`:
- `GET /api/agents` and `GET /api/agents/:slug` temporarily build `AgentSummary` from the row plus `runtimes.liveFields(id)`: `kind: "persistent"`, `template`, `runtime`, `reportsTo: null`, `credential: ""`, `projects: []`, `grantsOverridden`, `depth: 0` and `archivedAt` from the row. This lives in one helper, `summaryFromRow(row, live)` in `routes/agents.ts`, so the suite keeps compiling. Task 14 replaces both with `AgentService.list()`/`summary()` and deletes the helper.
- Map `AgentArchivedError` to `409 agent_archived`.

`test/helpers.ts`:
- remove `seed` and the `CLAUDE_CODE_OAUTH_TOKEN` env;
- add `FACTORY_HOST_SKILLS_DIR` (a temp dir);
- add `seedTestAgent` and expose it as `seedAgent: (o?) => seedTestAgent(first.app, o)`.

`seedTestAgent` inserts:
1. a credential `test-cred` (sealed `opts.credentialValue ?? "test-token"`);
2. an agent row (slug `opts.slug ?? "dev"`, `template: "test"`, `config: templateConfigSchema.parse({ name: "test", displayName: "Test agent", description: "", runtime: "local", permissionMode: "auto", projects: [], skills: [], localSkills: true, plugins: [], secrets: [], canSpawn: [], maxLiveSpawns: 5, warmWindowMinutes: 70, ...opts.config })`, `runtime: "local"`, `credentialId`);
3. a minimal workdir under `agentWorkdir(config.factoryHome, slug)`: `AGENTS.md`, `.claude-config/`, and `.factory/template/{settings.json: "{}", mcp.json: '{"mcpServers":{}}'}`.

Update every caller of `seed()` to `seedAgent()`. In `assembled.test.ts`, assert the fake saw `CLAUDE_CODE_OAUTH_TOKEN=test-token` in its logged env and a `CLAUDE_CONFIG_DIR` under the workdir.

Delete the seed files. In the root `package.json`:
- replace `"seed:dev-agent"` with `"agent:reset-session": "node --env-file-if-exists=.env --import tsx apps/server/scripts/reset-session.ts"`;
- add `"smoke:workspace": "node --env-file-if-exists=.env --import tsx apps/server/scripts/smoke-workspace.ts"` (Task 23 creates the script).

`agents/reset-session.ts` holds `resetSession(db, slug)` (S3's `resetDevSession` logic, generalized; throws `No agent named <slug>`). `scripts/reset-session.ts`:
1. reads `process.argv[2]` and prints usage if it's missing;
2. loads the config;
3. refuses with "Stop the server first" if `fetch(\`${config.publicUrl}/api/status\`)` answers;
4. otherwise calls `resetSession`.

Its usage text says: `Interim recovery for an agent whose session can't be resumed ("No conversation found"). The server must be stopped. A later release replaces this with an automatic path.`

`smoke-harness.ts`: build the agent with `seedTestAgent` against a minimal object (`{db, config, vault, workspace}`), set `config.model` to `"haiku"` through `opts.config`, and pass `prepareStart` from `createPrepareStart`. It now reads the token from the env and stores it as the test credential value (`credentialValue: process.env.CLAUDE_CODE_OAUTH_TOKEN`).

- [ ] **Step 4: Run the whole server suite**

Run: `pnpm vitest run apps/server packages`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server package.json
git commit -m "refactor(server): agents start through prepareStart; seed script replaced by agent:reset-session

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Apply-restart (requestRestart) in the runtime

**Files:**
- Modify: `apps/server/src/agents/agent-runtime.ts`, `apps/server/src/agents/runtimes.ts`
- Test: `apps/server/src/agents/agent-runtime.restart.test.ts` (new; reuse the lifecycle test's `makeRuntime` by moving it into `apps/server/src/agents/testing/runtime-harness.ts`)

**Interfaces:**
- Produces:
  - `AgentRuntime.requestRestart(): Promise<void>` (awaits its job);
  - `AgentRuntimes.requestRestart(agentId): Promise<void>` (a no-op when no runtime exists);
  - `live()` now reports `restartPending`/`restartWaitingOn`;
  - `AgentRuntime.stop()` sets `stopping`.

- [ ] **Step 1: Write the failing tests** (fake driver; the `ev` helpers from S3's `fake-driver.ts`)

```ts
const bg = (tasks: { taskId: string; ambient?: boolean }[]): HarnessEvent =>
  ({ type: "background_tasks", tasks: tasks.map((t) => ({ taskType: "local_bash", ...t })) });

test("not running: no-op", async () => {
  await makeRuntime();
  await rt.requestRestart();
  expect(rt.live().restartPending).toBe(false);
  expect(driver.starts).toHaveLength(0);
});

test("idle: stops now; next message resumes the same session", async () => {
  await makeRuntime();
  await send("hi"); driver.last.emit(...ev.turn("sess-1")); await rt.settled();
  await rt.requestRestart(); await rt.settled();
  expect(driver.starts[0].stopped).toBe(true);
  await send("again");
  expect(driver.starts).toHaveLength(2);
  expect(driver.last.opts.resumeSessionId).toBe("sess-1");
});

test.each([
  ["an open turn", (p: FakeProcess) => p.emit(ev.session(), ev.turnStarted()), (p: FakeProcess) => p.emit(...ev.turnEnd())],
  ["a live background task", (p: FakeProcess) => p.emit(bg([{ taskId: "t1" }])), (p: FakeProcess) => p.emit(bg([]))],
  ["an owed notification turn", (p: FakeProcess) => p.emit({ type: "background_task_finished", taskId: "t1", status: "completed", summary: "" }, bg([])),
    (p: FakeProcess) => p.emit(ev.turnStarted(), ...ev.turnEnd({ originKind: "task-notification" }))],
])("waits for %s", async (_n, busy, release) => {
  await makeRuntime();
  await send("hi"); driver.last.emit(...ev.turn("sess-1")); await rt.settled();
  busy(driver.last); await rt.settled();
  await rt.requestRestart(); await rt.settled();
  expect(driver.last.stopped).toBe(false);
  expect(rt.live().restartPending).toBe(true);
  release(driver.last); await rt.settled();
  expect(driver.starts[0].stopped).toBe(true);
});

test("ambient tasks don't block; restartWaitingOn counts non-ambient ones", async () => {
  await makeRuntime();
  await send("hi"); driver.last.emit(...ev.turn("sess-1"), bg([{ taskId: "a", ambient: true }, { taskId: "b" }])); await rt.settled();
  await rt.requestRestart(); await rt.settled();
  expect(rt.live().restartWaitingOn).toBe(1);
  driver.last.emit(bg([{ taskId: "a", ambient: true }])); await rt.settled();
  expect(driver.starts[0].stopped).toBe(true);
});

test("a message during the stop grace is held, then delivered after the restart without delivery_failed", async () => {
  await makeRuntime();
  await send("hi"); driver.last.emit(...ev.turn("sess-1")); await rt.settled();
  driver.last.holdStop = true; // FakeProcess: stop() resolves only when released
  await rt.requestRestart();
  const p = send("during");
  await rt.settled();
  expect(driver.starts[0].sent).toHaveLength(1);
  driver.starts[0].releaseStop(); await p; await rt.settled();
  expect(driver.starts).toHaveLength(2);
  expect(driver.last.sent.flat().map((m) => m.body)).toEqual(["during"]);
  expect((await store.after(agentId, 0, 1000)).some((e) => e.event.type === "delivery_failed")).toBe(false);
});

test("pending items trigger the restart's own start; a start failure keeps its real error", async () => {
  await makeRuntime();
  await send("hi"); driver.last.emit(...ev.turn("sess-1")); await rt.settled();
  driver.last.holdStop = true;
  await rt.requestRestart();
  const p = send("queued").catch(() => {});
  startError = new AgentStartError("Secret GH_TOKEN isn't set. Add it in Settings → Secrets.", "secrets");
  driver.starts[0].releaseStop(); await p; await rt.settled();
  expect(rt.live().lastError).toBe("Secret GH_TOKEN isn't set. Add it in Settings → Secrets.");
});

test("shutdown or archive during the grace never respawns", async () => {
  await makeRuntime();
  await send("hi"); driver.last.emit(...ev.turn("sess-1")); await rt.settled();
  driver.last.holdStop = true;
  await rt.requestRestart();
  const s = send("x").catch(() => {});
  const stopping = rt.stop();
  driver.starts[0].releaseStop(); await stopping; await s; await rt.settled();
  expect(driver.starts).toHaveLength(1);
});

test("a timed-out stop marks errored and unblocks", async () => {
  await makeRuntime();
  await send("hi"); driver.last.emit(...ev.turn("sess-1")); await rt.settled();
  driver.last.stopResult = { code: null, signal: null, timedOut: true };
  driver.last.emitExitOnStop = false;
  await rt.requestRestart(); await rt.settled();
  expect(rt.live().status).toBe("errored");
  expect(rt.live().lastError).toBe("Couldn't restart the agent: the process didn't stop.");
});

test("an unexpected exit clears restartPending", async () => {
  await makeRuntime();
  await send("hi"); driver.last.emit(...ev.turn("sess-1"), ev.turnStarted()); await rt.settled();
  await rt.requestRestart(); await rt.settled();
  driver.last.exit(1); await rt.settled();
  expect(rt.live().restartPending).toBe(false);
});
```

Extend `FakeProcess` (in `testing/fake-driver.ts`):
- `stopped: boolean`, set on `stop()`;
- `holdStop` with `releaseStop()`: `stop()` awaits a promise that `releaseStop` resolves, then emits `exited`;
- `stopResult` overrides the return value;
- `emitExitOnStop` (default true) skips the `exited` emission.

Add `ev.turn(sessionId)` (session, turn_started, usage, turn_end), `ev.turnStarted()` and `ev.turnEnd(opts?)` if the S3 helpers don't already have exactly these. Check `fake-driver.ts` and reuse its existing names where they exist. `startError` is a variable the harness's `prepareStart` consults.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/src/agents/agent-runtime.restart.test.ts`
Expected: FAIL (`requestRestart` is missing).

- [ ] **Step 3: Implement (spec §13, exactly)**

New fields:

```ts
  private restartPending = false;
  private restarting = false;
  private stopping = false;
  private liveTasks = new Map<string, boolean>(); // taskId → ambient
  private owedNotifications = 0;
```

- `requestRestart()` is `this.run(async () => { this.restartPending = true; this.maybeRestart(); this.publishStatus(); })`.
- `maybeRestart()` (synchronous; called at the end of the `turn_end` and `exited` cases, after `releaseHold()` in the hold-timeout job, and when a compact turn ends):

```ts
  private maybeRestart() {
    const proc = this.proc;
    if (!this.restartPending || !proc || proc === this.deadProc || this.errored || this.restarting || this.stopping) return;
    if (this.openTurnId || this.inFlight.length || this.awaiting.length || this.compactInFlight || this.hold) return;
    if (this.nonAmbient() > 0 || this.owedNotifications > 0) return;
    this.restarting = true;
    void proc.stop({ graceMs: 3000, termWaitMs: 10_000 }).then((r) => {
      if (r.timedOut)
        void this.run(async () => {
          if (!this.restarting) return;
          this.restarting = false;
          this.restartPending = false;
          this.deadProc = proc;
          await this.setErrored("Couldn't restart the agent: the process didn't stop.");
          this.d.log.error({ agent: this.agent.slug }, "restart stop timed out");
          this.publishStatus();
        });
    });
  }
  private nonAmbient() { let n = 0; for (const a of this.liveTasks.values()) if (!a) n += 1; return n; }
```

- `flush()`'s loop guard gains `&& !this.restarting`.
- In `onEvent`:
  - `background_tasks`: `this.liveTasks = new Map(e.tasks.map((t) => [t.taskId, Boolean(t.ambient)]))`, then append (default path).
  - `background_task_finished`: `this.owedNotifications += 1`.
  - `turn_end` with `originKind === "task-notification"`: `this.owedNotifications = Math.max(0, this.owedNotifications - 1)`.
  - `process_started` (appended in `ensureStarted`): reset `liveTasks` and `owedNotifications`.
  - At the end of the `turn_end` case: `this.maybeRestart()`.
- In `onExited`:
  - capture `const wasRestart = this.restarting && !this.stopping && !this.archived;`;
  - reset `restarting`, `restartPending`, `liveTasks` and `owedNotifications`;
  - after the existing cleanup and appends, if `wasRestart && this.queue.length`:

```ts
      try {
        await this.ensureStarted();
        await this.flush();
      } catch (err) {
        if (!(err instanceof AgentStartError || err instanceof AgentArchivedError)) {
          if (this.proc) await this.onJobFailure(this.proc, err);
          else this.d.log.error({ err, agent: this.agent.slug }, "restart failed");
        }
      }
```

    Add a code comment: `// S3 rule 5 changes here: a deliberate restart may start the process; crash exits still never do.` A deliberate restart's exit is `expected`, so it doesn't mark `errored`.
- `stop()`: set `this.stopping = true; this.restartPending = false; this.restarting = false;` before awaiting `p.stop(opts)`. Reset `stopping = false` in `onExited` once the process has gone **only if** the stop wasn't a shutdown. Simplest: reset it in `ensureStarted` when a new process starts.
- `live()` returns `restartPending: this.restartPending, restartWaitingOn: this.restartPending ? this.nonAmbient() : 0`. `statusFrame()` includes both fields.

In `runtimes.ts`, add `async requestRestart(agentId) { await this.get(agentId)?.requestRestart(); }`.

- [ ] **Step 4: Run all runtime tests**

Run: `pnpm vitest run apps/server/src/agents`
Expected: PASS, including the S3 lifecycle and delivery suites.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): requestRestart applies config changes at the next safe moment

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 14: AgentService and the agents API (create, edit, re-sync, archive, list)

**Files:**
- Create: `apps/server/src/agents/agent-service.ts`, `apps/server/src/agents/agent-service.test.ts`
- Modify: `apps/server/src/routes/agents.ts`, `apps/server/src/routes/agents.test.ts`, `apps/server/src/app.ts` (decorate `app.agents`, `app.templates`)

**Interfaces:**
- Consumes: `TemplateIndex.loadValid` (Task 7), `Workspace` (Task 10), `KeyedMutex` (Task 9), `AgentRuntimes.refresh/requestRestart/liveFields/get` (Tasks 12 and 13), `treeOrder` (Task 1).
- Produces:

```ts
export class AgentService {
  constructor(d: { db: Db; templates: TemplateIndex; workspace: Workspace; lock: KeyedMutex; runtimes: AgentRuntimes; log: RuntimeLog });
  list(archived: "exclude" | "include" | "only"): Promise<AgentSummary[]>;
  summary(slug: string): Promise<AgentSummary>; // 404 agent_not_found
  create(b: CreateAgentBody): Promise<AgentSummary>;
  update(slug: string, b: PatchAgentBody): Promise<AgentSummary>;
  resync(slug: string): Promise<{ agent: AgentSummary; backupDir?: string }>;
  archive(slug: string): Promise<AgentSummary>;
  unarchive(slug: string): Promise<AgentSummary>;
}
```

- [ ] **Step 1: Write the failing tests** (`agent-service.test.ts`, real DB through `makeTestApp`; a template written into `FACTORY_HOME/templates/lead` with `runtime: local`; the fake claude as `FACTORY_CLAUDE_BIN`; a credential row sealed with `app.vault`; a project row pointing at a temp dir)

```ts
test("create: layout on disk, rows, grants default; then summary in tree order", async () => {
  const a = await svc.create({ template: "lead", slug: "lead", displayName: "Lead", description: "", reportsTo: null, credential: "work" });
  expect(a).toMatchObject({ slug: "lead", template: "lead", runtime: "local", credential: "work", projects: ["app"], grantsOverridden: false, depth: 0, archivedAt: null });
  expect(existsSync(path.join(home, "agents/lead/AGENTS.md"))).toBe(true);
  const b = await svc.create({ template: "lead", slug: "dev-1", displayName: "Dev", description: "", reportsTo: "lead", credential: "work", projects: [] });
  expect(b).toMatchObject({ projects: [], grantsOverridden: true, depth: 1 });
  expect((await svc.list("exclude")).map((x) => x.slug)).toEqual(["lead", "dev-1"]);
});

test.each([
  ["slug taken", { slug: "lead" }, { code: "slug_taken" }],
  ["reserved slug", { slug: "humans" }, { code: "validation_error" }],
  ["unknown credential", { credential: "nope" }, { code: "validation_error", extra: { fields: { credential: expect.any(String) } } }],
  ["unknown project", { projects: ["web"] }, { code: "validation_error", extra: { fields: { projects: expect.any(String) } } }],
  ["unknown manager", { reportsTo: "ghost" }, { code: "validation_error" }],
  ["invalid template", { template: "broken" }, { code: "template_invalid" }],
])("create rejects: %s", async (_n, patch, err) => {
  await expect(svc.create({ template: "lead", slug: "x-new", displayName: "X", description: "", reportsTo: null, credential: "work", ...patch })).rejects.toMatchObject(err);
});

test("create race on one slug: one wins, the loser leaves the winner's folder intact", async () => {
  const body = { template: "lead", slug: "racer", displayName: "R", description: "", reportsTo: null, credential: "work" };
  const r = await Promise.allSettled([svc.create(body), svc.create(body)]);
  expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(existsSync(path.join(home, "agents/racer/AGENTS.md"))).toBe(true);
});

test("create: plugin failure removes the folder and inserts no row; existing folder → folder_exists, untouched", async () => {
  // a template "plugged" whose plugin is in FAKE_CLAUDE_PLUGIN_FAIL
  await expect(svc.create({ template: "plugged", slug: "pl", displayName: "P", description: "", reportsTo: null, credential: "work" })).rejects.toMatchObject({ code: "plugin_install_failed" });
  expect(existsSync(path.join(home, "agents/pl"))).toBe(false);
  mkdirSync(path.join(home, "agents/occupied"), { recursive: true });
  writeFileSync(path.join(home, "agents/occupied/keep.txt"), "k");
  await expect(svc.create({ template: "lead", slug: "occupied", displayName: "O", description: "", reportsTo: null, credential: "work" })).rejects.toMatchObject({ code: "folder_exists" });
  expect(existsSync(path.join(home, "agents/occupied/keep.txt"))).toBe(true);
});

test("update: cycle rejected; projects null resets; restart requested for it and (on rename) its reports", async () => {
  const spy = vi.spyOn(runtimes, "requestRestart");
  await expect(svc.update("lead", { reportsTo: "dev-1" })).rejects.toMatchObject({ message: "That would make @lead report to itself through @dev-1." });
  await svc.update("dev-1", { projects: null });
  expect((await svc.summary("dev-1")).grantsOverridden).toBe(false);
  await svc.update("lead", { displayName: "Lead 2" });
  expect(spy.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([idOf("lead"), idOf("dev-1")]));
});

test("resync: backup dir, runtime column, grants follow unless overridden; refused when archived", async () => {
  writeFileSync(path.join(home, "agents/lead/AGENTS.md"), "edited");
  writeFileSync(path.join(home, "templates/lead/template.yaml"), "name: lead\ndisplay_name: Lead\nruntime: local\nprojects: []\n");
  const r = await svc.resync("lead");
  expect(r.backupDir).toMatch(/^\.factory\/resync\//);
  expect(r.agent.projects).toEqual([]);
});

test("archive is blocked while active reports exist", async () => {
  await expect(svc.archive("lead")).rejects.toMatchObject({ code: "has_reports", message: "@dev-1 reports to this agent. Change their manager first." });
});

test("archive hides, refuses re-sync, allows PATCH; unarchive restores", async () => {
  await svc.archive("dev-1");
  expect((await svc.list("only")).map((a) => a.slug)).toEqual(["dev-1"]);
  expect((await svc.list("exclude")).map((a) => a.slug)).not.toContain("dev-1");
  await expect(svc.resync("dev-1")).rejects.toMatchObject({ code: "agent_archived" });
  expect((await svc.update("dev-1", { description: "parked" })).description).toBe("parked");
  expect((await svc.unarchive("dev-1")).archivedAt).toBeNull();
});

test("unarchive is refused while the manager is archived", async () => {
  await svc.update("dev-1", { reportsTo: null });
  await svc.create({ template: "lead", slug: "helper", displayName: "Helper", description: "", reportsTo: "dev-1", credential: "work" });
  await svc.archive("helper");
  await svc.archive("dev-1");
  await expect(svc.unarchive("helper")).rejects.toMatchObject({ code: "manager_archived", message: "Its manager @dev-1 is archived. Change its manager first." });
});
```

The tests in this file run in order (vitest's default within a file) and share the agents created by the first test, `lead` and `dev-1`. The `lead` template has no plugins, to keep the suite fast. Only `plugged` installs one (failing through `FAKE_CLAUDE_PLUGIN_FAIL`). `idOf(slug)` is a small helper that reads the agent id from the DB.

Route tests (`routes/agents.test.ts`, add):
- `POST /api/agents` gives `201`;
- `400` with `fields.slug`;
- `PATCH` gives `200`;
- the resync, archive and unarchive status codes;
- `GET /api/agents?archived=only`;
- `POST /api/agents/x/messages` to an archived agent gives `409 agent_archived`, and no message row is stored;
- route param `slug = "..%2F..%2Fetc"` gives `400 validation_error` on every `:slug` route (the shared `slugSchema` parses params).

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/src/agents/agent-service.test.ts apps/server/src/routes/agents.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `agent-service.ts`**

Every user-facing failure is an `ApiError` or a `FieldError`.

- **`list(archived)`.** It selects agents (filtered by `archived_at`), joined with the credential name, the grant project names and the manager slug. It orders them with `treeOrder` over the listed set. Each row is mapped to `AgentSummary`: `kind: "persistent"`, `runtime`, `template`, `reportsTo` (the manager slug, or null), `credential`, `projects`, `grantsOverridden`, `depth`, `archivedAt` ISO or null, and the live fields from `runtimes.liveFields(id)`.
- **`create(b)`** runs inside `this.lock.run("create:" + b.slug, …)` (the per-slug create lock; spec §6.2):
  1. `slugSchema` (already parsed by the route);
  2. if the slug is in the DB, `FieldError("slug", "That slug is taken.", "slug_taken")`;
  3. `const tpl = await templates.loadValid(b.template)`;
  4. the credential by name, or `FieldError("credential", "Choose a credential.")`;
  5. the manager by slug among non-archived agents, or `FieldError("reportsTo", "Choose an active agent.")`;
  6. projects = `b.projects ?? tpl.config.projects`, each registered, or `FieldError("projects", "Project <p> isn't registered.")`;
  7. `workspace.materialize(slug, slug, tpl, prepInput)` inside `lock.run(slug, …)`, catching errors: if the error isn't a `FieldError` with code `folder_exists`, call `workspace.discard(slug)`; a `PluginInstallError` becomes `ApiError(502, "plugin_install_failed", err.message, { output: err.output })`;
  8. a transaction inserts the agent row (`id: randomUUID()`, `config: tpl.config`, `runtime: tpl.config.runtime`, `grantsOverridden: b.projects !== undefined`) and the grants. On failure, `discard`. A unique violation (`23505` on `agents_slug_unique`) becomes `FieldError("slug", "That slug is taken.", "slug_taken")`;
  9. return `summary(slug)`.
- **`update(slug, b)`.**
  - It loads the row (404 if missing) and validates each present field as in `create`.
  - **Cycle check:** walk `reportsTo` from the new manager upward. If it reaches `slug`, throw `FieldError("reportsTo", \`That would make @${slug} report to itself through @${newManager}.\`)`.
  - `projects: null` resets to `config.projects` with `grantsOverridden = false`; an array sets it with `true`.
  - Update in a transaction, then `runtimes.refresh(id)`.
  - If anything that feeds start-time files changed (credential, grants, manager, display name, description), call `runtimes.requestRestart(id)`.
  - If the display name or description changed, also call `requestRestart` for each non-archived direct report.
- **`resync(slug)`.**
  - An archived agent throws `ApiError(409, "agent_archived", "@<slug> is archived. Restore it first.")`.
  - `const tpl = await templates.loadValid(row.template)`.
  - `lock.run(slug, async () => { backupDir = await workspace.resync(slug, tpl); update snapshot + runtime column; if (!grantsOverridden) replace grants with tpl.config.projects (each must be registered: else ApiError(409, "template_invalid", …)) })`. A `PluginInstallError` becomes `502`, and the snapshot is not updated (the update happens after the install).
  - After the lock: `refresh` and `requestRestart`.
- **`archive(slug)`.**
  - Active reports throw `ApiError(409, "has_reports", "@a, @b reports to this agent. Change their manager first.", { reports })`. Use "report" for several: "@a and @b report to this agent. Change their manager first."
  - Set `archived_at`, then `runtimes.get(id)?.markArchived()`, `await runtimes.get(id)?.stop({ graceMs: 3000, termWaitMs: 10_000 })` and `refresh`.
- **`unarchive(slug)`.** An archived manager throws `ApiError(409, "manager_archived", "Its manager @m is archived. Change its manager first.")`. Otherwise clear `archived_at` and `refresh`.

Routes in `routes/agents.ts`:
- `params: z.object({ slug: slugSchema })` on every `:slug` route, so a bad slug gives `400` before any disk or DB access;
- `GET /api/agents` with `querystring: agentListQuerySchema` → `{ agents: await app.agents.list(q.archived) }`;
- `GET /api/agents/:slug` uses `app.agents.summary(slug)` for the `agent` field;
- `POST /api/agents` (`201 agentResponseSchema`);
- `PATCH /api/agents/:slug`;
- `POST /api/agents/:slug/resync | archive | unarchive`.

The send, compact and interrupt handlers map `AgentArchivedError` to `409 agent_archived`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): agent create, edit, re-sync, archive and the org tree list

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Credentials: verification turn, service and routes

**Files:**
- Create: `apps/server/src/credentials/verify.ts`, `apps/server/src/credentials/credential-service.ts`, `apps/server/src/routes/credentials.ts`
- Test: `apps/server/src/credentials/verify.test.ts`, `apps/server/src/credentials/credential-service.test.ts`, `apps/server/src/routes/credentials.test.ts`
- Create: `packages/harness/testing/scenarios/invalid-token.json` (the fake replays `error-invalid-oauth-token` on the first user line)

**Interfaces:**
- Produces:

```ts
export type VerifyResult = { ok: true } | { ok: false; kind: "rejected" | "unreachable"; message: string };
export class CredentialVerifier {
  constructor(d: { driver: HarnessDriver; claudeBin: string; serverEnv?: NodeJS.ProcessEnv; timeoutMs?: number });
  verify(kind: CredentialKind, value: string): Promise<VerifyResult>;
}
export class CredentialService {
  constructor(d: { db: Db; vault: Vault; verifier: CredentialVerifier; runtimes: AgentRuntimes });
  list(): Promise<CredentialSummary[]>;
  create(b: { name: string; kind: CredentialKind; value: string }): Promise<CredentialSummary>;
  replace(name: string, value: string): Promise<CredentialSummary>;
  reverify(name: string): Promise<CredentialSummary>;
  remove(name: string): Promise<void>;
}
```

- [ ] **Step 1: Write the failing tests**

`verify.test.ts`, with the real `ClaudeDriver` against the fake (no network):

```ts
test("success: env is minimal, haiku, temp dir removed", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const v = new CredentialVerifier({ driver: createClaudeDriver(silent), claudeBin: fake.bin, serverEnv: { PATH: process.env.PATH, HOME: "/h", DATABASE_URL: "x", ANTHROPIC_API_KEY: "server" } });
  expect(await v.verify("oauth_token", "tok")).toEqual({ ok: true });
  const start = fake.log().find((e) => e.kind === "start");
  expect(Object.keys(start.env).filter((k) => !k.startsWith("FAKE_") && k !== "PWD" && k !== "SHLVL" && k !== "_").sort())
    .toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
  expect(start.argv).toEqual(expect.arrayContaining(["--model", "haiku"]));
  expect(existsSync(start.env.CLAUDE_CONFIG_DIR)).toBe(false);
});
test("401 → rejected; api_key wording", async () => {
  const fake = createFakeClaude({ scenario: "invalid-token" });
  const v = new CredentialVerifier({ driver: createClaudeDriver(silent), claudeBin: fake.bin });
  expect(await v.verify("oauth_token", "bad")).toEqual({ ok: false, kind: "rejected", message: "Claude rejected this token. Create a new one with `claude setup-token`." });
  expect((await v.verify("api_key", "bad")).message).toBe("Claude rejected this API key.");
});
test("no session / timeout → unreachable", async () => {
  const v = new CredentialVerifier({ driver: createClaudeDriver(silent), claudeBin: "/nonexistent/claude" });
  expect(await v.verify("oauth_token", "x")).toEqual({ ok: false, kind: "unreachable", message: "Couldn't reach Claude to verify. Try again." });
});
```

(The wrapper script may add shell vars such as `PWD`, `SHLVL` and `_`. Check the fake's logged env once and adjust the filter to exactly what the wrapper adds; the four real keys are the assertion. If `createFakeClaude`'s wrapper injects `FAKE_*` vars into the child env, they're filtered out the same way.)

`invalid-token.json`:

```json
{ "onUser": [{ "emit": { "fixture": "error-invalid-oauth-token", "lines": [1, 999] } }] }
```

(The fake stops at the fixture's end. Check that the fake tolerates an out-of-range end line; otherwise use the fixture's line count.)

`credential-service.test.ts` (with a fake verifier object):
- create stores a sealed value (the raw bytes don't contain the token), and `list` never contains the value;
- a rejected verification gives `422 credential_rejected` and no row;
- unreachable gives `422 credential_unverifiable`;
- a duplicate name gives `409 credential_exists`;
- `replace` re-verifies and calls `runtimes.requestRestart` for each active user;
- `reverify` records `lastVerifiedAt` and `lastError`;
- `remove` while it's used by an active or archived agent gives `409 credential_in_use` with `usedBy` and `archivedUsedBy` and both sentences ("Used by @a. Change their credential first." / "Archived agents @c still reference it. Edit them first.");
- `remove` when unused gives `204`;
- a logger capture shows neither the value nor `https://user:pw@` text from a failure output.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/src/credentials`
Expected: FAIL.

- [ ] **Step 3: Implement**

`CredentialVerifier.verify`:

```ts
  async verify(kind: CredentialKind, value: string): Promise<VerifyResult> {
    const dir = await mkdtemp(path.join(tmpdir(), "of-verify-"));
    const env: Record<string, string> = { CLAUDE_CONFIG_DIR: dir, [kind === "api_key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN"]: value };
    for (const k of ["PATH", "HOME"] as const) { const v = (this.d.serverEnv ?? process.env)[k]; if (v) env[k] = v; }
    const proc = this.d.driver.start(
      { agentId: "verify", slug: "verify", cwd: dir, env, claudeBin: this.d.claudeBin, runtime: "local", model: "haiku", permissionMode: "auto", mounts: [] },
      {},
    );
    let code: string | undefined; let status: number | undefined; let ok = false; let sawSession = false;
    const done = (async () => {
      for await (const e of proc.events) {
        if (e.type === "session_started") sawSession = true;
        if (e.type === "error" && e.code) code = e.code;
        if (e.type === "turn_end") { ok = !e.isError; status = e.apiErrorStatus; break; }
        if (e.type === "exited") break;
      }
    })();
    try {
      await proc.send([{ id: "verify", from: "@factory", kind: "message", urgent: false, body: "Reply with the single word OK." }]).catch(() => {});
      await Promise.race([done, new Promise((r) => setTimeout(r, this.d.timeoutMs ?? 60_000))]);
    } finally {
      await proc.stop({ graceMs: 1000, termWaitMs: 5000 }).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
    if (ok) return { ok: true };
    if (code === "authentication_failed" || status === 401 || status === 403)
      return { ok: false, kind: "rejected", message: kind === "api_key" ? "Claude rejected this API key." : "Claude rejected this token. Create a new one with `claude setup-token`." };
    void sawSession;
    return { ok: false, kind: "unreachable", message: "Couldn't reach Claude to verify. Try again." };
  }
```

Remove the unused `sawSession` if biome complains.

`CredentialService`:
- **Seal.** It seals with `aad = credentials:<id>` (id generated before the insert).
- **Usage.** `usedBy` and `archivedUsedBy` are agent slugs grouped by `archived_at`.
- **Create, replace, re-verify.**
  - `create`: verify first (`422` on failure), then insert (`409 credential_exists` on a unique violation).
  - `replace`: verify, then update the value, `last_verified_at = now()`, `last_error = null`, then `requestRestart` for the active users.
  - `reverify`: open the value, verify, then record `last_verified_at` on success or `last_error` (the message) on failure; it always returns the summary.
- **Remove.** Throws `ApiError(409, "credential_in_use", <sentences>, { usedBy, archivedUsedBy })` while referenced.

Routes `routes/credentials.ts`, with `requireUser` on every route and the param `name: nameSchema`:
- `GET /api/credentials` → `credentialsListSchema`;
- `POST /api/credentials` → `201 credentialResponseSchema`;
- `PUT /api/credentials/:name/value`;
- `POST /api/credentials/:name/verify`;
- `DELETE /api/credentials/:name` → `204`.

Register them in `app.ts`, with `CredentialVerifier` using the app's harness driver and `config.claudeBin`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/server/src/credentials apps/server/src/routes/credentials.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server packages/harness
git commit -m "feat(server): named credentials with a verification turn

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Secrets and projects

**Files:**
- Create: `apps/server/src/secrets/secret-service.ts`, `apps/server/src/projects/project-service.ts`, `apps/server/src/routes/secrets.ts`, `apps/server/src/routes/projects.ts`
- Test: `apps/server/src/secrets/secret-service.test.ts`, `apps/server/src/projects/project-service.test.ts`, `apps/server/src/routes/settings-routes.test.ts`

**Interfaces:**
- Produces:

```ts
export class SecretService {
  constructor(d: { db: Db; vault: Vault; runtimes: AgentRuntimes });
  list(): Promise<SecretSummary[]>;                 // usedBy = non-archived agents whose config.secrets has it
  put(name: string, value: string): Promise<SecretSummary>; // upsert; requestRestart for usedBy
  remove(name: string): Promise<void>;              // requestRestart for usedBy; 404 if missing
}
export class ProjectService {
  constructor(d: { db: Db; runtimes: AgentRuntimes; templates: TemplateIndex });
  list(): Promise<ProjectSummary[]>;
  create(b: { name: string; hostPath: string }): Promise<ProjectSummary>;
  update(name: string, hostPath: string): Promise<ProjectSummary>; // requestRestart for granted active agents
  remove(name: string): Promise<void>;              // 409 project_in_use while any grant exists
}
```

- [ ] **Step 1: Write the failing tests**

Secrets:
- `put` creates, then updates (`updatedAt` changes);
- the stored bytes don't contain the value;
- `usedBy` comes from agent snapshots (insert an agent whose `config.secrets` is `["GH_TOKEN"]`);
- `put` and `remove` call `requestRestart` for that agent (a spy);
- a reserved name at the route gives `400 validation_error`;
- `GET` never returns the value.

Projects:
- `create` stores the realpath of the given path (create via a symlinked temp dir and expect the resolved path);
- a missing path gives `FieldError("hostPath", "No folder at /x.")`;
- a file path gives the same message;
- a duplicate name gives `409 project_exists`;
- a duplicate path gives `FieldError("hostPath", "Project app already uses this folder.")`;
- `update` calls `requestRestart` for granted active agents;
- `remove` with an archived agent's grant gives `409 project_in_use` with `grantedTo: []` and `archivedGrantedTo: ["old"]`;
- `remove` when unused works;
- `list` includes `templates` that list the project (write a template folder listing `app` and run `templates.scan()` first).

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/src/secrets apps/server/src/projects apps/server/src/routes/settings-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- **Secrets.** Seal with `aad = secrets:<id>`; on update keep the id and re-seal. `usedBy` is computed with `select slug from agents where archived_at is null and config->'secrets' ? ${name}` (Drizzle `sql` template).
- **Projects.**
  - `realpath` and `stat().isDirectory()` the host path.
  - The project in-use message is `Granted to @a, @b. Remove the grant first.`, plus ` Archived agents @c still hold a grant.` when there are archived holders.
  - `templates` comes from `templates.scan()` rows whose `config?.projects` includes the name.
- **Routes** (`requireUser`):
  - `GET /api/secrets`, `PUT /api/secrets/:name` (params `secretParamsSchema`), `DELETE /api/secrets/:name` → `204`;
  - `GET /api/projects`, `POST /api/projects` → `201`, `PATCH /api/projects/:name`, `DELETE /api/projects/:name` → `204` or `409 {grantedTo, archivedGrantedTo}`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): write-only secrets and registered projects

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Templates API

**Files:**
- Create: `apps/server/src/routes/templates.ts`, `apps/server/src/routes/templates.test.ts`
- Modify: `apps/server/src/app.ts` (register)

**Interfaces:**
- Consumes: `TemplateIndex` (Task 7).
- Produces:
  - `GET /api/templates` → `{dir, templates}`;
  - `GET /api/templates/:name` → `{template}`;
  - `POST /api/templates` → `201 {template}`;
  - `PUT /api/templates/:name/files/:file` → `{hash, issues}`;
  - `POST /api/templates/:name/validate` → `{issues}`;
  - `DELETE /api/templates/:name` → `204`.

- [ ] **Step 1: Write the failing tests**

```ts
test("list rescans; summaries carry counts and optional fields for unparseable templates", async () => {
  mkdirSync(path.join(h.factoryHome, "templates/broken"), { recursive: true });
  writeFileSync(path.join(h.factoryHome, "templates/broken/template.yaml"), "name: [");
  const r = await get("/api/templates");
  expect(r.statusCode).toBe(200);
  expect(r.json().dir).toBe(path.join(h.factoryHome, "templates"));
  expect(r.json().templates.find((t: { name: string }) => t.name === "broken")).toMatchObject({ errors: 2, warnings: 0, agentCount: 0 });
});
test("traversal and bad names never reach the filesystem", async () => {
  for (const url of ["/api/templates/..%2F..%2Fetc", "/api/templates/%2Ftmp", "/api/templates/x/files/..%2Fsecret"]) {
    const r = await del(url);
    expect(r.statusCode).toBe(400);
  }
  expect((await put("/api/templates/lead/files/other.txt", { content: "", baseHash: null })).statusCode).toBe(400);
});
test("404 on a deleted folder for detail, save and validate", async () => {
  for (const r of [await get("/api/templates/gone"), await put("/api/templates/gone/files/AGENTS.md", { content: "", baseHash: null }), await post("/api/templates/gone/validate", { file: "AGENTS.md", content: "" })])
    expect(r.json().error.code).toBe("template_not_found");
});
test("save conflict returns currentHash; create conflict 409", async () => {
  expect((await post("/api/templates", { name: "lead", displayName: "Lead" })).statusCode).toBe(201);
  const d = (await get("/api/templates/lead")).json().template;
  const agentsMd = d.files.find((f: { file: string }) => f.file === "AGENTS.md");
  writeFileSync(path.join(h.factoryHome, "templates/lead/AGENTS.md"), "# Changed on disk\n");
  const r = await put("/api/templates/lead/files/AGENTS.md", { content: "# Mine\n", baseHash: agentsMd.hash });
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toMatchObject({ code: "changed_on_disk", currentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  const again = await put("/api/templates/lead/files/AGENTS.md", { content: "# Mine\n", baseHash: r.json().error.currentHash });
  expect(again.statusCode).toBe(200);
  expect((await post("/api/templates", { name: "lead", displayName: "Lead" })).json().error.code).toBe("template_exists");
});
test("unauthenticated → 401", async () => { expect((await h.app.inject({ method: "GET", url: "/api/templates" })).statusCode).toBe(401); });
```

`get`, `put`, `post` and `del` are signed-in `inject` helpers defined at the top of the file: `const s = await h.signUpUser(); const get = (url: string) => h.app.inject({ method: "GET", url, headers: { cookie: s.cookie } });`, and likewise for the others with a JSON `payload`. The "broken" template has two errors (YAML syntax and missing `AGENTS.md`).

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/server/src/routes/templates.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the routes**

They use `params: z.object({ name: nameSchema })`, and for files `z.object({ name: nameSchema, file: templateFileSchema })`, with the bodies from Task 1. `GET /api/templates` maps `scan()` rows to summaries: `errors` and `warnings` counted from `issues`; `agentCount` from a `count(*) group by template` over non-archived agents. `POST` returns `201` with `detail(name)`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/server`
Expected: PASS. Then run the root typecheck: `pnpm typecheck` (the web will still fail on the new `AgentSummary`; fix only server and package errors here).

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): templates API with hashed saves and validation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 18: Web foundation: shared form controls, dialogs and data clients

**Files:**
- Create:
  - `apps/web/src/components/field-shell.tsx`, `native-select.tsx`, `password-input.tsx`, `inline-outcome.tsx`, `confirm-dialog.tsx`, `middle-truncate.tsx`;
  - `apps/web/src/features/templates/api.ts`, `apps/web/src/features/agents/api.ts`, `apps/web/src/features/settings/api.ts`.
- Add (shadcn, locked CLI): `apps/web/src/components/ui/alert-dialog.tsx`
- Modify: `apps/web/src/components/form-field.tsx` (rebuilt on `FieldShell`), `apps/web/src/features/session/use-agent-status.ts` (fold `restartPending`/`restartWaitingOn`), `apps/web/src/features/session/api.ts` (list query with `archived`)
- Create: `apps/web/src/test/mock-api.ts` (test helper)
- Test: `apps/web/src/test/field-shell.test.tsx`, `apps/web/src/test/confirm-dialog.test.tsx`, `apps/web/src/test/inline-outcome.test.tsx`, `apps/web/src/test/use-agent-status.test.tsx` (extend)

**Interfaces:**
- Produces:

```tsx
export function FieldShell(p: { name: string; label: string; error?: string; help?: string; legend?: boolean;
  children: (a: { id: string; describedBy?: string; invalid: boolean }) => ReactNode }): JSX.Element;
export function NativeSelect(p: ComponentProps<"select">): JSX.Element;        // h-9, plate fill, field-edge
export function PasswordInput(p: Omit<ComponentProps<"input">, "type">): JSX.Element; // show/hide, new-password, data-1p-ignore, data-lpignore
export function InlineOutcome(p: { tone: "success" | "error"; children: ReactNode; undo?: () => void; focusOnMount?: boolean }): JSX.Element;
export function ConfirmDialog(p: { open: boolean; onOpenChange(o: boolean): void; title: string; body: ReactNode; confirmLabel: string; onConfirm(): Promise<void> | void }): JSX.Element;
export function MiddleTruncate(p: { text: string }): JSX.Element;            // head span truncates; last segment fixed; full text sr-only
// features/*/api.ts: queryOptions + mutations for every route of Tasks 14–17, parsed with the shared schemas, e.g.
export const templatesQueryOptions: ...; export const templateQueryOptions: (name: string) => ...;
export const saveTemplateFile: (name: string, file: TemplateFile, content: string, baseHash: string | null) => Promise<{ hash: string; issues: TemplateIssue[] }>;
export const validateTemplateFile: (name: string, file: TemplateFile, content: string) => Promise<TemplateIssue[]>;
export const createTemplate, deleteTemplate;
export const agentsListQueryOptions: (archived: "exclude" | "only") => ...; export const createAgent, updateAgent, resyncAgent, archiveAgent, unarchiveAgent;
export const credentialsQueryOptions, createCredential, replaceCredential, verifyCredential, deleteCredential;
export const secretsQueryOptions, putSecret, deleteSecret;
export const projectsQueryOptions, createProject, updateProject, deleteProject;
```

`apiFetch` errors already expose `code`/`message`. Check `packages/shared/src/api-fetch.ts`, and if the parsed error body's extra fields (`fields`, `currentHash`, `usedBy`, `output`) aren't kept on the thrown error, extend its error class to carry the whole `error` object as `body` (plus a test in `api-fetch.test.ts`).

- [ ] **Step 1: Add alert-dialog**

Run: `pnpm --filter @open-factory/web exec shadcn add alert-dialog`
Expected: it creates `src/components/ui/alert-dialog.tsx` importing from `radix-ui`. If the CLI tries to add a new npm dependency, stop: Radix is already present through `radix-ui`, so edit the generated imports to use it.

- [ ] **Step 2: Write the test helper and the failing tests**

`apps/web/src/test/mock-api.ts` (method-aware, generalizing the S3 `session-view.test.tsx` stub; the later web tasks use it):

```ts
import { vi } from "vitest";

export const json = (data: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
export type Handler = (body: unknown, url: string) => Response | Promise<Response>;
export interface MockApi { calls: { method: string; url: string; body: unknown }[]; on(key: string, h: Handler): void }

/** Keys are "METHOD /path" (exact) or "METHOD /path?" (prefix, longest wins). Unknown → 404. */
export function mockApi(routes: Record<string, Handler>): MockApi {
  const table = { ...routes };
  const api: MockApi = { calls: [], on: (k, h) => { table[k] = h; } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    api.calls.push({ method, url, body });
    const key = Object.keys(table)
      .filter((k) => { const [m, p] = k.split(" "); return m === method && (url === p || (p.endsWith("?") && url.startsWith(p))); })
      .sort((a, b) => b.length - a.length)[0];
    return key ? table[key](body, url) : json({ error: { code: "not_found", message: url } }, 404);
  }));
  return api;
}
```

Pages that open the WebSocket also need S3's `vi.mock("@/lib/ws", …)` and `vi.mock("@/lib/auth-client", …)` blocks. Copy them from `session-view.test.tsx` into each new web test file.

`field-shell.test.tsx`:

```tsx
test("FieldShell wires label, help and error; error replaces help", () => {
  const { rerender } = render(<FieldShell name="slug" label="Slug" help="How others address it.">{(a) => <input id={a.id} aria-describedby={a.describedBy} aria-invalid={a.invalid || undefined} />}</FieldShell>);
  expect(screen.getByLabelText("Slug")).toHaveAccessibleDescription("How others address it.");
  rerender(<FieldShell name="slug" label="Slug" help="How others address it." error="That slug is taken.">{(a) => <input id={a.id} aria-describedby={a.describedBy} aria-invalid={a.invalid || undefined} />}</FieldShell>);
  expect(screen.getByLabelText("Slug")).toHaveAccessibleDescription("That slug is taken.");
});
test("FormField keeps its API (S1 tests stay green)", () => {
  render(<FormField name="email" label="Email" error="Wrong" />);
  expect(screen.getByLabelText("Email")).toHaveAccessibleDescription("Wrong");
});
test("PasswordInput toggles visibility and opts out of managers", async () => {
  render(<label>Token<PasswordInput /></label>);
  const input = screen.getByLabelText("Token");
  expect(input).toHaveAttribute("type", "password");
  expect(input).toHaveAttribute("autocomplete", "new-password");
  expect(input).toHaveAttribute("data-1p-ignore");
  await userEvent.click(screen.getByRole("button", { name: "Show" }));
  expect(input).toHaveAttribute("type", "text");
});
```

`confirm-dialog.test.tsx`:

```tsx
test("names the action, Cancel focused first, Escape cancels", async () => {
  const onConfirm = vi.fn();
  render(<ConfirmDialog open onOpenChange={() => {}} title="Delete secret GH_TOKEN?" body="Its value is erased." confirmLabel="Delete GH_TOKEN" onConfirm={onConfirm} />);
  expect(screen.getByRole("alertdialog", { name: "Delete secret GH_TOKEN?" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "Delete GH_TOKEN" }));
  expect(onConfirm).toHaveBeenCalled();
});
```

`inline-outcome.test.tsx`: a success renders inside a `role="status"` region, an error inside `role="alert"`, `focusOnMount` focuses the Undo button (or the line), and Undo calls the callback.

Extend `use-agent-status.test.tsx`: a frame with `restartPending: true, restartWaitingOn: 1` updates the cached list and detail.

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm vitest run apps/web/src/test/field-shell.test.tsx apps/web/src/test/confirm-dialog.test.tsx apps/web/src/test/inline-outcome.test.tsx apps/web/src/test/use-agent-status.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement**

- **`FieldShell`** extracts S1's label, help and error markup from `form-field.tsx` (same classes; the error replaces the help in one slot). With `legend`, it renders `<fieldset><legend className="text-[0.8125rem] font-medium">…</legend>` instead of a `Label`. `FormField` becomes `<FieldShell …>{(a) => <Input id={a.id} aria-describedby={a.describedBy} aria-invalid={a.invalid || undefined} … />}</FieldShell>`, keeping its prefix adornment.
- **`NativeSelect`** is a `<select>` with `h-9 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`.
- **`PasswordInput`** is a relative wrapper around `Input type={shown ? "text" : "password"}` with `autoComplete="new-password" data-1p-ignore data-lpignore="true"` and a ghost icon button (`Eye` / `EyeOff`, `aria-label` "Show" / "Hide").
- **`InlineOutcome`** keeps two always-mounted live regions (`role="status"` and `role="alert"`) and renders its text into the one matching `tone`. That's the S1 `ReconnectStrip` pattern: the region exists before its text changes. It has a `CircleCheck` or `CircleAlert` icon and an "Undo" ghost link-button.
- **`ConfirmDialog`** is the shadcn `AlertDialog`: the title and description; `AlertDialogCancel` "Cancel", which gets `autoFocus`; and `AlertDialogAction`, which uses the danger variant with `confirmLabel` and shows a pending state while `onConfirm` resolves. The scrim is `bg-black/20` with no blur (check the generated overlay classes and remove any `backdrop-blur`).
- **`MiddleTruncate`** renders `<span className="flex min-w-0"><span className="truncate">{head}</span><span className="shrink-0">{tail}</span><span className="sr-only">{text}</span></span>`, where `tail` is the last path segment with its leading `/`. Add `aria-hidden` to the two visual spans.
- **API clients** use `apiFetch` with the shared schemas, one function per route, and invalidate the right query keys in the callers (e.g. `["agents"]`, `["templates"]`, `["credentials"]`, `["secrets"]`, `["projects"]`).
- **`use-agent-status`** adds `restartPending` and `restartWaitingOn` to the `patch` object.

- [ ] **Step 5: Run the web tests**

Run: `pnpm vitest run apps/web`
Expected: PASS (S1 and S3 suites included).

- [ ] **Step 6: Commit**

```bash
git add apps/web packages/shared pnpm-lock.yaml
git commit -m "feat(web): field shell, password input, confirm dialog, inline outcomes and S4 API clients

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Templates screens

**Files:**
- Delete: `apps/web/src/routes/_app/templates.tsx`
- Create:
  - `apps/web/src/routes/_app/templates.index.tsx`, `templates.new.tsx`, `templates.$name.tsx`;
  - `apps/web/src/features/templates/template-list.tsx`, `template-editor.tsx`, `code-textarea.tsx`, `issue-list.tsx`.
- Test: `apps/web/src/test/templates.test.tsx`
- Regenerate: `apps/web/src/routeTree.gen.ts` (the router plugin regenerates it on `vite build` or dev; run `pnpm --filter @open-factory/web build` once and commit the file)

**Interfaces:**
- Consumes: Task 18 clients and components.
- Produces:
  - `CodeTextarea` (`value`, `onChange`, `onBlur`, `onSave`, `id`, `describedBy`), with Tab inserting two spaces via `setRangeText`, a one-shot Escape exit, and ⌘S/Ctrl+S calling `onSave`;
  - `IssueList` (`issues`, `onJump(file, line)`).

- [ ] **Step 1: Write the failing tests** (`templates.test.tsx`; `mockApi` from Task 18, plus S3's ws and auth-client mocks)

```tsx
const summary = (p: Partial<{ name: string; errors: number; warnings: number; agentCount: number }>) => ({
  name: "lead", displayName: "Lead", description: "Leads", runtime: "local", errors: 0, warnings: 0, agentCount: 0, ...p,
});
const file = (f: string, content: string | null, hash: string | null = content === null ? null : `h-${f}`) => ({ file: f, content, hash });
const detail = (issues: unknown[] = []) => ({
  template: {
    name: "lead", path: "/h/of/templates/lead", issues, agents: [],
    config: { name: "lead", displayName: "Lead", description: "", runtime: "local", permissionMode: "auto", projects: [], skills: [], localSkills: true, plugins: [], secrets: [], canSpawn: [], maxLiveSpawns: 5, warmWindowMinutes: 70 },
    files: [file("template.yaml", "name: lead\ndisplay_name: Lead\n"), file("AGENTS.md", "# Lead\n"), file("settings.json", "{\n  \"a\": 1\n}\n"), file("mcp.json", null)],
  },
});
const yamlError = { severity: "error", file: "template.yaml", message: "Unknown field modle.", line: 3, column: 1 };

test("list: empty state names the folder", async () => {
  mockApi({ "GET /api/templates": () => json({ dir: "/h/of/templates", templates: [] }) });
  renderApp("/templates", alice);
  expect(await screen.findByText(/No templates yet\. Create one, or add a folder under/)).toBeInTheDocument();
  expect(screen.getByText("/h/of/templates/")).toBeInTheDocument();
});

test("rows: validation state in words and agent counts", async () => {
  mockApi({ "GET /api/templates": () => json({ dir: "/d", templates: [summary({ name: "lead", errors: 2 }), summary({ name: "dev", warnings: 1, agentCount: 2 })] }) });
  renderApp("/templates", alice);
  expect(await screen.findByText("2 errors")).toBeInTheDocument();
  expect(screen.getByText("1 warning")).toBeInTheDocument();
  expect(screen.getByText("No agents")).toBeInTheDocument();
  expect(screen.getByText("2 agents")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /lead/ })).toHaveAttribute("href", "/templates/lead");
});

test("editor: blur validates and replaces both issue lists; save with errors allowed; conflict offers Reload and Overwrite", async () => {
  const api = mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "POST /api/templates/lead/validate": () => json({ issues: [yamlError] }),
    "PUT /api/templates/lead/files/template.yaml": () => json({ error: { code: "changed_on_disk", message: "Changed on disk since you opened it. Reload to see the changes.", currentHash: "h-new" } }, 409),
  });
  renderApp("/templates/lead", alice);
  const editor = await screen.findByRole("textbox", { name: "template.yaml" });
  await userEvent.type(editor, "modle: x\n");
  expect(api.calls.some((c) => c.url.endsWith("/validate"))).toBe(false); // never while typing
  await userEvent.tab();
  expect(await screen.findAllByText("Unknown field modle.")).toHaveLength(2); // panel + under the editor
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("This file changed on disk since you opened it.")).toBeInTheDocument();
  api.on("PUT /api/templates/lead/files/template.yaml", (body) => {
    expect(body).toMatchObject({ baseHash: "h-new" });
    return json({ hash: "h-saved", issues: [yamlError] });
  });
  await userEvent.click(screen.getByRole("button", { name: "Overwrite" }));
  expect(await screen.findByText("Saved. Fix the errors before creating agents from this template.")).toBeInTheDocument();
});

test("issue click jumps to the tab and line", async () => {
  mockApi({ "GET /api/templates/lead": () => json(detail([{ severity: "error", file: "settings.json", message: "JSON: bad", line: 2, column: 3 }])) });
  renderApp("/templates/lead", alice);
  await userEvent.click(await screen.findByRole("button", { name: /settings\.json.*2:3.*JSON: bad/ }));
  const editor = screen.getByRole("textbox", { name: "settings.json" }) as HTMLTextAreaElement;
  expect(editor).toHaveFocus();
  expect(editor.selectionStart).toBe(editor.value.indexOf("\n") + 1);
});

test("CodeTextarea: Tab inserts two spaces; Escape then Tab leaves; Cmd+S saves", async () => {
  const onSave = vi.fn();
  function Harness() { const [v, setV] = useState(""); return <><CodeTextarea id="c" aria-label="code" value={v} onChange={setV} onSave={onSave} /><button type="button">after</button></>; }
  render(<Harness />);
  const t = screen.getByRole("textbox", { name: "code" });
  await userEvent.click(t);
  await userEvent.keyboard("a{Tab}b");
  expect(t).toHaveValue("a  b");
  await userEvent.keyboard("{Meta>}s{/Meta}");
  expect(onSave).toHaveBeenCalled();
  await userEvent.keyboard("{Escape}{Tab}");
  expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
});

test("Delete confirms and lands on the list", async () => {
  const api = mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "DELETE /api/templates/lead": () => json(null, 204),
    "GET /api/templates": () => json({ dir: "/d", templates: [] }),
  });
  renderApp("/templates/lead", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Delete…" }));
  const dialog = screen.getByRole("alertdialog", { name: "Delete template lead?" });
  expect(dialog).toHaveTextContent("Agents created from it keep their own copies, but they can't be re-synced.");
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete lead" }));
  expect(await screen.findByText("Deleted lead.")).toBeInTheDocument();
  expect(api.calls.some((c) => c.method === "DELETE")).toBe(true);
});

test("Create agent: disabled button with errors, link without", async () => {
  mockApi({ "GET /api/templates/lead": () => json(detail([yamlError])) });
  const { unmount } = renderApp("/templates/lead", alice);
  expect(await screen.findByRole("button", { name: "Create agent" })).toHaveAttribute("aria-disabled", "true");
  unmount();
  mockApi({ "GET /api/templates/lead": () => json(detail()) });
  renderApp("/templates/lead", alice);
  expect(await screen.findByRole("link", { name: "Create agent" })).toHaveAttribute("href", "/agents/new?template=lead");
});

test("new template: a taken name shows the field error", async () => {
  mockApi({ "POST /api/templates": () => json({ error: { code: "template_exists", message: "A template named lead already exists." } }, 409) });
  renderApp("/templates/new", alice);
  await userEvent.type(await screen.findByLabelText("Name"), "lead");
  await userEvent.type(screen.getByLabelText("Display name"), "Lead");
  await userEvent.click(screen.getByRole("button", { name: "Create template" }));
  expect(await screen.findByText("A template named lead already exists.")).toBeInTheDocument();
});
```

Textareas carry `aria-label={file}` (the tab label). `IssueList` buttons have the accessible name `"<file> <line>:<col> <message>"`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/web/src/test/templates.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement (UI design §3 and §2.1)**

- `templates.index.tsx`: `PageHeader` "Templates" with a "New template" action, then `TemplateList`, as rows following the S3 Agents list anatomy (UI §3.1), plus the states table.
- `templates.new.tsx`: the three-field form from UI §3.2. Fields validate on blur with `nameSchema` and on submit. On success it navigates to `/templates/$name`.
- `templates.$name.tsx`:
  - the header, summary strip, issues panel and tabs from UI §3.3;
  - per-file state `{content, baseHash, dirty, issues}`;
  - `AGENTS.md` uses the S1 `MarkdownEditor` (Write/Preview); the others use `CodeTextarea`;
  - the blur handler calls `validateTemplateFile` and **replaces** the page-level issues with the response (one source of truth);
  - Save calls `saveTemplateFile` and also replaces the issues;
  - the `409 changed_on_disk` UI, Discard, and the unsaved ink dot plus sr-only "(unsaved)";
  - the router `useBlocker` with the native prompt when anything is dirty;
  - a 404 shows the not-found state, and a 404 during save shows "This template no longer exists on disk.";
  - Delete opens `ConfirmDialog`, with the copy from UI §3.3;
  - Create agent is a link to `/agents/new?template=<name>`, or an `aria-disabled` button when the template has errors.
- `IssueList`: errors first; buttons only for the four editable files with a line, and plain text otherwise. A jump selects the tab (and Write for `AGENTS.md`), focuses the textarea, sets the selection to the line-start offset and calls `scrollIntoView`.
- `CodeTextarea`:

```tsx
function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); onSave?.(); return; }
  if (e.key === "Escape") { escArmed.current = true; return; }
  if (e.key === "Tab" && !e.shiftKey && !escArmed.current) {
    e.preventDefault();
    const t = e.currentTarget;
    t.setRangeText("  ", t.selectionStart, t.selectionEnd, "end");
    onChange(t.value);
    return;
  }
  escArmed.current = false;
}
```

  The hint "Esc then Tab to leave the editor" is shown on `:focus-visible` (track it with an `onFocus` keyboard heuristic, or show it whenever the field is focused) and tied with `aria-describedby`.

- [ ] **Step 4: Run the web tests and build**

Run: `pnpm vitest run apps/web && pnpm --filter @open-factory/web build`
Expected: PASS and a successful build (the route tree regenerates).

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): templates list, new template and raw file editors with validation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 20: Agents screens (org tree v0, New agent, Edit agent, re-sync, archive)

**Files:**
- Create:
  - `apps/web/src/routes/_app/agents.new.tsx`, `apps/web/src/routes/_app/agents.$slug.edit.tsx`;
  - `apps/web/src/features/agents/agent-tree.tsx`, `agent-form.tsx`, `project-grant-picker.tsx`, `agent-actions.tsx`, `prerequisites.tsx`.
- Modify: `apps/web/src/routes/_app/agents.index.tsx`
- Test: `apps/web/src/test/agents-tree.test.tsx`, `apps/web/src/test/agent-form.test.tsx`, `apps/web/src/test/agent-actions.test.tsx`; update `apps/web/src/test/agents-list.test.tsx` and `empty-states.test.tsx` (the S3 seed copy is gone)

**Interfaces:**
- Consumes: Task 18 clients and components.
- Produces:
  - `AgentForm({ mode: "create" | "edit", initial?, onSubmit })`, shared by both pages;
  - `usePrerequisites()` → `{ missing: "credential" | "template" | "valid-template" | null, invalidTemplate?: string }`.

- [ ] **Step 1: Write the failing tests**

`agents-tree.test.tsx`:
- rows render in server order with indentation via a CSS grid name cell (assert `style.paddingLeft` = `${depth * 20}px`, or the class);
- the sr-only "reports to Team Lead (@lead)";
- "Unsandboxed" for local and "Docker" for docker;
- the `RotateCw` "restart pending" sr text when `restartPending`;
- the Active/Archived radio pair writes `?archived=only`;
- `?justArchived=reviewer` shows "Archived @reviewer. Undo", focused, and Undo calls unarchive, then shows "Restored @reviewer.";
- the empty states in priority order (no credential → the credential line wins).

`agent-form.test.tsx`:
- the prerequisites replace the form when there's no credential;
- `?template=lead` preselects it and fills the display name, description and grants;
- the slug is prefilled from the template name when free;
- a docker template shows the warning line;
- a missing secret shows the warning with a link to `/settings?addSecret=GH_TOKEN#secrets`;
- blur validation on the slug (bad pattern → message; no message while typing);
- submit with `400 fields.slug` puts the error under Slug and focuses it;
- a manager select on Edit excludes self and descendants and uses ` ` indentation;
- the projects fieldset shows "From the template", and after a change "Custom" with "Use template default";
- no projects → "No projects yet. Add one in Settings.";
- fields are disabled while creating, and "Installing plugins…" appears after 3 s with plugins (fake timers);
- a `502` shows the form error and a collapsed "Show output".

`agent-actions.test.tsx`:
- Re-sync success with `backupDir` shows the line with the path in mono and "The agent restarts when idle." when running;
- `409 template_invalid` shows a crimson line with a link;
- `502` shows the plugin line and "Show output";
- Archive (ink, not crimson) navigates to `/agents?justArchived=<slug>`;
- `has_reports` shows the message with links;
- for an archived agent: "This agent is archived.", Restore, and `409 manager_archived`, which focuses the Manager field.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/web/src/test/agents-tree.test.tsx apps/web/src/test/agent-form.test.tsx apps/web/src/test/agent-actions.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement (UI design §4)**

Rows use `grid grid-cols-[7rem_minmax(0,1fr)_10rem_10rem_auto]` (a single column below `md`, wrapping into two lines). The name cell is `paddingLeft: Math.min(depth, isMd ? depth : 3) * 20`, with a `└` elbow drawn by `before:` border classes. The list query uses `agentsListQueryOptions(archived)`, and `useAgentStatusFrames()` stays.

The form uses `FieldShell`, `NativeSelect` and native checkboxes in a `fieldset`. Validation runs on blur with the shared Zod schemas (`slugSchema`, the display name rule), and everything is checked on submit. The submit wraps the fields in `<fieldset disabled={pending}>`. "Installing plugins…" appears after a 3 s `setTimeout` while pending, only if the template detail's `config.plugins.length`.

The Edit page loads `GET /api/agents/:slug`. `AgentActions` renders under a `rule` separator, with the copy from UI §4.3 verbatim.

Update `agents.index.tsx` and the S3 `agents-list.test.tsx` assertions to the new empty state copy ("No agents yet. …"), and remove any `pnpm seed:dev-agent` text.

- [ ] **Step 4: Run the web tests**

Run: `pnpm vitest run apps/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): org tree, new and edit agent forms, re-sync and archive with undo

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 21: Settings screen (credentials, secrets, projects)

**Files:**
- Modify: `apps/web/src/routes/_app/settings.tsx`
- Create: `apps/web/src/features/settings/credentials-section.tsx`, `secrets-section.tsx`, `projects-section.tsx`
- Test: `apps/web/src/test/settings.test.tsx`; update `empty-states.test.tsx` (Settings no longer shows "Nothing to configure yet.")

- [ ] **Step 1: Write the failing tests**

- the section order is Credentials, Secrets, Projects, with the anchors `#credentials`, `#secrets`, `#projects`;
- the add credential form: Kind radios, a `PasswordInput`, "Verify and add" → "Verifying…"; `422 credential_rejected` puts the message under the token field; success adds the row;
- the credential row shows Verify visible and Replace token and Delete… in the `⋯` menu; a used credential shows the disabled item "Delete (used by @lead)" and "Delete (archived @c still uses it)"; an unused one opens the confirmation "Delete credential work?" with the body from UI §5.1, and confirming calls DELETE; a `409` race shows a crimson row line with agent links;
- secrets: write-only rows ("Set", updated time, usage); Update shows a password field, then "Saved. @lead restarts when idle to use it. Reminders it scheduled in this session are lost."; Delete… confirms with the agent list; `?addSecret=GH_TOKEN` opens the add form with the name filled; the name is uppercased while typing with the caret kept; a reserved name (`PATH`) errors on blur;
- projects: the path is rendered by `MiddleTruncate` (with the sr-only full path); "Granted to @a · archived: @c"; Remove is disabled with a visible reason while any grant exists; when unused, Remove shows "Removed app. Undo", with the template note when `templates` is non-empty; Undo calls POST with the same name and path; Change path shows the success line with the reminders warning; a missing folder shows the field error "No folder at /x.";
- focus: after a row action, focus lands on the outcome line's Undo or on the line; an inline form focuses its first field, and Cancel or Escape returns focus to the opener.

Each bullet is one `test(...)` using `mockApi` routes for `GET /api/credentials`, `/api/secrets` and `/api/projects` and the mutation routes, asserting the exact copy quoted in the bullet (the UI design doc §5 has every string). Follow the structure of the Task 19 tests.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/web/src/test/settings.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement (UI design §5)**

Three sections with the panel-heading h2 style and the one-line descriptions. Rows follow the shared list pattern. The `⋯` menu is the existing shadcn `dropdown-menu`, and disabled items show their reason as text. The usage wording follows UI §2 ("Used by @a, @b" / "Not used"; "Granted to @a" / "Not granted"; archived appended as "· archived: @c"). Search params are read with the router (`addSecret`).

- [ ] **Step 4: Run the web tests**

Run: `pnpm vitest run apps/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): settings for credentials, secrets and projects

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 22: Session view additions

**Files:**
- Modify: `apps/web/src/features/session/agent-strip.tsx`, `session-view.tsx`, `timeline-row.tsx`, `tool-call-row.tsx`, `rows.ts`, `apps/web/src/routes/_app/agents.$slug.tsx`
- Test: `apps/web/src/test/session-view.test.tsx` (extend), `apps/web/src/features/session/rows.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

- **Strip:** `lead · tech-lead · reports to @cto · credential work · Unsandboxed: runs directly on this machine` (identifiers in mono); "No manager"; "Docker" for docker agents.
- **Restart pending:** "Restarts when idle to apply changes (waiting on 1 background task)", plus a "Why?" button that opens a popover with the copy from UI §4.4.
- **Header:** an "Edit" link to `/agents/$slug/edit`.
- **Archived:** the composer is replaced by "This agent is archived. Restore it to send messages." with a link; Compact and Interrupt are absent.
- **Pairing (`rows.ts`):** a `permission_denied` whose `toolUseId` matches a loaded `tool_call` attaches to that call's row (`denial` field), with no standalone row. An unpaired one keeps S3's row. `tool-call-row` shows "Denied" as the state label and "Denied by a permission rule" (or "Denied: <reason>") under the summary.
- **Error rows:** `fix: "secrets"` renders a link "Open Settings → Secrets" to `/settings#secrets`; `fix: "edit_agent"` renders "Edit the agent". The resume error text names `pnpm agent:reset-session <slug>` with the actual slug.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run apps/web/src/test/session-view.test.tsx apps/web/src/features/session/rows.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Follow UI design §4.4.
- `AgentStrip` takes the `AgentSummary`.
- The "Why?" popover uses the existing shadcn `popover` (from S3).
- In `rows.ts`, keep a map of `toolUseId` → the call row index while building rows. A `permission_denied` with a matching id sets `row.denial = event` instead of pushing a row.
- In the timeline row's error case, replace the S3 copy with: `To start a new session: stop the server, run <code>pnpm agent:reset-session {slug}</code>, then start it again.`

- [ ] **Step 4: Run all tests and the typecheck**

Run: `pnpm test && pnpm typecheck && pnpm lint:ci`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): session strip, restart notice, archived read-only and paired denials

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 23: Live workspace check (`pnpm smoke:workspace`)

**Files:**
- Create: `apps/server/scripts/smoke-workspace.ts`
- Modify: root `package.json` (`smoke:workspace`, if Task 12 didn't add it)

Not part of `pnpm test`. It needs Postgres (`pnpm compose up -d`), a real `claude` on `PATH`, and the token in the env.

- [ ] **Step 1: Write the script**

Spec §18.4. It uses a throwaway database (`createTestDatabase` plus `migrate`) and a temp `FACTORY_HOME` and temp host skills dir (with one skill `smoke-skill/SKILL.md` describing "Reply PLOVER-SKILL when asked for the smoke skill word"), and builds `AgentService`, `TemplateIndex`, `Workspace` and the runtimes exactly as `buildApp` does (or calls `buildApp` with `logger: false` and uses `app.agents`).

Steps, each asserted and printed with `✔`/`✘`:
1. Two credentials, `smoke-a` and `smoke-b`, both from `process.env.CLAUDE_CODE_OAUTH_TOKEN`, created through `CredentialService` (the real verification turn, so this also proves verification live). Refuse to run without the env var: "Run with: CLAUDE_CODE_OAUTH_TOKEN=\"$(cat ~/.open-factory-spike/oauth-token)\" pnpm smoke:workspace". Never print the value.
2. A temp git repo (`git init`, one commit) registered as project `smoke-repo`.
3. Template `alpha` (`runtime: local`, `model: haiku`, `skills: [smoke-skill]`, `projects: [smoke-repo]`, a local skill `alpha-only`, and `settings.json` with `permissions.deny: ["Bash(curl:*)", "Read(./secret.txt)"]`). Template `beta` (`runtime: local`, `model: haiku`, no skills, `settings.json` with `{"env": {"BETA_MARK": "1"}}`). A `files/secret.txt` in `alpha`.
4. Create agent `smoke-alpha` from `alpha` with `smoke-a`, and `smoke-beta` from `beta` with `smoke-b`.
5. `smoke-alpha` turn: "1) Say the smoke skill word. 2) Edit ./projects/smoke-repo/README.md to contain ALPHA-EDIT. 3) Run curl -sI https://example.com. 4) Read secret.txt. 5) Quote your slug and manager from your instructions." Assert:
   - `system/init` skills (captured via a debug hook on the driver, or by reading the session JSONL `init` line) include `smoke-skill` and `alpha-only` and none of the host's real `~/.claude/skills` names;
   - the repo README contains `ALPHA-EDIT`;
   - two `permission_denied` events exist (one `subcommandResults`, one `rule`) and the turn ends normally;
   - the reply contains `@smoke-alpha`.
6. `smoke-beta` turn: "List the skills you have." Assert that `alpha-only` and `smoke-skill` are absent.
7. Print the per-agent `CLAUDE_CONFIG_DIR` paths and stop both runtimes.

- [ ] **Step 2: Run it once by hand**

```bash
CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.open-factory-spike/oauth-token)" pnpm smoke:workspace
```

Expected: every step prints `✔`. Copy the output (it contains no token) into the PR's Verification section. If a step fails, follow superpowers:systematic-debugging before changing code.

- [ ] **Step 3: Commit**

```bash
git add apps/server/scripts/smoke-workspace.ts package.json
git commit -m "chore(server): live workspace smoke check

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 24: README, final checks, manual acceptance and the PR

**Files:**
- Modify: `README.md` (the run steps and env table)

- [ ] **Step 1: Update the README**

- Replace the S3 "Run the dev agent" section with "Run an agent": start Postgres and the server, sign up, add a credential in Settings (`claude setup-token`), optionally register a project, create a template (UI or `~/open-factory/templates/<name>/` with `runtime: local`), then create an agent and message it.
- Document the local-runtime caveats: the agent runs as you, host git config applies, push over HTTPS with a token secret (`GH_TOKEN`), and `SSH_AUTH_SOCK` is not passed.
- Document `pnpm agent:reset-session <slug>` (interim).
- Add a short "Templates" section: the folder layout, and one sentence on trust: "Template settings apply as written: templates are authored by the factory's operators. The factory owns `permissions.defaultMode`, keeps Claude's default `autoMode` rules (`$defaults`, so autoMode lists extend the defaults and can't replace them), appends granted project paths to `additionalDirectories`, and writes `claudeMdExcludes`."
- Remove `CLAUDE_CODE_OAUTH_TOKEN` and `FACTORY_DEV_MODEL` from the env table and add `FACTORY_HOST_SKILLS_DIR`.

- [ ] **Step 2: Full verification**

Run: `pnpm lint:ci && pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS.

Then check that no S3 stopgap survives (the server must never read its own token again):

```bash
git grep -nE 'resolveClaudeToken|claudeToken|devModel|FACTORY_DEV_MODEL|seedDevAgent|seed-dev|seed:dev-agent' -- apps packages README.md .env.example package.json
git grep -n 'process.env.CLAUDE_CODE_OAUTH_TOKEN' -- apps/server/src packages
```

Expected: no output from either (the smoke scripts under `apps/server/scripts/` may read the token from their own env; nothing under `src/` may).

- [ ] **Step 3: Manual acceptance in the browser** (`pnpm dev`)

Walk through spec ACs 1–6 and note each result for the PR:
- create two local templates and two agents with different credentials, and message both;
- edit a template on disk and see it on the next view;
- save an invalid `template.yaml` and see Create agent disabled;
- add a bad token and see "Claude rejected this token";
- trigger the deny rule and see the denial paired under its tool call;
- archive and Undo;
- re-sync and see the backup line.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin <implementation branch>
gh pr create --base spec/s3-walking-skeleton --title "feat: templates, workspace and context (S4)" --body-file /tmp/s4-pr.md
```

Base it on the S3 branch while #27 is open (stacked), or on `main` once S3 has merged. The body follows `.github/pull_request_template.md`, with the HTML comments removed:

```markdown
## What
Persistent agents created from templates on disk, each with its own working dir, Claude config dir, granted projects, named credential, secrets and generated CLAUDE.md, running in auto mode with deny-rule denials visible in the session. Templates, Agents (org tree v0, new, edit, re-sync, archive) and Settings (credentials, secrets, projects) screens.

Spec: docs/superpowers/specs/2026-11-19-s4-templates-workspace-design.md · UI design: docs/superpowers/designs/2026-11-19-s4-templates-agents-settings-ui-design.md · Decisions: #28

## Why
S4 of v0.0.1: humans create real agents instead of the S3 dev seed, with isolation from the host's Claude setup and one honest way to authenticate.

## Approach
- Snapshot template.yaml onto the agent row, rather than reading the template live, because the agent owns its copy and survives template edits and deletes.
- Rebuild settings.json, .mcp.json and CLAUDE.md at every start, rather than merging into existing files, because template rules and factory keys are re-asserted and agent-added keys can't escalate.
- Prefix every autoMode list with "$defaults", rather than passing template lists through, because a bare list replaces Claude's defaults, including Data Exfiltration.
- Exclude ancestor and workdir CLAUDE.md/AGENTS.md via claudeMdExcludes, rather than documenting it, because an ancestor CLAUDE.md both leaks in and stops AGENTS.md from loading.
- Keep .mcp.json without --strict-mcp-config, rather than passing an explicit MCP config, because strict mode drops plugin MCP servers (#25).
- Apply edits through one requestRestart seam that restarts when idle and resumes the session, rather than waiting for a next start that S4 never reaches, because revoked grants and credentials must stop applying; S5 replaces its body.
- Verify a credential with a one-shot haiku turn before saving it, rather than storing unverified tokens, because a credential that never worked has no reason to exist.
- Delete pre-S4 agents in the migration, rather than archiving them, because v0.0.1 is unreleased and template-less agents would need compatibility code forever.

## Changes
- **Shared:** template, settings and name schemas; tree order; error code/fix and apiErrorStatus.
- **Harness:** deny-rule denials derived from tool_result_meta and permission_denials; api_retry dropped; bypass flag and mounts on the runtime spec; new fixtures.
- **DB:** templates, projects, credentials, secrets, agent grants; agents columns; clean-cutover migration.
- **Server:** TemplateIndex and validator; Workspace (materialize, re-sync, prepare) with a per-agent lock; Vault; AgentService; credentials (verification turn), secrets and projects services and routes; prepareStart and requestRestart in the runtime; the agent:reset-session script; smoke:workspace.
- **Web:** Templates, Agents and Settings screens; session strip, restart notice, archived read-only, paired denials.

## Rollout notes
- The migration **deletes every pre-S4 agent** (the S3 dev seed) with its events. `FACTORY_HOME/agents/dev/` stays on disk; remove it by hand if you want the slug `dev`.
- `CLAUDE_CODE_OAUTH_TOKEN` and `FACTORY_DEV_MODEL` are no longer read. Add a credential in Settings instead.
- `pnpm seed:dev-agent` is gone; `pnpm agent:reset-session <slug>` replaces `--reset-session`.

## Verification
<pnpm smoke:workspace output and the manual AC walkthrough>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Comment on #28 with the PR link.

---

## Plan decisions (for the owner-proxy)

1. `AgentRuntime` gets its spec from an injected `prepareStart(agent)`, rather than reading the vault, templates and filesystem itself, so runtime tests stay with the fake driver.
2. The agent snapshot is stored as camelCase `TemplateConfig` (transformed from the snake_case `template.yaml`), rather than the raw YAML object.
3. Name collisions return `409 credential_exists` / `project_exists`, and secrets are upserted by `PUT`, rather than a separate create.
4. Verification failures return `422 credential_rejected` / `credential_unverifiable`, rather than `400`.
5. `AgentService.list()` (a DB query merged with live runtime fields) replaces `AgentRuntimes.list()`, rather than a per-runtime `summary()`, because the summary needs joins the runtime doesn't hold.
6. `agent_status` frames carry `restartPending` and `restartWaitingOn`, rather than only the list refetching.
7. Saving an optional template file with empty content writes an empty file, rather than deleting it; there's no "delete file" action in S4.
8. The `ANTHROPIC_API_KEY` redact paths mirror S3's three `CLAUDE_CODE_OAUTH_TOKEN` shapes.
9. `FieldError` keeps the code's status (`409` for `slug_taken`/`folder_exists`, `400` otherwise), rather than always `400`, so the codes match spec §14.
10. The workspace lock is keyed by slug, rather than agent id, so creation can take it before the row exists.
11. `Workspace.prepare` doesn't take the lock itself; every caller wraps it, rather than nesting locks, so `materialize`/`resync` holders can't deadlock.
