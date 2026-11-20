# S8 Tasks and inbox: UI Design

- **Date:** 2026-11-20
- **Status:** approved by owner-proxy (owner-s8), revised after the impeccable review against DESIGN.md (round 1)
- **Spec:** [`docs/superpowers/specs/2026-11-20-s8-tasks-inbox-design.md`](../specs/2026-11-20-s8-tasks-inbox-design.md)
- **Extends:** [S3 session UI](2026-11-18-s3-session-ui-design.md), [S4 templates, agents and settings UI](2026-11-19-s4-templates-agents-settings-ui-design.md), [S5 supervisor UI](2026-11-19-s5-supervisor-ui-design.md), [S6 messaging UI](2026-11-19-s6-messaging-ui-design.md), [S7 spawning UI](2026-11-19-s7-spawning-ui-design.md). Everything not mentioned here stays as they define it.
- **Design system:** `DESIGN.md` (Sawtooth). Where this doc and DESIGN.md disagree, DESIGN.md wins.

## 1. What changes

The Tasks page stops being an empty state: a dense list, a create page and a detail page. The Inbox gains read state, mentions and task events, and the sidebar shows how many items are unread. Home's Inbox panel shows what's unread. In a session, task messages carry a badge that opens the task, and the agent strip links to the agent's open tasks. All data comes from the spec's §9–§12 fields; **the UI never parses prose** (a task message is recognised by its `kind`, `taskKey` and `fact`; an inbox task event by its `kind` and `fact`).

**Terms.** "Task" and its key `T-42` (Geist Mono everywhere, including the page header: a key is an identifier). Statuses are written "Open", "In progress", "Done", "Cancelled" as labels, and lowercase mid-sentence ("moved this to in progress", "marked this done"). "Blocked" is not a status but a marker ("Blocked by T-41"). "Assignee", "Created by". "Comment" (noun and verb). "Mention" only in the inbox. Agents are `@slug`, humans `@handle`, both mono (S6). Spawned agents per PRODUCT.md. Past times use S6's `formatInboxTime` (`14:32`, `Yesterday 14:32`, `27 Nov 09:10`) in a `<time>` with the full timestamp as `title`.

**Status presentation** (Status Is Never Colour Alone): an icon plus the label, no pills, no orange (a task status is not "live"). Semantic colours only on icons, always with the label (DESIGN.md → Colors → Semantic; the spec asks the lead to record this use there):

| Status | Icon (lucide, `aria-hidden`) | Colour |
|---|---|---|
| Open | `Circle` | muted |
| In progress | `CircleDot` | ink |
| Done | `CircleCheck` | `success` icon, ink label |
| Cancelled | `CircleSlash` | muted icon and label |
| Blocked marker | `CircleMinus` | `warning` icon, ink label "Blocked by T-41" |

## 2. Sidebar

- The Inbox row shows the unread count at its right edge: Geist 13px tabular figures, `ink-muted`, no fill, no orange, "99+" above 99, nothing at 0. Accessible name "Inbox, 3 unread". In the collapsed icon rail, a 6px **ink** dot at the icon's top right when anything is unread, and the tooltip says "Inbox · 3 unread".
- The count comes from `GET /api/inbox/unread-count`, refetched on `inbox_changed`, and is decremented optimistically when a row is opened (§3). It changes in place (no animation).

## 3. Inbox page (`/inbox`)

S6's list, extended. Nothing S6 built is undone.

```
┌ PageHeader: Inbox ─────────────────────────────── [Mark all read] ┐
│ (InlineOutcome: Marked 7 items as read. [Undo])                    │
│ ● @dev mentioned you · T-42 · Plan the billing migration    14:32 │
│   @or can you confirm we keep the old invoices table for…         │
├────────────────────────────────────────────────────────────────────┤
│ ● Factory · ✓ Done · T-40 · Add usage export                13:05 │
│   @dev marked T-40 done.                                          │
├────────────────────────────────────────────────────────────────────┤
│   @dev → @humans                                     Yesterday 09:10│
│   Can someone approve the migration plan? It drops the…           │
└────────────────────────────────────────────────────────────────────┘
```

- **Rows** stay one link each, two lines, min 56px, `steel-hover` on hover, instant (S6).
- **Unread:** a 6px dot in **ink** (`graphite-ink` / `night-text`), in a fixed 12px slot at the row's left so read and unread rows align; the sender line in medium weight (500). Read rows: an empty slot, regular weight. The row's accessible name starts with "Unread, " when unread (the dot is `aria-hidden`).
- **Sender line by kind** (the part before the badge never truncates; the badge's title does):
  - `message` (S6): unchanged: "`@dev` → `@humans`" or "Factory about `@ops`".
  - `mention`: "`@dev` mentioned you" · badge (§3.1); for `@humans`: "`@dev` mentioned `@humans`" · badge. A human author is `@alice` (mono, like agents).
  - `task_event`: "Factory" · the status label with its icon from `fact` ("Done" / "Cancelled") · badge.
- **Preview:** S6's plain-text preview of the row's body (280 characters, one line, two below `md`).
- **Opening an item** (click, Enter, middle-click via `onAuxClick`, Cmd/Ctrl-click): the row turns read and the sidebar count drops at once in the query cache, `POST /api/inbox/:id/read` is fired without awaiting it, and the browser navigates (`message` → S6's session target; `mention` → `/tasks/T-42?comment=<id>`; `task_event` → `/tasks/T-42`). A failed call rolls the row and the count back; nothing else is shown.
- **Mark all read:** a ghost button in the page header, shown whenever the unread count is above 0 (it stays while the outcome line shows, so new arrivals can be marked too). On click the loaded rows turn read at once and the request carries `upTo` (the newest loaded item), so items arriving meanwhile stay unread. The outcome uses S4's `InlineOutcome` at the top of the page body (as the Agents page's archive undo does): "Marked 7 items as read." ("Marked 1 item as read.") + "Undo"; focus moves to Undo (`focusKey`). Undo restores exactly those items, clears the line and returns focus to "Mark all read" (or to the list's first row if the button is gone). Failures in the same line, alert tone: "Couldn't mark the items as read." + "Retry" (the rows revert), "Couldn't undo. Try again." + "Retry". The line stays until the user leaves the page or acts again.
- **Live:** `inbox_changed` refetches the newest page and the count (S6 merge by id, `overflow-anchor` scroll keeping). Reads in another tab update this one. New items are not announced on this page (the sidebar count is the signal; browser notifications cover a hidden tab).
- **Empty:** "Nothing in your inbox." (S1). Read items stay listed; there is no "all read" state.

### 3.1 The task badge (one component, reused)

`T-42 · Plan the billing migration`: the key in Geist Mono 13px ink, a muted " · ", the title in Geist 13px ink (plain text, never markdown), truncated with an ellipsis at the available width (the key never truncates). With no title known, the key alone. Inside an inbox row it is plain text (the whole row is the link). Elsewhere (session blocks, dependency lists) it is a link to the task: muted underline, signal on hover (S4's `FixLink` / `LINK_CLASS` style), accessible name "Task T-42: Plan the billing migration".

## 4. Home

The Inbox panel shows the **5 newest unread** items (`GET /api/inbox?unread=true&limit=5`) with the inbox row component and the same opening behaviour; when none, "Nothing unread." The panel's arrow link stays "Open inbox". The Agents panel is unchanged.

## 5. Tasks list (`/tasks`)

```
┌ PageHeader: Tasks ─────────────────────────────────── [+ New task] ┐
│ Status [Open and in progress ▾]  Assignee [Anyone ▾]  Created by [Anyone ▾] │
├────────────────────────────────────────────────────────────────────┤
│ T-42  Plan the billing migration          ◉ In progress  @dev      │
│       Blocked by T-41 · created by @or · updated 14:32             │
├────────────────────────────────────────────────────────────────────┤
│ T-41  Add usage export                    ○ Open         Unassigned│
│       created by @lead · updated Yesterday 09:10                   │
└────────────────────────────────────────────────────────────────────┘
```

- S3's agents-list pattern: a plain `<ul aria-label="Tasks">` in the page body, rows separated by 1px `rule`, each row **one link** to `/tasks/T-42`, `steel-hover`, instant, min 56px, two lines, S6's arrow-key row navigation:
  - line 1: key (mono, fixed 56px column so titles align), title (ink, plain text, truncates), then at the right status (icon + label, fixed width) and assignee (`@dev` mono, or muted "Unassigned"; an ended assignee: `@dev` muted with "· terminated" or "· archived" from `ended`);
  - line 2 (muted 13px): "Blocked by T-41" (marker icon, ink label) when blocked, "created by `@or`", "updated 14:32", separated by " · ".
  - Below `md`: line 1 is key and title; line 2 is status · assignee · blocked marker · updated ("created by" dropped).
- **Filters:** a toolbar row under the header, three S4 `NativeSelect`s (36px), each with a visible 13px muted label (`for`): **Status** (Open and in progress · Open · In progress · Done · Cancelled · All), **Assignee** (Anyone · Unassigned · each live agent `@slug`; an ended assignee only via the URL), **Created by** (Anyone · Me · each agent `@slug`; a human `@handle` works in the URL, shown as an extra option while selected). These selects only filter (no side effects), so changing on each arrow key is harmless. Values live in the URL (`/tasks?status=done&assignee=dev&creator=me`); changing a select updates the URL and the list, no Apply button. Below `md` the selects stack full-width.
- **Sort:** most recently updated first. **Paging:** 50 rows, then "Load more" (ghost, full width); a failed page shows "Couldn't load more tasks." + "Retry" in its place.
- **Live:** `tasks_changed` refetches the loaded pages and merges by key (React keys are task keys, so keyboard focus survives). Rows take their new order instantly, with no animation (DESIGN.md → Motion).
- **States:** first load: the route's pending mark. Empty on the **default** filter: "No open tasks." + a ghost link "Show all tasks" (`status=all`); when that view is empty too (no tasks at all): "No tasks yet." Empty with any other filter: "No tasks match these filters." + ghost "Clear filters" (shown only when a filter differs from its default). Error: S6's crimson line "Couldn't load tasks." + "Retry".
- **New task:** S4's header action pattern (ghost button with a `Plus` icon, label "New task", label `sr-only` below `md`), a link to `/tasks/new`.

## 6. Create page (`/tasks/new`)

A page, not a modal (long markdown bodies). S4's form layout (single column, max width 720px, labels above fields):

1. **Title** (`Input`, required).
2. **Description** (S4's `MarkdownEditor`, Write/Preview, optional).
3. **Assignee** (§8.1's picker; "Unassigned" first). Helper text: "Assigning sends the task to the agent's session right away." The create form uses a `NativeSelect`: nothing is sent until "Create task".
4. **Depends on** (§8.2).
5. **Links** (§8.3).
6. Buttons: primary "Create task" ("Creating…" while pending, disabled), ghost "Cancel" (back to `/tasks`, no confirmation: DESIGN.md never confirms routine actions).

**Validation** (DESIGN.md → Components → Validation, a longer form): each field validates when you leave it, never while you type, and everything is checked again on submit, which moves focus to the first invalid field. Errors appear below their field in crimson with an icon: "Enter a title.", "Keep the title to 200 characters or fewer.", "Keep the title on one line.", "Shorten the description to 64 KB or less.", plus §8.2's and §8.3's. Server field errors (the cycle sentence on Depends on) map to their field. On success: navigate to `/tasks/T-42`. A server error not tied to a field: S4's `role="alert"` line above the buttons, "Couldn't create the task. Try again."

## 7. Task detail (`/tasks/T-42`)

```
┌ PageHeader: ← Tasks / T-42 ──────────────────────────────────────────┐
│ Plan the billing migration          [Edit title]   │ Status   [In progress ▾]
│                                                     │ Assignee [@dev ▾]
│ (rendered markdown body)                            │   Blocked by T-41
│                              [Edit description]     │ Depends on
│ ─ Activity ─────────────────────────────────────    │   T-41 · Add usage export  ○ Open
│ @or created this task · 09:10                        │   [Edit dependencies]
│ @or assigned @dev · 09:10                            │ Blocks
│ ┌ @dev · Developer · 09:14 ────── [⧉] [Reply] ┐     │   T-43 · Ship invoices v2  Blocked
│ │ @or can you confirm we keep the old table?   │     │ Links
│ └───────────────────────────────────────────────┘    │   PR  github.com/acme/app/pull/12 ↗
│ @dev moved this to in progress · 09:15               │   File docs/plan.md
│ [composer: Write | Preview]            [Comment]    │   [Edit links]
│                                                     │ Created by @or · 20 Nov 09:10
└─────────────────────────────────────────────────────┴──────────────────────────────┘
```

- **Header:** `PageHeader`'s heading slot renders the key in Geist Mono at the page-title size (as agent pages render `AgentName`), with S4's back link "Tasks" before it. `document.title` "T-42 · Plan the billing migration · Open Factory".
- **Layout:** two columns from `lg` (main flexible, side 280px, 24px gap). Below `lg`, one column: title, then **Status, Assignee and the blocked marker**, then the body, then Depends on, Blocks, Links and Created by, then Activity.
- **Title:** an `<h2>` at the page-title role (Archivo 16/600, DESIGN.md hierarchy), plain text. A ghost "Edit" (`aria-label="Edit title"`) turns it into an `Input` with "Save"/"Cancel"; focus moves into the input; Enter saves, Escape cancels; after either, focus returns to the Edit button. Pending "Saving…"; failure keeps the input open with the text and shows "Couldn't save. Try again." under it; field errors as §6. A hint under the input when the task has a live assignee: "Saving sends the new title to @dev."
- **Body:** rendered through `Markdown`. A ghost "Edit" (`aria-label="Edit description"`) opens S4's `MarkdownEditor` in place with "Save" (primary) and "Cancel" (ghost); focus moves into the textarea; Escape does **not** cancel (it would discard a long draft); after Save or Cancel focus returns to the Edit button. Pending "Saving…"; failure keeps the editor open with the text: "Couldn't save. Try again." A hint under the editor when the task has a live assignee: "Saving sends the new description to @dev." Empty body: muted "No description." with a ghost "Add a description".
- **Side panel** (no card: rule-separated sections with 13px muted labels):
  - **Status** and **Assignee** apply immediately, so they are **menus, not native selects** (a focused native select changes on each arrow key on Windows and Linux, which here would assign and wake agents one after another). Each is a labelled trigger button ("Status: In progress" with a chevron; the accessible name includes the value) opening a `DropdownMenu` with a `DropdownMenuRadioGroup` (the sidebar Theme menu's pattern): arrow keys move, and only Enter, Space or a click commits. Status lists the four statuses with their icons; Assignee lists "Unassigned" and live agents (§8.1). An ended assignee shows above the trigger as "`@dev` · terminated" (or "· archived"), muted, and the trigger reads "Assignee: Choose an agent…". A commit applies at once (no Save) and appears in the activity; the polite announcer says "Status set to in progress", "Assigned to @dev" or "Unassigned". A failure reverts the trigger and shows the server's sentence under it in an alert region (e.g. "@x was terminated and can't be assigned tasks." when the agent ended after the page loaded).
  - The **blocked marker** sits under Assignee: "Blocked by T-41, T-44" (badges as links).
  - **Depends on / Blocks:** each a list of task badges (links) with the status icon and label; "Blocks" rows also show "Blocked" when the dependent is blocked. "Edit dependencies" (ghost) opens §8.2 inline with Save/Cancel (pending and failure as the body editor). "Blocks" is read-only (it is the other tasks' `depends_on`). Empty: "None" (muted).
  - **Links:** §8.3's display; "Edit links" (ghost) opens the editor inline with Save/Cancel.
  - **Created by** `@or` · `<time>`.
- **Activity** (`<ol aria-label="Activity">`, oldest first, 12px gaps):
  - **Comments** (`<article aria-label="Comment from @dev">`, `id="comment-<id>"`): S3's message block (1px `rule` edge, 6px radius, on the ground): sender line `@dev` (agent: link to its session in S6's underline style; human: plain mono), " · Developer" for agents, the time as plain text (`<time>`), a `CopyLink` icon button ("Copy link to this comment"; `CopyLink` gains `url` and `label` props), and a ghost **"Reply"** (`aria-label="Reply to @dev"`) that puts `@dev ` at the start of the composer (if not already there), focuses it and scrolls it into view (instant). Body through `Markdown`, long bodies clamped with S3's "Show all".
  - **History lines:** S3's `QuietLine` (muted 13px, icon `aria-hidden`), built from the structured history row, never from prose: "`@or` created this task", "`@or` assigned `@dev`", "`@lead` unassigned `@dev`", "`@dev` moved this to in progress", "`@or` marked this done", "`@or` cancelled this", "`@or` reopened this", "`@or` renamed this from “…”", "`@or` edited the description", "`@lead` changed the dependencies: added T-41, removed T-40", "`@lead` changed the links".
- **Composer** at the end of the activity: S4's `MarkdownEditor` (min height 96px) with "Comment" (primary, disabled while empty; "Posting…" while pending) and ⌘/Ctrl-Enter to submit. On failure the draft stays and "Couldn't post the comment. Try again." shows under the composer (alert). Helper line (muted 13px, `aria-describedby`), from the task's current data: "Goes to @dev and anyone you @mention." / "No assignee: only the people and agents you @mention are notified." After posting, when the result has `notReached`, one muted line under the new comment (polite status): "Not reached: @x (no such name), @y (matches more than one), @z (archived), @w (terminated), @me (reserved name), and 3 more (over 50 mentions)." (only the reasons present). The draft survives a refetch (local state), not a reload.
- **Mention prefill** (spec decision Q4): when the page opens with `?comment=<id>` and that comment's author is an **agent**, the composer starts as "`@author` " (only if it is empty), visible and editable, so the reply reaches the agent that asked. Nothing is prefilled otherwise.
- **Deep link `?comment=<id>`:** S3's behaviour: the page scrolls the comment to the centre once on load, gives it S3's highlight (`data-highlighted`, the 26% signal tint, instant, cleared when the user clicks elsewhere) and moves focus to it (`tabIndex=-1`) so keyboard users start there. An unknown comment id shows S3's muted line "Comment not found. Showing the task." at the top of the activity.
- **Live:** `tasks_changed` naming this key refetches the detail; the comment draft and any open editor keep the user's text (saving then overwrites: last write wins, spec §19; the activity shows both edits). New activity entries appear in place, not animated; a new comment by someone else is announced politely: "@dev commented".
- **Not found:** S4's `ResourceNotFound`, given a `detail` prop and `backTo="/tasks"` (its fixed "It may have been renamed or deleted." line is wrong for tasks, which are never deleted): "Task not found." / "No task T-999." / "Back to tasks".

## 8. Shared editors

### 8.1 Agent picker
Live agents as "`@slug` · Display name", sorted by display name (S4's order), spawned agents included (their " · ab12" tells them apart). A `NativeSelect` on the create form; radio items in the detail page's Assignee menu (§7).

### 8.2 Dependency editor
One text `Input` labelled "Depends on" taking keys separated by commas or spaces ("T-41, T-44"), helper text "Task keys, like T-41." On leave, the keys are resolved in **one** request (`GET /api/tasks?keys=T-41,T-44`) and shown below as badges with status. Errors: "Use task keys, like T-41.", "No task T-99.", "A task can't depend on itself.", "A task can depend on at most 50 tasks.", and the server's cycle sentence on save. (A searchable combobox would be a new component for a field filled a few times a day; keys are what agents and humans already write.)

### 8.3 Link editor and display
- **Display:** a list; each row a kind label (13px muted, fixed width: "PR", "URL", "File", "Agent") and the target: `url`/`pr` as an external link (the markdown link style with the `ArrowUpRight` icon and the shared "Opens in a new tab" description), showing the link's `title` (plain text) or the URL without its scheme; `agent` as the `@slug` session link (ended: muted "· terminated" / "· archived"); `file` as mono text, not a link.
- **Editor:** rows of [kind `NativeSelect`] [target `Input`] [title `Input`, optional] [ghost icon button "Remove link"], and "Add link" (ghost). Validation on leave: "Links must be http(s) URLs." (url/pr), "No agent @x." (agent), "Keep the path on one line." (file). Removing a row is immediate (nothing is saved until Save).

## 9. Session additions

### 9.1 Task messages in the timeline
`task_assigned`, `task_comment` and `task_update` envelopes render as S3/S6 message blocks (`MessageBlock` gains a `badge` prop) with:
- **Sender line:** `task_comment`: the author as S6 renders senders (agent link or human handle); `task_assigned`/`task_update`: "Factory" (S5's factory sender). Then the task badge (§3.1, a link: `task_comment` → `/tasks/T-42?comment=<commentId>`, others → `/tasks/T-42`) from `taskKey` and `taskTitle`.
- **Body:** as the agent saw it, through `Markdown` (the quoted brief renders as a blockquote), clamped with S3's "Show all".
- No new colours or edges: the badge is what marks a task message.
- Pending task messages show in S3's dashed "Not delivered yet" block with the badge (the queue item carries `taskKey` and `taskTitle`).

### 9.2 Agent strip
A segment after S6's org segment: "3 open tasks" (singular "1 open task"; the count includes in-progress tasks), a link to `/tasks?assignee=<slug>`, muted 13px with S6's link underline; hidden at 0; refetched on `tasks_changed`. Outside the `role="status"` region.

## 10. Browser notifications (the plan's last, separable task)

- **Switch:** in the sidebar user menu under Theme, a `DropdownMenuCheckboxItem` "Browser notifications" whose `onSelect` calls `preventDefault()` so the menu stays open and its description line is seen. Turning it on calls `Notification.requestPermission()` from the click. Granted: on, stored per browser (`localStorage` `of-notifications`). Denied or dismissed: stays off, with the description "Blocked by your browser. Allow notifications for this site to turn them on." A permission revoked later in the browser reads as off. Unsupported browser: the item is absent.
- **When:** the tab is hidden and a refetch shows an unread item not seen before in this tab: one notification, title by kind ("@dev mentioned you on T-42", "T-40 is done", "T-40 was cancelled", "@dev messaged you", "@dev messaged @humans", "Factory about @ops"), body the plain-text preview capped at 120 characters, `tag` = the item id (several open tabs collapse into one), the favicon as icon. Never while the tab is visible. Clicking: focuses the window, marks the item read and opens its target (our own deep link only).

## 11. Accessibility

- The task list and inbox are `<ul>`s with `aria-label` ("Tasks", "Inbox"); each row is one link whose accessible name is complete: "T-42, Plan the billing migration, In progress, blocked by T-41, assigned to @dev" and "Unread, @dev mentioned you on T-42 Plan the billing migration, 14:32" (preview via `aria-describedby`, as S6).
- Status icons are `aria-hidden`; the label carries the status.
- Immediate-apply controls are labelled menu triggers whose names include the value; results are announced (§7); errors go to an alert region.
- Every Edit, Reply and Copy button names its target ("Edit title", "Edit description", "Reply to @dev", "Copy link to this comment").
- Focus: into an editor on open, back to its Edit button on save or cancel; to Undo after Mark all read; to the deep-linked comment on load.
- The activity is an `<ol>`; comments are `<article>`s.
- The composer's helper text is attached with `aria-describedby`; "Not reached" is a polite status.

## 12. Responsive

Below `md`: list rows as §5; filters stack; the detail page is one column (§7); link editor rows wrap their title input under the target; the composer's buttons stay right-aligned; the "New task" label is `sr-only`. Content gutters 16px (DESIGN.md).

## 13. Components

`apps/web/src/features/tasks/`: `api.ts`, `TaskBadge`, `StatusLabel`, `StatusMenu`, `AssigneeMenu`, `TaskList`, `TaskFilters`, `TaskForm` (create), `TaskDetail`, `TaskActivity`, `CommentBlock`, `CommentComposer`, `DependencyEditor`, `LinkEditor`, `LinkList`, `AgentPicker`. `apps/web/src/features/inbox/`: `InboxList` (read state, kinds), `InboxRow` (shared with Home), `MarkAllRead` (with `InlineOutcome`), `useUnreadCount`, `notifications.ts`. Routes: `routes/_app/tasks.index.tsx`, `tasks.new.tsx`, `tasks.$key.tsx` (`validateSearch` for `comment`), the existing `inbox.tsx` and `index.tsx`. Changed shared pieces: `MessageBlock` (`badge`), `AgentStrip` (tasks segment), `CopyLink` (`url`, `label`), `ResourceNotFound` (`detail`, `backTo`), `AppSidebar` (count; notifications switch in the user menu).

## 14. Fixed strings

"Mark all read", "Marked 7 items as read.", "Marked 1 item as read.", "Undo", "Couldn't mark the items as read.", "Couldn't undo. Try again.", "Retry", "Nothing unread.", "mentioned you", "mentioned @humans", "Unread", "Inbox, 3 unread", "Inbox · 3 unread", "New task", "No open tasks.", "Show all tasks", "No tasks yet.", "No tasks match these filters.", "Clear filters", "Couldn't load tasks.", "Couldn't load more tasks.", "Load more", "Status", "Open and in progress", "Open", "In progress", "Done", "Cancelled", "All", "Anyone", "Me", "Unassigned", "Blocked", "Blocked by T-41", "created by", "updated", "Title", "Description", "Assignee", "Choose an agent…", "Depends on", "Blocks", "Links", "Created by", "Create task", "Creating…", "Couldn't create the task. Try again.", "Cancel", "Save", "Saving…", "Couldn't save. Try again.", "Edit", "Edit title", "Edit description", "Add a description", "No description.", "None", "Edit dependencies", "Edit links", "Add link", "Remove link", "PR", "URL", "File", "Agent", "Task keys, like T-41.", "Use task keys, like T-41.", "A task can't depend on itself.", "A task can depend on at most 50 tasks.", "Assigning sends the task to the agent's session right away.", "Saving sends the new title to @dev.", "Saving sends the new description to @dev.", "Enter a title.", "Keep the title to 200 characters or fewer.", "Keep the title on one line.", "Shorten the description to 64 KB or less.", "Links must be http(s) URLs.", "No task T-99.", "No agent @x.", "Keep the path on one line.", "Activity", "Reply", "Reply to @dev", "Copy link to this comment", "Comment", "Posting…", "Couldn't post the comment. Try again.", "Goes to @dev and anyone you @mention.", "No assignee: only the people and agents you @mention are notified.", "Not reached:", "no such name", "matches more than one", "archived", "terminated", "reserved name", "over 50 mentions", "Comment not found. Showing the task.", "Task not found.", "No task T-999.", "Back to tasks", "@dev commented", "Status set to in progress", "Assigned to @dev", "created this task", "assigned", "unassigned", "moved this to in progress", "marked this done", "cancelled this", "reopened this", "renamed this from", "edited the description", "changed the dependencies", "changed the links", "3 open tasks", "1 open task", "Browser notifications", "Blocked by your browser. Allow notifications for this site to turn them on.", "@dev mentioned you on T-42", "T-40 is done", "T-40 was cancelled", "@dev messaged you", "@dev messaged @humans".
