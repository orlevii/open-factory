# S5 Supervisor and Docker Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents wake on messages, stay warm while busy or pinned and for a warm window after, hibernate through one safe path, share a global cap with a FIFO queue, recover once from crashes with a factory notice, pause per credential on rate limits, and run sandboxed in Docker by default, with the local runtime an operator opt-in.

**Architecture:**
- `packages/shared` gains `statusOf`, the new statuses, factory events, frames and the notice message kind.
- `packages/harness` splits byte transport from `ClaudeProcess` (`LocalTransport` here, the Docker transport injected from the server), makes `stop()` idempotent and drops `session_state_changed`.
- `apps/server` gains:
  - a `Supervisor` (slots, FIFO wake queue, eviction, credential pauses, closing latch, boot reconciliation);
  - `AgentRuntime` job primitives (`startNow`, `beginHibernate`, `beginForceStop`) driven by `afterExit` intents;
  - the busy model, cron pin and warm timer;
  - the crash policy with one `attempting` flag;
  - `@factory` system notices;
  - factory-owned state (`FACTORY_HOME/state/agents/<slug>/`), `SafeFs`, `checkMounts` and factory-owned plugin installs;
  - the local `ProcessJournal`;
  - the Docker `ContainerManager` and `DockerExecTransport` (dockerode);
  - the `FACTORY_ALLOW_LOCAL_RUNTIME` gate.
- The web gains the new statuses, the strip's waiting-on and runtime segments, Restart, Start a new session, Factory notices and lifecycle lines.

**Tech Stack:** Node 24, TypeScript 7, Fastify 5, Drizzle + postgres.js, Zod 4, React 19 + TanStack Router/Query, Tailwind 4 + shadcn/ui, Vitest + Testing Library, Biome. New runtime dependency: `dockerode` (server) with `@types/dockerode` (dev).

**Spec:** `docs/superpowers/specs/2026-11-19-s5-supervisor-docker-design.md` (it wins over this plan on any conflict) and the UI design `docs/superpowers/designs/2026-11-19-s5-supervisor-ui-design.md`. Decision log: https://github.com/orlevii/open-factory/issues/38. Follow-ups that are NOT S5 work: #39–#45, #23, #26. Evidence: the spec's §19 and `packages/harness/fixtures/README.md`. Read the spec's §5, §6, §9 and §11 before any runtime or Docker task.

## Global Constraints

- **Dependencies:**
  - Add a dependency with `pnpm --filter <pkg> add <name>@latest`, then check `npm view <name> version`. Never hand-pin.
  - **Never loosen the pnpm supply-chain policy** (`minimumReleaseAge` and friends). If an install is blocked by it, pick an older release that passes, or stop and report.
  - Never `pnpm dlx <tool>@latest`. shadcn components: `pnpm --filter @open-factory/web exec shadcn add <component>`.
  - dockerode's optional native deps (`ssh2`, `cpu-features`) must **not** be added to `allowBuilds` in `pnpm-workspace.yaml`. A blocked build of them is expected and fine.
- **Package layout:** ESM, Node >= 24, `@open-factory/*`; `packages/*` export `.ts` source; Biome only (`pnpm lint`, `pnpm lint:fix`, `pnpm lint:ci`).
- **Error shape:** `{ error: { code, message, fields? } }`. Codes added in S5: `409 not_errored`, `409 attempt_in_progress`, `409 resume_unrecoverable`, `409 runtime_disabled`, `409 reset_not_allowed`. S3's `503 agent_start_failed` is reused for immediate start failures.
- **Config (env, one module `apps/server/src/config.ts`):** `FACTORY_MAX_RUNNING_AGENTS` (default 8, min 1), `FACTORY_ALLOW_LOCAL_RUNTIME` (default false), `FACTORY_DEFAULT_IMAGE` (default `ghcr.io/orlevii/open-factory/base:latest`), `FACTORY_DOCKER_CLAUDE_BIN` (default `claude`), `FACTORY_CLI_BUNDLE` (default `apps/cli/dist/open-factory.js` resolved from the repo root), `FACTORY_AGENT_URL` (default `http://host.docker.internal:<PORT>`). `FACTORY_HOME` is canonicalized with `realpath` after it is created.
- **Child env:** local = S4's allowlist plus the factory vars (unchanged). Docker = only `CLAUDE_CONFIG_DIR`, the one credential var, the secrets, the git identity and `OPEN_FACTORY_URL`. Plugin CLI env = exactly `PATH`, the host `HOME`, `CLAUDE_CONFIG_DIR=<factory-owned plugins-config>`, cwd an empty factory temp dir. Never `SSH_AUTH_SOCK`, `DATABASE_URL`, `FACTORY_SECRET_KEY`, the server's `ANTHROPIC_*`/`CLAUDE_*`.
- **Timings:** stop = close stdin, `graceMs` 3000, SIGTERM, `termWaitMs` 10000; owed-notification bound 30 s; journal snapshot 10 s; reap SIGTERM → 3 s → SIGKILL; container stop `t: 5`; ready-marker poll 200 ms, timeout 30 s; rate-limit fallback 30 min; warm window from the snapshot (default 70 min). S3's 20 s shutdown force-exit is unchanged.
- **Docker create options (asserted by a test):** `HostConfig.SecurityOpt: ["no-new-privileges:true"]`, `Tmpfs {"/run/open-factory": ""}`, `ExtraHosts ["host.docker.internal:host-gateway"]`, never `Privileged`, no `CapAdd`, never host network or host pid, `Env` only `HOST_UID`/`HOST_GID`, mounts only from `checkMounts`.
- **Claude in a container:** `exec -u agent -w <workdir>`, `Cmd = ["sh","-c","echo $$ > /tmp/open-factory-claude.pid && exec \"$0\" \"$@\"", <claude path>, ...args]`. terminate: `cat` the pid file, parse `/^[1-9][0-9]{0,9}$/`, `cat /proc/<pid>/comm` must equal `claude`, `["kill","-TERM",pid]` as `agent`. Argv arrays only.
- **Statuses:** `hibernated | queued | working | idle | rate_limited | errored`; only `errored` stored; precedence only in `statusOf` (spec §8.1).
- **No automated test calls a live model or the network.** Live checks (`pnpm smoke:docker`, the Task 1 gate) read `~/.open-factory-spike/oauth-token` into the env at run time, use `--model haiku`, and never print or commit it.
- **Docker tests** run only with `FACTORY_DOCKER_TESTS=1` and the local image `open-factory-base:dev`. Default CI never needs Docker.
- **UI rules (DESIGN.md + UI doc):** status = shape + label (the tooth only for `working`, never a dot); orange only for live/focused/selected; never `transition-all`; type in rem; no toasts; confirmation dialogs only for Delete template, Delete credential, Delete secret and Start a new session; inline outcomes; "crons" is the only term for in-session crons; credential names in mono; "retrying at HH:MM" whenever `rateLimitExact` is false; UI copy never mentions roadmap IDs.
- `docs/product/` is gitignored and read-only: never edit it.
- **Commits:** one per task, conventional message, ending with the `Co-Authored-By` attribution line from your own session's system reminder (not a fixed model name; the examples below show the shape).

## File Structure

```
packages/shared/src/
  status.ts        (new) statusOf(), StatusInputs
  agents.ts        (modify) AgentStatus +queued/rate_limited, summary fields, QueueItem kind "notice", running
  events.ts        (modify) factory events, message_in kind, error.fix "runtime", control "restart", process_started.reason
  ws.ts            (modify) agent_status fields, supervisor frame
  handle.ts        (modify) RESERVED_HANDLES + "factory"

packages/harness/
  src/transport/types.ts   (new) Transport
  src/transport/local.ts   (new) LocalTransport
  src/claude/process.ts    (modify) ClaudeProcess over a Transport; idempotent stop
  src/claude/driver.ts     (new) createClaudeDriver({log, transports})
  src/claude/mapper.ts     (modify) drop system/session_state_changed
  src/types.ts             (modify) FactoryMessage.kind, AgentRuntimeSpec.docker?
  testing/fake-claude.mjs  (modify) process.title, cwd in plugin.log
  fixtures/session-state-changed-background.jsonl (moved from pending/)
  fixtures/rate-limit-event-rejected.jsonl (new, synthetic, labelled unverified)

packages/db/
  src/schema/agents.ts, factory.ts  (modify) new columns
  migrations/0003_*.sql             generated, CHECK added by hand

apps/server/src/
  config.ts                  (modify) new vars, canonical FACTORY_HOME, localRuntimeAllowed()
  workspace/paths.ts         (modify) stateDir, templateCopyDir, resyncRoot, resyncPendingDir, pluginsConfigDir
  workspace/state-migration.ts (new) one-time move of <workdir>/.factory
  workspace/safe-fs.ts       (new) SafeFs
  workspace/mounts.ts        (modify) buildMounts from factory inputs, checkMounts
  workspace/plugins.ts       (modify) factory-owned install env/cwd
  workspace/settings.ts      (modify) plugin keys from plugins-config
  workspace/workspace.ts, files.ts, links.ts (modify) SafeFs, staged re-sync, plugins link
  workspace/claude-md.ts     (modify) @factory sentence
  agents/runtime-spec.ts     (modify) buildAgentEnv runtime parameter
  agents/notices.ts          (new) notice texts
  agents/resume-failure.ts   (new) classifyResumeFailure
  agents/event-store.ts      (modify) createNotice, pendingQueue order + left join, agent error/attempt/journal setters, credential pause
  agents/errors.ts           (modify) StartFix "runtime", new errors
  agents/agent-runtime.ts    (modify) primitives, afterExit, busy, pin, warm timer, hibernate, crash, attempts, rate limit, restart/reset
  agents/runtimes.ts         (modify) Supervisor wiring, version check minimal env
  agents/start.ts            (modify) gate, Docker path, canonical paths
  agents/agent-service.ts    (modify) staged re-sync result
  agents/reset-session.ts    (delete)
  supervisor/supervisor.ts   (new) Supervisor
  supervisor/reconcile.ts    (new) boot reconciliation
  runtime/local/journal.ts   (new) ProcessJournal, reap()
  runtime/docker/client.ts   (new) DockerClient interface + dockerode adapter
  runtime/docker/containers.ts (new) ContainerManager
  runtime/docker/exec-transport.ts (new) DockerExecTransport
  routes/agents.ts           (modify) restart, reset-session, running, staged re-sync
  templates/validate.ts      (modify) local-runtime warning
  app.ts                     (modify) wiring, reconciliation before listen, closing latch
  test/helpers.ts            (modify) supervisor-aware helpers
apps/server/scripts/
  reset-session.ts (delete), smoke-docker.ts (new)

apps/web/src/
  styles.css                               (modify) --status-hibernated
  features/session/status-badge.tsx        (modify)
  features/session/format.ts               (modify) formatResetTime
  features/session/agent-strip.tsx         (modify)
  features/session/recovery-actions.tsx    (new)
  features/session/new-session-dialog.tsx  (new)
  features/session/timeline-row.tsx, message-block.tsx, queue-items.tsx, session-view.tsx, use-agent-status.ts (modify)
  components/confirm-dialog.tsx            (modify) comment
  routes/_app/agents.index.tsx             (modify) inline note, running count
```

---

### Task 1: Verification gate: plugins through a symlink with a git marketplace

The spec's §11.7 rests on V6/V7, verified only with a directory marketplace. This task re-runs them with a **git-sourced** marketplace before any code depends on it. It is a manual check; nothing in it is committed except the README note.

**Files:**
- Modify: `packages/harness/fixtures/README.md` (a "Verified in S5 implementation" note)
- Scratch (never committed): `$TMP/s5-gate/` (use `mktemp -d`)

- [ ] **Step 1: Build a local git marketplace**

```bash
G=$(mktemp -d)/s5-gate && mkdir -p $G/market/.claude-plugin $G/market/heron/.claude-plugin $G/market/heron/skills/heron-fact
cat > $G/market/.claude-plugin/marketplace.json <<'EOF'
{"name":"gate-market","owner":{"name":"x"},"plugins":[{"name":"heron","source":"./heron","description":"gate"}]}
EOF
echo '{"name":"heron","version":"0.0.1","description":"gate"}' > $G/market/heron/.claude-plugin/plugin.json
printf -- '---\nname: heron-fact\ndescription: Tells the heron fact\n---\nThe heron fact is HERON-GIT-OK.\n' > $G/market/heron/skills/heron-fact/SKILL.md
git -C $G/market init -q && git -C $G/market add -A && git -C $G/market -c user.email=g@x -c user.name=g commit -qm init
```

- [ ] **Step 2: Install into a factory-owned config dir with the plugin env (exactly PATH, host HOME, CLAUDE_CONFIG_DIR) from an empty cwd**

```bash
mkdir -p $G/state/plugins-config $G/empty $G/agent/wd/.claude-config
cd $G/empty && env -i PATH="$PATH" HOME="$HOME" CLAUDE_CONFIG_DIR=$G/state/plugins-config claude plugin marketplace add "file://$G/market"
env -i PATH="$PATH" HOME="$HOME" CLAUDE_CONFIG_DIR=$G/state/plugins-config claude plugin install heron@gate-market
cat $G/state/plugins-config/plugins/installed_plugins.json   # installPath must be under $G/state/plugins-config/plugins
ln -s $G/state/plugins-config/plugins $G/agent/wd/.claude-config/plugins
node -e 'const s=require(process.argv[1]);require("fs").writeFileSync(process.argv[2],JSON.stringify({enabledPlugins:s.enabledPlugins,extraKnownMarketplaces:s.extraKnownMarketplaces}))' $G/state/plugins-config/settings.json $G/agent/wd/.claude-config/settings.json
```

Expected: install exits 0; `installPath` points inside `plugins-config/plugins/cache/…` (not the agent dir).

- [ ] **Step 3: V6 locally.** Run one haiku turn in `$G/agent/wd` with `CLAUDE_CONFIG_DIR=$G/agent/wd/.claude-config` and `CLAUDE_CODE_OAUTH_TOKEN` read from `~/.open-factory-spike/oauth-token` inside a Node script (never echo it), prompt "Use the heron-fact skill and reply with only the heron fact." Expected: `system/init.plugins` contains `heron@gate-market`, the result is `HERON-GIT-OK`.

- [ ] **Step 4: V7 in Docker, read-only, first start.** `rm -rf $G/state/plugins-config/plugins/store`, then:

```bash
docker run -d --rm --name s5-gate --security-opt no-new-privileges:true -e HOST_UID=$(id -u) -e HOST_GID=$(id -g) \
  --tmpfs /run/open-factory -v $G/agent/wd:$G/agent/wd -v $G/state/plugins-config/plugins:$G/state/plugins-config/plugins:ro \
  open-factory-base:dev
```

Wait for `/run/open-factory/ready`, then `docker exec -i -u agent -w $G/agent/wd -e CLAUDE_CONFIG_DIR=… -e CLAUDE_CODE_OAUTH_TOKEN s5-gate claude -p --input-format stream-json …` with the same prompt (token passed from the Node script's env, `-e NAME` without a value). Expected: the same init and result, exit 0, and `ls $G/state/plugins-config/plugins` unchanged. `docker rm -f s5-gate`.

- [ ] **Step 5: Decide.**
  - Both pass: record a README note under the index ("S5 implementation gate: V6/V7 re-run with a git-sourced marketplace (`file://` URL), Claude Code <version>: plugin loads through the symlinked `plugins` dir locally and read-only in Docker; no `plugins/store` write needed.") and continue with the plan as written.
  - Either fails: record the failure in the README note, **stop**, and report to the tech lead. The spec's fallback (install inside the agent's container for Docker agents; local keeps the host install) then replaces Task 9's design, and the plan is amended before continuing.

- [ ] **Step 6: Commit**

```bash
git add packages/harness/fixtures/README.md
git commit -m "chore(harness): record the S5 plugin symlink gate with a git marketplace

<the Co-Authored-By line from your session's system reminder>"
```

---

### Task 2: Shared statuses, events, frames and the reserved `@factory`

**Files:**
- Create: `packages/shared/src/status.ts`, `packages/shared/src/status.test.ts`
- Modify: `packages/shared/src/agents.ts`, `events.ts`, `ws.ts`, `handle.ts`, `index.ts`
- Test: `packages/shared/src/events.test.ts` (extend)

**Interfaces:**
- Produces:
  - `AgentStatus = "hibernated" | "queued" | "working" | "idle" | "rate_limited" | "errored"`;
  - `statusOf(i: StatusInputs): AgentStatus`, `StatusInputs = {errored, attempting, working, credentialPaused, hasPendingWork, queuedWake, processRunning}` (all boolean);
  - `ErrorKind = "start" | "resume" | "resume_unrecoverable" | "crash" | "stop_failed" | "internal"`;
  - `WaitingOn = {tasks: {taskId, description, startedAt}[], crons: number}`;
  - `AgentLive` fields added to `agentSummarySchema` and `agentStatusFrameSchema`: `rateLimitedUntil?`, `rateLimitExact?`, `waitingOn`, `runtimeDisabled?`, `errorKind?`, `image?`, `pulling?`;
  - `QueueItem.kind: "message" | "compact" | "notice"`;
  - `agentListSchema` gains `running: {count, max}`; frame `{type: "supervisor", running: number, max: number}`;
  - factory events per spec §15: `hibernated{reason, idleMinutes?}`, `container{action, image, imageId, claudeCodeVersion?}`, `cleanup{killedProcesses?, container?}`, `stop_escalated{how}`, `background_work_lost{reason, tasks, crons}`, `reconciled{killedProcesses, stoppedContainer}`, `rate_limit_paused{credential, until, exact}`, `rate_limit_reset{credential}`; `control.cmd` gains `restart`; `process_started` gains `reason?`; `message_in.messages[].kind` is `"message" | "system"`; `error.fix` gains `runtime`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/status.test.ts
import { expect, test } from "vitest";
import { type StatusInputs, statusOf } from "./status.ts";

const base: StatusInputs = {
  errored: false, attempting: false, working: false, credentialPaused: false,
  hasPendingWork: false, queuedWake: false, processRunning: false,
};
test.each<[string, Partial<StatusInputs>, string]>([
  ["nothing", {}, "hibernated"],
  ["warm", { processRunning: true }, "idle"],
  ["working", { processRunning: true, working: true }, "working"],
  ["queued", { queuedWake: true }, "queued"],
  ["paused + running", { credentialPaused: true, processRunning: true }, "rate_limited"],
  ["paused + queued", { credentialPaused: true, queuedWake: true }, "rate_limited"],
  ["paused + pending, hibernated", { credentialPaused: true, hasPendingWork: true }, "rate_limited"],
  ["paused, nothing pending, hibernated", { credentialPaused: true }, "hibernated"],
  ["errored", { errored: true }, "errored"],
  ["errored + paused", { errored: true, credentialPaused: true, queuedWake: true }, "errored"],
  ["attempt queued", { errored: true, attempting: true, queuedWake: true }, "queued"],
  ["attempt paused", { errored: true, attempting: true, credentialPaused: true, queuedWake: true }, "rate_limited"],
  ["attempt running between turns", { errored: true, attempting: true, processRunning: true }, "working"],
  ["attempt working", { errored: true, attempting: true, working: true, processRunning: true }, "working"],
])("%s", (_n, over, want) => {
  expect(statusOf({ ...base, ...over })).toBe(want);
});
```

```ts
// packages/shared/src/events.test.ts (add)
test("message_in accepts system notices and the new factory events parse", () => {
  expect(() => anyEventSchema.parse({ type: "message_in", messages: [{ id: "n1", from: "@factory", kind: "system", urgent: false, body: "x" }] })).not.toThrow();
  for (const e of [
    { type: "hibernated", reason: "warm_window", idleMinutes: 70 },
    { type: "container", action: "created", image: "open-factory-base:dev", imageId: "sha256:x" },
    { type: "cleanup", killedProcesses: 2 },
    { type: "stop_escalated", how: "sigkill" },
    { type: "background_work_lost", reason: "crash", tasks: [{ taskId: "t", description: "pnpm test" }], crons: [] },
    { type: "reconciled", killedProcesses: 0, stoppedContainer: true },
    { type: "rate_limit_paused", credential: "work", until: "2026-11-19T14:30:00Z", exact: false },
    { type: "rate_limit_reset", credential: "work" },
    { type: "control", cmd: "restart", by: "@or" },
    { type: "process_started", resumed: true, reason: "crash_recovery" },
    { type: "error", source: "spawn", message: "x", fix: "runtime" },
  ]) expect(() => anyEventSchema.parse(e)).not.toThrow();
});
test("factory is a reserved handle", () => {
  expect(handleSchema.safeParse("factory").success).toBe(false);
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/shared` → FAIL (`status.ts` missing, schema rejects).

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/status.ts
import type { AgentStatus } from "./agents.ts";
export interface StatusInputs {
  errored: boolean; attempting: boolean; working: boolean; credentialPaused: boolean;
  hasPendingWork: boolean; queuedWake: boolean; processRunning: boolean;
}
/** The one owner of status precedence (spec §8.1). */
export function statusOf(i: StatusInputs): AgentStatus {
  if (i.errored && !i.attempting) return "errored";
  if (i.working) return "working";
  if (i.credentialPaused && (i.processRunning || i.hasPendingWork || i.queuedWake)) return "rate_limited";
  if (i.queuedWake) return "queued";
  if (i.attempting) return "working";
  if (i.processRunning) return "idle";
  return "hibernated";
}
```

In `agents.ts`: widen `agentStatusSchema`, add `errorKindSchema`, `waitingOnSchema = z.object({tasks: z.array(z.object({taskId: z.string(), description: z.string(), startedAt: z.string()})), crons: z.number().int().nonnegative()})`, the optional fields above on `agentSummarySchema` (`waitingOn` required, default empty), `queueItemSchema.kind` enum + `"notice"`, `agentListSchema.running`. In `events.ts`: the factory events in `factoryEventSchema`, `process_started.reason` enum (`message | compact | crash_recovery | restart | reset | boot | boot_resume | rate_limit_reset | queued_items | apply_changes`), `control.cmd` + `restart`, `message_in` kind `z.enum(["message","system"])`, `error.fix` + `runtime`. In `ws.ts`: the frame fields and `z.object({type: z.literal("supervisor"), running: z.number().int(), max: z.number().int()})`. `handle.ts`: `["humans", "me", "scheduler", "factory"]`. Export `status.ts` from `index.ts`.

- [ ] **Step 4: Run** `pnpm vitest run packages/shared && pnpm typecheck` → PASS (fix any web/server type errors from the widened `AgentStatus` with exhaustive switches; the web gets real UI in Tasks 27–28, here only make it compile by mapping new statuses to the existing badge).

- [ ] **Step 5: Commit** `feat(shared): S5 statuses, factory events and frames`.

---

### Task 3: Database columns and the additive migration

**Files:**
- Modify: `packages/db/src/schema/agents.ts`, `packages/db/src/schema/factory.ts`
- Create: `packages/db/migrations/0003_*.sql` (generated, then hand-edited)
- Test: `packages/db/src/migrations.test.ts` (extend, or `apps/server/src/agents/event-store.test.ts` if that's where S4's migration test lives)

**Interfaces:**
- Produces columns: `credentials.rateLimitedUntil: Date | null`, `credentials.rateLimitExact: boolean`; `agents.lastError`, `agents.errorKind`, `agents.attempting: boolean`, `agents.runtimeJournal: RuntimeJournal | null`, `agents.rateLimitNoticeOwed: boolean`; `messages.fromUserId: string | null`, `messages.notice: string | null`.
- `RuntimeJournal = {claude?: {pid: number; start: string}; descendants?: {pid: number; start: string}[]; tasks: {taskId: string; description: string}[]; crons: {cronId: string; humanSchedule: string}[]; takenAt: string}` (exported from `packages/db/src/schema/agents.ts`).

- [ ] **Step 1: Write the failing test**

```ts
test("0003: system rows need no user and a notice; user rows need a user and no notice", async () => {
  // agent a1 and user u1 exist (helpers)
  await t.sql`insert into messages (id, kind, from_user_id, to_agent_id, body, notice) values ('n1','system',null,'a1','x','crash')`;
  await expect(t.sql`insert into messages (id, kind, from_user_id, to_agent_id, body) values ('n2','system',null,'a1','x')`).rejects.toThrow(/check/i);
  await expect(t.sql`insert into messages (id, kind, from_user_id, to_agent_id, body) values ('n3','message',null,'a1','x')`).rejects.toThrow(/check/i);
  await t.sql`insert into messages (id, kind, from_user_id, to_agent_id, body) values ('m1','message','u1','a1','x')`;
});
```

- [ ] **Step 2: Run** → FAIL (column `notice` missing).

- [ ] **Step 3: Implement.** Add the columns in the Drizzle schema, run `pnpm db:generate`, then append to the generated SQL:

```sql
-- S5: tie sender and kind. S6 rewrites this when agent senders (from_agent) arrive.
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_kind_check" CHECK (
  ("kind" = 'system' AND "from_user_id" IS NULL AND "notice" IS NOT NULL)
  OR ("kind" <> 'system' AND "from_user_id" IS NOT NULL AND "notice" IS NULL)
);
```

- [ ] **Step 4: Run** `pnpm vitest run packages/db apps/server/src/agents/event-store.test.ts` → PASS; existing rows untouched.

- [ ] **Step 5: Commit** `feat(db): S5 columns for errors, attempts, journals, pauses and notices`.

---

### Task 4: Config: new variables, canonical `FACTORY_HOME`, the local gate rule

**Files:**
- Modify: `apps/server/src/config.ts`, `apps/server/src/app.ts` (realpath after mkdir), `.env.example`
- Test: `apps/server/src/config.test.ts`

**Interfaces:**
- Produces on `Config`: `maxRunningAgents: number`, `allowLocalRuntime: boolean`, `defaultImage: string`, `dockerClaudeBin: string`, `cliBundle: string`, `agentUrl: string`; `export function localRuntimeAllowed(c: Pick<Config,"allowLocalRuntime">): boolean`.
- `buildApp` sets `config.factoryHome = await realpath(config.factoryHome)` right after creating it.

- [ ] **Step 1: Failing tests**

```ts
test("S5 defaults", () => {
  const c = loadConfig(baseEnv);
  expect(c.maxRunningAgents).toBe(8);
  expect(c.allowLocalRuntime).toBe(false);
  expect(c.defaultImage).toBe("ghcr.io/orlevii/open-factory/base:latest");
  expect(c.dockerClaudeBin).toBe("claude");
  expect(c.agentUrl).toBe("http://host.docker.internal:3000");
});
test("FACTORY_ALLOW_LOCAL_RUNTIME only accepts true/false", () => {
  expect(loadConfig({ ...baseEnv, FACTORY_ALLOW_LOCAL_RUNTIME: "true" }).allowLocalRuntime).toBe(true);
  expect(() => loadConfig({ ...baseEnv, FACTORY_ALLOW_LOCAL_RUNTIME: "yes" })).toThrow(ConfigError);
  expect(() => loadConfig({ ...baseEnv, FACTORY_MAX_RUNNING_AGENTS: "0" })).toThrow(ConfigError);
});
```

Plus an app test: with `FACTORY_HOME` under a symlinked temp prefix (create `tmp/real` and `tmp/link -> real`), `app.config.factoryHome` equals `realpath(tmp/link)`.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with Zod: `FACTORY_MAX_RUNNING_AGENTS: z.coerce.number().int().min(1).default(8)`, `FACTORY_ALLOW_LOCAL_RUNTIME: z.enum(["true","false"]).default("false")`, `FACTORY_DEFAULT_IMAGE`, `FACTORY_DOCKER_CLAUDE_BIN`, `FACTORY_CLI_BUNDLE` (default `fileURLToPath(new URL("../../../apps/cli/dist/open-factory.js", import.meta.url))` resolved from `config.ts`), `FACTORY_AGENT_URL` (default from `PORT`). `.env.example` documents each, with `FACTORY_ALLOW_LOCAL_RUNTIME=true` and `FACTORY_DEFAULT_IMAGE=open-factory-base:dev` shown as the development settings.
- [ ] **Step 4: Run** → PASS. Add `FACTORY_ALLOW_LOCAL_RUNTIME=true` to `makeTestApp`'s env so existing local-agent tests keep running.
- [ ] **Step 5: Commit** `feat(server): S5 configuration and canonical FACTORY_HOME`.

---

### Task 5: Harness transport split and idempotent stop

**Files:**
- Create: `packages/harness/src/transport/types.ts`, `packages/harness/src/transport/local.ts`, `packages/harness/src/claude/driver.ts`, `packages/harness/src/transport/fake.ts` (test-only export under `testing/`)
- Modify: `packages/harness/src/claude/process.ts`, `packages/harness/src/index.ts`, `packages/harness/src/types.ts`
- Test: `packages/harness/src/claude/process.test.ts` (extend), `packages/harness/src/transport/local.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Transport {
  readonly pid: number | undefined;
  write(line: string): Promise<void>;          // rejects ProcessNotRunningError after end/exit
  endInput(): void;                             // stdin EOF
  readonly stdout: AsyncIterable<string>;       // lines
  readonly stderr: AsyncIterable<string>;       // lines
  readonly exit: Promise<{ code: number | null; signal: string | null }>;
  terminate(): Promise<boolean>;                // SIGTERM-equivalent; false if it couldn't signal
  forceKill(): Promise<void>;                   // SIGKILL-equivalent
}
export type TransportFactory = (spec: AgentRuntimeSpec, args: string[]) => Transport;
export function createClaudeDriver(o: { log?: DriverLog; transports: { local: TransportFactory; docker?: TransportFactory } }): HarnessDriver;
export function localTransport(spec: AgentRuntimeSpec, args: string[]): Transport; // spawn, detached, env = spec.env
```

- `ClaudeProcess` constructor becomes `(spec, opts, transport, log)`; `stop()` returns the same promise on every call; `HarnessProcess` gains `forceKill(): Promise<void>`.
- `AgentRuntimeSpec` gains `docker?: { containerId: string; claudeBin: string }` (set by the server for Docker starts).

- [ ] **Step 1: Failing tests** (a `FakeTransport` with scripted stdout, a controllable exit and recorded `terminate` calls)

```ts
test("stop() is idempotent: one stdin close, one SIGTERM, one promise", async () => {
  const t = new FakeTransport(); const p = new ClaudeProcess(spec, {}, t);
  const a = p.stop({ graceMs: 10, termWaitMs: 10 }); const b = p.stop({ graceMs: 10, termWaitMs: 10 });
  expect(a).toBe(b);
  t.exitWith(143); await a;
  expect(t.endInputCalls).toBe(1); expect(t.terminateCalls).toBe(1);
});
test("terminate() returning false falls through to the timeout", async () => {
  const t = new FakeTransport({ terminateResult: false }); const p = new ClaudeProcess(spec, {}, t);
  await expect(p.stop({ graceMs: 5, termWaitMs: 5 })).resolves.toMatchObject({ timedOut: true });
});
test("localTransport: SIGTERM ends a child; forceKill SIGKILLs one that traps TERM", async () => {
  const t = localTransport({ ...spec, claudeBin: "/bin/sh" }, ["-c", "trap '' TERM; sleep 30"]);
  expect(await t.terminate()).toBe(true);
  await t.forceKill();
  expect((await t.exit).signal).toBe("SIGKILL");
});
```

All existing `ClaudeProcess` tests (against the fake claude) must pass unchanged through `localTransport`.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Move the spawn, readline and kill code from `process.ts` into `local.ts`; `ClaudeProcess` consumes `transport.stdout` lines through the mapper and `transport.exit` for `exited`. `stop()`:

```ts
private stopping: Promise<ExitInfo> | undefined;
stop(opts: { graceMs?: number; termWaitMs?: number } = {}): Promise<ExitInfo> {
  this.stopping ??= this.doStop(opts);
  return this.stopping;
}
private async doStop({ graceMs = 3000, termWaitMs = 10_000 }) {
  if (this.exited) return this.exited;
  this.stopRequested = true;
  this.transport.endInput();
  const winner = await exitWithin(this.exitPromise, graceMs);
  if (winner) return winner;
  await this.transport.terminate();
  const after = await exitWithin(this.exitPromise, termWaitMs);
  if (after) return after;
  this.log.error({ pid: this.transport.pid }, "claude did not exit after SIGTERM");
  return { code: null, signal: null, timedOut: true };
}
forceKill() { return this.transport.forceKill(); }
```

`createClaudeDriver` picks `transports[spec.runtime]` (throws `Error("No docker transport configured")` when missing). Update `apps/server/src/app.ts` to call `createClaudeDriver({ log: app.log, transports: { local: localTransport } })` (Docker added in Task 24). `FakeProcess` (server testing) gains `forceKill = async () => { this.forceKilled = true; this.exit(137); }`.

- [ ] **Step 4: Run** `pnpm vitest run packages/harness apps/server` → PASS.
- [ ] **Step 5: Commit** `refactor(harness): split byte transport from ClaudeProcess; idempotent stop`.

---

### Task 6: Mapper drop, fixtures, `FactoryMessage.kind`, fake claude tweaks

**Files:**
- Move: `packages/harness/fixtures/pending/session-state-changed-background.jsonl` → `packages/harness/fixtures/`
- Create: `packages/harness/fixtures/rate-limit-event-rejected.jsonl` (synthetic)
- Modify: `packages/harness/src/claude/mapper.ts`, `packages/harness/src/types.ts`, `packages/harness/src/envelope.ts` (kind attribute), `packages/harness/testing/fake-claude.mjs`, `packages/harness/fixtures/README.md`
- Test: `packages/harness/src/claude/mapper.test.ts`, `envelope.test.ts`

**Interfaces:**
- Produces: `FactoryMessage.kind: "message" | "system"`; envelopes render `kind="system"`; the fake records `cwd` in `plugin.log` entries and sets `process.title = "claude"`.

- [ ] **Step 1: Failing tests**

```ts
test("session_state_changed yields nothing", () => {
  const st = createMapperState({ resumed: false });
  expect(mapLine({ type: "system", subtype: "session_state_changed", state: "idle" }, st)).toEqual([]);
});
test("the rejected rate-limit fixture maps to rate_limited", () => {
  const evs = mapFixture("rate-limit-event-rejected");
  expect(evs.find((e) => e.type === "rate_limited")).toMatchObject({ status: "rejected", rateLimitType: "five_hour" });
});
test("envelope carries kind=system", () => {
  expect(renderEnvelopes([{ id: "n1", from: "@factory", kind: "system", urgent: false, body: "x" }])).toContain('kind="system"');
});
```

The all-fixtures test now includes `session-state-changed-background` (moved) and must pass.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Add `session_state_changed` to the mapper's system-subtype drop list. Write the synthetic fixture from the `rate-limit-event-allowed` fixture with the `rate_limit_event` line replaced by:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1795000000,"rateLimitType":"five_hour","utilization":1},"uuid":"00000000-0000-4000-8000-000000000001","session_id":"<same as the fixture>"}
```

followed by a `result` with `is_error: true, terminal_reason: "api_error", api_error_status: 429`. README entry: "`rate-limit-event-rejected` (S5, **synthetic, unverified**): built from the Agent SDK's documented shape; replace with a real trace when one is captured (#43)." Fake claude: `process.title = "claude";` at the top; add `cwd: process.cwd()` to the `plugin.log` JSON.

- [ ] **Step 4: Run** `pnpm vitest run packages/harness` → PASS.
- [ ] **Step 5: Commit** `feat(harness): drop session_state_changed, rejected rate-limit fixture, system envelopes`.

---

### Task 7: Factory-owned state paths and the one-time move out of the workdir

**Files:**
- Modify: `apps/server/src/workspace/paths.ts`, every caller of `templateCopyDir`/`resyncRoot` (`workspace.ts`, `files.ts`, `agent-service.ts`)
- Create: `apps/server/src/workspace/state-migration.ts`
- Test: `apps/server/src/workspace/state-migration.test.ts`, existing workspace tests (paths updated)

**Interfaces:**
- Produces:

```ts
export const agentStateDir = (factoryHome: string, slug: string) => path.join(factoryHome, "state", "agents", slug);
export const templateCopyDir = (factoryHome: string, slug: string) => path.join(agentStateDir(factoryHome, slug), "template");
export const resyncRoot = (factoryHome: string, slug: string) => path.join(agentStateDir(factoryHome, slug), "resync");
export const resyncPendingDir = (factoryHome: string, slug: string) => path.join(agentStateDir(factoryHome, slug), "resync-pending");
export const pluginsConfigDir = (factoryHome: string, slug: string) => path.join(agentStateDir(factoryHome, slug), "plugins-config");
export async function migrateWorkdirState(factoryHome: string, slugs: string[], log): Promise<void>;
```

The signatures change from `(workdir)` to `(factoryHome, slug)`; fix every caller.

- [ ] **Step 1: Failing tests**

```ts
test("moves .factory/template and resync/* into state; removes .factory", async () => {
  // <home>/agents/a/.factory/template/{settings.json,mcp.json}, .factory/resync/2026-11-19T10-00-00Z/AGENTS.md
  await migrateWorkdirState(home, ["a"], log);
  expect(await readFile(`${home}/state/agents/a/template/settings.json`, "utf8")).toBe("{}");
  expect(existsSync(`${home}/state/agents/a/resync/2026-11-19T10-00-00Z/AGENTS.md`)).toBe(true);
  expect(existsSync(`${home}/agents/a/.factory`)).toBe(false);
});
test("a symlinked .factory is removed as a link, never followed", async () => {
  await symlink(outside, `${home}/agents/a/.factory`);
  await migrateWorkdirState(home, ["a"], log);
  expect(existsSync(`${outside}/template/settings.json`)).toBe(true); // untouched
  expect(existsSync(`${home}/agents/a/.factory`)).toBe(false);
});
test("idempotent: a second run is a no-op", async () => { /* run twice, no throw, same files */ });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with `lstat`: if `<workdir>/.factory` is a symlink → `unlink`; if a directory → `rename` its `template/*` files and `resync/*` dirs into the state dir (create with `mkdir -p`; skip a target that exists, log it), then `rm -r` the `.factory` dir. `buildApp` calls it after migrations, before reconciliation (Task 26), for every agent slug.
- [ ] **Step 4: Run** `pnpm vitest run apps/server/src/workspace` → PASS.
- [ ] **Step 5: Commit** `feat(server): factory-owned agent state outside the workdir`.

---

### Task 8: `SafeFs`: symlink-safe writes, copies and deletes under a workdir

**Files:**
- Create: `apps/server/src/workspace/safe-fs.ts`, `safe-fs.test.ts`
- Modify: `workspace/files.ts` (`writeAtomic`, `copyTargets`, `backupDiffering`), `workspace/links.ts` (`linkHostSkills`, `linkProjects`), `workspace/workspace.ts` (`prepare`, `materialize`, `discard`)
- Test: `apps/server/src/workspace/hardening.test.ts` (new, the planted escapes)

**Interfaces:**
- Produces:

```ts
export class UnsafePathError extends WorkspaceError {} // message "<path> is a symlink; the factory won't write through it."
export class SafeFs {
  constructor(readonly root: string) {}                       // the workdir (canonical)
  /** lstat every component between root and target's parent; each must be a real directory. */
  assertParents(rel: string): Promise<void>;
  writeFile(rel: string, data: string | Buffer, mode?: number): Promise<void>; // temp (wx) + rename
  mkdirp(rel: string): Promise<void>;
  /** Create/replace a factory-made symlink; an existing non-symlink entry fails. */
  link(rel: string, target: string): Promise<void>;
  removeLink(rel: string): Promise<void>;                      // only removes a symlink
  /** Copy for backups: a symlink source is copied as a symlink (never its target's bytes). */
  copyOut(rel: string, dest: string): Promise<void>;
  readIfRegular(rel: string): Promise<Buffer | undefined>;    // undefined for missing or symlink
}
```

- [ ] **Step 1: Failing tests (unit + escapes)**

```ts
test("writeFile refuses a symlinked parent", async () => {
  await symlink(hostDir, `${wd}/.claude-config`);
  await expect(new SafeFs(wd).writeFile(".claude-config/settings.json", "{}")).rejects.toThrow(/is a symlink/);
  expect(existsSync(`${hostDir}/settings.json`)).toBe(false);
});
test("prepare fails closed when .claude-config is a symlink to a host dir", async () => {
  await symlink(hostDir, `${workdir}/.claude-config`);
  await expect(prepareAgent()).rejects.toThrow(AgentStartError);
  expect(readdirSync(hostDir)).toEqual([]);
});
test("re-sync backup of AGENTS.md -> secret file holds a symlink, not the secret", async () => {
  await rm(`${workdir}/AGENTS.md`); await symlink(secretFile, `${workdir}/AGENTS.md`);
  await resync();
  const backup = await findBackup("AGENTS.md");
  expect((await lstat(backup)).isSymbolicLink()).toBe(true); // a link, so no secret bytes were copied
  expect(await readlink(backup)).toBe(secretFile);
});
test("projects/ as a symlink to a directory fails the start", async () => {
  await rm(`${workdir}/projects`, { recursive: true, force: true }); await symlink(hostDir, `${workdir}/projects`);
  await expect(prepareAgent()).rejects.toThrow(/is a symlink/);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `assertParents` walks `path.relative(root, dirname(target))` component by component with `lstat`, throwing `UnsafePathError` on `isSymbolicLink()` and creating missing directories only through `mkdirp` (which applies the same check). `writeFile`: `open(tmp, "wx")` in the checked parent, write, `rename`. Replace every `fs` write in `files.ts`, `links.ts` and `workspace.ts` that targets the workdir with `SafeFs` calls; `backupDiffering` reads sources with `lstat` + `readIfRegular` and copies symlinks with `copyOut`. `WorkspaceError` from S4 maps to `AgentStartError` in `start.ts` already.
- [ ] **Step 4: Run** `pnpm vitest run apps/server/src/workspace apps/server/src/agents` → PASS.
- [ ] **Step 5: Commit** `fix(server): symlink-safe host writes under agent workdirs`.

---

### Task 9: Plugins in a factory-owned config dir (blocker R1)

**Files:**
- Modify: `apps/server/src/workspace/plugins.ts`, `workspace/settings.ts`, `workspace/workspace.ts`, `agents/runtimes.ts` (version check env)
- Test: `apps/server/src/workspace/plugins.test.ts`, `hardening.test.ts`

**Interfaces:**
- Consumes: `pluginsConfigDir` (Task 7), `SafeFs.link` (Task 8).
- Produces:
  - `installPlugins({claudeBin, pluginsConfig, plugins, tplSettings, hostHome, path})`: env exactly `{PATH, HOME: hostHome, CLAUDE_CONFIG_DIR: pluginsConfig}`, cwd a fresh `mkdtemp` removed afterwards;
  - `buildSettings({... pluginKeys})`: `enabledPlugins`/`extraKnownMarketplaces` taken from `<plugins-config>/settings.json` (passed as `pluginKeys`), never from the agent's config-dir `settings.json` (`prev` is no longer read for them);
  - `prepare` ensures `<workdir>/.claude-config/plugins` is a factory-made link to `<plugins-config>/plugins`; when `plugins-config/` doesn't exist and the snapshot lists plugins, it **fails closed** (no install at start, S4 Q7): `WorkspaceError("Re-sync @<slug> to reinstall its plugins into the factory-managed location.", "resync")` (`"resync"` joins the `StartFix` union and the shared `error.fix` enum; the UI links it to the agent's Re-sync). An agent whose snapshot lists no plugins migrates silently (the link is created over an empty or missing dir).
  - `resync` (the human act) installs into `plugins-config/`, then moves a real `.claude-config/plugins/` dir aside to `state/agents/<slug>/plugins-legacy-<ts>/` and creates the link.
  - `checkClaudeVersion(bin, {PATH, HOME})` only (local agents only; Docker skipped).

- [ ] **Step 1: Failing tests**

```ts
test("the install never sees the agent's config dir, cwd or settings (GIT_TRACE / GIT_CONFIG_* repro)", async () => {
  await writeFile(`${workdir}/.claude-config/settings.json`, JSON.stringify({
    env: { GIT_TRACE: `${marker}-trace`, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: `!touch ${marker}` },
  }));
  await resyncAgent(); // fake claude records argv, env keys and cwd in plugin.log
  const runs = pluginLog();
  expect(runs.length).toBeGreaterThan(0);
  for (const r of runs) {
    // r.env is the sorted key list the fake saw (its wrapper adds FAKE_CLAUDE_*): the planted keys must be absent
    expect(r.env).toEqual(expect.arrayContaining(["CLAUDE_CONFIG_DIR", "HOME", "PATH"]));
    for (const k of ["GIT_TRACE", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "DATABASE_URL", "FACTORY_SECRET_KEY"]) expect(r.env).not.toContain(k);
    expect(r.cwd.startsWith(workdir)).toBe(false);
    expect(r.configDir).toBe(pluginsConfigDir(home, slug));
  }
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(`${marker}-trace`)).toBe(false);
});
test("prepare links .claude-config/plugins to plugins-config/plugins", async () => {
  await prepareAgent();
  expect(await readlink(`${workdir}/.claude-config/plugins`)).toBe(`${pluginsConfigDir(home, slug)}/plugins`);
});
test("enabledPlugins come from plugins-config, not the agent's settings", async () => {
  await writeFile(`${workdir}/.claude-config/settings.json`, JSON.stringify({ enabledPlugins: { "evil@m": true } }));
  const s = JSON.parse(await prepareAndReadSettings());
  expect(s.enabledPlugins).not.toHaveProperty("evil@m");
});
test("an S4 agent with plugins and no plugins-config fails to start with the re-sync fix, and nothing is installed", async () => { /* ... */ });
test("re-sync installs into plugins-config, moves the old real plugins dir to plugins-legacy-<ts>/ and links it", async () => { /* ... */ });
test("an S4 agent without plugins migrates silently at prepare", async () => { /* ... */ });
```

(The fake records `CLAUDE_CONFIG_DIR` value as `configDir` in `plugin.log`: extend Task 6's fake change to include it.)

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the interfaces. `materialize` and `resync` call `installPlugins` with the factory-owned dir. Keep S4's redaction, 120 s per command and 240 s budget.
- [ ] **Step 4: Run** `pnpm vitest run apps/server/src/workspace apps/server/src/agents/agent-service.test.ts` → PASS.
- [ ] **Step 5: Commit** `fix(server): install plugins into a factory-owned config dir`.

---

### Task 10: Mounts from factory inputs only, and `checkMounts`

**Files:**
- Modify: `apps/server/src/workspace/mounts.ts`, `workspace/workspace.ts`
- Test: `apps/server/src/workspace/mounts.test.ts`, `hardening.test.ts`

**Interfaces:**
- Produces:

```ts
export function buildMounts(i: {
  workdir: string; grantedPaths: string[]; hostSkillPaths: string[];
  declaredMarketplaceDirs: string[];     // from the factory-owned template copy only
  pluginsDir: string; cliBundle: string;
}): Mount[];
export class MountRefusedError extends WorkspaceError {}   // "Mount <path> isn't allowed: <reason>."
export async function checkMounts(mounts: Mount[], ctx: {
  workdir: string; grantedPaths: string[]; hostSkillPaths: string[]; declaredMarketplaceDirs: string[];
  pluginsDir: string; cliBundle: string; factoryHome: string; home: string; dockerSockets: string[];
}): Promise<void>;
```

- [ ] **Step 1: Failing tests**

```ts
test.each([
  ["/", "root"], [os.homedir(), "home"], [home, "FACTORY_HOME"], [`${home}/state`, "state"],
  [path.dirname(home), "ancestor of FACTORY_HOME"], ["/var/run/docker.sock", "docker socket"],
  [`${home}/agents/other`, "another agent's workdir"], [`${home}/state/agents/other/plugins-config/plugins`, "another agent's plugins"],
])("refuses %s (%s)", async (src) => {
  await expect(checkMounts([{ source: src, target: src, readOnly: true }], ctx)).rejects.toThrow(MountRefusedError);
});
test("allows exactly the declared kinds with the right read-only flags", async () => {
  await expect(checkMounts(buildMounts(inputs), ctx)).resolves.toBeUndefined();
  expect(buildMounts(inputs).find((m) => m.target === "/opt/factory/bin/open-factory")).toMatchObject({ readOnly: true });
  expect(buildMounts(inputs).find((m) => m.source === inputs.workdir)).toMatchObject({ readOnly: false });
});
test("a marketplace path planted in the agent's config-dir settings never becomes a mount", async () => {
  await writeFile(`${workdir}/.claude-config/settings.json`, JSON.stringify({ extraKnownMarketplaces: { x: { source: { source: "directory", path: os.homedir() } } } }));
  const { mounts } = await prepareAgent();
  expect(mounts.map((m) => m.source)).not.toContain(os.homedir());
});
test("a granted project inside FACTORY_HOME fails the Docker start", async () => { /* project at <home>/agents/other */ });
test("checkMounts resolves symlinks before checking", async () => { /* link -> home dir is refused */ });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `realpath` each source; refuse `/`; refuse equality or ancestry with `home`, `factoryHome`, `factoryHome/state`, any socket path; refuse anything under `factoryHome` except the agent's workdir and its `plugins` dir; then require membership in the allowed sets with the expected `readOnly`. Workspace `prepare` returns `buildMounts` from the factory-owned template copy and calls `checkMounts` only for Docker agents (local ignores mounts). Docker sockets: `/var/run/docker.sock`, `~/.docker/run/docker.sock`, and the unix path of `DOCKER_HOST` when set.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(server): build mounts only from factory-owned inputs and check them`.

---

### Task 11: Staged re-sync for running agents

**Files:**
- Modify: `apps/server/src/workspace/workspace.ts`, `agents/agent-service.ts`, `routes/agents.ts`, `packages/shared/src/agents.ts` (`resyncResponseSchema.applied`)
- Test: `apps/server/src/agents/agent-service.test.ts`

**Interfaces:**
- Consumes: `resyncPendingDir`, `SafeFs`.
- Produces: `Workspace.resync(slug, tpl, {canWriteNow: boolean})` returns `{backupDir?, applied: "now" | "on_restart"}`; `Workspace.prepare` applies `resync-pending/` (backup + `SafeFs` writes) and removes it; `AgentService.resync` decides `canWriteNow` under the workspace lock from the runtime (`!rt?.hasProcess()` for local, `!(await containers.isRunning(agentId))` for Docker; Task 23 adds the Docker check, until then local only).

- [ ] **Step 1: Failing tests**

```ts
test("re-sync of a running agent stages files and applies them at the next prepare", async () => {
  await startAgent(); // fake driver, process running
  const r = await resync();
  expect(r.applied).toBe("on_restart");
  expect(await readFile(`${workdir}/AGENTS.md`, "utf8")).toBe(OLD);
  expect(existsSync(`${resyncPendingDir(home, slug)}/AGENTS.md`)).toBe(true);
  await restartAndPrepare();
  expect(await readFile(`${workdir}/AGENTS.md`, "utf8")).toBe(NEW);
  expect(existsSync(resyncPendingDir(home, slug))).toBe(false);
});
test("re-sync of a hibernated agent applies at once", async () => { expect((await resync()).applied).toBe("now"); });
test("a second staged re-sync replaces the pending dir", async () => { /* latest wins */ });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** The template copy in `state/` is always written at once; only workdir targets are staged. The route response gains `applied`; the web outcome line (Task 28) reads "Re-synced. The changes apply when @<slug> restarts (when idle)." for `on_restart`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): stage re-sync file changes for running agents`.

---

### Task 12: Env builder runtime parameter

**Files:**
- Modify: `apps/server/src/agents/runtime-spec.ts`, `agents/start.ts`
- Test: `apps/server/src/agents/runtime-spec.test.ts`

**Interfaces:**
- Produces: `buildAgentEnv(serverEnv, extra & {agentUrl?: string}, runtime: "local" | "docker")`.

- [ ] **Step 1: Failing tests**

```ts
test.each(["local", "docker"] as const)("%s: server-only vars never leak", (rt) => {
  const env = buildAgentEnv({ ...serverEnv, DATABASE_URL: "x", FACTORY_SECRET_KEY: "y", ANTHROPIC_API_KEY: "z", CLAUDE_FOO: "w", RANDOM_VAR: "v" }, extra, rt);
  for (const k of ["DATABASE_URL", "FACTORY_SECRET_KEY", "CLAUDE_FOO", "RANDOM_VAR", "SSH_AUTH_SOCK"]) expect(env).not.toHaveProperty(k);
});
test("docker: no host PATH/HOME/USER/SHELL; OPEN_FACTORY_URL set", () => {
  const env = buildAgentEnv(serverEnv, { ...extra, agentUrl: "http://host.docker.internal:3000" }, "docker");
  for (const k of ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM"]) expect(env).not.toHaveProperty(k);
  expect(env.OPEN_FACTORY_URL).toBe("http://host.docker.internal:3000");
  expect(env.CLAUDE_CONFIG_DIR).toBe(extra.configDir);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (skip the allowlist copy for `docker`; add `OPEN_FACTORY_URL` for `docker`). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): runtime-aware agent env`.

---

### Task 13: `@factory` system notices: store, texts, ordering

**Files:**
- Create: `apps/server/src/agents/notices.ts`, `notices.test.ts`
- Modify: `apps/server/src/agents/event-store.ts`, `agents/agent-runtime.ts` (`toFactory`, `MessageEntry` for notices, queue items), `workspace/claude-md.ts`
- Test: `apps/server/src/agents/event-store.test.ts`, `agent-runtime.delivery.test.ts`

**Interfaces:**
- Produces:

```ts
export type NoticeType = "crash" | "factory_restarted" | "restart" | "restart_crons" | "rate_limit_reset";
export const notices: {
  crash(i: { exit: { code: number | null; signal: string | null }; duringTurn: boolean; tasks: string[]; crons: string[] }): string;
  factoryRestarted(i: { tasks: string[] }): string;
  restart(i: { by: string; tasks: string[]; crons: string[] }): string;
  restartCrons(i: { crons: string[] }): string;
  rateLimitReset(i: { credential: string; at?: Date }): string; // at only when exact
};
// EventStore
createNotice(m: { toAgentId: string; notice: NoticeType; body: string }): Promise<MessageRow>; // replaces body of a pending one of the same type
deletePendingNotices(agentId: string): Promise<void>;
pendingQueue(agentId): Promise<(MessageRow & { fromHandle: string | null })[]>; // system first, then createdAt; LEFT JOIN users
```

- `AgentRuntime.addNotice(type, body)` (internal, inside a job): calls `createNotice`; if the returned row is new, inserts it into `queue` **before** the first non-notice entry; otherwise updates the existing entry's body. Queue items for notices: `{kind: "notice", from: "@factory", body}`. `toFactory` uses `row.kind` and `from: row.kind === "system" ? "@factory" : "@" + handle`.

- [ ] **Step 1: Failing tests**

```ts
test("notice texts are literal and omit empty lists", () => {
  expect(notices.crash({ exit: { code: 137, signal: null }, duringTurn: true, tasks: ["pnpm test"], crons: [] }))
    .toBe("Your previous process stopped unexpectedly (exit code 137) during a turn. These background tasks were stopped: `pnpm test`. Check the state of that work and continue where you left off.");
  expect(notices.crash({ exit: { code: null, signal: "SIGKILL" }, duringTurn: false, tasks: [], crons: ["every 5 minutes"] }))
    .toBe("Your previous process stopped unexpectedly (signal SIGKILL). These crons were stopped: every 5 minutes. Check the state of that work and continue where you left off.");
  expect(notices.rateLimitReset({ credential: "work" })).toBe("The rate limit on credential `work` reset. Continue where you left off.");
});
test("pendingQueue returns system notices first, including sender-less rows", async () => {
  await store.createMessage({ fromUserId: "u1", toAgentId: a, body: "older", urgent: false });
  await store.createNotice({ toAgentId: a, notice: "crash", body: "n" });
  expect((await store.pendingQueue(a)).map((m) => m.body)).toEqual(["n", "older"]);
});
test("the first batch after a notice begins with it, envelope from=@factory kind=system", async () => {
  // runtime harness: queue has an old pending message; addNotice; start; first send = [notice, old]
});
test("a second notice of the same type replaces a pending one; an in-flight one is untouched", async () => {});
test("history pages with a notice still parse (message_in kind=system)", async () => {});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Texts per spec §9.5 (crons wording "These crons were stopped: …"). `buildClaudeMd` gains, in "How messages reach you": "Messages from `@factory` are notices from the factory itself (restarts, recoveries, rate limits)." (update the snapshot).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): @factory system notices`.

---

### Task 14: Runtime job primitives, `afterExit` intents and the slot port

This task restructures `AgentRuntime` without changing behaviour visible to existing tests, and introduces the seam the Supervisor plugs into. Read spec §5.2 and §5.5 first.

**Files:**
- Modify: `apps/server/src/agents/agent-runtime.ts`, `agents/runtimes.ts`, `agents/testing/runtime-harness.ts`
- Create: `apps/server/src/supervisor/slots.ts` (the port and an unlimited test implementation)
- Test: `apps/server/src/agents/agent-runtime.primitives.test.ts` (new)

**Interfaces:**
- Produces:

```ts
// supervisor/slots.ts
export type WakeReason = "message" | "compact" | "crash_recovery" | "restart" | "reset" | "boot" | "boot_resume" | "rate_limit_reset" | "queued_items" | "apply_changes";
export interface SlotPort {
  /** Synchronous. "granted": the caller may startNow inline in its own job. "queued": a grant job will come later. "dropped": not eligible. */
  requestWake(agentId: string, reason: WakeReason, inline: boolean): "granted" | "queued" | "dropped";
  release(agentId: string): void;
  becameHibernatable(agentId: string): void;
  closing(): boolean;
}
export const unlimitedSlots: SlotPort; // always "granted", for tests that predate the Supervisor

// AgentRuntime (internal, call only inside its own job)
private async startNow(reason: WakeReason): Promise<void>;
private beginHibernate(reason: HibernateReason): boolean;      // false = refused
private beginForceStop(intent: AfterExit): void;
type AfterExit = { kind: "hibernate"; reason: HibernateReason } | { kind: "restart"; by: string } | { kind: "failed_start" } | { kind: "internal" };
type HibernateReason = "warm_window" | "freed_slot" | "apply_changes" | "shutdown" | "archived";
// AgentRuntime (public, each one job)
grant(reason: WakeReason): Promise<void>;          // the Supervisor's grant job
hibernate(reason: HibernateReason): Promise<boolean>;
setNoStart(): void;                                 // closing latch, synchronous
hasProcess(): boolean;
```

- `ensureStarted` is replaced: `sendMessage`/`compact` call `slots.requestWake(id, "message"|"compact", true)`; on `"granted"` they `await this.startNow(reason)` inline (S3's synchronous 503 still works); `startNow` releases the slot in a `finally` when it throws before the launch, re-checks `noStart` and `slots.closing()` right before `driver.start`, and records `process_started{resumed, reason}`.
- S3's `failingProc` stop records `afterExit = {kind:"failed_start"}`; `onJobFailure` records `{kind:"internal"}`; S4's restart stop becomes `beginHibernate("apply_changes")` (Task 16 finishes it).
- `onExited` dispatches on `afterExit`; with no intent and `expected:false` it calls `onCrash` (a stub that keeps S3 behaviour until Task 18). Every exit path calls `slots.release(id)` after recording the exit (Docker container stop is added in Task 25), except `stop_failed` (Task 19).
- `flush()` writes nothing while `stopping || restarting` (S4 had only `restarting`).

- [ ] **Step 1: Failing tests**

```ts
test("a start failure before launch releases the slot", async () => {
  const slots = new RecordingSlots(); await h.makeRuntime({ slots, startError: new AgentStartError("nope") });
  await expect(h.send("hi")).rejects.toThrow(AgentStartError);
  expect(slots.events).toEqual([["request", "message"], ["release"]]);
});
test("every exit releases the slot once", async () => {
  const slots = new RecordingSlots(); await h.makeRuntime({ slots });
  await h.send("hi"); h.driver.last.emit(...ev.fullTurn()); await h.rt.settled();
  h.driver.last.exit(1); await h.rt.settled();
  expect(slots.events.filter((e) => e[0] === "release")).toHaveLength(1);
});
test("noStart blocks a start already inside prepareStart", async () => {
  let open!: () => void; h.prepareGate = new Promise((r) => (open = r));
  const p = h.send("hi"); await tick(); h.rt.setNoStart(); open();
  await expect(p).rejects.toThrow(/being stopped/);
  expect(h.driver.starts).toHaveLength(0);
});
test("a message sent during a hibernate's stop grace is not written to the closing process", async () => {
  await idle(); h.driver.last.holdStop = true;
  void h.rt.hibernate("warm_window"); const p = h.send("during"); await h.rt.settled();
  expect(h.driver.starts[0].sent.flat().map((m) => m.body)).toEqual(["hi"]);
  h.driver.starts[0].releaseStop(); await p; await h.rt.settled();
});
```

`RecordingSlots` lives in `agents/testing/slots.ts`: records `request`/`release`/`hibernatable` calls and answers `"granted"`. `RuntimeHarness.makeRuntime` takes `slots?: SlotPort` (default `unlimitedSlots`). All S3/S4 runtime tests must still pass.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the interfaces. Keep the S3 serial queue; never await a stop inside a job (observe the stop promise and enqueue a job on timeout, as S4's `maybeRestart` does).
- [ ] **Step 4: Run** `pnpm vitest run apps/server/src/agents` → PASS.
- [ ] **Step 5: Commit** `refactor(server): runtime job primitives, afterExit intents and a slot port`.

---

### Task 15: Busy model, cron pin, waiting-on and the warm timer

**Files:**
- Modify: `apps/server/src/agents/agent-runtime.ts`, `agents/event-store.ts` (`setRuntimeJournal(agentId, j | null)`)
- Test: `apps/server/src/agents/agent-runtime.warm.test.ts` (new, fake timers)

**Interfaces:**
- Produces on `AgentRuntime`:
  - `busy(): boolean`, `pinned(): boolean`, `hibernatable(): boolean` (spec §6.1–6.3; `credentialPaused` input comes from Task 17, default false);
  - `waitingOn(): WaitingOn` (non-ambient tasks with `startedAt` = first seen, `crons` count);
  - `lastActivityAt: number`;
  - `updateWarmTimer()` called at the end of every job; it calls `slots.becameHibernatable(id)` on the false→true edge;
  - the live cron set and `runtime_journal.tasks/crons` written on changes (via `setRuntimeJournal`, merged with the local part from Task 20).
- Owed-notification bound: a 30 s timer armed only while no turn is open; fires a job that zeroes the counter if still no turn is open.

- [ ] **Step 1: Failing tests** (`vi.useFakeTimers()`; warm window from the agent snapshot, set to 1 minute in the row)

```ts
test("hibernates after the warm window when fully idle", async () => {
  await idle(); await vi.advanceTimersByTimeAsync(60_000); await h.rt.settled();
  expect(h.driver.last.stopped).toBe(true);
  expect(await types()).toContain("hibernated");
});
test.each([
  ["a live non-ambient task", () => h.driver.last.emit(ev.background([{ taskId: "t" }]))],
  ["a live cron", () => h.driver.last.emit({ type: "cron_created", cronId: "c1", recurring: true, humanSchedule: "every 5 minutes", nextFireAt: new Date(Date.now() + 3e5).toISOString() })],
  ["an owed notification turn (under 30 s)", () => h.driver.last.emit(ev.taskFinished("t"), ev.background([]))],
])("never hibernates with %s", async (_n, busy) => {
  await idle(); busy(); await h.rt.settled();
  await vi.advanceTimersByTimeAsync(60_000 * 5); await h.rt.settled();
  expect(h.driver.last.stopped).toBe(false);
});
test("the owed-notification bound releases after 30 s with no turn open", async () => {
  await idle(); h.driver.last.emit(ev.taskFinished("t"), ev.background([])); await h.rt.settled();
  await vi.advanceTimersByTimeAsync(30_000 + 60_000); await h.rt.settled();
  expect(h.driver.last.stopped).toBe(true);
});
test("the bound never fires during an open turn", async () => { /* taskFinished, turn_started, advance 40 s, counter still owed */ });
test("an ambient task doesn't block; waitingOn excludes it", async () => {});
test("a one-shot cron unpins after its firing turn", async () => {
  // cron_created recurring:false nextFireAt=+10s; advance 11 s; turn_started + turn_end{originKind:"cron"}; then warm window → stops
});
test("waitingOn reports tasks with startedAt and the cron count", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): busy model, cron pin and warm timer`.

---

### Task 16: The hibernate path and apply-restart under S5

**Files:**
- Modify: `apps/server/src/agents/agent-runtime.ts`
- Test: `apps/server/src/agents/agent-runtime.restart.test.ts` (S4's file, extended), `agent-runtime.warm.test.ts`

**Interfaces:**
- Produces: `beginHibernate(reason)` per spec §6.4 (re-check for `warm_window`/`freed_slot`, `apply_changes` checks only busy, snapshot of live tasks/crons); the `exited` handling for `{kind:"hibernate"}`: `background_work_lost` if non-empty, the `factory_restarted` notice for `shutdown` when a turn was open or anything was live, `hibernated{reason, idleMinutes?}`, `slots.release`, then `slots.requestWake(id, "queued_items", false)` when items are queued and the reason is not `shutdown`/`archived`; `requestRestart` = S4's waiting rules minus crons, then `beginHibernate("apply_changes")`; lost crons → `restart_crons` notice and `requestWake(id, "apply_changes", false)`.
- S4's `restarting` flag and `maybeRestart` are folded into this path; `restartPending`/`restartWaitingOn` keep their meaning.

- [ ] **Step 1: Failing tests**

```ts
test("apply-restart doesn't wait for crons; the agent is told which stopped", async () => {
  await idle(); h.driver.last.emit(cronCreated("c1", "every 5 minutes")); await h.rt.settled();
  await h.rt.requestRestart(); await h.rt.settled();
  expect(h.driver.starts[0].stopped).toBe(true);
  expect(await types()).toEqual(expect.arrayContaining(["background_work_lost", "hibernated"]));
  expect(h.driver.starts).toHaveLength(2);                       // woken at once
  expect(h.driver.last.sent[0][0]).toMatchObject({ kind: "system", body: expect.stringContaining("every 5 minutes") });
});
test("a message sent during the stop grace wakes the agent after the exit (no delivery_failed)", async () => {});
test("shutdown mid-turn leaves a factory_restarted notice and no wake", async () => {
  await idle(); h.driver.last.emit(ev.turn()); await h.rt.settled();
  await h.rt.hibernate("shutdown"); await h.rt.settled();
  expect((await h.store.pendingQueue(h.agentId))[0]).toMatchObject({ kind: "system", notice: "factory_restarted" });
  expect(h.driver.starts).toHaveLength(1);
});
test("a freed_slot victim that received a message meanwhile refuses", async () => {});
```

S4's restart tests must still pass (adjust only the expectations the spec changes: crons no longer block).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): one hibernate path; apply-restart no longer waits for crons`.

---

### Task 17: The Supervisor: slots, FIFO, granted state, eviction, closing latch

**Files:**
- Create: `apps/server/src/supervisor/supervisor.ts`, `supervisor.test.ts`
- Modify: `apps/server/src/agents/runtimes.ts` (owns the Supervisor; runtimes get it as their `SlotPort`), `apps/server/src/app.ts`, `routes/agents.ts` (`running` in the list), `ws/route.ts` (`supervisor` frame to every socket)

**Interfaces:**
- Consumes: `SlotPort` (Task 14), `AgentRuntime.grant/hibernate/hibernatable/lastActivityAt/hasDeliverable()` (add `hasDeliverable(): boolean` = queue has a message, notice or compact).
- Produces:

```ts
export class Supervisor implements SlotPort {
  constructor(d: { max: number; runtimes: { get(id: string): AgentRuntime | undefined }; bus: EventBus; log: RuntimeLog;
                   credentialOf(agentId: string): string; paused(credentialId: string): boolean; });
  requestWake(agentId: string, reason: WakeReason, inline: boolean): "granted" | "queued" | "dropped";
  release(agentId: string): void;
  becameHibernatable(agentId: string): void;
  closing(): boolean;
  close(): void;                        // the latch: no grants, queue dropped, timers cleared
  running(): { count: number; max: number };
  isQueued(agentId: string): boolean;
  onCredentialReset(credentialId: string): void;   // Task 18 calls it
}
```

- Rules (spec §5.2–5.3): slot set `holders`; `granted` set (synchronous); FIFO entries `{agentId, reason, requestedAt, pulling?}` deduped by agent; drop rules (running/granted/archived/`stop_failed`/`resume_unrecoverable`/attempting, errored except `crash_recovery|restart|reset|message`-from-human); no grant without `hasDeliverable()`; paused credential → skipped in place; on release: grant the first eligible entry by enqueueing `rt.grant(reason)` (never awaited from another job); eviction when `eligible > pendingEvictions + stoppingHolders` picks the least recently active `hibernatable()` holder not already evicting, calls `void rt.hibernate("freed_slot")`, and re-picks when it resolves `false`.
- Publishes `{type:"supervisor", running, max}` on every holder change.

- [ ] **Step 1: Failing tests** (real runtimes over the fake driver, `max: 2`)

```ts
test("third wake queues while two agents are mid-turn, starts when one exits", async () => {
  const [a, b, c] = await three(); await busy(a); await busy(b);
  await send(c, "hi");
  expect(status(c)).toBe("queued");
  endTurnAndExit(a); await settleAll();
  expect(started(c)).toBe(true);
});
test("with two idle-warm agents, the least recently active hibernates to free a slot", async () => {
  const [a, b, c] = await three(); await idleAt(a, 1000); await idleAt(b, 2000);
  await send(c, "hi"); await settleAll();
  expect(lastEvent(a)).toMatchObject({ type: "hibernated", reason: "freed_slot" });
  expect(stopped(b)).toBe(false); expect(started(c)).toBe(true);
});
test("never evicts a busy, pinned or mid-turn agent", async () => {});
test("never evicts two agents for one queued entry", async () => {});
test("a cap lowered by config at boot with more queued than slots evicts only as many as the queue needs", async () => {});
test("a victim that refuses is replaced by the next candidate", async () => {});
test("dedupe: a second request keeps the original place", async () => {});
test("granted state closes the double-start window", async () => {
  // release a slot to B (grant job enqueued, not yet run), then sendMessage to B: exactly one driver.start for B
});
test("no grant without a deliverable item", async () => {});
test("after close(), sends, warm timers and resets start nothing", async () => {});
test("running counts are published as supervisor frames", async () => {});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Status inputs: `queuedWake = supervisor.isQueued(id)`. `AgentRuntimes` constructs the Supervisor with `config.maxRunningAgents` and passes it to each runtime. `GET /api/agents` adds `running: supervisor.running()`.
- [ ] **Step 4: Run** `pnpm vitest run apps/server` → PASS.
- [ ] **Step 5: Commit** `feat(server): supervisor with a global cap, FIFO queue and early hibernation`.

---

### Task 18: Per-credential rate-limit pauses and the continue notice

**Files:**
- Modify: `apps/server/src/supervisor/supervisor.ts`, `agents/agent-runtime.ts`, `agents/event-store.ts` (`pauseCredential(id, until, exact)`, `clearCredentialPause(id)`, `pausedCredentials()`, `setNoticeOwed(agentId, bool)`, `owedAgents(credentialId)`)
- Test: `apps/server/src/supervisor/rate-limit.test.ts`

**Interfaces:**
- Produces: `Supervisor.paused(credentialId)`, `Supervisor.pause(credentialId, until, exact)` (extends only), one timer per credential firing `onCredentialReset` → clear columns, `rate_limit_reset` events and `rate_limit_reset` notices for owed agents (`setNoticeOwed(false)`), wakes FIFO, flush running ones. `AgentRuntime` on `rate_limited`: compute `until` from `resetsAt` (epoch seconds) or `now + 30 min` with `exact = false` and a warn log; `rate_limit_paused` event; `flush()` holds while paused (urgent interrupts still written); on the `turn_end` of a turn that saw `rate_limited`, `setNoticeOwed(true)` unless already owed.

- [ ] **Step 1: Failing tests** (fake timers)

```ts
test("a rejected event pauses only that credential", async () => {
  const [a, b] = await agentsOnCredentials("work", "personal");
  await busy(a); emitRejected(a, { resetsAt: nowSec + 600 });
  await send(b, "hi"); expect(started(b)).toBe(true);
  const c = await agentOn("work"); await send(c, "hi");
  expect(status(c)).toBe("rate_limited"); expect(started(c)).toBe(false);
});
test("missing resetsAt uses a 30-minute inexact window", async () => {});
test("deliveries to a running paused agent are held, then flushed at reset", async () => {});
test("the cut-off agent gets exactly one notice at reset, batched first with pending messages", async () => {});
test("a paused idle agent is hibernatable and can be evicted", async () => {});
test("a later event extends the window, never shortens it", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): per-credential rate-limit pauses and the continue notice`.

---

### Task 19: Crash policy, attempts, resume classification, escalation

**Files:**
- Create: `apps/server/src/agents/resume-failure.ts`, `resume-failure.test.ts`
- Modify: `apps/server/src/agents/agent-runtime.ts`, `agents/event-store.ts` (`setErrored(id, message, kind)`, `clearErrored(id)`, `setAttempting(id, bool)`)
- Test: `apps/server/src/agents/agent-runtime.crash.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export function classifyResumeFailure(text: string, apiErrorStatus?: number): "unrecoverable" | "ordinary";
// AgentRuntime internals
private async onCrash(e: ExitedEvent, live: { turnOpen: boolean; tasks: Task[]; crons: Cron[]; queued: boolean }): Promise<void>;
private beginAttempt(reason: WakeReason): void;   // set attempting (DB + memory), requestWake
private attemptSucceeded(): void;                  // on the first origin-less turn_end after the attempt's batch
private attemptFailed(kind: ErrorKind, message: string): void;
```

- Crash (spec §9.2): cleanup hook (local journal reap from Task 20, Docker container stop from Task 25; here a `cleanup` port with a no-op default), then: attempting → errored crash, clear, no wake; nothing lost → `exited` + hibernated; else errored crash + `background_work_lost` + `crash` notice + `beginAttempt("crash_recovery")`.
- `sendMessage` from a human to an errored agent (not `resume_unrecoverable`, not attempting) → `beginAttempt("message")`.
- Resume failure (`error{source:"resume"}` before `session_started`): `classifyResumeFailure` → `error_kind` `resume` or `resume_unrecoverable`; attempting cleared; no wake.
- Escalation (spec §9.6): when a stop resolves `timedOut`, a job calls `proc.forceKill()` (local SIGKILL; Docker transport container stop) and appends `stop_escalated`; if no exit follows within 5 s → `stop_failed` (errored, slot kept, `Supervisor` refuses wakes); a late exit releases the slot.
- `lastError`, `errorKind`, `attempting` are persisted and published.

- [ ] **Step 1: Failing tests**

```ts
test.each([
  ["No conversation found with session ID: x", undefined, "unrecoverable"],
  ['400 {"error":{"message":"… diagnostics.previous_message_id …"}}', 400, "unrecoverable"],
  ["API Error: 400 Could not process image", 400, "unrecoverable"],
  ["Connection reset", undefined, "ordinary"],
])("classify %s", (t, s, want) => expect(classifyResumeFailure(t, s)).toBe(want)); // documented, unverified: say so in a comment

test("idle crash with nothing live: hibernated, no turn, no notice", async () => {});
test("mid-turn crash: errored + attempting (queued), one notice-led attempt, success clears", async () => {
  await idle(); h.driver.last.emit(ev.turn()); h.driver.last.exit(137); await h.rt.settled();
  expect(h.rt.live().status).not.toBe("errored");          // attempting → queued/working
  const p = h.driver.last; p.emit(ev.session(), ev.turn(), ev.end({ originKind: "task-notification" })); await h.rt.settled();
  expect(h.rt.live().errorKind).toBe("crash");             // orphan-report turn doesn't count
  p.emit(ev.turn(), ev.end()); await h.rt.settled();
  expect(h.rt.live().status).toBe("idle");
  expect(p.sent[0][0]).toMatchObject({ kind: "system" });
});
test("crash during the attempt: errored, no further attempt", async () => {});
test("a human message makes one attempt; system notices never wake an errored agent", async () => {});
test("ordinary resume failure: errored resume, no automatic attempt", async () => {});
test("unrecoverable: later messages stay pending without an attempt", async () => {});
test("timed-out stop escalates (forceKill, stop_escalated); a failed escalation is stop_failed and keeps the slot", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): crash policy with one notice-led attempt, resume classification, escalation`.

---

### Task 20: Restart and Start a new session (routes); delete the interim script

**Files:**
- Modify: `apps/server/src/agents/agent-runtime.ts` (`restart(by)`, `resetSession(by)` public jobs), `routes/agents.ts`, `apps/server/src/agents/errors.ts`, root `package.json` (remove `agent:reset-session`), `apps/web/src/features/session/timeline-row.tsx` (drop the script copy; full UI in Task 28)
- Delete: `apps/server/src/agents/reset-session.ts`, `reset-session.test.ts`, `apps/server/scripts/reset-session.ts`
- Test: `apps/server/src/routes/agents.recovery.test.ts` (new)

**Interfaces:**
- Produces: `POST /api/agents/:slug/restart` → `202` | `409 not_errored | attempt_in_progress | resume_unrecoverable | runtime_disabled`; `POST /api/agents/:slug/reset-session` → `202` | `409 reset_not_allowed | attempt_in_progress`.

- [ ] **Step 1: Failing tests** (`makeTestApp`, fake driver)

```ts
test("restart: 409 unless errored; errored → restart notice first, control event, one attempt", async () => {});
test("restart while an attempt runs: 409 attempt_in_progress", async () => {});
test("restart of resume_unrecoverable: 409 with the new-session hint", async () => {});
test("restart of stop_failed reuses its slot; a failed second escalation stays stop_failed with no wake", async () => {});
test("reset-session: clears session_id, appends session_reset, deletes pending notices, delivers pending human messages as the first turn without --resume", async () => {
  // driver.last.opts.resumeSessionId undefined; first send has only the human message
});
test("reset-session only for resume / resume_unrecoverable", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm agent:reset-session` no longer exists.
- [ ] **Step 5: Commit** `feat(server): Restart and Start a new session; remove the interim reset script`.

---

### Task 21: The runtime journal and local cleanup

**Files:**
- Create: `apps/server/src/runtime/local/journal.ts`, `journal.test.ts`
- Modify: `apps/server/src/agents/agent-runtime.ts` (cleanup port wired for local), `agents/runtimes.ts`
- Test: also `apps/server/src/runtime/local/journal.live.test.ts` (real `sleep` children, no model)

**Interfaces:**
- Produces:

```ts
export interface PsRow { pid: number; ppid: number; start: string }
export function parsePs(out: string): PsRow[];                       // `ps -A -o pid=,ppid=,lstart=`
export function descendants(rows: PsRow[], root: number): PsRow[];
export class ProcessJournal {
  constructor(d: { ps?: () => Promise<string>; startOf?: (pid: number) => Promise<string | undefined>; kill?: (pid: number, sig: NodeJS.Signals) => void; sleep?: (ms: number) => Promise<void> });
  snapshot(claudePid: number): Promise<{ claude: { pid: number; start: string }; descendants: { pid: number; start: string }[] }>;
  /** SIGTERM every journaled pid whose start time still matches; 3 s; SIGKILL survivors that still match. Returns how many were signalled. */
  reap(j: Pick<RuntimeJournal, "claude" | "descendants">): Promise<number>;
}
```

- `AgentRuntime` (local only) snapshots on `process_started`, on `background_task_started`, and every 10 s while a turn is open or a task is live; writes `runtime_journal` (merged with tasks/crons from Task 15); clears it after a clean exit or a reap.

- [ ] **Step 1: Failing tests**

```ts
test("parsePs and descendants walk the tree including setsid children", () => {
  const rows = parsePs(" 10 1 Wed Nov 19 10:00:00 2026\n 11 10 Wed Nov 19 10:00:01 2026\n 12 11 Wed Nov 19 10:00:02 2026\n 13 1 Wed Nov 19 10:00:03 2026\n");
  expect(descendants(rows, 10).map((r) => r.pid)).toEqual([11, 12]);
});
test("reap never signals a pid whose start time changed", async () => {
  const kills: [number, string][] = [];
  const j = new ProcessJournal({ startOf: async (p) => (p === 11 ? "OTHER" : "S"), kill: (p, s) => kills.push([p, s]), sleep: async () => {} });
  await j.reap({ claude: { pid: 10, start: "S" }, descendants: [{ pid: 11, start: "S" }] });
  expect(kills.map((k) => k[0])).not.toContain(11);
});
test("live: a crash leaves a setsid sleep; reap kills it", async () => {
  // spawn `sh -c 'setsid sleep 600 & echo $! ; wait'` detached, snapshot, kill -9 the sh, reap, assert the sleep is gone
});
test("runtime: a mid-turn crash reaps the journal before the recovery start", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): local process journal with start-time-verified reaping`.

---

### Task 22: The local runtime gate

**Files:**
- Modify: `apps/server/src/agents/start.ts`, `agents/errors.ts` (`StartFix` + `"runtime"`), `templates/validate.ts`, `agents/agent-runtime.ts` (`runtimeDisabled` in `live()`), `routes/agents.ts` (restart 409)
- Test: `apps/server/src/agents/start.test.ts`, `templates/validate.test.ts`

**Interfaces:**
- Produces: the start failure `AgentStartError("The local runtime is disabled on this factory. Set FACTORY_ALLOW_LOCAL_RUNTIME=true to run agents unsandboxed.", "runtime")` before anything else; the validator warning `{severity:"warning", file:"template.yaml", message:"The local runtime is disabled on this factory.", path:"runtime"}` from the same `localRuntimeAllowed(config)`; `live().runtimeDisabled = "The local runtime is disabled on this factory."` for local agents while off.

- [ ] **Step 1: Failing tests**

```ts
test("gate off: local start fails closed with fix=runtime, messages stay pending", async () => {});
test("gate off: validator warns on runtime: local", async () => {});
test("gate off: restart is 409 runtime_disabled", async () => {});
test("gate on: local starts as before", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): gate the local runtime behind FACTORY_ALLOW_LOCAL_RUNTIME`.

---

### Task 23: Docker client and `ContainerManager`

**Files:**
- Modify: `apps/server/package.json` (`pnpm --filter @open-factory/server add dockerode@latest` and `pnpm --filter @open-factory/server add -D @types/dockerode@latest`; do not touch `allowBuilds`)
- Create: `apps/server/src/runtime/docker/client.ts`, `containers.ts`, `containers.test.ts`, `spec-hash.ts`

**Interfaces:**
- Produces:

```ts
// client.ts: the only dockerode import outside tests
export interface DockerClient {
  imageId(ref: string): Promise<string | undefined>;               // undefined when missing
  pull(ref: string, signal: AbortSignal): Promise<void>;            // rejects with the registry error verbatim
  imageLabel(ref: string, label: string): Promise<string | undefined>;
  findContainer(name: string): Promise<{ id: string; running: boolean; labels: Record<string, string> } | undefined>;
  listByLabel(label: string): Promise<{ id: string; running: boolean; labels: Record<string, string> }[]>;
  create(opts: ContainerCreateOptions): Promise<string>;
  start(id: string): Promise<void>; stop(id: string, t: number): Promise<void>; remove(id: string): Promise<void>;
  execRun(id: string, o: { cmd: string[]; user: string }): Promise<{ code: number; stdout: string }>;
  execStream(id: string, o: { cmd: string[]; user: string; workdir: string; env: string[] }): Promise<ExecStream>;
  logsTail(id: string, n: number): Promise<string>;
}
export function dockerodeClient(): DockerClient;   // honours DOCKER_HOST via dockerode defaults

// containers.ts
export function containerName(slug: string, agentId: string): string; // open-factory-<slug>-<agentId.slice(0,8)>
export function createOptions(i: { name: string; image: string; imageId: string; mounts: Mount[]; uid: number; gid: number; agentId: string; slug: string; specHash: string }): ContainerCreateOptions;
export function specHash(i: { imageId: string; mounts: Mount[]; uid: number; gid: number }): string; // + extra hosts, security opts, tmpfs, LAUNCHER_VERSION
export class ContainerManager {
  constructor(d: { docker: DockerClient; log: RuntimeLog; uid?: number; gid?: number });
  ensureImage(ref: string, signal: AbortSignal): Promise<void>;     // pull only when missing
  stopIfRunning(agentId: string, slug: string): Promise<boolean>;
  ensure(i: { agentId: string; slug: string; image: string; mounts: Mount[] }): Promise<{ containerId: string; action: "created" | "recreated" | "started"; imageId: string; claudeCodeVersion?: string }>;
  stop(agentId: string, slug: string): Promise<void>;
  isRunning(agentId: string, slug: string): Promise<boolean>;
  listOurs(): Promise<{ id: string; agentId: string; running: boolean }[]>;
}
```

- `ensure`: refuse uid/gid 0 ("The factory runs as root; Docker agents need a non-root host user."); compute the hash; if a container exists with another hash → stop + remove + create (`recreated`); else create if missing; start; poll `test -f /run/open-factory/ready` as root every 200 ms for 30 s; on timeout or exit → throw `AgentStartError` with `logsTail(id, 50)`.
- No test seam: every mount comes from the caller after `checkMounts` (owner's required change: no parameter may bypass `checkMounts` or `buildAgentEnv`).

- [ ] **Step 1: Failing tests** (a `FakeDockerClient` recording calls)

```ts
test("hardened create options", () => {
  const o = createOptions(inputs);
  expect(o.HostConfig?.SecurityOpt).toEqual(["no-new-privileges:true"]);
  expect(o.HostConfig?.Privileged).toBeFalsy();
  expect(o.HostConfig?.CapAdd).toBeUndefined();
  expect(o.HostConfig?.NetworkMode ?? "default").not.toBe("host");
  expect(o.HostConfig?.PidMode).toBeUndefined();
  expect(o.HostConfig?.Tmpfs).toEqual({ "/run/open-factory": "" });
  expect(o.HostConfig?.ExtraHosts).toEqual(["host.docker.internal:host-gateway"]);
  expect(o.Env).toEqual([`HOST_UID=${inputs.uid}`, `HOST_GID=${inputs.gid}`]);
  expect(o.Labels).toMatchObject({ "io.open-factory.agent-id": inputs.agentId, "io.open-factory.spec-hash": inputs.specHash });
});
test("spec hash changes on image id, mounts and uid; not on anything else passed", () => {});
test("pull only when missing", async () => {});
test("re-creates on hash change, starts on match", async () => {});
test("ready timeout surfaces the container logs", async () => {});
test("root host user is refused", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm install --frozen-lockfile` clean; `allowBuilds` unchanged.
- [ ] **Step 5: Commit** `feat(server): Docker container manager (dockerode)`.

---

### Task 24: Docker exec transport and the pid-file terminate

**Files:**
- Create: `apps/server/src/runtime/docker/exec-transport.ts`, `exec-transport.test.ts`
- Modify: `apps/server/src/app.ts` (driver gets `transports.docker`)

**Interfaces:**
- Consumes: `Transport` (Task 5), `DockerClient` (Task 23).
- Produces: `dockerTransport(d: { docker: DockerClient; containers: ContainerManager }): TransportFactory` using `spec.docker.containerId`, `spec.docker.claudeBin`, `spec.cwd`, `spec.env`; `parsePid(s: string): number | undefined`.

```ts
export const CLAUDE_WRAPPER = 'echo $$ > /tmp/open-factory-claude.pid && exec "$0" "$@"';
export function parsePid(s: string) { const t = s.trim(); return /^[1-9][0-9]{0,9}$/.test(t) ? Number(t) : undefined; }
// terminate():
const pid = parsePid((await docker.execRun(id, { cmd: ["cat", "/tmp/open-factory-claude.pid"], user: "agent" })).stdout);
if (!pid) return false;
const comm = (await docker.execRun(id, { cmd: ["cat", `/proc/${pid}/comm`], user: "agent" })).stdout.trim();
if (comm !== "claude") return false;
return (await docker.execRun(id, { cmd: ["kill", "-TERM", String(pid)], user: "agent" })).code === 0;
// forceKill(): containers.stop(...) (t: 5)
```

- stdin: `stream.write`; `endInput()`: `stream.end()` (half-close, V2); stdout/stderr demuxed into line iterables; `exit` resolves when the stream ends with `ExitCode` from exec inspect (`signal: null`).

- [ ] **Step 1: Failing tests** (fake `DockerClient` with a scripted exec stream)

```ts
test.each(["abc", "0", "-5", "12345678901", "12 34", ""])("pid file %j: no kill exec, terminate false", async (content) => {
  const d = fakeDocker({ pidFile: content });
  expect(await transport(d).terminate()).toBe(false);
  expect(d.execs.some((e) => e.cmd[0] === "kill")).toBe(false);
});
test("comm must be claude", async () => {});
test("good pid: kill -TERM as agent, argv only", async () => {
  const d = fakeDocker({ pidFile: "42\n", comm: "claude\n" });
  expect(await transport(d).terminate()).toBe(true);
  expect(d.execs.at(-1)).toEqual({ cmd: ["kill", "-TERM", "42"], user: "agent" });
});
test("exec Cmd uses the fixed wrapper and argv args; Env is the spec env", async () => {});
test("endInput half-closes; exit code from inspect", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): Docker exec transport with a verified pid-file SIGTERM`.

---

### Task 25: The Docker start path, crash cleanup and image pulls

**Files:**
- Modify: `apps/server/src/agents/start.ts`, `agents/agent-runtime.ts` (cleanup port for Docker, `container` event, container stop on every Docker exit), `supervisor/supervisor.ts` (`pulling` entries), `agents/agent-service.ts` (Docker `canWriteNow`), `agents/runtimes.ts`
- Test: `apps/server/src/agents/start.docker.test.ts` (fake Docker client)

**Interfaces:**
- `prepareStart` for Docker: `containers.stopIfRunning` → S4 prepare (canonical paths, plugins link, staged files, `checkMounts`) → returns the spec with `runtime: "docker"`; `startNow` then calls `containers.ensure` outside the workspace lock, sets `spec.docker = {containerId, claudeBin: config.dockerClaudeBin}`, appends `container{action, image, imageId, claudeCodeVersion}`.
- Every Docker exit (hibernate, crash, failed start, internal) stops the container before `slots.release`; a failing stop → `stop_failed` (Task 19).
- The Supervisor's `requestWake` for a Docker agent marks the entry `pulling` and calls `containers.ensureImage(ref, closingSignal)`; on success the entry becomes eligible; on failure it is dropped and a job on the agent records `errored` (`start`, the registry error). `live().pulling`.
- S4's "The Docker runtime isn't available yet." and its test are removed. The version check is skipped for Docker.

- [ ] **Step 1: Failing tests**

```ts
test("a Docker wake stops a running container, prepares, ensures, then execs", async () => {
  // fake docker: container running → stop called before prepare; ensure → exec with -u agent -w workdir
});
test("container event carries image id and claude version label", async () => {});
test("a crash stops the container before the recovery start", async () => {});
test("hibernate stops the container (not removed)", async () => {});
test("a missing image is pulled before the grant; status queued + pulling", async () => {});
test("a pull failure records errored start with the registry error", async () => {});
test("Docker unreachable: start fails with the DOCKER_HOST message", async () => {});
test("missing CLI bundle: 'Build the CLI first (pnpm build).'", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): start Docker agents through the container manager`.

---

### Task 26: Boot reconciliation and shutdown wiring

**Files:**
- Create: `apps/server/src/supervisor/reconcile.ts`, `reconcile.test.ts`
- Modify: `apps/server/src/app.ts` (run `migrateWorkdirState`, then `reconcile` before listen; `onClose`: `supervisor.close()`, every runtime `setNoStart()`, then parallel `hibernate("shutdown")`, then drain), `agents/runtimes.ts` (`stopAll` → hibernate shutdown), `agents/event-store.ts` (`danglingTurns()`, `closeDanglingTurns()`, agents with journals/attempting/pending)
- Test: `apps/server/src/agents/assembled.test.ts` (extend: the restart invariant with the fake claude)

**Interfaces:**
- Produces: `reconcile(d: { store; journal: ProcessJournal; containers?: ContainerManager; supervisor; runtimes; log }): Promise<void>` doing spec §5.7 steps 1–7 in order.

- [ ] **Step 1: Failing tests**

```ts
test("a journaled live pid with a matching start is reaped; a mismatched one isn't", async () => {});
test("running labelled containers of our agents are stopped; others' are left alone", async () => {});
test("Docker unreachable: warn and continue", async () => {});
test("dangling turns closed with factory_restarted; reconciled + background_work_lost appended", async () => {});
test("an agent whose attempt was cut short is errored and not woken", async () => {});
test("an agent mid-turn at crash gets factory_restarted and one boot_resume wake (attempting set)", async () => {});
test("agents with pending messages wake FIFO by oldest pending; errored ones don't", async () => {});
test("reset timers re-armed for future pauses; past ones cleared and owed notices created", async () => {});
test("assembled: app.close() with a live agent, reopen(): exactly one claude process per agent", async () => {
  // fake claude records pids; after reopen + a message, the old pid is gone and one new pid exists
});
test("assembled: graceful shutdown mid-turn → next boot delivers the factory_restarted notice once", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(server): boot reconciliation and a closing latch on shutdown`.

---

### Task 27: Web: statuses, reset times and the hibernated token

**Files:**
- Modify: `apps/web/src/styles.css`, `features/session/status-badge.tsx`, `features/session/format.ts`, `features/session/use-agent-status.ts`, `features/session/session-view.tsx` (title)
- Test: `apps/web/src/features/session/status-badge.test.tsx`, `format.test.ts`

**Interfaces:**
- Produces: `formatResetTime(until: Date, now: Date): string` (`14:30` today; `Thu 09:10` within 6 days; `27 Nov 09:10` otherwise); `StatusBadge({status, rateLimitedUntil?, rateLimitExact?, size: "long" | "short"})`.

- [ ] **Step 1: Failing tests**

```tsx
test("working renders the tooth, never a dot; others render a dot + label", () => {
  const { container } = render(<StatusBadge status="working" size="long" />);
  expect(container.querySelector(".of-tooth")).not.toBeNull();
  expect(container.querySelector("[data-status-dot]")).toBeNull();
});
test.each([
  [true, "Rate-limited until 14:30"],
  [false, "Rate-limited, retrying at 14:30"],
])("rate-limited long label (exact=%s)", (exact, label) => {
  render(<StatusBadge status="rate_limited" rateLimitedUntil={todayAt(14, 30)} rateLimitExact={exact} size="long" />);
  expect(screen.getByText(label)).toBeInTheDocument();
});
test("short label never has a time", () => {});
test("formatResetTime", () => {
  expect(formatResetTime(new Date(2026, 10, 19, 14, 30), new Date(2026, 10, 19, 9))).toBe("14:30");
  expect(formatResetTime(new Date(2026, 10, 20, 9, 10), new Date(2026, 10, 19, 9))).toBe("Thu 09:10");
  expect(formatResetTime(new Date(2026, 10, 27, 9, 10), new Date(2026, 10, 19, 9))).toBe("27 Nov 09:10");
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `styles.css`: light `--status-hibernated: oklch(0.6 0.01 255)`, dark `oklch(0.57 0.008 255)`. `document.title` uses the short label. The announcer strings per UI doc §6.
- [ ] **Step 4: Run** `pnpm vitest run apps/web` → PASS.
- [ ] **Step 5: Commit** `feat(web): queued and rate-limited statuses`.

---

### Task 28: Web: strip, recovery actions, dialog, timeline rows, Factory notices, Agents list

**Files:**
- Create: `apps/web/src/features/session/recovery-actions.tsx`, `new-session-dialog.tsx`
- Modify: `features/session/agent-strip.tsx`, `timeline-row.tsx`, `message-block.tsx`, `queue-items.tsx`, `session-view.tsx`, `components/confirm-dialog.tsx` (comment), `routes/_app/agents.index.tsx`, the agent edit/re-sync outcome copy (`features/agents/agent-actions.tsx`), the S4 "Reminders…" strings, the template and New agent warnings
- Test: `apps/web/src/features/session/*.test.tsx` (extend), `routes/_app/agents.index.test.tsx`

**Interfaces:**
- Consumes: the §8.2 fields, the `supervisor` frame, the §15 events, `restart`/`reset-session` endpoints.
- Produces: the UI doc's §3–§5 exactly, strings from its §8.

- [ ] **Step 1: Failing tests** (one per behaviour; the list below is the minimum)

```tsx
test("errored: Restart and Start a new session replace Compact/Interrupt", () => {});
test("Restart hidden for resume_unrecoverable and when runtimeDisabled", () => {});
test("Restarting… ends on the next error event (failed restart)", async () => {});
test("dialog copy names the agent and the loss; Cancel focused; confirm moves focus to the composer", async () => {
  // title "Start a new session for @lead?", body "@lead won't remember anything from its current session. …", confirm "Start new session for @lead"
});
test("strip: Waiting on with truncated aria-hidden text and full visually hidden text; outside the role=status region", () => {});
test("strip: paused detail uses 'retrying at' when inexact; queued detail; Pulling the image…", () => {});
test("strip: Docker (open-factory-base:dev) / Docker / local disabled with its Why? (distinct aria-label)", () => {});
test("timeline: rate_limited renders nothing; rate_limit_paused follows the fallback rule", () => {});
test("timeline: hibernated, process_started reasons (nothing after session_reset), cleanup, stop_escalated, background_work_lost, reconciled, unexpected exited as 'Stopped unexpectedly'", () => {});
test("Factory notice: sender 'Factory', icon aria-hidden, never announced", () => {});
test("Agents list: inline note priority, '3 of 8 running' before the radio pair, hidden on Archived", () => {});
test("re-sync outcome says the changes apply on restart when applied=on_restart", () => {});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the UI doc (icons `RefreshCcw`, `FilePlus2`, `ShieldOff`, `Factory` from lucide; S4 `ConfirmDialog` with `onCloseAutoFocus` → composer; recovery actions while errored only).
- [ ] **Step 4: Run** `pnpm vitest run apps/web && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(web): lifecycle, recovery and runtime in the session view and agents list`.

---

### Task 29: Gated Docker integration tests

**Files:**
- Create: `apps/server/src/runtime/docker/docker.int.test.ts` (skipped unless `FACTORY_DOCKER_TESTS=1`)
- Modify: `packages/harness/testing/index.ts` (a helper that copies the fake claude and the fixtures it replays into a test agent's workdir and returns the in-container path and the `FAKE_CLAUDE_*` values)

**Interfaces:**
- Consumes: the production `ContainerManager` and `dockerTransport` (no seams), the fake claude (Node in the image; `process.title = "claude"`).
- **How the fake gets in through the real paths:** the helper copies `fake-claude.mjs` and its fixtures into the test agent's **workdir** (already a checked read-write mount at path parity) and `FACTORY_DOCKER_CLAUDE_BIN` points at that path; the `FAKE_CLAUDE_*` values (scenario, log path inside the workdir) are defined as factory **secrets** and listed in the test template's `secrets`, so they reach the exec env through `buildAgentEnv` like any secret (the names pass the secret-name rules). If any of this turns out impossible, stop and ask the owner before adding a seam; any seam must go through `checkMounts`/`buildAgentEnv`, never after them.

- [ ] **Step 1: Write the tests** (they're the deliverable; each must fail before Tasks 23–26 are wired, which you can confirm by reverting one wiring line)

```ts
const docker = process.env.FACTORY_DOCKER_TESTS === "1" ? describe : describe.skip;
docker("Docker runtime (open-factory-base:dev, fake claude)", () => {
  test("hardened container: ready marker, -u agent, sudo fails", async () => {});
  test("exec round trip: envelope in, events out, half-close exits", async () => {});
  test("terminate via the pid file stops claude (143)", async () => {});
  test("hibernate stops the container; a grant change re-creates it", async () => {});
  test("crash: container stopped, the planted background sleep is gone, one notice-led resume", async () => {});
  test("a file written through a project mount is owned by the host user; git worktree list matches", async () => {});
  test("boot reconciliation stops a running labelled container", async () => {});
  test("a container left running by a dropped exec is stopped before the next start", async () => {});
  test("server restart invariant: one claude per agent (local and Docker)", async () => {});
});
```

- [ ] **Step 2: Run** `FACTORY_DOCKER_TESTS=1 pnpm vitest run apps/server/src/runtime/docker/docker.int.test.ts` → PASS (Docker Desktop or a Linux engine; image `open-factory-base:dev` built from `images/base`). Default `pnpm test` → the suite is skipped.
- [ ] **Step 3: Commit** `test(server): gated Docker integration tests`.

---

### Task 30: Live check `pnpm smoke:docker`

**Files:**
- Create: `apps/server/scripts/smoke-docker.ts`
- Modify: root `package.json` (`"smoke:docker": "node --env-file-if-exists=.env --import tsx apps/server/scripts/smoke-docker.ts"`)

- [ ] **Step 1: Write the script** following `smoke-workspace.ts`: a throwaway DB and `FACTORY_HOME`, the token read from `~/.open-factory-spike/oauth-token` into a credential at run time (never printed), a `runtime: docker` template with `model: haiku`, `warm_window_minutes: 1`, one directory-marketplace plugin, one granted temp git repo (created under a canonical path). Steps, each asserted and printed (spec §18.5): remember a word and list the plugin skill → hibernate, container stopped → wake, recall the word (AC1) → write a file and create a worktree; host `stat` owner = `id -u`; `git worktree list` equal on both sides (AC5) → background `sleep 600` keeps it awake past the window (AC2) → `curl -s $OPEN_FACTORY_URL/api/status` from the container answers (on Linux, set `HOST` per the README) → `sudo -n true` fails in the container → `docker exec … pkill -KILL -x claude` → container stopped, the sleep gone, one notice-led resume (AC4).
- [ ] **Step 2: Run** `pnpm smoke:docker` → all steps PASS; keep the output for the PR.
- [ ] **Step 3: Commit** `chore(server): live Docker smoke check`.

---

### Task 31: Docs, final checks and the PR

**Files:**
- Modify: `README.md` (Docker runtime: image, `FACTORY_DEFAULT_IMAGE`, pulls are explicit; no sudo in containers, use a user image; Linux reachability: bind to the Docker bridge address or a compose network, `0.0.0.0` as the less safe fallback; `FACTORY_ALLOW_LOCAL_RUNTIME`; the cap; container re-creation wipes `/home/agent`; Restart and Start a new session), `.env.example`

- [ ] **Step 1:** Update the docs.
- [ ] **Step 2:** `pnpm lint:ci && pnpm typecheck && pnpm test && pnpm build` → green. `FACTORY_DOCKER_TESTS=1` suite and `pnpm smoke:docker` → green (record output). `pnpm smoke:harness` and `pnpm smoke:workspace` still pass (with `FACTORY_ALLOW_LOCAL_RUNTIME=true`).
- [ ] **Step 3:** Manual pass in a real browser through ACs 1–8 (spec §2), including both themes for the status badges and 390 px for the session header.
- [ ] **Step 4:** Open the PR per `.github/pull_request_template.md`, stacked on `spec/s4-templates-workspace`. Changes must list the S4 behaviour changes (owed-notification bound, idempotent stop, escalation, flush held during stops, apply-restart no longer waits for crons, plugins in `state/`, `.factory` moved). Rollout notes: `FACTORY_ALLOW_LOCAL_RUNTIME=true` for existing local agents; agents can no longer sudo in containers; the one-time `.factory` move; S4 agents with plugins need one re-sync before they start again (no install at start); container re-creation wipes `/home/agent`; `pnpm agent:reset-session` is gone. `Closes #38`, and mention #10, #18, #19, #20, #31.
- [ ] **Step 5: Commit** `docs: S5 Docker runtime, local gate and recovery`.

---

## Decisions this plan makes where the spec is silent

1. **`SlotPort` interface between runtimes and the Supervisor** (Task 14), with an unlimited implementation for older tests: lets the runtime refactor land and be tested before the Supervisor exists.
2. **`DockerClient` wraps dockerode behind a small interface** (Task 23): unit tests use a fake, and only `client.ts` imports dockerode (spec §4's "nothing outside runtime/docker imports dockerode").
3. **`Transport.terminate()` returns a boolean** (Task 5): the pid-file checks can fail closed without throwing, and `stop()` falls through to its timeout and escalation.
4. **Error codes `409 reset_not_allowed` and `409 attempt_in_progress`** (Task 20): the spec names the conditions; these names keep the S1 error shape.
5. **A real `.claude-config/plugins/` dir found during the migration re-sync is moved to `state/agents/<slug>/plugins-legacy-<ts>/`, not deleted** (Task 9): nothing is lost if the reinstall misbehaves. (Owner's required change: no install at start; S4 agents with plugins fail closed with a "Re-sync" fix until a human re-syncs.)
6. **The rejected rate-limit fixture's `resetsAt` is a fixed epoch (1795000000)** and tests use fake timers relative to it (Task 6): deterministic.
7. **`FACTORY_CLI_BUNDLE` defaults to `apps/cli/dist/open-factory.js` resolved from `config.ts`'s location** (Task 4): works from source and from the built server without extra config.
8. **The owed-notification bound and journal snapshots use the runtime's existing timer style (setTimeout + a job), not a new scheduler** (Tasks 15, 21): one pattern, testable with fake timers.
9. **Task 1 is a manual gate with a README note, not a committed fixture**: it guards a design assumption; a trace would add nothing the note doesn't.
