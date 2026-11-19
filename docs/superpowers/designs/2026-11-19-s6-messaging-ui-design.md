# S6 Messaging and reporting line: UI Design

- **Date:** 2026-11-19
- **Status:** revised after the impeccable review against DESIGN.md (round 1)
- **Spec:** [`docs/superpowers/specs/2026-11-19-s6-messaging-reporting-design.md`](../specs/2026-11-19-s6-messaging-reporting-design.md)
- **Extends:** [S3 session UI](2026-11-18-s3-session-ui-design.md), [S4 templates, agents and settings UI](2026-11-19-s4-templates-agents-settings-ui-design.md), [S5 supervisor UI](2026-11-19-s5-supervisor-ui-design.md). Everything not mentioned here stays as they define it.
- **Design system:** `DESIGN.md` (Sawtooth). Where this doc and DESIGN.md disagree, DESIGN.md wins.

## 1. What changes

S6 makes conversations between agents readable from either side and keeps a manager's timeline calm while its reports work. No new pages: the Inbox page (an empty state since S1) gets a minimal list, the session timeline gets new sender lines and an outgoing block, and the agent strip's manager segment becomes an org segment. All data comes from the spec's §8.4 `message_in` fields (`parts`, `fact`, `subject`, `about`), §11 API and §13 events; **the UI never parses message prose**, and it renders every body exactly as the agent saw it.

**Terms.** "Message" is what someone sends on purpose. "Update" is a report's text forwarded to its manager (never "notification" or "activity"). Agents are written `@slug` in mono (`@dev`), as S4/S5 and DESIGN.md do (spec §7.1, decision R6; only the envelope's `from=` attribute, which the UI never shows, is bare); humans as `@handle` in mono; the factory as "Factory" (S5). "Sender → recipient" is the one direction format, used in the timeline and the Inbox.

## 2. Session timeline

### 2.1 Incoming direct messages (`kind="message"`)

S3's message block, unchanged in shape (1px `rule` edge, 6px radius, on the ground, body through `Markdown`, which renders no raw HTML). The sender line:
- **Agent sender:** the slug in Geist Mono 13px ink as a link to that agent's session, with a visible muted underline that turns signal on hover (S4's `FixLink` style), so agent senders are distinguishable from humans without hovering. After it, " · Developer" (the display name, muted), looked up from the cached agents list (envelopes carry no display name). An archived or unknown sender renders as the plain mono slug, no link, no display name. Then S3's Urgent label and time.
- **Human sender:** unchanged (`@or`, plain text).

### 2.2 Update groups (`kind="member_update"`)

A manager's timeline is conversation first; updates are context, and they will far outnumber messages. All consecutive `member_update` envelopes about one report in one `message_in` (its own text and factory facts about it, spec §8.4) render as **one update group**, an `<article>`:
- **Heading line, always shown, even when the group holds only factory facts:** an `ArrowUpFromLine` icon (`aria-hidden`, muted), "Update from" in muted 13px, the slug link (§2.1), and the **received** time (the `message_in` event's time, labelled with `title="Received 14:32:05"`), since a held update can arrive well after it was written. When the group's first part was written more than a minute before it was received, a muted "written 14:05" follows.
- **Edge:** a 1px `field-edge` bar on the left (≥3.2:1, WCAG 1.4.11; no thick stripe), 12px left padding, no border elsewhere and no radius, so it reads as quoted context without competing with message blocks.
- **Body:** the report's text parts through `Markdown`, separated by a 1px `rule` with 8px above and below. Text stays ink (it is what the report wrote).
- **Clamp:** a group of several parts shows only the **latest** part and a ghost button "Show all (5 updates)"; a single part longer than ~8 lines clamps with S3's "Show all". Expanded state is per group and not persisted.
- 4px between the heading and the first part; 12px between groups (S3's row gap).

### 2.3 Factory facts inside a group (`from="@factory" kind="member_update" about="dev"`)

S3's `QuietLine` inside the group, aligned with its left padding, keyed by `fact` (never by prose). The line's **text is the envelope body's first line exactly as the manager saw it**; the quoted part ("reported by @dev") goes into the line's expandable detail as a plain code-styled block. Icons:
- `turn_failed`, `errored`: `CircleAlert`, crimson icon, ink text (the facts that should stand out);
- `denied`: S3's denied rendering (`ShieldAlert` uncoloured, as in `timeline-row.tsx` `case "denied"`);
- `crashed`, `work_lost`: `CircleAlert` muted;
- `recovered`: `CircleCheck` muted.

The slug inside the line is plain text (the heading already links it).

### 2.4 Peer events (`peer_joined`, `peer_left`)

One `QuietLine` each, `Users` icon, built from `subject` (never from prose): "`@dev` · Developer joined as your peer" · "…joined as your report" · "`@dev` · Developer left: archived" · "…left: now reports to `@lead`" · "…left: now reports to the humans" (`to: null`). Several in one `message_in` stay as separate lines (they are rare).

### 2.5 Outgoing messages (the agent's own `send_message` call)

A `tool_call` named `mcp__factory__send_message` with a string `body` and string `to` (paired with its `tool_result` by `toolUseId`, S3) renders as an **outgoing message block** instead of the collapsed tool row. Any other shape (malformed input) falls back to S3's tool row. A call inside a subagent (`parentToolUseId`) stays in the parent's disclosure as S3 nests it, rendered there with the same block.
- Same block as §2.1 (rule edge, radius, **no indent**: indentation already means nesting in this timeline). Direction is in the sender line.
- **Sender line:** the session's own agent in mono (plain, not a link: it's this page), `ArrowRight` (`aria-hidden`), the recipient: the result's resolved `to` when there is a result, otherwise the call's argument: a slug as a link (§2.1), `@or` or `@humans` (plain mono). Then Urgent if set, then the time.
- **Body:** the `body` argument through `Markdown`, clamped like §2.1.
- **Footer line** (muted 13px), past tense, never stale:
  - no result and the call's turn still open: "Sending…";
  - no result and the turn ended / the process exited: "Not sent" (S3's no-result rule);
  - success to an agent: "Sent" + the recipient's status at send time: "· dev was hibernated", "· dev was queued", "· dev was rate-limited", "· dev was errored" (idle and working add nothing); then the result's `note` as written, if any;
  - success to humans: "Sent to the inbox";
  - failure (`isError`): S3's failed-tool treatment (small crimson icon, muted text), the tool's sentence as written. No link.
- **Links in the footer** (agent recipients, success): "View in session" (`aria-label="View this message in dev's session"`), a real link to `/agents/dev?message=<id>`: Cmd-click works, nothing is fetched on render. The session route resolves `message` through `GET /api/messages/:id`: a delivered message opens S3's deep-link window on `recipientEvent.seq` with the highlight; a pending one opens the newest page, where S3's dashed "Not delivered yet" block shows it; a `rejected` one opens the newest page with a muted line "This message wasn't delivered: dev was archived."; a `404` opens the newest page with S3's muted line "Message not found. Showing the latest."
- **"Show tool call":** a text toggle in the footer (`aria-expanded`) that expands S3's tool row beneath the block. No new hover menu.
- `mcp__factory__list_peers` stays a normal collapsed tool row (summary: `scope` or "neighborhood").

### 2.6 Held updates waiting

Pending held rows arrive in the `queue` frame as one item per group (`kind: "held"`, spec §13). They render as **one quiet line per group** at the end of the timeline (S3's queued-items position), never as dashed blocks, never ticking:
- `waitReason: "turn"`: "3 updates from `dev` waiting for this turn to end";
- `"window"`: "3 updates from `dev` waiting, delivered by 14:32" (the fixed `dueAt`, S5's time format);
- `"starting"`: "3 updates from `dev` waiting for this agent to start";
- `"errored"`: "3 updates from `dev` held until a human restarts this agent";
- `"rate_limited"`: "3 updates from `dev` held" + S5's reset phrase ("until 14:30" / "retrying at 14:30");
- `"ride_along"` (peer events only): one line for all of them, "2 peer changes waiting".

"Updates" counts every row in the group, facts included. The line sits outside any live region. It disappears when the next `queue` frame no longer lists it.

### 2.7 `mcp_unavailable`

S3's lifecycle `QuietLine` with a warning icon: "Factory tools didn't connect in this process, so it can't send messages until it restarts. Messages to it still arrive." The status (`failed`) is in the expandable detail. No action next to it: S5's Restart exists only for errored agents, and the next wake retries.

### 2.8 Announcements

S3's announcer said "Dev agent replied" when a turn with text ended. From S6, an agent's text isn't a reply to anyone, so the announcer says "**dev** messaged you" only when the turn contained a successful `send_message` to the watching human (`@handle`) or `@humans`, and keeps S3's status announcements. Updates, peer events and outgoing messages to agents are not announced.

## 3. Agent strip

S4's strip renders "reports to @{reportsTo}" / "No manager". The manager segment becomes the agent's place in the org (sentence case, `@slug` kept):
- "Reports to `@lead` · 3 reports"; "Reports to `@lead`"; "No manager · 3 reports"; "No manager". ("1 report" singular.)
- `@lead` links to its session. "3 reports" is plain text (the tree on `/agents` is one click away in the sidebar, and a link to the whole tree would surprise).
- Muted 13px like the rest of the strip, outside S5's `role="status"` region.

## 4. Inbox page (`/inbox`)

A minimal read-only list. S8 adds read state, mentions, task events and mark-all-read; nothing here should need undoing then.

```
┌ PageHeader: Inbox ────────────────────────────────────────────────┐
│ dev → @humans                                             14:32  │
│ Can someone approve the migration plan? It drops the…            │
├───────────────────────────────────────────────────────────────────┤
│ Factory about ops → @humans                         Yesterday 09:10│
│ ops is errored and needs a human.                                │
└───────────────────────────────────────────────────────────────────┘
```

- S3's agents-list pattern: a plain list in the page body, rows separated by 1px `rule` lines, each row **one link** (always: the spec's `link` always names a session), hover the `steel-hover` fill, instant. Rows are two lines (sender line, preview), min 56px.
- **Sender line:** the sender (agent slug in mono ink; "Factory" + muted "about `ops`" for factory items), `ArrowRight`, the recipient as addressed (`@or` or `@humans`, mono, muted), the Urgent label if set, and the time at the right: S5's `formatResetTime` style for the past (`14:32` today, `Yesterday 14:32`, `27 Nov 09:10`, and `27 Nov 2025 09:10` for another year); `<time>` with the full timestamp as `title`.
- **Preview:** the first 280 characters as **plain text** (Markdown syntax shown as typed), one line with an ellipsis; two lines below `md`.
- **Target:** `/agents/<link.agentSlug>?event=<link.seq>` (S3's deep-link window and highlight on the sender's `send_message` call), or `/agents/<link.agentSlug>` when there is no `seq`.
- **States:** loading: S1's route pending state on first load; empty: S1's "Nothing in your inbox."; fetch error: one crimson line with an icon, "Couldn't load the inbox.", and a ghost "Retry".
- **Paging:** "Load earlier" (S3's term) at the end when `nextCursor` is set; a failed page load shows an inline "Couldn't load earlier messages." with "Retry" in its place.
- **Live:** the list is one infinite query merged by `id`, keyed by `id` (keyboard focus survives a refetch). `inbox_changed` refetches the newest page and merges it; new rows are added at the top with `overflow-anchor` keeping the scroll position when the user has scrolled down. Not announced (no read state yet).
- No unread dot, no count badge in the sidebar (S8).

## 5. Accessibility

- Update groups and outgoing blocks are `<article>` elements (no landmarks: a busy manager timeline would otherwise expose dozens of regions inside S3's `role="log"`), with `aria-label` "Update from dev" / "Message from dev to lead". S3's roving focus treats each as one row; links and buttons inside follow S3's pattern (`tabIndex` 0 only on the focused row, as `CopyLink` does).
- Every link names its target in its accessible name ("View this message in dev's session", "Open dev's session").
- Icons are `aria-hidden`; text carries the meaning (Status Is Never Colour Alone).
- The Inbox is a `<ul aria-label="Inbox">`; each row link's accessible name is "From dev to @humans, urgent, 14:32" (urgent only when set), with the preview attached through `aria-describedby`.
- Announcements: §2.8.

## 6. Responsive

Below `md`: the update bar and padding stay; Inbox previews take two lines; the strip's org segment wraps with the others; the outgoing footer wraps before its links.

## 7. Components

`apps/web/src/features/session/`: `MessageBlock` (agent sender line), `UpdateGroup` (new), `OutgoingMessage` (new, wraps the `send_message` tool pair), `TimelineRow` (new kinds, `mcp_unavailable`), `QueueItems` (held lines), `AgentStrip` (org segment), `session-view` (`?message=` resolution), the announcer (§2.8). `apps/web/src/features/inbox/`: `InboxList`, `api.ts`. `apps/web/src/routes/_app/inbox.tsx`: the list.

## 8. Fixed strings

"Update from", "Received", "written 14:05", "Show all (5 updates)", "Sending…", "Not sent", "Sent", "dev was hibernated", "dev was queued", "dev was rate-limited", "dev was errored", "Sent to the inbox", "View in session", "Show tool call", "Message not found. Showing the latest.", "3 updates from dev waiting for this turn to end", "3 updates from dev waiting, delivered by 14:32", "3 updates from dev waiting for this agent to start", "3 updates from dev held until a human restarts this agent", "This message wasn't delivered: dev was archived.", "left: now reports to the humans", "3 updates from dev held", "2 peer changes waiting", "joined as your peer", "joined as your report", "left: archived", "left: now reports to lead", "Reports to", "No manager", "1 report", "3 reports", "about", "Load earlier", "Couldn't load the inbox.", "Couldn't load earlier messages.", "Retry", "dev messaged you", "Factory tools didn't connect in this process, so it can't send messages until it restarts. Messages to it still arrive."
