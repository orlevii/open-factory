# U3 Chat: Technical Design

- **Date:** 2026-11-21
- **Status:** Revised after the self-review and five UI-lens reviews (Taste, Apple design, Emil design-eng, Motion, Break UI) at `409904c`, and after spike-u3's findings. Owner-proxy (owner-u3) answered Q1–Q37. Low certainty and deviations for Or: §21.
- **Source of truth (gitignored, read from the main checkout):** `docs/product/ui-review/decisions.md` (decisions 1–21; 7, 13 and 16–21 binding here), `docs/product/ui-review/status.md` (U3 table rows 1–12, file:line at `322075d`), `docs/product/ui-review/pr76-review.md` (the U3 items decision 15 hands over), the seven reviews in `docs/product/ui-review/` (chat.md is the main source), `docs/product/behavior/*.md`, `docs/product/architecture/harness-driver.md`, and the spike write-up `docs/product/architecture/claude-streaming-and-commands.md` with its traces in `docs/product/ui-review/u3-spikes/` (Claude Code 2.1.327).
- **Builds on:** U1 (PRs #84–#88, decisions #77): the control system, `data-instant`, memoized timeline rows (`stabilizeRows`, `TimelineItem` + `itemPropsEqual`, memoized `Markdown`, rAF-batched frames), the send-key rule. U2 (PRs #95, #97–#101, decisions #89, leftovers #102): `AgentChip`, `AgentAvatar`, `MiddleTruncate`, `InlineOutcome`, `Kbd`, the one-line header and `LiveLine`, Agent details, the shortcut layer, `requestComposerFocus`.
- **Followed by:** U4 (create flows and mobile). U4 owns the mobile composer layout and long-press on rows (Q25).
- **Decision log:** GitHub issue "U3: Chat — decisions"; Q1–Q37 are the proxy's answers, D1–D3 tech-lead decisions.

> `docs/product/` is gitignored. Paths into it are relative to the main checkout. Other paths are relative to the repo root; web paths are relative to `apps/web/src/` unless they start with `apps/` or `packages/`.

## 1. Goal

Make watching an agent feel like watching it work, and talking to it feel like one conversation:

1. Say what the agent is doing right now, how long it has worked, and when and how a turn ended (activity line, turn footer).
2. Put the turn's controls where the turn is: Stop, Esc and urgency in the composer.
3. Show who is speaking, and let speech outrank machinery (speaker lines, three tiers, 15/24 prose).
4. Show the work as the work: per-tool renderers with diffs, folded tool runs, background tasks on their call, subagent cards.
5. Stream the agent's text as it is written (decision 7, no caret per decision 13).
6. One composer for sessions, task comments and the inbox pane, with `/` commands, `@` completion and attachments.

**Cross-cutting rules** (every section obeys them; acceptance 9 and 22 test them):

- **Stable rows.** `rows` derive from persisted events only; live frames, status frames, queue frames and the clock never change a row's identity. Display passes (§9.4, §7.6) run between two stabilization passes (§7.7). A memoized `TimelineItem` re-renders only when its own row or its own per-row state changed (U1's guarantee, extended to the new row kinds).
- **A visible thing never re-enters.** A node that replaces one already on screen keeps its key where possible and never fades (§8.3).
- **Nothing resizes its neighbour.** The composer's height doesn't change at turn edges (§6.2); a user's expand never scrolls the expanded element away (§8.1).
- **Keys typed during IME composition never send, stop, recall or complete** (`e.nativeEvent.isComposing || e.keyCode === 229`, one guard at the top of every composer key handler).

## 2. Acceptance criteria

All run in default CI (`pnpm test`, `pnpm typecheck`, `pnpm lint`) unless marked manual.

1. **Activity line.** While `agent.turnOpen` (and the view is not windowed), the line sits directly under the last row (above queued items): the tooth, a fixed-position elapsed duration from `agent.turnStartedAt` ("1m 12s", aligned to whole seconds, never negative), then the label from §5.1. A fake-timer test shows only `Elapsed` re-renders per tick (no `TimelineItem` render). A turn whose `turn_started` is outside the loaded page still shows the line and the duration. With no turn open the line is absent.
2. **Turn footer.** After a non-error, non-command `turn_end`, one quiet line: "Worked 2m 13s · 14 tool calls · $0.42 est."; zero parts omitted, "1 tool call" singular; cost only ≥ $0.01; values from that turn's `usage` event. Self-started turns say "Woke for a background task · 12s" (task notifications) or "Woke for a cron · 12s". The activity line leaving and the footer arriving land in one commit, with no fade on the footer.
3. **Stop.** While `turnOpen`, an outline Stop (CircleStop + "Stop") sits left of Send in the composer; the header has no Stop. Clicking it, or Esc with focus in the composer, no completion menu or peek open and no IME composition, sends one interrupt and shows a spinner and "Stopping…" until the turn closes. Esc with a menu open only closes the menu; with a peek open only closes the peek. With no turn open Esc does nothing to the agent. Send stays right-anchored.
4. **Urgent.** ⌥Enter (Alt+Enter) sends with `urgent: true`; ⌘/Ctrl+Enter and Enter send normally (U1 rule); the Urgent checkbox is gone. The hint line's height is always reserved; its text shows only while a turn is open: "Arrives at the agent's next step. ⌥↵ to interrupt instead." (Alt+↵ off macOS; "Stop first to interrupt." on coarse pointers). The composer's height is identical with and without an open turn (test).
5. **Stop hold (D1).** Server test: `interrupt()` takes the same hold as an urgent send, in the same api job as the control write; a message posted before the interrupted turn's `result` is not written until it lands (or the 10s fallback); while any hold is set, queued message and notice items carry `waitReason: "stopping"` and render "Not delivered yet: stopping the turn"; `publishQueue()` runs when the hold begins and ends; a second `interrupt()` during a hold writes nothing and returns 202; a fired fallback appends `interrupt_unconfirmed` and renders a warning quiet line.
6. **Cancel.** A held `kind: "message"` row you sent shows Cancel (others show none). Cancel is optimistic (one commit); with an empty box the text moves into the box. Undo restores the message among the still-queued items by `createdAt` while the agent hasn't ended (server test incl. "later messages already written → it goes next"); Undo empties the box only if it's untouched; the line lasts until your next send or leaving the page. Server: another user's message → 403 `not_sender`; written → 409 `already_delivered`; restore on an ended agent → 409 `agent_ended`; `GET /api/messages/:id` reports `cancelled`.
7. **Jump to latest.** One always-mounted pill centred on the 52rem column: "3 new messages" (speech only, "99+" cap), "New output" when only non-speech arrived, never "· 0"; windowed views navigate, others scroll and re-pin. End in the log focuses the last loaded row and re-pins (never navigates). Enter 150ms opacity + 4px rise; exit 100ms opacity + 4px drop; opacity only under reduced motion; instant when caused by a key.
8. **Stick-to-bottom.** While pinned, a block that grows 2,000px between scroll events stays pinned (the bug test). These unpin: wheel up (|deltaY| > |deltaX|, not absorbed by a nested scroller), touch drag up, PageUp/Home/↑/Space-up with focus in the log, a scrollbar drag or any other user scroll that decreases `scrollTop` and isn't our own write, focus entering a row above the viewport, a non-collapsed selection in the log, and any user expand/"Show all" inside the log (the toggled element's top stays within 1px). Re-pin only after a downward user scroll that ends within 8px of the bottom, Jump, End in the log, or sending. A 40px wheel-up during growth stays unpinned. Typing in the composer never unpins.
9. **Live rows.** Rows that are new on screen and appended by a live frame carry `data-live` and fade in (opacity, 150ms). Never: on load, Load earlier, resync, windowed views, a reconnect replay, a commit that appends more than 10 rows, a delivered message that replaces its queued or "Sending" block, a persisted text block that retires a live block, a tool row joining a group, a merged failure, a turn footer. Reducer and render tests per case.
10. **Speaker lines and tiers.** Envelopes that crossed a session boundary are cards with a speaker line (avatar 20 for agents, display name, muted `@handle`, shrink-0 time); outgoing cards show "Name → Recipient"; your own messages say "You"; factory notices are quiet lines with the factory mark and the body as two muted clamped lines; agent text has a speaker line on the turn's first text block and again after an incoming message splits the turn (live blocks too). Speech prose is 15/24 at tracking 0, every speaker's markdown at the demoted heading scale; work and system text 13–14. 24px before a speaker line or card and after a turn footer, 8px between rows inside a turn.
11. **Deep link.** `?event=` scrolls the row into view and focuses it (`preventScroll`); the ring is the inset row focus ring; a 6% signal tint on the row's own box (never the gutter) fades over 300ms `--ease-out` after 2s of visible time (kept under reduced motion). A link into a folded group, subagent card or merged failure lands on that row, expanding what holds it.
12. **Row menu.** One ⋯ per row (instant on hover/focus-within for fine pointers; always on touch) with only the actions that apply: Copy link, Copy text, Copy command, View tool call, Open in inbox, and on touch the row's time. Copy feedback: check in 150ms (opacity, scale 0.8→1, blur ≤1px), out 100ms after 1.5s; instant when activated from the keyboard; opacity only under reduced motion. Outgoing cards have no footer links. Code blocks have a Copy button with the same feedback.
13. **Failures and clamps.** Adjacent errors with the same source, code and message render as one row keyed by the first occurrence: "3 times · last 19:32" (date when not today); held messages repeat the reason only on the first. Bodies clamp at 40 lines or 4,000 rendered characters, cut at a block boundary outside a fence; "Show all" expands in place with nothing above moving. Queued bodies clamp at 3 lines; more than 3 queued messages show 2 plus "+N more queued".
14. **Tool runs.** ≥2 consecutive foldable tool rows form a group keyed by its first child (the wrapper never remounts when the run grows from 1 to 2). Collapsed: "Read 6 files, ran 4 commands · 1m 40s"; while live "4 calls so far"; the final summary lands with `turn_end` in one commit. If any child was expanded or focused when the group forms, the group opens and focus moves to its header. Failed, denied, factory, subagent and error rows are never inside a group. User toggles stick.
15. **Renderers.** Each tool in §9.2 renders from `tool_result.meta` and the call input; a result with no meta falls back to today's row; `partial` meta says "Diff truncated · show raw output"; Bash output tails 12 lines or 2,000 characters, strips ANSI and control characters, and shows "Binary output · 14 KB · show raw" for binary; an image Read shows "image · 1280×720" and never stores the image.
16. **Outside content.** No markdown image in the session timeline or inbox loads automatically (agent text, messages, tool results, live text): it renders as a link "Image: <alt ≤80 chars>". Tool-result markdown also renders mermaid fences as code.
17. **Fence-close highlighting.** A code block highlights only when its fence is closed: always for persisted rows; for the streaming tail only after the closing fence arrives (tested in PR4 through the tail parser; PR3 tests `CodeBlock`'s `closed` prop).
18. **Streaming** (PR4): text appears as it is generated, committed at most once per frame, no caret; reload mid-answer shows the text so far; the persisted block retires the live one in one commit with equal height and no fade; a late live frame for a retired key is ignored; an interrupt mid-text leaves exactly one block. A fixture test built from the spike's recorded stream covers these, including the interrupt case.
19. **Subagent cards** (PR4): the Agent/Task call renders as a header row with a neutral rule guide (no fill, no box), type, description, state chip (tooth + "Running" while live), a live progress line carried in the subscribe snapshot, body collapsed with the result last; more than 3 parallel subagents fold into one group; subagent children are one plate deep.
20. **Composer** (PR5): one `Composer` in `components/composer/` used by the session, task comments and the inbox pane; `CommentComposerHandle` (`reply`, `prefill`) unchanged; Send is a labelled primary, disabled-shaped when empty, graphite at once when text is typed; the box grows to 12 lines or 40svh (6 lines or 35svh below `md`), whichever is less; drafts in `localStorage` with a 7-day expiry and no cross-tab clobbering; ↑ in an empty box recalls your last loaded message; optimistic send per §13.2.
21. **`/`, `@`, attachments** (PR5): `/` as the first character opens the agent's commands (from `initialize`), `//` escapes; `@` anywhere opens agents and humans; both caret-anchored, opening upward, no animation, combobox semantics; dispatch through the command route; uploads per §13.5 with sniffed types and confirmed chips.
22. **Render counts** (`timeline-perf.test.tsx`): an `Elapsed` tick, an `agent_status` frame, a queue frame and a live frame re-render no `TimelineItem`; a tool row joining a group re-renders only that group; expanding a child inside a group re-renders that group.
23. **Manual, recorded in each PR:** before/after screenshots of a long session in light and dark (PR2, Q7); an Edit diff in both themes (PR3, Q18); a 40-call turn folded and expanded; the 2,400-event dataset scrolled and streamed under 4× CPU throttling with numbers into the virtualization issue (PR4); a reload mid-answer (PR4); the composer at 200% text at 1440×900 (PR5); 320px with an 80-character name and a 55-character MCP tool name (PR2, PR3).

## 3. Scope

**In:** status.md U3 rows 1–12; decision 14's U3 item and #82 (reading prose size); pr76-review's U3 items (fence-close highlighting, the comment composer's `reply`/`prefill` handle, Enter vs ⌘Enter); D1's server hold.

**Out (follow-up issues, §19):** timeline virtualization (measure after PR4), find in session (chat L4), `T-` task completion in composers (Q23), the mobile composer layout and row long-press (U4), PDFs and other attachment types (Q37).

## 4. U3 checklist

| # | Item (status.md U3 # / source) | Where | PR |
|---|---|---|---|
| 1 | Spikes (U3 #1) | spike-u3 → `claude-streaming-and-commands.md` | done |
| 2 | Activity line, elapsed, turn footer (U3 #2) | §5 | 1 |
| 3 | Stop in the composer, urgency, Esc, durable drafts, ↑ recall (U3 #3) | §6, §13 | 1, 5 |
| 4 | One Jump to latest (U3 #4) | §8.2 | 1 |
| 5 | Speaker identity, tiers, quiet deep-link highlight, card footers into a menu (U3 #5) | §7 | 2 |
| 6 | Per-tool renderers, diffs, folding, background tasks, repeated failures (U3 #6) | §9, §7.6 | 3, 2 |
| 7 | Token streaming (U3 #7) | §11 | 4 |
| 8 | Subagent cards (U3 #8) | §12 | 4 |
| 9 | `/` and `@` in one shared composer, optimistic send (U3 #9) | §13 | 5 (optimistic send 1) |
| 10 | Attachments (U3 #10) | §13.5 | 5 |
| 11 | Live-row polish: fade, queued → delivered, clamp by length, copy, timestamps, copy-link feedback (U3 #11) | §8.3, §7.5, §7.6 | 1, 2 |
| 12 | Queued messages: Cancel (U3 #12; "Send now" dropped, Q5) | §6.4 | 1 |
| 13 | Reading prose size (#82, decision 14) | §7.3 | 2 |
| 14 | Code highlighted only when its fence closes (decision 7, pr76 "done differently" #1) | §10 | 3, 4 |
| 15 | Comment composer's `reply`/`prefill` handle survives (pr76) | §13.1 | 5 |
| 16 | Enter vs ⌘Enter per U1's rule (pr76, decision 15) | §6.2 | 1 |

## 5. Activity line and turn footer (PR1)

### 5.1 One source of activity (Q1 condition, Q10)

`features/session/activity.ts`, pure, returns data (the component formats it):

```ts
export type ActivityKind = "tool_input" | "tool" | "subagent" | "subagents" | "thinking" | "text" | "working";
export type Activity = { kind: ActivityKind; tool?: string; target?: string; more?: number };
export function deriveActivity(open: OpenTurnRows | undefined, live: LiveState | undefined): Activity
```

- Gate (in the view, not here): shown while `agent.turnOpen` and not `state.windowed`. The windowed check stops an old turn whose `turn_end` lies beyond the window from reading as open.
- `OpenTurnRows` comes from the rows pass: `{ newestOpenTool?: ToolRow; openSubagents: ToolRow[] }` for the events after the newest `turn_started` (if it is loaded). It reuses the stabilized `ToolRow` objects. When the turn's start isn't loaded, it is `undefined` and the label falls back to "Working".
- `live` is `undefined` in PR1; PR4 passes the live state (§11). The call site and the component don't change.
- Priority, first that applies: (1) live tool input, `{kind: "tool_input", tool: "Write", target: "src/app.ts"}` → "Writing `src/app.ts`" (PR4); (2) open subagents: one → "Subagent: <description>"; several → "Subagents: <newest> and N more" (names only, no counters: Q19); (3) the newest open tool: Bash `description` else the command's first line ("Running `pnpm test`"), Read/Edit/Write the file name ("Reading `retry.ts`"), Grep/Glob the pattern, MCP "server · tool"; (4) thinking (PR4); (5) live text "Writing a reply" (PR4); (6) "Working".
- Label swaps are instant; PR4's fast-changing parts (input KB) round and update at most twice a second.

### 5.2 `ActivityLine` (`features/session/activity-line.tsx`)

- Position: the timeline footer, **directly under the last row** (including PR4's live text), then queued items, then nothing; the composer sits below the timeline. That reads in time order: now, then next (Apple M6).
- Layout: `[tooth] [Elapsed, shrink-0, tabular-nums] · [label, min-w-0, first line only, middle-truncated, title on hover]`. The duration comes first so the ticking number never moves sideways when the label changes.
- `Elapsed` is its own component: a `setTimeout` chain aligned to the next whole second since `startedAt`, recomputed at once on `visibilitychange` to visible, paused while hidden; `Math.max(0, …)` against clock skew; format "42s", "1m 12s", "1h 3m" (the one `formatDuration`, §5.4). Nothing else re-renders per tick (acceptance 1).
- `startedAt` = `agent.turnStartedAt` (new on `AgentSummary` and the `agent_status` frame, §15; set when the runtime opens the turn, cleared when it closes). Without it the duration is omitted.
- The line fades in once when it mounts (150ms opacity, the live-row rule) and never animates otherwise. The tooth never pulses.
- The behavior doc gets the distinction (§17): a running turn shows a ticking **duration**; waiting lines and holds keep fixed times and never tick.

### 5.3 Turn footer (Q10)

- `rows.ts` gains a `turn_footer` row kind, built from a non-error `turn_end` and that turn's `usage` event (the same event the usage service records into `turns`, so the footer and the Usage page show the same numbers; the web app computes no estimate of its own). Turns with `turn_end.command` (compact, local commands) get no footer.
- Text: "Worked {formatDuration(usage.durationMs)}" + " · {n} tool call(s)" (n = `tool_call` events in the turn incl. nested; omitted when 0) + " · ${cost} est." (only when `costUsd ≥ 0.01`, two decimals). Self-started turns: `originKind` "task-notification" → "Woke for a background task · 12s"; a cron firing → "Woke for a cron · 12s" (+ the same parts).
- A turn with no `usage` (an old row, an exit) shows no footer. Errored turn ends keep today's quiet line ("Turn interrupted", "Turn ended with an error").
- The `turn_end` frame removes the activity line (`turnOpen` false in the same flush, since the runtime publishes the status with the event) and adds the footer in one commit; the footer never fades (§8.3).
- If the turn's start isn't in the loaded page, n counts only loaded calls; the footer then omits the count rather than understating it (it knows: the turn's `turn_started` isn't loaded).

### 5.4 Formats

One `formatDuration(ms)` in `features/session/format.ts`: "42s", "1m 12s", "1h 3m", no space. Prose copy says "10 seconds".

## 6. Composer controls (PR1)

PR1 changes today's `features/session/composer.tsx` in place; PR5 moves it into the shared primitive (§13) without changing behaviour.

### 6.1 Stop (Q2, Q3, Q27)

- While `agent.turnOpen`: an **outline** button, CircleStop + "Stop", left of Send. Send stays right-anchored; Stop's appearance never moves it. It reuses `InterruptButton`'s logic (moved to `features/session/stop-button.tsx`): one `postInterrupt`; then a spinner replaces CircleStop and the label reads "Stopping…" (`aria-disabled`) until `turnEpoch` changes; a 409 is ignored; other failures go to the composer's error line ("Couldn't stop: …"). Under reduced motion the spinner stops and the label carries the meaning.
- The header's Stop is removed (`SessionActions`, `session-view.tsx:503-506`). DESIGN.md and `agents-and-sessions.md` are amended (§16, §17): this narrows decision 5's "plus Stop" (Q2, flagged in §21).
- When Stop unmounts while focused (the turn closed), focus moves to the textarea.
- Below a container width of ~24rem (200% text), Stop drops its visible label (aria-label kept).

### 6.2 Keys (Q3, Q4, U1 rule)

`lib/send-key.ts` gains `isUrgentSendKey(e)`: Enter with `altKey`, not composing, fine pointer only. The textarea's `onKeyDown`, in order:

0. IME guard: `isComposing` or keyCode 229 → return (nothing below runs).
1. Esc: if a completion menu is open (PR5), close it; else if a peek or popover is open, let it close (don't handle); else if `turnOpen` and Stop isn't pending, stop. `preventDefault` + `stopPropagation` only when the composer handled it. Otherwise Esc is not handled.
2. `isUrgentSendKey` → send with `urgent: true` (checked before `isSendKey`, which also matches Alt+Enter).
3. `isSendKey` (unchanged) → send normally.
4. ↑ (PR5, §13.2) → recall.

The Urgent checkbox, its hint and the "Send urgent" label swap go. The hint line under the box has its height reserved whenever the composer is mounted; its text shows only while a turn is open: "Arrives at the agent's next step. ⌥↵ to interrupt instead." (`Alt+↵` off macOS, by the U2 `Kbd` platform rule; on coarse pointers "Arrives at the agent's next step. Stop first to interrupt."). It truncates to one line. PR5 moves it into the toolbar row (§13.1). Placeholder: "Message {name}" (PR5 adds " · / for commands", Q24).

### 6.3 Stop hold on the server (D1)

Today a plain `interrupt()` (`agent-runtime.ts:644`) sets no hold, so a message sent right after Stop is written while the turn aborts and can be absorbed by it. Fix:

- `interrupt()` and `urgentInterrupt()` (`:3149`) share `beginInterruptHold(by)`: write the control, set `this.hold` with the 10s fallback, append the `control{interrupt}` event, `publishQueue()`, all in the same api job (so a `result` can't slip in between). `interrupt()` while a hold is already set writes nothing, appends nothing and returns 202.
- Release on `turn_end` and `exited` stays as today (`:2340`, `:2481`) and also calls `publishQueue()`.
- While `this.hold` is set, `itemOf()` (`:1625`) gives every message and notice item `waitReason: "stopping"` (new enum value in `queueItemSchema`); held member-update groups keep `"turn"` (`turnOpen()` already includes the hold). `QueueItems` prefers `q.waitReason` over `heldReason(agent)`: "Not delivered yet: stopping the turn".
- When the fallback fires (urgent or plain), the runtime appends a new factory event `interrupt_unconfirmed{}`, rendered as a warning quiet line: "The turn didn't confirm the stop within 10 seconds, so held messages were sent anyway."
- Stop-then-Send now equals ⌥Enter, which is why Q4 needs no split menu.

### 6.4 Cancel a held message (Q5, Q26, Q31, D2)

**Server.**
- Migration: `messages_state_check` (`packages/db/migrations/0004_ancient_tigra.sql:38`) widened to include `'cancelled'`; `messageLookupSchema.state` (`packages/shared/src/messaging.ts:110`) and the store type (`apps/server/src/agents/event-store.ts:79`) gain it. Boot queries already filter on `state = 'pending'`, so cancelled rows are skipped without code. A cancelled row stays in the record, never deleted.
- `DELETE /api/agents/:slug/queue/:messageId` → `rt.cancelQueued(id, userId)` inside an api job. Allowed only for `kind = 'message'` rows whose `from_user_id` is the session user (Q26; task comments and scheduled rows are never cancellable, D2): 403 `not_sender` otherwise. "Unwritten" means the entry is in `this.queue`; in flight, awaiting or written → 409 `already_delivered`. The DB update is conditional on `state = 'pending' AND delivered_event_seq IS NULL`. Cancelling never withdraws a wake already under way (D2; an agent that wakes for nothing hibernates after its warm window). Publishes the `queue` frame.
- `POST /api/agents/:slug/queue/:messageId/restore` → `rt.restoreQueued(id, userId)` in an api job: same sender check; 409 `agent_ended` when the agent is terminated or archived; sets `state = 'pending'` and re-inserts the entry among the still-queued items by `createdAt` (if later messages were already written, it simply goes next); bypasses the `seen` guard (its id is already known), wakes and flushes like a delivery; never re-sends an urgent interrupt. Publishes the `queue` frame.
- Both routes log an info line with user, agent and message id (audit).
- `GET /api/messages/:id` reports `cancelled`; a `?message=` deep link to one says "You cancelled this message."

**Client.**
- An outline-less ghost "Cancel" on a queued message block you sent; blocks you can't cancel show none.
- Optimistic in the session reducer: a `cancelled: Map<id, { item, index }>` overlay removes the item and renders, in its place, `InlineOutcome` "Message cancelled. Undo" (one commit, whichever of the DELETE response and the `queue` frame comes first); rolled back with the inline error on failure.
- If the composer box is empty, Cancel also puts the message text into the box: "Message cancelled · back in the box. Undo" (Q31, flagged). Undo empties the box only if it is unchanged since; otherwise it leaves the box alone.
- Undo: the restored item's `queue` frame and the outcome's removal land in one reducer step. The outcome line lasts until your next send or leaving the page; after a failed restore it says why and drops Undo (the line stays under the pointer; only Undo goes).
- No "Send now" (Q5).

### 6.5 Drafts and optimistic send

PR1 ships the `localStorage` drafts and the optimistic send for the session composer exactly as §13.2 defines them; PR5 moves both into the shared primitive.

## 7. Timeline tiers and speaker identity (PR2)

### 7.1 Tiers (Q6)

| Tier | Rows | Treatment |
|---|---|---|
| Speech | incoming messages, outgoing `send_message`, the agent's text | Speaker line; prose 15/24. **An envelope that crossed a session boundary is a card** (plate, 1px rule, radius 6); the agent's own text is unboxed. |
| Work | tool rows, tool groups, subagent cards, spawn/terminate blocks | 13px; tool names in mono only where they are identifiers |
| System | lifecycle quiet lines, turn footer, compaction marker | 13px muted; Copy link is the only row action |

Spacing replaces boxes for grouping (Apple m2, DESIGN.md "rhythm comes from rules and spacing"): 24px before a speaker line or a card and after a turn footer; 8px between rows inside a turn (today a uniform `space-y-3`).

### 7.2 Speaker line (`features/session/speaker-line.tsx`)

`[avatar 20] Name  @handle  14:02` — Geist 13/500 name (`dir="auto"`), muted mono handle (middle-truncated; hidden below a 20rem container, kept in the tooltip and row menu), muted time (`shrink-0`, never truncated).

- Agents: `AgentChip size={20} showSlug` (U2), linking to the agent's session except for the session's own agent.
- Humans: no avatar (humans have none), the user's name from the users list, else the handle; your own messages say "You" (from the session query's handle); never a second fill (Q6).
- Outgoing cards: "[avatar] Name → [avatar] Recipient @handle · time"; the recipient reads "You" when it is you, "All humans" for `@humans`.
- Factory notices (`system`, `task_assigned`, `task_update` from `@factory`): no card; a quiet line with the factory mark and the task badge, and the body below as two muted lines clamped with "Show all" (Q6, Apple m9, Taste m9b), so an assignment's brief isn't swallowed.
- Scheduler messages keep their sender ("Scheduler", schedule badge, "by …").
- Agent text: `rows.ts` marks a text row `head: true` when it is the first text of its turn, or the first text after a message row in the same turn (Q6 note 1). Head rows show the session agent's speaker line; others don't. Children of a subagent never get one. PR4 computes `head` for the live block the same way, so the handoff never adds or removes a speaker line (Motion M7).
- Message bodies and markdown block elements get `dir="auto"` (bidi).

### 7.3 Reading prose size (Q7, Q33, #82)

`styles.css`:
- `.prose-of` (speech, task bodies, comments): 15/24 (`0.9375rem/1.5rem`), tracking 0 (Q33: DESIGN.md's −0.01em at 15–17px applies to Archivo headings only).
- Markdown headings, page scale: h1 20/28, h2 17/24, h3 15/24 at 650. Demoted (`.prose-of-detail`): h1 17, h2 16, h3 15, all 650. **Every speaker's markdown in the timeline uses the demoted scale** (agent text included; today it uses the page scale at `timeline-row.tsx:325`), so nothing in a session outranks the page title.
- `.prose-of-work` is a modifier on `.prose-of` (like `.prose-of-detail`, so it keeps every overflow rule): 13/20, headings 14/13/13. Used for tool results rendered as markdown.
- Overflow: `.prose-of`'s `overflow-wrap: anywhere` rule extends to `:is(h1,h2,h3,h4,h5,h6,dt,dd)`; the timeline log gets `overflow-x: clip` so a leak can never scroll the conversation sideways.
- Code stays Geist Mono 13/1.55.
- PR2 records before/after screenshots of a long session in light and dark; #82 is closed by PR2.

### 7.4 Deep-link arrival (Q8, Q28)

- The lit row (or, inside a group, subagent card or merged failure, the holder is expanded first) is `scrollIntoView({ block: "center" })`ed, then focused with `focus({ preventScroll: true })` through the existing roving tabindex (it becomes the tab stop via `onRowFocus`; no `tabIndex=-1`). Its ring is DESIGN.md's inset row focus ring. Where `:focus-visible` doesn't match a programmatic focus after a mouse navigation, the row gets `data-focus-ring` until `blur`, styled identically ("ring = focus").
- A 6% signal tint on the row's own box (the card or the row, never the `pr-8` wrap or gutter): `[data-arrived]::before` with `background: color-mix(in oklab, var(--signal) 6%, transparent)`. After **2s of visible time** (the timer runs only while `document.visibilityState === "visible"`, starting after the row has painted), it fades over **300ms `--ease-out`** (opacity of the pseudo-element). The fade stays under reduced motion. Inside DESIGN.md's 300ms ceiling, so no amendment.
- The existing "until the user clicks elsewhere" pointer listener (`timeline.tsx:146-154`) goes.

### 7.5 One row menu, copy, timestamps (Q14)

- `CopyLink` becomes `RowMenu` (`features/session/row-menu.tsx`): one ⋯ trigger, a ghost icon `Button` (it gets the 0.98 press), shown instantly on hover/focus-within under `(hover: hover) and (pointer: fine)`, always visible on touch. It keeps `data-copy-link` so `applyTo` in `timeline.tsx:223` still excludes it from the roving tabindex.
- Right edge: cards span the full column with ⋯ inside their own padding; unboxed rows reserve a fixed 2rem right column. Order in the gutter: content | chip | time (hover/focus) | ⋯. Acceptance: a card's right edge equals the composer frame's right edge at 1440, 1024 and 390.
- Items, only those that apply: Copy link (all), Copy text (agent text, message bodies: the markdown source), Copy command (Bash), View tool call (outgoing, spawn), Open in inbox (outgoing to a human), and on touch the time ("Sent 14:02:11") as a label item. A row with only Copy link still opens the menu (one trigger kind everywhere).
- Copy feedback: the trigger icon crossfades to a check, 150ms in (opacity, scale 0.8→1, blur ≤1px), held 1.5s, 100ms out; instant when the item was activated from the keyboard; opacity only under reduced motion. "Couldn't copy" inline as today.
- Outgoing cards lose "Show tool call" / "Sent to the inbox" footers (`outgoing-message.tsx`).
- Code blocks (`CodeBlock` and the plain `pre`) get a Copy button, top-right, on hover/focus-within, with the same feedback.
- Agent text and tool rows show their time in the gutter on hover/focus; messages keep their visible time.
- Group headers and tool rows take the `.of-row` pressed fill (full-width rows never scale).

### 7.6 Repeated failures and clamps (Q15)

- `mergeFailures(rows)` (a display pass, §7.7) merges adjacent `error` rows with the same `source`, `code` and `message` into one row **keyed by the first occurrence**, with `count`, `lastAt` and `seqs`: "Image `playwright` isn't built · 3 times · last 19:32" ("last Mon 19:32" when not today). Stored rows are untouched. `targetRowKey` maps any of `seqs` to it. The announcer still runs on the unmerged rows, so each new failure is announced (D3).
- Queued messages: "Not delivered yet: <reason>" on the first held message block, "Not delivered yet" on the rest. Queued bodies clamp at 3 lines; with more than 3 queued messages, the first 2 show and "+N more queued" discloses the rest (each with its own Cancel).
- `ClampedMarkdown` clamps at 40 lines or 4,000 rendered characters (`plainLength()`: the source with markdown syntax stripped by a cheap regex pass), whichever comes first. The cut is made at the last blank line before the limit that is outside a fence, with an open fence closed virtually: the same `splitBlocks` splitter §11.4 uses, built in PR2 (`components/markdown/split-blocks.ts`). "Show all" expands in place: it unpins and anchors (§8.1), so nothing above moves.

### 7.7 The rows pipeline (U1's stable references, extended)

1. `buildRows(events)` → raw rows (+ `head` flags, `turn_footer` rows, `at`/`resultAt` on tool rows, background-task attachment §9.5).
2. `stabilizeRows(prev, raw)` → unchanged rows keep identity (children first, as today).
3. `groupWork` (§9.4) and `mergeFailures` (§7.6), producing `work_group` and merged `error` rows. Summaries are data (`{ verbs: Record<Family, number>; durationMs?; live: boolean; callCount }`), never JSX, so `sameValue` can compare them.
4. `stabilizeRows` again, by key; `stabilizeRow` recurses into `work_group` children and subagent cards as it does for `tool` children.

Every tool-only tree walk learns the new kinds: `itemPropsEqual`'s `subtree()` (`timeline-item.tsx:22-26`), `hasKey`, `containsSeq`, `targetRowKey` (`timeline.tsx:330-358`), `scanRows` (`session-view.tsx:376-391`) and `stabilizeRow` (`rows.ts:286-300`). One helper, `childrenOf(row)`, returns the children of `tool`, `work_group` and subagent rows, and all six use it. Render-count tests: acceptance 22.

## 8. Scrolling and live rows (PR1)

### 8.1 Stick-to-bottom on intent (Q12)

`Timeline` keeps `pinned` (ref). Today's position test (`timeline.tsx:159`) stops deciding it. It tracks `lastWrittenTop`, the `scrollTop` its own code last wrote, so it can tell its own scrolls from the user's.

- **Unpin** (fast paths): `wheel` with `deltaY < 0` and `|deltaY| > |deltaX|`, unless a nested scroller under the pointer (code plate, table) can absorb it; `touchmove` upward; PageUp, Home, ↑, Shift+Space with focus inside the log; focus entering a row above the viewport; a non-collapsed selection inside the log (`selectionchange`); a user-initiated expand, collapse or "Show all" inside the log (it also anchors that element, below).
- **Unpin** (fallback): any `scroll` where `scrollTop` decreased and isn't `lastWrittenTop` (scrollbar drag, middle-click autoscroll, find in page).
- **Re-pin:** a downward user scroll that ends within 8px of the bottom; Jump; End in the log; sending from the composer; a selection that collapses while within 8px.
- While pinned, the ResizeObserver and the rows layout effect write `scrollTop = scrollHeight` (recording `lastWrittenTop`) after layout and before paint, so growth never unpins (the 2,000px test).
- **Anchoring while unpinned (every height change, not only width):** the existing `captureAnchor`/`widthAnchor` mechanism runs for every content-height change while unpinned (a background task finishing, a group summary settling, a merged failure's count, a subagent result above the viewport): the top visible row keeps its position. A user-initiated toggle anchors the toggled element's top instead. No reliance on `overflow-anchor` (Safari lacks it; our own writes would fight it).
- Typing in the composer never unpins (its keys aren't in the log).
- Tabbing into the log focuses the tab-stop row; if that is above the viewport, that is a focus-above intent and unpins.

### 8.2 One Jump to latest (Q11)

- `JumpPill` (`features/session/jump-pill.tsx`), always mounted, absolutely positioned and centred on the 52rem column (not the scroller); `data-shown`, `inert` and `pointer-events: none` while hidden. Surface: `plate-raised` with `float-edge`, no shadow (decision 11), 32px, ArrowDown + label, `max-width: calc(100% - 2rem)`.
- Shown when unpinned and something arrived since, or when windowed.
- Label: speech rows appended (message, outgoing, agent text rows; a live text block counts once) → "1 new message" / "3 new messages" ("99+ new messages" cap, tabular nums); anything else only → "New output"; windowed → the speech count of `newWhileAway` (the reducer counts speech for windowed frames too), else "Jump to latest"; never "· 0". Label changes are instant.
- Action: windowed → navigate to `/agents/$slug` (today's behaviour); else scroll to bottom instantly and re-pin.
- End in the log focuses the last loaded row and re-pins; it never navigates (the pill alone leaves a windowed view).
- Motion: CSS transitions (interruptible, never keyframes): enter opacity 0 → 1 with `translate: -50% 4px` → `-50% 0`, 150ms `--ease-out`; exit the reverse, 100ms; opacity only under reduced motion; instant when shown or hidden by a key (`data-instant`).
- Removes `timeline.tsx:310-324` and `session-view.tsx:278-289`.

### 8.3 Live-row fade and handoffs (Q13)

**Rule:** a row fades only if its content was not on screen in the previous commit and it arrived by a live frame. A node that replaces one already on screen never fades.

- `useSession` records `liveAfter`: the highest seq when the last `loaded` landed, and again after each subscribe's replay is drained (so a reconnect's catch-up never fades). A commit that appends more than 10 rows counts as a load (no fade).
- `TimelineItem` gets `live: boolean` (compared in `itemPropsEqual`) and sets `data-live` when `row.seq > liveAfter` and the row's key isn't in the reducer's `handedOff` set.
- CSS: `[data-row-wrap][data-live] { transition: opacity 150ms var(--ease-out); @starting-style { opacity: 0 } }`. `@starting-style` applies on insertion only, so re-renders never replay it. Reduced motion keeps it (opacity only).
- `handedOff` (reducer state, keys of rows that replace something on screen):
  - a `message_in` whose envelope `id`/`ids` match queue items or optimistic "Sending" blocks (by `clientMessageId`, §13.2): those items are removed in the same reducer step;
  - a persisted `assistant_text` that retires a live block (PR4, by `(messageId, blockIndex)`);
  - not needed for groups and merged failures: they keep the first child's/occurrence's key, so their wrapper never remounts and their `live` flag is the first child's, already spent.
- `turn_footer` rows are never live.
- Not live: `loaded`, `earlier`, a resync reload, windowed views, a reconnect replay.

## 9. Tools (PR3)

### 9.1 `tool_result.meta` (Q16)

`packages/shared/src/tool-meta.ts`, one discriminated union keyed by `tool`; unknown tools carry none; old rows parse:

```ts
const hunk = z.object({ oldStart: z.number(), oldLines: z.number(), newStart: z.number(), newLines: z.number(), lines: z.array(z.string()) });
export const toolMetaSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("Edit"), hunks: z.array(hunk), partial: z.boolean().optional() }),      // MultiEdit: same shape, own literal
  z.object({ tool: z.literal("Write"), type: z.enum(["create", "update"]), hunks: z.array(hunk), partial: z.boolean().optional() }),
  z.object({ tool: z.literal("Bash"), interrupted: z.boolean(), backgroundTaskId: z.string().optional(), stderr: z.string().optional() }),
  z.object({ tool: z.literal("Read"), kind: z.literal("text"), startLine: z.number(), numLines: z.number(), totalLines: z.number() }),
  z.object({ tool: z.literal("ReadImage"), bytes: z.number(), width: z.number().optional(), height: z.number().optional() }),
  z.object({ tool: z.literal("Agent"), toolUses: z.number().optional(), tokens: z.number().optional(), durationMs: z.number().optional() }),
]);
```

- `tool_result` gains `meta: toolMetaSchema.optional()`.
- The mapper (`mapper.ts:295-301`) builds it from `tool_use_result` only when the `user` line holds exactly one `tool_result`. It **never copies** `originalFile`, `file.base64` or `file.content` (the spike: an image `Read` carries the image twice on stdout, 675 KB). It bounds meta itself: hunks are added until 32 KiB serialized, then `partial: true`; `stderr` ≤ 16 KiB. capPayload still applies.
- Shapes from the fixtures: Edit's result has no `type` (always an update; keys `filePath, oldString, newString, originalFile, replaceAll, structuredPatch, userModified`); a Write create has `type: "create"` and `structuredPatch: []`, so the create view reads its line count and first 20 lines from the call input's `content` (already persisted); an image Read is `file{base64, originalSize, dimensions}` (spike trace `attach-file-path`). Bash: `{stdout, stderr, interrupted, isImage, noOutputExpected, backgroundTaskId}`.
- No meta, and data from elsewhere, for: TodoWrite (the checklist is the call input), Grep/Glob (counts parsed from `content` when its first line reads "Found N files" (else the line count); a file list from `content`'s lines, bounded to 200 with the true count), WebFetch/WebSearch (host and path from the call input; status and size only if PR3 records a fixture showing them). PR3 records fixtures for Grep, Glob, MultiEdit and WebFetch with the spike credentials and adds meta for any whose shape then proves useful.
- Agent: the foreground Agent result's usage, and `background_task_finished` gains optional `usage{toolUses, tokens, durationMs}` from `task_notification` (`background-subagent-stdin-closed.jsonl`); PR4 records a foreground-subagent fixture. Without either, the subagent card shows no footer (§12).

### 9.2 Renderers (Q17)

`features/session/tools/` with one module per tool and `toolRenderers: Record<string, ToolRenderer>`, `ToolRenderer = { summary(row): ReactNode; body(row): ReactNode }`. Unknown names fall back to today's `ToolCallRow` body.

**Row anatomy (Break M9–M11):** collapsed rows are `min-h-8` (data rows wrap rather than clip at large text). One line: chevron, name/summary (`min-w-0`, truncating; the tool name `max-w-[60%]` truncating with the full name in `title`), and a one-word state chip (Running / Failed / Interrupted / In background / Finished, `shrink-0`). Detail (a background summary, the first error line, a denial) goes on its own line under the row, `pl-7`, `[overflow-wrap:anywhere]`, clamped to 2 lines, as today's denial line does. The chevron top-aligns once text wraps.

| Tool | Collapsed row | Expanded (result first; "Show input" only when it adds something) |
|---|---|---|
| Bash | its `description`, then the command muted and truncated on the same line (else `$ command`); chip | output tail: the last 12 lines or 2,000 characters, whichever is shorter (cut at a line start when possible), "Show all N lines" in place; ANSI escapes and control characters stripped; >10% control/NUL/U+FFFD → "Binary output · 14 KB · show raw"; stderr in its own plate with a muted crimson label |
| Edit / MultiEdit / Write | path (middle-truncated) · **+4 −2** (`shrink-0`), or "created · 120 lines" | unified diff from `hunks`: one gutter column (new line number; old on − lines) and the +/− sign, sticky (`position: sticky; left: 0`) in a horizontally scrolling plate; code in ink on `--diff-add`/`--diff-remove` tints, no syntax colour (Q18, Taste M6); first 3 hunks or 80 lines, then "Show all N lines"; `partial` → "Diff truncated · show raw output"; a create shows the input's first 20 lines as + lines |
| Read (text) | `retry.ts` · lines 1–120 of 340 | nothing; "Show content" renders it with a real gutter (the `N→` prefixes stripped), clamped like Bash by lines and characters |
| Read (image) | `screenshot.png` · image · 1280×720 | nothing (the image is never stored); if the path is an upload (§13.5), its chip preview |
| Grep / Glob | pattern in path · 6 files | the first 20 files (mono rows), "Show all N files"; content hits grouped by file |
| WebFetch / WebSearch | host + path | the prompt, then the result as outside-content markdown (§9.3) |
| TodoWrite | "Updated plan · 3/7 done" | checklist from the input (read-only, graphite boxes) |
| `mcp__factory__*` task/schedule tools | quiet line with the `T-n` / `S-n` badge | the generic body |
| Other MCP | `server · tool` (server middle-truncated, tool keeps its tail) + first string argument | input as a key/value list; result as outside-content markdown when it looks like text |

- "Show all" expands in place, unpinning and anchoring (§8.1); no nested vertical scroller (the 24rem `CodePlate` cap stays only for the raw fallback).
- Highlighting in Read "Show content" uses the extension → grammar map in `highlight.ts` with a plain fallback; above 2,000 lines it stays plain.
- The activity line's MCP label uses the same truncation.

### 9.3 Outside content (Q17, Q32)

- **Images, everywhere in the timeline and inbox:** `Markdown` renders every `img` as a link "Image: <alt, ≤80 chars, else host>" — agent text, messages, outgoing bodies, tool results, live text. Nothing loads from arbitrary hosts. Real images reach the UI only as attachments through the authenticated route (§13.5).
- `Markdown` gains `untrusted?: boolean` for tool results: in addition, mermaid fences render as plain code (DESIGN.md's Markdown bullet amended, §16). Raw HTML is already off; external links keep `rel="noopener noreferrer"`.

### 9.4 Folding tool runs (Q9, Q34)

- `groupWork(rows)` (pipeline step 3, §7.7): a run of ≥2 consecutive top-level `tool` rows whose state is `running`, `done` or `no_result`, with no `denial`, that are not Agent/Task calls, becomes `{ kind: "work_group", key: firstChild.key, children, summary }`. The first child renders with an inner key (`"c:" + key`). Because the group keeps the first child's key, the wrapper persists when a run grows from 1 to 2 calls (no remount, no fade). Any other row ends the run (failed, denied, factory blocks, subagent cards, errors, messages, text, quiet lines).
- When a group forms, if any child's key is in `expanded` the group's key is added (it opens, the child stays open); if focus was on a child, it moves to the group header.
- Summary, counting only the group's own children: final "Read 6 files, ran 4 commands, edited 2 files, 3 other calls · 1m 40s" (verbs per tool family, duration muted and last = last child's `resultAt` − first child's `at`); while the turn is open and the group is the newest: "4 calls so far" (counts only; the activity line names the tool). "Worked" belongs to the turn footer only (Q34). At turn end the final summary lands with the `turn_end` frame (one commit).
- Header: `min-h-8`, the summary wraps, numbers never truncate; the chevron rotates 150ms only when its own chevron was clicked; children render without height animation.
- Collapsed by default always; toggles stick (`expanded` by key). `targetRowKey`/`hasKey` look into groups; a deep link adds the group's key to `expanded`.

### 9.5 Background tasks on their call (Q20)

`background_task_started{toolUseId}` attaches to its tool row (`backgroundTask: { taskId, state: "running" }`, chip "In background"); `background_task_finished` with the same `taskId` updates it (chip "Finished" or "Failed", the summary on the detail line). Neither renders its own line then. Unmatched ones (Monitor, after a resume) keep today's quiet lines. The header's U2 "waiting on" fact is unchanged.

## 10. Code highlighted only when its fence closes (decision 7, PR3/PR4)

- `Markdown`'s `pre` renderer passes `closed` to `CodeBlock` (default true). For persisted rows every fence is closed. The streaming tail (§11.4) passes `closed: false` for an open fence, which renders `<pre><code>` plain until the closing fence arrives, then highlights once.
- Already done in the code and kept: `CodeBlock` keeps the previous highlight per language (`code-block.tsx`), `console` → `shellsession`, the extra aliases and the single `.catch` (`highlight.ts:81-85`, `:99-107`).
- Persisted diffs are not syntax-highlighted (§9.2).

## 11. Token streaming (PR4)

Binding: decision 7 (live over WS, not stored; the final message persisted as today; a reload mid-answer shows the text so far; highlighting when a fence closes; a live activity line) and decision 13 (no caret; at most one commit per frame). Facts from the spike (`claude-streaming-and-commands.md` §1).

### 11.1 Harness

- `buildClaudeArgs` adds `--include-partial-messages`. Persisted lines are unchanged by it; the cost is volume (~200 extra lines per short turn), all of it kept out of the event log.
- `ClaudeProcess` gains `live: AsyncQueue<LiveEvent>` beside `events`; `HarnessProcess.live` is optional, so the fake driver and other drivers need nothing. The debug stdout log skips `stream_event` lines.
- `LiveEvent` (in `packages/harness`, never in `HarnessEvent`):

```ts
type LiveEvent =
  | { type: "text_start"; messageId: string; index: number }
  | { type: "text_delta"; messageId: string; index: number; text: string }
  | { type: "tool_start"; messageId: string; index: number; toolUseId: string; name: string }
  | { type: "tool_input"; messageId: string; index: number; bytes: number; target?: string } // file_path / command / pattern, parsed early from partial_json
  | { type: "thinking"; estimatedTokens: number }
  | { type: "subagent_progress"; toolUseId: string; description: string; subagentType: string; toolUses: number; tokens: number; durationMs: number; lastTool?: string }
  | { type: "message_stop"; messageId: string };
```

- Mapping: `stream_event` `message_start` (records `api_message_id`), `content_block_start` (text → `text_start`; tool_use → `tool_start`; thinking → nothing but counts for the index), `content_block_delta` (`text_delta` → `text_delta`; `input_json_delta` → `tool_input` with cumulative bytes and `target` once `"file_path"`, `"command"` or `"pattern"` is complete in the partial JSON; `thinking_delta` → `thinking` from `estimated_tokens`), `message_stop` → `message_stop`; `system/thinking_tokens` → `thinking`; `system/task_progress` (today dropped, `mapper.ts:66`) → `subagent_progress`. Subagents never stream text (spike).
- Persisted `assistant_text` and `tool_call` gain optional `messageId` (the `message.id`) and `blockIndex` (the block's position among that id's `assistant` lines, **thinking blocks counted**): the reconcile key. The mapper counts per message id.

### 11.2 Runtime

- The runtime drains `proc.live` in its own loop, outside the serial job queue (no DB, no job). It keeps `LiveState` in memory: `text?: { messageId, index, text }` (at most one block), `toolInput?: { toolUseId, name, bytes, target }`, `thinkingTokens?`, `subagents: Map<toolUseId, progress>`.
- It publishes coalesced `live` frames on the bus every 50ms while something changed.
- Retirement: when the job that appends a persisted `assistant_text` with key `(messageId, blockIndex)` runs, it clears `text` for that key before publishing the `session_event` (the spike: the complete `assistant` line arrives just before `content_block_stop`, so retire on the line, never wait for the stop). The persisted `tool_call` clears `toolInput`. `turn_end` and `exited` clear everything but subagents; a subagent's entry clears on its `tool_result` / `background_task_finished`.
- Interrupt mid-text: Claude flushes the partial text as a normal `assistant` line (`terminal_reason: "aborted_streaming"`), so the same retirement applies; no special case.

### 11.3 WebSocket

- Server frame `live`: `{ type: "live", agent, text?: { messageId, index, offset, append }, toolInput?, thinkingTokens?, subagents?: Progress[], reset?: true }`. `offset` is the block length before `append`.
- Client message `{ type: "live_snapshot", agent }` → the server answers with a `reset` frame holding the full `LiveState`. The client sends it when it sees an offset gap.
- `subscribe()` (`ws/route.ts:108-121`) sends `rt.liveSnapshot()` as a `reset` frame after the replay and buffer drain: a reload mid-answer shows the text so far (decision 7), with no fade (it is part of the load).
- Live text is coalesced into state (latest text per key), never a growing queue, so a hidden tab holds one block, not minutes of frames.

### 11.4 Client

- Live state lives in the session reducer beside `ordered` (`state.live`), with a `retired: Set<"messageId:index">`. A persisted `assistant_text` adds its key to `retired` and `handedOff` and clears `live.text` in the same reducer step: one commit, no fade, equal height. A late `live` frame for a retired key is ignored; a `reset` clears `retired` entries older than the current turn.
- `rows` are derived from events only, so a live frame never changes their identity (acceptance 22). The footer's live tail is a memoized `LiveTail` component receiving `state.live` only.
- `LiveTail` renders as the last timeline item, with the same wrapper, `head` speaker line rule (§7.2) and spacing as the persisted row, so the handoff changes no height (a height-equality test). It fades in once when it mounts (a new row), never per chunk.
- Tail parsing, in-house (`components/markdown/stream-tail.ts`, ~150 lines, no new dependency, Q35): `splitBlocks` (§7.6) splits at the last blank line outside a fence; completed blocks render once each through the memoized `Markdown` (same pipeline, same sanitising, same no-remote-images rule as persisted text); only the tail re-renders. In the tail: an open fence renders as plain `<pre><code>` without markdown parsing (`closed: false`), highlighted once when the fence closes; unclosed `**`, `_`, inline backticks are auto-closed; a half link `[text](` shows its text until it closes; a trailing `|` line is held back until its delimiter row arrives. A tail over 4 KB with no blank line splits at the last newline, else renders as plain text until the block ends.
- Selection: while a selection is inside the live tail, the tail's DOM is not replaced for unchanged text (completed blocks keep their nodes) and the view is unpinned (§8.1).
- Activity: `deriveActivity(open, state.live)` (§5.1).
- Fixture test (Q35 condition 3): the spike's recorded streams (`partial-text-and-write`, `partial-interrupt-mid-text`) replayed through the mapper, runtime and reducer produce exactly one block per text block, including the interrupt case.

## 12. Subagent cards (PR4)

- The Agent/Task tool call (names `Agent` and `Task`) renders as `SubagentCard` (`features/session/subagent-card.tsx`), Q19 and Q30:
  - **Header row** (`min-h-8`): "Subagent · <subagentType, truncating> · <description, truncating>" and a state chip (`shrink-0`): tooth + "Running" while live, "Done", "Failed", "In background". Its accessible name says "in this session", so it never reads as a factory spawn block. No avatar, no link.
  - **Body:** indented, with a 1px neutral `rule` guide down its left (never status-coloured: structure, not state); no fill, no box. The tool bodies inside are the only plates (one plate deep).
  - Running: one live line from `subagent_progress` ("Reading `templates/purchase.md` · 4 tool calls · 23k tokens", counters updated at most twice a second, never a ticking timer), carried in the subscribe snapshot. Each card's line is memoized by `toolUseId`, so a frame re-renders only the cards that changed.
  - Body collapsed by default: the prompt as markdown, then the nested transcript in order (folded per §9.4), then the result last. When done, the result's first 3 lines show without expanding.
  - After it ends: only persisted figures, "12 tool calls · 41s · 23k tokens" from Agent meta or `background_task_finished.usage` (§9.1); no footer when neither exists.
- Parallel subagents (several calls in one message): up to 3 stack as cards; above 3 they fold into one group row "10 subagents · 4 running, 6 done" (the same group mechanics, keyed by the first card). A line "3 subagents running" above stacked cards stays after they finish, changing its text ("3 subagents · done"), so the cards don't jump.
- `targetRowKey`/`hasKey` open a card (and a group inside it) when a deep link lands inside.
- The activity line names subagents only (§5.1).

## 13. The shared composer (PR5)

### 13.1 Primitive (Q21)

`components/composer/composer.tsx`, `Composer`, used by the session (`features/session/composer.tsx` becomes a thin wrapper), task comments (`CommentComposer` keeps its file, props and `CommentComposerHandle { reply, prefill }`, which pr76 requires), and the inbox reading pane's reply.

- Frame: one plate (`field-edge`, radius 6) containing the auto-growing textarea and a 32px toolbar inside the frame. Growth: 2 → 12 lines or 40svh, whichever is less (2 → 6 lines or 35svh below `md`), then it scrolls inside (Break M2).
- Toolbar: left `/` (session) and `@` buttons opening the same menus as typing (the session's `@` button is labelled "Insert an agent's handle", never "mention", Q23), Write/Preview toggle (comments); middle the hint text (session, §6.2, truncating, so the frame height never changes); right Stop (session, while a turn is open) and Send. The toolbar may wrap at 200% text; Stop drops its label first.
- Send is always the primary variant with its "Send" label: disabled-shaped when empty (decision 21: plate, rule border, muted text), graphite **at once** when there is text (a keyboard action, so no transition).
- Props: `draftKey`; `onSubmit(text, { urgent, clientMessageId }) → Promise`; `turnOpen`, `onStop` (session only); `completions` (`/`, `@` sources); `preview` (comments).
- The keydown order is §6.2's, shared.

### 13.2 Drafts, recall, optimistic send (Q22, Q29)

- **Drafts:** `localStorage` `of-draft:agent:<slug>` / `of-draft:task:<key>`, stored as `{ text, at }`, dropped after 7 days, try/catch as today. A tab writes only while its textarea is focused, and adopts an emptied draft from `storage` events while not focused, so two tabs never resurrect sent text. The draft clears only what the server accepted (only what was sent, as today). A terminated agent's draft stays copyable ("Copy unsent message").
- **Recall:** ↑ in an empty composer with the caret at 0 fills the box with your newest `message_in` envelope in the loaded timeline (the server's record, Q22b); nothing when none is loaded. Always a new send.
- **Optimistic send** (Q29): Enter clears the box and adds, in the queue area, a block in the **delivered card's shape** with the body muted and the accessible name "Sending" (no dashed edge, no entrance motion, no row menu, no timestamp). Only if the POST is still pending after 400ms does "Sending…" with a spinner appear where the time goes; an ⌥Enter send says "Sending · will interrupt the turn". The block lives in the session reducer, keyed by a client-generated `clientMessageId` (uuid). The POST carries it; the server dedupes on (sender, `clientMessageId`) for 10 minutes and returns the original 202; the message row, its queue item and the `message_in` envelope echo it. Whichever arrives first (the 202's queue item or the delivered `message_in`) replaces the block in one reducer step (`handedOff`, §8.3). A queue item younger than 300ms doesn't show "Not delivered yet". After 15s the POST aborts: the block is removed, the text returns to the box (appended to anything typed since) with "Couldn't confirm the send. Retry sends it once." (a retry reuses the id, so it can't deliver twice). Other failures: block removed, text back, the inline error. Never a ghost block.

### 13.3 `/` commands (Q36)

**List.**
- At process start the driver sends `control_request{subtype: "initialize"}` (answered at once, no turn, no cost; spike §2) and maps the response's `commands[{name, description, argumentHint, builtin?, aliases?}]` to a `commands_available` harness event (not shown in the timeline). `commands_changed` (unreliable per the spike) is mapped the same way if it ever fires. `init.terminal_slash_commands` are dropped.
- The runtime stores the list as JSON on the agent row (`commands` column, so it survives hibernation), with the Claude Code version it came from. `GET /api/agents/:slug/commands` returns `{ commands, source: "session" | "template", at }`. Before the first start, the template's skills, `source: "template"`; the menu says "From template" honestly (Q36 condition 4). Re-sending `initialize` later in a process is unverified (spike), so the list refreshes at each process start only.
- Grouping and source: Skills (source from the description tag: project / plugin / personal), Commands (the allowlist), Factory.
- **Allowlist of built-ins:** `compact` → today's Compact flow; `clear` → today's New session confirmation; `context`, `usage` (with aliases `cost`, `stats`) → raw, rendered as `command_output`; `code-review`, `security-review`, `init` → raw. Everything else is hidden (model, effort, config, color, fast, rename, mcp, agents, doctor, heapdump, reload-*): the template owns it or it is terminal-only.

**Dispatch.**
- `POST /api/agents/:slug/commands { name, args, clientMessageId }`, humans only (a session user; agents have no route to it, and an agent's `send_message` text is never treated as a command). The server validates `name` against the stored list (or the template list before the first start; else 422 `unknown_command`, shown inline, never a silent text send), and builds one stream-json user message whose content is `"/" + name + (args ? " " + args : "")`, args as data, never concatenated into anything parsed again. It is never batched with envelopes.
- Held until no turn is open, as compact is (queue item kind `command`, "`/code-review` waits for the turn to end", args truncated). The spike shows a mid-turn slip would only queue as its own turn, but holding keeps one send, one result.
- Recorded as `control{cmd: "command", arg: "/name args", by}` (the `control` cmd enum gains `command`), rendered like your message with the command in mono and the sender suffix "ran a command".
- Local output: a `result` with `local_command` ∈ {context, usage, cost, stats} and `result.result` text is mapped to a new `command_output{command, text}` event (the synthetic `<synthetic>` assistant line stays dropped), rendered in a code plate (`/context`'s tables through `.md-table` scrolling) with Copy.

**Menu UX.**
- `/` as the **first character** of an empty composer opens it; a `/` later never does; `//` sends a literal slash. Caret-anchored, opening upward, the same popover as `@` (§13.4; Apple: same kind, same place), max 8 rows, `max-width: min(28rem, 100vw - 2rem)`, no animation, combobox semantics.
- Rows: `/name` in mono, the `argumentHint` muted (truncating), a one-line description; aliases match but get no rows; duplicates (project vs plugin) show their source. Fuzzy filter on name, then description.
- ↑/↓ move; Tab or Enter completes to `/name `, entering command mode: a "Command" chip at the left, the argument hint as placeholder; Enter then dispatches. Esc or Backspace past the `/` leaves command mode.
- A typed `/foo` that matches nothing sends as text, with the hint "Not a command for this agent; sends as text" while typing (Q36: honest label; the spike shows it reaches the model as text anyway).
- Empty state: "No commands loaded yet. They appear after the agent starts." (or the template list with "From template").

### 13.4 `@` completion (Q23)

- Built on `cmdk` (approved, decision 8) in a Radix popover anchored to a zero-size element at the caret, opening upward; opened by typing `@` anywhere or by the toolbar button; no animation; max 8 rows; `max-width: min(28rem, 100vw - 2rem)` with collision padding; `aria-activedescendant` combobox semantics; ↑/↓ move, Tab/Enter accept, Esc closes and leaves the text.
- Rows: avatar 16, display name (wrapping, `dir="auto"`), muted middle-truncated `@slug`; humans by name and handle; `@humans`. Ranking: your reports and recent senders first, then alphabetical; live agents only.
- Task comments insert `@slug ` (routing as today). The session composer inserts plain text; session UI copy never says "mention" (Q23).

### 13.5 Attachments (Q37)

- **Composer:** paste, drop (onto the composer only) or pick files. Each becomes a chip (name middle-truncated, thumbnail for images, an icon otherwise) with upload progress, Cancel and Retry; Send is disabled until uploads settle; up to 10 per message, chips wrap.
- **Upload:** `POST /api/agents/:slug/uploads` (multipart, 20 MB per file), with the same access check as sending that agent a message. The server builds the stored name, `.factory/uploads/<yyyymmdd>-<id>-<safe name>`: the client's name is stripped of path separators and control characters and capped at 80 characters, never trusted for the path; the resolved path is asserted to stay under the workdir's `.factory/uploads/`. The type is sniffed from the content (magic bytes for png, jpeg, gif, webp; UTF-8 text check for text-like files: txt, md, json, csv, log, source code); the extension and client MIME type are not trusted; SVG and HTML are refused (415). It returns `{ uploadId, path, kind, bytes, width?, height? }` and records the upload (a row tied to the agent).
- **Send:** the body gets one line per file, `[attached: .factory/uploads/…]`; the 64 KB body limit counts those lines. The agent reads the file with `Read` (verified in the spike); nothing from the file enters the event log or tool meta beyond the path (an image `Read`'s base64 is never stored, §9.1).
- **Display:** `MessageBlock` renders an `[attached: …]` line as a chip only when it matches an upload the server confirmed for that agent (the message's attachments are returned with it); a typed or agent-written `[attached: ../…]` stays plain text. Image chips preview through `GET /api/agents/:slug/uploads/:id` (authenticated, `X-Content-Type-Options: nosniff`, the sniffed `Content-Type`; non-images as `Content-Disposition: attachment`).
- **Lifetime:** uploads live and die with the workspace (no TTL in v1). Uploading to an agent that terminates mid-upload fails with the composer's inline error.
- **Rejected:** base64 image blocks over stdin (spike: they work, but they turn the envelope into a content array, interact with batching and merging, and put images in the session transcript and log).
- **Deferred:** PDFs and other types (untested in the spike), a follow-up issue.

## 14. Header (PR1)

The header loses Stop (§6.1). It keeps the status badge and U2's one live fact; the activity line stays in the timeline only (one surface).

## 15. Server changes

| PR | Change |
|---|---|
| 1 | `interrupt()` takes the hold, `waitReason: "stopping"`, `publishQueue()` on hold edges, factory event `interrupt_unconfirmed` (§6.3); `turnStartedAt` on `AgentSummary` and the `agent_status` frame (§5.2); cancel/restore routes, runtime methods, the `messages_state_check` migration and the `cancelled` state in shared enums (§6.4); `clientMessageId` on `POST /messages` with 10-minute dedupe, echoed on the queue item and envelope (§13.2) |
| 3 | `tool_result.meta` in the mapper and `packages/shared` (§9.1); fixtures for Grep, Glob, MultiEdit, WebFetch |
| 4 | `--include-partial-messages`, `LiveEvent`, runtime `LiveState` and its loop, `live` frame and `live_snapshot` client message, `messageId`/`blockIndex` on persisted events (§11); `task_progress` mapped; `background_task_finished.usage`; Agent meta; a foreground-subagent fixture (§12) |
| 5 | `initialize` at process start, `commands` column, `GET`/`POST /api/agents/:slug/commands`, `control{cmd:"command"}`, `command_output`, the `command` queue item (§13.3); uploads route, table and `GET` (§13.5) |

## 16. DESIGN.md amendments

1. **Components → Composers** (PR1, PR5): "The composer is one plate with the textarea and a toolbar inside its frame; it grows to 12 lines or 40% of the viewport, whichever is less. Send is a labelled primary, disabled-shaped while empty. While a turn is open, Stop sits left of Send: an outline button, the one toolbar control that acts on the running turn. Esc in the composer closes an open menu, then an open peek, and only then stops the turn. ⌥/Alt+Enter sends and interrupts the turn; ⌘/Ctrl+Enter also sends normally. Keys typed during IME composition never send, stop or complete. The composer's height never changes when a turn opens or closes."
2. **Typography** (PR2): Hierarchy: reading prose 15/24 for speech, task bodies and comments; markdown h1/h2/h3 20/17/15, demoted 17/16/15; in the session timeline every speaker's markdown uses the demoted scale; tool output markdown 13/20. Replaces "Reading prose stays 14/22 for now…". Named Rules → Tracking scales with size: "−0.015em at 20px and above and −0.01em at 15–17px apply to Archivo headings; Geist body and UI text stays at 0 at every size."
3. **Motion → Frequency decides** (PR1): "Rows appended to the session timeline by a live frame fade in with opacity only (150ms `--ease-out`). Never on load, Load earlier, resync or a reconnect's catch-up, never with movement or stagger. A row that replaces one already on screen (a queued or sending message becoming the delivered one, live text becoming the saved message, a tool call joining a folded run, the activity line becoming the turn footer) doesn't fade. Other live lists stay instant." And: "A running turn shows a ticking duration; waiting lines and holds keep fixed times."
4. **Motion → Deliberately not used** (PR2): blur crossfades are allowed for copy feedback (150ms, blur ≤1px), the first component that needs one.
5. **Colors → Semantic** (PR3): `--diff-add` and `--diff-remove`, low tints of success and crimson on the plate, per theme; the +/− sign is always shown; diff code keeps ink colour and is not syntax-coloured.
6. **Components → Session timeline** (new, PR2–PR4): the three tiers and their spacing; the card rule ("an envelope that crossed a session boundary is a card"); speaker lines; the deep-link arrival (the row takes focus; a 6% tint on the row's own box fades over 300ms after 2s of visible time); folded tool runs; subagent cards as a header row with a neutral rule guide, no fill or box; the one row menu; state chips carry one word, detail goes on the line below; tool output tails clamp by lines and characters; streamed text with no caret; no markdown image loads automatically in the timeline or inbox.
7. **Components → Completion menus** (PR5): keyboard-opened, so no animation; anchored at the caret, opening upward.
8. **Layout** (PR3): "Data rows are at least 32px; their text wraps rather than clipping at large text sizes."
9. **Components → Markdown** (PR3): "…mermaid diagrams always on a light plate, in trusted content; in tool results a mermaid fence shows as code."

## 17. Behavior-doc edits (gitignored `docs/product/`; applied in the main checkout by the dev in the PR named, listed in its description)

- `behavior/agents-and-sessions.md` (PR1): Stop and Esc in the composer, ⌥Enter urgent, header without Stop (narrowing decision 5); held-message Cancel and Undo; the activity line ticks, waiting lines don't. (PR4) live streaming defined as ephemeral and never stored. (PR5) `/` commands replace "the composer never interprets slash commands"; attachments.
- `architecture/harness-driver.md` (PR3, PR4, PR5): `tool_result.meta`; `LiveEvent`; mapping of `stream_event`, `task_progress`, `thinking_tokens`; `initialize`; `command_output`; the interrupt hold.
- `architecture/agent-runtime.md` (PR1): a plain interrupt takes the urgent hold.
- `architecture/data-model.md` (PR1, PR5): the `cancelled` message state; `clientMessageId`; the `commands` column; uploads.
- `ui-review/decisions.md`: a note under decision 5 pointing at Q2.

## 18. Testing

- Unit: `deriveActivity` priority incl. several subagents; `buildRows` open turn, footer (command turns, cron wording), head flags; `groupWork` (runs, splits, denial excluded, first-child key, expand carry-over, partial labels, one-commit settle); `mergeFailures` (key, seqs, date); `splitBlocks` and `plainLength`; the stream tail parser (fences, inline markers, links, tables, long paragraphs); the reducer's `handedOff`, `retired`, `liveAfter`, cancel overlay and optimistic blocks; `isUrgentSendKey`; the IME guard; `formatDuration`; mapper meta per tool from fixtures and meta bounding; `LiveEvent` mapping from the spike traces.
- Component: Stop and Esc (menu-open, peek-open, IME, no-turn cases); composer height constant across turn edges; Cancel/Undo incl. text back into the box; Jump pill labels, cap and windowed navigation; stick-to-bottom intents (2,000px growth, 40px wheel-up, scrollbar-style scroll, selection, composer typing, expand anchoring within 1px); deep-link focus, tint timer paused while hidden; row menu items per kind; renderers per tool incl. no-meta fallback, `partial`, binary output, image Read; images rendered as links; fence-close highlighting; live handoff height equality.
- Render counts (`timeline-perf.test.tsx`): acceptance 22.
- Server: interrupt hold (second interrupt, publish edges, fallback event); cancel/restore incl. 403, 409s, ordering after later writes, audit log; `clientMessageId` dedupe; command validation and the raw line's exact bytes; uploads (name sanitizing, path escape attempts, sniffing, SVG/HTML refusal, nosniff headers, access).
- Fixture replay: the spike streams through mapper → runtime → reducer (acceptance 18).

## 19. Follow-up issues (opened with the decisions issue)

1. Timeline virtualization (break L7): measure after PR4 on the 2,400-event dataset; numbers in the issue.
2. Find in session (chat L4).
3. `T-` task completion in composers (Q23).
4. Mobile composer layout and row long-press → U4 (Q25).
5. Attachments: PDFs and other file types, untested in the spike (Q37).

## 20. Delivery

Five stacked PRs on `u2/6-templates-inbox-home` (#101), in this order (Q1):

| PR | Branch | Content |
|---|---|---|
| 1 | `u3/1-live-turn` | §5, §6 (session composer in place, drafts and optimistic send), §8, §14, D1, Cancel |
| 2 | `u3/2-timeline-tiers` | §7 |
| 3 | `u3/3-tools` | §9, §10 |
| 4 | `u3/4-streaming` | §11, §12 |
| 5 | `u3/5-shared-composer` | §13 |

## 21. Decisions

Proxy answers Q1–Q37 and tech-lead decisions D1–D3 are logged in the decisions issue. D1: a plain interrupt takes the urgent hold, so Stop-then-Send can't be absorbed by the aborting turn (§6.3). D2: only `kind = 'message'` rows are cancellable, and a cancel never withdraws a wake under way (§6.4). D3: the announcer counts unmerged failures (§7.6).

Rated 3/5 or lower, for Or:

- **Q2** (3/5): Stop only in the composer; narrows decision 5's "header keeps … plus Stop".
- **Q4** (3/5): ⌥Enter for urgent and no split-Send menu.
- **Q7** (3/5): speech prose 15/24.
- **Q8** (3/5): deep-link arrival as real focus plus a fading tint (timing settled in Q28, 4/5).
- **Q10, cost part** (3/5): estimated cost on every turn footer.
- **Q22b** (3/5): ↑ recall from the loaded timeline.
- **Q31, text back into the box** (3/5): Cancel with an empty box moves the text into it.

## 22. Risks

- **Streaming cost on long sessions.** Mitigated by stable row identity, a memoized live tail and one commit per frame; measured in PR4 (acceptance 23) before deciding on virtualization.
- **Stop hold delays a steer by up to 10 seconds** if Claude never answers the interrupt; the fallback line makes it visible.
- **`initialize` once per process:** a skill added mid-process appears only after the next start (unverified whether `initialize` can be re-sent).
- **Prose at 15/24 lengthens sessions**; folding tool runs gives the height back (Q7).
- **Fixture gaps:** Grep, Glob, MultiEdit, WebFetch and foreground Agent results have no fixture yet; PR3/PR4 record them, and renderers fall back without meta.
