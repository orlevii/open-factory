import type { ServerMessage } from "@open-factory/shared";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { AgentRuntime } from "../agents/agent-runtime.ts";
import { EventBus } from "../agents/event-bus.ts";
import { EventStore } from "../agents/event-store.ts";
import { ev, FakeDriver, type FakeProcess } from "../agents/testing/fake-driver.ts";
import { insertAgent } from "../agents/testing/rows.ts";
import { okSpec, silentLog } from "../agents/testing/runtime-harness.ts";
import { createTestDb } from "../test/helpers.ts";
import { Supervisor } from "./supervisor.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  await t.sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
});
afterAll(() => t.close());

let n = 0;

/** Real runtimes over one fake driver, all starting through one Supervisor. */
class World {
  readonly driver = new FakeDriver();
  readonly bus = new EventBus();
  readonly frames: ServerMessage[] = [];
  readonly loaded = new Map<string, AgentRuntime>();
  readonly pausedCredentials = new Set<string>();
  readonly sup: Supervisor;
  constructor(max: number) {
    this.bus.subscribeAll((m) => this.frames.push(m));
    this.sup = new Supervisor({
      max,
      runtimes: { get: (id) => this.loaded.get(id), all: () => this.loaded.values() },
      bus: this.bus,
      log: silentLog,
      credentialOf: (id) => this.loaded.get(id)?.agent.credentialId ?? "",
      paused: (c) => this.pausedCredentials.has(c),
    });
  }

  async agent(o: { pending?: string[]; status?: string } = {}): Promise<AgentRuntime> {
    n += 1;
    const id = `s${n}`;
    await insertAgent(t.sql, { id, slug: `sup${n}`, ...(o.status ? { status: o.status } : {}) });
    for (const body of o.pending ?? [])
      await store.createMessage({ fromUserId: "u1", toAgentId: id, body, urgent: false });
    const agent = await store.agentById(id);
    if (!agent) throw new Error("no agent");
    const rt = new AgentRuntime({
      agent,
      store,
      bus: this.bus,
      driver: this.driver,
      prepareStart: async (a) => okSpec(a),
      log: silentLog,
      slots: this.sup,
      credentialPaused: () => this.sup.pausedFor(id),
    });
    await rt.init();
    this.loaded.set(id, rt);
    return rt;
  }

  starts(rt: AgentRuntime): FakeProcess[] {
    return this.driver.starts.filter((p) => p.spec.agentId === rt.agent.id);
  }
  proc(rt: AgentRuntime): FakeProcess {
    const p = this.starts(rt).at(-1);
    if (!p) throw new Error(`${rt.agent.slug} never started`);
    return p;
  }

  /** Every runtime's jobs have run, including grant and hibernate jobs one agent enqueued on another. */
  async settleAll() {
    for (let i = 0; i < 4; i++) for (const rt of this.loaded.values()) await rt.settled();
  }

  async close() {
    this.sup.close();
    for (const p of this.driver.starts) p.releaseStop();
    await Promise.all([...this.loaded.values()].map((rt) => rt.stop({ graceMs: 0 })));
  }
}

let w: World;
afterEach(async () => {
  await w?.close();
});

const send = (rt: AgentRuntime, body: string) =>
  rt.sendMessage({ fromUserId: "u1", fromHandle: "or", body, urgent: false });
const status = (rt: AgentRuntime) => rt.live().status;
const started = (rt: AgentRuntime) => w.starts(rt).length > 0;
const stopped = (rt: AgentRuntime) => w.starts(rt).some((p) => p.stopped);
const lastEvent = async (rt: AgentRuntime) =>
  (await store.after(rt.agent.id, 0, 1000)).at(-1)?.event;

async function three(max = 2) {
  w = new World(max);
  return [await w.agent(), await w.agent(), await w.agent()] as const;
}
/** Started and mid-turn. */
async function busy(rt: AgentRuntime) {
  await send(rt, "work");
  w.proc(rt).emit(ev.session(), ev.turn());
  await w.settleAll();
}
/** Started and idle (hibernatable), last active at `at`. */
async function idleAt(rt: AgentRuntime, at: number) {
  await send(rt, "work");
  w.proc(rt).emit(...ev.fullTurn());
  await w.settleAll();
  expect(rt.hibernatable()).toBe(true);
  rt.lastActivityAt = at;
}
function endTurnAndExit(rt: AgentRuntime) {
  const p = w.proc(rt);
  p.emit(ev.end());
  p.exit(0);
}

test("third wake queues while two agents are mid-turn, starts when one exits", async () => {
  const [a, b, c] = await three();
  await busy(a);
  await busy(b);
  await send(c, "hi");
  expect(status(c)).toBe("queued");
  expect(started(c)).toBe(false);
  endTurnAndExit(a);
  await w.settleAll();
  expect(started(c)).toBe(true);
  expect(
    w
      .proc(c)
      .sent.flat()
      .map((m) => m.body),
  ).toEqual(["hi"]);
  expect(w.sup.isQueued(c.agent.id)).toBe(false);
  expect(w.sup.running()).toEqual({ count: 2, max: 2 });
});

test("with two idle-warm agents, the least recently active hibernates to free a slot", async () => {
  const [a, b, c] = await three();
  await idleAt(a, 1000);
  await idleAt(b, 2000);
  await send(c, "hi");
  await w.settleAll();
  expect(await lastEvent(a)).toMatchObject({ type: "hibernated", reason: "freed_slot" });
  expect(stopped(b)).toBe(false);
  expect(started(c)).toBe(true);
  expect(w.sup.running()).toEqual({ count: 2, max: 2 });
});

test("never evicts a busy, pinned or mid-turn agent", async () => {
  const [a, b, c] = await three(3);
  const d = await w.agent();
  await busy(a); // mid-turn
  await idleAt(b, 1000);
  w.proc(b).emit(ev.background([{ taskId: "t1" }])); // a live non-ambient task
  await idleAt(c, 1000);
  w.proc(c).emit(ev.cron("c1")); // pinned
  await w.settleAll();
  await send(d, "hi");
  await w.settleAll();
  expect([stopped(a), stopped(b), stopped(c)]).toEqual([false, false, false]);
  expect(started(d)).toBe(false);
  expect(status(d)).toBe("queued");
  // Once one of them becomes hibernatable, it is the one that goes.
  w.proc(b).emit(ev.background([]));
  await w.settleAll();
  expect(stopped(b)).toBe(true);
  expect(started(d)).toBe(true);
});

test("never evicts two agents for one queued entry", async () => {
  const [a, b, c] = await three();
  await idleAt(a, 1000);
  await idleAt(b, 2000);
  w.proc(a).holdStop = true; // a's stop grace is still running
  await send(c, "hi");
  await w.settleAll();
  expect(stopped(a)).toBe(true);
  // b turns hibernatable again while a's eviction is still on its way: it is not asked to go too.
  await send(b, "more");
  w.proc(b).emit(ev.turn(), ev.end());
  await w.settleAll();
  expect(b.hibernatable()).toBe(true);
  expect(stopped(b)).toBe(false);
  w.proc(a).releaseStop();
  await w.settleAll();
  expect(started(c)).toBe(true);
  expect(stopped(b)).toBe(false);
});

test("a cap lowered by config at boot with more queued than slots evicts only as many as the queue needs", async () => {
  // Four agents were warm before the restart; the cap is now 3. Boot wakes each with pending work.
  w = new World(3);
  const rts = [
    await w.agent({ pending: ["a1"] }),
    await w.agent({ pending: ["b1"] }),
    await w.agent({ pending: ["c1"] }),
    await w.agent({ pending: ["d1"] }),
  ];
  const [a, b, c, d] = rts as [AgentRuntime, AgentRuntime, AgentRuntime, AgentRuntime];
  // Not inline: the answer is never "granted", the grant job starts the agent in its own turn.
  expect(rts.map((rt) => w.sup.requestWake(rt.agent.id, "boot", false))).toEqual([
    "queued",
    "queued",
    "queued",
    "queued",
  ]);
  await w.settleAll();
  expect(rts.map(started)).toEqual([true, true, true, false]);
  expect(status(d)).toBe("queued");
  // All three finish their turn and turn hibernatable while the first eviction is still stopping.
  for (const rt of [a, b, c]) {
    w.proc(rt).holdStop = true;
    w.proc(rt).emit(...ev.fullTurn());
    await w.settleAll();
    expect(rt.hibernatable() || rt.isStopping()).toBe(true);
  }
  expect([a, b, c].map(stopped)).toEqual([true, false, false]);
  w.proc(a).releaseStop();
  await w.settleAll();
  expect(started(d)).toBe(true);
  expect([b, c].map(stopped)).toEqual([false, false]);
  expect(w.sup.running()).toEqual({ count: 3, max: 3 });
});

test("a victim that refuses is replaced by the next candidate", async () => {
  const [a, b, c] = await three();
  await idleAt(a, 1000);
  await idleAt(b, 2000);
  // A message reaches a between the pick and its hibernate job: a re-checks in its job and refuses.
  const original = a.hibernate.bind(a);
  vi.spyOn(a, "hibernate").mockImplementationOnce((reason) => {
    void send(a, "meanwhile");
    return original(reason);
  });
  await send(c, "hi");
  await w.settleAll();
  expect(a.hibernate).toHaveBeenCalledWith("freed_slot");
  expect(stopped(a)).toBe(false);
  expect(
    w
      .proc(a)
      .sent.flat()
      .map((m) => m.body),
  ).toContain("meanwhile");
  expect(await lastEvent(b)).toMatchObject({ type: "hibernated", reason: "freed_slot" });
  expect(started(c)).toBe(true);
});

test("dedupe: a second request keeps the original place", async () => {
  w = new World(1);
  const a = await w.agent();
  const b = await w.agent();
  const c = await w.agent();
  await busy(a);
  await send(b, "b1");
  await send(c, "c1");
  await send(b, "b2"); // b keeps its place ahead of c
  expect([status(b), status(c)]).toEqual(["queued", "queued"]);
  endTurnAndExit(a);
  await w.settleAll();
  expect(started(b)).toBe(true);
  expect(started(c)).toBe(false);
  expect(w.starts(b)).toHaveLength(1);
  expect(
    w
      .proc(b)
      .sent.flat()
      .map((m) => m.body),
  ).toEqual(["b1", "b2"]);
  expect(w.sup.isQueued(b.agent.id)).toBe(false);
  expect(w.sup.isQueued(c.agent.id)).toBe(true);
});

test("granted state closes the double-start window", async () => {
  w = new World(1);
  const a = await w.agent();
  const b = await w.agent();
  await busy(a);
  await send(b, "one");
  // When a's exit hands the slot to b, a send to b lands ahead of b's grant job.
  const original = b.grant.bind(b);
  let sendDuringGrant: Promise<unknown> | undefined;
  vi.spyOn(b, "grant").mockImplementationOnce((reason) => {
    sendDuringGrant = send(b, "two");
    return original(reason);
  });
  endTurnAndExit(a);
  await w.settleAll();
  await sendDuringGrant;
  await w.settleAll();
  expect(b.grant).toHaveBeenCalledTimes(1);
  expect(w.starts(b)).toHaveLength(1);
  expect(
    w
      .proc(b)
      .sent.flat()
      .map((m) => m.body),
  ).toEqual(["one", "two"]);
  expect(w.sup.isQueued(b.agent.id)).toBe(false); // the send saw the grant: no second entry
  expect(w.sup.running()).toEqual({ count: 1, max: 1 });
});

test("no grant without a deliverable item", async () => {
  w = new World(1);
  const a = await w.agent();
  expect(w.sup.requestWake(a.agent.id, "boot", false)).toBe("dropped");
  expect(w.sup.requestWake(a.agent.id, "queued_items", true)).toBe("dropped");
  await w.settleAll();
  expect(started(a)).toBe(false);
  expect(w.sup.isQueued(a.agent.id)).toBe(false);
  expect(w.sup.running().count).toBe(0);
});

test("an errored agent wakes only for crash recovery, restart, reset or a human's message", async () => {
  w = new World(2);
  const a = await w.agent({ pending: ["x"], status: "errored" });
  for (const r of ["boot", "boot_resume", "queued_items", "rate_limit_reset"] as const)
    expect(w.sup.requestWake(a.agent.id, r, false)).toBe("dropped");
  expect(w.sup.running().count).toBe(0);
  await send(a, "hello"); // a human's message
  await w.settleAll();
  expect(started(a)).toBe(true);
});

test("a paused credential's entry is skipped without losing its place", async () => {
  w = new World(1);
  const a = await w.agent();
  const b = await w.agent();
  const c = await w.agent();
  await busy(a);
  w.pausedCredentials.add(b.agent.credentialId);
  await send(b, "b1");
  await send(c, "c1");
  expect(w.sup.isQueued(b.agent.id)).toBe(true);
  endTurnAndExit(a);
  await w.settleAll();
  expect(started(c)).toBe(true);
  expect(started(b)).toBe(false);
  w.pausedCredentials.delete(b.agent.credentialId);
  w.sup.onCredentialReset(b.agent.credentialId);
  await w.settleAll();
  expect(started(b)).toBe(false); // still no free slot
  const d = await w.agent();
  await send(d, "d1"); // queued behind b
  w.proc(c).emit(ev.session(), ev.turn());
  endTurnAndExit(c);
  await w.settleAll();
  expect(started(b)).toBe(true);
  expect(started(d)).toBe(false);
});

test("a grant whose credential was paused since goes back to its place", async () => {
  w = new World(1);
  const a = await w.agent();
  const b = await w.agent();
  const c = await w.agent();
  await busy(a);
  await send(b, "b1");
  await send(c, "c1");
  // The pause lands between the grant (bookkeeping) and b's grant job.
  const original = b.grant.bind(b);
  vi.spyOn(b, "grant").mockImplementationOnce((reason) => {
    w.pausedCredentials.add(b.agent.credentialId);
    return original(reason);
  });
  endTurnAndExit(a);
  await w.settleAll();
  expect(started(b)).toBe(false);
  expect(started(c)).toBe(true);
  expect(w.sup.isQueued(b.agent.id)).toBe(true);
  expect(w.sup.running().count).toBe(1);
});

test("after close(), sends, warm timers and resets start nothing", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    w = new World(2);
    const a = await w.agent();
    const b = await w.agent();
    const c = await w.agent();
    await idleAt(a, Date.now()); // its warm timer is armed
    await idleAt(b, 1000);
    w.proc(b).holdStop = true;
    await send(c, "queued"); // b is evicted for c; its stop grace is still running
    await w.settleAll();
    expect(stopped(b)).toBe(true);
    expect(status(c)).toBe("queued");
    w.sup.close();
    expect(w.sup.closing()).toBe(true);
    expect(w.sup.isQueued(c.agent.id)).toBe(false);
    expect(status(c)).toBe("hibernated");
    expect(w.sup.requestWake(c.agent.id, "message", true)).toBe("dropped");
    w.proc(b).releaseStop(); // the freed slot goes to nobody
    await send(c, "after close");
    w.sup.onCredentialReset(c.agent.credentialId);
    await vi.advanceTimersByTimeAsync(71 * 60_000);
    await w.settleAll();
    expect(started(c)).toBe(false);
    expect(stopped(a)).toBe(false); // the latch cleared its warm timer
    expect(w.driver.starts).toHaveLength(2);
    expect(w.sup.running()).toEqual({ count: 1, max: 2 });
  } finally {
    vi.useRealTimers();
  }
});

test("running counts are published as supervisor frames", async () => {
  w = new World(2);
  const a = await w.agent();
  await busy(a);
  endTurnAndExit(a);
  await w.settleAll();
  const frames = w.frames.filter((f) => f.type === "supervisor");
  expect(frames).toEqual([
    { type: "supervisor", running: 1, max: 2 },
    { type: "supervisor", running: 0, max: 2 },
  ]);
});
