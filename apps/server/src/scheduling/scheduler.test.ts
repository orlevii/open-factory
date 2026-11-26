import type { ServerMessage } from "@open-factory/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { EventStore } from "../agents/event-store.ts";
import { insertAgent, insertSchedule, insertScheduledMessage } from "../agents/testing/rows.ts";
import { LoopGuard } from "../messaging/loop-guard.ts";
import type { FactorySettings } from "../settings/factory-settings.ts";
import { createTestDb } from "../test/helpers.ts";
import { principalSql } from "../test/principals.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { Scheduler } from "./scheduler.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: ScheduleStore;
let sched: Scheduler;
let clock: Date;
let timers: { fn: () => void; ms: number; cleared: boolean }[];
let frames: ServerMessage[];
let holdSeq = 0;
const deliver = vi.fn(async (..._a: unknown[]) => undefined);
const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
const T0 = new Date("2026-11-20T10:00:00Z"); // Friday 11:00 Berlin

beforeAll(async () => {
  t = await createTestDb();
  await t.sql.unsafe(principalSql("u1", "human", "or"));
  await t.sql`insert into users (id, name, email) values ('u1', 'Or', 'or@x.io')`;
});
afterAll(() => t.close());
afterEach(async () => {
  // No hand-off of this test may leak into the next one.
  await sched.idle();
  vi.restoreAllMocks();
});
beforeEach(async () => {
  clock = T0;
  timers = [];
  frames = [];
  deliver.mockReset();
  deliver.mockResolvedValue(undefined);
  await t.sql`delete from messages`;
  await t.sql`delete from loop_holds`;
  await t.sql`delete from schedules`;
  await t.sql`delete from agents`;
  await t.sql`delete from credentials`;
  await insertAgent(t.sql, { id: "ceo", slug: "ceo" });
  await insertAgent(t.sql, { id: "dev", slug: "dev" });
  store = new ScheduleStore();
  sched = new Scheduler({
    db: t.db,
    store: new EventStore(t.db),
    schedules: store,
    loopGuard: new LoopGuard({
      settings: {
        loopGuardMessages: () => 2,
        loopGuardWindowMs: () => 10 * 60_000,
      } as FactorySettings,
      store: Object.assign(new EventStore(t.db), { clock: () => clock }),
      bus: { publishAll: () => {} },
      runtimes: { adoptNotice: async () => {} },
      log: silentLog as never,
      clock: () => clock,
      newId: () => `hold-${++holdSeq}`,
    }),
    runtimes: { deliver: deliver as never },
    bus: { publishAll: (m) => void frames.push(m) },
    log: silentLog,
    now: () => clock,
    setTimer: (fn, ms) => {
      const rec = { fn, ms, cleared: false };
      timers.push(rec);
      return rec as never;
    },
    clearTimer: (h) => {
      (h as never as { cleared: boolean }).cleared = true;
    },
  });
});

const lastTimer = () => timers.filter((x) => !x.cleared).at(-1);
const sched1 = (over: Partial<Parameters<typeof insertSchedule>[1]> = {}) =>
  insertSchedule(t.sql, {
    id: "s1",
    targetAgentId: "ceo",
    cron: "0 9 * * 1-5",
    timezone: "Europe/Berlin",
    nextRunAt: new Date("2026-11-23T08:00:00Z"),
    ...over,
  });
const asDate = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string));
const rows = async () =>
  (
    await t.sql`select kind, to_id, firings, late, due_at, state, body, author_id from messages order by created_at`
  ).map((r) => ({ ...r, due_at: asDate(r.due_at) }));
const schedRow = async (id = "s1") => {
  const r = (
    await t.sql`select next_run_at, last_fired_at, fail_count, retry_at, deleted_at, paused_at from schedules where id = ${id}`
  )[0] as Record<string, unknown>;
  return {
    ...r,
    next_run_at: asDate(r.next_run_at),
    last_fired_at: asDate(r.last_fired_at),
    retry_at: asDate(r.retry_at),
  } as {
    next_run_at: Date | null;
    last_fired_at: Date | null;
    retry_at: Date | null;
    fail_count: number;
  };
};

test("arms at most 60 s ahead and fires nothing until due", async () => {
  await sched1({ nextRunAt: new Date("2026-11-20T13:00:00Z") }); // three hours out
  sched.start();
  expect(lastTimer()?.ms).toBe(0); // the first tick at start
  await sched.tick();
  expect(lastTimer()?.ms).toBe(60_000);
  clock = new Date("2026-11-20T12:59:00Z");
  await sched.tick();
  expect(await rows()).toHaveLength(0);
  expect(lastTimer()?.ms).toBe(60_000);
  clock = new Date("2026-11-20T12:59:30Z");
  await sched.tick();
  expect(lastTimer()?.ms).toBe(30_000); // exactly to the due time
});

test("fires at the time: one row, next run advanced, last fired set, handed over after the commit", async () => {
  await sched1();
  clock = new Date("2026-11-23T08:00:00Z");
  await sched.tick();
  await sched.idle();
  expect(await rows()).toEqual([
    {
      kind: "scheduled",
      to_id: "ceo",
      firings: 1,
      late: false,
      due_at: new Date("2026-11-23T08:00:00Z"),
      state: "pending",
      body: "Review",
      author_id: "u1",
    },
  ]);
  const s = await schedRow();
  expect(s.next_run_at).toEqual(new Date("2026-11-24T08:00:00Z"));
  expect(s.last_fired_at).toEqual(clock);
  expect(deliver).toHaveBeenCalledTimes(1);
  const [row, sender, reason] = deliver.mock.calls[0] as unknown as [
    { kind: string; scheduleKey: string },
    string,
    string,
  ];
  expect([row.kind, row.scheduleKey, sender, reason]).toEqual([
    "scheduled",
    `S-${(await t.sql`select number from schedules where id = 's1'`)[0]?.number}`,
    "agent",
    "scheduled",
  ]);
  expect(frames.filter((f) => f.type === "schedules_changed")).toHaveLength(1);
});

test("catch-up: three days of a weekday cron fire once, late, covering every missed run", async () => {
  await sched1();
  clock = new Date("2026-11-26T10:40:00Z"); // Thu: Mon, Tue, Wed, Thu 09:00 Berlin passed
  await sched.tick();
  const [m] = await rows();
  expect(m).toMatchObject({ firings: 4, late: true, due_at: new Date("2026-11-26T08:00:00Z") });
  expect((await rows()).length).toBe(1);
  expect((await schedRow()).next_run_at).toEqual(new Date("2026-11-27T08:00:00Z"));
});

test("a one-shot that passed fires once, late, and is done", async () => {
  await sched1({
    cron: undefined,
    runAt: new Date("2026-11-21T09:00:00Z"),
    nextRunAt: new Date("2026-11-21T09:00:00Z"),
  });
  clock = new Date("2026-11-22T12:00:00Z");
  await sched.tick();
  expect(await rows()).toMatchObject([
    { firings: 1, late: true, due_at: new Date("2026-11-21T09:00:00Z") },
  ]);
  expect((await schedRow()).next_run_at).toBeNull();
});

test("an archived target gets no row; the schedule moves on and last_fired_at stays; a one-shot ends done without having run", async () => {
  await t.sql`update agents set archived_at = now() where id = 'ceo'`;
  await sched1();
  await sched1({ id: "s2", cron: undefined, runAt: new Date("2026-11-23T08:00:00Z") });
  clock = new Date("2026-11-23T08:00:00Z");
  await sched.tick();
  expect(await rows()).toHaveLength(0);
  expect(deliver).not.toHaveBeenCalled();
  const a = await schedRow("s1");
  expect([a.next_run_at, a.last_fired_at]).toEqual([new Date("2026-11-24T08:00:00Z"), null]);
  const b = await schedRow("s2");
  expect([b.next_run_at, b.last_fired_at]).toEqual([null, null]);
});

test("101 due schedules take two passes, the second right after the first", async () => {
  for (let i = 0; i < 101; i++)
    await sched1({ id: `m${i}`, nextRunAt: new Date("2026-11-23T08:00:00Z") });
  clock = new Date("2026-11-23T08:00:00Z");
  const spy = vi.spyOn(store, "dueIds");
  await sched.tick();
  const sizes = await Promise.all(spy.mock.results.map(async (r) => (await r.value).length));
  expect(sizes).toEqual([100, 1]);
  expect(await rows()).toHaveLength(101);
});

test("one tick at a time: a tick requested during a tick runs right after it", async () => {
  await sched1();
  clock = new Date("2026-11-23T08:00:00Z");
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const real = store.dueIds.bind(store);
  vi.spyOn(store, "dueIds").mockImplementation(async (...a) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls++;
    if (calls === 1) await gate;
    const r = await real(...a);
    inFlight--;
    return r;
  });
  const first = sched.tick();
  const second = sched.tick();
  release();
  await Promise.all([first, second]);
  expect(maxInFlight).toBe(1);
  expect(calls).toBe(2);
});

test("a firing that throws: fail_count and retry_at back off 5, 10, 20, 40, 60, 60 s; the timer never re-arms at 0", async () => {
  await sched1();
  clock = new Date("2026-11-23T08:00:00Z");
  vi.spyOn(store, "upsertFiring").mockRejectedValue(new Error("boom"));
  const gaps: number[] = [];
  for (let i = 0; i < 6; i++) {
    await sched.tick();
    const s = await schedRow();
    expect(s.fail_count).toBe(i + 1);
    gaps.push((s.retry_at as Date).getTime() - clock.getTime());
    expect(lastTimer()?.ms).toBeGreaterThanOrEqual(1_000);
    clock = s.retry_at as Date;
  }
  expect(gaps).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  expect(await rows()).toHaveLength(0);
});

test("a deadlock is retried once before it counts as a failure", async () => {
  await sched1();
  clock = new Date("2026-11-23T08:00:00Z");
  const real = store.upsertFiring.bind(store);
  const dead = Object.assign(new Error("deadlock detected"), { code: "40P01" });
  const spy = vi.spyOn(store, "upsertFiring").mockRejectedValueOnce(dead);
  await sched.tick();
  expect(spy).toHaveBeenCalledTimes(2);
  expect(await rows()).toHaveLength(1);
  expect((await schedRow()).fail_count).toBe(0);
  spy.mockReset();
  await sched1({ id: "s3" });
  spy.mockRejectedValue(dead);
  await sched.tick();
  expect((await schedRow("s3")).fail_count).toBe(1);
  void real;
});

test("a schedule locked by an edit is skipped and the timer re-arms at least 1 s ahead; it fires on a later tick", async () => {
  await sched1();
  clock = new Date("2026-11-23T08:00:00Z");
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const isReady = new Promise<void>((r) => (ready = r));
  const holder = t.sql.begin(async (tx) => {
    await tx`select id from schedules where id = 's1' for no key update`;
    ready();
    await gate;
  });
  await isReady;
  await sched.tick();
  expect(await rows()).toHaveLength(0);
  expect(lastTimer()?.ms).toBe(1_000);
  release();
  await holder;
  clock = new Date(clock.getTime() + 1_000);
  await sched.tick();
  expect(await rows()).toHaveLength(1);
});

test("retargeted between the unlocked read and the lock: skipped now, fires to the new target next tick", async () => {
  await sched1();
  clock = new Date("2026-11-23T08:00:00Z");
  const real = store.dueIds.bind(store);
  vi.spyOn(store, "dueIds").mockImplementationOnce(async (...a) => {
    const r = await real(...a);
    await t.sql`update schedules set target_agent_id = 'dev' where id = 's1'`;
    return r;
  });
  await sched.tick();
  expect(await rows()).toHaveLength(0);
  await sched.tick();
  expect(await rows()).toMatchObject([{ to_id: "dev" }]);
});

test("rearm before start and after stop does nothing; stop during a tick finishes its transaction and skips the hand-off", async () => {
  await sched1();
  sched.rearm();
  expect(timers).toHaveLength(0);
  clock = new Date("2026-11-23T08:00:00Z");
  sched.start();
  let release!: () => void;
  let inside!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const isInside = new Promise<void>((r) => (inside = r));
  const real = store.upsertFiring.bind(store);
  vi.spyOn(store, "upsertFiring").mockImplementation(async (...a) => {
    inside();
    await gate;
    return real(...a);
  });
  const tick = sched.tick();
  await isInside;
  sched.stop();
  release();
  await tick;
  await sched.idle();
  expect(await rows()).toHaveLength(1); // the transaction committed
  expect(deliver).not.toHaveBeenCalled();
  const before = timers.length;
  sched.rearm();
  expect(timers.length).toBe(before);
  expect(timers.every((x) => x.cleared || x === timers[0])).toBe(true);
});

test("idle() waits for hand-off promises", async () => {
  await sched1();
  clock = new Date("2026-11-23T08:00:00Z");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  deliver.mockImplementation(async () => {
    await gate;
    return undefined;
  });
  await sched.tick();
  let idle = false;
  const p = sched.idle().then(() => (idle = true));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  expect(idle).toBe(false);
  release();
  await p;
  expect(idle).toBe(true);
});

test("a paused or deleted schedule never fires", async () => {
  await sched1({ pausedAt: new Date() });
  await sched1({ id: "s2", deletedAt: new Date() });
  clock = new Date("2026-11-23T08:00:00Z");
  await sched.tick();
  expect(await rows()).toHaveLength(0);
});

test("a row delivered between the commit and the hand-off is not handed over again", async () => {
  await sched1();
  clock = new Date("2026-11-23T08:00:00Z");
  const pendingJoined = vi
    .spyOn(EventStore.prototype, "pendingJoined")
    .mockImplementation(async () => undefined); // the row is no longer pending
  await sched.tick();
  await sched.idle();
  expect(pendingJoined).toHaveBeenCalled();
  expect(deliver).not.toHaveBeenCalled();
});

test("a rearm() during the tick's last earliest() read is not dropped: the timer is re-read once more", async () => {
  sched.start();
  const original = store.earliest.bind(store);
  let first = true;
  vi.spyOn(store, "earliest").mockImplementation(async (...a) => {
    const at = await original(...a);
    if (first) {
      first = false;
      // A schedule committed just after that read, with its rearm() arriving while the tick is still running.
      await sched1({ nextRunAt: new Date("2026-11-20T10:00:20Z") });
      sched.rearm();
    }
    return at;
  });
  await sched.tick();
  expect(lastTimer()?.ms).toBe(20_000);
});

describe("loop guard on agent-authored schedules", () => {
  const FIRE = new Date("2026-11-23T08:00:00Z");
  /** dev and ceo exchanged messages: after dev's schedule fires into ceo, both directions exceed the limit of 2. */
  async function tripPair() {
    const at = new Date(FIRE.getTime() - 60_000).toISOString();
    for (const [from, to, n] of [
      ["dev", "ceo", 2],
      ["ceo", "dev", 3],
    ] as const)
      for (let i = 0; i < n; i++)
        await t.sql`insert into messages (id, kind, from_id, to_id, recipient_ids, body, state, created_at)
          values (${`m-${from}-${i}`}, 'message', ${from}, ${to}, ${[to]}::text[], 'x', 'delivered', ${at})`;
  }
  const devSchedule = (over: Partial<Parameters<typeof insertSchedule>[1]> = {}) =>
    sched1({ createdById: "dev", ...over });
  const scheduled = () =>
    t.sql`select id, state, firings, loop_hold_id from messages where kind = 'scheduled' order by created_at`;

  test("a firing into a pair that tripped is inserted held, opens the hold, and is never handed over", async () => {
    await tripPair();
    await devSchedule();
    clock = FIRE;
    await sched.tick();
    await sched.idle();
    const [row, ...rest] = await scheduled();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ state: "loop_held", firings: 1 });
    const [hold] = await t.sql`select id, resumed_at from loop_holds`;
    expect(hold?.resumed_at).toBeNull();
    expect(row?.loop_hold_id).toBe(hold?.id);
    expect(deliver).not.toHaveBeenCalled();
    expect((await schedRow()).next_run_at).toEqual(new Date("2026-11-24T08:00:00Z"));
    expect(
      await t.sql`select 1 from schedules where id = 's1' and last_fired_at is not null`,
    ).toHaveLength(1);
  });

  test("a second firing while held updates that row in place and hands nothing over", async () => {
    await tripPair();
    await devSchedule({ cron: "0 8 * * *" });
    clock = FIRE;
    await sched.tick();
    await sched.idle();
    clock = new Date("2026-11-25T08:00:00Z"); // one day missed in between
    await sched.tick();
    await sched.idle();
    const rows2 = await scheduled();
    expect(rows2).toHaveLength(1);
    expect(rows2[0]).toMatchObject({ state: "loop_held", firings: 3 });
    expect(deliver).not.toHaveBeenCalled();
  });

  test("a firing row already pending when the hold opened is still delivered and stays pending", async () => {
    await tripPair();
    await devSchedule();
    await insertScheduledMessage(t.sql, {
      id: "early",
      toAgentId: "ceo",
      scheduleId: "s1",
      authorId: "dev",
      createdAt: new Date(FIRE.getTime() - 3_600_000),
    });
    await t.sql`insert into loop_holds (id, agent_a, agent_b, opened_at) values ('h0', 'ceo', 'dev', ${FIRE.toISOString()})`;
    clock = FIRE;
    await sched.tick();
    await sched.idle();
    expect(await scheduled()).toMatchObject([{ id: "early", state: "pending", firings: 2 }]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  test("a human-authored schedule is never checked", async () => {
    await tripPair();
    await sched1();
    clock = FIRE;
    await sched.tick();
    await sched.idle();
    expect(await scheduled()).toMatchObject([{ state: "pending" }]);
    expect(await t.sql`select 1 from loop_holds`).toHaveLength(0);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
