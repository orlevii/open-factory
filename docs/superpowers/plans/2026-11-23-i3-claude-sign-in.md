# I3 Sign in with Claude Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an `oauth_token` credential by driving `claude setup-token` in a host PTY (sign-in link, pasted code, one-year token, verify, store), track its expiry with a 14-day Inbox notice, and replace it in place with Sign in again; pasting stays as a fallback.

**Architecture:** A fixed python3 PTY bridge (`String.raw` constant) runs the host `claude setup-token` with an env allow-list and a 0700 temp `HOME`/`CLAUDE_CONFIG_DIR`. Pure parsers and a small runner state machine sit behind a `PtyRun` interface. An in-memory `SignInAttempts` store (one attempt per user, `attemptId`, cap 3, 10-minute TTL while waiting for the code) owns the outcome promise and hands the token to the credential service's verified write halves. Routes live under `/api/claude-sign-in`. An hourly in-memory `ExpiryCheck` writes one `@factory` `system` message per credential (inbox kind `credential`). The web adds a Method choice with one primary at a time, a sign-in panel, a Sign in again sheet, row expiry lines and Inbox credential branches.

**Tech Stack:** TypeScript pnpm monorepo, Fastify, Postgres with Drizzle, Zod in `packages/shared`, React + Vite + TanStack Router/Query, Vitest, Biome, python3 standard library `pty` (no new npm dependency).

**Spec:** `docs/superpowers/specs/2026-11-23-i3-claude-sign-in-design.md`. Decision log: issue #147 (follow-ups #148, #149). Read the spec section each task cites before starting the task. The spec is the authority for copy and behaviour.

## Global Constraints

- **Security (owner rules, not negotiable).** Never run the real `claude setup-token`, `claude login` or any real sign-in, and never contact Anthropic's OAuth endpoints. Never read, print or copy `~/.claude`, `~/.open-factory-spike`, the macOS keychain or env vars holding tokens. Tests and evidence use the fake CLI (`packages/harness/testing/fake-claude.mjs`) only. The one real run is Or's manual step (last task).
- **No secret leaves the attempt (spec §6).** No URL, code or token in logs, events, the database (beyond the encrypted credential value), error responses, process argv or temp files. Every error answer is a fixed constant. No new pino redact wildcards (D20). No body logging on sign-in routes.
- **Pre-release, ADR 0028 (`docs/product/decisions/0028-pre-release-no-compatibility.md`).** No backward compatibility: no shims, aliases, deprecated paths, fallbacks for old shapes or flags for the old behaviour; replace the old thing and delete it. No data migration: schema changes ship as the generated Drizzle migration (`0020_*`) plus the hand edit of `inbox_items_kind_check` (spec §5.6), without backfilling or converting rows. Resetting local data is fine. PR body states: existing OAuth credentials get `expires_at` null; no reset needed.
- **Database tests run only in CI.** Server tests that use `createTestDb`/`makeTestApp` from `apps/server/src/test/helpers.ts` need Postgres; the local Postgres role is unavailable, so they run only in CI. Locally run the pure unit tests and the web tests; push and read CI for the DB suites.
- **Tests per task.** Each implementer and each reviewer runs only the test files the task created or changed (`pnpm vitest run <those files>`), plus the existing files a step names explicitly (for example the timeline and chat tests after the arrival extraction). The full suite, `pnpm typecheck`, `pnpm lint` and `pnpm build` run once, at the end of the part (Task 23), not per task. A task may run `pnpm typecheck` when a step says so, because a shared type change can only be checked that way.
- **No shared heavy-job lock.** There is no machine-wide lock for tests or builds. The browser evidence pass (Task 24) keeps the harness's own lock, which `run.sh` takes itself (`/tmp/of-u4-evidence.lock`).
- **Review.** One reviewer per task (fresh, read-only, against the spec section the task cites), then the whole-branch review (Task 22). For a task that touches `apps/web`, the reviewer invokes `vercel-react-best-practices` first and checks the React diff against it.
- **React.** The React parts of this plan were written with `vercel-react-best-practices` loaded and already comply (React 19 + Vite + TanStack Router/Query; Next-only rules don't apply). Every web task says: *The plan is already React-compliant; follow it as written and report any deviation.* An implementer who must deviate (the code differs from what the plan assumes) invokes the skill, keeps the deviation compliant, and names it in the task report.
- **I4 form rules.** Use `FieldShell`/`FieldNote`, `useFieldErrors`, `useOutcome`/`FormOutcome` and `field-stack`. Every error and outcome message ≤ 40 characters, an exported constant in shared `MSG` or web `FORM_MSG`, never interpolated (success toasts excepted). I4's length and template-literal tests must cover the new constants.
- **No new npm dependency.** The PTY is python3's `pty`.
- **Limits and constants (verbatim from the spec):** TTL `SIGN_IN_TTL_MS = 10 * 60_000` (injectable); start bound 30 s; exchange bound 60 s; `settleMs = 150`; buffers 64 KB; global cap 3; settled outcome and tombstone kept 60 s; wait answer after 50 s → 202; verify retry once after 3 s; window 200×50; boot sweep of `of-sign-in-*` older than 15 minutes; code 1–512 printable ASCII after removing all whitespace; `expires_at` = token read time + 365 days; notice 14 days ahead; expiry check hourly plus once after boot.
- **Never wait on other agents' processes.** No sleep or wait loops on processes this task did not start.
- **Git.** Merge, never rebase. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **PR.** Opened **ready for review** (not draft) once the final review is fixed and CI is green (Task 25). The user merges; the executor never merges.

## Branch

Work in the worktree `/Users/orlevi/projects/open-factory/.worktrees/spec-i3`. The spec branch `spec/i3-claude-sign-in` already has `origin/i2/3-config-form` (the I4, I6, I1, I2 stack) merged in, and this plan was revalidated against that code. Cut the implementation branch there, after merging the lower branch again in case it moved:

```bash
cd /Users/orlevi/projects/open-factory/.worktrees/spec-i3
git fetch origin
git merge --no-edit origin/i2/3-config-form   # a merge commit, never a rebase; resolve conflicts if any
git checkout -b i3/claude-sign-in
```

Before pushing, merge `origin/i2/3-config-form` again (never rebase).

Commands used throughout:
- one test file: `pnpm vitest run <path>`;
- the whole suite: `pnpm test` (once, in Task 23);
- `pnpm typecheck`, `pnpm lint`, `pnpm build`;
- migrations: `pnpm db:generate` (the next number is `0020_*`; `0019_magical_magik` is the latest on the base).

## File map

**Shared (`packages/shared/src/`)**

| File | Purpose |
|---|---|
| `messages.ts` (modify) | New `MSG.signIn*` constants (spec §6.3) |
| `settings.ts` (modify) | `CredentialSummary.expiresAt`, `.rejected` |
| `claude-sign-in.ts` (new) | `attemptViewSchema`, `signInStatusSchema`, `startSignInBodySchema`, `submitCodeBodySchema`, `waitBodySchema`, `normalizeSignInCode` |
| `messaging.ts` (modify) | `INBOX_KINDS = ["notice", "mention", "task_event", "credential"]` (I1's `notice` kept); `inboxItemSchema.credential`; `link` + `{ kind: "credential", name }` |
| `index.ts` (modify) | Exports |

**DB (`packages/db/`)**

| File | Purpose |
|---|---|
| `src/schema/factory.ts` (modify) | `credentials.expiresAt`, `expiryNotifiedAt`, `rejectedAt` |
| `src/schema/agents.ts` (modify) | `messages.subjectCredentialId` (FK, cascade); `inboxItems.kind` `$type<"message" \| "mention" \| "task_event" \| "credential">` (DB names: the stored `message` is the shared `notice`) |
| `migrations/0020_*.sql` (generated + hand edit) | Columns, FK, and the `inbox_items_kind_check` drop/add |
| `src/schema.tasks.test.ts` (modify, CI only) | The credential kind and the cascade |

**Server (`apps/server/src/`)**

| File | Purpose |
|---|---|
| `credentials/credential-service.ts` (modify) | `insertVerified`, `replaceVerified`, `replaceById`, `rejected_at`, `expires_at`, summary fields, `inbox_changed` publish |
| `credentials/sign-in/pty-bridge.ts` (new) | `PTY_BRIDGE` constant |
| `credentials/sign-in/host-pty.ts` (new) | `PtyRun`, `startHostPty`, `probePython`, `sweepStaleDirs`, `bridgeSpawnOptions` |
| `credentials/sign-in/setup-token.ts` (new) | `stripTerminal`, `parsePrompt`, `parseToken`, `hasOAuthError`, `runSetupToken` |
| `credentials/sign-in/__fixtures__/setup-token.SYNTHETIC.txt` (new) | Synthetic transcript |
| `credentials/sign-in/attempts.ts` (new) | `SignInAttempts` store (refusals are `ApiError`/`FieldError`) |
| `credentials/expiry-check.ts` (new) | `ExpiryCheck` interval |
| `routes/claude-sign-in.ts` (new) | `/api/claude-sign-in` routes |
| `routes/credentials.ts` (modify) | Paste routes pass `expiresAt: null`, call `endFor` after a paste/API-key add |
| `routes/auth.ts` (modify) | Sign-out hook → `endFor` |
| `users/user-admin.ts` (modify) | Disable → `endFor` |
| `agents/event-store.ts` (modify) | `createHumanMessage`: `subjectCredentialId`, `createdAt`, `inboxKind: "credential"`, the system guard; `inboxRows` joins `credentials`; `toEntries` credential branch first |
| `app.ts` (modify) | Wire store, routes, expiry check, shutdown step, boot sweep; `AppDeps.signInSpawn` test seam |
| `test/helpers.ts` (modify) | `TestAppOptions.logLevel` (default `info`) and `signInSpawn` |
| `test/sign-in-helpers.ts` (new) | `appWithFakeClaude()` for the route tests |
| `scripts/sign-in-record.ts` (new) + `package.json` script `sign-in:record` | Or's recording script |

**Harness:** `packages/harness/testing/fake-claude.mjs` (modify): `setup-token` mode, which writes its pid to `$FAKE_CLAUDE_DIR/setup-token.pid` (the wrapper `createFakeClaude` writes already exports `FAKE_CLAUDE_DIR`; `index.ts` is unchanged). `packages/harness/testing/synthetic-sign-in.mjs` (new): synthetic URL, code and token.

**Web (`apps/web/src/`)**

| File | Purpose |
|---|---|
| `features/settings/sign-in/api.ts` (new) | `signInQueryOptions`, `startSignIn`, `submitSignInCode`, `waitSignIn`, `cancelSignIn` |
| `features/settings/sign-in/expiry.ts` (new) | `expiryState()` |
| `features/settings/sign-in/use-sign-in.ts` (new) | Attempt hook: mutations, disappearance, deadline timer, wait loop |
| `features/settings/sign-in/sign-in-panel.tsx` (new) | Idle / Starting / Ready / Exchanging panel |
| `features/settings/forms/add-credential-form.tsx` (modify) | Method choice, one primary at a time |
| `features/settings/forms/form-frame.tsx` (modify) | `autoFocus?: boolean` (default true), passed to `InlineForm` |
| `features/settings/forms/shared.tsx` (modify) | `TokenField` help per method |
| `features/settings/credentials-section.tsx` (modify) | Module-level memoised `CredentialRow`, `ExpiryLine`, Sign in again, inline auto-open, `?credential=` arrival, delete-dialog copy |
| `features/settings/shared.tsx` (modify) | `RowLine` actions `flex-wrap justify-end`; `InlineForm` `autoFocus` |
| `features/sheets/sheet-store.ts`, `sheet-bodies.ts`, `sheet-host.tsx`, `body-skeleton.tsx` (modify) | `sign-in-again` kind, top-level description, skeleton rows, prefetch |
| `components/app-sidebar.tsx` (modify) | Sign-out calls `resetSignIn()` beside `resetSheets()`/`resetDrafts()` |
| `features/sheets/sign-in-again-sheet.tsx` (new) | Sheet body |
| `features/inbox/api.ts`, `inbox-row.tsx`, `inbox-pane.tsx`, `notifications.ts` (modify) | Credential branches |
| `lib/use-arrival.ts` (new) | `ARRIVAL_MS`, `Arrival`, `arrive`, `useArrivalTint`: the one copy of the deep-link arrival, used by the session timeline, the chat and the credentials page |
| `features/session/timeline.tsx`, `timeline-item.tsx`, `features/chat/chat-view.tsx`, `chat-row.tsx` (modify) | Use `lib/use-arrival.ts`; their duplicated tint timers, `ARRIVAL_MS`, `arrive` and `Arrival` are deleted |
| `routes/_app/settings.credentials.tsx` (modify) | `validateSearch` for `?credential=`; non-blocking sign-in prefetch |
| `lib/form-messages.ts` (modify) | `FORM_MSG.signInOtherPanel` |

**Docs:** `DESIGN.md` (four amendments). Product docs under `docs/product/` (gitignored, main checkout only) are listed for the lead in Task 21.

---

## Part 1: Shared and data

### Task 1: Shared messages and schemas

Implements spec §5.5 (shapes), §5.8, §6.3.

**Files:**
- Create: `packages/shared/src/claude-sign-in.ts`, `packages/shared/src/claude-sign-in.test.ts`
- Modify: `packages/shared/src/messages.ts`, `packages/shared/src/settings.ts`, `packages/shared/src/messaging.ts`, `packages/shared/src/index.ts`, `apps/web/src/lib/form-messages.ts` and `apps/web/src/features/agents/agent-form-state.ts` (the `credentialDeleted` move); the `CredentialSummary` construct sites in the same commit (m7): `apps/web/src/test/settings.test.tsx` (~`:31`), `apps/web/src/test/agent-screens-fixtures.ts` (~`:8`), `apps/server/src/credentials/credential-service.ts` `summarize()` (placeholders, made real in Task 3). `messages.test.ts` iterates every `MSG` key already, so it needs no change.

**Interfaces:**
- Produces:
  - `MSG.signInCode`, `signInCodeRejected`, `signInUnavailable`, `signInStartFailed`, `signInBusy`, `signInExpired`, `signInEnded`, `signInReplaced`, `signInFailed`, `signInNotFound`, `signInState`, `signInNameTaken`, `signInOAuthOnly`. Three answers reuse existing constants instead of new keys (m1): a just-minted token the verifier rejects answers with the verifier's own `VerifyResult.message` (`FIELD_MSG.tokenRejected` "Claude rejected this token."), an unreachable verifier with `FIELD_MSG.claudeUnreachable` ("Couldn't reach Claude. Try again."), and a replace whose credential was deleted answers `credential_not_found` with "That credential was deleted.", which already exists as web `FORM_MSG.credentialDeleted`: it **moves** to shared `MSG.credentialDeleted` (the server needs it), the `FORM_MSG` key is deleted and its one caller (`apps/web/src/features/agents/agent-form-state.ts:228`) reads `MSG.credentialDeleted` (no alias, ADR 0028);
  - `SIGN_IN_STATES = ["starting","awaiting_code","submitting","exchanging","verifying","settled"] as const`;
  - `attemptViewSchema` / `type AttemptView = { attemptId: string; state: SignInState; url?: string; codeDeadline?: string; purpose: "create" | "replace"; name?: string }`;
  - `signInStatusSchema = { available: boolean; attempt: AttemptView | null }`;
  - `startSignInBodySchema = { replace?: string (nameSchema) }`;
  - `submitCodeBodySchema = { attemptId: string; code: string; name?: string }`;
  - `waitBodySchema = { attemptId: string }`;
  - `normalizeSignInCode(raw: string): string | undefined` (removes all whitespace; returns undefined unless 1–512 chars of `[\x21-\x7E]`);
  - `CredentialSummary.expiresAt: string | null`, `.rejected: boolean`;
  - `INBOX_KINDS` includes `"credential"`; `InboxItem.credential?: { name: string; expiresAt: string | null; current: boolean }`; `InboxItem.link` includes `{ kind: "credential"; name: string }`.

- [ ] **Step 1: Write failing tests** in `claude-sign-in.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MSG } from "./messages.ts";
import { attemptViewSchema, normalizeSignInCode, submitCodeBodySchema } from "./claude-sign-in.ts";
import { INBOX_KINDS, inboxItemSchema } from "./messaging.ts";

describe("normalizeSignInCode", () => {
  it("removes every whitespace character", () => {
    expect(normalizeSignInCode("  abc\n#def\t ")).toBe("abc#def");
  });
  it.each(["", "   ", "a".repeat(513), "ab\u0007c", "abé"])("refuses %j", (c) => {
    expect(normalizeSignInCode(c)).toBeUndefined();
  });
  it("accepts 512 printable characters", () => {
    expect(normalizeSignInCode("x".repeat(512))).toBe("x".repeat(512));
  });
});

describe("schemas", () => {
  it("attempt view carries no token field and only known states", () => {
    const v = { attemptId: "a1", state: "awaiting_code", url: "https://claude.com/x", codeDeadline: "2026-11-23T10:00:00.000Z", purpose: "create" };
    expect(attemptViewSchema.parse(v)).toEqual(v);
    expect(attemptViewSchema.safeParse({ ...v, state: "minted" }).success).toBe(false);
    expect(attemptViewSchema.safeParse({ ...v, token: "x" }).success).toBe(false);
  });
  it("submit body requires attemptId and code", () => {
    expect(submitCodeBodySchema.safeParse({ code: "x" }).success).toBe(false);
    expect(submitCodeBodySchema.safeParse({ attemptId: "a", code: "x", name: "work" }).success).toBe(true);
  });
  it("inbox has the credential kind and link", () => {
    expect(INBOX_KINDS).toContain("credential");
    const item = inboxItemSchema.parse({
      id: "i", messageId: "m", kind: "credential", read: false,
      from: { kind: "factory", name: "factory" }, to: "everyone", preview: "work expires on 2027-11-12.",
      urgent: false, createdAt: "2026-11-23T10:00:00.000Z",
      credential: { name: "work", expiresAt: "2027-11-12T10:00:00.000Z", current: true },
      link: { kind: "credential", name: "work" },
    });
    expect(item.link).toEqual({ kind: "credential", name: "work" });
  });
});

describe("sign-in messages", () => {
  it.each(Object.entries(MSG).filter(([k]) => k.startsWith("signIn")))("%s ≤ 40 chars", (_k, v) => {
    expect(v.length).toBeLessThanOrEqual(40);
  });
});
```

- [ ] **Step 2: Run and confirm they fail.** `pnpm vitest run packages/shared/src/claude-sign-in.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement.**
  - `messages.ts`: add to `MSG` exactly (copy verbatim):

```ts
  signInCode: "Paste the code from the sign-in page.",
  signInCodeRejected: "Claude didn't accept that code.",
  signInUnavailable: "Sign-in needs python3 on the server.",
  signInStartFailed: "Couldn't start sign-in. Try again.",
  signInBusy: "Too many sign-ins. Try again shortly.",
  signInExpired: "Sign-in timed out. Start again.",
  signInEnded: "Sign-in ended. Start again.",
  signInReplaced: "Sign-in restarted elsewhere.",
  signInFailed: "Sign-in didn't finish. Start again.",
  signInNotFound: "No sign-in in progress.",
  signInState: "Sign-in is already finishing.",
  signInNameTaken: "That name was taken. Start again.",
  signInOAuthOnly: "Only OAuth tokens can sign in again.",
  credentialDeleted: "That credential was deleted.", // moved from web FORM_MSG
```

  - `claude-sign-in.ts`:

```ts
import { z } from "zod";
import { nameSchema } from "./names.ts";

export const SIGN_IN_STATES = ["starting", "awaiting_code", "submitting", "exchanging", "verifying", "settled"] as const;
export type SignInState = (typeof SIGN_IN_STATES)[number];

export const attemptViewSchema = z.strictObject({
  attemptId: z.string().min(1),
  state: z.enum(SIGN_IN_STATES),
  url: z.string().optional(),
  codeDeadline: z.string().optional(),
  purpose: z.enum(["create", "replace"]),
  name: z.string().optional(),
});
export type AttemptView = z.infer<typeof attemptViewSchema>;

export const signInStatusSchema = z.object({ available: z.boolean(), attempt: attemptViewSchema.nullable() });
export const attemptResponseSchema = z.object({ attempt: attemptViewSchema });
export const startSignInBodySchema = z.strictObject({ replace: nameSchema.optional() });
export const submitCodeBodySchema = z.strictObject({
  attemptId: z.string().min(1).max(64),
  code: z.string().max(4096),
  name: z.string().max(200).optional(),
});
export const waitBodySchema = z.strictObject({ attemptId: z.string().min(1).max(64) });

/** Removes every whitespace character (a pasted newline would submit early, D5); 1–512 printable ASCII or undefined. */
export function normalizeSignInCode(raw: string): string | undefined {
  const code = raw.replace(/\s+/g, "");
  return /^[\x21-\x7E]{1,512}$/.test(code) ? code : undefined;
}
```

  - `settings.ts`: in `credentialSummarySchema` add `expiresAt: z.string().nullable()` and `rejected: z.boolean()`.
  - `messaging.ts`: `INBOX_KINDS = ["notice", "mention", "task_event", "credential"] as const` (keep I1's `notice`: the Inbox rows, pane and notifications branch on `item.kind === "notice"`; the doc comment gains "`credential` is a factory fact about a credential"); add `credential: z.object({ name: z.string(), expiresAt: z.string().nullable(), current: z.boolean() }).optional()` to `inboxItemSchema`; add `z.object({ kind: z.literal("credential"), name: z.string() })` to the `link` discriminated union.
  - `index.ts`: `export * from "./claude-sign-in.ts";`.
- [ ] **Step 4: Run the tests and typecheck.** `pnpm vitest run packages/shared/src/claude-sign-in.test.ts packages/shared/src/messages.test.ts` → PASS. Add `expiresAt: null, rejected: false` to the three construct sites listed under Files (server `summarize()` as placeholders; Task 3 makes them real). `pnpm typecheck` then shows errors only where web code narrows `link.kind` to `session | task`; those are fixed in Task 18 (if one blocks compilation now, add the minimal exhaustive `credential` case that returns the same fallback the code has today and leave a `// Task 18` note, which Task 18 removes).
- [ ] **Step 5: Commit.** `git commit -m "feat(shared): sign-in schemas, messages and the credential inbox kind"` (with the trailer).

### Task 2: Database columns and migration

Implements spec §5.6 (schema).

**Files:**
- Modify: `packages/db/src/schema/factory.ts`, `packages/db/src/schema/agents.ts`
- Create: `packages/db/migrations/0020_<generated>.sql` (generated, then hand-edited; `0019_magical_magik` is the latest on the base)
- Test: `packages/db/src/schema.tasks.test.ts` (CI only; extend: it is the home of the `inbox_items_kind_check` test at ~`:100`)

**Interfaces:**
- Produces: `credentials.expiresAt`, `credentials.expiryNotifiedAt`, `credentials.rejectedAt` (all `timestamptz` null); `messages.subjectCredentialId` (`text`, FK `credentials.id` on delete cascade); `inboxItems.kind` `$type<"message" | "mention" | "task_event" | "credential">()`. These are DB names: the stored `message` is the shared `notice`, and `toEntries` maps it at the boundary as today (`event-store.ts` ~`:1442`). Shared `INBOX_KINDS` (Task 1) is `notice | mention | task_event | credential`.

- [ ] **Step 1: Write the failing CI test** in `packages/db/src/schema.tasks.test.ts`, in the file's own style (raw `postgres` tagged SQL, the existing seeded user and setup; read the file's top before writing):
  - insert a `credentials` row that no agent uses (the delete guard in `credentials` refuses a used one; see `schema/agents.check.test.ts:26-34`);
  - insert a `messages` row `(kind 'system', notice 'credential_expiring', subject_credential_id = that id, to_all_humans true, body 'work expires on 2027-11-12.')` with the other columns the file's existing message inserts set (see `schema.messages.test.ts:74` for an inbox insert);
  - an `inbox_items` row of kind `credential` for that message is accepted; one of kind `bogus` is rejected (the file's `bad()` helper, as the existing `'bogus'` insert at ~`:104`);
  - `delete from credentials where id = …`, then `select count(*)` of messages with that `subject_credential_id` and of their inbox items: both 0.
- [ ] **Step 2: Add the columns.** In `factory.ts` `credentials`: `expiresAt: ts("expires_at"), expiryNotifiedAt: ts("expiry_notified_at"), rejectedAt: ts("rejected_at"),`. In `agents.ts` `messages`: `subjectCredentialId: text("subject_credential_id").references((): AnyPgColumn => credentials.id, { onDelete: "cascade" }),` (`credentials` is already imported from `./factory.ts` at `agents.ts:19` and `AnyPgColumn` is in use: there is no cycle). `inboxItems.kind` `$type` gains `"credential"`.
- [ ] **Step 3: Generate and hand-edit.** `pnpm db:generate` (expect `0020_*`). Append to the generated SQL:

```sql
ALTER TABLE "inbox_items" DROP CONSTRAINT "inbox_items_kind_check";--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_kind_check" CHECK (kind IN ('message','mention','task_event','credential'));
```

  The constraint name and its current values are verified at `migrations/0008_modern_mephisto.sql:111`; it is not modelled in `schema/*.ts`, so `db:generate` never touches it. The stored value stays `'message'` (not `'notice'`). `messages_sender_kind_check` (latest definition `0009_demonic_black_cat.sql:49-90`) has no clause about `subject_credential_id`, so a stray value on another kind would pass the DB; the only writer is `createHumanMessage` (Task 11), which sets it only on `system` rows. No new check (state it in the PR, not in code).
- [ ] **Step 4: Verify locally what can run.** `pnpm typecheck` (the packages have no per-package typecheck script). The CHECK and cascade test runs in CI.
- [ ] **Step 5: Commit.** `feat(db): credential expiry columns, notice subject and the credential inbox kind`.

### Task 3: Credential service split, expiry and rejection

Implements spec §5.6 (service), Q6, D10.

**Files:**
- Modify: `apps/server/src/credentials/credential-service.ts`, `apps/server/src/routes/credentials.ts`, `apps/server/src/app.ts` (pass `bus`: it exists at ~`:201`, `CredentialService` is built at ~`:324`)
- Test: `apps/server/src/credentials/credential-service.test.ts` (CI only: DB). The file builds one `new CredentialService({ db, vault, verifier, runtimes, now, log })` at module level in `beforeAll`, with a mutable `result` the stub verifier returns; add `bus` to that construction (a recording stub `{ publishAll: (m) => published.push(m) }`) and switch `result` per test. `svc({ verify })` and `svcWithBus` below are not existing helpers: write the tests against the module-level `svc`, `result` and `published`.

**Interfaces:**
- Consumes: Task 1 summary fields, Task 2 columns.
- Produces (on `CredentialService`):
  - `create(b: { name; kind; value; expiresAt: Date | null }): Promise<CredentialSummary>` (pre-check name, verify, then `insertVerified`);
  - `insertVerified(b: { name; kind; value; expiresAt: Date | null }): Promise<CredentialSummary>` (insert only; 409 `credential_exists` on a unique violation);
  - `nameTaken(name: string): Promise<boolean>`;
  - `byName(name): Promise<{ id: string; name: string; kind: CredentialKind } | undefined>`;
  - `replace(name, value)`: resolves the id and calls `replaceById(id, value, { expiresAt: null })`;
  - `replaceById(id, value, { expiresAt }): Promise<CredentialSummary>` (verify, then `replaceVerified`);
  - `replaceVerified(id, value, { expiresAt }): Promise<CredentialSummary>` (update `value_enc`, `last_verified_at = now`, `expires_at`, clear `expiry_notified_at`, `rejected_at`, `last_error`; restart active users when idle; if `expiry_notified_at` was set, `bus.publishAll({ type: "inbox_changed" })`, as `router.ts` ~`:508` does for factory facts); 404 `credential_not_found` when the id is gone;
  - `reverify`: `rejected` sets `rejected_at = now()` and `last_error`; `ok` clears both and sets `last_verified_at`; `unreachable` changes neither column;
  - `summarize` sets `expiresAt` (ISO or null) and `rejected: row.rejectedAt !== null`.
- Constructor gains `bus: Pick<EventBus, "publishAll">`. No user-id read.

- [ ] **Step 1: Write failing tests** (CI only) in `credential-service.test.ts`:

```ts
it("create stores expiresAt; paste passes null", async () => {
  result = { ok: true };
  const c = await svc.create({ name: "work", kind: "oauth_token", value: "sk-ant-oat01-SYNTHETICxxxxxxxxxxxxxxxx", expiresAt: new Date("2027-11-12T00:00:00Z") });
  expect(c.expiresAt).toBe("2027-11-12T00:00:00.000Z");
  expect(c.rejected).toBe(false);
});
it("insertVerified never calls the verifier", async () => {
  const before = seen.length;
  await svc.insertVerified({ name: "w-iv", kind: "oauth_token", value: "v", expiresAt: null });
  expect(seen.length).toBe(before);
});
it("replaceVerified keeps the id, sets expiry, clears notified/rejected and publishes inbox_changed", async () => {
  result = { ok: true };
  const c = await svc.create({ name: "w-rv", kind: "oauth_token", value: "a", expiresAt: null });
  const { credentials } = schema;
  const [row] = await t.db.select().from(credentials).where(eq(credentials.name, "w-rv"));
  await t.db.update(credentials).set({ expiryNotifiedAt: new Date(), rejectedAt: new Date() }).where(eq(credentials.id, row!.id));
  published.length = 0;
  const r = await svc.replaceVerified(row!.id, "b", { expiresAt: new Date("2028-01-01T00:00:00Z") });
  expect(r.name).toBe(c.name);
  const [after] = await t.db.select().from(credentials).where(eq(credentials.id, row!.id));
  expect(after!.expiryNotifiedAt).toBeNull();
  expect(after!.rejectedAt).toBeNull();
  expect(published).toContainEqual({ type: "inbox_changed" });
});
it("replaceVerified on a deleted id is 404", async () => {
  await expect(svc.replaceVerified("missing", "b", { expiresAt: null })).rejects.toMatchObject({ code: "credential_not_found" });
});
it("reverify sets rejected_at on rejected, clears on ok, leaves it on unreachable", async () => { /* three verifier stubs, assert row.rejectedAt each time */ });
```

- [ ] **Step 2: Run.** These run only in CI (`createTestDb`). Locally confirm they at least typecheck: `pnpm typecheck` → FAIL (methods missing).
- [ ] **Step 3: Implement.** Split `create` into pre-check + `this.assertVerified(await verifier.verify(...))` + `insertVerified`. Move the `replace` body into `replaceVerified(id, …)` keyed on id; `replaceById` = verify + `replaceVerified`; `replace(name, value)` = `rowByName` → `replaceById(row.id, value, { expiresAt: null })`. Keep no second path for the old shape (ADR 0028). In `routes/credentials.ts` the POST passes `{ ...req.body, expiresAt: null }`. Pass `bus` in `app.ts` where `CredentialService` is constructed. Fix the other construct sites of `CredentialService` the typecheck finds (tests included).
- [ ] **Step 4: Verify.** `pnpm typecheck`. The changed test file is a DB test: it runs in CI.
- [ ] **Step 5: Commit.** `feat(server): credential expiry, rejection and verified write halves`.

## Part 2: The PTY, parsers, runner and store

### Task 4: Fake CLI `setup-token` mode

Implements spec §11.1. Needed by Tasks 5, 8 and 9.

**Files:**
- Create: `packages/harness/testing/synthetic-sign-in.mjs`
- Modify: `packages/harness/testing/fake-claude.mjs` (`index.ts` is unchanged: the wrapper `createFakeClaude` writes already exports `FAKE_CLAUDE_DIR`, and `opts.env` exists if a test needs more)
- Test: `packages/harness/testing/fake-setup-token.test.ts` (new; requires python3; skip locally without it, fail in CI without it)

**Interfaces:**
- Produces: running the fake with argv `setup-token` on a TTY prints the synthetic sign-in screen (constants exported from `synthetic-sign-in.mjs`: `SYNTHETIC_URL`, `SYNTHETIC_TOKEN`, `SYNTHETIC_CODE = "SYNTHETIC-CODE-1234"`), reads stdin raw; code `bad` → `OAuth error: Invalid code` then waits; `slow` → waits 70 s; other → success screen and exit 0. On start it writes its pid to `$FAKE_CLAUDE_DIR/setup-token.pid` (when `FAKE_CLAUDE_DIR` is set). Without a TTY: exits 1, stderr `Raw mode is not supported`.
- **Process liveness in every test and evidence check** (Tasks 5, 10, 24): read `setup-token.pid`, then `process.kill(pid, 0)` must throw `ESRCH` (in Python, `os.kill(pid, 0)` raises `ProcessLookupError`). Never `pgrep -f` on a title: Node's `process.title` does not change what `pgrep -f` matches on macOS (it reads the full argv, which Node does not rewrite there), so a title-based check is unreliable.

- [ ] **Step 1: Write the failing test** (`fake-setup-token.test.ts`), driving the fake (through a `createFakeClaude({ scenario: … })` wrapper, any existing scenario name) with a tiny inline `python3 -c` pty harness (test-only, no secrets), asserting: the output contains `the url below to sign in`, an OSC 8 hyperlink whose URI is `SYNTHETIC_URL`, and `Paste code here if prompted`; after writing `SYNTHETIC_CODE`, a 150 ms pause, then `\r`, output contains both token anchors and the process exits 0; with `bad`, output contains `OAuth error:`, and after the harness kills it the pid in `setup-token.pid` is gone (`ESRCH`); with no TTY, exit code 1.

```ts
const HARNESS = String.raw`
import os, pty, sys, time, select
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
code = os.environ["CODE"].encode()
out = b""; sent = False; t0 = time.time()
while time.time() - t0 < 10:
    r, _, _ = select.select([fd], [], [], 0.2)
    if fd in r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        out += d
    if not sent and b"Paste code here" in out:
        os.write(fd, code); time.sleep(0.15); os.write(fd, b"\r"); sent = True
sys.stdout.buffer.write(out)
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
_, st = os.waitpid(pid, 0)
sys.stderr.write("exit=%d\n" % os.waitstatus_to_exitcode(st))
`;
// Test-only harness: run as spawnSync("python3", ["-c", HARNESS, fakeWrapper, "setup-token"], { env: { ...minimalEnv, CODE } }).
// The success case asserts "exit=0" on stderr (the fake exits before the kill), the bad-code case asserts "OAuth error:".
```

- [ ] **Step 2: Run and confirm it fails.** `pnpm vitest run packages/harness/testing/fake-setup-token.test.ts` → FAIL.
- [ ] **Step 3: Implement.** The file today is: `process.title = "claude"` (`:9`), `const argv0 = process.argv.slice(2)`, an `if (argv0[0] === "plugin") { … }` block (to ~`:69`), then the scenario code at top level (`:71-205`, which reads `FAKE_CLAUDE_SCENARIO` and logs). Add a `setup-token` block **right after `argv0` and before the `plugin` block**, so it runs before any scenario read or env logging. It never returns into the code below: every terminal path calls `process.exit`, stdin `end` exits 1, and the block ends with `await new Promise(() => {})` (top-level await in an `.mjs`):

```js
if (argv0[0] === "setup-token") {
  const { SYNTHETIC_URL, SYNTHETIC_TOKEN } = await import("./synthetic-sign-in.mjs");
  if (process.env.FAKE_CLAUDE_DIR) writeFileSync(`${process.env.FAKE_CLAUDE_DIR}/setup-token.pid`, String(process.pid));
  if (!process.stdin.isTTY) { process.stderr.write("Raw mode is not supported\n"); process.exit(1); }
  const ESC = "\x1b", cols = process.stdout.columns || 80;
  const cha = (words) => words.join(`${ESC}[9G`);
  process.stdout.write(`Welcome to Claude Code v0.0.0-fake\r\n\r\n${cha(["Browser", "didn't", "open?", "Use", "the", "url", "below", "to", "sign", "in", "(c", "to", "copy)"])}\r\n\r\n`);
  process.stdout.write(`${ESC}]8;;${SYNTHETIC_URL}${ESC}\\${SYNTHETIC_URL.slice(0, cols - 1)}${ESC}]8;;${ESC}\\\r\n\r\n`);
  process.stdout.write("Hold Shift while selecting to use your terminal's native copy.\r\n\r\nPaste code here if prompted > ");
  process.stdin.setRawMode(true);
  let buf = "";
  process.stdin.on("data", (d) => {
    const s = d.toString("utf8");
    if (s !== "\r") { buf += s; process.stdout.write("*".repeat(s.length)); return; }
    process.stdin.pause();
    if (buf === "bad") { process.stdout.write("\r\nOAuth error: Invalid code\r\nPress Enter to retry.\r\n"); process.stdin.resume(); return; }
    const done = () => {
      const lines = SYNTHETIC_TOKEN.match(new RegExp(`.{1,${cols}}`, "g")) ?? [];
      process.stdout.write(`\r\n✓ Long-lived authentication token created successfully!\r\n\rYour OAuth token (valid for 1 year):\r\r\n${lines.join("\r\n")}\r\rStore this token securely. You won't be able to see it again.\r\n`);
      process.exit(0);
    };
    if (buf === "slow") setTimeout(done, 70_000); else done();
  });
  process.stdin.on("end", () => process.exit(1));
  await new Promise(() => {}); // never falls through to the plugin block or the scenario code
}
```

  The existing code below is unchanged byte for byte. `synthetic-sign-in.mjs` exports fixed made-up values: `SYNTHETIC_URL = "https://claude.com/cai/oauth/authorize?client_id=9d1c8f00-1a2b-3c4d-5e6f-708192a3b4c5&code=true&code_challenge=SYNTHETICchallengeAAAAAAAAAAAAAAAAAAAAAAAAAAAA&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&response_type=code&scope=user%3Ainference&state=SYNTHETICstateBBBBBBBBBBBB"`, `SYNTHETIC_TOKEN = "sk-ant-oat01-SYNTHETIC" + "x".repeat(80)`, `SYNTHETIC_CODE = "SYNTHETIC-CODE-1234"`. The bridge's env allow-list (Task 5) does not need to carry `FAKE_CLAUDE_DIR`: the wrapper script sets it inside itself, after the bridge's `execvp`.
- [ ] **Step 4: Run.** `pnpm vitest run packages/harness/testing/fake-setup-token.test.ts` → PASS locally with python3.
- [ ] **Step 5: Commit.** `test(harness): fake claude setup-token mode`.

### Task 5: PTY bridge and host transport

Implements spec §5.1, §5.2, D1–D4, R6.

**Files:**
- Create: `apps/server/src/credentials/sign-in/pty-bridge.ts`, `apps/server/src/credentials/sign-in/host-pty.ts`, `apps/server/src/credentials/sign-in/host-pty.test.ts`, `apps/server/src/credentials/sign-in/pty-bridge.test.ts`

**Interfaces:**
- Produces:
  - `export const PTY_BRIDGE: string`;
  - `export interface PtyRun { onData(cb: (chunk: string) => void): void; write(s: string): void; kill(): void; readonly exit: Promise<{ code: number | null }>; readonly dir: string }`;
  - `export function bridgeSpawnArgs(claudeBin: string): string[]` → `["-I", "-S", "-c", PTY_BRIDGE, claudeBin, "setup-token"]`;
  - `export function bridgeEnv(serverEnv: NodeJS.ProcessEnv, dir: string): Record<string, string>`;
  - `export async function startHostPty(d: { claudeBin: string; serverEnv?: NodeJS.ProcessEnv; spawnFn?: typeof spawn; tmp?: string }): Promise<PtyRun>` (rejects `new PtyUnavailable()` on ENOENT);
  - `export class PtyUnavailable extends Error {}`;
  - `export function probePython(spawnFn?: typeof spawn): Promise<boolean>` (cached by the caller);
  - `export async function sweepStaleDirs(tmp: string, now: number, uid = process.getuid?.()): Promise<void>` — acts only on direct children of `tmp` whose name starts with exactly `of-sign-in-`, inspected with `lstat` (a symlink is never followed or deleted through), owned by `uid`, a directory, and with mtime older than 15 minutes; everything else is left alone.

- [ ] **Step 1: Write failing tests.**

`pty-bridge.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PTY_BRIDGE } from "./pty-bridge.ts";

describe("PTY_BRIDGE", () => {
  it("is fixed text: no template interpolation, no backtick", () => {
    expect(PTY_BRIDGE).not.toContain("${");
    expect(PTY_BRIDGE).not.toContain("`");
  });
  it("sets the window in the child before exec and kills the CLI's group", () => {
    expect(PTY_BRIDGE).toMatch(/TIOCSWINSZ/);
    expect(PTY_BRIDGE.indexOf("TIOCSWINSZ")).toBeLessThan(PTY_BRIDGE.indexOf("execvp"));
    expect(PTY_BRIDGE).toMatch(/killpg\(pid, signal\.SIGKILL\)/);
    expect(PTY_BRIDGE).toMatch(/SIGINT/);
  });
});
```

`host-pty.test.ts` (pure parts with a spawn spy; the end-to-end parts need python3 and the Task 4 fake):

```ts
it("spawns python3 with the exact argv, env allow-list, detached and four pipes", async () => {
  const calls: unknown[][] = [];
  const spawnFn = ((...a: unknown[]) => { calls.push(a); return fakeChild(); }) as never;
  const run = await startHostPty({ claudeBin: "/opt/claude", serverEnv: { PATH: "/usr/bin", LANG: "en_US.UTF-8", DATABASE_URL: "postgres://x", FACTORY_SECRET_KEY: "k", GH_TOKEN: "g", CLAUDE_CODE_OAUTH_TOKEN: "t" }, spawnFn });
  const [cmd, args, opts] = calls[0] as [string, string[], { env: Record<string, string>; detached: boolean; stdio: string[] }];
  expect(cmd).toBe("python3");
  expect(args).toEqual(["-I", "-S", "-c", PTY_BRIDGE, "/opt/claude", "setup-token"]);
  expect(opts.detached).toBe(true);
  expect(opts.stdio).toEqual(["pipe", "pipe", "pipe", "pipe"]);
  expect(opts.env).toEqual({
    PATH: "/usr/bin", LANG: "en_US.UTF-8", TERM: "xterm-256color", HOME: run.dir, CLAUDE_CONFIG_DIR: run.dir,
    BROWSER: "true", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "",
  });
  expect((await stat(run.dir)).mode & 0o777).toBe(0o700);
  run.kill(); await run.exit;
  await expect(stat(run.dir)).rejects.toThrow();
});
it("ENOENT is PtyUnavailable", async () => { /* spawnFn emitting error {code:"ENOENT"} → rejects PtyUnavailable, dir removed */ });
it("probePython: non-zero exit and a 5 s timeout are unavailable", async () => { /* stubs */ });
it("sweepStaleDirs removes only own, real, old of-sign-in-* dirs", async () => {
  // in a temp parent: an old own dir (removed); a symlink named of-sign-in-link → an old dir elsewhere (link and target left alone);
  // an old dir with a stubbed uid mismatch (sweepStaleDirs(tmp, now, uid + 1) for that case, left alone); a 5-minute-old dir (left alone);
  // an old dir named xof-sign-in-y and one nested a level down (left alone)
});

describe.skipIf(!hasPython && !process.env.CI)("real bridge with the fake CLI", () => {
  it("fails in CI without python3", () => { if (process.env.CI) expect(hasPython).toBe(true); });
  it("stdin EOF, SIGTERM and SIGINT leave no CLI", async () => { /* startHostPty with a createFakeClaude wrapper; each kill path; the pid in <fake.dir>/setup-token.pid is gone (process.kill(pid, 0) throws ESRCH) */ });
  it("SIGKILL of the bridge, then the transport fallback, leaves no CLI", async () => { /* process.kill(bridgePid,"SIGKILL"); run.kill(); setup-token.pid's process is gone (ESRCH) */ });
});
it("drains the bridge's stderr and never forwards it", async () => {
  // spawnFn returns a fake child whose stderr emits "BRIDGE-STDERR-MARKER": assert stderr was resumed
  // (flowing) and that no onData callback, exit value or thrown error contains the marker. host-pty.ts has no logger.
});
```

- [ ] **Step 2: Run and confirm failure.** `pnpm vitest run apps/server/src/credentials/sign-in` → FAIL.
- [ ] **Step 3: Implement `pty-bridge.ts`:**

```ts
/** Spec §5.1: fixed script, run as `python3 -I -S -c PTY_BRIDGE <claudeBin> setup-token`. Never interpolate into it. */
export const PTY_BRIDGE = String.raw`
import errno, fcntl, os, pty, select, signal, struct, sys, termios
pid, master = pty.fork()
if pid == 0:
    try:
        os.close(3)
    except OSError:
        pass
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
    try:
        os.execvp(sys.argv[1], sys.argv[1:])
    finally:
        os._exit(127)
os.write(3, (str(pid) + "\n").encode())
os.close(3)
def stop(_s=None, _f=None):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os._exit(1)
for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(s, stop)
while True:
    readable, _, _ = select.select([master, 0], [], [])
    if 0 in readable:
        data = os.read(0, 4096)
        if not data:
            stop()
        os.write(master, data)
    if master in readable:
        try:
            data = os.read(master, 65536)
        except OSError as e:
            if e.errno == errno.EIO:
                break
            raise
        if not data:
            break
        os.write(1, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
```

  Note `sys.argv` under `-c` is `["-c", claudeBin, "setup-token"]`, so `sys.argv[1:]` is the CLI argv.

  Implement `host-pty.ts`: `mkdtemp(join(tmp ?? tmpdir(), "of-sign-in-"))` then `chmod(dir, 0o700)`; `bridgeEnv` copies only `PATH` and `LANG` when set, plus the fixed keys above; spawn with `bridgeSpawnArgs`; `stdout` through `new TextDecoder("utf-8", { fatal: false })` with `{ stream: true }`; `stderr.resume()`; read the child pid from `stdio[3]` (first line, `/^\d+$/`); `kill()`: `stdin.end()`, then `setTimeout(1000)` → `child.kill("SIGTERM")`, then `setTimeout(2000)` → `child.kill("SIGKILL")` and `process.kill(-childPid, "SIGKILL")` in try/catch; on `exit` clear timers and `rm(dir, { recursive: true, force: true })`; `exit` promise resolves `{ code }`. No logging at all in this file.
- [ ] **Step 4: Run.** `pnpm vitest run apps/server/src/credentials/sign-in` → PASS (real-bridge cases run here with python3).
- [ ] **Step 5: Commit.** `feat(server): python3 PTY bridge and host transport for setup-token`.

### Task 6: Parsers and the synthetic fixture

Implements spec §5.3 (parsers), §7.3.

**Files:**
- Create: `apps/server/src/credentials/sign-in/setup-token.ts` (parsers part), `apps/server/src/credentials/sign-in/setup-token-parse.test.ts`, `apps/server/src/credentials/sign-in/__fixtures__/setup-token.SYNTHETIC.txt`, `apps/server/src/credentials/sign-in/fixtures.test.ts`

**Interfaces:**
- Produces: `stripTerminal(text: string): string`, `parsePrompt(buf: string): { url: string } | null`, `parseToken(buf: string): string | null`, `hasOAuthError(buf: string): boolean`, constants `AUTH_URLS`, `REDIRECT_URI`, `TOKEN_BEFORE`, `TOKEN_AFTER`.

- [ ] **Step 1: Write the fixture.** First line: `# SYNTHETIC fixture — no real URL, code or token. Built from Paperclip's tested parser cases (MIT), 2026-11-23.` Then sections separated by a line `=== <case> ===`: `prompt-osc8` (CHA-spaced preamble, OSC 8 hyperlink with the Task 4 `SYNTHETIC_URL`, the copy hint, `Paste code here if prompted >`), `prompt-wrapped-claude-ai` (the same query on `https://claude.ai/oauth/authorize`, hard-wrapped at 64 columns, no OSC 8), `success-cr-joined` (anchor, CR, the synthetic token wrapped at 40 columns, CR, after-anchor). The test reads sections by name and keeps escape bytes (`\x1b`) literally in the file.
- [ ] **Step 2: Write failing tests** (`setup-token-parse.test.ts`), one `it` per spec §7.3 case. Build URLs from parts like Paperclip's tests do:

```ts
const Q = ["client_id=9d1c8f00-1a2b-3c4d-5e6f-708192a3b4c5", "code=true",
  "code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "code_challenge_method=S256",
  `redirect_uri=${encodeURIComponent("https://platform.claude.com/oauth/code/callback")}`,
  "response_type=code", `scope=${encodeURIComponent("user:inference")}`, "state=Xy7Kd2Pq9Rn4Vb8Lf1Mw6Zc3Hj0Tg5Us"].join("&");
const COM = `https://claude.com/cai/oauth/authorize?${Q}`;
const AI = `https://claude.ai/oauth/authorize?${Q}`;
const PRE = "Browser didn't open? Use the url below to sign in (c to copy)";
const PROMPT = "Paste code here if prompted >";
const out = (url: string, ...extra: string[]) => [PRE, url, ...extra, PROMPT].join("\n");

it.each([COM, AI])("accepts %s", (u) => expect(parsePrompt(out(u))?.url).toBe(u));
it("reads the URI of an OSC 8 link, not its wrapped text", () => {
  const link = `\x1b]8;;${COM}\x1b\\${COM.slice(0, 50)}\n${COM.slice(50, 90)}\x1b]8;;\x1b\\`;
  expect(parsePrompt([PRE, link, PROMPT].join("\n"))?.url).toBe(COM);
});
it("joins a hard-wrapped URL", () => expect(parsePrompt([PRE, ...AI.match(/.{1,64}/g)!, PROMPT].join("\n"))?.url).toBe(AI));
it("skips repeats and the copy hint", () => expect(parsePrompt(out(COM, COM, "Hold Shift while selecting to use your terminal's native copy."))?.url).toBe(COM));
it.each([
  ["look-alike host", COM.replace("claude.com", "claude.com.evil.io")],
  ["mixed case", COM.replace("claude.com", "Claude.com")],
  ["punycode", COM.replace("claude.com", "xn--claude-9ya.com")],
  ["port", COM.replace("claude.com", "claude.com:443")],
  ["userinfo", COM.replace("https://", "https://a@")],
  ["fragment", `${COM}#x`],
  ["duplicate key", `${COM}&state=Xy7Kd2Pq9Rn4Vb8Lf1Mw6Zc3Hj0Tg5Us`],
  ["missing key", COM.replace(/&state=[^&]+/, "")],
  ["wrong redirect", COM.replace("platform.claude.com", "evil.io")],
  ["five extra keys", `${COM}&a=1&b=1&c=1&d=1&e=1`],
  ["sk-ant in a value", `${COM}&x=sk-ant-oops`],
  ["sk-ant in a decoded key", `${COM}&sk%2Dant%2Dx=1`],
])("refuses %s", (_n, u) => expect(parsePrompt(out(u))).toBeNull());
it("refuses a prompt sharing prose or on the wrong line", () => {
  expect(parsePrompt([PRE, COM, "Paste code here if prompted, or not"].join("\n"))).toBeNull();
  expect(parsePrompt([PRE, COM, "something", PROMPT].join("\n"))).toBeNull();
});
it("refuses a URL more than 512 characters after the preamble", () => expect(parsePrompt([PRE, "x".repeat(600), COM, PROMPT].join("\n"))).toBeNull());

const TOK = `sk-ant-oat01-SYNTHETIC${"a".repeat(60)}`;
const BEFORE = "Your OAuth token (valid for 1 year):";
const AFTER = "Store this token securely. You won't be able to see it again.";
it("reads a wrapped, CR-joined token", () => expect(parseToken(`${BEFORE}\r${TOK.slice(0, 40)}\r\n${TOK.slice(40)}\r${AFTER}`)).toBe(TOK));
it.each([
  ["outside anchors", `${TOK}\n${BEFORE}\n${AFTER}`],
  ["anchors twice", `${BEFORE}\n${TOK}\n${AFTER}\n${BEFORE}\n${TOK}\n${AFTER}`],
  ["out of order", `${AFTER}\n${TOK}\n${BEFORE}`],
  ["prose between", `${BEFORE}\n${TOK}\nhello there\n${AFTER}`],
  ["wrong prefix", `${BEFORE}\nsk-ant-api03-${"a".repeat(40)}\n${AFTER}`],
  ["too short", `${BEFORE}\nsk-ant-oat01-abc\n${AFTER}`],
])("refuses a token %s", (_n, s) => expect(parseToken(s)).toBeNull());
it("detects an OAuth error through colours", () => expect(hasOAuthError("\x1b[31mOAuth error:\x1b[0m Invalid code")).toBe(true));
```

`fixtures.test.ts`: for every file in `__fixtures__`, (a) fails if it contains `/sk-ant-oat01-(?!SYNTHETIC)/`, (b) fails if any `code_challenge=` or `state=` value is not one of the synthetic values listed in a `SYNTHETIC_VALUES` array in the test, (c) runs `parsePrompt` on each prompt section and `parseToken` on each success section and expects non-null.
- [ ] **Step 3: Run and confirm failure.** `pnpm vitest run apps/server/src/credentials/sign-in/setup-token-parse.test.ts apps/server/src/credentials/sign-in/fixtures.test.ts` → FAIL.
- [ ] **Step 4: Implement the parsers** in `setup-token.ts`, following spec §5.3 exactly (regexes: OSC 8 `/\x1b\]8;[^;\x1b\x07]*;([^\x1b\x07]*)(?:\x1b\\|\x07)[\s\S]*?\x1b\]8;[^;\x1b\x07]*;(?:\x1b\\|\x07)/g` → `$1`; other OSC `/\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)/g` → `""`; horizontal moves `/\x1b\[[0-9;]*[GC]/g` → `" "`; CSI `/\x1b\[[0-?]*[ -/]*[@-~]/g` → `""`; then `\r\n|\r` → `\n`). Value patterns: `client_id` `^[A-Za-z0-9._~-]{1,128}$`, `code` `^[A-Za-z0-9._~-]{1,1024}$`, `code_challenge` `^[A-Za-z0-9_-]{43,128}$`, `state` `^[A-Za-z0-9_-]{16,256}$`, scope 1–8 space-separated tokens `^[A-Za-z0-9:._-]{1,64}$` and ≤ 512 chars, extra keys `^[a-z][a-z0-9_-]{0,63}$` with values `^[\x20-\x7E]{0,256}$`. Never include input in a thrown error; the functions don't throw.
- [ ] **Step 5: Run.** Both test files PASS.
- [ ] **Step 6: Commit.** `feat(server): setup-token prompt and token parsers with a synthetic fixture`.

### Task 7: Runner

Implements spec §5.3 (runner), Q12.

**Files:**
- Modify: `apps/server/src/credentials/sign-in/setup-token.ts`
- Create: `apps/server/src/credentials/sign-in/runner.test.ts`

**Interfaces:**
- Consumes: `PtyRun` (Task 5), parsers (Task 6).
- Produces:

```ts
export type RunFailure = "start_failed" | "code_rejected" | "exchange_failed" | "aborted";
export interface SetupTokenRun {
  readonly prompt: Promise<{ url: string }>;          // rejects RunFailed("start_failed" | "aborted")
  submit(code: string): Promise<string>;              // resolves the token; rejects RunFailed
  abort(): void;                                      // kills the PTY; idempotent
}
export class RunFailed extends Error { constructor(readonly reason: RunFailure) { super(reason); } }
export function runSetupToken(pty: PtyRun, o?: { settleMs?: number; startMs?: number; exchangeMs?: number; setTimer?: typeof setTimeout }): SetupTokenRun;
```

- [ ] **Step 1: Write failing tests** with an in-memory `PtyRun`:

```ts
function fakePty() {
  let cb: (s: string) => void = () => {};
  const writes: string[] = []; let killed = 0; let resolveExit!: (v: { code: number | null }) => void;
  const exit = new Promise<{ code: number | null }>((r) => { resolveExit = r; });
  return { pty: { onData: (f: (s: string) => void) => { cb = f; }, write: (s: string) => writes.push(s), kill: () => { killed++; resolveExit({ code: null }); }, exit, dir: "/tmp/x" },
    emit: (s: string) => cb(s), writes, killed: () => killed, exitWith: (c: number) => resolveExit({ code: c }) };
}
it("resolves the prompt across chunk boundaries", async () => {
  const f = fakePty(); const r = runSetupToken(f.pty, { settleMs: 0 });
  const text = [PRE, COM, PROMPT].join("\n");
  f.emit(text.slice(0, 30)); f.emit(text.slice(30));
  await expect(r.prompt).resolves.toEqual({ url: COM });
});
it("writes the code, then a separate CR after settleMs, and returns the token", async () => {
  vi.useFakeTimers(); const f = fakePty(); const r = runSetupToken(f.pty, { settleMs: 150 });
  f.emit([PRE, COM, PROMPT].join("\n")); await r.prompt;
  const p = r.submit("abc#def");
  expect(f.writes).toEqual(["abc#def"]);
  await vi.advanceTimersByTimeAsync(150);
  expect(f.writes).toEqual(["abc#def", "\r"]);
  f.emit(`${BEFORE}\n${TOK}\n${AFTER}\n`);
  await expect(p).resolves.toBe(TOK);
  expect(f.killed()).toBe(1);
});
it("an OAuth error is code_rejected and kills", async () => { /* emit "OAuth error: x" after submit → rejects RunFailed("code_rejected") */ });
it("exit without a token is exchange_failed", async () => { /* f.exitWith(0) */ });
it("no prompt in 30 s is start_failed", async () => { /* fake timers */ });
it("no token in 60 s is exchange_failed", async () => {});
it("abort in each state rejects with aborted and kills once", async () => {});
it("bounds the prompt buffer to 64 KB and still finds a later prompt", async () => {});
it("never puts CLI text in an error", async () => { /* emit secrets, fail, assert String(err) and err.message equal the reason only */ });
```

- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement** the state machine in spec §5.3's table. Keep the code in a local and drop it after the CR write. On each terminal state call `pty.kill()` once. Rejections carry only `RunFailed(reason)`.
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit.** `feat(server): setup-token runner`.

### Task 8: Attempt store

Implements spec §5.4 in full (the state table), D6–D9, D17, Q13.

**Files:**
- Create: `apps/server/src/credentials/sign-in/attempts.ts`, `apps/server/src/credentials/sign-in/attempts.test.ts`

**Interfaces:**
- Consumes: `startHostPty`/`PtyRun` (Task 5, injected as `startPty`), `runSetupToken` (Task 7, injected), `CredentialVerifier.verify`, `CredentialService.nameTaken`, `byName`, `insertVerified`, `replaceVerified` (Task 3), `MSG` (Task 1).
- Produces:

```ts
// Refusals are the existing ApiError / FieldError (apps/server/src/errors.ts): ApiError(status, code, message, extra?),
// with extra = { attempt } where spec §5.5 says the answer carries the attempt. No separate error class.
export type Outcome = { status: 200 | 201; credential: CredentialSummary };
export class SignInAttempts {
  constructor(d: {
    startPty(): Promise<PtyRun>;
    run(pty: PtyRun): SetupTokenRun;
    verify(value: string): Promise<VerifyResult>;
    credentials: Pick<CredentialService, "nameTaken" | "byName" | "insertVerified" | "replaceVerified">;
    now(): number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
    ttlMs?: number; cap?: number; waitMs?: number; keepMs?: number; retryMs?: number;
    newId?(): string; log: { info(o: object, m: string): void };
  });
  view(userId: string): AttemptView | null;
  start(userId: string, purpose: { replace?: string }): Promise<AttemptView>;        // ApiError on refusal
  submit(userId: string, attemptId: string, body: { code: string; name?: string }): Promise<Outcome | AttemptView>; // AttemptView = 202
  wait(userId: string, attemptId: string): Promise<Outcome | AttemptView>;
  cancel(userId: string, attemptId: string): Promise<void>;
  endFor(userId: string): void;
  closeAll(): Promise<void>;
}
```

  Error codes and statuses exactly as spec §5.5. `log.info` is called only with `{ userId, attemptId, reason }` and the messages `"sign-in started"` / `"sign-in ended"`.

- [ ] **Step 1: Write failing tests** (pure, injected clock and fakes). One `it` per row and rule:

```ts
it("starting is reserved synchronously: a second start while starting is 409", async () => {
  const s = store({ startPty: never() }); // a pty that never yields a prompt
  const first = s.start("u1", {});
  await expect(s.start("u1", {})).rejects.toMatchObject({ status: 409, code: "sign_in_state" });
  s.endFor("u1"); await expect(first).rejects.toBeDefined();
});
it("start ends an awaiting_code attempt and makes a new attemptId", async () => {});
it("the cap counts starting; the 4th user's start is 429 sign_in_busy", async () => {});
it("a submit in flight (submitting) holds its slot against the cap", async () => {});
it("isLive is true for starting, awaiting_code, submitting, exchanging and verifying only", () => {});
it("an attemptId mismatch is 409 sign_in_replaced and leaves the run untouched", async () => {});
it("another user with no attempt is 404 for code, wait and cancel whatever the id", async () => {});
it("name is checked before the code is written; failure returns to awaiting_code with the original deadline", async () => {
  const pty = promptingPty(); const s = store({ pty, nameTaken: async () => true });
  const a = await s.start("u1", {});
  await expect(s.submit("u1", a.attemptId, { code: "abc", name: "work" })).rejects.toMatchObject({ status: 409, code: "credential_exists" });
  expect(pty.writes).toEqual([]);
  expect(s.view("u1")).toMatchObject({ state: "awaiting_code", codeDeadline: a.codeDeadline });
});
it("a second submit during submitting is 409 sign_in_state", async () => {});
it("TTL while waiting kills, removes, tombstones: a late code is 410 for 60 s, then 404", async () => {});
it("submit clears the TTL: an exchange past 10 minutes still saves", async () => {});
it("verification unreachable is retried once after 3 s, then 502 claude_unreachable (FIELD_MSG.claudeUnreachable) and the token is dropped", async () => {});
it("verification rejected is 422 sign_in_token_rejected with FIELD_MSG.tokenRejected", async () => {});
it("create saves with expiresAt = token time + 365 d; replace uses replaceVerified by id", async () => {});
it("replace whose credential was deleted fails before the code is written (404, attempt ends)", async () => {});
it("a name race at insert is 409 sign_in_name_taken and ends the attempt", async () => {});
it("submit waits up to waitMs then answers the AttemptView (202); wait returns the outcome later", async () => {});
it("wait on awaiting_code is 409 sign_in_state with the attempt", async () => {});
it("the settled outcome is kept keepMs, then wait is 404", async () => {});
it("cancel and start are refused in exchanging/verifying; endFor leaves them alone", async () => {});
it("closeAll kills every pty", async () => {});
it("never logs the URL, code or token", async () => { /* capture log calls; JSON.stringify contains none of the synthetic strings */ });
```

- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement.** One exported `isLive(state)` helper (`starting`, `awaiting_code`, `submitting`, `exchanging`, `verifying`) used by both the cap count and `endFor`'s selection. One `Map<userId, Attempt>` plus `Map<userId, Tombstone>`. `start`: check the existing attempt per the table, reserve `{ state: "starting", attemptId }` and count it against the cap **before** the first `await`; then `startPty()` (a `PtyUnavailable` → 503 `sign_in_unavailable`), `run(pty)`, `await run.prompt` (failure → kill, 502 `sign_in_start_failed`), set `awaiting_code`, `url`, `codeDeadline = now + ttl`, arm the TTL timer. `submit`: user lookup → 404; id check → 409 `sign_in_replaced`; state check → 409; set `submitting` synchronously; `normalizeSignInCode` → 400 `validation_error` `{ fields: { code: MSG.signInCode } }` (back to `awaiting_code`); create: `nameSchema.safeParse` → 400 `{ fields: { name } }`, `await nameTaken` → 409 `credential_exists` (back to `awaiting_code`); replace: `await byName(purpose.name)` must match `credentialId` → else end, 404 `credential_not_found` with `MSG.credentialDeleted`; clear TTL; `exchanging`; build the `outcome` promise (`run.submit(code)` → `mintedAt = now()` → `verifying` → verify with one retry after `retryMs` → `insertVerified`/`replaceVerified` → `settled`, schedule drop after `keepMs`); map `RunFailed("code_rejected")` → 422 `sign_in_code_rejected`, `exchange_failed` → 502 `sign_in_failed`, a unique violation → 409 `sign_in_name_taken`; a verifier `rejected` → 422 `sign_in_token_rejected` with the verifier's own `r.message` (`FIELD_MSG.tokenRejected`), `unreachable` after the retry → 502 `claude_unreachable` with `FIELD_MSG.claudeUnreachable`. Code and name field errors are `new FieldError(field, MSG.…)` with constant messages (`field-messages.test.ts` forbids a template literal in a `FieldError`). Return `Promise.race([outcome, timeout(waitMs) → view])`. The token stays a local of the outcome function.
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit.** `feat(server): sign-in attempt store`.

### Task 9: Routes, wiring and the secret-capture test

Implements spec §5.5, AC5, AC6, AC10, D19, D20.

**Files:**
- Create: `apps/server/src/routes/claude-sign-in.ts`, `apps/server/src/routes/claude-sign-in.test.ts` (CI only: DB via `makeTestApp`), `apps/server/src/test/sign-in-helpers.ts`
- Modify: `apps/server/src/app.ts` (construct `SignInAttempts` **after** `CredentialService` (~`:324`) and **before** `UserAdminService` (~`:351`), which takes it in Task 10, with `startPty: () => startHostPty({ claudeBin: config.claudeBin, spawnFn: deps.signInSpawn })`, `runSetupToken`, the verifier, the credential service; decorate `app.signIn`; register routes next to `credentialsRoutes` (~`:439-445`); cache `probePython()`; add `AppDeps.signInSpawn?: typeof spawn`, the real `spawn` when absent), `apps/server/src/test/helpers.ts` (`TestAppOptions.logLevel?: string`, default `"info"`, used where the capture logger sets `level: "info"` (~`:82`); `TestAppOptions.signInSpawn` passed through like `docker`), `apps/server/src/routes/credentials.ts` (after a successful POST create, `app.signIn.endFor(userId)`)

**Interfaces:**
- Consumes: Task 8 store, Task 1 schemas.
- Produces: the five routes of spec §5.5; `app.signIn: SignInAttempts`; `app.signInAvailable(): Promise<boolean>`. The store throws `ApiError`/`FieldError` (Task 8), so the routes need no error mapping.

- [ ] **Step 1: Write the helper and failing route tests** (CI only). `test/sign-in-helpers.ts`: `appWithFakeClaude(o?: { logLevel?: string; logStream?: { write(s: string): void } })` creates `const fake = createFakeClaude({ scenario: <an existing scenario> })`, records spawn calls with `signInSpawn: (...a) => { spawnCalls.push(a); return spawn(...a); }`, builds `makeTestApp({ env: { FACTORY_CLAUDE_BIN: fake.bin }, signInSpawn, ...o })`, signs up a user with the existing `signUp(t.app)` (returns `{ cookie, user, … }`), and returns `{ t, app: t.app, cookie, fake, spawnCalls }`. Tests that need a second user call `signUp(app)` again. The bridge-stderr guarantee is proven in `host-pty.test.ts` (Task 5), not here.

```ts
it("signs in and creates a credential (AC1)", async () => {
  const { app, cookie } = await appWithFakeClaude();
  const s = await app.inject({ method: "POST", url: "/api/claude-sign-in", headers: { cookie }, payload: {} });
  expect(s.statusCode).toBe(200);
  const { attempt } = s.json(); expect(attempt.url).toBe(SYNTHETIC_URL);
  const c = await app.inject({ method: "POST", url: "/api/claude-sign-in/code", headers: { cookie }, payload: { attemptId: attempt.attemptId, code: SYNTHETIC_CODE, name: "work" } });
  expect(c.statusCode).toBe(201);
  expect(c.json().credential).toMatchObject({ name: "work", kind: "oauth_token", rejected: false });
  expect(Date.parse(c.json().credential.expiresAt) - Date.now()).toBeGreaterThan(364 * 86400_000);
});
it("never logs, returns or spawns a secret (AC5)", async () => {
  const lines: string[] = [];
  const { app, cookie, spawnCalls } = await appWithFakeClaude({ logLevel: "trace", logStream: { write: (l: string) => lines.push(l) } });
  // full sign-in as above, plus a failing code ("bad") run and a cancel; collect every response body
  const logs = lines.join("\n");
  for (const secret of [SYNTHETIC_URL, "SYNTHETICchallenge", SYNTHETIC_CODE, SYNTHETIC_TOKEN, "sk-ant-oat01"]) expect(logs).not.toContain(secret);
  for (const body of nonStartResponseBodies) expect(body).not.toContain(SYNTHETIC_URL);
  for (const body of allResponseBodies) { expect(body).not.toContain(SYNTHETIC_TOKEN); expect(body).not.toContain(SYNTHETIC_CODE); }
  expect(JSON.stringify(spawnCalls)).not.toContain(SYNTHETIC_CODE);
});
it("isolation between users and tabs (AC6)", async () => { /* user B GET → attempt null; B code/wait/DELETE → 404; A stale id → 409 sign_in_replaced */ });
it("a credential named sign-in can still be deleted", async () => { /* DELETE /api/credentials/sign-in → 204 */ });
it("python3 missing: GET available false, POST 503 sign_in_unavailable (AC10)", async () => { /* PATH without python3 */ });
it("replace via sign-in keeps the id and assignments and restarts (AC8)", async () => {});
it("replace of an api_key credential is 400 signInOAuthOnly", async () => {});
it("a paste add ends the user's awaiting_code attempt", async () => {});
```

- [ ] **Step 2: Run typecheck** (`pnpm typecheck` → FAIL: routes missing). The DB tests run in CI.
- [ ] **Step 3: Implement `routes/claude-sign-in.ts`.** `onRequest: requireUser` and `req.user.id`, as `routes/inbox.ts:31-32`; schemas from Task 1. Errors go through the existing envelope `{ error: { code, message, ...extra } }` (`errors.ts:28`): the store throws `ApiError(status, code, message, extra)` (with `extra = { attempt }` where spec §5.5 says the answer carries the attempt) and `FieldError(field, message)` for the code and name errors (400 `validation_error` with `{ fields: { [field]: message } }`); the route lets them propagate to the error handler, with no mapping of their own. `credential_exists` is raised exactly as `CredentialService.create` raises it today (same status and body). `Outcome` → `reply.code(o.status).send({ credential })`; an `AttemptView` result → `reply.code(202).send({ attempt })`. `GET` → `{ available: await app.signInAvailable(), attempt: app.signIn.view(userId) }`. `DELETE /api/claude-sign-in/:attemptId`. No `request.log` calls with bodies. Register in `app.ts` next to `credentialsRoutes`.
- [ ] **Step 4: Verify locally.** `pnpm typecheck`. The route test is a DB test: push for CI.
- [ ] **Step 5: Commit.** `feat(server): /api/claude-sign-in routes`.

### Task 10: endFor hooks, shutdown and boot sweep

Implements spec §5.4 (ends without a request), §5.2 (boot sweep), AC4.

**Files:**
- Modify: `apps/server/src/routes/auth.ts`, `apps/server/src/users/user-admin.ts`, `apps/server/src/app.ts` (shutdown step and boot sweep), `apps/server/src/users/user-admin.test.ts` and an auth route test (CI only)

**Interfaces:**
- Consumes: `app.signIn.endFor`, `closeAll`, `sweepStaleDirs`.

- [ ] **Step 1: Write failing tests** (CI only): sign-out (`POST /api/auth/sign-out` with the cookie) after a started attempt → the user's attempt is gone (`GET /api/claude-sign-in` → `attempt: null`) and the fake process is gone (the pid in `<fake.dir>/setup-token.pid`: `process.kill(pid, 0)` throws `ESRCH`, polled for up to 5 s since the kill path escalates over 3 s); disabling a user ends their attempt; `app.close()` ends every attempt. `user-admin.test.ts` constructs `UserAdminService` directly: add a recording `signIn: { endFor }` stub to its deps.
- [ ] **Step 2: Implement.**
  - `auth.ts` (one `app.route` for `/api/auth/*` with `url.pathname`, `headers` and `request` in scope): when `request.method === "POST" && url.pathname === "/api/auth/sign-out"`, before forwarding resolve `const session = await app.auth.api.getSession({ headers })`; after `res.status` is 2xx, `if (session) app.signIn.endFor(session.user.id)`.
  - `user-admin.ts`: its deps type is `{ db, now, bus }` (`users/user-admin.ts:9`); add `signIn: Pick<SignInAttempts, "endFor">`; call `this.d.signIn.endFor(targetId)` next to `this.d.bus.closeUser(targetId)` (~`:84`).
  - `app.ts`: in the `onClose` hook, before the DB closes: `await app.signIn.closeAll()`. After boot reconciliation: `void sweepStaleDirs(tmpdir(), clock().getTime())`.
- [ ] **Step 3: Verify.** `pnpm typecheck`; CI for the DB tests.
- [ ] **Step 4: Commit.** `feat(server): end sign-in attempts on sign-out, disable and shutdown`.

### Task 11: Expiry check and the credential inbox item

Implements spec §5.7, §5.8, AC8, D11, D12.

**Files:**
- Create: `apps/server/src/credentials/expiry-check.ts`, `apps/server/src/credentials/expiry-check.test.ts` (CI only)
- Modify: `apps/server/src/agents/event-store.ts` (`createHumanMessage` ~`:948-1030`, `inboxRows` ~`:1390`, `toEntries` ~`:1419`), `apps/server/src/app.ts` (construct near ~`:414`; `stop()` first in the `onClose` hook ~`:417`; `idle()` with the others; `void expiryCheck.run(); expiryCheck.start();` in the boot `try` right after `uploadSweep.start()` ~`:508-512`)

**Interfaces:**
- Consumes: Task 2 columns, `createHumanMessage`, `bus.publishToUser`, `config.factoryTimezone`.
- Produces: `class ExpiryCheck { constructor(d: { db; store: EventStore; bus: Pick<EventBus, "publishToUser">; zone: string; now(): Date; log; interval?: number }); start(): void; stop(): void; idle(): Promise<void>; run(): Promise<void> }`, shaped like `UploadSweep` (`apps/server/src/uploads/sweep.ts`): `timer.unref()`, errors logged, never thrown; `createHumanMessage({ …, subjectCredentialId?: string, createdAt?: Date, inboxKind?: "message" | "mention" | "task_event" | "credential" })` (DB names; a `system` row requires `subjectAgentId` **or** `subjectCredentialId`); inbox entries for credential messages: `kind: "credential"`, `from: { kind: "factory", name: "factory" }`, no `about`, `credential: { name, expiresAt, current }`, `link: { kind: "credential", name }`.

- [ ] **Step 1: Write failing tests** (CI only). `setup`, `addCredential` and `inboxFor` are helpers this new file defines (on `createTestDb` + a real `EventStore`, or `makeTestApp`), not existing ones:

```ts
it("notifies once per user within 14 days, never for null expires_at", async () => {
  const { check, db, users } = await setup({ now: new Date("2027-11-01T00:00:00Z") });
  await addCredential(db, { name: "work", expiresAt: new Date("2027-11-12T00:00:00Z") });
  await addCredential(db, { name: "pasted", expiresAt: null });
  await check.run(); await check.run();
  const items = await inboxFor(db, users[0]);
  expect(items.filter((i) => i.kind === "credential")).toHaveLength(1);
  expect(items[0]).toMatchObject({ preview: "work expires on 2027-11-12.", link: { kind: "credential", name: "work" }, credential: { name: "work", current: true } });
});
it("two concurrent runs make one message", async () => { await Promise.all([check.run(), check.run()]); /* count messages with subject = 1 */ });
it("an already expired credential says expired on", async () => {});
it("replace re-arms (current false, next run within 14 days notifies again)", async () => {});
it("deleting the credential cascades the notice", async () => {});
it("publishes inbox_changed to each addressee after commit", async () => {});
```

- [ ] **Step 2: Implement.** `run()`: `const at = this.d.now();` select candidates (spec §5.7 step 1, using `at` as now); per credential `db.transaction(async (tx) => { const [hit] = await tx.update(credentials).set({ expiryNotifiedAt: at }).where(and(eq(credentials.id, c.id), isNull(credentials.expiryNotifiedAt))).returning({ id: credentials.id }); if (!hit) return []; const past = c.expiresAt <= at; const date = formatDateInZone(c.expiresAt, zone) /* YYYY-MM-DD via Intl.DateTimeFormat("en-CA", { timeZone }) */; const { userIds } = await store.createHumanMessage({ kind: "system", notice: "credential_expiring", subjectCredentialId: c.id, to: "all", inboxKind: "credential", body: `${c.name} ${past ? "expired" : "expires"} on ${date}.`, urgent: false, createdAt: at }, tx); return userIds; })`, then publish to each returned user id. Three edits in `event-store.ts` (B2), each named:
  1. **`createHumanMessage`**: add `subjectCredentialId?: string` and `createdAt?: Date`; the guard at ~`:973` becomes `if (m.kind === "system" ? !m.subjectAgentId && !m.subjectCredentialId : m.kind === "message" && !m.fromAgentId) throw new Error("a human message needs a sender agent; a factory fact needs its subject agent or credential")` (no test asserts the old sentence: grep found it only at `event-store.ts:975`); the insert writes `subjectCredentialId`; `now = m.createdAt ?? this.clock()`, so the message timestamp equals `expiry_notified_at` (spec §5.8 `current`); `inboxKind` gains `"credential"` (default stays `"message"`).
  2. **`inboxRows`**: `.leftJoin(credentials, eq(credentials.id, messages.subjectCredentialId))` and select `credName: credentials.name`, `credExpiresAt: credentials.expiresAt`, `credNotifiedAt: credentials.expiryNotifiedAt`.
  3. **`toEntries`**: at the top of the loop, `if (r.m.subjectCredentialId && r.credName !== null) { items.push({ id, messageId, kind: "credential", read, from: { kind: "factory", name: "factory" }, to, preview, urgent, createdAt, credential: { name: r.credName, expiresAt: r.credExpiresAt?.toISOString() ?? null, current: r.credNotifiedAt?.getTime() === r.m.createdAt.getTime() }, link: { kind: "credential", name: r.credName } }); continue; }`, so the `agentSlug` computation and the session-link fallback are never reached for it. The existing `kind: r.item.kind === "message" ? "notice" : r.item.kind` mapping stays for the other rows.
- [ ] **Step 3: Verify.** `pnpm typecheck`; CI.
- [ ] **Step 4: Commit.** `feat(server): credential expiry notice in the Inbox`.

### Task 12: Recording script for Or

Implements spec §11.3 steps 1–2. **The executor never runs this script.** It is for Or.

**Files:**
- Create: `apps/server/scripts/sign-in-record.ts`, `apps/server/scripts/sign-in-redact.ts`, `apps/server/scripts/sign-in-redact.test.ts`
- Modify: `apps/server/package.json` (`"sign-in:record": "node --import tsx scripts/sign-in-record.ts"`)

**Interfaces:**
- Produces: `redactTranscript(raw: string, found: { url: string; code: string; token: string }): string` — replaces every query value of the URL (in the OSC 8 URI and in its display text, including across wraps), the code echo and every token fragment with same-length synthetic characters (`SYNTHETIC` prefix for the token: `sk-ant-oat01-SYNTHETIC` + `x` padding to the original length), preserving every other byte.

- [ ] **Step 1: Write failing tests** for `redactTranscript` using only synthetic inputs built in the test (a fake "real" token `sk-ant-oat01-REALLOOKING…`, a URL with distinct query values): the output length equals the input length; it contains none of the input's query values, code or token fragments; `parsePrompt` and `parseToken` still succeed on the output; the token parsed from the output starts with `sk-ant-oat01-SYNTHETIC`.
- [ ] **Step 2: Implement `sign-in-redact.ts`** and the script: `sign-in-record.ts` uses `startHostPty` + `runSetupToken` semantics but accumulates raw output in memory; prints only the parsed URL; reads the code with `readline` on the terminal (no echo of it to a file); after the token parses, before anything is written: `redactTranscript(raw, …)`; before removing the temp dir, prints `ls -la` of it and the names (never contents) of files containing `sk-ant-oat01` (read files as bytes, test with `includes`, print paths only); asserts the redacted text has no `sk-ant-oat01-(?!SYNTHETIC)` before writing; if that check fails it writes nothing and prints only "Redaction check failed; nothing written."; otherwise creates `join(os.homedir(), "open-factory-sign-in-recording")` with `mkdir(…, { recursive: true, mode: 0o700 })` (and `chmod 0o700` if it existed), writes `setup-token.recorded-<claude --version>.txt` there with `writeFile(…, { mode: 0o600, flag: "wx" })`, and prints that path. Unit-test the write helper (`writeRecording(dir, name, text)`) for the modes and the failed-check path with synthetic input. It never logs the token.
- [ ] **Step 3: Run** `pnpm vitest run apps/server/scripts/sign-in-redact.test.ts` → PASS. Do **not** run `sign-in:record`.
- [ ] **Step 4: Commit.** `feat(server): sign-in recording script for a redacted fixture`.

## Part 3: Web

Every task in this part was written with `vercel-react-best-practices` loaded and already complies. **React:** The plan is already React-compliant; follow it as written and report any deviation. The reviewer invokes `vercel-react-best-practices` first and checks this task's React diff against it.

### Task 13: Sign-in API, expiry state and the shared arrival hook

Implements spec §8.3 (query), §8.4 (`expiryState`), §8.6 (arrival hook, `validateSearch`).

**React:** The plan is already React-compliant; follow it as written and report any deviation. The reviewer invokes `vercel-react-best-practices` first and checks this task's React diff against it.

**Files:**
- Create: `apps/web/src/features/settings/sign-in/api.ts`, `apps/web/src/features/settings/sign-in/expiry.ts`, `apps/web/src/features/settings/sign-in/expiry.test.ts`, `apps/web/src/lib/use-arrival.ts`, `apps/web/src/lib/use-arrival.test.tsx`
- Modify (M1: I1 copied the arrival into the chat, so there are two live copies today): `apps/web/src/features/session/timeline.tsx` (`ARRIVAL_MS` `:74`, `arrive` `:79`, the tint state `:178`, the 2 s visible-time effect and `onArrivedEnd` `:232-245`), `apps/web/src/features/session/timeline-item.tsx` (`type Arrival` `:15`), `apps/web/src/features/chat/chat-view.tsx` (imports `ARRIVAL_MS`/`arrive` from the timeline at `:28`; tint state `:207`; the same effect `:249-259`), `apps/web/src/features/chat/chat-row.tsx` (`type Arrival` `:16`); `apps/web/src/routes/_app/settings.credentials.tsx` (`validateSearch`; non-blocking prefetch)
- Optional: `apps/server/src/app.ts` starts the python3 probe at boot (not awaited) so the first `GET` doesn't pay for it.

**Interfaces:**
- Produces:
  - `signInQueryOptions` (`queryKey: ["claude-sign-in"]`, `staleTime: 2_000` so a prefetch and the mount don't double-GET, `refetchOnWindowFocus: true`, no `refetchInterval`);
  - `startSignIn(body: { replace?: string }, signal?: AbortSignal): Promise<AttemptView>`;
  - `submitSignInCode(b: { attemptId; code; name? }): Promise<{ kind: "done"; credential: CredentialSummary } | { kind: "pending"; attempt: AttemptView }>` (201/200 → done, 202 → pending);
  - `waitSignIn(attemptId, signal?: AbortSignal): Promise<same union>` (passes `signal` through `apiFetch`); `cancelSignIn(attemptId): Promise<void>`;
  - `isRetryableWaitError(err: unknown): boolean` (true for network errors and `ApiError` whose code matches `/^http_\d+$/`; no catch-all);
  - `type ExpiryState = { tone: "none" } | { tone: "muted"; text: string } | { tone: "warning" | "crimson"; text: string; needsSignIn: true }`; `expiryState(expiresAt: string | null, now: Date, locale?: string, timeZone?: string): ExpiryState`;
  - `lib/use-arrival.ts`, the one copy of the deep-link arrival:

```ts
/** Visible time the deep-link tint holds before it fades (U3 §7.4, Q28). */
export const ARRIVAL_MS = 2000;
export type Arrival = "on" | "fading";
/** Moved verbatim from timeline.tsx: focuses without scrolling (callers scroll first); the
 *  data-focus-ring stand-in when a programmatic focus doesn't match :focus-visible. */
export function arrive(row: HTMLElement): void;
/** The tint: "on" for ARRIVAL_MS of visible time (useDocumentVisible), then "fading" until the row's
 *  animationend calls onArrivedEnd. `start` and `onArrivedEnd` are stable (useCallback, []), because
 *  they are passed into memoised rows (timeline-item, chat-row, CredentialRow). */
export function useArrivalTint(): { arrival: Arrival | undefined; start(): void; onArrivedEnd(): void };
```

- [ ] **Step 1: Write failing tests** in `expiry.test.ts`:

```ts
const now = new Date("2027-11-03T12:00:00Z");
it("more than 14 days is month precision, muted", () =>
  expect(expiryState("2028-01-15T00:00:00Z", now, "en-GB", "UTC")).toEqual({ tone: "muted", text: "Expires Jan 2028" }));
it("within 14 days counts calendar days, warning", () =>
  expect(expiryState("2027-11-12T00:00:00Z", now, "en-GB", "UTC")).toEqual({ tone: "warning", text: "Expires in 9 days", needsSignIn: true }));
it("tomorrow and today", () => {
  expect(expiryState("2027-11-04T08:00:00Z", now, "en-GB", "UTC")).toMatchObject({ text: "Expires tomorrow" });
  expect(expiryState("2027-11-03T20:00:00Z", now, "en-GB", "UTC")).toMatchObject({ text: "Expires today" });
});
it("tone follows the exact 14-day comparison, so a warning never says 15 days", () => {
  const edge = new Date(now.getTime() + 14 * 86400_000).toISOString();
  expect(expiryState(edge, now, "en-GB", "America/Los_Angeles")).toMatchObject({ tone: "warning" });
  expect((expiryState(edge, now, "en-GB", "America/Los_Angeles") as { text: string }).text).not.toMatch(/15/);
});
it("past is crimson with the date", () =>
  expect(expiryState("2027-11-01T00:00:00Z", now, "en-GB", "UTC")).toEqual({ tone: "crimson", text: "Expired 1 Nov 2027", needsSignIn: true }));
it("null is nothing", () => expect(expiryState(null, now)).toEqual({ tone: "none" }));
```

  `use-arrival.test.tsx` (fake timers; mock the visibility hook, not `document.visibilityState`: `let visible = true; vi.mock("@/hooks/use-document-visible", () => ({ useDocumentVisible: () => visible }))`, then `rerender` after changing it):
  - `arrive(el)` focuses `el` with `preventScroll: true` and never calls `scrollIntoView`; when `:focus-visible` doesn't match, `el` gets `data-focus-ring`, removed on blur;
  - after `start()`, `arrival` is `"on"`; 2 s later it is `"fading"`; `onArrivedEnd()` clears it;
  - hidden after 1.5 s: no change at 2 s or 10 s; visible again: `"fading"` 0.5 s later;
  - `start` and `onArrivedEnd` keep their identity across renders.
- [ ] **Step 2: Run, confirm failure.** `pnpm vitest run apps/web/src/features/settings/sign-in/expiry.test.ts apps/web/src/lib/use-arrival.test.tsx`.
- [ ] **Step 3: Implement.**
  - `expiryState`: `delta = expires - now`; `<= 0` → crimson `Expired <day month year>`; `<= 14 days` → warning; days = difference of calendar dates in `timeZone`, clamped to at most 14, text `today`/`tomorrow`/`in N days`; else muted `Expires <month short + year>`. Formatters are module-level cached `Intl.DateTimeFormat` instances in a `Map` keyed by `` `${locale}|${timeZone}|${kind}` `` (`js-cache-function-results`), never built per call or per render.
  - The API functions use `apiFetch` with the Task 1 schemas.
  - `useArrivalTint`, the timeline's code moved as is, plus `start`:

```ts
export function useArrivalTint() {
  const [arrival, setArrival] = useState<Arrival>();
  const visible = useDocumentVisible();
  const left = useRef(ARRIVAL_MS);
  // The tint fades after 2s of visible time (U3 §7.4): hidden, the clock stops and keeps what's left.
  // An effect runs after the row painted, so the 2s start from the first frame that shows it.
  useEffect(() => {
    if (arrival !== "on" || !visible) return;
    const startedAt = Date.now();
    const t = setTimeout(() => setArrival("fading"), left.current);
    return () => {
      clearTimeout(t);
      left.current = Math.max(0, left.current - (Date.now() - startedAt));
    };
  }, [arrival, visible]);
  const start = useCallback(() => {
    left.current = ARRIVAL_MS;
    setArrival("on");
  }, []);
  const onArrivedEnd = useCallback(() => setArrival(undefined), []);
  return { arrival, start, onArrivedEnd };
}
```

    `start` resets the remaining time; today's two copies never reset it, so a second arrival in the same mounted view faded at once. That is the only behaviour change.
  - Migrate **both** `timeline.tsx` and `chat-view.tsx`: replace their `useState<Arrival>()`, `arrivalLeft` ref, effect and `onArrivedEnd` with `const { arrival, start: startArrival, onArrivedEnd } = useArrivalTint()`, and their `setArrival("on")` with `startArrival()`; import `arrive` from `@/lib/use-arrival`. Delete `ARRIVAL_MS` and `arrive` from `timeline.tsx` and the two `type Arrival` declarations; `timeline-item.tsx` and `chat-row.tsx` import `type Arrival` from `@/lib/use-arrival`. Their layout effects and scroll logic stay where they are. No re-export from the old places (ADR 0028).
  - `settings.credentials.tsx`: `validateSearch: z.object({ credential: z.string().min(1).optional().catch(undefined) })` (the `inbox.tsx:20` pattern). In the loader, `void qc.prefetchQuery(signInQueryOptions)` **outside** and before the awaited `Promise.allSettled`, so the two requests start together (`async-parallel`) and a slow sign-in GET never delays the page.
- [ ] **Step 4: Run.** `pnpm vitest run apps/web/src/features/settings/sign-in/expiry.test.ts apps/web/src/lib/use-arrival.test.tsx apps/web/src/features/session apps/web/src/features/chat apps/web/src/test/session-view.test.tsx` → PASS (the last three are the changed timeline and chat's existing tests).
- [ ] **Step 5: Commit.** `feat(web): sign-in API, expiry state and one shared arrival hook`.

### Task 14: Credential row: expiry line, Sign in again, arrival

Implements spec §8.4, §8.6 (`?credential=`), AC9.

**React:** The plan is already React-compliant; follow it as written and report any deviation. The reviewer invokes `vercel-react-best-practices` first and checks this task's React diff against it.

**Files:**
- Modify: `apps/web/src/features/settings/credentials-section.tsx` (gains an `arriveAt?: string` prop), `apps/web/src/routes/_app/settings.credentials.tsx` (a small page component passes `arriveAt`), `apps/web/src/features/settings/shared.tsx` (`RowLine` actions `flex flex-wrap justify-end`), `apps/web/src/features/sheets/sheet-store.ts` (`SheetSpec` gains `{ kind: "sign-in-again"; name: string }`, `:4-10`), `apps/web/src/features/sheets/sheet-bodies.ts` (an entry with a placeholder body; Task 17 fills it), `apps/web/src/features/sheets/body-skeleton.tsx` (`ROWS` gains `"sign-in-again": 2`)
- Create: `apps/web/src/features/settings/credentials-section.test.tsx` (no component test for the section exists today; `apps/web/src/test/settings.test.tsx` renders the page and keeps passing)

**Interfaces:**
- Consumes: `expiryState`, `arrive`, `useArrivalTint`, `type Arrival` (Task 13), `openSheet({ kind: "sign-in-again", name })`, `sheetIntent("sign-in-again", spec)` (`sheet-bodies.ts:172`, returns `{ onPointerEnter, onFocus, onPointerDown }`).
- Produces: a module-level `const CredentialRow = memo(function CredentialRow(p: CredentialRowProps) { … })` with primitive or identity-stable props only:

```ts
type CredentialRowProps = {
  c: CredentialSummary;          // TanStack Query's structural sharing keeps an unchanged row's identity across refetches
  now: number;                   // minute-rounded, from the section: Math.floor(Date.now() / 60_000) * 60_000 (the inbox-list pattern, :93)
  busy: boolean;                 // verifying.has(c.name)
  outcome: Outcome | undefined;  // rowOutcome[c.name]
  replacing: boolean;            // replacing === c.name
  arrival: Arrival | undefined;  // the tint, only for the arrived row (undefined for every other row)
  onArrivedEnd(): void;          // from useArrivalTint, stable
  onVerify(c: CredentialSummary): void;
  onReplace(name: string): void;
  onReplaceDone(r: CredentialSummary): void;
  onReplaceCancel(name: string): void;
  onDelete(c: CredentialSummary): void;
  menuHandsOff: RefObject<string | false>;
};
```

- [ ] **Step 1: Write failing component tests** in `credentials-section.test.tsx` (render the section with a `QueryClient` seeded with `credentialsQueryOptions` data and the router/search mocks the settings tests already use; read `apps/web/src/test/settings.test.tsx` for the setup):

```tsx
it.each([
  [{ expiresAt: "2028-01-15T00:00:00Z" }, "Expires Jan 2028", false],
  [{ expiresAt: "2027-11-12T00:00:00Z" }, "Expires in 9 days", true],
  [{ expiresAt: "2027-11-01T00:00:00Z" }, "Expired 1 Nov 2027", true],
  [{ expiresAt: null }, null, false],
])("row state %#", (patch, text, button) => {
  vi.setSystemTime(new Date("2027-11-03T12:00:00Z"));
  renderSection([cred({ kind: "oauth_token", ...patch })]);
  if (text) expect(screen.getByText(text)).toBeInTheDocument();
  expect(!!screen.queryByRole("button", { name: "Sign in again" })).toBe(button);
});
it("a rejected OAuth credential shows Sign in again after its failure line", () => {});
it("an expired credential's verification line is muted, not a second crimson line", () => {});
it("the ⋯ menu has Sign in again for OAuth only, above Replace token", async () => {});
it("Sign in again (button and menu item) opens the sign-in-again sheet", async () => { /* spy openSheet */ });
it("?credential=work arrives on that row once, after the list loaded, then clears the search param", () => { /* navigate called with replace: true and credential: undefined */ });
it("?credential=gone (no such row) still clears the param and moves nothing", () => {});
it("Sign in again buttons and the menu item carry sheetIntent (prefetch on hover/focus/pointerdown)", () => {});
it("a refetch with unchanged data does not re-render the rows", () => { /* React Profiler or a render counter on CredentialRow */ });
```

  Render the section with an `arriveAt` prop in these tests (no router search needed); spy on `useNavigate`'s function.
- [ ] **Step 2: Run, confirm failure.** `pnpm vitest run apps/web/src/features/settings/credentials-section.test.tsx`.
- [ ] **Step 3: Implement.**
  - **Extract `CredentialRow`** (mandatory, R4): the body of today's inline `credentials.map((c) => …)` (`credentials-section.tsx` ~`:289-405`) moves into the module-level memoised component above, unchanged except for the additions below. Never define it inside `CredentialsSection` (`rerender-no-inline-components`).
  - **Stable handlers in the section** (`rerender-functional-setstate`): `setRow` becomes a `useCallback` over the functional `setRowOutcome` (as today, `[]` deps); `onVerify` is a `useCallback` with `[]` deps that reads the in-flight set from a ref (`verifyingRef`, updated beside `setVerifying`) instead of closing over `verifying`; `upsert` and `refresh` are `useCallback`s over `qc` (stable); `onReplace`, `onReplaceDone`, `onReplaceCancel` and `onDelete` are `useCallback`s built from those and from state setters only. `focusLater` (`useFocusLater`) is already stable.
  - **Per row:** `const ex = expiryState(c.expiresAt, new Date(now))` computed in the row from the `now` prop, never `Date.now()` in the row, so the memo holds. `ExpiryLine` (icon + text, tones from DESIGN.md tokens: `text-muted-foreground`, the warning token, `text-destructive`) sits after `VerificationState`, followed by `<Button variant="ghost" size="xs">Sign in again</Button>` when `ex.needsSignIn`; a `rejected` (not expired) OAuth row appends the same button after `VerificationState`; when expired, `VerificationState` renders its muted form. The intent props are built once per row identity: `const intent = useMemo(() => sheetIntent("sign-in-again", { kind: "sign-in-again", name: c.name }), [c.name])` inside the row, spread on the button and the menu item; the click handler is `() => openSheet({ kind: "sign-in-again", name: c.name })`.
  - **⋯ menu:** "Sign in again" for every `oauth_token` row, above `Replace token`, with `opensOverlay` (it opens a sheet; without it the phone drawer and the sheet animate over each other: `components/ui/adaptive-menu.tsx` ~`:318-331`) and `menuHandsOff.current = ""` in `onSelect` (the sheet places focus), like Delete.
  - **Arrival** is one section-level effect, no hook per row (R5). The section calls `const { arrival, start, onArrivedEnd } = useArrivalTint()` and keeps `const [arrivedName, setArrivedName] = useState<string>()`. Rows already carry `data-name={c.name}` (`SettingsRow`, ~`:296`): reuse it, no second attribute. The section must not import `Route` from its own route file (that file imports the section: a cycle). The route reads the param the repo's way (`inbox.tsx:77`) and passes a primitive: `component: function CredentialsPage() { const credential = Route.useSearch({ select: (s) => s.credential }); return <CredentialsSection arriveAt={credential} />; }`. In the section, `const navigate = useNavigate()` from `@tanstack/react-router` (stable):

```ts
const target = p.arriveAt;
const loaded = query.isSuccess;
useEffect(() => {
  if (!target || !loaded) return;
  const row = document.querySelector<HTMLElement>(`[data-name="${CSS.escape(target)}"]`);
  if (row) {
    row.scrollIntoView({ block: "center" }); // arrive() focuses without scrolling
    const button = row.querySelector<HTMLElement>("[data-sign-in-again]");
    arrive(button ?? row);
    setArrivedName(target);
    start();
  }
  void navigate({ to: "/settings/credentials", search: {}, replace: true });
}, [target, loaded, navigate, start]);
```

    The deps are primitives and stable functions (`rerender-dependencies`); clearing the param makes it fire once per value, and it clears the param even when no row matches. The row gets `arrival={c.name === arrivedName ? arrival : undefined}` and `onArrivedEnd`, and renders the tint the way `chat-row.tsx` does (`data-arrived`, `onAnimationEnd` when fading). The ghost Sign in again carries `data-sign-in-again`. If the row isn't focusable today, it gets `tabIndex={-1}` so `arrive` can focus it.
  - Delete-dialog copy (~`:456`): "To use it later, create a new one with `claude setup-token`." becomes "To use it later, add it again with Sign in with Claude." Update the assertion at `apps/web/src/test/settings.test.tsx:326`.
- [ ] **Step 4: Run.** `pnpm vitest run apps/web/src/features/settings/credentials-section.test.tsx apps/web/src/test/settings.test.tsx` → PASS.
- [ ] **Step 5: Commit.** `feat(web): credential expiry line and Sign in again on the row`.

### Task 15: The sign-in panel and its attempt hook

Implements spec §8.2, §8.3, R1, R2, R5, R7, AC2, AC3.

**React:** The plan is already React-compliant; follow it as written and report any deviation. The reviewer invokes `vercel-react-best-practices` first and checks this task's React diff against it.

**Files:**
- Create: `apps/web/src/features/settings/sign-in/use-sign-in.ts`, `apps/web/src/features/settings/sign-in/sign-in-panel.tsx`, `apps/web/src/features/settings/sign-in/sign-in-panel.test.tsx`
- Modify: `apps/web/src/lib/form-messages.ts` (`FORM_MSG.signInOtherPanel: "Another sign-in is open; Start ends it."`, 39 chars; `form-messages.test.ts` covers every key), `apps/web/src/components/app-sidebar.tsx` (sign-out calls `resetSignIn()` beside `resetSheets()` and `resetDrafts()`, ~`:123`)

**Interfaces:**
- Consumes: Task 13 API, Task 1 `MSG`, I4's `FieldErrors` type (`@/components/forms/use-field-errors`), `useOutcome` (`@/components/forms/form-outcome`), `FieldShell` (`@/components/field-shell`).
- Produces:

```ts
type Phase = "loading" | "idle" | "starting" | "ready" | "exchanging" | "verifying";
export function useSignIn(o: {
  purpose: "create" | "replace";
  name?: string;                                   // replace: the credential's name
  fields: Pick<FieldErrors<"name" | "code">, "set">; // the host form's own useFieldErrors: Add credential passes
                                                   // its FieldErrors<"name" | "value" | "code">, the sheet its
                                                   // FieldErrors<"code"> (set is a method, so both are assignable);
                                                   // the hook calls set("name") only for purpose "create"
  outcome: ReturnType<typeof useOutcome>;          // I4 FormOutcome from the host form
  onDone(c: CredentialSummary): void;              // read through a latest-ref (assigned in an effect); called once
}): {
  phase: Phase; attempt: AttemptView | null; available: boolean;
  line: { tone: "help" | "error"; text: string } | undefined; // the panel's Idle line, derived in render
  code: string; setCode(v: string): void;          // the hook owns the code; cleared after any outcome
  start(): Promise<void>; submit(name?: string): Promise<void>; cancel(): Promise<void>;
  pendingLabel: "Starting…" | "Signing in…" | "Verifying…" | undefined; // derived in render
};
export function SignInPanel(p: { s: ReturnType<typeof useSignIn>; frame: "inline" | "sheet"; codeRef: RefObject<HTMLInputElement | null> }): JSX.Element;
```

Module-level state in `use-sign-in.ts` (survives unmount, StrictMode and a second panel; per tab, cleared on sign-out):
- `const submittedHere = new Set<string>()` — attempt ids this tab submitted (H1);
- `const inFlight = new Map<string, { promise: Promise<Result>; controller: AbortController }>()` — one `waitUntilDone` loop per attempt id (H2);
- `function waitUntilDone(qc: QueryClient, attemptId: string): Promise<Result>` — returns the existing loop for that id, or starts one with its own `AbortController`: it calls `waitSignIn(attemptId, signal)` until a final answer; on a 202 or a retryable error (`isRetryableWaitError`) waits 1 s, 2 s, then 5 s (capped) and tries again; removes itself from `inFlight` when it settles. **The loop belongs to the tab, not to a panel** (spec §8.3: "its query updates and invalidations run even if the panel unmounted"): unmounting a panel never aborts it; it ends at a final answer, at `cancel`, or at `resetSignIn()`. **Outcome side effects run here, mounted or not** (H1): on success `qc.setQueryData(["claude-sign-in"], …)`, invalidate the credentials and inbox query keys (the inbox feature's real key from `features/inbox/api.ts`). The `QueryClient` is passed in by the hook (`useQueryClient()`); there is no global client.
- `export function resetSignIn()` — aborts every loop in `inFlight` and clears both collections, so a second user signing in on the same tab inherits no "submitted here" and no loop (R3). Called on sign-out from `components/app-sidebar.tsx`, beside `resetSheets()`/`resetDrafts()`.

- [ ] **Step 1: Write failing tests** (MSW or the repo's existing fetch mock):

```tsx
it("idle shows the help line and no Start button inside the panel (one primary, R1)", () => {});
it("ready renders a real link, Copy link and the host + fixed deadline line; no URL text on screen (R2)", async () => {
  mockGet({ available: true, attempt: ready({ url: SYN_URL, codeDeadline: "2026-11-23T14:32:00Z" }) });
  render(<Harness />);
  const link = await screen.findByRole("link", { name: "Open sign-in page" });
  expect(link).toHaveAttribute("href", SYN_URL);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getByText(/Opens claude\.com in a new tab · Expires at/)).toBeInTheDocument();
  expect(screen.queryByText(SYN_URL)).toBeNull();
});
it("focus moves to Open sign-in page when Ready arrives, then to Code after the link is used", async () => {});
it("the Code field is plain text with one-time-code autocomplete and never a password field (R5)", () => {});
it("a rejected code returns to Idle with the error on the line and focus on the primary", async () => {});
it("name errors stay on Name and keep Ready", async () => {});
it("an attempt that disappears shows Sign-in timed out after the deadline, Sign-in ended before it, restarted elsewhere for another id", async () => {});
it("the deadline timer refetches once, no interval", async () => {});
it("202 then waitUntilDone with 1/2/5 s backoff; retries only on network and http_ errors, never on a coded error", async () => {});
it("unmount does not abort the loop; the loop stops at its final answer, and resetSignIn() aborts it (no request after)", async () => {});
it("resetSignIn() clears submitted-here: after it, a settled success for that id is not shown", async () => {});
it("one loop under StrictMode and with a second panel (in-flight Map reused)", async () => {});
it("submit, unmount, the outcome lands, remount: success is shown exactly once; credentials and inbox were invalidated while unmounted (H1)", async () => {});
it("a settled success is rendered only by the tab that submitted", async () => {});
it("the pending label reads Signing in… until a 202 or refetch reports verifying, then Verifying… (L4)", async () => {});
it("purpose mismatch shows the other-panel line", async () => {});
it("exchanging makes Code and Name readOnly + aria-disabled and hides Cancel sign-in", async () => {});
it("the code lives only in the hook's state and is cleared after any outcome (no mutation cache)", async () => {});
it("states swap with no transition classes (R7)", () => {});
```

- [ ] **Step 2: Run, confirm failure.** `pnpm vitest run apps/web/src/features/settings/sign-in/sign-in-panel.test.tsx`.
- [ ] **Step 3: Implement.** `useSignIn`:
  - `useQuery(signInQueryOptions)`. Start, submit, wait and cancel are **plain async handlers with a `useState` pending flag** (the repo pattern), not `useMutation` (M2); on success they `setQueryData(["claude-sign-in"], …)` instead of refetching.
  - **Disappearance is state adjusted during render** (the repo's pattern: `inbox.tsx` `useSelectedChat`, `useFieldErrors`), with a guard so it settles in one extra render: one state object `shown = { id?: string; deadline?: string; line?: Line }`. In render: `if (!pending && (attempt?.attemptId ?? undefined) !== shown.id) setShown({ id: attempt?.attemptId, deadline: attempt?.codeDeadline ?? shown.deadline, line: shown.id ? disappearanceLine(shown, attempt, Date.now()) : shown.line })`, where `disappearanceLine` is a pure module function (`signInExpired` if now ≥ `shown.deadline`, `signInReplaced` for another id, else `signInEnded`). The last `codeDeadline` lives in that same state object (no ref written during render). Start and Cancel clear `shown`. Phase, the Idle line and `pendingLabel` are derived in render (`rerender-derived-state-no-effect`). **No effect for disappearance.**
  - `onDone` latest-ref (`advanced-use-latest`): `const onDoneRef = useRef(o.onDone); useLayoutEffect(() => { onDoneRef.current = o.onDone; });` — assigned in an effect, never during render. A `mountedRef` set to true/false in a mount effect gates the mounted-only effects.
  - One resolution handler (H3) maps every result per spec §8.2: `fields.set("code" | "name", msg, { focus: true })`, `outcome.fail(msg)`, `setCode("")`, the Idle line, and `onDoneRef.current(credential)` — called only when `submittedHere.has(attemptId)` and `mountedRef.current`; toast, `onDone` and `completeChild` are the only mounted-only effects (H1). The message for a `credential_not_found` answer is `MSG.credentialDeleted`; every other answer carries its constant in `ApiError.message`.
  - `submit` adds the attempt id to `submittedHere`, then awaits `waitUntilDone(qc, attemptId)` (shared through `inFlight`).
  - One mount effect for restore only: when the first `GET` shows `exchanging`/`verifying`/`settled`, join `waitUntilDone(qc, attemptId)`. Focus after Start comes from the Start handler via `useFocusLater` (L3), not an effect.
  - The deadline timer is one effect with primitive deps `[isReady, attemptId, codeDeadline]` (L2): a `setTimeout` to `codeDeadline` that calls `refetch()`; cleared on change. `SignInPanel`: no reserved height; Ready = link button (`buttonVariants({ variant: "outline" })` on an `<a>`, `ExternalLink` icon), `CopyIcon` ghost button with `useCopy`, `CopyFailed`, the muted host + deadline line, formatted by one module-level `Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" })` (never built per render); Code via `FieldShell` + `Input` (`className="font-mono"`, `autoComplete="one-time-code"`, `autoCapitalize="none"`, `autoCorrect="off"`, `spellCheck={false}`); a polite `role="status"` "Sign-in page ready."; Cancel sign-in ghost (sheet frame only).
- [ ] **Step 4: Run.** `pnpm vitest run apps/web/src/features/settings/sign-in/sign-in-panel.test.tsx apps/web/src/lib/form-messages.test.ts` → PASS.
- [ ] **Step 5: Commit.** `feat(web): sign-in panel and attempt hook`.

### Task 16: Add credential form: Method and one primary at a time

Implements spec §8.1, AC1, AC2, AC10, D13.

**React:** The plan is already React-compliant; follow it as written and report any deviation. The reviewer invokes `vercel-react-best-practices` first and checks this task's React diff against it.

**Files:**
- Modify: `apps/web/src/features/settings/forms/add-credential-form.tsx`; `apps/web/src/features/settings/forms/form-frame.tsx` and `apps/web/src/features/settings/shared.tsx` (`InlineForm`, ~`:269`) (M2: one optional `autoFocus?: boolean`, default `true`); `apps/web/src/features/settings/forms/shared.tsx` (`TokenField` help, `:47`); `apps/web/src/features/settings/credentials-section.tsx` (inline auto-open on a live `create` attempt; inline Cancel → `cancelSignIn`); `apps/web/src/features/sheets/sheet-bodies.ts` (`add-credential` prefetch adds `signInQueryOptions`)
- Test: `apps/web/src/features/settings/forms/add-credential-form.test.tsx` (new); update `apps/web/src/features/settings/forms/forms.test.tsx` (`:445`, `:453` assert the old TokenField help) and `apps/web/src/test/field-shell.test.tsx:150` if it renders `TokenField` with the old help

**Interfaces:**
- Consumes: Task 15 `useSignIn`, `SignInPanel`.

- [ ] **Step 1: Write failing tests:**

```tsx
it("Method defaults to Sign in with Claude and the primary is Start sign-in", () => {});
it("Enter in Name starts sign-in and runs no field checks (R8)", async () => { /* empty Name → POST start called, no Name error */ });
it("at Ready the primary is Sign in and add; submit sends attemptId, code and name", async () => {});
it("pending labels: Starting…, Signing in…, Verifying…", async () => {});
it("Paste a token shows the token field with the never-warned help; Verify and add posts expiresAt-less create", () => {});
it("Paste an API key keeps today's field", () => {});
it("python3 unavailable: default Paste a token, Sign in with Claude disabled with its reason", () => {});
it("inline Cancel cancels the attempt; sheet Close keeps it", async () => {});
it("Settings opens the inline form when GET has a live create attempt, never for settled", async () => {});
it("mounting with a live attempt does not move focus (autoFocus false); Ready then focuses Open sign-in page", async () => {});
it("a sign-in attempt change does not re-render the Settings section (select narrows to isLiveCreate)", async () => {});
```

- [ ] **Step 2: Run, confirm failure.** `pnpm vitest run apps/web/src/features/settings/forms/add-credential-form.test.tsx`.
- [ ] **Step 3: Implement.**
  - **FormFrame (M2).** Its props today are `frame, label, onSubmit, onCancel, submitLabel, pendingLabel, pending, outcome, autoFocusId, reveal, left, ref` (`form-frame.tsx:15-53`): add `autoFocus?: boolean` (default `true`). `false` skips the sheet branch's mount-focus effect (`:62-76`) and is passed to `InlineForm`, which gets the same prop and skips its mount focus of `autoFocusId ?? first input`. Nothing else changes: `submitLabel`/`pendingLabel` are already plain strings, so "Start sign-in", "Sign in and add" and "Verify and add" need no frame change. The add form passes `autoFocus={!restoring}`, where `restoring` is true when the first `GET` already had a live `create` attempt (derived in render from the query, not state).
  - **Fields (M3).** `type Field = "name" | "value" | "code"`; `FIELDS = ["name", "value", "code"]`; the form owns one `useFieldErrors<Field>` and passes it to `useSignIn`. `checks.value` applies only when the Method is a paste method and `checks.code` only when the panel is Ready (each check returns `undefined` otherwise). `f.submit(["name"])` is valid (the optional `fields` argument, `use-field-errors.ts:15`).
  - **Method.** Replace the Kind radios (`add-credential-form.tsx` ~`:127`, whose label mentions `claude setup-token`) with "Method" (`sign_in` | `paste_token` | `api_key`, UI state, `kind` derived from it); keep per-method values; call `useSignIn({ purpose: "create", fields: f, outcome: o, onDone })` with the form's own `useFieldErrors` and `useOutcome` (H3); the frame's `submitLabel`/`pendingLabel` and `onSubmit` come from the method and `s.phase` (`idle` → `s.start()`, `ready` → `f.submit(["name"])` then `s.submit(name)`; paste → today's submit).
  - **TokenField help** (`forms/shared.tsx:47`): for Paste a token, "Create one with `claude setup-token`. You won't be warned before it expires." (spec §8.1); the API key help stays as is.
  - **Settings section (R6).** `adding` becomes tri-state (`boolean | undefined`) and `showAdd = adding ?? liveCreate`, derived in render, no effect. `liveCreate` comes from `useQuery({ ...signInQueryOptions, select: isLiveCreate })`, so the section re-renders only when that boolean flips, not on every attempt field change (`rerender-derived-state`); `isLiveCreate` is a module-level function (stable `select`), true for a `create` attempt in `starting`/`awaiting_code`/`submitting`/`exchanging`/`verifying` and never for `settled`. The panel's own hook reads the full attempt.
- [ ] **Step 4: Run.** `pnpm vitest run apps/web/src/features/settings/forms/add-credential-form.test.tsx apps/web/src/features/settings/forms/forms.test.tsx apps/web/src/test/field-shell.test.tsx apps/web/src/features/settings/credentials-section.test.tsx` → PASS (existing add-credential tests updated to the Method wording).
- [ ] **Step 5: Commit.** `feat(web): Add credential with Sign in with Claude`.

### Task 17: Sign in again sheet

Implements spec §8.5, D14.

**React:** The plan is already React-compliant; follow it as written and report any deviation. The reviewer invokes `vercel-react-best-practices` first and checks this task's React diff against it.

**Files:**
- Create: `apps/web/src/features/sheets/sign-in-again-sheet.tsx`, `apps/web/src/features/sheets/sign-in-again-sheet.test.tsx`
- Modify: `apps/web/src/features/sheets/sheet-bodies.ts` (replace Task 14's placeholder: lazy load, `prefetch` warms `credentialsQueryOptions` and `signInQueryOptions` together so `sheetIntent` on every entry point preloads both in parallel, title "Sign in again"; `Entry` (today `title`, `titleClass`, `note`) gains `description?: (spec) => string` and `descriptionClass?: string`, here `(spec) => spec.name` with `"font-mono"`), `apps/web/src/features/sheets/sheet-host.tsx` (m10: `SheetLayer` renders a description only for stacked children today, `const description = parentTitle ? childDescription(...) : undefined` ~`:140`; it now also renders the entry's `description` for a top-level sheet, as a `SheetDescription` with `descriptionClass`). The sheet closes on route change (`onResolved`), so an Inbox-opened sheet is bound to `/inbox`: intended.

**Interfaces:**
- Consumes: Task 15 (`useSignIn({ purpose: "replace", name })`), `cappedList`, `restartNote`, Sonner `toast`.

- [ ] **Step 1: Write failing tests:** the sheet shows "Sign in again" with the mono name description; primary Start sign-in then **Sign in and replace**; on success the sheet closes, one toast "Signed in again: work." plus the capped restart note, and `qc.invalidateQueries({ queryKey: ["inbox"] })` (use the inbox feature's real key) and the credentials key are called; a `replace` attempt for another name shows the other-panel line.
- [ ] **Step 2: Run, confirm failure.** `pnpm vitest run apps/web/src/features/sheets/sign-in-again-sheet.test.tsx`.
- [ ] **Step 3: Implement** with `SheetFormFooter` + `FormOutcome`, the `SignInPanel` with `frame="sheet"`; the sheet's own `useFieldErrors<"code">` and `useOutcome` go to `useSignIn({ purpose: "replace", name: spec.name, fields, outcome, onDone })`. The body does not chain queries: it reads `credentialsQueryOptions` and `signInQueryOptions` with two independent `useQuery` calls (no `enabled` chain), both already warm from `prefetch` (R8, `async-parallel`). The toast text is built in the success handler (toasts are exempt from the no-interpolation rule).
- [ ] **Step 4: Run.** `pnpm vitest run apps/web/src/features/sheets/sign-in-again-sheet.test.tsx apps/web/src/features/sheets/sheet-host.test.tsx` → PASS.
- [ ] **Step 5: Commit.** `feat(web): Sign in again sheet`.

### Task 18: Inbox credential row, pane and notifications

Implements spec §8.6, AC8.

**React:** The plan is already React-compliant; follow it as written and report any deviation. The reviewer invokes `vercel-react-best-practices` first and checks this task's React diff against it.

**Files:**
- Modify (m8, the real branch points on the base):
  - `apps/web/src/features/inbox/api.ts`: `prefetchPane` (`:83`) branches on `link.kind`;
  - `apps/web/src/features/inbox/inbox-row.tsx`: `Sender` (`:18`), `SenderLine` (`:35`), `ContextLine` (`:65`), `labelOf` (`:78`), the row link ternary (`:178-200`); the row's `onOpen` lives here and in `inbox-list.tsx`;
  - `apps/web/src/features/inbox/inbox-pane.tsx`: `Sender` (`:51`), `OpenLink` (`:69`, "Open credentials"), the `PaneItem` body ternary (`:393`, today `link.kind === "session" ? NoticeContent : TaskContent`) → an exhaustive switch with a new `CredentialContent` beside `NoticeContent` (`:162`); the pane has no `onOpen`;
  - `apps/web/src/features/inbox/notifications.ts`: `notificationTitle` (`:80`) and the `l.kind` branch in `useInboxNotifier` (`:143`, the click target).
- Test (extend): `apps/web/src/features/inbox/inbox-list.test.tsx` (rows; there is no `inbox-row.test.tsx`), `apps/web/src/features/inbox/inbox-pane.test.tsx`, `apps/web/src/test/inbox-pane-content.test.tsx`, `apps/web/src/features/inbox/notifications.test.tsx`

**Interfaces:**
- Consumes: `expiryState` (Task 13), `openSheet({ kind: "sign-in-again", name })` (Task 17).

- [ ] **Step 1: Write failing tests:**

```tsx
const item = credItem({ name: "work", expiresAt: "2027-11-12T00:00:00Z", current: true });
it("row: 'Factory about work' then the live state; accessible name names the expiry", () => {});
it("row below 1024px links to /settings/credentials?credential=work", () => {});
it("pane: header Open credentials, body fact + Sign in again (opens the sheet), no composer", () => {});
it("pane: current false shows Already signed in again.", () => {});
it("notification title is Credential expiring / Credential expired; click opens the credentials deep link", () => {});
it("no branch falls through to a session link for a credential item", () => {});
it("the row's expiry text follows the now prop, not the wall clock (memo contract)", () => {});
```

- [ ] **Step 2: Run, confirm failure.** `pnpm vitest run apps/web/src/features/inbox/inbox-list.test.tsx apps/web/src/features/inbox/inbox-pane.test.tsx apps/web/src/test/inbox-pane-content.test.tsx apps/web/src/features/inbox/notifications.test.tsx`.
- [ ] **Step 3: Implement** each branch named above; every `link.kind` ternary becomes an exhaustive `switch` with `credential` (TypeScript `never` check), so a future kind fails to compile. Remove any interim `// Task 18` fallback left by Task 1. Credential items carry no `about`: the row and pane read `item.credential.name`.
  - `InboxRow` is `memo` with a minute-rounded `now` prop (`inbox-row.tsx:103-125`): the credential branch computes `expiryState(item.credential.expiresAt, new Date(now))` from that prop, never `Date.now()`/`new Date()` with no argument, so the memo contract holds (R7). The switch returns elements directly and allocates no new shared props object beyond what the row builds today.
  - The pane's Sign in again spreads `sheetIntent("sign-in-again", { kind: "sign-in-again", name })`, hoisted with `useMemo` keyed on the name, and calls `openSheet({ kind: "sign-in-again", name })`. The pane's live date also comes from the inbox's `now` (or one `new Date()` per pane render, which is not memoised).
- [ ] **Step 4: Run.** The four test files above → PASS.
- [ ] **Step 5: Commit.** `feat(web): credential expiry notice in the Inbox`.

## Part 4: Docs

### Task 19: DESIGN.md amendments

Implements spec §12 (DESIGN.md).

**Files:** Modify `DESIGN.md`.

- [ ] **Step 1:** Apply on the merged `DESIGN.md` (the I1/I2 stack changed it; line numbers are on the base). Add the four amendments verbatim from spec §12 in their sections: **Rows** (deep-link arrival; the "Selected rows" bullet is at `:346`, the Rows bullet at `:309`), **Inputs** (one-time codes, `:310`), **Forms** (one primary at a time, `:312`), **Motion → Live rows** (deadlines as fixed clock times, in the `:368` bullet beside "waiting lines and holds keep fixed times"). Also update the Session timeline "Deep-link arrival" bullet (`:302`) to point to the Rows rule.
- [ ] **Step 2: Commit.** `docs: DESIGN.md amendments for sign-in (arrival, one-time codes, one primary, deadlines)`.

### Task 20: In-repo docs

**Files:** Modify `README.md` (`:54` documents `claude setup-token`): replace "run `claude setup-token` and paste the token" with "Settings → Credentials → Add credential → Sign in with Claude (needs python3 on the server); pasting a token still works". The in-app strings that named `claude setup-token` are changed in their tasks: the delete-dialog body (Task 14), the Kind radio label and the TokenField help (Task 16). Before committing, `grep -rn "setup-token" apps/web/src` must show only the Paste-a-token help, its tests and `components/code-text.tsx`'s comment. Commit `docs: README sign-in`.

### Task 21: Product docs (for the lead)

`docs/product/` is gitignored and exists only in the main checkout (`/Users/orlevi/projects/open-factory/docs/product/`). **Edit it only when the lead instructs you to; otherwise list these changes in your final report for the lead:** ADR 0027 amendment, `concepts/credential.md`, `behavior/administration.md` → Credentials, `behavior/inbox.md`, `architecture/data-model.md`, and the I3 task spec, each exactly as spec §12 states.

## Part 5: Finish

### Task 22: Whole-branch review

- [ ] Fresh reviewer, read-only, over `git diff spec/i3-claude-sign-in...i3/claude-sign-in` against the spec. It runs only the test files the branch created or changed (Task 23 runs the rest): every AC has a test or an evidence item; spec §6 security (grep the diff for `log.` / `request.log` near `url`, `code`, `token`; confirm no new redact wildcard; `PTY_BRIDGE` test present; spawn options test present; no `process.env` spread into the child); ADR 0028 (no compatibility code); I4 rules (all new messages constants ≤ 40); **the React diff checked against `vercel-react-best-practices`** (the reviewer invokes the skill first: effects only for external sync, derived state in render, no state writes during render beyond the I4-sanctioned adjustments, stable query keys, no waterfalls on sheet open thanks to prefetch, the code held only in hook state). Also check: no hooks in loops, no components defined inside components, `CredentialRow` and `InboxRow` memo contracts (primitive or stable props, `now` from props), the sign-in wait loop is the only async chain that outlives a panel and it stops at a final answer, `cancel` or `resetSignIn()`, `sheetIntent` on every new sheet entry point, loaders never await the sign-in GET, one arrival implementation (`lib/use-arrival.ts`) with no leftover copy in the timeline or the chat. Apply fixes as their own commits; any apps/web fix stays compliant with `vercel-react-best-practices`.

### Task 23: Full verification

Run once for the whole part (no shared lock):
- [ ] `pnpm install --frozen-lockfile` (no lockfile change: no new dependency), `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
- [ ] The dev loop from a clean clone: `git clone` the branch into a temp dir, `pnpm install --frozen-lockfile`, `pnpm build`, start `pnpm dev` with a throwaway DB and the fake CLI as `FACTORY_CLAUDE_BIN`, load the app, open Settings → Credentials, and confirm the server starts and `GET /api/claude-sign-in` answers. Shut it down and remove the clone.
- [ ] DB tests: confirm in CI (they don't run locally). Any apps/web fix made here stays compliant with `vercel-react-best-practices`.

### Task 24: Real-browser evidence (Chromium and WebKit headless)

- [ ] Use the harness at `/Users/orlevi/projects/open-factory/docs/product/ui-review/u4-evidence/harness` (main checkout, gitignored): `./run.sh <check.py> …` takes the harness's own lock (`/tmp/of-u4-evidence.lock`), runs `up.sh`, the checks, then tears down only what it started. There is no other lock. **Fake Claude only:** `FACTORY_CLAUDE_BIN` is the harness wrapper (`$WORK/claude`, written by `up.sh`, which execs the harness's own `fake.mjs`), never the real CLI.
- [ ] The harness fake has no `setup-token` mode: add one routing line at the top of `harness/fake.mjs`, after `const args = …`: `if (args[0] === "setup-token") { await import("<repo>/packages/harness/testing/fake-claude.mjs"); }` (the repo fake reads the same `process.argv` and never returns from its `setup-token` branch), and export `FAKE_CLAUDE_DIR="$WORK"` in the wrapper `up.sh` writes, so `$WORK/setup-token.pid` exists for the liveness checks. The harness fake's verification path (a cwd containing `of-verify-`) must accept the synthetic token; check it does before AC1.
- [ ] Add an `i3_*.py` check set covering spec §11.2: AC1 (sign in, then an agent starts on the credential), AC2 (reopen after a reload mid-attempt and mid-exchange with code `slow`), AC3 (server started with a 20 s TTL), AC4 (Cancel sign-in, then the pid in `$WORK/setup-token.pid` is gone: `os.kill(pid, 0)` raises `ProcessLookupError`), AC6 two tabs, AC9 row states seeded through the DB at 320 px and 200% text, AC10 (`python3` hidden from the server's `PATH`), the Inbox row, pane and Sign in again (AC8), focus after Ready and after Open sign-in page; at 1440×900 and 390×844, light and dark. Screenshots and a short results table go to `docs/product/ui-review/i3-evidence/` in the main checkout (gitignored).
- [ ] Any failure is fixed on the branch (apps/web fixes stay compliant with `vercel-react-best-practices`) and the affected checks re-run.

### Task 25: Push, PR ready for review, CI

- [ ] `git fetch origin`; `git merge --no-edit origin/i2/3-config-form` (merge, never rebase); push `i3/claude-sign-in`.
- [ ] Watch CI until green (`gh run watch` on the branch's run); fix failures on the branch (apps/web fixes stay compliant with `vercel-react-best-practices`). The final review (Task 22) findings are fixed before this point.
- [ ] Then open the PR **ready for review** (not draft) with base `i2/3-config-form`. Title `feat: sign in with Claude and credential expiry`. Body per `.github/pull_request_template.md` (What, Why, Approach as "<decision>, rather than <alternative>, because <reason>", Changes by area; template HTML comments removed), linking the spec, this plan and issue #147, stating the breaking change (ADR 0028: new columns, migration `0020_*`, the `credentialDeleted` message moved to shared `MSG`; existing OAuth credentials have unknown expiry; no reset needed) and that DB tests run only in CI. It includes Task 26 for Or. End with the attribution line. Confirm `gh pr checks` is green on the PR. **Do not merge: the user merges.**

### Task 26: Manual step for Or (not automatable; the executor never does it)

Hand this to Or in the PR body and the final report:

1. **Record a real CLI transcript (redacted):** `pnpm --filter @open-factory/server sign-in:record`. Open the printed URL, sign in, paste the code into the terminal. The script redacts in memory and writes `setup-token.recorded-<version>.txt` outside the repo; copy it into `apps/server/src/credentials/sign-in/__fixtures__/` and run `pnpm vitest run apps/server/src/credentials/sign-in` (the fixture guard fails if anything real slipped through). Revoke that token in claude.ai settings if you won't use it.
2. **Config dir and keychain check:** the script prints `ls -la` of the temp dir and the names of files containing the token; also diff `security dump-keychain | grep -i 'claude code'` (no `-d`) before and after the run, and note whether a browser tab opened by itself. **A file holding the token, or a new or changed keychain item, is a blocker:** the PR is not merged until Or reports this check clean (a keychain item persists).
3. **One real sign-in** through the UI: Add credential → Sign in with Claude, then Sign in again on it. Confirm it verifies, an agent starts on it, and `grep` of the server log for `sk-ant-`, `oauth/authorize` and the code finds nothing.
