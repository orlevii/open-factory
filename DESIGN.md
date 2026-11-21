---
name: Open Factory
description: Sawtooth. The factory floor, cool steel and graphite with one safety-orange signal, built around the open-roof logo.
colors:
  brand-orange: "#FF5A1F"
  brand-ink: "#16140F"
  brand-paper: "#F4F1EA"
  steel: "oklch(0.965 0.003 250)"
  plate: "oklch(0.985 0.002 250)"
  plate-raised: "oklch(0.995 0.001 250)"
  steel-deep: "oklch(0.94 0.004 250)"
  steel-hover: "oklch(0.93 0.005 250)"
  steel-selected: "oklch(0.9 0.006 250)"
  rule: "oklch(0.89 0.005 250)"
  float-edge: "oklch(0.80 0.006 255)"
  field-edge: "oklch(0.62 0.01 255)"
  graphite-ink: "oklch(0.2 0.008 255)"
  ink-muted: "oklch(0.5 0.01 255)"
  signal: "oklch(0.6 0.2 37)"
  signal-text: "oklch(0.52 0.17 38)"
  crimson: "oklch(0.52 0.2 20)"
  success: "oklch(0.54 0.13 150)"
  warning: "oklch(0.6 0.125 88)"
  info: "oklch(0.54 0.13 250)"
  night-ground: "oklch(0.205 0.006 255)"
  night-rail: "oklch(0.17 0.006 255)"
  night-plate: "oklch(0.228 0.007 255)"
  night-rule: "oklch(0.305 0.008 255)"
  night-selected: "oklch(0.31 0.008 255)"
  night-float-edge: "oklch(0.38 0.008 255)"
  night-text: "oklch(0.94 0.004 250)"
  night-muted: "oklch(0.72 0.008 250)"
  night-signal: "oklch(0.682 0.211 37.7)"
  night-crimson: "oklch(0.7 0.16 15)"
  night-warning: "oklch(0.82 0.15 92)"
  avatar-1: "oklch(0.62 0.07 120)"
  avatar-2: "oklch(0.62 0.07 180)"
  avatar-3: "oklch(0.62 0.07 205)"
  avatar-4: "oklch(0.62 0.07 230)"
  avatar-5: "oklch(0.62 0.07 270)"
  avatar-6: "oklch(0.62 0.07 295)"
  avatar-7: "oklch(0.62 0.07 320)"
  avatar-8: "oklch(0.62 0.07 345)"
  night-avatar-1: "oklch(0.70 0.07 120)"
  night-avatar-2: "oklch(0.70 0.07 180)"
  night-avatar-3: "oklch(0.70 0.07 205)"
  night-avatar-4: "oklch(0.70 0.07 230)"
  night-avatar-5: "oklch(0.70 0.07 270)"
  night-avatar-6: "oklch(0.70 0.07 295)"
  night-avatar-7: "oklch(0.70 0.07 320)"
  night-avatar-8: "oklch(0.70 0.07 345)"
  avatar-ink: "{colors.graphite-ink}"
typography:
  heading-page:
    fontFamily: "Archivo Variable, Geist Variable, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "20px"
    letterSpacing: "-0.01em"
  heading-detail:
    fontFamily: "Archivo Variable, Geist Variable, sans-serif"
    fontSize: "20px"
    fontWeight: 650
    lineHeight: "28px"
    letterSpacing: "-0.015em"
  heading-auth:
    fontFamily: "Archivo Variable, Geist Variable, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: "28px"
    letterSpacing: "-0.015em"
  prose-h1:
    fontFamily: "Archivo Variable, Geist Variable, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 650
    letterSpacing: "-0.015em"
  prose-h2:
    fontFamily: "Archivo Variable, Geist Variable, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 650
    letterSpacing: "-0.01em"
  prose-h3:
    fontFamily: "Archivo Variable, Geist Variable, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 650
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
  label:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "18px"
  code:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "1.55"
rounded:
  sm: "3.6px"
  md: "4.8px"
  lg: "6px"
  xl: "8.4px"
spacing:
  unit: "4px"
  gutter-mobile: "16px"
  gutter-desktop: "24px"
  header: "48px"
  control: "32px"
  control-touch: "36px"
components:
  button-primary:
    backgroundColor: "{colors.graphite-ink}"
    textColor: "{colors.steel}"
    rounded: "{rounded.lg}"
    height: "32px"
  button-ghost:
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.lg}"
    height: "32px"
  input:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.lg}"
    height: "32px"
  button-outline:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.lg}"
    height: "32px"
  card:
    backgroundColor: "{colors.plate}"
    rounded: "{rounded.lg}"
  sheet:
    backgroundColor: "{colors.plate-raised}"
    width: "480px"
  panel:
    backgroundColor: "{colors.plate}"
    width: "320px"
  sidebar:
    backgroundColor: "{colors.steel-deep}"
    width: "240px"
  nav-item-active:
    backgroundColor: "{colors.steel-hover}"
    textColor: "{colors.graphite-ink}"
    height: "32px"
  nav-tooth:
    backgroundColor: "{colors.signal}"
    size: "6px 12px"
---

# Design System: Open Factory

## Overview

**Sawtooth.** The logo is a factory roofline drawn as one continuous line with an open floor, with teeth rising left to right at an exact 30°. The product looks like the floor inside that building: cool steel and graphite, matte and quiet, with one safety-orange light that means something is running. Safety orange is what a real factory paints on whatever is live or moving, which is exactly what the orange means here.

The people using it keep the tab open next to their editor for hours, often at night, watching agent sessions and working through an inbox. So the interface stays out of the way (this is an Operate surface). The brand shows in four precise things, and nowhere else:

1. **Steel and graphite.** The light theme sits on cool steel, the dark theme on graphite. The neutrals are deliberately cool and almost colourless, so the warm orange is the only warm interface colour (identity hues appear only inside avatars). (Earlier versions used the logo's warm Paper as the ground; together with an orange accent it read too close to Claude's cream-and-terracotta palette, and this product runs on Claude Code.)
2. **One signal.** Signal Orange marks what is live, focused or selected. It is never decoration.
3. **The pitch.** The logo's 30° angle appears in exactly three places (see Shapes).
4. **Archivo headings.** The wordmark's typeface sets page and auth titles. Everything else is Geist.

Both themes are equal citizens. The theme follows the OS by default, and the user menu offers System, Light and Dark; the choice is remembered per browser (see Components → Theme). Tokens live in `apps/web/src/styles.css`. The logo masters the app uses (light and dark horizontal lockups, the small cut) and the usage rules live in `brand/`; `brand/USAGE.md` is binding.

## Colors

The strategy is **restrained**: cool neutrals do almost all the work, plus one accent. Every neutral sits at hue 250–255 with chroma under 0.01: steel, not blue. The contrast in temperature between the cool floor and the warm signal is the identity.

### Primary

- **Signal Orange** (`brand-orange` `#FF5A1F`): the logo's colour. It is used **only inside the logo**, never for UI.
- **Signal** (`signal`, light `oklch(0.6 0.2 37)` ≈ `#DD4202`; dark = exactly `#FF5A1F`): the UI's version of the orange. It is used for focus rings, the active-nav tooth, the loading mark, text selection, the caret, link underlines on hover, and the `working` agent status. Checkboxes and radios are graphite: a checked box is a choice, not something live. Light mode deepens it because `#FF5A1F` on the steel ground is only 2.8:1, below the 3:1 minimum for non-text UI. The deepened signal reaches at least 3.2:1 on every light surface, including the active nav row. In dark mode it is ≥5.1:1 on every surface.
- **Signal text** (`signal-text`): use it when orange must be read as text. It is ≥5:1 in both themes.

### Neutral

- **Light:** the `steel` ground (`#F2F4F5`). A `plate` is one step lighter, for cards, inputs and code blocks, and popovers are lighter still. The `steel-deep` sidebar sits one step darker than the ground. `rule` is for dividers and card edges, and `field-edge` is for input boundaries (≥3.2:1, WCAG 1.4.11). Text is `graphite-ink` (`#14161A`, 16.4:1), and secondary text is `ink-muted` (≥5:1 on every light surface).
- **Dark:** the `night-ground` is graphite (`#15171A`). The rail is darker still (`night-rail`), as a recessed edge, and plates step lighter as they rise. Text is `night-text` (15:1), and `night-muted` reaches ≥6.2:1.
- **Primary buttons are graphite in light mode and light steel in dark mode, never orange.**
- **The logo keeps its own colours.** The lockups use the logo's warm Ink and Paper for the lettering, which reads correctly on steel and graphite. Never recolour them to match the UI.

### Semantic

`success`, `warning`, `info` and `crimson` (destructive / errored) are indicator colours for dots and icons, always paired with a label. They are spaced around the signal so no status can be mistaken for "working": crimson is pushed to hue 20 (light) and 15 (dark), and warning (rate-limited) is ochre at hue 88–92, 50° clear of the orange. All seven agent statuses were checked side by side at 6px dot size in both themes. Colour alone does not separate every pair: in the light theme `working` and `rate_limited` are indistinguishable for deuteranopes (ΔE 1.0), and `queued` and `idle` for tritanopes. The tooth shape and the label carry the difference, which is why status is never colour alone. Agent status tokens (`--status-*`) and chart tokens (`--chart-*`) are defined alongside them for status indicators and data charts.

Task status: Done uses `success`, the Blocked marker uses `warning`; both always with a label.

Chart series start at `--chart-2`; `--signal` marks only the focused datum. A partial datum (today's bar) is `--chart-5` with a 1px `--chart-2` outline: `--chart-5` alone is about 2:1 on both grounds, below the 3:1 a graphical object needs.

### Agent identity

Generated agent avatars use eight muted identity hues (`--avatar-1` … `--avatar-8`, chroma 0.07: hues 120, 180, 205, 230, 270, 295, 320, 345). The warm band, hues 0–100, is excluded, because crimson, the signal and the rate-limited ochre live there, and every hue keeps at least 15° from success (150) and info (250), so an avatar never reads as an error, working, rate-limited, done or queued mark. They were checked side by side at 24px in both themes. Identity colour appears only inside an avatar and never means status; status rides on the avatar as a corner badge (Components → Avatars). A user-supplied `avatar.svg` keeps its own colours.

The generated avatar is a "factory bot" drawn from the agent's slug: a head (rounded square, circle, capsule or a flat-topped hexagon, never a 30° roof), eyes, mouth and an accessory, drawn in graphite ink on one identity fill in both themes (≥3:1 on every fill at 16px). The face never changes with theme or status and never animates.

### Named Rules

- **The Pilot Light Rule.** Orange means "live, on, focused". If an element is not one of those, it is not orange. That rules out orange buttons, headings, backgrounds and illustrations.
- **The Logo Colour Rule.** `#FF5A1F` is used exactly only in the logo. UI orange is always `--signal`, because the logo is exempt from contrast rules and UI is not.
- **Status Is Never Colour Alone.** Every status pairs its colour with a label or icon.

### Increased contrast

Under `prefers-contrast: more`, the surfaces and the Pilot Light Rule stay the same, and five things change:
- Rules and field edges harden (≥3.2:1).
- Secondary text moves toward ink (≥8:1 in light mode, ≥10:1 in dark mode).
- Sidebar text becomes full graphite, or full light steel in dark mode.
- Light mode deepens the signal one step.
- The focus ring thickens to 3px.

## Typography

- **Archivo** (variable, self-hosted via `@fontsource-variable/archivo`) is the `font-heading` face. It is the typeface the wordmark is cut from. Use it for page titles (16px/600), auth titles (22px/700), error and not-found headings, card and sheet titles, and markdown headings. Tracking scales with size (see Named Rules).
- **Geist** covers all UI and body text. Base UI text is 14px, labels and secondary text are 13px, and long-form prose is 14/22.
- **Geist Mono** is only for things that are literally identifiers or code: code, handles (`@alice`), slugs, keys. It is never a "technical" costume for labels.

### Hierarchy

| Role | Face | Size / line | Weight |
|---|---|---|---|
| Auth title | Archivo | 22 / 28 | 700 |
| Page title (h1 in the 48px header) | Archivo | 16 / 20 | 600 |
| Detail title (task, in the page body) | Archivo | 20 / 28 | 650 |
| State heading (error, not found) | Archivo | 16 / 20 | 600 |
| Markdown h1 / h2 / h3 | Archivo | 20 / 17 / 15 (in a detail body or comment: 17 / 15 / 14) | 650 |
| Body / UI | Geist | 14 / 22 | 400 |
| Label, secondary, panel heading | Geist | 13 / 18 | 400–500 |
| Code | Geist Mono | 13 / 1.55 | 400 |

Reading prose stays 14/22 for now; the reading size of the timeline, task bodies and comments is decided with U3's timeline tiers.

### Named Rules

- **Never retype the wordmark.** "OpenFactory" in Archivo is a drawing, not text. Render it with the `Wordmark` component, which is built from the outlined master.
- **Type is set in rem, never px.** Sizes and line heights follow the reader's browser font-size setting, not just page zoom. The pixel values in the table are at the 16px default: 13px is `0.8125rem`, 14px is `0.875rem`, 18px is `1.125rem`, 22px is `1.375rem`.
- **Tracking scales with size.** −0.015em at 20px and above, −0.01em at 15–17px, 0 at 14px and below (Body, labels and a demoted h3).
- **A document never outranks its title.** Inside a detail body or a comment, markdown headings drop one step.
- **Sentence case everywhere.** The voice is a calm senior engineer (PRODUCT.md).

## Layout

- A 4px grid. Controls are 32px tall on desktop and 36px on touch, and the page header is 48px.
- The shell is a 240px sidebar, collapsible to icons, plus the content area. On mobile the sidebar becomes a left drawer, opened from its button.
- Content gutters are 16px on mobile and 24px from `md` up.
- **Agent details.** The session's details are a 320px column on the right, a plate with a 1px rule on its left edge and no shadow, opening with a 48px strip whose rule continues the page header's. From 1280px (80rem) it is open by default and remembered per browser; from 1024px it is the same column, closed on each visit; from 768px a peek sheet under the page header (the header stays usable); below, a bottom drawer. One header button and `]` toggle it everywhere, instantly at 1024px and up. When a column's width changes, the timeline keeps its place: pinned to the bottom if it was, else the top visible row stays put.
- **Two panes.** From 1024px the Inbox is a 380px list beside a reading pane; below, rows navigate.
- **Sub-navigation.** A section with several pages (Settings) has a 180px sub-nav left of its content; its current page takes the selected fill and medium weight (no tooth: the tooth stays on the sidebar row). When the content beside it would be narrower than 40rem, the sub-nav becomes a select above the content.
- Dense by design. Trees, timelines and tables put a lot on one screen, so rhythm comes from rules and spacing, not boxes.

## Elevation & Depth

Flat. Depth comes from stacked plates, not shadows: the steel ground, then a plate on it, then a floating layer. A plate is lighter than the ground and edged with a 1px `rule`. Floating layers (popover, menu, select, sheet, dialog, drawer) are one step lighter again and edged with `float-edge`, a 1px border stronger than `rule` so a menu over a plate of the same lightness still has an edge in light mode. Modal sheets, dialogs, drawers and the command palette add the scrim; peek sheets do not (20% black in light mode, 40% in dark). In dark mode, layers step lighter as they rise, and the rail steps darker. Nothing has a shadow.

## Shapes

Corners are tight, following the logo's mitred geometry: `--radius` is 6px (0.375rem), with `sm` 3.6px, `md` 4.8px and `xl` 8.4px derived from it.

### The pitch (30°)

The roof angle is the one shape that belongs to Open Factory. It is used in **exactly three places**, and adding a fourth is a design decision that needs recording here:

1. **The logo.** This covers the mark, the wordmark (the cut *t*) and the favicon set.
2. **The active-nav tooth** (`.of-tooth`). One roof bay, 6×12px in `--signal`, with a vertical wall on the right and a 30° roof rising to it (rise 3.46px = 6 × tan 30°). It replaces the generic active bar. The `working` agent status uses the same tooth, so "this is live" always has the same silhouette.
3. **The loading mark** (`LoadingMark`). The roofline lights up in orange from left to right over a faint track, in the direction the teeth rise. Each 1.2s pass lights the roofline over the first ~0.7s on `--ease-out`, rests lit, then dims before it relights. Under reduced motion it shows lit and still.

## Components

- **Logo** (`apps/web/src/components/wordmark.tsx`):
  - `Wordmark` is the horizontal lockup. It swaps between the light master and the reversed (~2% thinner) dark master by theme, never by recolouring one file. It is 20px tall in the sidebar (≈110px wide, above the 96px minimum) and 24px on auth pages.
  - `Mark` is the symbol on its own, always the **small cut** (16px grid), because every in-app use is under 32px.
  - `LoadingMark` is the pending screen.
  - Clear space is 2× the roofline stroke on every side.
- **Buttons:** primary is a graphite fill with steel text (inverted in dark mode); a disabled button keeps its variant's shape with muted text and no opacity fade: primary becomes a plate with a rule border, outline keeps its plate and rule edge, and ghost stays borderless with no plate, so a disabled control never looks like a different enabled one and never heavier than an enabled button. Standalone secondary buttons are ghost for actions inside a section (rail and section-header actions, repeated per item: Add a description, Edit dependencies, Edit links stay ghost); outline, a plate with a rule edge, only for page- or header-level standalone actions (Edit beside a title, Verify). Ghost is also for icon buttons, toolbar items and actions repeated on every item of a list (Reply on each comment). Danger uses crimson. Buttons name their action. Controls are 32px tall on fine pointers and 36px on touch.
- **Form controls:** Select, radio, checkbox, segmented control and inputs share one height, one plate fill, the `field-edge` boundary and one focus ring (2px signal, offset 2px). Checked boxes and radios are graphite. A segmented control is a steel-deep track whose selected segment is a raised plate. Where search beats a list (agents, time zones), the picker is a Combobox; there are no native selects.
- **Rows:** Linked rows take the `steel-hover` fill on hover (fine pointers only, 150ms colour) and a 6% deeper fill the instant they are pressed (on touch after 80ms, so a scroll doesn't flash them). Full-width rows never scale. Rows, sidebar items and timeline rows take the focus ring inset (offset −2px), so it never spills over a divider. Menu and select items show focus as the `steel-hover` fill instead of a ring.
- **Inputs:** a plate fill with a `field-edge` boundary, a signal focus ring (2px, offset 2px) and a signal caret. Errors appear inline below the field in crimson with an icon.
- **Validation:** the two short auth forms validate on submit and then move focus to the first invalid field. Editing a field clears its error. Longer forms (templates, schedules) validate each field when you leave it, never while you type, and still check everything on submit.
- **Destructive actions: forgiveness over confirmation.**
  - Prefer undo. When an action can be reversed, do it immediately and offer an inline undo.
  - Ask for confirmation only when the action is both destructive and irreversible, such as terminating an agent and discarding its session, or deleting a template.
  - The confirmation names exactly what will be lost, and its button names the action ("Terminate @reviewer", never "OK").
  - A confirmation shown for routine actions trains people to click through, so it never appears for those.
- **Overlays:**

  | Need | Surface |
  |---|---|
  | A quick pick or a fact about one control | Popover, menu or select, anchored to its trigger |
  | Jump to anything | Command palette (top centre, with a scrim) |
  | A create or edit form | Right sheet, 480px, with a scrim |
  | A quick peek (a task, Agent details below 1024px) | Right peek sheet, no scrim, 480px (Agent details 320px) |
  | Primary work you'd deep-link or keep open | A page |
  | A destructive, irreversible confirmation | Dialog |
  | Any sheet or dialog below `md` (48rem; 768px at the default text size) | A bottom drawer (Vaul); the nav is a left drawer; the command palette stays a top dialog |

  Sheets stack at most one level (Add credential over New agent); the parent stays where it is under a second scrim. Dismissing a sheet never asks: a typed draft is kept, in memory for the tab, for the next open. A peek sheet does not dim or trap focus; the page behind stays usable and clicking it does not close the peek; Esc and Close dismiss it. Opened from a list with the keyboard, focus stays in the list so `j`/`k` retarget it in place. A task peek opens only when the list keeps room beside it; otherwise the page opens. In a bottom drawer the buttons are full-width and stacked, the action first and Cancel last at the bottom, where the thumb rests. A confirmation button that carries a name may wrap to two lines; it is never truncated. The scrim is plain black, 20% in light mode and 40% in dark; there is no blur, because there is no translucency anywhere in the system, so `prefers-reduced-transparency` has nothing to undo.
- **Toasts:** A toast appears only when the control that caused an outcome is gone (a submitted sheet, a deleted row), and carries Undo when the action can be undone. Otherwise feedback stays inline, next to the control.
- **Composers:** Enter sends in every composer; Shift+Enter adds a line, ⌘/Ctrl+Enter also sends. On touch, Enter adds a line.
- **Cards and panels:** a plate on the ground, a 1px rule edge and a 6px radius, with a 40px header strip that has its own rule. Cards are never nested. The Agent details column's strip is 48px, continuing the page header's line.
- **Navigation:** sidebar rows are 32px (36px on touch). The active row gets the `steel-hover` fill plus the tooth, and the icon rail keeps the tooth. Nav labels are capitalised product nouns. The last nav row, **Agents**, heads the live agents as the reporting tree; its chevron collapses the tree and its `+` creates an agent. Agent rows are data rows that keep the agent's display name: chevron, avatar with its status badge, name, then a collapsed manager's working count (the tooth and a number, read as "N working") and the agent's unread messages. On an agent row the left tooth means only "you are here". Order is the tree's, never by activity. Roots start expanded and the rest collapsed; the user's toggles are remembered per browser; the open agent's managers expand for the visit only. While a live agent's session is open its row is the active row; an ended agent's session keeps the Agents row active. The collapsed rail shows only what needs a glance: the open agent, agents with unread messages, and agents working, queued, rate-limited or errored.
- **Avatars:** 16px in pickers, the palette and inbox rows; 20px in the sidebar, lists and Agent details; 24px in the session header. Always decorative (`aria-hidden`); a name is beside it, or in the rail its tooltip. In lists a status badge is cut into the bottom-right corner, one shape per status, the same shapes `StatusBadge` uses: the tooth when working, an alert glyph when errored, a filled dot when rate-limited, a hollow ring when queued, nothing at rest. The session header's avatar carries no badge; the status badge beside it does.
- **Selected rows:** a row shown in a pane or peek, or the current page of a sub-nav, takes `steel-selected`, one step deeper than hover, and keeps it under the pointer.
- **Command palette:** ⌘K / Ctrl+K from anywhere. A floating layer at the top centre, 640px wide, with the popover look and the scrim; modal. It never animates, however it was opened. Groups: Agents, an exact task key, Go to, Actions, then Tasks: a group whose results arrive late sits last, so nothing above the highlight moves when it lands.
- **Combobox:** a searchable pick (agents, time zones) looks exactly like a Select and opens a popover with a filter field at a fixed height. Arrow keys move the highlight; only Enter or a click commits.
- **Keyboard shortcuts:** single keys never fire while typing in a field, inside a menu, list box or tree, or while a modal layer is open, and can be switched off in the shortcuts sheet. `g` then a letter goes to a section; `c` new task; `]` Agent details; `j`/`k` move through lists; `?` lists them all in a sheet.
- **Key hints:** one `Kbd` style: Geist 12px, muted, on a plate with a rule; ⌘ on macOS, Ctrl elsewhere.
- **Empty states and loading:** one plain line in muted text, with no illustration. Loading keeps the layout: static skeleton plates at the real row heights, never shimmering. A spinner always sits next to a pending label ("Terminating…"); under reduced motion the spinner stops and the label carries the meaning.
- **Markdown** (`.prose-of`): headings in Archivo, code on a plate with a rule, link underlines that turn signal on hover, and mermaid diagrams always on a light plate.
- **Browser surfaces:** selection is a 26% signal tint, the caret is signal; checkboxes are graphite, scrollbars are thin and graphite-tinted, and focus-visible is a 2px signal ring.
- **Theme:** System / Light / Dark, as a radio group in the sidebar's user menu, under a small "Theme" label. System is the default and keeps following the OS live; Light and Dark override it and are stored per browser (`localStorage` key `of-theme`), synced across open tabs. Everything keys off `<html data-theme="light|dark">`: the tokens, the `dark:` variant, the Shiki colours and the browser `theme-color`. An inline script in `index.html` sets it before first paint, so there is never a flash of the wrong theme.
- **Favicon:** `favicon.svg` and `favicon.ico` in `apps/web/public/`, both from the small cut. There are no PNG, touch or manifest icons, because the app is used in a desktop browser tab, not installed. The full icon set is in the logo project if installing ever matters. `theme-color` is steel (`#F2F4F5`) in light mode and graphite (`#15171A`) in dark mode.

### Motion

**Motion is feedback, not decoration.** The rules come from a review against Emil Kowalski's design-engineering principles (`emilkowalski/skills`, emil-design-eng), adopted where they fit a dense, live-updating Operate tool.

- **Frequency decides.** Anything seen tens of times a day (nav changes, hovers, list updates) is instant or a colour-only change of 150ms at most. Keyboard-initiated actions never animate: ⌘B collapses the sidebar instantly, using `data-instant` on `<html>` for one frame, while a click animates. An overlay opened from the keyboard is stamped `data-instant` for that whole opening, so it appears and leaves at once; the one-frame `data-instant` on the root still covers keyboard-triggered transitions (⌘B) and now zeroes animations too. Live lists never reorder under the pointer: a re-sort waits until the pointer and focus leave the list, and never animates. Columns that change the page's layout (Agent details from 1024px, the settings sub-nav, the inbox pane) appear instantly; only the sidebar's collapse animates. A peek retargeted to another item swaps its content in place, instantly; it never closes and reopens. A key that closes an overlay (Esc, `]`, `?`, Space on a peek) closes it at once, however it was opened. A disclosure chevron rotates only when its own chevron was clicked. A selection moved from the keyboard (`j`/`k`, arrows) takes its fill at once; only pointer hover fades.
- **Curves** (tokens in `styles.css`; the built-in CSS easings are too weak):
  - `--ease-out` `cubic-bezier(0.23, 1, 0.32, 1)`: anything entering, plus press feedback.
  - `--ease-in-out` `cubic-bezier(0.77, 0, 0.175, 1)`: movement on screen (the sidebar collapsing).
  - `--ease-drawer` `cubic-bezier(0.32, 0.72, 0, 1)`: sheets and drawers sliding in.
  - Never `ease-in` or `linear` for UI. Linear only for constant rotation (the spinner).
- **Durations:** Press feedback 150ms. A disclosure chevron rotates over 150ms on `--ease-out`; the content it reveals never animates. Menus, popovers, selects and tooltips 100ms in, 75ms out. Dialogs 150ms in (from 96%), 100ms out (fade only). The command palette never animates. Sheets and drawers 250ms in on `--ease-drawer` and 200ms out on `--ease-out`, travelling 100% of their own size with no panel fade, the scrim on the same timing. The sidebar 200ms. Exits are faster than entries. Nothing else runs over 300ms.
- **Press:** pressable buttons scale to 0.98 on `:active` (not 0.97, because the full-width auth buttons are large). Transitions always name their properties; never `transition-all`.
- **Popovers:** Menus, popovers, selects and tooltips scale from their trigger (`--radix-*-transform-origin`) from 95% with a fade, with no directional slide. Tooltips wait 400ms the first time, then neighbours open instantly (skip delay 300ms) with no animation. Dialogs scale from 96% at the centre. The command palette never animates.
- **Reduced motion means fewer, gentler animations, not none.**
  - Fades stay.
  - Scale, slide and rotate are removed from enter and exit animations.
  - The sidebar's width and position changes, and the button press scale, are switched off.
  - The loading mark rests lit.
  - Sheets and drawers fade instead of sliding.
- **Deliberately not used:**
  - Staggered list entrances, because live lists would ripple on every websocket update.
  - Springs and the Motion library. Drawers can be dragged now, through Vaul's CSS transitions (see Gesture UI); Motion waits for drag-to-reorder.
  - Blur crossfades and hold-to-delete, until a specific component needs them.
  - Animated status: dots change colour over 150ms; the working tooth never pulses.
- **Performance:** Motion is only as smooth as the main thread: the timeline commits at most once per frame, and unchanged rows don't re-render.
- The loading mark is the only authored animation.
- **Gesture UI** (anything dragged, reordered or swiped) follows these rules from Apple's *Designing Fluid Interfaces*, via `emilkowalski/skills` apple-design:
  - Tracking is 1:1 with the pointer, using pointer capture, and respects where the item was grabbed.
  - Feedback starts on pointer-down.
  - Motion uses critically damped springs (bounce 0) by default. Bounce is added only after a flick that carried momentum.
  - The release velocity is handed to the spring, and the landing point is projected from the momentum.
  - Edges rubber-band instead of stopping hard.
  - Animations start from the value currently on screen, so they can be interrupted and reversed.
  - Drawers use Vaul (pinned exactly): 1:1 drag, flick to dismiss (Vaul measures velocity over the whole drag: above 0.4 px/ms, or past 25% of the drawer, it closes; drags are ignored for 500ms after open). After a flick the drawer leaves on the drawer curve over 300ms. Its release snap-back is a CSS transition hard-coded at 0.5s on `--ease-drawer`, not a spring: the accepted exception to the spring rule and a known gap against the 300ms ceiling. Opening and closing sheets, drawers and dialogs are keyframes and can't be reversed mid-flight; only a drag can. A 250ms window is rarely interrupted, and owning presence and focus logic to change that isn't worth it.

## Do's and Don'ts

**Do**
- Keep orange for what is live, focused or selected.
- Use `--signal` / `--signal-text` for UI orange, and `--brand-orange` only in the logo.
- Use Archivo for titles and Geist for everything else.
- Let stacked plates and 1px rules carry structure.
- Pair every status colour with a label.
- Follow `brand/USAGE.md` for any logo placement outside the app (docs, README, social).

**Don't**
- Don't make primary buttons, headings, fills or illustrations orange.
- Don't add the 30° pitch as decoration: no sawtooth dividers, angled card corners or pitched headers.
- Don't animate anything triggered from the keyboard, use `transition-all`, or use `ease-in` / `linear` for UI motion.
- Don't set type in px, and don't confirm an action that can be undone.
- Don't use translucent materials or backdrop blur. Depth is the plate stack.
- Don't retype, recolour, flip or close the logo, or add a floor line to it.
- Don't add decorative shadows, gradients, glass, eyebrow labels, colored side-borders on cards, toasts for outcomes whose control is still on screen, or centered modals for anything but a destructive confirmation or the command palette.
- Don't give a floating layer a shadow; use the plate step and `float-edge`.
- Don't use mono as a costume for non-code labels.
- Don't warm the neutrals (no cream, beige or paper grounds), and don't let them drift into visible blue. Every neutral stays at hue 250–255, chroma under 0.01.
