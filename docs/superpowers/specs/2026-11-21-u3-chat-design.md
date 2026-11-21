# U3 Chat: Technical Design

- **Date:** 2026-11-21
- **Status:** Revised after the self-review and five UI-lens reviews (Taste, Apple design, Emil design-eng, Motion, Break UI) at `409904c`, spike-u3's findings, and the self, Motion and Break UI re-reviews at `e279481`. Owner-proxy (owner-u3) answered Q1–Q44. Low certainty and deviations for Or: §21.
- **Source of truth (gitignored, read from the main checkout):** `docs/product/ui-review/decisions.md` (decisions 1–21; 7, 13 and 16–21 binding here), `docs/product/ui-review/status.md` (U3 table rows 1–12, file:line at `322075d`), `docs/product/ui-review/pr76-review.md` (the U3 items decision 15 hands over), the seven reviews in `docs/product/ui-review/` (chat.md is the main source), `docs/product/behavior/*.md`, `docs/product/architecture/harness-driver.md`, and the spike write-up `docs/product/architecture/claude-streaming-and-commands.md` with its traces in `docs/product/ui-review/u3-spikes/` (Claude Code 2.1.327).
- **Builds on:** U1 (PRs #84–#88, decisions #77): the control system, `data-instant`, memoized timeline rows (`stabilizeRows`, `TimelineItem` + `itemPropsEqual`, memoized `Markdown`, rAF-batched frames), the send-key rule. U2 (PRs #95, #97–#101, decisions #89, leftovers #102): `AgentChip`, `AgentAvatar`, `MiddleTruncate`, `InlineOutcome`, `Kbd`, the one-line header and `LiveLine`, Agent details, the shortcut layer, `requestComposerFocus`.
- **Followed by:** U4 (create flows and mobile). U4 owns the mobile composer layout and long-press on rows (Q25).
- **Decision log:** GitHub issue "U3: Chat — decisions"; Q1–Q44 are the proxy's answers, D1–D5 tech-lead decisions.

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
3. **Stop.** While `turnOpen`, an outline Stop (CircleStop + "Stop") sits left of Send in the composer; the header has no Stop. Clicking it, or Esc with focus in the composer, no completion menu or peek open and no IME composition, sends one interrupt and shows a spinner and "Stopping…" until the turn closes. Esc with a menu open only closes the menu; in command mode only leaves it; with a peek open only closes the peek. With no turn open, or while a compaction runs (Stop disabled, "Compacting…"), Esc does nothing to the agent. Send stays right-anchored.
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
18. **Streaming** (PR4): text appears as it is generated, committed at most once per frame, no caret; reload mid-answer shows the text so far, without a fade; the persisted block retires the live one in one commit keeping the same DOM element (a selection inside survives), the same height and no fade, with one `highlight()` call per fence; a late live frame or a server delta for a retired key is ignored; an interrupt mid-text leaves exactly one block; live text stops at 64 KiB with "Cut at 64 KB; the full text stayed with the agent.", and the persisted row says the same. Tail parsing shows no raw syntax (fence openers, list/heading markers, `**`, `_` per GFM flanking, half links, tables before their delimiter row). The activity label never flickers through "Working" (400ms hold) and "Thinking" shows only during a thinking block. Fixture tests built from the spike's recorded streams cover these, including the interrupt and async-subagent cases.
19. **Subagent cards** (PR4): the Agent/Task call renders as a header row with a neutral rule guide (no fill, no box), type, description, state chip (tooth + "Running" while live), a live progress line carried in the subscribe snapshot, body collapsed with the result last; the 4th and later parallel subagents collapse into one "+N more subagents · k running" row below the first 3 cards (cards on screen never collapse); an async-launched subagent stays "In background" until its `background_task_finished`; subagent children are one plate deep.
20. **Composer** (PR5; drafts and optimistic send ship in PR1 for the session composer): one `Composer` in `components/composer/` used by the session, task comments and the inbox pane; `CommentComposerHandle` (`reply`, `prefill`) unchanged; Send is a labelled primary, disabled-shaped when empty, graphite at once when text is typed; the box grows to 12 lines or 40svh (6 lines or 35svh below `md`), whichever is less; drafts in `localStorage` with a 7-day expiry and no cross-tab clobbering; ↑ in an empty box recalls your last loaded message; optimistic send per §13.2 (no flash under 400ms; `clientMessageId` dedupe, server test; a 15s abort and a late landing never deliver twice); the toolbar's height is constant across turn edges at 100% and 200% text.
21. **`/`, `@`, attachments** (PR5): `/` typed as a single first token opens the agent's commands (from `initialize`; "From template" before the first start; "Commands as of …" when stale), a paste never opens it, `//` escapes; Enter accepts only a name match, else sends the text unchanged (a pasted multi-line text starting with `/` sends unchanged); `@` anywhere opens agents and humans; both caret-anchored, opening upward, no animation, combobox semantics, Tab and Enter accept. Server: a refused built-in (`model`, `config`) or an unknown name → 422; aliases canonicalized; a command is held while a turn is open and nothing is written behind it until its turn ends; `/context` produces a `command_output` row; your own held command can be cancelled. Attachments in the session composer only: uploads per §13.5 (sanitized names, symlink refusal, sniffed types, 415/422 reasons, header-only dimensions), confirmed chips only, orphans deleted after 24h, `.factory/` in `info/exclude`.
22. **Render counts** (`timeline-perf.test.tsx`): an `Elapsed` tick, an `agent_status` frame and a queue frame re-render no `TimelineItem` (PR1); a tool row joining a group re-renders only that group, and expanding a child inside a group re-renders that group (PR3); a live frame re-renders only the live row, `ActivityLine` and `JumpPill`, never another `TimelineItem` or the composer (PR4).
23. **Background tasks** (PR3): a background Bash shows "In background" on its own call row and "Finished"/"Failed" with the summary below when its `background_task_finished` lands; no separate quiet lines; an unmatched task keeps its quiet line.
24. **Manual, recorded in each PR:** before/after screenshots of a long session in light and dark (PR2, Q7); an Edit diff in both themes (PR3, Q18); a 40-call turn folded and expanded; the 2,400-event dataset scrolled and streamed under 4× CPU throttling with numbers into the virtualization issue (PR4); a reload mid-answer (PR4); the composer at 200% text at 1440×900 (PR5); 320px with an 80-character name and a 55-character MCP tool name (PR2, PR3).

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
- Label swaps are instant, except a change **to** the fallback "Working", which holds the previous label for 400ms (Q41; it stops a flicker through "Working" between blocks); the hold never outlives the turn: when the turn ends the line goes at once. PR4's fast-changing parts (input KB) round and update at most twice a second. `tool_input` and the open-tool label share one target formatter.

### 5.2 `ActivityLine` (`features/session/activity-line.tsx`)

- Position: the timeline footer, **directly under the last row** (including PR4's live text), then queued items, then nothing; the composer sits below the timeline. That reads in time order: now, then next (Apple M6).
- Layout: `[tooth] [Elapsed, shrink-0, tabular-nums] · [label, min-w-0, first line only, middle-truncated, title on hover]`. The duration comes first so the ticking number never moves sideways when the label changes.
- `Elapsed` is its own component: a `setTimeout` chain aligned to the next whole second since `startedAt`, recomputed at once on `visibilitychange` to visible, paused while hidden; `Math.max(0, …)` against clock skew; format "42s", "1m 09s", "1h 03m" (the one `formatDuration`, §5.4; padded so the width only changes at unit boundaries). Nothing else re-renders per tick (acceptance 1).
- `startedAt` = `agent.turnStartedAt` (new on `AgentSummary` and the `agent_status` frame, §15; set when the runtime opens the turn, cleared when it closes). Without it the duration is omitted.
- The line fades in once when it mounts (150ms opacity, the live-row rule) and never animates otherwise. The tooth never pulses.
- The behavior doc gets the distinction (§17): a running turn shows a ticking **duration**; waiting lines and holds keep fixed times and never tick.

### 5.3 Turn footer (Q10)

- `rows.ts` gains a `turn_footer` row kind, built from a non-error `turn_end` and that turn's `usage` event (the same event the usage service records into `turns`, so the footer and the Usage page show the same numbers; the web app computes no estimate of its own). Turns with `turn_end.command` (compact, local commands) get no footer.
- Text: "Worked {formatDuration(usage.durationMs)}" + " · {n} tool call(s)" (n = `tool_call` events in the turn incl. nested; omitted when 0) + " · ${cost} est." (only when `costUsd ≥ 0.01`, two decimals). Self-started turns: `originKind` "task-notification" → "Woke for a background task · 12s"; a cron firing → "Woke for a cron · 12s" (+ the same parts).
- A turn with no `usage` (an old row, an exit) shows no footer. Errored turn ends keep today's quiet line ("Turn interrupted", "Turn ended with an error").
- One commit: the runtime publishes the `turn_end` event before the job that later sends `agent_status{turnOpen:false}`, so the two can land in different frames. The session reducer therefore applies `turnOpen = false`, clears `turnStartedAt` and clears `state.live` (except subagents) itself when it applies a `turn_end` event; the later status frame agrees. The activity line goes and the footer arrives in that one step; the footer never fades (§8.3). Groups decide "live" from rows (no `turn_end` after the newest `turn_started`), never from `agent.turnOpen`.
- If the turn's start isn't in the loaded page, n counts only loaded calls; the footer then omits the count rather than understating it (it knows: the turn's `turn_started` isn't loaded).

### 5.4 Formats

One `formatDuration(ms)` in `features/session/format.ts`, used everywhere (activity line, footer, group summaries, subagent figures): "42s", "1m 09s", "2m 13s", "1h 03m", no space; the smaller unit is padded to two digits after a larger one. Prose copy says "10 seconds".

## 6. Composer controls (PR1)

PR1 changes today's `features/session/composer.tsx` in place; PR5 moves it into the shared primitive (§13) without changing behaviour.

### 6.1 Stop (Q2, Q3, Q27)

- While `agent.turnOpen`: an **outline** button, CircleStop + "Stop", left of Send. Send stays right-anchored; Stop's appearance never moves it. It reuses `InterruptButton`'s logic (moved to `features/session/stop-button.tsx`): one `postInterrupt`; then a spinner replaces CircleStop and the label reads "Stopping…" (`aria-disabled`) until `turnEpoch` changes; a 409 is ignored; other failures go to the composer's error line ("Couldn't stop: …"). Under reduced motion the spinner stops and the label carries the meaning.
- The header's Stop is removed (`SessionActions`, `session-view.tsx:503-506`). DESIGN.md and `agents-and-sessions.md` are amended (§16, §17): this narrows decision 5's "plus Stop" (Q2, flagged in §21).
- When Stop unmounts while focused (the turn closed), focus moves to the textarea.
- Below a container width of ~24rem (200% text), Stop drops its visible label (aria-label kept).
- While a compaction runs (`agent.compacting`, from the runtime's `compactInFlight`, added to the status frame), Stop is disabled and reads "Compacting…" (D5): the runtime never interrupts a compaction, and the control says what it can actually do. `interrupt()` during a compaction returns 409 `compacting`.

### 6.2 Keys (Q3, Q4, U1 rule)

`lib/send-key.ts` gains `isUrgentSendKey(e)`: Enter with `altKey`, not composing, fine pointer only. The textarea's `onKeyDown`, in order:

0. IME guard: `isComposing` or keyCode 229 → return (nothing below runs).
1. Esc: if a completion menu is open (PR5), close it; else if command mode is on (PR5), leave it; else if a peek or popover is open, let it close (don't handle); else if `turnOpen`, Stop isn't pending and no compaction runs, stop. `preventDefault` + `stopPropagation` only when the composer handled it. Otherwise Esc is not handled.
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
- A 6% signal tint on the row's own box (the card or the row, never the `pr-8` wrap or gutter): `[data-arrived]::before` with `background: color-mix(in oklab, var(--signal) 6%, transparent)`. After **2s of visible time** (the timer runs only while `document.visibilityState === "visible"`, starting after the row has painted), it fades over **300ms `--ease-out`** (opacity of the pseudo-element; the attribute stays as `data-arrived="fading"` until `transitionend`, so the fade isn't cut). The fade stays under reduced motion. Inside DESIGN.md's 300ms ceiling, so no amendment.
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
- `ClampedMarkdown` (message, outgoing and spawn bodies only; agent text stays unclamped, so a long reply never collapses at the streaming handoff) clamps at 40 lines or 4,000 rendered characters (`plainLength()`: the source with markdown syntax stripped by a cheap regex pass), whichever comes first. The cut is made at the last blank line before the limit that is outside a fence, with an open fence closed virtually: the same `splitBlocks` splitter §11.4 uses, built in PR2 (`components/markdown/split-blocks.ts`). "Show all" expands in place: it unpins and anchors (§8.1), so nothing above moves.

### 7.7 The rows pipeline (U1's stable references, extended)

1. `buildRows(events)` → raw rows (+ `head` flags, `turn_footer` rows, `at`/`resultAt` on tool rows, background-task attachment §9.5; Agent/Task calls become `subagent` rows, their own kind, with `children` like `tool`).
2. `stabilizeRows(prevRaw, raw)` → unchanged raw rows keep identity (children first, as today). `prevRaw` is the previous step-2 output, kept separately.
3. `groupWork` (§9.4), `groupSubagents` (§12) and `mergeFailures` (§7.6), producing `work_group`, `subagent_overflow` and merged `error` rows. Summaries are flat primitives (`verbsKey: "read:6,ran:4"`, `durationMs`, `live`, `callCount`), never JSX or nested objects, so the shallow `sameValue` compares them.
4. `stabilizeRows(prevFinal, grouped)` by key, where `prevFinal` is the previous step-4 output; `stabilizeRow` recurses into the children of `work_group`, `subagent` and `subagent_overflow` rows as it does for `tool` children. Because step 2 reused the children, a grown group gets a new group object holding the same child objects.

Every tool-only tree walk learns the new kinds: `itemPropsEqual`'s `subtree()` (`timeline-item.tsx:22-26`), `hasKey`, `containsSeq`, `targetRowKey` (`timeline.tsx:330-358`), `scanRows` (`session-view.tsx:376-391`) and `stabilizeRow` (`rows.ts:286-300`). One helper, `childrenOf(row)`, returns the children of `tool`, `work_group`, `subagent` and `subagent_overflow` rows, and all six use it. Render-count tests: acceptance 22.

## 8. Scrolling and live rows (PR1)

### 8.1 Stick-to-bottom on intent (Q12)

`Timeline` keeps `pinned` (ref). Today's position test (`timeline.tsx:159`) stops deciding it. It tracks `lastWrittenTop`, the `scrollTop` its own code last wrote, so it can tell its own scrolls from the user's.

- **Unpin** (fast paths): `wheel` with `deltaY < 0` and `|deltaY| > |deltaX|`, unless a nested scroller under the pointer (code plate, table) can absorb it; `touchmove` upward; PageUp, Home, ↑, Shift+Space with focus inside the log; focus entering a row above the viewport; a non-collapsed selection inside the log (`selectionchange`); a user-initiated expand, collapse or "Show all" inside the log (it also anchors that element, below).
- **Unpin** (fallback): any `scroll` where `scrollTop` decreased, isn't `lastWrittenTop`, and the view is now more than 8px from the bottom (scrollbar drag, middle-click autoscroll, find in page). A content shrink while pinned (a held table row becoming a table) clamps `scrollTop` but leaves the view at the bottom, so it doesn't unpin.
- **Re-pin:** a downward user scroll that ends within 8px of the bottom as measured against the `scrollHeight` at the previous scroll event (so content growing under a streaming tail doesn't move the target); Jump; End in the log; sending from the composer; a selection that collapses while within 8px.
- While pinned, the ResizeObserver and the rows layout effect write `scrollTop = scrollHeight` (recording `lastWrittenTop`) after layout and before paint, so growth never unpins (the 2,000px test).
- **Anchoring while unpinned (every height change, not only width):** the existing `captureAnchor`/`widthAnchor` mechanism runs for every content-height change while unpinned (a background task finishing, a group summary settling, a merged failure's count, a subagent result above the viewport): the top visible row keeps its position. A user-initiated toggle anchors the toggled element's top instead. No reliance on `overflow-anchor` (Safari lacks it; our own writes would fight it).
- Typing in the composer never unpins (its keys aren't in the log).
- Tabbing into the log focuses the tab-stop row; if that is above the viewport, that is a focus-above intent and unpins.

### 8.2 One Jump to latest (Q11)

- `JumpPill` (`features/session/jump-pill.tsx`), always mounted, absolutely positioned and centred on the 52rem column (not the scroller); `data-shown`, `inert` and `pointer-events: none` while hidden. Surface: `plate-raised` with `float-edge`, no shadow (decision 11), 32px, ArrowDown + label, `max-width: calc(100% - 2rem)`.
- Shown when unpinned and something arrived since, or when windowed.
- Label: speech rows appended (a persisted block that retires a live one doesn't count again) (message, outgoing, agent text rows; a live text block counts once) → "1 new message" / "3 new messages" ("99+ new messages" cap, tabular nums); anything else only → "New output"; windowed → the speech count of `newWhileAway` (the reducer counts speech for windowed frames too), else "Jump to latest"; never "· 0". Label changes are instant.
- Action: windowed → navigate to `/agents/$slug` (today's behaviour); else scroll to bottom instantly and re-pin.
- End in the log focuses the last loaded row and re-pins; it never navigates (the pill alone leaves a windowed view).
- Motion: CSS transitions naming `opacity` and `translate` (interruptible, never keyframes), with the pill's own reduced-motion rule (the global block only zeroes tw-animate's variables): enter opacity 0 → 1 with `translate: -50% 4px` → `-50% 0`, 150ms `--ease-out`; exit the reverse, 100ms; opacity only under reduced motion; instant when shown or hidden by a key (`data-instant`).
- Removes `timeline.tsx:310-324` and `session-view.tsx:278-289`.

### 8.3 Live-row fade and handoffs (Q13)

**Rule:** a row fades only if its content was not on screen in the previous commit and it arrived by a live frame. A node that replaces one already on screen never fades.

- `useSession` records `liveAfter`: the highest seq when the last `loaded` landed, again when the subscribe's `reset` live frame arrives (it is sent after the replay drains, §11.3, and marks "caught up", so a reconnect's catch-up never fades), and again on `visibilitychange` to visible (rows committed while the tab was hidden never got a style pass and must not all fade at once on return). A commit that appends more than 10 rows counts as a load (no fade).
- `TimelineItem` gets `live: boolean` (compared in `itemPropsEqual`) and sets `data-live` when `row.seq > liveAfter` and the row's key isn't in the reducer's `handedOff` set.
- CSS: `[data-row-wrap][data-live] { transition: opacity 150ms var(--ease-out); @starting-style { opacity: 0 } }`. `@starting-style` applies on insertion only, so re-renders never replay it. Reduced motion keeps it (opacity only).
- `handedOff` (reducer state, keys of rows that replace something on screen):
  - a `message_in` whose envelope `id`/`ids` match queue items or optimistic "Sending" blocks (by `clientMessageId`, §13.2): those items are removed in the same reducer step;
  - a persisted `assistant_text` that retires a live block (PR4, by `(messageId, blockIndex)`), added only if `live.text` held that key (the row keeps the live block's key and DOM anyway, §11.4);
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
  z.object({ tool: z.literal("Agent"), async: z.boolean().optional(), toolUses: z.number().optional(), tokens: z.number().optional(), durationMs: z.number().optional() }), // from totalToolUseCount, totalTokens, totalDurationMs; async from isAsync / status "async_launched"
]);
```

- `tool_result` gains `meta: toolMetaSchema.optional()`.
- The mapper (`mapper.ts:295-301`) builds it from `tool_use_result` only when the `user` line holds exactly one `tool_result`. It **never copies** `originalFile`, `file.base64` or `file.content` (the spike: an image `Read` carries the image twice on stdout, 675 KB). It bounds meta itself: hunks are added until 32 KiB serialized, then `partial: true`; `stderr` ≤ 16 KiB. capPayload still applies.
- Shapes from the fixtures: Edit's result has no `type` (always an update; keys `filePath, oldString, newString, originalFile, replaceAll, structuredPatch, userModified`); a Write create has `type: "create"` and `structuredPatch: []`, so the create view reads its line count and first 20 lines from the call input's `content` (already persisted); an image Read is `file{base64, originalSize, dimensions}` (spike trace `attach-file-path`). Bash: `{stdout, stderr, interrupted, isImage, noOutputExpected, backgroundTaskId}`.
- No meta, and data from elsewhere, for: TodoWrite (the checklist is the call input), Grep/Glob (counts parsed from `content` when its first line reads "Found N files" (else the line count); a file list from `content`'s lines, bounded to 200 with the true count), WebFetch/WebSearch (host and path from the call input; status and size only if PR3 records a fixture showing them). PR3 records fixtures for Grep, Glob, MultiEdit and WebFetch with the spike credentials and adds meta for any whose shape then proves useful.
- Agent: the foreground Agent result's `totalToolUseCount`, `totalTokens`, `totalDurationMs` (the spike's `partial-thinking-summaries-forward-subagent` trace has one), and `background_task_finished` gains optional `usage{toolUses, tokens, durationMs}` from `task_notification` (`background-subagent-stdin-closed.jsonl`). An async launch (`partial-subagent.jsonl`) sets `async: true` (§12). Without usage, the subagent card shows no footer.

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
- `LiveEvent` (in `packages/harness`, never in `HarnessEvent`):

```ts
type LiveEvent =
  | { type: "text_start"; messageId: string; index: number }
  | { type: "text_delta"; messageId: string; index: number; text: string }
  | { type: "tool_start"; messageId: string; index: number; toolUseId: string; name: string }
  | { type: "tool_input"; messageId: string; index: number; bytes: number; target?: string } // file_path / command / pattern, parsed early from partial_json
  | { type: "thinking_start"; estimatedTokens?: number }
  | { type: "thinking_stop" }
  | { type: "subagent_progress"; toolUseId: string; description: string; subagentType: string; toolUses: number; tokens: number; durationMs: number; lastTool?: string }
  | { type: "message_stop"; messageId: string };
```

- **Plumbing.** `mapLine` returns `{ events: HarnessEvent[]; live: LiveEvent[] }` (its tests updated); `ClaudeProcess` pushes them to `events` and a new `live: AsyncQueue<LiveEvent>`. `HarnessProcess.live` is optional, so the fake driver and other drivers need nothing. `stream_event` gets its own `mapLine` case; `thinking_tokens` and `task_progress` leave `DROPPED_SYSTEM` (`mapper.ts:63-66`). The stdout debug log (`process.ts:94`) skips lines whose parsed `type` is `stream_event`.
- **Mapping.** `message_start` records `api_message_id`; `content_block_start` (text → `text_start`; tool_use → `tool_start`; thinking → `thinking_start`); `content_block_delta` (`text_delta` → `text_delta`; `input_json_delta` → `tool_input` with cumulative bytes and `target` once `"file_path"`, `"command"` or `"pattern"` is complete in the partial JSON; `thinking_delta` → `thinking_start` with the latest `estimated_tokens`); `content_block_stop` of a thinking block → `thinking_stop`; `message_stop` → `message_stop` (and `thinking_stop`); `system/thinking_tokens` → `thinking_start`; `system/task_progress` → `subagent_progress`. Subagents never stream text (spike).
- **Reconcile key.** Persisted `assistant_text` and `tool_call` gain optional `messageId` (the `message.id`) and `blockIndex`: the block's index in the API message, computed as (content blocks seen on earlier `assistant` lines with that id, including the thinking, redacted-thinking and empty-text blocks the mapper drops) + the position within this line's `content`. The trace check: stream index equals persisted position (thinking at 0, text at 1). The per-id counter map clears at `turn_end`.

### 11.2 Runtime

- The runtime drains `proc.live` in its own loop, outside the serial job queue (no DB, no job). It keeps `LiveState` in memory: `text?: { messageId, index, text, capped }` (at most one block), `toolInput?: { toolUseId, name, bytes, target }`, `thinking?: { tokens }`, `subagents: Map<toolUseId, progress>`, and `retiredKeys: Set<"messageId:index">` for the open turn.
- It publishes coalesced `live` frames on the bus every 50ms while something changed (the first delta of a block on the leading edge).
- **Retirement.** The job that appends a persisted `assistant_text` with key K adds K to `retiredKeys` and clears `text` if it holds K, before publishing the `session_event` (the complete `assistant` line arrives just before `content_block_stop`, so retire on the line, never wait for the stop). The live loop drops any later delta for a key in `retiredKeys`, so a lagging delta can never recreate a retired block (or put it into a snapshot next to its persisted row). The persisted `tool_call` clears `toolInput`. A thinking block's stop clears `thinking`.
- **Ends.** `turn_end` and `exited` clear `text`, `toolInput`, `thinking` and `retiredKeys` and publish a `reset` frame; a subagent's entry clears on its `background_task_finished`, or on its `tool_result` unless the call is async (§12). Whenever state is cleared other than by a retirement, a `reset` is published.
- **Cap (Q44).** `text` stops growing at 64 KiB (`CAP_BYTES`), marked `capped`; the tail then shows the muted line "Cut at 64 KB; the full text stayed with the agent.", and the persisted row (cut by capPayload, `truncated` record set) shows the same line, so what was read while streaming is what stays.
- Interrupt mid-text: Claude flushes the partial text as a normal `assistant` line (`terminal_reason: "aborted_streaming"`), so the same retirement applies. A block with no persisted line at all (an interrupt right after `text_start`, whose empty text the mapper drops at `mapper.ts:250`; an exit mid-text) is cleared by the `turn_end`/`exited` reset.

### 11.3 WebSocket

- Server frame `live`: `{ type: "live", agent, text?: { messageId, index, offset, append, capped? } | null, toolInput?: {...} | null, thinking?: { tokens } | null, subagents?: Progress[], reset?: true }`. An absent field means unchanged; `null` means cleared. `offset` is the block length before `append`.
- Client message `{ type: "live_snapshot", agent }` → the server answers with a `reset` frame holding the full `LiveState`. The client sends it when it sees an offset gap.
- `subscribe()` (`ws/route.ts:108-121`) drops buffered `live` frames (the snapshot supersedes them) and sends `rt.liveSnapshot()` as a `reset` frame after the replay and buffer drain; it marks "caught up" (§8.3), and a reload mid-answer shows the text so far (decision 7) without a fade.
- Live text is coalesced into state (latest text per key), never a growing queue, so a hidden tab holds one block, not minutes of frames.

### 11.4 Client

- **State.** Live state lives in the session reducer beside `ordered` (`state.live`), with a `retired: Set<"messageId:index">` seeded from every loaded `assistant_text` that has a key. A persisted `assistant_text` adds its key to `retired` and clears `live.text` in the same reducer step; a late frame or a `reset.text` for a retired key is ignored; applying `turn_end` or `exited` clears `live` (except subagents) and empties `retired` for the turn (§5.3); a persisted `tool_call` clears `live.toolInput`. `state.live` survives a socket drop (the `reset` on resubscribe replaces it in place). Windowed views ignore `live` frames, and the tail renders only when `!state.windowed`.
- **Same DOM at the handoff.** The live block is the last element of the same keyed array as the rows: `[...rows.map(row => <TimelineItem key={row.key}/>), live && <TimelineItem key={liveKey} row={liveRow}/>]`. Persisted `assistant_text` rows that carry a key use `key = "t:" + messageId + ":" + blockIndex` (others keep `${seq}`), and the live row uses the same key and the same `AgentText` component. When the persisted row arrives, React keeps the element: no remount, the selection and focus survive, the height is unchanged, nothing fades.
- **`BlockMarkdown`.** Agent text, live or persisted, renders through one component: `splitBlocks(text)` and one memoized `Markdown` per block in `bare` mode (no per-block `.prose` wrapper), all siblings inside one `.prose-of .prose-of-detail` container, so margins, loose lists and references behave the same in both. `splitBlocks` (§7.6) splits only at a blank line outside a fence where the next non-blank line starts at column 0 and doesn't continue a list or quote, so loose lists and indented continuations stay one block.
- **Highlight once.** `CodeBlock` reads a module-level LRU of highlights keyed by (lang, code) in its `useState` initializer, so the persisted block (or a re-mount) paints highlighted on its first frame and `highlight()` runs once per fence (test).
- **Tail parsing** (in-house, `components/markdown/stream-tail.ts`, ~150 lines, no new dependency, Q35), applied to the open (last) block only:
  - an open fence renders as plain `<pre><code>` without markdown parsing (`closed: false`), split into frozen 50-line slices so growth appends nodes; highlighted once when the fence closes;
  - unclosed `**`, inline backticks and `_` (only when GFM's flanking rule makes it emphasis, so `foo_bar` never flashes italic) are auto-closed; a lone trailing `*` is held;
  - a half link `[text](` shows its text until it closes;
  - a trailing line is held back until its newline when it is only `-`, `=`, `*` or `_`, starts with 1–3 backticks or tildes, or is a bare list, heading, quote or number marker; a trailing `|` line is held until its delimiter row arrives;
  - an open block over 4 KB is re-parsed at most every 250ms (under 4 KB, every committed frame), never split inside the block, so a 6 KB table or list and a 64 KB single paragraph stay one block (height-equality tests for each).
- **Selection.** While a non-collapsed selection intersects the tail, `LiveTail` keeps rendering the snapshot taken when the selection began (frames still land in `state.live`) and catches up in one commit when it collapses; the view is unpinned (§8.1). Retirement keeps the DOM, so it doesn't lose the selection either.
- **Render scope.** A live frame re-renders the live row, `ActivityLine` and `JumpPill` only: the rows list is a memoized element keyed on `rows` and its per-row props, and the composer is memoized on its own props (acceptance 22: a live frame renders no `TimelineItem` other than the live one, and not the composer).
- **Fade.** The live row fades in once, only when its first text came from a non-`reset` frame; never per chunk.
- **Gutter and clamps.** The live row reserves the same 2rem gutter as persisted rows (§7.5). Agent text stays unclamped (§7.6's clamp applies to message, outgoing and spawn bodies only), so a long reply never collapses at the handoff.
- **Activity.** `deriveActivity(open, state.live)` (§5.1); `thinking` counts only while a thinking block is open.
- **Fixture test** (Q35 condition 3): the spike's recorded streams (`partial-text-and-write`, `partial-interrupt-mid-text`, `partial-subagent`), and a synthetic one where the last delta arrives after the `assistant` line, replayed through mapper → runtime → reducer, produce exactly one block per text block, including after a reload in the middle.

## 12. Subagent cards (PR4)

- Agent/Task calls (names `Agent` and `Task`) are `subagent` rows rendered as `SubagentCard` (`features/session/subagent-card.tsx`), Q19, Q30:
  - **Header row** (`min-h-8`): "Subagent · <subagentType, truncating> · <description, truncating>" and a state chip (`shrink-0`): tooth + "Running" while live, "Done", "Failed", "In background". Its accessible name says "in this session", so it never reads as a factory spawn block. No avatar, no link.
  - **Body:** indented, with a 1px neutral `rule` guide down its left (never status-coloured: structure, not state); no fill, no box. The tool bodies inside are the only plates (one plate deep).
  - **Running:** one live line from `subagent_progress`: counters first, tabular ("4 tool calls · 23k tokens · Reading `templates/purchase.md`"), updated at most twice a second, never a ticking timer; carried in the subscribe snapshot. Each card's line is memoized by `toolUseId`, so a frame re-renders only the cards that changed.
  - **Body collapsed by default:** the prompt as markdown, then the nested transcript in order (folded per §9.4), then the result last. When done, the result's first 3 lines show without expanding.
  - **After it ends:** only persisted figures, "12 tool calls · 41s · 23k tokens" from Agent meta or `background_task_finished.usage` (§9.1); no footer when neither exists.
- **Async (auto-backgrounded) calls.** A call whose result is the launch notice (`tool_use_result.isAsync`, `status: "async_launched"`, seen in `partial-subagent.jsonl` without `run_in_background`) is marked `Agent{ async: true }` in meta. Its card stays "In background" and keeps its live line; state and result come only from `background_task_finished` (its summary and usage); the launch text is never rendered as the result.
- **Parallel subagents** (Q40): `groupSubagents` keeps the first 3 consecutive subagent rows as cards; the 4th and later collapse into one `subagent_overflow` row appended below them, keyed by the 4th call, "+N more subagents · k running", which expands in place. Nothing already on screen collapses. No separate "N running" line.
- `targetRowKey`/`hasKey` open a card (and the overflow row, and a group inside) when a deep link lands inside.
- The activity line names subagents only (§5.1).

## 13. The shared composer (PR5)

### 13.1 Primitive (Q21)

`components/composer/composer.tsx`, `Composer`, used by the session (`features/session/composer.tsx` becomes a thin wrapper), task comments (`CommentComposer` keeps its file, props and `CommentComposerHandle { reply, prefill }`, which pr76 requires), and the inbox reading pane's reply.

- Frame: one plate (`field-edge`, radius 6) containing the attachment chips (session), the auto-growing textarea and a 32px toolbar inside the frame. Growth: 2 → 12 lines or 40svh, whichever is less (2 → 6 lines or 35svh below `md`), then it scrolls inside.
- Toolbar: left `/` (session) and `@` buttons opening the same menus as typing (the session's `@` button is labelled "Insert an agent's handle", never "mention", Q23), the attach button (session only, Q38), Write/Preview toggle (comments); middle the hint text (session, §6.2: `min-w-0 flex-1`, truncating, always the first thing to shrink); right Stop (session) and Send. Stop's slot keeps its width when no turn is open (`visibility: hidden`), so a turn edge never re-wraps the toolbar; below a ~24rem container Stop shows only its icon (aria-label kept). The frame's height is constant across turn edges at 390 and 1440, at 100% and 200% text (test).
- Send is always the primary variant with its "Send" label: disabled-shaped when empty (decision 21: plate, rule border, muted text), graphite **at once** when there is text (a keyboard action, so no transition).
- Props: `draftKey`; `onSubmit(text, { urgent, clientMessageId, attachments }) → Promise`; `turnOpen`, `compacting`, `onStop` (session only); `completions` (`/`, `@` sources); `preview` (comments); `attachments` (session only).
- The keydown order is §6.2's, shared, with command mode added (§13.3).
- Where attachments aren't supported (task comments, inbox), there is no attach button, and a pasted or dropped file is ignored with the inline note "Files can be sent in an agent's session" (Q38).

### 13.2 Drafts, recall, optimistic send (Q22, Q29)

- **Drafts:** `localStorage` `of-draft:agent:<slug>` / `of-draft:task:<key>`, stored as `{ text, at }`, dropped after 7 days, try/catch as today. A tab writes only while its textarea is focused; an unfocused tab adopts a changed stored draft from `storage` events only if its own text equals the value previously stored (so it never wipes what it typed itself). The draft clears only what the server accepted (only what was sent, as today). A terminated agent's draft stays copyable ("Copy unsent message").
- **Recall:** ↑ in an empty composer with the caret at 0 fills the box with your newest `message_in` envelope in the loaded timeline (the server's record, Q22b), confirmed attachments restored as chips rather than raw lines; nothing when none is loaded. Always a new send.
- **Optimistic send** (Q29): Enter clears the box and adds, in the queue area, a block in the **delivered card's shape** with the body muted, its chips, and the accessible name "Sending" (no dashed edge, no entrance motion, no row menu, no timestamp). Only if the POST is still pending after 400ms does "Sending…" with a spinner appear where the time goes; an ⌥Enter send says "Sending · will interrupt the turn". The block lives in the session reducer, keyed by a client-generated `clientMessageId` (uuid).
  - The POST carries it; the server dedupes on (sender, `clientMessageId`) for 10 minutes in a `client_message_id` column with a unique partial index (sender, id) on the messages table (a PR1 migration; rows older than 10 minutes are ignored by the lookup), returning the original 202; the queue item and the `message_in` envelope's UI fields echo it (it is never rendered into the text the model sees).
  - Whichever arrives first (the 202's queue item or the delivered `message_in`) replaces the block in one reducer step (`handedOff`, §8.3). A queue item younger than 300ms doesn't show "Not delivered yet".
  - After 15s the POST aborts: the block is removed, the text returns to the box (appended to anything typed since) with "Couldn't confirm the send. Retry sends it once." While the box still holds that text unchanged, Enter and Retry both reuse the same id (so a late-landing original can never be sent twice); when a `message_in` echoing it arrives, the box (if unchanged) clears and the error goes. Other failures: block removed, text back, the inline error. Never a ghost block.

### 13.3 `/` commands (Q36, Q39)

**List.**
- At process start the driver sends `control_request{subtype: "initialize"}` (answered at once, no turn, no cost; spike §2). `ClaudeProcess` keeps a request-id map, intercepts the matching `control_response` (today dropped at `mapper.ts:461`, which interrupt responses share) and resolves a promise; a timeout (5s) or error resolves to no list and never blocks the first send. Inbound `control_request` lines from Claude are answered with an error response. The result goes to the runtime directly (`HarnessProcess.commands?(): Promise<Command[] | undefined>`), never into the event log. `system/commands_changed`, if it ever fires (the spike says it didn't), is handled the same way. `init.terminal_slash_commands` are dropped. Re-sending `initialize` later in a process is unverified, so the list refreshes at each process start only.
- The runtime stores the list in a separate `agent_commands` table (agent id, JSON, Claude Code version, `at`), never selected into `AgentSummary`. `GET /api/agents/:slug/commands` returns `{ commands, source: "session" | "template", at, stale }`. Before the first start: the template's skills, `source: "template"`, labelled "From template" (Q36 condition 4). When the template's skills changed after `at`, `stale: true` and the menu says "Commands as of {time}; updates when the agent next starts".
- **Allowed** (the server enforces it; the menu shows the same set): non-builtin entries (project, plugin and personal skills) plus the built-in allowlist, after canonicalizing aliases (`cost`, `stats` → `usage`; `review` → `code-review`; `new`, `reset` → `clear`). Built-in allowlist: `compact` → the server's Compact flow; `clear` → the New session confirmation, then the server's reset flow; `context`, `usage` → raw, rendered as `command_output`; `code-review`, `security-review`, `init` → raw. Every other built-in is refused (422 `unknown_command`): model, effort, config, color, fast, rename, mcp, agents, doctor, heapdump, reload-*, ultrareview, schedule, batch and any `builtin: true` bundled workflow; the template owns them, they are terminal-only, or they start costly work outside the factory's view.
- Groups: Skills (source from the description tag of non-builtin entries, stripped from the shown description: project / plugin / personal / workflow), Commands (the allowlist), Factory.

**Dispatch.**
- `POST /api/agents/:slug/commands { name, args, clientMessageId }`, humans only (a session user; agents have no route to it, and an agent's `send_message` text is never treated as a command). The server canonicalizes and validates `name` against the allowed set (else 422 `unknown_command`, shown inline, never a silent text send); `"/" + name + " " + args` must fit `MAX_BODY_BYTES` (else 413 with the inline error); `/compact <args>` maps to compact's focus (`MAX_FOCUS_CHARS`). The raw content is built as one string, args as data, never concatenated into anything parsed again, and never batched with envelopes.
- Held until no turn is open, as compact is (queue item kind `command`, "`/code-review` waits for the turn to end", args on one truncated line with `title`). Written through a new `HarnessProcess.command(text)` (today `control()` takes only compact, clear and interrupt), with a new wake reason `command`. A `commandInFlight` flag, set on write and cleared on that turn's `turn_end` (like `compactInFlight`), keeps `flush()` from writing the next message behind it, so one send gets one result.
- Your own held command shows Cancel (no Undo), sender-only, enforced by the route (`DELETE /api/agents/:slug/queue/:id` handles both kinds; Q39).
- Recorded as `control{cmd: "command", arg: "/name args", by}` (the `control` cmd enum gains `command`), rendered like your message with the command in mono, the sender suffix "ran a command", and the body clamp of §7.6.
- Local output: a `result` with `local_command` ∈ {context, usage, cost, stats} and `result.result` text maps to a new `command_output{command, text}` event (the `<synthetic>` assistant line stays dropped). `/context` renders as markdown (its tables scroll in `.md-table`); `/usage` and `/cost` as a code plate. Both with Copy.

**Menu UX.**
- Opens when the text is a single token `/` + non-space characters on one line, typed (a paste never opens it). A space, newline or paste closes it. `//` at the start sends text beginning with one `/`, with the hint "Sends as text; the agent may still run a skill by that name".
- Caret-anchored, opening upward, the same popover as `@` (§13.4), max 8 rows, `max-width: min(28rem, 100vw - 2rem)`, no animation, combobox semantics.
- Rows: `/name` in mono, middle-truncated keeping the part after `:` (the plugin prefix muted); the `argumentHint` muted (hidden below 24rem); a one-line description. Aliases match and show "alias: cost" on the canonical row. Name matches rank above all description matches.
- Enter accepts only a row highlighted by a name-prefix or exact match; otherwise Enter sends the text as typed. Tab (Q43) or Enter on such a row completes to `/name `, entering command mode: a "Command" chip at the left, the argument hint as placeholder; typing an exact allowed name followed by a space also enters command mode. Enter then dispatches; ⌥Enter acts as Enter in command mode.
- **Esc order** in the composer becomes: menu, then command mode, then an open peek, then stop the turn (§6.2).
- A typed `/foo` that matches nothing sends as text, with the hint "Not a command for this agent; sends as text" (Q36). Refused built-ins (`/model`) behave the same.
- Empty state: "No commands loaded yet. They appear after the agent starts." (or the template list with "From template").

### 13.4 `@` completion (Q23)

- Built on `cmdk` (approved, decision 8) in a Radix popover anchored to a zero-size element at the caret, opening upward; opened by typing `@` anywhere or by the toolbar button; no animation; max 8 rows; `max-width: min(28rem, 100vw - 2rem)` with collision padding; `aria-activedescendant` combobox semantics; ↑/↓ move, Tab/Enter accept (Q43), Esc closes and leaves the text.
- Rows: avatar 16, display name (wrapping, `dir="auto"`), muted middle-truncated `@slug`; humans by name and handle; `@humans`. Ranking: your reports and recent senders first, then alphabetical; live agents only.
- Task comments insert `@slug ` (routing as today). The session composer inserts plain text; session UI copy never says "mention" (Q23).

### 13.5 Attachments (Q37, Q38, Q42, Q43, D4)

Session composer only in v1 (Q38).

- **Composer.** Paste, drop (onto the composer frame; the window prevents the browser's default on file `dragover`/`drop`, so a missed drop never navigates away) or pick files. When the clipboard has non-empty `text/plain`, a paste inserts the text and ignores image items (spreadsheet and word-processor pastes carry a PNG of the cells); files are attached only when they are the only items. Each file becomes a chip: name middle-truncated (`dir="auto"`, Cf characters stripped for display), `max-w-[12rem]`, a 64px thumbnail for images rendered with `createImageBitmap(file, { resizeWidth: 64 })` (never a full-size `<img>`), an icon otherwise. While uploading: a determinate 2px bar along the chip's bottom edge and a tabular percentage, updated without transition (Q43), with Cancel; on failure an error state with the reason ("HEIC isn't supported; export as JPEG") and Retry or Remove. The chip area is at most 2 rows, then "+N files" expands in place. Up to 10 per message. Send stays disabled while an upload is pending or failed, with the reason in its tooltip ("Waiting for 2 uploads", "Remove or retry the failed file"). The drop target shows its `field-edge` in ink while a file is over it, with no animation (Q43).
- **Upload state** lives in a per-agent store outside the composer, so navigating away and back keeps in-flight uploads; leaving the app with uploads in flight asks the browser's `beforeunload`.
- **Upload route** (D4: no multipart dependency). `POST /api/agents/:slug/uploads` with the raw file as `application/octet-stream`, the original name percent-encoded in `X-Upload-Name`, a per-route `bodyLimit` of 20 MiB, streamed to a temp file in the uploads directory, sniffed, then renamed. The client uses XHR for upload progress; a non-JSON 413 (a proxy's limit) reads "The server refused a file this large (check the proxy's upload limit)." Same access check as sending that agent a message.
- **Names and paths.** The stored name is `<yyyymmdd>-<id>-<safe>`, where `safe` keeps only `[A-Za-z0-9._-]` (every other character becomes `-`), keeps the extension, NFC first, capped at 80 bytes; the original name is kept only in the upload row (for the chip). The workdir is resolved with `realpath`; the server creates `.factory/uploads/` with the existing `SafeFs`, `lstat`s every component and refuses any symlink, and opens files with `O_CREAT | O_EXCL | O_NOFOLLOW` (an agent can't redirect the write by planting a link). Tests: `]`, U+202E, an NFD `é`, a 200-character name, `..`, and a symlinked `.factory` and `.factory/uploads`.
- **Types.** Sniffed from the content: png, jpeg, gif, webp (magic bytes), and UTF-8 text for txt, md, json, csv, log and source code. The extension and client MIME type are not trusted; SVG, HTML, HEIC and anything else get 415 with a reason. Image dimensions are read from the header only (PNG IHDR, JPEG SOF, GIF, WebP), never decoded; over 8000px a side or 50 MP → 422 "Image is too large (max 8000 px a side)."
- **Response:** `{ uploadId, kind, bytes, width?, height?, name }`; the upload row records agent, uploader, stored path, kind, bytes, sha256 and `message_id` (null until sent).
- **Send.** `POST /api/agents/:slug/messages` gains `attachments: uploadId[]` (≤10). The server checks each belongs to this agent and this sender and is unused, appends one `[attached: .factory/uploads/<stored>]` line per file to the body itself (the 64 KB body limit counts them), and sets `message_id`. The agent reads the file with `Read` (verified in the spike under `acceptEdits`; under `auto` and in Docker it is a PR5 manual check, and the file must be readable by the container's uid). Nothing from the file enters the event log or tool meta beyond the path (an image `Read`'s base64 is never stored, §9.1).
- **Display.** The `message_in` envelope's UI fields carry the message's `attachments: { uploadId, name, kind, width?, height? }[]`; `MessageBlock` renders those as chips and hides the matching `[attached: …]` lines. A typed or agent-written `[attached: …]` line without a confirmed upload stays plain text. Image chips preview through `GET /api/agents/:slug/uploads/:id` (authenticated, same access check; opened with `O_NOFOLLOW`, refused unless a regular file whose size and sha256 match the row; `X-Content-Type-Options: nosniff`, the sniffed `Content-Type`; non-images as `Content-Disposition: attachment`).
- **Housekeeping** (Q42). Removing a chip or cancelling mid-upload deletes the file at once (`DELETE /api/agents/:slug/uploads/:id`, uploader only, unsent only); an aborted request deletes its temp file; uploads never attached to a sent message are deleted after 24 hours; sent uploads live and die with the workspace. On the first upload, `.factory/` is appended to the repository's `info/exclude` (the common git dir, so worktrees share it), idempotently and append-only, never touching a tracked `.gitignore`. Uploading to an agent that terminates mid-upload fails with the inline error and deletes the partial file.
- **Rejected:** base64 image blocks over stdin (spike: they work, but they turn the envelope into a content array, interact with batching and merging, and put images in the session transcript and log).
- **Deferred:** PDFs and other types (untested in the spike) and task-comment attachments, follow-up issues.

## 14. Header (PR1)

The header loses Stop (§6.1). It keeps the status badge and U2's one live fact; the activity line stays in the timeline only (one surface).

## 15. Server changes

| PR | Change |
|---|---|
| 1 | `interrupt()` takes the hold, `waitReason: "stopping"`, `publishQueue()` on hold edges, factory event `interrupt_unconfirmed` (§6.3); `turnStartedAt` and `compacting` on `AgentSummary` and the `agent_status` frame (§5.2, §6.1); `interrupt()` → 409 `compacting` during a compaction (D5); cancel/restore routes, runtime methods, the `messages_state_check` migration and the `cancelled` state in shared enums (§6.4); `clientMessageId` on `POST /messages`: a `client_message_id` column with a unique partial index (sender, id), 10-minute dedupe, echoed on the queue item and the envelope's UI fields (§13.2) |
| 3 | `tool_result.meta` in the mapper and `packages/shared` (§9.1); fixtures for Grep, Glob, MultiEdit, WebFetch |
| 4 | `--include-partial-messages`, `mapLine` returning `{events, live}`, `LiveEvent`, `HarnessProcess.live`, runtime `LiveState` with `retiredKeys` and its loop, the 64 KiB live cap, `live` frame and `live_snapshot` client message, `messageId`/`blockIndex` on persisted events (§11); `task_progress` and `thinking_tokens` mapped; `background_task_finished.usage`; Agent meta incl. `async` (§12) |
| 5 | `initialize` at process start with a request-id map for `control_response` and `HarnessProcess.commands()`; the `agent_commands` table; `GET`/`POST /api/agents/:slug/commands` with server-side allowlist and alias canonicalization; `HarnessProcess.command(text)`, wake reason `command`, `commandInFlight`; `control{cmd:"command"}`, `command_output`, the `command` queue item and its Cancel (§13.3); uploads: raw-body route with a 20 MiB `bodyLimit`, the `uploads` table, `attachments` on `POST /messages`, `GET`/`DELETE`, the 24h orphan sweep, `info/exclude` (§13.5) |

## 16. DESIGN.md amendments

1. **Components → Composers** (PR1, PR5): "The composer is one plate with the textarea and a toolbar inside its frame; it grows to 12 lines or 40% of the viewport, whichever is less. Send is a labelled primary, disabled-shaped while empty. While a turn is open, Stop sits left of Send: an outline button, the one toolbar control that acts on the running turn. Esc in the composer closes an open menu, then leaves command mode, then closes an open peek, and only then stops the turn (never during a compaction, when Stop reads "Compacting…"). ⌥/Alt+Enter sends and interrupts the turn; ⌘/Ctrl+Enter also sends normally. Keys typed during IME composition never send, stop or complete. The composer's height never changes when a turn opens or closes."
2. **Typography** (PR2): Hierarchy: reading prose 15/24 for speech, task bodies and comments; markdown h1/h2/h3 20/17/15, demoted 17/16/15; in the session timeline every speaker's markdown uses the demoted scale; tool output markdown 13/20. Replaces "Reading prose stays 14/22 for now…". Named Rules → Tracking scales with size: "−0.015em at 20px and above and −0.01em at 15–17px apply to Archivo headings; Geist body and UI text stays at 0 at every size."
3. **Motion → Frequency decides** (PR1): "Rows appended to the session timeline by a live frame fade in with opacity only (150ms `--ease-out`). Never on load, Load earlier, resync or a reconnect's catch-up, never with movement or stagger. A row that replaces one already on screen (a queued or sending message becoming the delivered one, live text becoming the saved message, a tool call joining a folded run, the activity line becoming the turn footer) doesn't fade. Other live lists stay instant." And: "A running turn shows a ticking duration; waiting lines and holds keep fixed times." And: "Status labels change instantly, except a change to the fallback ('Working'), which holds the previous label for 400ms waiting for a more specific one; never past the end of the turn." And: "Live text fades in once per block; becoming the saved message keeps its element, highlighting and height. Text restored by a reload or reconnect appears without a fade."
4. **Motion → Deliberately not used** (PR2): blur crossfades are allowed for copy feedback (150ms, blur ≤1px), the first component that needs one.
5. **Colors → Semantic** (PR3): `--diff-add` and `--diff-remove`, low tints of success and crimson on the plate, per theme; the +/− sign is always shown; diff code keeps ink colour and is not syntax-coloured.
6. **Components → Session timeline** (new, PR2–PR4): the three tiers and their spacing; the card rule ("an envelope that crossed a session boundary is a card"); speaker lines; the deep-link arrival (the row takes focus; a 6% tint on the row's own box fades over 300ms after 2s of visible time); folded tool runs; subagent cards as a header row with a neutral rule guide, no fill or box, and parallel subagents beyond three collapsing into a "+N more" row below the cards (never folding cards already on screen); live counters update at most twice a second and sit before variable text; the one row menu; state chips carry one word, detail goes on the line below; tool output tails clamp by lines and characters; streamed text with no caret; no markdown image loads automatically in the timeline or inbox.
7. **Components → Completion menus** (PR5): keyboard-opened, so no animation; anchored at the caret, opening upward. Combobox: "In a composer's caret menu, Tab also commits" (Q43).
10. **Components → Attachments** (PR5, Q43): "A transfer longer than a moment shows determinate progress: a 2px bar along the chip's bottom edge and a tabular percentage, updated without transition. A drop target shows its edge in ink while a file is over it, with no animation."
8. **Layout** (PR3): "Data rows are at least 32px; their text wraps rather than clipping at large text sizes."
9. **Components → Markdown** (PR3): "…mermaid diagrams always on a light plate, in trusted content; in tool results a mermaid fence shows as code."

## 17. Behavior-doc edits (gitignored `docs/product/`; applied in the main checkout by the dev in the PR named, listed in its description)

- `behavior/agents-and-sessions.md` (PR1): Stop and Esc in the composer, ⌥Enter urgent, header without Stop (narrowing decision 5); held-message Cancel and Undo; the activity line ticks, waiting lines don't. (PR4) live streaming defined as ephemeral and never stored. (PR5) `/` commands replace "the composer never interprets slash commands"; attachments.
- `architecture/harness-driver.md` (PR3, PR4, PR5): `tool_result.meta`; `LiveEvent` and `mapLine`'s `{events, live}`; mapping of `stream_event`, `task_progress`, `thinking_tokens`; `initialize` and the `control_response` map; `command(text)`; `command_output`.
- `architecture/agent-runtime.md` (PR1): a plain interrupt takes the urgent hold.
- `architecture/data-model.md` (PR1, PR5): the `cancelled` message state; `client_message_id`; the `agent_commands` table; the `uploads` table.
- `architecture/workspace.md` (PR5): `.factory/uploads/`, the orphan sweep and the `info/exclude` entry.
- `ui-review/decisions.md`: a note under decision 5 pointing at Q2.

## 18. Testing

- Unit: `deriveActivity` priority incl. several subagents; `buildRows` open turn, footer (command turns, cron wording), head flags; `groupWork` (runs, splits, denial excluded, first-child key, expand carry-over, partial labels, one-commit settle); `mergeFailures` (key, seqs, date); `splitBlocks` and `plainLength`; the stream tail parser (fences, inline markers, links, tables, long paragraphs); the reducer's `handedOff`, `retired`, `liveAfter`, cancel overlay and optimistic blocks; `isUrgentSendKey`; the IME guard; `formatDuration`; mapper meta per tool from fixtures and meta bounding; `LiveEvent` mapping from the spike traces.
- Component: Stop and Esc (menu-open, peek-open, IME, no-turn cases); composer height constant across turn edges; Cancel/Undo incl. text back into the box; Jump pill labels, cap and windowed navigation; stick-to-bottom intents (2,000px growth, 40px wheel-up, scrollbar-style scroll, selection, composer typing, expand anchoring within 1px); deep-link focus, tint timer paused while hidden; row menu items per kind; renderers per tool incl. no-meta fallback, `partial`, binary output, image Read; images rendered as links; fence-close highlighting; live handoff height equality.
- Render counts (`timeline-perf.test.tsx`): acceptance 22.
- Server: interrupt hold (second interrupt, publish edges, fallback event, 409 during compaction); cancel/restore incl. 403, 409s, ordering after later writes, audit log; `clientMessageId` dedupe; command validation (allowlist, refused built-ins, aliases, size), the raw line's exact bytes, `commandInFlight`, held-command Cancel; `initialize` timeout never blocking a send; the live loop's `retiredKeys` guard and 64 KiB cap; uploads (name sanitizing, symlinked `.factory` and `.factory/uploads`, `..`, sniffing, SVG/HTML/HEIC refusal, header-only dimensions and the 8000px cap, nosniff headers, size/sha256 check on GET, access, orphan sweep, `info/exclude` idempotence and worktrees).
- Fixture replay: the spike streams through mapper → runtime → reducer (acceptance 18).

## 19. Follow-up issues (opened with the decisions issue)

1. Timeline virtualization (break L7): measure after PR4 on the 2,400-event dataset; numbers in the issue.
2. Find in session (chat L4).
3. `T-` task completion in composers (Q23).
4. Mobile composer layout and row long-press → U4 (Q25).
5. Attachments: PDFs and other file types, untested in the spike (Q37).
6. Attachments in task comments and inbox replies (Q38).

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

Proxy answers Q1–Q44 and tech-lead decisions D1–D5 are logged in the decisions issue. D1: a plain interrupt takes the urgent hold, so Stop-then-Send can't be absorbed by the aborting turn (§6.3). D2: only `kind = 'message'` rows are cancellable, and a cancel never withdraws a wake under way (§6.4). D3: the announcer counts unmerged failures (§7.6). D4: uploads are a raw request body with the name in a header and a per-route 20 MiB limit, so no multipart dependency (§13.5). D5: Stop is disabled with "Compacting…" while a compaction runs (§6.1).

Rated 3/5 or lower, for Or:

- **Q2** (3/5): Stop only in the composer; narrows decision 5's "header keeps … plus Stop".
- **Q4** (3/5): ⌥Enter for urgent and no split-Send menu.
- **Q7** (3/5): speech prose 15/24.
- **Q8** (3/5): deep-link arrival as real focus plus a fading tint (timing settled in Q28, 4/5).
- **Q10, cost part** (3/5): estimated cost on every turn footer.
- **Q22b** (3/5): ↑ recall from the loaded timeline.
- **Q31, text back into the box** (3/5): Cancel with an empty box moves the text into it.
- **Q44** (3/5): keep the 64 KiB cap on agent text and show "Cut at 64 KB; the full text stayed with the agent." rather than raising the cap.
- **Q27** (4/5, a DESIGN.md exception worth seeing): the composer's Stop is an outline button inside a toolbar, where decision 20 would make it ghost.

## 22. Risks

- **Streaming cost on long sessions.** Mitigated by stable row identity, a memoized live tail and one commit per frame; measured in PR4 (acceptance 24) before deciding on virtualization.
- **Stop hold delays a steer by up to 10 seconds** if Claude never answers the interrupt; the fallback line makes it visible.
- **`initialize` once per process:** a skill added mid-process appears only after the next start (unverified whether `initialize` can be re-sent).
- **Prose at 15/24 lengthens sessions**; folding tool runs gives the height back (Q7).
- **Fixture gaps:** Grep, Glob, MultiEdit and WebFetch results have no fixture yet; PR3 records them, and renderers fall back without meta.
- **Uploads under `auto` and in Docker are unverified** (the spike ran `acceptEdits` locally); PR5 checks `Read` of an upload manually in both, and that the container's uid can read the file.
