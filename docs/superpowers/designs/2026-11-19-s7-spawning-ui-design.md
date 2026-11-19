# S7 Spawning and ephemeral agents: UI Design

- **Date:** 2026-11-19
- **Status:** revised after the impeccable review against DESIGN.md (round 1)
- **Spec:** [`docs/superpowers/specs/2026-11-19-s7-spawning-design.md`](../specs/2026-11-19-s7-spawning-design.md)
- **Extends:** [S3 session UI](2026-11-18-s3-session-ui-design.md), [S4 templates, agents and settings UI](2026-11-19-s4-templates-agents-settings-ui-design.md), [S5 supervisor UI](2026-11-19-s5-supervisor-ui-design.md), [S6 messaging UI](2026-11-19-s6-messaging-ui-design.md). Everything not mentioned here stays as they define it.
- **Design system:** `DESIGN.md` (Sawtooth). Where this doc and DESIGN.md disagree, DESIGN.md wins.

## 1. What changes

Spawned agents appear where the humans already look: nested under their spawner in the Agents tree, as blocks in the spawner's timeline, and as their own sessions. S7 adds one action (Terminate), one end state (Terminated, read-only for good), a workspace Pin, and a way to see agents that have ended. No new pages. The UI never parses prose: everything comes from the spec's §14 fields, events and tool calls.

**Terms** (spec decision R8). "Spawned agent" in every human- and agent-facing string; "ephemeral" is the data model's and the product docs' concept word only (PRODUCT.md gets the line, spec §19). "Spawner" is never shown; copy says "spawned by @lead". "Terminate" for the act, "Terminated" for the state. "Workspace" for the agent's working directory. Agents are `@slug` in Geist Mono (S6). There is no "Spawned" badge: the display name's "· ab12" already marks a spawned agent, and the screen is calmer without it.

**Dates.** Past moments use S6's `formatInboxTime` and future ones S5's `formatResetTime` (both in `session/format.ts`, local time), each with the preposition its output needs: "today at 14:32", "yesterday at 14:32", "on 19 Nov at 14:32". Never ids (agent id, container id) anywhere.

## 2. Status

`terminated` joins the status set, presented like S4's Archived (an end state, not a live one):

| Status | Slot | Long label | Short label |
|---|---|---|---|
| `terminated` | no dot (the empty 12px slot keeps alignment, as Archived) | Terminated | Terminated |

No new colour token. `document.title` = "Terminated · Tech Lead · ab12 · Open Factory". S3's announcer says "Tech Lead · ab12 was terminated".

## 3. Agents list

- **Active view:** spawned agents nest under their spawner (they report to it); S4's elbow and indentation apply, siblings by display name.
- **Ended view:** S4's Active/Archived radio pair becomes **Active / Ended** (`/agents?ended=only`; the API's `ended` replaces `archived`; `validateSearch` maps an old `?archived=only` bookmark to `ended=only`). Ended is a **flat list, newest end first** (decision R6), not a tree: up to 20 spawns an hour per spawner would otherwise bury everything under same-named roots. Each row's status slot says "Archived" or "Terminated" (no dot), and the S5 inline note (muted, one, plain text) carries the end and the workspace:
  - "Terminated 19 Nov · workspace kept until 22 Nov"
  - "Terminated 19 Nov · workspace pinned"
  - "Terminated 19 Nov · workspace deleted"
  - "Archived 19 Nov"

  "No archived agents." becomes "No ended agents." The list shows the newest 200; when there are more, a muted line under it says "Showing the latest 200 ended agents." S5's running count stays hidden on Ended.
- **Mobile:** the name cell keeps the " · ab12" tail visible: when the display name truncates, it truncates the part before " · " (S4's `MiddleTruncate` pattern), since the suffix is what tells siblings apart. The same rule applies to the session header's `h1`.

## 4. Spawner's timeline

### 4.1 Spawn block

A `tool_call` named `mcp__factory__spawn_agent` with string `template`, `description` and `prompt` (paired with its result by `toolUseId`) renders as a **spawn block**, on S6's outgoing-block shell (1px `rule` edge, 6px radius, no indent; any other shape falls back to S3's tool row; a call inside a subagent stays nested as S3 does):
- **Sender line:** a `GitFork` icon (`aria-hidden`, muted) instead of S6's arrow, so a spawn never reads as a message; then the session's own agent in mono (plain), "spawned" (muted 13px), and the child: from the result's `slug`, `@tech-lead-ab12` through `AgentLink` with its display name (§4.4); before a result or on failure, "spawn from template `tech-lead`". Then the time.
- **Description:** the `description` argument as one muted 13px line, plain text (never Markdown: it is metadata).
- **Body:** the `prompt` (the brief) through `Markdown`, clamped like S6 (~8 lines, "Show all").
- **Footer** (muted 13px, past tense, never stale):
  - no result, turn open: "Spawning…" (it can take tens of seconds while plugins install);
  - no result, turn ended or process exited: "No result: the turn ended before the spawn finished. Check the Agents list." (the spawn may have completed on the server, so never "Not spawned");
  - success: "Spawned", plus "· @tech-lead-ab12 was rate-limited" when the result's status is `rate_limited` (other statuses add nothing), then the result's `note` as written (what wasn't passed on);
  - failure (`isError`): S3's failed-tool treatment (small crimson icon, muted text) with the tool's sentence;
  - "Show tool call" toggle as S6.

### 4.2 Terminate line

A `tool_call` named `mcp__factory__terminate_agent` with a string `slug` renders as one S3 `QuietLine` with a `CircleX` icon (decision R7; the same icon as the Terminate button and every "Terminated" line): "Terminated `@tech-lead-ab12`" (an `AgentLink`) on success; "Couldn't terminate `@x`: <the tool's sentence>" on failure (crimson icon, muted text); "Terminating `@x`…" with no result while the turn is open; "No result: the turn ended before the terminate finished." otherwise.

### 4.3 Updates and peer events

Children's text and facts arrive as S6 update groups, unchanged. Peer events for terminations the spawner didn't do itself use S6's §2.4 line built from `subject.left` and the `by` mapping of §4.4: "`@tech-lead-ab12` · Tech Lead · ab12 left: terminated by `@or`" · "…left: terminated after 3 days without activity" (`by = @factory`).

### 4.4 Links and the `by` mapping

- **`AgentLink`** (S6 §2.1) resolves slugs from the active list **and** the ended list (`agentsListQueryOptions("only")`, fetched lazily when a slug isn't in the active list), so a terminated agent keeps its link and display name: its read-only session is worth opening. A terminated agent older than the newest 200 ended ones still gets the link (the session route resolves any slug), shown as the mono slug without a display name. An archived agent keeps S6's plain mono slug, no link (unchanged).
- **`by`** (the `terminated` event, `subject.left.by`, `terminatedBy`): a bare slug → `AgentLink` ("terminated by `@lead`"); a human `@handle` → plain mono; `@factory` → "after 3 days without activity" (never shown as "@factory").

## 5. A spawned agent's session

### 5.1 Lifecycle lines

- First line (the `spawned` event): S3 `QuietLine` with `GitFork`: "Spawned by `@lead` from template `tech-lead`". `process_started` with reason `spawned` adds no line.
- The `terminated` event: `CircleX`: "Terminated by `@lead`" · "Terminated by `@or`" · "Terminated after 3 days without activity". Exit lines may follow it (spec §8).
- `background_work_lost` with reason `terminated`: S5's line, "Lost when it was terminated: …".

### 5.2 Live spawned agent

- **Agent strip:** S4's manager segment reads "Spawned by `@lead`" instead of "Reports to `@lead`". S4's Edit link is absent.
- **Header actions:** Compact and Interrupt as S3 (or S5's recovery actions while Errored), then a 1px `rule` divider (16px tall, 8px margins), then **Terminate**: a ghost button with a **crimson `CircleX` icon and an ink label**, like S4's Delete… (DESIGN.md → Buttons). Below `md` it is an icon button (`aria-label` "Terminate @tech-lead-ab12", tooltip "Terminate"), and the divider keeps it apart from Interrupt's `Square`. At most two actions, the divider and Terminate.
- **Terminate confirmation** (S4 `ConfirmDialog`, Cancel focused, Esc closes; DESIGN.md destructive rule):
  - Title: "Terminate @tech-lead-ab12?"
  - Body: "It stops now, ending any work in progress, and its session can't continue. Messages waiting for it are dropped. Its workspace is deleted 3 days later unless you pin it; worktrees it made in projects stay."
  - Confirm: "Terminate @tech-lead-ab12" (danger style).
  - **Failure:** `ConfirmDialog`'s existing behaviour: the dialog stays open and shows the error in its own `role="alert"` line. An agent already terminated by someone else meanwhile is a success (terminate is idempotent, spec §7.3).
  - **Success:** the detail query is updated from the response (or refetched) before `onCloseAutoFocus` runs; focus then moves to **Pin workspace** (§5.3), or to the read-only line when there is no workspace to pin.

### 5.3 Terminated agent (read-only)

- **Composer** replaced by a muted line, focusable (`tabIndex=-1`): "This agent was terminated. Its session is read-only." Compact, Interrupt, the recovery actions and Terminate are hidden. The timeline stays fully readable, including deep links.
- **Terminated while you're viewing it** (by the spawner, another human or the TTL): on the `agent_status` frame that says `terminated`, close any open popover or dialog (Compact, Terminate, Start a new session), swap the composer for the read-only line and move focus to it. If the composer held an unsent draft, the line adds a ghost button "Copy unsent message" (copies the draft, then clears it). A send that races gets `409 agent_terminated`; the composer's error line says "@tech-lead-ab12 was terminated, so this wasn't sent."
- **Strip segment** (replacing S5's waiting/paused segments, which can't apply), plain text, outside the strip's `role="status"` region (a page load announces no dates):
  - in the grace period: "Terminated by `@lead` today at 14:32. Workspace will be deleted on 22 Nov at 14:32 unless you pin it." + **Pin workspace**;
  - grace over, not deleted yet (the sweep runs every 10 minutes, and a failing deletion is retried): "Terminated by `@lead` on 19 Nov at 14:32. Workspace due for deletion since 22 Nov at 14:32 unless you pin it." + **Pin workspace**;
  - pinned: "Terminated by `@lead` on 19 Nov at 14:32. Workspace pinned." + **Unpin workspace**;
  - deleted: "Terminated by `@lead` on 19 Nov at 14:32. Workspace deleted on 22 Nov at 14:40." (no button);
  - TTL: "Terminated on 19 Nov at 14:32 after 3 days without activity." + the same workspace sentence;
  - stuck (`stuck`, spec §8 step 5): a second sentence, "Its container couldn't be removed; the factory keeps retrying.";
  - the credential segment is omitted when the credential was deleted (never an empty label).
  - A "What's kept?" ghost button opens a popover: "The session history stays here for good. The workspace (its files and Claude config) is deleted 3 days after it was terminated, unless you pin it. Worktrees and branches it made in projects are never deleted."
- **Pin / Unpin** is one toggle button (focus stays on it when its label swaps between "Pin workspace" (`Pin`) and "Unpin workspace" (`PinOff`)); the outcome is announced through S4's polite inline-outcome region: "Workspace pinned." / "Workspace unpinned." Pin, and Unpin within the grace period, act at once (nothing is lost). **Unpin after the grace** (`now ≥ workspaceGraceEndsAt`) is irreversible, so it confirms:
  - Title: "Unpin and delete @tech-lead-ab12's workspace?"
  - Body: "Its files and Claude config are removed within 10 minutes; its session history stays."
  - Confirm: "Delete workspace" (danger style).
- **Rejected messages:** S6's deep-link line for a `rejected` message names the reason from the recipient's state: "This message wasn't delivered: @dev was terminated." (or "…was archived." as today).

## 6. Spawner's own pages

- **Archive refused:** S4's archive outcome line shows the `409 has_reports` sentence for live spawned agents ("@lead has live spawned agents: @a, @b. Terminate them first."), each slug an `AgentLink` to its session (where Terminate is).
- **Manager picker** (New agent, Edit): spawned agents are not offered.

## 7. Settings

- **Credentials:** usage counts only non-terminated agents. Live spawned agents are covered by their spawner ("Used by @lead"; spec decision M3: live inheritance keeps a child's credential equal to its spawner's). Delete is enabled when only terminated agents used it; its confirmation is unchanged.
- **Projects:** terminated agents' grants are gone, so Remove works as S4 defines. A live spawned grantee is named through its spawner: "Remove (granted to @tech-lead-ab12, spawned by @lead)".

## 8. Accessibility

- The spawn block is an `<article>` with `aria-label`: "@lead spawned @tech-lead-ab12" · "@lead is spawning from tech-lead" · "@lead's spawn from tech-lead failed" · "@lead's spawn from tech-lead has no result".
- Terminate, Pin/Unpin, "What's kept?" and "Copy unsent message" are real buttons with distinct accessible names; the dialogs trap focus; focus moves per §5.2 and §5.3.
- The terminated strip segment is outside the status region (§5.3); the S3 announcer reports the status change once.
- All copy sentence case (PRODUCT.md).

## 9. Components

`apps/web/src/features/session/`: `SpawnBlock` (§4.1, on S6's outgoing-block shell), `TimelineRow` (terminate line, `spawned`/`terminated` lines, the `background_work_lost` reason, peer-left terminated), `AgentLink` (ended-list lookup, §4.4), `formatBy` (§4.4), `StatusBadge` (`terminated`), `AgentStrip` ("Spawned by", the terminated segment with the Pin toggle and the popover), `TerminateButton` + `TerminateDialog` and `UnpinDialog` (on `ConfirmDialog`), the composer's read-only line and its draft copy, the rejected-message reason. `apps/web/src/routes/_app/agents.index.tsx` and `features/agents/agent-tree.tsx`: Active/Ended, the flat Ended list, row notes, the mobile suffix rule. `features/settings/credentials-section.tsx`, `projects-section.tsx`: usage wording.

## 10. Fixed strings

"Active", "Ended", "No ended agents.", "Terminated", "Archived 19 Nov", "Terminated 19 Nov · workspace kept until 22 Nov", "· workspace pinned", "· workspace deleted", "spawned", "spawn from template", "Spawning…", "Spawned", "No result: the turn ended before the spawn finished. Check the Agents list.", "Spawned by @lead", "Spawned by @lead from template tech-lead", "Terminated @x", "Terminating @x…", "Couldn't terminate @x:", "No result: the turn ended before the terminate finished.", "Terminated by @lead", "Terminated after 3 days without activity", "left: terminated by", "left: terminated after 3 days without activity", "Terminate", "Terminate @x?", "It stops now, ending any work in progress, and its session can't continue. Messages waiting for it are dropped. Its workspace is deleted 3 days later unless you pin it; worktrees it made in projects stay.", "Terminate @x", "This agent was terminated. Its session is read-only.", "Copy unsent message", "@x was terminated, so this wasn't sent.", "Workspace will be deleted on … unless you pin it.", "Workspace due for deletion since … unless you pin it.", "Workspace pinned.", "Workspace unpinned.", "Workspace deleted on ….", "Terminated on … after 3 days without activity.", "Its container couldn't be removed; the factory keeps retrying.", "Pin workspace", "Unpin workspace", "What's kept?", "The session history stays here for good. The workspace (its files and Claude config) is deleted 3 days after it was terminated, unless you pin it. Worktrees and branches it made in projects are never deleted.", "Unpin and delete @x's workspace?", "Its files and Claude config are removed within 10 minutes; its session history stays.", "Delete workspace", "This message wasn't delivered: @x was terminated.", "Lost when it was terminated:", "@lead has live spawned agents: @a, @b. Terminate them first.", "Remove (granted to @x, spawned by @lead)".
