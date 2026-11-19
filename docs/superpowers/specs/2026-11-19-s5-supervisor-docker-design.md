# S5 Supervisor and Docker runtime: Technical Design

- **Date:** 2026-11-19
- **Status:** approved by owner-proxy (owner-s5); pending Or's review on the low-certainty items (§21)
- **Roadmap spec:** `docs/product/roadmap/v0.1/s05-supervisor-docker.md`
- **UI design:** [`docs/superpowers/designs/2026-11-19-s5-supervisor-ui-design.md`](../designs/2026-11-19-s5-supervisor-ui-design.md)
- **Product sources of truth:** `docs/product/architecture/agent-runtime.md`, `harness-driver.md`, `base-image.md`, `workspace.md`, `permissions.md`, `system-overview.md`, `data-model.md`; `docs/product/concepts/agent.md`, `session.md`, `message.md`, `schedule.md`, `credential.md`; `docs/product/behavior/agents-and-sessions.md`; ADRs 0008, 0009, 0010, 0011, 0013, 0018; `docs/product/open-questions.md` ("Verified during design", the S0 findings).
- **Builds on:** S3 ([spec](2026-11-18-s3-walking-skeleton-design.md): harness driver, `AgentRuntime`, event store), S4 ([spec](2026-11-19-s4-templates-workspace-design.md): templates, workspace, `prepareStart`, `requestRestart`, credentials, `buildMounts`) and S2 ([spec](2026-11-18-s2-base-image-design.md) §5.1: the base image runtime contract).
- **Evidence:** the S0 fixtures in `packages/harness/fixtures/`, plus what this design verified (§19).
- **Decision log:** the GitHub issue "S5 Supervisor and Docker runtime: design decisions".
- **Stacked on:** `spec/s4-templates-workspace` (PR #37), itself stacked on `spec/s3-walking-skeleton` (PR #27).

> `docs/product/` is gitignored, so the product docs exist only in local checkouts. Paths above are relative to the repo root.

## 1. Goal

Agents behave as the product describes: a message wakes a hibernated agent, it stays warm while there is work and for a warm window after, it hibernates safely (never while busy or pinned), a global cap bounds how many run at once, crashes and rate limits are handled without losing work silently, and agents run sandboxed in Docker by default, with the local runtime an explicit operator opt-in.

## 2. Acceptance criteria

From the roadmap, made testable:

1. **Wake from Docker.** A message to a hibernated `runtime: docker` agent creates or starts its container, resumes the session, and the agent answers with its earlier memory intact (it recalls a word from a turn before hibernation).
2. **Busy never hibernates.** An agent running a background `sleep 600` is still running when its warm window expires; it hibernates only after the task ends and the window then elapses. The agent strip shows "Waiting on: sleep 600 (background, …)".
3. **Cap.** With `FACTORY_MAX_RUNNING_AGENTS=2` and two agents mid-turn, a third woken agent shows `queued` and starts when a slot frees up. With two idle-warm agents, the third starts at once and the least recently active idle agent hibernates ("Hibernated to free a slot").
4. **Crash.** Killing Claude mid-turn (SIGKILL) kills its leftover background shells, marks the agent `errored`, and makes exactly one automatic resume whose first turn is a factory notice; the agent recovers. If that resume also fails, the agent stays `errored` and offers Restart.
5. **Ownership and parity.** Files a Docker agent writes into a granted project are owned by the host user, and `git worktree list` gives the same output on the host and in the container.
6. **Factory restart.** Restarting the server while agents run (local and Docker) leaves no orphaned Claude process or running container, never runs two processes for one session, and wakes agents that had pending messages.
7. **Rate limit.** A `rejected` rate-limit event (fake driver, documented shape) pauses wakes and deliveries for agents on that credential only, shows `rate_limited until HH:MM`, and at reset the cut-off agent gets one continue notice.
8. **Local gate.** With `FACTORY_ALLOW_LOCAL_RUNTIME` unset, a local agent doesn't start and says why; with it set, it runs and shows Unsandboxed.
9. **No host escape through the workspace.** Each planted escape in §11.4 fails closed (regression tests).
10. CI is green. The live check (§18.5) has been run once with Docker and its output, plus a manual pass through ACs 1–8 in the browser, is recorded in the PR.

## 3. Scope

**In:**
- the `Supervisor`: wake queue, global cap with FIFO and early hibernation, warm timers, per-credential rate-limit pauses, boot reconciliation;
- hibernation (warm window, eviction, apply-restart, shutdown) through one hibernate path;
- busy tracking and a minimal in-memory cron pin; the "waiting on" detail;
- crash handling: leftover cleanup, one automatic resume with a factory notice, Restart, "Start a new session";
- the Docker launcher: container lifecycle with dockerode, exec transport, mount builder with an allow-check, image pull and re-create;
- the local process-tree journal and the `allow_local_runtime` gate;
- workspace hardening before Docker isolation (template copy out of the workdir, symlink-safe host writes);
- `system` messages from `@factory`;
- UI: the new statuses, waiting-on, Restart, Start a new session, lifecycle lines, runtime badges.

**Out:**
- pg-boss (it arrives with the first durable timer, S6/S9, §5.1);
- the factory MCP and agent authentication to the factory (S6); S5 only wires reachability (§11.6);
- delivering crash and lost-work notifications to managers (S6: logged and recorded as session events until then);
- cron persistence, the "pinned by N crons" badge and the kill action (S9);
- ephemeral agents, Terminate and TTLs (S7);
- resource limits, `oom_score_adj` (follow-up);
- durable queued compacts (#26 stays open);
- user image builds and image status (S10);
- a "kick" restart for healthy agents.

## 4. Architecture

```
routes (send, compact, interrupt, restart, reset-session)
  │
  ▼
AgentRuntimes ──► AgentRuntime (per agent, S3 serial job queue)
  │                 ├─ delivery queue, urgent hold, turns (S3)
  │                 ├─ busy: open turn, live non-ambient tasks, owed notifications, live crons (pin)
  │                 ├─ warm timer, hibernate(reason), crash policy, escalation
  │                 └─ reports idle/busy/exit/rate-limit to the Supervisor
  │
  ├─ Supervisor (one per server): cap, FIFO wake queue, eviction, credential pauses, boot reconciliation
  │
  └─ start path: Supervisor grants a slot → prepareStart (workspace lock) → Launcher
                     Launcher(local):  LocalTransport (child_process) + ProcessJournal
                     Launcher(docker): ContainerManager (dockerode) → DockerExecTransport
                                         ↑ MountBuilder + allow-check
                  ClaudeProcess (S3, now over a Transport): mapper, NDJSON writes, stop()
```

| Unit | Location | Owns |
|---|---|---|
| `Transport` interface, `LocalTransport` | `packages/harness/src/transport/` | Byte-level stdio, exit, terminate (SIGTERM-equivalent), forceKill. `ClaudeProcess` keeps the mapper, writes and the stop sequence, and now runs over a transport. |
| `DockerExecTransport` | `apps/server/src/runtime/docker/exec-transport.ts` | The hijacked exec stream, stdin half-close, demuxed stdout/stderr, exit code from exec inspect, in-container `kill -TERM` (§11.3). |
| `ContainerManager` | `apps/server/src/runtime/docker/containers.ts` | Create (hardened options), start, ready-marker wait, stop, remove, re-create on spec-hash change, image pull, listing by label (reconciliation). |
| `buildMounts` + `checkMounts` | `apps/server/src/workspace/mounts.ts` (S4's file) | Mounts from factory-owned inputs only; the allow-check (§11.4). |
| `ProcessJournal` | `apps/server/src/runtime/local/journal.ts` | Descendant snapshots, the persisted journal, verified reaping (§12). |
| `Supervisor` | `apps/server/src/supervisor/supervisor.ts` | Slots, the wake queue, eviction, credential pauses, reset timers, boot reconciliation orchestration. |
| `statusOf` | `packages/shared/src/status.ts` | The one pure precedence function (§8.1). |
| `classifyResumeFailure` | `apps/server/src/agents/resume-failure.ts` | Unrecoverable vs ordinary resume failures (§9.3). |
| `systemNotice` builders | `apps/server/src/agents/notices.ts` | The fixed texts of every `@factory` message (§9.5). |

Nothing outside `packages/harness/src/claude/` knows a stream-json field name (S3 rule, unchanged). Nothing outside `runtime/docker/` imports dockerode.

## 5. Supervisor

### 5.1 Why not pg-boss (decision Q1)

The roadmap says wake requests run through pg-boss. S5 doesn't: a slot is held by a **live process**, not by a job, and "who is waiting" is already durable as `pending` message rows. A pg-boss queue would be a second copy of that truth and a job model that doesn't fit long-lived processes. The wake queue is in memory, owned by one `Supervisor`, and rebuilt at boot from the database (§5.6). pg-boss arrives with the first durable timer (S6 debounce or S9 schedules). The product docs' wording is listed for the lead (§20).

### 5.2 Slots and the cap

- `FACTORY_MAX_RUNNING_AGENTS` (default 8, min 1) in `config.ts`. The Supervisor is the only owner of the cap.
- A **slot** is held from the moment a start is granted (before `prepareStart`) until the process has exited and, for Docker, its container is stopped. Warm-idle processes hold slots (product rule).
- `requestWake(agentId, reason)` is the only way a process starts. Callers: a send or compact API job, a crash recovery attempt, Restart, Start a new session, a rate-limit reset, boot reconciliation, the end of an apply-restart with items queued. It returns `"started"` (granted and started inside the caller's job, so S3's synchronous `503 agent_start_failed` still works when the start fails) or `"queued"`.
- Granting order: strict FIFO by request time, except that an entry whose credential is paused (§7) is skipped without losing its place; it becomes eligible again at reset.

### 5.3 Early hibernation when the cap is full (decision Q2)

When a wake is queued and some slot holder is **hibernatable** (§6.3: idle, not busy, not pinned, nothing queued for it, no restart in progress), the Supervisor hibernates the least recently active one (`lastActivityAt`: the last turn end, delivery or start) with reason `freed_slot`, through the same hibernate path as warm-window expiry. The freed slot goes to the head of the wake queue. Busy, pinned and mid-turn agents are never evicted. The queue waits only while every slot is busy or pinned.

### 5.4 Queued status

An agent with a wake in the queue is `queued` (unless a higher-precedence status applies, §8.1). The queued wake is in memory; the messages that caused it are durable, so nothing is lost if the server stops.

### 5.5 Wake as a job

A granted wake runs `AgentRuntime.start()` as a job on that agent's serial queue: `prepareStart` (§10), then the launcher, then `process_started`, then flush (S3). A start failure releases the slot at once. A wake for an agent that is already running, archived, errored (except the explicit recovery callers), or whose start is already in flight is dropped.

### 5.6 Boot reconciliation (decision Q5)

Runs in `buildApp` after migrations and **before the server listens**:

1. **Local leftovers.** For every agent row with a `process_journal` (§12): verify and reap Claude and its journaled descendants (SIGTERM, 3 s, SIGKILL, each pid only if its start time matches), then clear the journal.
2. **Docker leftovers.** List containers labelled `io.open-factory.agent-id`. For each whose agent id exists in this database: if running, stop it (timeout 5 s); keep it otherwise. Containers whose agent id isn't in this database belong to another factory (or a deleted agent) and are left alone, logged once at info.
3. **Dangling state.** Turns with `ended_at` null are closed with `terminal_reason = "factory_restarted"`, `is_error = true`. For each agent that had a dangling turn or a reaped process, a `reconciled{killedProcesses, stoppedContainer}` event is appended, and a `background_work_lost` event if its journal named live background tasks (§9.4).
4. **Wakes.** For every non-archived, non-errored agent with pending messages, `requestWake(…, "boot")`, ordered by the agent's oldest pending message so FIFO survives the restart. Agents owed a rate-limit continue notice whose credential has reset get it (§7.3). Errored agents are not woken. Agents that were merely warm stay hibernated.

Invariant: **never two processes for one session.** A test restarts the server with a live local agent and a live Docker agent (fake claude) and asserts there is exactly one process per agent afterwards.

## 6. Hibernation, busy and pinning

### 6.1 Busy

An agent is **busy** while any of these hold (S4's restart conditions, now shared):
- the process is starting, a turn is open, a batch is in flight or awaiting its turn, a compact is in flight, or an urgent hold is active;
- the live **non-ambient** background-task set is non-empty (from `background_tasks`, reset on `process_started`, S3/S4);
- a notification turn is **owed** (S4's counter), with a new **30 s bound**: each `background_task_finished` arms a 30 s timer; when it fires with the counter still above zero, the counter resets to 0 and a warn log names the agent (fixes "an owed notification turn that never arrives blocks restart forever").

`system/session_state_changed` is **not** used: it reports `idle` while a background task is still live (§19, closes #24).

### 6.2 Pinning by in-session crons (decision Q4)

- `AgentRuntime` keeps the live cron set in memory from `cron_created` / `cron_deleted`: `{cronId, recurring, humanSchedule, nextFireAt, createdAt}`. It is reset on `process_started` and cleared on `exited` (crons die with the process, so memory is exactly the right lifetime).
- A one-shot cron is dropped once its `nextFireAt` has passed **and** a turn with `originKind: "cron"` has ended after it (one-shots auto-delete with no `CronDelete`, S0). Any cron is dropped 7 days after `createdAt` (Claude's expiry).
- **Pinned** = the set is non-empty. A pinned agent is never hibernated by the warm window or by eviction. It still holds its slot (accepted: up to 7 days). Explicit actions (apply-restart §6.5, Restart, shutdown, archive) still stop it, and the crons that were live are recorded as lost (§9.4).
- S9 adds persistence, the badge and the kill action.

### 6.3 Hibernatable and the warm timer

**Hibernatable** = process running and started, not busy, not pinned, the delivery queue for it is empty, not errored, no restart or stop in progress, its credential not paused with deliveries held (§7.2 holds them; a held delivery counts as "queued for it").

The **warm timer** (one per runtime) starts whenever the agent becomes hibernatable and is cancelled whenever it stops being so. Duration: the snapshot's `warm_window_minutes` (default 70). On expiry it enqueues a job that re-checks hibernatable and calls `hibernate("warm_window")`. Every job that can change the inputs re-evaluates it (turn end, background tasks, exits, deliveries, cron changes, pause changes): one function `updateWarmTimer()` at the end of `onEvent` and of every API job.

### 6.4 The hibernate path (one path)

`hibernate(reason)` with `reason ∈ warm_window | freed_slot | apply_changes | shutdown | archived` runs as a job and:
1. sets `stopping` (S4 flag: no respawn, flush writes nothing);
2. records the live non-ambient tasks and live crons; if any (only possible for `apply_changes`, `shutdown`, `archived`), appends `background_work_lost` (§9.4);
3. calls `proc.stop({graceMs: 3000, termWaitMs: 10_000})` without awaiting it inside the job (S4's deadlock rule); the stop's promise is observed outside;
4. on `exited` (any): for Docker, `ContainerManager.stop()` (timeout 5 s; the container is stopped, not removed); then appends `hibernated{reason}` and releases the slot;
5. if the stop **timed out**, escalates (§9.6) instead of leaving the agent errored.

Hibernation keeps the session id, the working dir and the container.

### 6.5 Apply-restart under S5 (S4's `requestRestart`, decision Q17)

`requestRestart` keeps S4's seam and callers. Its body becomes "hibernate when safe, then wake if needed":
- It waits for everything that makes an agent busy (§6.1), **but not for crons**: a pin can last 7 days, and a revoked grant or credential must stop applying.
- At the safe moment it calls `hibernate("apply_changes")`. If crons were live, they are recorded as lost and the agent is woken right away with a system notice (§9.5 "restart-crons") so it can recreate them. If items are queued, it is woken to deliver them (S4 behaviour). Otherwise it stays hibernated until the next message.
- Docker: grants, image and mounts are part of the container spec hash (§11.2), so the next start re-creates the container when they changed. Secrets and the credential are exec env, so they never re-create it.

S4 fixes included (listed in the PR's Changes): the 30 s owed-notification bound (§6.1); `ClaudeProcess.stop()` is idempotent (a second call returns the first call's promise, fixing the double `proc.stop`); a timed-out stop escalates (§9.6) instead of leaving the agent errored until a server restart.

### 6.6 Shutdown

`app.close()` calls `hibernate("shutdown")` on every running runtime in parallel (S3 timing: close stdin, 3 s, SIGTERM, 10 s), then stops Docker containers (5 s), then waits for each job queue to drain. The force-exit budget in `shutdown.ts` rises from 20 s to **25 s** (3 + 10 + 5 s plus margin), with the comment updated. Lost background work is recorded (§9.4). Containers are stopped, never removed.

## 7. Rate limits (decisions Q3, Q18)

### 7.1 Detection

Only the mapper's `rate_limited` event (S3: emitted only for `status: "rejected"`) pauses anything. `allowed_warning` stays a dropped line in the mapper (no pause); surfacing it is S10's usage work. The `rejected` shape is documented but unverified (S0); the fake-driver fixture is built from the documented SDK shape and labelled unverified.

### 7.2 Per-credential pause

- `credentials.rate_limited_until timestamptz null` (additive). On a `rate_limited` event: `resetsAt` (epoch seconds) → `until`; if it is missing, unparseable or in the past, `until = now + 30 min` and a warn log says the reset time wasn't reported (`rate_limit_fallback = true` stored alongside, so no copy claims an exact time).
- If a later event extends the window, the later `until` wins; it never shortens.
- While `now < until` for a credential:
  - wakes of agents on it are skipped in the FIFO (§5.2), keeping their place;
  - running agents on it **hold deliveries**: `flush()` writes nothing (messages and compacts stay queued, visible as "Not delivered yet: rate limited until 14:30"). An urgent interrupt is still written (it costs no model call);
  - an agent's status is `rate_limited` per §8.1.
- A Supervisor timer per paused credential fires at `until`: it clears the column, then requests wakes (FIFO) for agents on it with pending items, and flushes running ones.

### 7.3 The continue notice

- When a turn ends after a `rate_limited` event in that same turn, the agent row gets `rate_limit_notice_owed = true` (additive boolean). At most one per cut-off turn: a second rejection while the flag is set doesn't add another.
- At reset, each owed agent gets the system notice "rate-limit-reset" (§9.5) as a `system` message, so it rides the normal wake path (cap, FIFO). If messages are pending, the notice and the messages go out as **one** batch turn (the notice first). The flag clears when the notice is created.
- The notice names the credential by its name and states the reset time only when it was reported (not on the fallback).

## 8. Status

### 8.1 Precedence (decision Q16)

`AgentStatus = hibernated | queued | working | idle | rate_limited | errored` (S7 adds `terminated`). Only `errored` is stored (S3 Q12). One pure function in `packages/shared` owns the precedence:

```
statusOf({errored, working, credentialPaused, hasPendingWork, queuedWake, processRunning}):
  errored                                   → errored
  working (starting, turn open, batch awaiting, compact in flight) → working
  credentialPaused && (processRunning || hasPendingWork || queuedWake) → rate_limited
  queuedWake                                → queued
  processRunning                            → idle
  otherwise                                 → hibernated
```

A hibernated agent with nothing pending on a paused credential stays `hibernated`. Table-driven tests cover every row, including errored on a paused credential (errored) and queued on a paused credential (rate_limited).

### 8.2 The status frame

`agent_status` and `AgentSummary` gain:
- `rateLimitedUntil?: string` (ISO) and `rateLimitExact: boolean` (false on the fallback window);
- `waitingOn: {tasks: {taskId, description, startedAt}[], crons: number}` (non-ambient tasks only; `startedAt` is the time the factory first saw the task; the client computes "3m"), empty when nothing keeps it awake;
- `runtimeDisabled?: string` ("The local runtime is disabled on this factory.") for local agents while the gate is off (§13);
- `errorKind?: "start" | "resume" | "resume_unrecoverable" | "crash" | "stop_failed" | "internal"`, which the UI uses to offer Restart or Start a new session;
- `image?: string` (Docker agents: the image reference of the last start).

`GET /api/agents` also returns `running: {count, max}` (slots held and the cap), and a factory-wide `supervisor` frame `{type: "supervisor", running, max}` goes to every socket when either changes, so the Agents list can say "3 of 8 running" and a queued agent's wait is explainable.

The frame stays deterministic (no relative times), so it's only republished when something changes.

### 8.3 Persisted error

`agents.last_error text null` and `agents.error_kind text null` (additive) persist `lastError` and its kind with `status = 'errored'`, so an errored agent still says why after a server restart. Cleared with the errored status.

## 9. Crashes and recovery (decisions Q6–Q8)

### 9.1 What counts as a crash

An `exited` with `expected: false` (S3), including a Docker exec stream that ends without a stop, and a container that dies.

### 9.2 Policy

On a crash, in one job:
1. **Clean up leftovers first:** local, reap the journal (§12); Docker, restart the container (stop with 5 s timeout, which kills everything inside, then it's started again by the resume). A `cleanup{killedProcesses?}` event records it (Docker: `cleanup{container:"restarted"}`).
2. **Was anything lost?** If no turn was open, no non-ambient task and no cron was live, and nothing is queued: append the `exited` row, set **hibernated** (not errored), release the slot. No resume, no tokens.
3. Otherwise: mark `errored` (`error_kind = "crash"`), append `background_work_lost` for the tasks and crons seen live (§9.4), create the system notice "crash" (§9.5), and `requestWake(…, "crash_recovery")`, **one automatic attempt**. The cap and the rate-limit pause apply to it.
4. **Success** = the resumed process emits `session_started` **and** the turn carrying the notice ends without the process exiting. Then `errored` clears (S3's `session_started` clear moves to that `turn_end`). A crash during the attempt leaves the agent `errored` and makes no further automatic attempt.
5. After that, only a **human** action makes another attempt: a message from a human (it starts the process as in S3) or Restart. Nothing the factory does on its own retries an errored agent (no loop).

### 9.3 Resume failures (#19, decision Q7)

`classifyResumeFailure(errorText, apiErrorStatus?)` is one function:
- `"No conversation found with session ID"` (S0 fixture `error-resume-missing-session`) → **unrecoverable**;
- a 400 whose text contains `diagnostics.previous_message_id` or `Could not process image` → **unrecoverable** (documented by the Agent SDK, **unverified**; the code and the test say so);
- anything else → ordinary: the §9.2 policy (one attempt, then errored).

An unrecoverable failure sets `errored`, `error_kind = "resume_unrecoverable"`: no automatic attempt, and new messages stay pending without triggering an attempt (the error says why). The UI offers **Start a new session** (§9.7).

### 9.4 Lost work

`background_work_lost{reason: "crash" | "apply_changes" | "shutdown" | "archived" | "restart", tasks: {taskId, description}[], crons: {cronId, humanSchedule}[]}` is appended when live non-ambient tasks or crons die with a process. It lists only what the factory saw live. A server log line at info carries the same, with the manager's slug ("would notify @lead"): S6 forwards it to the manager or the humans.

### 9.5 System messages from `@factory` (decision Q6 (i))

- `messages.from_user_id` becomes nullable; `messages.kind` (already present) gains `system`; a CHECK constraint ties them: `(kind = 'system') = (from_user_id IS NULL)`. Additive: existing rows stay valid. No sentinel user.
- System messages go through the same pending → delivered path, appear in the queue (`from: "@factory"`), render with a "Factory" badge, and are delivered as `<factory-message from="@factory" kind="system" …>`. `FactoryMessage.kind` widens to `"message" | "system"`. The S4 CLAUDE.md "How messages reach you" section gains one sentence: "Messages from `@factory` are notices from the factory itself (restarts, recoveries, rate limits)."
- Texts (`notices.ts`), every claim literally true:
  - **crash:** "Your previous process exited unexpectedly (exit code 137) during a turn. These background tasks were stopped: `pnpm test` (shell). These in-session scheduled jobs were stopped: every 5 minutes. Check the state of that work and continue where you left off." (each list omitted when empty; "during a turn" only when a turn was open);
  - **restart:** "Restarted by @or after an error." (+ the lost lists when non-empty);
  - **restart-crons:** "Your session was restarted to apply configuration changes. These in-session scheduled jobs were stopped: …. Recreate them if you still need them.";
  - **rate-limit-reset:** "The rate limit on credential work reset at 14:30. Continue where you left off." (without "at 14:30" on the fallback window).

### 9.6 Escalation of a stop that won't finish (decision Q8)

When `stop()` resolves `{timedOut: true}` (no exit after close-stdin, grace and SIGTERM):
- **local:** SIGKILL Claude, then reap the journal (§12);
- **Docker:** `ContainerManager.stop()` with a 5 s timeout (Docker SIGKILLs everything when it expires).

A `stop_escalated{how: "sigkill" | "container_stop"}` event records it. If the escalation also fails (the pid survives SIGKILL, the Docker API errors), the agent becomes `errored` with `error_kind = "stop_failed"`, and its slot is **kept** (a process may still be running) until Restart succeeds.

### 9.7 Actions

- **`POST /api/agents/:slug/restart`** (Restart; `409 not_errored` unless errored): force-stops whatever is left (the §9.6 escalation, immediately: SIGTERM, bounded wait, SIGKILL plus journal reap; or a container restart), appends `control{cmd:"restart", by}`, creates the "restart" notice, and `requestWake(…, "restart")`. Available for every `error_kind` except `resume_unrecoverable` (Restart can't fix that; the 409 says to start a new session). A failed Restart leaves the agent errored with the reason, no automatic retry.
- **`POST /api/agents/:slug/reset-session`** (Start a new session; allowed only when errored with `error_kind ∈ {resume, resume_unrecoverable}`, else `409`): clears `session_id`, appends `session_reset{by}`, clears errored, and `requestWake(…, "reset")` if messages are pending (they become the first turn of the new session). The old session JSONL stays on disk (a fresh id already stops it being resumed). The UI confirms first (irreversible: the agent loses its conversation memory; the timeline keeps the history).
- `pnpm agent:reset-session` and `apps/server/scripts/reset-session.ts` are **deleted**, and the S4 session copy that names it is replaced by the action.

## 10. Start path (`prepareStart` under S5)

S4's `createPrepareStart` keeps its contract and lock, with these changes:
1. **Runtime gate** (§13): a local agent with the gate off fails before anything else: `AgentStartError("The local runtime is disabled on this factory. Set FACTORY_ALLOW_LOCAL_RUNTIME=true to run agents unsandboxed.", "runtime")`.
2. **Docker:** the container is **stopped** before `Workspace.prepare` runs (a hibernated agent's container is already stopped; a crash recovery stops it first), so nothing inside it can race the host-side checks (§11.4). Then `prepare`, then `ContainerManager.ensure(spec)` (create or re-create, start, ready marker), then the exec transport.
3. `buildAgentEnv(serverEnv, extra, runtime)` gains the runtime parameter (§11.5).
4. S4's "The Docker runtime isn't available yet." is removed, with its test.

## 11. Docker runtime

### 11.1 Launcher (decision Q11)

dockerode for everything (new `apps/server` dependency, added through the lockfile under the existing `minimumReleaseAge` policy; its optional native `ssh2`/`cpu-features` build must not be enabled: check `onlyBuiltDependencies` and leave it out). `DOCKER_HOST` is honoured by dockerode's defaults; no docker CLI on the factory host.

- **One container per agent**, named `open-factory-<slug>-<first 8 of agent id>`, labelled `io.open-factory.agent-id`, `io.open-factory.slug`, `io.open-factory.spec-hash`, `io.open-factory.image-id`.
- **Created on first wake**, started on each wake, **stopped (not removed) on hibernate**, removed and re-created on a wake whose spec hash differs. Archive doesn't remove it (unarchive must keep working); S7's Terminate removes.
- **Create options** (S2 contract plus hardening, asserted by a unit test on the options object):
  - `Image`: the resolved image (§11.2); `Cmd`: the image default (`sleep infinity`); `Env`: `HOST_UID`, `HOST_GID` (the server's `process.getuid()/getgid()`; if either is 0 the start fails: "The factory runs as root; Docker agents need a non-root host user.") and nothing else;
  - `HostConfig.Tmpfs: {"/run/open-factory": ""}` (ready marker, cleared on stop);
  - `HostConfig.Binds`/`Mounts`: from §11.4 only;
  - `HostConfig.ExtraHosts: ["host.docker.internal:host-gateway"]`;
  - `HostConfig.SecurityOpt: ["no-new-privileges:true"]` (see "No sudo" below); never `Privileged`; no `CapAdd`; `NetworkMode` the default bridge (never `host`); `PidMode` never `host`; never the Docker socket or the host home among the mounts (also enforced by §11.4);
  - `Init`: not set (the image's ENTRYPOINT already runs `tini`).
- **Ready wait:** after start, poll for `/run/open-factory/ready` (an exec of `test -f` as root, every 200 ms, 30 s timeout). On timeout or if the container exits, the start fails with the last 50 lines of the container logs.
- **Claude** runs as `docker exec -i -u agent -w <workdir>` (S2 contract): `Cmd = ["sh", "-c", "echo $$ > /tmp/open-factory-claude.pid && exec claude \"$@\"", "claude", ...claudeArgs]`. The script is a fixed string; Claude's arguments are argv entries, never interpolated. `Env` = §11.5. `/run/open-factory` is root-owned and not writable by `agent` (verified), so the pid file lives in the container's own `/tmp` (not mounted).

**No sudo in agent containers (decision Q11b).** `no-new-privileges` is on for every agent container, so `agent` can't become root. Verified live: the entrypoint's UID remap still works under it (ready marker, `id` 502:20, a bind-mounted file owned 502:20 on the host), and `sudo -n true` as `agent` then fails. This deliberately reverses what the S2 image offers (passwordless sudo, asserted by its smoke test), because the container is the only real boundary for unattended and `bypass` agents: a manager's instruction can get `sudo …` approved by the classifier (S0), root writes root-owned files into bind-mounted repos (breaking AC5), and root widens the kernel surface. Agents that need system packages get them from a user image `FROM` the base (reproducible, unlike a runtime `apt-get`). The base image is **not** changed in S5; a follow-up issue updates S2's smoke test and `base-image.md`, decides whether to drop passwordless sudo from the image, and records a per-template `allow_sudo` opt-in as the likely shape if a real need appears. PR rollout note: agents can no longer sudo inside containers.

A test writes a non-integer, a zero, a negative and an over-long value into the pid file and asserts no `kill` exec is made from it and the stop falls back to the container stop.

### 11.2 Image and re-create (decision Q12)

- Image = the snapshot's `image`, else `FACTORY_DEFAULT_IMAGE` (one config constant, default `ghcr.io/orlevii/open-factory/base:latest`; `.env.example` shows `open-factory-base:dev` for development).
- **Pull only when missing locally**, never to update a present tag (updating an agent's toolchain is a human act, as plugins in S4 Q7). A pull failure or a missing local-only image fails the start with the registry's error verbatim.
- **Spec hash** = sha256 over: the local image **id** (so a rebuilt or re-pulled tag re-creates), the sorted mounts, `HOST_UID`/`HOST_GID`, the extra hosts, the security options, the tmpfs, and a launcher version constant. Grants and host skills change the mounts, so they re-create; secrets and the credential don't.
- The image id actually used is on the container label and in a `container{action: "created" | "recreated" | "started", image, imageId}` event at each wake, so "which toolchain and Claude ran this" can be answered.
- No resource limits in S5 (follow-up issue: memory/CPU limits and `oom_score_adj` on tool shells). Follow-up issue: pin the default image to a released `base-v*` version or digest instead of `:latest` (a floating default fetched at first pull is a supply-chain soft spot).

### 11.3 Exec transport and stop

- **stdin/stdout/stderr:** the hijacked exec stream (`hijack: true, stdin: true`), demultiplexed. NDJSON writes are unchanged (S3). **Closing stdin** = half-closing the stream (verified: the process sees EOF and its exit code comes back).
- **Exit:** when the stream ends, exec inspect gives `ExitCode` → `exited{code, signal: null}`. A container that dies ends the stream the same way.
- **terminate (SIGTERM):** exec `["cat", "/tmp/open-factory-claude.pid"]` as `agent`, parse the output as `/^[1-9][0-9]{0,9}$/` (fail closed on anything else), exec `["cat", "/proc/<pid>/comm"]` and require `claude`, then exec `["kill", "-TERM", "<pid>"]` as `agent`. Argv arrays only, never a shell with file contents. If any step fails, terminate reports failure and the stop proceeds to the timeout and escalation (§9.6).
- **forceKill:** `ContainerManager.stop()` (5 s, then Docker's SIGKILL of everything in the container).
- After any Docker exit the container is stopped (hibernate) or restarted (crash cleanup): in Docker the container stop is the leftover cleanup, the strong guarantee (#20).

### 11.4 Workspace hardening and the mount allow-check (decision Q13)

Found while designing S5: S4's `buildMounts` reads directory-marketplace paths from `.factory/template/settings.json` in the agent's **writable** workdir, so a Docker agent could add `{"source": "directory", "path": "/Users/or"}` and get the host home bind-mounted into its next container. Host-side factory writes and copies also follow symlinks the agent can plant (`.claude-config` → a host directory; `AGENTS.md` → `~/.ssh/id_ed25519`, which re-sync's backup would copy into the agent-readable workdir). Three parts, all required:

1. **Factory-owned state outside the workdir.** The template copy and the re-sync backups move from `<workdir>/.factory/` to `FACTORY_HOME/state/agents/<slug>/` (`template/settings.json`, `template/mcp.json`, `resync/<ts>/`). `FACTORY_HOME/state` is never mounted. A one-time move at boot migrates existing agents (move the two files and any `resync/` dirs, then remove `<workdir>/.factory` only if it is a real directory owned by the factory layout; a symlink there is removed as a link). `templateCopyDir`/`resyncRoot` in `paths.ts` change; the S4 UI copy "Previous files saved in .factory/resync/…" shows the new path.
2. **Mounts from factory-owned inputs only.** `buildMounts` takes the workdir, the granted project paths (DB), the host skill dirs (host skills dir), the directory marketplaces declared in the factory-owned template copy (part 1), and the CLI bundle. The `extraKnownMarketplaces` carried forward from the agent's config-dir `settings.json` (agent-writable) never become mounts; an undeclared directory marketplace found there is dropped from the generated settings with a warn log. Every source is `realpath`ed, then **`checkMounts`** (one function, defence in depth) requires each source to be exactly one of: the agent's workdir (rw), a granted project path (rw), a declared host skill dir (ro), a declared marketplace dir (ro), the CLI bundle file (ro, the one non-parity target `/opt/factory/bin/open-factory`). It also refuses any source that is `/`, the host user's home directory, `FACTORY_HOME` or an ancestor of it, `FACTORY_HOME/state` or anything under it, or a Docker socket path (`/var/run/docker.sock`, `~/.docker/run/docker.sock`, the `DOCKER_HOST` unix path), or an ancestor of any of these. A refusal fails the start closed ("Mount <path> isn't allowed: <reason>.").
3. **Symlink-safe host writes.** Every host-side write, copy or delete under a workdir (`prepare`: config-dir `settings.json` and `CLAUDE.md`, `.mcp.json`, the `.claude/skills/<name>` and `projects/<name>` links; re-sync: copies and backups; create's rollback) goes through one helper that `lstat`s every path component below the workdir and fails ("<path> is a symlink; the factory won't write through it.") when a component the factory expects to be a directory or a file is a symlink. The factory-made links (`projects/<name>`, `.claude/skills/<name>`) are checked as links and recreated, never followed. Reads for backup use `lstat` and copy a symlink as a symlink (never its target's bytes). Docker agents' `prepare` runs only while their container is stopped (§10), so nothing inside it can race these checks. Re-sync of a running Docker agent writes its files and then restarts through `requestRestart` (unchanged).

Regression tests plant each escape and assert the start or re-sync fails closed: the marketplace path in the old template copy location and in the config-dir settings; `.claude-config` as a symlink to a temp "host" dir; `AGENTS.md` as a symlink to a temp "secret" file during re-sync (the backup holds a symlink, not the secret's bytes); `projects` as a symlink to a directory; a granted project that contains `FACTORY_HOME`.

The local runtime is not a boundary (the agent runs as the host user), but it gets the same code: one path for both runtimes.

### 11.5 Environment (decision Q15)

`buildAgentEnv(serverEnv, extra, runtime)`:
- **local:** S4 unchanged (the allowlist plus the factory vars).
- **docker:** only the factory vars: `CLAUDE_CONFIG_DIR`, the one credential var, the secrets, the git identity, and `OPEN_FACTORY_URL` (§11.6). The image provides `PATH`, `HOME` (Docker sets it from `-u agent`), `USER`, `SHELL`, `LANG`. Verified: passing `Env` on an exec keeps the image's `PATH`.

S4's negative test runs for both runtimes: `DATABASE_URL`, `FACTORY_SECRET_KEY`, the server's own `ANTHROPIC_*`/`CLAUDE_*` and an unknown var are absent, and for Docker no host `PATH` or `HOME` appears.

### 11.6 Reaching the factory (decision Q14)

Containers get `ExtraHosts host.docker.internal:host-gateway` and the CLI bundle (`apps/cli/dist/open-factory.js`, path from `FACTORY_CLI_BUNDLE`, default resolved next to the server build) mounted read-only at `/opt/factory/bin/open-factory`. `OPEN_FACTORY_URL` = `FACTORY_AGENT_URL` (default `http://host.docker.internal:<PORT>`). It carries no credential: agent auth is S6. A missing CLI bundle fails Docker starts with "Build the CLI first (pnpm build)" in development.

Verified on Docker Desktop: a server on host `127.0.0.1` is reachable from a container at `host.docker.internal`. On plain Linux it isn't: the README says to bind the factory to the Docker bridge gateway address (e.g. `HOST=172.17.0.1`) or run it on a compose network with the containers, and names `HOST=0.0.0.0` as the less safe fallback (it exposes the factory to the LAN). The live check (§18.5) proves reachability with `curl $OPEN_FACTORY_URL/api/status` from a container.

## 12. Local runtime: the process journal (decision Q9)

- While a local agent runs, `ProcessJournal` snapshots Claude's descendants with `ps -A -o pid=,ppid=,lstart=` (portable to macOS and Linux) and walks the tree from Claude's pid. It snapshots on `process_started`, on every `background_task_started`, and every 10 s **while a turn is open or a background task is live** (descendants can only outlive Claude through those).
- The journal is one JSON column, `agents.process_journal jsonb null`, replaced on each snapshot: `{claude: {pid, start}, descendants: [{pid, start}], tasks: [{taskId, description}], takenAt}`. Persisting it lets boot reconciliation clean up after a server crash (§5.6). It is cleared after a clean exit or a reap.
- **Reap** (after a crash, an escalation, or at boot): for each journaled pid, signal it **only if** `ps -o lstart= -p <pid>` returns the same start time (never signal a pid we can't prove is ours). SIGTERM all, wait 3 s, SIGKILL the survivors that still match. Bash tools run in their own session (`setsid`), so signalling a process group would miss them; the journal names each process.
- Best effort, documented: a process that detaches and is gone within one 10 s interval, or that was started and re-parented between snapshots, can be missed. Docker's container restart is the strong guarantee.

## 13. The local runtime gate (#18, decision Q10)

- `FACTORY_ALLOW_LOCAL_RUNTIME` (default `false`) in `config.ts`: an operator decision that no API or UI session can change.
- One rule, `localRuntimeAllowed(config)`, used by: `prepareStart` (fail closed, §10), the template validator (a **warning** on `runtime: local`: "The local runtime is disabled on this factory."), New agent (the same warning), and the status frame's `runtimeDisabled`.
- Bypass with local stays a validator error (S4).
- Local agents keep the Unsandboxed badge, and while the gate is off they show the disabled reason instead of failing silently on the first message.
- Rollout note in the PR: every S4 agent is local, so development setups add `FACTORY_ALLOW_LOCAL_RUNTIME=true` to `.env` (and `.env.example` documents it).

## 14. Harness changes (`packages/harness`)

- `Transport` interface (`write(line)`, `endInput()`, `lines: stdout/stderr`, `exit: Promise<{code, signal}>`, `terminate(): Promise<boolean>`, `forceKill(): Promise<void>`, `pid?`), `LocalTransport` (S3's spawn code, `detached: true`, SIGTERM/SIGKILL). `ClaudeProcess` takes a transport; `createClaudeDriver({log, transports})` picks one by `spec.runtime`. The Docker transport is injected from the server.
- `stop()` is idempotent (one promise per process).
- `system/session_state_changed` is dropped in the mapper and asserted to yield nothing; the fixture moves from `fixtures/pending/` next to the others in the same commit.
- `FactoryMessage.kind` widens to `"message" | "system"`; the envelope renderer is unchanged otherwise.
- A synthetic `rate-limit-event-rejected` fixture (documented SDK shape, labelled unverified in the README) for the mapper and the server tests.

## 15. Events, API and frames

New factory-only events (`packages/shared/src/events.ts`):

| Event | Payload | When |
|---|---|---|
| `hibernated` | `reason` | after the process exited (and the container stopped) on the hibernate path |
| `container` | `action: created \| recreated \| started, image, imageId` | each Docker wake |
| `cleanup` | `killedProcesses?: number, container?: "restarted" \| "stopped"` | leftovers reaped after a crash or escalation |
| `stop_escalated` | `how: sigkill \| container_stop` | §9.6 |
| `background_work_lost` | `reason, tasks, crons` | §9.4 |
| `reconciled` | `killedProcesses, stoppedContainer` | §5.6 |
| `control` | `cmd` gains `restart` | Restart |
| `rate_limit_paused` / `rate_limit_reset` | `credential, until, exact` | on the agent that hit the limit (paused) and on each owed agent at reset |

API: `POST /api/agents/:slug/restart`, `POST /api/agents/:slug/reset-session` (§9.7). Messages and compacts to an agent whose credential is paused return `202` as usual (they queue). `AgentSummary` and `agent_status` gain the §8.2 fields. `QueueItem.from` may be `@factory`.

## 16. Database (`packages/db`), one migration, additive

```
credentials  + rate_limited_until timestamptz null, rate_limit_exact boolean not null default true
agents       + last_error text null, error_kind text null, process_journal jsonb null,
               container_id text null, rate_limit_notice_owed boolean not null default false
messages     from_user_id drops NOT NULL; CHECK ((kind = 'system') = (from_user_id IS NULL))
```

No data rewrite: existing message rows have a user and `kind = 'message'`.

## 17. Failures

| Failure | What happens |
|---|---|
| Local start with the gate off | `error{source:"spawn", fix:"runtime"}`, errored (`start`), messages pending, the strip shows why. |
| Image missing and pull fails | Start fails with the registry error verbatim; errored (`start`). |
| Ready marker timeout / container exits at start | Start fails with the last 50 container log lines. |
| A mount refused by `checkMounts` | Start fails closed with the reason. |
| A symlink where the factory writes | Start or re-sync fails closed naming the path. |
| Factory runs as root with a Docker agent | Start fails: "The factory runs as root; Docker agents need a non-root host user." |
| Docker daemon unreachable | Start fails: "Can't reach Docker at <DOCKER_HOST or the default socket>: <error>." Boot reconciliation logs a warn and skips the Docker step (local agents still work). |
| Crash mid-turn | §9.2: cleanup, errored, one notice-led resume. |
| Idle crash with nothing live | `exited` row, hibernated. |
| Resume unrecoverable | errored (`resume_unrecoverable`), Start a new session offered, no attempts. |
| Stop timed out | §9.6 escalation; errored (`stop_failed`) only if that fails too. |
| Rate limit rejected | Credential paused (§7), deliveries held, continue notice at reset. |
| Server crash | Boot reconciliation (§5.6). |

## 18. Testing

No automated test calls a live model. Few, thorough tests per behaviour.

### 18.1 Unit

`statusOf` (table); `classifyResumeFailure` (the S0 fixture text, the two documented 400 texts, an unknown error); `checkMounts` (every allowed kind, every refused kind, realpath through a symlink, ancestors); the container create options (hardening: no `Privileged`, no host network or pid, `no-new-privileges`, tmpfs, extra hosts, only allowed binds); the spec hash (changes on image id, grants, uid; not on secrets); `buildAgentEnv` for both runtimes; the notice texts (lists omitted when empty; no exact time on the fallback); the journal's tree walk over canned `ps` output and its start-time match.

### 18.2 Harness

`ClaudeProcess` over a fake transport (writes, idempotent stop, terminate failure falls through to the timeout); the mapper drops `session_state_changed`; the `rejected` fixture maps to `rate_limited`.

### 18.3 Server (fake driver, fake timers, real Postgres)

- **Supervisor:** cap and FIFO; queued status; early hibernation picks the least recently active hibernatable agent and never a busy, pinned or mid-turn one; a paused credential's entry is skipped without losing its place; the boot rebuild orders by oldest pending message.
- **Warm timer:** starts only when hibernatable; a live non-ambient task, an owed notification (with the 30 s bound) and a live cron each prevent it; an ambient task doesn't; a one-shot cron unpins after its firing turn; `background-bash-start-finish` ordering.
- **Hibernate path:** every reason; Docker container stopped after exit; `background_work_lost` only for what was live; timed-out stop escalates.
- **Apply-restart:** waits for busy but not crons; the restart-crons notice; S4's existing restart tests still pass.
- **Crash:** idle crash → hibernated, no turn; mid-turn crash → cleanup, errored, one notice-led attempt, success clears; a second crash leaves errored with no further attempt; a human message makes one attempt; unrecoverable resume → no attempt.
- **Rate limit:** per-credential pause, held deliveries, the 30 min fallback, the reset timer, one notice per cut-off turn, notice and pending messages in one batch.
- **Restart / reset-session routes:** 409s, the notice, pending messages delivered first in the new session.
- **Boot reconciliation:** a journal with a live matching pid (a real `sleep` child spawned by the test) is reaped; a non-matching start time is never signalled; dangling turns closed; wakes queued.
- **Hardening regressions:** §11.4's planted escapes.
- **Gate:** start refused with the gate off, warning in the validator.

### 18.4 Docker integration (gated, `FACTORY_DOCKER_TESTS=1`, not in default CI)

Uses the local `open-factory-base:dev` image and the **fake claude** mounted into the container as `claudeBin` (the image has Node), so no model is called: create with the hardened options and the ready wait; exec, NDJSON round trip, stdin half-close, exit code; terminate through the pid file; hibernate stops the container; a spec change re-creates it; a crash restarts the container and the planted background `sleep` is gone; a file written through a project bind mount is owned by the host user; boot reconciliation stops a running labelled container; the server restart test (§5.6 invariant). Not in default CI because the image is 2.8 GB; the PR records a local run.

### 18.5 Live check (`pnpm smoke:docker`, not part of `pnpm test`)

Real `claude` in `open-factory-base:dev`, the token file read into the environment at run time (never printed), `--model haiku`, a throwaway DB and `FACTORY_HOME`, one granted temp git repo. Steps, each asserted and printed: a Docker agent remembers a word → it hibernates (warm window set to 1 minute in its template) and the container is stopped → a message wakes it and it recalls the word (AC1); it writes a file in the repo and creates a worktree: host-side `stat` owner and `git worktree list` match on both sides (AC5); a background `sleep 600` keeps it awake past the window (AC2); `curl $OPEN_FACTORY_URL/api/status` from the container answers (§11.6); `kill -KILL` of Claude in the container → container restarted, the `sleep` gone, one notice-led resume (AC4). The PR records the output.

### 18.6 Web

The new statuses and labels, the waiting-on strip, Restart and Start a new session (dialog), the Factory badge, lifecycle lines, the runtime-disabled reason. Details in the UI doc.

## 19. Verified for this design

| # | Claim | How | If wrong |
|---|---|---|---|
| V1 | `system/session_state_changed` (with `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`) reports `idle` right after each `result` **while a background task is still live** (idle at 3.4 s, the task ended at 11 s), and `running` before each `system/init`, emitted just after the empty `background_tasks_changed`. It is a turn signal, not a busy signal. | Claude Code 2.1.327, haiku; fixture `pending/session-state-changed-background` | #24 would simplify busy tracking. |
| V2 | A Docker exec started through the raw API (the hijacked stream dockerode uses) as `agent` with `Env` set keeps the image's `PATH`, `HOME=/home/agent`; half-closing the stream delivers stdin EOF; exec inspect returns the exit code. | Docker Desktop 29.9.3, `open-factory-base:dev`, a throwaway Node probe | Fall back to the docker CLI as the transport. |
| V3 | A server bound to host `127.0.0.1` is reachable from a container at `host.docker.internal` (Docker Desktop with `host-gateway`). | Same | Plain Linux needs the bridge-address bind (§11.6). |
| V4 | `/run/open-factory` is root-owned 0755: `agent` can't write the pid file there. | Same | — (pid file in `/tmp`) |
| V5 | Under `no-new-privileges` the entrypoint remap works (ready marker, `id` 502:20, a bind-mounted file owned 502:20 on the host) but `sudo -n true` as `agent` fails. | Same | — |

## 20. Product doc wording (for the lead; not edited here)

- `architecture/agent-runtime.md` → Rate limits and ADR 0008: the pause is **per credential**, not global; a `rejected` event without a usable `resetsAt` uses a 30-minute fallback; the cut-off agent gets a continue notice at reset.
- `architecture/agent-runtime.md` → Concurrency: when every slot is held and some holder is idle (not busy or pinned), the least recently active idle agent hibernates early to free a slot.
- `architecture/agent-runtime.md` → Crash handling: an idle crash with no live work hibernates without a resume; the automatic resume writes a factory notice and succeeds when that turn ends; unrecoverable resumes go to "Start a new session".
- `architecture/agent-runtime.md` → Docker details and `architecture/system-overview.md`: the wake queue is in memory, rebuilt from pending messages at boot, not a pg-boss queue; `data-model.md` "pg-boss owns … wakes" likewise.
- `architecture/workspace.md`: the template copy and re-sync backups live in `FACTORY_HOME/state/agents/<slug>/`, outside the workdir; Docker mounts come only from factory-owned inputs.
- `architecture/harness-driver.md`: `system/session_state_changed` is a turn signal, not a busy signal.
- `concepts/message.md`: a `system` kind from `@factory` (crash, restart, apply-change and rate-limit notices).
- `concepts/session.md` → Controls: "Start a new session" (errored after an unrecoverable resume).
- `architecture/base-image.md` → Contents / User: agent containers run with `no-new-privileges`, so the image's passwordless `sudo` doesn't work for agents; system packages belong in a user image.
- S4's Known gap "the product docs expect `settings.json` to keep agent changes" stands (unchanged by S5).

## 21. Decisions needing Or's call (owner-proxy certainty 3/5)

- **Q1 wake queue:** in memory, rebuilt from pending messages at boot, instead of pg-boss as the roadmap says.
- **Q6 sender:** notices are `system` message rows from `@factory` (nullable `from_user_id` with a CHECK), not raw turns.
- **Q9 journal mechanism:** `ps` snapshots on events and every 10 s while busy, start-time-verified reaping; best effort locally.
- **Q17 apply-restart vs crons:** a config change restarts a pinned agent without waiting for its crons, and the agent is told which crons stopped.
- **Q18 continue notice:** a rate-limit-cut turn gets one "continue" notice at reset.
- **Q11b no sudo in containers:** `no-new-privileges` on every agent container, reversing the S2 image's passwordless sudo for agents; system packages come from user images.

## 22. Issues consumed and follow-ups

Consumed: **#10** (the S2 runtime contract: HOST_UID/GID, tmpfs, ready wait with logs, `-u agent -w`, CLI mount), **#18** (gate), **#19** (restart policy and unrecoverable resumes), **#20** (leftover cleanup), **#24** (evaluated and rejected with V1; close), **#31** (apply-restart tells the agent which crons stopped; S9 still owns pinning UI). Also S4's PR notes: the timed-out stop, the owed notification, the double `proc.stop`, the workspace symlink and template-copy hardening, and Docker templates failing closed.

Untouched: **#23**, **#26** (a compact to a hibernated agent wakes it; durability stays a follow-up), #29, #30, #32–#36.

Follow-ups to open: base image sudo under `no-new-privileges` (S2 smoke test and docs, whether to drop sudo, an `allow_sudo` opt-in shape); container resource limits and `oom_score_adj`; pin `FACTORY_DEFAULT_IMAGE` to a released version or digest; verify the documented `rejected` rate-limit shape and the poisoned-resume texts when they occur; Linux factory reachability for containers in S6 (bind address and agent auth); persisting live crons (S9); the Docker integration tests in CI with a cached image.
