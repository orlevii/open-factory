# S9 Scheduling: UI Design

- **Date:** 2026-11-20
- **Status:** approved by owner-proxy (owner-s9), revised after the impeccable review against DESIGN.md (round 1)
- **Spec:** [`docs/superpowers/specs/2026-11-20-s9-scheduling-design.md`](../specs/2026-11-20-s9-scheduling-design.md)
- **Extends:** [S3 session UI](2026-11-18-s3-session-ui-design.md), [S4 templates, agents and settings UI](2026-11-19-s4-templates-agents-settings-ui-design.md), [S5 supervisor UI](2026-11-19-s5-supervisor-ui-design.md), [S6 messaging UI](2026-11-19-s6-messaging-ui-design.md), [S7 spawning UI](2026-11-19-s7-spawning-ui-design.md), [S8 tasks and inbox UI](2026-11-20-s8-tasks-inbox-ui-design.md). Everything not mentioned here stays as they define it.
- **Design system:** `DESIGN.md` (Sawtooth). Where this doc and DESIGN.md disagree, DESIGN.md wins.

## 1. What changes

The Schedules page stops being an empty state: a dense list, a create page and an edit page. In a session, scheduled messages carry a badge that opens their schedule, and the agent strip's cron count opens a popover with the live crons and a **Stop crons** action. All data comes from the spec's §10–§11 fields; **the UI never parses prose** (a scheduled message is recognised by its `kind` and the row's `scheduleKey`, `dueAt`, `firings`, `late`; a schedule's state by `state`; authors by their `{kind, …}` objects; the stop by the events' `by`).

**Terms.**
- **Schedule** (a factory scheduled message) and its key `S-3` (Geist Mono, like `T-42`). Never "job", "timer" or "reminder" in the UI.
- **Cron** keeps S5's meaning: an in-session `CronCreate` job ("2 crons", "Stop crons"). A schedule's expression is its **"Repeats"** value, shown raw in mono and called a **pattern** in copy ("This pattern never runs."). "Cron expression" appears only in help text ("a 5-field cron expression"), so the two features stay apart.
- "Runs" for occurrences ("Next run", "next 3 runs", "covers 3 runs"); "Active", "Paused", "Done", "Skipped", "Waiting" as state labels.
- Agents `@slug`, humans `@handle`, both mono (S6). Spawned agents per PRODUCT.md.
- **Times:** one formatter, `formatScheduleTime(at, zone, now)`, used everywhere a schedule time is shown: weekday, day, month, 24h time in the schedule's zone, the year only when it isn't the current one, then the zone's IANA name in muted text: "Mon 23 Nov 09:00 Europe/Berlin", "Tue 4 Jan 2028 09:00 Europe/Berlin". Every time is a `<time>` with the ISO instant in `datetime` and a `title` that adds the viewer's time ("… · 08:00 your time"). Where the viewer's zone differs from the schedule's, the edit page's preview also says it in visible text (§3), because hover isn't reachable by keyboard or touch.

**State presentation** (Status Is Never Colour Alone): icon plus label, no pills, no orange (a schedule is not "live"). The reason is said once, next to the target, never repeated in the state.

| State (`state`) | Icon (lucide, `aria-hidden`) | Colour | Label | Next to the target |
|---|---|---|---|---|
| `active` | `CalendarClock` | muted icon, ink label | "Active" | — |
| `paused` | `CirclePause` | muted icon and label | "Paused" | — |
| `done` | `CircleCheck` | muted icon and label | "Done" | — |
| `skipped_archived` | `CircleSlash` | muted icon, ink label | "Skipped" | "· archived" |
| `pending_errored` | `CircleAlert` | `crimson` icon, ink label | "Waiting" | "· errored" |

## 2. Schedules page (`/schedules`)

```
┌ PageHeader: Schedules ─────────────────────────────── [+ New schedule] ┐
│ Target [Any agent ▾]   [ ] Show done                                     │
│ (InlineOutcome: Deleted S-3. [Undo])                                      │
├──────────────────────────────────────────────────────────────────────────┤
│ S-3  @ceo                                              ◷ Active    [⋯]  │
│      0 9 * * 1-5 · Next: Mon 23 Nov 09:00 Europe/Berlin                  │
│      Morning review: open tasks, blockers, what shipped.                 │
│      by @or                                                              │
├──────────────────────────────────────────────────────────────────────────┤
│ S-7  @dev · errored                                    ⚠ Waiting   [⋯]  │
│      Once · Wed 25 Nov 14:30 Europe/Berlin                               │
│      Check whether the nightly migration finished.                       │
│      created by @lead · last written by @or                              │
└──────────────────────────────────────────────────────────────────────────┘
```

- **List:** S8's list pattern: `<ul aria-label="Schedules">`, rows separated by a 1px `rule`, min 72px, four lines at every width (a single wide line overflowed at `md` with the sidebar open: key, target, pattern, next run and state need ~660px of a ~480px column). Each row is **one link** to `/schedules/S-3` stretched over the row (the key link's `::after` covers it), `steel-hover`, instant; the row menu button sits above it (`relative z-10`) and the target's own link likewise.
  - line 1: key (mono, fixed 56px column), target `@slug` (mono, a link to the agent's session; muted with "· archived" / "· errored" per the table), then at the right the state (icon + label, fixed width) and the row menu button.
  - line 2 (13px): **when**: the pattern in mono, or "Once"; then " · " and the time: "Next: …" (active; "Next: … (skipped)" when skipped, since it won't reach the agent), the `at` time (an active or waiting one-shot), "Ran …" (done with `ran`), "Didn't run: @x was archived" (done without `ran`), "—" while paused. The zone truncates first; the state never does.
  - line 3: the message's **first line as escaped plain text** (never rendered markdown), muted ink, truncated with an ellipsis.
  - line 4 (muted 13px): "by `@or`", or "created by `@lead` · last written by `@or`" when they differ; "`@lead` (archived)" when that agent is archived.
- **Row menu** (`DropdownMenu`, ghost icon button `MoreHorizontal`, `aria-label` "Actions for S-3"): **Edit**, **Pause** / **Resume** (not for done), **Delete**. Pause, Resume and Delete apply immediately (DESIGN.md: reversible, no confirmation). Outcomes go to the page's `InlineOutcome` (success tone): "Paused S-3." / "Resumed S-3. Next run: Mon 23 Nov 09:00 Europe/Berlin."; failures in alert tone: "Couldn't pause S-3." + "Retry". After Pause/Resume the row moves to its group instantly; focus stays on its menu button (stable keys).
- **Delete with Undo:** the row leaves the list at once; `InlineOutcome`: "Deleted S-3." + "Undo"; focus moves to Undo. Undo calls `restore`; the row returns and focus goes to its menu button. If the restored schedule is a passed one-shot it comes back as Done; with "Show done" off the line then reads "Restored S-3. It's done, so it's hidden." + "Show done", and focus stays on the line. Undo failure: "Couldn't restore S-3." + "Retry"; `409 target_ended`: "S-3 can't be restored: @x was terminated." The line stays until the user leaves the page or acts again.
- **Filters:** a toolbar row under the header: **Target** (S4 `NativeSelect` with a visible label; "Any agent" + each live agent `@slug`; an ended target via the URL only, shown as an extra option while selected) and **Show done** (S3's `Checkbox`). Values in the URL (`/schedules?target=ceo&done=true`), no Apply button. Below `md` they stack.
- **Order:** the server's (spec §11): active by next run, then paused, then done (newest first). No paging; at the server's cap of 500 the page says "Showing the first 500 schedules."
- **Live:** `schedules_changed` refetches and merges by key (React keys are schedule keys, so focus survives); rows reorder instantly, no animation.
- **States:** first load: the route's pending mark. Empty (no schedules at all): "No schedules yet." Empty with a filter: "No schedules match these filters." + ghost "Clear filters". Error: S6's crimson line "Couldn't load schedules." + "Retry".
- **New schedule:** S4's header action pattern (ghost button with a `Plus` icon, label "New schedule", `sr-only` below `md`), a link to `/schedules/new` (with `?target=<slug>` when the list is filtered).
- **Outcomes from other pages** (create, delete from the edit page) arrive as one-shot router state (`navigate({ state })`), never a URL parameter, so a reload or Back doesn't replay them: "Created S-8." / "Deleted S-3." + "Undo".

## 3. Create and edit pages (`/schedules/new`, `/schedules/S-3`)

A page, not a modal (long markdown bodies). S8's header pattern: a "← Schedules" back link, the title ("New schedule", or the key `S-3` in mono: a key is an identifier), `document.title` "New schedule · Open Factory" / "S-3 · <first line> · Open Factory". S4's form layout (single column, max width 720px, labels above fields):

1. **Target** (S8's `AgentPicker`, a `NativeSelect` of live agents, with its existing `agentOptionLabel`). On create its first option is an empty "Choose an agent…" (not S8's "Unassigned"). On edit, an archived current target is kept as an extra option "@x (archived)" while selected, so the select never falls back to another agent. Helper: "The schedule wakes this agent at each run." When a spawned agent is chosen the helper adds: "Spawned agents end when their work is done; this schedule is deleted with it."
2. **When:** a `<fieldset>` with the legend "When" and two native radio inputs styled as a segmented pair (no new component): **Repeats** · **Once**. Only the chosen option's field is rendered; the other's value is kept in form state, so switching back doesn't lose it.
   - **Repeats:** a mono `Input` labelled "Repeats". Helper: "A 5-field cron expression: minute hour day-of-month month day-of-week. Examples: `0 9 * * 1-5` (weekdays at 09:00), `*/30 * * * *` (every 30 minutes), `0 8 1 * *` (the 1st of each month at 08:00)."
   - **Once:** a native `datetime-local` input labelled "Date and time", read in the chosen zone. On edit it is filled from the stored instant converted into the schedule's zone. Changing the zone keeps the clock time and re-reads it in the new zone (the preview shows the new instant).
3. **Time zone:** a `NativeSelect` grouped by region with `<optgroup>`s (Africa, America, Asia, Atlantic, Australia, Europe, Indian, Pacific, and "Other" holding UTC), from `Intl.supportedValuesOf("timeZone")` plus **UTC** and the current value (the browser's resolved zone on create, the stored zone on edit) whenever the list lacks them (it omits UTC and some aliases). Native typeahead and mobile pickers come free; no combobox (S8 rejected a new component for a rarely used field). Helper: "Times are read and shown in this zone."
4. **Preview:** a muted 13px block under When and Time zone, `aria-live="polite"`. It updates when the pattern or date input loses focus and when the radio or zone changes, never per keystroke and never from the Message field: "Next runs: Mon 23 Nov 09:00 · Tue 24 Nov 09:00 · Wed 25 Nov 09:00 Europe/Berlin", or "Runs once: Wed 25 Nov 14:30 Europe/Berlin". When the zone differs from the browser's it adds the viewer's time in visible text: "(08:00 your time)" after the first run. Computed in the browser with the shared `cron.ts`. Invalid input shows no preview (the field error says why).
5. **Message** (S4's `MarkdownEditor`, Write/Preview, required). Helper on create: "Delivered as written, from @scheduler, with you as its author."
6. Buttons: primary "Create schedule" / "Save changes" ("Creating…"/"Saving…", disabled while pending), ghost "Cancel" (back to `/schedules`). Leaving with unsaved changes (Cancel, a link, Back, closing the tab) uses S4's unsaved-changes guard (the router blocker and the browser prompt); Cancel adds no confirmation of its own.

**Edit page only:**
- A header line under the title: the state (icon + label), "created by `@lead`", "last written by `@or`" when different, "last run Mon 23 Nov 09:00 Europe/Berlin" when it has run. A done schedule adds: "Done. Set a future date and time to run it again."
- Pause/Resume and Delete as ghost buttons in the page header; below `md` they become icon buttons with `sr-only` labels and tooltips (S4's header pattern). Delete navigates back to the list, which shows the Undo line (§2).
- When a firing is pending (`pendingFiring`): "A run is waiting to be delivered to @dev. Edits apply from the next run." (for `pending_errored`: "A run is waiting for @dev, which is errored. Edits apply from the next run.").
- When the body author is an agent (`bodyAuthor.kind = "agent"`), the Message helper reads "Saving a changed message makes you its author."
- **Saving sends only the fields that changed** (spec §6.3), and only changed fields are validated on submit, so a done or near-due one-shot's message can still be edited.
- **Live:** `schedules_changed` refreshes the header line and state; fields the user has edited are kept, untouched fields take the new values.
- **Not found:** `/schedules/S-99` uses the route-states not-found pattern: "There is no schedule S-99." + "Back to schedules".
- **Deleted:** the form is read-only with "S-3 was deleted." and a "Restore" button ("Restoring…"; failure "Couldn't restore S-3." + "Retry"). If its target was terminated, Restore isn't offered (the target line already says "· terminated").

**Validation** (DESIGN.md → Components → Validation, a longer form): each field validates when you leave it, never while you type; everything changed is checked again on submit, which moves focus to the first invalid field. Errors below their field in crimson with an icon: "Choose an agent.", "Enter a pattern.", "Use 5 fields: minute hour day-of-month month day-of-week.", "Only numbers, *, ranges, lists, steps and names are allowed.", the server's sentence for an invalid field ("Invalid value for minute: 61."), "This pattern never runs.", "Choose a date and time.", "That time has passed.", "Unknown time zone.", "Enter a message.", "Shorten the message to 64 KB or less." Server field errors map to their field; others go to S4's `role="alert"` line above the buttons: "Couldn't save the schedule. Try again." On success: back to `/schedules` with "Created S-8." (create), or S4's inline "Saved." (edit).

## 4. Session additions

### 4.1 Scheduled messages in the timeline
`scheduled` envelopes render as S3/S6 message blocks (`MessageBlock` with S8's `badge` prop):
- **Sender line:** "Scheduler" (S5's factory sender style, `CalendarClock` icon), then the schedule badge "`S-3`" (mono) linking to `/schedules/S-3`, then "by `@or`" (an agent author links to its session; a human doesn't).
- **Notes** after the sender line, muted 13px, only when relevant, separated by " · ": "due Mon 23 Nov 09:00 Europe/Berlin · delivered late" (`late`), "covers 3 runs" (`firings > 1`).
- **Body:** as the agent saw it, through `Markdown`, clamped with S3's "Show all".
- **Pending** scheduled rows show in S3's dashed "Not delivered yet" block with the badge and "covers 3 runs" when replaced (the queue item carries `scheduleKey` and `firings`).
- A deleted schedule's badge still shows the key; its link opens the edit page in its deleted state (§3).

### 4.2 Agent strip
- **Crons:** S5's waiting-on "2 crons" text becomes a ghost text button (same 13px muted look, S6's link underline on hover, `aria-haspopup="dialog"`, accessible name "2 crons: show and stop"). It opens a `Popover` (collision padding; it stays a popover below `md`, like the strip's other popovers):
  ```
  ┌ Crons in this session ──────────────────────────┐
  │ every 5 minutes          expires Fri 27 Nov      │
  │ at 14:30, once           next 14:30              │
  │ ──────────────────────────────────────────────── │
  │ Cron times are in the server's zone (UTC).       │
  │ They stop when the process stops. Stopping them   │
  │ hibernates @dev once its current work is done.    │
  │                               [Stop 2 crons]      │
  └──────────────────────────────────────────────────┘
  ```
  Each row: the schedule text as Claude wrote it (plain text, truncated at 60 characters with the full text visually hidden), ", once" for one-shots; for one-shots "next" + S5's `formatResetTime` (which adds the day when it isn't today), for recurring ones "expires" + the date. The zone line shows only when the viewer's zone differs from the agent's `cronZone`. A `durable` cron (which agents are told not to create) adds "(kept on disk)" in muted text. **Stop crons** is a ghost button with a crimson icon (`CircleStop`) (S7's Terminate style), label "Stop 2 crons" / "Stop 1 cron".
- **Confirmation** (DESIGN.md: destructive and irreversible: the crons are gone): opening it closes the popover first (one modal at a time). S5/S7's `ConfirmDialog`: title "Stop @dev's crons?"; body "These crons stop and can't be restored:" followed by a list of the crons, then "@dev hibernates now, or when its current work finishes, and is told you stopped them."; buttons "Stop 2 crons" (danger; "Stopping…" while pending, the dialog stays open) and "Cancel"; focus starts on Cancel. Failures show in the dialog's own alert line: "Couldn't stop the crons. Try again." `409 no_crons` and `409 stopping` count as done (the crons ended or are ending meanwhile).
- **Outcome:** the session view's `InlineOutcome` (always mounted, polite) announces "Stopped @dev's crons." or "@dev's crons stop when its current work finishes." When the dialog closes, focus returns to the strip's crons button, or to the composer if that button is gone (`onCloseAutoFocus` fallback).
- **Pending:** while `stopCronsPending`, the segment reads "2 crons · stopping when @dev's current work finishes" and the popover's button is replaced by that sentence.
- **Schedules:** a segment after S8's tasks segment: "2 schedules" (singular "1 schedule"), a link to `/schedules?target=<slug>`, muted 13px with S6's link underline; hidden at 0 (`scheduleCount`, which counts what that list shows by default); refetched on `schedules_changed`; hidden below `md` (`hidden md:inline`).
- Both segments sit outside the strip's `role="status"` region (S5).

### 4.3 Timeline quiet lines
| Event | Line |
|---|---|
| `hibernated` reason `crons_stopped` (`by`) | "Hibernated: @or stopped its crons" |
| `background_work_lost` reason `crons_stopped` (`by`) | "Stopped by @or: every 5 minutes (cron)" |
| `cron_created` with `durable` | "Cron created: every 5 minutes (kept on disk)" |

## 5. Org tree

Unchanged: "2 crons" stays the row's inline note (S5). No schedule indicator on rows.

## 6. Accessibility

- The schedule list is a `<ul aria-label="Schedules">`; each row's link has a complete accessible name: "S-3, to @ceo, repeats 0 9 * * 1-5, next run Monday 23 November 09:00 Europe/Berlin, Active, by @or" (with "target errored" / "target archived" when relevant); the message's first line via `aria-describedby`.
- State icons `aria-hidden`; the label carries the state.
- The When fieldset has the legend "When"; the hidden option's field is removed from the DOM, not just hidden, so it isn't validated or tabbed to.
- The preview is a polite live region updated only as §3 says.
- The zone select's accessible name includes its value ("Time zone, Europe/Berlin").
- Row menus name their schedule ("Actions for S-3"); Delete moves focus to Undo; Undo returns it (§2).
- The cron popover is a labelled dialog ("Crons in this session"); Escape closes it and returns focus to the strip button. Stop's outcome is announced (§4.2).
- `<time>` elements carry ISO `datetime`.

## 7. Responsive

Below `md`: list rows keep their four lines (line 4 may wrap); filters stack; the form is one column; the When pair spans the width; the edit page's header actions become icon buttons; the cron popover stays a popover; "New schedule" label `sr-only`; the strip's schedules segment hides. Content gutters 16px.

## 8. Components

`apps/web/src/features/schedules/`: `api.ts`, `ScheduleList`, `ScheduleRow`, `ScheduleFilters`, `ScheduleState`, `ScheduleForm` (create and edit), `WhenField` (the fieldset and its two inputs), `TimezoneSelect`, `RunPreview`, `ScheduleBadge`, `formatScheduleTime`. `apps/web/src/features/session/`: `CronsPopover`, `StopCronsDialog` (on `ConfirmDialog`). Routes: `routes/_app/schedules.index.tsx` (replaces `schedules.tsx`), `schedules.new.tsx`, `schedules.$key.tsx`. Changed shared pieces: `MessageBlock` (scheduled sender and notes), `AgentStrip` (crons button, schedules segment), `AgentPicker` (a `placeholder` prop and an extra-option prop), the queue item (badge), timeline quiet lines.

## 9. Fixed strings

"Schedules", "New schedule", "No schedules yet.", "No schedules match these filters.", "Clear filters", "Couldn't load schedules.", "Retry", "Showing the first 500 schedules.", "Target", "Any agent", "Show done", "Active", "Paused", "Done", "Skipped", "Waiting", "· archived", "· errored", "Next:", "(skipped)", "Ran", "Didn't run: @x was archived", "Once", "by", "created by", "last written by", "(archived)", "Actions for S-3", "Edit", "Pause", "Resume", "Delete", "Paused S-3.", "Resumed S-3. Next run:", "Couldn't pause S-3.", "Couldn't resume S-3.", "Deleted S-3.", "Undo", "Couldn't restore S-3.", "S-3 can't be restored: @x was terminated.", "Restored S-3. It's done, so it's hidden.", "Created S-8.", "← Schedules", "There is no schedule S-99.", "Back to schedules", "S-3 was deleted.", "Restore", "Restoring…", "Done. Set a future date and time to run it again.", "When", "Repeats", "Date and time", "Time zone", "Other", "Times are read and shown in this zone.", "A 5-field cron expression: minute hour day-of-month month day-of-week.", "Examples:", "weekdays at 09:00", "every 30 minutes", "the 1st of each month at 08:00", "Next runs:", "Runs once:", "your time", "Message", "Delivered as written, from @scheduler, with you as its author.", "Saving a changed message makes you its author.", "The schedule wakes this agent at each run.", "Spawned agents end when their work is done; this schedule is deleted with it.", "Choose an agent…", "A run is waiting to be delivered to @dev. Edits apply from the next run.", "A run is waiting for @dev, which is errored. Edits apply from the next run.", "Create schedule", "Creating…", "Save changes", "Saving…", "Saved.", "Cancel", "Couldn't save the schedule. Try again.", "Choose an agent.", "Enter a pattern.", "Use 5 fields: minute hour day-of-month month day-of-week.", "Only numbers, *, ranges, lists, steps and names are allowed.", "This pattern never runs.", "Choose a date and time.", "That time has passed.", "Unknown time zone.", "Enter a message.", "Shorten the message to 64 KB or less.", "Scheduler", "due", "delivered late", "covers 3 runs", "Not delivered yet", "2 crons", "1 cron", "2 crons: show and stop", "Crons in this session", ", once", "next", "expires", "(kept on disk)", "Cron times are in the server's zone (UTC).", "They stop when the process stops. Stopping them hibernates @dev once its current work is done.", "Stop 2 crons", "Stop 1 cron", "Stopping…", "Stop @dev's crons?", "These crons stop and can't be restored:", "@dev hibernates now, or when its current work finishes, and is told you stopped them.", "Couldn't stop the crons. Try again.", "Stopped @dev's crons.", "@dev's crons stop when its current work finishes.", "stopping when @dev's current work finishes", "2 schedules", "1 schedule", "Hibernated: @or stopped its crons", "Stopped by @or:", "Cron created:".
