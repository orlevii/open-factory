# S7 Spawning and ephemeral agents: UI Design

- **Date:** 2026-11-19
- **Status:** draft, pending the impeccable review against DESIGN.md
- **Spec:** [`docs/superpowers/specs/2026-11-19-s7-spawning-design.md`](../specs/2026-11-19-s7-spawning-design.md)
- **Extends:** [S3 session UI](2026-11-18-s3-session-ui-design.md), [S4 templates, agents and settings UI](2026-11-19-s4-templates-agents-settings-ui-design.md), [S5 supervisor UI](2026-11-19-s5-supervisor-ui-design.md), [S6 messaging UI](2026-11-19-s6-messaging-ui-design.md). Everything not mentioned here stays as they define it.
- **Design system:** `DESIGN.md` (Sawtooth). Where this doc and DESIGN.md disagree, DESIGN.md wins.

## 1. What changes

Spawned agents appear where the humans already look: nested under their spawner in the Agents tree, as blocks in the spawner's timeline, and as their own sessions. S7 adds one action (Terminate), one terminal state (Terminated, read-only forever), a workspace Pin, and a way to see agents that have ended. No new pages. The UI never parses prose: everything comes from the spec's §14 fields, events and tool calls.

**Terms.** "Spawned agent" in copy (never "ephemeral", which is the data model's word, or "child"). "Spawner" is never shown; copy says "spawned by @lead". "Terminate" for the act, "Terminated" for the state. "Workspace" for the agent's working directory. Agents are `@slug` in Geist Mono (S6). There is no "Ephemeral" badge: the display name's "· ab12" already marks a spawned agent, and the screen is calmer without it (decision Q18).

## 2. Status

`terminated` joins the status set, presented like S4's Archived (it is an end state, not a live one):

| Status | Slot | Long label | Short label |
|---|---|---|---|
| `terminated` | no dot (the empty 12px slot keeps alignment, as Archived) | Terminated | Terminated |

No new colour token. `document.title` = "Terminated · Tech Lead · ab12 · Open Factory". The S3 announcer says "Tech Lead · ab12 was terminated".

## 3. Agents list

- **Nesting:** spawned agents already nest under their spawner (they report to it); S4's elbow and indentation apply. Siblings sort by display name (S4), so "Tech Lead · ab12" sorts with its template's name.
- **Ended filter:** S4's Active/Archived radio pair becomes **Active / Ended** (`/agents?ended=only`; the API's `ended` replaces `archived`). Ended lists archived and terminated agents together; each row's status slot says "Archived" or "Terminated" (no dot). An ended agent whose manager is still active starts a new root in the Ended view (S4 rule). S4's "No archived agents." becomes "No ended agents." S5's running count stays hidden on Ended.
- **Inline note** (S5's single muted note after the name) gains, for terminated rows only: "workspace pinned" or "workspace deleted" (plain text; nothing when the workspace is still in its grace period).
- S4's Undo line after archiving is unchanged (Terminate has no undo; it navigates nowhere, §5).

## 4. Spawner's timeline

### 4.1 Spawn block

A `tool_call` named `mcp__factory__spawn_agent` with string `template`, `description` and `prompt` (paired with its result by `toolUseId`) renders as a **spawn block**, built like S6's outgoing message block (1px `rule` edge, 6px radius, no indent; any other shape falls back to S3's tool row; a call inside a subagent stays nested as S3 does):
- **Sender line:** the session's own agent in mono (plain), `ArrowRight` (`aria-hidden`), "spawned" in muted 13px, then the child: from the result, `@tech-lead-ab12` as a link to its session (S6's link style) and " · Tech Lead · ab12" muted; before a result exists, the template name in mono ("spawned from tech-lead"). Then the time.
- **Description:** the `description` argument as one muted 13px line, plain text (never Markdown: it's metadata).
- **Body:** the `prompt` (the brief) through `Markdown`, clamped like S6 (~8 lines, "Show all").
- **Footer** (muted 13px, past tense, never stale): no result and the turn open: "Spawning…" (it can take tens of seconds while plugins install); no result and the turn ended: "Not spawned"; success: "Spawned" + the child's status at that moment when it adds something ("· @tech-lead-ab12 was queued", "· … was rate-limited"; nothing for working/idle/hibernated), then the result's `note` as written (what inheritance didn't pass on); failure: S3's failed-tool treatment with the tool's sentence. "Show tool call" toggle as S6.

### 4.2 Terminate line

A `tool_call` named `mcp__factory__terminate_agent` with a string `slug` renders as one S3 `QuietLine` (`CircleStop` icon, muted): "Terminated `@tech-lead-ab12`" (the slug a link) on success; "Couldn't terminate `@x`: <the tool's sentence>" on failure (crimson icon, muted text); "Terminating `@x`…" with no result while the turn is open.

### 4.3 Updates and peer events

Children's text and facts arrive as S6 update groups, unchanged. Peer events for terminations the spawner didn't do itself render with S6's §2.4 line, built from `subject.left`: "`@tech-lead-ab12` · Tech Lead · ab12 left: terminated by `@or`" · "…left: terminated after 3 days without activity".

## 5. A spawned agent's session

### 5.1 Lifecycle lines

- First line (the `spawned` event): an S3 `QuietLine` with the `GitFork` icon: "Spawned by `@lead` from template `tech-lead`". `@lead` links to its session.
- `process_started` with reason `spawned`: no extra line (the line above covers it).
- Last line (the `terminated` event): `CircleStop` icon: "Terminated by `@lead`" · "Terminated by `@or`" · "Terminated after 3 days without activity".
- `background_work_lost` with reason `terminated`: S5's line, "Lost when it was terminated: …".

### 5.2 Live spawned agent

- **Agent strip:** S4's manager segment reads "Spawned by `@lead`" instead of "Reports to `@lead`".
- **Actions:** the composer works as for any agent (humans can message a spawned agent). S4's Edit link, Re-sync and Archive are absent. A **Terminate** ghost button (`CircleStop`) sits in the header actions slot after Compact and Interrupt (below `md`: an icon button with `aria-label` "Terminate @tech-lead-ab12" and a tooltip). While Errored, S5's recovery actions replace Compact and Interrupt; Terminate stays, so the header holds at most three actions.
- **Terminate confirmation** (S4 `ConfirmDialog`, Cancel focused, Esc closes; DESIGN.md destructive rule):
  - Title: "Terminate @tech-lead-ab12?"
  - Body: "Its process stops now and its session can't continue. Its workspace is deleted after 3 days unless you pin it. Worktrees it made in projects stay."
  - Confirm: "Terminate @tech-lead-ab12" (danger style).
  - On success the page stays on the session, which turns read-only (§5.3); focus moves to the strip's Pin button. A failure shows as a crimson outcome line under the header with the server's sentence; focus returns to Terminate.

### 5.3 Terminated agent (read-only)

- **Composer** replaced by a muted line: "This agent was terminated. Its session is read-only." Compact, Interrupt, Restart, Start a new session and Terminate are hidden. The timeline stays fully readable, including deep links.
- **Strip segment** (replacing S5's waiting/paused segments, which can't apply), plain text, dates in the viewer's local time (S5's format rules: "today 14:32", "Thu 09:10", "22 Nov 09:10"):
  - grace period: "Terminated by `@lead` on 19 Nov 14:32. Workspace deleted 22 Nov 14:32 unless pinned." + **Pin workspace** (ghost button, `Pin` icon);
  - pinned: "Terminated by `@lead` on 19 Nov 14:32. Workspace pinned." + **Unpin** (ghost button, `PinOff`);
  - deleted: "Terminated by `@lead` on 19 Nov 14:32. Workspace deleted 22 Nov 14:40." (no button);
  - TTL: "Terminated after 3 days without activity on …".
  - A "What's kept?" ghost button opens a popover: "The session history stays here for good. The workspace (its files and Claude config) is deleted after the grace period unless pinned. Worktrees and branches it made in projects are never deleted."
- **Pin** acts at once (no confirmation: nothing is lost) and the segment updates. **Unpin within the grace period** acts at once too. **Unpin after the grace period** is irreversible, so it confirms:
  - Title: "Unpin and delete @tech-lead-ab12's workspace?"
  - Body: "Its files and Claude config are removed within 10 minutes; its session history stays."
  - Confirm: "Delete workspace" (danger style).
- Never show ids (agent id, container id) anywhere.

## 6. Spawner's own pages

- **Archive refused:** S4's archive outcome line shows the `409 has_reports` sentence for live spawned agents ("@lead has live spawned agents: @a, @b. Terminate them first."), each slug a link to its session (where Terminate is).
- **Manager picker** (New agent, Edit): spawned agents are not offered.

## 7. Settings

- **Credentials:** usage counts only non-terminated agents; live spawned agents are covered by their spawner ("Used by @lead"), since they follow its credential. Delete is enabled when only terminated agents used it; its confirmation body gains nothing (the terminated agents keep their history).
- **Projects:** grants of terminated agents are gone, so Remove works as S4 defines.

## 8. Accessibility

- The spawn block is an `<article>` with `aria-label` "@lead spawned @tech-lead-ab12" (or "@lead is spawning from tech-lead").
- Terminate, Pin, Unpin and "What's kept?" are real buttons with distinct accessible names; the dialogs trap focus; focus moves per §5.2.
- The terminated strip segment is outside S4's `role="status"` region except the status itself, so a page load doesn't announce dates.
- All copy sentence case (PRODUCT.md).

## 9. Components

`apps/web/src/features/session/`: `SpawnBlock` (§4.1, on S6's outgoing-block shell), `TimelineRow` (terminate line, `spawned`/`terminated` lines, `background_work_lost` reason, peer-left terminated), `StatusBadge` (`terminated`), `AgentStrip` ("Spawned by", the terminated segment with Pin/Unpin and the popover), `TerminateButton` + `TerminateDialog` and `UnpinDialog` (on `ConfirmDialog`), the composer's terminated line. `apps/web/src/routes/_app/agents.index.tsx` and `features/agents/agent-tree.tsx`: Active/Ended, terminated rows, notes. `features/agents/agent-actions.tsx`: nothing for spawned agents; the has-reports links. `features/settings/credentials-section.tsx`: usage wording.

## 10. Fixed strings

"Active", "Ended", "No ended agents.", "Terminated", "Spawned", "Spawning…", "Not spawned", "spawned", "spawned from", "Spawned by @lead", "Spawned by @lead from template tech-lead", "Terminated @x", "Terminating @x…", "Couldn't terminate @x:", "Terminated by @lead", "Terminated after 3 days without activity", "Terminate", "Terminate @x?", "Terminate @x", "This agent was terminated. Its session is read-only.", "Pin workspace", "Unpin", "Workspace pinned.", "Workspace deleted …", "Workspace deleted … unless pinned.", "What's kept?", "Unpin and delete @x's workspace?", "Delete workspace", "workspace pinned", "workspace deleted", "Lost when it was terminated:", and the §4–§5 texts.
