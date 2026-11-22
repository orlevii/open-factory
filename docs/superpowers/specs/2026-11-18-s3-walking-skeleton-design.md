# S3 Walking skeleton (one agent): Technical Design

- **Date:** 2026-11-18
- **Status:** approved by owner-proxy (owner-s3), pending Or's review on the low-certainty items (see §17)
- **Roadmap spec:** `docs/product/roadmap/v0.0.1/s03-walking-skeleton.md`
- **UI design:** [`docs/superpowers/designs/2026-11-18-s3-session-ui-design.md`](../designs/2026-11-18-s3-session-ui-design.md)
- **Product sources of truth:** `docs/product/architecture/harness-driver.md`, `agent-runtime.md`, `workspace.md`, `permissions.md`, `data-model.md`; `docs/product/concepts/message.md`, `session.md`; `docs/product/behavior/agents-and-sessions.md`; `docs/product/open-questions.md` ("Verified during design", the S0 findings).
- **Evidence:** the stream-json traces in `packages/harness/fixtures/` (Claude Code 2.1.327), indexed in `packages/harness/fixtures/README.md`. S0 recorded most of them; this design added `manual-compact` and `interrupt-while-idle` (§6.7).
- **Decision log:** the GitHub issue "S3 Walking skeleton: design decisions" (orlevii/open-factory).
- **Stacked on:** `spec/s0-spikes` (the fixtures and `spikes/` scripts).

> `docs/product/` is gitignored, so the product docs exist only in local checkouts. Paths above are relative to the repo root.

## 1. Goal

Prove the hardest path end to end with one agent and the local runtime: the factory drives a live `claude -p` stream-json process, persists every event with a stable sequence id, streams it to the UI over WebSocket, and delivers human messages into it as `<factory-message>` envelopes. A human opens the agent's session, sends a message, watches the reply arrive, compacts, interrupts, and after a server restart the agent still remembers the conversation.

## 2. Acceptance criteria

From the roadmap, made testable:

1. From the UI a human sends a message to `dev` and the reply appears in the timeline while the agent works: each assistant text block and each tool call shows up as Claude emits it (block granularity, §6.6). Tool calls render collapsed.
2. Compact (with or without focus text) from the UI shows a compaction marker with the token counts before and after.
3. An urgent message sent while a turn is running interrupts that turn, and the message runs as the next turn (§8.3).
4. After the server is restarted (graceful stop of the process), the next message resumes the same Claude session (`--resume`, same `session_id`) and the agent recalls the earlier conversation.
5. Envelopes never render as raw XML. Incoming messages render as a sender badge (`@handle`) plus the body.
6. CI is green. The live smoke script (§13.3) has been run once, and its output plus a manual pass through ACs 1–5 in the browser are recorded in the PR.

## 3. Scope

In: the `HarnessDriver` boundary and the Claude stream-json driver in `packages/harness`; the factory event types in `packages/shared`; DB tables `agents`, `session_events`, `messages`, `turns`; a per-agent runtime in the server (start on demand, delivery, persistence, broadcast, graceful stop); the message, compact and interrupt APIs; WebSocket subscribe with gap-free replay; the Agents list and the session view; a dev-agent seed script; a fake `claude` for tests; a live smoke script.

Out (roadmap): Docker, hibernation and the warm window, templates, multiple agents (the code is per agent, but only `dev` is seeded and there is no create UI), the factory MCP. Also out here: token-by-token streaming (§6.6), a Restart/Stop button (S5), crash-loop policy and leftover-process cleanup (S5), the `allow_local_runtime` gate (S5, see §16), named credentials (S4), usage display (S10), the org tree (S4/S6), thinking blocks (§6.5).

## 4. Architecture

```
web (session view) ──HTTP──► routes/agents.ts ──► AgentRuntime (per agent, in memory)
        ▲                                            │  serial job queue: every stdin write and every append
        │ WS frames                                  │  delivery queue (FIFO), urgent hold, turns, status
        └── ws/route.ts ◄── EventBus ◄── EventStore ◄┤
                                                     ▼
                                    HarnessDriver (packages/harness)
                                     └─ ClaudeProcess: spawn claude -p … stream-json
                                         stdin NDJSON writer │ stdout line parser → mapper → HarnessEvent
```

Units and what they own:

| Unit | Package | Owns |
|---|---|---|
| Event types (`HarnessEvent`, `SessionEvent` DTO, WS frames, API schemas) | `packages/shared` | Zod schemas shared by server, harness and web. No stream-json types. |
| `HarnessDriver`, `HarnessProcess`, `AgentRuntimeSpec` | `packages/harness` | The boundary (§5). |
| Claude mapper | `packages/harness/src/claude/mapper.ts` | Pure: one parsed stdout line + small state → zero or more `HarnessEvent`s. |
| `ClaudeProcess` | `packages/harness/src/claude/process.ts` | Spawn, stdin writer, line splitter, stderr tail, exit, stop. |
| Envelope renderer | `packages/harness/src/envelope.ts` | `FactoryMessage[]` → the user-turn text. |
| Fake claude | `packages/harness/testing/fake-claude.mjs` | Test double executable built from the fixtures (§13.1). |
| `AgentRuntimes` / `AgentRuntime` | `apps/server/src/agents/` | Process lifecycle, serial job queue, delivery queue, urgent hold, turns, status. |
| `EventStore` | `apps/server/src/agents/event-store.ts` | Seq allocation, payload cap, history queries, message and turn rows (Postgres only). |
| `EventBus` | `apps/server/src/agents/event-bus.ts` | In-process pub/sub for WS. |
| Runtime spec builder | `apps/server/src/agents/runtime-spec.ts` | `buildRuntimeSpec(agent, config)`, `buildAgentEnv(...)`, `resolveClaudeToken(config)`: the one place S4 replaces. |
| Dev seed | `apps/server/src/agents/seed-dev.ts` + `apps/server/scripts/seed-dev-agent.ts` | `seedDevAgent(db, config)` (used by the script and tests); S4 deletes both. |
| Routes | `apps/server/src/routes/agents.ts`, `ws/route.ts` | HTTP API (§9) and WS frames (§10). |
| Web | `apps/web/src/routes/_app/agents.index.tsx`, `agents.$slug.tsx`, `src/features/session/` | Agents list and session view (UI design doc). The S1 `agents.tsx` becomes `agents.index.tsx`. |

`packages/harness` depends on `packages/shared` (for `HarnessEvent`) and on Node only. Nothing outside `packages/harness/src/claude/` knows a stream-json field name.

## 5. Harness boundary (`packages/harness`)

```ts
interface AgentRuntimeSpec {
  agentId: string;
  slug: string;
  cwd: string;                       // FACTORY_HOME/agents/<slug>
  env: Record<string, string>;       // complete child env (§7.2); nothing else is inherited
  claudeBin: string;                 // "claude" or FACTORY_CLAUDE_BIN
  model?: string;                    // omitted → no --model
  effort?: string;                   // omitted in S3
  permissionMode: "auto";            // S3 only ever passes auto (ADR 0011)
}

interface FactoryMessage {
  id: string; from: string;          // "@or" (human handle); agent slugs later
  kind: "message";                   // S3 produces only this kind
  urgent: boolean; body: string; taskKey?: string;
}

interface HarnessDriver {
  start(spec: AgentRuntimeSpec, opts: { resumeSessionId?: string }): HarnessProcess;
}
interface HarnessProcess {
  readonly pid: number | undefined;
  send(messages: FactoryMessage[]): Promise<void>;                 // one user turn; resolves when the write is flushed
  control(cmd: "compact" | "clear" | "interrupt", arg?: string): Promise<void>;
  stop(opts?: { graceMs?: number; termWaitMs?: number }): Promise<ExitInfo>;
  events: AsyncIterable<HarnessEvent>;                             // ends after `exited`
}
```

Differences from the product doc's sketch, all additive: `start` returns synchronously (spawn errors arrive as `error` + `exited` events, so there is one failure path); `send`/`control` return a promise that resolves on the stream's write callback and rejects on a write error (EPIPE is asynchronous, so a synchronous `write()` never proves delivery); `stop` takes the grace and SIGTERM waits (`graceMs: 0` = SIGTERM now, for Terminate/Restart later) and returns exit info; `pid` is exposed for S5's process-tree bookkeeping.

### 5.1 Command line and spawn

```
<claudeBin> -p --input-format stream-json --output-format stream-json --verbose \
  --permission-mode auto [--resume <session-id>] [--model <m>]
```

No `--include-partial-messages` (§6.6). Spawned with `stdio: ["pipe","pipe","pipe"]`, `cwd: spec.cwd`, `env: spec.env` (no merge with `process.env`), and `detached: true` so Claude gets its own process group: a Ctrl+C in the terminal running `pnpm dev` then reaches only the server, which stops Claude gracefully, instead of SIGINT-ing Claude directly (SIGINT behaviour was never verified). The child is not `unref`'d; the server always stops it.

### 5.2 Writing to stdin

- Every line is `JSON.stringify(obj) + "\n"`. Nothing else ever writes to stdin, because a malformed line kills the process (S0, `error-malformed-stdin-line`).
- `send(messages)`: one `{"type":"user","message":{"role":"user","content":<envelopes>}}` line. Never sets `"priority"` (S0: `priority:"now"` aborts the turn at the next tool boundary without killing the tool).
- `control("compact", focus?)` → a user line `/compact` or `/compact <focus>`. `control("clear")` → `/clear` (driver capability only, no UI and no caller in S3; it probably starts a new session id, unverified). `control("interrupt")` → `{"type":"control_request","request_id":<uuid>,"request":{"subtype":"interrupt"}}`.
- Writes after stdin has closed or the process has exited reject with `ProcessNotRunningError`.

### 5.3 Envelope (`envelope.ts`)

Per message:

```
<factory-message from="@or" kind="message" urgent="false" id="<message id>">
<body>
</factory-message>
```

A batch is the envelopes joined by a blank line, in order, as one user turn (Message concept). Attribute values are XML-attribute-escaped (`& < > "`). In the body, every match of `/<(\s*\/?\s*)factory-message/gi` has its `<` replaced by `&lt;`, so a body cannot forge or close an envelope in any spelling (`</Factory-Message>`, `< /factory-message`); nothing else in the body changes. Unit-tested with those variants.

### 5.4 Reading stdout and stderr

- stdout is split on `\n`; empty lines skipped; each line `JSON.parse`d. A non-JSON line is logged at warn and skipped (never observed).
- Every raw stdout line is logged at `debug` with the agent slug. Unmapped `type`/`subtype` values are logged at `warn` once per kind per process (Q6).
- stderr is logged at `warn` line by line and kept in a ring buffer (last 50 lines / 8 KB), which becomes `exited.stderrTail` and the detail of start-failure errors.

### 5.5 Exit and stop

On the child's `exit`, the process emits `exited{code, signal, stderrTail, expected}` (`expected` = `stop()` was called first) and ends the iterable. A spawn failure (`ENOENT`, `EACCES`) emits `error{source:"spawn", message:"Claude Code not found: set FACTORY_CLAUDE_BIN or put claude on PATH"}` and then `exited{code:null, signal:null, expected:false}`.

`stop({graceMs = 3000, termWaitMs = 10_000})` closes stdin, waits `graceMs` for a natural exit, then sends SIGTERM to the child and waits `termWaitMs`. It never sends SIGKILL (S0: SIGKILL orphans background shells; SIGTERM stops them and exits 143). If the process is still alive after that, `stop()` resolves with `{timedOut: true}` and logs an error; cleanup of such a process is S5's.

## 6. Event model

### 6.1 `HarnessEvent` (factory-owned, `packages/shared/src/events.ts`)

| Type | Payload | Source |
|---|---|---|
| `session_started` | `sessionId, model, cwd, claudeCodeVersion` | first `system/init` of a process (later repeats don't emit it) |
| `turn_started` | — | every `system/init` (it repeats once per turn, including self-started and compact turns) |
| `message_in` | `messages: {id, from, kind, urgent, body, taskKey?}[]` | **factory**, when a user turn is written (stream-json doesn't echo input) |
| `assistant_text` | `text, parentToolUseId?` | `assistant` content block `type:"text"` from a real model (not `model:"<synthetic>"`) |
| `tool_call` | `toolUseId, name, input, parentToolUseId?` | `assistant` content block `type:"tool_use"` |
| `tool_result` | `toolUseId, content (string), isError, parentToolUseId?` | `user` content block `type:"tool_result"` (text parts joined; non-text parts summarised, e.g. `[image]`, `[tool_reference CronCreate]`) |
| `background_task_started` | `taskId, toolUseId, taskType, description?` | `system/task_started` with `is_backgrounded:true` |
| `background_task_finished` | `taskId, status, summary` | `system/task_notification` for a task that is not a known foreground task (§6.2). `status` is passed through: `completed`, `stopped`, `failed`, `killed` (only the notification carries the summary; `task_updated` is dropped) |
| `background_tasks` | `tasks: {taskId, taskType, description?, ambient?}[]` | `system/background_tasks_changed` (the full live set). It is not emitted at process start, so consumers (S5) reset the set on `process_started`; `ambient` tasks don't count as activity |
| `cron_created` | `cronId, recurring, humanSchedule, nextFireAt` | `CronCreate` tool result (`tool_use_result.id`) |
| `cron_deleted` | `cronId` | `CronDelete` tool call `input.id` |
| `permission_denied` | `toolName, toolUseId, reasonType, reason` | `system/permission_denied` |
| `compacted` | `trigger: "manual"\|"auto", preTokens, postTokens, summary?` | `system/compact_boundary` + the synthetic summary user message that immediately follows it |
| `compact_failed` | `error, trigger: "manual"\|"auto"` | `system/status{compact_result:"failed", compact_error}` (manual "Not enough messages to compact."; auto "too_few_groups" or a raw API error, sometimes twice per turn). `trigger` is `manual` when the status follows a `/compact` write (the driver knows; it wrote it), else `auto` |
| `usage` | `model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, durationMs, numTurns` (all **per turn**) | `result`. `total_cost_usd` and `modelUsage` are running totals for the process (`error-refusal-and-failed-compaction`: 0.0117 → 0.127 → 0.404 → 0.776), and `usage` covers only the main loop, so the per-turn numbers come from `model_usage_since_last_result` (summed over its models; `model` = its largest-cost key); if it is absent, from the difference of the cumulative `modelUsage`/`total_cost_usd` against the previous `result` of the same process |
| `rate_limited` | `status, resetsAt, rateLimitType, utilization?` | `rate_limit_event` **only when `status == "rejected"`**. `allowed` and `allowed_warning` are not limits (dropped); `overageStatus` is never read (fixtures show `overageStatus:"rejected"` next to `status:"allowed"`). Only `allowed` has been observed; the `rejected` shape comes from the Agent SDK types (2.1.286) |
| `turn_end` | `isError, terminalReason?, originKind?, command?, numTurns` | `result` (error = `is_error`, whatever `subtype` says). `originKind` = `result.origin.kind` (e.g. `task-notification`), or `"cron"` when the turn was preceded by `command_lifecycle{state:"started", wakeup_source}` (cron firings have **no** `origin`: `cron-create-fire-delete`, `cron-oneshot`); absent for user-initiated turns. `command` = `result.local_command` (`"compact"` on compact results). `terminalReason` is absent on compact and orphan-report results |
| `error` | `source: "api"\|"refusal"\|"spawn"\|"resume", message, detail?` | `system/model_refusal_no_fallback`; an assistant message with `stop_reason:"refusal"` (seen in the fixtures; older versions ended refusals with `is_error:false`); a synthetic assistant message carrying an `error` field (e.g. `model_not_found`); an `is_error` result with `terminal_reason:"api_error"` when no `error` was emitted earlier in the same turn (at most one `error` per turn; an interrupted turn, `terminal_reason:"aborted_tools"`, is not an error event, only `turn_end{isError:true}`); spawn and resume failures (runtime, §11) |
| `exited` | `code, signal, stderrTail, expected` | child exit |

`system/model_refusal_fallback` (a fallback model took over) maps to a quiet `model_fallback{message}` line, not an error.

Plus **factory-only** event types that the runtime appends (never produced by a driver): `process_started{resumed}`; `control{cmd, arg?, by}` (Q17; `by` is the human's `@handle`); `delivery_failed{messageIds, reason}` (§8.3); `session_reset{by}` (the seed script, §12).

`background_*`, `cron_*` and `rate_limited` are mapped and persisted now so S5 and S9 can rely on them; the UI shows them as quiet lines.

### 6.2 Mapper state and drops

The mapper is a pure function over one line plus a small per-process state:
- whether `session_started` was emitted, and the last `system/init.model`;
- a pending `compacted`, held for exactly one more line: if that line is a synthetic user text message it becomes `summary`; the held event is emitted before whatever that line maps to, or on `result`/end of stream. No timers;
- the foreground task ids (`task_started` with `is_backgrounded:false`, e.g. a long foreground Bash): their `task_notification` is dropped. A `task_notification` for an id never seen in this process (the orphan reports after `--resume`) maps to `background_task_finished`;
- the `CronCreate` tool-use ids, to match the `CronCreate` result;
- whether an `error` was emitted in the current turn (reset on `turn_started`);
- a pending cron wakeup (`command_lifecycle{state:"started", wakeup_source}`), which tags the next `turn_end` with `originKind:"cron"`;
- whether any `system/init` has been seen: a `result` before the first `system/init` (only ever seen for a failed `--resume`) maps to **only** `error{source:"resume", message: result.errors[0]}` (no `usage`, no `turn_end`). The driver passes `resumed: true|false` into the mapper; when the process was not resumed the same case maps to `error{source:"spawn"}` with that message.

Dropped on purpose, each asserted to yield nothing in a test: `system/thinking_tokens`, `commands_changed`, `task_updated`, `task_progress`, `informational`, `hook_*`, `system/status` other than `compact_result:"failed"`, `control_response`, `rate_limit_event` unless `status:"rejected"`, `command_lifecycle` (consumed as state only), `thinking` content blocks (§6.5), replayed user lines (`isReplay:true`, e.g. `<local-command-stdout>Compacted </local-command-stdout>`), user text that isn't a `tool_result` and isn't the compact summary (e.g. "[Request interrupted by user for tool use]"), and synthetic assistant messages with `local_command_source` (their text duplicates `compact_failed`).

### 6.3 Resume

On `--resume`, Claude may first run a self-started turn reporting orphaned tasks: `task_notification{status:"stopped", summary:"Orphaned…"}` lines, `system/init`, then `result{num_turns:0, origin.kind:"task-notification"}` (`resume-after-sigkill-orphans`). It maps normally (`background_task_finished`, `turn_started`, `usage`, `turn_end{originKind:"task-notification"}`) and is never attributed to a delivered message (§8.4).

A resume of an unknown id yields a `result{subtype:"error_during_execution", num_turns:0, errors:["No conversation found with session ID: …"]}` **before any `system/init`**, and exit 1 (`error-resume-missing-session`). The mapper turns it into `error{source:"resume", message: errors[0]}` (§6.2). The runtime reacts to that `error` arriving before `session_started` (§11): `stop()` (in the fixture stdin was closed before the exit, so we don't rely on a self-exit), rollback of the tentative batch, `errored`. It **never** starts a fresh session on its own (Q8).

### 6.4 Payload cap

One rule at the persistence boundary (`EventStore`), not per type: any string field longer than 64 KiB of UTF-8 is cut to at most 64 KiB on a code-point boundary, and the payload gains `truncated: {<field path>: <original byte length>}`. The UI shows "Truncated (1.2 MB)". The full content stays in Claude's own session JSONL (Q7). Message bodies are limited to 64 KiB at the API (§9), so `message_in` is never truncated.

### 6.5 Thinking

Dropped. All 45 thinking blocks in the S0 fixtures are empty (signature only). Revisit if a later Claude Code emits thinking text (Q9).

### 6.6 Streaming granularity

Block granularity: no `--include-partial-messages`. Each text block and tool call appears when Claude emits it, and a "working" indicator covers the gap. The WS frame union (§10) is the seam: a transient `assistant_delta` frame can be added later without changing anything else (Q2).

### 6.7 Verified for this design (Claude Code 2.1.327, haiku)

- **Manual `/compact` is a turn and always ends with a `result`** (`manual-compact`): `status{compacting}` → `status{compact_result:"success"}` → `system/init` → `compact_boundary{trigger:"manual", pre_tokens, post_tokens}` → synthetic summary user message → replayed `Compacted` line → `result{num_turns:0, is_error:false}` with no `origin`. A failing compact ("Not enough messages to compact.") ends the same way after `status{compact_result:"failed"}` and a synthetic assistant message. Compact results carry `local_command:"compact"`. So there is no fallback timer for compacts, and `num_turns:0` doesn't identify orphan reports (only `origin`, plus the cron `command_lifecycle` marker, identify self-started turns).
- **An interrupt on an idle process is harmless** (`interrupt-while-idle`): only `control_response{success, still_queued:[]}`; the next message runs normally with memory intact.

## 7. Agent, workspace and environment

### 7.1 The dev agent

One row, slug `dev`, display name "Dev agent", created by `seedDevAgent` (§12). Working dir `FACTORY_HOME/agents/dev/` with a short placeholder `AGENTS.md` and an empty `.claude-config/`. `CLAUDE_CONFIG_DIR=<workdir>/.claude-config` (workspace doc, ADR 0010). The runtime is local and the UI shows the "Unsandboxed" badge.

### 7.2 Child environment (`buildAgentEnv`)

An explicit allowlist, built in one function that S4 extends (Q18):

- copied from the server env if set: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `TMPDIR`;
- set by the factory: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`.

Nothing else is inherited: not `DATABASE_URL`, `FACTORY_SECRET_KEY`, `ANTHROPIC_*`, other `CLAUDE_*`, `SSH_AUTH_SOCK`, or anything added to the server env later. A test asserts `DATABASE_URL`, `FACTORY_SECRET_KEY` and `ANTHROPIC_API_KEY` are absent.

### 7.3 Configuration (new env vars, `config.ts` and `.env.example`)

| Var | Default | Notes |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Read only by `resolveClaudeToken(config)` (S4 replaces it with named credentials). Optional for the server to boot. Missing → starting the agent fails closed with "Set CLAUDE_CODE_OAUTH_TOKEN to run agents". Never falls back to the host login (Q1). |
| `FACTORY_CLAUDE_BIN` | `claude` | Path or command name. Tests point it at the fake. |
| `FACTORY_DEV_MODEL` | unset (no `--model`) | **Stopgap, removed in S4** (the model comes from the template). Marked so in `config.ts` and `.env.example`. Feeds `AgentRuntimeSpec.model` in one place (Q4). |

The token never reaches a log: runtime specs and envs are never passed to the logger, and `config.claudeToken` is added to the logger's redact paths as an exact path.

### 7.4 Claude Code version

On the first start after boot the server runs `<claudeBin> --version` once (5 s timeout), logs it, and logs a warning if it is older than 2.1.327 (the version the fixtures come from). It never refuses to start (Q19). A missing binary surfaces as the spawn failure in §5.5.

## 8. Runtime (`apps/server/src/agents/`)

### 8.1 `AgentRuntimes`

A registry decorated on the Fastify app (`app.runtimes`): `get(agentId)` returns the agent's `AgentRuntime`, created lazily. Agents start on demand; nothing starts at boot; there is no Stop endpoint and no idle timeout (Q3). On `app.close()` it stops every running process **in parallel** with `stop({graceMs: 3000, termWaitMs: 10_000})`, then waits for each agent's job queue to drain (the `exited` event and the turn close persisted) before the DB is closed. The S1 graceful-shutdown force-exit timeout (`apps/server/src/shutdown.ts`, 10 s) is raised to 20 s with a comment saying why, so a mid-turn shutdown never exits the server while Claude still runs (which would leave it running on stdin EOF and let the next boot `--resume` the same session concurrently) (Q24).

### 8.2 `AgentRuntime` (one per agent)

State: the `HarnessProcess` or none; `started` (a `session_started` has been seen for this process); the open turn id or none; the **delivery queue**; the urgent hold; batches written but not yet attributed to a turn; the last start error.

**One serial job queue per agent.** Every stdin write and every DB append for the agent (driver events, `message_in`, `control`, `process_started`, `delivery_failed`, message-row and turn-row updates) runs as a job on one in-process promise chain, in order. Stdout events enqueue jobs as they arrive. A message delivery is one job: `await send()` → append `message_in` → update the message rows, in one DB transaction; reply events that arrive meanwhile queue behind it, so `message_in` always gets a lower seq than its reply. Each job: (1) DB writes, (2) commit, (3) publish on the `EventBus`, (4) react (status, turns, queue flush). Publishing after commit, in job order, is what makes WS replay gap-free (§10).

**Start on demand** (`ensureStarted`, called by send and compact, not by interrupt): build the spec, resolve the token (missing → fail before spawn), spawn with `resumeSessionId = agents.session_id` if set, append `process_started{resumed}`, start the event pump, then flush the delivery queue. The first `session_started` makes the start successful: `agents.session_id` is set if it was null (if it differs from a stored one, that is logged as an error and the stored id is kept), a stored `errored` status is cleared, and the tentative first batch is confirmed (§8.3).

### 8.3 Delivery queue, tentative delivery and urgent hold (one path)

All deliveries go through one strict-FIFO queue per agent (Q13, Q14, Q23). Items are human messages (`messages` rows, `state = pending`) and compact commands (in memory only; they don't survive a server restart). Flushing writes from the head while allowed:

1. **Messages.** All consecutive messages at the head go out as **one** user turn (envelopes in order). Allowed when the process is running, no urgent hold is active and no compact is in flight, including mid-turn (Claude absorbs them at the next tool boundary, S0 `midturn-messages-absorbed`).
2. **Compact is a barrier.** A compact at the head is written only when no turn is open and no batch is awaiting its turn. Its `control{cmd:"compact"}` event is appended when written. Writing it sets **compact in flight**. Nothing behind it is written until a `turn_end` with `command:"compact"` (or `exited`) clears that flag; a self-started turn that ends meanwhile doesn't (`manual-compact`: the `system/init` only comes ~3 s after the write, after the compaction itself). So no message is ever absorbed into a compact turn.
3. **Urgent while a turn is open:** an interrupt job is enqueued on the serial job chain right away (it jumps the delivery queue, not the job chain): it writes the control request, appends `control{cmd:"interrupt"}` and sets the hold. While the hold is active nothing is written. The hold is released by the open turn's `turn_end` (interrupted or natural, whichever comes) or after 10 s (logged as a warning); then the queue flushes per rule 1. A second urgent message during an active hold sends no second interrupt; it just joins the queue. An urgent message behind a queued compact stays behind it (strict FIFO).
4. **Urgent while idle** = a normal send. The **Interrupt action** is allowed only while a turn is open (409 otherwise) and sets no hold.
5. **Process not running:** only the send and compact API handlers call `ensureStarted`; a flush on a dead process writes nothing (so a rollback or the hold timeout can never cause a restart loop). Items stay queued; the queue flushes after `process_started` (pending messages become the first turn after the start, the product's wake semantics). If the start fails before spawn, items stay `pending`.
6. **In flight.** A written batch leaves the delivery queue at once and sits in an in-memory **in-flight** set until confirmed or rolled back; in-flight messages are never re-flushed and never appear in `queue` frames (their `message_in` is already in the timeline).
7. **Delivered means confirmed.** A batch becomes `delivered` (rows updated, `delivered_at` set) when its write resolved **and** the process has emitted `session_started`. Normally that is immediate. The first batch after a (re)start is **tentative** until `session_started`: if the process exits or reports a resume failure first, the rows go back to `pending` (re-entering the head of the queue in their original order) and `delivery_failed{messageIds, reason}` is appended (history stays append-only); the UI marks those `message_in` blocks "Not delivered", and the resend after the fix appends a new `message_in` (e.g. `--reset-session`). A rejected write (`ProcessNotRunningError`, EPIPE) leaves the rows `pending` and appends `delivery_failed`.

`exited` clears the urgent hold, the compact-in-flight flag and the in-flight set (rolling back unconfirmed batches per rule 7). A confirmed batch whose answering turn never ran because of an unexpected exit stays `delivered` with `delivered_turn_id` null (§16).

Why interrupt-then-hold rather than message-then-interrupt: in `interrupt-with-queued-message` the message (3.4 s) and the interrupt (4.9 s) were both written inside one 25 s `ping`, so no tool boundary fell between them. `midturn-messages-absorbed` shows a message written mid-turn is absorbed at the next tool boundary. So whenever the turn isn't inside a tool (the model is generating, or a tool just finished), a message written first is absorbed into the running turn and the interrupt then aborts that very turn: nothing is left queued and the urgent message gets no reply. `interrupt-then-message` (interrupt 5.5 s, result 5.5 s, message 6.5 s → normal new turn) works wherever the turn is. Both control responses report `still_queued:[]` even when a message was queued, so absorption can't be detected from them. A stray interrupt landing just after a natural `result` is harmless (`interrupt-while-idle`).

### 8.4 Turns and attribution

- A turn **opens** at `turn_started` (each `system/init`). A `turns` row is inserted then. Self-started turns (task notifications, cron firings, Monitor, the post-resume orphan report) and compact turns open the same way, because each starts with its own `system/init` (asserted with `background-bash-start-finish`, `cron-create-fire-delete` and `manual-compact`).
- A turn **closes** at `turn_end`: the row gets `ended_at`, usage, cost, model, `origin_kind`, `is_error`, `terminal_reason`. Any `exited` closes an open turn with `is_error = !expected` and `terminal_reason = "process_exited"` or `"process_stopped"`.
- Background, cron and task events never open a turn. Events between turns (`process_started`, `session_started`, `exited`, idle-time `control`, `delivery_failed`, `session_reset`, background notifications after the last `result`, spawn/resume `error`) have `turn_id = null` (Q22, Q26).
- **Attribution of a written batch** (`messages.delivered_turn_id`): if a turn is open when the batch is written, it is that turn (absorbed mid-turn, per S0). Otherwise the batch waits for the first turn that ends with **no** `originKind`; origin-tagged turns (orphan report, task notification, cron) never take it. Known edge: a message written in the instant a turn's final `result` is already in the pipe is attributed to that closing turn, and its reply then lands in the next turn (harness-driver.md: "probably becomes the next turn"). Accepted for S3.

### 8.5 Status (derived)

| Status | When |
|---|---|
| `errored` | stored in `agents.status`; set by a failed start, a resume failure or an unexpected exit; cleared by the next `session_started` |
| `working` | not errored, and the process is starting, or a turn is open, or a batch is awaiting its turn, or a compact is in flight |
| `idle` | not errored, process running, none of the above |
| `hibernated` | no process (the stored default) |

Only `errored` is stored; the column holds `hibernated` or `errored` (Q12). Every change is published as an `agent_status` frame `{agent, status, turnOpen, lastError?}`; `turnOpen` drives the Interrupt button, so "starting" (working, no turn) doesn't offer an interrupt the API would reject. Names match the product so S5 extends the set.

## 9. HTTP API (`apps/server/src/routes/agents.ts`)

All routes require a signed-in user (existing `requireUser`). Errors use the S1 shape `{error:{code,message}}`. Request and response schemas live in `packages/shared`.

| Method & path | Body / query | Result |
|---|---|---|
| `GET /api/agents` | — | `{agents: AgentSummary[]}`; `AgentSummary = {slug, displayName, description, status, turnOpen, runtime:"local", lastError?}` |
| `GET /api/agents/:slug` | — | `{agent: AgentSummary, queue: QueueItem[], lastSeq}` |
| `GET /api/agents/:slug/events` | `before=<seq>` or `around=<seq>`, `limit` (default 200, max 500) | `{events: SessionEvent[], hasMore: {before, after}}` in ascending seq. No cursor = newest page. `around` of a seq that doesn't exist → `404 event_not_found`. |
| `POST /api/agents/:slug/messages` | `{body: string (trimmed non-empty, ≤ 64 KiB UTF-8), urgent: boolean}` | `202 {item: QueueItem}`. A failure to start before spawn → the row stays pending and the response is `503 {error:{code:"agent_start_failed", message}}` (the message is still in the queue and shows as not delivered). Failures after spawn (resume failure, exit) arrive as events, not in this response. |
| `POST /api/agents/:slug/compact` | `{focus?: string (≤ 2000 chars)}` | `202 {item: QueueItem}`; `503 agent_start_failed` as above. |
| `POST /api/agents/:slug/interrupt` | — | `202`; `409 no_open_turn` when no turn is open. |

`QueueItem = {id, kind: "message"|"compact", body?, focus?, urgent?, from, createdAt}` (`urgent` only on messages): the queue in order (pending messages and queued compacts). `SessionEvent = {seq, agentSlug, turnId, at, event, truncated?}` where `event` is the persisted event typed as the `HarnessEvent` union (plus the factory-only types), i.e. `{type, ...payload}` (DB columns `type` and `payload`). Unknown slug → `404 agent_not_found`.

## 10. WebSocket (`ws/route.ts`, extends S1)

Client frames (added to `clientMessageSchema`):
- `{type:"subscribe", agent:<slug>, afterSeq:<number>}`
- `{type:"unsubscribe", agent:<slug>}`

Server frames (added to `serverMessageSchema`):
- `{type:"session_event", agent, event: SessionEvent}` (subscribers of that agent)
- `{type:"queue", agent, items: QueueItem[]}` (subscribers; whenever the queue changes)
- `{type:"agent_status", agent, status, turnOpen, lastError?}` (**every** authenticated socket, so the Agents list needs no subscription)
- `{type:"resync", agent}` (the replay gap exceeds 1000 events: the client reloads the newest page over HTTP and resubscribes)
- existing `hello`, `pong`, `error`

Subscribe is gap-free (Q11): the server registers the socket on the `EventBus` first (buffering live events), reads rows with `seq > afterSeq` from the DB and sends them, then drains the buffer skipping any seq already sent, then streams live. It also sends the current `queue` and `agent_status`. Because events are published only after commit and in seq order (§8.2), nothing falls between the DB read and the buffer. On reconnect the client resubscribes with the highest seq it holds; while it shows an older `around` window it subscribes with `afterSeq = lastSeq` from `GET /api/agents/:slug` and only counts new events (UI doc §4.3). The client also de-duplicates by seq. Unknown agent → `error{code:"agent_not_found"}`.

## 11. Failures

| Failure | What happens |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` unset | Start fails before spawn: `error{source:"spawn", message:"Set CLAUDE_CODE_OAUTH_TOKEN to run agents"}`, agent `errored` (`lastError` set), API `503`, items stay pending. |
| `claude` not found / not executable | Spawn failure (§5.5): same outcome, delivered as events; the tentative batch rolls back. |
| Resume of a missing session | A `result` before any `system/init`, mapped to `error{source:"resume", message: result.errors[0]}`: `stop()`, `exited`, tentative batch rolled back with `delivery_failed`, `errored`. Never auto-reset. The next message retries and fails the same way (accepted crash loop; S5 owns restart policy). The human stops the server, runs `pnpm seed:dev-agent --reset-session` and starts it again, after which the pending messages go into a new session. |
| Unexpected exit while running | `exited{expected:false}`, open turn closed as errored, a tentative batch rolled back, `errored`. Pending items stay pending; the next message or compact starts the process with `--resume`. Leftover-process cleanup is S5. |
| API error / refusal inside a turn | One `error` event + `turn_end{isError:true}`. The process is alive; status stays derived (not errored). |
| WS client falls far behind | `resync` frame. |
| DB write fails in a job | Logged at error; the runtime stops the process (`stop()`), marks `errored`, and drops further events of that process. Persisted history must not silently skip events. |

## 12. Database (`packages/db`), one new migration

```
agents
  id text pk, slug text unique not null, display_name text not null, description text not null default '',
  session_id text null, status text not null default 'hibernated'   -- 'hibernated' | 'errored' in S3
  created_at, updated_at
turns
  id text pk, agent_id text fk → agents on delete cascade, started_at not null, ended_at null,
  origin_kind text null, model text null, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens integer null,
  cost_usd numeric(12,6) null, is_error boolean null, terminal_reason text null
  index (agent_id, started_at)
session_events
  id bigserial pk, agent_id text fk → agents on delete cascade, seq integer not null,
  turn_id text null fk → turns, type text not null, payload jsonb not null, at timestamptz not null default now()
  unique (agent_id, seq)          -- the deep-link id and the ordering truth
messages
  id text pk, kind text not null default 'message', from_user_id text fk → users not null,
  to_agent_id text fk → agents on delete cascade not null, body text not null, urgent boolean not null default false,
  state text not null default 'pending' (pending | delivered), delivered_turn_id text null fk → turns,
  created_at not null, delivered_at null
  index (to_agent_id, state, created_at)
```

Columns from `data-model.md` that S3 doesn't use (`kind`, `template`, `reports_to`, `credential_id`, `runtime`, `busy`, `pinned_crons`, the other `messages` addressing columns, `task_id`, …) are added by the specs that use them. Ids are `crypto.randomUUID()`.

**Seq allocation:** inside the agent's serial job queue, `insert … select coalesce(max(seq), 0) + 1 … where agent_id = $1` in the same statement, backed by the unique index. The queue makes the server the only writer; a unique violation is a bug and fails the job (§11).

**Dev seed** (`seedDevAgent(db, config)`; CLI `pnpm seed:dev-agent` → `apps/server/scripts/seed-dev-agent.ts`; dev tooling, never imported by the server entry point; S4 deletes both):
- idempotent upsert of `dev`; creates the working dir, `AGENTS.md` (only if missing) and `.claude-config/`;
- `--reset-session`: refuses with "Stop the server first" if `GET <PUBLIC_URL>/api/status` answers (the server must not be writing for this agent); otherwise clears `session_id`, sets status `hibernated`, and appends `session_reset{by:"seed script"}` with the next seq.

## 13. Testing

Few, thorough tests per behaviour. No automated test calls a live model.

### 13.1 Harness unit tests (`packages/harness`)

- **Mapper:** for every fixture `.jsonl`, run the mapper over all lines and assert the event sequence (inline snapshots per fixture, reviewed once). Specific assertions: `session_started` once per process, `turn_started` per `system/init`; `rate_limited` absent for `allowed`; `turn_end.isError` true for `is_error:true, subtype:"success"`; one `error` per turn for the refusal (`error-refusal-and-failed-compaction`); `compacted` with trigger, tokens and summary for `auto-compaction` and `manual-compact`; `compact_failed` for the failed manual and auto compactions; `cron_created`/`cron_deleted` ids; `background_task_started` only for `is_backgrounded:true`; foreground task notifications dropped (`midturn-messages-absorbed`, `user-message-priority-now`); orphan notifications mapped (`resume-after-sigkill-orphans`); `turn_end.originKind` present only for self-started turns (`task-notification`, and `cron` for both cron fixtures); `turn_end.command:"compact"` on compact results; a pre-init `result` maps to only `error{source:"resume"}` (`error-resume-missing-session`); every drop in §6.2 yields nothing; thinking blocks yield nothing.
- **Envelope:** escaping, batching, forged close tags in several spellings.
- **Fake claude** (`testing/fake-claude.mjs`): an executable Node script that reads stdin NDJSON and replays fixture lines. A scenario (env `FAKE_CLAUDE_SCENARIO`) is a list of steps built from fixture slices, e.g. "on a user line → emit lines N–M of `rate-limit-event-allowed.jsonl` with the session id replaced", "on a `/compact` line → emit the `manual-compact` slice", "a long tool step that ends early on an interrupt control_request → emit the `interrupt-then-message` interrupt slice". Built-in behaviours: a non-JSON stdin line → exit 1 with the fixture's stderr text; stdin close → exit 0 after the current step; SIGTERM → exit 143; `--resume <unknown>` → the `error-resume-missing-session` lines and stderr, exit 1 when stdin closes; `--resume <known>` → reuses that session id (and can emit the orphan-report slice first). It records argv, env, pgid and stdin to the file named by `FAKE_CLAUDE_LOG`.
- **ClaudeProcess** against the fake: args (with/without resume and model), env passed through unchanged, own process group, NDJSON writes and write-promise rejection after exit, stderr tail, unexpected exit, `stop()` close-stdin path and SIGTERM path, spawn ENOENT.

### 13.2 Server tests (`apps/server`, real Postgres via the existing helpers)

Test-infra changes: `AppDeps` gains `harnessDriver?` (default the Claude driver); `makeTestApp` sets `FACTORY_HOME` to a temp dir and `CLAUDE_CODE_OAUTH_TOKEN` to a dummy, and gains a `keepDb` option plus a `reopen()` that builds a second app on the same DB (for the restart case); tests seed with `seedDevAgent`.

- `buildAgentEnv`: allowlist only; `DATABASE_URL`, `FACTORY_SECRET_KEY`, `ANTHROPIC_API_KEY` absent.
- Runtime with a **fake `HarnessDriver`** (in-memory, scripted events): batching; mid-turn write and attribution to the open turn; strict FIFO with compact as a barrier; urgent hold released by `turn_end` and by the 10 s timeout (fake timers); no second interrupt during a hold; Interrupt 409 while idle and while starting; pending on start failure then delivered as one turn on the next start; tentative first batch confirmed by `session_started` and rolled back (with `delivery_failed`) on exit or on a result before `session_started`; attribution skipping an origin-tagged orphan turn; turn open/close including self-started, compact, background-after-last-result (no phantom turn) and `exited` closing an open turn (expected and unexpected); status derivation; payload cap on a code-point boundary; seq order of `message_in` before its reply; a failed DB write stops the process.
- **Assembled system test** (Q5): the real `ClaudeDriver` against the fake claude, through `buildApp`: sign up → `POST /messages` → the fake sees the envelope on stdin → events persisted with seq 1..n → a subscribed WS client receives them in order → `GET /events?around=` returns the window. A second case: `app.close()` with a turn in progress stops the fake within the shutdown budget (SIGTERM path); `reopen()`, send a message, assert the fake was started with `--resume <same id>`.
- WS: subscribe replay with no gaps or duplicates when events are written during the replay; `resync`; `agent_status` to unsubscribed sockets; unknown agent.
- Routes: 404s, 409 interrupt, 503 start failure, body size and validation.

### 13.3 Live smoke script (`pnpm smoke:harness`, not part of `pnpm test`)

`apps/server/scripts/smoke-harness.ts` runs the real `AgentRuntime` with the real `ClaudeDriver` and the real Postgres `EventStore` against the local compose DB (a throwaway database), bypassing only HTTP and auth (Q27). It needs `CLAUDE_CODE_OAUTH_TOKEN`, uses `--model haiku`, an empty config dir and a temp workdir. Steps, each asserted and printed: send ("remember the word HERON") → reply; Compact → `compacted{trigger:"manual"}` with tokens; urgent mid-tool (a foreground `sleep 20`); urgent mid-generation (a long text answer); urgent just after a natural `result`; `stop()` → start again with `--resume` → "what word?" → HERON. The PR records the output.

### 13.4 Web tests

Timeline rendering per event type from fixture-derived `SessionEvent`s (envelope → sender badge, never raw XML; tool call + result paired and collapsed; unpaired calls after their turn ended show "No result"; compaction marker shows both counts; truncation note), composer (Enter sends, urgent toggle and hint, disabled states), Interrupt follows `turnOpen`, deep-link scroll and highlight and the 404 fallback, queue items as "Not delivered yet" and "Compact queued". Details in the UI design doc.

## 14. UI

See the UI design doc. Summary: `/agents` lists agents (one row for `dev`: status, name, slug, Unsandboxed badge); `/agents/$slug` is the session view: a header with name, status and actions (Compact with an optional focus popover, Interrupt), an agent strip under it, one continuous timeline, a composer with an Urgent toggle; `?event=<seq>` deep-links to an event. The composer always wraps text in an envelope: "/compact" typed there is plain text to the agent, and there is no `/clear` in the UI (Q10).

## 15. Shared plumbing touched

- `apps/server/src/shutdown.ts`: force-exit timeout 10 s → 20 s, with a comment (§8.1). Called out in the PR's Changes section.
- `packages/shared/src/ws.ts`: new client and server frames (§10).
- `apps/server/src/app.ts`: `AppDeps.harnessDriver?`, `app.runtimes`, the agents routes.
- `apps/server/src/test/helpers.ts`: §13.2 changes.
- `apps/web/src/components/page-header.tsx`: an optional `meta` slot after the title (UI doc §3).

## 16. Known gaps and follow-ups (issues to open)

- **Local runtime runs without the `allow_local_runtime` gate** (agent-runtime.md requires it). Acceptable for the one-agent dev skeleton; owned by S5. The UI shows "Unsandboxed". Not a default for later specs.
- **Crash loop on a bad resume id** is accepted; S5 owns restart policy.
- **No leftover-process cleanup** after an unexpected exit (S5).
- A confirmed batch whose answering turn never ran because the process exited unexpectedly stays `delivered` with `delivered_turn_id` null (the agent may or may not have seen it; S5's crash notice covers it).
- **Queued compacts are in memory** and are lost on a server restart (messages are not).
- **Token streaming** (`--include-partial-messages`, `assistant_delta` frame): later spec, if wanted.
- **Timeline virtualization:** only if measured slow.
- **Product doc wording** (sent to the lead, who owns the bundle; not edited here): harness-driver.md "Interrupt" and message.md "Urgent" should describe the mechanics (the interrupt is written first; the urgent message and anything after it are held by the factory until the interrupted turn's `result`, 10 s fallback; then written as the next turn); manual `/compact` is a turn ending with a `result` and is held until no turn is open; a stray interrupt on an idle process is harmless; a rate limit is `status:"rejected"` only (`allowed_warning` is a warning, `overageStatus` is irrelevant); `result.total_cost_usd`/`modelUsage` are cumulative per process; task statuses include `failed`/`killed`; Monitor is bounded by `timeout_ms` (not "alive indefinitely"); `num_turns:0` also appears on compact results, so only `result.origin` identifies self-started turns; and the event list gains `turn_started`, `compact_failed`, `model_fallback` and the factory-only `process_started`, `control`, `delivery_failed`, `session_reset`.
- `FACTORY_DEV_MODEL` and the seed script are removed in S4.
- From the lead's Agent SDK cross-check (documented in the SDK types, not verified here): a `uuid` on each injected user message is echoed in `result.user_message_uuid(s)`, which would bind replies to sends and detect absorbed-but-lost messages (could replace §8.4's attribution heuristics); `system/session_state_changed` (`idle|running|requires_action`, needs `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`) as the authoritative busy signal for S5; poisoned resumes (a 400 mentioning `diagnostics.previous_message_id` or "Could not process image") never recover and should not be retried (S5); resume works only from the same cwd (S4/S5 must keep the working dir path stable); Bash tools run in their own session (`setsid`), so a process-group kill misses them (S5 cleanup); `--mcp-config` + `--strict-mcp-config` instead of `.mcp.json` would avoid the unverified `enableAllProjectMcpServers` question (S4/S6); Monitor is bounded (`timeout_ms` default 300000, max 1800000) unless persistent.

## 17. Decisions needing Or's call (owner-proxy certainty 3/5)

- **Q2 Streaming granularity:** block granularity, no token streaming. "Watch the reply stream in" might be meant literally.
- **Q4 `FACTORY_DEV_MODEL`:** a labeled stopgap env var. Or might drop it and always use Claude's default.
- **Q6 Raw stream logging:** raw lines only in the server log at debug, no per-agent raw log file. Or might want an append-only file.
- **Q16 UI design artifact:** a separate design doc (S1 precedent) rather than a section of this spec.
- **Q27 Smoke script store:** the smoke runs against the real Postgres `EventStore` (needs the compose DB), not an in-memory store.

(Q13, urgent ordering, was first decided as message-then-interrupt at certainty 3, then reversed on trace evidence to interrupt-then-hold at certainty 4; see §8.3 and the decision log.)
