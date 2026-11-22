# U4 create flows and mobile: Technical Design

- **Date:** 2026-11-22
- **Status:** revised after the self-review and five UI-lens reviews (Taste, Apple design, Emil design-eng, Motion, Break UI). The owner-proxy (owner-u4) answered Q1–Q27. Low certainty, for Or: Q1 (3), Q4 (3), Q7 toast position (2), Q9 (3), Q13 (3), Q23 (3), Q24 (3).
- **Source of truth (gitignored, read from the main checkout):** `docs/product/ui-review/decisions.md` (decisions 1, 3, 14, 22, 23 bind here), `docs/product/ui-review/status.md` (U4 rows 1–4 and the "Not owned" items decision 14 gives U4), the seven reviews in `docs/product/ui-review/` (apple-design A2, A3, A6, C1, C3; taste T-H6, T-M6, T-M7, T-M8, T-L3; paperclip H6, M2; emil H4, M4, M6; break-ui M1, M2, M5, M6, M7, L5 and "Redesign 5"), `docs/product/behavior/*.md`.
- **Builds on:** U1 (#77: adaptive `Sheet`, Vaul `Drawer`, adaptive `ConfirmDialog`, the control system, `data-instant`), U2 (#89: `AgentCombobox`, `AgentAvatar`, `AgentMenu`, Agent details, the shortcut layer, the one-line session header, the task peek), U3 (#103: the shared `Composer`, `RowMenu`, `StopButton`). Stacked on `u3/5-shared-composer` (PR #117).
- **Inputs from other issues:** #107 (mobile composer and row long-press, from U3 Q25), #102 ("`/agents` overflows horizontally at 390px").
- **Decision log:** GitHub issue #118 "U4: create flows and mobile — design". Q1–Q27 are the proxy's answers; D1–D20 are tech-lead decisions (§19).

> `docs/product/` is gitignored. Paths into it are relative to the main checkout. Web paths are relative to `apps/web/src/` unless they start with `apps/` or `packages/`.

## 1. Goal

1. Every create and edit form opens in a sheet over the page you are on: New agent, Edit agent, New task, New schedule, Edit schedule, New template (decision 1). Nothing navigates away to fill in a form.
2. A fresh factory can create its first agent without leaving the New agent sheet: a missing credential, template, project or template secret is set up in a stacked sheet and selected on return (paperclip H6).
3. Outcomes whose control is gone are reported by a toast, with Undo where the server allows it (decisions 3 and 22, Sonner).
4. Phones get a touch layout: row and header menus as bottom drawers, long-press as an accelerator, 40px hit areas, a messaging-style composer, and no horizontal overflow at 320–390px.
5. The template editor highlights YAML, JSON and markdown with line numbers and validator markers (CodeMirror 6, decision 23), or keeps the textarea if the real-browser checks say so.
6. Close the break-ui leftovers decision 14 gives U4 (M5, M6, L5) and the phone rows (M1, M7, #102).

## 2. Acceptance criteria

All run in default CI (`pnpm test`, `pnpm typecheck`, `pnpm lint`) unless marked manual (headless-browser evidence pass, §16).

1. **Sheets everywhere.** No in-app code navigates to a form URL: a test greps `apps/web/src` (tests excluded) for `"/agents/new"`, `"/tasks/new"`, `"/schedules/new"`, `"/templates/new"`, `"/agents/$slug/edit"` and `"/schedules/$key"` in `to=`, `navigate(` and palette `ACTIONS` (`features/palette/rank.ts:150,152`, `features/tasks/actions.ts:5`) and finds only the redirect routes. The six legacy URLs still work from outside the app and land on the list or session with the sheet open (§5.4). Tests cover each entry point and each redirect, including bad params.
2. **A sheet belongs to its page.** A sheet stays open across re-renders and refetches, closes on a pathname change that happens after it opened (not on search-only changes, not on the redirect that opened it), and reopening the same kind shows the typed draft with "Draft restored · Discard" (§5.5). Successful submit clears the draft; sign-out clears every draft and pending child result.
3. **First agent with nothing set up.** On a factory with no credential and no template, the Agents empty state's "Create your first agent" opens New agent; the user creates a template, adds and verifies a credential, and creates the agent, without the parent sheet unmounting and without leaving the page (mocked-API test; manual evidence).
4. **Slug.** "Priya Nair" shows "Address @priya-nair"; with `priya-nair` taken by an agent or a person, `@priya-nair-2` shows before submit; "Łukasz Żak" derives `lukasz-zak`, "Straße" `strasse`; a CJK-only name shows "Address: choose one · Change"; "Change" reveals the slug input; a server slug error opens the input with the error (unit tests on `deriveSlug`, component tests on the line).
5. **Toasts.** Exactly the outcomes in §10.2 toast; a grep test allows `notify` only in the modules listed there. Undo on Archive and on schedule Delete restores (tests); a failed Undo or a failed menu action toasts its message. A toast never covers the sidebar footer or any part of a mounted composer at 1440, 1024 (sidebar expanded and collapsed), 390 and 200% text (manual); an open sheet's scrim dims toasts.
6. **Schedules.** Choosing "Weekdays 09:00" in Repeats writes `0 9 * * 1-5` and shows the next runs with their zone; choosing "Custom cron…" shows the cron input and, for a cron `describeCron` knows, a summary with the zone (unit tests on `describeCron`).
7. **Mobile menus.** Below 48rem every row menu and the session header menu render as a bottom drawer with a visible title naming the row and 44px items; at 48rem and up they are dropdowns (tests flip `matchMedia`). On touch, the ⋯ opens on click, never pointer-down. Long-press (500ms, touch only) on the rows in §11.2 opens their menu; on prose it does nothing and text selection works; Android's link context menu doesn't appear (tests with fake timers and pointer events; manual in Chromium and WebKit touch emulation).
8. **Hit areas.** On a coarse pointer every standalone control has a hit box of at least 40×40px and no expander overlaps a form control or prose (a probe hit-tests the 40px box corners with `elementFromPoint` in the evidence pass; unit tests assert the class contract).
9. **No sideways page on phones.** `/agents` (214 agents, 14-level chain), `/templates`, `/tasks` with a 25-blocker task, every sheet with 80-char names, 40-char slugs and 64-char secret names, and a session with the composer open have `scrollWidth <= clientWidth` at 320 and 390 and at 200% text (scripted probe).
10. **Template editor.** Either CodeMirror passes all five decision-23 checks (§12.6), loads in a lazy chunk of at most 135 kB gzip that no other route loads (build manifest check), and replaces the textarea on the template route only; or the textarea stays and the PR reports the failing check with evidence to Or.
11. **Leftovers.** Task rows show at most 3 blocker keys plus "+N more" (test); an 81-char user name and a 255-char email are refused at sign-up (form and server) and by the server on `/update-user` (tests); Back to `/agents` after scrolling restores within one row of the clicked row (manual), or §13.3 defers it.
12. **Restore.** An archived agent can be restored from its session's menu, from the Agents page Ended view's row menu, and from the "This agent is archived" notices in the session and inbox (tests).

## 3. Scope

**In:** §5–§13 and the DESIGN.md amendments in §14.

**Out (follow-up issues, §18):** Android Back closing a drawer (Q1); sheets addressable by URL with reload restore (Q1); row menus for task, inbox and Templates rows (Q23); template `skills/` and `files/` in the editor (#36); timeline virtualization (#104); breadcrumbs and sticky form footers (#94).

## 4. U4 checklist

| # | Item | Source | Where |
|---|---|---|---|
| 1 | New and Edit agent in a sheet: name first, slug derived, More options, inline credential/template/project/secret, manager combobox | status U4 #1; apple A3, C3; taste T-H6; paperclip H6; break M2 | §6, §7 |
| 2 | New task, New/Edit schedule in sheets, prefilled from context; schedule presets and summary | status U4 #2; paperclip M2; taste T-M6 (New-task bullet), T-M7; apple A2, C1 | §8, §9 |
| 3 | Toasts only when the control is gone, with Undo | status U4 #3; emil M6; decisions 3, 22 | §10 |
| 4 | Mobile pass: drawers, long-press, compact header, 40px targets, tree rows, Templates at 320, dialog titles that wrap | status U4 #4; apple A6; emil H4, M4; taste T-L3; chat M5; break M1, M7, Redesign 5; #102; #107 | §11 |
| 5 | CodeMirror template editor | decisions 14, 23; taste T-M8 | §12 |
| 6 | break-ui leftovers: M5 scroll restoration, M6 blockers in lists, L5 max lengths | decision 14 | §13 |
| 7 | New template as a sheet | Q12 | §7.4 |
| 8 | Agent lifecycle actions out of the Edit page (Re-sync, Archive, Restore) | Q2, Q22 | §6.5 |

Delivered upstream and verified rather than rebuilt: the adaptive `Sheet`/`ConfirmDialog` and the mobile nav drawer (U1), the manager `AgentCombobox` with tree indent (U2, break M2), the one-line session header with a single ⋯ and Agent details (U2, Q17), the mobile depth cap of 3 (U2).

Narrowings to record in the PR bodies: emil M4 asked for long-press **in place of** the ⋯; U4 keeps the ⋯ and adds long-press as an accelerator on row chrome only (Q13: selection on prose, and a hidden-only gesture is undiscoverable). chat M5's 32px ⋯ gutter on phone timeline rows stays for the same reason.

## 5. Sheet host, store and routing

### 5.1 Shape (Q1)

Sheets open in memory over whatever page is showing. There is no `?sheet=` URL and no reload restore; the draft is kept in memory for the tab (DESIGN.md). The six legacy routes become thin redirects (§5.4) for links that live outside the app's code (agent messages, inbox text, bookmarks).

### 5.2 `features/sheets/sheet-store.ts`

A module-level store read through `useSyncExternalStore`, the pattern of `features/shortcuts/sheet-store.ts`.

```ts
type SheetSpec =
  | { kind: "new-agent"; template?: string }
  | { kind: "edit-agent"; slug: string }
  | { kind: "new-task"; assignee?: string }
  | { kind: "new-schedule"; target?: string }
  | { kind: "edit-schedule"; key: string }
  | { kind: "new-template"; then: "open-editor" };

type ChildSpec =
  | { kind: "add-credential" }
  | { kind: "add-project" }
  | { kind: "add-secret"; name: string }
  | { kind: "new-template"; then: "return" };

openSheet(spec: SheetSpec, opts?: { instant?: boolean; at?: string }): void // at = the pathname it belongs to; default the current resolved pathname
openChildSheet(spec: ChildSpec, onDone: (name: string) => void): void // only while a parent is open
closeChildSheet(): void
closeSheet(): void
useSheet(): { parent?: SheetSpec & { id: number }; child?: ChildSpec & { id: number } }
```

- Each open gets a fresh instance `id`. A child's `onDone` is held with the parent's id and dropped if that parent instance has closed by the time the child succeeds (a late result updates the query cache only; break-ui M2).
- Opening a sheet while one is open swaps the content in place, instantly, with no exit and re-entry (DESIGN.md's retargeted-peek rule); the previous kind's draft stays.
- `openChildSheet` with no parent is a no-op in production and throws in tests. Never more than one child (DESIGN.md: one level).
- `instant: true` stamps the opening `data-instant` (keyboard entry points: `c`, the palette, Enter on a focused button already do this through `lib/input-modality.ts`; redirects on the initial navigation pass it explicitly, §5.4).

### 5.3 `features/sheets/sheet-host.tsx`

One `<SheetHost />` in the `_app` layout, beside the shortcuts sheet. It renders the parent `Sheet` and, over it, the child `Sheet`.

- **Lazy bodies.** Each kind's body is a `React.lazy` chunk (the agent and schedule forms stay out of the shell chunk). Every entry point preloads its chunk on `pointerenter`, `focus` and `pointerdown` (a shared `preloadSheet(kind)`), and the shell preloads all of them on idle after first paint, so the skeleton is rare. While a chunk loads, the sheet shows its header and a static skeleton at the form's real field and footer heights (test: each form's height matches its skeleton). The swap is instant. Focus-on-open runs when the body mounts, not in Radix's `onOpenAutoFocus`.
- **Closing on navigation.** Each open records `at`: the redirect target's pathname for a redirect (§5.4), the current resolved pathname for an in-app open. The host subscribes to the router's `onResolved` event and closes both sheets (drafts kept) only when the event's `toLocation.pathname !== at`. So the navigation that a redirect opened the sheet for (whose `pathChanged` is true, and always true on a fresh load) doesn't close it, and search-only changes don't either. A close caused by navigation is stamped `data-instant`, so the sheet doesn't slide out over the new page.
- **Stacking (Q24).** The child is 48px narrower than the parent on desktop (`w-[min(27rem,100%)]`), so a dimmed 48px strip of the parent shows; clicking that strip closes only the child. On phones the child drawer caps at 82svh so the parent's top edge and handle show above it. The child's description names its parent ("For New agent"). Desktop: a second Radix Dialog sheet with its own scrim; the parent doesn't move. Phones: a second Vaul `Root` (not `NestedRoot`, which scales the parent), with `noBodyStyles` on the child Root: Vaul 1.1.2 keeps one module-level saved body position, so a child closing would otherwise unfix the body and scroll the page under the still-open parent on Safari (`vaul/dist/index.mjs:886-888`, `:899-901`). U1's `Sheet` gains a `stacked` prop that sets the width cap, the height cap and `noBodyStyles`. Esc, the scrim and a drag close only the topmost sheet. In dark mode the evidence pass checks the two scrims' combined darkness and halves the child's scrim if it reads as near-black.
- **Esc and keyboard closes.** Esc stamps both the content and the overlay `data-instant` (today only the content), and `closeSheet()` after a submit made with Enter or ⌘Enter stamps both, so every keyboard close is instant (DESIGN.md Motion).
- **Shortcuts.** An open sheet is a modal layer, so single-key shortcuts are off (`lib/shortcuts.ts` already treats an open modal dialog this way).
- **Drag versus fields.** Inside a drawer, textareas, the markdown editor and CodeMirror carry `data-vaul-no-drag`, so scrolling a long body doesn't drag the drawer away.
- **Sizes.** Every parent is the U1 480px panel; bodies scroll inside `SheetBody`; footers stay pinned (U1 §5.3).

### 5.4 Legacy routes (Q1, Q21)

Each route keeps its file and holds no form code: `beforeLoad({ preload, search, params })` returns at once when `preload` is true (the router preloads on intent, `router.tsx:12`), otherwise calls `openSheet(spec, { at: <target pathname>, instant: !router.state.resolvedLocation })` (no resolved location yet means the initial navigation, where the sheet appears without sliding) and throws `redirect({ ..., replace: true })` so Back doesn't loop.

| URL | Lands on | Opens |
|---|---|---|
| `/agents/new?template=x` | `/agents` | `new-agent` with `template` |
| `/agents/$slug/edit` | `/agents/$slug` | `edit-agent` |
| `/tasks/new` | `/tasks` | `new-task` |
| `/schedules/new?target=x` | `/schedules` | `new-schedule` with `target` |
| `/schedules/$key` | `/schedules` | `edit-schedule` (key upper-cased) |
| `/templates/new` | `/templates` | `new-template`, `then: "open-editor"` |

Bad params fall through to the sheet's own states: an unknown or broken `?template=` shows the template unchosen with its error on submit (today's rule), an unknown, ended or spawned `?target=` leaves Target empty with an inline line naming why, an unknown slug or key shows the sheet's not-found body, and a human handle in `/agents/<handle>/edit` is an unknown agent. Tests cover each.

`routes/_app/agents.new.tsx`, `tasks.new.tsx`, `schedules.new.tsx`, `templates.new.tsx`, `agents.$slug_.edit.tsx` and `schedules.$key.tsx` shrink to these redirects. `features/agents/prerequisites.tsx` is deleted (Q4); the Agents empty state reads "No agents yet." with a primary "Create your first agent".

### 5.5 Drafts (Q9, Q25)

`features/sheets/drafts.ts`: a `Map<string, unknown>` keyed `new-agent`, `new-task`, `new-schedule`, `new-template`, `edit-agent:<slug>`, `edit-schedule:<key>`. Child sheets keep no draft (a credential token must not linger). A form reads its start values from the map once (a `useState` initialiser) and writes to it on every change through a ref, without re-rendering the host. A successful submit deletes the key. Sign-out clears the map, drops pending child callbacks and bumps a session generation that any in-flight `onDone` checks (the same hook that clears U3's attachment state on a user change).

- **Restored drafts are announced** (Q25): when a sheet opens with a non-empty draft, its footer shows a quiet line "Draft restored · Discard". Discard clears the fields and applies the context prefill. The dismiss button is labelled "Close", never "Cancel", because it keeps the draft.
- **Prefill** (§8.1) applies only to an empty draft; a non-empty draft keeps its own assignee or target, shown plainly (Q9).
- **Stale references.** On restore, every reference in the draft (template, manager, assignee, target, credential, projects) is checked against the current lists. A gone one is cleared with an inline line under its field ("@x has ended; pick another.", "Credential prod was deleted."), and More options opens itself if the field is folded.
- **Edit sheets** apply one rule, written once: a field the user touched keeps the draft's value, an untouched field follows the server (today's `mergeServer` in `schedule-form.tsx`, moved to `features/sheets/merge-server.ts` and used by the Edit agent form too). This replaces Edit agent's "seeded once" comment.

### 5.6 Entry points (Q20, Q21)

| Entry point | Today | Opens |
|---|---|---|
| Sidebar Agents `+` (`app-sidebar.tsx:258`, `sidebar-tree.tsx:475`), Agents header (`agents.index.tsx:70`), palette "New agent" (`palette/rank.ts:150`, a new `open-sheet` action kind), Agents empty state | `/agents/new` | `new-agent` |
| Template editor "Create agent" (`template-editor.tsx:545`) | `/agents/new?template=` | `new-agent` with template |
| AgentMenu "Edit" (`agent-menu.tsx:160`), Agent details "Edit agent" (`agent-details.tsx:498`), timeline `edit_agent` fix link (`timeline-row.tsx:227`), Settings agent links (`settings/shared.tsx:94`) | `/agents/$slug/edit` | `edit-agent` |
| Timeline `resync` fix link (`timeline-row.tsx:241-246`) | `/agents/$slug/edit` | runs the Re-sync action (§6.5) |
| "This agent is archived. Restore it" (`session-view.tsx:404-412`, `inbox-pane.tsx:185-193`) | `/agents/$slug/edit` | a Restore button running the action in place (§6.5) |
| Tasks header (`tasks.index.tsx:68`), `c`, palette "New task" (`features/tasks/actions.ts`) | `/tasks/new` | `new-task`; in a session `c` prefills that agent |
| AgentMenu "New task" (new) | — | `new-task` with assignee |
| Schedules header (`schedules.index.tsx:47`), palette "New schedule" (`palette/rank.ts:152`) | `/schedules/new` | `new-schedule` |
| AgentMenu "New schedule" (new; replaces the Agent details `/schedules/new?target=` link, Q20: one way in) | link | `new-schedule` with target |
| Schedule rows, `ScheduleBadge` (`schedule-badge.tsx:16`), Agent details schedule keys (`agent-details.tsx:336`), the crons popover's schedule links | `/schedules/$key` | `edit-schedule` |
| Templates header "New template" (`templates-header.tsx:26`) | `/templates/new` | `new-template` |

Triggers that open a sheet are buttons, not links (they don't navigate), keeping the row's name and focus ring, and they call `preloadSheet` on intent (§5.3).

## 6. New agent and Edit agent

### 6.1 Structure

`features/agents/agent-form.tsx` (647 lines) splits by job, keeping one validation and one body builder:

- `agent-form-state.ts`: `useAgentFormState(mode, initial, draftKey)`: values, touched, errors, `shown` (the prefill rule), `check`, `body()`, submit, server-field mapping. Pure helpers (`deriveSlug`, `check`) are unit-tested.
- `new-agent-sheet.tsx`, `edit-agent-sheet.tsx`: header, body and footer per mode.
- Existing field components stay (`AgentCombobox`, `ProjectGrantPicker`, `TemplateSummary`); new `address-line.tsx` (§6.3) and `template-field.tsx` (§6.2).

Every button inside the form that isn't the submit ("New template", "Add credential", "Add project", "Add secret", "Change", "Discard", More options) is `type="button"` (test: Enter in a field and clicks while pending submit once).

### 6.2 New agent sheet (Q5, Q6)

Header "New agent". The body renders once the credentials and templates queries have answered (the skeleton holds until then), so More options' open state is final at first paint and the body doesn't jump while typing. Top to bottom:

1. **Template.** The U1 `Select`. Each item shows the display name in its `ItemText` and, outside `ItemText`, a muted one-line description (so the closed trigger shows one line); the list scrolls within a max height in the drawer. Templates with errors are listed disabled as "name (has errors)". A ghost "New template" button in the field's label row opens the stacked New template sheet (§7.4). No template at all: the Select is replaced by "No templates yet." and that button. All templates broken: "No template is ready: fix the errors in `<name>`" (a link to the editor; with more than one broken template the link goes to `/templates`), plus the button. Below the field, `TemplateSummary` as today; its description is shown in full there (touch has no `title`).
2. **Display name** (`FormField`), prefilled from the template until touched (today's rule).
3. **Address line** (§6.3), with the agent's 20px avatar at its start (seeded from the slug, so it sits beside its cause; it updates on the settled slug, on blur or after 300ms without typing, and never animates).
4. **Manager**: `AgentCombobox` as today ("No manager (reports to the humans)" first). Visible because the reporting line is the product's one structure (Q6).
5. **More options**, a disclosure closed by default, holding Description, Credential and Projects. Its chevron rotates only when its own button is clicked (DESIGN.md); opening itself never animates.

More options opens itself, and its summary states why (Q6):
- no credential: "No Claude credential yet.";
- several credentials and none selected (the preselected one was deleted while the sheet was open, or a restored draft's was): "Choose a credential.";
- a template secret isn't set: "Secret `GH_TOKEN` isn't set." (with several: "3 secrets aren't set.");
- on submit, a field inside has an error (focus moves to it after opening);
- a restored draft's reference inside it went stale (§5.5).

With exactly one credential it is preselected and More options stays closed (Q6).

Footer: "Create agent" (primary, min-width that fits "Creating…"), Close (ghost), and the restored-draft line when it applies. While creating: "Creating…" with a spinner; after 3s, when the template installs plugins, a muted "Installing plugins…" line beside the button (the button doesn't change width). On success: close, clear the draft, navigate to the new agent's session (Q7; no toast, the session is the result).

**Dismissed while creating** (break-ui M2): the request continues. A late success toasts "Created @slug." with "Open" and does not navigate; a late failure toasts the error with "Open form", which reopens the sheet with the kept draft.

**Focus on open.** Desktop: Template when none is chosen, else Display name. Phones: the drawer content (U1 rule: the keyboard doesn't rise mid-slide).

### 6.3 Address line and slug derivation (Q5)

`deriveSlug(name, taken)`:
1. Fold letters NFKD leaves alone: ł→l, ø→o, ß→ss, æ→ae, œ→oe, đ→d, ı→i, þ→th (and their capitals); then NFKD and strip combining marks.
2. Lowercase; every run outside `[a-z0-9]` becomes `-`; trim hyphens.
3. Cut to 40 and trim a trailing hyphen.
4. If the result is in `taken`, cut the base so base + suffix fits 40, trim its trailing hyphen, and append `-2`, `-3`, … (never `--2`).
5. Return `""` when nothing survives or the result fails `slugSchema`.

`taken` holds every agent slug (active and archived, today's `useTakenSlugs`), every human handle (the people list U3's `@` completion loads) and `RESERVED_SLUGS` (`packages/shared/src/names.ts:8`); the server refuses all three.

The line under Display name reads "[avatar] Address **@priya-nair** · Change" (13px muted; slug in mono ink, `[overflow-wrap:anywhere]`; "Change" `whitespace-nowrap shrink-0`). It updates on every keystroke. With an empty derivation it reads "Address: choose one · Change". "Change" swaps the line for the slug `FormField` (prefix "@", help "How others address this agent, like @team-lead. Lowercase letters, numbers and hyphens. Can't be changed later."), focused, holding the derived value; once edited the slug is the user's and the name stops driving it. The field also opens itself, focused and with its error, when the derived slug is empty or invalid on Display name's blur or on submit, and when the server answers with a `fields.slug` error (a second tab or an agent took it). The template's name no longer prefills the slug (status.md "Done differently" 4 is reversed).

Until the taken-sets have answered, the line shows the derivation without a suffix, and submit waits for them (today's `awaitingPrefill`).

### 6.4 Edit agent sheet (Q2)

Header "Edit agent", description "@slug · Template `name`" (mono, wrapping, never truncated). Body, all visible: Display name, Manager (excluding the agent and its subtree, as today), Description, Credential (with "Add credential", §7.1), Projects (with "Add project", §7.2). Footer: "Save changes", Close, and the restored-draft line.

- **Restart notice before saving** (Taste M5): while a field whose change restarts a running agent is dirty (credential, projects, manager; whatever `restartPending` covers server-side, listed in the plan from the server code), a muted line above the footer states the real consequence in plain words, e.g. "Saving restarts @slug the next time it is idle, to apply the new credential. Crons it set in this session stop." (it names what changed and when the restart happens; never a generic warning).
- **States:** an archived agent shows "This agent is archived." with a Restore button (§6.5) and no form; a spawned agent shows "Spawned agents can't be edited." with Close; an unknown slug "There is no agent @slug.". If the agent is archived, terminated or deleted by someone else while the sheet is open, the sheet flips to that state live and keeps the draft (break-ui M9).
- **Save:** close and clear the draft. Toast per §10.2: none when the page under the sheet is that agent's session and only fields the header shows changed (display name); otherwise "Saved @slug."; with a restart, "Saved @slug. Restarts when idle." always.
- "Nothing to save: no field changed." stays inline in the footer (its control is still there). Server field errors land under their fields, as today.

### 6.5 Agent lifecycle actions (Q2, Q20, Q22)

`AgentActions` and `UndoArchiveLine` (`features/agents/agent-actions.tsx`) are deleted, with the `?justArchived` handling on the Agents page. Their actions move to `AgentMenu`, grouped (Q20): **New task, New schedule**; then **Edit, Usage, Open tasks** (and Agent details, Compact, Stop crons where they apply today); then **Re-sync from template…, Archive…, Restore, Terminate…**, separated, destructive items crimson (U1).

- **Re-sync from template…** keeps exactly today's confirmation behaviour (none added, none dropped). Its outcome toasts (the menu is gone).
- **Archive…** keeps today's blockers (reports, templates) and confirmation, if any; success toasts "Archived @slug." with Undo (`unarchive`).
- **Restore** (archived agents) runs `unarchive`. From a menu it toasts "Restored @slug."; from the "This agent is archived" notices in the session (`session-view.tsx:404-412`) and the inbox pane (`inbox-pane.tsx:185-193`), which become a "Restore" button, the outcome is inline (the control is still there).
- **Agents page rows** (`agent-tree.tsx`) get the same `AgentMenu` ⋯ (Q22): one menu for an agent everywhere. The Ended view's archived rows offer Restore through it. Terminated persistent agents and ended spawned agents get only Usage and Open tasks there (nothing else applies). `agents.index.tsx`'s `validateSearch` stays tolerant of the old `justArchived` param, which the S4 bookmark redirect (`agents.index.tsx:21-31`) still passes; it is ignored.
- The timeline's `resync` fix link (`timeline-row.tsx:241-246`) runs the Re-sync action directly.

## 7. Inline setup: stacked sheets (Q4, Q12)

Each prerequisite form exists once. `AddCredentialForm`, `AddSecretForm` and `AddProjectForm` move out of their Settings sections into `features/settings/forms/`, with fields, validation, submit and error mapping unchanged, plus a `frame` prop: `"inline"` renders today's `InlineForm` (Settings keeps its inline forms), `"sheet"` renders `SheetBody` + `SheetFooter` (primary submit, ghost Close). The New template form moves from `routes/_app/templates.new.tsx` into `features/templates/new-template-form.tsx` the same way.

On success a stacked sheet writes the new item into its list's query cache (`setQueryData`, then a background `invalidateQueries`), calls `onDone(name)` (dropped if the parent instance has gone, §5.2), and closes in this order: the parent field takes the value and scrolls into view (`block: "nearest"`, instant), then the child exits, revealing the value already in place. Focus returns to the served field: Credential, the Projects picker, or Template (for Add secret, whose warning has just disappeared, Template). On phones focus goes to the parent drawer's content instead, so the keyboard doesn't rise. No toast: the result is visible in the parent (decision 3).

### 7.1 Add credential

Opened by the ghost "Add credential" in the Credential field's label row (always there) and by the "No Claude credential yet." state. Title "Add credential", description "For New agent. Saved to Settings → Credentials; other agents can use it." (paperclip H6's honesty note). It verifies before saving, as in Settings ("Verify and add", "Verifying…"); a rejected token is never stored and stays an inline error. On done the parent's Credential is the new name.

### 7.2 Add project

Opened by "Add project" in `ProjectGrantPicker` (New and Edit). On done the project joins the grant set as an override (today's `setProjects` path).

### 7.3 Add secret

Each missing-secret warning in `TemplateSummary` reads "Secret `GH_TOKEN` isn't set. The agent won't start until you add it." (`[overflow-wrap:anywhere]` on the name; secret names have no break points) with an "Add secret" button opening the stacked sheet, name prefilled. Desktop focuses Value; phones focus the drawer content (U1 rule). On done the warning disappears because the secrets cache holds it. The form no longer uses the Settings `?addSecret=` link; the Settings route keeps the param.

### 7.4 New template

One sheet, two uses (Q12). Fields, identity first (§14 Forms rule): Display name, then the folder line "Folder `templates/priya-nair` · Change" derived with `deriveSlug` against the template names (Change reveals the Name input with its help "Lowercase letters, numbers and hyphens. Also the folder name."), then Description (optional). POST `/api/templates` writes `template.yaml` with `runtime: docker` and no image, plus `AGENTS.md` (`apps/server/src/templates/template-index.ts:278-300`); with no `image:` the factory default registry image is used, so an agent starts without a build (verified for Q4: `images/resolve.ts:12-20`, `images/status.ts:139-160`; the first start may pull the image, which the session already shows).

- From Templates (`then: "open-editor"`): on success the sheet closes and the app navigates to `/templates/$name` (the editor is the result).
- Stacked from New agent (`then: "return"`): on success it closes and the parent's Template is set to it.

## 8. New task

### 8.1 Prefill (Q8, Q20)

| Opened from | Assignee |
|---|---|
| An agent's session (`c`), any AgentMenu "New task" | that agent |
| Tasks list with an `assignee` filter (header button, `c`, palette) | the filter's agent |
| Anywhere else | Unassigned |

Prefill applies only to an empty draft (§5.5). A prefilled sheet's description reads "For Priya Nair".

### 8.2 Sheet

`TaskForm` keeps its validation (`features/tasks/task-form.tsx`), takes the draft key and initial values, and orders its fields Title, Assignee, Description (the long field last, so a prefilled assignee is on screen above a phone keyboard). **More options** holds Dependencies and Links, closed unless the draft has any or a field inside has an error (Q8). Footer "Create task", Close. On success: close, clear the draft, toast "Created T-42." with "Open" (navigates to `/tasks/$key`) (Q7). A dismiss while creating follows §6.2's late-result rule ("Created T-42." · Open, or the error with "Open form").

## 9. Schedules

### 9.1 New schedule sheet

`ScheduleForm` in the sheet with its draft key; Target prefilled per §5.6 when the draft is empty; When per §9.3. Its `useBlocker` unsaved-changes guard is not used in sheets (dismissing never asks; the draft is kept). Footer "Create schedule", Close. On success: close, clear the draft, toast "Created S-8." with "Open" (opens its Edit sheet). The Schedules list's page-to-page inline outcome (`schedule-list.tsx:119-130`, `PageOutcome`) is removed: one feedback channel (Q7).

D1: Q7 proposed no toast when the sheet was opened over `/schedules`; the list may be filtered so the new row isn't shown, so New schedule always toasts, like New task.

### 9.2 Edit schedule sheet (Q3)

Header: the key in mono as the title, the body's first line as the description (truncated, full in the body). Header action before Close: Pause or Resume (a ghost icon button with a tooltip and the name "Pause S-12"). Body: the state line (`ScheduleState`, created by, last written by, last run, "Done.", the pending-run note, action errors) as today, then the form. Footer: "Save changes", Close, and on its left a ghost crimson "Delete schedule" (away from Close).

- **Delete** is immediate (forgiveness over confirmation, as today): close, clear the draft, toast "Deleted S-12." with Undo (`restoreSchedule`). An Undo refused (`target_ended`) toasts the server's message.
- **Deleted state** (a `ScheduleBadge` clicked days later, or deleted by an agent while open, which flips live and keeps the draft): "S-12 was deleted." and, unless the target ended, a Restore button; below, the schedule as text (target, when, zone, the message rendered as markdown), not disabled fields. Restore succeeds in place: the sheet becomes the live form, with the draft's edits kept; no toast (its control is still there).
- **Not found:** "There is no schedule S-12." with Close.
- **Save:** close, clear the draft; no toast when the sheet was over `/schedules`, else "Saved S-12." (Q7).
- Live updates: the touched/untouched merge (§5.5).

### 9.3 Presets and summary (Q10, Q26)

When stays a segmented control (Repeats / Once). In Repeats mode the first field is a `Select` labelled "Repeats": Every hour (`0 * * * *`), Daily at 09:00 (`0 9 * * *`), Weekdays at 09:00 (`0 9 * * 1-5`), Mondays at 09:00 (`0 9 * * 1`), Custom cron…. A preset shows nothing more: the Select's label already says when it runs, and the next-runs preview below carries the zone. An existing schedule whose cron matches no preset opens on Custom.

Custom shows the cron input, a "Cron help" disclosure holding today's syntax text, and a summary line from `describeCron(cron)` (`features/schedules/describe-cron.ts`, hand-written, no dependency) ending with the zone the preview uses: "Weekdays at 09:00 (Europe/Berlin)". The summary line's height is always reserved in Custom so the preview doesn't jump as a cron is typed. Rules:
- `*/N * * * *` with N dividing 60 → "Every N minutes"; `0 */N * * *` with N dividing 24 → "Every N hours"; `M * * * *` → "Every hour at :MM";
- `M H * * *` → "Daily at HH:MM"; `M H * * 1-5` → "Weekdays at HH:MM"; `M H * * d[,d]` (up to three days, `0` and `7` both Sunday) → "Mondays and Thursdays at HH:MM";
- `M H D * *` with D ≤ 28 → "Monthly on the Dth at HH:MM" (correct ordinals: 1st, 2nd, 3rd, 21st, 22nd, 23rd);
- anything else, including ranges other than `1-5`, D of 29–31 and step expressions not listed: no summary (the preview still shows).

Time zone moves directly under When. The next-runs preview (`RunPreview`) sits right under the Repeats field (apple C1). Once mode is unchanged. The message body loses its mono costume (taste T-M7: Geist).

## 10. Toasts (decisions 3 and 22)

### 10.1 Library and component

`sonner`, exact-pinned: `pnpm --filter @open-factory/web add --save-exact sonner@2.0.8`. The repo sets no release-age option, so the effective policy is pnpm 12.21.0's default `minimumReleaseAge` of 1440 minutes (verified: a plain `pnpm add` picks a 29-hour-old release over a 23-hour-old one); 2.0.8 was published 2026-08-09. It has no dependencies and peers on React ≥18. Never loosen the policy; record its value and the publish date in the PR.

`components/ui/toaster.tsx`: one `<Toaster />` in the `_app` layout and a `notify()` helper; nothing else imports `sonner` (a grep test).

```ts
notify({ text: string; action?: { label: string; run(): void }; undo?: () => Promise<void> }): void
```

- **Look:** `toastOptions={{ unstyled: true, classNames }}` (in 2.0.8 `unstyled` is a toast option, not a Toaster prop): a floating plate (`bg-popover`, `border-float-edge`, 6px radius), no shadow (decision 11), 13/18 text, the action and Undo as ghost buttons. `expand` is on, so toasts list with an 8px gap instead of Sonner's scaled, peeking stack.
- **Overrides:** Sonner injects unlayered CSS that applies even when unstyled: 400ms `transform`, `opacity` and `height` transitions, an enter from `translateY(100%)`, a collapsed stack scaled 5% per toast, and under reduced motion `transition: none !important`. `styles.css` gets an unlayered `!important` block beside the Vaul block, pinned to 2.0.8 with a guard test (as `drawer.test.tsx` guards Vaul's attributes): enter opacity + `translateY(8px)` → 0 over 200ms `--ease-out`; exit back to that start over 150ms (Sonner unmounts at 200ms); stack shifts as a `transform` transition, 200ms `--ease-out`; no `height` transition; reduced motion keeps the opacity fade only.
- **Position (Q7, Q27, D2):** chosen from `useIsMobile()` (Sonner's own `mobileOffset` only applies under its 600px media query). Desktop: bottom-left of the content area; the left offset is the sidebar's current width variable plus 16px, applied as a `transform` transition of 200ms `--ease-in-out` that follows the sidebar's collapse (instant under `data-instant`, for ⌘B). Phones: bottom-centre. On every width the bottom offset is 16px plus `--composer-h`, a CSS variable on `<html>`: bottom-docked composers (the session and inbox-reply composers, not a task comment composer mid-page) register their `ResizeObserver` height in a module-level set, and the variable is the set's maximum (0 when empty), so one composer unmounting never zeroes it while another is mounted and a toast never covers a docked composer; on phones also above `env(safe-area-inset-bottom)`.
- **Layering:** the Toaster sits at z-40 (the `!important` override block sets `z-index` on `[data-sonner-toaster]`, whose injected value is 999999999), below the z-50 sheet and dialog scrims, so an open sheet dims any toast; closing a sheet and the toast appearing read as one gesture. A modal Radix Dialog or Vaul drawer marks its body siblings `aria-hidden`, toaster included, so a toast raised while a modal layer is open would not be announced: `notify()` holds toasts while a modal layer is open (the same selector `lib/shortcuts.ts` uses) and shows them when the last one closes. A toast already showing when a modal opens stays visible, dimmed; it was announced when it appeared (Q27).
- **Timing:** at most 3 visible; `duration` = max(5000ms, 60ms per character of the text) (touch has no hover-pause); paused on hover, focus and hidden tab (Sonner's built-ins).
- **Undo:** the first click disables it, runs `undo()` and dismisses the toast; a failure shows a new toast with the server's message, or "Couldn't undo: can't reach the server." Archive/unarchive and schedule restore have no server time limit (`apps/server/src/routes/agents.ts:126-134`, `scheduling/schedule-service.ts:500`), so a toast never outlasts the server's undo.
- **Gesture:** Sonner's swipe-to-dismiss stays on touch; DESIGN.md Gesture UI lists it as an accepted exception (a CSS snap-back, like Vaul's).
- **Accessibility:** Sonner's live region announces the text; Alt+T focuses the toasts; the action is reachable with Tab.

### 10.2 The outcomes that toast

| Outcome | Toast | Called from |
|---|---|---|
| Agent created after the sheet was dismissed | "Created @slug." · Open | new-agent sheet |
| Task created | "Created T-42." · Open | new-task sheet |
| Schedule created | "Created S-8." · Open | new-schedule sheet |
| Schedule deleted | "Deleted S-12." · Undo | edit-schedule sheet |
| Schedule saved, sheet not over `/schedules` | "Saved S-12." | edit-schedule sheet |
| Agent saved, not only header fields on its own session | "Saved @slug." | edit-agent sheet |
| Agent saved with a restart | "Saved @slug. Restarts when idle." | edit-agent sheet |
| Agent archived from a menu | "Archived @slug." · Undo | AgentMenu |
| Agent restored from a menu | "Restored @slug." | AgentMenu |
| Agent re-synced from a menu or the timeline link | today's re-sync outcome text | AgentMenu, timeline-row |
| A menu action that failed after its menu closed | "Couldn't archive @slug: <message>" (and the like) | AgentMenu |
| A create that failed after its sheet was dismissed | the error · Open form | create sheets |
| An Undo that failed | the server's message, or "Couldn't undo: can't reach the server." | toaster |

Nothing else toasts. A created agent navigates to its session; stacked sheets fill their parent field; anything whose control is still on screen keeps `InlineOutcome`.

## 11. Mobile pass

"Phone" means `useIsMobile()` (below 48rem); "touch" means `(pointer: coarse)`.

### 11.1 `AdaptiveMenu` (Q14)

`components/ui/adaptive-menu.tsx` exposes the subset of `DropdownMenu` the app uses (`AdaptiveMenu`, `Trigger`, `Content`, `Item` with `asChild`, `variant="destructive"` and `onSelect`, `Separator`, `Label`, `Shortcut`). At 48rem and up it renders the U1 `DropdownMenu`; below, a bottom `Drawer`. Chosen at open, like `Sheet`.

- **Drawer look:** a visible one-line muted title naming the target ("Priya Nair", "Message from Priya Nair · 17:55", "S-12"; every consumer passes one); items as full-width 44px rows (`steel-hover` pressed fill, destructive in crimson); separators as rules; `Shortcut` hidden; a destructive last item separated from Cancel by a rule and 8px; Cancel last.
- **The row** keeps `steel-selected` while its menu is open.
- **Opening on touch:** a trigger opens on `click` for touch and pen, on `pointerdown` only for a mouse (Radix's rule). `RowMenu`'s lazy mount (`row-menu.tsx:155-162`, which today opens on any pointerdown) keeps its mount-on-intent but follows this rule, so starting a scroll on a ⋯ never opens a drawer.
- **Selecting:** `onSelect` runs in the same tick the close starts. When the item opens another overlay (Edit, New task, New schedule, Archive's or Terminate's confirmation), the menu drawer closes instantly (`data-instant`) and only the new overlay rises, so two drawers never cross on the same edge; other items close the drawer normally. Focus handoffs (`AgentMenu`'s `handoff.current`) keep working; tested both ways.
- **A target that vanishes:** the menu is rendered by an owner keyed by the target's id that isn't unmounted with the row; if the target disappears while the menu is open (an agent terminated, a schedule deleted, a list re-sorted), the menu closes.

Consumers: `RowMenu` (timeline), `AgentMenu` (sidebar, Agents page, session header), schedule rows, Settings rows (`MoreButton` users). No row keeps a bare `DropdownMenu`. Task, inbox and Templates rows have no menu in U4 (Q23).

### 11.2 Long-press accelerator (Q13, Q23)

`hooks/use-long-press.ts`: `useLongPress(onLongPress)` returns pointer and `contextmenu` handlers active only for `pointerType === "touch"`. It fires at 500ms and is cancelled by more than 8px of movement, `pointercancel` (a scroll starting), `pointerup` before 500ms, or a second pointer. On fire: `navigator.vibrate?.(10)` (absent on iOS; nothing relies on it), `onLongPress()`, the click that follows the release is swallowed, and so is the first `pointerup` inside the opened menu (on a tablet, where the menu is a dropdown, lifting the finger over an item must not select it). A dropdown opened by long-press anchors to a virtual element at the press point. `contextmenu` from a touch press on a long-press region is `preventDefault`ed (Android Chrome otherwise shows its link menu over ours); never on prose.

**Feedback** starts on pointer-down: after 80ms the row's own box takes DESIGN.md's pressed fill (6% deeper; on the timeline, the row's card or block, never the gutter), cleared on cancel; no scale (D3: DESIGN.md forbids scaling full-width rows). Timeline rows aren't `.of-row`, so they get the fill through a `data-pressed` attribute the hook sets.

**Where (Q23):** only rows that have a menu.
- Sidebar agent rows: the whole row. They keep U2's choice of no ⋯ on touch (`styles.css:721-735`, U2 spec §8.4); long-press is their only menu path on touch, and the session header's ⋯ is one tap away. The PR body says so, so Or can revisit it if it proves undiscoverable (Q23).
- Agents-page rows (with their new `AgentMenu`, §6.5), schedule rows, Settings rows: the whole row; their ⋯ stays visible on touch.
- Timeline rows: the speaker line, a tool row's summary line and the row's gutter only; never message prose, so a long-press on text selects it. The ⋯ stays visible on touch (DESIGN.md).
- `-webkit-touch-callout: none` and `user-select: none` apply only to those chrome regions.

### 11.3 Hit areas (Q15)

On coarse pointers every standalone control has a hit box of at least 40×40px:
- **Icon buttons** (`icon`, `icon-sm`, `icon-xs`, `icon-lg`) and small text buttons outside forms get a `pointer-coarse:` `::after` expander (`absolute`, inset `min(0px, (100% - 2.5rem) / 2)` on each axis) so the glyph keeps its size. The button is `relative`.
- **An expander never overlaps a form control or prose.** Buttons inside forms ("Change", "Add credential", "New template", "Add project", "Add secret", "Cron help", More options, "Discard") grow to 40px on coarse pointers with real padding, and the form's gaps grow to fit, instead of an overlay. The timeline ⋯ on coarse pointers is a 32×40px visible box in its gutter (chat M5), with no expander over the text.
- **Neighbours:** in toolbars and header groups whose expanders would overlap, the visible size on coarse pointers becomes 40px (`size-10`) with a 4px gap.
- **Clipping:** no ancestor of an expanded control may clip it (`overflow: hidden` truncation wrappers, the sheet header); the probe in §2.8 hit-tests the box corners with `elementFromPoint`.
- **Non-Button controls:** the sidebar `+` and row actions use `after:-inset-2` (36px, `sidebar.tsx:420,552`); they move to the same 40px rule.
- `default`, `lg` and `sm` text buttons outside forms are 40px tall on coarse pointers.
- Dense rows keep their heights (sidebar 36px on touch); drawer menu items are 44px (§11.1).

### 11.4 Phone composer (#107, Q16)

Below 48rem the shared `Composer` (`components/composer/composer.tsx`):
- The toolbar row inside the frame holds attach, `/` and `@` as 40px ghost icon buttons on the left and, at its right end (the frame's bottom-right corner), **Stop** then **Send**. The textarea gets no extra padding, so nothing reflows when a turn opens or closes (DESIGN.md: the composer's height never changes then).
- **Send** is a 40px primary icon button (arrow-up, `aria-label="Send"`).
- **Stop** is a 40px outline icon button (filled square, `aria-label="Stop"`; "Stopping…" as its accessible name and an sr-only status while pending). Its slot stays reserved whether or not a turn is open (today's rule), 8px from Send. It differs from Send by shape (outline square vs filled arrow), never only by colour.
- Write/Preview and the hint line are hidden; the hint stays in the textarea's accessible description, and while a turn is open the placeholder carries the queued-message hint ("Sends after @x's current step").
- Growth is DESIGN.md's rule (6 lines or 35svh); Enter adds a line on touch (unchanged). The command chip and attachment chips keep their places.
- At 48rem and up U3's layout is unchanged. The inbox reply and task comment composers follow the rule (they are the same component).

### 11.5 Headers on phones (Q17)

Verify, don't rebuild: below 48rem the session header shows the avatar, name, short status, Agent details and one ⋯ (`AgentMenu`, now an `AdaptiveMenu` drawer); Stop is only in the composer. Other `PageHeader` actions below `sm` are icon-only with `aria-label` (Tasks already is). The evidence pass checks every page header at 320 for the badge/action overlap (break H3) and fixes any that remains.

### 11.6 Lists, dialogs and drawers on phones

- **Agents tree (break M1, #102):** below 48rem the status column is the status shape with its label sr-only; the name has `title={displayName}`; the second-line wrapper takes `min-w-0 max-w-full`; the new ⋯ fits the row. The 390 overflow (#102) is reproduced first and its cause named in the PR.
- **Templates at 320 (break M7):** header actions icon-only below `sm`; row metadata wraps (`flex-wrap min-w-0`).
- **ConfirmDialog:** title and description take `[overflow-wrap:anywhere]` in both branches (break Redesign 5); the confirm button wraps to two lines rather than truncating (DESIGN.md).
- **Sheets as drawers:** each sheet in §6–§9 is checked at 390 with the keyboard open (WebKit): the focused field stays visible (Vaul's input repositioning), the footer is reachable, inputs are 16px on touch (no iOS zoom; `input.tsx` and `textarea.tsx` already use `pointer-coarse:text-base`). A stacked child opened while the keyboard is up is in the check (two Vaul roots repositioning).

## 12. Template editor (decision 23, Q11)

### 12.1 Dependencies

Official packages only, exact-pinned (`--save-exact`), each the newest release allowed by the effective policy (pnpm's default 1440 minutes, §10.1) at install time; record each version and publish date in the PR. Verified allowed on 2026-11-22: `@codemirror/state` 6.7.6, `@codemirror/view` 6.43.15, `@codemirror/language` 6.13.1 (bracket matching, highlighting; brings `@codemirror/streamparser`), `@codemirror/commands` 6.11.1, `@codemirror/lang-yaml` 6.1.3, `@codemirror/lang-json` 6.0.2, `@codemirror/lang-markdown` 6.5.2, `@codemirror/lint` 6.9.8, and `@lezer/highlight` 1.2.5 (a direct import for the highlight `tags`). No `codemirror` meta-package and no third-party wrapper. No autocomplete, search or fold extension is enabled (`@codemirror/autocomplete` arrives transitively through `lang-yaml` and stays unused). If an install is blocked, stop and report; never loosen the policy.

Markdown uses `new LanguageSupport(markdownLanguage)`, not `markdown()`, which embeds HTML, CSS and JavaScript (the self-review's build: 195.5 kB gzip with `markdown()`, 130.2 kB with `markdownLanguage`). Budget: the editor chunk is at most 135 kB gzip.

### 12.2 Wrapper

`features/templates/code-editor.tsx`, loaded with `React.lazy` from `template-editor.tsx` only, preloaded by the template route's loader when it runs for a real navigation (`if (!preload)`), so hovering a template link elsewhere doesn't fetch it. Props as `CodeTextarea` (`value`, `onChange`, `onBlur`, `onSave`, `id`, `describedBy`) plus `language: "yaml" | "json" | "markdown"`, `fileKey` (template + file), `states` (the state map), `diagnostics: { line: number; column?: number; message: string; severity }[]`, and an imperative handle `{ focusLine(line: number): void }` replacing the textarea ref the jump code uses (`serveJump`).

- **Per-file state:** `TabsContent key={f}` (`template-editor.tsx:345`) unmounts inactive tabs, so the `EditorState` map lives in `TemplateEditor` (a ref keyed by `fileKey`) and is passed down; a remounted tab restores its state, so undo history survives tab switches and never crosses files (Q11). A reload or a conflict's "Use theirs" replaces that file's entry; the map is dropped when `TemplateEditor` unmounts.
- **Controlled the CodeMirror way:** user edits flow out through an update listener (`onChange(doc)`); an external value change (reload, a conflict's "Use theirs") dispatches one replace transaction with `addToHistory: false` and a `external` annotation the listener ignores, so a reload doesn't mark the file dirty. No effect recreates the view on a keystroke.
- **Extensions:** `lineNumbers`, `history`, `drawSelection`, `bracketMatching`, `indentOnInput`, the language, a `HighlightStyle` from tokens (§12.3), `keymap` with `defaultKeymap`, `historyKeymap`, `indentWithTab` and Mod-s → `onSave`, `EditorView.lineWrapping` for AGENTS.md only, `lintGutter({ hoverTime: 400 })` (DESIGN.md tooltip delay) and `setDiagnostics`. No live linter: validation stays on blur and save.
- **Leaving with the keyboard:** Esc then Tab moves focus out (CodeMirror's tab-focus mode with `indentWithTab`, verified headless); the "Esc then Tab to leave the editor" hint stays in the description.
- **Accessibility:** `EditorView.contentAttributes` sets `id`, `aria-labelledby` (the tab's label), `aria-describedby` (field descriptions + hint) and `aria-multiline`; the gutters are `aria-hidden`.
- **AGENTS.md:** its Write view uses the shared `MarkdownEditor` (also used by the task and schedule forms). `MarkdownEditor` gains a `writeSurface` render prop; only the template editor passes the CodeMirror surface. Preview is unchanged.
- **Loading swap:** until the chunk resolves, the tab renders today's `CodeTextarea`, padded by the gutter's width so text doesn't shift; on swap, the text, selection, scroll position and focus carry over, instantly.

### 12.3 Theme

`EditorView.theme` uses DESIGN.md tokens only: the surface `--code-bg`, edge `--code-border` with the field focus ring on `focus-within`, Geist Mono 13/20 (16px on coarse pointers, so iOS doesn't zoom on focus), the signal caret, and `.cm-selectionBackground` (and its `.cm-focused` variant) at the 26% signal tint. Syntax colours are new CSS variables `--syntax-keyword`, `--syntax-string`, `--syntax-number`, `--syntax-comment`, `--syntax-property`, `--syntax-punctuation`, `--syntax-heading`, `--syntax-link` for light, dark and `prefers-contrast: more`, taken from the Shiki GitHub themes the markdown code blocks use, except that no token may fall in the signal hue band (about 30–50° in oklch: GitHub's `#e36209` and `#ffab70` are swapped for the nearest non-orange), because orange means live or focused (Pilot Light rule). Below 48rem the separate lint gutter is dropped and the line number of a line with a diagnostic takes the marker's colour and shape through a small `gutterLineClass` extension on the line-number gutter, saving ~16px.

### 12.4 Markers

Validator issues for the open file become diagnostics: a gutter mark (warning or error shape, not colour alone), a wavy underline from the column to the line's end (or the whole line), and the message on hover and on keyboard focus of the line. The issues list stays the primary list and is reachable beside the editor at 390 (touch has no hover); its jump-to-line uses `focusLine`. Issues without a line get no marker.

### 12.5 Scope kept

`template.yaml` (YAML), `settings.json` and `mcp.json` (JSON), AGENTS.md (markdown, Write/Preview kept). The unsaved-changes guard, conflict handling, Save and validation are unchanged.

### 12.6 Real-browser checks and fallback

Run in the evidence pass, side by side against the textarea on the same template, in Chromium and WebKit (Playwright), desktop and 390 touch emulation:

| Check | Method | Passes when |
|---|---|---|
| Typing | type a 200-line YAML at one key per frame; record input latency | no dropped characters; p95 key-to-paint within one frame of the textarea |
| IME | Chromium CDP `Input.imeSetComposition`/`insertText` (Japanese); WebKit composition events | composed text lands once; Enter during composition inserts no newline and doesn't save |
| Undo | edit, switch tabs, edit, undo across both | per-file history; no undo crosses files; a reload isn't undoable |
| Screen-reader labelling | Playwright accessibility snapshot | role `textbox`, multiline, named by the tab, described by the hint and field descriptions |
| Phone editing | 390 touch emulation, both engines | a tap places the caret, typing works, selection handles work, focus doesn't zoom, no sideways page |

If any check is worse than the textarea, the editor ships nowhere: `CodeTextarea` stays, the dependencies are removed, and the PR reports the failing check with its evidence to Or (decision 23, Q11: all-or-nothing; Q19: PR4 ships as "textarea kept" or is closed). The chunk's gzip size and proof that no other route loads it are in the PR either way.

## 13. break-ui leftovers (decision 14, Q18)

### 13.1 Blockers in lists (M6)

`BlockedMarker` (`features/tasks/status-label.tsx:63`) takes `max` (default all); task list rows pass 3: "Blocked by T-15, T-16, T-17 +22 more", the full list in `title` and unchanged in the rail. The separator before the marker is drawn by the marker (`before:content-['·']`) so it can't orphan on a wrap.

### 13.2 Name and email lengths (L5)

`packages/shared/src/schemas.ts`: user `name` `max(80)` and `email` `max(254)` in `signUpSchema` (the sign-up form; there is no profile-edit form or schema in the app). The server enforces both in better-auth's `hooks.before` middleware (`apps/server/src/auth/options.ts:70-73`, scoped to `/sign-up/email` and `/update-user`), with the length checks placed **before** that middleware's existing early returns (`!p.nameTaken`, no `handle` in the body), so they always run. A refusal throws better-auth's `APIError` with a field-shaped body the sign-up form already maps to field errors (the plan names the mapping from `routes/sign-up.tsx`). `/update-user` is checked server-side only. Invites carry no email (`users/invites.ts`). Input only: no migration; stored longer values stay readable and aren't validated on read; an update that doesn't send `name` doesn't fail on an old long name.

### 13.3 Scroll restoration on Back (M5), last and timeboxed

Reproduce with the worst-case data first. Fix inside the Agents page: render the usage cell at its final width while usage loads (row heights don't change), and let TanStack Router's scroll restoration run after the list query settles (`scrollRestoration` with a per-route key, restoring once data is present). If the fix needs router-wide scroll changes, defer it to a follow-up issue with the reason (Q18). Timebox: half a day.

## 14. DESIGN.md amendments

- **Overlays:** after the ladder table: "Every create and edit form is a sheet opened over the page you are on, from every entry point; a form never has its own page. Sheets are not addressed by URL; old form URLs open the sheet over their list. A sheet belongs to the page it opened over and closes, instantly, when you leave that page, keeping its draft. Its dismiss button says Close, and a sheet that reopens with a kept draft says so, with Discard. A prerequisite missing from a form (a credential, a template, a project, a secret) is created in a sheet stacked over it and selected on return. A stacked sheet is 48px narrower than its parent (on phones, shorter), and names it."
- **Toasts:** "Bottom-left of the content area, clear of the sidebar; bottom-centre on phones; always above a mounted composer, and under any open sheet's scrim. A plate with `float-edge`, no shadow, listed (not stacked); at most three; at least 5 seconds, longer for long text, paused while hovered, focused or hidden. Undo never outlasts what the server can restore."
- **Motion → Durations:** "Toasts 200ms in (opacity and an 8px rise), 150ms out, stack shifts 200ms."
- **Gesture UI:** "On touch, an overlay trigger opens on click, never on pointer-down. Long-press on a row's chrome prevents the native context menu there, never on text. Sonner's swipe-to-dismiss is a CSS snap-back, accepted like Vaul's."
- **One row menu:** "On touch, long-pressing a row that has a menu opens it: the whole row in lists; on the timeline, the speaker line, tool line or gutter, never text. 500ms, cancelled by movement or scroll, with the pressed fill as feedback. Below `md` every row and header menu opens as a bottom drawer with a title naming the row and 44px items."
- **Buttons, Layout and the `control-touch` token (`DESIGN.md:113`, `:251`, `:283`):** "On coarse pointers every standalone control has a hit area of at least 40px, extended invisibly where the glyph is smaller, except next to a form control or text, where the control itself grows; dense rows keep their height."
- **Composers:** "Below `md` the toolbar holds attach, `/` and `@` as icons on the left and Stop and Send as 40px icons at its right end, without Write/Preview or the hint."
- **Forms (new line):** "Create forms show the fields that define the thing and fold the rest under More options, which opens itself, saying why, when something inside needs attention. An identifier derived from a name is shown as a line with Change, never asked first."
- **Schedules (new line):** "Repeats offers presets in a select; a cron is the Custom case, with a summary that names its time zone."
- **Template editor (new line, only if §12.6 passes):** "Template files are edited in CodeMirror with line numbers, syntax colours from the same tokens as code blocks (never orange), and validator markers on their lines."

The behaviour docs in `docs/product/behavior/` (gitignored) describe inline Undo for Archive (`agents-and-sessions.md:19`) and schedule Delete (`administration.md:24`); U4 doesn't edit them. A follow-up issue asks the owner to update them (§18).

## 15. Files the PRs share

Stacked PRs touch some files more than once; the plan orders tasks so each overlap is a rebase, not a conflict of intent:
- `features/templates/template-editor.tsx`: PR2 (the "Create agent" entry point, one line) and PR4 (the editor).
- `components/markdown/markdown-editor.tsx`: PR1 (draft-backed forms) and PR4 (`writeSurface`).
- `features/tasks/task-list.tsx`, `status-label.tsx`: PR3 (phone rows) and PR5 (M6).
- `routes/_app/agents.index.tsx`, `features/agents/agent-tree.tsx`: PR2 (row menu, empty state), PR3 (phone rows) and PR5 (M5).
- `DESIGN.md`, `styles.css`: every PR, in separate sections.

## 16. Testing and evidence

Unit and component tests (Vitest, jsdom) per section: the store and host (open, swap, stack, instance ids, close only on a later pathname change, not on search changes or the redirect itself, preload ignored), redirects and bad params, drafts (keep, announce, discard, clear on submit and sign-out, prefill only into an empty draft, stale references, touched/untouched merge), `deriveSlug` (fold map, suffix at 40, empty), `describeCron`, More options' reasons and non-animated self-open, each stacked sheet's `onDone` and focus return, late results after dismiss, the `notify` call-site grep, the Sonner CSS guard, `AdaptiveMenu` at both widths (click-to-open on touch, instant handoff, vanishing target), `useLongPress` (timers, movement, cancel, swallowed click and pointerup, contextmenu, prose excluded), the hit-area class contract, the phone composer, AgentMenu grouping and Restore, `BlockedMarker` max, schema and better-auth limits.

Headless-browser evidence pass at the end of each PR (§17), under these resource rules (the machine was overloaded during U3):
- Only one evidence pass runs at a time across all devs, and evidence passes and full-suite runs never overlap. Vitest runs locally with `--maxWorkers=50%`; tasks run targeted tests; the full suite runs only at PR end.
- Each pass uses a throwaway database and home, the fake Claude (never real Claude credentials), light and dark, 1440, 390 and 200% text (plus 320 and 1024 for the mobile PR), Chromium and WebKit where touch matters, and the break-ui worst-case seed where rows matter.
- Each pass kills its browser, server, Vite and throwaway DB when it ends, in a `trap`/`finally`, and leaves no headless Chrome running (checked with `pgrep`).
- Screenshots and probe output go in the PR; each pass has one budgeted fix round.

## 17. Delivery (Q19)

Five stacked PRs on `u3/5-shared-composer` (#117). Every PR body links this spec and the decision issue.

| PR | Branch | Contents | Depends on |
|---|---|---|---|
| 1 | `u4/1-sheets` | sheet store, host, drafts, redirects; Sonner `Toaster`, `notify` and its CSS; New task sheet; New and Edit schedule sheets with presets and summary; task and schedule entry points; DESIGN.md overlay, toast and motion amendments | #117 |
| 2 | `u4/2-agent-sheets` | New and Edit agent sheets (state split, address line, More options), stacked Add credential/project/secret and New template, New template from Templates, AgentMenu grouping with New task/New schedule/Re-sync/Archive/Restore, AgentMenu on Agents-page rows, prerequisites and AgentActions removal, agent entry points; DESIGN.md forms amendment | PR1 |
| 3 | `u4/3-mobile` | `AdaptiveMenu` everywhere, long-press, hit areas, phone composer, header verification, Agents tree and Templates on phones, #102, ConfirmDialog wrapping; DESIGN.md mobile amendments | PR2 (its evidence covers the new sheets and menus as drawers) |
| 4 | `u4/4-template-editor` | CodeMirror wrapper and theme, markers, the §12.6 checks, or the documented fallback; droppable as a unit | code-independent of PR1–3 except §15; stacked on PR3 |
| 5 | `u4/5-leftovers` | M6, L5, M5 (last, timeboxed); depends on nothing in PR4 | stacked on PR4 |

Parallelism: dev A runs PR1 → PR2 → PR3. Dev B starts PR4 at once in its own worktree (its overlaps with PR1–2 are §15's one-line entry point and `MarkdownEditor`'s new prop) and rebases onto PR3 when it lands. Dev B starts PR5 after PR3 lands (PR5 shares `task-list.tsx`, `status-label.tsx`, `agents.index.tsx` and `agent-tree.tsx` with PR2–3), stacked on PR4, and must not depend on PR4's code, so PR4 can be dropped. Evidence passes are serialized across both devs (§16).

## 18. Follow-up issues

1. #119 Android Back closes the top drawer or sheet (Q1).
2. #120 Sheets addressable by URL with reload restore, if ever wanted (Q1 rejected it for now).
3. #121 Row menus (and long-press) for task, inbox and Templates rows (Q23).
4. #122 Update `docs/product/behavior/agents-and-sessions.md:19` and `administration.md:24` for toast Undo and the moved lifecycle actions (gitignored; owner's docs).
5. M5 scroll restoration, only if §13.3 defers it.
6. CodeMirror, only if §12.6 falls back: what failed and what would need to change.
7. #83: close if U2's comboboxes cover the timezone and agent pickers; otherwise narrow it (checked during PR1).

## 19. Decision index

Proxy answers (certainty): Q1 in-memory sheets, thin redirects (3) · Q2 Edit agent is the form only (4) · Q3 Edit schedule sheet with a deleted state (4) · Q4 inline credential/project/secret/template, verified runnable (3) · Q5 address line with Change (4) · Q6 More options (4) · Q7 context-dependent toasts (4; desktop position 2, settled as bottom-left of the content area) · Q8 New task prefill (4) · Q9 drafts with the touched/untouched rule (3) · Q10 presets and a hand summary, no dependency (4) · Q11 CodeMirror (a) + bracket matching, all-or-nothing fallback (4) · Q12 one New template sheet (4) · Q13 long-press as an accelerator, ⋯ stays (3) · Q14 AdaptiveMenu (4) · Q15 40px hit areas (4) · Q16 phone composer (4) · Q17 verify the header (4) · Q18 leftovers in U4 (4) · Q19 five stacked PRs (4) · Q20 New task/New schedule in a grouped AgentMenu (4) · Q21 in-app links open sheets in place (4) · Q22 Restore in AgentMenu, AgentMenu on Agents-page rows, no shim for UndoArchiveLine (4) · Q23 long-press only where a menu exists, sidebar keeps no ⋯ on touch (3) · Q24 stacked sheet 48px narrower and named (3) · Q25 "Close" and "Draft restored · Discard" (4) · Q26 presets in a Select, one fact once (4) · Q27 toasts lifted above the composer, under the scrim but still announced, longer for long text (4).

Tech-lead decisions (from the reviews): D1 New schedule always toasts (§9.1) · D2 toast position and composer lift (§10.1) · D3 pressed fill instead of a 0.98 scale for long-press (§11.2) · D4 template descriptions inside the Select (§6.2) · D5 the avatar on the address line, no re-roll (§6.2) · D6 child sheets keep no draft (§5.5) · D7 a second Vaul `Root` with `noBodyStyles`, not `NestedRoot` (§5.3) · D8 `@codemirror/lint` for markers, no live linting (§12.2) · D9 syntax tokens from the Shiki GitHub themes, no orange (§12.3) · D10 `markdownLanguage` and a 135 kB budget (§12.1) · D11 the restart notice inline before Save (§6.4) · D12 New task fields Title, Assignee, Description (§8.2) · D13 New template asks Display name first (§7.4) · D14 Delete schedule in the footer's left (§9.2) · D15 the deleted schedule as text (§9.2) · D16 Send and Stop at the toolbar's right end, no textarea padding (§11.4) · D17 a menu item that opens an overlay closes the menu drawer instantly (§11.1) · D18 Sonner swipe kept as an accepted exception (§10.1) · D19 late results after a dismissed sheet toast and never navigate (§6.2) · D20 the Toaster below the sheet scrim (§10.1).
