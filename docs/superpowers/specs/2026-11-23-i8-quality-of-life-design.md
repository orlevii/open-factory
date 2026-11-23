# I8 Quality of life: Technical Design

Task: [I8 Quality of life](../../product/roadmap/v0.0.2/i8-quality-of-life.md) (gitignored `docs/product/`, read from the main checkout). Issues: #102 (first-run hint), #47 (loop guard), #55 (worktree cleanup). Decisions: ADR 0021 (the guard counts per pair), ADR 0022 (Chat), ADR 0025 (`manage_org`), ADR 0027 (credential expiry), ADR 0028 (pre-release, no compatibility). Builds on I1 (Chat, chat rows in the Inbox, list sends, `operator_input`, `useInboxNotifier` reading chats), I3 (the `credential` inbox item, the Add credential sheet), I7 (the "Can manage the org" switch, `org_action` frames), I4 (form fields) and U1 §10 (the browser-notification switch).

Every question went to the owner proxy (`owner-i8`); the log of questions, alternatives, answers and certainty is in the decisions issue. §11 lists what is rated 3/5 or lower.

ADR 0028: nothing here keeps old shapes alive. Schema changes ship as the generated migration only; **reset local data** if a migration refuses a non-empty table. The worktree path convention changes without a note for the old layout.

## 1. Goal

Four independent slices:

1. **First-run steps.** A fresh factory's Inbox says what to do first.
2. **Desktop notifications.** Only when a human is addressed or needed, with no message text, one per burst.
3. **Loop guard.** Two agents talking to each other with no human in between are held after a threshold until a human resumes them.
4. **Spawned-agent cleanup.** A terminated spawned agent's worktrees are removed with its workspace; its branches are deleted only when provably landed.

## 2. Acceptance criteria

"PR n" says where each lands (§3).

1. (PR 1) A factory with no agent rows shows "Set up your factory" with three steps on the Inbox; each opens its sheet; a finished step shows a check and stays clickable; the block disappears without a reload when the first agent is created (by this browser, another browser or an agent).
2. (PR 1) The steps show while the factory has never had an agent: archived and terminated agents count as agents.
3. (PR 1) "Sign in to Claude" opens the Add credential sheet as a top-level sheet; it is done once any credential exists. "Create a template" opens New template; done once any template exists.
4. (PR 2) With notifications on and the tab hidden, an agent's Chat message to you raises one notification "Ada · 1 new message"; two more messages before you read it replace it silently ("Ada · 3 new messages"); clicking it focuses the tab on that Chat at the first unread message.
5. (PR 2) No notification ever carries message text; task events, factory restarts and member updates never notify.
6. (PR 2) A mention, a top-level agent's error and a credential expiring each notify once, coalesced per task, agent and credential, and open the comment, the agent's Session and the credential.
7. (PR 3) Two agents scripted to ping-pong are held when both directions pass the threshold; the sender's tool result says `held` with the reason; one Inbox notice "@a and @b exchanged 22 messages in 3 minutes; further messages between them are held." with Resume and Open sessions reaches every human; each agent's manager that isn't the other agent gets a factory message; a desktop notification fires.
8. (PR 3) Resume delivers the held messages in order, closes the hold, resets the window and turns every open pane to "Resumed by @or · 14:02".
9. (PR 3) A human message, a human's raw Session input, or a status change on a task assigned to either agent resets the pair's window; a task comment between them counts toward it and, when held, is still posted on the task.
10. (PR 3) Both thresholds are editable in Settings → Factory and apply to the next send.
11. (PR 4) Agents are told to create worktrees under `<repo>/.worktrees/<slug>/<branch>`.
12. (PR 4) When a terminated spawned agent's workspace is deleted, `<repo>/.worktrees/<slug>/` is removed in each granted project and the worktree metadata pruned; a branch whose commits are all on a remote-tracking ref or the default branch is deleted; any other branch is kept and listed in one notice to the spawner (if live) and the Inbox: "Kept branch `feat/x` (3 commits not on a remote) in web."
13. (PR 4) The cleanup never runs a hook, fsmonitor or a working-tree read, never follows a symlink out of `.worktrees/<slug>/`, and never deletes the default branch or a branch checked out elsewhere (tests plant each).

## 3. Delivery: four draft PRs

| PR | Branch | Content | Demo |
|---|---|---|---|
| 1 | `i8/1-first-run` | §4 | Fresh factory → steps → create an agent → steps vanish |
| 2 | `i8/2-notifications` | §5 | Hidden tab, an agent replies, one notification opens the Chat |
| 3 | `i8/3-loop-guard` | §6 | Two fake agents ping-pong, get held, Resume delivers |
| 4 | `i8/4-spawn-cleanup` | §7 | A terminated spawned agent's worktree and merged branch go; an unpushed branch is kept and listed |

None of I1–I7 is on `main` yet, so every I8 branch starts from the head of the I7 implementation chain (its last branch). Stacked only where there is a real dependency (Q1): **PR 3 stacks on PR 2** (the hold notice renders in the notifier and the pane PR 2 reshapes); PRs 1, 2 and 4 each start from the I7 head and can merge in any order after it.

## 4. PR 1: First-run steps (#102, Q11, Q12)

### 4.1 Data

`GET /api/setup` (human session) → `{ hasCredential: boolean, hasTemplate: boolean, hasAgent: boolean }`, three `exists` queries: any `credentials` row, any `templates` row (valid or not, Q12), any `agents` row (archived, terminated and spawned included, Q11). No stored flag.

The web query `["setup"]` (staleTime 0, refetched on window focus) is invalidated:
- by the create mutations of this browser (credential, template, agent; the sheets already call their `onSuccess`);
- by the ws frames that announce changes elsewhere: `org_action` (I7, agent-made creates), `agent_status` for an agent the client doesn't know (any agent appearing), and `settings_changed`. A missed frame is healed by the focus refetch.

### 4.2 Where and when

- On `/inbox`, in the list column, while `hasAgent` is false. With no inbox items it replaces "Nothing in your inbox."; with items (an I3 credential notice, say) it sits above the list. Below 1024px the same, full width. The reading pane keeps its empty state.
- When `hasAgent` turns true the block unmounts at once (no exit animation: DESIGN, live content leaves instantly) and the Inbox shows what it would otherwise show.
- Every signed-in user sees it (there are no roles). No dismiss.

### 4.3 The block

```
Set up your factory
1  Sign in to Claude              Connect the Claude account your agents run on.    ›
2  Create a template              A template is a role: persona, skills, tools and model.   ›
3  Create an agent                An agent runs a template in its own session.      ›
   Then turn on "Can manage the org" in its Edit sheet and ask it in Chat to build the rest of your team.
```

- Heading: 15px semibold, foreground. Each step is one `<button>` row (h-14 on fine pointers, min 44px touch target), full width of the column (max 40rem): a 20px step marker (the number in muted mono inside a 1px ring; when done, a `Check` icon in the success token, `aria-label` "Done"), the title (14px medium), the description (13px muted, one line, truncating at narrow widths, full text in the accessible name), a trailing `ChevronRight` muted. Hover and focus as DESIGN's list rows. Order never changes; done steps stay clickable (adding a second credential is legitimate).
- The tip under step 3 is plain 13px muted text, the switch name in quotes as I7 labels it. It is not a link (the switch is on an agent that doesn't exist yet).
- Accessible: the block is a `<section aria-labelledby>`; the rows are an ordered list; each row's accessible name is "Step 1 of 3, Sign in to Claude, done" / "…, not done".
- Loading: nothing renders until `["setup"]` has data (it is a cheap query; a skeleton would flash). Error: the block is not shown (the Inbox's own states apply).

### 4.4 Sheets

- Step 1 opens Add credential. Today `add-credential` is a child-only kind in `features/sheets/sheet-store.ts`; it becomes a top-level kind too (`{ kind: "add-credential" }` in the top-level union), rendered by the **same** sheet body (`sheet-bodies.ts`), whose submit returns to nothing (top-level) or to the parent (child) as the store already distinguishes. Sign in with Claude is its default method (I3).
- Step 2 opens `{ kind: "new-template", then: "open-editor" }` (today's top-level kind).
- Step 3 opens `{ kind: "new-agent" }`; its inline setup creates a missing credential or template on the way (U4).

### 4.5 DESIGN.md amendment

Empty states: "One plain line in muted text, with no illustration. Exception: a factory with no agents shows numbered setup steps on the Inbox in place of the empty line; they are rows (buttons that open sheets), not cards, and disappear once an agent exists."

## 5. PR 2: Desktop notifications (Q7–Q10)

The switch stays as U1 built it (user menu "Browser notifications", per browser in `localStorage`, permission requested only from the click, a blocked note). What changes is what fires, what it says, and how it coalesces. All in `features/inbox/notifications.ts`, driven by the same `inbox_changed` / `chat_changed` triggers as today.

### 5.1 What fires (Q7)

| Source (from `GET /api/inbox`, unread) | Tag (Q9) | Title (no body text, Q8) | Click opens |
|---|---|---|---|
| A chat row (I1 `chats[]`) | `chat:<slug>:<firstUnreadId>` | "Ada · 1 new message" / "Ada · 3 new messages" | `/agents/<slug>/chat?message=<firstUnreadId>` |
| `mention` item | `task:<key>:<firstUnreadItemId>` | "@dev mentioned you on T-42" | `/tasks/<key>?comment=<commentId>` |
| @factory `agent_errored` | `error:<slug>:<itemId>` | "@dev hit an error" | `/agents/<slug>/session` |
| `credential` item (I3) | `credential:<id>:<itemId>` | "Credential work expires Dec 3" / "Credential work expired Dec 3" | `/settings/credentials?credential=<name>` |
| @factory `loop_held` (PR 3) | `loop:<holdId>` | "@a and @b are held by the loop guard" | `/inbox?item=<itemId>` |

Nothing else: `task_event` items no longer notify (the branch is deleted, no switch), and no other @factory fact does (restarts, recoveries, PR 4's cleanup notice). Errors notify only when they reach your Inbox (top-level agents; a report's error goes to its manager). Names are display names for agents in chat titles (as the chat row shows them) and handles elsewhere; credential names and task keys are labels, not content, and stay. Dates use the browser's locale, month and day.

`body` is omitted; `icon` stays `/favicon.svg`. Every string passes through the existing one-line/cap helpers (names can be long). Agent text never reaches a notification.

### 5.2 Bursts (Q9)

- A **burst** is a run of unread items under one key (chat, task, error, credential), identified by its **first unread** item. The tag embeds that id, so:
  - another message while the chat is still unread re-uses the tag: the notification is replaced with the new count, silently (`renotify` unset);
  - once the chat is read, the next message has a new first-unread id, so a new tag: a new notification with sound.
- The notifier keeps, per tab, `Map<tagPrefix, Notification>` of what it showed. When a key has nothing unread any more (read here, in another tab or on another device: seen on the next inbox refresh), it calls `close()` on that notification, so a stale notification never sits in the OS centre pointing at read messages.
- Baseline as today: what is unread when the switch turns on or the app loads is not new. A key notifies only when it gains an item not in the baseline or seen set.

### 5.3 When (Q10)

Each tab decides alone: it fires only while `document.visibilityState === "hidden"` and the switch is on and permission is granted. Two hidden tabs may both fire; the shared tag collapses them in browsers that honour tags (accepted, Q10). No cross-tab coordination.

### 5.4 Click

`window.focus()`, close the notification, navigate (table above), and for chats and items mark nothing read by itself: the opened view's own read rules apply (I1 §6.7).

## 6. PR 3: Loop guard (#47, Q2–Q6)

### 6.1 Rule

For an unordered pair of agents {A, B}:

- **Counted** (Q2): agent-to-agent rows from one to the other: `send_message` rows (`kind = 'message'`), task-comment deliveries (`kind = 'task_comment'`, sender = the comment's agent author, to the assignee or a mentioned agent), and agent-authored scheduled firings (`kind = 'scheduled'`, sender = `author_agent_id`). Humans, `@factory` and `@scheduler` with a human author never count. A row's **sender** is `from_agent_id`, or `author_agent_id` for scheduled rows.
- **Window start** = the latest of: `now − window`; the pair's last Resume (`loop_holds.resumed_at`); the latest **reset** involving A or B (Q3):
  - a human's `kind = 'message'` row to A or B (`from_user_id` set, `to_agent_id` in {A, B});
  - a human's raw Session input to A or B (an `operator_input` session event whose payload says `fromKind: "human"`; I8 adds `fromKind: "human" | "agent"` to I1's `operator_input` payload, since I1 PR 4 also writes agent ones for `send_command`);
  - a `status` task event on a task currently assigned to A or B (any actor).
  Comments and human-authored schedule firings never reset.
- **Trip** (Q4): when a new counted row from A to B is about to be inserted, count the counted rows A→B and B→A created after the window start. If, including the new row, both directions exceed N, the new row is the first **held** one and a hold opens. While a hold is open for the pair, every new counted row between them, either direction, is held.
- **Settings:** `factory_settings.loop_guard_messages` (N, default 10, bounds 2–1000) and `loop_guard_window_minutes` (default 10, bounds 1–1440). Read live at each check. No off switch.
- Counts are derived at send time (Q4); nothing is counted in memory or stored.

### 6.2 Schema

```
messages.state            CHECK gains 'held'
messages.loop_hold_id     text null → loop_holds(id)   (set on held rows and on the hold's notice)
loop_holds(
  id          text primary key,
  agent_a     text not null → agents(id),   -- the smaller id
  agent_b     text not null → agents(id),   -- the larger id; CHECK agent_a < agent_b
  opened_at   timestamptz not null default now(),
  resumed_at  timestamptz null,
  resumed_by  text null → users(id)
)
unique (agent_a, agent_b) where resumed_at is null      -- one open hold per pair
index on session_events (agent_id, at) where type = 'operator_input'   -- the reset read
```

No counts are stored (Q5): the notice text carries them as they were when the hold opened. The notice message is found by `messages.loop_hold_id` with `kind = 'system'`.

### 6.3 The check (`apps/server/src/messaging/loop-guard.ts`)

`LoopGuard.check(tx, { from, to, now }) → { held: false } | { held: true; holdId; opened: boolean; counts?: { ab, ba, minutes } }`, called inside the transaction that inserts each counted row, before the insert:

1. `pg_advisory_xact_lock` on the pair key (`loop:<a>:<b>`), so two concurrent sends between the pair serialise and can't both slip under N.
2. An open hold for the pair → `{ held: true, holdId, opened: false }`.
3. Else read the settings, compute the window start (one query: `greatest` of the three reset sources and the last resume), count both directions (one query over `messages` on `(from_agent_id | author_agent_id, to_agent_id, created_at)`; the existing `messages_from_agent_idx` serves the message rows, and the plan checks the scheduled path's plan on the 214-agent dataset).
4. Both > N with the new row → insert the hold, return `opened: true` with the counts and the minutes since the first counted row in the window (rounded up).

The caller inserts its row with `state = 'held'` and `loop_hold_id` when held, and does not hand it over. Call sites:

- `Router.send` (I1's list send), per agent recipient. Its per-recipient result gains `status: "held"` with the note (§6.5).
- Task comment fan-out (`task-service.ts`), per agent recipient (assignee, mentions) when the author is an agent. The comment itself is always posted; `comment_task`'s result lists held recipients: `held: [{ to: "@b", note }]`.
- The scheduler's firing, when the schedule's author is an agent and the target is another agent. Coalescing (`schedule-store.ts`, firings + missed) matches a `held` row of the same schedule as it matches a `pending` one, and the row stays held: a long hold accrues one row per schedule, not one per firing.

When a check opens a hold, the same transaction writes the notices (§6.4); the frames publish after commit.

### 6.4 Notices (Q6)

- **Humans:** one `@factory` message, `kind = 'system'`, `notice = 'loop_held'`, `subject_agent_id = A` (the sender of the tripping row), `loop_hold_id`, `to_all_humans`, through `EventStore.createHumanMessage` (the `agent_errored` path; no new inbox kind). Body (also the preview): "@a and @b exchanged 22 messages in 3 minutes; further messages between them are held."
- **Managers:** for each of A's and B's managers that exists, is live, and isn't the other agent of the pair (deduplicated): a `@factory` `system` message to that agent, notice `loop_held`: "@a and @b exchanged 22 messages in 3 minutes with no human in between. Messages between them are held until a human resumes them in the Inbox." Managers can't resume (Q5).
- **Inbox item shape:** `inboxItemSchema` gains `notice?: string` (the row's notice, for every @factory item) and `loopHold?: { id, agents: [slugA, slugB], resumedAt: string | null, resumedBy: string | null }` (handle with `@`). The row renders like any @factory item; the pane switches on `notice === "loop_held"`. A new inbox kind is not needed: the notice drives rendering, and the existing @factory row anatomy fits.

### 6.5 The senders

The tool result for a held recipient: `{ to: "@b", kind: "agent", status: "held", id, note: "Held: you and @b exchanged 22 messages in 3 minutes with no human in between. A human must resume this pair in the Inbox; it is delivered then." }` (later held rows reuse the counts of the hold's notice). CLAUDE.md, messaging section: "If a send comes back `held`, stop messaging that agent about it and carry on with other work or end your turn: a human resumes the pair."

The Session's outgoing card (I1 §4.7) renders `held` like `pending`: one muted line "Held by the loop guard: @b".

### 6.6 Resume

- `POST /api/loop-holds/:id/resume` (human session). One transaction: lock the hold row; if `resumed_at` is set → 409 `{ resumedBy, resumedAt }`; else set `resumed_at = now()`, `resumed_by`, turn every `held` row with this `loop_hold_id` to `pending` (their `created_at` keeps queue order), and commit. After commit: hand each row over in creation order (the Router's existing agent hand-off), publish `inbox_changed` to everyone.
- Resume resets the window (its time is a window start, §6.1), so the pair gets N more each way before tripping again.
- **Ended agents:** terminating or archiving an agent rejects its `held` rows as it rejects its pending ones (`rejectPending` and `rejectPendingToTerminated` match both states). A hold whose rows are all gone still resumes (nothing to deliver); the pane says how many were delivered.
- Boot: held rows are not pending, so the wake queue rebuild skips them; nothing else changes.

### 6.7 Pane and row

- The row: the @factory row as today, preview = the body.
- The pane for `loop_held`: the body as a sentence with both handles as `AgentChip`s; then a button row: **Resume** (primary) and **Open sessions** (outline, a menu with "@a's session" and "@b's session"; below 640px two stacked links instead of a menu). While the POST runs, "Resuming…" with a spinner. After: the button row is replaced in place by "Resumed by @or · 14:02" (muted 13px, same height), also for a 409 (another human was first) and for every other open pane on the next `inbox_changed`. The pane gives "Delivered 4 held messages." as a toast through the existing toaster.
- The notification (§5.1) opens this pane.

### 6.8 Settings → Factory

Two numeric fields after "Member-update debounce", as the existing ones (`factory-section.tsx`, I4 field errors, bounds in `FACTORY_BOUNDS`): "Loop guard: messages each way" (unit none) and "Loop guard: window" (unit "min"), help line: "Two agents that both pass this many messages to each other within the window, with no human in between, are held until someone resumes them."

## 7. PR 4: Spawned-agent cleanup (#55, Q13–Q17)

### 7.1 Convention (Q13)

The CLAUDE.md workspace line becomes, with the agent's actual slug: "To change code in a project, create your own git worktree under `<repo>/.worktrees/dev-ab12/<branch>` instead of editing the main checkout, so you never disturb the humans' or other agents' work." A spawned agent's line adds: "They are removed a few days after you are terminated, with any uncommitted changes; branches are kept unless every commit is already pushed or merged, so push what you want to keep." `<branch>` is the branch name with `/` kept (git creates the nested folders).

**Slug uniqueness**, which makes `.worktrees/<slug>/` unambiguous: `agents.slug` is unique (`packages/db/src/schema/agents.ts`, `.unique()`), I1's `handles` table owns the namespace with `agents.slug → handles(handle)`, agent rows are never deleted (terminated and archived rows stay; no code path deletes from `agents`), and a claim is reclaimable only when no row references it (I1 §4.1). So a terminated agent's slug is never reused. The plan cites these and adds a test that a spawn with a terminated agent's slug is refused.

### 7.2 When

In the reaper's step 3 (`spawning/reaper.ts`), inside `Workspace.deleteWorkspace`'s callback order: after `stillUnpinned()` passes and **before** the workspace folders are removed, under the same per-slug workspace lock. Pinned agents are skipped with their workspace; unpinning later runs both. Only spawned agents (persistent agents are never reaped).

### 7.3 Projects

The agent's `agent_project_grants` rows joined to `projects` (current `host_path`). For each project, independently (Q17): a project whose folder is missing, isn't a git repository, or whose git call fails is skipped and named in the notice ("Couldn't clean up worktrees in web: not a git repository"). No `.worktrees/<slug>` folder → nothing to do, nothing reported. `git` missing from the host (ENOENT on the first call) → every project skipped, one notice line "Couldn't clean up worktrees: git isn't installed on the factory host." The workspace is deleted regardless; nothing is retried.

### 7.4 The git runner (Q14 hardening)

`apps/server/src/spawning/git.ts`: one function `git(repo, args, { timeoutMs = 15_000 })`:

- `execFile("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: repo, timeout, env })`; never a shell; output size capped (1 MB).
- `env`: the server's `PATH` and `HOME` only, plus `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C` (stable messages). No credential helpers are invoked because nothing touches the network.
- **No network, no working-tree reads.** Allowed subcommands, enforced by a constant the function checks: `rev-parse`, `worktree list --porcelain -z`, `worktree prune`, `symbolic-ref`, `show-ref`, `check-ref-format`, `rev-list`, `branch -D`. No `status`, `diff`, `worktree remove`, `fetch`, `gc`.
- `safe.directory`: never loosened globally. If a call fails with git's "detected dubious ownership" (a container writing as another uid), the runner retries that call once with `-c safe.directory=<realpath(repo)>`, the exact path, never `*`, never written to any config. The plan flags this as the only place it happens.

Verified locally (git 2.50, 2026-11-23): `git status` runs `core.fsmonitor`; `git branch -D` runs the `reference-transaction` hook; with the two `-c` overrides neither runs; `worktree list`, `for-each-ref`, `rev-list` and `merge-base` run neither. `git rev-list --end-of-options <ref> --not …` is rejected ("option '--not' must come before non-option arguments"), so rev-list relies on fully qualified `refs/heads/…` arguments instead of `--end-of-options`.

### 7.5 Steps per project

1. `repo = realpath(project.host_path)`; `git rev-parse --git-common-dir` must succeed (else "not a git repository").
2. **The folder:** `base = repo/.worktrees/<slug>`. `lstat` `repo/.worktrees` and `base`: if either is missing → done for this project; if either is a symlink or not a directory → refuse ("…/.worktrees/dev-ab12 is a symbolic link; left in place") and skip the project.
3. **Branches to consider** (Q15): `git worktree list --porcelain -z`. Paths it prints are agent-controlled data (a worktree's `.git` file and its admin `gitdir` file are editable): they are used only to pick entries, never as delete targets. An entry is the agent's when its path, normalised lexically, is strictly under `base`. Its `branch refs/heads/<name>` is collected. Entries outside `base` give the set `checkedOutElsewhere`.
4. **Default branch:** `git symbolic-ref -q refs/remotes/origin/HEAD` → `refs/remotes/origin/<d>` → `refs/heads/<d>`; with no `origin/HEAD`, `refs/heads/main` when it exists (`show-ref --verify -q`); else none.
5. **Remove the folder:** `SafeFs` removal of `base`, never following symlinks inside it (a symlink is unlinked, not traversed), after re-checking (`lstat`) that `base` is still a real directory whose `realpath` equals `repo/.worktrees/<slug>` (no swap since step 2). `git worktree remove` is never called (its dirt check reads the working tree; a deliberate deviation from the task text, noted in the PR).
6. `git worktree prune` (drops the metadata of worktrees whose folder is gone).
7. **Each collected branch:** validate with `git check-ref-format --branch <name>`; skip and keep it when it is the default branch, is in `checkedOutElsewhere`, or `git worktree list` (re-read after prune) still shows it checked out. Then `git rev-list --count refs/heads/<name> --not --remotes [refs/heads/<default>]`: `0` → `git branch -D --end-of-options <name>` (hooks disabled); else keep it with that count. Local refs only, no fetch: a squash-merged branch whose remote branch is already gone locally is kept (we can't prove it landed).

Removal results (folders, deleted branches) are appended to the terminated agent's Session as one `workspace_cleanup` event `{ projects: [{ project, removed: boolean, deleted: string[], kept: [{ branch, commits }], error?: string }] }`, rendered as a muted factory line ("Cleaned up worktrees in web: deleted feat/y; kept feat/x (3 commits not on a remote).").

### 7.6 Notice (Q16)

Only when a branch was kept or a project failed:

- **Humans:** one `@factory` `system` message, `notice = 'worktrees_kept'`, `subject_agent_id` = the terminated agent, `to_all_humans` (the same path as §6.4). Body: "Cleaned up @dev-ab12's worktrees. Kept branch `feat/x` (3 commits not on a remote) in web." Several lines joined, one per kept branch or failure, capped at 20 then "and N more".
- **Spawner:** the same text as a `@factory` system message to the agent's manager (`reports_to`) when it is live (not archived or terminated).
- No desktop notification (§5.1).
- The pane renders the body as text with branch names in mono; it links to the spawned agent's Session (read-only).

## 8. Schema and shared changes by PR

| PR | Change |
|---|---|
| 1 | `GET /api/setup`; top-level `add-credential` sheet kind |
| 2 | none server-side |
| 3 | `messages.state` CHECK `held`; `messages.loop_hold_id`; `loop_holds`; partial index on `session_events` for `operator_input`; `factory_settings.loop_guard_messages`, `loop_guard_window_minutes` and their bounds and schemas; `operator_input.fromKind`; `NoticeType` `loop_held`; `inboxItemSchema.notice`, `.loopHold`; `send_message` / `comment_task` result status `held`; `POST /api/loop-holds/:id/resume`; `rejectPending*` match `held`; scheduler coalescing matches `held`; CLAUDE.md held line |
| 4 | CLAUDE.md worktree line; `spawning/git.ts`; the cleanup in the reaper; `workspace_cleanup` session event; `NoticeType` `worktrees_kept` |

## 9. Product-doc edits (gitignored, applied in the main checkout by the dev of the PR named)

- PR 1: `behavior/inbox.md` (first-run steps), `behavior/administration.md` (where setup starts).
- PR 2: `behavior/inbox.md` (notifications: which fire, no text, bursts), `ui-review/decisions.md` if it records notification copy.
- PR 3: `concepts/message.md` (`held`, the loop guard), `architecture/factory-mcp.md` (`held` results), `architecture/data-model.md` (`loop_holds`, `loop_hold_id`, settings), `behavior/inbox.md` (the notice and Resume), `architecture/usage-tracking.md` (the guard joins the guardrails), `behavior/administration.md` (the two settings).
- PR 4: `concepts/agent.md` or `behavior/agents-and-sessions.md` (spawned-agent workspace lifecycle), `architecture/context-assembly.md` (the worktree line), `concepts/project.md` (what the factory does in a granted repo).

## 10. Testing

- **PR 1:** server: `GET /api/setup` on empty, after a credential, a template, an archived-only agent. Web: steps render, done checks, each opens its sheet (top-level add-credential reuses the body), block vanishes on the `["setup"]` refetch, items below it, accessible names.
- **PR 2:** unit (fake `Notification`): no `body`; titles per source; tag per burst; replacement keeps the tag; a read key closes its notification; a new burst after read gets a new tag; task events and other @factory facts never fire; hidden-only; baseline. Click navigates to each target.
- **PR 3 (CI DB tests):** counting per kind (message, task comment, agent-authored schedule; human-authored and humans excluded); trip exactly when both directions pass N; one-direction flood never trips; each reset source resets, comments don't; Resume resets; concurrent sends between the pair serialise (two connections racing at N); open hold holds both directions; held rows skip hand-off and boot rebuild; Resume flips in order, hands off, 409 on the second; termination rejects held rows; schedule coalescing into a held row; notices to humans and managers (manager = other agent excluded, deduped); tool results; settings bounds. Web: the pane, Resume states, 409, the settings fields. Evidence: a fake-Claude script with two agents ping-ponging through `$mcp send_message`, the notice, Resume.
- **PR 4:** real git in temp repos (no network): worktree folder and metadata removed; merged and pushed branches deleted; an unpushed branch kept with its count; the default branch and a branch checked out in the main checkout or in another agent's folder never deleted; a planted `core.fsmonitor` script, a `reference-transaction` hook and a `post-checkout` hook never run (a marker file stays absent); a symlinked `.worktrees`, a symlinked `<slug>` and a symlink inside the folder pointing outside are refused or unlinked, never followed (the outside file survives); a forged admin `gitdir` pointing outside `base` doesn't widen the delete; an invalid branch name is skipped; missing folder, non-repo and missing `git` (PATH without git) produce the notice lines and still delete the workspace; pinned agents skipped; the notice only when something was kept or failed.

## 11. Decisions

The full log (questions, alternatives, answers, certainty) is in the decisions issue. Tech-lead decisions:

- **D1** `GET /api/setup` rather than reusing the agents, templates and credentials list queries: the agent list in the sidebar leaves out ended agents, and Q11 counts them.
- **D2** Bursts are identified by their first unread item, embedded in the tag, so "replace until read" needs no timer and no cross-tab state.
- **D3** The loop guard serialises per pair with a transaction-scoped advisory lock, since counts are derived (Q4) and two racing sends could both pass under N.
- **D4** `operator_input` gains `fromKind`, because I1 PR 4 writes agent-authored ones for `send_command` and only human input resets the window.
- **D5** Schedule coalescing matches held rows, so a long hold grows by one row per schedule.
- **D6** The cleanup runs before the workspace folders are removed, under the same lock, so a pin set meanwhile stops both.
- **D7** `safe.directory` is passed per call for the exact repo path only after git refuses for dubious ownership.

Rated 3/5 or lower, for Or:

- **Q3** (3/5): the reset set (human message, human raw input, status change on a task assigned to either; not comments, not human-authored schedules).
- **Q6** (3/5): the hold notice reuses the @factory `notice` path (`loop_held`) instead of a new inbox kind.
- **Q8** (3/5): notifications never carry message text.
- **Q10** (3/5): each hidden tab fires on its own; occasional duplicates accepted.
- **Q16** (3/5): the cleanup notice goes to every human's Inbox as well as the spawner.

## 12. Risks and unverified

- **Notification replacement semantics** vary: Chrome and Firefox replace by tag silently without `renotify`; Safari's handling of tags is weaker, so duplicates may show there (Q10 accepts it).
- **Squash merges** look unmerged locally; such branches are kept and listed (by design).
- **Containers writing as another uid** may trigger git's dubious-ownership refusal; handled per call (§7.4) but only exercised in a Docker test if CI has one.
- **Reset read cost**: the window start reads three sources per counted send; the plan measures it on the 214-agent dataset and adds an index only if needed.
