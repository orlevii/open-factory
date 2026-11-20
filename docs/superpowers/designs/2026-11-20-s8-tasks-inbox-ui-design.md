# S8 Tasks and inbox: UI Design

- **Date:** 2026-11-20
- **Status:** approved by owner-proxy (owner-s8); pending the impeccable review against DESIGN.md
- **Spec:** [`docs/superpowers/specs/2026-11-20-s8-tasks-inbox-design.md`](../specs/2026-11-20-s8-tasks-inbox-design.md)
- **Extends:** [S3 session UI](2026-11-18-s3-session-ui-design.md), [S4 templates, agents and settings UI](2026-11-19-s4-templates-agents-settings-ui-design.md), [S5 supervisor UI](2026-11-19-s5-supervisor-ui-design.md), [S6 messaging UI](2026-11-19-s6-messaging-ui-design.md), [S7 spawning UI](2026-11-19-s7-spawning-ui-design.md). Everything not mentioned here stays as they define it.
- **Design system:** `DESIGN.md` (Sawtooth). Where this doc and DESIGN.md disagree, DESIGN.md wins.

## 1. What changes

The Tasks page stops being an empty state: a dense list, a create page and a detail page. The Inbox gains read state, mentions and task events, and the sidebar shows how many items are unread. Home's Inbox panel shows what's unread. In a session, task messages carry a badge that opens the task, and the agent strip links to the agent's open tasks. All data comes from the spec's §9–§12 fields; **the UI never parses prose** (a task message is recognised by its `kind`, `taskKey` and `fact`).

**Terms.** "Task" and its key `T-42` (Geist Mono: a key is an identifier). Statuses are written "Open", "In progress", "Done", "Cancelled"; "Blocked" is not a status but a marker ("Blocked by T-41"). "Assignee", "Created by". "Comment" (noun and verb). "Mention" only in the inbox. Agents are `@slug`, humans `@handle`, both mono (S6). Spawned agents per PRODUCT.md. Past times use S6's `formatInboxTime` (`14:32`, `Yesterday 14:32`, `27 Nov 09:10`) in a `<time>` with the full timestamp as `title`.

**Status presentation** (Status Is Never Colour Alone): an icon plus the label, no coloured pills, no orange (a task status is not "live"):

| Status | Icon (lucide, `aria-hidden`) | Colour |
|---|---|---|
| Open | `Circle` | muted |
| In progress | `CircleDot` | ink |
| Done | `CircleCheck` | `success` icon, ink label |
| Cancelled | `CircleSlash` | muted icon and label |
| Blocked marker | `CircleMinus` | `warning` icon, ink label "Blocked by T-41" |

## 2. Sidebar

- The Inbox row shows the unread count at its right edge: Geist 12px tabular figures, `ink-muted`, no fill, no orange, "99+" above 99, nothing at 0. Accessible name "Inbox, 3 unread". In the collapsed icon rail, a 6px **ink** dot at the icon's top right when anything is unread (the label carries the count in the tooltip: "Inbox · 3 unread").
- The count comes from `GET /api/inbox/unread-count`, refetched on `inbox_changed`; it changes in place (no animation).

## 3. Inbox page (`/inbox`)

S6's list, extended. Nothing S6 built is undone.

```
┌ PageHeader: Inbox ─────────────────────────────── [Mark all read] ┐
│ ● @dev mentioned you on T-42 · Plan the billing migration   14:32 │
│   @or can you confirm we keep the old invoices table for…         │
├────────────────────────────────────────────────────────────────────┤
│ ● Factory: T-40 · Add usage export is done                 13:05  │
│   @dev marked T-40 done.                                          │
├────────────────────────────────────────────────────────────────────┤
│   @dev → @humans                                     Yesterday 09:10│
│   Can someone approve the migration plan? It drops the…           │
└────────────────────────────────────────────────────────────────────┘
```

- **Rows** stay one link each, two lines, min 56px, `steel-hover` on hover, instant (S6).
- **Unread:** a 6px dot in **ink** (`graphite-ink` / `night-text`), in a fixed 12px slot at the row's left so read and unread rows align; the sender line in medium weight (500). Read rows: an empty slot, regular weight. The row's accessible name starts with "Unread, " when unread (the dot is `aria-hidden`).
- **Sender line by kind:**
  - `message` (S6): unchanged: "`@dev` → `@humans`" or "Factory about `@ops`".
  - `mention`: "`@dev` mentioned you on" + the task badge (§3.1); for `@humans`: "`@dev` mentioned `@humans` on" + badge. A human author is `@alice` (mono, like agents).
  - `task_event`: "Factory:" + badge + "is done" / "was cancelled".
- **Preview:** S6's plain-text preview of the row's body (280 characters, one line, two below `md`).
- **Click:** marks the item read (`POST /api/inbox/:id/read`, fired and not awaited: navigation never waits for it; a failure leaves the item unread and nothing else is shown), then navigates: `message` → S6's session target; `mention` → `/tasks/T-42?comment=<id>`; `task_event` → `/tasks/T-42`. Cmd/Ctrl-click and middle-click open a new tab and also mark it read.
- **Mark all read:** a ghost button in the page header, shown only while the unread count is above 0. On click the rows turn read at once; an inline line replaces the button: "Marked 7 as read." + ghost "Undo" (DESIGN.md: forgiveness over confirmation). Undo restores exactly those items. The line stays until the user leaves the page or marks something else; it is `role="status"` (polite). A failure restores the previous state and shows "Couldn't mark them as read." with "Retry" in the same place.
- **Live:** `inbox_changed` refetches the newest page and the count (S6 merge by id, `overflow-anchor` scroll keeping). Reads in another tab update this one. New items are not announced on this page (the count in the sidebar is the signal; browser notifications cover a hidden tab).
- **Empty:** "Nothing in your inbox." (S1). There is no "all read" state: read items stay listed.

### 3.1 The task badge (one component, reused)

`T-42 · Plan the billing migration`: the key in Geist Mono 13px ink, a muted " · ", the title in Geist 13px ink, truncated with an ellipsis at the available width (the key never truncates). Inside an inbox row it is plain text (the whole row is the link). Elsewhere (session blocks, dependency lists) it is a link to the task: underline in muted, signal on hover (S4's `FixLink` style), accessible name "Task T-42: Plan the billing migration".

## 4. Home

The Inbox panel shows the **5 newest unread** items with the inbox row component (same click behaviour); when none, "Nothing unread." The panel's arrow link stays "Open inbox". The Agents panel is unchanged.

## 5. Tasks list (`/tasks`)

```
┌ PageHeader: Tasks ──────────────────────────────────── [New task] ┐
│ Status [Open and in progress ▾]  Assignee [Anyone ▾]  Created by [Anyone ▾] │
├────────────────────────────────────────────────────────────────────┤
│ T-42  Plan the billing migration          ◉ In progress  @dev      │
│       Blocked by T-41 · created by @or · updated 14:32             │
├────────────────────────────────────────────────────────────────────┤
│ T-41  Add usage export                    ○ Open         Unassigned│
│       created by @lead · updated Yesterday 09:10                   │
└────────────────────────────────────────────────────────────────────┘
```

- S3's agents-list pattern: a plain `<ul>` in the page body, rows separated by 1px `rule`, each row **one link** to `/tasks/T-42`, `steel-hover`, instant, min 56px, two lines:
  - line 1: key (mono, fixed 56px column so titles align), title (ink, truncates), then at the right status (icon + label, fixed width) and assignee (`@dev` mono, or muted "Unassigned"; an ended assignee: `@dev` in muted with "· terminated" / "· archived");
  - line 2 (muted 13px): "Blocked by T-41" (marker icon, ink label) when blocked, "created by `@or`", "updated 14:32". Separated by " · ".
- **Filters:** a toolbar row under the header, three `NativeSelect`s (S4's component, 32px), each with a visible label (13px muted, `for`): Status (Open and in progress · Open · In progress · Done · Cancelled · All), Assignee (Anyone · Unassigned · each live agent by `@slug`, ended assignees only via the URL), Created by (Anyone · each human `@handle` · each agent `@slug`). Values live in the URL (`/tasks?status=done&assignee=dev`), so a filtered view can be shared and the back button works; changing a select updates the URL and the list (no Apply button). Below `md` the selects stack full-width.
- **Sort:** most recently updated first. **Paging:** 50 rows, then "Load more" (ghost, full width); a failed page shows "Couldn't load more tasks." + "Retry" in its place.
- **Live:** `tasks_changed` refetches the loaded pages and merges by key (keyboard focus survives, React keys are task keys). Rows take their new order on refetch, instantly, with no animation (DESIGN.md → Motion: no list animations on live updates).
- **States:** first load: the route's pending mark; empty with the default filter and no tasks at all: "No tasks yet." with the "New task" button in the header; empty with filters: "No tasks match these filters." + ghost "Clear filters"; error: S6's crimson line "Couldn't load tasks." + "Retry".
- **New task:** primary button in the page header ("New task"), a link to `/tasks/new`.

## 6. Create page (`/tasks/new`)

A page, not a modal (long markdown bodies). S4's form layout (single column, max width 720px, labels above fields):

1. **Title** (`Input`, required).
2. **Description** (S4's `MarkdownEditor`, Write/Preview, optional).
3. **Assignee** (`NativeSelect`: "Unassigned" + live agents as "`@dev` · Developer"; ended agents never listed). Helper text: "Assigning sends the task to the agent's session right away."
4. **Depends on** (§8.2's dependency editor).
5. **Links** (§8.3's link editor).
6. Buttons: primary "Create task", ghost "Cancel" (back to `/tasks`, no confirmation: DESIGN.md never confirms routine actions).

**Validation** (DESIGN.md → Components → Validation, a longer form): each field validates when you leave it, never while you type, and everything is checked again on submit, which moves focus to the first invalid field. Errors appear below their field in crimson with an icon: "Enter a title.", "Keep the title under 200 characters.", "Keep the title on one line.", "The description is over 64 KB.", "Links must be http(s) URLs.", "No task T-99.", "T-41 already depends on T-42 (through T-43); that would make a cycle." (the server's sentence, mapped to the field). On success: navigate to `/tasks/T-42`. A server error not tied to a field: one crimson line above the buttons.

## 7. Task detail (`/tasks/T-42`)

```
┌ PageHeader: T-42 ───────────────────────────────────────────────────┐
│ Plan the billing migration                  [Edit]  │ Status   [In progress ▾]
│                                                     │ Assignee [@dev ▾]
│ (rendered markdown body)                            │ Depends on
│                                       [Edit]        │   T-41 · Add usage export  ○ Open
│ ─ Activity ─────────────────────────────────────    │   [Edit dependencies]
│ @or created this task · 09:10                        │ Blocks
│ @or assigned @dev · 09:10                            │   T-43 · Ship invoices v2  Blocked
│ ┌ @dev · 09:14 ───────────────────────── [Reply] ┐  │ Links
│ │ @or can you confirm we keep the old table?     │  │   PR  github.com/acme/app/pull/12 ↗
│ └────────────────────────────────────────────────┘  │   File docs/plan.md
│ @dev moved this to In progress · 09:15               │   [Edit links]
│ [composer: Write | Preview]           [Comment]     │ Created by @or · 20 Nov 09:10
└──────────────────────────────────────────────────────┴──────────────────────────────┘
```

- **Header:** the `PageHeader` title is the key ("T-42", Archivo 16/600 per DESIGN.md; the key is in Archivo here because it is the page title), `document.title` "T-42 · Plan the billing migration · Open Factory". A back link "Tasks" in S4's header position.
- **Layout:** two columns from `lg` (main flexible, side 280px, 24px gap), one column below `lg` with the side panel's fields placed **between the title and the body** (status and assignee first), so the most-changed controls stay near the top on a phone.
- **Title:** an `<h2>` in Archivo 20/650 (markdown h1 scale) as plain text. "Edit" (ghost, small) turns it into an `Input` with Save/Cancel; Enter saves, Escape cancels (keyboard: no animation). Errors as §6.
- **Body:** rendered through `Markdown`. "Edit" opens S4's `MarkdownEditor` in place with "Save" (primary) and "Cancel" (ghost); while editing, a muted line under the editor says "Saving sends the new description to @dev." when the task has a live assignee other than you (it is what happens, spec §7.1). Empty: muted "No description." with "Add a description" (ghost).
- **Side panel** (no card: rule-separated sections with 13px muted labels, DESIGN.md's density):
  - **Status:** a `NativeSelect` with the four statuses; a change applies at once (no Save) and appears in the activity. Blocked tasks show the marker under it: "Blocked by T-41, T-44" (badges as links).
  - **Assignee:** a `NativeSelect` ("Unassigned" + live agents); applies at once. An ended assignee shows as "`@dev` · terminated" (muted) above the select, whose value is then "Choose an agent…".
  - **Depends on / Blocks:** each a list of task badges (links) with the status icon and label; "Blocks" rows also show "Blocked" when the dependent is blocked. "Edit dependencies" (ghost) opens §8.2 inline. "Blocks" is read-only here (it is the other tasks' `depends_on`). Empty: "None" (muted).
  - **Links:** §8.3's display; "Edit links" (ghost) opens the editor inline.
  - **Created by** `@or` · `<time>`.
  - A failed immediate change reverts the control and shows one crimson line under it with the server's sentence (for example "@x was terminated and can't be assigned tasks." when the agent ended after the page loaded).
- **Activity** (`<ol aria-label="Activity">`, oldest first, 12px gaps):
  - **Comments:** S3's message block (1px `rule` edge, 6px radius, on the ground): sender line `@dev` (agent: link to its session with S6's underline style; human: plain mono), " · " display name for agents, time (a `<time>`, and the comment's own deep link: a `CopyLink` like S3's, "Copy link to this comment"); body through `Markdown`; long bodies clamp with S3's "Show all". A ghost **"Reply"** button in the sender line's right edge: puts `@author ` at the start of the composer (if not already there), focuses it, and scrolls it into view (instant). Each comment has `id="comment-<id>"`.
  - **History lines:** S3's `QuietLine` (muted 13px, icon `aria-hidden`): "`@or` created this task", "`@or` assigned `@dev`", "`@lead` unassigned `@dev`", "`@dev` moved this to In progress", "`@or` marked this Done", "`@or` cancelled this", "`@or` reopened this", "`@or` renamed this from "…"", "`@or` edited the description", "`@lead` changed the dependencies: added T-41, removed T-40", "`@lead` changed the links". Built from the structured history row, never from prose.
- **Composer** at the end of the activity: S4's `MarkdownEditor` (min height 96px) with "Comment" (primary, disabled while empty) and ⌘/Ctrl-Enter to submit. Helper line (muted 13px), from the server's current data: "Goes to @dev and anyone you @mention." / "Unassigned: only people and agents you @mention see it." After posting, the result's `notReached` shows one muted line under the new comment: "Not reached: @unknown (no such name), @qa-x1 (terminated)." The draft survives a refetch (local state), not a reload.
- **Mention prefill** (spec decision Q4): when the page opens with `?comment=<id>` and that comment's author is an **agent**, the composer starts as "`@author` " (only if it is empty), visible and editable, so the reply reaches the agent that asked. Nothing is prefilled otherwise.
- **Deep link `?comment=<id>`:** S3's deep-link behaviour: the page scrolls the comment to the centre once on load and gives it S3's highlight (`data-highlighted`, the instant tint, no animation, cleared when the user clicks elsewhere). An unknown comment id shows S3's muted line "Comment not found. Showing the task." at the top of the activity.
- **Live:** `tasks_changed` naming this key refetches the detail; the comment draft and an open title or body editor keep the user's text (saving then overwrites: last write wins, spec §19, and the activity shows both edits). New activity entries appear in place; not announced, except a new comment by someone else, which S3's polite announcer reads as "@dev commented".
- **Not found:** `/tasks/T-999` renders S1's not-found state ("No task T-999." + "Go to Tasks").

## 8. Shared editors

### 8.1 Agent picker
A `NativeSelect` of live agents, "`@slug` · Display name", sorted by display name (S4's order), spawned agents included (their " · ab12" tells them apart).

### 8.2 Dependency editor
One text `Input` labelled "Depends on" taking keys separated by commas or spaces ("T-41, T-44"), with helper text "Task keys, like T-41." On leave, each key is resolved (`GET /api/tasks/:key`) and shown below as badges with status; an unknown key is a field error ("No task T-99."). In the detail page: "Save" / "Cancel" ghost pair. Rationale: a searchable combobox would be a new component for a field filled a few times a day; keys are what agents and humans already write.

### 8.3 Link editor and display
- **Display:** a list; each row a kind label (13px muted, fixed width: "PR", "URL", "File", "Agent") and the target: `url`/`pr` as an external link (S1 markdown link style with the `ArrowUpRight` icon and the shared "Opens in a new tab" description), showing the link's `title` or the URL without its scheme; `agent` as the `@slug` session link (ended: muted "· terminated"); `file` as mono text, not a link, with S3's `CopyLink` to copy the path.
- **Editor:** rows of [kind `NativeSelect`] [target `Input`] [title `Input`, optional] [remove: ghost icon button "Remove link"], and "Add link" (ghost). Validation on leave: "Links must be http(s) URLs." (url/pr), "No agent named 'x'." (agent), "Keep it on one line." (file). Removing a row is immediate with no undo inside the editor (nothing is saved until Save).

## 9. Session additions

### 9.1 Task messages in the timeline
`task_assigned`, `task_comment` and `task_update` envelopes render as S3/S6 message blocks with:
- **Sender line:** `task_comment`: the author as S6 renders senders (agent link or human handle); `task_assigned`/`task_update`: "Factory" (S5's factory sender). Then the task badge (§3.1, a link: `task_comment` → `/tasks/T-42?comment=<commentId>`, others → `/tasks/T-42`) using `taskKey` and `taskTitle` from the event.
- **Body:** as the agent saw it, through `Markdown` (the quoted brief renders as a blockquote), clamped with S3's "Show all".
- No new colours or edges: the badge is what marks a task message.
- Pending task messages show in S3's dashed "Not delivered yet" block with the badge.

### 9.2 Agent strip
A segment after S6's org segment: "3 open tasks" (singular "1 open task"), a link to `/tasks?assignee=<slug>`, muted 13px with S6's link underline; hidden at 0. Outside the `role="status"` region.

## 10. Browser notifications (the plan's last, separable task)

- **Switch:** in the sidebar user menu under Theme, a `DropdownMenuCheckboxItem` "Browser notifications". Turning it on calls `Notification.requestPermission()` (from the click, as browsers require). Granted: on, stored per browser (`localStorage` `of-notifications`). Denied or dismissed: stays off, and the item's description line says "Blocked by your browser. Allow notifications for this site to turn them on." Unsupported: the item is absent.
- **When:** the tab is hidden and a refetch shows an unread item not seen before in this tab: one notification, title "@dev mentioned you on T-42" / "T-40 is done" / "@dev messaged @humans", body the plain-text preview capped at 120 characters, `tag` = the item id (several open tabs collapse into one), the favicon as icon. Never while the tab is visible. Clicking: focuses the window, marks the item read, opens its target.

## 11. Accessibility

- The task list and inbox are `<ul>`s with `aria-label` ("Tasks", "Inbox"); each row is one link whose accessible name is complete: "T-42, Plan the billing migration, In progress, blocked by T-41, assigned to @dev" and "Unread, @dev mentioned you on T-42 Plan the billing migration, 14:32" (preview via `aria-describedby`, as S6).
- Status icons are `aria-hidden`; the label carries the status.
- Every immediate-apply control (status, assignee) has a visible label; its change is announced by S3's polite announcer ("Status set to In progress").
- The activity is an `<ol>`; comments are `<article aria-label="Comment from @dev">`; the highlighted comment receives focus (`tabIndex=-1`) after the scroll so keyboard users start there.
- Mark all read's result line is `role="status"`; Undo is reachable by Tab right after it.
- The composer's helper text is attached with `aria-describedby`.

## 12. Responsive

Below `md`: list rows keep two lines with the status and assignee moving to line 2 ("◉ In progress · @dev · Blocked by T-41"); filters stack; the detail page is one column (§7); link editor rows wrap their title input under the target; the composer's buttons stay right-aligned. Content gutters 16px (DESIGN.md).

## 13. Components

`apps/web/src/features/tasks/`: `api.ts`, `TaskBadge`, `StatusLabel`, `TaskList`, `TaskFilters`, `TaskForm` (create), `TaskDetail`, `TaskActivity`, `CommentBlock`, `CommentComposer`, `DependencyEditor`, `LinkEditor`, `LinkList`, `AgentPicker`. `apps/web/src/features/inbox/`: `InboxList` (read state, kinds), `InboxRow` (shared with Home), `MarkAllRead`, `useUnreadCount`, `notifications.ts`. Routes: `routes/_app/tasks.index.tsx`, `tasks.new.tsx`, `tasks.$key.tsx` (`validateSearch` for `comment`), the existing `inbox.tsx` and `index.tsx`. Session: `MessageBlock` (task badge), `AgentStrip` (tasks segment). Sidebar: `AppSidebar` (count), user menu (notifications switch).

## 14. Fixed strings

"Mark all read", "Marked 7 as read.", "Undo", "Couldn't mark them as read.", "Nothing unread.", "mentioned you on", "mentioned @humans on", "is done", "was cancelled", "Unread", "Inbox, 3 unread", "New task", "No tasks yet.", "No tasks match these filters.", "Clear filters", "Couldn't load tasks.", "Couldn't load more tasks.", "Load more", "Open and in progress", "Open", "In progress", "Done", "Cancelled", "All", "Anyone", "Unassigned", "Blocked by T-41", "created by", "updated", "Title", "Description", "Assignee", "Depends on", "Blocks", "Links", "Created by", "Create task", "Cancel", "Save", "Edit", "Add a description", "No description.", "None", "Edit dependencies", "Edit links", "Add link", "Remove link", "Task keys, like T-41.", "Assigning sends the task to the agent's session right away.", "Saving sends the new description to @dev.", "Enter a title.", "Keep the title under 200 characters.", "Keep the title on one line.", "The description is over 64 KB.", "Links must be http(s) URLs.", "No task T-99.", "No agent named 'x'.", "Keep it on one line.", "Activity", "Reply", "Comment", "Goes to @dev and anyone you @mention.", "Unassigned: only people and agents you @mention see it.", "Not reached:", "Comment not found. Showing the task.", "No task T-999.", "Go to Tasks", "@dev commented", "Status set to In progress", "created this task", "assigned", "unassigned", "moved this to In progress", "marked this Done", "cancelled this", "reopened this", "renamed this from", "edited the description", "changed the dependencies", "changed the links", "3 open tasks", "1 open task", "Browser notifications", "Blocked by your browser. Allow notifications for this site to turn them on.", "Copy link to this comment", "terminated", "archived".
