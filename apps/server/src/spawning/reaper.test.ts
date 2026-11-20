import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentRow, schema } from "@open-factory/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AgentRuntime } from "../agents/agent-runtime.ts";
import { ev, FakeDriver, type FakeProcess } from "../agents/testing/fake-driver.ts";
import { insertAgent } from "../agents/testing/rows.ts";
import { sendAs } from "../agents/testing/runtime-harness.ts";
import { makeTestApp } from "../test/helpers.ts";
import { agentStateDir } from "../workspace/paths.ts";
import { SWEEP_INTERVAL_MS } from "./lifecycle.ts";
import { Reaper } from "./reaper.ts";

/** S7 §10: the sweep over the assembled app (fake driver, real Postgres), its clock injected. */
type T = Awaited<ReturnType<typeof makeTestApp>>;
let t: T | undefined;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await t?.close();
  t = undefined;
});

const day = 24 * 3_600_000;
/** The reaper's wall clock, moved by each test (activity rows are stamped with the real clock at first). */
let now = Date.now();
beforeEach(() => {
  now = Date.now();
});

const writeTemplate = (home: string, name: string, y: string) => {
  const d = path.join(home, "templates", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "template.yaml"), y);
  writeFileSync(path.join(d, "AGENTS.md"), `# ${name}\n`);
};

interface Child {
  id: string;
  slug: string;
  rt: AgentRuntime;
  proc: FakeProcess;
}

/** A spawner `lead` that may spawn `dev` (local), one running slot, and a reaper on the injected clock. */
async function setup(o: { maxRunning?: number } = {}) {
  const driver = new FakeDriver();
  t = await makeTestApp({
    harnessDriver: driver,
    env: { FACTORY_MAX_RUNNING_AGENTS: String(o.maxRunning ?? 1) },
  });
  const app = t;
  writeTemplate(app.factoryHome, "dev", "name: dev\ndisplay_name: Dev\nruntime: local\n");
  const lead = await app.seedAgent({
    slug: "lead",
    config: { canSpawn: ["dev"], maxLiveSpawns: 10 },
  });
  const { user } = await app.signUpUser();
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const reaper = new Reaper({
    store: app.app.store,
    runtimes: app.app.runtimes,
    terminator: app.app.terminator,
    workspace: app.app.workspace,
    log,
    now: () => now,
  });
  const human = (rt: AgentRuntime, body: string) =>
    sendAs(app.app.store, rt, { fromUserId: user.id, body, urgent: false });
  const procsOf = (id: string) => driver.starts.filter((p) => p.spec.agentId === id);

  /** Spawns `dev-<suffix>`, lets its brief start it, and ends its first turn: a started, idle (warm) child. */
  async function spawnIdle(suffix: string): Promise<Child> {
    const r = await app.app.spawner.spawn(
      lead.id,
      { template: "dev", description: "Does the work", prompt: "Do it", suffix },
      null,
    );
    if (!r.ok) throw new Error(r.message);
    const rt = await app.app.runtimes.load(r.agentId);
    if (!rt) throw new Error("no runtime");
    await rt.settled();
    const proc = procsOf(r.agentId).at(-1) as FakeProcess;
    proc.emit(...ev.fullTurn(`sess-${suffix}`));
    await rt.settled();
    return { id: r.agentId, slug: r.slug, rt, proc };
  }
  /** Spawned, then hibernated: no process, no slot. */
  async function spawnHibernated(suffix: string): Promise<Child> {
    const c = await spawnIdle(suffix);
    expect(await c.rt.hibernate("warm_window")).toBe(true);
    await c.rt.settled();
    expect(c.proc.exited).toBe(true);
    return c;
  }
  /** Spawned, crashed mid-turn, and its recovery attempt crashed too: errored, no process. */
  async function spawnErrored(suffix: string): Promise<Child> {
    const c = await spawnIdle(suffix);
    c.proc.emit(ev.turn());
    await c.rt.settled();
    c.proc.exit(137);
    await c.rt.settled();
    const attempt = procsOf(c.id).at(-1) as FakeProcess;
    expect(attempt).not.toBe(c.proc);
    attempt.exit(137);
    await c.rt.settled();
    expect(c.rt.live().status).toBe("errored");
    expect(procsOf(c.id).filter((p) => !p.exited)).toEqual([]);
    return c;
  }
  const row = async (id: string) => (await app.app.store.agentById(id)) as AgentRow;
  const terminatedBy = async (id: string) => (await row(id)).terminatedBy;
  return {
    t: app,
    driver,
    lead,
    user,
    log,
    reaper,
    human,
    procsOf,
    spawnIdle,
    spawnHibernated,
    spawnErrored,
    row,
    terminatedBy,
  };
}
type S = Awaited<ReturnType<typeof setup>>;

/** Awaits every `setLastActivity` write the runtime fired so far (they are fire-and-forget). */
async function activityWrites(spy: { mock: { results: { value: unknown }[] } }) {
  await Promise.all(spy.mock.results.map((r) => r.value));
}

test("reaps a hibernated and an errored child after the TTL (by @factory)", async () => {
  const s = await setup();
  const a = await s.spawnHibernated("a");
  const b = await s.spawnErrored("b");
  now = Date.now() + 3 * day - 60_000; // not yet
  await s.reaper.run();
  expect(await s.terminatedBy(a.id)).toBeNull();
  now += 2 * 60_000;
  await s.reaper.run();
  expect(await s.terminatedBy(a.id)).toBe("@factory");
  expect(await s.terminatedBy(b.id)).toBe("@factory");
  await a.rt.settled();
  await b.rt.settled();
  for (const c of [a, b]) {
    expect(c.rt.live().status).toBe("terminated");
    const evs = (await s.t.app.store.after(c.id, 0, 1000)).map((e) => e.event);
    expect(evs.filter((e) => e.type === "terminated")).toEqual([
      { type: "terminated", by: "@factory" },
    ]);
  }
});

const neverReaped: [string, (s: S) => Promise<Child>][] = [
  ["warm (process running)", (s) => s.spawnIdle("w")],
  [
    "busy (background task)",
    async (s) => {
      const c = await s.spawnIdle("bg");
      c.proc.emit(ev.background([{ taskId: "t1", description: "build" }]));
      await c.rt.settled();
      return c;
    },
  ],
  [
    "cron-pinned",
    async (s) => {
      const c = await s.spawnIdle("cr");
      c.proc.emit(ev.cron("cron-1"));
      await c.rt.settled();
      return c;
    },
  ],
  [
    "queued",
    async (s) => {
      const c = await s.spawnHibernated("q");
      // The spawner takes the only slot (started, no session yet: not evictable); the child's wake waits for it.
      const lead = await s.t.app.runtimes.load(s.lead.id);
      if (!lead) throw new Error("no lead runtime");
      await s.human(lead, "keep busy");
      await lead.settled();
      await s.human(c.rt, "hi");
      expect(s.t.app.runtimes.supervisor.isQueued(c.id)).toBe(true);
      return c;
    },
  ],
  [
    "owed a continue notice",
    async (s) => {
      const c = await s.spawnHibernated("ow");
      await s.t.app.store.setNoticeOwed(c.id, true);
      return c;
    },
  ],
  [
    "on a paused credential",
    async (s) => {
      const c = await s.spawnHibernated("pc");
      // Paused past the reaper's (moved) clock: a pause can outlast the TTL.
      await s.t.app.store.pauseCredential(
        c.rt.agent.credentialId ?? "",
        new Date(now + 4 * day),
        true,
      );
      return c;
    },
  ],
];

test.each(neverReaped)("never reaps a child that is %s", async (_n, make) => {
  const s = await setup();
  const c = await make(s);
  now = Date.now() + 3 * day + 1;
  await s.reaper.run();
  expect(await s.terminatedBy(c.id)).toBeNull();
  expect(c.rt.isTerminated()).toBe(false); // no latch left behind either
});

test("recent activity (a process start, a turn end) resets the clock", async () => {
  const s = await setup();
  const c = await s.spawnHibernated("r");
  const old = new Date(Date.now() - 4 * day);
  await s.t.db.update(schema.agents).set({ lastActivityAt: old }).where(eq(schema.agents.id, c.id));
  const writes = vi.spyOn(s.t.app.store, "setLastActivity");
  await s.human(c.rt, "more work");
  await c.rt.settled();
  const proc = s.procsOf(c.id).at(-1) as FakeProcess;
  proc.emit(ev.session("sess-r"));
  await c.rt.settled();
  await activityWrites(writes);
  const started = (await s.row(c.id)).lastActivityAt;
  expect(started.getTime()).toBeGreaterThan(old.getTime()); // process_started moved it
  proc.emit(ev.turn(), ev.usage(), ev.end());
  await c.rt.settled();
  await activityWrites(writes);
  expect((await s.row(c.id)).lastActivityAt.getTime()).toBeGreaterThanOrEqual(started.getTime());
  expect(writes.mock.calls.length).toBeGreaterThanOrEqual(3); // start, delivery, turn end
  expect(await c.rt.hibernate("warm_window")).toBe(true);
  await c.rt.settled();
  // Now idle and hibernated, but recently active: three days from the old stamp, not from now.
  now = old.getTime() + 3 * day + 60_000;
  await s.reaper.run();
  expect(await s.terminatedBy(c.id)).toBeNull();
});

test("last_activity_at never moves backwards when an older write lands last", async () => {
  const s = await setup();
  const c = await s.spawnHibernated("m");
  const newer = new Date(Date.now() + 60_000);
  const older = new Date(Date.now() - day);
  await s.t.app.store.setLastActivity(c.id, newer);
  await s.t.app.store.setLastActivity(c.id, older);
  expect((await s.row(c.id)).lastActivityAt.getTime()).toBe(newer.getTime());
});

/** Wraps the terminator: `during` runs inside the window between the reaper's latch and the transaction. */
function duringTermination(s: S, during: () => Promise<void>) {
  const original = s.t.app.terminator.terminate.bind(s.t.app.terminator);
  return vi
    .spyOn(s.t.app.terminator, "terminate")
    .mockImplementation(async (...a: Parameters<typeof original>) => {
      await during();
      return original(...a);
    });
}

test("a wake requested right after the check can't start a process (latch); a failing transaction unlatches", async () => {
  const s = await setup();
  const c = await s.spawnHibernated("l");
  const startsBefore = s.procsOf(c.id).length;
  duringTermination(s, async () => {
    expect(c.rt.isTerminated()).toBe(true); // latched inside the check job
    await s.human(c.rt, "are you there?");
    await c.rt.settled();
    expect(s.procsOf(c.id)).toHaveLength(startsBefore); // queued, no wake
  });
  vi.spyOn(s.t.app.store, "terminateRows").mockRejectedValueOnce(
    new Error("the database went away"),
  );
  now = Date.now() + 3 * day + 1;
  await s.reaper.run();
  expect(s.log.error).toHaveBeenCalledWith(
    expect.objectContaining({ agent: c.slug }),
    "terminating an idle spawned agent failed; retrying next sweep",
  );
  expect(await s.terminatedBy(c.id)).toBeNull();
  expect(c.rt.isTerminated()).toBe(false);
  await c.rt.settled();
  // What arrived in the window is delivered normally.
  const proc = s.procsOf(c.id).at(-1) as FakeProcess;
  expect(s.procsOf(c.id)).toHaveLength(startsBefore + 1);
  expect(proc.sent.flat().map((m) => m.body)).toContain("are you there?");
});

test("a failed TTL termination undoes only its own latch: another termination's survives", async () => {
  const s = await setup();
  const c = await s.spawnHibernated("k");
  // Another termination (a human's) latches provisionally while the reaper's is in flight.
  duringTermination(s, async () => c.rt.markTerminated({ committed: false }));
  vi.spyOn(s.t.app.store, "terminateRows").mockRejectedValueOnce(
    new Error("the database went away"),
  );
  now = Date.now() + 3 * day + 1;
  await s.reaper.run();
  expect(await s.terminatedBy(c.id)).toBeNull();
  expect(c.rt.isTerminated()).toBe(true); // the human's latch still holds
  c.rt.unmarkTerminated(); // the human's transaction fails too
  expect(c.rt.isTerminated()).toBe(false);
});

test("workspace deleted after the grace, not when pinned; unpin after grace deletes at the next run; a planted symlink is removed as a link", async () => {
  const s = await setup();
  const a = await s.spawnHibernated("a");
  const b = await s.spawnHibernated("b");
  for (const c of [a, b]) await s.t.app.terminator.terminate(c.id, "@or");
  await a.rt.settled();
  await b.rt.settled();
  const ws = s.t.app.workspace;
  const outside = mkdtempSync(path.join(tmpdir(), "of-outside-"));
  writeFileSync(path.join(outside, "keep.txt"), "not the agent's");
  symlinkSync(outside, path.join(ws.workdir(a.slug), "planted"));
  const stateA = agentStateDir(s.t.factoryHome, a.slug);
  expect(existsSync(stateA)).toBe(true);
  await s.t.app.store.setWorkspacePinned(b.id, true);

  now = Date.now() + 3 * day - 60_000; // inside the grace
  await s.reaper.run();
  expect(existsSync(ws.workdir(a.slug))).toBe(true);

  now += 2 * 60_000; // past it
  await s.reaper.run();
  expect(existsSync(ws.workdir(a.slug))).toBe(false);
  expect(existsSync(stateA)).toBe(false);
  expect(existsSync(path.join(outside, "keep.txt"))).toBe(true); // the link went, not its target
  expect((await s.row(a.id)).workspaceDeletedAt).toEqual(new Date(now));
  expect(existsSync(ws.workdir(b.slug))).toBe(true); // pinned
  expect((await s.row(b.id)).workspaceDeletedAt).toBeNull();

  await s.t.app.store.setWorkspacePinned(b.id, false);
  now += SWEEP_INTERVAL_MS;
  await s.reaper.run();
  expect(existsSync(ws.workdir(b.slug))).toBe(false);
  expect((await s.row(b.id)).workspaceDeletedAt).toEqual(new Date(now));
});

test("a pin taken while the deletion waits for the workspace lock keeps the workspace", async () => {
  const s = await setup();
  const c = await s.spawnHibernated("p");
  await s.t.app.terminator.terminate(c.id, "@or");
  await c.rt.settled();
  const ws = s.t.app.workspace;
  // The pin route's shape (Task 16): under the same lock, set the pin.
  let pinned!: () => void;
  const pinning = new Promise<void>((r) => {
    pinned = r;
  });
  let releasePin!: () => void;
  const held = ws.lock.run(c.slug, async () => {
    pinned();
    await new Promise<void>((r) => {
      releasePin = r;
    });
    await s.t.app.store.setWorkspacePinned(c.id, true);
  });
  await pinning;
  now = Date.now() + 3 * day + 1;
  const run = s.reaper.run(); // read the candidate unpinned; waits on the lock
  releasePin();
  await held;
  await run;
  expect(existsSync(ws.workdir(c.slug))).toBe(true);
  expect((await s.row(c.id)).workspaceDeletedAt).toBeNull();
});

test("a failing deletion is logged and retried by the next run", async () => {
  const s = await setup();
  const c = await s.spawnHibernated("f");
  await s.t.app.terminator.terminate(c.id, "@or");
  await c.rt.settled();
  vi.spyOn(s.t.app.workspace, "deleteWorkspace").mockRejectedValueOnce(
    new Error("EBUSY: resource busy or locked"),
  );
  now = Date.now() + 3 * day + 1;
  await s.reaper.run();
  expect(s.log.error).toHaveBeenCalledWith(
    expect.objectContaining({ agent: c.slug }),
    "deleting a workspace failed; retrying next sweep",
  );
  expect(existsSync(s.t.app.workspace.workdir(c.slug))).toBe(true);
  expect((await s.row(c.id)).workspaceDeletedAt).toBeNull();
  await s.reaper.run();
  expect(existsSync(s.t.app.workspace.workdir(c.slug))).toBe(false);
  expect((await s.row(c.id)).workspaceDeletedAt).not.toBeNull();
});

test("stuck: a terminated stop_failed child is force-removed and its slot released; skipped while its stop is in progress", async () => {
  const s = await setup({ maxRunning: 2 });
  const release = vi.spyOn(s.t.app.runtimes.supervisor, "release");
  const releasesOf = (id: string) => release.mock.calls.filter(([a]) => a === id).length;

  // A stop in progress: never stuck, nothing done to it.
  const busy = await s.spawnIdle("s1");
  busy.proc.holdStop = true;
  await s.t.app.terminator.terminate(busy.id, "@or");
  await busy.rt.settled();
  expect(busy.proc.stopped).toBe(true);
  expect(await busy.rt.sweepStuck()).toBe("still");
  await s.reaper.run();
  expect(releasesOf(busy.id)).toBe(0);
  expect(busy.proc.forceKilled).toBe(false);
  busy.proc.releaseStop();
  await busy.rt.settled();
  expect(releasesOf(busy.id)).toBe(1);

  // stop_failed: its stop timed out and every escalation failed, the termination's too.
  const c = await s.spawnIdle("s2");
  c.proc.stopResult = { code: null, signal: null, timedOut: true };
  c.proc.emitExitOnStop = false;
  c.proc.forceKill = async () => {
    throw new Error("kill: operation not permitted");
  };
  expect(await c.rt.hibernate("warm_window")).toBe(true);
  await c.rt.settled();
  await s.t.app.terminator.terminate(c.id, "@or");
  await c.rt.settled();
  expect((await s.row(c.id)).errorKind).toBe("stop_failed");
  expect(c.proc.exited).toBe(false);
  expect(releasesOf(c.id)).toBe(0);

  // The sweep retries the escalation (it now works); the exit cleans up and gives the slot back.
  c.proc.forceKill = async () => {
    c.proc.forceKilled = true;
    c.proc.exit(137);
  };
  now += SWEEP_INTERVAL_MS;
  await s.reaper.run();
  await c.rt.settled();
  expect(c.proc.forceKilled).toBe(true);
  expect(c.proc.exited).toBe(true);
  expect(releasesOf(c.id)).toBe(1);
  const r = await s.row(c.id);
  expect(r.errorKind).toBeNull();
  expect(r.runtimeJournal).toBeNull();
  // Cleared: a later run leaves it alone (no second release), and its workspace becomes deletable.
  await s.reaper.run();
  expect(await c.rt.sweepStuck()).toBe("none");
  expect(releasesOf(c.id)).toBe(1);
  const evs = (await s.t.app.store.after(c.id, 0, 1000)).map((e) => e.event);
  expect(evs.filter((e) => e.type === "terminated")).toHaveLength(1);
});

test("a stuck agent's workspace is kept past the grace until it is cleared", async () => {
  const s = await setup();
  const c = await s.spawnIdle("k");
  c.proc.stopResult = { code: null, signal: null, timedOut: true };
  c.proc.emitExitOnStop = false;
  c.proc.forceKill = async () => {
    throw new Error("kill: operation not permitted");
  };
  await s.t.app.terminator.terminate(c.id, "@or");
  await c.rt.settled();
  expect((await s.row(c.id)).errorKind).toBe("stop_failed");
  now = Date.now() + 3 * day + 1;
  await s.reaper.run();
  await c.rt.settled();
  expect(existsSync(s.t.app.workspace.workdir(c.slug))).toBe(true);
  expect((await s.row(c.id)).workspaceDeletedAt).toBeNull();
});

test("the sweep appends a terminated event a crash after the commit lost", async () => {
  const s = await setup();
  const c = await s.spawnHibernated("e");
  // The commit happened (the row says so) but the stop job never ran.
  await s.t.db
    .update(schema.agents)
    .set({ terminatedAt: new Date(), terminatedBy: "@lead" })
    .where(eq(schema.agents.id, c.id));
  await s.reaper.run();
  const evs = (await s.t.app.store.after(c.id, 0, 1000)).map((e) => e.event);
  expect(evs.filter((e) => e.type === "terminated")).toEqual([{ type: "terminated", by: "@lead" }]);
  await s.reaper.run();
  const again = (await s.t.app.store.after(c.id, 0, 1000)).map((e) => e.event);
  expect(again.filter((e) => e.type === "terminated")).toHaveLength(1);
});

test("the stuck sweep is bounded: 50 long-terminated, cleanly removed agents load no runtime", async () => {
  const s = await setup();
  const ids: string[] = [];
  for (let i = 0; i < 50; i++) {
    const id = `gone-${i}`;
    ids.push(id);
    await insertAgent(s.t.sql, {
      id,
      slug: `gone-${i}`,
      reportsTo: s.lead.id,
      terminatedAt: new Date(now - day),
    });
  }
  const load = vi.spyOn(s.t.app.runtimes, "load");
  await s.reaper.run();
  expect(load.mock.calls.filter(([id]) => ids.includes(id))).toEqual([]);
  expect(await s.t.app.store.stuckCandidates(new Date(now - 2 * SWEEP_INTERVAL_MS))).toEqual([]);
});

test("stuck candidates: stop_failed, a kept journal, or a recent termination", async () => {
  const s = await setup();
  const at = (ms: number) => new Date(now - ms);
  const rows: [string, { errorKind?: string; journal?: boolean; terminatedAt: Date }][] = [
    ["stop-failed", { errorKind: "stop_failed", terminatedAt: at(day) }],
    ["journal", { journal: true, terminatedAt: at(day) }],
    ["recent", { terminatedAt: at(SWEEP_INTERVAL_MS) }],
    ["old-clean", { terminatedAt: at(day) }],
    ["old-errored", { errorKind: "crash", terminatedAt: at(day) }],
  ];
  for (const [id, r] of rows) {
    await insertAgent(s.t.sql, {
      id,
      slug: id,
      reportsTo: s.lead.id,
      terminatedAt: r.terminatedAt,
      errorKind: r.errorKind ?? null,
    });
    if (r.journal)
      await s.t
        .sql`update agents set runtime_journal = ${JSON.stringify({ tasks: [], crons: [] })}::jsonb where id = ${id}`;
  }
  const found = await s.t.app.store.stuckCandidates(new Date(now - 2 * SWEEP_INTERVAL_MS));
  expect(found.map((r) => r.id).sort()).toEqual(["journal", "recent", "stop-failed"]);
});

test("the interval runs every 10 minutes and stops on close", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const s = await setup();
  const run = vi.spyOn(s.t.app.reaper, "run").mockResolvedValue();
  vi.advanceTimersByTime(SWEEP_INTERVAL_MS - 1);
  expect(run).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(run).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
  expect(run).toHaveBeenCalledTimes(2);
  await s.t.app.close();
  vi.advanceTimersByTime(3 * SWEEP_INTERVAL_MS);
  expect(run).toHaveBeenCalledTimes(2);
});

test("a stopped reaper starts no run, and a run requested during one joins it", async () => {
  const s = await setup();
  const candidates = vi.spyOn(s.t.app.store, "ttlCandidates");
  await Promise.all([s.reaper.run(), s.reaper.run()]);
  expect(candidates).toHaveBeenCalledTimes(1);
  s.reaper.stop();
  await s.reaper.run();
  expect(candidates).toHaveBeenCalledTimes(1);
});
