# S9 Scheduling: UI Design

- **Date:** 2026-11-20
- **Status:** approved by owner-proxy (owner-s9); pending the impeccable review against DESIGN.md
- **Spec:** [`docs/superpowers/specs/2026-11-20-s9-scheduling-design.md`](../specs/2026-11-20-s9-scheduling-design.md)
- **Extends:** [S3 session UI](2026-11-18-s3-session-ui-design.md), [S4 templates, agents and settings UI](2026-11-19-s4-templates-agents-settings-ui-design.md), [S5 supervisor UI](2026-11-19-s5-supervisor-ui-design.md), [S6 messaging UI](2026-11-19-s6-messaging-ui-design.md), [S7 spawning UI](2026-11-19-s7-spawning-ui-design.md), [S8 tasks and inbox UI](2026-11-20-s8-tasks-inbox-ui-design.md). Everything not mentioned here stays as they define it.
- **Design system:** `DESIGN.md` (Sawtooth). Where this doc and DESIGN.md disagree, DESIGN.md wins.

## 1. What changes

The Schedules page stops being an empty state: a dense list, a create page and an edit page. In a session, scheduled messages carry a badge that opens their schedule, and the agent strip's cron count opens a popover with the live crons and a **Stop crons** action. All data comes from the spec's §10–§11 fields; **the UI never parses prose** (a scheduled message is recognised by its `kind` and the row's `scheduleKey`, `dueAt`, `firings`, `late`; a schedule's state by `state`).

**Terms.**
- **Schedule** (a factory scheduled message) and its key `S-3` (Geist Mono, like `T-42`). Never "job", "timer" or "reminder" in the UI.
- **Cron** keeps S5's meaning: an in-session `CronCreate` job ("2 crons", "Stop crons"). A schedule's cron expression is called its **"Repeats"** value in the form and shown raw in mono; the word "cron" appears next to it only in help text ("a 5-field cron expression"), so the two features stay apart.
- "Runs" for occurrences ("Next run", "next 3 runs", "covers 3 runs"); "Paused", "Done", "Active" as state labels.
- Agents `@slug`, humans `@handle`, both mono (S6). Spawned agents per PRODUCT.md.
- **Times:** every absolute time is shown **in the schedule's zone** with the zone name: "Mon 23 Nov 09:00 Europe/Berlin". The zone is written as its IANA name in muted text after the time. Past times in lists use S6's `formatInboxTime` style but with the zone. Times are `<time>` elements whose `datetime` is the ISO instant and whose `title` is the full timestamp in the viewer's local zone too ("Mon 23 Nov 2026 09:00 Europe/Berlin · 08:00 your time").

**State presentation** (Status Is Never Colour Alone): icon plus label, no pills, no orange (a schedule is not "live").

| State | Icon (lucide, `aria-hidden`) | Colour | Label |
|---|---|---|---|
| Active | `CalendarClock` | muted icon, ink label | "Active" |
| Paused | `CirclePause` | muted icon and label | "Paused" |
| Done (fired one-shot) | `CircleCheck` | muted icon and label | "Done" |
| Skipped (target archived) | `CircleSlash` | muted icon, ink label | "Skipped: @x is archived" |
| Pending, target errored | `CircleAlert` | `crimson` icon, ink label | "Pending: @x is errored" |

## 2. Schedules page (`/schedules`)

```
┌ PageHeader: Schedules ─────────────────────────────── [+ New schedule] ┐
│ Target [Any agent ▾]   [ ] Show done                                     │
│ (InlineOutcome: Deleted S-3. [Undo])                                      │
├──────────────────────────────────────────────────────────────────────────┤
│ S-3  @ceo   0 9 * * 1-5        Next: Mon 23 Nov 09:00 Europe/Berlin   ◷ Active │
│      Morning review: open tasks, blockers, what shipped.        [⋯]      │
│      by @or                                                              │
├──────────────────────────────────────────────────────────────────────────┤
│ S-7  @dev   Once               Wed 25 Nov 14:30 Europe/Berlin   ⊘ Pending: @dev is errored │
│      Check whether the nightly migration finished.              [⋯]      │
│      created by @lead · last written by @or                              │
└──────────────────────────────────────────────────────────────────────────┘
```

- **List:** S8's list pattern: `<ul aria-label="Schedules">`, rows separated by a 1px `rule`, min 56px, three lines. Unlike tasks, a row is **not** one link (it has a menu); the key is the link to the edit page (`/schedules/S-3`), and the row has `steel-hover`.
  - line 1: key (mono, fixed 56px column), target `@slug` (mono, a link to the agent; ended targets muted with "· terminated"/"· archived"), **when** (cron raw in mono, or "Once"), the next run ("Next: …" for active; the `at` time for a pending one-shot; "Ran Mon 23 Nov 09:00 Europe/Berlin" for done; "—" while paused), then at the right the state (icon + label, fixed width).
  - line 2: the message's **first line as escaped plain text** (never rendered markdown), muted ink, truncated with an ellipsis; the row menu button at the right.
  - line 3 (muted 13px): "by `@or`", or "created by `@lead` · last written by `@or`" when they differ (`@lead (archived)` when the creator is archived).
  - Below `md`: line 1 is key, target and state; line 2 is when · next run; line 3 the message; line 4 the authors.
- **Row menu** (`DropdownMenu`, ghost icon button `MoreHorizontal`, `aria-label` "Actions for S-3"): **Edit** (link to `/schedules/S-3`), **Pause** / **Resume** (not for done), **Delete**. Pause, Resume and Delete apply immediately (DESIGN.md: reversible, no confirmation). Pause/Resume show their outcome in the row's state; a failure uses the page's `InlineOutcome` in alert tone: "Couldn't pause S-3." + "Retry".
- **Delete with Undo:** the row leaves the list at once; S4's `InlineOutcome` at the top of the page body: "Deleted S-3." + "Undo"; focus moves to Undo. Undo calls `restore`, the row returns (with its recomputed next run), focus returns to the row's menu button. The line stays until the user leaves the page or acts again. Undo failure: "Couldn't restore S-3. Try again." + "Retry".
- **Filters:** a toolbar row under the header: **Target** (S4 `NativeSelect` with a visible label; "Any agent" + each live agent `@slug`; an ended target via the URL only, shown as an extra option while selected) and **Show done** (a checkbox; S3's `Checkbox`). Values in the URL (`/schedules?target=ceo&done=true`), no Apply button. Below `md` they stack.
- **Sort:** by next run (soonest first), then paused, then done (most recent first), then key. No paging (tens of rows); the server caps at 500 and the page says "Showing the first 500 schedules." if reached.
- **Live:** `schedules_changed` refetches and merges by key (React keys are schedule keys, so focus survives); rows reorder instantly, no animation.
- **States:** first load: the route's pending mark. Empty (no schedules at all): "No schedules yet." Empty with a filter: "No schedules match these filters." + ghost "Clear filters". Error: S6's crimson line "Couldn't load schedules." + "Retry".
- **New schedule:** S4's header action pattern (ghost button with a `Plus` icon, label "New schedule", `sr-only` below `md`), a link to `/schedules/new` (with `?target=<slug>` prefilled when the list is filtered).

## 3. Create and edit pages (`/schedules/new`, `/schedules/S-3`)

A page, not a modal (long markdown bodies). S4's form layout (single column, max width 720px, labels above fields):

1. **Target** (S8's `AgentPicker` as a `NativeSelect` of live agents, persistent and spawned; spawned agents read `@slug · spawned by @lead`). Helper: "The schedule wakes this agent at each run."
2. **When:** a two-option segmented control (radio group, S4's `SegmentedControl` if present, else a `RadioGroup` styled as one): **Repeats** · **Once**.
   - **Repeats:** a mono `Input` labelled "Repeats (cron)". Helper text: "A 5-field cron expression: minute hour day-of-month month day-of-week. Examples: `0 9 * * 1-5` (weekdays at 09:00), `*/30 * * * *` (every 30 minutes), `0 8 1 * *` (the 1st of each month at 08:00)."
   - **Once:** a native `datetime-local` input labelled "Date and time", read in the chosen zone.
3. **Time zone:** a combobox (shadcn `Command` in a `Popover`, the list from `Intl.supportedValuesOf("timeZone")`), default the browser's zone on create; the trigger shows the IANA name. Helper: "Times are read and shown in this zone."
4. **Preview:** a muted 13px block under the When/Zone fields, `aria-live="polite"`, updated when a field is left (never per keystroke): "Next runs: Mon 23 Nov 09:00 · Tue 24 Nov 09:00 · Wed 25 Nov 09:00 (Europe/Berlin)", or for Once "Runs once: Wed 25 Nov 14:30 (Europe/Berlin)". Computed in the browser with the shared `cron.ts` (same croner version as the server). Invalid input shows no preview (the field error says why).
5. **Message** (S4's `MarkdownEditor`, Write/Preview, required). Helper: "Delivered as written, from @scheduler, with you as its author."
6. Buttons: primary "Create schedule" / "Save changes" ("Creating…"/"Saving…", disabled while pending), ghost "Cancel" (back to `/schedules`, no confirmation).

**Edit page only:**
- A header line under the page title (`S-3` in mono as the title, DESIGN.md: a key is an identifier): the state (icon + label), "created by `@lead`", "last written by `@or`" when different, "last run Mon 23 Nov 09:00 Europe/Berlin" when it has run.
- Pause/Resume and Delete as ghost buttons in the page header (Delete navigates back to the list, where the Undo line shows: the list route reads a `deleted=S-3` search param for it).
- A note when a firing is pending: "A run is waiting for @dev (errored). Edits apply from the next run." (from `state = pending_errored`, or generally when the item reports `pendingFiring: true`: "A run is waiting to be delivered to @dev. Edits apply from the next run.")
- When the body was written by an agent and the human edits the message: the helper changes to "Saving makes you the author of this message." (Q18).

**Validation** (DESIGN.md → Components → Validation, a longer form): each field validates when you leave it, never while you type; everything is checked again on submit, which moves focus to the first invalid field. Errors below their field in crimson with an icon: "Choose an agent.", "Enter a cron expression.", "Use 5 fields: minute hour day-of-month month day-of-week.", the server's sentence for an invalid field ("Invalid value for minute: 61."), "This cron never fires.", "Choose a date and time.", "That time has passed.", "Unknown time zone.", "Enter a message.", "Shorten the message to 64 KB or less." Server field errors map to their field; others go to S4's `role="alert"` line above the buttons: "Couldn't save the schedule. Try again." On success: back to `/schedules` (create) or stay with S4's inline "Saved." outcome (edit).

## 4. Session additions

### 4.1 Scheduled messages in the timeline
`scheduled` envelopes render as S3/S6 message blocks (`MessageBlock` with S8's `badge` prop):
- **Sender line:** "Scheduler" (the factory sender style of S5, `CalendarClock` icon), then the schedule badge: "`S-3`" (mono) linking to `/schedules/S-3`, then "by `@or`" (S6 sender rendering: an agent author links to its session).
- **Notes** after the sender line, muted 13px, only when relevant, separated by " · ": "due Mon 23 Nov 09:00 Europe/Berlin · delivered late" (`late`), "covers 3 runs" (`firings > 1`). The due time is shown only with "delivered late".
- **Body:** as the agent saw it, through `Markdown`, clamped with S3's "Show all".
- **Pending** scheduled rows show in S3's dashed "Not delivered yet" block with the badge and "covers 3 runs" when replaced (the queue item carries `scheduleKey`, `firings`).
- A deleted schedule's badge still shows the key; its link opens the edit page, which says "S-3 was deleted." with "Restore" (humans).

### 4.2 Agent strip
- **Crons:** S5's waiting-on "2 crons" text becomes a ghost text button (same 13px muted look, S6's link underline on hover, `aria-haspopup="dialog"`, accessible name "2 crons: show and stop"). It opens a `Popover`:
  ```
  ┌ Crons in this session ────────────────────────┐
  │ every 5 minutes        next 14:35 · expires 27 Nov │
  │ at 14:30, once         next 14:30               │
  │ ─────────────────────────────────────────────── │
  │ They stop when the process stops. Stopping them  │
  │ hibernates @dev once it is idle.                 │
  │                              [Stop 2 crons]      │
  └────────────────────────────────────────────────┘
  ```
  Each row: the schedule text as Claude wrote it (plain text, truncated at 60 characters with the full text visually hidden), "once" for one-shots, "durable" in muted text when `durable` is set, "next HH:MM" (local zone, `<time>`), "expires 27 Nov" for recurring. **Stop crons** is a ghost button with a crimson icon (`CircleStop`) (S7's Terminate style), label "Stop 2 crons" / "Stop 1 cron".
- **Confirmation** (DESIGN.md: destructive and irreversible: the crons are gone): S5's `AlertDialog`. Title "Stop @dev's crons?" Body: "These crons stop and can't be restored: every 5 minutes; at 14:30, once. @dev hibernates now (or when its current work finishes) and is told a human stopped them." Buttons: "Stop 2 crons" (danger) and "Cancel". Focus: Cancel first (destructive default), back to the strip button on close.
- **Pending:** while `stopCronsPending`, the segment reads "2 crons · stopping when its current work finishes" and the popover's button is replaced by that sentence. Outcome failures in the popover, alert tone: "Couldn't stop the crons. Try again." + "Retry"; a `409 no_crons` closes the popover silently (the crons ended meanwhile).
- **Schedules:** a segment after S8's tasks segment: "2 schedules" (singular "1 schedule"), a link to `/schedules?target=<slug>`, muted 13px with S6's link underline; hidden at 0 (`scheduleCount`); refetched on `schedules_changed`. If the strip overflows, this is the first segment to drop below `md`.
- Both segments sit outside the strip's `role="status"` region (S5).

### 4.3 Timeline quiet lines
| Event | Line |
|---|---|
| `hibernated` reason `crons_stopped` | "Hibernated: @or stopped its crons" |
| `background_work_lost` reason `crons_stopped` | "Stopped by @or: every 5 minutes (cron)" |
| `cron_created` with `durable` | "Cron created: every 5 minutes (durable)" |

## 5. Org tree

Unchanged: "2 crons" stays the row's inline note (S5). No schedule indicator on rows.

## 6. Accessibility

- The schedule list is a `<ul aria-label="Schedules">`; each row's key link has a complete accessible name: "S-3, to @ceo, repeats 0 9 * * 1-5, next run Monday 23 November 09:00 Europe/Berlin, Active, by @or"; the first line of the message via `aria-describedby`.
- State icons `aria-hidden`; the label carries the state.
- The segmented control is a radio group with a group label "When"; the inactive option's field is removed from the DOM (not just hidden) so it isn't validated or tabbed to.
- The preview is a polite live region updated on blur only.
- The zone combobox follows shadcn `Command`'s pattern (listbox, typeahead); its trigger's name includes the value ("Time zone: Europe/Berlin").
- Row menus name their schedule ("Actions for S-3"); Delete moves focus to Undo; Undo returns it.
- The cron popover is a labelled dialog ("Crons in this session"); Escape closes it and returns focus to the strip button.
- `<time>` elements carry ISO `datetime`.

## 7. Responsive

Below `md`: list rows as §2; filters stack; the form is one column (it already is); the segmented control spans the width; the popover becomes S3's bottom sheet; "New schedule" label `sr-only`. Content gutters 16px.

## 8. Components

`apps/web/src/features/schedules/`: `api.ts`, `ScheduleList`, `ScheduleRow`, `ScheduleFilters`, `ScheduleState`, `ScheduleForm` (create and edit), `WhenField` (segmented control + cron/at inputs), `TimezoneCombobox`, `RunPreview`, `ScheduleBadge`. `apps/web/src/features/session/`: `CronsPopover`, `StopCronsDialog`. Routes: `routes/_app/schedules.index.tsx` (replaces `schedules.tsx`), `schedules.new.tsx`, `schedules.$key.tsx`. Changed shared pieces: `MessageBlock` (scheduled sender and notes), `AgentStrip` (crons button, schedules segment), `QueueItem` (badge), timeline quiet lines.

## 9. Fixed strings

"Schedules", "New schedule", "No schedules yet.", "No schedules match these filters.", "Clear filters", "Couldn't load schedules.", "Retry", "Showing the first 500 schedules.", "Target", "Any agent", "Show done", "Active", "Paused", "Done", "Skipped: @x is archived", "Pending: @x is errored", "Next:", "Ran", "Once", "by", "created by", "last written by", "(archived)", "Actions for S-3", "Edit", "Pause", "Resume", "Delete", "Couldn't pause S-3.", "Couldn't resume S-3.", "Deleted S-3.", "Undo", "Couldn't restore S-3. Try again.", "S-3 was deleted.", "Restore", "When", "Repeats", "Repeats (cron)", "Date and time", "Time zone", "Times are read and shown in this zone.", "A 5-field cron expression: minute hour day-of-month month day-of-week.", "Examples:", "weekdays at 09:00", "every 30 minutes", "the 1st of each month at 08:00", "Next runs:", "Runs once:", "Message", "Delivered as written, from @scheduler, with you as its author.", "Saving makes you the author of this message.", "The schedule wakes this agent at each run.", "A run is waiting to be delivered to @dev. Edits apply from the next run.", "A run is waiting for @dev (errored). Edits apply from the next run.", "Create schedule", "Creating…", "Save changes", "Saving…", "Saved.", "Cancel", "Couldn't save the schedule. Try again.", "Choose an agent.", "Enter a cron expression.", "Use 5 fields: minute hour day-of-month month day-of-week.", "This cron never fires.", "Choose a date and time.", "That time has passed.", "Unknown time zone.", "Enter a message.", "Shorten the message to 64 KB or less.", "Scheduler", "due", "delivered late", "covers 3 runs", "Not delivered yet", "2 crons", "1 cron", "2 crons: show and stop", "Crons in this session", "once", "durable", "next", "expires", "They stop when the process stops. Stopping them hibernates @dev once it is idle.", "Stop 2 crons", "Stop 1 cron", "Stop @dev's crons?", "These crons stop and can't be restored:", "@dev hibernates now (or when its current work finishes) and is told a human stopped them.", "stopping when its current work finishes", "Couldn't stop the crons. Try again.", "2 schedules", "1 schedule", "Hibernated: @or stopped its crons", "Stopped by @or:", "(durable)".
