# S3 Session view: UI Design

- **Date:** 2026-11-18
- **Author:** tech-lead-s3
- **Status:** reviewed against DESIGN.md (impeccable review; findings applied, see the decision issue)
- **Spec:** [`docs/superpowers/specs/2026-11-18-s3-walking-skeleton-design.md`](../specs/2026-11-18-s3-walking-skeleton-design.md)
- **Binding:** [`DESIGN.md`](../../../DESIGN.md) (Sawtooth) and [`PRODUCT.md`](../../../PRODUCT.md). Where this doc and DESIGN.md disagree, DESIGN.md wins.
- **Product behaviour:** `docs/product/behavior/agents-and-sessions.md` (Session view), `docs/product/concepts/session.md`.

This is the product's most-used screen: a tab left open for hours next to the editor, watching an agent work. Later specs extend it (S5 lifecycle, Restart and "what keeps it awake", S6 agent senders and member updates, S7 spawn and Terminate, S8 tasks, S9 cron pins, S10 usage), so the structure here has to take those additions without a redesign. S3 builds only what is listed as S3. Every piece of data used here comes from the spec's §6 events, §9 API and §10 frames.

## 1. Screens and routes

| Route | Screen | File |
|---|---|---|
| `/agents` | Agents list (replaces the S1 empty state) | `routes/_app/agents.index.tsx` |
| `/agents/$slug` | Session view | `routes/_app/agents.$slug.tsx` |
| `/agents/$slug?event=<seq>` | Session view showing a window around event `seq`, highlighted | same |

The sidebar's Agents item stays active on both routes.

## 2. Agents list

A plain list inside the page body, not cards (DESIGN.md: dense, structure from rules). One row per agent, 44px tall, separated by 1px `rule` lines, the whole row one link:

```
[▲] Working   Dev agent   dev                                  Unsandboxed
```

- **Status:** a fixed 12×12px slot holding either the 6px dot in `--status-<name>` or, for `working`, the `.of-tooth` (DESIGN.md → The pitch), so labels line up. Always followed by the label (Status Is Never Colour Alone). S3 labels: Hibernated, Working, Idle, Errored. After a server boot every agent is Hibernated until it is messaged.
- **Display name** in 14px ink; **slug** in Geist Mono 13px muted (it is an identifier).
- **Unsandboxed** badge at the right: 13px muted text in a 1px `rule` outline, radius `sm`, no fill, no colour. No tooltip here (it would be an interactive element inside a link); the session view's agent strip explains it.
- Empty: "No agents yet. Run `pnpm seed:dev-agent` to create the dev agent." (one muted line, the command in mono).
- Status updates arrive from `agent_status` frames, which every socket receives. Hover is the `steel-hover` fill, instant (frequency decides).

## 3. Session view layout

```
┌ PageHeader (48px) ─────────────────────────────────────────────────────────┐
│ ☰  Dev agent  [▲] Working                                [Compact] [Interrupt]│
├ Agent strip (32px) ────────────────────────────────────────────────────────┤
│ dev · Unsandboxed: runs directly on this machine                           │
├────────────────────────────────────────────────────────────────────────────┤
│ (reconnect strip, S1)                                                      │
│   timeline (the only scrolling region)       content max-width 52rem       │
│                                            [↓ 3 new events]                │
├────────────────────────────────────────────────────────────────────────────┤
│ composer                                           ◻ Urgent   [Send]       │
└────────────────────────────────────────────────────────────────────────────┘
```

- The page is a column filling the content area: header, agent strip, timeline, composer pinned to the bottom. No outer page scroll.
- **Header (48px):** the `PageHeader` with the display name as the h1, then the status (slot + label) through a new optional `meta` slot on `PageHeader` (spec §15), then the actions on the right. `document.title` = "Working · Dev agent · Open Factory" (status first, so a background tab shows when the agent finishes).
- **Agent strip (32px):** muted 13px text on the ground with a bottom `rule`: the slug in mono, then "Unsandboxed: runs directly on this machine". This strip is where later specs add "waiting on: pnpm test (background, 3m)", "pinned by 2 crons", usage and linked tasks, so the header never has to hold them. On narrow screens it wraps; it never moves into the timeline.
- Timeline content is capped at 52rem and left-aligned with the page gutter, so long lines stay readable and the left edge lines up with the header.
- Header actions are ghost buttons with icon + label: **Compact** (`Minimize2`) and **Interrupt** (`Square`). S5 adds Restart in the same slot. Below `md` they become icon buttons with `aria-label`s and tooltips.

## 4. Timeline

One continuous column in seq order. No bubbles, no avatars, no left/right alignment: rows separated by spacing (12px between rows, 24px before incoming input), the way a log reads. Every row has `id="event-<seq>"`.

### 4.1 Row types (S3)

| Event | Rendering |
|---|---|
| `message_in` | One block per envelope: **incoming input**. A sender line: the handle in Geist Mono 13px ink (`@or`); for urgent messages an "Urgent" label in 13px ink inside a 1px `rule` outline (like the Unsandboxed badge, never orange: a delivered message is not live); then the absolute time `HH:mm` in muted text (`<time>` with the full timestamp as `title`). Below, the body through the S1 `Markdown` component. The block has a 1px `rule` edge and 6px radius on the **ground** (no plate fill, so code blocks inside it, which sit on a plate, stay visible and nothing is nested). Bodies longer than ~40 lines clamp with a "Show all" button. The sender line is generic (`from` + `kind`), so S6's agent senders, member updates and peer events reuse the block with a different badge. Never raw XML. |
| queued message (`queue` item, kind message) | The same block at the end of the timeline, at full opacity, with a dashed 1px `field-edge` border, a clock icon and "Not delivered yet" in muted text instead of the time. If `agent_status.lastError` is set: "Not delivered yet: <lastError>". It disappears when its `message_in` arrives. |
| queued compact (`queue` item, kind compact) | A quiet line with a clock icon: "Compact queued until the turn ends" (with the focus text if any). Replaced by the `control` line when written. |
| `assistant_text` (no `parentToolUseId`) | The text through `Markdown`, directly on the ground. The agent's voice and the bulk of the timeline. |
| `tool_call` (+ its `tool_result`, paired by `toolUseId`) | One **collapsed** 32px row: a chevron, the tool name in mono (`Bash`, `Read`, `mcp__…`), and a one-line summary in **mono** muted text, truncated with an ellipsis: Bash → `command`, Read/Edit/Write → file path, Grep/Glob → pattern, others → the first string field of the input. State label at the right: "Running" while no result has arrived and the call's turn is open; "No result" (muted) once the turn has ended, the process exited, or a later turn started without a result; "Failed" with a crimson icon for `isError`. Expanded: the input (the Bash command as a code block, other tools as formatted JSON) and the result in code blocks (plate, mono 13px), each capped at 24rem with its own scroll, with "Truncated (1.2 MB)" under a capped field. A `tool_result` whose call isn't loaded (it's on an earlier page) renders as its own collapsed row "Result for an earlier call". **Nested work** (`tool_call`, `tool_result` and `assistant_text` with a `parentToolUseId`, i.e. a subagent's activity) renders inside the parent call's disclosure, indented 16px, collapsed with it, never as the agent's own voice. |
| `compacted` | A full-width divider: a 1px `rule` line with a centred muted label "Compacted (manual) · 27.5k → 15.3k tokens" (or "(auto)"). Expandable to show the summary in a code-styled plate when one exists; not expandable otherwise. |
| `compact_failed` | A quiet line with a warning icon: "Compact skipped: Not enough messages to compact." |
| `control` | A quiet line, 13px muted: "`@or` asked to compact: <focus>" or "`@or` interrupted" (handle in mono). |
| `turn_end` with `isError` | A quiet line: "Turn interrupted" for `aborted_tools`, "Turn ended with an error" otherwise. Successful `turn_end`s render nothing. |
| `error` | A row with a crimson icon and the message in ink, the detail (stderr line) in mono below. Spawn and resume errors say what to do ("Set CLAUDE_CODE_OAUTH_TOKEN to run agents", "Run `pnpm seed:dev-agent --reset-session` to start a new session"). |
| `delivery_failed` | A quiet line with a warning icon: "Not delivered: <reason>. It will be sent again on the next start." |
| `permission_denied` | A row with a warning icon: "Denied: Bash" and the reason in muted text, expandable for the full message. |
| `process_started` / `exited` / `session_reset` | Quiet lifecycle lines: "Started" / "Resumed session"; "Stopped"; "Exited unexpectedly (code 1)" or "(SIGTERM)" when there is only a signal, with the stderr tail expandable; "Session reset". |
| `background_task_started` / `_finished`, `cron_*`, `rate_limited` | Quiet one-liners: "Background task started: <description or taskType>", "Background task <status>: <summary>", "Cron created: every minute", "Cron deleted", "Rate limited until 14:30". |
| `session_started`, `turn_started`, `usage`, `background_tasks` | Not rendered. |

### 4.2 Working indicator

While the status is `working`, the last row of the timeline is a 24px line with the `.of-tooth` and "Working". It is static (the loading mark is the only authored animation) and disappears instantly when the status changes.

### 4.3 Scrolling and deep links

- **Stick to bottom:** within 64px of the bottom, new events keep the view pinned (instant, no smooth scroll).
- **Reading history:** when scrolled up, new events don't move the view. A "↓ N new events" pill (ghost button on a plate, bottom-right of the timeline) appears; clicking it jumps to the bottom instantly. It is not announced (see §7).
- **Load earlier:** a "Load earlier" ghost button at the top when `hasMore.before`, "Loading…" while it loads, scroll anchored on the first visible row.
- **Deep link (`?event=<seq>`):** load `?around=<seq>`, centre that row, and mark it with a 26% signal tint background (the selection colour from DESIGN.md → Browser surfaces), distinct from the 2px focus ring. The tint stays until the user navigates or clicks elsewhere. While the window has newer events (`hasMore.after`), live events are **not** appended; they are counted into a "Jump to latest · N new" control that loads the newest page and pins to the bottom (the socket subscribes with `lastSeq` from `GET /api/agents/:slug`, spec §10). A `404 event_not_found` loads the newest page with a muted line at the top: "Event 412 isn't in this session. Showing the latest."
- **Copy link:** each row has a "Copy link" icon button (copies `/agents/$slug?event=<seq>`), shown on hover and on `:focus-within`. On touch (`pointer: coarse`) it is an always-visible `⋯` button at the row's end with "Copy link" as its only item for now. This is the deep-link source until the inbox (S8).

### 4.4 States

- **Loading:** the S1 route pending component on first load only.
- **Empty session:** one muted line: "No messages yet. Send the first one below."
- **Agent not found:** the S1 NotFound state.
- **Errored:** the status reads "Errored" (crimson dot), and the latest `error` row says why. The composer stays enabled: sending is how the human retries (spec §11).
- **Disconnected:** the S1 reconnect strip. The composer stays enabled (HTTP still works); the client inserts the `202` response's queue item locally at once so the message shows even without the socket, and resubscribes with its last seq on reconnect.

## 5. Composer

- A `Textarea` with the `field-edge` boundary on a plate, auto-growing from 2 to 12 lines (6 below `md`), then scrolling. Placeholder "Message Dev agent"; visually hidden label "Message to Dev agent".
- **Enter sends, Shift+Enter inserts a newline**, IME composition respected. On touch (`pointer: coarse`) Enter inserts a newline and only the button sends.
- **Urgent:** a checkbox labelled "Urgent" to the left of Send. When checked, Send reads "Send urgent" and a muted hint appears under the composer: "Interrupts the current turn, then runs next." or, while idle, "Dev agent is idle, so this sends normally." It resets to off after each send.
- **Send** is the primary button (graphite, never orange), disabled for empty or whitespace text and while the POST is in flight. The text clears when the server accepts it (`202`), and also on `503 agent_start_failed` (the message is queued and shows "Not delivered yet: <reason>"). Other errors (validation, network) show inline under the composer in crimson with an icon, and the text stays.
- The composer never interprets slash commands: "/compact" is plain text to the agent.
- The draft is kept per agent in `sessionStorage` (wrapped in try/catch).

## 6. Actions

- **Compact:** a popover anchored to the button (shadcn `popover`; grows from its trigger in 100ms; under reduced motion only the fade remains). On open, focus moves to a single-line input "Focus (optional)"; Enter or the primary "Compact" button submits; Escape closes; focus returns to the trigger on close or submit. No confirmation. If the request fails, the error shows inside the popover (crimson, with an icon) and it stays open. On success the popover closes and the queued-compact line (§4.1) shows until the compact is written.
- **Interrupt:** enabled only while `turnOpen` (from `agent_status`). It uses `aria-disabled` rather than `disabled`, so its tooltip "Nothing to interrupt." still shows and it stays focusable; clicks while not enabled do nothing. After a click it stays disabled until the status changes. A `409` (the turn ended meanwhile) is ignored. No confirmation (DESIGN.md: forgiveness over confirmation; nothing is lost that can't be resent).

## 7. Accessibility and keyboard

- The timeline is a `role="log"` region with `aria-label="Session"` and `aria-live="off"`. A separate visually hidden `role="status"` region announces only: "Dev agent replied" when a turn with assistant text ends, errors, and status changes ("Dev agent is working").
- **One tab stop for the timeline** with roving focus over rows: Up/Down move between rows, Home/End jump to the first/last loaded row, Enter/Space toggles a disclosure on the focused row, and Tab leaves the timeline. Copy link is reachable as the focused row's secondary button (`:focus-within`). A visually hidden "Skip to composer" link is the first focusable element of the view.
- Focus order: Skip to composer, header actions, timeline, "N new events" pill, composer, Urgent, Send. After sending, focus stays in the composer.
- All text in rem; colours from tokens; status never colour alone; focus-visible is the 2px signal ring.

## 8. Responsive

- Below `md`: gutters 16px, header actions become icon buttons, the agent strip wraps, tool summaries truncate earlier, Copy link is the `⋯` button, and Enter in the composer inserts a newline.
- The 52rem cap only matters from `lg` up.
- Long content: prose tables and code blocks scroll horizontally (`overflow-x: auto`), long unbroken tokens wrap (`overflow-wrap: anywhere`).

## 9. Components to add

`apps/web/src/features/session/`: `SessionView`, `AgentStrip`, `Timeline` (roving focus), `TimelineRow` (switch on event type), `MessageBlock`, `ToolCallRow` (with nested children), `CompactionMarker`, `QuietLine`, `QueueItems`, `Composer`, `CompactPopover`, `StatusBadge` (shared with the Agents list), `UnsandboxedBadge`, `useSessionEvents` (HTTP pages + WS subscription + dedup by seq + queue + status + deep-link window). shadcn additions: `popover`, `checkbox`. `PageHeader` gains an optional `meta` slot.

## 10. Copy

Sentence case, calm, specific (PRODUCT.md). Fixed strings: "Not delivered yet", "Compact queued until the turn ends", "Working", "Turn interrupted", "Turn ended with an error", "Compacted (manual) · 27.5k → 15.3k tokens", "Compact skipped: …", "No result", "Running", "Failed", "Load earlier", "Jump to latest · N new", "Nothing to interrupt.", "Send", "Send urgent", "Urgent", "Interrupts the current turn, then runs next.", "Dev agent is idle, so this sends normally.", "Compact", "Interrupt", "Focus (optional)", "No messages yet. Send the first one below.", "Event 412 isn't in this session. Showing the latest.", "Unsandboxed: runs directly on this machine". Token counts: one decimal with `k` (27.5k), no decimals at 100k and above.
