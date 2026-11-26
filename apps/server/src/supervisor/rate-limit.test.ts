import { setTimeout as sleep } from "node:timers/promises";
import type { HarnessEvent } from "@open-factory/shared";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { AgentRuntime } from "../agents/agent-runtime.ts";
import { EventBus } from "../agents/event-bus.ts";
import { EventStore } from "../agents/event-store.ts";
import { liveCredentialId } from "../agents/live-credential.ts";
import { notices } from "../agents/notices.ts";
import { ev, FakeDriver, type FakeProcess } from "../agents/testing/fake-driver.ts";
import { insertAgent } from "../agents/testing/rows.ts";
import {
  noForward,
  noopTokens,
  okSpec,
  sendAs,
  silentLog,
} from "../agents/testing/runtime-harness.ts";
import { createTestDb } from "../test/helpers.ts";
import { principalSql } from "../test/principals.ts";
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

/** Real runtimes over one fake driver, all starting through one Supervisor; agents share named credentials. */
class World {
  readonly driver = new FakeDriver();
  readonly bus = new EventBus();
  readonly loaded = new Map<string, AgentRuntime>();
  readonly creds = new Map<string, string>(); // name → id
  readonly warns: string[] = [];
  /** When set, the next prepareStart waits for it. */
  prepareGate: Promise<void> | undefined;
  readonly log = { ...silentLog, warn: (_o: object, msg: string) => this.warns.push(msg) };
  readonly sup: Supervisor;
  constructor() {
    const log = this.log;
    this.sup = new Supervisor({
      runtimes: { get: (id) => this.loaded.get(id), all: () => this.loaded.values() },
      bus: this.bus,
      log,
      credentialOf: (id) => this.loaded.get(id)?.agent.credentialId ?? "",
      rateLimits: store,
      load: async (slug) => [...this.loaded.values()].find((rt) => rt.agent.slug === slug),
    });
  }

  /** The credential's id; created on first use with a name unique to this test file. */
  async credential(name: string): Promise<string> {
    const known = this.creds.get(name);
    if (known) return known;
    n += 1;
    const id = `rl-cred-${n}`;
    await t.sql`insert into credentials (id, name, kind, value_enc)
                values (${id}, ${`${name}-${n}`}, 'oauth_token', ${Buffer.from("dummy")})`;
    this.creds.set(name, id);
    return id;
  }

  async agentOn(cred: string): Promise<AgentRuntime> {
    const credId = await this.credential(cred);
    n += 1;
    const id = `rl${n}`;
    await insertAgent(t.sql, { id, slug: `rl${n}` });
    await t.sql`update agents set credential_id = ${credId} where id = ${id}`;
    const agent = await store.agentById(id);
    if (!agent) throw new Error("no agent");
    const rt = new AgentRuntime({
      tokens: noopTokens,
      forward: noForward,
      agent,
      store,
      bus: this.bus,
      driver: this.driver,
      prepareStart: async (a) => {
        const gate = this.prepareGate;
        this.prepareGate = undefined;
        if (gate) await gate;
        return okSpec(a);
      },
      log: this.log,
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
    if (!p) throw new Error(`${rt.agent.slug} never started`);
    return p;
  }

  async settleAll() {
    for (let i = 0; i < 4; i++) for (const rt of this.loaded.values()) await rt.settled();
  }

  /** The reset runs outside any job (DB reads, then jobs): wait until `done` holds. */
  async until(done: () => boolean | Promise<boolean>) {
    // Bounded by real time, not by a loop count: a slow database (CI) must not make this flaky.
    // node:timers/promises is not covered by the fake timers.
    const deadline = process.hrtime.bigint() + 15_000_000_000n;
    while (process.hrtime.bigint() < deadline) {
      await this.settleAll();
      if (await done()) return;
      await sleep(5);
    }
    throw new Error("condition never held");
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
  vi.useRealTimers();
});

const nowSec = () => Math.floor(Date.now() / 1000);
const send = (rt: AgentRuntime, body: string, urgent = false) =>
  sendAs(store, rt, { fromUserId: "u1", fromHandle: "or", body, urgent });
const status = (rt: AgentRuntime) => rt.live().status;
const started = (rt: AgentRuntime) => w.starts(rt).length > 0;
const sentBodies = (rt: AgentRuntime) => w.proc(rt).sent.map((b) => b.map((m) => m.body));
const events = async (rt: AgentRuntime) =>
  (await store.after(rt.agent.id, 0, 1000)).map((e) => e.event);
async function credRow(id: string) {
  const [r] = await t.sql<{ until: string | null; exact: boolean; name: string }[]>`
    select rate_limited_until as until, rate_limit_exact as exact, name from credentials where id = ${id}`;
  if (!r) throw new Error(`no credential ${id}`);
  return { ...r, until: r.until === null ? null : new Date(r.until) };
}
const owed = async (rt: AgentRuntime) =>
  (await store.agentById(rt.agent.id))?.rateLimitNoticeOwed ?? false;

function rejected(resetsAt?: number): HarnessEvent {
  return {
    type: "rate_limited",
    status: "rejected",
    resetsAt: resetsAt ?? 0, // the mapper's value when the event has none
    rateLimitType: "five_hour",
  };
}

async function agentsOnCredentials(...names: string[]) {
  w = new World();
  const out: AgentRuntime[] = [];
  for (const name of names) out.push(await w.agentOn(name));
  return out;
}
/** Started and mid-turn. */
async function busy(rt: AgentRuntime) {
  await send(rt, "work");
  w.proc(rt).emit(ev.session(), ev.turn());
  await w.settleAll();
}
async function emitRejected(rt: AgentRuntime, o: { resetsAt?: number } = {}) {
  w.proc(rt).emit(rejected(o.resetsAt));
  await w.settleAll();
}
function useFakeTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

test("a rejected event pauses only that credential", async () => {
  const [a, b] = (await agentsOnCredentials("work", "personal")) as [AgentRuntime, AgentRuntime];
  await busy(a);
  const resetsAt = nowSec() + 600;
  await emitRejected(a, { resetsAt });
  await send(b, "hi");
  expect(started(b)).toBe(true);
  const c = await w.agentOn("work");
  await send(c, "hi");
  expect(status(c)).toBe("rate_limited");
  expect(started(c)).toBe(false);
  expect(c.live()).toMatchObject({
    rateLimitedUntil: new Date(resetsAt * 1000).toISOString(),
    rateLimitExact: true,
  });
  expect(status(a)).toBe("working");
  expect(b.live().rateLimitedUntil).toBeUndefined();
  const row = await credRow(liveCredentialId(a.agent));
  expect(row?.until?.getTime()).toBe(resetsAt * 1000);
  expect(row?.exact).toBe(true);
  expect(await events(a)).toContainEqual({
    type: "rate_limit_paused",
    credential: row?.name,
    until: new Date(resetsAt * 1000).toISOString(),
    exact: true,
  });
});

test("missing resetsAt uses a 30-minute inexact window", async () => {
  useFakeTimers();
  const [a] = (await agentsOnCredentials("work")) as [AgentRuntime];
  const c = await w.agentOn("work");
  await busy(a);
  const t0 = Date.now();
  await emitRejected(a); // resetsAt missing
  expect(w.warns).toContain(
    "rate limit reached but no reset time was reported; retrying in 30 minutes",
  );
  const row = await credRow(liveCredentialId(a.agent));
  expect(row?.exact).toBe(false);
  expect(row?.until?.getTime()).toBe(t0 + 30 * 60_000);
  expect(a.live()).toMatchObject({ rateLimitExact: false });
  // A reset time in the past is as good as none.
  await emitRejected(a, { resetsAt: nowSec() - 60 });
  expect((await credRow(liveCredentialId(a.agent)))?.until?.getTime()).toBe(t0 + 30 * 60_000);

  await send(c, "hi");
  expect(status(c)).toBe("rate_limited");
  await vi.advanceTimersByTimeAsync(29 * 60_000);
  await w.settleAll();
  expect(started(c)).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  await w.until(() => started(c));
  const cleared = await credRow(liveCredentialId(a.agent));
  expect(cleared).toMatchObject({ until: null, exact: true });
  expect(c.live().rateLimitedUntil).toBeUndefined();
  expect(sentBodies(c)).toEqual([["hi"]]);
});

test("deliveries to a running paused agent are held, then flushed at reset", async () => {
  useFakeTimers();
  const [a, b] = (await agentsOnCredentials("work", "work")) as [AgentRuntime, AgentRuntime];
  await send(b, "first");
  w.proc(b).emit(...ev.fullTurn());
  await w.settleAll();
  await busy(a);
  await emitRejected(a, { resetsAt: nowSec() + 600 });
  w.proc(a).emit(ev.end({ isError: true, terminalReason: "api_error", apiErrorStatus: 429 }));
  await w.settleAll();

  await send(b, "held");
  expect(sentBodies(b)).toEqual([["first"]]);
  expect(status(b)).toBe("rate_limited");
  // An urgent interrupt is still written (it costs no model call); the message itself is held.
  w.proc(b).emit(ev.turn());
  await w.settleAll();
  await send(b, "urgent", true);
  expect(w.proc(b).controls).toEqual([{ kind: "control", cmd: "interrupt" }]);
  w.proc(b).emit(ev.end({ terminalReason: "aborted_tools" }));
  await w.settleAll();
  await b.compact({ byHandle: "or" }); // compacts are held too
  expect(sentBodies(b)).toEqual([["first"]]);
  expect(w.proc(b).controls).toEqual([{ kind: "control", cmd: "interrupt" }]);

  await vi.advanceTimersByTimeAsync(600_000);
  await w.until(() => w.proc(b).sent.length === 2);
  // b wasn't cut off: no notice, only what was held (the compact waits for that batch's turn).
  expect(sentBodies(b)).toEqual([["first"], ["held", "urgent"]]);
  expect(await owed(b)).toBe(false);
  expect(status(b)).toBe("working"); // the batch is written; its turn is coming
  expect(b.queueItems().map((i) => i.kind)).toEqual(["compact"]);
});

test("the cut-off agent gets exactly one notice at reset, batched first with pending messages", async () => {
  useFakeTimers();
  const [a] = (await agentsOnCredentials("work")) as [AgentRuntime];
  await busy(a);
  const resetsAt = nowSec() + 600;
  await emitRejected(a, { resetsAt });
  await emitRejected(a, { resetsAt }); // a second rejection in the same turn adds nothing
  w.proc(a).emit(ev.end({ isError: true, terminalReason: "api_error", apiErrorStatus: 429 }));
  await w.settleAll();
  expect(await owed(a)).toBe(true);
  // A later cut-off turn while the flag is set adds nothing either.
  w.proc(a).emit(ev.turn(), rejected(resetsAt), ev.end({ isError: true }));
  await w.settleAll();
  expect(await owed(a)).toBe(true);
  await send(a, "pending one");
  await send(a, "pending two");
  expect(w.proc(a).sent).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(600_000);
  await w.until(() => w.proc(a).sent.length === 2);
  const name = (await credRow(liveCredentialId(a.agent)))?.name ?? "";
  const batch = w.proc(a).sent[1] ?? [];
  expect(batch.map((m) => [m.from, m.kind, m.body])).toEqual([
    [
      "@factory",
      "system",
      notices.rateLimitReset({ credential: name, at: new Date(resetsAt * 1000) }),
    ],
    ["@or", "message", "pending one"],
    ["@or", "message", "pending two"],
  ]);
  expect(await owed(a)).toBe(false);
  const evs = await events(a);
  expect(evs.filter((e) => e.type === "rate_limit_reset")).toEqual([
    { type: "rate_limit_reset", credential: name },
  ]);
  const rows =
    await t.sql`select id from messages where to_id = ${a.agent.id} and notice = 'rate_limit_reset'`;
  expect(rows).toHaveLength(1);
});

test("an owed agent that hibernated is woken at reset with its notice", async () => {
  useFakeTimers();
  const [a] = (await agentsOnCredentials("work")) as [AgentRuntime];
  await busy(a);
  await emitRejected(a); // inexact: the notice states no time
  w.proc(a).emit(ev.end({ isError: true }));
  await w.settleAll();
  expect(await a.hibernate("warm_window")).toBe(true);
  await w.settleAll();
  expect(status(a)).toBe("hibernated");

  await vi.advanceTimersByTimeAsync(30 * 60_000);
  await w.until(() => w.starts(a).length === 2);
  const name = (await credRow(liveCredentialId(a.agent)))?.name ?? "";
  expect(sentBodies(a)).toEqual([[notices.rateLimitReset({ credential: name })]]);
  expect(notices.rateLimitReset({ credential: name })).not.toContain(" at ");
  expect((await events(a)).at(-2)).toMatchObject({
    type: "process_started",
    reason: "rate_limit_reset",
  });
});

test("a later event extends the window, never shortens it", async () => {
  useFakeTimers();
  const [a] = (await agentsOnCredentials("work")) as [AgentRuntime];
  const c = await w.agentOn("work");
  await busy(a);
  const t0 = nowSec();
  await emitRejected(a, { resetsAt: t0 + 600 });
  await emitRejected(a, { resetsAt: t0 + 300 });
  expect((await credRow(liveCredentialId(a.agent)))?.until?.getTime()).toBe((t0 + 600) * 1000);
  const paused = (await events(a)).filter((e) => e.type === "rate_limit_paused");
  expect(paused.map((e) => e.type === "rate_limit_paused" && e.until)).toEqual([
    new Date((t0 + 600) * 1000).toISOString(),
    new Date((t0 + 600) * 1000).toISOString(),
  ]);
  await emitRejected(a, { resetsAt: t0 + 1200 });
  expect(a.live().rateLimitedUntil).toBe(new Date((t0 + 1200) * 1000).toISOString());
  await send(c, "hi");
  await vi.advanceTimersByTimeAsync(700_000);
  await w.settleAll();
  expect(started(c)).toBe(false);
  expect((await credRow(liveCredentialId(a.agent)))?.until?.getTime()).toBe((t0 + 1200) * 1000);
  await vi.advanceTimersByTimeAsync(500_000);
  await w.until(() => started(c));
});

test("an inline start that a pause overtakes during prepare goes back to the queue", async () => {
  useFakeTimers();
  const [a] = (await agentsOnCredentials("work")) as [AgentRuntime];
  let open = () => {};
  w.prepareGate = new Promise<void>((r) => {
    open = r;
  });
  const sending = send(a, "hi");
  await new Promise((r) => setImmediate(r));
  w.sup.pause(liveCredentialId(a.agent), new Date(Date.now() + 600_000), true);
  open();
  await sending; // accepted (202), not a start failure
  expect(started(a)).toBe(false);
  expect(w.sup.running().count).toBe(0);
  expect(w.sup.isQueued(a.agent.id)).toBe(true);
  expect(status(a)).toBe("rate_limited");
  w.sup.onCredentialReset(liveCredentialId(a.agent));
  await w.until(() => started(a));
});

test("a window past setTimeout's cap re-arms and resets at its end", async () => {
  useFakeTimers();
  const [a] = (await agentsOnCredentials("work")) as [AgentRuntime];
  const c = await w.agentOn("work");
  await busy(a);
  const until = nowSec() + 30 * 24 * 3600; // 30 days: more than 2^31-1 ms
  await emitRejected(a, { resetsAt: until });
  await send(c, "hi");
  await vi.advanceTimersByTimeAsync(2_147_483_647 + 1000);
  await w.settleAll();
  expect(started(c)).toBe(false);
  expect(status(c)).toBe("rate_limited");
  await vi.advanceTimersByTimeAsync(until * 1000 - Date.now());
  await w.until(() => started(c));
});

test("a window extended during the reset keeps the flag, and its own reset writes the new time", async () => {
  useFakeTimers();
  const [a] = (await agentsOnCredentials("work")) as [AgentRuntime];
  await busy(a);
  const first = nowSec() + 600;
  await emitRejected(a, { resetsAt: first });
  w.proc(a).emit(ev.end({ isError: true }));
  await w.settleAll();
  const later = first + 600;
  const owedAgents = store.owedAgents.bind(store);
  const spy = vi.spyOn(store, "owedAgents").mockImplementationOnce(async (id) => {
    w.sup.pause(id, new Date(later * 1000), true); // lands while the reset reads the owed agents
    return owedAgents(id);
  });
  await vi.advanceTimersByTimeAsync(600_000);
  await w.until(() => spy.mock.calls.length === 1);
  await w.settleAll();
  expect(await owed(a)).toBe(true);
  expect((await events(a)).some((e) => e.type === "rate_limit_reset")).toBe(false);
  expect(a.queueItems()).toEqual([]);
  await vi.advanceTimersByTimeAsync(600_000);
  await w.until(() => w.proc(a).sent.length === 2);
  const name = (await credRow(liveCredentialId(a.agent))).name;
  expect(sentBodies(a)[1]).toEqual([
    notices.rateLimitReset({ credential: name, at: new Date(later * 1000) }),
  ]);
  expect(await owed(a)).toBe(false);
});

test("moving an agent off a paused credential re-pumps its entry, flushes held items and drops the owed notice", async () => {
  const [a, c] = (await agentsOnCredentials("work", "work")) as [AgentRuntime, AgentRuntime];
  await busy(a);
  await emitRejected(a, { resetsAt: nowSec() + 3600 });
  w.proc(a).emit(ev.end({ isError: true }));
  await w.settleAll();
  expect(await owed(a)).toBe(true);
  await send(a, "held");
  await send(c, "queued");
  expect(status(c)).toBe("rate_limited");
  const personal = await w.credential("personal");
  for (const rt of [a, c]) {
    await t.sql`update agents set credential_id = ${personal} where id = ${rt.agent.id}`;
    await rt.reload(); // what AgentRuntimes.refresh does, then it re-pumps the queue
    w.sup.recheckQueue();
  }
  await w.settleAll();
  expect(sentBodies(a)).toEqual([["work"], ["held"]]);
  expect(await owed(a)).toBe(false);
  expect(started(c)).toBe(true);
  expect(sentBodies(c)).toEqual([["queued"]]);
  expect(c.live().rateLimitedUntil).toBeUndefined();
});
