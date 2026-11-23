# I8 Quality of life Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four independent quality-of-life slices: first-run steps on a fresh factory's Inbox, desktop notifications only when a human is addressed or needed (never with message text), a loop guard that holds two agents ping-ponging with no human in between until a human resumes them, and cleanup of the worktrees and landed branches a terminated spawned agent leaves in project repos.

**Architecture:**
- **First run** is one derived endpoint (`GET /api/setup`) and one React block that renders in the Inbox's reading pane (≥1024px) or list (below), reusing the existing sheets.
- **Notifications** stay a client-side module (`features/inbox/notifications.ts`) driven by the inbox query; bursts are keyed by their first unread item and embedded in the tag, so replacement and closing need no timers or cross-tab state.
- **The loop guard** is one server module (`messaging/loop-guard.ts`) called inside every transaction that inserts an agent-to-agent row; counts and resets are derived from existing rows under sorted per-pair advisory locks; held rows get the state `loop_held`, one `loop_holds` row per open hold, one @factory notice, and a human-only Resume route.
- **The cleanup** is a hardened git runner (`spawning/git.ts`) plus a never-throwing `SpawnCleanup` (`spawning/cleanup.ts`) that `Workspace.deleteWorkspace` calls before removing a terminated spawned agent's workspace.

**Tech Stack:** TypeScript pnpm monorepo, Fastify, Postgres with Drizzle, Zod in `packages/shared`, React + Vite + TanStack Router/Query, Vitest, Biome, `node:child_process.execFile` for git. **No new dependency.**

**Spec:** `docs/superpowers/specs/2026-11-23-i8-quality-of-life-design.md` (commit 65a1d98). It is the authority for behaviour and copy. Decision log: #169. Follow-ups: #170–#176. Before each task, read the spec sections it cites; for anything I1, I3 or I7 defines, read their specs and plans in this folder (`2026-11-23-i1-…`, `i3-…`, `i7-…`).

## Global Constraints

- **Pre-release (ADR 0028).** No backward compatibility, no shims, aliases, fallbacks for old shapes or data migration. Schema changes ship as the generated Drizzle migration (`pnpm db:generate`) plus the two hand edits to hand-written SQL named in Task 3.1. The worktree convention changes with no note for the old layout. Any fallback or compatibility branch is a review defect.
- **Reset step**, stated in every PR body: PR 3 only — if the migration refuses a non-empty table, reset local data (drop the database, recreate agents). PRs 1, 2 and 4 have no migration.
- **Builds on unmerged work.** I1, I3 and I7 must be implemented on the branch below. Names this plan uses from them (from their plans):
  - I1: `Router.send(from, to: string[], body, urgent, opts)` with per-recipient results (`messaging/router.ts`); `chatRowSchema` and `inboxPageSchema.chats` (`packages/shared/src/messaging.ts`); `EventStore.inboxPage` returning `chats` (`agents/event-store.ts`); the `operator_input` event `{ type: "operator_input"; text; by; clientMessageId?; entryId }` (`packages/shared/src/events.ts`) written by `writeRaw` in `agents/agent-runtime.ts`; `rt.rawInput({ text, by, userId?, clientMessageId?, self? })`; `useInboxNotifier` reading `chats`; `/agents/$slug/chat?message=` and `/agents/$slug/session` routes; the composer's outgoing card `features/session/outgoing-message.tsx` reading `{results}`; I1's list-stability helper for Inbox rows (Task 3.13).
  - I3: inbox items with `kind: "credential"`, `credential: { name, expiresAt, current }`, `link: { kind: "credential", name }`; `createHumanMessage({ …, inboxKind, subjectCredentialId?, createdAt? })`; the `add-credential` sheet body in `features/sheets/sheet-bodies.ts`; `/settings/credentials?credential=<name>`.
  - I7: `agents.manageOrg` and `AgentSummary.manageOrg`; `patchAgentBodySchema.manageOrg`; `createAgentBodySchema` refusing `manageOrg` (Task A2), which Task 1.2 changes for humans; the "Can manage the org" `Switch` and its help in `features/agents/edit-agent-sheet.tsx` / `agent-form-state.ts`; `Actor` (`packages/shared/src/actor.ts`) and `OrgRefusedError`; the `org_action` WS frame.
  If a name differs in the implemented code, use the implemented name and note it in the PR body. Don't add an adapter.
- **Copy is verbatim from the spec** (§4.3, §5.1, §6.4, §6.5, §6.7, §6.8, §7.1, §7.6). Copy it, don't paraphrase. Counts use `Intl.PluralRules` / `Intl.NumberFormat` (a `plural(n, one, other)` helper is enough).
- **Notifications never carry message text** (Q8): titles are who, bodies are facts. No preview, no body excerpt, no tool output.
- **Git trust boundary (PR 4).** Agents can write granted repos, including `.git/config`, hooks and worktree metadata. Every git call goes through `spawning/git.ts` with the exact flags and env of Task 4.1; paths, ids and branch names from git or the repo are untrusted data used only to match.
- **No real Claude.** Tests and evidence use fake Claude (`packages/harness/testing/fake-claude.mjs` and the U4 harness's `fake.mjs`). Never read `~/.open-factory-spike` or the real `~/.claude`.
- **Database tests run only in CI.** Tests using `createTestDb` / `makeTestApp` (`apps/server/src/test/helpers.ts`) need Postgres, unavailable locally. Locally run pure unit tests, git tests (temp repos), web tests and `pnpm typecheck`; read CI for DB suites.
- **React.** Every task that touches `apps/web` says "Implementer and reviewer invoke `vercel-react-best-practices` and follow it." This is React + Vite + TanStack Router/Query: Next-only and server-component rules don't apply (say so). Each PR's final review checks the React diff against the skill.
- **I4 form rules.** `FieldShell` / `FieldNote`, `useFieldErrors`, `FormOutcome`, `field-stack`; client messages in `MSG` / `FIELD_MSG` / `FORM_MSG`, at most 40 characters.
- **DESIGN.md.** Type in rem; mono only for identifiers and code; status changes don't animate; toasts only when the outcome is off screen.
- **Heavy jobs.** At most one full suite, build or evidence pass at a time on this machine, under `/tmp/of-v002-heavy.lock`: `mkdir /tmp/of-v002-heavy.lock` and write an `owner` file (agent name and pid) inside; if it exists, do other work and retry later (never a sleep or wait loop on other agents' processes); `rm -rf /tmp/of-v002-heavy.lock` when done. The U4 harness has its own lock as well.
- **Supply chain.** Exact pins, the pnpm minimum release age and `--frozen-lockfile` stay; the lockfile doesn't change.
- **Git.** Merge, never rebase. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never merge a PR.

## Branches

All work happens in `/Users/orlevi/projects/open-factory/.worktrees/spec-i8`. The I7 chain head is `origin/i7/3-restart` if it exists, else `origin/i7/2-template-tools`, else `origin/i7/1-manage-org`, else `origin/spec/i7-agents-managing-agents`.

- **PR 1, `i8/1-first-run`:** from `spec/i8-quality-of-life` merged with the I7 chain head.
- **PR 2, `i8/2-notifications`:** from `spec/i8-quality-of-life` merged with the I7 chain head (independent of PR 1).
- **PR 3, `i8/3-loop-guard`:** from `i8/2-notifications`.
- **PR 4, `i8/4-spawn-cleanup`:** from `i8/3-loop-guard`.

```bash
cd /Users/orlevi/projects/open-factory/.worktrees/spec-i8
git fetch origin
HEAD7=$(for b in i7/3-restart i7/2-template-tools i7/1-manage-org spec/i7-agents-managing-agents; do git rev-parse -q --verify origin/$b >/dev/null && echo origin/$b && break; done)
git checkout spec/i8-quality-of-life && git merge --no-edit "$HEAD7"
git checkout -b i8/1-first-run          # later: git checkout spec/i8-quality-of-life && git checkout -b i8/2-notifications
```

Before each push, merge the base again (never rebase). Each PR is a **draft**; PR 1 and PR 2 target the I7 head branch, PR 3 targets `i8/2-notifications`, PR 4 targets `i8/3-loop-guard`; each body says it must be retargeted after its base merges.

**Commands:** one file `pnpm vitest run <path>`; `pnpm typecheck`, `pnpm lint`; heavy (lock): `pnpm test`, `pnpm build`; migrations `pnpm db:generate`.

## File map

| File | Purpose | PR |
|---|---|---|
| `packages/shared/src/setup.ts` (new) | `setupStatusSchema`, `SetupStatus` | 1 |
| `apps/server/src/routes/setup.ts` (new) + `app.ts` | `GET /api/setup` | 1 |
| `packages/shared/src/agents.ts` | `createAgentBodySchema.manageOrg?` | 1 |
| `apps/server/src/agents/agent-service.ts` | `create` accepts `manageOrg` from a human actor only | 1 |
| `apps/web/src/features/setup/` (new: `api.ts`, `setup-steps.tsx`) | the query, the block | 1 |
| `apps/web/src/features/sheets/sheet-store.ts`, `sheet-host.tsx` | top-level `add-credential` | 1 |
| `apps/web/src/routes/_app/inbox.tsx`, `features/inbox/inbox-list.tsx`, `inbox-pane.tsx` | where the block renders | 1, 3 |
| `apps/web/src/features/agents/new-agent-sheet.tsx`, `edit-agent-sheet.tsx`, `agent-form-state.ts` | the switch in New agent, the help lead | 1 |
| `apps/web/src/features/inbox/notifications.ts` (rewrite) + `notification-copy.ts` (new) | sources, bursts, tags, copy | 2 |
| `packages/shared/src/messaging.ts` | `chatRowSchema.firstUnreadId`; `inboxItemSchema.notice`, `.loopHold`; `held` statuses | 2, 3 |
| `apps/server/src/agents/event-store.ts` | `firstUnreadId`; `notice` in entries; `loop_held` in rejects; `loopHold` join | 2, 3 |
| `packages/db/src/schema/agents.ts`, `factory.ts`, migration | `loop_holds`, `messages.loop_hold_id`, settings columns | 3 |
| `apps/server/src/messaging/loop-guard.ts` (new) | `LoopGuard` | 3 |
| `apps/server/src/messaging/router.ts`, `tasks/task-service.ts`, `scheduling/schedule-store.ts`, `scheduling/scheduler.ts` | call sites | 3 |
| `apps/server/src/routes/loop-holds.ts` (new) | `POST /api/loop-holds/:id/resume` | 3 |
| `packages/shared/src/settings.ts`, `settings/factory-settings.ts`, `features/settings/factory-section.tsx` | the two settings | 3 |
| `apps/web/src/features/inbox/loop-hold-pane.tsx` (new), `inbox-row.tsx` | pane and row label | 3 |
| `apps/server/src/workspace/claude-md.ts` | held line (3); worktree line (4) | 3, 4 |
| `apps/server/src/spawning/git.ts` (new) | the hardened runner | 4 |
| `apps/server/src/spawning/cleanup.ts` (new) | `SpawnCleanup` | 4 |
| `apps/server/src/workspace/workspace.ts`, `spawning/reaper.ts`, `app.ts` | `beforeRemove` | 4 |
| `packages/shared/src/events.ts`, `features/session/rows.ts` | `workspace_cleanup` event and its line | 4 |
| `apps/web/src/features/inbox/cleanup-pane.tsx` (new) | the cleanup notice pane | 4 |

## Acceptance criteria map

| AC (spec §2) | Task(s) | Proof |
|---|---|---|
| 1 steps, sheets, checks, vanish | 1.1, 1.3, 1.4, 1.6 | `setup-steps.test.tsx`, `inbox-setup.test.tsx`, evidence `i8_c01` |
| 2 ever-had-agent, first paint | 1.1, 1.4 | `routes/setup.test.ts` (CI), `inbox-setup.test.tsx` (no empty line first) |
| 3 step targets and done rules | 1.1, 1.3 | same |
| 4 switch in New/Edit with help | 1.2, 1.5 | `agents.test.ts` (CI), `new-agent-sheet.test.tsx` |
| 5 chat burst, silent replace, click | 2.2, 2.3 | `notifications.test.tsx`, evidence `i8_c10` |
| 6 never text; never task/other facts | 2.2 | `notification-copy.test.ts`, `notifications.test.tsx` |
| 7 mention/error/credential, marks read | 2.2, 2.3 | `notifications.test.tsx` |
| 8 trip, held result, notices, notification | 3.2–3.6, 3.9 | `loop-guard.test.ts`, `router.test.ts` (CI), evidence script |
| 9 Resume, inline result, row label | 3.7, 3.9 | `loop-holds.test.ts` (CI), `loop-hold-pane.test.tsx`, evidence |
| 10 390px full width | 3.10 | `inbox-route.test.tsx`, evidence `i8_c21` at 390 |
| 11 resets, comments count | 3.2, 3.4 | `loop-guard.test.ts` (CI) |
| 12 settings | 3.8 | `settings.test.ts`, `settings-factory.test.tsx` |
| 13 CLAUDE.md worktree line | 4.4 | `claude-md.test.ts` snapshot |
| 14 cleanup, branches, notice | 4.2, 4.3, 4.5 | `cleanup.test.ts` (real git), `reaper.test.ts` |
| 15 hardening | 4.1, 4.2 | `git.test.ts`, `cleanup.hardening.test.ts` (real git) |

---

# PR 1: `i8/1-first-run`

Implements spec §4, AC 1–4.

### Task 1.1: `GET /api/setup`

**Files:**
- Create: `packages/shared/src/setup.ts`, `apps/server/src/routes/setup.ts`
- Modify: `packages/shared/src/index.ts` (export), `apps/server/src/app.ts` (register the route next to `inbox`)
- Test: `apps/server/src/routes/setup.test.ts` (DB, CI)

**Interfaces:**
- Produces: `setupStatusSchema = z.object({ hasCredential: z.boolean(), hasTemplate: z.boolean(), hasAgent: z.boolean() })`, `type SetupStatus`; route `GET /api/setup` (human session, same `requireUser` hook as `routes/inbox.ts`) → `SetupStatus`.

- [ ] **Step 1: Failing tests** (`makeTestApp`): empty factory → all false; after inserting a credential row → `hasCredential`; a `templates` row with `issues` non-empty → `hasTemplate` true (valid or not, Q12); one agent row with `archivedAt` set → `hasAgent` true; a terminated ephemeral row only → `hasAgent` true; no session → 401.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/routes/setup.test.ts` — expect FAIL (route missing). (Locally the DB suite is skipped; it fails in CI until Step 3.)
- [ ] **Step 3: Implement** one query:

```ts
const [r] = await db.execute<{ c: boolean; t: boolean; a: boolean }>(sql`
  select exists(select 1 from credentials) as c,
         exists(select 1 from templates)   as t,
         exists(select 1 from agents)      as a`);
return { hasCredential: r.c, hasTemplate: r.t, hasAgent: r.a };
```

- [ ] **Step 4: Typecheck** (`pnpm typecheck`), push to read CI later in Task 1.7.
- [ ] **Step 5: Commit** `feat(server): GET /api/setup derives the first-run state`.

### Task 1.2: Humans can grant `manage_org` at creation

**Files:**
- Modify: `packages/shared/src/agents.ts` (`createAgentBodySchema` gains `manageOrg: z.boolean().optional()`), `apps/server/src/agents/agent-service.ts` (`create`), `apps/server/src/routes/agents.ts` (pass it), I7's `create_agent` tool in `apps/server/src/mcp/tools/` (unchanged schema: it must not expose `manageOrg`)
- Test: `packages/shared/src/agents.test.ts`, `apps/server/src/routes/agents.test.ts` (DB, CI), the I7 org-tools test

**Interfaces:**
- Consumes: I7 `Actor`, `OrgRefusedError`, `agents.manageOrg`, the CHECK `agents_manage_org_persistent`.
- Produces: `AgentService.create(body: CreateAgentBody & { manageOrg?: boolean }, actor: Actor)`.

- [ ] **Step 1: Failing tests:** `createAgentBodySchema.parse({...valid, manageOrg: true}).manageOrg === true` (replaces I7's "refuses manageOrg" assertion; delete that one, no compat); `POST /api/agents` with `manageOrg: true` from a human creates the agent with `manageOrg` true and the restart/peer events as for any create; `AgentService.create({...,manageOrg:true}, agentActor)` → `OrgRefusedError("Only a human can grant manage_org.")` (I7's sentence verbatim); the `create_agent` MCP tool's input schema has no `manageOrg` key.
- [ ] **Step 2: Run** the shared test locally — FAIL.
- [ ] **Step 3: Implement.** In `create`, `if (body.manageOrg && actor.kind !== "human") throw new OrgRefusedError("Only a human can grant manage_org.")`; insert `manageOrg: body.manageOrg ?? false`.
- [ ] **Step 4: Run** shared test PASS; typecheck.
- [ ] **Step 5: Commit** `feat(server): humans can grant manage_org when creating an agent`.

### Task 1.3: Top-level Add credential sheet and the setup query

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/sheets/sheet-store.ts` (top-level union gains `{ kind: "add-credential" }`), `apps/web/src/features/sheets/sheet-host.tsx` / `sheet-bodies.ts` (route the top-level kind to the **same** body; on success a top-level sheet closes, a child returns to its parent, as the store already distinguishes; also invalidate `["setup"]`)
- Create: `apps/web/src/features/setup/api.ts`
- Modify: the success handlers of New template (`features/templates/…` create mutation) and New agent (`features/agents/new-agent-sheet.tsx`) to invalidate `["setup"]`; the global WS `onMessage` in `routes/_app.tsx` invalidates `["setup"]` on `org_action`
- Test: `apps/web/src/features/sheets/sheet-store.test.ts`, `apps/web/src/features/setup/api.test.ts`

**Interfaces:**
- Produces: `setupQueryOptions = queryOptions({ queryKey: ["setup"], queryFn: () => api.get("/api/setup", setupStatusSchema), staleTime: (q) => (q.state.data?.hasAgent ? Infinity : 30_000), refetchOnWindowFocus: true })` (once an agent exists the answer never changes back, Q11); `useSetup()`. New agent's success also calls `qc.setQueryData(["setup"], (d) => d && { ...d, hasAgent: true })` so the block leaves without a round trip.

- [ ] **Step 1: Failing tests:** `openSheet({kind:"add-credential"})` at top level renders the add-credential body (the same component instance type as the child); submitting it closes the sheet and focus returns to the opener; a child add-credential still returns to its parent (existing test stays green); creating a credential, a template or an agent invalidates `["setup"]`; an `org_action` frame invalidates it.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/sheets/sheet-store.test.ts` — FAIL.
- [ ] **Step 3: Implement** (no new body component; one `kind` branch in the host's switch). The Add credential body branches on `getSheetState().parent?.id === sheetId`: as a child it returns its result to the parent as today; top-level it writes the credentials list into the cache, invalidates `["setup"]` and calls `close()`.
- [ ] **Step 4: Run** PASS.
- [ ] **Step 5: Commit** `feat(web): Add credential opens as a top-level sheet; the setup query`.

### Task 1.4: The setup steps block and where it renders

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/setup/setup-steps.tsx`
- Modify: `apps/web/src/routes/_app/inbox.tsx` (loader fetches both in parallel: `await Promise.all([context.queryClient.ensureInfiniteQueryData(inboxQueryOptions).catch(noop), context.queryClient.ensureQueryData(setupQueryOptions).catch(noop)])`), `apps/web/src/features/inbox/inbox-list.tsx` (L121: the empty line is held while setup is pending; below 1024 the block renders at the top of the list and the empty line is omitted while `hasAgent` is false), `apps/web/src/features/inbox/inbox-pane.tsx` (L473: with nothing selected and `hasAgent` false, the pane renders `<SetupSteps/>` max-w-[40rem] instead of "No item selected.")
- Test: `apps/web/src/features/setup/setup-steps.test.tsx`, `apps/web/src/test/inbox-setup.test.tsx`, update `apps/web/src/test/inbox-pane.test.tsx`

**Interfaces:**
- Consumes: `useSetup()`, `openSheet` from the sheet store.
- Produces: `<SetupSteps status={SetupStatus} />`; `useSetupVisible(hasAgent: boolean | undefined): { shown: boolean; listProps: { onPointerEnter; onPointerLeave; onFocusCapture; onBlurCapture }; blockProps: { onFocusCapture; onBlurCapture } }` (`features/setup/use-setup-visible.ts`), called **once** in `InboxPage` and passed to `InboxList` and `InboxPane`.

`useSetupVisible` (spec §4.2, React review M2, option A): pointer-in-list and focus-in-list are **refs**; the only state is `held: boolean`. `shown` is adjusted **during render** (the `useRested` pattern): when `hasAgent` becomes true and neither the pointer is over the list column nor focus is inside the list column, `shown` turns false in the same render; otherwise `held` is set and the pointer-leave / blur handlers clear it. Focus inside the block itself does **not** hold it. A `focusInside` ref is set by the block's focus handlers; a `useLayoutEffect` keyed on `shown` moves focus to the first Inbox row, or to the page `h1` when the Inbox is empty, when `shown` went false with `focusInside` set. No effect mirrors the query into state.

Spec §4.2–4.3 copy and layout verbatim:
- `<section aria-labelledby="setup-h">`, `<h2 id="setup-h">` "Set up your factory" in the State heading role (Archivo `text-[1rem] leading-[1.25rem] font-semibold`).
- `<ol>` of three `<li><button>` rows, `min-h-14`, marker `size-5` ring with the number in Geist `text-[0.8125rem] tabular-nums text-muted-foreground`, or `<Check aria-hidden>` in the success token when done; title `text-[0.875rem] font-medium`; description `text-[0.8125rem] text-muted-foreground` wrapping (no `truncate`); trailing `ChevronRight` muted. Hover/press/inset focus classes copied from DESIGN Rows (no scale). Accessible name "Step 1 of 3, Sign in to Claude, done|not done"; description via `aria-describedby`.
- Steps: 1 "Sign in to Claude" / "Connect the Claude account your agents run on." → `openSheet({kind:"add-credential"})`, done = `hasCredential`; 2 "Create a template" / "A template is a role: persona, skills, tools and model." → `openSheet({kind:"new-template", then:"open-editor"})`, done = `hasTemplate`; 3 "Create an agent" / "It runs a template in its own session. Give it \"Can manage the org\" to have it build the rest." → `openSheet({kind:"new-agent"})`, never done.

- [ ] **Step 1: Failing tests:**
  - block: three rows in order with exact copy; done rows show the check and stay enabled; each click opens its sheet kind; accessible names; no `truncate` class on descriptions.
  - inbox (wide, `matchMedia` mocked ≥1024): with `hasAgent` false and nothing selected the pane shows the block and the list shows "Nothing in your inbox."; selecting an item shows the item; clearing returns the block.
  - inbox (narrow): the block is at the top of the list; with no items there is no "Nothing in your inbox."; with an item it follows below.
  - first paint: render with the inbox query resolved and setup pending → neither the empty line nor the block; then setup resolves → block (assert "Nothing in your inbox." never appeared: spy on the text across renders).
  - leaving, through the real paths (an `org_action` frame invalidating `["setup"]`, and a window-focus refetch, with the API mock flipping `hasAgent`): the block unmounts in that render when the pointer is outside the list column; with the pointer over the list column (or focus inside the list column) it stays until pointer leave / blur; focus on a step row does **not** hold it, and when it unmounts with focus inside, focus lands on the first inbox row (or the `h1` when empty) in a layout effect (no frame with focus on `body`).
  - no horizontal overflow class combos (`min-w-0` on text column).
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/setup apps/web/src/test/inbox-setup.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** `InboxPage` calls `useSetup()` and `useSetupVisible(data?.hasAgent)` once and passes `status` and `shown` down; the block reads them via props (no context, no second subscription).
- [ ] **Step 4: Run** PASS; `inbox-pane.test.tsx` "No item selected." tests updated to set `hasAgent: true` in their setup mock.
- [ ] **Step 5: Commit** `feat(web): first-run steps on the Inbox`.

### Task 1.5: "Can manage the org" in New agent, and its help lead

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/agents/new-agent-sheet.tsx` (the I7 `Switch` field after Projects, persistent only; sends `manageOrg`), `apps/web/src/features/agents/edit-agent-sheet.tsx` and the shared help constant (I7's help line gains the lead sentence), `agent-form-state.ts` if New agent shares it
- Test: `apps/web/src/features/agents/new-agent-sheet.test.tsx`, `edit-agent-sheet.test.tsx`

- [ ] **Step 1: Failing tests:** New agent shows "Can manage the org", off by default; its help starts with "Lets this agent create and arrange other agents: ask it in Chat to build the rest of your team." followed by I7's text verbatim; submitting with it on sends `manageOrg: true`; Edit agent's help shows the same lead. One constant holds the help so the two never diverge.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** PASS.
- [ ] **Step 5: Commit** `feat(web): Can manage the org at creation, with what to do with it`.

### Task 1.6: DESIGN.md, product docs, evidence

- [ ] **Step 1: DESIGN.md** Empty states amendment, spec §4.6, verbatim. Commit `docs(design): first-run steps are the empty Inbox's exception`.
- [ ] **Step 2: Product docs** (main checkout `/Users/orlevi/projects/open-factory/docs/product/`, gitignored): `behavior/inbox.md` (first-run steps: when, where, the three steps), `behavior/administration.md` (setup starts on the Inbox; Can manage the org at creation). List them in the PR body.
- [ ] **Step 3: Evidence** (fake Claude only, under the heavy lock and the harness lock). Write `docs/product/ui-review/i8-evidence/checks/i8_c01_first_run.py` (main checkout) on the U4 harness with `U4_SEED=empty`: the steps at 1440 (in the pane) and 390 (in the list), light and dark, 1440 at 200% text, 320; no page overflow (`u4lib.page_overflow`); open each sheet; create a credential (fake), a template and an agent; the checks turn on and the block leaves. `REPO=<snapshot> PR=i8-pr1 ./run.sh …`. Results JSON and shots under `i8-evidence/pr1/`.

### Task 1.7: PR 1 review, verification, push, draft PR, CI

- [ ] **Step 1: Whole-PR review.** A fresh read-only reviewer on `git diff spec/i8-quality-of-life...i8/1-first-run` checks spec §4 and AC 1–4, copy verbatim, ADR 0028 (I7's "refuses manageOrg" test replaced, not kept), and **the React diff against `vercel-react-best-practices`** (the reviewer invokes the skill first; Next-only rules skipped and said so): no effect that mirrors query data into state, no component defined inside a component, stable query keys, the `/inbox` loader fetches inbox and setup in parallel (`Promise.all`), `useSetupVisible` keeps pointer/focus in refs and adjusts `shown` during render, focus moves done in a layout effect keyed on `shown`. Fix findings as their own commits.
- [ ] **Step 2: Full verification** under `/tmp/of-v002-heavy.lock`: `pnpm install --frozen-lockfile` (no lockfile change), `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`; the dev loop from a clean clone (clone to a temp dir, install, build, `pnpm dev` with a throwaway DB and fake Claude, load the Inbox, shut down, delete the clone). Release the lock.
- [ ] **Step 3: Push and draft PR.** Merge the base again, push `i8/1-first-run`, `gh pr create --draft --base <I7 head branch>`, title `feat(web): first-run steps on the Inbox`, body per `.github/pull_request_template.md` (What, Why, Approach bullets "<decision>, rather than <alternative>, because <reason>", Changes), links to the spec, this plan and #169, "Closes #102" only if every #102 bullet it covers is the first-run one (else "Part of #102"), docs updated, DB tests in CI, retarget after the base merges; template comments removed; ends with the attribution line. `gh pr checks --watch` until green, fixing on the branch. Never merge.

---

# PR 2: `i8/2-notifications`

Implements spec §5, AC 5–7. Cut from `spec/i8-quality-of-life` merged with the I7 head (not from PR 1).

### Task 2.1: `firstUnreadId` on chat rows; `notice` on @factory items; chats come from agent messages only

**Files:**
- Modify: `packages/shared/src/messaging.ts` (`chatRowSchema.firstUnreadId: z.string()`; `inboxItemSchema.notice: z.string().optional()`), `apps/server/src/agents/event-store.ts` (`inboxPage`: per chat `min(message id by created_at)` of unread items; the `notify=true` filter (routes/inbox.ts query schema gains `notify: z.coerce.boolean().optional()`); `toEntries`: `notice` for `kind = 'system'` rows; the `chats` grouping selects only rows with `from_agent_id` set and `kind = 'message'`, so `system` rows stay in `items`)
- Test: `apps/server/src/routes/inbox.test.ts` (DB, CI)

- [ ] **Step 1: Failing tests:** `GET /api/inbox?unread=true&notify=true` returns all chats and every unread `mention`, `agent_errored`, `credential` and `loop_held` item (and nothing else) newest first, capped at 200; three unread messages from @ada → `chats[0].firstUnreadId` is the oldest; read the first → it becomes the second; an `agent_errored` notice appears in `items` with `notice: "agent_errored"` and never in `chats`; I3's credential item still in `items`.
- [ ] **Step 2–4:** run (CI), implement, typecheck.
- [ ] **Step 5: Commit** `feat(server): chat rows carry their first unread message; @factory items carry their notice`.

### Task 2.2: Notification sources, copy and bursts (pure)

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/inbox/notification-copy.ts`
- Test: `apps/web/src/features/inbox/notification-copy.test.ts`

**Interfaces:**
- Produces:

```ts
export type Burst = {
  key: string;            // "chat:ada" | "task:T-42" | "error:dev" | "credential:work" | "loop:<holdId>"
  tag: string;            // `${key}:${firstUnreadId}`; for loop: the key itself
  title: string;          // who, ≤ 40 chars
  body: string;           // the fact, never message text
  newestId: string;       // chats: latest.messageId; items: newest item id
  itemIds: string[];      // inbox items to mark read on click (empty for chats)
  open: { to: string; search?: Record<string, string | number> };
  resolved?: boolean;     // a resumed hold
};
export function burstsOf(page: { chats: ChatRow[]; items: InboxItem[] }): Burst[];
export function capTitle(s: string, kind: "handle" | "name"): string; // handles middle-ellipsis, names end-ellipsis, 40 chars
```

Rules (spec §5.1): chat → title display name (as the chat row shows it), body `plural(unread, "1 new message", "N new messages")`, open `/agents/$slug/chat?message=firstUnreadId`; `mention` items grouped by `task.key` → title first mentioner's `@handle`, or the task key when several handles, body "Mentioned you on T-42" / "N mentions on T-42", open `/tasks/$key?comment=<first unread commentId>`; items with `notice === "agent_errored"` grouped by `about` → title `@dev`, body "Hit an error", open `/agents/$slug/session`; `kind === "credential"` → title `Credential "work"`, body "Expires Dec 3" / "Expired Dec 3" from `expiresAt` (`Intl.DateTimeFormat(undefined, {month:"short", day:"numeric"})`, past → "Expired"), open `/settings/credentials?credential=work`; `notice === "loop_held"` (PR 3 fills `loopHold`; until then this branch is unit-tested with a fixture) → title `@a and @b`, body "Messages between them are held", open `/inbox?item=<id>`, `resolved` when `loopHold.resumedAt`. Everything else (task_event, other notices, `worktrees_kept`) yields no burst. Unread only.

- [ ] **Step 1: Failing tests:** each source's title, body and open target; a 60-char handle is middle-truncated to 40 and a display name end-truncated; plurals at 1 and 2; **no test fixture's message preview or body text appears in any title or body** (assert with fixtures whose preview is a unique marker string); `task_event`, `factory_restarted`, `crash_recovered`, `worktrees_kept` produce nothing; tags change after the first unread changes.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/inbox/notification-copy.test.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** PASS.
- [ ] **Step 5: Commit** `feat(web): notification copy and bursts without message text`.

### Task 2.3: The notifier: show, replace, close, click

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify (rewrite the notify half): `apps/web/src/features/inbox/notifications.ts` (keep `useBrowserNotifications`, `BLOCKED_NOTE`; replace `notificationTitle` and `notifyNewItems`; `useInboxNotifier` uses `burstsOf`)
- Modify: `apps/web/src/components/app-sidebar.tsx` (the switch hides when `supported` is false, which now includes a throwing constructor)
- Test: `apps/web/src/features/inbox/notifications.test.tsx`

**Interfaces:**
- Produces: `class Notifier { constructor(onOpen: (b: Burst) => void); baseline(bs: Burst[]): void; update(bs: Burst[], visible: boolean): void; closeAll(): void; reset(): void }` (holds `seen: Set<string>` of newest ids and `shown: Map<key, { tag; n: Notification }>`).
- Lifecycle (React review M3, option A): one instance per `AppLayout` (`routes/_app.tsx`): `const [notifier] = useState(() => new Notifier((b) => onOpenRef.current(b)))`, with `onOpenRef.current` updated in an effect (not during render). `reset()` closes every shown notification and clears `seen`/`shown`; it is called on sign-out next to `resetSheets()`. Delete the render-time `notifyRef.current = notify` write in `_app.tsx`; the WS handler calls `notifier`-driving `useInboxNotifier`'s stable callback. Tests create a fresh instance each.
- Data (React review M4): the notifier reads `GET /api/inbox?unread=true&notify=true`, which returns every chat plus every unread `mention`, `agent_errored`, `credential` and `loop_held` item (newest first, capped at 200), so a key never looks read because its items fell off the first page. The callback: cheap `isOn()` guard before fetching; read `document.visibilityState` **after** the await; only the latest fetch is applied (a sequence number), and a frame arriving mid-fetch schedules exactly one trailing fetch.

`update` per spec §5.2:
1. For each shown key not in `bs`, or `resolved`: `n.close()`, delete.
2. For each burst: if its `newestId` is in `seen` → if a shown entry's tag differs from `b.tag`, close it and delete (partial read elsewhere; nothing re-shows); continue.
3. Else add to `seen`; if `visible` is false and the switch is on: if shown with a different tag, close it; `const n = new Notification(b.title, { body: b.body, tag: b.tag, icon: "/favicon.svg" })` inside `try` (a throw marks notifications unsupported via the store and stops); `n.onclick = () => { window.focus(); n.close(); onOpen(b) }`; `n.onclose = () => shown.get(b.key)?.n === n && shown.delete(b.key)`; store.
`onOpen`: `navigate(b.open)`; when `b.itemIds.length`, mark them read through `useInboxCache().setRead` + `postRead` exactly as `useOpenItem` does (D8).

- [ ] **Step 1: Failing tests** (fake `Notification` class recording constructions and `close` calls; `document.visibilityState` stubbed):
  - visible → nothing shown; hidden → one shown with title/body/tag, and `options.body` never equals any preview;
  - a second chat message while unread → a construction with the **same tag** (silent replacement), body "2 new messages";
  - the chat read (burst gone) → `close()` called; the next message → a new tag;
  - partial read elsewhere (first unread changed, no new item) → old one closed, nothing new;
  - 6 unread mention items across 2 tasks spread over more than one inbox page → neither notification closes (the `notify=true` response holds them all);
  - turning the switch off closes this tab's shown notifications (spec §5.2, m7); `reset()` on sign-out closes and clears;
  - two frames during one fetch → one trailing fetch, and a stale response arriving after a newer one is ignored;
  - task_event and other facts → nothing;
  - baseline: unread at load never notifies;
  - a constructor that throws → `supported` false, no unhandled rejection;
  - click: `window.focus` called, navigates to each source's target, mention/error/credential items marked read (`postRead` called), chats not marked by the click.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** PASS.
- [ ] **Step 5: Commit** `feat(web): one notification per burst, replaced silently, closed when read`.

### Task 2.4: Product docs, evidence, review, PR 2

- [ ] **Step 1: Product docs** (main checkout): `behavior/inbox.md` — which items notify, no text (replace "a 120-character preview"), bursts, the click marks items read (keep that sentence). List in the PR body.
- [ ] **Step 2: Evidence** (heavy + harness locks, fake Claude): `i8-evidence/checks/i8_c10_notifications.py` — grant notification permission in the Playwright context, stub `Notification` to record (headless can't show OS notifications) while the page is hidden (`page.evaluate` overriding `visibilityState` + dispatching `visibilitychange`), have the fake agent reply three times via `ctl.py`, assert one tag and the final body "3 new messages", invoke the recorded `onclick` and assert the URL is the Chat at the first unread message. Chromium only (WebKit lacks the permission API in headless).
- [ ] **Step 3: Whole-PR review** as in Task 1.7 Step 1, against spec §5 and AC 5–7, plus: no message text reaches `Notification` (grep the diff for `preview` in notification code), I1/I3 notifier lines superseded, **the React diff against `vercel-react-best-practices`** (module-level notifier, no state set in the WS handler, effects only for external sync with cleanup).
- [ ] **Step 4: Full verification** as in Task 1.7 Step 2.
- [ ] **Step 5: Push and draft PR** (base: the I7 head branch), title `feat(web): desktop notifications only when you're needed, without message text`; body as in Task 1.7 Step 3. CI until green. Never merge.

---

# PR 3: `i8/3-loop-guard`

Implements spec §6, AC 8–12. `git checkout -b i8/3-loop-guard i8/2-notifications`.

### Task 3.1: Schema: `loop_held`, `loop_hold_id`, `loop_holds`, settings, index

**Files:**
- Modify: `packages/db/src/schema/agents.ts` (`messages.loopHoldId: text("loop_hold_id").references(() => loopHolds.id)`; new `loopHolds` table; partial index `session_events_operator_input_idx` on `(agent_id, at) where type = 'operator_input'`), `packages/db/src/schema/factory.ts` (`loopGuardMessages integer not null default 10`, `loopGuardWindowMinutes integer not null default 10`)
- Create: the migration via `pnpm db:generate`, then hand edits in the same file:

```sql
ALTER TABLE "messages" DROP CONSTRAINT "messages_state_check";
ALTER TABLE "messages" ADD CONSTRAINT "messages_state_check"
  CHECK (state IN ('pending','delivered','rejected','cancelled','loop_held'));
DROP INDEX "messages_schedule_pending_idx";
CREATE UNIQUE INDEX "messages_schedule_pending_idx" ON "messages" (schedule_id, to_agent_id)
  WHERE state IN ('pending','loop_held');   -- copy the column list from migration 0009 exactly
```

- Test: `packages/db/src/schema.messages.test.ts` (CI)

```ts
export const loopHolds = pgTable("loop_holds", {
  id: text("id").primaryKey(),
  agentA: text("agent_a").notNull().references(() => agents.id),
  agentB: text("agent_b").notNull().references(() => agents.id),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  resumedAt: timestamp("resumed_at", { withTimezone: true }),
  resumedBy: text("resumed_by").references(() => users.id),
}, (t) => [
  check("loop_holds_order", sql`${t.agentA} < ${t.agentB}`),
  uniqueIndex("loop_holds_open_unique").on(t.agentA, t.agentB).where(sql`${t.resumedAt} is null`),
]);
```

- [ ] **Step 1: Failing tests:** a `loop_held` message row inserts; a second open hold for the same pair violates the unique index; `agent_a > agent_b` violates the check; two rows of one schedule, one `pending` and one `loop_held`, violate the widened index.
- [ ] **Step 2:** Generate, hand-edit (check migration 0009 for the exact index columns), run the migrate test in CI.
- [ ] **Step 3: Commit** `feat(db): loop_held messages and loop_holds`.

### Task 3.2: `LoopGuard`

**Files:**
- Create: `apps/server/src/messaging/loop-guard.ts`
- Test: `apps/server/src/messaging/loop-guard.test.ts` (DB, CI) and `loop-guard.unit.test.ts` (pure helpers)

**Interfaces:**
- Consumes: `FactorySettings.loopGuardMessages()`, `.loopGuardWindowMs()` (Task 3.8 adds them; add the getters here first, defaulting from the row), `EventStore.clock()`.
- Produces:

```ts
export type PairKey = { a: string; b: string };              // a < b
export const pairOf = (x: string, y: string): PairKey => (x < y ? { a: x, b: y } : { a: y, b: x });
export type GuardResult =
  | { held: false }
  | { held: true; holdId: string; opened: false }
  | { held: true; holdId: string; opened: true; counts: { ab: number; ba: number; minutes: number } };
export class LoopGuard {
  constructor(d: { settings: FactorySettings; clock: () => Date; newId: () => string });
  lockPairs(tx: Tx, pairs: PairKey[]): Promise<void>;
  check(tx: Tx, from: string, to: string): Promise<GuardResult>;
}
```

`lockPairs`: compute keys in SQL to lock what Postgres hashes, sorted numerically:

```sql
select pg_advisory_xact_lock(k) from (
  select distinct hashtextextended('loop:' || a || ':' || b, 0) as k
  from unnest($1::text[], $2::text[]) as p(a, b)
) s order by k;
```

`check` (spec §6.1, §6.3), under the caller's locks:
1. `select id from loop_holds where agent_a = $a and agent_b = $b and resumed_at is null` → held, `opened: false`.
2. Window start, one statement:

```sql
select greatest(
  $now::timestamptz - make_interval(mins => $window),
  (select max(resumed_at) from loop_holds where agent_a = $a and agent_b = $b),
  (select max(created_at) from messages
     where kind = 'message' and from_user_id is not null and to_agent_id in ($a, $b)),
  (select max(at) from session_events
     where type = 'operator_input' and agent_id in ($a, $b) and payload->>'fromKind' = 'human'),
  (select max(e.at) from task_events e join tasks t on t.id = e.task_id
     where e.type = 'status' and e.actor_user_id is not null and t.assignee_agent_id in ($a, $b))
) as since;
```

3. Counts since `since`, sender = `coalesce(from_agent_id, author_agent_id)`, kinds `message`, `task_comment`, `scheduled` (scheduled only with `author_agent_id` set), any state except `cancelled`:

```sql
select coalesce(m.from_agent_id, m.author_agent_id) as s, count(*)::int as n, min(m.created_at) as first
from messages m
where m.created_at > $since and m.kind in ('message','task_comment','scheduled')
  and m.state <> 'cancelled'
  and ((coalesce(m.from_agent_id, m.author_agent_id) = $a and m.to_agent_id = $b)
    or (coalesce(m.from_agent_id, m.author_agent_id) = $b and m.to_agent_id = $a))
group by 1;
```

Add 1 for the new row in its direction. If both `> N`: insert the hold (`opened_at = clock()`), return `opened: true` with `ab`, `ba` (oriented from the sender's view: `ab` = from→to), `minutes = max(1, ceil((now - first) / 60000))`.

- [ ] **Step 1: Failing tests** (CI; helpers insert two agents and rows with explicit `created_at`): N = 3 for speed via settings —
  - 3 each way → not held; the 4th from A after B already has 4 → held, opened, counts `{ab:4, ba:4}`;
  - 50 one way, 0 back → never held;
  - each reset source (human message to B, human `operator_input` on A, human status event on a task assigned to B) between the rows → not held; an agent's `status` done/reopen events, an agent-authored comment, a human-authored schedule row and an `operator_input` with `fromKind: "agent"` → don't reset;
  - an open hold → `opened: false` for either direction;
  - a resumed hold's `resumed_at` is a window start; a reset after the hold opened doesn't release it;
  - task_comment and agent-authored scheduled rows count; human-authored scheduled rows don't;
  - window: rows older than `window` don't count;
  - **concurrency:** two connections each running `lockPairs([{A,B},{A,C}])` / `lockPairs([{A,C},{A,B}])` and inserting → both commit, no deadlock (Postgres `40P01` never seen); two racing sends at the threshold → exactly one opens the hold, the other sees it open.
  - unit: `pairOf` orders; the minutes rounding is ≥ 1.
- [ ] **Step 2–4:** implement; measure `explain analyze` of the window and count statements on the U4 `worst` dataset (214 agents) and paste the plans in the PR body; add an index only if a sequential scan on `messages` shows up for the scheduled branch.
- [ ] **Step 5: Commit** `feat(server): the loop guard derives pair counts under sorted advisory locks`.

### Task 3.3: Router list send holds per recipient

**Files:**
- Modify: `apps/server/src/messaging/router.ts` (I1's `send(from, to[], …)`: for an agent sender, collect agent recipients, `loopGuard.lockPairs` once at the start of the insert transaction, `check` per agent recipient before its insert; a held row is inserted with `state: "loop_held"`, `loopHoldId` and not handed over), `apps/server/src/agents/event-store.ts` (`createMessage` accepts `state?: "pending" | "loop_held"` and `loopHoldId?`), `packages/shared/src/messaging.ts` (per-recipient result `status` gains `"held"`; `MessageLookup.state` and its schema gain `"loop_held"`), `apps/server/src/app.ts` (construct `LoopGuard`, inject into Router, TaskService, Scheduler)
- Test: `apps/server/src/messaging/router.test.ts` (CI)

- [ ] **Step 1: Failing tests:** after the threshold, `send(A, ["@b","@orlevi"])` returns `@b` `status: "held"` with the tripping note verbatim and `@orlevi` `status: "inbox"`; the held row is not in B's queue (`runtimes.deliver` not called for it); a later send in either direction gets the later-row note verbatim; a human sender is never checked; a list send to B and C where only A↔B is held holds only B.
- [ ] **Step 2–4:** implement; notes from one module `loopNotes` (`apps/server/src/messaging/loop-guard.ts`): `tripping(to, total, minutes)` and `later(to)` with `plural`.
- [ ] **Step 5: Commit** `feat(server): send_message holds a looping pair`.

### Task 3.4: Task comments and scheduled firings

**Files:**
- Modify: `apps/server/src/tasks/task-service.ts` (`write()` ~L798: when `p.kind === "task_comment"` and `p.from` is an agent, lock all agent recipients' pairs first, then `check` per recipient; held rows created via `createTaskMessage(tx, {..., state: "loop_held", loopHoldId})` and not pushed to `agentRows`; collect `held: [{ to, note }]` into the outcome; `comment()`'s result gains `held`), `apps/server/src/agents/event-store.ts` (`createTaskMessage` accepts `state`/`loopHoldId`), the `comment_task` MCP tool result schema (`held`), `apps/server/src/scheduling/schedule-store.ts` (`upsertFiring`: the pending lookup matches `state in ('pending','loop_held')`; a matched `loop_held` row is updated in place and the function returns `undefined` (never handed over); the insert path takes `{ held?: { holdId } }` and inserts `state: "loop_held"`), `records()` (`pendingFiring` true for either state), `apps/server/src/scheduling/scheduler.ts` (`fire()`: when the schedule's body author is an agent and the target is another agent, after the schedule row lock: `lockPairs([pairOf(author, target)])`, then `check` only on the insert path, i.e. when `upsertFiring` found no open row)
- Test: `apps/server/src/tasks/task-service.test.ts`, `apps/server/src/scheduling/scheduler.test.ts` (CI)

- [ ] **Step 1: Failing tests:** an agent comment that mentions B after the pair tripped is posted (comment row exists, visible on the task) and B's row is `loop_held`; `comment_task` returns `held: [{to:"@b", note}]`; a human comment is never checked; an agent-authored schedule firing into B after the trip is inserted `loop_held`; a second firing while held updates that row in place (firings + missed) and nothing is handed over; a firing row already `pending` when the hold opened is still delivered (upsert path, no check); a human-authored schedule is never checked.
- [ ] **Step 2–4:** implement. **Step 5: Commit** `feat(server): task comments and agent schedules count toward the loop guard`.

### Task 3.5: Notices on open; `operator_input.fromKind`; ended agents

**Files:**
- Modify: `apps/server/src/messaging/loop-guard.ts` (`LoopNotices.onOpened(tx, hold, a, b, counts)`), `apps/server/src/agents/event-store.ts` (`createHumanMessage` accepts `loopHoldId`; `rejectPending` and `rejectPendingToTerminated` match `state in ('pending','loop_held')`), `packages/shared/src/events.ts` (`operator_input.fromKind: z.enum(["human","agent"])`, required), `apps/server/src/agents/agent-runtime.ts` (`writeRaw` sets `fromKind: entry.userId ? "human" : "agent"`), the web `operator_input` fixtures
- Test: `loop-guard.test.ts`, `apps/server/src/spawning/terminate-service.test.ts`, `agent-runtime` raw-input test (CI)

Notices (spec §6.4 copy verbatim; `@a` = sender of the tripping row):
- humans: `createHumanMessage({ kind: "system", fromAgentId: null, notice: "loop_held", subjectAgentId: A, loopHoldId, to: "all", body: "@a and @b exchanged 22 messages in 3 minutes; further messages between them are held.", urgent: false }, tx)`;
- managers: for `new Set([A.reportsTo, B.reportsTo])` minus null, minus A and B, minus archived/terminated: `store.createNotice`-style `system` row to that agent (the same path as other `@factory` notices to agents), no `loopHoldId`, body "@a and @b exchanged 22 messages in 3 minutes with no human in between. Messages between them are held until a human resumes them in the Inbox.";
- after commit: `bus.publishAll({ type: "inbox_changed" })`, hand-off of the manager notices as other notices are.

- [ ] **Step 1: Failing tests:** opening a hold writes exactly one human notice with `loop_hold_id` and one inbox item per user; a manager who is B gets nothing; a shared manager gets one; an archived manager gets nothing; terminating B rejects its `loop_held` rows; archiving B leaves them `loop_held`; `rejectPendingToTerminated` at boot rejects `loop_held` rows to terminated agents; boot's wake rebuild ignores `loop_held` rows; human raw input writes `fromKind: "human"`, an agent `send_command` writes `"agent"`.
- [ ] **Step 2–4:** implement. **Step 5: Commit** `feat(server): loop hold notices; held rows follow termination`.

### Task 3.6: CLAUDE.md held line; outgoing card

Implementer and reviewer invoke `vercel-react-best-practices` and follow it (the outgoing card).

**Files:**
- Modify: `apps/server/src/workspace/claude-md.ts` (messaging section, spec §6.5 sentence verbatim), `apps/web/src/features/session/outgoing-message.tsx` (status `held` renders like pending: muted line "Held by the loop guard: @b")
- Test: `apps/server/src/workspace/claude-md.test.ts` (snapshot), `outgoing-message.test.tsx`

- [ ] **Step 1–4:** failing snapshot and card test; implement; pass. **Step 5: Commit** `feat: agents learn what held means; the outgoing card shows it`.

### Task 3.7: Resume

**Files:**
- Create: `apps/server/src/routes/loop-holds.ts`, `apps/server/src/messaging/loop-resume.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/agents/event-store.ts` (inbox `toEntries`: for `notice = 'loop_held'` rows with `loop_hold_id`, join `loop_holds`, both agents' slug and live status, `waiting` = count of `loop_held` rows with that id, `sentOn` = count of rows with that id whose state is neither `loop_held` nor `rejected`, `resumedBy` = `'@' || users.handle`), `packages/shared/src/messaging.ts` (`loopHold` per spec §6.4; `resumeLoopHoldResponseSchema = z.object({ sentOn: z.number().int() })`, 409 body `{ resumedBy: string, resumedAt: string }`)
- Test: `apps/server/src/routes/loop-holds.test.ts` (CI)

```ts
// loop-resume.ts, one transaction (spec §6.6)
const hold = await tx.select().from(loopHolds).where(eq(loopHolds.id, id));   // read the pair first
await guard.lockPairs(tx, [{ a: hold.agentA, b: hold.agentB }]);              // pair lock BEFORE the row lock
const [locked] = await tx.select().from(loopHolds).where(eq(loopHolds.id, id)).for("update");
if (locked.resumedAt) throw new AlreadyResumed(locked.resumedBy, locked.resumedAt);
await tx.update(loopHolds).set({ resumedAt: clock(), resumedBy: userId }).where(eq(loopHolds.id, id));
const rows = await tx.update(messages).set({ state: "pending" })
  .where(and(eq(messages.loopHoldId, id), eq(messages.state, "loop_held")))
  .returning(/* PendingRow columns */);
// after commit: rows sorted by createdAt → router hand-off (agent sender: enqueue as today); publishAll inbox_changed
```

- [ ] **Step 1: Failing tests:** the inbox entry's `loopHold.sentOn` = count of rows with that `loop_hold_id` whose state is neither `loop_held` nor `rejected` (0 before Resume, n after, unchanged by a remount); Resume flips every held row to pending, hands them off in `created_at` order, returns `{ sentOn: n }`, sets `resumed_at`/`resumed_by`; a second Resume → 409 with `resumedBy: "@or"`; unknown id → 404; no session → 401; the window restarts at `resumed_at` (N more each way before a new hold); **race:** a send paused (test hook) between `check` (saw the hold open) and its insert while Resume runs → Resume waits on the pair lock, the send commits its held row, Resume then flips it too (no `loop_held` row left on a closed hold); a hold whose rows were all rejected resumes with `sentOn: 0`; the inbox entry's `loopHold` has `waiting`, `sentOn`, both statuses and `resumedBy`.
- [ ] **Step 2–4:** implement. **Step 5: Commit** `feat(server): humans resume a held pair`.

### Task 3.8: The two settings

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `packages/shared/src/settings.ts` (`FACTORY_BOUNDS.loopGuardMessages: [2, 1000]`, `loopGuardWindowMinutes: [1, 1440]`; both in `factorySettingsSchema` and `patchFactorySettingsSchema`), `apps/server/src/settings/factory-settings.ts` (values, getters `loopGuardMessages()`, `loopGuardWindowMs()`), `apps/server/src/routes/settings.ts`, `apps/web/src/features/settings/factory-section.tsx` (two `numberField`s after Member-update debounce; labels, suffixes and hints verbatim from spec §6.8)
- Test: `packages/shared/src/settings.test.ts`, `apps/server/src/routes/settings-routes.test.ts` (CI), `apps/web/src/test/settings-factory.test.tsx`

- [ ] **Step 1: Failing tests:** bounds reject 1 and 1001 / 0 and 1441 with the shared sentence; PATCH updates and the guard reads the new value on the next check (no restart); the form shows "Loop guard limit" with suffix "messages" and its hint, "Loop guard window" with "min" and its hint.
- [ ] **Step 2–4:** implement. **Step 5: Commit** `feat: loop guard limit and window in Settings → Factory`.

### Task 3.9: The hold row and pane

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/inbox/loop-hold-pane.tsx`
- Modify: `apps/web/src/features/inbox/inbox-row.tsx` (muted label "Held" / "Resumed" after the sender on line one, `shrink-0`, never truncated, when `item.loopHold`), `apps/web/src/features/inbox/inbox-pane.tsx` (the body switch: `notice === "loop_held"` → `LoopHoldPane`; hide the header `OpenLink`; no excerpt, no composer), `apps/web/src/features/inbox/api.ts` (`useResumeHold` mutation → on success `invalidateQueries(inboxQueryKey)` and the item query)

React review M5: the result line renders from the **mutation's data** right after a Resume (`m.data.sentOn`), and from `loopHold` otherwise; `loopHold.sentOn` is derived server-side (Task 3.7) so every pane and every remount shows "· 4 messages sent on". A `focusResult` ref is set in the click handler's `mutate(undefined, { onSuccess: () => { focusResult.current = true } })`; the status line moves focus in a `useLayoutEffect` (or callback ref) when the flag is set, then clears it. The click handler starts with `if (m.isPending) return`. A 409 renders "Resumed by @ana · …" from the error body at once, then invalidates the inbox and item queries.
- Test: `apps/web/src/features/inbox/loop-hold-pane.test.tsx`, `inbox-row.test.tsx`

Pane per spec §6.7 (copy verbatim): body text with handles in `font-mono` and `[overflow-wrap:anywhere]`; waiting line (`plural`: "1 message waiting" / "4 messages waiting" / "Nothing is waiting"); a terminated agent line "@b was terminated; its held messages were rejected."; the action slot at one fixed `min-h` holding either the primary button "Resume @a and @b" (wraps, `min-w` kept while pending with "Resuming…" and the spinner, `aria-disabled`) or the `role="status"` `tabIndex={-1}` line (focused after your own Resume via a ref in the mutation's `onSuccess`): "Resumed by you · {formatInboxTime} · {n} messages sent on" / "… · nothing was left to send"; another human's or a 409: "Resumed by @ana · {time}" (`title` = full timestamp); two ghost links "Open @a's session" / "Open @b's session" to `/agents/$slug/session`; a non-409 failure keeps the button and shows `FormOutcome` with `FORM_MSG.resumeFailed = "Couldn't resume. Try again."`. No toast. The notifier closes the hold's notification once `resumedAt` is set (Task 2.3 `resolved`).

- [ ] **Step 1: Failing tests:** each line's copy at 0/1/4 waiting; terminated line; pending keeps width and is `aria-disabled`; success replaces the button with the status line and focuses it; 409 shows the other human; error line; header `OpenLink` absent; no composer rendered; row label Held → Resumed after `inbox_changed`; `formatInboxTime` used (a resumed time from yesterday shows its date).
- [ ] **Step 2–4:** implement. **Step 5: Commit** `feat(web): the loop hold pane with Resume`.

### Task 3.10: Full-width notice pane below 1024px

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/routes/_app/inbox.tsx` (React review M6: **delete** the L47-50 effect; narrow passes `itemId` to `useLoadedItem` too; below `WIDE` with an `itemId` the page renders `<NarrowItem id={itemId} />` instead of the list), `apps/web/src/features/inbox/api.ts` (move `usePaneItem` here from `inbox-pane.tsx` and export it), `apps/web/src/features/inbox/inbox-row.tsx` (rows of `FULL_WIDTH_NOTICES` link to `/inbox?item=<id>` at every width)
- Create: `apps/web/src/features/inbox/narrow-item.tsx`: `NarrowItem` resolves the item with `usePaneItem(id)`: a `chat:<slug>` id returns `<Navigate to="/agents/$slug/chat" params={{ slug }} replace />` with no fetch; while resolving, a static skeleton (never the list); an item whose `notice` is in `FULL_WIDTH_NOTICES` (`["loop_held"]` here; PR 4 adds `"worktrees_kept"`) renders `<InboxPane>` full-width with Back as `<Link to="/inbox" search={{}}>`; any other kind returns `<Navigate replace … />` to the item's own target (no navigate-in-effect).
- Test: `apps/web/src/test/inbox-route.test.tsx`

- [ ] **Step 1: Failing tests** (narrow `matchMedia`): `/inbox?item=chat:ada` navigates to `/agents/ada/chat` without fetching the item (assert no request); `/inbox?item=<hold>` renders the hold pane full-width with Back and Resume; Back returns to the list; `/inbox?item=<mention>` replaces the URL with the task target; an unloaded item id (not in the first page) is fetched and rendered without the list flashing; a hold row's link is `/inbox?item=` at 390 and 1440.
- [ ] **Step 2–4:** implement. **Step 5: Commit** `feat(web): a hold opens full-width below 1024px`.

### Task 3.11: DESIGN.md, product docs, evidence, review, PR 3

- [ ] **Step 1: DESIGN.md** Layout → Two panes amendment, spec §6.7, verbatim. Commit.
- [ ] **Step 2: Product docs** (main checkout): `concepts/message.md`, `architecture/factory-mcp.md`, `architecture/data-model.md`, `behavior/inbox.md`, `architecture/usage-tracking.md`, `behavior/administration.md` per spec §9. List them in the PR body.
- [ ] **Step 3: Evidence** (heavy + harness locks, fake Claude): `i8-evidence/loop_guard.ts` starts the harness server with the settings at N = 3, two fake agents whose `fake.mjs` scripts answer every message with `$mcp send_message` to the other (I1's `$mcp` directive); records each `send_message` result until `held`, the notice, the managers' messages; then Resume through the API and records `sentOn`. Screenshots `i8_c20_hold_pane.py` (1440 pane, light/dark, 200%) and `i8_c21_hold_narrow.py` (390 and 320 full-width, Resume works, Back), plus the row label before and after.
- [ ] **Step 4: Whole-PR review** as in Task 1.7 Step 1 against spec §6 and AC 8–12, plus: every insert path of a counted row goes through `lockPairs` + `check` (grep `kind: "message"`, `task_comment`, `scheduled` inserts); Resume takes the pair lock before the row lock; no counts stored; copy verbatim; ADR 0028 (no state alias `held` in the DB); **the React diff against `vercel-react-best-practices`** (mutation from the click handler, focus via ref in `onSuccess`, no derived state in effects, the route's resolve logic without effect chains).
- [ ] **Step 5: Full verification** as in Task 1.7 Step 2. **Step 6: Push and draft PR** (base `i8/2-notifications`), title `feat: a loop guard holds agent ping-pong until a human resumes it`, "Closes #47", reset step stated, `explain analyze` plans pasted, docs listed, retarget note. CI until green. Never merge.

---

# PR 4: `i8/4-spawn-cleanup`

Implements spec §7, AC 13–15. `git checkout -b i8/4-spawn-cleanup i8/3-loop-guard`.

**Slug uniqueness** (spec §7.1), cited in code comments and the PR body: `agents.slug` is `.unique()` in `packages/db/src/schema/agents.ts`; I1's `handles` table (`agents.slug → handles(handle)`, I1 Task 1.1) reclaims a claim only when no row references it (`claimHandle` in `apps/server/src/messaging/principals.ts`, I1 Task 1.2); no code deletes from `agents` (Task 4.3 adds a test that greps `apps/server/src` for `delete(agents)` / `delete(schema.agents)` and finds none, and a test that spawning with a terminated agent's slug as explicit suffix is refused).

### Task 4.1: The hardened git runner

**Files:**
- Create: `apps/server/src/spawning/git.ts`
- Test: `apps/server/src/spawning/git.test.ts` (real git in `mkdtemp` repos; no DB; runs locally)

**Interfaces:**
- Produces:

```ts
export class GitMissingError extends Error {}
export class GitError extends Error { constructor(readonly args: string[], readonly stderr: string, readonly code: number | null) }
export type GitAllowed =
  | ["rev-parse", "--show-toplevel"] | ["rev-parse", "--git-common-dir"]
  | ["worktree", "list", "--porcelain", "-z"]
  | ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]
  | ["show-ref", "--verify", "-q", string]
  | ["check-ref-format", "--branch", string]
  | ["rev-list", "--count", string, "--not", "--remotes", ...string[]]   // ends with "--"
  | ["branch", "-D", "--end-of-options", string];
export function git(repo: string, args: GitAllowed, opts?: { timeoutMs?: number }): Promise<string>;
```

Implementation, exactly (spec §7.4):

```ts
const BASE = ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
function env(repo: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME,       // nothing else from the server's env
    GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0", GIT_CEILING_DIRECTORIES: path.dirname(repo), LC_ALL: "C",
  };
}
async function run(repo: string, args: string[], timeoutMs: number) {
  return new Promise<string>((resolve, reject) =>
    execFile("git", args, { cwd: repo, env: env(repo), timeout: timeoutMs, maxBuffer: 1 << 20, shell: false },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(new GitMissingError());
        if (err) return reject(new GitError(args, String(stderr), typeof err.code === "number" ? err.code : null));
        resolve(String(stdout));
      }));
}
export async function git(repo, args, { timeoutMs = 15_000 } = {}) {
  assertAllowed(args);                 // the GitAllowed shapes at runtime too; rev-list must end with "--"
  try { return await run(repo, [...BASE, ...args], timeoutMs); }
  catch (e) {
    if (e instanceof GitError && /detected dubious ownership/.test(e.stderr))
      // D7: the exact repo path for this one call; never "*", never written to any config.
      return run(repo, [...BASE, "-c", `safe.directory=${repo}`, ...args], timeoutMs);
    throw e;
  }
}
```

`repo` is always the `realpath` the caller computed. `assertAllowed` throws for anything else (`status`, `diff`, `worktree remove`, `worktree prune`, `fetch`, `gc`, any shape not listed); this is a unit test.

- [ ] **Step 1: Failing tests** (each in a fresh temp repo; a `marker` file outside the repo):
  - `assertAllowed` refuses `["status"]`, `["worktree","prune"]`, `["worktree","remove","x"]`, `["fetch"]`, a `rev-list` without a trailing `--`;
  - planted `git config core.fsmonitor <script writing marker>` + `core.hooksPath <dir>` with `reference-transaction`, `post-checkout`, `pre-commit` hooks that write the marker: running every allowed command (including `branch -D --end-of-options x` on a real branch) leaves `marker` absent; a control run of plain `git branch -D` (outside the runner) writes it (proves the plant works);
  - env: a script set as `GIT_EXTERNAL_DIFF`/`GIT_SSH_COMMAND` in the server env is not passed (assert the child env keys via a `git` shim on `PATH` in the test that dumps its env);
  - `GIT_CEILING_DIRECTORIES`: `git(<non-repo subfolder of a repo>, ["rev-parse","--show-toplevel"])` throws `GitError`;
  - `PATH` without git → `GitMissingError`;
  - a timeout of 1 ms on a slow shim → `GitError` (killed), no hang;
  - dubious ownership: a `git` shim on `PATH` that fails once with "detected dubious ownership" then records its args → the retry has `-c safe.directory=<repo>` exactly once and never `*`; no `git config --global` is ever invoked (the shim records every call).
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/spawning/git.test.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** PASS.
- [ ] **Step 5: Commit** `feat(server): a hardened git runner for spawned-agent cleanup`.

### Task 4.2: Per-project cleanup steps

**Files:**
- Create: `apps/server/src/spawning/cleanup-project.ts` (spec §7.5 step 4: a metadata mismatch skips the whole project, stricter than per-worktree)
- Test: `apps/server/src/spawning/cleanup-project.test.ts`, `cleanup.hardening.test.ts` (real git, temp repos, no DB)

**Interfaces:**
- Consumes: `git`, `GitError`, `GitMissingError`, `SafeFs` (`apps/server/src/workspace/safe-fs.ts`).
- Produces:

```ts
export type ProjectResult = {
  project: string;
  removed: boolean;
  deleted: string[];
  kept: { branch: string; commits?: number; reason?: "elsewhere" }[];
  error?: string;            // the spec's per-project sentence after "web: "
};
export async function cleanupProject(p: { name: string; hostPath: string }, slug: string): Promise<ProjectResult | null>; // null = nothing of ours there
```

Steps, exactly (spec §7.5; every refusal becomes `error` and stops that project):

1. `repo = await realpath(hostPath)` (missing → `error: "the project folder is missing"`). `top = (await git(repo, ["rev-parse","--show-toplevel"])).trim()`; `top !== repo` → `error: "not a git repository"`. `common = await realpath(path.resolve(repo, (await git(repo, ["rev-parse","--git-common-dir"])).trim()))`.
2. `lstat` in turn `repo/.worktrees`, `repo/.worktrees/.agents`, `base = repo/.worktrees/.agents/<slug>`: a symlink or non-directory at any → `error: ".worktrees/.agents/<slug> is a symbolic link; left in place"` (name the offending component); missing → `baseExists = false`.
3. `git worktree list --porcelain -z` → parse records (NUL-separated fields, empty field ends a record): `worktree <path>`, `branch refs/heads/<name>`, `locked`, `prunable`. `inBase(p) = rel = path.relative(base, path.normalize(p)); rel && !rel.startsWith("..") && !path.isAbsolute(rel)`. Ours → `branches`; others → `checkedOutElsewhere` (their branch names); the first record's branch also → `checkedOutElsewhere`. A `locked` mark is ignored (R12). Paths are data: never passed to `rm`.
4. Admin dirs: `wt = path.join(common, "worktrees")`; `lstat(wt)` must be a real directory (symlink → `error`; missing → `adminDirs = []`). `wtReal = await realpath(wt)`. For each `id` of `readdir(wt)`: skip unless `/^[^./][^/]*$/.test(id) && !id.includes("..")`; `st = lstat(wt/id)` must be a directory and not a symlink; `path.dirname(await realpath(wt/id)) === wtReal`; read `wt/id/gitdir` with `O_NOFOLLOW` (`SafeFs.readIfRegular`), trim; `g = path.isAbsolute(raw) ? raw : path.resolve(wt, id, raw)`; `g = path.normalize(g)`; keep `wt/id` when `inBase(path.dirname(g))` (gitdir names `<worktree>/.git`). Cross-check: for each of ours from step 3 whose `worktree` path has no admin dir whose `gitdir` dirname equals it → do not remove that worktree's folder; record `error: "couldn't match <branch>'s metadata; left in place"` and skip steps 5–7 for the project (keeps it simple and safe).
5. If `baseExists`: re-`lstat` `base` (still a directory, not a symlink) and `realpath(base) === path.join(repo, ".worktrees/.agents", slug)`; then `await new SafeFs(base).removeAll()` (rm never follows links inside; a symlinked root is unlinked). Any error (EACCES) → `error: "couldn't remove .worktrees/.agents/<slug>: <code>"`, skip 6–7. `removed = true`.
6. For each admin dir: re-check (lstat directory, not symlink, `dirname(realpath) === wtReal`), then `new SafeFs(dir).removeAll()`. No `git worktree prune`, ever.
7. Default: `d = await git(repo, ["symbolic-ref","-q","refs/remotes/origin/HEAD"]).then(s => s.trim().replace(/^refs\/remotes\/origin\//, ""), () => undefined)`; candidates `[d, "main", "master"]`, the default = the first whose `show-ref --verify -q refs/heads/<x>` succeeds (or none). `protectedNames = new Set([d, "main", "master"].filter(Boolean))`. For each branch of `branches`: `check-ref-format --branch <name>` fails → skip silently; in `protectedNames` → skip; in `checkedOutElsewhere` → `kept.push({branch, reason:"elsewhere"})`; else `n = Number(await git(repo, ["rev-list","--count",`refs/heads/${name}`,"--not","--remotes", ...(def ? [`refs/heads/${def}`] : []), "--"]))`; `n === 0` → `git branch -D --end-of-options <name>` → `deleted.push(name)`; else `kept.push({branch, commits: n})`.
`GitMissingError` propagates (the caller turns it into the one host-level line). Returns `null` when steps 2–4 found nothing of ours (no folder, no entries, no admin dirs).

- [ ] **Step 1: Failing tests** (`cleanup-project.test.ts`, real git, a bare `origin` repo in the temp dir as the remote, no network):
  - our two worktrees `.worktrees/.agents/dev-ab12/feat/x` (unpushed commit) and `…/fix/y` (pushed: `git push origin fix/y`) → folder gone; both admin dirs gone; `fix/y` deleted; `feat/x` kept with `commits: 1`; `git worktree list` shows only the main checkout;
  - a merged branch (fast-forwarded into `main` locally, never pushed) → deleted;
  - a human worktree `.worktrees/feat-z` whose folder was moved away (prunable) keeps its admin dir (we never prune);
  - another agent's folder `.worktrees/.agents/dev-zz99/…` untouched;
  - a branch of ours also checked out in the main checkout → kept `reason: "elsewhere"`; `main`, `master` and the origin/HEAD default never deleted even if checked out in our folder;
  - a locked worktree in our folder (`git worktree lock`) → removed with its admin dir, its branch judged normally;
  - a worktree created with `git worktree add --relative-paths` → matched and removed (git ≥ 2.48; skip with a recorded reason if the installed git is older);
  - origin/HEAD → `develop` with no local `develop` → no `rev-list` failure (default falls to `main`);
  - the folder already deleted by the agent but admin dirs left → admin dirs removed, branches judged;
  - nothing of ours → `null`.
- [ ] **Step 2: Failing tests** (`cleanup.hardening.test.ts`, each with an outside `victim/` folder holding a file that must survive):
  - `.worktrees` a symlink to `victim/`; `.worktrees/.agents` a symlink; `<slug>` a symlink → `error`, victim intact;
  - a symlink inside our folder pointing to `victim/` → unlinked, victim intact;
  - `common/worktrees` a symlink to a folder that contains a forged admin dir → `error`, nothing removed there;
  - an admin dir named `..x`, `.hidden`, or a symlink to `victim/` → ignored;
  - a forged admin dir whose `gitdir` points into `victim/` → not removed; a forged admin dir whose `gitdir` points under `base` but lives outside `common/worktrees` cannot exist (ids are read only from `common/worktrees`);
  - a worktree entry of ours whose admin dir was renamed so nothing matches → cross-check refuses; folder kept;
  - planted fsmonitor and hooks (as Task 4.1) → marker absent after the whole cleanup;
  - a file named `refs/heads/feat/x` in the main checkout → `rev-list` still counts (the trailing `--`);
  - a branch named `-D` or `--force` cannot be created by git; a ref name that fails `check-ref-format --branch` (written directly into `.git/refs/heads/` as `bad..name`) → skipped, never passed to `branch -D`;
  - a non-repo subfolder of a parent repo as the project path → `error: "not a git repository"`.
- [ ] **Step 3: Run** `pnpm vitest run apps/server/src/spawning/cleanup-project.test.ts apps/server/src/spawning/cleanup.hardening.test.ts` — FAIL. **Step 4: Implement**, then run — PASS.
- [ ] **Step 5: Commit** `feat(server): clean up a terminated agent's worktrees in one project, hardened`.

### Task 4.3: `SpawnCleanup`, the reaper hook, the event and the notice

**Files:**
- Create: `apps/server/src/spawning/cleanup.ts`
- Modify: `apps/server/src/workspace/workspace.ts` (`deleteWorkspace(slug, stillUnpinned, markDeleted, beforeRemove)`: called after `stillUnpinned()` and before `removeAll`), `apps/server/src/spawning/reaper.ts` (passes `() => this.d.cleanup.run(a)`; `ReaperDeps.cleanup: Pick<SpawnCleanup, "run">`), `apps/server/src/app.ts` (construct), `packages/shared/src/events.ts` (`workspace_cleanup { projects: ProjectResult[] }`), `apps/server/src/agents/event-store.ts` (`createHumanMessage` and the agent-notice path accept `notice: "worktrees_kept"`)
- Test: `apps/server/src/spawning/cleanup.test.ts` (DB, CI), `reaper.test.ts`, `workspace.test.ts`

**Interfaces:**
- Produces: `class SpawnCleanup { constructor(d: { db: Db; store: EventStore; bus: EventBus; router: Router; log: RuntimeLog; cleanupProject?: typeof cleanupProject }); run(agent: AgentRow): Promise<void> /* never rejects */ }`; `noticeBody(slug, results, hostLine?): string | null` (pure).

`run`: `projects = select name, host_path from projects order by name`; for each, `try { r = await cleanupProject(p, agent.slug) } catch (e) { if (e instanceof GitMissingError) { hostLine = true; break } r = { project: p.name, removed: false, deleted: [], kept: [], error: "couldn't clean up: " + short(e) } }`; collect non-null results. If any: `store.append(agent.id, null, { type: "workspace_cleanup", projects })` (the agent is terminated and its journal is empty — the reaper skips agents with a journal — so the single-writer rule holds). `body = noticeBody(...)`; when non-null (something kept or failed, or the host line): one `createHumanMessage({ kind: "system", fromAgentId: null, notice: "worktrees_kept", subjectAgentId: agent.id, to: "all", body, urgent: false })` with its inbox `link.seq` = the appended event's seq, then `publishAll(inbox_changed)`; and when the manager (`reportsTo`) is live, the same body as a `@factory` system message to it (the existing notice-to-agent path, handed over after commit). Everything in one outer `try/catch` that logs and returns: `run` never rejects, so `deleteWorkspace` always proceeds.

`noticeBody` (spec §7.6 copy verbatim): first line "Cleaned up @dev-ab12's worktrees." when any `removed`, else (or when any `error`) "Couldn't fully clean up @dev-ab12's worktrees."; then per project with kept or error: "web: kept `feat/x` (3 commits not pushed or merged), `feat/y` (checked out elsewhere)" / "web: couldn't clean up: not a git repository"; the host line "Couldn't clean up worktrees: git isn't installed on the factory host."; at most 20 entries then "and N more in @dev-ab12's session"; `null` when nothing was kept and nothing failed.

- [ ] **Step 1: Failing tests:**
  - pure `noticeBody`: removed+kept, failures only, host line, the cap at 20 with "and N more…", plural "1 commit"/"3 commits", `null` for removals only;
  - `cleanup.test.ts` (CI, with a fake `cleanupProject`): kept → one human notice with `notice: "worktrees_kept"` and its inbox link at the event, one manager message when the manager is live, none when it is terminated; removals only → event appended, no notice; a throwing `cleanupProject` → still resolves; `GitMissingError` → the host line; a failing `createHumanMessage` → logged, `run` resolves;
  - `reaper.test.ts`: `beforeRemove` runs before the folders are removed and only when unpinned; a pin set before the sweep skips both; `run` rejecting is impossible (assert deletion proceeds when the injected cleanup throws inside);
  - projects are scanned regardless of grants (a terminated agent has none: termination deletes `agent_project_grants`, `event-store.ts:221`);
  - slug uniqueness: spawning with `suffix` equal to a terminated agent's suffix is refused (`slug_taken`); the grep test that nothing deletes from `agents`.
- [ ] **Step 2–4:** implement. **Step 5: Commit** `feat(server): clean up worktrees when a spawned agent's workspace is deleted`.

### Task 4.4: CLAUDE.md worktree line

**Files:**
- Modify: `apps/server/src/workspace/claude-md.ts` (L193: the line from spec §7.1 with the agent's slug; spawned agents get the second sentence too)
- Test: `apps/server/src/workspace/claude-md.test.ts` (snapshots for a persistent and a spawned agent)

- [ ] **Step 1–4:** failing snapshots; implement; pass. **Step 5: Commit** `feat(server): agents put worktrees under .worktrees/.agents/<slug>`.

### Task 4.5: Web: the cleanup line and notice pane

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `packages/shared/src/messaging.ts` + `apps/server/src/agents/event-store.ts` (React review m10: inbox items of `notice = 'worktrees_kept'` gain `cleanup?: ProjectResult[]`, built in `toEntries` from the referenced `workspace_cleanup` event's payload; `ProjectResult` moves to `packages/shared/src/events.ts`), `apps/web/src/features/session/rows.ts` / `timeline-row.tsx` (a `workspace_cleanup` event renders as a muted factory line grouped by project, branch names `font-mono [overflow-wrap:anywhere]`, copy from spec §7.5), `apps/web/src/features/inbox/inbox-pane.tsx` (`notice === "worktrees_kept"` → `CleanupPane`; no excerpt, no composer; header `OpenLink` stays and targets the event seq), `apps/web/src/routes/_app/inbox.tsx` (`FULL_WIDTH_NOTICES` gains `"worktrees_kept"`)
- Create: `apps/web/src/features/inbox/cleanup-pane.tsx` (renders from `item.cleanup`, the same `ProjectResult[]` shape as the session line, never by parsing the body: lines grouped by project, branch names mono with `copy-feedback.tsx`, then "Push them to keep the work, or delete them in the project's repository.")
- Test: `cleanup-pane.test.tsx`, a `rows` test, `inbox-route.test.tsx` (full width at 390)

- [ ] **Step 1–4:** failing tests (copy, mono branches, copy button feedback, long branch names wrap without page overflow, no composer, full-width at 390 with Back, no desktop notification for this notice — Task 2.2's test already covers it); implement; pass.
- [ ] **Step 5: Commit** `feat(web): the cleanup line and notice`.

### Task 4.6: Product docs, evidence, whole-I8 review, PR 4

- [ ] **Step 1: Product docs** (main checkout): `behavior/agents-and-sessions.md` (spawned-agent workspace lifecycle incl. worktrees and branches), `architecture/context-assembly.md` (the worktree line), `concepts/project.md` (L16 "never deleted by the factory" → what the factory removes in a repo and what it never touches). List them in the PR body.
- [ ] **Step 2: Evidence** (heavy + harness locks, fake Claude): `i8-evidence/cleanup.ts` creates a project repo in a temp dir with a bare origin, registers it, spawns a fake child, creates (as the test, through the runner-free git CLI in the temp repo) two worktrees under `.worktrees/.agents/<child>/` (one pushed, one not), terminates the child, sets its `terminated_at` back 3 days + 1 minute in the throwaway DB, runs the reaper once (`app.reaper.run()` via the harness's control hook or a script), and records: the folder gone, the pushed branch gone, the unpushed one kept, the notice text, the Session line. Screenshot `i8_c30_cleanup_notice.py` at 1440 and 390.
- [ ] **Step 3: Whole-PR and whole-I8 review.** A fresh read-only reviewer on `git diff i8/3-loop-guard...i8/4-spawn-cleanup` (and skimming PRs 1–3) checks spec §7 and AC 13–15 line by line, **every git invocation goes through `git()`** (grep for `execFile`, `spawn(`, `"git"` in `apps/server/src/spawning`), no `worktree remove`/`prune`, no path from git output reaches `rm`/`SafeFs` except the computed `base` and `common/worktrees/<id>`, `safe.directory` only in the one retry, ADR 0028, copy verbatim, and **the React diff against `vercel-react-best-practices`**. Fix findings.
- [ ] **Step 4: Full verification** as in Task 1.7 Step 2.
- [ ] **Step 5: Push and draft PR** (base `i8/3-loop-guard`), title `feat(server): clean up worktrees and landed branches of terminated spawned agents`, "Closes #55", the deliberate deviation stated (no `git worktree remove`; the folder is deleted directly), slug-uniqueness citations, docs listed, retarget note. CI until green. Never merge.

## Manual steps for Or (the executor never does these)

1. Review the decisions rated 3/5 or lower on #169 (Q6, Q8, Q10, Q16, R2a, R5, R6, R12; R11 rose to 4).
2. Optionally, on a real project: let a real spawned agent make a worktree, terminate it, and watch the cleanup after the grace (the evidence uses fake Claude and temp repos only).
