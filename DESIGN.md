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
  steel-selected: "oklch(0.885 0.007 250)"
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
  night-selected: "oklch(0.33 0.009 255)"
  night-float-edge: "oklch(0.38 0.008 255)"
  night-text: "oklch(0.94 0.004 250)"
  night-muted: "oklch(0.72 0.008 250)"
  night-signal: "oklch(0.682 0.211 37.7)"
  night-crimson: "oklch(0.7 0.16 15)"
  night-warning: "oklch(0.82 0.15 92)"
  avatar-1: "oklch(0.56 0.07 115)"
  avatar-2: "oklch(0.68 0.07 130)"
  avatar-3: "oklch(0.56 0.07 175)"
  avatar-4: "oklch(0.68 0.07 190)"
  avatar-5: "oklch(0.56 0.07 205)"
  avatar-6: "oklch(0.68 0.07 220)"
  avatar-7: "oklch(0.56 0.07 270)"
  avatar-8: "oklch(0.68 0.07 285)"
  avatar-9: "oklch(0.56 0.07 300)"
  avatar-10: "oklch(0.68 0.07 315)"
  avatar-11: "oklch(0.56 0.07 330)"
  avatar-12: "oklch(0.68 0.07 345)"
  night-avatar-1: "oklch(0.64 0.07 115)"
  night-avatar-2: "oklch(0.76 0.07 130)"
  night-avatar-3: "oklch(0.64 0.07 175)"
  night-avatar-4: "oklch(0.76 0.07 190)"
  night-avatar-5: "oklch(0.64 0.07 205)"
  night-avatar-6: "oklch(0.76 0.07 220)"
  night-avatar-7: "oklch(0.64 0.07 270)"
  night-avatar-8: "oklch(0.76 0.07 285)"
  night-avatar-9: "oklch(0.64 0.07 300)"
  night-avatar-10: "oklch(0.76 0.07 315)"
  night-avatar-11: "oklch(0.64 0.07 330)"
  night-avatar-12: "oklch(0.76 0.07 345)"
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
  hit-touch: "40px"
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

Diff lines use `--diff-add` and `--diff-remove`, low tints of success and crimson on the plate, per theme and opaque so a sticky gutter can repeat them. The + and − sign is always shown, so colour never carries the change alone, and the code keeps ink colour and is not syntax-coloured.

Task status: Done uses `success`, the Blocked marker uses `warning`; both always with a label.

Chart series start at `--chart-2`; `--signal` marks only the focused datum. A partial datum (today's bar) is `--chart-5` with a 1px `--chart-2` outline: `--chart-5` alone is about 2:1 on both grounds, below the 3:1 a graphical object needs.

### Agent identity

Generated agent avatars use twelve muted identity colours (`--avatar-1` … `--avatar-12`, chroma 0.07, hues 115, 130, 175, 190, 205, 220, 270, 285, 300, 315, 330, 345) in two lightness tiers that alternate by index (light L 0.56/0.68, dark 0.64/0.76), so no two are closer than ΔE_ok 0.03; ink is at least 3:1 on every fill. The warm band, hues 0–100, is excluded, because crimson, the signal and the rate-limited ochre live there, and every hue keeps at least 15° from success (150) and info (250), so an avatar never reads as an error, working, rate-limited, done or queued mark. Identity colour appears only inside an avatar and never means status; status rides on the avatar as a corner badge (Components → Avatars). A human may pick an agent's colour (Edit agent → Colour); Auto is the slug's seeded colour; spawned agents are always Auto; a template `avatar.svg` wins and keeps its own colours, and Colour isn't offered.

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
- **Geist** covers all UI and body text. Base UI text is 14px, labels and secondary text are 13px, and reading prose (speech, task bodies, comments) is 15/24.
- **Geist Mono** is only for things that are literally identifiers or code: code, handles (`@alice`), slugs, keys. It is never a "technical" costume for labels.

### Hierarchy

| Role | Face | Size / line | Weight |
|---|---|---|---|
| Auth title | Archivo | 22 / 28 | 700 |
| Page title (h1 in the 48px header) | Archivo | 16 / 20 | 600 |
| Detail title (task, in the page body) | Archivo | 20 / 28 | 650 |
| State heading (error, not found) | Archivo | 16 / 20 | 600 |
| Markdown h1 / h2 / h3 | Archivo | 20 / 17 / 15 (demoted, in a detail body, comment or session timeline: 17 / 16 / 15) | 650 |
| Reading prose | Geist | 15 / 24 | 400 |
| Body / UI | Geist | 14 / 22 | 400 |
| Label, secondary, panel heading | Geist | 13 / 18 | 400–500 |
| Tool output as markdown | Geist | 13 / 20 (headings 14 / 13 / 13) | 400 |
| Code | Geist Mono | 13 / 1.55 | 400 |

Reading prose is 15/24: speech in the session timeline, task bodies and comments. Base UI text stays 14/22, and tool output stays at 13/20, so the work tier reads quieter than speech.

### Named Rules

- **Never retype the wordmark.** "OpenFactory" in Archivo is a drawing, not text. Render it with the `Wordmark` component, which is built from the outlined master.
- **Type is set in rem, never px.** Sizes and line heights follow the reader's browser font-size setting, not just page zoom. The pixel values in the table are at the 16px default: 13px is `0.8125rem`, 14px is `0.875rem`, 18px is `1.125rem`, 22px is `1.375rem`.
- **Tracking scales with size.** −0.015em at 20px and above and −0.01em at 15–17px apply to Archivo headings; Geist body and UI text stays at 0 at every size, reading prose included.
- **A document never outranks its title.** Inside a detail body, a comment or the session timeline, markdown headings drop to the demoted scale. Nothing in a session outranks the page title.
- **Sentence case everywhere.** The voice is a calm senior engineer (PRODUCT.md).

## Layout

- A 4px grid. Controls are 32px tall on fine pointers; on touch, fields are 36px and default and large buttons 40px. The page header is 48px. On coarse pointers every standalone control but the timeline's gutter ⋯ (see One row menu) has a hit area of at least 40px (`hit-touch`): a smaller control keeps its drawn size and gets an invisible expander out to 40px, except in a form or beside text, where the control itself grows to 40px. Dense rows keep their height, so neighbouring expanders never overlap; toolbar and header icon groups space their icons 4px apart as visible 40px boxes, and a lone small ⋯ 4px from a neighbour is a visible 32px box, so its expander stops at the gap.
- The shell is a 240px sidebar, collapsible to icons, plus the content area. On mobile the sidebar becomes a left drawer, opened from its button.
- Content gutters are 16px on mobile and 24px from `md` up.
- Form fields stack in `field-stack`, 12px apart, so a field's note sits twice as far from the next label as a label from its control; each field's reserved note line provides the rest of the rhythm. A form's outcome line follows the last field's note at 4px. The 18px note line is the one exception to the 4px grid. If adjacent fields read as one group, raise the gap between fields, never the note line.
- **Agent details.** The session's details are a 320px column on the right, a plate with a 1px rule on its left edge and no shadow, opening with a 48px strip whose rule continues the page header's. From 1280px (80rem) it is open by default and remembered per browser; from 1024px it is the same column, closed on each visit; from 768px a peek sheet under the page header (the header stays usable); below, a bottom drawer. One header button and `]` toggle it everywhere, instantly at 1024px and up. When a column's width changes, the timeline keeps its place: pinned to the bottom if it was, else the top visible row stays put.
- **Agent views.** An agent opens as its Chat; its Session is one ghost button away in the header. Switching between them is instant; the header stays put.
- **Two panes.** From 1024px the Inbox is a 380px list beside a reading pane; below, rows navigate. An unread chat is one Inbox row; selecting it shows the Chat in the reading pane under a compact strip, never Agent details. A chat opened in the pane is read after the dwell.
- **Sub-navigation.** A section with several pages (Settings) has a 180px sub-nav left of its content; its current page takes the selected fill and medium weight (no tooth: the tooth stays on the sidebar row). When the content beside it would be narrower than 40rem, the sub-nav becomes a select above the content.
- **Timeline data rows are at least 32px** (`min-h-8`, never a fixed height); their text wraps rather than clipping at large text sizes.
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
- **Buttons:** primary is a graphite fill with steel text (inverted in dark mode); a disabled button keeps its variant's shape with muted text and no opacity fade: primary becomes a plate with a rule border, outline keeps its plate and rule edge, and ghost stays borderless with no plate, so a disabled control never looks like a different enabled one and never heavier than an enabled button. Standalone secondary buttons are ghost for actions inside a section (rail and section-header actions, repeated per item: Add a description, Edit dependencies, Edit links stay ghost); outline, a plate with a rule edge, only for page- or header-level standalone actions (Edit beside a title, Verify). Ghost is also for icon buttons, toolbar items and actions repeated on every item of a list (Reply on each comment). Danger uses crimson. Buttons name their action. A header view switch (Chat ↔ Session) is navigation: a ghost button with icon and label, icon-only when narrow, moving into ⋯ when the header is crowded. Buttons are 32px tall on fine pointers, with a hit area of at least 40px on touch: the small sizes (icon, extra-small, small) get an invisible expander (`hit-40`) and keep their drawn size, the default and large sizes grow to 40px tall, and a button in a form (`inForm`) grows to 40px with padding instead of taking an expander, so it never overlaps a field or text.
- **Form controls:** Select, radio, checkbox, segmented control and inputs share one height, one plate fill, the `field-edge` boundary and one focus ring (2px signal, offset 2px). Checked boxes and radios are graphite. A segmented control is a steel-deep track whose selected segment is a raised plate. Where search beats a list (agents, time zones), the picker is a Combobox; there are no native selects.
- **Session timeline:** the timeline of a session has three tiers. Spacing, not boxes, groups them.
  - **Speech** is incoming messages, outgoing `send_message` calls and the agent's text, with a speaker line and prose at 15/24. A message that crossed a session boundary is a card (a plate with a 1px rule and the 6px radius); the agent's own text is never boxed. A factory notice (system, task assigned, task update) is no card: a quiet line with the factory mark, its body below as two muted lines with "Show all".
  - **Work** is tool rows, spawn and terminate blocks, at 13px, with tool names in mono only where they are identifiers.
  - **System** is lifecycle lines, the turn footer and the compaction marker, at 13px muted.
  - **Spacing:** 24px before a speaker line or a card and after a turn footer, 8px between the other rows of a turn. Repeated identical failures merge into one row ("3 times · last 19:32"). A long message, outgoing or spawn body is clamped at 40 lines or 4,000 characters, cut between blocks and closed with "Show all", which expands in place; agent text is never clamped.
  - **Speaker line:** avatar (20px), name in Geist 13px medium, a muted mono handle, truncated in the middle, that hides in a narrow row (the name's tooltip then carries it) and a muted time that is never truncated; name and handle truncate before the time ever wraps. Your own messages say "You"; humans have a 20px initials avatar on neutral steel (never an agent hue; first and last word, by grapheme, skipping Jr and III; a person glyph when the name has no letters), an outgoing card reads "Name → Recipient", and to several people "Name → @a, @b +8": the first two handles, then a count, the full list in the line's accessible name and the row menu's Recipients item. Under such a card, one muted line for each recipient that wasn't plainly delivered ("Not sent to @x: terminated"). Senders are read by kind (agent, human, factory) from the message, never from the `@`, and there is no "All humans": every recipient is a handle.
  - **Deep-link arrival:** the linked row scrolls to the centre and takes focus, with the inset focus ring. A 6% signal tint on the row's own box (never its gutter) holds for 2s of visible time, then fades over 300ms; the fade stays under reduced motion. The general rule is under Rows.
  - **Tool calls** are one 32px-minimum line: chevron, the tool's summary, a state chip and, on hover or focus, the call's time at the line's end, so it never covers the chip. The chip is one word ("Running", "Failed", "Denied"); anything longer, such as a failure's first error line or a background task's summary, goes on the line below, two lines at most. Output from a tool is untrusted text and renders as text, or as markdown that loads nothing and draws no diagrams. A tail of it clamps to its last 12 lines or 2,000 characters, whichever is shorter, and "Show all" expands in place. Diffs collapse to the first 3 hunks or 80 lines.
  - **Folded runs:** two or more consecutive tool calls fold into one row, a chevron and a summary that wraps ("Read 6 files, ran 4 commands · 1m 40s", "4 calls so far" while running). A failed or denied call and a subagent end a run and stay rows of their own. A run keeps its row when it grows from one call to two. Each call in an open run keeps its own ⋯ and its time in its own line, shown on hover or focus of that call only.
  - **Streamed text:** the agent's text appears as it is written, in the same element that becomes the saved message, so the handoff keeps its highlighting, selection and height. There is no caret. Half-typed markdown never shows raw syntax: a trailing `**`, a lone list or heading marker, a half link or a table still missing its delimiter row waits for the rest, and an open code fence reads as plain code until it closes. While you select text inside a streaming block it holds still, and catches up when the selection ends. Text cut at 64 KB says so on a line below it: "Cut at 64 KB; the full text stayed with the agent."
  - **Subagent cards:** an Agent or Task call is a header row, "Subagent · type · description" and a state chip (Running with the tooth, Done, Failed, In background, Stopped, Denied), with its body indented behind a 1px neutral rule: no fill, no box, no avatar. While it runs the body is one live line, counters first and tabular, then what it is doing: "4 tool calls · 123k tokens · Reading `purchase.md`". Counters update at most twice a second and the line never shows a timer. Once done the body shows the result's first 3 lines and, after it, the call, time and token figures; expanded it holds the prompt, the transcript and the result last. When several run at once the first three stay cards and the rest fold into one "+N more subagents · M running" row below them, which expands in place and never folds a card already on screen.
  - **One row menu:** every row has a single ⋯ at its right, shown on hover and focus within on fine pointers and always on touch: in the rows' right gutter, or for a card, which spans the column, inside the card's own padding. It lists only what applies: Copy link, Copy text, Copy command, View tool call, View in the recipient agent's session, Open in inbox, and on touch the time. A copy turns the icon into a check for 1.5s. On touch the gutter ⋯ is a visible 32px-wide box with no expander, the one standalone control under 40px: it is at most 40px tall, capped at its row's height plus 4px, so on a one-line row it is 32×28 and never reaches the next row's ⋯. The menu is the only row action, so rows carry no footer links. The Chat's working and outcome lines carry one inline "Open session" link: they are status lines, not rows. Below `md` every row and header menu opens as a bottom drawer with a title naming the row and 44px items; from `md` up it is the dropdown (a long-press hangs it from the pressed point). The surface is chosen when the menu opens.
- **Chat:** the Chat is the speech tier of the session timeline and nothing else. Every message is unboxed for everyone (you, agents, humans): a left-aligned speaker line with a 20px avatar, the body under it in prose, no tool rows. Consecutive messages from the same sender to the same recipients within 5 minutes, with nothing between them, share one speaker line (4px between bodies, the time of each shown on hover or focus in the leading edge); an urgent message, a different sender, a longer gap, an outcome or a divider starts a new one. "Also to" follows the speaker. A held or slow-sending message shows its status ("Waiting for Ada's current step" with Cancel, "Sending…") in the speaker line's time slot, swapped with the time by opacity (150ms in, 100ms out) so the line never changes size; the status is the message's accessible description and is announced in the Chat's polite region. A rejected message gets one error-toned line, icon and text, "Not delivered: <reason>", and no Retry. The ⋯ sits in the row's gutter and the row takes the `steel-hover` fill on fine pointers. While a turn that read your message runs, the thread's last row is a working line in the activity line's anatomy ("[tooth] 42s · Ada is working · Open session"); when the turn ends without a reply it becomes a muted outcome line in the same line box and position. Recipients are chips in a "To:" row that appears only once you add a second one.
- **Rows:** Linked rows take the `steel-hover` fill on hover (fine pointers only, 150ms colour) and a 6% deeper fill the instant they are pressed (on touch after 80ms, so a scroll doesn't flash them). Full-width rows never scale. Rows, sidebar items and timeline rows take the focus ring inset (offset −2px), so it never spills over a divider. Menu and select items show focus as the `steel-hover` fill instead of a ring. A row reached by a deep link (a timeline row, or a settings row via `?<kind>=<name>`) scrolls to the centre, takes focus with the inset ring and holds the 6% signal tint for 2 s of visible time, fading over 300 ms. The selected fill stays for a row shown in a pane or peek.
- **Inputs:** a plate fill with a `field-edge` boundary, a signal focus ring (2px, offset 2px) and a signal caret. Every field reserves one note line under its control, for its help text or nothing. An error takes that line, with the alert icon, in crimson, and the control's edge turns crimson; never colour alone. Nothing below moves. The note wraps, breaking anywhere when it must; it never truncates.
  - A field that takes a path on the factory's machine has a ghost **How do I find this path?** button, with a help icon, at the right of its label row. It opens a popover (at every width, also inside a drawer) with the steps to copy a folder's path on the factory machine's OS, the machine's name, and what `~` means there. Paths may start with `~/`; the factory stores the absolute path.
  - A one-time code is a plain text field (`autocomplete="one-time-code"`, no autocapitalise, autocorrect or spellcheck). Masked fields with the reveal eye are for long-lived secrets: tokens, keys and secret values.
- **Forms:** create forms show the fields that define the thing, name first, and fold the rest under More options, which opens itself, saying why, when something inside needs attention. An identifier derived from a name (an agent's address, a template's folder) is shown as a line with Change, never asked first; Edit has no template or address input, because neither can change. A short prerequisite (a credential, a project, a secret) is created inline, as under Overlays; a large one (a template) in a stacked sheet. When a form needs one prerequisite step first (Start sign-in), its primary button is that step until it completes; the footer never shows a disabled primary beside the step's own button.
- **Configuration lists:** two groups, each labelled once with a count: From template (full-contrast, read-only, collapses past 8 with Show all) and This agent (removable, never collapsed, with the add row). Rows min 32px / 40px on touch, never fixed height; values wrap, never truncate; rules mono, prose Geist.
- **Provenance:** Anything fetched from outside the factory shows where it came from and what it is pinned to: the source, a short commit in mono that is a copy button for the full commit (also in its tooltip and accessible name, and shown in full, selectable, in a peek), or 'Live' for host and folder sources. Updates are never automatic: an update view expands in place under the section it changes, lists what changes as + and − lines, and ends in its action. It is never a dialog.
- **Untrusted text:** Third-party code and file text (commands, hooks, files, SKILL.md) is shown in full as mono text that is pre-wrap, wraps anywhere, isolates bidi and shows invisible, bidi and control characters as visible tokens, under 'Runs code' first. Third-party prose (descriptions, commit subjects) is Geist with the same bidi isolation and tokens. Neither is ever markdown or links. File text opens at its first line with the message clamp (40 lines, Show all).
- **Page forms:** a page with one save has a footer at the bottom of its column: the outcome line above Discard (ghost) and Save changes (primary), side by side at every width, and at 200% text, where they no longer fit, Save wraps under Discard, right-aligned; sticky only while dirty or an outcome shows; plate background and top rule, no blur. Discard is instant with an inline Undo. Leaving dirty asks first. One draft per file: a form and a raw tab never hold drafts of the same file at once.
- **Schedules:** Repeats offers presets in a select; a cron is the Custom case, with a summary that names its time zone.
- **Validation:** Every form validates a field when you leave it, if you changed it, and everything on submit, never while you type. Leaving the window or pressing Close doesn't count as leaving the field. While a field shows an error, each keystroke re-checks it: the fix clears it at once and the message always matches what is typed. Submit moves focus to the first invalid field and scrolls the whole field, its message included, into view. A form's own outcome (Couldn't save, Saved) sits on one reserved line directly above its buttons, outside any scrolling region; it takes its height from the space above the buttons. Error copy follows three rules: at most 40 characters, so it fits one line in the narrowest form column on a phone; one message per rule, naming the rule that failed, so it never needs the help text it replaces; never a value the user typed, which is already in the control. The help text keeps the summary.
- **Template editor:** template files are edited in CodeMirror with line numbers, syntax colours from the same tokens as code blocks (never orange), and validator markers on their lines. A Configuration tab (Geist) comes before the file tabs (mono); below 40rem the tabs are a Select with dirty and error marks.
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
  | A quick peek (a task, a build log, Agent details below 1024px) | Right peek sheet, no scrim, 480px (Agent details 320px) |
  | Primary work you'd deep-link or keep open | A page |
  | A destructive, irreversible confirmation | Dialog |
| A form opened from a page for one item (an MCP server) | Dialog |
  | Any sheet or dialog below `md` (48rem; 768px at the default text size) | A bottom drawer (Vaul); the nav is a left drawer; the command palette stays a top dialog |

  A dialog for a form anchors at a fixed top (about 12svh, origin top centre) so it never jumps as fields come and go, enters from 96% over 150ms (the scale only when motion is allowed), leaves with a 100ms fade, scrolls its body under a fixed footer (ghost Cancel, then the primary), and on close returns focus to the row it was about, which takes the arrival tint. Create flows stay sheets. A short prerequisite created from inside a sheet or dialog (a credential, a project, a secret) expands inline; New template, a large form, is the one stacked sheet that remains.

  Every create and edit form is a sheet opened over the page you are on, from every entry point; a form never has its own page. Exception: a Configuration (agent, template) is a page. It is long, has several sections and a raw editor, and is deep-linked. Create and identity edits stay sheets. Sheets are not addressed by URL; old form URLs open the sheet over their list. A sheet belongs to the page it opened over and closes, instantly, when you leave that page, keeping its draft. Its dismiss button says Close, and a sheet that reopens with a kept draft says so, with Discard. A short prerequisite missing from a form (a credential, a project, a secret) is created inline: a disclosure under its field expands the form behind a 1px left rule, with no box and no nested form. Enter submits only it; Esc collapses only it, the sheet stays, and focus returns to the disclosure; its buttons are secondary, so the sheet's one primary stays the one. On success the new item is selected and the field takes focus. Pressing the sheet's primary over an open expansion that holds input focuses the expansion and says to add it or cancel it first. A large prerequisite (a template) is created in a sheet stacked over it and selected on return. A stacked sheet is 48px narrower than its parent (on phones, shorter), and names it.

  Sheets stack at most one level (New template over New agent); the parent stays where it is under a second scrim. Dismissing a sheet never asks: a typed draft is kept, in memory for the tab, for the next open. A peek sheet does not dim or trap focus; the page behind stays usable and clicking it does not close the peek; Esc and Close dismiss it. Opened from a list with the keyboard, focus stays in the list so `j`/`k` retarget it in place. A task peek opens only when the list keeps room beside it; otherwise the page opens. In a bottom drawer the buttons are full-width and stacked, the action first and Cancel last at the bottom, where the thumb rests. A confirmation button that carries a name may wrap to two lines; it is never truncated. The scrim is plain black, 20% in light mode and 40% in dark; there is no blur, because there is no translucency anywhere in the system, so `prefers-reduced-transparency` has nothing to undo.
- **Peeks:** A list whose items have no page of their own opens them in a peek: its rows are buttons with aria-expanded, the shown row takes steel-selected, F6 moves focus into the peek and back, and the list keeps the peek's width clear (≥54rem of container) so the shown row stays visible. A peek may step into a related item in place with Back; Back is instant and returns focus to the row it came from; Esc closes the peek.
- **Toasts:** A toast appears only when the control that caused an outcome is gone (a submitted sheet, a deleted row), and carries Undo when the action can be undone. Otherwise feedback stays inline, next to the control. Toasts sit bottom-left of the content area, clear of the sidebar, and bottom-centre on phones; always above a mounted composer, and under any open sheet's scrim. A toast is a plate with `float-edge`, no shadow, listed (not stacked); at most three; at least 5 seconds, longer for long text, paused while hovered, focused or hidden. Undo never outlasts what the server can restore.
- **Long operations:** A pending label shows elapsed time after 10 s. An operation that can outlast its sheet continues on the server after Close, shows a pending row in its list. Success is the row arriving (the arrival tint, no toast); only a failure reports as a toast.
- **Version pins:** Third-party code that can change under you says so. A pinned entry shows 'Pinned' and its short commit (the copy button). An entry that follows upstream shows a 'Latest · auto-updates' badge (warning icon plus the words, never colour alone) wherever it appears. Pinning is the default; choosing Latest is its own explicit action, reviewed in place, with the risk stated next to its button.
- **Composers:** Enter sends in every composer; Shift+Enter adds a line, ⌘/Ctrl+Enter also sends. On touch, Enter adds a line. A composer is one plate with the textarea and the toolbar inside its frame; the box grows to 12 lines or 40svh, whichever is less (6 lines or 35svh below `md`), then scrolls. Send is a labelled primary, disabled-shaped while there is nothing to send. While a turn is open in a session composer, Stop sits left of Send: an outline button, the one toolbar control that acts on the running turn. It reads "Stopping…" with a spinner until the turn changes, and "Compacting…" (doing nothing) while a compaction runs, because a compaction is never interrupted. Esc in the composer closes an open completion menu first, then stops the turn; an open peek or popover that took that Esc first only closes itself. ⌥/Alt+Enter sends and interrupts the turn (fine pointers only; on touch the hint points at Stop). Keys typed during IME composition never send, stop or complete. The composer's height never changes when a turn opens or closes: the note slot sits inside the toolbar, on the left, and keeps its height whether or not it has text, and Stop's slot keeps its width whether or not a turn is open. The session's composer is raw: its text goes to Claude as typed, its toolbar has `/` only (no `@`, no attach), and the `/` menu is autocomplete that inserts `/name `; a denied command shows disabled in it, and its reason takes the note slot and holds Send. Below `md` the toolbar is icons: `/`, `@` and attach where a composer has them, in the same order as on desktop, and Stop and Send as 40px icons at its right end, with no Write/Preview toggle (a Preview left open returns to Write). The turn hint stays the box's accessible description, and while a turn is open the queued-message hint becomes the placeholder. Stop's slot stays reserved at 40px whether or not a turn is open. The Chat's composer sends messages (⌥Enter interrupts), its toolbar has `@` and attach and no `/`, and Stop sits left of Send while the turn that read your message runs. `@` adds the agent as a recipient (a "To:" row of chips above the text, shown only once you add one; Backspace in an empty box selects the last chip, then removes it) and takes the typed token out; with more than one recipient the paperclip is `aria-disabled` and says "Files go to one agent at a time" in the note slot. A leading `/` stays text, with the note "Commands run in the session · Open session" for a known command.
  - **One note slot:** a composer shows one note at a time, never stacked, by priority: error, then refusal (a denied command, a refused file or recipient), then conflict, then hint; the composer picks it while it renders. On fine pointers it is the toolbar's hint slot, one fixed line that truncates; below `md` it is one line reserved under the frame in composers that can show notes (the session's and the task comment's; any other gets the line only while it has a note), empty when there is no note. The slot carries its text in a `title`, and a refusal is the last thing the toolbar cuts. A note never changes the composer's height, and it is announced through a live region that is mounted with the box. A Send that is held (for uploads, or by a refusal) stays focusable and `aria-disabled`, links its reason with `aria-describedby`, and pressing it shows the reason in the slot.
- **Attachments:** a file in a composer is a chip. A transfer longer than a moment shows determinate progress: a 2px bar along the chip's bottom edge and a tabular percentage, updated without transition. A drop target shows its edge in ink while a file is over it, with no animation. In a message, an image file previews automatically only up to 1 MB; a larger one shows its name until "Show preview" is pressed.
- **Cards and panels:** a plate on the ground, a 1px rule edge and a 6px radius, with a 40px header strip that has its own rule. Cards are never nested. The Agent details column's strip is 48px, continuing the page header's line.
- **Navigation:** sidebar rows are 32px (36px on touch). The active row gets the `steel-hover` fill plus the tooth, and the icon rail keeps the tooth. Nav labels are capitalised product nouns. Nav order: Inbox, Tasks, Templates, Skills, Schedules, Usage, Settings, then Agents. The last nav row, **Agents**, heads the live agents as the reporting tree; its chevron collapses the tree and its `+` creates an agent. Agent rows are data rows that keep the agent's display name: chevron, avatar with its status badge, name, then a collapsed manager's working count (the tooth and a number, read as "N working") and the agent's unread messages. On an agent row the left tooth means only "you are here". Order is the tree's, never by activity. Roots start expanded and the rest collapsed; the user's toggles are remembered per browser; the open agent's managers expand for the visit only. Agent rows open the agent's Chat; the row is active on its Chat and its Session (a live agent's), and an ended agent's pages keep the Agents row active. The collapsed rail shows only what needs a glance: the open agent, agents with unread messages, and agents working, queued, rate-limited or errored.
- **Avatars:** 16px in pickers, the palette and inbox rows; 20px in the sidebar, lists and Agent details; 24px in the session header. Always decorative (`aria-hidden`); a name is beside it, or in the rail its tooltip. In lists a status badge is cut into the bottom-right corner, one shape per status, the same shapes `StatusBadge` uses: the tooth when working, an alert glyph when errored, a filled dot when rate-limited, a hollow ring when queued, nothing at rest. The session header's avatar carries no badge; the status badge beside it does.
- **Colour swatches:** avatar-faced swatches at 24px; 32px pitch on fine pointers, 40px on touch (`hit-touch`); a radiogroup with roving tabindex, Auto first, set apart by an 8px gap with a 1px dashed outline; selected = 2px graphite (foreground) ring at offset 2, focus = the standard signal ring outside it at offset 4; the selected name shows in the legend row and a hue's name is its tooltip and accessible name; arrow keys move and select; no transition.
- **Selected rows:** a row shown in a pane or peek, or the current page of a sub-nav, takes `steel-selected`, one step deeper than hover, and keeps it under the pointer.
- **Command palette:** ⌘K / Ctrl+K from anywhere. A floating layer at the top centre, 640px wide, with the popover look and the scrim; modal. It never animates, however it was opened. Groups: Agents, an exact task key, Go to, Actions, then Tasks: a group whose results arrive late sits last, so nothing above the highlight moves when it lands.
- **Combobox:** a searchable pick (agents, time zones) looks exactly like a Select and opens a popover with a filter field at a fixed height. Arrow keys move the highlight; only Enter or a click commits. A filter ignores a leading `@`. The Manager picker has two labelled groups: People (you first, as "You (Name · @handle)", with the human avatar; disabled users left out), then Agents in tree order. A completion menu (the `@` and `/` menus in a composer) is opened by typing, so it never animates; it is anchored at the caret and opens upward, and focus stays in the textarea. There Tab also commits, as Enter and a click do.
- **Multi-pick Combobox:** A picker that adds to a list opens from a ghost Add action in the list's label row, not a Select-shaped trigger. Its popover stays open after each pick; a picked option stays where it is, disabled and marked Added (single-select listbox semantics, never aria-multiselectable), until the popover closes, and is left out the next time it opens. The popover doesn't move while open, and a polite live region outside the popover announces each addition. A footer line says when a rule limits the options.
- **Keyboard shortcuts:** single keys never fire while typing in a field, inside a menu, list box or tree, or while a modal layer is open, and can be switched off in the shortcuts sheet. `g` then a letter goes to a section; `c` new task; `]` Agent details; `j`/`k` move through lists; `?` lists them all in a sheet. `g k` Skills.
- **Key hints:** one `Kbd` style: Geist 12px, muted, on a plate with a rule; ⌘ on macOS, Ctrl elsewhere. Keys that describe another machine (path help on the factory's machine) are shown literally.
- **Empty states and loading:** one plain line in muted text, with no illustration. In the Inbox that line, its load errors and the mark-all-read outcome sit on the rows' grid, so their text lines up with the rows' text. Exception: a factory with no agents shows numbered setup steps on the Inbox, in the reading pane from 1024px and at the top of the list below. They are two-line rows (buttons that open sheets), not cards; numbers in Geist tabular, not mono; the block leaves instantly once an agent exists, never under the pointer. Loading keeps the layout: static skeleton plates at the real row heights, never shimmering. A spinner always sits next to a pending label ("Terminating…"); under reduced motion the spinner stops and the label carries the meaning.
- **Markdown** (`.prose-of`): headings in Archivo, code on a plate with a rule, link underlines that turn signal on hover, and mermaid diagrams always on a light plate, in trusted content only. In text from outside (tool results, fetched pages) a mermaid fence shows as code. No markdown image ever loads automatically, in the timeline, the inbox or anywhere else: each shows as a link to its source (plain text when the source isn't http(s)).
- **Browser surfaces:** selection is a 26% signal tint, the caret is signal; checkboxes are graphite, scrollbars are thin and graphite-tinted, and focus-visible is a 2px signal ring.
- **Theme:** System / Light / Dark, as a radio group in the sidebar's user menu, under a small "Theme" label. System is the default and keeps following the OS live; Light and Dark override it and are stored per browser (`localStorage` key `of-theme`), synced across open tabs. Everything keys off `<html data-theme="light|dark">`: the tokens, the `dark:` variant, the Shiki colours and the browser `theme-color`. An inline script in `index.html` sets it before first paint, so there is never a flash of the wrong theme.
- **Favicon:** `favicon.svg` and `favicon.ico` in `apps/web/public/`, both from the small cut. There are no PNG, touch or manifest icons, because the app is used in a desktop browser tab, not installed. The full icon set is in the logo project if installing ever matters. `theme-color` is steel (`#F2F4F5`) in light mode and graphite (`#15171A`) in dark mode.

### Motion

**Motion is feedback, not decoration.** The rules come from a review against Emil Kowalski's design-engineering principles (`emilkowalski/skills`, emil-design-eng), adopted where they fit a dense, live-updating Operate tool.

- **Frequency decides.** Anything seen tens of times a day (nav changes, hovers, list updates) is instant or a colour-only change of 150ms at most. Keyboard-initiated actions never animate: ⌘B collapses the sidebar instantly, using `data-instant` on `<html>` for one frame, while a click animates. An overlay opened from the keyboard is stamped `data-instant` for that whole opening, so it appears and leaves at once; the one-frame `data-instant` on the root still covers keyboard-triggered transitions (⌘B) and now zeroes animations too. Live lists never reorder, insert above the pointer or drop rows while the pointer or focus is in them; the change waits until both leave, then applies without animation. A selected row stays until the selection moves. Columns that change the page's layout (Agent details from 1024px, the settings sub-nav, the inbox pane) appear instantly; only the sidebar's collapse animates. A peek retargeted to another item swaps its content in place, instantly; it never closes and reopens. A key that closes an overlay (Esc, `]`, `?`, Space on a peek) closes it at once, however it was opened. A disclosure chevron rotates only when its own chevron was clicked. A selection moved from the keyboard (`j`/`k`, arrows) takes its fill at once; only pointer hover fades. In-field feedback such as a note swap is not a keyboard-initiated transition: a Tab-triggered error fades like a clicked one. Inside an overlay opened from the keyboard everything is instant for that opening, notes included.
- **Curves** (tokens in `styles.css`; the built-in CSS easings are too weak):
  - `--ease-out` `cubic-bezier(0.23, 1, 0.32, 1)`: anything entering, plus press feedback.
  - `--ease-in-out` `cubic-bezier(0.77, 0, 0.175, 1)`: movement on screen (the sidebar collapsing).
  - `--ease-drawer` `cubic-bezier(0.32, 0.72, 0, 1)`: sheets and drawers sliding in.
  - Never `ease-in` or `linear` for UI. Linear only for constant rotation (the spinner).
- **Durations:** Press feedback 150ms. Toasts 200ms in (opacity and an 8px rise), 150ms out; when the list changes, the others shift over 200ms (`transform`: Sonner places each toast with its `--y` offset); the toaster's left edge follows the sidebar over 200ms by animating `left`. A disclosure chevron rotates over 150ms on `--ease-out`; the content it reveals never animates. Menus, popovers, selects and tooltips 100ms in, 75ms out. Dialogs 150ms in (from 96%), 100ms out (fade only). The command palette never animates. Sheets and drawers 250ms in on `--ease-drawer` and 200ms out on `--ease-out`, travelling 100% of their own size with no panel fade, the scrim on the same timing. The sidebar 200ms. Exits are faster than entries. Nothing else runs over 300ms. A field's note swaps in place: the new text fades in over 150ms and the old fades out over 100ms on `--ease-out`, opacity only (visibility flips at the ends). A form's outcome line fades in over 150ms and leaves at once. A control's invalid edge changes colour on the same pair.
- **Live rows:** a row appended to the session timeline by a live frame fades in with opacity only (150ms `--ease-out`), as does the activity line when it appears. Never on load, Load earlier, a resync, a tab's return or a catch-up, and never with movement or stagger. A row that replaces one already on screen (a queued or sending message becoming the delivered one, the activity line becoming the turn footer) keeps its place and doesn't fade. A running turn shows a ticking duration, on whole seconds and paused while the tab is hidden; waiting lines and holds keep fixed times. A deadline shows as a fixed clock time ('Expires at 14:32'), never a relative duration that goes stale. Status labels change instantly, except a change to the fallback ("Working"), which holds the previous label for 400ms waiting for a more specific one, and never past the end of the turn. Live text fades in once per block (opacity only); becoming the saved message keeps its element and height and doesn't fade, and text restored by a reload or reconnect appears without a fade. A counter on the activity line or a subagent card changes at most twice a second. The Chat follows the same rule: a message that arrived by a live frame fades in; your own send, a pending message becoming delivered (its status gives way to its time) and the outcome replacing the working line keep their element and don't fade; the working line fades in like the activity line when it appears live. Nothing fades on load, a reading-pane retarget or a Chat/Session switch.
- **Press:** pressable buttons scale to 0.98 on `:active` (not 0.97, because the full-width auth buttons are large). Transitions always name their properties; never `transition-all`.
- **Popovers:** Menus, popovers, selects and tooltips scale from their trigger (`--radix-*-transform-origin`) from 95% with a fade, with no directional slide. Tooltips wait 400ms the first time, then neighbours open instantly (skip delay 300ms) with no animation. Dialogs scale from 96% at the centre. The command palette never animates.
- **Reduced motion means fewer, gentler animations, not none.**
  - Fades stay.
  - Scale, slide and rotate are removed from enter and exit animations.
  - The sidebar's width and position changes, and the button press scale, are switched off.
  - The loading mark rests lit.
  - Sheets and drawers fade instead of sliding.
  - Toasts don't shift when the list changes, and the toaster doesn't slide with the sidebar.
- **Deliberately not used:**
  - Staggered list entrances, because live lists would ripple on every websocket update.
  - Springs and the Motion library. Drawers can be dragged now, through Vaul's CSS transitions (see Gesture UI); Motion waits for drag-to-reorder.
  - Blur crossfades, except for copy feedback (150ms in, blur of 1px at most), and hold-to-delete, until a specific component needs them.
  - Animated status: dots change colour over 150ms; the working tooth never pulses.
- **Performance:** Motion is only as smooth as the main thread: the timeline commits at most once per frame, and unchanged rows don't re-render.
- The loading mark is the only authored animation.
- **Gesture UI** (anything dragged, reordered or swiped) follows these rules from Apple's *Designing Fluid Interfaces*, via `emilkowalski/skills` apple-design:
  - Tracking is 1:1 with the pointer, using pointer capture, and respects where the item was grabbed.
  - Feedback starts on pointer-down.
  - Motion uses critically damped springs (bounce 0) by default. Bounce is added only after a flick that carried momentum.
  - The release velocity is handed to the spring, and the landing point is projected from the momentum.
  - Edges rubber-band instead of stopping hard.
  - On touch, an overlay trigger opens on click, never on pointer-down (a mouse still opens on pointer-down), so starting a scroll on the trigger doesn't open it.
  - On touch, long-pressing a row that has a menu opens it: the whole row in lists; on the timeline, the speaker line, tool line or gutter, never text. 500ms, cancelled by movement beyond 8px or by a scroll, with the pressed fill (80ms in) as feedback. The press prevents the native context menu on the row's chrome, never on text, and the finger lifting afterwards doesn't pick an item.
  - Sonner's swipe-to-dismiss is a CSS snap-back, accepted like Vaul's.
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
- Don't animate anything triggered from the keyboard (in-field feedback excepted, see Motion), use `transition-all`, or use `ease-in` / `linear` for UI motion.
- Don't set type in px, and don't confirm an action that can be undone.
- Don't use translucent materials or backdrop blur. Depth is the plate stack.
- Don't retype, recolour, flip or close the logo, or add a floor line to it.
- Don't add decorative shadows, gradients, glass, eyebrow labels, colored side-borders on cards, toasts for outcomes whose control is still on screen, or centered modals for anything but a destructive confirmation or the command palette.
- Don't give a floating layer a shadow; use the plate step and `float-edge`.
- Don't use mono as a costume for non-code labels.
- Don't warm the neutrals (no cream, beige or paper grounds), and don't let them drift into visible blue. Every neutral stays at hue 250–255, chroma under 0.01.
