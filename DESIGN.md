---
name: Open Factory
description: Sawtooth. A paper-and-ink workshop with one live signal, built around the open-roof logo.
colors:
  brand-orange: "#FF5A1F"
  brand-ink: "#16140F"
  brand-paper: "#F4F1EA"
  paper: "oklch(0.959 0.01 87)"
  sheet: "oklch(0.982 0.006 87)"
  sheet-raised: "oklch(0.99 0.004 87)"
  paper-deep: "oklch(0.935 0.012 87)"
  paper-hover: "oklch(0.925 0.012 87)"
  rule: "oklch(0.885 0.012 87)"
  field-edge: "oklch(0.62 0.012 80)"
  ink: "oklch(0.192 0.01 89)"
  ink-muted: "oklch(0.5 0.012 80)"
  signal: "oklch(0.6 0.2 37)"
  signal-text: "oklch(0.52 0.17 38)"
  crimson: "oklch(0.52 0.2 20)"
  success: "oklch(0.54 0.13 150)"
  warning: "oklch(0.6 0.13 70)"
  info: "oklch(0.54 0.13 250)"
  night-ground: "oklch(0.192 0.01 89)"
  night-rail: "oklch(0.16 0.009 89)"
  night-sheet: "oklch(0.215 0.01 89)"
  night-rule: "oklch(0.29 0.011 89)"
  night-text: "oklch(0.94 0.01 87)"
  night-muted: "oklch(0.72 0.012 85)"
  night-signal: "oklch(0.682 0.211 37.7)"
  night-crimson: "oklch(0.7 0.16 15)"
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
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.lg}"
    height: "36px"
  button-ghost:
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    height: "36px"
  input:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    height: "36px"
  card:
    backgroundColor: "{colors.sheet}"
    rounded: "{rounded.lg}"
  sidebar:
    backgroundColor: "{colors.paper-deep}"
    width: "240px"
  nav-item-active:
    backgroundColor: "{colors.paper-hover}"
    textColor: "{colors.ink}"
    height: "32px"
  nav-tooth:
    backgroundColor: "{colors.signal}"
    size: "6px 12px"
---

# Design System: Open Factory

## Overview

**Sawtooth.** The logo is a factory roofline drawn as one continuous line with an open floor, with teeth rising left to right at an exact 30°. The product looks like the building that logo describes: a workshop of paper and ink, matte and quiet, with one orange light that means something is running.

The people using it keep the tab open next to their editor for hours, often at night, watching agent sessions and working through an inbox. So the interface stays out of the way (this is an Operate surface). The brand shows in four precise things, and nowhere else:

1. **Paper and Ink.** The light theme sits on the logo's Paper, and the dark theme on its Ink. The tool feels like a workbench, not a cloud console.
2. **One signal.** Signal Orange marks what is live, focused or selected. It is never decoration.
3. **The pitch.** The logo's 30° angle appears in exactly three places (see Shapes).
4. **Archivo headings.** The wordmark's typeface sets page and auth titles. Everything else is Geist.

Theme follows the system only: there is no toggle, and both themes are equal citizens. Tokens live in `apps/web/src/styles.css`. The logo masters the app uses (light and dark horizontal lockups, the small cut) and the usage rules live in `brand/`; `brand/USAGE.md` is binding.

## Colors

The strategy is **restrained**: warm neutrals do almost all the work, plus one accent. Every neutral uses the logo's own hue, 87 (Paper and Ink are both hue ~88 at chroma 0.01), so the surfaces and the logo share one temperature.

### Primary

- **Signal Orange** (`brand-orange` `#FF5A1F`): the logo's colour. It is used **only inside the logo**, never for UI.
- **Signal** (`signal`, light `oklch(0.6 0.2 37)` ≈ `#DD4202`; dark = exactly `#FF5A1F`): the UI's version of the orange. It is used for focus rings, the active-nav tooth, the loading mark, text selection, the caret, checkbox accents, link underlines on hover, and (from S3) the `working` status. Light mode deepens it because `#FF5A1F` on Paper is only 2.76:1, below the 3:1 minimum for non-text UI. The deepened signal reaches at least 3.2:1 on every light surface, including the active nav row.
- **Signal text** (`signal-text`): use it when orange must be read as text. It is ≥4.9:1 in light and ≥5:1 in dark.

### Neutral

- **Light:** the `paper` ground (= Paper `#F4F1EA`). A `sheet` is one step lighter, for cards, inputs and code blocks laid on the paper, and popovers are lighter still. The `paper-deep` sidebar sits one step darker than the ground. `rule` is for dividers and card edges, and `field-edge` is for input boundaries (≥3:1, WCAG 1.4.11). Text is `ink` (= Ink `#16140F`, 16:1 on Paper), and secondary text is `ink-muted` (≥4.9:1 on every light surface).
- **Dark:** the `night-ground` (= Ink). The rail is darker still (`night-rail`), as a recessed edge, and sheets are slightly lighter. Text is Paper dimmed to `night-text` for long reading at night, and `night-muted` reaches ≥6.5:1.
- **Primary buttons are ink in light mode and paper in dark mode, never orange.**

### Semantic

`success`, `warning`, `info` and `crimson` (destructive / errored) are indicator colours for dots and icons, always paired with a label. Crimson is pushed to hue 20 (light) and 15 (dark), so it stays distinguishable from the signal at hue 37. Agent status tokens (`--status-*`) and chart tokens (`--chart-*`) are reserved in CSS for S3/S5/S10.

### Named Rules

- **The Pilot Light Rule.** Orange means "live, on, focused". If an element is not one of those, it is not orange. That rules out orange buttons, headings, backgrounds and illustrations.
- **The Logo Colour Rule.** `#FF5A1F` is used exactly only in the logo. UI orange is always `--signal`, because the logo is exempt from contrast rules and UI is not.
- **Status Is Never Colour Alone.** Every status pairs its colour with a label or icon.

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
| Body / UI | Geist | 14 / 22 | 400 |
| Label, secondary, panel heading | Geist | 13 / 18 | 400–500 |
| Code | Geist Mono | 13 / 1.55 | 400 |

### Named Rules

- **Never retype the wordmark.** "open factory" in Archivo is a drawing, not text. Render it with the `Wordmark` component, which is built from the outlined master.
- **Sentence case everywhere.** The voice is a calm senior engineer (PRODUCT.md).

## Layout

- A 4px grid. Controls are 32px tall on desktop and 36px on touch, and the page header is 48px.
- The shell is a 240px sidebar, collapsible to icons, plus the content area. On mobile the sidebar becomes a sheet.
- Content gutters are 16px on mobile and 24px from `md` up.
- Dense by design. Later screens (org tree, session timeline, task tables) put a lot on one screen, so rhythm comes from rules and spacing, not boxes.

## Elevation & Depth

Flat. Depth comes from the paper stack, not shadows: paper, then a sheet on paper, then a popover. A sheet is lighter than the ground and edged with a 1px `rule`. In dark mode, layers step lighter as they rise, and the rail steps darker. There are no decorative shadows.

## Shapes

Corners are tight, following the logo's mitred geometry: `--radius` is 6px (0.375rem), with `sm` 3.6px, `md` 4.8px and `xl` 8.4px derived from it.

### The pitch (30°)

The roof angle is the one shape that belongs to Open Factory. It is used in **exactly three places**, and adding a fourth is a design decision that needs recording here:

1. **The logo.** This covers the mark, the wordmark (the cut *t*) and the favicon set.
2. **The active-nav tooth** (`.of-tooth`). One roof bay, 6×12px in `--signal`, with a vertical wall on the right and a 30° roof rising to it (rise 3.46px = 6 × tan 30°). It replaces the generic active bar. It is reserved for the S3 `working` status indicator too, so "this is live" always has the same silhouette.
3. **The loading mark** (`LoadingMark`). The roofline lights up in orange from left to right over a faint track, in the direction the teeth rise. Each pass takes 1.2s: it lights over the first ~0.8s on `--ease-out`, then rests lit. Under reduced motion it shows lit and still.

## Components

- **Logo** (`apps/web/src/components/wordmark.tsx`):
  - `Wordmark` is the horizontal lockup. It swaps between the light master and the reversed (~2% thinner) dark master by theme, never by recolouring one file. It is 20px tall in the sidebar (≈107px wide, above the 96px minimum) and 24px on auth pages.
  - `Mark` is the symbol on its own, always the **small cut** (16px grid), because every in-app use is under 32px.
  - `LoadingMark` is the pending screen.
  - Clear space is 2× the roofline stroke on every side.
- **Buttons:** primary is an ink fill with paper text. Ghost is for secondary actions. Danger uses crimson. Buttons name their action.
- **Inputs:** a sheet fill with a `field-edge` boundary, a signal focus ring (2px, offset 2px) and a signal caret. Errors appear inline below the field in crimson with an icon.
- **Cards and panels:** a sheet on paper, a 1px rule edge and a 6px radius, with a 40px header strip that has its own rule. Cards are never nested.
- **Navigation:** sidebar rows are 32px. The active row gets the `paper-hover` fill plus the tooth, and the icon rail keeps the tooth. Nav labels are capitalised product nouns.
- **Empty states:** one plain line in muted text, with no illustration.
- **Markdown** (`.prose-of`): headings in Archivo, code on a sheet with a rule, link underlines that turn signal on hover, and mermaid diagrams always on a light sheet.
- **Browser surfaces:** selection is a 26% signal tint, the caret and checkbox accent are signal, scrollbars are thin and ink-tinted, and focus-visible is a 2px signal ring.
- **Favicon and app icons:** served from `apps/web/public/` (`favicon.ico`, `favicon.svg`, touch and manifest icons). `theme-color` is Paper in light mode and Ink in dark mode.

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
  - Springs and the Motion library, because nothing is dragged yet; revisit for the org-tree editor.
  - Blur crossfades and hold-to-delete, until a specific component needs them.
- The loading mark is the only authored animation.

## Do's and Don'ts

**Do**
- Keep orange for what is live, focused or selected.
- Use `--signal` / `--signal-text` for UI orange, and `--brand-orange` only in the logo.
- Use Archivo for titles and Geist for everything else.
- Let the paper stack and 1px rules carry structure.
- Pair every status colour with a label.
- Follow `brand/USAGE.md` for any logo placement outside the app (docs, README, social).

**Don't**
- Don't make primary buttons, headings, fills or illustrations orange.
- Don't add the 30° pitch as decoration: no sawtooth dividers, angled card corners or pitched headers.
- Don't animate anything triggered from the keyboard, use `transition-all`, or use `ease-in` / `linear` for UI motion.
- Don't retype, recolour, flip or close the logo, or add a floor line to it.
- Don't add decorative shadows, gradients, glass, eyebrow labels, colored side-borders on cards, toasts or modals for routine tasks.
- Don't use mono as a costume for non-code labels.
- Don't use blue-grey neutrals. Every neutral stays on hue 87.
