# S3 Session view: UI Design

- **Date:** 2026-11-18
- **Author:** tech-lead-s3
- **Status:** draft, reviewed against DESIGN.md (impeccable review, see the decision issue)
- **Spec:** [`docs/superpowers/specs/2026-11-18-s3-walking-skeleton-design.md`](../specs/2026-11-18-s3-walking-skeleton-design.md)
- **Binding:** [`DESIGN.md`](../../../DESIGN.md) (Sawtooth) and [`PRODUCT.md`](../../../PRODUCT.md). Where this doc and DESIGN.md disagree, DESIGN.md wins.
- **Product behaviour:** `docs/product/behavior/agents-and-sessions.md` (Session view), `docs/product/concepts/session.md`.

This is the product's most-used screen: a tab left open for hours next to the editor, watching an agent work. Later specs extend it (S5 lifecycle and Restart, S6 agent senders and member updates, S7 spawn and Terminate, S8 tasks, S9 cron pins), so the structure here has to take those additions without a redesign. S3 builds only what is listed as S3.

## 1. Screens and routes

| Route | Screen |
|---|---|
| `/agents` | Agents list (replaces the S1 empty state) |
| `/agents/$slug` | Session view |
| `/agents/$slug?event=<seq>` | Session view scrolled to event `seq`, highlighted |

The sidebar's Agents item stays active on both routes.

## 2. Agents list

A plain list inside the page body, not cards (DESIGN.md: dense, structure from rules). One row per agent, 44px tall, separated by 1px `rule` lines, full-row link:

```
● Working   Dev agent   dev                                 Unsandboxed
```

- **Status:** 6px dot in `--status-<name>` plus the label (Status Is Never Colour Alone). `working` uses the `.of-tooth` shape instead of a dot, per DESIGN.md → The pitch.
- **Display name** in 14px ink, **slug** in Geist Mono 13px muted (it is an identifier).
- **Unsandboxed** badge at the right: 13px muted text with a 1px `rule` outline, radius `sm`, no fill, no colour. Tooltip: "Runs directly on this machine, without a container."
- Empty: "No agents yet. Run `pnpm seed:dev-agent` to create the dev agent." (one muted line, the command in mono).
- Status updates arrive over WS (`agent_status`), so the list subscribes to the status of the listed agents. Hover: `steel-hover` fill, colour-only 150ms.

## 3. Session view layout

```
┌ PageHeader ───────────────────────────────────────────────────────────────┐
│ ☰  Dev agent  dev  ● Idle  Unsandboxed                [Compact] [Interrupt]│
├───────────────────────────────────────────────────────────────────────────┤
│ (reconnect strip, S1)                                                     │
│                                                                           │
│   timeline (scrolls)                         max-width 52rem, left-aligned │
│                                                                           │
│                                           [↓ 3 new events]  (when away)   │
├───────────────────────────────────────────────────────────────────────────┤
│ composer: textarea                                     Urgent ◻   [Send]  │
└───────────────────────────────────────────────────────────────────────────┘
```

- The page is a column filling the content area: header (48px), the timeline (the only scrolling region), the composer pinned to the bottom. No outer page scroll.
- The `PageHeader` title is the display name. The slug (mono, muted), the status (dot + label) and the Unsandboxed badge sit after the h1 in the same 48px strip. `document.title` = "Dev agent · Open Factory".
- Timeline content is capped at 52rem and left-aligned with the page gutter, so long lines stay readable on wide screens and the left edge lines up with the header.
- Header actions are ghost buttons with icon + label: **Compact** and **Interrupt**. S5 adds Restart in the same slot.

## 4. Timeline

One continuous column in seq order. No bubbles, no avatars, no left/right alignment: rows separated by spacing (12px between rows, 24px before a new incoming message), the way a log reads. Every row has `id="event-<seq>"` for deep links.

### 4.1 Row types (S3)

| Event | Rendering |
|---|---|
| `message_in` | One block per envelope. A **sender badge** line: the handle in Geist Mono 13px ink (`@or`), then "urgent" as a small text label in `signal-text` when urgent, then the relative time (muted, `<time>` with the full timestamp as title). Below it the body through the S1 `Markdown` component. The block sits on a `plate` with a 1px `rule` edge and 6px radius, so human input is distinguishable from agent output without colour. Never raw XML. |
| pending message (from `pending_messages`) | Same block, at the end of the timeline, at 60% opacity, with "Not delivered yet" (or "Not delivered: <reason>" when the last start failed) in muted text instead of the time. It disappears when its `message_in` arrives. |
| `assistant_text` | The text through `Markdown`, directly on the ground (no plate). This is the agent's voice and the bulk of the timeline. |
| `tool_call` (+ its `tool_result`, paired by `toolUseId`) | One **collapsed** row, 32px: a chevron, the tool name in mono (`Bash`, `Read`, `mcp__…`), and a one-line summary in muted text, truncated with an ellipsis: Bash → `command`, Read/Edit/Write → file path, Grep/Glob → pattern, others → the first string field of the input. While no result has arrived: a small "running" label, the tooth-free static `…` (no spinner in content). Result error → "failed" label with a crimson icon. Expanded: input as formatted JSON (or the Bash command as a code block), then the result in a code block (`plate`, mono 13px, max-height 24rem with its own scroll), with "Truncated (1.2 MB)" under it when capped. Nested calls (`parentToolUseId`) are indented 16px under their parent. |
| `compacted` | A full-width divider row: a 1px `rule` line with a centered label "Compacted (manual) · 129k → 32k tokens". Expandable: the summary text in a code-styled plate. A preceding `control{compact}` is shown as its own quiet line. |
| `control` | A quiet line, 13px muted: "@or asked to compact: <focus>" or "@or interrupted". |
| `turn_end` with `isError` | A quiet line: "Turn interrupted" for `aborted_tools`, otherwise "Turn ended with an error". Successful `turn_end`s render nothing. |
| `error` | A row with a crimson icon and the message in ink, the detail (stderr line) in mono below. Spawn and resume errors also say what to do ("Set CLAUDE_CODE_OAUTH_TOKEN to run agents", "Run `pnpm seed:dev-agent --reset-session` to start a new session"). |
| `permission_denied` | A row with a warning icon: "Denied: Bash" and the reason in muted text, expandable for the full message. |
| `process_started` / `exited` / `session_reset` | Quiet lifecycle lines: "Started", "Resumed session", "Stopped", "Exited unexpectedly (code 1)" (with the stderr tail expandable), "Session reset". |
| `background_task_*`, `background_tasks`, `cron_*`, `rate_limited` | Quiet one-liners ("Background task started: sleep 20", "Cron created: every minute", "Rate limited until 14:30"). `background_tasks` renders nothing (it is state, used by S5). |
| `session_started`, `usage` | Not rendered. |

### 4.2 Working indicator

While the agent's status is `working`, the last row of the timeline is a 24px line with the `.of-tooth` and "Working". It is not an animation (the loading mark is the only authored animation). When the status flips to idle it disappears instantly.

### 4.3 Scrolling

- **Stick to bottom:** when the user is within 64px of the bottom, new events keep the view pinned to the bottom (no smooth scroll: instant, these arrive tens of times a minute).
- **Reading history:** when scrolled up, new events do not move the view. A "↓ N new events" pill (ghost button on a plate, bottom-right of the timeline) appears; clicking it jumps to the bottom instantly. Its count is announced politely (see §7).
- **Load earlier:** a "Load earlier" ghost button at the top of the timeline when `hasMore.before`. Loading keeps the scroll anchored on the first visible row.
- **Deep link (`?event=<seq>`):** load `?around=<seq>`, scroll that row to the vertical centre, and mark it with a 2px `--signal` outline (the Pilot Light Rule: it is the selected thing) that stays until the user clicks elsewhere or navigates. If the seq doesn't exist: the newest page plus an inline muted line "That event doesn't exist." at the top. A "Jump to latest" control appears while viewing a window that has newer events.
- Every row has a hover-revealed "Copy link" icon button (copies `/agents/$slug?event=<seq>`), the deep-link source for now (the inbox uses it in S8).

### 4.4 States

- **Loading:** the S1 route pending component (LoadingMark) on first load only. "Load earlier" shows "Loading…" in the button.
- **Empty session:** one muted line: "No messages yet. Send the first one below."
- **Agent not found:** the S1 NotFound state.
- **Errored:** the status label says "Errored" (crimson dot), and the latest `error` row explains why. The composer stays enabled: sending is how the human retries (spec §11).
- **Disconnected:** the S1 reconnect strip. The composer stays enabled (HTTP still works); on reconnect the client resubscribes with its last seq.

## 5. Composer

- A `Textarea` on a plate with the `field-edge` boundary, auto-growing from 2 to 12 lines, then scrolling. Placeholder: "Message Dev agent". Label (visually hidden): "Message to Dev agent".
- **Enter sends, Shift+Enter inserts a newline.** IME composition is respected (no send while composing). ⌘/Ctrl+Enter also sends.
- **Urgent** toggle to the left of Send: a checkbox with the label "Urgent", tooltip "Interrupts the current turn. The message runs next." When checked, the Send button label changes to "Send urgent". It resets to off after each send. Urgent while idle is allowed (it is a normal send).
- **Send** is the primary button (graphite, never orange). Disabled when the text is empty or whitespace. While the POST is in flight: disabled, label unchanged, the text stays in the box until the server accepts it (202), then clears. A `503 agent_start_failed` keeps the message (it is persisted as pending and shows in the timeline) and clears the box; the reason shows in the pending row and as the latest error row. Other errors show inline under the composer in crimson with an icon, and the text stays.
- The composer never interprets slash commands: "/compact" is plain text to the agent.
- The draft is kept per agent in `sessionStorage` (so a reload doesn't lose it).

## 6. Actions

- **Compact:** opens a small popover anchored to the button (grows from its trigger, 100ms, per DESIGN.md → Motion): a single-line input "Focus (optional)" and a primary "Compact" button. Enter submits. No confirmation (it is not destructive and the marker shows the result). After submit the popover closes; if a turn is running, the control line appears when the compact is written (after the turn ends). Needs the shadcn `popover` component added.
- **Interrupt:** enabled only while the status is `working`. One click sends it, no confirmation (an interrupted turn loses nothing that the human can't resend; DESIGN.md: forgiveness over confirmation). Disabled state has a tooltip "Nothing to interrupt."
- Both are ghost buttons with icons (`Archive`/`Minimize2`-style for Compact, `Square` for Interrupt, from the existing icon set) and text labels. On narrow screens (< `md`) they collapse to icon buttons with `aria-label`s and tooltips.

## 7. Accessibility and keyboard

- The timeline is a `role="log"` region with `aria-label="Session"` and `aria-live="off"` (a live log of tool calls would be unbearable with a screen reader). A separate visually hidden `role="status"` region announces only: new assistant text after a turn ends ("Dev agent replied"), errors, and status changes ("Dev agent is working").
- Tool rows are `<button aria-expanded>` disclosures; Enter/Space toggle. Collapsed by default.
- Focus order: header actions, timeline (each disclosure and copy-link button), "N new events" pill, composer, Urgent, Send. After sending, focus stays in the composer.
- `j`/`k` timeline navigation is not in S3.
- All text in rem; all colours from tokens; status never colour alone; focus-visible is the 2px signal ring. Increased-contrast mode needs nothing extra beyond the tokens.
- Reduced motion: the only motion here is the popover (fade stays, scale removed).

## 8. Responsive

- `< md`: gutters 16px, header actions become icon buttons, the slug and Unsandboxed badge move out of the header into a single line at the top of the timeline. The composer stays pinned; the textarea grows to 6 lines max. Tool summaries truncate earlier.
- The timeline max width (52rem) only matters from `lg` up.

## 9. Components to add

`apps/web/src/features/session/`: `SessionView`, `Timeline`, `TimelineRow` (switch on event type), `MessageBlock`, `ToolCallRow`, `CompactionMarker`, `QuietLine`, `Composer`, `CompactPopover`, `StatusBadge` (shared with the Agents list), `UnsandboxedBadge`, `useSessionEvents` (HTTP pages + WS subscription + dedup by seq + pending set + status). shadcn additions: `popover`, `checkbox`.

## 10. Copy

Sentence case, calm, specific (PRODUCT.md). Fixed strings: "Not delivered yet", "Working", "Turn interrupted", "Compacted (manual) · 129k → 32k tokens", "Load earlier", "Jump to latest", "Nothing to interrupt.", "Send", "Send urgent", "Urgent", "Compact", "Interrupt", "Focus (optional)", "No messages yet. Send the first one below.", "That event doesn't exist." Token counts use `k` with no decimals above 10k and one decimal below.
