# S6 Messaging and reporting line: UI Design

- **Date:** 2026-11-19
- **Status:** draft, pending the impeccable review against DESIGN.md
- **Spec:** [`docs/superpowers/specs/2026-11-19-s6-messaging-reporting-design.md`](../specs/2026-11-19-s6-messaging-reporting-design.md)
- **Extends:** [S3 session UI](2026-11-18-s3-session-ui-design.md), [S4 templates, agents and settings UI](2026-11-19-s4-templates-agents-settings-ui-design.md), [S5 supervisor UI](2026-11-19-s5-supervisor-ui-design.md). Everything not mentioned here stays as they define it.
- **Design system:** `DESIGN.md` (Sawtooth). Where this doc and DESIGN.md disagree, DESIGN.md wins.

## 1. What changes

S6 makes conversations between agents readable from either side and lets a manager's timeline stay calm while its reports work. No new pages: the Inbox page (an empty state since S1) gets a minimal list, the session timeline gets new sender lines and an outgoing block, and the agent strip gains a reports count. Every piece of data comes from the spec's §8.4 envelopes, §11 API and §13 events.

**Terms.** "Message" is what someone sends on purpose. "Update" is a report's text forwarded to its manager (never "notification" or "activity"). Agents are written as their slug in mono (`dev`) wherever the product writes a sender; humans as `@handle` in mono; the factory as "Factory" (S5).

## 2. Session timeline

### 2.1 Incoming direct messages (`kind="message"`)

S3's message block, unchanged in shape (1px `rule` edge, 6px radius, on the ground, body through `Markdown`, which renders no raw HTML). The sender line:
- **Agent sender:** the slug in Geist Mono 13px ink, as a link to that agent's session (`/agents/dev`), underline on hover only (the S1 link style). After it, the muted display name ("dev · Developer") so a human who doesn't know every slug can still read it. Then the S3 Urgent label and time.
- **Human sender:** unchanged (`@or`, plain text).
- The sender line link is the block's only interactive element besides S3's "Show all" and Copy link.

### 2.2 Update groups (`kind="member_update"`)

A manager's timeline is conversation first; updates are context. One envelope (which may carry several merged blocks, spec §8.4) renders as **one update group**, quieter than a message:
- **No border, no radius.** A 2px `rule` bar on the left edge (the only edge), 12px left padding, so the group reads as "quoted from someone" without competing with direct messages.
- **Sender line:** an `ArrowUpFromLine` icon (`aria-hidden`, muted), "Update from" in muted 13px, then the slug as a link (as §2.1), then the time of the group's last block.
- **Body:** each block through `Markdown`, separated by a 1px `rule` line with 8px space above and below. Text colour stays ink (it is what the report wrote).
- **Clamping:** a group longer than ~20 lines clamps with S3's "Show all" (lower than S3's 40 for messages, because updates are skimmed).
- Consecutive envelopes in one `message_in` from the same report (its text, then a factory fact about it, then more text) stay visually together: 4px between them instead of the usual 12px.

### 2.3 Factory facts about a report (`from="@factory" kind="member_update" about="dev"`)

S3's `QuietLine` inside the report's group position (no bar of its own, aligned with the group's left padding): 13px muted text with an icon, never crimson for routine facts:
- "Turn failed: <message>" (`CircleAlert`, crimson icon, ink text: an error is the one fact that should stand out, as S5's "Stopped unexpectedly");
- "Denied Bash: <reason>" (`ShieldAlert`, warning icon), reason truncated to one line, expandable;
- "dev stopped unexpectedly during a turn; recovery under way" · "dev is errored and needs a human: <error>" (crimson icon, ink) · "dev recovered" · "Stopped background tasks of dev: pnpm test".

The slug in these lines is a link to that agent's session.

### 2.4 Peer events (`peer_joined`, `peer_left`)

One `QuietLine` each, `Users` icon: "dev (Developer) joined as your peer" · "joined as your report" · "dev (Developer) left: archived" · "left: now reports to lead". The description from the envelope body is in the line's expandable detail, not inline.

### 2.5 Outgoing messages (the agent's own `send_message` call)

A `tool_call` named `mcp__factory__send_message` (paired with its `tool_result` by `toolUseId`, S3) renders as an **outgoing message block** instead of the collapsed tool row:
- Same block as §2.1 (rule edge, radius), so a conversation reads the same from both sides, but **indented 32px from the left** of the timeline column, the one visual cue for "this agent said this to someone". No colour, no right alignment (S3: no bubbles).
- **Sender line:** `ArrowRight` icon (muted), "To", then the recipient: a slug as a link, `@or`, or `@humans` (plain, mono). Then Urgent if set, then the time.
- **Body:** the `body` argument through `Markdown`, clamped like §2.1.
- **Footer line** (muted 13px), from the tool result:
  - while the call has no result and the turn is open: "Sending…";
  - success: the recipient's status at send time, as a short phrase: "Delivered" (idle/working, humans), "Waking dev" (hibernated), "Queued" (queued), "Waiting: rate-limited" (rate-limited), and the result's `note` verbatim when present ("dev is errored; your message will be delivered when a human restarts it.");
  - then, for agent recipients, a **"View in dev's session"** ghost link. It calls `GET /api/messages/:id` on click (not on render, so a long timeline doesn't fire a request per row) and navigates to `/agents/dev?event=<seq>`; if the message isn't delivered yet (no `recipientEvent`), it navigates to the recipient's session without `event` and shows S3's "Not delivered yet" block there.
  - failure (`isError`): a crimson icon and the tool's sentence in ink ("No agent or user named 'x'. Call list_peers…"). No link.
- The raw tool call stays reachable: the block's `⋯`/hover menu (S3's Copy link slot) gains "Show tool call", which expands the S3 tool row beneath it.
- `mcp__factory__list_peers` stays a normal collapsed tool row (summary: `scope` or "neighborhood").

### 2.6 Held updates in the queue

Pending held rows come in the `queue` frame as one item per group (`kind: "held"`, spec §13). They render as **one quiet line** at the end of the timeline (S3's queued-items position), never as dashed blocks: "3 updates from dev waiting · delivered when this agent's turn ends or within 30 s" (the seconds left until the item's `dueAt`, rounded up, refreshed each second only while the line is on screen; "delivered with its next turn" once `dueAt` has passed while a turn is open). Several groups: one line each, in group order. Peer events waiting: "1 org change waiting". They disappear when the next `queue` frame no longer lists them.

### 2.7 `mcp_unavailable`

S3's lifecycle `QuietLine` with a warning icon: "Factory tools unavailable in this process (failed). Messages to it still arrive; it can't send until it restarts."

## 3. Agent strip

S4's strip shows "slug · template · manager · credential · runtime". The manager segment becomes the agent's place in the org:
- with a manager and reports: "reports to `lead` · 3 reports";
- with a manager only: "reports to `lead`";
- top-level with reports: "no manager · 3 reports";
- top-level without reports: "no manager".

`lead` links to its session. "3 reports" links to `/agents` (the tree, where they are listed). Muted 13px text like the rest of the strip, outside S5's `role="status"` region (it isn't live status).

## 4. Inbox page (`/inbox`)

A minimal read-only list. S8 adds read state, mentions, task events and mark-all-read; nothing here should need undoing then.

```
┌ PageHeader: Inbox ────────────────────────────────────────────────┐
│ dev  → @humans                                          14:32    │
│ Can someone approve the migration plan? It drops the…            │
├───────────────────────────────────────────────────────────────────┤
│ Factory  about ops → @humans                       Yesterday 09:10│
│ ops is errored and needs a human: No conversation found…         │
└───────────────────────────────────────────────────────────────────┘
```

- S3's agents-list pattern: a plain list inside the page body, rows separated by 1px `rule` lines, each row **one link** to its target, hover is the `steel-hover` fill, instant. Rows are two lines (sender line, preview), min 56px.
- **Sender line:** the sender (agent slug in mono ink; "Factory" with `about <slug>` in muted text for factory items), an `ArrowRight` and the recipient as addressed (`@or` or `@humans`, mono, muted), Urgent label if set, and the time at the right (`HH:mm` today, `Yesterday HH:mm`, then `27 Nov HH:mm`; `<time>` with the full timestamp as `title`).
- **Preview:** the first 280 characters as **plain text** (no Markdown, markdown syntax shown as typed), one line, truncated with an ellipsis. Below `md`, two lines.
- **Target:** the sender's `send_message` call (`/agents/<sender>?event=<seq>`, S3's deep-link window and highlight). A factory item links to the subject agent's session. If the link can't be resolved (`link: null`), the row is not a link and its preview line ends with "Source not available" in muted text.
- **Empty:** S1's existing "Nothing in your inbox." line.
- **Paging:** "Load older" ghost button at the end when `nextCursor` is set.
- **Live:** the `inbox_changed` frame refetches the first page; new rows appear at the top without moving the scroll position when the user has scrolled down. Not announced (no read state yet, so no count to announce).
- No unread dot, no count badge in the sidebar (S8).

## 5. Accessibility

- Update groups are `<section aria-label="Update from dev">`; outgoing blocks are `<article aria-label="Message to dev">`; S3's roving focus treats each as one row.
- S3's announcer adds nothing for updates or peer events (they aren't replies); an outgoing message's failure is not announced either (the agent handles it).
- Every link names its target: "View in dev's session", the slug links read as "dev, open session" via `aria-label`.
- Icons are `aria-hidden`; the text carries the meaning (Status Is Never Colour Alone).
- The Inbox list is a `<ul aria-label="Inbox">`; each row link's accessible name is "From dev to @humans, 14:32: <preview>".

## 6. Responsive

- Below `md`: outgoing blocks indent 16px instead of 32px; the update bar stays 2px; Inbox previews take two lines; the strip's org segment wraps with the others.

## 7. Components

`apps/web/src/features/session/`: `MessageBlock` (agent sender line), `UpdateGroup` (new), `OutgoingMessage` (new, wraps the send_message tool pair), `ViewInSessionLink` (new, lazy lookup), `TimelineRow` (new kinds, `mcp_unavailable`), `QueueItems` (held line), `AgentStrip` (org segment). `apps/web/src/features/inbox/`: `InboxList`, `api.ts`. `apps/web/src/routes/_app/inbox.tsx`: the list.

## 8. Fixed strings

"Update from", "To", "Sending…", "Delivered", "Waking dev", "Queued", "Waiting: rate-limited", "View in dev's session", "Show tool call", "3 updates from dev waiting · delivered when this agent's turn ends or within 30 s", "1 org change waiting", "joined as your peer", "joined as your report", "left: archived", "left: now reports to lead", "reports to", "no manager", "3 reports", "1 report", "Load older", "Source not available", "Factory tools unavailable in this process (failed). Messages to it still arrive; it can't send until it restarts.", and the §2.3 lines.
