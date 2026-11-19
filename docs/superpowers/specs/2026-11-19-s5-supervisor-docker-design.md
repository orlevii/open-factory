# S5 Supervisor and Docker runtime: Technical Design

- **Date:** 2026-11-19
- **Status:** approved by owner-proxy (owner-s5), revised after the spec self-review and the impeccable UI review; pending Or's review on the low-certainty items (§21)
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

From the roadmap, made testable. ACs 1, 2, 4 (Docker), 5 and 6 (Docker) are proven by the gated Docker tests (§18.4) and the live check (§18.5), not by default CI; the rest by default CI.

1. **Wake from Docker.** A message to a hibernated `runtime: docker` agent creates or starts its container, resumes the session, and the agent answers with its earlier memory intact (it recalls a word from a turn before hibernation).
2. **Busy never hibernates.** An agent with a live background task is still running when its warm window expires; it hibernates only after the task ends and the window then elapses. The strip shows the task under "Waiting on" (fake driver: exact description; live check: a `sleep 600` whose description contains `sleep`).
3. **Cap.** With `FACTORY_MAX_RUNNING_AGENTS=2` and two agents mid-turn, a third woken agent shows `queued` and starts when a slot frees up. With two idle-warm agents, a third wake makes the least recently active one hibernate ("Hibernated to free a slot") and starts as soon as that process has exited.
4. **Crash.** Killing Claude mid-turn (SIGKILL) kills its leftover background shells, marks the agent `errored`, and makes exactly one automatic resume whose first batch begins with a factory notice; the agent recovers. If that resume also fails, the agent stays `errored` and offers Restart.
5. **Ownership and parity.** Files a Docker agent writes into a granted project are owned by the host user, and `git worktree list` gives the same output on the host and in the container.
6. **Factory restart.** Restarting the server while agents run (local and Docker) leaves no orphaned Claude process or running container and never runs two processes for one session. Agents that had pending messages wake; agents that were mid-turn or had live background tasks get one notice-led resume.
7. **Rate limit.** A `rejected` rate-limit event (fake driver, documented shape) pauses wakes and deliveries for agents on that credential only, shows `rate_limited` with its time, and at reset the cut-off agent gets one continue notice.
8. **Local gate.** With `FACTORY_ALLOW_LOCAL_RUNTIME` unset, a local agent doesn't start and says why; with it set, it runs and shows Unsandboxed.
9. **No host escape through the workspace.** Each planted escape in §11.4 and §11.7 fails closed (regression tests).
10. CI is green. The gated Docker tests and the live check (§18.5) have been run once and their output, plus a manual pass through ACs 1–8 in the browser, is recorded in the PR.

## 3. Scope

**In:**
- the `Supervisor`: wake queue, global cap with FIFO and early hibernation, warm timers, per-credential rate-limit pauses, boot reconciliation;
- hibernation (warm window, eviction, apply-restart, shutdown) through one hibernate path;
- busy tracking and a minimal in-memory cron pin; the "waiting on" detail;
- crash handling: leftover cleanup, one automatic resume with a factory notice, Restart, "Start a new session";
- the Docker launcher: container lifecycle with dockerode, exec transport, mount builder with an allow-check, image pull and re-create;
- the local process-tree journal and the `allow_local_runtime` gate;
- workspace hardening before Docker isolation (factory-owned state and plugins outside the workdir, symlink-safe host writes, staged re-sync);
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
  │                 ├─ warm timer, hibernate path, crash policy, escalation
  │                 └─ reports hibernatable / exit / rate limit to the Supervisor
  │
  ├─ Supervisor (one per server): cap, FIFO wake queue, eviction, credential pauses, closing latch, boot reconciliation
  │
  └─ start path: Supervisor grants a slot → (Docker: image present) → prepareStart (workspace lock) → Launcher
                     Launcher(local):  LocalTransport (child_process) + ProcessJournal
                     Launcher(docker): ContainerManager (dockerode) → DockerExecTransport
                                         ↑ buildMounts + checkMounts
                  ClaudeProcess (S3, now over a Transport): mapper, NDJSON writes, stop()
```

| Unit | Location | Owns |
|---|---|---|
| `Transport` interface, `LocalTransport` | `packages/harness/src/transport/` | Byte-level stdio, exit, terminate (SIGTERM-equivalent), forceKill. `ClaudeProcess` keeps the mapper, writes and the stop sequence, and now runs over a transport. |
| `DockerExecTransport` | `apps/server/src/runtime/docker/exec-transport.ts` | The hijacked exec stream, stdin half-close, demuxed stdout/stderr, exit code from exec inspect, in-container `kill -TERM` (§11.3). |
| `ContainerManager` | `apps/server/src/runtime/docker/containers.ts` | Image presence and pull, create (hardened options), start, ready-marker wait, stop, remove, re-create on spec-hash change, listing by label. |
| `buildMounts` + `checkMounts` | `apps/server/src/workspace/mounts.ts` (S4's file) | Mounts from factory-owned inputs only; the allow-check (§11.4). |
| `SafeFs` | `apps/server/src/workspace/safe-fs.ts` | Symlink-safe writes, copies and deletes under a workdir (§11.4 part 3). |
| `ProcessJournal` | `apps/server/src/runtime/local/journal.ts` | Descendant snapshots and verified reaping (§12). |
| `Supervisor` | `apps/server/src/supervisor/supervisor.ts` | Slots, the wake queue, eviction, credential pauses and reset timers, the closing latch, boot reconciliation. |
| `statusOf` | `packages/shared/src/status.ts` | The one pure precedence function (§8.1). |
| `classifyResumeFailure` | `apps/server/src/agents/resume-failure.ts` | Unrecoverable vs ordinary resume failures (§9.3). |
| notice builders | `apps/server/src/agents/notices.ts` | The fixed texts of every `@factory` message (§9.5). |

Nothing outside `packages/harness/src/claude/` knows a stream-json field name (S3 rule). Nothing outside `runtime/docker/` imports dockerode.

## 5. Supervisor

### 5.1 Why not pg-boss (decision Q1)

The roadmap says wake requests run through pg-boss. S5 doesn't: a slot is held by a **live process**, not by a job, and "who is waiting" is already durable as `pending` message rows. A pg-boss queue would be a second copy of that truth and a job model that doesn't fit long-lived processes. The wake queue is in memory, owned by one `Supervisor`, and rebuilt at boot from the database (§5.7). pg-boss arrives with the first durable timer (S6 debounce or S9 schedules). The product docs' wording is listed for the lead (§20).

### 5.2 Slots and the cap

- `FACTORY_MAX_RUNNING_AGENTS` (default 8, min 1) in `config.ts`. The Supervisor is the only owner of the cap.
- A **slot** is held from the moment a start is granted until the process has exited and, for Docker, its container is stopped. Warm-idle processes hold slots (product rule).
- **Every exit releases the slot** once the exit is recorded and (Docker) the container is stopped, with one exception: `stop_failed` (§9.6) keeps it, because a process may still run (a late exit of that process releases it). Releases happen inside the agent's `exited` job; a recovery start that follows requests a new slot like any other wake (the cap and FIFO apply to it).
- **A start that fails before a process exists releases the slot too.** `startNow` releases it in a `finally` on any throw before the launch (gate off, `prepareStart`, `checkMounts`, `SafeFs`, root host user, Docker unreachable, missing CLI bundle, ready-marker timeout), and stops a container it had already started.
- `requestWake(agentId, reason)` is the only way a process starts. Callers: a send or compact API job, crash recovery, Restart, Start a new session, a rate-limit reset, boot reconciliation, the end of a hibernate with items still queued. A wake is **only granted when the agent has a deliverable item** (a pending message or notice, or a queued compact): after `--resume`, `system/init` only arrives after a user line is written (S3 Q23), so a start with nothing to write would never confirm. Restart and the recovery paths always create a notice first, so they always have one.
- **Dedupe:** at most one queue entry per agent; a second request for a queued agent keeps the original place. A wake for an agent that is running, **granted** (a slot handed over whose job hasn't run yet), starting, archived, `stop_failed`, `resume_unrecoverable` or attempting (§9.2) is dropped. An inline start removes any queue entry for that agent.
- **Errored agents** wake only for these reasons: `crash_recovery`, `restart`, `reset`, and a `message` from a human. Never for `boot`, `queued_items`, `rate_limit_reset` or a system notice (§9.2).
- **Granting order:** strict FIFO by first request time. An entry whose agent's credential is currently paused (§7) is skipped without losing its place and becomes eligible at reset. The credential is read at grant time, so a credential change while queued takes effect.
- **Granting is synchronous bookkeeping:** the Supervisor marks the agent `granted` before enqueueing its grant job, and the job re-checks the whole eligibility predicate (not archived, not running or starting, not closing, credential not paused, something deliverable); if it fails, the slot is released at once and, for a pause, the entry goes back to its place. `startNow` re-checks the pause right before the launch too, so a pause that lands between grant and launch re-queues instead of starting a process that could never write its first line.

### 5.3 Early hibernation when the cap is full (decision Q2)

When the queue has an eligible entry and every slot is held, the Supervisor picks the **least recently active hibernatable** holder (`lastActivityAt`: the last turn end, delivery or start; §6.3) that isn't already being evicted, records it in `pendingEvictions`, and asks it to hibernate with reason `freed_slot`. In the victim's job, hibernatable is **re-checked**; if it no longer holds (a message arrived meanwhile), the victim refuses, leaves `pendingEvictions`, and the Supervisor picks again. Holders already stopping for another reason count as slots on their way. It evicts only while `eligible entries > pendingEvictions + holders already stopping`, so it never frees more slots than the queue needs. When the victim's exit releases its slot, the slot goes to the head of the queue. Busy, pinned and mid-turn agents are never evicted. The Supervisor re-runs this whenever an agent becomes hibernatable while the queue has eligible entries.

### 5.4 Queued status

An agent with an entry in the wake queue is `queued` (unless a higher-precedence status applies, §8.1). The entry is in memory; what caused it is durable (message rows, notices), so nothing is lost if the server stops.

### 5.5 Jobs and the deadlock rules

S3's per-agent serial job queue stays the only serialization. Two kinds of runtime methods exist:

- **Internal primitives**, callable only from inside that agent's own job: `startNow(reason)` (prepare, launch, `process_started`, flush), `beginHibernate(reason)`, `beginForceStop()`. They never await anything that is itself a job of the same agent. Stops are started and **not awaited** (S4's rule): `proc.stop(...)` is called and its promise observed outside the job; the work that must follow the exit (release the slot, stop the container, wake again, escalate) runs in the `exited` job, driven by an `afterExit` intent recorded when the stop began: `{kind: "hibernate", reason}` | `{kind: "restart", by}` | `{kind: "failed_start"}` (S3's stop after a spawn or resume failure, `failingProc`) | `{kind: "internal"}` (S3's `onJobFailure` stop). `failed_start` and `internal` release the slot and never wake. An `exited` with no recorded intent and `expected: false` is a crash (§9.1).
- **Public methods** (`sendMessage`, `compact`, `interrupt`, `restart`, `resetSession`, `hibernate(reason)`, `requestRestart`, `grant(slot)`) each enqueue one job that calls the primitives.

The Supervisor never awaits an agent's job from inside another job. Granting a slot to agent B from agent A's job (A just released) only **enqueues** B's `grant` job. A grant to the requesting agent itself (a send whose wake is granted at once) runs `startNow` inline in that same job, so S3's synchronous `503 agent_start_failed` keeps working for an immediate start failure. A granted start whose job finds the agent no longer eligible (§5.2) releases the slot at once.

### 5.6 Closing latch (shutdown)

`app.close()` first sets `Supervisor.closing`: no new grants, the wake queue frozen (entries dropped; their causes are durable), every warm, eviction, owed-notification and rate-limit timer cleared, and each runtime's `noStart` latch set, so no send, timer or reset can start a process after shutdown begins. The latch is set on **every loaded runtime**, and `startNow` re-checks it right before the launch (S3's `refuseWhileStopping` point), so a start already inside `prepareStart` never launches. In-flight image pulls are aborted. Only then does it hibernate every running runtime (§6.6).

### 5.7 Boot reconciliation (decisions Q5, R2)

Runs in `buildApp` after migrations and **before the server listens**:

1. **Local leftovers.** For every local agent whose `runtime_journal` (§12) names a Claude process: reap Claude and its journaled descendants (verified by start time, §12).
2. **Docker leftovers.** List containers labelled `io.open-factory.agent-id`. For each whose agent id exists in this database: if running, stop it (a Claude whose exec lost its client sees stdin EOF and keeps draining background tasks inside, so the container stop is required before any resume). Containers whose agent id isn't in this database belong to another factory or a deleted agent and are left alone, logged once at info. If Docker is unreachable, the step logs a warn and is skipped; every Docker start stops a running container before it prepares anyway (§10), so a missed leftover can never run next to a new process.
3. **Dangling state.** Turns with `ended_at` null are closed with `terminal_reason = "factory_restarted"`, `is_error = true`. Per affected agent a `reconciled{killedProcesses, stoppedContainer}` event is appended, plus `background_work_lost{reason: "factory_restarted"}` for the tasks and crons its journal recorded live (§9.4).
4. **Attempts cut short.** Every agent with `attempting = true` (§9.2) was in an attempt when the server stopped: it is set errored (`error_kind = "crash"`, or kept if already set), `attempting` cleared, and it is not woken. This is what stops a crash-looping server from spending tokens on every boot.
5. **Interrupted work (R2).** A non-archived, non-errored agent that had a dangling turn (from the turn rows) or recorded live non-ambient tasks gets the "factory-restarted" notice (§9.5). A graceful shutdown already created that notice (§6.6). Either way the agent's wake in step 6 is its **single automatic attempt**: `attempting` is persisted as it is woken (§9.2).
6. **Wakes.** For every non-archived, non-errored agent with pending messages or notices, `requestWake(…, "boot")` (`boot_resume` when a factory-restarted notice is among them), ordered by the agent's oldest pending item so FIFO survives the restart. Reset timers are re-armed for every credential with `rate_limited_until` in the future; credentials whose window passed are cleared and their owed continue notices created (§7.3). Agents that were merely warm with nothing pending stay hibernated.
7. Every `runtime_journal` is cleared.

Invariant: **never two processes for one session.** A test restarts the server with a live local agent and a live Docker agent (fake claude) and asserts there is exactly one process per agent afterwards.

## 6. Hibernation, busy and pinning

### 6.1 Busy

An agent is **busy** while any of these hold (S4's restart conditions, now shared):
- the process is starting, a turn is open, a batch is in flight or awaiting its turn, a compact is in flight, or an urgent hold is active;
- the live **non-ambient** background-task set is non-empty (from `background_tasks`, reset on `process_started`, S3/S4);
- a notification turn is **owed** (S4's counter), with a new **30 s bound**: the timer is armed only while no turn is open (on `background_task_finished` with no open turn, and re-armed at each `turn_end` while the counter is above zero); when it fires with the counter still above zero and still no turn open, the counter resets to 0 and a warn log names the agent. It fixes "an owed notification turn that never arrives blocks restart forever" without firing during a running turn.

`system/session_state_changed` is **not** used: it reports `idle` while a background task is still live (§19 V1, closes #24).

### 6.2 Pinning by in-session crons (decision Q4)

- `AgentRuntime` keeps the live cron set in memory from `cron_created` / `cron_deleted`: `{cronId, recurring, humanSchedule, nextFireAt, createdAt}`. It is reset on `process_started` and cleared on `exited` (crons die with the process). It is also written to `runtime_journal.crons` (§12) so boot can report lost crons.
- A one-shot cron is dropped once its `nextFireAt` has passed **and** a turn with `originKind: "cron"` has ended after it (one-shots auto-delete with no `CronDelete`, S0). Any cron is dropped 7 days after `createdAt` (Claude's expiry).
- **Pinned** = the set is non-empty. A pinned agent is never hibernated by the warm window or by eviction. It still holds its slot (accepted: up to 7 days). Explicit actions (apply-restart §6.5, Restart, shutdown, archive) still stop it, and the crons that were live are recorded as lost (§9.4).
- S9 adds persistence, the badge and the kill action.

### 6.3 Hibernatable and the warm timer

**Hibernatable** = process running and started, not busy, not pinned, no restart, stop or attempt in progress, not errored, and nothing deliverable is queued for it **unless** its credential is paused (D1: held deliveries are pending rows the reset wakes, so a paused agent doesn't pin a slot for the whole window, which can be days).

The **warm timer** (one per runtime) starts whenever the agent becomes hibernatable and is cancelled whenever it stops being so. Duration: the snapshot's `warm_window_minutes` (default 70). On expiry it enqueues a job that re-checks hibernatable and calls `beginHibernate("warm_window")`. One function `updateWarmTimer()` runs at the end of every job (events, API calls, timers), so every input change re-evaluates it; it also notifies the Supervisor when the agent becomes hibernatable (§5.3).

### 6.4 The hibernate path (one path)

`beginHibernate(reason)`, `reason ∈ warm_window | freed_slot | apply_changes | shutdown | archived`, inside a job:
1. re-checks hibernatable for `warm_window` and `freed_slot` (a refusal returns, and for `freed_slot` tells the Supervisor); `apply_changes` checks only "not busy" (crons don't block it, §6.5); `shutdown` and `archived` don't check;
2. sets `stopping` and records `afterExit = {kind: "hibernate", reason}`; **while `stopping` or `restarting` is set, `flush()` writes nothing** (a message sent during the stop stays queued instead of being written to a closing stdin);
3. snapshots the live non-ambient tasks and crons (for §9.4);
4. calls `proc.stop({graceMs: 3000, termWaitMs: 10_000})` without awaiting it.

The `exited` job then: appends `background_work_lost` if the snapshot is non-empty; for `shutdown`, if a turn was open or non-ambient tasks or crons were live, creates the "factory-restarted" notice row so the next boot resumes the agent (§5.7); for Docker, stops the container (§11.3; a failing container stop makes the agent `stop_failed`, §9.6); appends `hibernated{reason, idleMinutes?}` (`idleMinutes` for `warm_window`); releases the slot; and, unless the reason is `shutdown` or `archived` or `closing` is set, calls `requestWake(…, "queued_items")` when the delivery queue is non-empty (fixes a message sent during the stop grace getting stuck). If the stop **timed out**, the escalation (§9.6) runs instead of leaving the agent errored.

Hibernation keeps the session id, the working dir and the container.

### 6.5 Apply-restart under S5 (S4's `requestRestart`, decision Q17)

`requestRestart` keeps S4's seam and callers. Its body becomes "hibernate when not busy, then wake if needed":
- It waits for everything that makes an agent busy (§6.1), **but not for crons**: a pin can last 7 days, and a revoked grant or credential must stop applying.
- At the safe moment it runs `beginHibernate("apply_changes")`. If crons were live, the `exited` job creates the "restart-crons" notice (§9.5), so the agent wakes right away and can recreate them. If items are queued, it wakes to deliver them (S4 behaviour). Otherwise it stays hibernated until the next message.
- Docker: grants, image and mounts are in the container spec hash (§11.2), so the next start re-creates the container when they changed. Secrets and the credential are exec env and never re-create it.

S4 fixes included (listed in the PR's Changes section, since they change S4 behaviour): the 30 s owed-notification bound (§6.1); `ClaudeProcess.stop()` is idempotent (a second call returns the first call's promise, fixing the double `proc.stop`); a timed-out stop escalates (§9.6) instead of leaving the agent errored until a server restart; flush is held during every stop.

### 6.6 Shutdown

After the closing latch (§5.6), `app.close()` runs `hibernate("shutdown")` on every running runtime in parallel (S3 timing: close stdin, 3 s, SIGTERM, 10 s; Docker containers are then stopped, which takes well under a second because a container stop kills every process in it once `tini` exits, §19 V8), then waits for each job queue to drain. S3's 20 s force-exit budget is unchanged. Lost background work is recorded (§9.4) and the agents that were mid-turn or had live tasks get the factory-restarted notice and resume at the next boot (§6.4, §5.7). Containers are stopped, never removed.

## 7. Rate limits (decisions Q3, Q18)

### 7.1 Detection

Only the mapper's `rate_limited` event (S3: emitted only for `status: "rejected"`) pauses anything. `allowed_warning` stays a dropped line in the mapper (no pause); surfacing it is S10's usage work. The `rejected` shape is documented but unverified (S0); the fixture is built from the documented SDK shape and labelled unverified.

### 7.2 Per-credential pause

- `credentials.rate_limited_until timestamptz null` and `credentials.rate_limit_exact boolean not null default true` (additive). On a `rate_limited` event: `resetsAt` (epoch seconds) → `until`, `exact = true`; if it is missing, unparseable or in the past, `until = now + 30 min`, `exact = false`, and a warn log says the reset time wasn't reported.
- A later event that extends the window wins; it never shortens.
- While `now < until` for a credential:
  - queued wakes of agents on it are skipped (§5.2), keeping their place;
  - running agents on it **hold deliveries**: `flush()` writes nothing (messages and compacts stay queued). An urgent interrupt is still written (it costs no model call);
  - running agents on it are hibernatable when otherwise idle (§6.3, D1);
  - an agent's status follows §8.1.
- Events: `rate_limit_paused{credential, until, exact}` on the agent that hit the limit.
- One Supervisor timer per paused credential fires at `until` (re-armed at boot, §5.7): it clears the columns, appends `rate_limit_reset{credential}` to each owed agent, creates the owed continue notices, requests wakes (FIFO) for agents on it with pending items, and flushes running ones.

### 7.3 The continue notice

- When a turn ends after a `rate_limited` event in that same turn, the agent row gets `rate_limit_notice_owed = true`. At most one per cut-off turn: a second rejection while the flag is set adds nothing.
- At reset, each owed agent gets the "rate-limit-reset" notice (§9.5), which rides the normal wake path (cap, FIFO). If messages are pending, the notice and the messages go out as **one** batch turn with the notice first (§9.5 ordering). The flag clears when the notice is created.
- The notice names the credential and states the reset time only when it was exact.

## 8. Status

### 8.1 Precedence (decision Q16)

`AgentStatus = hibernated | queued | working | idle | rate_limited | errored` (S7 adds `terminated`). Only `errored` is stored (S3 Q12). One pure function in `packages/shared` owns the precedence:

```
statusOf({errored, attempting, working, credentialPaused, hasPendingWork, queuedWake, processRunning}):
  errored && !attempting                            → errored
  working (starting, turn open, batch awaiting, compact in flight) → working
  credentialPaused && (processRunning || hasPendingWork || queuedWake) → rate_limited
  queuedWake (including a pending image pull)       → queued
  attempting                                        → working   (an attempt's process is running between turns)
  processRunning                                    → idle
  otherwise                                         → hibernated
```

`attempting` (§9.2) is set while an attempt to recover an errored agent is in progress, so the UI shows what the attempt is doing (queued, rate-limited, working), not Errored, and offers no Restart in the middle of it. A hibernated agent with nothing pending on a paused credential stays `hibernated`. Table-driven tests cover every row, including errored on a paused credential (errored), queued on a paused credential (rate_limited), an attempt waiting for a slot (queued) and an attempt running (working).

### 8.2 The status frame

`agent_status` and `AgentSummary` gain:
- `rateLimitedUntil?: string` (ISO) and `rateLimitExact?: boolean`;
- `waitingOn: {tasks: {taskId, description, startedAt}[], crons: number}` (non-ambient tasks only; `startedAt` is when the factory first saw the task; the client computes "3m"), empty when nothing keeps it awake;
- `runtimeDisabled?: string` for local agents while the gate is off (§13);
- `errorKind?: "start" | "resume" | "resume_unrecoverable" | "crash" | "stop_failed" | "internal"`;
- `image?: string` (Docker agents: the image reference of the last start);
- `pulling?: boolean` (its image is being pulled, §11.2).

`GET /api/agents` also returns `running: {count, max}`, and a factory-wide `{type: "supervisor", running, max}` frame goes to every socket when either changes. The frames stay deterministic (no relative times), so they're only republished when something changes.

### 8.3 Persisted error

`agents.last_error text null`, `agents.error_kind text null` and `agents.attempting boolean not null default false` (additive) persist the error, its kind and whether an attempt is in progress, so an errored agent still says why after a server restart and boot can tell an attempt that was cut short (§5.7 step 4). `last_error`/`error_kind` clear with the errored status; `attempting` clears on every attempt outcome.

## 9. Crashes and recovery (decisions Q6–Q8)

### 9.1 What counts as a crash

An `exited` with `expected: false` and no recorded `afterExit` (§5.5), **whether or not the agent is already errored or attempting** (S3's `!e.expected && !this.errored` test is replaced, so a crash during an attempt is still cleaned up). For Docker: the exec stream ends without the factory having asked it to stop (the container itself keeps running `sleep infinity` after Claude exits, so "container still running" means nothing on its own), or the container dies.

### 9.2 Policy

**Attempts.** An *attempt* is a start meant to bring back an agent whose work was interrupted: the automatic crash recovery, a boot resume of interrupted work (§5.7), a human message to an errored agent, Restart, and Start a new session. One flag, `attempting` (persisted, §8.3), covers all of them: set when the attempt's wake is requested, cleared on its outcome. **Success** = the process emits `session_started` and the attempt's **batch turn** ends with the process still running; the batch turn is the first `turn_end` with no `originKind` after the batch carrying the notice (or the human's message) was written (S3's attribution rule, so post-resume orphan-report and task-notification turns don't count). Success clears `attempting` and errored. Any failure (a crash, a resume failure, a start failure) clears `attempting` and leaves or sets errored. While attempting, every new wake request is dropped (§5.2) and Restart and Start a new session return `409 attempt_in_progress`.

In the `exited` job of a crash:
1. **Clean up leftovers first:** local, reap the journal (§12); Docker, stop the container (it's started again by the next wake). A `cleanup{killedProcesses?, container?: "stopped"}` event records it.
2. **A crash during any attempt** (`attempting` was set): clear `attempting`, set errored (`error_kind = "crash"`), release the slot, no automatic attempt. Only a human acts next.
3. **Was anything lost?** If no turn was open, no non-ambient task and no cron was live, and nothing is queued: append the `exited` row, set **hibernated** (not errored), release the slot. No resume, no tokens.
4. Otherwise: set errored (`error_kind = "crash"`), append `background_work_lost` for what was live (§9.4), create the "crash" notice (§9.5), release the slot, set `attempting`, and `requestWake(…, "crash_recovery")`: **one automatic attempt**, through the cap, FIFO and the rate-limit pause.
5. After a failed attempt, only a **human** action makes another: a message from a human (one attempt, same rules) or Restart. Nothing the factory does on its own retries an errored agent: system notices never wake one (§5.2), and boot doesn't wake errored agents.

### 9.3 Resume failures (#19, decision Q7)

A resume failure is the mapper's `error{source: "resume"}` before `session_started`; the runtime stops that process itself (S3), so its exit is **expected** and is not a §9.1 crash. It is the failed result of whichever attempt started the process (a human message, a recovery, Restart, a boot wake). `classifyResumeFailure(errorText, apiErrorStatus?)`, one function:
- `"No conversation found with session ID"` (S0 fixture `error-resume-missing-session`) → **unrecoverable**;
- a 400 whose text contains `diagnostics.previous_message_id` or `Could not process image` → **unrecoverable** (documented by the Agent SDK, **unverified**; the code and the test say so);
- anything else → **ordinary**.

Either way `attempting` clears (§9.2). An ordinary failure sets `errored`, `error_kind = "resume"` and makes no automatic attempt of its own (the failed start *was* the attempt); a human message or Restart tries again, and Start a new session is also offered. An unrecoverable failure sets `error_kind = "resume_unrecoverable"`: no attempt from any source; new messages stay pending without triggering one (the error says why); only **Start a new session** recovers (§9.7). When unsure, don't wipe: anything unclassified is ordinary.

### 9.4 Lost work

`background_work_lost{reason: "crash" | "apply_changes" | "shutdown" | "archived" | "restart" | "factory_restarted", tasks: {taskId, description}[], crons: {cronId, humanSchedule}[]}` is appended when live non-ambient tasks or crons die with a process. It lists only what the factory saw live. A server log line at info carries the same, naming the manager ("would notify @lead"): S6 forwards it to the manager or the humans.

### 9.5 System messages from `@factory` (decision Q6 (i))

- `messages.from_user_id` becomes nullable; `messages.kind` (already present) gains `system`; `messages.notice text null` names the notice type (`crash`, `factory_restarted`, `restart`, `restart_crons`, `rate_limit_reset`). A CHECK ties sender and kind: `(kind = 'system' AND from_user_id IS NULL AND notice IS NOT NULL) OR (kind <> 'system' AND from_user_id IS NOT NULL AND notice IS NULL)`. Additive: existing rows stay valid. No sentinel user. S6 rewrites this CHECK when agent senders (`from_agent`) arrive.
- `factory` joins the shared `RESERVED_HANDLES` (`packages/shared/src/handle.ts`), so no human can sign up as `@factory`.
- System messages go through the same pending → delivered path, appear in the queue (`QueueItem.kind: "notice"`, `from: "@factory"`), and are delivered as `<factory-message from="@factory" kind="system" …>`. `FactoryMessage.kind` widens to `"message" | "system"`, `toFactory` passes the row's kind (S3 hard-codes `"message"`), and the `message_in` event schema's `messages[].kind` widens the same way (S3's `z.literal("message")` would make every history page with a notice fail to parse).
- **Ordering:** a notice goes to the **head** of the delivery queue, ahead of older pending messages and rolled-back batches, so the first batch after a crash, restart or reset begins with it. `pendingQueue` orders `kind = 'system'` first, then `created_at`, and **left**-joins `users` (S3's inner join would drop sender-less rows). One notice of each type per agent at a time: creating one while a **pending** (not yet written) one of the same type exists replaces its body; a written (in-flight) one is never touched.
- The S4 CLAUDE.md "How messages reach you" section gains one sentence: "Messages from `@factory` are notices from the factory itself (restarts, recoveries, rate limits)."
- Texts (`notices.ts`), every claim literally true:
  - **crash:** "Your previous process stopped unexpectedly (exit code 137) during a turn. These background tasks were stopped: `pnpm test`. These crons were stopped: every 5 minutes. Check the state of that work and continue where you left off." ("exit code N" or "signal SIGKILL" as reported; "during a turn" only when a turn was open; each list omitted when empty);
  - **factory-restarted:** "The factory restarted while you were working. These background tasks were stopped: …. Check the state of that work and continue where you left off.";
  - **restart:** "Restarted by @or after an error." (+ the lost lists when non-empty);
  - **restart-crons:** "Your session was restarted to apply configuration changes. These crons were stopped: …. Recreate them if you still need them.";
  - **rate-limit-reset:** "The rate limit on credential `work` reset at 14:30. Continue where you left off." (without "at 14:30" when the window wasn't exact).

### 9.6 Escalation of a stop that won't finish (decision Q8)

When `stop()` resolves `{timedOut: true}` (no exit after close-stdin, grace and SIGTERM), a job runs:
- **local:** SIGKILL Claude, then reap the journal (§12);
- **Docker:** stop the container (immediate: everything in it dies).

A `stop_escalated{how: "sigkill" | "container_stop"}` event records it, then the normal `exited` handling runs with the recorded `afterExit`. If the escalation also fails (the pid survives SIGKILL, the Docker API errors), or a container stop fails anywhere else (a hibernate's or crash's `exited` job), the agent becomes `errored` with `error_kind = "stop_failed"` and **keeps its slot** (a process may still run); every wake is refused for it except Restart. A late exit of that process releases the slot and leaves the agent errored.

**Restart of a `stop_failed` agent** makes one more escalation try (local: SIGKILL and journal reap; Docker: container stop, then remove if the stop fails again). If it succeeds, the slot is released and the restart's wake follows as usual; if it fails, the agent stays `stop_failed`, no wake is requested, and the error says so ("The agent's process can't be stopped. Check the host (pid 4242) or Docker, then restart again."; the detail, not the status line, carries the pid).

### 9.7 Actions

- **`POST /api/agents/:slug/restart`** (Restart). `409 not_errored` unless errored; `409 attempt_in_progress` while an attempt runs; `409 resume_unrecoverable` (with "Start a new session instead."); `409 runtime_disabled` while the local gate is off. In a job: create the "restart" notice, append `control{cmd: "restart", by}`, set `attempting`, then if a process or container is left, `beginForceStop()` (SIGTERM, 3 s, then SIGKILL plus journal reap; Docker: container stop) with `afterExit = {kind: "restart", by}`, whose `exited` job requests the wake; otherwise request the wake now. A `stop_failed` agent follows §9.6. One attempt; a failure leaves the agent errored with the reason.
- **`POST /api/agents/:slug/reset-session`** (Start a new session). Allowed only when errored with `error_kind ∈ {resume, resume_unrecoverable}` (else `409`). In a job: clear `session_id`, append `session_reset{by}`, **delete pending system notices** (they describe the old session, e.g. "Restarted by @or after an error."), clear errored, and if human messages are pending set `attempting` and `requestWake(…, "reset")` (they become the first turn of the new session). The old session JSONL stays on disk (a fresh id already stops it being resumed). The UI confirms first.
- `pnpm agent:reset-session` and `apps/server/scripts/reset-session.ts` are **deleted**, and the S4 session copy that names it is replaced by the action.

## 10. Start path (`startNow` and `prepareStart` under S5)

`startNow(reason)`, inside the agent's job, with a slot granted:
1. **Runtime gate** (§13): a local agent with the gate off fails first: `AgentStartError("The local runtime is disabled on this factory. Set FACTORY_ALLOW_LOCAL_RUNTIME=true to run agents unsandboxed.", "runtime")`. `"runtime"` joins S4's `StartFix` union (`apps/server/src/agents/errors.ts`) and the `error.fix` enum in `packages/shared/src/events.ts`; the UI renders no link for it (the strip's disabled segment explains it, UI doc §3.2).
2. **Docker: the container is stopped** if it is running (whatever left it running: a missed reconciliation, a dropped exec stream), so nothing inside it can race the host-side checks and no leftover Claude runs beside the new one. The image must already be present (§11.2: pulls happen before the grant, outside the job).
3. S4's `prepareStart` (workspace lock, `Workspace.prepare`, env), with: the factory-owned state and plugin layout (§11.4, §11.7); staged re-sync files applied (§11.4 part 4); `buildAgentEnv(serverEnv, extra, runtime)` (§11.5).
4. Docker: `ContainerManager.ensure(spec)` (create or re-create by spec hash, start, ready marker; §11.1, §11.2), outside the workspace lock. Then the exec transport.
5. Re-check the closing latch and the credential pause right before the launch (§5.2, §5.6); a hit releases the slot (and re-queues for a pause).
6. `process_started{resumed, reason}` and flush.

Any throw before the launch releases the slot and stops a container this start started (§5.2).

**Canonical paths.** `FACTORY_HOME` is canonicalized with `realpath` at boot (after it is created), so every workdir is canonical; project paths are already stored as their realpath (S4); host skill paths are resolved to their realpath (S4). Mount targets therefore equal their sources and path parity holds even where the host has symlinked prefixes (macOS `/var` → `/private/var`): `git worktree list` records `/private/var/…`, and the container has that exact path.

S4's "The Docker runtime isn't available yet." is removed, with its test. The one-time Claude version check runs only for local agents, with a minimal env (`PATH`, `HOME`) instead of the agent's; Docker agents log the image's `io.open-factory.claude-code.version` label in the `container` event.

## 11. Docker runtime

### 11.1 Launcher (decision Q11)

dockerode for everything (a new `apps/server` dependency, added through the lockfile under the existing `minimumReleaseAge` policy; its optional native `ssh2`/`cpu-features` build stays disabled: it must not be added to `onlyBuiltDependencies`). `DOCKER_HOST` is honoured by dockerode's defaults; no docker CLI on the factory host.

- **One container per agent**, named `open-factory-<slug>-<first 8 of agent id>`, labelled `io.open-factory.agent-id`, `io.open-factory.slug`, `io.open-factory.spec-hash`, `io.open-factory.image-id`. No DB column: containers are found by label.
- **Created on first wake**, started on each wake, **stopped (not removed) on hibernate**, removed and re-created on a wake whose spec hash differs. Archive doesn't remove it (unarchive must keep working); S7's Terminate removes.
- **Create options** (S2 contract plus hardening, asserted by a unit test on the options object):
  - `Image`: the resolved image (§11.2); `Cmd`: the image default (`sleep infinity`); `Env`: `HOST_UID`, `HOST_GID` (the server's `process.getuid()/getgid()`; if either is 0 the start fails: "The factory runs as root; Docker agents need a non-root host user.") and nothing else;
  - `HostConfig.Tmpfs: {"/run/open-factory": ""}` (ready marker, cleared on stop);
  - `HostConfig.Mounts`: from §11.4 only (bind mounts, `ReadOnly` as listed there);
  - `HostConfig.ExtraHosts: ["host.docker.internal:host-gateway"]`;
  - `HostConfig.SecurityOpt: ["no-new-privileges:true"]` (see "No sudo" below); never `Privileged`; no `CapAdd`; `NetworkMode` the default bridge (never `host`); `PidMode` never `host`; never the Docker socket or the host home among the mounts (also enforced by §11.4);
  - `Init`: not set (the image's ENTRYPOINT already runs `tini`).
- **Ready wait:** after start, poll for `/run/open-factory/ready` (exec `test -f` as root, every 200 ms, 30 s timeout). On timeout or if the container exits, the start fails with the last 50 lines of the container logs.
- **Claude** runs as `docker exec -i -u agent -w <workdir>` (S2 contract): `Cmd = ["sh", "-c", "echo $$ > /tmp/open-factory-claude.pid && exec \"$0\" \"$@\"", <claude path>, ...claudeArgs]`. The script is a fixed string; the Claude path and its arguments are argv entries, never interpolated. The Claude path is `FACTORY_DOCKER_CLAUDE_BIN` (default `claude`, the image's). `Env` = §11.5. `/run/open-factory` is root-owned and not writable by `agent` (V4), so the pid file lives in the container's own `/tmp` (not mounted).

**No sudo in agent containers (decision Q11b).** `no-new-privileges` is on for every agent container, so `agent` can't become root. Verified live: the entrypoint's UID remap still works under it, and `sudo -n true` as `agent` then fails (V5). This deliberately reverses what the S2 image offers (passwordless sudo, asserted by its smoke test), because the container is the only real boundary for unattended and `bypass` agents: a manager's instruction can get `sudo …` approved by the classifier (S0), root in the container can write root-owned or setuid files into bind-mounted repos (breaking AC5), and root widens the kernel surface. Agents that need system packages get them from a user image `FROM` the base (reproducible, unlike a runtime `apt-get`). The base image is **not** changed in S5; a follow-up issue updates S2's smoke test and `base-image.md`, decides whether to drop passwordless sudo from the image, and records a per-template `allow_sudo` opt-in as the likely shape if a real need appears. PR rollout note: agents can no longer sudo inside containers.

### 11.2 Image and re-create (decision Q12)

- Image = the snapshot's `image`, else `FACTORY_DEFAULT_IMAGE` (one config constant, default `ghcr.io/orlevii/open-factory/base:latest`; `.env.example` shows `open-factory-base:dev` for development).
- **Pull only when missing locally**, never to update a present tag (updating an agent's toolchain is a human act, as plugins in S4 Q7). The pull runs **before the grant, outside the agent's job and lock**. `requestWake` stays synchronous: for a Docker agent it records the entry as `pulling` and starts (or joins) one background check-and-pull per image reference (a present image resolves at once). A `pulling` entry keeps its FIFO place but is not eligible until the pull resolves; the agent's status is `queued` (§8.1, "including a pending image pull") and the status frame carries `pulling: true`, which the strip shows as "Pulling the image…". The pull is aborted by the closing latch. A failed pull drops the entry and enqueues a job on the agent that records the failure (errored, `start`, the registry's error verbatim).
- **Spec hash** = sha256 over: the local image **id** (so a rebuilt or re-pulled tag re-creates), the sorted mounts, `HOST_UID`/`HOST_GID`, the extra hosts, the security options, the tmpfs, and a launcher version constant. Grants, host skills and plugin dirs change the mounts, so they re-create; secrets and the credential don't.
- The image id is on the container label and in a `container{action: "created" | "recreated" | "started", image, imageId, claudeCodeVersion?}` event at each wake.
- **Re-creating wipes `/home/agent`** (shell history, `gh` login state, `known_hosts`, caches). Credentials belong in secrets and the rest is rebuildable; documented in the README and the PR rollout notes, with a follow-up issue (persist HOME under the workdir?).
- No resource limits in S5 (follow-up: memory/CPU limits and `oom_score_adj` on tool shells). Follow-up: pin the default image to a released `base-v*` version or digest instead of `:latest` (a floating default fetched at first pull is a supply-chain soft spot).

### 11.3 Exec transport and stop

- **stdin/stdout/stderr:** the hijacked exec stream (`hijack: true, stdin: true`), demultiplexed. NDJSON writes are unchanged (S3). **Closing stdin** = half-closing the stream (V2).
- **Exit:** when the stream ends, exec inspect gives `ExitCode` → `exited{code, signal: null}`. A container that dies ends the stream the same way. If the stream ends but the container still runs, it's a crash (§9.1) and the container is stopped.
- **terminate (SIGTERM):** exec `["cat", "/tmp/open-factory-claude.pid"]` as `agent`, parse the output as `/^[1-9][0-9]{0,9}$/` (fail closed on anything else), exec `["cat", "/proc/<pid>/comm"]` and require it to equal `claude` (the literal; `comm` is cut at 15 characters, so a configured path's basename isn't compared; the fake claude sets `process.title = "claude"`, §14), then exec `["kill", "-TERM", "<pid>"]` as `agent`. Argv arrays only, never a shell with file contents. If any step fails, terminate reports failure and the stop proceeds to its timeout and the escalation (§9.6). A test writes a non-integer, `0`, a negative and an over-long value into the pid file and asserts no `kill` exec is made from it and the stop falls back to the container stop.
- **forceKill / container stop:** `container.stop({t: 5})`. A container stop doesn't signal exec'd processes: Docker SIGTERMs PID 1 (`tini`), whose child `sleep` exits at once, and the kernel then kills every process in the namespace (V8). So it is effectively an immediate kill, which is why the graceful path SIGTERMs Claude itself first.
- In Docker the container stop is the leftover cleanup, the strong guarantee (#20).

### 11.4 Workspace hardening and the mount allow-check (decision Q13)

Found while designing S5: S4's `buildMounts` reads directory-marketplace paths from `.factory/template/settings.json` in the agent's **writable** workdir, so a Docker agent could add `{"source": "directory", "path": "/Users/or"}` and get the host home bind-mounted into its next container. Host-side factory writes and copies also follow symlinks the agent can plant (`.claude-config` → a host directory; `AGENTS.md` → `~/.ssh/id_ed25519`, which re-sync's backup would copy into the agent-readable workdir). Four parts, all required:

1. **Factory-owned state outside the workdir.** The template copy, re-sync backups, staged re-sync files and the plugin install dir (§11.7) live in `FACTORY_HOME/state/agents/<slug>/` (`template/settings.json`, `template/mcp.json`, `resync/<ts>/`, `resync-pending/`, `plugins-config/`). `FACTORY_HOME/state` is never mounted whole. A one-time move at boot migrates S4 agents: the two template files and any `resync/` dirs move, and `<workdir>/.factory` is then removed (a symlink there is removed as a link, never followed). The old copy isn't quarantined (D3): S4 Docker agents never started (they failed closed), an agent's runtime only changes through a re-sync, which rewrites the copy from the host template, and a local agent is unsandboxed anyway, so a tampered local copy grants nothing new. `templateCopyDir`/`resyncRoot` in `paths.ts` change; the S4 UI copy "Previous files saved in .factory/resync/…" shows the new path.
2. **Mounts from factory-owned inputs only.** `buildMounts` takes the workdir, the granted project paths (DB), the host skill dirs (host skills dir), the directory marketplaces declared in the factory-owned template copy, the agent's factory-owned `plugins-config/plugins` dir (§11.7), and the CLI bundle. Nothing in the agent's workdir or config dir becomes a mount. Every source is canonical (§10 "Canonical paths"), and each mount's target equals its source (the CLI bundle is the one exception). **`checkMounts`** (one function, defence in depth) `realpath`s each source again and requires it to be exactly one of: the agent's workdir (rw), a granted project path (rw), a declared host skill dir (ro), a declared marketplace dir (ro), the agent's plugins dir (ro), the CLI bundle file (ro, the one non-parity target `/opt/factory/bin/open-factory`). It refuses any source that is `/`, the host user's home directory, `FACTORY_HOME`, `FACTORY_HOME/state` (the agent's own `plugins-config/plugins` is the one allowed path under it), a Docker socket path (`/var/run/docker.sock`, `~/.docker/run/docker.sock`, the `DOCKER_HOST` unix path), or an ancestor of any of these; and it refuses any source **under** `FACTORY_HOME` other than this agent's own workdir and its own plugins dir (so a project registered inside another agent's workdir or inside `state/` can't be used to reach another agent's files). A refusal fails the start closed ("Mount <path> isn't allowed: <reason>.").
3. **Symlink-safe host writes (`SafeFs`).** Every host-side write, copy or delete under a workdir (`prepare`: config-dir `settings.json` and `CLAUDE.md`, `.mcp.json`, the `.claude/skills/<name>`, `projects/<name>` and `.claude-config/plugins` links; re-sync: copies and backups; create's rollback) goes through one helper that `lstat`s every path component below the workdir and fails ("<path> is a symlink; the factory won't write through it.") when a component the factory expects to be a directory or a file is a symlink. The factory-made links are checked as links and recreated, never followed. Backups `lstat` their source and copy a symlink as a symlink (never its target's bytes).
4. **No host write races a running container (D2).** Docker agents' `prepare` runs only with their container stopped (§10). Re-sync decides **under the workspace lock** (which every start also takes): it writes its workdir files (AGENTS.md, skills, files) at once only when nothing can race it (local: no process running; Docker: the container isn't running). Otherwise it writes them to `state/agents/<slug>/resync-pending/` instead (the template copy in `state/` is updated at once; a second staged re-sync replaces the pending dir, latest wins), and the next `prepare` applies them through `SafeFs` (with the backup) before the process starts; `requestRestart` makes that happen at the next safe moment. The re-sync response and UI say so: "Re-synced. The changes apply when @lead restarts (when idle)." Nothing looks applied when it isn't. One rule for both runtimes.

Regression tests plant each escape and assert the start or re-sync fails closed: a directory marketplace path in the old `.factory/template` location and in the agent's config-dir settings (neither becomes a mount); `.claude-config` as a symlink to a temp "host" dir; `AGENTS.md` as a symlink to a temp "secret" file during re-sync (the backup holds a symlink, not the secret's bytes); `projects` as a symlink to a directory; a granted project that contains `FACTORY_HOME`.

The local runtime is not a boundary (the agent runs as the host user and can write `FACTORY_HOME/state` too, the accepted trust decision behind the Q10 gate), but it gets the same code: one path for both runtimes.

### 11.5 Environment (decision Q15)

`buildAgentEnv(serverEnv, extra, runtime)`:
- **local:** S4 unchanged (the allowlist plus the factory vars).
- **docker:** only the factory vars: `CLAUDE_CONFIG_DIR`, the one credential var, the secrets, the git identity, and `OPEN_FACTORY_URL` (§11.6). The image provides `PATH`, `HOME` (Docker sets it from `-u agent`), `USER`, `SHELL`, `LANG` (V2: passing `Env` on an exec keeps the image's `PATH`).

S4's negative test runs for both runtimes: `DATABASE_URL`, `FACTORY_SECRET_KEY`, the server's own `ANTHROPIC_*`/`CLAUDE_*` and an unknown var are absent, and for Docker no host `PATH` or `HOME` appears.

### 11.6 Reaching the factory (decision Q14)

Containers get `ExtraHosts host.docker.internal:host-gateway` and the CLI bundle (`apps/cli/dist/open-factory.js`, path from `FACTORY_CLI_BUNDLE`, default resolved next to the server build) mounted read-only at `/opt/factory/bin/open-factory`. `OPEN_FACTORY_URL` = `FACTORY_AGENT_URL` (default `http://host.docker.internal:<PORT>`). It carries no credential: agent auth is S6. A missing CLI bundle fails Docker starts with "Build the CLI first (pnpm build)."

On Docker Desktop a server on host `127.0.0.1` is reachable at `host.docker.internal` (V3). On plain Linux it isn't: the README says to bind the factory to the Docker bridge gateway address (e.g. `HOST=172.17.0.1`) or run it on a compose network with the containers, and names `HOST=0.0.0.0` as the less safe fallback (it exposes the factory to the LAN). The live check (§18.5) runs `curl $OPEN_FACTORY_URL/api/status` from a container.

### 11.7 Plugins in a factory-owned dir (blocker R1)

S4's re-sync ran `claude plugin marketplace add/install` **on the host** with `CLAUDE_CONFIG_DIR` = the agent's writable `.claude-config` and cwd = its workdir. The self-review verified that a planted `{"env": {"GIT_TRACE": "/tmp/PWNED_cfg"}}` in that `settings.json` takes effect during `claude plugin marketplace add`; with `GIT_CONFIG_*` (a `credential.helper=!cmd`) that is host code execution the next time a human re-syncs. The host never again runs `claude` against an agent-writable config or cwd:

- Plugins install into `FACTORY_HOME/state/agents/<slug>/plugins-config/` (its own `settings.json` and `plugins/`), with cwd = a fresh empty factory temp dir and an env built from an explicit allowlist of exactly `PATH`, the host `HOME` and `CLAUDE_CONFIG_DIR=<plugins-config>` (decision R3: the host HOME is operator-controlled and git needs its config and credential helpers for private marketplaces; the danger was only the agent-controlled config dir and cwd). Nothing else: no `DATABASE_URL`, `FACTORY_SECRET_KEY`, credentials or `SSH_AUTH_SOCK` (S4 R4; if SSH-URL marketplaces need it, that is a follow-up).
- At every `prepare`, `<workdir>/.claude-config/plugins` is recreated (through `SafeFs`) as a factory-made symlink to `<plugins-config>/plugins`, and in Docker that dir is mounted read-only at the same path, so the absolute `installPath`s that `installed_plugins.json` records resolve on both sides.
- `buildSettings` carries `enabledPlugins` and `extraKnownMarketplaces` from `<plugins-config>/settings.json` (factory-owned), never from the agent's config-dir `settings.json`. The Q13 concern about carried keys becoming mounts disappears.
- Verified: Claude loads a plugin through the `plugins` symlink (V6), also in Docker with that dir mounted read-only; at start it tries to write `plugins/store/`, and with a read-only mount it skips that write and starts normally (V7). Not yet verified for a git-sourced marketplace (its install lands in the same `plugins/` dir, so the mechanism is the same); the plan's first task re-runs V6/V7 with a git marketplace, and if a read-only dir ever breaks startup, the factory-built settings disable marketplace and plugin auto-update rather than making the mount writable. **Fallback** if the symlink approach fails: install inside the agent's container (a throwaway exec as `agent`) for Docker agents; local keeps the host install.
- Migration, lazily at the agent's next `prepare` (not at boot: installs are networked and slow): when `plugins-config/` doesn't exist yet and the snapshot lists plugins, `prepare` installs them there (S4 Q7: installs are idempotent; an install failure is a start failure with the CLI's redacted stderr, as S4's create), then replaces the old real `.claude-config/plugins/` dir through `SafeFs` with the factory-made link.
- Regression test from the reviewer's repro: plant `env.GIT_TRACE` and a `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0=credential.helper`/`GIT_CONFIG_VALUE_0=!touch <marker>` in the agent's `.claude-config/settings.json`, re-sync (fake claude records the env and cwd it was run with), and assert the planted keys never reach the install and the marker is never created.
- Residual risk, stated: local agents run as the host user and can write `plugins-config/` and the host `HOME` themselves; that is the accepted local trust decision behind the Q10 gate, not a new hole.

## 12. The runtime journal and local cleanup (decision Q9)

- `agents.runtime_journal jsonb null`, one column replaced on each write: `{claude?: {pid, start}, descendants?: [{pid, start}], tasks: [{taskId, description}], crons: [{cronId, humanSchedule}], takenAt}`. `tasks` and `crons` are written for **both runtimes** on `background_tasks` and cron changes (boot uses them for the lost-work list and the R2 notice). `claude` and `descendants` are local only. Cleared after a clean exit, a reap, or reconciliation.
- **Local snapshots:** `ProcessJournal` runs `ps -A -o pid=,ppid=,lstart=` (portable to macOS and Linux) and walks the tree from Claude's pid, on `process_started`, on every `background_task_started`, and every 10 s **while a turn is open or a background task is live** (descendants can only outlive Claude through those).
- **Reap** (after a crash, an escalation, a Restart or at boot): signal a journaled pid **only if** `ps -o lstart= -p <pid>` returns the same start time (never signal a pid we can't prove is ours). SIGTERM all, wait 3 s, SIGKILL the survivors that still match. Bash tools run in their own session (`setsid`), so signalling a process group would miss them; the journal names each process.
- Best effort, documented: a process that detaches and is gone within one 10 s interval, or that was started and re-parented between snapshots, can be missed. Docker's container stop is the strong guarantee.

## 13. The local runtime gate (#18, decision Q10)

- `FACTORY_ALLOW_LOCAL_RUNTIME` (default `false`) in `config.ts`: an operator decision that no API or UI session can change.
- One rule, `localRuntimeAllowed(config)`, used by: `startNow` (fail closed, §10), the template validator (a **warning** on `runtime: local`: "The local runtime is disabled on this factory."), New agent (the same warning), the status frame's `runtimeDisabled`, and Restart (`409 runtime_disabled`, so a Restart certain to fail isn't offered).
- Bypass with local stays a validator error (S4).
- Local agents keep the Unsandboxed badge, and while the gate is off they show the disabled reason instead of failing silently on the first message.
- Rollout note in the PR: every S4 agent is local, so development setups add `FACTORY_ALLOW_LOCAL_RUNTIME=true` to `.env` (`.env.example` documents it).

## 14. Harness changes (`packages/harness`)

- `Transport` interface (`write(line)`, `endInput()`, stdout and stderr line streams, `exit: Promise<{code, signal}>`, `terminate(): Promise<boolean>`, `forceKill(): Promise<void>`, `pid?`) and `LocalTransport` (S3's spawn code, `detached: true`, SIGTERM/SIGKILL). `ClaudeProcess` takes a transport; `createClaudeDriver({log, transports})` picks one by `spec.runtime`. The Docker transport is injected from the server.
- `stop()` is idempotent (one promise per process).
- `system/session_state_changed` is dropped in the mapper and asserted to yield nothing; the fixture moves from `fixtures/pending/` next to the others in the same commit.
- `FactoryMessage.kind` widens to `"message" | "system"`.
- A synthetic `rate-limit-event-rejected` fixture (documented SDK shape, labelled unverified in the README).
- The fake claude sets `process.title = "claude"` so the comm check (§11.3) passes when it runs in a container.

## 15. Events, API and frames

New factory-only events (`packages/shared/src/events.ts`):

| Event | Payload | When |
|---|---|---|
| `hibernated` | `reason, idleMinutes?` | after the process exited (and the container stopped) on the hibernate path |
| `container` | `action: created \| recreated \| started, image, imageId, claudeCodeVersion?` | each Docker wake |
| `cleanup` | `killedProcesses?: number, container?: "stopped"` | leftovers reaped after a crash, an escalation or a Restart |
| `stop_escalated` | `how: sigkill \| container_stop` | §9.6 |
| `background_work_lost` | `reason, tasks, crons` | §9.4 |
| `reconciled` | `killedProcesses, stoppedContainer` | §5.7 |
| `rate_limit_paused` / `rate_limit_reset` | `credential, until, exact` / `credential` | §7.2 |
| `control` | `cmd` gains `restart` | Restart |
| `process_started` | gains `reason?: message \| compact \| crash_recovery \| restart \| reset \| boot \| boot_resume \| rate_limit_reset \| queued_items \| apply_changes` | every start |

API: `POST /api/agents/:slug/restart`, `POST /api/agents/:slug/reset-session` (§9.7). Messages and compacts to a queued or paused agent return `202` as usual. `AgentSummary` and `agent_status` gain the §8.2 fields; `GET /api/agents` gains `running`; the `supervisor` frame is new. `QueueItem.kind` gains `"notice"` (`from: "@factory"`). The re-sync response gains `applied: "now" | "on_restart"`.

## 16. Database (`packages/db`), one migration, additive

```
credentials  + rate_limited_until timestamptz null, rate_limit_exact boolean not null default true
agents       + last_error text null, error_kind text null, attempting boolean not null default false,
               runtime_journal jsonb null, rate_limit_notice_owed boolean not null default false
messages     from_user_id drops NOT NULL; + notice text null; CHECK per §9.5 (system ⇔ no user and a notice type)
```

No data rewrite: existing message rows have a user and `kind = 'message'`. `data-model.md`'s `agents.container_id` isn't added: containers are found by label (§11.1).

## 17. Failures

| Failure | What happens |
|---|---|
| Local start with the gate off | `error{source:"spawn", fix:"runtime"}`, errored (`start`), messages pending, the strip shows why, no Restart offered. |
| Image missing and pull fails | Start fails with the registry error verbatim; errored (`start`). |
| Ready marker timeout / container exits at start | Start fails with the last 50 container log lines. |
| A mount refused by `checkMounts` | Start fails closed with the reason. |
| A symlink where the factory writes | Start or re-sync fails closed naming the path. |
| Factory runs as root with a Docker agent | Start fails: "The factory runs as root; Docker agents need a non-root host user." |
| Docker daemon unreachable | Docker starts fail: "Can't reach Docker at <DOCKER_HOST or the default socket>: <error>." Boot reconciliation logs a warn and skips its Docker step; local agents still work. |
| Crash mid-turn | §9.2: cleanup, errored, one notice-led attempt (`attempting`). |
| Idle crash with nothing live | `exited` row, hibernated. |
| Crash during the recovery attempt | Cleanup, errored, no further automatic attempt. |
| Resume failure (ordinary / unrecoverable) | §9.3. |
| Stop timed out | §9.6 escalation; errored (`stop_failed`, slot kept) only if that fails too. |
| Rate limit rejected | Credential paused (§7), deliveries held, continue notice at reset. |
| Server stopped or crashed mid-turn | Boot reconciliation, one notice-led resume (§5.7 step 5). |

## 18. Testing

No automated test calls a live model. Few, thorough tests per behaviour.

### 18.1 Unit

`statusOf` (table); `classifyResumeFailure` (the S0 fixture text, the two documented 400 texts, an unknown error); `checkMounts` (every allowed kind, every refused kind, realpath through a symlink, ancestors, a project under another agent's workdir or under `state/`); canonical `FACTORY_HOME` under a symlinked prefix; the container create options (no `Privileged`, no host network or pid, `no-new-privileges`, tmpfs, extra hosts, only allowed mounts with the right read-only flags); the spec hash (changes on image id, grants, uid; not on secrets); `buildAgentEnv` for both runtimes; the notice texts (lists omitted when empty; signal vs exit code; no exact time when inexact); the pid-file parser; the journal's tree walk over canned `ps` output and its start-time match.

### 18.2 Harness

`ClaudeProcess` over a fake transport (writes, idempotent stop, terminate failure falls through to the timeout); the mapper drops `session_state_changed`; the `rejected` fixture maps to `rate_limited`.

### 18.3 Server (fake driver, fake timers, real Postgres)

- **Supervisor:** cap and FIFO; dedupe; queued status; no grant without a deliverable item; early hibernation picks the least recently active hibernatable agent, never a busy, pinned or mid-turn one, re-picks when the victim refuses, and never evicts two agents for one entry; a paused credential's entry is skipped without losing its place; the boot rebuild orders by oldest pending item; slot counts asserted after every crash and failure test; a `stop_failed` agent keeps its slot and Restart reuses it.
- **Deadlock-free:** a grant to another agent from inside an `exited` job; a Restart while a stop is in flight; the warm timer and an apply-restart racing.
- **Warm timer:** starts only when hibernatable; a live non-ambient task, an owed notification (with the 30 s bound armed only while no turn is open) and a live cron each prevent it; an ambient task doesn't; a one-shot cron unpins after its firing turn; the `background-bash-start-finish` ordering; a paused agent with held messages is hibernatable.
- **Hibernate path:** every reason; a message sent during the stop grace is not written to the closing process and wakes the agent after the exit; Docker container stopped after exit; `background_work_lost` only for what was live; timed-out stop escalates.
- **Shutdown:** after the closing latch, a send, a warm-timer expiry and a rate-limit reset start nothing; no process survives `app.close()`.
- **Apply-restart:** waits for busy but not crons; the restart-crons notice; S4's restart tests still pass.
- **Crash:** idle crash → hibernated, no turn; mid-turn crash → cleanup, errored + attempting (status queued, then working), one notice-led attempt whose first batch begins with the notice even with older pending messages, success (the first origin-less turn end after that batch, not an orphan-report turn) clears; a crash during any attempt (automatic, human message, Restart) → cleanup, errored, no automatic attempt; Restart returns 409 while an attempt runs; system notices never wake an errored agent; boot sets an agent whose attempt was cut short to errored and doesn't wake it; a graceful shutdown mid-turn leaves a factory-restarted notice and the next boot resumes it once.
- **Resume failures:** ordinary → errored `resume`, no automatic attempt; unrecoverable → no attempt from a later message.
- **Rate limit:** per-credential pause, held deliveries, the 30 min inexact fallback, the reset timer (and its re-arm at boot), one notice per cut-off turn, notice and pending messages in one batch with the notice first.
- **Restart / reset-session routes:** every 409, the notice, pending messages delivered in the new session.
- **Boot reconciliation:** a journal with a live matching pid (a real `sleep` child spawned by the test) is reaped; a non-matching start time is never signalled; dangling turns closed; an agent that was mid-turn gets the factory-restarted notice and one wake; an agent already in recovery is set errored instead; wakes queued.
- **Hardening regressions:** §11.4's and §11.7's planted escapes, including the `GIT_TRACE`/`GIT_CONFIG_*` repro.
- **Staged re-sync:** a running agent's files land in `resync-pending/` and apply at the next prepare; a hibernated agent's apply at once; the response says which.
- **Gate:** start refused with the gate off, validator warning, Restart 409.
- **System messages:** the CHECK constraint, `pendingQueue` returns sender-less rows first, the envelope says `from="@factory" kind="system"`.

### 18.4 Docker integration (gated, `FACTORY_DOCKER_TESTS=1`, not in default CI)

Uses the local `open-factory-base:dev` image and the **fake claude** mounted into the container as `FACTORY_DOCKER_CLAUDE_BIN` (the image has Node; the fake sets `process.title`), so no model is called. **Test seam:** `ContainerManager` and the env builder take test-only deps, `extraMounts` and `extraEnv` (the fake's script and its `FAKE_CLAUDE_*` variables), that are appended **after** `checkMounts` and `buildAgentEnv` ran; `buildApp` never sets them, and a unit test asserts the production wiring passes none. Covered: create with the hardened options and the ready wait; exec, NDJSON round trip, stdin half-close, exit code; terminate through the pid file and the comm check; hibernate stops the container; a spec change re-creates it; a crash stops the container and a planted background `sleep` is gone; a file written through a project bind mount is owned by the host user; boot reconciliation stops a running labelled container; a running container left by a dropped exec is stopped before the next start; the server-restart invariant (§5.7). Not in default CI because the image is 2.8 GB; the PR records a local run.

### 18.5 Live check (`pnpm smoke:docker`, not part of `pnpm test`)

Real `claude` in `open-factory-base:dev`, the token file read into the environment at run time (never printed), `--model haiku`, a throwaway DB and `FACTORY_HOME`, one granted temp git repo and one directory-marketplace plugin. Steps, each asserted and printed: a Docker agent remembers a word and lists its plugin's skill → it hibernates (warm window 1 minute in its template) and the container is stopped → a message wakes it and it recalls the word (AC1); it writes a file in the repo and creates a worktree: host-side `stat` owner and `git worktree list` match on both sides (AC5); a background `sleep 600` keeps it awake past the window (AC2); `curl $OPEN_FACTORY_URL/api/status` from the container answers (§11.6); `sudo -n true` fails in the container (Q11b); `kill -KILL` of Claude in the container → container stopped, the `sleep` gone, one notice-led resume (AC4). The PR records the output.

### 18.6 Web

The new statuses and labels (tooth only for working), the fallback wording everywhere, the waiting-on strip, Restart and Start a new session (dialog, focus), the Factory badge, lifecycle lines (`rate_limited` renders nothing), the runtime-disabled reason, the running count. Details in the UI doc.

## 19. Verified for this design (Claude Code 2.1.327)

| # | Claim | How | If wrong |
|---|---|---|---|
| V1 | `system/session_state_changed` (with `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`) reports `idle` right after each `result` **while a background task is still live** (idle at 3.4 s, the task ended at 11 s), and `running` before each `system/init`, emitted just after the empty `background_tasks_changed`. A turn signal, not a busy signal. | haiku; fixture `pending/session-state-changed-background` | #24 would simplify busy tracking. |
| V2 | A Docker exec started through the raw API (the hijacked stream dockerode uses) as `agent` with `Env` set keeps the image's `PATH` and `HOME=/home/agent`; half-closing the stream delivers stdin EOF; exec inspect returns the exit code. | Docker Desktop 29.9.3, `open-factory-base:dev`, a throwaway Node probe | Fall back to the docker CLI as the transport. |
| V3 | A server bound to host `127.0.0.1` is reachable from a container at `host.docker.internal` (Docker Desktop, `host-gateway`). | Same | Plain Linux needs the bridge-address bind (§11.6). |
| V4 | `/run/open-factory` is root-owned 0755: `agent` can't write a pid file there. | Same | — (pid file in `/tmp`) |
| V5 | Under `no-new-privileges` the entrypoint remap works (ready marker, `id` 502:20, a bind-mounted file owned 502:20 on the host) but `sudo -n true` as `agent` fails. | Same | — |
| V6 | A plugin installed with `CLAUDE_CONFIG_DIR` = a separate (factory-owned) dir loads in an agent whose `.claude-config/plugins` is a symlink to that dir's `plugins/`, with `enabledPlugins`/`extraKnownMarketplaces` copied into the agent's settings: `system/init` lists it and its skill answers. | Local, haiku, a directory marketplace | §11.7 fallback (install inside the container). |
| V7 | Same in Docker with the plugins dir mounted read-only at path parity, including a first start with no `plugins/store/` dir: Claude skips the store write and starts normally. | `open-factory-base:dev` with `no-new-privileges`, haiku | Disable plugin auto-update in settings, never make the mount writable. |
| V8 | A container stop doesn't SIGTERM exec'd processes: an exec'd TERM trap received nothing, and `docker stop -t 5` returned in about 0.1 s because PID 1's exit kills the namespace. | Self-review probe, `open-factory-base:dev` | — |
| V9 | Planted `env.GIT_TRACE` in a config-dir `settings.json` takes effect during `claude plugin marketplace add`. | Self-review probe in `open-factory-base:dev` | (the reason for §11.7) |

## 20. Product doc wording (for the lead; not edited here)

Deviations from the roadmap or product wording, each with its reason:
- `architecture/agent-runtime.md` → Rate limits, and ADR 0008: the pause is **per credential**, not global, because limits belong to the account behind a credential and a global pause would stop agents on unrelated accounts. A `rejected` event without a usable `resetsAt` uses a 30-minute fallback; the cut-off agent gets one continue notice at reset; a paused idle agent may hibernate.
- `architecture/agent-runtime.md` → Concurrency: when every slot is held and some holder is idle (not busy or pinned), the least recently active idle agent hibernates early to free a slot, because the warm window is an optimisation and a real wake shouldn't wait up to 70 minutes.
- `architecture/agent-runtime.md` → Crash handling: an idle crash with no live work hibernates without a resume (nothing was lost, so no tokens are spent); the automatic resume writes a factory notice and succeeds when that turn ends; a server stop during a turn is treated like a crash at the next boot; unrecoverable resumes go to "Start a new session".
- `roadmap/v0.1/s05-supervisor-docker.md`, `architecture/system-overview.md` and `data-model.md`: the wake queue is in memory, rebuilt from pending messages at boot, not a pg-boss queue (a slot is a live process, not a job); `agents.container_id` isn't a column (containers are found by label).
- `architecture/workspace.md`: the template copy, re-sync backups and installed plugins live in `FACTORY_HOME/state/agents/<slug>/`, outside the workdir; `.claude-config/plugins` is a factory-made symlink; Docker mounts come only from factory-owned inputs; re-sync of a running agent applies at its next restart.
- `architecture/harness-driver.md`: `system/session_state_changed` is a turn signal, not a busy signal.
- `concepts/message.md`: a `system` kind from `@factory` (crash, restart, apply-change, factory-restart and rate-limit notices).
- `concepts/session.md` → Controls: "Start a new session" (errored after a failed resume).
- `architecture/base-image.md` → Contents / User: agent containers run with `no-new-privileges`, so the image's passwordless `sudo` doesn't work for agents; system packages belong in a user image.
- `DESIGN.md` → Colors → Semantic ("checked side by side"): in light theme `working` and `rate_limited` are indistinguishable by colour for deuteranopes (ΔE 1.0), and `queued`/`idle` for tritanopes; the tooth shape and the label carry the difference. (DESIGN.md is in the repo; listed here because it's design-system wording the lead owns.)
- S4's Known gap "the product docs expect `settings.json` to keep agent changes" stands (unchanged by S5).

## 21. Decisions needing Or's call (owner-proxy certainty 3/5)

- **Q1 wake queue:** in memory, rebuilt from pending messages at boot, instead of pg-boss as the roadmap says.
- **Q6 sender:** notices are `system` message rows from `@factory` (nullable `from_user_id` with a CHECK), not raw turns.
- **Q9 journal mechanism:** `ps` snapshots on events and every 10 s while busy, start-time-verified reaping; best effort locally.
- **Q11b no sudo in containers:** `no-new-privileges` on every agent container, reversing the S2 image's passwordless sudo for agents; system packages come from user images.
- **Q17 apply-restart vs crons:** a config change restarts a pinned agent without waiting for its crons, and the agent is told which crons stopped.
- **Q18 continue notice:** a rate-limit-cut turn gets one "continue" notice at reset.

Roadmap/product deviations taken at certainty 4 that Or should still see (§20): the per-credential pause (Q3), no resume after an idle crash (Q6), early hibernation to free a slot (Q2).

## 22. Issues consumed and follow-ups

Consumed: **#10** (the S2 runtime contract: HOST_UID/GID, tmpfs, ready wait with logs, `-u agent -w`, CLI mount), **#18** (gate), **#19** (restart policy and unrecoverable resumes), **#20** (leftover cleanup), **#24** (evaluated and rejected with V1; close), **#31** (apply-restart tells the agent which crons stopped; S9 still owns the pinning UI). Also S4's PR notes: the timed-out stop, the owed notification, the double `proc.stop`, the workspace symlink and template-copy hardening, and Docker templates failing closed.

Untouched: **#23**, **#26** (a compact to a hibernated agent wakes it; durability stays a follow-up), #29, #30, #32–#36.

Follow-ups to open: base image sudo under `no-new-privileges` (S2 smoke test and docs, whether to drop sudo, an `allow_sudo` opt-in shape); container resource limits and `oom_score_adj`; pin `FACTORY_DEFAULT_IMAGE` to a released version or digest; persist `/home/agent` across container re-creation; verify the documented `rejected` rate-limit shape and the poisoned-resume texts when they occur; Linux factory reachability for containers in S6 (bind address and agent auth); persisting live crons (S9); the Docker integration tests in CI with a cached image.
