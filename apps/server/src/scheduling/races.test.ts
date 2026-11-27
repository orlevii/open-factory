import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { agentRowOf, makeTestApp, signUp } from "../test/helpers.ts";
import { seedTestUser } from "../test/principals.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let clock: Date;
let userId: string;
const timers = { setTimer: () => ({}) as never, clearTimer: () => {} };
const weekday = { cron: "0 9 * * 1-5", timezone: "Europe/Berlin" };

beforeEach(async () => {
  clock = new Date("2026-11-20T10:00:00Z");
  h = await makeTestApp({
    harnessDriver: new FakeDriver(),
    clock: () => clock,
    schedulerTimers: timers,
  });
  userId = (await signUp(h.app, { handle: "or" })).user.id;
  await h.seedAgent({ handle: "lead" });
  await h.seedAgent({ handle: "kid" });
  await h.sql`update agents set kind = 'ephemeral', reports_to = (select id from agents where id = (select id from principals where handle = 'lead')) where id = (select id from principals where handle = 'kid')`;
});
afterEach(() => h.close());

/** Polls `pg_stat_activity` until `n` backends of this database wait on a lock (no sleeps, no timeouts of ours). */
async function waitForLocks(n = 1): Promise<void> {
  for (;;) {
    const r =
      await h.sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`;
    if (r.length >= n) return;
    await new Promise((res) => setImmediate(res));
  }
}
/** Holds a transaction open on its own connection until `release()`. */
function hold(run: (tx: typeof h.sql) => Promise<void>) {
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const isReady = new Promise<void>((r) => (ready = r));
  const done = h.sql.begin(async (tx) => {
    await run(tx as unknown as typeof h.sql);
    ready();
    await gate;
  });
  return { ready: isReady, release, done };
}
const kidId = async () => (await agentRowOf(h.app, "kid"))?.id as string;
const sched = (body = "v1") =>
  h.app.schedules.create({ kind: "human", id: userId }, { target: "kid", ...weekday, body });
const msgs = () => h.sql`select state, firings from messages where kind = 'scheduled'`;

test("termination first: the firing waits on the agent row, then finds the schedule deleted and writes nothing", async () => {
  const { item } = await sched();
  const id = await kidId();
  const term = hold(async (tx) => {
    await tx`select id from agents where id = ${id} for no key update`;
    await tx`update agents set terminated_at = now(), terminated_by = null where id = ${id}`;
    await tx`update schedules set deleted_at = now(), next_run_at = null where target_agent_id = ${id}`;
  });
  await term.ready;
  clock = new Date("2026-11-23T08:00:00Z");
  const tick = h.app.scheduler.tick();
  await waitForLocks(1);
  term.release();
  await term.done;
  await tick;
  await h.app.scheduler.idle();
  expect(await msgs()).toHaveLength(0);
  expect((await h.app.schedules.get(item.key, { includeDeleted: true }))?.deleted).toBe(true);
});

test("firing first: the termination waits on the firing's lock, then rejects the row it wrote and the schedule is deleted", async () => {
  const { item } = await sched();
  const id = await kidId();
  // Blocks only the firing's message insert, after its FOR SHARE on the agent row.
  const blocker = hold(async (tx) => {
    await tx`lock table messages in share mode`;
  });
  await blocker.ready;
  clock = new Date("2026-11-23T08:00:00Z");
  const tick = h.app.scheduler.tick();
  await waitForLocks(1);
  const terminated = h.app.terminator.terminate(id, await seedTestUser(h.app.db, "or"));
  await waitForLocks(2); // the termination now waits on the agent row our firing shares
  blocker.release();
  await blocker.done;
  await tick;
  await terminated;
  await h.app.scheduler.idle();
  expect(await msgs()).toMatchObject([{ state: "rejected" }]);
  expect((await h.app.schedules.get(item.key, { includeDeleted: true }))?.deleted).toBe(true);
});

test("edit vs firing: a schedule being edited is skipped (SKIP LOCKED) and fires with the edited values on the next tick", async () => {
  const { item } = await sched("old");
  const n = Number(item.key.slice(2));
  const editing = hold(async (tx) => {
    await tx`select id from schedules where number = ${n} for no key update`;
    await tx`update schedules set body = 'edited' where number = ${n}`;
  });
  await editing.ready;
  clock = new Date("2026-11-23T08:00:00Z");
  await h.app.scheduler.tick();
  expect(await msgs()).toHaveLength(0);
  editing.release();
  await editing.done;
  clock = new Date("2026-11-23T08:00:02Z");
  await h.app.scheduler.tick();
  await h.app.scheduler.idle();
  const [m] = await h.sql`select body from messages where kind = 'scheduled'`;
  expect(m?.body).toBe("edited");
});
