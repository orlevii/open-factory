# S10 Usage and Administration Implementation Plan

> **For agentic workers:** this plan is executed by one developer working **directly** (no implementer subagents), task by task, **test-first**, **one commit per task**. You read your inbox only between tool calls, so tasks are small and independent. Steps use checkbox (`- [ ]`) syntax for tracking. Use superpowers:executing-plans for the checkpoints.

**Goal:** Visibility into cost and load, plus complete administration. This covers per-turn usage attributed to tasks and credentials, plain-SQL rollups, the tree column, a per-agent usage page and Settings → Usage with a hand-rolled chart; rate-limit state per credential; invite-only sign-up with disable/enable; live factory settings (cap, default warm window, debounce); and user Docker images built from `~/open-factory/images/<name>/`, with status per template and an `open-factory images` CLI.

**Architecture:**
- `packages/shared`: `usage.ts` (totals, daily, agents, credentials and agent usage schemas; `USAGE_DAYS`), `settings.ts` (extended: factory settings, the credential `rateLimit` fields), `users.ts` (users, invites, sign-up state), `images.ts` (bare-name grammar, `isUserImageRef`, statuses, REST and frame schemas), `events.ts` (`rate_limit_status` harness event; `error.fix` + `"image"`), `ws.ts` (frames `settings_changed`, `users_changed`, `images_changed`, `image_build`), `templates.ts` (`warm_window_minutes` optional; `imageStatus` on summary and detail).
- `packages/db`: one migration covering `turns.task_id` and `turns.credential_id` with indexes, `credentials.rl_*`, `factory_settings` (seeded row), `users.disabled_at` and `users.disabled_by`, and `invites`.
- `packages/harness`: the mapper emits `rate_limit_status` for every `rate_limit_event`.
- `apps/server`:
  - `usage/` (new): `UsageService` and routes;
  - `settings/` (new): `FactorySettings` and routes;
  - `users/` (new): `InviteService`, `UserAdminService`, `signUpGate` with its `AsyncLocalStorage`, and routes;
  - `images/` (new): `resolveImage`, `walkContext`, `ImageBuilder`, status, and routes.
  - Changes elsewhere: the runtime (procCredentialId, stamp before close, `attributeTask`, rate-limit status, live warm and debounce), the supervisor (live `max`, `capChanged()`), `EventStore`, `routes/auth.ts`, `auth/options.ts`, `auth/require-user.ts`, `EventBus.closeUser`, the docker client `buildImage`, template validation, and `config.ts` (two env vars removed).
- `apps/cli`: `open-factory images` and `open-factory images build`.
- `apps/web`:
  - `features/usage/` (new): format, api, chart, and the usage page;
  - Settings: anchor nav, per-section errors, and the new Usage, Users and Factory sections;
  - the tree column, the strip segment, the task usage line;
  - Templates: the Image column and the Images section with its log panel;
  - the sign-up and sign-in states;
  - the DESIGN.md chart line.

**Tech Stack:** Node 24, TypeScript 7, Fastify 5, Drizzle + postgres.js (Postgres 18), Zod 4, better-auth 1.7.25, dockerode 5.0.1, React 19 + TanStack Router/Query, Tailwind 4 + shadcn/ui, Vitest + Testing Library, Biome. **Two new direct dependencies, both already in the lockfile through dockerode:** `tar-stream@2.2.0` and `@balena/dockerignore@1.0.2` (`apps/server` only; Task 18).

**Spec:** `docs/superpowers/specs/2026-11-20-s10-usage-admin-design.md`. The spec wins over this plan on any conflict. Decision log: https://github.com/orlevii/open-factory/issues/68.
- Follow-ups that are NOT S10 work: #69 (user deletion), #70 (agent-facing usage tool), #71 (build history), #72 (CSV export), #73 (rate-limit history).
- #62 and #1 are consumed and close with the PR. #47 and #43 got notes only.
- **Read spec §5.2 (stamping order), §9.3 (sign-up gate) and §10 (images) before the tasks that touch them.**

## Global Constraints

- **Working mode:** the dev works directly and test-first (red, green, commit), with one commit per task. Use a conventional commit message ending with a `Co-Authored-By:` line naming the model the dev actually runs as (e.g. `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`). The PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Postgres must be up (`pnpm compose up -d`) for the server and db tests.
- **Verify commands** (run from the repo root; script names are the real ones in `package.json`):
  - one file: `pnpm vitest run <path>`;
  - all: `pnpm test`;
  - `pnpm typecheck`;
  - `pnpm lint` (`pnpm lint:fix` formats);
  - `pnpm lint:ci` and `pnpm build` at the end;
  - migrations: `pnpm db:generate`.

  Every task's last step runs its file(s), then `pnpm typecheck` and `pnpm lint`.
- **Dependencies:** add only `tar-stream@2.2.0` and `@balena/dockerignore@1.0.2`, with `pnpm --filter @open-factory/server add --save-exact …`. Both are already resolved in `pnpm-lock.yaml` through dockerode, so no new release enters the tree; check that the lockfile shows no other change. **Never loosen any pnpm supply-chain setting**, and add no overrides or exceptions. No chart library and no new shadcn components.
- **Layout rules:**
  - `dockerode` is imported only by `apps/server/src/runtime/docker/client.ts` (its existing rule);
  - `tar-stream` and `@balena/dockerignore` only by `apps/server/src/images/context.ts`;
  - nothing outside `packages/harness/src/claude/` knows a stream-json field;
  - better-auth hooks live only in `apps/server/src/auth/options.ts`.
- **No DB triggers.** Every rule is app code.
- **Security** (spec §13):
  - Every new REST plugin guards itself with `app.addHook("onRequest", requireUser)`, once per plugin and never per handler. A live agent token gets `401` on each group (one test per group).
  - `PATCH /api/settings/factory` is `.strict()`, so `allowLocalRuntime` gets `400`.
  - Invite tokens: 32 random bytes, base64url, stored as `sha256`. Every invalid case gives the same `403 invite_invalid`.
  - Sign-up is serialised by one process-wide mutex. Its comment names ADR 0013 and the advisory-lock replacement.
  - `user.create.before` refuses without the gate's ALS flag, with no zero-users exception.
  - Disable deletes every `sessions` row of the user, revokes their pending invites and closes their sockets (1008).
  - Image names match the bare grammar and resolve to a direct child of `images/`. Links are packed as links and never followed; a link out of the folder fails the build. Builds take no build args, no registry auth and no push.
- **Truth and clocks:** usage numbers come from `turns` only, with no caching and no rollup tables. Every usage query takes `now` and the zone as parameters (never Postgres `now()`), so tests pin them.
- **Timing in tests:**
  - use fake timers plus awaited real events;
  - drain job queues with `rt.settled()`;
  - race tests wait on `pg_stat_activity.wait_event_type = 'Lock'`, or on the mutex being held;
  - **never raise a timeout to make a test pass**, and never sleep.
  - **Sign-up bypass tests use a real listener** (`app.listen({port: 0})` + `fetch`), never `inject`, because `inject` normalizes dot segments.
- **No automated test calls a live model or a real Docker daemon.** The live gates (Task 1, Task 32):
  - read `~/.open-factory-spike/oauth-token` into the environment at run time only, use haiku, and never print or commit it;
  - use local Docker, with `open-factory-base:dev` for the local-only base;
  - give agents only the env vars they need.
- **UI rules** (DESIGN.md and spec §12):
  - orange (`--signal`) only for live, focused or selected things: chart bars use `--chart-2`, and the selected bar uses `--signal`;
  - status is always an icon plus a label;
  - numbers use `tabular-nums`;
  - never a tooltip alone, and no tooltips inside the tree's row links;
  - type is set in rem;
  - no toasts; revoke uses Undo; Disable is the one new confirmation;
  - longer forms validate on blur and on submit.

  **Every user-facing string comes from spec §12.10 verbatim.**
- `docs/product/` is gitignored and read-only: never edit it, and never link it from the PR. Report product-doc results (V5) to the lead, who edits it.

## File Structure

```
packages/shared/src/
  usage.ts                    (new)    USAGE_DAYS, totalsSchema, dailyUsageSchema, agentsUsageSchema,
                                       credentialsUsageSchema, agentUsageSchema, taskUsageSchema
  settings.ts                 (modify) factorySettingsSchema, patchFactorySettingsSchema (.strict), rateLimitStateSchema;
                                       credentialSummarySchema gains rateLimit, pausedUntil?, pauseExact?
  users.ts                    (new)    userAdminItemSchema, inviteItemSchema, createInviteResponseSchema, signUpStateSchema
  images.ts                   (new)    USER_IMAGE_NAME, isUserImageRef, userImageTag, IMAGE_STATUSES, imageItemSchema,
                                       imagesListSchema, imageStatusSchema, imageBuildLineSchema
  events.ts                   (modify) harness rate_limit_status; error.fix + "image"
  ws.ts                       (modify) settings_changed, users_changed, images_changed, image_build
  templates.ts                (modify) warm optional; summary/detail imageStatus
  index.ts                    (modify) exports

packages/db/
  src/schema/agents.ts        (modify) turns.taskId, turns.credentialId, indexes
  src/schema/factory.ts       (modify) credentials.rl*; factorySettings; invites
  src/schema/auth.ts          (modify) users.disabledAt, disabledBy
  migrations/0010_*.sql       generated; seed row and CHECK by hand
  src/schema.s10.test.ts      (new)

packages/harness/src/claude/mapper.ts (+ test, fixture)   rate_limit_status

apps/server/src/
  agents/agent-runtime.ts     (modify) procCredentialId; turn_end/exit stamping; rate_limit_status; warmArmedAt;
                                       settingsChanged(); debounce getter
  agents/event-store.ts       (modify) openTurn(agentId, credentialId); closeTurnWith(); attributeTask();
                                       recordRateLimit(); closeDanglingTurns unchanged
  agents/runtimes.ts          (modify) settings getters; settingsChanged() fan-out; images port uses resolveImage
  agents/errors.ts            (modify) StartFix + "image"
  agents/event-bus.ts         (modify) onUserClose/closeUser
  supervisor/supervisor.ts    (modify) max getter; capChanged()
  supervisor/reconcile.ts     (modify) debounce getter
  config.ts                   (modify) drop two env vars; removedEnvWarnings()
  usage/usage-service.ts      (new)    daily, agents, credentials, agent, task
  routes/usage.ts             (new)    /api/usage/*
  routes/agents.ts            (modify) GET /api/agents/:slug/usage
  routes/tasks.ts             (modify) detail usage
  routes/credentials.ts, credentials/credential-service.ts (modify) rateLimit fields
  settings/factory-settings.ts (new)   FactorySettings
  routes/settings.ts          (new)    /api/settings/factory
  users/invites.ts            (new)    InviteService
  users/user-admin.ts         (new)    UserAdminService
  users/sign-up-gate.ts       (new)    signUpMutex, signUpContext (ALS), handleSignUp()
  routes/users.ts             (new)    /api/users*, /api/invites*, GET /api/auth/sign-up-state
  routes/auth.ts              (modify) branch on normalized pathname
  auth/options.ts             (modify) disabledAt field; user.create.before; session.create.before
  auth/require-user.ts        (modify) disabled → null
  images/resolve.ts           (new)    resolveImage
  images/context.ts           (new)    walkContext, contextHash, packContext
  images/builder.ts           (new)    ImageBuilder
  images/status.ts            (new)    imageStatus(), templateImageStatus()
  routes/images.ts            (new)    /api/images*
  runtime/docker/client.ts (+ testing/fake-docker.ts) (modify) buildImage
  templates/validate.ts, template-index.ts (modify) userImages context; bare-name error
  routes/templates.ts         (modify) imageStatus
  app.ts                      (modify) wiring, mkdir images/, settings before reconcile
  test/helpers.ts             (modify) signUp mints invites; makeTestApp factorySettings
  scripts/smoke-images.ts     (new)    live check

apps/cli/src/commands/images.ts (new), commands.ts (modify)

apps/web/src/
  features/usage/             (new)    format.ts, api.ts, usage-chart.tsx, usage-totals.tsx, usage-tables.tsx,
                                       range-filter.tsx, estimate-line.tsx
  routes/_app/agents.$slug_.usage.tsx (new)
  features/agents/agent-tree.tsx, routes/_app/agents.index.tsx (modify) cost cell, explanation line
  features/session/agent-strip.tsx (modify) usage segment
  features/tasks/task-detail.tsx (modify) usage line
  routes/_app/settings.tsx    (modify) order, anchor nav, per-section errors
  features/settings/          (modify/new) usage-section, users-section, factory-section, rate-limit-line, api.ts
  routes/sign-up.tsx, sign-in.tsx (modify)
  features/templates/         (modify/new) template-list image column, images-section, build-log, image-status
  routes/_app.tsx             (modify) frame invalidations, turnOpen edge, reconnect
DESIGN.md                     (modify) the chart series line
```

---

## Chunk A: live gates, shared, data, attribution (Tasks 1–7)

### Task 1: Gates V1, V2, V3 and V5 (scratch scripts, local Docker, live haiku)

Spec §16. Nothing is committed except a README note. **Stop and report to the lead if any result differs from the spec's assumption**; the "If wrong" column names the fallback.

**Files:**
- Modify: `packages/harness/fixtures/README.md` (add a "Verified in S10 implementation" section)
- Scratch (never committed): `G=$(mktemp -d)/s10-gate`

- [ ] **Step 1: V1 (dockerode build).** In `$G`, write `build.mjs`. It imports `dockerode` from the server's `node_modules` (`createRequire("/Users/orlevi/projects/open-factory-wt/s10/apps/server/package.json")`) and `tar-stream`, packs a two-file context in memory (`Dockerfile` + `hello.txt`), and calls `docker.buildImage(pack, {t: "of-gate:1", pull: true, labels: {"io.open-factory.context-hash": "x"}})`, consuming the stream with `docker.modem.followProgress`. Run four cases:
  - (a) `FROM ghcr.io/orlevii/open-factory/base:latest`, `RUN true`: succeeds, `docker image inspect of-gate:1 --format '{{json .Config.Labels}}'` shows the label;
  - (b) `RUN false`: record whether the failure arrives as an `{error}`/`errorDetail` object in the stream or as a rejection;
  - (c) `FROM open-factory-base:dev` with `pull: true`: record the exact error text (expected: "pull access denied" or similar);
  - (d) the same with `pull: false`: succeeds.

  Record each case's verbatim output line.
- [ ] **Step 2: V2 + V3 (better-auth).** Write `$G/auth.mjs`: better-auth 1.7.25 from the main checkout's `node_modules`, the memory adapter, `bearer()`, `emailAndPassword`, `user.additionalFields.disabledAt {type: "date", required: false, input: false}`, and `databaseHooks`:
  - `user.create.before` throws `new APIError("FORBIDDEN", {code: "invite_required"})` unless `als.getStore()?.allowed`;
  - `session.create.before` throws `APIError("FORBIDDEN", {code: "USER_DISABLED", message: "This account is disabled."})` when the user's `disabledAt` is set.

  Drive it with `auth.handler(new Request(...))`. Assert and record:
  - sign-up without the ALS store returns 403 `invite_required`; inside `als.run({allowed:true}, …)` it returns 200;
  - two concurrent requests, one in the ALS and one not, give 200 and 403;
  - a sign-up body containing `disabledAt` is rejected or ignored (not stored);
  - after setting `disabledAt` in the adapter, sign-in returns 403 with code `USER_DISABLED` in the JSON body;
  - `getSession` returns `user.disabledAt`.
- [ ] **Step 3: V5 (live `rate_limit_event` shapes).** Use S0's `drive.mjs` (`git -C /Users/orlevi/projects/open-factory-wt/s10 show origin/spec/s0-spikes:spikes/drive.mjs > $G/drive.mjs`). Run one haiku turn ("Reply with OK") with `CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.open-factory-spike/oauth-token)"`, the token read at run time and never echoed, and save the raw stream-json. `grep rate_limit_event`, then record the `rate_limit_info` keys and values (`status`, `rateLimitType`, `utilization`, `resetsAt`, and any others) with the token-free lines.
- [ ] **Step 4: Record** the results in `packages/harness/fixtures/README.md` under "Verified in S10 implementation": the Claude Code and Docker versions and the V1 a–d, V2, V3 and V5 lines. Commit `docs(harness): record S10 gate checks (V1, V2, V3, V5)`. If V5 shows an `allowed` event, also save the redacted line as `packages/harness/fixtures/rate-limit-allowed.ndjson` (Task 4 uses it). Send the V5 lines to the lead for `open-questions.md` and #43.

---

### Task 2: Shared schemas

Spec §5.3, §7, §8.3, §9, §10, §11; the frames.

**Files:**
- Create: `packages/shared/src/usage.ts`, `users.ts`, `images.ts`, and tests `usage.test.ts`, `images.test.ts`, `users.test.ts`
- Modify: `packages/shared/src/settings.ts` (+ `settings.test.ts`), `events.ts`, `ws.ts`, `templates.ts` (+ `templates.test.ts`), `index.ts`

**Interfaces — Produces:**
```ts
// usage.ts
export const USAGE_DAYS = [7, 30, 90] as const;  export type UsageDays = (typeof USAGE_DAYS)[number];
export const usageDaysSchema = z.coerce.number().pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]));
export const totalsSchema = z.object({ costUsd: z.number(), inputTokens: z.number().int(), outputTokens: z.number().int(),
  cacheWriteTokens: z.number().int(), cacheReadTokens: z.number().int(), turns: z.number().int() });
export type Totals = z.infer<typeof totalsSchema>;
export const dayUsageSchema = totalsSchema.extend({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
export const dailyUsageSchema = z.object({ timezone: z.string(), days: z.array(dayUsageSchema) });
export const agentUsageRowSchema = z.object({ slug: z.string(), displayName: z.string(),
  kind: z.enum(["persistent", "ephemeral"]), spawnerSlug: z.string().optional(), archived: z.boolean(),
  terminated: z.boolean(), own: totalsSchema, spawned: totalsSchema.optional(), total: totalsSchema });
export const agentsUsageSchema = z.object({ agents: z.array(agentUsageRowSchema) });
export const rateLimitStateSchema = z.object({ status: z.enum(["allowed", "allowed_warning", "rejected"]),
  type: z.string().nullable(), utilization: z.number().nullable(), resetsAt: z.string().nullable(), observedAt: z.string() });
export const credentialUsageRowSchema = z.object({ name: z.string(), kind: z.enum(["oauth_token", "api_key"]),
  totals: totalsSchema, agents: z.array(z.object({ slug: z.string(), costUsd: z.number() })),
  rateLimit: rateLimitStateSchema.nullable(), pausedUntil: z.string().optional(), pauseExact: z.boolean().optional() });
export const credentialsUsageSchema = z.object({ credentials: z.array(credentialUsageRowSchema), unattributed: totalsSchema });
export const agentUsageSchema = z.object({ agent: z.object({ slug: z.string(), displayName: z.string(),
  kind: z.enum(["persistent", "ephemeral"]) }), timezone: z.string(), total: totalsSchema, own: totalsSchema,
  daily: z.array(dayUsageSchema), byModel: z.array(totalsSchema.extend({ model: z.string() })),
  byTask: z.array(totalsSchema.extend({ key: z.string(), title: z.string() })),
  spawned: z.array(totalsSchema.extend({ slug: z.string(), displayName: z.string(), terminated: z.boolean() })) });
export const taskUsageSchema = z.object({ costUsd: z.number(), turns: z.number().int() }).nullable();
// settings.ts (added)
export const FACTORY_BOUNDS = { maxRunningAgents: [1, 64], defaultWarmWindowMinutes: [1, 1440],
  memberUpdateDebounceSeconds: [0, 86_400] } as const;
export const factorySettingsSchema = z.object({ maxRunningAgents: z.number().int(), defaultWarmWindowMinutes: z.number().int(),
  memberUpdateDebounceSeconds: z.number().int(), allowLocalRuntime: z.boolean(), updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable() /* @handle */ });
export const patchFactorySettingsSchema = z.strictObject({ /* each optional, int, bounds from FACTORY_BOUNDS, message
  `Enter a whole number from ${lo} to ${hi}.` */ });
// credentialSummarySchema gains: rateLimit: rateLimitStateSchema.nullable(), pausedUntil: z.string().optional(), pauseExact: z.boolean().optional()
// users.ts
export const userAdminItemSchema = z.object({ id, name, handle, email, createdAt: z.string(), disabledAt: z.string().nullable() });
export const inviteItemSchema = z.object({ id: z.string(), createdBy: z.string() /* @handle */, createdAt: z.string(), expiresAt: z.string() });
export const createInviteResponseSchema = z.object({ invite: inviteItemSchema, link: z.string() });
export const signUpStateSchema = z.object({ bootstrap: z.boolean(), invite: z.enum(["valid", "invalid", "missing"]) });
// images.ts
export const USER_IMAGE_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
export const isUserImageRef = (ref: string) => USER_IMAGE_NAME.test(ref);
export const userImageTag = (name: string) => `open-factory-user/${name}:latest`;
export const LABEL_CONTEXT_HASH = "io.open-factory.context-hash", LABEL_BUILT_AT = "io.open-factory.built-at";
export const IMAGE_STATUSES = ["no_dockerfile", "building", "failed", "not_built", "out_of_date", "built", "unknown"] as const;
export const TEMPLATE_IMAGE_STATUSES = [...IMAGE_STATUSES, "present", "pulled_on_start"] as const;
export const imageStatusSchema = z.object({ kind: z.enum(["user", "registry"]), name: z.string(), status: z.enum(TEMPLATE_IMAGE_STATUSES) });
export const imageItemSchema = z.object({ name, status: z.enum(IMAGE_STATUSES), builtAt: z.string().optional(),
  contextHash: z.string().optional(), usedBy: z.array(z.string()),
  lastBuild: z.object({ state: z.enum(["succeeded", "failed"]), finishedAt: z.string(), error: z.string().optional(), durationMs: z.number() }).optional() });
export const imagesListSchema = z.object({ imagesDir: z.string(), baseImage: z.string(), images: z.array(imageItemSchema) });
export const imageLogSchema = z.object({ state: z.enum(["building", "succeeded", "failed"]).nullable(), lines: z.array(z.string()) });
export const buildBodySchema = z.object({ pull: z.boolean().default(true) });
export const buildStreamLineSchema = z.union([z.object({ line: z.string() }),
  z.object({ state: z.enum(["succeeded", "failed"]), error: z.string().optional() })]);
// events.ts: harness union + { type: "rate_limit_status", status: z.enum([...]), rateLimitType: z.string(),
//   utilization: z.number().optional(), resetsAt: z.number().optional() }; error.fix enum + "image"
// ws.ts: { type: "settings_changed" }, { type: "users_changed" }, { type: "images_changed" },
//   { type: "image_build", name: z.string(), state: z.enum(["building","succeeded","failed"]), lines: z.array(z.string()).optional() }
// templates.ts: templateConfigSchema.warmWindowMinutes optional; templateYamlSchema warm_window_minutes optional (no default),
//   transform spreads it only when set; templateSummarySchema/templateDetailSchema gain imageStatus: imageStatusSchema.optional()
```

- [ ] **Step 1: Failing tests:**
  - `usageDaysSchema` accepts "7", "30", "90" and refuses "14";
  - `patchFactorySettingsSchema` refuses `{allowLocalRuntime: true}` and `{maxRunningAgents: 0}` (message "Enter a whole number from 1 to 64."), accepts `{memberUpdateDebounceSeconds: 0}`, and refuses non-integers;
  - `isUserImageRef`: true for "playwright", "my_img.v2"; false for "ubuntu:22.04", "docker.io/library/ubuntu", "a/b", "..", "Upper";
  - `templateYamlSchema` without `warm_window_minutes` parses to a config without `warmWindowMinutes`, and with `30` keeps it;
  - the frames parse with `serverMessageSchema`;
  - `rate_limit_status` parses with `harnessEventSchema`;
  - an `error` event with `fix: "image"` parses.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared` → FAIL.
- [ ] **Step 3: Implement** the schemas above, and export them from `index.ts`. The web timeline (`features/session/rows.ts` / `timeline-row.tsx`) must not render `rate_limit_status`: add it to whatever "ignored types" list `rows.ts` keeps. If the union is matched exhaustively, `pnpm typecheck` points at the place.
- [ ] **Step 4: Run** → PASS. Then run `pnpm vitest run apps/web/src/features/session` (it still passes), `pnpm typecheck` (fix the compile errors in test builders that set `warmWindowMinutes: 70`; they stay valid because the field is optional) and `pnpm lint`.
- [ ] **Step 5: Commit** `feat(shared): usage, factory settings, users, images schemas and S10 frames`.

---

### Task 3: Database migration

Spec §5.1, §8.1, §9.1.

**Files:**
- Modify: `packages/db/src/schema/agents.ts` (`turns`: `taskId` → `tasks.id` on delete set null, `credentialId` → `credentials.id` on delete set null; indexes `turns_task_idx` partial, `turns_credential_started_idx`, `turns_started_idx`), `packages/db/src/schema/factory.ts` (`credentials`: `rlStatus`, `rlType`, `rlUtilization real`, `rlResetsAt`, `rlObservedAt`; new `factorySettings`, `invites`), `packages/db/src/schema/auth.ts` (`users.disabledAt timestamp`, `disabledBy text → users.id`), `packages/db/src/schema/index.ts`
- Generated + hand-edited: `packages/db/migrations/0010_*.sql`
- Create: `packages/db/src/schema.s10.test.ts`

- [ ] **Step 1: Failing test** `schema.s10.test.ts` (modelled on `schema.schedules.test.ts`: a migrated throwaway DB, raw SQL):
  - `factory_settings` has exactly one row `(1, 8, 70, 30)`; inserting `id = 2` → `23514`;
  - a `turns` row with `task_id`/`credential_id`; deleting the task's referenced credential sets `credential_id` NULL;
  - `credentials.rl_*` nullable;
  - `invites.token_hash` unique, `used_by` unique;
  - `users.disabled_at` nullable.
- [ ] **Step 2: Run** `pnpm vitest run packages/db/src/schema.s10.test.ts` → FAIL.
- [ ] **Step 3: Implement** the Drizzle columns (`factorySettings`: `id smallint pk`, `maxRunningAgents int not null default 8`, `defaultWarmWindowMinutes int not null default 70`, `memberUpdateDebounceSeconds int not null default 30`, `updatedAt timestamptz`, `updatedBy text → users.id`; `invites`: `id text pk`, `tokenHash text not null unique`, `createdBy text not null → users.id`, `createdAt timestamptz not null default now()`, `expiresAt timestamptz not null`, `usedAt`, `usedBy text unique → users.id`, `revokedAt`). Run `pnpm db:generate`, then hand-add to the SQL: `ALTER TABLE factory_settings ADD CONSTRAINT factory_settings_singleton CHECK (id = 1);` and `INSERT INTO factory_settings (id) VALUES (1);`. Note: `tasks` is defined in `schema/tasks.ts`, and `agents.ts` already imports it.
- [ ] **Step 4: Run** the file, `pnpm vitest run packages/db`, and `pnpm vitest run apps/server/src/agents/event-store.test.ts` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(db): turn attribution, rate-limit state, factory settings, invites, disabled users`.

---

### Task 4: `rate_limit_status` from the mapper, stored per credential

Spec §5.3, R3.

**Files:**
- Modify: `packages/harness/src/claude/mapper.ts` (the `case "rate_limit_event"` at ~430), `mapper.test.ts`; `apps/server/src/agents/event-store.ts` (`recordRateLimit`), `agent-runtime.ts` (new `case "rate_limit_status"` next to `case "rate_limited"` at ~2346)
- Test: `apps/server/src/agents/agent-runtime.rate-limit-status.test.ts` (new)

**Interfaces — Produces:** `EventStore.recordRateLimit(credentialId: string, s: {status; rateLimitType; utilization?: number; resetsAt?: number /* epoch s */}, at: Date): Promise<void>` performs `UPDATE credentials SET rl_status, rl_type, rl_utilization, rl_resets_at = to_timestamp(resetsAt), rl_observed_at = at WHERE id = $1 AND (rl_observed_at IS NULL OR rl_observed_at <= at)`.

- [ ] **Step 1: Failing tests:**
  - mapper: `allowed` → `[rate_limit_status]`; `allowed_warning` with utilization 0.82 → `[rate_limit_status]`; `rejected` → `[rate_limit_status, rate_limited]` in that order (the S5 `rejected` fixture test keeps passing); with Task 1's fixture when it exists;
  - runtime (fake driver, `RuntimeHarness` from `agents/testing/runtime-harness.ts`): a `rate_limit_status{allowed_warning}` updates the agent's credential's `rl_*`, appends **no** session event and pauses nothing (`slots.pauseOf` undefined); an older `at` doesn't overwrite a newer one; `rejected` still pauses (the existing S5 tests).
- [ ] **Step 2: Run** `pnpm vitest run packages/harness/src/claude/mapper.test.ts apps/server/src/agents/agent-runtime.rate-limit-status.test.ts` → FAIL.
- [ ] **Step 3: Implement.** In the mapper, a single `switch` arm with the comment "Every rate_limit_event reports status; only `rejected` pauses (S5)". In the runtime: `await this.d.store.recordRateLimit(liveCredentialId(this.agent), e, new Date())`, with errors logged and never thrown (a status write must not fail the turn).
- [ ] **Step 4: Run** the files plus `pnpm vitest run apps/server/src/agents` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat: record every rate-limit status per credential; only rejected pauses`.

---

### Task 5: The credential a turn ran on

Spec §5.2 (R2).

**Files:**
- Modify: `apps/server/src/agents/agent-runtime.ts` (a field `private procCredentialId: string | undefined`, set where the process is launched in `startNow` (~1891, next to `this.proc = proc` ~1990) from `liveCredentialId(this.agent)` as read at launch, cleared on exit (~2458); `case "turn_started"` passes it), `event-store.ts` (`openTurn(agentId, credentialId: string | null, tx?)`)
- Test: `apps/server/src/agents/agent-runtime.turn-credential.test.ts` (new)

- [ ] **Step 1: Failing tests:**
  - a persistent agent's turn row has `credential_id` = its credential;
  - a spawned agent's (seed a spawned row with the spawner's credential, as `agent-service.spawn.test.ts` does) = the spawner's;
  - the agent is moved to another credential (`reload()` with a changed `credentialId`) while the process runs; the next turn still records the **launch** credential;
  - after the credential row is deleted (the agent is terminated first), the turn's `credential_id` is NULL.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Update every other `openTurn` caller (tests and harness) with `pnpm typecheck` as the guide.
- [ ] **Step 4: Run** the file plus `pnpm vitest run apps/server/src/agents` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): record the credential each turn ran on`.

---

### Task 6: Task attribution: stamp before close, `attributeTask`, exit path, and V4

Spec §5.2 (F1 and round 2), AC2, §11 V4. **Read the turn_end (~2286–2320) and exit (~2435–2500) code in `agent-runtime.ts` first.**

**Files:**
- Modify: `apps/server/src/agents/event-store.ts`, `agent-runtime.ts`
- Test: `apps/server/src/agents/agent-runtime.task-attribution.test.ts` (new)

**Interfaces — Produces:**
```ts
// event-store.ts
/** Spec §5.2: the turn's task when every delivered non-system message carries that one task (a lower bound). */
async attributeTask(turnId: string, tx: Exec): Promise<void>; // UPDATE turns SET task_id = (SELECT min(task_id) FROM messages WHERE delivered_turn_id = $turn AND kind <> 'system' HAVING count(*) > 0 AND count(*) = count(task_id) AND count(DISTINCT task_id) = 1) WHERE id = $turn
/** One transaction: stamp `stampIds` with the turn (when given), close it, and attribute it when `attribute` is true. */
async closeTurnWith(turnId: string, d: TurnClose, stampIds: string[], attribute: boolean): Promise<void>;
```

- [ ] **Step 1: Failing tests** (fake driver; task messages created through `TaskService` or by the `rows.ts` helpers with `task_id`):
  - a single task message starts a turn → `turns.task_id` = that task;
  - one batch with messages of two tasks → NULL;
  - a non-task human message plus a task message → NULL (any non-system message without the task disqualifies);
  - a task message plus a `system` notice → the task;
  - a mid-turn absorbed task message of the same task → the task (and `messages.delivered_turn_id` set for both batches);
  - **a cron turn ends while a batch is awaiting** (fake driver emits `turn_started`, then `turn_end{originKind:"cron"}` with `awaiting` non-empty) → `awaiting` stays unstamped and the cron turn's `task_id` is NULL. The batch's own later turn gets the task, and S6's update-only computation is unchanged (assert `dueAtTurnEnd` via the existing held tests still passing);
  - process exit with an open turn and an awaiting task batch → NULL (S6's exit path unchanged; awaiting not stamped);
  - `closeDanglingTurns` at boot → `task_id` NULL;
  - **V4:** on the exit path, the last `agent_status` frame with `turnOpen: false` arrives after the turn row has `ended_at` (subscribe to the bus with `subscribeAll`, then read the row in the listener).
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/agents/agent-runtime.task-attribution.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
  - **turn_end:** when `!e.originKind`, call `closeTurnWith(turnId, close, this.awaiting.flat(), true)`, then clear `awaiting`/`awaitingKinds` as S6 does today. With an `originKind`, call `closeTurnWith(turnId, close, [], false)`. Keep `ran` and `updateOnly` computed **before**, exactly as today.
  - **exit:** unchanged S6 behaviour (no stamping, no attribution).
  - Leave `closeDanglingTurns` unchanged.
  - If V4 fails, move the exit path's `publishStatus()` after the close.
- [ ] **Step 4: Run** the file plus `pnpm vitest run apps/server/src/agents apps/server/src/messaging` (S6 held, forward and delivery tests unchanged) → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): attribute turns to tasks at close (#62)`.

---

### Task 7: Checkpoint A: review findings applied

- [ ] Request a code review of Tasks 2–6 (superpowers:requesting-code-review against the spec §5 and §16). Fix the findings test-first, one commit each (`fix(…): …`). Re-run `pnpm test`.

---

## Chunk B: usage queries, factory settings (Tasks 8–13)

### Task 8: `UsageService`

Spec §6, §7, AC1. Every query is one SQL statement with `now` and `tz` as parameters.

**Files:**
- Create: `apps/server/src/usage/usage-service.ts`, `usage-service.test.ts`
- Modify: `apps/server/src/agents/testing/rows.ts` (add `insertTurn(db, {agentId, startedAt, endedAt?, costUsd?, tokens…, model?, taskId?, credentialId?})`)

**Interfaces — Produces:**
```ts
export class UsageService {
  constructor(d: { db: Db; now: () => Date; timezone: () => string /* FACTORY_TIMEZONE */ });
  daily(days: UsageDays, scope?: { agentIds: string[] }): Promise<DailyUsage>;
  agents(window: { kind: "rolling"; days: 7 } | { kind: "calendar"; days: UsageDays }): Promise<AgentsUsage>;
  credentials(days: UsageDays): Promise<CredentialsUsage>;
  agent(slug: string, days: UsageDays): Promise<AgentUsage | undefined>;
  task(taskId: string): Promise<{ costUsd: number; turns: number } | null>;
}
```
- **Calendar window:** `started_at >= (($today_local - (days-1)) :: timestamp AT TIME ZONE $tz)`, where `$today_local = ($now AT TIME ZONE $tz)::date`. The rolling 7-day window is `started_at >= $now - interval '7 days'`. Only rows with `ended_at IS NOT NULL` count, and `coalesce(cost_usd, 0)` and `coalesce(tokens, 0)` are applied everywhere.
- **Spawner scope for a persistent agent X:** `agent_id = X OR agent_id IN (SELECT id FROM agents WHERE kind = 'ephemeral' AND reports_to = X)`.
- **Zero-fill** uses `generate_series` over local dates.

- [ ] **Step 1: Failing test** `usage-service.test.ts` (a real DB). A seed builder inserts turns across:
  - a persistent `lead` with two spawned children (one terminated) and a persistent report `dev` (`reports_to = lead`, kind persistent);
  - two credentials plus NULL;
  - two tasks;
  - days spanning the `America/New_York` fall-back day (2026-11-01);
  - an open turn (no `ended_at`) and a turn with `cost_usd` NULL.

  A `reference(turns, predicate)` helper in the test sums the seeded JS objects. Assert:
  - every route method equals the reference;
  - `daily(30)` has 30 entries, zero-filled, and its sum equals `agent(…, 30).total` (F4);
  - `lead`'s `total` = own + spawned and excludes `dev`;
  - the boundary turn exactly at local midnight of the first day is included, and one millisecond earlier is excluded;
  - the rolling 7-day window for the tree;
  - `credentials(30).unattributed` sums the NULL turns, and its top agents are ordered by cost (at most 5);
  - `byTask` holds the top 20;
  - `task(id)` returns null without attributed turns;
  - the open turn is excluded everywhere;
  - the NULL-cost turn counts as a turn with $0.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/usage/usage-service.test.ts` → FAIL.
- [ ] **Step 3: Implement** with Drizzle `sql` template queries (as `task-store.ts` does for raw SQL). Map numerics with `Number()`.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): usage rollups as plain queries`.

---

### Task 9: Usage REST, task usage, credential rate-limit fields

Spec §7, §13, AC1, AC8.

**Files:**
- Create: `apps/server/src/routes/usage.ts`, `routes/usage.test.ts`
- Modify: `apps/server/src/routes/agents.ts` (`GET /api/agents/:slug/usage`), `routes/tasks.ts` (the detail's `usage`), `packages/shared/src/tasks.ts` (`taskDetailSchema` + `usage: taskUsageSchema`), `credentials/credential-service.ts` (`summarize` adds `rateLimit`, `pausedUntil`, `pauseExact` from the row's `rl_*` and `rateLimitedUntil`/`rateLimitExact`, with the pause only when in the future), `app.ts` (decorate `usage`, register `usageRoutes`)

- [ ] **Step 1: Failing tests:**
  - `GET /api/usage/daily?days=30`, `/agents?days=7`, `/credentials?days=30` and `/api/agents/lead/usage?days=30` return the Task 8 numbers for a seeded app;
  - `days=14` → `400 invalid_days`;
  - an unknown slug → `404`;
  - `GET /api/tasks/T-1` has `usage`;
  - `GET /api/credentials` has `rateLimit` (null with no data);
  - **AC8:** a live agent token (`app.agentTokens` as `routes/schedules.test.ts` does) → `401` on `/api/usage/daily` and `/api/agents/lead/usage`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `usageRoutes` is a `FastifyPluginAsyncZod` with `app.addHook("onRequest", requireUser)` at the top, like `routes/credentials.ts:16`. Responses are validated with the shared schemas.
- [ ] **Step 4: Run** the file plus `pnpm vitest run apps/server/src/routes` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): usage REST, task usage and credential rate-limit state`.

---

### Task 10: `FactorySettings`, its REST, and removing the two env vars

Spec §8.1, §8.3, Q6, R7.

**Files:**
- Create: `apps/server/src/settings/factory-settings.ts`, `factory-settings.test.ts`, `apps/server/src/routes/settings.ts`, `routes/settings.test.ts`
- Modify:
  - `apps/server/src/config.ts`: remove `FACTORY_MAX_RUNNING_AGENTS`, `FACTORY_MEMBER_UPDATE_DEBOUNCE_SECONDS`, `maxRunningAgents` and `memberUpdateDebounceMs` from `Config`; keep `DEFAULT_MAX_RUNNING_AGENTS` for tests; add `export function removedEnvWarnings(env): string[]`;
  - `config.test.ts`;
  - `app.ts`: load settings right after the migrations check and before `new AgentRuntimes`; pass getters; log the warnings at boot;
  - `test/helpers.ts`: `TestAppOptions.factorySettings?: Partial<{maxRunningAgents; defaultWarmWindowMinutes; memberUpdateDebounceSeconds}>`, written with an `UPDATE factory_settings` before `buildApp`;
  - every test and smoke script that passed the two env vars: `app.test.ts`, `scheduling/lifecycle.test.ts`, `spawning/scenario.test.ts`, `spawning/reaper.test.ts` → `factorySettings`; `scripts/smoke-{messaging,spawning,scheduling,tasks}.ts` → `UPDATE factory_settings` through the API (`PATCH /api/settings/factory` after sign-up);
  - `.env.example`, `README.md` (remove both vars; add a line pointing at Settings → Factory), `packages/harness/fixtures/README.md` mentions.

**Interfaces — Produces:**
```ts
export type FactorySettingsValues = { maxRunningAgents: number; defaultWarmWindowMinutes: number; memberUpdateDebounceSeconds: number };
export class FactorySettings {
  static load(db: Db): Promise<FactorySettings>;
  get(): FactorySettingsValues & { updatedAt: Date | null; updatedBy: string | null };
  readonly maxRunningAgents: () => number;
  readonly defaultWarmWindowMinutes: () => number;
  readonly memberUpdateDebounceMs: () => number;      // seconds × 1000
  update(patch: Partial<FactorySettingsValues>, userId: string): Promise<void>; // writes the row, then swaps the copy, then calls listeners
  onChange(fn: (prev: FactorySettingsValues, next: FactorySettingsValues) => void): void;
}
```

- [ ] **Step 1: Failing tests:**
  - `loadConfig` no longer has the two fields;
  - `removedEnvWarnings({FACTORY_MAX_RUNNING_AGENTS: "4"})` → `["FACTORY_MAX_RUNNING_AGENTS is no longer read; set it in Settings → Factory."]`;
  - `FactorySettings.load` reads the seeded row; `update` persists, and the getters return the new values;
  - REST: `GET /api/settings/factory` → defaults + `allowLocalRuntime: true` (the test app sets it);
  - `PATCH {maxRunningAgents: 2}` → 200 and `settings_changed` published;
  - `PATCH {allowLocalRuntime: false}` → `400 invalid_settings`;
  - `{maxRunningAgents: 65}` → 400 with the field message;
  - an agent token → `401`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** For now, wire `runtimes` with `maxRunningAgents: settings.maxRunningAgents()` and `memberUpdateDebounceMs: settings.memberUpdateDebounceMs()` read at construction. Task 11 and Task 12 make them live. `reconcile` gets `settings.memberUpdateDebounceMs()`.
- [ ] **Step 4: Run** the files, then `pnpm test` (the whole suite, since the config removal touches many files) → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): factory settings in the database; drop the cap and debounce env vars`.

---

### Task 11: The concurrency cap, live

Spec §8.2 (supervisor), AC3, Q9.

**Files:**
- Modify: `apps/server/src/supervisor/supervisor.ts` (`SupervisorDeps.max: () => number`; every `this.d.max` → `this.d.max()`, at ~86, 410 and 454; new public `capChanged(): void { this.pump(); this.evict(); this.publish(); }`), `agents/runtimes.ts` (`maxRunningAgents?: () => number`; ~144), `app.ts` (`settings.onChange` → `runtimes.supervisor.capChanged()` when the cap changed), `agents/testing/runtime-harness.ts`
- Test: `apps/server/src/supervisor/cap-live.test.ts` (new)

- [ ] **Step 1: Failing tests** (fake driver, two agents, `factorySettings: {maxRunningAgents: 1}`):
  - A busy (turn open) and B with a queued wake: `PATCH {maxRunningAgents: 2}` grants B without a restart (B's `process_started`), and a `supervisor` frame with `max: 2` is published;
  - both busy, `PATCH 1`: neither is stopped;
  - with a third agent C queued and A idle and hibernatable: A hibernates with `freed_slot` (S5's `evict()`), then C is granted;
  - with B busy and no one idle: C waits.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file plus `pnpm vitest run apps/server/src/supervisor apps/server/src/agents/cap.test.ts` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): the concurrency cap changes live`.

---

### Task 12: The default warm window and the debounce, live

Spec §8.2, AC4, Q8.

**Files:**
- Modify:
  - `apps/server/src/agents/agent-runtime.ts`:
    - `AgentRuntimeDeps.memberUpdateDebounceMs?: () => number`, used in `heldDueAt` (~1249) and `heldDue` (~1263);
    - `defaultWarmWindowMinutes?: () => number`;
    - `private warmArmedAt: number | undefined`, set when `updateWarmTimer` (~2918) arms;
    - minutes = `this.agent.config.warmWindowMinutes ?? this.d.defaultWarmWindowMinutes?.() ?? DEFAULT_WARM_WINDOW_MINUTES`;
    - a public `settingsChanged(): Promise<void>`, which runs in `this.run(...)`: if `!this.agent.config.warmWindowMinutes && this.warmTimer`, clear the timer and re-arm it for `warmArmedAt + new window - now` (firing at once when ≤ 0, through the same callback); then `this.updateHeldTimer()`;
  - `agents/runtimes.ts`: pass getters; add a public `settingsChanged()` that awaits each loaded runtime's `settingsChanged()` and logs failures;
  - `supervisor/reconcile.ts`: the `memberUpdateDebounceMs` dep becomes a getter;
  - `agents/testing/runtime-harness.ts`;
  - `app.ts`: `settings.onChange` → `runtimes.settingsChanged()` when the window or the debounce changed;
  - `templates/validate.ts` (no default injected; nothing else), and the template editor hint in Task 31.
- Test: `apps/server/src/agents/agent-runtime.settings-live.test.ts` (new)

- [ ] **Step 1: Failing tests** (fake timers):
  - an agent whose config has no `warmWindowMinutes` hibernates after the factory default (set it to 5 → after 5 minutes);
  - with a timer armed at t0 for 70 minutes, changing the default to 10 at t0 + 3 min hibernates it at t0 + 10 min; changing it to 2 at t0 + 3 min hibernates it at once;
  - an agent whose snapshot holds 70 is unaffected;
  - a held member update created at t0 with debounce 30 s: changing the debounce to 5 s at t0 + 1 s delivers at t0 + 5 s; changing it to 0 delivers at once;
  - the existing S5 warm and S6 held tests still pass.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file plus `pnpm vitest run apps/server/src/agents apps/server/src/supervisor` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): default warm window and member-update debounce change live`.

---

### Task 13: Checkpoint B: review findings applied

- [ ] Request a code review of Tasks 8–12 (spec §6–§8). Fix the findings test-first, one commit each. Run `pnpm test`.

---

## Chunk C: users, sign-up, images, CLI (Tasks 14–22)

### Task 14: Invites

Spec §9.1–§9.2.

**Files:**
- Create: `apps/server/src/users/invites.ts`, `invites.test.ts`, `apps/server/src/routes/users.ts` (invite routes in this task; the user routes come in Task 16), `routes/users.test.ts`
- Modify: `app.ts` (decorate `invites`, register `usersRoutes`)

**Interfaces — Produces:**
```ts
export const INVITE_TTL_MS = 7 * 86_400_000;
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export class InviteService {
  constructor(d: { db: Db; now: () => Date; publicUrl: string; bus: EventBus });
  create(byUserId: string): Promise<{ invite: InviteItem; link: string }>;   // randomBytes(32).toString("base64url")
  listPending(): Promise<InviteItem[]>;
  revoke(id: string): Promise<void>; restore(id: string): Promise<void>;     // restore: 409 invite_expired | invite_used
  check(token: string, tx?: Exec): Promise<{ id: string } | null>;           // by hash; used/revoked/expired → null
  markUsed(id: string, userId: string): Promise<boolean>;                    // guarded UPDATE … WHERE used_at IS NULL RETURNING
}
```

- [ ] **Step 1: Failing tests:**
  - `create` stores only the hash (the DB row ≠ the token), and the link is `${publicUrl}/sign-up?invite=<token>`;
  - `check` returns null for unknown, used, revoked and expired invites (fake clock);
  - revoke then restore works; restore after expiry → `409`;
  - `markUsed` twice → the second returns false;
  - REST: `POST /api/invites` → 201 `{invite, link}`; `GET` lists pending without tokens; revoke and restore; `users_changed` is published;
  - an agent token gets `401`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): invite links`.

---

### Task 15: The sign-up gate, the ALS backstop, and the test helpers

Spec §9.3 (F2), AC5. **Bypass tests use a real listener.**

**Files:**
- Create: `apps/server/src/users/sign-up-gate.ts`, `apps/server/src/users/sign-up-gate.test.ts`
- Modify:
  - `apps/server/src/routes/auth.ts`: inside the existing handler, after `const url = new URL(...)`: if `request.method === "POST" && url.pathname === "/api/auth/sign-up/email"`, return `handleSignUp(...)`;
  - `apps/server/src/auth/options.ts`: `AuthOptionParams.mayCreateUser?: () => boolean`; `databaseHooks.user.create.before` throws `new APIError("FORBIDDEN", {code: "invite_required", message: "Sign-up needs an invite link from a member of this factory."})` unless `p.mayCreateUser?.()`;
  - `auth/auth.ts` (pass `() => signUpContext.getStore()?.allowed === true`);
  - `routes/users.ts` (`GET /api/auth/sign-up-state?invite=`, public);
  - `test/helpers.ts`: `signUp` mints an invite whenever `users` has rows (insert `invites` with `hashToken(t)` and `created_by` = any user) and sends `invite: t`; call sites stay unchanged;
  - `auth/auth.test.ts` and `routes/auth.names.test.ts` (their direct sign-ups of a second user pass an invite);
  - `scripts/smoke-*.ts` (a second user: create the invite through `POST /api/invites` with the first user's cookie).

**Interfaces — Produces:**
```ts
export const signUpContext = new AsyncLocalStorage<{ allowed: boolean }>();
/** Correct only because the factory is one server process (ADR 0013); a multi-instance deployment must replace this with
 *  a Postgres advisory lock. */
export const signUpMutex = new KeyedMutex(); // apps/server/src/workspace's KeyedMutex, key "sign-up" (or a tiny local mutex)
export async function handleSignUp(d: { db: Db; invites: InviteService; auth: Auth }, req: Request, body: unknown): Promise<Response>;
```
`handleSignUp` does the following under the mutex:
1. Count users. With rows: take `invite` from the body; absent → `403 {error:{code:"invite_required"}}`; `check` null → `403 {error:{code:"invite_invalid", message: "This invite link isn't valid anymore. Ask a member of this factory for a new one."}}`.
2. Strip `invite` and rebuild the `Request`.
3. Run `signUpContext.run({allowed:true}, () => auth.handler(req2))`.
4. On a 2xx, read the new user's id from the response JSON (`user.id`) and call `markUsed`.

- [ ] **Step 1: Failing tests** (`app.listen({port: 0, host: "127.0.0.1"})`, global `fetch`):
  - zero users: sign-up without an invite → 200;
  - one user: without an invite → `403 invite_required`; with a valid one → 200; reusing it → `403 invite_invalid`; expired, revoked and unknown → the same `403 invite_invalid` body;
  - the bypass variants `/api/auth/./sign-up/email`, `/api/auth/x/../sign-up/email`, `/api/auth/%2e/sign-up/email` and `/api/auth/sign-up/./email`, without an invite and with one user → never 200, and the user count is unchanged;
  - a direct `app.auth.api.signUpEmail(...)` outside the gate → refused (`invite_required`), even with zero users;
  - two concurrent sign-ups on one invite → exactly one 200;
  - two concurrent first sign-ups with zero users → exactly one 200; the other gets `403 invite_required`;
  - `GET /api/auth/sign-up-state` → `{bootstrap: true, invite: "missing"}` with zero users; with one user and a valid token → `{bootstrap: false, invite: "valid"}`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** If Task 1's V3 showed the ALS store not reaching the hook, use the spec's V3 fallback (a header the catch-all strips from client input and sets itself) and note it in the PR.
- [ ] **Step 4: Run** the file, then the whole `pnpm test` (the helper change touches about 40 files) → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): invite-only sign-up (closes #1 with disable)`.

---

### Task 16: Disable and enable users

Spec §9.4, AC6, Q10.

**Files:**
- Create: `apps/server/src/users/user-admin.ts`, `user-admin.test.ts`
- Modify:
  - `routes/users.ts`: `GET /api/users`, `POST /api/users/:id/disable`, `/enable`;
  - `auth/options.ts`: `user.additionalFields.disabledAt {type: "date", required: false, input: false}`; `databaseHooks.session.create.before` loads the user's `disabled_at` through `p.isDisabled?(userId)` and throws `APIError("FORBIDDEN", {code: "USER_DISABLED", message: "This account is disabled."})`;
  - `auth/auth.ts`: `isDisabled` with one indexed query;
  - `auth/require-user.ts`: `getUser` returns `null` when `session.user.disabledAt` is set;
  - `agents/event-bus.ts`: `onUserClose(userId, fn): () => void` and `closeUser(userId)`;
  - `ws/route.ts`: register `socket.close(1008, "user disabled")` with `onUserClose`, and unregister on close.

**Interfaces — Produces:** `UserAdminService.disable(actorId, targetId): Promise<{ revokedInvites: number }>`, which throws `ApiError` 409 `cannot_disable_self` / `last_enabled_user`. In one transaction it runs `SELECT id FROM users WHERE disabled_at IS NULL FOR UPDATE`, sets `disabled_at`/`disabled_by`, runs `DELETE FROM sessions WHERE user_id`, and sets `revoked_at = now` on the user's pending invites. After the commit: `bus.closeUser`, then publish `users_changed`. `enable(targetId)` clears `disabled_at`.

- [ ] **Step 1: Failing tests:**
  - disable deletes the user's cookie session **and** a bearer token (sign in with `Authorization: Bearer` as the CLI does) → both get `401` on `/api/me`;
  - an open WS of that user closes with 1008 and gets no further `agent_status`;
  - a WS upgrade with the old token → 401;
  - sign-in of the disabled user → 403 `USER_DISABLED`;
  - their pending invites are revoked, and the response carries the count;
  - self → `409 cannot_disable_self`; the last enabled user → `409 last_enabled_user`;
  - two admins disabling each other concurrently → one succeeds and one gets `409 last_enabled_user`, with no deadlock (wait on `pg_stat_activity`);
  - enable restores sign-in;
  - `GET /api/users` lists `disabledAt`;
  - an agent token gets `401`;
  - a sign-up body or `update-user` with `disabledAt` is ignored (from V2).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file plus `pnpm vitest run apps/server/src/auth apps/server/src/ws apps/server/src/routes` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): disable and enable users`.

---

### Task 17: User image names: validation, resolution and start without pull

Spec §10.1, F6, AC7 (the start half).

**Files:**
- Create: `apps/server/src/images/resolve.ts`, `resolve.test.ts`
- Modify:
  - `apps/server/src/agents/errors.ts` (`StartFix` + `"image"`);
  - `templates/validate.ts`: `ValidationContext.userImages: Set<string>` (names whose `images/<name>/Dockerfile` exists); a bare `image:` not in the set → error `No user image ‘<name>’ (images/<name>/Dockerfile). For a Docker Hub image, write docker.io/library/<name>.` on `template.yaml` with the line of `image`;
  - `templates/template-index.ts` (fills `userImages` from a listing of `<factoryHome>/images`);
  - `agents/runtimes.ts`: the images port. `refOf` returns `resolveImage(agent.config.image, docker.defaultImage).tag`. `ensure`: for `kind: "user"`, `imageId(tag)` undefined → throw `new AgentStartError("Image \`<name>\` isn't built. Build it in Templates → Images, or run \`open-factory images build <name>\`.", "image")`, never `pull`; registry refs behave as today. `ContainerManager.ensureImage` stays for registry refs;
  - `agents/agent-runtime.ts`: `imagePullFailed(message, fix?)` appends `error{fix}` (the supervisor's `pull()` passes `err instanceof AgentStartError ? err.fix : undefined`); `supervisor.ts` `done(failure)` carries the fix;
  - `agents/start.ts` (~330): `image: resolveImage(config.image, d.config.defaultImage).tag`;
  - `app.ts`: `mkdir(path.join(config.factoryHome, "images"), {recursive: true})` next to `templates` (~160).

**Interfaces — Produces:**
```ts
export type ResolvedImage = { kind: "user"; name: string; tag: string } | { kind: "registry"; ref: string; tag: string };
/** Spec §10.1: only a template's image: is resolved; the factory default never is. */
export function resolveImage(templateImage: string | undefined, defaultImage: string): ResolvedImage;
```

- [ ] **Step 1: Failing tests:**
  - `resolveImage("playwright", d)` → user `open-factory-user/playwright:latest`;
  - `resolveImage(undefined, "ghcr.io/…:latest")` → registry, **even if the default has a bare name**;
  - `resolveImage("docker.io/library/ubuntu", d)` → registry;
  - validation: `image: ubuntu` without a folder → the exact error; with `images/ubuntu/Dockerfile` → no error;
  - start (fake docker in `runtime/docker/testing/fake-docker.ts`): a Docker agent with `image: smoke` and no local tag → `error{source:"spawn", fix:"image"}`, errored `start`, and `pull` **never called**; with the tag present → it starts; a registry image still pulls when missing (S5 test kept).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files plus `pnpm vitest run apps/server/src/templates apps/server/src/agents apps/server/src/supervisor` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): bare image names are user images, started without pulling`.

---

### Task 18: The build context: walk, hash and tar

Spec §10.2, R8. Add the two dependencies here.

**Files:**
- Modify: `apps/server/package.json` (`pnpm --filter @open-factory/server add --save-exact tar-stream@2.2.0 @balena/dockerignore@1.0.2`; if `@types/tar-stream` is needed, add the version already in the lockfile or write a minimal `declare module` in `images/tar-stream.d.ts`)
- Create: `apps/server/src/images/context.ts`, `context.test.ts`

**Interfaces — Produces:**
```ts
export class ImageNameError extends Error {}          // → 400 invalid_image_name
export class ContextLinkError extends Error {}        // "images/<name>/<path> links outside the folder. Copy the file into the folder instead."
export async function imageDir(imagesRoot: string, name: string): Promise<string>; // grammar + realpath direct child, else ImageNameError
export type ContextEntry = { path: string; type: "file" | "link" | "dir"; mode: number; target?: string };
export async function walkContext(dir: string, name: string): Promise<ContextEntry[]>; // sorted; .dockerignore honoured; links never followed
export async function contextHash(dir: string, name: string): Promise<string>;           // sha256 over path\0type\0(bytes|target)\0mode
export async function packContext(dir: string, name: string): Promise<NodeJS.ReadableStream>; // tar-stream pack of the same entries
```

- [ ] **Step 1: Failing tests** (temp folders):
  - `imageDir` refuses `..`, `a/b`, `Upper`, and a folder that is a symlink to outside `images/`; it accepts a plain child;
  - `.dockerignore` excludes `node_modules` and keeps `!keep.txt`;
  - a link to a file inside is packed as a link entry (read back the tar with tar-stream `extract` and check the entry's `type: "symlink"` and `linkname`);
  - a link to `../../etc/passwd` → `ContextLinkError` with the exact sentence;
  - the hash is stable across two runs, and changes with content, mode and a link target;
  - the walk ignores a file excluded by `.dockerignore` for the hash too.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Check that `git diff pnpm-lock.yaml` only adds the two importer entries (no new packages).
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): image build context walk, hash and tar`.

---

### Task 19: `ImageBuilder`, `DockerClient.buildImage` and status

Spec §10.3, §10.4, F3, Q13.

**Files:**
- Modify: `apps/server/src/runtime/docker/client.ts` (`buildImage(context: NodeJS.ReadableStream, o: {tag: string; pull: boolean; labels: Record<string,string>}, onLine: (line: string) => void): Promise<{ok: true} | {ok: false; error: string}>`, using `docker.buildImage(ctx, {t, pull, labels, rm: true, forcerm: true})` and `modem.followProgress`, turning `stream` lines and the `error`/`errorDetail` object from V1 into lines and a result, plus `imageInspect(ref)` for `RepoDigests` if needed), `runtime/docker/testing/fake-docker.ts` (scripted builds)
- Create: `apps/server/src/images/builder.ts`, `builder.test.ts`, `apps/server/src/images/status.ts`, `status.test.ts`

**Interfaces — Produces:**
```ts
export class ImageBuilder {
  constructor(d: { docker: DockerClient; imagesRoot: string; bus: EventBus; now: () => Date; log });
  build(name: string, o: { pull: boolean }): Promise<BuildResult>;      // joins a running build of the same name
  running(name: string): boolean;
  log(name: string): { state: "building" | "succeeded" | "failed" | null; lines: string[] }; // last 200 lines when done
  last(name: string): { state: "succeeded" | "failed"; finishedAt: Date; error?: string; durationMs: number } | undefined;
  subscribe(name: string, fn: (line: string) => void): () => void;     // the ndjson stream's source
}
export async function imageStatus(d: { docker; builder; imagesRoot }, name: string): Promise<ImageItem>;
export async function listImages(d, templates: TemplateRow[]): Promise<ImageItem[]>;  // usedBy from template configs
export async function templateImageStatus(d, config: TemplateConfig | undefined, defaultImage: string): Promise<ImageStatus | undefined>;
```
- **Build flow:** `contextHash` → `packContext` → `docker.buildImage(…, {tag: userImageTag(name), pull, labels: {[LABEL_CONTEXT_HASH]: hash, [LABEL_BUILT_AT]: now.toISOString()}})`.
- **Pull failure:** a failure matching V1 (c)'s text becomes the error `Base image <ref> couldn't be pulled. If it's local-only, run \`open-factory images build <name> --no-pull\`.`
- **Frames:** lines are batched every 250 ms into `image_build {name, state:"building", lines}`; at the end come `image_build {state}` and `images_changed`.
- **Status** follows the spec §10.4 table in order. Docker errors that `dockerUnreachable(err)` recognises (it already exists in `runtimes.ts`; move it to `runtime/docker/errors.ts` if needed) → `unknown`.

- [ ] **Step 1: Failing tests** (fake docker):
  - a build writes the tag with both labels, and `pull` is passed through;
  - a second `build` while running joins it (one `buildImage` call);
  - a failing build keeps the last 200 lines and the error;
  - the pull-failure text maps to the `--no-pull` sentence;
  - frames are batched (fake timers);
  - status covers every row of the table, including `out_of_date` after a file change and `failed` newer than an existing image;
  - `unknown` when Docker throws `ECONNREFUSED`;
  - `templateImageStatus` returns `present`/`pulled_on_start` for registry refs and the user status for bare names.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): user image builds and status from Docker labels`.

---

### Task 20: Images REST and template image status

Spec §10.5, AC7, AC8.

**Files:**
- Create: `apps/server/src/routes/images.ts`, `routes/images.test.ts`
- Modify: `routes/templates.ts` (list and detail add `imageStatus`), `app.ts` (decorate `images: ImageBuilder`, register `imagesRoutes`)

- [ ] **Step 1: Failing tests:**
  - `GET /api/images` → `{imagesDir, baseImage, images}`;
  - `POST /api/images/smoke/build` → `202 {state:"building"}`; with `{pull:false}` the fake sees `pull: false`;
  - with `Accept: application/x-ndjson` the response streams `{"line":…}` lines and ends with `{"state":"succeeded"}`; a client abort mid-stream doesn't cancel the build (its `last()` ends `succeeded`);
  - `POST /api/images/..%2Fx/build` → `400 invalid_image_name`;
  - `GET /api/images/smoke/log`;
  - `GET /api/templates` has `imageStatus` per template;
  - an agent token gets `401` on all of them.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** For the ndjson branch use `reply.hijack()` or `reply.raw.write`, the way any streamed route in the codebase does. If there is none, use `reply.raw` with `content-type: application/x-ndjson` and close when the build ends.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): images REST and template image status`.

---

### Task 21: CLI `open-factory images`

Spec §10.5.

**Files:**
- Create: `apps/cli/src/commands/images.ts`, `apps/cli/src/commands/images.test.ts`
- Modify: `apps/cli/src/commands.ts` (`COMMANDS` adds `images`, with summary `List user images or build one: open-factory images [build <name>|--all] [--no-pull]`)

- [ ] **Step 1: Failing tests** (the `Io` fake with `fetch` stubbed, as `cli.test.ts` does):
  - `images` prints a table (name, status, built, used by);
  - `images build smoke` streams lines to `out` and exits 0 on a final `succeeded`, or 1 on `failed` (printing the error to `err`);
  - `--no-pull` sends `{pull:false}`;
  - `--all` builds every image whose status isn't `built`, in order, and exits 1 if any failed;
  - not logged in → the existing auth message, exit 1;
  - an unknown subcommand → usage on `err`, exit 2 (match how other commands do it).
- [ ] **Step 2: Run** `pnpm vitest run apps/cli` → FAIL.
- [ ] **Step 3: Implement** with `resolveTarget`/`readConfig`/`guardedFetch`, the way `commands/status.ts` uses them. The ndjson reader splits `response.body` on `\n`.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(cli): open-factory images and images build`.

---

### Task 22: Checkpoint C: review findings applied

- [ ] Request a code review of Tasks 14–21 (spec §9, §10, §13), with **an explicit security pass** over the sign-up gate, disable and the build context. Fix the findings test-first, one commit each. Run `pnpm test`.

---

## Chunk D: web, live check, PR (Tasks 23–33)

### Task 23: Web foundations: format, APIs and invalidations

Spec §6 (formatting), §11.

**Files:**
- Create: `apps/web/src/features/usage/format.ts`, `format.test.ts`, `apps/web/src/features/usage/api.ts`
- Modify:
  - `apps/web/src/features/session/format.ts`: `formatTokens` gains `M` from 1,000,000 ("1.2M"); `k` stays lowercase;
  - `apps/web/src/routes/_app.tsx` `onMessage`:
    - `settings_changed` → `["factory-settings"]`;
    - `users_changed` → `["users"]`, `["invites"]`;
    - `images_changed` / `image_build` → `["images"]`, `["templates"]`;
    - `agent_status` turnOpen true→false edge → invalidate `["usage"]` (debounced 5 s), using a `useRef<Map<string, boolean>>` of the last `turnOpen` per agent;
  - `onOpen` (reconnect) → invalidate `["usage"]`;
  - `apps/web/src/features/settings/api.ts`: query options for factory settings, users, invites, plus mutations.

**Interfaces — Produces:**
```ts
// features/usage/format.ts
export function formatCost(usd: number, turns: number): string; // "—" when turns = 0; "<$0.01"; "$12.34"; "$1,234"; "$0.00"
export function formatCostEst(usd: number, turns: number): string; // `${formatCost} est.` (no suffix on "—")
export function parseDay(date: string): { y: number; m: number; d: number };    // no Date shift
export function formatDayShort(date: string): string;                           // "Thu 20 Nov" via Intl with timeZone "UTC" on Date.UTC
export function niceMax(v: number): number;                                     // 1/2/5 × 10ⁿ ≥ v
export const RATE_LIMIT_WINDOW: Record<string, string>;                         // five_hour → "5-hour", seven_day → "7-day"
// features/usage/api.ts: dailyUsageQuery(days), agentsUsageQuery(days | "rolling7"), credentialsUsageQuery(days),
//   agentUsageQuery(slug, days); all keys start with "usage"
```

- [ ] **Step 1: Failing tests:**
  - `formatCost(0.004, 1)` → `<$0.01`; `(0, 3)` → `$0.00`; `(0, 0)` → `—`; `(12.345, 1)` → `$12.35`; `(1234.5, 1)` → `$1,235`;
  - `formatTokens(1_234_567)` → `1.2M`;
  - `formatDayShort("2026-11-20")` → `Fri 20 Nov` (whatever weekday 2026-11-20 is; compute it in the test with `Date.UTC`);
  - `niceMax(3.21)` → 5, `(12)` → 20;
  - in `routes/_app` (a render with a fake hub, as `ws-hub.test.tsx` does): a true→false edge invalidates `usage` once after 5 s; two edges within 5 s invalidate once.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/usage apps/web/src/test/ws-hub.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): usage formatting, APIs and live invalidation`.

---

### Task 24: The usage chart

Spec §12.6 (F5, U1/U3/U20).

**Files:**
- Create: `apps/web/src/features/usage/usage-chart.tsx`, `usage-chart.test.tsx`
- Modify: `DESIGN.md` → Colors → Semantic: append "Chart series start at `--chart-2`; `--chart-1` (signal) marks only the focused datum."

**Interfaces — Produces:** `<UsageChart days={DayUsage[]} rangeDays={7|30|90} timezone={string} today={string /* local date */} />`

- [ ] **Step 1: Failing tests** (Testing Library):
  - one bar per day; bars use `fill="var(--chart-2)"`, today's uses `var(--chart-5)`, and the selected one `var(--signal)`;
  - a non-zero tiny value gets height ≥ 1;
  - the wrapper has `tabIndex=0`, `role="group"` and the aria-label with `{days}`;
  - ArrowRight/ArrowLeft/Home/End move the selection, and Escape clears it;
  - the live region's text equals the tooltip text ("Thu 20 Nov · $3.21 est. · 41 turns"; today's ends "· today so far");
  - the SVG is `aria-hidden` and contains no focusable element;
  - the hidden `<table>` has a row per day;
  - x labels every day for 7, every 7th for 30, every 14th for 90;
  - the caption reads "30 days to today, in Europe/Berlin.".
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with ResizeObserver width (fallback 600 in jsdom), min height 160, and a tooltip opacity transition of 100ms (`transition-opacity`, never `transition-all`) that is none under `prefers-reduced-motion`.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): usage chart`.

---

### Task 25: Tree cost cell, strip segment, task usage line

Spec §12.1, §12.2, §12.5 (U2, U7, U17).

**Files:**
- Modify: `apps/web/src/features/agents/agent-tree.tsx` (a cost cell per row from a `Map<slug, AgentUsageRow>` prop; hidden below `md`; sr-only text), `apps/web/src/routes/_app/agents.index.tsx` (fetch `agentsUsageQuery("rolling7")`; the muted explanation line above the Active tree), `apps/web/src/features/session/agent-strip.tsx` (the usage segment), `apps/web/src/features/tasks/task-detail.tsx` (the usage line + hint)
- Test: `apps/web/src/test/agents-tree.test.tsx`, `features/session/agent-strip.test.tsx`, `features/tasks/task-detail.test.tsx` (extend)

- [ ] **Step 1: Failing tests:**
  - a persistent row shows the total, and its sr-only text is "Estimated cost, last 7 days: $4.60 (own $1.20, spawned $3.40)";
  - a spawned row shows its own figure; no turns shows `—`;
  - no tooltip trigger inside the row link;
  - the line above the tree has the exact string;
  - the strip segment links to `/agents/lead/usage` with "$4.12 est. · 7d" and the aria-label, or "Usage" when empty;
  - the task detail shows "Usage: $1.23 est. · 14 turns" and the hint, and is hidden when `usage` is null.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): usage in the agent tree, the strip and tasks`.

---

### Task 26: The per-agent usage page

Spec §12.3 (U4–U10, U18).

**Files:**
- Create: `apps/web/src/routes/_app/agents.$slug_.usage.tsx`, `apps/web/src/features/usage/range-filter.tsx` (a native radio group with legend "Range", modelled on the Ended filter in `agents.index.tsx`), `usage-totals.tsx` (`<dl>`), `estimate-line.tsx`, `usage-tables.tsx` (by model, by task, spawned)
- Test: `apps/web/src/test/agent-usage.test.tsx`
- Generated: `apps/web/src/routeTree.gen.ts` (by the router plugin on `pnpm --filter @open-factory/web build` or dev)

- [ ] **Step 1: Failing tests** (`render-in-router` + `mock-api`):
  - `?days` defaults to 30; switching to 7 updates the URL and keeps the previous data while loading;
  - the back link reads "← @lead"; the document title is "Usage · Lead · Open Factory";
  - the totals `<dl>` shows "Estimated cost" enlarged and the tokens line verbatim, plus the estimate line;
  - the by-task note string, headed "By task";
  - spawned agents appear for a persistent agent only;
  - empty: "No usage in the last 7 days.";
  - error: "Couldn't load usage for @lead." with Retry;
  - an unknown slug → `ResourceNotFound`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): per-agent usage page`.

---

### Task 27: Settings: order, anchor nav, per-section errors, Usage section, credential rate-limit line

Spec §12.4 (Usage, Credentials), §12.9 (U9–U11, U16).

**Files:**
- Modify: `apps/web/src/routes/_app/settings.tsx` (sections and `SECTIONS` → `usage, credentials, secrets, projects, users, factory`; `<nav aria-label="On this page">`; remove the page-wide error and the `useQueries` gate; `validateSearch` adds `days`), each existing section (`credentials-section.tsx`, `secrets-section.tsx`, `projects-section.tsx`) renders its own "Couldn't load …" + Retry
- Create: `apps/web/src/features/settings/usage-section.tsx`, `rate-limit-line.tsx`
- Test: `apps/web/src/test/settings.test.tsx` (extend), `features/settings/rate-limit-line.test.tsx`

- [ ] **Step 1: Failing tests:**
  - the nav links all six anchors, and the hash focus works for `#usage`;
  - a failing credentials query shows only "Couldn't load credentials." while the other sections render;
  - the Usage section's agents `<table>` has headers "Own (est.)", "Spawned (est.)" and "Total (est.)", and a disclosure "Show 3 spawned agents of @lead" with `aria-expanded`;
  - the "8 agents with no usage" fold;
  - agent names link to usage pages;
  - the credentials table;
  - all-zero days → the empty line, with the credentials table still shown;
  - `RateLimitLine` covers each derived state from spec §7 in order (pause → "Rate-limited until 14:30"; no data → "No rate-limit data yet"; a warning with a future reset → "82% of the 5-hour limit used"; a warning without `resetsAt`, observed 30 minutes ago → near the limit, observed 2 hours ago → within limits; a past reset → "Within limits · seen 5 minutes ago"), each with an icon plus text;
  - the credentials rows show the same line.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): Settings usage section and rate-limit state`.

---

### Task 28: Settings: Users and invites

Spec §12.4 Users (U12, U13, U21).

**Files:**
- Create: `apps/web/src/features/settings/users-section.tsx`, `invite-reveal.tsx`
- Test: `apps/web/src/test/settings-users.test.tsx`

- [ ] **Step 1: Failing tests:**
  - users list rows show "Joined 19 Nov" and "(you)"; the menu is labelled "Actions for @alice";
  - "Disable (that's you)" and "Disable (last enabled user)" are unavailable;
  - Disable opens the confirmation with the exact text for 2, 1 and 0 invites, and the button "Disable @alice";
  - a 409 maps to its sentence;
  - Enable shows "Enabled @alice. They can sign in again.";
  - pending invites read "Created by @or · expires in 6 days"; Revoke shows "Revoked the invite from @or. Undo", Undo restores, and an Undo failure shows "Couldn't restore the invite: it has expired.";
  - "Create invite link" reveals the field focused with its text selected, Copy → "Copied.", and the shown-once line; Done hides it; creating another replaces it; a failure shows "Couldn't create an invite. Try again.".
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with `ConfirmDialog`, `InlineOutcome` and the `DropdownMenu` patterns from `credentials-section.tsx`.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): Settings users and invites`.

---

### Task 29: Settings: Factory

Spec §12.4 Factory (U14).

**Files:**
- Create: `apps/web/src/features/settings/factory-section.tsx`
- Test: `apps/web/src/test/settings-factory.test.tsx`

- [ ] **Step 1: Failing tests:**
  - the three fields carry their hints verbatim (§12.10), with suffixes "min" and "s";
  - the live "3 of 8 running" comes from a `supervisor` frame;
  - blur with 0 in the cap → "Enter a whole number from 1 to 64."; editing clears it;
  - Save sends only the changed fields and shows "Saved."; a server 400 maps to its field;
  - the read-only "Local runtime: Not allowed" row with its sentence;
  - a `settings_changed` frame while the form is dirty shows "These settings were changed elsewhere." with Reload;
  - the warm-window hint adds "Agents created before this change keep 70 min until re-synced." (shown always, as the spec says).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** using `FormField`/`FieldShell` and the blur-validation pattern of `schedules/` forms.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): Settings factory config`.

---

### Task 30: Sign-up and sign-in states

Spec §12.7 (U19).

**Files:**
- Modify: `apps/web/src/routes/sign-up.tsx` (`validateSearch` `invite`; a loader fetches `/api/auth/sign-up-state`; the states; `invite` sent in the body; 403 mapping), `apps/web/src/routes/sign-in.tsx` (the "Sign up" link only when bootstrap; `USER_DISABLED` → the disabled line), `apps/web/src/components/auth-error.ts` (code mapping)
- Test: `apps/web/src/test/sign-up.test.tsx`, `sign-in.test.tsx` (extend)

- [ ] **Step 1: Failing tests:**
  - bootstrap → the form + "You're the first user of this factory. You'll invite everyone else from Settings → Users.";
  - valid → the form;
  - missing → "Sign-up needs an invite link from a member of this factory." + the sign-in link, and no form;
  - invalid → the invalid line, no form;
  - a submit 403 `invite_invalid` → the form-level invalid line;
  - a 403 `invite_required` after loading as bootstrap → "Someone else just became the first user. Ask them for an invite link.";
  - sign-in: `USER_DISABLED` → "This account is disabled. Ask a member of this factory to enable it."; "Sign up" hidden unless bootstrap.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): invite-only sign-up states`.

---

### Task 31: Templates: Image column, template page status, Images section, build log

Spec §12.8 (U15); the template editor's warm-window hint.

**Files:**
- Create: `apps/web/src/features/templates/image-status.tsx` (icon + word for every status), `images-section.tsx`, `build-log.tsx`
- Modify: `apps/web/src/features/templates/template-list.tsx` (the Image column), `routes/_app/templates.index.tsx` (the Images section, the "Images" header link, `#images` focus), `routes/_app/templates.$name.tsx` / `template-editor.tsx` (status next to `image:`, a Build button, the `warm_window_minutes` hint "Omit to use the factory default (70 min)." with the live value from the factory settings query), `features/templates/api.ts` (images queries, `buildImage(name)`)
- Test: `apps/web/src/test/templates.test.tsx` (extend), `features/templates/build-log.test.tsx`

- [ ] **Step 1: Failing tests:**
  - each status renders its icon and word (Building… uses `text-signal`; failed crimson; out of date warning; built success; others muted);
  - "Pulled when missing" for a registry ref;
  - the Images rows carry Build/Rebuild, with View log hidden when no log is held;
  - `image_build` frames append lines to an open log;
  - the log has `role="log"` and `aria-live="off"`; ANSI is stripped; "Jump to latest" appears after scrolling up; Copy;
  - success shows "Built playwright in 1m 12s.";
  - the empty state uses `imagesDir` and `baseImage` from the response;
  - the note "Agents use a rebuilt image from their next start.";
  - the template page's Build button for a `not_built` user image;
  - the editor hint shows the live default.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): image status, the Images section and build logs`.

---

### Task 32: Live check `pnpm smoke:images` and final verification

Spec §15.5, AC7, AC9.

**Files:**
- Create: `apps/server/scripts/smoke-images.ts` (modelled on `smoke-scheduling.ts`: a throwaway DB and `FACTORY_HOME`, the real app, real routes only, the token read at run time)
- Modify: root `package.json` (`"smoke:images": "node --env-file-if-exists=.env --import tsx apps/server/scripts/smoke-images.ts"`), `packages/harness/fixtures/README.md`

- [ ] **Step 1: Write the script** with these steps, each asserted and printed:
  1. Sign up the first user (bootstrap); `POST /api/credentials` with the haiku token; create `images/smoke/Dockerfile` (`FROM ghcr.io/orlevii/open-factory/base:latest` + `RUN echo smoke > /etc/smoke`) and a template `smoke-tpl` (`runtime: docker`, `image: smoke`, `model: haiku`); create agent `smoke`.
  2. Message it: the start fails with `fix: "image"` and the exact "isn't built" message; `pull` never ran (no `pulling` status seen).
  3. Run the built CLI `node apps/cli/dist/open-factory.js images build smoke` with `OPEN_FACTORY_URL` set to the app and `OPEN_FACTORY_TOKEN` set to the user's bearer token (the `set-auth-token` header from sign-in; `config-store.ts` `resolveTarget` reads both env vars). The log streams, exit 0; `docker image inspect` shows `io.open-factory.context-hash`; `GET /api/images` → `built`.
  4. Restart the agent (`POST /api/agents/smoke/restart`, or message it again): it starts, the container label `io.open-factory.image` = `open-factory-user/smoke:latest`, and it answers; `GET /api/agents/smoke/usage?days=7` has turns ≥ 1; the turn row has `credential_id` set; `GET /api/usage/credentials?days=7` shows the credential with a `rateLimit` (record it: V5 in situ).
  5. `touch images/smoke/new.txt` → `GET /api/images` → `out_of_date`.
  6. A second image `FROM open-factory-base:dev`: `images build local --no-pull` → exit 0; without `--no-pull` → exit 1 with the "couldn't be pulled" sentence.
  7. Invite flow through real HTTP: `POST /api/invites` → sign up a second user with the link's token → 200; reuse → 403. Disable the second user → their bearer gets 401.

  Run `pnpm build && pnpm smoke:images` → all PASS. Keep the redacted output for the PR.
- [ ] **Step 2: Full verification** (paste the summary lines into the PR):

```bash
pnpm compose up -d
pnpm test
pnpm typecheck
pnpm lint:ci
pnpm build
```

- [ ] **Step 3: Manual browser pass** (`pnpm dev`):
  - the tree column and line;
  - a usage page with each range;
  - chart keyboard navigation with VoiceOver reading the live region;
  - Settings: anchor nav, Usage, Users (create, reveal, copy, revoke + Undo, disable confirmation), Factory (blur errors, save, the live running count);
  - Templates: Images build with the live log, and a failure;
  - sign-up with and without an invite;
  - both themes; one phone-width pass.

  Fix anything off test-first before the PR.
- [ ] **Step 4: Record** the smoke lines and the Docker and Claude Code versions in `packages/harness/fixtures/README.md` ("Verified in S10 implementation"). Commit `docs: record S10 live verification` together with the script.

---

### Task 33: Pull request

- [ ] **Step 1:** `git push`, then open the PR against `spec/s9-scheduling` (stacked), following `.github/pull_request_template.md` and AGENTS.md:
  - **Title:** `feat: usage tracking, invites and live factory settings, user images`
  - **What:** this covers:
    - per-turn usage attributed to tasks and credentials;
    - rollups in the tree, on the per-agent page and in Settings → Usage, with a chart;
    - rate-limit state per credential;
    - invite-only sign-up with disable/enable;
    - live factory settings;
    - user images built from `~/open-factory/images/` with status and the CLI.
  - **Why:** the S10 roadmap item. Link the spec, this plan and the decision issue #68. Closes #1 and #62.
  - **Approach** (one bullet per decision, in the form "X, rather than Y, because Z"):
    - store `turns.task_id` at close, rather than derive per query, because it freezes the attribution and is cheap to read; it is a lower bound (only turns that handled that task's messages and nothing else);
    - plain SQL rollups, rather than materialized views or a rollup table, because the numbers then equal the stored turns by construction;
    - estimated cost as the headline, rather than tokens, because it compares across models (labelled est. with a visible line);
    - a `factory_settings` row, rather than env plus override layers, because one source of truth needs no precedence UI;
    - local runtime stays env-only, rather than a UI toggle, because unsandboxed host access must need host access;
    - the invite check inside the `/api/auth/*` catch-all on the normalized path, plus an ALS backstop in `user.create.before`, rather than a separate route, because a separate route was bypassable through dot segments;
    - a minimal disable, rather than deferring user removal, because invite-only sign-up needs a way to cut someone off;
    - bare `image:` names as user images, never pulled, rather than a prefix, because it matches "reference them by name";
    - status from Docker labels, rather than a builds table, because Docker is the truth for what exists;
    - manual builds with `pull: true` and a CLI `--no-pull`, rather than auto-builds, because builds are slow and fail in ways a human must read;
    - a hand-rolled SVG chart, rather than a library, because it is one simple chart.
  - **Changes** grouped by area (shared, db, harness, server usage, runtime, supervisor, settings, auth/users, images, CLI, web usage, web settings, web templates, smoke).
    - **Behaviour changes to earlier slices, listed explicitly:**
      - turn_end stamps the starting batch before closing the turn (S6 order changed, with the guard kept);
      - exit stamps the awaiting batch to the open turn;
      - `openTurn` takes a credential;
      - the supervisor cap is a getter;
      - the warm and held timers re-arm on settings changes;
      - `warm_window_minutes` is optional;
      - `FACTORY_MAX_RUNNING_AGENTS` and `FACTORY_MEMBER_UPDATE_DEBOUNCE_SECONDS` are removed (boot warns);
      - sign-up needs an invite after the first user;
      - `getUser` rejects disabled users;
      - a bare `image:` is a user image (escape: `docker.io/library/<name>`);
      - `StartFix` gains `image`;
      - Settings errors are per section.
    - **Rollout notes:** set the cap and the debounce in Settings → Factory; rewrite `image: ubuntu`-style templates as `docker.io/library/ubuntu`; invite teammates from Settings → Users.
  - **Non-goals:** budgets; #69–#73; a usage MCP tool; TZ in containers (#66).
  - **Verification:**
    - Task 1's V1, V2, V3 and V5 results;
    - the smoke output (redacted);
    - the test, typecheck, lint and build lines;
    - the manual pass.
    - **Dependencies:** `tar-stream@2.2.0` and `@balena/dockerignore@1.0.2` became direct dependencies; they were already in the lockfile through dockerode, and no supply-chain setting changed.
  - Remove the template's HTML comments, and end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 2:** Report the PR URL to the lead.

---

## Acceptance criteria → tasks

| AC | Proven by |
|---|---|
| 1 Usage matches stored turns | Tasks 8, 9, 23, 25–27 |
| 2 Per-task attribution (#62) | Task 6 |
| 3 Concurrency cap live | Tasks 10, 11 |
| 4 Default warm window and debounce live | Task 12 |
| 5 Invite-only sign-up | Tasks 14, 15, 30, 32 |
| 6 Disable | Task 16, 28, 32 |
| 7 User image builds and runs | Tasks 17–21, 31, 32 |
| 8 Session-only routes | Tasks 9, 10, 14, 16, 20 |
| 9 CI and live | Tasks 32, 33 |

## Spec §15 tests → tasks

§15.1 unit → Tasks 2, 4, 15, 17, 18, 23, 24. §15.2 server: AC1 → Task 8; AC2 → Task 6; credential → Task 5; rate limits → Task 4; AC3/AC4 → Tasks 11, 12; AC5/AC6 → Tasks 15, 16; images → Tasks 17–20; AC8 → Tasks 9, 10, 14, 16, 20; disable vs sockets → Task 16; test-setup changes → Tasks 10, 15. §15.3 CLI → Task 21. §15.4 web → Tasks 23–31. §15.5 live → Task 32. §16 V1/V2/V3/V5 → Task 1 (V3 fallback → Task 15); V4 → Task 6.
