# S3 Walking skeleton (one agent): Technical Design

- **Date:** 2026-11-18
- **Status:** approved by owner-proxy (owner-s3), pending Or's review on the low-certainty items (see §16)
- **Roadmap spec:** `docs/product/roadmap/v0.1/s03-walking-skeleton.md`
- **UI design:** [`docs/superpowers/designs/2026-11-18-s3-session-ui-design.md`](../designs/2026-11-18-s3-session-ui-design.md)
- **Product sources of truth:** `docs/product/architecture/harness-driver.md`, `agent-runtime.md`, `workspace.md`, `permissions.md`, `data-model.md`; `docs/product/concepts/message.md`, `session.md`; `docs/product/behavior/agents-and-sessions.md`; `docs/product/open-questions.md` ("Verified during design", the S0 findings).
- **Evidence:** the S0 stream-json traces in `packages/harness/fixtures/` (Claude Code 2.1.327), indexed in `packages/harness/fixtures/README.md`.
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

Out (roadmap): Docker, hibernation and the warm window, templates, multiple agents (the code is per agent, but only `dev` is seeded and there is no create UI), the factory MCP. Also out here: token-by-token streaming (§6.6), a Restart/Stop button (S5), crash-loop policy and leftover-process cleanup (S5), the `allow_local_runtime` gate (S5, see §15), named credentials (S4), usage display (S10), the org tree (S4/S6), thinking blocks (§6.5).

## 4. Architecture

```
web (session view) ──HTTP──► routes/agents.ts ──► AgentRuntime (per agent, in memory)
        ▲                                            │  delivery queue (pending messages, compact)
        │ WS frames                                  │  turn tracking, status
        └── ws/route.ts ◄── EventBus ◄── EventStore ◄┤  (single serialized writer per agent)
                                                     ▼
                                    HarnessDriver (packages/harness)
                                     └─ ClaudeProcess: spawn claude -p … stream-json
                                         stdin NDJSON writer │ stdout line parser → mapper → HarnessEvent
```

Units and what they own:

| Unit | Package | Owns |
|---|---|---|
| Event types (`HarnessEvent`, `SessionEvent` DTO, WS frames) | `packages/shared` | Zod schemas shared by server, harness and web. No stream-json types. |
| `HarnessDriver`, `HarnessProcess`, `AgentRuntimeSpec` | `packages/harness` | The boundary (§5). |
| Claude mapper | `packages/harness/src/claude/mapper.ts` | Pure: one parsed stdout line + small state → zero or more `HarnessEvent`s. |
| `ClaudeProcess` | `packages/harness/src/claude/process.ts` | Spawn, stdin writer, line splitter, stderr tail, exit, stop. |
| Envelope renderer | `packages/harness/src/envelope.ts` | `FactoryMessage[]` → the user-turn text. |
| Fake claude | `packages/harness/testing/fake-claude.mjs` | Test double executable built from the S0 fixtures (§13.1). |
| `AgentRuntimes` / `AgentRuntime` | `apps/server/src/agents/` | Process lifecycle, delivery queue, urgent hold, turns, status. |
| `EventStore` | `apps/server/src/agents/event-store.ts` | Seq allocation, payload cap, history queries. |
| `EventBus` | `apps/server/src/agents/event-bus.ts` | In-process pub/sub per agent for WS. |
| Runtime spec builder | `apps/server/src/agents/runtime-spec.ts` | `buildRuntimeSpec(agent, config)` and `buildAgentEnv(...)`: the one place S4 replaces. |
| Routes | `apps/server/src/routes/agents.ts`, `ws/route.ts` | HTTP API (§9) and WS frames (§10). |
| Web | `apps/web/src/routes/_app/agents*.tsx`, `src/features/session/` | Agents list and session view (UI design doc). |

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
  id: string; from: string;          // "@or" (human handle) or an agent slug later
  kind: "message";                   // S3 produces only this kind
  urgent: boolean; body: string; taskKey?: string;
}

interface HarnessDriver {
  start(spec: AgentRuntimeSpec, opts: { resumeSessionId?: string }): HarnessProcess;
}
interface HarnessProcess {
  readonly pid: number | undefined;
  send(messages: FactoryMessage[]): void;                    // exactly one user turn
  control(cmd: "compact" | "clear" | "interrupt", arg?: string): void;
  stop(opts?: { graceMs?: number }): Promise<ExitInfo>;     // close stdin, wait graceMs (default 10_000), then SIGTERM
  events: AsyncIterable<HarnessEvent>;                       // ends after `exited`
}
```

Differences from the product doc's sketch, all additive: `start` returns synchronously (spawn errors arrive as `error` + `exited` events, so there is one failure path); `stop` takes a grace period (`graceMs: 0` = SIGTERM now, for Terminate/Restart later) and returns exit info; `pid` is exposed for S5's process-tree bookkeeping.

### 5.1 Command line

```
<claudeBin> -p --input-format stream-json --output-format stream-json --verbose \
  --permission-mode auto [--resume <session-id>] [--model <m>]
```

No `--include-partial-messages` (§6.6). Spawned with `stdio: ["pipe","pipe","pipe"]`, `cwd: spec.cwd`, `env: spec.env` (no merge with `process.env`), not detached.

### 5.2 Writing to stdin

- Every line is `JSON.stringify(obj) + "\n"`. Nothing else ever writes to stdin, because a malformed line kills the process (S0, `error-malformed-stdin-line`).
- `send(messages)`: one `{"type":"user","message":{"role":"user","content":<envelopes>}}` line. Never sets `"priority"` (S0: `priority:"now"` aborts the turn at the next tool boundary without killing the tool).
- `control("compact", focus?)` → a user line with content `/compact` or `/compact <focus>`. `control("clear")` → `/clear`. `control("interrupt")` → `{"type":"control_request","request_id":<uuid>,"request":{"subtype":"interrupt"}}`.
- Writes after stdin has closed or the process has exited throw `ProcessNotRunningError`; the runtime treats that as "not delivered".

### 5.3 Envelope (`envelope.ts`)

Per message:

```
<factory-message from="@or" kind="message" urgent="false" id="<message id>">
<body>
</factory-message>
```

A batch is the envelopes joined by a blank line, in order, as one user turn (Message concept). Attribute values are XML-attribute-escaped (`& < > "`). In the body, any literal `<factory-message` or `</factory-message` is escaped to `&lt;factory-message` / `&lt;/factory-message` so a body cannot forge or close an envelope; nothing else in the body is changed. Unit-tested, including a body that tries to close the envelope.

### 5.4 Reading stdout and stderr

- stdout is split on `\n`; empty lines skipped; each line `JSON.parse`d. A non-JSON line is logged at warn and skipped (it has never been observed).
- Every raw stdout line is logged at `debug` with the agent slug. Unmapped `type`/`subtype` values are logged at `warn` once per kind per process (Q6).
- stderr is logged at `warn` line by line and kept in a ring buffer of the last 50 lines / 8 KB, which becomes `exited.stderrTail` and the text of start-failure errors.

### 5.5 Exit

On the child's `exit`, the process emits `exited{code, signal, stderrTail, expected}` (`expected` = `stop()` was called) and ends the iterable. A spawn failure (`ENOENT`, `EACCES`) emits `error{source:"spawn", message:"Claude Code not found: set FACTORY_CLAUDE_BIN or put claude on PATH"}` and then `exited{code:null, signal:null, expected:false}`.

`stop()` closes stdin, waits `graceMs` for exit, then sends SIGTERM and waits up to 10 s more. It never sends SIGKILL (S0: SIGKILL orphans background shells). If the process is still alive after SIGTERM + 10 s, `stop()` resolves with `{timedOut: true}` and logs an error; cleanup of such a process is S5's.

## 6. Event model

### 6.1 `HarnessEvent` (factory-owned, `packages/shared/src/events.ts`)

| Type | Payload | Source |
|---|---|---|
| `session_started` | `sessionId, model, cwd, claudeCodeVersion` | first `system/init` per process (later repeats ignored) |
| `message_in` | `messages: {id, from, kind, urgent, body, taskKey?}[]` | **factory**, when a user turn is written (stream-json does not echo input) |
| `assistant_text` | `text, parentToolUseId?` | `assistant` content block `type:"text"` |
| `tool_call` | `toolUseId, name, input, parentToolUseId?` | `assistant` content block `type:"tool_use"` |
| `tool_result` | `toolUseId, content (string), isError` | `user` message content block `type:"tool_result"` (text parts joined; non-text parts summarised as `[image]` etc.) |
| `background_task_started` | `taskId, toolUseId, taskType, description?` | `system/task_started` with `is_backgrounded:true` |
| `background_task_finished` | `taskId, status, summary` | `system/task_notification` |
| `background_tasks` | `tasks: {taskId, taskType, description?}[]` | `system/background_tasks_changed` (full live set) |
| `cron_created` | `cronId, recurring, humanSchedule, nextFireAt` | `CronCreate` tool result (`tool_use_result.id`) |
| `cron_deleted` | `cronId` | `CronDelete` tool call `input.id` |
| `permission_denied` | `toolName, toolUseId, reasonType, reason` | `system/permission_denied` |
| `compacted` | `trigger: "manual"\|"auto", preTokens, postTokens, summary?` | `system/compact_boundary` + the following synthetic summary user message |
| `usage` | `model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, durationMs, numTurns` | `result` |
| `rate_limited` | `status, resetsAt, rateLimitType` | `rate_limit_event` **only when `status != "allowed"`** |
| `turn_end` | `isError, terminalReason, originKind?, numTurns` | `result` (error = `is_error`, whatever `subtype` says) |
| `error` | `source: "api"\|"refusal"\|"compaction"\|"spawn"\|"resume", message, detail?` | API-error results, `system/model_refusal_no_fallback`, `status{compact_result:"failed"}`, spawn failure, resume failure |
| `exited` | `code, signal, stderrTail, expected` | child exit |

Plus three **factory-only** event types that the server appends (they never come from a driver): `process_started{resumed}`, `control{cmd, arg?, by}` (Q17; `by` is the human's `@handle`), and `session_reset{by}` (the seed script, §12).

The mapper is a pure function with a small per-process state: whether `session_started` was emitted, the pending `compacted` (held for one line to pick up the summary), the `CronCreate` tool-use ids seen, and whether a `compacting` status is open. It is tested against every S0 fixture (§13.1). `background_*`, `cron_*` and `rate_limited` are mapped and persisted now so S5 and S9 can rely on them; the UI shows them as quiet lines (UI design §4).

### 6.2 Things the mapper drops on purpose

`system/thinking_tokens`, `system/commands_changed`, `system/task_updated`, `system/task_progress`, `system/informational`, `system/status` (except as compaction input), `control_response`, `rate_limit_event` with `status:"allowed"`, `command_lifecycle`, and `thinking` content blocks (§6.5). Each is listed in a test that asserts it yields nothing.

### 6.3 Resume

On `--resume`, Claude may first emit `task_notification{status:"stopped", summary:"Orphaned…"}` lines and a zero-cost `result` with `num_turns: 0` (`resume-after-sigkill-orphans`). These map normally (`background_task_finished`, `usage`, `turn_end`); that turn is a self-started turn (§8.4) and is never counted as the reply to a delivered message.

A resume of an unknown id yields `result{subtype:"error_during_execution", num_turns:0}`, stderr "No conversation found…" and exit 1 (`error-resume-missing-session`). The runtime turns that into `error{source:"resume"}` with the stderr line, marks the agent `errored`, and **never** starts a fresh session on its own (Q8).

### 6.4 Payload cap

One rule at the persistence boundary (`EventStore`), not per type: any string field in a payload longer than 64 KiB (UTF-8 bytes) is cut to 64 KiB, and the payload gains `truncated: {<field path>: <original byte length>}`. The UI shows "Truncated (1.2 MB)". The full content stays in Claude's own session JSONL (Q7).

### 6.5 Thinking

Dropped. All 45 thinking blocks in the S0 fixtures are empty (signature only). Revisit if a later Claude Code emits thinking text (Q9).

### 6.6 Streaming granularity

Block granularity: no `--include-partial-messages`. Each text block and tool call appears when Claude emits it, and a "working" indicator covers the gap. The WS frame union (§10) is the seam: a transient `assistant_delta` frame can be added later without changing anything else (Q2).

## 7. Agent, workspace and environment

### 7.1 The dev agent

One row, slug `dev`, display name "Dev agent", created by the seed script (§12). Working dir `FACTORY_HOME/agents/dev/` with a short placeholder `AGENTS.md` and an empty `.claude-config/`. `CLAUDE_CONFIG_DIR=<workdir>/.claude-config` (workspace doc, ADR 0010). The runtime is local and the UI shows the "Unsandboxed" badge.

### 7.2 Child environment (`buildAgentEnv`)

An explicit allowlist, built in one function that S4 extends (Q18):

- copied from the server env if set: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `TMPDIR`;
- set by the factory: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`.

Nothing else is inherited: not `DATABASE_URL`, `FACTORY_SECRET_KEY`, `ANTHROPIC_*`, other `CLAUDE_*`, `SSH_AUTH_SOCK` or anything added to the server env later. A test asserts `DATABASE_URL`, `FACTORY_SECRET_KEY` and `ANTHROPIC_API_KEY` are absent.

### 7.3 Configuration (new env vars)

| Var | Default | Notes |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Read by `resolveClaudeToken(config)` (one function; S4 replaces it with named credentials). Missing → start fails closed with "Set CLAUDE_CODE_OAUTH_TOKEN to run agents". Never falls back to the host login (Q1). Optional for the server to boot. |
| `FACTORY_CLAUDE_BIN` | `claude` | Path or command name. Tests point it at the fake. |
| `FACTORY_DEV_MODEL` | unset (no `--model`) | **Stopgap, removed in S4** (the model comes from the template). Marked so in `config.ts` and `.env.example`. Feeds `AgentRuntimeSpec.model` in one place (Q4). |

The token is redacted in logs (added to the logger's redact paths and never logged as part of a spec).

### 7.4 Claude Code version

On the first start after boot the server runs `<claudeBin> --version` once (5 s timeout), logs it, and logs a warning if it is older than 2.1.327 (the version S0 verified). It never refuses to start (Q19). If the binary is missing, that surfaces as the spawn failure in §5.5.

## 8. Runtime (`apps/server/src/agents/`)

### 8.1 `AgentRuntimes`

A registry decorated on the Fastify app: `get(agentId)` returns the agent's `AgentRuntime`, created lazily. On `app.close()` (the existing graceful-shutdown path) it calls `stop()` on every running process in parallel and waits. On boot nothing starts; agents start on demand (Q3). There is no Stop endpoint and no idle timeout.

### 8.2 `AgentRuntime` (one per agent)

State: the `HarnessProcess` or none; `openTurnId` or none; the **delivery queue**; the urgent hold; the derived status.

**Start on demand** (`ensureStarted`): called by send, compact and interrupt. Builds the spec, resolves the token (missing → fail), spawns with `resumeSessionId = agents.session_id` if set, appends `process_started{resumed}`, and starts the event pump. The first `session_started` makes the start "successful": `agents.session_id` is set if it was null (and checked equal if it was set; a mismatch is logged as an error), and a persisted `errored` status is cleared. A start that fails before `session_started` leaves the agent `errored` (§11).

**Event pump:** for each `HarnessEvent`, in order: assign the turn (§8.4), persist through `EventStore` (assigns `seq`), publish on `EventBus`, then react (status changes, turn close, delivery flush). One pump per process, so writes for an agent are serialized and `seq` order is emission order.

### 8.3 Delivery queue and urgent hold (one path)

All deliveries go through one per-agent queue (Q13, Q14). Items are human messages (`messages` rows, `state = pending`) and compact commands. The rule for writing:

1. A **message** may be written whenever the process is running and no urgent hold is active, including mid-turn (Claude absorbs it at the next tool boundary; S0 `midturn-messages-absorbed`). All pending messages that are writable at that moment go out as **one** user turn (envelopes in order). The `message_in` event is appended and the rows become `delivered` with `delivered_turn_id` = the open turn (the running one if absorbed, the new one otherwise) **only after** the stdin write returned without error.
2. A **compact** is written only when no turn is open (it is a slash command, and absorbing it mid-turn is unverified). It waits in the queue behind the current turn. Its `control` event is appended when written.
3. **Urgent** message while a turn is open: write the interrupt control request immediately and append `control{cmd:"interrupt"}`, then set the hold. While the hold is active, nothing in the queue is written (the urgent message and anything sent after it stay `pending`). The hold is released by that turn's `turn_end` (interrupted or natural, whichever arrives) or after 10 s (logged as a warning); then the queue flushes as one user turn per rule 1.
4. **Urgent** while idle: a normal send.
5. **Interrupt** action: allowed only while a turn is open (409 otherwise); writes the control request and appends `control{cmd:"interrupt"}`. No hold.
6. If the process isn't running, the item stays queued and `ensureStarted` runs; the queue flushes after `process_started` (pending messages become the first turn after the start, as in the product's wake semantics). If the start fails, items stay `pending`.

Why interrupt-then-hold rather than message-then-interrupt: in `interrupt-with-queued-message` the message (3.4 s) and the interrupt (4.9 s) were both written inside one 25 s `ping`, so no tool boundary fell between them. But `midturn-messages-absorbed` shows a message written mid-turn is absorbed at the next tool boundary. If the turn is not inside a tool (the model is generating, or a tool just finished), a message written first is absorbed into the running turn, and the interrupt then aborts that turn: nothing is left queued and the urgent message gets no reply. `interrupt-then-message` (interrupt 5.5 s, result 5.5 s, message 6.5 s → normal new turn) is verified regardless of where the turn is. Both control responses report `still_queued:[]` even when a message was queued, so absorption can't be detected from them. The case "interrupt arrives just after a natural `result`" (stray interrupt on an idle process) is unverified; the smoke script exercises it and the PR records the outcome.

### 8.4 Turns

- A turn **opens** when a user turn (messages or compact) is written while none is open, or when any driver event other than `session_started`/`exited` arrives while none is open (a self-started turn: task notification, cron firing, Monitor, the post-resume orphan report). A `turns` row is inserted at open.
- A turn **closes** at `turn_end`; the row gets `ended_at`, usage, cost, model, `origin_kind`, `is_error`, `terminal_reason`. An unexpected exit closes an open turn with `is_error = true`, `terminal_reason = "process_exited"`.
- Every event inside a turn carries `turn_id`. Events outside a turn (`process_started`, `session_started`, `exited`, idle-time `control`, `session_reset`, spawn/resume `error`) have `turn_id = null` (Q22).

### 8.5 Status (derived)

| Status | When |
|---|---|
| `errored` | persisted in `agents.status`; set by a failed start or an unexpected exit, cleared by the next `session_started` |
| `working` | not errored, process running, a turn is open (or the process is starting) |
| `idle` | not errored, process running, no open turn |
| `hibernated` | no process |

Only `errored` is stored (Q12). On boot, any `agents.status` other than `errored` is set to `hibernated`. Every change is published as an `agent_status` frame. Names match the product so S5 extends the set.

## 9. HTTP API (`apps/server/src/routes/agents.ts`)

All routes require a signed-in user (existing `requireUser`). Errors use the S1 shape `{error:{code,message}}`. Request and response schemas live in `packages/shared`.

| Method & path | Body / query | Result |
|---|---|---|
| `GET /api/agents` | — | `{agents: AgentSummary[]}` (`slug, displayName, description, status, runtime:"local"`) |
| `GET /api/agents/:slug` | — | `{agent: AgentSummary, pendingMessages: PendingMessage[], lastSeq}` |
| `GET /api/agents/:slug/events` | `before=<seq>` or `around=<seq>`, `limit` (default 200, max 500) | `{events: SessionEvent[], hasMore: {before: bool, after: bool}}` in ascending seq. No cursor = newest page. |
| `POST /api/agents/:slug/messages` | `{body: string (1..100_000 chars, trimmed non-empty), urgent: boolean}` | `202 {message: PendingMessage}`. Start failure → the row stays pending and the response is `503 {error:{code:"agent_start_failed", message}}`. |
| `POST /api/agents/:slug/compact` | `{focus?: string (≤ 2000)}` | `202`. Start failure → `503 agent_start_failed`. |
| `POST /api/agents/:slug/interrupt` | — | `202`; `409 not_running` when no turn is open. |

Unknown slug → `404 agent_not_found`. `SessionEvent` = `{seq, agentSlug, turnId, at, type, payload}`.

## 10. WebSocket (`ws/route.ts`, extends S1)

Client frames (added to `clientMessageSchema`):
- `{type:"subscribe", agent:<slug>, afterSeq:<number>}`
- `{type:"unsubscribe", agent:<slug>}`

Server frames (added to `serverMessageSchema`):
- `{type:"session_event", agent, event: SessionEvent}`
- `{type:"agent_status", agent, status}`
- `{type:"pending_messages", agent, messages: PendingMessage[]}` (whenever the pending set changes)
- `{type:"resync", agent}` (the replay gap exceeds 1000 events: the client reloads the newest page over HTTP and resubscribes)
- existing `hello`, `pong`, `error`

Subscribe is gap-free (Q11): the server registers the socket on the `EventBus` first (buffering live events), then reads rows with `seq > afterSeq` from the DB, sends them, then drains the buffer, skipping any `seq` already sent, then streams live. It also sends the current `agent_status` and `pending_messages`. On reconnect the client resubscribes with the highest seq it has. The client also de-duplicates by seq. Unknown agent → `error{code:"agent_not_found"}`.

## 11. Failures

| Failure | What happens |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` unset | Start fails before spawn: `error{source:"spawn", message:"Set CLAUDE_CODE_OAUTH_TOKEN to run agents"}`, agent `errored`, API `503`, items stay pending. |
| `claude` not found / not executable | Same, with the §5.5 message. |
| Resume of a missing session | `error{source:"resume"}` with the stderr line, `exited`, `errored`. Never auto-reset. The next message retries and fails the same way (accepted crash loop; S5 owns restart policy). The human runs `pnpm seed:dev-agent --reset-session`. |
| Unexpected exit while running | `exited{expected:false}`, open turn closed as errored, `errored`. Pending items stay pending; the next message or compact starts the process with `--resume`. Leftover-process cleanup is S5. |
| API error / refusal inside a turn | `error` event + `turn_end{isError:true}`. The process is still alive; status stays derived (not errored). |
| WS client falls far behind | `resync` frame. |
| DB write fails in the pump | Logged at error; the pump stops writing for that process and calls `stop()`; agent `errored`. (Persisted history must not silently skip events.) |

## 12. Database (`packages/db`), one new migration

```
agents
  id text pk, slug text unique not null, display_name text not null, description text not null default '',
  session_id text null, status text not null default 'hibernated'  -- only 'hibernated' | 'errored' stored in S3
  created_at, updated_at
session_events
  id bigserial pk, agent_id text fk → agents on delete cascade, seq integer not null,
  turn_id text null fk → turns, type text not null, payload jsonb not null, at timestamptz not null default now()
  unique (agent_id, seq)          -- the deep-link id and the ordering truth
messages
  id text pk, kind text not null default 'message', from_user_id text fk → users not null,
  to_agent_id text fk → agents not null, body text not null, urgent boolean not null default false,
  state text not null default 'pending' (pending | delivered), delivered_turn_id text null fk → turns,
  created_at, delivered_at null
  index (to_agent_id, state, created_at)
turns
  id text pk, agent_id text fk, started_at, ended_at null, origin_kind text null, model text null,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens integer null, cost_usd numeric(12,6) null,
  is_error boolean null, terminal_reason text null
  index (agent_id, started_at)
```

Columns from `data-model.md` that S3 doesn't use (`kind`, `template`, `reports_to`, `credential_id`, `runtime`, `busy`, `pinned_crons`, the `messages` addressing variants, `task_id`, …) are added by the specs that use them. Ids are `crypto.randomUUID()`.

**Seq allocation:** inside the agent's serialized pump, `insert … select coalesce(max(seq), 0) + 1 … where agent_id = $1` in one statement, backed by the unique index. On a unique violation (only possible if the seed script wrote concurrently) it retries once. No in-memory counter, so out-of-process writers stay safe.

**Seed script** (`apps/server/scripts/seed-dev-agent.ts`, `pnpm seed:dev-agent`, dev tooling, not imported by the server entry point; S4 deletes it):
- idempotent upsert of `dev`, creates the working dir, `AGENTS.md` (only if missing) and `.claude-config/`;
- `--reset-session`: clears `session_id`, sets status `hibernated`, appends `session_reset{by:"seed script"}`. Prints "Stop the server first" and refuses if it can connect to the server's `/api/status` on `PUBLIC_URL`.

## 13. Testing

Few, thorough tests per behaviour. No automated test calls a live model.

### 13.1 Harness unit tests (`packages/harness`)

- **Mapper:** for every S0 fixture `.jsonl`, run the mapper over all lines and assert the produced event sequence (inline snapshots per fixture, reviewed once). Specific assertions: `session_started` once per process although `system/init` repeats; `rate_limited` absent for `allowed`; `turn_end.isError` true for `is_error:true, subtype:"success"`; `compacted` with pre/post tokens and summary (`auto-compaction`); failed compaction → `error{source:"compaction"}`; `cron_created`/`cron_deleted` ids (`cron-create-fire-delete`); `background_task_started` only for `is_backgrounded:true`; the drop list in §6.2 yields nothing; thinking blocks yield nothing.
- **Envelope:** escaping, batching, forged close tag.
- **Fake claude** (`testing/fake-claude.mjs`): an executable Node script that reads stdin NDJSON and replays fixture lines. A scenario (env `FAKE_CLAUDE_SCENARIO`) is a list of steps built from fixture slices, e.g. "on user line → emit lines 1–7 of `rate-limit-event-allowed.jsonl` with the session id replaced". Behaviours: a non-JSON stdin line → exit 1 with the fixture's stderr text; `control_request interrupt` during a "long tool" step → emit the `interrupt-then-message` interrupt slice; stdin close → exit 0 after the current step; SIGTERM → exit 143; `--resume <unknown>` → the `error-resume-missing-session` lines and exit 1; `--resume <known>` → reuses that session id. It also records its argv, env and stdin to a file named by `FAKE_CLAUDE_LOG` for assertions.
- **ClaudeProcess** against the fake: args (with/without resume and model), env passes through unchanged, NDJSON writes, stderr tail, unexpected exit, `stop()` close-stdin path and SIGTERM path, `ProcessNotRunningError` after exit, spawn ENOENT.

### 13.2 Server tests (`apps/server`, real Postgres via the existing helpers)

- `buildAgentEnv`: allowlist only; `DATABASE_URL`, `FACTORY_SECRET_KEY`, `ANTHROPIC_API_KEY` absent.
- Runtime with a **fake `HarnessDriver`** (in-memory, scripted events): delivery batching, mid-turn write, compact waits for turn end, urgent hold released by `turn_end` and by the 10 s timeout (fake timers), pending on start failure then delivered as one turn on the next start, `delivered` only after a successful write, turn open/close including self-started and orphan-report turns, status derivation and boot healing, payload cap, seq allocation.
- **Assembled system test** (Q5): the real `ClaudeDriver` against the fake claude, through `buildApp`: sign up → `POST /messages` → the fake sees the envelope on stdin → events persisted with seq 1..n → a subscribed WS client receives them in order → `GET /events?around=` returns the window. A second case: stop the app, build it again on the same DB, send a message, assert the fake was started with `--resume <same id>`.
- WS: subscribe replay with no gaps or duplicates when events are written during the replay; `resync`; unknown agent.
- Routes: 404, 409 interrupt when idle, 503 start failure, validation.

### 13.3 Live smoke script (`pnpm smoke:harness`, not part of `pnpm test`)

`packages/harness/scripts/smoke.ts` drives the real `ClaudeDriver` (not the server) with `CLAUDE_CODE_OAUTH_TOKEN`, `--model haiku`, an empty temp config dir and workdir. Steps, each asserted and printed: send ("remember the word HERON") → reply; manual `/compact` → `compacted{trigger:"manual"}` with tokens; urgent mid-tool (foreground `sleep 20`); urgent mid-generation (a long text answer); urgent just after a natural `result` (stray interrupt on idle; the outcome is printed and recorded in the PR as a new finding); `stop()` → restart with `--resume` → "what word?" → HERON. It writes the trace to `packages/harness/fixtures/manual-compact.jsonl` (+ timeline) through `spikes/scrub.mjs`, so the manual-compact shape on the current Claude Code becomes a fixture (S0 only verified it on 2.1.319). The PR records the run.

### 13.4 Web tests

Timeline rendering per event type from fixture-derived `SessionEvent`s (envelope → sender badge, never raw XML; tool call + result paired and collapsed; compaction marker shows both counts; truncation note), composer (Enter sends, urgent toggle, disabled states), Interrupt disabled while idle, deep-link scroll and highlight, pending "Not delivered" row. Details in the UI design doc.

## 14. UI

See the UI design doc. Summary: `/agents` lists agents (one row for `dev`: name, slug, status, Unsandboxed badge); `/agents/$slug` is the session view: header with status and actions (Compact with an optional focus popover, Interrupt), one continuous timeline, a composer with an Urgent toggle; `?event=<seq>` deep-links to an event. The composer always wraps text in an envelope: "/compact" typed there is plain text to the agent, and there is no `/clear` in the UI (Q10).

## 15. Known gaps and follow-ups (issues to open)

- **Local runtime runs without the `allow_local_runtime` gate** (agent-runtime.md requires it). Acceptable for a one-agent dev skeleton, owned by S5. The UI shows "Unsandboxed". Not a default for later specs.
- **Crash loop on a bad resume id** is accepted; S5 owns restart policy.
- **No leftover-process cleanup** after an unexpected exit (S5).
- **Stray interrupt on an idle process** is unverified until the smoke run; record the result.
- **Token streaming** (`--include-partial-messages`, `assistant_delta` frame): later spec, if wanted.
- **Timeline virtualization:** only if measured slow.
- **Product doc wording** (sent to the lead, who owns the bundle; not edited here): harness-driver.md "Interrupt" and message.md "Urgent" should describe the mechanics: the interrupt is written first, the urgent message (and anything after it) is held by the factory until the interrupted turn's `result` (10 s fallback), then written as the next turn; and compact is held until the turn ends. Also add the `control`, `process_started`, `session_reset` factory events to the event list, and note that the manual-compact fixture was captured on the S3 smoke run.
- `FACTORY_DEV_MODEL` and the seed script are removed in S4.

## 16. Decisions needing Or's call (owner-proxy certainty 3/5)

- **Q2 Streaming granularity:** block granularity, no token streaming. "Watch the reply stream in" might be meant literally.
- **Q4 `FACTORY_DEV_MODEL`:** a labeled stopgap env var. Or might drop it and always use Claude's default.
- **Q6 Raw stream logging:** raw lines only in the server log at debug, no per-agent raw log file. Or might want an append-only file.
- **Q16 UI design artifact:** a separate design doc (S1 precedent) rather than a section of this spec.

(Q13, urgent ordering, was first decided as message-then-interrupt at certainty 3 and then reversed on trace evidence to interrupt-then-hold at certainty 4; see §8.3 and the decision log.)
