# I1 Chat and Session: Technical Design

Task: [I1 Chat and Session](../../product/roadmap/v0.0.2/i1-chat-and-session.md) (gitignored `docs/product/`, read from the main checkout). Decisions: ADR 0021 (handles and recipients), ADR 0022 (Chat and raw Session), ADR 0026 (`send_command`), ADR 0028 (pre-release, no compatibility). Builds on U3 (`2026-11-21-u3-chat-design.md`: shared composer, `/` commands, raw-command path, streaming) and must follow I4 (`2026-11-23-i4-field-errors-design.md`) for any form it touches. Stacks on I6 (`spec/i6-path-help`).

Every question was answered by the owner proxy (`owner-i1`); the log with alternatives and certainty is in the decisions issue. Section 13 lists what is rated 3/5 or lower.

## 1. Goal

Talking to an agent feels like a DM; looking under the hood is a deliberate step.

- Every principal is `@handle`, agents included; `#` is reserved; `@humans` is gone; `send_message` takes a list; one handle namespace enforced by the database; agents can list the humans.
- Each agent has two views: **Chat** (default, per human: your messages and its `send_message` replies to you) and **Session** (diagnosis: the live timeline, with a composer that writes raw input to Claude's stdin minus a denylist).
- The Inbox shows one row per chat with unread messages.
- Agents get `send_command` for themselves and their direct reports.
- `/context` (and any built-in) works on an agent that has never started.

ADR 0028: nothing here keeps old shapes alive. The migrations are schema-only; **reset local data** (drop the database, recreate agents) after PR 1. Old `message_in` events with bare agent senders are not parsed specially.

## 2. Acceptance criteria

Numbered for the plan and the evidence pass. "PR n" says where each lands.

1. (PR 3) Clicking an agent in the sidebar, the palette or the Agents page opens `/agents/<slug>/chat`. A bare `/agents/<slug>` redirects there.
2. (PR 1, PR 3) A message you send from the Chat arrives in the agent's session as `<factory-message from="@you" from_kind="human" kind="message" to="@agent" …>`.
3. (PR 3) The agent's `send_message` reply to you shows in your Chat and as one "@agent · 1 new" Inbox row; opening the Chat (or the row in the reading pane) marks it read and the row leaves the Inbox once the selection moves.
4. (PR 1, PR 3) An agent sends one message to `["@orlevi", "@dev"]`: each envelope carries `to="@orlevi @dev"`; it appears in Or's Chat with that agent marked "also to @dev"; when `@dev` is terminated, only `@dev` is refused and the rest are sent.
5. (PR 1) `send_message` to `@humans` is refused with guidance; a task comment mentioning `@humans` is posted and its result says `@humans` reached nobody; agent-facing prose never says `@humans`.
6. (PR 1) Creating an agent whose slug equals a user's handle fails at the database (`slug_taken`), including when the two writes race; signing up with an agent's slug fails with `HANDLE_TAKEN`; a sign-up that failed for another reason never locks its handle.
7. (PR 1) `list_peers` returns one `peers` list with humans as `{handle, kind: "human", name}`; disabled users are absent.
8. (PR 2) In the Session, `hello` reaches Claude unwrapped (no envelope) and the agent's plain-text answer shows in the timeline with "@orlevi · raw" above the input; the agent's context says un-enveloped input is from an operator.
9. (PR 2) `/context` typed in the Session of an agent that has never started runs (its output renders as `command_output`); the `/` menu lists built-ins before the first start.
10. (PR 2) `/clear`, `/model`, `/new`, `/QUIT` are refused inline before sending, and by the server, each with its one-sentence reason; nothing is written to stdin.
11. (PR 2) Raw input typed while a turn is open is queued ("Runs after the current turn."), shows Cancel, and is written only after the turn's `result`.
12. (PR 2) After a process start, the composer's command list is the new process's (no 30 s stale window).
13. (PR 3) A turn started by your Chat message that ends with no `send_message` to you shows "@agent finished without replying · Open session" in your Chat and keeps it in history; one stopped by an interrupt says "stopped before replying"; one that errored says "hit an error before replying".
14. (PR 3) While the agent works on a turn that consumed your message, the Chat shows "@agent is working · 42s · Open session" with a ticking duration.
15. (PR 3) A leading `/context` in the Chat composer shows "Commands run in the Session · Open session" and, if sent anyway, is sent as message text.
16. (PR 3) The Chat composer's `@` adds agent recipients as chips; with two recipients the paperclip is disabled with "Files go to one agent at a time".
17. (PR 4) An agent calls `send_command({target: "@me-or-self", command: "/compact"})` mid-turn: the compact runs after its turn, then `@factory` delivers "Your /compact finished. Continue where you left off." and the agent continues on its own.
18. (PR 4) `send_command` to an agent that is not the caller or one of its direct reports is refused; a spawned agent's tool accepts only itself.
19. (all) Chat and Inbox hold at 390px, 1440px and 200% text with no horizontal page scroll; long names and long messages wrap or truncate as specified (§6.10).

## 3. Delivery: four stacked PRs

| PR | Branch | Content | Demo |
|---|---|---|---|
| 1 | `i1/1-handles-recipients` | §4: `handles` table, `@` senders, list `to`, `from_kind`, `recipients` column, no `@humans`, `list_peers` humans, CLAUDE.md org/messaging | An agent messages two recipients; envelopes list both |
| 2 | `i1/2-raw-session` | §5: raw input route and denylist, `operator_input`, Session composer raw mode, operator rule in CLAUDE.md, the `/context` fixes | `hello` and `/context` in the Session of a fresh agent |
| 3 | `i1/3-chat-inbox` | §6: routes, Chat view and composer, chat thread API, working/finished lines, `chat_changed`, Inbox chat rows, multi-recipient human send | Click an agent, chat, see the reply in the Inbox |
| 4 | `i1/4-send-command` | §7: `send_command`, self-compact continue notice | An agent compacts itself and continues |

PR 1 starts from the spec branch (`spec/i1-chat-and-session`, itself on `spec/i6-path-help`); each later PR from the previous. Between PR 1 and PR 3 the old Session page still sends enveloped messages through the old route (PR 1 changes only its sender attributes); PR 2 turns that composer raw, so between PR 2 and PR 3 a human messages an agent only through the Inbox reading pane's reply (which still uses the old route until PR 3 replaces it). That interim gap is accepted: the stack merges together.

## 4. PR 1: handles and recipients

### 4.1 `handles` table, claim-first (Q2, Q2b)

```
handles(
  handle     text primary key,      -- lowercase; the validators already force it, so no lower() index
  kind       text not null check (kind in ('agent','user','reserved')),
  claimed_at timestamptz not null default now()
)
agents.slug  → FK handles(handle)   (its unique index stays)
users.handle → FK handles(handle)   (its unique index stays)
```

- The schema migration inserts the reserved rows: `me`, `factory`, `scheduler`, `all`, `system`, `humans` (`humans` is added to `RESERVED_HANDLES`; the reserved list keeps one owner in `packages/shared/src/handle.ts`). That is part of the schema, not a backfill.
- **One function claims**, `claimHandle(tx, handle, kind)` in `apps/server/src/messaging/principals.ts`, used by sign-up, handle change, agent create and spawn:
  ```sql
  INSERT INTO handles (handle, kind) VALUES ($1, $2)
  ON CONFLICT (handle) DO UPDATE SET kind = excluded.kind, claimed_at = now()
    WHERE handles.kind <> 'reserved'
      AND NOT EXISTS (SELECT 1 FROM users  WHERE users.handle = handles.handle)
      AND NOT EXISTS (SELECT 1 FROM agents WHERE agents.slug  = handles.handle)
  RETURNING handle
  ```
  No row back means taken. An orphan (a claim whose user or agent insert then failed: email already used, an expired invite) is unreferenced and is simply reclaimed by the next claimer. Nothing sweeps orphans.
- **Agents** (agent service create, spawn service): claim then insert the agent in one transaction; no row back → `slug_taken` (`FieldError`, 409) / the spawn refusal; a `23505` on `agents.slug` is mapped the same way. `isNameTaken` is deleted.
- **Users** (better-auth before-hook on `/sign-up/email` and `/update-user` with a `handle`): the hook first validates with the same `handleSchema` (the endpoint's own validator runs after the hook, so the hook must not claim an invalid name), then calls `claimHandle` outside any transaction (better-auth owns the user insert). No row back → `HANDLE_TAKEN` (422). Keeping one's own handle on update is not a change. A handle change leaves the old claim unreferenced, so it is reclaimable; nothing frees it explicitly.
- **Accepted limit (K1):** two sign-ups racing for the same orphaned handle can both pass the claim; the second user insert then fails at `users_handle_unique` with better-auth's generic error. Rare (needs an orphan and a race).
- **Guard (owner flag):** if the claim path grows past this one statement plus the validate call, stop and take the trigger option back to Or. Before relying on it, the dev verifies in a test that the before-hook runs before better-auth's user insert on both paths (sign-up and update-user); if it doesn't, fall back to one trigger on `users` and say so in the PR.
- `resolveName(db, raw)` becomes one lookup on `handles` joined to `agents`/`users`: trim; a leading `#` → `{kind: "channel"}`; drop one leading `@`; `reserved` (including `humans`) → `{kind: "reserved"}`; `agent` → the row; `user` → `{userId, handle, disabled}`; nothing → `none`. The `ambiguous` and `humans` kinds are deleted.

### 4.2 `@` everywhere

- Envelope `from` for an agent is `@slug` (`entryOf` in `agent-runtime.ts:262`); `about="@slug"`; scheduled `by` is `@slug` or `@handle` (`authorLabel` in `event-store.ts:1047`). Every factory prose line that names an agent uses `@slug` (peer bodies, notices, task and schedule texts, tool errors). The `peer-body.ts` parser is updated with it.
- `#` in a target → refused "Channels aren't supported yet." Handles can't contain `#` already (patterns).
- `messageLookup`, inbox entries and the web read agent senders as `@slug`; the web's "agent senders are bare slugs" parsing (`message-block.tsx:112`, `outgoing-message.tsx:69-72`, `speaker-line.tsx`) is replaced by `fromKind` (§4.3), never by guessing from the sigil.

### 4.3 Envelope attributes (Q3)

`<factory-message from="@lead" from_kind="agent" kind="message" to="@orlevi @dev" urgent="false" id="…">`

- `from_kind` on every envelope: `human`, `agent` or `factory` (`@factory` and `@scheduler`). For a `task_comment` it is its author's kind.
- `to` only on `kind="message"` envelopes, always (one recipient too): the message's `recipients`, space-separated, in the order sent. Other kinds have one recipient by construction.
- `FactoryMessage`/`BatchRow` (`packages/harness/src/envelope.ts`) gain `fromKind` and `to?: string[]`; `one()` renders them; `runKey` includes `fromKind`. `envelopeSchema` gains `fromKind` and `to` so the UI never parses the XML.
- CLAUDE.md "How messages reach you": "`from` is the sender's handle (`@…`); `from_kind` says whether it is a human, an agent or the factory; `to` lists everyone a message was sent to."

### 4.4 `recipients` and list sends (Q4, Q5)

- `messages.recipients text[]` (handles with `@`), set on every `kind = 'message'` row: the **accepted** recipients of that send, in order, after de-duplication. One row per accepted recipient (agent: `to_agent_id`; human: `to_user_id` with its inbox item). "Also to" in the UI is `recipients` minus the viewer and the chat's agent. No group id (one record of one fact).
- `send_message` input: `{to: string[] (1–10), body, urgent?}`. A string is a validation error (no shim).
- Router: `send(from, to[], body, urgent, opts)` replaces `send`/`sendFromHuman`'s single target. Steps: resolve each target; collapse duplicates (by resolved principal); refuse per target (`none`, `reserved` with the `@humans` sentence below, `channel`, self, archived, terminated, disabled user, and for a human sender any human target); insert every accepted row in one transaction with the same `recipients`; hand each agent row over as today (human sender: awaited; agent sender: enqueued); publish `inbox_changed` to the human recipients only (`publishToUser`), and `chat_changed` (§6.5) from PR 3.
- Result (agent): `{results: [{to: "@orlevi", status: "inbox", id}, {to: "@dev", status: "queued", recipient_status: "working", id}, {to: "@ops", status: "pending", id, note: "@ops is errored; your message is delivered when a human restarts it."}, {to: "@x", status: "refused", reason: "@x was terminated and can't receive messages."}]}`. All refused → a tool error listing each reason, one line each. More than 10 → tool error "Send to at most 10 recipients at once."
- `@humans` (or `humans`) as a target: "`@humans` isn't a handle. Message people by handle; list_peers lists them."
- `factory` notifications to every user (a top-level agent errored) keep `to_all_humans` and their fan-out (kind `system` only); nothing else writes it. `createHumanMessage`'s `"all"` target is limited to `kind = 'system'`.
- Human sends (PR 3's route, §6.6) dedupe on `(from_user_id, client_message_id, to_agent_id)`: the U3 unique index widens to include `to_agent_id`.

### 4.5 `@humans` removed (Q6)

- Task comments: `humans` is a reserved name, so a `@humans` mention goes through the existing reserved path: the comment posts and `not_reached` lists `@humans` with reason `reserved`. In `comment_task`'s result the reserved reason for `humans` reads "`@humans` isn't a handle. Mention people by handle; list_peers lists them." Deleted: the `humans` outcome flag, `["@humans"]` in `mentioned_humans`, `case "humans"` (task-service ~L240, L336-343, L919) and the `inbox_changed` publish that served it.
- UI: the inbox's "mentioned @humans" copy and notification wording, `speaker-line`'s "All humans", the `@` completion's `@humans` row.
- Agent-facing prose: CLAUDE.md drops every `@humans`; spawn-service failures (`spawn-service.ts:76, 144, 163, 217, 303`) say "ask your manager" (spawned agents and reports) or "ask a human (list_peers lists them)" (top-level spawners), chosen by whether the caller has a manager. A grep test fails the build on `@humans` in `apps/server/src` outside tests and the reserved list.

### 4.6 `list_peers` and "Your org" (Q16)

- `list_peers(scope?)` → `{peers: [{handle: "@team-lead", kind: "agent", displayName, description, relation, status}, …, {handle: "@orlevi", kind: "human", name: "Or Levi"}]}`: agents first in today's order (`manager`, peers, reports, then `other` with `scope: "all"`), then humans by name then handle. Disabled users are left out (`Neighborhood.humans()` filters `disabled_at IS NULL`). Human names pass through `inline()`.
- CLAUDE.md "Your org" gains "Humans: `@orlevi` (Or Levi), …", at most 25 then "and N more; call mcp__factory__list_peers", sorted like `list_peers`. The file is still a pure function; it changes when users are added or renamed, which only matters at the next process start.
- CLAUDE.md messaging, rewritten once (each rule once, with its reason): "Send with `mcp__factory__send_message` to one or more handles (`@agent` or `@person`, up to 10); every recipient sees the full list. `list_peers` lists the agents and the humans." … "Message a human only when you need a decision or have something they asked for: they read every message." "Address people by handle; there is no address for all humans."

## 5. PR 2: raw Session input and the `/context` fixes

### 5.1 Route (Q7)

`POST /api/agents/:slug/input { text, clientMessageId }`, human session only; replaces `POST /api/agents/:slug/commands`. The `GET …/commands` list stays (autocomplete only).

Server steps, in order:
1. `text` is non-empty after trim and ≤ 64 KB (`MAX_BODY_BYTES`), else 400.
2. If `text.trimStart()` starts with `/`: it is a **command**. It must be one line (no character `breaksLine` rejects), else 400 "A command must be one line.". Its first token, lowercased, is looked up in the shared denylist (§5.2): denied → 422 `command_denied` with the entry's reason. `compact` (and only that name) → the Compact flow (`rt.compact`, focus = the rest, `MAX_FOCUS_CHARS`), unchanged. Otherwise the text is sent byte-exact.
3. Otherwise it is **free text**: `<factory-message` tags are neutralised with the envelope's own escaper (`envelope.ts` exports `neutraliseEnvelopeTags`, the function `body()` uses; one function at both points, Q8); every other byte is sent as typed.
4. `rt.rawInput({text, userId, byHandle, clientMessageId})`: one in-memory `RawEntry` (today's `CommandEntry`, renamed), queued, held until no turn is open, written with `proc.command(text)` (renamed `proc.raw(text)`: one stream-json user line, no envelope), a barrier until its turn ends (`commandInFlight` → `rawInFlight`), retry-deduped by `(userId, clientMessageId)` as today. Wake reason `command` → `raw`. An errored agent holds it until a Restart and never starts a recovery (`raw` is not in `ERRORED_WAKES`). Queue item kind `command` → `raw`; its own Cancel (sender only, no Undo) as today. 202 with the queue item.
5. When written, the runtime appends `operator_input{text, by: "@orlevi"}` (persisted, the audit record, Q7) in place of `control{cmd: "command"}` (the `command` value leaves the control enum). `text` is what was written.

Deleted with it: `BUILTIN_ALLOWLIST`, `REFUSED_BUILTINS`, `allowedCommands`'s built-in filtering, `findCommand`, `runCommandBodySchema`, `commandText`'s use in dispatch, the composer's command mode, `postCommand`.

Queued raw input lives in memory: a factory restart drops it (as commands today). Each written input is in the session log.

Mid-turn timing is not the runtime's guess: raw `/commands` are never absorbed (U3 spike `slash-raw-mid-turn`); plain text written mid-turn **is** absorbed into the running turn (spike `partial-midturn-message-absorbed`). Holding all raw input until no turn is open keeps "one input, one turn" for both.

### 5.2 Denylist (Q9)

One constant in `packages/shared/src/commands.ts`, the rule's only owner, read by the server and the composer:

| Names (case-insensitive) | Reason shown |
|---|---|
| `clear`, `new`, `reset` | "/clear isn't available: each agent keeps one session." |
| `model`, `effort` | "The model and effort come from the agent's template." (I2 updates it when its form lands) |
| `login`, `logout` | "Credentials are managed in Settings → Credentials." |
| `exit`, `quit` | "The factory runs this agent's process." |
| `resume`, `continue` | "The factory runs this agent's process." |

`/{typed}` in the reason uses the name as typed. Aliases are rows of the constant, never resolved through the stored command list. Everything else is allowed (ADR 0022), including built-ins U3 refused. Unknown commands reach Claude, which passes them to the model as text (spike: `/nonexistent-cmd`).

### 5.3 Command list and the `/context` fixes (task §5)

Root cause (2026-11-22): before an agent's first start nothing is stored, so `GET /commands` returned template skills only, no built-ins; the composer found no row and sent `/context` as an enveloped message. Also: Enter sent text while the list loaded or was empty, a pasted `/command` never opened the menu, and the browser kept the list up to 30 s after a start.

Fixes:
- **Built-ins before the first start.** `packages/shared/src/claude-builtins.ts`: the 55 `builtin: true` entries of Claude Code 2.1.327's `initialize` answer (`packages/harness/fixtures/u3/control-initialize-commands.jsonl`), generated once by a script kept next to it, as `{name, description, argumentHint, aliases}`. `GET /commands` with nothing stored returns those built-ins minus the denylist plus the template's skills, `source: "template"`; once stored, the session's list minus the denylist. `stale` as today.
- **Invalidate on start.** The Session view, which is subscribed to the agent's stream, invalidates `["agent-commands", slug]` when a `process_started` session event arrives; the server stores the new list once `initialize` answers (≤ 5 s later), so the invalidation refetches when the menu next opens and the `watch` in `commandSource` re-reads it. `COMMANDS_STALE_MS` stays for idle refetches only.
- **Never a silent text send.** With raw input the Session composer sends everything raw: no path turns `/…` into an enveloped message. A list that is loading, empty or failed affects only the menu.
- Tests, one per failure mode found: never-started agent lists `context`; the list after `process_started` is the new one; Enter on `/context` while the list is pending POSTs `/input`, not a message; a pasted `/context` + Enter POSTs `/input`; `/context` with an empty list POSTs `/input`.

### 5.4 Session composer (Q10)

- The shared `Composer` in raw mode: placeholder "Type to Claude directly · / for commands"; hint line while a turn is open: "Runs after the current turn."; Enter sends (⌥Enter is Enter); no attachments (paste or drop of a file: "Files can be sent from the Chat"); no urgent; Stop as today.
- `/` menu: autocomplete only. Accepting a row inserts `/name ` into the text (no chip, no command mode). Rows are the allowed list; denied names never appear.
- A typed denied command shows its reason on the composer's reserved note line as soon as the first token is complete (the shared constant), and Send is disabled-shaped with the reason as its tooltip; the server refuses it too (422 shown on the same line).
- Optimistic block: a "Sending" raw block in the queue area keyed by `clientMessageId` until the 202's queue item replaces it, as U3 §13.2. Drafts: `of-draft:session:<slug>`. ↑ recall: your newest `operator_input` in the loaded timeline.
- Timeline: `operator_input` renders as a speech row with the speaker line "@orlevi · raw" ("You · raw" for you), the text in mono when it starts with `/`, prose otherwise, with the §7.6 clamp. `command_output` stays as U3.

### 5.5 The operator rule

CLAUDE.md, in "How messages reach you": "Input that isn't inside a `<factory-message>` envelope comes from a human operator watching your session. Answer it in plain text in the session, not with `send_message`." The answer reaches the manager as `member_update` like all text (ADR 0005 unchanged).

## 6. PR 3: Chat and Inbox

### 6.1 Routes (Q11)

- `routes/_app/agents.$slug.tsx` becomes the layout: loader as today, the shared header (§6.2), Agent details panel and sheet, `<Outlet/>`.
- `agents.$slug.index.tsx`: `beforeLoad` redirects to `/agents/$slug/chat` (replace).
- `agents.$slug.chat.tsx`: `?message=<id>` (scroll to and highlight, DESIGN.md deep-link arrival).
- `agents.$slug.session.tsx`: `?event=` and `?message=` (today's).
- Every link that opened an agent (sidebar rows, palette, Agents page, inbox, task and schedule links to an agent) goes to `/chat`; links to a session event go to `/session?event=`. Session row menus gain "Open in chat" on messages between you and this agent.

### 6.2 Shared header

The header (`SessionHeader`, extracted to `features/agents/agent-header.tsx`) shows the avatar, name, status badge and the one live fact, as today, for both views. Its actions gain one ghost button: in Chat "Session" (lucide `SquareTerminal`), in Session "Chat" (`MessageSquare`); icon-only below ~24rem container width with the label as `aria-label` and tooltip. `]` and the ⋯ menu as today. The live-status line's "Open session" links go to `/session`.

### 6.3 Chat thread API

`GET /api/agents/:slug/chat?before=<cursor>&limit=50` (human session; cursor = `createdAt|id`, newest first, served oldest-first in the page):

```ts
type ChatEntry =
  | { kind: "message"; id: string; from: string; fromKind: "human" | "agent";
      body: string; recipients: string[]; urgent: boolean; createdAt: string;
      state: "pending" | "delivered" | "rejected" | "cancelled";
      attachments?: MessageAttachment[]; clientMessageId?: string }
  | { kind: "turn_outcome"; turnId: string; endedAt: string;
      outcome: "no_reply" | "stopped" | "error" };
type ChatPage = { entries: ChatEntry[]; nextCursor: string | null;
                  working: { turnId: string; startedAt: string } | null };
```

- Messages: `kind = 'message'` rows from you to this agent (`from_user_id = me, to_agent_id = A`) and from this agent to you (`from_agent_id = A, to_user_id = me`). Body as stored, attachments as stored. Cancelled rows are left out; the "Message cancelled. Undo" line comes from the client's cancel overlay (§6.4).
- Turn outcomes: originless turns of A, ended, that consumed one of your rows (`messages.delivered_turn_id = turn.id`, `from_user_id = me`; S10 stamps the starting batch at close and absorbed rows at write), with no `message` row from A to you created between the turn's `started_at` and `ended_at`. `outcome`: `stopped` when `terminal_reason` is `aborted_tools` or `aborted_streaming`, `error` when `is_error`, else `no_reply`. Placed at `endedAt`.
- `working`: from the runtime (in memory): A's open turn if it consumed one of your rows (in `awaiting` or stamped with the open turn). Null otherwise.
- An index on `messages (to_user_id, from_agent_id, created_at)` and the existing `(to_agent_id, state, created_at)`/`from_user_id` paths serve it; the plan checks the query plan on the 214-agent dataset.

### 6.4 Chat view (`features/chat/`)

- One column, max 52rem like the session, newest at the bottom, stick-to-bottom on intent and one Jump to latest (U3 §8), Load earlier at the top.
- Each message is the speech tier of the session timeline (DESIGN.md → Session timeline): speaker line (avatar 20, name, muted `@handle`, time; "You" for you) and a card; agent text renders as markdown (`.prose-of`, demoted scale). When `recipients` minus you and this agent is non-empty, the speaker line ends with a muted "also to @dev, @ops" (truncates with the full list in its tooltip). No tool rows, no envelopes, no member updates.
- Your pending rows show in place, muted, with "Waiting for @ceo's current step" and Cancel; Cancel → "Message cancelled. Undo" in place (U3 §6.4 routes and overlay).
- **Working line** under your newest message while `working` is set: "@ceo is working · 42s · Open session" (duration ticks on whole seconds from `working.startedAt`, the activity line's formatter; "Open session" links to `/session`). No tool detail.
- **Outcome line** at its turn's place: "@ceo finished without replying · Open session" / "stopped before replying" / "hit an error before replying", muted 13px system tier, kept in history. "Open session" links to `/session?event=<turn_end seq>`.
- Read-only (terminated, archived): the composer is replaced by the read-only line as in the session.
- Live rows fade in by the session's rule (opacity 150ms, never on load); the working line appears and leaves without motion; the outcome line replaces the working line in place (no fade).

### 6.5 Live updates (Q14)

- New per-user ws frame `chat_changed{agent: slug}` (`publishToUser`), published when a `message` row between that user and that agent is created or changes state (delivered, cancelled, restored, rejected), and when a turn that consumed one of that user's rows starts or ends (the runtime knows the human senders of `awaiting` and stamped rows).
- The Chat query (`["chat", slug]`, infinite) refetches its newest page on the frame and merges by id; older pages stay. Status frames (already broadcast) drive the ticking duration.

### 6.6 Chat composer (Q5, Q13)

- The shared `Composer` with `draftKey` `of-draft:chat:<slug>`, placeholder "Message {name}", Enter sends, ⌥Enter sends urgent (interrupts, as today), attachments (§13.5 of U3) when there is one recipient, optimistic block, recall (↑: your newest chat message).
- **Recipients:** the chat's agent is always a recipient (shown as the first chip, not removable). `@` completion lists live agents only (no humans, no `@humans`); accepting a row adds a chip above the textarea and removes the typed `@token`; Backspace in an empty box removes the last added chip; max 10. A typed `@name` not accepted stays text.
- With more than one recipient the paperclip is disabled with the tooltip and accessible description "Files go to one agent at a time"; adding a recipient while files are attached is refused with the same line on the reserved note line.
- Leading `/`: sent as text. The note line shows "Commands run in the Session · Open session" only when the first token matches a known command for this agent or the command list hasn't loaded.
- Route: `POST /api/messages {to: string[], body, urgent, clientMessageId, attachments?}` (human session), replacing `POST /api/agents/:slug/messages`. 202 `{results: [{to, status: "queued" | "refused", id?, item?, reason?}]}`; one refused recipient shows its reason on the note line; the others are sent. Attachments with more than one `to` → 422.

### 6.7 Inbox (Q12)

- `GET /api/inbox` returns `{chats: ChatRow[], items, nextCursor}`; `items` no longer contains `kind: "message"` entries (they are counted as chats). `ChatRow = {agent: {slug, displayName}, unread: number, latest: {messageId, preview, createdAt, urgent}}` for every agent with unread `message` items for you, unpaginated (at most one per agent). `kind: "message"` inbox items stay the unread record.
- The list interleaves chat rows with items by `latest.createdAt`; a chat row older than the oldest loaded item waits until a page reaches its time or there are no more pages (accepted quirk).
- Chat row: avatar 16, "@ceo" name line with "· 3 new", the latest preview on the second line, urgent marked as items are. Click / Enter: on wide screens selects it (`?item=chat:<slug>`) and the reading pane hosts the Chat for that agent (header, thread, composer); below 1024px it navigates to `/agents/<slug>/chat`.
- Read: only opening the Chat (route or pane) marks the agent's messages to you read (`read-from`, today's rule moved from the Session view to the Chat view; the Session never marks). A read chat row leaves the list, except the selected one, which stays (shown read) until the selection moves. Mark all read and its Undo cover chat items as today. Sidebar per-agent unread counts unchanged.
- The reading pane's old "message" content (session excerpt + reply composer) is deleted; mentions and task events keep their panes.

### 6.8 Sidebar and palette

Agent rows link to `/chat`; the unread count stays. The palette's agent results open the Chat; an action "Open session" is added for the current agent.

### 6.9 What leaves the Session view

The Session view keeps everything it had except: reading read state (moved to Chat), the enveloped composer (now raw, PR 2), the inbox-reply role. Its header shows the "Chat" button.

### 6.10 Long content and small screens

- Names: speaker lines truncate name and handle before the time; "also to" truncates into its tooltip. Recipient chips `max-w-[12rem]`, middle-truncated handles, wrap to at most 2 rows then "+N" expanding in place (the attachment chips' rule).
- Message bodies: the session's clamp (40 lines or 4,000 characters, "Show all") for your messages; agent replies never clamp (as agent text).
- 390px: the header's Chat/Session button is icon-only; the composer per U4's phone composer. 200% text: no horizontal scroll (U4's overflow check runs on Chat and Inbox).

## 7. PR 4: `send_command` (Q15)

- Registered for every agent. Persistent: `send_command(target, command)`; targets: the caller (`"me"` or its own handle) or a direct report (`reports_to = caller`, spawned agents included). Spawned agents get a version whose description says "only yourself" and that refuses any other target.
- `command`: starts with `/`, one line, ≤ 64 KB, the shared denylist (same reasons). `/compact [focus]` → the Compact flow with `by: "@caller"`; anything else → a `RawEntry` with `by: "@caller"` (no `userId`; agents never cancel).
- Result: `{target: "@dev", status: "queued", note: "Runs when @dev's current turn ends."}` (or "Runs now." when the target is idle; a hibernated target is woken with reason `raw`/`compact` and the note says "Wakes @dev to run it."). Self: "Your /compact runs when this turn ends. Write down where you are before you end the turn."
- Refusals (tool errors, one sentence): "@x isn't you or one of your direct reports.", a terminated or archived target as for messages, a denied command's reason, "You already have /compact queued." (at most one pending self-command, by entry `by` and target).
- **Self-compact continue:** when a compact whose `by` is the agent itself ends (`turn_end` with `command === "compact"`, or `compact_failed`), the runtime adds a `compact_continue` notice: success "Your /compact finished. Continue where you left off."; failure "Your /compact didn't run (see the Session). Continue where you left off." (fixed text: Claude's own failure text is process output and is never quoted, Q15 condition). The notice is not passive, so it starts a turn. A report compacted by its manager gets no notice. Other self-commands run as their own turn with no notice.
- The `control{cmd: "compact"}` and `operator_input` events carry `by: "@lead"`; the timeline shows the agent as the speaker ("@lead · raw").

## 8. Server and shared changes by PR

| PR | Change |
|---|---|
| 1 | `handles` table + FKs + reserved rows (migration); `claimHandle`; `isNameTaken` gone; `resolveName` on `handles`; auth before-hook claims; agent and spawn create claim in their transaction; `RESERVED_HANDLES` + `humans`; envelope `from_kind`, `to`, `@` agents, `about`/`by` as `@`; `messages.recipients`; widened client-id unique index; Router list send and per-recipient results; `sendMessageToolSchema.to` array; `list_peers` `peers`; `Neighborhood.humans()` without disabled users; task-service `@humans` branches deleted and the reserved text; CLAUDE.md org and messaging; `@humans` prose sweep and its grep test |
| 2 | `POST /input`; shared denylist and `claude-builtins.ts`; `RawEntry`, `rawInFlight`, wake reason `raw`, queue kind `raw`; `operator_input` event; `neutraliseEnvelopeTags` export; `GET /commands` built-ins before start; `/commands` POST and the allowlist code deleted; CLAUDE.md operator rule |
| 3 | `GET /api/agents/:slug/chat`; `chat_changed` frame and publishers; runtime `workingFor(userId)`; `POST /api/messages`; `POST /api/agents/:slug/messages` deleted; inbox `chats`; `read-from` unchanged; index on `messages (to_user_id, from_agent_id, created_at)` |
| 4 | `send_command` tool (per-caller registration); `compact_continue` notice type; one-pending-self-command check |

## 9. DESIGN.md amendments

1. **Layout** (PR 3): "An agent opens as its Chat; its Session is one ghost button away in the header."
2. **Components → Chat** (new, PR 3): "The Chat is the speech tier of the session timeline and nothing else: speaker lines and cards, no tool rows. 'Also to' names the other recipients after the speaker. A working line ('@ceo is working · 42s · Open session') sits under your newest message while a turn that read it runs, and becomes, in place, a muted outcome line when the turn ends without a reply. Recipients are chips above the composer's text; the chat's own agent is the first and can't be removed."
3. **Components → Composers** (PR 2, PR 3): the Session composer writes raw input: "A session composer sends what you type to Claude unwrapped; a denied command says why on the note line before you send. It has no attachments and no urgent send." The Chat composer is the one that interrupts with ⌥Enter.
4. **Navigation** (PR 3): "Agent rows open the agent's Chat."
5. **Layout → Two panes** (PR 3): "An unread chat is one Inbox row; selecting it shows the Chat in the reading pane."

## 10. Product-doc edits (gitignored, applied in the main checkout by the dev of the PR named, listed in its description)

- PR 1: `concepts/message.md` (addresses, envelope, `from_kind`, `to`, list sends, recipients, no `@humans`, handles table), `concepts/reporting-line.md` (`list_peers` humans), `architecture/factory-mcp.md` (`send_message`, `list_peers`, `comment_task` reserved text), `architecture/context-assembly.md` (org humans, messaging rules), `architecture/data-model.md` (`handles`, `recipients`, index), `behavior/tasks.md` (mentions), `behavior/inbox.md` (no `@humans`).
- PR 2: `concepts/session.md` (raw input, denylist), `behavior/agents-and-sessions.md` (Session composer), `architecture/harness-driver.md` (`raw(text)`, `operator_input`), `architecture/context-assembly.md` (operator rule).
- PR 3: `behavior/agents-and-sessions.md` (Chat default, header buttons), `behavior/inbox.md` (chat rows, read on Chat), `concepts/session.md` ("session is the DM" moves to Chat), ADR 0003 note → done.
- PR 4: `architecture/factory-mcp.md` (`send_command`), `concepts/reporting-line.md`, `concepts/message.md` (`compact_continue`).

## 11. Testing

- **Unit/shared:** denylist matching (case, aliases, leading spaces, one-line rule); `neutraliseEnvelopeTags` shared; envelope rendering with `from_kind`/`to`; `resolveName` kinds incl. `#`, `humans`, disabled; per-recipient result building; `claude-builtins` generator output matches the fixture.
- **Server (DB tests run only in CI; the local Postgres role is unavailable):** claim-first (agent/user collision both orders, concurrent agent creates, orphan reclaim after a failed sign-up, reserved never reclaimed, handle change frees by being unreferenced, the before-hook order on both auth paths); list send (dedupe, self, terminated alone, all refused, >10, `#`, `@humans`, disabled human, recipients column, inbox items per human, client-id dedupe per agent); `list_peers` shape; CLAUDE.md snapshots; `/input` (free text unwrapped and neutralised, command byte-exact, denied 422 with nothing written, multi-line command 400, compact flow, held until turn end, written after `result`, `operator_input` persisted with `by`, errored holds, cancel); `GET /commands` before first start; chat query (both directions, other humans' threads excluded, outcomes `no_reply`/`stopped`/`error`, a reply in the turn suppresses the outcome, `working` incl. absorbed rows); `chat_changed` publish points; inbox `chats`; `send_command` (self, report, spawned report, non-report refused, spawned self-only, denied, one pending, hibernated target woken, continue notice on success and failure with fixed text, no notice for manager-initiated compact).
- **Web component:** Chat rows, also-to, pending/cancel, working and outcome lines, recipients chips (add, Backspace, max, paperclip disabled), `/` hint rule; Session raw composer (no chip, denied inline, paste + Enter, list loading + Enter); inbox chat rows (interleave, stay-while-selected, leave after read, mark all read); redirect and links; render counts for live Chat updates (memoized rows, stable references, U1's `timeline-perf` pattern).
- **Browser evidence** (last plan tasks): the U4 harness (`docs/product/ui-review/u4-evidence/harness`, `run.sh` lock, fake Claude only, one pass at a time), Chromium and WebKit headless, for every acceptance criterion above. The fake learns two things: an `$mcp {tool, args}` directive that calls the factory MCP with its own token (`OPEN_FACTORY_AGENT_TOKEN`, URL from `.mcp.json`), so it can `send_message` and `send_command`; and answering plain un-enveloped text (it already auto-replies to any user line).

## 12. Follow-up issues

1. Raw input survives a factory restart (persist queued raw input) if losing it bites.
2. `/model` and `/effort` refusal copy points at I2's form when it lands (I2 owns it).
3. Chat: find in chat (with #105).
4. Re-verify the built-ins snapshot when Claude Code moves past 2.1.327 (a stale snapshot only affects the menu before a first start).

## 13. Decisions

Proxy answers Q1–Q16 (and Q2b) and their alternatives are in the decisions issue. Tech-lead decisions made while writing:

- **D1** `recipients` holds the accepted recipients only, so an envelope never lists someone who didn't get it.
- **D2** Chat outcomes distinguish `stopped` and `error` from `no_reply`, using the turn row's `terminal_reason` and `is_error`, so the line is literally true.
- **D3** `working` comes from the runtime's memory (the open turn's `awaiting` or stamped rows), because the starting batch is stamped only at close.
- **D4** The free-text escaper is exported from `envelope.ts` and reused, not copied (Q8).
- **D5** Built-ins before the first start come from a generated snapshot of the recorded `initialize` fixture.
- **D6** A handle change frees the old handle by leaving it unreferenced (reclaimable by `claimHandle`), so no after-hook is needed.

Rated 3/5 or lower, for Or:

- **Q2/Q2b** (3/5): claim-first `handles` with FKs and a reclaimable-orphan upsert instead of triggers; fallback to one `users` trigger if the before-hook order fails verification.
- **Q6** (3/5): `@humans` in a task comment posts and reports `not_reached: reserved` rather than refusing the comment.
- **Q11** (3/5): ghost Chat/Session buttons in the header rather than a segmented control.

## 14. Risks and unverified

- **Better-auth hook order** is read from the code, not yet tested; PR 1's first server test proves it (§4.1).
- **Raw plain text mid-turn** is absorbed by Claude (spike), which is why all raw input waits for the turn to end; a raw line written in the gap between `result` and the runtime seeing it is the same race commands have today.
- **Unknown or newer built-ins**: the denylist covers today's names and aliases; a new alias of a denied command added by a later Claude Code passes until a line is added.
- **`/compact` failure reason** is never quoted (it is process output), so the agent learns only that it failed.
- Real-Claude behaviour of `send_command` self-compact (compact then a notice-started turn) is built from the recorded `manual-compact` sequence; a live run is for Or to do or waive.
