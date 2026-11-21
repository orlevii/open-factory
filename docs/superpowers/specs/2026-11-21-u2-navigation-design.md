# U2 Navigation: Technical Design

- **Date:** 2026-11-21
- **Status:** revised after the self-review and five UI-lens reviews (Taste, Apple design, Emil design-eng, Motion, Break UI); owner-proxy (owner-u2) answered Q1–Q40. Low certainty and deviations for Or: §21.
- **Source of truth (gitignored, read from the main checkout):** `docs/product/ui-review/decisions.md` (owner decisions 1–15, final), `docs/product/ui-review/status.md` (U2 backlog, file:line at `322075d`), the seven reviews in `docs/product/ui-review/` (paperclip.md is the main source), `docs/product/behavior/*.md`.
- **Builds on:** U1 (`u1/5-perceived-speed`, PRs #84–#88, decisions issue #77): Sheet/Drawer/ConfirmDialog, the control system, `data-instant` and `stampInstant`, the avatar tokens, DESIGN.md as amended there.
- **Followed by:** U3 chat (reuses `AgentChip` for speaker lines; owns Stop in the composer and Esc there), U4 create flows and mobile (turns New agent/task/schedule into sheets behind the same actions U2 binds).
- **Decision log:** GitHub issue #89 "U2: Navigation — decisions"; Q1–Q40 are the proxy's answers, D1–D14 tech-lead decisions.

> `docs/product/` is gitignored. Paths into it are relative to the main checkout. Other paths are relative to the repo root; web paths are relative to `apps/web/src/` unless they start with `apps/` or `packages/`.

## 1. Goal

Make Open Factory navigable the way its first principle asks ("talk directly"): every live agent is one click away in the sidebar, any agent, task or page one keystroke away in ⌘K, and the screens that today put "everything in one place" (the session strip, Settings, Templates + Images, the Inbox hop) are split along decision 1's overlay ladder.

1. Agents in the sidebar as the reporting tree (decision 2), with generated avatars (decision 9).
2. A session "Agent details" panel and a one-line header (decisions 4, 5).
3. Settings one route per section; Usage top-level (decision 4).
4. ⌘K palette, a small shortcut layer, searchable agent and time-zone pickers (decision 8, #83).
5. Inbox reading pane (decision 6) and task peek (decision 14).
6. Home redesign and Templates/Images views (decision 14).

## 2. Acceptance criteria

All run in default CI (`pnpm test`, `pnpm typecheck`, `pnpm lint`) unless marked manual.

1. **Sidebar tree.** With live agents A (root) → B → C and a spawned S under B, the tree shows A expanded and B collapsed with a working count (tooth + "1", accessible name "1 working") when C is working; expanding B shows C and S. Expansion toggled by the user survives a reload. Opening `/agents/c` reveals A and B (in memory, not persisted), scrolls C's row into view, and gives it the fill and the left tooth; the Agents row is not active. Opening an ended agent's session keeps the Agents row active. Clicking a chevron toggles without navigating. The tree is one tab stop with the APG navigation-treeview keys. With B expanded, an `agent_status` frame for C re-renders C's row only; with B collapsed, it re-renders B's row (its count) only (render-count tests).
2. **Avatars.** `botParts(slug)` matches pinned golden vectors for ten slugs. An agent whose summary carries `avatarVersion` renders the template's SVG over its generated face; an image error leaves the face. The avatar route answers with `image/svg+xml`, `nosniff` and the §15.3 CSP; an unknown name is 404, an invalid one 400, a file over 256 KB 404 and its version null. Badges: tooth (working), alert glyph (errored), filled dot (rate-limited), hollow ring (queued), nothing at rest; the same shapes in `StatusBadge`.
3. **Unread per agent.** `GET /api/inbox/unread-count` returns `{ count, byAgent }`; `byAgent` counts unread `message` items by sending agent only (server test: message, agent mention, human mention, task_event, factory). Viewing an agent's session (document visible) marks that agent's unread messages to you read up to the newest event the session loaded, through one idempotent call; a hover preload marks nothing.
4. **Agent details.** ≥1280: in-flow column, open unless the user closed it (remembered). 1024–1279: in-flow, closed on every visit. 768–1023: a non-modal sheet under the header. <768: bottom drawer. `]` and one header button toggle it at every width. The strip is gone; the header shows the status badge and at most one live fact (§8.2). Toggling at the bottom of the timeline stays at the bottom; scrolled up, the top visible row keeps its position within 1px.
5. **Settings and Usage.** `/settings/{credentials,secrets,projects,users,factory}` load only their own queries; `/settings` → credentials; `/settings?addSecret=X#secrets` → `/settings/secrets?addSecret=X` with the form open; `/settings#usage` and `/settings?days=7` → `/usage?days=7`. Sidebar, top to bottom after PR4: the Search button row, Inbox, Tasks, Templates, Schedules, Usage, Settings, then the Agents row and its tree.
6. **Palette.** ⌘K / Ctrl+K opens it from anywhere, including inputs, with no animation; typing `T-42` shows an "Open T-42" row first at once; typing a title fragment lists ≤20 server matches (`q`), as the last group; agents filter client-side, live before ended ("Ended"). `%`, `_` and `\` in `q` are literal (server test).
7. **Shortcuts.** `g i/t/s/u/a`, `c`, `]`, `?`, `j`/`k` work outside fields, menus, listboxes and the tree's typeahead, and do nothing inside them; `?` opens the shortcuts sheet; its "Single-key shortcuts" switch turns them all off (remembered).
8. **Pickers.** Manager, assignee (task detail and New task), the task list's assignee and creator filters, schedule target and time zone are comboboxes with typeahead; assigning pickers list live agents only; filters also list ended agents ("Ended"); arrow keys never commit; an agent value not in the options renders as `@slug` with its face; a human `@handle` value renders as text.
9. **Inbox pane.** At 1024px+, click or Enter selects a row (push `?item=`), marks it read and shows it; `j`/`k` move the selection (replace), the pane follows, and the item is marked read after `INBOX_DWELL_MS` of being shown; a key-repeat sweep marks nothing read (fake-timer test); ↑/↓ move focus only. Reload with `?item=` of an item outside the first page shows it (`GET /api/inbox/:id`). Modifier-click and middle-click open the target. Below 1024px rows navigate.
10. **Task peek.** `j`/`k` move the selection, Enter opens the page, Space opens a non-modal peek when the list keeps ≥24rem beside it (else opens the page); `j`/`k` retarget it in place; Esc closes it and focuses the selected row. A plain click navigates.
11. **Home.** "Needs you": up to 5 newest unread items, then live errored agents (capped at 8, "and N more"). "Live now": working, queued and rate-limited agents (capped at 8), header "2 working · 1 queued". Existing queries only.
12. **Templates/Images.** `/templates` and `/templates/images`, switched by a segmented control; `/templates#images` redirects; creating a template named `new` or `images` is rejected; a build log opens in a non-modal sheet and streams there; nothing overflows at 320.
13. **Manual, recorded in each PR:** the 214-agent break-ui dataset in the sidebar (scroll, expand, a status storm under 4× CPU throttling; decides the virtualization follow-up); a collapsed manager at depth 4 with working and unread counts; an active working row (two orange marks, Q3); the rail with 214 agents; avatars at 16/20/24 in both themes with the 3:1 ink table; the panel at 767/768/1023/1024/1279/1280 with a running agent; the session header at 1280 with an 80-character name, errored, panel open; a 500-row timeline with the sidebar collapse and the panel open (scroll anchoring frame cost); the palette at 390 and 1440; the inbox pane at 1023/1024 with an 11 KB single-line message; the task peek at 1024 and 1440; Settings at 320 and 800 with the sidebar open; Templates at 320.

## 3. Scope

**In:** §5–§15, the DESIGN.md amendments in §16, the behavior-doc edits in §17.

**Out:**
- U3: speaker identity in the timeline (reuses `AgentChip`), the activity line, Stop in the composer, Esc in the composer, the shared composer, `/` and `@` completion, clamping long single-line messages by length (break L1).
- U4: New agent, New task, New schedule and Edit agent as sheets (U2's `+`, `c` and palette actions keep pointing at the existing pages; U4 swaps the destination, not the binding), the mobile pass (long-press, row menus as drawers, the Settings section control on phones).
- Not owned by any spec (Q19): breadcrumbs, hover cards, sticky form footers, first-step empty states (paperclip L1–L4); one umbrella follow-up issue.
- Follow-up issues (§19): panel resize, sidebar virtualization (only if the measurement lags), a trigram index for task search (only if slow), a keyboard chord for the panel from inputs (Q37).

## 4. U2 checklist

| # | Item (status.md U2 # / source) | Where |
|---|---|---|
| 1 | Agents in the sidebar: active-row rule, depth cap, per-row subscription, full names on truncation (tooltip), footer name and handle (U2 #1; break L4, L6) | §6 |
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
| 12 | Searchable pickers incl. time zone (#83, U1 Q12) | §10.4 |

## 5. Shared building blocks

### 5.1 Avatars (`components/agent-avatar.tsx`, `lib/factory-bot.ts`)

**Generator (Q4, Q20).** `lib/factory-bot.ts` is pure, no dependency:

```ts
export function fnv1a32(s: string): number             // FNV-1a 32-bit over the UTF-16 code units
export interface BotParts { head: 0|1|2|3; eyes: 0|1|2|3|4|5; mouth: 0|1|2|3; accessory: 0|1|2|3|4; fill: 1|2|3|4|5|6|7|8 }
export function botParts(slug: string): BotParts       // successive bit ranges of fnv1a32(slug), each mod its count
```

- Seed: the slug (immutable): no column, migration or API change. Spawned agents get their own face, full opacity (Q4, certainty 3).
- Parts: head 4 (rounded square, circle, capsule, **flat-topped** hexagon: a pointy top would draw the reserved 30° roof), eyes 6, mouth 4, accessory 5 (antenna, visor, bolt, headset, none). 480 × 8 fills.
- Tokens: U1 defines `--avatar-1…8`; the dark block must redefine them to the `night-avatar` values (the dev verifies, and adds them if missing), so one `var(--avatar-N)` serves both themes.
- Drawing: `BotSvg({ parts, size })`, one inline `<svg viewBox="0 0 24 24">`: head in `var(--avatar-N)`, features in `--avatar-ink` (= `graphite-ink` in **both** themes: night-text on the night fills is ≈2.2:1, graphite ≈6.7:1; ≈4.9:1 on the light fills), a 1px `rule` edge. The face never changes with theme or status. The PR records a contrast table (8 fills × 2 themes, computed from the tokens) showing ≥3:1 at 16px, and a unit test computes the same table from the token values in `styles.css` so a retune that drops a fill below 3:1 fails.
- Golden test: `factory-bot.test.ts` pins `botParts` for ten slugs (including `lead`, a 40-char slug, `dev-abcd`). A change that moves any face must update the vectors deliberately.

**Template override (Q5).** If the agent's template folder holds `avatar.svg` (≤256 KB), every agent of that template (spawned included) uses it, read live from disk. `AgentSummary` gains `avatarVersion: string | null` (§15.3), so no avatar ever probes a URL and the sidebar never subscribes to the templates list. The avatar draws the generated face, and when `avatarVersion` is set lays `<img src="/api/templates/<template>/avatar.svg?v=<avatarVersion>" alt="" class="object-contain">` over it in the same box on a plate disc; on `error` the img hides (keyed on `src`, so a new version is tried again). No fade.

**Components.**

```ts
AgentAvatar({ slug, template, avatarVersion, size, status }:
  { slug: string; template?: string; avatarVersion?: string | null; size: 16 | 20 | 24; status?: AgentStatus })
AgentChip(props: { agent: AgentChipAgent } | { slug: string; name?: string },
          opts?: { size?: 16 | 20 | 24; slug?: boolean; badge?: boolean })
```

- `AgentChipAgent = Pick<AgentSummary, "slug" | "displayName" | "template" | "status" | "kind" | "avatarVersion">`.
- The slug form (`{ slug, name? }`) resolves the agent from the live list cache, then the cached ended list, else renders the slug-seeded face with `name ?? "@" + slug`. Call sites with a slug only use it: inbox senders whose `from.kind` is `agent`, the task assignee (`TaskAgentRef`), agent creators and comment authors (`TaskPrincipal` with `kind: "agent"`), and agent combobox values. Human principals (`kind: "user"`) and `@handle` values render as the handle in text with no avatar (`PrincipalChip` wraps both cases).
- `aria-hidden` always; a name is always beside it (in the rail, the tooltip and the sr-only label).
- **Badge (Q25, Q33)**, only when `badge` is set and only for list contexts (sidebar, Agents page, Home, inbox rows, comboboxes); never on the session header avatar (Q36). Bottom-right corner: working → the tooth (4×8 below size 24, else 6×12); errored → a filled alert glyph in `crimson`; rate-limited → a filled dot in `warning`; queued → a hollow 1.5px ring in the queued status colour; idle, hibernated, terminated → nothing. 6px at sizes 20 and 24, 4px at 16. The badge sits in a hole cut from the avatar with a CSS `mask` 2px larger than the badge, so whatever surface the row shows (hover, press, selected, highlighted) shows through; there is no ring colour. Dots change colour over 150ms; a shape swap is instant; nothing pulses. The status word is always present as text (tooltip and sr-only in the sidebar and rail; the status column elsewhere).
- `StatusBadge` adopts the same shapes per status (Q33), keeping its label.
- `PrincipalChip` = `AgentChip` for agents, the plain `@handle` for humans. `AgentChip` = avatar + display name (`min-w-0`, truncating; a spawned name keeps its " · ab12" tail via `AgentName`) + optional muted mono `@slug`. The slug gives way first (`MiddleTruncate`, down to 6rem), the name keeps at least `min(8rem, 45%)`; in a container under 24rem the chip wraps to two lines (name, then the slug at 12px). Full values appear in a Radix tooltip only when truncated (measured `scrollWidth > clientWidth` on pointer enter or focus), inside the shared `TooltipProvider`; no native `title`.
- Sizes used: 16 (palette, comboboxes, inbox rows), 20 (sidebar, Agents page, task assignee, Agent details Org, Home), 24 (session header). No other.
- `AgentAvatar` is `memo`; `botParts` is `useMemo` on the slug.

### 5.2 Peek sheets: `Sheet` gains `modal` and `inset` (U1 Q18)

`Sheet({ open, onOpenChange, modal = true, children })`, `SheetContent({ width = "sheet", inset = "full", … })`:

- `modal={false}` on desktop (≥768) passes through to Radix Dialog: no scrim, no focus trap, no scroll lock, no `aria-modal`; the page behind stays usable. `onInteractOutside` and `onFocusOutside` are prevented, so clicking the page behind doesn't close it. Esc (Radix listens on the document) and Close close it.
- Focus: opened by a click on its trigger, focus moves into the sheet; opened from the keyboard on a list (Space), `onOpenAutoFocus` is prevented and focus stays in the list. On close, a custom `onCloseAutoFocus` focuses what the consumer names (the currently selected row, or the toggle), because Radix's non-modal close focuses only its trigger ref.
- `width`: `"sheet"` = `w-[min(30rem,100%)]`; `"panel"` = `w-[min(20rem,100%)]`. `inset`: `"full"` = `inset-y-0`; `"below-header"` = `top-12 bottom-0` (the session header stays usable).
- Motion: the sheet's (250/200ms, `--ease-drawer`/`--ease-out`), instant when opened from the keyboard (U1's per-opening stamp). A key that closes an overlay (Esc, `]`, `?`, Space on a peek) stamps `data-instant` on the content first, so the close is instant however it opened (§16.8).
- Retargeting: a page owns one peek state (`{ kind, target } | null`); the `Sheet` and `SheetContent` stay mounted while the target changes, only the body is keyed, so a retarget swaps content in place and resets the body's scroll; it never closes and reopens. Opening a different kind of peek replaces the content the same way.
- Below 768 the adaptive Sheet renders the Vaul bottom drawer, always modal.
- Consumers: Agent details at 768–1023 (§8), task peek (§12), build log (§14), shortcuts sheet (§10.3).

### 5.3 Shell-level live state (D1)

- Status frames are applied once, at the shell: `AppLayout`'s existing `onMessage` (it renders the `WsContext` provider, so it can't call a hook that reads it) enqueues `agent_status` and `supervisor` frames into a module-level queue that `applyStatusFrames` flushes (`features/session/use-agent-status.ts` keeps the patch logic); the five page-level `useAgentStatusFrames()` calls (`session-view.tsx:43`, `home-agents`, `agents.index`, `agents.$slug_.edit`, `settings/factory-section`) are removed.
- The queue flushes in one `setQueriesData` per animation frame (a 100ms timeout while `document.hidden`, and on `visibilitychange`), as U1 does for the timeline; `["agents"]` is invalidated at most once per batch. The flush folds the batch per slug (the last frame wins), computes "enters terminated" against the state before the batch, patches the lists and each `["agent", slug]` detail once, and applies the newest `supervisor` frame. The patch keeps the identity of every unchanged agent object (a test pins it).
- `useAgentIndex()`: a slug → agent index built once per list-data identity (memoized in a `WeakMap` keyed by the data array) and read inside per-row `select`s, so a frame costs O(n), not O(n²). Selects never return a `Map` or `Set` (TanStack's structural sharing only keeps plain objects and arrays stable): counts are `Record`s, memberships `string[]`. Per-row selectors use `refetchOnMount: false`; the slug form of `AgentChip` reads the ended list from the cache only (never fetches it).

### 5.4 Per-browser preferences (D2)

`lib/prefs.ts`: `usePref<T>(key, fallback, parse)` over `localStorage` with `useSyncExternalStore` (a `storage` listener keeps tabs in sync, as the theme does); every read and write in `try/catch`.

| Key | Value | Used by |
|---|---|---|
| `of-tree-expanded` | JSON `{ [slug]: boolean }`, explicit user toggles only (default: roots open, the rest closed); pruned to live slugs on write | §6 |
| `of-tree-collapsed` | `"1"` when the whole Agents tree is collapsed under its row | §6 |
| `of-agent-details` | `"open"` \| `"closed"` (absent = open) | §8, ≥1280 only |
| `of-recent-agents` | JSON array of the last 8 opened slugs | §10.2 |
| `of-single-keys` | `"off"` when single-key shortcuts are disabled | §10.3 |

### 5.5 Breakpoints and constants (D3)

`lib/breakpoints.ts`, rem so they follow the text size: `MOBILE = "(width < 48rem)"` (existing), `WIDE = "(width >= 64rem)"` (inbox panes, in-flow Agent details), `XWIDE = "(width >= 80rem)"` (Agent details open by default). `useMedia(query)` reuses the cached `MediaQueryList` pattern of `use-mobile.ts`. Layout decided by these follows the window live; an open overlay keeps its primitive until it closes (U1).

`lib/timing.ts`: `INBOX_DWELL_MS = 1000` (Q31; one named constant Or may retune).

### 5.6 Selected rows and key hints

- `steel-selected` (Q35): in `styles.css` terms `--selected` (in `:root` and the dark block) and `--color-selected` in `@theme`. steel-hover is `--accent` (light 0.93, dark 0.285); selected is one step further from the surface than hover in each theme: darker in light (about 0.90, below `--sidebar-accent`'s 0.905), lighter in dark (about 0.31); tuned in the PR5 screenshots. A selected row (the inbox item in the pane, the task in the peek, the current Settings page) takes it with `aria-current="true"` and keeps it under the pointer; hover stays `steel-hover`.
- A keyboard-moved selection takes the fill at once: the list moves selection inside `runInstantOn(listEl, fn)` (new in `lib/run-instant.ts`: `data-instant` on that element for two frames), so neither the old nor the new row fades. Pointer hover keeps its 150ms colour.
- `Kbd` (`components/ui/kbd.tsx`): Geist 12px, `ink-muted`, on a plate with a `rule` edge, radius sm, never mono. Shows ⌘ on macOS and Ctrl elsewhere (`navigator.userAgentData?.platform ?? navigator.platform`).

## 6. Sidebar agent tree (PR1; the ⋯ in PR2)

### 6.1 Placement (Q39)

`AppSidebar`: header (wordmark); in PR4 a "Search" button row (§10.2); the main nav **Inbox, Tasks, Templates, Schedules, Usage (PR3), Settings**; then the **Agents** row, which is both the nav row for `/agents` and the head of the tree: its label links to `/agents` (active there and on `/agents/new`, `/agents/$slug/edit`, `/agents/$slug/usage`, and on an ended agent's session), a chevron at its end collapses the whole tree (`of-tree-collapsed`), and a `+` (tooltip "New agent") links to `/agents/new`. The tree follows, taking the remaining height and scrolling on its own (`min-h-0 flex-1 overflow-y-auto`), then the footer (user menu; name and handle get a truncation-only tooltip, break L4).

The Agents row moves from second to last place so a long tree doesn't push Tasks…Settings down (Q40): only the tree region scrolls, and the Agents row is sticky at the top of that region so its chevron and `+` stay reachable. The collapsed rail keeps the same order: nav icons, a rule, then the rail's agents (§6.6). Fallback if the merged row proves awkward (Q39): a plain "Agents" nav row stays last in the nav and the tree follows under a rule with no label, the `+` on the first tree line.

### 6.2 What it shows (Q2)

- Live agents only (`agentsListQueryOptions("exclude")`); a spawned agent nests under its spawner (its `reportsTo`).
- Order: `treeOrder` (siblings by display name, then slug), never by status.
- Expansion: roots open, the rest closed, overridden by the user's own toggles (`of-tree-expanded`). Viewing `/agents/$slug` reveals its ancestors **in memory** for the session (not persisted), and scrolls the row into view once per navigation (`scrollIntoView({ block: "nearest" })`, instant).
- No row cap. Indent 8px per level, stopping at depth 4 (deeper rows keep `aria-level` but no further indent; their tooltip names the manager: "Name · reports to Manager").
- Virtualization is not built; PR1 records the 214-agent measurement (§2.13); the follow-up issue is opened only if it lags.

### 6.3 Row anatomy (Q6, Q32)

32px (36px on coarse pointers), `px-2`:

1. Chevron slot, 16px, only when the agent has children: an `aria-hidden` `<span>` with a hit area of the full row height × 24px (pseudo-element). `onPointerDown` prevents default (no row press, no focus jump); `onClick` prevents default, stops propagation and toggles. It rotates 90° over 150ms on `--ease-out` **only** when toggled by that pointer click (`data-toggled="pointer"` scopes the transition); keyboard toggles, revealed ancestors, cross-tab sync and the rail snap.
2. `AgentAvatar` 20 with its badge.
3. Display name, `min-w-16 truncate`.
4. At the end, only when non-zero: a collapsed manager's working count drawn as the working tooth + `tabular-nums` number (sr-only and tooltip "3 working"), then the unread count (`byAgent[slug]`, Q34: messages only). Both in one recipe: muted 13px `tabular-nums`, "99+" cap; the working count hides first when the row has no room.
- Active row (its session open): `steel-hover` fill + the left tooth, as a nav row (Q3). An active working agent shows the left tooth and the badge tooth (recorded in §2.13).
- Hover (fine pointer): a ⋯ (ghost 24px, `tabIndex={-1}`, `aria-label="Actions for <name>"`) replaces the counts instantly; it opens `AgentMenu context="sidebar"` (§8.4, PR2). There is one `AgentMenu` instance for the whole tree, controlled by the target slug and anchored to the hovered or focused row; rows mount no Radix root of their own (the truncation tooltip mounts only once a pointer or focus finds the name truncated). Shift+F10 or the Context Menu key on a focused row opens the same menu. Right-click keeps the browser's own menu (Open in new tab, Copy link). Coarse pointers get no ⋯ (U4's long-press).
- Click or Enter navigates to `/agents/$slug`; on mobile it closes the drawer. Intent preload as every link.
- Tooltip only when the name is truncated (full name; with the manager past depth 4). The status word is sr-only text in the row.

### 6.4 Rendering and data (D4)

- `features/agents/sidebar-tree.tsx`: `useAgentTreeShape()` selects `{ slug, displayName, reportsTo }[]` reduced to a string key, so the tree re-renders only when an agent is added, removed, renamed or moved.
- `SidebarAgentRow = memo(({ slug, level, expanded, hasChildren, active, tabbable }) => …)` reads its agent from `useAgentIndex()` (§5.3) with a per-slug `select`. Rows are a plain `Link` with the menu-button classes: no `SidebarMenuButton`, no `useSidebar()` and no per-row tooltip; closing the mobile drawer is one delegated click handler on the list. `SidebarAgentTree` is `memo` with primitive props; callbacks passed to rows are stable.
- `useWorkingCounts()` selects a `Map<slug, number>` of working descendants of collapsed managers with a content-equality check, so only rows whose count changed re-render.
- `useUnreadByAgent(slug)` selects `byAgent[slug] ?? 0` from `["inbox-unread"]`.

### 6.5 Keyboard and semantics

WAI-APG navigation treeview, rendered flat: `<nav aria-label="Agents">` wraps one `<ul role="tree">` of the visible rows in tree order; each row is an `<a role="treeitem" aria-level aria-setsize aria-posinset aria-expanded? aria-current="page"?>` inside `<li role="none">` (no nested `role="group"` lists, so the list renders without recursion). Roving tabindex: one tab stop (the active row, else the first); ↓/↑, → (open or first child), ← (close or parent), Home/End, Enter follows the link, typeahead on display name. Focus ring inset.

### 6.6 Collapsed rail (Q38) and mobile (Q23)

- Rail: nav icons, a rule, the Agents icon (links `/agents`), then a compressed glance, not the tree: the active agent, agents with unread messages, and agents working, queued, rate-limited or errored, in tree order, avatar only (with badge), the unread count as a dot on the avatar's top-right. Tooltip "Name · @slug · Status". The active row keeps the tooth. Rows snap with the rail (no padding, margin or width transitions on rows).
- Mobile left drawer: the full tree, the same component; tapping a row closes the drawer.

### 6.7 Empty and loading

No live agents: one muted line "No agents yet." and a "New agent" link. Loading: three static 32px skeleton rows.

## 7. Agents page polish (PR1, status.md U2 #7)

`features/agents/agent-tree.tsx` rows, desktop: indent with **continuous** 1px tree lines in `rule` (one absolutely positioned line per ancestor level that still has later siblings, plus the elbow, so lines join across rows; lines stop at the depth cap), then `AgentChip` (20, badge, `@slug`), the status column (unchanged), the template only when it differs from the slug's stem (the slug minus a trailing `-<suffix>`), "Unsandboxed" only when `runtime === "local"`, cost right-aligned `tabular-nums`. Drawn depth caps at 8 on desktop and 3 below 768 (as today); a row deeper than the cap shows a muted `tabular-nums` depth marker ("└ 12"). Mobile two-line rows stay U4.

## 8. Session header and Agent details (PR2)

### 8.1 Layout (Q7, Q9, Q24, Q27, Q30)

`SessionView` becomes a row: the main column (header, notices, timeline, composer) and the Agent details container. `agent-strip.tsx` is deleted and `terminated-strip.tsx`'s pin logic moves into the header's Pin button and Agent details' Now section; each segment's new home is in §8.2/§8.3. The timeline and the composer share one column, `max-w-[52rem]`, the same inset, left-aligned.

| Width | Agent details |
|---|---|
| ≥1280 | In-flow `<aside aria-label="Agent details">`, 20rem, `bg-card border-l`; open unless `of-agent-details` is `"closed"` |
| 1024–1279 | The same in-flow column, closed on every visit (decision 5: closed below 1280); not remembered |
| 768–1023 | `Sheet modal={false} width="panel" inset="below-header"`, closed on every visit |
| <768 | The adaptive Sheet's bottom drawer (modal) |

- One control at every width: the header's toggle (ghost icon `PanelRight`, `aria-label="Agent details"`, `aria-expanded`, `aria-controls`), plus `]`. No chord from inputs in U2 (Q37).
- In-flow open and close are instant from keyboard and click (Q24).
- Switching agents while it is open keeps it open (≥1024: it is part of the page; 768–1023: the sheet retargets in place, §5.2). A visit = a navigation to a different slug; the 1024–1279 and 768–1023 modes start closed on each.
- Crossing a breakpoint while the 768–1023 sheet is open: the sheet stays until closed (U1 latch); the in-flow column isn't rendered meanwhile, then follows its rule.
- **Scroll anchoring (Q24).** `Timeline` keeps `anchor = { key, top }`: a passive, rAF-throttled scroll listener sets it to `document.elementFromPoint(x, scrollerTop + 1)?.closest("[data-row]")` and its offset; `atBottom` is the last value computed on scroll. A `ResizeObserver` on the scroller, on a width change and synchronously in the callback (after layout, before paint): if `atBottom`, `scrollTop = scrollHeight`; else `scrollTop += row.getBoundingClientRect().top - anchor.top`. The panel toggle captures the anchor in its handler before the state change. This also covers the sidebar collapse and window resizes; PR2 records its frame cost (§2.13).

### 8.2 Header (Q8, Q21, Q36)

`[sidebar trigger] [avatar 24, no badge] [h1 name] [status badge] [live line] … [Pin] [Stop] [Restart] [toggle] [⋯]`

- **Live line** (`features/session/live-line.tsx`, `role="status"`): `liveFact(agent, ctx): LiveFact | null`, pure, the first that applies:
  1. terminated: "Terminated by @x · <time> · deletes Sun 21:53" (or "workspace pinned" / "workspace deleted"); **Pin/Unpin** is its own `shrink-0` button in the actions slot, never inside the truncating line (the existing logic and its confirmation after the grace period);
  2. errored: the first line of `lastError` (full text in a tooltip);
  3. queued: the existing detail (all N slots in use / credential paused / pulling image);
  4. restart pending: "Restarts when idle";
  5. waiting on: the first background task "pnpm test · since 14:02", "+N" when more;
  6. crons: "Kept awake by N crons".
  Rate-limited has no line fact: the long badge already says "Rate-limited until 15:30". Times are absolute, never ticking. No fact → no line.
- Give-way: the name is capped at `max-w-[45%]` (still truncating to U1's 4rem floor), the line takes `min-w-[8rem]` when it has a fact and truncates first; below 640px the line hides (Agent details' Now carries it).
- **Stop**: today's `InterruptButton`, only while `turnOpen`. The composer is untouched (U3).
- **Restart**: today's `RecoveryActions` when errored (and its "Start a new session"); its error text moves out of the header into a notice row under it.
- **⋯**: `AgentMenu context="session"`.
- Removed from the header: Edit, Compact, Terminate (into the menu).

### 8.3 Agent details content (Q7, Q36)

`features/session/agent-details.tsx`, `AgentDetails({ agent, stop })`, the same in every container:

- A 48px strip, `border-b`, aligned with the page header's rule: title "Agent details"; Close in the sheet and drawer modes.
- `@slug` (mono, `[overflow-wrap:anywhere]`) and the description (muted, wraps, clamped to 3 lines with "More").
- **Now** (only when something applies), using the header's wording for the fact it shows: all waiting-on tasks with start times, crons with Stop crons, restart pending with its Why popover, queued detail, rate-limited until, the terminated facts with Pin, the restart error.
- **Org**: "Reports to" (`AgentChip`, link), reports and live spawned agents (`AgentChip` each, up to 8, then "All N reports" → `/agents?focus=<slug>`, which scrolls to the agent's row and gives it `steel-hover` for that visit; `focus` is added to the Agents page's search in PR2).
- **Work**: open tasks from a new non-infinite `agentTasksOptions(slug)` (`GET /api/tasks?status=open_in_progress&assignee=<slug>&limit=5`; `tasksListOptions` is infinite with a fixed limit of 50) (key, title, status), "All N tasks" from `agent.openTasks` → `/tasks?assignee=`; schedules targeting it, up to 5 (`S-n`, next run), "All N schedules" from `agent.scheduleCount`. Both queries enabled only while it is open.
- **Usage** (decision 4): the 7-day estimate from `agentsUsageQuery("rolling7")` + "Usage" → `/agents/$slug/usage`.
- **Runtime**: template (link), credential, image (pulling), projects, "Unsandboxed" when local.
- Footer: "Edit agent" (outline; persistent, not archived). U1's pending outline-vs-ghost decision applies if Or changes it.
- No new endpoint. Its own scroll.

### 8.4 `AgentMenu` (Q6, Q8)

`features/agents/agent-menu.tsx`: `AgentMenu({ agent, context, trigger, stop, onTerminate… })`, a `DropdownMenu`:

| Item | Session | Sidebar |
|---|---|---|
| Open session | — | ✓ |
| Agent details (`]`) | ✓ | — |
| Compact… | ✓ live, not errored | — |
| Edit | ✓ persistent, not archived | ✓ |
| Usage | ✓ | ✓ |
| Open tasks | ✓ | ✓ |
| Stop crons… | ✓ crons live | — |
| Terminate… | ✓ spawned, live; separator above, crimson | — |

- Compact…: `CompactPopover` becomes controlled with a `PopoverAnchor` on the ⋯ trigger; the menu item prevents the menu's `onCloseAutoFocus` and opens the popover on the next frame, so focus lands in the popover (tested).
- `SessionView` owns the Stop crons state (`useStopCrons`) and keeps `CronsStopLayer` mounted (it used to live in the strip); Agent details and the menu receive `stop`. Terminate's `onTerminateStart`/`onTerminated` wiring moves with it.

## 9. Settings and Usage (PR3)

- `routes/_app/settings.tsx` becomes a layout: `PageHeader title="Settings"`, a 180px sub-nav (`<nav aria-label="Settings">`, 32px rows, current page with the fill and medium weight in PR3, `steel-selected` from PR5, no tooth) and an `<Outlet />`. When the content beside it would be narrower than 40rem (a container query on the body), the sub-nav becomes a "Section" `Select` above the content (U4 may revisit it on phones).
- Children `settings.credentials.tsx`, `settings.secrets.tsx` (search `addSecret?`), `settings.projects.tsx`, `settings.users.tsx`, `settings.factory.tsx`; each loader fetches only its own queries (preload-aware as U1 §10.2) and keeps its section's error with Retry. All users are equal admins, so every section shows.
- The layout's `validateSearch` (`addSecret`, `days`) moves to `settings.index.tsx` (both, for the redirects) and `settings.secrets.tsx` (`addSecret`).
- `settings.index.tsx`: `beforeLoad` redirects (`replace`) by `location.hash`: `#credentials|secrets|projects|users|factory` → that route (carrying `addSecret` to secrets); `#usage` or `days` → `/usage?days=`; else `/settings/credentials` (Q12).
- The "On this page" row, the hash scroll/focus plumbing and the `hashchange` listener are deleted.
- `routes/_app/usage.tsx`: `PageHeader title="Usage"`, the existing `UsageSection` content, search `days` (7/30/90, default 30). The per-credential table's heading becomes "By credential" (one "Credentials" heading in the app).
- Links updated: `prerequisites.tsx:56`, `agent-form.tsx:553,653`, `project-grant-picker.tsx:45`, `timeline-row.tsx:230`.
- The sidebar gains the Usage nav row (between Schedules and Settings).

## 10. Palette, shortcuts and pickers (PR4)

### 10.1 Dependency

`cmdk@1.1.1`, `pnpm --filter @open-factory/web add --save-exact cmdk@1.1.1` (decision 8; published 2025-03-14; Vaul is already exact-pinned by U1). Its Radix deps dedupe with `radix-ui@1.8.1`. No supply-chain setting changes.

### 10.2 Palette (`features/palette/command-palette.tsx`)

- Built from our `radix-ui` `Dialog` (Overlay and Content carry `data-instant` unconditionally; an sr-only `DialogTitle` "Search") with a cmdk `<Command shouldFilter={false}>` inside (cmdk's `Command.Dialog` can't forward our attributes, refs or title). Top-centre `top-[15vh] w-[min(40rem,calc(100%-2rem))]` (below 48rem: `top-2`, list `max-h-[40dvh]`), popover look, modal, the 20%/40% scrim, **never animates** (Q26).
- Loaded eagerly (cmdk is small): no first-open delay, no misrouted keys.
- Open: ⌘K / Ctrl+K from anywhere (handled before the editable-target check), and a **Search** button row above the main nav (Search icon, "Search", a right-aligned `Kbd`; a button, never active, a rule under it).
- Groups in this order (async last, so nothing above the highlight moves when results land; Q-adopted):
  1. **Agents**: client-side over the live list, plus the ended list (`agentsListQueryOptions("only")`, prefetched when the palette opens); ranking (`features/palette/rank.ts`, pure): exact slug or name, prefix, recent (`of-recent-agents`), substring in tree order; live before ended ("Ended"; with `more`, a muted "Showing the 200 most recently ended" line). Lists are snapshotted per query change, so a status frame never moves rows. Row: `AgentChip` 16 with `@slug`. Enter opens the session; ⇧Enter also focuses the composer.
  2. **Open T-42**: when the input matches `/^t-\d+$/i`, a synthetic row appears at once (Enter navigates; the task page handles not-found) and fills in its title through the existing `lookupTasks` (`keys=` with `status=all`, so done tasks resolve) with the same cmdk `value`, so the highlight stays.
  3. **Go to**: Inbox, Agents, Tasks, Templates, Images (PR4: `/templates#images`; PR6 switches it to `/templates/images`), Schedules, Usage, each Settings page.
  4. **Actions** (Q28): New agent, New task, New schedule, Agent details (session pages only), Theme: System / Light / Dark, Keyboard shortcuts. No "Mark all read".
  5. **Tasks**: from 2 characters, `GET /api/tasks?q=<input>&status=all&limit=20`, debounced 150ms (`tasksSearchOptions(q)`, key `["tasks", "search", q]`); stale rows from the previous query are muted and Enter doesn't commit them. Row: key, title (`min-w-0 truncate`), status (`shrink-0`).
- Empty query: recent agents, Go to, Actions.

### 10.3 Shortcut layer (`lib/shortcuts.ts`)

- One `keydown` listener on `window` in `AppLayout`; handlers register with `useShortcut(key, handler, { enabled })` (latest registration wins, so a page scopes `j`/`k`).
- Single keys are ignored when: `of-single-keys` is `"off"`; `event.defaultPrevented`; the target is editable (`input`, `textarea`, `select`, `[contenteditable]`) or inside `[role=menu]`, `[role=listbox]`, `[role=tree]` (its typeahead), `[role=grid]`, `[role=radiogroup]`; a modal layer is open (`[aria-modal=true]`, `[role=alertdialog]`); during IME composition; with Ctrl or ⌘. Matching is on `event.key`; Alt/Option is allowed when it produced the bound character (`]` is Option+5/6 or AltGr on some layouts).
- Bindings (Q11): `g` then `i`/`t`/`s`/`u`/`a` within 1s → Inbox/Tasks/Schedules/Usage/Agents; `c` → New task (the palette's action, today `/tasks/new`); `]` → Agent details (session pages); `?` → the shortcuts sheet; `j`/`k` → inbox and task lists.
- Shortcut-opened UI is keyboard-initiated and instant.
- **Shortcuts sheet** (`?`): `Sheet modal={false}` "Keyboard shortcuts", grouped Global / Lists / Session with `Kbd`, and a "Single-key shortcuts" switch (`of-single-keys`, WCAG 2.1.4). Also the palette's "Keyboard shortcuts" action.

### 10.4 Combobox and pickers (#83, Q22)

- `components/ui/combobox.tsx`: a trigger styled as U1's `Select` trigger, opening a `Popover` (`w-[max(var(--radix-popover-trigger-width),min(24rem,calc(100vw-2rem)))]`, `align="start"`, the side chosen at open locked while open) with a cmdk `Command` (filter input + list at a fixed `h-72`, so the popover doesn't resize as the filter narrows; no list-height transition). Props: `value`, `onValueChange`, `options: { value; label; keywords?; group?; disabled?; fixed?; render? }[]`, `placeholder`, `emptyText`, `aria-label`, `renderValue?`. Arrows move the highlight only; Enter or a click commits (tasks.md). Option order: `fixed` options (each picker's own: "None" for manager and assignee; "Anyone" and "Unassigned" for the assignee filter; "Anyone" and "Me" for the creator filter; "Any agent" for the schedules target filter) first and kept while filtering, then the current value, then the rest in their order.
- `AgentCombobox({ value, onValueChange, scope: "live" | "live+ended", fixed? })`: `AgentChip` 16 with `@slug`, keywords `[slug, displayName]`, an "Ended" group last for `live+ended`; a value missing from the options renders through the slug form of `AgentChip`. The manager picker keeps U1's indent cap and the rule that spawned agents aren't managers.
- Swaps: manager (`agent-form.tsx`, live persistent), assignee (`tasks/assignee-menu.tsx` and the New task form, live), schedule target (`schedule-form.tsx`, live, keeping its `extraOption`), the task list's assignee and creator filters (`live+ended`; human creators stay URL-only as today: a `@handle` value renders as text) and the schedules list's target filter (`live+ended`), and the time zone (`zoneGroups()` kept: UTC and the current value; keywords add the offset and the name with `_` as spaces, offsets computed on first open). `NativeSelect` is deleted.
- The task status menu, the credential select and other short fixed lists stay.

## 11. Inbox reading pane (PR5)

### 11.1 Layout and selection (Q14, Q31)

- Route search gains `item?: string`.
- ≥1024 (`WIDE`): a list column `w-[23.75rem] shrink-0 border-r` and the pane (`min-w-0 flex-1`), each with its own scroll. Nothing selected: one muted line "No item selected."
- Plain left click (no modifier, button 0) or Enter on a row: `preventDefault`, navigate `?item=<id>` with **push**, mark read at once (existing optimistic `useOpenItem`). The row stays an `<a href>` to the real target, so modifier-click, middle-click and Copy link open the target (inbox.md unchanged for those).
- `j`/`k`: move the selection (inside `runInstantOn`), navigate with **replace**, the pane follows at once; the item is marked read once it has been shown for `INBOX_DWELL_MS` (the timer is cancelled when the selection moves). The neighbours' pane data are prefetched. ↓/↑ move focus only (existing `row-nav`).
- The selected row has `steel-selected` and `aria-current="true"`.
- <1024: rows navigate as today; `?item=` is dropped (`replace`).
- Rows at 380px, three lines: (1) sender (`AgentChip` 16 slug form, or the human/factory name) and the kind word, the time right-aligned (`tabular-nums`, never truncated); (2) the context (`T-6 · title`, or "→ @humans" when the recipient isn't you), truncating; (3) the preview, one line. Read rows show sender and preview in `ink-muted`; unread rows keep the ink dot and medium weight. Previews are plain text: `plainPreview(markdown)` (pure, `features/inbox/preview.ts`) strips fences, inline code ticks, emphasis, links (keeps their text), headings and list markers, and collapses whitespace.

### 11.2 Pane content (Q15)

The pane is a flex column: a 48px header (from the list row, so it swaps at once: sender `AgentChip` 20 or name, time, an outline "Open in session" / "Open task" link to the exact target), a scrolling body, and the composer pinned `shrink-0` below the scroller. Switching items swaps the content instantly (no crossfade); the body shows static skeleton plates at real row heights until its data arrives, never the previous item's body.

- **message** (agent sender): `SessionExcerpt({ slug, seq })`: `GET /api/agents/:slug/events?around=<seq>&limit=7`, rows from `rows.ts` rendered by `TimelineRow` directly (not `TimelineItem`, so no copy links and no tab-key plumbing; tool rows still expand); when `link.seq` is absent the excerpt is the latest 7 events of the sender's session with no highlight; the target row highlighted and scrolled into view (`block: "start"`). Then the session `Composer` (urgent toggle included), keyed by target so its draft is per slug, sending to the sender's session. A terminated sender shows `TerminatedComposer`'s line; an archived one the archived line.
- **message** from `@factory` (an errored top-level agent): the excerpt and the composer target the subject agent.
- **mention**: the task header (key, title, status, assignee `AgentChip`), the 3 comments before the mentioned one and the comment (from `taskDetailOptions(key)`), then `CommentComposer` for that task, keyed by task, prefilled with `@author ` when the author is an agent (as the task page does).
- **task_event**: the task header and the fact ("Done" / "Cancelled", by whom, when), "Open task"; no composer.
- An item outside the loaded pages: `GET /api/inbox/:id` (§15.4); the list's pages don't change. 404: "This item no longer exists."
- Sending a reply marks the item read at once.

## 12. Task peek (PR5, Q16)

- Task list: `j`/`k` alias ↓/↑ in `row-nav` and move the selection (`runInstantOn`, `steel-selected`).
- Space on a focused row (`preventDefault`): when the list's container keeps ≥24rem beside a 30rem sheet (container check on the list, not the viewport), opens `Sheet modal={false}` (width `sheet`) with `TaskPeek({ taskKey })`; otherwise opens `/tasks/$key`. Focus stays on the list; Tab from the last row, or F6, moves into the peek.
- `TaskPeek`: a header (key, "Open" link to `/tasks/$key`; the title comes from `TitleBlock`) and `TaskDetailView`. `TaskDetailView`'s root becomes `@container/task` with its two-column layout at `@[45rem]/task` (= today's `lg` with the sidebar open: 1024 − 256 − 48 = 720px) instead of viewport `lg:`; every `lg:` in `task-detail.tsx` converts (L184 `BodyPlates`, 289, 296, 297, 314, 378 `TitleBlock`, 470). `PageBody` moves out to the route, so the page renders as today and the 480px peek stacks. jsdom can't evaluate container queries: the test checks classes, the layout is a manual check.
- `j`/`k` with the peek open retarget it in place (§5.2), resetting its scroll; the neighbours' `taskDetailOptions` are prefetched while it is open. Esc or Space closes it and focuses the selected row. No URL state (D11).
- Plain click navigates; Enter opens the page.
- Below 768: the Sheet's drawer.

## 13. Home (PR6, Q17)

`routes/_app/index.tsx`: `PageHeader title="Home"`, two plates side by side from `lg`, stacked below:

- **Needs you**: the 5 newest unread inbox items (`HomeInbox`), then live agents that are errored (`AgentChip` with badge, `liveFact()`, link to the session), at most 8, then "and N more" → `/agents`. Rate-limited and restart-pending agents are not "needs you". Empty: "Nothing needs you."
- **Live now**: agents working, queued or rate-limited (`AgentChip`, `StatusBadge`, `liveFact()`), tree order, at most 8 then "and N more"; header count describes the list ("2 working · 1 queued"). Order and membership are frozen while the pointer or focus is in the plate (U1's rule, extended to rows joining or leaving); never animated. Empty: "No agent is working." No agents at all: "No agents yet." with "New agent".
- Existing queries only.
- Alternative for Or (Q17, certainty 3): drop Home and land on `/inbox`; a one-line answer: `/` redirects to `/inbox` and `index.tsx` is deleted.

## 14. Templates and Images (PR6, Q18)

- `templates.index.tsx` and a new `templates.images.tsx`: the header's title area holds two links styled as a segmented control (`SegmentedLinks`, new: the SegmentedControl look on `<a>` elements with `aria-current="page"`, Tab between them, no radio semantics) "Templates | Images" ( the h1 "Templates" stays visible from 25rem of header width, and below that becomes sr-only so the control takes its place); the actions slot holds New template (icon-only below 640px, with `aria-label` and tooltip).
- `/templates#images` → `/templates/images` (`beforeLoad` on the index); `timeline-row.tsx:213` and the palette's Images entry link the new route. A template named `images` would be shadowed by the route, as one named `new` already is today (nothing reserves either): template creation (`POST /api/templates`) rejects the names `new` and `images` ("That name is reserved."); TanStack ranks the static routes above `$name`, so a folder created on disk with either name is unreachable by URL: its list row shows "Rename this folder: its name is reserved." (server test for the POST rejection).
- Image rows show status only; "Build log" (ghost, per row) opens `Sheet modal={false}` titled "<image> build log" (`[overflow-wrap:anywhere]`) with `BuildLog` streaming and Build in its footer; another row's "Build log" retargets it in place. The inline expanding log is removed.
- The template page shows "avatar.svg ignored: over 256 KB" when the file exists but is too large.

## 15. Server changes

### 15.1 Unread per agent (PR1, Q13, Q34)

- `GET /api/inbox/unread-count` → `{ count, byAgent: Record<slug, number> }` (schema in `packages/shared/src/messaging.ts`). `byAgent` = the user's unread `inbox_items` of kind `message` joined to `messages` on `message_id`, grouped by `messages.from_agent_id` → slug; mentions, task events and `@factory` items (`from_agent_id` null) count for no agent. `count` stays the global badge's source.
- `POST /api/inbox/read-from/:slug` `{ upTo: string /* ISO */ }` → `{ marked: number, readAt }`: marks the requesting user's unread `message` items from that agent created at or before `upTo` read; idempotent; unknown slug 404.
- Web: `useInboxCache().setRead` keeps `byAgent` (spreads the old value, decrements `byAgent[from.name]` for agent-sent `message` items); Mark all read and its Undo leave `byAgent` to the `inbox_changed` refetch; if that frame is missed, the reconnect-wide invalidation (U1 R4) resyncs it.
- The server publishes `inbox_changed` to that user when `marked > 0` (as read-all and `:id/read` do), so list pages, Home and other tabs refetch; the client also flips cached inbox rows where `kind === "message" && from.kind === "agent" && from.name === slug`. `upTo` is validated as read-all's cursor (400 when not an instant).
- The session view calls `read-from` (only from the mounted `SessionView`, never a loader, only while `document.visibilityState === "visible"`, re-checked on `visibilitychange`) whenever the agent's `byAgent` count is non-zero and the newest loaded event's time has advanced since the last call, with `upTo` = that time (the newest **event**: the agent's outgoing `send_message` event is stamped before its inbox item, so the call re-runs as events advance); at most one call in flight, trailing-throttled to one per second, so a streaming turn doesn't POST per event. It updates `count` and `byAgent` optimistically.

### 15.2 Task search (PR4, Q10)

`GET /api/tasks` gains `q: z.string().trim().min(1).max(200).optional()`: `title ILIKE '%' || esc(q) || '%' ESCAPE '\'` (`esc` escapes `\`, `%`, `_`), the list's ordering and cursor unchanged, `limit` applies. The exact-key path stays `keys=` (the palette routes `T-42` there). No trigram index (follow-up).

### 15.3 Template avatar (PR1, Q5)

- `AgentSummary` gains `avatarVersion: string | null`: `"<mtimeMs>-<size>"` of `<templatesDir>/<template>/avatar.svg` when it is a regular file ≤256 KB, else null; computed once per distinct template per list/detail response (one `stat` each). The `agent_status` frame doesn't carry it.
- `GET /api/templates/:name/avatar.svg`: same auth as the template routes; `:name` passes the template `nameSchema` (invalid → 400) and is looked up in the template index (unknown → 404); the path comes from the index entry; missing, not a regular file or >256 KB → 404. Headers: `Content-Type: image/svg+xml`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `Cache-Control: private, max-age=31536000, immutable`, `ETag` = the version.
- The template detail response gains `avatar: { version: string | null; tooLarge: boolean }` for the §14 note.

### 15.4 One inbox item (PR5, Q29)

`GET /api/inbox/:id` → `{ item: InboxItem }` for the signed-in user's own item; another user's or unknown → 404 (no existence leak). Same row mapping and Zod schema as the list.

## 16. DESIGN.md amendments

Exact text; section names refer to DESIGN.md at U1's top (`0e65634`). DESIGN.md never describes a feature before it exists: where one bullet covers several PRs, each PR lands only the clauses for its own features (marked [PR n] below), and the later PR adds its clauses.

### 16.1 Front matter (PR1, PR2, PR5)

Add colors `steel-selected` (light) and `night-selected` (dark) with the values tuned in PR5, `avatar-ink: "{colors.graphite-ink}"`; add under `components`:
```yaml
  panel:
    backgroundColor: "{colors.plate}"
    width: "320px"
```
Correct `sidebar.width` to `"256px"` (the code's `16rem`; DESIGN.md said 240) and Layout's "240px sidebar" to "256px".

### 16.2 Colors → Agent identity (PR1)

Replace "status rides on the avatar as the usual dot or tooth" with "status rides on the avatar as a corner badge (Components → Avatars)", then append:

> The generated avatar is a "factory bot" drawn from the agent's slug: a head (rounded square, circle, capsule or a flat-topped hexagon, never a 30° roof), eyes, mouth and an accessory, drawn in graphite ink on one identity fill in both themes (≥3:1 on every fill at 16px). The face never changes with theme or status and never animates.

### 16.3 Layout (PR2, PR3, PR5; append)

> - **Agent details.** The session's details are a 320px column on the right, a plate with a 1px rule on its left edge and no shadow, opening with a 48px strip whose rule continues the page header's. From 1280px (80rem) it is open by default and remembered per browser; from 1024px it is the same column, closed on each visit; from 768px a peek sheet under the page header (the header stays usable); below, a bottom drawer. One header button and `]` toggle it everywhere, instantly at 1024px and up. When a column's width changes, the timeline keeps its place: pinned to the bottom if it was, else the top visible row stays put.
> - **Two panes.** From 1024px the Inbox is a 380px list beside a reading pane; below, rows navigate.
> - **Sub-navigation.** A section with several pages (Settings) has a 180px sub-nav left of its content; its current page takes the fill and medium weight (no tooth: the tooth stays on the sidebar row) [PR3; PR5 changes "the fill" to "the selected fill"]. When the content beside it would be narrower than 40rem, the sub-nav becomes a select above the content.

### 16.4 Components → Navigation (PR1, replace)

> - **Navigation:** sidebar rows are 32px (36px on touch). The active row gets the `steel-hover` fill plus the tooth, and the icon rail keeps the tooth. Nav labels are capitalised product nouns. The last nav row, **Agents**, heads the live agents as the reporting tree; its chevron collapses the tree and its `+` creates an agent. Agent rows are data rows that keep the agent's display name: chevron, avatar with its status badge, name, then a collapsed manager's working count (the tooth and a number, read as "N working") and the agent's unread messages. On an agent row the left tooth means only "you are here". Order is the tree's, never by activity. Roots start expanded and the rest collapsed; the user's toggles are remembered per browser; the open agent's managers expand for the visit only. While a live agent's session is open its row is the active row; an ended agent's session keeps the Agents row active. The collapsed rail shows only what needs a glance: the open agent, agents with unread messages, and agents working, queued, rate-limited or errored.

### 16.5 Components (new bullets) (PR1, PR4, PR5)

> - **Avatars:** 16px in pickers, the palette and inbox rows; 20px in the sidebar, lists, Agent details and Home; 24px in the session header. Always decorative (`aria-hidden`); a name is beside it, or in the rail its tooltip. In lists a status badge is cut into the bottom-right corner, one shape per status, the same shapes `StatusBadge` uses: the tooth when working, an alert glyph when errored, a filled dot when rate-limited, a hollow ring when queued, nothing at rest. The session header's avatar carries no badge; the status badge beside it does.
> - **Selected rows:** a row shown in a pane or peek, or the current page of a sub-nav, takes `steel-selected`, one step deeper than hover, and keeps it under the pointer.
> - **Command palette:** ⌘K / Ctrl+K from anywhere. A floating layer at the top centre, 640px wide, with the popover look and the scrim; modal. It never animates, however it was opened. Groups: Agents, an exact task key, Go to, Actions, then Tasks: a group whose results arrive late sits last, so nothing above the highlight moves when it lands.
> - **Combobox:** a searchable pick (agents, time zones) looks exactly like a Select and opens a popover with a filter field at a fixed height. Arrow keys move the highlight; only Enter or a click commits.
> - **Keyboard shortcuts:** single keys never fire while typing in a field, inside a menu, list box or tree, or while a modal layer is open, and can be switched off in the shortcuts sheet. `g` then a letter goes to a section; `c` new task; `]` Agent details; `j`/`k` move through lists; `?` lists them all in a sheet.
> - **Key hints:** one `Kbd` style: Geist 12px, muted, on a plate with a rule; ⌘ on macOS, Ctrl elsewhere.

### 16.6 Components → Overlays (PR2, PR4; edits)

- Ladder table: in the row "Any sheet or dialog below `md` … | A bottom drawer (Vaul); the nav is a left drawer", append "; the command palette stays a top dialog" (PR4). Replace the row "A create or edit form, or a quick peek | Right sheet, 480px, with a scrim" with two rows: "A create or edit form | Right sheet, 480px, with a scrim" and "A quick peek (a task, a build log, Agent details below 1024px) | Right peek sheet, no scrim, 480px (Agent details 320px)" [PR2; "a task, a build log" in PR5 and PR6]. Add after the popover row: "| Jump to anything | Command palette (top centre, with a scrim) |" (PR4).
- Replace "A peek sheet does not dim or trap focus; the page behind stays usable; Esc and Close dismiss it." with: "A peek sheet does not dim or trap focus; the page behind stays usable and clicking it does not close the peek; Esc and Close dismiss it." [PR2]; then append "Opened from a list with the keyboard, focus stays in the list so `j`/`k` retarget it in place. A task peek opens only when the list keeps room beside it; otherwise the page opens." [PR5]

### 16.7 Elevation & Depth, Form controls, Don'ts (PR2, PR4)

- Elevation: "Sheets, dialogs and drawers add the scrim" → "Modal sheets, dialogs and drawers add the scrim; peek sheets do not" [PR2]; PR4 inserts "and the command palette" after "drawers".
- Cards and panels: append "The Agent details column's strip is 48px, continuing the page header's line." [PR2]
- Motion → Durations and Popovers: after "Dialogs 150ms in (from 96%), 100ms out (fade only)." and after "Dialogs scale from 96% at the centre." add "The command palette never animates." [PR4]
- Form controls: "Native selects are used only where search beats a list (the timezone picker)." → "Where search beats a list (agents, time zones), the picker is a Combobox; there are no native selects." (PR4)
- Don'ts: "centered modals for anything but a destructive confirmation" → "centered modals for anything but a destructive confirmation or the command palette" (PR4; decision 8 approved the palette).

### 16.8 Motion → Frequency decides (append, by PR)

> [PR2] Columns that change the page's layout (Agent details from 1024px) appear instantly; only the sidebar's collapse animates. A peek retargeted to another item swaps its content in place, instantly; it never closes and reopens. A key that closes an overlay (Esc, `]`, Space on a peek) closes it at once, however it was opened. A disclosure chevron rotates only when its own chevron was clicked.
>
> [PR3] adds "the settings sub-nav" to the columns; [PR4] adds `?` to the closing keys; [PR5] adds "the inbox pane" to the columns and: "A selection moved from the keyboard (`j`/`k`, arrows) takes its fill at once; only pointer hover fades."

## 17. Behavior-doc edits (gitignored `docs/product/`; applied in the main checkout by the dev in the PR named, and listed in its description)

- `general.md` → Navigation (PR1, PR3, PR4): "Inbox, Tasks, Templates, Schedules, Usage, Settings, then Agents, which heads the live agents as the reporting tree (rows open the agent's session). ⌘K finds any agent, task or page; `?` lists the shortcuts."
- `agents-and-sessions.md` → Session view (PR2): the strip is replaced by "The header shows the status and at most one live fact (terminated, errored, queued, restart pending, waiting on, crons, in that priority). Everything else is in Agent details (Now, Org, Work, Usage, Runtime): open at 1280px and up, toggled with `]`." Actions: Compact, Edit, Stop crons and Terminate move to the header's ⋯ menu (Terminate still confirms); Restart stays visible when errored. "pinned by 2 crons" → "kept awake by 2 crons". Drop "The agent strip gains an org segment".
- `administration.md` → Settings (PR3): "Settings sections and order: Credentials, Secrets, Projects, Users, Factory, one page each with a sub-nav; `/settings` opens Credentials." Usage becomes its own top-level page (`/usage`). Schedules (PR4): "native time zone picker (no combobox…)" → "a searchable time zone picker". Templates → Images (PR6): "a view of the Templates page (`/templates/images`); the build log streams in a side panel."
- `inbox.md` (PR1, PR5, PR6): read rule: "An item becomes read when opened (click, Cmd/Ctrl-click, middle-click or Enter), when it has been shown in the reading pane for a moment, or when you reply from the pane; sweeping past with j/k does not. Opening an agent's session marks that agent's unread messages to you read." Add: "On wide screens (1024px and up) the Inbox is a list and a reading pane: the pane shows the message with its surrounding session rows, or the comment with its thread, and a composer that replies at the same target." The sidebar's agent rows show unread messages per agent. Home: "Home's Needs you panel shows the 5 newest unread items."
- `tasks.md`: [PR4] "Status is a radio menu and the assignee a searchable picker; both commit only on an explicit pick (Enter or a click), never on arrow keys." and "Tasks are searchable by key or title (⌘K)." [PR5] "The list is keyboard-navigable (`j`/`k`, Enter opens, Space peeks)."

## 18. Testing

TDD per change; Vitest + Testing Library (jsdom); server tests in the existing setup. Tests guard behaviour and regressions, never token values or DESIGN.md prose (U1 rule); the avatar contrast test computes from the tokens, it doesn't pin them.

- **Pure units:** `fnv1a32`/`botParts` golden vectors; the avatar ink contrast table; `liveFact` priority; tree shape, expansion merge (stored vs revealed), working counts; rail selection; palette `rank` and snapshotting; `plainPreview`; the shortcut dispatcher (editable, role containers, modal, `defaultPrevented`, Alt-produced keys, the off switch, `g` timeout with fake timers); `esc` for LIKE.
- **Components:** sidebar tree (APG keys, one tab stop, chevron click doesn't navigate, active row and Agents row for live and ended sessions, reveal not persisted, render counts on a frame via `vi.mock` counters, coalesced frames); `AgentAvatar` img over face and error; badge shapes in `AgentAvatar` and `StatusBadge`; `Sheet modal={false}` (no `aria-modal`, outside click keeps it, Esc closes and is instant, focus stays in the list on keyboard open, focus returns to the named element, retarget keeps the content node); Agent details per width (mocked `matchMedia` at 767/768/1023/1024/1279/1280), `]`, persistence only ≥1280; the header's one fact and Pin outside it; `Timeline` anchoring (mock `ResizeObserver`, `elementFromPoint`); `AgentMenu` items per context and Compact focus; Stop crons from the menu with the panel closed; Settings redirects and per-route loader requests; palette (opens from an input, no animation attribute missing, "Open T-42" row first and stable highlight, `q` debounce, ended label, stale rows not committable); `Combobox` (arrows don't commit, Enter commits, fixed options kept, unknown value); inbox (click selects + push + read once; `j`/`k` replace, dwell marks read after `INBOX_DWELL_MS`, a sweep marks nothing; ↑/↓ focus only; `?item=` outside the page; <1024 navigates; `setRead` keeps `byAgent`); session `read-from` (called once when visible with a count; not on preload; not while hidden); task peek (Space, width gate, retarget, Esc focus; container classes on `TaskDetailView`); Home plates and caps; Templates/Images routes, redirect, build-log retarget.
- **Server:** `byAgent` attribution; `read-from` (scope, `upTo`, idempotence, other users untouched); `q` with `%`, `_`, `\`; avatar route (headers, 400/404 cases, oversize, ETag) and `avatarVersion` on summaries; `GET /api/inbox/:id` (own, other user's, unknown).
- **Manual (per PR):** §2.13.

## 19. Follow-up issues (opened with the decisions issue)

1. (#90) Agent details resize (paperclip L5: drag, arrow keys in 16px steps, double-click reset, persisted width).
2. (#91) Sidebar tree virtualization: only if PR1's 214-agent measurement shows long frames (Q2).
3. (#92) Trigram index for task title search: only if `q` is slow on real data (Q10).
4. (#93) A keyboard chord for Agent details from inside inputs (Q37), if asked for.
5. (#94) Umbrella: unowned paperclip L1–L4 (breadcrumbs, hover cards, sticky form footers, first-step empty states) and why they are out of U2 (Q19).

## 20. Delivery

Six stacked PRs on U1's `u1/5-perceived-speed` (Q1), each on the one below, each leaving the app working, with its own CI and manual evidence. No PR depends on a later one. PR6 is last so it can be cut with a reason.

| PR | Title | Contents |
|---|---|---|
| 1 | `feat: agent avatars and agents in the sidebar` | §5.1, §5.3, §5.4, §5.5, §6 (no ⋯), §7, §15.1, §15.3; `AgentChip` on task list/detail assignee; `StatusBadge` shapes; DESIGN.md §16.1 (avatar-ink, sidebar width), §16.2, §16.4, §16.5 (Avatars); `general.md` and `inbox.md` (agent rows, read-from) |
| 2 | `feat(web): Agent details panel and a one-line session header` | §5.2, §8, §5.6 `Kbd`, the Agents page `?focus=` search (§8.3), the sidebar ⋯ (§6.3), `lib/shortcuts.ts` with `]`, DESIGN.md §16.1 (panel), §16.3 (Agent details), §16.6 (peek rows and sentence), §16.7 (Elevation), §16.8; `agents-and-sessions.md` |
| 3 | `feat(web): Settings pages and a top-level Usage page` | §9, DESIGN.md §16.3 (Sub-navigation); `administration.md` Settings, `general.md` |
| 4 | `feat: command palette, shortcuts and searchable pickers` | §10 (except `j`/`k`, which land with their lists in PR5), §15.2, DESIGN.md §16.5 (palette, combobox, shortcuts, key hints), §16.6 (palette row), §16.7 (Form controls, Don'ts); `administration.md` Schedules, `tasks.md`, `general.md`; closes #83 |
| 5 | `feat: inbox reading pane and task peek` | §11, §12, §15.4, the `j`/`k` bindings (and their lines in the shortcuts sheet), §5.6 `steel-selected` and `runInstantOn`, DESIGN.md §16.1 (selected tokens), §16.3 (Two panes), §16.5 (Selected rows); `inbox.md`, `tasks.md` |
| 6 | `feat(web): Home redesign and Templates/Images views` | §13, §14; `administration.md` Images, `inbox.md` Home |

PR3's Settings sub-nav uses `steel-selected`, which lands in PR5: PR3 renders its current row with `steel-hover` + medium weight and PR5 switches it to `steel-selected` (one line).

## 21. Decisions and deviations for Or

**Deviations from the decisions' literal text (for Or):**
- Q32: decision 2's "1 working" is drawn as the working tooth plus a number (accessible name "1 working"), because the words don't fit a 256px row with a name.
- Q34: opening an agent's session marks that agent's unread messages read (an inbox.md change).
- Q30: Agent details is in-flow (not an overlay) at 1024–1279, closed by default there, per decision 5's "closed below 1280".

| Q | Decision | Certainty |
|---|---|---|
| Q1 | Six stacked PRs; #83 pickers in PR4 with one Combobox | 4 |
| Q2 | Full live tree, roots open, collapsed below, per-browser toggles, no cap, indent stops at depth 4, roving tabindex | 4 |
| Q3 | Status on the avatar; left tooth = "you are here"; Agents row not active on a live session | 4 |
| Q4 | Seed = slug hash; spawned agents full opacity | 4 / **3** |
| Q5 | `avatar.svg` only, live from disk, locked-down headers | 4 |
| Q6 | Row anatomy; ⋯ reuses `AgentMenu` (right-click custom menu dropped later) | 4 |
| Q7 | Agent details sections; strip removed; no new endpoint (overlay part revised by Q30) | 4 |
| Q8 | Header: badge, one fact, Stop, Restart, ⋯, toggle | 4 |
| Q9 | `]` and one toggle at every width | 4 |
| Q10 | Palette groups; server `q`; ended agents after live | 4 / **3** |
| Q11 | Shortcuts incl. `c`; `?` opens a sheet | 4 / **3** (`c`) |
| Q12 | Settings routes; Usage top-level; `/settings` → Credentials | 4 / **3** (landing) |
| Q13 | `{ count, byAgent }` on the unread-count route | 4 |
| Q14 | In-flow inbox panes ≥1024, `?item=` (selection rules revised by Q31) | 4 |
| Q15 | Pane content; reuse `Composer` and `CommentComposer` | 4 |
| Q16 | Click navigates; Space peeks | **3** |
| Q17 | Home "Needs you" + "Live now"; drop-Home alternative recorded | **3** |
| Q18 | Templates/Images routes; log in a peek | 4 |
| Q19 | L1–L4 out, one umbrella issue; Agents page polish in PR1 | **3** / 4 |
| Q20 | Parts generator, flat-topped hex, golden vectors; `AgentChip` everywhere | 4 / **3** |
| Q21 | Header live-fact priority | 4 |
| Q22 | Combobox pickers; live-only to assign, ended in filters | 4 |
| Q23 | Same tree in the mobile drawer | 4 |
| Q24 | Panel instant; timeline anchoring | 4 |
| Q25 | Badges only for working, queued, rate-limited, errored (shapes by Q33) | 4 |
| Q26 | Palette top-centre, modal, scrim, never animates | 4 |
| Q27 | One left-aligned 52rem column | 4 |
| Q28 | No "Mark all read" in the palette | 5 |
| Q29 | `GET /api/inbox/:id`, own items only | 4 |
| Q30 | In-flow ≥1024 (open by default ≥1280), sheet under the header 768–1023 | 4 |
| Q31 | `j`/`k` select with replace, read after `INBOX_DWELL_MS`; click/Enter push and read | **3** |
| Q32 | Working count as tooth + number; 8px indent | **3** |
| Q33 | Distinct badge shapes, shared with `StatusBadge` | 4 |
| Q34 | Session view marks that agent's messages read; row counts messages only | **3** |
| Q35 | `steel-selected` token | 4 |
| Q36 | No header avatar badge; 48px "Agent details" strip; sizes 16/20/24; one name | 4 |
| Q37 | No input chord for `]` in U2 | 4 |
| Q38 | The rail shows only active, unread and badge-worthy agents | **3** |
| Q39 | The Agents nav row heads the tree (moved last) | **3** |
| Q40 | Fixed nav first, then the sticky Agents row and its scrolling tree | 4 |

Tech-lead decisions: D1 shell-level, coalesced status frames; D2 `usePref` over localStorage; D3 rem breakpoints; D4 per-row selectors over one index; D5 no "Mark all read" in the palette (confirmed Q28); D6 inbox click/Enter push, `j`/`k` replace (confirmed Q31); D7 no crossfade on pane or peek switches; D8 palette loaded eagerly; D9 a Search button row above the nav; D10 Agents page depth cap 8 with a depth marker; D11 no URL state for the task peek; D12 no custom right-click menu; D13 `avatarVersion` on the agent summary rather than the templates list; D14 Rate-limited has no header line fact (the badge says it).

## 22. Risks

- **Status storms with 200+ agents.** Coalesced frames and per-row selectors over one index (§5.3); the PR1 measurement decides virtualization.
- **Radix non-modal Dialog.** Outside interaction is prevented; close focus is handled by the consumer (§5.2); one peek state per page.
- **Nested focus scopes.** cmdk inside a Popover inside a non-modal Sheet (a combobox in the task peek) is tested.
- **SVG from disk.** Served only with §15.3's headers, rendered only through `<img>`.
- **Read semantics.** `read-from` must never run on preload or in a hidden tab (tested); Q34 is flagged for Or.
- **Behavior docs are gitignored.** §17 edits are applied in the main checkout and listed in each PR.
- **U1's pending decisions:** only the "Edit agent" button in Agent details (outline vs ghost) depends on them.
