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

## Revalidated on I5/I7 (2026-11-25)

`spec/i8-quality-of-life` now has `origin/i7/3-restart` (I1–I7) merged in; every name below was checked against that code. Changes:

1. **Base.** The I7 head is merged into the spec branch, so PRs 1 and 2 branch straight from `spec/i8-quality-of-life` and target `i7/3-restart`. The branch-picking script is gone.
2. **Process (Or's v0.0.2 rules).** No heavy-job lock (the browser evidence still uses the U4 harness's `run.sh` lock); each implementer and reviewer runs only the test files it created or changed, the full suite/typecheck/lint/build once per PR; one reviewer per task plus a whole-PR review; PRs open **ready for review** (not draft) once the review is fixed and CI is green. Each task names its implementer model (Haiku for narrow, well-specified edits; Sonnet for judgement), per the Haiku trial.
3. **DB tests run locally when Postgres is up** (`DATABASE_URL`, via `makeTestApp`/`createTestDb`), else read CI; new DB-only files are named `*.db.test.ts`. `makeTestApp` sets `FACTORY_CLAUDE_BIN` to the fake Claude wrapper, which passes I5's Claude Code floor check on the start path: don't override it.
4. **Task 1.2:** `createAgentBodySchema` is a non-strict `z.object` without `manageOrg`, so a human's `manageOrg` is silently stripped (test "create body strips manageOrg instead of accepting it", `packages/shared/src/agents.test.ts:89`). That test is replaced. `create_agent` uses its own `createAgentToolSchema` (`packages/shared/src/org-tools.ts`), already covered by "create_agent: has no way to set manage_org" (`org-tools.test.ts:17`): no change there. The insert is in `AgentService.createLocked`.
5. **Task 1.3 shrinks.** `openSheetForResult(spec: ChildSpec, onDone)` (`sheet-store.ts:84`) already opens Add credential as a parent layer that serves itself, with the same `AddCredentialSheet` body (`setup-sheets.tsx`). No new sheet kind, no store or host change. The `["setup"]` invalidations go into the create paths that exist: `AddCredentialForm` (`features/settings/forms/add-credential-form.tsx`), `new-template-form.tsx` after `createTemplate`, `new-agent-sheet.tsx`'s `create`, and the `org_action` branch of `routes/_app.tsx`'s `onMessage`.
6. **Task 1.4/1.5 line refs.** "Nothing in your inbox." is `inbox-list.tsx:233`; "No item selected." is in `InboxPane` (`inbox-pane.tsx:596`). New agent shares `useAgentFormState` (`agent-form-state.ts`), whose `body()` create branch must send `manageOrg`; I7's help is `MANAGE_ORG_HELP` in `edit-agent-sheet.tsx:68` and the test copy `MANAGE_HELP` in `edit-agent-sheet.test.tsx:857`.
7. **Task 2.1 shrinks.** The chats/items split is already on the base (`inboxPage` filters `ne(messages.kind, "message")`; `unreadChats` inner-joins `from_agent_id`). What's left: `firstUnreadId` in `unreadChats` and through the route's chat enrichment (`routes/inbox.ts`), `notice` in `toEntries`, and the `notify` query (`z.enum(["true","false"])` like `unread`; its own cap of 200, above the route's `limit` max of 100).
8. **Task 2.3 names.** The base notifier is `notificationTitle`, `chatNotificationTitle`, `notifyNew` and a baseline from `homeInboxQueryOptions`; `_app.tsx` writes `notifyRef.current = notify` during render (L76-77). I5's `plugin_not_loaded` human notice joins the never-notify list.
9. **D4 is delivered.** `operator_input` already carries the required `byKind: "human" | "agent"` (`packages/shared/src/events.ts:117`, written in `agent-runtime.ts` `writeRaw`). The window's reset reads `payload->>'byKind' = 'human'`. Task 3.5 loses its `fromKind` steps; PR 3's reset step loses the "`operator_input` events don't parse" sentence.
10. **Task 3.1 SQL.** The schedule index is `("schedule_id","to_agent_id") WHERE state = 'pending' AND schedule_id IS NOT NULL` (0009); the widened one keeps `schedule_id IS NOT NULL`. The migration is 0024 on this base.
11. **Task 3.4 names.** The scheduler's transaction is `Scheduler.fireOnce` (`lockAgents` share, then `lockForFiring`, then `upsertFiring`); the pair lock goes after `lockForFiring`. Task comments' transactions run under `withDeadlockRetry`, so the guard's work must be retry-safe (it is: everything is in the transaction).
12. **Task 3.5 manager notices.** `EventStore.createNotice` isn't transaction-aware and replaces a pending notice of the same type and subject. Manager notices are inserted as new rows in the hold's transaction through a public `insertNotice(m, tx)` (today private), then handed over after commit. `NoticeType` (`agents/notices.ts`) gains `loop_held` and (PR 4) `worktrees_kept`.
13. **Task 3.6 card.** `outgoing-message.tsx` prints a recipient's `note` instead of its status; for `held` the "Held by the loop guard" line wins.
14. **Naming.** The base's "held" means rows held until a turn ends (`createHeld`, the `held` queue item, `agent-runtime.held.test.ts`). Loop-guard identifiers say `loopHeld`; only the tool status string is `held`.
15. **Task 3.3.** The spawn brief (`spawn-service.ts:309`, `createMessage` from spawner to child) is counted but never checked (a new child has no window).
16. **Task 4.3.** A `system` row's inbox link has no `seq` (only sender tool calls give one), so the cleanup notice links to the session without a `seq` (the event is the terminated agent's last). `cleanup` is read from the subject agent's `workspace_cleanup` event. The "nothing deletes from `agents`" grep test is dropped (AGENTS.md testing standards: no implementation-detail tests); the PR body cites it. The spawn refusal is the sentence "@<slug> is taken; pick another suffix or leave it out." (`spawn-service.ts:31`), not a `slug_taken` code.
17. **Task 4.4.** The worktree line is `claude-md.ts:248`.
18. **Task 4.2, verified.** `git worktree add` through the agent's `./projects/<name>` symlink records the physical path (git 2.50.1), and Docker mounts keep host paths, so matching against `realpath(repo)` holds (spec §12).
19. **Test file paths fixed:** `inbox-pane.test.tsx` exists in both `apps/web/src/test/` and `features/inbox/`; `inbox-route.test.tsx` and `inbox-row.test.tsx` are new files.

## Global Constraints

- **Pre-release (ADR 0028).** No backward compatibility, no shims, aliases, fallbacks for old shapes or data migration. Schema changes ship as the generated Drizzle migration (`pnpm db:generate`) plus the two hand edits to hand-written SQL named in Task 3.1. The worktree convention changes with no note for the old layout. Any fallback or compatibility branch is a review defect.
- **Reset step**, stated in every PR body: PR 3 only — if the migration refuses a non-empty table, reset local data (drop the database, recreate agents). PRs 1, 2 and 4 have no migration.
- **Builds on I1–I7, merged into this branch** (checked 2026-11-25). Names this plan uses from them, as implemented:
  - I1: `Router.send(from, to: string[], body, urgent, opts)` with per-recipient `RecipientResult` (`messaging/router.ts`), inserts through `store.transaction`; `chatRowSchema` and `inboxPageSchema.chats` (`packages/shared/src/inbox.ts`); `inboxItemSchema`, `INBOX_KINDS`, `messageLookupSchema` (`packages/shared/src/messaging.ts`); `EventStore.inboxPage(userId, before, limit, { unread })`, `unreadChats`, `toEntries`, `inboxRows` (`agents/event-store.ts`); the `operator_input` event `{ type; text; by; byKind: "human"|"agent"; clientMessageId?; entryId }` (`packages/shared/src/events.ts`) written by `writeRaw` in `agents/agent-runtime.ts`; `useInboxNotifier` (`features/inbox/notifications.ts`); `/agents/$slug/chat?message=` and `/agents/$slug/session` routes; the outgoing card `features/session/outgoing-message.tsx`; the list-stability helper `useHeldList` (`features/inbox/use-held-list.ts`).
  - I3: inbox items with `kind: "credential"`, `credential: { name, expiresAt, current }`, `link: { kind: "credential", name }`; `createHumanMessage({ …, notice?, inboxKind?, subjectCredentialId?, createdAt? }, tx?)`; `AddCredentialSheet` (`features/sheets/setup-sheets.tsx`) and `AddCredentialForm`; `/settings/credentials?credential=<name>`.
  - I5: the `plugin_not_loaded` human notice (`agent-runtime.ts`), which never notifies.
  - I7: `agents.manageOrg` (CHECK `agents_manage_org_persistent`) and `AgentSummary.manageOrg`; `patchAgentBodySchema.manageOrg`; `AgentService.create(b, actor)` → `createLocked`; `OrgRefusedError("Only a human can grant manage_org.")` in `update`; `createAgentToolSchema` without `manage_org`; the "Can manage the org" `Switch` with `MANAGE_ORG_HELP` in `features/agents/edit-agent-sheet.tsx`; `Actor`; the `org_action` WS frame handled in `routes/_app.tsx`.
  If a name still differs in the code, use the implemented name and note it in the PR body. Don't add an adapter.
- **Copy is verbatim from the spec** (§4.3, §5.1, §6.4, §6.5, §6.7, §6.8, §7.1, §7.6). Copy it, don't paraphrase. Counts use `Intl.PluralRules` / `Intl.NumberFormat` (a `plural(n, one, other)` helper is enough).
- **Notifications never carry message text** (Q8): titles are who, bodies are facts. No preview, no body excerpt, no tool output.
- **Git trust boundary (PR 4).** Agents can write granted repos, including `.git/config`, hooks and worktree metadata. Every git call goes through `spawning/git.ts` with the exact flags and env of Task 4.1; paths, ids and branch names from git or the repo are untrusted data used only to match.
- **No real Claude.** Tests and evidence use fake Claude (`packages/harness/testing/fake-claude.mjs` and the U4 harness's `fake.mjs`). Never read `~/.open-factory-spike` or the real `~/.claude`.
- **Database tests.** Server tests need Postgres (`DATABASE_URL`). Get a database only through `makeTestApp` or `createTestDb` (`apps/server/src/test/helpers.ts`), never migrate your own. Where the local Postgres role is unavailable, run the pure, git and web tests you touched and read CI for the DB suites. Name new DB-only test files `*.db.test.ts`. AGENTS.md testing standards apply (behaviour, not implementation; no existence-only tests).
- **Implementer model.** Each task names one: Haiku for narrow, well-specified edits and test generation; Sonnet where the task needs judgement (transactions and locks, security, React state). Fix rounds use the task's model; reviewers use the dev's model.
- **Tests per task, full suite per PR.** Each implementer and reviewer runs only the test files it created or changed (`pnpm vitest run <files>` or `pnpm test:related <sources>`); `pnpm typecheck` when an exported symbol is renamed or deleted. The full suite, typecheck, lint and build run once at the end of each PR; CI is the full check.
- **React.** Every task that touches `apps/web` says "Implementer and reviewer invoke `vercel-react-best-practices` and follow it." This is React + Vite + TanStack Router/Query: Next-only and server-component rules don't apply (say so). Each PR's final review checks the React diff against the skill.
- **I4 form rules.** `FieldShell` / `FieldNote`, `useFieldErrors`, `FormOutcome`, `field-stack`; client messages in `MSG` / `FIELD_MSG` / `FORM_MSG`, at most 40 characters.
- **DESIGN.md.** Type in rem; mono only for identifiers and code; status changes don't animate; toasts only when the outcome is off screen.
- **No heavy-job lock** (Or, 2026-11-23). Browser evidence still runs through the U4 harness's `run.sh`, which has its own lock.
- **Supply chain.** Exact pins, the pnpm minimum release age and `--frozen-lockfile` stay; the lockfile doesn't change.
- **Git.** Merge, never rebase. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never merge a PR.

## Branches

All work happens in `/Users/orlevi/projects/open-factory/.worktrees/spec-i8`. `spec/i8-quality-of-life` already contains `origin/i7/3-restart` (the I7 head, with I1–I6).

- **PR 1, `i8/1-first-run`:** from `spec/i8-quality-of-life`.
- **PR 2, `i8/2-notifications`:** from `spec/i8-quality-of-life` (independent of PR 1).
- **PR 3, `i8/3-loop-guard`:** from `i8/2-notifications`.
- **PR 4, `i8/4-spawn-cleanup`:** from `i8/3-loop-guard`.

```bash
cd /Users/orlevi/projects/open-factory/.worktrees/spec-i8
git fetch origin
git checkout spec/i8-quality-of-life && git merge --no-edit origin/i7/3-restart   # picks up I7 fixes since 2026-11-25
git checkout -b i8/1-first-run          # later: git checkout spec/i8-quality-of-life && git checkout -b i8/2-notifications
```

Before each push, merge the base again (never rebase). PR 1 and PR 2 target `i7/3-restart`, PR 3 targets `i8/2-notifications`, PR 4 targets `i8/3-loop-guard`; each body says it must be retargeted after its base merges. Each PR opens **ready for review** once its whole-PR review is fixed and CI is green (a draft until then).

**Commands:** one file `pnpm vitest run <path>`; `pnpm test:related <file>…`; end of PR: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`; migrations `pnpm db:generate`.

## File map

| File | Purpose | PR |
|---|---|---|
| `packages/shared/src/setup.ts` (new) | `setupStatusSchema`, `SetupStatus` | 1 |
| `apps/server/src/routes/setup.ts` (new) + `app.ts` | `GET /api/setup` | 1 |
| `packages/shared/src/agents.ts` | `createAgentBodySchema.manageOrg?` | 1 |
| `apps/server/src/agents/agent-service.ts` | `create` accepts `manageOrg` from a human actor only | 1 |
| `apps/web/src/features/setup/` (new: `api.ts`, `setup-steps.tsx`, `use-setup-visible.ts`) | the query, the block | 1 |
| `apps/web/src/features/settings/forms/add-credential-form.tsx`, `features/templates/new-template-form.tsx` | invalidate `["setup"]` on create | 1 |
| `apps/web/src/routes/_app/inbox.tsx`, `features/inbox/inbox-list.tsx`, `inbox-pane.tsx` | where the block renders | 1, 3 |
| `apps/web/src/features/agents/new-agent-sheet.tsx`, `edit-agent-sheet.tsx`, `agent-form-state.ts`, `manage-org-help.ts` (new) | the switch in New agent, the help lead | 1 |
| `apps/web/src/features/inbox/notifications.ts` (rewrite) + `notification-copy.ts` (new) | sources, bursts, tags, copy | 2 |
| `packages/shared/src/inbox.ts` | `chatRowSchema.firstUnreadId` | 2 |
| `packages/shared/src/messaging.ts` | `inboxItemSchema.notice`, `.loopHold`, `.cleanup`; `loop_held` in `messageLookupSchema.state` | 2, 3, 4 |
| `apps/server/src/routes/inbox.ts` | `notify` query; `firstUnreadId` through the chat enrichment | 2 |
| `apps/server/src/agents/event-store.ts` | `firstUnreadId`; `notice` in entries; `loop_held` in rejects; `loopHold` join; public `insertNotice` | 2, 3 |
| `apps/server/src/agents/notices.ts` | `NoticeType` gains `loop_held`, `worktrees_kept` | 3, 4 |
| `packages/db/src/schema/agents.ts`, `factory.ts`, migration 0024 | `loop_holds`, `messages.loop_hold_id`, settings columns | 3 |
| `apps/server/src/messaging/loop-guard.ts` (new) | `LoopGuard` | 3 |
| `apps/server/src/messaging/router.ts`, `tasks/task-service.ts`, `mcp/tools/task-tools.ts`, `scheduling/schedule-store.ts`, `scheduling/scheduler.ts` | call sites | 3 |
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
| 2 ever-had-agent, first paint | 1.1, 1.4 | `routes/setup.db.test.ts`, `inbox-setup.test.tsx` (no empty line first) |
| 3 step targets and done rules | 1.1, 1.3 | same |
| 4 switch in New/Edit with help | 1.2, 1.5 | `agents.test.ts` (DB), `new-agent-sheet.test.tsx` |
| 5 chat burst, silent replace, click | 2.2, 2.3 | `notifications.test.tsx`, evidence `i8_c10` |
| 6 never text; never task/other facts | 2.2 | `notification-copy.test.ts`, `notifications.test.tsx` |
| 7 mention/error/credential, marks read | 2.2, 2.3 | `notifications.test.tsx` |
| 8 trip, held result, notices, notification | 3.2–3.6, 3.9 | `loop-guard.db.test.ts`, `router.test.ts` (DB), evidence script |
| 9 Resume, inline result, row label | 3.7, 3.9 | `loop-holds.db.test.ts`, `loop-hold-pane.test.tsx`, evidence |
| 10 390px full width | 3.10 | `inbox-route.test.tsx`, evidence `i8_c21` at 390 |
| 11 resets, comments count | 3.2, 3.4 | `loop-guard.db.test.ts` |
| 12 settings | 3.8 | `settings.test.ts`, `settings-factory.test.tsx` |
| 13 CLAUDE.md worktree line | 4.4 | `claude-md.test.ts` snapshot |
| 14 cleanup, branches, notice | 4.2, 4.3, 4.5 | `cleanup.test.ts` (real git), `reaper.test.ts` |
| 15 hardening | 4.1, 4.2 | `git.test.ts`, `cleanup.hardening.test.ts` (real git) |

---

# PR 1: `i8/1-first-run`

Implements spec §4, AC 1–4.

### Task 1.1: `GET /api/setup`

**Implementer:** Haiku.

**Files:**
- Create: `packages/shared/src/setup.ts`, `apps/server/src/routes/setup.ts`
- Modify: `packages/shared/src/index.ts` (export), `apps/server/src/app.ts` (register the route next to `inbox`)
- Test: `apps/server/src/routes/setup.db.test.ts` (DB)

**Interfaces:**
- Produces: `setupStatusSchema = z.object({ hasCredential: z.boolean(), hasTemplate: z.boolean(), hasAgent: z.boolean() })`, `type SetupStatus`; route `GET /api/setup` (human session, the `requireUser` onRequest hook from `auth/require-user.ts`, as `routes/inbox.ts`) → `SetupStatus`.

- [ ] **Step 1: Failing tests** (`makeTestApp`): empty factory → all false; after inserting a credential row → `hasCredential`; a `templates` row with `issues` non-empty → `hasTemplate` true (valid or not, Q12); one agent row with `archivedAt` set → `hasAgent` true; a terminated ephemeral row only → `hasAgent` true; no session → 401.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/routes/setup.db.test.ts` — expect FAIL (route missing); without local Postgres, read CI.
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

**Implementer:** Haiku.

**Files:**
- Modify: `packages/shared/src/agents.ts` (`createAgentBodySchema` gains `manageOrg: z.boolean().optional()`), `apps/server/src/agents/agent-service.ts` (`create` refuses it from an agent before the lock; `createLocked` inserts it), `apps/server/src/routes/agents.ts` (the body passes through as is; check). `create_agent` (`mcp/tools/org-tools.ts`) builds its own body from `createAgentToolSchema`, which has no `manage_org`: unchanged.
- Test: `packages/shared/src/agents.test.ts`, `apps/server/src/routes/agents.test.ts` (DB), `apps/server/src/agents/agent-service.org.db.test.ts`

**Interfaces:**
- Consumes: I7 `Actor`, `OrgRefusedError`, `agents.manageOrg`, the CHECK `agents_manage_org_persistent`.
- Produces: `CreateAgentBody.manageOrg?: boolean`.

- [ ] **Step 1: Failing tests:** `createAgentBodySchema.parse({...valid, manageOrg: true}).manageOrg === true`, and `manageOrg: "yes"` refused (this **replaces** "create body strips manageOrg instead of accepting it", `agents.test.ts:89`; delete it, no compat); `POST /api/agents` with `manageOrg: true` from a human creates the agent with `manageOrg` true (summary and row); `AgentService.create({...,manageOrg:true}, agentActor)` → `OrgRefusedError("Only a human can grant manage_org.")` (I7's sentence verbatim) and no row, no workspace. `create_agent` refusing it is already tested (`org-tools.test.ts:17`).
- [ ] **Step 2: Run** the shared test — FAIL.
- [ ] **Step 3: Implement.** In `create`, before the lock: `if (b.manageOrg && actor.kind === "agent") throw new OrgRefusedError("Only a human can grant manage_org.")` (the same test `update` uses at `agent-service.ts:683`); in `createLocked`'s insert, `manageOrg: b.manageOrg ?? false`.
- [ ] **Step 4: Run** shared test PASS; typecheck.
- [ ] **Step 5: Commit** `feat(server): humans can grant manage_org when creating an agent`.

### Task 1.3: The setup query and its invalidations

Implementer and reviewer invoke `vercel-react-best-practices` and follow it. **Implementer:** Haiku.

Revalidated: no sheet-store change. Step 1 of the block opens Add credential with the existing `openSheetForResult({ kind: "add-credential" }, () => {})` (`sheet-store.ts:84`): with no sheet open it is the parent layer and serves itself through `completeChild` (closes, then `onDone`), rendered by the same `AddCredentialSheet` (`setup-sheets.tsx`), which already writes the credentials list into the cache.

**Files:**
- Create: `apps/web/src/features/setup/api.ts`
- Modify: `features/settings/forms/add-credential-form.tsx` (where it reports success, before `onDone`: `invalidateQueries({ queryKey: ["setup"] })`, so Settings, the sheet and New agent's inline setup all count), `features/templates/new-template-form.tsx` (after `createTemplate` succeeds), `features/agents/new-agent-sheet.tsx` (`create`, next to `invalidateQueries({ queryKey: ["agents"] })`: `qc.setQueryData(["setup"], (d) => d && { ...d, hasAgent: true })`), `routes/_app.tsx` (the `org_action` branch of `onMessage` invalidates `["setup"]`)
- Test: `apps/web/src/features/setup/api.test.ts`, the existing `add-credential-form.test.tsx` and `new-agent-sheet.test.tsx`

**Interfaces:**
- Produces: `setupQueryOptions = queryOptions({ queryKey: ["setup"], queryFn: () => api.get("/api/setup", setupStatusSchema), staleTime: (q) => (q.state.data?.hasAgent ? Infinity : 30_000), refetchOnWindowFocus: true })` (once an agent exists the answer never changes back, Q11); `useSetup()`.

- [ ] **Step 1: Failing tests:** creating a credential (through the form), a template or an agent leaves `["setup"]` stale and a mounted reader refetches; creating an agent flips a cached `hasAgent` to true without a request; an `org_action` frame refetches a mounted `["setup"]`; `openSheetForResult({kind:"add-credential"})` with no sheet open renders Add credential and, on submit, closes and returns focus to the opener (a test in `sheet-host.test.tsx` if none covers the self-serving layer yet).
- [ ] **Step 2: Run** the touched test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** PASS.
- [ ] **Step 5: Commit** `feat(web): the setup query and what refreshes it`.

### Task 1.4: The setup steps block and where it renders

Implementer and reviewer invoke `vercel-react-best-practices` and follow it. **Implementer:** Sonnet (deferred-leave state, focus).

**Files:**
- Create: `apps/web/src/features/setup/setup-steps.tsx`, `apps/web/src/features/setup/use-setup-visible.ts`
- Modify: `apps/web/src/routes/_app/inbox.tsx` (loader fetches both in parallel: `await Promise.all([context.queryClient.ensureInfiniteQueryData(inboxQueryOptions).catch(noop), context.queryClient.ensureQueryData(setupQueryOptions).catch(noop)])`), `apps/web/src/features/inbox/inbox-list.tsx` (L233, `if (rows.length === 0) return <EmptyState text="Nothing in your inbox." />`: the empty line is held while setup is pending; below 1024 the block renders at the top of the list and the empty line is omitted while `hasAgent` is false), `apps/web/src/features/inbox/inbox-pane.tsx` (`InboxPane`, L596: with nothing selected and `hasAgent` false, the pane renders `<SetupSteps/>` max-w-[40rem] instead of "No item selected.")
- Test: `apps/web/src/features/setup/setup-steps.test.tsx`, `apps/web/src/test/inbox-setup.test.tsx` (new), update the "No item selected." cases in `apps/web/src/test/inbox-pane.test.tsx` and `apps/web/src/features/inbox/inbox-pane.test.tsx`, and `inbox-list.test.tsx`'s empty case

**Interfaces:**
- Consumes: `useSetup()`, `openSheet` from the sheet store.
- Produces: `<SetupSteps status={SetupStatus} />`; `useSetupVisible(hasAgent: boolean | undefined): { shown: boolean; listProps: { onPointerEnter; onPointerLeave; onFocusCapture; onBlurCapture }; blockProps: { onFocusCapture; onBlurCapture } }` (`features/setup/use-setup-visible.ts`), called **once** in `InboxPage` and passed to `InboxList` and `InboxPane`.

`useSetupVisible` (spec §4.2, React review M2, option A): pointer-in-list and focus-in-list are **refs**; the only state is `held: boolean`. `shown` is adjusted **during render** (the `useRested` pattern): when `hasAgent` becomes true and neither the pointer is over the list column nor focus is inside the list column, `shown` turns false in the same render; otherwise `held` is set and the pointer-leave / blur handlers clear it. Focus inside the block itself does **not** hold it. A `focusInside` ref is set by the block's focus handlers; a `useLayoutEffect` keyed on `shown` moves focus to the first Inbox row, or to the page `h1` when the Inbox is empty, when `shown` went false with `focusInside` set. No effect mirrors the query into state.

Spec §4.2–4.3 copy and layout verbatim:
- `<section aria-labelledby="setup-h">`, `<h2 id="setup-h">` "Set up your factory" in the State heading role (Archivo `text-[1rem] leading-[1.25rem] font-semibold`).
- `<ol>` of three `<li><button>` rows, `min-h-14`, marker `size-5` ring with the number in Geist `text-[0.8125rem] tabular-nums text-muted-foreground`, or `<Check aria-hidden>` in the success token when done; title `text-[0.875rem] font-medium`; description `text-[0.8125rem] text-muted-foreground` wrapping (no `truncate`); trailing `ChevronRight` muted. Hover/press/inset focus classes copied from DESIGN Rows (no scale). Accessible name "Step 1 of 3, Sign in to Claude, done|not done"; description via `aria-describedby`.
- Steps: 1 "Sign in to Claude" / "Connect the Claude account your agents run on." → `openSheetForResult({kind:"add-credential"}, () => {})`, done = `hasCredential`; 2 "Create a template" / "A template is a role: persona, skills, tools and model." → `openSheet({kind:"new-template", then:"open-editor"})`, done = `hasTemplate`; 3 "Create an agent" / "It runs a template in its own session. Give it \"Can manage the org\" to have it build the rest." → `openSheet({kind:"new-agent"})`, never done.

- [ ] **Step 1: Failing tests:**
  - block: three rows in order with exact copy; done rows show the check and stay enabled; each click opens its sheet kind; accessible names; no `truncate` class on descriptions.
  - inbox (wide, `matchMedia` mocked ≥1024): with `hasAgent` false and nothing selected the pane shows the block and the list shows "Nothing in your inbox."; selecting an item shows the item; clearing returns the block.
  - inbox (narrow): the block is at the top of the list; with no items there is no "Nothing in your inbox."; with an item it follows below.
  - first paint: render with the inbox query resolved and setup pending → neither the empty line nor the block; then setup resolves → block (assert "Nothing in your inbox." never appeared: spy on the text across renders).
  - leaving, through the real paths (an `org_action` frame invalidating `["setup"]`, and a window-focus refetch, with the API mock flipping `hasAgent`): the block unmounts in that render when the pointer is outside the list column; with the pointer over the list column (or focus inside the list column) it stays until pointer leave / blur; focus on a step row does **not** hold it, and when it unmounts with focus inside, focus lands on the first inbox row (or the `h1` when empty) in a layout effect (no frame with focus on `body`).
  - no horizontal overflow class combos (`min-w-0` on text column).
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/setup apps/web/src/test/inbox-setup.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** `InboxPage` calls `useSetupVisible(hasAgent)` once and passes `shown` down. `InboxPage`, `InboxList` and `InboxPane` read only `useQuery({ ...setupQueryOptions, select: (s) => s.hasAgent })` (rerender-derived-state, m2); only `SetupSteps` reads the whole status.
  - The three step specs are **module constants** (rendering-hoist-jsx, m3), each with its sheet spec and a module-level intent, as `features/agents/agent-menu.tsx:24` does (`sheetIntent` from `features/sheets/sheet-bodies.ts:172`):

```ts
const noop = () => {};
const STEPS = [
  { title: "Sign in to Claude", desc: "Connect the Claude account your agents run on.",
    open: () => openSheetForResult({ kind: "add-credential" }, noop), intent: sheetIntent("add-credential", { kind: "add-credential" }), done: (s: SetupStatus) => s.hasCredential },
  { title: "Create a template", desc: "A template is a role: persona, skills, tools and model.",
    open: () => openSheet({ kind: "new-template", then: "open-editor" }), intent: sheetIntent("new-template", { kind: "new-template", then: "open-editor" }), done: (s: SetupStatus) => s.hasTemplate },
  { title: "Create an agent", desc: "It runs a template in its own session. Give it \"Can manage the org\" to have it build the rest.",
    open: () => openSheet({ kind: "new-agent" }), intent: sheetIntent("new-agent", { kind: "new-agent" }), done: () => false },
] as const;
```

    Each row spreads `{...step.intent}` so hover and focus warm the sheet chunk and its lists (credentials, templates, agents) (bundle-preload, m3).
- [ ] **Step 4: Run** PASS; the existing "No item selected." / "Nothing in your inbox." tests updated to answer `GET /api/setup` with `hasAgent: true` in their API mock.
- [ ] **Step 5: Commit** `feat(web): first-run steps on the Inbox`.

### Task 1.5: "Can manage the org" in New agent, and its help lead

Implementer and reviewer invoke `vercel-react-best-practices` and follow it. **Implementer:** Haiku.

**Files:**
- Create: `apps/web/src/features/agents/manage-org-help.ts` (`MANAGE_ORG_HELP` moves here from `edit-agent-sheet.tsx:68`, with the lead sentence prepended)
- Modify: `apps/web/src/features/agents/new-agent-sheet.tsx` (the same `FieldShell` + `Switch` block as `edit-agent-sheet.tsx:495`, after the `ProjectGrantPicker`; New agent only creates persistent agents), `apps/web/src/features/agents/edit-agent-sheet.tsx` (imports the constant), `apps/web/src/features/agents/agent-form-state.ts` (`body()`'s create branch adds `...(shown.manageOrg ? { manageOrg: true } : {})`; `blank()` already defaults it to false)
- Test: `apps/web/src/features/agents/new-agent-sheet.test.tsx`, `edit-agent-sheet.test.tsx` (its `MANAGE_HELP` copy at L857 gains the lead), `agent-form-state.test.ts`

- [ ] **Step 1: Failing tests:** New agent shows the "Can manage the org" switch, off; its accessible description is "Lets this agent create and arrange other agents: ask it in Chat to build the rest of your team." followed by I7's text verbatim; submitting with it on posts `manageOrg: true`, with it off posts no `manageOrg`; Edit agent's description has the same lead.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** PASS.
- [ ] **Step 5: Commit** `feat(web): Can manage the org at creation, with what to do with it`.

### Task 1.6: DESIGN.md, product docs, evidence

- [ ] **Step 1: DESIGN.md** Empty states amendment, spec §4.6, verbatim. Commit `docs(design): first-run steps are the empty Inbox's exception`.
- [ ] **Step 2: Product docs** (main checkout `/Users/orlevi/projects/open-factory/docs/product/`, gitignored): `behavior/inbox.md` (first-run steps: when, where, the three steps), `behavior/administration.md` (setup starts on the Inbox; Can manage the org at creation). List them in the PR body.
**Implementer:** Haiku (docs), the dev itself for the evidence.

- [ ] **Step 3: Evidence** (fake Claude only, through the harness's `run.sh` and its lock). Write `docs/product/ui-review/i8-evidence/checks/i8_c01_first_run.py` (main checkout) on the U4 harness with `U4_SEED=empty`: the steps at 1440 (in the pane) and 390 (in the list), light and dark, 1440 at 200% text, 320; no page overflow (`u4lib.page_overflow`); open each sheet; create a credential (fake), a template and an agent; the checks turn on and the block leaves. `REPO=<snapshot> PR=i8-pr1 ./run.sh …`. Results JSON and shots under `i8-evidence/pr1/`.

### Task 1.7: PR 1 review, verification, push, PR, CI

**Done by the dev** (as Tasks 2.4, 3.11 and 4.6): reviewers on the dev's model.

- [ ] **Step 1: Whole-PR review.** A fresh read-only reviewer on `git diff spec/i8-quality-of-life...i8/1-first-run` checks spec §4 and AC 1–4, copy verbatim, ADR 0028 (I7's "refuses manageOrg" test replaced, not kept), and **the React diff against `vercel-react-best-practices`** (the reviewer invokes the skill first; Next-only rules skipped and said so): no effect that mirrors query data into state, no component defined inside a component, stable query keys, the `/inbox` loader fetches inbox and setup in parallel (`Promise.all`), `useSetupVisible` keeps pointer/focus in refs and adjusts `shown` during render, focus moves done in a layout effect keyed on `shown`. Fix findings as their own commits.
- [ ] **Step 2: Full verification** (once per PR, no lock): `pnpm install --frozen-lockfile` (no lockfile change), `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`; the dev loop from a clean clone (clone to a temp dir, install, build, `pnpm dev` with a throwaway DB and fake Claude, load the Inbox, shut down, delete the clone).
- [ ] **Step 3: Push and PR.** Merge the base again, push `i8/1-first-run`, `gh pr create --draft --base i7/3-restart`, then `gh pr ready` once CI is green and the review is fixed; title `feat(web): first-run steps on the Inbox`, body per `.github/pull_request_template.md` (What, Why, Approach bullets "<decision>, rather than <alternative>, because <reason>", Changes), links to the spec, this plan and #169, "Closes #102" only if every #102 bullet it covers is the first-run one (else "Part of #102"), docs updated, retarget after the base merges; template comments removed; ends with the attribution line. `gh pr checks --watch` until green, fixing on the branch. Never merge.

---

# PR 2: `i8/2-notifications`

Implements spec §5, AC 5–7. Cut from `spec/i8-quality-of-life` (not from PR 1).

### Task 2.1: `firstUnreadId` on chat rows; `notice` on @factory items; the notify query

**Implementer:** Sonnet (SQL in the inbox read).

The chats/items split is already on the base (`inboxPage` filters `ne(messages.kind, "message")`; `unreadChats` inner-joins `from_agent_id`); no change and no new test for it.

**Files:**
- Modify: `packages/shared/src/inbox.ts` (`chatRowSchema.firstUnreadId: z.string()`), `packages/shared/src/messaging.ts` (`inboxItemSchema.notice: z.string().optional()`), `apps/server/src/agents/event-store.ts` (`unreadChats`: per agent the oldest unread `message` item's message id, a second `selectDistinctOn` ordered ascending, next to the existing newest one; `toEntries`: `notice: r.m.notice` for `kind = 'system'` rows; `inboxPage` gains `o.notify`: unread only, items whose `inbox_items.kind` is `mention` or `credential`, or whose message is `kind = 'system'` with `notice in ('agent_errored','loop_held')`, newest first, limit 200), `apps/server/src/routes/inbox.ts` (`inboxQuerySchema.notify: z.enum(["true","false"]).optional()`; with `notify` the route passes limit 200 regardless of `limit`; the chat enrichment, L44-63, carries `firstUnreadId`)
- Test: `apps/server/src/routes/inbox.test.ts` (DB)

- [ ] **Step 1: Failing tests:** `GET /api/inbox?unread=true&notify=true` returns all chats and every unread `mention`, `agent_errored`, `credential` and `loop_held` item, and no `task_event` or `plugin_not_loaded` item, newest first, capped at 200 (seed 201); three unread messages from @ada → `chats[0].firstUnreadId` is the oldest; read the first → it becomes the second; an `agent_errored` notice's item has `notice: "agent_errored"`.
- [ ] **Step 2–4:** run, implement, typecheck.
- [ ] **Step 5: Commit** `feat(server): chat rows carry their first unread message; @factory items carry their notice`.

### Task 2.2: Notification sources, copy and bursts (pure)

Implementer and reviewer invoke `vercel-react-best-practices` and follow it. **Implementer:** Haiku (pure function, fully specified).

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

Rules (spec §5.1): chat → title display name (as the chat row shows it), body `plural(unread, "1 new message", "N new messages")`, open `/agents/$slug/chat?message=firstUnreadId`; `mention` items grouped by `task.key` → title first mentioner's `@handle`, or the task key when several handles, body "Mentioned you on T-42" / "N mentions on T-42", open `/tasks/$key?comment=<first unread commentId>`; items with `notice === "agent_errored"` grouped by `about` → title `@dev`, body "Hit an error", open `/agents/$slug/session`; `kind === "credential"` → title `Credential "work"`, body "Expires Dec 3" / "Expired Dec 3" from `expiresAt` (`Intl.DateTimeFormat(undefined, {month:"short", day:"numeric"})`, past → "Expired"), open `/settings/credentials?credential=work`; `notice === "loop_held"` (PR 3 fills `loopHold`; until then this branch is unit-tested with a fixture) → title `@a and @b`, body "Messages between them are held", open `/inbox?item=<id>`, `resolved` when `loopHold.resumedAt`. Everything else (task_event, other notices, I5's `plugin_not_loaded`, `worktrees_kept`) yields no burst. Unread only.

Formatters are created once at module level (js-cache-function-results, m5): `const PLURAL = new Intl.PluralRules("en")`, `const NUM = new Intl.NumberFormat()`, `const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })`; never per call.

- [ ] **Step 1: Failing tests:** each source's title, body and open target; a 60-char handle is middle-truncated to 40 and a display name end-truncated; plurals at 1 and 2; **no test fixture's message preview or body text appears in any title or body** (assert with fixtures whose preview is a unique marker string); `task_event`, `factory_restarted`, `crash_recovered`, `plugin_not_loaded`, `worktrees_kept` produce nothing; tags change after the first unread changes.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/inbox/notification-copy.test.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** PASS.
- [ ] **Step 5: Commit** `feat(web): notification copy and bursts without message text`.

### Task 2.3: The notifier: show, replace, close, click

Implementer and reviewer invoke `vercel-react-best-practices` and follow it. **Implementer:** Sonnet (lifecycle, races, React).

**Files:**
- Modify (rewrite the notify half): `apps/web/src/features/inbox/notifications.ts` (keep `useBrowserNotifications`, `BLOCKED_NOTE`; delete `notificationTitle`, `chatNotificationTitle`, `notifyNew` and their tests in `notifications.test.tsx`; `useInboxNotifier` uses `burstsOf` and fetches the notify query instead of `homeInboxQueryOptions`)
- Modify: `apps/web/src/components/app-sidebar.tsx` (the switch hides when `supported` is false, which now includes a throwing constructor)
- `supported` becomes reactive (m6): a module flag `unsupported`, set and `emit()`ed when the constructor throws, read through `useSyncExternalStore` in `useBrowserNotifications` (today the sidebar hides the switch only because `isOn()` happens to change).
- `toggle` in `useBrowserNotifications` is wrapped in `useCallback` (m12; the sidebar row may be memoised).
- Test: `apps/web/src/features/inbox/notifications.test.tsx`

**Interfaces:**
- Produces: `class Notifier { constructor(onOpen: (b: Burst) => void); baseline(bs: Burst[]): void; update(bs: Burst[], visible: boolean): void; closeAll(): void; reset(): void }` (holds `seen: Set<string>` of newest ids and `shown: Map<key, { tag; n: Notification }>`).
- Lifecycle (React review M3, option A): one instance per `AppLayout` (`routes/_app.tsx`): `const [notifier] = useState(() => new Notifier((b) => onOpenRef.current(b)))`, with `onOpenRef.current` updated in an effect (not during render). `reset()` closes every shown notification and clears `seen`/`shown`; it is called on sign-out next to `resetSheets()`. Delete the render-time `notifyRef.current = notify` write in `_app.tsx` (L76-77); the WS handler calls `notifier`-driving `useInboxNotifier`'s stable callback. Tests create a fresh instance each.
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
  - a constructor that throws → `supported` false and a mounted sidebar re-renders without the switch (through `useSyncExternalStore`), no unhandled rejection;
  - `toggle` keeps its identity across renders;
  - click: `window.focus` called, navigates to each source's target, mention/error/credential items marked read (`postRead` called), chats not marked by the click.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** PASS.
- [ ] **Step 5: Commit** `feat(web): one notification per burst, replaced silently, closed when read`.

### Task 2.4: Product docs, evidence, review, PR 2

- [ ] **Step 1: Product docs** (main checkout): `behavior/inbox.md` — which items notify, no text (replace "a 120-character preview"), bursts, the click marks items read (keep that sentence). List in the PR body.
- [ ] **Step 2: Evidence** (harness `run.sh` and its lock, fake Claude): `i8-evidence/checks/i8_c10_notifications.py` — grant notification permission in the Playwright context, stub `Notification` to record (headless can't show OS notifications) while the page is hidden (`page.evaluate` overriding `visibilityState` + dispatching `visibilitychange`), have the fake agent reply three times via `ctl.py`, assert one tag and the final body "3 new messages", invoke the recorded `onclick` and assert the URL is the Chat at the first unread message. Chromium only (WebKit lacks the permission API in headless).
- [ ] **Step 3: Whole-PR review** as in Task 1.7 Step 1, against spec §5 and AC 5–7, plus: no message text reaches `Notification` (grep the diff for `preview` in notification code), I1/I3 notifier lines superseded, **the React diff against `vercel-react-best-practices`** (module-level notifier, no state set in the WS handler, effects only for external sync with cleanup).
- [ ] **Step 4: Full verification** as in Task 1.7 Step 2.
- [ ] **Step 5: Push and PR** (base `i7/3-restart`; ready once green), title `feat(web): desktop notifications only when you're needed, without message text`; body as in Task 1.7 Step 3, stating plainly that the evidence stubs `Notification` and no real OS notification was checked. CI until green. Never merge.

---

# PR 3: `i8/3-loop-guard`

Implements spec §6, AC 8–12. `git checkout -b i8/3-loop-guard i8/2-notifications`.

### Task 3.1: Schema: `loop_held`, `loop_hold_id`, `loop_holds`, settings, index

**Implementer:** Haiku.

**Files:**
- Modify: `packages/db/src/schema/agents.ts` (`messages.loopHoldId: text("loop_hold_id").references(() => loopHolds.id)`; new `loopHolds` table; partial index `session_events_operator_input_idx` on `(agent_id, at) where type = 'operator_input'`), `packages/db/src/schema/factory.ts` (`loopGuardMessages integer not null default 10`, `loopGuardWindowMinutes integer not null default 10`)
- Create: the migration via `pnpm db:generate` (0024 on this base), then hand edits in the same file (the existing hand-written CHECK is 0011's, the index 0009's):

```sql
ALTER TABLE "messages" DROP CONSTRAINT "messages_state_check";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_state_check"
  CHECK (state IN ('pending','delivered','rejected','cancelled','loop_held'));--> statement-breakpoint
DROP INDEX "messages_schedule_pending_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "messages_schedule_pending_idx" ON "messages" ("schedule_id","to_agent_id")
  WHERE state IN ('pending','loop_held') AND schedule_id IS NOT NULL;
```

- Test: `packages/db/src/schema.messages.test.ts` (DB)

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
- [ ] **Step 2:** Generate, hand-edit, run `schema.messages.test.ts` and `migrate.test.ts`.
- [ ] **Step 3: Commit** `feat(db): loop_held messages and loop_holds`.

### Task 3.2: `LoopGuard`

**Implementer:** Sonnet (locks, derived counts).

**Files:**
- Create: `apps/server/src/messaging/loop-guard.ts`
- Test: `apps/server/src/messaging/loop-guard.db.test.ts` (DB) and `loop-guard.test.ts` (pure helpers)

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
     where type = 'operator_input' and agent_id in ($a, $b) and payload->>'byKind' = 'human'),
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

- [ ] **Step 1: Failing tests** (DB; helpers insert two agents and rows with explicit `created_at`): N = 3 for speed via settings —
  - 3 each way → not held; the 4th from A after B already has 4 → held, opened, counts `{ab:4, ba:4}`;
  - 50 one way, 0 back → never held;
  - each reset source (human message to B, human `operator_input` on A, human status event on a task assigned to B) between the rows → not held; an agent's `status` done/reopen events, an agent-authored comment, a human-authored schedule row and an `operator_input` with `byKind: "agent"` → don't reset;
  - an open hold → `opened: false` for either direction;
  - a resumed hold's `resumed_at` is a window start; a reset after the hold opened doesn't release it;
  - task_comment and agent-authored scheduled rows count; human-authored scheduled rows don't;
  - window: rows older than `window` don't count;
  - **concurrency:** two connections each running `lockPairs([{A,B},{A,C}])` / `lockPairs([{A,C},{A,B}])` and inserting → both commit, no deadlock (Postgres `40P01` never seen); two racing sends at the threshold → exactly one opens the hold, the other sees it open.
  - unit: `pairOf` orders; the minutes rounding is ≥ 1.
- [ ] **Step 2–4:** implement; measure `explain analyze` of the window and count statements on the U4 `worst` dataset (214 agents) and paste the plans in the PR body; add an index only if a sequential scan on `messages` shows up for the scheduled branch.
- [ ] **Step 5: Commit** `feat(server): the loop guard derives pair counts under sorted advisory locks`.

### Task 3.3: Router list send holds per recipient

**Implementer:** Sonnet.

**Files:**
- Modify: `apps/server/src/messaging/router.ts` (`send`: for an agent sender, collect agent recipients, `loopGuard.lockPairs` once at the start of the `store.transaction` that inserts, `check` per agent recipient before its `createMessage`; a held row is inserted with `state: "loop_held"`, `loopHoldId` and is not handed over (it skips the `agentRows` hand-off); `RecipientResult` gains `{ to; kind: "agent"; status: "held"; id; note }`; `repeated()` maps a `loop_held` row to `held` with the later-row note), `apps/server/src/agents/event-store.ts` (`createMessage` accepts `state?: "pending" | "loop_held"` and `loopHoldId?`), `packages/shared/src/messaging.ts` (`messageLookupSchema.state` gains `"loop_held"`), `apps/server/src/mcp/tools/send-message.ts` (result type), `apps/server/src/app.ts` (construct `LoopGuard` before the Router, L327; inject into Router, TaskService, Scheduler). The spawn brief (`spawn-service.ts:309`) is not checked (spec §6.3).
- Test: `apps/server/src/messaging/router.test.ts` (DB)

- [ ] **Step 1: Failing tests:** after the threshold, `send(A, ["@b","@orlevi"])` returns `@b` `status: "held"` with the tripping note verbatim and `@orlevi` `status: "inbox"`; the held row is not in B's queue (`runtimes.deliver` not called for it); a later send in either direction gets the later-row note verbatim; a human sender is never checked; a list send to B and C where only A↔B is held holds only B.
- [ ] **Step 2–4:** implement; notes from one module `loopNotes` (`apps/server/src/messaging/loop-guard.ts`): `tripping(to, total, minutes)` and `later(to)` with `plural`.
- [ ] **Step 5: Commit** `feat(server): send_message holds a looping pair`.

### Task 3.4: Task comments and scheduled firings

**Implementer:** Sonnet.

**Files:**
- Modify: `apps/server/src/tasks/task-service.ts` (`write()` ~L790: when `p.kind === "task_comment"` and `p.from` is an agent, lock all agent recipients' pairs first, then `check` per recipient; held rows created via `createTaskMessage(tx, {..., state: "loop_held", loopHoldId})` and not pushed to `agentRows`; collect `held: [{ to, note }]` into the outcome; `comment()`'s `CommentResult` gains `held`. `comment` runs under `withDeadlockRetry`: a retried transaction re-locks and re-checks, which is correct since nothing is kept outside it), `apps/server/src/agents/event-store.ts` (`createTaskMessage` accepts `state`/`loopHoldId`), `apps/server/src/mcp/tools/task-tools.ts` (`comment_task`'s result adds `held` next to `not_reached`), `apps/server/src/scheduling/schedule-store.ts` (`upsertFiring`: the pending lookup matches `state in ('pending','loop_held')`; a matched `loop_held` row is updated in place and the function returns `undefined` (never handed over); the insert path takes `{ held?: { holdId } }` and inserts `state: "loop_held"`; `records()`: `pendingFiring` true for either state), `apps/server/src/scheduling/scheduler.ts` (`fireOnce`: when the schedule's body author is an agent and the target is another agent, after `lockAgents` and `lockForFiring`: `lockPairs([pairOf(author, target)])`, then `check` only on the insert path, i.e. when no open row exists; split `upsertFiring` into a lookup and an insert, or let it take a callback, so the check sits between them)
- Test: `apps/server/src/tasks/task-service.comment.test.ts`, `apps/server/src/scheduling/scheduler.test.ts` (DB)

- [ ] **Step 1: Failing tests:** an agent comment that mentions B after the pair tripped is posted (comment row exists, visible on the task) and B's row is `loop_held`; `comment_task` returns `held: [{to:"@b", note}]`; a human comment is never checked; an agent-authored schedule firing into B after the trip is inserted `loop_held`; a second firing while held updates that row in place (firings + missed) and nothing is handed over; a firing row already `pending` when the hold opened is still delivered (upsert path, no check); a human-authored schedule is never checked.
- [ ] **Step 2–4:** implement. **Step 5: Commit** `feat(server): task comments and agent schedules count toward the loop guard`.

### Task 3.5: Notices on open; ended agents

**Implementer:** Sonnet.

`operator_input.byKind` already exists (I1); nothing to add for it.

**Files:**
- Modify: `apps/server/src/messaging/loop-guard.ts` (`LoopNotices.onOpened(tx, hold, a, b, counts)`), `apps/server/src/agents/notices.ts` (`NoticeType` gains `"loop_held"`), `apps/server/src/agents/event-store.ts` (`createHumanMessage` accepts `loopHoldId`; `insertNotice(m, tx)` becomes public (it is the always-insert half of `createNotice`); `rejectPending` and `rejectPendingToTerminated` match `state in ('pending','loop_held')`; `rejectPending` is also called from `AgentRuntime.init` for a terminated agent, where matching held rows is equally right)
- Test: `loop-guard.db.test.ts`, `apps/server/src/spawning/terminate-service.test.ts` (DB)

Notices (spec §6.4 copy verbatim; `@a` = sender of the tripping row):
- humans: `createHumanMessage({ kind: "system", fromAgentId: null, notice: "loop_held", subjectAgentId: A, loopHoldId, to: "all", body: "@a and @b exchanged 22 messages in 3 minutes; further messages between them are held.", urgent: false }, tx)`;
- managers: for `new Set([A.reportsTo, B.reportsTo])` minus null, minus A and B, minus archived/terminated: `store.insertNotice({ toAgentId: manager, notice: "loop_held", subjectAgentId: A, body }, tx)`, a new row each time (not `createNotice`: it isn't transaction-aware and would overwrite a pending `loop_held` notice about A from another hold), no `loopHoldId`, body "@a and @b exchanged 22 messages in 3 minutes with no human in between. Messages between them are held until a human resumes them in the Inbox.";
- after commit: `bus.publishAll({ type: "inbox_changed" })`; the manager rows handed over with `router.handOffHeldRows`-style hand-off (look up as `PendingRow`, deliver as other `@factory` notices are).

- [ ] **Step 1: Failing tests:** opening a hold writes exactly one human notice with `loop_hold_id` and one inbox item per user; a manager who is B gets nothing; a shared manager gets one; an archived manager gets nothing; two holds involving A in a row give A's manager two notices; terminating B rejects its `loop_held` rows; archiving B leaves them `loop_held`; `rejectPendingToTerminated` at boot rejects `loop_held` rows to terminated agents; boot's wake rebuild ignores `loop_held` rows.
- [ ] **Step 2–4:** implement. **Step 5: Commit** `feat(server): loop hold notices; held rows follow termination`.

### Task 3.6: CLAUDE.md held line; outgoing card

Implementer and reviewer invoke `vercel-react-best-practices` and follow it (the outgoing card). **Implementer:** Haiku.

**Files:**
- Modify: `apps/server/src/workspace/claude-md.ts` (the `## Messaging` section, L153: spec §6.5 sentence verbatim), `apps/web/src/features/session/outgoing-message.tsx` (status `held` renders like pending: muted line "Held by the loop guard: @b", handle in mono; checked **before** the `if (r.note)` branch at ~L233, since a held result carries a note written for the agent)
- Test: `apps/server/src/workspace/claude-md.test.ts` (snapshot), `outgoing-message.test.tsx`

- [ ] **Step 1–4:** failing snapshot and card test; implement; pass. **Step 5: Commit** `feat: agents learn what held means; the outgoing card shows it`.

### Task 3.7: Resume

**Implementer:** Sonnet.

**Files:**
- Create: `apps/server/src/routes/loop-holds.ts`, `apps/server/src/messaging/loop-resume.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/agents/event-store.ts` (inbox `toEntries`: for `notice = 'loop_held'` rows with `loop_hold_id`, join `loop_holds`, both agents' slug and live status, `waiting` = count of `loop_held` rows with that id, `sentOn` = count of rows with that id whose state is neither `loop_held` nor `rejected`, `resumedBy` = `'@' || users.handle`), `packages/shared/src/messaging.ts` (`loopHold` per spec §6.4; `resumeLoopHoldResponseSchema = z.object({ sentOn: z.number().int() })`, 409 body `{ resumedBy: string, resumedAt: string }`)
- Test: `apps/server/src/routes/loop-holds.db.test.ts` (DB)

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
// after commit: rows sorted by createdAt → hand-off through the Router (send's agent path, or handOffHeldRows /
// handOffTaskRows for comment rows; scheduled rows as Scheduler.handOff does); publishAll inbox_changed
```

- [ ] **Step 1: Failing tests:** the inbox entry's `loopHold.sentOn` = count of rows with that `loop_hold_id` whose state is neither `loop_held` nor `rejected` (0 before Resume, n after, unchanged by a remount); Resume flips every held row to pending, hands them off in `created_at` order, returns `{ sentOn: n }`, sets `resumed_at`/`resumed_by`; a second Resume → 409 with `resumedBy: "@or"`; unknown id → 404; no session → 401; the window restarts at `resumed_at` (N more each way before a new hold); **race:** a send paused (test hook) between `check` (saw the hold open) and its insert while Resume runs → Resume waits on the pair lock, the send commits its held row, Resume then flips it too (no `loop_held` row left on a closed hold); a hold whose rows were all rejected resumes with `sentOn: 0`; the inbox entry's `loopHold` has `waiting`, `sentOn`, both statuses and `resumedBy`.
- [ ] **Step 2–4:** implement. **Step 5: Commit** `feat(server): humans resume a held pair`.

### Task 3.8: The two settings

Implementer and reviewer invoke `vercel-react-best-practices` and follow it. **Implementer:** Haiku.

**Files:**
- Modify: `packages/shared/src/settings.ts` (`FACTORY_BOUNDS.loopGuardMessages: [2, 1000]`, `loopGuardWindowMinutes: [1, 1440]`; both in `factorySettingsSchema` and `patchFactorySettingsSchema`), `apps/server/src/settings/factory-settings.ts` (values, getters `loopGuardMessages()`, `loopGuardWindowMs()` beside `memberUpdateDebounceMs`, L54), `apps/server/src/routes/settings.ts`, `apps/web/src/features/settings/factory-section.tsx` (labels in the `Field` map at L55; two `numberField`s after `memberUpdateDebounceSeconds` at L210; labels, suffixes and hints verbatim from spec §6.8)
- Test: `packages/shared/src/settings.test.ts`, `apps/server/src/routes/settings-routes.test.ts` (DB), `apps/web/src/test/settings-factory.test.tsx`

- [ ] **Step 1: Failing tests:** bounds reject 1 and 1001 / 0 and 1441 with the shared sentence; PATCH updates and the guard reads the new value on the next check (no restart); the form shows "Loop guard limit" with suffix "messages" and its hint, "Loop guard window" with "min" and its hint.
- [ ] **Step 2–4:** implement. **Step 5: Commit** `feat: loop guard limit and window in Settings → Factory`.

### Task 3.9: The hold row and pane

Implementer and reviewer invoke `vercel-react-best-practices` and follow it. **Implementer:** Sonnet.

**Files:**
- Create: `apps/web/src/features/inbox/loop-hold-pane.tsx`
- Row cost (m8): `InboxRow` stays `memo`'d; the Held/Resumed label reads `item.loopHold.resumedAt` only and passes no new object props; `formatInboxTime` stays in render as today.
- Pending across navigation (m9, accepted): the pane remounts per item, so a Resume in flight is not shown after you navigate away and back until the refetch; the remount reads `loopHold.resumedAt` once `inbox_changed` arrives.
- Modify: `apps/web/src/features/inbox/inbox-row.tsx` (muted label "Held" / "Resumed" after the sender on line one, `shrink-0`, never truncated, when `item.loopHold`), `apps/web/src/features/inbox/inbox-pane.tsx` (`PaneBody`, L419, switches on `link.kind`; before it, `notice === "loop_held"` → `LoopHoldPane`; `PaneItem` hides the header `OpenLink` for it; notices already render without excerpt or composer (`NoticeContent`)), `apps/web/src/features/inbox/api.ts` (`useResumeHold` mutation → on success `invalidateQueries(inboxQueryKey)` and the item query)

React review M5: the result line renders from the **mutation's data** right after a Resume (`m.data.sentOn`), and from `loopHold` otherwise; `loopHold.sentOn` is derived server-side (Task 3.7) so every pane and every remount shows "· 4 messages sent on". A `focusResult` ref is set in the click handler's `mutate(undefined, { onSuccess: () => { focusResult.current = true } })`; the status line moves focus in a `useLayoutEffect` (or callback ref) when the flag is set, then clears it. The click handler starts with `if (m.isPending) return`. A 409 renders "Resumed by @ana · …" from the error body at once, then invalidates the inbox and item queries.
- Test: `apps/web/src/features/inbox/loop-hold-pane.test.tsx`, `inbox-row.test.tsx` (new)

Pane per spec §6.7 (copy verbatim): body text with handles in `font-mono` and `[overflow-wrap:anywhere]`; waiting line (`plural`: "1 message waiting" / "4 messages waiting" / "Nothing is waiting"); a terminated agent line "@b was terminated; its held messages were rejected."; the action slot at one fixed `min-h` holding either the primary button "Resume @a and @b" (wraps, `min-w` kept while pending with "Resuming…" and the spinner, `aria-disabled`) or the `role="status"` `tabIndex={-1}` line (focused after your own Resume via a ref in the mutation's `onSuccess`): "Resumed by you · {formatInboxTime} · {n} messages sent on" / "… · nothing was left to send"; another human's or a 409: "Resumed by @ana · {time}" (`title` = full timestamp); two ghost links "Open @a's session" / "Open @b's session" to `/agents/$slug/session`; a non-409 failure keeps the button and shows `FormOutcome` with `FORM_MSG.resumeFailed = "Couldn't resume. Try again."`. No toast. The notifier closes the hold's notification once `resumedAt` is set (Task 2.3 `resolved`).

- [ ] **Step 1: Failing tests:** each line's copy at 0/1/4 waiting; terminated line; pending keeps width and is `aria-disabled`; success replaces the button with the status line and focuses it; 409 shows the other human; error line; header `OpenLink` absent; row label Held → Resumed after `inbox_changed`; navigating away mid-Resume and back shows the button until `inbox_changed`, then the resumed line from `loopHold.resumedAt` (m9); `formatInboxTime` used (a resumed time from yesterday shows its date).
- [ ] **Step 2–4:** implement. **Step 5: Commit** `feat(web): the loop hold pane with Resume`.

### Task 3.10: Full-width notice pane below 1024px

Implementer and reviewer invoke `vercel-react-best-practices` and follow it. **Implementer:** Sonnet.

**Files:**
- Modify: `apps/web/src/routes/_app/inbox.tsx` (React review M6: **delete** the effect in `InboxPage` that drops `?item=` below 1024 ("a `?item=` from a wider window is dropped"); narrow passes `itemId` to `useLoadedItem` too; below `WIDE` with an `itemId` the page renders `<NarrowItem id={itemId} />` instead of the list), `apps/web/src/features/inbox/api.ts` (move `usePaneItem(id, loaded)` here from `inbox-pane.tsx:139` and export it), `apps/web/src/features/inbox/inbox-row.tsx` (rows of `FULL_WIDTH_NOTICES` link to `/inbox?item=<id>` at every width)
- Create: `apps/web/src/features/inbox/narrow-item.tsx`: `NarrowItem` resolves the item with `usePaneItem(id)`: a `chat:<slug>` id returns `<Navigate to="/agents/$slug/chat" params={{ slug }} replace />` with no fetch; while resolving, a static skeleton (never the list); an item whose `notice` is in `FULL_WIDTH_NOTICES` (`["loop_held"]` here; PR 4 adds `"worktrees_kept"`) renders `<InboxPane>` full-width with Back as `<Link to="/inbox" search={{}}>`; any other kind returns `<Navigate replace … />` to the item's own target (no navigate-in-effect).
- Test: `apps/web/src/test/inbox-route.test.tsx` (new; `fake-match-media.ts` for the width)

- [ ] **Step 1: Failing tests** (narrow `matchMedia`): `/inbox?item=chat:ada` navigates to `/agents/ada/chat` without fetching the item (assert no request); `/inbox?item=<hold>` renders the hold pane full-width with Back and Resume; Back returns to the list; `/inbox?item=<mention>` replaces the URL with the task target; an unloaded item id (not in the first page) is fetched and rendered without the list flashing; a hold row's link is `/inbox?item=` at 390 and 1440.
- [ ] **Step 2–4:** implement. **Step 5: Commit** `feat(web): a hold opens full-width below 1024px`.

### Task 3.11: DESIGN.md, product docs, evidence, review, PR 3

- [ ] **Step 1: DESIGN.md** Layout → Two panes amendment, spec §6.7, verbatim. Commit.
- [ ] **Step 2: Product docs** (main checkout): `concepts/message.md`, `architecture/factory-mcp.md`, `architecture/data-model.md`, `behavior/inbox.md`, `architecture/usage-tracking.md`, `behavior/administration.md` per spec §9. List them in the PR body.
- [ ] **Step 3: Evidence** (harness `run.sh` and its lock, fake Claude; the harness's `fake.mjs` supports `{"$mcp": {"tool": "send_message", …}}`): `i8-evidence/loop_guard.ts` starts the harness server with the settings at N = 3, two fake agents whose `fake.mjs` scripts answer every message with `$mcp send_message` to the other (I1's `$mcp` directive); records each `send_message` result until `held`, the notice, the managers' messages; then Resume through the API and records `sentOn`. Screenshots `i8_c20_hold_pane.py` (1440 pane, light/dark, 200%) and `i8_c21_hold_narrow.py` (390 and 320 full-width, Resume works, Back), plus the row label before and after.
- [ ] **Step 4: Whole-PR review** as in Task 1.7 Step 1 against spec §6 and AC 8–12, plus: every insert path of a counted row goes through `lockPairs` + `check` (grep `kind: "message"`, `task_comment`, `scheduled` inserts); Resume takes the pair lock before the row lock; no counts stored; copy verbatim; ADR 0028 (no state alias `held` in the DB); **the React diff against `vercel-react-best-practices`** (mutation from the click handler, focus via ref in `onSuccess`, no derived state in effects, the route's resolve logic without effect chains).
- [ ] **Step 5: Full verification** as in Task 1.7 Step 2. **Step 6: Push and PR** (base `i8/2-notifications`; ready once green), title `feat: a loop guard holds agent ping-pong until a human resumes it`, "Closes #47", reset step stated as: "Reset local data if the migration refuses a non-empty table." `explain analyze` plans pasted, docs listed, retarget note. CI until green. Never merge.

---

# PR 4: `i8/4-spawn-cleanup`

Implements spec §7, AC 13–15. `git checkout -b i8/4-spawn-cleanup i8/3-loop-guard`.

**Slug uniqueness** (spec §7.1), cited in code comments and the PR body: `agents.slug` is `.unique()` in `packages/db/src/schema/agents.ts`; I1's `handles` table (`agents.slug → handles(handle)`) reclaims a claim only when no row references it (`claimHandle` in `apps/server/src/messaging/principals.ts`); no production code deletes from `agents` (checked 2026-11-25: only two tests do; cited in the PR body, not tested). Task 4.3 adds a test that spawning with a terminated agent's slug as explicit suffix is refused.

### Task 4.1: The hardened git runner

**Implementer:** Sonnet (security boundary).

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

**Implementer:** Sonnet (security boundary).

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

0. **Validate `slug` before it touches any path** (owner plan review, defence in depth): it must match the server's slug schema (`slugSchema` / `SLUG_PATTERN` from `@open-factory/shared`), be one path segment, and not be `.` or `..` nor contain `/` or `\`; else throw `Error("invalid slug")`, caught by the caller as a project error. Slugs come from the database, but this function deletes folders, so it validates its own inputs.
1. `repo = await realpath(hostPath)` (missing → `error: "the project folder is missing"`). `top = (await git(repo, ["rev-parse","--show-toplevel"])).trim()`; `top !== repo` → `error: "not a git repository"`. `common = await realpath(path.resolve(repo, (await git(repo, ["rev-parse","--git-common-dir"])).trim()))`.
2. `lstat` in turn `repo/.worktrees`, `repo/.worktrees/.agents`, `base = repo/.worktrees/.agents/<slug>`: a symlink or non-directory at any → `error: ".worktrees/.agents/<slug> is a symbolic link; left in place"` (name the offending component); missing → `baseExists = false`.
3. `git worktree list --porcelain -z` → parse records (NUL-separated fields, empty field ends a record): `worktree <path>`, `branch refs/heads/<name>`, `locked`, `prunable`. `inBase(p) = rel = path.relative(base, path.normalize(p)); rel && !rel.startsWith("..") && !path.isAbsolute(rel)`. Ours → `branches`; others → `checkedOutElsewhere` (their branch names); the first record's branch also → `checkedOutElsewhere`. A `locked` mark is ignored (R12). Paths are data: never passed to `rm`.
4. Admin dirs: `wt = path.join(common, "worktrees")`; `lstat(wt)` must be a real directory (symlink → `error`; missing → `adminDirs = []`). `wtReal = await realpath(wt)`. For each `id` of `readdir(wt)`: skip unless `/^[^./][^/]*$/.test(id) && !id.includes("..")`; `st = lstat(wt/id)` must be a directory and not a symlink; `path.dirname(await realpath(wt/id)) === wtReal`; read `wt/id/gitdir` with `O_NOFOLLOW` (`SafeFs.readIfRegular`), trim; `g = path.isAbsolute(raw) ? raw : path.resolve(wt, id, raw)`; `g = path.normalize(g)`; keep `wt/id` when `inBase(path.dirname(g))` (gitdir names `<worktree>/.git`). Cross-check: for each of ours from step 3 whose `worktree` path has no admin dir whose `gitdir` dirname equals it → do not remove that worktree's folder; record `error: "couldn't match <branch>'s metadata; left in place"` and skip steps 5–7 for the project (keeps it simple and safe).
5. If `baseExists`: re-`lstat` `base` (still a directory, not a symlink) and `realpath(base) === path.join(repo, ".worktrees/.agents", slug)`; then `await new SafeFs(base).removeAll()` (rm never follows links inside; a symlinked root is unlinked). Any error (EACCES) → `error: "couldn't remove .worktrees/.agents/<slug>: <code>"`, skip 6–7. `removed = true`.
6. For each admin dir: re-check (lstat directory, not symlink, `dirname(realpath) === wtReal`), then `new SafeFs(dir).removeAll()`. No `git worktree prune`, ever.
7. Default: `d = await git(repo, ["symbolic-ref","-q","refs/remotes/origin/HEAD"]).then(s => s.trim().replace(/^refs\/remotes\/origin\//, ""), () => undefined)`; candidates `[d, "main", "master"]`, the default = the first whose `show-ref --verify -q refs/heads/<x>` succeeds (or none). `protectedNames = new Set([d, "main", "master"].filter(Boolean))`. For each branch of `branches`: `check-ref-format --branch <name>` fails → skip silently; in `protectedNames` → skip; in `checkedOutElsewhere` → `kept.push({branch, reason:"elsewhere"})`; else `n = Number(await git(repo, ["rev-list","--count",`refs/heads/${name}`,"--not","--remotes", ...(def ? [`refs/heads/${def}`] : []), "--"]))`; `n === 0` → `git branch -D --end-of-options <name>` → `deleted.push(name)`; else `kept.push({branch, commits: n})`.
`GitMissingError` propagates (the caller turns it into the one host-level line). Returns `null` when steps 2–4 found nothing of ours (no folder, no entries, no admin dirs).

- [ ] **Step 1: Failing tests** (`cleanup-project.test.ts`, real git, a bare `origin` repo in the temp dir as the remote, no network):
  - (hardening) `cleanupProject(p, "..")`, `"a/b"`, `".agents"` and `""` throw `invalid slug` before any filesystem or git call (a spy on `lstat` and `git` records none);
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

**Implementer:** Sonnet.

**Files:**
- Create: `apps/server/src/spawning/cleanup.ts`
- Modify: `apps/server/src/workspace/workspace.ts` (`deleteWorkspace(slug, stillUnpinned, markDeleted, beforeRemove)`, L174: called after `stillUnpinned()` and before the two `SafeFs(...).removeAll()`), `apps/server/src/spawning/reaper.ts` (the `deleteWorkspace` call in step 3 passes `() => this.d.cleanup.run(a)`; `ReaperDeps.cleanup: Pick<SpawnCleanup, "run">`), `apps/server/src/app.ts` (construct before `new Reaper`, L489), `packages/shared/src/events.ts` (`workspace_cleanup { projects: ProjectResult[] }`), `apps/server/src/agents/notices.ts` (`NoticeType` gains `"worktrees_kept"`; `createHumanMessage` takes `notice?: string` already)
- Test: `apps/server/src/spawning/cleanup.db.test.ts` (DB), `cleanup.test.ts` (pure `noticeBody`), `reaper.test.ts`, `workspace.test.ts`

**Interfaces:**
- Produces: `class SpawnCleanup { constructor(d: { db: Db; store: EventStore; bus: EventBus; router: Router; log: RuntimeLog; cleanupProject?: typeof cleanupProject }); run(agent: AgentRow): Promise<void> /* never rejects */ }`; `noticeBody(slug, results, hostLine?): string | null` (pure).

`run`: `projects = select name, host_path from projects order by name`; for each, `try { r = await cleanupProject(p, agent.slug) } catch (e) { if (e instanceof GitMissingError) { hostLine = true; break } r = { project: p.name, removed: false, deleted: [], kept: [], error: "couldn't clean up: " + short(e) } }`; collect non-null results. If any: `store.append(agent.id, null, { type: "workspace_cleanup", projects })` (the agent is terminated and its journal is empty — the reaper skips agents with a journal — so the single-writer rule holds). `body = noticeBody(...)`; when non-null (something kept or failed, or the host line): one `createHumanMessage({ kind: "system", fromAgentId: null, notice: "worktrees_kept", subjectAgentId: agent.id, to: "all", body, urgent: false })` (its inbox link is the plain session link `toEntries` already builds for a `system` row: no `seq`, and the event is the agent's last), then `publishAll(inbox_changed)`; and when the manager (`reportsTo`) is live, `store.createNotice({ toAgentId: manager, notice: "worktrees_kept", subjectAgentId: agent.id, body })`, handed over as other `@factory` notices are. Everything in one outer `try/catch` that logs and returns: `run` never rejects, so `deleteWorkspace` always proceeds.

`noticeBody` (spec §7.6 copy verbatim): first line "Cleaned up @dev-ab12's worktrees." when any `removed`, else (or when any `error`) "Couldn't fully clean up @dev-ab12's worktrees."; then per project with kept or error: "web: kept `feat/x` (3 commits not pushed or merged), `feat/y` (checked out elsewhere)" / "web: couldn't clean up: not a git repository"; the host line "Couldn't clean up worktrees: git isn't installed on the factory host."; at most 20 entries then "and N more in @dev-ab12's session"; `null` when nothing was kept and nothing failed.

- [ ] **Step 1: Failing tests:**
  - pure `noticeBody`: removed+kept, failures only, host line, the cap at 20 with "and N more…", plural "1 commit"/"3 commits", `null` for removals only;
  - `cleanup.db.test.ts` (with a fake `cleanupProject`): kept → one human notice with `notice: "worktrees_kept"` whose item links to the agent's session, one manager message when the manager is live, none when it is terminated; removals only → event appended, no notice; a throwing `cleanupProject` → still resolves; `GitMissingError` → the host line; a failing `createHumanMessage` → logged, `run` resolves;
  - `reaper.test.ts`: `beforeRemove` runs before the folders are removed and only when unpinned; a pin set before the sweep skips both; `run` rejecting is impossible (assert deletion proceeds when the injected cleanup throws inside);
  - projects are scanned regardless of grants (a terminated agent has none: termination deletes `agent_project_grants`, `event-store.ts:221`);
  - slug uniqueness: spawning with `suffix` equal to a terminated agent's suffix is refused with "@<slug> is taken; pick another suffix or leave it out." (`spawn-service.ts:31`), in `spawn-service.test.ts` if not already covered there.
- [ ] **Step 2–4:** implement. **Step 5: Commit** `feat(server): clean up worktrees when a spawned agent's workspace is deleted`.

### Task 4.4: CLAUDE.md worktree line

**Implementer:** Haiku.

**Files:**
- Modify: `apps/server/src/workspace/claude-md.ts` (L248, today "`<repo>/.worktrees/<slug>-<branch>`": the line from spec §7.1 with the agent's slug; spawned agents (`i.kind !== "persistent"`) get the second sentence too)
- Test: `apps/server/src/workspace/claude-md.test.ts` (snapshots for a persistent and a spawned agent)

- [ ] **Step 1–4:** failing snapshots; implement; pass. **Step 5: Commit** `feat(server): agents put worktrees under .worktrees/.agents/<slug>`.

### Task 4.5: Web: the cleanup line and notice pane

Implementer and reviewer invoke `vercel-react-best-practices` and follow it. **Implementer:** Sonnet.

**Files:**
- Modify: `packages/shared/src/messaging.ts` + `apps/server/src/agents/event-store.ts` (React review m10: inbox items of `notice = 'worktrees_kept'` gain `cleanup?: ProjectResult[]`, built in `toEntries` from the subject agent's `workspace_cleanup` event (one read for the page's such items: `session_events where type = 'workspace_cleanup' and agent_id in (…)`); `ProjectResult` moves to `packages/shared/src/events.ts`), `apps/web/src/features/session/rows.ts` / `timeline-row.tsx` (a `workspace_cleanup` event renders as a muted factory line grouped by project, branch names `font-mono [overflow-wrap:anywhere]`, copy from spec §7.5), `apps/web/src/features/inbox/inbox-pane.tsx` (`notice === "worktrees_kept"` → `CleanupPane`; header `OpenLink` stays and opens the agent's session, whose last event is the cleanup), `apps/web/src/routes/_app/inbox.tsx` (`FULL_WIDTH_NOTICES` gains `"worktrees_kept"`)
- The `workspace_cleanup` row type in `rows.ts` / `timeline-row.tsx` keeps the timeline's memoised row contract (m11): a module-level component, no inline component definitions, stable props (the event object from the store, no per-render objects).
- Create: `apps/web/src/features/inbox/cleanup-pane.tsx` (renders from `item.cleanup`, the same `ProjectResult[]` shape as the session line, never by parsing the body: lines grouped by project, branch names mono with `copy-feedback.tsx`, then "Push them to keep the work, or delete them in the project's repository.")
- Test: `cleanup-pane.test.tsx`, a `rows` test, `inbox-route.test.tsx` (full width at 390)

- [ ] **Step 1–4:** failing tests (copy, mono branches, copy button feedback, long branch names wrap without page overflow, no composer, full-width at 390 with Back, no desktop notification for this notice — Task 2.2's test already covers it); implement; pass.
- [ ] **Step 5: Commit** `feat(web): the cleanup line and notice`.

### Task 4.6: Product docs, evidence, whole-I8 review, PR 4

- [ ] **Step 1: Product docs** (main checkout): `behavior/agents-and-sessions.md` (spawned-agent workspace lifecycle incl. worktrees and branches), `architecture/context-assembly.md` (the worktree line), `concepts/project.md` (L16 "never deleted by the factory" → what the factory removes in a repo and what it never touches). List them in the PR body.
- [ ] **Step 2: Evidence** (harness `run.sh` and its lock, fake Claude): `i8-evidence/cleanup.ts` creates a project repo in a temp dir with a bare origin, registers it, spawns a fake child, creates (as the test, through the runner-free git CLI in the temp repo) two worktrees under `.worktrees/.agents/<child>/` (one pushed, one not), terminates the child, sets its `terminated_at` back 3 days + 1 minute in the throwaway DB, runs the reaper once (`app.reaper.run()` via the harness's control hook or a script), and records: the folder gone, the pushed branch gone, the unpushed one kept, the notice text, the Session line. Screenshot `i8_c30_cleanup_notice.py` at 1440 and 390.
- [ ] **Step 3: Whole-PR and whole-I8 review.** A fresh read-only reviewer on `git diff i8/3-loop-guard...i8/4-spawn-cleanup` (and skimming PRs 1–3) checks spec §7 and AC 13–15 line by line, **every git invocation goes through `git()`** (grep for `execFile`, `spawn(`, `"git"` in `apps/server/src/spawning`), no `worktree remove`/`prune`, no path from git output reaches `rm`/`SafeFs` except the computed `base` and `common/worktrees/<id>`, `safe.directory` only in the one retry, ADR 0028, copy verbatim, and **the React diff against `vercel-react-best-practices`**. Fix findings.
- [ ] **Step 4: Full verification** as in Task 1.7 Step 2.
- [ ] **Step 5: Push and PR** (base `i8/3-loop-guard`; ready once green), title `feat(server): clean up worktrees and landed branches of terminated spawned agents`, "Closes #55", the deliberate deviation stated (no `git worktree remove`; the folder is deleted directly), the accepted risk from spec §12 (an agent can forge `refs/remotes/*` to make its own unpushed branch look pushed; accepted, it only affects its own branches in its own folder and fetching would break the no-network rule), slug-uniqueness citations, docs listed, retarget note. CI until green. Never merge.

## Manual steps for Or (the executor never does these)

1. Review the decisions rated 3/5 or lower on #169 (Q6, Q8, Q10, Q16, R2a, R5, R6, R12; R11 rose to 4).
2. Optionally, on a real project: let a real spawned agent make a worktree, terminate it, and watch the cleanup after the grace (the evidence uses fake Claude and temp repos only).
