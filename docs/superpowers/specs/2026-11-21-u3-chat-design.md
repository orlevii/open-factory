# U3 Chat: Technical Design

- **Date:** 2026-11-21
- **Status:** Draft. Owner-proxy (owner-u3) answered Q1–Q25; streaming, `/` commands and attachments (§11, §13.3–§13.5) wait for spike-u3's findings. Low certainty and deviations for Or: §21.
- **Source of truth (gitignored, read from the main checkout):** `docs/product/ui-review/decisions.md` (decisions 1–21; 7, 13 and 16–21 binding here), `docs/product/ui-review/status.md` (U3 table rows 1–12, file:line at `322075d`), `docs/product/ui-review/pr76-review.md` (the U3 items decision 15 hands over), the seven reviews in `docs/product/ui-review/` (chat.md is the main source), `docs/product/behavior/*.md`, `docs/product/architecture/harness-driver.md`, and, once written, `docs/product/architecture/claude-streaming-and-commands.md` (spike-u3).
- **Builds on:** U1 (PRs #84–#88, decisions #77): the control system, `data-instant`, memoized timeline rows (`stabilizeRows`, `TimelineItem` + `itemPropsEqual`, memoized `Markdown`, rAF-batched frames), the send-key rule. U2 (PRs #95, #97–#101, decisions #89, leftovers #102): `AgentChip`, `AgentAvatar`, the one-line header and `LiveLine`, Agent details, the shortcut layer, `requestComposerFocus`.
- **Followed by:** U4 (create flows and mobile). U4 owns the mobile composer layout and long-press on rows (Q25).
- **Decision log:** GitHub issue "U3: Chat — decisions"; Q1–Q25 are the proxy's answers, D1–Dn tech-lead decisions.

> `docs/product/` is gitignored. Paths into it are relative to the main checkout. Other paths are relative to the repo root; web paths are relative to `apps/web/src/` unless they start with `apps/` or `packages/`.

## 1. Goal

Make watching an agent feel like watching it work, and talking to it feel like one conversation:

1. Say what the agent is doing right now, how long it has worked, and when and how a turn ended (activity line, turn footer).
2. Put the turn's controls where the turn is: Stop, Esc and urgency in the composer.
3. Show who is speaking, and let speech outrank machinery (speaker lines, three tiers, 15/24 prose).
4. Show the work as the work: per-tool renderers with diffs, folded tool runs, background tasks on their call, subagent cards.
5. Stream the agent's text as it is written (decision 7, no caret per decision 13).
6. One composer for sessions, task comments and the inbox pane, with `/` commands, `@` completion and attachments.

## 2. Acceptance criteria

All run in default CI (`pnpm test`, `pnpm typecheck`, `pnpm lint`) unless marked manual.

1. **Activity line.** While a turn is open the timeline footer shows the tooth, a label from §5.1's priority list and a ticking elapsed duration ("· 1m 12s") from the open turn's `turn_started`; a fake-timer test shows only `Elapsed` re-renders per second (render count on `TimelineItem` unchanged). With no turn open the line is absent. The same `deriveActivity` feeds the line in PR1 (rows only) and PR4 (rows + live state), with unchanged call sites (§5.1).
2. **Turn footer.** After a non-error `turn_end`, one quiet line: "Worked 2m 13s · 14 tool calls · $0.42 est."; zero parts omitted; cost only ≥ $0.01; values from that turn's `usage` event; a self-started turn reads "Woke for a background task · 12 s".
3. **Stop.** While `turnOpen`, a ghost "Stop" (CircleStop + label) sits left of Send in the composer, and the header has no Stop. Clicking it, or Esc with focus in the composer and no completion menu open, sends one interrupt; it shows "Stopping…" until the turn closes. Esc with a menu open only closes the menu. With no turn open Esc does nothing to the agent.
4. **Urgent.** ⌥Enter (Alt+Enter) sends with `urgent: true`; ⌘/Ctrl+Enter and Enter send normally (U1 rule); the Urgent checkbox is gone. The hint "Arrives at the agent's next step. ⌥↵ to interrupt instead." shows only while a turn is open (Alt+↵ off macOS).
5. **Stop hold (D1).** Server test: after `interrupt()`, a message posted before the interrupted turn's `result` is not written until it lands (or the 10 s fallback); its queue item carries `waitReason: "stopping"` and renders "Not delivered yet: stopping the turn"; a fired fallback appends `interrupt_unconfirmed` and renders a quiet line.
6. **Cancel.** A held human message you sent shows Cancel; Cancel removes it at once with an inline Undo; Undo restores it in its original position while it is still unwritten; once written, Undo is gone and `restore` answers 409 (server test).
7. **Jump to latest.** One pill, bottom-centre: "3 new messages" (speech only), "New output" when only non-speech arrived, never "· 0"; windowed views navigate, others scroll; End in the log does the same. The windowed button and "N new events" are gone.
8. **Stick-to-bottom.** A block that grows by 2,000px between two scroll events while pinned stays pinned (the bug test); a wheel-up, touch drag up, PageUp/Home/↑ with focus in the log, or a text selection inside the log unpins; typing in the composer never unpins; scrolling back within 64px or Jump re-pins.
9. **Live rows.** Rows appended by a live frame carry `data-live` and fade in (opacity, 150ms); rows from load, Load earlier, resync and windowed views do not; a delivered message that replaces its queued block does not, and both changes land in one commit (reducer test).
10. **Speaker lines and tiers.** Incoming and outgoing envelopes are cards with a speaker line (avatar 20 for agents, display name, muted `@handle`, time); your own messages say "You"; factory notices are quiet lines with the factory mark; agent text has a speaker line on the turn's first text block and again after an incoming message splits the turn. Speech prose is 15/24; work and system text 13–14 (§7.3).
11. **Deep link.** `?event=` scrolls the row into view, focuses it (`preventScroll`), shows the inset focus ring and a 6% signal tint that fades after 2 s (no fade under reduced motion); the tint never covers the gutter. A link into a folded group or merged failure lands on that row, expanding the group.
12. **Row menu.** One ⋯ per row (hover/focus; always on touch) with only the actions that apply: Copy link, Copy text, Copy command, View tool call, Open in inbox, and on touch the row's time. Outgoing cards have no footer links. Code blocks have a Copy button.
13. **Failures and clamps.** Adjacent errors with the same kind/code and message render as one row "3 times · last 19:32" (exact); held messages repeat the reason only on the first. A 4,000-character single-line body clamps with "Show all", which expands in place without moving the content above.
14. **Tool runs.** ≥2 consecutive foldable tool rows form a collapsed group, "Worked 1m 40s · read 6 files, ran 4 commands"; while live, "Running pnpm test · 4 calls so far"; at turn end the final summary lands in one commit. Failed, denied, factory, subagent and error rows are never inside a group. User toggles stick.
15. **Renderers.** Each tool in §9.2 renders its collapsed and expanded form from `tool_result.meta`; a result with no meta (old rows) falls back to today's row; truncated meta says "Diff truncated · show raw output"; outside content renders without raw HTML and without loading remote images.
16. **Fence-close highlighting.** A code block highlights only when its fence is closed: always for persisted rows; for the streaming tail only after the closing fence arrives (test: a streamed fence renders `<pre>` until closed, then highlights once).
17. **Streaming** (PR4; final shape after the spike): text appears as it is generated, committed at most once per frame, no caret; reload mid-answer shows the text so far; the persisted `assistant_text` replaces the live block in one commit; an interrupt mid-text leaves no lingering live block.
18. **Subagent cards** (PR4): the Agent/Task call renders as a card with type, description, state chip, a live progress line (in the subscribe snapshot), body collapsed with the result last.
19. **Composer** (PR5): one `Composer` in `components/composer/` used by the session, task comments and the inbox pane; `CommentComposerHandle` (`reply`, `prefill`) unchanged; Send is a primary that is disabled-shaped when empty; drafts in `localStorage` with a 7-day expiry; ↑ in an empty box recalls your last message from the loaded timeline; optimistic "Sending…" block.
20. **`/` and `@`** (PR5; dispatch after the spike): `/` as the first character opens the agent's commands; `@` anywhere opens agents and humans; keyboard-opened, no animation; combobox semantics.
21. **Manual, recorded in each PR:** before/after screenshots of a long session in light and dark (PR2, Q7); the 2,400-event dataset scrolled and streamed under 4× CPU throttling (PR4, numbers into the virtualization issue); a 40-call turn folded and expanded; an Edit diff in both themes (PR3, Q18); a reload mid-answer (PR4).

## 3. Scope

**In:** status.md U3 rows 1–12; decision 14's U3 item and #82 (reading prose size); pr76-review's U3 items (fence-close highlighting, the comment composer's `reply`/`prefill` handle, Enter vs ⌘Enter); D1's server hold.

**Out (follow-up issues, §19):** timeline virtualization (measure after PR4), find in session (chat L4), `T-` task completion in composers (Q23), the mobile composer layout and row long-press (U4).

## 4. U3 checklist

| # | Item (status.md U3 # / source) | Where | PR |
|---|---|---|---|
| 1 | Spikes (U3 #1) | spike-u3 → `claude-streaming-and-commands.md` | — |
| 2 | Activity line, elapsed, turn footer (U3 #2) | §5 | 1 |
| 3 | Stop in the composer, urgency, Esc, durable drafts, ↑ recall (U3 #3) | §6, §13 | 1, 5 |
| 4 | One Jump to latest (U3 #4) | §8.2 | 1 |
| 5 | Speaker identity, tiers, quiet deep-link highlight, card footers into a menu (U3 #5) | §7 | 2 |
| 6 | Per-tool renderers, diffs, folding, background tasks, repeated failures (U3 #6) | §9, §7.6 | 3, 2 |
| 7 | Token streaming (U3 #7) | §11 | 4 |
| 8 | Subagent cards (U3 #8) | §12 | 4 |
| 9 | `/` and `@` in one shared composer, optimistic send (U3 #9) | §13 | 5 |
| 10 | Attachments (U3 #10) | §13.5 | 5 |
| 11 | Live-row polish: fade, queued → delivered, clamp by length, copy, timestamps, copy-link feedback (U3 #11) | §8.3, §7.5, §7.6 | 1, 2 |
| 12 | Queued messages: Cancel (U3 #12; "Send now" dropped, Q5) | §6.4 | 1 |
| 13 | Reading prose size (#82, decision 14) | §7.3 | 2 |
| 14 | Code highlighted only when its fence closes (decision 7, pr76 "done differently" #1) | §10 | 3 |
| 15 | Comment composer's `reply`/`prefill` handle survives (pr76) | §13.1 | 5 |
| 16 | Enter vs ⌘Enter per U1's rule (pr76, decision 15) | §6.2 | 1 |

## 5. Activity line and turn footer (PR1)

### 5.1 One source of activity (Q1 condition, Q10)

`features/session/activity.ts`, pure:

```ts
export type Activity = {
  label: ReactNode;        // "Running `pnpm test`", "Reading `retry.ts`", "Subagent: Draft the request", "Thinking", "Writing a reply", "Working"
  startedAt: string;       // the open turn's turn_started `at`
};
export function deriveActivity(turn: OpenTurn | undefined, live: LiveState | undefined): Activity | undefined
```

- `OpenTurn` comes from `rows.ts`'s pass (`buildRows` also returns, stabilized like the rows, `openTurn: { startedAt, newestOpenTool?: ToolRow, toolCount }` when the newest `turn_started` has no `turn_end`, `exited` or later `turn_started`). Today `turn_started` is hidden; the pass reads it without rendering it.
- `live` is `undefined` in PR1; PR4 passes the live state (§11). The call site and the component do not change.
- Priority, first that applies: (1) live tool input ("Writing `src/app.ts`") — PR4; (2) the newest open tool row: Bash `description` else the command ("Running `pnpm test`"), Read/Edit/Write the file name ("Reading `retry.ts`", "Editing `retry.ts`"), Grep/Glob the pattern, Agent/Task "Subagent: <description>" (no counters: Q19 keeps them on the card), MCP "server · tool"; (3) thinking (PR4); (4) live text ("Writing a reply", PR4); (5) "Working". Paths middle-truncate (`MiddleTruncate`).

### 5.2 `ActivityLine` (`features/session/activity-line.tsx`)

- Replaces the static Working line in the timeline footer (`session-view.tsx:258-271`). Tooth (static, never pulses), the label, then `<Elapsed since={startedAt} />`.
- `Elapsed` is its own component with a 1s `setInterval` (cleared on unmount and while `document.hidden`), `tabular-nums`, "· 42s", "· 1m 12s", "· 1h 3m". It sits outside every live region, and nothing else re-renders per tick (acceptance 1).
- The distinction is written into the behavior doc (§17): a running turn shows a ticking **duration**; waiting lines and holds keep fixed times and never tick.
- When `agent.stuck` is set (`packages/shared/src/agents.ts:73`), the line keeps the label and adds the existing stuck wording after the duration.

### 5.3 Turn footer (Q10)

- `rows.ts` gains a `turn_footer` row kind, built from a non-error `turn_end` and that turn's `usage` event (the same event the usage service records into `turns`, so the footer and the Usage page show the same numbers; the web app computes no estimate of its own).
- Text: "Worked {formatDuration(usage.durationMs)}" + " · {n} tool calls" (n = tool calls in the turn, nested included; omitted when 0) + " · ${cost} est." (only when `costUsd ≥ 0.01`, two decimals). Self-started turns (`turn_end.originKind` set): "Woke for a background task · 12 s" (+ the same parts).
- A turn with no `usage` (an old row, an exit) shows no footer. Errored turn ends keep today's quiet line ("Turn interrupted", "Turn ended with an error").
- System tier: 13px muted quiet line, no row actions beyond Copy link.

## 6. Composer controls (PR1)

PR1 changes today's `features/session/composer.tsx` in place; PR5 moves it into the shared primitive (§13) without changing behaviour.

### 6.1 Stop (Q2, Q3)

- While `agent.turnOpen`: a ghost button, CircleStop + "Stop", left of Send. It reuses `InterruptButton`'s logic (moved to `features/session/stop-button.tsx`): one `postInterrupt`, "Stopping…" (`aria-disabled`) until `turnEpoch` changes, a 409 ignored, other failures in the composer's error line ("Couldn't stop: …").
- The header's Stop is removed (`SessionActions`, `session-view.tsx:503-506`). DESIGN.md and `agents-and-sessions.md` are amended (§16, §17): this narrows decision 5's "plus Stop" (Q2, flagged in §21).
- When Stop unmounts under focus (the turn closed), focus stays in the textarea.

### 6.2 Keys (Q3, Q4, U1 rule)

`lib/send-key.ts` gains `isUrgentSendKey(e)`: Enter with `altKey`, not composing, fine pointer only. In the textarea's `onKeyDown`, in order:

1. Esc: if a completion menu is open, close it (PR5); else if `turnOpen` and Stop is not pending, stop; `preventDefault` and `stopPropagation` in both cases so the shortcut layer never sees it. Otherwise Esc is not handled.
2. `isUrgentSendKey` → send with `urgent: true`.
3. `isSendKey` (unchanged: Enter, ⌘/Ctrl+Enter; Shift+Enter and touch Enter add a line) → send normally.

The Urgent checkbox, its hint and the "Send urgent" label swap go. The hint line under the box shows only while a turn is open: "Arrives at the agent's next step. ⌥↵ to interrupt instead." (`Alt+↵` off macOS, using the U2 `Kbd` rule for the platform glyph). Placeholder: "Message {name}" (PR5 adds " · / for commands", Q24).

### 6.3 Stop hold on the server (D1)

- `AgentRuntime.interrupt()` (`agent-runtime.ts:644`) takes the same hold `urgentInterrupt` takes (`:3149`): factored into `beginInterruptHold(by)`. While held, `flush()` writes nothing (as today for urgent); messages posted meanwhile stay queued.
- Queue items held by it carry `waitReason: "stopping"` (new enum value in `queueItemSchema`); `QueueItems` renders "Not delivered yet: stopping the turn".
- When the hold's 10 s fallback fires (urgent or plain), the runtime appends a new factory event `interrupt_unconfirmed{}`; the timeline renders it as a warning quiet line: "The turn didn't confirm the stop within 10 s, so held messages were sent anyway."
- Stop-then-Send now equals ⌥Enter, which is why Q4 needs no split menu.

### 6.4 Cancel a held message (Q5, D2)

- Server: `DELETE /api/agents/:slug/queue/:messageId` sets the message row's `state` to `"cancelled"` and drops it from the runtime queue, only if it is still unwritten and was sent by the caller (D2: your own messages; agents' and other humans' messages are not yours to retract); 409 `already_delivered` otherwise. `POST /api/agents/:slug/queue/:messageId/restore` sets it back to `"pending"` and re-inserts it by `createdAt` (its original position), 409 when it was written or the agent ended. Both publish the `queue` frame. Boot recovery skips `cancelled` rows.
- Client: a ghost "Cancel" on a queued message block you sent. On success the block is replaced in place by a one-line `InlineOutcome` "Message cancelled. Undo" (DESIGN.md: forgiveness over confirmation). Undo is offered only while the server would honour it: it disappears when the next `queue` frame or event shows the agent has started writing (a turn opened). No "Send now" (Q5).

### 6.5 Drafts, recall, optimistic send

Defined in §13.2; PR1 ships drafts in `localStorage` and the optimistic block for the session composer, PR5 moves both into the shared primitive.

## 7. Timeline tiers and speaker identity (PR2)

### 7.1 Tiers (Q6)

| Tier | Rows | Treatment |
|---|---|---|
| Speech | incoming messages, outgoing `send_message`, the agent's text | Speaker line; prose 15/24. **An envelope that crossed a session boundary is a card** (plate, 1px rule, radius 6); the agent's own text is unboxed. |
| Work | tool rows, tool groups, subagent cards, spawn/terminate blocks | 13px; tool names in mono only where they are identifiers |
| System | lifecycle quiet lines, turn footer, compaction marker | 13px muted; Copy link is the only row action |

### 7.2 Speaker line (`features/session/speaker-line.tsx`)

`[avatar 20] Name  @handle  14:02` — Geist 13/500 name, muted mono handle (middle-truncated), muted time.

- Agents: `AgentChip size={20} showSlug` (U2), linking to the agent's session except for the session's own agent.
- Humans: no avatar (humans have none), the user's name from the users list, else the handle; your own messages say "You" (from the session query's handle); never a second fill (Q6).
- Factory notices (`system`, `task_assigned`, `task_update` from `@factory`): no card; a quiet line with the factory mark and the task badge (Q6).
- Scheduler messages keep their sender ("Scheduler", schedule badge, "by …").
- Agent text: `rows.ts` marks a text row `head: true` when it is the first text of its turn, or the first text after a message row in the same turn (Q6 note 1). Head rows show the session agent's speaker line; others don't. Children of a subagent never get one.

### 7.3 Reading prose size (Q7, #82)

`styles.css`:
- `.prose-of` (speech, and task bodies and comments): 15/24 (`0.9375rem/1.5rem`), tracking 0 → −0.01em per DESIGN.md's tracking rule at 15px.
- Markdown headings, page: h1 20/28, h2 17/24, h3 15/24 at weight 650 (distinguished from body by weight). Detail-demoted (`.prose-of-detail`): h1 17, h2 16, h3 15, all 650.
- New `.prose-of-work` (tool results rendered as markdown, §9): 13/20, headings 14/13/13.
- Code stays Geist Mono 13/1.55.
- PR2 records before/after screenshots of a long session in light and dark; #82 is closed by PR2.

### 7.4 Deep-link highlight (Q8)

- The lit row's `[data-row]` element gets `tabIndex=-1` and `focus({ preventScroll: true })` after `scrollIntoView({ block: "center" })`. Its ring is DESIGN.md's inset row focus ring. Where `:focus-visible` doesn't match a programmatic focus after a mouse navigation, the row gets `data-focus-ring` until `blur`, styled identically ("ring = focus").
- The 6% signal tint goes on the row's own box (the card or the row, inside the gutter, never the `pr-8` wrap): `[data-arrived]` with `background: color-mix(in oklab, var(--signal) 6%, transparent)`; after 2 s it fades (opacity of a pseudo-element, 1.2 s `--ease-out`); reduced motion removes it on the first interaction instead.
- The existing "until the user clicks elsewhere" pointer listener (`timeline.tsx:146-154`) goes.

### 7.5 One row menu, copy, timestamps (Q14)

- `CopyLink` becomes `RowMenu` (`features/session/row-menu.tsx`): one ⋯ trigger, hover/focus-within on fine pointers, always visible on touch, inside the row's right padding so the row and composer share one right edge. Items, only those that apply: Copy link (all), Copy text (agent text, message bodies: the markdown source), Copy command (Bash), View tool call (outgoing, spawn), Open in inbox (outgoing to a human), and on touch the time ("Sent 14:02:11") as a disabled label item. Copy feedback: the trigger icon crossfades to a check (150ms, blur ≤2px, §16), "Couldn't copy" inline as today.
- Outgoing cards lose "Show tool call" / "Sent to the inbox" footers (`outgoing-message.tsx`).
- Code blocks (`CodeBlock` and the plain `pre`) get a Copy button, top-right, on hover/focus-within.
- Agent text and tool rows show their time in the right gutter on hover/focus; messages keep their visible time.

### 7.6 Repeated failures and clamps (Q15)

- A display pass after `buildRows` merges adjacent `error` rows with the same `source`, `code` and `message` into one row with `count` and `lastAt`: "Image `playwright` isn't built · 3 times · last 19:32". Stored rows are untouched. The merged row's `seqs` include every occurrence so `targetRowKey` lands on it.
- Queued messages: "Not delivered yet: <reason>" on the first held message block, "Not delivered yet" on the rest.
- `ClampedMarkdown` clamps at 40 lines or 4,000 rendered characters (counted on the source with markdown syntax stripped by a cheap regex pass, `plainLength()`), whichever comes first; "Show all" expands in place; the row above the button is the scroll anchor, so nothing above moves.

## 8. Scrolling and live rows (PR1)

### 8.1 Stick-to-bottom on intent (Q12)

`Timeline` keeps `pinned` (ref). Today's position test (`timeline.tsx:159`) stops deciding it.

- Unpin on: `wheel` with `deltaY < 0`; `touchmove` upward; `keydown` PageUp, Home, ↑ while focus is inside the log; `pointerdown` that starts a text selection in the log, and any non-collapsed selection inside the log on `selectionchange`.
- Re-pin on: a scroll that ends within 64px of the bottom; Jump; End in the log; sending a message from the composer.
- While pinned, the ResizeObserver and the rows layout effect set `scrollTop = scrollHeight` as today, so growth never unpins (the 2,000px test).
- Typing in the composer never unpins (its keys aren't in the log).

### 8.2 One Jump to latest (Q11)

- `JumpPill` (`features/session/jump-pill.tsx`), absolutely positioned bottom-centre over the timeline. Shown when unpinned and something arrived since (or windowed).
- Count: speech rows appended (message, outgoing, agent text rows; a live text block counts once) → "1 new message" / "3 new messages"; anything else only → "New output"; windowed → "Jump to latest" plus the speech count of `newWhileAway` events (the reducer counts speech for windowed frames too); never "· 0".
- Action: windowed → navigate to `/agents/$slug` (today's behaviour); else scroll to bottom instantly and re-pin. End in the log does the same.
- Motion: enters opacity 0 → 1 with `translateY(4px)` → 0, 150ms `--ease-out`, origin bottom centre; exits opacity, 100ms; instant when shown or hidden by a key (`data-instant`). Removes `timeline.tsx:310-324` and `session-view.tsx:278-289`.

### 8.3 Live-row fade and the queued → delivered handoff (Q13)

- `useSession` records `liveAfter`: the highest seq when the last `loaded` landed. A row whose `seq > liveAfter` arrived by a frame. `TimelineItem` gets `live: boolean` (compared in `itemPropsEqual`) and sets `data-live`.
- CSS: `[data-row-wrap][data-live] { transition: opacity 150ms var(--ease-out); @starting-style { opacity: 0 } }`. `@starting-style` applies on insertion only, so re-renders never replay it. Reduced motion keeps it (opacity only).
- Reducer: when a `message_in` event arrives whose envelope `id`/`ids` match queue items, those items are removed in the same reducer step and the ids go into `handedOff`; rows holding a handed-off id don't get `data-live`. One commit, no fade, no duplicate (motion M2).
- Not live: `loaded`, `earlier`, a resync reload, windowed views.

## 9. Tools (PR3)

### 9.1 `tool_result.meta` (Q16)

`packages/shared/src/tool-meta.ts`:

```ts
export const toolMetaSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("Edit"), type: z.enum(["create", "update"]), hunks: z.array(hunkSchema), partial: z.boolean().optional() }),
  // MultiEdit and Write use "Edit"'s shape under their own literal
  z.object({ tool: z.literal("Bash"), interrupted: z.boolean(), backgroundTaskId: z.string().optional(), stderr: z.string().optional() }),
  z.object({ tool: z.literal("Read"), startLine: z.number(), numLines: z.number(), totalLines: z.number() }),
  z.object({ tool: z.literal("Grep"), mode: z.string(), numFiles: z.number(), numLines: z.number().optional(), files: z.array(z.string()).optional() }),
  z.object({ tool: z.literal("Glob"), numFiles: z.number(), files: z.array(z.string()).optional() }),
  z.object({ tool: z.literal("WebFetch"), code: z.number().optional(), bytes: z.number().optional() }),
  z.object({ tool: z.literal("TodoWrite"), todos: z.array(z.object({ content: z.string(), status: z.string() })) }),
]);
// hunkSchema: { oldStart, oldLines, newStart, newLines, lines: string[] }  (structuredPatch)
```

- `tool_result` gains `meta: toolMetaSchema.optional()`; unknown tools carry none; old rows parse.
- The mapper (`mapper.ts:295-301`) builds it from `tool_use_result`, never copying `originalFile`. It bounds meta itself: hunks are added until 32 KiB serialized, then `partial: true`; `stderr` ≤16 KiB. capPayload still applies.
- Bash: the renderer shows `content` (what the model saw) as output; when `meta.stderr` is non-empty and `content` ends with it, that tail moves to its own stderr plate. Exit state: `isError` → "failed", `interrupted` → "interrupted", `backgroundTaskId` → "in background".
- The exact `tool_use_result` shapes per tool are taken from the fixtures (Edit's `structuredPatch` is in `factory-mcp-and-project-symlink-edits.jsonl`; Bash in `background-bash-start-finish.jsonl`); a mapper test per tool uses a fixture line, and any tool whose shape no fixture shows is left without meta.

### 9.2 Renderers (Q17)

`features/session/tools/` with one module per tool and a `toolRenderers: Record<string, ToolRenderer>` map; `ToolRenderer = { summary(row): ReactNode; body(row): ReactNode }`. Unknown names fall back to today's `ToolCallRow` body.

| Tool | Collapsed row | Expanded (result first; "Show input" only when it adds something) |
|---|---|---|
| Bash | `$ pnpm test` or its `description` (command mono below); chip failed / interrupted / in background | stdout tail, last 12 lines, "Show all N lines" in place; stderr plate with a muted crimson label |
| Edit / MultiEdit / Write | path · **+4 −2**, or "created · 120 lines" | unified diff from `hunks`, line-number gutter, +/− signs, Shiki by extension; `partial` → "Diff truncated · show raw output" |
| Read | `retry.ts` · lines 1–120 of 340 | nothing; "Show content" renders it with a real gutter (the `N→` prefixes stripped) |
| Grep / Glob | pattern in path · 6 files | file list (mono rows), content hits grouped by file |
| WebFetch / WebSearch | host + path · 200 · 14 KB | the prompt, then the result as outside-content markdown |
| TodoWrite | "Updated plan · 3/7 done" | checklist (read-only checkboxes, graphite) |
| `mcp__factory__*` task/schedule tools | quiet line with the `T-n` / `S-n` badge | the generic body |
| Other MCP | `server · tool` + first string argument | input as a key/value list; result as outside-content markdown when it looks like text |

- Failed calls show the first error line in the collapsed row ("Failed: ENOENT …").
- "Show all" expands in place with the row above as anchor (no nested scroller; the 24rem `CodePlate` cap stays only for the raw fallback).
- Highlighting by extension uses an extension → grammar map in `highlight.ts` with a plain fallback.

### 9.3 Outside content (Q17)

`Markdown` gains `untrusted?: boolean` (all tool results rendered as markdown): no raw HTML (already off), `img` renders as a link "Image: <alt or host>" so nothing loads from arbitrary hosts, and external links keep `rel="noopener noreferrer"`.

### 9.4 Folding tool runs (Q9)

- A display pass `groupWork(rows)` after `buildRows`: a run of ≥2 consecutive top-level `tool` rows whose state is `running`, `done` or `no_result` and which are not subagent calls becomes `{ kind: "work_group", key: "g:" + firstChild.key, children, live, summary }`. Any other row ends the run (failed, denied, factory blocks, subagent cards, errors, messages, text, quiet lines). A single call stays a plain tool row.
- Summary, counting only the group's own children: "Worked 1m 40s · read 6 files, ran 4 commands, edited 2 files, 3 other calls" (verbs per tool family; duration = last child's result `at` − first child's `at`). While the turn is open and the group is the newest: "Running `pnpm test` · 4 calls so far" — the label from §5.1's tool formatter. At turn end the final summary lands with the `turn_end` frame (one commit).
- Collapsed by default always; the user's toggle is kept in `expanded` by key and sticks. `targetRowKey` and `hasKey` look into groups; a deep link adds the group's key to `expanded`.
- The group header is a 32px row with the chevron (150ms rotation only when its chevron was clicked); children render inside without height animation.

### 9.5 Background tasks on their call (Q20)

`background_task_started{toolUseId}` attaches to its tool row (`backgroundTask: { taskId, state: "running" }`); `background_task_finished` with the same `taskId` updates it ("Finished · <summary>" or "Failed"). Neither renders its own line then. Unmatched ones (Monitor, after a resume) keep today's quiet lines. The header's U2 "waiting on" fact is unchanged.

## 10. Code highlighted only when its fence closes (decision 7, PR3)

- `Markdown`'s `pre` renderer passes `closed` to `CodeBlock`. For persisted rows every fence is closed. For the streaming tail (§11.4) the open fence renders `<pre><code>` plain until the closing fence arrives, then highlights once.
- `CodeBlock` keeps the previous highlight only when the language is unchanged (pr76 nit), else shows the new code as plain text until its grammar loads.
- `highlight.ts` nits from pr76: `console` → `shellsession`; the `.catch` attached once inside the `??=` branch; add `powershell`/`ps1`, `hcl`/`terraform`, `proto`, `dotenv` aliases where Shiki ships them.

## 11. Token streaming (PR4) — awaiting spike-u3

Binding: decision 7 (live over WS, not stored; the final message persisted as today; a reload mid-answer shows the text so far; highlighting when a fence closes; a live activity line) and decision 13 (no caret; at most one commit per frame). The shape below follows chat H1 and is finalized against `docs/product/architecture/claude-streaming-and-commands.md`.

### 11.1 Harness

- `--include-partial-messages` in `buildClaudeArgs`.
- The mapper maps `stream_event` lines to a separate, ephemeral `LiveEvent` type kept out of the `HarnessEvent` union: text block start/delta/stop, tool_use block start (tool name, id) and input byte counts, message stop; `system/thinking_tokens` and `system/task_progress` (subagents, §12) become live events too.
- `ClaudeProcess` exposes `live: AsyncIterable<LiveEvent>` beside `events`; `HarnessProcess.live` is optional so other drivers and fakes need nothing.
- Persisted `assistant_text` and `tool_call` gain optional `messageId` and `blockIndex`, the reconcile key.

### 11.2 Runtime

- The runtime drains `live` outside the serial job queue (no DB, no job): it keeps `LiveState` in memory (the current text block's id, index and text, at most one message; the current tool input; thinking tokens; subagent progress by tool use id), and publishes coalesced frames every 50 ms on the bus.
- It clears the text block when the persisted `assistant_text` with the same key is appended (same job that publishes it), and everything on `turn_end` and `exited`.

### 11.3 WebSocket

- Frame `live`: `{ type: "live", agent, text?: { messageId, index, offset, append }, activity?: {...}, subagents?: [...], reset?: true }`. `offset` is the block length before `append`; a client that sees a gap sends `{ type: "live_snapshot", agent }` and gets a `reset` frame.
- `subscribe()` sends `rt.liveSnapshot()` as a `reset` frame after the replay and buffer drain: a reload mid-answer shows the text so far (decision 7).

### 11.4 Client

- Live state lives in the session reducer beside `ordered`, so a persisted `assistant_text` that retires the live block lands in the same commit; `rows` are derived from events only, so a live frame never changes their identity (U1's stable references hold; perf test: a live frame re-renders no `TimelineItem`).
- `LiveText` renders as the last timeline row, above the footer: completed markdown blocks (split at the last blank line outside a fence) render once each through the memoized `Markdown`; only the tail re-renders, with an unclosed fence shown as plain code (§10). No caret, no fade per token (decision 13).
- The activity line reads live state through `deriveActivity` (§5.1).

## 12. Subagent cards (PR4)

- The Agent/Task tool call (names `Agent` and `Task`) renders as `SubagentCard` (`features/session/subagent-card.tsx`): a plate indented like a quote (no message-card border, no avatar, no link), header "Subagent · general-purpose · <description>" and a state chip (running / done / failed / in background). It says "in this session" in its accessible name, so it never reads as a factory spawn block.
- Running: one live line from `subagent_progress` (last tool, tool calls, tokens; never a ticking timer), carried in the subscribe snapshot (Q19 condition 1). After it ends, only the persisted footer: "12 tool calls · 41 s · 23k tokens" (from the tool result / `background_task_finished`).
- Body collapsed by default: the prompt as markdown, then the nested transcript in order (folded per §9.4), then the result last. When done, the result's first 3 lines show without expanding.
- Parallel subagents (several calls in one message) stack, with one "3 subagents running" line above them while any runs.
- The activity line names the subagent only (Q19 condition 2).

## 13. The shared composer (PR5; §13.3–§13.5 await spike-u3)

### 13.1 Primitive (Q21)

`components/composer/composer.tsx`, `Composer` — used by the session (`features/session/composer.tsx` becomes a thin wrapper), task comments (`CommentComposer` keeps its file, props and `CommentComposerHandle { reply, prefill }`), and the inbox reading pane's reply.

- Frame: one plate (`field-edge`, radius 6) containing the auto-growing textarea (2→12 lines, 2→6 below `md`) and a 32px toolbar inside the frame: left `/` (session) and `@` buttons opening the same menus as typing; Write/Preview toggle (comments); right Stop (session, while a turn is open) and Send.
- Send is always the primary variant: disabled-shaped when empty (decision 21: a plate with a rule border, muted arrow), graphite when there is text (150ms colour). Q21 dropped the ghost → primary morph.
- Props: `value/onChange` owned inside with a `draftKey`; `onSubmit(text, { urgent }) → Promise`; `turnOpen`, `onStop` (session only); `completions` (`/`, `@` sources); `preview` (comments).

### 13.2 Drafts, recall, optimistic send (Q22)

- Drafts: `localStorage` `of-draft:agent:<slug>` / `of-draft:task:<key>`, stored as `{ text, at }`, dropped after 7 days, try/catch as today; cleared only when the server accepts the send (only what was sent, as today); a terminated agent's draft stays copyable.
- ↑ recall: in an empty composer with the caret at 0, ↑ fills the box with your newest `message_in` envelope in the loaded timeline (the server's record, Q22b); nothing when none is loaded. Always a new send.
- Optimistic send: Enter clears the box and adds a dashed-border "Sending…" block to the queue area (distinct label and no "Not delivered yet" text, so it never looks queued or delivered); the 202's queue item, or the delivered message, replaces it in one commit; on failure the text returns to the box (appended to anything typed since) with the inline error, and the block is removed.

### 13.3 `/` commands — awaiting spike-u3

Planned per chat H4 (opening rule: a leading `/` only, `//` escapes; groups Skills, Commands (an allowlist of built-ins), Factory (Compact, New session); command mode; held until no turn is open; a raw-command endpoint, decisions.md "Reviewer disagreements"). Final after the spike.

### 13.4 `@` completion (Q23)

- Built on `cmdk` (approved, decision 8) in a Radix popover anchored to a zero-size element at the caret; opened by typing or the toolbar button; no animation (keyboard-opened); max 8 rows; `aria-activedescendant` combobox semantics; ↑/↓ move, Tab/Enter accept, Esc closes and leaves the text.
- Rows: avatar 16, display name, muted middle-truncated `@slug` (max width 28rem); humans by name and handle; `@humans`. Ranking: your reports and recent senders first, then alphabetical; live agents only.
- Task comments insert `@slug ` (routing as today). The session composer inserts plain text; session UI copy never says "mention" (Q23).

### 13.5 Attachments — awaiting spike-u3

Planned per chat M3 (upload into the agent's workspace `.factory/uploads/`, an `[attached: …]` line per file in the body, chips in `MessageBlock`). Final after the spike.

## 14. Header (PR1)

The header loses Stop (§6.1). It keeps the status badge and U2's one live fact; the activity line stays in the timeline footer only (one surface).

## 15. Server changes

| PR | Change |
|---|---|
| 1 | `interrupt()` takes the hold (§6.3); `waitReason: "stopping"`; factory event `interrupt_unconfirmed`; queue cancel/restore routes and `state = "cancelled"` (§6.4) |
| 3 | `tool_result.meta` in the mapper and `packages/shared` (§9.1) |
| 4 | `--include-partial-messages`, `LiveEvent`, runtime `LiveState`, `live` frame and `live_snapshot` client message, `messageId`/`blockIndex` on persisted events (§11) |
| 5 | commands list and dispatch, uploads (after the spike) |

## 16. DESIGN.md amendments

1. **Components → Composers** (PR1, PR5): "The composer is one plate with the textarea and a toolbar inside its frame. Send is a primary button, disabled-shaped while empty. While a turn is open, Stop (a ghost button with its label) sits left of Send, and Esc in the composer stops the turn. ⌥/Alt+Enter sends and interrupts the turn; ⌘/Ctrl+Enter also sends normally."
2. **Typography → Hierarchy** (PR2): reading prose 15/24 for speech, task bodies and comments; markdown h1/h2/h3 20/17/15, demoted 17/16/15; tool output markdown 13/20. Replaces "Reading prose stays 14/22 for now…".
3. **Motion → Frequency decides** (PR1): "Rows appended to the session timeline by a live frame fade in with opacity only (150ms `--ease-out`). Never on load, Load earlier or resync, never with movement or stagger; a queued message turning into the delivered one doesn't fade. Other live lists stay instant." And: "A running turn shows a ticking duration; waiting lines and holds keep fixed times."
4. **Motion → Deliberately not used** (PR2): blur crossfades are allowed for the row menu's copy feedback (150ms, blur ≤2px), the first component that needs one.
5. **Colors → Semantic** (PR3): `--diff-add` and `--diff-remove`, low tints of success and crimson on the plate, per theme; the +/− sign is always shown; code text keeps ink colour.
6. **Components → Session timeline** (new, PR2–PR4): the three tiers; the card rule ("an envelope that crossed a session boundary is a card"); speaker lines; the deep-link arrival (focus ring + fading 6% tint, never the gutter); folded tool runs; subagent cards as an indented plate, distinct from message cards and spawn blocks; the one row menu; streamed text with no caret.
7. **Components → Completion menus** (PR5): keyboard-opened, so no animation; anchored at the caret.

## 17. Behavior-doc edits (gitignored `docs/product/`; applied in the main checkout by the dev in the PR named, listed in its description)

- `behavior/agents-and-sessions.md` (PR1): Stop and Esc in the composer, ⌥Enter urgent, header without Stop (narrowing decision 5); held-message Cancel; activity line ticks, waiting lines don't. (PR4) live streaming defined as ephemeral and never stored. (PR5) `/` commands replace "the composer never interprets slash commands".
- `architecture/harness-driver.md` (PR3, PR4): `tool_result.meta`; `LiveEvent`; mapping of `stream_event`, `task_progress`, `thinking_tokens`; interrupt hold.
- `ui-review/decisions.md`: a note under decision 5 pointing at Q2.

## 18. Testing

- Unit: `deriveActivity` priority; `buildRows` open turn, footer, head flags; `groupWork` (runs, splits, partial labels, one-commit settle); failure merge; `plainLength`; the reducer's handoff and `liveAfter`; `isUrgentSendKey`; mapper meta per tool from fixtures; meta bounding.
- Component: Stop and Esc (menu-open case, no-turn case); hint visibility; Cancel/Undo; Jump pill labels and windowed navigation; stick-to-bottom intents (the 2,000px growth case, selection, composer typing); deep-link focus and tint; row menu items per kind; renderers per tool incl. no-meta fallback and `partial`; untrusted markdown images; fence-close highlighting.
- Render counts (U1's harness, `timeline-perf.test.tsx`): an `Elapsed` tick, a live frame (PR4) and an `agent_status` frame re-render no `TimelineItem`.
- Server: interrupt hold and fallback event; cancel/restore incl. 409s and boot skip.

## 19. Follow-up issues (opened with the decisions issue)

1. Timeline virtualization (break L7): measure after PR4 on the 2,400-event dataset; numbers in the issue.
2. Find in session (chat L4).
3. `T-` task completion in composers (Q23).
4. Mobile composer layout and row long-press → U4 (Q25).

## 20. Delivery

Five stacked PRs on `u2/6-templates-inbox-home` (#101), in this order (Q1):

| PR | Branch | Content |
|---|---|---|
| 1 | `u3/1-live-turn` | §5, §6 (session composer in place), §8, §14, D1, Cancel |
| 2 | `u3/2-timeline-tiers` | §7 |
| 3 | `u3/3-tools` | §9, §10 |
| 4 | `u3/4-streaming` | §11, §12 (after the spike) |
| 5 | `u3/5-shared-composer` | §13 (after the spike) |

## 21. Decisions

Proxy answers Q1–Q25 and tech-lead decisions D1–D2 are logged in the decisions issue. Rated 3/5 or lower, for Or:

- **Q2** (3/5): Stop only in the composer; narrows decision 5's "header keeps … plus Stop".
- **Q4** (3/5): ⌥Enter for urgent and no split-Send menu.
- **Q7** (3/5): speech prose 15/24.
- **Q8** (3/5): deep-link arrival as real focus plus a fading tint.
- **Q10, cost part** (3/5): estimated cost on every turn footer.
- **Q22b** (3/5): ↑ recall from the loaded timeline.

## 22. Risks

- **Streaming cost on long sessions.** Mitigated by keeping rows' identity stable and committing once per frame; measured in PR4 (acceptance 21) before deciding on virtualization.
- **Stop hold delays a human's steer by up to 10 s** if Claude never answers the interrupt; the fallback line makes it visible.
- **Prose at 15/24 lengthens sessions**; folding tool runs gives the height back (Q7).
