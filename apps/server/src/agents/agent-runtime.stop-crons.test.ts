import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { AgentRuntime } from "./agent-runtime.ts";
import { EventBus } from "./event-bus.ts";
import { EventStore } from "./event-store.ts";
import { ev, FakeDriver } from "./testing/fake-driver.ts";
import { insertAgent } from "./testing/rows.ts";
import { sendAs } from "./testing/runtime-harness.ts";
import { unlimitedSlots } from "./testing/unlimited-slots.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
let n = 0;
beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  await t.sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
});
afterAll(() => t.close());

let driver: FakeDriver;
let rt: AgentRuntime;
let id: string;
let forwarded: { fact?: string }[] = [];
const frames: { type: string }[] = [];
async function make(o: { spawned?: boolean; archived?: boolean; terminated?: boolean } = {}) {
  n += 1;
  id = `sc${n}`;
  if (o.spawned) {
    await insertAgent(t.sql, { id: `sl${n}`, slug: `slead${n}` });
    await insertAgent(t.sql, { id, slug: `stop${n}`, reportsTo: `sl${n}` });
    await t.sql`update agents set kind = 'ephemeral' where id = ${id}`;
  } else if (o.terminated) {
    await insertAgent(t.sql, { id: `tl${n}`, slug: `tlead${n}` });
    await insertAgent(t.sql, {
      id,
      slug: `stop${n}`,
      terminatedAt: new Date(),
      reportsTo: `tl${n}`,
    });
  } else
    await insertAgent(t.sql, { id, slug: `stop${n}`, ...(o.archived ? { archived: true } : {}) });
  driver = new FakeDriver();
  forwarded = [];
  const agent = await store.agentById(id);
  if (!agent) throw new Error("no agent");
  const bus = new EventBus();
  bus.subscribeAll((m) => void frames.push(m));
  rt = new AgentRuntime({
    tokens: { mint: () => ({ token: "t" }), revoke() {}, revokeAll() {} } as never,
    forward: async (f) => void forwarded.push(f as { fact?: string }),
    agent,
    store,
    bus,
    driver,
    prepareStart: async (a) => ({
      agentId: a.id,
      slug: a.slug,
      cwd: "/w",
      env: {},
      claudeBin: "claude",
      runtime: "local",
      permissionMode: "auto",
      mounts: [],
    }),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    slots: unlimitedSlots,
  });
  await rt.init();
}
beforeEach(() => make());

const send = (body: string) => sendAs(store, rt, { fromUserId: "u1", body, urgent: false });
const events = async () => (await store.after(id, 0, 1000)).map((e) => e.event);
async function idleWithCrons() {
  await send("boot");
  driver.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
  await rt.settled();
  driver.last.emit(
    ev.cron("c1", { humanSchedule: "every 5 minutes" }),
    ev.cron("c2", { recurring: false, humanSchedule: "at 14:30, once" }),
  );
  await rt.settled();
}
const pendingNotice = () =>
  t.sql`select body from messages where to_agent_id = ${id} and notice = 'crons_stopped' and state = 'pending'`;

test("no process, no crons: no_crons; archived and terminated agents are refused", async () => {
  await expect(rt.stopCrons("or")).rejects.toMatchObject({
    code: "no_crons",
    status: 409,
    message: `@stop${n} has no crons.`,
  });
  await send("boot");
  driver.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
  await rt.settled();
  await expect(rt.stopCrons("or")).rejects.toMatchObject({ code: "no_crons" });
  await make({ archived: true });
  await expect(rt.stopCrons("or")).rejects.toThrow(/archived/);
  await make({ terminated: true });
  await expect(rt.stopCrons("or")).rejects.toThrow(/terminated/);
});

test("idle with two crons: stops now, records who, leaves the passive notice, wakes nothing, tells no manager", async () => {
  await idleWithCrons();
  expect(rt.hibernatable()).toBe(false); // pinned
  const r = await rt.stopCrons("or");
  expect(r).toEqual({ status: "stopped" });
  await rt.settled();
  expect(driver.last.stopped).toBe(true);
  const evs = await events();
  expect(evs.find((e) => e.type === "hibernated")).toMatchObject({
    reason: "crons_stopped",
    by: "@or",
  });
  expect(evs.find((e) => e.type === "background_work_lost")).toMatchObject({
    reason: "crons_stopped",
    by: "@or",
    crons: [{ cronId: "c1" }, { cronId: "c2" }],
  });
  const [notice] = await pendingNotice();
  expect(notice?.body).toBe(
    "@or stopped your crons: every 5 minutes; at 14:30, once. Don't recreate them unless you are asked to.",
  );
  expect(driver.starts).toHaveLength(1); // no wake
  expect(forwarded.filter((f) => f.fact === "work_lost")).toHaveLength(0);
});

test("busy: pending, stopCronsPending in the frame; at the turn end it stops despite the pin, and lists crons created meanwhile", async () => {
  await send("boot");
  driver.last.emit(ev.session(), ev.turn());
  await rt.settled();
  driver.last.emit(ev.cron("c1", { humanSchedule: "every 5 minutes" }));
  await rt.settled();
  expect(await rt.stopCrons("or")).toEqual({ status: "pending" });
  expect(rt.statusFrame().stopCronsPending).toBe(true);
  driver.last.emit(ev.cron("c2", { humanSchedule: "every hour" }));
  await rt.settled();
  expect(driver.last.stopped).toBe(false);
  driver.last.emit(ev.usage(), ev.end());
  await rt.settled();
  await rt.settled();
  expect(driver.last.stopped).toBe(true);
  expect(rt.statusFrame().stopCronsPending).toBe(false);
  const [notice] = await pendingNotice();
  expect(notice?.body).toContain("every 5 minutes; every hour");
  expect((await events()).find((e) => e.type === "hibernated")).toMatchObject({
    reason: "crons_stopped",
    by: "@or",
  });
});

test("a live background task keeps the stop pending until it finishes", async () => {
  await idleWithCrons();
  driver.last.emit(ev.background([{ taskId: "b1", description: "build" }]));
  await rt.settled();
  expect(await rt.stopCrons("or")).toEqual({ status: "pending" });
  driver.last.emit(ev.taskFinished("b1"), ev.background([]));
  await rt.settled();
  driver.last.emit(ev.turn(), ev.usage(), ev.end({ originKind: "task-notification" }));
  await rt.settled();
  await rt.settled();
  expect(driver.last.stopped).toBe(true);
});

test("another stop under way is refused: a second Stop while the first is stopping", async () => {
  await idleWithCrons();
  driver.last.holdStop = true;
  expect(await rt.stopCrons("or")).toEqual({ status: "stopped" });
  await expect(rt.stopCrons("or")).rejects.toMatchObject({
    code: "stopping",
    status: 409,
    message: `@stop${n} is already stopping; its crons stop with it.`,
  });
  driver.last.releaseStop();
  await rt.settled();
});

test("a spawned agent behaves the same", async () => {
  await make({ spawned: true });
  await idleWithCrons();
  expect(await rt.stopCrons("or")).toEqual({ status: "stopped" });
  await rt.settled();
  expect((await events()).find((e) => e.type === "hibernated")).toMatchObject({
    reason: "crons_stopped",
  });
});
