# U4 create flows and mobile: Technical Design

- **Date:** 2026-11-22
- **Status:** draft for review. The owner-proxy (owner-u4) answered Q1–Q21. Low certainty, for Or: Q1 (3), Q4 (3), Q7 toast position (2), Q9 (3), Q13 (3).
- **Source of truth (gitignored, read from the main checkout):** `docs/product/ui-review/decisions.md` (decisions 1, 3, 14, 22, 23 bind here), `docs/product/ui-review/status.md` (U4 rows 1–4 and the "Not owned" items decision 14 gives U4), the seven reviews in `docs/product/ui-review/` (apple-design A2, A3, A6, C1, C3; taste T-H6, T-M6, T-M7, T-M8, T-L3; paperclip H6, M2; emil H4, M4, M6; break-ui M1, M2, M5, M6, M7, L5 and "Redesign 5"), `docs/product/behavior/*.md`.
- **Builds on:** U1 (#77: adaptive `Sheet`, Vaul `Drawer`, adaptive `ConfirmDialog`, the control system, `data-instant`), U2 (#89: `AgentCombobox`, `AgentAvatar`, `AgentMenu`, Agent details, the shortcut layer, the one-line session header, the task peek), U3 (#103: the shared `Composer`, `RowMenu`, `StopButton`). Stacked on `u3/5-shared-composer` (PR #117).
- **Inputs from other issues:** #107 (mobile composer and row long-press, from U3 Q25), #102 line "`/agents` overflows horizontally at 390px".
- **Decision log:** GitHub issue "U4: create flows and mobile — design"; Q1–Q21 are the proxy's answers, D1–D9 tech-lead decisions.

> `docs/product/` is gitignored. Paths into it are relative to the main checkout. Web paths are relative to `apps/web/src/` unless they start with `apps/` or `packages/`.

## 1. Goal

1. Every create and edit form opens in a sheet over the page you are on: New agent, Edit agent, New task, New schedule, Edit schedule, New template (decision 1). Nothing navigates away to fill in a form.
2. A fresh factory can create its first agent without leaving the New agent sheet: a missing credential, template, project or template secret is set up in a stacked sheet and selected on return (paperclip H6).
3. Outcomes whose control is gone are reported by a toast, with Undo where the server allows it (decisions 3 and 22, Sonner).
4. Phones get a touch layout: row and header menus as bottom drawers, long-press as an accelerator, 40px hit areas, a messaging-style composer, and no horizontal overflow at 320–390px.
5. The template editor highlights YAML, JSON and markdown with line numbers and validator markers (CodeMirror 6, decision 23), or keeps the textarea if the real-browser checks say so.
6. Close the break-ui leftovers decision 14 gives U4 (M5, M6, L5) and the phone rows (M1, M7, #102).

## 2. Acceptance criteria

All run in default CI (`pnpm test`, `pnpm typecheck`, `pnpm lint`) unless marked manual (headless-browser evidence pass, §15).

1. **Sheets everywhere.** `grep -rn 'to="/agents/new"\|to="/tasks/new"\|to="/schedules/new"\|to="/templates/new"\|"/agents/$slug/edit"\|to="/schedules/$key"' apps/web/src --include=*.tsx` (tests excluded) finds no link: every in-app entry point calls `openSheet` (§5.3). The six legacy URLs still work from outside the app (an address bar, a link in an agent message) and land on the list or session with the sheet open (§5.4). Tests cover each entry point and each redirect.
2. **A sheet belongs to its page.** A sheet stays open across re-renders and data refetches, closes when the pathname changes, and reopening the same kind shows the typed draft (§5.5). Successful submit clears the draft. Sign-out clears every draft.
3. **First agent with nothing set up.** On a factory with no credential and no template, the Agents empty state's "Create your first agent" opens the New agent sheet; the user creates a template, adds and verifies a credential, and creates the agent, without the parent sheet unmounting and without leaving the page (test with mocked API; manual evidence).
4. **Slug.** Typing "Priya Nair" shows "Address @priya-nair"; with `priya-nair` taken it shows `@priya-nair-2` before submit; "Change" reveals the slug input; a name that derives an empty or invalid slug opens the slug input with its error (unit tests on `deriveSlug`, component tests on the line).
5. **Toasts.** Exactly the outcomes in §10.2 toast; no other code path calls `notify`. Undo on Archive and on schedule Delete restores (tests); a failed Undo toasts the server's message. Desktop toasts never cover the sidebar footer or the composer's Send (manual at 1440 and 1024, sidebar expanded and collapsed).
6. **Schedules.** Picking "Weekdays 09:00" writes `0 9 * * 1-5` and the summary reads "Weekdays at 09:00 (Europe/Berlin)" with the zone the next-runs preview uses; a cron no rule describes shows only the next-runs preview (unit tests on `describeCron`).
7. **Mobile menus.** Below 48rem every row menu and the session header menu render as a bottom drawer with 44px items; at 48rem and above they are dropdowns (tests flip `matchMedia`). Long-press (500ms, touch only) on a list row or on a timeline row's chrome opens its menu; on prose it does nothing and text selection works (tests with fake timers and pointer events; manual on WebKit and Chromium touch emulation).
8. **Hit areas.** On a coarse pointer every standalone control has a hit box of at least 40×40px (a test walks the rendered buttons in a sheet, the composer, the page header and a row, asserting the class contract; manual measurement in the evidence pass).
9. **No sideways page on phones.** `/agents` (214 agents, 14-level chain), `/templates`, `/tasks` with a 25-blocker task, every sheet, and a session with the composer open have `scrollWidth <= clientWidth` at 320 and 390 and at 200% text (manual evidence, scripted probe).
10. **Template editor.** Either CodeMirror passes all five decision-23 checks (§12.6) and replaces `CodeTextarea` on the template route only, in a lazy chunk not loaded on any other route (build manifest check), or the textarea stays and the PR reports the failing check with evidence to Or.
11. **Leftovers.** Task rows show at most 3 blocker keys plus "+N more" (test); a 81-char user name and a 255-char email are refused by sign-up, invite and profile edit on client and server (tests); Back to `/agents` after scrolling restores within one row of the clicked row (manual, or deferred per §13.3).

## 3. Scope

**In:** §5–§13 and the DESIGN.md amendments in §14.

**Out (follow-up issues, §17):** Android Back closing a drawer (Q1), sheets addressable by URL with reload restore (Q1), template folders `skills/` and `files/` in the editor (#36), timeline virtualization (#104), breadcrumbs and sticky form footers (#94), searchable pickers beyond what U2 shipped (#83 stays open for the timezone picker only if still native; verify and close otherwise).

## 4. U4 checklist

| # | Item | Source | Where |
|---|---|---|---|
| 1 | New and Edit agent in a sheet: name first, slug derived, More options, inline credential/template/project/secret, manager combobox | status U4 #1; apple A3, C3; taste T-H6; paperclip H6; break M2 | §6, §7 |
| 2 | New task, New/Edit schedule in sheets, prefilled from context; schedule presets and summary | status U4 #2; paperclip M2; taste T-M6 (New-task bullet), T-M7; apple A2, C1 | §8, §9 |
| 3 | Toasts only when the control is gone, with Undo | status U4 #3; emil M6; decisions 3, 22 | §10 |
| 4 | Mobile pass: drawers, long-press, compact header, 40px targets, tree rows, Templates at 320, dialog titles that wrap | status U4 #4; apple A6; emil H4, M4; taste T-L3; chat M5; break M1, M7, Redesign 5; #102; #107 | §11 |
| 5 | CodeMirror template editor | decision 14, 23; taste T-M8 | §12 |
| 6 | break-ui leftovers: M5 scroll restoration, M6 blockers in lists, L5 max lengths | decision 14 | §13 |
| 7 | New template as a sheet | Q12 | §7.4 |

Already delivered upstream, verified rather than rebuilt: adaptive `Sheet`/`ConfirmDialog` and the mobile nav drawer (U1), the manager `AgentCombobox` with tree indent (U2, break M2), the one-line session header with a single ⋯ and Agent details (U2, Q17), the mobile depth cap of 3 (U2).

## 5. Sheet host, store and routing

### 5.1 Shape (Q1)

Sheets are opened in memory, over whatever page is showing. There is no `?sheet=` URL and no reload restore; the draft is kept in memory for the tab (DESIGN.md). The six legacy routes become thin redirects (§5.4) so links from outside the app's code keep working.

### 5.2 `features/sheets/sheet-store.ts`

A module-level store read through `useSyncExternalStore`, the same pattern as `features/shortcuts/sheet-store.ts`.

```ts
type SheetSpec =
  | { kind: "new-agent"; template?: string }
  | { kind: "edit-agent"; slug: string }
  | { kind: "new-task"; assignee?: string }
  | { kind: "new-schedule"; target?: string }
  | { kind: "edit-schedule"; key: string }
  | { kind: "new-template"; then: "open-editor" | "return" };

type ChildSpec =
  | { kind: "add-credential"; onDone(name: string): void }
  | { kind: "add-project"; onDone(name: string): void }
  | { kind: "add-secret"; name: string; onDone(name: string): void }
  | { kind: "new-template"; then: "return"; onDone(name: string): void };

openSheet(spec: SheetSpec, opts?: { at?: string }): void   // at = pathname it belongs to; default the current one
openChildSheet(spec: ChildSpec): void                      // only while a parent is open (one level, DESIGN.md)
closeChildSheet(): void
closeSheet(): void
useSheet(): { parent?: SheetSpec & { at: string }; child?: ChildSpec }
```

Opening a sheet while another is open replaces it (its draft stays). `openChildSheet` with no parent is a no-op in production and throws in tests.

### 5.3 `features/sheets/sheet-host.tsx`

One `<SheetHost />` in the `_app` layout, beside the shortcuts sheet. It renders the parent `Sheet` and, above it, the child `Sheet`, each body loaded with `React.lazy` per kind (the agent form and the schedule form stay out of the shell chunk). While a lazy body loads, the sheet shows its header and a static skeleton at the form's field heights (DESIGN.md loading rule). `Suspense` sits inside `SheetContent`, so the panel's motion is not delayed by the chunk.

- **Closing on navigation.** The host subscribes to the router's resolved location; when the pathname differs from `parent.at`, it closes both sheets (drafts kept). Links inside a sheet therefore need no extra close logic. Search-only changes (a list filter) don't close it.
- **Stacking.** On desktop the child is a second Radix Dialog sheet with its own scrim over the parent; the parent does not move (DESIGN.md). On phones the child is a second Vaul drawer `Root` (not `NestedRoot`, which scales the parent; DESIGN.md says the parent stays where it is). Esc, the scrim and a drag close only the topmost sheet. The child returns focus to the control that opened it.
- **Shortcuts.** An open sheet is a modal layer, so single-key shortcuts are off (`lib/shortcuts.ts` already treats an open modal `role=dialog` this way).
- **Sizes.** Every sheet is the U1 480px panel. The New agent and Edit schedule sheets scroll inside `SheetBody`; footers stay pinned (U1 §5.3).

### 5.4 Legacy routes (Q1, Q21)

Each route keeps its file but holds no form code: `beforeLoad` calls `openSheet(spec, { at })` and `throw redirect(...)`.

| URL | Lands on | Opens |
|---|---|---|
| `/agents/new?template=x` | `/agents` | `new-agent` with `template` |
| `/agents/$slug/edit` | `/agents/$slug` | `edit-agent` |
| `/tasks/new` | `/tasks` | `new-task` |
| `/schedules/new?target=x` | `/schedules` | `new-schedule` with `target` |
| `/schedules/$key` | `/schedules` | `edit-schedule` |
| `/templates/new` | `/templates` | `new-template`, `then: "open-editor"` |

`routes/_app/agents.new.tsx`, `tasks.new.tsx`, `schedules.new.tsx`, `templates.new.tsx`, `agents.$slug_.edit.tsx` and `schedules.$key.tsx` shrink to these redirects. `features/agents/prerequisites.tsx` (`PrerequisiteLine`, `usePrerequisites`) is deleted (Q4): the Agents empty state reads "No agents yet." and a primary "Create your first agent" button.

### 5.5 Drafts (Q9)

`features/sheets/drafts.ts`: a `Map<string, unknown>` keyed `new-agent`, `new-task`, `new-schedule`, `new-template`, `edit-agent:<slug>`, `edit-schedule:<key>`. Child sheets keep no draft (a credential token must not linger). A form reads its start values from the map once (`useState` initialiser) and writes to it on every change through a ref-backed setter that doesn't re-render the host. A successful submit deletes the key; signing out clears the map (the same hook that clears U3's attachment state on a user change).

Context prefill (§8.1) applies only when the draft for that kind is empty; a non-empty draft keeps its own assignee or target and shows it plainly (Q9).

Edit sheets apply one rule, written once and shared: a field the user touched keeps the draft's value, an untouched field follows the server (today's `mergeServer` in `schedule-form.tsx`, moved to `features/sheets/merge-server.ts` and used by the Edit agent form too). This replaces Edit agent's "seeded once" comment.

### 5.6 Entry points switched (Q20, Q21)

| Entry point | Today | Opens |
|---|---|---|
| Sidebar Agents `+` (`app-sidebar.tsx:258`, `sidebar-tree.tsx:475`), Agents header, palette "New agent", Agents empty state | `/agents/new` | `new-agent` |
| Template editor "Create agent" (`template-editor.tsx:545`) | `/agents/new?template=` | `new-agent` with template |
| AgentMenu "Edit" (`agent-menu.tsx:160`), Agent details "Edit agent" (`agent-details.tsx:498`), session view link (`session-view.tsx:408`), timeline rows (`timeline-row.tsx:227,244`), inbox pane (`inbox-pane.tsx:189`), Settings agent links (`settings/shared.tsx:94`), agent-actions links | `/agents/$slug/edit` | `edit-agent` |
| Tasks header, `c`, palette "New task" (`features/tasks/actions.ts`) | `/tasks/new` | `new-task`; in a session `c` prefills that agent |
| AgentMenu "New task" (new item), Agent details tasks section "New task" (new) | — | `new-task` with assignee |
| Schedules header, palette "New schedule" | `/schedules/new` | `new-schedule` |
| AgentMenu "New schedule" (new), Agent details schedules section "New schedule" (replaces `/schedules/new?target=`) | — / link | `new-schedule` with target |
| Schedule rows, `ScheduleBadge`, Agent details schedule keys (`agent-details.tsx:336`), the crons popover's schedule links | `/schedules/$key` | `edit-schedule` |
| Templates header "New template" (`templates-header.tsx:26`) | `/templates/new` | `new-template` |

Row links that open a sheet are buttons, not links (they don't navigate), with the row's existing name and focus ring.

## 6. New agent and Edit agent

### 6.1 Structure

`features/agents/agent-form.tsx` (647 lines today) splits by job, keeping one validation and one body builder:

- `agent-form-state.ts`: `useAgentFormState(mode, initial, draftKey)`: values, touched, errors, `shown` (the prefill rule), `check`, `body()`, submit, server-field mapping. Pure helpers (`deriveSlug`, `check`) unit-tested.
- `new-agent-sheet.tsx` and `edit-agent-sheet.tsx`: header, body layout and footer for each mode.
- Field components that already exist stay (`AgentCombobox`, `ProjectGrantPicker`, `TemplateSummary`), plus `address-line.tsx` (§6.3) and `template-field.tsx` (§6.2).

### 6.2 New agent sheet (Q5, Q6)

Header: "New agent". Body, top to bottom:

1. **Template.** The U1 `Select`. Each item shows the template's display name and, on a second muted line, its description (one line, truncated, full text in `title`); templates with errors are listed disabled as "name (has errors)". A ghost "New template" button sits in the field's label row and opens the stacked New template sheet (§7.4). When no template exists the Select is replaced by "No templates yet." and that button; when all templates have errors, by "No template is ready: fix the errors in `<name>`" (a link that navigates to the editor, which closes the sheet by §5.3) and the button. Below the field, `TemplateSummary` as today, with its avatar: the `AgentAvatar` (20px) for the slug the form would create, beside the template's runtime and model line, so identity shows as soon as a template is picked (apple A3, without a re-roll: the avatar is seeded from the slug).
2. **Display name** (`FormField`), prefilled from the template until touched (today's rule).
3. **Address line** (§6.3).
4. **Manager**: `AgentCombobox` as today ("No manager (reports to the humans)" first). Visible because the reporting line is the product's one structure (Q6).
5. **More options** (a disclosure, closed by default): Description, Credential, Projects. Its chevron follows DESIGN.md (150ms rotate, content never animates).

More options opens itself, and its summary line states why, when (Q6):
- there is no credential: "No Claude credential yet.";
- there are several credentials and none is preselected (today the first one is preselected, so this happens only when the preselected one was deleted while the sheet was open): "Choose a credential.";
- a field inside has an error on submit: focus moves to that field after opening;
- the template needs a secret that isn't set: "Secret GH_TOKEN isn't set.".

With exactly one credential it is preselected and More options stays closed (Q6).

Footer: primary "Create agent" (then "Creating…" with a spinner, "Installing plugins…" after 3s as today), and Cancel (ghost) closes the sheet. On success the sheet closes, the draft clears and the app navigates to the new agent's session (Q7): no toast, the session is the result.

**Focus on open.** Desktop: the Template select when no template is chosen, else Display name. Phones: the drawer content (U1 rule, so the keyboard doesn't rise mid-slide).

### 6.3 Address line and slug derivation (Q5)

`deriveSlug(name, taken)`: NFKD, strip combining marks, lowercase, every run of characters outside `[a-z0-9]` becomes `-`, trim leading/trailing hyphens, cut to 40 then trim a trailing hyphen; if the result starts with a digit prefix nothing (the slug schema decides validity); if it is in `taken` (active and archived, today's `useTakenSlugs`), append `-2`, `-3`, … keeping the total within 40. Returns `""` when nothing survives.

The line under Display name reads "Address **@priya-nair** · Change" in 13px muted, the slug in mono and ink; it updates on every keystroke (no debounce: it's local). "Change" (a ghost text button) swaps the line for the slug `FormField` with "@" prefix and the help "How others address this agent, like @team-lead. Lowercase letters, numbers and hyphens. Can't be changed later.", focused, holding the derived value. Once the user edits the slug it is theirs: the name stops driving it. The field opens itself, with its error, when the derived slug is empty or fails `slugSchema` (a CJK-only name), on blur of Display name or on submit. The template's name no longer prefills the slug (status "Done differently" 4 is reversed here).

The taken-set comes from two cached list queries; until both answered the line shows the derived slug without a suffix and submit waits for them (it already does: `awaitingPrefill`).

### 6.4 Edit agent sheet (Q2)

Header: "Edit agent", description "@slug · Template `name`" (mono). Body: every field visible, no template field and no slug input: Display name, Manager (excluding the agent and its subtree, as today), Description, Credential (with the "Add credential" ghost button, §7.1), Projects (with "Add project"). Footer: "Save changes" and Cancel.

- Opened for an archived or spawned agent (only through a legacy URL; no in-app entry offers it), the body is one line: "Spawned agents can't be edited." or "Archived agents can't be edited. Restore it from the Agents page." and the footer only has Close.
- Unknown slug: "There is no agent @slug." with Close.
- Save: the sheet closes and the draft clears. Toast per §10.2: none when the page under it is that agent's session (the header shows the change), "Saved @slug." elsewhere; when the save makes the agent restart (`restartPending` or it was running), the toast always appears and reads "Saved. @slug restarts when idle to apply the changes; its crons from this session stop." (the line Edit shows inline today).
- "Nothing to save: no field changed." stays inline in the footer (the control is still there).
- Server field errors land under their fields, as today.

`AgentActions` (Re-sync from template, Archive/Restore and `UndoArchiveLine`) leaves the Edit surface (Q2):
- **Re-sync from template…** and **Archive…** join `AgentMenu` (persistent, non-archived agents), above Terminate's separator. Re-sync keeps exactly the confirmation it has today (none added, none dropped); its outcome, whose control (the menu) is gone, toasts. Archive keeps its current blockers (reports, templates) as a `ConfirmDialog` only where today's flow confirms; on success it toasts "Archived @slug." with Undo (`unarchive`).
- **Restore** stays on the Agents page's Ended view row menu.
- `agent-actions.tsx` is deleted once its pieces have moved; its `TemplateProblem` and `ReportsMessage` copy move with them.

### 6.5 Removing the prerequisites gate (Q4)

The New agent sheet always opens. The checks `usePrerequisites` made become in-sheet states (§6.2, §7). The Agents page empty state: "No agents yet." and a primary "Create your first agent".

## 7. Inline setup: stacked sheets (Q4, Q12)

Each prerequisite form exists once. `AddCredentialForm`, `AddSecretForm` and `AddProjectForm` move out of their Settings sections into `features/settings/forms/` with their fields, validation, submit and error mapping unchanged, plus a `frame` prop: `"inline"` renders today's `InlineForm` (Settings keeps its inline forms), `"sheet"` renders `SheetBody` + `SheetFooter` (submit primary, Cancel ghost). The New template form gets the same treatment from `routes/_app/templates.new.tsx` into `features/templates/new-template-form.tsx`.

On success a stacked sheet: writes the new item into its list's query cache (`setQueryData`, then `invalidateQueries` in the background), calls `onDone(name)`, closes, and returns focus to the field it serves, which now shows the new value. No toast: the result is visible in the parent field (decision 3).

### 7.1 Add credential

Opened by the ghost "Add credential" in the Credential field's label row (always available, not only with none) and by the "No Claude credential yet." state. Title "Add credential", description "Saved to Settings → Credentials; other agents can use it." (paperclip H6's honesty note). The form verifies before saving, exactly as in Settings ("Verify and add", "Verifying…"); a rejected token is never stored and stays an inline error. On done the parent's Credential is set to the new name.

### 7.2 Add project

Opened by "Add project" in `ProjectGrantPicker` (New and Edit). On done the project is added to the grant set as an override (today's `setProjects` path), so the agent gets it.

### 7.3 Add secret

Each missing-secret warning in `TemplateSummary` becomes "Secret `GH_TOKEN` isn't set. The agent won't start until you add it." with an "Add secret" ghost button opening the stacked sheet with the name prefilled and focus on Value (today's `?addSecret` behaviour). On done the warning disappears because the secrets cache now holds it. The Settings link (`?addSecret=`) is no longer used by the form; the Settings route keeps the param.

### 7.4 New template

One sheet, two uses (Q12). Fields as today's page: Name (mono, "Also the folder name."), Display name, Description (optional). POST `/api/templates` writes `template.yaml` with `runtime: docker` and no image plus `AGENTS.md` (`apps/server/src/templates/template-index.ts:278-300`); with no `image:` the factory default registry image is used, so an agent can start without a build (verified for Q4: `images/resolve.ts:12-20`, `images/status.ts:139-160`; the first start may pull the image, which the session already shows).
- From Templates (`then: "open-editor"`): on success the sheet closes and the app navigates to `/templates/$name` (the editor is the result).
- Stacked from New agent (`then: "return"`): on success it closes and the parent's Template is set to it, and its summary loads.

## 8. New task

### 8.1 Prefill (Q8, Q20)

| Opened from | Assignee |
|---|---|
| An agent's session (`c`, AgentMenu "New task", Agent details tasks "New task") | that agent |
| Sidebar or Agents-page AgentMenu "New task" | that agent |
| Tasks list with an `assignee` filter (header button, `c`, palette) | the filter's agent |
| Anywhere else | Unassigned |

Prefill applies only to an empty draft (§5.5).

### 8.2 Sheet

`TaskForm` keeps its fields and validation (`features/tasks/task-form.tsx`), takes the draft key and initial values, and renders inside the sheet: Title, Body (the markdown editor), Assignee visible; **More options** holds Dependencies and Links, closed unless the draft has any or a field inside has an error (Q8). Footer "Create task" and Cancel. On success: close, clear the draft, toast "Created T-42." with an "Open" action (navigates to `/tasks/$key`) (Q7). The Tasks list (if under the sheet) refetches its query.

## 9. Schedules

### 9.1 New schedule sheet

`ScheduleForm` in the sheet with the draft key; Target prefilled per §5.6 when the draft is empty; the When field per §9.3. Its `useBlocker` unsaved-changes guard is removed for sheets (dismissing a sheet never asks; the draft is kept). Footer "Create schedule", Cancel. On success: close, clear the draft, toast "Created S-8." with "Open" (opens its Edit sheet). The Schedules list's page-to-page inline outcome (`schedule-list.tsx:119-130`, `PageOutcome`) is removed: one feedback channel (Q7).

D1: Q7(a) proposed no toast when the sheet was opened on `/schedules`. The list may be filtered so the new row isn't shown, and the toast is cheap and consistent with New task, so New schedule always toasts. Flagged in the review for the proxy.

### 9.2 Edit schedule sheet (Q3)

Header: the key in mono as the title, the first line of the body as description (truncated). Header actions, before Close: Pause or Resume and Delete, ghost icon buttons with tooltips and accessible names ("Pause S-12", "Delete S-12"), as on today's page. Body, top: the state line (`ScheduleState`, created by, last written by, last run, "Done.", the pending-run note, action errors) as today; then the form. Footer "Save changes", Cancel.

- **Delete** is immediate (forgiveness over confirmation, as today): the sheet closes, the draft clears, toast "Deleted S-12." with Undo (`restoreSchedule`). Undo failure (`target_ended`) toasts the server message.
- **Deleted state:** opened for a deleted schedule (a `ScheduleBadge` clicked days later), the body shows "S-12 was deleted." and, unless the target ended, a "Restore" button at the top, then the form read-only; no footer Save. Restore succeeds in place: the state flips to the live form (the control is still there: no toast).
- **Not found:** "There is no schedule S-12." with Close.
- **Save:** close, clear the draft; no toast when the sheet was over `/schedules` (the row shows the change), else "Saved S-12." (Q7).
- Live updates: the form's existing touched/untouched merge (§5.5).

### 9.3 Presets and summary (Q10)

`WhenField` Repeats mode gains a row of preset chips (a `SegmentedControl` would force one choice; these are toggle buttons with `aria-pressed`, 32px, 36 on touch, wrapping): "Every hour" `0 * * * *`, "Daily 09:00" `0 9 * * *`, "Weekdays 09:00" `0 9 * * 1-5`, "Mondays 09:00" `0 9 * * 1`, "Custom". A preset writes the cron and shows it read-only in a muted mono line; "Custom" (or a cron that matches no preset, e.g. an edited schedule) shows the cron input with the help behind a "Cron help" disclosure (today's text moves there). The chip matching the current cron is pressed.

Directly under the field, the summary line: `describeCron(cron)` in `features/schedules/describe-cron.ts`, hand-written, no dependency:
- `*/N * * * *` → "Every N minutes"; `0 */N * * *` → "Every N hours"; `M * * * *` → "Every hour at :MM";
- `M H * * *` → "Daily at HH:MM"; `M H * * 1-5` → "Weekdays at HH:MM"; `M H * * d[,d…]` → "Mondays and Thursdays at HH:MM";
- `M H D * *` → "Monthly on the Dth at HH:MM";
- anything else → no summary.

Every summary ends with the zone the next-runs preview uses: "Weekdays at 09:00 (Europe/Berlin)". The next-runs preview (`RunPreview`) moves up to sit right under the summary (apple C1), and stays for every cron. Once mode is unchanged. The message body loses its mono costume (taste T-M7: Geist).

## 10. Toasts (decisions 3 and 22)

### 10.1 Library and component

`sonner`, exact-pinned: `pnpm --filter @open-factory/web add --save-exact sonner@<v>` where `<v>` is the newest release older than the effective supply-chain policy at install time (record `pnpm config get minimumReleaseAge`; on 2026-11-22 the candidate is `2.0.8`, published 2026-08-09; it has no dependencies and peers on React ≥18). Never loosen the policy.

`components/ui/toaster.tsx`: one `<Toaster />` in the `_app` layout and a `notify()` helper; no feature imports `sonner` directly (a lint rule or a grep test enforces it).

```ts
notify({ text: string; action?: { label: string; run(): void }; undo?: () => Promise<void> }): void
```

- Look: a floating plate (`bg-popover`, `border-float-edge`, 6px radius), no shadow (decision 11), 13/18 text, the action and Undo as ghost buttons; `unstyled` Sonner with our classes.
- Position (Q7, D2): desktop bottom-left of the content area, its left offset the sidebar's current width plus 16px (the shadcn sidebar exposes its expanded and icon widths as CSS variables; the Toaster reads `useSidebar().state`), so it covers neither the sidebar footer nor the composer's Send corner; bottom offset 16px. Phones: bottom-centre, above `env(safe-area-inset-bottom)`. 
- At most 3 visible, 5s, paused on hover, focus and hidden tab (Sonner defaults). Enter: opacity and an 8px rise, 200ms `--ease-out`; exit 150ms; reduced motion: opacity only (an override in `styles.css`, as for Vaul).
- Undo: runs `undo()`, dismisses the toast, and on failure shows a new toast with the server's message. Undo windows: archive/unarchive and schedule restore have no server time limit (`routes/agents.ts:126-134`, `scheduling/schedule-service.ts:500`), so the toast never outlasts the server.
- Accessibility: Sonner's live region announces the text; the action is reachable with its hotkey (Alt+T) and by Tab.

### 10.2 The outcomes that toast

| Outcome | Toast |
|---|---|
| Task created from the sheet | "Created T-42." · Open |
| Schedule created | "Created S-8." · Open |
| Schedule deleted from its sheet | "Deleted S-12." · Undo |
| Schedule saved, sheet not over `/schedules` | "Saved S-12." |
| Agent saved, page isn't its session | "Saved @slug." |
| Agent saved with a restart | the restart line (§6.4), always |
| Agent archived from AgentMenu | "Archived @slug." · Undo |
| Agent re-synced from AgentMenu | today's re-sync outcome text |
| An Undo that failed | the server's message |

Nothing else toasts: a created agent navigates to its session; stacked sheets fill their parent field; everything with a control still on screen keeps `InlineOutcome`.

## 11. Mobile pass

"Phone" means `useIsMobile()` (below 48rem); "touch" means `(pointer: coarse)`.

### 11.1 `AdaptiveMenu` (Q14)

`components/ui/adaptive-menu.tsx` exposes the subset of `DropdownMenu` the app uses (`AdaptiveMenu`, `Trigger`, `Content`, `Item` with `asChild`, `variant="destructive"` and `onSelect`, `Separator`, `Label`, `Shortcut`). At 48rem and up it renders the U1 `DropdownMenu`; below, a bottom `Drawer` with the menu's label as the drawer title (sr-only when the menu has none), items as full-width 44px rows (`steel-hover` pressed fill, destructive in crimson), separators as rules, `Shortcut` hidden, and a Cancel row last (DESIGN.md drawer rule). Chosen at open, like `Sheet`. Selecting an item closes the drawer and then runs `onSelect` (focus handoffs such as AgentMenu's `handoff.current` keep working).

Consumers: `RowMenu` (timeline), `AgentMenu` (sidebar, Agents page, session header), task rows, inbox rows, schedule rows, Settings rows (`MoreButton` users), the templates list. No row keeps a bare `DropdownMenu`.

### 11.2 Long-press accelerator (Q13)

`hooks/use-long-press.ts`: `useLongPress(onLongPress)` returns pointer handlers active only for `pointerType === "touch"`: fires at 500ms; cancelled by more than 8px of movement, `pointercancel` (a scroll starting), `pointerup` before 500ms, or a second pointer. On fire: `navigator.vibrate?.(10)`, `onLongPress()`, and the click that follows the release is swallowed. Feedback starts on pointer-down: the row's existing pressed fill (DESIGN.md: rows take a 6% deeper fill when pressed, after 80ms on touch; full-width rows never scale). D3: Q13 approved "0.98 press"; DESIGN.md forbids scaling full-width rows, so the pressed fill is the feedback. Flagged for the proxy.

The ⋯ stays on every row (DESIGN.md "always on touch"); long-press opens the same menu (the controlled `AdaptiveMenu` of that row, so on a phone a drawer). Where:
- **List rows** (sidebar agent rows, Agents page rows, task, inbox, schedule, Settings and template rows): the whole row.
- **Timeline rows:** the speaker line, a tool row's summary line and the row's gutter only; never message prose, so long-press on text still selects it.
- `-webkit-touch-callout: none` and `user-select: none` only on those chrome regions; never on prose.

Narrows emil M4 ("long-press in place of ⋯"): the PR body says so, with the reason (selection on prose; a hidden-only gesture is undiscoverable).

### 11.3 Hit areas (Q15)

On coarse pointers every standalone control's hit box is at least 40×40px:
- `button.tsx` sizes `icon`, `icon-sm`, `icon-xs`, `sm`, `xs` and `default` get a `pointer-coarse:` `::after` expander (`absolute`, inset `min(0px, (100% - 2.5rem) / 2)` on each axis) so the visible glyph keeps its size. The button is `relative`; the expander is transparent and takes the button's pointer events.
- Where two expanded neighbours would overlap (toolbars, header action groups), the group's gap on coarse pointers grows to at least `2.5rem - visible size` or the visible size grows to 36px; the evidence pass measures it.
- Sheet and drawer Close, the composer's Send, Stop and attach, `/` and `@`, menu triggers, and the session header's buttons are explicitly in the hit-area test.
- Dense rows keep their heights (sidebar 36px on touch); drawer menu items are 44px (§11.1).

### 11.4 Phone composer (#107, Q16)

Below 48rem the shared `Composer` (`components/composer/composer.tsx`):
- **Send** is a 40px icon button (arrow-up, `aria-label="Send"`, primary fill) in the frame's bottom-right corner, inside the frame; the textarea's right padding leaves room for it so text never runs under it.
- **Stop**, while a turn is open, is a 40px outline icon button (filled square, `aria-label="Stop"`, "Stopping…" as its label and sr-only status while pending) directly left of Send. It differs from Send by shape (outline square vs filled arrow), never only by colour.
- The toolbar row keeps attach, `/` and `@` as 40px icon buttons; Write/Preview and the hint line are hidden (the hint's text stays available to screen readers through the textarea's description).
- Growth is the DESIGN.md rule (6 lines or 35svh); Enter adds a line on touch (unchanged). Command mode's chip and attachment chips keep their places above the toolbar.
- At 48rem and up the U3 layout is unchanged. The inbox reply composer and task comment composer follow the same rule (they are the same component).

### 11.5 Headers on phones (Q17)

Verify, don't rebuild: below 48rem the session header shows the avatar, name, short status, Agent details and one ⋯ (`AgentMenu`, now an `AdaptiveMenu` drawer); Stop is only in the composer. Other `PageHeader` actions below `sm` are icon-only with `aria-label` (Tasks already is). The evidence pass checks every page header at 320 for the badge/action overlap (break H3) and fixes any page that still wraps or overflows.

### 11.6 Lists and dialogs on phones

- **Agents tree (break M1, #102):** below 48rem the status column is the status shape only with the label sr-only; the name has `title={displayName}`; the second-line wrapper takes `min-w-0 max-w-full`; the page has no sideways scroll at 320 and 390 with the worst-case data (#102's 390 overflow is reproduced first, its cause named in the PR).
- **Templates at 320 (break M7):** header actions icon-only below `sm`; row metadata wraps (`flex-wrap min-w-0`).
- **ConfirmDialog:** title and description take `[overflow-wrap:anywhere]` in both the dialog and the drawer branch (break Redesign 5); the confirm button wraps to two lines rather than truncating (DESIGN.md).
- **Sheets as drawers:** every sheet in §6–§9 is checked at 390 with the keyboard open (WebKit emulation): the focused field stays visible (Vaul's input repositioning), the footer stays reachable, inputs are 16px on touch (no iOS zoom; `input.tsx` and `textarea.tsx` already use `pointer-coarse:text-base`).

## 12. Template editor (decision 23, Q11)

### 12.1 Dependencies

Official packages only, exact-pinned, each the newest release older than the effective policy at install time (record the policy value and each version's publish date in the PR). Candidates on 2026-11-22: `@codemirror/state` 6.7.6, `@codemirror/view` 6.43.15, `@codemirror/language` 6.13.1 (bracket matching, highlighting), `@codemirror/commands` 6.11.1 (history, default keymap, `indentWithTab`), `@codemirror/lang-yaml` 6.1.3, `@codemirror/lang-json` 6.0.2, `@codemirror/lang-markdown` 6.5.2, `@codemirror/lint` (diagnostic markers; 6.9.7 if 6.9.8 is still too new), and `@lezer/highlight` 1.2.5 (the highlight `tags`, a direct import). No `codemirror` meta-package, no `@uiw/*`, no autocomplete, search or fold packages. Transitive `@lezer/*` parsers come with the language packages. If the policy blocks a package, stop and report; never loosen it.

### 12.2 Wrapper

`features/templates/code-editor.tsx`, loaded with `React.lazy` from `template-editor.tsx` only. Same props as `CodeTextarea` (`value`, `onChange`, `onBlur`, `onSave`, `id`, `describedBy`) plus `language: "yaml" | "json" | "markdown"`, `diagnostics: { line: number; column?: number; message: string; severity }[]`, and an imperative handle `{ focusLine(line: number): void }` replacing the textarea ref the jump code uses (`serveJump`).

- One `EditorView` per mounted file tab; one `EditorState` per file kept in a ref map across tab switches, so each file keeps its own undo history (Q11).
- Controlled the CodeMirror way: user edits flow out through an update listener (`onChange(doc)`); an external value change (reload, conflict "Use theirs") dispatches a single replace transaction marked `addToHistory: false`. No effect re-creates the view on a keystroke.
- Extensions: `lineNumbers`, `history`, `drawSelection`, `bracketMatching`, `indentOnInput`, the language, a `HighlightStyle` from tokens (§12.3), `keymap` with `defaultKeymap`, `historyKeymap`, `indentWithTab` and Mod-s → `onSave`, `EditorView.lineWrapping` for AGENTS.md only, the lint gutter and `setDiagnostics` (no live linter: validation stays on blur and save, as today).
- Leaving with the keyboard: Esc then Tab moves focus out (CodeMirror's tab-focus mode with `indentWithTab`); the "Esc then Tab to leave the editor" hint stays in the description.
- Accessibility: `EditorView.contentAttributes` sets `id`, `aria-labelledby` (the tab's label), `aria-describedby` (field descriptions + hint) and `aria-multiline`; the gutter is `aria-hidden`.
- Loading: until the chunk resolves the tab renders today's `CodeTextarea` at the same height; text typed there carries over.

### 12.3 Theme

`EditorView.theme` with DESIGN.md tokens only: the editor surface `--code-bg`, edge `--code-border` with the field focus ring on `focus-within`, Geist Mono 13/20, caret and selection per DESIGN.md (signal caret, 26% signal selection), gutter muted. Syntax colours come from CSS variables `--syntax-keyword`, `--syntax-string`, `--syntax-number`, `--syntax-comment`, `--syntax-property`, `--syntax-punctuation`, `--syntax-heading`, `--syntax-link`, added to `styles.css` for light, dark and `prefers-contrast: more`, taken from the Shiki GitHub light and dark themes the markdown code blocks use, so code reads the same in a template and in a message.

### 12.4 Markers

Validator issues for the open file become diagnostics: a gutter mark (warning or error shape, not colour alone), a wavy underline on the line from the column to its end (or the whole line), and the message on hover and on keyboard focus of the line (lint's tooltip). The issues list stays the primary list; its jump-to-line uses `focusLine`. Issues without a line get no marker.

### 12.5 Scope kept

AGENTS.md keeps its Write/Preview tabs; Write is the editor with markdown highlighting. `template.yaml` YAML, `settings.json` and `mcp.json` JSON. Unsaved-changes guard, conflict handling, Save and validation are unchanged.

### 12.6 Real-browser checks and fallback

Run in the evidence pass, side by side against the current textarea on the same template, Chromium and WebKit (Playwright), desktop and phone emulation (390, touch):

| Check | Method | Passes when |
|---|---|---|
| Typing | type a 200-line YAML at 1 key/frame; record input latency | no dropped characters; p95 key-to-paint not worse than the textarea by more than one frame |
| IME | Chromium CDP `Input.imeSetComposition`/`insertText` (Japanese), WebKit composition events | composed text lands once, Enter during composition doesn't insert a newline or save |
| Undo | edit, switch tabs, edit, undo across both | per-file history; no undo crosses files; reload of a file isn't undoable |
| Screen-reader labelling | Playwright accessibility snapshot | the editable has the tab's name and the hint and field descriptions as its description, role `textbox` with multiline |
| Phone editing | 390 touch emulation, both engines | tap places the caret, the keyboard input works, selection handles work, the page doesn't zoom or scroll sideways |

If any check is worse than the textarea, the editor is not shipped anywhere: `CodeTextarea` stays, the dependencies are removed, and the PR reports the failing check with its evidence to Or (decision 23, Q11: all-or-nothing). The bundle effect (the lazy chunk's gzip size, and proof that no other route loads it) is in the PR either way.

## 13. break-ui leftovers (decision 14, Q18)

### 13.1 Blockers in lists (M6)

`BlockedMarker` takes `max` (default all); task list rows pass 3: "Blocked by T-15, T-16, T-17 +22 more" with the full list in its `title` and in the rail unchanged. The separator before the marker is drawn by the marker (`before:content-['·']`) so it can't orphan on a wrap.

### 13.2 Name and email lengths (L5)

`packages/shared/src/schemas.ts`: user `name` `max(80)` and email `max(254)` in the schemas sign-up, invite and profile edit use, on client and server. Input only: no migration, stored longer values stay readable and aren't validated on read; a profile edit that doesn't touch the name doesn't fail on an old long name (the patch only validates fields it sends).

### 13.3 Scroll restoration on Back (M5), last and timeboxed

Reproduce with the worst-case data first. Fix inside the Agents page: render the usage cell at its final width while usage loads (so row heights don't change), and let TanStack Router's scroll restoration run after the list query settles (`scrollRestoration` with a per-route key, restoring once data is present). If the fix needs router-wide scroll changes (other routes' behaviour), defer it to a follow-up issue with the reason (Q18). Timebox: half a day.

## 14. DESIGN.md amendments

- **Components → Overlays:** after the ladder table: "Every create and edit form is a sheet opened over the page you are on, from every entry point; a form never has its own page. Sheets are not addressed by URL; old form URLs open the sheet over their list. A sheet belongs to the page it opened over and closes when you leave that page, keeping its draft. A prerequisite missing from a form (a credential, a template, a project, a secret) is created in a sheet stacked over it and selected on return."
- **Components → Toasts:** add placement and look: "Bottom-left of the content area, clear of the sidebar and the composer; bottom-centre on phones. A plate with `float-edge`, no shadow; at most three; 5 seconds, paused while hovered, focused or hidden. Undo never outlasts what the server can restore."
- **Components → One row menu:** "On touch, long-pressing a row's chrome (a list row, a timeline row's speaker line, tool line or gutter; never its text) opens the same menu: 500ms, cancelled by movement or scroll, with the pressed fill as feedback. Below `md` every row and header menu opens as a bottom drawer with 44px items."
- **Components → Buttons / Layout:** "On coarse pointers every standalone control has a hit area of at least 40px, extended invisibly where the glyph is smaller; dense rows keep their height." (Replaces "36px on touch" for standalone controls; rows unchanged.)
- **Components → Composers:** "Below `md` Send is a 40px icon in the frame's corner and Stop a 40px outline square beside it; the toolbar keeps attach, `/` and `@` as icons, without Write/Preview or the hint."
- **Components → Forms (new line):** "Create forms show the fields that define the thing and fold the rest under More options, which opens itself, saying why, when something inside needs attention. An identifier derived from a name is shown as a line with Change, never asked first."
- **Components → Schedules (new line):** "Repeats offers presets first; a cron is the Custom case. A summary under the field says when it runs, with its time zone."
- **Components → Template editor (new line):** "Template files are edited in CodeMirror with line numbers, syntax colours from the same tokens as code blocks, and validator markers on their lines" (only if §12.6 passes).

## 15. Testing and evidence

Unit and component tests (Vitest, jsdom) per section: the store and host (open, replace, stack, close on pathname change, not on search change), the redirects, drafts (keep, clear on submit and sign-out, prefill only into an empty draft, touched/untouched merge), `deriveSlug`, `describeCron`, More options auto-open reasons, each stacked sheet's `onDone`, `notify` call sites (a grep test that only allowed modules call it), `AdaptiveMenu` at both widths, `useLongPress` (fake timers, movement, cancel, click swallow, prose excluded), the hit-area class contract, the phone composer, `BlockedMarker` max, schema limits.

Headless-browser evidence pass at the end of each PR (§16), with these rules (the machine was overloaded during U3):
- Only one evidence pass runs at a time across all devs; evidence passes and full-suite runs never overlap. Vitest runs locally with `--maxWorkers=50%`; tasks run targeted tests, the full suite runs only at PR end.
- Each pass uses a throwaway database and home, the fake Claude (never real Claude credentials), light and dark, 1440, 390 and 200% text (plus 320 for the mobile PR), and the worst-case seed from break-ui where rows matter.
- Each pass kills its browser, server, Vite and throwaway DB when it ends, in a `trap`/`finally`, and leaves no headless Chrome running (checked with `pgrep`).
- Screenshots and probe output are attached to the PR; each pass has one budgeted fix round.

## 16. Delivery (Q19)

Five stacked PRs on `u3/5-shared-composer` (#117):

| PR | Branch | Contents | Depends on |
|---|---|---|---|
| 1 | `u4/1-sheets` | sheet store, host, drafts, legacy redirects; Sonner `Toaster` and `notify`; New task sheet; New and Edit schedule sheets with presets and summary; task and schedule entry points; DESIGN.md overlay and toast amendments | #117 |
| 2 | `u4/2-agent-sheets` | New and Edit agent sheets (state split, address line, More options), stacked Add credential/project/secret and New template, New template from Templates, AgentMenu Re-sync/Archive/New task/New schedule, prerequisites removal, agent entry points; DESIGN.md forms amendment | PR1 |
| 3 | `u4/3-mobile` | `AdaptiveMenu` everywhere, long-press, hit areas, phone composer, header verification, Agents tree and Templates on phones, #102, ConfirmDialog wrapping; DESIGN.md mobile amendments | PR2 (code), so the evidence covers the new sheets as drawers |
| 4 | `u4/4-template-editor` | CodeMirror wrapper and theme, markers, the §12.6 checks, or the documented fallback | code-independent; stacked on PR3 |
| 5 | `u4/5-leftovers` | M6, L5, M5 (last, timeboxed) | code-independent; stacked on PR4 |

Parallelism: dev A runs PR1 → PR2 → PR3. Dev B runs PR4 and then PR5 in their own worktrees from the start; they touch no file PR1–PR3 touch except `DESIGN.md` and `styles.css` (separate sections, merged at rebase), and rebase onto PR3 when it lands. Evidence passes are serialized across both devs (§15).

## 17. Follow-up issues

1. Android Back closes the top drawer or sheet (Q1).
2. Sheets addressable by URL with reload restore, if ever wanted (Q1 rejected (b)).
3. M5 scroll restoration, only if §13.3 defers it.
4. CodeMirror, only if §12.6 falls back: what failed and what would need to change.
5. #83: close if U2's comboboxes already cover the timezone and agent pickers; otherwise narrow it.

## 18. Decision index

Proxy answers (certainty): Q1 in-memory sheets, thin redirects (3) · Q2 Edit agent is form only, lifecycle in AgentMenu (4) · Q3 Edit schedule sheet with deleted state (4) · Q4 inline credential/project/secret/template, verified runnable (3) · Q5 address line with Change (4) · Q6 More options (4) · Q7 context-dependent toasts (4; position 2) · Q8 New task prefill (4) · Q9 drafts, touched/untouched rule (3) · Q10 presets and hand summary (4) · Q11 CodeMirror (a) + bracket matching, all-or-nothing fallback (4) · Q12 one New template sheet (4) · Q13 long-press as accelerator, ⋯ stays (3) · Q14 AdaptiveMenu (4) · Q15 40px hit areas (4) · Q16 phone composer (4) · Q17 verify header (4) · Q18 leftovers in U4 (4) · Q19–Q21 see the decision issue.

Tech-lead: D1 New schedule always toasts (§9.1) · D2 toast position (§10.1) · D3 pressed fill instead of a 0.98 scale for long-press (§11.2) · D4 template items show descriptions in the Select, no row list (§6.2) · D5 avatar preview without re-roll (§6.2) · D6 child sheets keep no draft (§5.5) · D7 Vaul second `Root`, not `NestedRoot` (§5.3) · D8 `@codemirror/lint` for markers, no live linting (§12.2) · D9 syntax colour tokens from the Shiki GitHub themes (§12.3).
