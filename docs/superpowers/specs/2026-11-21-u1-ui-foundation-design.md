# U1 UI foundation: Technical Design

- **Date:** 2026-11-21
- **Status:** revised after the self-review and five UI-lens reviews (Taste, Apple design, Emil design-eng, Motion, Break UI); owner-proxy (owner-u1) answered Q1–Q23. Low certainty, for Or: Q5 (3), Q8 (3), Q16 (2), Q18 (3), Q20 (3), Q23 (3).
- **Source of truth (gitignored, read from the main checkout):** `docs/product/ui-review/decisions.md` (owner decisions 1–15, final), `docs/product/ui-review/status.md` (U1 backlog, file:line at `322075d`), `docs/product/ui-review/pr76-review.md` (R1–R5 and nits), the seven reviews in `docs/product/ui-review/`, `docs/product/behavior/*.md`.
- **Builds on:** `main` at `322075d` (PR #76).
- **Followed by:** U2 navigation, U3 chat, U4 create flows and mobile. U1 builds the primitives and the DESIGN.md rules they use; it builds none of their features.
- **Decision log:** GitHub issue "U1: UI foundation — decisions"; question numbers (Q1–Q23) and tech-lead decisions (D1–D8) below refer to it.

> `docs/product/` is gitignored. Paths into it are relative to the main checkout. All other paths are relative to the repo root; web paths are relative to `apps/web/src/` unless they start with `apps/`.

## 1. Goal

Make the existing UI correct and consistent before U2–U4 change its shape:

1. Fix the bugs and quick fixes listed in status.md's U1 section.
2. Amend DESIGN.md with the owner's decisions (overlay ladder, toasts, flat floating layers, graphite controls, avatar palette, type scale) and the motion rules the reviews proposed.
3. Ship the overlay primitives (an adaptive sheet: right on desktop, Vaul bottom drawer on phones; a Vaul drawer; `ConfirmDialog` made adaptive behind its existing API) and one control system (button, input, select, radio, checkbox, segmented control, focus ring, row hover and press, tooltip, menu, spinner, skeleton), so U2–U4 compose rather than invent.
4. Stop the session timeline from re-rendering and re-parsing every row on every WebSocket frame (motion H2), before U3 adds token streaming.
5. Close the PR #76 follow-ups R1–R5 and its nits (decision 15).

## 2. Acceptance criteria

All run in default CI (`pnpm test`, `pnpm typecheck`, `pnpm lint`) unless marked manual.

1. **Home.** With agents in the cache, Home's Agents panel lists them (§7.1); with none, it says "No agents yet." and links New agent. A test covers both.
2. **No sideways page.** A task with a 300-char unbroken URL in its body and in a comment, and a session message with an 11 KB single-line token, produce `scrollWidth <= clientWidth` on the page and on the timeline scroller at 390px and 1440px (jsdom cannot lay out: covered by class assertions in tests plus a manual check recorded in the PR at 320, 390, 768 with the sidebar open, 1440, and 200% text at 1024).
3. **Header.** A long agent name never overlaps the status badge or the actions: the header gives way in the §7.3 order (Q22): the mono name in meta first, then a data title down to a 4rem floor (2rem below a 22rem header, so the actions never leave the screen); the status badge, static titles and actions never shrink, and truncated text keeps its full value in `title` (class test with a 40-char template name + manual check at 320, 390, 768 and 1024).
4. **Reduced motion.** Under `prefers-reduced-motion: reduce` the loading mark is lit and still; every spinner is static; skeletons never animate (CSS test for the layer order, manual DevTools check).
5. **Controls.** No browser-blue control remains: `grep -rn 'type="radio"\|type="checkbox"' apps/web/src --include=*.tsx` (tests excluded) returns only `components/ui/segmented-control.tsx`; every focusable primitive shows the same 2px signal ring at a 2px offset; `NativeSelect` is used only by the timezone picker.
6. **Overlays.** On desktop the sheet travels 100% of its width with no panel fade (250ms in on `--ease-drawer`, 200ms out on `--ease-out`), its scrim on the same timing; dialogs 150/100ms; menus, popovers and tooltips 100/75ms with no slide; no floating layer has a shadow; all floating layers carry the `--float-edge` border. Below 768px every `ConfirmDialog` renders as a Vaul bottom drawer and the mobile nav as a Vaul left drawer that a drag or flick dismisses. Keyboard-opened overlays don't animate (`data-instant` zeroes animations). Tests cover structure and data attributes; motion is a manual check recorded in the PR.
7. **Timeline performance.** In a test session with 200 rows, an `agent_status` frame re-renders no `TimelineRow` and no `Markdown`; one appended `session_event` renders exactly one new row and one `Markdown`; ten frames delivered in one task commit once. Manual: a DevTools Performance recording on a 2,000-event session before and after, attached to the PR (frame time on an `agent_status` frame and on scroll).
8. **Data layer.** `createQueryClient()` is used by the app and by `renderApp`; unit tests show 404, 400 and `ZodError` are not retried, 500, 408, 429 and `TypeError` are, and retries stop after 3; hovering a task or schedule link and then clicking sends one detail request, not two (templates: §10.2); a detail GET that started before a task save and resolves after it doesn't overwrite the saved task; a WebSocket reconnect invalidates every query; credentials, secrets, projects and templates list refetch on window focus.
9. **Send keys.** Enter sends and Shift+Enter adds a newline in both the session composer and the task comment composer; ⌘/Ctrl+Enter also sends; on a coarse pointer Enter adds a newline; an IME-confirming Enter never sends.
10. **Composer errors.** A message over 64 KB (UTF-8) is refused before any request with an inline line naming its size and the limit; a server validation error shows the issue's message without a schema path (server test on `errors.ts`).

## 3. Scope

**In:** everything in §5–§11, the U1 checklist in §4, and the DESIGN.md amendments in §12.

**Out (owned elsewhere, do not build):**
- U2: agents in the sidebar, the avatar component, the session right panel, the ⌘K palette and its `cmdk` dependency, Settings split into pages, Usage top-level, the inbox reading pane, the Home redesign, task peek, Templates/Images layout.
- U3: activity line, Stop in the composer, one jump-to-latest, speaker identity, per-tool renderers, token streaming, fence-close highlighting, subagent cards, `/` and `@` in a shared composer, live-row fade, copy-link blur crossfade.
- U4: New agent, New task, New/Edit schedule and Edit agent in sheets, the sheet URL convention, inline credential/secret/project setup, toasts (Sonner is not approved), slug from display name, the mobile pass (long-press, row menus as drawers, 40px touch targets, tree rows on phones).

## 4. U1 checklist

Every U1 item in status.md, pr76-review.md and decisions 14–15, with where this spec handles it.

| # | Item (status.md U1 # / source) | Where |
|---|---|---|
| 1 | Home "No agents yet." (U1 #1) | §7.1 |
| 2 | Long tokens widen the page; task grid overflow (U1 #2) | §7.2 |
| 3 | Header badge collision; Templates header at 320 (U1 #3) | §7.3 |
| 4 | Loading mark vs reduced motion; hard loop cut (U1 #4) | §7.4 |
| 5 | One control system (U1 #5) | §6 |
| 6 | Tooltips: delay, timing, native `title`s (U1 #6) | §5.6, §7.6 |
| 7 | Dropdown easing, slide, crimson Delete, base width (U1 #7) | §5.5 |
| 8 | Interrupt icon (U1 #8) | §7.5 |
| 9 | Composer copy, schema path in errors, 64 KB check (U1 #9) | §7.7 |
| 10 | Enter vs ⌘Enter (U1 #10) | §7.8 |
| 11 | Sheet, drawer and dialog primitives (U1 #11) | §5 |
| 12 | DESIGN.md amendments (U1 #12) | §12 |
| 13 | Timeline render performance (U1 #13) | §9 |
| 14 | Spinners and skeleton vs reduced motion (U1 #14) | §6.9 |
| 15 | Motion polish: pending screen, status dots, chevrons, sidebar (U1 #15) | §8 |
| 16 | Perceived speed beyond preload (U1 #16) | §11 (scope per Q3) |
| 17 | Type scale (decision 14; apple B2/C4, taste T-M2) | §6.10, §12 |
| 18 | R1 shared query client | §10.1 |
| 19 | R2 loaders branch on `preload` | §10.2 |
| 20 | R3 cancel in-flight detail fetch before a save write | §10.3 |
| 21 | R4 stale lists and reconnect | §10.4 |
| 22 | R5 retry rule | §10.1 |
| 23 | #76 nits (9) | §10.5 |

Deferred with a follow-up issue (§14): timeline virtualization (break L7), the sidebar collapse animation (motion M3, needs a recording), the reconnect strip's height animation (motion M4 second half, owned by no spec), optimistic single-field saves (U1 #16 last bullet, per Q3).

status.md also lists the adaptive confirmation (as "bottom confirmations"), the mobile nav drawer and the manager-picker indent under U4 #1 and #4: U1 delivers those three (Q2, §6.5), and U4 builds on them.

Correction to status.md: `features/agents/agent-actions.tsx:257,283,300` are `title` props of `ActionRow` that render an `<h3>`, not native tooltips. Only `template-editor.tsx:534,543,549` and `link-editor.tsx:118` are native `title`s.

## 5. Overlays

### 5.1 The ladder (decision 1)

| Need | Primitive | U1 consumers |
|---|---|---|
| Quick pick or info about one control | `Popover`, `DropdownMenu`, `Select`, `Tooltip` | existing |
| Create/edit form, quick peek | `Sheet`: right panel on desktop, bottom `Drawer` below 768px | none in U1 (first form consumer is U4); tested directly (Q2) |
| Primary work | a route | existing |
| Destructive confirmation | `ConfirmDialog` (API unchanged, internals swapped, Q2): `AlertDialog` (desktop) or bottom `Drawer` (< 768px) | all eight existing `ConfirmDialog` users, with no call-site diff |
| Mobile navigation | `Drawer` left | `components/ui/sidebar.tsx` mobile branch |

"Mobile" is `useIsMobile()` (`hooks/use-mobile.ts`), whose query becomes `(width < 48rem)`, sharing one constant with the `md` breakpoint the desktop sidebar uses (`sidebar.tsx:216,237`). Today it is `max-width: 767px` in px while `md` is 48rem, so with a 24px browser font a 768–1151px window gets neither the desktop sidebar nor the nav drawer. Below, "768px" means 48rem at the default text size. An adaptive overlay (`Sheet`, `ConfirmDialog`) decides dialog-or-drawer **once, when it opens** (state captured on the closed → open edge, reset on close) and keeps that primitive until it closes. Crossing 768px while open (an iPad mini rotation at 744px, Split View, a window resize) changes nothing: both branches work at any width, a pending confirmation is never swapped mid-request, and a U4 form never loses its draft to a resize. Test: open, flip the mocked `matchMedia`, assert still open with the same role.

### 5.2 Shared floating-layer look (decision 11)

- No `shadow-*` on any floating layer. Remove `shadow-md` from `popover.tsx:30` and `dropdown-menu.tsx:45`, `shadow-lg` from `dropdown-menu.tsx:246` and `sheet.tsx:65`. The active tab in `tabs.tsx:63-65` also loses its shadow and takes the segmented-control look (§6.7). (The `shadow-*` in `sidebar.tsx:249,314,480` belong to the unused `floating` and `inset` variants and an `outline` menu-button variant that draws its border with a box-shadow; they are left alone.)
- Edge: `border border-float-edge` replaces `ring-1 ring-foreground/10` on popover, dropdown content and sub-content, select content, alert dialog, sheet (its inner edge only) and drawer (its inner edge only). Tooltips stay inverted (`bg-foreground`) with no edge.
- Surface: `bg-popover` (one plate step above `card`), as today.
- Scrim: `bg-black/20` in light mode and `dark:bg-black/40` in dark mode (Q19; 20% is near invisible over graphite), for sheet, dialog and drawer; no blur. Values confirmed in the Q8 screenshot pass.
- Tokens: `styles.css` gains `--float-edge` in `:root`, the dark theme and the `prefers-contrast: more` block (there it moves to `field-edge`, ≥3.2:1), plus `--color-float-edge` in `@theme inline`. The avatar tokens (§12.1) are added in U1 too, so U2 only builds the component.

### 5.3 `Sheet` (`components/ui/sheet.tsx`, rewritten)

One API for U4's forms and peeks: `Sheet` (`open`, `onOpenChange`), `SheetContent`, `SheetHeader`, `SheetTitle`, `SheetDescription`, `SheetBody`, `SheetFooter`, `SheetClose`. On desktop it renders the Radix Dialog right panel below; below 768px it renders the §5.4 bottom `Drawer` with the same slots (decision 1), chosen at open (§5.1). The `side` prop is removed: the only left-side consumer, the mobile nav, moves to `Drawer` (§5.8). There is no separate "responsive" component (Q2: no parallel primitives).

Desktop panel:

- Panel: `fixed inset-y-0 right-0 z-50 w-[min(30rem,100%)] flex flex-col bg-popover border-l border-float-edge`, `data-slot="sheet-content"`.
- Motion: `data-open:animate-in data-open:slide-in-from-right duration-250 ease-(--ease-drawer)`, `data-closed:animate-out data-closed:slide-out-to-right data-closed:duration-200 data-closed:ease-(--ease-out)`. No fade on the panel. Reduced motion: the global override zeroes the translate; `motion-reduce:data-open:fade-in-0 motion-reduce:data-closed:fade-out-0` makes it fade instead of snapping (tested).
- Scrim: same durations and curves as the panel, opacity only.
- Slots: `SheetHeader` (`min-h-12 py-3 flex items-start gap-2 border-b px-4`: `SheetTitle` in Archivo 16/20 600, `min-w-0 flex-1 [overflow-wrap:anywhere] line-clamp-2`, titles come from data; the close button `shrink-0`), `SheetBody` (`flex-1 min-h-0 overflow-y-auto p-4`, `@container` so content lays out by the sheet's width, never the viewport's: break-ui "Redesign 1"; the inner width is ~448px, so consumers use `@sm`/`@lg` breakpoints, never `@md`, which a scrollbar would flip), `SheetFooter` (`border-t p-4 flex flex-wrap justify-end gap-2`, pinned; under `@media (max-height: 30rem)` the footer scrolls with the body so a 200%-text form above an iOS keyboard keeps a usable body). `SheetDescription` stays. `DrawerHeader`/`DrawerFooter` follow the same rules; drawer footers stack full-width buttons with the primary action first and Cancel last (Q14 applies to every bottom drawer).
- Close: the header's ghost icon button, `aria-label="Close"`. Esc and the scrim close.
- Focus: Radix moves focus into the panel on open (the first focusable element, or the content with `tabIndex={-1}` when a consumer passes `onOpenAutoFocus` to keep the keyboard down) and returns it to the trigger on close.
- Peek mode (Q18): not built in U1. DESIGN.md records the rule now; U2 adds a `modal` prop to this same `Sheet` (passed through to Radix Dialog) with its first peek consumer.
- The sheet asks nothing on dismiss (Q9). Keeping a typed draft is the consumer's job in U4: in memory for the tab (component state lifted above the sheet, or the query cache), not across a reload.
- Stacking: a sheet opened from inside a sheet is allowed one level deep; the primitive doesn't enforce it, DESIGN.md does (U4 has the only stacked case).

### 5.4 `Drawer` (`components/ui/drawer.tsx`, new; Vaul)

- Dependency: `vaul@1.1.2`, `pnpm --filter @open-factory/web add --save-exact vaul@1.1.2` (decision 8). It depends on `@radix-ui/react-dialog ^1.1.1`, which resolves to the `1.3.1` already in `pnpm-lock.yaml` (through `radix-ui`), so the only new package is `vaul` itself. No supply-chain setting changes.
- Exports `Drawer` (Root, `direction` `"bottom" | "left"`), `DrawerContent`, `DrawerHeader`, `DrawerTitle`, `DrawerDescription`, `DrawerBody`, `DrawerFooter`, `DrawerClose`. Content and overlay are `fixed z-50` and carry `data-slot="drawer-content"` / `data-slot="drawer-overlay"`.
- Bottom: `inset-x-0 bottom-0 max-h-[90svh] rounded-t-xl border-t border-float-edge bg-popover`, a 4×36px handle (`bg-border`, `aria-hidden`), bottom padding `max(1rem, env(safe-area-inset-bottom))`. The surface runs edge to edge; its inner column is `mx-auto w-full max-w-lg`, so a 600–767px window doesn't stretch buttons across.
- Left: `inset-y-0 left-0 w-(--sidebar-width) max-w-[85vw] border-r border-float-edge`.
- Focus: Vaul's Root defaults `autoFocus` to `false` and prevents Radix's open auto-focus (`vaul/dist/index.mjs`), which would leave focus on the trigger behind the scrim. The wrapper defaults `autoFocus` to `true`; its `onOpenAutoFocus` focuses the content (`tabIndex={-1}`) rather than the first input, so the iOS keyboard doesn't rise mid-slide; consumers can override (ConfirmDialog keeps Cancel's `autoFocus`). `onCloseAutoFocus` passes through. Tests assert `document.activeElement` is inside the drawer after open.
- Motion: Vaul animates open and close with CSS keyframes at 0.5s from a `<style>` it appends to `<head>` when its module loads, after `styles.css`, unlayered. Tailwind utilities live in `@layer utilities` and lose to it, and an equal-specificity rule loses the tie on source order. So `styles.css` gets an **unlayered** block whose declarations are `!important`: an important declaration beats Vaul's normal ones regardless of specificity or order, so one mechanism does the job (Vaul's rules: `[data-vaul-drawer]` for duration, `[data-vaul-overlay][data-vaul-snap-points=false]` for the overlay's duration, four-attribute selectors for `animation-name`):
  ```css
  /* Vaul 1.1.2 (pinned) injects unlayered rules after this file: [data-vaul-drawer]{animation-duration:.5s},
     [data-vaul-overlay][data-vaul-snap-points=false]{animation-duration:.5s}. !important overrides them.
     Re-check on any Vaul upgrade; the guard test in drawer.test.tsx fails if these attributes change.
     DESIGN.md → Motion. */
  [data-vaul-drawer][data-slot="drawer-content"][data-state="open"] { animation-duration: 250ms !important; animation-timing-function: var(--ease-drawer) !important; }
  [data-vaul-drawer][data-slot="drawer-content"][data-state="closed"] { animation-duration: 200ms !important; animation-timing-function: var(--ease-out) !important; }
  [data-vaul-drawer][data-slot="drawer-content"][data-state="closed"][data-released] { animation-duration: 300ms !important; animation-timing-function: var(--ease-drawer) !important; } /* Q23 */
  [data-vaul-overlay][data-slot="drawer-overlay"][data-state="open"] { animation-duration: 250ms !important; animation-timing-function: var(--ease-drawer) !important; }
  [data-vaul-overlay][data-slot="drawer-overlay"][data-state="closed"] { animation-duration: 200ms !important; animation-timing-function: var(--ease-out) !important; }
  ```
  jsdom can't evaluate the cascade, so the manual 10%-speed check (§13) confirms the panel and scrim run together.
- Reduced motion: no specificity contest. Vaul's slide keyframes animate from `var(--initial-transform, 100%)`, which its JS never sets; `@media (prefers-reduced-motion: reduce) { [data-vaul-drawer] { --initial-transform: 0px } }` turns the slide into a no-op (the keyframe still runs, so Presence still waits for it), and an inner wrapper of `DrawerContent` fades with `motion-reduce:animate-in motion-reduce:fade-in-0` / `motion-reduce:animate-out motion-reduce:fade-out-0`. Tested by class and variable presence.
- Keyboard-opened drawers: the §8.1 stamp applies (`[data-instant] { animation: none }` in the base layer with `!important`; a layered `!important` beats Vaul's unlayered normal rules, so nothing more is needed).
- Post-flick close (Q23): `onRelease` sets `data-released` on the content when a drag ends in a close, so that close runs 300ms on `--ease-drawer` instead of 200ms (a flick otherwise leaves ~5× faster than the finger). Vaul's other fixed 0.5s timers (`onAnimationEnd` cleanup, the 500ms drag lockout after open) stay; nothing in our code sequences on them.
- Drag: Vaul's own 1:1 tracking. Its dismissal rule is not configurable: velocity measured as total distance over total drag time above 0.4 px/ms, or past 25% of the drawer's size; drags are ignored for 500ms after open. Its release snap-back is an inline 0.5s transition in its JS and stays (recorded in DESIGN.md as the accepted exception, Q11). Controls inside a drawer that must not start a drag get `data-vaul-no-drag`.
- Interruptibility (Q11): open and close are keyframes, as with every Radix overlay; a scrim tap mid-open plays the exit from the end state. Drag is interruptible. Recorded in DESIGN.md with the reason.
- Upgrade guard (Q11): `drawer.test.tsx` renders an open `Drawer` and asserts the content has `data-vaul-drawer`, `data-slot="drawer-content"` and `data-state`, the overlay `data-vaul-overlay`, and that the injected Vaul `<style>` still contains `[data-vaul-drawer]{` with `animation-duration:.5s`, `[data-vaul-overlay][data-vaul-snap-points=false]{` and the `animation-name:slideFromBottom` / `slideFromLeft` rules keyed on `--initial-transform`; an upgrade that renames or re-scopes them fails CI. (Verified: Vaul's style lands in jsdom's `<head>`.)

### 5.5 `DropdownMenu` (`components/ui/dropdown-menu.tsx`)

- Content and sub-content: `duration-100 ease-(--ease-out) data-closed:duration-75`, `fade-in-0 zoom-in-95` / `fade-out-0 zoom-out-95` only; remove every `data-[side=*]:slide-in-from-*-2`; keep `origin-(--radix-dropdown-menu-content-transform-origin)`; `motion-safe:` on the zoom (as `popover.tsx` does).
- Remove `w-(--radix-dropdown-menu-trigger-width)` from the content base, which becomes `min-w-32 max-w-[min(var(--radix-dropdown-menu-content-available-width),20rem)]`; items wrap (`[overflow-wrap:anywhere]`). The task status and assignee menus (`tasks/assignee-menu.tsx:53` and the status menu) set the trigger width explicitly. A class test asserts the base `max-w-`.
- Items: one floating-row height for menus and selects, 32px (`min-h-8 py-1.5`), `pointer-coarse:min-h-9`. Menu and select items show focus as the `accent` fill, not a ring: the one named exception to §6.1, because roving focus inside a list is a highlight.
- Destructive items: every item that deletes, removes, revokes, disables, archives or terminates uses `variant="destructive"` and has a `DropdownMenuSeparator` above it. Known sites: `schedules/schedule-row.tsx:125` (Delete), `settings/credentials-section.tsx` (~523, Delete), `settings/projects-section.tsx` (~418, Remove), `settings/users-section.tsx` (~317, Disable); the plan re-greps.

### 5.6 `Tooltip` and `Popover`

- `TooltipProvider`: `delayDuration = 400`, `skipDelayDuration = 300`.
- `TooltipContent`: remove the four `slide-in-from-*-2`; `duration-100 ease-(--ease-out)`, closed `duration-75`; animate only on `data-[state=delayed-open]`; keep `zoom-in-95` under `motion-safe:`. The `data-open:animate-in …` pair is dead code (shadcn's `data-open:` matches only `data-state="open"`, which a tooltip never has) and is removed as cleanup; `instant-open` (neighbours, focus) already appears without animation.
- `PopoverContent`: already right on timing; gains `data-closed:duration-75`, the `float-edge` border and loses `shadow-md`.

### 5.7 `AlertDialog` and `ConfirmDialog`

- `alert-dialog.tsx:37,59`: content and overlay `duration-150 ease-(--ease-out)`, closed `duration-100`; content enters with `motion-safe:zoom-in-[0.96]` and fade, leaves with a plain 100ms fade (no zoom), centered origin; `rounded-xl` → `rounded-lg` (6px, DESIGN.md Shapes); `float-edge` border.
- `ConfirmDialog` (`components/confirm-dialog.tsx`) keeps its props and behaviour (pending holds it open, Cancel autofocus, inline error), so no caller changes (Q2) except one: `pendingLabel` becomes **required** (Q16), and the seven callers without one get a present-participle label ("Terminating…", "Deleting…", "Disabling…", "Starting…", "Unpinning…"). Its internals become adaptive (chosen at open, §5.1): below md it renders `Drawer direction="bottom"` with `role="alertdialog"` on the content, `dismissible={!pending}`, outside taps ignored while pending; the drawer holds the title (header), the body and error line in a `DrawerBody` (`min-h-0 flex-1 overflow-y-auto`), then the footer: the destructive action full-width **first** and Cancel full-width **last**, at the bottom, focused on open (Q14: platform convention, the thumb rests on the safe action). On desktop the dialog is `sm:max-w-md`, `max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto]` with the body scrolling and the footer pinned and `flex-wrap`. Buttons that carry a name may wrap (Q21): `whitespace-normal h-auto min-h-8 py-1.5 text-center [overflow-wrap:anywhere]`, never truncated. Title and body wrap with `[overflow-wrap:anywhere]` (break-ui "Redesign 5"). Tested with a 64-char secret name, a 40-char slug and 30 crons at 320×568 and at 1440×700 with 200% text (manual).
- The spinner inside it is `<Spinner>` (§6.9).

### 5.8 Mobile navigation (Q2)

`components/ui/sidebar.tsx`'s `isMobile` branch renders `Drawer direction="left"` in place of `Sheet`, keeping `data-sidebar="sidebar"`, `data-mobile="true"`, the sr-only title and description, and `openMobile` / `setOpenMobile`. The drawer is portaled outside the sidebar provider's wrapper, so it sets `--sidebar-width: 18rem` (`SIDEBAR_WIDTH_MOBILE`) inline and carries `bg-sidebar p-0 text-sidebar-foreground` itself. It opens from its button (or ⌘B), never by an edge swipe: the browser's back gesture owns the screen edge. ⌘B is keyboard-initiated, so it opens without animation (§8.1).

## 6. Controls

### 6.1 Focus ring (D5)

One ring everywhere: the base-layer `:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px }` (`styles.css`). Every utility that suppresses or replaces it goes, because a utility beats the base layer (`outline-none` compiles to `outline-style: none` in `@layer utilities`; verified in Tailwind 4.3.5):

- Primitives: remove `outline-none` and `focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50` from `button.tsx:7`, `input.tsx:10`, `textarea.tsx:9`, `checkbox.tsx:14`, `tabs.tsx:81`; remove `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2` from `native-select.tsx:8`; `outline-ring/50` in the base `*` rule goes.
- Feature halos: remove the row-level `focus-visible:ring-3 … outline-none` at `agents/agent-tree.tsx:131`, `tasks/task-list.tsx:46`, `inbox/inbox-row.tsx:89`, `templates/template-list.tsx:48`, `templates/issue-list.tsx:60`, `usage/usage-tables.tsx:9,44`, `settings/usage-section.tsx:50`, `usage/usage-chart.tsx:121`, and `outline-hidden … focus-visible:ring-2` at `sidebar.tsx:409,429,474,561,674`. The plan re-greps all of `apps/web/src`.
- Rows take the ring **inset**: `.of-row`, sidebar menu buttons and timeline rows use `outline-offset: -2px`, so the ring never spills over a divider or gets clipped by a scroller.
- Segmented labels: `has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring`.
- Exception: menu, select and (later) command items show focus as the `accent` fill (§5.5).
- Invalid state keeps `aria-invalid:border-destructive` only (no translucent halo). Increased contrast keeps its 3px ring.
- Test (§13): a source scan over all of `apps/web/src` (not only `components/ui`) fails on `ring-3`, `ring-ring/50`, `outline-none` and `outline-hidden` outside an allowlist of the menu/select item classes.

### 6.2 Heights

Controls are 32px (`h-8`) on fine pointers and 36px (`pointer-coarse:h-9`) on coarse ones: button `default`, input, textarea min, select trigger, segmented control `default`. DESIGN.md's YAML (`button-primary`, `button-ghost`, `input` at 36px) is corrected to match its own Layout text (§12).

### 6.3 Button (`components/ui/button.tsx`) (Q6)

- Disabled, all variants (Q17, amended by decision 21): one disabled look for both `disabled` and `aria-disabled="true"`: the variant keeps its own shape, with `text-muted-foreground cursor-not-allowed`, no hover change, no press scale, no opacity fade. Primary and destructive take the plate with a rule border (`bg-card border-border`); outline keeps its `bg-card` plate and `border-border` edge; ghost and link stay borderless with no plate (a disabled ghost must never read as an enabled outline button) (never a faded graphite slab, never heavier than an enabled outline button). The 20+ per-site `aria-disabled:opacity-50` patches (`confirm-dialog.tsx:80,87`, `settings/shared.tsx:279`, `settings/factory-section.tsx:230`, `agents/agent-form.tsx:554`, `templates/template-editor.tsx:438,463,532,674`, `templates.new.tsx:150`, `session/interrupt-button.tsx`, the recovery and agent-actions buttons; the plan re-greps) are deleted. A pending ConfirmDialog action keeps `aria-disabled` (so focus stays on it) but also carries `aria-busy="true"`, which exempts it from the disabled look: it stays destructive-styled with its spinner and pending label.
- `default`: graphite, as today.
- `outline` = the secondary style: `bg-card border-border hover:bg-muted`, dark `bg-card border-border`. Used only for page- or header-level standalone actions (Edit beside a title, Verify, Re-sync, Load earlier, Cancel in dialogs) (decision 20).
- `ghost`: standalone secondary actions inside a section (rail and section-header actions, repeated per item: Add a description, Edit dependencies, Edit links stay ghost) (decision 20), icon buttons, toolbar items, and actions repeated on every item of a list (Reply on each comment).
- `destructive`: crimson text on a crimson 10% tint, as today.
- `secondary` variant: removed (no call site uses it).
- The plan audits the 78 `variant="ghost"` call sites: a **standalone** page- or header-level button with a visible text label that is not in a toolbar becomes `outline`; in-section actions (rail and section-header actions) stay ghost (decision 20). Repeated per-item actions (Reply on every comment card, per-row actions) stay ghost (Q17), so a thread isn't a column of boxes.

### 6.4 Input and Textarea

`bg-card` fill (DESIGN.md: inputs are plates; today `bg-transparent` and many call sites patch `bg-card dark:bg-card`), `border-input` (field-edge), the §6.1 ring, `text-sm` at all widths except `pointer-coarse:text-base` (iOS zoom guard).

### 6.5 Select (`components/ui/select.tsx`, new) (Q12)

Radix `Select` from `radix-ui`: `Select`, `SelectTrigger` (§6.2 height, `bg-card border-input`, chevron `ink-muted`), `SelectContent` (`position="popper"`, `min-w-(--radix-select-trigger-width)`, §5.2 look, §5.5 timings, `origin-(--radix-select-content-transform-origin)`), `SelectItem` (32px, graphite check), `SelectGroup`, `SelectLabel`, `SelectSeparator`. Content: `max-w-(--radix-select-content-available-width) max-h-(--radix-select-content-available-height)` with Radix's scroll buttons; items `min-h-8 py-1.5` and wrap. Trigger: `min-w-0`, the value truncates (with `title`), chevron `shrink-0`. Agent options set `textValue` to the slug so typeahead works despite "@" labels; the closed manager picker shows the name and a muted `@slug` as two spans so the slug truncates first. With 200+ agents a Select is still a long list: the cmdk follow-up (§14) covers agent pickers too. Radix forbids `""` as an item value: call sites with an "Any"/"All" option use a sentinel (`"__all"`) mapped at the boundary.

Replaces `NativeSelect` in `tasks/task-filters.tsx`, `tasks/agent-picker.tsx`, `tasks/link-editor.tsx`, `agents/agent-form.tsx`, `schedules/schedule-filters.tsx`. `schedules/timezone-select.tsx` keeps a native `<select>` (≈400 zones; typeahead without search is worse) restyled to the shared height, fill, edge and ring; `NativeSelect` stays for that one use; a follow-up issue (§14) replaces it with the cmdk combobox when U2 adds cmdk. The manager picker in `agent-form.tsx` caps its indent at 3 levels and prefixes deeper levels with `└ ` (break M2 quick fix); the closed trigger shows the name without indentation.

### 6.6 RadioGroup and Checkbox (decision 12)

- `components/ui/radio-group.tsx` (new, Radix): 16px circle, `border-input`, checked: graphite border and a 6px graphite dot. Replaces the raw radios in `settings/credentials-section.tsx:241`.
- `Checkbox` (Radix, graphite, as today) replaces the native checkbox in `agents/project-grant-picker.tsx:62`.
- Prose task lists (`styles.css:360`) switch `accent-color` from `--signal` to `--foreground`: graphite everywhere, orange only for live state.

### 6.7 SegmentedControl (`components/ui/segmented-control.tsx`, new)

A `fieldset` of sr-only native radios with styled labels (the pattern `agents.index.tsx:172` and `usage/range-filter.tsx:19` already use, so arrow keys and form semantics come free).

- Track: `inline-flex rounded-lg bg-muted p-0.5`, height on the track: `h-8` (default) or `h-7` (`sm`, header filter bars only), both `pointer-coarse:h-9`. In dark mode the track is the ground (`dark:bg-background`), so the selected plate still steps lighter.
- Segment: `h-full rounded-md border border-transparent px-2.5 text-sm text-muted-foreground`; selected `bg-card text-foreground border-border` (dark: `dark:bg-accent`); `transition-[background-color,color,border-color] duration-150 ease-(--ease-out)`. Unselected segments keep a transparent border so selection never shifts labels.
- Props: `legend` and `legendVisible?` (`when-field` shows its "When" legend), `name`, `value`, `options: { value: string | number; label: ReactNode }[]`, `onChange(value)`; `range-filter` passes numbers (`UsageDays`).
- `min-w-0 max-w-full`, labels `whitespace-nowrap`, a `block` prop for full width (`when-field`). Only for 2–4 short fixed labels; options from data, or more than 4, use a Select.
- Replaces `agents.index.tsx:172`, `usage/range-filter.tsx:19`, `schedules/when-field.tsx:31-46`. The `Tabs` active trigger (`tabs.tsx:63-65`) takes the same selected look (no shadow).

### 6.8 Row hover and press

A `.of-row` class in `@layer components`, one token, `--accent` (DESIGN.md's `steel-hover`, the same fill menus use):

- `transition: background-color 150ms var(--ease-out)`.
- `@media (hover: hover) and (pointer: fine) { .of-row:hover { background: var(--accent) } }`.
- `.of-row:active { background: color-mix(in oklch, var(--accent), var(--foreground) 6%); transition-duration: 0ms }`: the press lands at once, the release eases back.
- `@media (pointer: coarse) { .of-row:active { transition-delay: 80ms } }`, so a touch that starts a scroll doesn't flash the row.
- Focus: the inset ring (§6.1). No scale on full-width rows.
- Applied to `agents/agent-tree.tsx:131`, `tasks/task-list.tsx:46`, `inbox/inbox-row.tsx:89` (their `hover:bg-sidebar-accent` removed) and the Home agents rows (§7.1).

### 6.9 Spinner and Skeleton

- `components/ui/spinner.tsx` (new): `Loader2`, `aria-hidden`, `motion-safe:animate-spin`, `size` `"text"` (3.5) or `"button"` (4). Static under reduced motion (Q16, certainty 2: Or may prefer it keeps turning); a spinner always sits next to a pending label, which is what shows progress: ConfirmDialog's `pendingLabel` is required (§5.7) and template Save reads "Saving…" while pending. Replaces bare `animate-spin` in `templates/template-editor.tsx:468,629`, `components/confirm-dialog.tsx:90`, `components/auth-card.tsx:46`, `routes/_app/templates.new.tsx:151`.
- `Skeleton`: static `bg-muted` plate; `animate-pulse` removed (DESIGN.md: skeletons are static plates, the loading mark is the only authored animation).

### 6.10 Type scale (decision 14, Q5)

- Detail title: the **task** title (`tasks/task-detail.tsx:299`) becomes Archivo 20/28 (`text-[1.25rem] leading-[1.75rem]`), weight 650, tracking −0.015em. Template and schedule pages have no in-body title (their title is the 16/20 PageHeader h1: `templates/template-editor.tsx:524`, `schedules/schedule-edit.tsx:126`), so they don't change.
- Inside detail bodies and comments (task body, comments, timeline messages), markdown headings drop one step: h1 17, h2 15, h3 14, all 650. Implemented as a `.prose-of-detail` modifier on `Markdown`'s wrapper via a `variant="detail"` prop; standalone markdown (template README views) keeps 20/17/15.
- Heading tracking (Q20): −0.015em at 20px, −0.01em at 15–17px, 0 at 14px (the demoted h3 included).
- Reading prose stays 14/22 (Q5). **Deferred to U3:** U3 decides the reading size (taste's 15/24) together with the timeline tiers, and re-derives the demoted heading sizes with it (a 15px body would equal the h2); recorded in DESIGN.md and as a follow-up issue so it isn't lost.
- The PR carries before/after screenshots of a task detail (Q5 is certainty 3; Or may retune the values).

## 7. Bugs and quick fixes

### 7.1 Home Agents panel (Q10, Q15)

`routes/_app/index.tsx:23`: the panel renders `HomeAgents` (new, `features/agents/home-agents.tsx`):

- Data: the existing agents list query; no new endpoint or field (Q10).
- Which and in what order (Q15): persistent, non-archived agents; **needs attention** first (errored, stuck, rate-limited, restart pending), then **working**, then the rest (idle, queued, hibernated); within a group by display name, then slug (names aren't unique). Up to 8.
- Stable under the pointer (Q15): while the pointer is over the panel or focus is inside it, the displayed order is frozen (status changes update rows in place); the new order applies on `pointerleave`/`focusout`, with no animation. Implemented by holding the last order in state and recomputing only when the panel isn't engaged. Tested.
- Row: a link to the agent's live session `/agents/$slug`, `.of-row`: the `StatusBadge` with its **visible** short label (never colour alone; stuck and restart-pending show their own label, not idle's), the display name (truncating, `title` with the full name), a muted `@slug` that truncates first.
- States: loading, three static skeleton rows; error, "Couldn't load agents."; empty, "No agents yet." plus a "New agent" link to `/agents/new`.
- Overflow: when the cap cuts rows, a last line "All N agents" links `/agents`, so the panel never looks complete when it isn't.
- Home's inbox row timestamp running past the card edge at 390 (`inbox/inbox-row.tsx:137`, `home--lively--390.png`): the row grid becomes `grid-cols-[minmax(0,1fr)_auto]`.

### 7.2 Overflow (break H1, H2)

- `.prose-of :is(p, li, blockquote) { overflow-wrap: anywhere }` and `.prose-of :is(a, :not(pre) > code):not(td *, th *) { overflow-wrap: anywhere }` in `styles.css`; table cells get `overflow-wrap: break-word` only, because `anywhere` lowers a cell's min-content width so the table squeezes its columns (breaking "in_prog/ress") instead of overflowing into `.md-table`'s own scroll. `pre` and `.md-table` keep their own scroll. The §2.2 manual check adds a 4-column table at 390px.
- `tasks/task-detail.tsx:202`: base `grid-cols-[minmax(0,1fr)]`; `min-w-0` on every direct grid child and the aside's children (`:204-211`, `:213`); `flex-1` on the title `h2` (`:299`); rail `lg:grid-cols-[minmax(0,1fr)_min(17.5rem,40%)]` so 200% text doesn't starve the main column (a `minmax(14rem,17.5rem)` rail keeps its 14rem minimum at 200% text and squeezes the main column; `min(17.5rem,40%)` caps the rail at 40% of the row instead).
- `session/timeline.tsx:202`: the log gets `min-w-0`, and each row wrap `min-w-0` so no row widens the scroller.

### 7.3 Page header (break H3, M7)

`components/page-header.tsx` (Q22): the header is an `@container`, and things give way in this order: (1) a mono slug or name inside `meta` truncates first (with `title`) and hides below a 32rem header width (`@max-[32rem]:hidden`); it is `grow basis-0 max-w-max min-w-0`, so it takes only the room the title and badge leave (up to its own width) and is gone before the title loses a character; (2) a data-driven h1 (agent or task name) truncates down to a `min-w-16` (4rem) floor above a 22rem header and a `min-w-8` (2rem) floor below it (`@max-[22rem]:min-w-8`), because at 320px a long name, the Hibernated badge and three icon actions don't fit beside a 4rem floor and the actions would leave the screen (with `title`); a custom `heading` (the task and schedule headers' mono keys) is `min-w-0 truncate` (with `title`); (3) the status badge (`shrink-0 whitespace-nowrap`), a static h1 ("Templates") and the actions (`ml-auto shrink-0`) never shrink. The `meta` wrapper is `display: contents` (`contents`), so the badge and slug are the header's own flex items: a wrapper box cannot both hold an unshrinkable badge and let the slug shrink (as a `min-w-0` box it collapsed to 0px under a truncating title and the actions painted over the badge). Truncated text always carries its full value in `title`. A test renders the header with a 40-char template name and asserts the give-way classes and `title`s; the manual check covers the template header at 320, 390 and 768 with the sidebar open, Agents at 320, and a session with an 80-char name at 390 and 1024. `routes/_app/templates.index.tsx:29-41`: below `sm` "+ New template" shortens to "+ New" (a visible label, because Radix tooltips don't open on touch) and the "Images" in-page link is hidden (the section is on the same page, below); row metadata wraps (`flex-wrap min-w-0`).

### 7.4 Loading mark (motion H1, L4)

The bug: `.of-ignite` (`styles.css:258-261`) is unlayered and beats the base-layer reduced-motion override (`:464`); moving it into a layer is not enough (Tailwind 4 orders `theme, base, components, utilities`). Fix, with no override at all: `.of-ignite { clip-path: inset(0) }` is the still, lit default, and the animation exists only inside `@media (prefers-reduced-motion: no-preference) { .of-ignite { animation: of-ignite 1.2s var(--ease-out) infinite } }`; the base-layer `.of-ignite { animation: none }` is deleted. New keyframes: `0% { clip-path: inset(0 100% 0 0); opacity: 1 } 60% { clip-path: inset(0) } 85% { opacity: 1 } 100% { clip-path: inset(0); opacity: 0 }` (light, rest, dim, relight). Test: the stylesheet declares the `of-ignite` animation only inside the `no-preference` media block.

### 7.5 Interrupt glyph (emil M5)

`session/interrupt-button.tsx:2,59`: `Square` → `CircleStop`. Placement stays (U3 moves it).

### 7.6 Native titles (emil M1)

`templates/template-editor.tsx:534,543,549` and `tasks/link-editor.tsx:118`: `title=` → `Tooltip`. The disabled "Create agent" button already uses `aria-disabled`, so it still receives pointer events and the tooltip works. `<time title=…>` timestamps stay native (not controls).

### 7.7 Composer copy and errors (taste T-H4/T-L2, break M3, Q13)

- `session/composer.tsx:204-213`: the button reads "Send urgent" only when `urgent && agent.turnOpen`, else "Send"; the hint shows only when `urgent && agent.turnOpen` ("Interrupts the current turn, then runs next."). The checkbox stays.
- The label swap and the hint must not move the layout when `turnOpen` flips by itself: both labels are stacked in one grid cell (the inactive one `invisible`), and the hint line is reserved (empty, same height) while Urgent is checked.
- Before posting, the composer checks the same limit the server enforces, from one source: `MAX_BODY_BYTES` exported by `packages/shared/src/agents.ts` (used by `sendMessageBodySchema`), `new TextEncoder().encode(text.trim()).length > MAX_BODY_BYTES` → no request; inline error "This message is {n} KB; the limit is 64 KB. Shorten it to send." with `n = Math.ceil(bytes / 1024)`. The draft stays.
- `apps/server/src/errors.ts:39`, once at the error boundary so every validation error benefits (Q13): `message` is the first issue's `issue.message` (the schemas already write them as sentences, e.g. "Message is larger than 64 KB"), falling back to "Invalid request", never `err.message` (which carries the instance path, `body/body …`). `fields` unchanged. Server test covers a body-schema and a params-schema failure.

### 7.8 Send keys (decision 15, D1)

One helper, `lib/send-key.ts`: `isSendKey(e)` is true for Enter without Shift (or with ⌘/Ctrl), false while composing (`isComposing` or `keyCode 229`), false for plain Enter on a coarse pointer (⌘/Ctrl+Enter still sends there). Used by `session/composer.tsx:150-156` and `tasks/comment-composer.tsx:113`. On fine pointers only, the comment helper line ends with "Enter to post." (merged into the existing "Goes to @… and anyone you @mention." line, not a second line); on touch, where Enter adds a line, nothing is added.

## 8. Motion polish (U1 #15)

### 8.1 Keyboard rule (motion L3)

Today only ⌘B sets `data-instant` (on `<html>`, for one frame: `sidebar.tsx:104-107`), and it zeroes transitions only. Two changes:

- **Overlays stamp themselves.** `lib/input-modality.ts` records the last input modality with capture-phase `keydown` and `pointerdown` listeners on `document` (installed once in `main.tsx`). Every overlay's Content and Overlay (dropdown, popover, select, alert dialog, sheet, drawer) compose a module-level `stampInstant` ref callback from that file: Radix and Vaul mount the content node anew for each opening, so the callback runs once per opening and sets `data-instant` on the node when the last input was keyboard. It is not React state in a wrapper component, because those wrappers stay mounted while the overlay is closed and would fix the answer at page load. The stamp lasts for that whole opening. The base layer gets `[data-instant], [data-instant] * { animation: none !important; transition-duration: 0s !important }`: no flag is removed mid-animation, so nothing replays or freezes. Esc-close of a keyboard-opened overlay is instant too, since the stamp lasts until unmount.
- **The global flag stays for transitions.** `runInstant(fn)` is extracted from `sidebar.tsx:104` into `lib/run-instant.ts` (sets `data-instant` on `<html>` for one frame) and keeps serving ⌘B's sidebar collapse and the Enter-toggled chevrons (§8.4). It also zeroes `animation-duration` now (motion L3), which matters only for the ⌘B mobile drawer; that drawer also gets the per-overlay stamp, so the global flag never has to cover a running keyframe.
- Tests: open a menu with Enter and assert `data-instant` on its content; open it with a click and assert it is absent.

### 8.2 Pending screen (motion L5, emil H1)

`AppPending` inside the shell is `absolute inset-0` within the content inset (the `SidebarInset` becomes `relative`), not `fixed` over the sidebar; full-screen `fixed` stays for the first load (no shell). It enters with `animate-in fade-in-0 duration-150 ease-(--ease-out)`.

### 8.3 Status dots (motion L8)

`[data-status-dot] { transition: background-color 150ms var(--ease-out) }`. Dot ↔ tooth swaps stay instant.

### 8.4 Chevrons (motion L2)

Every disclosure chevron: `transition-transform duration-150 ease-(--ease-out)`: `session/tool-call-row.tsx:69`, `settings/usage-section.tsx:109`; the `<details>` rows (`session/quiet-line.tsx:31`, `session/compaction-marker.tsx:23`) get a chevron that rotates on `[open]`. Bodies never animate height.

### 8.5 Sidebar (motion M3 partial, emil L4)

Remove `transition-[width,height,padding]` from `sidebarMenuButtonVariants` (`sidebar.tsx:474`) and `transition-[margin,opacity]` from the group label (`:409`): they snap with the container. The container's own 200ms width/left animation stays until a recording decides (follow-up issue).

## 9. Timeline performance (motion H2, Q4)

Goal: work per WebSocket frame is proportional to what changed, not to the session's length.

1. **Events memo.** `use-session.ts:118`: `useMemo(() => eventsInOrder(state.events), [state.events])` (`eventsInOrder` takes the map). An `agent_status` or `queue` frame keeps `state.events`' identity, so `events`, `rows`, `failedIds` and `interruptedEnds` aren't rebuilt.
2. **Cheaper reducer.** `session-state.ts:47-51` copies the whole map per event and `:103-104` re-sorts all events per change. The `frames` fold (step 6) copies the map once per batch, and `eventsInOrder` becomes incremental: the hook keeps the previous ordered array and, when every new seq is above the previous maximum (the live case), appends instead of re-sorting; any other change (Load earlier, resync, a load) sorts once.
3. **Stable rows.** `rows.ts` gets `stabilizeRows(prev: Row[], next: Row[]): Row[]`: for each next row, the previous object with the same `key` is reused when every field is equal, comparing event objects by reference (they are immutable and keep identity in the map), arrays element by element (`update_group.envelopes` is rebuilt on every build, `rows.ts:157-158`), plain objects shallowly (the tool row's `truncated`, `rows.ts:231-235`), and `children` recursively: children are stabilized first (reused when every child is reused and the length matches), so even a row whose own fields changed (a result arriving) carries stabilized children. A seq repeated within one batch is inserted once. `use-session` keeps the previous rows in a ref. `failedIds` and `interruptedEnds` return the previous `Set` when their contents are equal.
4. **Memoized items.** `timeline.tsx` renders each row through `TimelineItem = memo(...)`, which owns the wrap `div`, `TimelineRow` and `CopyLink`. Props: `row`, `slug`, `spawned`, `lit` (boolean), `firstOfSeq` (boolean: whether the wrapper carries `id="event-<seq>"`, which today depends on the previous row, `timeline.tsx:224`), `tabKey`, `expanded`, `failedIds`, `interruptedEnds`, and stable callbacks (`toggle` and `onRowFocus(key)` are `useCallback`s; `rowProps` is replaced by `tabKey` plus `onRowFocus`). The comparator compares `row` by identity, the scalar props by value, and, for the row **and all its descendants**, `expanded.has(k)`, `tabKey === k`, `failedIds` membership of their message ids, and `interruptedEnds` membership of their seqs. So toggling one tool row, or moving focus, re-renders only the rows involved. `TimelineRow` itself is unchanged apart from receiving those props.
5. **Markdown.** `components/markdown/markdown.tsx`: `const REMARK_PLUGINS = [remarkGfm]` at module scope; `export const Markdown = memo(function Markdown(...))` (props: `source`, `variant`).
6. **One commit per frame.** `use-session.ts`: the WS listener ignores frames for other agents (they never touch this state), pushes this agent's frames into a ref queue and schedules one flush with `requestAnimationFrame` (a `setTimeout(…, 100)` while `document.hidden`, since rAF pauses in background tabs); the flush dispatches `{ type: "frames", messages }`, which the reducer folds with the existing `frame` logic. Before **any** local dispatch (`loaded`, `earlier`, `queued`, `agent`, `reset`) the queue is flushed synchronously first, so order is preserved. The scheduled callback is cancelled on unmount and on slug change.
7. **Tabindex pass.** `timeline.tsx:162-179`: the `MutationObserver` handles only `addedNodes` subtrees; the full pass runs on mount and when `tabKey` changes.

Tests (§13) count renders with a `vi.mock` of `Markdown` and of `TimelineRow` wrapped in counters, including positive cases (a tool result arriving re-renders exactly that tool row; a `delivery_failed` re-renders exactly the affected message row).

Virtualization is out (Q4): follow-up issue with its trigger, decided by the recording in §2.7.

## 10. Data layer (PR #76 follow-ups, decision 15)

### 10.1 Query client (R1, R5)

`lib/query-client.ts`:
```ts
export function shouldRetry(count: number, error: unknown): boolean
// count < 3 && !(error instanceof ZodError)
//   && !(error instanceof ApiError && error.status < 500 && error.status !== 408 && error.status !== 429)
export function createQueryClient(overrides?: DefaultOptions): QueryClient
// queries: { staleTime: 30_000, retry: shouldRetry, ...overrides?.queries }
```
`main.tsx` and `test/render-app.tsx` both call it; tests pass `{ queries: { retry: false } }` and nothing else, so integration tests now run with the production `staleTime: 30_000`. Tests that break because of it are fixed by asserting the real behaviour (e.g. invalidating explicitly), never by overriding `staleTime` back to 0. `ZodError` is zod v4's classic `ZodError` (what `schema.parse` throws in `apiFetch`). Unit tests for `shouldRetry` and the default `staleTime`.

### 10.2 Preload-aware loaders (R2)

`routes/_app/tasks.$key.tsx:15`, `schedules.$key.tsx:11`, `templates.$name.tsx:13`: `loader: ({ context, params, preload }) => preload ? qc.ensureQueryData(opts) : qc.fetchQuery({ ...opts, staleTime: 5_000 })`, with the existing `notFound` mapping in both branches: a click within 5s of the hover reuses the hover's fetch (pr76 R2 option 2), an older one refetches. Test (tasks and schedules): hover then click sends one detail request. Templates are exempt from that count: `TemplatePage`'s `useQuery(templateQueryOptions)` keeps `staleTime: 0` on purpose (the editor needs a current `baseHash`, `templates/api.ts:29`), so a navigation fetches in the loader and again on mount, as today; the preload branch still stops the hover from fetching twice.

### 10.3 Task save race (R3)

`tasks/task-detail.tsx:131-140`: `onSuccess: async (r) => { await qc.cancelQueries({ queryKey: detailKey }); qc.setQueryData(detailKey, r.task); … }`. Test with a deferred detail GET.

### 10.4 Stale lists and reconnect (R4)

- `staleTime: 0` on `["credentials"]` (`settings/api.ts:23`), `["secrets"]` (`:47`), `["projects"]` (`:60`) and `["templates"]` list (`templates/api.ts:19`), so focus and mount refetch.
- `routes/_app.tsx` `onOpen` on a reconnect: `qc.invalidateQueries()` with no key (only mounted queries refetch), replacing the two specific invalidations.

### 10.5 Nits

1. `schedules/schedule-form.tsx:117-127`: functional `setV`; the preview computed from the same merge helper.
2. `components/markdown/code-block.tsx:20-27`: keep the previous HTML only while the language is unchanged; on a language change render the new code as plain text until its highlight resolves; update `code-block.test.tsx`.
3. `components/markdown/highlight.ts:50`: `console` → `shellsession`; add aliases `ps1`/`powershell`, `hcl`/`terraform`, `proto`, `env` → `dotenv`, each verified to load under the JS regex engine.
4. `highlight.ts:97`: attach `.catch` once, inside the `??=` branch.
5. `hooks/use-mobile.ts:15`: cache the `MediaQueryList` per `window.matchMedia` function identity (re-created when a test installs a new fake `matchMedia`), so `test/use-mobile.test.ts` and the desktop/mobile overlay tests keep working; `getServerSnapshot` removed.
6. `tasks/task-detail.tsx:651-652`: Save in the link editor disabled until the agent lists are known; the lists prefetch when Edit is clicked.
7. `tasks/task-detail.tsx:222`: `CommentComposer` gets the route's `taskKey` (one source).
8. `agents/agent-form.tsx:176-184`: `slow` derived as `pending && pluginCount > 0 && timerFired`, no state reset in an effect.
9. `tasks/comment-composer.tsx:87`: clear the draft only if it still equals what was posted (same rule as the session composer).

## 11. Perceived speed (U1 #16, Q3)

- **Loaders don't block on cached summaries.** Today the session loader awaits `ensureQueryData(agentDetail)` (`agents.$slug.tsx:16`) and the task loader awaits `fetchQuery` (`tasks.$key.tsx:15`), so a page only renders once its detail is in, and after 400ms the user sees `AppPending` even when the list already knows the name and status. Change: when the list cache holds the summary (`AgentSummary` in `["agents", …]`, `TaskSummary` in the tasks list), the loader starts the fetch without awaiting it (`void qc.prefetchQuery(opts)`, the R2 branch otherwise unchanged); it awaits only when nothing is cached, which keeps the `notFound` mapping for unknown keys. The page maps a later `*_not_found` error to `ResourceNotFound` itself.
- **Session:** `useSession.load` fetches the agent detail and, on a plain visit (no `?event=` or `?message=` to resolve first), the latest events page in parallel (`Promise.all`) instead of one after the other; the header and strip render from `state.agent ?? summaryFromListCache(slug)` while it loads; the timeline area shows static skeleton rows.
- **Task detail:** `useQuery(taskDetailOptions)` gets `placeholderData` built from the `TaskSummary` (key, title, status, assignee); the body and activity areas render static skeleton plates until the real detail arrives (`isPlaceholderData`), and nothing editable is enabled from placeholder data.
- **Static skeletons** replace `return null` while loading at `routes/_app/agents.index.tsx:124` (`EmptyAgents`, a one-line plate at the line's height). `:151` (`RunningCount`) stays: it is a trailing inline count with no layout to hold.
- **AppPending inside the shell:** §8.2.
- **Optimistic single-field saves:** follow-up issue (Q3).

## 12. DESIGN.md amendments

Exact text for the dev to apply. Section names refer to DESIGN.md as of `322075d`.

### 12.1 Front matter

- Add colors: `float-edge: "oklch(0.80 0.006 255)"`, `night-float-edge: "oklch(0.38 0.008 255)"`, and `avatar-1` … `avatar-8` (light) / `night-avatar-1` … `night-avatar-8` (dark): `oklch(0.62 0.07 H)` / `oklch(0.70 0.07 H)` for H = 120, 180, 205, 230, 270, 295, 320, 345. Constraints (Q7): outside the warm band 0–100; ≥15° from success (150) and info (250); ≥20° from crimson (15–20, wrapping past 360) and warning (88–92). Allowed ranges are 112–135, 165–235 and 265–355; the eight picks are ≥25° apart. The dev checks all eight side by side at 24px in both themes (screenshot in the PR); if two can't be told apart, drop to seven.
- Typography: add `heading-detail: { fontFamily: "Archivo Variable, Geist Variable, sans-serif", fontSize: "20px", fontWeight: 650, lineHeight: "28px", letterSpacing: "-0.015em" }`.
- Components: `button-primary.height`, `button-ghost.height`, `input.height` → `"32px"`; add `button-outline: { backgroundColor: "{colors.plate}", textColor: "{colors.graphite-ink}", rounded: "{rounded.lg}", height: "32px" }`; add `sheet: { backgroundColor: "{colors.plate-raised}", width: "480px" }`.

### 12.2 Colors → Primary (replace the Signal bullet's list)

> It is used for focus rings, the active-nav tooth, the loading mark, text selection, the caret, link underlines on hover, and the `working` agent status. Checkboxes and radios are graphite: a checked box is a choice, not something live.

### 12.3 Colors → new subsection "Agent identity" (after Semantic)

> Generated agent avatars use eight muted identity hues (`--avatar-1` … `--avatar-8`, chroma 0.07: hues 120, 180, 205, 230, 270, 295, 320, 345). The warm band, hues 0–100, is excluded, because crimson, the signal and the rate-limited ochre live there, and every hue keeps at least 15° from success (150) and info (250), so an avatar never reads as an error, working, rate-limited, done or queued mark. They were checked side by side at 24px in both themes. Identity colour appears only inside an avatar and never means status; status rides on the avatar as the usual dot or tooth. A user-supplied `avatar.svg` keeps its own colours.

### 12.4 Typography → Hierarchy (table rows)

Add after "Page title": `| Detail title (task, in the page body) | Archivo | 20 / 28 | 650 |`. Replace the markdown row with: `| Markdown h1 / h2 / h3 | Archivo | 20 / 17 / 15 (in a detail body or comment: 17 / 15 / 14) | 650 |`. After the table: "Reading prose stays 14/22 for now; the reading size of the timeline, task bodies and comments is decided with U3's timeline tiers." Add under Named Rules: "**A document never outranks its title.** Inside a detail body or a comment, markdown headings drop one step." Replace "Tracking scales with size. Headings are tightened (−0.01em)." with "**Tracking scales with size.** −0.015em at 20px and above, −0.01em at 15–17px, 0 at 14px and below (Body, labels and a demoted h3)." (Q20)

### 12.5 Elevation & Depth (replace the paragraph)

> Flat. Depth comes from stacked plates, not shadows: the steel ground, then a plate on it, then a floating layer. A plate is lighter than the ground and edged with a 1px `rule`. Floating layers (popover, menu, select, sheet, dialog, drawer) are one step lighter again and edged with `float-edge`, a 1px border stronger than `rule` so a menu over a plate of the same lightness still has an edge in light mode. Sheets, dialogs and drawers add the scrim (20% black in light mode, 40% in dark). In dark mode, layers step lighter as they rise, and the rail steps darker. Nothing has a shadow.

### 12.6 Components (new bullets and replacements)

- **Buttons** (replace): "Primary is a graphite fill with steel text (inverted in dark mode); disabled (any variant), a button becomes a plate with a rule border and muted text, never a faded fill and never heavier than an enabled button. Secondary is `outline`: a plate with a rule edge, for every standalone secondary action. Ghost is for icon buttons, toolbar items and actions repeated on every item of a list (Reply on each comment). Danger uses crimson. Buttons name their action. Controls are 32px tall on fine pointers and 36px on touch."
- **Form controls** (new): "Select, radio, checkbox, segmented control and inputs share one height, one plate fill, the `field-edge` boundary and one focus ring (2px signal, offset 2px). Checked boxes and radios are graphite. A segmented control is a steel-deep track whose selected segment is a raised plate. Native selects are used only where search beats a list (the timezone picker)."
- **Rows** (new): "Linked rows take the `steel-hover` fill on hover (fine pointers only, 150ms colour) and a 6% deeper fill the instant they are pressed (on touch after 80ms, so a scroll doesn't flash them). Full-width rows never scale. Rows, sidebar items and timeline rows take the focus ring inset (offset −2px), so it never spills over a divider. Menu and select items show focus as the `steel-hover` fill instead of a ring."
- **Overlays** (new, replaces the Scrim bullet): the ladder table:

  | Need | Surface |
  |---|---|
  | A quick pick or a fact about one control | Popover, menu or select, anchored to its trigger |
  | A create or edit form, or a quick peek | Right sheet, 480px, with a scrim |
  | Primary work you'd deep-link or keep open | A page |
  | A destructive, irreversible confirmation | Dialog |
  | Any sheet or dialog below `md` (48rem; 768px at the default text size) | A bottom drawer (Vaul); the nav is a left drawer |

  Followed by: "Sheets stack at most one level (Add credential over New agent); the parent stays where it is under a second scrim. Dismissing a sheet never asks: a typed draft is kept, in memory for the tab, for the next open. A peek sheet does not dim or trap focus; the page behind stays usable; Esc and Close dismiss it. In a bottom drawer the buttons are full-width and stacked, the action first and Cancel last at the bottom, where the thumb rests. A confirmation button that carries a name may wrap to two lines; it is never truncated. The scrim is plain black, 20% in light mode and 40% in dark; there is no blur."
- **Toasts** (new): "A toast appears only when the control that caused an outcome is gone (a submitted sheet, a deleted row), and carries Undo when the action can be undone. Otherwise feedback stays inline, next to the control."
- **Composers** (new): "Enter sends in every composer; Shift+Enter adds a line, ⌘/Ctrl+Enter also sends. On touch, Enter adds a line."
- **Empty states and loading** (append): "Loading keeps the layout: static skeleton plates at the real row heights, never shimmering. A spinner always sits next to a pending label (\"Terminating…\"); under reduced motion the spinner stops and the label carries the meaning."

### 12.7 Motion (replace "Durations", amend others)

- **Durations:** "Press feedback 150ms. A disclosure chevron rotates over 150ms on `--ease-out`; the content it reveals never animates. Menus, popovers, selects and tooltips 100ms in, 75ms out. Dialogs 150ms in (from 96%), 100ms out (fade only). Sheets and drawers 250ms in on `--ease-drawer` and 200ms out on `--ease-out`, travelling 100% of their own size with no panel fade, the scrim on the same timing. The sidebar 200ms. Exits are faster than entries. Nothing else runs over 300ms."
- **Popovers** (replace): "Menus, popovers, selects and tooltips scale from their trigger (`--radix-*-transform-origin`) from 95% with a fade, with no directional slide. Tooltips wait 400ms the first time, then neighbours open instantly (skip delay 300ms) with no animation. Dialogs scale from 96% at the centre."
- **Keyboard rule** (append to Frequency): "An overlay opened from the keyboard is stamped `data-instant` for that whole opening, so it appears and leaves at once; the one-frame `data-instant` on the root still covers keyboard-triggered transitions (⌘B) and now zeroes animations too."
- **Reduced motion** (append): "Sheets and drawers fade instead of sliding."
- **Gesture UI** (append): "Drawers use Vaul (pinned exactly): 1:1 drag, flick to dismiss (Vaul measures velocity over the whole drag: above 0.4 px/ms, or past 25% of the drawer, it closes; drags are ignored for 500ms after open). After a flick the drawer leaves on the drawer curve over 300ms. Its release snap-back is a CSS transition hard-coded at 0.5s on `--ease-drawer`, not a spring: the accepted exception to the spring rule and a known gap against the 300ms ceiling. Opening and closing sheets, drawers and dialogs are keyframes and can't be reversed mid-flight; only a drag can. A 250ms window is rarely interrupted, and owning presence and focus logic to change that isn't worth it."
- **Curves** (append): "Linear only for constant rotation (the spinner)."
- **Frequency** (append, Q15): "Live lists never reorder under the pointer: a re-sort waits until the pointer and focus leave the list, and never animates."
- **Performance** (new bullet): "Motion is only as smooth as the main thread: the timeline commits at most once per frame, and unchanged rows don't re-render."
- **Deliberately not used** (append): "Animated status: dots change colour over 150ms; the working tooth never pulses."

### 12.8 Lines that would otherwise contradict the amendments

- Overview, point 1: "so the warm orange is the only temperature on screen" → "so the warm orange is the only warm interface colour (identity hues appear only inside avatars)".
- Shapes → The pitch, point 3: "Each pass takes 1.2s: it lights over the first ~0.8s on `--ease-out`, then rests lit." → "Each 1.2s pass lights the roofline over the first ~0.7s on `--ease-out`, rests lit, then dims before it relights."
- Layout: "On mobile the sidebar becomes a sheet." → "On mobile the sidebar becomes a left drawer, opened from its button."
- Components → Browser surfaces: "the caret and checkbox accent are signal" → "the caret is signal; checkboxes are graphite".
- Motion → Curves: "`--ease-drawer` … the mobile sheet sliding in" → "sheets and drawers sliding in".
- Motion → Deliberately not used: "Springs and the Motion library, until something can be dragged." → "Springs and the Motion library. Drawers can be dragged now, through Vaul's CSS transitions (see Gesture UI); Motion waits for drag-to-reorder."

### 12.9 Do's and Don'ts

- Don't: replace "toasts or modals for routine tasks" with "toasts for outcomes whose control is still on screen, or centered modals for anything but a destructive confirmation".
- Don't: add "Don't give a floating layer a shadow; use the plate step and `float-edge`."

## 13. Testing

TDD per change; Vitest + Testing Library (jsdom) for web, the existing server test setup for `errors.ts`.

- **Primitives:** render tests for `Sheet`, `Drawer`, `ConfirmDialog` (desktop and mobile via a mocked `matchMedia`); the primitive locked at open across a breakpoint flip (§5.1); focus inside the drawer after open (§5.4); the keyboard stamp (§8.1); the Vaul upgrade guard (§5.4); reduced-motion classes and `--initial-transform` on the Radix sheet and the Vaul drawer (fade kept, slide dropped): slots, roles (`dialog`, `alertdialog`), close paths (Esc, scrim, Close), pending holds the confirmation open, button order on mobile, `data-slot` attributes the CSS keys on. `Select`, `RadioGroup`, `SegmentedControl`: keyboard selection and `onChange`; the sentinel mapping.
- **Class contracts:** a source-scan test asserts: no `shadow-` in the floating-layer primitives (`popover`, `dropdown-menu`, `select`, `sheet`, `drawer`, `alert-dialog`, `tooltip`, `tabs`); no `slide-in-from-` in menus, popovers, selects or tooltips; no `ring-3`, `ring-ring/50`, `outline-none` or `outline-hidden` anywhere in `apps/web/src` outside the menu/select item allowlist (§6.1); `styles.css` has the `of-ignite` animation only inside `@media (prefers-reduced-motion: no-preference)` and the `[data-instant]` rule. Tests guard against regressions, not values: no test copies DESIGN.md prose or a token value (`--float-edge`, the avatar hues and the like are retuned from screenshots, so pinning them would triple every retune).
- **Bugs:** Home (agents, attention-first ordering, frozen order under the pointer, "All N agents" when capped, empty, loading, error); page header classes; composer 64 KB and copy; `isSendKey` table test; comment composer Enter; server validation message.
- **Timeline:** render counts (§9), `stabilizeRows` unit tests (reuse on unchanged, replace on changed result, children), reducer `frames` fold, rAF batching with Vitest fake timers (`toFake: ["requestAnimationFrame"]`), tabindex on added nodes.
- **Data layer:** §2.8.
- **Manual, recorded in the PR:** before/after task detail (Q5); a menu over a plate in light and dark (Q8, to tune `--float-edge`, and the dark scrim); the avatar hues side by side at 24px in both themes next to the 6px status dots (Q7; hue 120 against the warning ochre in particular); the Vaul drawer and its scrim at 10% animation speed (they must run together), and ⌘B on mobile at 10% (no replayed slide); a drag-dismiss and a button close of the confirm drawer on a real phone (Q23: 300ms vs 200ms, tuned by feel); the break-ui stress data (`seed-worst.mjs` in `/Users/orlevi/.claude/jobs/7530b76c/tmp/break-ui/`, against a clone DB, never the shared one): 40-char slugs, a 64-char secret, 30 crons, 214 agents in the manager Select and assignee menu, duplicate display names, Agents at 320, the browser font at 24px with a 1024px window; Performance recordings with 4× CPU throttling, including the sidebar collapse and the pending loading mark; the overflow matrix (§2.2), header at 390/1024 and Templates at 320, reduced-motion checks, overlay motion in Chrome at normal and 10% animation speed, Vaul drag on a phone-sized touch emulation, the before/after Performance recording (§2.7), light and dark screenshots of the new controls.

## 14. Follow-up issues

1. (#78) Timeline virtualization (break L7). Trigger: in the §2.7 recording on a 2,000-event session after H2 lands, any frame commit over 16ms on an `agent_status` or `session_event` frame, or visible scroll jank (frames over 16ms while scrolling). Below that, close the issue.
2. (#80) Sidebar collapse: transform-based container if a recording on a 500-row session drops below 60fps (motion M3).
3. (#81) Reconnect strip height animation (motion M4 second half; owned by no spec).
4. (#79) Optimistic single-field saves: task status and assignee, inbox mark-read, schedule pause/resume, pin (emil H1 last bullet). Deferred because they touch every mutation and interact with R3's cancel-before-write (§10.3); one focused change (decision 14 allows deferral with a reason).
5. (#82) Prose reading size 15/24 (taste T-M2), decided in U3 with the timeline tiers; the demoted heading sizes (17/15/14) are re-derived with it.
6. (#83) Searchable pickers: replace the native timezone select (Q12) and the agent pickers (manager, assignee, agent filter: 200+ agents is a long Radix Select) with the cmdk combobox once U2 adds cmdk.

## 15. Delivery

Five stacked PRs (owner review of the plan), each based on the one below, each leaving main working, each with its own CI run and its own slice of the §2/§13 manual evidence:

1. `fix(web): data layer and PR #76 follow-ups` (§10, base main).
2. `feat: DESIGN.md amendments, tokens and UI primitives` (§5, §6 primitives, §8.1, §12; Q7 and Q8 screenshots).
3. `feat: control system consumers and UI bug fixes` (no scope: it also changes `apps/server/src/errors.ts`) (§6 call sites, §7, §8.2–§8.5; Q5 before/after, the overflow matrix, header checks).
4. `refactor(web): timeline render performance` (§9; before/after recordings posted on #78).
5. `fix(web): render pages from cached summaries while details load` (§11).

The whole-stack React review and spec-coverage walk run on the top of the stack.

## 16. Risks

- **Vaul's injected CSS is unlayered.** Overrides must stay unlayered and more specific; a Tailwind utility on the drawer won't move its timing. The class-contract test guards the block.
- **Radix Select in tests.** It uses pointer capture and `scrollIntoView`; jsdom needs the usual shims (`hasPointerCapture`, `scrollIntoView`) in `test-setup.ts`.
- **Memo comparators can hide updates.** A comparator that forgets a prop shows stale rows. Every `TimelineItem` prop is either compared or stable by construction, and the render-count tests include a positive case (a tool result arriving re-renders that tool row).
- **Low-certainty values (Q5, Q8).** The detail title size and `--float-edge` are visual judgements at certainty 3; screenshots go in the PR so Or can retune them.
- **Ghost → outline audit** touches many files; it is mechanical but visible. Screenshots in light and dark go in the PR.
