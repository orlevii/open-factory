# I4 Field errors: Technical Design

- **Date:** 2026-11-23
- **Status:** revised after the self-review and five UI-lens reviews (Taste, Apple design, Emil design-eng, Motion, Break UI). The owner-proxy (owner-i4) answered Q1–Q19. Low certainty, for Or: Q5 (the restart notice shares the outcome line, 3), Q6/Q17 (crossfade timing, 3), Q15 (fade for keyboard-triggered errors, 3), and Q14 (the fade stays under reduced motion, overriding the task spec's "instant swap").
- **Source of truth (gitignored, read from the main checkout):** `docs/product/roadmap/v0.0.2/i4-field-errors.md` (the task), `docs/product/roadmap/v0.0.2/scope.md`, `docs/product/roadmap/v0.0.2/index.md` (I4 lands first; I2, I3 and later forms build on it), `docs/product/decisions/0028-pre-release-no-compatibility.md`, `docs/product/ui-review/decisions.md`.
- **Builds on:** `main` at 64d0edc (U1–U4 merged: `FieldShell`, `FormField`, `FormFrame`, `InlineForm`, `SheetFormFooter`, `InlineOutcome`, `MoreOptions`, the adaptive `ConfirmDialog`).
- **Decision log:** GitHub issue "I4: Field errors — design". Q1–Q19 are the proxy's answers; D1–D14 are tech-lead decisions (§12).

> `docs/product/` is gitignored. Paths into it are relative to the main checkout. Web paths are relative to `apps/web/src/` unless they start with `apps/` or `packages/`.

## 1. Goal

A validation error appears where the eyes already are and moves nothing. Today `FieldShell` inserts the error paragraph under the control on demand, so every field below jumps by a line; the form-level error (a conditional `<p role="alert">` or an `empty:hidden` div) jumps the buttons too, and in `ConfirmDialog` and `FormFrame` it sits inside the scrolling body, where it can render out of view. Each form re-implements error state, blur validation, clear-on-edit and focus-first-invalid, and the copies have drifted (focus before the error renders, through `flushSync`, in an effect, in a microtask).

After I4:

1. Every field reserves its one note line, always. Help text and the error share it and swap in place.
2. Every form-level outcome (error, and success where the form has one) has one reserved line directly above the buttons, outside any scroll region.
3. One hook owns validation timing and focus, and every form uses it.
4. Every error message fits one line on a phone and names the rule that failed.

### 1.1 Deviations from the task spec (owner-proxy approved)

- **Form-level line above the buttons, not beside the submit** (Q5, Q18): a 480px sheet footer already holds "Draft restored · Discard" beside its buttons, and phone drawers stack the buttons full width, so "beside" has no room on desktop and cannot exist on phones. One placement works at both widths.
- **The fade stays under reduced motion** (Q14): DESIGN.md → Motion says "Reduced motion means fewer, gentler animations, not none. Fades stay"; an opacity change is not vestibular motion. The task spec's "Reduced motion: instant swap" is dropped.
- **Crossfade 150ms in, 100ms out, not ~150ms symmetric** (Q17): DESIGN.md's "Exits are faster than entries", and a symmetric fade draws the two notes over each other.
- **Resolved dependencies show as the note's help line, not badges below the field** (Q19).

## 2. Acceptance criteria

Default CI (`pnpm test`, `pnpm typecheck`, `pnpm lint`) unless marked manual (the evidence pass, §11).

1. **Nothing moves.** In every form in §4, triggering an error (blur and submit) and fixing it leaves the bounding box of every element in the form (fields, MoreOptions header, footer and its buttons) unchanged, at 1440×900 and 390×844, in Chromium and WebKit headless (manual, scripted `getBoundingClientRect` before and after). Accepted exceptions, each measured as one:
   - (a) an error longer than the reserved line (help or empty) pushes what is below; at 200% text this is any error longer than half a line. Nothing clips or truncates.
   - (b) the chosen template's summary under the Template field (content the user asked for, shown while focus is still on the pick).
   - (c) a submit that finds an error inside a folded MoreOptions, the closed Address line or New template's hidden Name field opens it (§6.5).
   - (d) a server-provided form-level message (`err.message` passed through) longer than one line.
2. **Timing.** A field shows an error on blur only if the user changed it since the form mounted (or it already shows one), except when focus leaves the document or goes to a `data-skip-validate` control (§5.4); never while typing; on submit every relevant field is checked. While an error shows, each keystroke re-runs the field's synchronous check: valid clears it at once, still-invalid updates the message. Async and server errors clear on any edit of their field (unit tests on the hook, component tests per form).
3. **Focus.** Submitting a form with errors (sync, async or server) focuses the first invalid field in DOM order after the errors render, including a field inside a MoreOptions or Address line the submit opened, after a server 400 re-enables the fieldset, and after an async check settles. The whole field, note included, is scrolled into view inside its scroll container at 390×844 and 1440×900 (tests per form; manual for the scroll).
4. **Signals.** An invalid control has `aria-invalid="true"`, a crimson edge (`aria-invalid:border-destructive`) and the note shows the alert icon plus text, never colour alone. `aria-describedby` names the visible note (the error while there is one, else the help) plus any persistent description the field already has (the Projects legend's "Custom / From the template" marker, the template summary); never the hidden note. The hidden note is `visibility: hidden` once its fade ends (tests on `FieldShell`).
5. **Announcements.** A blur error is not announced live; it is read when focus returns to the field. A form-level error is announced once each time it appears, including a second identical failure (`role="alert"`, text inserted fresh); a success through `role="status"`; pending only through an sr-only status (tests; manual VoiceOver + Safari check in §11).
6. **One mechanism.** No field or form error renders outside `FieldNote` and `FormOutcome`: a UI-contract test scans every `features/**` and `components/**` `.tsx` (tests excluded), matching per JSX element (an element whose opening tag or children span several lines counts as one), and fails on a `CircleAlert` + `text-destructive` paragraph, an `empty:hidden` alert line, or a conditional `{x && <p role="alert">}`, outside those two components; an element that is not form validation carries `ui-contract:allow <reason>` on its opening line (about 25 existing files need one: session, templates, schedule state, the credentials row status, `InlineOutcome`, `ErrorLine`, …) (`test/ui-contract.test.ts`).
7. **Copy.** Every field message and every client form-level message is at most 40 characters, never interpolates a user value, and names one rule. Shared Zod messages and server `FieldError` messages are exported constants checked by a length test in their own package; web check messages by a test over the web constants; a grep test fails on a template literal passed to `FieldError` or `f.set` (§8).
8. **Motion.** The note swap is opacity only (with `visibility` flipping at the ends), entering over 150ms and leaving over 100ms on `--ease-out`, a CSS transition, no movement; the control's edge colour follows the same pair (unit test on the class contract; manual recording in §11).

## 3. Scope

**In:** `FieldNote` (new), `FieldShell`, `FormField`, `TokenField`, `ValueField`, `MarkdownEditor` (invalid frame); `FormOutcome` (new) in `SheetFormFooter`, `FormFrame`, `InlineForm`, `AuthCard`, `ConfirmDialog`, the Factory settings form and task detail's `EditorButtons`; the `useFieldErrors` hook and `focusField`; every form in §4 migrated; the hand-rolled renderers deleted (link-editor rows, `TemplateField`, `ProjectGrantPicker`, `Unverifiable` in `TokenField`, the task form's links line); error copy rewritten in web, `packages/shared` and `apps/server`; control edge timing; DESIGN.md amended (§10).

**Out:** the credentials row's "Last check failed" line (a stored row status, Q11); session composer error lines; `ErrorLine` load failures. One follow-up issue, "non-form status lines", covers four lines that shift layout but are not form validation: task detail's sidebar Assignee/Status action error line (`task-detail.tsx:583`; `ui-contract:allow` until then), Edit schedule's Pause/Delete `StateLine`, Factory settings' "changed elsewhere" banner, and MoreOptions' self-open reason line wrapping on long secret names. A second follow-up: `LinkEditor`'s viewport-based `md:` row switch should be a container query inside a 480px sheet.

**Breaking (ADR 0028):** `FieldShell` always renders its note; `SheetFormFooter`'s `above`, `FormFrame`/`InlineForm`/`AuthCard`'s `formError`, and `auth-card.tsx`'s `focusFirstInvalid` are deleted and replaced by the `outcome` prop and `focusField`; every form's own error state, blur handlers, clear-on-edit and focus code is deleted, not wrapped; shared schema messages change, which changes what the server, MCP tools and CLI return. No compatibility props or aliases.

## 4. Inventory

Every form that shows a validation error today, what it does now. §7 says what each becomes.

| Where | Fields today | Timing today | Form-level error today | Focus today |
|---|---|---|---|---|
| `routes/sign-in.tsx` | `FormField` email, password | submit only; any edit clears | `AuthCard` conditional `<p role=alert>` above submit | `flushSync` + `focusFirstInvalid` |
| `routes/sign-up.tsx` | `FormField` name, handle (`@` prefix, help), email, password (help) | submit only; any edit clears | same | same |
| `features/tasks/task-form.tsx` (New task sheet) | `FormField` title; `FieldShell` assignee (`AgentCombobox`, help), description (`MarkdownEditor`, no invalid edge); `DependencyEditor`; `LinkEditor` rows; a separate links `<p>` | blur + submit; async dependency lookup; stale assignee set in an effect; any edit clears | conditional `<p role=alert>` "Couldn't create the task. Try again." in the body | `flushSync` then `querySelector`; server 400 in `queueMicrotask` |
| `features/tasks/dependency-editor.tsx` | `FieldShell` with help; resolved badges between input and note | parent's | — | — |
| `features/tasks/link-editor.tsx` | hand-rolled per-row `<p>` with `CircleAlert`, conditional; rows `flex-wrap`, title `max-md:order-last` | blur per row | — | parent queries `[aria-invalid]` |
| `features/tasks/task-detail.tsx` editors (title, description, dependencies, links) | title `Input` with `aria-invalid`, its validation shown in `EditorButtons`' failed line; dependencies and links reuse the editors above | title on Save; dependencies and links on blur and Save; any edit clears | `EditorButtons`: a hint `<p>` and a conditional failed `<p role=alert>` above Save | none |
| `features/schedules/schedule-form.tsx` (New/Edit schedule) | `FieldShell` target (help), timezone (help), body (help); `WhenField` → `RepeatsField` (cron) / `FieldShell` at | blur + submit; edit checks changed fields only; stale target set during render | conditional `<p role=alert>` "Couldn't save the schedule. Try again." | `setToFocus` + effect |
| `features/agents/agent-form-state.ts` + `new-agent-sheet.tsx`, `edit-agent-sheet.tsx` | `TemplateField` (hand-rolled error `<p>`, summary below), `FormField` displayName, `AddressLine` → `FormField` slug (help), `FieldShell` reportsTo (help = stale note), description, credential (help = stale note), `ProjectGrantPicker` (hand-rolled fieldset error) | blur + submit (both modes check every field); any edit clears | `InlineOutcome` in the body below the fields (with `ShowOutput` `<details>` for plugin failures); Edit agent's restart notice in `SheetFormFooter`'s `above` row; New agent's "Installing plugins…" `note` | `wantFocus` ref + effect on `[pending, errors]`; MoreOptions opens once per `autoKey` |
| `features/templates/new-template-form.tsx` (sheet via `FormFrame`) | `FormField` displayName, name (help, hidden until revealed), `FieldShell` description | blur + submit | `FormFrame` `formError` (`empty:hidden` alert inside `SheetBody`) | `flushSync` reveals Name, then `querySelector` |
| `features/settings/forms/add-credential-form.tsx` | `FormField` name, `FieldShell` kind (legend), `TokenField` (verdict error or warning) | blur + submit; verification 422 after submit | `FormFrame` | `getElementById` before render |
| `features/settings/forms/add-project-form.tsx`, `add-secret-form.tsx` | `FormField` name, path / `ValueField` | blur + submit | `FormFrame` | `getElementById` before render |
| `features/settings/credentials-section.tsx` (Replace token), `secrets-section.tsx` (Update value), `projects-section.tsx` (Change path) | `TokenField`, `ValueField`, `FormField` | submit (projects: blur too) | `InlineForm` `formError` (`empty:hidden` alert above the buttons) | `getElementById` |
| `features/settings/factory-section.tsx` | `FieldShell` number fields (help) | blur always; submit changed only | `InlineOutcome` beside Save ("Saved." / "Couldn't save. Try again.") | `querySelector`, `flushSync` for 400 |
| `features/session/compact-popover.tsx` | instructions field | submit | conditional `CircleAlert` `role=alert` line | none |
| `components/confirm-dialog.tsx` | — | — | `empty:hidden` alert line inside the scrolling middle (desktop) / `DrawerBody` (phone) | — |

## 5. Components

### 5.1 `FieldNote` (new, `components/field-note.tsx`)

The reserved line under a control. Used by `FieldShell` and by each `LinkEditor` row.

```tsx
<FieldNote id={baseId} help={help} error={error} warning={warning} />
// and, called by FieldShell before it renders its children:
noteDescribedBy(baseId, { help, error, warning }) // the visible note's id, or undefined
```

- **Box.** A `div` with class `field-note`: `display: grid; min-width: 0; min-height: 1lh; font-size: 0.8125rem; line-height: 1.125rem`. The type sits on the grid itself, because `1lh` resolves against the element's own line height. The empty line is exactly one note line at any text size.
- **Layers.** The help `<p id="{baseId}-help">` and the error `<p id="{baseId}-error">` both stay mounted in the same cell (`grid-area: 1 / 1`). The cell is as tall as the taller of the two, so swapping never changes its height (D1). The error paragraph keeps its last message after the error clears (render-time adjusted state, `if (error && error !== last) setLast(error)`), so a two-line error that is fixed keeps its height (D2).
- **Swap.** The shown layer: `opacity: 1; visibility: visible; transition: opacity 150ms var(--ease-out), visibility 150ms var(--ease-out)`. The hidden layer: `opacity: 0; visibility: hidden; transition-duration: 100ms`. So the incoming note enters over 150ms and the outgoing one leaves over 100ms, on `--ease-out` (Q17); `visibility` flips at the end of a fade-out, so a hidden note is never read or hit-tested (D3). An error replaced by a different error swaps its text in place, no fade (Q6). A note that is already an error when the field mounts (a restored stale reference, a field in a MoreOptions the submit just opened) appears at once: no `@starting-style`.
- **Error:** `CircleAlert` 14px, then the text in crimson. **Warning** (`TokenField`'s unverifiable verdict only): `TriangleAlert` in ochre, then the text in ink; it takes the error layer's place and does not set `aria-invalid`.
- **Wrapping:** the text sits in a `span` with `min-width: 0; overflow-wrap: anywhere` inside the flex paragraph, so a long mono value breaks instead of widening the column. Never `truncate`, `line-clamp` or `overflow: hidden`.
- **Not a live region.** Field notes are read through `aria-describedby` on focus (the task spec: blur errors are not announced live). The one note that arrives after a submit without focus moving to it (the unverifiable warning) is announced by the form's `FormOutcome`, not by the note (§6.4).

### 5.2 `FieldShell` (changed)

- Always renders `FieldNote` under the control, in both the `label` and the `legend` form. No prop turns it off (Q2).
- Order: label row (with `action`), control, note, then `below` (new, for requested content: the template summary).
- Spacing: label → control 6px, control → note 4px, note → `below` 6px. The shell's root is `grid gap-1.5`; the note takes `margin-top: -0.125rem` to land 4px under the control. The root has `min-width: 0` and `data-field` (the scroll target, §5.4).
- Children still receive `{ id, describedBy, invalid }`; `describedBy` is `noteDescribedBy(...)` joined with the field's persistent description ids, if any.
- `FormField` keeps its API and inherits the slot. `TokenField` drops its extra grid and its `Unverifiable` block; it passes `warning` to the shell. `ValueField` inherits the slot.
- **Control edges:** `Input`, `Textarea`, the `Select` trigger, the `AgentCombobox`/`Combobox` trigger and the `MarkdownEditor` frame transition `border-color` on the note's pair, 150ms into the invalid state and 100ms out of it on `--ease-out` (one shared class, `field-edge-transition`), so the edge and the note arrive and leave together (today: Tailwind's default ease, no transition, and `--ease-out`).
- **`MarkdownEditor`:** gains `invalid`, which draws the frame's crimson edge (the textarea itself is `border-0`) and sets `aria-invalid` on the textarea. While `invalid`, a submit switches the editor to Write (its `view` becomes controlled by the form for that), because Preview unmounts the textarea and there would be nothing to focus.

### 5.3 Composite fields

- **`LinkEditor`:** each row is a grid. Wide: `kind target title remove` on one line, the row's `FieldNote` under it spanning all columns. Below `md`: areas `"kind target remove" "note note note" "title title title"`, so the target's error sits under the target, not under the title (it is today a `flex-wrap` with the title `max-md:order-last`). The target input is described by its row's note. Links is a plain `fieldset` with a legend and no field note (it would always be empty): a server `links` error goes to the first row's note when there are rows, else to the form's `FormOutcome`. `links` is not a single check string: the form keeps `checkedRows`, the set of row ids that were blurred or present at the last submit, and derives each row's message from `checkLink` for rows in that set while `links` is flagged (`checks.links` returns the first row message, for `submit`). A row added later is checked once it is blurred or on the next submit. The evidence pass checks that rows still read as one list at 390px; if they don't, this becomes a question for Or, not a silent change.
- **`ProjectGrantPicker`:** becomes `FieldShell legend` named Projects; the "Custom / From the template" marker stays in the legend and stays in its `describedBy`; its hand-rolled error paragraph is deleted.
- **`TemplateField`:** becomes `FieldShell` with `action` (New template) and `below` (the summary). "No templates yet." and "No template is ready…" render as the control. Its hand-rolled error paragraph is deleted.
- **`DependencyEditor`:** input then note; no badges in the form (Q19). The lookup result is the note's help: "Depends on T-41 and T-52.", "Depends on T-41, T-44 and 3 more." (keys only, at most two listed, one line), or the static help "Task keys, like T-41." when empty. Task detail keeps its status badges, which are its content.

### 5.4 `useFieldErrors` and `focusField` (new, `components/forms/`)

One small hook per form; no form library (Q7).

```ts
const f = useFieldErrors<Field>({
  form,      // RefObject<HTMLElement>: the form root, for focus
  checks,    // Partial<Record<Field, () => string | undefined>>, synchronous, reading current values
});
f.errors                     // Partial<Record<Field, string>>: what to render
f.attempt                    // number: bumped by a failing submit(), a server() that mapped a field, and set(..., { focus: true }) with a message (opens disclosures, §6.5)
f.change(field)              // from onChange, after the value update
f.blur(field, event)         // from onBlur
f.set(field, message, opts?) // one async or derived result; { focus: true } after a submit
f.server(fields): boolean    // a 400's `fields` map; true when any key is one of this form's fields (else the form shows its outcome)
f.submit(fields?): boolean   // runs the checks for `fields` (default all); false and a focus request on any error
f.reset()                    // Discard, reload
```

State: `flagged: Set<Field>` (fields a check failed for), `external: Partial<Record<Field, string>>` (async and server messages, mirrored in a ref so `submit` reads what `set` wrote in the same tick), `changed: Set<Field>` (since mount, never stored in a draft; separate from New agent's `touched`), `focus: number` (requests).

Rules (Q1, Q10):

- **Render.** `errors[f]` = `external[f]` ?? (`flagged.has(f)` ? `checks[f]()` : undefined), computed from current values, so a shown message always matches what is typed (D4). A flagged field whose check now passes is unflagged in the same render (render-time state adjustment), so breaking it again while typing does not re-flag it.
- **`change(f)`:** adds `f` to `changed`; deletes `external[f]`. Never flags.
- **`blur(f, e)`:** flags `f` when its check fails and (`changed.has(f)` or `f` shows an error), unless focus is leaving the document (`!document.hasFocus()` after the event: a window or tab switch to copy a token) or `event.relatedTarget` is inside an element marked `data-skip-validate` (Close, Discard, the MoreOptions toggle, a field's own `action` button such as New template or Add credential). When `relatedTarget` is null (WebKit doesn't focus a clicked button), the hook uses the target of the last capture-phase `pointerdown` in the document instead. Both checks live only in the hook; forms add the attribute, never their own conditions. A control that opens a list in a portal (Select, Combobox) calls `f.blur` when its list closes, not when its trigger blurs on opening (`TemplateField`'s existing pattern), so opening the list never validates.
- **`submit(fields)`:** flags every failing field in `fields`; any `external` error in `fields` also fails; fields outside `fields` are unflagged and their `external` messages dropped, so a subset save never leaves an unrelated error on screen. Returns false, requests focus and bumps `attempt` when anything fails.
- **`server(fields)`:** writes the mapped messages to `external`; when any mapped, requests focus and bumps `attempt` and returns true.
- **`set(f, m, { focus })`:** writes `external[f]`; with `focus: true` and a message, requests focus and bumps `attempt`. A call during render (the schedule form's stale target) writes only when the message differs, so it cannot loop.
- **Focus.** A `useLayoutEffect` on the focus request calls `focusField(form.current)` after the commit that rendered the errors. Disclosures open in that same commit (§6.5), and forms that disable their fieldset while pending set `pending` false in the same update as `f.server(...)`, so the field exists and is enabled. All `flushSync`, `queueMicrotask`, `wantFocus` refs and `toFocus` effects are deleted.

`focusField(root)`: the first `[aria-invalid="true"]` in DOM order that is focusable and not inside a disabled fieldset (for a `legend` field, its first focusable control); calls `focus({ preventScroll: true })`, then `closest("[data-field]").scrollIntoView({ block: "nearest" })`, instantly, so the label, the control and the note are all in view, also above a phone keyboard. Replaces `focusFirstInvalid` (deleted from `auth-card.tsx`).

### 5.5 `FormOutcome` (new, `components/forms/form-outcome.tsx`)

The form-level line (Q5, Q12, Q18): one always-mounted line directly above the buttons, full width, starting at the form's left edge like the field notes, never inside a scroll region.

- **Content, in priority order:** the form-level error; a success ("Saved."); a quiet notice (Edit agent's restart notice; task detail editors' hint; New agent's "Installing plugins…"). An error replaces the notice while it shows; the notice returns when the error clears (Q5, certainty 3). Pending is not shown in the line, because the submit button already shows "Creating…"; it goes to an sr-only `role="status"` in `FormOutcome`, and the other sr-only pending spans (`FormFrame`, `InlineForm`, the agent sheets, `SheetFormFooter`'s body siblings) are deleted.
- **Live regions:** two always-mounted, always-visible regions stacked in one grid cell (`min-height: 1lh`, note type on the cell): `role="alert"` for the error and `role="status"` for success. A role never changes at runtime (Q12), and neither region, nor any ancestor, ever transitions `visibility`. Each outcome's text is inserted fresh, keyed by `outcomeKey`, a counter the form bumps every time it sets an outcome (any failure, network or server, and each "Saved."), so a second identical failure is announced again; it fades in with `@starting-style { opacity: 0 }` and `transition: opacity 150ms var(--ease-out)` and leaves at once (it unmounts). The notice is a plain muted paragraph in the same cell, with the `field-note` swap.
- **Clearing:** the error clears on the next submit or Discard; "Saved." clears on the next edit, never on a timer.
- **Placement and spacing** (Q18), so the reserved line costs little at rest:
  - `SheetFormFooter`: the line is the footer's first row; the footer's top padding becomes 8px (was 16px), with 4px from the line to the buttons, so the footer grows by 8 + 18 + 4 − 16 = 14px (not 26px). Desktop and phone alike (the phone's stacked buttons follow the line).
  - `FormFrame` (sheet): the same, through `SheetFormFooter`'s layout. `FormFrame` (inline) and `InlineForm`: the line follows the last field's note at 4px, the buttons 8px below it.
  - `AuthCard`: the line follows the last field's note at 4px, the submit 8px below.
  - `ConfirmDialog`: the line moves out of the scrolling middle and `DrawerBody` into the top of the footer band, above the actions, with the band's top padding cut to 8px and 4px to the actions; the dialog grows by about 14px at rest, measured in the evidence pass.
  - Factory settings: the line sits above Save, following the last field's note at 4px; "Saved." moves into it, nothing stays beside Save.
- **Copy:** client form-level messages are at most 40 characters (§8); a server-provided `err.message` is shown as is and may wrap (exception (d)). New agent's plugin failure shows a "Show output" button in the line that opens the existing `showOutput()` dialog (`features/agents/show-output.tsx`); the `<details>` with a `pre` never sits in the line.
- **API:** `SheetFormFooter`, `FormFrame`, `InlineForm` and `AuthCard` take a required `outcome: { error?: ReactNode; success?: ReactNode; notice?: ReactNode; outcomeKey: number; action?: ReactNode }` (the line is always rendered; a form with nothing to say passes `{ outcomeKey: 0 }`); `above`, `formError` and `note` are deleted. While a notice shows, the submit's `aria-describedby` names it, as `above` does today. ConfirmDialog and `EditorButtons` keep their own counter; they don't use the hook. `InlineOutcome` stays for its other uses (Undo, `focusKey`), unchanged.

### 5.6 `field-stack`

One class in `styles.css` for every form body, replacing per-form `gap-4`/`gap-5`: `display: grid; row-gap: 0.75rem; align-content: start; min-width: 0`. A field without help then ends 4 + 18 + 12 = 34px above the next label (today 16–20px); with help, its note is 4px under its own control and 12px above the next label (today 40–44px), so a field's parts group and fields separate (2:1 against the 6px label gap). The note's 18px line puts these off the 4px grid; §10's Layout amendment records that exception. MoreOptions' inner content, sheet bodies, the auth column, inline forms and the factory form all use it. The evidence pass checks at 390px that neighbouring checkbox and switch rows don't run together; if they do, the row gap grows, never the note line (Q13).

## 6. Behaviour details

### 6.1 Motion
- Field notes: 150ms in, 100ms out on `--ease-out`, opacity with `visibility` flipping at the ends (Q17). Form outcomes: 150ms in, out at once (§5.5). Control edges: `border-color` on the same pair (150ms in, 100ms out).
- All notes changed by one submit swap together, never staggered. Focus moves in the layout effect and never waits for a fade.
- Under reduced motion the fades stay (DESIGN.md; Q14).
- Keyboard: the swap is state feedback inside a field, not a keyboard-initiated transition, so a Tab-triggered error fades like a clicked one (Q15). Inside an overlay opened from the keyboard, `data-instant` zeroes every transition for that opening, notes included; that is the existing rule and stays.
- Disclosures a submit opens (MoreOptions, the Address line) appear instantly: MoreOptions already stamps `data-instant` on a programmatic open (`more-options.tsx`).

### 6.2 Async checks
- **Dependency lookup:** on blur, the result sets the note's help (§5.3) or `f.set("dependsOn", error)`. On submit the form awaits the lookup, calls `f.set("dependsOn", error)`, then `f.submit()`, which sees the error through the ref and focuses. A failed lookup on submit keeps today's form-level "Couldn't create the task. Try again." (now in `FormOutcome`); on blur it shows nothing.
- **Credential verification** (a 422 after submit): rejection → `f.set(field, message, { focus: true })`; unverifiable → the note's warning (§6.4).
- **New agent's taken slug and every server 400:** `f.server(fields)`; when it returns false the form shows the message in `FormOutcome`.

### 6.3 Stale references
Agent and schedule forms show "That agent has ended; pick another." (or "No such agent; pick another.", replacing `There is no agent @${slug}.`) when a restored draft or a link points at an ended or unknown agent: agent sheets as the field's help (as today), task and schedule forms through `f.set` (task form in its existing effect, schedule form during render, guarded as in §5.4).

### 6.4 `TokenField` warning
An unverifiable verdict (`credential_unverifiable`) is not an error: `aria-invalid` stays false and the note shows it in warning tone. It arrives after a submit whose create failed (a 422). The form keeps it in its own state (`warning`), clears it on the next edit of the token or the next submit, and shows the server message in the ochre note; its `FormOutcome` error says "Couldn't add the credential." (Replace token: "Couldn't replace the token."), which is what announces it. `Unverifiable`'s separate `role=alert` block is deleted.

### 6.5 Disclosures
A submit that finds an error in a hidden field opens it in the commit that renders the errors, then focus moves there. This moves what is below it once: exception (c) (Q16).
- **Task form:** `moreOpen = userOpen ?? derived`; when `f.attempt` changes and `dependsOn` or `links` has an error, `userOpen` resets to `undefined` (adjusted during render), so a fold the user made is overridden by a failing submit.
- **New agent:** `f.attempt` is appended to `autoKey` while an inner field has an error, so More options reopens on every failing submit, not once per reason.
- **New template:** when `checks.name()` fails on submit, the handler calls `update({ revealed: true, name: <the derived name> })` in the same event as `f.submit` (as today's code passes the derived name), so Name exists at commit with its value.
- **New agent's Address line** opens into the Slug input when the slug has an error (existing state-during-render).

## 7. Forms after I4

Each form keeps its values and checks and drops its own error machinery.

- **sign-in, sign-up:** `useFieldErrors` with the Zod schemas split into per-field checks; blur now validates changed fields (DESIGN.md's auth special case goes); `AuthCard` takes `outcome`.
- **task form:** checks title, body, links (one field; row messages derived from it), dependsOn via `f.set`; `MarkdownEditor invalid`; outcome in `SheetFormFooter`.
- **task detail editors:** title, dependencies and links each use `useFieldErrors` with a `FieldNote` under the control (the title's validation moves from the failed line into its note); `EditorButtons`' `FormOutcome` holds the hint (notice) and the save failure.
- **schedule form:** checks target, cron, at, timezone, body; edit passes the changed fields to `submit`; outcome in `SheetFormFooter`.
- **agent form-state:** owns one `useFieldErrors` (both modes check every field, as today); its body `InlineOutcome` and the `above` notice move to the footer `FormOutcome`.
- **new template form, add credential/project/secret forms:** through `FormFrame`'s `outcome`.
- **settings row forms** (Replace token, Update value, Change path): through `InlineForm`'s `outcome`; Replace token and Update value now also validate on blur of a changed field.
- **factory settings:** blur validates changed fields only (today every blur); `FormOutcome` above Save.
- **compact popover:** `FieldNote` under its field and `FormOutcome` above its buttons.
- **ConfirmDialog:** `FormOutcome` above the actions, outside the scroll region.

## 8. Copy

Every field message and every client form-level message:

- **fits one line** in the narrowest note column at 390px: at most 40 characters (the Slug field, inset by the avatar, is about 290px of text at 13px);
- **never interpolates a user value**, because the value is already in the control: "No folder at this path.", "Another project uses this folder.", "That agent has ended; pick another." (`@${slug} has ended; pick another.` can run to 65 characters);
- **names the one rule that failed**, so it never depends on the help it replaces: names (`packages/shared/src/names.ts`: `nameSchema` 2–40, `slugSchema` 3–40) split into "Start with a letter.", "Use 2 to 40 characters." / "Use 3 to 40 characters." (per schema), "Use only a–z, 0–9 and hyphens.", "Don't end with a hyphen." (Zod `.min`/`.max`/`.regex` with their own messages); help keeps the summary for the clean state.

The credential rejection is our own server copy (`verify.ts`), not third-party text: the error becomes "Claude rejected this token." and the OAuth `TokenField` gets permanent help "Create one with `claude setup-token`.". "Couldn't reach Claude to verify. Try again." becomes "Couldn't reach Claude. Try again.". Client form-level messages are shortened the same way ("Couldn't create the agent. Check that the server is running, then try again." → "Couldn't reach the server. Try again."). Shared messages also reach MCP and CLI callers, who see the same specific, short text.

Mechanism: shared Zod messages and server `FieldError` messages become exported constants, each package tests their length (≤ 40); a web test does the same for the web checks' constants; a grep test fails on a template literal passed to `FieldError` or `f.set`. The plan lists every current message over 40 characters (grep of `apps/web/src`, `packages/shared/src`, `apps/server/src`) with its rewrite. The evidence pass asserts that every rendered note at 390px and 100% text is one line tall.

## 9. Testing

- **Unit, `useFieldErrors`:** blur on an untouched field stays clean; blur on a changed field flags; blur to `data-skip-validate` or out of the document doesn't; re-check while flagged updates the message, a pass unflags, breaking it again while typing doesn't re-flag; `change` clears external; `submit` subsets unflag the rest; `submit` fails on an external error set in the same tick; `set(..., { focus })`; `server` returns whether anything mapped; focus after commit for a field that mounts in that commit and for a fieldset re-enabled in the same update; `attempt` increments.
- **Unit, `FieldNote`:** both layers mounted; hidden layer `visibility: hidden`; `noteDescribedBy`; last error kept; warning tone without `aria-invalid`; text wraps (`overflow-wrap: anywhere`).
- **Unit, `FormOutcome`:** regions always mounted and never visibility-transitioned; a repeated identical error re-inserts its text; notice replaced by the error and restored; "Saved." cleared by an edit; pending only in the sr-only status.
- **Component:** each form's existing error tests updated to the new timing and copy, plus one test per form that submit focuses the first invalid field (sync, async and server), and the disclosure cases of §6.5.
- **UI contract (`test/ui-contract.test.ts`):** AC6's scan; the `field-note` class transitions only `opacity` and `visibility`, 150ms shown and 100ms hidden, on `--ease-out`; `field-note` sets its own font size and line height; `field-edge-transition` on every control primitive.
- **Copy:** AC7's length and template-literal tests.

## 10. DESIGN.md amendments

- **Components → Inputs:** "Errors appear inline below the field in crimson with an icon." → "Every field reserves one note line under its control, for its help text or nothing. An error takes that line, with the alert icon, in crimson, and the control's edge turns crimson; never colour alone. Nothing below moves. The note wraps, breaking anywhere when it must; it never truncates."
- **Components → Validation** (rewritten): "Every form validates a field when you leave it, if you changed it, and everything on submit, never while you type. Leaving the window or pressing Close doesn't count as leaving the field. While a field shows an error, each keystroke re-checks it: the fix clears it at once and the message always matches what is typed. Submit moves focus to the first invalid field and scrolls the whole field, its message included, into view. A form's own outcome (Couldn't save, Saved) sits on one reserved line directly above its buttons, outside any scrolling region; it takes its height from the space above the buttons. Error copy follows three rules: at most 40 characters, so it fits one line in the narrowest form column on a phone; one message per rule, naming the rule that failed, so it never needs the help text it replaces; never a value the user typed, which is already in the control. The help text keeps the summary."
- **Motion → Durations:** add "A field's note swaps in place: the new text fades in over 150ms and the old fades out over 100ms on `--ease-out`, opacity only (visibility flips at the ends). A form's outcome line fades in over 150ms and leaves at once. A control's invalid edge changes colour on the same pair."
- **Motion → Frequency decides:** add "In-field feedback such as a note swap is not a keyboard-initiated transition: a Tab-triggered error fades like a clicked one. Inside an overlay opened from the keyboard everything is instant for that opening, notes included."
- **Do's and Don'ts:** "Don't animate anything triggered from the keyboard" gains "(in-field feedback excepted, see Motion)".
- **Layout:** "Form fields stack in `field-stack`, 12px apart, so a field's note sits twice as far from the next label as a label from its control; each field's reserved note line provides the rest of the rhythm. A form's outcome line follows the last field's note at 4px. The 18px note line is the one exception to the 4px grid. If adjacent fields read as one group, raise the gap between fields, never the note line."

## 11. Evidence pass (manual, the plan's last tasks)

Using `docs/product/ui-review/u4-evidence/harness` (main checkout) with its `run.sh` lock, fake Claude only, never real agents. One evidence pass or full test suite at a time on this machine.

- **Forms:** every form in §4, Chromium and WebKit headless.
- **Sizes:** 1440×900 and 390×844 at 100% text; 200% text by doubling the browser's default font size (not page zoom, which also changes the viewport) at 1920×1080 (desktop sheet and centred dialog) and at 390×844 (drawer); 320×568 at 100% for copy.
- **Per form:** record every element's bounding box; blur a changed field into an error; record; fix it; record; submit empty; record; assert equality except §2's exceptions; screenshot each state.
- **Also:** every rendered note at 390px and 100% text is one line tall; after a failing submit the focused field's note is inside its scroll container's visible rect; ConfirmDialog with a long body at 200% shows its error without scrolling; link rows read as one list at 390px; checkbox and switch rows don't run together.
- **Recordings:** the factory warm-window field going help → error → help at 0.25× speed in both browsers (no frame of legible overlapping text); a submit with Enter, scrubbed to the frame focus lands (ring at once, note and edge together).
- **VoiceOver + Safari:** a FormOutcome failure is announced once, and again on an identical second failure.

## 12. Decisions

Q1–Q19 with the proxy's answers and certainty are in the decision issue. Tech-lead decisions:

- **D1** The note's two layers are stacked in one grid cell rather than one paragraph whose text swaps, because the cell then holds the taller one's height (a three-line help replaced by a one-line error would otherwise shrink the slot). The stacking is needed for stability even without a fade, so the fade costs only the transition declarations (Q15's "drop the fade if it adds real code" does not apply).
- **D2** The last error text stays in the hidden layer after a fix rather than clearing, because clearing would shrink a two-line slot.
- **D3** `visibility` transitions with opacity on field notes rather than `aria-hidden` alone, because a hidden note must leave the accessibility tree and hit testing; `aria-describedby` names only the visible note.
- **D4** Errors are computed during render from flagged fields and current values, rather than stored strings, so a message can never be stale relative to the input.
- **D5** Focus after commit in one layout effect in the hook, rather than each form's `flushSync`/microtask/effect, because it is the one point where the invalid field is guaranteed to exist and be enabled.
- **D6** Focus with `preventScroll` then scroll the field root into view, rather than plain `focus()`, because plain focus scrolls only the control and leaves its note below the fold (Apple, Emil, Break UI).
- **D7** `FormOutcome`'s live regions are never visibility-transitioned and each outcome is inserted fresh, rather than reusing the field note's layers, because a live region whose text is present but hidden, or unchanged on a repeat, is announced unreliably (Motion, self-review).
- **D8** Pending is sr-only rather than a visible line, because the submit button already shows the pending label.
- **D9** Async errors live in a ref-mirrored `external` map that `submit` reads, rather than only in state, so a result set in the same tick blocks the submit and gets focus (self-review B1).
- **D10** Disclosures reopen on every failing submit through `f.attempt`, rather than once per reason, because a user's fold would otherwise hide the field focus must reach (self-review B2).
- **D11** Blur ignores focus leaving the document and `data-skip-validate` targets, rather than validating every blur, so going to copy a token or pressing Close never paints a half-typed field red (Emil).
- **D12** Copy limits are tests on exported constants plus a template-literal ban, rather than review, so later forms (I2, I3) keep to them.
- **D13** Control edges share the note's 150ms-in/100ms-out pair rather than three different timings, so the edge and the note arrive as one state change.
- **D14** `LinkEditor` rows use grid areas rather than `flex-wrap` + `order`, so a row's note sits under the input it describes at every width.
