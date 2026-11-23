# I1 Chat and Session: Technical Design

Task: [I1 Chat and Session](../../product/roadmap/v0.0.2/i1-chat-and-session.md) (gitignored `docs/product/`, read from the main checkout). Decisions: ADR 0021 (handles and recipients), ADR 0022 (Chat and raw Session), ADR 0026 (`send_command`), ADR 0028 (pre-release, no compatibility). Builds on U3 (`2026-11-21-u3-chat-design.md`: shared composer, `/` commands, raw-command path, streaming) and follows I4 (`2026-11-23-i4-field-errors-design.md`) for any form it touches (I1 adds none; the sign-up and New agent forms keep their existing `slug_taken`/`HANDLE_TAKEN` field errors). Stacks on I6 (`spec/i6-path-help`).

Every question was answered by the owner proxy (`owner-i1`), and the spec was reviewed through six lenses (self, Taste, Apple, Emil, Motion, Break UI); the log of questions, alternatives, answers and certainty is in the decisions issue. §13 lists what is rated 3/5 or lower.

## 1. Goal

Talking to an agent feels like a DM; looking under the hood is a deliberate step.

- Every principal is `@handle`, agents included; `#` is reserved; `@humans` is gone; `send_message` takes a list; one handle namespace enforced by the database; agents can list the humans.
- Each agent has two views: **Chat** (default, per human: your messages and its `send_message` replies to you) and **Session** (diagnosis: the live timeline, with a composer that writes raw input to Claude's stdin minus a denylist).
- The Inbox shows one row per chat with unread messages.
- Agents get `send_command` for themselves and their direct reports.
- `/context` (and any built-in) works on an agent that has never started.

ADR 0028: nothing here keeps old shapes alive. Migrations are schema-only and fail on a non-empty database: **reset local data** (drop the database, recreate agents) before the first boot of PR 1. Old `message_in` events with bare agent senders are not parsed specially.

## 2. Acceptance criteria

Numbered for the plan and the evidence pass; "PR n" says where each lands.

1. (PR 3) Clicking an agent in the sidebar, the palette or the Agents page opens `/agents/<slug>/chat`; a bare `/agents/<slug>` redirects there; the tab title reads "Ada · Chat" (Session: "Ada · Session").
2. (PR 1, PR 3) A message you send from the Chat arrives in the agent's session as `<factory-message from="@you" from_kind="human" kind="message" to="@agent" …>`.
3. (PR 3) The agent's `send_message` reply to you shows in your Chat and as one "Ada · 1 new" Inbox row; opening the Chat page marks it read at once, the reading pane after the dwell; the read row leaves the Inbox only once the pointer and focus have left the list.
4. (PR 1, PR 3) An agent sends one message to `["@orlevi", "@dev"]`: each envelope carries `to="@orlevi @dev"`; it appears in Or's Chat with that agent marked "also to @dev"; when `@dev` is terminated, only `@dev` is refused and the rest are sent.
5. (PR 1) `send_message` to `@humans` is refused with guidance; a task comment mentioning `@humans` is posted and its result says `@humans` reached nobody; agent-facing prose never says `@humans`.
6. (PR 1) Creating an agent whose slug equals a user's handle fails at the database (`slug_taken`), including while that user's sign-up is in flight; signing up with an agent's slug fails with `HANDLE_TAKEN`; a sign-up that failed for another reason (email in use) does not lock its handle for the next sign-up.
7. (PR 1) `list_peers` returns one `peers` list with humans as `{handle, kind: "human", name}`; disabled users are absent.
8. (PR 1) The Session's outgoing `send_message` card renders a 10-recipient call ("Ada → @a, @b +8") with one status line per refused or pending recipient.
9. (PR 2) In the Session, `hello` reaches Claude unwrapped and the agent's plain-text answer shows in the timeline under "You · raw"; the agent's context says un-enveloped input is from an operator.
10. (PR 2) `/context` typed (or pasted) in the Session of an agent that has never started runs (its output renders as `command_output`), including when Enter is pressed before the command list has loaded; the `/` menu lists built-ins before the first start.
11. (PR 2) `/clear`, `/model`, `/new`, `/QUIT` are refused on the composer's note slot before sending (the composer's height does not change), and by the server; nothing is written to stdin. `/news-digest` (a skill) shows no refusal while typed.
12. (PR 2) Raw input typed while a turn is open is queued ("Runs after the current turn.") as one block that keeps its node from Sending to the timeline row, shows Cancel, and is written only after the turn's `result`.
13. (PR 2) A menu opened right after a process start lists that process's commands.
14. (PR 3) A turn that consumed your Chat message and ends with no `send_message` to you shows "Ada finished without replying · Open session", kept in history; interrupted or stopped on purpose (Restart, archive): "Ada was stopped before replying"; errored, or the process died (including before the turn opened, or the factory restarted): "Ada hit an error before replying".
15. (PR 3) While a turn that consumed your message runs, the Chat's last row is "[tooth] 42s · Ada is working · Open session" with a ticking duration; when the turn ends it becomes the outcome line in the same box (or disappears if Ada replied) with no flash.
16. (PR 3) A leading `/context` in the Chat composer shows "Commands run in the session · Open session" on the note slot and, if sent, is sent as message text; "Open session" carries the text into the Session's draft.
17. (PR 3) The Chat composer's `@` adds agent recipients; the "To:" row appears only with a second recipient, the paperclip then refuses with "Files go to one agent at a time" on the note slot; recipients survive a reload with the draft.
18. (PR 3) `/chat?message=<id>` lands on a message older than the newest page.
19. (PR 3) Mark all read with only chats unread marks them all; its Undo restores them; a reload with `?item=chat:<slug>` shows that Chat in the pane.
20. (PR 3) A desktop notification fires for an agent's message to you and opens its Chat.
21. (PR 4) An agent calls `send_command({target: "me", command: "/compact"})` mid-turn: the compact runs after its turn, then `@factory` delivers "Your /compact finished. Continue where you left off." and the agent continues on its own.
22. (PR 4) `send_command` to an agent that is not the caller or one of its direct reports is refused; a spawned agent's tool accepts only itself.
23. (all) Chat, Session header and Inbox hold at 320, 390, 1024 (the 404px pane) and 1440px and at 200% text with no horizontal page scroll; long names and handles truncate as specified (§6.11).

## 3. Delivery: four stacked PRs

| PR | Branch | Content | Demo |
|---|---|---|---|
| 1 | `i1/1-handles-recipients` | §4: `handles`, `@` senders, list `to`, `from_kind`, `recipients`, no `@humans`, `list_peers` humans, CLAUDE.md, the Session's multi-recipient outgoing card | The fake agent messages two recipients; envelopes list both |
| 2 | `i1/2-raw-session` | §5: raw input route and denylist, `operator_input`, Session composer raw mode and its note slot, operator rule, the `/context` fixes | `hello` and `/context` in the Session of a fresh agent |
| 3 | `i1/3-chat-inbox` | §6: routes, Chat view and composer, chat thread API, working/outcome lines, `chat_changed`, Inbox chat rows, multi-recipient human send | Click an agent, chat, see the reply in the Inbox |
| 4 | `i1/4-send-command` | §7: `send_command`, self-compact continue notice | An agent compacts itself and continues |

PR 1 starts from the spec branch (`spec/i1-chat-and-session`, on `spec/i6-path-help`); each later PR from the previous one. Interim states: through PR 1 the Session composer still sends enveloped messages through the old route; after PR 2 it is raw, and until PR 3 a human messages an agent only through the Inbox reading pane's reply (old route). Accepted, because the stack merges together. The fake Claude's `$mcp` directive (§11) lands in PR 1 so its demo runs.

## 4. PR 1: handles and recipients

### 4.1 `handles`, claim-first (Q2, Q2b, R1)

```
handles(
  handle     text primary key,   -- lowercase: handleSchema and slugSchema already force it, so no lower() index
  kind       text not null check (kind in ('agent','user')),
  claimed_at timestamptz not null default now()
)
agents.slug  → FK handles(handle)   (its unique index stays)
users.handle → FK handles(handle)   (its unique index stays)
```

- Reserved names have one owner, `RESERVED_HANDLES` (`packages/shared/src/handle.ts`; it already includes `humans`): the validators (`handleSchema`, `slugSchema`) refuse them before any claim, so `claimHandle` never sees one, and `resolveName` checks the list before its lookup. No reserved rows in `handles`.
- **What the database guarantees, said exactly:** the FKs check that a claim row exists, not its kind; the unique indexes on `agents.slug` and `users.handle` and the same-kind reclaim make two principals with one handle impossible as long as every writer claims through `claimHandle`. The writers are the auth hook, agent create, spawn and the fixture helper (`user-admin.ts` only sets `disabled_at`); a test lists them by grepping for inserts into `agents` and `users`.
- **One claim function**, `claimHandle(tx, handle, kind)` in `apps/server/src/messaging/principals.ts`, used by every claimer (sign-up, handle change, agent create, spawn):
  ```sql
  INSERT INTO handles (handle, kind) VALUES ($1, $2)
  ON CONFLICT (handle) DO UPDATE SET claimed_at = now()
    WHERE handles.kind = excluded.kind
      AND NOT EXISTS (SELECT 1 FROM users  WHERE users.handle = handles.handle)
      AND NOT EXISTS (SELECT 1 FROM agents WHERE agents.slug  = handles.handle)
  RETURNING handle
  ```
  No row back means taken. A reclaim is allowed **only within the same kind** and only when nothing references the claim. Under READ COMMITTED an agent claimer that waited on another agent's commit can still get a row back and then fail at the `agents.slug` unique index with `23505`; that is mapped to `slug_taken` too, and spawn's name retry loop continues on it.
- **Agents** (agent create, spawn): claim and insert the agent in one transaction, so an agent claim is never orphaned, and the row lock makes a concurrent claimer wait for the commit. No row → `slug_taken` (409 `FieldError`) / the spawn's name refusal; a `23505` on `agents.slug` maps the same way. The cheap pre-read before workspace materialisation (`agent-service.ts:471`, `spawn-service.ts:84`'s retry loop) becomes one `SELECT` on `handles`; the claim is still the guarantee. `isNameTaken` is deleted.
- **Users** (better-auth before-hook on `/sign-up/email` and `/update-user` with a `handle`): the hook validates with the same `handleSchema` and, when it fails, returns without claiming so better-auth answers its own 400 (better-auth's validator runs later, inside the endpoint: verified in 1.7.25 `dispatch.mjs`, `runBeforeHooks` before `endpoint()` and before the endpoint's session middleware). On `/update-user` the hook claims only when `getSessionFromCtx` returns a user; without a session it returns and the endpoint answers 401, so nobody can squat names without signing in. It then claims outside any transaction (better-auth owns the user insert). No row → `HANDLE_TAKEN` (422). Keeping one's own handle on update is not a change. A handle change leaves the old claim unreferenced; only a user can reclaim it.
- **Both user paths run under `signUpMutex`:** `routes/auth.ts` sends `POST /api/auth/update-user` through `signUpMutex.run("sign-up", …)` as it already does for sign-up, so a user claim is never reclaimed while another user's insert is in flight. Users never race users; an in-flight user claim can never be taken by an agent, because the kinds differ. Agent create gets `slug_taken` while a user claim exists.
- **Accepted leftover (K2):** a sign-up or handle change that fails after its claim (email in use, short password, an update that also sends `email`) leaves a `user` orphan: reclaimable by any user, blocking that name for agents until then.
- **Guard (owner flag):** if a path appears where a user claim can be reclaimed while its insert is in flight, or the claim path grows past this one statement plus the validate call, stop and take the trigger option back to Or. Don't add columns.
- `resolveName(db, raw)` becomes one lookup on `handles` joined to `agents`/`users`: trim; a leading `#` → `channel`; drop one leading `@`; a name in `RESERVED_HANDLES` (including `humans`) → `reserved` before the lookup; `agent` → the row; `user` → `{userId, handle, disabled}`; nothing → `none`. The `ambiguous` and `humans` kinds are deleted.
- Test fixtures that insert agents or users directly (`test/helpers.ts`, `agents/testing/rows.ts`, `runtime-harness.ts`, `scripts/smoke-*`, the U1 and U4 seed scripts) insert their handle rows first, through one helper.

### 4.2 `@` everywhere

- Envelope `from` for an agent is `@slug` (`entryOf`, `agent-runtime.ts:262`); `about="@slug"`; scheduled `by` is `@slug` or `@handle` (`authorLabel`, `event-store.ts:1047`). Every factory prose line that names an agent uses `@slug` (`peer-body.ts` already does).
- Stored `by` fields (`control` events, compact entries) hold the handle **with** `@`; renderers stop prefixing `@` (no `@@lead`).
- `#` in a target → refused "Channels aren't supported yet."
- `messageLookup`, inbox entries and the web read senders with their kind (`fromKind`, §4.3), never by guessing from the sigil: `message-block.tsx:112`, `outgoing-message.tsx:64-73` and `speaker-line.tsx` change with it.

### 4.3 Envelope attributes (Q3)

`<factory-message from="@lead" from_kind="agent" kind="message" to="@orlevi @dev" urgent="false" id="…">`

- `from_kind` on every envelope: `human`, `agent` or `factory` (`@factory` and `@scheduler`). For a `task_comment` it is its author's kind.
- `to` only on `kind="message"` envelopes, always (one recipient too): the row's `recipients`, space-separated, in send order.
- `FactoryMessage` (`packages/harness/src/types.ts`) and `BatchRow` (`envelope.ts`) gain `fromKind` and `to?: string[]`; `one()` renders them. `envelopeSchema` gains `fromKind` and `to` for the UI.
- CLAUDE.md "How messages reach you": "`from` is the sender's handle; `from_kind` says whether it is a human, an agent or the factory; `to` lists everyone a message was sent to."

### 4.4 `recipients` and list sends (Q4, Q5)

- `messages.recipients text[]`, set on every `kind = 'message'` row (a check: not null when `kind = 'message'`): the **accepted** recipients of that send (D1), in order, after de-duplication, as handles with `@`. One row per accepted recipient (agent: `to_agent_id`; human: `to_user_id` with its inbox item). "Also to" is `recipients` minus the viewer and the chat's agent. No group id. A recipient renamed later keeps its old handle in old rows (accepted).
- `send_message` input: `{to: string[] (1–10), body, urgent?}`. A string is a validation error.
- Router `send(from, to[], body, urgent, opts)` replaces the single-target `send`/`sendFromHuman`: resolve each target; collapse duplicates by resolved principal; refuse per target (`none`, `reserved`, `channel`, self, archived, terminated, disabled user; for a human sender also any human); insert every accepted row in one transaction with the same `recipients`; hand each agent row over as today (human sender: awaited; agent sender: enqueued); `publishToUser(inbox_changed)` to human recipients only; `chat_changed` (§6.5) from PR 3.
- Agent result: `{results: [{to: "@orlevi", kind: "human", status: "inbox", id}, {to: "@dev", kind: "agent", status: "queued", recipient_status: "working", id}, {to: "@ops", kind: "agent", status: "pending", id, note: "@ops is errored; your message is delivered when a human restarts it."}, {to: "@x", status: "refused", reason: "@x was terminated and can't receive messages."}]}`. All refused → a tool error listing each reason, one line each. More than 10 → "Send to at most 10 recipients at once."
- `@humans` as a target: "`@humans` isn't a handle. Message people by handle; list_peers lists them."
- Factory notifications to every user (a top-level agent errored) keep `to_all_humans` and their fan-out, `kind = 'system'` only (`createHumanMessage`'s `"all"` is limited to it). Their label in lookups and the UI is "everyone" (`event-store.ts:1210`, `:1339`), never `@humans`.
- Human sends (PR 3, §6.6) dedupe on `(from_user_id, client_message_id, to_agent_id)`: the U3 unique index widens; a retry returns the result for **every** row with that `clientMessageId`.

### 4.5 `@humans` removed (Q6)

- Task comments: `humans` is a reserved name, so a `@humans` mention takes the existing reserved path (the comment posts; `not_reached` lists it, reason `reserved`). In `comment_task`'s result the reason text for `humans` is "`@humans` isn't a handle. Mention people by handle; list_peers lists them." Deleted: the `humans` outcome flag, `["@humans"]` in `mentioned_humans`, `case "humans"` (task-service ~L240, L336-343, L919-922) and its `inbox_changed` publish.
- UI: the inbox's "mentioned @humans" copy, `notifications.ts:80-84`, `speaker-line`'s "All humans", the `@` completion's `@humans` row.
- Agent-facing prose: CLAUDE.md drops every `@humans`; spawn-service failures (`spawn-service.ts:76, 144, 163, 217, 303`) say "ask your manager" when the caller has one and "ask a human (list_peers lists them)" otherwise.

### 4.6 `list_peers` and "Your org" (Q16)

- `list_peers(scope?)` → `{peers: [{handle: "@team-lead", kind: "agent", displayName, description, relation, status}, …, {handle: "@orlevi", kind: "human", name: "Or Levi"}]}`: agents first in today's order (manager, peers, reports, then `other` with `scope: "all"`), then humans by name then handle, disabled users left out. Names pass through `inline()`.
- CLAUDE.md "Your org" gains "Humans: `@orlevi` (Or Levi), …", at most 25 then "and N more; call mcp__factory__list_peers". Still a pure function of its inputs; it changes when users are added or renamed, read at the next process start.
- CLAUDE.md messaging, each rule once with its reason: "Send with `mcp__factory__send_message` to one or more handles (`@agent` or `@person`, up to 10); every recipient sees the full list. `list_peers` lists the agents and the humans." … "Message a human only when you need a decision or have something they asked for: they read every message." "Address people by handle; there is no address for all humans."

### 4.7 The Session's outgoing card (Break B6, self M5)

`outgoing-message.tsx` reads `to: string[]` and `{results}`. Speaker line "Ada → @a, @b +8" (the first two, then a count; the full list in the row menu's Recipients item and the line's accessible name). Under the card, one muted line per refused or pending recipient ("Not sent to @x: terminated"). A call whose result hasn't arrived renders from its arguments.

## 5. PR 2: raw Session input and the `/context` fixes

### 5.1 Route (Q7, Q8, R9, R10)

`POST /api/agents/:slug/input { text, clientMessageId }`, human session only; replaces `POST /api/agents/:slug/commands`. `GET …/commands` stays (autocomplete only).

Server steps:
1. Trim trailing whitespace. Empty, or over 64 KB (`MAX_BODY_BYTES`) → 400.
2. **Command or text.** After `trimStart`, if the text starts with `/` and its first token (up to whitespace) is a **known name**, compared case-insensitively with names and aliases (the agent's command list: stored, or the built-ins snapshot §5.3 plus template skills; and the denylist §5.2), it is a command:
   - denied → 422 `command_denied` with the entry's reason; nothing is written;
   - more than one line → 400 "A command must be one line.";
   - `compact` → the Compact flow (`rt.compact`, focus = the rest, `MAX_FOCUS_CHARS`), unchanged;
   - otherwise the command is written as `trimStart`ed text, with envelope tags in its arguments neutralised.
   Anything else (no leading `/`, or an unknown `/token` such as a pasted `/Users/or/log.txt`) is **free text**: envelope tags neutralised, every other byte as typed (after the trailing trim). Unknown `/x` reaches the model as text (spike `/nonexistent-cmd`). Classification only gates the denylist, the one-line rule and Compact: a skill the list doesn't know yet, sent as text, still runs in Claude, so a miss is safe.
3. Neutralising uses one function exported from `packages/harness/src/envelope.ts` (`neutraliseEnvelopeTags`, the one `body()` uses), for free text and command arguments alike (D4).
4. `rt.rawInput({text, userId, by: "@orlevi", clientMessageId})`: one in-memory `RawEntry` (today's `CommandEntry`, renamed), queued, held until no turn is open, written with `proc.raw(text)` (today's `command(text)`: one stream-json user line, no envelope), a barrier until its turn ends (`rawInFlight`, today's `commandInFlight`), retry-deduped by `(userId, clientMessageId)`. Wake reason `raw`. An errored agent holds it until a Restart; `raw` is not in `ERRORED_WAKES`. Queue item kind `raw` (replaces `command`), carrying `clientMessageId`; Cancel for the sender only, no Undo. 202 with the queue item.
5. When written, the runtime appends `operator_input{text, by, clientMessageId?, entryId}` (persisted: the audit record) in place of `control{cmd: "command"}` (`command` leaves the control enum).

Deleted: `BUILTIN_ALLOWLIST`, `REFUSED_BUILTINS`, `findCommand`, `runCommandBodySchema`, the composer's command mode and chip, `postCommand`, the `//` escape (raw mode has nothing to escape from).

Queued raw input is in memory: a factory restart drops it (as commands today). Every written input is in the session log.

Timing: raw `/commands` are never absorbed mid-turn (spike `slash-raw-mid-turn`); plain text written mid-turn **is** absorbed into the running turn (spike `partial-midturn-message-absorbed`). Holding all raw input until no turn is open keeps one input, one turn.

### 5.2 Denylist (Q9)

One constant in `packages/shared/src/commands.ts`, the rule's only owner, read by the server and the composer. Aliases are rows of the constant. Matching: first token, case-insensitive.

| Names | Reason (`/{typed}` is the name as typed) |
|---|---|
| `clear`, `new`, `reset` | "/{typed} isn't available: each agent keeps one session." |
| `model`, `effort` | "/{typed} isn't available: the model and effort come from the agent's template." (I2 updates it) |
| `login`, `logout` | "/{typed} isn't available: credentials are managed in Settings → Credentials." |
| `exit`, `quit`, `resume`, `continue` | "/{typed} isn't available: the factory runs this agent's process." |

Everything else is allowed (ADR 0022), including built-ins U3 refused. A template or Library skill named like a denied command can't be run raw; the `/` menu shows it disabled with the reason (F1).

### 5.3 Command list and the `/context` fixes

Root cause (2026-11-22): before an agent's first start nothing is stored, so `GET /commands` returned template skills only; the composer found no row and sent `/context` as an enveloped message. Also: Enter sent text while the list loaded or was empty, a pasted `/command` never opened the menu, and the browser kept the list up to 30 s after a start.

- **Built-ins before the first start.** `packages/shared/src/claude-builtins.ts`: the 55 `builtin: true` entries of Claude Code 2.1.327's `initialize` answer (`packages/harness/fixtures/u3/control-initialize-commands.jsonl`), generated by a script kept beside it (`{name, description, argumentHint, aliases}`). `GET /commands` with nothing stored returns those plus the template's skills (`source: "template"`); once stored, the session's list. Either way denied names are kept but flagged `denied: true` with their reason, so the menu can show them disabled and nothing else offers them.
- **Fresh after a start.** After `saveCommands` the runtime publishes a per-agent frame `agent_commands_changed{agent}` (to the agent's subscribers; named apart from Claude's own `system/commands_changed`); the web handles it globally (the app's `onMessage` in `routes/_app.tsx`) and invalidates `["agent-commands", slug]`, so the Session's menu and the Chat's leading-`/` hint both get it. This closes the window between `process_started` and `initialize`'s answer (≤ 5 s).
- **Never a silent text send.** The Session composer sends everything through `/input`; the list affects only the menu.
- Tests, one per failure mode: never-started agent lists `context`; the list after a start is the new one (frame-driven); Enter on `/context` while the list is pending POSTs `/input`; a pasted `/context` + Enter POSTs `/input`; `/context` with an empty list POSTs `/input`; `/context` + a trailing Return (phone) runs.

### 5.4 Session composer (Q10)

- The shared `Composer` in raw mode. Toolbar: `/` only (no `@`, no attach). Placeholder "Raw input to Claude · / for commands". Hint slot: at rest "Goes to Claude as typed · Message Ada in Chat" (link to `/chat`), while a turn is open "Runs after the current turn.". Enter sends (⌥Enter is Enter, no urgent); Stop as today; Esc: closes the menu, else stops the turn (no command mode). A pasted or dropped file: "Files can be sent from the chat" on the note slot.
- `/` menu: autocomplete only; accepting a row inserts `/name `. Denied names appear only when the typed prefix matches one exactly, as a disabled row with its reason.
- **The note slot (all composers, DESIGN amendment §9.3):** one slot, one note at a time, by priority: error > refusal (denied command, one-line rule, refused recipient) > conflict (files with several recipients) > hint. On fine pointers it is the toolbar's hint slot, which already keeps its height; below `md` it is one line reserved under the frame in composers that can show notes. A note never changes the composer's height; it is announced through the composer's existing live region. Today's stacked `<p class="mt-2">` notes (`components/composer/composer.tsx:1104-1150`) collapse into it.
- A denied command is recognised when its first token is complete (whitespace typed, or Enter); then its reason takes the slot and Send uses the existing `held` pattern (`aria-disabled`, focusable, the reason linked with `aria-describedby`; pressing it shows the reason). The server refuses it too.
- **One node from Sending to the timeline:** the optimistic raw block, the queued `raw` item and the `operator_input` row are keyed by `clientMessageId` and render in one shape: the speech row "You · raw", mono when it is a command, prose otherwise, then "Runs after the current turn." and Cancel while queued. The reducer replaces the queue item with the `operator_input` row in one step (added to `handedOff`, so it never fades). U3's `SLOW_SEND_MS` (400) and `YOUNG_ITEM_MS` (300) apply.
- Drafts `sessionDraftKey(slug)` under the existing `of-draft:v1:` prefix (`of-draft:v1:session:<slug>`; `agentDraftKey` is renamed, no alias); ↑ recall: your newest `operator_input` in the loaded timeline.
- Timeline: `operator_input` is a speech row, speaker "You · raw" or "Ada Lovelace · raw" (an agent's, PR 4: "@lead · raw"), `pre-wrap` with `overflow-wrap: anywhere`, the §7.6 clamp. `command_output` stays as U3.
- The Session view marks read the messages to you it has loaded and rendered (decision #16 stands, R2; today's `useReadFrom`, server-side, never on hover).

### 5.5 The operator rule (R9)

CLAUDE.md, in "How messages reach you": "Input that isn't inside a `<factory-message>` envelope, other than your own scheduled prompts and task notifications, comes from a human operator watching your session or, for slash commands, from your manager through send_command. Answer it in plain text in the session, not with send_message." Checked: in-session cron prompts and `<task-notification>` turns reach the model without an envelope (harness-driver "Self-started turns"), so the parenthetical is literally needed. The answer reaches the manager as `member_update` like all text (ADR 0005).

## 6. PR 3: Chat and Inbox

### 6.1 Routes (Q11)

- `routes/_app/agents.$slug.tsx` becomes the layout: loader as today, the shared header (§6.2), Agent details panel and sheet, `<Outlet/>`. The header stays mounted across the switch.
- `agents.$slug.index.tsx`: `beforeLoad` redirects (replace) to `/agents/$slug/chat`.
- `agents.$slug.chat.tsx`: `?message=<id>`. `agents.$slug.session.tsx`: `?event=`, `?message=` (today's).
- Every link that opened an agent (sidebar rows, palette, Agents page, inbox, task and schedule links) goes to `/chat`; links to a session event go to `/session?event=`. Session row menus gain "Open in chat" on messages between you and this agent; Chat row menus have "View in session".
- Document titles: "Ada · Chat" and "Ada · Session" (the status prefix stays).
- Switching is instant (no transition). Each view keeps its scroll position or pin across switches in a module-level per-slug map (the Session's events refetch on return: accepted); the Session opened by a switch is a load (nothing fades). "Open session" from a working or outcome line lands pinned at the bottom (or at its `?event=`).

### 6.2 Shared header (R8)

`SessionHeader` moves to `features/agents/agent-header.tsx` for both views: avatar, name, status badge, the one live fact (its "Open session" link hidden in the Session), as today. Actions gain the **view switch**: a ghost button, icon + label (Chat: "Session" with lucide `SquareTerminal`; Session: "Chat" with `MessageSquare`), in a fixed slot just left of the Agent details toggle, `min-width` of the wider label so it never moves. Icon-only (label as `aria-label` and tooltip) below ~24rem container width. The `crowded` rule counts it: below 22rem with a third action (Restart, Pin), the view switch moves to the top of ⋯ ("Open session" / "Open chat") and Restart stays visible.

### 6.3 Chat thread API

`GET /api/agents/:slug/chat?before=<cursor>|around=<messageId>&limit=50` (human session; cursor = `createdAt|id`):

```ts
type ChatEntry =
  | { kind: "message"; id: string; from: string; fromKind: "human" | "agent";
      body: string; recipients: string[]; urgent: boolean; createdAt: string;
      state: "pending" | "delivered" | "rejected"; rejectReason?: string;
      attachments?: MessageAttachment[]; clientMessageId?: string }
  | { kind: "turn_outcome"; key: string; turnId: string; endedAt: string; eventSeq: number | null;
      outcome: "no_reply" | "stopped" | "error" };
type ChatPage = { entries: ChatEntry[]; nextCursor: string | null; newerCursor: string | null;
                  working: { key: string; since: string } | null };
```

`key` is the id of the first of your messages in the batch the turn consumed: the working line and its outcome share it from the moment the batch is written, so neither a cron turn starting meanwhile nor `turn_started` arriving re-keys the line.

- Messages: `kind = 'message'` rows from you to this agent and from this agent to you. Cancelled rows are left out (the client's cancel overlay shows "Message cancelled. Undo").
- Turn outcomes: turns of the agent, closed, that consumed one of your rows (`messages.delivered_turn_id = turn.id AND from_user_id = me`), with no `message` row from the agent to you created between the turn's start and end. Any turn counts (no origin filter: the stamp is the proof). `outcome`: `stopped` when `terminal_reason` is `aborted_tools` or `aborted_streaming`, or the turn was closed by a deliberate stop (`process_stopped`: Restart, archive, hibernate); `error` when `is_error`, or closed by `process_exited` or `factory_restarted`; else `no_reply`. `eventSeq` is stored on the `turns` row at close (new column `end_event_seq`): the `turn_end` event's seq for a normal close (`append` returns it; passed to `closeTurnWith`); for an exit or boot close, the turn's last event seq (`max(seq) where turn_id = id`), null when it has none (the link then opens the Session at its end).
- **Exit and boot stamping (re-review M4, M5):**
  - Exit with a turn open: before `onExited` resets its memory (~L2808-2823), it snapshots `closing = {turnId, awaiting ids and their human senders, since}`; `closeTurnWith(turnId, close, closing ids, attribute = true)` then stamps and closes in one transaction, and `workingFor` keeps reporting the snapshot until that settles (`finally`), so a page never shows neither working nor outcome.
  - Exit with a written batch but no turn opened (`batchUnanswered`): the runtime opens and closes a zero-length turn (`terminal_reason: "process_exited"`, `is_error`) carrying the stamp, so the message gets its "hit an error" outcome.
  - Boot: `closeDanglingTurns` also stamps that agent's delivered, unstamped `kind = 'message'` rows whose `delivered_event_seq` is at or after the dangling turn's first event, in the same transaction.
- `working` comes from the runtime (in memory): your row is in a written batch not yet closed (`awaiting`, or absorbed into the open turn). The runtime keeps, per written batch, its write time, row ids and their human senders (today `awaiting` holds ids only and absorbed rows only their kinds). `since` = the batch's write time, so a cold start reads as working (D3). On `turn_end` the stamp and the close are one transaction before memory clears, so the swap is atomic server-side.
- **Read order in `GET /chat`:** read `rt.workingFor(userId)` synchronously first, then query; drop `working` if its `key` already has an outcome in the page. Never both, never neither.
- `around` returns 25 entries each side of the message, with `newerCursor`; the view shows Jump to latest.
- Index: partial `messages (to_agent_id, from_user_id, created_at) where kind = 'message'` and `messages (to_user_id, from_agent_id, created_at) where kind = 'message'`; the plan checks the plan on the 214-agent dataset.

### 6.4 Chat view (`features/chat/`)

- One column, max 52rem, newest at the bottom; stick-to-bottom on intent and one Jump to latest (U3 §8); Load earlier at the top keeps the top visible row in place.
- **Your messages** are the speech tier's cards (speaker line "You", card, the 40-line / 4,000-character clamp). **Ada's replies** are unboxed `.prose-of` at 15/24 under the speaker line (avatar, display name, muted mono handle, time), never clamped (D7, R7). No bubbles, no left/right alignment, no tool rows, no envelopes, no member updates.
- **Also to:** after the speaker, muted "also to @dev" / "also to @dev and 8 others" (`Intl.PluralRules`), handles mono; the full list in the row menu's Recipients item and the speaker line's accessible name.
- **Row menu** (DESIGN One row menu): Copy text, Copy link (`/chat?message=`), View in session, Recipients (when there are others), on touch the time; long-press on touch.
- **Pending** rows of yours: muted, "Waiting for Ada's current step", Cancel → "Message cancelled. Undo" in place (U3 §6.4 routes and overlay). **Rejected:** "This message wasn't delivered: {reason}."
- **Working line:** always the thread's last row while `working` is set: the activity line's anatomy and component, `[tooth] 42s · Ada is working · Open session`, duration first and tabular (`Elapsed` from `working.since`, its own memo boundary, paused while the tab is hidden), name middle-truncated, the duration and link `shrink-0`, h-6 like the activity line. Only the page's `working` decides whether it shows; status frames never hide it.
- **Outcome line:** "Ada finished without replying · Open session" / "Ada was stopped before replying · Open session" / "Ada hit an error before replying · Open session", muted 13px, the same box (height, gutter, 12px icon slot with a muted icon in place of the tooth, link at the same x). It sits at its turn's `endedAt`. When a refetch brings the outcome for the batch the working line showed, both share the key `turn:<key>` and the node is reused (no fade). If the agent replied, the working line simply goes (the reply arrives in the same commit). Each "Open session" link's accessible name includes the time ("Open session at 14:02"); inline links on these two status lines are a documented exception to "rows carry no footer links" (DESIGN amendment §9).
- **States:** loading: static skeleton speech rows; empty: "No messages with Ada yet." with the composer; error: "Couldn't load this chat." with Retry (older pages: an error line at the top).
- **Read-only** (terminated, archived): the composer is replaced by the read-only line, as in the session.
- **Live rows (Motion H1, H2):** the view keeps a `liveAfter` cursor, set on load and after any refetch not triggered by `chat_changed` (focus, reconnect, Load earlier, pane retarget). An entry fades in (opacity 150ms, the session's rule) only if it is newer than the cursor and arrived from a `chat_changed` refetch while the view was mounted and visible. Never faded: an entry matching an optimistic block by `clientMessageId`, a pending row becoming delivered, an outcome replacing the working line. The working line fades in when it appears live (like the activity line; never on load or switch) and leaves instantly. Entries are keyed by `clientMessageId ?? id` and merged on both; `SLOW_SEND_MS`/`YOUNG_ITEM_MS` apply.
- **Deep link** `?message=`: the card's arrival tint (never the gutter), as DESIGN.

### 6.5 Live updates (Q14)

- Per-user ws frame `chat_changed{agent: slug}` (`publishToUser`), published when a `message` row between that user and that agent is created or changes state (delivered, cancelled, restored, rejected), and when a batch holding one of their rows is written or its turn starts or closes.
- The Chat query (`["chat", slug]`, infinite) refetches its newest page on the frame and **unions by key** into the cache (never drops cached entries; a gap larger than one page refetches until it meets the cache). Refetches coalesce: one in flight plus one trailing. Stable entry references and memoised rows and markdown (U1's timeline-perf pattern): one new entry renders one row; a tick renders zero rows.

### 6.6 Chat composer (Q5, Q13, R4, R6)

- The shared `Composer`; draft key `chatDraftKey(slug)` (`of-draft:v1:chat:<slug>`) storing text **and** recipients (validated on read: `string[]`, ≤ 10; the key is removed only when both are empty). Toolbar: `@` and attach (no `/`). Placeholder "Message Ada" ("Message Ada and 1 other" with recipients). Enter sends; ⌥Enter sends urgent (interrupts, as today); attachments (U3 §13.5) when there is one recipient; optimistic block; ↑ recall: your newest chat message.
- **Stop** while `working` is set (the turn read your message), left of Send as in the Session; Esc closes the menu, else stops that turn. On touch the hint points at Stop.
- **Recipients:** no recipient row while the chat's agent is the only recipient. The `@` menu lists live agents only, without the chat's agent and agents already added; rows read "Add @dev as recipient", the menu note "Adds a recipient · Esc keeps it as text". Accepting adds the recipient, removes the typed `@token`, opens the row "To: Ada (plain text) [@dev ×]" above the text and announces "Also sending to @dev". Chips: an `AgentChip` at 16px, `max-w-[min(12rem,100%)]`, at most 2 rows then "+N" expanding in place (below `md`: one row). Backspace in an empty box selects the last added chip, a second press removes it ("Removed @dev" announced). Removing the last added chip closes the row. Max 10 recipients. Chips appear and leave instantly. A typed `@name` not accepted stays text.
- **Files:** with more than one recipient the paperclip is `aria-disabled`; pressing it shows "Files go to one agent at a time" on the note slot; adding a recipient while files are attached is refused with the same note.
- **Leading `/`:** sent as text. The note slot shows "Commands run in the session · Open session" only when the first token matches a known command (the agent's list or the built-ins snapshot) or the list hasn't loaded; "Open session" writes the text into `sessionDraftKey(slug)` in its click handler.
- **Route:** `POST /api/messages {to: string[], body, urgent, clientMessageId, attachments?}` (human session), replacing `POST /api/agents/:slug/messages`. 202 `{results: [{to, status: "queued" | "start_failed" | "refused", id?, item?, reason?}]}`; `start_failed` keeps the row pending (today's 503 case, per recipient). Attachments with more than one `to` → 422. When a recipient other than the chat's agent is refused, the others are sent and the note slot says "Not sent to @x: terminated." (one line per refused recipient); when the chat's agent itself is refused, the draft stays and the note gives the reason ("Sent to @dev only." if others went).

### 6.7 Inbox (Q12, R2, R3)

- `GET /api/inbox` (and `?unread=true`) returns `{chats: ChatRow[], items, nextCursor}`; `items` no longer contains `kind: "message"` entries. `ChatRow = {agent: {slug, displayName, template, avatarVersion, kind, status, archivedAt}, unread: number, latest: {messageId, preview (plain text, ≤ 280 chars), createdAt, urgent}}`, for every agent with unread `message` items for you, unpaginated. `kind: "message"` inbox items stay the unread record.
- The list interleaves chat rows and items by `latest.createdAt`; a chat row older than the oldest loaded item waits until a page reaches its time or no pages remain (accepted). The Inbox is empty only with no chats and no items.
- **Chat row** (the item row's anatomy: `LINK_CLASS` grid, unread-dot slot): line one `AgentChip` 16 (display name; the handle in its tooltip; spawned agents keep `· ab12`), muted "· 3 new" (`Intl.NumberFormat`), Urgent badge, a muted "archived"/"terminated" when ended, time on the right; the name truncates, the rest `shrink-0`. Line two the preview. Click/Enter: on wide screens selects it (`?item=chat:<slug>`), below 1024px navigates to `/agents/<slug>/chat`.
- **Reading pane:** hosts that agent's Chat (thread and composer) under a compact 40px strip: avatar, name, status badge, "Open chat" (full page) and the "Session" view switch; no ⋯, no `]`, no Agent details. Selecting keeps focus in the list; the pane composer never takes focus by itself (Enter on the row or `r` moves it there). Retargeting swaps instantly and nothing in the new thread fades. It opens at the first unread message with a "New" divider when the unread messages are taller than the pane, else pinned at the bottom. `?item=chat:<slug>` resolves by slug (reload, Back/Forward, deep link), even when the chat has nothing unread. Decision #6 is refined: for chats the pane hosts the Chat.
- **Read:** the Chat page marks the agent's messages to you read at once (today's `read-from`); the pane marks them after `INBOX_DWELL_MS`, cancelled if the selection moves; the Session marks what it rendered (§5.4). `useReadFrom` posts on mount and when a message newer than the last one read arrives, never in reaction to its own messages turning unread (so Mark all read's Undo sticks).
- **List stability (R3, DESIGN Motion):** a chat row's removal (read), re-sort (new message) and insertion (first unread) wait until the pointer and focus have left the list, then apply instantly. Until then a read row shows read with no count; the selected row stays. A chat on screen and visible in the pane doesn't bump its count.
- **Mark all read:** `upTo` is the newest of `items[0]` and every `chats[].latest.createdAt`; the optimistic update zeroes chat rows and `byAgent`; the outcome counts rows ("Marked 3 chats and 2 items as read."); Undo restores instantly.
- **Notifications and recent senders:** `useInboxNotifier` reads `chats` too (title "Ada · 3 new", tag `latest.messageId`, click opens `/agents/<slug>/chat?message=<latest>`); `mention-source`'s recent senders rank from `chats`.
- The pane's old "message" content (session excerpt + reply composer) is deleted; mentions and task events keep their panes.

### 6.8 Sidebar and palette

Agent rows link to `/chat`; the unread count stays, and an agent row is active on both its Chat and Session. The palette's agent results open the Chat; on an agent page it offers "Open session" or "Open chat" for the other view.

### 6.9 What leaves the Session view

The enveloped composer (raw since PR 2) and the inbox-reply role. Its header shows the "Chat" switch.

### 6.10 DESIGN.md decision 20 note

The view switch is navigation, so ghost (amendment §9.6), not the outline decision 20 gives header-level actions.

### 6.11 Long content and small screens

- Speaker lines, chat rows, working/outcome lines: names and handles truncate (handles in the middle) before times, counts, durations and links, which are `shrink-0`. "Also to" counts the rest. Recipient chips per §6.6.
- 320/390px: header per §6.2; Chat composer per U4's phone composer with the note line reserved. 1024px: the pane is ~404px and its compact strip fits. 200% text: no horizontal scroll (U4's overflow check runs on Chat, Session header and Inbox).

## 7. PR 4: `send_command` (Q15)

- Registered for every agent. Persistent agents: `send_command(target, command)`, target the caller (`"me"` or its own handle) or a direct report (`reports_to = caller`, spawned agents included). Spawned agents get a version whose description says "only yourself" and that refuses any other target.
- `command`: starts with `/`, one line after trimming, ≤ 64 KB, the shared denylist; arguments neutralised (§5.1.3). `/compact [focus]` → the Compact flow; anything else → a `RawEntry`. Entries carry `by: "@caller"` and `self: true` when caller = target (no `userId`; agents never cancel).
- Result: `{target: "@dev", status: "queued", note}` with note "Runs when @dev's current turn ends." (turn open), "Runs now." (idle), "Wakes @dev to run it." (hibernated, wake reason `raw`/`compact`) or "@dev is errored; it runs after a human restarts it." Self: "Your /compact runs when this turn ends. Write down where you are before you end the turn." (other self-commands: "Your /x runs when this turn ends.").
- Refusals (one sentence): "@x isn't you or one of your direct reports.", terminated or archived targets as for messages, a denied command's reason, "You already have a command queued for yourself." (at most one pending self-command).
- **Self-compact continue:** decided once, at the self compact's `turn_end`: failure if a `compact_failed` was seen since it was written, else success. The runtime then adds a `compact_continue` notice: "Your /compact finished. Continue where you left off." or "Your /compact didn't run (see the Session). Continue where you left off." (fixed text: Claude's failure text is process output and is never quoted). The notice starts a turn. If the process exits mid-compact, no notice is added (the restart's own notice covers it). Nobody can cancel an agent's queued `send_command` entry in the UI (agents never cancel; humans can't cancel another principal's input). A report compacted by its manager gets no notice; other self-commands run as their own turn with no notice (a self `/context`'s output is not read back to the agent: documented).
- The `control{cmd: "compact"}` and `operator_input` events carry `by: "@lead"`; the timeline shows the agent as the speaker ("Lead · raw").

## 8. Server and shared changes by PR

| PR | Change |
|---|---|
| 1 | `handles` + FKs; `claimHandle`; `isNameTaken` gone; `resolveName` on `handles`; auth before-hook validates and claims (update-user only with a session); update-user under `signUpMutex`; agent and spawn create claim in their transaction; fixtures' handle helper; envelope `from_kind`, `to`, `@` agents, `about`/`by` with `@`; stored `by` with `@`; `messages.recipients`; widened client-id index; Router list send and per-recipient results; `sendMessageToolSchema.to` array; `list_peers` `peers`; disabled users excluded; task-service `@humans` branches deleted and the reserved text; "everyone" label; CLAUDE.md org and messaging; `@humans` prose sweep and its test; Session outgoing card; fake `$mcp` |
| 2 | `POST /input`; denylist and `claude-builtins.ts`; `RawEntry`, `rawInFlight`, wake reason `raw`, queue kind `raw`; `operator_input`; `neutraliseEnvelopeTags`; `GET /commands` built-ins and `denied` flags; `agent_commands_changed` frame; `/commands` POST and allowlist code deleted; CLAUDE.md operator rule; the composer note slot |
| 3 | `GET /chat` (`before`/`around`); `chat_changed`; runtime `workingFor(userId)`; exit-path stamping; `turns.end_event_seq`; exit/boot stamping and the `closing` snapshot; `POST /api/messages`; `POST /api/agents/:slug/messages` deleted; inbox `chats`; the two partial indexes |
| 4 | `send_command` (per-caller registration); `compact_continue` notice; one-pending-self-command check |

## 9. DESIGN.md amendments

1. **Layout** (PR 3): "An agent opens as its Chat; its Session is one ghost button away in the header. Switching between them is instant; the header stays put."
2. **Components → Chat** (new, PR 3): "The Chat is the speech tier of the session timeline and nothing else. Your messages are cards; the agent's replies are unboxed prose under its speaker line; no tool rows. 'Also to' follows the speaker. While a turn that read your message runs, the thread's last row is a working line in the activity line's anatomy ('[tooth] 42s · Ada is working · Open session'); when the turn ends without a reply it becomes a muted outcome line in the same line box and position. Recipients are chips in a 'To:' row that appears only once you add a second one."
3. **Components → Composers** (PR 2, PR 3): "A composer has one note slot, one note at a time (error, refusal, conflict, hint): the toolbar's hint slot on fine pointers, one reserved line under the frame below md. A note never changes the composer's height; a disabled control that has a reason stays focusable and shows it there, never only in a tooltip. Toolbars: the chat composer has @ and attach, the session composer / only. A session composer sends what you type to Claude unwrapped, with no attachments and no urgent send; a chat composer sends messages and interrupts with ⌥Enter. Stop sits left of Send in a session composer while a turn is open and in a chat composer while a turn that read your message runs." The "leaves command mode" step leaves the Esc chain.
4. **Session timeline → Speaker line** (PR 1): "An outgoing card to several recipients reads 'Name → @a, @b +8'; the row menu lists them all. In the Chat the speaker line names only the sender; other recipients follow as a muted 'also to …'."
5. **Session timeline → One row menu** (PR 3): "The Chat's working and outcome lines carry one inline 'Open session' link: they are status lines, not rows."
6. **Buttons** (PR 3): "A header view switch (Chat ↔ Session) is navigation: a ghost button with icon and label, icon-only when narrow, moving into ⋯ when the header is crowded."
7. **Motion → Live rows** (PR 3): "The Chat follows the same rule: a message that arrived by a live frame fades in; your own send, a pending message becoming delivered and the outcome replacing the working line keep their element and don't fade; the working line fades in like the activity line when it appears live. Nothing fades on load, a reading-pane retarget or a Chat/Session switch." The activity line's fade is gated on a live attribute (today `styles.css:331` fades it on every mount).
8. **Motion → Frequency decides** (PR 3): "Live lists never reorder, insert above the pointer or drop rows while the pointer or focus is in them; the change waits until both leave, then applies without animation. A selected row stays until the selection moves."
9. **Layout → Two panes** (PR 3): "An unread chat is one Inbox row; selecting it shows the Chat in the reading pane under a compact strip, never Agent details. A chat opened in the pane is read after the dwell."
10. **Navigation** (PR 3): "Agent rows open the agent's Chat; the row is active on its Chat and its Session."

## 10. Product-doc edits (gitignored, applied in the main checkout by the dev of the PR named, listed in its description)

- PR 1: `concepts/message.md`, `concepts/user.md` (L17-18), `concepts/task.md` (L38), `concepts/reporting-line.md`, `architecture/factory-mcp.md`, `architecture/context-assembly.md`, `architecture/data-model.md` (`handles`, `recipients`), `architecture/permissions.md` (L40), `behavior/tasks.md`, `behavior/inbox.md`. Task doc AC "a `@humans` mention is refused" becomes "is posted and reported as not reached" (Q6).
- PR 2: `concepts/session.md`, `behavior/agents-and-sessions.md`, `architecture/harness-driver.md`, `architecture/claude-streaming-and-commands.md`, `architecture/agent-runtime.md` (raw entries), `architecture/context-assembly.md` (operator rule).
- PR 3: `behavior/agents-and-sessions.md`, `behavior/inbox.md`, `concepts/session.md`, ADR 0003's note, `ui-review/decisions.md` #6 (refined: the pane hosts the Chat), `architecture/data-model.md` (`turns.end_event_seq`, indexes).
- PR 4: `architecture/factory-mcp.md`, `concepts/reporting-line.md`, `concepts/message.md` (`compact_continue`), `architecture/agent-runtime.md`.

## 11. Testing

- **Unit/shared:** denylist matching (case, aliases, first-token completion: `/news-digest` doesn't match `/new`); command-vs-text classification (known token, unknown `/path`, multi-line, trailing whitespace); `neutraliseEnvelopeTags` used at both points; envelopes with `from_kind`/`to`; `resolveName` incl. `#`, `humans`, disabled; per-recipient results; `claude-builtins` generator matches the fixture.
- **Server (DB tests run only in CI; the local Postgres role is unavailable):** claim-first (agent vs user both orders; an agent create while a sign-up's claim is in flight, paused between hook and insert, gets `slug_taken` and no duplicate exists; orphan reclaim by a user after a failed sign-up; an agent never reclaims a user orphan; the before-hook order on both auth paths); list send (dedupe, self, terminated alone, all refused, >10, `#`, `@humans`, disabled, recipients, inbox items per human, client-id dedupe per agent and retry returning every row); `list_peers`; CLAUDE.md snapshots; `/input` (free text unwrapped and neutralised, command arguments neutralised, denied 422 with nothing written, multi-line known command 400, multi-line unknown `/path` sent as text, compact flow, held until turn end, written after `result`, `operator_input` persisted with `by` and `clientMessageId`, errored holds, cancel); `GET /commands` before first start; `agent_commands_changed`; chat query (both directions, other humans' threads excluded, `no_reply`/`stopped`/`error`, process-exit outcome with and without an open turn, boot-closed turn stamping, `update-user` without a session claims nothing, update-user and sign-up serialised, a reply in the turn suppresses it, `working` from write, atomic close, `around`); `chat_changed` publish points; inbox `chats` and `?unread=true`; `send_command` (self, report, spawned report, non-report, spawned self-only, denied, one pending, hibernated woken, errored note, continue notice once on success and on failure, none on exit mid-compact or for a manager's compact).
- **Web component:** Chat: cards vs prose, also-to, row menu, pending/cancel, rejected, working line last and ticking with zero row renders per tick, working→outcome reusing the node, no fade on load/refetch/focus, optimistic merge by `clientMessageId`, states; Chat composer: recipients row, chips (add, two-step Backspace, max, persisted draft), paperclip refusal, `/` hint rule and carry-over, Stop while working; Session composer: note slot height constant (denied command, one-line), no chip, paste + Enter, list loading + Enter, Sending→queued→row one node; Inbox: interleave, deferred removal/re-sort under pointer and focus, dwell read in the pane, `?item=chat:` reload, Mark all read with chats only and Undo, notifications from chats; header: view switch slot and crowded move into ⋯; redirect and links; render counts (U1 `timeline-perf` pattern) for live Chat updates.
- **Browser evidence** (last plan tasks): the U4 harness (`docs/product/ui-review/u4-evidence/harness`, `run.sh` lock, fake Claude only, one pass at a time), Chromium and WebKit headless, for every acceptance criterion with a UI; server-only criteria (the database namespace, `list_peers`, `send_command` refusals and the like) cite their CI tests in the AC table. The full matrix (320/390/1024/1440, light and dark, 200% text) runs only on layout-sensitive views (the Chat, the composer with recipients, the header switch at 320/390, Inbox chat rows and the pane); everything else at one width and one theme. Plus frame-by-frame recordings of the working→outcome swap and the raw Sending→row handoff. The fake learns an `$mcp {tool, args}` directive that calls the factory MCP with its own token (`OPEN_FACTORY_AGENT_TOKEN`, URL from `.mcp.json`), so it can `send_message` and `send_command` (PR 1); it already answers plain un-enveloped lines.

## 12. Follow-up issues

1. Persist queued raw input across a factory restart, if losing it bites.
2. `/model` and `/effort` refusal copy points at I2's form when it lands (I2 owns it).
3. Find in chat (with #105).
4. Re-verify the built-ins snapshot when Claude Code moves past 2.1.327.
5. A failed sign-up's orphan claim blocks that name for agents until a user claims it (K2): revisit if it bites.

## 13. Decisions

Proxy answers Q1–Q16, Q2b and R1–R10, with alternatives and certainty, are in the decisions issue. Tech-lead decisions:

- **D1** `recipients` holds the accepted recipients only, so an envelope never lists someone who didn't get it.
- **D2** Chat outcomes distinguish `stopped` and `error` from `no_reply` (`terminal_reason`, `is_error`, process exit).
- **D3** `working` comes from the runtime's memory and starts when your batch is written, because the starting batch is stamped only at close and a cold start can take seconds.
- **D4** One exported neutraliser for free text and command arguments.
- **D5** Built-ins before the first start come from a generated snapshot of the recorded `initialize` fixture.
- **D6** A handle change frees the old handle by leaving it unreferenced (reclaimable by a user claim).
- **D7** Your messages are cards and the agent's replies unboxed prose (R7).
- Plus the review fixes the owner accepted as a list: one note slot; per-mode toolbars; Chat row menu; "and N others"; Chat states; `around`; compact pane strip; Mark all read over chats; `?item=chat:` by slug; notifications and recent senders from chats; enriched `ChatRow`; outcome on process exit and `eventSeq`; self-compact decided at `turn_end`; `agent_commands_changed` frame; refusal copy in one shape; the Session placeholder and at-rest hint; live-row rules keyed by `clientMessageId`.

Rated 3/5 or lower, for Or:

- **Q2/Q2b/R1** (3/5): claim-first `handles` with FKs, a same-kind reclaim of unreferenced claims, no triggers and no extra columns. Reserved rows were dropped at plan review (one owner: `RESERVED_HANDLES`).
- **Q6** (3/5): `@humans` in a task comment posts and reports `not_reached: reserved` rather than refusing the comment (the task doc's AC changes).
- **Q11/R8** (3/5): ghost Chat/Session view switch in the header, moving into ⋯ when crowded; document titles name the view.
- **R6** (3/5): Stop in the Chat composer while a turn that read your message runs (Emil disagreed).
- **R7** (3/5): your messages as cards, agent replies unboxed.

## 14. Risks and unverified

- **Better-auth hook order** is confirmed from the 1.7.25 source; PR 1's first server test proves it on both paths.
- **Raw plain text mid-turn** is absorbed by Claude (spike), which is why all raw input waits for the turn to end.
- **Newer built-ins and aliases**: the denylist covers today's names; a new alias of a denied command passes until a line is added.
- **`/compact` failure reason** is never quoted, so the agent learns only that it failed.
- **Self-compact on real Claude** (compact then a notice-started turn) is built from the recorded `manual-compact` sequence; a live run is for Or to do or waive.
