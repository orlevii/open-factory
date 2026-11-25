# I8 Quality of life: Technical Design

Task: [I8 Quality of life](../../product/roadmap/v0.0.2/i8-quality-of-life.md) (gitignored `docs/product/`, read from the main checkout). Issues: #102 (first-run hint), #47 (loop guard), #55 (worktree cleanup). Decisions: ADR 0021 (the guard counts per pair), ADR 0022 (Chat), ADR 0025 (`manage_org`), ADR 0027 (credential expiry), ADR 0028 (pre-release, no compatibility). Builds on I1 (Chat, chat rows in the Inbox, list sends, `operator_input`, `useInboxNotifier` reading chats), I3 (the `credential` inbox item, the Add credential sheet), I7 (the "Can manage the org" switch, `org_action` frames), I4 (form fields) and U1 §10 (the browser-notification switch).

Every question went to the owner proxy (`owner-i8`), and the spec was reviewed through five lenses (self, Taste, Apple, Emil, Break UI); findings that changed an answer went back to the proxy (R1–R10). The log of questions, alternatives, answers and certainty is in the decisions issue. §11 lists what is rated 3/5 or lower.

**Revalidated on I5/I7 (2026-11-25)** against `origin/i7/3-restart` (I1–I7 merged): I1 already ships `operator_input.byKind` (D4 is delivered, no schema change) and the chats/items split (§5.1); `openSheetForResult` already opens Add credential as a self-serving top-level layer (§4.4); `createAgentBodySchema` still strips `manageOrg` (§4.5 stands); I5 adds a `plugin_not_loaded` human notice that never notifies (§5.1); the cleanup notice links to the session without a `seq` (§7.6). The plan's "Revalidated" section lists every change.

ADR 0028: nothing here keeps old shapes alive. Schema changes ship as the generated migration only (plus the hand edits to hand-written constraints named in §6.2); **reset local data** if a migration refuses a non-empty table. The worktree path convention changes without a note for the old layout.

## 1. Goal

Four independent slices:

1. **First-run steps.** A fresh factory's Inbox says what to do first.
2. **Desktop notifications.** Only when a human is addressed or needed, never with message text, one per burst.
3. **Loop guard.** Two agents talking to each other with no human in between are held after a threshold until a human resumes them.
4. **Spawned-agent cleanup.** A terminated spawned agent's worktrees are removed with its workspace; its branches are deleted only when provably landed.

## 2. Acceptance criteria

"PR n" says where each lands (§3).

1. (PR 1) A factory with no agent rows shows "Set up your factory" with three steps on the Inbox (in the reading pane from 1024px with nothing selected, in the list column below); each opens its sheet; a finished step shows a check and stays clickable; the block disappears without a reload when the first agent is created in this browser, and on the next focus or frame in another browser.
2. (PR 1) The steps show while the factory has never had an agent: archived and terminated agents count. The first paint of a fresh factory's Inbox is the steps, never "Nothing in your inbox." first.
3. (PR 1) "Sign in to Claude" opens Add credential as a top-level sheet; done once any credential exists. "Create a template" opens New template; done once any template exists.
4. (PR 1) The New agent and Edit agent sheets show "Can manage the org" with help text that says what to do with it.
5. (PR 2) With notifications on and the tab hidden, an agent's Chat message to you raises one notification, title "Ada", body "1 new message"; two more before you read replace it silently ("3 new messages"); clicking focuses the tab on that Chat at the first unread message.
6. (PR 2) No notification ever carries message text; task events, factory restarts, member updates and cleanup notices never notify.
7. (PR 2) A mention, a top-level agent's error and a credential expiring each notify once per burst and open the comment, the agent's Session and the credential; opening an item from its notification marks it read as an Inbox click does.
8. (PR 3) Two agents scripted to ping-pong are held when both directions pass the threshold; the sender's tool result says `held` with the reason; one Inbox notice "@a and @b exchanged 22 messages in 3 minutes; further messages between them are held." with "Resume @a and @b" reaches every human; each manager that isn't the other agent gets a factory message; a desktop notification fires.
9. (PR 3) Resume turns the held messages pending in order and hands them over, closes the hold, resets the window, and every pane, after any reload, shows "Resumed by you · 14:02 · 4 messages sent on" (another human: "Resumed by @or · 14:02 · 4 messages sent on"); the row label turns from "Held" to "Resumed".
10. (PR 3) At 390px the hold row opens its pane full-width at `/inbox?item=<id>` with Back, and Resume works there; the notification lands there too.
11. (PR 3) A human message, a human's raw Session input, or a human's status change on a task assigned to either agent resets the pair's window; no agent action does (an agent marking a task done included); a task comment between them counts toward it and, when held, is still posted on the task.
12. (PR 3) Both thresholds are editable in Settings → Factory and apply to the next counted message.
13. (PR 4) Agents are told to create worktrees under `<repo>/.worktrees/.agents/<slug>/<branch>`.
14. (PR 4) When a terminated spawned agent's workspace is deleted, `<repo>/.worktrees/.agents/<slug>/` is removed in every registered project that has it, with exactly those worktrees' metadata; a branch whose commits are all on a remote-tracking ref or the default branch is deleted; any other branch is kept and listed in one notice to the spawner (if live) and the Inbox ("web: kept `feat/x` (3 commits not pushed or merged)", §7.6).
15. (PR 4) The cleanup never runs a hook, fsmonitor or a working-tree read, never follows a symlink out of `.worktrees/.agents/<slug>/` or `<common-dir>/worktrees/<id>`, never touches another worktree's metadata, and never deletes the default branch or a branch checked out elsewhere (tests plant each; the guarantee assumes no concurrent writer swaps a directory mid-removal, §12).

## 3. Delivery: four stacked PRs

| PR | Branch | Content | Demo |
|---|---|---|---|
| 1 | `i8/1-first-run` | §4 | Fresh factory → steps → create an agent → steps vanish |
| 2 | `i8/2-notifications` | §5 | Hidden tab, an agent replies, one notification opens the Chat |
| 3 | `i8/3-loop-guard` | §6 | Two fake agents ping-pong, get held, Resume sends them on |
| 4 | `i8/4-spawn-cleanup` | §7 | A terminated spawned agent's worktree and merged branch go; an unpushed branch is kept and listed |

None of I1–I7 is on `main` yet, so every I8 branch starts from the head of the I7 implementation chain (its last branch). Stacked only where there is a real dependency (Q1): **PR 3 stacks on PR 2** (the hold notice renders in the notifier and the pane PR 2 reshapes); **PR 4 stacks on PR 3** (its notice reuses PR 3's full-width notice pane and `notice` field). PR 1 starts from the I7 head and can merge in any order after it.

## 4. PR 1: First-run steps (#102, Q11, Q12, R5, R6)

### 4.1 Data

`GET /api/setup` (human session) → `{ hasCredential: boolean, hasTemplate: boolean, hasAgent: boolean }`: three `exists` queries, any `credentials` row, any `templates` row (valid or not, Q12), any `agents` row (archived, terminated and spawned included, Q11). No stored flag. (D1: the sidebar's agent list leaves out ended agents, so it can't answer Q11.)

The web query `["setup"]` (staleTime 0, refetched on window focus):

- is ensured in the `/inbox` route loader in parallel with the inbox's first page (`Promise.all`), stays fresh for 30 s while `hasAgent` is false and forever once true, so the first paint knows which view to draw; while it is pending the list holds its empty line (never "Nothing in your inbox." first); on error the Inbox shows its usual states;
- is invalidated by this browser's create mutations (credential, template, agent: the sheets' `onSuccess`) and by the I7 `org_action` frame (agent-made creates). A human's create in another browser publishes no frame today; the focus refetch heals it (AC1 says so).

### 4.2 Where and when

- While `hasAgent` is false:
  - **From 1024px, nothing selected:** the steps render in the reading pane (max 40rem, the pane's gutters) in place of "No item selected."; the list column shows its items or "Nothing in your inbox.". Selecting an item shows it in the pane as usual; clearing the selection brings the steps back.
  - **Below 1024px:** the steps sit at the top of the list column; inbox items (an I3 credential notice, say) follow below; with no items there is no empty line.
- When `hasAgent` turns true the block leaves without animation. If the pointer is over the list column, or focus is inside the list column, the change waits until both have left (I1's list-stability rule), then applies at once. Focus inside the block itself does not hold it: the block leaves, and focus moves to the first Inbox row, or to the page heading when the Inbox is empty, before the next paint.
- Every signed-in user sees it (there are no roles). No dismiss.

### 4.3 The block

```
Set up your factory
 1  Sign in to Claude                                        ›
    Connect the Claude account your agents run on.
 2  Create a template                                        ›
    A template is a role: persona, skills, tools and model.
 3  Create an agent                                          ›
    It runs a template in its own session. Give it "Can manage the org" to have it build the rest.
```

- Heading: DESIGN's State heading role (Archivo 1rem/1.25rem, 600), an `h2` under the page's "Inbox" `h1`.
- Each step is one `<button>` row, `min-h-14` (never a fixed height), full width of its container: a 1.25rem step marker top-aligned with the title (the number in Geist 0.8125rem `tabular-nums`, muted, inside a 1px ring; when done, a `Check` icon in the success token), the title (0.875rem, 500) on line one, the description (0.8125rem, muted) on line two, wrapping, never truncated; a trailing `ChevronRight`, muted, vertically centred. Hover, press and inset focus as DESIGN's Rows (full-width rows never scale). Order never changes; done steps stay clickable (adding a second credential is legitimate). The check appears instantly (status changes don't animate).
- Accessible: `<section aria-labelledby>`; the rows are an ordered list; each row's accessible name is "Step 1 of 3, Sign in to Claude, done" / "…, not done", its description linked by `aria-describedby`.
- At 320/390px and 200% text the rows wrap; nothing scrolls horizontally.

### 4.4 Sheets

- Step 1 opens Add credential with the existing `openSheetForResult({ kind: "add-credential" }, onDone)` (`features/sheets/sheet-store.ts`): with no sheet open it opens as the parent layer and serves itself (closes, then calls `onDone`), rendered by the same `AddCredentialSheet` body (`setup-sheets.tsx`). No new sheet kind. Sign in with Claude is its default method (I3). Focus returns to the step row on close.
- Step 2 opens `{ kind: "new-template", then: "open-editor" }` (today's top-level kind).
- Step 3 opens `{ kind: "new-agent" }`; its inline setup creates a missing credential or template on the way (U4).

### 4.5 "Can manage the org" where it is decided (R6)

- The New agent sheet gains I7's `Switch` "Can manage the org" (New agent only creates persistent agents; after Projects, as in Edit agent); `POST /api/agents` accepts `manageOrg` from a human session (today `createAgentBodySchema` silently strips it); agents creating agents through I7's `create_agent` tool still can't set it (`createAgentToolSchema` has no such field, ADR 0025), and `AgentService.create` refuses it from an agent actor with I7's "Only a human can grant manage_org."
- The switch's help line, in both sheets, gains a lead sentence before I7's text: "Lets this agent create and arrange other agents: ask it in Chat to build the rest of your team." I7's honest description of what it can reach stays.

### 4.6 DESIGN.md amendments

- **Empty states:** "One plain line in muted text, with no illustration. Exception: a factory with no agents shows numbered setup steps on the Inbox, in the reading pane from 1024px and at the top of the list below. They are two-line rows (buttons that open sheets), not cards; numbers in Geist tabular, not mono; the block leaves instantly once an agent exists, never under the pointer."

## 5. PR 2: Desktop notifications (Q7–Q10, R7, R8)

The switch stays as U1 built it (user menu "Browser notifications", per browser in `localStorage`, permission requested only from the click, a blocked note). What changes is what fires, what it says, and how it coalesces, in `features/inbox/notifications.ts`, driven by the same `inbox_changed` / `chat_changed` triggers.

### 5.1 What fires (Q7, R7)

Title = who, capped at 40 characters (handles middle-truncated, names end-truncated); body = the fact as metadata, never message text, never a preview. Counts use `Intl.PluralRules` and `Intl.NumberFormat`.

| Source (unread, from `GET /api/inbox`) | Burst key | Title | Body | Click opens |
|---|---|---|---|---|
| A chat row (I1 `chats[]`) | `chat:<slug>` | the agent's display name ("Developer · ab12" for a spawned agent stays as the chat row shows it) | "1 new message" / "3 new messages" | `/agents/<slug>/chat?message=<firstUnreadId>` |
| `mention` items | `task:<key>` | the first mentioner's handle ("@dev"), or "T-42" when several people mentioned you | "Mentioned you on T-42" / "2 mentions on T-42" | `/tasks/<key>?comment=<commentId of the first unread>` |
| @factory `agent_errored` | `error:<slug>` | "@dev" | "Hit an error" | `/agents/<slug>/session` |
| `credential` item (I3) | `credential:<name>` | `Credential "work"` | "Expires Dec 3" / "Expired Dec 3" | `/settings/credentials?credential=<name>` |
| @factory `loop_held` (PR 3) | `loop:<holdId>` | "@a and @b" | "Messages between them are held" | `/inbox?item=<itemId>` |

Nothing else: `task_event` items no longer notify (the branch is deleted, no switch), and no other @factory fact does (restarts, recoveries, I5's `plugin_not_loaded`, PR 4's `worktrees_kept`). Errors notify only when they reach your Inbox (top-level agents). The credential date is formatted from `expiresAt` in the browser's locale and zone, the same source I3's row and pane render from (I3 D11), so the notification and the pane never show different days.

`icon` stays `/favicon.svg`. Constructing a `Notification` is wrapped in `try`: where the constructor throws (Android Chrome requires a service worker), the switch reports notifications as unsupported and hides itself. No service worker is added.

This table supersedes the notifier on the base (`notificationTitle`, `chatNotificationTitle` "Ada · 3 new", `notifyNew` with the preview as body and the item or message id as tag, in `features/inbox/notifications.ts`): PR 2 replaces them.

The chats/items split is already on the base (I1): `inboxPage` excludes `messages.kind = 'message'` from `items`, and `unreadChats` joins on `from_agent_id`. @factory notices (`kind = 'system'`: `agent_errored`, `plugin_not_loaded`, `loop_held`, `worktrees_kept`) stay in `items`. PR 2 only adds `notice` to their entries.

### 5.2 Bursts (Q9)

- A **burst** is the run of unread items under one key, identified by its **first unread** item. The tag is `<key>:<firstUnreadId>`: another item while the key is still unread re-uses the tag, so the notification is replaced with the new count silently (`renotify` unset); once the key is read, the next item has a new first unread, so a new tag and a new notification with sound. For `loop:<holdId>` the burst is the hold itself.
- `ChatRow` (I1) gains `firstUnreadId` (the oldest unread message's id), a server change in PR 2; mentions, errors and credentials take theirs from the oldest unread item of the key in `items`.
- Per tab, `Map<key, Notification>` of what it showed. On each inbox refresh, a key with nothing unread any more, or a resumed hold (`loopHold.resumedAt` set), is `close()`d; a key whose first unread changed while still unread (partly read elsewhere) with no new item only closes the old notification (nothing new arrived, so nothing re-shows); a `close` event drops the entry. "A key gains an item" means: for chats, `latest.messageId` is not in the seen set; for items, an item id is not in the seen set. Best effort (R8): only tabs holding a handle close it; a notification shown by a tab since closed stays until the OS clears it.
- The notifier reads `GET /api/inbox?unread=true&notify=true`: every chat plus every unread `mention`, `agent_errored`, `credential` and `loop_held` item, newest first, capped at 200, so a burst never looks read because its items fell off a page. Only the latest fetch is applied; a frame during a fetch schedules one trailing fetch.
- Turning the switch off closes this tab's shown notifications; signing out closes them and forgets what was seen.
- Baseline as today: what is unread when the switch turns on or the app loads is not new. A key notifies only when it gains an item not in the baseline or seen set.

### 5.3 When (Q10)

Each tab decides alone: it fires only while `document.visibilityState === "hidden"`, the switch is on and permission is granted. Two hidden tabs may both fire; the shared tag collapses them where browsers honour tags (accepted, Q10). No cross-tab coordination.

### 5.4 Click

`window.focus()`, close the notification, navigate (table above). For inbox items (mentions, errors, credentials, holds) the click marks the burst's items read exactly as an Inbox click does (today's `useOpenItem`); chats follow the Chat's own read rules (opening the Chat marks it read, I1 §6.7).

## 6. PR 3: Loop guard (#47, Q2–Q6, R8–R11)

### 6.1 Rule

For an unordered pair of agents {A, B}:

- **Not counted:** `send_command` (I1) goes only from an agent to itself or its direct reports, and a report can't send_command its manager, so it is one-directional and can't ping-pong; a report's answer reaches its manager as text (`member_update`, ADR 0005), which isn't agent-to-agent messaging.
- **Counted** (Q2): agent-to-agent rows from one to the other: `send_message` rows (`kind = 'message'`), task-comment deliveries (`kind = 'task_comment'`, sender = the comment's agent author, to the assignee or a mentioned agent), and agent-authored scheduled firings (`kind = 'scheduled'`, sender = `author_agent_id`). Humans, `@factory` and human-authored schedules never count. A row's **sender** is `from_agent_id`, or `author_agent_id` for scheduled rows.
- **Window start** = the latest of: `now − window`; the pair's last Resume (`loop_holds.resumed_at`); the latest **reset** involving A or B (Q3, R11): only human actions reset,
  - a human's `kind = 'message'` row to A or B (`from_user_id` set, `to_agent_id` in {A, B});
  - a human's raw Session input to A or B: an `operator_input` session event with `byKind: "human"` (I1 already writes the required `byKind: "human" | "agent"`; `send_command` writes `"agent"`; D4);
  - a `status` task event by a human (`actor_user_id` set) on a task currently assigned to A or B.
  Comments, human-authored schedule firings and every agent action (an agent marking a task done or reopening it included: that is the done/reopen ping-pong the guard exists for) never reset. A reset never releases an open hold; only Resume does.
- **Trip** (Q4): when a counted row from A to B is about to be inserted, count the counted rows A→B and B→A created after the window start. If, including the new row, both directions exceed N, the new row is the first held one and a hold opens. While a hold is open for the pair, every new counted row between them, either direction, is held.
- **Settings:** `factory_settings.loop_guard_messages` (N, default 10, bounds 2–1000) and `loop_guard_window_minutes` (default 10, bounds 1–1440), read live at each check. No off switch.
- Counts are derived at send time (Q4); nothing is counted in memory or stored. Every counted row counts whatever its state, except `cancelled` (a held, rejected or delivered message was still sent).

### 6.2 Schema (R9)

```
messages.state            CHECK gains 'loop_held'       -- the code and DB name; copy says "held"
messages.loop_hold_id     text null → loop_holds(id)    -- on held rows and on the humans' notice only
loop_holds(
  id          text primary key,
  agent_a     text not null → agents(id),   -- the smaller id
  agent_b     text not null → agents(id),   -- the larger id; CHECK agent_a < agent_b
  opened_at   timestamptz not null,         -- from EventStore.clock()
  resumed_at  timestamptz null,             -- from EventStore.clock()
  resumed_by  text null → users(id)
)
unique (agent_a, agent_b) where resumed_at is null      -- one open hold per pair
index on session_events (agent_id, at) where type = 'operator_input'   -- the reset read
```

- No counts are stored (Q5): the humans' notice body carries them as they were when the hold opened; the live "N messages waiting" is `count(*) where loop_hold_id = $1 and state = 'loop_held'`.
- `messages_state_check` (migration 0011) and `messages_schedule_pending_idx` (0009, `("schedule_id","to_agent_id") where state = 'pending' and schedule_id is not null`) are hand-written SQL: the generated migration (the next number, 0024 on the base) gets hand edits, as I3's did. The schedule index widens to `state in ('pending','loop_held') and schedule_id is not null`, so the database keeps one open firing row per schedule across both states.
- The managers' notices carry no `loop_hold_id`, so "the hold's notice" is exactly one row.
- Shared types gain the state where they enumerate it: `MessageLookup.state` and its schema, the outgoing card's state union, `rejectPending*`.
- Naming: the base already uses "held" for something else (`EventStore.createHeld`, the `held` queue-item kind: rows held until a turn ends). The loop guard's code identifiers say `loopHeld`/`loop_held`; only the tool result status and the copy say "held".

### 6.3 The check (`apps/server/src/messaging/loop-guard.ts`)

`LoopGuard.lockPairs(tx, pairs)` then `LoopGuard.check(tx, { from, to, now }) → { held: false } | { held: true; holdId; opened: boolean; counts?: { ab, ba, minutes } }`, called inside the transaction that inserts counted rows, before each insert:

1. **Lock, once per transaction, in order.** The caller collects every pair the transaction will insert into (a list send has up to 10 recipients, a comment the assignee plus up to 50 mentions), computes each lock key `hashtextextended('loop:' || a || ':' || b, 0)` (a bigint), sorts and de-duplicates the keys numerically, and takes `pg_advisory_xact_lock(key)` for each in ascending order before any check (D3). Resume takes the same lock (§6.6). Ordering with existing locks: in the scheduler after the schedule row lock and before message writes; in task-service after the task and agent reads, before message writes; in the Router before message writes. Sorted acquisition rules out a cycle between sends.
2. An open hold for the pair → `{ held: true, holdId, opened: false }`.
3. Else read the settings, compute the window start (one query: `greatest` of the three reset sources and the last resume), and count both directions (one query over `messages` by sender, `to_agent_id`, `created_at`; `messages_from_agent_idx` serves message and comment rows, and the plan checks the scheduled path's plan on the 214-agent dataset).
4. Both > N with the new row → insert the hold (`opened_at` from the store clock) and return `opened: true` with the counts and the minutes from the first counted row in the window to now, rounded up, at least 1.

The caller inserts its row with `state = 'loop_held'` and `loop_hold_id`, and does not hand it over. Call sites:

- `Router.send` (I1's list send), per agent recipient. The per-recipient result gains `status: "held"` with the note (§6.5).
- Task comment fan-out (`task-service.ts`), per agent recipient (assignee, mentions) when the author is an agent. The comment itself is always posted; `comment_task`'s result lists held recipients: `held: [{ to: "@b", note }]`.
- Not checked: the spawn brief (`spawn-service.ts`, a `kind = 'message'` row from the spawner to a brand-new child, which can't have a window yet). It still counts toward the pair afterwards.
- The scheduler's firing (`Scheduler.fireOnce`), when the schedule's author is an agent and the target is another agent, on the **insert** path. `upsertFiring` that updates an already-pending row in place does not re-check: a firing row that was pending when the hold opened is still delivered (it predates the hold). `records().pendingFiring` and coalescing treat a `loop_held` row like a pending one and leave it held, so a long hold accrues one row per schedule; the widened unique index guarantees that, and Resume's flip to pending can't collide with another open row of the same schedule.

When a check opens a hold, the same transaction writes the notices (§6.4); frames publish after commit.

### 6.4 Notices (Q6)

- **Humans:** one `@factory` message, `kind = 'system'`, `notice = 'loop_held'`, `subject_agent_id = A` (the sender of the tripping row), `loop_hold_id`, `to_all_humans`, through `EventStore.createHumanMessage` (the `agent_errored` path). Body (also the preview): "@a and @b exchanged 22 messages in 3 minutes; further messages between them are held." (pluralised).
- **Managers:** for each of A's and B's managers that exists, is live and isn't the other agent of the pair (deduplicated): a `@factory` `system` message, notice `loop_held`, `subject_agent_id = A`, without `loop_hold_id`, always a **new** row inserted in the hold's transaction (not `EventStore.createNotice`, which isn't transaction-aware and replaces a pending notice of the same type and subject, so a second hold involving A would overwrite the first), adopted into the manager's queue after commit without waking it (it learns at its next turn): "@a and @b exchanged 22 messages in 3 minutes with no human in between. Messages between them are held until a human resumes them in the Inbox." Managers can't resume (Q5).
- **No new inbox kind** (Q6): the notice drives rendering (`inboxItemSchema.notice`, added in PR 2), and the @factory row anatomy fits. `inboxItemSchema` gains `loopHold?: { id, agents: [{ slug, status }, { slug, status }], waiting: number, sentOn: number, resumedAt: string | null, resumedBy: string | null }` (`sentOn` = rows with this `loop_hold_id` whose state is neither `loop_held` nor `rejected`, excluding the hold's own `system` notice, so every pane and every remount can show it) (`resumedBy` a handle with `@`; `status` live, so the pane can say who ended).

### 6.5 The senders

A held recipient's result: `{ to: "@b", kind: "agent", status: "held", id, note }`. The note for the tripping row: "Held: you and @b exchanged 22 messages in 3 minutes with no human in between. A human must resume this pair in the Inbox; it is sent on then." For later rows of an open hold (no stored counts): "Held: messages between you and @b are held until a human resumes them in the Inbox; it is sent on then." CLAUDE.md, messaging section: "If a send comes back `held`, stop messaging that agent about it and carry on with other work or end your turn: a human resumes the pair."

The Session's outgoing card (I1 §4.7, `features/session/outgoing-message.tsx`) renders `held` like `pending`: one muted line "Held by the loop guard: @b". The card shows a recipient's `note` in place of its status text; for `held` the status line wins over the note (the note is written for the agent).

### 6.6 Resume (R10)

- `POST /api/loop-holds/:id/resume` (human session). One transaction: take the pair's advisory lock (§6.3 step 1), then `SELECT … FOR UPDATE` the hold row (always in that order, so a send that saw the hold open has committed its held row before Resume reads them); if `resumed_at` is set → 409 with the standard error envelope carrying `resumedBy` and `resumedAt` in `error`; else set `resumed_at` (store clock) and `resumed_by`, turn every `loop_held` row with this `loop_hold_id` to `pending`, and commit. After commit: hand each row over in `created_at` order through a new `Router.handOffResumed` (per kind: `agent_message`, `task_message` or `scheduled` delivery, as the original insert would have). Live, the recipient's queue appends them after what it already holds (queue order is `created_at` only at a boot rebuild), and a message the pair sends between Resume's commit and its hand-off may overtake them (accepted: both are delivered). Publish `inbox_changed` to everyone. 200 `{ sentOn: number }`.
- Resume resets the window (its time is a window start, §6.1), so the pair gets N more each way before tripping again.
- **Ended agents:** termination rejects an agent's `loop_held` rows as it rejects its pending ones (`terminateRows` → `rejectPending`, `rejectPendingToTerminated` match both states). Archiving rejects nothing (as for pending rows today): held rows to an archived agent stay held, and after Resume they wait as pending rows do. Nothing auto-closes a hold; the pane derives what to say from the agents' live status (§6.7).
- Boot: held rows are not pending, so the wake-queue rebuild skips them.

### 6.7 Row and pane (R4, R8)

- **Row:** the @factory row as today (sender "Factory", about `@a`), preview = the body. Line one carries a muted text label after the sender, never truncated: "Held" while `resumedAt` is null, "Resumed" after (I1's "archived"/"terminated" pattern). The row links to `/inbox?item=<id>` at every width (R4).
- **Pane** (`notice === "loop_held"`): no session excerpt and no composer (a human message would silently reset the window). The header's "Open in session" link is hidden for this notice. Content, top to bottom:
  1. The body as text, handles in mono, `[overflow-wrap:anywhere]`.
  2. A muted line from `waiting`: "4 messages waiting" / "Nothing is waiting" (pluralised). When an agent is terminated: "@b was terminated; its held messages were rejected." (and the waiting line counts what's left the other way).
  3. The action slot, one fixed height: **"Resume @a and @b"** (primary; may wrap, never truncates; keeps its width while pending, label "Resuming…" with a spinner, `aria-disabled`). Below it two ghost links, "Open @a's session" and "Open @b's session", wrapping at every width.
  4. After a Resume, the button is replaced in place by a `role="status"` line, `tabIndex=-1`, which takes focus after your own Resume: "Resumed by you · 14:02 · 4 messages sent on" (zero: "Resumed by you · 14:02 · nothing was left to send"); for another human's Resume or a 409: "Resumed by @ana · 14:01 · 4 messages sent on" (from `loopHold.sentOn`). Times use `formatInboxTime` (a date when not today), full timestamp in `title`. No toast (DESIGN Toasts: the outcome is on screen).
  5. A Resume failure other than 409 keeps the button and shows the I4 `FormOutcome` line "Couldn't resume. Try again."
- **Below 1024px** (R4): `/inbox?item=<id>` for a `loop_held` (and, from PR 4, `worktrees_kept`) item renders the pane full-width as the page body with a Back link to the list. Today the route drops `?item=` below 1024 in an effect (`routes/_app/inbox.tsx`, `InboxPage`, "a `?item=` from a wider window is dropped"); instead it keeps `?item=` while `usePaneItem` resolves the item (it fetches unloaded items by id, as when landing from a notification), showing the pane's loading state, never the list; then it renders the full-width pane for these notices, or replaces the URL with the item's own target for every other kind, whose rows navigate as before.
- The notification (§5.1) opens this pane at every width.

DESIGN.md amendment, Layout → Two panes: "From 1024px the Inbox is a 380px list beside a reading pane; below, rows navigate to their target. A notice whose action lives only in the Inbox (a loop-guard hold, a cleanup notice) opens its pane full-width at `/inbox?item=`, with Back to the list."

### 6.8 Settings → Factory

Two numeric fields after "Member-update debounce", as the existing ones (`factory-section.tsx`, I4 field errors, bounds in `FACTORY_BOUNDS`), each with its own hint:

- "Loop guard limit", suffix "messages": "Two agents that each send the other more than this many messages within the window, with no human in between, are held until someone resumes them in the Inbox (2–1000)."
- "Loop guard window", suffix "min": "How far back the limit counts. A human message to either agent starts a new window (1–1440 min)."

Changes apply to the next counted message.

## 7. PR 4: Spawned-agent cleanup (#55, Q13–Q17, R1, R2)

### 7.1 Convention (Q13, R1)

The CLAUDE.md workspace line becomes, with the agent's actual slug: "To change code in a project, create your own git worktree under `<repo>/.worktrees/.agents/dev-ab12/<branch>` instead of editing the main checkout, so you never disturb the humans' or other agents' work." A spawned agent's line adds: "They are removed a few days after you are terminated, with any uncommitted changes; a branch checked out there is kept unless every commit on it is already pushed or merged, so push what you want to keep." `<branch>` keeps its `/` (git creates the nested folders).

`.agents` can never be a human's branch-named worktree folder: `git check-ref-format --branch .agents/x` is rejected (no ref component may start with `.`).

**Slug uniqueness**, which makes `.worktrees/.agents/<slug>/` unambiguous: `agents.slug` is unique (`packages/db/src/schema/agents.ts`, `.unique()`); I1's `handles` table owns the namespace with `agents.slug → handles(handle)` and reclaims a claim only when nothing references it (I1 §4.1); agent rows are never deleted (no code path deletes from `agents`; terminated and archived rows stay). So a terminated agent's slug is never reused. The plan cites these and adds a test that spawning with a terminated agent's slug is refused.

### 7.2 When

In the reaper's step 3 (`spawning/reaper.ts`), inside `Workspace.deleteWorkspace`: after `stillUnpinned()` passes and **before** the workspace folders are removed, under the same per-slug workspace lock (D6). `deleteWorkspace` gains a fourth callback, `beforeRemove: () => Promise<void>`, which the reaper fills with `SpawnCleanup.run(agent)` (`spawning/cleanup.ts`; it holds the projects store, the git runner and the EventStore). It is idempotent: an agent that already has a `workspace_cleanup` event is skipped (the reaper retries the deletion when the folder removal throws). The callback never throws: every failure, including writing the event or the notice, is caught and logged inside it, so the workspace deletion always proceeds and is never retried because of the cleanup. Pinned agents are skipped with their workspace; unpinning later runs both. Only spawned agents (persistent agents are never reaped).

### 7.3 Projects (R2a, Q17)

Termination deletes the agent's `agent_project_grants` rows, so the cleanup doesn't read grants: it scans **every registered project** (`projects`, current `host_path`) for `.worktrees/.agents/<slug>`, one `lstat` each (the namespace is ours and the slug is never reused). For each project independently:

- no `.worktrees/.agents/<slug>` → nothing to do, nothing reported;
- the folder is missing, isn't a git repository, a check refuses, or a git call fails → the project is skipped and named in the notice ("web: couldn't clean up: not a git repository");
- `git` missing from the host (ENOENT on the first call) → every project with a folder is skipped, one notice line "Couldn't clean up worktrees: git isn't installed on the factory host."

The workspace is deleted regardless; nothing is retried.

### 7.4 The git runner (Q14)

`apps/server/src/spawning/git.ts`, one function `git(repo, args, { timeoutMs = 15_000 })`:

- `execFile("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: repo, timeout, maxBuffer: 1 MB, env })`; never a shell.
- `env`: the server's `PATH` and `HOME` only, plus `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CEILING_DIRECTORIES=<dirname(repo)>` (a non-repo subfolder of a parent repo isn't taken for a repo), `LC_ALL=C`.
- **No network, no working-tree reads.** Allowed subcommands, enforced by a constant the function checks: `rev-parse`, `worktree list --porcelain -z`, `symbolic-ref`, `show-ref`, `check-ref-format`, `rev-list`, `branch -D`. Never `status`, `diff`, `worktree remove`, `worktree prune`, `fetch`, `gc`.
- `safe.directory`: never loosened globally. If a call fails with git's "detected dubious ownership" (a container writing as another uid), the runner retries that call once with `-c safe.directory=<realpath(repo)>`, that exact path, never `*`, never written to any config (D7). The plan flags it as the only place this happens.

Verified locally (git 2.50, 2026-11-23, and by the self-review): `git status` runs `core.fsmonitor`; `git branch -D` runs the `reference-transaction` hook; with the two `-c` overrides neither runs; `worktree list`, `for-each-ref`, `rev-list` and `merge-base` run neither. `rev-list` with a revision that also names a planted file fails as ambiguous unless a trailing `--` ends the revisions; `--end-of-options` can't be used with rev-list's `--not`. `branch -D --end-of-options <name>` works. `git worktree prune` drops the metadata of *any* worktree whose folder is missing (a human's on an unmounted disk), so it is never called.

### 7.5 Steps per project

All paths are compared after `realpath` of the repo and the common dir; paths and ids that git or the agent wrote are data, used only to match, never as delete targets of their own.

0. The slug must match the server's slug schema (one segment, no `.`/`..`/`/`) before it is joined into any path; else the project errors. Defence in depth: slugs come from the database, but this step deletes folders.
1. `repo = realpath(project.host_path)`; `git rev-parse --show-toplevel` must equal `repo`, and `common = realpath(path.resolve(repo, <git rev-parse --git-common-dir>))` (git prints it relative to the cwd, `.git`).
2. **Our folder:** `lstat` `repo/.worktrees`, `repo/.worktrees/.agents` and `base = repo/.worktrees/.agents/<slug>` in turn. A missing one → go to step 3 anyway (the agent may have deleted its folder but left metadata) and skip step 5. A symlink or non-directory at any of the three → refuse the project ("web: .worktrees/.agents/dev-ab12 is a symbolic link; left in place").
3. **Entries:** `git worktree list --porcelain -z`. An entry is ours when its `worktree` path, normalised lexically, is strictly under `base`. Ours give `branches` (their `branch refs/heads/<name>`); a `locked` mark on ours is ignored (R12: the folder is our namespace and the agent that set it is terminated). All others give `checkedOutElsewhere`; the first entry's branch (the main checkout's HEAD) joins it.
4. **Admin dirs to remove:** `common/worktrees` itself must `lstat` as a real directory (not a symlink; missing → no admin dirs). For each `<id>` in it: `<id>` must be a single plain segment (non-empty, no `/`, no `..`, not starting with `.`); `common/worktrees/<id>` must `lstat` as a real directory whose realpath is directly under `realpath(common/worktrees)`; its `gitdir` file's content (untrusted) is resolved against `common/worktrees/<id>/` when relative (git ≥ 2.48 writes relative paths with `worktree.useRelativePaths` or `--relative-paths`), normalised lexically, and must point strictly under `base`. Locked or not (the `locked` file lives inside the entry and goes with it), these form `adminDirs`. Cross-check: every entry step 3 marks as ours must have its admin dir in `adminDirs`; if one doesn't, the whole project is skipped (nothing removed there, stricter than per worktree) and reported ("web: couldn't match `feat/x`'s metadata; left in place").
5. **Remove the folder** (when it exists): re-`lstat` `base` (still a real directory, realpath unchanged since step 2), then `SafeFs` removal without following symlinks (a symlink inside is unlinked, never traversed). `git worktree remove` is never called (its dirt check reads the working tree; a deliberate deviation from the task text, noted in the PR). A partial removal (EACCES, a file in use) is reported for the project and steps 6–7 are skipped for it.
6. **Remove our metadata:** each of `adminDirs`, with the same `SafeFs` removal, re-checked just before. No `git worktree prune`.
7. **Branches:** the default branch is `refs/remotes/origin/HEAD`'s target mapped to `refs/heads/<d>` (`git symbolic-ref -q`), or `refs/heads/main`, else `refs/heads/master`, each used only when it exists locally (`show-ref --verify -q`; a mapped default with no local branch is dropped from the rev-list, its remote ref is already in `--remotes`). For each of `branches`: skip when `git check-ref-format --branch <name>` fails; keep (with its reason, no count) when it is in `checkedOutElsewhere` ("checked out elsewhere"); never touch the default branch, `main` or `master`. Otherwise `git rev-list --count refs/heads/<name> --not --remotes [refs/heads/<default>] --`: `0` → `git branch -D --end-of-options <name>`; else keep with the count. Local refs only, no fetch: a squash-merged branch whose remote branch is already gone locally is kept (we can't prove it landed).

Only branches checked out in the agent's worktrees at cleanup are considered; other branches it made are never touched and not listed (documented in the CLAUDE.md line and the docs). A crash between steps 5 and 7 leaves those branches unlisted (the next sweep finds nothing); accepted, since nothing is lost, only unreported.

The terminated agent's Session gets one `workspace_cleanup` event `{ projects: [{ project, removed: boolean, deleted: string[], kept: [{ branch, commits?: number, reason?: "elsewhere" }], error?: string }] }`, rendered as a muted factory line grouped by project ("web: removed the worktrees; deleted `feat/y`; kept `feat/x` (3 commits not pushed or merged)"), branch names in mono with `[overflow-wrap:anywhere]`.

### 7.6 Notice (Q16)

Only when a branch was kept or a project failed:

- **Humans:** one `@factory` `system` message, `notice = 'worktrees_kept'`, `subject_agent_id` = the terminated agent, `to_all_humans`. Its inbox link is the existing session link without a `seq` (a `system` row has no sender event): the agent is terminated and the `workspace_cleanup` event is its last, so the session opens at it. Body (and preview): first line "Cleaned up @dev-ab12's worktrees." when something was removed, "Couldn't fully clean up @dev-ab12's worktrees." when any project failed; then one line per project: "web: kept `feat/x` (3 commits not pushed or merged), `feat/y` (checked out elsewhere)". At most 20 branch or failure entries, then "and N more in @dev-ab12's session". Counts pluralised.
- **Spawner:** the same text as a `@factory` system message to the agent's manager (`reports_to`) when it is live, sent with `EventStore.createNotice({ toAgentId: manager, notice: "worktrees_kept", subjectAgentId: agent, body })` (one per terminated agent, so its replace-pending rule never merges two cleanups), adopted without a wake.
- No desktop notification (§5.1).
- **Item shape:** inbox items of this notice gain `cleanup?: ProjectResult[]`, read in `toEntries` from the subject agent's `workspace_cleanup` event (at most one per agent: the cleanup runs once, before the workspace is marked deleted); the pane and the Session line render from that one shape, never by parsing the body.
- **Pane:** no excerpt, no composer. The lines grouped by project, branch names in mono with copy feedback (`copy-feedback.tsx`), wrapping; then "Push them to keep the work, or delete them in the project's repository." The header's "Open in session" (the read-only Session at the cleanup event) stays. Full-width below 1024px (§6.7).

## 8. Schema and shared changes by PR

| PR | Change |
|---|---|
| 1 | `GET /api/setup`; Add credential through the existing `openSheetForResult`; `POST /api/agents` accepts `manageOrg` (human); the switch in New agent and its help lead |
| 2 | `ChatRow.firstUnreadId`; `inboxItemSchema.notice` on @factory items; `GET /api/inbox?unread=true&notify=true` |
| 3 | `messages.state` CHECK `loop_held` (hand edit); `messages_schedule_pending_idx` widened (hand edit); `messages.loop_hold_id`; `loop_holds`; partial index for `operator_input`; `factory_settings.loop_guard_messages`, `loop_guard_window_minutes`, bounds and schemas; `NoticeType` `loop_held`; `inboxItemSchema.loopHold`; `held` status in `send_message` / `comment_task` results and the lookup state unions; `POST /api/loop-holds/:id/resume`; `rejectPending*` match `loop_held`; scheduler coalescing matches `loop_held`; CLAUDE.md held line; `?item=` kept below 1024 for `loop_held` |
| 4 | CLAUDE.md worktree line; `spawning/git.ts`; the cleanup in the reaper; `workspace_cleanup` session event; `NoticeType` `worktrees_kept`; `?item=` kept below 1024 for it; `deleteWorkspace`'s `beforeRemove` callback; `inboxItemSchema.cleanup` |

## 9. Product-doc edits (gitignored, applied in the main checkout by the dev of the PR named)

- PR 1: `behavior/inbox.md` (first-run steps), `behavior/administration.md` (where setup starts; Can manage the org at creation).
- PR 2: `behavior/inbox.md` (which items notify, no text, bursts, click marks read): it replaces "a 120-character preview".
- PR 3: `concepts/message.md` (the held state, the loop guard), `architecture/factory-mcp.md` (`held` results), `architecture/data-model.md` (`loop_holds`, `loop_hold_id`, settings), `behavior/inbox.md` (the notice, Resume, full-width below 1024), `architecture/usage-tracking.md` (the guard joins the guardrails), `behavior/administration.md` (the two settings).
- PR 4: `behavior/agents-and-sessions.md` (spawned-agent workspace lifecycle), `architecture/context-assembly.md` (the worktree line), `concepts/project.md` (L16 "never deleted by the factory" changes: what the factory removes in a repo).

## 10. Testing

- **PR 1:** server: `GET /api/setup` on empty, after a credential, a template, an archived-only agent; `POST /api/agents` with `manageOrg`. Web: steps in the pane at 1024+ with nothing selected and in the list below; no "Nothing in your inbox." before the steps; done checks; each opens its sheet (top-level add-credential reuses the body); the block leaves on the refetch, deferred while pointer or focus is in the list, focus moved when it was inside; accessible names; 320/390/1024/1440 and 200% text.
- **PR 2:** unit (fake `Notification`): title and body per source with no message text; caps and plurals; tag per burst; silent replacement keeps the tag; a read key and a resumed hold close their notification; a changed tag closes the old one; a new burst after read gets a new tag; task events, other @factory facts and `worktrees_kept` never fire; hidden-only; baseline; a throwing constructor reads as unsupported. Click navigates to each target and marks inbox items read. Server: `firstUnreadId`; @factory notices stay in `items`.
- **PR 3 (CI DB tests):** counting per kind (message, task comment, agent-authored schedule; human-authored and humans excluded); trip exactly when both directions pass N; a one-direction flood never trips; each reset source resets (human message, human raw input, human status change); an agent's done/reopen flips and comments don't; Resume resets; a reset doesn't release an open hold; concurrent list sends whose pairs overlap in opposite orders never deadlock and never both slip under N; an open hold holds both directions; held rows skip hand-off and the boot rebuild; Resume flips in order, hands off, returns `sentOn`, 409 on the second; a send paused between its check and its insert while Resume runs is never stranded on a closed hold; termination rejects held rows, archiving doesn't; schedule coalescing into a held row and the widened index; an upsert of a row pending before the hold is delivered; notices to humans and managers (manager = other agent excluded, deduped, no `loop_hold_id`); tool results for the first and later held rows; settings bounds. Web: row label, pane (waiting line, terminated line, Resume pending, inline result with focus, 409, error line), full-width at 390 with Back, settings fields. Evidence: a fake-Claude script with two agents ping-ponging through `$mcp send_message`, the notice, Resume at 1440 and 390.
- **PR 4:** real git in temp repos (no network): our folder and only our admin dirs removed; a human worktree whose folder is missing keeps its metadata; merged and pushed branches deleted; an unpushed branch kept with its count; a locked worktree inside our folder removed with its metadata and its branch judged normally; the default branch, `main`, `master` and a branch checked out in the main checkout or in another agent's folder never deleted; a planted `core.fsmonitor` script, `reference-transaction` and `post-checkout` hooks never run (a marker file stays absent); a file named like a branch ref in the main checkout doesn't break `rev-list`; a symlinked `.worktrees`, `.agents` or `<slug>`, a symlink inside the folder pointing outside, a symlinked `common/worktrees`, a symlinked or `..`-named admin dir, a relative `gitdir` (`--relative-paths`), an origin/HEAD whose local branch doesn't exist, and a forged `gitdir` pointing outside `base` are refused, unlinked or ignored, never followed (the outside file survives); a non-repo subfolder of a parent repo is refused; an invalid branch name is skipped; missing folder, non-repo and missing `git` produce the notice lines and still delete the workspace; a terminated agent's former grant doesn't matter (projects are scanned); pinned agents skipped; the notice only when something was kept or failed, its copy for removed-and-kept and for failures.

## 11. Decisions

The full log (questions, alternatives, answers, certainty) is in the decisions issue. Tech-lead decisions:

- **D1** `GET /api/setup` rather than reusing list queries: the sidebar's agent list leaves out ended agents, and Q11 counts them.
- **D2** Bursts are identified by their first unread item, embedded in the tag, so "replace until read" needs no timer and no cross-tab state; `ChatRow` gains `firstUnreadId` for it.
- **D3** The loop guard serialises per pair with transaction-scoped advisory locks taken once, sorted, before any check, since counts are derived (Q4) and list sends lock several pairs.
- **D4** Only human raw input resets the window, read from `operator_input.byKind` (I1 already writes it required, `"agent"` for `send_command`); the earlier plan's `fromKind` field is dropped as delivered.
- **D5** Schedule coalescing matches held rows and the one-open-row index covers both states, so a long hold grows by one row per schedule.
- **D6** The cleanup runs before the workspace folders are removed, under the same lock, so a pin set meanwhile stops both.
- **D7** `safe.directory` is passed per call for the exact repo path, only after git refuses for dubious ownership.
- **D8** Notification clicks on inbox items mark them read, as today's `useOpenItem` does (the first draft's "marks nothing" was a regression).
- **D9** Resume feedback is inline in the pane, not a toast (DESIGN Toasts), and says "sent on", not "delivered" (the rows become pending).

Rated 3/5 or lower, for Or:

- **Q3/R11** (3/5 then 4/5): only human actions reset the window (a message or raw input to either agent, a status change on a task assigned to either); not comments, not human-authored schedules, not agents finishing work.
- **R12** (3/5): a `git worktree lock` inside the agent's own folder is ignored; the worktree is removed like the rest.
- **Q6** (3/5): the hold notice reuses the @factory `notice` path (`loop_held`) instead of a new inbox kind.
- **Q8** (3/5): notifications never carry message text (R7 puts the fact in the body as metadata).
- **Q10** (3/5): each hidden tab fires on its own; occasional duplicates accepted.
- **Q16** (3/5): the cleanup notice goes to every human's Inbox as well as the spawner.
- **R2a** (3/5): the cleanup scans every registered project for the agent's folder instead of reading grants (deleted at termination).
- **R5** (3/5): from 1024px the setup steps fill the reading pane while nothing is selected.
- **R6** (3/5): the manage_org tip lives in the switch's help line, and the switch is added to the New agent sheet.

## 12. Risks and unverified

- **Notification replacement** varies: Chrome and Firefox replace by tag silently without `renotify`; Safari's handling of tags is weaker, so duplicates may show there (Q10 accepts it). Android Chrome needs a service worker, which we don't add: notifications read as unsupported there.
- **Squash merges** look unmerged locally; such branches are kept and listed (by design).
- **Containers writing as another uid** may trigger git's dubious-ownership refusal; handled per call (§7.4), exercised in a Docker test only if CI has Docker.
- **Check-then-act in removal:** another live agent with the same project can write in `.worktrees/` and swap a directory for a symlink between the `lstat` checks and the removal; `SafeFs` refuses symlinks on the way, but Node offers no `openat`-style guarantee. Agents only ever write `.worktrees/.agents/<their slug>`, so this needs a hostile agent racing the sweep.
- **Reset read cost:** the window start reads three sources per counted send; the plan measures it on the 214-agent dataset and adds an index only if needed.
- **Forged remote refs (accepted):** an agent can write `refs/remotes/*` in a granted repo so its own unpushed branch looks pushed, and the cleanup then deletes it. Accepted: it only affects that agent's own branches checked out in its own folder, which it could delete itself, and verifying by fetching would break the no-network rule.
- **Unlisted branches:** branches an agent made but didn't leave checked out are neither deleted nor reported.
- **Symlinked project paths (verified, git 2.50.1, 2026-11-25):** an agent reaches a project through `./projects/<name>`, a link to its host path. `git worktree add` with an absolute path through that link, or a relative one from inside it, records the physical path in both `worktree list` and the admin dir's `gitdir`, so entries compare against `realpath(repo)` as §7.5 assumes. Docker mounts keep source and target paths equal (`workspace/mounts.ts`), so container-made worktrees record host paths too.
