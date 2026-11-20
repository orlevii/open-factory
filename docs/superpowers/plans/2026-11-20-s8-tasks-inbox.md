# S8 Tasks and Inbox Implementation Plan

> **For agentic workers:** this plan is executed by one developer working **directly** (no implementer subagents), task by task, **test-first**, **one commit per task**. Steps use checkbox (`- [ ]`) syntax for tracking. Use superpowers:executing-plans for the checkpoints.

**Goal:** Lightweight tracked work and a per-user inbox: tasks with dependencies, links, comments and history; five factory MCP task tools for every agent; `task_assigned` / `task_comment` / `task_update` messages delivered into sessions; mentions in comments reaching agents and humans; an inbox with read state, mark-all-read with exact undo, deep links to comments, and optional browser notifications; Tasks list, create and detail pages.

**Architecture:**
- `packages/shared`: `tasks.ts` (statuses, notice codes, `parseTaskKey`, input/tool/response schemas), `mentions.ts` (subpath `@open-factory/shared/mentions`, `extractMentions` over the mdast AST), message kinds and envelope/queue/inbox fields, the `task_message` wake reason, `tasks_changed` frame.
- `packages/db`: one migration (five task tables, `messages.task_id`/`comment_id` with a composite FK, the CHECK rewrite, inbox kind CHECK and the unread index).
- `apps/server/src/tasks/` (new): `TaskStore` (SQL, the lock-order header), `canChange`, `Notifier` (pure), `taskBodies` (pure), `TaskService` (the one transaction procedure of spec §13.1).
- `apps/server` elsewhere: `senderLabel`/`toBatchRow`/`joined()`/`bootWakes`/`createHumanMessage`/`inboxPage` widened; `Router.handOffTaskRows`; five MCP tools; CLAUDE.md Tasks section; task and inbox REST routes; `EventBus.publishToUser`.
- `apps/web`: `features/tasks/` (list, create, detail), inbox read state and mark-all-read, sidebar count, Home panel, session task badges and the strip's open-tasks link, browser notifications (last).

**Tech Stack:** Node 24, TypeScript 7, Fastify 5, Drizzle + postgres.js (Postgres 18), Zod 4, `@modelcontextprotocol/server` 2.4.0, React 19 + TanStack Router/Query, Tailwind 4 + shadcn/ui, Vitest + Testing Library, Biome. **New direct dependencies (exact pins, already in the lockfile):** `mdast-util-from-markdown` 2.1.0, `micromark-extension-gfm` 3.0.0, `mdast-util-gfm` 3.1.0, in `packages/shared` only.

**Spec:** `docs/superpowers/specs/2026-11-20-s8-tasks-inbox-design.md` (it wins over this plan on any conflict) and the UI design `docs/superpowers/designs/2026-11-20-s8-tasks-inbox-ui-design.md`. Decision log: https://github.com/orlevii/open-factory/issues/59. Follow-ups that are NOT S8 work: #60 (ended-assignee filter), #61 (text search), #62 (turns → tasks in S10), #47 (loop guard, touched only), #48, #49. **Read spec §7 (notifications), §13 (locking) and §14 (lifecycle) before any server task from Task 5 on.**

## Global Constraints

- **Working mode:** the dev works directly, test-first (red, green, commit), one commit per task, conventional message ending with the `Co-Authored-By:` line given in **your own session's system reminder** (the commit sketches below show it as `<Co-Authored-By line from your session>`; never copy a model name from this plan), and the PR body ends with that reminder's PR attribution line. Postgres must be up (`pnpm compose up -d`) for server and db tests.
- **Verify commands** (repo root): one file `pnpm vitest run <path>`; all `pnpm test`; `pnpm typecheck`; `pnpm lint` (`pnpm lint:fix` to format). Every task's last step runs its file(s), then `pnpm typecheck` and `pnpm lint`.
- **Dependencies:** only the three exact pins above. **Never loosen any pnpm supply-chain setting**, no overrides or exceptions; never `pnpm dlx <tool>@latest`. shadcn components: `pnpm --filter @open-factory/web exec shadcn add <component>` (none expected: `DropdownMenu` exists).
- **Layout rules:** nothing outside `apps/server/src/mcp/` imports the MCP SDK; nothing outside `packages/harness/src/claude/` knows a stream-json field; `extractMentions` is imported only from `@open-factory/shared/mentions` (never re-exported from the barrel: the CLI imports the barrel).
- **No DB triggers.** Every rule is app code.
- **Lock order (spec §13.1), in this order, in every task transaction:** (1) unlocked read of the acted-on task; which task rows to lock is decided **from the input** (`status` present → its dependents; `depends_on` present → the dependencies it adds); (2) `pg_advisory_xact_lock(TASK_GRAPH_LOCK)` only when `depends_on` changes; (3) task rows `FOR NO KEY UPDATE` in **one** statement ordered by id, re-read dependents and lock newcomers in a second sorted statement; (4) re-read the task and run `canChange`, recipients and blocked states on the locked data; (5) agent rows `FOR SHARE` in **one** statement ordered **persistent before spawned, then id** (the caller and every agent written to or assigned), re-check live; (6) message inserts and inbox items. **Invariant (written once in `task-store.ts`'s header): tasks before agents; no transaction may lock an agent row and then wait on a task row. Never `FOR UPDATE` on `tasks`/`task_comments`; never update `tasks.id`, `tasks.number`, `task_comments.(task_id, id)`.** Every store/router/resolver call inside takes `tx`. **The transaction never awaits a runtime call** (`runtimes.load`, `statusOf`, `deliver`). Every task transaction is retried once from step 1 on `40P01`. **Write next to the invariant in the header:** the second sorted statement (newcomer dependents) is taken while already holding task locks, so it can deadlock against another transaction's first statement; that is expected and covered by the once-only retry; do not "fix" it with more locking. A second deadlock in a row is not a 500 or a thrown error: it becomes a plain error, "The task changed while you were editing it; try again." (tool error / `409 task_conflict`).
- **Hand-offs:** after commit, through `Router.handOffTaskRows`, after `bootDone`, skipped when closed, never awaited, every promise `.catch`ed and logged.
- **Truthful senders:** `task_assigned`/`task_update` have no sender columns (`@factory`); `task_comment` is from its author. Author text inside factory text is attributed and quoted; every envelope body is escaped by `groupEnvelopes`.
- **Security:** `/api/tasks*` and `/api/inbox*` use `requireUser` (a valid agent token gets 401); link `url`/`pr` targets must be `http:`/`https:` ≤ 2,000 chars; titles and link titles are plain text everywhere; bodies and comments render only through `Markdown`; identity comes from the token or session, never from input.
- **Names and copy:** "spawned agent" in UI and agent-facing text; agents `@slug`, humans `@handle`; task keys `T-<n>`; the spec's exact sentences (copy them, don't paraphrase).
- **Timing in tests:** await real events, drain job queues (`rt.settled()`, the harness helpers); race tests wait on `pg_stat_activity.wait_event_type = 'Lock'`; **never raise a timeout to make a test pass**; no sleeps.
- **No automated test calls a live model.** Live checks (Task 1, Task 10, Task 23) read `~/.open-factory-spike/oauth-token` into the environment at run time only, use haiku, never print or commit it; Docker image `open-factory-base:dev`.
- **UI rules (DESIGN.md + UI doc):** orange only for live/focused/selected (unread dot and counts are ink/muted); status = icon + label; no list animations on live updates; keyboard actions never animate; never `transition-all`; type in rem; no toasts; undo over confirmation; longer forms validate on blur and submit.
- `docs/product/` is gitignored and read-only: never edit it, never link it from the PR.

## File Structure

```
packages/shared/
  package.json                (modify) exports "./mentions"; 3 exact deps
  src/tasks.ts                (new)    statuses, notices, parseTaskKey/taskKey, input + tool + response schemas
  src/mentions.ts             (new)    extractMentions (subpath export only)
  src/messaging.ts            (modify) MESSAGE_KINDS + task kinds; envelope taskTitle/commentId; inbox item fields
  src/agents.ts               (modify) queue item taskKey/taskTitle/commentId; AgentSummary.openTasks
  src/events.ts               (modify) process_started reason + task_message
  src/ws.ts                   (modify) tasks_changed frame
  src/index.ts                (modify) export * from "./tasks.ts"

packages/db/
  src/schema/tasks.ts         (new)    tasks, taskDependencies, taskLinks, taskComments, taskEvents
  src/schema/agents.ts        (modify) messages.taskId/commentId; inboxItems kind type
  src/schema/index.ts         (modify) export tasks
  migrations/0008_*.sql       generated, CHECKs/composite FK/sequence/partial index by hand
  src/schema.tasks.test.ts    (new)    V3: every row shape

packages/harness/src/
  envelope.ts                 (modify) BatchRow taskKey/taskTitle/commentId; ORDER; single/merge copy taskKey
  types.ts                    (modify) FactoryMessage taskTitle/commentId

apps/server/src/
  tasks/task-store.ts         (new)    SQL + lock helpers; THE lock-order header
  tasks/permission.ts         (new)    canChange
  tasks/blocked.ts            (new)    isBlocked, blockedBy (pure)
  tasks/bodies.ts             (new)    taskAssignedBody, taskUpdateBody (pure)
  tasks/notifier.ts           (new)    plan() (pure)
  tasks/task-service.ts       (new)    create, update, comment; withDeadlockRetry
  tasks/errors.ts             (new)    TaskError(code, message, status, field?)
  mcp/tools/{create,update,list,get,comment}-task.ts (new)
  agents/runtimes.ts          (modify) senderLabel → @factory for sender-less rows
  agents/agent-runtime.ts     (modify) toBatchRow task fields
  agents/event-store.ts       (modify) clock(), joined() task join, bootWakes kinds, createHumanMessage per kind,
                                       inboxPage kinds/fields/unread, markRead/markAllRead/undoReadAll/unreadCount
  agents/event-bus.ts         (modify) subscribeUser/publishToUser
  supervisor/slots.ts         (modify) WakeReason + task_message
  messaging/router.ts         (modify) handOffTaskRows
  workspace/claude-md.ts      (modify) kinds line, @factory parenthetical, ## Tasks
  agents/agent-service.ts     (modify) AgentSummary.openTasks
  routes/tasks.ts             (new)    task REST
  routes/inbox.ts             (modify) read, read-all, undo, unread-count, ?unread
  ws/route.ts                 (modify) per-user subscription
  app.ts                      (modify) TaskStore/TaskService wiring, tools, routes
  scripts/smoke-tasks.ts      (new)    live check (--early slice)

apps/web/src/
  features/tasks/*            (new)    api, TaskBadge, StatusLabel, StatusMenu, AssigneeMenu, TaskList, TaskFilters,
                                       TaskForm, TaskDetail, TaskActivity, CommentBlock, CommentComposer,
                                       DependencyEditor, LinkEditor, LinkList, AgentPicker
  routes/_app/tasks.tsx       (delete) replaced by tasks.index.tsx, tasks.new.tsx, tasks.$key.tsx
  features/inbox/*            (modify) InboxRow, read state, MarkAllRead, useUnreadCount, notifications.ts
  routes/_app/index.tsx       (modify) Home inbox panel
  routes/_app.tsx             (modify) tasks_changed / inbox_changed invalidation
  components/app-sidebar.tsx  (modify) unread count; notifications switch
  components/route-states.tsx (modify) ResourceNotFound detail/backTo
  features/session/copy-link.tsx, message-block.tsx, timeline-row.tsx, queue-items.tsx, agent-strip.tsx (modify)
```

---

### Task 1: Task tool schemas and live gate V1 (real schemas, stub handlers, haiku)

Spec §18 V1: prove Claude lists and calls the five tools with their real array/object/nullable inputs before any task code. This task writes the shared schemas (they are needed for the probe and are kept), then probes them live.

**Files:**
- Create: `packages/shared/src/tasks.ts`, `packages/shared/src/tasks.test.ts`
- Modify: `packages/shared/src/index.ts` (`export * from "./tasks.ts";`)
- Modify: `packages/harness/fixtures/README.md` ("Verified in S8 implementation")
- Scratch (never committed): `G=$(mktemp -d)/s8-gate`

**Interfaces — Produces:**
```ts
export const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_NOTICES = ["done", "cancelled", "unblocked", "unassigned", "status_changed", "edited"] as const;
export type TaskNotice = (typeof TASK_NOTICES)[number];
export function parseTaskKey(raw: string): number | null;   // "T-42" | "t-42" | "42" → 42; anything else null
export const taskKey = (n: number) => `T-${n}`;
export const taskTitleSchema, taskBodySchema, commentBodySchema, linkInputSchema;
export type LinkInput = z.infer<typeof linkInputSchema>;
export const createTaskToolSchema, updateTaskToolSchema, listTasksToolSchema, getTaskToolSchema, commentTaskToolSchema;
export const createTaskBodySchema, patchTaskBodySchema, taskCommentBodySchema;   // REST (camelCase)
```

- [ ] **Step 1: Write the failing tests** `packages/shared/src/tasks.test.ts`:

```ts
import { expect, test } from "vitest";
import {
  commentBodySchema, createTaskToolSchema, linkInputSchema, parseTaskKey, taskBodySchema, taskTitleSchema,
  updateTaskToolSchema,
} from "./tasks.ts";

test("parseTaskKey accepts T-42, t-42, 42 and nothing else", () => {
  expect(parseTaskKey("T-42")).toBe(42);
  expect(parseTaskKey("t-42")).toBe(42);
  expect(parseTaskKey(" 42 ")).toBe(42);
  for (const bad of ["T42", "T-", "T-0", "T--1", "x-42", "4.2", "", "T-99999999999"]) expect(parseTaskKey(bad)).toBeNull();
});

test("title: trimmed, 1–200, one line", () => {
  expect(taskTitleSchema.parse("  Plan  ")).toBe("Plan");
  expect(taskTitleSchema.safeParse("").error?.issues[0]?.message).toBe("Enter a title.");
  expect(taskTitleSchema.safeParse("x".repeat(201)).error?.issues[0]?.message).toBe("Keep the title to 200 characters or fewer.");
  expect(taskTitleSchema.safeParse("a\nb").error?.issues[0]?.message).toBe("Keep the title on one line.");
});

test("body: may be empty, ≤ 64 KB UTF-8; comment: non-empty", () => {
  expect(taskBodySchema.parse("")).toBe("");
  expect(taskBodySchema.safeParse("é".repeat(32_769)).success).toBe(false); // 65,538 bytes
  expect(commentBodySchema.safeParse("   ").success).toBe(false);
});

test("links: url/pr http(s) ≤ 2000, agent slug, file one line ≤ 500", () => {
  expect(linkInputSchema.safeParse({ kind: "url", target: "javascript:alert(1)" }).error?.issues[0]?.message)
    .toBe("Links must be http(s) URLs.");
  expect(linkInputSchema.safeParse({ kind: "pr", target: `https://x.io/${"a".repeat(2000)}` }).success).toBe(false);
  expect(linkInputSchema.safeParse({ kind: "pr", target: "https://github.com/a/b/pull/1", title: "PR" }).success).toBe(true);
  expect(linkInputSchema.safeParse({ kind: "file", target: "a\nb" }).success).toBe(false);
  expect(linkInputSchema.safeParse({ kind: "agent", target: "@dev" }).success).toBe(true);
});

test("tool schemas: arrays, nullable assignee, caps", () => {
  expect(createTaskToolSchema.safeParse({ title: "t", depends_on: Array(51).fill("T-1") }).success).toBe(false);
  expect(updateTaskToolSchema.parse({ id: "T-1", assignee: null }).assignee).toBeNull();
  expect(updateTaskToolSchema.safeParse({ id: "T-1", links: Array(51).fill({ kind: "file", target: "a" }) }).success).toBe(false);
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/tasks.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `packages/shared/src/tasks.ts`:

```ts
import { z } from "zod";

export const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_NOTICES = ["done", "cancelled", "unblocked", "unassigned", "status_changed", "edited"] as const;
export type TaskNotice = (typeof TASK_NOTICES)[number];
export const TASK_LINK_KINDS = ["url", "pr", "file", "agent"] as const;

export function parseTaskKey(raw: string): number | null {
  const m = /^(?:t-)?([1-9][0-9]{0,8})$/i.exec(raw.trim());
  return m ? Number(m[1]) : null;
}
export const taskKey = (n: number) => `T-${n}`;

const BODY_MAX = 64 * 1024;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const oneLine = (s: string) => !/[\r\n]/.test(s);

export const taskTitleSchema = z
  .string()
  .trim()
  .min(1, "Enter a title.")
  .max(200, "Keep the title to 200 characters or fewer.")
  .refine(oneLine, "Keep the title on one line.");
export const taskBodySchema = z.string().refine((s) => bytes(s) <= BODY_MAX, "Shorten the description to 64 KB or less.");
export const commentBodySchema = z
  .string()
  .trim()
  .min(1, "Write a comment first.")
  .refine((s) => bytes(s) <= BODY_MAX, "Shorten the comment to 64 KB or less.");

const httpUrl = z
  .string()
  .trim()
  .max(2000, "Links must be http(s) URLs.")
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "Links must be http(s) URLs.");
const linkTitle = z.string().trim().min(1).max(200).refine(oneLine, "Keep it on one line.").optional();
export const linkInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), target: httpUrl, title: linkTitle }),
  z.object({ kind: z.literal("pr"), target: httpUrl, title: linkTitle }),
  z.object({ kind: z.literal("file"), target: z.string().trim().min(1).max(500).refine(oneLine, "Keep the path on one line."), title: linkTitle }),
  z.object({ kind: z.literal("agent"), target: z.string().trim().min(1).max(64), title: linkTitle }),
]);
export type LinkInput = z.infer<typeof linkInputSchema>;

const taskRef = z.string().min(1).max(20);
const name = z.string().min(1).max(64);
const deps = z.array(taskRef).max(50, "A task can depend on at most 50 tasks.");
const links = z.array(linkInputSchema).max(50, "A task can have at most 50 links.");

/** MCP inputs (snake_case, as the product's tool signatures). Parameter semantics only; rules live in CLAUDE.md. */
export const createTaskToolSchema = z.object({
  title: taskTitleSchema.describe("One line"),
  body: taskBodySchema.optional().describe("Markdown brief"),
  assignee: name.optional().describe('An agent slug, or "me"'),
  depends_on: deps.optional().describe("Task keys this task waits on, like T-41"),
  links: links.optional(),
});
export const updateTaskToolSchema = z.object({
  id: taskRef.describe("Task key, like T-42"),
  title: taskTitleSchema.optional(),
  body: taskBodySchema.optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assignee: name.nullable().optional().describe('An agent slug, "me", or null to unassign'),
  depends_on: deps.optional().describe("The full new list (replaces the old one)"),
  links: links.optional().describe("The full new list (replaces the old one)"),
});
export const listTasksToolSchema = z.object({
  status: z.array(z.enum(TASK_STATUSES)).min(1).optional().describe('Default ["open","in_progress"]'),
  assignee: name.optional().describe('An agent slug or "me"'),
  unassigned: z.literal(true).optional().describe("Only tasks with no assignee (instead of assignee)"),
  created_by: name.optional().describe('An agent slug, a human "@handle", or "me"'),
  limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
});
export const getTaskToolSchema = z.object({
  id: taskRef,
  comments_before: z.string().min(1).optional().describe("A comment id: return the 50 comments before it"),
});
export const commentTaskToolSchema = z.object({ id: taskRef, body: commentBodySchema });

/** REST inputs (camelCase). */
export const createTaskBodySchema = z.object({
  title: taskTitleSchema,
  body: taskBodySchema.default(""),
  assignee: name.nullable().optional(),
  dependsOn: deps.default([]),
  links: links.default([]),
});
export const patchTaskBodySchema = z.object({
  title: taskTitleSchema.optional(),
  body: taskBodySchema.optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assignee: name.nullable().optional(),
  dependsOn: deps.optional(),
  links: links.optional(),
});
export const taskCommentBodySchema = z.object({ body: commentBodySchema });
```

(Response schemas are added in Task 14.)

- [ ] **Step 4: Run** the test file → PASS; `pnpm typecheck`; `pnpm lint`.

- [ ] **Step 5: Write the probe** `$G/probe.mjs` (run from `apps/server` so the SDK and `@open-factory/shared` resolve; tsx loads the `.ts` source):

```js
import http from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  commentTaskToolSchema, createTaskToolSchema, getTaskToolSchema, listTasksToolSchema, updateTaskToolSchema,
} from "@open-factory/shared";

const seen = [];
const ok = (name) => async (args) => {
  seen.push({ name, args });
  const r = { create_task: { key: "T-1", status: "open", assignee: "dev", blocked_by: [] },
    update_task: { key: "T-1", status: "done", blocked_by: [], changed: ["status"] },
    list_tasks: { tasks: [{ key: "T-1", title: "Probe", status: "open", blocked_by: [] }], more: false },
    get_task: { key: "T-1", title: "Probe", body: "Say hi in a comment.", status: "open", comments: [], earlier_comments: 0 },
    comment_task: { id: "c1", delivered_to: [], mentioned_humans: ["@or"], not_reached: [] } }[name];
  return { content: [{ type: "text", text: JSON.stringify(r) }] };
};
const handler = createMcpHandler(async () => {
  const s = new McpServer({ name: "factory", version: "0.0.0" });
  s.registerTool("create_task", { description: "Create a task", inputSchema: createTaskToolSchema }, ok("create_task"));
  s.registerTool("update_task", { description: "Change a task", inputSchema: updateTaskToolSchema }, ok("update_task"));
  s.registerTool("list_tasks", { description: "List tasks", inputSchema: listTasksToolSchema }, ok("list_tasks"));
  s.registerTool("get_task", { description: "Read a task", inputSchema: getTaskToolSchema }, ok("get_task"));
  s.registerTool("comment_task", { description: "Comment on a task", inputSchema: commentTaskToolSchema }, ok("comment_task"));
  return s;
}, { legacy: "stateless", responseMode: "json", maxRequestBodySize: 512 * 1024 });
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.headers.authorization !== "Bearer tok-probe") { res.writeHead(401).end(); return; }
  const r = await handler.fetch(new Request(`http://127.0.0.1:47814${req.url}`,
    { method: req.method, headers: req.headers, body: body.length ? body : undefined }),
    { authInfo: { token: "x", clientId: "probe", scopes: [] } });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(47814, "127.0.0.1", () => console.error("listening"));
process.on("SIGTERM", () => { console.error("SEEN", JSON.stringify(seen)); process.exit(0); });
```

- [ ] **Step 6: Run one haiku turn**

```bash
G=$(mktemp -d)/s8-gate; mkdir -p $G/a $G/cfg
cat > $G/a/.mcp.json <<'EOF'
{"mcpServers":{"factory":{"type":"http","url":"http://127.0.0.1:47814/mcp","headers":{"Authorization":"Bearer ${OPEN_FACTORY_AGENT_TOKEN}"}}}}
EOF
(cd apps/server && node --import tsx $G/probe.mjs 2> $G/server.log &) ; sleep 1
P='Use the factory tools in this order: create_task with title "Probe", assignee "dev", depends_on ["T-7","T-8"] and links [{"kind":"pr","target":"https://github.com/a/b/pull/1"}]; get_task id "T-1"; comment_task id "T-1" body "@or done?"; update_task id "T-1" with assignee null and status "done"; list_tasks with status ["done"]. Then reply "finished".'
cd $G/a && printf '%s\n' "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$P")}}" \
 | env -i PATH="$PATH" HOME="$HOME" CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.open-factory-spike/oauth-token)" \
   CLAUDE_CONFIG_DIR=$G/cfg OPEN_FACTORY_AGENT_TOKEN=tok-probe \
   claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --permission-mode auto > $G/run.jsonl; cd - >/dev/null
pkill -TERM -f "$G/probe.mjs"; sleep 1
grep -o '"tools":\[[^]]*\]' $G/run.jsonl | head -1 | tr ',' '\n' | grep mcp__factory
grep SEEN $G/server.log
```

Expected: `system/init` lists `mcp__factory__create_task`, `update_task`, `list_tasks`, `get_task`, `comment_task`; `SEEN` has five calls with `depends_on` an array of two strings, `links` an array of one object, `assignee: null` on `update_task`, `status: ["done"]` on `list_tasks`. The token is read only inside `env -i`; never echo it.

- [ ] **Step 7: If it fails, apply the spec's fallback** (§18 V1): flatten inputs (`depends_on` as a comma-separated string, links as `"kind target [title]"` strings, `assignee: ""` for unassign). Change the schemas accordingly, re-run the probe, and note the change at the top of Task 9.

- [ ] **Step 8: Record and commit.** Append to `packages/harness/fixtures/README.md` under "Verified in S8 implementation": `claude --version`, that the five tools listed, and which input shapes arrived intact.

```bash
git add packages/shared/src/tasks.ts packages/shared/src/tasks.test.ts packages/shared/src/index.ts packages/harness/fixtures/README.md
git commit -m "feat(shared): task schemas, verified live against haiku

<Co-Authored-By line from your session>"
```

---

### Task 2: Database: task tables, message references, CHECK rewrite (V3)

**Files:**
- Create: `packages/db/src/schema/tasks.ts`, `packages/db/src/schema.tasks.test.ts`
- Modify: `packages/db/src/schema/agents.ts` (messages `taskId`, `commentId`; `inboxItems.kind` type), `packages/db/src/schema/index.ts`
- Generate: `packages/db/migrations/0008_*.sql` (`pnpm db:generate`), then hand-edit

**Interfaces — Produces:** Drizzle tables `tasks`, `taskDependencies`, `taskLinks`, `taskComments`, `taskEvents`; types `TaskRow`, `TaskCommentRow`, `TaskEventRow`, `TaskLinkRow`; `messages.taskId`, `messages.commentId`; `InboxItemRow.kind: "message" | "mention" | "task_event"`.

- [ ] **Step 1: Write the failing test** `packages/db/src/schema.tasks.test.ts` (same setup as `schema.messages.test.ts`: `createTestDatabase`, `migrate`, seed `u1`, `c1`, agents `a1`, `a2`; plus a task and a comment):

```ts
beforeAll(async () => {
  /* as schema.messages.test.ts, then: */
  await sql`insert into tasks (id,title,created_by_user_id) values ('t1','One','u1'),('t2','Two','u1')`;
  await sql`insert into task_comments (id,task_id,author_agent_id,body) values ('k1','t1','a1','hi')`;
});

test("keys come from a sequence", async () => {
  const rows = await sql`select number from tasks order by number`;
  expect(rows.map((r) => r.number)).toEqual([1, 2]);
});

test("every pre-S8 shape still passes and new shapes pass", async () => {
  await ok(sql`insert into messages (id,kind,from_user_id,to_agent_id,body) values ('m1','message','u1','a1','x') returning id`);
  await ok(sql`insert into messages (id,kind,from_agent_id,to_all_humans,body,state) values ('m2','message','a1',true,'x','delivered') returning id`);
  await ok(sql`insert into messages (id,kind,subject_agent_id,notice,to_agent_id,body) values ('m3','member_update','a1','denied','a2','x') returning id`);
  await ok(sql`insert into messages (id,kind,subject_agent_id,notice,to_agent_id,body) values ('m4','peer_left','a1','peer','a2','x') returning id`);
  await ok(sql`insert into messages (id,kind,notice,to_agent_id,body) values ('m5','system','crash_recovered','a1','x') returning id`);
  await ok(sql`insert into messages (id,kind,notice,subject_agent_id,to_all_humans,body,state) values ('m6','system','agent_errored','a1',true,'x','delivered') returning id`);
  await ok(sql`insert into messages (id,kind,task_id,to_agent_id,body) values ('n1','task_assigned','t1','a1','x') returning id`);
  await ok(sql`insert into messages (id,kind,from_agent_id,task_id,comment_id,to_agent_id,body) values ('n2','task_comment','a2','t1','k1','a1','x') returning id`);
  await ok(sql`insert into messages (id,kind,from_user_id,task_id,comment_id,to_agent_id,body) values ('n3','task_comment','u1','t1','k1','a1','x') returning id`);
  await ok(sql`insert into messages (id,kind,from_agent_id,task_id,comment_id,to_all_humans,body,state) values ('n4','task_comment','a1','t1','k1',true,'x','delivered') returning id`);
  await ok(sql`insert into messages (id,kind,notice,task_id,to_agent_id,body) values ('n5','task_update','unblocked','t1','a1','x') returning id`);
  await ok(sql`insert into messages (id,kind,notice,task_id,to_user_id,body,state) values ('n6','task_update','done','t1','u1','x','delivered') returning id`);
});

test("wrong shapes are rejected", async () => {
  await bad(sql`insert into messages (id,kind,task_id,to_agent_id,body) values ('b1','message','t1','a1','x')`); // old kind + task
  await bad(sql`insert into messages (id,kind,from_agent_id,task_id,to_agent_id,body) values ('b2','task_assigned','a2','t1','a1','x')`);
  await bad(sql`insert into messages (id,kind,task_id,to_agent_id,body) values ('b3','task_comment','t1','a1','x')`);
  await bad(sql`insert into messages (id,kind,notice,task_id,to_agent_id,body) values ('b4','task_update','bogus','t1','a1','x')`);
  await bad(sql`insert into messages (id,kind,notice,task_id,to_all_humans,body) values ('b5','task_update','done','t1',true,'x')`);
  await bad(sql`insert into messages (id,kind,task_id,to_user_id,body) values ('b6','task_assigned','t1','u1','x')`);
  await bad(sql`insert into tasks (id,title) values ('bt','no creator')`);
  await bad(sql`insert into task_links (id,task_id,position,kind,target,agent_id) values ('bl','t1',0,'agent','x','a1')`);
  await bad(sql`insert into task_dependencies (task_id,depends_on_task_id) values ('t1','t1')`);
  await bad(sql`insert into inbox_items (id,user_id,kind,message_id) values ('bi','u1','bogus','n6')`);
});

test("a message's comment must belong to its task (composite FK)", async () => {
  await expect(
    sql`insert into messages (id,kind,from_agent_id,task_id,comment_id,to_agent_id,body) values ('f1','task_comment','a2','t2','k1','a1','x')`,
  ).rejects.toThrow(/foreign key/i);
});
```

(`ok`/`bad` as in `schema.messages.test.ts`; `bad` matches `/check|violates/i` for the not-null and FK-free cases.)

- [ ] **Step 2: Run** `pnpm vitest run packages/db/src/schema.tasks.test.ts` → FAIL (relation "tasks" does not exist).

- [ ] **Step 3: Schema** `packages/db/src/schema/tasks.ts` (Drizzle, matching spec §5): `tasks` (`id` text pk, `number` integer not null unique default `sql\`nextval('task_number_seq')\``, `title`, `body` default `''`, `status` default `'open'`, `assigneeAgentId` → agents, `createdByAgentId` → agents, `createdByUserId` → users, `createdAt`, `updatedAt` not null) with indexes `(status, updated_at desc, id)`, `(assignee_agent_id, status)`, `(created_by_agent_id)`, `(created_by_user_id)` and CHECKs `status IN (…)`, `num_nonnulls(created_by_agent_id, created_by_user_id) = 1`; `taskDependencies` (pk, CHECK, index on `depends_on_task_id`); `taskLinks`; `taskComments` with `uniqueIndex("task_comments_task_id_id_unique").on(t.taskId, t.id)`; `taskEvents`. In `agents.ts`: `messages.taskId = text("task_id").references(() => tasks.id)`, `messages.commentId = text("comment_id")` (the composite FK goes in SQL), and `inboxItems.kind` typed `"message" | "mention" | "task_event"` with `index("inbox_items_unread_idx").on(t.userId).where(sql\`${t.readAt} is null\`)`.

- [ ] **Step 4: Generate and hand-edit the migration.** `pnpm db:generate`, then edit the new file:
  - Put `CREATE SEQUENCE "task_number_seq";` before `CREATE TABLE "tasks"`.
  - Add `ALTER TABLE "messages" ADD CONSTRAINT "messages_task_comment_fk" FOREIGN KEY ("task_id","comment_id") REFERENCES "task_comments"("task_id","id");`
  - Replace `messages_sender_kind_check` (drop, then add) with S6's text where **every** existing branch gains `AND task_id IS NULL AND comment_id IS NULL`, plus the three branches of spec §5 verbatim.
  - `ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_kind_check" CHECK (kind IN ('message','mention','task_event'));`
  - `CREATE INDEX "messages_task_idx" ON "messages" ("task_id") WHERE task_id IS NOT NULL;`

- [ ] **Step 5: Run** the new test and `pnpm vitest run packages/db/src` (`schema.messages.test.ts` must stay green) → PASS. Then `pnpm vitest run apps/server/src/messaging apps/server/src/agents/event-store.test.ts` to catch row inserts that now trip the CHECK (none should). `pnpm typecheck`, `pnpm lint`.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "feat(db): task tables, message task references and the CHECK rewrite

<Co-Authored-By line from your session>"
```

---

### Task 3: `extractMentions` on the markdown AST (V4)

**Files:**
- Create: `packages/shared/src/mentions.ts`, `packages/shared/src/mentions.test.ts`
- Modify: `packages/shared/package.json` (exports `"./mentions": "./src/mentions.ts"`; dependencies `"mdast-util-from-markdown": "2.1.0"`, `"micromark-extension-gfm": "3.0.0"`, `"mdast-util-gfm": "3.1.0"`), `pnpm-lock.yaml` — add the dependencies through the package manager, never by hand-editing `package.json`: `pnpm --filter @open-factory/shared add --save-exact mdast-util-from-markdown@2.1.0 micromark-extension-gfm@3.0.0 mdast-util-gfm@3.1.0` (the versions already resolve, so only importer entries change — check the diff shows no version changes); add the `exports` entry by editing `package.json`

**Interfaces — Produces:** `extractMentions(markdown: string): {names: string[]; skipped: string[]}` (`names`: without `@`, lowercase, deduped, first-appearance order, `"humans"` included as a name; `skipped`: names whose source offset didn't match, see the note below).

- [ ] **Step 1: Failing tests** `packages/shared/src/mentions.test.ts`:

```ts
import { expect, test } from "vitest";
import { extractMentions as m } from "./mentions.ts";

test.each([
  ["@or please look", ["or"]],
  ["(@or) and @dev-x1, @lead.", ["or", "dev-x1", "lead"]],
  ["hi @humans", ["humans"]],
  ["mail x@or.io", []],
  ["path/@or and @@or", []],
  ["\\@or escaped", []],
  ["@Or is not lowercase", []],
  ["@oré", []],
  ["@or- trailing hyphen", ["or"]],
  ["`@or` inline", []],
  ["```\n@or fenced\n```", []],
  ["    @or indented code", []],
  ["https://x.io/?q=@or", []],
  ["<https://x.io/?q=@or>", []],
  ["[ask @or](https://x.io)", ["or"]],
  ["@or then @or again", ["or"]],
])("%s", (src, want) => expect(m(src).names).toEqual(want));
```

- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/mentions.test.ts` → FAIL.

- [ ] **Step 3: Implement** `packages/shared/src/mentions.ts`:

```ts
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** Before `@`: start, or not a letter/digit/_ and not / . @ ; after the name: not a letter/digit/_. */
const MENTION = /(?<![\p{L}\p{N}_/.@])@([a-z0-9][a-z0-9-]*)(?![\p{L}\p{N}_])/gu;

type Node = { type: string; value?: string; url?: string; children?: Node[]; position?: { start: { offset?: number } } };

/** Spec §8: the names mentioned outside code, through the same micromark+GFM parser react-markdown uses. */
export function extractMentions(markdown: string): { names: string[]; skipped: string[] } {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as Node;
  const out: string[] = [];
  const skipped: string[] = [];
  const visit = (n: Node) => {
    if (n.type === "code" || n.type === "inlineCode") return;
    // An autolink or bare URL: a link whose only text is its own URL.
    if (n.type === "link" && n.children?.length === 1 && n.children[0]?.type === "text" &&
        (n.children[0].value === n.url || `mailto:${n.children[0].value}` === n.url)) return;
    if (n.type === "text" && n.value) {
      const base = n.position?.start.offset ?? 0;
      for (const hit of n.value.matchAll(MENTION)) {
        // `\@or`: the escape vanished from the AST; read the source.
        const at = base + (hit.index ?? 0);
        if (markdown[at] !== "@") { // offset drifted after an earlier escape: skip, never guess (limitation, see note)
          const n2 = (hit[1] ?? "").replace(/-+$/, "");
          if (n2 && !skipped.includes(n2)) skipped.push(n2);
          continue;
        }
        if (markdown[at - 1] === "\\") continue;
        const name = (hit[1] ?? "").replace(/-+$/, "");
        if (name && !out.includes(name)) out.push(name);
      }
      return;
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit(tree);
  return { names: out, skipped: skipped.filter((n) => !out.includes(n)) };
}
```

Note: text-node offsets map 1:1 to the source only when the node has no escapes before the `@`; the `markdown[at] !== "@"` guard skips a mismatched offset rather than guessing. **No fallback search** (it could land on a deliberately escaped `\@or` and turn it into a mention). Record the limitation in a code comment: a mention placed after an escape in the same text node may be missed. To keep that miss visible, `extractMentions` returns `{names, skipped}` (`skipped`: the names whose offset didn't match), and `comment` (Task 8) reports each skipped name not otherwise reached in `not_reached` with reason `"unknown"`, so the author sees it went nowhere. Add a fixture: `"\\* @or"`-style text with an escape before the mention in the same node → `or` in `skipped`, and Task 8 asserts it appears in `not_reached`.

- [ ] **Step 4: Run** → PASS (the deps were added with the `pnpm --filter … add --save-exact` command above), `pnpm typecheck`, `pnpm lint`. Confirm `git diff pnpm-lock.yaml` adds no new package versions.

- [ ] **Step 5: Commit**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): extract mentions outside code with the UI's markdown parser

<Co-Authored-By line from your session>"
```

---

### Task 4: Pure task rules: `canChange`, blocked, bodies, `Notifier.plan`

**Files:**
- Create: `apps/server/src/tasks/{permission,blocked,bodies,notifier,errors}.ts` and their `.test.ts`

**Interfaces — Produces:**
```ts
// errors.ts
export class TaskError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409, readonly field?: string);
}
// permission.ts
export type Actor = { kind: "agent"; agentId: string; slug: string } | { kind: "user"; userId: string; handle: string };
export function canChange(actor: Actor, t: { createdByAgentId: string | null; assigneeAgentId: string | null },
  managersOf: (agentId: string) => readonly string[]): boolean;
export function forbiddenSentence(key: string, creator: string /* "@lead" | "@or" */, assignee: string | null): string;
// blocked.ts
export const isBlocked = (status: TaskStatus, depStatuses: TaskStatus[]) => boolean;   // open|in_progress && some dep not done/cancelled
export const blockedBy = (status, deps: { key: string; status: TaskStatus }[]) => string[];
// bodies.ts
export function taskAssignedBody(i: { actor: string; key: string; title: string; creator: string; body: string;
  bodyAuthor: string; deps: { key: string; status: TaskStatus }[]; blockedBy: string[];
  links: { kind: string; label: string }[] }): string;
export function taskUpdateBody(lines: UpdateLine[], key: string, title: string, editedBody?: { author: string; body: string }): string;
export type UpdateLine =
  | { k: "done" | "cancelled"; actor: string } | { k: "status"; actor: string; to: TaskStatus }
  | { k: "reassigned"; actor: string; to: string } | { k: "unassigned"; actor: string }
  | { k: "renamed"; actor: string; to: string } | { k: "edited"; actor: string }
  | { k: "unblocked"; cause: string; how: "done" | "cancelled" | "removed" };
// notifier.ts
export type Recipient = { agentId: string } | { userId: string } | "all";
export type PlannedRow = {
  kind: "task_assigned" | "task_comment" | "task_update"; taskId: string; to: Recipient;
  notice?: TaskNotice; commentId?: string; from?: { agentId: string } | { userId: string };
  body: string; inboxKind?: "mention" | "task_event"; exceptUserId?: string;
  wake: "human" | "task_message";   // human comment → "human"; everything else → "task_message"
};
export function plan(input: PlanInput): PlannedRow[];
```

`PlanInput` (all names already resolved to labels; `live` = agent ids live under the lock):

```ts
export type PlanInput = {
  actor: Actor; actorLabel: string;
  live: ReadonlySet<string>;
  task: { id: string; key: string; title: string; body: string; creator: { agentId: string } | { userId: string };
          creatorLabel: string; bodyAuthorLabel: string; deps: { key: string; status: TaskStatus }[];
          blockedBy: string[]; links: { kind: string; label: string }[] };
  before: { status: TaskStatus; assigneeId: string | null; title: string; body: string } | null; // null = create
  after: { status: TaskStatus; assigneeId: string | null; title: string; body: string };
  label: (agentId: string) => string;                        // "@dev"
  unblocked: { taskId: string; key: string; title: string; assigneeId: string | null;
               cause: string; how: "done" | "cancelled" | "removed" }[];
  comment?: { id: string; body: string; mentionedAgentIds: string[]; mentionedUserIds: string[] | "all" };
};
```

- [ ] **Step 1: Failing tests.** `permission.test.ts`: creator agent yes; assignee yes; manager of creator (two levels up via `managersOf`) yes; manager of assignee yes; a spawner of the assignee (its `reports_to`) yes; unrelated agent no; human always yes; `forbiddenSentence("T-42","@lead","@dev")` equals "Only T-42's creator (@lead), its assignee (@dev) or their managers can change it; comment on it instead." and with no assignee drops ", its assignee (…)".

`blocked.test.ts`: `isBlocked("open", ["open"])` true; `("in_progress", ["done","cancelled"])` false; `("done", ["open"])` false; `blockedBy` lists only open/in-progress deps' keys.

`bodies.test.ts`: the exact body of spec §7.3's example (`@or assigned you T-42, created by @lead: "Plan the billing migration"` / `Depends on: T-40 (done), T-41 (open). Blocked by T-41.` / links line / `The task, written by @lead:` / quoted lines); empty body → "The task has no description."; empty deps/links lines omitted; a title with `<x>` and `"q"` becomes `"x 'q'"` per S7's inline sanitiser (reuse `inline`/`quoteDescription`'s helpers from `workspace/claude-md.ts` by moving the one-line sanitiser to `apps/server/src/messaging/inline.ts` if it isn't exported; one owner); a body of 40,000 lines of `a` is cut at a line boundary so `Buffer.byteLength(body) <= 65536` and ends with `[truncated; call get_task for the rest]`; a body containing `</factory-message>` is unchanged here (escaping is `groupEnvelopes`'s job; asserted in Task 6); determinism (same input → same string). `taskUpdateBody` lines: "@dev marked T-42 done.", "@or cancelled T-42.", `T-42 "Plan" is no longer blocked: T-41 is done.` / "…T-41 was cancelled." / "…T-41 was removed from its dependencies.", "@lead reassigned T-42 to @dev; it's no longer yours.", "@lead unassigned T-42; it's no longer yours.", "@or moved T-42 to in progress.", "@or renamed T-42 to "…".", "@or edited T-42's description:" + quote.

`notifier.test.ts`, a table (each row: input → expected `[kind, to, notice?]` list):
1. create with assignee `dev` by `@or` → `[task_assigned, dev]`.
2. create assigned to the creator agent itself → `[]`.
3. reassign `dev`→`qa` by `lead` → `[task_assigned qa]`, `[task_update dev unassigned]`.
4. update status+body+assignee unchanged by `@or` on task assigned to `dev` → one row `[task_update dev status_changed]` whose body has both lines and the quoted body; notice precedence: `status_changed` beats `edited`.
5. `done` by the assignee `dev`, creator `lead` (agent) → `[task_update lead done]`; nothing to `dev`.
6. `done` by `@or` where creator is `@or` → no creator row; the assignee `dev` gets one `task_update` whose line is "@or marked T-42 done." and whose notice is `done` (precedence: `unassigned`, `done`, `cancelled`, `unblocked`, `status_changed`, `edited`).
7. `done` with creator human `u2` (not the actor) → `[task_update {userId:u2} done, inboxKind task_event]`.
8. `done` on T-1 unblocking T-2 assigned to `qa` and T-3 assigned to `lead` where `lead` is also T-1's creator → `lead` gets two rows (T-1 `done`, T-3 `unblocked`): one per (recipient, task).
9. unblocked whose assignee is the actor → no row; unblocked whose assignee is ended (not in `live`) → no row.
10. comment by `dev` (assignee) mentioning `@qa` and `@or` → `[task_comment qa from dev]`, `[task_comment {userId:or} from dev, inboxKind mention]`; nothing to `dev`.
11. comment by `@or` (human) on task assigned to `dev` mentioning `@humans` → `[task_comment dev from or, wake human]`, `[task_comment "all" from or, inboxKind mention, exceptUserId or]`.
12. comment mentioning `@humans` and `@sam` → only the `"all"` row for humans.
13. comment mentioning the assignee too → one row to the assignee.
14. an ended assignee → no row for it.

- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/tasks` → FAIL.

- [ ] **Step 3: Implement** the five files. `Notifier.plan` builds a `Map<recipientKey + taskId, {lines, notices, kind}>`, then emits one row per entry: `task_assigned` if the recipient is the new assignee of `task` (and not the actor), otherwise `task_update` with the highest-precedence notice and `taskUpdateBody` of all its lines; comment rows are separate (`task_comment`) and never merged with updates. Exclude the actor (`actor.kind === "agent" && id === actor.agentId`; for humans `userId`), and any agent id not in `live`. `wake` is `"human"` exactly for `task_comment` rows whose `from` is a user and whose `to` is an agent.

- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.

- [ ] **Step 5: Commit** `feat(server): task permission, blocked, bodies and notification planning (pure)`.

---

### Task 5: `TaskStore`: SQL, keys, cycles, the lock-order header

**Files:**
- Create: `apps/server/src/tasks/task-store.ts`, `apps/server/src/tasks/task-store.test.ts`
- Modify: `apps/server/src/agents/event-store.ts` (make the clock public: rename `private stamp()` to `clock()` and keep a private `stamp = () => this.clock()` alias or update call sites)

**Interfaces — Produces** (every method takes `tx: Exec` first; the file's header comment is the spec §13.1 order + the invariant + the two companion rules, verbatim):

```ts
export const TASK_GRAPH_LOCK = 0x5348_0008; // pg_advisory_xact_lock key for dependency edits
export class TaskStore {
  constructor(d: { db: Db; clock: () => Date });
  byNumber(tx, n: number): Promise<TaskRow | undefined>;
  byNumbers(tx, ns: number[]): Promise<TaskRow[]>;
  insertTask(tx, t: { title; body; assigneeAgentId; createdBy: { agentId } | { userId } }): Promise<TaskRow>;
  updateTask(tx, id, set: Partial<Pick<TaskRow, "title" | "body" | "status" | "assigneeAgentId">>): Promise<void>; // bumps updated_at
  touch(tx, id): Promise<void>;
  lockTasks(tx, ids: string[]): Promise<TaskRow[]>;                 // ONE statement, ORDER BY id, FOR NO KEY UPDATE
  lockAgents(tx, ids: string[]): Promise<{ id; kind; archivedAt; terminatedAt }[]>; // ONE statement, FOR SHARE,
                                                                     // ORDER BY (kind = 'ephemeral'), id
  lockGraph(tx): Promise<void>;                                       // pg_advisory_xact_lock(TASK_GRAPH_LOCK)
  dependencies(tx, taskId): Promise<{ id; number; title; status }[]>;
  dependents(tx, taskId): Promise<{ id; number; title; status; assigneeAgentId }[]>;
  depStatuses(tx, taskIds: string[]): Promise<Map<string, { number: number; status: TaskStatus }[]>>;
  cyclePath(tx, taskId, newDepIds: string[]): Promise<number[] | null>; // recursive CTE with UNION; shortest path, ≤ 5 shown
  replaceDependencies(tx, taskId, depIds: string[]): Promise<{ added: string[]; removed: string[] }>;
  replaceLinks(tx, taskId, links: ResolvedLink[]): Promise<void>;     // ResolvedLink = {kind, target | agentId, title?}
  links(tx, taskId): Promise<...>;
  insertComment(tx, c: { taskId; author: { agentId } | { userId }; body }): Promise<TaskCommentRow>;
  insertEvents(tx, rows: { taskId; actor; type; from?; to? }[]): Promise<void>;
  managerChain(tx, agentId): Promise<string[]>;                       // recursive CTE over reports_to, UNION
}
```

- [ ] **Step 1: Failing tests** (real Postgres via `createTestDb()` from `apps/server/src/test/helpers.ts`, seeded agents `lead` (persistent), `dev` (persistent, reports to lead), `kid` (ephemeral, reports to lead), user `or`):
  - `insertTask` twice → numbers 1, 2; `byNumber(2)`.
  - `cyclePath`: T1→T2, T2→T3; adding T3→T1 returns `[3, 1, 2, 3]`-style path (assert it contains 1,2,3 and starts at the task); adding T3→T4 returns null; a pre-existing loop can't hang the query (insert T5→T6, T6→T5 directly with SQL and call `cyclePath` on T5 with a new dep; the `UNION` CTE terminates).
  - `lockAgents(tx, [kid, dev, lead])` returns `lead, dev` (persistent, by id) then `kid` — assert via `EXPLAIN (FORMAT JSON)` of the statement that `LockRows` sits above `Sort` (so lock order is sort order), and assert the returned order.
  - `lockTasks` with three ids returns them sorted by id and a concurrent `select … for no key update` on one of them from a second connection waits (poll `pg_stat_activity` for `wait_event_type = 'Lock'` from the test's third connection, then commit and assert it finishes).
  - `managerChain(kid)` → `[lead]`; a 3-level chain returns both managers.
  - `replaceDependencies` returns added/removed; `replaceLinks` keeps `position` order.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/tasks/task-store.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Key SQL:

```ts
async lockAgents(tx: Exec, ids: string[]) {
  if (!ids.length) return [];
  const rows = await tx.execute(sql`
    select id, kind, archived_at as "archivedAt", terminated_at as "terminatedAt" from agents
    where id = any(${ids}) order by (kind = 'ephemeral'), id for share`);
  return rows as unknown as { id: string; kind: string; archivedAt: Date | null; terminatedAt: Date | null }[];
}
async cyclePath(tx: Exec, taskId: string, newDepIds: string[]): Promise<number[] | null> {
  // Does any new dependency reach taskId? Walk depends_on edges from each new dependency.
  const r = await tx.execute(sql`
    with recursive walk(id, path) as (
      select d, array[d]::text[] from unnest(${newDepIds}::text[]) d
      union
      select td.depends_on_task_id, w.path || td.depends_on_task_id
      from walk w join task_dependencies td on td.task_id = w.id
      where not td.depends_on_task_id = any(w.path) and array_length(w.path, 1) < 1000)
    select path from walk where id = ${taskId} order by array_length(path, 1) limit 1`);
  /* map the id path to numbers, prefix taskId, cut to 5 shown */
}
```

- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): task store with the one lock order`.

---

### Task 6: Message plumbing for the task kinds

Everything that lets a task row travel S6's pipeline, before any service writes one (spec §7.4's change list).

**Files:**
- Modify: `packages/shared/src/messaging.ts` (`MESSAGE_KINDS` + `task_assigned`, `task_comment`, `task_update`; `envelopeSchema` + `taskTitle?`, `commentId?`; `inboxItemSchema` widened in Task 15), `packages/shared/src/agents.ts` (`queueItemSchema` + `taskKey?`, `taskTitle?`, `commentId?`), `packages/shared/src/events.ts` (`process_started.reason` + `"task_message"`)
- Modify: `apps/server/src/supervisor/slots.ts` (`WakeReason` + `"task_message"`, comment: "a task message (S8 §7.4); never wakes an errored agent")
- Modify: `packages/harness/src/envelope.ts` (`BatchRow` + `taskKey?`, `taskTitle?`, `commentId?`; `ORDER` maps the three kinds to 1; `single()` and `merge()` copy `taskKey`, `taskTitle`, `commentId`), `packages/harness/src/types.ts` (`FactoryMessage` + `taskTitle?`, `commentId?`)
- Modify: `apps/server/src/agents/runtimes.ts` (`senderLabel`: no handle and no slug → `"@factory"`)
- Modify: `apps/server/src/agents/agent-runtime.ts` (`toBatchRow`: `taskKey`, `taskTitle`, `commentId`, and `fact` = notice for `task_update`; the queue `itemOf` copies `taskKey`/`taskTitle`/`commentId`)
- Modify: `apps/server/src/agents/event-store.ts` (`joined()` left-joins `tasks` → `taskNumber`, `taskTitle` on `PendingRow`; `bootWakes` counts `'task_assigned','task_comment','task_update'`; `MessageLookup.kind`; `createHumanMessage` per-kind guard, `fromUserId`, `taskId`, `commentId`, `inboxKind`, `exceptUserId`, and returns `{row: undefined, userIds: []}` when no user remains)
- Modify: `apps/server/src/messaging/router.ts` (`handOffTaskRows`)
- Tests: `packages/harness/src/envelope.test.ts`, `apps/server/src/agents/runtimes.test.ts`, `apps/server/src/agents/agent-runtime.delivery.test.ts` (errored/attempt cases), `apps/server/src/agents/event-store.messages.test.ts`, `apps/server/src/messaging/router.test.ts`

**Interfaces — Produces:**
```ts
// PendingRow gains: taskNumber: number | null; taskTitle: string | null
// EventStore:
clock(): Date;
createTaskMessage(tx: Exec, m: { kind: "task_assigned" | "task_comment" | "task_update"; taskId: string;
  commentId?: string; notice?: TaskNotice; from?: { agentId } | { userId }; toAgentId: string; body: string }): Promise<PendingRow>;
createHumanMessage(m: { kind: "message" | "system" | "task_comment" | "task_update"; fromAgentId?: string | null;
  fromUserId?: string; notice?: string; subjectAgentId?: string; taskId?: string; commentId?: string;
  to: { userId: string } | "all"; exceptUserId?: string; inboxKind?: "message" | "mention" | "task_event";
  body: string; urgent: boolean; fromToolUseId?: string | null }, outer?: Exec)
  : Promise<{ row: MessageRow | undefined; userIds: string[] }>;
// Router:
handOffTaskRows(rows: { row: PendingRow; wake: "human" | "task_message" }[]): void;
```

- [ ] **Step 1: Failing tests.**
  - envelope: `renderEnvelopes(groupEnvelopes([taskRow]))` for each kind contains `task="T-7"`; a batch of a notice, a message, a `task_update`, a member update and a peer event orders as notice, message, task_update (created-order with the message), update group, peer; a body containing `</factory-message>` comes out neutralised; `parts`/`taskTitle`/`commentId` survive `single()`.
  - runtimes: `deliver(taskAssignedRow, "agent", "task_message")` on a hibernated agent resolves without throwing and wakes it with reason `task_message` (fake driver, `process_started.reason`); the same for `task_update`.
  - runtime: an errored agent receiving a `task_update` with reason `task_message` stays errored with the row pending and no attempt (`attempting` false); receiving a human `task_comment` via `deliver(row, "human")` starts an attempt (assert `beginAttempt`'s effect: `attempting` true, `process_started.reason === "message"`).
  - event-store: `bootWakes` returns an agent whose only pending row is a `task_update`; `createHumanMessage({kind:"task_update", to:{userId}, inboxKind:"task_event", …})` writes one inbox item kind `task_event`; `({kind:"task_comment", fromUserId:or, to:"all", exceptUserId:or, inboxKind:"mention"})` writes items for every user but `or`; with `or` the only user → no row at all (`row: undefined`).
  - router: `handOffTaskRows` before `bootDone()` doesn't deliver; after it, delivers; after `close()`, delivers nothing; a `deliver` that rejects is logged and never becomes an unhandled rejection (`process.on("unhandledRejection")` spy stays uncalled).
- [ ] **Step 2: Run** the five files → FAIL.
- [ ] **Step 3: Implement.** `handOffTaskRows`:

```ts
handOffTaskRows(rows: { row: PendingRow; wake: "human" | "task_message" }[]): void {
  void this.booted.then(
    () => {
      if (this.closed) return;
      for (const { row, wake } of rows) {
        const p = wake === "human" ? this.d.runtimes.deliver(row, "human") : this.d.runtimes.deliver(row, "agent", "task_message");
        p.catch((err: unknown) => this.d.log.info({ err, message: row.id }, "a task message stays pending"));
      }
    },
    () => {},
  );
}
```

- [ ] **Step 4: Run** the files, then `pnpm vitest run apps/server/src/agents apps/server/src/messaging packages/harness` (S3–S7 stay green) → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): carry task messages through delivery, envelopes and boot`.

---

### Task 7: `TaskService.create` and `update`

**Files:**
- Create: `apps/server/src/tasks/task-service.ts`, `apps/server/src/tasks/task-service.test.ts`
- Modify: `apps/server/src/app.ts` (construct `TaskStore({ db, clock: () => store.clock() })` and `TaskService`; `app.decorate("tasks", …)` and the Fastify type augmentation where the other decorations are declared)

**Interfaces — Produces:**
```ts
export type TaskView = { key: string; title: string; status: TaskStatus; assignee?: string; assigneeEnded?: "archived" | "terminated";
  blockedBy: string[] };
export type ChangeResult = { task: TaskView; changed: string[]; note?: string };
export class TaskService {
  constructor(d: { db: Db; store: EventStore; tasks: TaskStore; router: Router; runtimes: AgentRuntimes; bus: EventBus; log });
  create(actor: Actor, input: { title; body?; assignee?: string | null; dependsOn?: string[]; links?: LinkInput[] }): Promise<ChangeResult>;
  update(actor: Actor, key: string, patch: { title?; body?; status?; assignee?: string | null; dependsOn?; links? }): Promise<ChangeResult>;
}
export async function withDeadlockRetry<T>(fn: () => Promise<T>): Promise<T>; // retries once on postgres code "40P01"
```

The procedure (one private `run(actor, key | null, input)` used by both; comment uses it in Task 8):

```ts
return withDeadlockRetry(async () => {
  const out = await this.d.db.transaction(async (tx) => {
    // 1. unlocked read; which rows to lock comes from the input
    const pre = key ? await this.d.tasks.byNumber(tx, n) : undefined;           // TaskError 404 if missing
    const newDeps = input.dependsOn ? await resolveDeps(tx, input.dependsOn) : undefined; // 400 field errors
    // 2. advisory lock for graph edits
    if (newDeps) await this.d.tasks.lockGraph(tx);
    // 3. task rows in one sorted statement
    const ids = [pre?.id, ...(input.status && pre ? (await this.d.tasks.dependents(tx, pre.id)).map((d) => d.id) : []),
                 ...(newDeps?.map((d) => d.id) ?? [])].filter(Boolean);
    await this.d.tasks.lockTasks(tx, ids);
    // ... re-read dependents; lock newcomers in a second sorted statement
    // 4. re-read under the lock; canChange; compute before/after, blocked states, unblocked list, history rows
    // 5. agents FOR SHARE in one statement: caller (if agent) + assignee(s) + creator agent + dependents' assignees;
    //    caller ended → TaskError("ended", "You can't work on tasks: you were terminated.", 409);
    //    new assignee ended → TaskError("assignee_ended", "@x was terminated and can't be assigned tasks.", 409, "assignee")
    // 6. writes: task row, deps (cycle check first → 400 field "dependsOn"), links, task_events, then
    //    plan() → createTaskMessage / createHumanMessage rows
    return { view, changed, rows, humans: boolean, keys: [pre.key, ...unblockedKeys] };
  });
  // after commit: hand-offs, frames, notes
  this.d.router.handOffTaskRows(out.rows);
  if (out.humans) this.d.bus.publishAll({ type: "inbox_changed" });
  this.d.bus.publishAll({ type: "tasks_changed", keys: out.keys });
  return { task: out.view, changed: out.changed, ...(await this.noteFor(out)) }; // errored note, after commit
});
```

Assignee resolution uses `resolveName(tx, …)` (S6) with the §6.1 sentences: user → "Tasks can only be assigned to agents; @or is a human."; `"me"` → the calling agent (agents only; a human passing "me" gets "No agent or user named 'me'…" from `resolveName`'s reserved branch: use S6's reserved sentence). Agent links resolve by slug to id (`No agent @x.` field error on `links`).

Notes after commit: for each agent recipient of a `task_assigned` row, `runtimes.statusOf(row)` (not inside the tx) → `"@dev is errored; it will see this when a human restarts it."`; `assigneeEnded` → note "The assignee @dev was terminated."

- [ ] **Step 1: Failing tests** (`makeTestApp` with the fake driver, seeded `lead` → `dev`, `qa`, users `or`, `sam`; await deliveries with the runtime harness helpers / `rt.settled()`):
  - create by `@or` with assignee `dev` (hibernated) → `T-1`; `dev`'s first batch holds one `task_assigned` envelope with `task="T-1"` and the §7.3 body (AC 1); `tasks_changed` published with `["T-1"]`; history has `created` and `assignee`.
  - create with `dependsOn: ["T-1"]` → `blockedBy: ["T-1"]`; `dependsOn: ["T-1","T-99"]` → 400 field `dependsOn` "No task T-99."; self → "A task can't depend on itself."; cycle T-1→T-2 then patch T-1 dependsOn T-2 → the cycle sentence.
  - `links: [{kind:"url", target:"javascript:alert(1)"}]` → 400 "Links must be http(s) URLs." (via the schema at the route; the service re-validates with the same schema for MCP); `agent` link to `@nobody` → "No agent @nobody."
  - update by unrelated agent `qa` on a task created by `@or` assigned to `dev` → 403 with the forbidden sentence; by `lead` (dev's manager) → allowed.
  - status `done` by `dev` on T-1 (creator `lead`) where T-2 (assignee `qa`) depends on T-1 → `lead` gets `task_update done`, `qa` gets `task_update unblocked` about T-2, `dev` gets nothing (AC 3).
  - status change + body edit by `@or` → `dev` gets exactly one `task_update` listing both and quoting the new body.
  - reassign `dev` → `qa` by `lead` → `qa` `task_assigned`, `dev` `unassigned`.
  - assigning to an archived agent → 409 "…was archived…"; to a terminated spawned agent → "…was terminated…"; to `@or` → "Tasks can only be assigned to agents; @or is a human."
  - a no-op patch (same status) → `changed: []`, no history row, no message.
  - creator human `sam`, done by `@or` → `sam` gets one inbox item kind `task_event`; `or` gets none.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/tasks/task-service.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): task service create and update with notifications`.

---

### Task 8: `TaskService.comment` and mentions

**Files:** Modify `apps/server/src/tasks/task-service.ts`; Test `apps/server/src/tasks/task-service.comment.test.ts`.

**Interfaces — Produces:**
```ts
comment(actor: Actor, key: string, body: string): Promise<{ id: string; deliveredTo: string[]; mentionedHumans: string[];
  notReached: { name: string; reason: "unknown" | "ambiguous" | "archived" | "terminated" | "reserved" | "too_many" }[] }>;
```

Procedure: `extractMentions(body)` (from `@open-factory/shared/mentions`) before the transaction; names beyond the first 50 → `too_many`; each `skipped` name (offset mismatch, Task 3) → `not_reached` with reason `unknown` (test it). Inside the transaction (spec §13.1): lock the task row (no dependents), re-read it, resolve each name with `resolveName(tx, name)` (`humans` → all; user → user; agent → candidate; `reserved`/`none`/`ambiguous` → `not_reached`; the author → skipped silently), lock agents `FOR SHARE` (caller, assignee, candidate agents), drop ended ones into `not_reached` with their reason (the ended assignee too), insert the comment, touch the task, `plan()` with `comment`, write rows. Result `deliveredTo` = agent slugs written to (assignee included); `mentionedHumans` = `["@humans"]` or the handles.

- [ ] **Step 1: Failing tests:**
  - AC 2 server side: `dev` comments on T-1 (assigned to `dev`, created by `@or`) "@or can you confirm?" → `or` has one unread `mention` item linking `{kind:"task", key:"T-1", commentId}`; nothing to `dev`; result `mentionedHumans: ["@or"]`.
  - `@or` comments "@dev yes" → `dev` receives `task_comment` from `@or` (envelope `from="@or" kind="task_comment" task="T-1"`); wake reason `message`.
  - `@humans` from an agent → every existing user gets one item; a user created afterwards gets none; `@humans` by `@or` → every user but `or`.
  - mention inside inline code / fence → nothing; `@nobody` (unknown), a name held by both a user and an agent (inserted with raw SQL: ambiguous), `@me` (reserved), a terminated spawned agent, an archived agent → `not_reached` reasons in order.
  - 51 distinct mentions → 50 resolved, the rest `too_many`.
  - an unrelated agent may comment (no 403).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): task comments and mentions`.

---

### Task 9: The five MCP tools, for every agent

**Files:**
- Create: `apps/server/src/mcp/tools/{create-task,update-task,list-tasks,get-task,comment-task}.ts`, `apps/server/src/mcp/tools/task-tools.test.ts`
- Modify: `apps/server/src/app.ts` (`tools: (caller) => [sendMessageTool, listPeersTool, ...taskTools(d.tasks), ...(maySpawn(caller) ? […] : [])]`), `apps/server/src/tasks/task-service.ts` (`list(actor, filter)`, `get(key, commentsBefore?)` read methods returning the §9 shapes)

**Interfaces — Produces:** `taskTools(tasks: TaskService): ToolRegistration[]`. Each handler: `callerOf(tctx)` → the actor `{kind:"agent", agentId, slug}` (slug from `store.agentById`); `TaskError` → `toolError(e.message)`; result → `textResult` with the snake_case §9 shape (`blocked_by`, `assignee_ended`, `earlier_comments`, `delivered_to`, `mentioned_humans`, `not_reached`, `more`, `note`).

`list_tasks`: default status `["open","in_progress"]`, `limit` default 50 (max 200), newest updated first; cut → `more: true` and `note: "Showing the 50 most recently updated; pass a larger limit (max 200) or narrow the filter."`. `get_task`: newest 50 comments before `comments_before` (or the end), oldest first, `earlier_comments`, and when > 0 `note: "N earlier comments; call get_task with comments_before=<first id> for them."`. Tool descriptions: parameter semantics only (e.g. create_task: "Create a task. Assigning sends it to that agent's session."), no workflow rules.

- [ ] **Step 1: Failing tests** (real `fetch` against the port-0 agent listener with `mcpCall`/`callTool` from `apps/server/src/mcp/testing/mcp-client.ts`, real tokens minted the way `server.test.ts` does):
  - `tools/list` for a persistent agent without `can_spawn` and for a spawned agent: exactly `send_message`, `list_peers` + the five; a spawner: + `spawn_agent`, `terminate_agent`.
  - `create_task` by `lead` with `assignee:"me"` → assigns `lead`, no message written; with `depends_on`, `links`; `update_task` with `assignee: null` unassigns; an unrelated agent's `update_task` → `isError` with the forbidden sentence; its `comment_task` succeeds.
  - `list_tasks {unassigned:true}`, `{assignee:"me"}`, `{created_by:"@or"}`, `limit` cut with `more`.
  - `get_task` with 60 comments → 50, `earlier_comments: 10`, the note; `comments_before` returns the 10.
  - identity: `create_task` from `qa`'s token records `created_by` `qa` whatever the arguments contain.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/mcp/tools/task-tools.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm vitest run apps/server/src/mcp` (S6/S7 listings updated where they assert exact tool lists); `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): factory MCP task tools`.

---

### Task 10: Live gate 2: `pnpm smoke:tasks --early` (first slice, haiku, Docker)

Run as soon as the tools exist (spec §17.5): tool listing, a human-created assignment, `get_task`, `comment_task` with a mention. The script grows to the full run in Task 23.

**Files:**
- Create: `apps/server/scripts/smoke-tasks.ts`
- Modify: `package.json` (`"smoke:tasks": "node --env-file-if-exists=.env --import tsx apps/server/scripts/smoke-tasks.ts"`)

- [ ] **Step 1: Write the script**, copying `smoke-messaging.ts`'s scaffolding verbatim (token read from `~/.open-factory-spike/oauth-token` into a factory credential, `redact`/`say`/`ok`/`fail`, throwaway database, temp `FACTORY_HOME`, Docker on `open-factory-base:dev`, `--local` option, cleanup). Org: `dev` and `qa` (persistent, top-level), users `or` and `sam`. It talks to the app **only** through real REST routes (`app.inject` with a signed-in cookie, as `smoke-messaging.ts` does) and the agents talk through the real MCP. Steps for `--early`:
  1. Start the app; seed templates/agents through REST.
  2. `POST /api/tasks {title:"Smoke one", body:"Read this task with get_task, then comment on it mentioning @or with one short question.", assignee:"dev"}` as `or`.
  3. Wait (poll the agent's session events through `GET /api/agents/dev/events`, at most 180 s overall, as `smoke-messaging.ts` waits) for `system/init`: assert its tools include `mcp__factory__create_task`, `update_task`, `list_tasks`, `get_task`, `comment_task`.
  4. Assert the first `message_in` holds a `task_assigned` envelope with `taskKey: "T-1"`.
  5. Assert `dev` called `mcp__factory__get_task` and `mcp__factory__comment_task`, and `or`'s `GET /api/inbox` has one unread `mention` linking `T-1` and a comment id.
  Print PASS/FAIL per step; exit 1 on any failure.
- [ ] **Step 2: Run** `pnpm build && pnpm smoke:tasks --early` (Docker running). Expected: all PASS. If a step fails because of a defect (not model wording), fix it test-first in the owning task's files before going on; record the defect in the commit message.
- [ ] **Step 3: Save the output** (already redacted) to paste into the PR; never commit it.
- [ ] **Step 4: Commit** `chore(server): live task smoke, first slice`.

---

### Task 11: Concurrency and lock-order tests (spec §13)

**Files:** Test `apps/server/src/tasks/task-races.test.ts` (real Postgres; a helper `waitForLock(sql, pid)` that polls `select wait_event_type from pg_stat_activity where pid = $1` until `'Lock'`, with no sleep longer than one event-loop turn between polls, bounded by the suite's normal test timeout, never raised).

- [ ] **Step 1: Write the tests** (they should pass against Task 7/8's code; any failure is a defect to fix in `task-service.ts`/`task-store.ts`):
  1. **Termination first:** test connection `A` begins, `select … from agents where id = dev for no key update`, `update agents set terminated_at = now(), terminated_by = '@or' where id = dev`; start `tasks.create(or, {assignee:"dev"})`; `waitForLock`; commit `A`; the create rejects with "@dev was terminated and can't be assigned tasks." (use a spawned `dev` so `terminated_at` passes the CHECK).
  2. **Assignment first:** connection `A` runs `LOCK TABLE messages IN SHARE MODE` in an open transaction; start the create; `waitForLock` on it; start the real `app.terminator.terminate(devId, "@or")`; `waitForLock` on the terminator's backend (find it by `query ilike '%agents%' and wait_event_type = 'Lock'`); commit `A`; await both; the `task_assigned` row is `rejected`, the task's assignee is still `dev`.
  3. **Archive vs comment-mention:** archive first → `not_reached: archived`; comment first (same `LOCK TABLE messages` technique) → the archive waits, then the row is rejected at hand-off (assert `state = 'rejected'` after `rt.settled()`).
  4. **Review deadlock shape:** Y1 depends on X and Y2; Y2 depends on X; mark X done and Y2 done concurrently (two `update` calls started together) → both succeed, no `40P01` surfaced; Y1's assignee gets exactly one `unblocked`.
  5. **Two dependencies finishing together:** T3 depends on T1 and T2; mark T1 and T2 done concurrently → T3's assignee gets exactly one `unblocked`.
  6. **Edge vs done:** patch T5 `dependsOn: ["T4"]` concurrently with T4 → done → T5's assignee gets exactly one `unblocked` or none (when the edge transaction saw T4 done), never zero with T5 left blocked by a done T4 (assert final `blockedBy(T5) === []` and the count is consistent with the order observed in history).
  7. **Concurrent cycle:** T6→T7 and T7→T6 patched concurrently → exactly one refused with the cycle sentence.
  8. **Assignee re-check:** `dev`'s `update_task` racing `@or` reassigning to `qa` (hold `LOCK TABLE messages` so the reassignment commits first) → `dev`'s change is refused with the forbidden sentence.
  9. **Comment racing reassignment** → the comment goes to the assignee read under the lock (`qa`), not `dev`.
  10. **Deadlock retry:** inject a `40P01` once via a wrapped `db` whose first `transaction` call throws `Object.assign(new Error("deadlock"), {code:"40P01"})` → the operation succeeds; two in a row → the operation fails with exactly "The task changed while you were editing it; try again." (tool error; REST `409 task_conflict`), never a raw 500.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/tasks/task-races.test.ts` → PASS (fix defects test-first if not).
- [ ] **Step 3:** `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 4: Commit** `test(server): task lock order, races and deadlock retry`.

---

### Task 12: Lifecycle interactions (spec §14)

**Files:** Test `apps/server/src/tasks/task-lifecycle.test.ts` (fake driver, runtime harness helpers; no sleeps).

- [ ] **Step 1: Tests** (fix defects test-first where they fail):
  - errored assignee: `task_assigned` pending, no attempt, create result note "@dev is errored; it will see this when a human restarts it."; a human comment starts an attempt; an agent comment doesn't.
  - hibernated assignee wakes with `task_message`; warm idle delivered at once; mid-turn written mid-turn (S6 harness pattern).
  - credential rate-limited: rows wait; after the reset they go out.
  - shutdown begun (`router.close()`): a task change commits, nothing handed over; a new app on the same DB boots and delivers once (seen-id dedupe: exactly one `message_in` with that id).
  - commit then crash before hand-off (call the service with `router` swapped for a stub whose `handOffTaskRows` is a no-op), then boot → delivered once.
  - before `bootDone`: hand-off waits.
  - terminated caller past the listener: call `tasks.update` with a terminated agent actor → "You can't work on tasks: you were terminated."
  - spawner terminates a child with an assigned task → pending task rows `rejected`; the task keeps the ended assignee; `get_task` shows `assignee_ended: "terminated"`.
  - spawner may change its child's task (manager rule).
  - unarchive: nothing retroactive (no rows written while archived).
  - "Start a new session" with only a `task_update` queued starts an attempt (documents S5's rule).
  - one namespace: a user and an agent named `x` (raw SQL) → assignee `x` gets S6's "matches both" sentence.
- [ ] **Step 2: Run** → PASS. `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 3: Commit** `test(server): task lifecycle interactions`.

---

### Task 13: The generated CLAUDE.md: kinds, `@factory`, Tasks section

**Files:** Modify `apps/server/src/workspace/claude-md.ts`; Test `apps/server/src/workspace/claude-md.test.ts`.

- [ ] **Step 1: Failing tests:** the "How messages reach you" paragraph lists the kinds `message`, `system`, `member_update`, `peer_joined`, `peer_left`, `task_assigned`, `task_comment`, `task_update`, says a task envelope's `task` names the task, and its `@factory` parenthetical reads "(restarts, recoveries, rate limits, changes to your neighborhood and task changes)"; a `## Tasks` section follows `## Messaging` with exactly the seven bullets of spec §10 (assert each line); output byte-identical for the same input; present for spawned agents too.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/workspace/claude-md.test.ts` → FAIL. **Step 3: Implement** `tasksSection()` returning the seven lines verbatim from spec §10 (tool names as `mcp__factory__create_task`, then `update_task`, `list_tasks`, `get_task`, `comment_task` as in the spec). **Step 4: Run** → PASS (update existing snapshot assertions deliberately); `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): tasks guidance in the generated CLAUDE.md`.

---

### Task 14: Task REST, response schemas, `openTasks`, `tasks_changed`

**Files:**
- Create: `apps/server/src/routes/tasks.ts`, `apps/server/src/routes/tasks.test.ts`
- Modify: `packages/shared/src/tasks.ts` (response schemas), `packages/shared/src/ws.ts` (`tasks_changed {keys: string[]}`), `packages/shared/src/agents.ts` (`openTasks: z.number().int().nonnegative()`), `apps/server/src/agents/agent-service.ts` (count open + in-progress assigned tasks for the shown rows in the same summary query pattern as `reports`), `apps/server/src/app.ts` (register `tasksRoutes`)

**Interfaces — Produces** (shared):
```ts
export const taskAgentRefSchema = z.object({ slug: z.string(), displayName: z.string(), ended: z.enum(["archived","terminated"]).optional() });
export const taskPrincipalSchema = z.union([z.object({ kind: z.literal("agent"), slug: z.string() }), z.object({ kind: z.literal("user"), handle: z.string() })]);
export const taskSummarySchema = z.object({ key: z.string(), title: z.string(), status: z.enum(TASK_STATUSES),
  assignee: taskAgentRefSchema.nullable(), blockedBy: z.array(z.string()), createdBy: taskPrincipalSchema, updatedAt: z.string() });
export const taskPageSchema = z.object({ tasks: z.array(taskSummarySchema), nextCursor: z.string().nullable() });
export const taskLinkSchema = z.object({ kind: z.enum(TASK_LINK_KINDS), target: z.string().optional(),
  agent: taskAgentRefSchema.optional(), title: z.string().optional() });
export const taskActivitySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("comment"), id: z.string(), author: taskPrincipalSchema, authorName: z.string().optional(), body: z.string(), at: z.string() }),
  z.object({ type: z.literal("event"), id: z.string(), actor: taskPrincipalSchema,
    event: z.enum(["created","status","assignee","title","body","depends_on","links"]),
    from: z.unknown().optional(), to: z.unknown().optional(), at: z.string() }),
]);
export const taskDetailSchema = taskSummarySchema.extend({ body: z.string(), createdAt: z.string(),
  dependsOn: z.array(z.object({ key: z.string(), title: z.string(), status: z.enum(TASK_STATUSES), blocked: z.boolean() })),
  blocks: z.array(/* same */), links: z.array(taskLinkSchema), activity: z.array(taskActivitySchema) });
export const taskChangeResponseSchema = z.object({ task: taskDetailSchema, note: z.string().optional() });
export const taskCommentResponseSchema = z.object({ comment: /* activity comment */, deliveredTo: z.array(z.string()),
  mentionedHumans: z.array(z.string()), notReached: z.array(z.object({ name: z.string(), reason: z.string() })) });
```

History `from`/`to` for `assignee` are rendered server-side as slugs; `depends_on` as keys; `body` has none.

- [ ] **Step 1: Failing tests:**
  - every route (`GET/POST /api/tasks`, `GET/PATCH /api/tasks/:key`, `POST /api/tasks/:key/comments`) without a session → 401, and with `Authorization: Bearer <a live agent token>` (minted as `server.test.ts` does for a running fake agent) → 401.
  - `GET /api/tasks` default filter (open + in progress), `status=all`, `status=done&status=cancelled`, `assignee=dev`, `unassigned=true`, `creator=me`, `creator=@sam`, `keys=T-1,T-3`, cursor paging (newest updated first, `updatedAt desc, id`), invalid cursor → 400 field `before`.
  - `POST` returns 201 with the detail; `javascript:` link → 400 field `links`; `PATCH` with cycle → 400 field `dependsOn`; unknown key → 404 `task_not_found`; ended assignee → 409 `assignee_ended`.
  - `GET /api/tasks/:key` returns activity oldest first, comments and events interleaved by time; `blocks` lists dependents with `blocked`.
  - `GET /api/agents` items carry `openTasks`.
  - a create publishes `{type:"tasks_changed", keys:["T-1"]}` to a connected WebSocket (use the ws test pattern in `apps/server/src/ws/ws.test.ts`).
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/routes/tasks.test.ts` → FAIL. **Step 3: Implement** (`requireUser` as `onRequest` hook, like `inbox.ts`; `TaskError` → `ApiError(status, code, message)` or `FieldError(field, message)`). **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): task REST routes and open task counts`.

---

### Task 15: Inbox server: kinds, read state, mark all read with exact undo, per-user frames

**Files:**
- Modify: `packages/shared/src/messaging.ts` (`inboxItemSchema`: `kind`, `read`, `task?: {key, title}`, `fact?: "done"|"cancelled"`, `from.kind` + `"human"`, `link` union `{kind:"session", agentSlug, seq?} | {kind:"task", key, commentId?}`; `readAllResponseSchema {readAt, count}`, `unreadCountSchema {count}`)
- Modify: `apps/server/src/agents/event-store.ts` (`inboxPage(userId, before, limit, {unread})` labels by kind and sender columns; `markRead`, `markAllRead`, `undoReadAll`, `unreadCount`, all `read_at` from `clock()`)
- Modify: `apps/server/src/agents/event-bus.ts` (`subscribeUser(userId, fn)`, `publishToUser(userId, m)`), `apps/server/src/ws/route.ts` (subscribe each socket to its user)
- Modify: `apps/server/src/routes/inbox.ts`; Test `apps/server/src/routes/inbox.test.ts`

- [ ] **Step 1: Failing tests:**
  - a mention item: `kind:"mention"`, `from:{kind:"agent", name:"dev"}` (or `{kind:"human", name:"sam"}` for a human author, not "factory"), `task:{key:"T-1", title}`, `link:{kind:"task", key:"T-1", commentId}`; a task event: `kind:"task_event"`, `fact:"done"`, `from.kind:"factory"`, `link:{kind:"task", key}`; S6 items unchanged except `link.kind:"session"`.
  - `POST /api/inbox/:id/read` marks only the caller's item; another user's id → 404 `inbox_item_not_found`; idempotent (second call keeps the first `read_at`).
  - `GET /api/inbox?unread=true&limit=5`.
  - `POST /api/inbox/read-all {upTo}` marks items created at or before `upTo` (an item created after stays unread) and returns `{readAt, count}`; `POST /api/inbox/read-all/undo {readAt}` (the JSON-echoed value) restores exactly those (an item read earlier by click stays read); another user's items are untouched.
  - `GET /api/inbox/unread-count`.
  - read changes publish `inbox_changed` to the reading user's sockets only (two users connected, assert the other received nothing); new items still publish to all.
  - agent token → 401 on every inbox route.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/routes/inbox.test.ts apps/server/src/agents/event-store.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): inbox kinds, read state and mark all read with undo`.

---

### Task 16: Web foundations: task API, badge, status label, shared component props, frames

**Files:**
- Create: `apps/web/src/features/tasks/api.ts`, `task-badge.tsx`, `status-label.tsx`, `features/tasks/task-badge.test.tsx`
- Modify: `apps/web/src/routes/_app.tsx` (`tasks_changed` → invalidate `["tasks"]` and `["agents"]`; `inbox_changed` → also `["inbox-unread"]`), `apps/web/src/features/session/copy-link.tsx` (`url` + `label` props; existing callers pass the event URL and "Copy link"), `apps/web/src/components/route-states.tsx` (`ResourceNotFound` gains `detail?: string`, `backTo` adds `"/tasks"`; default detail stays "It may have been renamed or deleted."), `apps/web/src/features/session/message-block.tsx` (`badge?: ReactNode` after the sender)

**Interfaces — Produces:** `taskQueryKey`, `tasksPageOptions(filters)`, `taskDetailOptions(key)`, `createTask`, `patchTask`, `postComment`, `lookupTasks(keys)`; `<TaskBadge taskKey title link? />` (link → `/tasks/$key` with optional `comment` search); `<StatusLabel status />` (icon + label per UI doc §1); `<BlockedMarker keys />`.

- [ ] **Step 1: Failing tests:** `TaskBadge` renders mono key, muted " · ", title truncating; as a link its accessible name is "Task T-42: Plan the billing migration"; without title only the key; `StatusLabel` renders the icon `aria-hidden` and the label text for each status; `CopyLink` with a custom url/label copies that url; `ResourceNotFound` renders a given `detail`.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/tasks apps/web/src/test/route-states.test.tsx` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): task API, badge and status label`.

---

### Task 17: Web: Tasks list (`/tasks`)

**Files:**
- Delete: `apps/web/src/routes/_app/tasks.tsx`; Create: `routes/_app/tasks.index.tsx` (`validateSearch`: `status` enum incl. `all` default `open_in_progress`, `assignee?`, `unassigned?`, `creator?`), `features/tasks/task-list.tsx`, `task-filters.tsx`, `features/tasks/task-list.test.tsx`
- Regenerate `apps/web/src/routeTree.gen.ts` with `pnpm --filter @open-factory/web build` and commit it.

- [ ] **Step 1: Failing tests** (`renderApp` + `mockApi` from `apps/web/src/test/`): rows render per UI doc §5 (key mono, status label, assignee or "Unassigned", ended "· terminated", line 2 blocked/created/updated); each row is one link named "T-42, Plan the billing migration, In progress, blocked by T-41, assigned to @dev"; changing the Status select updates the URL search and refetches; "Created by" options are Anyone · Me · agents; empty default filter → "No open tasks." + "Show all tasks"; empty after "Show all" → "No tasks yet."; empty with another filter → "No tasks match these filters." + "Clear filters"; load more and its failure line; `tasks_changed` refetches without losing focus on a row; "New task" header action is a ghost link to `/tasks/new`.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/tasks/task-list.test.tsx` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): tasks list with filters`.

---

### Task 18: Web: create page (`/tasks/new`) and the shared editors

**Files:** Create `routes/_app/tasks.new.tsx`, `features/tasks/task-form.tsx`, `agent-picker.tsx`, `dependency-editor.tsx`, `link-editor.tsx`, `link-list.tsx`, `features/tasks/task-form.test.tsx`; regenerate `routeTree.gen.ts`.

- [ ] **Step 1: Failing tests:** validation on blur not while typing, everything on submit with focus to the first invalid field, exact sentences (UI doc §6, §8.2, §8.3); dependency keys resolved in one `GET /api/tasks?keys=` on leave; server field error (cycle) shown under Depends on; "Creating…" while pending; non-field failure → "Couldn't create the task. Try again." in `role="alert"`; success navigates to `/tasks/T-42`; Cancel goes back without a dialog; link editor add/remove rows and `javascript:` refused.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): create task page`.

---

### Task 19: Web: task detail (`/tasks/$key`)

**Files:** Create `routes/_app/tasks.$key.tsx` (`validateSearch: { comment: z.string().min(1).optional().catch(undefined) }`), `features/tasks/task-detail.tsx`, `status-menu.tsx`, `assignee-menu.tsx`, `task-activity.tsx`, `comment-block.tsx`, `comment-composer.tsx`, tests `features/tasks/task-detail.test.tsx`; regenerate `routeTree.gen.ts`.

- [ ] **Step 1: Failing tests:**
  - header shows the key in mono with the "Tasks" back link; `document.title`.
  - Status and Assignee are menu triggers ("Status: In progress"); arrow keys inside the open menu don't PATCH; Enter on an item PATCHes once; announcer says "Status set to in progress" / "Assigned to @dev"; a failed PATCH reverts and shows the server sentence in an alert region.
  - ended assignee shows "@dev · terminated" and "Assignee: Choose an agent…".
  - title edit: focus into input, Enter saves, Escape cancels, focus returns to "Edit title"; hint "Saving sends the new title to @dev."; body edit: Escape doesn't cancel, Save/Cancel return focus to "Edit description", "Saving…", "Couldn't save. Try again." keeps text.
  - activity: comments and history interleaved oldest first with the exact history strings (UI doc §7); a human author not linked; Reply puts "@dev " at the composer start and focuses it.
  - composer: disabled while empty, ⌘/Ctrl-Enter posts, "Posting…", failure keeps the draft; helper line by assignee; `notReached` line lists only present reasons.
  - `?comment=<id>` of an agent comment: scrolled into view, `data-highlighted`, focused, composer prefilled "@dev "; of a human comment: no prefill; unknown id → "Comment not found. Showing the task."
  - `/tasks/T-999` → "Task not found." / "No task T-999." / "Back to tasks".
  - `tasks_changed` for this key refetches and keeps an open editor's text.
  - **Agent text is inert (spec §15), one test:** a task body and a comment containing `<script>alert(1)</script>`, `<img src=x onerror=alert(1)>` and `[x](javascript:alert(1))` render with no `script` or `img` element in the container and no anchor whose `href` starts with `javascript:`; a title `<b>x</b>` renders as the literal text `<b>x</b>` (no `b` element). This guards against a later Markdown change silently dropping the guarantee.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (menus via `DropdownMenu` + `DropdownMenuRadioGroup`, the Theme menu's pattern in `app-sidebar.tsx`; the highlight reuses the session timeline's `data-highlighted` CSS). **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): task detail with activity, comments and deep links`.

---

### Task 20: Web: inbox read state, mark all read, sidebar count, Home panel

**Files:** Modify `features/inbox/inbox-list.tsx` (extract `inbox-row.tsx`), `features/inbox/api.ts` (`markRead`, `markAllRead`, `undoReadAll`, `useUnreadCount`), create `features/inbox/mark-all-read.tsx`; modify `components/app-sidebar.tsx`, `routes/_app/index.tsx`, `routes/_app/inbox.tsx`; tests `features/inbox/inbox-list.test.tsx` (extend), `test/shell.test.tsx` (count), `test/empty-states.test.tsx` (Home).

- [ ] **Step 1: Failing tests:** unread dot (ink, `aria-hidden`), weight 500, accessible name starts "Unread, "; sender line per kind (mention, task event with "Done" icon+label from `fact`, S6 message); opening (click, Enter, middle-click via `onAuxClick`) marks read optimistically and decrements the count before navigating, and a failing POST rolls both back; targets per kind; "Mark all read" sends `upTo` = newest loaded `createdAt`, rows turn read, `InlineOutcome` "Marked 7 items as read." with focus on Undo; Undo restores and returns focus to "Mark all read"; failure strings; the button remains while unread > 0; sidebar shows "3", "99+", nothing at 0, accessible name "Inbox, 3 unread", collapsed rail dot and tooltip; Home panel lists 5 unread from `?unread=true&limit=5` or "Nothing unread."
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): inbox read state, mark all read and unread count`.

---

### Task 21: Web: task messages in the session and the strip's open tasks

**Files:** Modify `features/session/timeline-row.tsx` (pass `badge` for the three kinds, `system` sender for `task_assigned`/`task_update`), `features/session/queue-items.tsx` (pending task rows show the badge), `features/session/agent-strip.tsx` ("3 open tasks" link); tests `features/session/messaging.test.tsx` (extend), `features/session/agent-strip.test.tsx`.

- [ ] **Step 1: Failing tests:** a `message_in` with a `task_assigned` envelope renders "Factory" + badge linking `/tasks/T-1`; a `task_comment` from `@or` renders the human sender + badge linking `/tasks/T-1?comment=<id>`; a `task_update` with `fact:"unblocked"` renders as a message block (no prose parsing); pending queue item with `taskKey` shows the badge in the dashed block; strip shows "1 open task" / "3 open tasks" linking `/tasks?assignee=dev`, hidden at 0.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): task badges in the session and open tasks in the strip`.

---

### Task 22: Browser notifications (last, separable)

If the PR is too large, this task moves to a follow-up issue unchanged; nothing else depends on it.

**Files:** Create `apps/web/src/features/inbox/notifications.ts`, `notifications.test.ts`; modify `components/app-sidebar.tsx` (the `DropdownMenuCheckboxItem` under Theme), `routes/_app.tsx` (after an inbox refetch, hand new unread items to the notifier).

**Interfaces — Produces:** `useBrowserNotifications()` → `{supported, enabled, blocked, toggle()}`; `notifyNewItems(items, seen: Set<string>)`.

- [ ] **Step 1: Failing tests** (stub `globalThis.Notification` and `document.visibilityState`): unsupported → item absent; toggle calls `requestPermission` from the click; denied → stays off with "Blocked by your browser. Allow notifications for this site to turn them on." and the menu stays open (`onSelect` `preventDefault`); revoked permission reads as off; hidden tab + new unread item → one `new Notification(title, {body, tag: item.id, icon: "/favicon.svg"})` with the UI doc §10 titles and a 120-char plain-text body; visible tab → none; an already seen item → none; click → `window.focus()`, mark read, navigate to the item's target.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/inbox/notifications.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): opt-in browser notifications for new inbox items`.

---

### Task 23: Final live check and verification

- [ ] **Step 1: Extend `smoke-tasks.ts` to the full run** (without `--early`): after the early steps, **first** `or` creates T-2 with `dependsOn: ["T-1"]` assigned to `qa` (before the comment below, so the model can't mark T-1 done first and race the assertion); **then** `or` posts `POST /api/tasks/T-1/comments {body:"@dev Yes. Mark the task done when you have read this."}`; assert `dev` receives a `task_comment` from `@or` and calls `update_task` with `status: "done"`; assert `or`'s inbox has a `task_event` with `fact: "done"` (or created T-1); assert `qa` receives a `task_update` with `fact: "unblocked"` about T-2; assert no request carried an `Origin` header (as S6). Run `pnpm build && pnpm smoke:tasks` → all PASS. Keep the redacted output for the PR.
- [ ] **Step 2: Full verification** (all must pass; paste the summary lines into the PR):

```bash
pnpm compose up -d
pnpm test
pnpm typecheck
pnpm lint:ci
pnpm build
```

- [ ] **Step 3: Manual browser pass** (`pnpm dev`, two users): AC 1 (create assigned to an agent, see it in the session with the badge), AC 2 (agent mentions you, inbox unread item, click → highlighted comment, reply with the prefill, agent continues), AC 3 (done unblocks a dependent), AC 4 (an agent's refused change visible in its session as a tool error), AC 5 (read state, mark all read + undo, second tab updates, sidebar count). Both themes, one phone-width pass. Note anything off and fix it test-first before the PR.
- [ ] **Step 4: Record verification** in `packages/harness/fixtures/README.md` ("Verified in S8 implementation": the smoke result lines, Claude version) and commit `docs: record S8 live verification`.

---

### Task 24: Pull request

- [ ] **Step 1:** `git push`; open the PR against `spec/s7-spawning` (stacked) following `.github/pull_request_template.md` and AGENTS.md:
  - **Title:** `feat: tasks, mentions and the inbox with read state`
  - **What:** tasks with dependencies, links, comments and history; five MCP task tools; `task_assigned`/`task_comment`/`task_update` messages; mentions; inbox read state, mark all read with undo, deep links, unread count; Tasks pages; browser notifications.
  - **Why:** the S8 roadmap item; link the spec `docs/superpowers/specs/2026-11-20-s8-tasks-inbox-design.md`, the UI design, this plan and the decision issue #59.
  - **Approach** (one bullet per decision, "X, rather than Y, because Z"): factory-sent `task_assigned`/`task_update` rather than actor-sent, because senders stay truthful; one permission function rather than per-route checks, because REST and MCP must agree; inbox via message rows rather than polymorphic items, because one pipeline and one resolver; one written lock order (tasks before agents) rather than serializable retries, because it is reviewable and deterministic; mentions through the UI's markdown parser rather than a regex, because "in code" can't drift; menus for immediate-apply controls rather than native selects, because arrow keys would assign and wake agents; no `turns.task_id` write rather than a stored column, because S10 derives it (#62).
  - **Changes** grouped by area (shared, db, server tasks, server messaging/inbox, MCP, CLAUDE.md, web tasks, web inbox, smoke).
  - **Non-goals:** project filter, Unread/All filter, mark-as-unread, comment edit/delete, task delete, CLI, caps, `turns.task_id`, search. Follow-ups #60, #61, #62; #47 touched (note added); #48, #49 untouched.
  - **Verification:** both smoke outputs (early and full, redacted), the test/typecheck/lint/build lines, the manual pass. New direct dependencies (the three exact pins) called out; no supply-chain setting changed.
  - Remove the template's HTML comments; end with the attribution line from the session's system reminder.
- [ ] **Step 2:** Report the PR URL to the lead.

---

## Acceptance criteria → tasks

| AC | Proven by |
|---|---|
| 1 Assignment reaches the session | Task 7 (server), Task 21 (UI), Task 10/23 (live), Task 23 manual |
| 2 Mention, reply, continue | Task 8, Task 15, Task 19, Task 20, Task 10/23 |
| 3 Done unblocks | Task 4, Task 7, Task 11 (races), Task 23 |
| 4 Permissions and REST auth | Task 4, Task 7, Task 9, Task 14, Task 15 |
| 5 Read state | Task 15, Task 20 |
| 6 Ended agents | Task 7, Task 11 (§13.3 both orders), Task 12 |
| 7 Mentions in code | Task 3, Task 8 |
| 8 CI and live | Task 23 |

## Spec §17 tests → tasks

§17.1 unit → Tasks 1, 3, 4, 5, 13. §17.2 tools over HTTP → Task 9; notifications → Tasks 6, 7; mentions → Task 8; ended and lifecycle → Tasks 11, 12; inbox → Task 15; REST auth → Tasks 14, 15. §17.3 harness → Task 6. §17.4 web → Tasks 16–22. §17.5 live → Tasks 1, 10, 23. §18 V1 → Task 1; V3 → Task 2; V4 → Task 3; V5 → Task 11.
