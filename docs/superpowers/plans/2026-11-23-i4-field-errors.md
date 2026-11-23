# I4 Field Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validation errors never move the layout. Every field reserves a note line, help and error swap in place, one hook owns validation timing and focus, and every form-level outcome sits on one reserved line above the buttons.

**Architecture:** There are four new primitives in `apps/web/src/components`:
- `FieldNote`: the reserved line, with stacked help and error layers.
- `useFieldErrors` plus `focusField`: timing, async and server errors, and focus after commit.
- `FormOutcome`: always-visible alert and status regions, plus a notice.
- Three CSS classes: `field-note`, `field-stack` and `field-edge-transition`.

`FieldShell`, `SheetFormFooter`, `FormFrame`, `InlineForm`, `AuthCard` and `ConfirmDialog` are rebuilt on them. Every form then drops its own error state, blur, clear-on-edit and focus code and uses the hook. Error copy becomes short exported constants in `packages/shared`, `apps/server` and `apps/web`, with length tests.

**Tech Stack:**
- TypeScript, pnpm 12.21.0 monorepo.
- `apps/web`: React 19, Vite, TanStack Router and Query, Tailwind 4.3 (`min-h-lh` exists).
- `apps/server`: Fastify.
- `packages/shared`: Zod.
- Tests: Vitest with Testing Library (jsdom). Lint: Biome.
- Playwright, for evidence only, through the harness outside the repo.
- No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-23-i4-field-errors-design.md`, on branch `spec/i4-field-errors`. Decision issue #131; follow-ups #132 and #133. Read the spec alongside this plan. §n refers to a spec section and AC n to an acceptance criterion.

## Global Constraints

- **Branch and worktree:** implementation runs on a new branch `i4/field-errors`, created from `origin/main` in a new worktree: `git fetch origin && git worktree add .worktrees/i4-field-errors -b i4/field-errors origin/main` (repo root). The spec and this plan live on `spec/i4-field-errors`; read them from `.worktrees/spec-i4` or cherry-pick them into the branch as the first commit (`git checkout spec/i4-field-errors -- docs/superpowers`).
- Every task that touches `apps/web` repeats this line: **Implementer and reviewer invoke `vercel-react-best-practices` and follow it.** The stack is React 19 with Vite and TanStack Router/Query, not Next.js, so skip server-component and Next-only rules.
- **ADR 0028 (pre-release):** no compatibility code. Delete `SheetFormFooter`'s `above` and `note`, `FormFrame`/`InlineForm`/`AuthCard`'s `formError`, and `auth-card.tsx`'s `focusFirstInvalid`, along with every form's own error machinery. Add no aliases, no optional fallbacks for old props and no feature flags. Changed shared messages also change what the server, MCP and CLI return; that is intended.
- **Copy rules (§8):** every field message and every client form-level message is at most **40 characters**, never interpolates a user value, and names one rule. Server-provided `err.message` passes through as is.
- **Motion (§5.1, §6.1):** a note enters over `150ms` and leaves over `100ms` on `var(--ease-out)`, animating opacity with `visibility` flipping at the ends. Outcome lines fade in over `150ms` (`@starting-style`) and leave at once. Control edges use the same 150/100 pair. Fades stay under reduced motion. Nothing moves, shakes or animates height.
- **Spacing:** `field-stack` row gap is `0.75rem`. Inside `FieldShell`: label to control 6px, control to note 4px, note to `below` 6px. The outcome line follows the last note at 4px, with buttons 8px below. The sheet footer's top padding is 8px, with 4px from the line to the buttons.
- **No form library**, no new dependency, no `flushSync` or `queueMicrotask` for focus.
- **Resource rules:** only one browser evidence pass or full test suite runs at a time on this machine, because CPU is shared. Evidence passes take the harness lock (`run.sh`, `/tmp/of-u4-evidence.lock`), and a full-suite run should not overlap one. Tasks run targeted tests: `pnpm vitest run --maxWorkers=50% <paths>`. The full suite (`pnpm test -- --maxWorkers=50%`) runs only in Task 20.
- **Evidence:** fake Claude only (`fake.mjs`). Never use real Claude credentials, never touch `~/.open-factory-spike`, and never start real agents.
- `docs/product/` is gitignored and belongs to the owner. Read it from `/Users/orlevi/projects/open-factory/docs/product/` and never edit its docs. The only writes allowed there are evidence outputs under `ui-review/u4-evidence/i4/`.
- **Commands** (run from the worktree root): `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test -- --maxWorkers=50%`.
- **Commits** are conventional (`feat(web): …`, `feat(shared): …`, `feat(server): …`, `docs: …`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **TDD:** in every task, write the failing test, run it to see it fail, implement, run it to see it pass, then commit. Tests check behaviour (ARIA, focus, text, classes in the contract), not pixel values.

## File map

| File | Responsibility | Task |
|---|---|---|
| `apps/web/src/components/code-text.tsx` | `CodeText` (moved from `features/settings/shared.tsx`) | 1 |
| `apps/web/src/components/field-note.tsx` | `FieldNote`, `noteDescribedBy` | 1 |
| `apps/web/src/styles.css` | `.field-note`, `.field-stack`, `.field-edge-transition`, `.form-outcome*` | 1, 4 |
| `apps/web/src/components/field-shell.tsx` | always-on note, `below`, `data-field`, string errors | 2 |
| `apps/web/src/components/ui/{input,textarea,select}.tsx`, `ui/combobox.tsx`, `features/agents/agent-combobox.tsx` | `field-edge-transition` | 2 |
| `apps/web/src/components/markdown/markdown-editor.tsx` | `invalid` prop | 2 |
| `apps/web/src/components/forms/use-field-errors.ts` | the hook | 3 |
| `apps/web/src/components/forms/focus-field.ts` | `focusField` | 3 |
| `apps/web/src/components/forms/form-outcome.tsx` | `FormOutcome`, `Outcome` type | 4 |
| `apps/web/src/features/sheets/form-footer.tsx`, `features/settings/forms/form-frame.tsx`, `features/settings/shared.tsx` (`InlineForm`), `components/auth-card.tsx`, `components/confirm-dialog.tsx` | `outcome` wiring | 5 |
| `packages/shared/src/messages.ts` | `MSG` constants used by the shared schemas | 6 |
| `apps/server/src/field-messages.ts` | `FIELD_MSG` constants used by `FieldError` throws and `verify.ts` | 6 |
| `apps/web/src/lib/form-messages.ts` | `FORM_MSG` constants for web checks and form-level copy | 6 |
| the forms | migrations | 7–16 |
| `apps/web/src/test/ui-contract.test.ts` | AC6 scan and the class contract | 17 |
| `DESIGN.md` | §10 amendments | 18 |

---

### Task 1: `CodeText` move, `FieldNote` and the CSS classes

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/components/code-text.tsx`, `apps/web/src/components/field-note.tsx`, `apps/web/src/components/field-note.test.tsx`
- Modify: `apps/web/src/features/settings/shared.tsx` (remove `CodeText`; import it from `@/components/code-text` wherever it is used: `grep -rn "CodeText" apps/web/src`), `apps/web/src/styles.css`

**Interfaces:**
- Produces:
  - `CodeText({ text }: { text: string })`
  - `FieldNote({ id, help, error, warning }: { id: string; help?: string; error?: string; warning?: string })`
  - `noteDescribedBy(id: string, n: { help?: string; error?: string; warning?: string }): string | undefined`
  - The CSS classes `field-note`, `field-stack` and `field-edge-transition`.
- Errors are **strings**. Backtick spans render as code through `CodeText`. A string compares stably across renders, so `FieldNote` can keep "last message" state without looping.

- [ ] **Step 1: Write the failing tests** (`field-note.test.tsx`)

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { FieldNote, noteDescribedBy } from "@/components/field-note";

test("both layers stay mounted; only the visible one is shown", () => {
  const { container, rerender } = render(<FieldNote id="f" help="Task keys, like T-41." />);
  const help = container.querySelector("#f-help")!;
  const error = container.querySelector("#f-error")!;
  expect(help).toHaveAttribute("data-shown");
  expect(error).not.toHaveAttribute("data-shown");
  rerender(<FieldNote id="f" help="Task keys, like T-41." error="Use task keys, like T-41." />);
  expect(container.querySelector("#f-help")).not.toHaveAttribute("data-shown");
  expect(container.querySelector("#f-error")).toHaveAttribute("data-shown");
  expect(screen.getByText("Use task keys, like T-41.")).toBeInTheDocument();
});

test("the last error text stays after a fix, hidden", () => {
  const { container, rerender } = render(<FieldNote id="f" error="Enter a title." />);
  rerender(<FieldNote id="f" />);
  const error = container.querySelector("#f-error")!;
  expect(error).toHaveTextContent("Enter a title.");
  expect(error).not.toHaveAttribute("data-shown");
});

test("warning uses the error layer without crimson", () => {
  const { container } = render(<FieldNote id="f" warning="Couldn't reach Claude. Try again." />);
  const layer = container.querySelector("#f-error")!;
  expect(layer).toHaveAttribute("data-shown");
  expect(layer).toHaveAttribute("data-tone", "warning");
});

test("backticks render as code", () => {
  render(<FieldNote id="f" help="Create one with `claude setup-token`." />);
  expect(screen.getByText("claude setup-token").tagName).toBe("CODE");
});

test("noteDescribedBy names only the visible note", () => {
  expect(noteDescribedBy("f", {})).toBeUndefined();
  expect(noteDescribedBy("f", { help: "h" })).toBe("f-help");
  expect(noteDescribedBy("f", { help: "h", error: "e" })).toBe("f-error");
  expect(noteDescribedBy("f", { warning: "w" })).toBe("f-error");
});
```

- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --maxWorkers=50% apps/web/src/components/field-note.test.tsx` fails because the module is missing.

- [ ] **Step 3: Implement**

`code-text.tsx`: move `CodeText` unchanged from `features/settings/shared.tsx`, together with its `monoClass` use. Import `monoClass` from `@/features/settings/shared`, or inline `"font-mono text-[0.8125rem]"`; choose the inline string so `components/` doesn't import from `features/`.

`field-note.tsx`:

```tsx
import { CircleAlert, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { CodeText } from "@/components/code-text";
import { cn } from "@/lib/utils";

type Note = { help?: string; error?: string; warning?: string };

/** The id a control's aria-describedby names: the visible note, or nothing for an empty line. */
export function noteDescribedBy(id: string, n: Note): string | undefined {
  if (n.error || n.warning) return `${id}-error`;
  return n.help ? `${id}-help` : undefined;
}

/** One reserved note line (spec §5.1): help and error stacked in one cell, swapped by opacity. */
export function FieldNote({ id, help, error, warning }: { id: string } & Note) {
  const message = error ?? warning;
  const tone = error ? "error" : "warning";
  // The hidden layer keeps the last message, so a fixed two-line error keeps the slot's height (D2).
  const [last, setLast] = useState({ text: message ?? "", tone });
  if (message && (message !== last.text || tone !== last.tone)) setLast({ text: message, tone });
  const Icon = last.tone === "error" ? CircleAlert : TriangleAlert;
  return (
    <div className="field-note -mt-0.5">
      <p id={`${id}-help`} data-shown={!message && help ? "" : undefined} className="text-muted-foreground">
        {help && <CodeText text={help} />}
      </p>
      <p
        id={`${id}-error`}
        data-shown={message ? "" : undefined}
        data-tone={last.tone}
        className={cn("flex items-start gap-1.5", last.tone === "error" ? "text-destructive" : "text-foreground")}
      >
        {last.text && (
          <Icon
            aria-hidden="true"
            className={cn("mt-0.5 size-3.5 shrink-0", last.tone === "warning" && "text-warning")}
          />
        )}
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <CodeText text={last.text} />
        </span>
      </p>
    </div>
  );
}
```

`styles.css`: add these after the existing transition utilities near `.jump-pill`, outside any reduced-motion block, so the fades stay:

```css
/* I4 (spec §5): one reserved note line. The type sits on the cell, so 1lh is one note line. */
.field-note {
  display: grid;
  min-width: 0;
  min-height: 1lh;
  font-size: 0.8125rem;
  line-height: 1.125rem;
}
.field-note > * {
  grid-area: 1 / 1;
  min-width: 0;
  opacity: 0;
  visibility: hidden;
  transition: opacity 100ms var(--ease-out), visibility 100ms var(--ease-out);
}
.field-note > [data-shown] {
  opacity: 1;
  visibility: visible;
  transition-duration: 150ms;
}
.field-stack {
  display: grid;
  row-gap: 0.75rem;
  align-content: start;
  min-width: 0;
}
/* The invalid edge arrives with the note (150ms) and leaves with it (100ms). */
.field-edge-transition {
  transition-property: border-color, background-color, color;
  transition-duration: 100ms;
  transition-timing-function: var(--ease-out);
}
.field-edge-transition[aria-invalid="true"],
.field-edge-transition:has([aria-invalid="true"]) {
  transition-duration: 150ms;
}
```

- [ ] **Step 4: Run them and confirm they pass,** together with `apps/web/src/test/field-shell.test.tsx`, which still passes because `FieldShell` is untouched.
- [ ] **Step 5: Commit** with `feat(web): FieldNote and the reserved note line classes`.

### Task 2: `FieldShell`, field wrappers, control edges and `MarkdownEditor invalid`

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify:
  - `apps/web/src/components/field-shell.tsx`
  - `apps/web/src/components/form-field.tsx` (type only)
  - `apps/web/src/features/settings/forms/shared.tsx` (`TokenField`, `ValueField`; delete `Unverifiable`)
  - `apps/web/src/components/ui/input.tsx`, `ui/textarea.tsx`, `ui/select.tsx` (`SelectTrigger` class string at :38), `ui/combobox.tsx` (trigger), `features/agents/agent-combobox.tsx` (trigger, if it has its own class)
  - `apps/web/src/components/markdown/markdown-editor.tsx`
- Test: `apps/web/src/test/field-shell.test.tsx`, plus a new `apps/web/src/components/markdown/markdown-editor.test.tsx` if none exists (`ls` first).

**Interfaces:**
- Consumes: `FieldNote` and `noteDescribedBy` (Task 1).
- Produces:
  - `FieldShell` props become `{ name; label; error?: string; help?: string; warning?: string; legend?; action?; below?: ReactNode; describedBy?: string; children(a: { id; describedBy?: string; invalid: boolean }) }`. Here `describedBy` holds extra persistent ids that are appended to the visible note's id.
  - The root carries `data-field` and `min-w-0`.
  - `MarkdownEditor` gains `invalid?: boolean`.

- [ ] **Step 1: Write the failing tests** in `field-shell.test.tsx`. Keep the existing tests and add these:

```tsx
test("the note line is always rendered, also without help or error", () => {
  const { container } = render(<FieldShell name="t" label="Title">{input}</FieldShell>);
  expect(container.querySelector(".field-note")).toBeInTheDocument();
  expect(container.querySelector("[data-field]")).toBeInTheDocument();
  expect(screen.getByLabelText("Title")).not.toHaveAttribute("aria-describedby");
});

test("extra describedBy ids are kept beside the visible note", () => {
  render(<FieldShell name="p" label="Projects" legend help="h" describedBy="marker">{() => <input aria-label="x" />}</FieldShell>);
  expect(screen.getByRole("group", { name: "Projects" })).toHaveAttribute("aria-describedby", "field-p-help marker");
});

test("below renders after the note", () => {
  const { container } = render(<FieldShell name="t" label="T" below={<p>summary</p>}>{input}</FieldShell>);
  const note = container.querySelector(".field-note")!;
  expect(note.nextElementSibling).toHaveTextContent("summary");
});

test("a warning describes the control but doesn't mark it invalid", () => {
  render(<FieldShell name="tok" label="Token" warning="Couldn't reach Claude. Try again.">{input}</FieldShell>);
  const el = screen.getByLabelText("Token");
  expect(el).toHaveAccessibleDescription("Couldn't reach Claude. Try again.");
  expect(el).not.toBeInvalid();
});

test("TokenField shows a warning in its note, not in a second alert", () => {
  render(<TokenField name="credential-value" label="Token" value="" onChange={() => {}} verdict={{ warning: "Couldn't reach Claude. Try again." }} />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("Token")).toHaveAccessibleDescription("Couldn't reach Claude. Try again.");
});
```

Also add a `MarkdownEditor` test: `invalid` sets `aria-invalid="true"` on the textarea and `data-invalid` on the frame (the `Tabs` root).

- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --maxWorkers=50% apps/web/src/test/field-shell.test.tsx apps/web/src/components/markdown`
- [ ] **Step 3: Implement**
  - **`FieldShell`:**
    - Compute `const noteId = id`.
    - Set `const visible = noteDescribedBy(id, { help, error, warning })` and `describedBy = [visible, props.describedBy].filter(Boolean).join(" ") || undefined`.
    - Render `<FieldNote id={id} help={help} error={error} warning={warning} />` after `body`, then `below`.
    - The root `div` and the `fieldset` both get `grid min-w-0 gap-1.5` and `data-field=""`.
    - The fieldset passes `aria-describedby={describedBy}`.
    - `invalid` is `Boolean(error)`.
    - Remove the old conditional `note`.
  - **`FormField`:** type `error?: string` (already a string). No other change.
  - **`TokenField`:**
    - Drop the outer `div` and `Unverifiable`.
    - Pass `error={verdict.error}` (a string; `CodeText` now renders inside `FieldNote`) and `warning={verdict.warning}`.
    - Add `help` for OAuth: give the signature `kind?: CredentialKind`, and when `kind === "oauth_token"`, set `help="Create one with \`claude setup-token\`."`. Callers pass `kind` in Tasks 8 and 9; until then, pass it in this task at the three call sites (`add-credential-form.tsx`, `credentials-section.tsx`), which compile either way.
    - Delete `Unverifiable` entirely.
  - **Control edges:** in `input.tsx` and `textarea.tsx`, replace `transition-colors` with `field-edge-transition`. In `select.tsx`'s trigger string (`:38`), add `field-edge-transition`. In the combobox trigger(s), replace their `transition-*` class with `field-edge-transition`.
  - **`MarkdownEditor`:**
    - Add `invalid?: boolean`.
    - The `Tabs` root gets `data-invalid={invalid || undefined}` and the classes `field-edge-transition data-[invalid]:border-destructive`. Drop `border-color` from its own `transition-[box-shadow,border-color]`, which becomes `transition-[box-shadow]`, so the edge timing comes from `field-edge-transition`.
    - The textarea gets `aria-invalid={invalid || undefined}`.
    - Write/Preview is already controllable (`view`, `onViewChange`); the forms use it in Tasks 12 and 14.
- [ ] **Step 4: Run** the new tests and every test that renders these components: `pnpm vitest run --maxWorkers=50% apps/web/src/test/field-shell.test.tsx apps/web/src/features/settings apps/web/src/components`. Update the assertions that looked for the `Unverifiable` alert: the warning is now in the field's description, and the form's announcement comes in Task 8.
- [ ] **Step 5: Commit** with `feat(web): FieldShell always reserves its note line; control edges share its timing`.

### Task 3: `useFieldErrors` and `focusField`

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/components/forms/use-field-errors.ts`, `apps/web/src/components/forms/focus-field.ts`, `apps/web/src/components/forms/use-field-errors.test.tsx`

**Interfaces:**
- Produces:

```ts
export type Checks<F extends string> = Partial<Record<F, () => string | undefined>>;
export type FieldErrors<F extends string> = {
  errors: Partial<Record<F, string>>;
  attempt: number;
  change(f: F): void;
  blur(f: F, e?: { relatedTarget: EventTarget | null }): void;
  set(f: F, message: string | undefined, opts?: { focus?: boolean }): void;
  server(fields: Record<string, string> | undefined): boolean;
  submit(fields?: readonly F[]): boolean;
  reset(): void;
};
export function useFieldErrors<F extends string>(o: {
  form: RefObject<HTMLElement | null>;
  checks: Checks<F>;
  /** Every field this form owns; `server` maps only these, `submit()` checks these. */
  fields: readonly F[];
}): FieldErrors<F>;
export function focusField(root: HTMLElement | null): void;
```

- [ ] **Step 1: Write the failing tests** (`use-field-errors.test.tsx`). Use a small harness component: one input per field, each with `aria-invalid` from `errors`, a `data-skip-validate` Close button, and a form ref.

```tsx
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { expect, test } from "vitest";
import { useFieldErrors } from "@/components/forms/use-field-errors";

type F = "title" | "path";
let api: ReturnType<typeof useFieldErrors<F>>;
function Harness({ hidePath = false }: { hidePath?: boolean }) {
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState({ title: "", path: "" });
  api = useFieldErrors<F>({
    form,
    fields: ["title", "path"],
    checks: {
      title: () => (v.title.trim() ? undefined : "Enter a title."),
      path: () => (!v.path ? "Enter a path." : v.path.startsWith("/") ? undefined : "Use an absolute path."),
    },
  });
  const field = (f: F) => (
    <div data-field="">
      <input aria-label={f} aria-invalid={api.errors[f] ? true : undefined} value={v[f]}
        onChange={(e) => { setV((x) => ({ ...x, [f]: e.target.value })); api.change(f); }}
        onBlur={(e) => api.blur(f, e)} />
      <span>{api.errors[f]}</span>
    </div>
  );
  return (
    <form ref={form}>
      {field("title")}
      {!hidePath && field("path")}
      <button type="button" data-skip-validate="">Close</button>
      <button type="button">Other</button>
    </form>
  );
}

test("tabbing past an untouched field shows nothing", async () => {
  render(<Harness />);
  await userEvent.click(screen.getByLabelText("title"));
  await userEvent.tab();
  expect(screen.queryByText("Enter a title.")).toBeNull();
});

test("blur on a changed field flags; while flagged the message follows typing; a pass clears and typing never re-flags", async () => {
  render(<Harness />);
  const path = screen.getByLabelText("path");
  await userEvent.type(path, "a");
  await userEvent.click(screen.getByText("Other"));
  expect(screen.getByText("Use an absolute path.")).toBeInTheDocument();
  await userEvent.clear(path);
  expect(screen.getByText("Enter a path.")).toBeInTheDocument();
  await userEvent.type(path, "/x");
  expect(screen.queryByText(/path\./)).toBeNull();
  await userEvent.clear(path);
  expect(screen.queryByText("Enter a path.")).toBeNull(); // no error while typing once fixed
});

test("blur to a data-skip-validate control doesn't validate", async () => {
  render(<Harness />);
  await userEvent.type(screen.getByLabelText("title"), " ");
  await userEvent.click(screen.getByText("Close"));
  expect(screen.queryByText("Enter a title.")).toBeNull();
});

test("submit flags all, focuses the first invalid field in DOM order, bumps attempt", () => {
  render(<Harness />);
  let ok = true;
  act(() => { ok = api.submit(); });
  expect(ok).toBe(false);
  expect(api.attempt).toBe(1);
  expect(screen.getByLabelText("title")).toHaveFocus();
});

test("an external error set in the same tick fails submit; change clears it", async () => {
  render(<Harness />);
  await userEvent.type(screen.getByLabelText("title"), "x");
  await userEvent.type(screen.getByLabelText("path"), "/x");
  let ok = true;
  act(() => { api.set("path", "No folder at this path."); ok = api.submit(); });
  expect(ok).toBe(false);
  expect(screen.getByLabelText("path")).toHaveFocus();
  await userEvent.type(screen.getByLabelText("path"), "y");
  expect(screen.queryByText("No folder at this path.")).toBeNull();
});

test("submit with a subset unflags the rest", () => {
  render(<Harness />);
  act(() => { api.submit(); });
  act(() => { api.submit(["path"]); });
  expect(screen.queryByText("Enter a title.")).toBeNull();
  expect(screen.getByText("Enter a path.")).toBeInTheDocument();
});

test("server maps known fields only and says whether it did", () => {
  render(<Harness />);
  let mapped = true;
  act(() => { mapped = api.server({ other: "x" }); });
  expect(mapped).toBe(false);
  act(() => { mapped = api.server({ path: "Another project uses this folder." }); });
  expect(mapped).toBe(true);
  expect(screen.getByLabelText("path")).toHaveFocus();
});

test("focus waits for a field that mounts in the same commit", () => {
  const { rerender } = render(<Harness hidePath />);
  act(() => { api.set("path", "Enter a path.", { focus: true }); });
  rerender(<Harness />);
  // In the forms, the disclosure opens in the same render as the error; here the rerender stands in for it.
  act(() => { api.set("path", "Enter a path.", { focus: true }); });
  expect(screen.getByLabelText("path")).toHaveFocus();
});
```

Add one more test: leaving the document. Stub `document.hasFocus` to return `false`, fire a `blur` event on a changed field, and expect no error.

Add a `focusField` test. Build a disabled `fieldset` containing an `aria-invalid` input, followed by an enabled one, and check that the enabled one gets focus. Spy on `Element.prototype.scrollIntoView` (jsdom lacks it, so define it on the prototype in the test) and check that it is called on the `[data-field]` ancestor with `{ block: "nearest" }`.

- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --maxWorkers=50% apps/web/src/components/forms`
- [ ] **Step 3: Implement**

`focus-field.ts`:

```ts
const FOCUSABLE = "input:not([type=hidden]),textarea,select,button,[role=combobox],[tabindex]:not([tabindex='-1'])";
/** Focus the first invalid field in DOM order and bring the whole field, note included, into view (spec §5.4, D6). */
export function focusField(root: HTMLElement | null) {
  if (!root) return;
  const el = [...root.querySelectorAll<HTMLElement>('[aria-invalid="true"]')].find(
    (e) => !e.closest("fieldset:disabled"),
  );
  if (!el) return;
  const target = el instanceof HTMLFieldSetElement ? el.querySelector<HTMLElement>(FOCUSABLE) : el;
  target?.focus({ preventScroll: true });
  (el.closest("[data-field]") ?? el).scrollIntoView?.({ block: "nearest" });
}
```

`use-field-errors.ts`:

```ts
import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { focusField } from "./focus-field";

// WebKit doesn't focus a clicked button, so a blur toward one has no relatedTarget: fall back to the last pointerdown.
let lastPointer: { target: EventTarget | null; at: number } = { target: null, at: 0 };
let tracking = false;
function trackPointer() {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener("pointerdown", (e) => { lastPointer = { target: e.target, at: performance.now() }; }, true);
}
const skips = (t: EventTarget | null) => t instanceof Element && t.closest("[data-skip-validate]") !== null;

export function useFieldErrors<F extends string>({ form, checks, fields }: {
  form: RefObject<HTMLElement | null>; checks: Checks<F>; fields: readonly F[];
}): FieldErrors<F> {
  const [flagged, setFlagged] = useState<ReadonlySet<F>>(() => new Set());
  const [external, setExternalState] = useState<Partial<Record<F, string>>>({});
  const externalRef = useRef(external);
  const changed = useRef(new Set<F>());
  const [focusReq, setFocusReq] = useState(0);
  const [attempt, setAttempt] = useState(0);
  // Handlers run after commit; the effect keeps them on this render's checks (no ref write during render).
  const checksRef = useRef(checks);
  useLayoutEffect(() => { checksRef.current = checks; });
  useLayoutEffect(trackPointer, []);
  useLayoutEffect(() => { if (focusReq) focusField(form.current); }, [focusReq, form]);

  const setExternal = (next: Partial<Record<F, string>>) => { externalRef.current = next; setExternalState(next); };
  const requestFocus = () => { setFocusReq((n) => n + 1); setAttempt((n) => n + 1); };

  // Render: a flagged field's message comes from its check now (D4); a passing flagged field is unflagged in this render.
  const errors: Partial<Record<F, string>> = {};
  const passed: F[] = [];
  for (const f of fields) {
    const ext = external[f];
    const own = flagged.has(f) ? checks[f]?.() : undefined;
    if (flagged.has(f) && !own) passed.push(f);
    const m = ext ?? own;
    if (m) errors[f] = m;
  }
  if (passed.length > 0) setFlagged((s) => { const n = new Set(s); for (const f of passed) n.delete(f); return n; });

  return {
    errors,
    attempt,
    change(f) {
      changed.current.add(f);
      if (externalRef.current[f] !== undefined) { const { [f]: _, ...rest } = externalRef.current; setExternal(rest as typeof external); }
    },
    blur(f, e) {
      if (!document.hasFocus()) return;
      const to = e?.relatedTarget ?? (performance.now() - lastPointer.at < 500 ? lastPointer.target : null);
      if (skips(to)) return;
      if (!changed.current.has(f) && !flagged.has(f) && !externalRef.current[f]) return;
      if (checksRef.current[f]?.()) setFlagged((s) => new Set(s).add(f));
    },
    set(f, message, opts) {
      if (externalRef.current[f] === message) return; // guards a call made during render
      const next = { ...externalRef.current };
      if (message) next[f] = message; else delete next[f];
      setExternal(next);
      if (message && opts?.focus) requestFocus();
    },
    server(map) {
      const next: Partial<Record<F, string>> = {};
      for (const f of fields) if (map?.[f]) next[f] = map[f];
      if (Object.keys(next).length === 0) return false;
      setExternal(next);
      requestFocus();
      return true;
    },
    submit(only = fields) {
      const failing = only.filter((f) => checksRef.current[f]?.());
      const ext: Partial<Record<F, string>> = {};
      for (const f of only) if (externalRef.current[f]) ext[f] = externalRef.current[f];
      setFlagged(new Set(failing));
      setExternal(ext);
      if (failing.length > 0 || Object.keys(ext).length > 0) { requestFocus(); return false; }
      return true;
    },
    reset() { setFlagged(new Set()); setExternal({}); changed.current.clear(); },
  };
}
```

`submit` reads `checksRef.current`, which is this render's checks because handlers run after the commit that set it. A form that changes a value and submits in the same event (none do today) would see the previous values; the forms never do that.

- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** with `feat(web): useFieldErrors and focusField own validation timing and focus`.

### Task 4: `FormOutcome`

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/components/forms/form-outcome.tsx`, `apps/web/src/components/forms/form-outcome.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces:
  - `type Outcome = { error?: ReactNode; success?: ReactNode; notice?: ReactNode; outcomeKey: number; action?: ReactNode }`
  - `FormOutcome({ outcome, pending, noticeId, className }: { outcome: Outcome; pending?: string; noticeId?: string; className?: string })`

- [ ] **Step 1: Write the failing tests**

```tsx
test("both live regions are always mounted and never visibility-hidden", () => {
  render(<FormOutcome outcome={{ outcomeKey: 0 }} />);
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(1);
});

test("an identical second failure re-inserts its text", () => {
  const { rerender } = render(<FormOutcome outcome={{ error: "Couldn't save. Try again.", outcomeKey: 1 }} />);
  const first = screen.getByText("Couldn't save. Try again.");
  rerender(<FormOutcome outcome={{ error: "Couldn't save. Try again.", outcomeKey: 2 }} />);
  expect(screen.getByText("Couldn't save. Try again.")).not.toBe(first);
});

test("an error hides the notice; the notice returns when it clears", () => {
  const { container, rerender } = render(<FormOutcome noticeId="n" outcome={{ notice: "@ada restarts when idle.", outcomeKey: 0 }} />);
  expect(container.querySelector("#n")).toHaveAttribute("data-shown");
  rerender(<FormOutcome noticeId="n" outcome={{ notice: "@ada restarts when idle.", error: "Couldn't save. Try again.", outcomeKey: 1 }} />);
  expect(container.querySelector("#n")).not.toHaveAttribute("data-shown");
  rerender(<FormOutcome noticeId="n" outcome={{ notice: "@ada restarts when idle.", outcomeKey: 1 }} />);
  expect(container.querySelector("#n")).toHaveAttribute("data-shown");
});

test("success goes to the status region; pending only to the sr-only status", () => {
  render(<FormOutcome pending="Saving…" outcome={{ success: "Saved.", outcomeKey: 1 }} />);
  expect(screen.getByText("Saved.").closest("[role=status]")).toBeInTheDocument();
  expect(screen.getByText("Saving…")).toHaveClass("sr-only");
});
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement**

```tsx
export function FormOutcome({ outcome, pending, noticeId, className }: {
  outcome: Outcome; pending?: string; noticeId?: string; className?: string;
}) {
  const { error, success, notice, outcomeKey, action } = outcome;
  const showNotice = !error && !success && Boolean(notice);
  return (
    <div className={cn("form-outcome", className)}>
      <p id={noticeId} data-shown={showNotice ? "" : undefined} className="form-outcome-notice text-muted-foreground">{notice}</p>
      <div role="alert">
        {error && (
          <p key={outcomeKey} className="form-outcome-line flex items-start gap-1.5 text-destructive">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{error}</span>
            {action}
          </p>
        )}
      </div>
      <div role="status">
        {!error && success && (
          <p key={outcomeKey} className="form-outcome-line flex items-start gap-1.5">
            <CircleCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-success" />
            <span className="min-w-0">{success}</span>
          </p>
        )}
      </div>
      <span role="status" className="sr-only">{pending ?? ""}</span>
    </div>
  );
}
```

CSS:

```css
.form-outcome { display: grid; min-width: 0; min-height: 1lh; font-size: 0.8125rem; line-height: 1.125rem; }
.form-outcome > * { grid-area: 1 / 1; min-width: 0; }
.form-outcome-notice { opacity: 0; visibility: hidden; transition: opacity 100ms var(--ease-out), visibility 100ms var(--ease-out); }
.form-outcome-notice[data-shown] { opacity: 1; visibility: visible; transition-duration: 150ms; }
/* Live regions never transition visibility (D7): the inserted line fades in and leaves at once. */
.form-outcome-line { transition: opacity 150ms var(--ease-out); }
@starting-style { .form-outcome-line { opacity: 0; } }
```

The `sr-only` span is absolutely positioned and sits outside the grid flow.

- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** with `feat(web): FormOutcome, the reserved form-level line`.

### Task 5: Wire `outcome` into footers, frames, auth and dialog

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify:
  - `apps/web/src/features/sheets/form-footer.tsx`
  - `apps/web/src/features/settings/forms/form-frame.tsx`
  - `apps/web/src/features/settings/shared.tsx` (`InlineForm`)
  - `apps/web/src/components/auth-card.tsx`
  - `apps/web/src/components/confirm-dialog.tsx`
  - every caller (`grep -rn "formError=\|above=\|note=\|focusFirstInvalid" apps/web/src`)
- Test: `apps/web/src/test/confirm-dialog.test.tsx`, `apps/web/src/features/settings/forms/forms.test.tsx`, plus a new `apps/web/src/features/sheets/form-footer.test.tsx`

**Interfaces:**
- Consumes: `FormOutcome` and `Outcome` (Task 4).
- Produces:
  - `SheetFormFooter({ submitLabel, pendingLabel, pending, restored, onDiscard, left, submitClassName, outcome })`. `outcome: Outcome` is required; `above` and `note` are deleted.
  - `FormFrame` and `InlineForm` take `outcome: Outcome` in place of `formError`.
  - `AuthCard` takes `outcome: Outcome` in place of `formError`.
  - `ConfirmDialog` keeps its API; internally it holds an `outcomeKey` counter.
  - The `focusFirstInvalid` export is deleted.

- [ ] **Step 1: Write the failing tests**
  - `form-footer.test.tsx`:
    - The footer's first child is the `.form-outcome` line.
    - With `outcome.notice`, the submit's `aria-describedby` names the notice id.
    - With `outcome.error`, the notice is hidden and the alert has the text.
    - The submit button never sits in the same row as the line; assert DOM order: the line comes before the buttons.
  - `confirm-dialog.test.tsx`:
    - A failing confirm puts the message in `role=alert` inside the footer band, not inside the scrolling middle. Assert that `screen.getByRole("alert").closest("[data-slot=alert-dialog-footer],[data-slot=drawer-footer]")` is truthy.
    - A second identical failure re-inserts the text.
  - `forms.test.tsx`: the inline frame shows `formError`-equivalent text through `outcome` above the buttons.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement**
  - **`SheetFormFooter`:**
    - Render `<FormOutcome outcome={outcome} pending={pending ? pendingLabel : undefined} noticeId={noticeId} className="basis-full -mb-1" />` as the footer's first child, on desktop and mobile alike.
    - Pass `className="pt-2"` to `SheetFooter` (desktop `p-4` becomes `px-4 pb-4 pt-2`) and to `DrawerFooter` (`pt-4` becomes `pt-2`).
    - Desktop rows: the line spans the full row (`basis-full`), and its `-mb-1` with the footer's `gap-2` leaves 4px to the buttons.
    - Delete `aboveLine` and `note`.
    - The submit's `aria-describedby` is `noticeId` when `outcome.notice` shows and there is no error.
  - **`FormFrame`** (sheet frame):
    - Delete the body `role=alert` div and the body `sr-only` status.
    - Render `SheetFormFooter`-like markup with `FormOutcome` as the footer's first row, or render `SheetFormFooter` itself if its Close semantics match. Today `FormFrame` uses a plain `Button` that calls `onCancel`, so keep its own footer and add the same `FormOutcome` row and padding.
    - Give the Close button `data-skip-validate`.
  - **`InlineForm`:**
    - Replace the `role=alert` div and the `sr-only` status with `<FormOutcome outcome={outcome} pending={pending ? pendingLabel : undefined} className="-mt-2" />` before the button row. With the form's `gap-4`, `-mt-2` gives 4px after the last note when the form uses `field-stack`; set the form's class to `field-stack max-w-xl py-3` and put the button row in a `div` with `mt-1`. Measure in Task 21.
    - Cancel gets `data-skip-validate`.
  - **`AuthCard`:**
    - The `form` becomes `field-stack`.
    - The conditional `<p role=alert>` becomes `<FormOutcome outcome={props.outcome} className="-mt-2" />` right before the submit.
    - Delete `focusFirstInvalid`.
  - **`ConfirmDialog`:**
    - Add `const [key, setKey] = useState(0)`, and call `setKey((k) => k + 1)` in `catch`.
    - Remove `errorLine` from the middle and `DrawerBody`.
    - Render `<FormOutcome outcome={{ error, outcomeKey: key }} className="basis-full" />` as the first child of `AlertDialogFooter` and `DrawerFooter`, with footer `pt-2`.
    - Shorten the fallback to `"Something went wrong. Try again."`, which is already 32 characters.
  - **Callers:** mechanical for now. Each `formError={x}` becomes `outcome={{ error: x, outcomeKey: k }}`, where `k` is a `useState(0)` counter bumped wherever the form sets the error. Each `above={notice}` becomes `outcome={{ notice, … }}`, and `note={slow ? … : undefined}` becomes `notice` (New agent). Sign-in and sign-up still call `focusFirstInvalid`: replace it with `focusField(form)` from `@/components/forms/focus-field` (they move to the hook in Task 7). Agent sheets keep their body `InlineOutcome` until Task 15, but their sr-only pending spans are deleted here because the footer announces pending.
- [ ] **Step 4: Run** `pnpm typecheck` and `pnpm vitest run --maxWorkers=50% apps/web/src/test/confirm-dialog.test.tsx apps/web/src/features/sheets apps/web/src/features/settings apps/web/src/test/sign-in.test.tsx apps/web/src/test/sign-up.test.tsx`.
- [ ] **Step 5: Commit** with `feat(web): one reserved outcome line above every form's buttons`.

### Task 6: Copy constants and length tests (shared, server, web)

Implementer and reviewer invoke `vercel-react-best-practices` and follow it (the `apps/web` part).

**Files:**
- Create: `packages/shared/src/messages.ts`, `packages/shared/src/messages.test.ts`, `apps/server/src/field-messages.ts`, `apps/server/src/field-messages.test.ts`, `apps/web/src/lib/form-messages.ts`, `apps/web/src/lib/form-messages.test.ts`
- Modify:
  - `packages/shared/src/names.ts`, `tasks.ts`, `cron.ts`, `schedules.ts`, `agents.ts`, `handle.ts`, `settings.ts`: every Zod message that reaches a form field. `templates.ts` validator issues are out: they show in the template issue list, not in a field note.
  - `apps/server/src/projects/project-service.ts:111-128`, `apps/server/src/agents/agent-service.ts:29,416,433,456,464,617`, `apps/server/src/workspace/workspace.ts:142`, `apps/server/src/credentials/verify.ts:87-96`
  - the matching `*.test.ts` that assert old copy (`grep -rln "inner hyphens\|already uses this folder\|isn't registered\|No folder at\|setup-token" apps packages --include=*.test.ts*`).

**Interfaces:**
- Produces:
  - `MSG` (shared), a `const` object of strings: `MSG.startLetter`, `MSG.nameLength` ("Use 2 to 40 characters."), `MSG.slugLength` ("Use 3 to 40 characters."), `MSG.nameChars` ("Use only a–z, 0–9 and hyphens."), `MSG.noTrailingHyphen` ("Don't end with a hyphen."), and so on.
  - `FIELD_MSG` (server).
  - `FORM_MSG` (web): form-level and web-only check messages.

**Rewrites.** This is every message over 40 characters, or with interpolation, that reaches a field or a form line. Run `grep -rnoE '"[A-Z][^"]{40,}\."' apps/web/src packages/shared/src apps/server/src --include=*.ts --include=*.tsx | grep -v test` and add any hit not listed here.

| Where | Now | After |
|---|---|---|
| `names.ts` `slugSchema` | "Use 3–40 lowercase letters, numbers and inner hyphens, starting with a letter." | `.min(3, MSG.slugLength).max(40, MSG.slugLength).regex(/^[a-z]/, MSG.startLetter).regex(/^[a-z0-9-]+$/, MSG.nameChars).regex(/[^-]$/, MSG.noTrailingHyphen)` plus the existing inner-hyphen rule expressed in `SLUG_PATTERN` as a final `.regex(SLUG_PATTERN, MSG.nameChars)` |
| `names.ts` `nameSchema` | "Use 2–40 …" | the same chain with `MSG.nameLength` |
| `names.ts` `secretNameSchema` | "Use uppercase letters, numbers and underscores, like GH_TOKEN." (61) | "Use A–Z, 0–9 and underscores." |
| `names.ts` reserved secret | "That name is reserved for the agent's environment." (50) | "That name is reserved." |
| `cron.ts:6` | "Use 5 fields: minute hour day-of-month month day-of-week." | "Use 5 fields, like 0 9 * * 1-5." |
| `cron.ts:7` | "Only numbers, *, ranges, lists, steps and names are allowed." | "Use numbers, *, -, / and commas." |
| `tasks.ts:29` | "Keep the title to 200 characters or fewer." (42) | "Use 200 characters or fewer." |
| web `add-*-form.tsx` `checkName` | "Use 2–40 lowercase letters, numbers and inner hyphens, starting with a letter." | the first `nameSchema` issue message |
| web `add-*-form.tsx` exists | `A credential named ${n} already exists.` / `A project named ${n} already exists.` | "That name is taken." |
| web `task-form.tsx:98` | `@${staleSlug} has ended; pick another.` / `There is no agent @${staleSlug}.` | "That agent has ended; pick another." / "No such agent; pick another." |
| web `schedule-form.tsx:176` | the same | the same |
| web `agent-form-state.ts` | `Template ${v.template} has errors. Fix them first.` | "That template has errors; fix it first." |
| web `agent-form-state.ts` | "Keep the display name to 80 characters or fewer." | "Use 80 characters or fewer." |
| web `agent-form-state.ts` | "Keep the description to 500 characters or fewer." | "Use 500 characters or fewer." |
| web `agent-form-state.ts` | "Couldn't create the agent. Check that the server is running, then try again." / "Couldn't save. Check that …" | "Couldn't reach the server. Try again." |
| web `schedule-form.tsx` | "Shorten the message to 64 KB or less." (37) | unchanged |
| web `edit-agent-sheet.tsx:329` toast | not a form line | unchanged (toasts are out) |
| server `project-service.ts:112` | `No folder at ${hostPath}.` | "No folder at this path." |
| server `project-service.ts:128` | `Project ${other.name} already uses this folder.` | "Another project uses this folder." |
| server `agent-service.ts:456` | `Project ${n} isn't registered.` | "A chosen project was removed." |
| server `verify.ts:91` | "Claude rejected this token. Create a new one with `claude setup-token`." | "Claude rejected this token." |
| server `verify.ts:96` | "Couldn't reach Claude to verify. Try again." | "Couldn't reach Claude. Try again." |
| server `workspace.ts:142`, `agent-service.ts:617` | read them; rewrite to ≤ 40 characters, no interpolation | |

- [ ] **Step 1: Write the failing tests**
  - `packages/shared/src/messages.test.ts`: `for (const [k, m] of Object.entries(MSG)) expect(m.length, k).toBeLessThanOrEqual(40)`. Add a schema-level test: `slugSchema.safeParse("9ab").error?.issues[0]?.message === MSG.startLetter`, `"ab"` gives `slugLength`, `"ab-"` gives `noTrailingHyphen`, and `"a_b"` gives `nameChars`.
  - `apps/server/src/field-messages.test.ts`:
    - The same length test for `FIELD_MSG`.
    - A source scan: read every `apps/server/src/**/*.ts` (not tests) and fail on `/new FieldError\([^,]+,\s*`/`. A template literal as the message is banned.
    - `verify.ts` messages come from `FIELD_MSG`.
  - `apps/web/src/lib/form-messages.test.ts`:
    - A length test for `FORM_MSG`.
    - A source scan of `apps/web/src/**/*.tsx?` (not tests) that fails on `` /\.set\([^,]+,\s*`/ `` (a template literal passed to `f.set`).
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --maxWorkers=50% packages/shared/src/messages.test.ts apps/server/src/field-messages.test.ts apps/web/src/lib/form-messages.test.ts`
- [ ] **Step 3: Implement** the constants and replace the literals at each site in the table. Update the old-copy assertions in existing tests to the new constants. Import them rather than re-typing strings.
- [ ] **Step 4: Run** the three tests, `pnpm vitest run --maxWorkers=50% packages/shared apps/server/src/projects apps/server/src/agents apps/server/src/credentials`, and `pnpm typecheck`.
- [ ] **Step 5: Commit** with `feat(shared): short, one-rule field messages with length tests`. Use a second commit, `feat(server): …`, if the diff reads better split.

### Task 7: Sign in and sign up

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/routes/sign-in.tsx`, `apps/web/src/routes/sign-up.tsx`
- Test: `apps/web/src/test/sign-in.test.tsx`, `apps/web/src/test/sign-up.test.tsx`

**Interfaces:**
- Consumes: `useFieldErrors`, `AuthCard({ outcome })`.

- [ ] **Step 1: Write the failing tests** (add to the existing files):
  - Tabbing through an empty sign-in form shows no error.
  - Typing an invalid email then tabbing away shows "Enter a valid email".
  - Fixing it clears the error on the keystroke that makes it valid.
  - Submitting empty focuses Email.
  - A failed sign-in (mock `authClient.signIn.email` resolving `{ error }` with no field) puts the message in `role=alert`; a second identical failure announces again (the text node is new).
  - Sign-up: an invalid handle typed and blurred shows the handle schema's first issue message.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement**
  - `checks`: for each field, `() => signInSchema.shape.email.safeParse(values.email).error?.issues[0]?.message`, and likewise for each field of `signUpSchema` (use `.shape`; if `signUpSchema` is a refined object, export its base object from shared as `signUpFieldsSchema` and use that).
  - `const f = useFieldErrors({ form: formRef, fields: ["email","password"], checks })`. `AuthCard` forwards a `ref` to its `<form>`: add `formRef?: Ref<HTMLFormElement>` to `AuthCard`, or have `AuthCard` accept `ref` as a React 19 prop.
  - `set(field, value)` updates the value and calls `f.change(field)`. Each `FormField` gets `onBlur={(e) => f.blur(field, e)}` and `error={f.errors[field]}`.
  - `submit`: `if (!f.submit()) return;`. On an auth failure with a field, call `f.server({ [m.field]: m.message })`; otherwise set the outcome error and bump `outcomeKey`.
  - Delete `errors` state, `showFieldErrors`, `flushSync` and the "Editing a field clears its error" comment.
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** with `feat(web): sign in and sign up on useFieldErrors`.

### Task 8: Settings add forms (credential, project, secret) on `FormFrame`

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/settings/forms/add-credential-form.tsx`, `add-project-form.tsx`, `add-secret-form.tsx`, `form-frame.tsx` (body becomes `field-stack`)
- Test: `apps/web/src/features/settings/forms/forms.test.tsx`

- [ ] **Step 1: Write the failing tests.** For each form:
  - Submit empty: focus goes to the first field.
  - A server 400 `fields.hostPath` lands under Path and focuses it.
  - Untouched blur stays clean.
  - Credential:
    - A `credential_rejected` 422 puts "Claude rejected this token." under the token and focuses it.
    - A `credential_unverifiable` 422 shows the warning in the token's note (ochre, not invalid) and "Couldn't add the credential." in `role=alert`.
    - Editing the token clears the warning.
    - The OAuth kind shows the help "Create one with claude setup-token.".
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Each form uses `useFieldErrors` with `form` from `FormFrame`: `FormFrame` takes `formRef` and passes it to both its `form` (sheet) and `InlineForm`.
  - Credential:
    - `verdictOf` maps a rejection to `f.set("value", msg, { focus: true })`.
    - An unverifiable result sets `warning` state (cleared in the token's `onChange` and at the start of submit) and the outcome error `FORM_MSG.addCredentialFailed` ("Couldn't add the credential.").
    - `credential_exists` goes to `f.set("name", FORM_MSG.nameTaken, { focus: true })`.
    - `validation_error` goes to `f.server(fields)`; when it returns `false`, the outcome error is `err.message`.
  - Project and secret: same pattern.
  - Delete the `focus` helpers and the per-field error state.
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** with `feat(web): settings add forms on useFieldErrors`.

### Task 9: Settings row forms and Factory settings

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/settings/credentials-section.tsx` (Replace token, ~:90-140), `secrets-section.tsx` (Update value, :40-82), `projects-section.tsx` (Change path, :105-163), `factory-section.tsx`
- Test: `apps/web/src/test/settings.test.tsx`, `apps/web/src/test/settings-factory.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - Replace token and Update value validate on blur of a changed field ("Enter the token.", "Enter a value.").
  - Factory:
    - Blur on an unchanged number field shows nothing.
    - Saving puts "Saved." in the line above Save, and nothing sits beside Save. Assert that `screen.getByText("Saved.")` comes before the Save button in DOM order.
    - The next edit clears "Saved.".
    - A failure shows "Couldn't save. Try again." in `role=alert`.
    - A server 400 field error focuses its field.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Row forms: hook plus `InlineForm outcome`.
  - Factory:
    - The hook's `submit(changedFields)`.
    - `FormOutcome` above the Save row with `success` / `error` and an `outcomeKey` counter.
    - `onChange` clears `success`.
    - Delete the `InlineOutcome` beside Save, the `flushSync` and `focus`.
    - The form uses `field-stack`.
    - The "changed elsewhere" banner stays as is (out of scope, #132).
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** with `feat(web): settings row forms and factory settings on the shared form pieces`.

### Task 10: New template form

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/templates/new-template-form.tsx`
- Test: `apps/web/src/features/templates/new-template-form.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - Submitting with a derived name that fails reveals Name with the derived value and focuses it.
  - A blur on an untouched Description stays clean.
  - A server failure shows in `role=alert` in the footer.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the hook.
  - Submit:
    ```ts
    const okName = !checks.name();
    if (!okName && !v.revealed) update({ revealed: true, name });
    if (!f.submit()) return;
    ```
    `name` is the derived name the code already computes. Because the reveal and `f.submit` are batched into the same commit, focus finds Name.
  - Delete `show`, `focus` and `flushSync`. Discard calls `f.reset()`.
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** with `feat(web): new template form on useFieldErrors`.

### Task 11: `DependencyEditor` and `LinkEditor`

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/tasks/dependency-editor.tsx`, `apps/web/src/features/tasks/link-editor.tsx`
- Test: create `apps/web/src/features/tasks/dependency-editor.test.tsx` and `link-editor.test.tsx` if they are missing (`ls` first)

**Interfaces:**
- Produces:
  - `dependsSummary(keys: string[]): string`, which returns "Depends on T-41.", "Depends on T-41 and T-52." or "Depends on T-41, T-44 and 3 more."
  - `DependencyEditor({ value, onChange, onBlur, error, resolvedKeys, name })`. `resolved: TaskSummary[]` becomes `resolvedKeys: string[]`, and the badges leave the component.
  - `LinkEditor({ rows, onChange, errors, onBlurRow })`, unchanged, where `errors` maps a row id to a message.

- [ ] **Step 1: Write the failing tests.**
  - `dependsSummary` with 0, 1, 2 and 5 keys. With 5 keys it returns "Depends on T-1, T-2 and 3 more.", which is at most 40 characters for up to two 6-character keys.
  - `DependencyEditor` shows the summary as help, shows no list, and an error replaces the help.
  - `LinkEditor`:
    - Each row has a `.field-note` after the target in DOM order, with the note before the title input.
    - The target is described by the row's note when the row has an error.
    - No `CircleAlert` paragraph exists outside `.field-note`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - **`DependencyEditor`:**
    - `help={resolvedKeys.length ? dependsSummary(resolvedKeys) : "Task keys, like T-41."}`.
    - Delete the badge `ul`.
  - **Task detail:** `task-detail.tsx` renders its own badges list below the editor, as content (`TaskBadge` plus `StatusLabel`, moved there verbatim from the component).
  - **`LinkEditor` rows:**
    - Each row is a `div` with `grid gap-x-2 grid-cols-[6rem_minmax(0,1fr)_auto] [grid-template-areas:'kind_target_remove''note_note_note''title_title_title'] md:grid-cols-[6rem_minmax(0,1fr)_12rem_auto] md:[grid-template-areas:'kind_target_title_remove''note_note_note_note']`.
    - Each child gets its own `[grid-area:…]`.
    - The note is `<FieldNote id={`${r.id}`} error={err} />`, and the target's `aria-describedby` is `noteDescribedBy(r.id, { error: err })`.
    - Delete the hand-rolled `<p>`.
    - The fieldset stays a plain `fieldset` with a `legend`.
    - "Add link" gets `data-skip-validate`, so moving from a row to Add link doesn't validate.
- [ ] **Step 4: Run them and confirm they pass,** together with `features/tasks` tests that touch these components.
- [ ] **Step 5: Commit** with `feat(web): dependency summary in the note; link rows with their own note`.

### Task 12: New task form

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/tasks/task-form.tsx`
- Test: `apps/web/src/features/tasks/task-form.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - Submit empty: focus goes to Title.
  - Bad dependency keys on submit, with More options folded by the user: it opens and Depends on gets focus.
  - A bad link on a second submit after the user folds More options again reopens it.
  - A server 400 `fields.links` with no rows shows in `role=alert`; with rows, it shows in the first row's note.
  - A row added while links are flagged shows nothing until it is blurred.
  - An invalid description (over the limit) marks the editor frame `data-invalid`, switches Preview back to Write, and focuses the textarea.
  - A stale assignee shows "That agent has ended; pick another.".
  - A failed lookup on submit shows "Couldn't create the task. Try again.".
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Fields: `["title","assignee","body","dependsOn","links"]`.
  - `checks`:
    - `title`: `taskTitleSchema`.
    - `body`: `taskBodySchema`.
    - `links`: the first row message over `checkedRows`.
    - `assignee` and `dependsOn` have no sync check; they use `f.set`.
  - `checkedRows: Set<string>` lives in state. Add a row id on its blur. On submit, set it to all current ids. `rowErrors` is derived in render: for ids in `checkedRows`, while `f.errors.links` is present, `checkLink(row, known)`.
  - Dependencies:
    - On blur, `checkDependencies(deps)`. On success, `setResolvedKeys(r.keys)` and `f.set("dependsOn", r.error)`.
    - On submit, `const r = await checkDependencies(deps).catch(() => undefined); if (r) f.set("dependsOn", r.error); setCheckedRows(new Set(rows.map(x=>x.id))); if (!f.submit()) return; if (!r) { failed outcome; return }`.
  - Stale assignee: the existing effect calls `f.set("assignee", staleError)`.
  - MoreOptions: keep `[seenAttempt, setSeenAttempt] = useState(f.attempt)`. When `f.attempt !== seenAttempt`, set `seenAttempt` and, if `f.errors.dependsOn || f.errors.links`, call `setUserOpen(undefined)` (adjusted during render).
  - Description:
    - `MarkdownEditor invalid={Boolean(f.errors.body)} view={bodyView} onViewChange={setBodyView}`.
    - On a failing submit with a body error, call `setBodyView("write")` in the submit handler before `f.submit()`, so the textarea exists at commit.
  - Server: `if (!f.server(pick(err.body.fields, FIELDS))) { outcome error }`. A `links` field with no rows is mapped to the outcome instead: check `rows.length === 0` first.
  - Footer: `SheetFormFooter outcome={{ error: failed ? FORM_MSG.createTaskFailed : undefined, outcomeKey }}`.
  - Body: `field-stack`.
  - Delete `errors` state, `show`, `focus`, `flushSync`, `queueMicrotask`, the links `<p>` and the body failure `<p>`. Discard calls `f.reset()`.
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** with `feat(web): new task form on useFieldErrors`.

### Task 13: Task detail editors

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/tasks/task-detail.tsx` (`EditorButtons` :92; title editor ~:353; description ~:445; dependencies ~:665; links ~:761)
- Test: `apps/web/src/features/tasks/task-detail.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - The title editor's empty-title Save shows "Enter a title." under the input, in its note, and focuses the input.
  - A save failure shows in `EditorButtons`' `role=alert` line, and the hint returns after the next edit.
  - The dependencies editor's bad key on blur shows in its note.
  - The links editor's row error sits under its target.
  - The badges still render below the dependencies editor.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - **`EditorButtons({ pending, saveDisabled, onSave, onCancel, outcome })`:**
    - It renders `FormOutcome` with `notice: hint` and `error: failed` above the buttons.
    - Cancel gets `data-skip-validate`.
  - **Each editor:**
    - Wrap the editor in a `ref`'d `div` and give it `useFieldErrors` with its one field.
    - The title input moves into a `FormField`-like `FieldShell` (label `sr-only` "Title", since the section already labels it) so it gets a note.
    - The title's validation goes through `f.submit()`; Save failures go through the outcome's `outcomeKey`.
    - Delete the per-editor `error` state where the hook replaces it.
  - **The sidebar Assignee/Status line at :583** stays and gets `// ui-contract:allow non-form status line, follow-up #132`.
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** with `feat(web): task detail editors on the shared form pieces`.

### Task 14: Schedule form (New and Edit schedule)

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/schedules/schedule-form.tsx`, `when-field.tsx`, `repeats-field.tsx`, `timezone-select.tsx` (blur on close if it is a combobox)
- Test: `schedule-form.test.tsx`, `new-schedule-sheet.test.tsx`, `edit-schedule-sheet.test.tsx`, `repeats-field.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - Edit schedule: flag At on blur (a past time), revert At, edit Body, and save. The save goes through and At shows no error (the subset rule).
  - Submit focuses the first invalid field.
  - A stale target shows "That agent has ended; pick another." and the render doesn't loop: the test renders and asserts one call to the agents query.
  - The Message editor's invalid state marks the frame.
  - A server 400 focuses its field.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Fields: `["target","cron","at","timezone","body"]`. `checks` are the existing `check` object's functions bound to `v`.
  - The stale target during render calls `f.set("target", msg)`. This is guarded: it writes only when the message differs.
  - Submit: `if (!f.submit(FIELDS.filter(relevant))) return;`.
  - Server: `f.server(fields)`, else `failed`.
  - Delete `toFocus`, the focus effect and `focus`, plus the `failed` `<p>`. The outcome goes to the footer: `FORM_MSG.saveScheduleFailed` ("Couldn't save the schedule. Try again.", 38 characters).
  - `WhenField` and `RepeatsField` pass `(e) => f.blur("cron"|"at", e)`. The Repeats `Select` calls blur on close, following `TemplateField`'s pattern (an `onOpenChange` that tracks open and validates on close).
  - Body becomes `field-stack`.
  - The Pause/Delete `StateLine` in `edit-schedule-sheet.tsx` stays and gets `ui-contract:allow` (#132).
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** with `feat(web): schedule form on useFieldErrors`.

### Task 15: Agent sheets (form state, New agent, Edit agent, TemplateField, ProjectGrantPicker, AddressLine)

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/agents/agent-form-state.ts`, `new-agent-sheet.tsx`, `edit-agent-sheet.tsx`, `template-field.tsx`, `project-grant-picker.tsx`, `address-line.tsx`
- Test: `apps/web/src/features/agents/new-agent-sheet.test.tsx`, `edit-agent-sheet.test.tsx`, `agent-form-state.test.ts`, `address-line.test.tsx`

**Interfaces:**
- `useAgentFormState({ …, form })`: it takes the form ref and returns `errors`, `blur(f, e)`, `attempt` and `outcome: Outcome` in place of the old `outcome` tone object.

- [ ] **Step 1: Write the failing tests.**
  - New agent:
    - Submit with no credential picked: More options opens (also after the user folded it once) and Credential gets focus.
    - A taken slug from the server opens the Address line and focuses Slug.
    - `plugin_install_failed` shows the message plus a "Show output" button in `role=alert` in the footer, and clicking the button opens the output dialog.
    - "Installing plugins…" shows as the footer notice.
    - Tabbing through untouched fields shows nothing.
    - Clicking "New template" from a changed Template field doesn't validate it.
  - Edit agent:
    - The restart notice is the footer notice and describes Save.
    - A save failure replaces it with "Couldn't reach the server. Try again." and it returns after the next edit.
    - The template field's and the projects picker's errors render in `.field-note`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - **`agent-form-state.ts`:**
    - `const f = useFieldErrors({ form, fields: FIELDS, checks: Object.fromEntries(FIELDS.map((x) => [x, () => check(x, shown)])) })`.
    - `set` and `setProjects` call `f.change(field)`. `blur = f.blur`.
    - Submit: `if (!f.submit()) return "invalid"`.
    - Server: `if (!f.server(fields)) setOutcome(...)`.
    - Outcome state is `{ error?: ReactNode; success?: ReactNode; action?: ReactNode }` plus an `outcomeKey` counter.
    - For `plugin_install_failed`, `action` is `<Button variant="ghost" size="xs" onClick={() => showOutput({ output })}>Show output</Button>` (use `hasOutput` to guard). `ShowOutput` `<details>` is no longer used here.
    - "Nothing to save: no field changed." stays a `success`.
    - Discard calls `f.reset()`.
    - Return `attempt: f.attempt`.
  - **`new-agent-sheet.tsx`:**
    - Append `inner.length > 0 ? \`attempt:${s.attempt}\` : ""` to `autoKey`.
    - Delete `wantFocus` and its effect.
    - The footer gets `outcome={{ ...s.outcome, notice: slow ? "Installing plugins…" : undefined }}`.
    - Delete the body `InlineOutcome` and the sr-only status.
    - The body becomes `field-stack`.
    - `leavesForOwnAdd` checks are deleted in favour of `data-skip-validate` on the field `action` buttons (Add credential, New template). Pass the event: `onBlur={(e) => s.blur("credential", e)}`.
  - **`edit-agent-sheet.tsx`:** the same. `above={restartNotice}` becomes `outcome={{ ...s.outcome, notice: restartNotice }}`.
  - **`template-field.tsx`:**
    - Rebuild on `FieldShell` with `action` (the New template button, `data-skip-validate`) and `below={children}`. The select renders as the control; the "No templates yet." and "No template is ready…" paragraphs render as the control too.
    - Delete the hand-rolled error.
    - The existing close-to-validate effect calls `onBlur?.()` with no event, which the hook treats as a real blur.
  - **`project-grant-picker.tsx`:**
    - `FieldShell legend` with `describedBy={noteId}` for the Custom/From the template marker.
    - The Add project and Use template default buttons get `data-skip-validate`.
    - Delete the hand-rolled error.
  - **`address-line.tsx`:** unchanged apart from being typed with `error?: string`, since it already opens on error.
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** with `feat(web): agent sheets on useFieldErrors and the footer outcome line`.

### Task 16: Compact popover and leftovers sweep

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/session/compact-popover.tsx`, and every remaining caller found by `grep -rn "focusFirstInvalid\|formError\|InlineOutcome tone=\"error\"\|flushSync" apps/web/src/features apps/web/src/routes`
- Test: `apps/web/src/features/session/` compact tests (`grep -rln "Compact" apps/web/src --include=*.test.tsx`)

- [ ] **Step 1: Write the failing test.** A failed compact shows its message in `role=alert` above the Compact button, and a second identical failure is announced again.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement.** The field becomes `FormField` (label "Focus (optional)"), so it gets the reserved note. Add `FormOutcome` with an `outcomeKey` counter above the button, and delete the conditional `<p>`. Leftover `flushSync` uses unrelated to focus (for example `new-agent-sheet.tsx:139` for stacked-sheet writes) stay.
- [ ] **Step 4: Run it and confirm it passes.** Also run `pnpm typecheck`.
- [ ] **Step 5: Commit** with `feat(web): compact popover on the shared form pieces`.

### Task 17: UI contract (AC6, class contract)

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/test/ui-contract.test.ts`, plus `ui-contract:allow` markers on the non-form lines it finds

- [ ] **Step 1: Write the failing tests**

```ts
describe("I4 field errors (AC6)", () => {
  // Per JSX element: join each opening tag with its children up to the matching close, then test the joined text.
  const elements = (src: string) => [...src.matchAll(/<(p|div|span)\b[^>]*>[\s\S]*?<\/\1>/g)].map((m) => m[0]);
  const allowed = (el: string) => /ui-contract:allow/.test(el);
  const OWNERS = ["components/field-note.tsx", "components/forms/form-outcome.tsx"];
  for (const file of sourceFiles().filter((f) => /\.(tsx)$/.test(f) && !OWNERS.some((o) => f.endsWith(o)))) {
    test(`${file.replace(SRC, "")}: no hand-rolled field or form error`, () => {
      const src = readFileSync(file, "utf8");
      const bad = elements(src).filter(
        (el) => !allowed(el) &&
          ((/CircleAlert/.test(el) && /text-destructive/.test(el)) ||
           (/role="alert"/.test(el) && /empty:hidden/.test(el))),
      );
      const conditionalAlert = [...src.matchAll(/\{[^{}]*&&\s*\(?\s*<p[^>]*role="alert"/g)].filter((m) => !/ui-contract:allow/.test(m[0]));
      expect([...bad, ...conditionalAlert.map((m) => m[0])]).toEqual([]);
    });
  }
  test("field-note transitions opacity and visibility, 150ms shown, 100ms hidden, on --ease-out", () => {
    expect(css).toMatch(/\.field-note > \*\s*{[^}]*transition:\s*opacity 100ms var\(--ease-out\),\s*visibility 100ms var\(--ease-out\)/);
    expect(css).toMatch(/\.field-note > \[data-shown\]\s*{[^}]*transition-duration:\s*150ms/);
    expect(css).toMatch(/\.field-note\s*{[^}]*font-size:\s*0\.8125rem;[^}]*line-height:\s*1\.125rem/);
  });
  test("form-outcome live regions never transition visibility", () => {
    expect(css).not.toMatch(/\.form-outcome-line[^{]*{[^}]*visibility/);
  });
  for (const f of ["input", "textarea", "select"]) {
    test(`${f}.tsx uses field-edge-transition`, () => {
      expect(readFileSync(join(SRC, `components/ui/${f}.tsx`), "utf8")).toContain("field-edge-transition");
    });
  }
});
```

- [ ] **Step 2: Run the test.** Expect it to fail on the non-form lines (session, templates, schedule state, credentials row status, `InlineOutcome`, `ErrorLine`, task detail sidebar, edit schedule `StateLine`, …).
- [ ] **Step 3: Add markers.** Put `{/* ui-contract:allow <reason> */}` or a `// ui-contract:allow <reason>` comment inside each flagged element (on its opening line), with a short reason ("load failure with Retry", "row status", "non-form status line, #132"). Do not mark a real form or field error: fix it instead.
- [ ] **Step 4: Run it and confirm it passes.**
- [ ] **Step 5: Commit** with `test(web): UI contract for field and form errors`.

### Task 18: DESIGN.md amendments

**Files:**
- Modify: `DESIGN.md` (Components → Inputs :299; Components → Validation :302; Motion → Durations :351; Motion → Frequency decides :346; Do's and Don'ts, "Don't animate anything triggered from the keyboard"; Layout :252)

- [ ] **Step 1: Apply spec §10 verbatim.** Replace the Inputs sentence. Rewrite Validation. Add the Durations and Frequency sentences. Append "(in-field feedback excepted, see Motion)" to the Don't. Add the Layout sentences.
- [ ] **Step 2: Check** with `grep -n "two short auth forms" DESIGN.md`; it must return nothing, because the auth special case is gone.
- [ ] **Step 3: Commit** with `docs: DESIGN.md amendments for field errors (I4)`.

### Task 19: Whole-branch review

- [ ] **Step 1: Review the full diff.** Run `git diff origin/main...HEAD` and check it against the spec, every AC and the Global Constraints:
  - No compatibility props remain: `grep -rn "formError\|above=\|focusFirstInvalid" apps/web/src` must be empty.
  - No form keeps its own error state.
  - No `flushSync` or `queueMicrotask` is used for focus.
  - No template literal is passed to `FieldError` or `f.set`.
- [ ] **Step 2: Review the React diff.** Invoke `vercel-react-best-practices` and check every changed `.tsx`/`.ts` in `apps/web` against it, covering re-render scope, derived state during render (the hook's unflag and the forms' attempt adjustments), effects (only the hook's layout effects and existing ones), stable callbacks where they are props of memoized children, no new barrel imports, and conditional rendering. Skip Next.js-only and server-component rules and say so in the review notes.
- [ ] **Step 3: Fix and commit** any findings (`fix(web): …`). Record what was checked in the PR body draft.

### Task 20: Full verification

- [ ] **Step 1: Run the checks in the worktree:** `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm build`. Then run `pnpm test -- --maxWorkers=50%`; do not run it while an evidence pass holds `/tmp/of-u4-evidence.lock` (check with `ls /tmp/of-u4-evidence.lock`).
- [ ] **Step 2: Run the dev loop from a clean clone.**
  - `git clone --branch i4/field-errors <origin url> "$TMPDIR/i4-clean"`, then `pnpm install`.
  - Follow the README's dev setup (database env as the README says), run `pnpm dev`, and open the web URL.
  - Sign in, open New task, blur an empty changed Title, fix it, then submit empty.
  - Stop the processes and delete the clone.
- [ ] **Step 3: Record** the commands and results for the PR body. Fix any failure first and commit it.

### Task 21: Real-browser check of the acceptance criteria (evidence pass)

**Files:**
- Create (outside the repo, owner's evidence folder): `/Users/orlevi/projects/open-factory/docs/product/ui-review/u4-evidence/i4/checks/c40_field_boxes.py`, `c41_copy_lines.py`, `c42_focus_scroll.py`, `c43_motion_frames.py`. Outputs go to `../i4/shots` and `../i4/results` (`PR=i4`).

Only one evidence pass or full test suite runs at a time on this machine. `run.sh` takes the lock. Fake Claude only; never real Claude agents or credentials.

- [ ] **Step 1: Snapshot the built branch.**
  ```bash
  cd /Users/orlevi/projects/open-factory/docs/product/ui-review/u4-evidence/harness
  ./snapshot.sh /Users/orlevi/projects/open-factory/.worktrees/i4-field-errors $TMPDIR/u4-evidence-snapshot-i4
  ```
- [ ] **Step 2: Write `c40_field_boxes.py`** with `u4lib`:
  - Run every form in spec §4: sign-in, sign-up (bootstrap), New task, task detail editors, New and Edit schedule, New and Edit agent, New template, Add credential/project/secret (sheet and inline), the settings row forms, Factory settings, the compact popover and ConfirmDialog.
  - Variants:
    - `(1440,"light",False)`, `(390,"light",False)` and `(320,"light",False)`.
    - 200% text by default font size, not page zoom: in a new context, `page.add_init_script("document.documentElement.style.fontSize='200%'")` at 1920×1080 and 390×844.
    - Engines: Chromium, and WebKit with `U4_ENGINE=webkit`.
  - For each form:
    1. Record `getBoundingClientRect` of every `[data-field]`, the MoreOptions header, `.form-outcome` and every footer button.
    2. Type into the first field, change it to invalid, and blur by clicking an empty area of the form. Record.
    3. Fix it. Record.
    4. Submit empty. Record.
    5. Assert equal boxes (±0.5px), except spec §2 AC1 (a)–(d). Label each exception in the result's `detail`.
  - Screenshot every state.
- [ ] **Step 3: Write `c41_copy_lines.py`.** At 390 and at 100%, trigger each form's errors and assert that every visible `.field-note` and `.form-outcome` is one line tall: `height <= parseFloat(getComputedStyle(el).lineHeight) + 0.5`. Report hits at 320 as findings, not failures.
- [ ] **Step 4: Write `c42_focus_scroll.py`.**
  - After a failing submit in New agent (credential inside a folded More options) and New task (links), at 390×844 and 1440×900, assert that the focused element's `[data-field]` box is inside its scroll container's visible rect.
  - Open ConfirmDialog (archive with a mocked failure via the fake server, or the delete-schedule failure path) with a long body at 200%. Assert that the alert is visible without scrolling.
  - At 390, assert that link rows and the checkbox and switch rows don't run together: the gap between rows is ≥ 12px. Screenshot for eyes.
- [ ] **Step 5: Write `c43_motion_frames.py`.**
  - In both engines, record a video (`record_video_dir`) of the Factory warm-window field going help → error → help, for eyes.
  - In the same run, sample `getComputedStyle(layer).opacity` of both note layers every 16ms (`requestAnimationFrame` loop in `page.evaluate`) through each swap, with the real `--ease-out`. Assert that no sample has both layers at ≥ 0.5.
  - Record a submit with Enter, and assert that focus is on the field in the first sampled frame.
- [ ] **Step 6: Run the pass.**
  ```bash
  REPO=$TMPDIR/u4-evidence-snapshot-i4 PR=i4 ./run.sh ../i4/checks/c40_field_boxes.py ../i4/checks/c41_copy_lines.py ../i4/checks/c42_focus_scroll.py ../i4/checks/c43_motion_frames.py
  U4_ENGINE=webkit REPO=$TMPDIR/u4-evidence-snapshot-i4 PR=i4 ./run.sh ../i4/checks/c40_field_boxes.py ../i4/checks/c41_copy_lines.py ../i4/checks/c43_motion_frames.py
  jq '.failed' ../i4/results/*.json
  ```
- [ ] **Step 7: Fix and re-run.** Allow one fix round (commit fixes on the branch, re-snapshot, re-run the failed checks). Anything left goes into the PR body as a finding.
  - If the 150/100 crossfade shows legible double-drawn text, switch the hidden layer's duration to `0ms` (spec Q17's fallback), note it in the PR, and update DESIGN.md's Durations sentence to match.
  - If link rows don't read as a list at 390, don't change the layout: put it in the PR body as a question for Or.
- [ ] **Step 8: VoiceOver check.** Manual, only if a person is available; otherwise list it in the PR's checklist for Or. In Safari with VoiceOver, a FormOutcome failure is announced once, and again on an identical second failure.

### Task 22: Push

- [ ] **Step 1: Push** with `git push -u origin i4/field-errors`.

### Task 23: Open the PR

- [ ] **Step 1: Write the body** following `.github/pull_request_template.md` and AGENTS.md, with the template's HTML comments removed.
  - **Title:** `feat(web): field errors that never move the layout`.
  - **What / Why:** from spec §1.
  - **Approach:** one bullet per decision in "<decision>, rather than <alternative>, because <reason>" form, drawn from spec §1.1 and D1–D14.
  - **Changes:** grouped as primitives, forms, copy (shared/server/web), DESIGN.md and tests.
  - **Links:** the spec and plan (on `spec/i4-field-errors`), #131, and follow-ups #132 and #133.
  - **Evidence:** the evidence results table and screenshots path (`docs/product/ui-review/u4-evidence/i4/`), plus Task 20's verification output.
  - **For Or:** Q5, Q6/Q17, Q15 and Q14 with their proxy certainty, plus any Task 21 findings.
  - **Ending:** `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 2: Create the PR** with `gh pr create --base main --head i4/field-errors --title "feat(web): field errors that never move the layout" --body-file <file>`. Never merge.

### Task 24: CI until green

- [ ] **Step 1: Watch CI** with `gh pr checks --watch`.
- [ ] **Step 2: Fix failures.** On a failure, read the log (`gh run view --log-failed`), reproduce locally with the targeted test, fix, commit and push. Repeat until every check is green, then report the PR URL and the final check list.
