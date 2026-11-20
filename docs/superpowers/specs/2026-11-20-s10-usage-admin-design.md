# S10 Usage and Administration: Technical Design

- **Date:** 2026-11-20
- **Status:** approved by owner-proxy (owner-s10); pending the spec self-review, the impeccable UI review and Or's review of the low-certainty items (§21)
- **Roadmap spec:** `docs/product/roadmap/v0.1/s10-usage-admin.md`
- **Product sources of truth:** `docs/product/architecture/usage-tracking.md`, `base-image.md`, `data-model.md`, `agent-runtime.md`; `docs/product/behavior/administration.md`; `docs/product/concepts/credential.md`, `user.md`, `agent-template.md`; ADRs 0013 (one server process), 0019 (usage, no budgets).
- **Builds on:** S1 (better-auth, `requireUser`, sign-up), S3 (`turns`, mapper usage deltas), S4 (templates, credentials, Settings sections), S5 ([spec](2026-11-19-s5-supervisor-docker-design.md): supervisor slot pool, credential rate-limit pauses, image pull on start, container spec hash, the local-runtime gate), S6 (member-update debounce), S7 (spawned agents: `kind = 'ephemeral'`, `reports_to` = spawner, the spawner's credential), S8 ([spec](2026-11-20-s8-tasks-inbox-design.md) §6.7: `messages.task_id`, `delivered_turn_id`), S9 (`FACTORY_TIMEZONE`).
- **Decision log:** the S10 GitHub issue; question numbers below (Q1–Q20, R1–R10) refer to it.
- **Stacked on:** `spec/s9-scheduling` (PR #67) → S8 → … → S3.

> `docs/product/` is gitignored, so the product docs exist only in local checkouts. Paths above are relative to the repo root.

## 1. Goal

Visibility into cost and load, and complete administration:

- **Usage:** per-turn usage (already stored since S3) rolled up per agent, per spawner, per task, per credential and per day; shown in the agent tree, on a per-agent usage page and in Settings with a daily chart; rate-limit state per credential, including the early warning Claude sends before a limit.
- **Administration:** invite-only sign-up with a disable switch (closes #1), factory config editable live in Settings (concurrency cap, default warm window, member-update debounce; local runtime shown read-only), and user Docker images built from `~/open-factory/images/<name>/` with an image status per template.

## 2. Acceptance criteria

From the roadmap, made testable. All run in default CI (fake driver, real Postgres, fake Docker client) unless marked live.

1. **Usage matches stored turns.** For a seeded set of turns across agents, spawned children, tasks, credentials, days and a DST boundary in `FACTORY_TIMEZONE`, every REST rollup (§7) equals a reference sum computed in the test directly from `turns` rows. The tree column, the per-agent page and Settings → Usage render those numbers.
2. **Per-task attribution (#62).** A turn whose delivered messages carry task messages of exactly one task gets `turns.task_id`; a turn with messages of two tasks, or none, gets `NULL`; a turn that absorbs a mid-turn batch of the same task stays attributed; a turn that ends by process exit, and a dangling turn closed at boot, are attributed by the same rule.
3. **Concurrency cap live.** With cap 1 and two agents wanting to run, `PATCH /api/settings/factory {maxRunningAgents: 2}` grants the queued wake without a restart, and the `supervisor` frame reports `max: 2`. Lowering it to 1 stops nobody; the next grant waits until running < 1.
4. **Default warm window and debounce live.** An agent whose template omits `warm_window_minutes` hibernates after the factory default; changing the default changes the next evaluation. A changed debounce applies to the next armed debounce.
5. **Invite-only sign-up.** With zero users, sign-up works without an invite. With one user, sign-up without a valid invite gets `403 invite_required`; with a valid one it succeeds once (a second use, an expired, revoked or unknown token all give the same `403 invite_invalid`). Two concurrent sign-ups on one invite: exactly one user is created. Two concurrent first sign-ups with zero users: exactly one succeeds without an invite.
6. **Disable.** Disabling a user deletes their sessions (cookie and bearer, including a CLI token), revokes their pending invites, makes every authenticated REST call and WS upgrade with their old token fail with `401`, and blocks a new sign-in. You can't disable yourself or the last enabled user. Enable restores sign-in.
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
- invites, `users.disabled_at`, the wrapped sign-up route, disable/enable; Settings → Users; sign-up page changes;
- user images: name resolution, the build service, the context hash, start without pull, image status per template, the Templates page's Images section, the CLI `open-factory images` and `open-factory images build`;
- a live check `pnpm smoke:images`.

**Out (decided):** budgets or caps on cost (ADR 0019 unchanged); materialized views or rollup tables (Q2); a per-agent "current task" (Q1 C); a rate-limit history table (Q5); env-var fallbacks for the two removed variables (Q6); a UI toggle for the local runtime (Q7); auto-builds on start or on change (Q12); a `user_images` table and persisted build history (Q13); a charting library (Q17); an agent-facing usage tool or usage in `get_task` (Q18); a new WS frame for usage (Q19); user deletion, password reset (#2), email-locked invites, an open-sign-up escape hatch (Q10); build args, secrets, registry credentials or pushing images (R8); stacking the chart by agent; CSV export.

## 4. Architecture

```
harness mapper ── usage, rate_limit_status, rate_limited ──► AgentRuntime
                                                             │ turn open: turns.credential_id
                                                             │ turn close (turn_end, exit, boot): usage + task_id (§5.2)
                                                             │ rate_limit_status → CredentialStore.recordRateLimit
                                                             ▼
                                                           turns ◄── UsageService (plain SQL, §7) ◄── /api/usage/*, /api/agents/:slug/usage, task detail
                                                                                                    ▲
web: tree column, /agents/:slug/usage, Settings → Usage ── invalidate on agent_status turnOpen true→false (5 s debounce)

Settings → Factory ── PATCH /api/settings/factory ──► FactorySettings (row + in-memory copy) ──► live getters:
                                                       supervisor.max (re-run grants, `supervisor` frame), runtime warm window, debounce

/sign-up ── POST /api/auth/sign-up/email (our wrapper, in-process mutex) ──► invite check → better-auth → mark invite used
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

- **Credential at turn open.** `openTurn(agentId, credentialId)` writes the credential the running process was started with (the runtime keeps it from the start; for a spawned agent that is the spawner's credential, already on its row since S7).
- **Task at turn close.** One function, `attributeTask(turnId, tx)`, runs inside every close path: `closeTurn` on `turn_end`, the close on process exit (`agent-runtime.ts`'s exit path), and boot's `closeDanglingTurns`. It sets
  `task_id = (SELECT min(task_id) FROM messages WHERE delivered_turn_id = $turn AND task_id IS NOT NULL HAVING count(DISTINCT task_id) = 1)`.
  It runs at close, not at delivery, because a turn absorbs mid-turn batches (S6) whose rows get the same `delivered_turn_id`. Non-task messages in the turn don't disqualify it. A turn later continued after an unrelated wake is not attributed: per-task usage is a **lower bound**, worded "turns started by this task's messages".
- **Usage deltas** are unchanged (S3 mapper: `model_usage_since_last_result`, or cumulative differences).

### 5.3 Rate-limit status (Q5, R3)

The mapper emits `{type: "rate_limit_status", status, rateLimitType, utilization?, resetsAt?}` for **every** `rate_limit_event`. Only `status: "rejected"` additionally emits the existing `rate_limited` event, which alone pauses the credential (S5); the code keeps that boundary in one `switch` with a comment. The runtime writes `rate_limit_status` to the credential's `rl_*` columns (an `UPDATE … WHERE id = $cred AND (rl_observed_at IS NULL OR rl_observed_at <= $now)`) and does not append it to the session timeline. The S5 pause (`rate_limited_until`) stays the source of truth for "paused". `allowed_warning` and `rejected` shapes are from SDK docs (#43 is still open); the fixture is labelled unverified until observed.

## 6. Usage semantics

- **Headline: cost in USD, always labelled "est."** (Q3, R4) with the tooltip "API-equivalent estimate. Subscription usage is billed by plan, not per token." Tokens appear in the detail views: input, output, cache write, and cache read listed separately. Format: `$12.34`; a non-zero amount under a cent is `<$0.01`; no turns is `—`.
- **Windows** (Q4): the tree column is a rolling 7 days (header "7d"). The usage page and Settings → Usage offer 7 / 30 / 90 days, default 30, as `?days=` in the URL. Totals use the rolling window `started_at >= now() - days`; the chart buckets turns by day in `FACTORY_TIMEZONE` (`date_trunc('day', started_at AT TIME ZONE $tz)`), for the last `days` calendar days including today. The zone is named under the chart ("Days in Europe/Berlin").
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

## 8. Factory settings (Q6–Q9, R7)

### 8.1 Storage

A single-row table `factory_settings (id smallint PRIMARY KEY CHECK (id = 1), max_running_agents int NOT NULL DEFAULT 8, default_warm_window_minutes int NOT NULL DEFAULT 70, member_update_debounce_seconds int NOT NULL DEFAULT 30, updated_at, updated_by text REFERENCES users(id))`, inserted by the migration. **`FACTORY_MAX_RUNNING_AGENTS` and `FACTORY_MEMBER_UPDATE_DEBOUNCE_SECONDS` are removed** from `config.ts`, `.env.example`, compose files and docs, with no shim (Q6); the PR's release note says so, and boot logs a warning when either is still set ("… is no longer read; set it in Settings → Factory"). That warning is the only trace; nothing reads the value. `FACTORY_ALLOW_LOCAL_RUNTIME` stays env-only (Q7).

### 8.2 Live reads

`FactorySettings` loads the row at boot and keeps an in-memory copy; `update()` writes the row and then swaps the copy (one process, ADR 0013). Consumers take getters, not values:
- **Supervisor:** `max` becomes `() => settings.maxRunningAgents`. After an update the supervisor runs its grant loop once (raising the cap grants queued wakes at once, FIFO) and publishes the existing `supervisor {running, max}` frame. Lowering it stops nobody; grants wait until `running < max`.
- **Debounce:** `AgentRuntime` reads `memberUpdateDebounceMs` through a getter at each arm; an armed debounce keeps its due time.
- **Warm window:** `warm_window_minutes` becomes optional in `templateYamlSchema` (no default) and `templateConfigSchema`; the parsed config omits it when the template does. The runtime uses `config.warmWindowMinutes ?? settings.defaultWarmWindowMinutes` at each warm-timer evaluation, and the update triggers an evaluation on every live runtime. Existing agent snapshots that already hold 70 keep it until re-synced (no rewriting of stored snapshots); the template editor's hint says "Omit to use the factory default (70 min)".

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

Our Fastify route `POST /api/auth/sign-up/email`, registered before the `/api/auth/*` catch-all, wraps better-auth's handler:

1. Acquire the process-wide `signUpMutex` (comment: "Correct only because the factory is one server process (ADR 0013); a multi-instance deployment must replace this with a Postgres advisory lock.").
2. If `users` has rows: require `invite` in the body (`403 invite_required` when absent) and check it (§9.2). With zero users the invite is not needed (bootstrap).
3. Forward the request without the `invite` field to better-auth (S1's handle hook still runs).
4. On a 2xx, mark the invite used (`used_at`, `used_by` = the new user id) in a guarded `UPDATE … WHERE used_at IS NULL RETURNING`; `invites.used_by UNIQUE` is the backstop. A non-2xx leaves the invite unused.
5. Release the mutex.

`GET /api/auth/sign-up-state?invite=` (public) returns `{bootstrap: boolean, invite: "valid" | "invalid" | "missing"}` for the sign-up page. The sign-in page keeps its "Sign up" link only when `bootstrap` is true.

### 9.4 Disable and enable

- `POST /api/users/:id/disable`: refuse `409 cannot_disable_self` and `409 last_enabled_user`. In one transaction: lock the enabled users (`FOR UPDATE`, so two admins disabling each other can't leave zero), set `disabled_at`/`disabled_by`, delete all of the user's `sessions` rows (cookie sessions and bearer tokens are both rows; the CLI token is a bearer), revoke their pending invites. Response includes the count of revoked invites.
- `POST /api/users/:id/enable` clears `disabled_at`; it does not restore invites.
- **Enforcement on every request:** `getUser` reads `disabled_at` through a better-auth `additionalFields` entry (`disabledAt`, `input: false`) that comes back with `getSession`, and returns `null` when it is set (so `requireUser` gives `401` and the WS upgrade is refused). better-auth's cookie cache stays off (it is off today), so a deleted session is gone at once. `databaseHooks.session.create.before` returns `false` for a disabled user, so no sign-in method can create a session.
- `GET /api/users` lists `{id, name, handle, email, createdAt, disabledAt}`. Disabled users keep their handle, inbox rows and authorship (no deletion; follow-up issue).

## 10. User images (Q11–Q14, R8)

### 10.1 Names and resolution

- A template `image:` that is a **bare name** (`^[a-z0-9][a-z0-9_.-]{0,62}$`, so no `/`, `:` or `@`) names the user image in `<FACTORY_HOME>/images/<name>/`. Anything else stays a registry reference (S5 behaviour, pulled when missing).
- A bare name whose folder has no `Dockerfile` is a template **validation error** ("No image folder images/playwright/ with a Dockerfile."), so the template can't be used. The template scan reads `images/` (directory listing only) when it validates.
- **Start:** `resolveImage(ref)` returns `{kind: "user", tag: "open-factory-user/<name>:latest"}` or `{kind: "registry", ref}`. A user image is never pulled: when the tag is missing locally the start fails with `AgentStartError("Image playwright isn't built. Build it in Templates → Images, or run open-factory images build playwright.", "image")`. `"image"` joins the `StartFix` union and the shared `error.fix` enum; the UI links it to `/templates#images`. The container spec hash already includes the image id, so an agent picks up a rebuilt image at its next container start (no forced restart, Q13).

### 10.2 The context walk and hash

One function `walkContext(dir)` serves both the hash and the tar, so they always agree:
- `name` must match the bare-name grammar, and `realpath(images/<name>)` must be a direct child of `realpath(images/)` (`400 invalid_image_name` otherwise).
- Walk the folder, honouring `.dockerignore` (the `@balena/dockerignore` matcher Docker's own semantics are ported to, or an equivalent already in the tree; the plan picks one and pins it, §14).
- A symlink is packed **as a link** (its target string), never followed. A link whose target resolves outside the image folder fails the build with "images/playwright contains a link outside the folder: <path>".
- Hash: sha256 over, for each entry in sorted relative-path order, `path \0 type \0 (file bytes | link target) \0 mode`.

### 10.3 The builder

`ImageBuilder.build(name)`:
- At most one build per name: a second request joins the running one (same promise and log stream).
- `docker.buildImage(tarStream, {t: "open-factory-user/<name>:latest", pull: true, labels: {"io.open-factory.context-hash": hash, "io.open-factory.built-at": iso}, rm: true, forcerm: true})`. No `buildargs`, no registry auth, no push (R8). The log records the resolved `FROM` image id (Docker's "Step 1/…" output, plus an explicit line with the base's `RepoDigests` after the pull).
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

For registry references a template shows `present` (local image exists) or `pulled_on_start`. Docker unreachable: every image shows `unknown` with "Docker isn't reachable." Status words in the UI: "No Dockerfile", "Building…", "Build failed", "Not built", "Out of date", "Built <relative time>", "Present locally", "Pulled on first start".

### 10.5 REST and CLI

- `GET /api/images` → `[{name, status, builtAt?, contextHash?, usedBy: [template names], lastBuild?: {state, finishedAt, error?}}]` for every folder in `images/`.
- `GET /api/images/:name/log` → the running or last build's lines.
- `POST /api/images/:name/build` → `202 {state: "building"}`; with `Accept: application/x-ndjson` the response streams `{line}` objects and ends with `{state, error?}` (the CLI's path). A client disconnect doesn't cancel the build.
- The templates list and detail gain `imageStatus: {kind: "user" | "registry", name, status}`.
- CLI (bearer token from `open-factory login`): `open-factory images` prints a table (name, status, built, used by); `open-factory images build <name>` streams the log and exits 0 on success, 1 on failure; `--all` builds every folder whose status isn't `built`, one after another.

## 11. Freshness (Q19)

No new usage frame. The web invalidates usage queries (`["usage", …]`, and the open agent's usage) when an `agent_status` frame for any agent goes from `turnOpen: true` to `turnOpen: false`, debounced to 5 s on the client. The plan verifies that frame is sent after `closeTurn` has committed (if not, it moves the publish after the write). `settings_changed`, `images_changed`, `image_build` and a new `users_changed` (after invite and disable/enable commits) invalidate their sections.

## 12. UI

Follows DESIGN.md (dense, flat plates, sentence case, tabular numerals for every number, status never colour alone, forgiveness over confirmation, validation on blur for longer forms). Strings below are final unless the UI review changes them.

### 12.1 Agent tree

A right-aligned "7d" column (tabular numerals, `ink-muted`, 64px). Persistent rows show the spawner total; spawned rows their own. The header's tooltip: "Estimated cost, last 7 days. A row includes the agents it spawned." A persistent row with spawned usage has a tooltip "Own $1.20 · spawned $3.40". `—` for no turns. On mobile (below `md`) the column is hidden. The Ended list shows each agent's own 7-day figure.

### 12.2 Agent status strip

A new segment "$4.12 est. · 7d" linking to `/agents/:slug/usage` (hidden when `—`).

### 12.3 `/agents/:slug/usage`

Page header "Usage · <display name>" with a back link to the session and the 7d/30d/90d segmented control (URL `?days=`). Then:
1. **Totals strip:** cost est. (large), turns, input, output, cache write, cache read (labelled numbers in one row; wraps on mobile). For a persistent agent with spawned usage: "Own $x · spawned $y" under the cost.
2. **Daily chart** (§12.6).
3. **By model** table (model, turns, tokens, cost).
4. **By task** table (key link, title, turns, cost), headed "Tasks", with the note "Counts turns started by a task's messages; work continued after other messages isn't included."
5. **Spawned agents** (persistent only): slug link, ended state, turns, cost.
Empty: "No usage in the last 30 days."

### 12.4 Settings

Settings gains three sections; the order becomes **Usage, Credentials, Secrets, Projects, Users, Factory**, with an "On this page" anchor list at the top (`#usage`, …, `#factory`; the existing hash-focus behaviour extends to them).
- **Usage:** range control; the daily chart (factory-wide); the per-agent table (columns: agent, turns, own, spawned, total; persistent agents with their spawned children collapsed under them, expandable; sorted by total desc); the credentials table (name, kind, cost, top agents, rate-limit state). Rate-limit state wording: "Rate limited until 14:30" (a `warning` dot plus the label, from the S5 pause), "Near limit: 82% of 5-hour" (`allowed_warning`), "OK" with the observed time, or "No data yet".
- **Credentials:** each row gains the same one-line rate-limit state.
- **Users:** a list (name, `@handle` mono, email, "Joined <date>", a "Disabled" label), row menu Disable / Enable; Disable opens a confirmation "Disable @alice? They're signed out everywhere, can't sign in, and their 2 pending invites are revoked." with button "Disable @alice". Below: "Pending invites" (created by, expires in, Revoke with inline Undo) and "Create invite", which reveals the link once in a read-only field with Copy and "Shown once. It works for one sign-up within 7 days."
- **Factory:** one form, fields validated on blur and on Save: "Concurrency cap" (number, "Agents that can run at once. Lowering it stops nobody; agents finish and hibernate."), "Default warm window" (minutes, "For templates that don't set warm_window_minutes."), "Member-update debounce" (seconds); a read-only row "Local runtime: Off" with "Set FACTORY_ALLOW_LOCAL_RUNTIME on the server and restart to change it." Save shows the inline outcome "Saved"; server field errors map to fields.

### 12.5 Templates

- The list gains an "Image" column with the status word (and the image name in mono). The template page shows the same next to `image:`, with a "Build" button for a user image that isn't `built`.
- A second section **Images** (`#images`) on the Templates page: one row per folder (name mono, status, built time, used by), row actions Build / Rebuild and View log. A running build expands an inline log panel (Geist Mono 13px, auto-scroll that pauses when the reader scrolls up, last 200 lines). Failed: "Build failed" + the error line + View log. Empty: "No images yet. Add a Dockerfile at ~/open-factory/images/<name>/Dockerfile, starting FROM ghcr.io/orlevii/open-factory/base." A note under the section: "Agents use a rebuilt image from their next start."

### 12.6 The chart

A hand-rolled SVG bar chart (`components/usage-chart.tsx`): one series (`--chart-1`), one bar per day, a y-axis with 3 gridlines and `$` labels, x labels every 7th day (`ink-muted`, 12px), tabular numerals. Hover and keyboard focus (bars are focusable via roving tabindex, arrow keys move) show a tooltip "Thu 20 Nov · $3.21 est. · 41 turns · 1.2M tokens". A visually hidden `<table>` carries the same data for screen readers; the SVG is `aria-hidden`. Resizes with its container (ResizeObserver), min height 160px. No animation beyond the tooltip's fade (reduced motion: none).

### 12.7 Sign-up

`/sign-up?invite=<token>` loads `sign-up-state`. Bootstrap: the form, with the line "You're the first user of this factory." Valid invite: the form. Missing: "Sign-up needs an invite link from a member of this factory." with a link to sign in. Invalid: "This invite link isn't valid anymore. Ask a member of this factory for a new one." A `403` on submit shows the same line at form level.

## 13. Security

- **One session-only guard** (R5): a Fastify plugin `humansOnly` registered on the route groups `/api/usage`, `/api/settings`, `/api/users`, `/api/invites`, `/api/images` (and the new `/api/agents/:slug/usage`) applies `requireUser`; agent tokens never authenticate the REST API (S6), and a test per group sends a live agent token and gets `401`.
- **Local runtime** stays an operator decision (Q7): the PATCH schema is strict, so it can't be set over HTTP.
- **Builds run on the host's Docker daemon** (effectively root): only signed-in humans can start one; names are validated and confined to direct children of `images/`; symlinks are never followed out of the folder; no build args, secrets, registry auth or push (R8). `pull: true` on the mutable base tag is consistent with `FACTORY_DEFAULT_IMAGE`'s policy (#41) and logged with the resolved digest.
- **Invites:** 256-bit random tokens, stored hashed, single use, 7-day expiry, revocable, indistinguishable failures; sign-up serialised by the one-process mutex with a DB uniqueness backstop; disabling revokes the user's pending invites.
- **Disable** revokes every session (web and bearer/CLI) and is enforced on every authenticated request and WS upgrade, not only at sign-in.
- **Cost data** is visible to every user (all are admins) and to no agent (Q18).

## 14. Dependencies

A `.dockerignore` matcher (`@balena/dockerignore` or equivalent), pinned exactly at a release older than the repo's `minimumReleaseAge`, used only by `walkContext`. `tar-stream` (or `tar-fs` without `dereference`) for the context, pinned the same way; the plan checks which is already in the tree via dockerode first. Nothing else; no chart library.

## 15. Testing

No automated test calls a live model or a real Docker daemon (the fake `DockerClient` gains `buildImage`, `imageLabels`).

### 15.1 Unit
Usage formatting (`<$0.01`, `—`, token abbreviations); `attributeTask` SQL cases; the mapper's `rate_limit_status` for `allowed`, `allowed_warning`, `rejected` (and `rejected` still emits `rate_limited`); bare-name grammar and resolution; `walkContext` (`.dockerignore`, a link inside packed as a link, a link outside refused, hash stability and sensitivity to content, mode and link target); the settings schema (bounds, strict); invite token hashing; the chart's scale and tick functions.

### 15.2 Server (fake driver, real Postgres)
- **AC 1:** seeded turns; every route equals the reference sum; window edges (`started_at` exactly at the boundary), zero-filled days, a DST day in `America/New_York`, open turns excluded, spawner totals exclude persistent reports, unattributed credential bucket.
- **AC 2:** every case of §5.2 through the runtime (one task; two tasks; non-task plus task; mid-turn absorb; exit close; boot close).
- **Credential:** `turns.credential_id` for a persistent and a spawned agent; a credential delete leaves turns with `NULL`.
- **Rate limits:** `allowed_warning` updates `rl_*` and pauses nothing; `rejected` still pauses (S5 tests kept); an older event never overwrites a newer one.
- **AC 3, AC 4** with fake timers.
- **AC 5, AC 6:** concurrency via two parallel `inject` calls (the mutex serialises them; also a test that the unique backstop rejects a forced double use); `invite_required` vs `invite_invalid`; the hook blocks sign-in of a disabled user; disable deletes bearer sessions (a CLI-style bearer gets `401` afterwards); WS upgrade refused; self and last-user refusals; two admins disabling each other concurrently leave one enabled.
- **Images:** name confinement (`..`, `a/b`, a symlinked folder pointing outside); one build per name (joined); labels written; status table rows; start with a missing user image fails with the `image` fix and never calls `pull`; a registry image still pulls; template validation error for a missing folder.
- **AC 8:** `401` per route group for a live agent token.
- S3–S9 tests keep passing (the config removals change test setup that passed the two env vars).

### 15.3 CLI
`images` table output; `images build` streams ndjson, exit codes, `--all` order; auth error when logged out.

### 15.4 Web
Tree column and tooltips; usage page states (loading, empty, data, range in URL); chart keyboard focus and the hidden table; Settings sections (usage tables, users: disable confirmation text with invite count, revoke + Undo, create invite shown once; factory form blur validation and server errors; the read-only local-runtime row); Images section (build, live log, failure, empty); sign-up states (bootstrap, valid, missing, invalid).

### 15.5 Live check (`pnpm smoke:images`, not part of `pnpm test`)
Real Docker and real `claude` on haiku, a throwaway database and `FACTORY_HOME`, the token read from a file at run time (never printed), only real routes:
1. Create `images/smoke/Dockerfile` (`FROM` the dev base, `RUN apt-get install -y jq`-style one-liner, already present tools are fine) and a template `image: smoke`.
2. Start an agent: it fails with the "isn't built" message.
3. `open-factory images build smoke` (CLI, real bearer token): log streams, exit 0, the image has the context-hash label; `GET /api/images` says `built`.
4. Message the agent: it starts on the image (container label `io.open-factory.image` = the user tag) and answers; its turn appears in `/api/agents/:slug/usage` with `credential_id` set.
5. Touch a file in the folder: status `out_of_date`.
The output goes in the PR.

## 16. To verify first

| # | Claim | How | If wrong |
|---|---|---|---|
| V1 | dockerode's `buildImage` accepts a tar stream with `labels` and `pull`, streams JSON progress, and reports a failed `RUN` as an `error` in the stream (not a rejected promise). | Plan task 1 against local Docker. | Adapt the stream parser; the API shape is the same. |
| V2 | better-auth 1.7.25: `databaseHooks.session.create.before` returning `false` blocks sign-in with a clean error; an `additionalFields` entry with `input: false` comes back on `getSession` and can't be set by sign-up or update-user. | Plan task 1 tests. | Look up `disabled_at` in `getUser` directly (one indexed query) and block sign-in in the `hooks.before` middleware for `/sign-in/email`. |
| V3 | Registering `POST /api/auth/sign-up/email` before the `/api/auth/*` wildcard takes precedence in Fastify and the forwarded request still passes S1's hook. | Route test. | Do the invite check inside the existing catch-all, keyed on the path. |
| V4 | The `agent_status` frame with `turnOpen: false` is published after `closeTurn` commits. | Read and test (§11). | Move the publish after the write. |
| V5 | `rate_limit_event` `allowed` / `allowed_warning` shapes as the SDK docs describe (`rate_limit_info.status`, `rateLimitType`, `utilization`, `resetsAt`). | A live haiku turn records whatever `rate_limit_event` arrives (one usually does on every turn with OAuth); compare. | Fix the mapper; record the fixture (#43 note). |

## 17. Accepted risks and non-goals

- **Per-task usage is a lower bound** (Q1): turns that continue a task after unrelated wakes aren't counted; the UI says so.
- **Cost is notional on subscriptions** (Q3); labelled "est." everywhere.
- **Old turns are unattributed** for credential and task (no backfill).
- **A failed build's log is lost on restart** (Q13); the status then truthfully reads from Docker.
- **The sign-up mutex assumes one process** (ADR 0013); commented at the mutex.
- **Existing agents keep their snapshot's warm window** (70) until re-synced (Q8).
- **Removing two env vars** is a one-time break for setups that set them; boot warns.
- Non-goals: §3 Out.

## 18. Product doc wording (for the lead; not edited here)

- `architecture/usage-tracking.md`: turns store `task_id` (attributed at close when the turn's delivered messages carry exactly one task; lower bound) and `credential_id`; rollups are plain queries; cost labelled as an estimate; the latest rate-limit status per credential, including `allowed_warning`; rolling 7-day tree column; days in `FACTORY_TIMEZONE`.
- `architecture/data-model.md`: `turns.task_id`, `turns.credential_id`; `credentials.rl_*`; `factory_settings`; `invites`; `users.disabled_at`.
- `behavior/administration.md` → Settings: section order and anchors; Users (invites, disable/enable, pending invites with Undo); Factory config (three editable fields; local runtime read-only, set by `FACTORY_ALLOW_LOCAL_RUNTIME`; the debounce env var is gone); Usage (chart, per-agent grouped by spawner, credentials with rate-limit state). Templates: the Image column and the Images section.
- `architecture/base-image.md` → User images: a bare `image:` name means `images/<name>/`, tagged `open-factory-user/<name>:latest`, never pulled, built manually (UI or CLI) with `pull: true`; status derived from Docker labels; agents use a rebuild from their next start.
- `concepts/user.md`: invite-only after the first user; disable; no deletion.
- `concepts/agent-template.md`: `warm_window_minutes` optional, default from Settings.
- `roadmap/v0.1/s10-usage-admin.md`: "Rollup queries" (no materialized views).

## 19. Issues consumed and follow-ups

Consumed: **#62** (resolved by Q1: stored at close, exactly-one-task rule, lower bound), **#1** (sign-up closed: invites, bootstrap, disable). Notes: **#47** (S10 makes agent ping-pong visible in usage; no guard added), **#43** (the `allowed`/`allowed_warning` shapes, V5), **#2** (still no password reset; a disabled user can be re-enabled, a forgotten password still can't be reset).

Follow-ups (new issues): user deletion; an agent-facing usage tool (managers seeing their spawns' cost); persisted image build history; usage export (CSV); a rate-limit history if near-limit trends turn out to matter.

## 20. Decision summary

Q1 store `turns.task_id`, exactly-one-task rule, lower bound (3) · Q2 plain SQL (5) · Q3 cost headline labelled est. (3) · Q4 FACTORY_TIMEZONE days, 7/30/90 default 30 (4); tree rolling 7d (3) · Q5 `turns.credential_id`, latest rate-limit status on credentials (4) · Q6 `factory_settings` only, env vars removed (3) · Q7 local runtime env-only (5) · Q8 optional template warm window, live factory default (3) · Q9 live semantics (4) · Q10 invites, bootstrap, no hatch (4); disable user in S10 (2) · Q11 bare names are user images, missing Dockerfile is an error (4) · Q12 manual builds (4) · Q13 server builds, `pull: true`, labels not a table (3) · Q14 status per template plus an Images section on Templates (4) · Q15 `/agents/:slug/usage` and Settings → Usage (4) · Q16 spawner total in the tree (3) · Q17 hand-rolled SVG chart (3) · Q18 REST/UI only (4) · Q19 reuse `agent_status` turnOpen edge (3) · Q20 users/invites UI, revoke with Undo, disable confirmed (4) · R1–R10 as in the log (4).

## 21. Decisions needing Or's call (owner-proxy certainty ≤ 3/5)

- **Q1** store `turns.task_id` rather than derive at query time (both use the same rule; derive-before-store is Or's default).
- **Q3** cost (USD, "est.") as the headline even on subscriptions, rather than tokens.
- **Q4** the tree column is a rolling 7 days rather than "today".
- **Q6** the two env vars are removed outright (DB only), rather than kept as first-boot defaults.
- **Q8** the template warm window becomes optional with a live factory default (existing snapshots keep 70).
- **Q10 (2/5)** a minimal disable-user ships in S10 rather than being deferred.
- **Q13** no build table: status from Docker labels, failures in memory only.
- **Q16** persistent rows show the spawner total (own + spawned) in the tree.
- **Q17** a hand-rolled SVG chart rather than a chart library.
- **Q19** usage refreshes on the `agent_status` turnOpen edge rather than a dedicated frame.
