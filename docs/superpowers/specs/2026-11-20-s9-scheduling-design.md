# S9 Scheduling: Technical Design

- **Date:** 2026-11-20
- **Status:** approved by owner-proxy (owner-s9), revised after the spec self-review and the impeccable UI review (round 1, R1–R5 in the decision log); pending Or's review of the low-certainty items (§22)
- **Roadmap spec:** `docs/product/roadmap/v0.1/s09-scheduling.md`
- **UI design:** [`docs/superpowers/designs/2026-11-20-s9-scheduling-ui-design.md`](../designs/2026-11-20-s9-scheduling-ui-design.md)
- **Product sources of truth:** `docs/product/concepts/schedule.md`, `message.md`, `agent.md`; `docs/product/behavior/administration.md`, `agents-and-sessions.md`; `docs/product/architecture/agent-runtime.md`, `harness-driver.md`, `factory-mcp.md`, `data-model.md`, `context-assembly.md`, `system-overview.md`, `tech-stack.md`; ADRs 0008, 0016, 0019; `docs/product/open-questions.md` (S0 cron findings, S4–S8 corrections).
- **Builds on:** S3 (cron events in the mapper, `originKind: "cron"`), S5 ([spec](2026-11-19-s5-supervisor-docker-design.md): the in-memory cron pin set, one hibernate path, wake reasons, `ERRORED_WAKES`, notices, boot reconciliation, rate-limit pauses), S6 ([spec](2026-11-19-s6-messaging-reporting-design.md): agent listener, tokens, router, truthful senders, `groupEnvelopes` escaping, commit-then-hand-off), S7 ([spec](2026-11-19-s7-spawning-design.md): per-caller tool lists, termination transaction, lock order, the Reaper), S8 ([spec](2026-11-20-s8-tasks-inbox-design.md): direct-message kinds, `T-<n>` keys, lock-order header, race tests on `pg_stat_activity`).
- **Decision log:** #64 ("S9 Scheduling: design decisions"); the question numbers below (Q1–Q23, R1–R5) refer to it.
- **Stacked on:** `spec/s8-tasks-inbox` (PR #63) → S7 (#58) → S6 (#53) → S5 (#46) → S4 (#37) → S3 (#27).

> `docs/product/` is gitignored, so the product docs exist only in local checkouts. Paths above are relative to the repo root.

## 1. Goal

Timed work without idle heartbeats. Two kinds of timer, with honest semantics:

- **Factory schedules** (durable): a cron expression or a one-shot time, a target agent and a message. They survive hibernation, factory restarts and reboots, and arrive as `scheduled` messages from `@scheduler`. A firing that is still undelivered is replaced, never stacked.
- **Harness crons** (in-session, Claude Code's `CronCreate`): process-local, so they die with the process. The factory already tracks them and pins the agent warm while any is live (S5); S9 shows them, lets a human stop them, and tells agents which kind to use.

## 2. Acceptance criteria

From the roadmap, made testable. Every AC is proven in default CI with the fake driver and fake timers, agent actions through the real MCP over HTTP with real tokens; ACs 1–3 again by the live check (§17.5).

1. **A weekday cron fires, wakes, survives a restart.** A human creates `0 9 * * 1-5` in `Europe/Berlin` to hibernated `@ceo`. At 09:00 Berlin on a weekday the scheduler writes one `scheduled` row; `@ceo` wakes (reason `scheduled`) and its first batch carries `<factory-message from="@scheduler" kind="scheduled" … schedule="S-1" by="@or" due="2026-11-23T09:00:00+01:00">`. The server is stopped across 09:00 the next day and started at 11:40: the schedule fires once at boot with `late="true"`, and its next run is the following weekday 09:00.
2. **Harness crons pin.** An agent whose stream reports `CronCreate("*/5 * * * *")` is not hibernated past its warm window; after `CronDelete` it hibernates when the window ends. "Stop crons" in the UI hibernates a pinned, idle agent at once, with the `crons_stopped` notice waiting for its next wake (it does not wake it).
3. **No stacking.** Three firings of a schedule while its target is errored leave **one** pending row with `firings = 3` and the schedule's current body; nothing starts a recovery attempt.
4. **Agent tools and bounds.** A persistent agent calls `schedule_message` (default target itself), `list_schedules` and `cancel_schedule`; `*/5 * * * *` from an agent is refused with the 15-minute sentence; a 21st schedule is refused; cancelling a human's schedule is refused naming who can. A spawned agent's tool list has none of the three. A live agent token on every `/api/schedules*` route gets `401`.
5. **Lifecycle.** Terminating a target deletes its schedules in the termination transaction; firings to an archived target are skipped and resume (without catch-up) after unarchive; a termination racing a firing ends in one of the outcomes of §12.2 (race test).
6. **Time zones.** Unit tests pin DST behaviour for `Europe/Berlin` and `America/New_York` (§7.2) and the UI preview shows the next 3 runs in the schedule's zone.
7. CI is green; the live check has been run on its early slice and at the end, and its output plus a manual pass through the Schedules page and the cron popover is recorded in the PR.

## 3. Scope

**In:**
- `schedules` table; keys `S-<n>`; a `Scheduler` service with a durable `next_run_at` and one in-process timer (no pg-boss, Q1);
- the `scheduled` message kind, the envelope attributes `schedule`, `by`, `due`, `firings`, `late`; replace-not-stack;
- the `ScheduleService`: create, edit, pause, resume, delete, restore, the agent limits, the lifecycle rules for ended agents;
- MCP tools `schedule_message`, `list_schedules`, `cancel_schedule` for persistent agents only (Q12);
- human REST `/api/schedules*` and a `schedules_changed` frame;
- harness crons: the live list on the agent status, "Stop crons" (reason `crons_stopped`, a passive notice), the `durable` flag kept on `cron_created`;
- the generated CLAUDE.md's Scheduling section, and `scheduled` in "How messages reach you";
- UI (UI doc): the Schedules page, create/edit page, the session's `scheduled` badge, the strip's cron popover with Stop crons, the strip's schedules link;
- the live check `pnpm smoke:scheduling` and an early harness-cron probe.

**Out (decided):** pg-boss, and moving the S6 debounce or the S7 Reaper onto the new timer (Q2; #57 gets a note); a `harness_crons` table (Q5); schedules addressed to humans; edit or pause tools for agents (Q11); schedule tools for spawned agents (Q12); a cron describer such as cronstrue or a visual cron builder (Q21); per-cron "ask the agent to delete" (Q13); CLI commands (#48 untouched); scheduled compaction (#26 untouched); purging deleted or done schedules.

## 4. Architecture

```
agent ──MCP──► Agent listener ──► FactoryMcp (3 schedule tools, persistent agents only)
                                     │
humans (REST, session auth) ─────────┼──► ScheduleService ── validate, limits, lock order §12 ── schedules rows
                                     │         │ after commit: scheduler.rearm(), bus: schedules_changed
                                     │         ▼
                                     │    Scheduler (one timer at min(next_run_at), ≤ 60 s)
                                     │      tick: due ids → one transaction per schedule:
                                     │        lock target agent → lock schedule (NO KEY UPDATE SKIP LOCKED) → advance
                                     │        next_run_at → insert or replace the pending `scheduled` row
                                     │      after commit: runtimes.deliver(row, "agent", "scheduled") (after bootDone)
                                     ▼
AgentRuntime ── crons (S5 set) ── status: crons[] ── POST /api/agents/:slug/stop-crons → stopCrons()
```

| Unit | Location | Owns |
|---|---|---|
| `cron.ts` | `packages/shared/src/cron.ts` | Pure: parse/validate a 5-field cron (croner), `nextRuns(expr, zone, after, n)`, `minGap(expr, zone, n)`, zone validation via `Intl`, the shared Zod schemas. Used by server and web. |
| `parseKey` | `packages/shared/src/keys.ts` | `T-`/`S-` keys, generalised from S8's `parseTaskKey`/`taskKey` (which become thin wrappers) (Q16). |
| `ScheduleStore` | `apps/server/src/scheduling/schedule-store.ts` | SQL for `schedules` and the `scheduled` rows; every call inside a transaction takes `tx`; the lock-order header (§12). Excludes `deleted_at` rows in one place (Q17). |
| `ScheduleService` | `apps/server/src/scheduling/schedule-service.ts` | Create, edit, pause, resume, delete, restore, list; limits; authorship; `recomputeFromNow` (the one helper for resume, undo and unarchive, Q19). |
| `Scheduler` | `apps/server/src/scheduling/scheduler.ts` | The timer, the tick, the firing transaction, catch-up, hand-off; injected `now()`. |
| schedule tools | `apps/server/src/mcp/tools/schedule-tools.ts` | Schemas, caller identity, results (§9). |
| routes | `apps/server/src/routes/schedules.ts` | Human REST (§11). |

S3–S8 rules stay: nothing outside `apps/server/src/mcp/` imports the MCP SDK; nothing outside `packages/harness/src/claude/` knows a stream-json field; a transaction never awaits a runtime call (rows are committed, then handed over and never awaited); every hand-off waits for `bootDone`; agent text is escaped by `groupEnvelopes` only.

**Why not pg-boss (Q1).** The two rules that matter, replace-not-stack and fire-once catch-up, are ours whichever engine runs the clock; pg-boss's cron doesn't catch up missed minutes. It would add a second schema, polling workers and maintenance to wrap one column and one timer. The factory is one Node process; `FOR NO KEY UPDATE SKIP LOCKED` keeps the firing correct even if that ever changes. The product docs drop pg-boss (§20).

## 5. Data model (`packages/db`), one migration

```
CREATE SEQUENCE schedule_number_seq;
schedules   id text pk, number integer not null unique default nextval('schedule_number_seq'),
            target_agent_id text not null references agents(id),
            cron text null, run_at timestamptz null,              -- exactly one (CHECK num_nonnulls = 1)
            timezone text not null,                               -- IANA, validated in the service
            body text not null,                                   -- markdown, ≤ 64 KB
            created_by_agent_id text null references agents(id),  -- exactly one creator (CHECK)
            created_by_user_id  text null references users(id),
            body_author_agent_id text null references agents(id), -- exactly one body author (CHECK, Q18)
            body_author_user_id  text null references users(id),
            next_run_at timestamptz null,                         -- null: a one-shot whose time came (done) or deleted
            last_fired_at timestamptz null,                       -- set only when a row was written (not on an archived skip)
            fail_count integer not null default 0, retry_at timestamptz null, -- firing backoff (§8.1 step 4)
            paused_at timestamptz null, deleted_at timestamptz null,
            created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  index schedules_due_idx on (next_run_at) where deleted_at is null and paused_at is null and next_run_at is not null
  CHECK (run_at IS NULL OR cron IS NULL); CHECK (num_nonnulls(cron, run_at) = 1); CHECK (num_nonnulls(created_by_agent_id, created_by_user_id) = 1); CHECK (num_nonnulls(body_author_agent_id, body_author_user_id) = 1)
  index schedules_target_idx on (target_agent_id) where deleted_at is null
  index schedules_creator_idx on (created_by_agent_id) where deleted_at is null and created_by_agent_id is not null

messages    + schedule_id text null references schedules(id),
            + author_agent_id text null references agents(id), + author_user_id text null references users(id),
            + due_at timestamptz null, + firings integer null, + late boolean null
  unique index messages_schedule_pending_idx on (schedule_id, to_agent_id) where state = 'pending' and schedule_id is not null
```

- **Derived state, no status column (Q15, Q9, D3):** `deleted` = `deleted_at` set; `paused` = `paused_at` set; `done` = a one-shot (`run_at` set) with `next_run_at` null, not deleted (R5): it ran when `last_fired_at` is set, and "didn't run" when its time came while the target was archived (`last_fired_at` null); otherwise active. "Skipped" (target archived) and "Waiting" (a pending row while the target is errored) are derived at read time from the target's row and runtime status.
- **The `messages` CHECK** gains one branch and every earlier branch gains `schedule_id IS NULL AND author_agent_id IS NULL AND author_user_id IS NULL AND due_at IS NULL AND firings IS NULL AND late IS NULL`:
  `kind = 'scheduled' AND from_user_id IS NULL AND from_agent_id IS NULL AND notice IS NULL AND subject_agent_id IS NULL AND task_id IS NULL AND comment_id IS NULL AND to_agent_id IS NOT NULL AND to_all_humans = false AND schedule_id IS NOT NULL AND num_nonnulls(author_agent_id, author_user_id) = 1 AND due_at IS NOT NULL AND firings IS NOT NULL AND firings >= 1 AND late IS NOT NULL` (`firings >= 1` alone accepts NULL: found in review on Postgres 18).
  The row carries its author because the schedule's `body_author` can change after the firing (Q18: a pending row stays as fired). A migration test inserts every S3–S8 row shape and the new one, and rejects the wrong shapes (S8's V3 technique).
- **The partial unique index** is the database's guarantee of "at most one pending firing per schedule and target": the replace path updates that row; a concurrent insert fails with `23505` instead of stacking (§8.2).
- `agents.pinned_crons` (data-model doc) is not added: pins are live process state (Q5).
- `bootWakes`' deliverable kinds gain `scheduled`; the `crons_stopped` notice is excluded (`kind = 'system' AND notice <> 'crons_stopped'`, §10.3).
- **Boot clears stale write marks:** reconciliation runs `UPDATE messages SET delivered_event_seq = NULL, delivered_turn_id = NULL WHERE state = 'pending' AND delivered_event_seq IS NOT NULL` before `bootWakes`. Today only the exit rollback (`markPending`) clears them, so after a server crash a row written to a not-yet-started process keeps its seq forever, and §8.2 would then never replace it (review finding: a human Restart of an errored target, a crash, boot's `failCutShortAttempts` re-errors it, and every later firing would write nothing). At that point no runtime is loaded and the Scheduler hasn't started; a process that couldn't be reaped may still run, which is harmless: the row stays pending and is re-sent.

## 6. Factory schedules

### 6.1 Fields and validation (one Zod schema per input in `packages/shared`, used by REST and MCP)

| Field | Rule |
|---|---|
| `cron` | Exactly one of `cron`/`at`. Plain Vixie cron (R3): exactly five whitespace-separated fields (minute hour day-of-month month day-of-week), each made of numbers, `*`, ranges, lists, steps, month names (`jan`) or day names (`mon`), day-of-week 0–7; checked by our own pre-validation before croner, which otherwise accepts seconds and year fields, `@nicknames`, `L`, `W`, `#` and `?` (all refused: "Use 5 fields: minute hour day-of-month month day-of-week." / "Only numbers, *, ranges, lists, steps and names are allowed."). Parsed by croner in its default mode (day-of-month and day-of-week are ORed as in Vixie cron; verified). Must have a next occurrence (`0 0 30 2 *` is refused: "This pattern never runs."). Field errors are croner's message rewritten as one sentence naming the field. |
| `at` | ISO 8601 date-time. With an offset it is that instant; without one it is read in `timezone` (a wall time that doesn't exist that day, 02:30 on the spring-forward night, is read as 03:30, the instant the same offset arithmetic gives: unlike a cron, which runs at 03:00; pinned in tests). Must be in the future (no grace: "That time has passed."). |
| `timezone` | IANA name accepted by `Intl.DateTimeFormat` (checked in the Zod refine); unknown → "Unknown time zone 'Mars/Base'; use an IANA name such as Europe/Berlin." Default: the UI sends the browser's zone; MCP uses `FACTORY_TIMEZONE` (§7.1). |
| `body` | 1 byte to 64 KB (S6's message cap), markdown. |
| `to` (MCP) / `target` (REST) | A live agent (persistent or spawned; a spawned target's schedules are deleted when it is terminated): slug, `@slug` or (MCP) `me`. Not archived, not terminated, not a human, not `@humans`, not a reserved name. S6's `resolveName` and its sentences. |

### 6.2 Agent limits (Q10; enforced in `ScheduleService`, so every path is covered)

Apply when an **agent** creates a schedule (and to `cron`/`at` an agent writes; agents have no edit tool, so that is creation only). Humans have none of them (Q18: a human tightening an agent's schedule is the human's call).

- **20** schedules per creating agent, counting every schedule it created that is not deleted and not done (paused ones count, Q19). Refusal: "You already have 20 schedules; cancel one first (list_schedules shows them)."
- **15 minutes** minimum gap for an agent's `cron`: the smallest gap between consecutive occurrences among the next 10 after now, in the schedule's zone, must be ≥ 15 minutes. Refusal: "Schedules can't fire more often than every 15 minutes. For a short loop inside this session, use CronCreate." (A DST shift can make one real gap shorter, e.g. `0 2,3 * * *` on a fall-back night; the check uses the next 10 occurrences only, accepted.)
- **One year** (366 days, so a date one calendar year out is never refused) horizon for an agent's `at`: "Pick a time within the next year."
- Constants in one module (`scheduling/limits.ts`), like S7's; not settings.

### 6.3 Creation, edit, pause, resume, delete, restore

- **Create:** writes the row with `created_by` and `body_author` = the actor, computes `next_run_at` (first occurrence strictly after now, or `at`), commits, re-arms the timer, publishes `schedules_changed`.
- **Edit (humans, Q18):** `PATCH` carries only changed fields, and only those are validated (so a done or near-due one-shot's message can be edited). Changing `cron`/`at`/`timezone` recomputes `next_run_at` from now (switching between cron and at included). Changing `body` sets `body_author` to the editor. Changing `target` re-checks the new target is live. A pending firing stays exactly as fired (old body, old target, old author); the next firing replaces it (§8.2). Editing a done one-shot's `at` to a future time makes it active again. `created_by` never changes.
- **Pause / resume (humans, Q19):** pause sets `paused_at`; a pending row is left alone. Resume clears it and calls `recomputeFromNow` (no catch-up).
- **Delete:** sets `deleted_at` (and `next_run_at` null). Humans get an inline Undo (UI); agents' `cancel_schedule` is the same soft delete (Q17). A pending row of a deleted schedule stays pending and is delivered (it was fired).
- **Restore (Undo):** re-checks the target is live (R2: a schedule deleted because its target was terminated can't come back: `409 target_ended`, "@x was terminated."), clears `deleted_at` and calls `recomputeFromNow`; a one-shot whose `at` has passed is restored as done. Allowed for humans only; the agent limit is not re-checked (a human acted). Every other mutation of a deleted schedule (edit, pause, resume) answers `404 schedule_not_found`.
- **`recomputeFromNow(schedule)`** (also clears `fail_count`/`retry_at`, as every human edit does, body and target included): `next_run_at` = first occurrence strictly after now (cron), or `run_at` if still in the future, else null (done). The one helper behind resume, restore, unarchive and timing edits, so "no catch-up" lives in one place.

## 7. Time

### 7.1 Zones (Q4)

Every schedule stores its IANA zone; all instants are `timestamptz`. `FACTORY_TIMEZONE` (env, validated at boot with the same zone check; default the server's resolved zone `Intl.DateTimeFormat().resolvedOptions().timeZone`, or `UTC` if that is undefined) is the MCP default and is named in the generated CLAUDE.md ("Schedules use Europe/Berlin unless you pass `timezone`"): stable config, so the file stays deterministic. The UI shows the zone next to every schedule time.

### 7.2 DST (croner, verified while designing on 11.0.0)

- A wall time that doesn't exist that day (02:30 on the spring-forward night) fires at the next valid time (03:00), once.
- A **single** fixed wall time that occurs twice (`30 2 * * *` on the fall-back night) fires once, at the first occurrence.
- A list, range or step that hits the repeated hour fires at **both** repeats: `*/30 * * * *` and `0,30 2 * * *` run at 02:00 and 02:30 CEST and again at 02:00 and 02:30 CET; `0 2,3 * * *` likewise (verified in review on 11.0.0, Berlin 2026-10-25).
Unit tests pin these, and the `at` reading of §6.1, for `Europe/Berlin` and `America/New_York` at the 2026 transitions, so a croner upgrade that changes them fails CI.

### 7.3 The clock

The `Scheduler` takes `now()` (injected; tests use fake timers plus that clock), and every query it runs passes that instant as a parameter, never Postgres `now()`. The timer is armed for `min(coalesce(retry_at, next_run_at))` over active schedules, **at least 1 s ahead** after a tick that made no progress (so a stuck row can never hot-loop, §8.1 step 4) and **clamped to at most 60 s**, so a wall-clock jump, a laptop sleep or a missed re-arm is corrected within a minute; it is re-armed after every tick and after every committed change (`rearm()`), and armed once at start (Q1 condition b). One tick at a time: a tick that is running when the timer fires again is not overlapped; the next tick follows it.

## 8. Firing

### 8.1 The tick

1. Read due ids and their `target_agent_id` without locks: `next_run_at <= $now AND (retry_at IS NULL OR retry_at <= $now) AND paused_at IS NULL AND deleted_at IS NULL`, oldest first, at most 100 per tick (the rest fire on the immediately following tick).
2. For each, one transaction (§12 order):
   1. Lock the **target agent row** `FOR SHARE` (the target read in step 1, unlocked).
   2. Lock the schedule `FOR NO KEY UPDATE SKIP LOCKED` (never `FOR UPDATE`, S7's rule); re-read it; if it is no longer due (edited, paused, deleted meanwhile) or its `target_agent_id` is no longer the agent locked in 2.1 (retargeted meanwhile), skip: it is re-read on the next tick.
   3. Compute: `due` = the latest occurrence ≤ now (croner `previousRuns(1, now + 1 ms)`, so an occurrence exactly at now counts; a one-shot: `run_at`); `missed` = the number of occurrences in `[next_run_at, now]` (counted by stepping, capped at 1,000; a one-shot: 1); `late` = `now − due > 60 s`. Advance `next_run_at` to the first occurrence strictly after now (a one-shot: null); clear `fail_count`/`retry_at`.
   4. **Target ended:** terminated → cannot happen (its schedules were deleted with it, §10.1), but if read, delete the schedule. **Archived** → write no row and leave `last_fired_at` unchanged (Q9, R5); the schedule stays; that is the whole firing.
   5. Otherwise set `last_fired_at = now` and insert or replace the pending row (§8.2).
3. After each commit: hand the row to `runtimes.deliver(row, "agent", "scheduled")` (§8.4) (after `bootDone`, skipped once shutdown has begun, never awaited inside a transaction, `.catch`ed and logged: S8's rule); publish `schedules_changed`.
4. A transaction that fails (deadlock `40P01`, serialization) is retried once from step 2.1. A second failure (or any other error: a constraint, a bug) is logged and, in its own statement, sets `fail_count + 1` and `retry_at = now + min(5 s × 2^min(fail_count, 4), 60 s)` (computed in TypeScript, never `power()` in SQL), so a broken row is retried at most once a minute and never spins the tick. Nothing is lost: claim, advance and message write are one transaction (Q20).

### 8.2 Replace, never stack (Q6)

"Undelivered" means the `scheduled` row is still `pending`: messages to a running agent are written to stdin at once (mid-turn included), so a firing finds a pending row only while its target is hibernated and queued, starting, errored, rate-limited, stopping, held behind an urgent hold or a compact in flight, or while a batch to a not-yet-started process awaits confirmation.

- If a pending row of this schedule to this target exists (locked `FOR NO KEY UPDATE`, found through its partial unique index), it is **updated in place**: `body` and author = the schedule's current body and `body_author`, `due_at` = this occurrence, `firings = firings + missed`, `late` = this firing's late flag, `created_at` unchanged (its queue position is kept). Otherwise a row is inserted with `firings = missed`.
- The pending row may already be written to a process that hasn't started yet (S5's `inFlight`: written, not confirmed, still `pending`). The transaction can't ask the runtime (no runtime call in a transaction), so it reads the row's own state: a written row has its `delivered_event_seq` set (S6 §11). The firing therefore distinguishes three cases on the locked pending row: none → insert; `delivered_event_seq IS NULL` → replace as above; `delivered_event_seq` set → **write nothing** (the agent is about to read that row; this firing coalesces into it). The partial unique index makes a fourth case (two pending rows) impossible. This is the accepted coalescing race of Q6, made explicit.
- **What was delivered is what the row says** (review finding). The runtime renders a batch from its in-memory entries, sends it, and only then commits `delivered_event_seq`; and a hand-off job can queue behind a start job that writes the older entry. So a replacement can land between rendering and the batch's commit. Two rules make the row truthful anyway:
  1. `writeBatch`'s transaction writes the **rendered** `body`, author, `due_at`, `firings` and `late` of every `scheduled` row in the batch back onto its row (`UPDATE … WHERE id = $id`), in the same transaction that sets `delivered_event_seq`. The row then records exactly what the agent read; a replacement that landed in the window is coalesced into it (Q6's accepted race: the agent read one firing fewer than happened, never more).
  2. `flush()` re-reads the batch's `scheduled` rows (`pendingRow(id)`) just before `toEnvelopes`, so a stale entry (loaded by `init()`, or a hand-off queued behind a slow start job) renders the row's current content; rule 1 then only covers a replacement committed between that read and the batch's commit (the accepted window). A row that is no longer pending at that read (rejected by a termination) is dropped from the batch.
  3. The runtime's queued entry is also refreshed on hand-off, **monotonically**: `deliver` for an id the runtime has already seen and still queues re-reads the row (`pendingRow(id)`, inside the runtime job) and replaces the entry's row only if the stored `firings` is higher (an older hand-off arriving after `init()` loaded a newer version never regresses it), instead of returning early; if the re-read finds no pending row (written meanwhile, or rejected), it returns as today for a seen id. A seen id that is no longer queued (already written) returns as today.

### 8.3 Catch-up (Q3)

Boot is not special: after `bootDone` the Scheduler starts, and its first tick finds every schedule whose `next_run_at` passed while the factory was down. Each fires **once**, coalescing its missed occurrences (`firings` = missed), with `late = true` and `due` = the latest missed occurrence; then `next_run_at` moves to the next future occurrence. A one-shot that passed fires once, late. Laptop sleep is the same case (the 60 s clamp catches it). **Fallback if Or prefers skipping (P15):** step 2.3 would write no row when `late` is true for a recurring schedule: one branch and one test, added only if Or flips Q3 (no off switch ships).

### 8.4 Delivery (Q8)

Scheduled rows are **direct messages** (S6's queue, not the held list): `ORDER.scheduled = 1` with messages and task rows in created order (the replaced row keeps its `created_at`, so its place); they wake a hibernated target with the new wake reason **`scheduled`** through the cap and FIFO; wait out rate-limit pauses; are written mid-turn like any message; are never urgent. `scheduled` is **not** in `ERRORED_WAKES`: to an errored target the row stays pending (replaced on every firing) and never starts a recovery attempt, whoever created the schedule (the sender at fire time is `@scheduler`; no human is watching, Q8). "Start a new session" (a human action) still starts with queued scheduled rows (S8's accepted rule). The hand-off uses the existing agent path, `runtimes.deliver(row, "agent", "scheduled")` (no new sender kind). `entryOf` and `senderLabel` render a `scheduled` row as `@scheduler` (today a sender-less non-message row becomes `@factory`). The joined `PendingRow` gains the schedule key, the schedule's zone and the author's slug or handle.

### 8.5 The envelope (Q7)

```
<factory-message from="@scheduler" kind="scheduled" urgent="false" id="m_8f2" schedule="S-3" by="@or" due="2026-11-23T09:00:00+01:00" firings="3" late="true">
Morning review: open tasks, blockers, what shipped.
</factory-message>
```

- `from` is always `@scheduler`; `by` is the row's author (`@handle` for a human, the bare slug for an agent), read from the row's author columns, never from tool input. `due` is the row's `due_at` rendered as ISO 8601 with the schedule zone's offset at that instant (stored on the row as the zone name at firing time is not needed: the offset is computed from `schedule.timezone` when the row is read; a later zone edit therefore changes how a still-pending row's `due` renders, accepted). `firings` only when > 1; `late` only when true. The rendering is a pure function of the joined row (the row plus its schedule's key and zone and its author's name, S6), so the same rows render the same bytes.
- The body is the author's text verbatim, through `groupEnvelopes`' escaping (the one owner); every attribute through `attr()`. Rows of one schedule are never merged (one pending row per schedule anyway).
- The CLAUDE.md line (§10.4) tells the agent the body was written by `by` and is weighed like that author's own messages.

## 9. The MCP tools (Q10–Q12)

Registered **per caller**, only for **persistent** agents (S7's per-caller list; spawned agents never see them, Q12). Identity always comes from the token. Results are one text block of compact JSON; errors one sentence saying what to do (S8 style). Keys accept `S-3`, `s-3` or `3`.

| Tool | Behaviour |
|---|---|
| `schedule_message(body, cron?, at?, timezone?, to?)` | Exactly one of `cron`/`at` ("Pass either cron or at."). `to` defaults to the caller (`me` accepted). §6.1 validation, §6.2 limits. Returns `{id: "S-3", to, cron?|at?, timezone, next_run: "<ISO with offset>", note?}`; `note` when the target is errored ("@x is errored; it will see this when a human restarts it.") or is the caller and is a recurring schedule ("You will be woken at each run; cancel it with cancel_schedule when it is no longer needed."). |
| `list_schedules()` | The caller's own schedules (created by it) and those targeting it, not deleted and not done, newest first, at most 100: `{id, to, created_by, by, cron?|at?, timezone, next_run, paused, yours: boolean, body, truncated?}`. Bodies are returned as JSON-escaped data (S8 rule), capped at 2,000 characters each with `truncated: true`. |
| `cancel_schedule(id)` | Only schedules the caller created: otherwise "S-3 was created by @or; only its creator or a human can cancel it." Unknown or deleted: "There is no schedule S-3." Returns `{id, status: "cancelled"}`; a pending firing is still delivered. |

The tool descriptions say: schedules survive restarts and wake the target; use `CronCreate` instead for a short loop inside this session.

## 10. Lifecycle and harness crons

### 10.1 Ended and errored agents (Q9)

| Interaction | Rule |
|---|---|
| Target terminated | S7's termination transaction soft-deletes every schedule targeting the agent (after its agent locks, §12). Pending scheduled rows are rejected like every pending row (S7). Soft, not hard (R2): delivered `scheduled` rows reference their schedule (`schedule_id` is required by the CHECK), so the terminated agent's read-only session keeps its badges; Restore refuses (`409 target_ended`). |
| Creator terminated | Not reachable: spawned agents can't create schedules (Q12) and persistent agents are archived, never terminated. Kept as an assertion in the service test. |
| Target archived | Firings skip (no row, `next_run_at` advances, `last_fired_at` unchanged). The UI shows "Skipped" with "@x · archived". Creating, retargeting or restoring to an archived agent is refused. |
| Target unarchived | `AgentService.unarchive` (which has no transaction today) gets one: lock the agent row `FOR NO KEY UPDATE`, clear `archived_at`, `recomputeFromNow` every schedule targeting it (agents before schedules), commit, then `runtimes.refresh` before `scheduler.rearm()`: no catch-up. A firing in the millisecond between the commit and the refresh reaches a runtime that still thinks the agent is archived and is rejected (accepted). |
| Creator archived (persistent) | Its schedules keep firing; the UI shows "created by @x (archived)". |
| Target errored | Rows stay pending and are replaced; no recovery (§8.4); UI state "Waiting" with "@x · errored". |
| Target rate-limited, hibernated, queued at the cap, starting | Rows wait / wake through the normal paths; replacement applies while pending. |
| Target mid-turn | Written at once and absorbed at the next tool boundary (S6). |
| Apply-restart, hibernate, restart, crash | Pending rows are durable; the firing timer is independent of the target's process. |
| Server stops between commit and hand-off | The row is pending; `bootWakes` (now counting `scheduled`) wakes the target; S6's seen-id set prevents a double write (test, Q20). |
| Server stops mid-firing (before commit) | Nothing was written; `next_run_at` is unchanged; it fires at boot (late if > 60 s). |
| Shutdown begun | The Scheduler is stopped first (`scheduler.stop()` next to `reaper.stop()`, before `runtimes.close()`): no new tick; a tick in progress finishes its current transaction and its hand-offs are skipped (`Router.closed` rule); the onClose hook then `await scheduler.idle()` before the database closes (as `reaper.idle()`). |
| Before `bootDone` | The Scheduler isn't started (it starts right after `router.bootDone()`, next to the Reaper). `rearm()` before `start()` or after `stop()` is a no-op (REST and MCP calls can arrive earlier: the agent listener is up before reconciliation). |
| Token of an exited or ended process | `401` at the listener. A terminated caller already past the listener: the service re-checks the caller is live in the transaction ("You can't schedule messages: you were terminated." — only reachable through a race, since spawned agents don't have the tools). |

### 10.2 Harness crons: what S9 adds to S5 (Q5)

S5 already keeps the live set per process (`cron_created`/`cron_deleted`, one-shots dropped after their firing turn, the 7-day expiry timer, `runtime_journal.crons`, the pin, the "N crons" count). S9 adds, with **no table**:

- `LiveCron` keeps `durable` (from `tool_use_result.durable`, mapped onto `cron_created` as an optional field) and the agent status (summary and `agent_status` frame) gains `crons: {cronId, humanSchedule, recurring, durable, nextFireAt?, expiresAt?}[]` (empty when none); `nextFireAt` only for one-shots (a recurring cron's `nextFireAt` is the first firing, never updated: S0 gives no later value), `expiresAt` only for recurring ones; `waitingOn.crons` stays the count. The agent summary also gains `cronZone`, the zone Claude's process runs in and writes `humanSchedule` in: `UTC` for Docker agents (the base image sets no `TZ`, and S9 passes none) and the server's resolved zone for local agents, so the UI can say so when it differs from the viewer's. (Passing `TZ=FACTORY_TIMEZONE` into containers would align them; not done in S9, to keep the runtime env unchanged.)
- **Apply-restart keeps S5's rule (Q5b, S5 Q17, #38):** it doesn't wait for crons (a revoked grant or credential must stop applying; a pin can last 7 days); the restart-crons notice names each lost cron by its schedule text so the agent can recreate it, and the manager gets `work_lost`. This closes #31.

### 10.3 Stop crons (Q13)

`POST /api/agents/:slug/stop-crons` (human, session auth) → `runtime.stopCrons(byHandle)` in a runtime job:

| Runtime state at the call | Result |
|---|---|
| No process, or no live crons | `409 no_crons` ("@x has no crons."); the UI treats it as done. |
| Archived, terminated | S5/S7's refusals. |
| A hibernate for `apply_changes` already under way | The stop takes it over, as shutdown takes over a running hibernate: the reason becomes `crons_stopped`, the notice is added, no `restart_crons` notice is added; the exit's wake for the queued restart still happens only for non-passive items. `200 {status: "stopped"}`. |
| Any other stop under way (restart, terminate, shutdown, a dead or failing process, `stop_failed`) | `409 stopping` ("@x is already stopping; its crons stop with it."). |
| Idle (no open turn, no batch awaiting, no live non-ambient task, no owed notification, no compact in flight, no urgent hold) | Stops now: in this job, add the notice (text from the crons live **now**) and `beginHibernate("crons_stopped")`. `200 {status: "stopped"}` (the busy row below answers `{status: "pending"}`). |
| Busy, errored-with-a-process, attempting a recovery, rate-limited with a process, restart pending | Sets `stopCronsPending` (`by` kept); the stop's trigger is apply-restart's: the first moment the agent is not `busy()` (the pin and `restartPending` don't count), it stops as in the idle row, in that job (the warm window is not waited for). |

- **Stop wins over a pending apply-restart:** (with nothing else queued the agent then stays hibernated, and the new configuration applies at its next start, like any hibernated agent's) when `stopCronsPending` is set, `maybeRestart` doesn't run; the stop's exit then wakes the agent only if non-passive items are queued, which delivers the restart as S5's apply-restart does (its new process reads the new config), and the `restart_crons` notice is **not** added (its "Recreate them" would contradict the stop).
- Crons created while the stop is pending are stopped too (the notice lists what is live at the stop). If the crons reach 0 before the stop (deleted, fired, expired), `stopCronsPending` is cleared and `maybeRestart()` runs (a restart it held back goes ahead). A server shutdown or an exit clears it (the crons die anyway). The status frame carries `stopCronsPending`.
- `beginHibernate` S5's way (close stdin, bounded wait, SIGTERM); `hibernated{reason: "crons_stopped", by: "@or"}` and `background_work_lost{reason: "crons_stopped", by: "@or", crons}` gain an optional `by` (the enum and `HibernateReason` gain `crons_stopped`), so the UI never parses prose.
- **The `crons_stopped` notice** (from `@factory`): "@or stopped your crons: every 5 minutes; at 14:30, once. Don't recreate them unless you are asked to." It is a **passive notice**, by one predicate `isPassive(entry)` (a `system` row with notice `crons_stopped`) used everywhere a queue item counts as a reason to act: `hasDeliverable`, the `queued_items` wake after an exit, the Reaper's `reapable()` (so a passive notice never keeps a spawned agent alive), `flush()` (a passive notice alone is never written; it rides at the head of the next batch with something else; a compact queued behind a passive-only head goes ahead of it, since flush otherwise cuts a batch at the first non-message entry), and `deliverableWhere` for `bootWakes`. `reportLostWork` gains an explicit exclusion for `crons_stopped` next to `archived`. A second Stop before the next wake replaces it (S5's one-pending-notice-per-type rule).
- `background_work_lost` with reason `crons_stopped` is **not forwarded** to the manager (Q13: a human did it in the open); every other reason keeps S6's forwarding.
- Spawned agents: the same action (their crons pin them too; S7's Reaper already skips cron-pinned agents).

### 10.4 `durable: true` crons (Q14)

The factory context says never to use `durable` (use `schedule_message`). A durable cron is pinned like any other while live. Whether a durable job fires again after `--resume` is unverified (S0); the early live check (§18 V2) settles it. **Named fallback if it does:** before every start, the runtime deletes `<workdir>/.claude/scheduled_tasks.json`, the path resolved by the factory from the agent's own working directory (never from the model or the event stream), through `SafeFs` (no link following), logged with the agent slug, so no cron outlives a process. The result is recorded in open-questions.md either way.

### 10.5 The generated CLAUDE.md (§ context assembly item 3)

"How messages reach you" gains the kind `scheduled` and: "`@scheduler` delivers scheduled messages: `schedule` names the schedule, `by` who wrote the text (weigh it as a message from them), `due` when it was due; `firings` says how many runs it stands for while you were away, `late` that it was delayed (the factory was down)." A **Scheduling** section, deterministic (the zone and the limits come from config/constants):

- Persistent agents: "- For a short loop inside this session (checking a build every few minutes), use `CronCreate` (or `/loop`); it keeps you awake while it runs and stops when your process stops (a restart or a human can stop it). Never pass `durable: true`." "- For anything that must survive restarts or happen later (a daily review, a reminder next week), use `mcp__factory__schedule_message` with a 5-field `cron` or an `at` time; it wakes the target. Schedules use Europe/Berlin unless you pass `timezone`." "- Your schedules can't fire more often than every 15 minutes, and you can have at most 20; `list_schedules` and `cancel_schedule` manage them. Cancel schedules you no longer need: each run costs a turn."
- Spawned agents: only the `CronCreate` bullet (they have no schedule tools).

## 11. Human REST API (session auth; agent tokens get `401`)

| Route | Behaviour |
|---|---|
| `GET /api/schedules?target=<slug>&done=true` | Not deleted; done one-shots only with `done=true`; ordered active (by `next_run_at`), then paused (by `next_run_at`), then done (`coalesce(last_fired_at, run_at)` newest first), then key, at most 500; the UI keeps this order. Each item: `key, target {slug, displayName, archived, terminated}, cron?, at?, timezone, body, nextRunAt, lastFiredAt, paused, done, createdBy, bodyAuthor, pendingFiring, state` where `createdBy` and `bodyAuthor` are `{kind: "agent", slug, archived, terminated} | {kind: "user", handle}`, and `state` ∈ `active | paused | done | skipped_archived | pending_errored` (derived; `pending_errored` when a pending row exists and the target's runtime status is errored; `done` items carry `ran: boolean`). |
| `GET /api/schedules/:key` | One schedule (the edit page). |
| `POST /api/schedules` | Create (§6.1); `201` with the item. |
| `PATCH /api/schedules/:key` | Edit (§6.3); fields absent are unchanged. |
| `POST /api/schedules/:key/pause`, `/resume` | `409 already_paused` / `not_paused`, `409 schedule_done` for a done one-shot. |
| `DELETE /api/schedules/:key` | Soft delete; `200` with the item (the UI keeps it for Undo). |
| `POST /api/schedules/:key/restore` | Undo. |
| `POST /api/agents/:slug/stop-crons` | §10.3: `200 {status: "stopped" \| "pending"}`; `409 no_crons`, `409 stopping`. |

Errors use S8's shapes (`400 invalid_schedule` with the sentence, `404 schedule_not_found`, `409 target_ended`). Queue items (`queueItemSchema`) and `MessageLookup` gain `scheduleKey`, `firings`, `late`, `dueAt` for pending and delivered scheduled rows; `GET /api/schedules/:key` also returns a deleted schedule (with `deleted: true`) so a badge link can offer Restore. Every mutation publishes `schedules_changed` to all sockets after its commit; the agent summary gains `scheduleCount` (schedules targeting it that are neither deleted nor done: what `/schedules?target=` shows by default, R4) for the strip. The web computes the run preview with the shared `cron.ts` (croner through `packages/shared`, one version).

## 12. Locking and concurrency

### 12.1 The order

Written in the header of `schedule-store.ts`:

1. Read without locks to learn which agents are involved (target, new target, caller).
2. **Agent rows** first, in **one global order** (persistent before spawned, then by id; S7/S8's order), one row per statement so each row gets its own mode: the creating agent `FOR NO KEY UPDATE` when it creates (serialises its own creates so the 20-limit count can't be raced), every target `FOR SHARE`; a row that is both gets `FOR NO KEY UPDATE`. (Creator first, then targets, would deadlock when A schedules for B while B schedules for A: found in review.) A deadlock is still retried once from step 1, as S8 does. Re-check each is live.
3. **Schedule rows**, `FOR NO KEY UPDATE` (edits, deletes, restore) or `FOR NO KEY UPDATE SKIP LOCKED` (the firing). Never `FOR UPDATE` (S7's rule: it would conflict with the `KEY SHARE` that message inserts take through `schedule_id`). An edit that changes the target re-reads the schedule under its lock and, if the target changed meanwhile, retries once from step 1.
4. **Message rows**: the pending scheduled row `FOR NO KEY UPDATE`, then insert or update.

**Invariant: agents before schedules before messages; no transaction locks a schedule row and then waits on an agent row.** S7's termination (agent rows, then `terminateRows`, which now also updates the target's schedules) and unarchive (agent row, then its schedules) follow it. Tasks are never touched by schedule transactions, so S8's "tasks before agents" is unaffected. A deadlock is retried once (§8.1); every call inside takes `tx`; the transaction never awaits a runtime call.

### 12.2 Races, each with a test (S8's `pg_stat_activity` technique, no sleeps, no server hooks)

- **Termination vs firing:** termination first → the firing's `FOR SHARE` waits, then the schedule is deleted (re-read under its lock: skipped). Firing first → the termination waits on our `FOR SHARE`, then rejects the pending row in its own transaction.
- **Edit vs firing:** whichever locks the schedule first wins; the firing re-reads under its lock (an edit that moved `next_run_at` into the future or changed the target makes it skip; `SKIP LOCKED` makes a firing skip a schedule being edited and fire it on the next tick, at least 1 s later, §7.3).
- **Two concurrent creates by one agent at 19:** serialised by the creator's `FOR NO KEY UPDATE`: one succeeds, one is refused.
- **Firing vs batch write** (the accepted race of §8.2): the predicate `delivered_event_seq IS NULL` and the partial unique index keep it to coalescing, never two pending rows.

## 13. Security

- **Identity:** `created_by`, `body_author`, the row's author and `from = @scheduler` come from the token or the session, never from input. The envelope's `by` therefore can't name someone else.
- **Reach:** an agent can schedule to any live agent it could `send_message` to (S6: every live agent), never to humans; a schedule is no wider than a message, but bounded (20 schedules, 15-minute floor, one-year horizon, 64 KB body). Spawned agents have no schedule tools.
- **Agent text is untrusted:** bodies render through the one `Markdown` component in the session and as escaped plain text (first line) in lists; envelopes escape bodies and attributes (`groupEnvelopes`, `attr()`); `list_schedules` returns bodies as JSON-escaped data.
- **REST:** `/api/schedules*` and `stop-crons` use `requireUser`; a test sends a live agent token to each and gets `401`.
- **The durable-cron fallback** deletes one factory-resolved path only (§10.4).
- **Accepted:** ping-pong through schedules is bounded by the floor and the cap (#47 gets a note); humans have no floor (a human's `* * * * *` costs a turn a minute, by choice).

## 14. Failures

| Failure | What happens |
|---|---|
| Invalid input, unknown or ended target, limit | Tool error sentence / `400`/`404`/`409`; nothing written. |
| Firing transaction fails | Retried once on a deadlock, then logged with the per-schedule backoff of §8.1 step 4. |
| Hand-off throws (start failure) | Logged; the row stays pending; next wake or boot delivers it. |
| croner throws on a stored expression (should be impossible: validated on write) | Logged; that schedule is paused by the scheduler with `paused_at` and a log line, so it can't spin every tick; the UI shows it paused. |
| Any other persistent firing failure | Backoff per schedule (§8.1 step 4): at most one retry a minute, logged each time. |
| `FACTORY_TIMEZONE` invalid | Boot fails with the zone sentence (config is validated like S5's). |
| Stop crons on an agent whose stop fails | S5's escalation and `stop_failed` apply. |

## 15. UI (summary; the UI doc is the source)

- **Schedules page** (`/schedules`): a stacked list (key, target, when, next run, state; the message's first line; authors), a row menu (Edit, Pause/Resume, Delete with Undo), filters target and "Show done"; create and edit on their own pages with the Repeats/Once switch, a "next 3 runs" preview in the chosen zone (updated on change/blur), a zone select grouped by region (R1), the `MarkdownEditor`, validation on blur.
- **Session:** `scheduled` blocks with the "Scheduler" sender, an `S-3` badge linking to the schedule, "by @x", and "due … · delivered late" / "covers 3 runs" notes.
- **Agent strip:** the "2 crons" segment opens a popover listing the live crons with **Stop crons** (confirmation naming the crons, button "Stop 2 crons"); "Stops when its current work finishes" while pending; "2 schedules" links to `/schedules?target=<slug>` when nonzero.

## 16. Dependencies

`croner` as a direct dependency of `packages/shared` (used by server and web through it), pinned exactly with `pnpm add --save-exact`, at the newest release that passes the repo's `minimumReleaseAge` (11.0.0 at the time of writing; 11.0.1 was 6 days old). Nothing else. pg-boss is not added.

## 17. Testing

No automated test calls a live model. Timing tests use fake timers plus the injected clock and await real events and the runtime job queues; none raises a timeout; a test never calls `settled()` right after a fire-and-forget hand-off without awaiting it (the Scheduler exposes `idle()` for its tick).

### 17.1 Unit
`cron.ts`: validation (fields, nicknames, 6 fields, never-firing), `nextRuns` across both DST transitions in two zones (§7.2), `minGap` (15-minute floor, `*/15` accepted, `*/5` refused, `0 9 * * *` accepted), zone validation; `parseKey` for `T-`/`S-`; the input schemas; the occurrence/missed/late computation of §8.1 step 3 (catch-up of 3 days of a weekday cron = 3 missed, due = last); envelope rendering of `scheduled` (attributes, escaping, determinism, a forged `</factory-message>` in the body stays inside); `buildClaudeMd` (Scheduling section for persistent vs spawned, kinds line, determinism with `FACTORY_TIMEZONE`).

### 17.2 Server (fake driver, fake timers, real Postgres)
- **Scheduler:** fires at the time; arms at most 60 s ahead; re-arms after create/edit/pause/delete; a clock jump forward fires once; one tick at a time; 101 due schedules take two ticks; a failing transaction retries once on a deadlock, then backs off per §8.1 step 4.
- **AC 1** end to end (hibernated target wakes with `scheduled`; envelope bytes); **catch-up** after a simulated downtime (fires once, `late`, `firings` = missed, next run correct); one-shot catch-up; the skip fallback branch behind its test.
- **AC 3** replacement: errored target, three firings → one row, `firings = 3`, current body and author, no attempt; the runtime's queued entry refreshed, monotonically (an older hand-off after `init()` doesn't regress it); a written-but-unconfirmed row is not replaced; a replacement landing between rendering and the batch's commit leaves the row equal to what was rendered (§8.2 rule 1); boot clears a stale `delivered_event_seq` and the next firing replaces again (the review's Restart → crash → errored path).
- **Round-2 cases:** Stop crons with a pending apply-restart (the stop runs at the first not-busy moment; crons reaching 0 lets the restart run); Stop crons during an `apply_changes` hibernate (takes it over, no `restart_crons`); a compact queued behind the passive notice still runs; two agents scheduling for each other at once (no deadlock, or one retry); `flush` re-reading a stale scheduled entry renders the current row.
- **Backoff:** a schedule whose firing throws every time is retried with 5 s → 60 s backoff and never re-arms the timer at 0 ms; a `SKIP LOCKED` skip re-arms at least 1 s ahead.
- **Lifecycle:** every row of §10.1, including archive skip, unarchive without catch-up, termination deleting schedules, a pending row of a deleted schedule still delivered, shutdown between commit and hand-off delivered once at boot (Q20), `bootWakes` counting `scheduled`.
- **Races** of §12.2 with lock-wait polling.
- **Tools over HTTP** (real `fetch`, real tokens): persistent agents list the three tools, spawned agents don't; defaults (`to` = self, zone = `FACTORY_TIMEZONE`); limits (20, 15 min, one year); cancel rules; list contents.
- **REST:** every route; derived states; `401` for a live agent token on each.
- **Harness crons:** the status lists crons with `durable`, `nextFireAt` (one-shots) and `expiresAt` (recurring); Stop crons for every row of §10.3's table (idle: hibernates now, notice pending, no wake, not forwarded; busy: pending, hibernates at the first idle moment despite the pin, the notice listing crons created meanwhile; crons reaching 0 clears it; a pending apply-restart: the stop wins, no `restart_crons`, the restart still applies; stopping/`stop_failed`: `409 stopping`); `isPassive` in every place it is used (no write of a passive notice alone, no `queued_items` wake, no `bootWakes` wake, the Reaper reaps a spawned agent whose only queued item is the notice); apply-restart still doesn't wait (S5 test kept) and its notice names the crons.
- S3–S8 tests keep passing (the `messages` CHECK rewrite, `bootWakes`, `entryOf`, `ORDER`).

### 17.3 Harness
The mapper keeps `durable` on `cron_created` (fixture `cron-create-fire-delete`); `renderEnvelopes` with the `scheduled` attributes.

### 17.4 Web
The UI doc's states (table states, filters as URL params, create/edit validation on blur, preview in zone, pause/resume, delete with Undo, the cron popover and its confirmation, the strip segments, the session badge).

### 17.5 Live check (`pnpm smoke:scheduling`, not part of `pnpm test`)
Real `claude` on haiku, the token file read into the environment at run time (never printed), a throwaway database and `FACTORY_HOME`, Docker agents on `open-factory-base:dev`, only the env vars the agent needs. It drives only real routes and the real MCP endpoint (no test hooks, no bypass of security or limits). The template sets `warm_window_minutes: 1` (normal config, Q23). Steps, each asserted and printed:
1. A human creates a one-shot at now + 90 s and a `* * * * *` schedule (humans have no floor) to hibernated `ceo` through `POST /api/schedules`; `ceo` wakes with the `scheduled` envelope.
2. `ceo` calls `schedule_message` to itself at now + 2 min, `list_schedules`, `cancel_schedule` on its own; an agent call with `*/5 * * * *` gets the 15-minute sentence.
3. Replacement: the target is blocked through a real path (`FACTORY_MAX_RUNNING_AGENTS=1` with another agent holding the slot, so the target stays queued; a bad credential can't be stored, since credentials are verified on save); two firings leave one pending row with `firings = 2`.
4. Restart: the server stops with a one-shot due during the downtime; at start it fires once with `late="true"`.
5. Crons: the agent is asked (a human message) to run `CronCreate("*/2 * * * *")`; it stays up past its 1-minute warm window; Stop crons hibernates it; the next wake carries the `crons_stopped` notice.
The early slice (§18) runs first; the whole script at the end; both outputs go in the PR.

## 18. To verify first

| # | Claim | How | If wrong |
|---|---|---|---|
| V1 | On today's Claude Code (2.1.327 locally), `CronCreate` (recurring and one-shot) and `CronDelete` still map as S0 recorded (`tool_use_result` with `id, recurring, durable, nextFireAt`; one-shot auto-delete; `command_lifecycle{wakeup_source}` before the firing turn). | Plan task 1: a haiku run through the real driver, compared with the S0 fixtures. | Fix the mapper first; re-record the fixture. |
| V2 | A `durable: true` cron does **not** fire after the process stops and the session is resumed. | Plan task 1: create a durable one-shot 2 min out, stop the process, `--resume` after the time, watch for a `schedule_wakeup` turn and `.claude/scheduled_tasks.json`. | Ship §10.4's fallback (delete the file before every start). |
| V3 | Claude lists and calls the three schedule tools from the per-caller server, with the optional `cron`/`at` pair and `timezone`. | The early slice, right after the tools exist. | Split into `schedule_cron` and `schedule_once` (no optional pair). |
| V4 | A haiku agent reading a `scheduled` envelope acts on the body and doesn't try to recreate a fired one-shot. | The early slice and step 1 of §17.5. | Sharpen the CLAUDE.md line; never script phrasings. |
| V5 | The extended `messages` CHECK accepts every S3–S8 row shape and the new one, and rejects wrong shapes. | The migration test (Postgres 18). | Fix the CHECK. |
| V6 | croner's DST behaviour is as §7.2 states (verified while designing and again in review on 11.0.0), and our pre-validation refuses its extensions. | Unit tests on the pinned version. | Pin the behaviour by wrapping croner. |

## 19. Accepted risks and non-goals

- **Catch-up after long downtime** fires once, late (Q3); the agent judges whether it still matters. Fallback: skip late recurring firings (one branch, added only if Or flips Q3).
- **Coalescing race** between a firing and a batch's rendering and commit (§8.2): never two rows, and the row always says what the agent read; at worst a firing that landed in that window is counted into it without the agent seeing the higher count.
- **A pending row keeps its body** after an edit; a zone edit changes how a pending row's `due` renders.
- **DST** can make a single real gap of an agent schedule shorter than 15 minutes (§6.2).
- **Humans have no floor:** a human's every-minute schedule costs a turn a minute.
- **Crons die with every process** (restart, shutdown, crash), as before; agents are told which (S5).
- Non-goals: §3 Out.

## 20. Product doc wording (for the lead; not edited here)

- `architecture/tech-stack.md` → Jobs / events: "Postgres only: durable timers are a `next_run_at` column and one in-process timer (S9); no pg-boss, no Redis; the wake queue, the member-update debounce and the spawned-agent sweep are in-memory timers rebuilt from durable rows."
- `architecture/system-overview.md` → the diagram's Scheduler line and the Scheduler component: "Scheduler: factory schedules on a durable `next_run_at` with one in-process timer (S9); the in-memory sweep (TTLs, workspace cleanup) stays separate."
- `architecture/data-model.md`: `schedules` fields as §5 (`target_agent_id`, `cron` | `run_at`, `timezone`, `body`, creator, body author, `next_run_at`, `last_fired_at`, `paused_at`, `deleted_at`; keys `S-<n>`); `messages` gains `scheduled` with `schedule_id`, author, `due_at`, `firings`, `late`; **remove `harness_crons`** and `agents.pinned_crons` (crons are process-local; the live list is runtime state); remove "pg-boss owns its own job tables…".
- `concepts/schedule.md`: replace "the factory watches the event stream … `harness_crons`" wording with "the runtime keeps the live set"; add time zones (IANA per schedule, `FACTORY_TIMEZONE` default for agents), catch-up (fires once, late), replacement (one pending row, `firings`), agent limits (20, 15 minutes, one year; spawned agents have no schedule tools), the kill action (Stop crons hibernates; passive notice), and the `durable` result once V2 is known.
- `concepts/message.md` → Kinds: `scheduled` is from `@scheduler` with `schedule`, `by`, `due`, `firings`, `late`; a direct message; never starts a recovery.
- `architecture/factory-mcp.md`: `schedule_message(body, cron?, at?, timezone?, to?)` (was `prompt`), `list_schedules()` (yours and those targeting you), `cancel_schedule(id)` (yours only); persistent agents only; limits.
- `architecture/agent-runtime.md` → Busy and pinned: Stop crons; the passive notice; apply-restart keeps not waiting for crons.
- `architecture/context-assembly.md` item 3: the Scheduling section of §10.5.
- `behavior/administration.md` → Schedules: zone shown, next 3 runs preview, derived states, delete with Undo, done one-shots under "Show done".
- `behavior/agents-and-sessions.md`: the cron popover and Stop crons; the schedules link.
- `roadmap/v0.1/s09-scheduling.md`: no pg-boss; no `harness_crons` table; the kill action stops the process.
- `open-questions.md` → Verified in S9: V1, V2 results.

## 21. Issues consumed and follow-ups

Consumed: **#31** (closed: S5 tells the agent and its manager; S9 names the crons and adds Stop crons; links S5 Q17 / #38). Notes: **#57** (pg-boss won't take over the sweep; the S9 timer could host it later), **#47** (schedules are another agent-to-agent path, bounded by the floor and the cap). Untouched: #26 (no scheduled compaction), #48, #49, #23.

Follow-ups: schedules addressed to humans (#65); running Docker agents in the factory's zone (#66). The durable-cron result is recorded in open-questions either way (no issue). The §22 items Or may flip need no issue: each names its one-branch fallback.

## 22. Decisions needing Or's call (owner-proxy certainty 3/5)

- **Q3** overdue schedules fire once at boot with `late` (pulls against "skip late runs", P15); fallback: skip late recurring firings, one branch.
- **Q10** agent limits: 20 schedules per agent, 15-minute floor, one-year horizon.
- **Q12** spawned agents get no schedule tools (alternative: allowed like everyone, deleted at termination).
- **Q15** fired one-shots are kept and shown under "Show done" (alternative: deleted after firing).
- **Q17** soft delete with Undo (`deleted_at`) instead of a confirmed hard delete.
