# I1 Chat and Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@` handles for every principal with a database-enforced namespace and list recipients; a raw Session composer; a per-human Chat as the default agent view with Inbox chat rows; `send_command` for agents; the `/context` fix.

**Architecture:** Four stacked PRs in one worktree. PR 1 changes the messaging core (handles table, envelope attributes, list sends). PR 2 replaces U3's allowlisted command dispatch with one raw-input route and a shared denylist. PR 3 adds a chat thread API, a per-user `chat_changed` frame, the Chat route under an agent layout route, and chat rows in the Inbox. PR 4 adds the `send_command` MCP tool on top of PR 2's raw entries.

**Tech Stack:** TypeScript pnpm monorepo; Fastify, Drizzle + Postgres, pg-boss, better-auth 1.7.25 (server); React 19 + Vite, TanStack Router and Query (web); Zod schemas in `packages/shared`; Vitest; Biome.

**Spec:** `docs/superpowers/specs/2026-11-23-i1-chat-and-session-design.md` (read it with this plan; § numbers below are the spec's). Decisions issue: #135. Product docs (`docs/product/`) are gitignored: read them from the main checkout `/Users/orlevi/projects/open-factory/docs/product/`, and apply the product-doc edits listed in each PR there (never in the worktree), naming them in the PR description.

## Global Constraints

- Pre-release, ADR 0028: no compatibility code, no shims, no aliases for old shapes, no data migration or backfill. Migrations are `pnpm --filter @open-factory/db generate` output plus, in PR 1 only, one hand-appended `INSERT` of the reserved handle rows. **Reset local data** (drop the database, recreate agents) before the first boot of PR 1.
- Never run real Claude. No spike credentials; never read `~/.open-factory-spike`. The fake Claude only.
- Server DB tests (anything using `makeTestApp`, `createTestDb`, `seedTestAgent` or a runtime harness with a DB) **run only in CI**: the local Postgres role is unavailable. Locally run unit tests that need no DB, `pnpm typecheck`, `pnpm lint`, and the web tests. Each task that adds DB tests says so; push and read CI for them.
- Every task touching `apps/web`: **Implementer and reviewer invoke `vercel-react-best-practices` and follow it.** (React + Vite + TanStack Router/Query: skip Next-only rules.)
- Forms follow I4 (`2026-11-23-i4-field-errors-design.md`): reserved note line, `useFieldErrors`, copy ≤ 40 chars in `MSG`/`FIELD_MSG`/`FORM_MSG`. I1 adds no form; existing sign-up and New agent field errors keep their codes.
- Copy is literal and in sentence case: "the session", "the chat" in prose; "Chat"/"Session" only as button labels. One link wording: "Open session".
- Denylist reasons (exact): `/{typed} isn't available: each agent keeps one session.` (clear, new, reset); `/{typed} isn't available: the model and effort come from the agent's template.` (model, effort); `/{typed} isn't available: credentials are managed in Settings → Credentials.` (login, logout); `/{typed} isn't available: the factory runs this agent's process.` (exit, quit, resume, continue).
- `@humans` refusal (exact): "`@humans` isn't a handle. Message people by handle; list_peers lists them." (mention variant: "Mention people by handle; list_peers lists them.").
- Channels refusal (exact): "Channels aren't supported yet."
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR titles are conventional commits; bodies follow `.github/pull_request_template.md` (What, Why, Approach with "X, rather than Y, because Z", Changes), link the spec and #135, list the product-doc edits, remove the template's HTML comments, end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Never merge.
- Commands: unit tests `pnpm vitest run <path>`; web `pnpm vitest run --project web <path>` (the `apps/web` project); typecheck `pnpm typecheck`; lint `pnpm lint`; build `pnpm build`.
- At most one browser evidence pass or full test suite at a time on this machine.

## Branches

| PR | Branch | Cut from | PR base |
|---|---|---|---|
| 1 | `i1/1-handles-recipients` | `spec/i1-chat-and-session` | `i6/path-help` if it exists on origin, else `spec/i6-path-help` |
| 2 | `i1/2-raw-session` | `i1/1-handles-recipients` | `i1/1-handles-recipients` |
| 3 | `i1/3-chat-inbox` | `i1/2-raw-session` | `i1/2-raw-session` |
| 4 | `i1/4-send-command` | `i1/3-chat-inbox` | `i1/3-chat-inbox` |

All in `/Users/orlevi/projects/open-factory/.worktrees/spec-i1`. When a lower branch changes (review fixes, base moved), merge it upward (`git merge`, never rebase).

---

# Part 1: `i1/1-handles-recipients` (spec §4)

### Task 1.1: Branch, `handles` table, FKs, reserved rows, fixture helper

**Files:**
- Create: `packages/db/src/schema/handles.ts`
- Modify: `packages/db/src/schema/index.ts`, `packages/db/src/schema/agents.ts` (`agents.slug` FK), `packages/db/src/schema/auth.ts` (`users.handle` FK)
- Create: `packages/db/migrations/00NN_<generated>.sql` (generated, then append the INSERT)
- Create: `apps/server/src/test/handles.ts` (fixture helper)
- Modify: `apps/server/src/test/helpers.ts`, `apps/server/src/agents/testing/rows.ts` (`insertAgent`), `apps/server/src/agents/testing/runtime-harness.ts`, every `apps/server/src/test/smoke-*.ts` that inserts agents or users
- Test: `packages/db/src/schema/handles.test.ts` (DB: CI only)

**Interfaces:**
- Produces: `schema.handles` (`handle text pk`, `kind 'agent'|'user'|'reserved'`, `claimedAt`); `claimTestHandle(db, handle, kind)` in `apps/server/src/test/handles.ts`.

- [ ] **Step 1:** `git switch -c i1/1-handles-recipients spec/i1-chat-and-session`.
- [ ] **Step 2: Write the failing test** (`packages/db/src/schema/handles.test.ts`, modelled on `agents.check.test.ts`):

```ts
test("an agent row needs a handles row", async () => {
  await expect(db.insert(schema.agents).values(agentValues({ slug: "nohandle" }))).rejects.toThrow(/foreign key/);
});
test("reserved rows are seeded by the migration", async () => {
  const rows = await db.select().from(schema.handles).where(eq(schema.handles.kind, "reserved"));
  expect(rows.map((r) => r.handle).sort()).toEqual([...RESERVED_HANDLES].sort());
});
test("kind is checked", async () => {
  await expect(db.insert(schema.handles).values({ handle: "x1", kind: "team" as never })).rejects.toThrow(/check/);
});
```
- [ ] **Step 3:** Add the table:

```ts
// packages/db/src/schema/handles.ts
export const handles = pgTable(
  "handles",
  {
    handle: text("handle").primaryKey(),
    kind: text("kind").notNull().$type<"agent" | "user" | "reserved">(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("handles_kind", sql`${t.kind} IN ('agent','user','reserved')`)],
);
```
  and `.references(() => handles.handle)` on `agents.slug` and `users.handle` (keep their unique indexes).
- [ ] **Step 4:** `pnpm --filter @open-factory/db generate`; append to the generated SQL, after the DDL, one statement: `INSERT INTO "handles" ("handle","kind") VALUES ('me','reserved'),('factory','reserved'),('scheduler','reserved'),('all','reserved'),('system','reserved'),('humans','reserved');--> statement-breakpoint` (values from `RESERVED_HANDLES` in `packages/shared/src/handle.ts`; a comment above it says it is part of the schema, not a backfill).
- [ ] **Step 5:** `apps/server/src/test/handles.ts`: `claimTestHandle(db, handle, kind)` = `db.insert(handles).values({handle, kind}).onConflictDoNothing()`. Call it before every direct insert into `agents`/`users` in `insertAgent`, `seedTestAgent`, `runtime-harness.ts` and the smoke scripts; any helper that truncates tables re-seeds the reserved rows (`INSERT … ON CONFLICT DO NOTHING`).
- [ ] **Step 6:** `pnpm typecheck && pnpm lint`. DB tests run in CI only (push the branch later in Task 1.15).
- [ ] **Step 7:** Commit `feat(db): handles table claimed by agents and users`.

### Task 1.2: `claimHandle` and `resolveName` on `handles`

**Files:**
- Modify: `apps/server/src/messaging/principals.ts` (delete `isNameTaken`, add `claimHandle`, rewrite `resolveName`)
- Test: `apps/server/src/messaging/principals.test.ts` (DB: CI only)

**Interfaces:**
- Produces:
  ```ts
  export async function claimHandle(db: Db | Tx, handle: string, kind: "agent" | "user"): Promise<boolean>;
  export type ResolvedName =
    | { kind: "agent"; agent: AgentRow }
    | { kind: "user"; userId: string; handle: string; disabled: boolean }
    | { kind: "reserved"; name: string }
    | { kind: "channel"; name: string }
    | { kind: "none"; name: string };
  export async function resolveName(db: Db | Tx, raw: string): Promise<ResolvedName>;
  export async function handleKind(db: Db | Tx, handle: string): Promise<"agent" | "user" | "reserved" | undefined>; // the cheap pre-read
  ```

- [ ] **Step 1: Failing tests** (`principals.test.ts`):

```ts
test("claim, then the same claim again by the same kind while unreferenced is a reclaim", async () => {
  expect(await claimHandle(db, "ada", "user")).toBe(true);
  expect(await claimHandle(db, "ada", "user")).toBe(true); // orphan reclaimed
});
test("an agent never reclaims a user orphan", async () => {
  await claimHandle(db, "bob", "user");
  expect(await claimHandle(db, "bob", "agent")).toBe(false);
});
test("a referenced claim is taken", async () => {
  await seedUser(db, { handle: "cy" }); // inserts the claim and the user
  expect(await claimHandle(db, "cy", "user")).toBe(false);
});
test("reserved is never reclaimed", async () => {
  expect(await claimHandle(db, "humans", "user")).toBe(false);
});
test.each([
  ["#ops", "channel"], ["@humans", "reserved"], ["humans", "reserved"], ["@nobody", "none"],
])("resolveName(%s) is %s", async (raw, kind) => expect((await resolveName(db, raw)).kind).toBe(kind));
test("resolveName reports a disabled user", async () => { /* set disabled_at, expect disabled: true */ });
```
- [ ] **Step 2:** Implement `claimHandle` with the spec §4.1 statement through Drizzle's `sql` (`RETURNING handle`; true when a row comes back). `resolveName`: trim; `#` prefix → `channel`; strip one `@`; `select handles left join agents on slug left join users on handle where handles.handle = name`; map by `kind`. Delete `isNameTaken` and the `ambiguous`/`humans` kinds.
- [ ] **Step 3:** `pnpm typecheck` (callers break: fixed in Tasks 1.3, 1.4, 1.7). Lint.
- [ ] **Step 4:** Commit `feat(server): one handle claim and one name lookup`.

### Task 1.3: Agent create and spawn claim in their transaction

**Files:**
- Modify: `apps/server/src/agents/agent-service.ts` (~L465-520 `create`/`createLocked`), `apps/server/src/spawning/spawn-service.ts` (L84 pre-read loop, L254 insert)
- Test: `apps/server/src/agents/agent-service.test.ts`, `apps/server/src/spawning/spawn-service.test.ts` (DB: CI only)

**Interfaces:**
- Consumes: `claimHandle`, `handleKind` (Task 1.2).

- [ ] **Step 1: Failing tests:** "create with a user's handle → FieldError slug_taken (409)"; "create while a user claim is in flight (claim inserted, no user row) → slug_taken and no duplicate"; "two concurrent creates of one slug: one succeeds, the other slug_taken (a 23505 on agents.slug is mapped too)"; spawn: "a taken suffix retries the next name, including on 23505".
- [ ] **Step 2:** Pre-read before materialise: `if (await handleKind(db, b.slug)) throw slugTaken();`. In the insert transaction: `if (!(await claimHandle(tx, slug, "agent"))) throw slugTaken();` before `insert(agents)`; catch `pgCode(err, "23505")` (`apps/server/src/db-errors.ts`) on the agent insert → `slugTaken()`. Spawn: same in its transaction at L254; the retry loop at L84 uses `handleKind` and continues on a false claim or 23505.
- [ ] **Step 3:** typecheck, lint. Commit `feat(server): agents claim their slug in the create transaction`.

### Task 1.4: Users claim in the auth hook; update-user under the mutex

**Files:**
- Modify: `apps/server/src/auth/options.ts` (before-hook ~L95-115; `nameTaken` option becomes `claim`), `apps/server/src/auth/auth.ts` (wire `claim: (h) => claimHandle(db, h, "user")`), `apps/server/src/routes/auth.ts` (update-user through `signUpMutex.run("sign-up", …)`)
- Test: `apps/server/src/auth/auth.test.ts`, `apps/server/src/auth/options.test.ts` (DB: CI only)

- [ ] **Step 1: Failing tests:**
  - "sign-up with an agent's slug → 422 HANDLE_TAKEN";
  - "a sign-up that fails with an email in use leaves a claim that the next sign-up with that handle reclaims";
  - "update-user with a handle and no session → 401 and no handles row" (assert `select count(*) from handles where handle = <h>` is 0);
  - "update-user to an invalid handle → 400 and no claim";
  - "update-user keeping one's own handle is not a change";
  - "the before-hook runs before the user insert on sign-up and update-user" (spy on `claimHandle` and the adapter's create/update; assert call order);
  - "update-user and sign-up are serialised" (two requests; the mutex spy sees both keys `sign-up`).
- [ ] **Step 2:** In the hook: `const r = handleSchema.safeParse(handle); if (!r.success) return;`. For `/update-user`: `const session = await getSessionFromCtx(ctx); if (!session) return; if (session.user.handle === handle) return;`. Then `if (!(await p.claim(handle))) throw new APIError("UNPROCESSABLE_ENTITY", { code: "HANDLE_TAKEN", message: "That handle is already taken" });`.
- [ ] **Step 3:** `routes/auth.ts`: `url.pathname === "/api/auth/update-user" && request.method === "POST"` → `signUpMutex.run("sign-up", () => app.auth.handler(req))`, with a code comment: the mutex is in-process and assumes one server process (ADR 0013); a multi-instance deployment needs a Postgres advisory lock here too.
- [ ] **Step 4:** Guard check (spec §4.1): the claim path is the one statement plus `handleSchema`; if implementing needs more, stop and tell the tech-lead.
- [ ] **Step 5:** typecheck, lint. Commit `feat(server): users claim their handle before better-auth writes`.

### Task 1.5: Envelope `from_kind`, `to`, `@` agents, `by` with `@`

**Files:**
- Modify: `packages/harness/src/types.ts` (`FactoryMessage`), `packages/harness/src/envelope.ts` (`BatchRow`, `one()`, `single`, `merge`), `packages/shared/src/messaging.ts` (`envelopeSchema` gains `fromKind`, `to`), `apps/server/src/agents/agent-runtime.ts` (`entryOf` ~L262: `@slug`, `fromKind`, `to` from `row.recipients`; every `by: \`@${…}\`` site keeps one `@`), `apps/server/src/agents/event-store.ts` (`authorLabel` ~L1047 → `@slug`), `apps/server/src/messaging/forwarder.ts`/`notices.ts` prose that names agents
- Test: `packages/harness/src/envelope.test.ts`, `apps/server/src/agents/agent-runtime.messaging.test.ts` (or the existing envelope-rendering runtime test; DB: CI only)

**Interfaces:**
- Produces: `FactoryMessage.fromKind: "human" | "agent" | "factory"`, `FactoryMessage.to?: string[]`; envelope text `from_kind="…"` after `from`, `to="@a @b"` after `kind` on `kind="message"` only.

- [ ] **Step 1: Failing test** (`envelope.test.ts`):

```ts
test("a direct message carries from_kind and the full recipient list", () => {
  const [m] = groupEnvelopes([row({ from: "@lead", fromKind: "agent", kind: "message", to: ["@orlevi", "@dev"] })]);
  expect(renderEnvelopes([m!])).toMatch(
    /^<factory-message from="@lead" from_kind="agent" kind="message" to="@orlevi @dev" urgent="false" id="m1">/,
  );
});
test("other kinds carry from_kind and no to", () => {
  const [m] = groupEnvelopes([row({ from: "@factory", fromKind: "factory", kind: "system" })]);
  expect(renderEnvelopes([m!])).not.toMatch(/ to="/);
  expect(renderEnvelopes([m!])).toMatch(/from_kind="factory"/);
});
```
- [ ] **Step 2:** Implement: `one()` renders `from_kind="${m.fromKind}"` and, when `m.kind === "message" && m.to?.length`, `to="${attr(m.to.join(" "))}"`. `entryOf`: agent sender `from = \`@${fromSlug}\``, `fromKind` = `human` (fromHandle) / `agent` (fromSlug) / `factory` (system, scheduled, none); `about = \`@${subjectSlug}\``; `to = row.recipients ?? undefined`. Update the runtime and store tests' expected envelopes.
- [ ] **Step 3:** `pnpm vitest run packages/harness/src/envelope.test.ts` PASS; typecheck; lint. Commit `feat(harness): envelopes name every sender with @ and carry from_kind and to`.

### Task 1.6: `messages.recipients`, widened client-id index

**Files:**
- Modify: `packages/db/src/schema/agents.ts` (`messages`: `recipients: text("recipients").array()`, check `messages_recipients` `kind <> 'message' OR recipients IS NOT NULL`; `messages_client_id_unique` on `(from_user_id, client_message_id, to_agent_id)`)
- Create: generated migration
- Modify: `apps/server/src/agents/event-store.ts` (`createMessage`, `createClientMessage`, `createHumanMessage` take `recipients`; `byClientMessageId` returns all rows)
- Test: `packages/db/src/schema/agents.check.test.ts` (DB: CI only)

- [ ] **Step 1: Failing test:** inserting a `kind='message'` row without `recipients` violates `messages_recipients`.
- [ ] **Step 2:** Schema, `generate`, store signatures (`recipients: string[]` required for `kind: "message"`). `byClientMessageId(userId, id): Promise<PendingRow[]>`.
- [ ] **Step 3:** typecheck, lint. Commit `feat(db): messages record their recipients`.

### Task 1.7: Router list send with per-recipient results

**Files:**
- Modify: `apps/server/src/messaging/router.ts` (`send` takes `to: string[]`; `sendFromHuman` folds in), `apps/server/src/routes/agents.ts` (POST `/api/agents/:slug/messages` calls `send(user, [slug], …)` until PR 3 replaces it)
- Test: `apps/server/src/messaging/router.test.ts` (DB: CI only)

**Interfaces:**
- Produces:
  ```ts
  export type RecipientResult =
    | { to: string; kind: "human"; status: "inbox"; id: string }
    | { to: string; kind: "agent"; status: "queued"; recipient_status: AgentStatus; id: string; item?: QueueItem }
    | { to: string; kind: "agent"; status: "pending"; id: string; note: string }
    | { to: string; kind: "agent"; status: "start_failed"; id: string; note: string }
    | { to: string; status: "refused"; reason: string; code: RefusalCode };
  export type RefusalCode = "not_found" | "reserved" | "channel" | "self" | "archived" | "terminated" | "disabled" | "human" | "invalid_attachment" | "too_large";
  send(from: Sender, to: string[], body: string, urgent: boolean, opts?: { clientMessageId?: string; attachments?: string[] }): Promise<{ results: RecipientResult[] }>;
  ```

- [ ] **Step 1: Failing tests:** dedupe (`["dev", "@dev"]` → one row, one result); self refused alone; a terminated recipient refused alone while the others get rows; all refused; `#ops` → channel reason; `@humans` → the exact `@humans` sentence; disabled user → "@x's account is disabled."; human sender with a human target → refused; every accepted row has the same `recipients` (accepted only, in order); one inbox item per human recipient and `inbox_changed` published to that user only (`publishToUser`); errored agent → `pending` with the note; client-id retry returns every row's result.
- [ ] **Step 2:** Implement: resolve all; build accepted list; one transaction inserting rows (agent: `createMessage` / `createClientMessage`; human: `createHumanMessage({to: {userId}, recipients})`); after commit, hand over agent rows (human sender awaited, `AgentStartError` → `start_failed` for that recipient with its row pending; agent sender enqueued); results in input order. Attachments only with one agent recipient (else `invalid_attachment` for all). `createHumanMessage`'s `"all"` throws unless `kind === "system"`.
- [ ] **Step 3:** typecheck, lint. Commit `feat(server): send to a list of recipients, each succeeding or failing alone`.
- Note (M7): the old `POST /api/agents/:slug/messages` route keeps its response shape (`queueItemResponseSchema`, built from the single result's `item`) until Task 3.5 deletes it, so the web's `postMessage` parser in `features/session/api.ts` is untouched in PR 1; a route test asserts the shape.

### Task 1.8: `send_message` tool

**Files:**
- Modify: `packages/shared/src/agents.ts` (`sendMessageToolSchema.to: z.array(z.string().min(1).max(65)).min(1).max(10, "Send to at most 10 recipients at once.")`), `apps/server/src/mcp/tools/send-message.ts`
- Test: `apps/server/src/mcp/tools/send-message.test.ts` (create; DB: CI only)

- [ ] **Step 1: Failing tests:** result is `{results: […]}` as JSON text; all refused → `toolError` with one line per reason; a string `to` → validation error; description mentions handles and lists, never `@humans`.
- [ ] **Step 2:** Implement; description: "Send a message to one or more handles (an agent's @slug or a person's @handle), up to 10. Every recipient sees the full list. Set urgent to interrupt agents that are working."
- [ ] **Step 3:** typecheck, lint. Commit `feat(mcp): send_message takes a list of recipients`.

### Task 1.9: Remove `@humans` everywhere on the server

**Files:**
- Modify: `apps/server/src/tasks/task-service.ts` (~L89, L177-188, L240, L336-343, L804-842, L919-922), `apps/server/src/mcp/tools/task-tools.ts` (L240 description, L249 result), `apps/server/src/agents/event-store.ts` (L1210, L1339 → `"everyone"` for `toAllHumans`), `apps/server/src/spawning/spawn-service.ts` (L76, L144, L163, L217, L303)
- Create: `apps/server/src/no-humans-handle.test.ts`
- Test: `apps/server/src/tasks/task-service.test.ts`, `apps/server/src/mcp/tools/task-tools.test.ts` (DB: CI only)

- [ ] **Step 1: Failing tests:** a comment mentioning `@humans` posts and `not_reached` = `[{name: "humans", reason: "reserved"}]` with the reason text "`@humans` isn't a handle. Mention people by handle; list_peers lists them."; no inbox items are written; spawn failures read "ask your manager" for a caller with a manager and "ask a human (list_peers lists them)" otherwise.
- [ ] **Step 2:** The grep test:

```ts
test("no agent-facing @humans outside the reserved list", async () => {
  const files = await glob("apps/server/src/**/*.ts", { ignore: ["**/*.test.ts"] });
  const hits = files.filter((f) => readFileSync(f, "utf8").includes("@humans"));
  expect(hits).toEqual([]);
});
```
- [ ] **Step 3:** Delete the `humans` branches; route `humans` through the reserved path; add the reserved-text override for `humans` in `comment_task`'s result; relabel; rewrite spawn copy (`fail(callerHasManager ? "…ask your manager." : "…ask a human (list_peers lists them).")`).
- [ ] **Step 4:** typecheck, lint, `pnpm vitest run apps/server/src/no-humans-handle.test.ts`. Commit `feat(server): remove @humans; agents address people by handle`.

### Task 1.10: `list_peers` one `peers` list; disabled users left out

**Files:**
- Modify: `apps/server/src/messaging/neighborhood.ts` (`humans()` filters `isNull(users.disabledAt)`), `apps/server/src/mcp/tools/list-peers.ts`
- Test: `apps/server/src/mcp/server.test.ts` (existing `listPeersTool` cases; DB: CI only)

- [ ] **Step 1: Failing test:** result `{peers: [...]}` with agents (`handle: "@team-lead"`, `kind: "agent"`, `displayName`, `description`, `relation`, `status`) first in today's order, then humans `{handle: "@orlevi", kind: "human", name}` by name then handle; a disabled user is absent; `scope: "all"` adds `relation: "other"` agents.
- [ ] **Step 2:** Implement; names through `inline()`.
- [ ] **Step 3:** typecheck, lint. Commit `feat(mcp): list_peers lists agents and humans in one list`.

### Task 1.11: CLAUDE.md: humans in "Your org", messaging rules, envelope description

**Files:**
- Modify: `apps/server/src/workspace/claude-md.ts` (`messagingSection`, `tasksSection`, "How messages reach you", `orgSection`), its input builder (pass the non-disabled humans), `apps/server/src/workspace/claude-md.test.ts` and `__snapshots__`

- [ ] **Step 1: Failing tests:** the snapshot contains "Humans: `@orlevi` (Or Levi)" capped at 25 with "and N more; call mcp__factory__list_peers"; no `@humans`; the envelope paragraph says "`from` is the sender's handle; `from_kind` says whether it is a human, an agent or the factory; `to` lists everyone a message was sent to."; messaging lines exactly as spec §4.6.
- [ ] **Step 2:** Implement; regenerate snapshots (`pnpm vitest run apps/server/src/workspace/claude-md.test.ts -u`), read the diff.
- [ ] **Step 3:** Commit `feat(server): agents' context lists the humans and drops @humans`.

### Task 1.12: Web: senders by kind, multi-recipient outgoing card, no `@humans`

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/session/message-block.tsx` (L112: sender from `fromKind`), `apps/web/src/features/session/speaker-line.tsx` (drop "All humans"), `apps/web/src/features/session/outgoing-message.tsx` (L15 schema `to: z.array(z.string())`, L64-73 results), `apps/web/src/features/inbox/inbox-row.tsx` (L42-44, L90), `apps/web/src/features/inbox/notifications.ts` (L80-84), `apps/web/src/features/mentions/mention-source.ts` (no `@humans` row)
- Modify: `DESIGN.md` (amendment §9.4: speaker line for several recipients)
- Test: `apps/web/src/features/session/outgoing-message.test.tsx` (create), existing `message-block`/`speaker-line` tests

- [ ] **Step 1: Failing tests:** a `send_message` call to 10 recipients renders "Ada → @a, @b +8" with the full list in the row menu's Recipients item and the line's accessible name; a result with one `refused` and one `pending` renders one muted line each ("Not sent to @x: terminated"); a call without a result renders from its arguments; an agent sender in a `message_in` envelope is rendered from `fromKind: "agent"`.
- [ ] **Step 2:** Implement. No `useMemo` for "+N" (a cheap string); extend the existing `parsedResults` WeakMap in `outgoing-message.tsx` to cache the parsed `{results}`; `Intl` objects (`PluralRules`, `NumberFormat`) are module-level.
- [ ] **Step 3:** `pnpm vitest run --project web apps/web/src/features/session`; typecheck; lint. Commit `feat(web): senders by kind and outgoing cards to several recipients`.

### Task 1.13: Fake Claude learns `$mcp`

**Files:**
- Modify (main checkout, gitignored product material): `/Users/orlevi/projects/open-factory/docs/product/ui-review/u4-evidence/harness/fake.mjs` (the browser harness's fake; `up.sh` wraps it as `FACTORY_CLAUDE_BIN`). `packages/harness/testing/fake-claude.mjs` is the server tests' fake and is not used by the harness; leave it.

- [ ] **Step 1:** Add a directive `{"$mcp": {"tool": "send_message", "args": {...}}}`: read the agent's `.mcp.json` in `cwd` (`mcpServers.factory.url`), `POST` JSON-RPC `tools/call` with `Authorization: Bearer ${process.env.OPEN_FACTORY_AGENT_TOKEN}` and `Accept: application/json, text/event-stream`, log `{kind: "mcp", tool, status, body}`. Also emit a matching `tool_use` assistant line first with `name: "mcp__factory__<tool>"` and the args, then the `tool_result` from the response, so the Session shows the call.
- [ ] **Step 2:** Demo check: through `run.sh` with one check script `docs/product/ui-review/i1-evidence/checks/c00_list_send.py` that queues `$mcp send_message {to: ["@or", "@bob"]}` on `ada` and asserts bob's session shows an envelope with `to="@or @bob"` and Or's Inbox has the message. Note the results path in the PR.
- [ ] **Step 3:** Nothing to commit in the worktree (gitignored); record the fake's change in the PR description.

### Task 1.14: Product docs for PR 1 (main checkout)

- [ ] Edit in `/Users/orlevi/projects/open-factory/docs/product/`: `concepts/message.md`, `concepts/user.md` (L17-18), `concepts/task.md` (L38), `concepts/reporting-line.md`, `architecture/factory-mcp.md`, `architecture/context-assembly.md`, `architecture/data-model.md` (`handles`, `recipients`), `architecture/permissions.md` (L40), `behavior/tasks.md`, `behavior/inbox.md`, and the task doc's AC ("a `@humans` mention is posted and reported as not reached"). Replace "Planned in v0.0.2" notes for what PR 1 delivers. List each file in the PR body.

### Task 1.15: PR 1 review, verification, PR, CI

- [ ] **Step 1:** Review the PR 1 diff (`git diff spec/i1-chat-and-session...`) against spec §4: every bullet has code and a test. The reviewer checks the React diff (`apps/web`) against `vercel-react-best-practices`.
- React checklist (copied from Task 5.1, the reviewer ticks each): stable references in live lists; memoised rows and markdown; no effects that derive state; query keys per data; no request waterfalls in route loaders; suspense/preload in loaders; handoffs (optimistic → server, queued → timeline, working → outcome) keyed in the **same parent array** so the node is reused; no new arrays, objects or elements passed as memo props; ws frames routed in one place (global `onMessage` or the per-agent session stream), never both.
- [ ] **Step 2:** `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm vitest run --project web && pnpm build`.
- [ ] **Step 3:** `git push -u origin i1/1-handles-recipients`; `gh pr create --base <i6/path-help or spec/i6-path-help> --title "feat: @ handles for everyone, list recipients, no @humans"` with the template filled (Approach bullets: claim-first handles rather than triggers because …; per-recipient rows with a recipients column rather than a group id because …; `@humans` as a reserved name rather than a refusal branch because …), "Reset local data before the first boot", the product docs list, the fake's `$mcp` note, and "Server DB tests run in CI only (local Postgres role unavailable)".
- [ ] **Step 4:** Watch CI (`gh pr checks --watch`); fix until green. Never merge.

---

# Part 2: `i1/2-raw-session` (spec §5)

### Task 2.1: Shared denylist and input classification

**Files:**
- Modify: `packages/shared/src/commands.ts` (add; delete `runCommandBodySchema` and `commandText` once callers go in 2.6)
- Test: `packages/shared/src/commands.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const DENIED_COMMANDS: Readonly<Record<string, "session" | "model" | "credentials" | "process">>;
  export function deniedReason(typed: string): string | undefined; // exact Global Constraints copy, "/{typed}" as typed
  export type InputClass =
    | { kind: "text" }
    | { kind: "command"; name: string; args: string; denied?: string; multiline: boolean };
  /** `text` is already trimEnd'ed; `known` holds lowercase names and aliases (list + snapshot + template skills). */
  export function classifyInput(text: string, known: ReadonlySet<string>): InputClass;
  export const inputBodySchema: z.ZodType<{ text: string; clientMessageId: string }>;
  ```

- [ ] **Step 1: Failing tests:**

```ts
test.each(["/clear", "/NEW", "  /quit", "/Resume x", "/continue"])("%s is denied", (t) =>
  expect(classifyInput(t, new Set())).toMatchObject({ kind: "command", denied: expect.stringContaining("isn't available") }));
test("the reason names the command as typed", () =>
  expect(deniedReason("QUIT")).toBe("/QUIT isn't available: the factory runs this agent's process."));
test("/news-digest is not /new", () => expect(classifyInput("/news-digest", new Set(["news-digest"]))).toMatchObject({ kind: "command", denied: undefined }));
test("an unknown /path is text, even on several lines", () => expect(classifyInput("/Users/or/log.txt shows:\nError", new Set())).toEqual({ kind: "text" }));
test("a known multi-line command is flagged", () => expect(classifyInput("/context\nmore", new Set(["context"]))).toMatchObject({ multiline: true }));
test("aliases count as known", () => expect(classifyInput("/cost", new Set(["cost"]))).toMatchObject({ kind: "command" }));
```
- [ ] **Step 2:** Implement (first token = `trimStart` text up to whitespace without the `/`, compared lowercased; a command when the token is in `known` or `DENIED_COMMANDS`).
- [ ] **Step 3:** `pnpm vitest run packages/shared/src/commands.test.ts` PASS. Commit `feat(shared): one denylist and one rule for what is a command`.

### Task 2.2: Built-ins snapshot

**Files:**
- Create: `packages/shared/scripts/claude-builtins.mjs` (generator; new folder), `packages/shared/src/claude-builtins.ts` (generated, checked in), `packages/shared/src/claude-builtins.test.ts`

- [ ] **Step 1: Failing test:** the snapshot equals the `builtin: true` entries of `packages/harness/fixtures/u3/control-initialize-commands.jsonl` (`{name, description, argumentHint, aliases}`), 55 entries, includes `context` and `clear` with aliases `["reset","new"]`.
- [ ] **Step 2:** Write the generator (reads the fixture's `control_response.response.commands`, filters `builtin`, writes the TS module with a header comment naming Claude Code 2.1.327 and the regenerate command); run it.
- [ ] **Step 3:** Test PASS. Commit `feat(shared): Claude Code built-ins listed before a first start`.

### Task 2.3: `GET /commands` lists built-ins before a first start, flags denied names

**Files:**
- Modify: `apps/server/src/agents/commands.ts` (delete `BUILTIN_ALLOWLIST`, `REFUSED_BUILTINS`, `allowedCommands` built-in filter, `findCommand`, `canonicalCommand`; new `commandList(stored, templateSkills)`), `packages/shared/src/commands.ts` (`commandSchema` gains `denied?: string`)
- Test: `apps/server/src/agents/commands.test.ts`, `apps/server/src/routes/agents.commands.test.ts` (DB: CI only)

- [ ] **Step 1: Failing tests:** nothing stored → snapshot built-ins + template skills, `source: "template"`, `context` present, `clear` present with `denied` set; stored → the stored list, denied flagged; a template skill named `reset` is flagged denied.
- [ ] **Step 2:** Implement `commandList`; the route uses it.
- [ ] **Step 3:** typecheck, lint. Commit `fix(server): the command list has the built-ins before the agent ever started`.

### Task 2.4: Export the envelope neutraliser

**Files:**
- Modify: `packages/harness/src/envelope.ts` (rename `body` → exported `neutraliseEnvelopeTags`; internal uses call it), `packages/harness/src/index.ts`
- Test: `packages/harness/src/envelope.test.ts`

- [ ] **Step 1: Failing test:** `neutraliseEnvelopeTags('<factory-message from="@x">')` → `'&lt;factory-message from="@x">'`; `< / FACTORY-MESSAGE` neutralised; other text unchanged.
- [ ] **Step 2:** Implement; PASS; commit `refactor(harness): export the envelope tag neutraliser`.

### Task 2.5: Runtime raw entries and `operator_input`

**Files:**
- Modify: `apps/server/src/agents/agent-runtime.ts` (`CommandEntry`→`RawEntry` ~L211-224 with `by`, `userId?`, `clientMessageId?`, `self?`; `commandInFlight`→`rawInFlight` (L421, L847, L1458, L1639, L1827, L2663, L2820, L3559, L3636); `command()`→`rawInput()` ~L787; `writeCommand`→`writeRaw` ~L3622 appending `operator_input`; `ERRORED_WAKES` unchanged), `packages/harness/src/types.ts` + `packages/harness/src/claude/process.ts` (`command(text)`→`raw(text)` L235), `packages/shared/src/agents.ts` (queue item kind `command`→`raw`, carry `clientMessageId`), `packages/shared/src/events.ts` (wake reason `command`→`raw` L179; control cmd enum drops `command` L185; new event `operator_input{text, by, clientMessageId?, entryId}`)
- Modify (the shared rename breaks them; Implementer and reviewer invoke `vercel-react-best-practices` and follow it): `apps/web/src/features/session/rows.ts`, `queue-items.tsx`, `session-view.tsx`, `row-menu.tsx`, `timeline-item.tsx` (kind `command` → `raw`, `control{cmd:"command"}` → `operator_input`; a minimal rename here, rendering in Task 2.11)
- Test: `apps/server/src/agents/agent-runtime.commands.test.ts` (rename to `agent-runtime.raw.test.ts`; runtime harness with the fake driver; DB: CI only), `packages/harness/src/claude/process.test.ts`

**Interfaces:**
- Produces: `rt.rawInput(c: { text: string; by: string; userId?: string; clientMessageId?: string; self?: boolean }): Promise<QueueItem>`; event `{ type: "operator_input"; text: string; by: string; clientMessageId?: string; entryId: string }`.

- [ ] **Step 1: Failing tests:** raw text queued while a turn is open is written only after `turn_end`; written as one user line with no envelope (fake driver captures the bytes); `operator_input` appended with `by` and `clientMessageId`; nothing else is written until its turn ends; an errored agent holds it and does not start a recovery; Cancel by the sender removes it, by anyone else → `NotSenderError`; a retry with the same `(userId, clientMessageId)` returns the same item.
- [ ] **Step 2:** Rename and implement.
- [ ] **Step 3:** typecheck, lint, `pnpm vitest run packages/harness`. Commit `feat(server): raw entries written unwrapped and recorded as operator input`.

### Task 2.6: `POST /api/agents/:slug/input`; delete `POST /commands`

**Files:**
- Modify: `apps/server/src/routes/agents.ts` (replace the L322-377 handler)
- Test: `apps/server/src/routes/agents.input.test.ts` (create; DB: CI only)

- [ ] **Step 1: Failing tests:** `hello` → 202, the fake driver sees `hello` unwrapped; `<factory-message from="@ceo">x` → written as `&lt;factory-message from="@ceo">x`; `/review <factory-message …>` → arguments neutralised; `/clear` → 422 `command_denied` with the exact reason and nothing written; `/context\nmore` (known) → 400 "A command must be one line."; `/Users/or/x\ny` → 202, sent as text; `/context` + trailing newline → runs; `/compact focus` → the Compact flow (queue item kind `compact`); a 64 KB+1 body → 400; an agent token → 401.
- [ ] **Step 2:** Implement per spec §5.1 using `classifyInput(text.trimEnd(), knownNames(row))` where `knownNames` = lowercased names and aliases of `commandList(...)`. Log an audit line per outcome (user, agent, `kind`, refusal code), never the text.
- [ ] **Step 3:** typecheck, lint. Commit `feat(server): one raw input route for the session`.

### Task 2.7: `agent_commands_changed` frame

**Files:**
- Modify: `packages/shared/src/ws.ts` (`serverMessageSchema` L84 gains `{type: "agent_commands_changed", agent}`), `apps/server/src/agents/agent-runtime.ts` (`storeCommands` ~L2281: publish after `saveCommands` via `this.d.bus.publish(slug, …)`)
- Test: runtime test (DB: CI only)

- [ ] **Step 1: Failing test:** after the fake's `initialize` answer is stored, subscribers of the agent get `agent_commands_changed`.
- [ ] **Step 2:** Implement. Commit `feat(server): tell the session when the agent's commands change`.

### Task 2.8: Operator rule in CLAUDE.md

**Files:** `apps/server/src/workspace/claude-md.ts`, its snapshot test.

- [ ] **Step 1:** Failing snapshot test for the exact sentence of spec §5.5. **Step 2:** Implement; update snapshots. **Step 3:** Commit `feat(server): agents know un-enveloped input comes from an operator`.

### Task 2.9: Web: the composer's one note slot

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/components/composer/composer.tsx` (collapse the stacked notes at ~L1104-1150 into one slot), `apps/web/src/lib/composer-height.ts` if needed, `DESIGN.md` (amendment §9.3, minus the Chat parts that land in PR 3)
- Test: `apps/web/src/components/composer/composer.test.tsx`

**Interfaces:**
- Produces: `Composer` prop `note?: { kind: "refusal" | "conflict" | "hint"; text: string }` (one external note, a stable object from the caller); the composer picks the shown note **during render** by priority (error > refusal > conflict > hint), merging it with its internal notes (error, pending, attach); no effect, no state for the choice. `held` gains `reason` linked by `aria-describedby`.

- [ ] **Step 1: Failing tests:** with a fine pointer the note renders in the toolbar hint slot and the frame's height (`getBoundingClientRect().height`) is equal before and after a refusal appears; below `md` (coarse) the reserved line exists with no note; priority error > refusal > conflict > hint; the slot is announced via the existing live region; a held Send is `aria-disabled`, focusable, and pressing it shows the reason.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `pnpm vitest run --project web apps/web/src/components/composer`; commit `feat(web): one note slot that never moves the composer`.

### Task 2.10: Web: Session composer in raw mode

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/session/composer.tsx` (drop `onCommand`, `postCommand`, command mode; `postInput`), `apps/web/src/features/session/commands.ts` (delete `postCommand`, `COMMAND_UNCONFIRMED`, `SENDS_AS_TEXT`, `NOT_A_COMMAND`, `unescapeSlash`, `NAME_AND_SPACE`, `ESCAPED`; `accept` inserts `/name `; denied rows shown only on an exact prefix match, disabled with the reason), `apps/web/src/features/session/api.ts` (`postInput(slug, {text, clientMessageId}, signal)`), `apps/web/src/components/composer/composer.tsx` (remove command mode and its chip, `commandFor`, `enterNeedsExact` paths that existed only for it)
- Test: `apps/web/src/features/session/composer.test.tsx`

- [ ] **Step 1: Failing tests:** placeholder "Raw input to Claude · / for commands"; at rest the hint "Goes to Claude as typed · Message Ada in Chat" (the link goes to `/agents/ada/chat` — until PR 3 it targets `/agents/ada`, and PR 3 updates the test); with a turn open "Runs after the current turn."; toolbar has `/` and no `@` or attach; a dropped file shows "Files can be sent from the chat"; ⌥Enter sends like Enter; typing `/clear ` shows the reason in the note slot and Send is held; `/news-digest` shows nothing while typed; Enter on `/context` while the commands query is pending POSTs `/input` with `/context`; a pasted `/context` + Enter POSTs `/input`; an empty list + `/context` POSTs `/input`; Esc closes the menu, else stops the turn.
- [ ] **Step 2:** Implement. The denied-command note and (PR 3) the Chat's leading-`/` note come from the identity-stable `/` source's `textNote(text)`; the lowercase known-name `Set` is built once per commands data (a WeakMap keyed on the query data object), never per keystroke; no effects. Drafts: rename `agentDraftKey` to `sessionDraftKey` (`session:<slug>` under `of-draft:v1:`), no alias.
- [ ] **Step 3:** web tests; typecheck; lint. Commit `feat(web): the session composer writes raw input`.

### Task 2.11: Web: one node from Sending to the `operator_input` row

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/session/session-state.ts` (handoff ~L352-371 extended to `operator_input` by `clientMessageId`), `apps/web/src/features/session/queue-items.tsx` (L219-255: raw item rendered in the speech shape, keyed by `clientMessageId ?? id`), `apps/web/src/features/session/rows.ts` / `timeline-row.tsx` (an `operator_input` row: speaker "You · raw" / "{name} · raw", mono for commands, `pre-wrap` + `overflow-wrap:anywhere`, the clamp)
- Test: `apps/web/src/features/session/session-state.test.ts`, `queue-items.test.tsx`, `timeline-row.test.tsx`

- Placement (H1): pending and queued raw blocks render as **tail items of `Timeline`'s items** (like `liveRows`), keyed `raw:${clientMessageId}`, not in a separate queue list; `rows.ts` gives an `operator_input` row with a `clientMessageId` the same key, so React reuses the node across the three states.
- [ ] **Step 1: Failing tests:** the reducer replaces the raw queue item with the `operator_input` row in one step and lists it in `handedOff` (no fade); the Sending block, queued item and row are one element (a ref callback counts mounts: exactly one across Sending → queued → row); `SLOW_SEND_MS` and `YOUNG_ITEM_MS` hide "Sending…"/"Runs after…" for fast paths; Cancel on a queued raw item; ↑ recalls your newest `operator_input`.
- [ ] **Step 2:** Implement. **Step 3:** web tests; commit `feat(web): raw input keeps one block from send to timeline`.

### Task 2.12: Web: fresh command list after a start

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/routes/_app.tsx` (the global `onMessage`: `agent_commands_changed` → `qc.invalidateQueries({ queryKey: ["agent-commands", m.agent] })`), `apps/web/src/features/session/use-session.ts` (skips `agent_commands_changed` and, from PR 3, `chat_changed`)
- Test: `apps/web/src/features/session/messaging.test.tsx` (or `commands.test.ts`)

- [ ] **Step 1: Failing tests:** the global handler invalidates the query for `m.agent`; the open menu re-reads rows (`watch`); `use-session`'s reducer ignores the frame (no state change, no re-render).
- [ ] **Step 2:** Implement. Commit `fix(web): the command list refreshes when the agent starts`.

### Task 2.13: Product docs for PR 2 (main checkout)

- [ ] `concepts/session.md`, `behavior/agents-and-sessions.md`, `architecture/harness-driver.md` (`raw(text)`, `operator_input`), `architecture/claude-streaming-and-commands.md`, `architecture/agent-runtime.md` (raw entries), `architecture/context-assembly.md` (operator rule). List them in the PR.

### Task 2.14: PR 2 review, verification, PR, CI

- [ ] Review the PR 2 diff against spec §5 and the React diff against `vercel-react-best-practices` (React checklist below); `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm vitest run --project web && pnpm build`; push; `gh pr create --base i1/1-handles-recipients --title "feat: raw session input with a denylist; fix /context"` (Approach: one raw route rather than an allowlisted command route because …; classification by known names rather than any leading `/` because …; built-ins snapshot rather than an empty list because …); CI until green; never merge.
- React checklist (copied from Task 5.1, the reviewer ticks each): stable references in live lists; memoised rows and markdown; no effects that derive state; query keys per data; no request waterfalls in route loaders; suspense/preload in loaders; handoffs (optimistic → server, queued → timeline, working → outcome) keyed in the **same parent array** so the node is reused; no new arrays, objects or elements passed as memo props; ws frames routed in one place (global `onMessage` or the per-agent session stream), never both.

---

# Part 3: `i1/3-chat-inbox` (spec §6)

### Task 3.1: Turn close seq, exit and boot stamping, indexes

**Files:**
- Modify: `packages/db/src/schema/agents.ts` (`turns.endEventSeq integer`; partial indexes `messages_chat_in_idx (to_agent_id, from_user_id, created_at) where kind='message'`, `messages_chat_out_idx (to_user_id, from_agent_id, created_at) where kind='message'`), generated migration
- Modify: `apps/server/src/agents/event-store.ts` (`closeTurnWith(turnId, close, ids, attribute, endEventSeq?)` L732; `closeTurn` L695 records `max(seq)`; `closeDanglingTurns` L749 stamps delivered unstamped `kind='message'` rows with `delivered_event_seq >=` the turn's first event seq, same transaction)
- Modify: `apps/server/src/agents/agent-runtime.ts` (`turn_end` L2621-2650 passes the appended `turn_end` seq; `onExited` ~L2808-2845 snapshots `closing = {turnId, ids, senders, since}` before resetting, closes with `closeTurnWith(turnId, close, closing.ids, true, lastSeq)`, clears `closing` in `finally`; `batchUnanswered` with no open turn: `openTurn` + `closeTurnWith(…, {isError: true, terminalReason: "process_exited"})`)
- Test: `apps/server/src/agents/agent-runtime.task-attribution.test.ts` (extend), new `agent-runtime.chat-turns.test.ts` (DB: CI only)

- [ ] **Step 1: Failing tests:** a normal close stores `end_event_seq` = the `turn_end` seq; an exit mid-turn stamps the starting batch and closes with `process_exited`; an exit with a written batch and no turn creates a zero-length errored turn stamped with the batch; `closeDanglingTurns` stamps the dangling turn's delivered messages; during the exit close, `closing` is visible (asserted through `workingFor` in Task 3.2).
- [ ] **Step 2:** Implement. **Step 3:** typecheck, lint. Commit `feat(server): every turn that read a message is stamped, however it ends`.

### Task 3.2: Runtime `workingFor(userId)`

**Files:**
- Modify: `apps/server/src/agents/agent-runtime.ts` (`awaiting` entries keep `{ids, senders: Map<id, userId|null>, writtenAt, firstIdBySender}`; absorbed rows recorded per open turn; `workingFor`)
- Test: `agent-runtime.chat-turns.test.ts` (DB: CI only)

**Interfaces:**
- Produces: `rt.workingFor(userId: string): { key: string; since: string } | null` — `key` = id of the user's first message in the batch (or the first absorbed row of the user in the open turn); `since` = the batch's write time; also reports `closing` until its close settles.

- [ ] **Step 1: Failing tests:** null before any write; set from the batch write (cold start: before `turn_started`); unchanged key across `turn_started` and a cron turn starting meanwhile; null after `turn_end`'s close commits; during `onExited`'s close it still reports `closing`; another user's batch → null for you.
- [ ] **Step 2:** Implement. Commit `feat(server): the runtime knows when a turn is working on your message`.

### Task 3.3: `GET /api/agents/:slug/chat`

**Files:**
- Create: `apps/server/src/agents/chat-store.ts` (queries), `packages/shared/src/chat.ts` (`chatEntrySchema`, `chatPageSchema` per spec §6.3 with `key`, `eventSeq: number | null`)
- Modify: `apps/server/src/routes/agents.ts` (route), `packages/shared/src/index.ts`
- Test: `apps/server/src/routes/agents.chat.test.ts` (DB: CI only)

- [ ] **Step 1: Failing tests:** both directions, newest page oldest-first, `before` paging; another human's thread with the agent is excluded; cancelled rows excluded; rejected rows carry `rejectReason`; outcomes `no_reply`, `stopped` (aborted tools/streaming, `process_stopped`), `error` (`is_error`, `process_exited`, `factory_restarted`), suppressed by a reply inside the turn; `eventSeq` from `turns.end_event_seq`; `around=<id>` returns 25 each side with `newerCursor`; `working` is read before the query and dropped when its `key` already has an outcome in the page; 401 for agent tokens; 404 unknown slug.
- [ ] **Step 2:** Implement (outcome query: turns joined to messages on `delivered_turn_id`, `from_user_id = me`, `not exists` a message from the agent to me with `created_at between started_at and ended_at`; `key` = min message id of yours per turn by `created_at`). Check `EXPLAIN` on the 214-agent dataset (`seed_worst.mjs` via the harness DB) uses the partial indexes; paste it in the PR.
- [ ] **Step 3:** typecheck, lint. Commit `feat(server): a per-human chat thread with turn outcomes`.

### Task 3.4: `chat_changed` frame

**Files:**
- Modify: `packages/shared/src/ws.ts` (`{type: "chat_changed", agent}`), `apps/server/src/messaging/router.ts` (publish on create to the human party), `apps/server/src/agents/agent-runtime.ts` (on batch write, `turn_started`, close, cancel/restore, reject: publish to each human sender involved), `apps/server/src/agents/event-store.ts` callers as needed
- Test: router and runtime tests (DB: CI only)

- [ ] **Step 1: Failing tests:** each publish point sends `chat_changed{agent}` to that user only (`publishToUser`) and to no other user.
- [ ] **Step 2:** Implement. Commit `feat(server): tell a human when their chat with an agent changes`.

### Task 3.5: `POST /api/messages`; delete the per-agent message route

**Files:**
- Create: `apps/server/src/routes/messages.ts` (extend: `POST /api/messages`)
- Modify: `apps/server/src/routes/agents.ts` (delete L204-241), `apps/web/src/features/session/api.ts` (delete `postMessage`, the old route's caller; the inbox pane's reply that still uses it is replaced in Task 3.14, so do this deletion as the last step of Task 3.14 if 3.5 lands first: the web must never call a deleted route), `packages/shared/src/agents.ts` (`sendMessagesBodySchema = {to: string[] 1..10, body, urgent, clientMessageId, attachments?}`; `sendMessagesResponseSchema = {results}`)
- Test: `apps/server/src/routes/messages.test.ts` (DB: CI only)

- [ ] **Step 1: Failing tests:** two agent recipients → two rows, one per agent, `recipients` both; a human recipient → refused; attachments with two `to` → 422; one refused recipient with others sent → 202 with mixed results; `start_failed` per recipient keeps its row pending; retry with the same `clientMessageId` returns every row's result; 401 for agent tokens.
- [ ] **Step 2:** Implement over `router.send`. Commit `feat(server): humans send one message to several agents`.

### Task 3.6: Inbox `chats`

**Files:**
- Modify: `apps/server/src/agents/event-store.ts` (`inboxPage` excludes `kind='message'` items and returns `chats`; `toEntries`), `packages/shared/src/messaging.ts` (`chatRowSchema` per spec §6.7; `inboxPageSchema` gains `chats`), `apps/server/src/routes/inbox.ts`
- Test: `apps/server/src/routes/inbox.test.ts` (DB: CI only)

- [ ] **Step 1: Failing tests:** `chats` lists every agent with unread messages for you with `unread`, `latest` (plain-text preview ≤ 280 chars, markdown stripped by the existing preview helper), agent fields `{slug, displayName, template, avatarVersion, kind, status, archivedAt}`; `items` has no `message` kind; `?unread=true` includes `chats`; read-all with `upTo` marks chat items; undo restores them; `byAgent` unchanged.
- [ ] **Step 2:** Implement. Commit `feat(server): the inbox groups unread messages into chats`.

### Task 3.7: Web: agent layout route, Chat and Session routes, links, titles

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/routes/_app/agents.$slug.tsx` (layout with `<Outlet/>`; keeps the loader, details panel state)
- Create: `apps/web/src/routes/_app/agents.$slug.index.tsx` (`beforeLoad` → `redirect({to: "/agents/$slug/chat", params, replace: true})`), `agents.$slug.chat.tsx` (`?message=`), `agents.$slug.session.tsx` (`?event=`, `?message=`; renders `SessionView`)
- Modify: every link builder to an agent (grep `to: "/agents/$slug"` and `/agents/${`): `features/agents/sidebar-tree.tsx`, `features/agents/agent-tree.tsx`, `features/palette/command-palette.tsx`, `features/inbox/*`, `features/tasks/*`, `features/schedules/*`, `features/session/row-menu.tsx` ("Open in chat"), `features/session/live-line.tsx`; document titles in both routes ("Ada · Chat", "Ada · Session", status prefix kept)
- Test: `apps/web/src/routes/agents.routes.test.tsx` (create), existing link tests

- Route details (H3, H4, M2):
  - `validateSearch` (`event`, `message`) lives on the child routes; the `key` remount (`${slug}:${event}:${message}`) applies to the child views only, never the layout.
  - `useAgentSummary(slug)`: a narrow `select` over the agent cache that `enqueueStatusFrame` updates; the header reads only that.
  - Header notices (`restartError`, `pinOutcome`, `raceNotice`) are lifted to the layout and exposed to the children through a context of stable setters.
  - Scroll and pin per view: a module-level per-slug map (`features/agents/view-memory.ts`: `{chat?: {top, pinned}, session?: {top, pinned}}`) restored on mount; the Session's events refetch on return (accepted).
  - Chat child loader with `loaderDeps: ({search}) => ({message: search.message})`: on `preload`, `prefetchInfiniteQuery`; when the chat is cached, start a non-awaited fetch; await only when uncached. Keys `["chat", slug]` and `["chat", slug, "around", id]`.
- [ ] **Step 1: Failing tests:** `/agents/ada` redirects to `/agents/ada/chat` (replace); a sidebar row links to `/chat`; a session-event link goes to `/session?event=`; titles per view; the sidebar row is active on both children; the header does not re-render on a `?event=` change or a chat refetch (render count); a Chat → Session → Chat switch restores the chat's scroll and pin from the map.
- [ ] **Step 2:** Implement (the route tree `apps/web/src/routeTree.gen.ts` is checked in: regenerate it with `pnpm --filter @open-factory/web build` and commit it).
- [ ] **Step 3:** web tests; commit `feat(web): an agent opens as its chat; the session has its own route`.

### Task 3.8: Web: shared header with the view switch

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/agents/agent-header.tsx` (moved from `session-view.tsx` `SessionHeader` ~L433-520 and `SessionActions` ~L658), `apps/web/src/features/agents/view-switch.tsx`
- Modify: `apps/web/src/features/session/session-view.tsx` (uses it from the layout), `apps/web/src/features/agents/agent-menu.tsx` ("Open session"/"Open chat" item when crowded), `DESIGN.md` (amendments §9.1, §9.6, §9.10)
- Test: `apps/web/src/features/agents/agent-header.test.tsx`

- [ ] **Step 1: Failing tests:** in Chat the switch reads "Session" with `SquareTerminal`, in Session "Chat" with `MessageSquare`; its slot keeps one width for both labels; icon-only below 24rem with `aria-label`; with Restart visible below 22rem the switch moves to the top of ⋯ and Restart stays; the live line's "Open session" is hidden in the Session; the header does not remount across a switch (render count).
- [ ] **Step 2:** Implement. `agent-header.tsx` and `view-switch.tsx` never import `session-view.tsx` (shared pieces move to `features/agents/`). Commit `feat(web): one agent header with a chat/session switch`.

### Task 3.9: Web: chat data (query, union, live cursor)

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/chat/api.ts` (`chatQueryOptions(slug)` infinite; `postMessages`), `apps/web/src/features/chat/use-chat.ts` (frame subscription to `chat_changed` for the slug, coalesced refetch of the newest page: one in flight + one trailing; union by `clientMessageId ?? id` keeping cached entries; `liveAfter` cursor set on load and on non-frame refetches; `around` loading for `?message=`), `apps/web/src/features/chat/chat-state.ts` (pure merge and live-set functions)
- Test: `apps/web/src/features/chat/chat-state.test.ts`, `use-chat.test.tsx`

**Interfaces:**
- Produces: `useChat(slug, {messageId?}) → { entries: ChatEntry[]; working: ChatPage["working"]; live: ReadonlySet<string>; loadEarlier(); hasEarlier; status; error; retry() }`; entries keep identity across merges when unchanged.

- Fetching (H2, M1):
  - Frames, focus and reconnect fetch the **newest page only** and write it with `qc.setQueryData` through the chat union, which reuses the previous object for every unchanged key; the query sets `structuralSharing: false` (the union is the sharing).
  - `refetchOnWindowFocus: false`, `refetchOnReconnect: false`; our own newest-page refresh runs on window focus and on the ws `openCount` change.
  - `chat_changed` is routed in the global `onMessage` (`routes/_app.tsx`) to a module-level per-slug coalescer (one in flight + one trailing).
  - `select` is a module-level function (stable).
- [ ] **Step 1: Failing tests:** a 51st entry arriving leaves the other 50 entry objects `===` to before and renders exactly one row; union never drops cached entries (60 rows arriving between frames refetch until they meet the cache); an optimistic entry and its server row merge into one key; a pending→delivered change keeps the entry object's key; only frame-driven refetches add to `live`; a focus refetch adds nothing to `live`; two frames in flight make one trailing refetch.
- [ ] **Step 2:** Implement. Commit `feat(web): chat data that never flashes or drops rows`.

### Task 3.10: Web: Chat view rows and states

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/chat/chat-view.tsx`, `chat-row.tsx` (memoised: your card / agent prose), `also-to.tsx`, `chat-row-menu.tsx` (reuses `features/session/row-menu.tsx` pieces)
- Modify: `apps/web/src/routes/_app/agents.$slug.chat.tsx`, `DESIGN.md` (amendments §9.2, §9.5, §9.7)
- Test: `apps/web/src/features/chat/chat-view.test.tsx`, `apps/web/src/features/chat/chat-perf.test.tsx` (U1 `timeline-perf` pattern)

- [ ] **Step 1: Failing tests:** your message is a card with "You" and the clamp; the agent's reply is unboxed `.prose-of` and never clamped; "also to @dev and 8 others" with the full list in the row menu and accessible name; row menu items Copy text, Copy link (`/chat?message=`), View in session, Recipients; pending row "Waiting for Ada's current step" + Cancel → "Message cancelled. Undo"; rejected "This message wasn't delivered: …"; states (skeleton, "No messages with Ada yet.", "Couldn't load this chat." + Retry); `?message=` lands with the arrival tint on the card; read-only line for terminated/archived; stick-to-bottom and Jump to latest; Load earlier keeps the top row; live entries fade, loaded ones don't; one new entry renders one row.
- [ ] **Step 2:** Implement. `ChatRow` takes a `live` boolean (not the live Set) and one stable menu handler from the view; markdown memoised; `warmHighlighter()` on Chat mount. Commit `feat(web): the chat view`.

### Task 3.11: Web: working and outcome line

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/chat/turn-line.tsx` (one component for both, reusing `features/session/activity-line.tsx`'s anatomy and `Elapsed`)
- Modify: `apps/web/src/styles.css` (~L327-336: gate the `[data-activity-line]` fade on `[data-live]`), `apps/web/src/features/session/activity-line.tsx` (set `data-live` only when the line appears from a live frame)
- Test: `apps/web/src/features/chat/turn-line.test.tsx`

- [ ] **Step 1: Failing tests:** the working line is the thread's last row ("[tooth] 42s · Ada is working · Open session"), duration first and tabular; a tick re-renders only the duration (0 row renders); status frames never hide it; when the page brings the outcome for its `key`, the same node shows the outcome (same element, no fade attribute) and the link keeps its x; when the agent replied the line goes in the same commit as the reply; "Open session at 14:02" accessible names; names middle-truncate at 390px; the Session's activity line no longer fades on mount from load.
- [ ] **Step 2:** Implement. Placement (H1): the working line is a tail item of the chat's single entries array keyed `turn:${key}`, and the outcome entry has the same key, so React reuses the node. `data-live` is decided once at mount (a ref), never toggled after. Commit `feat(web): working and outcome lines that hand off in place`.

### Task 3.12: Web: Chat composer

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/chat/chat-composer.tsx`, `recipients.tsx` (the "To:" row and chips), `apps/web/src/features/chat/recipient-source.ts` (`@` source: live agents minus the chat's agent and added ones; rows "Add @dev as recipient"; menu note)
- Modify: `apps/web/src/lib/drafts.ts` (`of-draft:chat:<slug>` stores `{text, recipients, at}`), `apps/web/src/components/composer/composer.tsx` (a `recipients` slot above the text; Stop driven by a `stopVisible` prop)
- Test: `apps/web/src/features/chat/chat-composer.test.tsx`

- [ ] **Step 1: Failing tests:** no "To:" row with one recipient; accepting `@dev` opens "To: Ada [@dev ×]", removes the typed token, announces "Also sending to @dev", placeholder "Message Ada and 1 other"; Backspace in an empty box selects then removes the last chip ("Removed @dev"); max 10; recipients survive a remount from the draft; with two recipients the paperclip is `aria-disabled` and pressing it shows "Files go to one agent at a time"; `/context` shows "Commands run in the session · Open session" only for a known command or an unloaded list, and the link writes the text into `of-draft:session:ada`; Stop shows only while `working`; Esc stops that turn; ⌥Enter urgent; refused recipients each show "Not sent to @x: …" in the note slot; the chat's agent refused keeps the draft; toolbar `@` + attach, no `/`.
- [ ] **Step 2:** Implement:
  - POST `/api/messages`; the optimistic block is a tail item of the chat's entries keyed by `clientMessageId`, the key its server row takes (H1).
  - Recipients are data: `Composer` props `recipients: readonly Recipient[]` and a stable `onRecipientsChange`; the Composer renders the "To:" row (M3).
  - Drafts (M8): `chatDraftKey(slug)` under `of-draft:v1:`; recipients validated on read (`string[]`, ≤ 10, else dropped); the key is removed only when text and recipients are both empty; "Open session" writes `sessionDraftKey(slug)` in its click handler.
  - Commit `feat(web): the chat composer`.

### Task 3.13: Web: Inbox chat rows and list stability

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/inbox/chat-row.tsx`, `apps/web/src/features/inbox/use-held-list.ts` (applies removals, re-sorts and inserts only when pointer and focus are outside the list)
- Modify: `apps/web/src/features/inbox/inbox-list.tsx` (interleave by `latest.createdAt`; a chat older than the oldest loaded item waits; empty only with no chats and no items), `apps/web/src/features/inbox/api.ts`, `DESIGN.md` (amendments §9.8, §9.9)
- Test: `apps/web/src/features/inbox/inbox-list.test.tsx`, `use-held-list.test.ts`

- [ ] **Step 1: Failing tests:** chat row anatomy (AgentChip 16 with handle tooltip and `· ab12` for spawned, "· 3 new", Urgent, "archived"/"terminated", time; name truncates first); interleave order; a read row stays (read, no count) while the pointer or focus is in the list and leaves once both are out; a new message re-sorts only after both leave; j/k keeps the list held; a visible chat in the pane doesn't bump its count; below 1024px a click navigates to the Chat.
- [ ] **Step 2:** Implement `useHeldList` (M5): pointer and focus inside the list live in refs; only `held: boolean` is state; while held, order comes from a snapshot of keys taken when holding began and data from a live `Map` by key; no copying items into state in effects. `inbox-list` passes a minute-rounded number for "now", never a new `Date` per render. Commit `feat(web): unread chats as inbox rows that never move under you`.

### Task 3.14: Web: reading pane hosts the Chat; read rules

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/inbox/inbox-pane.tsx` (chat selection `chat:<slug>` resolved by slug; compact 40px strip with avatar, name, status, "Open chat", the view switch; delete the old message content ~L136-200 and `session-excerpt.tsx` if unused), `apps/web/src/routes/_app/inbox.tsx` (`?item=chat:<slug>`; a synthetic read row for the selected slug), `apps/web/src/features/session/use-read-from.ts` (a `delayMs` option for the pane; posts on mount and when a message newer than the last read arrives, never because its own messages turned unread)
- Test: `apps/web/src/features/inbox/inbox-pane.test.tsx`, `use-read-from.test.ts`

- [ ] **Step 1: Failing tests:** the pane shows the Chat thread and composer under the strip, no ⋯/`]`/Agent details; selecting keeps focus in the list; the composer takes focus only on Enter or `r`; retargeting swaps instantly, nothing fades; it opens at the first unread with a "New" divider when unread messages are taller than the pane; read after `INBOX_DWELL_MS`, cancelled when the selection moves; the Chat page reads at once; the Session view reads what it rendered; a reload with `?item=chat:ada` shows Ada's chat even with nothing unread; Undo of Mark all read sticks while the chat is open.
- [ ] **Step 2:** Implement (M6, M2): `useReadFrom` compares the newest agent-message time with a ref of the last `upTo` it posted and drops `hasUnread` from its deps; the dwell timer is an effect keyed on the selected slug with cleanup; the pane renders `key={slug}`; no `keepPreviousData` across slugs; a non-suspense `useInfiniteQuery`; `prefetchPane` prefetches the chat rows for a hovered/next chat row. Commit `feat(web): the inbox pane hosts the chat`.

### Task 3.15: Web: Mark all read with chats; notifications and recent senders

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/inbox/mark-all-read.tsx` (L38-45: `upTo` = newest of `items[0]` and `chats[].latest.createdAt`; optimistic zeroing of chat rows and `byAgent`; outcome "Marked 3 chats and 2 items as read."), `apps/web/src/features/inbox/notifications.ts` (L122: read `chats`; title "Ada · 3 new", tag `latest.messageId`, open `/agents/<slug>/chat?message=<id>`), `apps/web/src/features/mentions/mention-source.ts` (L35 recent senders from `chats`)
- Test: `mark-all-read.test.tsx`, `notifications.test.ts`

- [ ] **Step 1: Failing tests:** chats-only inbox: Mark all read marks them, Undo restores; the counts sentence; a notification for a new chat message opens its chat.
- [ ] **Step 2:** Implement. Commit `fix(web): mark all read and notifications cover chats`.

### Task 3.16: Sidebar and palette

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:** `apps/web/src/features/agents/sidebar-tree.tsx`, `apps/web/src/features/palette/command-palette.tsx`; tests beside them.

- [ ] **Step 1: Failing tests:** palette agent result opens `/chat`; on an agent page it offers "Open session" (in Chat) or "Open chat" (in Session). **Step 2:** Implement. Commit `feat(web): sidebar and palette open the chat`.

### Task 3.17: Product docs for PR 3 (main checkout)

- [ ] `behavior/agents-and-sessions.md`, `behavior/inbox.md`, `concepts/session.md`, ADR 0003's note, `ui-review/decisions.md` (#6 refined: the pane hosts the Chat), `architecture/data-model.md` (`turns.end_event_seq`, indexes). List them in the PR.

### Task 3.18: PR 3 review, verification, PR, CI

- [ ] Review against spec §6 and the React diff against `vercel-react-best-practices` (React checklist below); full local verification as in 1.15; push; `gh pr create --base i1/2-raw-session --title "feat: per-human chat as the default agent view, with chat rows in the inbox"` (Approach: chat from message rows plus turn stamps rather than a projection of the session stream because …; a per-user `chat_changed` frame rather than session subscriptions because …; held list changes rather than instant removal because …); CI until green; never merge.
- React checklist (copied from Task 5.1, the reviewer ticks each): stable references in live lists; memoised rows and markdown; no effects that derive state; query keys per data; no request waterfalls in route loaders; suspense/preload in loaders; handoffs (optimistic → server, queued → timeline, working → outcome) keyed in the **same parent array** so the node is reused; no new arrays, objects or elements passed as memo props; ws frames routed in one place (global `onMessage` or the per-agent session stream), never both.

---

# Part 4: `i1/4-send-command` (spec §7)

### Task 4.1: `send_command` tool

**Files:**
- Create: `apps/server/src/mcp/tools/send-command.ts`
- Modify: `apps/server/src/app.ts` (~L517 tool list: `sendCommandTool({…, spawned: caller.kind === "ephemeral"})` for every caller), `packages/shared/src/agents.ts` (`sendCommandToolSchema = {target: string, command: string}`)
- Test: `apps/server/src/mcp/tools/send-command.test.ts` (DB: CI only)

**Interfaces:**
- Consumes: `classifyInput`, `deniedReason` (2.1), `neutraliseEnvelopeTags` (2.4), `rt.rawInput` and `rt.compact` (2.5).
- Produces: result JSON `{target, status: "queued", note}`.

- [ ] **Step 1: Failing tests:** self via `"me"` and own handle; a direct report; a spawned report; a non-report → "@x isn't you or one of your direct reports."; a spawned caller targeting anyone else → refused (its description says "only yourself"); denied command → its reason; multi-line → "A command must be one line."; no leading `/` → "A command starts with /."; arguments neutralised; `/compact focus` → the Compact flow with `by: "@caller"`; notes for open turn / idle / hibernated (woken) / errored; self note texts exact (spec §7).
- [ ] **Step 2:** Implement. Nobody can cancel an agent's queued `send_command` entry in the UI: agents never cancel, and humans can't cancel another principal's input (the queue item shows no Cancel; `DELETE …/queue/:id` → 403 `not_sender`); a test covers it. Commit `feat(mcp): send_command for yourself and your direct reports`.

### Task 4.2: Self-compact continue notice; one pending self-command

**Files:**
- Modify: `apps/server/src/agents/notices.ts` (`NoticeType` gains `"compact_continue"`; texts), `apps/server/src/agents/agent-runtime.ts` (compact entry `self` flag; on the self compact's `turn_end`: `compact_failed` seen since write → failure text, else success; `addNotice("compact_continue", …)` and flush; nothing on exit mid-compact; one pending self entry per agent)
- Test: `apps/server/src/agents/agent-runtime.send-command.test.ts` (DB: CI only)

- [ ] **Step 1: Failing tests:** a self `/compact` sent mid-turn runs after the turn; on success the notice "Your /compact finished. Continue where you left off." is delivered and starts a turn; on failure "Your /compact didn't run (see the Session). Continue where you left off." (fixed text, no process output); exactly one notice (not two); none when the process exits mid-compact; none for a manager-initiated compact; a second self-command while one is pending → "You already have a command queued for yourself."
- [ ] **Step 2:** Implement. Commit `feat(server): an agent that compacts itself is told to continue`.

### Task 4.3: Product docs for PR 4 (main checkout)

- [ ] `architecture/factory-mcp.md`, `concepts/reporting-line.md`, `concepts/message.md` (`compact_continue`), `architecture/agent-runtime.md`. List them in the PR.

### Task 4.4: PR 4 review, verification, PR, CI

- [ ] Review against spec §7; full local verification; push; `gh pr create --base i1/3-chat-inbox --title "feat(mcp): send_command for agents"`; CI until green; never merge.

---

# Part 5: Whole stack

### Task 5.1: Whole-branch review

- [ ] Review `git diff spec/i1-chat-and-session...i1/4-send-command` against every spec section and acceptance criterion; list each AC with the task and test that covers it; check no compatibility code (ADR 0028), no `@humans` left, no leftover U3 allowlist or command-mode code; the reviewer checks the whole React diff against `vercel-react-best-practices` (stable references in live lists, memoised rows, no effects that derive state, query keys, no request waterfalls on the chat route, suspense/preload in the route loaders). Fix findings on the lowest branch they belong to and merge upward.

### Task 5.2: Full verification from a clean clone

- [ ] `git clone` the repo into `$TMPDIR/i1-verify`, `git switch i1/4-send-command`, then `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build` (the DB suites need CI; say which ran where) and the dev loop: `pnpm compose up -d` for Postgres if available, `pnpm dev`, open the app, sign up, create an agent from the fake (`FACTORY_CLAUDE_BIN` = the harness fake wrapper), confirm Chat opens and a message round-trips. Record results in the PR 4 body.

### Task 5.3: Real-browser evidence of every acceptance criterion

- [ ] Use `/Users/orlevi/projects/open-factory/docs/product/ui-review/u4-evidence/harness` through its `run.sh` lock (one pass at a time on this machine; fake Claude only, never real agents). Snapshot the built `i1/4-send-command` (`./snapshot.sh /Users/orlevi/projects/open-factory/.worktrees/spec-i1 $TMPDIR/u4-evidence-snapshot-i1`), write checks under `docs/product/ui-review/i1-evidence/checks/` (main checkout), one per AC in spec §2 (1-23), using `u4lib` variants (320, 390, 1024, 1440; light/dark; 200% text) in **Chromium and WebKit** headless (`U4_ENGINE=webkit`). Drive agents with `$mcp` (send_message, send_command) and raw directives. Record frame-by-frame (Playwright `page.video` or `requestAnimationFrame` screenshots at 16ms) the working→outcome swap and the raw Sending→row handoff, and assert no blank frame and one element. Results in `docs/product/ui-review/i1-evidence/results`, linked from the PR 3 and PR 4 bodies with the failed-count table.

### Task 5.4: Push and CI

- [ ] Merge any base movement upward (`origin/spec/i6-path-help` or `i6/path-help` into `spec/i1-chat-and-session`, then each i1 branch in order; merge, never rebase), push all four branches, and watch every PR's CI until green. Never merge a PR.
