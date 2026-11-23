# I3 Sign in with Claude Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an `oauth_token` credential by driving `claude setup-token` in a host PTY (sign-in link, pasted code, one-year token, verify, store), track its expiry with a 14-day Inbox notice, and replace it in place with Sign in again; pasting stays as a fallback.

**Architecture:** A fixed python3 PTY bridge (`String.raw` constant) runs the host `claude setup-token` with an env allow-list and a 0700 temp `HOME`/`CLAUDE_CONFIG_DIR`. Pure parsers and a small runner state machine sit behind a `PtyRun` interface. An in-memory `SignInAttempts` store (one attempt per user, `attemptId`, cap 3, 10-minute TTL while waiting for the code) owns the outcome promise and hands the token to the credential service's verified write halves. Routes live under `/api/claude-sign-in`. An hourly in-memory `ExpiryCheck` writes one `@factory` `system` message per credential (inbox kind `credential`). The web adds a Method choice with one primary at a time, a sign-in panel, a Sign in again sheet, row expiry lines and Inbox credential branches.

**Tech Stack:** TypeScript pnpm monorepo, Fastify, Postgres with Drizzle, Zod in `packages/shared`, React + Vite + TanStack Router/Query, Vitest, Biome, python3 standard library `pty` (no new npm dependency).

**Spec:** `docs/superpowers/specs/2026-11-23-i3-claude-sign-in-design.md`. Decision log: issue #147 (follow-ups #148, #149). Read the spec section each task cites before starting the task. The spec is the authority for copy and behaviour.

## Global Constraints

- **Security (owner rules, not negotiable).** Never run the real `claude setup-token`, `claude login` or any real sign-in, and never contact Anthropic's OAuth endpoints. Never read, print or copy `~/.claude`, `~/.open-factory-spike`, the macOS keychain or env vars holding tokens. Tests and evidence use the fake CLI (`packages/harness/testing/fake-claude.mjs`) only. The one real run is Or's manual step (last task).
- **No secret leaves the attempt (spec §6).** No URL, code or token in logs, events, the database (beyond the encrypted credential value), error responses, process argv or temp files. Every error answer is a fixed constant. No new pino redact wildcards (D20). No body logging on sign-in routes.
- **Pre-release, ADR 0028.** No backward compatibility, no shims, no data migration. Schema changes ship as the generated Drizzle migration plus the hand edit of `inbox_items_kind_check` (spec §5.6). PR body states: existing OAuth credentials get `expires_at` null; no reset needed.
- **Database tests run only in CI.** Server tests that use `createTestDb`/`makeTestApp` from `apps/server/src/test/helpers.ts` need Postgres; the local Postgres role is unavailable, so they run only in CI. Locally run the pure unit tests and the web tests; push and read CI for the DB suites.
- **React.** Every task that touches `apps/web`: the implementer and the reviewer invoke `vercel-react-best-practices` and follow it (Next-only rules don't apply: this is React + Vite + TanStack).
- **I4 form rules.** Use `FieldShell`/`FieldNote`, `useFieldErrors`, `useOutcome`/`FormOutcome` and `field-stack`. Every error and outcome message ≤ 40 characters, an exported constant in shared `MSG` or web `FORM_MSG`, never interpolated (success toasts excepted). I4's length and template-literal tests must cover the new constants.
- **No new npm dependency.** The PTY is python3's `pty`.
- **Limits and constants (verbatim from the spec):** TTL `SIGN_IN_TTL_MS = 10 * 60_000` (injectable); start bound 30 s; exchange bound 60 s; `settleMs = 150`; buffers 64 KB; global cap 3; settled outcome and tombstone kept 60 s; wait answer after 50 s → 202; verify retry once after 3 s; window 200×50; boot sweep of `of-sign-in-*` older than 15 minutes; code 1–512 printable ASCII after removing all whitespace; `expires_at` = token read time + 365 days; notice 14 days ahead; expiry check hourly plus once after boot.
- **Heavy jobs.** At most one evidence pass or full suite at a time on this machine, under `/tmp/of-v002-heavy.lock`: `mkdir /tmp/of-v002-heavy.lock` (retry while it exists; write your pid inside), remove it when done. Never write sleep or wait loops on other agents' processes.
- **Git.** Merge, never rebase. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Branch

Work in the worktree `/Users/orlevi/projects/open-factory/.worktrees/spec-i3`. The implementation branch `i3/claude-sign-in` is cut from `spec/i3-claude-sign-in` there. First merge the latest I2 branch on origin into the spec branch (I2's last implementation branch if it exists, e.g. `i2/3-config-form`, else `spec/i2-agent-config`):

```bash
cd /Users/orlevi/projects/open-factory/.worktrees/spec-i3
git fetch origin
git branch -r | grep 'origin/i2/'   # pick the last I2 branch, if any
git merge --no-edit origin/i2/3-config-form 2>/dev/null || git merge --no-edit origin/spec/i2-agent-config
git checkout -b i3/claude-sign-in
```

Before pushing, merge the latest lower branch again (never rebase).

Commands used throughout:
- one test file: `pnpm vitest run <path>`;
- the whole suite: `pnpm test` (heavy; take the lock);
- `pnpm typecheck`, `pnpm lint`, `pnpm build`;
- migrations: `pnpm db:generate`.

## File map

**Shared (`packages/shared/src/`)**

| File | Purpose |
|---|---|
| `messages.ts` (modify) | New `MSG.signIn*` constants (spec §6.3) |
| `settings.ts` (modify) | `CredentialSummary.expiresAt`, `.rejected` |
| `claude-sign-in.ts` (new) | `attemptViewSchema`, `signInStatusSchema`, `startSignInBodySchema`, `submitCodeBodySchema`, `waitBodySchema`, `normalizeSignInCode` |
| `messaging.ts` (modify) | `INBOX_KINDS` + `credential`; `inboxItemSchema.credential`; `link` + `{ kind: "credential", name }` |
| `index.ts` (modify) | Exports |

**DB (`packages/db/`)**

| File | Purpose |
|---|---|
| `src/schema/factory.ts` (modify) | `credentials.expiresAt`, `expiryNotifiedAt`, `rejectedAt` |
| `src/schema/agents.ts` (modify) | `messages.subjectCredentialId` (FK, cascade); `inboxItems.kind` `$type` + `credential` |
| `migrations/00NN_*.sql` (generated + hand edit) | Columns, FK, and the `inbox_items_kind_check` drop/add |

**Server (`apps/server/src/`)**

| File | Purpose |
|---|---|
| `credentials/credential-service.ts` (modify) | `insertVerified`, `replaceVerified`, `replaceById`, `rejected_at`, `expires_at`, summary fields, `inbox_changed` publish |
| `credentials/sign-in/pty-bridge.ts` (new) | `PTY_BRIDGE` constant |
| `credentials/sign-in/host-pty.ts` (new) | `PtyRun`, `startHostPty`, `probePython`, `sweepStaleDirs`, `bridgeSpawnOptions` |
| `credentials/sign-in/setup-token.ts` (new) | `stripTerminal`, `parsePrompt`, `parseToken`, `hasOAuthError`, `runSetupToken` |
| `credentials/sign-in/__fixtures__/setup-token.SYNTHETIC.txt` (new) | Synthetic transcript |
| `credentials/sign-in/attempts.ts` (new) | `SignInAttempts` store, `SignInError` |
| `credentials/expiry-check.ts` (new) | `ExpiryCheck` interval |
| `routes/claude-sign-in.ts` (new) | `/api/claude-sign-in` routes |
| `routes/credentials.ts` (modify) | Paste routes pass `expiresAt: null`, call `endFor` after a paste/API-key add |
| `routes/auth.ts` (modify) | Sign-out hook → `endFor` |
| `users/user-admin.ts` (modify) | Disable → `endFor` |
| `agents/event-store.ts` (modify) | `createHumanMessage.subjectCredentialId`, `inboxKind: "credential"`; inbox query join and `toEntries` credential branch |
| `app.ts` (modify) | Wire store, routes, expiry check, shutdown step, boot sweep |
| `scripts/sign-in-record.ts` (new) + `package.json` script `sign-in:record` | Or's recording script |

**Harness:** `packages/harness/testing/fake-claude.mjs` (modify): `setup-token` mode.

**Web (`apps/web/src/`)**

| File | Purpose |
|---|---|
| `features/settings/sign-in/api.ts` (new) | `signInQueryOptions`, `startSignIn`, `submitSignInCode`, `waitSignIn`, `cancelSignIn` |
| `features/settings/sign-in/expiry.ts` (new) | `expiryState()` |
| `features/settings/sign-in/use-sign-in.ts` (new) | Attempt hook: mutations, disappearance, deadline timer, wait loop |
| `features/settings/sign-in/sign-in-panel.tsx` (new) | Idle / Starting / Ready / Exchanging panel |
| `features/settings/forms/add-credential-form.tsx` (modify) | Method choice, one primary at a time |
| `features/settings/credentials-section.tsx` (modify) | `ExpiryLine`, Sign in again, inline auto-open, `?credential=` arrival |
| `features/settings/shared.tsx` (modify) | `RowLine` actions `flex-wrap justify-end` |
| `features/sheets/sheet-store.ts`, `sheet-bodies.ts`, `sheet-host.tsx`, `setup-sheets.tsx` (modify) | `sign-in-again` kind, top-level description, prefetch |
| `features/sheets/sign-in-again-sheet.tsx` (new) | Sheet body |
| `features/inbox/api.ts`, `inbox-row.tsx`, `inbox-pane.tsx`, `notifications.ts` (modify) | Credential branches |
| `lib/use-arrival.ts` (new) | Deep-link arrival hook extracted from `features/session/timeline.tsx` |
| `routes/_app/settings.credentials.tsx` (modify) | `validateSearch` for `?credential=` |
| `lib/form-messages.ts` (modify) | `FORM_MSG.signInOtherPanel` |

**Docs:** `DESIGN.md` (four amendments). Product docs under `docs/product/` (gitignored, main checkout only) are listed for the lead in Task 21.

---

## Part 1: Shared and data

### Task 1: Shared messages and schemas

Implements spec §5.5 (shapes), §5.8, §6.3.

**Files:**
- Create: `packages/shared/src/claude-sign-in.ts`, `packages/shared/src/claude-sign-in.test.ts`
- Modify: `packages/shared/src/messages.ts`, `packages/shared/src/settings.ts`, `packages/shared/src/messaging.ts`, `packages/shared/src/index.ts`, `packages/shared/src/messages.test.ts` (only if it lists keys explicitly)

**Interfaces:**
- Produces:
  - `MSG.signInCode`, `signInCodeRejected`, `signInUnavailable`, `signInStartFailed`, `signInBusy`, `signInExpired`, `signInEnded`, `signInReplaced`, `signInFailed`, `signInNotFound`, `signInState`, `signInTokenRejected`, `signInUnreachable`, `signInNameTaken`, `signInOAuthOnly`, `signInCredentialGone`;
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
  signInTokenRejected: "Claude rejected the new token.",
  signInUnreachable: "Couldn't reach Claude. Start again.",
  signInNameTaken: "That name was taken. Start again.",
  signInOAuthOnly: "Only OAuth tokens can sign in again.",
  signInCredentialGone: "That credential was deleted.",
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
  - `messaging.ts`: `INBOX_KINDS = ["message", "mention", "task_event", "credential"] as const`; add `credential: z.object({ name: z.string(), expiresAt: z.string().nullable(), current: z.boolean() }).optional()` to `inboxItemSchema`; add `z.object({ kind: z.literal("credential"), name: z.string() })` to the `link` discriminated union.
  - `index.ts`: `export * from "./claude-sign-in.ts";`.
- [ ] **Step 4: Run the tests and the shared package.** `pnpm vitest run packages/shared` → PASS. `pnpm typecheck` shows errors only where server/web build `CredentialSummary` or switch on `link.kind`; fix server `summarize()` now with `expiresAt: null, rejected: false` placeholders only if needed to compile; Task 3 makes them real. (Web errors are fixed in their tasks; if typecheck must pass per commit, add the two fields to test fixtures that construct `CredentialSummary`.)
- [ ] **Step 5: Commit.** `git commit -m "feat(shared): sign-in schemas, messages and the credential inbox kind"` (with the trailer).

### Task 2: Database columns and migration

Implements spec §5.6 (schema).

**Files:**
- Modify: `packages/db/src/schema/factory.ts`, `packages/db/src/schema/agents.ts`
- Create: `packages/db/migrations/00NN_<generated>.sql` (generated, then hand-edited)
- Test: `packages/db/src/schema/agents.check.test.ts` (CI only; extend)

**Interfaces:**
- Produces: `credentials.expiresAt`, `credentials.expiryNotifiedAt`, `credentials.rejectedAt` (all `timestamptz` null); `messages.subjectCredentialId` (`text`, FK `credentials.id` on delete cascade); `inboxItems.kind` `$type<"message" | "mention" | "task_event" | "credential">()`.

- [ ] **Step 1: Write the failing CI test** in `agents.check.test.ts` (DB test, runs in CI only):

```ts
it("accepts an inbox item of kind credential, refuses an unknown kind", async () => {
  const { db, userId, credentialId } = await seedForInbox(); // existing helpers in this file; add a credential row
  const [m] = await db.insert(messages).values({
    id: randomUUID(), kind: "system", notice: "credential_expiring", subjectCredentialId: credentialId,
    toAllHumans: true, body: "work expires on 2027-11-12.", state: "delivered",
  }).returning();
  await expect(db.insert(inboxItems).values({ id: randomUUID(), userId, kind: "credential", messageId: m!.id })).resolves.toBeDefined();
  await expect(db.insert(inboxItems).values({ id: randomUUID(), userId, kind: "bogus" as never, messageId: m!.id })).rejects.toThrow(/inbox_items_kind_check/);
});
it("deleting a credential deletes its notice and inbox items", async () => {
  // insert as above, then delete the credential and expect 0 messages with that subject and 0 inbox items
});
```

- [ ] **Step 2: Add the columns.** In `factory.ts` `credentials`: `expiresAt: ts("expires_at"), expiryNotifiedAt: ts("expiry_notified_at"), rejectedAt: ts("rejected_at"),`. In `agents.ts` `messages`: `subjectCredentialId: text("subject_credential_id").references((): AnyPgColumn => credentials.id, { onDelete: "cascade" }),` (import `credentials` from `./factory.ts`; if that creates an import cycle, declare the FK in the hand-edited SQL instead and keep the column plain). `inboxItems.kind` `$type` gains `"credential"`.
- [ ] **Step 3: Generate and hand-edit.** `pnpm db:generate`. Append to the generated SQL:

```sql
ALTER TABLE "inbox_items" DROP CONSTRAINT "inbox_items_kind_check";--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_kind_check" CHECK (kind IN ('message','mention','task_event','credential'));
```

  Check migration 0008 for the exact existing constraint name before editing (`grep -n inbox_items_kind_check packages/db/migrations/*.sql`).
- [ ] **Step 4: Verify locally what can run.** `pnpm typecheck` (DB package), `pnpm vitest run packages/db/src/schema/agents.test.ts` if it is pure. The CHECK test runs in CI.
- [ ] **Step 5: Commit.** `feat(db): credential expiry columns, notice subject and the credential inbox kind`.

### Task 3: Credential service split, expiry and rejection

Implements spec §5.6 (service), Q6, D10.

**Files:**
- Modify: `apps/server/src/credentials/credential-service.ts`, `apps/server/src/routes/credentials.ts`, `apps/server/src/app.ts` (pass `bus`)
- Test: `apps/server/src/credentials/credential-service.test.ts` (CI only: DB)

**Interfaces:**
- Consumes: Task 1 summary fields, Task 2 columns.
- Produces (on `CredentialService`):
  - `create(b: { name; kind; value; expiresAt: Date | null }): Promise<CredentialSummary>` (pre-check name, verify, then `insertVerified`);
  - `insertVerified(b: { name; kind; value; expiresAt: Date | null }): Promise<CredentialSummary>` (insert only; 409 `credential_exists` on a unique violation);
  - `nameTaken(name: string): Promise<boolean>`;
  - `byName(name): Promise<{ id: string; name: string; kind: CredentialKind } | undefined>`;
  - `replace(name, value)`: resolves the id and calls `replaceById(id, value, { expiresAt: null })`;
  - `replaceById(id, value, { expiresAt }): Promise<CredentialSummary>` (verify, then `replaceVerified`);
  - `replaceVerified(id, value, { expiresAt }): Promise<CredentialSummary>` (update `value_enc`, `last_verified_at = now`, `expires_at`, clear `expiry_notified_at`, `rejected_at`, `last_error`; restart active users when idle; if `expiry_notified_at` was set, `bus.publishToUser(u, { type: "inbox_changed" })` to every user id); 404 `credential_not_found` when the id is gone;
  - `reverify`: `rejected` sets `rejected_at = now()` and `last_error`; `ok` clears both and sets `last_verified_at`; `unreachable` changes neither column;
  - `summarize` sets `expiresAt` (ISO or null) and `rejected: row.rejectedAt !== null`.
- Constructor gains `bus: { publishToUser(userId: string, m: ServerMessage): void }` and a `userIds(): Promise<string[]>` read (`select id from users`).

- [ ] **Step 1: Write failing tests** (CI only) in `credential-service.test.ts`:

```ts
it("create stores expiresAt; paste passes null", async () => {
  const s = await svc({ verify: ok });
  const c = await s.create({ name: "work", kind: "oauth_token", value: "sk-ant-oat01-SYNTHETICxxxxxxxxxxxxxxxx", expiresAt: new Date("2027-11-12T00:00:00Z") });
  expect(c.expiresAt).toBe("2027-11-12T00:00:00.000Z");
  expect(c.rejected).toBe(false);
});
it("insertVerified never calls the verifier", async () => {
  const verify = vi.fn(); const s = await svc({ verify });
  await s.insertVerified({ name: "w", kind: "oauth_token", value: "v", expiresAt: null });
  expect(verify).not.toHaveBeenCalled();
});
it("replaceVerified keeps the id, sets expiry, clears notified/rejected and publishes inbox_changed", async () => {
  const { s, db, published } = await svcWithBus({ verify: ok });
  const c = await s.create({ name: "w", kind: "oauth_token", value: "a", expiresAt: null });
  const [row] = await db.select().from(credentials).where(eq(credentials.name, "w"));
  await db.update(credentials).set({ expiryNotifiedAt: new Date(), rejectedAt: new Date() }).where(eq(credentials.id, row!.id));
  const r = await s.replaceVerified(row!.id, "b", { expiresAt: new Date("2028-01-01T00:00:00Z") });
  expect(r.name).toBe(c.name);
  const [after] = await db.select().from(credentials).where(eq(credentials.id, row!.id));
  expect(after!.expiryNotifiedAt).toBeNull();
  expect(after!.rejectedAt).toBeNull();
  expect(published.some((p) => p.m.type === "inbox_changed")).toBe(true);
});
it("replaceVerified on a deleted id is 404", async () => {
  const { s } = await svcWithBus({ verify: ok });
  await expect(s.replaceVerified("missing", "b", { expiresAt: null })).rejects.toMatchObject({ code: "credential_not_found" });
});
it("reverify sets rejected_at on rejected, clears on ok, leaves it on unreachable", async () => { /* three verifier stubs, assert row.rejectedAt each time */ });
```

- [ ] **Step 2: Run.** These run only in CI (`createTestDb`). Locally confirm they at least typecheck: `pnpm typecheck` → FAIL (methods missing).
- [ ] **Step 3: Implement.** Split `create` into pre-check + `this.assertVerified(await verifier.verify(...))` + `insertVerified`. Move the `replace` body into `replaceVerified(id, …)` keyed on id; `replaceById` = verify + `replaceVerified`; `replace(name, value)` = `rowByName` → `replaceById(row.id, value, { expiresAt: null })`. In `routes/credentials.ts` the POST passes `{ ...req.body, expiresAt: null }`. Wire `bus` and user ids in `app.ts` where `CredentialService` is constructed.
- [ ] **Step 4: Verify.** `pnpm typecheck`, `pnpm vitest run apps/server/src/credentials/rate-limit-state.test.ts` (pure) → PASS. DB tests in CI.
- [ ] **Step 5: Commit.** `feat(server): credential expiry, rejection and verified write halves`.

## Part 2: The PTY, parsers, runner and store

### Task 4: Fake CLI `setup-token` mode

Implements spec §11.1. Needed by Tasks 5, 8 and 9.

**Files:**
- Modify: `packages/harness/testing/fake-claude.mjs`, `packages/harness/testing/index.ts` (wrapper env `FAKE_CLAUDE_ST_NONCE`)
- Test: `packages/harness/testing/fake-setup-token.test.ts` (new; requires python3; skip locally without it, fail in CI without it)

**Interfaces:**
- Produces: running the fake with argv `setup-token` on a TTY prints the synthetic sign-in screen (constants exported from a new `packages/harness/testing/synthetic-sign-in.mjs`: `SYNTHETIC_URL`, `SYNTHETIC_TOKEN`, `SYNTHETIC_CODE = "SYNTHETIC-CODE-1234"`), reads stdin raw; code `bad` → `OAuth error: Invalid code` then waits; `slow` → waits 70 s; other → success screen and exit 0. Process title `claude-fake-st-${process.env.FAKE_CLAUDE_ST_NONCE ?? process.pid}`. Without a TTY: exits 1, stderr `Raw mode is not supported`.

- [ ] **Step 1: Write the failing test** (`fake-setup-token.test.ts`), driving the fake through a tiny inline `python3 -c` pty harness (test-only, no secrets), asserting: the output contains `the url below to sign in`, an OSC 8 hyperlink whose URI is `SYNTHETIC_URL`, and `Paste code here if prompted`; after writing `SYNTHETIC_CODE`, a 150 ms pause, then `\r`, output contains both token anchors and the process exits 0; with `bad`, output contains `OAuth error:`; with no TTY, exit code 1.

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
- [ ] **Step 3: Implement.** In `fake-claude.mjs`, **before** `process.title = "claude"` and before any `FAKE_CLAUDE_SCENARIO` read or env logging:

```js
if (process.argv[2] === "setup-token") {
  const { SYNTHETIC_URL, SYNTHETIC_TOKEN } = await import("./synthetic-sign-in.mjs");
  process.title = `claude-fake-st-${process.env.FAKE_CLAUDE_ST_NONCE ?? process.pid}`;
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
} else {
  // existing body unchanged (process.title = "claude", scenarios, logging…)
}
```

  (Wrap the existing top-level body in the `else`, or move the `setup-token` branch into a function called first and `return`-free with `process.exitCode` — keep the existing behaviour byte-for-byte otherwise.) `synthetic-sign-in.mjs` exports fixed made-up values: `SYNTHETIC_URL = "https://claude.com/cai/oauth/authorize?client_id=9d1c8f00-1a2b-3c4d-5e6f-708192a3b4c5&code=true&code_challenge=SYNTHETICchallengeAAAAAAAAAAAAAAAAAAAAAAAAAAAA&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&response_type=code&scope=user%3Ainference&state=SYNTHETICstateBBBBBBBBBBBB"`, `SYNTHETIC_TOKEN = "sk-ant-oat01-SYNTHETIC" + "x".repeat(80)`. The wrapper written by `createFakeClaude` exports `FAKE_CLAUDE_ST_NONCE` (random) so the bridge's env allow-list doesn't need to carry it (the wrapper sets it inside the script).
- [ ] **Step 4: Run.** The test passes locally with python3. `pnpm vitest run packages/harness` → existing fake tests still pass.
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
  - `export async function sweepStaleDirs(tmp: string, now: number): Promise<void>` (removes `of-sign-in-*` with mtime older than 15 min).

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
it("sweepStaleDirs removes only of-sign-in-* older than 15 minutes", async () => { /* temp dir with utimes */ });

describe.skipIf(!hasPython && !process.env.CI)("real bridge with the fake CLI", () => {
  it("fails in CI without python3", () => { if (process.env.CI) expect(hasPython).toBe(true); });
  it("stdin EOF, SIGTERM and SIGINT leave no CLI", async () => { /* startHostPty with the fake wrapper; kill paths; pgrep -f claude-fake-st-<nonce> finds nothing */ });
  it("SIGKILL of the bridge, then the transport fallback, leaves no CLI", async () => { /* process.kill(bridgePid,"SIGKILL"); run.kill(); pgrep empty */ });
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
export class SignInError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly attempt?: AttemptView) { super(message); }
}
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
  start(userId: string, purpose: { replace?: string }): Promise<AttemptView>;        // SignInError on refusal
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
it("verification unreachable is retried once after 3 s, then signInUnreachable and the token is dropped", async () => {});
it("verification rejected is 422 sign_in_token_rejected", async () => {});
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
- [ ] **Step 3: Implement.** One `Map<userId, Attempt>` plus `Map<userId, Tombstone>`. `start`: check the existing attempt per the table, reserve `{ state: "starting", attemptId }` and count it against the cap **before** the first `await`; then `startPty()` (a `PtyUnavailable` → 503 `sign_in_unavailable`), `run(pty)`, `await run.prompt` (failure → kill, 502 `sign_in_start_failed`), set `awaiting_code`, `url`, `codeDeadline = now + ttl`, arm the TTL timer. `submit`: user lookup → 404; id check → 409 `sign_in_replaced`; state check → 409; set `submitting` synchronously; `normalizeSignInCode` → 400 `validation_error` `{ fields: { code: MSG.signInCode } }` (back to `awaiting_code`); create: `nameSchema.safeParse` → 400 `{ fields: { name } }`, `await nameTaken` → 409 `credential_exists` (back to `awaiting_code`); replace: `await byName(purpose.name)` must match `credentialId` → else end, 404 `credential_not_found` with `MSG.signInCredentialGone`; clear TTL; `exchanging`; build the `outcome` promise (`run.submit(code)` → `mintedAt = now()` → `verifying` → verify with one retry after `retryMs` → `insertVerified`/`replaceVerified` → `settled`, schedule drop after `keepMs`); map `RunFailed("code_rejected")` → 422 `sign_in_code_rejected`, `exchange_failed` → 502 `sign_in_failed`, a unique violation → 409 `sign_in_name_taken`. Return `Promise.race([outcome, timeout(waitMs) → view])`. The token stays a local of the outcome function.
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit.** `feat(server): sign-in attempt store`.

### Task 9: Routes, wiring and the secret-capture test

Implements spec §5.5, AC5, AC6, AC10, D19, D20.

**Files:**
- Create: `apps/server/src/routes/claude-sign-in.ts`, `apps/server/src/routes/claude-sign-in.test.ts` (CI only: DB via `makeTestApp`)
- Modify: `apps/server/src/app.ts` (construct `SignInAttempts` with `startHostPty({ claudeBin: config.claudeBin })`, `runSetupToken`, the verifier, the credential service; decorate `app.signIn`; register routes; cache `probePython()`), `apps/server/src/routes/credentials.ts` (after a successful POST create, `app.signIn.endFor(userId)`)

**Interfaces:**
- Consumes: Task 8 store, Task 1 schemas.
- Produces: the five routes of spec §5.5; `app.signIn: SignInAttempts`; `app.signInAvailable(): Promise<boolean>`.

- [ ] **Step 1: Write failing route tests** (CI only), with `FACTORY_CLAUDE_BIN` = the Task 4 fake wrapper and two signed-up users:

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
  const { app, cookie, spawnArgs } = await appWithFakeClaude({ logStream: { write: (l: string) => lines.push(l) } });
  // full sign-in as above, plus a failing code ("bad") run and a cancel
  const logs = lines.join("\n");
  for (const secret of [SYNTHETIC_URL, "SYNTHETICchallenge", SYNTHETIC_CODE, SYNTHETIC_TOKEN, "sk-ant-oat01"]) expect(logs).not.toContain(secret);
  for (const body of nonStartResponseBodies) expect(body).not.toContain(SYNTHETIC_URL);
  for (const body of allResponseBodies) { expect(body).not.toContain(SYNTHETIC_TOKEN); expect(body).not.toContain(SYNTHETIC_CODE); }
  expect(JSON.stringify(spawnArgs)).not.toContain(SYNTHETIC_CODE);
});
it("isolation between users and tabs (AC6)", async () => { /* user B GET → attempt null; B code/wait/DELETE → 404; A stale id → 409 sign_in_replaced */ });
it("a credential named sign-in can still be deleted", async () => { /* DELETE /api/credentials/sign-in → 204 */ });
it("python3 missing: GET available false, POST 503 sign_in_unavailable (AC10)", async () => { /* PATH without python3 */ });
it("replace via sign-in keeps the id and assignments and restarts (AC8)", async () => {});
it("replace of an api_key credential is 400 signInOAuthOnly", async () => {});
it("a paste add ends the user's awaiting_code attempt", async () => {});
```

- [ ] **Step 2: Run typecheck** (`pnpm typecheck` → FAIL: routes missing). The DB tests run in CI.
- [ ] **Step 3: Implement `routes/claude-sign-in.ts`.** `onRequest: requireUser`; schemas from Task 1; handlers call the store with `req.user.id` (use the same accessor the other routes use); map `SignInError` to `reply.code(e.status).send({ code: e.code, message: e.message, ...(e.attempt ? { attempt: e.attempt } : {}), ...(fields ? { fields } : {}) })` through the existing `ApiError` (`new ApiError(e.status, e.code, e.message, extra)`). `Outcome` → `reply.code(o.status).send({ credential })`; an `AttemptView` result → `reply.code(202).send({ attempt })`. `GET` → `{ available: await app.signInAvailable(), attempt: app.signIn.view(userId) }`. `DELETE /api/claude-sign-in/:attemptId`. No `request.log` calls with bodies. Register in `app.ts` next to `credentialsRoutes`.
- [ ] **Step 4: Verify locally.** `pnpm typecheck`, `pnpm lint`, `pnpm vitest run apps/server/src/credentials/sign-in` → PASS; push later for CI.
- [ ] **Step 5: Commit.** `feat(server): /api/claude-sign-in routes`.

### Task 10: endFor hooks, shutdown and boot sweep

Implements spec §5.4 (ends without a request), §5.2 (boot sweep), AC4.

**Files:**
- Modify: `apps/server/src/routes/auth.ts`, `apps/server/src/users/user-admin.ts`, `apps/server/src/app.ts` (shutdown step and boot sweep), `apps/server/src/users/user-admin.test.ts` and an auth route test (CI only)

**Interfaces:**
- Consumes: `app.signIn.endFor`, `closeAll`, `sweepStaleDirs`.

- [ ] **Step 1: Write failing tests** (CI only): sign-out (`POST /api/auth/sign-out` with the cookie) after a started attempt → the user's attempt is gone (`GET /api/claude-sign-in` → `attempt: null`) and the fake process is gone (`pgrep -f claude-fake-st-<nonce>` empty); disabling a user ends their attempt; `app.close()` ends every attempt.
- [ ] **Step 2: Implement.**
  - `auth.ts`: when `request.method === "POST" && url.pathname === "/api/auth/sign-out"`, before forwarding resolve `const session = await app.auth.api.getSession({ headers })`; after `res.status` is 2xx, `if (session) app.signIn.endFor(session.user.id)`.
  - `user-admin.ts`: inject `signIn: { endFor(userId: string): void }` in its deps; call `this.d.signIn.endFor(targetId)` next to `this.d.bus.closeUser(targetId)`.
  - `app.ts`: in the `onClose` hook, before the DB closes: `await app.signIn.closeAll()`. After boot reconciliation: `void sweepStaleDirs(tmpdir(), clock().getTime())`.
- [ ] **Step 3: Verify.** `pnpm typecheck`; CI for the DB tests.
- [ ] **Step 4: Commit.** `feat(server): end sign-in attempts on sign-out, disable and shutdown`.

### Task 11: Expiry check and the credential inbox item

Implements spec §5.7, §5.8, AC8, D11, D12.

**Files:**
- Create: `apps/server/src/credentials/expiry-check.ts`, `apps/server/src/credentials/expiry-check.test.ts` (CI only)
- Modify: `apps/server/src/agents/event-store.ts` (`createHumanMessage`, inbox query, `toEntries`), `apps/server/src/app.ts` (start after boot, stop on close), `apps/server/src/routes/inbox.ts` if it maps links

**Interfaces:**
- Consumes: Task 2 columns, `createHumanMessage`, `bus.publishToUser`, `config.factoryTimezone`.
- Produces: `class ExpiryCheck { constructor(d: { db; store: EventStore; bus; zone: string; now(): Date; log; interval?: number }); start(): void; stop(): void; run(): Promise<void> }`; `createHumanMessage({ …, subjectCredentialId?: string, inboxKind?: "message" | "mention" | "task_event" | "credential" })` (a `system` row requires `subjectAgentId` **or** `subjectCredentialId`); inbox entries for credential messages: `kind: "credential"`, `from: { kind: "factory", name: "factory" }`, no `about`, `credential: { name, expiresAt, current }`, `link: { kind: "credential", name }`.

- [ ] **Step 1: Write failing tests** (CI only):

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

- [ ] **Step 2: Implement.** `run()`: `const at = this.d.now();` select candidates (spec §5.7 step 1, using `at` as now); per credential `db.transaction(async (tx) => { const [hit] = await tx.update(credentials).set({ expiryNotifiedAt: at }).where(and(eq(credentials.id, c.id), isNull(credentials.expiryNotifiedAt))).returning({ id: credentials.id }); if (!hit) return []; const past = c.expiresAt <= at; const date = formatDateInZone(c.expiresAt, zone) /* YYYY-MM-DD via Intl.DateTimeFormat("en-CA", { timeZone }) */; const { userIds } = await store.createHumanMessage({ kind: "system", notice: "credential_expiring", subjectCredentialId: c.id, to: "all", inboxKind: "credential", body: `${c.name} ${past ? "expired" : "expires"} on ${date}.`, urgent: false, createdAt: at }, tx); return userIds; })`, then publish. `createHumanMessage` gains an optional `createdAt` so the message timestamp equals `expiry_notified_at` (spec §5.8 `current`). In the inbox query left-join `credentials` on `messages.subjectCredentialId`; in `toEntries` branch first on `m.subjectCredentialId` to build the credential entry (`current = cred.expiryNotifiedAt?.getTime() === m.createdAt.getTime()`). Start/stop in `app.ts` like `UploadSweep` (hourly, once after boot reconciliation).
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
- [ ] **Step 2: Implement `sign-in-redact.ts`** and the script: `sign-in-record.ts` uses `startHostPty` + `runSetupToken` semantics but accumulates raw output in memory; prints only the parsed URL; reads the code with `readline` on the terminal (no echo of it to a file); after the token parses, before anything is written: `redactTranscript(raw, …)`; before removing the temp dir, prints `ls -la` of it and the names (never contents) of files containing `sk-ant-oat01` (read files as bytes, test with `includes`, print paths only); writes the redacted text to `join(os.homedir(), "open-factory-sign-in-recording", "setup-token.recorded-<claude --version>.txt")` (outside the repo) and prints that path; asserts the redacted text has no `sk-ant-oat01-(?!SYNTHETIC)` before writing, else aborts without writing. It never logs the token.
- [ ] **Step 3: Run** `pnpm vitest run apps/server/scripts/sign-in-redact.test.ts` → PASS. Do **not** run `sign-in:record`.
- [ ] **Step 4: Commit.** `feat(server): sign-in recording script for a redacted fixture`.

## Part 3: Web

Every task in this part: **Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

### Task 13: Sign-in API, expiry state and the arrival hook

Implements spec §8.3 (query), §8.4 (`expiryState`), §8.6 (arrival hook, `validateSearch`).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/settings/sign-in/api.ts`, `apps/web/src/features/settings/sign-in/expiry.ts`, `apps/web/src/features/settings/sign-in/expiry.test.ts`, `apps/web/src/lib/use-arrival.ts`, `apps/web/src/lib/use-arrival.test.tsx`
- Modify: `apps/web/src/features/session/timeline.tsx` (use the extracted hook, no behaviour change), `apps/web/src/routes/_app/settings.credentials.tsx` (`validateSearch: z.object({ credential: z.string().min(1).optional().catch(undefined) })`; loader also prefetches `signInQueryOptions`)

**Interfaces:**
- Produces:
  - `signInQueryOptions` (`queryKey: ["claude-sign-in"]`, `staleTime: 0`, `refetchOnWindowFocus: true`, no `refetchInterval`);
  - `startSignIn(body: { replace?: string }): Promise<AttemptView>`;
  - `submitSignInCode(b: { attemptId; code; name? }): Promise<{ kind: "done"; credential: CredentialSummary } | { kind: "pending"; attempt: AttemptView }>` (201/200 → done, 202 → pending);
  - `waitSignIn(attemptId): Promise<same union>`; `cancelSignIn(attemptId): Promise<void>`;
  - `isRetryableWaitError(err: unknown): boolean` (true for network errors and `ApiError` whose code matches `/^http_\d+$/`);
  - `type ExpiryState = { tone: "none" } | { tone: "muted"; text: string } | { tone: "warning" | "crimson"; text: string; needsSignIn: true }`; `expiryState(expiresAt: string | null, now: Date, locale?: string, timeZone?: string): ExpiryState`;
  - `useArrival(targetKey: string | undefined, opts: { ref: RefObject<HTMLElement | null> }): boolean` (scrolls to centre, focuses with the inset ring class, sets the 6% tint for 2 s of visible time, then a 300 ms fade).

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

  `use-arrival.test.tsx`: renders a row with `useArrival("work", { ref })`; asserts `scrollIntoView({ block: "center" })` called, focus moved, the tint class present, then removed after 2 s of visible time (fake timers; `document.visibilityState` toggled to `hidden` pauses it). The session timeline's existing arrival tests still pass.
- [ ] **Step 2: Run, confirm failure.** `pnpm vitest run apps/web/src/features/settings/sign-in apps/web/src/lib/use-arrival.test.tsx`.
- [ ] **Step 3: Implement.** `expiryState`: `delta = expires - now`; `<= 0` → crimson `Expired ${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone }).format(expires)}`; `<= 14 days` → warning; days = difference of calendar dates in `timeZone`, clamped to at most 14, text `today`/`tomorrow`/`in N days`; else muted `Expires ${month short + year}`. The API functions use `apiFetch` with the Task 1 schemas. Extract the timeline's arrival logic into `useArrival` and make `timeline.tsx` call it (same timings, same reduced-motion behaviour).
- [ ] **Step 4: Run.** PASS; `pnpm vitest run apps/web/src/features/session` still PASS.
- [ ] **Step 5: Commit.** `feat(web): sign-in API, expiry state and a shared arrival hook`.

### Task 14: Credential row: expiry line, Sign in again, arrival

Implements spec §8.4, §8.6 (`?credential=`), AC9.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/features/settings/credentials-section.tsx`, `apps/web/src/features/settings/shared.tsx` (`RowLine` actions `flex flex-wrap justify-end`)
- Test: `apps/web/src/features/settings/credentials-section.test.tsx` (extend)

**Interfaces:**
- Consumes: `expiryState` (Task 13), `useArrival` (Task 13), `openSheet({ kind: "sign-in-again", name })` (Task 17 adds the kind; until then, this task adds the `SheetSpec` member and a stub body to keep types compiling, or orders Task 17's store change first — do the store change here).

- [ ] **Step 1: Write failing component tests:**

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
it("Sign in again opens the sign-in-again sheet", async () => { /* spy openSheet */ });
it("?credential=work arrives on that row", () => {});
```

- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement** `ExpiryLine` (icon + text, tones from DESIGN.md tokens: `text-muted-foreground`, warning token, `text-destructive`) followed by a `Button variant="ghost" size="xs"` "Sign in again" when `needsSignIn`; the rejected case appends the same button after `VerificationState`; the menu item; `useArrival(search.credential === c.name ? c.name : undefined, { ref })` on the row, focusing its Sign in again when shown. Read `search` with the route's `useSearch`.
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit.** `feat(web): credential expiry line and Sign in again on the row`.

### Task 15: The sign-in panel and its attempt hook

Implements spec §8.2, §8.3, R1, R2, R5, R7, AC2, AC3.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/settings/sign-in/use-sign-in.ts`, `apps/web/src/features/settings/sign-in/sign-in-panel.tsx`, `apps/web/src/features/settings/sign-in/sign-in-panel.test.tsx`
- Modify: `apps/web/src/lib/form-messages.ts` (`FORM_MSG.signInOtherPanel: "Another sign-in is open; Start ends it."`)

**Interfaces:**
- Consumes: Task 13 API, Task 1 `MSG`.
- Produces:

```ts
type Phase = "loading" | "idle" | "starting" | "ready" | "exchanging" | "verifying";
export function useSignIn(o: { purpose: "create" } | { purpose: "replace"; name: string }): {
  phase: Phase; attempt: AttemptView | null; available: boolean;
  line: { tone: "help" | "error"; text: string } | undefined;   // the panel's Idle line
  start(): void; submit(b: { code: string; name?: string }): void; cancel(): void;
  codeError?: string; nameError?: string; outcome?: string;      // routed per §8.2 Errors
  done?: CredentialSummary;                                       // only for the tab that submitted
  pendingLabel: "Starting…" | "Signing in…" | "Verifying…" | undefined;
};
export function SignInPanel(p: { s: ReturnType<typeof useSignIn>; frame: "inline" | "sheet"; code: string; onCode(v: string): void; codeRef: RefObject<HTMLInputElement | null> }): JSX.Element;
```

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
it("202 then wait loop; retries only on network and http_ errors, never on a coded error", async () => {});
it("a settled success is rendered only by the tab that submitted", async () => {});
it("purpose mismatch shows the other-panel line", async () => {});
it("exchanging makes Code and Name readOnly + aria-disabled and hides Cancel sign-in", async () => {});
it("the code mutation keeps no variables after it settles", async () => { /* queryClient.getMutationCache().getAll() empty of the code */ });
it("states swap with no transition classes (R7)", () => {});
```

- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement.** `useSignIn`: `useQuery(signInQueryOptions)`; mutations with `setQueryData` on success; the code mutation `gcTime: 0` and `reset()` in `onSettled`; remember the shown `attemptId` and the submitted one in refs (handlers only, never written during render); derive disappearance in an effect keyed on `attempt?.attemptId` (compare with the last shown id; no local action pending); one `setTimeout` to `codeDeadline` that calls `refetch()`; the wait loop as a mutation chain (`onSuccess` pending → `wait`; `onError` retryable → `wait`). Map errors to `codeError`/`nameError`/Idle line/`outcome` per spec §8.2. `SignInPanel`: no reserved height; Ready = link button (`buttonVariants({ variant: "outline" })` on an `<a>`, `ExternalLink` icon), `CopyIcon` ghost button with `useCopy`, `CopyFailed`, the muted host + `Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" })` line; Code via `FieldShell` + `Input` (`className="font-mono"`, `autoComplete="one-time-code"`, `autoCapitalize="none"`, `autoCorrect="off"`, `spellCheck={false}`); a polite `role="status"` "Sign-in page ready."; Cancel sign-in ghost (sheet frame only).
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit.** `feat(web): sign-in panel and attempt hook`.

### Task 16: Add credential form: Method and one primary at a time

Implements spec §8.1, AC1, AC2, AC10, D13.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/features/settings/forms/add-credential-form.tsx`, `apps/web/src/features/settings/forms/form-frame.tsx` (an `autoFocus={false}` escape for restore; a primary that can be "Start sign-in"), `apps/web/src/features/settings/credentials-section.tsx` (inline auto-open on a live `create` attempt; inline Cancel → `cancelSignIn`), `apps/web/src/features/sheets/sheet-bodies.ts` (`add-credential` prefetch `signInQueryOptions`)
- Test: `apps/web/src/features/settings/forms/add-credential-form.test.tsx`

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
```

- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement.** Replace the Kind radios with "Method" (`sign_in` | `paste_token` | `api_key`, UI state); keep per-method values; the frame's submit label/pending label and `onSubmit` come from the method and `s.phase` (`idle` → `s.start()`, `ready` → `f.submit()` for Name then `s.submit({ code, name })`); `done` → `onDone(credential)`; Settings section reads `signInQueryOptions` on load to open the inline form.
- [ ] **Step 4: Run.** PASS; existing add-credential tests updated to the Method wording.
- [ ] **Step 5: Commit.** `feat(web): Add credential with Sign in with Claude`.

### Task 17: Sign in again sheet

Implements spec §8.5, D14.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/sheets/sign-in-again-sheet.tsx`, `apps/web/src/features/sheets/sign-in-again-sheet.test.tsx`
- Modify: `apps/web/src/features/sheets/sheet-store.ts` (`SheetSpec` + `{ kind: "sign-in-again"; name: string }`), `apps/web/src/features/sheets/sheet-bodies.ts` (entry: lazy load, prefetch credentials + `signInQueryOptions`, title "Sign in again", `description: (spec) => spec.name` rendered mono), `apps/web/src/features/sheets/sheet-host.tsx` (render a top-level description when the body entry provides one)

**Interfaces:**
- Consumes: Task 15 (`useSignIn({ purpose: "replace", name })`), `cappedList`, `restartNote`, Sonner `toast`.

- [ ] **Step 1: Write failing tests:** the sheet shows "Sign in again" with the mono name description; primary Start sign-in then **Sign in and replace**; on success the sheet closes, one toast "Signed in again: work." plus the capped restart note, and `qc.invalidateQueries({ queryKey: ["inbox"] })` (use the inbox feature's real key) and the credentials key are called; a `replace` attempt for another name shows the other-panel line.
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement** with `SheetFormFooter` + `FormOutcome`, the `SignInPanel` with `frame="sheet"`; the toast text is built in the success handler (toasts are exempt from the no-interpolation rule).
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit.** `feat(web): Sign in again sheet`.

### Task 18: Inbox credential row, pane and notifications

Implements spec §8.6, AC8.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/features/inbox/api.ts` (link mapping), `apps/web/src/features/inbox/inbox-row.tsx` (`Link` target, `SenderLine`, `ContextLine`, `labelOf`), `apps/web/src/features/inbox/inbox-pane.tsx` (`OpenLink` "Open credentials", `Sender`, the body switch → new `CredentialContent`, `prefetchPane`, `onOpen`), `apps/web/src/features/inbox/notifications.ts` (`notificationTitle`, click target)
- Test: `apps/web/src/features/inbox/inbox-row.test.tsx`, `inbox-pane.test.tsx`, `notifications.test.tsx` (extend)

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
```

- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement** each branch named in the spec; every `link.kind` ternary becomes an exhaustive `switch` with `credential` (TypeScript `never` check), so a future kind fails to compile.
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit.** `feat(web): credential expiry notice in the Inbox`.

## Part 4: Docs

### Task 19: DESIGN.md amendments

Implements spec §12 (DESIGN.md).

**Files:** Modify `DESIGN.md`.

- [ ] **Step 1:** Add the four amendments verbatim from spec §12 in their sections: **Rows** (deep-link arrival, beside "Selected rows"), **Inputs** (one-time codes), **Forms** (one primary at a time), **Motion → Live rows** (deadlines as fixed clock times, beside "waiting lines keep fixed times"). Also update the Components → Session timeline "Deep-link arrival" bullet to point to the Rows rule.
- [ ] **Step 2: Commit.** `docs: DESIGN.md amendments for sign-in (arrival, one-time codes, one primary, deadlines)`.

### Task 20: In-repo docs

**Files:** Modify `README.md` only if it documents credentials setup (search for `setup-token`); replace "run `claude setup-token`" guidance with "Settings → Credentials → Add credential → Sign in with Claude (needs python3 on the server); pasting a token still works". Commit `docs: README sign-in`.

### Task 21: Product docs (for the lead)

`docs/product/` is gitignored and exists only in the main checkout (`/Users/orlevi/projects/open-factory/docs/product/`). **Edit it only when the lead instructs you to; otherwise list these changes in your final report for the lead:** ADR 0027 amendment, `concepts/credential.md`, `behavior/administration.md` → Credentials, `behavior/inbox.md`, `architecture/data-model.md`, and the I3 task spec, each exactly as spec §12 states.

## Part 5: Finish

### Task 22: Whole-branch review

- [ ] Fresh reviewer, read-only, over `git diff spec/i3-claude-sign-in...i3/claude-sign-in` against the spec: every AC has a test or an evidence item; spec §6 security (grep the diff for `log.` / `request.log` near `url`, `code`, `token`; confirm no new redact wildcard; `PTY_BRIDGE` test present; spawn options test present; no `process.env` spread into the child); ADR 0028 (no compatibility code); I4 rules (all new messages constants ≤ 40); **the React diff checked against `vercel-react-best-practices`** (the reviewer invokes the skill first: effects only for external sync, derived state in render, no state writes during render beyond the I4-sanctioned adjustments, stable query keys, no waterfalls on sheet open thanks to prefetch, mutations not retaining the code). Apply fixes as their own commits.

### Task 23: Full verification

- [ ] Take `/tmp/of-v002-heavy.lock`.
- [ ] `pnpm install --frozen-lockfile` (no lockfile change: no new dependency), `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
- [ ] The dev loop from a clean clone: `git clone` the branch into a temp dir, `pnpm install --frozen-lockfile`, `pnpm build`, start `pnpm dev` with a throwaway DB and the fake CLI as `FACTORY_CLAUDE_BIN`, load the app, open Settings → Credentials, and confirm the server starts and `GET /api/claude-sign-in` answers. Shut it down and remove the clone.
- [ ] Release the lock. DB tests: confirm in CI (they don't run locally).

### Task 24: Real-browser evidence (Chromium and WebKit headless)

- [ ] Use the harness at `/Users/orlevi/projects/open-factory/docs/product/ui-review/u4-evidence/harness` through its `run.sh` lock, plus the shared `/tmp/of-v002-heavy.lock` (at most one evidence pass or full suite at a time on this machine). `FACTORY_CLAUDE_BIN` is the harness's **fake** wrapper, extended with the Task 4 `setup-token` mode: a synthetic URL and token only, **never the real CLI**.
- [ ] Add an `i3_*.py` check set covering spec §11.2: AC1 (sign in, then an agent starts on the credential), AC2 (reopen after a reload mid-attempt and mid-exchange with code `slow`), AC3 (server started with a 20 s TTL), AC4 (Cancel sign-in, then `pgrep -f claude-fake-st-` empty), AC6 two tabs, AC9 row states seeded through the DB at 320 px and 200% text, AC10 (`python3` hidden from the server's `PATH`), the Inbox row, pane and Sign in again (AC8), focus after Ready and after Open sign-in page; at 1440×900 and 390×844, light and dark. Screenshots and a short results table go to `docs/product/ui-review/i3-evidence/` in the main checkout (gitignored).
- [ ] Any failure is fixed on the branch and the affected checks re-run.

### Task 25: Push, draft PR, CI

- [ ] `git fetch origin`; merge the latest lower branch (I2's last implementation branch on origin, else `spec/i2-agent-config`) — merge, never rebase; push `i3/claude-sign-in`.
- [ ] Open a **draft** PR with base = I2's last implementation branch on origin (if none exists yet, `spec/i2-agent-config`, and note in the PR body to retarget once I2's branch exists). Title `feat: sign in with Claude and credential expiry`. Body per `.github/pull_request_template.md` (What, Why, Approach as "<decision>, rather than <alternative>, because <reason>", Changes by area), linking the spec, this plan and issue #147, stating the breaking change (new columns; existing OAuth credentials have unknown expiry; no reset needed) and that DB tests run only in CI. End with the attribution line.
- [ ] Watch CI until green (`gh pr checks --watch`); fix failures on the branch. Do not merge.

### Task 26: Manual step for Or (not automatable; the executor never does it)

Hand this to Or in the PR body and the final report:

1. **Record a real CLI transcript (redacted):** `pnpm --filter @open-factory/server sign-in:record`. Open the printed URL, sign in, paste the code into the terminal. The script redacts in memory and writes `setup-token.recorded-<version>.txt` outside the repo; copy it into `apps/server/src/credentials/sign-in/__fixtures__/` and run `pnpm vitest run apps/server/src/credentials/sign-in` (the fixture guard fails if anything real slipped through). Revoke that token in claude.ai settings if you won't use it.
2. **Config dir and keychain check:** the script prints `ls -la` of the temp dir and the names of files containing the token; also diff `security dump-keychain | grep -i 'claude code'` (no `-d`) before and after the run, and note whether a browser tab opened by itself. **A file holding the token, or a new or changed keychain item, is a blocker:** report it before the PR leaves draft.
3. **One real sign-in** through the UI: Add credential → Sign in with Claude, then Sign in again on it. Confirm it verifies, an agent starts on it, and `grep` of the server log for `sk-ant-`, `oauth/authorize` and the code finds nothing.
