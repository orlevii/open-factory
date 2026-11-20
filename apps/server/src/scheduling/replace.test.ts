import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { Scheduler } from "./scheduler.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let driver: FakeDriver;
let clock: Date;
let userId: string;
const timers = {
  setTimer: () => ({}) as never,
  clearTimer: () => {},
};

beforeEach(async () => {
  clock = new Date("2026-11-20T10:00:00Z");
  driver = new FakeDriver();
  h = await makeTestApp({ harnessDriver: driver, clock: () => clock, schedulerTimers: timers });
  userId = (await signUp(h.app, { handle: "or" })).user.id;
  await h.seedAgent({ slug: "ceo" });
  await h.seedAgent({ slug: "dev" });
  await h.sql`update agents set status = 'errored', error_kind = 'start' where slug = 'ceo'`;
});
afterEach(() => h.close());

const fireAt = async (iso: string) => {
  clock = new Date(iso);
  await h.app.scheduler.tick();
  await h.app.scheduler.idle();
};
const pending = () =>
  h.sql`select id, firings, body, late, author_user_id, author_agent_id, created_at, delivered_event_seq from messages where kind = 'scheduled' and state = 'pending'`;
const weekday = { cron: "0 9 * * 1-5", timezone: "Europe/Berlin" };

test("AC 3: three firings while the target is errored leave one pending row with the current body, and start nothing", async () => {
  const dev = (await h.app.store.agentBySlug("dev"))?.id as string;
  const { item } = await h.app.schedules.create(
    { agentId: dev },
    { target: "ceo", ...weekday, body: "v1" },
  );
  await fireAt("2026-11-23T08:00:00Z");
  const [first] = await pending();
  expect(first).toMatchObject({ firings: 1, body: "v1", author_agent_id: dev });
  await h.app.schedules.edit({ userId }, item.key, { body: "v2" });
  await fireAt("2026-11-24T08:00:00Z");
  await fireAt("2026-11-25T08:00:00Z");
  const rows = await pending();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: first?.id,
    firings: 3,
    body: "v2",
    author_user_id: userId,
    author_agent_id: null,
    late: false,
  });
  expect(new Date(rows[0]?.created_at as string).getTime()).toBe(
    new Date(first?.created_at as string).getTime(),
  );
  expect(driver.starts).toHaveLength(0);
  const status = (await h.sql`select status, attempting from agents where slug = 'ceo'`)[0];
  expect(status).toEqual({ status: "errored", attempting: false });
  // the runtime's queued entry is refreshed too
  const rt = await h.app.runtimes.bySlug("ceo");
  await rt?.settled(); // the hand-off itself was awaited by idle(); the runtime's own job queue is drained here
  expect(rt?.queueItems().find((q) => q.id === first?.id)).toMatchObject({
    firings: 3,
    body: "v2",
  });
});

test("a pending row already written to a process that hasn't confirmed it is not replaced; nothing else is written", async () => {
  const { item } = await h.app.schedules.create(
    { userId },
    { target: "ceo", ...weekday, body: "v1" },
  );
  await fireAt("2026-11-23T08:00:00Z");
  const [first] = await pending();
  await h.sql`update messages set delivered_event_seq = 7 where id = ${first?.id as string}`;
  await h.app.schedules.edit({ userId }, item.key, { body: "v2" });
  await fireAt("2026-11-24T08:00:00Z");
  const rows = await pending();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: first?.id, firings: 1, body: "v1" });
  const s = await h.app.schedules.get(item.key);
  expect(s?.nextRunAt).toBe("2026-11-25T08:00:00.000Z"); // the schedule still moved on
  expect(s?.lastFiredAt).toBe("2026-11-24T08:00:00.000Z");
});

test("two schedulers firing one schedule: one fires, the other skips it (SKIP LOCKED), never two pending rows", async () => {
  await h.app.schedules.create({ userId }, { target: "ceo", ...weekday, body: "v1" });
  const mk = () =>
    new Scheduler({
      db: h.db,
      store: h.app.store,
      schedules: new ScheduleStore({ db: h.db }),
      runtimes: h.app.runtimes,
      bus: h.app.bus,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      now: () => clock,
      ...timers,
    });
  clock = new Date("2026-11-23T08:00:00Z");
  const a = mk();
  const b = mk();
  await Promise.all([a.tick(), b.tick()]);
  await Promise.all([a.idle(), b.idle()]);
  expect(await pending()).toHaveLength(1);
  const [{ n }] =
    (await h.sql`select count(*)::int as n from messages where kind = 'scheduled'`) as unknown as [
      { n: number },
    ];
  expect(n).toBe(1);
});
