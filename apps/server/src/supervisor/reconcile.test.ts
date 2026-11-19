import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import type { RuntimeJournal } from "@open-factory/db";
import type { AnyEvent } from "@open-factory/shared";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import type { AgentRuntime } from "../agents/agent-runtime.ts";
import { EventBus } from "../agents/event-bus.ts";
import { EventStore } from "../agents/event-store.ts";
import { AgentRuntimes } from "../agents/runtimes.ts";
import { ev, FakeDriver, type FakeProcess } from "../agents/testing/fake-driver.ts";
import { insertAgent } from "../agents/testing/rows.ts";
import { noopTokens, okSpec, silentLog } from "../agents/testing/runtime-harness.ts";
import { ContainerManager, LABEL_AGENT_ID } from "../runtime/docker/containers.ts";
import { FakeDockerClient } from "../runtime/docker/testing/fake-docker.ts";
import { ProcessJournal } from "../runtime/local/journal.ts";
import { createTestDb } from "../test/helpers.ts";
import { ATTEMPT_CUT_SHORT, reconcile } from "./reconcile.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  await t.sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
});
afterAll(() => t.close());

/** One boot of the factory: real runtimes and Supervisor over the fake driver, and a fake Docker daemon. */
class Boot {
  readonly driver = new FakeDriver();
  readonly docker = new FakeDockerClient();
  readonly runtimes: AgentRuntimes;
  readonly logs: { level: string; msg: string }[] = [];
  readonly log = {
    debug: () => {},
    info: (_: object, msg: string) => this.logs.push({ level: "info", msg }),
    warn: (_: object, msg: string) => this.logs.push({ level: "warn", msg }),
    error: (_: object, msg: string) => this.logs.push({ level: "error", msg }),
  };
  constructor(max = 8) {
    this.runtimes = new AgentRuntimes({
      tokens: noopTokens,
      store,
      bus: new EventBus(),
      driver: this.driver,
      prepareStart: async (a) => okSpec(a),
      log: silentLog,
      maxRunningAgents: max,
    });
  }

  run(journal: ProcessJournal = new ProcessJournal({ sleep: async () => {} })) {
    return reconcile({
      store,
      journal,
      containers: new ContainerManager({ docker: this.docker, log: silentLog, uid: 501, gid: 20 }),
      supervisor: this.runtimes.supervisor,
      runtimes: this.runtimes,
      memberUpdateDebounceMs: 30_000,
      log: this.log,
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
  store.createMessage({ from: { userId: "u1" }, toAgentId: id, body, urgent: false });
const openTurn = (id: string) => store.openTurn(id);
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
  expect(boot.logs).toContainEqual({
    level: "info",
    msg: "background work lost; would notify the manager",
  });
});

test("an agent whose attempt was cut short is errored and not woken", async () => {
  const fresh = await agent();
  await t.sql`update agents set attempting = true where id = ${fresh}`;
  await store.createNotice({ toAgentId: fresh, notice: "crash", body: "crashed" });
  const resumeFailed = await agent({ status: "errored" });
  await t.sql`update agents set attempting = true, error_kind = 'resume', last_error = 'No conversation'
              where id = ${resumeFailed}`;
  await pending(resumeFailed, "hi");
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
  expect(boot.startOrder()).toEqual([a, b, c]);
  expect((await boot.rt(d)).live().status).toBe("queued");
  expect((await boot.rt(e)).live().status).toBe("queued");
  for (const id of [a, b, c]) (boot.starts(id)[0] as FakeProcess).emit(...ev.fullTurn());
  await boot.settleAll(ids);
  // Two idle holders are hibernated for the two waiting; the slots go to the queue in FIFO order.
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
