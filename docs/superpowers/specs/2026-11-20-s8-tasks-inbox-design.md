# S8 Tasks and inbox: Technical Design

- **Date:** 2026-11-20
- **Status:** approved by owner-proxy (owner-s8); pending the spec self-review and the impeccable UI review; pending Or's review of the low-certainty items (§22)
- **Roadmap spec:** `docs/product/roadmap/v0.1/s08-tasks-inbox.md`
- **UI design:** [`docs/superpowers/designs/2026-11-20-s8-tasks-inbox-ui-design.md`](../designs/2026-11-20-s8-tasks-inbox-ui-design.md)
- **Product sources of truth:** `docs/product/concepts/task.md`, `message.md`, `user.md`, `agent.md`, `reporting-line.md`; `docs/product/behavior/tasks.md`, `inbox.md`, `agents-and-sessions.md`; `docs/product/architecture/factory-mcp.md`, `data-model.md`, `context-assembly.md`, `usage-tracking.md`; ADRs 0002, 0004, 0012, 0015, 0019; `docs/product/open-questions.md` (S0 and S4–S7 findings).
- **Builds on:** S3 ([spec](2026-11-18-s3-walking-skeleton-design.md): delivery queue, event store, deep links and the highlight), S4 ([spec](2026-11-19-s4-templates-workspace-design.md): `buildClaudeMd`, `MarkdownEditor`), S5 ([spec](2026-11-19-s5-supervisor-docker-design.md): wake reasons, `ERRORED_WAKES`, boot reconciliation, rate-limit pauses), S6 ([spec](2026-11-19-s6-messaging-reporting-design.md): agent listener, tokens, factory MCP, router, one namespace, truthful senders, envelopes, `inbox_items`, `GET /api/messages/:id`) and S7 ([spec](2026-11-19-s7-spawning-design.md): terminated agents, the live predicate, lock order, per-caller tool lists).
- **Decision log:** the S8 decision issue (linked from the PR).
- **Stacked on:** `spec/s7-spawning` (PR #58) → `spec/s6-messaging-reporting` (PR #53) → `spec/s5-supervisor-docker` (PR #46) → `spec/s4-templates-workspace` (PR #37) → `spec/s3-walking-skeleton` (PR #27).

> `docs/product/` is gitignored, so the product docs exist only in local checkouts. Paths above are relative to the repo root.

## 1. Goal

Lightweight tracked work, and one place that shows each human what needs them. A task is a pointer plus a status: assigning it, commenting on it and finishing it become messages in the right agents' sessions, and an agent that needs a human mentions them in a comment, which lands in that human's inbox with a link to the exact comment.

## 2. Acceptance criteria

From the roadmap, made testable. Every AC is proven in default CI with the fake driver, every agent action going through the real MCP over HTTP with its real token; ACs 1–3 again by the live check (§17.5).

1. **Assignment reaches the session.** A human creates a task assigned to a hibernated agent through the UI. The agent wakes; its first batch carries a `<factory-message from="@factory" kind="task_assigned" … task="T-1">` envelope whose body holds the title, the body quoted as written by its author, the dependencies and the links. The agent's timeline shows it as a message block with a "T-1 · <title>" badge linking to the task.
2. **Mention, reply, continue.** The agent calls `comment_task` mentioning `@or`. Or's inbox shows one unread mention item; clicking it marks it read and opens `/tasks/T-1?comment=<id>`, scrolled to and highlighted. Or replies with a comment (the composer is prefilled with `@<agent> `) and the agent receives it as a `task_comment` from `@or` and continues; replying in the agent's session instead works too (S6's composer).
3. **Done unblocks.** T-2 depends on T-1. Marking T-1 done sends T-2's assignee one `task_update` (notice `unblocked`) and T-1's creator one (`done`: an agent creator in its session, a human creator as an inbox item). Nobody is notified of their own action.
4. **Permissions.** An agent that is not a task's creator, its assignee or a manager above either can read and comment on it but not change it (a tool error naming who can). A valid agent token presented to any `/api/tasks*` or `/api/inbox*` route gets `401`.
5. **Read state.** Items are unread until clicked; "Mark all read" marks every unread item of that user and its Undo restores exactly those; another user's read state is untouched; a second tab of the same user updates live; the sidebar shows the unread count.
6. **Ended agents.** No task message is ever written to an archived or terminated agent; assigning to one is refused with S6/S7's sentence; a termination racing an assignment ends in one of the two outcomes of §13.3 (proven by a race test).
7. **Mentions in code don't count.** `@or` inside inline code or a fenced block creates no inbox item; `not_reached` reports unknown, ambiguous and ended names.
8. CI is green; the live check (§17.5) has been run on the first tool slice and at the end, and its output, plus a manual pass through ACs 1–5 in the browser, is recorded in the PR.

## 3. Scope

**In:**
- tables `tasks`, `task_dependencies`, `task_links`, `task_comments`, `task_events`; keys `T-<n>` from a sequence; `blocked` computed;
- the `TaskService`: create, update, comment, the permission rule, validation, dependency cycles, history, and the notifications each change produces;
- three message kinds, `task_assigned`, `task_comment`, `task_update`, with the envelope's `task` attribute, delivered as direct messages;
- mention parsing in comments (`@handle`, `@humans`, agent slugs) with the markdown parser the UI renders with;
- the MCP tools `create_task`, `update_task`, `list_tasks`, `get_task`, `comment_task` for every agent;
- the generated CLAUDE.md's Tasks section;
- the inbox: kinds `mention` and `task_event`, read state, mark all read with undo, per-user live sync, unread count, deep links to comments and tasks, optional browser notifications;
- UI (UI doc): Tasks list, create page, detail page; Inbox read state; Home's Inbox panel; task badges in the session; the agent strip's tasks link.

**Out (non-goals, decided):** a project field or filter on tasks (§19); an Unread/All filter and mark-as-unread; editing or deleting comments; deleting tasks; CLI commands (#48, #49 untouched); a task count or rate cap; writing `turns.task_id` (S10 derives it, §6.7); text search; an "assigned to an ended agent" filter; human assignees.

## 4. Architecture

```
agent ──MCP──► Agent listener ──► FactoryMcp (5 task tools, every agent)
                                     │
humans (REST, session auth) ─────────┼──► TaskService ── one transaction: lock order §13 ─┐
                                     │      │ validate, permission (canChange), apply,   │
                                     │      │ task_events, comments, cycle check,         │
                                     │      │ Notifier.plan(change) → message rows        │
                                     │      │ (+ inbox_items via the store)               │
                                     │      ▼ after commit                                │
                                     │    Router.handOffTaskRows ─► recipient runtimes (enqueued, after bootDone)
                                     │    bus: inbox_changed (users), tasks_changed (all)
Inbox REST (read, read-all, undo) ──► EventStore (inbox) ──► bus: inbox_changed to that user
```

| Unit | Location | Owns |
|---|---|---|
| `TaskStore` | `apps/server/src/tasks/task-store.ts` | SQL for the five tables, every call taking `tx`; the lock order header (§13). |
| `TaskService` | `apps/server/src/tasks/task-service.ts` | Create, update, comment; validation; `canChange`; cycle check; history rows; calls `Notifier` (§6–§8). |
| `canChange` | `apps/server/src/tasks/permission.ts` | The one rule of who may change a task (§6.3). |
| `Notifier` | `apps/server/src/tasks/notifier.ts` | Pure: from a change, its actor and the task's people, the message rows to write (recipients, kind, notice, body) (§7). |
| `taskBodies` | `apps/server/src/tasks/bodies.ts` | Pure, deterministic text of `task_assigned` and `task_update` bodies (§7.3). |
| `extractMentions` | `packages/shared/src/mentions.ts` | Pure: the `@names` of a markdown text outside code, via the mdast AST (§8). |
| `parseTaskKey` | `packages/shared/src/tasks.ts` | `T-42`/`t-42`/`42` → 42; schemas shared by REST and MCP. |
| task tools | `apps/server/src/mcp/tools/{create,update,list,get,comment}-task.ts` | Schemas, caller identity, results (§9). |
| routes | `apps/server/src/routes/tasks.ts`, `routes/inbox.ts` | Human REST (§11, §12). |

S3–S7 rules stay: nothing outside `apps/server/src/mcp/` imports the MCP SDK; nothing outside `packages/harness/src/claude/` knows a stream-json field; cross-agent effects never await another agent's job from inside a job (task rows are committed, then handed over and never awaited); every hand-off waits for `bootDone`.

## 5. Data model (`packages/db`), one migration

```
CREATE SEQUENCE task_number_seq;
tasks              id text pk, number integer not null unique default nextval('task_number_seq'),
                   title text not null, body text not null default '',
                   status text not null default 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
                   assignee_agent_id text null → agents(id),
                   created_by_agent_id text null → agents(id), created_by_user_id text null → users(id),
                   CHECK (num_nonnulls(created_by_agent_id, created_by_user_id) = 1),
                   created_at, updated_at (server clock; bumped by every change and comment)
                   index (status, updated_at desc, id), (assignee_agent_id, status), (created_by_agent_id), (created_by_user_id)
task_dependencies  task_id → tasks(id), depends_on_task_id → tasks(id), pk (task_id, depends_on_task_id),
                   CHECK (task_id <> depends_on_task_id), index (depends_on_task_id)
task_links         id, task_id → tasks(id), position integer not null,
                   kind text CHECK (kind IN ('url','pr','file','agent')), target text null, agent_id text null → agents(id),
                   title text null, CHECK ((kind = 'agent') = (agent_id IS NOT NULL AND target IS NULL)),
                   CHECK (kind = 'agent' OR target IS NOT NULL), index (task_id, position)
task_comments      id, task_id → tasks(id), author_agent_id null → agents(id), author_user_id null → users(id),
                   CHECK (num_nonnulls(author_agent_id, author_user_id) = 1), body text not null, created_at,
                   index (task_id, created_at, id)
task_events        id, task_id → tasks(id), actor_agent_id null → agents(id), actor_user_id null → users(id),
                   CHECK (num_nonnulls(actor_agent_id, actor_user_id) = 1),
                   type text CHECK (type IN ('created','status','assignee','title','body','depends_on','links')),
                   from_value jsonb null, to_value jsonb null, at, index (task_id, at, id)
messages           + task_id text null → tasks(id), + comment_id text null → task_comments(id)
                   kind ∈ … | task_assigned | task_comment | task_update; sender CHECK gains:
                     OR (kind = 'task_assigned' AND from_user_id IS NULL AND from_agent_id IS NULL AND notice IS NULL
                         AND subject_agent_id IS NULL AND task_id IS NOT NULL AND comment_id IS NULL AND to_agent_id IS NOT NULL)
                     OR (kind = 'task_comment'  AND num_nonnulls(from_user_id, from_agent_id) = 1 AND notice IS NULL
                         AND subject_agent_id IS NULL AND task_id IS NOT NULL AND comment_id IS NOT NULL)
                     OR (kind = 'task_update'   AND from_user_id IS NULL AND from_agent_id IS NULL AND notice IS NOT NULL
                         AND subject_agent_id IS NULL AND task_id IS NOT NULL AND comment_id IS NULL)
                   and every pre-S8 kind gains `task_id IS NULL AND comment_id IS NULL`.
                   + index (task_id) where task_id is not null (S10's per-task join)
inbox_items        kind CHECK (kind IN ('message','mention','task_event'))
```

- **Keys.** `key = 'T-' || number`; a sequence, so a rolled-back create leaves a gap (accepted). `parseTaskKey` accepts `T-42`, `t-42` and `42` and nothing else ("No task T-42." for an unknown one).
- **Agents and users are never deleted**, so the new references are plain foreign keys. Tasks are never deleted (cancel instead), so the task references are plain too.
- **Who wrote it.** `created_by_*`, `author_*` and `actor_*` are one-of-two columns, like S6's sender columns; the factory never authors task content in S8 (every change has a human or agent actor).
- **Agent links** store the agent id (`agent_id`), so a link shows the agent's current slug and its ended state. `position` keeps the order given.
- `notice` on `task_update` rows is the fact code of §7.2. `messages.task_id` on every task row plus S3's `delivered_turn_id` is the turn-to-task link (§6.7).

## 6. Tasks

### 6.1 Fields and validation (one Zod schema per input, in `packages/shared`, used by REST and MCP)

| Field | Rule |
|---|---|
| `title` | trimmed, 1–200 characters, one line (no line breaks) |
| `body` | markdown, up to 64 KB UTF-8 (S6's body rule; may be empty) |
| `status` | `open` \| `in_progress` \| `done` \| `cancelled` |
| `assignee` | resolved through S6's one namespace (`@` optional): must be a **live** agent. A user: "Tasks can only be assigned to agents; @or is a human." Archived/terminated: S6/S7's sentences ("@x was terminated and can't be assigned tasks."). Unknown/ambiguous/reserved: S6's sentences. `null` (update only) unassigns. |
| `depends_on` | up to 50 existing task keys, not the task itself, no duplicates (deduped silently), no cycle (§6.4) |
| `links` | up to 50 `{kind, target, title?}`: `url` and `pr` must parse as `http:`/`https:` URLs (anything else: "Links must be http(s) URLs."); `agent` must name an existing agent (live or ended), stored by id; `file` is free text, 1–500 characters, one line. `title` optional, 1–200 characters, one line. |

`update_task`/`PATCH` replace `depends_on` and `links` as whole lists (decision Q9); a field left out is unchanged; a field equal to its current value is not a change (no history row, no message).

### 6.2 Status and blocked (decision Q6)

- Any status may move to any other, each move recorded in history (reopening is allowed).
- **Blocked is computed and advisory:** a task is blocked while it is `open` or `in_progress` and at least one dependency is neither `done` nor `cancelled` (a cancelled dependency will never be done, so it stops blocking). `blocked_by` lists those dependencies' keys. Nothing refuses a status change on a blocked task; the UI and the tools show "blocked by T-41".
- Reopening a done task re-blocks its dependents silently.

### 6.3 Who may change a task (decision Q3)

`canChange(actor, task)`, in `permission.ts`, called by `TaskService` for every change (REST and MCP both go through it; nothing else decides):
- a **human**: always (all users are equal admins);
- an **agent**: when it is the task's creator, its current assignee, or a manager above either in the reporting line (the transitive `reports_to` chain, read in the transaction with a recursive query; a spawner is its children's manager since `reports_to` is the spawner, S7).

Anyone may **read** and **comment** on any task, and any agent may **create** a task and assign it to any live agent (the reach of `send_message`). Self-assignment is allowed and sends no message. A refused change is a tool error / `403 task_forbidden`: "Only T-42's creator (@lead), its assignee (@dev) or their managers can change it; comment on it instead." (the creator shown as `@handle` for a human; "its assignee" left out when unassigned).

### 6.4 Dependencies and cycles

A change to `depends_on` (create or update) runs in the task transaction after `pg_advisory_xact_lock(<fixed key>)` (§13): with the lock held, a recursive query from each new dependency over `task_dependencies` checks whether it reaches the task. A hit refuses the whole change: "T-41 already depends on T-42 (through T-43); that would make a cycle." (the shortest path found, at most 5 keys shown). One global lock is enough: dependency edits are rare, and two concurrent edits that each pass the check could otherwise form a cycle together.

### 6.5 History (decision Q10)

`task_events` is append-only, one row per changed field per action, with the actor and from/to values (`status`: strings; `assignee`: agent ids, rendered as current slugs; `title`: strings; `body`: no values (the UI says "edited the description"); `depends_on` and `links`: the full lists). `created` is written at creation. Comments are their own rows. The detail view interleaves comments and history oldest first.

### 6.6 Comments

`comment(actor, key, body)`: body as §6.1's body rule, non-empty. Writes a `task_comments` row, bumps `updated_at`, then §7.1's comment recipients and §8's mentions. Comments are never edited or deleted (each was delivered as a message; the record and the delivered text must agree).

### 6.7 Turns and tasks (decision Q13)

S8 writes no `turns.task_id`. Every task message carries `task_id`, and S3's `messages.delivered_turn_id` records the turn that ran it, so S10 can derive turn-to-task with a join (the turn of a batch that held task messages of exactly one task belongs to that task) or choose a richer rule with usage data in hand. This is how S8 meets the roadmap line "link the task to its turns"; the PR says so, and `data-model.md`'s `turns.task_id` becomes S10's decision (§21).

## 7. Notifications (decisions Q1, Q2, Q7, Q8)

### 7.1 Who gets what

`Notifier.plan({actor, before, after, comment?, mentions?, unblocked})` returns the rows. Rules applied to every action:
- **Never to the actor** (nobody is told about their own action).
- **Never to an ended agent** (archived or terminated, the S7 live predicate, read in the transaction); a recipient skipped this way is reported in the tool result's `not_reached` where the tool has one.
- **At most one row per recipient per action** (an update that changes status, body and assignee sends the assignee one message listing all of it).

| Event | Recipient | Kind, notice |
|---|---|---|
| Created with an assignee, or assignee set or changed | the new assignee | `task_assigned` |
| Assignee changed away or unassigned | the old assignee | `task_update`, `unassigned` |
| Status, title or body changed by someone else | the current assignee | `task_update`, `status_changed` or `edited` (body or title; the body is quoted in full) |
| Status → `done` or `cancelled` | the creator: an agent → `task_update` (`done`/`cancelled`) in its session; a human → `task_update` message to that user with an inbox item of kind `task_event` | |
| A dependent goes from blocked to unblocked (a dependency done or cancelled, or removed from its `depends_on`), and the dependent is open or in progress | the dependent's assignee | `task_update`, `unblocked` (about the dependent) |
| A comment | the assignee (unless the author) and every live agent mentioned in it (§8), deduped, never the author | `task_comment` from the author |
| A comment mentioning humans | each mentioned user (or every user for `@humans`), never the author | `task_comment` from the author, to the user (or `to_all_humans`), inbox kind `mention` |

When one recipient qualifies for several rows in one action, it gets one: `task_assigned` wins over everything (the new assignee reads the current task), then the precedence `unassigned`, `done`, `cancelled`, `unblocked`, `status_changed`, `edited` decides the row's `notice`, and its body lists every change that concerns that recipient. Humans get nothing except their done/cancelled as creator and their mentions (humans can't be assignees).

**Unblocked detection** happens in the transaction, under the lock of each affected dependent (§13), so two dependencies finishing at the same time can't both see the other still open and lose the notification: the second transaction waits on the dependent's row and then reads the first one's committed status.

### 7.2 Codes

`task_update.notice` ∈ `done`, `cancelled`, `unblocked`, `unassigned`, `status_changed`, `edited`. Like S6's fact codes, the UI keys on the code, never on prose.

### 7.3 Bodies (pure, deterministic, `taskBodies`)

Truthful senders (S6): `task_assigned` and `task_update` are from `@factory`; any text an author wrote (title, body, link titles and file names) is attributed and, when multi-line, quoted. A `task_comment` is from its author and its body is exactly the comment.

```
<factory-message from="@factory" kind="task_assigned" urgent="false" id="m_1" task="T-42">
@or assigned you T-42, created by @lead: "Plan the billing migration"
Depends on: T-40 (done), T-41 (open). Blocked by T-41.
Links: pr https://github.com/acme/app/pull/12 · file docs/plan.md · agent @reviewer-ab12
The task, written by @lead:
> First line of the body
> …
</factory-message>
```

- Agents as `@slug`, humans as `@handle` (S6 R6). The title and link titles are inlined with S7's one-line sanitising (angle brackets stripped, double quotes replaced by single ones) inside double quotes; file names likewise in backticks.
- The body is quoted with every line prefixed `> ` (S6's `quoteReported` pattern) under the 64 KB message cap instead of S6's 2,000-character cap: a body over 60,000 characters is cut with "[truncated; call get_task for the rest]". An empty body says "The task has no description."
- Lines left out when empty (no dependencies, no links).
- `task_update` bodies, one line per change, then the quoted body for `edited`: "@dev marked T-42 done." · "@or cancelled T-42." · "T-42 is no longer blocked: T-41 is done." (or "…T-41 was cancelled." / "…T-41 was removed from its dependencies.") · "@lead reassigned T-42 to @dev; it's no longer yours." · "@lead unassigned T-42; it's no longer yours." · "@or moved T-42 to in progress." · "@or edited T-42's description:" + quote · "@or renamed T-42 to "…"." The task title follows the key in the first line when the line names the task ("T-42 "Plan the billing migration"").
- Every body passes through `groupEnvelopes`' escaping like every envelope body, so no text can close the envelope or forge one.

### 7.4 Delivery (decision Q8)

- Task rows are **direct messages**: S6's `queue`, not the held list. They wake a hibernated agent, go through the cap, FIFO and the image pull, wait out rate-limit pauses (S5 §7.2), are written mid-turn like any message, and are never urgent. Batch order: notices, then direct messages and task messages together in created order, then update groups, then peer events (`envelope.ts` `ORDER`: the three kinds join `message` at 1).
- **Recovery follows the truthful sender.** A `task_comment` written by a human is a human message: it is handed over as `deliver(row, "human")`, wakes with S5's `message` reason (in `ERRORED_WAKES`) and starts an errored agent's recovery attempt exactly like a message typed in the session. `task_assigned` and `task_update` (from `@factory`) and an agent's `task_comment` wake with a new reason **`task`**, not in `ERRORED_WAKES`: to an errored agent they stay pending and never start an attempt (S6's rule for agent messages). Results say so with S6's note: "@dev is errored; it will see this when a human restarts it."
- Rows are committed in the task transaction and handed over after the commit through `Router.handOffTaskRows(rows)` (after `bootDone`, unless shutdown has begun, never awaited, the REST routes included: the change succeeded, and a start failure shows on the agent, not on the task form). Human-addressed rows are written `delivered` with their inbox items by the store's `createHumanMessage` in the same transaction, then one `inbox_changed` frame (§11.4).
- Runtime changes (each with a test): `entryOf` renders `task_assigned`/`task_update` as `@factory` (no sender columns) and `task_comment` from its author; `BatchRow` and `FactoryMessage` carry `taskKey` (the envelope already renders `task="…"` from it); `pendingQueue` and `pendingRow` join `tasks.number`; `EventStore.bootWakes` counts the three kinds as deliverable (today `kind in ('message','system')`); the queue frame's item for a pending task row is `kind: "message"` with `taskKey`; `message_in.messages[]` gains `taskKey`, `taskTitle` (at delivery, for the badge), `commentId` and `fact` (the notice) for the UI, which never parses prose.
- **Ended recipients** are skipped at write time (§7.1); a row racing a termination is rejected by S7's machinery (the termination transaction rejects pending rows, and a committed latch rejects later hand-offs).

## 8. Mentions (decision Q12)

- **Only in comments.** Task titles and bodies never notify (a body is a brief, and re-notifying on every edit would be noise).
- **Parsing:** `extractMentions(markdown)` parses with `mdast-util-from-markdown` and the GFM extension (`micromark-extension-gfm`, `mdast-util-gfm`), the same micromark parser `react-markdown` + `remark-gfm` use in the UI, and walks the AST's **text nodes only**: `inlineCode` and `code` (fenced or indented) nodes are skipped, and so are link URLs and autolinks' targets (a link's visible text is a text node and counts). Inside a text node, a mention is `@` followed by a name in the slug/handle character set (`[a-z0-9][a-z0-9-]*`, trailing hyphens dropped since neither `HANDLE_PATTERN` nor `SLUG_PATTERN` allows one), where the `@` is at the start of the node or follows a character that is not a word character, `/`, `.` or `@` (so `x@or.io`, `path/@or` and `@@or` don't match), and the name doesn't continue with a word character. Case: names are lowercase; `@Or` is not a mention. Deduped, in order of first appearance.
- The three packages become direct dependencies of `packages/shared`, pinned to the exact versions already resolved in the lockfile for `react-markdown`/`remark-gfm` (a new direct runtime dependency for the server; `minimumReleaseAge` and every other supply-chain setting stay as they are; the PR says so).
- **Resolution** through S6's `resolveName` in the transaction: `humans` → every user existing now; a user → that user; a live agent → a `task_comment` to it (§7.1); the author, reserved names, unknown, ambiguous and ended names → not reached. A user mentioned alongside `@humans` gets one item (one `to_all_humans` row; individual rows only without `@humans`), and the author never gets an item for their own comment (`createHumanMessage` gains `exceptUserId`).
- `comment_task`'s result says who it reached (§9): `delivered_to` (agent slugs, the assignee included), `mentioned_humans` (`@handle`s, or `["@humans"]`), `not_reached: [{name, reason: "unknown" | "ambiguous" | "archived" | "terminated" | "reserved"}]`. The REST response carries the same.
- The UI shows comment text exactly as written; mentions are not restyled in S8.

## 9. The MCP tools (decisions Q22, Q24)

All five are registered for **every** agent (persistent and spawned) by S7's per-caller `tools(caller)`. Identity (creator, commenter, `me`) always comes from the token's agent, never from a parameter. Input schemas are the shared Zod schemas; results are one text block of compact JSON (agent-written text is JSON-escaped data, never an envelope); errors are one sentence saying what to do. Task ids accept `T-42`, `t-42`, `42`. Tool descriptions state parameter semantics only; the workflow rules live in CLAUDE.md (§10).

| Tool | Input | Result |
|---|---|---|
| `create_task` | `title`, `body?`, `assignee?`, `depends_on?: string[]`, `links?: Link[]` | `{key, status, assignee?, blocked_by, note?}` |
| `update_task` | `id`, `title?`, `body?`, `status?`, `assignee?: string \| null`, `depends_on?`, `links?` | `{key, status, assignee?, blocked_by, changed: string[], note?}` (`changed: []` for a no-op) |
| `list_tasks` | `status?: Status[]` (default `["open","in_progress"]`), `assignee?: slug \| "me" \| "none"`, `created_by?: slug \| "@handle" \| "me"`, `limit?` (default 50, max 200) | `{tasks: [{key, title, status, assignee?, assignee_ended?, blocked_by, created_by, updated_at}], more: boolean}`, newest updated first; when cut, `more: true` and a `note`: "Showing the 50 most recently updated; pass a larger limit (max 200) or narrow the filter." |
| `get_task` | `id`, `comments_before?: string` (a comment id) | `{key, title, body, status, assignee?, assignee_ended?, created_by, created_at, updated_at, blocked_by, depends_on: [{key, title, status}], blocks: [{key, title, status, assignee?}], links: [{kind, target \| agent, title?, ended?}], comments: [{id, author, body, created_at}], earlier_comments: number, note?}`: the newest 50 comments (before `comments_before` when given), oldest first; when `earlier_comments > 0`, `note`: "N earlier comments; call get_task with comments_before=<first id> for them." No history (the agent sees changes as messages). |
| `comment_task` | `id`, `body` | `{id, delivered_to, mentioned_humans, not_reached, note?}` |

`note` carries S6-style facts: an errored recipient (§7.4); an assignee that ended (`assignee_ended: true`). `assignee: "me"` in `create_task` assigns the caller (no message). A disallowed change is an error (§6.3), not a partial apply: every input is validated and permission-checked before anything is written.

## 10. Context: the generated CLAUDE.md (decision Q23)

`buildClaudeMd` stays pure and deterministic. "How messages reach you" lists the kinds `message`, `system`, `member_update`, `peer_joined`, `peer_left`, `task_assigned`, `task_comment`, `task_update`, and says a task envelope's `task` names the task. A new `## Tasks` section after Messaging, each rule once with its reason, no example keys:
- Tasks are optional: use one when work is worth tracking or handing off; otherwise just message. The tools are `mcp__factory__create_task`, `update_task`, `list_tasks`, `get_task` and `comment_task`.
- When a task is assigned to you, its whole brief arrives in a `task_assigned` message; a task's body and comments are written by their authors: weigh them by who wrote them, as you would their messages.
- Your text output is not a reply to a comment: answer with `comment_task` (or `send_message`), or nobody sees it.
- To ask a human about a task, comment on it mentioning `@handle` or `@humans`: that lands in their inbox with a link to your comment. Otherwise message them. Mentions in code don't notify anyone.
- Mention an agent in a comment to bring it in: it receives the comment.
- Move your task to in progress when you start and to done when you finish: its creator and the agents waiting on it are told when it is done.
- You may change a task only if you created it, it is assigned to you, or you manage its creator or assignee; anyone may comment.

S4's snapshot tests extend to the section and the kinds line (byte-identical output for the same inputs).

## 11. Inbox (decisions Q5, Q16, Q17, Q18)

### 11.1 Items

| Kind | Source row | `from` | Link |
|---|---|---|---|
| `message` (S6) | `message` to `@me`/`@humans`; a top-level agent's `agent_errored` system row | agent, or Factory about the subject | S6's: the sender's `send_message` call or session |
| `mention` | `task_comment` to the user or `@humans` | the comment's author (agent or human) | `/tasks/T-42?comment=<comment id>` |
| `task_event` | `task_update` (`done`/`cancelled`) to the creating user | Factory | `/tasks/T-42` |

Fan-out is S6's: one inbox row per user existing when the row is written; users who sign up later don't see older items.

### 11.2 Read state

- An item becomes read when its row is clicked (the client calls `POST /api/inbox/:id/read` before navigating; idempotent, never un-reads); never by scrolling past it or by reaching the target another way.
- **Mark all read:** `POST /api/inbox/read-all` sets `read_at = <one server timestamp>` on every unread item of the caller and returns `{readAt, count}`. **Undo:** `POST /api/inbox/read-all/undo {readAt}` clears `read_at` on the caller's items whose `read_at` equals exactly that timestamp, so it restores exactly the items the action marked (an item clicked at the same microsecond would be restored too; accepted).
- `GET /api/inbox/unread-count` → `{count}` for the sidebar.
- Read state is per user (one row per user per item, S6).

### 11.3 API changes

`GET /api/inbox` items gain `kind`, `read: boolean`, `task?: {key, title}` (the current title), and `from.kind` widens to `agent | human | factory`; `link` becomes a union: `{kind: "session", agentSlug, seq?}` (S6's) or `{kind: "task", key, commentId?}`. `GET /api/messages/:id` widens its `kind` enum. All inbox routes keep `requireUser` (an agent token gets `401`).

### 11.4 Frames

- `inbox_changed` is content-free as in S6. New rows for humans publish it to every socket (S6); a read change (read, read-all, undo) publishes it only to **that user's** sockets (`EventBus.publishToUser(userId, …)`; the WebSocket route already knows each socket's user), so another tab of the same user refetches and others don't.
- `tasks_changed {keys: string[]}` goes to every socket after any task commit (create, change, comment); the list and an open detail page refetch when their key is listed.

### 11.5 Browser notifications

Opt-in per browser (UI doc §7): when on and the tab is hidden, each new unread inbox item seen by a refetch shows one `Notification` with plain text only (sender and a 120-character preview, no markup, never a URL taken from agent text), `tag` = the item id so several open tabs collapse into one; clicking it focuses the tab, marks the item read and opens its deep link. Separable: it is the plan's last task, and the first to move to a follow-up if the PR runs large (decision Q17).

## 12. Human REST API

All under `requireUser` on the existing server (no new listener or port); bodies validated by the shared schemas; errors `{error: {code, message}}`.

| Route | Does |
|---|---|
| `GET /api/tasks?status=&assignee=&creator=&before=&limit=` | Page of tasks, newest updated first (`updated_at desc, id`), cursor like the inbox's; `status` repeatable or `all` (default open and in progress); `assignee` a slug or `none`; `creator` a slug or `@handle`. Each item: key, title, status, assignee (slug, display name, ended), `blockedBy`, creator, updatedAt. |
| `POST /api/tasks` | Create (`201 {task}`); the human is the creator. |
| `GET /api/tasks/:key` | Detail: fields, `dependsOn` and `blocks` (key, title, status, blocked), links, and the whole activity (comments and history, oldest first; S8 doesn't page it, accepted in §20). `404 task_not_found`. |
| `PATCH /api/tasks/:key` | Any subset of title, body, status, assignee (`null` unassigns), dependsOn, links. `409 assignee_ended`, `400` field errors (cycle on `dependsOn`). |
| `POST /api/tasks/:key/comments` | `201 {comment, deliveredTo, mentionedHumans, notReached}`. |
| `POST /api/inbox/:id/read`, `POST /api/inbox/read-all`, `POST /api/inbox/read-all/undo`, `GET /api/inbox/unread-count` | §11.2 |

The agents API gains `openTasks: number` on `AgentSummary` (open and in-progress tasks assigned to it) for the strip link.

## 13. Locking and concurrency (decision Q15)

### 13.1 The one order

Written once, in the header of `task-store.ts` and here; every transaction that touches tasks follows it:

1. **Agent rows**, `FOR SHARE`: the agents this action makes recipients of a new relation (the new assignee; the agents mentioned in a comment and the assignee for a comment), **persistent before spawned, then by id**, which matches S7's spawner-then-child order (S7 §5.7). `FOR SHARE` conflicts with a termination's or archive's `FOR NO KEY UPDATE`, so the two serialize; it doesn't conflict with message inserts' `KEY SHARE`.
2. The **advisory lock** `pg_advisory_xact_lock(<fixed key>)`, only when `depends_on` changes (§6.4).
3. **Task rows**, `FOR NO KEY UPDATE`: the acted-on task, then the dependents whose blocked state the action may change, sorted by id (§7.1). Dependencies form a DAG and dependency edits are serialized by step 2, so this order can't cycle.
4. **Message rows** (inserts; S7's general rule "agent rows before message rows").

Every store, router and resolver call inside takes `tx` (S7 §5.7: a call on its own connection would wait forever on our uncommitted rows). `canChange`'s manager walk and the live checks read in `tx`.

### 13.2 Interaction with S6/S7 paths

- S6 `send_message` and the forwarder lock nothing new; task transactions never lock an agent `FOR NO KEY UPDATE`, so no S6/S7 transaction waits on us except a termination or archive of an agent we hold `FOR SHARE`.
- S7's termination locks the spawner then the child `FOR NO KEY UPDATE`; we lock only the agents in step 1, in the same relative order, so no cycle.

### 13.3 Termination racing an assignment (AC 6)

- The termination commits first: our `FOR SHARE` waits, then reads `terminated_at` and refuses the assignment ("@x was terminated and can't be assigned tasks.").
- Our transaction commits first: the termination waits on our `FOR SHARE`, then rejects the pending `task_assigned` row in its own transaction (S7 §8 step 2), and the task keeps the (now ended) assignee (decision Q11).

Both are asserted by one race test with an interleaving barrier (no timeouts).

## 14. Lifecycle interactions

Listed explicitly because the S5–S7 reviews found most bugs here.

| Interaction | Rule |
|---|---|
| Assignee or creator archived or terminated | Nothing changes on the task (decision Q11); tools return `assignee_ended: true`, the UI marks it and offers reassign; no task message is written to an ended agent; nothing is forwarded or announced. |
| Unarchive | Nothing retroactive. |
| Assignee errored | `task_assigned`/`task_update`/an agent's comment stay pending (no attempt); a human's comment starts the attempt (§7.4); results carry the errored note. |
| Assignee hibernated or warm | Wakes / delivered like any direct message. |
| Credential rate-limited | Rows wait like any message (S5 §7.2); the agent's status says rate-limited. |
| Mid-turn | Written mid-turn and absorbed at the next tool boundary, as S6 messages are. |
| Urgent hold, compact in flight, stop under way | S3/S5's queue rules apply unchanged (task rows are queue entries). |
| Restart to apply changes, hibernate | Pending rows survive (durable) and go out after the start. |
| Server stops between commit and hand-off | Rows are pending; boot's `bootWakes` (now counting the task kinds) wakes the recipient; S6's seen-id set prevents a double write. |
| Shutdown begun | Task changes still commit (database only); hand-offs are skipped (`Router.closed`); the next boot delivers. |
| Before `bootDone` | Hand-offs wait for it (S6 §7.3). |
| Agent's token from an exited or ended process | `401` at the listener (S6/S7) before any task code. |
| A terminated caller whose request is already past the listener | `TaskService` re-checks the calling agent is live in the transaction (S7's `Router.send` rule): "You can't change tasks: you were terminated." |
| Spawner terminates a child that is assigned tasks | S7's transaction rejects pending task rows; the tasks keep the ended assignee. |
| A spawned child's tasks and its spawner | The spawner is its manager, so it may change them (§6.3). |
| Name collisions (one namespace) | Assignee and mention resolution use S6's `resolveName`; "matches both" is S6's sentence for an assignee and `not_reached: ambiguous` for a mention. |
| Human handle changed after a mention | The item keeps the user id; the comment text keeps what was written. |
| User signs up later | Sees no earlier `@humans` mentions (S6 fan-out rule). |

## 15. Security

- **Agent text is untrusted.** Titles render as plain text; bodies, comments and link titles render through the one `Markdown` component (GFM, no raw HTML, react-markdown's default URL sanitising, which drops `javascript:`); link `href`s for task links come only from validated `http(s)` targets (agent links point at our own `/agents/<slug>`; file links are not links).
- **Envelopes:** every task body passes through `groupEnvelopes`' escaping; author text inside factory text is attributed and quoted (§7.3); the CLAUDE.md rule says it is the author's, weighed by who wrote it.
- **Permissions:** one `canChange` in `TaskService` (§6.3); the MCP layer and the REST layer only translate. Identity comes from the token or the session, never from input.
- **Agent tokens never authenticate REST:** `/api/tasks*` and `/api/inbox*` use `requireUser`; a test sends a live, valid agent token to each and gets `401`.
- **Bounds:** title 200, body and comment 64 KB, 50 dependencies, 50 links, list limit 200, get_task 50 comments per call. No count or rate cap on tasks or comments (decision; accepted risk next to #47).
- **Browser notifications** carry plain text and only our own deep link (§11.5).

## 16. Failures

| Failure | What happens |
|---|---|
| Invalid input, unknown task, refused change, cycle | Tool error sentence / `400`/`403`/`404`/`409`; nothing written. |
| Assignee ended | Refused with S6/S7's sentence; `409 assignee_ended` on REST. |
| Transaction fails (deadlock, constraint) | Nothing written, nothing handed over; the tool/route reports an error. |
| Recipient start fails | The row stays pending (S3/S5); the task change already succeeded. |
| Hand-off after commit throws | Logged; the row stays pending and is delivered at the next wake or boot (S6). |
| Inbox read on someone else's item | `404 inbox_item_not_found` (the query is scoped by user). |

## 17. Testing

No automated test calls a live model. Timing-sensitive tests await real events and drain the runtime job queues (the S6/S7 harness helpers); none raise a timeout.

### 17.1 Unit
`parseTaskKey`; the input schemas (every rule of §6.1); `canChange` (creator, assignee, managers above either, transitive, spawner, unrelated agent, human); blocked computation (open/in_progress only, cancelled dependencies); cycle detection (direct, transitive, the path in the sentence); `Notifier.plan` as a table (every row of §7.1, the actor excluded, ended recipients excluded, one row per recipient, precedence, unblocked only when fully unblocked); `taskBodies` (every body, sanitising, quoting, truncation, determinism, a forged `</factory-message>` stays inside); `extractMentions` (start, punctuation, email, path, `@@`, uppercase, inline code, fenced and indented code, link URL vs link text, dedupe, `@humans`); `buildClaudeMd` (Tasks section, kinds line, determinism).

### 17.2 Server (fake driver, fake timers, real Postgres)
- **Tools over HTTP** (real `fetch`, port-0 agent listener, real tokens): every agent lists the five tools (+2 for spawners); each tool acts as the token's agent; an unrelated agent's `update_task` is refused and `comment_task` allowed; results as §9, including `more`, `earlier_comments` with `comments_before`, `not_reached`.
- **Notifications end to end:** AC 1 (assignment wakes a hibernated agent with `task`; the envelope bytes); AC 3 (done → dependent's assignee `unblocked`, creator `done`; a human creator gets an inbox `task_event`); reassignment (`unassigned` to the old, `task_assigned` to the new); an update changing three fields sends one row; nothing to the actor; a human comment to an errored agent starts an attempt, a factory row and an agent comment don't; urgent never set; batch order with notices, messages, task rows, updates and peer events in one batch.
- **Mentions:** AC 2 with the fake driver (mention → inbox item; human comment with the prefilled mention → `task_comment` to the agent); `@humans` fan-out to existing users only and never the author; code excluded; ended and unknown names in `not_reached`.
- **Ended and lifecycle:** assigning to an archived and to a terminated agent refused; no rows to ended creators, assignees or mentioned agents; **the termination-versus-assignment race** in both orders (§13.3) with a barrier; two dependencies of one task finishing concurrently notify its assignee exactly once; concurrent dependency edits that would form a cycle: one refused; shutdown between commit and hand-off → boot delivers once; boot wakes an agent whose only pending row is a task row; a terminated caller's in-flight request refused.
- **Inbox:** read on click scoped per user; read-all and its exact undo; unread count; `inbox_changed` to the user's own sockets for read changes and to all for new items; links per kind; paging unchanged.
- **REST auth:** a live agent token on every `/api/tasks*` and `/api/inbox*` route gets `401`.
- S3–S7 tests keep passing (the `messages` CHECK rewrite, `bootWakes`, `entryOf`).

### 17.3 Harness
`renderEnvelopes` with `task` on each of the three kinds; `groupEnvelopes` ordering with task rows.

### 17.4 Web
The UI doc's states (list filters as URL params, create validation, detail edits, deep-link highlight, prefill, read state, undo, live updates, notifications toggle and permission denied).

### 17.5 Live check (`pnpm smoke:tasks`, not part of `pnpm test`)
Real `claude` on haiku, the token file read into the environment at run time (never printed), a throwaway database and `FACTORY_HOME`, Docker agents on `open-factory-base:dev`, two seeded users. It drives **only real routes and the real MCP endpoint** (no test hooks, no auth or permission bypass). Steps, each asserted and printed: `system/init` lists the five task tools (+2 for a spawner); a human creates T-1 assigned to hibernated `dev` through `POST /api/tasks`; `dev` wakes with the `task_assigned` envelope (`task="T-1"`), calls `get_task`, and `comment_task` mentioning `@or`; Or's inbox has the mention; Or comments back through REST with `@dev` and `dev` receives it and calls `update_task` to done; Or's inbox gets the `task_event`; T-2 (depending on T-1, assigned to `qa`) makes `qa` receive `unblocked`. **The plan runs its first slice (tool listing, create with assignment, `get_task`, `comment_task` with a mention) as an early task, right after the first tools exist**, and the whole script at the end; the PR records both outputs.

## 18. To verify first

| # | Claim | How | If wrong |
|---|---|---|---|
| V1 | Claude lists and calls five more factory tools from the per-caller server and handles their array/object inputs (`depends_on`, `links`) and nullable `assignee`. | The early slice of the live check | Flatten the inputs (comma-separated keys; links as strings) |
| V2 | A haiku agent reading a `task_assigned` envelope acts on the quoted brief and replies with `comment_task`, not plain text. | The early slice | Sharpen the CLAUDE.md Tasks section; never script phrasings |
| V3 | The extended `messages` CHECK (task kinds, `task_id`/`comment_id` null for old kinds) accepts every existing row shape and rejects the wrong ones. | A migration test on Postgres 18 with rows of every S3–S7 kind | Fix the CHECK before anything else |
| V4 | `mdast-util-from-markdown` + GFM classify inline code, fences and autolinks the way the UI renders them. | Unit tests comparing with `react-markdown`'s output on the same fixtures | Keep the server and web on one shared parse function |

## 19. Accepted risks and non-goals

- **Ping-pong through comments:** two agents can comment on each other's tasks indefinitely, like messages (#47 stays open, with a note). No task or comment cap in v0.1 (ADR 0019; usage is visible per agent; per-call bounds exist).
- **`@humans` spam:** an agent can mention `@humans` in every comment, as it can `send_message` them (same fan-out, #47 note).
- **Activity unpaged** on the task detail page (tasks are expected to hold tens of comments); revisit only if measured slow (like #22).
- **Mark-all-read undo** restores an item clicked in the same microsecond too.
- **Lost lists under concurrent edits:** replacing `depends_on`/`links` is last write wins; history shows both writes.
- **Non-goals:** see §3 Out.

## 20. Product doc wording (for the lead; not edited here)

- `concepts/message.md` → Kinds: `task_assigned` is from `@factory` with `task=`, its body the task with its body quoted as written by its author; `task_comment` is from its author (to the assignee, mentioned agents, or humans via the inbox); new `task_update` from `@factory` with codes `done`, `cancelled`, `unblocked`, `unassigned`, `status_changed`, `edited`; nobody is notified of their own action; a human's comment starts an errored agent's recovery, factory task facts and agents' comments don't; task messages are direct messages, never held.
- `concepts/task.md`: blocked is advisory and cancelled dependencies don't block; any status can move to any other; who may change a task (creator, assignee, managers above either; anyone comments); comments go to the assignee and mentioned agents; reassignment and edits by others notify the assignee (edits carry the new body); tasks are never deleted and comments never edited; nothing changes when an assignee ends.
- `behavior/tasks.md`: drop the project filter; filters are status, assignee, creator; history includes title, body, dependency and link changes; the composer's mention prefill and Reply.
- `behavior/inbox.md`: item kinds; read on click; mark all read with undo; unread count; browser notifications opt-in per browser, only while the tab is hidden.
- `architecture/factory-mcp.md`: `update_task(id, title?, body?, status?, assignee?, depends_on?, links?)` replaces lists; `get_task(id, comments_before?)`; `list_tasks` filters and `more`; `comment_task` returns who it reached; all five tools for every agent.
- `architecture/data-model.md`: `tasks.number` (sequence) instead of a `key` column; `task_events`; `task_links.agent_id`; `messages.task_id`, `comment_id`; `inbox_items.kind` values; `turns.task_id` not written in S8 (S10 decides).
- `architecture/context-assembly.md` → Protocol: the Tasks section.
- `roadmap/v0.1/s08-tasks-inbox.md`: "link the task to its turns" is met by `messages.task_id` + `delivered_turn_id`.

## 21. Issues consumed and follow-ups

Consumed: none fully. Touched: **#47** (comments are a second agent-to-agent path; `@humans` mentions; no task caps): a note, stays open. Untouched: #48, #49 (no CLI in S8), #22, #23 and the rest.

Follow-ups (new issues, linked from the PR): an "assigned to an ended agent" filter; text search over tasks; per-task usage storage if S10 wants a column; browser notifications, if moved out of the PR.

## 22. Decisions needing Or's call (owner-proxy certainty 3/5)

- **Q4** comment recipients are the assignee plus mentioned agents; a reply reaches a non-assignee agent only through the composer's visible `@agent` prefill (fallback: a reply also goes to the replied comment's agent author).
- **Q7 detail** an "edited" `task_update` carries the full new body.
- **Q8** a human's task comment starts an errored agent's recovery (keyed on the truthful sender); factory task facts and agents' comments don't (fallback: no task message ever starts recovery).
- **Q13** no `turns.task_id` write in S8; S10 derives it.
- **Q17** browser notifications in S8, as the last, separable task.
- **Q18** Home's Inbox panel shows the 5 newest unread items.
