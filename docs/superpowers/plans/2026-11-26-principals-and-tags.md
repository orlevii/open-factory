# Principals and Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every agent and human becomes a principal with a stable id and an 8-char ref. Handles become mutable labels. Stored text holds `<@ref>` tags rendered to the current handle on read. In the chat composer, `@` only tags.

**Architecture:**
- One `principals` table (id, kind, handle, ref) is the parent of `agents` and `users`. Every agent-or-human column pair collapses into one principal FK.
- Two pure modules in `packages/shared` own the formats: `ref.ts` (Crockford base32 refs) and `tags.ts` (scan, apply, render).
- The server resolves tags on every tag-holding write. Agents get `<@ref|handle>`, rendered at delivery.
- Durable keys (workdir, container, REST and web routes, event channels) move from the slug to the ref or the id.
- The web renders tags as chips from a principals cache that a `principal_updated` frame patches. Composers keep a textarea with atomic tag ranges.

**Tech Stack:** TypeScript pnpm monorepo, Fastify, Postgres + Drizzle (drizzle-kit 0.31), better-auth 1.7.25, Zod in `packages/shared`, micromark + mdast (`mdast-util-from-markdown`, GFM) for parsing, React + Vite + TanStack Router/Query, react-markdown 10 + remark-gfm, sonner, Radix, Vitest + Testing Library, Biome. **No new dependency.**

**Spec:** `docs/superpowers/specs/2026-11-26-principals-and-tags-design.md` (commit 89cf996b). It is the authority for behaviour and copy. Read the sections a task cites before starting it.

## Spec corrections found while mapping the code (apply them; Task 7.1 updates the spec text)

1. **Container names** are `open-factory-<slug>-<id8>` today (`runtime/docker/containers.ts:55`), not `of-agent-…`. They become `open-factory-<ref>`. AC14's `of-agent-<ref>` is read as `open-factory-<ref>`.
2. **Stored principal references that aren't free text also move to ids:**
   - `messages.recipients` (a text[] of `@handle`) becomes `recipient_ids text[]` of principal ids.
   - `messages.re[].from` (`@handle`) holds a tag, `<@ref>`, or the reserved `@scheduler` / `@factory`.
   - `skill_sources.added_by` (a text `@handle`) becomes `added_by_id` → principals.
   - Session-event payloads that carry `by` (`spawned`, control events) carry `<@ref>`.
3. **Server-written prose stores tags.** These bodies are built with `@slug` today and are stored in `messages.body`, so they'd go stale on a rename. They write `<@ref>` instead:
   - peer joined/left (`messaging/peer-body.ts`)
   - forwarded facts (`messaging/forwarder.ts`)
   - restart notices (`agents/notices.ts`)
   - the loop-guard notice (`messaging/loop-guard.ts:149`)
   - task message bodies (`tasks/bodies.ts` labels)

   `peerLeftOf` parses tags, not `@slug`.
4. **`inline()`** (`messaging/inline.ts`) strips `<` and `>`. It must keep `<@ref>` tags whole. **`attr()`** in `packages/harness/src/envelope.ts` escapes `<` and `>`; it writes exact tag substrings unescaped (spec §4.4).
5. **Event channels.** Per-agent bus channels are keyed by slug (`agents/event-bus.ts`). They become keyed by agent id, and WS client messages carry the agent's ref.
6. **Git identity in agent env** (`agents/runtime-spec.ts:48-49`): the name is the handle at start, the email is `<ref>@open-factory.local`.
7. **better-auth.**
   - The handle claim runs in request middleware, outside the user insert, and the drizzle adapter has transactions off. Sign-up creates the principal itself, before the user, under the existing `signUpMutex`, and deletes it if sign-up fails (Task 2.2).
   - `advanced.database.generateId` hands the user the principal's id.
   - The user's handle is not a better-auth field after Task 5.3.
8. **Surfaces the spec didn't list:**
   - The agent description is a plain `Textarea`, not `MarkdownEditor` (`edit-agent-sheet.tsx:432`, `new-agent-sheet.tsx:479`).
   - Both task title fields are `<Input>`.
   - Task comments render through `ClampedMarkdown` (`features/session/message-block.tsx:489`).
   - `to_all_humans` stays as it is (out of scope).

## Global Constraints

- **Pre-release (ADR 0028):** no backward compatibility, shims, aliases, fallbacks or data migration. Each schema task ships its generated migration (`pnpm db:generate`), plus the hand edits it names. **Reset local data**; the PR body says so.
- **Interim state inside the branch:** between Task 2.1 and Task 5.3, `agents.slug` and `users.handle` stay as plain columns, written equal to the principal's handle on every create path. Nothing renames before 5.3, so they never diverge. New code never adds a read of `agents.slug` or `users.handle`; it reads `principals.handle`. Task 5.3 deletes both columns. No compatibility survives the PR.
- **Formats (exact):**
  - ref = 8 chars of `0123456789abcdefghjkmnpqrstvwxyz`
  - stored tag `<@ref>`; agent tag `<@ref|handle>`
  - handle `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, 2–40 chars
  - reserved `humans, me, scheduler, factory, all, system, unknown`
- **Copy is verbatim from the spec:** §2.11, §4.5 (chip, menu notes, Add recipient, rename and profile copy, errors). Don't paraphrase.
- **Agent-facing strings (exact):**
  - unknown ref: ``<@REF> isn't anyone in this factory; list_peers shows each agent and human with their tag.``
  - plain tag: ``Plain tag detected: @NAME was resolved to <@REF|HANDLE>. Tag as <@ref|handle>.``
- **Tests:** AGENTS.md testing standards apply (behaviour, not implementation; no existence-only tests; mock only boundaries; a real Postgres via `makeTestApp` / `createTestDb`; name new DB-only files `*.db.test.ts`).
  - Implementers and reviewers run only the test files they created or changed (`pnpm vitest run <files>` or `pnpm test:related <sources>`), plus `pnpm typecheck` when an exported symbol changes.
  - The full `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm build` run once, in Task 7.2.
- **No browser or UI checks** (no dev server, no screenshots). The owner verifies the UI afterwards; Task 7.2 lists what to check.
- **No real Claude.** Tests use fake Claude (`makeTestApp` sets `FACTORY_CLAUDE_BIN`).
- **React tasks:** the implementer and reviewer invoke `vercel-react-best-practices` and follow it (React + Vite + TanStack; Next-only and RSC rules don't apply). UI tasks also follow DESIGN.md, `impeccable` and Emil Kowalski's skills (emil-design-eng, break-ui, apple-design).
- **I4 form rules:** `FormField` / `FieldNote`, `useFieldErrors`, `FORM_MSG` / `FIELD_MSG`; client messages at most 40 characters.
- **Implementer model:** each task names one. Haiku for narrow, well-specified edits; Sonnet for judgement. Fix rounds use the task's model. Reviewers use the dev's model; there is one reviewer per task plus a whole-branch review.
- **Commits:** one per task (more if a task says so), conventional style, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| Area | New | Main files changed |
|---|---|---|
| Shared | `packages/shared/src/ref.ts`, `tags.ts` (+ tests) | `handle.ts`, `names.ts` (deleted in 5.3), `mentions.ts` (deleted in 4.1), `agents.ts`, `messaging.ts`, `tasks.ts`, `schedules.ts`, `chat.ts`, `inbox.ts`, `usage.ts`, `users.ts`, `schemas.ts`, `actor.ts`, `ws.ts`, `org-tools.ts`, `package.json` exports |
| DB | `schema/principals.ts`, migrations 0029+ | `schema/agents.ts`, `auth.ts`, `tasks.ts`, `schedules.ts`, `library.ts`, `index.ts`; `handles.ts` deleted |
| Server identity | `apps/server/src/principals/principal-store.ts`, `principal-text.ts`, `principal-args.ts` | `messaging/principals.ts` (deleted), `auth/*`, `users/sign-up-gate.ts`, `agents/agent-service.ts`, `spawning/*`, `test/helpers.ts`, `test/handles.ts` (→ `test/principals.ts`), `agents/testing/rows.ts` |
| Server text and agents | — | `messaging/router.ts`, `forwarder.ts`, `peer-body.ts`, `inline.ts`, `neighborhood.ts`, `loop-guard.ts`; `agents/event-store.ts`, `chat-store.ts`, `agent-runtime.ts`, `notices.ts`, `start.ts`; `tasks/*`; `scheduling/*`; `mcp/tools/*`; `workspace/claude-md.ts`; `packages/harness/src/envelope.ts` |
| Server keys | — | `workspace/paths.ts`, `workspace.ts`, `runtime/docker/containers.ts`, `agents/runtime-spec.ts`, `agents/event-bus.ts`, `ws/route.ts`, `routes/*.ts`, `uploads/service.ts`, `usage/usage-service.ts` |
| Web | `features/principals/*`, `components/tag/*`, `components/composer/tag-ranges.ts`, `tag-highlighter.tsx`, `features/profile/*`, `features/chat/add-recipient.tsx` | `composer.tsx`, `caret-menu.tsx`, `mentions.ts`, `mention-source.ts`, `markdown.tsx`, `markdown-editor.tsx`, `chat-composer.tsx`, `recipients.tsx`, agents routes `$slug` → `$ref`, `agent-chip.tsx`, `agent-avatar.tsx`, `address-line.tsx`, `edit-agent-sheet.tsx`, `agent-form-state.ts`, `app-sidebar.tsx`, `sign-up.tsx`, `lib/session.ts`, `routes/_app.tsx` |
| Docs | `docs/product/decisions/0029-principals-and-tags.md` | ADR index, concepts, architecture, DESIGN.md, spec corrections |

---

## Part 1 — Shared primitives

### Task 1.1: Refs and the one handle rule

**Model:** Haiku. **Spec:** §4.1 Handles, §4.2.

**Files:**
- Create: `packages/shared/src/ref.ts`, `packages/shared/src/ref.test.ts`
- Modify: `packages/shared/src/handle.ts`, `packages/shared/src/handle.test.ts`, `packages/shared/src/index.ts` (export `ref.ts`), `apps/web/src/routes/sign-up.tsx` (input `maxLength={40}`)

**Interfaces — Produces:**
- `REF_ALPHABET: string`
- `REF_PATTERN: RegExp`
- `refOf(uuid: string): string`
- `normaliseRef(s: string): string | undefined`
- `handleSchema`: 2–40 chars, with `unknown` reserved
- `RESERVED_HANDLES` gains `"unknown"`

- [ ] **Step 1: Write failing tests** in `ref.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { normaliseRef, REF_PATTERN, refOf } from "./ref.ts";

test("a ref is 8 chars of the Crockford alphabet for any UUID", () => {
  for (let i = 0; i < 500; i++) expect(refOf(randomUUID())).toMatch(REF_PATTERN);
});

test("a ref is taken from the UUID's last 5 bytes", () => {
  expect(refOf("00000000-0000-4000-8000-000000000000")).toBe("00000000");
  expect(refOf("00000000-0000-4000-8000-00ffffffffff")).toBe("zzzzzzzz");
  expect(refOf("ffffffff-ffff-4fff-bfff-ff0000000001")).toBe("00000001");
});

test.each([
  ["K7X2M9QD", "k7x2m9qd"],
  ["k7x2m9qd", "k7x2m9qd"],
  ["iL0o0000", "11000000"],
])("normaliseRef(%s) maps case and i/l/o", (raw, want) => expect(normaliseRef(raw)).toBe(want));

test.each(["k7x2m9q", "k7x2m9qdd", "k7x2m9q-", "uuuuuuuu", ""])("%s is not a ref", (raw) =>
  expect(normaliseRef(raw)).toBeUndefined(),
);
```

  In `handle.test.ts`, replace the literal-list assertion (`expect(RESERVED_HANDLES).toEqual([...])` is an existence test) with behaviour:

```ts
test.each(["unknown", "factory", "me"])("%s is refused as a handle", (h) =>
  expect(handleSchema.safeParse(h).success).toBe(false));
test("a 40-char handle is accepted and a 41-char one refused", () => {
  expect(handleSchema.safeParse(`a${"b".repeat(39)}`).success).toBe(true);
  expect(handleSchema.safeParse(`a${"b".repeat(40)}`).success).toBe(false);
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/ref.test.ts packages/shared/src/handle.test.ts`. Expect FAIL (no `ref.ts`; 40 chars refused; `unknown` accepted).

- [ ] **Step 3: Implement** `ref.ts`:

```ts
/** Crockford base32, lowercase: no i, l, o, u, so a ref can't be misread (spec §4.2). */
export const REF_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const REF_PATTERN = /^[0-9a-hjkmnp-tv-z]{8}$/;

/** The principal's ref: the UUID's last 5 bytes (random in a v4 UUID) as 8 base32 chars. */
export function refOf(uuid: string): string {
  let n = BigInt(`0x${uuid.replaceAll("-", "").slice(-10)}`);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = REF_ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/** A typed or copied ref, normalised (case; i/l → 1; o → 0), or undefined when it isn't one. */
export function normaliseRef(s: string): string | undefined {
  const r = s.toLowerCase().replaceAll(/[il]/g, "1").replaceAll("o", "0");
  return REF_PATTERN.test(r) ? r : undefined;
}
```

  In `handle.ts`, add `"unknown"` to `RESERVED_HANDLES` (with the comment "how a dangling tag renders") and set `.max(40, MSG.handleLength)`. If `MSG.handleLength` names 32, update it to "Use 2 to 40 characters". In `sign-up.tsx:180`, set `maxLength={40}`.

- [ ] **Step 4: Run** the same tests. Expect PASS. Then run `pnpm test:related packages/shared/src/handle.ts`.
- [ ] **Step 5: Commit** `feat(shared): principal refs and one 2–40 handle rule`.

### Task 1.2: The `tags` module

**Model:** Sonnet. **Spec:** §4.3.

**Files:**
- Create: `packages/shared/src/tags.ts`, `packages/shared/src/tags.test.ts`
- Modify: `packages/shared/package.json` (export `"./tags": "./src/tags.ts"`; `./mentions` stays until Task 4.1)

**Interfaces — Consumes:** `normaliseRef`. **Produces:**

```ts
export type TagToken = { ref: string; start: number; end: number; raw: string; name: string }; // name = text after "<@" (lowercased), before "|" or ">"
export type PlainCandidate = { name: string; start: number; end: number };                     // "@name" or "<@name…>" whose name isn't a ref
export type TagScan = { tokens: TagToken[]; plain: PlainCandidate[] };
export type TagPrincipal = { ref: string; handle: string };
export type TagLookup = { byRef: ReadonlyMap<string, TagPrincipal>; byHandle: ReadonlyMap<string, TagPrincipal> };
export type TagWarning = { written: string; ref: string; handle: string };
export type AppliedTags = { text: string; refs: string[]; warnings: TagWarning[]; unknownRefs: string[] };
export function scanTags(text: string): TagScan;
export function applyTags(text: string, scan: TagScan, lookup: TagLookup, opts: { resolvePlain: boolean }): AppliedTags;
export function renderTags(text: string, lookup: (ref: string) => TagPrincipal | undefined, style: "agent" | "plain"): string;
export const tagOf: (ref: string) => string;          // "<@ref>"
export const agentTagOf: (p: TagPrincipal) => string; // "<@ref|handle>"
export const plainTagWarning: (w: TagWarning) => string;
export const unknownRefError: (ref: string) => string;
```

**Rules** (spec §4.3; the GFM table note is the reason for whole-source scanning):

- **Scan the whole source,** not per text node, because a `|` in a GFM table row splits cells. Parse once with `fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })` and collect **excluded ranges**:
  - every `code` and `inlineCode` node
  - every autolink or bare URL (a `link` whose single text child equals its `url` or `mailto:` + it), whole
  - for any other `link`, its source range minus its children's ranges, which drops the `(url)` part
- **Token regex:** `/<@([0-9A-Za-z][0-9A-Za-z-]*)(?:\|[^<>\n]*)?>/g`.
  - A match whose start is in an excluded range, or which is preceded by `\`, is skipped.
  - If `normaliseRef(name)` is defined, it's a `TagToken`. Otherwise, if `name` matches the handle pattern, it's a `PlainCandidate` covering the whole `<…>`.
- **Plain regex:** the existing `MENTION` (`/(?<![\p{L}\p{N}_/.@])@([a-z0-9][a-z0-9-]*)(?![\p{L}\p{N}_-])/gu`) over the source.
  - Skip matches in excluded ranges or inside a token's span.
  - Skip matches preceded by `\`.
  - Apply the boundary rule at slice start, as `extractMentions` does.
  - Trim trailing `-`.
- **`applyTags`** replaces spans from the end to the start:
  - **Token:**
    - ref known → `<@ref>`; ref pushed to `refs` (deduplicated, in order of first appearance).
    - ref unknown but `name` is a current handle → treated as plain (below).
    - otherwise → left as written, ref pushed to `unknownRefs`.
  - **Plain** (only with `resolvePlain`): an exact (lowercase) handle match → `<@ref>`, a warning, ref pushed. No match → left as text, no warning.
- **`renderTags`:**
  - Scans, and replaces tokens only, from the end.
  - `"agent"` → `<@ref|handle>`; `"plain"` → `@handle`.
  - An unknown ref gives `<@ref|unknown>` / `@unknown`.
  - Plain candidates are untouched.

- [ ] **Step 1: Write failing tests** in `tags.test.ts`. Port every case from `packages/shared/src/mentions.test.ts` as `scanTags(...).plain.map((p) => p.name)`, keeping their inputs and expectations, but with `@humans` now just a name. Add:

```ts
const P = (ref: string, handle: string) => ({ ref, handle });
const L = (...ps: { ref: string; handle: string }[]) => ({
  byRef: new Map(ps.map((p) => [p.ref, p])),
  byHandle: new Map(ps.map((p) => [p.handle, p])),
});
const cmo = P("k7x2m9qd", "cmo-agent");

test.each([
  ["`<@k7x2m9qd>`", []],
  ["```\n<@k7x2m9qd>\n```", []],
  ["\\<@k7x2m9qd>", []],
  ["[x](https://a.io/<@k7x2m9qd>)", []],
  ["| a | <@k7x2m9qd|cmo> |\n|---|---|", ["k7x2m9qd"]],
  ["hi <@K7X2M9QD|whatever>", ["k7x2m9qd"]],
])("scanTags tokens in %j", (src, refs) => expect(scanTags(src).tokens.map((t) => t.ref)).toEqual(refs));

test("applyTags strips labels and reports refs", () => {
  const src = "ask <@k7x2m9qd|old-name> now";
  expect(applyTags(src, scanTags(src), L(cmo), { resolvePlain: false })).toEqual({
    text: "ask <@k7x2m9qd> now", refs: ["k7x2m9qd"], warnings: [], unknownRefs: [],
  });
});

test("an unknown ref is reported and left as written", () => {
  const src = "ask <@zzzzzzzz>";
  const r = applyTags(src, scanTags(src), L(cmo), { resolvePlain: true });
  expect(r.unknownRefs).toEqual(["zzzzzzzz"]);
  expect(r.text).toBe(src);
});

test("a plain @handle resolves only with resolvePlain, with a warning", () => {
  const src = "I told @cmo-agent and @nobody";
  expect(applyTags(src, scanTags(src), L(cmo), { resolvePlain: false }).text).toBe(src);
  const r = applyTags(src, scanTags(src), L(cmo), { resolvePlain: true });
  expect(r.text).toBe("I told <@k7x2m9qd> and @nobody");
  expect(r.warnings).toEqual([{ written: "@cmo-agent", ref: "k7x2m9qd", handle: "cmo-agent" }]);
});

test("<@handle> written instead of a ref resolves as a plain tag", () => {
  const src = "see <@cmo-agent>";
  expect(applyTags(src, scanTags(src), L(cmo), { resolvePlain: true }).text).toBe("see <@k7x2m9qd>");
});

test.each([
  ["agent", "hi <@k7x2m9qd> and <@zzzzzzzz>", "hi <@k7x2m9qd|cmo-agent> and <@zzzzzzzz|unknown>"],
  ["plain", "hi <@k7x2m9qd> and <@zzzzzzzz>", "hi @cmo-agent and @unknown"],
  ["plain", "`<@k7x2m9qd>` stays", "`<@k7x2m9qd>` stays"],
] as const)("renderTags %s", (style, src, want) =>
  expect(renderTags(src, (r) => L(cmo).byRef.get(r), style)).toBe(want));

test("the agent-facing strings", () => {
  expect(unknownRefError("zzzzzzzz")).toBe(
    "<@zzzzzzzz> isn't anyone in this factory; list_peers shows each agent and human with their tag.");
  expect(plainTagWarning({ written: "@cmo-agent", ref: "k7x2m9qd", handle: "cmo-agent" })).toBe(
    "Plain tag detected: @cmo-agent was resolved to <@k7x2m9qd|cmo-agent>. Tag as <@ref|handle>.");
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/tags.test.ts`. Expect FAIL (no module).
- [ ] **Step 3: Implement** `tags.ts` per the rules above. Reuse the micromark imports and the `Node` type from `mentions.ts`. Hoist the regexes to module scope (`js-hoist-regexp`). Precompute excluded ranges as a sorted array and test membership with a binary search.
- [ ] **Step 4: Run** the test file. Expect PASS. Break one rule once (for example, drop the backslash check) and see the escape test fail.
- [ ] **Step 5: Commit** `feat(shared): tag scan, apply and render`.

---

## Part 2 — Principals

### Task 2.1: The `principals` table, the principal store, and agent creation

**Model:** Sonnet. **Spec:** §4.1, AC1, AC3.

**Files:**
- Create:
  - `packages/db/src/schema/principals.ts`
  - `apps/server/src/principals/principal-store.ts`
  - `apps/server/src/principals/principal-store.db.test.ts`
  - `apps/server/src/test/principals.ts` (replaces `test/handles.ts`)
- Modify:
  - `packages/db/src/schema/{index,agents,auth}.ts`; delete `schema/handles.ts` and `schema/handles.test.ts`
  - `apps/server/src/messaging/principals.ts` (delete `claimHandle`, `handleKind`)
  - `agents/agent-service.ts` (`createLocked`, `resolveManager` pre-read)
  - `spawning/spawn-service.ts`
  - `db-errors.ts` (`isSlugUnique` → `isHandleTaken`)
  - `test/helpers.ts` (`seedTestAgent`)
  - `agents/testing/rows.ts` (`insertAgent`)
  - `agents/testing/runtime-harness.ts`
  - every test calling `claimTestHandle` / `claimTestHandleSql` / `seedTestUser` / `testManagerUserId`
  - the `packages/db` schema tests that insert `handles`
- Migration: `packages/db/migrations/0029_*.sql` (generated)

**Interfaces — Produces:**

```ts
// packages/db/src/schema/principals.ts
export const principals = pgTable("principals", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull().$type<"agent" | "human">(),
  handle: text("handle").notNull(),
  ref: text("ref").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("principals_handle_unique").on(t.handle),
  uniqueIndex("principals_ref_unique").on(t.ref),
  check("principals_kind", sql`${t.kind} IN ('agent','human')`),
]);

// apps/server/src/principals/principal-store.ts
export type PrincipalKind = "agent" | "human";
export type Principal = { id: string; ref: string; kind: PrincipalKind; handle: string };
export class HandleTakenError extends Error {}
/** Inserts a principal (UUID id, ref = refOf(id)); a ref collision retries with a new UUID up to 5 times. */
export async function createPrincipal(tx: Tx, kind: PrincipalKind, handle: string, newId: () => string = randomUUID): Promise<Principal>;
export async function principalById(tx: Tx, id: string): Promise<Principal | undefined>;
export async function principalsByIds(tx: Tx, ids: readonly string[]): Promise<Map<string, Principal>>;
export async function principalsByRefs(tx: Tx, refs: readonly string[]): Promise<Map<string, Principal>>;
export async function principalsByHandles(tx: Tx, handles: readonly string[]): Promise<Map<string, Principal>>;
export const isHandleTaken: (e: unknown) => boolean; // 23505 on principals_handle_unique
```

(`Tx` is the type `db.transaction` callbacks get, as in `messaging/principals.ts`.)

**Schema details:**
- `agents.id` and `users.id` get `.references(() => principals.id)`.
- `agents.slug` loses its FK to `handles` but stays `notNull().unique()` until 5.3.
- `users.handle` loses its FK and `users_handle_unique` stays until 5.3.
- Hand-edit the migration so `DROP TABLE "handles"` runs after the FK drops.
- Generated migrations are applied to empty databases (reset), so no ordering for data is needed.

**Create path:**
- `createLocked` and spawn call `createPrincipal(tx, "agent", slug)` inside their existing transaction, *before* `insert(agents)`, and use `p.id` as the agent id. This moves `randomUUID()` from after materialize into the transaction.
- The workdir is still `materialize(slug, …)` until Task 5.1.
- The `handleKind` pre-reads become `principalsByHandles(db, [slug])`, keeping the same "taken" answers.
- `isSlugUnique` call sites catch `HandleTakenError` / `isHandleTaken`.

- [ ] **Step 1: Write failing tests** in `principal-store.db.test.ts` (use `createTestDb`):
  - "two principals can't share a handle": the second `createPrincipal` with `handle "dev"` throws `HandleTakenError`.
  - "a principal's ref is derived from its id and unique": insert a principal row by hand with ref `"00000001"`, then call `createPrincipal` with an injected id source that returns a colliding UUID first and a fresh one second (add an optional `newId = randomUUID` parameter). It succeeds with the second id's ref.
  - "an agent can't exist without its principal": a raw `insert into agents (id, …)` with an id not in `principals` fails with 23503.
  - "a user can't exist without its principal": the same for `users`.

  In `apps/server/src/agents/agent-service.test.ts`, add "creating an agent creates its principal with the agent's id and handle": create via `AgentService.create`, then `principalById(db, agent.id)` → `{ kind: "agent", handle: "dev" }`.
- [ ] **Step 2: Run** them. Expect FAIL.
- [ ] **Step 3: Implement** the schema, run `pnpm db:generate`, and hand-edit the migration (drop order, a `-- principals replace handles` comment). Then write `principal-store.ts`, the create paths, and the test helpers:
  - `test/principals.ts` exports `seedTestPrincipal(sql|db, kind, handle, id?)`, `seedTestUser(...)` (inserts principal + user with the same id; `handle` is still written to `users.handle`) and `testManagerUserId(...)`, with the same signatures as `test/handles.ts`.
  - Update every importer. `insertAgent` in `agents/testing/rows.ts` inserts the principal first.
  - Raw `insert into agents` / `insert into users` in the 13 + 37 test files insert into `principals` first. Add a `principalSql(id, kind, handle)` helper in `test/principals.ts` and use it.
- [ ] **Step 4: Run** the new tests, `pnpm test:related apps/server/src/agents/agent-service.ts apps/server/src/spawning/spawn-service.ts`, and the `packages/db` schema tests. Expect PASS.
- [ ] **Step 5: Commit** `feat(db): principals table replaces handles`.

### Task 2.2: Users get UUIDs and a principal at sign-up; `/api/me` carries ref and handle

**Model:** Sonnet. **Spec:** §4.1 Users, AC2. Spec correction 7.

**Files:**
- Modify:
  - `apps/server/src/users/sign-up-gate.ts`
  - `apps/server/src/auth/options.ts`
  - `apps/server/src/auth/auth.ts`
  - `apps/server/src/auth/require-user.ts`
  - `packages/shared/src/schemas.ts` (`meSchema` adds `ref`)
  - `apps/server/src/routes/me.ts`
  - `apps/server/src/test/helpers.ts` (`signUp`)
- Test: `apps/server/src/routes/auth.test.ts` (or the existing sign-up test file; find it with `grep -rl "sign-up/email" apps/server/src/**/*.test.ts`)

**Interfaces — Produces:**
- `RequestUser = { id; email; name; handle; ref }`. `getUser` reads `handle` and `ref` from `principals` by the session user's id: one primary-key query.
- `meSchema = { id, ref, email, name, handle }`.

**Behaviour:**
- **`handleSignUp`** (under `signUpMutex`):
  1. Read and validate `handle` from the body with `handleSchema`. If invalid, return 400 with the field error, as better-auth's validator did.
  2. `const p = await createPrincipal(db, "human", handle)`. `HandleTakenError` → 422 `HANDLE_TAKEN` with `MSG.handleTaken`.
  3. Run the handler inside `signUpContext.run({ allowed: true, userId: p.id })`.
  4. **If the handler's response isn't 2xx, delete the principal** (`DELETE FROM principals WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE id = $1)`).
- **`authOptions`:**
  - `advanced: { database: { generateId: ({ model }) => (model === "user" ? signUpContext.getStore()?.userId : undefined) ?? randomUUID() } }`.
  - The `handle` additional field becomes `{ type: "string", required: false, input: false }`. The gate writes it: pass `handle` into the body it forwards via the context, and set it in `databaseHooks.user.create.before` by returning `{ data: { ...user, handle } }` from the context. Keep the invite backstop.
  - The `hooks.before` claim branch is deleted.
  - `/update-user` with a `handle` in the body → 400 `{ code: "handle_not_here", message: "Change your handle in Edit profile." }`. Task 5.4 adds the profile route.
- **`claim`** is removed from `AuthOptionParams`.

- [ ] **Step 1: Write failing tests** (route tests via `makeTestApp`):
  - "sign-up creates a user and its principal with one UUID id": sign up `handle: "alice"`. Then `users.id` matches the UUID pattern, and `principals` has `{ id: users.id, kind: "human", handle: "alice" }`.
  - "sign-up with a taken handle is refused with 422 and creates nothing": seed an agent `alice`, sign up as `alice` → 422 `HANDLE_TAKEN`; `users` count unchanged.
  - "a failed sign-up leaves no principal behind": sign up twice with the same email and different handles → the second fails, and no principal with the second handle exists.
  - "GET /api/me returns the user's ref and handle": `ref === refOf(id)`.
  - "update-user can't change a handle": POST `/api/auth/update-user` `{ handle: "x" }` → 400 `handle_not_here`.
- [ ] **Step 2: Run** them. Expect FAIL.
- [ ] **Step 3: Implement** the changes. `test/helpers.ts signUp` keeps working (it posts through the real route).
- [ ] **Step 4: Run** the tests and `pnpm test:related apps/server/src/users/sign-up-gate.ts apps/server/src/auth/options.ts apps/server/src/auth/require-user.ts`. Expect PASS.
- [ ] **Step 5: Commit** `feat(server): users get UUIDs and a principal at sign-up`.

### Task 2.3: One resolver for principal arguments (tag, ref or handle)

**Model:** Sonnet. **Spec:** §4.4 Principal arguments, AC10, AC11.

**Files:**
- Create: `apps/server/src/principals/principal-args.ts`, `apps/server/src/principals/principal-args.db.test.ts`
- Modify:
  - `messaging/principals.ts`: delete `resolveName`; keep `HUMANS_*` and move them into `principal-args.ts`, then delete the file
  - `messaging/router.ts` (`resolveTargets`)
  - `tasks/task-service.ts` (`resolveAssignee`, `resolveLinks`)
  - `tasks/task-reads.ts` (`agentId`, `creator`)
  - `scheduling/schedule-service.ts` (`resolveTarget`)
  - `agents/agent-service.ts` (`resolveManager`)
  - `mcp/tools/restart-agent.ts`, `send-command.ts`, `org-tools.ts` (`bare()` uses)
  - `spawning/terminate-service.ts`
  - `packages/shared/src/agents.ts` (`sendMessageToolSchema.to`, `sendCommandToolSchema.target`, `terminateAgentToolSchema`: rename `slug` → `target`, max 80)
  - `org-tools.ts` (`slugRef` → `principalRef`: `z.string().trim().min(1).max(80).describe("An agent or person: their tag <@ref|handle>, ref, or @handle")`)
  - `tasks.ts` tool schemas' descriptions

**Interfaces — Produces:**

```ts
export type ArgResolution =
  | { kind: "principal"; p: Principal; warning?: string } // warning = plainTagWarning(...) when written as a handle
  | { kind: "reserved"; name: string }
  | { kind: "channel"; name: string }
  | { kind: "unknown_ref"; ref: string }                  // message = unknownRefError(ref)
  | { kind: "none"; name: string };
/** One batched lookup for many raw args. Accepts <@ref|…>, <@ref>, a bare ref, @handle or handle. */
export async function resolveArgs(tx: Tx, raws: readonly string[]): Promise<ArgResolution[]>;
export const resolveArg: (tx: Tx, raw: string) => Promise<ArgResolution>;
```

**Resolution order** for one raw (trimmed):
1. Starts with `#` → channel.
2. A full tag `<@x…>` → `normaliseRef(x)`. A known ref → principal. An unknown ref → if `x` is a current handle, principal + warning; else `unknown_ref`.
3. `normaliseRef(raw)` defined and known → principal, no warning.
4. Strip one leading `@`; a reserved word → reserved.
5. A handle match → principal + warning (`written` = the raw as given, prefixed with `@` if it had none).
6. Otherwise → none.

**Callers:**
- They keep their existing refusal sentences for reserved, none, archived and the rest.
- They add `unknown_ref` → `unknownRefError(ref)`.
- They carry `warning` into their results:
  - `send_message` and `send_command`: a top-level `warnings: string[]` in the tool result (deduplicated)
  - task tools and `schedule_message`: `warnings`
  - REST callers: ignore warnings
- **REST (human) callers never get plain-handle resolution with a warning.** The REST `to` and `reportsTo` take refs from the web (Task 5.2). Until then, a REST handle still resolves.

- [ ] **Step 1: Write failing tests** (`principal-args.db.test.ts`, with seeded principals `dev`/`k…` and `or`), using `test.each` over raws:
  - `<@REF|old>` → the principal, no warning
  - `REF` uppercased → the principal
  - `@dev` / `dev` → the principal + the exact warning
  - `<@zzzzzzzz>` → `unknown_ref`
  - `#ops` → channel; `@me` → reserved; `ghost` → none

  Plus one tool-level test in `apps/server/src/mcp/tools/send-message.test.ts`: "send_message to a plain handle delivers and warns", where `to: ["dev"]` → result `warnings[0]` equals the plain-tag sentence and the recipient is queued.
- [ ] **Step 2: Run** them. Expect FAIL.
- [ ] **Step 3: Implement**, replacing every `resolveName` / `agentBySlug(strip(@))` call listed above. The `bare()` helper in `org-tools.ts` is deleted.
- [ ] **Step 4: Run** the new tests and `pnpm test:related` over the modified sources. Update existing tests whose args say `slug:` to say `target:`. Expect PASS.
- [ ] **Step 5: Commit** `feat(server): principal arguments accept a tag, a ref or a handle`.

---

## Part 3 — Collapse agent-or-human pairs

Each task ships its own migration, rewrites the hand-written checks it touches, and updates every reader and writer in its domain. Translate CHECK clauses mechanically:

| Old clause | New clause |
|---|---|
| `num_nonnulls(x_user_id, x_agent_id) = 1`, `x_agent_id IS NOT NULL` | `x_id IS NOT NULL` |
| both `IS NULL` | `x_id IS NULL` |
| `num_nonnulls(...) <= 1` | (dropped) |
| `to_agent_id IS NOT NULL OR to_user_id IS NOT NULL` | `to_id IS NOT NULL` |
| `to_user_id IS NULL` alone | (dropped) |

Agent-only or human-only kinds are enforced in app code, as today.

### Task 3.1: `agents.reports_to`, `agents.terminated_by`, `skill_sources.added_by`

**Model:** Sonnet. **Spec:** §4.1 table.

**Files:**
- Modify: `packages/db/src/schema/agents.ts`, `packages/db/src/schema/library.ts`, `agents/agent-service.ts` (`reportsToOf`, `terminationFields`, `resolveManager`, `createLocked`), `agents/event-store.ts` (`terminateRows`, reads at 479-486), `spawning/terminate-service.ts`, `spawning/reaper.ts`, `routes/agents.ts` (terminate), `messaging/neighborhood.ts` (peers: `reportsTo = same`), `agents/start.ts` (manager read), `library/sources-service.ts`, `routes/library.ts`, `agents/testing/rows.ts`, `packages/shared/src/agents.ts` (`reportsToSchema` → `{ kind: "agent" | "human", ref, handle }`; `terminatedBy` → `{ ref, handle } | null`), plus their tests.

**Schema:**
- `reports_to` → `principals.id`, on delete restrict. `reports_to_user` is dropped.
- CHECK `agents_manager`: `(kind = 'ephemeral' AND reports_to IS NOT NULL) OR (kind = 'persistent' AND reports_to IS NOT NULL)`, which simplifies to `reports_to IS NOT NULL`. Keep the constraint name.
- `terminated_by` → `principals.id`, null = the factory. CHECK `agents_terminated_ephemeral` keeps its shape with the new type.
- `skill_sources.added_by` (text) → `added_by_id` → `principals.id`, not null.

- [ ] **Step 1: Write failing tests:**
  - "a persistent agent must have a manager" (db): an insert with `reports_to` null fails on `agents_manager`.
  - "a human-managed agent reports its manager as a human" (`agent-service.test.ts`): `summary().reportsTo` = `{ kind: "human", ref, handle: "or" }`.
  - "terminating from the UI records the human" (`routes/agents.test.ts`): POST terminate → `terminatedBy` = the signed-in user's `{ ref, handle }`. The idle TTL → `terminatedBy: null`.
- [ ] **Step 2: Run** them. Expect FAIL.
- [ ] **Step 3: Implement.** `peerBody`'s `terminatedBy()` reads a principal or null (`null` → the TTL wording). Its tag form comes in Task 4.2. Keep `@handle` text there for now.
- [ ] **Step 4: Run** them, plus `pnpm test:related` on the modified sources. Expect PASS.
- [ ] **Step 5: Commit** `refactor: agents report to and are terminated by a principal`.

### Task 3.2: `messages`: `from_id`, `to_id`, `author_id`, `recipient_ids`

**Model:** Sonnet. **Spec:** §4.1 table; spec corrections 2.

**Files:**
- Modify:
  - `packages/db/src/schema/agents.ts` (`messages`)
  - `agents/event-store.ts`: `createMessage`, `createClientMessage`, `createHumanMessage`, `createTaskMessage`, `joined`, `PendingRow`, `messageLookup`, the inbox mapping around 1450-1546, `unreadChats`, `unreadByAgent`, `markReadFrom`
  - `agents/chat-store.ts`
  - `agents/agent-runtime.ts` (`entryOf`, `toBatchRow`, `requestsOf`)
  - `messaging/router.ts`
  - `messaging/loop-guard.ts`, `messaging/loop-resume.ts`
  - `scheduling/schedule-store.ts` (the firing row's author)
  - `spawning/spawn-service.ts` (brief row)
  - `tasks/task-service.ts` (`write`)
  - `packages/shared/src/chat.ts` (`chatEntrySchema.from` → `{ ref, handle, kind }`, `recipients` → `{ ref, handle }[]`)
  - `packages/shared/src/messaging.ts` (`requestRefSchema.from` holds a stored tag or reserved word, documented)
  - their tests

**Schema:**
- `from_user_id` + `from_agent_id` → `from_id`, a principal FK (null = factory/system/scheduled).
- `to_agent_id` + `to_user_id` → `to_id`, a principal FK (on delete cascade, as `to_agent_id` had).
- `author_agent_id` + `author_user_id` → `author_id`.
- `recipients text[]` → `recipient_ids text[]` (principal ids). The `messages_recipients` check is renamed accordingly.
- Indexes:

  | Old | New |
  |---|---|
  | `messages_to_agent_state_idx` | `messages_to_state_idx (to_id, state, created_at)` |
  | `messages_from_agent_idx` | `messages_from_idx (from_id, created_at)` |
  | `messages_schedule_pending_idx` | `(schedule_id, to_id)` |
  | `messages_client_id_unique` | `(from_id, client_message_id, to_id)` |
  | `messages_chat_in_idx` | `(to_id, from_id, created_at) WHERE kind = 'message'` |
  | `messages_chat_out_idx` | (dropped: the same index covers both directions once ids are shared) |

- Hand-written `messages_sender_kind_check` and `messages_recipient_check` (`num_nonnulls(to_id, nullif(to_all_humans, false)) = 1`) are re-issued with the translation table above. The `--` comment is "principals: one sender/recipient/author column".

**Code:**
- Wherever code branched on "agent column vs user column", it reads one column and joins `principals` for `kind`, `handle` and `ref`.
- **The agent inbox queue query** becomes `to_id = agentId`; **the human inbox** becomes `to_id = userId`.
- **Envelope `from`** is still produced as `@handle` text in this task. Task 4.3 moves it to tags.
- **`re[].from`** stores `tagOf(sender.ref)` for principals, or the reserved `@scheduler` / `@factory`.

- [ ] **Step 1: Write failing tests:**
  - "a message reaches only its to_id" (`router.test.ts`): send to two agents → two rows, each with its own `to_id`, both with `recipient_ids` = both ids.
  - "the chat thread lists both directions" (`chat-store` test): a human→agent row and an agent→human row both appear, newest first.
  - "a member update's re stores the sender's tag" (`agent-runtime` forwarding test): `re[0].from` = `<@ref>` of the human who asked.
  - DB: "a message row with neither sender nor notice is refused" (kind `message` with `from_id` null → check violation).
- [ ] **Step 2: Run** them. Expect FAIL.
- [ ] **Step 3: Implement.** This is the largest server task. Work file by file in the order listed, running `pnpm typecheck` (server) as the guide.
- [ ] **Step 4: Run** the tests, plus `pnpm test:related` on every modified source. Expect PASS.
- [ ] **Step 5: Commit** `refactor: messages have one sender, recipient and author principal`.

### Task 3.3: `tasks`, `task_comments`, `task_events`

**Model:** Sonnet. **Spec:** §4.1 table.

**Files:** `packages/db/src/schema/tasks.ts`, `tasks/task-store.ts`, `task-reads.ts` (`PrincipalRef`, aliases `aa/ca/ea`), `task-service.ts` (`labelOf`, `notify` label map), `tasks/permission.ts` (`Actor` → `{ kind: "agent" | "human", id, ref, handle }`), `routes/tasks.ts`, `mcp/tools/task-tools.ts` (`principal()`), `packages/shared/src/tasks.ts` (`taskPrincipalSchema` → `{ kind, ref, handle }`), tests.

**Schema:**
- `created_by_agent_id` + `created_by_user_id` → `created_by_id`.
- `author_agent_id` + `author_user_id` → `author_id`.
- `actor_agent_id` + `actor_user_id` → `actor_id`.
- CHECKs `tasks_creator_check`, `task_comments_author_check` and `task_events_actor_check` become `x_id IS NOT NULL`. That's covered by `notNull()`, so drop the checks and make the columns `notNull()`.
- Indexes `tasks_created_by_{agent,user}_idx` → `tasks_created_by_idx (created_by_id)`.

- [ ] **Step 1: Write failing tests** (`routes/tasks.test.ts`, `task-tools.test.ts`):
  - "a task created by a human lists its creator as that human": `createdBy` = `{ kind: "human", ref, handle }`.
  - "list_tasks filters by creator given as a tag": `created_by: "<@REF|x>"` returns that creator's tasks.
- [ ] **Step 2: Run** them. Expect FAIL. **Step 3: Implement.** **Step 4: Run** the tests and the related tests; expect PASS.
- [ ] **Step 5: Commit** `refactor: tasks, comments and events have one principal column`.

### Task 3.4: `schedules`

**Model:** Haiku. **Spec:** §4.1 table.

**Files:** `packages/db/src/schema/schedules.ts`, `scheduling/schedule-store.ts` (aliases `cu/bu/ca/ba`, raw `select id, slug` at 100), `schedule-service.ts` (`label`, `toItem`, `listForAgent`), `schedule-store.ts:327` (firing row `author_id`), `scheduling/schedule-store.ts` `Actor` → `{ id }`, `packages/shared/src/schedules.ts` (`createdBy` and `bodyAuthor` → `{ kind, ref, handle }`), tests.

**Schema:**
- `created_by_*` → `created_by_id` (not null).
- `body_author_*` → `body_author_id` (not null).
- Drop `schedules_creator_check` and `schedules_author_check`.
- `schedules_creator_idx` → `(created_by_id) WHERE deleted_at IS NULL`.

- [ ] **Step 1: Write failing test** (`schedule-service` db test): "editing a schedule body records the editor as its body author", where a human edit → `bodyAuthor` = `{ kind: "human", ref, handle }`.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS), and run the related tests.
- [ ] **Step 5: Commit** `refactor: schedules have one creator and body-author principal`.

---

## Part 4 — Tags in text

### Task 4.1: Every tag-holding write resolves tags; comment tags reach

**Model:** Sonnet. **Spec:** §4.3 write paths and "What a tag does"; AC5, AC11, AC12, AC13.

**Files:**
- Create: `apps/server/src/principals/principal-text.ts`, `principal-text.db.test.ts`
- Modify:
  - `messaging/router.ts` (body; also `restart_agent`'s note goes through `send`)
  - `spawning/spawn-service.ts` (brief and description)
  - `agents/agent-service.ts` (`createLocked`, `planUpdate`: description)
  - `tasks/task-service.ts` (`procedure` title and body; `commentProcedure`)
  - `scheduling/schedule-service.ts` (`create` and `edit` body)
  - `routes/messages.ts`, `routes/tasks.ts`, `routes/schedules.ts`, `routes/agents.ts` (400 field errors)
  - `mcp/tools/*` that write those fields (errors and warnings)
  - delete `packages/shared/src/mentions.ts` and its test, plus the `./mentions` export

**Interfaces — Produces:**

```ts
export class UnknownTagsError extends Error { constructor(readonly refs: string[]) { super(refs.map(unknownRefError).join("\n")); } }
/** scan → one batched principals query (token refs, plus plain names and token names as handles) → apply. `agent` resolves plain @handles; warnings are `plainTagWarning` strings. */
export async function resolveText(tx: Tx, text: string, writer: "agent" | "human"): Promise<{ text: string; refs: string[]; warnings: string[] }>;
/** For rendering: one query for every ref in the texts. */
export async function tagLookupFor(tx: Tx, texts: readonly string[]): Promise<(ref: string) => TagPrincipal | undefined>;
```

**Rules:**
- **Agents:** an `UnknownTagsError` is a tool error, and nothing is written; the message is the joined `unknownRefError`s. Warnings are added to the tool result as `warnings` (merged with Task 2.3's).
- **Humans:** an `UnknownTagsError` → 400 `{ error: { code: "unknown_tag", fields: { <field>: "Tag isn't anyone here" } } }`. The field is `body`, `title`, `description` or `text` (comment). A human's plain `@name` is left as text.
- **Task comments:**
  - `commentProcedure` takes `refs` from `resolveText` instead of `extractMentions` names. Each ref is looked up as a principal; agents and humans are split by `kind`. Unknown refs can't reach here.
  - `MAX_MENTIONS` (50) caps refs. `notReached` keeps `too_many`, `archived` and `terminated`; drop `unknown` and `reserved`, which can't happen now.
  - `CommentResult.mentionedHumans` → `{ ref, handle }[]`; the tool maps them to `<@ref|handle>`.
- Messages, schedules and descriptions: tags notify nobody (no new code; assert it).

- [ ] **Step 1: Write failing tests:**
  - `principal-text.db.test.ts`: "an agent's plain @handle is stored as a tag with a warning"; "an unknown ref throws UnknownTagsError naming it"; "a human's plain @handle stays text".
  - `send-message.test.ts`: "send_message with an unknown tag is refused and nothing is sent" (no message row).
  - `routes/messages.test.ts`: "a message with a tag reaches only its recipients", where human → agent A with `<@B>` in the body gives exactly one row, `to_id` = A, and B's queue empty; "a body with an unknown ref is 400 and writes nothing".
  - `routes/tasks.test.ts`: "a comment's tag reaches the tagged agent" (a `task_comment` row to the tagged agent); "a task title with a tag is stored as <@ref>".
  - `task-tools.test.ts`: "comment_task reports a tagged human as reached"; `mentioned_humans` = [`<@ref|or>`].
- [ ] **Step 2: Run** them. Expect FAIL. **Step 3: Implement.** **Step 4: Run** the tests and related tests; expect PASS.
- [ ] **Step 5: Commit** `feat: tags are resolved on every write; comment tags reach`.

### Task 4.2: Server-written prose stores tags

**Model:** Sonnet. Spec correction 3.

**Files:** `messaging/peer-body.ts` (`peerBody`, `terminatedBy`, `peerLeftOf`: parse with `scanTags`), `messaging/forwarder.ts` (`factFor`), `agents/notices.ts` (76, 90, 91), `messaging/loop-guard.ts` (`onOpened`), `tasks/bodies.ts` + `task-service.ts` label map (actor, creator, body author → `tagOf(ref)`), `agents/agent-runtime.ts` control events `by`, `spawning/spawn-service.ts` `spawned { by }`, `agents/agent-service.ts` `resetPersona(slug, by)`, `restart-agent.ts` `by`, tests.

**Rule:** every principal named in a stored body or event payload is written `tagOf(p.ref)`. `@factory` and `@scheduler` stay words. `subject.left` (`{ reason: "moved", to }`, `{ reason: "terminated", by }`) holds tags. `peerLeftOf` reads them back with `scanTags` (the first token is `to` / `by`).

- [ ] **Step 1: Write failing tests:**
  - `peer-body.test.ts`: "a peer-left body names the terminator by tag and parses back", where `peerLeftOf(peerBody(…terminated by p…))` → `{ reason: "terminated", by: tagOf(p.ref) }`.
  - `loop-guard.db.test.ts`: "the loop notice names both agents by tag", where the stored body contains `<@refA>` and `<@refB>`.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS) plus related tests.
- [ ] **Step 5: Commit** `feat(server): bodies the factory writes name principals by tag`.

### Task 4.3: What agents read: tags rendered at delivery

**Model:** Sonnet. **Spec:** §4.4 Envelopes, Rendered for agents, Instructions; AC9.

**Files:**
- `packages/harness/src/envelope.ts`: `attr()` writes exact tag substrings (`/<@[0-9a-z]{8}\|[a-z0-9-]+>/g`) unescaped and escapes everything else.
- `apps/server/src/agents/agent-runtime.ts` (`entryOf` / `toBatchRow` / `toEnvelopes`):
  - one `tagLookupFor` over every body, `re` and recipient in the batch
  - `from` / `to` / `about` / `by` / `re[].from` → `agentTagOf`
  - bodies → `renderTags(body, lookup, "agent")` before `neutraliseEnvelopeTags`
- `messaging/inline.ts`: `inline()` keeps `<@…>` tokens whole (strips other `<`/`>`). Test it.
- `workspace/claude-md.ts`:
  - `orgLine`, `humansLine`, manager, `lifecycleSection` and "You are" use `<@ref|handle>`
  - the description goes through `renderTags(…, "agent")`
  - the example envelope uses tags
  - replace lines 159, 181, 192, 200, 225, 226 and 266 with the §4.4 Instructions section, verbatim intent: tag as `<@ref|handle>` in factory tools; `list_peers` shows tags; the ref counts and a label can be stale; outside the factory write plain names
- `agents/start.ts`: build `ClaudeMdInput` with `{ ref, handle }` for entries, writers, spawner and humans.
- `mcp/tools/list-peers.ts`: each entry adds `tag: agentTagOf(p)` and keeps `handle: "@handle"`.
- Tool results that name principals:
  - `get_agent.reports_to`; `create_agent`/`update_agent`/`archive_agent`/`unarchive_agent` result `target`; `spawn_agent` (`tag`); `terminate_agent`; `restart_agent`; `send_command`
  - `send_message` `results[].to`; task tool `assignee`/`created_by`/`author`/`links[].agent`
  - `schedule_message`/`list_schedules` `to`/`created_by`/`by`
  - comment and task bodies in `get_task` → `renderTags(…, "agent")`
  - all render as `<@ref|handle>`

**Interfaces — Consumes:** `tagLookupFor`, `renderTags`, `agentTagOf`.

- [ ] **Step 1: Write failing tests:**
  - `envelope.test.ts`: "a tag in an attribute is written unescaped and other angle brackets are escaped".
  - `agent-runtime` delivery test (fake Claude, `makeTestApp`): "after a rename, a new delivery shows the new handle in from and in a body tag". Rename by updating `principals.handle` in SQL (the endpoint comes in 5.4), deliver a message from that principal whose body tags it, and assert the stdin envelope contains `from="<@REF|new>"` and `<@REF|new>` in the body.
  - `claude-md.test.ts`: "the org block lists peers by tag".
  - `list-peers` test: "list_peers returns each peer's tag".
  - `inline.test.ts`: "inline keeps a tag and strips other angle brackets".
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS) plus related tests.
- [ ] **Step 5: Commit** `feat: agents read principals as <@ref|handle>`.

---

## Part 5 — Ref keys, dropping the slug, renames

### Task 5.1: Workdir, containers, git identity and event channels keyed by ref or id

**Model:** Sonnet. **Spec:** §4.4 Durable keys; AC14; spec corrections 1, 5, 6.

**Files:**
- `workspace/paths.ts`: `agentWorkdir(home, ref)`, `agentStateDir(home, ref)`
- `workspace/workspace.ts`: the lock key, `workdir`, `materialize`, `discard`, `deleteWorkspace`, `resetPersona`, `applyPersona(…)` and `prepare` take a ref; `PrepareInput.ref` + `handle`; the "unique and immutable" comment → ref
- `agents/agent-service.ts`, `spawning/spawn-service.ts`: materialize happens after `createPrincipal`. Order: open the transaction → principal → materialize under `lock.run(ref)` → insert → commit; discard on failure. Or create the principal first and delete it on failure. Pick the first and keep the existing discard semantics.
- `spawning/reaper.ts`, `agents/start.ts`, `uploads/service.ts`, `routes/agents.ts` (pin)
- `runtime/docker/containers.ts`: `containerName(ref) = \`open-factory-${ref}\``; drop `LABEL_SLUG`; methods take `(agentId, ref)`; `ours()` checks the agent-id label
- `runtime/docker/exec-transport.ts`, `agents/runtimes.ts`, `agents/agent-runtime.ts` (2905, 2938, 2961, 1876)
- `agents/runtime-spec.ts`: `GIT_*_NAME` = handle, email = `${ref}@open-factory.local`; `AgentRuntimeSpec.slug` → `ref` (`packages/harness/src/types.ts:12`, log ctx)
- `workspace/settings.ts`: the system prompt `@${handle}`
- `agents/event-bus.ts`: per-agent channels keyed by agent id
- `ws/route.ts`: the client `agent` field is a ref, resolved with `principalsByRefs` → agent id
- `packages/shared/src/ws.ts`: rename `agent` (slug) to `agent` (ref) in client messages and per-agent frames, and document it
- `test/helpers.ts` (`agentWorkdir(factoryHome, ref)`)

- [ ] **Step 1: Write failing tests:**
  - `workspace` db test: "an agent's workdir is named by its ref".
  - `start.test.ts` (fake Claude): "an agent renamed between two starts keeps its workdir and resumes its session". Start, end the turn, update `principals.handle` in SQL, start again, and assert the same `cwd` and that `--resume <sessionId>` was passed.
  - `containers.test.ts`: "a container is named open-factory-<ref>".
  - `ws/route` test: "subscribing by ref streams that agent's events".
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS) plus related tests.
- [ ] **Step 5: Commit** `refactor(server): workdirs, containers and channels are keyed by ref and id`.

### Task 5.2: REST addresses agents by ref; DTOs carry ref and handle

**Model:** Sonnet. **Spec:** §4.4 REST, AC15.

**Files:**
- `routes/agents.ts`: `refParams = z.object({ ref: z.string().transform(normaliseRef).pipe(z.string()) })`, which 404s when undefined; every `/api/agents/:slug…` → `/:ref…`; lookup through `principalsByRefs` → agent row
- `routes/uploads.ts`
- `routes/inbox.ts` (`/api/inbox/read-from/:ref`)
- `runtimes.ts` (`bySlug` → `byRef`)
- `event-store.ts` (`agentBySlug` → `agentByRef`; `markReadFrom`)
- `agent-service.ts` (`summary(ref)`, `rowByRef`, `update(ref)`, `archive(ref)`…)
- `config-service.ts`, `usage/usage-service.ts` (raw SQL `where slug` → join principals by ref)
- Shared DTOs:
  - `AgentSummary`: `slug` → `ref` + `handle`
  - `agentDetail`; inbox `link.agentSlug` → `agentRef`; `from: { kind, ref, handle }` for principals (`{ kind: "factory" }` stays)
  - `unreadCountSchema.byAgent` keyed by ref; `chatRowSchema.agent` → `{ ref, handle, … }`
  - `loopHoldSchema.agents[]` → `{ ref, handle, status }`, `resumedBy` → `{ ref, handle } | null`
  - `messageLookupSchema` / `eventRefSchema` `agentSlug` → `agentRef`
  - usage schemas (`slug`/`spawnerSlug` → `ref` + `handle`)
  - `sendMessagesBodySchema.to` → refs (`z.array(refSchema)`)
  - `managerRefSchema` → a ref
  - `org_action` frame `by`/`subject` → refs
- The 404 copy: `No agent at this ref`.

**Note:** web tests are red from this task until Task 6.2. Run Task 6.2 next.

- [ ] **Step 1: Write failing tests** (`routes/agents.test.ts`): "GET /api/agents/:ref returns the agent with its ref and handle"; "an unknown ref is 404"; "a ref in another case resolves" (uppercase); "POST /api/messages takes refs".
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS) plus the related server tests.
- [ ] **Step 5: Commit** `refactor(server): REST addresses agents by ref`.

### Task 5.3: Drop `agents.slug` and `users.handle`

**Model:** Sonnet.

**Files:**
- Schema `agents.ts`, `auth.ts` + migration.
- `packages/shared/src/names.ts`: delete `slugSchema`, `SLUG_PATTERN`, `RESERVED_SLUGS`; callers use `handleSchema`, `HANDLE_PATTERN`, `RESERVED_HANDLES`.
- `spawning/slug.ts` → `spawning/handle.ts` (`spawnHandle`, same rule, `handleSchema`).
- `createAgentBodySchema.slug` → `handle`; `FieldError("slug", …)` → `"handle"`.
- `auth/options.ts`: remove the `handle` additional field; drop `handle` from the gate's context data.
- **Every remaining reader** (compile-driven: `pnpm typecheck`).
- **Web, minimal:**
  - `lib/session.ts` fetches `/api/me` (`meSchema`) and returns `{ user: Me } | null`, keeping the null-on-401 and throw-on-5xx rules.
  - `lib/auth-client.ts` drops `inferAdditionalFields`.
  - Callers reading `session.user.handle` keep working.
- Smoke scripts in `apps/server/scripts/*` follow (raw SQL `slug` → join principals; URLs by ref).

- [ ] **Step 1: Write failing test** (`lib/session.test.ts` or existing): "the session query reads the signed-in user from /api/me, with handle and ref"; a 401 → null.
- [ ] **Step 2: Run** it. Expect FAIL. **Step 3: Implement**, dropping the columns and fixing every typecheck error. **Step 4: Run** the full **server** typecheck, and `pnpm test:related` over the modified files. Expect PASS.
- [ ] **Step 5: Commit** `refactor!: handles live only on principals`.

### Task 5.4: Principals API, renames and `principal_updated`

**Model:** Sonnet. **Spec:** AC6; §4.4 Rename endpoints; §4.5 Principals cache.

**Files:**
- Create: `apps/server/src/routes/principals.ts`, `apps/server/src/principals/principal-events.ts`
- Modify: `routes/agents.ts` (PATCH accepts `handle`), `routes/me.ts` (`PATCH /api/me`), `packages/shared/src/ws.ts`, `packages/shared/src/principals.ts` (new DTOs), `agents/agent-service.ts` (create, archive, unarchive), `spawning/*` (create, terminate), `users/user-admin.ts` (disable, enable), `users/sign-up-gate.ts` (create)

**Interfaces — Produces:**

```ts
// packages/shared/src/principals.ts
export const principalStateSchema = z.enum(["live", "archived", "terminated", "disabled"]);
export const principalItemSchema = z.object({
  id: z.string(), ref: z.string(), kind: z.enum(["agent", "human"]), handle: z.string(), name: z.string(),
  state: principalStateSchema,
  avatar: z.object({ template: z.string(), avatarVersion: z.string().nullable(), color: z.number().int().nullable() }).nullable(), // agents only
});
export type PrincipalItem = z.infer<typeof principalItemSchema>;
export const principalsResponseSchema = z.object({ principals: z.array(principalItemSchema) });
export const patchMeBodySchema = z.strictObject({ name: z.string().trim().min(1).max(80), handle: handleSchema }).partial();
// ws.ts: serverMessageSchema gains
// { type: "principal_updated", principal: principalItemSchema }
```

**Endpoints and events:**
- `GET /api/principals` lists all; `GET /api/principals?refs=a,b` lists those refs (at most 100).
- `PATCH /api/agents/:ref` with `{ handle }`, and `PATCH /api/me` with `{ name?, handle? }`:
  - Update `principals.handle` (and `users.name`) in one transaction.
  - `isHandleTaken` → 409 field error `handle`: "Another agent or person has this handle".
  - A reserved or malformed handle → 400 from `handleSchema` with its message: "Reserved for the factory", "Use 2 to 40 characters", "Use lowercase letters, numbers and hyphens", "Start and end with a letter or number". Put these in `MSG` with the ≤40-char rule.
  - A handle change doesn't trigger the "restarts its reports" logic.
- `publishPrincipal(bus, tx|db, id)` publishes `principal_updated` with the full item **after commit**. It's called on create (agent, spawn, sign-up), a handle or name change, archive, unarchive, terminate, disable and enable.

- [ ] **Step 1: Write failing tests** (`routes/principals.test.ts`, `routes/agents.test.ts`, `routes/me.test.ts`):
  - "renaming an agent returns 200 and publishes principal_updated with the new handle" (capture frames via `bus.subscribeAll`).
  - "renaming to a taken handle is 409 with the field error".
  - "renaming to a reserved handle is 400".
  - "after a rename the old handle is free for a new agent".
  - "PATCH /api/me changes name and handle and publishes".
  - "creating an agent publishes principal_updated".
  - "GET /api/principals?refs= returns only those refs".
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS) plus related tests.
- [ ] **Step 5: Commit** `feat(server): rename agents and yourself; principal_updated`.

---

## Part 6 — Web

Every task in this part: the implementer and reviewer invoke `vercel-react-best-practices`, and follow DESIGN.md, `impeccable` and Emil Kowalski's skills. No browser checks.

### Task 6.1: The principals cache

**Model:** Sonnet. **Spec:** §4.5 Principals cache.

**Files:**
- Create:
  - `apps/web/src/features/principals/api.ts` (`principalsQueryOptions`, key `["principals"]`, `staleTime: Infinity`; `applyPrincipalUpdated(qc, item)`)
  - `features/principals/use-principal.ts` (`usePrincipal(ref): { status: "pending" | "found" | "unknown"; principal? }`)
  - tests
- Modify: `routes/_app.tsx` (`principal_updated` → `applyPrincipalUpdated`)

**Behaviour:**
- `usePrincipal` reads the cache with `select`, so it re-renders only when that principal changes (`rerender-derived-state`).
- A ref missing from a loaded cache joins a module-level batch, flushed once per `requestAnimationFrame`, that fetches `/api/principals?refs=…` and merges the results. Refs the server didn't return are marked unknown in a `Set` kept in the query data.
- `"pending"` lasts until the cache has loaded and the batch has answered.

- [ ] **Step 1: Write failing tests:**
  - "a principal_updated frame changes the handle usePrincipal returns" (render a probe and dispatch via the `_app` WS mock pattern, `test/ws-hub.test.tsx`).
  - "a ref missing from the cache is fetched once and then found".
  - "a ref the server doesn't know becomes unknown, never before the fetch answers".
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(web): principals cache patched live`.

### Task 6.2: Routes and links by ref; avatars seeded from the id

**Model:** Sonnet (large, mechanical). **Spec:** §4.5 Routes; AC15.

**Files:**
- Rename the route files `routes/_app/agents.$slug*.tsx` → `agents.$ref*.tsx` and regenerate `routeTree.gen.ts`.
- Every `to="/agents/$slug/…" params={{ slug }}` → `$ref` (the files are listed in the web map: agent-chip, agent-menu, agent-tree, back-to-agent, new-agent-sheet, sidebar-tree, view-switch, chat-composer, chat-view, turn-line, config-states, inbox/*, command-palette, schedule-row, session/*, settings/shared, usage-section, skills peeks, template-editor, usage-tables).
- String paths: `notification-copy.ts`, `org-toasts.ts`, `edit-agent-sheet.tsx` `AGENT_PAGES`, `app-sidebar.tsx` `matchSession`, `inbox/api.ts` `chatSlugOf` → `chatRefOf`.
- Query keys `["agent", ref]`.
- `use-agent-index.ts` indexes by ref.
- `AgentAvatar` takes `id` for the seed (`botParts(id)`); `colour-field.tsx`.
- Not-found copy: "No agent at this link".
- `test/render-in-router.tsx` stub.

- [ ] **Step 1: Write failing tests:**
  - App-level (`renderApp`): "an agent's chat route is addressed by its ref".
  - "after principal_updated the page header shows the new handle and the URL is unchanged".
  - "an unknown ref shows 'No agent at this link'".
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS), then run the web tests touched (`pnpm vitest run apps/web/src/features/agents apps/web/src/features/chat apps/web/src/features/session apps/web/src/features/inbox`).
- [ ] **Step 5: Commit** `refactor(web): agents are addressed by ref`.

### Task 6.3: The Tag chip, the remark plugin, plain-text surfaces

**Model:** Sonnet. **Spec:** §4.5 Tag chip, Plain-text surfaces; §4.6.

**Files:**
- Create:
  - `apps/web/src/components/tag/tag.tsx` (`Tag({ tagRef, interactive = true })`)
  - `components/tag/remark-tags.ts` (a remark plugin: splits `text` nodes on `/<@([0-9A-Za-z]{8})(?:\|[^<>\n]*)?>/g` into `{ type: "tag", data: { hName: "of-tag", hProperties: { tagRef } } }`; never inside `code`/`inlineCode`)
  - `components/tag/plain-tags.ts` (`usePlainTags(text): string`: `renderTags(text, lookup, "plain")` over the cache)
  - tests
- Modify:
  - `components/markdown/markdown.tsx`: `REMARK_PLUGINS = [remarkGfm, remarkTags]`, except when `untrusted` (mono tool rows stay raw, §4.5): `[remarkGfm]`; `components["of-tag"] = TagFromMarkdown`. Inside an `a` override, render children with a context that sets `interactive={false}`.
  - `features/tasks/task-list.tsx` title; `inbox-row.tsx` / `chat-row.tsx` preview; `notification-copy.ts`; `page-header.tsx` `documentTitle` callers (task title); edit-agent sheet description line → `usePlainTags`

**Chip (exact, from §4.5):**
- An agent is a TanStack `Link` to `/agents/$ref/chat`; a human is a `span`. Both are `inline-flex`, with `nowrap` across the avatar, `@` and the first handle segment.
- Avatar `min(1em,16px)`, `aria-hidden`. Visible `@handle`, then `<span className="sr-only">, {name}{state !== "live" ? `, ${state}` : ""}</span>`.
- Tooltip: "Name · Agent" / "Name · Person", or "Name · Terminated" / "· Archived" / "· Disabled".
- Pending: `@…` with a steel plate. Unknown: muted `@unknown`, no avatar, tooltip and sr-only text "No one in this factory has this tag".
- `interactive={false}` renders a `span`, not focusable.
- Styling uses existing tokens (no tests on classes).

- [ ] **Step 1: Write failing tests** (Testing Library, with a seeded query client):
  - "a tag renders as a link to the agent's chat named by its current handle".
  - "a human tag is not a link".
  - "a terminated agent's chip says terminated to a screen reader" (`getByRole("link", { name: "@old-dev, Ada Lovelace, terminated" })`).
  - "a tag inside a code span renders as text".
  - "a ref missing from the cache shows @… then the handle, never @unknown".
  - "a tag inside a task-list row link renders as plain text, not a nested link" (no `link` inside the row link).
  - "a chip shows the new handle after principal_updated".
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(web): tags render as chips`.

### Task 6.4: Tag ranges (pure)

**Model:** Sonnet. **Spec:** §4.5 Composer (data rules).

**Files:**
- Create: `apps/web/src/components/composer/tag-ranges.ts`, `tag-ranges.test.ts`

**Interfaces — Produces:**

```ts
export type TagRange = { start: number; end: number; ref: string }; // [start,end) covers "@handle"
export type Tagged = { text: string; ranges: readonly TagRange[] };
/** Stored "<@ref>" text → display "@handle" text with ranges (handle from lookup; "@…" while pending). */
export function hydrate(stored: string, handleOf: (ref: string) => string): Tagged;
/** Display text with ranges → stored "<@ref>" text. */
export function serialise(t: Tagged): string;
/** Applies a textarea edit (old text → new text, diffed by common prefix and suffix) to ranges: shift ranges after it; drop a range the edit touches inside. */
export function rebase(prev: Tagged, nextText: string): Tagged;
/** Inserts a picked tag over [from, caret+tail) as "@handle " and records its range. */
export function insertTag(t: Tagged, from: number, to: number, ref: string, handle: string): { tagged: Tagged; caret: number };
/** Caret snapping: a collapsed caret inside a range moves to its nearer edge (click) or its far edge in the direction of travel (arrows). */
export function snapCaret(ranges: readonly TagRange[], at: number, how: "click" | "left" | "right"): number;
/** Selection edges inside a range snap outward. */
export function snapSelection(ranges: readonly TagRange[], start: number, end: number): [number, number];
/** Backspace at a range's end / Delete at its start removes the whole range and one following space. */
export function deleteTagAt(t: Tagged, caret: number, key: "Backspace" | "Delete"): { tagged: Tagged; caret: number } | undefined;
/** Pasted text/html with data-of-tag spans, or plain text with <@ref> / <@ref|label>, → text + ranges to insert. */
export function fromClipboard(data: { html?: string; text: string }, handleOf: (ref: string) => string): Tagged;
/** Copy: plain @handle text and html with data-of-tag spans for a selection. */
export function toClipboard(t: Tagged, start: number, end: number): { text: string; html: string };
```

- [ ] **Step 1: Write failing tests**, one `test.each` per function:
  - `hydrate` / `serialise` round trip.
  - `rebase`: typing before a range shifts it; typing inside one drops it; deleting across one drops it.
  - `snapCaret`: a click at the middle goes to the nearer edge; left from just after goes to just before.
  - `snapSelection`.
  - `deleteTagAt`: removes the tag and its trailing space.
  - `fromClipboard`: both html and raw `<@ref|label>`.
  - `toClipboard`.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(web): atomic tag ranges`.

### Task 6.5: Composer: tags, highlighter, caret, undo, copy and paste; the `@` menu

**Model:** Sonnet. **Spec:** §4.5 Composer and "The `@` menu"; AC7.

**Files:**
- Create: `components/composer/tag-highlighter.tsx` (a mirror layer under the textarea; export `COPY_PROPS` from `caret-menu.tsx` and reuse it)
- Modify:
  - `components/composer/composer.tsx`: state is `Tagged` instead of a string; `useDraft` stores the serialised text and hydrates on load; `onChange` → `rebase`; `onSelect` → `snapCaret` / `snapSelection`; `onKeyDown` Backspace/Delete → `deleteTagAt`; `onCopy` / `onCut` / `onPaste` → `toClipboard` / `fromClipboard`; `pick()` → `insertTag`
  - **undo:** picks and whole-tag deletes go through `document.execCommand("insertText")` where supported; keep a snapshot stack `{ text, ranges, selection }` and restore ranges on `beforeinput` `historyUndo` / `historyRedo` by matching text
  - **submit:** `serialise`
  - `CompletionSource.accept` returns `{ ref, handle }` for `@` sources (a new optional `acceptTag`) so the composer records a range
  - `components/composer/mentions.ts`: `rankMentions` over `PrincipalItem[]` (live only), `Mention` carries `ref`
  - `features/mentions/mention-source.ts`: reads `principalsQueryOptions`; items `id = ref`, `detail = @handle`, human avatar via `HumanAvatar`; `label: "Tag someone"`; `menuNote` per surface (a new `mentionSource(qc, { note })`)
  - `features/tasks/comment-composer.tsx`: `COMMENT_AT_LABEL` → "Tag someone"; note "A tag notifies them · Esc keeps it as text"; the hint "Goes to @x and anyone you tag."
- Tests: `composer.test.tsx`, `mentions.test.ts`

- [ ] **Step 1: Write failing tests:**
  - "picking from @ inserts a tag that is sent as <@ref>".
  - "a click inside a tag puts the caret at its edge".
  - "Backspace at a tag's end removes it whole".
  - "undo after deleting a tag restores it as a tag" (fire `beforeinput` with `inputType: "historyUndo"`).
  - "pasting copied tags keeps them as tags".
  - "a draft with a tag hydrates back to @handle and sends <@ref>".
  - "typed @name that wasn't picked is sent as text".
  - "the @ menu is labelled Tag someone and lists only live principals".
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(web): composers tag with atomic ranges`.

### Task 6.6: Tags in the task title, task body, agent description and schedule body fields

**Model:** Sonnet. **Spec:** §4.5 Composer surfaces, MarkdownEditor fields; AC7.

**Files:**
- Create: `components/composer/use-tag-field.ts`, a hook that brings Task 6.4/6.5's range behaviour, the highlighter and the `@` caret menu to any `<textarea>` or `<input>`. It returns `{ value, bind, menu, serialised }`.
- Modify:
  - `components/markdown/markdown-editor.tsx` (Write uses the hook; Preview renders `serialised`; no `@` button)
  - `features/tasks/task-form.tsx` (title `Input`, Description)
  - `features/tasks/task-detail.tsx` (`TitleEditor`, body editor)
  - `features/agents/edit-agent-sheet.tsx` and `new-agent-sheet.tsx` (Description `Textarea`)
  - `features/schedules/schedule-form.tsx` (Message)
  - Each field's menu note is "Esc keeps it as text".

- [ ] **Step 1: Write failing tests:** "editing a task title with a tag shows @handle and saves <@ref>"; "a schedule body's Preview renders the tag as a chip".
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(web): tag fields beyond composers`.

### Task 6.7: Chat: `@` only tags; Add recipient

**Model:** Sonnet. **Spec:** §4.5 Chat recipients; AC8.

**Files:**
- Delete: `features/chat/recipient-source.ts` and its test.
- Create: `features/chat/add-recipient.tsx`, the toolbar control plus a Multi-pick `Combobox` (`components/ui/combobox.tsx` `multiple`).
- Modify:
  - `features/chat/chat-composer.tsx`: `completions={{ at: mentionSource with the note "A tag doesn't send · Esc keeps it as text" }}`; recipients stay in this component's state
  - `components/composer/composer.tsx`: a new optional `toolbarStart?: ReactNode` slot, left of `@`
  - `components/composer/recipients.tsx` (an "Add" ghost at the end of the chips)
  - `lib/drafts.ts` (recipients stored as refs)

**Behaviour (§4.5):**
- **Labels:** "Add recipient" with `UserPlus`; below `md`, a 40px icon with `aria-label="Add recipient"`.
- **Picker:** live agents minus the chat's agent and the ones already added. It stays open, marks added rows "Added", and announces each addition through the existing "Also sending to @x" region. Footer: "Only live agents get messages · Up to 10 per message".
- **When held:** `aria-disabled`, with the reason in the note slot when pressed: at 10, "A message goes to at most 10 agents."; with files, "Files go to one agent at a time".

- [ ] **Step 1: Write failing tests** (`chat-composer.test.tsx`):
  - "picking from @ in chat inserts a tag and adds no recipient" (the send goes to `[chatRef]` only).
  - "Add recipient adds an agent and announces it".
  - "Add recipient is aria-disabled with its reason at 10 recipients".
  - "Add recipient is aria-disabled with its reason while files are attached".
  - Remove the old tests that asserted `@` adds a recipient.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(web): @ tags in chat; recipients are added with their own control`.

### Task 6.8: Rename an agent; Edit profile; rename feedback

**Model:** Sonnet. **Spec:** §4.5 Renaming an agent, Editing your profile, Validation and feedback; AC6.

**Files:**
- Modify:
  - `features/agents/address-line.tsx` (label "Handle"; the create and edit help copy from §4.5; an `edit` mode with the extra line)
  - `features/agents/edit-agent-sheet.tsx` (`AddressLine` under Display name; the handle saves through `PATCH /api/agents/:ref`; the handle isn't in `restartFields`)
  - `features/agents/agent-form-state.ts` (`FIELDS` `slug` → `handle`; edit mode includes `handle`; `check("handle")` with `handleSchema` and a blur check against the principals cache)
  - `features/agents/derive-slug.ts` → `derive-handle.ts`
  - `new-agent-sheet.tsx`
  - `components/app-sidebar.tsx` (the "Edit profile" menu item)
  - `features/sheets/sheet-store.ts` / `sheet-bodies.ts` (an `edit-profile` sheet)
  - `routes/sign-up.tsx` (the help copy from §4.5)
  - `lib/form-messages.ts`
- Create: `features/profile/edit-profile-sheet.tsx`, `features/profile/api.ts` (`patchMe`)

**Behaviour:**
- **Validation timing:** on blur when changed, then on every keystroke while an error shows.
- **Errors:** the §4.5 copy; a server 409 maps to the same message.
- **After a handle save:** close the sheet, then `notify({ text: "@old is now @new", undo: () => patch(old) })`. On 409, Undo throws an `ApiError` with "Couldn't undo: @old was taken" (the toaster shows the message).
- **A name-only save** uses the sheet's normal confirmation.

- [ ] **Step 1: Write failing tests:**
  - "Edit profile saves a new name and handle".
  - "a taken handle shows 'Another agent or person has this handle'".
  - "Undo on the rename toast restores the old handle".
  - "renaming an agent doesn't show the restart note".
  - "the create form calls it Handle".
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(web): rename agents and edit your profile`.

---

## Part 7 — Docs and finish

### Task 7.1: ADR 0029, product docs, DESIGN.md, spec corrections

**Model:** Sonnet. **Spec:** §5.

**Files:**
- Create: `docs/product/decisions/0029-principals-and-tags.md` (front matter as ADR 0028; Context / Decision / Consequences)
- Modify:
  - `docs/product/decisions/index.md`
  - `docs/product/concepts/{agent,user,message,task}.md`
  - `docs/product/architecture/*` pages that name `handles`, slugs, workdir paths or container names (`grep -rln "slug\|handles\|agents/<" docs/product/architecture`)
  - `DESIGN.md`: Forms; Composers (`@` tags, Add recipient, the highlighter, the session composer still raw); a new Tag chip entry; the user menu's Edit profile
  - the spec, applying the "Spec corrections" list above (container name, recipient ids, server prose, inline/attr, channels, git identity, better-auth, surfaces)

- [ ] **Step 1:** Write the docs. **Step 2:** Run `grep -rn "slug" docs/product/concepts` and make sure every remaining hit is intended. **Step 3: Commit** `docs: principals and tags`.

### Task 7.2: Whole-branch review, verification, PR

**Model:** the dev's model.

- [ ] **Step 1:** A whole-branch review (`superpowers:requesting-code-review`) against the spec and this plan, including the React diff against `vercel-react-best-practices`. Fix the findings.
- [ ] **Step 2:** Run `pnpm typecheck && pnpm lint && pnpm build && pnpm test`. All must pass; paste the summaries into the PR body.
- [ ] **Step 3:** Push and open the PR, **ready for review**:
  - **Title:** `feat: principals and tags: changeable handles, @ only tags`
  - **Body** per `.github/pull_request_template.md`:
    - What, Why, Approach (one bullet per decision: "<decision>, rather than <alternative>, because <reason>")
    - Changes grouped by area
    - links to the spec and this plan
    - the **reset step**: drop the database and recreate agents and users
    - **"For the owner to check in the browser":**
      - the tag chip states (live, pending, ended, unknown)
      - the composer highlighter, caret, Backspace, undo, copy and paste
      - the `@` menu notes per surface
      - Add recipient on desktop and mobile
      - the rename toast with Undo
      - Edit profile
      - links staying the same after a rename
    - ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
- [ ] **Step 4:** Wait for CI to go green; fix and push if it doesn't.
