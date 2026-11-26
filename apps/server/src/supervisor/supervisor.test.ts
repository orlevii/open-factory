import type { ServerMessage } from "@open-factory/shared";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { AgentRuntime } from "../agents/agent-runtime.ts";
import { EventBus } from "../agents/event-bus.ts";
import { EventStore } from "../agents/event-store.ts";
import { liveCredentialId } from "../agents/live-credential.ts";
import { ev, FakeDriver, type FakeProcess } from "../agents/testing/fake-driver.ts";
import { insertAgent } from "../agents/testing/rows.ts";
import {
  deliverHuman,
  humanRow,
  noForward,
  noopTokens,
  okSpec,
  sendAs,
  silentLog,
} from "../agents/testing/runtime-harness.ts";
import { createTestDb } from "../test/helpers.ts";
import { principalSql, testRef } from "../test/principals.ts";
import { Supervisor } from "./supervisor.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  await t.sql.unsafe(principalSql("u1", "human", "or"));
  await t.sql`insert into users (id, name, email) values ('u1', 'Or', 'or@x.io')`;
});
afterAll(() => t.close());

let n = 0;

/** Real runtimes over one fake driver, all starting through one Supervisor. */
class World {
  readonly driver = new FakeDriver();
  readonly bus = new EventBus();
  readonly frames: ServerMessage[] = [];
  readonly loaded = new Map<string, AgentRuntime>();
  /** Agents moved to another credential (several agents sharing one). */
  readonly credentials = new Map<string, string>();
  readonly sup: Supervisor;
  constructor() {
    this.bus.subscribeAll((m) => this.frames.push(m));
    this.sup = new Supervisor({
      runtimes: { get: (id) => this.loaded.get(id), all: () => this.loaded.values() },
      bus: this.bus,
      log: silentLog,
      credentialOf: (id) =>
        this.credentials.get(id) ?? this.loaded.get(id)?.agent.credentialId ?? "",
      rateLimits: store,
      load: async (handle) => [...this.loaded.values()].find((rt) => rt.agent.handle === handle),
    });
  }

  async agent(
    o: { pending?: string[]; status?: string; errorKind?: string } = {},
  ): Promise<AgentRuntime> {
    n += 1;
    const id = `s${n}`;
    await insertAgent(t.sql, { id, handle: `sup${n}`, ...(o.status ? { status: o.status } : {}) });
    if (o.errorKind) await t.sql`update agents set error_kind = ${o.errorKind} where id = ${id}`;
    for (const body of o.pending ?? [])
      await store.createMessage({
        from: { userId: "u1" },
        toAgentId: id,
        recipientIds: [id],
        body,
        urgent: false,
      });
    const agent = await store.agentById(id);
    if (!agent) throw new Error("no agent");
    const rt = new AgentRuntime({
      tokens: noopTokens,
      forward: noForward,
      agent,
      store,
      bus: this.bus,
      driver: this.driver,
      prepareStart: async (a) => okSpec(a),
      log: silentLog,
      slots: this.sup,
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
    if (!p) throw new Error(`${rt.agent.handle} never started`);
    return p;
  }

  /** Every runtime's jobs have run, including grant and hibernate jobs one agent enqueued on another. */
  async settleAll() {
    for (let i = 0; i < 4; i++) for (const rt of this.loaded.values()) await rt.settled();
  }

  /** Pauses the credential for an hour (no reset fires during a test). */
  pause(credentialId: string) {
    this.sup.pause(credentialId, new Date(Date.now() + 3_600_000), true);
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
  sendAs(store, rt, { fromUserId: "u1", fromHandle: "or", body, urgent: false });
const status = (rt: AgentRuntime) => rt.live().status;
const started = (rt: AgentRuntime) => w.starts(rt).length > 0;
const stopped = (rt: AgentRuntime) => w.starts(rt).some((p) => p.stopped);
const lastEvent = async (rt: AgentRuntime) =>
  (await store.after(rt.agent.id, 0, 1000)).at(-1)?.event;

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

test("dedupe: a second request while a wake waits keeps one entry, and one start delivers both", async () => {
  w = new World();
  const a = await w.agent();
  w.pause(liveCredentialId(a.agent));
  await send(a, "a1");
  await send(a, "a2");
  expect(w.sup.isQueued(a.agent.id)).toBe(true);
  expect(started(a)).toBe(false);
  w.sup.onCredentialReset(liveCredentialId(a.agent));
  await w.settleAll();
  expect(w.starts(a)).toHaveLength(1);
  expect(
    w
      .proc(a)
      .sent.flat()
      .map((m) => m.body),
  ).toEqual(["a1", "a2"]);
  expect(w.sup.isQueued(a.agent.id)).toBe(false);
});

test("more agents than the old cap of 8 all start, and none is hibernated to make room", async () => {
  w = new World();
  const agents: AgentRuntime[] = [];
  for (let i = 0; i < 10; i++) agents.push(await w.agent());
  for (const rt of agents) await busy(rt);
  expect(agents.map(status)).toEqual(agents.map(() => "working"));
  expect(w.sup.running()).toEqual({ count: 10 });
  for (const rt of agents) expect(stopped(rt)).toBe(false);
  for (const rt of agents) {
    const events = (await store.after(rt.agent.id, 0, 1000)).map((e) => e.event.type);
    expect(events).not.toContain("hibernated");
  }
});

test("granted state closes the double-start window", async () => {
  w = new World();
  const b = await w.agent();
  w.pause(liveCredentialId(b.agent));
  await send(b, "one");
  // When the reset hands b its start, a send to b lands ahead of b's grant job.
  const original = b.grant.bind(b);
  let sendDuringGrant: Promise<unknown> | undefined;
  let statusWhileGranted: string | undefined;
  vi.spyOn(b, "grant").mockImplementationOnce((reason) => {
    statusWhileGranted = status(b);
    sendDuringGrant = send(b, "two");
    return original(reason);
  });
  const framesBefore = w.frames.length;
  w.sup.onCredentialReset(liveCredentialId(b.agent));
  await w.settleAll();
  await sendDuringGrant;
  await w.settleAll();
  expect(b.grant).toHaveBeenCalledTimes(1);
  // Granted counts as waiting: never a hibernated flicker between queued and working.
  expect(statusWhileGranted).toBe("queued");
  const bStatuses = w.frames
    .slice(framesBefore)
    .flatMap((f) =>
      f.type === "agent_status" && f.agent === testRef(b.agent.id) ? [f.status] : [],
    );
  expect(bStatuses).not.toContain("hibernated");
  expect(w.starts(b)).toHaveLength(1);
  expect(
    w
      .proc(b)
      .sent.flat()
      .map((m) => m.body),
  ).toEqual(["one", "two"]);
  expect(w.sup.isQueued(b.agent.id)).toBe(false); // the send saw the grant: no second entry
  expect(w.sup.running()).toEqual({ count: 1 });
});

test("an entry that can never start is dropped at once (archived while queued)", async () => {
  w = new World();
  const b = await w.agent();
  w.pause(liveCredentialId(b.agent));
  await send(b, "b1");
  expect(w.sup.isQueued(b.agent.id)).toBe(true);
  b.markArchived();
  expect(w.sup.isQueued(b.agent.id)).toBe(false);
  w.sup.onCredentialReset(liveCredentialId(b.agent));
  await w.settleAll();
  expect(started(b)).toBe(false);
});

test("no grant without a deliverable item", async () => {
  w = new World();
  const a = await w.agent();
  expect(w.sup.requestWake(a.agent.id, "boot", false)).toBe("dropped");
  expect(w.sup.requestWake(a.agent.id, "queued_items", true)).toBe("dropped");
  await w.settleAll();
  expect(started(a)).toBe(false);
  expect(w.sup.isQueued(a.agent.id)).toBe(false);
  expect(w.sup.running().count).toBe(0);
});

test("an errored agent wakes only for crash recovery, restart, reset or a human's message", async () => {
  w = new World();
  const a = await w.agent({ pending: ["x"], status: "errored" });
  for (const r of ["boot", "boot_resume", "queued_items", "rate_limit_reset"] as const)
    expect(w.sup.requestWake(a.agent.id, r, false)).toBe("dropped");
  expect(w.sup.running().count).toBe(0);
  await send(a, "hello"); // a human's message
  await w.settleAll();
  expect(started(a)).toBe(true);
});

test("stop_failed and resume_unrecoverable agents are dropped except for Restart or Start a new session", async () => {
  w = new World();
  const a = await w.agent({ pending: ["x"], status: "errored", errorKind: "stop_failed" });
  const b = await w.agent({ pending: ["x"], status: "errored", errorKind: "resume_unrecoverable" });
  for (const r of ["message", "crash_recovery", "reset"] as const)
    expect(w.sup.requestWake(a.agent.id, r, false)).toBe("dropped");
  for (const r of ["message", "crash_recovery", "restart"] as const)
    expect(w.sup.requestWake(b.agent.id, r, false)).toBe("dropped");
  await send(b, "hello"); // a human's message makes no attempt
  await w.settleAll();
  expect(started(b)).toBe(false);
  expect(w.sup.running().count).toBe(0);
});

test("a paused credential's wakes wait while other agents start; a reset starts each of them once", async () => {
  w = new World();
  const b = await w.agent();
  const c = await w.agent();
  const d = await w.agent();
  w.credentials.set(b.agent.id, "shared");
  w.credentials.set(d.agent.id, "shared");
  w.pause("shared");
  await send(d, "d1");
  await send(b, "b1");
  await send(c, "c1");
  expect(started(c)).toBe(true);
  expect([started(b), started(d)]).toEqual([false, false]);
  expect([w.sup.isQueued(d.agent.id), w.sup.isQueued(b.agent.id)]).toEqual([true, true]);
  w.sup.onCredentialReset("shared");
  await w.settleAll();
  expect([w.starts(b).length, w.starts(c).length, w.starts(d).length]).toEqual([1, 1, 1]);
});

test("a grant whose credential was paused since goes back to its place", async () => {
  w = new World();
  const b = await w.agent();
  w.pause(liveCredentialId(b.agent));
  await send(b, "b1");
  // The pause lands between the grant (bookkeeping) and b's grant job.
  const original = b.grant.bind(b);
  vi.spyOn(b, "grant").mockImplementationOnce((reason) => {
    w.pause(liveCredentialId(b.agent));
    return original(reason);
  });
  w.sup.onCredentialReset(liveCredentialId(b.agent));
  await w.settleAll();
  expect(started(b)).toBe(false);
  expect(w.sup.isQueued(b.agent.id)).toBe(true);
  expect(w.sup.running().count).toBe(0);
});

test("after close(), sends, warm timers and resets start nothing", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    w = new World();
    const a = await w.agent();
    const c = await w.agent();
    await idleAt(a, Date.now()); // its warm timer is armed
    w.pause(liveCredentialId(c.agent));
    await send(c, "queued");
    expect(status(c)).toBe("rate_limited");
    expect(w.sup.isQueued(c.agent.id)).toBe(true);
    w.sup.close();
    expect(w.sup.closing()).toBe(true);
    expect(w.sup.isQueued(c.agent.id)).toBe(false);
    expect(w.sup.requestWake(c.agent.id, "message", true)).toBe("dropped");
    await send(c, "after close");
    w.sup.onCredentialReset(liveCredentialId(c.agent));
    await vi.advanceTimersByTimeAsync(71 * 60_000);
    await w.settleAll();
    expect(started(c)).toBe(false);
    expect(stopped(a)).toBe(false); // the latch cleared its warm timer
    expect(w.driver.starts).toHaveLength(1);
    expect(w.sup.running()).toEqual({ count: 1 });
  } finally {
    vi.useRealTimers();
  }
});

test("running counts are published as supervisor frames", async () => {
  w = new World();
  const a = await w.agent();
  await busy(a);
  endTurnAndExit(a);
  await w.settleAll();
  const frames = w.frames.filter((f) => f.type === "supervisor");
  expect(frames).toEqual([
    { type: "supervisor", running: 1 },
    { type: "supervisor", running: 0 },
  ]);
});

test("a restart wake takes over a queued entry whose reason no longer wakes the agent", async () => {
  w = new World();
  const b = await w.agent({ pending: ["x"], status: "errored", errorKind: "crash" });
  w.pause(liveCredentialId(b.agent));
  expect(w.sup.requestWake(b.agent.id, "message", false)).toBe("queued");
  await b.restartNow({ by: "@or", force: false, changes: [], runtimeAllowed: true });
  expect(status(b)).toBe("rate_limited"); // the entry kept its place and is now the restart's wake
  w.sup.onCredentialReset(liveCredentialId(b.agent));
  await w.settleAll();
  expect(started(b)).toBe(true);
  expect(
    (await store.after(b.agent.id, 0, 1000)).filter((e) => e.event.type === "process_started"),
  ).toMatchObject([{ event: { reason: "restart" } }]);
});

test("a start granted for an older request before Restart began starts the restart", async () => {
  w = new World();
  const b = await w.agent({ pending: ["x"], status: "errored", errorKind: "crash" });
  w.pause(liveCredentialId(b.agent));
  expect(w.sup.requestWake(b.agent.id, "message", false)).toBe("queued");
  // The reset grants b its start for "message"; Restart lands ahead of b's grant job.
  const original = b.grant.bind(b);
  let restarting: Promise<unknown> | undefined;
  vi.spyOn(b, "grant").mockImplementationOnce((reason) => {
    restarting = b.restartNow({ by: "@or", force: false, changes: [], runtimeAllowed: true });
    return original(reason);
  });
  w.sup.onCredentialReset(liveCredentialId(b.agent));
  await w.settleAll();
  await restarting;
  await w.settleAll();
  expect(b.grant).toHaveBeenCalledWith("message");
  expect(w.starts(b)).toHaveLength(1);
  expect(
    (await store.after(b.agent.id, 0, 1000)).filter((e) => e.event.type === "process_started"),
  ).toMatchObject([{ event: { reason: "restart" } }]);
  expect(status(b)).toBe("working"); // attempting, started: not stuck
});
