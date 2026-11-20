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
  rule: "oklch(0.89 0.005 250)"
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
  night-text: "oklch(0.94 0.004 250)"
  night-muted: "oklch(0.72 0.008 250)"
  night-signal: "oklch(0.682 0.211 37.7)"
  night-crimson: "oklch(0.7 0.16 15)"
  night-warning: "oklch(0.82 0.15 92)"
typography:
  heading-page:
    fontFamily: "Archivo Variable, Geist Variable, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "20px"
    letterSpacing: "-0.01em"
  heading-auth:
    fontFamily: "Archivo Variable, Geist Variable, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: "28px"
    letterSpacing: "-0.01em"
  prose-h1:
    fontFamily: "Archivo Variable, Geist Variable, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 650
    letterSpacing: "-0.01em"
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
    height: "36px"
  button-ghost:
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.lg}"
    height: "36px"
  input:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.lg}"
    height: "36px"
  card:
    backgroundColor: "{colors.plate}"
    rounded: "{rounded.lg}"
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

1. **Steel and graphite.** The light theme sits on cool steel, the dark theme on graphite. The neutrals are deliberately cool and almost colourless, so the warm orange is the only temperature on screen. (Earlier versions used the logo's warm Paper as the ground; together with an orange accent it read too close to Claude's cream-and-terracotta palette, and this product runs on Claude Code.)
2. **One signal.** Signal Orange marks what is live, focused or selected. It is never decoration.
3. **The pitch.** The logo's 30° angle appears in exactly three places (see Shapes).
4. **Archivo headings.** The wordmark's typeface sets page and auth titles. Everything else is Geist.

Both themes are equal citizens. The theme follows the OS by default, and the user menu offers System, Light and Dark; the choice is remembered per browser (see Components → Theme). Tokens live in `apps/web/src/styles.css`. The logo masters the app uses (light and dark horizontal lockups, the small cut) and the usage rules live in `brand/`; `brand/USAGE.md` is binding.

## Colors

The strategy is **restrained**: cool neutrals do almost all the work, plus one accent. Every neutral sits at hue 250–255 with chroma under 0.01: steel, not blue. The contrast in temperature between the cool floor and the warm signal is the identity.

### Primary

- **Signal Orange** (`brand-orange` `#FF5A1F`): the logo's colour. It is used **only inside the logo**, never for UI.
- **Signal** (`signal`, light `oklch(0.6 0.2 37)` ≈ `#DD4202`; dark = exactly `#FF5A1F`): the UI's version of the orange. It is used for focus rings, the active-nav tooth, the loading mark, text selection, the caret, checkbox accents, link underlines on hover, and the `working` agent status. Light mode deepens it because `#FF5A1F` on the steel ground is only 2.8:1, below the 3:1 minimum for non-text UI. The deepened signal reaches at least 3.2:1 on every light surface, including the active nav row. In dark mode it is ≥5.1:1 on every surface.
- **Signal text** (`signal-text`): use it when orange must be read as text. It is ≥5:1 in both themes.

### Neutral

- **Light:** the `steel` ground (`#F2F4F5`). A `plate` is one step lighter, for cards, inputs and code blocks, and popovers are lighter still. The `steel-deep` sidebar sits one step darker than the ground. `rule` is for dividers and card edges, and `field-edge` is for input boundaries (≥3.2:1, WCAG 1.4.11). Text is `graphite-ink` (`#14161A`, 16.4:1), and secondary text is `ink-muted` (≥5:1 on every light surface).
- **Dark:** the `night-ground` is graphite (`#15171A`). The rail is darker still (`night-rail`), as a recessed edge, and plates step lighter as they rise. Text is `night-text` (15:1), and `night-muted` reaches ≥6.2:1.
- **Primary buttons are graphite in light mode and light steel in dark mode, never orange.**
- **The logo keeps its own colours.** The lockups use the logo's warm Ink and Paper for the lettering, which reads correctly on steel and graphite. Never recolour them to match the UI.

### Semantic

`success`, `warning`, `info` and `crimson` (destructive / errored) are indicator colours for dots and icons, always paired with a label. They are spaced around the signal so no status can be mistaken for "working": crimson is pushed to hue 20 (light) and 15 (dark), and warning (rate-limited) is ochre at hue 88–92, 50° clear of the orange. All seven agent statuses were checked side by side at 6px dot size in both themes. Colour alone does not separate every pair: in the light theme `working` and `rate_limited` are indistinguishable for deuteranopes (ΔE 1.0), and `queued` and `idle` for tritanopes. The tooth shape and the label carry the difference, which is why status is never colour alone. Agent status tokens (`--status-*`) and chart tokens (`--chart-*`) are defined alongside them for status indicators and data charts.

Task status: Done uses `success`, the Blocked marker uses `warning`; both always with a label.

Chart series start at `--chart-2`; `--signal` marks only the focused datum.

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

- **Archivo** (variable, self-hosted via `@fontsource-variable/archivo`) is the `font-heading` face. It is the typeface the wordmark is cut from. Use it for page titles (16px/600), auth titles (22px/700), error and not-found headings, card and sheet titles, and markdown headings. Tracking is −0.01em, matching the wordmark's −1%.
- **Geist** covers all UI and body text. Base UI text is 14px, labels and secondary text are 13px, and long-form prose is 14/22.
- **Geist Mono** is only for things that are literally identifiers or code: code, handles (`@alice`), slugs, keys. It is never a "technical" costume for labels.

### Hierarchy

| Role | Face | Size / line | Weight |
|---|---|---|---|
| Auth title | Archivo | 22 / 28 | 700 |
| Page title (h1 in the 48px header) | Archivo | 16 / 20 | 600 |
| State heading (error, not found) | Archivo | 16 / 20 | 600 |
| Markdown h1 / h2 / h3 | Archivo | 20 / 17 / 15 | 650 |
| Body / UI | Geist | 14 / 22 | 400 |
| Label, secondary, panel heading | Geist | 13 / 18 | 400–500 |
| Code | Geist Mono | 13 / 1.55 | 400 |

### Named Rules

- **Never retype the wordmark.** "OpenFactory" in Archivo is a drawing, not text. Render it with the `Wordmark` component, which is built from the outlined master.
- **Type is set in rem, never px.** Sizes and line heights follow the reader's browser font-size setting, not just page zoom. The pixel values in the table are at the 16px default: 13px is `0.8125rem`, 14px is `0.875rem`, 18px is `1.125rem`, 22px is `1.375rem`.
- **Tracking scales with size.** Headings are tightened (−0.01em). Body text and labels stay at 0, because Geist is already spaced for small sizes.
- **Sentence case everywhere.** The voice is a calm senior engineer (PRODUCT.md).

## Layout

- A 4px grid. Controls are 32px tall on desktop and 36px on touch, and the page header is 48px.
- The shell is a 240px sidebar, collapsible to icons, plus the content area. On mobile the sidebar becomes a sheet.
- Content gutters are 16px on mobile and 24px from `md` up.
- Dense by design. Trees, timelines and tables put a lot on one screen, so rhythm comes from rules and spacing, not boxes.

## Elevation & Depth

Flat. Depth comes from stacked plates, not shadows: the steel ground, then a plate on it, then a popover. A plate is lighter than the ground and edged with a 1px `rule`. In dark mode, layers step lighter as they rise, and the rail steps darker. There are no decorative shadows.

## Shapes

Corners are tight, following the logo's mitred geometry: `--radius` is 6px (0.375rem), with `sm` 3.6px, `md` 4.8px and `xl` 8.4px derived from it.

### The pitch (30°)

The roof angle is the one shape that belongs to Open Factory. It is used in **exactly three places**, and adding a fourth is a design decision that needs recording here:

1. **The logo.** This covers the mark, the wordmark (the cut *t*) and the favicon set.
2. **The active-nav tooth** (`.of-tooth`). One roof bay, 6×12px in `--signal`, with a vertical wall on the right and a 30° roof rising to it (rise 3.46px = 6 × tan 30°). It replaces the generic active bar. The `working` agent status uses the same tooth, so "this is live" always has the same silhouette.
3. **The loading mark** (`LoadingMark`). The roofline lights up in orange from left to right over a faint track, in the direction the teeth rise. Each pass takes 1.2s: it lights over the first ~0.8s on `--ease-out`, then rests lit. Under reduced motion it shows lit and still.

## Components

- **Logo** (`apps/web/src/components/wordmark.tsx`):
  - `Wordmark` is the horizontal lockup. It swaps between the light master and the reversed (~2% thinner) dark master by theme, never by recolouring one file. It is 20px tall in the sidebar (≈110px wide, above the 96px minimum) and 24px on auth pages.
  - `Mark` is the symbol on its own, always the **small cut** (16px grid), because every in-app use is under 32px.
  - `LoadingMark` is the pending screen.
  - Clear space is 2× the roofline stroke on every side.
- **Buttons:** primary is a graphite fill with steel text (inverted in dark mode). Ghost is for secondary actions. Danger uses crimson. Buttons name their action.
- **Inputs:** a plate fill with a `field-edge` boundary, a signal focus ring (2px, offset 2px) and a signal caret. Errors appear inline below the field in crimson with an icon.
- **Validation:** the two short auth forms validate on submit and then move focus to the first invalid field. Editing a field clears its error. Longer forms (templates, schedules) validate each field when you leave it, never while you type, and still check everything on submit.
- **Destructive actions: forgiveness over confirmation.**
  - Prefer undo. When an action can be reversed, do it immediately and offer an inline undo.
  - Ask for confirmation only when the action is both destructive and irreversible, such as terminating an agent and discarding its session, or deleting a template.
  - The confirmation names exactly what will be lost, and its button names the action ("Terminate @reviewer", never "OK").
  - A confirmation shown for routine actions trains people to click through, so it never appears for those.
- **Scrim:** the mobile sheet dims the page with a plain 20% black scrim. There is no backdrop blur, because there is no translucency anywhere in the system, so `prefers-reduced-transparency` has nothing to undo.
- **Cards and panels:** a plate on the ground, a 1px rule edge and a 6px radius, with a 40px header strip that has its own rule. Cards are never nested.
- **Navigation:** sidebar rows are 32px. The active row gets the `steel-hover` fill plus the tooth, and the icon rail keeps the tooth. Nav labels are capitalised product nouns.
- **Empty states:** one plain line in muted text, with no illustration.
- **Markdown** (`.prose-of`): headings in Archivo, code on a plate with a rule, link underlines that turn signal on hover, and mermaid diagrams always on a light plate.
- **Browser surfaces:** selection is a 26% signal tint, the caret and checkbox accent are signal, scrollbars are thin and graphite-tinted, and focus-visible is a 2px signal ring.
- **Theme:** System / Light / Dark, as a radio group in the sidebar's user menu, under a small "Theme" label. System is the default and keeps following the OS live; Light and Dark override it and are stored per browser (`localStorage` key `of-theme`), synced across open tabs. Everything keys off `<html data-theme="light|dark">`: the tokens, the `dark:` variant, the Shiki colours and the browser `theme-color`. An inline script in `index.html` sets it before first paint, so there is never a flash of the wrong theme.
- **Favicon:** `favicon.svg` and `favicon.ico` in `apps/web/public/`, both from the small cut. There are no PNG, touch or manifest icons, because the app is used in a desktop browser tab, not installed. The full icon set is in the logo project if installing ever matters. `theme-color` is steel (`#F2F4F5`) in light mode and graphite (`#15171A`) in dark mode.

### Motion

**Motion is feedback, not decoration.** The rules come from a review against Emil Kowalski's design-engineering principles (`emilkowalski/skills`, emil-design-eng), adopted where they fit a dense, live-updating Operate tool.

- **Frequency decides.** Anything seen tens of times a day (nav changes, hovers, list updates) is instant or a colour-only change of 150ms at most. Keyboard-initiated actions never animate: ⌘B collapses the sidebar instantly, using `data-instant` on `<html>` for one frame, while a click animates.
- **Curves** (tokens in `styles.css`; the built-in CSS easings are too weak):
  - `--ease-out` `cubic-bezier(0.23, 1, 0.32, 1)`: anything entering, plus press feedback.
  - `--ease-in-out` `cubic-bezier(0.77, 0, 0.175, 1)`: movement on screen (the sidebar collapsing).
  - `--ease-drawer` `cubic-bezier(0.32, 0.72, 0, 1)`: the mobile sheet sliding in.
  - Never `ease-in` or `linear` for UI.
- **Durations:** press feedback 150ms; menus and tooltips 100ms; the sidebar 200ms; the sheet 250ms in and 200ms out (exits are faster than entries). Nothing else runs over 300ms.
- **Press:** pressable buttons scale to 0.98 on `:active` (not 0.97, because the full-width auth buttons are large). Transitions always name their properties; never `transition-all`.
- **Popovers** (menus, tooltips) grow from their trigger (`--radix-*-transform-origin`), starting at 95% scale with a fade, never from `scale(0)`.
- **Reduced motion means fewer, gentler animations, not none.**
  - Fades stay.
  - Scale, slide and rotate are removed from enter and exit animations.
  - The sidebar's width and position changes, and the button press scale, are switched off.
  - The loading mark rests lit.
- **Deliberately not used:**
  - Staggered list entrances, because live lists would ripple on every websocket update.
  - Springs and the Motion library, until something can be dragged.
  - Blur crossfades and hold-to-delete, until a specific component needs them.
- The loading mark is the only authored animation.
- **Gesture UI** (anything dragged, reordered or swiped) follows these rules from Apple's *Designing Fluid Interfaces*, via `emilkowalski/skills` apple-design:
  - Tracking is 1:1 with the pointer, using pointer capture, and respects where the item was grabbed.
  - Feedback starts on pointer-down.
  - Motion uses critically damped springs (bounce 0) by default. Bounce is added only after a flick that carried momentum.
  - The release velocity is handed to the spring, and the landing point is projected from the momentum.
  - Edges rubber-band instead of stopping hard.
  - Animations start from the value currently on screen, so they can be interrupted and reversed.

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
- Don't add decorative shadows, gradients, glass, eyebrow labels, colored side-borders on cards, toasts or modals for routine tasks.
- Don't use mono as a costume for non-code labels.
- Don't warm the neutrals (no cream, beige or paper grounds), and don't let them drift into visible blue. Every neutral stays at hue 250–255, chroma under 0.01.
