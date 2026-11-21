# U1 UI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. One fresh implementer subagent per task, then a reviewer, then a fix round, **one commit per task**. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing web UI correct and consistent before U2–U4: the U1 bug list, the DESIGN.md amendments, the overlay primitives (adaptive `Sheet`, Vaul `Drawer`, adaptive `ConfirmDialog`, mobile nav drawer), one control system, timeline render performance, the PR #76 follow-ups and perceived-speed fixes.

**Architecture:** Foundations first: DESIGN.md text and CSS tokens, then the data layer (query client, loaders), then primitives under `apps/web/src/components/ui/` with their own tests, then the call sites that consume them, then the timeline performance work in `features/session/`, then motion polish and perceived speed. Every primitive keeps its current export names where it exists today (`ConfirmDialog`, `Sheet*`, `DropdownMenu*`), so callers change only where the spec says so.

**Tech Stack:** React 19, TanStack Router 1.170 / Query 5.107, Radix (`radix-ui` 1.8.1), Tailwind 4.3.5 + tw-animate-css, **Vaul 1.1.2 (new, exact pin)**, Vitest 5 + Testing Library (jsdom), Fastify 5 (one server file), Biome.

**Spec:** `docs/superpowers/specs/2026-11-21-u1-ui-foundation-design.md`. The spec wins over this plan on any conflict. Decision log: https://github.com/orlevii/open-factory/issues/77. Follow-ups that are NOT U1 work and stay open: #78–#83.

The four spec self-contradictions found while planning (§2.3, §12.4, §12.5, §13) have been corrected in the spec. The DESIGN.md detail-title row is `| Detail title (task, in the page body) | Archivo | 20 / 28 | 650 |`.

## Global Constraints

- **React rule:** every task that touches `apps/web` says "Implementer and reviewer invoke `vercel-react-best-practices` and follow it". This is binding (React + Vite + TanStack, not Next.js: skip server-component and Next-only rules).
- **TDD:** each task writes the failing test first, runs it red, implements, runs it green, then runs `pnpm typecheck` and `pnpm lint` before committing.
- **Commands** (from the worktree root):
  - one web file: `pnpm --filter @open-factory/web exec vitest run <path relative to apps/web>`;
  - one server file: `pnpm vitest run apps/server/src/<file>.test.ts`;
  - all tests: `pnpm test`; types: `pnpm typecheck`; lint: `pnpm lint` (`pnpm lint:fix` formats); at the end `pnpm lint:ci` and `pnpm build`.
- **Commits:** conventional message, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the model the implementer actually runs as). The PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Dependencies:** only `vaul@1.1.2`, added with `pnpm --filter @open-factory/web add --save-exact vaul@1.1.2`. Its `@radix-ui/react-dialog ^1.1.1` resolves to the `1.3.1` already in `pnpm-lock.yaml`. **Never loosen any pnpm supply-chain setting**, no overrides, no exceptions. No `cmdk`, no Sonner, no new shadcn components beyond those written here.
- **Tokens and copy (verbatim from the spec):**
  - `--float-edge`: light `oklch(0.80 0.006 255)`, dark `oklch(0.38 0.008 255)`, increased contrast = `var(--input)`.
  - Avatars: `oklch(0.62 0.07 H)` light / `oklch(0.70 0.07 H)` dark, H = 120, 180, 205, 230, 270, 295, 320, 345.
  - Scrim: `bg-black/20 dark:bg-black/40`.
  - Durations: menus/popovers/selects/tooltips 100ms in, 75ms out; dialogs 150ms in, 100ms out (exit is a fade only); sheets/drawers 250ms in on `--ease-drawer`, 200ms out on `--ease-out`; a drag-initiated drawer close 300ms on `--ease-drawer`.
  - Tooltip delay 400ms, skip 300ms.
  - Composer size error: `This message is {n} KB; the limit is 64 KB. Shorten it to send.` with `n = Math.ceil(bytes / 1024)`.
  - Home: `No agents yet.`, `New agent`, `Couldn't load agents.`, `All {N} agents`.
- **Mobile** means `useIsMobile()` with the query `(width < 48rem)` (Task 6). Adaptive overlays decide dialog-or-drawer once per opening (`useLatchedMobile`, Task 8).
- **No shadow** on any floating layer; no `outline-none` / `outline-hidden` / `ring-3` / `ring-ring/50` anywhere in `apps/web/src` outside the menu/select item allowlist (enforced by `src/test/ui-contract.test.ts`, created in Task 2 and extended later).
- **Manual checks** are recorded in the PR, never claimed without evidence. Stress data comes from `seed-worst.mjs` in `/Users/orlevi/.claude/jobs/7530b76c/tmp/break-ui/`, run only against a cloned database, never the shared one.

## File map

**New:**
- `apps/web/src/lib/query-client.ts` (+ `.test.ts`): `shouldRetry`, `createQueryClient`.
- `apps/web/src/lib/input-modality.ts` (+ `.test.ts`): last input modality, `useKeyboardOpened`.
- `apps/web/src/lib/run-instant.ts`: one-frame root `data-instant`.
- `apps/web/src/lib/send-key.ts` (+ `.test.ts`): `isSendKey`.
- `apps/web/src/hooks/use-latched-mobile.ts` (+ `.test.tsx`).
- `apps/web/src/components/ui/drawer.tsx` (+ `drawer.test.tsx`), `select.tsx` (+ test), `radio-group.tsx`, `segmented-control.tsx` (+ test), `spinner.tsx`.
- `apps/web/src/components/ui/sheet.test.tsx`, `components/confirm-dialog.test.tsx` already exists under `src/test/` (extended).
- `apps/web/src/features/agents/home-agents.tsx` (+ `.test.tsx`).
- `apps/web/src/features/session/timeline-item.tsx` (+ `timeline-perf.test.tsx`).
- `apps/web/src/test/ui-contract.test.ts`: source and stylesheet scans.

**Modified (main ones):** `DESIGN.md`, `styles.css`, `main.tsx`, `router.tsx`, `test/render-app.tsx`, `test-setup.ts`, `hooks/use-mobile.ts`, every file in `components/ui/` listed per task, `components/confirm-dialog.tsx`, `components/page-header.tsx`, `components/route-states.tsx`, `components/markdown/{markdown,code-block,highlight}.tsx|ts`, `features/session/{use-session,session-state,rows,timeline,composer,interrupt-button,tool-call-row,quiet-line,compaction-marker}.ts(x)`, `features/tasks/{task-detail,comment-composer,link-editor,task-filters,agent-picker,assignee-menu,task-list}.tsx`, `features/agents/{agent-form,agent-tree,project-grant-picker}.tsx`, `features/schedules/{schedule-form,schedule-filters,when-field,timezone-select,schedule-row}.tsx`, `features/settings/*`, `features/templates/*`, `features/inbox/inbox-row.tsx`, `features/usage/range-filter.tsx`, `routes/_app.tsx`, `routes/_app/{index,agents.index,agents.$slug,tasks.$key,schedules.$key,templates.$name,templates.index,templates.new}.tsx`, `apps/server/src/errors.ts` (+ test).

---

## Phase A: foundations

### Task 1: DESIGN.md amendments

**DESIGN.md sections implemented:** front matter; Overview; Colors → Primary, Agent identity (new); Typography → Hierarchy, Named Rules; Layout; Elevation & Depth; Shapes → The pitch; Components (Buttons, Form controls, Rows, Overlays, Toasts, Composers, Empty states, Browser surfaces); Motion (Frequency, Curves, Durations, Popovers, Reduced motion, Gesture UI, Performance, Deliberately not used); Do's and Don'ts.

**Files:**
- Modify: `DESIGN.md`
- Test: `apps/web/src/test/design-doc.test.ts` (new)

Docs only, no React code in this task.

- [ ] **Step 1: Write the failing test.** It pins the phrases that must exist and the ones that must be gone, so later edits can't silently drop an amendment.

```ts
// apps/web/src/test/design-doc.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const doc = readFileSync(fileURLToPath(new URL("../../../../DESIGN.md", import.meta.url)), "utf8");

test.each([
  'float-edge: "oklch(0.80 0.006 255)"',
  'night-float-edge: "oklch(0.38 0.008 255)"',
  "heading-detail:",
  "button-outline:",
  "Agent identity",
  "| Detail title (task, in the page body) | Archivo | 20 / 28 | 650 |",
  "A document never outranks its title.",
  "Live lists never reorder under the pointer",
  "A toast appears only when the control that caused an outcome is gone",
  "Enter sends in every composer",
  "Linear only for constant rotation (the spinner).",
  "A peek sheet does not dim or trap focus",
  "20% in light mode and 40% in dark",
  "Nothing has a shadow.",
  "Drawers use Vaul (pinned exactly)",
])("DESIGN.md contains %s", (phrase) => {
  expect(doc).toContain(phrase);
});

test.each([
  "the warm orange is the only temperature on screen",
  "On mobile the sidebar becomes a sheet.",
  "the caret and checkbox accent are signal",
  "Springs and the Motion library, until something can be dragged.",
  "toasts or modals for routine tasks",
  'height: "36px"\n  button-ghost',
])("DESIGN.md no longer contains %s", (phrase) => {
  expect(doc).not.toContain(phrase);
});
```

- [ ] **Step 2: Run it red.** `pnpm --filter @open-factory/web exec vitest run src/test/design-doc.test.ts` → FAIL (missing phrases).

- [ ] **Step 3: Apply every amendment in spec §12.1–§12.9 verbatim**, with the four corrections listed at the top of this plan (task-only detail-title row; 20/40% scrim wording in Elevation & Depth). Front matter: add the colors, the typography entry and the component entries exactly as §12.1 lists them, and change `button-primary.height`, `button-ghost.height`, `input.height` to `"32px"`.

- [ ] **Step 4: Run it green**, then `pnpm lint`.

- [ ] **Step 5: Commit** `docs(design): U1 amendments to DESIGN.md`.

---

### Task 2: Stylesheet foundations and the UI contract test

**DESIGN.md sections implemented:** Colors (float-edge, avatar tokens); Shapes → The pitch (loading mark); Components → Markdown, Rows, Browser surfaces; Motion → Frequency (keyboard rule), Reduced motion, Deliberately not used (status dots).

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/styles.css` (`:root` ~66-150, `:root[data-theme="dark"]` 152-205, both `prefers-contrast` blocks 209-235, `.of-ignite` 247-261, `.prose-of` 264-361, the base layer 403-468)
- Create: `apps/web/src/test/ui-contract.test.ts`

- [ ] **Step 1: Write the failing contract test.** It reads `styles.css` and the source tree as text.

```ts
// apps/web/src/test/ui-contract.test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(SRC, "styles.css"), "utf8");

export function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".gen.ts") ? [p] : [];
  });
}

describe("styles.css", () => {
  test("float-edge is a token in both themes and the theme map", () => {
    expect(css).toMatch(/--float-edge:\s*oklch\(0\.8 0\.006 255\)|--float-edge:\s*oklch\(0\.80 0\.006 255\)/);
    expect(css).toMatch(/--float-edge:\s*oklch\(0\.38 0\.008 255\)/);
    expect(css).toContain("--color-float-edge: var(--float-edge)");
  });
  test("eight avatar tokens per theme", () => {
    for (const h of [120, 180, 205, 230, 270, 295, 320, 345]) {
      expect(css).toContain(`oklch(0.62 0.07 ${h})`);
      expect(css).toContain(`oklch(0.7 0.07 ${h})`);
    }
  });
  test("the loading mark animates only when motion is allowed", () => {
    const gate = css.match(/@media \(prefers-reduced-motion: no-preference\)\s*{[^}]*\.of-ignite\s*{[^}]*animation:\s*of-ignite/);
    expect(gate).not.toBeNull();
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\)\s*{[\s\S]*?}\s*}/g, "");
    expect(outside).not.toMatch(/\.of-ignite\s*{[^}]*animation/);
  });
  test("keyboard-opened overlays never animate", () => {
    expect(css).toMatch(/\[data-instant\],\s*\[data-instant\] \*\s*{[^}]*animation:\s*none !important/);
  });
  test("prose wraps long tokens but table cells only break-word", () => {
    expect(css).toMatch(/\.prose-of :is\(p, li, blockquote\)\s*{\s*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.prose-of :is\(td, th\)\s*{\s*overflow-wrap:\s*break-word/);
  });
  test("task lists are graphite", () => {
    expect(css).toMatch(/input\[type="checkbox"\]\)\s*{\s*accent-color:\s*var\(--foreground\)/);
  });
  test("rows have one hover/press recipe with an inset ring", () => {
    expect(css).toMatch(/\.of-row\s*{[^}]*transition:\s*background-color 150ms var\(--ease-out\)/);
    expect(css).toMatch(/\.of-row:focus-visible\s*{[^}]*outline-offset:\s*-2px/);
  });
  test("status dots change colour over 150ms", () => {
    expect(css).toMatch(/\[data-status-dot\]\s*{[^}]*transition:\s*background-color 150ms/);
  });
});
```

- [ ] **Step 2: Run red.** `pnpm --filter @open-factory/web exec vitest run src/test/ui-contract.test.ts` → FAIL.

- [ ] **Step 3: Edit `styles.css`.**
  - `@theme inline`: add `--color-float-edge: var(--float-edge);` and `--color-avatar-1` … `--color-avatar-8: var(--avatar-N);`.
  - `:root`: `--float-edge: oklch(0.80 0.006 255);` and `--avatar-1: oklch(0.62 0.07 120);` … `--avatar-8: oklch(0.62 0.07 345);`. Dark (`:root[data-theme="dark"]`): `--float-edge: oklch(0.38 0.008 255);`, `--avatar-N: oklch(0.7 0.07 H)`. Both `prefers-contrast: more` blocks: `--float-edge: var(--input);`. (Biome's formatter may print `0.80` as `0.8`; the test accepts both.)
  - Loading mark (replace lines 247-261 and delete `.of-ignite { animation: none; }` from the base reduced-motion block at ~464):
    ```css
    @keyframes of-ignite {
      0% { clip-path: inset(0 100% 0 0); opacity: 1; }
      60% { clip-path: inset(0); }
      85% { opacity: 1; }
      100% { clip-path: inset(0); opacity: 0; }
    }
    /* Still and lit by default; it only animates when motion is allowed (DESIGN.md → The pitch). */
    .of-ignite { clip-path: inset(0); }
    @media (prefers-reduced-motion: no-preference) {
      .of-ignite { animation: of-ignite 1.2s var(--ease-out) infinite; }
    }
    ```
  - Prose overflow (after the `.prose-of` token block):
    ```css
    .prose-of :is(p, li, blockquote) { overflow-wrap: anywhere; }
    .prose-of :is(a, :not(pre) > code):not(td *, th *) { overflow-wrap: anywhere; }
    .prose-of :is(td, th) { overflow-wrap: break-word; }
    ```
  - Task lists (`styles.css:360`): `accent-color: var(--foreground);`.
  - Rows, in a new `@layer components { … }` block:
    ```css
    @layer components {
      .of-row { transition: background-color 150ms var(--ease-out); }
      @media (hover: hover) and (pointer: fine) { .of-row:hover { background: var(--accent); } }
      .of-row:active { background: color-mix(in oklch, var(--accent), var(--foreground) 6%); transition-duration: 0ms; }
      @media (pointer: coarse) { .of-row:active { transition-delay: 80ms; } }
      .of-row:focus-visible { outline-offset: -2px; }
      [data-status-dot] { transition: background-color 150ms var(--ease-out); }
    }
    ```
  - Base layer: remove `outline-ring/50` from the `*` rule (keep `border-border`); replace the `:root[data-instant] *` rule with
    ```css
    /* Keyboard-initiated: a root flag for one frame (⌘B), or a stamp on an overlay for its whole opening. */
    [data-instant],
    [data-instant] * {
      /* biome-ignore lint/complexity/noImportantStyles: must beat every component animation and transition. */
      animation: none !important;
      /* biome-ignore lint/complexity/noImportantStyles: as above. */
      transition-duration: 0s !important;
    }
    ```

- [ ] **Step 4: Run green**, plus `pnpm --filter @open-factory/web exec vitest run` (the whole web suite still passes: nothing else changed), `pnpm typecheck`, `pnpm lint`.

- [ ] **Step 5: Commit** `feat(web): U1 tokens, loading mark, prose wrapping and row recipe`.

---

### Task 3: Shared query client and retry rule (R1, R5)

**DESIGN.md sections implemented:** none.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/lib/query-client.ts`, `apps/web/src/lib/query-client.test.ts`
- Modify: `apps/web/src/main.tsx:12-22`, `apps/web/src/test/render-app.tsx:16`

**Interfaces:**
- Produces: `shouldRetry(failureCount: number, error: unknown): boolean`; `createQueryClient(overrides?: DefaultOptions): QueryClient`.

- [ ] **Step 1: Failing test.**

```ts
// apps/web/src/lib/query-client.test.ts
import { ApiError } from "@open-factory/shared";
import { expect, test } from "vitest";
import { z } from "zod";
import { createQueryClient, shouldRetry } from "./query-client";

const zodError = (() => { try { z.string().parse(1); } catch (e) { return e; } })();

test.each([
  ["404", new ApiError(404, "not_found", "x"), false],
  ["400", new ApiError(400, "validation_error", "x"), false],
  ["ZodError", zodError, false],
  ["500", new ApiError(500, "internal_error", "x"), true],
  ["408", new ApiError(408, "http_408", "x"), true],
  ["429", new ApiError(429, "http_429", "x"), true],
  ["TypeError", new TypeError("Failed to fetch"), true],
])("%s retries: %s", (_n, err, retries) => {
  expect(shouldRetry(0, err)).toBe(retries);
});

test("retries stop after three", () => {
  const e = new TypeError("Failed to fetch");
  expect([0, 1, 2, 3].map((n) => shouldRetry(n, e))).toEqual([true, true, true, false]);
});

test("production defaults, overridable for tests", () => {
  const qc = createQueryClient();
  expect(qc.getDefaultOptions().queries?.staleTime).toBe(30_000);
  expect(qc.getDefaultOptions().queries?.retry).toBe(shouldRetry);
  const t = createQueryClient({ queries: { retry: false } });
  expect(t.getDefaultOptions().queries?.retry).toBe(false);
  expect(t.getDefaultOptions().queries?.staleTime).toBe(30_000);
});
```

- [ ] **Step 2: Red** (`pnpm --filter @open-factory/web exec vitest run src/lib/query-client.test.ts`: module not found).

- [ ] **Step 3: Implement.**

```ts
// apps/web/src/lib/query-client.ts
import { ApiError } from "@open-factory/shared";
import { type DefaultOptions, QueryClient } from "@tanstack/react-query";
import { ZodError } from "zod";

/** A 4xx won't change on retry (except 408 and 429, which are transient); a response that fails its
 *  schema won't either. Network errors and 5xx retry up to three times. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 3) return false;
  if (error instanceof ZodError) return false;
  if (error instanceof ApiError && error.status < 500 && error.status !== 408 && error.status !== 429)
    return false;
  return true;
}

/** One client for the app and the tests: the tests run the production defaults (pr76 R1). */
export function createQueryClient(overrides?: DefaultOptions): QueryClient {
  return new QueryClient({
    defaultOptions: {
      ...overrides,
      // Loader-prefetched data is fresh on mount; WebSocket events invalidate what changes on the server.
      queries: { staleTime: 30_000, retry: shouldRetry, ...overrides?.queries },
    },
  });
}
```
  `main.tsx`: `const queryClient = createQueryClient();` (drop the inline client and the `ApiError` import). `render-app.tsx:16`: `const queryClient = createQueryClient({ queries: { retry: false } });`.

- [ ] **Step 4: Green**, then the whole web suite: `pnpm --filter @open-factory/web exec vitest run`. Tests that now fail because data stays fresh for 30s are fixed by asserting the real behaviour (an explicit `invalidateQueries`, or seeding the cache), **never** by overriding `staleTime` back to 0. Then `pnpm typecheck`, `pnpm lint`.

- [ ] **Step 5: Commit** `fix(web): one query client for the app and tests; retry 408/429, never schema errors`.

---

### Task 4: Preload-aware detail loaders (R2)

**DESIGN.md sections implemented:** none.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/routes/_app/tasks.$key.tsx:13-20`, `schedules.$key.tsx:9-16`, `templates.$name.tsx:11-18`
- Test: `apps/web/src/test/preload-loaders.test.tsx` (new)

- [ ] **Step 1: Failing test.** Render the app at `/tasks` with the mocked API (`test/mock-api.ts`), hover a task link (`fireEvent.mouseEnter` / `focus`), advance 60ms, click it, and count `GET /api/tasks/T-1` calls: expect exactly 1. Same for a schedule link (`/schedules` → `/schedules/:key`). Use the existing `renderApp` and the fetch mock pattern from `test/settings.test.tsx`.

- [ ] **Step 2: Red** (2 requests today).

- [ ] **Step 3: Implement**, per loader:
```tsx
loader: async ({ context, params, preload }) => {
  const opts = taskDetailOptions(params.key);
  try {
    // A hover warms the cache once; the click within 5s reuses it (pr76 R2).
    await (preload
      ? context.queryClient.ensureQueryData(opts)
      : context.queryClient.fetchQuery({ ...opts, staleTime: 5_000 }));
  } catch (e) {
    if (e instanceof ApiError && e.code === "task_not_found") throw notFound();
  }
},
```
  Templates: same branch with `templateQueryOptions(params.name)` (its own `staleTime: 0` stays for the page's `useQuery`); templates are not in the one-request test (spec §10.2).

- [ ] **Step 4: Green**, typecheck, lint. **Step 5: Commit** `fix(web): hover preloads no longer double-fetch task and schedule details`.

---

### Task 5: Task save race, stale lists, reconnect (R3, R4)

**DESIGN.md sections implemented:** none.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/tasks/task-detail.tsx:131-140`; `features/settings/api.ts:23,47,60`; `features/templates/api.ts:19`; `routes/_app.tsx:116-126`
- Test: `apps/web/src/features/tasks/task-detail.test.tsx` (extend), `apps/web/src/test/ws-hub.test.tsx` (extend)

- [ ] **Step 1: Failing tests.**
  - Task save: start a detail GET that is held open (a deferred promise in the fetch mock), PATCH the title, resolve the PATCH with title "New", then resolve the stale GET with title "Old"; assert the heading still reads "New".
  - Reconnect: with a mounted inbox and tasks list, simulate the socket closing and reopening (second `onOpen`); assert both lists refetched (fetch mock call counts +1 each).
  - Focus refetch: `["credentials"]` refetches on `window` focus even within 30s (`focusManager.setFocused(false/true)`).

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**
  - `task-detail.tsx`:
    ```ts
    onSuccess: async (r) => {
      const detailKey = taskDetailOptions(taskKey).queryKey;
      // An older detail GET still in flight would land on top of the saved task (pr76 R3).
      await qc.cancelQueries({ queryKey: detailKey });
      qc.setQueryData(detailKey, r.task);
      void qc.invalidateQueries({
        queryKey: tasksQueryKey,
        predicate: (q) => !(q.queryKey[1] === "detail" && q.queryKey[2] === taskKey),
      });
    },
    ```
  - `settings/api.ts` credentials, secrets, projects query options and the templates list options: `staleTime: 0` with a comment ("no WebSocket event invalidates it: refetch on focus and mount").
  - `_app.tsx` `onOpen` reconnect branch: `void qc.invalidateQueries();` (only mounted queries refetch) replacing the `usage` and `runningQueryKey` invalidations.

- [ ] **Step 4: Green**, typecheck, lint. **Step 5: Commit** `fix(web): task saves win over in-flight fetches; stale lists refetch; reconnect invalidates all`.

---

### Task 6: Mobile breakpoint, highlighter and code-block nits

**DESIGN.md sections implemented:** Layout (breakpoint wording).

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/hooks/use-mobile.ts`; `components/ui/sidebar.tsx` (export the shared breakpoint use); `components/markdown/highlight.ts:50,97`; `components/markdown/code-block.tsx:20-27`
- Test: `apps/web/src/test/use-mobile.test.ts` (extend), `components/markdown/code-block.test.tsx` (update), `components/markdown/highlight.test.ts` (new)

**Interfaces:**
- Produces: `MOBILE_QUERY = "(width < 48rem)"` exported from `hooks/use-mobile.ts`; `useIsMobile(): boolean` (unchanged signature).

- [ ] **Step 1: Failing tests.**
  - `use-mobile.test.ts`: the hook calls `matchMedia` with `"(width < 48rem)"`; installing a new fake `matchMedia` between two renders makes the hook read the new one (cache keyed on the function identity); `matchMedia` is called once per render cycle, not once per consumer render (spy count with two consumers).
  - `highlight.test.ts`: `resolveLang("console") === "shellsession"`, and `ps1`, `powershell`, `hcl`, `terraform`, `proto`, `env` resolve to a loaded grammar (use the module's existing alias lookup export; if it has none, export `resolveLang` for the test). A failed grammar load rejects once and a second call retries (the `.catch` is attached once).
  - `code-block.test.tsx`: change the "keeps the old HTML" case: with the language unchanged the old HTML stays; with a language change the new code renders as plain text until its highlight resolves.

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**
  ```ts
  // hooks/use-mobile.ts
  import { useSyncExternalStore } from "react";
  /** Below md (48rem): the same breakpoint as the desktop sidebar, in rem so it follows the browser's text size. */
  export const MOBILE_QUERY = "(width < 48rem)";
  let cached: { fn: typeof window.matchMedia; mql: MediaQueryList } | undefined;
  /** One MediaQueryList per matchMedia function (tests install a fresh fake per test). */
  function mql(): MediaQueryList {
    if (cached?.fn !== window.matchMedia) cached = { fn: window.matchMedia, mql: window.matchMedia(MOBILE_QUERY) };
    return cached.mql;
  }
  function subscribe(onChange: () => void) {
    const m = mql();
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }
  const getSnapshot = () => mql().matches;
  export function useIsMobile() {
    return useSyncExternalStore(subscribe, getSnapshot);
  }
  ```
  `highlight.ts`: `console: "shellsession"`, add `ps1`/`powershell` → `powershell`, `hcl`/`terraform` → `hcl` (Shiki ids exist: verified), `proto`, `env` → `dotenv`; move `.catch` inside the `??=` initializer. `code-block.tsx`: store `{ lang, html }`; render the stored html only when `stored.lang === lang`, otherwise `<pre><code>{code}</code></pre>` until the new highlight resolves.

- [ ] **Step 4: Green** (incl. `src/test/shell.test.tsx`, which exercises the sidebar on mobile), typecheck, lint. **Step 5: Commit** `fix(web): rem-based phone breakpoint; highlighter aliases; code blocks never show stale code`.

---

### Task 7: Remaining #76 nits (schedule form, link editor, composer key, agent form, comment draft)

**DESIGN.md sections implemented:** none.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `features/schedules/schedule-form.tsx:117-127`; `features/tasks/task-detail.tsx:222,651-652`; `features/agents/agent-form.tsx:176-184`; `features/tasks/comment-composer.tsx:87`
- Test: `features/schedules/schedule-form.test.tsx` (extend), `features/tasks/task-detail.test.tsx`, `test/agent-form.test.tsx`, `features/tasks/comment-composer.test.tsx` (extend or create)

- [ ] **Step 1: Failing tests.**
  - Schedule form: after a server sync, the preview text equals the expected human summary for the merged value (assert the exact string, not just "changed").
  - Link editor: right after clicking Edit links, Save is disabled until the agent lists resolve; the lists' fetch starts on the Edit click.
  - Comment composer: type "a", post (held), type "b" while posting, resolve: the draft is "ab" (not cleared); with no typing during the post the draft clears.
  - Agent form: the "slow" line appears only when pending with plugins after the timer, and disappears on settle, with no effect-driven reset (behavioural test; keep the existing ones green).

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**
  - `schedule-form.tsx`: a pure `mergeServer(prev, server)` helper; the effect calls `setV((prev) => mergeServer(prev, server))`; the preview uses `mergeServer(v, server)` in render.
  - `task-detail.tsx`: `<CommentComposer taskKey={taskKey} …>` (route param); link editor: `const known = useQuery(...)`; `onClick` of Edit links calls `void qc.prefetchQuery(agentListsOptions)`; Save `disabled={known === undefined}`.
  - `agent-form.tsx`: `const [timerFired, setTimerFired] = useState(false)` set by a timeout started when pending begins (cleared in the effect cleanup); `const slow = pending && pluginCount > 0 && timerFired;` (no reset effect).
  - `comment-composer.tsx:87`: `setDraft((cur) => (cur === posted ? "" : cur.startsWith(posted) ? cur.slice(posted.length) : cur));`.

- [ ] **Step 4: Green**, typecheck, lint. **Step 5: Commit** `fix(web): #76 nits (schedule sync, link editor, comment draft, agent form)`.

---

## Phase B: primitives

### Task 8: Input modality, root-instant helper, latched mobile hook

**DESIGN.md sections implemented:** Motion → Frequency (keyboard rule).

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/lib/input-modality.ts` (+ `.test.ts`), `apps/web/src/lib/run-instant.ts`, `apps/web/src/hooks/use-latched-mobile.ts` (+ `.test.tsx`), `apps/web/src/test/fake-match-media.ts` (shared by Tasks 8, 16, 17, 18, 28)
- Modify: `apps/web/src/main.tsx` (install once), `apps/web/src/components/ui/sidebar.tsx:95-110` (use `runInstant`)

**Interfaces:**
- Produces: `installInputModality(doc?: Document): () => void`; `lastInputModality(): "keyboard" | "pointer"`; `useKeyboardOpened(): boolean` (read once at mount); `runInstant(fn: () => void): void`; `useLatchedMobile(open: boolean): boolean`.

- [ ] **Step 1: Failing tests.**

```ts
// lib/input-modality.test.ts
import { renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { installInputModality, lastInputModality, useKeyboardOpened } from "./input-modality";

let off = () => {};
afterEach(() => off());

test("records the last input", () => {
  off = installInputModality();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(lastInputModality()).toBe("keyboard");
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(lastInputModality()).toBe("pointer");
});

test("useKeyboardOpened reads once at mount", () => {
  off = installInputModality();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const { result, rerender } = renderHook(() => useKeyboardOpened());
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  rerender();
  expect(result.current).toBe(true);
});
```

```tsx
// hooks/use-latched-mobile.test.tsx: flip a fake matchMedia while open
test("keeps the primitive chosen at open until it closes", () => {
  const mm = fakeMatchMedia.install(false); // src/test/fake-match-media.ts
  const { result, rerender } = renderHook(({ open }) => useLatchedMobile(open), { initialProps: { open: true } });
  expect(result.current).toBe(false);
  act(() => mm.set(true));
  rerender({ open: true });
  expect(result.current).toBe(false);
  rerender({ open: false });
  rerender({ open: true });
  expect(result.current).toBe(true);
});
```

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**

```ts
// lib/input-modality.ts
import { useState } from "react";

let last: "keyboard" | "pointer" = "pointer";

/** Capture-phase listeners: an overlay opened right after a key press was opened from the keyboard. */
export function installInputModality(doc: Document = document): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Shift" && e.key !== "Meta" && e.key !== "Control" && e.key !== "Alt") last = "keyboard";
  };
  const onPointer = () => {
    last = "pointer";
  };
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("pointerdown", onPointer, true);
  return () => {
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("pointerdown", onPointer, true);
    last = "pointer";
  };
}

export const lastInputModality = () => last;

/** For overlay content, which mounts once per opening: whether this opening came from the keyboard. */
export function useKeyboardOpened(): boolean {
  const [keyboard] = useState(() => last === "keyboard");
  return keyboard;
}
```

```ts
// lib/run-instant.ts
/** A keyboard-triggered transition (⌘B): suspend transitions and animations for the frame that applies it. */
export function runInstant(fn: () => void) {
  const root = document.documentElement;
  root.dataset.instant = "";
  fn();
  requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.instant));
}
```

```ts
// hooks/use-latched-mobile.ts
import { useState } from "react";
import { useIsMobile } from "./use-mobile";

/** Dialog or drawer is decided when an overlay opens and kept until it closes (spec §5.1): a resize or
 *  rotation never swaps the primitive under a pending request or a draft. */
export function useLatchedMobile(open: boolean): boolean {
  const isMobile = useIsMobile();
  const [prevOpen, setPrevOpen] = useState(open);
  const [latched, setLatched] = useState(isMobile);
  // Adjusting state on a prop edge during render (no effect): the open render already uses the new value.
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setLatched(isMobile);
  }
  // Kept after close too, so the exit animation plays on the primitive that opened.
  return latched;
}
```
  Add to the test: after closing, flipping `matchMedia` doesn't change the value until the next open.
  `test/fake-match-media.ts`:
```ts
type Listener = (e: MediaQueryListEvent) => void;
/** A window.matchMedia whose lists all share one `matches` flag (per query family: width vs pointer). */
export const fakeMatchMedia = {
  install(matches: boolean, { coarse = false } = {}) {
    const state = { width: matches, coarse };
    const listeners = new Set<Listener>();
    window.matchMedia = ((query: string) => {
      const pick = () => (query.includes("pointer") ? state.coarse : state.width);
      return {
        get matches() { return pick(); }, media: query, onchange: null,
        addEventListener: (_: string, l: Listener) => listeners.add(l),
        removeEventListener: (_: string, l: Listener) => listeners.delete(l),
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
    return {
      set(next: boolean) { state.width = next; for (const l of listeners) l({ matches: next } as MediaQueryListEvent); },
      setCoarse(next: boolean) { state.coarse = next; },
    };
  },
};
```
  Restore the setup's default `matchMedia` in an `afterEach` inside each test file that installs it (save `const original = window.matchMedia` at the top).
  `main.tsx`: call `installInputModality()` once before `createRoot`. `sidebar.tsx`: the ⌘B handler becomes `runInstant(toggleSidebar)`.

- [ ] **Step 4: Green** (+ `src/test/shell.test.tsx`), typecheck, lint. **Step 5: Commit** `feat(web): input modality, runInstant and latched mobile overlay choice`.

---

### Task 9: Button, Input, Textarea, Checkbox, NativeSelect: one ring, heights, disabled

**DESIGN.md sections implemented:** Components → Buttons, Form controls, Inputs; Layout (control heights).

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/components/ui/button.tsx`, `input.tsx`, `textarea.tsx`, `checkbox.tsx`, `components/native-select.tsx`
- Test: `apps/web/src/components/ui/button.test.tsx` (new), `src/test/ui-contract.test.ts` (extend)

- [ ] **Step 1: Failing tests.**
  - `button.test.tsx`: a `disabled` button and an `aria-disabled="true"` button both carry the classes that select `bg-card border-border text-muted-foreground` (assert via `toHaveClass` on the variant string fragments `disabled:bg-card` and `aria-disabled:bg-card`), none has `opacity-50`; `aria-busy="true"` with `aria-disabled` keeps the destructive look (no `aria-[disabled=true]:not-aria-busy:` mismatch: assert the class `aria-disabled:not-aria-busy:bg-card`); the variant list no longer includes `secondary` (type test: `// @ts-expect-error` on `variant="secondary"`).
  - `ui-contract.test.ts`: for `button.tsx`, `input.tsx`, `textarea.tsx`, `checkbox.tsx`, `native-select.tsx`: no `outline-none`, `ring-3`, `ring-ring/50`, `focus-visible:ring-2`.

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**
  - `button.tsx` base: drop `outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40`; add
    `disabled:pointer-events-none disabled:bg-card disabled:border-border disabled:text-muted-foreground aria-disabled:not-aria-busy:cursor-not-allowed aria-disabled:not-aria-busy:bg-card aria-disabled:not-aria-busy:border-border aria-disabled:not-aria-busy:text-muted-foreground aria-disabled:not-aria-busy:hover:bg-card aria-disabled:active:scale-100`.
    Sizes: `default: "h-8 pointer-coarse:h-9 …"`, `icon: "size-8 pointer-coarse:size-9"`.
    Variants: `outline: "border-border bg-card hover:bg-muted hover:text-foreground aria-expanded:bg-muted dark:border-border dark:bg-card dark:hover:bg-muted"`; delete `secondary`.
  - `input.tsx`: `h-8 pointer-coarse:h-9 w-full min-w-0 rounded-lg border border-input bg-card px-2.5 py-1 text-sm pointer-coarse:text-base transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive …file classes` (no outline/ring classes, no `md:text-sm`).
  - `textarea.tsx`: same field classes with its min height.
  - `checkbox.tsx`: drop `outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:ring-3 …ring…`, keep graphite `data-checked:` classes, add `bg-card`.
  - `native-select.tsx`: `h-8 pointer-coarse:h-9 w-full min-w-0 rounded-lg border border-input bg-card px-2.5 text-sm aria-invalid:border-destructive disabled:cursor-not-allowed disabled:text-muted-foreground` (focus comes from the base layer).
  - Remove call-site `bg-card dark:bg-card` patches on `Input`/`Textarea` only where grep shows them (`grep -rn "bg-card dark:bg-card" apps/web/src`): they're now the default.

- [ ] **Step 4: Green**, whole web suite, typecheck, lint. **Step 5: Commit** `feat(web): one focus ring, one control height, one disabled style`.

---

### Task 10: Focus-ring sweep across features and sidebar

**DESIGN.md sections implemented:** Components → Rows (inset ring), Form controls (one ring).

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `features/agents/agent-tree.tsx:131`, `features/tasks/task-list.tsx:46`, `features/inbox/inbox-row.tsx:89`, `features/templates/template-list.tsx:48`, `features/templates/issue-list.tsx:60`, `features/usage/usage-tables.tsx:9,44`, `features/settings/usage-section.tsx:50`, `features/usage/usage-chart.tsx:121`, `components/ui/sidebar.tsx:409,429,474,561,674`, `components/ui/tabs.tsx:81`, plus anything the grep finds
- Test: `src/test/ui-contract.test.ts` (extend)

- [ ] **Step 1: Failing test** (whole-tree scan):

```ts
const ALLOW = [/data-slot="(dropdown-menu|select)-item"/]; // menu/select items show focus as a fill
test("no utility hides or replaces the focus ring", () => {
  const offenders = sourceFiles().flatMap((f) => {
    const text = readFileSync(f, "utf8");
    return [...text.matchAll(/\b(outline-none|outline-hidden|ring-3|ring-ring\/50)\b/g)]
      .filter((m) => {
        const line = text.slice(text.lastIndexOf("\n", m.index) + 1, text.indexOf("\n", m.index));
        return !ALLOW.some((re) => re.test(text.slice(Math.max(0, m.index - 600), m.index))) && !line.includes("ui-contract:allow");
      })
      .map(() => f.replace(SRC, ""));
  });
  expect(offenders).toEqual([]);
});
```
  (Menu and select item components mark their class line with a trailing `// ui-contract:allow focus is a fill` comment in Tasks 11–12.)

- [ ] **Step 2: Red** (lists the files above).

- [ ] **Step 3: Implement.** Remove `outline-none`/`outline-hidden` and the `focus-visible:ring-*` halos at every listed site. Row links (`agent-tree`, `task-list`, `inbox-row`, `template-list`, `issue-list`) take `.of-row` (which carries the inset outline offset) and drop `hover:bg-sidebar-accent`; sidebar menu buttons and sub-buttons get `focus-visible:outline-offset-[-2px]`; usage table rows and chart bars rely on the base outline (`focus-visible:outline-offset-[-2px]` on full-width rows). `tabs.tsx:81` content: drop `outline-none`.

- [ ] **Step 4: Green**, whole web suite, typecheck, lint. **Step 5: Commit** `fix(web): visible focus everywhere; rows take an inset ring`.

---

### Task 11: Popover, DropdownMenu, Tooltip on spec; destructive items

**DESIGN.md sections implemented:** Elevation & Depth; Motion → Durations, Popovers, Frequency (keyboard stamp).

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `components/ui/popover.tsx:30`, `components/ui/dropdown-menu.tsx:45,60-80,246`, `components/ui/tooltip.tsx:6,42`; destructive items in `features/schedules/schedule-row.tsx:125`, `features/settings/credentials-section.tsx:~523`, `features/settings/projects-section.tsx:~418`, `features/settings/users-section.tsx:~317` (re-grep `DropdownMenuItem` for delete/remove/revoke/disable/archive/terminate); explicit widths in `features/tasks/assignee-menu.tsx:53` and the task status menu
- Test: `components/ui/overlay-timing.test.tsx` (new), `src/test/ui-contract.test.ts` (extend)

- [ ] **Step 1: Failing tests.**
  - Contract: `popover.tsx`, `dropdown-menu.tsx`, `tooltip.tsx` contain no `shadow-` and no `slide-in-from-`; dropdown content contains `max-w-[min(var(--radix-dropdown-menu-content-available-width),20rem)]` and no `w-(--radix-dropdown-menu-trigger-width)`; popover and dropdown contain `border-float-edge` and `data-closed:duration-75`.
  - `overlay-timing.test.tsx`: after `installInputModality()`, opening a `DropdownMenu` with Enter on its trigger renders content with `data-instant`; opening it with a click renders none. Same for `Popover`.
  - Tooltip: `TooltipProvider` defaults `delayDuration` 400 and `skipDelayDuration` 300 (render a provider with a trigger; with fake timers the content is absent at 399ms and present at 400ms after hover).
  - Each destructive item renders with `data-variant="destructive"` (one test per settings section where a menu exists; schedule-row test).

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**
  - `PopoverContent`: `const instant = useKeyboardOpened();` → `data-instant={instant ? "" : undefined}`; classes: replace `shadow-md ring-1 ring-foreground/10` with `border border-float-edge`; add `data-closed:duration-75`.
  - `DropdownMenuContent` and `SubContent`: `min-w-32 max-w-[min(var(--radix-dropdown-menu-content-available-width),20rem)] … rounded-lg border border-float-edge bg-popover p-1 … duration-100 ease-(--ease-out) data-closed:duration-75 data-open:animate-in data-open:fade-in-0 motion-safe:data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 motion-safe:data-closed:zoom-out-95` (no `shadow-*`, no `slide-in-from-*`, no trigger width); `data-instant` stamp as for Popover. Items: `min-h-8 py-1.5 pointer-coarse:min-h-9 [overflow-wrap:anywhere]`, keep `outline-hidden` with the trailing `// ui-contract:allow focus is a fill` comment, focus fill `focus:bg-accent`.
  - Tooltip: `delayDuration = 400`, add `skipDelayDuration = 300`; content classes: remove the four `slide-in-from-*-2` and the dead `data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95`; `duration-100 ease-(--ease-out) data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 motion-safe:data-[state=delayed-open]:zoom-in-95 data-closed:duration-75 data-closed:animate-out data-closed:fade-out-0`.
  - Destructive items: `<DropdownMenuSeparator />` then `<DropdownMenuItem variant="destructive" …>`.
  - Assignee and status menus: `className="w-(--radix-dropdown-menu-trigger-width)"` on their `DropdownMenuContent`.

- [ ] **Step 4: Green**, whole web suite, typecheck, lint. **Step 5: Commit** `feat(web): menus, popovers and tooltips on DESIGN.md timing; crimson destructive items`.

---

### Task 12: Select primitive

**DESIGN.md sections implemented:** Components → Form controls; Elevation & Depth; Motion → Durations, Popovers.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/components/ui/select.tsx`, `apps/web/src/components/ui/select.test.tsx`
- Modify: `apps/web/src/test-setup.ts` (pointer-capture shims)

**Interfaces:**
- Produces: `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` (`textValue?: string`), `SelectGroup`, `SelectLabel`, `SelectSeparator`; `ALL = "__all"` sentinel exported from `select.tsx`.

- [ ] **Step 1: Failing test.**

```tsx
// components/ui/select.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ALL, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

test("keyboard selection calls onValueChange; the sentinel stands for 'all'", async () => {
  const onChange = vi.fn();
  render(
    <Select value={ALL} onValueChange={onChange}>
      <SelectTrigger aria-label="Agent"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All agents</SelectItem>
        <SelectItem value="dev-001" textValue="dev-001">Developer One (@dev-001)</SelectItem>
      </SelectContent>
    </Select>,
  );
  const trigger = screen.getByRole("combobox", { name: "Agent" });
  expect(trigger).toHaveClass("h-8", "pointer-coarse:h-9", "min-w-0");
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onChange).toHaveBeenCalledWith("dev-001");
});

test("content is a floating layer without shadow", async () => {
  render(
    <Select defaultOpen><SelectTrigger aria-label="x"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="a">A</SelectItem></SelectContent></Select>,
  );
  const listbox = await screen.findByRole("listbox");
  expect(listbox.closest("[data-slot=select-content]")?.className).toMatch(/border-float-edge/);
  expect(listbox.closest("[data-slot=select-content]")?.className).not.toMatch(/shadow-/);
});
```

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.** `test-setup.ts`: add `Element.prototype.hasPointerCapture ??= () => false; Element.prototype.setPointerCapture ??= () => {}; Element.prototype.releasePointerCapture ??= () => {};`. `select.tsx` on `import { Select as SelectPrimitive } from "radix-ui"`:
  - `SelectTrigger`: `flex h-8 pointer-coarse:h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-card px-2.5 text-sm data-placeholder:text-muted-foreground aria-invalid:border-destructive disabled:cursor-not-allowed disabled:text-muted-foreground [&>span]:truncate`, a `ChevronDown` `shrink-0 text-muted-foreground`; `SelectValue` passes `title` when the value is text.
  - `SelectContent`: `position="popper"`, `sideOffset={4}`, classes `z-50 min-w-(--radix-select-trigger-width) max-w-(--radix-select-content-available-width) max-h-(--radix-select-content-available-height) origin-(--radix-select-content-transform-origin) overflow-hidden rounded-lg border border-float-edge bg-popover p-1 text-popover-foreground duration-100 ease-(--ease-out) data-closed:duration-75 data-open:animate-in data-open:fade-in-0 motion-safe:data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0`, with `SelectPrimitive.ScrollUpButton`/`ScrollDownButton`, `data-instant` from `useKeyboardOpened()`.
  - `SelectItem`: `relative flex min-h-8 pointer-coarse:min-h-9 w-full cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm outline-hidden select-none [overflow-wrap:anywhere] focus:bg-accent data-disabled:pointer-events-none data-disabled:text-muted-foreground` (comment `// ui-contract:allow focus is a fill`), a graphite `Check` in `SelectPrimitive.ItemIndicator`.
  - `export const ALL = "__all";` with a doc comment: Radix forbids `""` as an item value.

- [ ] **Step 4: Green**, typecheck, lint. **Step 5: Commit** `feat(web): Radix Select primitive`.

---

### Task 13: RadioGroup, SegmentedControl, Tabs active look

**DESIGN.md sections implemented:** Components → Form controls (graphite radios, segmented control).

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `components/ui/radio-group.tsx`, `components/ui/segmented-control.tsx`, `components/ui/segmented-control.test.tsx`
- Modify: `components/ui/tabs.tsx:63-65`

**Interfaces:**
- Produces:
```ts
export function SegmentedControl<V extends string | number>(props: {
  legend: string;
  legendVisible?: boolean;
  name: string;
  value: V;
  options: readonly { value: V; label: ReactNode }[];
  onChange(value: V): void;
  size?: "sm" | "default";
  block?: boolean;
  className?: string;
}): JSX.Element;
export const RadioGroup: typeof RadioGroupPrimitive.Root; export function RadioGroupItem(...): JSX.Element;
```

- [ ] **Step 1: Failing test.**

```tsx
test("arrow keys move the selection and report typed values", async () => {
  const onChange = vi.fn();
  render(<SegmentedControl legend="Range" name="r" value={7} onChange={onChange}
    options={[{ value: 7, label: "7 days" }, { value: 30, label: "30 days" }]} />);
  const seven = screen.getByRole("radio", { name: "7 days" });
  seven.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(onChange).toHaveBeenCalledWith(30);
});
test("track carries the height; segments keep a border so selection never shifts", () => {
  const { container } = render(<SegmentedControl legend="Show" name="s" value="a" onChange={() => {}}
    options={[{ value: "a", label: "Active" }, { value: "b", label: "Ended" }]} size="sm" />);
  const track = container.querySelector("[data-slot=segmented-track]");
  expect(track).toHaveClass("h-7", "pointer-coarse:h-9", "dark:bg-background");
  for (const l of container.querySelectorAll("label")) expect(l).toHaveClass("h-full", "border");
});
test("the legend is visible only when asked", () => {
  render(<SegmentedControl legend="When" legendVisible name="w" value="a" onChange={() => {}} options={[{ value: "a", label: "Repeats" }]} />);
  expect(screen.getByText("When")).not.toHaveClass("sr-only");
});
```

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**

```tsx
// components/ui/segmented-control.tsx
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 2–4 short fixed choices as native radios (arrow keys and form semantics for free). Options from data,
 *  or more than four, belong in a Select (DESIGN.md → Form controls). */
export function SegmentedControl<V extends string | number>(p: {
  legend: string; legendVisible?: boolean; name: string; value: V;
  options: readonly { value: V; label: ReactNode }[]; onChange(value: V): void;
  size?: "sm" | "default"; block?: boolean; className?: string;
}) {
  return (
    <fieldset className={cn("min-w-0 max-w-full", p.block && "w-full", p.className)}>
      <legend className={p.legendVisible ? "mb-1.5 text-[0.8125rem] font-medium" : "sr-only"}>{p.legend}</legend>
      <div
        data-slot="segmented-track"
        className={cn(
          "inline-flex max-w-full rounded-lg bg-muted p-0.5 dark:bg-background pointer-coarse:h-9",
          p.size === "sm" ? "h-7" : "h-8",
          p.block && "flex w-full",
        )}
      >
        {p.options.map((o) => (
          <label
            key={String(o.value)}
            className={cn(
              "flex h-full min-w-0 cursor-pointer items-center justify-center rounded-md border border-transparent px-2.5 text-sm whitespace-nowrap text-muted-foreground transition-[background-color,color,border-color] duration-150 ease-(--ease-out) hover:text-foreground",
              "has-checked:border-border has-checked:bg-card has-checked:text-foreground dark:has-checked:bg-accent",
              "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring",
              p.block && "flex-1",
            )}
          >
            <input type="radio" name={p.name} value={String(o.value)} checked={p.value === o.value}
              onChange={() => p.onChange(o.value)} className="sr-only" />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
```
  `radio-group.tsx`: Radix `RadioGroup` (`grid gap-2`) and `RadioGroupItem` (`aspect-square size-4 shrink-0 rounded-full border border-input bg-card data-checked:border-foreground disabled:cursor-not-allowed`), indicator a 6px `bg-foreground` dot. `tabs.tsx:63-65`: active trigger `data-active:border-border data-active:bg-card data-active:text-foreground dark:data-active:bg-accent`, remove the `box-shadow` transition and any `shadow` class.

- [ ] **Step 4: Green**, typecheck, lint. **Step 5: Commit** `feat(web): RadioGroup and SegmentedControl; tabs without shadow`.

---

### Task 14: Spinner and static Skeleton

**DESIGN.md sections implemented:** Components → Empty states and loading; Motion → Curves (linear spinner), Reduced motion.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `components/ui/spinner.tsx`
- Modify: `components/ui/skeleton.tsx:7`; sites `features/templates/template-editor.tsx:468,629`, `components/auth-card.tsx:46`, `routes/_app/templates.new.tsx:151` (confirm-dialog's spinner moves in Task 18)
- Test: `src/test/ui-contract.test.ts` (extend)

- [ ] **Step 1: Failing contract test:** no file outside `components/ui/spinner.tsx` contains `animate-spin`; `skeleton.tsx` contains no `animate-pulse`; template Save shows "Saving…" while pending (add to `test/templates.test.tsx`: click Save with a held PATCH, assert button text "Saving…").

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**
```tsx
// components/ui/spinner.tsx
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
/** Always next to a pending label; stops under reduced motion (the label carries the meaning). */
export function Spinner({ size = "button", className }: { size?: "text" | "button"; className?: string }) {
  return <Loader2 aria-hidden="true" className={cn("motion-safe:animate-spin", size === "text" ? "size-3.5" : "size-4", className)} />;
}
```
  Replace the bare `<Loader2 … animate-spin />` at each site with `<Spinner size=… />`; template Save's label becomes `{pending ? "Saving…" : "Save"}`. `Skeleton`: `cn("rounded-md bg-muted", className)`.

- [ ] **Step 4: Green**, typecheck, lint. **Step 5: Commit** `feat(web): one Spinner; static skeletons`.

---

### Task 15: Vaul Drawer primitive

**DESIGN.md sections implemented:** Components → Overlays; Elevation & Depth; Motion → Durations, Reduced motion, Gesture UI, Frequency (keyboard stamp).

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/package.json`, `pnpm-lock.yaml` (via pnpm), `apps/web/src/styles.css` (unlayered Vaul block at the end of the file, outside every `@layer`)
- Create: `apps/web/src/components/ui/drawer.tsx`, `apps/web/src/components/ui/drawer.test.tsx`

**Interfaces:**
- Produces: `Drawer` (`direction?: "bottom" | "left"`, `autoFocus` default `true`, plus Vaul Root props), `DrawerContent`, `DrawerHeader`, `DrawerTitle`, `DrawerDescription`, `DrawerBody`, `DrawerFooter`, `DrawerClose`.

- [ ] **Step 1: Add the dependency.** `pnpm --filter @open-factory/web add --save-exact vaul@1.1.2`. Check `git diff pnpm-lock.yaml`: only `vaul@1.1.2` is new (its `@radix-ui/react-dialog` resolves to the existing `1.3.1`). If anything else changes, stop and report. Never touch supply-chain settings.

- [ ] **Step 2: Failing test.**

```tsx
// components/ui/drawer.test.tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Drawer, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from "./drawer";

const open = (direction: "bottom" | "left" = "bottom") =>
  render(
    <Drawer open direction={direction} onOpenChange={() => {}}>
      <DrawerContent>
        <DrawerHeader><DrawerTitle>Title</DrawerTitle></DrawerHeader>
        <DrawerBody><input aria-label="field" /></DrawerBody>
        <DrawerFooter><button type="button">Act</button></DrawerFooter>
      </DrawerContent>
    </Drawer>,
  );

test("Vaul upgrade guard: the attributes and injected rules our overrides depend on (Vaul 1.1.2)", () => {
  open();
  const content = document.querySelector("[data-slot=drawer-content]");
  expect(content).toHaveAttribute("data-vaul-drawer");
  expect(content).toHaveAttribute("data-state", "open");
  expect(document.querySelector("[data-slot=drawer-overlay]")).toHaveAttribute("data-vaul-overlay");
  const injected = [...document.head.querySelectorAll("style")].map((s) => s.textContent).join("");
  expect(injected).toContain("[data-vaul-drawer]{");
  expect(injected).toContain("animation-duration:.5s");
  expect(injected).toContain("[data-vaul-overlay][data-vaul-snap-points=false]{");
  expect(injected).toMatch(/animation-name:slideFromBottom/);
  expect(injected).toMatch(/animation-name:slideFromLeft/);
  expect(injected).toContain("var(--initial-transform,100%)");
});

test("focus moves into the drawer, onto the content, not the first input", () => {
  open();
  expect(document.activeElement).toBe(document.querySelector("[data-slot=drawer-content]"));
});

test("reduced motion fades an inner wrapper", () => {
  open();
  const inner = document.querySelector("[data-slot=drawer-inner]");
  expect(inner).toHaveClass("motion-reduce:animate-in", "motion-reduce:fade-in-0");
});

test("bottom drawer caps its column; left drawer uses the sidebar width", () => {
  open("bottom");
  expect(document.querySelector("[data-slot=drawer-inner]")).toHaveClass("max-w-lg", "mx-auto");
});

test("the override block is unlayered, !important and keyed on data-state", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  expect(css).toMatch(/\[data-vaul-drawer\]\[data-slot="drawer-content"\]\[data-state="open"\]\s*{\s*animation-duration:\s*250ms !important/);
  expect(css).toMatch(/\[data-vaul-overlay\]\[data-slot="drawer-overlay"\]\[data-state="open"\]\s*{\s*animation-duration:\s*250ms !important/);
  expect(css).toMatch(/\[data-released\]\s*{\s*animation-duration:\s*300ms !important/);
  expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*{\s*\[data-vaul-drawer\]\s*{\s*--initial-transform:\s*0px/);
});
```

- [ ] **Step 3: Red.**

- [ ] **Step 4: Implement.**

```css
/* styles.css, at the end, OUTSIDE any @layer.
   Vaul 1.1.2 (pinned exactly) appends unlayered rules to <head> after this file:
   [data-vaul-drawer]{animation-duration:.5s}, [data-vaul-overlay][data-vaul-snap-points=false]{animation-duration:.5s}
   and four-attribute animation-name selectors. These declarations are !important and one attribute more
   specific. Re-check on any Vaul upgrade; drawer.test.tsx's guard fails if the attributes change.
   DESIGN.md → Motion → Durations, Gesture UI. */
[data-vaul-drawer][data-slot="drawer-content"][data-state="open"] { animation-duration: 250ms !important; animation-timing-function: var(--ease-drawer) !important; }
[data-vaul-drawer][data-slot="drawer-content"][data-state="closed"] { animation-duration: 200ms !important; animation-timing-function: var(--ease-out) !important; }
[data-vaul-drawer][data-slot="drawer-content"][data-state="closed"][data-released] { animation-duration: 300ms !important; animation-timing-function: var(--ease-drawer) !important; }
[data-vaul-overlay][data-slot="drawer-overlay"][data-state="open"] { animation-duration: 250ms !important; animation-timing-function: var(--ease-drawer) !important; }
[data-vaul-overlay][data-slot="drawer-overlay"][data-state="closed"] { animation-duration: 200ms !important; animation-timing-function: var(--ease-out) !important; }
/* Reduced motion: Vaul's slide starts from var(--initial-transform, 100%), which its JS never sets. */
@media (prefers-reduced-motion: reduce) {
  [data-vaul-drawer] { --initial-transform: 0px; }
}
```
  (Biome may require `biome-ignore lint/complexity/noImportantStyles` comments per declaration block; add them with the reason "must beat Vaul's injected rules".)

```tsx
// components/ui/drawer.tsx
import * as React from "react";
import { Drawer as Vaul } from "vaul";
import { useKeyboardOpened } from "@/lib/input-modality";
import { cn } from "@/lib/utils";

type Direction = "bottom" | "left";
const Ctx = React.createContext<{ direction: Direction; released: boolean }>({ direction: "bottom", released: false });

/** Vaul drawer (DESIGN.md → Overlays, Gesture UI). Focus moves in on open (Vaul's default would leave it
 *  behind the scrim); a drag that ends in a close leaves on the drawer curve (data-released). */
function Drawer({ direction = "bottom", autoFocus = true, onRelease, open, ...props }:
  Omit<React.ComponentProps<typeof Vaul.Root>, "direction"> & { direction?: Direction }) {
  const [released, setReleased] = React.useState(false);
  const [prevOpen, setPrevOpen] = React.useState(open);
  if (open !== prevOpen) { setPrevOpen(open); if (open) setReleased(false); }
  return (
    <Ctx.Provider value={{ direction, released }}>
      <Vaul.Root data-slot="drawer" direction={direction} autoFocus={autoFocus} open={open}
        onRelease={(e, stillOpen) => { if (!stillOpen) setReleased(true); onRelease?.(e, stillOpen); }}
        {...props} />
    </Ctx.Provider>
  );
}

function DrawerContent({ className, children, onOpenAutoFocus, ...props }: React.ComponentProps<typeof Vaul.Content>) {
  const { direction, released } = React.useContext(Ctx);
  const instant = useKeyboardOpened();
  return (
    <Vaul.Portal>
      <Vaul.Overlay data-slot="drawer-overlay" data-instant={instant ? "" : undefined}
        className="fixed inset-0 z-50 bg-black/20 dark:bg-black/40" />
      <Vaul.Content
        data-slot="drawer-content"
        data-released={released ? "" : undefined}
        data-instant={instant ? "" : undefined}
        tabIndex={-1}
        onOpenAutoFocus={(e) => {
          onOpenAutoFocus?.(e);
          if (e.defaultPrevented) return;
          // The content, not the first input: the iOS keyboard must not rise mid-slide.
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
        className={cn(
          "fixed z-50 flex flex-col bg-popover text-sm text-popover-foreground",
          direction === "bottom"
            ? "inset-x-0 bottom-0 max-h-[90svh] rounded-t-xl border-t border-float-edge pb-[max(1rem,env(safe-area-inset-bottom))]"
            : "inset-y-0 left-0 w-(--sidebar-width) max-w-[85vw] border-r border-float-edge",
          className,
        )}
        {...props}
      >
        <div data-slot="drawer-inner"
          className={cn("flex min-h-0 flex-1 flex-col motion-reduce:animate-in motion-reduce:fade-in-0 group-data-[state=closed]:motion-reduce:animate-out group-data-[state=closed]:motion-reduce:fade-out-0",
            direction === "bottom" && "mx-auto w-full max-w-lg")}>
          {direction === "bottom" && <div aria-hidden="true" className="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-border" />}
          {children}
        </div>
      </Vaul.Content>
    </Vaul.Portal>
  );
}

const DrawerHeader = ({ className, ...p }: React.ComponentProps<"div">) => (
  <div data-slot="drawer-header" className={cn("flex min-h-12 items-start gap-2 border-b px-4 py-3", className)} {...p} />
);
const DrawerTitle = ({ className, ...p }: React.ComponentProps<typeof Vaul.Title>) => (
  <Vaul.Title data-slot="drawer-title" className={cn("min-w-0 flex-1 font-heading text-base leading-5 font-semibold tracking-[-0.01em] [overflow-wrap:anywhere] line-clamp-2", className)} {...p} />
);
const DrawerDescription = ({ className, ...p }: React.ComponentProps<typeof Vaul.Description>) => (
  <Vaul.Description data-slot="drawer-description" className={cn("text-sm text-muted-foreground", className)} {...p} />
);
const DrawerBody = ({ className, ...p }: React.ComponentProps<"div">) => (
  <div data-slot="drawer-body" className={cn("@container min-h-0 flex-1 overflow-y-auto p-4", className)} {...p} />
);
/** Full-width stacked buttons: the action first, Cancel last at the bottom (DESIGN.md → Overlays). */
const DrawerFooter = ({ className, ...p }: React.ComponentProps<"div">) => (
  <div data-slot="drawer-footer" className={cn("flex flex-col gap-2 border-t px-4 pt-4 [&>*]:w-full", className)} {...p} />
);
const DrawerClose = Vaul.Close;

export { Drawer, DrawerBody, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle };
```
  Note: `group` must be on `Vaul.Content` for the `group-data-[state=closed]` variants: add `group` to its class list.

- [ ] **Step 5: Green**, typecheck, lint. **Step 6: Commit** `feat(web): Vaul drawer primitive (vaul@1.1.2, exact)`.

---

### Task 16: Mobile nav drawer and sidebar transitions

**DESIGN.md sections implemented:** Layout (left drawer); Components → Navigation; Motion → Gesture UI (no edge swipe), Frequency.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `components/ui/sidebar.tsx:16` (imports), `:185-210` (mobile branch), `:409` (group label), `:474` (menu button variants)
- Test: `apps/web/src/test/shell.test.tsx` (extend)

- [ ] **Step 1: Failing test:** on mobile (`fakeMatchMedia.install(true)`), clicking the sidebar trigger opens `[data-slot=drawer-content]` with `data-sidebar="sidebar"` and `data-mobile="true"`, the nav links inside, `style` containing `--sidebar-width: 18rem`, class `bg-sidebar`; Escape closes it; ⌘B toggles it and the content carries `data-instant` when opened by ⌘B. Contract: `sidebar.tsx` no longer contains `transition-[width,height,padding]` or `transition-[margin,opacity]`.

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**
```tsx
if (isMobile) {
  return (
    <Drawer open={openMobile} onOpenChange={setOpenMobile} direction="left">
      <DrawerContent data-sidebar="sidebar" data-mobile="true"
        className="bg-sidebar p-0 text-sidebar-foreground"
        style={{ "--sidebar-width": SIDEBAR_WIDTH_MOBILE } as React.CSSProperties}>
        <DrawerTitle className="sr-only">Sidebar</DrawerTitle>
        <DrawerDescription className="sr-only">Displays the mobile sidebar.</DrawerDescription>
        <div className="flex h-full w-full flex-col">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}
```
  (Opened only from its button or ⌘B: no edge-swipe handler is added.) Remove the `Sheet*` imports. `:474`: delete `transition-[width,height,padding]`; `:409`: delete `transition-[margin,opacity] duration-200 ease-(--ease-in-out)`.

- [ ] **Step 4: Green**, typecheck, lint. **Step 5: Commit** `feat(web): mobile nav as a Vaul left drawer; sidebar items stop animating layout`.

---

### Task 17: Adaptive Sheet

**DESIGN.md sections implemented:** Components → Overlays; Elevation & Depth; Motion → Durations, Reduced motion.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Rewrite: `apps/web/src/components/ui/sheet.tsx`
- Create: `apps/web/src/components/ui/sheet.test.tsx`

**Interfaces:**
- Consumes: `Drawer*` (Task 15), `useLatchedMobile` (Task 8), `useKeyboardOpened` (Task 8).
- Produces: `Sheet` (`open`, `onOpenChange`, `children`), `SheetContent` (`onOpenAutoFocus?`), `SheetHeader`, `SheetTitle`, `SheetDescription`, `SheetBody`, `SheetFooter`, `SheetClose`. No `side` prop: its only left-side consumer, the sidebar, already moved to `Drawer` in Task 16, so nothing else imports the old API (`grep -rn "components/ui/sheet" apps/web/src` shows no caller before this task).

- [ ] **Step 1: Failing test.**

```tsx
// components/ui/sheet.test.tsx
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "./sheet";
import { fakeMatchMedia } from "@/test/fake-match-media"; // new tiny helper: { install(matches), set(matches) }

function Demo({ onOpenChange = () => {} }: { onOpenChange?: (o: boolean) => void }) {
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader><SheetTitle>New task</SheetTitle></SheetHeader>
        <SheetBody>body</SheetBody>
        <SheetFooter><button type="button">Create</button></SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

test("desktop: a right panel with a header close, full travel, no fade, no shadow", () => {
  fakeMatchMedia.install(false);
  render(<Demo />);
  const panel = screen.getByRole("dialog", { name: "New task" });
  expect(panel).toHaveAttribute("data-slot", "sheet-content");
  expect(panel.className).toMatch(/slide-in-from-right/);
  expect(panel.className).not.toMatch(/fade-in-0(?!\S*motion-reduce)/);
  expect(panel.className).toMatch(/motion-reduce:data-open:fade-in-0/);
  expect(panel.className).not.toMatch(/shadow-/);
  expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
});

test("Esc closes", async () => {
  fakeMatchMedia.install(false);
  const onOpenChange = vi.fn();
  render(<Demo onOpenChange={onOpenChange} />);
  await userEvent.keyboard("{Escape}");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("mobile: a bottom drawer with the same slots", () => {
  fakeMatchMedia.install(true);
  render(<Demo />);
  expect(document.querySelector("[data-slot=drawer-content]")).toBeInTheDocument();
  expect(screen.getByText("New task")).toBeInTheDocument();
});

test("crossing the breakpoint while open keeps the primitive", () => {
  const mm = fakeMatchMedia.install(false);
  render(<Demo />);
  act(() => mm.set(true));
  expect(document.querySelector("[data-slot=sheet-content]")).toBeInTheDocument();
  expect(document.querySelector("[data-slot=drawer-content]")).toBeNull();
});
```
  (`fakeMatchMedia` is the helper from Task 8.)

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.** Sketch:

```tsx
// components/ui/sheet.tsx
const SheetCtx = React.createContext<{ mobile: boolean }>({ mobile: false });

/** One sheet for create/edit forms and peeks (DESIGN.md → Overlays): a 480px right panel on desktop, a
 *  bottom drawer below md. The choice is made per opening (spec §5.1). Dismissing never asks. */
function Sheet({ open, onOpenChange, children }: { open: boolean; onOpenChange(o: boolean): void; children: React.ReactNode }) {
  const mobile = useLatchedMobile(open);
  return (
    <SheetCtx.Provider value={{ mobile }}>
      {mobile ? (
        <Drawer open={open} onOpenChange={onOpenChange} direction="bottom">{children}</Drawer>
      ) : (
        <SheetPrimitive.Root open={open} onOpenChange={onOpenChange}>{children}</SheetPrimitive.Root>
      )}
    </SheetCtx.Provider>
  );
}

function SheetContent({ className, children, ...props }: React.ComponentProps<typeof SheetPrimitive.Content>) {
  const { mobile } = React.useContext(SheetCtx);
  const instant = useKeyboardOpened();
  if (mobile) return <DrawerContent className={className} {...props}>{children}</DrawerContent>;
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay data-slot="sheet-overlay" data-instant={instant ? "" : undefined}
        className="fixed inset-0 z-50 bg-black/20 dark:bg-black/40 duration-250 ease-(--ease-drawer) data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-closed:duration-200 data-closed:ease-(--ease-out)" />
      <SheetPrimitive.Content data-slot="sheet-content" data-instant={instant ? "" : undefined}
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-[min(30rem,100%)] flex-col border-l border-float-edge bg-popover text-sm text-popover-foreground",
          "duration-250 ease-(--ease-drawer) data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right data-closed:duration-200 data-closed:ease-(--ease-out)",
          "motion-reduce:data-open:fade-in-0 motion-reduce:data-closed:fade-out-0",
          "[@media(max-height:30rem)]:overflow-y-auto",
          className,
        )}
        {...props}>
        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}
```
  `SheetHeader` renders `DrawerHeader` on mobile, else `<div className="flex min-h-12 items-start gap-2 border-b px-4 py-3">{children}<SheetPrimitive.Close asChild><Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Close"><XIcon /></Button></SheetPrimitive.Close></div>`. `SheetTitle` (Radix Title or `DrawerTitle`): `min-w-0 flex-1 font-heading text-base leading-5 font-semibold tracking-[-0.01em] [overflow-wrap:anywhere] line-clamp-2`. `SheetBody`: `@container min-h-0 flex-1 overflow-y-auto p-4 [@media(max-height:30rem)]:overflow-visible` (doc comment: consumers use `@sm`/`@lg`, never `@md`). `SheetFooter`: desktop `flex flex-wrap justify-end gap-2 border-t p-4`, mobile `DrawerFooter`. `SheetClose`: Radix Close or `DrawerClose`.

- [ ] **Step 4: Green**, typecheck, lint. **Step 5: Commit** `feat(web): adaptive Sheet (right panel, bottom drawer on phones)`.

---

### Task 18: AlertDialog timing and the adaptive ConfirmDialog

**DESIGN.md sections implemented:** Components → Overlays (confirmation drawer order, wrapping names), Destructive actions, Empty states and loading (pending label); Motion → Durations.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `components/ui/alert-dialog.tsx:30-62`; `components/confirm-dialog.tsx`; the seven callers without a `pendingLabel`: `features/settings/credentials-section.tsx`, `features/settings/secrets-section.tsx`, `features/settings/users-section.tsx`, `features/templates/template-editor.tsx`, `features/session/new-session-dialog.tsx`, `features/session/terminate-dialog.tsx`, `features/session/unpin-dialog.tsx`
- Test: `apps/web/src/test/confirm-dialog.test.tsx` (extend)

**Interfaces:**
- Consumes: `Drawer*`, `useLatchedMobile`, `Spinner`, `useKeyboardOpened`.
- Produces: `ConfirmDialog` props unchanged except `pendingLabel: string` is now **required**.

- [ ] **Step 1: Failing tests** (in `test/confirm-dialog.test.tsx`):
  - Desktop (`fakeMatchMedia.install(false)`): `role="alertdialog"`; the dialog content has `sm:max-w-md` and `max-h-[calc(100svh-2rem)]`; a 64-char secret name in `confirmLabel` renders a button with `whitespace-normal` and `[overflow-wrap:anywhere]`; while pending (held promise) the action shows the pending label and a spinner, has `aria-busy="true"` and `aria-disabled="true"`, Esc does nothing.
  - Mobile (`install(true)`): the content is `[data-slot=drawer-content]` with `role="alertdialog"`; the footer's buttons in DOM order are [destructive, Cancel]; Cancel has focus after open; while pending, Escape and an overlay pointerdown don't close it.
  - Breakpoint flip while pending: still the same primitive and still pending.
  - Type test: omitting `pendingLabel` is a type error (`// @ts-expect-error` in the test).

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**
  - `alert-dialog.tsx`: overlay `bg-black/20 dark:bg-black/40 duration-150 ease-(--ease-out) data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-closed:duration-100`; content `rounded-lg border border-float-edge … duration-150 ease-(--ease-out) data-open:animate-in data-open:fade-in-0 motion-safe:data-open:zoom-in-[0.96] data-closed:animate-out data-closed:fade-out-0 data-closed:duration-100` (no `zoom-out`, no `ring-*`, no `rounded-xl`), `data-instant` from `useKeyboardOpened()`.
  - `confirm-dialog.tsx` (keeps the pending/error logic; render split):

```tsx
const mobile = useLatchedMobile(open);
const actionClass = "whitespace-normal h-auto min-h-8 py-1.5 text-center [overflow-wrap:anywhere]";
const action = (
  <Button variant="destructive" className={actionClass} aria-busy={pending || undefined}
    aria-disabled={pending || undefined} onClick={confirm}>
    {pending && <Spinner />}
    {pending ? pendingLabel : confirmLabel}
  </Button>
);
if (mobile) {
  return (
    <Drawer open={open} onOpenChange={(o) => !pending && onOpenChange(o)} dismissible={!pending}>
      <DrawerContent role="alertdialog" aria-modal="true"
        onPointerDownOutside={(e) => pending && e.preventDefault()}
        onEscapeKeyDown={(e) => pending && e.preventDefault()}
        onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={(e) => { e.preventDefault(); cancelRef.current?.focus(); }}>
        <DrawerHeader><DrawerTitle>{title}</DrawerTitle></DrawerHeader>
        <DrawerBody>
          <DrawerDescription className="[overflow-wrap:anywhere]">{body}</DrawerDescription>
          {detail}
          <div role="alert" className="mt-2 text-[0.8125rem] leading-[1.125rem] text-destructive empty:hidden">{error}</div>
        </DrawerBody>
        <DrawerFooter>
          {action}
          <Button ref={cancelRef} variant="outline" aria-disabled={pending || undefined}
            onClick={() => !pending && onOpenChange(false)}>Cancel</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
// desktop: today's AlertDialog tree, with
// <AlertDialogContent className="sm:max-w-md max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto]" …>
// header (title with [overflow-wrap:anywhere]), a scrolling middle (body, detail, error: min-h-0 overflow-y-auto),
// <AlertDialogFooter className="flex-wrap"> Cancel (outline, autoFocus), then <AlertDialogAction asChild>{action}</AlertDialogAction>
```
  `pendingLabel: string` in the props type. Callers: credentials and secrets "Deleting…", users "Disabling…", template editor "Deleting…", new session "Starting…", terminate "Terminating…", unpin "Unpinning…" (stop-crons already passes one). Remove `aria-disabled:opacity-50`-style patches from `confirm-dialog.tsx:80,87`.

- [ ] **Step 4: Green** (+ `test/agent-actions.test.tsx`, `test/settings*.test.tsx`, `features/session/*dialog*.test.tsx`), typecheck, lint. **Step 5: Commit** `feat(web): ConfirmDialog becomes a bottom drawer on phones; required pending labels`.

---

## Phase C: consumers

### Task 19: Selects at their call sites; manager indent

**DESIGN.md sections implemented:** Components → Form controls.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `features/tasks/task-filters.tsx`, `features/tasks/agent-picker.tsx`, `features/tasks/link-editor.tsx`, `features/agents/agent-form.tsx:55,491`, `features/schedules/schedule-filters.tsx`; `features/schedules/timezone-select.tsx` keeps `NativeSelect` (now restyled by Task 9)
- Test: existing `features/tasks/*filters*.test.tsx`, `test/agent-form.test.tsx`, `features/schedules/*.test.tsx`; contract in `ui-contract.test.ts`

- [ ] **Step 1: Failing tests.** Contract: `NativeSelect` is imported only by `timezone-select.tsx`. Behaviour: each migrated test drives the Select by role `combobox` → `option` instead of `selectOptions`; an "All" option maps to `undefined` filter values through `ALL`; the manager picker shows option labels with at most 3 indent levels and a `└ ` prefix deeper; the closed trigger shows the name and a muted `@slug` span (`[data-slot=select-value] .text-muted-foreground`).

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.** Replace each `<NativeSelect>` with `Select`/`SelectTrigger`/`SelectValue`/`SelectContent`/`SelectItem`, keeping `id`/`aria-label`/`aria-describedby`/`aria-invalid` on the trigger. Agent options: `<SelectItem value={a.slug} textValue={a.slug}><span>{a.displayName}</span> <span className="text-muted-foreground font-mono">@{a.slug}</span></SelectItem>`. Manager indent: `const indent = (depth: number) => depth <= 3 ? " ".repeat(depth * 2) : " ".repeat(6) + "└ "` applied inside the item only (never in the trigger, which renders the selected agent's name and slug spans).

- [ ] **Step 4: Green**, whole web suite, typecheck, lint. **Step 5: Commit** `feat(web): Radix Select replaces native selects (timezone excepted)`.

---

### Task 20: Radios, segmented controls and checkboxes at their call sites

**DESIGN.md sections implemented:** Components → Form controls.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `features/settings/credentials-section.tsx:241` (RadioGroup), `features/agents/project-grant-picker.tsx:62` (Checkbox), `routes/_app/agents.index.tsx:168-185` (SegmentedControl sm), `features/usage/range-filter.tsx:19` (SegmentedControl sm, numbers), `features/schedules/when-field.tsx:31-46` (SegmentedControl block, visible legend "When")
- Test: `ui-contract.test.ts` (radio/checkbox grep from spec §2.5), `test/agents-list.test.tsx`, `features/usage/*.test.tsx`, `features/schedules/*.test.tsx`, `test/settings.test.tsx`

- [ ] **Step 1: Failing contract test:** `grep`-equivalent over `sourceFiles()`: `type="radio"` and `type="checkbox"` appear only in `components/ui/segmented-control.tsx`.

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement** the replacements; keep each control's accessible name and URL/search behaviour (Active/Ended still navigates to `/agents` with `{ ended: "only" }`).

- [ ] **Step 4: Green**, whole suite, typecheck, lint. **Step 5: Commit** `feat(web): one segmented control, graphite radios and checkboxes`.

---

### Task 21: Button audit: outline secondaries, disabled patches removed

**DESIGN.md sections implemented:** Components → Buttons.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: call sites from `grep -rn 'variant="ghost"' apps/web/src --include=*.tsx` (78 today) and `grep -rn "aria-disabled:opacity-50\|aria-disabled:hover" apps/web/src` (`settings/shared.tsx:279`, `settings/factory-section.tsx:230`, `agents/agent-form.tsx:554`, `templates/template-editor.tsx:438,463,532,674`, `routes/_app/templates.new.tsx:150`, `session/interrupt-button.tsx:53`, recovery and agent-actions buttons)
- Test: `ui-contract.test.ts` (no `aria-disabled:opacity-50` anywhere)

- [ ] **Step 1: Failing contract test** for `aria-disabled:opacity-50` / `aria-disabled:hover:bg-transparent` anywhere in `apps/web/src`.

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**
  - Delete the per-site disabled patches (the Button base style from Task 9 covers both states).
  - Ghost audit rule: a **standalone** button with a visible text label, not in a toolbar and not repeated on every item of a list, becomes `variant="outline"`. Stays ghost: icon-only buttons (`size="icon*"`), header/toolbar actions, per-item actions (Reply on each comment, row actions), the sidebar. Write the list of changed call sites into the commit body.

- [ ] **Step 4: Green**, whole suite, typecheck, lint. Take light and dark screenshots of Settings, task detail and the template editor for the PR. **Step 5: Commit** `feat(web): outline secondary actions; one disabled look`.

---

### Task 22: Type scale (task title, demoted markdown headings)

**DESIGN.md sections implemented:** Typography → Hierarchy, Named Rules (tracking scale).

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `features/tasks/task-detail.tsx:299`; `components/markdown/markdown.tsx` (add `variant?: "default" | "detail"`); call sites in task body, comments (`features/tasks/comment-block.tsx`), timeline messages (`features/session/message-block.tsx`, `outgoing-message.tsx`); `styles.css` (`.prose-of-detail`)
- Test: `components/markdown/markdown.test.tsx` (extend), `ui-contract.test.ts`

- [ ] **Step 1: Failing tests:** `<Markdown variant="detail" source="# A" />` wraps in `.prose-of-detail`; the stylesheet defines `.prose-of-detail :where(h1)` at `1.0625rem`, `h2` `0.9375rem`, `h3` `0.875rem`, all `font-weight: 650`, with letter-spacing `-0.01em` for h1/h2 and `0` for h3; the task title `h2` has `text-[1.25rem] leading-[1.75rem] font-[650] tracking-[-0.015em] flex-1`.

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement** the class changes and the CSS block; the three call sites pass `variant="detail"`. Take before/after screenshots of `/tasks/T-1` (light, 1440 and 390) for the PR (Q5).

- [ ] **Step 4: Green**, typecheck, lint. **Step 5: Commit** `feat(web): detail title 20/28; headings step down inside a document`.

---

## Phase D: bugs and quick fixes

### Task 23: Home Agents panel

**DESIGN.md sections implemented:** Colors → Status is never colour alone; Components → Rows, Empty states; Motion → Frequency (live lists never reorder under the pointer).

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/agents/home-agents.tsx`, `home-agents.test.tsx`
- Modify: `routes/_app/index.tsx:23`; `features/inbox/inbox-row.tsx:137` (row grid)

**Interfaces:**
- Consumes: `agentsQueryOptions` (`features/session/api.ts:48`), `StatusBadge` (`features/session/status-badge.tsx:67`), `.of-row`, `Skeleton`.
- Produces: `HomeAgents(): JSX.Element`; pure `orderHomeAgents(agents: AgentSummary[]): AgentSummary[]` (exported for tests).

- [ ] **Step 1: Failing tests.**

```tsx
test("needs attention first, then working, then the rest; ties by name then slug", () => {
  const a = (slug: string, displayName: string, over: Partial<AgentSummary> = {}) => ({ ...baseAgent, slug, displayName, ...over });
  const out = orderHomeAgents([
    a("idle-1", "Bea"), a("w-1", "Ann", { status: "working" }), a("err", "Zed", { status: "errored" }),
    a("stuck", "Cal", { status: "idle", stuck: true }), a("dup-b", "Bea"), a("spawn", "Kid", { kind: "ephemeral" }),
    a("arch", "Old", { archivedAt: "2026-01-01T00:00:00Z" }),
  ]);
  expect(out.map((x) => x.slug)).toEqual(["stuck", "err", "w-1", "dup-b", "idle-1"]);
});
```
  plus render tests (with `renderInRouter` and a seeded query client): up to 8 rows, each a link to `/agents/<slug>` containing the visible status label text; with 14 agents the last line is a link "All 14 agents" to `/agents`; empty → "No agents yet." and a "New agent" link; query error → "Couldn't load agents."; loading → three `[data-slot=skeleton]` plates; **frozen order**: `fireEvent.pointerEnter(panel)`, update the cache so the idle agent becomes errored, assert the row order is unchanged and that row's label now reads the errored label, then `fireEvent.pointerLeave(panel)` and assert it moved first. Same with `focusIn`/`focusOut`.

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**

```tsx
const ATTENTION = (a: AgentSummary) =>
  a.status === "errored" || a.status === "rate_limited" || a.stuck === true || a.restartPending;
const rank = (a: AgentSummary) => (ATTENTION(a) ? 0 : a.status === "working" ? 1 : 2);
export function orderHomeAgents(agents: AgentSummary[]) {
  return agents
    .filter((a) => a.kind === "persistent" && a.archivedAt === null)
    .sort((x, y) => rank(x) - rank(y) || x.displayName.localeCompare(y.displayName) || x.slug.localeCompare(y.slug));
}

export function HomeAgents() {
  const q = useQuery(agentsQueryOptions);
  const [engaged, setEngaged] = useState(false);
  const live = useMemo(() => (q.data ? orderHomeAgents(q.data) : undefined), [q.data]);
  // The order shown is frozen while the pointer or focus is inside (DESIGN.md: live lists never reorder
  // under the pointer); rows still update in place from the live data.
  const [order, setOrder] = useState<string[]>();
  if (!engaged && live && (order === undefined || !sameOrder(order, live))) setOrder(live.map((a) => a.slug));
  …render rows from `order` mapped through a slug → agent map from `live` (dropping slugs that left)…
}
```
  Panel container: `onPointerEnter={() => setEngaged(true)} onPointerLeave={() => setEngaged(false)} onFocus={() => setEngaged(true)} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setEngaged(false)}`. Row: `<Link to="/agents/$slug" params={{ slug }} className="of-row flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5">` with `<StatusBadge status={a.status} size="short" … />` (shrink-0), the name `min-w-0 truncate` with `title`, `@slug` `min-w-0 truncate font-mono text-muted-foreground`. `StatusBadge`/`statusLabel` know only `AgentStatus`, so a stuck or restart-pending agent gets a second visible short label after the badge: `<span className="shrink-0 text-[0.8125rem] text-warning-text">Stuck</span>` (use `text-muted-foreground` if no warning text token exists) or "Restart pending", mirroring `agent-tree.tsx:149`; the test asserts the label text, not only the dot. `index.tsx:23`: `<HomeAgents />`. `inbox-row.tsx:137`: the row wrapper becomes `grid grid-cols-[minmax(0,1fr)_auto] gap-2`.

- [ ] **Step 4: Green** (+ `test/empty-states.test.tsx`), typecheck, lint. **Step 5: Commit** `fix(web): Home lists real agents, needs-attention first, stable under the pointer`.

---

### Task 24: Overflow fixes (task grid, timeline)

**DESIGN.md sections implemented:** Layout.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `features/tasks/task-detail.tsx:202-215`, `features/session/timeline.tsx:202,226`
- Test: `features/tasks/task-detail.test.tsx`, `test/session-view.test.tsx` (class assertions)

- [ ] **Step 1: Failing tests:** the task grid has `grid-cols-[minmax(0,1fr)]` and `lg:grid-cols-[minmax(0,1fr)_minmax(14rem,17.5rem)]`; every direct child of the grid and of the aside has `min-w-0`; the timeline log and each `[data-row-wrap]` have `min-w-0`.

- [ ] **Step 2: Red.** **Step 3: Implement** the class changes (spec §7.2). **Step 4: Green**, typecheck, lint. Record the §2.2 manual overflow matrix (320, 390, 768 with sidebar, 1440, 200% text at 1024, a 4-column table at 390) for the PR. **Step 5: Commit** `fix(web): long tokens and wide blocks never widen the page`.

---

### Task 25: Page header give-way; Templates header

**DESIGN.md sections implemented:** Layout; Components → Navigation.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `components/page-header.tsx`, `routes/_app/templates.index.tsx:29-41`, `features/templates/template-editor.tsx:524` (meta: mono name gets `data-slot="header-slug"`), `features/session/session-view.tsx` header meta (status badge, slug)
- Test: `apps/web/src/components/page-header.test.tsx` (new), `test/templates.test.tsx`

**Interfaces:**
- Produces: `PageHeader` gains `titleFromData?: boolean` (a data-driven h1 truncates to a `min-w-16` floor; a static one never shrinks); a `HeaderSlug` component (`components/page-header.tsx`) for mono names in `meta`: `<span data-slot="header-slug" title={value} className="min-w-0 truncate font-mono text-muted-foreground @max-[32rem]:hidden">`.

- [ ] **Step 1: Failing test:** render `PageHeader` with `title="a-40-character-template-name-xxxxxxxxxxxx"`, `titleFromData`, `meta={<><StatusBadge …/><HeaderSlug value="dev-001-…" /></>}`, `actions={<Button>Delete</Button>}`: the header has `@container`; the h1 has `min-w-16 truncate` and `title` equal to the full text; the meta wrapper `min-w-0`; the status badge wrapper `shrink-0 whitespace-nowrap`; the slug `@max-[32rem]:hidden truncate` with `title`; the actions wrapper `ml-auto shrink-0`. A static title (`titleFromData` false) has `shrink-0`. Templates index below `sm`: the new-template button's visible text is "New" (assert the `sm:hidden` / `max-sm:hidden` spans) and the Images link has `max-sm:hidden`.

- [ ] **Step 2: Red.** **Step 3: Implement** (spec §7.3, Q22). **Step 4: Green**, typecheck, lint; record the manual checks (template header at 320/390/768+sidebar, Agents at 320, an 80-char session name at 390 and 1024). **Step 5: Commit** `fix(web): header gives way slug-first; actions never leave the screen`.

---

### Task 26: Interrupt glyph and native tooltips

**DESIGN.md sections implemented:** Motion → Popovers (tooltips).

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `features/session/interrupt-button.tsx:2,59`, `features/templates/template-editor.tsx:534,543,549`, `features/tasks/link-editor.tsx:118`
- Test: `ui-contract.test.ts` (no `title=` on a `<Button` or `<Link` within those files), `test/session-view.test.tsx` (the interrupt button renders the `lucide-circle-stop` icon class)

- [ ] **Step 1–2:** failing tests, red. **Step 3:** `Square` → `CircleStop`; wrap the three template header buttons and the link-remove button in `Tooltip`/`TooltipTrigger asChild`/`TooltipContent`, removing `title=`. **Step 4:** green, typecheck, lint. **Step 5: Commit** `fix(web): stop glyph for Interrupt; real tooltips instead of titles`.

---

### Task 27: Composer copy, 64 KB pre-check, server validation message

**DESIGN.md sections implemented:** Components → Inputs (inline errors).

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/session/composer.tsx:120-213`; `apps/server/src/errors.ts:31-40`
- Test: `apps/web/src/test/composer.test.tsx` (extend); `apps/server/src/errors.test.ts` (extend)

- [ ] **Step 1: Failing tests.**
  - Web: with `turnOpen: false` and Urgent checked the button's accessible name is "Send" and no hint text is visible (the reserved hint line is empty); with `turnOpen: true` it is "Send urgent" and the hint reads "Interrupts the current turn, then runs next."; a 70 KB message (`"é".repeat(36_000)` = 72,000 bytes) shows "This message is 71 KB; the limit is 64 KB. Shorten it to send." and `fetch` was not called; the draft remains.
  - Server:
    ```ts
    test("a validation message is the issue's own sentence, never the schema path", async () => {
      const app = Fastify().withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
      registerErrorHandlers(app);
      app.post("/m", { schema: { body: sendMessageBodySchema } }, async () => ({}));
      app.get("/p/:n", { schema: { params: z.object({ n: z.coerce.number().int("Must be a whole number") }) } }, async () => ({}));
      const big = await app.inject({ method: "POST", url: "/m", payload: { body: "x".repeat(70_000) } });
      expect(big.json().error.message).toBe("Message is larger than 64 KB");
      const p = await app.inject({ method: "GET", url: "/p/1.5" });
      expect(p.json().error.message).toBe("Must be a whole number");
      expect(p.json().error.message).not.toMatch(/\//);
    });
    ```
- [ ] **Step 2: Red** (`pnpm vitest run apps/server/src/errors.test.ts`; web file).
- [ ] **Step 3: Implement.**
  - `errors.ts`: `const first = err.validation?.[0]?.message; … message: first ?? "Invalid request"`.
  - `composer.tsx`: `import { MAX_BODY_BYTES } from "@open-factory/shared";` (export it from the package index if it isn't); in `send()`, before `setSending(true)`: `const bytes = new TextEncoder().encode(sent.trim()).length; if (bytes > MAX_BODY_BYTES) { setError(\`This message is ${Math.ceil(bytes / 1024)} KB; the limit is 64 KB. Shorten it to send.\`); return; }`. Labels: `const urgentNow = urgent && agent.turnOpen;` the button contains `<span className="grid"><span className={cn("[grid-area:1/1]", urgentNow && "invisible")}>Send</span><span className={cn("[grid-area:1/1]", !urgentNow && "invisible")} aria-hidden={!urgentNow}>Send urgent</span></span>` with `aria-label={urgentNow ? "Send urgent" : "Send"}`; the hint `<p>` renders whenever `urgent` (reserving the line) and its text only when `agent.turnOpen`.
- [ ] **Step 4: Green**, `pnpm test` for both files, typecheck, lint. **Step 5: Commit** `fix: composer copy, a 64 KB check before sending, validation messages without schema paths`.

---

### Task 28: One send key for both composers

**DESIGN.md sections implemented:** Components → Composers.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/lib/send-key.ts`, `send-key.test.ts`
- Modify: `features/session/composer.tsx:24,150-156`; `features/tasks/comment-composer.tsx:97,113`
- Test: `test/composer.test.tsx`, `features/tasks/comment-composer.test.tsx`

**Interfaces:**
- Produces: `isSendKey(e: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "keyCode" | "isComposing">, coarse?: boolean): boolean`; `isCoarsePointer(): boolean`.

- [ ] **Step 1: Failing test.**

```ts
test.each([
  [{ key: "Enter" }, false, true],
  [{ key: "Enter", shiftKey: true }, false, false],
  [{ key: "Enter", metaKey: true }, false, true],
  [{ key: "Enter", ctrlKey: true }, true, true],
  [{ key: "Enter" }, true, false],
  [{ key: "Enter", isComposing: true }, false, false],
  [{ key: "Enter", keyCode: 229 }, false, false],
  [{ key: "a" }, false, false],
])("%o coarse=%s → %s", (e, coarse, expected) => {
  expect(isSendKey({ shiftKey: false, metaKey: false, ctrlKey: false, keyCode: 13, isComposing: false, ...e }, coarse)).toBe(expected);
});
```
  Component tests: Enter posts a comment (fetch called once); Shift+Enter inserts a newline; the comment helper line ends with "Enter to post." on a fine pointer and doesn't on a coarse one (`fakeMatchMedia` for `(pointer: coarse)`).

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**
```ts
export const isCoarsePointer = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
/** Enter sends everywhere; Shift+Enter adds a line; ⌘/Ctrl+Enter also sends; on touch, plain Enter adds a line;
 *  an IME-confirming Enter never sends (Safari fires it as keyCode 229). DESIGN.md → Composers. */
export function isSendKey(e: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "keyCode" | "isComposing">, coarse = isCoarsePointer()): boolean {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return false;
  if (e.metaKey || e.ctrlKey) return true;
  return !e.shiftKey && !coarse;
}
```
  Both composers call `isSendKey(e.nativeEvent)`; the comment helper appends " Enter to post." only when `!isCoarsePointer()` (read once per render).

- [ ] **Step 4: Green**, typecheck, lint. **Step 5: Commit** `feat(web): Enter sends in both composers`.

---

## Phase E: timeline performance

### Task 29: Reducer keeps an ordered array; one commit per frame; memoized Markdown

**DESIGN.md sections implemented:** Motion → Performance.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `features/session/session-state.ts` (state shape, `frames` action, `withEvents`, `eventsInOrder`), `features/session/use-session.ts:30,90,118-121` (listener, dispatch wrapper, memos), `components/markdown/markdown.tsx`
- Test: `features/session/session-state.test.ts` (extend or create), `features/session/use-session-batching.test.tsx` (new), `components/markdown/markdown.test.tsx`

**Interfaces:**
- Produces: `SessionState.ordered: SessionEvent[]`; action `{ type: "frames"; messages: ServerMessage[] }`; `eventsInOrder(s) => s.ordered`; `Markdown = memo(...)` with `REMARK_PLUGINS` at module scope.

- [ ] **Step 1: Failing tests.**
  - Reducer: appending live events above the max keeps the earlier entries' array prefix identical (`next.ordered.slice(0, n)` elements `===`) and never calls `Array.prototype.sort` (spy); an `earlier` page sorts once; a `frames` batch of three `session_event`s copies the map once (spy on `Map` constructor calls via a wrapper or assert one new map identity) and equals three single `frame` dispatches; an `agent_status` frame keeps `state.events` and `state.ordered` identical.
  - Batching (fake timers, `vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] })`): ten frames delivered synchronously produce one render (count with a `useSession` consumer's render counter) after `vi.advanceTimersToNextFrame()`; frames for another agent schedule nothing; with `document.hidden` stubbed true the flush comes after 100ms; a local `queued` dispatch flushes pending frames first (order preserved); unmount cancels the pending frame.
  - Markdown: re-rendering the parent with the same `source` doesn't call `ReactMarkdown` again (mock `react-markdown` with a counting component).

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**

```ts
// session-state.ts (parts)
export interface SessionState { /* … */ events: Map<number, SessionEvent>; ordered: SessionEvent[]; /* … */ }

/** Adds events; the ordered array is appended when every new seq is above the current max (the live
 *  case), else sorted once. */
function withEvents(s: Pick<SessionState, "events" | "ordered">, evs: SessionEvent[]) {
  const fresh = evs.filter((e) => !s.events.has(e.seq));
  if (fresh.length === 0) return { events: s.events, ordered: s.ordered };
  const events = new Map(s.events);
  for (const e of fresh) events.set(e.seq, e);
  const max = s.ordered.at(-1)?.seq ?? 0;
  const sortedFresh = fresh.length > 1 ? [...fresh].sort((a, b) => a.seq - b.seq) : fresh;
  const ordered = sortedFresh[0].seq > max
    ? s.ordered.concat(sortedFresh)
    : [...events.values()].sort((a, b) => a.seq - b.seq);
  return { events, ordered };
}

case "frames": {
  // Fold a batch; consecutive session_events become one withEvents call (one map copy).
  let next = s;
  let pending: SessionEvent[] = [];
  const drain = () => { if (pending.length) { next = { ...next, ...withEvents(next, pending) }; pending = []; } };
  for (const m of a.messages) {
    if (m.type === "session_event" && "agent" in m && m.agent === next.slug && !next.windowed) {
      pending.push(m.event);
      continue;
    }
    drain();
    next = sessionReducer(next, { type: "frame", message: m });
  }
  drain();
  return next;
}
export const eventsInOrder = (s: SessionState) => s.ordered;
```
  `loaded`/`earlier`/single `frame` use `withEvents` too; `initialSessionState.ordered = []`.

```ts
// use-session.ts (parts)
const [state, dispatchRaw] = useReducer(sessionReducer, initialSessionState);
const queue = useRef<ServerMessage[]>([]);
const scheduled = useRef<(() => void) | null>(null); // the cancel function of the pending flush
const flush = useCallback(() => {
  scheduled.current?.();
  scheduled.current = null;
  if (queue.current.length === 0) return;
  const messages = queue.current;
  queue.current = [];
  dispatchRaw({ type: "frames", messages });
}, []);
/** Every local action flushes pending frames first, so order is preserved. */
const dispatch = useCallback((a: SessionAction) => { flush(); dispatchRaw(a); }, [flush]);
useEffect(
  () =>
    ws.listen((m) => {
      if (!("agent" in m) || m.agent !== slug) return; // other agents never touch this state
      queue.current.push(m);
      if (scheduled.current) return;
      if (document.hidden) {
        const t = setTimeout(flush, 100); // rAF pauses in background tabs
        scheduled.current = () => clearTimeout(t);
      } else {
        const id = requestAnimationFrame(flush);
        scheduled.current = () => cancelAnimationFrame(id);
      }
    }),
  [ws, slug, flush],
);
useEffect(() => () => { scheduled.current?.(); scheduled.current = null; queue.current = []; }, [slug]);
const events = useMemo(() => eventsInOrder(state), [state.ordered]); // biome: depend on state.ordered only
```
  Note: `useReducer`'s `dispatch` is replaced by the wrapper everywhere in the hook (`loaded`, `earlier`, `queued`, `agent`, `reset`).

```tsx
// markdown.tsx
const REMARK_PLUGINS = [remarkGfm];
export const Markdown = memo(function Markdown({ source, variant = "default" }: { source: string; variant?: "default" | "detail" }) {
  /* … same body, remarkPlugins={REMARK_PLUGINS}, wrapper adds "prose-of-detail" when variant === "detail" … */
});
```

- [ ] **Step 4: Green** (+ `test/session-view.test.tsx`, `features/session/*.test.ts*`), typecheck, lint. **Step 5: Commit** `fix(web): one commit per frame; append-only ordering; memoized markdown` (AGENTS.md types are feat, fix, refactor, chore).

---

### Task 30: Stable rows and stable sets

**DESIGN.md sections implemented:** Motion → Performance.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `features/session/rows.ts` (add `stabilizeRows`, `stableSet`), `features/session/use-session.ts:119-121`
- Test: `features/session/rows.test.ts` (extend)

**Interfaces:**
- Produces: `stabilizeRows(prev: readonly Row[], next: Row[]): Row[]`; `stableSet<T>(prev: Set<T> | undefined, next: Set<T>): Set<T>`.

- [ ] **Step 1: Failing tests.**
  - Building rows twice from the same events and stabilizing returns the previous array (`toBe`).
  - Appending one event: every previous row object is reused (`toBe`) and the new row is new.
  - An `update_group` whose `envelopes` array is rebuilt with the same elements is reused.
  - A tool row whose `truncated` object is rebuilt with the same values is reused.
  - A tool result arriving replaces that tool row (new object) and keeps its unchanged children (`toBe` per child).
  - `stableSet(prev, new Set(prev))` returns `prev`; a set with a new member returns the new one.

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**

```ts
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;

/** Event objects are compared by identity (immutable, kept in the map); arrays element by element; plain
 *  objects (a tool's `truncated`) shallowly. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (isPlainObject(a) && isPlainObject(b) && !("type" in a)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
  }
  return false;
}

function stabilizeRow(old: Row, row: Row): Row {
  if (old.kind !== row.kind) return row;
  const o = old as Record<string, unknown>;
  const r = row as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== Object.keys(o).length) return row;
  let children: Row[] | undefined;
  for (const k of keys) {
    if (k === "children") {
      children = stabilizeRows(o.children as Row[], r.children as Row[]);
      continue;
    }
    if (!sameValue(o[k], r[k])) return children === undefined && row.kind === "tool"
      ? { ...row, children: stabilizeRows((old as Extract<Row, { kind: "tool" }>).children, row.children) } as Row
      : row;
  }
  if (children !== undefined && children !== o.children) return { ...row, children } as Row;
  return old;
}

/** Reuses the previous row object for every unchanged row, so memoized rows skip rendering (spec §9.3). */
export function stabilizeRows(prev: readonly Row[], next: Row[]): Row[] {
  if (prev.length === 0) return next;
  const byKey = new Map(prev.map((r) => [r.key, r]));
  let same = prev.length === next.length;
  const out = next.map((row, i) => {
    const old = byKey.get(row.key);
    const s = old ? stabilizeRow(old, row) : row;
    if (s !== prev[i]) same = false;
    return s;
  });
  return same ? (prev as Row[]) : out;
}

export function stableSet<T>(prev: Set<T> | undefined, next: Set<T>): Set<T> {
  if (prev && prev.size === next.size) {
    for (const x of next) if (!prev.has(x)) return next;
    return prev;
  }
  return next;
}
```
  Simplify `stabilizeRow`'s early return during implementation if the reviewer prefers (the requirement: a changed field yields a new row object that still carries stabilized `children`). `use-session.ts`:
```ts
const prevRows = useRef<Row[]>([]);
const rows = useMemo(() => (prevRows.current = stabilizeRows(prevRows.current, buildRows(events))), [events]);
const prevFailed = useRef<Set<string>>();
const failedIds = useMemo(() => (prevFailed.current = stableSet(prevFailed.current, deliveryFailedIds(events))), [events]);
// interruptedEnds the same way
```
  (Writing a ref inside `useMemo` is acceptable here because the memo is pure with respect to its inputs; the reviewer checks it against `vercel-react-best-practices` and may move it to a small `useStable(prev => …)` helper.)

- [ ] **Step 4: Green**, typecheck, lint. **Step 5: Commit** `fix(web): unchanged timeline rows keep their identity`.

---

### Task 31: Memoized timeline items and the incremental tabindex pass

**DESIGN.md sections implemented:** Motion → Performance.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `features/session/timeline-item.tsx`, `features/session/timeline-perf.test.tsx`
- Modify: `features/session/timeline.tsx:156-245` (props, callbacks, row map, MutationObserver)

**Interfaces:**
- Consumes: stable `rows`, `failedIds`, `interruptedEnds` (Task 30).
- Produces:
```ts
export type TimelineItemProps = {
  row: Row; slug: string; spawned?: boolean; lit: boolean; firstOfSeq: boolean; tabKey: string | undefined;
  expanded: ReadonlySet<string>; failedIds: ReadonlySet<string>; interruptedEnds: ReadonlySet<number>;
  toggle(key: string): void; onRowFocus(key: string): void;
};
export const TimelineItem: React.MemoExoticComponent<(p: TimelineItemProps) => JSX.Element>;
export function itemPropsEqual(a: TimelineItemProps, b: TimelineItemProps): boolean;
```

- [ ] **Step 1: Failing tests** (`timeline-perf.test.tsx`): mock `./timeline-row` with a counting wrapper (`vi.mock("./timeline-row", async (orig) => …)`) and `@/components/markdown/markdown` with a counting `Markdown`; render `SessionView` (or `Timeline` with `useSession` driven by a fake WS from `test/session-fixtures.ts`) with 200 events:
  - an `agent_status` frame → 0 new `TimelineRow` renders, 0 `Markdown` renders;
  - one appended `session_event` (an assistant `text`) → exactly 1 new `TimelineRow` and 1 `Markdown` render;
  - a `tool_result` for a running tool → exactly that tool row re-renders (count 1);
  - a `delivery_failed` for one message → exactly that message row re-renders;
  - toggling one tool row → 1 re-render; moving focus with ArrowDown → 2 re-renders (old and new tab row);
  - ten frames in one task → one commit (with fake rAF).
  Plus a unit test of `itemPropsEqual`: a nested child's key entering `expanded`, or becoming `tabKey`, makes it return false; an unrelated key doesn't.

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**

```tsx
// features/session/timeline-item.tsx
import { memo } from "react";
import { CopyLink } from "./copy-link";
import type { Row } from "./rows";
import { TimelineRow } from "./timeline-row";

function subtree(row: Row, out: Row[] = []): Row[] {
  out.push(row);
  if (row.kind === "tool") for (const c of row.children) subtree(c, out);
  return out;
}

/** Re-render only when this row, or something that decides how it or a descendant looks, changed (spec §9.4). */
export function itemPropsEqual(a: TimelineItemProps, b: TimelineItemProps): boolean {
  if (a.row !== b.row || a.slug !== b.slug || a.spawned !== b.spawned || a.lit !== b.lit ||
      a.firstOfSeq !== b.firstOfSeq || a.toggle !== b.toggle || a.onRowFocus !== b.onRowFocus) return false;
  for (const r of subtree(a.row)) {
    if (a.expanded.has(r.key) !== b.expanded.has(r.key)) return false;
    if ((a.tabKey === r.key) !== (b.tabKey === r.key)) return false;
    if (a.interruptedEnds.has(r.seq) !== b.interruptedEnds.has(r.seq)) return false;
    if (r.kind === "message" && a.failedIds.has(r.message.id) !== b.failedIds.has(r.message.id)) return false;
  }
  return true;
}

export const TimelineItem = memo(function TimelineItem(p: TimelineItemProps) {
  const { row } = p;
  return (
    <div
      data-row-wrap
      {...(p.firstOfSeq ? { id: `event-${row.seq}` } : {})}
      {...(p.lit ? { "data-highlighted": "true" } : {})}
      className={`group relative min-w-0 rounded-md pr-8 ${row.kind === "message" || row.kind === "outgoing" ? "pt-3" : ""} ${p.lit ? "bg-[color-mix(in_oklab,var(--signal)_26%,transparent)]" : ""}`}
    >
      <TimelineRow
        slug={p.slug}
        spawned={p.spawned}
        row={row}
        expanded={p.expanded as Set<string>}
        toggle={p.toggle}
        rowProps={(r) => ({ "data-row": r.key, tabIndex: r.key === p.tabKey ? 0 : -1, onFocus: () => p.onRowFocus(r.key) })}
        failedIds={p.failedIds as Set<string>}
        interruptedEnds={p.interruptedEnds as Set<number>}
      />
      <CopyLink url={`${location.origin}/agents/${encodeURIComponent(p.slug)}?event=${row.seq}`} focusable={row.key === p.tabKey} />
    </div>
  );
}, itemPropsEqual);
```
  `timeline.tsx`: `const toggle = useCallback((k: string) => setExpanded(…), [])`; `const onRowFocus = useCallback((k: string) => setActiveKey(k), [])`; the map renders `<TimelineItem key={row.key} row={row} lit={row.key === litKey} firstOfSeq={rows[i - 1]?.seq !== row.seq} tabKey={tabKey} … />`. (`rowProps` inside `TimelineItem` is created per render of that item only; `TimelineRow` is not memoized itself, so that's fine.)
  MutationObserver (`:162-179`): split `apply` into `applyTo(root: ParentNode)`; run `applyTo(content)` on mount/`tabKey` change; the observer callback runs `applyTo` on each `addedNodes` element only:
```ts
const mo = new MutationObserver((records) => {
  for (const rec of records) for (const n of rec.addedNodes) if (n instanceof HTMLElement) applyTo(n);
});
```
  where `applyTo` also handles `n` itself matching the selector.

- [ ] **Step 4: Green** (+ the whole session suite: `test/session-view.test.tsx`, deep-link and roving focus tests), typecheck, lint. **Step 5: Commit** `fix(web): timeline rows re-render only when they change`.

---

## Phase F: motion polish and perceived speed

### Task 32: Pending screen inside the shell; chevrons

**DESIGN.md sections implemented:** Motion → Durations (chevrons), Frequency; Shapes → The pitch (pending screen).

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `components/route-states.tsx:9-17`, the shell's `SidebarInset` usage (`routes/_app.tsx`, add `relative`), `features/session/tool-call-row.tsx:69`, `features/settings/usage-section.tsx:109`, `features/session/quiet-line.tsx:31`, `features/session/compaction-marker.tsx:23`
- Test: `test/route-states.test.tsx` (extend), `ui-contract.test.ts`

- [ ] **Step 1: Failing tests:** inside the shell `AppPending`'s status element has `absolute inset-0` and `animate-in fade-in-0 duration-150`, not `fixed`; at the root (no shell) it is `fixed inset-0`; every chevron listed has `transition-transform duration-150 ease-(--ease-out)`; the two `<details>` rows render a chevron with `group-open:rotate-90` (or `[details[open]>summary_&]:rotate-90`).

- [ ] **Step 2: Red.** **Step 3: Implement** (spec §8.2, §8.4; Enter-toggled chevrons in the tool row call `runInstant(() => toggle(key))` when the toggle came from the keyboard: the row's `onKeyDown` path). **Step 4: Green**, typecheck, lint. **Step 5: Commit** `fix(web): pending screen stays in the content area; chevrons rotate on spec`.

---

### Task 33: Perceived speed: loaders don't block on cached summaries

**DESIGN.md sections implemented:** Components → Empty states and loading.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `routes/_app/agents.$slug.tsx:16-22`, `routes/_app/tasks.$key.tsx` (on top of Task 4), `features/session/session-view.tsx` (header/strip from the list cache; skeleton rows), `features/tasks/task-detail.tsx` (placeholder, skeleton plates, nothing editable while placeholder), `features/tasks/api.ts` (a `summaryFromList(qc, key)` helper), `features/session/api.ts` (`summaryFromAgentsList(qc, slug)`), `routes/_app/agents.index.tsx:124` (`EmptyAgents` skeleton line)
- Test: `test/session-view.test.tsx`, `features/tasks/task-detail.test.tsx`, `test/agents-list.test.tsx`

**Interfaces:**
- Produces: `summaryFromAgentsList(qc: QueryClient, slug: string): AgentSummary | undefined` (scans `qc.getQueriesData<AgentSummary[]>({ queryKey: ["agents"] })`); `taskSummaryFromList(qc, key): TaskSummary | undefined` (scans the tasks list pages in the cache).

- [ ] **Step 1: Failing tests.**
  - With the agents list cached and the agent detail GET held open, navigating to `/agents/dev-001` renders the header name and status immediately (no `AppPending`), with skeleton rows in the timeline area; resolving the GET renders the timeline.
  - With nothing cached, the route still awaits and an unknown slug still shows not-found.
  - Task: with the tasks list cached and the detail held, `/tasks/T-1` shows the title and status at once, the body area shows `[data-slot=skeleton]` plates, and the status/assignee menus and Edit buttons are disabled; a later `task_not_found` renders `ResourceNotFound`.
  - Agents page: while prerequisites load, `EmptyAgents` renders a one-line skeleton (not nothing).

- [ ] **Step 2: Red.**

- [ ] **Step 3: Implement.**
```ts
loader: async ({ context, params, preload }) => {
  const qc = context.queryClient;
  const opts = agentDetailQueryOptions(params.slug);
  if (summaryFromAgentsList(qc, params.slug)) {
    void qc.prefetchQuery(opts); // the page renders from the list's summary meanwhile (spec §11)
    return;
  }
  try { await (preload ? qc.ensureQueryData(opts) : qc.ensureQueryData(opts)); }
  catch (e) { if (e instanceof ApiError && e.code === "agent_not_found") throw notFound(); }
},
```
  Task loader: the same shape around Task 4's branch. `SessionView`: `const agent = state.agent ?? summaryFromAgentsList(qc, slug);` for the header and strip; when `state.agent` is undefined and `error` is `agent_not_found`, render `ResourceNotFound`. `TaskDetailView`: `useQuery({ ...taskDetailOptions(key), placeholderData: () => toPlaceholder(taskSummaryFromList(qc, key)) })` where `toPlaceholder` fills the summary fields and leaves body/comments/activity empty; while `isPlaceholderData`, render static `Skeleton` plates for the body and activity and pass `disabled` to the editing controls.

- [ ] **Step 4: Green**, whole web suite, typecheck, lint. **Step 5: Commit** `fix(web): session and task pages render from the list cache while their detail loads`.

---

## Phase G: final review, verification and PR

### Task 34: Whole-branch review, verification, PR

**DESIGN.md sections implemented:** all of the above (review only).

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

- [ ] **Step 1: React review.** A fresh reviewer invokes `vercel-react-best-practices` and checks the whole React diff (`git diff origin/main...HEAD -- apps/web`) against it: re-renders (stable props into memoized components, no inline objects into `TimelineItem`, no context values recreated per render in `Sheet`/`Drawer` providers: wrap them in `useMemo`), effects that should be derived state, waterfalls in loaders, list keys, bundle size (Vaul is the only new import; check it isn't pulled into the initial chunk unnecessarily: the sidebar imports it, so it is, and that's accepted), and `useSyncExternalStore` usage. Fix findings in a separate commit.
- [ ] **Step 2: Spec coverage review.** Walk spec §2 (acceptance criteria) and §4 (checklist) item by item and point to the commit and test for each. Anything missing becomes a fix commit, not a PR note.
- [ ] **Step 3: Verify for real.** From a clean clone of the branch: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint:ci`, `pnpm test`, `pnpm build`, then the dev loop (`pnpm compose up -d`, `pnpm dev`) and click through Home, Agents, a session, a task, Templates, Schedules, Settings on desktop and at 390. Record what ran and the output.
- [ ] **Step 4: Manual checks, recorded for the PR** (screenshots and recordings attached or linked in the PR):
  - Q5: task detail before/after (light; 1440 and 390).
  - Q8: a menu over a plate in light and dark (tune `--float-edge` if needed and say so), and the dark 40% scrim.
  - Q7: the eight avatar swatches at 24px in both themes next to the 6px status dots (hue 120 against the warning ochre); drop to seven if two can't be told apart, and amend DESIGN.md and the tokens accordingly.
  - §2.7: DevTools Performance recordings before (on `origin/main`) and after, on a 2,000-event session with 4× CPU throttling: frame time on an `agent_status` frame, on a `session_event`, and while scrolling; also the sidebar collapse and the pending loading mark. Post the numbers on #78 and #80 (their triggers).
  - Q23: on a real phone, a drag-dismiss and a button close of the confirm drawer (300ms vs 200ms by feel).
  - Overlays at normal and 10% animation speed: sheet, dialog, drawer and scrim together; ⌘B on mobile (no replayed slide); keyboard-opened menu (no animation).
  - Reduced motion: loading mark lit and still, spinners still, sheets and drawers fade.
  - §2.2 overflow matrix; header checks (§7.3); the break-ui stress data from `seed-worst.mjs` against a **cloned** DB only: 40-char slugs, a 64-char secret, 30 crons, 214 agents in the manager Select and the assignee menu, duplicate display names, Agents at 320, browser font 24px at 1024.
- [ ] **Step 5: Open the PR** (authorized to push and open, not merge), base `main`, following `.github/pull_request_template.md` and AGENTS.md:
  - Title: `feat: U1 UI foundation` (no scope: the diff spans web, server and DESIGN.md).
  - What / Why / Approach (one bullet per decision: "<decision>, rather than <alternative>, because <reason>", e.g. Vaul with `!important` overrides rather than a custom presence; keyframes, not interruptible open/close; Radix Select rather than cmdk in U1; per-overlay keyboard stamp rather than a global two-frame flag) / Changes grouped by area (DESIGN.md, primitives, controls, overlays, timeline, data layer, bugs, server).
  - Link the spec, this plan and the decision issue #77. Close nothing except what U1 delivers; list #78–#83 as follow-ups that stay open. Remove the template's HTML comments. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
  - Attach the manual-check evidence from Step 4 and list anything that couldn't be verified.
- [ ] **Step 6: Check CI** until green; fix and push if not.
