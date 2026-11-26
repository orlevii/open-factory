import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { EventStore } from "../agents/event-store.ts";
import { insertAgent } from "../agents/testing/rows.ts";
import { createTestDb } from "../test/helpers.ts";
import { principalSql, testRef } from "../test/principals.ts";
import { MAX_AGENT_SCHEDULES } from "./limits.ts";
import { type Actor, ScheduleService } from "./schedule-service.ts";
import { ScheduleStore } from "./schedule-store.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let svc: ScheduleService;
let clock = new Date("2026-11-20T10:00:00Z");
let changed = 0;
const NOW = new Date("2026-11-20T10:00:00Z");
const or: Actor = { kind: "human", id: "u1" };
const agent = (id: string): Actor => ({ kind: "agent", id });

beforeAll(async () => {
  t = await createTestDb();
  await t.sql.unsafe(principalSql("u1", "human", "or"));
  await t.sql`insert into users (id, name, email) values ('u1', 'Or', 'or@x.io')`;
});
afterAll(() => t.close());
beforeEach(async () => {
  clock = NOW;
  changed = 0;
  await t.sql`delete from messages`;
  await t.sql`delete from schedules`;
  await t.sql`delete from agents`;
  await t.sql`delete from credentials`;
  await insertAgent(t.sql, { id: "ceo", slug: "ceo" });
  await insertAgent(t.sql, { id: "dev", slug: "dev" });
  svc = new ScheduleService({
    db: t.db,
    store: new EventStore(t.db),
    schedules: new ScheduleStore(),
    now: () => clock,
    factoryZone: "Europe/Berlin",
    onChanged: () => {
      changed += 1;
    },
  });
});

const weekday = { cron: "0 9 * * 1-5", timezone: "Europe/Berlin", body: "Review" };
const rejects = (p: Promise<unknown>, message: string) =>
  expect(p).rejects.toMatchObject({ message });

test("a human creates a weekday cron: authored by them, next run computed from the injected clock", async () => {
  const { item } = await svc.create(or, { target: "ceo", ...weekday });
  expect(item).toMatchObject({
    key: "S-1",
    cron: "0 9 * * 1-5",
    timezone: "Europe/Berlin",
    nextRunAt: "2026-11-23T08:00:00.000Z",
    createdBy: { kind: "human", ref: testRef("u1"), handle: "or" },
    bodyAuthor: { kind: "human", ref: testRef("u1"), handle: "or" },
    state: "active",
    target: { slug: "ceo" },
  });
  const [row] = await t.sql`select created_by_id, body_author_id from schedules`;
  expect(row).toEqual({ created_by_id: "u1", body_author_id: "u1" });
  expect(changed).toBe(1);
});

test("an agent's target defaults to itself, and 'me' and '@slug' resolve", async () => {
  for (const to of [undefined, "me", "@dev", "dev"]) {
    const { item } = await svc.create(agent("dev"), { ...(to ? { target: to } : {}), ...weekday });
    expect(item.target.slug).toBe("dev");
    expect(item.createdBy).toMatchObject({ kind: "agent", handle: "dev" });
  }
  const { item } = await svc.create(agent("dev"), { target: "@ceo", ...weekday });
  expect(item.target.slug).toBe("ceo");
});

test("a note for an agent: recurring to itself, and an errored target", async () => {
  const self = await svc.create(agent("dev"), weekday);
  expect(self.note).toBe(
    "You will be woken at each run; cancel it with cancel_schedule when it is no longer needed.",
  );
  const errSvc = new ScheduleService({
    db: t.db,
    store: new EventStore(t.db),
    schedules: new ScheduleStore(),
    now: () => clock,
    factoryZone: "UTC",
    onChanged: () => {},
    statusOf: (a) => (a.id === "ceo" ? "errored" : undefined),
  });
  const other = await errSvc.create(agent("dev"), { target: "ceo", ...weekday });
  expect(other.note).toBe(
    "@ceo is errored; it will see this after it is restarted (restart_agent, or a human).",
  );
});

test("exactly one of cron and at", async () => {
  const sentence = "Pass either cron or at.";
  await rejects(svc.create(or, { target: "ceo", timezone: "UTC", body: "x" }), sentence);
  await rejects(
    svc.create(or, {
      target: "ceo",
      cron: "0 9 * * *",
      at: "2026-12-01T09:00",
      timezone: "UTC",
      body: "x",
    }),
    sentence,
  );
});

test("the 15-minute floor applies to agents only", async () => {
  const floor =
    "Schedules can't fire more often than every 15 minutes. For a short loop inside this session, use CronCreate.";
  await rejects(
    svc.create(agent("dev"), { cron: "*/5 * * * *", timezone: "UTC", body: "x" }),
    floor,
  );
  await svc.create(agent("dev"), { cron: "*/15 * * * *", timezone: "UTC", body: "x" });
  await svc.create(or, { target: "ceo", cron: "* * * * *", timezone: "UTC", body: "x" });
});

test("at: the past is refused for everyone, a year out only for agents", async () => {
  await rejects(
    svc.create(or, { target: "ceo", at: "2026-11-20T09:00:00Z", timezone: "UTC", body: "x" }),
    "That time has passed.",
  );
  await rejects(
    svc.create(agent("dev"), { at: "2026-11-20T10:00:00Z", timezone: "UTC", body: "x" }),
    "That time has passed.",
  );
  const far = "2027-12-30T10:00";
  await rejects(
    svc.create(agent("dev"), { at: far, timezone: "UTC", body: "x" }),
    "Pick a time within the next year.",
  );
  await svc.create(or, { target: "ceo", at: far, timezone: "UTC", body: "x" });
  const ok = await svc.create(agent("dev"), { at: "2027-11-20T10:00", timezone: "UTC", body: "x" });
  expect(ok.item.at).toBe("2027-11-20T10:00:00.000Z");
});

const nth = (k: number, set: string) =>
  t.sql.unsafe(
    `update schedules set ${set} where id = (select id from schedules order by number limit 1 offset ${k})`,
  );

test("the 21st active schedule of an agent is refused; paused count, deleted and done don't", async () => {
  for (let i = 0; i < MAX_AGENT_SCHEDULES; i++) await svc.create(agent("dev"), weekday);
  const limit = "You already have 20 schedules; cancel one first (list_schedules shows them).";
  await rejects(svc.create(agent("dev"), weekday), limit);
  await nth(0, "paused_at = now()");
  await rejects(svc.create(agent("dev"), weekday), limit);
  await nth(1, "deleted_at = now(), next_run_at = null");
  await svc.create(agent("dev"), weekday);
  await rejects(svc.create(agent("dev"), weekday), limit);
  await nth(2, "cron = null, run_at = now(), next_run_at = null");
  await svc.create(agent("dev"), weekday);
  // another agent's count is its own, and a human has none
  await svc.create(agent("ceo"), weekday);
  await svc.create(or, { target: "ceo", ...weekday });
});

test("targets: unknown, humans, a handle, reserved, archived and terminated", async () => {
  await insertAgent(t.sql, { id: "old", slug: "old", archived: true });
  await insertAgent(t.sql, {
    id: "gone",
    slug: "gone",
    terminatedAt: new Date(),
    reportsTo: "ceo",
  });
  const to = (target: string) => svc.create(or, { target, ...weekday });
  await expect(to("nobody")).rejects.toMatchObject({ code: "target_not_found" });
  await expect(to("@humans")).rejects.toMatchObject({ code: "reserved" });
  await expect(to("@or")).rejects.toMatchObject({
    message: "Schedules can only be addressed to agents.",
  });
  await expect(to("system")).rejects.toMatchObject({ code: "reserved" });
  await expect(to("old")).rejects.toMatchObject({
    code: "target_ended",
    status: 409,
    message: "@old is archived and can't receive messages.",
  });
  await expect(to("gone")).rejects.toMatchObject({
    code: "target_ended",
    message: "@gone was terminated and can't receive messages.",
  });
});

test("a caller terminated meanwhile is refused", async () => {
  await insertAgent(t.sql, {
    id: "gone",
    slug: "gone",
    terminatedAt: new Date(),
    reportsTo: "ceo",
  });
  await rejects(
    svc.create(agent("gone"), { target: "ceo", ...weekday }),
    "You can't schedule messages: you were terminated.",
  );
});

test("a spawned agent can be a target", async () => {
  await t.sql`update agents set kind = 'ephemeral', reports_to = 'ceo' where id = 'dev'`;
  const { item } = await svc.create(or, { target: "dev", ...weekday });
  expect(item.target.slug).toBe("dev");
});

async function waitForLocks(n: number): Promise<void> {
  for (;;) {
    const r =
      await t.sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`;
    if (r.length >= n) return;
    await new Promise((res) => setImmediate(res));
  }
}

test("two concurrent creates by one agent at 19 are serialised by its row lock: one succeeds, one is refused", async () => {
  for (let i = 0; i < MAX_AGENT_SCHEDULES - 1; i++) await svc.create(agent("dev"), weekday);
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const isReady = new Promise<void>((r) => (ready = r));
  const holder = t.sql.begin(async (tx) => {
    await tx`select id from agents where id = 'dev' for no key update`;
    ready();
    await gate;
  });
  await isReady;
  const a = svc.create(agent("dev"), weekday);
  const b = svc.create(agent("dev"), weekday);
  const settled = Promise.allSettled([a, b]);
  await waitForLocks(2);
  release();
  await holder;
  const [ra, rb] = await settled;
  expect([ra?.status, rb?.status].sort()).toEqual(["fulfilled", "rejected"]);
  const [{ n }] = (await t.sql`select count(*)::int as n from schedules`) as unknown as [
    { n: number },
  ];
  expect(n).toBe(MAX_AGENT_SCHEDULES);
});

test("A schedules for B while B schedules for A: no deadlock escapes, both succeed", async () => {
  await insertAgent(t.sql, { id: "kid", slug: "kid" });
  await t.sql`update agents set kind = 'ephemeral', reports_to = 'ceo' where id = 'kid'`;
  for (let i = 0; i < 15; i++) {
    const res = await Promise.all([
      svc.create(agent("ceo"), { target: "dev", ...weekday }),
      svc.create(agent("dev"), { target: "ceo", ...weekday }),
      svc.create(or, { target: "kid", ...weekday }),
    ]);
    expect(res).toHaveLength(3);
  }
});

test("a spawned agent can't create schedules even when called directly (Q12)", async () => {
  await t.sql`update agents set kind = 'ephemeral', reports_to = 'ceo' where id = 'dev'`;
  await expect(svc.create(agent("dev"), { target: "ceo", ...weekday })).rejects.toMatchObject({
    code: "forbidden",
    message: "Spawned agents can't schedule messages.",
  });
});

test("review 4: an empty cron is not 'absent': it gets the field sentence", async () => {
  await rejects(
    svc.create(or, { target: "ceo", cron: "", timezone: "UTC", body: "x" }),
    "Use 5 fields, like 0 9 * * 1-5.",
  );
  await rejects(
    svc.create(or, { target: "ceo", at: "", timezone: "UTC", body: "x" }),
    "Use an ISO 8601 date and time, such as 2026-11-23T09:00.",
  );
});
