# I4 Field errors: Technical Design

- **Date:** 2026-11-23
- **Status:** draft, before reviews. Owner-proxy (owner-i4) answered Q1–Q16. Low certainty, for Or: Q5's restart-notice sharing (3), Q6 crossfade timing (3), Q15 fade vs instant swap for keyboard-triggered errors (3).
- **Source of truth (gitignored, read from the main checkout):** `docs/product/roadmap/v0.0.2/i4-field-errors.md` (the task), `docs/product/roadmap/v0.0.2/scope.md`, `docs/product/roadmap/v0.0.2/index.md` (I4 lands first; I2, I3 and later forms build on it), `docs/product/decisions/0028-pre-release-no-compatibility.md`, `docs/product/ui-review/decisions.md`.
- **Builds on:** `main` at 64d0edc (U1–U4 merged: `FieldShell`, `FormField`, `FormFrame`, `InlineForm`, `SheetFormFooter`, `InlineOutcome`, `MoreOptions`, the adaptive `ConfirmDialog`).
- **Decision log:** GitHub issue "I4: Field errors — design". Q1–Q16 are the proxy's answers; D1–D… are tech-lead decisions (§12).

> `docs/product/` is gitignored. Paths into it are relative to the main checkout. Web paths are relative to `apps/web/src/` unless they start with `apps/` or `packages/`.

## 1. Goal

A validation error appears where the eyes already are and moves nothing. Today `FieldShell` inserts the error paragraph under the control on demand, so every field below jumps by a line; the form-level error (a conditional `<p role="alert">` or an `empty:hidden` div) jumps the buttons too. Each of seven forms re-implements error state, blur validation, clear-on-edit and focus-first-invalid, so the behaviour has drifted (some focus before the error renders, some through `flushSync`, some in an effect, some in a microtask).

After I4:

1. Every field reserves its one note line, always. Help text and errors share it and crossfade.
2. Every form-level outcome (error, and success where the form has one) has one reserved line directly above the footer buttons.
3. One hook owns validation timing and focus, and every form uses it.

## 2. Acceptance criteria

Default CI (`pnpm test`, `pnpm typecheck`, `pnpm lint`) unless marked manual (the headless evidence pass, §11).

1. **Nothing moves.** In every form in §4, triggering an error (blur and submit) and fixing it leaves the bounding box of every element in the form (fields, MoreOptions header, footer buttons) unchanged, at 1440×900 and 390×844, in Chromium and WebKit headless (manual, scripted with `getBoundingClientRect` before/after). Exceptions, stated and measured as exceptions: (a) at 200% text an error that wraps to two lines where the help was one pushes what is below (nothing clips or truncates); (b) content the user asked for (the dependency editor's resolved badges, a template summary) may push; (c) a submit that finds an error inside a folded MoreOptions or the closed Address line opens it (§6.5); (d) third-party text (Claude's credential rejection) may wrap at 100% text.
2. **Timing.** A field shows an error on blur only if the user changed it in this form session (or it already shows one); never while typing; on submit every relevant field is checked. While an error shows, each keystroke re-runs the field's synchronous check: valid clears it at once, still-invalid updates the message. Server and async errors clear on any edit of their field (unit tests on the hook, component tests per form).
3. **Focus.** Submitting a form with errors focuses the first invalid field in DOM order after the errors have rendered, including a field inside a MoreOptions that the submit opened and after a server 400 re-enables the fieldset (tests per form).
4. **Signals.** An invalid control has `aria-invalid="true"`, the crimson `field-edge`, and the slot shows the alert icon plus text. `aria-describedby` names exactly the visible note (the error while there is one, else the help). The hidden note is `visibility: hidden` once its fade ends, so it is not read (tests on `FieldShell`).
5. **Announcements.** A blur error is not announced live; it is read when focus returns to the field (describedby). The form-level outcome line is always mounted, so its error is announced once when it appears (`role="alert"`) and a success through `role="status"` (tests).
6. **One mechanism.** No error paragraph is rendered outside `FieldNote` and `FormOutcome`: a UI-contract test fails on `text-destructive` paragraphs with `CircleAlert` in `features/**` form files, on `empty:hidden` alert lines, and on conditional `role="alert"` form errors (`test/ui-contract.test.ts`).
7. **Copy.** Every client-side field message and every server field message (`FieldError` and shared Zod messages that reach a field) is at most 48 characters (a test enumerates the shared schema messages and the web check functions' messages where they are constants; manual review at 390px for the rest).
8. **Motion.** The swap is an opacity crossfade of 150ms on `--ease-out`, both directions, CSS transition, no movement (manual; a unit test asserts the class contract).

## 3. Scope

**In:** `FieldShell` and its slot (`FieldNote`), `FormField`, `TokenField`, `ValueField`; `FormFrame`, `InlineForm`, `SheetFormFooter`, `AuthCard`, `ConfirmDialog` outcome lines; the `useFieldErrors` hook and `focusFirstInvalid`; every form in §4 migrated onto them; the four hand-rolled field-error renderers deleted; error copy shortened; DESIGN.md amended (§10).

**Out:** form libraries (none added); new validation rules; the credentials row's "Last check failed" status line (a stored row status, not a form error; Q11); session composer error lines (not forms); `ErrorLine` load failures with Retry (page states, not forms).

**Breaking (ADR 0028):** `FieldShell` always renders its note line; `focusFirstInvalid` moves out of `auth-card.tsx`; every form's local error state, blur handlers, clear-on-edit and focus code is deleted, not wrapped. No compatibility props.

## 4. Inventory

Every form and field that shows a validation error today, what it does now, and what changes.

| Where | Fields today | Timing today | Form-level error today | Focus today |
|---|---|---|---|---|
| `routes/sign-in.tsx` | `FormField` email, password | submit only; any edit clears | `AuthCard` conditional `<p role=alert>` above submit | `flushSync` + `focusFirstInvalid` |
| `routes/sign-up.tsx` | `FormField` name, handle (`@` prefix, help), email, password (help) | submit only; any edit clears | same | same |
| `features/tasks/task-form.tsx` (New task sheet) | `FormField` title; `FieldShell` assignee (`AgentCombobox`, help), description (`MarkdownEditor`, no `aria-invalid`); `DependencyEditor`; `LinkEditor` rows; a separate links `<p>` | blur + submit; async dependency lookup; any edit clears | conditional `<p role=alert>` "Couldn't create the task. Try again." in the body | `flushSync`, then `querySelector`; server 400 in `queueMicrotask` |
| `features/tasks/dependency-editor.tsx` | `FieldShell` with help; resolved badges render between input and note | parent's | — | — |
| `features/tasks/link-editor.tsx` | hand-rolled per-row `<p>` with `CircleAlert`, conditional | blur per row | — | parent queries `[aria-invalid]` |
| `features/tasks/task-detail.tsx` inline editors (title, description, dependencies, links, assignee) | `Input` with `aria-invalid`; `EditorButtons` shows a hint `<p>` and a conditional failed `<p role=alert>` above Save | submit (Save); any edit clears | the same conditional line | none |
| `features/schedules/schedule-form.tsx` (New/Edit schedule sheets) | `FieldShell` target (help), timezone (help), body (help); `WhenField` → `RepeatsField` (cron) / `FieldShell` at | blur + submit; edit checks changed fields only | conditional `<p role=alert>` "Couldn't save the schedule. Try again." | `setToFocus` + effect |
| `features/schedules/edit-schedule-sheet.tsx` | — | — | conditional `<p role=alert>` for Pause/Delete failures | — |
| `features/agents/agent-form-state.ts` + `new-agent-sheet.tsx`, `edit-agent-sheet.tsx` | `TemplateField` (hand-rolled error `<p>`, summary below), `FormField` displayName, `AddressLine` → `FormField` slug (help), `FieldShell` reportsTo (help = stale note), description, credential (help = stale note), `ProjectGrantPicker` (hand-rolled fieldset error) | blur + submit; any edit clears | `InlineOutcome` in the body below the fields; Edit agent's restart notice in `SheetFormFooter`'s `above` row | `wantFocus` ref + effect on `[pending, errors]` |
| `features/templates/new-template-form.tsx` (sheet via `FormFrame`) | `FormField` displayName, name (help), `FieldShell` description | blur + submit | `FormFrame` `formError` (`empty:hidden` alert in the body) | `flushSync` + `querySelector` |
| `features/settings/forms/add-credential-form.tsx` | `FormField` name, `FieldShell` kind (legend), `TokenField` (verdict error or warning) | blur + submit | `FormFrame` | `getElementById` before render |
| `features/settings/forms/add-project-form.tsx`, `add-secret-form.tsx` | `FormField` name, path / `ValueField` | blur + submit | `FormFrame` | `getElementById` before render |
| `features/settings/credentials-section.tsx` (Replace token), `secrets-section.tsx` (Update value), `projects-section.tsx` (Change path) | `TokenField`, `ValueField`, `FormField` | submit (projects: blur too) | `InlineForm` `formError` (`empty:hidden` alert above the buttons) | `getElementById` |
| `features/settings/factory-section.tsx` | `FieldShell` number fields (help) | blur + submit (changed only) | `InlineOutcome` beside Save ("Saved." / "Couldn't save. Try again.") | `querySelector`, `flushSync` for 400 |
| `components/confirm-dialog.tsx` | — | — | `empty:hidden` alert line above the actions | — |

`TokenField` also renders a warning line (`Unverifiable`, `TriangleAlert`) in a second `role=alert` below the field; it moves into the same note slot (§6.4).

## 5. Components

### 5.1 `FieldNote` (new, `components/field-note.tsx`)

The reserved line. Used by `FieldShell` and by each `LinkEditor` row (a note under something that isn't a single labelled field).

```tsx
<FieldNote id={baseId} help={help} error={error} tone="error" | "warning" />
```

- Renders a `div.grid` with `min-height: 1lh` at the note type (13px / 18px line), so the empty line is exactly one line tall at any text size. The help `<p id={baseId-help}>` and the error `<p id={baseId-error}>` both stay mounted, stacked in the same grid cell (`grid-area: 1/1`), so the slot is as tall as the taller of the two and neither crossfade direction changes its height.
- The visible one has `opacity: 1; visibility: visible`; the other `opacity: 0; visibility: hidden`. Transition: `opacity 150ms var(--ease-out), visibility 150ms var(--ease-out)` (visibility flips at the end of a fade-out and at the start of a fade-in, so a hidden note is never read or hit-tested). Class `field-note` in `styles.css`.
- The error paragraph keeps the last message after the error clears (render-time adjusted state: `if (error && error !== last) setLast(error)`), so the fade-out shows the text that was there and the slot keeps its height. An error replaced by a different error swaps text in place, no fade (Q6).
- Error: `CircleAlert` 14px + text in crimson. Warning (`tone="warning"`, `TokenField` only): `TriangleAlert` in ochre + text in ink.
- Long text wraps; never `truncate`, `line-clamp` or `overflow: hidden`.
- Returns `describedBy`: the error id while there is an error, else the help id when there is help, else `undefined` (an empty slot describes nothing).

### 5.2 `FieldShell` (changed)

- Always renders `FieldNote` under the control (both in the `label` and the `legend` form). No prop turns it off (Q2).
- Order inside: label row (with `action`), control, note, then a new `below` slot for requested content (the dependency badges, the template summary) (Q4).
- Spacing: label → control 6px, control → note 4px (the note's own line height gives the rest). Fields stack in a `field-stack` container (§5.6).
- Children still receive `{ id, describedBy, invalid }`. `MarkdownEditor` gains `aria-invalid` passthrough so the description fields are marked.

`FormField` keeps its API and inherits the slot. `TokenField` stops wrapping `FieldShell` in an extra grid and passes `warning` into the shell's note (`tone="warning"` when there is no error). `ValueField` is unchanged apart from inheriting the slot.

### 5.3 Composite fields

- **`LinkEditor`:** each row is `[kind][target][title][remove]` then a `FieldNote` for that row (no help). The target input is described by the row's note. The task form's separate "links" paragraph is deleted; a server `links` error lands on the first row's note, or, with no rows, on the Links fieldset's note (the fieldset uses `FieldShell legend`).
- **`ProjectGrantPicker`:** becomes `FieldShell legend` named Projects; the "Custom / From the template" marker stays in the legend; its hand-rolled error paragraph is deleted.
- **`TemplateField`:** becomes `FieldShell` with `action` (New template) and `below` (the summary). The "No templates yet." / "No template is ready" states render as the control. Its hand-rolled error paragraph is deleted.
- **`DependencyEditor`:** input, note, then `below` = resolved badges.
- **Task detail `EditorButtons`:** the hint and the save failure share one `FormOutcome` line above Save/Cancel (hint = notice, failure = error), so the failure is announced once and the hint returns when it clears.

### 5.4 `useFieldErrors` (new, `components/forms/use-field-errors.ts`)

One small hook per form; no form library (Q7).

```ts
const f = useFieldErrors<Field>({
  form,                       // RefObject<HTMLFormElement | HTMLElement>
  checks,                     // Partial<Record<Field, () => string | undefined>>: synchronous, read current values
});
f.errors                      // Partial<Record<Field, string>>: what to render
f.change(field)               // call from onChange, after the value update
f.blur(field)                 // call from onBlur
f.set(field, message)         // async or server result for one field (dependency lookup, taken slug, credential verdict)
f.server(fields)              // a 400's `fields` map, mapped to this form's fields; requests focus
f.submit(fields?)             // runs the checks for `fields` (default: all); returns true when all pass; requests focus otherwise
f.reset()                     // Discard / reload
```

State: `client: Set<Field>` (fields flagged by a check), `external: Partial<Record<Field, string>>` (async and server messages), `changed: Set<Field>`, `focusRequest: number`.

Rules (Q1, Q10):

- `errors[f]` = `external[f]` ?? (`client.has(f)` ? `checks[f]()` : undefined), computed during render from current values. So a flagged field's message always matches what is typed (Q1a); when the check passes the field is unflagged in the same render (render-time state adjustment), so a later keystroke that breaks it again does not re-flag it while typing.
- `change(f)`: adds `f` to `changed`; deletes `external[f]` (any edit clears async and server errors). Never flags.
- `blur(f)`: flags `f` if its check fails and (`changed.has(f)` or it already shows an error). An untouched field tabbed past stays clean.
- `submit(fields)`: flags every failing field in `fields`, bumps `focusRequest` when any fails.
- Focus: a `useLayoutEffect` on `focusRequest` calls `focusFirstInvalid(form.current)` after the commit that rendered the errors. Forms derive MoreOptions' open state and the Address line's open state from `errors` in that same render (they already do), so the invalid field exists when the effect runs. A form that disables its fieldset while pending sets `pending` false in the same update as `f.server(...)`, so the field is enabled at commit. All `flushSync`, `queueMicrotask`, `wantFocus` refs and `toFocus` effects are deleted.
- Edit forms (schedule edit, factory settings, Edit agent) pass only the fields that changed to `submit`, as they do today.

`focusFirstInvalid(root)` moves to `components/forms/focus-first-invalid.ts`: the first `[aria-invalid="true"]` in DOM order that is focusable (not inside a `[disabled]` fieldset); for a fieldset (`legend` fields) its first focusable control.

### 5.5 `FormOutcome` (new, `components/forms/form-outcome.tsx`)

The form-level line (Q5, Q12): one always-mounted line, `min-height: 1lh`, full width, directly above the footer's button row, on every width.

- Holds, in priority order: the form-level error, a pending or success outcome, or a quiet notice (Edit agent's restart notice, muted). An error replaces the notice while it shows; the notice returns when the error clears (Q5, certainty 3).
- Two always-mounted live regions stacked in one grid cell: a `role="alert"` for the error and a `role="status"` for pending and success (Q12: a role never changes at runtime, because screen readers announce that unreliably). The notice is a plain muted paragraph in the same cell. Visually one line, with the same `field-note` crossfade as fields. Built from `InlineOutcome`'s two regions, which it already mounts this way.
- Used by `SheetFormFooter` (replacing its `above` row and every body-level failure paragraph or `InlineOutcome`), `FormFrame` (sheet and inline), `InlineForm`, `AuthCard`, `ConfirmDialog` (its `empty:hidden` line), the Factory settings page ("Saved." moves from beside Save into this line), task detail's `EditorButtons` (via the note in §5.3).
- Copy: "Couldn't create the task. Try again." and siblings stay one line at 390px (§8).

The submit's `aria-describedby` points at the notice when one shows (as `above` does today).

### 5.6 `field-stack`

One class in `styles.css`, used by every form body instead of per-form `gap-4` / `gap-5`: `display: grid; row-gap: 0.5rem; align-content: start`. With the reserved note, a field without help ends 4 + 18 + 8 = 30px above the next label (today 16–20px), a field with help ends at the same 30px (today 6 + 18 + 16/20 = 40–44px). MoreOptions' inner grid uses it too. The auth column, the sheet bodies, the settings inline forms and the factory form all switch. Verified at 390px in the evidence pass.

## 6. Behaviour details

### 6.1 Crossfade
150ms opacity, `--ease-out`, both directions (Q6). Runs under reduced motion (DESIGN.md: fades stay; Q14) and for keyboard-triggered blurs (state feedback, not a keyboard-driven layout transition; Q15). `data-instant` overlays already zero all transitions inside them; a sheet opened from the keyboard therefore swaps instantly for that opening, which is the existing rule and is accepted.

### 6.2 Async checks
- Dependency lookup: on blur `f.set("dependsOn", r?.error)` after `checkDependencies`; on submit the form awaits the lookup, then calls `f.set` and `f.submit`. A lookup that fails on submit keeps today's behaviour (the form-level "Couldn't create the task. Try again."), now in `FormOutcome`; on blur it shows nothing.
- Credential verification (`TokenField` verdict): rejection → `f.set(field, message)` (error); unverifiable → the note's warning tone.
- New agent's taken-slug and server field errors → `f.server`.

### 6.3 Stale references
The agent and schedule forms show "@x has ended; pick another." when a restored draft points at an ended agent. These stay what they are today: help-tone notes (agent sheets) or `external` errors set on render (task and schedule forms), now through `f.set`.

### 6.4 `TokenField` warning
An unverifiable verdict (the server's `credential_unverifiable` message) is not an error: `aria-invalid` stays false and the field's note shows it in warning tone in the same slot. It arrives after a submit (the verification turn), so it is announced: `FieldNote` takes `announce` for this one case and renders the warning paragraph inside an always-mounted `role="status"`. `Unverifiable`'s separate `role=alert` block below the field is deleted.

### 6.5 Disclosures
A submit that finds an error in a folded MoreOptions opens it in the render that shows the errors (existing derived state), then focus moves to the field. New agent's Address line opens into the Slug input on a slug error. Both move what is below them once; this is the accepted exception (c) in §2 (Q16).

## 7. Forms after I4

Each form keeps its values and checks and drops its own error machinery:

- **sign-in, sign-up:** `useFieldErrors` with the Zod schema split into per-field checks; blur now validates changed fields (DESIGN.md amended: no special case for auth forms); `AuthCard`'s `formError` through `FormOutcome`.
- **task form:** checks title, body, links rows (as one `links` field whose error lands per row through `rowErrors` derived from the hook's flagged set), dependsOn via `f.set`; failure through `SheetFormFooter`'s `FormOutcome`.
- **schedule form:** checks target, cron, at, timezone, body; edit passes changed fields; the Pause/Delete action failure in `edit-schedule-sheet.tsx` uses the footer `FormOutcome`.
- **agent form-state:** owns one `useFieldErrors`; `errors`, `blur`, `change` come from it; the body `InlineOutcome` moves to the footer `FormOutcome` with the restart notice.
- **new template form, add credential/project/secret forms:** `FormFrame` gives `FormOutcome`.
- **settings row forms:** `InlineForm` gives `FormOutcome`.
- **factory settings:** `FormOutcome` above Save holds "Saved." and the failure.
- **task detail inline editors:** `EditorButtons` outcome line (§5.3); the title editor's `aria-invalid` stays.
- **ConfirmDialog:** reserved `FormOutcome` line above the actions.

## 8. Copy

Every client message and every server message that lands in a field fits one line at 390px: at most 48 characters (a 358px sheet column at 13px, less the 20px icon). Rules move into help text. Examples:

| Now | After |
|---|---|
| "Use 2–40 lowercase letters, numbers and inner hyphens, starting with a letter." | error "Use lowercase letters, numbers and hyphens." with help "2–40 characters, starting with a letter." |
| "Shorten the message to 64 KB or less." | unchanged (37) |
| "A task can depend on at most 50 tasks." | unchanged |

The plan lists every message over 48 characters found by a grep of `apps/web/src`, `packages/shared/src` (Zod messages) and `apps/server/src` (`FieldError`), with its rewrite. Third-party text (Claude's credential rejection, passed through) wraps; it is never shortened or clipped.

## 9. Testing

- Unit: `useFieldErrors` (blur on untouched vs changed field, re-check while flagged, unflag on pass and no re-flag while typing, external cleared on change, submit subsets, focus after commit including a field that mounts in that commit and a fieldset re-enabled in the same update); `FieldNote` (both mounted, `visibility`, describedby, last error kept, warning tone); `FormOutcome` (always mounted, alert vs status, notice replaced by error and restored).
- Component: each form's existing error tests updated to the new timing (sign-in/up blur, untouched-field blur stays clean), plus one test per form that submit focuses the first invalid field.
- UI contract (`test/ui-contract.test.ts`): no hand-rolled field-error markup, no `empty:hidden` alert lines, `field-note` transition names `opacity` and `visibility` only.
- Evidence (manual, §11).

## 10. DESIGN.md amendments

- **Components → Inputs:** "Errors appear inline below the field in crimson with an icon." → "Every field reserves one note line under its control, for its help text or nothing. An error takes that line, with the alert icon, in crimson, and a crimson edge on the control; never colour alone. Nothing below moves."
- **Components → Validation** (rewritten): "Every form validates a field when you leave it, if you changed it, and everything on submit, never while you type. While a field shows an error, each keystroke re-checks it: the fix clears it at once and the message always matches what is typed. Submit moves focus to the first invalid field. A form's own outcome (Couldn't save, Saved) sits on one reserved line directly above its buttons. Error copy fits one line on a phone; rules go in the help text."
- **Motion → Durations:** add "A field's note and a form's outcome line crossfade over 150ms on `--ease-out` (opacity only), also under reduced motion (fades stay)."
- **Motion → Frequency decides:** add "In-field feedback such as a note swap is not a keyboard-initiated transition; it fades the same whatever caused it."
- **Layout:** "Form fields stack in `field-stack`, 8px apart; each field's reserved note line provides the rest of the rhythm. If adjacent fields read as one group (checkbox and switch rows), raise the gap between fields, never the note line."

## 11. Evidence pass (manual, plan's last tasks)

Using `docs/product/ui-review/u4-evidence/harness` (main checkout) with its `run.sh` lock, fake Claude only. For each form in §4, Chromium and WebKit headless, at 1440×900 and 390×844, and at 200% text: record every form element's bounding box, trigger a blur error, record, fix it, record, submit empty, record; assert equality except §2's exceptions; screenshot each state. One evidence pass or full test suite at a time on this machine.

## 12. Decisions

Q1–Q16 with the proxy's answers and certainty are in the decision issue. Tech-lead decisions:

- **D1** The note's two paragraphs are stacked in one grid cell rather than one paragraph whose text swaps, because the cell then holds the taller one's height (a three-line help replaced by a one-line error would otherwise shrink the slot). That stacking is needed for stability even without a fade, so the crossfade costs one `transition` declaration; this is why Q15's "instant swap if the fade adds real code" does not apply.
- **D2** The last error text stays in the hidden paragraph after a fix, rather than clearing, because clearing would shrink a two-line slot and shift at 200% text.
- **D3** `visibility` transitions with opacity rather than `aria-hidden` alone, because a hidden note must leave the accessibility tree and hit testing, and `aria-describedby` already names only the visible note.
- **D4** Errors are computed during render from flagged fields and current values, rather than stored strings, so a message can never be stale relative to the input.
- **D5** Focus after commit in one layout effect in the hook, rather than each form's `flushSync`/microtask/effect, because it is the one point where the invalid field is guaranteed to exist and be enabled.
