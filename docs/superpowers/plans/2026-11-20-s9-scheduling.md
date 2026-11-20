# S9 Scheduling Implementation Plan

> **For agentic workers:** this plan is executed by one developer working **directly** (no implementer subagents), task by task, **test-first**, **one commit per task**. You read your inbox only between tool calls, so tasks are small and independent. Steps use checkbox (`- [ ]`) syntax for tracking. Use superpowers:executing-plans for the checkpoints.

**Goal:** Timed work without idle heartbeats: durable factory schedules (cron or one-shot, per-schedule IANA zone) that deliver `scheduled` messages from `@scheduler`, replace instead of stacking, fire once after downtime; three MCP tools for persistent agents; a Schedules page; and, for Claude Code's in-session crons, a live list on the agent status and a **Stop crons** action.

**Architecture:**
- `packages/shared`: `cron.ts` (plain 5-field Vixie validation, croner wrappers, zones, DST-safe `at` parsing, occurrence math), `keys.ts` (`T-`/`S-` keys), `schedules.ts` (tool, REST and response schemas, states), the `scheduled` message kind, envelope/queue fields, the `scheduled` wake reason, `crons_stopped` reasons, the `schedules_changed` frame, agent summary fields (`crons`, `cronZone`, `scheduleCount`, `stopCronsPending`).
- `packages/db`: one migration (`schedules` + sequence, `messages` columns, the CHECK rewrite, the partial unique index).
- `packages/harness`: `cron_created.durable`; envelope attributes `schedule`, `by`, `due`, `firings`, `late`.
- `apps/server/src/scheduling/` (new): `limits.ts`, `ScheduleStore` (SQL, the lock-order header), `ScheduleService` (create/edit/pause/resume/delete/restore/list, limits, `recomputeFromNow`), `Scheduler` (one timer, the tick, the firing transaction, catch-up, backoff, hand-off).
- `apps/server` elsewhere: runtime plumbing (`@scheduler` sender, monotonic refresh, flush re-read, `writeBatch` write-back, `stopCrons`, `isPassive`), boot clear of stale write marks, termination and unarchive touching schedules, three MCP tools, CLAUDE.md Scheduling section, `FACTORY_TIMEZONE`, REST routes.
- `apps/web`: `features/schedules/` (list, create, edit), session scheduled blocks, the strip's crons popover with Stop crons and the schedules segment.

**Tech Stack:** Node 24, TypeScript 7, Fastify 5, Drizzle + postgres.js (Postgres 18), Zod 4, `@modelcontextprotocol/server` 2.4.0, React 19 + TanStack Router/Query, Tailwind 4 + shadcn/ui, Vitest + Testing Library, Biome. **One new direct dependency:** `croner` (exact pin, `packages/shared` only; Task 2).

**Spec:** `docs/superpowers/specs/2026-11-20-s9-scheduling-design.md` (it wins over this plan on any conflict) and the UI design `docs/superpowers/designs/2026-11-20-s9-scheduling-ui-design.md`. Decision log: https://github.com/orlevii/open-factory/issues/64. Follow-ups that are NOT S9 work: #65 (schedules to humans), #66 (`TZ` in containers); #47 and #57 touched by notes only; #26, #48, #49 untouched; #31 is consumed (closes with the PR). **Read spec §8 (firing), §10 (lifecycle and crons) and §12 (locking) before any server task from Task 7 on.**

## Global Constraints

- **Working mode:** the dev works directly, test-first (red, green, commit), one commit per task, conventional message ending with a `Co-Authored-By:` line naming the model the dev actually runs as (e.g. `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`); the PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Postgres must be up (`pnpm compose up -d`) for server and db tests.
- **Verify commands** (repo root; real script names from `package.json`): one file `pnpm vitest run <path>`; all `pnpm test`; `pnpm typecheck`; `pnpm lint` (`pnpm lint:fix` to format); `pnpm lint:ci` and `pnpm build` at the end; migrations `pnpm db:generate`. Every task's last step runs its file(s), then `pnpm typecheck` and `pnpm lint`.
- **Dependencies:** only `croner`, added with `pnpm --filter @open-factory/shared add --save-exact croner@<version>` after Task 2 Step 1's concrete release-age check (record `pnpm config get minimumReleaseAge`; if it is unset, pick a croner release at least 14 days old; the PR names the version and its publish date; 11.0.0, published 2026-10-26, at spec time). **Never loosen any pnpm supply-chain setting**, no overrides or exceptions; never `pnpm dlx <tool>@latest`. The web gets croner only through `@open-factory/shared` (one version). No pg-boss. shadcn: none expected.
- **Layout rules:** nothing outside `apps/server/src/mcp/` imports the MCP SDK; nothing outside `packages/harness/src/claude/` knows a stream-json field; croner is imported only by `packages/shared/src/cron.ts`.
- **No DB triggers.** Every rule is app code.
- **Lock order (spec §12.1), written once in `schedule-store.ts`'s header:** (1) unlocked read of the involved agents; (2) **agent rows in one global order** (persistent before spawned, then id), one row per statement with its own mode (the creating agent `FOR NO KEY UPDATE`, targets `FOR SHARE`, a row that is both `FOR NO KEY UPDATE`), re-check live; (3) schedule rows `FOR NO KEY UPDATE` (the firing: `FOR NO KEY UPDATE SKIP LOCKED`), **never `FOR UPDATE`**; (4) the pending scheduled message row `FOR NO KEY UPDATE`, then insert/update. **Invariant: agents before schedules before messages; no transaction locks a schedule row and then waits on an agent row.** A deadlock (`40P01`) is retried once from step 1. Every store call inside a transaction takes `tx`. **A transaction never awaits a runtime call** (`runtimes.load`, `statusOf`, `deliver`).
- **Hand-offs:** after commit, `runtimes.deliver(row, "agent", "scheduled")`, after `bootDone`, skipped once closing, every promise `.catch`ed and logged.
- **Truthful senders:** `scheduled` rows have no sender columns (`@scheduler`) and carry their author (`author_agent_id` | `author_user_id`); `by` comes from those columns, never from input. Bodies are escaped only by `groupEnvelopes`; attributes only by `attr()`.
- **Clock:** the `Scheduler` and `ScheduleService` take `now: () => Date`; every query passes that instant as a parameter, never Postgres `now()`.
- **Security:** `/api/schedules*` and `POST /api/agents/:slug/stop-crons` use `requireUser` (a valid agent token gets 401); identity from token/session only; agent limits (20 / 15 minutes over the next 10 runs / one year) enforced in `ScheduleService`; spawned agents never get the schedule tools.
- **Names and copy:** "spawned agent" in UI and agent-facing text; "cron" only for in-session crons, "pattern" / "Repeats" for a schedule's expression; keys `S-<n>`; the spec's and UI doc's exact sentences (copy them, don't paraphrase).
- **Timing in tests:** fake timers plus the injected clock; await real events; drain job queues (`rt.settled()`, `scheduler.idle()`, which awaits the tick **and** its hand-off promises); race tests wait on `pg_stat_activity.wait_event_type = 'Lock'`; **never raise a timeout to make a test pass**; no sleeps; never call `settled()` right after a fire-and-forget hand-off without awaiting the hand-off first.
- **No automated test calls a live model.** Live checks (Tasks 1, 17, 30) read `~/.open-factory-spike/oauth-token` into the environment at run time only, use haiku, never print or commit it; Docker image `open-factory-base:dev`; agents get only the env vars they need.
- **UI rules (DESIGN.md + UI doc):** orange only for live/focused/selected; state = icon + label; no list animations on live updates; never `transition-all`; type in rem; no toasts; undo over confirmation (Stop crons is the one confirmation); longer forms validate on blur and submit.
- `docs/product/` is gitignored and read-only: never edit it, never link it from the PR. Product-doc results (V1, V2) are reported to the lead, who edits it.

## File Structure

```
packages/shared/
  package.json                (modify) croner exact pin
  src/cron.ts                 (new)    validateCron, isValidZone, nextRun(s), latestAtOrBefore, countRuns, minGapMinutes,
                                       parseAt, formatOffsetIso, factoryZoneDefault
  src/keys.ts                 (new)    parseKey/formatKey; tasks.ts parseTaskKey/taskKey become wrappers
  src/schedules.ts            (new)    SCHEDULE_STATES, body/cron/at/zone schemas, tool + REST + item schemas
  src/messaging.ts            (modify) MESSAGE_KINDS + "scheduled"; envelope scheduleKey/by/due/firings/late
  src/agents.ts               (modify) queue item scheduleKey/firings/late/dueAt; summary crons, cronZone,
                                       scheduleCount, stopCronsPending
  src/events.ts               (modify) cron_created.durable?; hibernated.by?; background_work_lost.by?;
                                       reasons + "crons_stopped"; process_started reason + "scheduled"
  src/ws.ts                   (modify) schedules_changed frame
  src/index.ts                (modify) exports

packages/db/
  src/schema/schedules.ts     (new)    schedules table
  src/schema/agents.ts        (modify) messages.scheduleId/authorAgentId/authorUserId/dueAt/firings/late
  src/schema/index.ts         (modify) export schedules
  migrations/0009_*.sql       generated; sequence, CHECKs, partial indexes, CHECK rewrite by hand
  src/schema.schedules.test.ts (new)   V5: every row shape

packages/harness/src/
  claude/mapper.ts            (modify) durable on cron_created
  envelope.ts, types.ts       (modify) scheduled attributes, ORDER

apps/server/src/
  scheduling/limits.ts        (new)    MAX_AGENT_SCHEDULES=20, MIN_AGENT_GAP_MINUTES=15, AGENT_AT_HORIZON_DAYS=366,
                                       TICK_MAX_MS=60_000, TICK_MIN_MS=1_000, DUE_BATCH=100, LATE_MS=60_000,
                                       backoffMs(failCount)
  scheduling/schedule-store.ts (new)   SQL; THE lock-order header
  scheduling/schedule-service.ts (new) human + agent operations, recomputeFromNow, items
  scheduling/scheduler.ts     (new)    timer, tick, fire(), idle(), start/stop/rearm
  mcp/tools/schedule-tools.ts (new)    schedule_message, list_schedules, cancel_schedule
  routes/schedules.ts         (new)    /api/schedules*
  routes/agents.ts            (modify) POST /api/agents/:slug/stop-crons
  agents/agent-runtime.ts     (modify) deliver refresh, flush re-read, writeBatch write-back, stopCrons, isPassive,
                                       crons list, durable
  agents/event-store.ts       (modify) joined() fields, bootWakes/deliverableWhere, pendingRow, writeBackScheduled,
                                       clearStaleWriteMarks, terminateRows soft-deletes schedules
  agents/runtimes.ts          (modify) senderLabel @scheduler; stopCrons passthrough
  agents/notices.ts           (modify) cronsStopped notice
  agents/agent-service.ts     (modify) unarchive transaction + recomputeFromNow
  supervisor/reconcile.ts     (modify) clearStaleWriteMarks before bootWakes
  workspace/claude-md.ts      (modify) kinds line, Scheduling section
  config.ts                   (modify) FACTORY_TIMEZONE
  app.ts                      (modify) wiring, start/stop/idle, tool list
  scripts/smoke-scheduling.ts (new)    live check (Tasks 17, 30)

apps/web/src/
  features/schedules/         (new)    api.ts, format.ts (formatScheduleTime), ScheduleState, ScheduleBadge,
                                       ScheduleList, ScheduleRow, ScheduleFilters, ScheduleForm, WhenField,
                                       TimezoneSelect, RunPreview
  features/session/           (modify) CronsPopover, StopCronsDialog, MessageBlock sender/notes, queue items,
                                       timeline quiet lines, AgentStrip segments
  features/tasks/agent-picker (modify) placeholder + extra option props
  routes/_app/schedules.*.tsx (new)    index (replaces schedules.tsx), new, $key
```

---

## Chunk A: live gates, shared foundations, data, plumbing (Tasks 1–9)

### Task 1: Live gate V1/V2: harness crons on today's Claude Code (haiku)

Spec §18 V1 (cron mapping still matches S0) and V2 (does a `durable: true` cron fire after stop + `--resume`?). Nothing in S9 depends on V2's answer except the conditional Task 19.

**Files:**
- Modify: `packages/harness/fixtures/README.md` ("Verified in S9 implementation")
- Scratch (never committed): `G=$(mktemp -d)/s9-gate`

- [ ] **Step 1: Set up the scratch driver** (S0's, from its branch):

```bash
G=$(mktemp -d)/s9-gate && mkdir -p "$G/work" && cd "$G"
git -C /Users/orlevi/projects/open-factory-wt/s9 show origin/spec/s0-spikes:spikes/drive.mjs > drive.mjs
git -C /Users/orlevi/projects/open-factory-wt/s9 show origin/spec/s0-spikes:spikes/scenarios/cron-create-fire-delete.json > recurring.json
git -C /Users/orlevi/projects/open-factory-wt/s9 show origin/spec/s0-spikes:spikes/scenarios/cron-oneshot.json > oneshot.json
claude --version   # record it
```

- [ ] **Step 2: V1.** Run both scenarios on haiku with a fresh config dir, the token read at run time (never echoed):

```bash
export CLAUDE_CONFIG_DIR="$G/cfg" && mkdir -p "$CLAUDE_CONFIG_DIR"
CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.open-factory-spike/oauth-token)" \
  node drive.mjs recurring.json "$G/recurring" -- --model haiku --permission-mode auto
CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.open-factory-spike/oauth-token)" \
  node drive.mjs oneshot.json "$G/oneshot" -- --model haiku --permission-mode auto
```

Then map each trace with the real mapper and compare with the S0 fixtures:

```bash
cd /Users/orlevi/projects/open-factory-wt/s9
node --import tsx -e '
import { readFileSync } from "node:fs";
import { createMapperState, flushMapper, mapLine } from "./packages/harness/src/claude/mapper.ts";
for (const f of process.argv.slice(1)) {
  const s = createMapperState({ resumed: false });
  const ev = [...readFileSync(f, "utf8").trim().split("\n").flatMap((l) => mapLine(JSON.parse(l), s)), ...flushMapper(s)];
  console.log(f, JSON.stringify(ev.filter((e) => e.type.startsWith("cron_") || e.type === "turn_end").map((e) => ({ t: e.type, id: e.cronId, rec: e.recurring, o: e.originKind }))));
}' "$G/recurring.jsonl" "$G/oneshot.jsonl"
```

Expected: `cron_created` with `recurring` true/false and a `nextFireAt`; a `turn_end` with `originKind: "cron"` for each firing; `cron_deleted` for the recurring one; no deletion event for the one-shot. Also grep the raw `tool_use_result` of `CronCreate` for `durable`. If anything differs from S0: stop, report to the lead, and fix the mapper test-first in Task 2 before anything else.

- [ ] **Step 3: V2.** A durable one-shot, then stop, then resume after its time:

```bash
cat > durable.json <<'EOF'
[
  { "send": "Use the CronCreate tool to create a ONE-SHOT (recurring=false) job with durable=true that fires 2 minutes from now, with prompt 'Reply with the word DURABLEFIRED.' Then end your turn with the job id." },
  { "waitFor": { "type": "result" }, "timeout": 120000 },
  { "shell": "ls -la .claude; cat .claude/scheduled_tasks.json" },
  { "closeStdin": true },
  { "waitExit": 30000 }
]
EOF
cd "$G/work" && CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.open-factory-spike/oauth-token)" \
  node ../drive.mjs ../durable.json "$G/durable-1" -- --model haiku --permission-mode auto
SID=$(grep -o '"session_id":"[^"]*"' "$G/durable-1.jsonl" | head -1 | cut -d'"' -f4)
sleep 180   # past the job's time, process stopped (a plain shell wait outside any test)
cat > resume.json <<'EOF'
[
  { "send": "Say OK." },
  { "waitFor": { "type": "result" }, "timeout": 120000 },
  { "mark": true },
  { "waitFor": { "type": "result", "text": "DURABLEFIRED" }, "since": "mark", "timeout": 150000, "optional": true },
  { "shell": "ls -la .claude; cat .claude/scheduled_tasks.json || true" },
  { "closeStdin": true },
  { "waitExit": 30000 }
]
EOF
CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.open-factory-spike/oauth-token)" \
  node ../drive.mjs ../resume.json "$G/durable-2" -- --model haiku --permission-mode auto --resume "$SID"
grep -c 'schedule_wakeup' "$G/durable-2.jsonl"; grep -c 'DURABLEFIRED' "$G/durable-2.jsonl"
```

Outcome **V2-positive** = a `schedule_wakeup` turn or `DURABLEFIRED` appears after resume (durable crons outlive a process: Task 19 becomes mandatory). **V2-negative** = neither (Task 19 is skipped). Note whether `scheduled_tasks.json` existed after step 1 and after the resume.

- [ ] **Step 4: Record** in `packages/harness/fixtures/README.md` under "Verified in S9 implementation": the Claude Code version, V1 result (mapping unchanged, or what changed), V2 result (positive/negative, the file's presence). Don't commit traces (they hold paths); if a new fixture is worth keeping, scrub it with S0's `scrub.mjs` (`git show origin/spec/s0-spikes:spikes/scrub.mjs`) first. **Send the lead** one message with the V1/V2 result for `open-questions.md` (the lead edits docs/product).
- [ ] **Step 5: Verify** `git diff --stat` shows only the README; no token in any file (`grep -r "sk-ant" packages/harness/fixtures` → nothing).
- [ ] **Step 6: Commit** `docs(harness): record S9 live cron checks (V1, V2)`.

---

### Task 2: `croner`, `cron.ts`, keys, and the durable flag

Spec §6.1 (R3 syntax), §7.1–§7.2 (zones, DST), §8.1 step 3 (occurrence math), §16. Also `cron_created.durable` (spec §10.2).

**Files:**
- Modify: `packages/shared/package.json` (croner exact pin)
- Create: `packages/shared/src/cron.ts`, `packages/shared/src/cron.test.ts`, `packages/shared/src/keys.ts`, `packages/shared/src/keys.test.ts`
- Modify: `packages/shared/src/tasks.ts` (`parseTaskKey`/`taskKey` call `parseKey`/`formatKey`), `packages/shared/src/index.ts`, `packages/shared/src/events.ts` (`cron_created.durable: z.boolean().optional()`)
- Modify: `packages/harness/src/claude/mapper.ts`, `packages/harness/src/claude/mapper.test.ts` (durable from `tool_use_result.durable`)

**Interfaces — Produces:**
```ts
// keys.ts
export type KeyPrefix = "T" | "S";
export function parseKey(prefix: KeyPrefix, raw: string): number | null; // "S-3" | "s-3" | "3" → 3
export const formatKey = (prefix: KeyPrefix, n: number) => `${prefix}-${n}`;
// cron.ts
export function validateCron(expr: string): string | null;     // null = valid; else the spec's sentence
export function isValidZone(zone: string): boolean;
export function factoryZoneDefault(): string;                  // resolved zone, or "UTC"
export function nextRun(expr: string, zone: string, after: Date): Date | null;            // strictly after
export function nextRuns(expr: string, zone: string, after: Date, n: number): Date[];
export function latestAtOrBefore(expr: string, zone: string, now: Date): Date | null;     // previousRuns(1, now+1ms)
export function countRuns(expr: string, zone: string, from: Date, to: Date, cap?: number): number; // [from, to], cap 1000
export function minGapMinutes(expr: string, zone: string, after: Date, n?: number): number;       // over next n (10)
export function parseAt(at: string, zone: string): Date | null;  // ISO; no offset → read in zone (two-pass)
export function formatOffsetIso(at: Date, zone: string): string; // "2026-11-23T09:00:00+01:00"
```

- [ ] **Step 1: Add croner.** Record the effective policy: `pnpm config get minimumReleaseAge` (this worktree's `pnpm-workspace.yaml` sets none explicitly). If it is set, pick the newest croner release older than it; **if it is unset, pick the newest release at least 14 days old**. `npm view croner time --json | tail -8` gives the dates. `pnpm --filter @open-factory/shared add --save-exact croner@<v>`. Note the version, its publish date and the recorded policy value for the PR body. If pnpm refuses because of release age, pick an older one; never add, loosen or override any supply-chain setting. Confirm `packages/shared/package.json` shows the exact version (no caret) and `pnpm-workspace.yaml` is unchanged.
- [ ] **Step 2: Write the failing tests** `cron.test.ts`, `keys.test.ts`:

```ts
import { expect, test } from "vitest";
import { countRuns, formatOffsetIso, isValidZone, latestAtOrBefore, minGapMinutes, nextRun, nextRuns,
  parseAt, validateCron } from "./cron.ts";
const iso = (d: Date | null) => d?.toISOString();
const B = "Europe/Berlin", NY = "America/New_York";

test.each(["0 9 * * 1-5", "*/30 * * * *", "0 8 1 * *", "0,30 2 * * *", "0 9 * jan mon", "0 9 * * 7", "5-10/2 * * * *"])(
  "accepts %s", (e) => expect(validateCron(e)).toBeNull());
test.each([
  ["0 9 * *", "Use 5 fields: minute hour day-of-month month day-of-week."],
  ["0 0 9 * * *", "Use 5 fields: minute hour day-of-month month day-of-week."],
  ["@daily", "Use 5 fields: minute hour day-of-month month day-of-week."],
  ["0 9 L * *", "Only numbers, *, ranges, lists, steps and names are allowed."],
  ["0 9 * * 5#2", "Only numbers, *, ranges, lists, steps and names are allowed."],
  ["0 9 ? * *", "Only numbers, *, ranges, lists, steps and names are allowed."],
  ["0 9 15W * *", "Only numbers, *, ranges, lists, steps and names are allowed."],
  ["0 0 30 2 *", "This pattern never runs."],
])("refuses %s", (e, msg) => expect(validateCron(e)).toBe(msg));
test("a field error names the field", () => expect(validateCron("61 * * * *")).toMatch(/minute/i));

test("zones", () => {
  expect(isValidZone(B)).toBe(true); expect(isValidZone("UTC")).toBe(true); expect(isValidZone("Mars/Base")).toBe(false);
});

// DST pins (spec §7.2), 2026 transitions. Berlin: spring 29 Mar 02:00→03:00, fall 25 Oct 03:00→02:00.
test("Berlin spring-forward: 02:30 runs at 03:00 once", () => {
  expect(nextRuns("30 2 * * *", B, new Date("2026-03-28T12:00:00Z"), 2).map(iso))
    .toEqual(["2026-03-29T01:00:00.000Z", "2026-03-30T00:30:00.000Z"]);
});
test("Berlin fall-back: a single fixed time runs once", () => {
  expect(nextRuns("30 2 * * *", B, new Date("2026-10-24T12:00:00Z"), 2).map(iso))
    .toEqual(["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
});
test("Berlin fall-back: a list hitting the repeated hour runs at both repeats", () => {
  expect(nextRuns("0,30 2 * * *", B, new Date("2026-10-24T12:00:00Z"), 4).map(iso)).toEqual([
    "2026-10-25T00:00:00.000Z", "2026-10-25T00:30:00.000Z", "2026-10-25T01:00:00.000Z", "2026-10-25T01:30:00.000Z"]);
});
test("New York transitions (8 Mar, 1 Nov 2026)", () => {
  expect(iso(nextRun("30 2 * * *", NY, new Date("2026-03-07T12:00:00Z")))).toBe("2026-03-08T07:00:00.000Z");
  expect(iso(nextRun("30 1 * * *", NY, new Date("2026-10-31T12:00:00Z")))).toBe("2026-11-01T05:30:00.000Z");
});
test("parseAt: offset wins; no offset is read in the zone; a missing wall time becomes 03:30", () => {
  expect(iso(parseAt("2026-11-23T09:00:00+01:00", NY))).toBe("2026-11-23T08:00:00.000Z");
  expect(iso(parseAt("2026-11-23T09:00", B))).toBe("2026-11-23T08:00:00.000Z");
  expect(iso(parseAt("2026-03-29T02:30", B))).toBe("2026-03-29T01:30:00.000Z"); // 03:30 CEST
  expect(parseAt("not a date", B)).toBeNull();
});
test("occurrence math (spec §8.1 step 3)", () => {
  const e = "0 9 * * 1-5";
  // down Tue 24 Nov 08:00 Berlin to Fri 27 Nov 11:40: runs Tue, Wed, Thu, Fri 09:00 = 4; latest = Fri 09:00
  const from = new Date("2026-11-24T08:00:00Z"), now = new Date("2026-11-27T10:40:00Z");
  expect(countRuns(e, B, from, now)).toBe(4);
  expect(iso(latestAtOrBefore(e, B, now))).toBe("2026-11-27T08:00:00.000Z");
  expect(iso(latestAtOrBefore(e, B, new Date("2026-11-27T08:00:00Z")))).toBe("2026-11-27T08:00:00.000Z"); // exactly now counts
  expect(countRuns("* * * * *", B, from, now)).toBe(1000); // cap
});
test("minGapMinutes", () => {
  const t = new Date("2026-11-20T10:00:00Z");
  expect(minGapMinutes("*/15 * * * *", B, t)).toBe(15);
  expect(minGapMinutes("*/5 * * * *", B, t)).toBe(5);
  expect(minGapMinutes("0 9 * * *", B, t)).toBe(1440);
});
test("formatOffsetIso", () => {
  expect(formatOffsetIso(new Date("2026-11-23T08:00:00Z"), B)).toBe("2026-11-23T09:00:00+01:00");
  expect(formatOffsetIso(new Date("2026-07-01T07:00:00Z"), B)).toBe("2026-07-01T09:00:00+02:00");
});
```

```ts
// keys.test.ts
import { expect, test } from "vitest";
import { formatKey, parseKey } from "./keys.ts";
import { parseTaskKey, taskKey } from "./tasks.ts";
test("keys", () => {
  for (const r of ["S-3", "s-3", "3", " S-3 "]) expect(parseKey("S", r)).toBe(3);
  for (const r of ["T-3", "S-0", "S-", "x", "S-1234567890"]) expect(parseKey("S", r)).toBeNull();
  expect(formatKey("S", 3)).toBe("S-3");
  expect(parseTaskKey("t-42")).toBe(42); expect(taskKey(42)).toBe("T-42"); // unchanged behaviour
});
```

Also a mapper test: the `cron-create-fire-delete` fixture's `cron_created` carries `durable: false`.

- [ ] **Step 3: Run** `pnpm vitest run packages/shared/src/cron.test.ts packages/shared/src/keys.test.ts packages/harness/src/claude/mapper.test.ts` → FAIL.
- [ ] **Step 4: Implement.**
  - `validateCron`: trim; split on whitespace; 5 parts else the 5-fields sentence; each part must match `^(\*|[0-9]+|[a-z]{3})(-([0-9]+|[a-z]{3}))?(\/[0-9]+)?(,(\*|[0-9]+|[a-z]{3})(-([0-9]+|[a-z]{3}))?(\/[0-9]+)?)*$/i` else the allowed-tokens sentence (this refuses `L`, `W`, `#`, `?`, `@…`); then `new Cron(expr, { paused: true })` in a try: on throw return croner's message rewritten as "Invalid value for minute: 61." style (keep croner's text after `CronPattern: `, end with a period); then `nextRun(expr, "UTC", new Date())` null → "This pattern never runs.".
  - croner: `new Cron(expr, { timezone: zone, paused: true })` (its default mode ORs day-of-month and day-of-week); `.nextRuns(n, after)`, `.previousRuns(1, new Date(now.getTime() + 1))`. `countRuns` steps `nextRun` from `from − 1 ms` while `≤ to`, up to `cap`.
  - `isValidZone`: `try { new Intl.DateTimeFormat("en", { timeZone: z }); return true } catch { return false }`.
  - `parseAt`: if the string has `Z` or `±hh:mm`, `new Date(at)`; else parse `YYYY-MM-DDTHH:mm(:ss)?`, `guess = Date.UTC(...)`, `o1 = offsetMs(zone, guess)`, `t = guess − o1`, `o2 = offsetMs(zone, t)`, return `o2 === o1 ? t : guess − o2` (`offsetMs` via `Intl.DateTimeFormat(..., { timeZoneName: "longOffset" })`). Invalid → null.
  - `formatOffsetIso`: wall fields + offset from the same `Intl` call.
  - Mapper: on the `CronCreate` result, `durable: Boolean(r.durable)`.
- [ ] **Step 5: Run** the three files → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 6: Commit** `feat(shared): plain cron validation, zone and occurrence helpers on croner`.

---

### Task 3: Shared schemas and event/message types

Spec §6.1, §9, §10.2–§10.3, §11; UI doc §1.

**Files:**
- Create: `packages/shared/src/schedules.ts`, `packages/shared/src/schedules.test.ts`
- Modify: `packages/shared/src/messaging.ts`, `agents.ts`, `events.ts`, `ws.ts`, `index.ts`; `apps/server/src/supervisor/slots.ts` (`WakeReason` + `"scheduled"`)

**Interfaces — Produces:**
```ts
export const SCHEDULE_STATES = ["active", "paused", "done", "skipped_archived", "pending_errored"] as const;
export const scheduleBodySchema;            // 1 byte..64 KB
export const cronFieldSchema;               // string refined by validateCron (message = its sentence)
export const zoneSchema;                    // refined by isValidZone: "Unknown time zone '<z>'; use an IANA name such as Europe/Berlin."
export const scheduleMessageToolSchema = z.object({ body, cron: cronFieldSchema.optional(), at: z.string().optional(),
  timezone: zoneSchema.optional(), to: z.string().optional() });           // exactly-one check is in the service
export const listSchedulesToolSchema = z.object({});
export const cancelScheduleToolSchema = z.object({ id: z.string() });
export const createScheduleBodySchema = z.object({ target: z.string(), cron: cronFieldSchema.optional(),
  at: z.string().optional(), timezone: zoneSchema, body: scheduleBodySchema });
export const patchScheduleBodySchema = createScheduleBodySchema.partial();
export const scheduleAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), slug: z.string(), archived: z.boolean(), terminated: z.boolean() }),
  z.object({ kind: z.literal("user"), handle: z.string() })]);
export const scheduleItemSchema = z.object({ key, target: {slug, displayName, archived, terminated}, cron?, at?, timezone,
  body, nextRunAt: nullable, lastFiredAt: nullable, paused, done, ran?, deleted?, createdBy: scheduleAuthorSchema,
  bodyAuthor: scheduleAuthorSchema, pendingFiring: z.boolean(), state: z.enum(SCHEDULE_STATES) });
export const liveCronSchema = z.object({ cronId, humanSchedule, recurring, durable, nextFireAt: optional ISO, expiresAt: optional ISO });
```
Plus: `MESSAGE_KINDS` + `"scheduled"`; envelope gains `scheduleKey?`, `by?`, `due?`, `firings?`, `late?`; queue item gains `scheduleKey?`, `firings?`, `late?`, `dueAt?`; agent summary and `agent_status` gain `crons: liveCronSchema[]` (default `[]`), `cronZone: string`, `scheduleCount: number` (summary only), `stopCronsPending: boolean`; events: `hibernated.by?`, `background_work_lost.by?`, `crons_stopped` added to their reason enums and `HibernateReason`; `process_started.reason` + `"scheduled"`; ws `{type: "schedules_changed"}`.

- [ ] **Step 1: Failing tests** `schedules.test.ts`: tool schema accepts `{body:"x", cron:"0 9 * * 1-5"}` and refuses `cron:"@daily"` with the 5-fields sentence; `timezone:"Mars/Base"` refused with the zone sentence; body over 64 KB refused; `createScheduleBodySchema` requires `timezone`; `scheduleItemSchema` parses both author kinds; `MESSAGE_KINDS` includes `scheduled`; `sessionEventSchema.parse({type:"hibernated", reason:"crons_stopped", by:"@or"})` and `{type:"background_work_lost", reason:"crons_stopped", by:"@or", tasks:[], crons:[]}` parse; `serverMessageSchema.parse({type:"schedules_changed"})`.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/schedules.test.ts` → FAIL.
- [ ] **Step 3: Implement** the schemas and type widenings. Fix the compile errors this causes elsewhere only with the narrowest change (defaults: `crons: []`, `stopCronsPending: false`, `cronZone` from the runtime in Task 20; until then `"UTC"`).
- [ ] **Step 4: Run** the file and `pnpm test packages/shared` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(shared): schedule schemas, the scheduled kind and crons_stopped reasons`.

---

### Task 4: Database: `schedules`, message columns, CHECK rewrite (V5)

Spec §5.

**Files:**
- Create: `packages/db/src/schema/schedules.ts`, `packages/db/src/schema.schedules.test.ts`
- Modify: `packages/db/src/schema/agents.ts` (messages columns), `packages/db/src/schema/index.ts`
- Generated + hand-edited: `packages/db/migrations/0009_*.sql`

- [ ] **Step 1: Failing test** `schema.schedules.test.ts` (S8's `schema.tasks.test.ts` as the model: a migrated throwaway database, raw SQL):
  - inserts one row of **every** S3–S8 message shape (copy S8's list) → all accepted, and the new `scheduled` shape (`kind='scheduled'`, no sender, `to_agent_id`, `schedule_id`, `author_user_id`, `due_at`, `firings=1`, `late=false`) → accepted;
  - rejects: `scheduled` with `firings` NULL; `firings = 0`; both authors; no author; a `from_agent_id`; `schedule_id` null; `late` null; `due_at` null; a `message` row carrying `schedule_id`; a `task_update` carrying `firings`;
  - the partial unique index: a second **pending** row for the same `(schedule_id, to_agent_id)` → `23505`; a delivered one plus a pending one → fine;
  - `schedules`: `cron` and `run_at` both set → refused, neither → refused; two creators → refused; `number` comes from the sequence.
- [ ] **Step 2: Run** `pnpm vitest run packages/db/src/schema.schedules.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Drizzle schema per spec §5 (columns exactly as listed, incl. `fail_count integer not null default 0`, `retry_at`); `pnpm db:generate`; then hand-edit the SQL: `CREATE SEQUENCE schedule_number_seq` and the `number` default; the four `schedules` CHECKs; the three partial indexes; `messages_schedule_pending_idx` (unique, partial `WHERE state = 'pending' AND schedule_id IS NOT NULL`); drop and re-add `messages_sender_kind_check` with every S8 branch gaining `schedule_id IS NULL AND author_agent_id IS NULL AND author_user_id IS NULL AND due_at IS NULL AND firings IS NULL AND late IS NULL` and the new branch:
  ```sql
  OR (kind = 'scheduled' AND from_user_id IS NULL AND from_agent_id IS NULL AND notice IS NULL
      AND subject_agent_id IS NULL AND task_id IS NULL AND comment_id IS NULL AND to_agent_id IS NOT NULL
      AND to_all_humans = false AND schedule_id IS NOT NULL AND num_nonnulls(author_agent_id, author_user_id) = 1
      AND due_at IS NOT NULL AND firings IS NOT NULL AND firings >= 1 AND late IS NOT NULL)
  ```
  The `schedule_id` FK has no `ON DELETE` (schedules are soft-deleted only).
- [ ] **Step 4: Run** the file, then `pnpm test packages/db` and `pnpm vitest run apps/server/src/agents/event-store` (S3–S8 inserts still pass) → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(db): schedules and scheduled message rows`.

---

### Task 5: Envelope: the `scheduled` attributes

Spec §8.5.

**Files:** Modify `packages/harness/src/envelope.ts`, `packages/harness/src/types.ts`, `packages/harness/src/envelope.test.ts`.

**Interfaces — Produces:** `BatchRow` and `FactoryMessage` gain `scheduleKey?`, `by?`, `due?` (already formatted ISO with offset), `firings?`, `late?`; `ORDER.scheduled = 1`; `single()` copies them; scheduled rows are never merged.

- [ ] **Step 1: Failing tests:** a scheduled row renders exactly
  `<factory-message from="@scheduler" kind="scheduled" urgent="false" id="m1" schedule="S-3" by="@or" due="2026-11-23T09:00:00+01:00" firings="3" late="true">\nMorning review\n</factory-message>`; `firings` omitted at 1, `late` omitted when false; an attribute with `"` / `<` is escaped by `attr()`; a body containing `</factory-message>` stays inside (neutralised); two consecutive scheduled rows stay two envelopes; ordering with a notice, a message, a scheduled row and a member update: notice, then message and scheduled by created order, then updates; same rows → same bytes.
- [ ] **Step 2: Run** `pnpm vitest run packages/harness/src/envelope.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `one()`: append ` schedule="…"`, ` by="…"`, ` due="…"`, ` firings="n"` (n > 1), ` late="true"` after `task`, each through `attr()`; `ORDER`; `single()` copies; the merge step treats `kind === "scheduled"` as never mergeable.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(harness): scheduled envelope attributes`.

---

### Task 6: Runtime plumbing for the `scheduled` kind

Spec §8.4, §5 (bootWakes), §11 (queue items, lookup).

**Files:**
- Modify: `apps/server/src/agents/event-store.ts` (`joined()`: left join `schedules` → `scheduleKey` via `formatKey("S", number)`, `scheduleZone`, author slug/handle; `deliverableWhere` counts `scheduled`; `pendingRow(id)` exported if not already), `agent-runtime.ts` (`entryOf`: `scheduled` → `from: "@scheduler"`; `toBatchRow` copies `scheduleKey`, `by`, `due = formatOffsetIso(dueAt, scheduleZone)`, `firings`, `late`), `runtimes.ts` (`senderLabel` → `@scheduler`), queue `itemOf` and `messageLookup` fields
- Test: `apps/server/src/agents/agent-runtime.scheduled.test.ts` (new), `event-store.messages.test.ts` (extend)

**Interfaces — Produces:** `PendingRow` gains `scheduleKey: string | null`, `scheduleZone: string | null`, `authorLabel: string | null` (`@handle` or slug); `EventStore.insertScheduledRow(tx, {...})` is NOT here (Task 7 store).

- [ ] **Step 1: Failing tests** (fake driver, `RuntimeHarness`, a real Postgres row inserted with raw SQL through `rows.ts` helpers: add `insertSchedule` and `insertScheduledMessage` to `agents/testing/rows.ts`):
  - a hibernated agent with a pending scheduled row: `runtimes.deliver(row, "agent", "scheduled")` wakes it with `process_started.reason === "scheduled"`; the first `message_in` envelope is `from="@scheduler"`, `kind="scheduled"`, `schedule="S-1"`, `by="@or"`, `due` with the zone's offset;
  - to an **errored** agent: stays pending, no attempt (`scheduled` not in `ERRORED_WAKES`; assert the attempt counter/`process_started` absent);
  - `bootWakes` returns an agent whose only pending row is `scheduled`;
  - the queue item has `scheduleKey`, `firings`, `late`, `dueAt`; `messageLookup` too.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/agents/agent-runtime.scheduled.test.ts` → FAIL.
- [ ] **Step 3: Implement** the widenings above (each a small change; keep `@factory` for every other sender-less kind).
- [ ] **Step 4: Run** the new file plus `pnpm vitest run apps/server/src/agents` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): deliver scheduled rows from @scheduler`.

---

### Task 7: `ScheduleStore`, the lock-order header, and `ScheduleService.create` with the agent limits

Spec §6.1–§6.3 (create), §6.2, §12.1.

**Files:**
- Modify (config, moved here from Task 16 so Task 15 can rely on it): `apps/server/src/config.ts` (`FACTORY_TIMEZONE`, validated with the shared zone check, default `factoryZoneDefault()`; a boot error "Unknown time zone 'Mars/Base'; use an IANA name such as Europe/Berlin.") + `config.test.ts` (unset → default; invalid → boot error). The service's default zone for agent-created schedules comes from it.
- Create: `apps/server/src/scheduling/limits.ts`, `schedule-store.ts`, `schedule-service.ts`, `schedule-service.create.test.ts`

**Interfaces — Produces:**
```ts
// limits.ts
export const MAX_AGENT_SCHEDULES = 20, MIN_AGENT_GAP_MINUTES = 15, AGENT_AT_HORIZON_MS = 366 * 86_400_000,
  TICK_MAX_MS = 60_000, TICK_MIN_MS = 1_000, DUE_BATCH = 100, LATE_MS = 60_000;
export const backoffMs = (failCount: number) => Math.min(5_000 * 2 ** Math.min(failCount, 4), 60_000);
// schedule-service.ts
export type Actor = { agentId: string } | { userId: string };
export type ScheduleInput = { target: string; cron?: string; at?: string; timezone: string; body: string };
export type ScheduleResult = { ok: true; item: ScheduleItem; note?: string } | { ok: false; code: string; message: string; status: 400 | 403 | 404 | 409 };
export class ScheduleService {
  constructor(d: { db; store: EventStore; schedules: ScheduleStore; now: () => Date; factoryZone: string;
    onChanged: () => void /* rearm + bus */ });
  create(actor: Actor, input: ScheduleInput): Promise<ScheduleResult>;
}
```

- [ ] **Step 1: Write the header first** in `schedule-store.ts` (the spec §12.1 text, the invariant, "never FOR UPDATE", "every call takes tx", "a transaction never awaits a runtime call"), then the failing tests in `schedule-service.create.test.ts`:
  - human creates `0 9 * * 1-5` in Berlin for `ceo`: row has `created_by_user_id`, `body_author_user_id`, `next_run_at` = next weekday 08:00Z (injected clock);
  - agent creates with `to` omitted → target self; `to: "me"`; `to: "@ceo"`;
  - exactly one of cron/at: both → "Pass either cron or at."; neither → same;
  - agent `*/5 * * * *` → "Schedules can't fire more often than every 15 minutes. For a short loop inside this session, use CronCreate."; `*/15` accepted; human `* * * * *` accepted;
  - agent `at` > one year → "Pick a time within the next year."; past `at` → "That time has passed." (human too);
  - the 21st active schedule of an agent → "You already have 20 schedules; cancel one first (list_schedules shows them)."; a paused one counts; a deleted one and a done one don't;
  - targets: unknown, `@humans`, a user handle, a reserved name, an archived and a terminated agent → S6's `resolveName` sentences / `409 target_ended`;
  - a caller terminated meanwhile (set `terminated_at` before the call) → "You can't schedule messages: you were terminated.";
  - two concurrent creates by one agent at 19 → one ok, one refused (start both, the second waits on the creator's `FOR NO KEY UPDATE`: poll `pg_stat_activity` for a `Lock` wait, then let the first commit);
  - A schedules for B while B schedules for A, concurrently → both succeed (global agent order) — run each 20 times in a loop without `40P01` escaping.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/scheduling/schedule-service.create.test.ts` → FAIL.
- [ ] **Step 3: Implement** `ScheduleStore` (`lockAgents(tx, rows: {id, kind, mode}[])` locking one row per statement in the global order; `countActiveCreatedBy(tx, agentId)`; `insert(tx, …)`; `itemFor(tx|db, id)`), and `create` per the order: resolve names without locks → `lockAgents` → re-check live → validate (§6.1 via the shared schemas + `parseAt` + `nextRun`) → limits for agents → insert → commit → `onChanged()`. Retry once on `40P01`.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): schedule store, lock order and create with agent limits`.

---

### Task 8: `ScheduleService`: edit, pause, resume, delete, restore, list, `recomputeFromNow`

Spec §6.3, §11 item fields and states, R2, R4, R5.

**Files:** Modify `schedule-store.ts`, `schedule-service.ts`; Test `schedule-service.edit.test.ts`.

**Interfaces — Produces:**
```ts
edit(actor: { userId: string }, key: string, patch: Partial<ScheduleInput>): Promise<ScheduleResult>;
pause(actor, key), resume(actor, key), remove(actor: Actor, key), restore(actor: { userId }, key): Promise<ScheduleResult>;
get(key: string, o?: { includeDeleted: true }): Promise<ScheduleItem | undefined>;
list(f: { target?: string; done?: boolean }): Promise<ScheduleItem[]>;            // humans, ≤ 500, spec §11 order
listForAgent(agentId: string): Promise<AgentScheduleView[]>;                       // created by or targeting, ≤ 100
cancelForAgent(agentId: string, key: string): Promise<ScheduleResult>;
recomputeFromNow(tx, scheduleId: string): Promise<void>;                            // the one helper
scheduleCountFor(agentId: string): Promise<number>;                                 // not deleted, not done
```

- [ ] **Step 1: Failing tests:**
  - edit only the body: `body_author` becomes the editor, `created_by` unchanged, `next_run_at` unchanged; edit only the target → re-checked live; edit timing → recomputed from now; switching cron→at and back; a pending row is untouched by every edit; every edit clears `fail_count`/`retry_at`; PATCH of a done one-shot's body succeeds (only changed fields validated); a done one-shot's `at` moved to the future → active again; edit of a deleted schedule → `404 schedule_not_found`;
  - pause/resume: `409 already_paused`, `409 not_paused`, `409 schedule_done`; resume recomputes from now (no catch-up: a schedule paused across 3 runs gets `next_run_at` = the next future run);
  - delete: soft, `next_run_at` null, excluded from `list`, `listForAgent`, the limit count and `scheduleCountFor`; its pending row stays pending;
  - restore: recomputes; a passed one-shot comes back done (`ran` false when `last_fired_at` null); target terminated → `409 target_ended` "@x was terminated."; target archived → refused; no agent limit check;
  - `cancelForAgent`: another's schedule → "S-3 was created by @or; only its creator or a human can cancel it."; unknown or deleted → "There is no schedule S-3."; own → `{id, status: "cancelled"}`;
  - `list` states: `active`, `paused`, `done` (`ran` true/false), `skipped_archived` (target archived), `pending_errored` (a pending row and the target's runtime status errored: `list` takes a `statusOf(agentId)` dependency read **outside** any transaction); order active by next run, paused, done newest first; `?target`; `done=true`;
  - `listForAgent` shape (spec §9), body capped at 2,000 chars with `truncated: true`.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/scheduling/schedule-service.edit.test.ts` → FAIL.
- [ ] **Step 3: Implement**; `deleted_at IS NULL` lives in one store helper (`live()`) used by every query except `get(…, {includeDeleted})` and `restore`.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): edit, pause, resume, delete and restore schedules`.

---

### Task 9: Checkpoint A: review findings applied

- [ ] **Step 1:** `pnpm test`, `pnpm typecheck`, `pnpm lint` all green. Push the branch.
- [ ] **Step 2:** Send the lead one message: "Chunk A (Tasks 1–8) done at <sha>: <one line per task>. V1: <result>. V2: <result>. Please review." Continue with Task 10 while waiting; read your inbox between tool calls.
- [ ] **Step 3:** For each finding: fix it test-first in the owning files; one commit `fix(server): chunk A review findings` (or per area). Reply to the lead listing each finding and its fix (or why not), before starting Task 14.

---

## Chunk B: the Scheduler, replacement, lifecycle, tools (Tasks 10–18)

### Task 10: `Scheduler`: timer, tick, firing transaction, catch-up, backoff, wiring

Spec §7.3, §8.1, §8.3, §10.1 (shutdown, before bootDone).

**Files:**
- Create: `apps/server/src/scheduling/scheduler.ts`, `scheduler.test.ts`
- Modify: `schedule-store.ts` (`dueIds(now, limit)`, `fire(tx, …)`, `recordFailure(id, retryAt)`, `earliestDue()`), `apps/server/src/app.ts` (construct; `scheduler.start()` after `router.bootDone()` next to `reaper.start()`; `scheduler.stop()` next to `reaper.stop()`; `await scheduler.idle()` next to `reaper.idle()`; `ScheduleService.onChanged` → `scheduler.rearm()` + `bus.publishAll({type:"schedules_changed"})`)

**Interfaces — Produces:**
```ts
export class Scheduler {
  constructor(d: { db; schedules: ScheduleStore; runtimes: Pick<Runtimes, "deliver">; router: { closed: boolean };
    bus: EventBus; log; now: () => Date; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout });
  start(): void;  stop(): void;  rearm(): void;   // rearm before start / after stop is a no-op
  idle(): Promise<void>;   // resolves when no tick is running and every hand-off promise of the last tick settled
  tick(): Promise<void>;   // exposed for tests; one at a time
}
```

- [ ] **Step 1: Failing tests** (`vi.useFakeTimers()`, a `let clock` behind `now`, real Postgres, a fake `runtimes.deliver` recording calls and returning a resolved promise; then one end-to-end test with the real `Runtimes` + fake driver):
  - arms at `min(next_run_at)` but never more than 60 s ahead (a schedule 3 h out: the timer fires every 60 s, nothing fires until due);
  - fires at the time: one row (`firings 1`, `late false`, `due` = the run), `next_run_at` advanced, `last_fired_at` set, `deliver(row, "agent", "scheduled")` called after commit;
  - catch-up: clock jumps 3 days across a weekday cron → one row, `firings` = missed count, `late true`, `due` = latest run, `next_run_at` = next future run; one-shot past → one row, late, `next_run_at` null (done);
  - archived target: no row, `next_run_at` advanced, `last_fired_at` unchanged; a one-shot to an archived target ends done with `ran` false;
  - 101 due schedules: two ticks, the second right after the first;
  - one tick at a time (a timer firing during a tick waits);
  - a firing that throws a non-deadlock error: `fail_count 1`, `retry_at = now + 5 s`, then 10, 20, 40, 60, 60 s; never re-armed at 0 ms (assert the timer delay ≥ 1 s after a no-progress tick); a deadlock is retried once before counting;
  - a schedule locked by another transaction (`SKIP LOCKED`) is skipped and fires on a later tick (≥ 1 s);
  - retargeted between the unlocked read and the lock → skipped this tick, fires to the new target next tick;
  - `rearm()` before `start()` and after `stop()` does nothing; `stop()` during a tick: the tick finishes its transaction, its hand-offs are skipped (`router.closed`), `idle()` resolves;
  - `idle()` awaits hand-off promises (assert by a deliver that resolves later).
  - End-to-end with `makeTestApp`: AC 1 (a hibernated `ceo` wakes with the envelope at 09:00 Berlin; fake driver).
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/scheduling/scheduler.test.ts` → FAIL.
- [ ] **Step 3: Implement** per spec §8.1 steps 1–4 (`dueIds` passes `$now`; lock target `FOR SHARE`; lock schedule `FOR NO KEY UPDATE SKIP LOCKED`; re-read; compute with `latestAtOrBefore`/`countRuns`/`nextRun`; archived skip; else `last_fired_at` and the message upsert of Task 11 — in this task the store's `upsertFiring` only inserts (Task 11 adds the replace and write-nothing cases); commit; then hand off). The timer delay: `clamp(earliest − now, progress ? 0 : TICK_MIN_MS, TICK_MAX_MS)` where `earliest = min(coalesce(retry_at, next_run_at))`.
- [ ] **Step 4: Run** → PASS; `pnpm vitest run apps/server/src/app` (wiring) → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): the scheduler: durable timer, firing, catch-up and backoff`.

---

### Task 11: Replace, never stack (spec §8.2, all three rules)

**Files:**
- Modify: `schedule-store.ts` (`upsertFiring(tx, …)`), `scheduler.ts` (call it), `agents/event-store.ts` (`writeBackScheduled(tx, rows)`), `agents/agent-runtime.ts` (`deliver` monotonic refresh; `flush` re-read; `writeBatch` write-back)
- Test: `apps/server/src/scheduling/replace.test.ts`

- [ ] **Step 1: Failing tests:**
  - **AC 3:** errored target, three firings → one pending row, `firings = 3`, body and author = the schedule's current ones (edit the body between firings: the row takes the new body and `body_author`), `created_at` unchanged, no recovery attempt;
  - a pending row with `delivered_event_seq` set (written to a not-yet-started process) → the firing writes nothing (no insert, no update; no `23505` escapes);
  - the runtime's queued entry is refreshed on hand-off: after the second firing the next batch carries `firings="2"`;
  - monotonic: an older hand-off (firings 1) arriving after `init()` loaded firings 2 doesn't regress the entry (call `rt.deliver` with the stale row object);
  - `flush` re-read: a runtime whose entry is stale (loaded at firings 1, row now 3) renders `firings="3"`; a row rejected meanwhile is dropped from the batch;
  - write-back: run `writeBatch` with a hook-free interleaving — render (entry at firings 2), then commit a replacement to firings 3 from another connection **before** `writeBatch`'s transaction (make the fake driver's `send` await a promise the test controls), then release: the row ends `delivered` with `firings = 2` and the body the agent saw (the row says what was read);
  - the partial unique index never lets two pending rows exist (concurrent firings of one schedule from two `Scheduler` instances: one fires, one skips by `SKIP LOCKED`).
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/scheduling/replace.test.ts` → FAIL.
- [ ] **Step 3: Implement:** `upsertFiring`: `SELECT … FROM messages WHERE schedule_id=$1 AND to_agent_id=$2 AND state='pending' FOR NO KEY UPDATE` → none: insert; `delivered_event_seq IS NULL`: update body/author/`due_at`/`firings + missed`/`late`; else nothing. Runtime: in `deliver`, for a seen id still queued, `const fresh = await this.d.store.pendingRow(row.id)`; replace `entry.row` only if `fresh && fresh.firings > entry.row.firings`. In `flush`, before `toEnvelopes`, re-read every `scheduled` entry of the batch (drop ones no longer pending). In `writeBatch`'s transaction, `writeBackScheduled(tx, batch rows of kind scheduled)` with the rendered fields.
- [ ] **Step 4: Run** → PASS; `pnpm vitest run apps/server/src/agents` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): scheduled firings replace the pending row instead of stacking`.

---

### Task 12: Boot clears stale write marks

Spec §5 ("Boot clears stale write marks").

**Files:** Modify `agents/event-store.ts` (`clearStaleWriteMarks()`), `supervisor/reconcile.ts` (call before `bootWakes`, after `rejectPendingToTerminated`); Test `supervisor/reconcile.test.ts` (extend).

- [ ] **Step 1: Failing test:** the review's path: a pending scheduled row with `delivered_event_seq` and `delivered_turn_id` set and its agent errored (`failCutShortAttempts` shape); run `reconcile`; the row's seq and turn id are null and state pending; then a firing **replaces** it (`firings 2`). A delivered row's seq is untouched (deep links keep working).
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/supervisor/reconcile.test.ts` → FAIL.
- [ ] **Step 3: Implement** `UPDATE messages SET delivered_event_seq = NULL, delivered_turn_id = NULL WHERE state = 'pending' AND delivered_event_seq IS NOT NULL`.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `fix(server): boot clears write marks left on pending rows`.

---

### Task 13: Lifecycle interactions (spec §10.1)

**Files:**
- Modify: `agents/event-store.ts` (`terminateRows` also `UPDATE schedules SET deleted_at = $now, next_run_at = NULL WHERE target_agent_id = $id AND deleted_at IS NULL`, after its agent locks), `agents/agent-service.ts` (`unarchive` in one transaction: lock `FOR NO KEY UPDATE`, clear `archived_at`, `recomputeFromNow` for every schedule targeting it, commit; then `runtimes.refresh`, then `scheduler.rearm()`)
- Test: `apps/server/src/scheduling/lifecycle.test.ts`

- [ ] **Step 1: Failing tests,** one per row of the spec §10.1 table:
  - terminate a spawned target → its schedules soft-deleted in the same transaction, pending scheduled rows rejected; restore → `409 target_ended`;
  - creator terminated: assert spawned agents can't create (no tools, Task 15) and `create` with a spawned creator actor is refused by the service (assertion);
  - archived target: skipped; create/retarget/restore to it refused; unarchive → `next_run_at` = next future run (no catch-up, the same `recomputeFromNow`);
  - archived persistent creator: its schedules keep firing; the item's `createdBy.archived` true;
  - errored target: pending, replaced, no attempt; item state `pending_errored`;
  - rate-limited credential: the row waits; after the reset it is delivered once with its `firings`;
  - hibernated and queued at a cap of 1: the row waits; replacement applies;
  - mid-turn: written at once (a `message_in` while the turn is open);
  - apply-restart / restart / crash while a row is pending: the row survives and is delivered after the start;
  - **server stops between commit and hand-off** (Q20): fire with `router.closed = true` so the hand-off is skipped; boot (`reconcile` + `bootWakes`) wakes the target and delivers the row exactly once (S6's seen set);
  - server stops before commit: the controller holds `LOCK TABLE messages IN SHARE MODE`; start `tick()`; wait for its lock wait (`pg_stat_activity`); kill its backend with `pg_terminate_backend(pid)`; assert nothing was written and `next_run_at` is unchanged; a later tick (after the backoff) fires it once, late;
  - shutdown: `app.close()` while a tick runs → the tick's transaction completes, no hand-off, `idle()` resolves before the DB closes (no "pool closed" errors);
  - before `bootDone`: REST create works and `rearm()` is a no-op; the first tick happens after `start()`.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/scheduling/lifecycle.test.ts` → FAIL.
- [ ] **Step 3: Implement** the two modifications above.
- [ ] **Step 4: Run** → PASS; `pnpm vitest run apps/server/src/spawning apps/server/src/agents/agent-service.test.ts` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): schedules follow termination, archive and unarchive`.

---

### Task 14: Races (spec §12.2)

**Files:** Test `apps/server/src/scheduling/races.test.ts` (S8's lock-wait helper: copy `waitForLockWait(sql, pattern)` polling `pg_stat_activity` where `wait_event_type = 'Lock'`).

- [ ] **Step 1: Write the tests** (each must pass without sleeps or server hooks; a controlling connection holds locks):
  - **termination first:** the test locks the spawned target `FOR NO KEY UPDATE` and sets `terminated_at` + soft-deletes its schedules in its own open transaction; start `scheduler.tick()`; wait for its lock wait; commit; the firing re-reads the schedule as deleted → no row;
  - **firing first:** hold `LOCK TABLE messages IN SHARE MODE` on the controller (blocks only the firing's insert, after its `FOR SHARE` on the agent); start the tick; wait; start `TerminateService.terminate`; wait for its lock wait on the agent row; release; the scheduled row ends `rejected` and the schedule `deleted_at` set;
  - **edit vs firing:** controller holds the schedule row `FOR NO KEY UPDATE`; the tick skips it (`SKIP LOCKED`); release; the next tick (≥ 1 s, fake timers) fires it with the edited values;
  - **firing vs batch write:** covered in Task 11 (reference it).
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/scheduling/races.test.ts` → fix any real defect test-first in the owning task's files.
- [ ] **Step 3:** `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 4: Commit** `test(server): schedule lock-order races`.

---

### Task 15: The three MCP tools (persistent agents only)

Spec §9.

**Files:**
- Create: `apps/server/src/mcp/tools/schedule-tools.ts`, `schedule-tools.test.ts`
- Modify: `apps/server/src/app.ts` (tool list: `...(caller.kind === "persistent" ? scheduleTools({ schedules }) : [])`)

- [ ] **Step 1: Failing tests** over real HTTP (port-0 agent listener, real tokens, `callTool` from `mcp/testing/mcp-client.ts`):
  - a persistent agent's `tools/list` includes `schedule_message`, `list_schedules`, `cancel_schedule`; a spawned agent's doesn't (and calling them → unknown tool);
  - `schedule_message({body, cron:"0 9 * * 1-5"})` → `{id:"S-1", to:"<self>", cron, timezone:<FACTORY_TIMEZONE>, next_run:"…+01:00", note: "You will be woken at each run; cancel it with cancel_schedule when it is no longer needed."}`; with `at`; to an errored agent → the errored note; identity from the token (a `by`-like extra field in args is rejected by the schema / ignored);
  - `*/5` → the 15-minute sentence as a tool error; 21st → the limit sentence;
  - `list_schedules` returns own + targeting with `yours`; `cancel_schedule("s-1")` works; someone else's → the sentence;
  - a live agent token on `GET /api/schedules` → 401 (also in Task 23).
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/mcp/tools/schedule-tools.test.ts` → FAIL.
- [ ] **Step 3: Implement** following `task-tools.ts` (descriptions: "Schedule a message that survives restarts and wakes its target at each run (a 5-field cron, or a one-shot at). For a short loop inside this session, use CronCreate instead." / "List your schedules and the ones that target you." / "Cancel a schedule you created."). Results: one text block of compact JSON; errors: `toolError(sentence)`.
- [ ] **Step 4: Run** → PASS; `pnpm vitest run apps/server/src/mcp` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): schedule_message, list_schedules and cancel_schedule`.

---

### Task 16: The generated CLAUDE.md (Scheduling section)

Spec §7.1, §10.5.

**Files:** Modify `apps/server/src/workspace/claude-md.ts` (+ `claude-md.test.ts`), the call site that builds `ClaudeMdInput` (pass `scheduling: { zone, maxSchedules, minGapMinutes } | null` for persistent agents).

- [ ] **Step 1: Failing tests** (the config part landed in Task 7): CLAUDE.md: the "How messages reach you" paragraph lists `scheduled` and the `@scheduler` sentence (spec §10.5 verbatim); a persistent agent has the three Scheduling bullets with "Schedules use Europe/Berlin unless you pass `timezone`." and "at most 20" / "every 15 minutes"; a spawned agent has only the CronCreate bullet; the file is byte-identical for identical inputs.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/workspace/claude-md.test.ts` → FAIL.
- [ ] **Step 3: Implement** (copy the spec's sentences exactly; update the snapshot once, reviewing the diff).
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): scheduling guidance in the generated CLAUDE.md`.

---

### Task 17: Live gate 2: `pnpm smoke:scheduling --early` (V3, V4)

Run as soon as the tools exist. The script grows to the full run in Task 30.

**Files:**
- Create: `apps/server/scripts/smoke-scheduling.ts`
- Modify: `package.json` (`"smoke:scheduling": "node --env-file-if-exists=.env --import tsx apps/server/scripts/smoke-scheduling.ts"`)

- [ ] **Step 1: Write the script**, copying `smoke-tasks.ts`'s scaffolding verbatim (token read from `~/.open-factory-spike/oauth-token` into a factory credential, `redact`/`say`/`ok`/`fail`, throwaway database, temp `FACTORY_HOME`, Docker on `open-factory-base:dev`, `--local`, cleanup). A template with `warm_window_minutes: 1`. Org: `ceo` (persistent, top-level, can spawn), user `or`. It talks to the app **only** through real REST routes (`app.inject` with a signed-in cookie) and the agents through the real MCP. `--early` steps:
  1. `POST /api/schedules {target:"ceo", at:<now+90 s ISO>, timezone:"UTC", body:"Call list_schedules, then use schedule_message to schedule a message to yourself with cron \"0 9 * * 1-5\" and another with at in 2 minutes. Then say DONE."}` as `or`.
  2. Wait (poll `GET /api/agents/ceo/events`, at most 240 s) for `system/init`: assert the three `mcp__factory__*schedule*` tools are listed.
  3. Assert the first `message_in` holds a `scheduled` envelope with `scheduleKey: "S-1"` and `by: "@or"`.
  4. Assert `ceo` called `list_schedules` and `schedule_message` twice (one `cron`, one `at`), and `GET /api/schedules?target=ceo` shows them created by `ceo`.
  5. Ask `ceo` (a human message via REST) to spawn a child with any template and report; when the child's `system/init` arrives, assert it lists none of the three tools.
  Print PASS/FAIL per step; exit 1 on any failure.
- [ ] **Step 2: Run** `pnpm build && pnpm smoke:scheduling --early` (Docker running). If a step fails because of a defect (not model wording), fix it test-first in the owning task's files; if the model mis-reads the envelope (V4), sharpen the CLAUDE.md line (Task 16's files), never script phrasings. If the optional `cron`/`at` pair confuses the model (V3), report to the lead before splitting the tool.
- [ ] **Step 3: Keep the redacted output** for the PR; never commit it.
- [ ] **Step 4: Commit** `chore(server): live scheduling smoke, first slice`.

---

### Task 18: Checkpoint B: review findings applied

- [ ] **Step 1:** `pnpm test`, `pnpm typecheck`, `pnpm lint` green; push.
- [ ] **Step 2:** Message the lead: "Chunk B (Tasks 10–17) done at <sha>: … smoke --early: <PASS/FAIL lines>. Please review." Continue with Task 19/20 meanwhile.
- [ ] **Step 3:** Apply findings test-first; commit `fix(server): chunk B review findings`; reply to the lead with each finding and its fix before starting Task 23.

---

## Chunk C: harness crons, REST, web foundations (Tasks 19–27)

### Task 19 (conditional on Task 1's V2): durable cron cleanup before every start

**Skip this task, and say so in the PR, if V2 was negative.** Mandatory if V2 was positive. Spec §10.4.

**Files:** Modify `apps/server/src/agents/start.ts` (before every launch, both runtimes); Test `start.test.ts` (extend).

- [ ] **Step 1: Failing tests:** a `<workdir>/.claude/scheduled_tasks.json` is removed before the start and an info log names the agent slug; a symlink at that path pointing outside the workdir is removed as a link without touching its target (SafeFs never follows links); a missing file is fine; the path is built only from the agent's own working directory.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/agents/start.test.ts` → FAIL.
- [ ] **Step 3: Implement** with the workspace's `SafeFs` (`unlinkNoFollow` or its equivalent), path `path.join(workdir, ".claude", "scheduled_tasks.json")`.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `fix(server): no durable cron outlives a process`.

---

### Task 20: The live cron list on the agent status

Spec §10.2.

**Files:** Modify `agents/agent-runtime.ts` (`LiveCron.durable`; `cronsList()`; summary and `agent_status` `crons`, `cronZone`, `stopCronsPending`), `agents/runtimes.ts` (offline summary defaults), `agents/agent-service.ts` (`scheduleCount` via `ScheduleService.scheduleCountFor`); Test `agents/agent-runtime.crons.test.ts`.

- [ ] **Step 1: Failing tests:** after `cron_created` (recurring, durable false) and a one-shot, the status frame's `crons` lists both: the one-shot with `nextFireAt` and no `expiresAt`, the recurring with `expiresAt = createdAt + 7 days` and no `nextFireAt`; `durable: true` carried; after `cron_deleted` and after the one-shot's firing turn they disappear; `cronZone` is `"UTC"` for a Docker agent and `factoryZoneDefault()` for a local one; the summary's `scheduleCount` counts not-deleted, not-done schedules targeting it.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/agents/agent-runtime.crons.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): live cron list and schedule count on the agent status`.

---

### Task 21: `isPassive` everywhere (before Stop crons, so its tests can go green honestly)

Spec §10.3 (the passive notice), round-2 finding 3.

**Files:** Modify `agents/agent-runtime.ts` (the `reportLostWork` exclusion for `crons_stopped`; `isPassive(entry)`, used in `hasDeliverable`, the `queued_items` wake, `reapable`, `flush`), `agents/event-store.ts` (`deliverableWhere`: `kind = 'system' AND notice <> 'crons_stopped'`); Test `agents/agent-runtime.passive.test.ts`.

- [ ] **Step 1: Failing tests** (insert the `crons_stopped` notice row directly with the store's `createNotice`; Stop crons doesn't exist yet): with only the passive notice queued: no `queued_items` wake after the exit; `hasDeliverable()` false; `bootWakes` doesn't return the agent; `flush` writes nothing to a running process; the Reaper reaps a spawned agent whose only queued item is the notice; a later human message → one batch with the notice first, then the message; a compact queued behind the passive notice runs (the compact is written, the notice stays queued); a second notice of that type replaces the first (one pending row of that type); `reportLostWork` doesn't forward a `background_work_lost` with reason `crons_stopped` (appended directly).
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/agents/agent-runtime.passive.test.ts` → FAIL.
- [ ] **Step 3: Implement** the one predicate and its five uses; in `flush`, when the head is passive-only and the next entry is a compact, write the compact.
- [ ] **Step 4: Run** → PASS; `pnpm vitest run apps/server/src/spawning apps/server/src/agents` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): the crons_stopped notice never wakes or keeps an agent`.

---

### Task 22a: Stop crons in the runtime: the basics

Spec §10.3 (state table rows: none, ended, idle, busy, other stop under way; the notice). Task 22b adds the apply-restart interplay.

**Files:**
- Modify: `agents/agent-runtime.ts` (`stopCrons(byHandle): Promise<{status: "stopped" | "pending"}>`, `stopCronsPending`, the trigger, takeover of an `apply_changes` hibernate, `restart_crons` suppression, `maybeRestart` skip and re-run when crons reach 0), `agents/notices.ts` (`cronsStopped({by, crons})` → "@or stopped your crons: every 5 minutes; at 14:30, once. Don't recreate them unless you are asked to."), `agents/runtimes.ts` (`stopCrons(slug, by)` with archived/terminated refusals)
- Test: `apps/server/src/agents/agent-runtime.stop-crons.test.ts`

**Interfaces — Produces:** `class StopCronsError extends ApiError` with codes `no_crons` (409, "@x has no crons.") and `stopping` (409, "@x is already stopping; its crons stop with it.").

- [ ] **Step 1: Failing tests** (this task: the idle and busy rows, the notice, the refusals):
  - no process / no crons → `no_crons`; archived / terminated → their refusals;
  - idle with 2 crons → `{status:"stopped"}`; the process gets stdin closed (S5 path); `hibernated{reason:"crons_stopped", by:"@or"}` and `background_work_lost{reason:"crons_stopped", by:"@or", crons}` appended; the notice is pending, lists both crons; **no wake** follows (Task 21's predicate); the manager receives **no** `work_lost` row (Task 21's exclusion);
  - busy (open turn) → `{status:"pending"}`, `stopCronsPending` in the frame; the turn ends → stops in that job though the pin is live and the warm window not reached; a cron created while pending is listed in the notice;
  - errored-with-a-process, attempting, rate-limited-with-a-process → pending, then stops when not busy;
  - any other stop under way (restart, shutdown, terminate, dead/failing process, `stop_failed`) → `stopping`;
  - spawned agent: same behaviour.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/agents/agent-runtime.stop-crons.test.ts` → FAIL.
- [ ] **Step 3: Implement.** The stop job adds the notice (from the crons live at that moment) and calls `beginHibernate("crons_stopped")` in the same job; `HibernateReason` gains `crons_stopped`.
- [ ] **Step 4: Run** → PASS; `pnpm vitest run apps/server/src/agents` → PASS (S5's apply-restart tests unchanged); `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): stop an agent's crons`.

---

### Task 22b: Stop crons in the runtime: apply-restart, crons reaching 0, exits

Spec §10.3 (the apply-restart rows and bullets).

**Files:** Modify `agents/agent-runtime.ts` (takeover of an `apply_changes` hibernate, `restart_crons` suppression, `maybeRestart` skip and re-run when crons reach 0, clearing on exit/shutdown); Test: the same `agent-runtime.stop-crons.test.ts`.

- [ ] **Step 1: Failing tests:**
  - restart pending (an apply-restart waiting on a background task): the stop runs at the first not-busy moment (it doesn't wait for `restartPending`); no `restart_crons` notice; the exit wakes the agent only because a non-passive item exists; with none it stays hibernated, and the next start reads the new config (assert the runtime spec is rebuilt);
  - an `apply_changes` hibernate already under way → taken over: reason `crons_stopped`, notice added, no `restart_crons`, `{status:"stopped"}`;
  - crons reach 0 while pending (a `cron_deleted`) → pending cleared, `maybeRestart()` runs (a held restart goes ahead);
  - exit or shutdown while pending → cleared.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/agents/agent-runtime.stop-crons.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm vitest run apps/server/src/agents` → PASS (S5's apply-restart tests unchanged); `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): stop crons wins over a pending apply-restart`.

---

### Task 23: REST: `/api/schedules*` and stop-crons

Spec §11.

**Files:** Create `apps/server/src/routes/schedules.ts`, `routes/schedules.test.ts`; Modify `routes/agents.ts` (`POST /api/agents/:slug/stop-crons`), `app.ts` (register).

- [ ] **Step 1: Failing tests** (`makeTestApp`, `signUp`): every route of the §11 table with its codes (`201`, `400 invalid_schedule` with the field's sentence and `field`, `404 schedule_not_found`, `409 already_paused | not_paused | schedule_done | target_ended`); `GET /api/schedules/:key` of a deleted one → `deleted: true`; ordering and `?target`/`?done`; every mutation publishes `schedules_changed` once after commit; `stop-crons` → `{status}` / `409 no_crons` / `409 stopping`; **a live agent token** (mint one through a real start with the fake driver) on every `/api/schedules*` route and on `stop-crons` → `401`.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/routes/schedules.test.ts` → FAIL.
- [ ] **Step 3: Implement** (`requireUser` as an `onRequest` hook, as `routes/tasks.ts` does; bodies parsed with the shared schemas).
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): schedules REST API and stop-crons`.

---

### Task 24: Web foundations: API, time formatting, state, badge, frames

UI doc §1, §8.

**Files:** Create `apps/web/src/features/schedules/{api.ts,format.ts,format.test.ts,schedule-state.tsx,schedule-badge.tsx}`; Modify the WS frame handling (invalidate `["schedules"]` and the agent summary on `schedules_changed`), `features/tasks/agent-picker.tsx` (`placeholder` and `extraOption` props, default unchanged).

- [ ] **Step 1: Failing tests:** `formatScheduleTime(new Date("2026-11-23T08:00:00Z"), "Europe/Berlin", now)` → "Mon 23 Nov 09:00" + zone part "Europe/Berlin"; a different year shows it ("Tue 4 Jan 2028 09:00"); the `<time>` has `datetime` and a title with "your time"; `ScheduleState` renders icon + label per state (no orange class); `AgentPicker` with `placeholder="Choose an agent…"` and an extra "@x (archived)" option keeps that value selected.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/schedules` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): schedule API, time format, state and badge`.

---

### Task 25: Web: Schedules list (`/schedules`)

UI doc §2.

**Files:** Create `features/schedules/{schedule-list.tsx,schedule-row.tsx,schedule-filters.tsx}` + tests; `routes/_app/schedules.index.tsx` (replaces `schedules.tsx`; regenerate `routeTree.gen.ts` with the existing router plugin/dev command).

- [ ] **Step 1: Failing tests:** four-line rows with the exact texts per state (Next/Ran/Didn't run/(skipped)/—, "· archived", "· errored", authors line); the stretched link and the menu's accessible name "Actions for S-3"; Pause/Resume/Delete apply at once with the outcomes ("Paused S-3.", "Resumed S-3. Next run: …"); Delete → "Deleted S-3." + Undo with focus on Undo; Undo restores and focuses the row menu; a done restore with Show done off → "Restored S-3. It's done, so it's hidden." + "Show done"; `409 target_ended` text; filters in the URL; empty/filtered-empty/error/cap texts; outcomes passed as router state are shown once (not after reload); `schedules_changed` refetch keeps focus; **escaping:** a body `<img src=x onerror=alert(1)>` followed by raw HTML and markdown (`<script>…</script>`, `**bold**`, `[x](javascript:alert(1))`) shows as the literal first line in plain text, creates no `img`/`script`/`a` element and runs nothing (a spy on `window.alert` and a DOM query assert it).
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/schedules` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): the Schedules list`.

---

### Task 26a: Web: the create page and the When, zone and preview fields

UI doc §3 (fields 1–6, validation).

**Files:** Create `features/schedules/{schedule-form.tsx,when-field.tsx,timezone-select.tsx,run-preview.tsx}` + tests; `routes/_app/schedules.new.tsx`.

- [ ] **Step 1: Failing tests:** the When fieldset (two native radios, only the chosen field rendered, the other's value kept); help text and examples verbatim; the zone select grouped by region with UTC and the browser's zone always present; preview updates on blur of the pattern/date and on radio/zone change only (not per keystroke, not from Message), with "(08:00 your time)" when zones differ; validation on blur with each sentence; submit focuses the first invalid field; the "Choose an agent…" placeholder and the spawned-agent helper; the unsaved-changes guard on Cancel/navigation; create → `/schedules` with "Created S-8.".
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/schedules` → FAIL.
- [ ] **Step 3: Implement** (reuse S4's `MarkdownEditor`, form layout and unsaved-changes guard; `cron.ts` from `@open-factory/shared` for the preview and the pattern check).
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): create schedules`.

---

### Task 26b: Web: the edit page, deleted and restore states

UI doc §3 (edit page only).

**Files:** Modify the form files; create `routes/_app/schedules.$key.tsx` + tests.

- [ ] **Step 1: Failing tests:** edit sends **only changed fields** and validates only those (a done one-shot's message edit saves); the archived current target kept as an extra option; "Saving a changed message makes you its author." when the author is an agent; pending-firing notes; done header line; `schedules_changed` keeps edited fields; not-found and deleted states (read-only, Restore with pending/failure; no Restore when the target is terminated); **escaping in the read-only deleted view:** the same hostile body as Task 25 renders through the existing sanitized `Markdown` renderer (or the editor's preview) with no `img`/`script` element, no `javascript:` link and no `alert` call; header actions become icon buttons below `md`.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/schedules` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): edit, delete and restore schedules`.

---

### Task 27: Checkpoint C: review findings applied

- [ ] **Step 1:** `pnpm test`, `pnpm typecheck`, `pnpm lint` green; push.
- [ ] **Step 2:** Message the lead: "Chunk C (Tasks 19–26) done at <sha> (Task 19: <done|skipped, V2 negative>). Please review." Continue with Task 28 meanwhile.
- [ ] **Step 3:** Apply findings test-first; commit `fix: chunk C review findings`; reply with each finding and its fix before Task 30.

---

## Chunk D: session UI, live check, PR (Tasks 28–31)

### Task 28: Web: scheduled messages in the session

UI doc §4.1, §4.3.

**Files:** Modify `features/session/` (`MessageBlock` scheduled sender line and notes; queue item badge and "covers N runs"; timeline quiet lines for `hibernated`/`background_work_lost` with `crons_stopped` and `cron_created` durable) + tests.

- [ ] **Step 1: Failing tests:** a delivered scheduled block shows "Scheduler", the `S-3` badge linking `/schedules/S-3`, "by @or" (an agent author links to its session), "due … · delivered late" only when `late`, "covers 3 runs" only when `firings > 1`; a pending one in the dashed block with the badge; the three quiet lines verbatim, using the events' `by` (no prose parsing); **escaping:** a scheduled block whose body is `<img src=x onerror=alert(1)>` plus raw HTML and markdown goes through the existing sanitized `Markdown` renderer: markdown formats, the HTML stays text, no `img`/`script` element, no `javascript:` href, `window.alert` never called.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/session` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): scheduled messages in the session`.

---

### Task 29: Web: the strip's crons popover, Stop crons, schedules segment

UI doc §4.2.

**Files:** Create `features/session/{crons-popover.tsx,stop-crons-dialog.tsx}` + tests; Modify `AgentStrip`.

- [ ] **Step 1: Failing tests:** "2 crons" is a button named "2 crons: show and stop" opening a labelled popover; rows per cron (one-shot "next" via `formatResetTime`, recurring "expires …", "(kept on disk)" for durable); the zone line only when the viewer's zone differs from `cronZone`; opening Stop closes the popover and opens `ConfirmDialog` with the title, the cron list, the body sentence and "Stop 2 crons"/"Stopping…"; focus starts on Cancel; failure in the dialog's alert line; `409 no_crons`/`stopping` treated as done; the session `InlineOutcome` announces "Stopped @dev's crons." / "@dev's crons stop when its current work finishes."; focus falls back to the composer when the strip button is gone; pending text "2 crons · stopping when @dev's current work finishes"; "2 schedules" link hidden at 0 and below `md`, refetched on `schedules_changed`.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/session` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): crons popover with Stop crons, and the schedules link`.

---

### Task 30: Final live check and verification

- [ ] **Step 1: Extend `smoke-scheduling.ts` to the full run** (spec §17.5; without `--early`), after the early steps:
  1. A human creates `* * * * *` (humans have no floor) to `ceo`; it fires within ~60 s and `ceo` receives a `scheduled` envelope.
  2. `ceo` is asked (human message) to call `schedule_message` with `cron:"*/5 * * * *"`; assert its tool result is the 15-minute sentence; it calls `cancel_schedule` on its own `at` schedule; assert `GET /api/schedules` reflects it.
  3. **Replacement via a real path:** the smoke app runs with `FACTORY_MAX_RUNNING_AGENTS=1` (normal config); `ceo` is kept busy with a long human-requested task (e.g. "run `sleep 200` in the foreground"), so a second agent `qa` is queued at the cap; two firings of a human `* * * * *` schedule to `qa` leave one pending row with `firings=2` (`GET /api/agents/qa/queue`).
  4. **Restart:** stop the app with a one-shot due during the downtime (at now + 30 s, stop at once, wait 60 s, start again on the same database): it fires once with `late="true"`.
  5. **Crons:** ask `ceo` (human message) to run `CronCreate` with `*/2 * * * *`; assert `GET /api/agents/ceo` lists 1 cron and it stays up past its 1-minute warm window; `POST /api/agents/ceo/stop-crons` → `{status}`; assert `hibernated{reason:"crons_stopped"}`; send a human message; assert the next batch starts with the `crons_stopped` notice.
  Run `pnpm build && pnpm smoke:scheduling` → all PASS. Keep the redacted output for the PR.
- [ ] **Step 2: Full verification** (paste the summary lines into the PR):

```bash
pnpm compose up -d
pnpm test
pnpm typecheck
pnpm lint:ci
pnpm build
```

- [ ] **Step 3: Manual browser pass** (`pnpm dev`): create a weekday schedule (preview in another zone shows "your time"), edit, pause/resume, delete + Undo, Show done; an agent's scheduled message in its session with the badge; the crons popover and Stop crons on a pinned agent (both outcomes); both themes; one phone-width pass. Fix anything off test-first before the PR.
- [ ] **Step 4: Record** in `packages/harness/fixtures/README.md` ("Verified in S9 implementation": smoke lines, Claude Code version) and commit `docs: record S9 live verification`. Send the lead the lines for `open-questions.md`.

---

### Task 31: Pull request

- [ ] **Step 1:** `git push`; open the PR against `spec/s8-tasks-inbox` (stacked) following `.github/pull_request_template.md` and AGENTS.md:
  - **Title:** `feat: durable schedules and stoppable in-session crons`
  - **What:** schedules (cron or one-shot, per-schedule zone) delivered as `scheduled` messages from `@scheduler`, replaced instead of stacked, fired once after downtime; three MCP tools for persistent agents; the Schedules page; the live cron list and Stop crons.
  - **Why:** the S9 roadmap item; link the spec `docs/superpowers/specs/2026-11-20-s9-scheduling-design.md`, the UI design, this plan and the decision issue #64. Closes #31.
  - **Approach** (one bullet per decision, "X, rather than Y, because Z"): a `next_run_at` column and one in-process timer, rather than pg-boss, because replace-not-stack and catch-up are ours either way and pg-boss would add a schema and workers for one timer; update the pending row in place, rather than stacking or superseding rows, because an undelivered firing hasn't happened yet; fire once late after downtime, rather than skipping, because the agent can judge from `due`/`late` (if Or prefers skipping, it is one branch and one test); `from="@scheduler" by="<author>"`, rather than a factory preface, because senders and authors both stay truthful; no `harness_crons` table, rather than persisting crons, because they die with the process; Stop crons hibernates the agent, rather than asking it to `CronDelete`, because it is deterministic; plain 5-field cron, rather than croner's extensions, because what we accept is what people know; no schedule tools for spawned agents, rather than per-agent TTL rules, because a spawned agent is one phase of work.
  - **Changes** grouped by area (shared, db, harness, server scheduling, server runtime, MCP, CLAUDE.md, REST, web schedules, web session, smoke). **Behaviour changes to S5–S8, listed explicitly:** `entryOf`/`senderLabel` render `scheduled` rows as `@scheduler`; `deliver` refreshes a seen, queued scheduled entry monotonically; `flush` re-reads scheduled rows before rendering; `writeBatch` writes the rendered scheduled fields back; boot clears write marks on pending rows; `isPassive` in `hasDeliverable`, the `queued_items` wake, `reapable`, `flush`, `deliverableWhere`; `unarchive` runs in a transaction and recomputes schedules; termination soft-deletes schedules targeting the agent; `reportLostWork` doesn't forward `crons_stopped`; apply-restart keeps not waiting for crons.
  - **Non-goals:** pg-boss, a `harness_crons` table, schedules to humans (#65), `TZ` in containers (#66), agent edit/pause tools, a cron describer, purging; #47/#57 notes only.
  - **Verification:** Task 1's V1/V2 results, both smoke outputs (redacted), the test/typecheck/lint/build lines, the manual pass; Task 19 done or skipped (V2). New direct dependency `croner`: the exact version, its publish date and the recorded `minimumReleaseAge` value (or "unset; ≥ 14 days") from Task 2; no supply-chain setting changed. The skip-late fallback for Q3 is stated as a sentence (not shipped as a switch).
  - Remove the template's HTML comments; end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 2:** Report the PR URL to the lead.

---

## Acceptance criteria → tasks

| AC | Proven by |
|---|---|
| 1 Weekday cron fires, wakes, survives a restart | Tasks 2, 10 (AC 1 and catch-up), 13, 17/30 (live) |
| 2 Harness crons pin; Stop crons | S5 tests kept, Tasks 20, 21, 22, 29, 30 |
| 3 No stacking | Tasks 11, 12, 30 |
| 4 Agent tools and bounds; 401 | Tasks 7, 8, 15, 23, 17/30 |
| 5 Lifecycle and the termination race | Tasks 13, 14 |
| 6 Time zones and DST | Tasks 2, 26 |
| 7 CI and live | Tasks 30, 31 |

## Spec §17 tests → tasks

§17.1 unit → Tasks 2, 3, 5, 7 (config), 16. §17.2 Scheduler → Task 10; AC 1 and catch-up → Task 10; AC 3 replacement → Tasks 11, 12; backoff → Task 10; lifecycle → Task 13; races → Tasks 7, 14; tools → Task 15; REST → Task 23; harness crons, `isPassive` and Stop crons → Tasks 20, 21, 22a, 22b; round-2 cases → Tasks 7, 11, 21, 22b. §17.3 harness → Tasks 2, 5. §17.4 web → Tasks 24, 25, 26a, 26b, 28, 29. §17.5 live → Tasks 1, 17, 30. §18 V1/V2 → Task 1 (V2 → Task 19); V3/V4 → Task 17; V5 → Task 4; V6 → Task 2.
