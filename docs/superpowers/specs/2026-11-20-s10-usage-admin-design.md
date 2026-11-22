# S10 Usage and Administration: Technical Design

- **Date:** 2026-11-20
- **Status:** approved by owner-proxy (owner-s10), revised after the spec self-review and the impeccable UI review (F1–F6 and U1–U22 in the decision log); pending Or's review of the low-certainty items (§21)
- **Roadmap spec:** `docs/product/roadmap/v0.0.1/s10-usage-admin.md`
- **Product sources of truth:** `docs/product/architecture/usage-tracking.md`, `base-image.md`, `data-model.md`, `agent-runtime.md`; `docs/product/behavior/administration.md`; `docs/product/concepts/credential.md`, `user.md`, `agent-template.md`; ADRs 0013 (one server process), 0019 (usage, no budgets).
- **Builds on:** S1 (better-auth, `requireUser`, sign-up), S3 (`turns`, mapper usage deltas), S4 (templates, credentials, Settings sections), S5 ([spec](2026-11-19-s5-supervisor-docker-design.md): supervisor slot pool, credential rate-limit pauses, image pull on start, container spec hash, the local-runtime gate), S6 (member-update debounce), S7 (spawned agents: `kind = 'ephemeral'`, `reports_to` = spawner, the spawner's credential), S8 ([spec](2026-11-20-s8-tasks-inbox-design.md) §6.7: `messages.task_id`, `delivered_turn_id`), S9 (`FACTORY_TIMEZONE`).
- **Decision log:** #68 ("S10 Usage and administration: design decisions"); question numbers below (Q1–Q20, R1–R10) refer to it.
- **Stacked on:** `spec/s9-scheduling` (PR #67) → S8 → … → S3.

> `docs/product/` is gitignored, so the product docs exist only in local checkouts. Paths above are relative to the repo root.

## 1. Goal

Visibility into cost and load, and complete administration:

- **Usage:** per-turn usage (already stored since S3) rolled up per agent, per spawner, per task, per credential and per day; shown in the agent tree, on a per-agent usage page and in Settings with a daily chart; rate-limit state per credential, including the early warning Claude sends before a limit.
- **Administration:** invite-only sign-up with a disable switch (closes #1), factory config editable live in Settings (concurrency cap, default warm window, member-update debounce; local runtime shown read-only), and user Docker images built from `~/open-factory/images/<name>/` with an image status per template.

## 2. Acceptance criteria

From the roadmap, made testable. All run in default CI (fake driver, real Postgres, fake Docker client) unless marked live.

1. **Usage matches stored turns.** For a seeded set of turns across agents, spawned children, tasks, credentials, days and a DST boundary in `FACTORY_TIMEZONE`, every REST rollup (§7) equals a reference sum computed in the test directly from `turns` rows. The tree column, the per-agent page and Settings → Usage render those numbers.
2. **Per-task attribution (#62).** A turn that ends normally, has no `originKind`, and whose every delivered non-system message carries task T gets `turns.task_id = T`: a single task message that starts a turn attributes it (the starting batch is stamped before the close), and a mid-turn absorbed batch of the same task keeps it attributed. A turn with messages of two tasks, a task message plus any non-task message (human, agent, scheduled), no messages, an `originKind` (cron, task notification), a process exit, or a boot close gets `NULL` (§5.2).
3. **Concurrency cap live.** With cap 1 and two agents wanting to run, `PATCH /api/settings/factory {maxRunningAgents: 2}` grants the queued wake without a restart, and the `supervisor` frame reports `max: 2`. Lowering it to 1 with both busy stops neither; a queued wake is granted only once running < 1 (idle holders may hibernate early under S5's `evict()`, §8.2).
4. **Default warm window and debounce live.** An agent whose template omits `warm_window_minutes` hibernates after the factory default; changing the default re-arms an idle agent's armed timer to `armedAt + new window` (firing at once when past). A changed debounce re-arms held member updates at `createdAt + new debounce`.
5. **Invite-only sign-up.** With zero users, sign-up works without an invite. With one user, sign-up without a valid invite gets `403 invite_required`; with a valid one it succeeds once (a second use, an expired, revoked or unknown token all give the same `403 invite_invalid`). Two concurrent sign-ups on one invite: exactly one user is created. Two concurrent first sign-ups with zero users: exactly one succeeds without an invite.
6. **Disable.** Disabling a user deletes their sessions (cookie and bearer, including a CLI token), revokes their pending invites, makes every authenticated REST call and WS upgrade with their old token fail with `401`, closes their open sockets (1008; no further frames arrive), and blocks a new sign-in with `403 USER_DISABLED`. You can't disable yourself or the last enabled user. Enable restores sign-in.
7. **User image builds and runs.** `open-factory images build playwright` (CLI) and the UI's Build button each build `images/playwright/` into `open-factory-user/playwright:latest` with the context-hash label; a template with `image: playwright` starts a Docker agent on it (live check, §15.5). Before the build, the start fails with the "isn't built" message and never pulls. Changing a file in the folder shows "Out of date".
8. **Session-only routes.** A live agent token gets `401` on every route group added here (usage, settings, users/invites, images).
9. CI is green; the live check has been run and its output, plus a manual pass through Settings, the per-agent usage page and the Images section, is recorded in the PR.

## 3. Scope

**In:**
- `turns.task_id` and `turns.credential_id`, written by the runtime; indexes for the rollups;
- usage queries (plain SQL, no materialized views, Q2) and REST `/api/usage/*`, `/api/agents/:slug/usage`, the task detail's `usage` field;
- the mapper's `rate_limit_status` event for every `rate_limit_event`; the latest status per credential on `credentials`;
- UI: the tree's usage column, `/agents/:slug/usage`, Settings → Usage (daily chart, per-agent table grouped by spawner, credentials), the task detail usage line, a hand-rolled SVG bar chart;
- `factory_settings` (single row) replacing `FACTORY_MAX_RUNNING_AGENTS` and `FACTORY_MEMBER_UPDATE_DEBOUNCE_SECONDS`; the default warm window; live reads; Settings → Factory;
- invites, `users.disabled_at`, the invite check in the `/api/auth/*` catch-all (§9.3), disable/enable; Settings → Users; sign-up page changes;
- user images: name resolution, the build service, the context hash, start without pull, image status per template, the Templates page's Images section, the CLI `open-factory images` and `open-factory images build`;
- a live check `pnpm smoke:images`.

**Out (decided):** budgets or caps on cost (ADR 0019 unchanged); materialized views or rollup tables (Q2); a per-agent "current task" (Q1 C); a rate-limit history table (Q5); env-var fallbacks for the two removed variables (Q6); a UI toggle for the local runtime (Q7); auto-builds on start or on change (Q12); a `user_images` table and persisted build history (Q13); a charting library (Q17); an agent-facing usage tool or usage in `get_task` (Q18); a new WS frame for usage (Q19); user deletion, password reset (#2), email-locked invites, an open-sign-up escape hatch (Q10); build args, secrets, registry credentials or pushing images (R8); stacking the chart by agent; CSV export.

## 4. Architecture

```
harness mapper ── usage, rate_limit_status, rate_limited ──► AgentRuntime
                                                             │ turn open: turns.credential_id
                                                             │ turn close (turn_end, exit): usage + task_id; boot: closed, unattributed (§5.2)
                                                             │ rate_limit_status → CredentialStore.recordRateLimit
                                                             ▼
                                                           turns ◄── UsageService (plain SQL, §7) ◄── /api/usage/*, /api/agents/:slug/usage, task detail
                                                                                                    ▲
web: tree column, /agents/:slug/usage, Settings → Usage ── invalidate on agent_status turnOpen true→false (5 s debounce)

Settings → Factory ── PATCH /api/settings/factory ──► FactorySettings (row + in-memory copy) ──► live getters:
                                                       supervisor.max (re-run grants, `supervisor` frame), runtime warm window, debounce

/sign-up ── /api/auth/* catch-all, normalized path = sign-up (in-process mutex) ──► invite check → better-auth (ALS flag; user.create.before refuses without it) → mark invite used
Settings → Users ── /api/users*, /api/invites* ──► UserAdminService (disable: sessions + invites in one tx)

Templates → Images ── POST /api/images/:name/build ─┐
CLI `open-factory images build` (x-ndjson stream) ──┴──► ImageBuilder (one build per name, dockerode, labels) ── `image_build` frames
agent start (Docker, user image) ──► resolveImage: bare name → open-factory-user/<name>:latest, never pulled
```

New server modules: `usage/` (service, routes), `settings/` (factory settings store, routes), `users/` (invites, disable, the sign-up wrapper), `images/` (resolve, context walk and hash, builder, routes). Shared Zod schemas for every new route live in `packages/shared` (`usage.ts`, `settings.ts`, `users.ts`, `images.ts`).

## 5. Usage data

### 5.1 Schema (one migration)

- `turns.task_id text NULL REFERENCES tasks(id) ON DELETE SET NULL`, index `turns_task_idx (task_id) WHERE task_id IS NOT NULL`.
- `turns.credential_id text NULL REFERENCES credentials(id) ON DELETE SET NULL`, index `turns_credential_started_idx (credential_id, started_at)`.
- Index `turns_started_idx (started_at)` (the factory-wide daily query). `turns_agent_started_idx` exists.
- `credentials` gains `rl_status text` (`allowed | allowed_warning | rejected`), `rl_type text` (as Claude reports it, e.g. `five_hour`, `seven_day`), `rl_utilization real`, `rl_resets_at timestamptz`, `rl_observed_at timestamptz`; all nullable. They are overwritten on each event (no history, Q5).
- No backfill: older turns keep `NULL` task and credential and show as "unattributed".

### 5.2 Writing (Q1, R1, R2)

- **Credential at turn open.** `openTurn(agentId, credentialId)` writes the credential the running process was started with. Today the runtime only has `this.agent.credentialId`, which `reload()` replaces (`agent-runtime.ts` ~656), so the runtime captures `procCredentialId` when it spawns the process and uses that. For a spawned agent it is the spawner's credential, already on its row since S7.
- **Task at turn close** (Q1, tightened after round 2 to keep a true lower bound). One function, `attributeTask(turnId, tx)`, runs only on a `turn_end` without `originKind` and sets
  `task_id = (SELECT min(task_id) FROM messages WHERE delivered_turn_id = $turn AND kind <> 'system' HAVING count(*) > 0 AND count(*) = count(task_id) AND count(DISTINCT task_id) = 1)`:
  every delivered non-system message of the turn carries the same task; any message from a human, another agent or a schedule without that task leaves the turn unattributed.
  It runs at close, not at delivery, because a turn absorbs mid-turn batches (S6) whose rows are stamped with `delivered_turn_id` when written (`agent-runtime.ts` ~3302). The batch that **starts** a turn waits in `awaiting` and today is stamped only after `closeTurn` (turn_end: `closeTurn` ~2297, then `setDeliveredTurn` ~2304), and on process exit it is cleared unstamped (~2454). So the close paths change order (F1):
  - **turn_end without `originKind`** (the unchanged S6 condition, ~2303): in one transaction `setDeliveredTurn(awaiting, turnId)`, then `closeTurn`, then `attributeTask`.
  - **turn_end with an `originKind`** (cron, task notification): `closeTurn` only; S6 still never lets such a turn consume `awaiting` (the batch's own later turn computes S6 §8.1's `ran`/update-only from it). Not attributed: the turn wasn't started by a message.
  - **process exit with an open turn** and **boot's `closeDanglingTurns`**: unchanged S6 behaviour, not attributed. The open turn's origin isn't known at exit, so attributing it could charge a cron turn to a task; a crashed turn is undercounted instead (the R1 wish to attribute crashed turns gives way to the lower bound).
  Per-task usage is therefore a **lower bound**: every attributed turn handled only that task's messages, and work continued after other messages, mixed turns, self-started turns and crashed turns are missed. The UI says so (§12.10).
- **Usage deltas** are unchanged (S3 mapper: `model_usage_since_last_result`, or cumulative differences).

### 5.3 Rate-limit status (Q5, R3)

The mapper emits `{type: "rate_limit_status", status, rateLimitType, utilization?, resetsAt?}` for **every** `rate_limit_event`. Only `status: "rejected"` additionally emits the existing `rate_limited` event, which alone pauses the credential (S5); the code keeps that boundary in one `switch` with a comment. The runtime writes `rate_limit_status` to the credential's `rl_*` columns (an `UPDATE … WHERE id = $cred AND (rl_observed_at IS NULL OR rl_observed_at <= $now)`) and does not append it to the session timeline. The S5 pause (`rate_limited_until`) stays the source of truth for "paused". `allowed_warning` and `rejected` shapes are from SDK docs (#43 is still open); the fixture is labelled unverified until observed.

## 6. Usage semantics

- **Headline: estimated cost in USD** (Q3, R4). The explanation is visible, never only a tooltip: a muted line where cost first appears on a page, "Estimated at API prices. A subscription is billed by plan, not per token." Column headers read "Cost (est.)", totals "Estimated cost", inline figures "$4.12 est.". Tokens appear in the detail views: input, output, cache write, and cache read listed separately.
- **Formatting** (`features/usage/format.ts`, en grouping, tabular numerals): `$12.34` below $1,000, `$1,234` from $1,000 up (no cents); a non-zero amount under a cent is `<$0.01`; turns with zero cost show `$0.00`; no turns shows `—`. Tokens extend S3's `formatTokens` (lowercase `k`) with `M` ("1.2M"). Daily `date` strings are parsed as calendar dates, never through a local `Date` shift.
- **Windows** (Q4, F4): the tree column is a rolling 7 days (`started_at >= now() - 7 days`). The usage page and Settings → Usage offer 7 / 30 / 90 days, default 30, as `?days=` in the URL, and **everything on those pages covers the same calendar days**: the last `days` days in `FACTORY_TIMEZONE` including today (`started_at >= ($today - (days-1))::date AT TIME ZONE $tz`), so totals equal the sum of the bars. The chart buckets by `date_trunc('day', started_at AT TIME ZONE $tz)`. Caption under the chart: "30 days to today, in Europe/Berlin."
- **A turn counts** when it has `ended_at` (open turns are excluded) and is counted by `started_at`. Turns with `cost_usd IS NULL` (no usage event, e.g. a crash before `result`) count as turns with zero cost and tokens.
- **Spawner total** (Q16): a persistent agent's own turns plus the turns of every agent with `kind = 'ephemeral' AND reports_to = it` (S7: spawned agents can't spawn, so one level), terminated ones included. It follows the spawn chain only, never the reporting line: a manager's total excludes its persistent reports. A spawned agent's figure is its own.
- **Credential usage:** turns by `credential_id`, plus "Unattributed" for `NULL` (pre-S10 turns, deleted credentials).

## 7. Usage queries and REST (Q2, R5)

All routes are session-only (§13). `days ∈ {7, 30, 90}` (`400 invalid_days` otherwise). Each is one SQL statement over `turns` (joined to `agents` for grouping), with no caching; at single-developer scale these are index range scans. Amounts are returned as numbers (USD, 6 decimals as stored), tokens as integers.

| Route | Returns |
|---|---|
| `GET /api/usage/daily?days=` | `{timezone, days: [{date: "2026-11-20", costUsd, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, turns}]}`, one entry per calendar day in the window (zero-filled with `generate_series`). |
| `GET /api/usage/agents?days=` | `{agents: [{slug, displayName, kind, spawnerSlug?, archived, terminated, own: Totals, spawned?: Totals, total: Totals}]}` for every agent with turns in the window plus every live persistent agent (zeros), where `Totals = {costUsd, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, turns}`. Used by Settings → Usage and, with `days=7`, by the tree. |
| `GET /api/usage/credentials?days=` | `{credentials: [{name, kind, totals: Totals, agents: [{slug, costUsd}] (top 5 by cost), rateLimit: {status, type, utilization, resetsAt, observedAt} \| null, pausedUntil?, pauseExact?}], unattributed: Totals}`. |
| `GET /api/agents/:slug/usage?days=` | `{agent, total: Totals, own: Totals, daily: [...same as /daily but for this agent (spawner scope for a persistent agent)], byModel: [{model, ...Totals}], byTask: [{key, title, ...Totals}] (top 20), spawned: [{slug, displayName, terminated, ...Totals}] (persistent only)}`. |
| `GET /api/tasks/:key` (existing) | gains `usage: {costUsd, turns} \| null` (null when no attributed turns). |
| `GET /api/credentials` (existing) | each `CredentialSummary` gains `rateLimit: {status, type, utilization, resetsAt, observedAt} \| null` (the `rl_*` columns) and `pausedUntil?`, `pauseExact?` (the S5 pause), for the Credentials rows. |

`GET /api/usage/agents` also takes an optional `window=rolling`, valid only with `days=7` or `days` omitted, for the tree's rolling 7 days; any other `window` value, or `rolling` with another `days`, is `400 invalid_window`.

**Displayed rate-limit state** is derived, in this order: a live S5 pause → "rate-limited until"; else no `rl_observed_at` → "no data yet"; else `allowed_warning` whose `resetsAt` is in the future, or that has no `resetsAt` and was observed within the last hour → "near the limit"; else (including a warning whose reset has passed) → "within limits".

## 8. Factory settings (Q6–Q9, R7)

### 8.1 Storage

A single-row table `factory_settings (id smallint PRIMARY KEY CHECK (id = 1), max_running_agents int NOT NULL DEFAULT 8, default_warm_window_minutes int NOT NULL DEFAULT 70, member_update_debounce_seconds int NOT NULL DEFAULT 30, updated_at, updated_by text REFERENCES users(id))`, inserted by the migration. **`FACTORY_MAX_RUNNING_AGENTS` and `FACTORY_MEMBER_UPDATE_DEBOUNCE_SECONDS` are removed** from `config.ts`, `.env.example`, compose files and docs, with no shim (Q6); the PR's release note says so, and boot logs a warning when either is still set ("… is no longer read; set it in Settings → Factory"). That warning is the only trace; nothing reads the value. `FACTORY_ALLOW_LOCAL_RUNTIME` stays env-only (Q7).

### 8.2 Live reads

`FactorySettings` loads the row at boot and keeps an in-memory copy; `update()` writes the row and then swaps the copy (one process, ADR 0013). Consumers take getters, not values:
`FactorySettings` loads before boot reconciliation (`reconcile.ts` reads the debounce at boot). An update calls three public entry points: `supervisor.capChanged()` (wraps the private `pump()` then `publish()`), and a `runtimes.settingsChanged()` fan-out that enqueues a re-arm on each runtime's `run()` job queue (warm timer, held-update timer). Every read of the debounce goes through a getter returning ms (the setting is stored in seconds): `heldDue()`'s `=== 0` check, `runtimes.ts` ~201, the runtime test harness and reconcile.
- **Supervisor:** `max` becomes `() => settings.maxRunningAgents` (the supervisor deps built in `runtimes.ts`). After an update the supervisor runs `pump()` (raising the cap grants queued wakes at once, FIFO) and then publishes the existing `supervisor {running, max}` frame. Lowering it never stops a busy agent; but while wakes are queued, S5's `evict()` (free = max − holders) can make idle, hibernatable holders hibernate early (`freed_slot`) until running < max. That is S5's normal behaviour under a full cap, and the hint text says "running agents finish first".
- **Debounce:** S6 already recomputes a held update's due time as `createdAt + debounce` on every check (`heldDueAt`); it now reads the debounce through a getter, and an update re-arms every runtime's held-update timer from the recomputed due time (an earlier due time fires at once).
- **Warm window:** `warm_window_minutes` becomes optional in `templateYamlSchema` (no default) and `templateConfigSchema`; the parsed config omits it when the template does (test helpers that build configs are updated). The runtime uses `config.warmWindowMinutes ?? settings.defaultWarmWindowMinutes`. Because `updateWarmTimer` arms only when no timer exists, the runtime records `warmArmedAt`; a settings update makes every runtime whose snapshot omits the window clear its armed timer and re-arm it for `warmArmedAt + new window` (firing at once when that is past). Existing agent snapshots that already hold 70 keep it until re-synced (no rewriting of stored snapshots); the template editor's hint says "Omit to use the factory default (70 min)".

### 8.3 REST

`GET /api/settings/factory` → `{maxRunningAgents, defaultWarmWindowMinutes, memberUpdateDebounceSeconds, allowLocalRuntime, updatedAt, updatedBy}`. `PATCH` takes any subset of the three editable fields, validated by the shared schema (cap 1–64, warm window 1–1440, debounce 0–86400; `.strict()`, so `allowLocalRuntime` or any unknown key is a `400 invalid_settings`, never ignored). It publishes `settings_changed` to all sockets; the strip's "running/max" text already follows the `supervisor` frame.

## 9. Users and invites (Q10, Q20, R9)

### 9.1 Schema

- `users.disabled_at timestamptz NULL`, `users.disabled_by text NULL REFERENCES users(id)`.
- `invites (id text PK, token_hash text UNIQUE NOT NULL, created_by text NOT NULL REFERENCES users(id), created_at, expires_at NOT NULL, used_at, used_by text UNIQUE REFERENCES users(id), revoked_at)`.

### 9.2 Invites

- **Create** (`POST /api/invites`): a 32-byte random token (256 bits, base64url), stored as `sha256(token)`; `expires_at = now + 7 days`. The response carries the link `${PUBLIC_URL}/sign-up?invite=<token>` once; it is never retrievable again.
- **List** (`GET /api/invites`): pending ones (not used, not revoked, not expired) with creator and expiry; no token.
- **Revoke** (`POST /api/invites/:id/revoke`) sets `revoked_at` at once; **Undo** (`POST /api/invites/:id/restore`) clears it if the invite isn't used or expired. A revoked token is invalid during the Undo window.
- **Validity check** is one lookup by hash: `used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`. Every failure (unknown, used, revoked, expired) gives the same `403 invite_invalid` and the same page text, "This invite link isn't valid anymore. Ask a member of this factory for a new one."

### 9.3 Sign-up

A separate Fastify route for the sign-up path is **not** used: review showed over a real socket that `/api/auth/./sign-up/email`, `/api/auth/x/../sign-up/email` and `/api/auth/%2e/sign-up/email` miss a specific route, fall into the `/api/auth/*` catch-all, are normalized by `new URL()` there, and reach better-auth's sign-up (F2). Instead the existing catch-all in `routes/auth.ts` branches on the **normalized** `url.pathname === "/api/auth/sign-up/email"` with method POST (exactly what better-auth matches; trailing-slash, `//` and case variants already 404 in better-auth), and runs:

1. Acquire the process-wide `signUpMutex` (comment: "Correct only because the factory is one server process (ADR 0013); a multi-instance deployment must replace this with a Postgres advisory lock.").
2. If `users` has rows: require `invite` in the body (`403 invite_required` when absent) and check it (§9.2). With zero users the invite is not needed (bootstrap); this is the only place the zero-users rule lives.
3. Forward the request without the `invite` field to better-auth (S1's handle hook still runs) inside `signUpContext.run({allowed: true}, …)` (an `AsyncLocalStorage`).
4. On a 2xx, mark the invite used (`used_at`, `used_by` = the new user id) in a guarded `UPDATE … WHERE used_at IS NULL RETURNING`; `invites.used_by UNIQUE` is the backstop. A non-2xx leaves the invite unused.
5. Release the mutex.

**Backstop:** `databaseHooks.user.create.before` throws `APIError("FORBIDDEN", {code: "invite_required"})` unless `signUpContext.getStore()?.allowed` is set, with no zero-users exception, so the only code path that can create a user is the wrapper, whatever path or endpoint reaches better-auth. Tests drive a real listener (not `inject`, which normalizes dot segments itself) with the canonical path and the `/./`, `/x/../` and `%2e` variants.

`GET /api/auth/sign-up-state?invite=` (public) returns `{bootstrap: boolean, invite: "valid" | "invalid" | "missing"}` for the sign-up page. The sign-in page keeps its "Sign up" link only when `bootstrap` is true.

### 9.4 Disable and enable

- `POST /api/users/:id/disable`: refuse `409 cannot_disable_self` and `409 last_enabled_user`. In one transaction: lock the enabled users (`FOR UPDATE`, so two admins disabling each other can't leave zero), set `disabled_at`/`disabled_by`, delete all of the user's `sessions` rows (cookie sessions and bearer tokens are both rows; the CLI token is a bearer), revoke their pending invites. Response includes the count of revoked invites.
- `POST /api/users/:id/enable` clears `disabled_at`; it does not restore invites.
- **Enforcement on every request:** `getUser` reads `disabled_at` through a better-auth `additionalFields` entry (`disabledAt`, `input: false`) that comes back with `getSession`, and returns `null` when it is set (so `requireUser` gives `401` and the WS upgrade is refused). better-auth's cookie cache stays off (verified: off unless `enabled === true`), so a deleted session is gone at once. `databaseHooks.session.create.before` throws `APIError("FORBIDDEN", {code: "USER_DISABLED", message: "This account is disabled."})` for a disabled user (the admin plugin's ban pattern), so no sign-in method can create a session and the sign-in page can say why ("This account is disabled. Ask a member of this factory to enable it.").
- **Open sockets:** the WS route checks the session only at upgrade, so after the disable transaction commits the server closes every socket of that user with code 1008 (the event bus already indexes sockets per user; it gains `closeUser(userId)`).
- `GET /api/users` lists `{id, name, handle, email, createdAt, disabledAt}`. Disabled users keep their handle, inbox rows and authorship (no deletion; follow-up issue).

## 10. User images (Q11–Q14, R8)

### 10.1 Names and resolution

- Boot creates `<FACTORY_HOME>/images/` when missing, as it does `agents/` and `templates/`.
- A template `image:` that is a **bare name** (`^[a-z0-9][a-z0-9_.-]{0,62}$`, so no `/`, `:` or `@`) names the user image in `<FACTORY_HOME>/images/<name>/`. Anything else stays a registry reference (S5 behaviour, pulled when missing). The resolution applies only to a template's `image:`, never to `FACTORY_DEFAULT_IMAGE`.
- A bare name was a valid Docker Hub reference before S10 (`image: ubuntu`); the PR's release note gives the escape `docker.io/library/ubuntu` (F6).
- A bare name whose folder has no `Dockerfile` is a template **validation error**, so the template can't be used: "No user image ‘ubuntu’ (images/ubuntu/Dockerfile). For a Docker Hub image, write docker.io/library/ubuntu." The template scan reads `images/` (directory listing only) when it validates.
- **Start:** `resolveImage(ref)` returns `{kind: "user", tag: "open-factory-user/<name>:latest"}` or `{kind: "registry", ref}`. A user image is never pulled: when the tag is missing locally the start fails with `AgentStartError("Image `playwright` isn't built. Build it in Templates → Images, or run `open-factory images build playwright`.", "image")` (backticks render as `CodeText`). `"image"` joins the `StartFix` union and the shared `error.fix` enum; the UI links it to `/templates#images`. The container spec hash already includes the image id, so an agent picks up a rebuilt image at its next container start (no forced restart, Q13).

### 10.2 The context walk and hash

One function `walkContext(dir)` serves both the hash and the tar, so they always agree:
- `name` must match the bare-name grammar, and `realpath(images/<name>)` must be a direct child of `realpath(images/)` (`400 invalid_image_name` otherwise).
- Walk the folder, honouring `.dockerignore` with `@balena/dockerignore` (§14).
- A symlink is packed **as a link** (its target string), never followed. A link whose target resolves outside the image folder fails the build with "images/playwright/<path> links outside the folder. Copy the file into the folder instead."
- Hash: sha256 over, for each entry in sorted relative-path order, `path \0 type \0 (file bytes | link target) \0 mode`.

### 10.3 The builder

`ImageBuilder.build(name)`:
- At most one build per name: a second request joins the running one (same promise and log stream).
- `docker.buildImage(tarStream, {t: "open-factory-user/<name>:latest", pull, labels: {"io.open-factory.context-hash": hash, "io.open-factory.built-at": iso}, rm: true, forcerm: true})`. `pull` is `true` by default (upgrading Claude means rebuilding); the CLI's `--no-pull` sets it to `false` for a local-only base (F3; no UI option). When the pull fails the build's error says "Base image <ref> couldn't be pulled. If it's local-only, run `open-factory images build <name> --no-pull`." No `buildargs`, no registry auth, no push (R8). The log records the resolved `FROM` image id (Docker's step output, plus an explicit line with the base's `RepoDigests` after the pull).
- Build output lines are kept in memory: the running build's full log is streamed, and the last result per name (`succeeded | failed`, finished time, error, last 200 lines) is kept until the next build or a server restart (no table, Q13).
- Frames: `image_build {name, state: "building" | "succeeded" | "failed", lines?: string[]}` to all sockets (lines batched every 250 ms), then `images_changed`.

### 10.4 Status (Q14)

Derived on each `GET`, from the folder and the local Docker image (Docker is the only truth for what exists):

| Status | When |
|---|---|
| `no_dockerfile` | the folder has no `Dockerfile` |
| `building` | a build for the name is running |
| `failed` | the last in-memory result failed and no image exists, or the image exists but the failure is newer (shown with the log) |
| `not_built` | no local `open-factory-user/<name>:latest` |
| `out_of_date` | the image's context-hash label ≠ the folder's current hash |
| `built` | otherwise, with `builtAt` from the label |

For registry references a template shows `present` (local image exists) or `pulled_on_start`. Docker unreachable (or any other Docker error, logged at warn): every image whose status needs Docker shows `unknown`, while `no_dockerfile` and `building` still show, since they come from the folder and the builder. Status words and icons are in §12.8.

### 10.5 REST and CLI

- `GET /api/images` → `[{name, status, builtAt?, contextHash?, usedBy: [template names], lastBuild?: {state, finishedAt, error?}}]` for every folder in `images/`.
- `GET /api/images/:name/log` → the running or last build's lines.
- `POST /api/images/:name/build` → `202 {state: "building"}`; with `Accept: application/x-ndjson` the response streams `{line}` objects and ends with `{state, error?}` (the CLI's path). A client disconnect doesn't cancel the build.
- The templates list and detail gain `imageStatus: {kind: "user" | "registry", name, status}`.
- CLI (bearer token from `open-factory login`): `open-factory images` prints a table (name, status, built, used by); `open-factory images build <name> [--no-pull]` streams the log and exits 0 on success, 1 on failure; `--all` builds every folder whose status isn't `built`, one after another. `POST /api/images/:name/build` takes `{pull?: boolean}` (default true).
- `GET /api/images` also returns `{imagesDir, baseImage}` (the absolute folder and `FACTORY_DEFAULT_IMAGE`) so the empty state isn't hard-coded.

## 11. Freshness (Q19)

No new usage frame. The web invalidates usage queries (`["usage", …]`, and the open agent's usage) when an `agent_status` frame for any agent goes from `turnOpen: true` to `turnOpen: false`, debounced to 5 s on the client, and also on every WS reconnect (an edge missed while disconnected). `agent_status` is published to all sockets and, on the `turn_end` path, after `closeTurn` (verified in review); the plan keeps that order for the exit path too. `settings_changed`, `images_changed`, `image_build` and a new `users_changed` (after invite and disable/enable commits) invalidate their sections.

## 12. UI

Follows DESIGN.md (dense, flat plates, sentence case, tabular numerals for every number, status never colour alone, never a tooltip alone, forgiveness over confirmation, validation on blur for longer forms). Revised after the impeccable UI review (U1–U22 in the decision log). Every string is listed in §12.10.

### 12.1 Agent tree

- A right-aligned cost cell in each row (tabular numerals, `ink-muted`, 64px), hidden below `md`. Persistent rows show the spawner total, spawned rows their own; `—` for no turns. The Ended list shows each agent's own 7-day figure.
- The tree has no header row and each row is one link (no interactive elements inside), so there are **no tooltips**: a muted line above the Active tree explains the column, and each cell carries sr-only text (§12.10).

### 12.2 Agent status strip

A segment linking to `/agents/:slug/usage`, always shown (from `md` up): "$4.12 est. · 7d" (the same figure as the agent's tree cell: the spawner total for a persistent agent, its own for a spawned one), or "Usage" when there are no turns; its `aria-label` spells it out.

### 12.3 `/agents/:slug/usage`

- Route `agents.$slug_.usage.tsx`; back link "← @lead" to the session (the S9 pattern); document title "Usage · Lead · Open Factory"; an unknown slug renders `ResourceNotFound`.
- A toolbar row with the range as a native radio group (like the Ended filter): legend "Range", options "7 days", "30 days", "90 days"; URL `?days=` (default 30). While switching, the previous data stays (`placeholderData`).
- **Totals** as a `<dl>`: labels 13px muted, values 14px tabular; only "Estimated cost" is enlarged (Geist 16/20, 600; not Archivo). Then "Turns", and one tokens line. For a persistent agent with spawned usage: "Own $1.20 · spawned $3.40" under the cost. The estimate line (§6) follows. No KPI tiles.
- **Daily** chart (§12.6), with its caption.
- **By model** table (model mono, turns, tokens, Cost (est.)).
- **By task** table (key link, title, turns, Cost (est.)) with the lower-bound note above it.
- **Spawned agents** (persistent only): slug link to its usage page, ended label, turns, Cost (est.).
- States: loading keeps a 160px chart placeholder; empty "No usage in the last {days} days."; error "Couldn't load usage for @lead." with Retry.

### 12.4 Settings

- Order: **Usage, Credentials, Secrets, Projects, Users, Factory**. An "On this page" list at the top (`<nav aria-label="On this page">`, wrapping, not sticky) links `#usage` … `#factory`; the existing hash-focus behaviour extends to them; `days` joins `validateSearch`.
- Errors become **per section** (today one page-wide "Couldn't load settings." would blank all six): each section shows "Couldn't load <section>." with Retry.

**Usage** (`#usage`): the range radio group; h3 "Daily" with the factory chart and caption; the estimate line; h3 "Agents" with a real `<table>` (agent, turns, "Own (est.)", "Spawned (est.)", "Total (est.)"; numbers right-aligned), sorted by total. A persistent agent's spawned children are collapsed behind a disclosure button "Show 3 spawned agents of @lead" (`aria-expanded`); spawned rows leave "spawned" blank. Agents with no usage fold into a final row "8 agents with no usage" with Show. Agent names link to their usage page. Below `md` only the agent and total columns. h3 "Credentials": name, kind, Cost (est.), top agents, rate-limit state (§12.9). If every day is zero the chart is replaced by the empty line; the credentials table stays.

**Credentials** (existing section): each row gains the one-line rate-limit state (§12.9).

**Users** (`#users`): a list of users: name, `@handle` (mono), email, "Joined 19 Nov" (`formatDay`), a "Disabled" label; the current user is marked "(you)". Row menu (`aria-label` "Actions for @alice"): Disable / Enable. Disable is unavailable with a reason in the item for yourself and for the last enabled user. Disable opens the confirmation (crimson button "Disable @alice"); Enable needs none and shows an inline outcome. Below, h3 "Pending invites": "Created by @or · expires in 6 days", Revoke (immediate, inline Undo). Then a "Create invite link" button. The reveal is a read-only mono field that takes focus with its text selected, a Copy button ("Copied." outcome), the shown-once line, and a ghost "Done". The reveal stays until Done or navigation; creating another replaces it.

**Factory** (`#factory`): one form, validated on blur and on Save, server field errors mapped to fields, inline outcome "Saved.":
- "Concurrency cap" (number) with a live "3 of 8 running" from the `supervisor` frame;
- "Default warm window" (number, suffix "min"); its hint always adds "Agents created before this change keep 70 min until re-synced." (no server field to make it conditional);
- "Member-update debounce" (number, suffix "s");
- a read-only row "Local runtime: Not allowed" / "Allowed" with how to change it.
When `settings_changed` arrives while the form is dirty: a notice with Reload.

### 12.5 Task detail

A line in the task's metadata, "Usage: $1.23 est. · 14 turns", with a muted hint under it; hidden when `usage` is null.

### 12.6 The chart (`features/usage/usage-chart.tsx`, hand-rolled SVG, Q17)

- **Colour (F5, Pilot Light Rule):** bars in `--chart-2`; `--signal` only on the selected (hovered or focused) bar; today's partial bar in `--chart-5` with a 1px `--chart-2` outline (the fill alone is about 2:1 on both grounds; the outline gives the 3:1 of WCAG 1.4.11), its tooltip ending "today so far". DESIGN.md → Colors → Semantic gains: "Chart series start at `--chart-2`; `--chart-1` (signal) marks only the focused datum."
- **Scale:** y from 0 to a nice maximum (1/2/5 × 10ⁿ), 3 gridlines with `$` labels; a non-zero bar is at least 1px tall. X labels (`ink-muted`, 12px): every day for 7 days, every 7th day for 30, every 14th day for 90.
- **Keyboard and screen readers:** the wrapper is the single tab stop (`tabIndex=0`, `role="group"`, `aria-label` "Daily estimated cost, last {days} days. Arrow keys move between days."). ←/→ move the selection, Home/End jump, Escape clears. The selected day's tooltip text is mirrored into a polite live region. The SVG is `aria-hidden` and contains nothing focusable; a visually hidden `<table>` carries every day.
- **Pointer and touch:** the hit area is the full column; hover selects, tap selects.
- **Tooltip:** "Thu 20 Nov · $3.21 est. · 41 turns" (no token count: about 90% of it would be cache reads); fades in over 100ms; no motion on keyboard moves; none under reduced motion.
- Resizes with its container (ResizeObserver), min height 160px.

### 12.7 Sign-up and sign-in

`/sign-up?invite=<token>` loads `sign-up-state`. Bootstrap: the form with the first-user line. Valid invite: the form. Missing: the needs-an-invite line with a link to sign in. Invalid: the invalid line. A `403 invite_invalid` on submit shows the invalid line at form level; a `403 invite_required` on a page that loaded as bootstrap shows the lost-race line. Sign-in maps `USER_DISABLED` to the disabled line. Sign-in's "Sign up" link shows only while bootstrap is true.

### 12.8 Templates and Images

- The templates list gains an "Image" column: the status icon and word, plus the image name in mono. The template page shows the same next to `image:`, with a Build button for a user image that isn't `built`. The template editor's `warm_window_minutes` hint: "Omit to use the factory default (70 min)." (with the live value).
- The Templates header gains an "Images" link to `#images`. Section **Images**: one row per folder (name mono, status, built time, "Used by …"), row actions Build / Rebuild and View log (hidden when no log is held). Status icon + word: Building… (`--signal`, live), Build failed (crimson), Out of date (warning), Built (success), Not built and No Dockerfile (muted), Unknown (muted, with the Docker line).
- **Log panel** (inline under the row, opened by a build or View log): `role="log"` with `aria-live="off"` (only state changes are announced, through the row's status), Geist Mono 13px, `pre-wrap`, ANSI stripped, about 20 lines tall, auto-scroll that pauses when the reader scrolls up, with "Jump to latest" while paused, and a Copy button. Success line "Built playwright in 1m 12s."; failure shows "Build failed" plus the error line.
- Empty state with `imagesDir` and `baseImage` from the server; a note under the section: "Agents use a rebuilt image from their next start."

### 12.9 Rate-limit state wording

From §7's derived state: a live pause → "Rate-limited until 14:30" (through the existing `resetPhrase`, hyphenated like `statusLabel`, warning icon); `allowed_warning` → "82% of the 5-hour limit used" with a warning icon (`five_hour` → "5-hour", `seven_day` → "7-day", others passed through; without utilization "Near the 5-hour limit"); within limits → "Within limits · seen 5 minutes ago"; no data → "No rate-limit data yet". Clock times are in the browser's zone; only chart days use the factory zone.

### 12.10 Strings

| Where | String |
|---|---|
| Estimate line | Estimated at API prices. A subscription is billed by plan, not per token. |
| Tree, line above Active | Costs are estimates for the last 7 days. A persistent agent's figure includes the agents it spawned. |
| Tree cell, sr-only | Estimated cost, last 7 days: $4.60 (own $1.20, spawned $3.40) |
| Strip segment / aria-label | $4.12 est. · 7d · Usage / Usage: $4.12 estimated, last 7 days · Usage: no turns in the last 7 days |
| Chart caption | 30 days to today, in Europe/Berlin. |
| Chart tooltip | Thu 20 Nov · $3.21 est. · 41 turns (today: … · today so far) |
| Usage empty | No usage in the last 30 days. |
| Usage errors | Couldn't load usage. · Couldn't load usage for @lead. · Couldn't load users. · Couldn't load factory settings. · Couldn't load images. · Couldn't load credentials. · Couldn't load secrets. · Couldn't load projects. |
| Totals tokens line | Tokens: 1.2M in · 340k out · 2.1M cache write · 18M cache read |
| By-task note | Counts only turns that handled this task's messages and nothing else. Real usage can be higher. |
| Task detail | Usage: $1.23 est. · 14 turns / hint: Counts only turns that handled this task's messages and nothing else. Real usage can be higher. |
| Invite button / reveal | Create invite link · Copy this link now. It isn't shown again. It works for one sign-up within 7 days. · Copied. · Done |
| Invite failure | Couldn't create an invite. Try again. |
| Pending invite row | Created by @or · expires in 6 days |
| Revoke | Revoked the invite from @or. Undo · Couldn't restore the invite: it has expired. |
| Disable confirmation | Disable @alice? They're signed out everywhere and can't sign in. Their 2 pending invites are revoked. You can enable them again later; revoked invites stay revoked. (1: "Their pending invite is revoked." 0: sentence dropped.) Button: Disable @alice |
| Disable unavailable | Disable (that's you) · Disable (last enabled user) |
| Disable errors | You can't disable yourself. · @alice is the last enabled user. Enable someone else first. |
| Enable | Enabled @alice. They can sign in again. |
| Factory hints | Agents that can run at once (1–64). Lowering it never interrupts a turn; idle agents may hibernate sooner. · How long an idle agent stays running before it hibernates (1–1440 min). Templates can set their own with warm_window_minutes. · How long to collect status changes from an agent's reports before telling it (0–86400 s). 0 sends each change at once. |
| Factory errors | Enter a whole number from 1 to 64. (per field bounds) |
| Local runtime row | Local runtime: Not allowed / Allowed · Set FACTORY_ALLOW_LOCAL_RUNTIME on the server and restart to change it. |
| Factory outcome / conflict | Saved. · These settings were changed elsewhere. Reload |
| Sign-up bootstrap | You're the first user of this factory. You'll invite everyone else from Settings → Users. |
| Sign-up missing invite | Sign-up needs an invite link from a member of this factory. |
| Sign-up invalid invite | This invite link isn't valid anymore. Ask a member of this factory for a new one. |
| Sign-up lost race | Someone else just became the first user. Ask them for an invite link. |
| Sign-in disabled | This account is disabled. Ask a member of this factory to enable it. |
| Images empty | No images yet. Add a Dockerfile at {imagesDir}/<name>/Dockerfile, starting FROM {baseImage}. |
| Images note | Agents use a rebuilt image from their next start. |
| Image statuses | Building… · Build failed · Out of date · Built 2 hours ago · Not built · No Dockerfile · Unknown · Present locally · Pulled when missing |
| Docker unreachable | Docker isn't reachable. Check that the daemon is running and the server can reach its socket. |
| Build success | Built playwright in 1m 12s. |
| Rate limits | Rate-limited until 14:30 · 82% of the 5-hour limit used · Near the 5-hour limit · Within limits · seen 5 minutes ago · No rate-limit data yet |

## 13. Security

- **Session-only routes** (R5): agent tokens authenticate only the separate MCP listener (S6), and every REST route plugin already guards itself with `app.addHook("onRequest", requireUser)`. Each new route plugin (`usage`, `settings`, `users` + `invites`, `images`) does the same, in that one place per plugin, never per handler; `/api/agents/:slug/usage` lives in the already-guarded agents plugin. A test per group sends a live agent token and gets `401`.
- **Local runtime** stays an operator decision (Q7): the PATCH schema is strict, so it can't be set over HTTP.
- **Builds run on the host's Docker daemon** (effectively root): only signed-in humans can start one; names are validated and confined to direct children of `images/`; symlinks are never followed out of the folder; no build args, secrets, registry auth or push (R8). `pull: true` on the mutable base tag is consistent with `FACTORY_DEFAULT_IMAGE`'s policy (#41) and logged with the resolved digest.
- **Invites:** 256-bit random tokens, stored hashed, single use, 7-day expiry, revocable, indistinguishable failures; sign-up serialised by the one-process mutex with a DB uniqueness backstop; disabling revokes the user's pending invites.
- **Disable** revokes every session (web and bearer/CLI) and is enforced on every authenticated request and WS upgrade, not only at sign-in.
- **Cost data** is visible to every user (all are admins) and to no agent (Q18).

## 14. Dependencies

`@balena/dockerignore` 1.0.2 and `tar-stream` 2.2.0, both already in the tree through dockerode 5.0.1, become direct dependencies of `apps/server` at exactly those versions (`walkContext` and the context tar). dockerode passes a raw tar stream through unchanged, and `@types/dockerode` 4.0.2 already types `labels` and `pull`. The fake and real `DockerClient` reuse the existing `imageLabel` and gain `buildImage`. Nothing else; no chart library.

## 15. Testing

No automated test calls a live model or a real Docker daemon (the fake `DockerClient` gains `buildImage`, `imageLabels`).

### 15.1 Unit
Usage formatting (`<$0.01`, `—`, token abbreviations); `attributeTask` SQL cases; the mapper's `rate_limit_status` for `allowed`, `allowed_warning`, `rejected` (and `rejected` still emits `rate_limited`); bare-name grammar and resolution; `walkContext` (`.dockerignore`, a link inside packed as a link, a link outside refused, hash stability and sensitivity to content, mode and link target); the settings schema (bounds, strict); invite token hashing; the chart's scale and tick functions.

### 15.2 Server (fake driver, real Postgres)
- **AC 1:** seeded turns; every route equals the reference sum; window edges (`started_at` exactly at the boundary), zero-filled days, a DST day in `America/New_York`, open turns excluded, spawner totals exclude persistent reports, unattributed credential bucket.
- **AC 2:** every case of §5.2 through the runtime: a single task message starts the turn (stamped before close); task plus a system notice (attributed); two tasks; non-task plus task (`NULL`); mid-turn absorb of the same task; a cron turn_end with a batch awaiting (batch unstamped, `NULL`); exit close and boot close (`NULL`).
- **Credential:** `turns.credential_id` for a persistent and a spawned agent; a credential delete leaves turns with `NULL`.
- **Rate limits:** `allowed_warning` updates `rl_*` and pauses nothing; `rejected` still pauses (S5 tests kept); an older event never overwrites a newer one.
- **AC 3, AC 4** with fake timers.
- **AC 5, AC 6:** over a **real listener** (not `inject`): the canonical path and the `/./`, `/x/../`, `%2e`, trailing-slash, `//`, and upper-case variants never create a user without an invite; `user.create.before` refuses any creation without the wrapper's flag (also for zero users); two parallel sign-ups (the mutex serialises them; also a test that the unique backstop rejects a forced double use); `invite_required` vs `invite_invalid`; the hook blocks sign-in of a disabled user; disable deletes bearer sessions (a CLI-style bearer gets `401` afterwards); WS upgrade refused; self and last-user refusals; two admins disabling each other concurrently leave one enabled.
- **Images:** name confinement (`..`, `a/b`, a symlinked folder pointing outside); one build per name (joined); labels written; status table rows; start with a missing user image fails with the `image` fix and never calls `pull`; a registry image still pulls; template validation error for a missing folder.
- **AC 8:** `401` per route group for a live agent token.
- **Disable vs open sockets:** a signed-in socket of the disabled user is closed with 1008 and receives no further frames.
- S3–S9 tests keep passing. Test setup changes: the two removed env vars; config builders without `warmWindowMinutes`; and invite-only sign-up, which affects about 40 test files that call `signUp`/`signUpUser` (`test/helpers.ts`), many of them for a second user. The helpers mint an invite (a direct DB insert of a hashed token) whenever users already exist, so call sites don't change.

### 15.3 CLI
`images` table output; `images build` streams ndjson, exit codes, `--all` order; auth error when logged out.

### 15.4 Web
Tree column, the explanatory line and sr-only cell text; the strip segment; usage page states (loading, empty, data, range in URL); chart keyboard focus and the hidden table; Settings sections (usage tables, users: disable confirmation text with invite count, revoke + Undo, create invite shown once; factory form blur validation and server errors; the read-only local-runtime row); Images section (build, live log, failure, empty); sign-up states (bootstrap, valid, missing, invalid).

### 15.5 Live check (`pnpm smoke:images`, not part of `pnpm test`)
Real Docker and real `claude` on haiku, a throwaway database and `FACTORY_HOME`, the token read from a file at run time (never printed), only real routes:
1. Create `images/smoke/Dockerfile` (`FROM ghcr.io/orlevii/open-factory/base`, pullable, so the default `pull: true` path is exercised; one `RUN` line) and a template `image: smoke`. A second build `FROM open-factory-base:dev` with `--no-pull` checks the local-base path.
2. Start an agent: it fails with the "isn't built" message.
3. `open-factory images build smoke` (CLI, real bearer token): log streams, exit 0, the image has the context-hash label; `GET /api/images` says `built`.
4. Message the agent: it starts on the image (container label `io.open-factory.image` = the user tag) and answers; its turn appears in `/api/agents/:slug/usage` with `credential_id` set.
5. Touch a file in the folder: status `out_of_date`.
The output goes in the PR.

## 16. To verify first

| # | Claim | How | If wrong |
|---|---|---|---|
| V1 | dockerode's `buildImage` accepts a tar stream with `labels` and `pull`, streams JSON progress, and reports a failed `RUN` as an `error` in the stream (not a rejected promise); with `pull: true` a local-only `FROM` fails with a pull error we can recognise (for the `--no-pull` hint). | Plan task 1 against local Docker. | Adapt the stream parser and the error matcher; the API shape is the same. |
| V2 | better-auth 1.7.25: a `databaseHooks.session.create.before` / `user.create.before` that throws `APIError` surfaces that error (code and status) from sign-in / sign-up; an `additionalFields` entry with `input: false` comes back on `getSession` and can't be set by sign-up or update-user. (Review confirmed: returning `false` gives `401 FAILED_TO_CREATE_SESSION`; cookie cache off by default; bearer tokens are `sessions` rows.) | Plan task 1 tests. | Look up `disabled_at` in `getUser` directly (one indexed query); map `FAILED_TO_CREATE_SESSION` for a disabled email to the disabled line. |
| V3 | The `AsyncLocalStorage` store set around `auth.handler()` in the catch-all is visible inside `databaseHooks.user.create.before`. Confirmed in round-2 review with a real better-auth 1.7.25 script (the drizzle adapter runs without a transaction, so no detached context); re-checked by the plan's real-listener test. | Real-listener test. | Pass the flag through a request header that the catch-all strips from client input and sets itself to a per-process random secret, read in the hook from `context.request`; tested for a client-sent copy being stripped and refused. |
| V4 | `agent_status` reaches every socket with `turnOpen: false` after `closeTurn` on the exit path too (verified for `turn_end` in review). | Test (§11). | Move the publish after the write. |
| V5 | `rate_limit_event` `allowed` / `allowed_warning` shapes as the SDK docs describe (`rate_limit_info.status`, `rateLimitType`, `utilization`, `resetsAt`). | A live haiku turn records whatever `rate_limit_event` arrives (one usually does on every turn with OAuth); compare. | Fix the mapper; record the fixture (#43 note). |

## 17. Accepted risks and non-goals

- **Per-task usage is a lower bound** (Q1): mixed turns, work continued after other messages, self-started, crashed and boot-closed turns are missed; the UI says so.
- **Cost is notional on subscriptions** (Q3); labelled "est." everywhere.
- **Old turns are unattributed** for credential and task (no backfill).
- **A failed build's log is lost on restart** (Q13); the status then truthfully reads from Docker.
- **The sign-up mutex assumes one process** (ADR 0013); commented at the mutex.
- **Existing agents keep their snapshot's warm window** (70) until re-synced (Q8).
- **Removing two env vars** is a one-time break for setups that set them; boot warns.
- Non-goals: §3 Out.

## 18. Product doc wording (for the lead; not edited here)

- `architecture/usage-tracking.md`: turns store `task_id` (attributed at a normal close when every delivered non-system message carries the same task; a lower bound) and `credential_id`; rollups are plain queries; cost labelled as an estimate; the latest rate-limit status per credential, including `allowed_warning`; rolling 7-day tree column; days in `FACTORY_TIMEZONE`.
- `architecture/data-model.md`: `turns.task_id`, `turns.credential_id`; `credentials.rl_*`; `factory_settings`; `invites`; `users.disabled_at`.
- `behavior/administration.md` → Settings: section order and anchors; Users (invites, disable/enable, pending invites with Undo); Factory config (three editable fields; local runtime read-only, set by `FACTORY_ALLOW_LOCAL_RUNTIME`; the debounce env var is gone); Usage (chart, per-agent grouped by spawner, credentials with rate-limit state). Templates: the Image column and the Images section.
- `architecture/base-image.md` → User images: a bare `image:` name means `images/<name>/`, tagged `open-factory-user/<name>:latest`, never pulled, built manually (UI or CLI) with `pull: true`; status derived from Docker labels; agents use a rebuild from their next start.
- `concepts/user.md`: invite-only after the first user; disable; no deletion.
- `concepts/agent-template.md`: `warm_window_minutes` optional, default from Settings.
- `roadmap/v0.0.1/s10-usage-admin.md`: "Rollup queries" (no materialized views).

## 19. Issues consumed and follow-ups

Consumed: **#62** (resolved by Q1: stored at close, only-this-task rule, lower bound), **#1** (sign-up closed: invites, bootstrap, disable). Notes: **#47** (S10 makes agent ping-pong visible in usage; no guard added), **#43** (the `allowed`/`allowed_warning` shapes, V5), **#2** (still no password reset; a disabled user can be re-enabled, a forgotten password still can't be reset).

Follow-ups: user deletion (#69); an agent-facing usage tool (#70); persisted image build history (#71); usage export as CSV (#72); a rate-limit history per credential (#73).

## 20. Decision summary

Q1 store `turns.task_id`; attributed only when every delivered non-system message carries the task, normal non-self-started turns only; lower bound (F1, round 2) (3) · Q2 plain SQL (5) · Q3 cost headline labelled est. (3) · Q4 FACTORY_TIMEZONE days, 7/30/90 default 30, page totals = the chart's calendar days (F4) (4); tree rolling 7d (3) · Q5 `turns.credential_id`, latest rate-limit status on credentials (4) · Q6 `factory_settings` only, env vars removed (3) · Q7 local runtime env-only (5) · Q8 optional template warm window, live factory default (3) · Q9 live semantics (4) · Q10 invites, bootstrap, no hatch; checked in the catch-all on the normalized path with an ALS-flag backstop (F2) (4); disable user in S10 (2) · Q11 bare names are user images, missing Dockerfile is an error naming the `docker.io/library/` escape (F6) (4) · Q12 manual builds (4) · Q13 server builds, `pull: true` with CLI-only `--no-pull` (F3), labels not a table (3) · Q14 status per template plus an Images section on Templates (4) · Q15 `/agents/:slug/usage` and Settings → Usage (4) · Q16 spawner total in the tree (3) · Q17 hand-rolled SVG chart, `--chart-2` bars, single tab stop (F5) (3) · Q18 REST/UI only (4) · Q19 reuse `agent_status` turnOpen edge (3) · Q20 users/invites UI, revoke with Undo, disable confirmed (4) · R1–R10 as in the log (4).

## 21. Decisions needing Or's call (owner-proxy certainty ≤ 3/5)

- **Q1** store `turns.task_id` rather than derive at query time (derive-before-store is Or's default); and the strict only-this-task rule (a true lower bound, less coverage) rather than the looser exactly-one-task rule (more coverage, wrong in both directions).
- **Q3** cost (USD, "est.") as the headline even on subscriptions, rather than tokens.
- **Q4** the tree column is a rolling 7 days rather than "today".
- **Q6** the two env vars are removed outright (DB only), rather than kept as first-boot defaults.
- **Q8** the template warm window becomes optional with a live factory default (existing snapshots keep 70).
- **Q10 (2/5)** a minimal disable-user ships in S10 rather than being deferred.
- **Q13** no build table: status from Docker labels, failures in memory only; `--no-pull` on the CLI only (F3).
- **Q16** persistent rows show the spawner total (own + spawned) in the tree, explained by a line above the tree (no tooltips possible).
- **Q17** a hand-rolled SVG chart rather than a chart library.
- **Q19** usage refreshes on the `agent_status` turnOpen edge rather than a dedicated frame.
