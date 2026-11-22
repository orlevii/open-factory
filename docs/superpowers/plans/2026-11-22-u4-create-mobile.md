# U4 Create Flows and Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every create and edit form opens in a sheet over the page you are on (with stacked sheets for missing prerequisites), outcomes whose control is gone toast through Sonner, phones get a touch layout (drawer menus, long-press, 40px hit areas, a messaging composer), the template editor moves to CodeMirror 6 (or keeps the textarea), and the break-ui leftovers close, as five stacked PRs on U3.

**Architecture:** A module-level sheet store (`useSyncExternalStore`) and one `SheetHost` in the `_app` layout render a parent and at most one child sheet over any page, with lazily loaded bodies, in-memory drafts and thin redirect routes for the old form URLs. Toasts go through one `notify()` wrapper around Sonner, held while a modal is open and lifted above docked composers. Menus go through one `AdaptiveMenu` (dropdown ≥48rem, Vaul drawer below); long-press is a hook that opens the same menu. CodeMirror lives in one lazy wrapper used only by the template editor.

**Tech Stack:** TypeScript, pnpm 12.21.0 monorepo; React 19 + Vite + TanStack Router/Query (`apps/web`); Fastify + better-auth (`apps/server`); Zod (`packages/shared`); Radix (`radix-ui`), `vaul@1.1.2`, `cmdk@1.1.1` (installed); new: `sonner@2.0.8` (PR1) and the CodeMirror set (PR4); Vitest + Testing Library (jsdom); Biome; Playwright (evidence only, outside the repo).

**Spec:** `docs/superpowers/specs/2026-11-22-u4-create-mobile-design.md` (commit 478f8f0; decisions issue #118; follow-ups #119–#122). Read it with this plan; section numbers (§n) and acceptance numbers (A n) are the spec's. DESIGN.md amendment text is in spec §14.

## Global Constraints

- Five stacked PRs (spec §17). PR1's base is `u3/5-shared-composer` (#117). Each PR leaves the app working and depends on no later PR. PR4 is droppable as a unit; PR5 never depends on PR4's code.
- Every task that touches `apps/web`: **Implementer and reviewer invoke `vercel-react-best-practices` and follow it.** (Repeated in each such task.) The stack is React 19 + Vite + TanStack Router/Query, not Next.js: skip server-component and Next-specific rules.
- **Dependencies:** only `sonner@2.0.8` (PR1) and the CodeMirror set in spec §12.1 (PR4), added with `pnpm --filter @open-factory/web add --save-exact <pkg>@<version>`. The effective supply-chain policy is pnpm 12.21.0's default `minimumReleaseAge` of 1440 minutes (the repo sets none). Record `pnpm --version`, `pnpm config get minimumReleaseAge` (prints `undefined` → the default applies) and each version's publish date (`npm view <pkg> time --json`) in the PR body. **Never loosen any pnpm supply-chain setting**, no overrides or exceptions; if an install is blocked, stop and report to `main`.
- **Resource rules (the machine was overloaded during U3):**
  1. Only one headless-browser evidence pass runs at a time across all devs: every pass takes the lock `/tmp/of-u4-evidence.lock` (`mkdir`, released in a `trap`), see Task 14.
  2. Evidence passes and full-suite runs never overlap: the full suite also takes the lock. Locally Vitest runs with `--maxWorkers=50%`.
  3. Every evidence pass kills its browser, server, Vite and throwaway DB when it ends (`trap … EXIT`/`finally`) and leaves no headless browser of its own behind: it kills only its own process group (never a global `pkill`, which would kill other teams' passes), and its leak check looks at that group (`pgrep -g $PGID` prints nothing).
  4. Tasks run targeted tests (`pnpm vitest run --maxWorkers=50% <paths>`); the full suite (`pnpm test -- --maxWorkers=50%`) runs only at PR end.
- **Evidence passes** use a throwaway database and `FACTORY_HOME`, the fake Claude from the U3 harness (`FACTORY_CLAUDE_BIN` → `fake.mjs`), **never real Claude credentials** and never `~/.open-factory-spike`. Each is budgeted (stated per PR) with **one** fix round; anything left goes to the PR body as a finding or a follow-up issue.
- TDD where logic is pure or hook-shaped: write the failing test, run it, implement, run it, commit. Tests check behaviour, not DESIGN.md prose or token values.
- Copy is exact as the spec quotes it (sentence case, no exclamation marks).
- Sheets are never URLs. No task adds a `?sheet=` param (Q1).
- `docs/product/` is gitignored and the owner's: no task edits the behaviour docs (follow-up #122). Evidence files go to `/Users/orlevi/projects/open-factory/docs/product/ui-review/u4-evidence/pr<N>/` (as U3 did).
- Commands (repo root of the worktree): `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test -- --maxWorkers=50%`; one file: `pnpm vitest run --maxWorkers=50% <path>`.
- Commit messages are conventional (`feat(web): …`, `feat(server): …`, `feat(shared): …`, `docs: …`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- PR bodies follow `.github/pull_request_template.md` (What, Why, Approach as "<decision>, rather than <alternative>, because <reason>", Changes by area; template comments removed), link the spec and #118, and end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Never merge.

## Delivery and parallelism

| PR | Branch | Base | Title | Tasks | Dev |
|---|---|---|---|---|---|
| 1 | `u4/1-sheets` | `u3/5-shared-composer` | `feat(web): create and edit tasks and schedules in sheets, toasts` | 1–15 | A |
| 2 | `u4/2-agent-sheets` | `u4/1-sheets` | `feat(web): new and edit agent in sheets with inline setup` | 16–27 | A |
| 3 | `u4/3-mobile` | `u4/2-agent-sheets` | `feat(web): mobile pass: drawer menus, long-press, touch targets, phone composer` | 28–37 | A |
| 4 | `u4/4-template-editor` | `u4/3-mobile` (stacked; developed from `u3/5-shared-composer`) | `feat(web): CodeMirror template editor` (or `chore(web): keep the template textarea` on fallback) | 38–43 | B |
| 5 | `u4/5-leftovers` | `u4/4-template-editor` (or `u4/3-mobile` if PR4 is dropped) | `fix: break-ui leftovers: blockers in lists, name and email limits, scroll restoration` | 44–48 | B |
| — | on `u4/5-leftovers` | | Whole-U4 review | 49 | A or B |

- **Dev A** runs PR1 → PR2 → PR3 in `.worktrees/u4-a`, sequentially (each builds on the previous one's code).
- **Dev B** starts PR4 at once in `.worktrees/u4-b`, branching from `u3/5-shared-composer`. PR4 touches none of PR1–3's files except `components/markdown/markdown-editor.tsx` (a new optional prop, Task 41), `features/templates/template-editor.tsx` (PR2 changes one entry-point line, Task 23), `styles.css` and `DESIGN.md` (separate sections). When dev A pushes `u4/3-mobile`, dev B rebases: `git rebase --onto u4/3-mobile u3/5-shared-composer u4/4-template-editor`.
- **Dev B** starts PR5 only after `u4/3-mobile` is pushed (PR5 shares `task-list.tsx`, `status-label.tsx`, `agents.index.tsx`, `agent-tree.tsx` with PR2–3), branching from `u4/4-template-editor`. PR5 imports nothing PR4 adds. If PR4 is dropped: `git rebase --onto u4/3-mobile u4/4-template-editor u4/5-leftovers` and retarget PR5's base.
- Inside PR1, Tasks 8–9 (`describeCron`, Repeats select) don't depend on Tasks 1–6 and can be done first or in between. Inside PR3, Tasks 28 and 29 (hook, menu) are independent of each other.
- Evidence passes (Tasks 14, 26, 36, 42, 47) are serialized across both devs by the lock.
- After a lower PR merges, retarget the next PR's base and rebase (`git rebase --onto <new-base> <old-base> <branch>`).

## File map

| File | Responsibility | PR |
|---|---|---|
| `apps/web/src/features/sheets/sheet-store.ts` | `openSheet`, `openChildSheet`, `closeSheet`, `closeChildSheet`, `useSheet`, `resetSheets`, types | 1 |
| `apps/web/src/features/sheets/drafts.ts` | `useSheetDraft`, `hasDraft`, `clearDraft`, `resetDrafts` | 1 |
| `apps/web/src/features/sheets/merge-server.ts` | `mergeServer` (moved from `schedule-form.tsx`) | 1 |
| `apps/web/src/features/sheets/sheet-host.tsx` | `SheetHost`, `preloadSheet`, close-on-navigation | 1 |
| `apps/web/src/features/sheets/sheet-bodies.ts` | the lazy body registry per kind | 1, 2 |
| `apps/web/src/features/sheets/form-footer.tsx` | `SheetFormFooter` (primary, Close, "Draft restored · Discard") | 1 |
| `apps/web/src/features/sheets/body-skeleton.tsx` | static skeletons per kind | 1, 2 |
| `apps/web/src/components/ui/toaster.tsx` | `Toaster`, `notify`, modal hold | 1 |
| `apps/web/src/lib/composer-height.ts` | `registerDockedComposer` → `--composer-h` | 1 |
| `apps/web/src/features/tasks/new-task-sheet.tsx` | New task body | 1 |
| `apps/web/src/features/schedules/describe-cron.ts` | `describeCron` | 1 |
| `apps/web/src/features/schedules/repeats-field.tsx` | Repeats select + Custom | 1 |
| `apps/web/src/features/schedules/new-schedule-sheet.tsx`, `edit-schedule-sheet.tsx` | schedule bodies | 1 |
| `apps/web/src/features/agents/derive-slug.ts` | `deriveSlug`, `foldLetters`, `useTakenNames` | 2 |
| `apps/web/src/features/settings/forms/{add-credential,add-secret,add-project}-form.tsx` | extracted forms with `frame` | 2 |
| `apps/web/src/features/templates/new-template-form.tsx` | New template form and body | 2 |
| `apps/web/src/features/agents/agent-form-state.ts` | `useAgentFormState` | 2 |
| `apps/web/src/features/agents/address-line.tsx`, `template-field.tsx`, `more-options.tsx` | New agent parts | 2 |
| `apps/web/src/features/agents/new-agent-sheet.tsx`, `edit-agent-sheet.tsx` | agent bodies | 2 |
| `apps/web/src/features/agents/lifecycle.ts` | `resyncAgent`, `archiveAgent`, `restoreAgent` actions with toasts | 2 |
| `apps/web/src/hooks/use-long-press.ts` | `useLongPress` | 3 |
| `apps/web/src/components/ui/adaptive-menu.tsx` | `AdaptiveMenu` and parts | 3 |
| `apps/web/src/features/templates/code-editor.tsx` | CodeMirror wrapper | 4 |
| `apps/web/src/features/templates/code-editor-setup.ts` | extensions, theme, highlight style, diagnostics mapping | 4 |

---

# PR 1 — `u4/1-sheets`: tasks and schedules in sheets, toasts

Setup (once, dev A): `cd /Users/orlevi/projects/open-factory && git fetch && git worktree add .worktrees/u4-a -b u4/1-sheets origin/u3/5-shared-composer && cd .worktrees/u4-a && pnpm install`. Later PRs branch in the same worktree (`git checkout -b u4/2-agent-sheets`).

### Task 1: Sheet store

Implements §5.2. A: 2.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (m3) `getSnapshot` returns the module `state` object itself (replaced only on change, never rebuilt per read); `openChildSheet` keeps the same `parent` reference; the host passes `closeSheet` itself as the body's `close` (no wrapper per render).

**Files:**
- Create: `apps/web/src/features/sheets/sheet-store.ts`
- Test: `apps/web/src/features/sheets/sheet-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SheetSpec =
    | { kind: "new-agent"; template?: string }
    | { kind: "edit-agent"; slug: string }
    | { kind: "new-task"; assignee?: string }
    | { kind: "new-schedule"; target?: string }
    | { kind: "edit-schedule"; key: string }
    | { kind: "new-template"; then: "open-editor" };
  export type ChildSpec =
    | { kind: "add-credential" } | { kind: "add-project" }
    | { kind: "add-secret"; name: string } | { kind: "new-template"; then: "return" };
  export type OpenParent = SheetSpec & { id: number; at: string; instant: boolean };
  export type OpenChild = ChildSpec & { id: number; parentId: number };
  export function openSheet(spec: SheetSpec, opts?: { instant?: boolean; at?: string }): void;
  export function openChildSheet(spec: ChildSpec, onDone: (name: string) => void): void;
  export function completeChild(childId: number, name: string): void; // calls onDone only if its parent is still the open one
  export function closeChildSheet(): void;
  export function closeSheet(): void;
  export function useSheet(): { parent?: OpenParent; child?: OpenChild };
  export function getSheetState(): { parent?: OpenParent; child?: OpenChild };
  export function resetSheets(): void; // sign-out
  export function currentPathname(): string; // injected; default window.location.pathname
  export function setPathnameSource(fn: () => string): void; // SheetHost sets it to the router's resolved pathname
  ```

- [ ] **Step 1: Failing tests**

```ts
beforeEach(() => resetSheets());
test("openSheet records the pathname it belongs to", () => {
  setPathnameSource(() => "/tasks");
  openSheet({ kind: "new-task" });
  expect(getSheetState().parent).toMatchObject({ kind: "new-task", at: "/tasks", instant: false });
  openSheet({ kind: "new-agent" }, { at: "/agents", instant: true });
  expect(getSheetState().parent).toMatchObject({ kind: "new-agent", at: "/agents", instant: true });
});
test("opening while open swaps in place and keeps one parent; each open gets a fresh id", () => {
  openSheet({ kind: "new-task" }); const a = getSheetState().parent!.id;
  openSheet({ kind: "new-schedule" }); expect(getSheetState().parent!.id).not.toBe(a);
});
test("a child needs a parent (throws in tests) and there is never more than one", () => {
  expect(() => openChildSheet({ kind: "add-credential" }, () => {})).toThrow();
  openSheet({ kind: "new-agent" });
  openChildSheet({ kind: "add-credential" }, () => {});
  openChildSheet({ kind: "add-project" }, () => {});
  expect(getSheetState().child).toMatchObject({ kind: "add-project" });
});
test("a late child result reaches only the parent instance that opened it", () => {
  const done = vi.fn();
  openSheet({ kind: "new-agent" });
  openChildSheet({ kind: "add-credential" }, done);
  const childId = getSheetState().child!.id;
  closeSheet(); openSheet({ kind: "new-agent" });
  completeChild(childId, "prod");
  expect(done).not.toHaveBeenCalled();
});
test("closeSheet closes both; resetSheets drops pending callbacks", () => { /* … */ });
test("useSheet re-renders subscribers on change only", () => { /* renderHook + act */ });
```

- [ ] **Step 2:** `pnpm vitest run --maxWorkers=50% apps/web/src/features/sheets/sheet-store.test.ts` → FAIL.
- [ ] **Step 3: Implement** with the `features/shortcuts/sheet-store.ts` pattern: one module `state` object replaced immutably on each change, a `Set` of listeners, `useSyncExternalStore(subscribe, get, get)`. `openChildSheet` throws when `import.meta.env.MODE === "test"` and there is no parent, else no-ops. Callbacks live in a `Map<number, { parentId; onDone }>` cleared by `closeSheet` and `resetSheets`.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(web): an in-memory store for sheets`.

### Task 2: Drafts and the server merge

Implements §5.5. A: 2.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (M1) `edit-*` drafts store `{ values, base }` (`base` = the server copy the user edited against). On restore, before first render, start from `mergeServer(draft.values, draft.base, serverNow)`. Live server changes merge **in render**: keep the previous server values in state and, when the query's data identity differs, set `values = mergeServer(values, prevServer, serverNow)` and `prevServer = serverNow` during render (the React "adjusting state on prop change" pattern), never `useEffect` + `setV` as `schedule-form.tsx:144-153` does today (Task 11 moves the schedule form onto this). Test: save a draft, change an untouched field on the server, reopen → the field shows the server value; a touched field keeps the draft.
- (m2) `initial()` runs once (a lazy ref); `save` and `clear` have stable identities (test: same function across renders); forms call `save` from their field setters, never from an effect.

**Files:**
- Create: `apps/web/src/features/sheets/drafts.ts`, `apps/web/src/features/sheets/merge-server.ts`
- Modify: `apps/web/src/features/schedules/schedule-form.tsx` (import `mergeServer` from the new module; delete the local copy at :57-67), `apps/web/src/components/app-sidebar.tsx:112-118` (`signOut` calls `resetSheets()` and `resetDrafts()` beside `resetUploads()`)
- Test: `apps/web/src/features/sheets/drafts.test.ts`, `apps/web/src/features/sheets/merge-server.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DraftKey = "new-agent" | "new-task" | "new-schedule" | "new-template" | `edit-agent:${string}` | `edit-schedule:${string}`;
  /** Start values come from the draft when one exists, else from `initial()`; writes go to the map
   *  through a ref and never re-render the host. `restored` is true when the start came from a draft. */
  export function useSheetDraft<T>(key: DraftKey, initial: () => T): { start: T; restored: boolean; save(v: T): void; clear(): void };
  export function hasDraft(key: DraftKey): boolean;
  export function clearDraft(key: DraftKey): void;
  export function resetDrafts(): void;
  export function draftGeneration(): number; // bumped by resetDrafts; in-flight work checks it
  export function mergeServer<T extends Record<string, unknown>>(prev: T, prevBase: T, server: T): T;
  ```

- [ ] **Step 1: Failing tests:** a draft saved by one hook instance is the next instance's `start` with `restored: true`; `clear()` makes the next start come from `initial()` with `restored: false`; `resetDrafts()` clears every key and bumps `draftGeneration()`; `save` with a value deep-equal to the hook's `initial()` deletes the key, so an untouched form counts as no draft (`hasDraft` false, `restored` false next time); `mergeServer` keeps touched fields and follows the server for untouched ones (move the existing cases from `schedule-form.test.tsx`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (`Map<DraftKey, unknown>`; deep-equal via `JSON.stringify` of plain values). **Step 4:** Run these and `schedule-form.test.tsx` → PASS.
- [ ] **Step 5:** Commit `feat(web): in-memory sheet drafts`.

### Task 3: `Sheet` stacking, keyboard closes, no drag on fields

Implements §5.3 (stacking, Esc, drag). A: 2.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/components/ui/sheet.tsx` (props `stacked?: boolean`, `onStripClick?`; width `w-[min(27rem,100%)]` when stacked; overlay stamped on Esc; export `closeSheetInstantly(el)`), `apps/web/src/components/ui/drawer.tsx` (pass `noBodyStyles` and a `max-h-[82svh]` class when stacked), `apps/web/src/components/ui/textarea.tsx` and `apps/web/src/components/markdown/markdown-editor.tsx` (add `data-vaul-no-drag` to the textarea)
- Test: `apps/web/src/components/ui/sheet.test.tsx`, `apps/web/src/components/ui/drawer.test.tsx`

**Interfaces:**
- Produces: `Sheet({ open, onOpenChange, modal?, stacked?, children })`; `SheetContent` reads `stacked` from context. On desktop a stacked sheet's overlay is the strip: clicking the overlay closes only that sheet (Radix default). Drawer: `Drawer({ …, stacked?: boolean })` → Vaul `Root` gets `noBodyStyles` when stacked.

- [ ] **Step 1: Failing tests:** stacked desktop content has the 27rem class and the parent stays mounted and open; stacked phone drawer root receives `noBodyStyles` (spy on the Vaul Root props via a module mock) and the content carries `max-h-[82svh]`; Esc stamps `data-instant` on both `[data-slot=sheet-overlay]` and content before closing; a textarea inside `SheetContent` has `data-vaul-no-drag`.
- [ ] **Step 2–4:** Run → FAIL; implement; PASS (also `confirm-dialog.test.tsx`, `overlay-timing.test.tsx`).
- [ ] **Step 5:** Commit `feat(web): stacked sheets and instant keyboard closes`.

### Task 4: `SheetHost`, lazy bodies, close on navigation, the form footer

Implements §5.3, §5.5 (Close, "Draft restored · Discard"). A: 2.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (M2) Each `sheetBodies` entry also has `prefetch(qc: QueryClient, spec): void` that starts the body's queries (`qc.prefetchQuery`/`ensureQueryData` for each list or detail it reads). `openSheet` (via the host) and `preloadSheet(kind, spec?)` on intent call `load()` and `prefetch()` together, so data and chunk load in parallel. Bodies read with `useSuspenseQueries` (one call, parallel) or `useQuery` + the skeleton, never sequential `useSuspenseQuery` calls. Test: with a deferred chunk, the body's queries are requested before the chunk resolves.
- (M3) The `React.lazy` components are created once at module scope (a `Map<kind, LazyExoticComponent>` filled on first use); `preloadSheet` calls the same `load` the lazy component uses. The idle-preload effect in `_app.tsx` returns a cleanup (`cancelIdleCallback` / `clearTimeout`); the `router.subscribe("onResolved", …)` effect returns its unsubscribe; `setPathnameSource` is called in an effect, not during render.
- (m9) Render-count test (React `Profiler` around `SheetHost` and the `_app` shell): typing in a body's field re-renders neither.

**Files:**
- Create: `apps/web/src/features/sheets/sheet-host.tsx`, `apps/web/src/features/sheets/sheet-bodies.ts`, `apps/web/src/features/sheets/body-skeleton.tsx`, `apps/web/src/features/sheets/form-footer.tsx`
- Modify: `apps/web/src/routes/_app.tsx:200-203` (mount `<SheetHost />` beside `<GlobalShortcuts />`; on mount, call `requestIdleCallback(() => preloadAllSheets())` with a `setTimeout` fallback)
- Test: `apps/web/src/features/sheets/sheet-host.test.tsx`

**Interfaces:**
- Consumes: Task 1 store, Task 3 `Sheet`.
- Produces:
  ```ts
  // sheet-bodies.ts: kind → lazy body. PR1 registers new-task, new-schedule, edit-schedule; PR2 the rest.
  export type BodyProps<S> = { spec: S; sheetId: number; close(): void };
  export const sheetBodies: { [K in SheetSpec["kind"] | ChildSpec["kind"]]?: { load: () => Promise<{ default: ComponentType<BodyProps<any>> }>; prefetch(qc: QueryClient, spec: any): void; title: string } };
  export function preloadSheet(kind: SheetSpec["kind"] | ChildSpec["kind"], spec?: SheetSpec | ChildSpec): void; // load() + prefetch(qc, spec)
  export function preloadAllSheets(): void;
  // form-footer.tsx
  export function SheetFormFooter(props: { submitLabel: string; pendingLabel: string; pending: boolean; restored: boolean; onDiscard(): void; left?: ReactNode; note?: ReactNode }): JSX.Element;
  ```
- Host rules: `useSheet()`; parent `Sheet open={!!parent}`; child `Sheet stacked open={!!child}`; `Suspense` **inside** `SheetContent` with `BodySkeleton kind`; `setPathnameSource(() => router.state.resolvedLocation?.pathname ?? window.location.pathname)`; `router.subscribe("onResolved", (e) => { const p = getSheetState().parent; if (p && e.toLocation.pathname !== p.at) { stampInstant both; closeSheet(); } })`. Focus-on-open is the body's job (on mount), so `SheetContent` gets `onOpenAutoFocus={(e) => e.preventDefault()}` and the body focuses its first field (desktop) or the content (phone).
- Footer: "Close" (ghost, `type="button"`, closes; draft kept); when `restored`, a muted line "Draft restored · " + a ghost text button "Discard" (`type="button"`).

- [ ] **Step 1: Failing tests** (render the app with `renderApp` from `apps/web/src/test/render-app.tsx` and a stub body registered for `new-task`):

```tsx
test("a sheet opened over /tasks closes when the path changes, not on a search change", async () => { … });
test("a redirect-opened sheet (at: '/tasks') survives the navigation that lands on /tasks", async () => { … });
test("the child sheet stacks over the parent; Esc closes only the child", async () => { … });
test("the body's chunk loads lazily; the skeleton shows header and field rows meanwhile", async () => { … });
test("Close keeps the draft; reopening shows 'Draft restored · Discard'; Discard clears it", async () => { … });
```

- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): one sheet host over every page`.

### Task 5: Sonner, `notify`, the CSS override and the composer lift

Implements §10.1. A: 5.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (M4) The held-toast `MutationObserver` connects only while at least one toast is held, observing `document.body` with `{ subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "aria-modal"] }`, and disconnects after the flush (test: after flush no observer stays connected — spy on `MutationObserver.prototype.disconnect`). `--composer-h`: the API is `registerDockedComposer(id: string, el: HTMLElement): () => void` (id from `useId`); one `ResizeObserver` per element, registered in a layout effect with cleanup; writes are batched in one `requestAnimationFrame`, and `document.documentElement.style.setProperty` runs only when the maximum changes (test: a resize that doesn't change the max writes nothing).
- (m7) `Toaster`'s `toastOptions`, `classNames` and `offset` objects are module constants (two offset constants, desktop and phone), not literals per render.
- (§10.1) `notify()` holds toasts while a modal layer is open and shows them when the last one closes (spec §10.1); this is the Step 3 "held" test.

**Files:**
- Modify: `apps/web/package.json` (via `pnpm --filter @open-factory/web add --save-exact sonner@2.0.8`), `pnpm-lock.yaml`, `apps/web/src/routes/_app.tsx` (mount `<Toaster />`), `apps/web/src/styles.css` (unlayered `!important` block after the Vaul block), `apps/web/src/components/composer/composer.tsx` (accept `docked?: boolean`; when docked, register its height)
- Modify: `apps/web/src/features/session/session-view.tsx:237`, `apps/web/src/features/inbox/inbox-pane.tsx:200` (`<Composer docked …>`)
- Create: `apps/web/src/components/ui/toaster.tsx`, `apps/web/src/lib/composer-height.ts`
- Test: `apps/web/src/components/ui/toaster.test.tsx`, `apps/web/src/lib/composer-height.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function notify(t: { text: string; action?: { label: string; run(): void }; undo?: () => Promise<void> }): void;
  export function Toaster(): JSX.Element; // mounted once in _app
  export function registerDockedComposer(id: string, el: HTMLElement): () => void; // one ResizeObserver per element; --composer-h on <html> = the max, rAF-batched
  ```
- Rules (spec §10.1): `toastOptions={{ unstyled: true, classNames: {...}, duration }}`, `visibleToasts={3}`, `expand`, `position` from `useIsMobile()` (`bottom-left` / `bottom-center`), `offset={{ bottom: "calc(16px + var(--composer-h, 0px))", left: "calc(var(--sidebar-current-width) + 16px)" }}` on desktop; the left offset reads a `--sidebar-current-width` variable the sidebar wrapper sets from its state (expanded `--sidebar-width`, collapsed `--sidebar-width-icon`, `components/ui/sidebar.tsx:133-134`) and transitions as `transform` 200ms `--ease-in-out` (none under `[data-instant]`). Duration `Math.max(5000, text.length * 60)`. **Modal hold:** `notify` checks `document.querySelector(MODAL)` with the selector exported from `lib/shortcuts.ts` (export it as `MODAL_SELECTOR`); if a modal is open, queue the toast and flush it from a `MutationObserver` on `document.body` when none remains. **Undo:** the action button disables after the first click, calls `undo()`, dismisses; on failure `notify({ text: err instanceof ApiError ? err.message : "Couldn't undo: can't reach the server." })`.
- CSS block (pin to 2.0.8; selectors from `node_modules/sonner/dist/styles.css` / the injected string in `dist/index.mjs`; verify each one exists before writing it):
  ```css
  /* Sonner 2.0.8 (pinned) injects unlayered rules: 400ms transform/opacity/height, translateY(100%) enter,
     scaled collapsed stack, z-index 999999999, reduced-motion transition:none. Re-check these selectors on any upgrade. */
  [data-sonner-toaster] { z-index: 40 !important; }
  [data-sonner-toast] { transition: transform 200ms var(--ease-out), opacity 200ms var(--ease-out) !important; }
  [data-sonner-toast][data-mounted="false"] { transform: translateY(8px) !important; opacity: 0 !important; }
  [data-sonner-toast][data-removed="true"] { transition-duration: 150ms !important; transform: translateY(8px) !important; opacity: 0 !important; }
  @media (prefers-reduced-motion: reduce) { [data-sonner-toast] { transition: opacity 150ms var(--ease-out) !important; transform: none !important; } }
  ```

- [ ] **Step 1: Record the policy:** `pnpm --version` (expect 12.21.0), `pnpm config get minimumReleaseAge`, `npm view sonner@2.0.8 time --json | grep '"2.0.8"'`. Save the three lines for the PR body.
- [ ] **Step 2: Install:** `pnpm --filter @open-factory/web add --save-exact sonner@2.0.8`. If blocked: stop and report to `main`. Check `apps/web/package.json` shows `"sonner": "2.0.8"` (no caret).
- [ ] **Step 3: Failing tests:** `notify` shows text and an Undo that runs once (second click ignored); a failing undo shows the server message; with an open modal (`<div role="dialog" data-state="open">`) a toast is held and appears after the modal is removed; duration for a 120-char text is 7200ms; two registered elements of 80 and 120px (stubbed `ResizeObserver`) → `--composer-h: 120px`, unregister b → 80px, unregister a → 0px, and a resize that keeps the max writes nothing. (No grep or guard test: the version is exact-pinned and the CSS block's comment says to re-check on upgrade; which outcomes toast is enforced in review against spec §10.2.)
- [ ] **Step 4–5:** Implement; PASS.
- [ ] **Step 6:** Commit `feat(web): toasts through Sonner, held under modals and above composers`.

### Task 6: Redirect routes for tasks and schedules

Implements §5.4 (tasks, schedules). A: 1.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/sheets/redirect.ts`
- (The route files switch to `sheetRedirect` in the task that registers their body: `tasks.new.tsx` in Task 7, `schedules.new.tsx` in Task 10, `schedules.$key.tsx` in Task 11, `templates.new.tsx` in Task 18, `agents.new.tsx` in Task 21, `agents.$slug_.edit.tsx` in Task 23.)
- Test: `apps/web/src/test/sheet-redirects.test.tsx`

**Interfaces:**
- Produces: `sheetRedirect(spec: SheetSpec, to: string, opts: { preload: boolean; router: AnyRouter }): never | undefined` — returns `undefined` when `preload`; else `openSheet(spec, { at: to, instant: !opts.router.state.resolvedLocation })` and `throw redirect({ to, replace: true })`.
- Routes:
  ```ts
  export const Route = createFileRoute("/_app/schedules/$key")({
    beforeLoad: ({ params, preload, context }) =>
      sheetRedirect({ kind: "edit-schedule", key: params.key.toUpperCase() }, "/schedules", { preload, router: context.router }),
  });
  ```
  (if `context` has no router, import the app router instance from `apps/web/src/router.tsx`). `schedules.new` keeps `validateSearch` for `target`; `tasks.new` has none.

- [ ] **Step 1: Failing tests** (a test router with two throwaway routes `/from` and `/to`, `/to-form` using `sheetRedirect({ kind: "new-task" }, "/to", …)`): navigating to `/to-form` lands on `/to` with the `new-task` sheet open (`at: "/to"`) and the history entry replaced; a preload of `/to-form` opens nothing; on a fresh load (`resolvedLocation` undefined) the sheet is `instant`; an in-app navigation from `/from` gives `instant: false`. The real routes get their own redirect tests in Tasks 7, 10, 11, 18, 21, 23 (e.g. `/schedules/s-12` → key `S-12`, `?target=ada`).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): old form URLs open their sheet`.

### Task 7: New task sheet

Implements §8, §5.6 (task rows), §10.2 (task created). A: 1, 2, 5.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (m4) `MoreOptions` open state is derived in render: `open = userOpen ?? (hasValues || hasError)`, where `userOpen` is `undefined` until the user clicks the disclosure; no effect sets it.
- (m5) `newTask()` reads `router.state.location` at call time to find the session slug or the `assignee` filter; it subscribes to nothing.

**Files:**
- Create: `apps/web/src/features/tasks/new-task-sheet.tsx`
- Modify: `apps/web/src/features/tasks/task-form.tsx` (props `draftKey`, `prefill?: { assignee?: string }`, field order Title, Assignee, Description; Dependencies and Links inside a `MoreOptions` disclosure that opens itself when it holds values or an error; the parent-agnostic `onSubmit` stays), `apps/web/src/features/tasks/actions.ts` (`newTask()` → `openSheet({ kind: "new-task", assignee })` where `assignee` is the session's slug when the current path is a session, else the Tasks `assignee` filter), `apps/web/src/features/palette/rank.ts:150-152` (new `kind: "open-sheet"` with `sheet: SheetSpec["kind"]`), `apps/web/src/features/palette/command-palette.tsx:253-256` (handle `open-sheet`), `apps/web/src/features/shortcuts/global-shortcuts.tsx:20`, `apps/web/src/routes/_app/tasks.index.tsx:68` (button, `preloadSheet("new-task")` on intent), `apps/web/src/routes/_app/tasks.new.tsx` (redirect, Task 6), `apps/web/src/features/sheets/sheet-bodies.ts`
- Create: `apps/web/src/features/sheets/more-options.tsx` (`MoreOptions({ open, onOpenChange, reason?, children })`: a disclosure; the chevron rotates only on its own click — opening because `open` became true from outside sets `data-instant` on the chevron)
- Test: `apps/web/src/features/tasks/task-form.test.tsx`, `apps/web/src/features/tasks/new-task-sheet.test.tsx`, `apps/web/src/test/command-palette.test.tsx`, `apps/web/src/test/global-shortcuts.test.tsx`

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5.
- Produces: `NewTaskSheet` body (default export, `BodyProps<{ kind: "new-task"; assignee?: string }>`); `MoreOptions`.

- [ ] **Step 1: Failing tests:** `c` in `/agents/ada` opens New task with Assignee `@ada`; `c` on `/tasks?assignee=bo` prefills `@bo`; a non-empty draft keeps its own assignee; the sheet description reads "For Ada" when prefilled; fields in order Title, Assignee, Description; More options closed, opens itself with a dependency error after submit; success closes, clears the draft and calls `notify({ text: "Created T-42.", action: { label: "Open" } })`; **late result:** close the sheet while `createTask` is pending → on success `notify("Created T-42." · Open)` and no navigation; on failure `notify({ text: <message>, action: { label: "Open form" } })` reopening with the kept draft; **stale reference:** a draft whose assignee has ended shows "@x has ended; pick another." and clears it; Enter in a field while pending posts once.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): New task in a sheet, prefilled from where you are`.

### Task 8: `describeCron`

Implements §9.3 (summary). A: 6. Independent of Tasks 1–7.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/schedules/describe-cron.ts`
- Test: `apps/web/src/features/schedules/describe-cron.test.ts`

**Interfaces:**
- Produces: `describeCron(cron: string): string | undefined` (no zone; the caller appends ` (${zone})`); `REPEATS_PRESETS: readonly { label: string; cron: string }[]` = Every hour `0 * * * *`, Daily at 09:00 `0 9 * * *`, Weekdays at 09:00 `0 9 * * 1-5`, Mondays at 09:00 `0 9 * * 1`; `presetOf(cron: string): string | undefined`.

- [ ] **Step 1: Failing tests:**

```ts
test.each([
  ["*/15 * * * *", "Every 15 minutes"], ["*/7 * * * *", undefined],
  ["0 */6 * * *", "Every 6 hours"], ["0 */5 * * *", undefined],
  ["30 * * * *", "Every hour at :30"],
  ["0 9 * * *", "Daily at 09:00"], ["5 17 * * 1-5", "Weekdays at 17:05"],
  ["0 9 * * 1,4", "Mondays and Thursdays at 09:00"], ["0 9 * * 0", "Sundays at 09:00"], ["0 9 * * 7", "Sundays at 09:00"],
  ["0 9 * * 1,3,5", "Mondays, Wednesdays and Fridays at 09:00"], ["0 9 * * 1,2,3,4", undefined],
  ["0 8 1 * *", "Monthly on the 1st at 08:00"], ["0 8 22 * *", "Monthly on the 22nd at 08:00"],
  ["0 8 23 * *", "Monthly on the 23rd at 08:00"], ["0 8 11 * *", "Monthly on the 11th at 08:00"],
  ["0 8 29 * *", undefined], ["0 9 * * 1-3", undefined], ["0 9 1 1 *", undefined], ["nonsense", undefined],
])("%s → %s", (c, out) => expect(describeCron(c)).toBe(out));
```

- [ ] **Step 2–4:** FAIL → implement (split on whitespace, exactly 5 fields, regexes per rule) → PASS.
- [ ] **Step 5:** Commit `feat(web): plain-language summaries for common crons`.

### Task 9: Repeats select, Custom cron and the When layout

Implements §9.3. A: 6.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/schedules/repeats-field.tsx`
- Modify: `apps/web/src/features/schedules/when-field.tsx:50-70` (Repeats mode renders `RepeatsField`), `apps/web/src/features/schedules/schedule-form.tsx` (Time zone directly under When; `RunPreview` right under the Repeats field; the message body without `font-mono`)
- Test: `apps/web/src/features/schedules/schedule-form.test.tsx`, `apps/web/src/features/schedules/repeats-field.test.tsx`

**Interfaces:**
- Consumes: Task 8.
- Produces: `RepeatsField({ cron, onCron, zone, error, onBlurCron })`: a U1 `Select` labelled "Repeats" with the four presets and "Custom cron…"; Custom renders the cron `Input`, a "Cron help" disclosure (today's help text from `when-field.tsx:54`), and a summary line `describeCron(cron) + " (" + zone + ")"` whose height is always reserved (`min-h-[1.125rem]`, empty when no summary). A cron matching no preset selects Custom.

- [ ] **Step 1: Failing tests:** choosing "Weekdays at 09:00" sets cron `0 9 * * 1-5` and shows no cron input and no summary; Custom shows input + help + summary "Weekdays at 09:00 (Europe/Berlin)" for `0 9 * * 1-5`; an existing schedule `*/7 * * * *` opens on Custom with no summary and the line's box present; Time zone follows When in DOM order; the message textarea has no `font-mono`.
- [ ] **Step 2–4:** FAIL → implement → PASS (existing `schedule-form.test.tsx` updated where it typed into the cron field: choose Custom first).
- [ ] **Step 5:** Commit `feat(web): schedule presets first, cron as the custom case`.

### Task 10: New schedule sheet

Implements §9.1, §5.6 (schedule create entry points). A: 1, 2, 5, 6.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/schedules/new-schedule-sheet.tsx`
- Modify: `apps/web/src/features/schedules/schedule-form.tsx` (props `draftKey`, `inSheet` — when `inSheet`, no `useBlocker`, no `cancelTo`, footer via `SheetFormFooter`), `apps/web/src/features/schedules/schedule-list.tsx:33,119-130` (delete `PageOutcome` and the page-to-page outcome), `apps/web/src/routes/_app/schedules.index.tsx:47` (button opens the sheet), `apps/web/src/routes/_app/schedules.new.tsx` (redirect), `apps/web/src/features/palette/rank.ts:152` (`open-sheet`), `apps/web/src/features/sheets/sheet-bodies.ts`, `apps/web/src/features/schedules/back-link.tsx` (delete if unused after Task 11)
- Test: `apps/web/src/features/schedules/new-schedule-sheet.test.tsx`, `apps/web/src/features/schedules/schedule-list.test.tsx`

- [ ] **Step 1: Failing tests:** the Schedules header button opens New schedule; target prefilled from `spec.target` only into an empty draft; an ended or unknown `target` leaves Target empty with "@x has ended; pick another." / "There is no agent @x."; success closes, clears the draft, `notify({ text: "Created S-8.", action: { label: "Open" } })` and Open calls `openSheet({ kind: "edit-schedule", key: "S-8" })`; no inline "Created S-8." line on the list anymore; dismiss never asks (no `window.confirm`); late result rule as Task 7.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): New schedule in a sheet`.

### Task 11: Edit schedule sheet

Implements §9.2, §5.6 (schedule rows, `ScheduleBadge`, Agent details keys). A: 1, 2, 5.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (M1) Move the Edit schedule form's live merge onto Task 2's in-render rule (delete the `useEffect` + `setV` at `schedule-form.tsx:144-153`); the draft for `edit-schedule:<key>` stores `{ values, base }`.

**Files:**
- Create: `apps/web/src/features/schedules/edit-schedule-sheet.tsx` (from `schedule-edit.tsx`: state line, Pause/Resume in the header, form, deleted state as text, not-found)
- Delete: `apps/web/src/features/schedules/schedule-edit.tsx` (and its test → port the cases)
- Modify: `apps/web/src/features/schedules/schedule-row.tsx` (row opens the sheet; a `button`, not a `Link`; `preloadSheet` on intent), `apps/web/src/features/schedules/schedule-badge.tsx:15-22`, `apps/web/src/features/session/agent-details.tsx:336-341`, `apps/web/src/routes/_app/schedules.$key.tsx` (redirect), `apps/web/src/features/sheets/sheet-bodies.ts`
- Test: `apps/web/src/features/schedules/edit-schedule-sheet.test.tsx`, `apps/web/src/features/schedules/schedule-list.test.tsx`, `apps/web/src/test/agent-details.test.tsx`

- [ ] **Step 1: Failing tests:** header shows the key in mono, description the body's first line, a "Pause S-12" icon button; footer has "Save changes", Close, and a ghost crimson "Delete schedule" on the left; Delete closes, clears the draft and `notify({ text: "Deleted S-12.", undo })`; Undo calls `restoreSchedule`; an undo refused with `target_ended` toasts the server message; opened on a deleted schedule: "S-12 was deleted.", Restore (absent when the target ended), the schedule as text (target, `describeCron` or cron, zone, the message as markdown), no Save; Restore flips to the live form keeping the draft's edits, no toast; deleted by an agent while open (a refetch returns `deleted`) flips live and keeps the draft; unknown key → "There is no schedule S-12." with Close; Save closes and toasts "Saved S-12." only when the sheet's `at` isn't `/schedules`; `ScheduleBadge` and Agent details keys open the sheet over the session.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): Edit schedule in a sheet with its deleted state`.

### Task 12: Close #83 or narrow it

Implements §18 item 7.

- [ ] **Step 1:** Check whether the timezone picker and every agent picker use `Combobox`/`AgentCombobox` (`features/schedules/timezone-select.tsx:2` imports `Combobox`; grep `NativeSelect` and `<select` in `apps/web/src`, tests excluded).
- [ ] **Step 2:** If none remain native, note "closes #83" for the PR body (closing happens on merge); otherwise list what remains in the PR body. No code change in this task.

### Task 13: PR1 DESIGN.md amendments

Implements §14 (Overlays, Toasts, Motion → Durations, Gesture UI's Sonner line, Schedules line).

- [ ] **Step 1:** Apply those spec §14 bullets verbatim to `DESIGN.md` (Overlays after the ladder table at ~:316; Toasts at :318; Motion → Durations at :345; Gesture UI list at :362-369; a Schedules line in Components). Leave the forms, mobile and editor lines to PR2–PR4.
- [ ] **Step 2:** Commit `docs: DESIGN.md sheets, drafts and toasts`.

### Task 14: PR1 evidence pass (budget: 75 minutes including one fix round)

Implements §16 (evidence rules). A: 1, 2, 5, 6, 9.

**Files (outside the repo):** `/Users/orlevi/projects/open-factory/docs/product/ui-review/u4-evidence/harness/` (shared by every U4 pass), `…/u4-evidence/pr1/{shots,results,findings.md}`.

- [ ] **Step 1: Harness (first pass only):** copy `/Users/orlevi/projects/open-factory/docs/product/ui-review/u3-evidence/pr5/harness/` to `…/u4-evidence/harness/` and adapt `env.sh` (ports 3480/3481, DB `u4_evidence`, `WORK=$TMPDIR/u4-evidence-work`, `REPO` = the worktree under test). Wrap `up.sh`/`down.sh` in a runner:

```bash
#!/usr/bin/env bash
# run.sh <check.py> … : one evidence pass at a time; tears down only what this pass started.
set -euo pipefail
LOCK=/tmp/of-u4-evidence.lock
while ! mkdir "$LOCK" 2>/dev/null; do
  owner=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    echo "clearing stale lock left by dead pid $owner"; rm -rf "$LOCK"; continue
  fi
  echo "waiting for $LOCK (pid ${owner:-?}: $(cat "$LOCK/owner" 2>/dev/null))"; sleep 30
done
echo $$ > "$LOCK/pid"; echo "$USER $(date +%T) $PWD" > "$LOCK/owner"
# Everything this pass starts runs in its own process group, so teardown never touches other teams' browsers.
set -m
cleanup() {
  ./down.sh drop || true                                   # server, Vite, fake claude, throwaway DB, $WORK
  [ -n "${PGID:-}" ] && kill -- -"$PGID" 2>/dev/null || true # this pass's browsers and helpers only
  sleep 1
  if [ -n "${PGID:-}" ] && pgrep -g "$PGID" >/dev/null; then  # leak check scoped to this pass
    echo "LEAK: processes left in group $PGID:" >&2; pgrep -lg "$PGID" >&2; kill -9 -- -"$PGID" 2>/dev/null || true
  fi
  rm -rf "$LOCK"
}
trap cleanup EXIT INT TERM
./up.sh
( for c in "$@"; do ./py "$c"; done ) &   # a new process group under job control (set -m)
PGID=$!
wait "$PGID"
```

The full suite uses the same lock: `until mkdir /tmp/of-u4-evidence.lock …; trap 'rm -rf /tmp/of-u4-evidence.lock' EXIT; pnpm test -- --maxWorkers=50%`.
- [ ] **Step 2: Checks** (Playwright Chromium, light and dark, 1440 and 390, 200% text at 1440): New task from `/tasks`, from a session via `c` (prefill), and via the palette; draft kept and "Draft restored · Discard"; late result after dismiss (slow the POST in the fake server path or route-intercept); `/tasks/new` and `/schedules/S-1` typed in the address bar (instant sheet, replace); New schedule with each preset and a Custom cron (summary and zone shown once); Edit schedule live, Pause, Delete + Undo toast, deleted state from a `ScheduleBadge`; toast positions: bottom-left of the content area at 1440 and 1024 (sidebar expanded and collapsed), above the session composer, under a sheet's scrim; held while a sheet is open; `scrollWidth <= clientWidth` for every sheet at 390 and 200%.
- [ ] **Step 3:** One fix round for what fails; re-run only the failed checks. Write `findings.md` (pass/fail table, screenshots list). Anything left becomes a PR-body finding.

### Task 15: PR1 review, verify and open

- [ ] **Step 1: Review** (fresh reviewer subagent): invoke `vercel-react-best-practices` and review `git diff u3/5-shared-composer...HEAD -- apps/web` against it (skip server-component rules): no new object/function props per render into memoized children, `useSyncExternalStore` selectors return stable values, lazy bodies and preloads (bundle rules), no effect-derived state, no waterfall in sheet bodies (parallel queries), `notify` doesn't re-render the shell; and the plan's review items M1 (edit drafts merge in render from `{ values, base }`), M2 (entry points prefetch body queries with the chunk; no sequential suspense), M8 (child list writes: cancel → set → invalidate active). Fix findings in one commit.
- [ ] **Step 2: Verify** (take the lock): `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test -- --maxWorkers=50% && pnpm build`. All green.
- [ ] **Step 3:** `git push -u origin u4/1-sheets && gh pr create --base u3/5-shared-composer --title "feat(web): create and edit tasks and schedules in sheets, toasts" --body-file <body>`: template sections; link the spec and #118; the policy lines and sonner's publish date (Task 5 Step 1); the DESIGN.md edits; the evidence summary; "Stacked on #117"; a **For Or** section with Q1 (in-memory sheets, 3), Q7 toast position (2), Q9 (drafts, 3), each with its one-line why from #118; #83 per Task 12.
- [ ] **Step 4:** `gh pr checks --watch`; fix until green.

---

# PR 2 — `u4/2-agent-sheets`: New and Edit agent in sheets with inline setup

`git checkout -b u4/2-agent-sheets` from `u4/1-sheets` in `.worktrees/u4-a`.

### Task 16: `deriveSlug` and the taken names

Implements §6.3. A: 4.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/agents/derive-slug.ts`
- Test: `apps/web/src/features/agents/derive-slug.test.ts`

**Interfaces:**
- Produces: `foldLetters(s: string): string`; `deriveSlug(name: string, taken: ReadonlySet<string>): string`; `useTakenNames(enabled: boolean): ReadonlySet<string> | undefined` (agent slugs active + archived — today's `useTakenSlugs` at `agent-form.tsx:92-103`, moved here — plus human handles from the people source U3's `@` completion loads (`components/composer/mentions.ts`), plus `RESERVED_SLUGS` from `@open-factory/shared`; `undefined` until all lists answered; memoized on the three `data` references).

- [ ] **Step 1: Failing tests:**

```ts
const none = new Set<string>();
test.each([
  ["Priya Nair", "priya-nair"], ["Łukasz Żak", "lukasz-zak"], ["Søren Lund", "soren-lund"],
  ["Straße", "strasse"], ["Æther Œuvre", "aether-oeuvre"], ["Đorđe", "dorde"], ["Iğdır ı", "igdir-i"],
  ["Þór", "thor"], ["  --Ops!!  Lead-- ", "ops-lead"], ["陳大文", ""], ["🤖", ""], ["9lives", ""],
])("%s → %s", (n, s) => expect(deriveSlug(n, none)).toBe(s));
test("taken names get -2, -3", () => {
  expect(deriveSlug("Priya Nair", new Set(["priya-nair"]))).toBe("priya-nair-2");
  expect(deriveSlug("Priya Nair", new Set(["priya-nair", "priya-nair-2"]))).toBe("priya-nair-3");
});
test("a 40-char base is cut so the suffix fits, never '--2'", () => {
  const name = "abcdefghij abcdefghij abcdefghij abcdefgh"; // derives 40 chars with a hyphen at 39
  const base = deriveSlug(name, none);
  const s = deriveSlug(name, new Set([base]));
  expect(s.length).toBeLessThanOrEqual(40); expect(s).not.toMatch(/--/); expect(s.endsWith("-2")).toBe(true);
});
test("reserved and human handles count as taken", () => {
  expect(deriveSlug("Me", new Set(["me"]))).toBe("me-2");
});
```

- [ ] **Step 2–4:** FAIL → implement (fold map → NFKD → strip `\p{M}` → lowercase → `[^a-z0-9]+` → `-` → trim → cut 40 → trim → validate with `slugSchema`, `""` if invalid → suffix loop) → PASS.
- [ ] **Step 5:** Commit `feat(web): derive an agent's address from its name`.

### Task 17: Extract the Add credential, secret and project forms

Implements §7 (one form each, two frames). Independent of Task 16.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/settings/forms/add-credential-form.tsx` (from `credentials-section.tsx:109-285`, with `TokenField`, `verdictOf`, `Unverifiable` as needed), `…/forms/add-secret-form.tsx` (from `secrets-section.tsx:32-167`, with `ValueField`), `…/forms/add-project-form.tsx` (from `projects-section.tsx:105-203`)
- Modify: the three sections import them with `frame="inline"`
- Test: existing `apps/web/src/test/settings.test.tsx`; new `apps/web/src/features/settings/forms/forms.test.tsx`

**Interfaces:**
- Produces: each form takes `frame: "inline" | "sheet"`, its existing props (`existing`, `onDone`, `onCancel`, and `initialName` for secrets), and for `"sheet"` renders `SheetBody` (fields) + `SheetFooter` (primary submit, ghost Close calling `onCancel`); `"inline"` renders today's `InlineForm`. Field ids stay as today (`field-credential-name`, …). Every non-submit button is `type="button"`.

- [ ] **Step 1:** Write `forms.test.tsx` failing: each form in `"sheet"` frame renders inside a stub `Sheet`, validates, submits once on Enter, maps server errors as in Settings.
- [ ] **Step 2–4:** FAIL → move the code (no behaviour change) → PASS, and `settings.test.tsx` stays green unchanged.
- [ ] **Step 5:** Commit `refactor(web): one Add credential, secret and project form for Settings and sheets`.

### Task 18: New template form, sheet and redirect

Implements §7.4, §5.4 (`/templates/new`), §5.6 (Templates header). A: 3.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/templates/new-template-form.tsx` (`NewTemplateForm({ frame, then, onDone })` and the default-exported sheet body)
- Modify: `apps/web/src/routes/_app/templates.new.tsx` (redirect to `/templates` with `{ kind: "new-template", then: "open-editor" }`), `apps/web/src/features/templates/templates-header.tsx:26` (button), `apps/web/src/features/sheets/sheet-bodies.ts` (both `new-template` parent and child)
- Test: `apps/web/src/features/templates/new-template-form.test.tsx`, `apps/web/src/test/templates.test.tsx`

**Interfaces:**
- Consumes: `deriveSlug` (Task 16) against template names (`templatesQueryOptions`), `AddressLine` pattern — the folder line is a local component here: "Folder `templates/<name>` · Change"; Change reveals Name with help "Lowercase letters, numbers and hyphens. Also the folder name."
- Produces: on success `then: "open-editor"` → `closeSheet()` then `navigate({ to: "/templates/$name" })`; `then: "return"` → `completeChild(childId, name)` then `closeChildSheet()`.

- [ ] **Step 1: Failing tests:** fields in order Display name, folder line, Description; "Priya Nair" → `templates/priya-nair`; a taken name gets `-2`; Change reveals Name; server `template_exists` opens Name with the error; Templates header opens the sheet; `/templates/new` lands on `/templates` with the sheet; success navigates to the editor.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): New template in a sheet, name first`.

### Task 19: Split the agent form's state

Implements §6.1. Refactor; no visible change.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (M1) Edit mode stores `{ values, base }` and merges in render exactly as Task 2 describes; test: a draft saved, the server changes an untouched field (description), reopen → it shows the server's value.

**Files:**
- Create: `apps/web/src/features/agents/agent-form-state.ts`
- Modify: `apps/web/src/features/agents/agent-form.tsx` (uses the hook; keeps rendering as today until Tasks 21/23 replace it)
- Test: `apps/web/src/test/agent-form.test.tsx` (unchanged, must stay green), new `apps/web/src/features/agents/agent-form-state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function useAgentFormState(args: { mode: "create" | "edit"; agent?: AgentSummary; draftKey: DraftKey; prefill?: { template?: string } }): {
    values: Values; shown: Values; errors: Errors; touched: Partial<Record<Field, boolean>>;
    set<K extends keyof Values>(f: K, v: Values[K]): void; blur(f: Field): void; claim(f: "displayName" | "description"): void;
    setProjects(next: string[]): void; applyTemplateDefault(): void;
    submit(onSubmit: (b: CreateAgentBody | PatchAgentBody) => Promise<unknown>): Promise<"ok" | "invalid" | "failed" | "nothing">;
    pending: boolean; slow: boolean; outcome?: { tone: "success" | "error"; content: ReactNode };
    config?: TemplateConfig; missingSecrets: string[]; noCredentials: boolean; credentials?: CredentialSummary[];
    restored: boolean; discard(): void; staleNotes: Partial<Record<Field, string>>;
  };
  ```
  Values move from `useState` to `useSheetDraft(draftKey, …)` (Task 2); in edit mode untouched fields follow the server through `mergeServer` (replaces the "seeded once" comment in `agents.$slug_.edit.tsx:65`). `slug` is no longer prefilled from the template's name (spec §6.3); Task 20 provides the derivation.

- [ ] **Step 1:** Write `agent-form-state.test.ts` (renderHook): validation per field as today, `body()` diff in edit mode, server field errors mapped, draft restore, untouched edit field follows a refetch.
- [ ] **Step 2–4:** FAIL → extract → PASS (plus `agent-form.test.tsx`, adjusting only the template-name-slug cases, which now expect an empty slug until Task 20).
- [ ] **Step 5:** Commit `refactor(web): the agent form's state as a hook backed by sheet drafts`.

### Task 20: Address line

Implements §6.3 (line, Change, self-opening, server slug error), §6.2 item 3 (avatar). A: 4.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (m4) The shown slug is derived in render: `slug = slugTouched ? slug : deriveSlug(name, taken)`; no effect writes it.

**Files:**
- Create: `apps/web/src/features/agents/address-line.tsx`
- Test: `apps/web/src/features/agents/address-line.test.tsx`

**Interfaces:**
- Consumes: `deriveSlug`, `useTakenNames` (Task 16), `AgentAvatar` (`components/agent-avatar.tsx`, size 20).
- Produces: `AddressLine({ name, slug, slugTouched, onSlug, error, forceOpen, onOpened })`: closed → "[avatar] Address **@x** · Change" (or "Address: choose one · Change" when empty); the avatar's slug updates after 300ms without typing or on blur (`useDeferredSettle`: a local `useState` + `setTimeout` cleared on change), never animated; open → the slug `FormField` (prefix "@", help text from spec §6.3), focused on open. Opens itself (and focuses the input) when `forceOpen` (set by the state hook on Display name blur or submit with an empty/invalid derivation, or on a server `fields.slug` error). "Change" is `type="button"`, `whitespace-nowrap shrink-0`; the slug `[overflow-wrap:anywhere]`.

- [ ] **Step 1: Failing tests:** live update per keystroke; the taken suffix shows; Change opens the input holding the derived slug, focused; editing it stops the name from driving it; empty derivation text; `forceOpen` after blur focuses the input (no focus lost to `<body>`); avatar slug changes only after 300ms (fake timers).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): the address line under an agent's name`.

### Task 21: New agent sheet, entry points and the empty state

Implements §6.2, §6.5 (empty state), §5.4 (`/agents/new`), §5.6 (agent create entry points). A: 1, 3, 4.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (M2) The `new-agent` entry's `prefetch` starts templates, credentials, projects, secrets, both agent lists and the people list together; the body reads them with one `useSuspenseQueries` call (or `useQuery` + skeleton), never sequential suspense.

**Files:**
- Create: `apps/web/src/features/agents/new-agent-sheet.tsx`, `apps/web/src/features/agents/template-field.tsx`
- Delete: `apps/web/src/features/agents/prerequisites.tsx`, `apps/web/src/routes/_app/agents.new.tsx` content (→ redirect)
- Modify: `apps/web/src/components/app-sidebar.tsx:258`, `apps/web/src/features/agents/sidebar-tree.tsx:475`, `apps/web/src/routes/_app/agents.index.tsx:70` and its empty state ("No agents yet." + primary "Create your first agent"), `apps/web/src/features/palette/rank.ts:150` (`open-sheet`), `apps/web/src/features/templates/template-editor.tsx:545` (`openSheet({ kind: "new-agent", template: name })`), `apps/web/src/features/sheets/sheet-bodies.ts`, `apps/web/src/features/sheets/body-skeleton.tsx`
- Test: `apps/web/src/features/agents/new-agent-sheet.test.tsx`, `apps/web/src/test/empty-states.test.tsx`, `apps/web/src/test/agents-list.test.tsx`, `apps/web/src/test/sidebar-tree.test.tsx`

**Interfaces:**
- Consumes: Tasks 4, 7 (`MoreOptions`), 16, 19, 20.
- Produces: `TemplateField({ value, onChange, templates, onNewTemplate, error })`: Select items with the display name in `ItemText` and the description outside it (muted, truncated); disabled "name (has errors)"; label-row ghost "New template" (`type="button"`); the no-template and all-broken states (one broken: link to `/templates/$name`; several: link to `/templates`); `SelectContent` max height scrolls inside the drawer.
- Body: the skeleton holds until `credentials` and `templates` queries answered; order Template (+`TemplateSummary` with full description), Display name, `AddressLine`, Manager, `MoreOptions` (Description, Credential, Projects) with reasons per §6.2 ("No Claude credential yet.", "Choose a credential.", "Secret `X` isn't set." / "N secrets aren't set."); footer `SheetFormFooter` "Create agent" (min width fits "Creating…"), "Installing plugins…" as a muted line beside it after 3s; success → `closeSheet()`, clear draft, `navigate` to the session; dismissed while pending → `notify("Created @slug." · Open)` without navigating, or the error · "Open form".
- Focus: desktop Template when empty else Display name; phone the content.

- [ ] **Step 1: Failing tests:** the sheet opens with no credentials and no templates (no gate page); one credential preselected and More options closed; no credential → More options open with "No Claude credential yet."; several credentials with the selected one gone → "Choose a credential."; missing secret reason; picking a template prefills Display name and Description until touched; submit with an invalid derived slug opens the address input; server `fields.slug` opens it with the error; success navigates to `/agents/<slug>`; late success toasts and doesn't navigate; sidebar `+`, Agents header, palette, empty state and template editor's "Create agent" (with template) open it; `/agents/new?template=x` redirects to `/agents` with it open; a draft with an archived manager clears it with "@x has ended; pick another."; Enter while pending submits once.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): New agent in a sheet, name first, no gate page`.

### Task 22: Stacked setup sheets in New agent

Implements §7.1–§7.4 (stacked use), §5.3 (stacking). A: 3.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (M8) A child's success writes its list as: `await qc.cancelQueries({ queryKey })`, then `qc.setQueryData(queryKey, (old) => old && [...old, item])`, then `void qc.invalidateQueries({ queryKey, refetchType: "active" })`. Test: a list fetch already pending when the item is added resolves afterwards without dropping it.

**Files:**
- Modify: `apps/web/src/features/agents/new-agent-sheet.tsx`, `apps/web/src/features/agents/project-grant-picker.tsx:43-49` ("Add project" ghost button), `apps/web/src/features/agents/agent-form.tsx` → `TemplateSummary` moved into `template-field.tsx` (missing-secret warnings with "Add secret"), `apps/web/src/features/sheets/sheet-bodies.ts` (child bodies `add-credential`, `add-project`, `add-secret` wrapping Task 17's forms with `frame="sheet"`, titles "Add credential", "Add project", "Add secret", description "For New agent." plus, for credentials, "Saved to Settings → Credentials; other agents can use it.")
- Test: `apps/web/src/features/agents/new-agent-sheet.test.tsx` (stacking cases), `apps/web/src/test/agent-form.test.tsx`

**Interfaces:**
- Consumes: `openChildSheet`, `completeChild`, `closeChildSheet` (Task 1); forms (Task 17); `NewTemplateForm` (Task 18).
- On a child's success: `qc.setQueryData(list, add)`; `completeChild(id, name)` → the parent sets the field; `fieldEl.scrollIntoView({ block: "nearest" })`; then `closeChildSheet()`; focus the served field after close (desktop: Credential, Projects picker, Template — Template also for Add secret) or the parent drawer content (phone); a background `invalidateQueries`. Add secret: desktop focuses Value on open, phone the content.

- [ ] **Step 1: Failing tests:** "Add credential" opens a stacked sheet over New agent (parent still mounted with its typed values); verify-and-add success selects the credential and focus lands on the Credential trigger; a rejected token stays an inline error and nothing is stored; "Add project" adds it to the grants as an override; "Add secret" opens prefilled, success removes the warning, focus to Template; "New template" (stacked) selects the new template; the parent closed while the child verifies → the child's late success updates the cache only (no field write, no throw); sign-out during a pending child drops it (draft generation).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): set up a missing credential, template, project or secret without leaving New agent`.

### Task 23: Edit agent sheet

Implements §6.4, §5.4 (`/agents/$slug/edit`), §5.6 (edit entry points). A: 1.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/agents/edit-agent-sheet.tsx`
- Delete: `apps/web/src/features/agents/agent-form.tsx` (its parts now live in Tasks 19–22's modules; move any remaining helper), page code in `apps/web/src/routes/_app/agents.$slug_.edit.tsx` (→ redirect to `/agents/$slug`)
- Modify: `apps/web/src/features/agents/agent-menu.tsx:159-163`, `apps/web/src/features/session/agent-details.tsx:495-500`, `apps/web/src/features/session/timeline-row.tsx:227`, `apps/web/src/features/settings/shared.tsx:94`, `apps/web/src/features/sheets/sheet-bodies.ts`
- Test: `apps/web/src/features/agents/edit-agent-sheet.test.tsx`, `apps/web/src/test/agent-menu.test.tsx`, `apps/web/src/test/agent-details.test.tsx`

**Interfaces:**
- Restart notice: list the restart-triggering fields from the server (`grep -n "restartPending" apps/server/src/agents/*.ts` — the fields whose change sets it); while any is dirty and the agent is running, a muted line above the footer names what changed and when, e.g. "Saving restarts @ada the next time it is idle, to apply the new credential. Crons it set in this session stop." (one sentence per changed field kind: "the new credential", "the new projects", "the new manager").
- Save: `closeSheet()`, clear draft, then `notify` per §10.2: none when `parent.at === "/agents/<slug>"` and only `displayName` changed; "Saved @slug." otherwise; with `restartPending` "Saved @slug. Restarts when idle." always.

- [ ] **Step 1: Failing tests:** header "Edit agent" and the wrapping description "@slug · Template `name`"; all fields visible, no template or slug input; the restart notice appears when the credential is dirty on a running agent and names it; save toasts per the rule; "Nothing to save: no field changed." inline; archived agent → "This agent is archived." with a Restore button (wired in Task 24) and no form; spawned → "Spawned agents can't be edited."; unknown → "There is no agent @x."; archived by another tab while open → flips, draft kept; `/agents/ada/edit` lands on `/agents/ada` with the sheet; AgentMenu Edit, Agent details Edit and the timeline `edit_agent` link open it.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): Edit agent in a sheet`.

### Task 24: Agent lifecycle in `AgentMenu`, Restore everywhere it's needed

Implements §6.5, §10.2 (archive, restore, re-sync, failures). A: 5, 12.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (M6) The Agents page uses **one** shared, anchored `AgentMenu` instance (the pattern of `TreeAgentMenu`, `sidebar-tree.tsx:601`), opened by a stable `openMenu(slug, anchor?)`. Extract `const AgentTreeRow = memo(…)` from `agent-tree.tsx`: it calls `useLongPress` (Task 31) and renders a plain ⋯ `button` as a **sibling** of the row's `Link` (never a button inside an anchor). Memoize `bySlug` and `now` in the page. Tests: no Radix menu root is mounted at rest across 214 rows; one agent's status frame re-renders exactly one `AgentTreeRow` (Profiler).

**Files:**
- Create: `apps/web/src/features/agents/lifecycle.ts` (move `resync`, `archive`, `restore` logic and their copy from `agent-actions.tsx:118-316`, incl. `TemplateProblem` and `ReportsMessage`)
- Delete: `apps/web/src/features/agents/agent-actions.tsx` (and `UndoArchiveLine`), `apps/web/src/test/agent-actions.test.tsx` (port cases)
- Modify: `apps/web/src/features/agents/agent-menu.tsx` (context `"session" | "sidebar" | "list"`; groups: New task, New schedule · Edit, Usage, Open tasks, Agent details, Compact…, Stop crons… · Re-sync from template…, Archive…, Restore, Terminate…; destructive crimson; for terminated or ended spawned agents in the list only Usage and Open tasks), `apps/web/src/features/agents/agent-tree.tsx` (each row gets the `AgentMenu` ⋯ with `context="list"`), `apps/web/src/routes/_app/agents.index.tsx` (delete `justArchived` everywhere: the `validateSearch` field, the S4 bookmark redirect's `justArchived` pass-through at :27-31, and `UndoArchiveLine`; make the search schema ignore unknown keys generally — Zod `z.object` strips unknown keys by default, so check `.strict()`/`.passthrough()` isn't used and add a test), `apps/web/src/features/session/session-view.tsx:404-412` and `apps/web/src/features/inbox/inbox-pane.tsx:185-193` (Restore button running `restoreAgent` with an inline outcome), `apps/web/src/features/session/timeline-row.tsx:241-246` (runs `resyncAgent`)
- Test: `apps/web/src/test/agent-menu.test.tsx`, `apps/web/src/test/agents-list.test.tsx`, `apps/web/src/test/session-view.test.tsx`, `apps/web/src/test/inbox-pane.test.tsx`, `apps/web/src/features/session/timeline-row.test.tsx`

**Interfaces:**
- Produces: `resyncAgent(slug, qc): Promise<void>`, `archiveAgent(agent, qc, { confirm }): Promise<void>`, `restoreAgent(slug, qc, { inline?: boolean }): Promise<string | undefined>` — each toasts its outcome or failure ("Couldn't archive @slug: <message>") unless `inline`.

- [ ] **Step 1: Failing tests:** menu order and separators for a persistent live agent; Archive (with today's confirmation behaviour, unchanged) toasts "Archived @slug." with Undo calling unarchive; Restore in the menu of an archived agent toasts "Restored @slug."; Re-sync keeps today's confirmation (none or same) and toasts its outcome; a failed archive toasts the message; the session's and inbox's archived notices show a Restore button with an inline outcome; Agents-page rows have the ⋯ menu, Ended view archived rows offer Restore, terminated rows only Usage and Open tasks; `/agents?archived=only&justArchived=x` (an old URL) still lands on the Ended view with no error, and `/agents?unknownKey=1` loads normally; the timeline resync link runs the action; New task / New schedule items open their sheets prefilled.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): agent lifecycle in the agent menu, Restore where it's needed`.

### Task 25: PR2 DESIGN.md amendment

- [ ] **Step 1:** Apply spec §14's Forms line to DESIGN.md Components. Commit `docs: DESIGN.md create forms`.

### Task 26: PR2 evidence pass (budget: 90 minutes including one fix round)

Implements §16. A: 3, 4, 9, 12.

- [ ] **Step 1:** `run.sh` (Task 14) against `.worktrees/u4-a` at `u4/2-agent-sheets`, fresh DB with no credentials and no templates.
- [ ] **Step 2: Checks** (Chromium; light/dark; 1440, 390, 200% text): first agent from an empty factory end to end (New template stacked, Add credential stacked with the fake verification path, create, land in the session); the stacked strip visible at 1440 and clicking it closes only the child; on 390 the child stops short of the parent's handle and closing it doesn't scroll the page (also WebKit: `noBodyStyles`); address line with 80-char names, CJK, "Łukasz Żak"; 40-char slugs and 64-char secret names don't overflow at 320/390; Edit agent restart notice and toasts; Archive → toast Undo; Restore from the session notice, the inbox notice and the Ended view; `/agents/new?template=x` and `/agents/x/edit` from the address bar.
- [ ] **Step 3:** One fix round; `findings.md` in `…/u4-evidence/pr2/`.

### Task 27: PR2 review, verify and open

- [ ] **Step 1: Review** (fresh reviewer subagent): invoke `vercel-react-best-practices` and review `git diff u4/1-sheets...HEAD -- apps/web`: the agent form hook doesn't recreate callbacks per keystroke into memoized children (`AgentCombobox` filter stays stable — keep `excludedKey`/`canManage` from `agent-form.tsx:376-394`), taken-name set memoized, child sheets' cache writes don't trigger list refetch storms, lazy bodies, no waterfall (parallel queries in the New agent body); M1 (edit-agent drafts merge in render), M2 (prefetch with the chunk), M8 (cancel → set → invalidate in child sheets), M6 (one shared AgentMenu on the Agents page, memoized rows). Fix in one commit.
- [ ] **Step 2: Verify** (take the lock): `pnpm typecheck && pnpm lint && pnpm test -- --maxWorkers=50% && pnpm build`.
- [ ] **Step 3:** `git push -u origin u4/2-agent-sheets && gh pr create --base u4/1-sheets --title "feat(web): new and edit agent in sheets with inline setup" --body-file <body>`: template sections; spec and #118; DESIGN.md edit; evidence; **For Or**: Q4 (inline template, 3), Q24 (stacked geometry, 3), with their why from #118. Note that behaviour docs need #122.
- [ ] **Step 4:** `gh pr checks --watch`; fix until green.

---

# PR 3 — `u4/3-mobile`: drawer menus, long-press, touch targets, phone composer

`git checkout -b u4/3-mobile` from `u4/2-agent-sheets`. Tasks 28 and 29 are independent of each other.

### Task 28: `useLongPress`

Implements §11.2 (mechanics). A: 7.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (m1) Unmount clears both timers and removes `data-pressed`; test: unmounting mid-press never fires `onLongPress`.

**Files:**
- Create: `apps/web/src/hooks/use-long-press.ts`
- Test: `apps/web/src/hooks/use-long-press.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function useLongPress(onLongPress: (at: { x: number; y: number }) => void): {
    onPointerDown(e: React.PointerEvent): void; onPointerMove(e: React.PointerEvent): void;
    onPointerUp(e: React.PointerEvent): void; onPointerCancel(e: React.PointerEvent): void;
    onClickCapture(e: React.MouseEvent): void; onContextMenu(e: React.MouseEvent): void;
  };
  /** True for one pointerup after a long-press fired: menus call it to ignore the lifting finger. */
  export function consumeLongPressRelease(): boolean;
  ```
  Touch only (`e.pointerType === "touch"`); 500ms; cancel on >8px, `pointercancel`, early `pointerup`, a second pointer; sets `data-pressed` on `e.currentTarget` after 80ms (cleared on cancel/up); on fire `navigator.vibrate?.(10)`, `onLongPress({ x, y })`, swallow the next click (capture) and mark one release for `consumeLongPressRelease`; `onContextMenu` `preventDefault`s when a touch press is active or just fired. The handlers object is stable (`useMemo` with `onLongPress` held in a ref).

- [ ] **Step 1: Failing tests** (fake timers, `fireEvent.pointerDown(el, { pointerType: "touch", clientX, clientY })`): fires at 500ms; not at 499; 9px move cancels; `pointercancel` cancels; mouse never fires; `data-pressed` after 80ms and removed on up; the click after a fire is swallowed and the next one isn't; `contextmenu` during a press is default-prevented, a mouse right-click isn't; handler identity stable across renders.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): a long-press hook for touch`.

### Task 29: `AdaptiveMenu`

Implements §11.1. A: 7.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/components/ui/adaptive-menu.tsx`
- Test: `apps/web/src/components/ui/adaptive-menu.test.tsx`

**Interfaces:**
- Produces: `AdaptiveMenu({ open?, onOpenChange?, title: string, anchor?: { x: number; y: number }, children })`, `AdaptiveMenuTrigger`, `AdaptiveMenuContent`, `AdaptiveMenuItem({ asChild?, variant?: "destructive", opensOverlay?: boolean, onSelect? })`, `AdaptiveMenuSeparator`, `AdaptiveMenuLabel`, `AdaptiveMenuShortcut`. Desktop (latched at open, like `Sheet`'s `useLatchedMobile`): `DropdownMenu`; the trigger opens on `pointerdown` only for `pointerType === "mouse"` (`onPointerDown` → `if (e.pointerType !== "mouse") e.preventDefault()`, then open on click); with `anchor`, `DropdownMenuContent` anchors to a virtual element at that point; the first `pointerup` inside content after `consumeLongPressRelease()` is ignored. Phone: `Drawer` bottom with a visible muted title, 44px items (`min-h-11`), destructive crimson, a rule + 8px before a trailing destructive item, a "Cancel" row last, `Shortcut` hidden. `onSelect` runs in the same tick the close starts; when `opensOverlay`, the drawer content and overlay are stamped `data-instant` before closing.

- [ ] **Step 1: Failing tests:** ≥48rem renders a `menu` role dropdown; <48rem a drawer with the title visible and a Cancel last; a touch `pointerdown` on the trigger doesn't open, the click does; mouse `pointerdown` opens; `opensOverlay` item stamps `data-instant` and calls `onSelect` synchronously; flipping `matchMedia` while open keeps the same surface; a trailing destructive item is preceded by a separator.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): one menu that becomes a drawer on phones`.

### Task 30: Move every row and header menu onto `AdaptiveMenu`

Implements §11.1 (consumers, vanishing targets). A: 7.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (M7) `RowMenu` exposes a ref handle `{ openAt(p: { x: number; y: number }): void }` (`useImperativeHandle`); rows pass a stable `onLongPress` (a `useCallback` over the ref) that calls it, so no menu state is lifted into memoized rows. `AdaptiveMenu` keeps `RowMenu`'s lazy mount, so `useIsMobile`/`useLatchedMobile` are read only once a menu is mounted. Add `timeline-perf.test.tsx` cases: 200 rows mount no menu root and read no media query at rest; a long-press re-renders only that row's menu.
- (M6) The sidebar and Agents page each keep one shared `AgentMenu`; the long-press path calls the same stable `openMenu(slug, anchor)`.
- (m4) The sidebar menu's effective open state is derived in render: `open && agentPresent` (the target still in the list); no effect closes it.

**Files:**
- Modify: `apps/web/src/features/session/row-menu.tsx` (the lazy trigger at :124-200 mounts on intent but opens per Task 29's rule; title per row kind: "Message from <name> · <time>", "<tool> · <time>"), `apps/web/src/features/agents/agent-menu.tsx` (title = display name; items that open a sheet or confirmation get `opensOverlay`), `apps/web/src/features/schedules/schedule-row.tsx` (title = key), Settings sections using `MoreButton` + `DropdownMenu` (`credentials-section.tsx`, `secrets-section.tsx`, `projects-section.tsx`, `users-section.tsx`; title = the item's name), `apps/web/src/features/agents/sidebar-tree.tsx` (its single shared `AgentMenu` instance: when the target slug leaves the agents list, close it)
- Test: `apps/web/src/features/session/row-menu.test.tsx`, `apps/web/src/test/agent-menu.test.tsx`, `apps/web/src/features/schedules/schedule-list.test.tsx`, `apps/web/src/test/settings.test.tsx`, `apps/web/src/test/sidebar-tree.test.tsx`

- [ ] **Step 1: Failing tests:** each consumer renders a drawer with its title below 48rem; a timeline ⋯ touch `pointerdown` no longer opens; the agent menu closes when its agent disappears from the list (terminate via a status frame); a schedule row's menu closes when its schedule is deleted by a refetch; `grep -rn "DropdownMenu" apps/web/src/features` finds only `status-menu.tsx`, `assignee-menu.tsx` and the user menu in `app-sidebar.tsx` (pickers, not row menus) — assert in `ui-contract.test.ts`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): row and header menus become drawers on phones`.

### Task 31: Long-press on rows that have a menu

Implements §11.2 (where, feedback, callout). A: 7.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (M7) Every row's `onLongPress` is stable (calls the row menu's `openAt` handle or the page's `openMenu`); `timeline-perf.test.tsx` stays green with the long-press props in place.
- (M6) Agents-page rows get long-press inside the memoized `AgentTreeRow` (Task 24).

**Files:**
- Modify: `apps/web/src/features/agents/sidebar-tree.tsx` (row handlers; open the shared menu for that row with `anchor`), `apps/web/src/features/agents/agent-tree.tsx`, `apps/web/src/features/schedules/schedule-row.tsx`, the Settings row components, `apps/web/src/features/session/speaker-line.tsx`, `apps/web/src/features/session/tool-call-row.tsx` (summary line), `apps/web/src/features/session/row-chrome.tsx` (gutter), `apps/web/src/styles.css` (`[data-longpress-region] { -webkit-touch-callout: none; user-select: none }` under `@media (pointer: coarse)`; `[data-pressed]` → the 6% deeper fill on the row's own box: `.of-row[data-pressed]` and the timeline row's card/block `[data-row-box][data-pressed]`)
- Test: `apps/web/src/test/sidebar-tree.test.tsx`, `apps/web/src/test/agents-list.test.tsx`, `apps/web/src/features/session/timeline-row.test.tsx`

- [ ] **Step 1: Failing tests:** a 500ms touch press on a sidebar row opens its menu (and does not navigate); on an Agents-page row, a schedule row and a Settings row likewise; on a speaker line and a tool summary line it opens the row menu; on message prose (`.prose-of`) nothing happens and no `data-longpress-region` is on prose; `data-pressed` lands on the card for a timeline press; mouse presses do nothing.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): long-press opens a row's menu on touch`.

### Task 32: 40px hit areas

Implements §11.3. A: 8.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/components/ui/button.tsx:20-31` (add `relative` and the coarse `::after` expander to `icon`, `icon-sm`, `icon-xs`, `icon-lg`, `xs`, `sm`; `default`, `lg` → `pointer-coarse:h-10`; a new `variant`-independent prop `inForm?: boolean` → no expander, `pointer-coarse:min-h-10 pointer-coarse:px-3` real padding), `apps/web/src/components/ui/sidebar.tsx:420,552` (`after:-inset-2` → the same 40px rule on coarse), `apps/web/src/features/session/row-menu.tsx` (on coarse the ⋯ is a visible `h-10 w-8` box in the gutter, no expander), the form-inline buttons (`AddressLine` Change, `TemplateField` New template, Credential "Add credential", `ProjectGrantPicker` "Add project", "Add secret", `RepeatsField` "Cron help", `MoreOptions`, `SheetFormFooter` Discard → `inForm`), toolbar/header groups where expanders would overlap → `pointer-coarse:size-10` + `gap-1`
- Create: the expander utility in `apps/web/src/styles.css`:
  ```css
  @media (pointer: coarse) {
    .hit-40::after { content: ""; position: absolute; inset-block: min(0px, calc((100% - 2.5rem) / 2)); inset-inline: min(0px, calc((100% - 2.5rem) / 2)); }
  }
  ```
- Test: `apps/web/src/components/ui/button.test.tsx`, `apps/web/src/test/ui-contract.test.ts` (no `overflow-hidden` ancestor directly wraps an icon button in `PageHeader`, `SheetHeader`, composer toolbar — a class check on the known wrappers)

- [ ] **Step 1: Failing tests:** each icon size carries `hit-40`; `inForm` buttons have no `hit-40` and have `pointer-coarse:min-h-10`; the form buttons listed above use `inForm`; the timeline ⋯ has `pointer-coarse:h-10`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): 40px touch targets`.

### Task 33: Phone composer

Implements §11.4, #107. A: 7, 8.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/components/composer/composer.tsx:917-1060` (below 48rem via `useIsMobile()`: toolbar = attach, `/`, `@` as `size-10` ghost icons; Write/Preview and the hint line hidden (the hint stays in `aria-describedby`); right end `data-composer-actions`: Stop slot reserved (`size-10`, outline, filled square, `aria-label` "Stop" / "Stopping…") + 8px + Send `size-10` primary arrow-up `aria-label="Send"`; the placeholder carries the queued hint "Sends after @x's current step" while a turn is open), `apps/web/src/components/composer/stop-button.tsx` (icon variant)
- Test: `apps/web/src/components/composer/composer.test.tsx`

- [ ] **Step 1: Failing tests** (mock `matchMedia` <48rem): Send is an icon button named "Send"; Stop named "Stop" appears left of Send during a turn and its slot is present (same box) when no turn is open; Write/Preview tabs absent; the hint text is in the textarea's description; the toolbar's height is identical with and without an open turn (class/structure check); ≥48rem layout unchanged (existing tests green).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): the composer on phones`.

### Task 34: Headers, Agents tree, Templates and dialogs on phones

Implements §11.5, §11.6, #102. A: 9.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (m6) The status label uses `max-md:sr-only` (CSS) instead of a `useIsMobile()` branch.

**Files:**
- Modify: `apps/web/src/features/agents/agent-tree.tsx` (below 48rem the status column shows the status shape with the label `sr-only`; `title={displayName}` on the name; second-line wrapper `min-w-0 max-w-full`), `apps/web/src/routes/_app/templates.index.tsx:29-41`, `apps/web/src/features/templates/templates-header.tsx` (icon-only actions below `sm`), `apps/web/src/features/templates/template-list.tsx` (meta `flex-wrap min-w-0`), `apps/web/src/components/confirm-dialog.tsx` (title and description `[overflow-wrap:anywhere]` in both branches; the confirm button `whitespace-normal`), any `PageHeader` caller found overflowing at 320 in Step 1
- Test: `apps/web/src/test/agents-tree.test.tsx`, `apps/web/src/test/templates.test.tsx`, `apps/web/src/test/confirm-dialog.test.tsx`

- [ ] **Step 1: Reproduce #102 first** (dev server + Playwright at 390 with the break-ui worst-case seed, or the jsdom class path if obvious): name the overflowing element and cause in a note for the PR body. Verify the session header on phones already shows avatar, name, short status, Agent details and one ⋯ (U2); change nothing there if so.
- [ ] **Step 2: Failing tests** for the class contracts above.
- [ ] **Step 3–4:** Implement; PASS.
- [ ] **Step 5:** Commit `fix(web): Agents, Templates and confirmations fit a phone`.

### Task 35: PR3 DESIGN.md amendments

- [ ] **Step 1:** Apply spec §14's One row menu, Buttons/Layout (and the `control-touch` token at DESIGN.md:113 plus lines :251 and :283), Composers and Gesture UI (trigger opens on click on touch; long-press prevents the native context menu on chrome) bullets. Commit `docs: DESIGN.md touch targets, drawer menus, long-press and the phone composer`.

### Task 36: PR3 evidence pass (budget: 120 minutes including one fix round)

Implements §16. A: 7, 8, 9.

- [ ] **Step 1:** `run.sh` against `u4/3-mobile`, the break-ui worst-case seed (214 agents, 14-level chain, 25-blocker task) plus a session.
- [ ] **Step 2: Checks:** Chromium and WebKit with touch emulation (`hasTouch: true, isMobile: true`) at 320 and 390; 1024 and 1440 with a mouse; light/dark; 200% text: every row menu as a drawer with its title; long-press on sidebar, Agents, schedule and Settings rows and on timeline chrome (opens) vs prose (selects text); Android-style `contextmenu` suppressed on chrome (Chromium); a ⋯ touch-scroll doesn't open a drawer; a menu item opening a sheet: only one drawer moves; hit areas: for each standalone control, `elementFromPoint` at the four corners of its 40px box returns the control (report any miss), and no expander covers an input; phone composer (Send/Stop, no reflow when a turn opens); `scrollWidth <= clientWidth` at 320/390/200% for `/agents`, `/templates`, `/tasks`, every sheet, a session; stacked drawers with the keyboard up (WebKit).
- [ ] **Step 3:** One fix round; `findings.md` in `…/u4-evidence/pr3/`.

### Task 37: PR3 review, verify and open

- [ ] **Step 1: Review** (fresh reviewer subagent): invoke `vercel-react-best-practices` and review `git diff u4/2-agent-sheets...HEAD -- apps/web`: long-press handlers stable and not re-created per row render (timeline rows stay memoized: `timeline-perf.test.tsx` green), `AdaptiveMenu` mounts no Radix root per row at rest (keep `RowMenu`'s lazy mount), `useIsMobile` reads don't re-render lists, no layout thrash in the composer; M6/M7 (one shared menu per list, `openAt` handle, no menu state in memoized rows, no media-query reads at rest). Fix in one commit.
- [ ] **Step 2: Verify** (take the lock): `pnpm typecheck && pnpm lint && pnpm test -- --maxWorkers=50% && pnpm build`.
- [ ] **Step 3:** `git push -u origin u4/3-mobile && gh pr create --base u4/2-agent-sheets --title "feat(web): mobile pass: drawer menus, long-press, touch targets, phone composer" --body-file <body>`: template sections; spec and #118; closes #107 and the #102 line; **narrowings**: emil M4 (long-press is an accelerator; the ⋯ stays, reason: text selection on prose, discoverability) and chat M5's ⋯ gutter; the sidebar's touch menu path is long-press only (Q23, for Or to revisit); **For Or**: Q13 (3), Q23 (3).
- [ ] **Step 4:** `gh pr checks --watch`; fix until green.

---

# PR 4 — `u4/4-template-editor`: CodeMirror template editor (dev B, droppable)

Setup (dev B, at once): `cd /Users/orlevi/projects/open-factory && git fetch && git worktree add .worktrees/u4-b -b u4/4-template-editor origin/u3/5-shared-composer && cd .worktrees/u4-b && pnpm install`. Rebase onto `u4/3-mobile` when it is pushed (see Delivery). Every commit in this PR is confined to the files below so the PR can be dropped as a unit.

### Task 38: Install the CodeMirror packages

Implements §12.1. A: 10.

**Files:** `apps/web/package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Record the policy, then pin the listed versions:** `pnpm --version`; `pnpm config get minimumReleaseAge` (`undefined` → pnpm 12.21.0's default of 1440 minutes). The listed versions: `@codemirror/state@6.7.6 @codemirror/view@6.43.15 @codemirror/language@6.13.1 @codemirror/commands@6.11.1 @codemirror/lang-yaml@6.1.3 @codemirror/lang-json@6.0.2 @codemirror/lang-markdown@6.5.2 @codemirror/lint@6.9.8 @lezer/highlight@1.2.5`; record each one's publish date (`npm view <pkg> time --json`). Pin the listed versions. If one is younger than the policy's 1440 minutes at install time, use the newest version that satisfies the policy, record it, and never bypass the policy.
- [ ] **Step 2:** `pnpm --filter @open-factory/web add --save-exact <the nine>`. If blocked by the policy: stop and report to `main`. Check every entry in `apps/web/package.json` has no caret.
- [ ] **Step 3:** Commit `chore(web): add the official CodeMirror 6 packages, exact-pinned`.

### Task 39: Syntax colour tokens

Implements §12.3 (tokens). Independent of Task 38.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/styles.css` (`--syntax-keyword`, `--syntax-string`, `--syntax-number`, `--syntax-comment`, `--syntax-property`, `--syntax-punctuation`, `--syntax-heading`, `--syntax-link` in `:root`, the dark theme block and both `prefers-contrast: more` blocks, as `oklch(...)`; values from Shiki's `github-light`/`github-dark` (`node_modules/shiki/dist/themes/github-light.mjs`) except any in hue 30–50°)
- Test: `apps/web/src/features/templates/syntax-tokens.test.ts`

- [ ] **Step 1: Failing test:** parse `styles.css`, collect every `--syntax-*` value per block, assert all eight exist in each block and that none's oklch hue is within 30–50 (the signal band).
- [ ] **Step 2–4:** FAIL → add tokens → PASS.
- [ ] **Step 5:** Commit `feat(web): syntax colour tokens, never orange`.

### Task 40: The `CodeEditor` wrapper

Implements §12.2, §12.3, §12.4. A: 10.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (M5) `onChange`, `onSave` and `onBlur` are read through a latest-ref (`useRef`, updated in `useLayoutEffect`), so extensions never capture a stale handler and the view is never recreated for a new callback; `mobile` and `language` live in `Compartment`s reconfigured on change; when `fileKey` changes, `view.setState(states.get(fileKey) ?? EditorState.create({ doc: value, extensions }))`. Test: replacing `onChange` after mount → the next edit calls the new handler.

**Files:**
- Create: `apps/web/src/features/templates/code-editor-setup.ts`, `apps/web/src/features/templates/code-editor.tsx`
- Test: `apps/web/src/features/templates/code-editor-setup.test.ts`, `apps/web/src/features/templates/code-editor.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  // code-editor-setup.ts
  export type Lang = "yaml" | "json" | "markdown";
  export type Diag = { line: number; column?: number; message: string; severity: "error" | "warning" };
  export function toDiagnostics(doc: Text, diags: readonly Diag[]): Diagnostic[]; // line/col → from/to; lines beyond the doc dropped
  export const external: AnnotationType<boolean>;
  export function extensionsFor(lang: Lang, o: { onSave(): void; onChange(doc: string): void; onBlur(): void; ids: { id: string; labelledBy: string; describedBy: string }; mobile: boolean }): Extension[];
  // code-editor.tsx (default export for React.lazy)
  export type CodeEditorHandle = { focusLine(line: number): void };
  export default forwardRef<CodeEditorHandle, { value: string; onChange(v: string): void; onBlur?(): void; onSave?(): void; id: string; labelledBy: string; describedBy?: string; language: Lang; fileKey: string; states: Map<string, EditorState>; diagnostics: readonly Diag[] }>(…);
  ```
- Rules: one `EditorView` per mount, created in a ref callback/`useLayoutEffect` once; `states.get(fileKey)` restores, `states.set(fileKey, view.state)` on every transaction; a `value` that differs from the doc and wasn't just emitted dispatches `{ changes: { from: 0, to: doc.length, insert: value }, annotations: [external.of(true), Transaction.addToHistory.of(false)] }`; the update listener ignores `external` transactions; markdown uses `new LanguageSupport(markdownLanguage)`; extensions: `lineNumbers()`, `history()`, `drawSelection()`, `bracketMatching()`, `indentOnInput()`, language, `syntaxHighlighting(HighlightStyle.define([...tags → var(--syntax-*)]))`, `keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab, { key: "Mod-s", run: () => { onSave(); return true } }])`, `EditorView.lineWrapping` (markdown only), `mobile ? lineNumberMarkers : lintGutter({ hoverTime: 400 })` where the mobile variant is a `gutterLineClass` extension marking lines with diagnostics, `EditorView.contentAttributes.of({ id, "aria-labelledby", "aria-describedby", "aria-multiline": "true" })`, `EditorView.theme({ "&": { backgroundColor: "var(--code-bg)" }, ".cm-content": { fontFamily: "var(--font-mono)", fontSize: "13px", lineHeight: "20px" }, ".cm-gutters": { color: "var(--muted-foreground)" }, … })` plus `@media (pointer: coarse)` 16px via a class on the wrapper; selection backgrounds `color-mix(in oklch, var(--signal) 26%, transparent)` incl. `.cm-focused`. `setDiagnostics(view.state, toDiagnostics(...))` on `diagnostics` change.

- [ ] **Step 1: Failing tests:** `toDiagnostics` maps line 3 col 5 to the right offsets, a missing column to the whole line, a line past the end is dropped; (jsdom, CodeMirror mounts there) typing via `view.dispatch` calls `onChange`; an external `value` replace doesn't call `onChange` and `undo(view)` doesn't revert it; unmount + remount with the same `fileKey` and `states` keeps the undo history (`undoDepth`); two fileKeys keep separate histories; the content element has `role="textbox"`, `aria-multiline`, the labelledby/describedby ids; `focusLine(4)` puts the selection at line 4's start; Mod-s calls `onSave`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): a small CodeMirror 6 wrapper for template files`.

### Task 41: Use it in the template editor

Implements §12.2 (integration, loading swap, writeSurface, loader preload), §12.5. A: 10.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**React review notes (apply in this task):**
- (m8) The state map is `useState(() => new Map<string, EditorState>())[0]`, not `useRef(new Map())` (no Map built per render); `writeSurface` is a `useCallback` when `MarkdownEditor` is memoized.

**Files:**
- Modify: `apps/web/src/features/templates/template-editor.tsx` (a `useState(() => new Map<string, EditorState>())[0]` keyed `${name}:${file}`, dropped on unmount; a reload or "Use theirs" deletes that key before setting the value; `CodeEditor` via `React.lazy` with the existing `CodeTextarea` as the `Suspense` fallback, padded left by the gutter width; on swap carry `selectionStart/End`, `scrollTop`, focus; `jumpTo` → `editorRef.current?.focusLine(line)` when the editor is mounted, else today's `serveJump`), `apps/web/src/components/markdown/markdown-editor.tsx` (optional `writeSurface?: (p: { value; onChange; id; describedBy }) => ReactNode`; when absent, today's textarea), `apps/web/src/routes/_app/templates.$name.tsx` (loader: `if (!preload) void import("@/features/templates/code-editor")`)
- Test: `apps/web/src/test/templates.test.tsx`

- [ ] **Step 1: Failing tests:** the template page renders the CodeMirror content for `template.yaml` after the lazy import resolves (await `findByRole("textbox", { name: "template.yaml" })`); switching to `mcp.json` and back keeps `template.yaml`'s undo depth; an issue's jump focuses its line; a reload of a file doesn't mark it dirty; AGENTS.md Write uses the editor and Preview still renders markdown; the task form's `MarkdownEditor` still renders a textarea.
- [ ] **Step 2–4:** FAIL → implement → PASS. Then `pnpm build` once and note the editor chunk from its output: its gzip size (≤135 kB) and that only the template route's chunk imports it (dynamically); both go in the PR body.
- [ ] **Step 5:** Commit `feat(web): template files edit in CodeMirror`.

### Task 42: Decision 23's real-browser checks, and the fallback gate (budget: 120 minutes including one fix round)

Implements §12.6, decision 23. A: 10.

**Files (outside the repo):** `/Users/orlevi/projects/open-factory/docs/product/ui-review/u4-evidence/pr4/{checks.py,shots,results,findings.md}`.

- [ ] **Step 1:** `run.sh checks.py` against `.worktrees/u4-b` (the lock serializes it with dev A's passes). Seed one template with a 200-line `template.yaml`. Each check runs twice: once on this branch's build and once on the textarea baseline, built from the base branch (`git worktree add .worktrees/u4-baseline <base>` from the repo root, per AGENTS.md → `pnpm install --frozen-lockfile && pnpm build`, served by a second server on another port; the baseline worktree (`git worktree remove --force .worktrees/u4-baseline`) and its server are removed by the same `trap`). No runtime switch between editors is added to the app.
  1. **Typing:** type the 200-line YAML at one key per frame (`page.keyboard.type(text, { delay: 16 })`) in Chromium and WebKit; record dropped characters (final doc vs input) and key-to-paint latency (`performance.now()` in a `keydown` listener → next `requestAnimationFrame` after the DOM mutation, p95). Pass: 0 dropped; p95 within 16.7ms of the textarea's.
  2. **IME:** Chromium CDP session: `Input.imeSetComposition({ text: "にほ", selectionStart: 2, selectionEnd: 2 })`, then `Input.insertText({ text: "日本" })`; press Enter during a composition; WebKit: dispatch `compositionstart/update/end` with `insertText`. Pass: "日本" lands once; Enter during composition inserts no newline and doesn't save (no PUT in the network log).
  3. **Undo:** type in `template.yaml`, switch to `mcp.json`, type, switch back, ⌘Z/Ctrl+Z repeatedly: only `template.yaml`'s edits revert; trigger a conflict "Use theirs" / reload: ⌘Z doesn't bring the old text back.
  4. **Screen-reader labelling:** `page.accessibility.snapshot()` / `locator.ariaSnapshot()`: the editable is `textbox`, multiline, named by the tab label, described by the hint and field descriptions — same as the textarea's.
  5. **Phone editing:** 390×844 `isMobile: true, hasTouch: true` in Chromium and WebKit: tap places the caret at the tapped line; `keyboard.type` works; a double-tap selects a word; `visualViewport.scale` stays 1 after focus (no zoom); `scrollWidth <= clientWidth`.
- [ ] **Step 2:** Write `findings.md` with a table: check × engine × CodeMirror vs textarea, pass/fail, numbers, screenshots.
- [ ] **Step 3: Gate.**
  - **All five pass (after at most one fix round):** continue with Task 43.
  - **Any check worse than the textarea:** fallback — `git revert` Tasks 41, 40 and 38's commits (keep Task 39's tokens only if anything else uses them; otherwise revert it too), so `CodeTextarea` stays everywhere and no `@codemirror/*` or `@lezer/*` package is in `apps/web/package.json`; run `pnpm install && pnpm typecheck && pnpm test -- --maxWorkers=50% && pnpm build`; the PR ships as `chore(web): keep the template textarea; CodeMirror checks failed` with the evidence table, or is closed if Or prefers (ask `main`). Send `main` a message for Or: which check failed, the numbers, the screenshots path. Do not ship a desktop-only editor (Q11).

### Task 43: PR4 DESIGN.md, review, verify and open

- [ ] **Step 1 (only if the gate passed):** apply spec §14's Template editor line to DESIGN.md. Commit `docs: DESIGN.md template editor`.
- [ ] **Step 2: Review** (fresh reviewer subagent): invoke `vercel-react-best-practices` and review `git diff <base>...HEAD -- apps/web`: the lazy boundary (bundle-dynamic-imports), the editor never re-created per keystroke, no effect syncing state that could be derived, stable callbacks into the editor (held in refs), the state map not a React state; M5 (latest-ref handlers, Compartments, `setState` on fileKey change). Fix in one commit.
- [ ] **Step 3: Verify** (take the lock): `pnpm typecheck && pnpm lint && pnpm test -- --maxWorkers=50% && pnpm build`; from the build output, record the editor chunk's gzip size and that the template route is its only importer.
- [ ] **Step 4:** Rebase onto `u4/3-mobile` if not done; `git push -u origin u4/4-template-editor && gh pr create --base u4/3-mobile --title "<per the gate>" --body-file <body>`: template sections; spec and #118; policy and the nine publish dates; the editor chunk's gzip size and its only importer (measured from the build output); a line stating that `@lezer/highlight` is the same project's official package (Lezer is CodeMirror's parser system, same author and repository family), needed for the highlight `tags`: a deliberate reading of decision 23's "official `@codemirror/*` packages only", not drift; the five-check table (Task 42); "droppable as a unit: nothing else depends on it".
- [ ] **Step 5:** `gh pr checks --watch`; fix until green.

---

# PR 5 — `u4/5-leftovers`: blockers in lists, name and email limits, scroll restoration (dev B, after PR3 is pushed)

`git checkout -b u4/5-leftovers` from `u4/4-template-editor` in `.worktrees/u4-b` after rebasing PR4 onto `u4/3-mobile`. Import nothing from PR4. Tasks 44 and 45 are independent.

### Task 44: Blockers in task lists

Implements §13.1. A: 11.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/tasks/status-label.tsx:62-71` (`BlockedMarker({ keys, max, className })`; with `max` and more keys: the first `max` + " +N more", the full list in `title`; the separator drawn by the marker: `before:content-['·'] before:mx-1.5`), `apps/web/src/features/tasks/task-list.tsx:58-67` (pass `max={3}`; drop the separate "·" before the marker)
- Test: `apps/web/src/features/tasks/task-list.test.tsx`

- [ ] **Step 1: Failing tests:** 25 keys → "Blocked by T-15, T-16, T-17 +22 more" with `title` holding all 25; 3 keys → all three, no "+0 more"; the list row has no standalone "·" sibling before the marker; the rail (no `max`) lists all.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `fix(web): task rows show three blockers and a count`.

### Task 45: Name and email length limits

Implements §13.2. A: 11.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it (sign-up form).

**Files:**
- Modify: `packages/shared/src/schemas.ts:4-9` (`name: z.string().trim().min(1, "Name is required").max(80, "Keep your name to 80 characters or fewer.")`, `email: z.email().max(254, "Keep your email to 254 characters or fewer.")`; export `USER_NAME_MAX = 80`, `EMAIL_MAX = 254`), `apps/server/src/auth/options.ts:70-73` (at the top of `hooks.before`, before the early returns: for `/sign-up/email` and `/update-user`, if the body's `name` is a string longer than 80 after trim → `throw new APIError("BAD_REQUEST", { code: "NAME_TOO_LONG", message: "Keep your name to 80 characters or fewer." })`; for `/sign-up/email`, `email` longer than 254 → `EMAIL_TOO_LONG`), `apps/web/src/components/auth-error.ts:17-50` (`NAME_TOO_LONG` → field `name`; `EMAIL_TOO_LONG` → field `email`)
- Test: `packages/shared/src/schemas.test.ts`, `apps/server/src/auth/options.test.ts` (or the existing auth route test file: `grep -ln "sign-up/email" apps/server/src --include=*.test.ts`), `apps/web/src/test/sign-up.test.tsx`

- [ ] **Step 1: Failing tests:** schema refuses 81 chars / 255-char email, accepts 80 / 254; server: `POST /api/auth/sign-up/email` with an 81-char name → 400 `NAME_TOO_LONG` (even when no `handle` is sent), 255-char email → `EMAIL_TOO_LONG`; `/update-user` with an 81-char name → 400; `/update-user` without `name` succeeds for a user whose stored name is 120 chars (insert it directly); sign-up form shows the message under Name / Email.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `fix: cap user names at 80 and emails at 254 characters on input`.

### Task 46: Scroll restoration on Back to `/agents` (timeboxed: 4 hours, defer path)

Implements §13.3. A: 11.

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/routes/_app/agents.index.tsx`, `apps/web/src/features/agents/agent-tree.tsx` (the usage cell renders at its final width while usage loads: a fixed `w-[…]` placeholder with the same line height), `apps/web/src/router.tsx` only if per-route options suffice (`scrollRestoration: true`, `getScrollRestorationKey` for `/agents`)

- [ ] **Step 1: Reproduce** with the worst-case seed (in the next evidence pass's environment or a dev server with the lock held): scroll 4,000px, open an agent, Back; record the landing offset vs the clicked row.
- [ ] **Step 2:** Fix inside the Agents page: stable row heights while usage loads; restore after the list query settles (TanStack Router scroll restoration keyed per route; if restoration runs before data, delay with the route's `pendingComponent`/loader awaiting the cached list, `ensureQueryData` when not preloading).
- [ ] **Step 3:** Re-measure: within one row. If the fix needs router-wide scroll changes (other routes' behaviour) or the timebox runs out: revert this task's changes, open a follow-up issue "U4 follow-up: scroll restoration on Back to /agents (break-ui M5)" with the measurements and the reason, and note it in the PR body.
- [ ] **Step 4:** Commit `fix(web): Back to Agents returns to the row you left` (or no commit when deferred).

### Task 47: PR5 evidence pass (budget: 45 minutes including one fix round)

- [ ] **Step 1:** `run.sh` against `u4/5-leftovers` with the worst-case seed: task rows with 25 blockers at 390/1440 (no orphan "·", no overflow); sign-up with 81-char name and 255-char email (inline errors); Back to `/agents` (Task 46). Light/dark, 200% text. `findings.md` in `…/u4-evidence/pr5/`.

### Task 48: PR5 review, verify and open

- [ ] **Step 1: Review** (fresh reviewer subagent): invoke `vercel-react-best-practices` and review `git diff u4/4-template-editor...HEAD -- apps/web` (confirm no import from PR4's modules: `grep -rn "code-editor"` in the diff finds nothing); re-check M1, M2, M5, M8 still hold after the rebase. Fix in one commit.
- [ ] **Step 2: Verify** (take the lock): `pnpm typecheck && pnpm lint && pnpm test -- --maxWorkers=50% && pnpm build`.
- [ ] **Step 3:** `git push -u origin u4/5-leftovers && gh pr create --base u4/4-template-editor --title "fix: break-ui leftovers: blockers in lists, name and email limits, scroll restoration" --body-file <body>`: template sections; spec and #118; "independent of #<PR4>; if PR4 is dropped, rebase onto u4/3-mobile"; M5 outcome or its follow-up issue.
- [ ] **Step 4:** `gh pr checks --watch`; fix until green.

### Task 49: Whole-U4 review

- [ ] **Step 1** (fresh reviewer subagent, on `u4/5-leftovers` with all five PRs stacked): invoke `vercel-react-best-practices` and review `git diff u3/5-shared-composer...u4/5-leftovers -- apps/web` against it as a whole (skip server-component rules): bundle (sheet bodies and the editor lazy; the shell chunk's size vs `u3/5-shared-composer`, from `pnpm build` output), re-render hot spots (the sheet store, `notify`, `--composer-h`, long-press handlers, `AdaptiveMenu`), data fetching (no waterfalls in sheet bodies, cache writes from child sheets), the review items M1, M2, M5, M6, M7, M8, and the spec coverage table below. Report findings to the PR owners; fixes land in the PR they belong to, one commit each.
- [ ] **Step 2:** Post the review summary as a comment on #118.

---

## Spec coverage

| Spec | Tasks |
|---|---|
| §5.1–5.2 store | 1 |
| §5.3 host, stacking, Esc, lazy, drag | 3, 4 |
| §5.4 redirects | 6, 10, 11, 18, 21, 23 |
| §5.5 drafts, Close, Discard, stale refs, merge | 2, 4, 7, 10, 19, 21 |
| §5.6 entry points | 7, 10, 11, 18, 21, 23, 24 |
| §6.1–6.4 agent sheets | 16, 19, 20, 21, 23 |
| §6.5 lifecycle, Restore | 24 |
| §7 stacked setup | 17, 18, 22 |
| §8 New task | 7 |
| §9 schedules | 8, 9, 10, 11 |
| §10 toasts | 5, 7, 10, 11, 21, 23, 24 |
| §11.1 AdaptiveMenu | 29, 30 |
| §11.2 long-press | 28, 31 |
| §11.3 hit areas | 32 |
| §11.4 phone composer | 33 |
| §11.5–11.6 headers, lists, dialogs | 34 |
| §12 template editor | 38–43 |
| §13 leftovers | 44, 45, 46 |
| §14 DESIGN.md | 13, 25, 35, 43 |
| §16 evidence | 14, 26, 36, 42, 47 |
| §17 delivery | Delivery table |
| §18 follow-ups | 12 (#83), 46 (M5 if deferred), 42 (fallback); #119–#122 already open |

| Acceptance | Tasks |
|---|---|
| A1 sheets everywhere | 6, 7, 10, 11, 18, 21, 23, 30 (grep) |
| A2 sheet belongs to its page | 1, 2, 4 |
| A3 first agent | 21, 22, 26 |
| A4 slug | 16, 20 |
| A5 toasts | 5, 7, 10, 11, 23, 24, 14 |
| A6 schedules | 8, 9 |
| A7 mobile menus, long-press | 28–31, 36 |
| A8 hit areas | 32, 36 |
| A9 no sideways page | 34, 14, 26, 36 |
| A10 editor | 38–42 |
| A11 leftovers | 44–46 |
| A12 restore | 24 |
