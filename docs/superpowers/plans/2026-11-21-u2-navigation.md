# U2 Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents in the sidebar as the reporting tree with generated avatars, an Agent details panel and one-line session header, Settings pages and a top-level Usage page, a ⌘K palette with shortcuts and searchable pickers, an inbox reading pane and task peek, and the Home and Templates/Images redesigns, delivered as six stacked PRs on U1.

**Architecture:** Shared Zod schemas grow a few fields (`byAgent`, `avatarVersion`, `q`); the server adds four small routes; the web app adds a handful of primitives (avatar, chip, peek sheet mode, combobox, shortcut dispatcher, prefs, breakpoints) and rebuilds the shell, session header, settings, inbox and task list on them. Live agent state is folded into the query cache once, in the shell, and read per row through selectors so a status frame re-renders only what changed.

**Tech Stack:** TypeScript, pnpm monorepo; Fastify + Drizzle/Postgres (`apps/server`, `packages/db`); React 19 + Vite + TanStack Router/Query (`apps/web`); Radix (`radix-ui@1.8.1`), Vaul 1.1.2, cmdk 1.1.1 (new); Vitest + Testing Library (jsdom); Biome.

**Spec:** `docs/superpowers/specs/2026-11-21-u2-navigation-design.md` (decision issue #89). Read it with this plan; section numbers below (§n) are the spec's. DESIGN.md amendment text is quoted verbatim in spec §16 and staged per PR as §16 says (`[PR n]` markers).

## Global Constraints

- Six stacked PRs, each based on the one below; PR1's base is `u1/5-perceived-speed`. No PR depends on a later one; each leaves the app working.
- Every task that touches `apps/web`: **Implementer and reviewer invoke `vercel-react-best-practices` and follow it.** (Repeated in each task.)
- TDD: failing test first, then code, then run. Tests guard behaviour and regressions, never exact token values or DESIGN.md prose; the avatar contrast and golden-vector tests compute, they don't pin colours.
- `cmdk@1.1.1` added with `--save-exact` (decision 8). No supply-chain setting changes. No other new dependency.
- DESIGN.md never describes a feature before it exists: each PR lands only its own `[PR n]` clauses (spec §16).
- Behavior docs (`docs/product/behavior/*.md`) are gitignored: the dev edits them in the main checkout `/Users/orlevi/projects/open-factory/docs/product/behavior/` (spec §17) and lists each edit in the PR body.
- Copy: sentence case; "New agent" everywhere for creating an agent; "Agent details" is the panel's only name; "No item selected."; "No agents yet."; "Nothing needs you."; "No agent is working.".
- Breakpoints in rem (`lib/breakpoints.ts`): `MOBILE (width < 48rem)`, `WIDE (width >= 64rem)`, `XWIDE (width >= 80rem)`.
- Keyboard-initiated UI never animates (U1 `data-instant`); the palette never animates at all.
- Commands: `pnpm test` (vitest, root), `pnpm typecheck`, `pnpm lint`, `pnpm build`. A single file: `pnpm vitest run <path>`.
- Commit messages are conventional (`feat(web): …`, `feat(server): …`, `feat: …` when spanning) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Delivery

| PR | Branch | Base | Title | Tasks |
|---|---|---|---|---|
| 1 | `u2/1-sidebar-agents` | `u1/5-perceived-speed` | `feat: agent avatars and agents in the sidebar` | 1–17 |
| 2 | `u2/2-agent-details` | `u2/1-sidebar-agents` | `feat(web): Agent details panel and a one-line session header` | 18–26 |
| 3 | `u2/3-settings-usage` | `u2/2-agent-details` | `feat(web): Settings pages and a top-level Usage page` | 27–30 |
| 4 | `u2/4-palette` | `u2/3-settings-usage` | `feat: command palette, shortcuts and searchable pickers` | 31–38 |
| 5 | `u2/5-inbox-pane` | `u2/4-palette` | `feat: inbox reading pane and task peek` | 39–46 |
| 6 | `u2/6-home-templates` | `u2/5-inbox-pane` | `feat(web): Home redesign and Templates/Images views` | 47–52 |

After a PR below merges, retarget the next PR's base to `main` and rebase its branch (`git rebase --onto main <old-base> <branch>`). Task 52 (whole-stack review) runs on PR6's branch.

## File map (new files)

| File | Responsibility | PR |
|---|---|---|
| `apps/web/src/lib/factory-bot.ts` | `fnv1a32`, `botParts`, contrast helpers | 1 |
| `apps/web/src/components/agent-avatar.tsx` | `BotSvg`, `AgentAvatar`, `StatusMark` (badge shapes) | 1 |
| `apps/web/src/components/agent-chip.tsx` | `AgentChip`, `PrincipalChip`, `TruncTooltip` | 1 |
| `apps/web/src/lib/prefs.ts` | `usePref` over localStorage | 1 |
| `apps/web/src/lib/breakpoints.ts` | rem media queries + `useMedia` | 1 |
| `apps/web/src/lib/timing.ts` | `INBOX_DWELL_MS` | 1 |
| `apps/web/src/features/agents/use-agent-index.ts` | `useAgentIndex`, `useAgent(slug)` | 1 |
| `apps/web/src/features/agents/tree-model.ts` | pure tree shape, expansion, working counts, rail filter | 1 |
| `apps/web/src/features/agents/sidebar-tree.tsx` | the sidebar tree component | 1 |
| `apps/web/src/features/session/use-read-from.ts` | session-view read-from effect | 1 |
| `apps/web/src/components/ui/kbd.tsx` | key hints | 2 |
| `apps/web/src/lib/shortcuts.ts` | global key dispatcher, `useShortcut` | 2 |
| `apps/web/src/features/session/live-line.tsx` | `liveFact`, `LiveLine` | 2 |
| `apps/web/src/features/agents/agent-menu.tsx` | `AgentMenu` | 2 |
| `apps/web/src/features/session/agent-details.tsx` | `AgentDetails`, `useAgentDetailsPanel` | 2 |
| `apps/web/src/routes/_app/settings.{credentials,secrets,projects,users,factory,index}.tsx` | settings pages | 3 |
| `apps/web/src/routes/_app/usage.tsx` | Usage page | 3 |
| `apps/web/src/components/ui/combobox.tsx` | cmdk combobox | 4 |
| `apps/web/src/features/agents/agent-combobox.tsx` | `AgentCombobox` | 4 |
| `apps/web/src/features/palette/{rank.ts,command-palette.tsx}` | palette | 4 |
| `apps/web/src/features/shortcuts/shortcuts-sheet.tsx` | `?` sheet | 4 |
| `apps/web/src/features/inbox/{preview.ts,inbox-pane.tsx,session-excerpt.tsx}` | inbox pane | 5 |
| `apps/web/src/features/tasks/task-peek.tsx` | task peek | 5 |
| `apps/web/src/components/ui/segmented-links.tsx` | link-style segmented control | 6 |
| `apps/web/src/routes/_app/templates.images.tsx` | Images view | 6 |

---

# PR 1 — `u2/1-sidebar-agents`: agent avatars and agents in the sidebar

Setup (once, before Task 1): from the repo root, `git fetch && git worktree add .worktrees/u2-1 -b u2/1-sidebar-agents origin/u1/5-perceived-speed && cd .worktrees/u2-1 && pnpm install`. (Later PRs: a new branch from the previous PR's branch in the same worktree, `git checkout -b u2/<n>-<slug>`.)

### Task 1: Shared schemas: `byAgent`, `avatarVersion`, read-from

Implements §15.1, §15.3 (schema half).

**Files:**
- Modify: `packages/shared/src/messaging.ts:93-97`
- Modify: `packages/shared/src/agents.ts:47-82`
- Test: `packages/shared/src/messaging.test.ts`, `packages/shared/src/agents.test.ts`

**Interfaces:**
- Produces: `unreadCountSchema = z.object({ count, byAgent: z.record(z.string(), z.number().int().nonnegative()).default({}) })`; `readFromBodySchema = z.object({ upTo: z.string().min(1) })`; `readFromResponseSchema = z.object({ marked: z.number().int(), readAt: z.string() })`; `inboxItemResponseSchema = z.object({ item: inboxItemSchema })` (used in PR5); `agentSummarySchema.avatarVersion: z.string().nullable().default(null)`.

- [ ] **Step 1: Failing tests**

```ts
// packages/shared/src/messaging.test.ts
test("unread count carries byAgent and defaults it", () => {
  expect(unreadCountSchema.parse({ count: 2 })).toEqual({ count: 2, byAgent: {} });
  expect(unreadCountSchema.parse({ count: 2, byAgent: { ada: 2 } }).byAgent).toEqual({ ada: 2 });
});
test("read-from body and response", () => {
  expect(readFromBodySchema.safeParse({ upTo: "" }).success).toBe(false);
  expect(readFromResponseSchema.parse({ marked: 1, readAt: "2026-11-21T00:00:00.000Z" }).marked).toBe(1);
});
// packages/shared/src/agents.test.ts
test("agent summary avatarVersion defaults to null", () => {
  const a = agentSummarySchema.parse(minimalSummary()); // reuse the file's existing fixture builder or inline the required fields
  expect(a.avatarVersion).toBeNull();
});
```

- [ ] **Step 2:** `pnpm vitest run packages/shared/src/messaging.test.ts packages/shared/src/agents.test.ts` → FAIL.
- [ ] **Step 3:** Add the fields/schemas above; export the new schemas from `packages/shared/src/index.ts` if the index re-exports by name.
- [ ] **Step 4:** Re-run → PASS; `pnpm typecheck` (the server's `unread-count` handler now fails typecheck until Task 2; keep `byAgent: {}` in the handler as a stopgap in this commit).
- [ ] **Step 5:** Commit `feat: unread byAgent, read-from and avatarVersion schemas`.

### Task 2: Server: unread count per agent

Implements §15.1 (count). Builds on `EventStore.unreadCount` (`apps/server/src/agents/event-store.ts:1306`), route `apps/server/src/routes/inbox.ts:47-51`.

**Files:**
- Modify: `apps/server/src/agents/event-store.ts` (new `unreadByAgent(userId)`)
- Modify: `apps/server/src/routes/inbox.ts:47-51`
- Test: `apps/server/src/routes/inbox.test.ts`

**Interfaces:**
- Produces: `EventStore.unreadByAgent(userId: string): Promise<Record<string, number>>`.

- [ ] **Step 1: Failing test** (reuse the file's `aCalls`, `callTool`, `get` helpers):

```ts
test("unread-count byAgent counts unread messages by sending agent only", async () => {
  await aCalls("toolu_m1", { to: "@or", body: "one" });
  await aCalls("toolu_m2", { to: "@humans", body: "two" });
  // a factory item and a task_event must not count: the existing tests' helpers that create a task done-event
  // and an errored top-level agent item are reused here if present; otherwise create a task as `or`, have `ada`
  // mention @or in a comment (mention: excluded), and mark the task done (task_event: excluded).
  const r = (await get("/api/inbox/unread-count")).json();
  expect(r.byAgent).toEqual({ ada: 2 });
  expect(r.count).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2:** `pnpm vitest run apps/server/src/routes/inbox.test.ts -t byAgent` → FAIL.
- [ ] **Step 3:** Implement:

```ts
async unreadByAgent(userId: string): Promise<Record<string, number>> {
  const fa = alias(agents, "fa");
  const rows = await this.db
    .select({ slug: fa.slug, n: count() })
    .from(inboxItems)
    .innerJoin(messages, eq(messages.id, inboxItems.messageId))
    .innerJoin(fa, eq(fa.id, messages.fromAgentId))
    .where(and(eq(inboxItems.userId, userId), isNull(inboxItems.readAt), eq(inboxItems.kind, "message")))
    .groupBy(fa.slug);
  return Object.fromEntries(rows.map((r) => [r.slug, r.n]));
}
```
Route: `async (req) => { const u = userOf(req); const [count, byAgent] = await Promise.all([app.store.unreadCount(u), app.store.unreadByAgent(u)]); return { count, byAgent }; }`.
- [ ] **Step 4:** Re-run the file → PASS.
- [ ] **Step 5:** Commit `feat(server): unread inbox count per sending agent`.

### Task 3: Server: `POST /api/inbox/read-from/:slug`

Implements §15.1 (read-from). Builds on `markAllRead` (`event-store.ts:1278`), `isCursorInstant`.

**Files:**
- Modify: `apps/server/src/agents/event-store.ts` (new `markReadFrom`)
- Modify: `apps/server/src/routes/inbox.ts`
- Test: `apps/server/src/routes/inbox.test.ts`

**Interfaces:**
- Produces: `EventStore.markReadFrom(userId, slug, upTo): Promise<{ marked: number; readAt: string } | null>` (null = unknown slug).

- [ ] **Step 1: Failing tests**

```ts
test("read-from marks that agent's unread messages up to upTo, idempotent, user-scoped", async () => {
  await aCalls("toolu_r1", { to: "@or", body: "one" });
  const upTo = new Date().toISOString();
  const other = (await signUp(h.app, { handle: "sam" })).cookie; // invite flow helper as the file's other tests do
  const post = (c: string, slug = "ada", body: object = { upTo }) =>
    h.app.inject({ method: "POST", url: `/api/inbox/read-from/${slug}`, headers: { cookie: c }, payload: body });
  expect((await post(cookie)).json().marked).toBe(1);
  expect((await post(cookie)).json().marked).toBe(0);
  expect((await get("/api/inbox/unread-count")).json().byAgent).toEqual({});
  expect((await post(cookie, "nobody")).statusCode).toBe(404);
  expect((await post(cookie, "ada", { upTo: "yesterday" })).statusCode).toBe(400);
  // a message after upTo stays unread
  await aCalls("toolu_r2", { to: "@or", body: "later" });
  expect((await post(cookie)).json().marked).toBe(0);
  void other;
});
test("read-from publishes inbox_changed only when it marked something", async () => { /* spy app.bus.publishToUser as the read-all test does */ });
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `markReadFrom` (resolve the agent id by slug, `null` if missing; `isCursorInstant(upTo)` else throw `InvalidCursorError`; update `inbox_items` set `readAt = clock()` where user, unread, kind `message`, `created_at <= upTo`, and `message_id in (select id from messages where from_agent_id = <id>)`, returning ids). Route: params `{ slug: z.string().min(1).max(64) }`, body `readFromBodySchema`, response `readFromResponseSchema`; 404 `agent_not_found` on null; `FieldError("upTo","Not a valid time.")` on `InvalidCursorError`; `if (r.marked) app.bus.publishToUser(userId, { type: "inbox_changed" })`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(server): mark an agent's unread messages read`.

### Task 4: Server: `avatarVersion` and the avatar route

Implements §15.3. Builds on `AgentService.summarize` (`apps/server/src/agents/agent-service.ts:179`, deps `this.d.templates: TemplateIndex` with `dir`), `templatesRoutes` (`apps/server/src/routes/templates.ts`, `params = z.object({ name: nameSchema })`, `app.templates.scanOne(name)` → `TemplateRow` with `path`), template detail response (`templateDetailResponseSchema` in `packages/shared/src/templates.ts`).

**Files:**
- Create: `apps/server/src/templates/avatar.ts` (`MAX_AVATAR_BYTES = 256 * 1024`, `avatarStat(dir): Promise<{ version: string | null; tooLarge: boolean }>`)
- Modify: `apps/server/src/agents/agent-service.ts` (summarize: one `avatarStat` per distinct template)
- Modify: `apps/server/src/routes/templates.ts` (GET `/api/templates/:name/avatar.svg`; detail adds `avatar`)
- Modify: `packages/shared/src/templates.ts` (detail `avatar: { version: string|null; tooLarge: boolean }`)
- Test: `apps/server/src/templates/avatar.test.ts`, `apps/server/src/routes/templates.test.ts`, `apps/server/src/agents/agent-service.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// avatar.test.ts (tmp dir)
test("version from mtime and size; null when missing, too large or not a file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tpl-"));
  expect(await avatarStat(dir)).toEqual({ version: null, tooLarge: false });
  await writeFile(path.join(dir, "avatar.svg"), "<svg/>");
  expect((await avatarStat(dir)).version).toMatch(/^\d+-6$/);
  await writeFile(path.join(dir, "avatar.svg"), "x".repeat(256 * 1024 + 1));
  expect(await avatarStat(dir)).toEqual({ version: null, tooLarge: true });
});
// templates.test.ts
test("avatar route: headers, 404 when absent, 400 invalid name, 404 unknown", async () => {
  // write <templatesDir>/dev/avatar.svg in the test app's factory home
  const r = await get("/api/templates/dev/avatar.svg");
  expect(r.headers["content-type"]).toMatch(/^image\/svg\+xml/);
  expect(r.headers["x-content-type-options"]).toBe("nosniff");
  expect(r.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
  expect(r.headers.etag).toBeDefined();
  expect((await get("/api/templates/nope/avatar.svg")).statusCode).toBe(404);
  expect((await get("/api/templates/..%2Fx/avatar.svg")).statusCode).toBe(400);
});
// agent-service.test.ts
test("summaries carry the template avatarVersion", async () => { /* seed agent of template with avatar.svg; list; expect avatarVersion string; delete file; list; null */ });
```

- [ ] **Step 2:** Run the three files → FAIL.
- [ ] **Step 3:** Implement. Route: `scanOne(name)` → 404 if undefined; `avatarStat(row.path)`; 404 if no version; `reply.header(...)` the four headers + `Cache-Control: private, max-age=31536000, immutable` + `ETag: "<version>"`; send `await readFile(...)`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(server): template avatar.svg with locked-down headers and avatarVersion on agents`.

### Task 5: Web: the factory-bot generator

Implements §5.1 (generator), DESIGN.md §16.1 (`avatar-ink`), §16.2 [PR1].

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/lib/factory-bot.ts`
- Modify: `apps/web/src/styles.css` (`--avatar-ink: var(--graphite-ink-value)` in both themes: use the light theme's `--foreground` oklch literal `oklch(0.2 0.008 255)` in both `:root` and the dark block; add `--color-avatar-ink` to `@theme inline`)
- Test: `apps/web/src/lib/factory-bot.test.ts`

**Interfaces:**
- Produces: `fnv1a32(s: string): number`; `type BotParts = { head: 0|1|2|3; eyes: 0..5; mouth: 0..3; accessory: 0..4; fill: 1..8 }`; `botParts(slug: string): BotParts`; `oklchToRelLuminance(l: number, c: number, h: number): number`; `contrast(a: number, b: number): number`.

- [ ] **Step 1: Failing tests**

```ts
test("fnv1a32 known vectors", () => {
  expect(fnv1a32("")).toBe(0x811c9dc5);
  expect(fnv1a32("a")).toBe(0xe40c292c);
});
test("botParts golden vectors (a change here must be deliberate)", () => {
  const slugs = ["lead", "dev", "reviewer", "dev-abcd", "a".repeat(40), "ceo", "qa", "pm", "designer", "ops-xyzw"];
  expect(Object.fromEntries(slugs.map((s) => [s, botParts(s)]))).toMatchInlineSnapshot();
});
test("parts stay in range", () => { for (const s of ["x", "lead", "z9"]) { const p = botParts(s); expect(p.fill).toBeGreaterThanOrEqual(1); expect(p.fill).toBeLessThanOrEqual(8); } });
test("avatar ink reaches 3:1 on every fill in both themes (computed from styles.css)", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const fills = [...css.matchAll(/--avatar-(\d):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g)];
  expect(fills.length).toBe(16); // 8 light + 8 dark
  const ink = oklchToRelLuminance(0.2, 0.008, 255);
  for (const [, , l, c, h] of fills) expect(contrast(oklchToRelLuminance(+l, +c, +h), ink)).toBeGreaterThanOrEqual(3);
});
```
(Run once with an empty `toMatchInlineSnapshot()` to record the golden vectors, inspect them for spread across fills, then keep them.)

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: FNV-1a (`h ^= code; h = Math.imul(h, 0x01000193) >>> 0`); `botParts` takes `h` and peels fields with `% count` then `Math.floor(h / count)`; OKLCH→linear sRGB→relative luminance (standard OKLab matrices); `contrast = (max+0.05)/(min+0.05)`. If the regex finds fills in a different shape in `styles.css`, adapt the regex to the file, not the values.
- [ ] **Step 4:** Run → PASS. Record the 16-row contrast table in the PR body (Task 17).
- [ ] **Step 5:** Commit `feat(web): deterministic factory-bot avatar generator`.

### Task 6: Web: `AgentAvatar` and the status badge shapes

Implements §5.1 (drawing, override, badge), §16.5 Avatars [PR1]. Builds on `.of-tooth` (`styles.css:272`), `StatusBadge` (`features/session/status-badge.tsx`).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/components/agent-avatar.tsx`
- Modify: `apps/web/src/features/session/status-badge.tsx` (use `StatusMark` for the leading glyph)
- Modify: `apps/web/src/styles.css` (`.of-avatar-cut` mask rule)
- Test: `apps/web/src/components/agent-avatar.test.tsx`, `apps/web/src/features/session/status-badge.test.tsx`

**Interfaces:**
- Produces:
  - `StatusMark({ status, size }: { status: AgentStatus; size: 4 | 6 }): JSX.Element | null` — `working` tooth, `errored` alert glyph (lucide `CircleAlert` filled, `text-destructive`), `rate_limited` filled dot (`bg-warning`), `queued` hollow ring (`border-[1.5px]` in the queued status colour), else `null`; carries `data-status-mark={status}`.
  - `AgentAvatar = memo(({ slug, template, avatarVersion, size, status }: { slug: string; template?: string; avatarVersion?: string | null; size: 16|20|24; status?: AgentStatus }) => …)` renders `<span aria-hidden className="relative inline-block shrink-0" style={{ width: size, height: size }}>` with `BotSvg`, the optional `<img>` overlay, and the badge in a mask hole.

- [ ] **Step 1: Failing tests**

```tsx
test("draws the generated face, aria-hidden", () => {
  const { container } = render(<AgentAvatar slug="lead" size={20} />);
  expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  expect(container.querySelector("svg")).not.toBeNull();
});
test("template override lies over the face and hides on error; a new version retries", () => {
  const { container, rerender } = render(<AgentAvatar slug="a" template="dev" avatarVersion="1-6" size={20} />);
  const img = container.querySelector("img")!;
  expect(img.getAttribute("src")).toBe("/api/templates/dev/avatar.svg?v=1-6");
  fireEvent.error(img);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
  rerender(<AgentAvatar slug="a" template="dev" avatarVersion="2-6" size={20} />);
  expect(container.querySelector("img")).not.toBeNull();
});
test.each([["working","working"],["errored","errored"],["rate_limited","rate_limited"],["queued","queued"]])(
  "badge shape for %s", (s) => {
    const { container } = render(<AgentAvatar slug="a" size={20} status={s as AgentStatus} />);
    expect(container.querySelector(`[data-status-mark="${s}"]`)).not.toBeNull();
  });
test.each(["idle","hibernated","terminated"])("no badge at rest: %s", (s) => {
  const { container } = render(<AgentAvatar slug="a" size={20} status={s as AgentStatus} />);
  expect(container.querySelector("[data-status-mark]")).toBeNull();
});
// status-badge.test.tsx: StatusBadge for errored renders [data-status-mark="errored"] and still its label.
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. `BotSvg` uses `useMemo(() => botParts(slug), [slug])`, draws in `viewBox="0 0 24 24"`, head `fill="var(--avatar-N)"`, features `fill="var(--avatar-ink)"`, `stroke="var(--border)"` 1px; the flat-topped hex is `points="6,3 18,3 23,12 18,21 6,21 1,12"`. The `<img>` sits `absolute inset-0 size-full object-contain rounded-full bg-card` and is keyed on `src` with a local `failed` state reset by the key. Badge: when a mark renders, the avatar wrapper gets `of-avatar-cut` whose CSS mask is `radial-gradient(circle at calc(100% - var(--mark)/2) calc(100% - var(--mark)/2), transparent calc(var(--mark)/2 + 2px), #000 calc(var(--mark)/2 + 2px))`, and the mark is positioned bottom-right outside the masked layer. Dots: `transition-[background-color] duration-150`; no animation on shapes.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(web): AgentAvatar with status badge shapes shared with StatusBadge`.

### Task 7: Web: `AgentChip`, `PrincipalChip`, truncation tooltip

Implements §5.1 (chip). Builds on `AgentName` (`features/agents/agent-tree.tsx:55-72`), `MiddleTruncate` (`components/middle-truncate.tsx`), `Tooltip` (`components/ui/tooltip.tsx`), `agentsListQueryOptions` (`features/session/api.ts:21`).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/components/agent-chip.tsx`
- Create: `apps/web/src/features/agents/use-agent-index.ts` (`useAgentIndex`, `useAgent(slug)`; see Task 9 for the frame side)
- Test: `apps/web/src/components/agent-chip.test.tsx`

**Interfaces:**
- Produces:
  - `type AgentChipAgent = Pick<AgentSummary, "slug"|"displayName"|"template"|"status"|"kind"|"avatarVersion">`
  - `AgentChip(props: ({ agent: AgentChipAgent } | { slug: string; name?: string }) & { size?: 16|20|24; showSlug?: boolean; badge?: boolean; className?: string })`
  - `PrincipalChip({ principal, size }: { principal: { kind: "agent"; slug: string } | { kind: "user"; handle: string }; size?: 16|20|24 })`
  - `TruncTooltip({ text, children })`: wraps a single truncating element; opens the shared Radix tooltip only when `el.scrollWidth > el.clientWidth` at pointer-enter or focus.
  - `useAgentIndex(): Map<string, AgentSummary>` (live) and `useEndedIndex()`; `useAgent(slug): AgentSummary | undefined`.

- [ ] **Step 1: Failing tests**

```tsx
test("agent form shows avatar, name and @slug; no native title", () => { /* render with { agent }, showSlug; expect name, '@lead', no [title] */ });
test("slug form resolves from the live list cache", () => { /* seed queryClient ["agents","exclude"] with lead; render { slug: 'lead' } → displayName */ });
test("slug form falls back to @slug when unknown", () => { /* render { slug: 'ghost' } → '@ghost' */ });
test("a human principal renders the handle without an avatar", () => {
  const { container } = renderInRouter(<PrincipalChip principal={{ kind: "user", handle: "or" }} />);
  expect(screen.getByText("@or")).toBeInTheDocument();
  expect(container.querySelector("svg")).toBeNull();
});
test("tooltip only when truncated", async () => { /* mock scrollWidth > clientWidth on the name span; hover; expect role=tooltip with full name; with equal widths, none */ });
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. `useAgentIndex` = `useQuery({ ...agentsListQueryOptions("exclude"), select: indexOf })` where `const cache = new WeakMap<AgentSummary[], Map<string, AgentSummary>>(); const indexOf = (l) => cache.get(l) ?? (cache.set(l, new Map(l.map((a) => [a.slug, a]))), cache.get(l)!)` at module scope (stable `select`). `useAgent(slug)` = same query with `select: useCallback((l) => indexOf(l).get(slug), [slug])`. Chip layout: `inline-flex min-w-0 items-center gap-1.5`; name `min-w-[min(8rem,45%)] truncate` via `AgentName`; slug `MiddleTruncate` `min-w-24 font-mono text-muted-foreground`; `@container` + `@max-[24rem]:flex-col @max-[24rem]:items-start` for the two-line form.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(web): AgentChip and PrincipalChip`.

### Task 8: Web: prefs, breakpoints, timing

Implements §5.4, §5.5. Builds on `hooks/use-mobile.ts` (cached `MediaQueryList`), `lib/theme.ts` (storage sync pattern).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/lib/prefs.ts`, `apps/web/src/lib/breakpoints.ts`, `apps/web/src/lib/timing.ts`
- Test: `apps/web/src/lib/prefs.test.tsx`, `apps/web/src/lib/breakpoints.test.tsx`

**Interfaces:**
- Produces: `usePref<T>(key: string, fallback: T, parse: (raw: string) => T | undefined, serialize?: (v: T) => string): [T, (v: T) => void]`; `MOBILE`, `WIDE`, `XWIDE` strings; `useMedia(query: string): boolean`; `INBOX_DWELL_MS = 1000`.

- [ ] **Step 1: Failing tests**

```tsx
test("usePref reads, writes and follows other tabs", () => {
  const { result } = renderHook(() => usePref("of-x", false, (r) => r === "1", (v) => (v ? "1" : "0")));
  expect(result.current[0]).toBe(false);
  act(() => result.current[1](true));
  expect(localStorage.getItem("of-x")).toBe("1");
  act(() => { localStorage.setItem("of-x", "0"); window.dispatchEvent(new StorageEvent("storage", { key: "of-x" })); });
  expect(result.current[0]).toBe(false);
});
test("usePref survives a throwing localStorage", () => { /* vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error()}); fallback returned */ });
test("useMedia follows the fake matchMedia", () => { /* use test/fake-match-media.ts at 1279 then 1280 for XWIDE */ });
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `useSyncExternalStore` (subscribe to `storage` + an in-module listener set notified on our own writes; `getSnapshot` reads the raw string so React compares strings). `useMedia` mirrors `use-mobile.ts`'s cache keyed by `window.matchMedia` identity and query.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(web): per-browser prefs and rem breakpoints`.

### Task 9: Web: shell-level, coalesced agent status frames

Implements §5.3. Builds on `useAgentStatusFrames` (`features/session/use-agent-status.ts`), `AppLayout` (`routes/_app.tsx`), the rAF/hidden-timeout pattern in `features/session/use-session.ts:158-171`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/features/session/use-agent-status.ts` (queue + flush)
- Modify: `apps/web/src/routes/_app.tsx` (mount once)
- Modify: remove calls in `features/session/session-view.tsx:43`, `features/agents/home-agents.tsx`, `routes/_app/agents.index.tsx`, `routes/_app/agents.$slug_.edit.tsx`, `features/settings/factory-section.tsx`
- Test: `apps/web/src/test/use-agent-status.test.tsx` (extend), `apps/web/src/test/ws-hub.test.tsx`

**Interfaces:**
- Produces: `applyStatusFrames(qc: QueryClient, frames: WsMessage[]): void` (exported for tests); `useAgentStatusFrames()` unchanged signature.

- [ ] **Step 1: Failing tests**

```ts
test("frames in one frame coalesce: one list write, last frame per slug wins", () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
  const spy = vi.spyOn(qc, "setQueriesData");
  push(frame("ada", "working")); push(frame("ada", "idle")); push(frame("bob", "working"));
  expect(spy).not.toHaveBeenCalled();
  vi.advanceTimersToNextFrame();
  expect(spy).toHaveBeenCalledTimes(1);
  expect(list().find((a) => a.slug === "ada")?.status).toBe("idle");
});
test("unchanged agents keep their object identity", () => { /* before = list()[1]; push frame for list()[0]; flush; expect(list()[1]).toBe(before) */ });
test("entering terminated is computed against the state before the batch", () => { /* working→terminated in one batch invalidates ["agents"] once */ });
test("supervisor frame sets the running count", () => {});
test("mounted once: the session view no longer subscribes", () => { /* renderApp('/agents/ada') and count ws.listen registrations for agent_status = 1 */ });
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Move the per-frame body into `applyStatusFrames`: fold frames into `Map<slug, patch>` (last wins), compute `enters` per slug against `getQueriesData` before writing, one `setQueriesData` over `["agents"]` mapping only matching slugs, one `setQueryData(["agent", slug])` per cached detail (invalidate uncached), newest `supervisor` sets `runningQueryKey`. The hook queues frames in a ref and flushes with `requestAnimationFrame` (`setTimeout(…,100)` while `document.hidden`), cancelling on unmount. Mount in `AppLayout`; delete the five page calls.
- [ ] **Step 4:** Run the two files plus `pnpm vitest run apps/web/src/test/session-view.test.tsx apps/web/src/test/agents-list.test.tsx` → PASS (adjust tests that relied on a synchronous patch to advance one frame).
- [ ] **Step 5:** Commit `refactor(web): fold agent status frames once in the shell, one write per frame`.

### Task 10: Web: inbox cache keeps `byAgent`; read-from client

Implements §15.1 (web). Builds on `features/inbox/api.ts` (`unreadCountQueryOptions`, `useInboxCache().setRead`, `useOpenItem`).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/features/inbox/api.ts`
- Test: `apps/web/src/features/inbox/inbox-read.test.tsx` (extend)

**Interfaces:**
- Produces: `type Unread = { count: number; byAgent: Record<string, number> }`; `useUnreadCount()` (still selects `count`); `useUnreadByAgent(slug: string): number`; `postReadFrom(slug: string, upTo: string)`; `useInboxCache().setRead(ids, read, delta, items?: InboxItem[])` decrements `byAgent[from.name]` for items with `kind==="message" && from.kind==="agent"`; `useInboxCache().readFrom(slug: string)` flips cached rows of that sender to read and zeroes `byAgent[slug]`, adjusting `count`.

- [ ] **Step 1: Failing tests**

```ts
test("opening a row keeps byAgent and decrements its sender", () => { /* seed ["inbox-unread"] {count:3, byAgent:{ada:2}}; open an unread message from ada; expect {count:2, byAgent:{ada:1}} */ });
test("mark all read leaves byAgent for the refetch", () => { /* setRead(all, true, -3) without items → byAgent unchanged */ });
test("readFrom flips that sender's cached rows and zeroes its count", () => {});
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (spread the previous value: `(c) => c && { ...c, count: Math.max(0, c.count + delta), byAgent: next }`). **Step 4:** PASS. **Step 5:** Commit `feat(web): unread per agent in the inbox cache`.

### Task 11: Web: tree model (pure)

Implements §6.2, §6.3 (counts), §6.6 (rail). Builds on `treeOrder` (`packages/shared/src/tree.ts`).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/agents/tree-model.ts`
- Test: `apps/web/src/features/agents/tree-model.test.ts`

**Interfaces:**
- Produces:
  - `type TreeNode = { slug: string; level: number; parent: string | null; hasChildren: boolean }`
  - `buildTree(rows: { slug; displayName; reportsTo }[]): TreeNode[]` (tree order via `treeOrder`)
  - `isExpanded(node, stored: Record<string, boolean>, revealed: ReadonlySet<string>): boolean` — default `node.level === 0`; `stored[slug]` overrides; `revealed` forces open
  - `visibleNodes(nodes, stored, revealed): TreeNode[]`
  - `ancestorsOf(nodes, slug): string[]`
  - `workingCounts(nodes, statusOf: (slug) => AgentStatus | undefined, expanded: (slug) => boolean): Map<string, number>` — only for collapsed nodes with children; counts working descendants at any depth
  - `railSlugs(nodes, { active, unread: (slug)=>number, statusOf }): string[]` — active, unread>0, or status in working/queued/rate_limited/errored; tree order
  - `INDENT_PX = 8`, `MAX_INDENT_LEVEL = 4`, `indentOf(level) = Math.min(level, 4) * 8`
  - `pruneStored(stored, liveSlugs: Set<string>)`

- [ ] **Step 1: Failing tests**

```ts
const rows = [
  { slug: "a", displayName: "A", reportsTo: null },
  { slug: "b", displayName: "B", reportsTo: "a" },
  { slug: "c", displayName: "C", reportsTo: "b" },
  { slug: "s", displayName: "S · ab12", reportsTo: "b" },
];
test("roots open, the rest closed; stored toggles override; revealed forces open", () => {
  const n = buildTree(rows);
  expect(visibleNodes(n, {}, new Set()).map((x) => x.slug)).toEqual(["a", "b"]);
  expect(visibleNodes(n, { b: true }, new Set()).map((x) => x.slug)).toEqual(["a", "b", "c", "s"]);
  expect(visibleNodes(n, { a: false }, new Set(["a"])).map((x) => x.slug)).toEqual(["a", "b"]);
});
test("working count on collapsed managers counts all working descendants", () => {
  const n = buildTree(rows);
  const status = (s: string) => (s === "c" || s === "s" ? "working" : "idle") as AgentStatus;
  const m = workingCounts(n, status, (s) => isExpanded(n.find((x) => x.slug === s)!, {}, new Set()));
  expect(m.get("b")).toBe(2);
  expect(m.has("a")).toBe(false); // a is expanded
});
test("indent stops at level 4", () => expect([0, 4, 9].map(indentOf)).toEqual([0, 32, 32]));
test("rail keeps active, unread and badge-worthy agents in tree order", () => {});
test("ancestorsOf", () => expect(ancestorsOf(buildTree(rows), "c")).toEqual(["a", "b"]));
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): sidebar tree model`.

### Task 12: Web: the sidebar agent tree component

Implements §6.2–§6.5, §6.7. Builds on Tasks 6, 7, 8, 10, 11; `SidebarMenu*` (`components/ui/sidebar.tsx`); `useSidebar`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/agents/sidebar-tree.tsx`
- Test: `apps/web/src/test/sidebar-tree.test.tsx`

**Interfaces:**
- Consumes: `useAgent`, `useAgentIndex`, `useUnreadByAgent`, `usePref`, `buildTree`/`visibleNodes`/`workingCounts`/`ancestorsOf`/`indentOf`.
- Produces: `SidebarAgentTree({ activeSlug, collapsedRail }: { activeSlug?: string; collapsedRail: boolean })`; `SidebarAgentRow = memo(...)` with `data-agent-row={slug}`; `useAgentTreeShape(): TreeNode[]` (select builds a key string `slug|displayName|reportsTo` joined; `useMemo` on that key).

- [ ] **Step 1: Failing tests** (render inside `SidebarProvider` with a seeded query client; fixtures A→B→C, S under B):

```tsx
test("A open, B collapsed with a working count named '1 working'", () => {
  expect(screen.getByRole("treeitem", { name: /A/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("treeitem", { name: /B/ })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("1 working", { selector: ".sr-only" })).toBeInTheDocument();
});
test("chevron click toggles without navigating", async () => { /* click [data-chevron] of B; C appears; router location unchanged */ });
test("toggle persists; revealed ancestors don't", () => { /* activeSlug='c' reveals A,B; localStorage of-tree-expanded unchanged; user toggle B writes {b:true} */ });
test("APG keys: one tab stop, ↓/↑, →/← open/close and move, Home/End, Enter navigates", async () => {});
test("an agent_status frame for C re-renders C's row only (B expanded) / B's row only (B collapsed)", () => {
  /* vi.mock a render counter around SidebarAgentRow via a test-only onRender prop or React Profiler; push one frame via applyStatusFrames; assert counts */
});
test("unread count from byAgent, working count hides first when narrow", () => {});
test("empty: 'No agents yet.' with New agent link; loading: three skeleton rows", () => {});
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement per §6.3: row `<a role="treeitem" aria-level aria-expanded aria-current tabIndex={tabbable?0:-1}>` in `<li role="none">`; padding-left `indentOf(level)`; chevron `<span data-chevron aria-hidden className="relative … after:absolute after:inset-y-[-8px] after:-inset-x-1">` with `onPointerDown={(e)=>e.preventDefault()}` and `onClick={(e)=>{e.preventDefault();e.stopPropagation(); toggle(slug, "pointer")}}`; rotation class `data-[toggled=pointer]:transition-transform duration-150 ease-(--ease-out) motion-reduce:transition-none`, `data-toggled` set only for pointer toggles (cleared on the next keyboard toggle). Name `min-w-16 truncate` inside `TruncTooltip` (tooltip text "Name · reports to Manager" past level 4). End slot: working count `<span className="inline-flex items-center gap-0.5 text-[0.8125rem] tabular-nums text-muted-foreground"><span className="of-tooth scale-75"/>{n}<span className="sr-only"> working</span></span>` and unread `<span className="tabular-nums …">{n>99?"99+":n}</span>`; the end slot is `flex shrink-0` and the working count has `max-[...]` hiding via a container query on the row (`@container` on the row, `@max-[12rem]:hidden` on the working count). Roving focus: keep `focusSlug` state; key handler on the `ul` per APG; typeahead on first letter of display name. Reveal: on `activeSlug` change, `revealed = new Set(ancestorsOf(...))` (state, not pref) and `requestAnimationFrame(() => row?.scrollIntoView({ block: "nearest" }))`. Write `pruneStored(...)` on each user toggle.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(web): live agents as the reporting tree in the sidebar`.

### Task 13: Web: `AppSidebar` restructure (merged Agents row, rail, active rule)

Implements §6.1, §6.6; DESIGN.md §16.4 [PR1]. Builds on `components/app-sidebar.tsx` (nav array `:53-60`, `isActive`), Task 12.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/components/app-sidebar.tsx`
- Test: `apps/web/src/test/shell.test.tsx` (extend)

- [ ] **Step 1: Failing tests**

```tsx
test("nav order: Inbox, Tasks, Templates, Schedules, Settings, then the Agents row heading the tree", () => {});
test("on a live agent's session the Agents row is not active and the agent row is", () => {});
test("on an ended agent's session the Agents row is active", () => { /* agent not in live list */ });
test("Agents row: label links /agents, chevron collapses the whole tree (of-tree-collapsed), + links /agents/new", () => {});
test("collapsed rail: nav icons, a rule, Agents icon, then only active/unread/badge-worthy avatars; tooltip 'Name · @slug · Status'", () => {});
test("mobile drawer: tapping an agent closes the drawer", () => {});
test("footer name and handle get a tooltip when truncated", () => {});
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement: nav array without Agents; `SidebarContent` becomes `flex min-h-0 flex-col`: nav group (shrink-0), then a group `min-h-0 flex-1 overflow-y-auto` whose first child is the sticky Agents row (`sticky top-0 z-10 bg-sidebar`), then `SidebarAgentTree`. `activeSlug` from `useRouterState({ select: (s) => matchSession(s.location.pathname) })` where `matchSession` returns the slug only for exactly `/agents/$slug`; Agents row active = `isActive(pathname,"/agents") && !(activeSlug && liveIndex.has(activeSlug))`. Rail via `collapsedRail = state === "collapsed"` from `useSidebar()`.
- [ ] **Step 4:** PASS (fix `shell.test.tsx` expectations that assumed Agents second).
- [ ] **Step 5:** Commit `feat(web): Agents row heads the sidebar tree; rail shows what needs a glance`.

### Task 14: Web: session view marks the agent's messages read

Implements §15.1 (session effect), spec §2.3. Builds on Task 10, `SessionView` (`features/session/session-view.tsx`), `useSession` (`state.events`/rows newest time).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/session/use-read-from.ts`
- Modify: `apps/web/src/features/session/session-view.tsx` (call it)
- Test: `apps/web/src/test/read-from.test.tsx`

**Interfaces:**
- Produces: `useReadFrom(slug: string, newestEventAt: string | undefined): void`.

- [ ] **Step 1: Failing tests**

```tsx
test("visible session with unread messages calls read-from once with upTo = newest event time", async () => {});
test("re-runs when the newest event advances while the count stays > 0; at most one in flight, ≤1/s", async () => { /* fake timers */ });
test("hidden document: no call until visible", async () => { /* Object.defineProperty(document,'visibilityState',{value:'hidden'}) then dispatch visibilitychange */ });
test("a hover preload of /agents/ada never calls read-from", async () => { /* renderApp('/'), router.preloadRoute({to:'/agents/$slug',params:{slug:'ada'}}), expect no POST */ });
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement with `useUnreadByAgent(slug)`, `useInboxCache().readFrom` (optimistic), `postReadFrom`, a ref for in-flight + last `upTo`, a trailing 1s throttle, a `visibilitychange` listener; never from a loader. **Step 4:** PASS. **Step 5:** Commit `feat(web): viewing a session clears that agent's unread messages`.

### Task 15: Web: Agents page polish

Implements §7. Builds on `features/agents/agent-tree.tsx` (`AgentTree`, `:116-200`).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/features/agents/agent-tree.tsx`
- Test: `apps/web/src/test/agents-tree.test.tsx` (extend)

- [ ] **Step 1: Failing tests**

```tsx
test("row starts with AgentChip (avatar, name, @slug)", () => {});
test("template shown only when it differs from the slug stem", () => { /* slug dev-abcd template dev → hidden; slug lead template ceo → 'ceo' */ });
test("'Unsandboxed' only for local runtime; Docker never shown", () => {});
test("continuous tree lines: one line element per ancestor level with later siblings", () => { /* querySelectorAll('[data-tree-line]') counts per row */ });
test("rows deeper than the cap show a depth marker '└ 12'", () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement (`slugStem = (s) => s.replace(/-[a-z0-9]{4}$/, "")`; lines: compute per row `continues: boolean[]` per level from the ordered list; render `<span data-tree-line className="absolute top-0 bottom-0 w-px bg-border" style={{ left }}/>` for each continuing ancestor level ≤ cap, plus an elbow; cap 8 desktop, 3 below md via `useIsMobile()`). **Step 4:** PASS. **Step 5:** Commit `feat(web): Agents page shows identity first with continuous tree lines`.

### Task 16: Web: `AgentChip` on task assignee and creator

Implements §5.1 (call sites), Q20. Builds on `features/tasks/task-list.tsx`, `task-detail.tsx` (assignee/creator display), `TaskAgentRef`/`TaskPrincipal` (`packages/shared/src/tasks.ts:141-147`).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/features/tasks/task-list.tsx`, `apps/web/src/features/tasks/task-detail.tsx`, `apps/web/src/features/tasks/comment-block.tsx` (author)
- Test: `apps/web/src/features/tasks/task-list.test.tsx`, `apps/web/src/features/tasks/task-detail.test.tsx`

- [ ] **Step 1:** Failing tests: the list row's assignee renders an avatar `svg` and the display name; a human creator/comment author renders `@handle` and no `svg`; an ended assignee keeps its "ended" mark.
- [ ] **Step 2:** FAIL. **Step 3:** Replace the text renderings with `AgentChip` (slug form, `size={20}`) and `PrincipalChip`. **Step 4:** PASS. **Step 5:** Commit `feat(web): agents shown with their avatar on tasks`.

### Task 17: PR1 docs, verify and open

Implements DESIGN.md §16.1 (`avatar-ink`, `sidebar.width` 256px, Layout "256px sidebar"), §16.2, §16.4, §16.5 Avatars [PR1]; behavior docs §17 `general.md` (navigation, agents tree part) and `inbox.md` (agent rows show unread messages; opening a session marks that agent's messages read).

- [ ] **Step 1:** Apply the §16 [PR1] text to `DESIGN.md` exactly as the spec quotes it (front matter: add `avatar-ink`, fix `sidebar.width: "256px"`; Layout "240px" → "256px"; §16.2 replace + append; §16.4 replace the Navigation bullet; §16.5 add the Avatars bullet). Commit `docs: DESIGN.md avatars and the sidebar agent tree`.
- [ ] **Step 2:** Edit the behavior docs in the main checkout (`/Users/orlevi/projects/open-factory/docs/product/behavior/general.md`, `inbox.md`) with the PR1 parts of spec §17. Not committed (gitignored); copy the edited sentences into the PR body.
- [ ] **Step 3:** Verify: `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build`. All green.
- [ ] **Step 4:** Manual evidence (spec §2.13, PR1 rows), recorded in the PR body with screenshots: the 214-agent break-ui dataset (`/Users/orlevi/.claude/jobs/7530b76c/tmp/break-ui/seed-worst.mjs` against a clone DB) in the sidebar: scroll, expand, a status storm under 4× CPU throttling (Performance recording; if a frame over 16ms is attributable to the tree, comment the recording on #91, else close #91 with it); a collapsed manager at depth 4 with working and unread counts; an active working row; the rail with 214 agents; avatars at 16/20/24 in both themes with the 16-row contrast table from Task 5; a template `avatar.svg` override.
- [ ] **Step 5:** Push and open the PR: `git push -u origin u2/1-sidebar-agents && gh pr create --base u1/5-perceived-speed --title "feat: agent avatars and agents in the sidebar" --body-file <body>` following `.github/pull_request_template.md` (What, Why, Approach "<decision>, rather than <alternative>, because <reason>", Changes by area; template comments removed), linking the spec and #89, listing the behavior-doc edits, and noting "Stacked on #88; retarget to main after the U1 stack merges." End the body with the Claude Code attribution line.

---

# PR 2 — `u2/2-agent-details`: Agent details panel and a one-line session header

`git checkout -b u2/2-agent-details` from `u2/1-sidebar-agents`.

### Task 18: Web: `Sheet` peek mode (`modal`, `width`, `inset`, closing keys)

Implements §5.2; DESIGN.md §16.6 (peek row and sentence [PR2]), §16.7 Elevation [PR2]. Builds on `components/ui/sheet.tsx` (`Sheet`, `SheetContent`, `useStampedRef`), `lib/input-modality.ts` (`stampInstant`).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/components/ui/sheet.tsx`
- Test: `apps/web/src/components/ui/sheet.test.tsx` (extend)

**Interfaces:**
- Produces: `Sheet({ open, onOpenChange, modal = true, children })`; `SheetContent({ width = "sheet" | "panel", inset = "full" | "below-header", returnFocus?: () => HTMLElement | null, keepFocus?: boolean, ... })`; `closeInstantly(contentEl)` helper: stamps `data-instant` before `onOpenChange(false)`.

- [ ] **Step 1: Failing tests**

```tsx
test("modal={false}: no overlay, no aria-modal, outside click keeps it open, Esc closes", async () => {});
test("Esc close is instant (data-instant stamped on the content before closing)", async () => {});
test("keepFocus: opening leaves focus where it was; returnFocus decides where focus goes on close", async () => {});
test("width='panel' and inset='below-header' classes", () => { /* w-[min(20rem,100%)], top-12 bottom-0 */ });
test("below md it is still the modal bottom drawer", () => {});
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement: pass `modal` to `SheetPrimitive.Root`; render the Overlay only when `modal`; when not modal, `onInteractOutside={(e)=>e.preventDefault()}` and `onFocusOutside={(e)=>e.preventDefault()}`; `onOpenAutoFocus` prevented when `keepFocus`; `onCloseAutoFocus={(e)=>{ const t = returnFocus?.(); if (t) { e.preventDefault(); t.focus(); } }}`; `onEscapeKeyDown={(e)=>{ stampInstant-on-content }}` (set `data-instant` on the content node via the stamped ref). Width/inset class maps.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(web): non-modal peek sheets`.

### Task 19: Web: `Kbd` and the shortcut dispatcher with `]`

Implements §10.3 (dispatcher), §5.6 `Kbd`. Builds on `routes/_app.tsx` (`AppLayout`), `lib/prefs.ts`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/components/ui/kbd.tsx`, `apps/web/src/lib/shortcuts.ts`
- Modify: `apps/web/src/routes/_app.tsx` (`installShortcuts()` in an effect)
- Test: `apps/web/src/lib/shortcuts.test.ts`, `apps/web/src/components/ui/kbd.test.tsx`

**Interfaces:**
- Produces: `installShortcuts(win = window): () => void`; `useShortcut(key: string, handler: (e: KeyboardEvent) => void, opts?: { enabled?: boolean }): void` (keys: single characters, or `"g i"` sequences); `shouldIgnore(e: KeyboardEvent): boolean` (exported for tests); `SINGLE_KEYS_PREF = "of-single-keys"`; `Kbd({ keys }: { keys: string[] })` (maps `"Mod"` to ⌘ or Ctrl).

- [ ] **Step 1: Failing tests**

```ts
test.each([
  ["input", true], ["textarea", true], ["[contenteditable]", true],
  ["[role=menu] button", true], ["[role=listbox] div", true], ["[role=tree] a", true],
  ["body", false],
])("ignore inside %s → %s", (sel, ignored) => { /* build DOM, dispatch keydown 'c' on it, expect handler called = !ignored */ });
test("ignored with Ctrl/Meta, during IME, when defaultPrevented, or with a modal open", () => {});
test("Alt allowed when it produced the bound key (']' via Option)", () => { /* key ']' altKey true → fires */ });
test("'g i' within 1s fires; after 1s doesn't", () => { /* fake timers */ });
test("the off switch disables single keys", () => { localStorage.setItem("of-single-keys","off"); /* no fire */ });
test("latest registration wins and unregisters on unmount", () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement a module-level `Map<string, Set<handler>>` stack (last added wins); one `keydown` listener; `isComposing`; `document.querySelector('[aria-modal="true"],[role="alertdialog"]')`. **Step 4:** PASS. **Step 5:** Commit `feat(web): a small global shortcut layer`.

### Task 20: Web: `liveFact` and `LiveLine`

Implements §8.2 (live line). Builds on `AgentSummary` fields, `resetPhrase`/`formatResetTime` (`status-badge.tsx`, `format.ts`), terminated-strip copy (`terminated-strip.tsx`).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/session/live-line.tsx`
- Test: `apps/web/src/features/session/live-line.test.tsx`

**Interfaces:**
- Produces: `type LiveFact = { kind: "terminated"|"errored"|"queued"|"restart"|"waiting"|"crons"; text: string; title?: string }`; `liveFact(agent: AgentSummary, ctx: { slotsMax?: number; now: Date }): LiveFact | null`; `LiveLine({ fact }: { fact: LiveFact | null })` (`role="status"`, `min-w-[8rem] grow basis-0 truncate`, hidden below 640px).

- [ ] **Step 1: Failing tests** — a table test over priority: an agent that is terminated AND errored → terminated; errored + queued → errored; rate-limited only → `null` (the badge says it); queued with all slots → "All 8 slots are in use."; restartPending → "Restarts when idle"; waitingOn 2 tasks → "pnpm test · since 14:02 +1"; crons 2 → "Kept awake by 2 crons"; idle → null; times absolute (assert no "ago"/seconds).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): one live fact for the session header`.

### Task 21: Web: `AgentMenu`, controlled Compact, Stop crons owned by the session

Implements §8.4. Builds on `features/session/compact-popover.tsx`, `stop-crons-dialog.tsx`, `agent-strip.tsx:243,315` (`useStopCrons`, `CronsStopLayer`), `terminate-button.tsx`/`terminate-dialog.tsx`, `DropdownMenu`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/agents/agent-menu.tsx`
- Modify: `apps/web/src/features/session/compact-popover.tsx` (controlled `open`/`onOpenChange` + `anchor` ref via `PopoverAnchor`)
- Move: `useStopCrons` and `CronsStopLayer` out of `agent-strip.tsx` into `apps/web/src/features/session/stop-crons.tsx`
- Test: `apps/web/src/test/agent-menu.test.tsx`

**Interfaces:**
- Produces: `AgentMenu({ agent, context, stop, onOpenDetails, onTerminateStart, onTerminated, triggerClassName }: { agent: AgentSummary; context: "session"|"sidebar"; stop?: StopCrons; onOpenDetails?: () => void; ... })` rendering its own ⋯ trigger (ghost icon `MoreHorizontal`, `aria-label` "Actions for <name>"); `type StopCrons = ReturnType<typeof useStopCrons>`.

- [ ] **Step 1: Failing tests**

```tsx
test.each([
  ["session", ["Agent details", "Compact…", "Edit", "Usage", "Open tasks"]],
  ["sidebar", ["Open session", "Edit", "Usage", "Open tasks"]],
])("%s items for a live persistent agent", async (context, items) => {});
test("Terminate… only for a live spawned agent in the session, crimson with a separator, confirms", async () => {});
test("Stop crons… opens the confirmation with the panel closed", async () => {});
test("Compact… moves focus into the compact popover", async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement (Compact item: `onSelect` sets `compactOpen` on the next `requestAnimationFrame`; `DropdownMenuContent onCloseAutoFocus={(e)=> compactPending && e.preventDefault()}`; shortcut hint via `DropdownMenuShortcut` with `<Kbd keys={["]"]}/>`). **Step 4:** PASS. **Step 5:** Commit `feat(web): one agent menu for the session and the sidebar`.

### Task 22: Web: `AgentDetails` content

Implements §8.3. Builds on `agent-strip.tsx` segments (re-homed), `agentsUsageQuery("rolling7")`, schedules API (`features/schedules/api.ts`), Task 21's `StopCrons`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/session/agent-details.tsx`
- Modify: `apps/web/src/features/tasks/api.ts` (`agentTasksOptions(slug)`: key `["tasks", "agent", slug]`, `GET /api/tasks?status=open_in_progress&assignee=<slug>&limit=5`, `queryOptions` not infinite)
- Test: `apps/web/src/test/agent-details.test.tsx`

**Interfaces:**
- Produces: `AgentDetails({ agent, stop, usage, onClose? }: { agent: AgentSummary; stop: StopCrons; usage: AgentUsageRow | null | undefined; onClose?: () => void })`.

- [ ] **Step 1: Failing tests** — strip titled "Agent details"; `@slug` and description; Now lists every waiting task, crons with Stop crons, restart pending with Why, the terminated facts with Pin; Org shows manager and reports (`AgentChip`) with "All N reports" linking `/agents?focus=<slug>`; Work shows ≤5 tasks with "All N tasks" from `agent.openTasks` and ≤5 schedules with "All N schedules" from `agent.scheduleCount`; Usage shows the 7-day estimate and links `/agents/$slug/usage`; Runtime shows "Unsandboxed" only when local; "Edit agent" only for persistent, not archived; task/schedule queries don't fire until mounted.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): Agent details content`.

### Task 23: Web: `SessionView` layout, header and panel modes; strip removed

Implements §8.1 (layout and modes), §8.2; DESIGN.md §16.1 `panel`, §16.3 Agent details [PR2], §16.7 Cards and panels [PR2], §16.8 [PR2]. Builds on `session-view.tsx` (header `:107-141`, strip `:142-151`), `PageHeader`, Tasks 18–22.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/features/session/session-view.tsx`
- Create (inside `agent-details.tsx`): `useAgentDetailsPanel(slug): { open: boolean; toggle: () => void; mode: "inflow" | "overlay" | "drawer" }`
- Delete: `apps/web/src/features/session/agent-strip.tsx`, `agent-strip.test.tsx` (move still-relevant assertions into `agent-details.test.tsx` / `live-line.test.tsx`), `terminated-strip.tsx` (pin logic moved into `live-line.tsx`'s `PinButton` and Agent details)
- Test: `apps/web/src/test/session-view.test.tsx` (extend), `apps/web/src/test/agent-details-modes.test.tsx`

- [ ] **Step 1: Failing tests**

```tsx
test.each([
  [1440, "inflow", true], [1280, "inflow", true], [1279, "inflow", false], [1024, "inflow", false],
  [1023, "overlay", false], [768, "overlay", false], [767, "drawer", false],
])("at %ipx the mode is %s, open by default = %s", (w, mode, open) => {});
test("≥1280 the choice is remembered (of-agent-details); 1024–1279 starts closed on every visit", () => {});
test("] and the header toggle open and close it at every width; aria-expanded follows", async () => {});
test("the overlay sits below the header: Stop and the toggle stay clickable", () => { /* class top-12 on sheet content */ });
test("header: avatar without badge, name, StatusBadge, one live fact, Pin outside the line, Stop only while turnOpen, Restart when errored, ⋯", () => {});
test("no strip: 'Reports to' no longer renders under the header", () => {});
test("switching agents keeps an open panel open (≥1024) and retargets the overlay in place", () => {});
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement: `SessionView` root `flex h-svh min-h-0` with the main column `flex min-w-0 flex-1 flex-col` and, in `inflow` mode when open, `<aside id="agent-details" aria-label="Agent details" className="w-80 shrink-0 border-l bg-card flex flex-col min-h-0">`; overlay mode renders `<Sheet modal={false} …><SheetContent width="panel" inset="below-header" keepFocus={false}>`; drawer mode the adaptive Sheet. Header: `heading` = `AgentChip`-less layout (`AgentAvatar size={24}` + `AgentName`), h1 class adds `max-w-[45%]`; `meta` = StatusBadge + `LiveLine`; actions = `PinButton` (terminated), `InterruptButton` (`turnOpen`), `RecoveryActions` (errored; its error text renders as a notice row below the header), the toggle, `AgentMenu context="session"`. `useShortcut("]", toggle)` while mounted. Persist only in `XWIDE`; reset `open` on slug change for non-XWIDE. Timeline and composer share `max-w-[52rem]` and the same `px-4 md:px-6`.
- [ ] **Step 4:** PASS (`pnpm vitest run apps/web/src/test/session-view.test.tsx apps/web/src/test/agent-details-modes.test.tsx apps/web/src/features/session`).
- [ ] **Step 5:** Commit `feat(web): Agent details panel replaces the strip; one-line session header`.

### Task 24: Web: timeline keeps its place on width changes

Implements §8.1 (scroll anchoring). Builds on `features/session/timeline.tsx` (`atBottom` ref `:39`, rows carry `data-row` `:196`).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/features/session/timeline.tsx`
- Test: `apps/web/src/test/timeline-anchor.test.tsx`

**Interfaces:**
- Produces: `Timeline` exposes `captureAnchor()` through an imperative handle used by the panel toggle (`useImperativeHandle`), or an exported `useTimelineAnchor(scrollerRef)` hook; pick one and use it from Task 23's toggle handler.

- [ ] **Step 1: Failing tests** (mock `ResizeObserver` and `document.elementFromPoint`, stub `getBoundingClientRect`):

```tsx
test("at the bottom, a width change keeps it pinned", () => {});
test("scrolled up, a width change restores the top row's offset by delta, synchronously in the RO callback", () => {
  /* anchor row top 100 → after resize the row reports 160 → scrollTop increased by 60 before any rAF */
});
test("atBottom is not recomputed in the RO callback", () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement: passive scroll listener throttled with rAF setting `anchor = { el: elementFromPoint(x, top+1)?.closest("[data-row]"), top }`; `ResizeObserver` on the scroller compares `contentRect.width` to the last width; pinned → `scrollTop = scrollHeight`, else delta. **Step 4:** PASS. **Step 5:** Commit `feat(web): timeline keeps its place when columns change width`.

### Task 25: Web: sidebar row ⋯ and the Agents page `?focus`

Implements §6.3 (⋯, Shift+F10), §8.3 ("All N reports" target). Builds on Task 12, Task 21, `routes/_app/agents.index.tsx` (search schema).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/features/agents/sidebar-tree.tsx`, `apps/web/src/routes/_app/agents.index.tsx`, `apps/web/src/features/agents/agent-tree.tsx`
- Test: `apps/web/src/test/sidebar-tree.test.tsx`, `apps/web/src/test/agents-list.test.tsx`

- [ ] **Step 1:** Failing tests: hovering a row (fine pointer) shows a ⋯ with `tabIndex=-1` replacing the counts; Shift+F10 on a focused row opens `AgentMenu` with sidebar items; right-click does not `preventDefault` (the browser menu stays); `/agents?focus=lead` scrolls the lead row into view and gives it the hover fill for that visit.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (`SidebarMenuAction` with `showOnHover`; `onKeyDown` Shift+F10 / `ContextMenu` key opens the menu's controlled `open`). **Step 4:** PASS. **Step 5:** Commit `feat(web): agent actions from the sidebar`.

### Task 26: PR2 docs, verify and open

Implements DESIGN.md §16.1 `panel`, §16.3 Agent details, §16.6 (peek row and sentence [PR2]), §16.7 (Elevation [PR2], Cards and panels [PR2]), §16.8 [PR2]; behavior docs §17 `agents-and-sessions.md`.

- [ ] **Step 1:** Apply the [PR2] text to DESIGN.md as quoted in spec §16. Commit `docs: DESIGN.md Agent details and peek sheets`.
- [ ] **Step 2:** Edit `/Users/orlevi/projects/open-factory/docs/product/behavior/agents-and-sessions.md` per §17 (PR2); copy the edits into the PR body.
- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- [ ] **Step 4:** Manual evidence (§2.13 PR2 rows): the panel at 767/768/1023/1024/1279/1280 with a running agent (Stop reachable, toggle visible); the header at 1280 with an 80-character name, errored, panel open; a 500-row timeline with the sidebar collapse and the panel toggle (Performance recording of the anchoring frames).
- [ ] **Step 5:** Push and `gh pr create --base u2/1-sidebar-agents` with the template, spec and #89 links, behavior-doc edits, and "Stacked on PR1; retarget after it merges".

---

# PR 3 — `u2/3-settings-usage`: Settings pages and a top-level Usage page

`git checkout -b u2/3-settings-usage` from `u2/2-agent-details`.

### Task 27: Web: Settings layout, sub-nav and per-section routes

Implements §9 (layout, children); DESIGN.md §16.3 Sub-navigation [PR3], §16.8 [PR3] clause. Builds on `routes/_app/settings.tsx` (loader `:45-57`, `SECTIONS`), `features/settings/*-section.tsx`, `SettingsSection` (`features/settings/shared.tsx`).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/routes/_app/settings.tsx` (layout + sub-nav + `<Outlet/>`; remove "On this page", hash plumbing, `hashchange`)
- Create: `apps/web/src/routes/_app/settings.credentials.tsx`, `settings.secrets.tsx` (`validateSearch: { addSecret?: string }`), `settings.projects.tsx`, `settings.users.tsx`, `settings.factory.tsx`
- Regenerate: `apps/web/src/routeTree.gen.ts` (the Vite plugin / `pnpm --filter @open-factory/web build` regenerates it; commit the result)
- Test: `apps/web/src/test/settings.test.tsx` (rewrite), `settings-users.test.tsx`, `settings-factory.test.tsx`

- [ ] **Step 1: Failing tests**

```tsx
test.each([
  ["/settings/credentials", ["GET /api/credentials"]],
  ["/settings/secrets", ["GET /api/secrets"]],
  ["/settings/projects", ["GET /api/projects"]],
  ["/settings/users", ["GET /api/users", "GET /api/invites"]],
  ["/settings/factory", ["GET /api/settings"]],
])("%s loads only its own queries", async (path, calls) => { /* mockApi().calls filtered to settings endpoints equals calls (use the real paths from features/settings/api.ts) */ });
test("sub-nav lists the five pages; the current one is aria-current with medium weight", () => {});
test("below a 40rem content width the sub-nav is a Section select", () => { /* container query: assert classes; select navigates */ });
test("/settings/secrets?addSecret=GH_TOKEN opens the add form with the name", () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): one page per Settings section`.

### Task 28: Web: top-level Usage page and its nav row

Implements §9 (`/usage`, "By credential", Usage nav row); spec §2.5 nav order. Builds on `features/settings/usage-section.tsx`, `features/usage/*`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/routes/_app/usage.tsx` (`validateSearch: { days: 7|30|90 = 30 }`, loader warms `dailyUsageQuery`, `agentsUsageQuery`, `credentialsUsageQuery`)
- Modify: `apps/web/src/features/settings/usage-section.tsx` (heading "By credential"; navigation to `/usage` with `days`)
- Modify: `apps/web/src/components/app-sidebar.tsx` (Usage row between Schedules and Settings, icon `ChartColumn`)
- Test: `apps/web/src/test/usage-page.test.tsx`, `apps/web/src/test/shell.test.tsx`

- [ ] **Step 1:** Failing tests: `/usage` renders "Usage", the range control changes `?days=`; the per-credential heading reads "By credential" and the app has one "Credentials" heading (on `/settings/credentials`); nav order Inbox, Tasks, Templates, Schedules, Usage, Settings, then Agents.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): Usage is a top-level page`.

### Task 29: Web: Settings redirects and link updates

Implements §9 (`settings.index`, links). 

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/routes/_app/settings.index.tsx` (`validateSearch: { addSecret?, days? }`, `beforeLoad` redirect with `replace: true` by `location.hash`)
- Modify: `features/agents/prerequisites.tsx:56`, `features/agents/agent-form.tsx:553,653`, `features/agents/project-grant-picker.tsx:45`, `features/session/timeline-row.tsx:230`
- Test: `apps/web/src/test/settings-redirects.test.tsx`

- [ ] **Step 1: Failing tests**

```tsx
test.each([
  ["/settings", "/settings/credentials"],
  ["/settings#secrets", "/settings/secrets"],
  ["/settings?addSecret=X#secrets", "/settings/secrets?addSecret=X"],
  ["/settings#usage", "/usage"],
  ["/settings?days=7", "/usage?days=7"],
  ["/settings#factory", "/settings/factory"],
])("%s → %s", async (from, to) => {});
test("in-app links point at the new routes", () => { /* render prerequisites with no credential: link href /settings/credentials */ });
```
(`/usage` exists from Task 28.)

- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): old Settings links redirect to the new pages`.

### Task 30: PR3 docs, verify and open

Implements DESIGN.md §16.3 Sub-navigation [PR3], §16.8 [PR3]; behavior docs §17 `administration.md` (Settings, Usage), `general.md` (nav).

- [ ] **Step 1:** DESIGN.md [PR3] text; commit `docs: DESIGN.md settings sub-navigation`.
- [ ] **Step 2:** Behavior docs in the main checkout; list them in the PR body.
- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- [ ] **Step 4:** Manual: Settings at 320 and at 800 with the sidebar open (select form), each section, old bookmarks.
- [ ] **Step 5:** Push and `gh pr create --base u2/2-agent-details` (template, spec, #89, docs, stacked note).

---

# PR 4 — `u2/4-palette`: command palette, shortcuts and searchable pickers

`git checkout -b u2/4-palette` from `u2/3-settings-usage`.

### Task 31: Server: task title search `q`

Implements §15.2. Builds on `listQuerySchema` (`apps/server/src/routes/tasks.ts:23-43`), `TaskReads.list` + `ListFilter` (`apps/server/src/tasks/task-reads.ts:23-80`).

**Files:**
- Modify: `apps/server/src/routes/tasks.ts`, `apps/server/src/tasks/task-reads.ts`
- Create: `apps/server/src/tasks/like.ts` (`escapeLike(s: string): string`)
- Test: `apps/server/src/tasks/like.test.ts`, `apps/server/src/tasks/task-store.test.ts` or the routes test that covers `GET /api/tasks` (find it with `grep -rln "GET\", url: \"/api/tasks" apps/server/src`)

- [ ] **Step 1: Failing tests**

```ts
test("escapeLike", () => expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b"));
test("q matches titles case-insensitively; % and _ are literal", async () => {
  // create tasks "Fix 100% CPU", "Fix 100x CPU", "snake_case", "snakeXcase"
  // q=100% → only "Fix 100% CPU"; q=snake_ → only "snake_case"; q=FIX → both Fix; status=all includes done tasks
});
test("q validates: empty → 400, over 200 chars → 400", async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Add `q: z.string().trim().min(1).max(200).optional()` to the schema, pass `{ q }` into `ListFilter`, and `where.push(sql\`${tasks.title} ilike ${"%" + escapeLike(f.q) + "%"} escape '\\'\`)`. **Step 4:** PASS. **Step 5:** Commit `feat(server): search tasks by title`.

### Task 32: Web: cmdk and the `Combobox` primitive

Implements §10.1, §10.4 (primitive); DESIGN.md §16.5 Combobox [PR4].

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/package.json`, `pnpm-lock.yaml` (`pnpm --filter @open-factory/web add --save-exact cmdk@1.1.1`)
- Create: `apps/web/src/components/ui/combobox.tsx`
- Modify: `apps/web/src/test/ui-contract-files.ts` (add the file if the contract lists primitives)
- Test: `apps/web/src/components/ui/combobox.test.tsx`

**Interfaces:**
- Produces: `type ComboOption = { value: string; label: string; keywords?: string[]; group?: string; disabled?: boolean; fixed?: boolean; render?: () => ReactNode }`; `Combobox({ value, onValueChange, options, placeholder, emptyText, "aria-label", renderValue?, triggerClassName? })`.

- [ ] **Step 1: Failing tests**

```tsx
test("arrows move the highlight but never commit; Enter commits; click commits", async () => {});
test("filters by label and keywords; fixed options stay while filtering", async () => {});
test("trigger looks like Select (same data-slot/classes contract as select trigger)", () => {});
test("popover width at least 24rem, side locked while open, list height fixed (h-72)", () => {});
test("keyboard-opened popover is stamped data-instant", async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement: `Popover` + `PopoverTrigger asChild` (Button styled like `SelectTrigger`) + `PopoverContent className="w-[max(var(--radix-popover-trigger-width),min(24rem,calc(100vw-2rem)))] p-0" align="start" avoidCollisions={!open-latched}` (lock: record `side` on first `onOpenAutoFocus` via the content's `data-side` and pass `side` + `avoidCollisions={false}` afterwards); `<Command filter={custom that returns 1 for fixed}>` with `CommandInput`, `CommandList className="h-72"`; no `--cmdk-list-height` transition. **Step 4:** PASS. **Step 5:** Commit `feat(web): searchable Combobox on cmdk`.

### Task 33: Web: `AgentCombobox` and the assigning pickers

Implements §10.4 (manager, assignee, New task, schedule target). Builds on `features/tasks/agent-picker.tsx` (`useAssignableAgents`, `AgentPicker`), `features/tasks/assignee-menu.tsx`, `features/agents/agent-form.tsx` (manager `Select`, U1 indent cap), `features/schedules/schedule-form.tsx` (target + `extraOption`), `features/tasks/task-form.tsx`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/agents/agent-combobox.tsx`
- Modify: the four files above
- Test: `apps/web/src/test/agent-form.test.tsx`, `apps/web/src/features/tasks/task-form.test.tsx`, `apps/web/src/features/tasks/task-detail.test.tsx`, `apps/web/src/features/schedules/schedule-form.test.tsx`, `apps/web/src/features/agents/agent-combobox.test.tsx`

**Interfaces:**
- Produces: `AgentCombobox({ value, onValueChange, scope, fixed, filter, "aria-label" }: { value: string | null; onValueChange(v: string | null): void; scope: "live" | "live+ended"; fixed?: ComboOption[]; filter?: (a: AgentSummary) => boolean })`.

- [ ] **Step 1:** Failing tests: typeahead by slug and by name finds the agent among 214 fixtures; assigning pickers list live agents only; the manager picker excludes spawned agents and keeps the indent cap; arrows don't change the task's assignee (no PATCH until Enter); an unknown value renders `@slug` with a face.
- [ ] **Step 2:** FAIL. **Step 3:** Implement and swap. **Step 4:** PASS. **Step 5:** Commit `feat(web): searchable agent pickers`.

### Task 34: Web: filter comboboxes and the time zone

Implements §10.4 (filters, time zone). Builds on `features/tasks/task-filters.tsx` (`:84-115`), `features/schedules/schedule-filters.tsx` (`:37-45`), `features/schedules/timezone-select.tsx` (`zoneGroups`), `components/native-select.tsx`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `task-filters.tsx`, `schedule-filters.tsx`, `timezone-select.tsx`
- Delete: `apps/web/src/components/native-select.tsx` (and its contract-test entry)
- Test: `apps/web/src/features/tasks/task-list.test.tsx`, `apps/web/src/features/schedules/schedule-list.test.tsx`, `apps/web/src/features/schedules/schedule-form.test.tsx`

- [ ] **Step 1:** Failing tests: assignee filter shows Anyone/Unassigned first plus live and an "Ended" group; creator filter Anyone/Me first and a URL `@handle` value renders as text; schedules target filter "Any agent" first plus Ended; time zone typeahead "new york" finds `America/New_York`, keeps UTC and the current value, keywords include the offset; `grep -rn NativeSelect apps/web/src` is empty (assert in `ui-contract.test.ts`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement (offsets computed lazily on first open with `Intl.DateTimeFormat(…, { timeZoneName: "shortOffset" })`). **Step 4:** PASS. **Step 5:** Commit `feat(web): searchable filters and time zone; no native selects`.

### Task 35: Web: palette ranking (pure)

Implements §10.2 (ranking, snapshot).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/palette/rank.ts`
- Test: `apps/web/src/features/palette/rank.test.ts`

**Interfaces:**
- Produces: `rankAgents(query: string, live: AgentSummary[], ended: AgentSummary[], recent: string[], treeOrder: string[]): { agent: AgentSummary; ended: boolean }[]`; `isTaskKey(q: string): boolean` (`/^t-\d+$/i`); `GO_TO`, `ACTIONS` static lists.

- [ ] **Step 1:** Failing tests: exact slug beats exact name beats prefix beats recent beats substring; ties in tree order; live before ended; empty query → recent first then nothing else from agents; 190 "Developer NNN" don't bury "ceo" for query "c" when ceo is recent or prefix.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): palette ranking`.

### Task 36: Web: the command palette and the Search row

Implements §10.2; DESIGN.md §16.5 Command palette [PR4], §16.6 palette ladder row and drawer-row append [PR4], §16.7 Elevation insert, Don'ts, Motion "never animates" [PR4]. Builds on `radix-ui` `Dialog`, cmdk `Command`, Task 35, `lookupTasks` (`features/tasks/api.ts:110`), `agentsListQueryOptions("only")`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/palette/command-palette.tsx` (+ `tasksSearchOptions(q)` in `features/tasks/api.ts`: key `["tasks","search",q]`, `GET /api/tasks?q=…&status=all&limit=20`)
- Modify: `apps/web/src/routes/_app.tsx` (mount `<CommandPalette/>`), `apps/web/src/components/app-sidebar.tsx` (Search button row above the nav)
- Test: `apps/web/src/test/command-palette.test.tsx`

**Interfaces:**
- Produces: `openPalette()` (module-level store) used by the Search row and `⌘K`; `CommandPalette()`.

- [ ] **Step 1: Failing tests**

```tsx
test("⌘K opens from inside an input; overlay and content carry data-instant; sr-only title 'Search'", async () => {});
test("'T-42' shows 'Open T-42' first at once; Enter navigates; title fills in without moving the highlight", async () => {});
test("title search fires once after 150ms debounce with status=all&limit=20; Tasks group is last; stale rows can't be committed", async () => {});
test("agents: live first, ended after with 'Ended'; Enter opens the session; ⇧Enter focuses the composer", async () => {});
test("Actions: no 'Mark all read'; 'Agent details' only on session pages", async () => {});
test("Go to includes Usage and each Settings page; Images links /templates#images", async () => {});
test("the Search row opens it and shows the platform key hint", async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement per §10.2 (eager import; window `keydown` for Mod+K handled before `shouldIgnore`; group order Agents, key row, Go to, Actions, Tasks; snapshot agent lists per query in a ref; ended list `useQuery({...agentsListQueryOptions("only"), enabled: open})` plus `qc.prefetchQuery` on open; below 48rem `top-2` and list `max-h-[40dvh]`). **Step 4:** PASS. **Step 5:** Commit `feat(web): ⌘K command palette`.

### Task 37: Web: go-to and `c` bindings, shortcuts sheet with off switch

Implements §10.3 (bindings except `j`/`k`, sheet); DESIGN.md §16.5 Keyboard shortcuts and Key hints [PR4], §16.8 `?` clause [PR4].

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/shortcuts/shortcuts-sheet.tsx`, `apps/web/src/features/shortcuts/global-shortcuts.tsx` (registers `g i/t/s/u/a`, `c`, `?`)
- Modify: `apps/web/src/routes/_app.tsx` (mount), `features/palette/command-palette.tsx` ("Keyboard shortcuts" action opens the sheet; "New task" action shared with `c` through `newTask(navigate)` in `features/tasks/actions.ts`)
- Test: `apps/web/src/test/global-shortcuts.test.tsx`

- [ ] **Step 1:** Failing tests: `g` then `t` within 1s goes to `/tasks`; `c` goes to `/tasks/new` (same function the palette calls); `?` opens a non-modal sheet "Keyboard shortcuts" listing Global / Session groups (no `j`/`k` yet); the "Single-key shortcuts" switch turns them off and persists; none fire in an input.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): go-to shortcuts and a shortcuts sheet`.

### Task 38: PR4 docs, verify and open

Implements DESIGN.md [PR4] clauses of §16.5, §16.6, §16.7, §16.8; behavior docs §17 `administration.md` Schedules (time zone), `tasks.md` [PR4], `general.md` (⌘K, `?`).

- [ ] **Step 1:** DESIGN.md [PR4] text; commit `docs: DESIGN.md palette, combobox and shortcuts`.
- [ ] **Step 2:** Behavior docs in the main checkout; list them in the PR body.
- [ ] **Step 3:** `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- [ ] **Step 4:** Manual: palette at 390 and 1440 (no animation, keys from the composer), comboboxes with 214 agents and the time zone list, a combobox inside a sheet.
- [ ] **Step 5:** Push and `gh pr create --base u2/3-settings-usage`; body says "Closes #83" plus template, spec, #89, docs, stacked note.

---

# PR 5 — `u2/5-inbox-pane`: inbox reading pane and task peek

`git checkout -b u2/5-inbox-pane` from `u2/4-palette`.

### Task 39: Server: `GET /api/inbox/:id`

Implements §15.4. Builds on `EventStore.inboxPage` row mapping (`event-store.ts:1164-1260`).

**Files:**
- Modify: `apps/server/src/agents/event-store.ts` (extract the row→`InboxEntry` mapping into a private `toEntries(rows)` used by `inboxPage` and a new `inboxItem(userId, id)`), `apps/server/src/routes/inbox.ts`
- Test: `apps/server/src/routes/inbox.test.ts`

- [ ] **Step 1:** Failing tests: own item → `{ item }` equal to the list's entry for that id; another user's id → 404; unknown → 404; `unread-count` and `read-all` routes still match (static segments win).
- [ ] **Step 2:** FAIL. **Step 3:** Implement (`params: z.object({ id: z.string().min(1).max(64) })`, response `inboxItemResponseSchema`). **Step 4:** PASS. **Step 5:** Commit `feat(server): read one inbox item`.

### Task 40: Web: selected rows, `runInstantOn`, `j`/`k` in lists

Implements §5.6 (`steel-selected`, `runInstantOn`), `j`/`k` bindings; DESIGN.md §16.1 selected tokens, §16.5 Selected rows [PR5], §16.8 [PR5] selection clause.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/styles.css` (`--selected` in `:root` ≈ `oklch(0.90 0.006 250)` and the dark block ≈ `oklch(0.31 0.008 255)`, `--color-selected` in `@theme inline`; `.of-row[aria-current="true"] { background-color: var(--selected) }` kept under `:hover`)
- Modify: `apps/web/src/lib/run-instant.ts` (`runInstantOn(el: HTMLElement, fn: () => void)`), `apps/web/src/lib/row-nav.ts` (`j`/`k` aliases when `shouldIgnore` is false; returns the new row)
- Modify: `apps/web/src/features/shortcuts/shortcuts-sheet.tsx` (Lists group: `j`/`k`, Enter, Space)
- Test: `apps/web/src/lib/run-instant.test.ts`, `apps/web/src/test/row-nav.test.tsx`

- [ ] **Step 1:** Failing tests: `runInstantOn` sets `data-instant` on that element only and clears it after two frames; `j`/`k` move focus like ↓/↑ in a row list; a selected row keeps `aria-current` styling class under hover (class contract).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): selected rows and j/k in lists`.

### Task 41: Web: inbox previews and the 380px row

Implements §11.1 (rows, `plainPreview`). Builds on `features/inbox/inbox-row.tsx` (`SenderLine`, `:10`, `:153-173`).

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/inbox/preview.ts`
- Modify: `apps/web/src/features/inbox/inbox-row.tsx`
- Test: `apps/web/src/features/inbox/preview.test.ts`, `apps/web/src/features/inbox/inbox-list.test.tsx`

- [ ] **Step 1: Failing tests**

```ts
test.each([
  ["```ts\nconst a = 1\n```\nDone", "const a = 1 Done"],
  ["**bold** and _it_ and `code`", "bold and it and code"],
  ["[the PR](https://x/y) is up", "the PR is up"],
  ["# Title\n- one\n- two", "Title one two"],
])("plainPreview(%j)", (md, out) => expect(plainPreview(md)).toBe(out));
// inbox-list: three lines; sender AgentChip (agent) or name (human/factory); time never truncated; read rows muted
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): plain inbox previews and a three-line row`.

### Task 42: Web: inbox two panes and selection rules

Implements §11.1 (layout, selection, dwell); DESIGN.md §16.3 Two panes [PR5]. Builds on `routes/_app/inbox.tsx`, `features/inbox/inbox-list.tsx`, `useOpenItem`, `INBOX_DWELL_MS`, `WIDE`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/routes/_app/inbox.tsx` (`validateSearch: { item?: string }`; two-pane at `WIDE`), `apps/web/src/features/inbox/inbox-list.tsx` (selection props)
- Create: `apps/web/src/features/inbox/inbox-pane.tsx` (shell only here: header from the row, skeleton body, "No item selected.")
- Test: `apps/web/src/test/inbox-pane.test.tsx`

- [ ] **Step 1: Failing tests**

```tsx
test("≥1024 plain click selects: push ?item=, marks read once, row aria-current", async () => {});
test("modifier-click and middle-click don't select (target opens), and mark read as today", async () => {});
test("j/k move the selection with replace; read only after INBOX_DWELL_MS", async () => { /* fake timers: k,j,j within 300ms → no POST; wait 1000 → one POST for the resting item */ });
test("a key-repeat sweep marks nothing read", async () => {});
test("↓/↑ move focus only (no ?item= change)", async () => {});
test("Enter selects (push) and marks read at once", async () => {});
test("<1024 rows navigate; ?item= is dropped", async () => {});
test("neighbours' pane data are prefetched on selection", async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement (selection inside `runInstantOn(listEl, …)`; dwell `setTimeout` cleared on change; `navigate({ search: { item }, replace })`). **Step 4:** PASS. **Step 5:** Commit `feat(web): inbox list and reading pane`.

### Task 43: Web: pane content

Implements §11.2. Builds on `GET /api/agents/:slug/events?around=&limit=` (`fetchEvents` in `features/session/api.ts:70`), `rows.ts` (`buildRows`), `TimelineRow` (`features/session/timeline-row.tsx`), `Composer`/`TerminatedComposer` (`features/session/composer.tsx:47,94`), `CommentComposer` (`features/tasks/comment-composer.tsx`, `prefill`), `taskDetailOptions`, Task 39.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/inbox/session-excerpt.tsx`
- Modify: `apps/web/src/features/inbox/inbox-pane.tsx`, `apps/web/src/features/inbox/api.ts` (`inboxItemOptions(id)`: key `["inbox","item",id]`, `GET /api/inbox/:id`)
- Test: `apps/web/src/test/inbox-pane-content.test.tsx`

- [ ] **Step 1:** Failing tests: a message item shows 7 rows around `seq` with the target highlighted and scrolled to `block: "start"`, then a composer that posts to `/api/agents/<sender>/messages`; without `seq`, the latest 7 events and no highlight; a `@factory` item targets the subject agent; a terminated sender shows the read-only line; a mention item shows the task header, 3 previous comments and the comment, and a `CommentComposer` prefilled `@ada ` (agent author) or empty (human author); a task_event shows the fact and "Open task" with no composer; the composer stays visible while the body scrolls; switching items shows skeletons, never the previous body; `?item=` not in the loaded pages fetches `/api/inbox/:id`; 404 shows "This item no longer exists."; sending a reply marks the item read.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (`Composer key={slug}`, `CommentComposer key={taskKey}`; pane `flex min-h-0 flex-col`: header `h-12 border-b shrink-0`, body `min-h-0 flex-1 overflow-y-auto`, composer `shrink-0 border-t`). **Step 4:** PASS. **Step 5:** Commit `feat(web): the reading pane shows context and replies at the target`.

### Task 44: Web: `TaskDetailView` lays out by its container

Implements §12 (container query). Builds on `features/tasks/task-detail.tsx` (`lg:` at L184 `BodyPlates`, 289, 296, 297, 314, 378 `TitleBlock`, 470), `routes/_app/tasks.$key.tsx`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/features/tasks/task-detail.tsx`, `apps/web/src/routes/_app/tasks.$key.tsx` (wrap in `PageBody` there)
- Test: `apps/web/src/features/tasks/task-detail.test.tsx`

- [ ] **Step 1:** Failing test: the view's root has `@container/task`; no `lg:` class remains in `task-detail.tsx` (source scan); the two-column classes use `@[45rem]/task:`; the route still wraps in `PageBody`.
- [ ] **Step 2:** FAIL. **Step 3:** Convert each `lg:` to `@[45rem]/task:`; move `PageBody` out. **Step 4:** PASS. **Step 5:** Commit `refactor(web): task detail lays out by its container`.

### Task 45: Web: task peek

Implements §12; DESIGN.md §16.6 [PR5] append. Builds on `features/tasks/task-list.tsx`, Task 18 Sheet, Task 40, Task 44, `useTaskDetail`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/features/tasks/task-peek.tsx`
- Modify: `apps/web/src/features/tasks/task-list.tsx`, `apps/web/src/routes/_app/tasks.index.tsx`
- Test: `apps/web/src/test/task-peek.test.tsx`

- [ ] **Step 1:** Failing tests: Space on a focused row opens a non-modal sheet with the task (and `preventDefault`s the scroll) when the list container is ≥54rem (24 + 30); below that Space opens `/tasks/$key`; focus stays on the list; `j`/`k` retarget the peek without remounting `SheetContent` (same node) and reset its scroll; neighbours' `taskDetailOptions` prefetched; Esc and Space close it and focus the selected row; a plain click navigates; Enter opens the page.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (`ResizeObserver` on the list container for the width gate; one `peek` state on the page; `SheetBody key={taskKey}`). **Step 4:** PASS. **Step 5:** Commit `feat(web): Space peeks a task from the list`.

### Task 46: PR5 docs, verify and open

Implements DESIGN.md [PR5] clauses of §16.1, §16.3, §16.5, §16.6, §16.8, plus §16.3 Sub-navigation "the selected fill" change; switches the Settings sub-nav's current row to `steel-selected` (`routes/_app/settings.tsx`, one class); behavior docs §17 `inbox.md` (pane, read rule), `tasks.md` [PR5].

- [ ] **Step 1:** Settings sub-nav class change + its test assertion; commit `feat(web): Settings sub-nav uses the selected fill`.
- [ ] **Step 2:** DESIGN.md [PR5] text; commit `docs: DESIGN.md reading pane, peeks and selected rows`.
- [ ] **Step 3:** Behavior docs in the main checkout; list them in the PR body.
- [ ] **Step 4:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`; manual: the inbox pane at 1023/1024 with an 11 KB single-line message (composer stays visible), the task peek at 1024 and 1440, `steel-selected` in both themes next to hover (tune the two values; screenshots).
- [ ] **Step 5:** Push and `gh pr create --base u2/4-palette` (template, spec, #89, docs, stacked note).

---

# PR 6 — `u2/6-home-templates`: Home redesign and Templates/Images views

`git checkout -b u2/6-home-templates` from `u2/5-inbox-pane`.

### Task 47: Web: Home "Needs you" and "Live now"

Implements §13. Builds on `routes/_app/index.tsx`, `features/agents/home-agents.tsx` (frozen-order logic), `features/inbox/home-inbox.tsx`, `liveFact` (Task 20), `useAgentIndex`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/routes/_app/index.tsx`, `apps/web/src/features/agents/home-agents.tsx` (becomes `LiveNow` + `NeedsYouAgents`)
- Test: `apps/web/src/features/agents/home-agents.test.tsx`, `apps/web/src/test/empty-states.test.tsx`

- [ ] **Step 1:** Failing tests: Needs you = 5 unread items then live errored agents (not rate-limited, not restart-pending, no `stuck`), capped at 8 with "and N more" → `/agents`; Live now = working/queued/rate-limited, tree order, capped at 8, header "2 working · 1 queued"; membership and order frozen while the pointer is inside, applied when it leaves; empty lines "Nothing needs you." / "No agent is working." / "No agents yet." + "New agent".
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): Home shows what needs you and what is live`.

### Task 48: Web: `SegmentedLinks` and the Templates/Images routes

Implements §14 (views, header, redirect). Builds on `components/ui/segmented-control.tsx` (look), `routes/_app/templates.index.tsx` (header `:29-41`, `ImagesSection` `:58`), `features/templates/images-section.tsx`, `features/session/timeline-row.tsx:213`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Create: `apps/web/src/components/ui/segmented-links.tsx`, `apps/web/src/routes/_app/templates.images.tsx`
- Modify: `apps/web/src/routes/_app/templates.index.tsx` (`beforeLoad` redirect for `#images`; header title area), `features/session/timeline-row.tsx:213`, `features/palette/command-palette.tsx` (Images → `/templates/images`)
- Test: `apps/web/src/test/templates.test.tsx`, `apps/web/src/components/ui/segmented-links.test.tsx`

- [ ] **Step 1:** Failing tests: two links with `aria-current="page"` on the active one, no radio roles; `/templates#images` → `/templates/images`; the h1 stays visible from a 25rem header and is sr-only below (class contract); New template icon-only below 640px with `aria-label`; no horizontal overflow classes regress (contract).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): Templates and Images as two views`.

### Task 49: Web: the build log in a peek

Implements §14 (build log). Builds on `features/templates/build-log.tsx` (`BuildLog({ name, item })`), `images-section.tsx:145`, Task 18.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `apps/web/src/features/templates/images-section.tsx`
- Test: `apps/web/src/features/templates/build-log.test.tsx`, `apps/web/src/test/templates.test.tsx`

- [ ] **Step 1:** Failing tests: rows show status only (no inline log); "Build log" opens a non-modal sheet titled "<image> build log" streaming frames; another row's "Build log" retargets the same `SheetContent` node; Build in the sheet footer starts a build.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): image build logs stream in a side panel`.

### Task 50: Reserved template names and the oversize avatar note

Implements §14 (reserved names, oversize note), §15.3 (detail `avatar`). Builds on `POST /api/templates` (`apps/server/src/routes/templates.ts:84`), `createTemplateBodySchema`, `features/templates/template-list.tsx`, `template-editor.tsx`.

**Implementer and reviewer invoke `vercel-react-best-practices` and follow it.**

**Files:**
- Modify: `packages/shared/src/templates.ts` (`RESERVED_TEMPLATE_NAMES = ["new", "images"]`; refine on the create body name: "That name is reserved."), `apps/server/src/routes/templates.ts`, `apps/web/src/features/templates/template-list.tsx`, `apps/web/src/features/templates/template-editor.tsx`
- Test: `apps/server/src/routes/templates.test.ts`, `apps/web/src/test/templates.test.tsx`

- [ ] **Step 1:** Failing tests: `POST /api/templates { name: "images" }` → 400 "That name is reserved."; a folder named `images` on disk lists with "Rename this folder: its name is reserved."; the template page shows "avatar.svg ignored: over 256 KB" when the detail says `tooLarge`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat: reserve the template names the routes use`.

### Task 51: PR6 docs, verify and open

Implements behavior docs §17 `administration.md` Images, `inbox.md` Home sentence.

- [ ] **Step 1:** Behavior docs in the main checkout; list them in the PR body. (No DESIGN.md text in PR6.)
- [ ] **Step 2:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- [ ] **Step 3:** Manual: Home with the stress data (caps), Templates and Images at 320, a streaming build log.
- [ ] **Step 4:** Push and `gh pr create --base u2/5-inbox-pane` (template, spec, #89, docs, stacked note). Mention Q17's alternative (drop Home → `/inbox`) as a one-line switch in the PR body.

### Task 52: Whole-stack review (on PR6's branch)

- [ ] **Step 1:** Invoke `vercel-react-best-practices` and review the whole React diff of the stack (`git diff u1/5-perceived-speed...u2/6-home-templates -- apps/web`) against it: re-renders on WS frames (sidebar rows, Home, palette), stable selectors and callbacks, no effects that derive state, no waterfalls in loaders (Settings children, `/usage`, inbox pane), list rendering (`key`s, memoized rows), bundle (cmdk eager is deliberate; nothing else added).
- [ ] **Step 2:** Walk the spec section by section (§2 acceptance criteria 1–12, §4 checklist rows 1–12, §5–§16) and tick each against a task/commit; record any gap as a fix commit on the PR that owns it (rebase the stack above it) or as a follow-up issue linked from #89.
- [ ] **Step 3:** Confirm every DESIGN.md [PR n] clause landed in its PR and nothing describes an unbuilt feature; confirm every §17 behavior-doc edit is applied in the main checkout and listed in a PR body.
- [ ] **Step 4:** Post the review summary as a comment on #89 and on PR6.
