import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import type { RuntimeJournal } from "@open-factory/db";
import type { AnyEvent } from "@open-factory/shared";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import type { AgentRuntime } from "../agents/agent-runtime.ts";
import { EventBus } from "../agents/event-bus.ts";
import { EventStore } from "../agents/event-store.ts";
import { AgentRuntimes } from "../agents/runtimes.ts";
import { ev, FakeDriver, type FakeProcess } from "../agents/testing/fake-driver.ts";
import { insertAgent, insertSchedule, insertScheduledMessage } from "../agents/testing/rows.ts";
import {
  noForward,
  noopTokens,
  okSpec,
  silentLog,
  testEffective,
} from "../agents/testing/runtime-harness.ts";
import type { Forward } from "../messaging/forwarder.ts";
import { ContainerManager, containerName, LABEL_AGENT_ID } from "../runtime/docker/containers.ts";
import { FakeDockerClient } from "../runtime/docker/testing/fake-docker.ts";
import { ProcessJournal } from "../runtime/local/journal.ts";
import { ScheduleStore } from "../scheduling/schedule-store.ts";
import { Reaper } from "../spawning/reaper.ts";
import { claimTestHandleSql } from "../test/handles.ts";
import { createTestDb } from "../test/helpers.ts";
import { ATTEMPT_CUT_SHORT, reconcile } from "./reconcile.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  await claimTestHandleSql(t.sql, "or", "user");
  await t.sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
});
afterAll(() => t.close());

/** One boot of the factory: real runtimes and Supervisor over the fake driver, and a fake Docker daemon. */
class Boot {
  readonly driver = new FakeDriver();
  readonly docker = new FakeDockerClient();
  /** The one ContainerManager, as in buildApp: boot, the runtimes and the sweep share it. */
  readonly containers = new ContainerManager({
    docker: this.docker,
    log: silentLog,
    uid: 501,
    gid: 20,
  });
  readonly runtimes: AgentRuntimes;
  readonly logs: { level: string; msg: string }[] = [];
  readonly forwarded: Forward[] = [];
  readonly log = {
    debug: () => {},
    info: (_: object, msg: string) => this.logs.push({ level: "info", msg }),
    warn: (_: object, msg: string) => this.logs.push({ level: "warn", msg }),
    error: (_: object, msg: string) => this.logs.push({ level: "error", msg }),
  };
  /** `dockerRuntime`: the runtimes get the Docker deps (a terminated Docker agent's removal goes through them). */
  constructor(max = 8, o: { dockerRuntime?: boolean } = {}) {
    this.runtimes = new AgentRuntimes({
      tokens: noopTokens,
      forward: noForward,
      store,
      bus: new EventBus(),
      driver: this.driver,
      prepareStart: async (a) => okSpec(a),
      log: silentLog,
      maxRunningAgents: () => max,
      ...(o.dockerRuntime
        ? {
            docker: {
              containers: this.containers,
              claudeBin: "claude",
              defaultImage: "img",
              resolver: { effective: async () => testEffective({ runtime: "docker" }) },
            },
          }
        : {}),
    });
  }

  run(journal: ProcessJournal = new ProcessJournal({ sleep: async () => {} })) {
    return reconcile({
      store,
      journal,
      containers: this.containers,
      supervisor: this.runtimes.supervisor,
      runtimes: this.runtimes,
      memberUpdateDebounceMs: () => 30_000,
      forward: async (f) => {
        this.forwarded.push(f);
      },
      log: this.log,
    });
  }

  /** The spawned-agent sweep (spec §10.3) over this boot's runtimes and Docker; its other steps find nothing. */
  reaper(now = Date.now()) {
    return new Reaper({
      store,
      runtimes: this.runtimes,
      terminator: { terminate: async () => ({ status: "terminated" }) },
      workspace: { deleteWorkspace: async () => false },
      containers: this.containers,
      log: this.log,
      now: () => now,
    });
  }

  async rt(id: string): Promise<AgentRuntime> {
    const rt = await this.runtimes.get(id);
    if (!rt) throw new Error(`${id} not loaded`);
    return rt;
  }
  starts(id: string): FakeProcess[] {
    return this.driver.starts.filter((p) => p.spec.agentId === id);
  }
  startOrder(): string[] {
    return this.driver.starts.map((p) => p.spec.agentId);
  }
  async settleAll(ids: string[]) {
    for (let i = 0; i < 4; i++)
      for (const id of ids) await (await this.runtimes.get(id))?.settled();
  }
}

let boot: Boot | undefined;
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const p of boot?.driver.starts ?? []) p.releaseStop();
  await boot?.runtimes.close();
  boot = undefined;
  for (const c of children.splice(0)) c.kill("SIGKILL");
  // Each boot reconciles the whole database: start every test from an empty factory.
  await t.sql`truncate messages, session_events, turns, agents, credentials cascade`;
});

let n = 0;
async function agent(o: { status?: string } = {}): Promise<string> {
  n += 1;
  const id = `r${n}`;
  await insertAgent(t.sql, { id, slug: `rec${n}`, ...(o.status ? { status: o.status } : {}) });
  return id;
}
const pending = (id: string, body: string) =>
  store.createMessage({
    from: { userId: "u1" },
    toAgentId: id,
    recipients: ["@test"],
    body,
    urgent: false,
  });
const openTurn = (id: string) => store.openTurn(id, null);
const setJournal = (id: string, j: Omit<RuntimeJournal, "takenAt">) =>
  store.setRuntimeJournal(id, { ...j, takenAt: new Date().toISOString() });
const events = async (id: string): Promise<AnyEvent[]> =>
  (await store.after(id, 0, 1000)).map((e) => e.event);
const row = async (id: string) => {
  const r = await store.agentById(id);
  if (!r) throw new Error("no agent");
  return r;
};
const notices = (id: string) =>
  t.sql`select notice, body, state from messages where to_agent_id = ${id} and kind = 'system' order by created_at`;

/** A real `sleep` child and its start time as `ps` reports it (the journal's format). */
function sleeper(): { pid: number; start: string } {
  const c = spawn("sleep", ["60"], { stdio: "ignore" });
  children.push(c);
  const pid = c.pid;
  if (!pid) throw new Error("no pid");
  const start = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
  })
    .toString()
    .trim()
    .replace(/\s+/g, " ");
  return { pid, start };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const exited = (c: ChildProcess) =>
  new Promise<void>((r) =>
    c.exitCode !== null || c.signalCode !== null ? r() : c.once("exit", () => r()),
  );

test("a journaled live pid with a matching start is reaped; a mismatched one isn't", async () => {
  const id = await agent();
  const claude = sleeper();
  const other = sleeper();
  await setJournal(id, {
    claude,
    descendants: [{ pid: other.pid, start: "Thu Jan 1 00:00:00 1970" }],
    tasks: [],
    crons: [],
  });
  boot = new Boot();
  await boot.run();
  await exited(children[0] as ChildProcess);
  expect(alive(claude.pid)).toBe(false);
  expect(alive(other.pid)).toBe(true);
  expect(await events(id)).toEqual([
    { type: "reconciled", killedProcesses: 1, stoppedContainer: false },
  ]);
  expect((await row(id)).runtimeJournal).toBeNull();
  expect(boot.driver.starts).toHaveLength(0); // nothing pending: it stays hibernated
});

test("running labelled containers of our agents are stopped; others' are left alone", async () => {
  const id = await agent();
  const idle = await agent();
  boot = new Boot();
  const put = (name: string, agentId: string, running: boolean) =>
    boot?.docker.containers.set(name, {
      id: name,
      name,
      running,
      labels: { [LABEL_AGENT_ID]: agentId },
      opts: {},
    });
  put("ours", id, true);
  put("ours-stopped", idle, false);
  put("foreign", "another-factory-agent", true);
  await boot.run();
  const stops = boot.docker.calls.filter((c) => c.op === "stop").map((c) => c.args[0]);
  expect(stops).toEqual(["ours"]);
  expect(boot.docker.containers.get("foreign")?.running).toBe(true);
  expect(await events(id)).toEqual([
    { type: "reconciled", killedProcesses: 0, stoppedContainer: true },
  ]);
  expect(await events(idle)).toEqual([]);
  expect(boot.logs).toContainEqual({
    level: "info",
    msg: "containers of another factory or a deleted agent were left alone",
  });
});

test("Docker unreachable: warn and continue", async () => {
  const id = await agent();
  await t.sql`update agents set runtime = 'docker' where id = ${id}`;
  await openTurn(id);
  boot = new Boot();
  boot.docker.down = Object.assign(new Error("connect ECONNREFUSED /var/run/docker.sock"), {
    code: "ECONNREFUSED",
  });
  await boot.run();
  expect(boot.logs).toContainEqual({
    level: "warn",
    msg: "Docker isn't reachable; leftover containers were not checked",
  });
  // The other steps still ran: the dangling turn is closed and the agent resumes.
  expect(await events(id)).toContainEqual({
    type: "reconciled",
    killedProcesses: 0,
    stoppedContainer: false,
  });
  await boot.settleAll([id]);
  expect(boot.starts(id)).toHaveLength(1);
});

test("dangling turns closed with factory_restarted; reconciled + background_work_lost appended", async () => {
  const id = await agent();
  const untouched = await agent();
  const turnId = await openTurn(id);
  const lost = {
    tasks: [{ taskId: "t1", description: "pnpm test" }],
    crons: [{ cronId: "c1", humanSchedule: "every 5 minutes" }],
  };
  await setJournal(id, lost);
  boot = new Boot();
  await boot.run();
  const [turn] =
    await t.sql`select ended_at, is_error, terminal_reason from turns where id = ${turnId}`;
  expect(turn?.ended_at).not.toBeNull();
  expect(turn).toMatchObject({ is_error: true, terminal_reason: "factory_restarted" });
  const evs = await events(id);
  expect(evs.slice(0, 2)).toEqual([
    { type: "reconciled", killedProcesses: 0, stoppedContainer: false },
    { type: "background_work_lost", reason: "factory_restarted", ...lost },
  ]);
  expect(await notices(id)).toEqual([
    {
      notice: "factory_restarted",
      body: "The factory restarted while you were working. These background tasks were stopped: `pnpm test`. Check the state of that work and continue where you left off.",
      state: "pending",
    },
  ]);
  expect((await row(id)).runtimeJournal).toBeNull();
  expect(await events(untouched)).toEqual([]);
  expect(boot.forwarded).toEqual([
    {
      agentId: id,
      fact: "work_lost",
      body: expect.stringContaining("Reported by @"),
    },
  ]);
  expect(boot.forwarded[0]?.body).toContain("> pnpm test\n> every 5 minutes");
});

test("an agent whose attempt was cut short is errored and not woken", async () => {
  const fresh = await agent();
  await t.sql`update agents set attempting = true where id = ${fresh}`;
  await store.createNotice({ toAgentId: fresh, notice: "crash", body: "crashed" });
  const resumeFailed = await agent({ status: "errored" });
  await t.sql`update agents set attempting = true, error_kind = 'resume', last_error = 'No conversation',
              errored_reported = true where id = ${resumeFailed}`;
  await pending(resumeFailed, "hi");
  // A crash whose automatic attempt failed (reported), then a human retry the restart cut short: same episode.
  const crashRetry = await agent({ status: "errored" });
  await t.sql`update agents set attempting = true, error_kind = 'crash', last_error = 'Exited unexpectedly (code 1)',
              errored_reported = true where id = ${crashRetry}`;
  boot = new Boot();
  await boot.run();
  expect(await row(fresh)).toMatchObject({
    status: "errored",
    errorKind: "crash",
    lastError: ATTEMPT_CUT_SHORT,
    attempting: false,
  });
  expect(await row(resumeFailed)).toMatchObject({
    status: "errored",
    errorKind: "resume",
    lastError: "No conversation",
    attempting: false,
  });
  await boot.settleAll([fresh, resumeFailed]);
  expect(boot.driver.starts).toHaveLength(0);
  // S6 §9.1: the cut-short automatic attempt starts an errored episode; the cut-short human retries were inside one.
  expect(boot.forwarded.filter((f) => f.fact === "errored").map((f) => f.agentId)).toEqual([fresh]);
  const body = boot.forwarded.find((f) => f.agentId === fresh)?.body;
  expect(body).toContain("is errored and needs a human. Reported by @");
  expect(body).toContain(`\n> ${ATTEMPT_CUT_SHORT}`);
});

test("an agent mid-turn at crash gets factory_restarted and one boot_resume wake (attempting set)", async () => {
  const id = await agent();
  await pending(id, "older message");
  await openTurn(id);
  boot = new Boot();
  await boot.run();
  await boot.settleAll([id]);
  expect(boot.starts(id)).toHaveLength(1);
  expect((await row(id)).attempting).toBe(true);
  const rt = await boot.rt(id);
  expect(rt.live().status).toBe("working");
  expect(await events(id)).toContainEqual({
    type: "process_started",
    resumed: false,
    reason: "boot_resume",
  });
  // The notice leads the first batch, ahead of the older message.
  const p = boot.starts(id)[0] as FakeProcess;
  expect(p.sent[0]?.map((m) => m.from)).toEqual(["@factory", "@or"]);
  expect(p.sent[0]?.[0]?.body).toBe(
    "The factory restarted while you were working. Check the state of that work and continue where you left off.",
  );
  // The attempt succeeds with its batch turn; no second wake was asked for.
  p.emit(...ev.fullTurn());
  await boot.settleAll([id]);
  expect((await row(id)).attempting).toBe(false);
  expect(boot.starts(id)).toHaveLength(1);
});

test("a boot_resume still queued at shutdown never started: the next boot wakes it, not errors it", async () => {
  const first = await agent();
  const second = await agent();
  await pending(first, "a1");
  await openTurn(first);
  await pending(second, "b1");
  await openTurn(second);
  const one = new Boot(1);
  boot = one;
  await one.run();
  await one.settleAll([first, second]);
  expect(one.startOrder()).toEqual([first]);
  expect((await one.rt(second)).live().status).toBe("queued");
  expect((await row(second)).attempting).toBe(true);

  // A graceful shutdown: the closing latch drops the queued wake before any process started.
  for (const p of one.driver.starts) p.releaseStop();
  await one.runtimes.close();
  expect((await row(second)).attempting).toBe(false);
  expect((await row(first)).attempting).toBe(true); // its process ran: cut short for real

  const two = new Boot();
  boot = two;
  await two.run();
  await two.settleAll([first, second]);
  expect(await row(first)).toMatchObject({ status: "errored", lastError: ATTEMPT_CUT_SHORT });
  expect((await row(second)).status).not.toBe("errored");
  expect(two.starts(second)).toHaveLength(1);
  expect(await events(second)).toContainEqual({
    type: "process_started",
    resumed: false,
    reason: "boot_resume",
  });
  expect((two.starts(second)[0] as FakeProcess).sent[0]?.[0]?.from).toBe("@factory");
});

test("agents with pending messages wake FIFO by oldest pending; errored ones don't", async () => {
  const x = await agent();
  const y = await agent();
  const z = await agent();
  const broken = await agent({ status: "errored" });
  await t.sql`update agents set error_kind = 'crash', last_error = 'x' where id = ${broken}`;
  await pending(broken, "first of all");
  await pending(z, "z1");
  await pending(x, "x1");
  await pending(y, "y1");
  await pending(z, "z2");
  boot = new Boot(1);
  await boot.run();
  const ids = [x, y, z, broken];
  await boot.settleAll(ids);
  expect(boot.startOrder()).toEqual([z]);
  expect((await boot.rt(x)).live().status).toBe("queued");
  expect((await boot.rt(y)).live().status).toBe("queued");
  // Each finished turn frees the one slot for the next in line (early hibernation, spec §5.3).
  for (const id of [z, x]) {
    const p = boot.starts(id).at(-1) as FakeProcess;
    p.emit(...ev.fullTurn());
    await boot.settleAll(ids);
  }
  expect(boot.startOrder()).toEqual([z, x, y]);
  expect(await boot.runtimes.get(broken)).toBeUndefined(); // never loaded, never woken
  expect(boot.starts(broken)).toHaveLength(0);
});

test("reset timers re-armed for future pauses; past ones cleared and owed notices created", async () => {
  const future = await agent();
  const past = await agent();
  const until = new Date(Date.now() + 3_600_000);
  await store.pauseCredential(`cred-${future}`, until, true);
  await store.pauseCredential(`cred-${past}`, new Date(Date.now() - 60_000), false);
  await t.sql`update agents set rate_limit_notice_owed = true where id in (${future}, ${past})`;
  await pending(future, "held");
  boot = new Boot();
  await boot.run();
  const sup = boot.runtimes.supervisor;
  // Re-armed before the wakes: the paused agent is queued, never started.
  expect(sup.paused(`cred-${future}`)).toBe(true);
  await boot.settleAll([future]);
  expect(boot.starts(future)).toHaveLength(0);
  expect((await boot.rt(future)).live()).toMatchObject({
    status: "rate_limited",
    rateLimitedUntil: until.toISOString(),
  });
  expect((await row(future)).rateLimitNoticeOwed).toBe(true);
  // The window that already passed resets at once: the continue notice, the columns cleared, then a wake.
  await vi.waitFor(async () => {
    const [c] =
      await t.sql`select rate_limited_until from credentials where id = ${`cred-${past}`}`;
    expect(c?.rate_limited_until).toBeNull();
  });
  await vi.waitFor(() => expect(boot?.starts(past)).toHaveLength(1));
  expect(sup.paused(`cred-${past}`)).toBe(false);
  expect((await row(past)).rateLimitNoticeOwed).toBe(false);
  expect((await notices(past)).map((m) => m.notice)).toEqual(["rate_limit_reset"]);
});

test("a cap lowered at boot with more agents waking than slots starts the first in line and evicts for the rest", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = await agent();
    await pending(id, `m${i}`);
    ids.push(id);
  }
  boot = new Boot(3);
  await boot.run();
  await boot.settleAll(ids);
  const [a, b, c, d, e] = ids as [string, string, string, string, string];
  // The first three in line hold the slots. Their grant jobs run concurrently, so the spawn order among them is the
  // DB's, not the queue's: the queue order shows in who is still waiting.
  expect([...boot.startOrder()].sort()).toEqual([a, b, c].sort());
  expect((await boot.rt(d)).live().status).toBe("queued");
  expect((await boot.rt(e)).live().status).toBe("queued");
  const procs = [a, b, c].map((id) => boot?.starts(id)[0] as FakeProcess);
  for (const p of procs) {
    p.holdStop = true;
    p.emit(...ev.fullTurn());
  }
  await boot.settleAll(ids);
  // Two idle holders are hibernated for the two waiting; the slots go to the queue in FIFO order. One slot at a time,
  // for the same reason as above.
  const evicted = procs.filter((p) => p.stopped);
  expect(evicted).toHaveLength(2);
  evicted[0]?.releaseStop();
  await boot.settleAll(ids);
  expect(boot.startOrder().slice(3)).toEqual([d]);
  expect((await boot.rt(e)).live().status).toBe("queued");
  evicted[1]?.releaseStop();
  await boot.settleAll(ids);
  expect(boot.startOrder().slice(3)).toEqual([d, e]);
  expect(boot.runtimes.supervisor.running()).toEqual({ count: 3, max: 3 });
});

test("a reap that fails keeps the agent's journal and doesn't wake it", async () => {
  const failed = await agent();
  const reaped = await agent();
  const gone = (pid: number) => ({ pid, start: "Thu Jan 1 00:00:00 1970" });
  await setJournal(failed, { claude: gone(999_998), tasks: [], crons: [] });
  await setJournal(reaped, { claude: gone(999_999), tasks: [], crons: [] });
  await pending(failed, "waiting");
  await pending(reaped, "waiting too");
  boot = new Boot();
  const journal = new ProcessJournal({ sleep: async () => {} });
  const reap = journal.reap.bind(journal);
  journal.reap = async (j) => {
    if (j.claude?.pid === 999_998) throw new Error("ps failed");
    return reap(j);
  };
  await boot.run(journal);
  await boot.settleAll([failed, reaped]);
  expect((await row(failed)).runtimeJournal?.claude).toEqual(gone(999_998));
  expect((await row(reaped)).runtimeJournal).toBeNull();
  expect(boot.starts(failed)).toHaveLength(0);
  expect(boot.starts(reaped)).toHaveLength(1);
  expect(boot.logs).toContainEqual({
    level: "error",
    msg: "reaping the previous run's processes failed; the agent isn't woken",
  });
});

/** A spawned agent (reporting to a fresh manager) whose termination by `@lead` committed before the server stopped. */
async function terminatedAgent(): Promise<string> {
  const lead = await agent();
  n += 1;
  const id = `r${n}`;
  await insertAgent(t.sql, { id, slug: `rec${n}`, reportsTo: lead, terminatedAt: new Date() });
  await t.sql`update agents set terminated_by = '@lead' where id = ${id}`;
  return id;
}
const putContainer = (b: Boot, name: string, agentId: string, running: boolean) =>
  b.docker.containers.set(name, {
    id: name,
    name,
    running,
    labels: { [LABEL_AGENT_ID]: agentId },
    opts: {},
  });

test("S7 §12: a terminated agent's leftovers are removed and reaped; it is never woken, noticed or forwarded", async () => {
  const live = await agent();
  const id = await terminatedAgent();
  const claude = sleeper();
  // Everything a crash (or a shutdown racing the termination) can leave behind.
  await setJournal(id, {
    claude,
    tasks: [{ taskId: "t1", description: "pnpm test" }],
    crons: [],
  });
  await openTurn(id);
  await t.sql`update agents set attempting = true, rate_limit_notice_owed = true where id = ${id}`;
  await store.pauseCredential(`cred-${id}`, new Date(Date.now() - 60_000), false);
  // Rows that raced in during the crash window: a message and a young member update.
  await pending(id, "raced in");
  await store.createHeld({ kind: "member_update", toAgentId: id, fromAgentId: live, body: "b" });
  boot = new Boot();
  putContainer(boot, "term-running", id, true);
  putContainer(boot, "term-stopped", id, false);
  putContainer(boot, "live-running", live, true);
  await boot.run();
  await exited(children[0] as ChildProcess);

  // Step 2: both of its containers removed (not stopped); a live agent's still only stopped.
  const ops = boot.docker.calls.filter((c) => c.op === "remove" || c.op === "stop");
  expect(ops.filter((c) => c.op === "remove").map((c) => c.args[0])).toEqual(
    expect.arrayContaining(["term-running", "term-stopped"]),
  );
  expect(ops.filter((c) => c.op === "remove")).toHaveLength(2);
  expect(ops.filter((c) => c.op === "stop").map((c) => c.args[0])).toEqual(["live-running"]);
  expect(boot.docker.containers.has("term-running")).toBe(false);
  expect(boot.docker.containers.has("term-stopped")).toBe(false);
  // Step 1: its local Claude reaped, without a `reconciled` event; the journal is cleared.
  expect(alive(claude.pid)).toBe(false);
  expect((await row(id)).runtimeJournal).toBeNull();
  // The missing `terminated` event, by whoever terminated it, and nothing else.
  expect(await events(id)).toEqual([{ type: "terminated", by: "@lead" }]);
  // Steps 3–6 skip it: not errored, no notice, no continue notice, nothing forwarded, never loaded or woken.
  expect((await row(id)).status).not.toBe("errored");
  expect((await row(id)).errorKind).toBeNull();
  expect(boot.forwarded).toEqual([]);
  await vi.waitFor(async () => {
    const [c] = await t.sql`select rate_limited_until from credentials where id = ${`cred-${id}`}`;
    expect(c?.rate_limited_until).toBeNull();
  });
  expect(await notices(id)).toEqual([]);
  // The rows that raced in are rejected, not left pending.
  expect(
    await t.sql`select kind, state from messages where to_agent_id = ${id} order by created_at`,
  ).toEqual([
    { kind: "message", state: "rejected" },
    { kind: "member_update", state: "rejected" },
  ]);
  expect(await boot.runtimes.get(id)).toBeUndefined();
  expect(boot.starts(id)).toHaveLength(0);
  // The stale `attempting` on its row is inert: no attempt was cut short, nothing errored, and loading it starts
  // nothing.
  expect(await row(id)).toMatchObject({ attempting: true, status: "hibernated", lastError: null });
  const rt = await boot.runtimes.load(id);
  await rt?.settled();
  expect(boot.starts(id)).toHaveLength(0);
  expect(rt?.live().status).toBe("terminated");
});

test("S7 §8: a failed removal of a terminated agent's container makes it stop_failed for the sweep", async () => {
  const id = await terminatedAgent();
  boot = new Boot();
  putContainer(boot, "term", id, false);
  boot.docker.removeError = new Error("device busy");
  await boot.run();
  expect((await row(id)).errorKind).toBe("stop_failed");
  expect(boot.logs).toContainEqual({
    level: "error",
    msg: "removing a terminated agent's leftover container failed; the sweep retries",
  });
  expect(boot.forwarded).toEqual([]);
});

/** A terminated Docker agent's leftover container, under the name the runtime's removal looks it up by. */
async function dockerLeftover(b: Boot, id: string, running: boolean): Promise<string> {
  await t.sql`update agents set runtime = 'docker' where id = ${id}`;
  const name = containerName((await row(id)).slug, id);
  putContainer(b, name, id, running);
  return name;
}

test("S7 §8: Docker unreachable at boot: the crash-window agent is stop_failed; the next sweep that lists Docker removes every leftover", async () => {
  // Crashed between the commit and the stop job (no event), and between the event and the removal.
  const noEvent = await terminatedAgent();
  const evented = await terminatedAgent();
  await store.append(evented, null, { type: "terminated", by: "@lead" });
  // Long ago: past the stuck query's recent window, so only the container list can find it.
  await t.sql`update agents set terminated_at = now() - interval '30 days' where id = ${evented}`;
  boot = new Boot(8, { dockerRuntime: true });
  const a = await dockerLeftover(boot, noEvent, true);
  const b = await dockerLeftover(boot, evented, false);
  boot.docker.down = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  await boot.run();
  expect(await row(noEvent)).toMatchObject({ errorKind: "stop_failed", status: "errored" });
  expect((await row(evented)).errorKind).toBeNull(); // not in the crash window: the sweep's list finds it
  expect(await events(noEvent)).toEqual([{ type: "terminated", by: "@lead" }]);

  // A sweep while Docker is still down: nothing is removed, and the stop_failed agent stays stuck.
  await boot.reaper().run();
  expect(boot.docker.containers.has(a)).toBe(true);
  expect((await row(noEvent)).errorKind).toBe("stop_failed");

  boot.docker.down = undefined;
  await boot.reaper().run();
  expect(boot.docker.containers.has(a)).toBe(false);
  expect(boot.docker.containers.has(b)).toBe(false);
  for (const id of [noEvent, evented]) {
    expect(await row(id)).toMatchObject({ errorKind: null, status: "hibernated" });
    expect(await events(id)).toEqual([
      { type: "terminated", by: "@lead" },
      { type: "cleanup", container: "removed" },
    ]);
  }
  expect(boot.runtimes.supervisor.running().count).toBe(0);
  expect(boot.forwarded).toEqual([]);
});

test("S7 §10.3: the sweep finds a long-terminated agent's leftover container without loading other long-terminated agents", async () => {
  const leaky = await terminatedAgent();
  const clean = await terminatedAgent();
  for (const id of [leaky, clean])
    await store.append(id, null, { type: "terminated", by: "@lead" });
  await t.sql`update agents set terminated_at = now() - interval '30 days' where id in (${leaky}, ${clean})`;
  boot = new Boot(8, { dockerRuntime: true });
  const name = await dockerLeftover(boot, leaky, false);
  await boot.reaper().run();
  expect(boot.docker.containers.has(name)).toBe(false);
  expect(await boot.runtimes.get(leaky)).toBeDefined();
  expect(await boot.runtimes.get(clean)).toBeUndefined();
});

test("S7 §8: the terminated-event lookups use the partial index, not the agent's whole log", async () => {
  const id = await terminatedAgent();
  // A long log with no `terminated` event: reading it would be the cost the index avoids.
  await t.sql`insert into session_events (agent_id, seq, type, payload)
              select ${id}, g, 'text', '{}'::jsonb from generate_series(1, 5000) g`;
  await t.sql`analyze session_events`;
  const plan = async (q: string) =>
    (await t.sql.unsafe(`explain ${q}`)).map((r) => String(r["QUERY PLAN"])).join("\n");
  // The statements `terminatedWithoutEvent` and `hasTerminatedEvent` send.
  const boot = await plan(
    `select id from agents where terminated_at is not null and not exists (select 1 from session_events e where e.agent_id = agents.id and e.type = 'terminated')`,
  );
  const one = await plan(
    `select id from session_events where agent_id = '${id}' and type = 'terminated' limit 1`,
  );
  expect(boot).toContain("session_events_terminated_idx");
  expect(one).toContain("session_events_terminated_idx");
});

test("S7 §8: a terminated event lost in the crash window is appended once: not again by a second boot or the sweep", async () => {
  const id = await terminatedAgent();
  const recorded = await terminatedAgent();
  await store.append(recorded, null, { type: "terminated", by: "@lead" });
  boot = new Boot();
  await boot.run();
  expect(await events(id)).toEqual([{ type: "terminated", by: "@lead" }]);
  expect(await events(recorded)).toEqual([{ type: "terminated", by: "@lead" }]);
  await boot.runtimes.close();

  boot = new Boot();
  await boot.run();
  // The sweep run at the end of boot (spec §10.3) also ensures the event: still exactly one.
  await boot.reaper().run();
  expect(await events(id)).toEqual([{ type: "terminated", by: "@lead" }]);
  expect(await events(recorded)).toEqual([{ type: "terminated", by: "@lead" }]);
});

test("S7 §8: a runtime loaded for a terminated agent rejects rows still pending to it and never queues them", async () => {
  const id = await terminatedAgent();
  boot = new Boot();
  await boot.run();
  // A row that got past the boot's rejection (committed after it).
  await pending(id, "late");
  const rt = await boot.runtimes.load(id);
  expect(rt?.queueItems()).toEqual([]);
  expect(await t.sql`select state from messages where to_agent_id = ${id}`).toEqual([
    { state: "rejected" },
  ]);
  await rt?.settled();
  expect(boot.starts(id)).toHaveLength(0);
});

test("S6 §17.2: boot wakes only for due member updates and loads agents with young ones, whose timer wakes them", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.now() + 60_000 });
  try {
    const report = await agent();
    const young = await agent();
    const due = await agent();
    const update = (to: string) =>
      store.createHeld({ kind: "member_update", toAgentId: to, fromAgentId: report, body: "b" });
    await update(due);
    vi.setSystemTime(Date.now() + 31_000);
    await update(young);
    boot = new Boot();
    await boot.run();
    await boot.settleAll([young, due]);
    expect(boot.startOrder()).toEqual([due]);
    const rt = await boot.runtimes.get(young);
    expect(rt?.queueItems()).toEqual([
      expect.objectContaining({ kind: "held", waitReason: "window", count: 1 }),
    ]);
    await vi.advanceTimersByTimeAsync(29_000);
    await boot.settleAll([young]);
    expect(boot.starts(young)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_500);
    await boot.settleAll([young]);
    expect(boot.starts(young)).toHaveLength(1);
    expect(boot.starts(young)[0]?.sent[0]?.map((m) => m.kind)).toEqual(["member_update"]);
  } finally {
    vi.useRealTimers();
  }
});

test("boot clears write marks left on pending rows, so a firing replaces the row again; delivered rows keep theirs", async () => {
  const id = await agent({ status: "errored" });
  await insertSchedule(t.sql, { id: "sch1", targetAgentId: id, cron: "0 9 * * *" });
  await insertScheduledMessage(t.sql, { id: "pm", toAgentId: id, scheduleId: "sch1", firings: 1 });
  await t.sql`update messages set delivered_event_seq = 4 where id = 'pm'`;
  await insertSchedule(t.sql, { id: "sch2", targetAgentId: id, cron: "0 9 * * *" });
  await insertScheduledMessage(t.sql, {
    id: "dm",
    toAgentId: id,
    scheduleId: "sch2",
    state: "delivered",
  });
  await t.sql`update messages set delivered_event_seq = 9 where id = 'dm'`;
  boot = new Boot();
  const schedules = new ScheduleStore();
  const [before] = await t.sql`select delivered_event_seq from messages where id = 'pm'`;
  expect(before?.delivered_event_seq).toBe(4);
  await boot.run();
  const [pm] =
    await t.sql`select state, delivered_event_seq, delivered_turn_id from messages where id = 'pm'`;
  expect(pm).toEqual({ state: "pending", delivered_event_seq: null, delivered_turn_id: null });
  const [dm] = await t.sql`select delivered_event_seq from messages where id = 'dm'`;
  expect(dm?.delivered_event_seq).toBe(9);
  // the next firing replaces the pending row (it would have written nothing while the mark was set)
  const [sched] = await t.sql`select * from schedules where id = 'sch1'`;
  const row = {
    id: "sch1",
    targetAgentId: id,
    body: "later",
    bodyAuthorUserId: "u1",
    bodyAuthorAgentId: null,
  };
  void sched;
  const written = await t.db.transaction((tx) =>
    schedules.upsertFiring(tx, {
      schedule: row as never,
      due: new Date(),
      missed: 1,
      late: false,
      now: new Date(),
    }),
  );
  expect(written).toBe("pm");
  const [after] = await t.sql`select firings, body from messages where id = 'pm'`;
  expect(after).toEqual({ firings: 2, body: "later" });
});
