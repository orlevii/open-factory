# U2 Navigation: Technical Design

- **Date:** 2026-11-21
- **Status:** draft for review; owner-proxy (owner-u2) answered Q1–Q29. Low certainty, for Or: see §21.
- **Source of truth (gitignored, read from the main checkout):** `docs/product/ui-review/decisions.md` (owner decisions 1–15, final), `docs/product/ui-review/status.md` (U2 backlog, file:line at `322075d`), the seven reviews in `docs/product/ui-review/` (paperclip.md is the main source), `docs/product/behavior/*.md`.
- **Builds on:** U1 (`u1/5-perceived-speed`, PRs #84–#88, decisions issue #77): the Sheet/Drawer/ConfirmDialog primitives, the control system, `data-instant`, the avatar tokens and DESIGN.md as amended there.
- **Followed by:** U3 chat (reuses `AgentChip` for speaker lines), U4 create flows and mobile (turns New agent/task/schedule into sheets behind the same actions U2 binds).
- **Decision log:** GitHub issue "U2: Navigation — decisions"; Q1–Q29 are the proxy's answers, D1–D12 are tech-lead decisions.

> `docs/product/` is gitignored. Paths into it are relative to the main checkout. Other paths are relative to the repo root; web paths are relative to `apps/web/src/` unless they start with `apps/` or `packages/`.

## 1. Goal

Make Open Factory navigable the way its first principle asks ("talk directly"): every live agent is one click away in the sidebar, any agent, task or page is one keystroke away in ⌘K, and the screens that today put "everything in one place" (the session strip, Settings, Templates + Images, the Inbox hop) are split along the overlay ladder of decision 1.

1. Agents in the sidebar as the reporting tree (decision 2), with generated avatars (decision 9).
2. A session right panel and a one-line header (decisions 4, 5).
3. Settings one route per section; Usage top-level (decision 4).
4. ⌘K palette, a small shortcut layer, and searchable agent and timezone pickers (decision 8, #83).
5. Inbox reading pane (decision 6) and task peek (decision 14).
6. Home redesign and Templates/Images views (decision 14).

## 2. Acceptance criteria

All run in default CI (`pnpm test`, `pnpm typecheck`, `pnpm lint`) unless marked manual.

1. **Sidebar tree.** With live agents A (root) → B → C and a spawned S under B, the sidebar renders A expanded, B collapsed showing "1 working" when C is working, and after expanding B shows C and S. Expansion survives a reload (localStorage). Opening `/agents/c` expands A and B, gives C's row the fill and the left tooth, and the "Agents" nav row is not active. The tree is one tab stop; ↑/↓/←/→/Home/End/Enter work per the APG navigation treeview. An `agent_status` frame for C re-renders C's row (and the ancestors' working counts) only (render-count test).
2. **Avatars.** `botParts(slug)` matches pinned golden vectors for ten slugs (a deliberate generator change must fail the test). An agent whose template has `avatar.svg` renders an `<img>` from `/api/templates/:name/avatar.svg?v=…`; an `<img>` error falls back to the generated face. The avatar route answers with `Content-Type: image/svg+xml`, `X-Content-Type-Options: nosniff` and the §15.3 CSP; `../x` and unknown names are 404; a file over 256 KB is 404 and the list reports no avatar.
3. **Unread per agent.** `GET /api/inbox/unread-count` returns `{ count, byAgent }`; `count` is unchanged; `byAgent` counts unread `message` and `mention` items by the sending agent's slug and nothing else (server test). A sidebar row shows its agent's count.
4. **Session panel.** At 1280px+ the panel is an in-flow column, open by default, toggled by `]` and the header button, remembered in localStorage. At 768–1279 the same button and `]` open a non-modal sheet (no scrim, the timeline stays clickable) that starts closed on every visit. Below 768 the button opens a bottom drawer. The strip is gone; the header shows the status badge and at most one live fact chosen by §8.2's priority. Toggling the panel at the bottom of the timeline stays at the bottom; scrolled up, the top visible row keeps its position (±1 row).
5. **Settings and Usage.** `/settings/{credentials,secrets,projects,users,factory}` each load only their own queries; `/settings` → `/settings/credentials`; `/settings#secrets?addSecret=X`-style old links land on the matching route with the add-secret form open; `/settings#usage` and `/settings?days=7` → `/usage?days=7`. Sidebar order: Inbox, Agents, Tasks, Templates, Schedules, Usage, Settings.
6. **Palette.** ⌘K / Ctrl+K opens the palette from anywhere, including from inside an input; it never animates. Typing `T-42` lists task T-42 first; typing a title fragment queries `GET /api/tasks?q=` (debounced) and lists ≤20 matches; agents filter client-side, live first, ended after with "Ended". `%` and `_` in `q` are literal (server test).
7. **Shortcuts.** `g i/a/t/s/u`, `c`, `]`, `?`, `j`/`k` work outside editable fields and do nothing inside them; `?` opens the shortcuts sheet.
8. **Pickers.** Manager, assignee (task detail and New task), the task list's assignee and creator filters, schedule target and timezone are cmdk comboboxes with typeahead; assigning pickers list live agents only; filters also list ended agents labelled "Ended"; arrow keys never commit an assignee (tasks.md).
9. **Inbox pane.** At 1024px+ selecting a row (click, Enter, `j`/`k`) shows it in the pane, marks it read and sets `?item=<id>`; Back returns to the previous selection; reload with `?item=` restores it (also for an item outside the first page, via `GET /api/inbox/:id`). Modifier-click and middle-click open the target in a new tab. Below 1024px rows navigate as today.
10. **Task peek.** In the task list `j`/`k` move the selection, Enter opens the page, Space opens a non-modal peek showing the task; `j`/`k` with the peek open retarget it; Esc closes it and returns focus to the row. A plain click still navigates.
11. **Home.** "Needs you" lists up to 5 newest unread items and every live errored or stuck agent; "Live now" lists working, queued and rate-limited agents with their live fact and "N of M running". Built from existing queries only.
12. **Templates/Images.** `/templates` and `/templates/images` are two views switched by a segmented control; `/templates#images` redirects; a build log opens in a non-modal sheet and streams there.
13. **Manual, recorded in each PR:** the 214-agent break-ui dataset in the sidebar (scroll, expand, a status storm with 4× CPU throttling: no long frames attributable to the tree; decides the virtualization follow-up), avatars at 16/20/24/48 in both themes (all 8 fills, ink contrast, the template override), the panel at 1279/1280/1440 and 768/767, the palette at 390 and 1440, the inbox pane at 1023/1024, Settings at 320, Templates at 320.

## 3. Scope

**In:** §5–§15, the DESIGN.md amendments in §16 and the behavior-doc edits in §17.

**Out:**
- U3: speaker identity in the timeline (U3 reuses `AgentChip`), the activity line ("Working · Bash `pnpm test`"), Stop in the composer, the shared composer, `/` and `@` completion.
- U4: New agent, New task, New schedule and Edit agent as sheets (U2's `+`, `c` and palette actions keep pointing at the existing pages; U4 swaps the destination, not the binding), the mobile pass.
- Not owned by any spec and staying out (Q19): breadcrumbs, hover cards, sticky form footers, first-step empty states (paperclip L1–L4); one umbrella follow-up issue lists them.
- Not built in U2 (follow-up issues, §19): panel resize, sidebar virtualization (only if the 214-agent measurement lags), a trigram index for task search (only if slow), per-agent avatar upload or re-roll.

## 4. U2 checklist

| # | Item (status.md U2 # / source) | Where |
|---|---|---|
| 1 | Agents in the sidebar: active-row rule, depth cap, per-row subscription, name `title`s, footer name `title` (U2 #1; break L4, L6) | §6 |
| 2 | Avatars, status as a corner badge (U2 #2) | §5.1 |
| 3 | Session right panel; one-line header; strip removed; terminated state; column alignment (U2 #3) | §8 |
| 4 | ⌘K palette and shortcut layer (U2 #4) | §10 |
| 5 | Settings routes; Usage top-level; one "Credentials" heading (U2 #5) | §9 |
| 6 | Inbox reading pane; read rows de-emphasised; previews without raw markdown (U2 #6) | §11 |
| 7 | Agents page: identity first, continuous tree lines, runtime only when exceptional (U2 #7) | §7 |
| 8 | Home redesign (decision 14, paperclip M3) | §13 |
| 9 | Task peek and list keyboard (decision 14, paperclip M4) | §12 |
| 10 | Templates/Images layout, build log in a panel (decision 14, paperclip M5) | §14 |
| 11 | Sheet `modal={false}` peek mode (U1 Q18) | §5.2 |
| 12 | Searchable pickers incl. timezone (#83, U1 Q12) | §10.4 |

## 5. Shared building blocks

### 5.1 Avatars (`components/agent-avatar.tsx`, `lib/factory-bot.ts`)

**Generator (Q4, Q20).** `lib/factory-bot.ts` is pure and has no dependency:

```ts
export function fnv1a32(s: string): number            // FNV-1a, 32-bit, over the UTF-16 code units of s
export interface BotParts { head: 0|1|2|3; eyes: 0|1|2|3|4|5; mouth: 0|1|2|3; accessory: 0|1|2|3|4; fill: 1|2|3|4|5|6|7|8 }
export function botParts(slug: string): BotParts      // fields taken from successive bit ranges of fnv1a32(slug), each mod its count
```

- Seed: the slug (immutable), so no column, migration or API change. Spawned agents get their own face from their own slug, at full opacity (Q4, certainty 3).
- Parts: head 4 (rounded square, circle, capsule, **flat-topped** hex: a pointy-top hex draws the reserved 30° roof, Q20), eyes 6, mouth 4, accessory 5 (antenna, visor, bolt, headset, none). 480 combinations, 8 fills.
- Drawing: `BotSvg({ parts, size })` renders one inline `<svg viewBox="0 0 24 24">`, the head filled with `var(--avatar-N)` (dark theme uses the `night-avatar` values through the same variable), features in `--foreground`-ink, a 1px `rule` edge. If a fill fails 3:1 for the ink features at 16px in either theme (checked in the PR, Q20 fix 3), that fill's features use the light ink (`--background`) instead; the choice is a static per-fill table in the file, not computed at runtime.
- Golden test: `factory-bot.test.ts` pins `botParts` for ten slugs (including `lead`, a 40-char slug and a spawned `dev-abcd`). A generator change that moves any face must update the vectors deliberately.

**Template override (Q5).** If the agent's template folder holds `avatar.svg`, every agent of that template (spawned included) uses it, read live from disk, no re-sync. The templates list carries `avatarVersion: string | null` per template (§15.3); the avatar renders `<img src="/api/templates/<name>/avatar.svg?v=<avatarVersion>" alt="">` and falls back to the generated face on `error`. `useTemplateAvatars()` selects a `Map<template, version>` from the templates list query (`select`, stable reference), so an avatar never fetches a 404 to find out.

**Component.**

```ts
AgentAvatar({ slug, template, size, status? }: { slug: string; template: string; size: 16 | 20 | 24 | 48; status?: AgentStatus })
AgentChip({ agent, size = 20, slug = false, status = false }: { agent: Pick<AgentSummary, "slug"|"displayName"|"template"|"status"|"kind">; size?: 16 | 20 | 24; slug?: boolean; status?: boolean })
```

- `aria-hidden` always; the name is always beside it (the rail's tooltip and sr-only label carry it there).
- Status badge (Q3, Q25): bottom-right corner, on a 2px ring in the surface colour behind it (`--avatar-ring`, set by the row: sidebar, plate or popover). `working` draws the tooth (`.of-tooth`, scaled to 4×8 below size 24); `queued`, `rate_limited`, `errored` draw the 6px status dot (4px below 24); `idle`, `hibernated` and `terminated` draw nothing. The status word is always present as text (tooltip and sr-only in the sidebar, the status column elsewhere).
- Sizes used: 16 (palette, comboboxes, inbox rows), 20 (sidebar, Agents page, task assignee, panel Org, Home), 24 (session header), 48 (top of the panel). No other size.
- `AgentChip` = avatar + display name (truncating, `title` = full name; a spawned name keeps its " · ab12" tail via the existing `AgentName`) + optional muted mono `@slug`. It is the one way U2 shows an agent: sidebar, Agents page, session header, panel, inbox, Home, palette, comboboxes, task list and task detail assignee (Q20). U3 reuses it.
- Memo: `AgentAvatar` is `memo`; `botParts` is computed in a `useMemo` on `slug`.

### 5.2 Peek sheets: `Sheet` gains `modal` (U1 Q18)

`Sheet({ open, onOpenChange, modal = true, children })`. With `modal={false}` on desktop (≥768):

- Passed through to Radix Dialog `modal={false}`: no scrim, no focus trap, no scroll lock, `aria-modal` absent; the page behind stays usable.
- `onInteractOutside` and `onFocusOutside` are prevented in `SheetContent` when non-modal, so clicking the list behind (to pick the next item) doesn't close it. Esc (Radix's document-level listener) and the Close button close it.
- Focus: opening moves focus into the sheet only when opened by a click on its trigger; opened from the keyboard on a list (`Space`), focus stays on the list (`onOpenAutoFocus` prevented) so `j`/`k` keep working. Close returns focus to the element that had it at open.
- `SheetContent` accepts `width?: "sheet" | "panel"`: `sheet` is the existing `w-[min(30rem,100%)]`; `panel` is `w-[min(20rem,100%)]` (the session panel overlay).
- Motion is the sheet's (250/200ms, `--ease-drawer`/`--ease-out`), and the per-opening `data-instant` stamp makes a keyboard-opened peek instant.
- Below 768 the adaptive Sheet still renders the Vaul bottom drawer, always modal (a phone peek covers the screen anyway).
- Consumers: the session panel at 768–1279 (§8), the task peek (§12), the build log (§14), the shortcuts sheet (§10.3).

### 5.3 Shell-level live state (D1)

- `useAgentStatusFrames()` moves into `AppLayout` (`routes/_app.tsx`), mounted once; the five page-level calls (`session-view.tsx:43`, `home-agents`, `agents.index`, `agents.$slug_.edit`, `settings/factory-section`) are removed. The list query `agentsListQueryOptions("exclude")` is subscribed by the sidebar, so it is always warm.
- The frame patch keeps the identity of every unchanged agent object (it already maps only the matching slug, `use-agent-status.ts:44`); a test pins it, because per-row selectors (§6.4) depend on it.

### 5.4 Per-browser preferences (D2)

`lib/prefs.ts`: `usePref<T>(key, fallback, parse)` over `localStorage` with `useSyncExternalStore` (a `storage` listener keeps tabs in sync, as the theme does), every read and write in `try/catch` (private mode works, with the fallback).

| Key | Value | Used by |
|---|---|---|
| `of-tree-expanded` | JSON `{ [slug]: boolean }`, explicit overrides of the default (roots open, the rest closed); pruned to live slugs on write | §6 |
| `of-session-panel` | `"open"` \| `"closed"` (absent = open) | §8, ≥1280 only |
| `of-recent-agents` | JSON array of the last 8 opened slugs | §10.2 ranking |

### 5.5 Breakpoints (D3)

One module, `lib/breakpoints.ts`, exports the queries as rem so they follow the text size, as U1 did for `md`: `MOBILE = "(width < 48rem)"` (existing), `INBOX_PANE = "(width >= 64rem)"`, `PANEL_INFLOW = "(width >= 80rem)"`. `useMedia(query)` uses the cached `MediaQueryList` pattern from `use-mobile.ts`. Layout decided by these is re-evaluated live (unlike an open sheet's primitive, which U1 latches at open: an open overlay panel stays an overlay if the window widens past 1280 until it closes).

## 6. Sidebar agent tree (PR1, PR2 for the row menu)

### 6.1 Placement

`AppSidebar` becomes: header (wordmark), the main nav (fixed), a rule, the **Agents** group (`SidebarGroup`, label "Agents" in 13/18 muted sentence case, a `+` group action with tooltip "New agent" linking to `/agents/new`), which takes the remaining height and scrolls on its own (`min-h-0 flex-1 overflow-y-auto`), then the footer (user menu). The footer user name and handle get `title` (break L4).

Main nav (Q12): Inbox, Agents, Tasks, Templates, Schedules, **Usage**, Settings. While a session is open (`/agents/$slug` exactly), the "Agents" nav row is not active (Q3): `isActive` excludes the session route; `/agents`, `/agents/new`, `/agents/$slug/edit` and `/agents/$slug/usage` keep it active.

### 6.2 What it shows (Q2)

- Live agents only (`agentsListQueryOptions("exclude")`: persistent and live spawned; archived and terminated are on Agents → Ended).
- The reporting tree from `reportsTo`; a spawned agent's `reportsTo` is its spawner, so it nests under it.
- Order: the server's `treeOrder` (siblings by display name, then slug), never by status or activity.
- Expansion: roots open, everything else closed, overridden per slug by `of-tree-expanded`. Viewing `/agents/$slug` adds that agent's ancestors to the stored overrides as open (once per navigation, so the user can collapse them again).
- No row cap; the group scrolls. Indentation is 12px per level and stops growing at depth 4 (deeper rows keep their tree position and aria-level but don't indent further).
- Virtualization is not built; the PR records the 214-agent measurement (§2.13) and the follow-up issue is opened only if it lags (Q2).

### 6.3 Row anatomy (Q6)

32px (36px on coarse pointers, Q23), `px-2`, items in order:

1. Chevron slot, 16px: a ghost disclosure (`aria-hidden`; the treeitem's `aria-expanded` carries it) when the agent has children in the list; rotates 90° over 150ms on `--ease-out` (instant from the keyboard); empty slot otherwise.
2. `AgentAvatar` size 20 with its status badge (§5.1).
3. Display name, `min-w-0 truncate`, `title` = full name (spawned names keep the " · ab12" tail).
4. At the end, in this order, each only when non-zero: a collapsed manager's "N working" (muted 13px: working agents among all descendants, Q2), then the unread count for that agent (`byAgent[slug]`, ink, `tabular-nums`, capped "99+").
- Active row (the open session): `steel-hover` fill and the left tooth, exactly as a nav row (Q3).
- Hover (fine pointer): the row's ⋯ (`SidebarMenuAction`, ghost, 24px, `aria-label="Agent actions for <name>"`) replaces the counts' slot; right-click opens the same menu. The menu is `AgentMenu` with `context="sidebar"` (§8.4), PR2. Coarse pointers get no ⋯ in U2 (U4's long-press).
- Click or Enter: navigate to `/agents/$slug`; on mobile it also closes the drawer. Intent preload as every link.
- Tooltip (desktop, 400ms): "Name · Status" (`statusLabel`).

### 6.4 Rendering and data (D4)

- `features/agents/sidebar-tree.tsx`: `useAgentTreeShape()` selects from the agents list only `{ slug, displayName, reportsTo, depth }[]` joined into a string key, so the tree's structure re-renders only when an agent is added, removed, renamed or moved, never on a status frame.
- `SidebarAgentRow = memo(({ slug, level, expanded, hasChildren, active, tabbable }) => …)` reads its own agent with `useQuery({ ...agentsListQueryOptions("exclude"), select: (d) => d.agents.find((a) => a.slug === slug) })` (identity stable for unchanged agents, §5.3), so a frame re-renders that row only.
- Working counts: `useWorkingCounts()` selects a `Map<slug, number>` of working descendants for collapsed managers, compared by content (a custom `structuralSharing` or equality on a serialized key), so a frame re-renders only rows whose count changed.
- Unread: `useUnreadCount()` keeps returning `count` for the Inbox row; `useUnreadByAgent(slug)` selects `byAgent[slug] ?? 0` per row.

### 6.5 Keyboard and semantics

WAI-APG navigation treeview: `<nav aria-label="Agents">` wraps `<ul role="tree">`; each row is an `<a role="treeitem" aria-level aria-expanded? aria-current="page"?>` inside `<li role="none">`, children in `<ul role="group">`. Roving tabindex: one tab stop (the active row, else the first); ↓/↑ next/previous visible row; → opens a closed row or moves to its first child; ← closes an open row or moves to its parent; Home/End; Enter follows the link; typeahead on display name. Focus ring inset (DESIGN.md Rows).

### 6.6 Collapsed rail and mobile

- Icon rail: the same visible rows (same expansion state), avatar only, centred, no indent or chevron; the active row keeps the tooth; tooltip "Name · Status"; the unread count becomes a dot on the avatar's top-right (as the Inbox row does).
- Mobile left drawer (Q23): the same component; tapping a row closes the drawer.

### 6.7 Empty and loading

No live agents: the group shows one muted line "No agents yet." with "Create one" linking `/agents/new`. Loading: three static skeleton rows at 32px.

## 7. Agents page polish (PR1, status.md U2 #7)

`features/agents/agent-tree.tsx` rows, desktop: indent with **continuous** 1px tree lines in `rule` (a vertical line per ancestor level that still has later siblings, plus the elbow; drawn with one absolutely positioned element per level, not per-row `└` glyphs, so lines join across rows), then `AgentChip` (avatar 20, name, muted mono `@slug`), the status column (unchanged, with its live sub-line), the template only when it differs from the slug's stem (`slug` minus a trailing `-<suffix>`), "Unsandboxed" only when `runtime === "local"` (Docker is the default and is not shown), cost right-aligned with `tabular-nums`. Drawn depth caps at 8 levels on desktop and 3 below 768 (as today); deeper rows stop indenting. Mobile two-line rows stay U4.

## 8. Session header and right panel (PR2)

### 8.1 Layout

`SessionView` becomes a row: the main column (header, notices, timeline, composer) and, at ≥1280 with the panel open, `<aside aria-label="About @slug">` 20rem wide, `bg-card border-l`, full height under nothing (the header spans only the main column, so the panel has its own top). The strip (`agent-strip.tsx`) and `terminated-strip.tsx` are deleted; each segment moves as §8.2/§8.3 say.

Column alignment (Q27): the timeline and the composer share one column, `max-w-[52rem]`, the same horizontal inset (`px-4 md:px-6`), left-aligned as today.

| Width | Panel |
|---|---|
| ≥1280 | In-flow column, open unless `of-session-panel` is `"closed"`; toggling is instant from keyboard and click (Q24) |
| 768–1279 | `Sheet modal={false} width="panel"`, starts closed on every visit; sheet motion, instant from the keyboard |
| <768 | The adaptive Sheet's bottom drawer (modal) |

One control at every width (Q9): the header's panel toggle, a ghost icon button (`PanelRight`, `aria-label="Agent details"`, `aria-expanded`, `aria-controls`), plus `]`.

**Scroll anchoring (Q24).** `Timeline` observes its scroller's width (`ResizeObserver`). On a width change: if `atBottom`, stay pinned to the bottom; otherwise restore the first visible row's offset, tracked on scroll as `{ key, top }` (row `data-row-key` plus `getBoundingClientRect` relative to the scroller). This also covers the sidebar collapse and window resizes.

### 8.2 Header (Q8, Q21)

`[sidebar trigger] [avatar 24] [h1 name] [status badge] [live line] … [Stop] [Restart] [panel toggle] [⋯]`

- **Live line** (`features/session/live-line.tsx`): `liveFact(agent, ctx): LiveFact | null`, pure, the first that applies:
  1. terminated: "Terminated by @x · <time>" + workspace fate ("deletes Sun 21:53" / "pinned" / "deleted") + an inline Pin/Unpin button (the existing pin logic and its confirmation after the grace period);
  2. errored: the first line of `lastError` (full text in the tooltip);
  3. rate-limited: "until 15:30" (`rateLimitExact` false → "until about 15:30");
  4. queued: the existing detail (all N slots in use / credential paused / pulling image);
  5. restart pending: "Restarts when idle";
  6. waiting on: the first background task "pnpm test · since 14:02", plus "+N" when more;
  7. crons: "Kept awake by N crons".
  Times are absolute, never ticking. No fact → no line. The line is the first thing to give way (`min-w-0 grow basis-0 truncate`, as `HeaderSlug`), then the title (U1's 4rem floor). Below 640px the line hides; the panel's Now section carries it.
- **Stop**: today's `InterruptButton` (U1 stop glyph), only while `turnOpen`. U2 does not touch the composer (U3).
- **Restart**: today's `RecoveryActions`, visible only when errored.
- **⋯**: `AgentMenu context="session"` (§8.4).
- Removed from the header: Edit, Compact and Terminate buttons (into the menu).
- `documentTitle` unchanged.

### 8.3 Panel content (Q7)

`features/session/agent-panel.tsx`, `AgentPanel({ agent })`, the same component in all three containers. Sections in order, each a 13/18 medium heading and rows; no tabs, no cards:

1. Identity: `AgentAvatar` 48, display name, `@slug`, description (muted, clamped to 3 lines with "More").
2. **Now** (only when something applies): every live fact, not just the header's one: all waiting-on tasks with their start times, crons with the existing Stop crons control (`CronsStopLayer`), restart pending with its Why popover, rate-limit and queued detail, the terminated facts with Pin.
3. **Org**: "Reports to" the manager (`AgentChip`, link to its session), reports and live spawned agents (`AgentChip` each, up to 8, then "All N on the Agents page").
4. **Work**: open tasks assigned to it, from `tasksListOptions({ status: "open_in_progress", assignee: slug })`'s first page, up to 5 rows (key, title, status), then "All N tasks" → `/tasks?assignee=`; schedules targeting it, from the schedules list filtered by target, up to 5 (`S-n`, next run), then "All N schedules". Both queries are enabled only while the panel is open.
5. **Usage** (decision 4): the 7-day estimated cost from `agentsUsageQuery("rolling7")` (already fetched by the session) + "Usage" link to `/agents/$slug/usage`.
6. **Runtime**: template (link), credential, image (and pulling), projects, "Unsandboxed" when local.
7. Footer actions: "Edit agent" (outline button; persistent and not archived). U1's pending outline-vs-ghost decision for standalone Edit buttons applies here if Or changes it.

No new endpoint (Q7). The panel has its own scroll (`overflow-y-auto`).

### 8.4 `AgentMenu` (Q6, Q8)

`features/agents/agent-menu.tsx`: `AgentMenu({ agent, context: "session" | "sidebar", trigger })`, a `DropdownMenu`. Items by context:

| Item | Session | Sidebar |
|---|---|---|
| Open session | — | ✓ |
| Agent details (`]`) | ✓ (also the header toggle) | — |
| Compact… | ✓ live, not errored: opens the existing `CompactPopover` anchored to the ⋯ trigger | — |
| Edit | ✓ persistent, not archived | ✓ same |
| Usage | ✓ | ✓ |
| Open tasks | ✓ | ✓ |
| Stop crons… | ✓ when crons are live (existing confirmation) | — |
| Terminate… | ✓ spawned, live; separator above, crimson, existing `ConfirmDialog` | — |

### 8.5 Data

`SessionView` already holds the agent and the 7-day usage. Tasks and schedules for the panel load in the panel (enabled while open). `useSessionPanel()` returns `{ open, toggle, mode: "inflow" | "overlay" | "drawer" }` from §5.4/§5.5; `]` registers through the shortcut layer (§10.3) only while a session is mounted.

## 9. Settings and Usage (PR3)

### 9.1 Routes

- `routes/_app/settings.tsx` becomes a layout: `PageHeader title="Settings"`, then a two-column body: a 180px sub-nav (`<nav aria-label="Settings">`, rows 32px, active row `steel-hover` fill and medium weight, no tooth: the tooth stays on the sidebar's Settings row) and an `<Outlet />`. Below 768 the sub-nav becomes a `Select` row ("Section") above the content.
- Children: `settings.credentials.tsx`, `settings.secrets.tsx` (search `addSecret?`), `settings.projects.tsx`, `settings.users.tsx`, `settings.factory.tsx`; each loader fetches only its own queries (credentials: `["credentials"]`; secrets: `["secrets"]`; projects: `["projects"]`; users: `["users"]`, `["invites"]`; factory: `["factory-settings"]`), preload-aware as U1 §10.2. Each keeps its section component and per-section error with Retry.
- `settings.index.tsx`: `beforeLoad` redirects by `location.hash` and search: `#credentials|secrets|projects|users|factory` → that route (with `addSecret` carried to secrets); `#usage` or `days` → `/usage?days=`; anything else → `/settings/credentials` (Q12, certainty 3). `replace: true`.
- The "On this page" row, the hash scroll/focus plumbing and the `hashchange` listener are deleted.
- `routes/_app/usage.tsx`: `PageHeader title="Usage"`, the existing `UsageSection` content (range control, chart, per-agent table, per-credential table), search `days` (7/30/90, default 30). The per-credential table's heading becomes "By credential" so the app has one "Credentials" heading (taste T-M5).
- Links updated: `prerequisites.tsx:56`, `agent-form.tsx:553,653`, `project-grant-picker.tsx:45`, `timeline-row.tsx:230` point at the new routes (`to="/settings/credentials"` etc.); the redirects keep old bookmarks working.
- All users are equal admins (administration.md), so the sub-nav shows every section.

## 10. Palette, shortcuts and pickers (PR4)

### 10.1 Dependency

`cmdk@1.1.1`, `pnpm --filter @open-factory/web add --save-exact cmdk@1.1.1` (decision 8; published 2025-03-14). Its `@radix-ui/react-dialog ^1.1.6`, `react-id`, `react-primitive`, `react-compose-refs` resolve to the versions `radix-ui` already brings. pnpm has no `minimumReleaseAge` set; nothing in the supply-chain settings changes.

### 10.2 Palette (`features/palette/command-palette.tsx`)

- Form (Q26): `Command.Dialog`, a floating layer at top-centre: `top-[15vh] w-[min(40rem,calc(100%-2rem))]`, popover look (`bg-popover border border-float-edge rounded-lg`, no shadow), modal (focus trapped, Esc closes, focus returns), the 20%/40% scrim, and **no animation ever**: content and overlay carry `data-instant` unconditionally.
- Open: ⌘K / Ctrl+K anywhere (also from inside inputs), and a "Search" row at the top of the sidebar nav (`⌘K` hint) for discoverability. Mounted lazily: the palette module is `lazy()`-imported on first open, and preloaded on `pointerenter`/`focus` of the sidebar Search row.
- `shouldFilter={false}`; our ranking (`features/palette/rank.ts`, pure, unit-tested):
  - **Agents** (client-side: the live list is complete, `agentsListQueryOptions("exclude")`; ended from `agentsListQueryOptions("only")`, enabled while the palette is open): exact slug or name match, then prefix, then recent (`of-recent-agents`), then substring in tree order; live before ended; ended labelled "Ended" (Q10, certainty 3). Row: `AgentChip size=16 slug`. Enter opens the session; ⇧Enter opens it and focuses the composer.
  - **Tasks**: input matching `/^t-\d+$/i` → `GET /api/tasks?keys=T-42` (exists); otherwise, from 2 characters, `GET /api/tasks?q=<input>&status=all&limit=20` debounced 150ms (`tasksSearchOptions(q)`, key `["tasks", "search", q]`, `placeholderData: keepPreviousData`). Row: key, title, status. Enter opens `/tasks/$key`.
  - **Go to**: Inbox, Agents, Tasks, Templates, Images, Schedules, Usage, and each Settings page.
  - **Actions** (Q28): New agent, New task, New schedule, Agent details (session pages only), Theme: System / Light / Dark, Keyboard shortcuts. "Mark all read" is not offered: its `upTo` cutoff must be the newest item the user has loaded, and the palette has loaded none.
- Empty query: Go to and Actions, plus the recent agents.
- `aria-activedescendant` combobox semantics come from cmdk.

### 10.3 Shortcut layer (`lib/shortcuts.ts`)

- One `keydown` listener on `window`, installed in `AppLayout`. Handlers register with `useShortcut(key, handler, { enabled })` (a module-level registry; latest registration for a key wins, so a page can scope `j`/`k`).
- Ignored when `event.target` is editable (`input`, `textarea`, `select`, `[contenteditable]`, a cmdk input), when any modal layer is open (`[role=dialog][aria-modal=true]`, `[role=alertdialog]` in the document), on IME composition, or with Ctrl/⌘/Alt (except ⌘K/Ctrl+K, handled by the palette).
- Bindings (Q11): `g` then `i`/`a`/`t`/`s`/`u` within 1s → Inbox/Agents/Tasks/Schedules/Usage; `c` → New task (today `/tasks/new`; the same action the palette's "New task" runs, so U4 changes one place); `]` → session panel toggle (session pages); `?` → the shortcuts sheet; `j`/`k` → inbox and task list (§11, §12).
- Everything opened by a shortcut is keyboard-initiated and instant (the U1 stamp).
- **Shortcuts sheet** (`?`, Q11): `Sheet modal={false}` titled "Keyboard shortcuts", a two-column list grouped Global / Lists / Session; the same list is the palette's "Keyboard shortcuts" action.

### 10.4 Combobox and pickers (#83, Q22)

- `components/ui/combobox.tsx`: a trigger styled exactly as U1's `Select` trigger (height, plate, `field-edge`, focus ring, chevron) opening a `Popover` with a cmdk `Command` (input + list, `max-h-72` scroll). Props: `value`, `onValueChange`, `options: { value; label; keywords?: string[]; group?; disabled?; render? }[]`, `placeholder`, `emptyText`, `aria-label`. Arrow keys move the highlight only; a value commits on Enter or click (tasks.md: assignee never commits on arrows). Popover motion is the U1 popover's; keyboard-opened is instant.
- `AgentCombobox({ value, onValueChange, scope: "live" | "live+ended", allowNone? })`: options rendered with `AgentChip size=16 slug`, keywords `[slug, displayName]`; "Ended" group last for `live+ended`.
- Swaps: manager in `agent-form.tsx` (live persistent only, as today's rule), assignee in `tasks/assignee-menu.tsx` and the New task form (live), schedule target in `schedule-form.tsx` (live), the task list's assignee and creator filters (`live+ended`), and the timezone picker (`Intl.supportedValuesOf("timeZone")`, keywords include the offset), replacing the last `NativeSelect` (it is then deleted along with U1's exception sentence in DESIGN.md).
- The task status menu, credential select and other short fixed lists stay as they are.

## 11. Inbox reading pane (PR5)

### 11.1 Layout (Q14)

- Route search gains `item?: string`.
- ≥1024 (`INBOX_PANE`): `/inbox` renders a list column `w-[23.75rem] shrink-0 border-r` (its own scroll) and the pane (`min-w-0 flex-1`, its own scroll). No item selected: the pane shows one muted line "Select an item to read it here."
- Selecting: a plain left click on a row (no modifier, button 0) calls `preventDefault`, navigates to `?item=<id>` (push, so Back steps through selections) and marks the item read through the existing optimistic `useOpenItem`. The row stays an `<a href>` to the real target, so modifier-click, middle-click and "copy link" keep opening the target (inbox.md "read when opened" unchanged).
- `j`/`k` (and ↓/↑ via the existing `row-nav`) move focus and select; Enter on a focused row selects it; `o` is not added. The selected row has the `steel-hover` fill and `aria-current="true"`.
- <1024: rows navigate as today; `?item=` is ignored (and dropped by a `replace`).
- Rows (status.md U2 #6): read rows show sender and preview in `ink-muted`; unread rows keep the ink dot and medium weight. Previews are plain text: `plainPreview(markdown)` (pure, `features/inbox/preview.ts`) strips fences, inline code ticks, emphasis, links (keeps their text), headings and list markers, and collapses whitespace (break L3). Sender shown with `AgentChip size=16` for agent senders.

### 11.2 Pane content (Q15)

Header (48px, own rule): sender (`AgentChip` 20 or the human/factory name), time, and "Open in session" / "Open task" (an outline link button to the exact target).

- **message**: `SessionExcerpt({ slug, seq })`: `GET /api/agents/:slug/events?around=<seq>&limit=7` (existing), rows built with `rows.ts` and rendered with `TimelineRow` read-only (no copy links, no tab-key plumbing), the target row highlighted with the existing deep-link highlight; then the session `Composer` as-is (`slug`, `agent` from the live list; urgent toggle included), sending to the sender's session. If the sender is terminated or archived, `TerminatedComposer`'s read-only line replaces it.
- **mention**: the task header (key, title, status, assignee `AgentChip`), the 3 comments before the mentioned one and the comment itself (from `taskDetailOptions(key)`), then `CommentComposer` for that task prefilled with `@author ` (the existing `prefill` handle).
- **task_event**: the task header and the fact ("Done" / "Cancelled", by whom, when) and "Open task"; no composer.
- An item not in the loaded pages (reload with an old `?item=`): fetched with `GET /api/inbox/:id` (§15.4, Q29), so the pane always resolves; a 404 shows "This item no longer exists."
- Switching items replaces the pane content instantly (no crossfade; "frequency decides"). The pane's scroll resets to the top per item; the composer's draft is per target (the session composer already keys its draft by slug).

## 12. Task peek (PR5, Q16)

- Task list: `j`/`k` alias ↓/↑ in `row-nav` for the tasks list; the focused row is the selection.
- Space on a focused row opens `Sheet modal={false}` (width `sheet`) with `TaskPeek({ taskKey })`: a header (key, title, "Open" link to `/tasks/$key`) and `TaskDetailView` in a container-query layout (`@container` in `SheetBody`; the 280px rail stacks under the body below `@lg`), comments included, composer included.
- With the peek open, `j`/`k` (focus stays on the list, §5.2) retarget the peek to the newly focused row. Esc closes and leaves focus on the row. Space again closes.
- A plain click on a row still navigates; Enter opens the page.
- Data: `useTaskDetail` already seeds from the list row (`placeholderData`), so the peek paints at once.
- Below 768 the Sheet's drawer shows the same content (U4's mobile pass may revisit).

## 13. Home (PR6, Q17)

`routes/_app/index.tsx`: `PageHeader title="Home"`, two plates side by side from `lg`, stacked below (`Panel` components as today):

- **Needs you**: the 5 newest unread inbox items (`["inbox-home"]`, existing `HomeInbox` rows) followed by every live agent that is errored or stuck (`AgentChip`, its live fact from `liveFact()`, link to its session). Empty: "Nothing needs you."
- **Live now**: agents working, queued or rate-limited (`AgentChip`, status badge, `liveFact()`), tree order, frozen under the pointer (U1's rule), header count "3 of 8 running" from `["supervisor"]`. Empty: "No agent is working." No agents at all: "No agents yet. Create your first agent." with the link.
- Existing queries only; no Home endpoint.
- Alternative recorded for Or (Q17, certainty 3): drop Home and land on `/inbox` (inbox.md calls the inbox the home screen; the sidebar tree already shows who is working). Switching is a one-line answer: `/` redirects to `/inbox` and `index.tsx` is deleted.

## 14. Templates and Images (PR6, Q18)

- `routes/_app/templates.index.tsx` and a new `templates.images.tsx`: both render a `PageHeader` whose actions are a `SegmentedControl` "Templates | Images" (changes route; `onChange` navigates) and, on the Templates view, New template. Below 640 the actions go icon-only (break M7).
- `/templates#images` → `/templates/images` (`beforeLoad` on the index reading the hash); `timeline-row.tsx:213` links the new route.
- Images rows show status only; "Build log" (ghost, per row) opens `Sheet modal={false}` titled "<image> build log" with the existing `BuildLog` streaming inside and the Build button in its footer. The inline expanding log is removed.

## 15. Server changes

### 15.1 Unread per agent (PR1, Q13)

`GET /api/inbox/unread-count` → `{ count: number, byAgent: Record<string, number> }` (`packages/shared/src/messaging.ts` schema). `byAgent` = unread `inbox_items` of kind `message` or `mention` joined to `messages` on `message_id`, grouped by `messages.from_agent_id` → agent slug; `task_event` and `@factory` items (no `from_agent_id`, or kind `task_event`) count for no agent. One extra `GROUP BY` on the same partial unread index; `count` stays the global badge's only source. Same `inbox_changed` invalidation.

### 15.2 Task search (PR4, Q10)

`GET /api/tasks` `listQuerySchema` gains `q: z.string().trim().min(1).max(200).optional()`. With `q`: `title ILIKE '%' || escaped(q) || '%' ESCAPE '\'` where `escaped` doubles `\` and escapes `%` and `_`; if `q` matches a task key exactly (`/^T-\d+$/i`), that task is first. Ordering otherwise the list's (newest updated first). `limit` applies (the palette sends 20). No trigram index (follow-up if slow).

### 15.3 Template avatar (PR1, Q5)

- `GET /api/templates` entries gain `avatarVersion: string | null`: `"<mtimeMs>-<size>"` of `<templatesDir>/<name>/avatar.svg` when it exists, is a regular file and is ≤256 KB; else null.
- `GET /api/templates/:name/avatar.svg`: same auth as the other template routes; `:name` is looked up in the template index (unknown → 404; the path is built from the index entry, never from the raw param); missing, not a regular file or >256 KB → 404. Response headers: `Content-Type: image/svg+xml`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `Cache-Control: private, max-age=31536000, immutable` (the URL carries `?v=`), `ETag` = the version.

### 15.4 One inbox item (PR5, Q29)

`GET /api/inbox/:id` → `{ item: InboxItem }` for the signed-in user's item; another user's or unknown → 404. Same row mapping as the list.

## 16. DESIGN.md amendments

Exact text; section names refer to DESIGN.md as of U1's top (`0e65634`). Each lands in the PR that implements it.

### 16.1 Front matter (PR1, PR2)

Add under `components`:
```yaml
  panel:
    backgroundColor: "{colors.plate}"
    width: "320px"
  avatar:
    size: "20px"
```

### 16.2 Colors → Agent identity (PR1, append)

> The generated avatar is a "factory bot" drawn from the agent's slug: a head (rounded square, circle, capsule or a flat-topped hexagon, never a 30° roof), eyes, mouth and an accessory in ink on one identity fill. Where ink falls under 3:1 on a fill, that fill's features are drawn in the light ink instead. The face never changes with status and never animates.

### 16.3 Layout (PR2, PR5, append)

> - **Right panel.** The session's About panel is an in-flow column on the right, 320px, a plate with a 1px rule on its left edge and no shadow, from 1280px (80rem). It is open by default, toggled by its header button and `]`, remembered per browser, and appears and disappears instantly (it is frequent, and a width animation would reflow the timeline). From 768px to 1279px the same button opens it as a peek sheet; below 768px as a bottom drawer. When a column's width changes, the timeline keeps its place: pinned to the bottom if it was, else the top visible row stays put.
> - **Two panes.** From 1024px (64rem) the Inbox is a list column (380px) beside a reading pane; selecting a row shows it in the pane. Below that, rows navigate.
> - **Sub-navigation.** A section with several pages (Settings) has a 180px sub-nav on the left of its content; its active row takes the fill without the tooth (the tooth stays on the sidebar row). Below 768px it becomes a select above the content.

### 16.4 Components → Navigation (PR1, replace)

> - **Navigation:** sidebar rows are 32px (36px on touch). The active row gets the `steel-hover` fill plus the tooth, and the icon rail keeps the tooth. Nav labels are capitalised product nouns. Below the nav, the **Agents** group lists live agents as the reporting tree. Agent rows are data rows, not nav labels, and keep the agent's display name: chevron, avatar with its status badge, name, then a collapsed manager's "N working" and the unread count. On an agent row the left tooth means only "you are here"; status rides on the avatar. Order is the tree's, never by activity. Roots start expanded, the rest collapsed, remembered per browser. While a session is open, its agent row is the active row and the Agents nav row is not.

### 16.5 Components (new bullets) (PR1, PR4)

> - **Avatars:** 16px in pickers, the palette and inbox rows; 20px in the sidebar, lists, the panel and Home; 24px in the session header; 48px at the top of the panel. Always decorative (`aria-hidden`): a name is always next to it. The status badge sits on the bottom-right corner on a 2px ring of the surface behind it: the tooth when working, the status dot when queued, rate-limited or errored, nothing at rest (idle, hibernated). An agent is shown with its avatar and name everywhere it is a subject (`AgentChip`).
> - **Command palette:** ⌘K / Ctrl+K from anywhere. A floating layer at the top centre, 640px wide, with the popover look (plate step, `float-edge`, no shadow) and the scrim; modal. It never animates, however it was opened. Groups: Agents, Tasks, Go to, Actions. Results never reorder while the query is unchanged.
> - **Combobox:** a searchable pick (agents, time zones) looks exactly like a Select and opens a popover with a filter field. Arrow keys move the highlight; only Enter or a click commits.
> - **Keyboard shortcuts:** single keys never fire while typing in a field or while a modal layer is open. `g` then a letter goes to a section; `c` new task; `]` the agent panel; `j`/`k` move through lists; `?` lists them all in a sheet.

### 16.6 Components → Overlays (PR2, edits)

- Ladder table: add a row `| Jump to anything | Command palette |` after the popover row.
- In the paragraph after the table, replace "A peek sheet does not dim or trap focus; the page behind stays usable; Esc and Close dismiss it." with: "A peek sheet (the agent panel below 1280px, a task peek, a build log, the shortcuts list) does not dim or trap focus; the page behind stays usable and clicking it does not close the peek; Esc and Close dismiss it. Opened from a list with the keyboard, focus stays in the list so `j`/`k` retarget the peek."

### 16.7 Components → Form controls (PR4, edit)

Replace "Native selects are used only where search beats a list (the timezone picker)." with "Where search beats a list (agents, time zones), the picker is a Combobox; there are no native selects."

### 16.8 Motion (PR2, PR4, append to "Frequency decides")

> Panels and panes that change the page's columns (the right panel at 1280px and up, the inbox pane, the settings sub-nav) appear instantly. The command palette never animates.

## 17. Behavior-doc edits (gitignored `docs/product/`, applied in the main checkout by the dev in the PR that changes the behavior, and listed in the PR description)

- `general.md` → Navigation (PR1, PR3, PR4): "Inbox, Agents, Tasks, Templates, Schedules, Usage, Settings; below them, live agents as the reporting tree (rows open the agent's session). ⌘K finds any agent, task or page; `?` lists the shortcuts."
- `agents-and-sessions.md` → Session view (PR2): the strip is replaced by "The header shows the status and at most one live fact (terminated, errored, rate-limited, queued, restart pending, waiting on, crons, in that priority); everything else is in the About panel (Now, Org, Work, Usage, Runtime), open at 1280px and up, toggled with `]`." Drop "The agent strip gains an org segment".
- `administration.md` → Settings (PR3): "Settings sections and order: Credentials, Secrets, Projects, Users, Factory, one page each with a sub-nav; `/settings` opens Credentials." Usage moves to its own top-level page `/usage`. Templates → Images (PR6): "a view of the Templates page (`/templates/images`); the build log streams in a side panel."
- `inbox.md` (PR5, PR6): add "On wide screens (1024px and up) the Inbox is a list and a reading pane: selecting an item opens it in the pane and marks it read; the pane shows the message with its surrounding session rows or the comment with its thread, and a composer that replies at the same target." Home's sentence becomes "Home's Needs you panel shows the 5 newest unread items."
- `tasks.md` (PR4, PR5): "The list is keyboard-navigable (`j`/`k`, Enter opens, Space peeks). Tasks are searchable by key or title (⌘K)."

## 18. Testing

TDD per change; Vitest + Testing Library (jsdom); server tests in the existing setup. Tests guard behaviour and regressions, never token values or DESIGN.md prose (U1 rule).

- **Pure units:** `fnv1a32`/`botParts` golden vectors; `liveFact` priority table; tree shape + expansion merge + working counts (`sidebar-tree` helpers); palette `rank`; `plainPreview`; shortcut dispatcher (editable targets, modal open, `g` sequences timeout with fake timers); `escapeLike`.
- **Components:** sidebar tree keyboard (APG keys, one tab stop), active row and the Agents nav row, rail and mobile drawer, render counts on an `agent_status` frame (`vi.mock` counters on `SidebarAgentRow`); `AgentAvatar` img fallback on error; `Sheet modal={false}` (no `aria-modal`, outside click keeps it open, Esc closes, focus stays when opened with `onOpenAutoFocus` prevented); session panel per width (mocked `matchMedia` at 1279/1280/767), `]`, persistence, the header's one fact; `Timeline` anchoring on a width change (mock `ResizeObserver`); `AgentMenu` items per context; Settings redirects (each old hash and `days`), per-route loaders' requests; palette (opens from an input with ⌘K, task key and `q` paths, ended label, no animation attribute); `Combobox` (arrows don't commit, Enter commits, typeahead by slug); inbox pane (click selects and marks read once, modifier click doesn't select, `j`/`k`, reload with `?item=` outside the page uses `GET /api/inbox/:id`, <1024 navigates); task peek (Space, retarget, Esc focus); Home plates; Templates/Images routes and redirect.
- **Server:** unread `byAgent` attribution (message, agent mention, human mention, task_event, factory), `q` with `%`, `_`, `\` literals and the exact-key-first rule, avatar route (headers, traversal, unknown, oversize, ETag), `GET /api/inbox/:id` (own, other user's, unknown).
- **Manual (recorded per PR):** §2.13.

## 19. Follow-up issues (opened with the decisions issue)

1. Session panel resize (paperclip L5: drag, arrow keys in 16px steps, double-click reset, persisted width).
2. Sidebar tree virtualization: opened only if the PR1 measurement with 214 agents shows long frames (Q2).
3. Trigram index for task title search: only if `q` is slow on real data (Q10).
4. Umbrella: unowned paperclip L1–L4 (breadcrumbs, hover cards, sticky form footers, first-step empty states), with why they are out of U2 (Q19).

## 20. Delivery

Six stacked PRs on top of U1's `u1/5-perceived-speed` (Q1), each based on the one below, each leaving the app working, each with its own CI and its own manual evidence. PR6 is last so it can be cut with a reason if needed.

| PR | Title | Contents |
|---|---|---|
| 1 | `feat: agent avatars and agents in the sidebar` | §5.1, §5.3, §5.4, §5.5, §6 (without the row ⋯), §7, §15.1, §15.3, `AgentChip` in task list/detail assignee, DESIGN.md §16.1 (avatar), §16.2, §16.4, §16.5 (Avatars) |
| 2 | `feat(web): session right panel and one-line header` | §5.2, §8, the sidebar row ⋯ (§6.3), `lib/shortcuts.ts` with `]` as its first binding, DESIGN.md §16.1 (panel), §16.3 (Right panel), §16.6, §16.8 |
| 3 | `feat(web): settings pages and a top-level Usage page` | §9, DESIGN.md §16.3 (Sub-navigation) |
| 4 | `feat: command palette, shortcuts and searchable pickers` | §10, §15.2, DESIGN.md §16.5 (Command palette, Combobox, Keyboard shortcuts), §16.7, §16.8 (palette); closes #83 |
| 5 | `feat: inbox reading pane and task peek` | §11, §12, §15.4, DESIGN.md §16.3 (Two panes) |
| 6 | `feat(web): Home redesign and Templates/Images views` | §13, §14 |

Behavior-doc edits (§17) go with the PR named there. The whole-stack React review and the spec-coverage walk run on PR6.

## 21. Decisions (summary; full log in the decisions issue)

| Q | Decision | Certainty |
|---|---|---|
| Q1 | Six stacked PRs; #83 pickers in PR4 with one Combobox | 4 |
| Q2 | Full live tree, roots open, collapsed below, per-browser expansion, no cap, indent stops at depth 4, roving tabindex, ancestors of the open agent expand | 4 |
| Q3 | Status on the avatar; left tooth = "you are here"; Agents nav row not active on a session | 4 |
| Q4 | Avatar seed = slug hash, no column; spawned agents full opacity | 4 / **3** |
| Q5 | `avatar.svg` only, live from disk, locked-down headers | 4 |
| Q6 | Row anatomy; ⋯ reuses `AgentMenu`; unread from the extended unread-count | 4 |
| Q7 | Panel: in-flow 320px ≥1280; Sheet `modal={false}` 768–1279; drawer <768; strip removed | 4 |
| Q8 | Header: badge, one fact, Stop, Restart when errored, ⋯, panel toggle | 4 |
| Q9 | `]` and one toggle button at every width | 4 |
| Q10 | Palette groups; server `q`; ended agents included after live | 4 / **3** (ended) |
| Q11 | Shortcuts incl. `c`; `?` opens a sheet | 4 / **3** (`c`) |
| Q12 | Settings routes; Usage top-level; `/settings` → Credentials | 4 / **3** (landing) |
| Q13 | `{ count, byAgent }` on the unread-count route | 4 |
| Q14 | In-flow inbox panes ≥1024, `?item=` | 4 |
| Q15 | Pane content; reuse `Composer` and `CommentComposer` | 4 |
| Q16 | Click navigates; Space peeks | **3** |
| Q17 | Home "Needs you" + "Live now"; drop-Home alternative recorded | **3** |
| Q18 | Templates/Images routes with a segmented control; log in a peek | 4 |
| Q19 | L1–L4 out, one umbrella issue; Agents page polish in PR1 | **3** / 4 |
| Q20 | Parts generator, flat-topped hex, golden vectors, ink contrast; `AgentChip` everywhere incl. assignee | 4 / **3** (generator vs identicon) |
| Q21 | Header live-fact priority | 4 |
| Q22 | Combobox pickers; live-only for assigning, ended in filters | 4 |
| Q23 | Same tree in the mobile drawer | 4 |
| Q24 | Panel instant ≥1280; timeline anchoring | 4 |
| Q25 | Avatar badge only for working, queued, rate-limited, errored; StatusBadge elsewhere unchanged | 4 |
| Q26 | Palette top-centre, modal, scrim, never animates; ladder row | 4 |
| Q27 | Timeline and composer share one left-aligned 52rem column | 4 |
| Q28 | No "Mark all read" in the palette | 5 |
| Q29 | `GET /api/inbox/:id`, own items only, 404 otherwise; the list's pages don't change | 4 |

Tech-lead decisions: D1 shell-level status frames; D2 `usePref` over localStorage; D3 rem breakpoints module; D4 per-row selectors; D5 "Mark all read" not in the palette (confirmed Q28); D6 inbox selection by push navigation; D7 no crossfade when switching inbox items; D8 palette lazy-loaded; D9 sidebar "Search" row; D10 Agents page depth cap 8; D11 no URL state for the task peek; D12 the avatar status badge at rest draws nothing (confirmed Q25).

## 22. Risks

- **Status storms with 200+ agents.** Per-row selectors depend on the frame patch keeping unchanged agents' identity (§5.3); a test pins it. The measurement in PR1 decides virtualization.
- **Radix non-modal Dialog quirks.** `modal={false}` closes on outside interaction by default; §5.2 prevents it. Two non-modal sheets can't be open at once (opening one closes the other, by owning one `peek` state per page).
- **cmdk inside a Radix Popover/Dialog** uses Radix Dialog itself; nested focus scopes are tested (combobox inside the task peek sheet).
- **SVG from disk.** Served only with the §15.3 headers and only rendered through `<img>`; a test asserts the headers.
- **Behavior docs are gitignored.** §17 edits are applied in the main checkout and listed in each PR, or they get lost.
- **Dependency on U1's pending decisions:** only the panel's "Edit agent" button (outline vs ghost) depends on it; it follows whatever Or picks.
