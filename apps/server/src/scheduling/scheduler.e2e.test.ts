import { afterEach, beforeEach, expect, test } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let driver: FakeDriver;
let clock: Date;
let timers: { fn: () => void; ms: number; cleared: boolean }[];
let userId: string;
const schedulerTimers = {
  setTimer: (fn: () => void, ms: number) => {
    const rec = { fn, ms, cleared: false };
    timers.push(rec);
    return rec as never;
  },
  clearTimer: (x: unknown) => {
    (x as { cleared: boolean }).cleared = true;
  },
};
const opts = () => ({ harnessDriver: driver, clock: () => clock, schedulerTimers });
const proc = () => driver.starts.filter((p) => p.spec.slug === "ceo").at(-1);

beforeEach(async () => {
  clock = new Date("2026-11-20T10:00:00Z");
  timers = [];
  driver = new FakeDriver();
  h = await makeTestApp(opts());
  userId = (await signUp(h.app, { handle: "or" })).user.id;
  await h.seedAgent({ slug: "ceo" });
});
afterEach(() => h.close());

async function ceo() {
  const a = await h.app.store.agentBySlug("ceo");
  if (!a) throw new Error("seed");
  return a;
}

test("AC 1: a weekday cron in Europe/Berlin wakes a hibernated agent with the scheduled envelope", async () => {
  const { item } = await h.app.schedules.create(
    { userId },
    {
      target: "ceo",
      cron: "0 9 * * 1-5",
      timezone: "Europe/Berlin",
      body: "Morning review: open tasks.",
    },
  );
  expect(item.nextRunAt).toBe("2026-11-23T08:00:00.000Z");
  clock = new Date("2026-11-23T08:00:00Z");
  await h.app.scheduler.tick();
  await h.app.scheduler.idle();
  await (await h.app.runtimes.bySlug("ceo"))?.settled();
  const p = proc();
  expect(p).toBeDefined();
  p?.emit(ev.session(), ev.turn());
  await (await h.app.runtimes.bySlug("ceo"))?.settled();
  const first = p?.sent[0]?.[0];
  expect(first).toMatchObject({
    from: "@scheduler",
    kind: "scheduled",
    scheduleKey: item.key,
    by: "@or",
    due: "2026-11-23T09:00:00+01:00",
  });
  expect(first?.firings).toBe(1); // rendered only above 1
  expect(first?.late).toBeUndefined();
  const events = (await h.app.store.after((await ceo()).id, 0, 100)).map((e) => e.event);
  expect(events.find((e) => e.type === "process_started")).toMatchObject({ reason: "scheduled" });
});

test("catch-up: a server stopped across the next 09:00 fires once at boot, late, and moves on", async () => {
  const { item } = await h.app.schedules.create(
    { userId },
    { target: "ceo", cron: "0 9 * * 1-5", timezone: "Europe/Berlin", body: "Morning review" },
  );
  await h.app.close();
  clock = new Date("2026-11-24T10:40:00Z"); // Tuesday 11:40 Berlin; the 09:00 run was missed, and so was Monday's
  timers = [];
  driver = new FakeDriver();
  const again = await h.reopen(opts());
  expect(timers.some((x) => !x.cleared && x.ms === 0)).toBe(true); // armed once at start
  await again.app.scheduler.tick();
  await again.app.scheduler.idle();
  const rows = await h.sql`select firings, late, due_at from messages where kind = 'scheduled'`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ firings: 2, late: true });
  expect(new Date(rows[0]?.due_at as string).toISOString()).toBe("2026-11-24T08:00:00.000Z");
  const got = await again.app.schedules.get(item.key);
  expect(got?.nextRunAt).toBe("2026-11-25T08:00:00.000Z");
  await (await again.app.runtimes.bySlug("ceo"))?.settled();
  const p = driver.starts.at(-1);
  p?.emit(ev.session(), ev.turn());
  await (await again.app.runtimes.bySlug("ceo"))?.settled();
  expect(p?.sent[0]?.[0]).toMatchObject({ kind: "scheduled", firings: 2, late: true });
});
