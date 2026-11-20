import type { ServerMessage } from "@open-factory/shared";
import { afterEach, expect, test } from "vitest";
import type { AgentRuntime } from "../agents/agent-runtime.ts";
import { ev, FakeDriver, type FakeProcess } from "../agents/testing/fake-driver.ts";
import { sendAs } from "../agents/testing/runtime-harness.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";

/** S10 §8.2, AC3: the concurrency cap changes live through PATCH /api/settings/factory, over the assembled app. */
type T = Awaited<ReturnType<typeof makeTestApp>>;
let t: T | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function setup(maxRunningAgents: number, slugs: string[]) {
  const driver = new FakeDriver();
  t = await makeTestApp({ harnessDriver: driver, factorySettings: { maxRunningAgents } });
  const app = t;
  const or = await signUp(app.app, { handle: "or" });
  const frames: ServerMessage[] = [];
  app.app.bus.subscribeAll((m) => frames.push(m));
  const rts: AgentRuntime[] = [];
  for (const slug of slugs) {
    const row = await app.seedAgent({ slug });
    const rt = await app.app.runtimes.load(row.id);
    if (!rt) throw new Error(`no runtime for ${slug}`);
    rts.push(rt);
  }
  /** Every runtime's jobs, including grant and hibernate jobs one agent enqueued on another. */
  const settleAll = async () => {
    for (let i = 0; i < 4; i++) for (const rt of rts) await rt.settled();
  };
  const starts = (rt: AgentRuntime) => driver.starts.filter((p) => p.spec.agentId === rt.agent.id);
  const proc = (rt: AgentRuntime): FakeProcess => {
    const p = starts(rt).at(-1);
    if (!p) throw new Error(`${rt.agent.slug} never started`);
    return p;
  };
  const send = async (rt: AgentRuntime, body: string) => {
    await sendAs(app.app.store, rt, { fromUserId: or.user.id, body, urgent: false });
    await settleAll();
  };
  /** Started and mid-turn. */
  const busy = async (rt: AgentRuntime) => {
    await send(rt, "work");
    proc(rt).emit(ev.session(), ev.turn());
    await settleAll();
  };
  /** Started, its turn over: idle and hibernatable. */
  const idle = async (rt: AgentRuntime) => {
    await send(rt, "work");
    proc(rt).emit(...ev.fullTurn());
    await settleAll();
    expect(rt.hibernatable()).toBe(true);
  };
  const patchCap = async (max: number) => {
    const r = await app.app.inject({
      method: "PATCH",
      url: "/api/settings/factory",
      headers: { cookie: or.cookie },
      payload: { maxRunningAgents: max },
    });
    expect(r.statusCode).toBe(200);
    await settleAll();
  };
  const events = async (rt: AgentRuntime) =>
    (await app.app.store.after(rt.agent.id, 0, 1000)).map((e) => e.event);
  const started = (rt: AgentRuntime) => starts(rt).length > 0;
  const stopped = (rt: AgentRuntime) => starts(rt).some((p) => p.stopped);
  return {
    app,
    frames,
    rts,
    send,
    busy,
    idle,
    patchCap,
    events,
    started,
    stopped,
    proc,
    settleAll,
  };
}

test("raising the cap grants a queued wake without a restart and publishes the new max", async () => {
  const s = await setup(1, ["a", "b"]);
  const [a, b] = s.rts as [AgentRuntime, AgentRuntime];
  await s.busy(a);
  await s.send(b, "hi");
  expect(b.live().status).toBe("queued");
  expect(s.started(b)).toBe(false);

  await s.patchCap(2);

  expect(s.started(b)).toBe(true);
  expect(await s.events(b)).toContainEqual(expect.objectContaining({ type: "process_started" }));
  expect(s.frames).toContainEqual({ type: "supervisor", running: 2, max: 2 });
  expect(s.app.app.runtimes.supervisor.running()).toEqual({ count: 2, max: 2 });
  expect(s.stopped(a)).toBe(false);
});

test("lowering the cap with both agents busy stops neither", async () => {
  const s = await setup(2, ["a", "b"]);
  const [a, b] = s.rts as [AgentRuntime, AgentRuntime];
  await s.busy(a);
  await s.busy(b);

  await s.patchCap(1);

  expect([s.stopped(a), s.stopped(b)]).toEqual([false, false]);
  expect(s.frames).toContainEqual({ type: "supervisor", running: 2, max: 1 });
  expect(s.app.app.runtimes.supervisor.running()).toEqual({ count: 2, max: 1 });
});

test("under a lowered cap an idle holder hibernates with freed_slot, then the queued wake is granted", async () => {
  const s = await setup(2, ["a", "c"]);
  const [a, c] = s.rts as [AgentRuntime, AgentRuntime];
  await s.idle(a);

  await s.patchCap(1);
  expect(s.stopped(a)).toBe(false); // nothing waits: lowering alone stops no one

  await s.send(c, "hi");
  await s.settleAll();
  expect((await s.events(a)).at(-1)).toMatchObject({ type: "hibernated", reason: "freed_slot" });
  expect(s.started(c)).toBe(true);
  expect(s.app.app.runtimes.supervisor.running()).toEqual({ count: 1, max: 1 });
});

test("under a lowered cap a queued wake waits while the remaining holder is busy", async () => {
  const s = await setup(2, ["a", "b", "c"]);
  const [a, b, c] = s.rts as [AgentRuntime, AgentRuntime, AgentRuntime];
  await s.busy(a);
  await s.busy(b);
  await s.patchCap(1);

  await s.send(c, "hi");
  expect(c.live().status).toBe("queued");
  // A's turn ends: it is idle, so it hibernates early to bring running under the cap.
  s.proc(a).emit(ev.end());
  await s.settleAll();
  expect((await s.events(a)).at(-1)).toMatchObject({ type: "hibernated", reason: "freed_slot" });
  // B is busy and no one is idle: running (1) is not below the cap (1), so C waits.
  expect(s.stopped(b)).toBe(false);
  expect(s.started(c)).toBe(false);
  expect(c.live().status).toBe("queued");
  expect(s.app.app.runtimes.supervisor.running()).toEqual({ count: 1, max: 1 });
});
