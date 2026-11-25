import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { EventStore } from "../agents/event-store.ts";
import { insertAgent, insertScheduledMessage } from "../agents/testing/rows.ts";
import { claimTestHandleSql } from "../test/handles.ts";
import { createTestDb } from "../test/helpers.ts";
import { MAX_AGENT_SCHEDULES } from "./limits.ts";
import { type Actor, ScheduleService } from "./schedule-service.ts";
import { ScheduleStore } from "./schedule-store.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let svc: ScheduleService;
let clock: Date;
let changed = 0;
let statuses: Record<string, string> = {};
const NOW = new Date("2026-11-20T10:00:00Z"); // Friday 11:00 Berlin
const or: Actor & { userId: string } = { userId: "u1" };
const agent = (id: string): Actor => ({ agentId: id });
const weekday = { cron: "0 9 * * 1-5", timezone: "Europe/Berlin", body: "Review" };

beforeAll(async () => {
  t = await createTestDb();
  await claimTestHandleSql(t.sql, "or", "user");
  await claimTestHandleSql(t.sql, "jo", "user");
  await t.sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or'), ('u2', 'Jo', 'jo@x.io', 'jo')`;
});
afterAll(() => t.close());
beforeEach(async () => {
  clock = NOW;
  changed = 0;
  statuses = {};
  await t.sql`delete from messages`;
  await t.sql`delete from schedules`;
  await t.sql`delete from agents`;
  await t.sql`delete from credentials`;
  await insertAgent(t.sql, { id: "ceo", slug: "ceo", displayName: "CEO" });
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
    statusOf: (a) => statuses[a.id],
  });
});

const mk = async (over: Record<string, unknown> = {}, actor: Actor = or) =>
  (await svc.create(actor, { target: "ceo", ...weekday, ...over })).item;
const dbRow = async (key: string) =>
  (await t.sql`select * from schedules where number = ${Number(key.slice(2))}`)[0] as Record<
    string,
    unknown
  >;
const rejects = (
  p: Promise<unknown>,
  m: Partial<{ code: string; status: number; message: string }>,
) => expect(p).rejects.toMatchObject(m);

test("edit only the body: the editor becomes its author, creator and next run stay", async () => {
  const s = await mk({}, agent("dev"));
  const r = await svc.edit(or, s.key, { body: "New text" });
  expect(r.body).toBe("New text");
  expect(r.bodyAuthor).toEqual({ kind: "user", handle: "or" });
  expect(r.createdBy).toMatchObject({ kind: "agent", slug: "dev" });
  expect(r.nextRunAt).toBe(s.nextRunAt);
});

test("edit only the target is re-checked live", async () => {
  const s = await mk();
  expect((await svc.edit(or, s.key, { target: "dev" })).target.slug).toBe("dev");
  await insertAgent(t.sql, { id: "old", slug: "old", archived: true });
  await rejects(svc.edit(or, s.key, { target: "old" }), { code: "target_ended" });
  await rejects(svc.edit(or, s.key, { target: "nobody" }), { code: "target_not_found" });
});

test("editing timing recomputes from now; cron to at and back", async () => {
  const s = await mk();
  clock = new Date("2026-11-23T09:30:00Z"); // Monday 10:30 Berlin, after the 09:00 run
  const a = await svc.edit(or, s.key, { cron: "0 9 * * *" });
  expect(a.nextRunAt).toBe("2026-11-24T08:00:00.000Z");
  const b = await svc.edit(or, s.key, { at: "2026-12-01T09:00" });
  expect(b).toMatchObject({
    at: "2026-12-01T08:00:00.000Z",
    nextRunAt: "2026-12-01T08:00:00.000Z",
  });
  expect(b.cron).toBeUndefined();
  const c = await svc.edit(or, s.key, { cron: "0 9 * * 1-5" });
  expect(c.cron).toBe("0 9 * * 1-5");
  expect(c.at).toBeUndefined();
  const d = await svc.edit(or, s.key, { timezone: "UTC" });
  expect(d).toMatchObject({ timezone: "UTC", nextRunAt: "2026-11-24T09:00:00.000Z" });
  await rejects(svc.edit(or, s.key, { cron: "0 9 * * *", at: "2026-12-01T09:00" }), {
    message: "Pass either cron or at.",
  });
  await rejects(svc.edit(or, s.key, { cron: "@daily" }), { status: 400 });
  await rejects(svc.edit(or, s.key, { at: "2026-11-01T09:00" }), {
    message: "That time has passed.",
  });
});

test("edits leave a pending firing exactly as fired and clear the firing backoff", async () => {
  const s = await mk();
  const row = await dbRow(s.key);
  await insertScheduledMessage(t.sql, {
    id: "pm",
    toAgentId: "ceo",
    scheduleId: row.id as string,
    body: "old body",
  });
  await t.sql`update schedules set fail_count = 3, retry_at = now() where id = ${row.id as string}`;
  await svc.edit(or, s.key, { body: "new", target: "dev" });
  const [m] =
    await t.sql`select body, to_agent_id, state, author_user_id from messages where id = 'pm'`;
  expect(m).toEqual({
    body: "old body",
    to_agent_id: "ceo",
    state: "pending",
    author_user_id: "u1",
  });
  const after = await dbRow(s.key);
  expect([after.fail_count, after.retry_at]).toEqual([0, null]);
});

test("a done one-shot: its message can be edited, and a future time makes it active again", async () => {
  const s = await mk({ cron: undefined, at: "2026-11-21T09:00", timezone: "UTC" });
  clock = new Date("2026-11-22T00:00:00Z");
  await t.sql`update schedules set next_run_at = null, last_fired_at = ${"2026-11-21T09:00:00Z"} where number = ${Number(s.key.slice(2))}`;
  const edited = await svc.edit(or, s.key, { body: "Still relevant" });
  expect(edited).toMatchObject({
    body: "Still relevant",
    state: "done",
    done: true,
    ran: true,
    nextRunAt: null,
  });
  const again = await svc.edit(or, s.key, { at: "2026-11-30T09:00" });
  expect(again).toMatchObject({
    state: "active",
    done: false,
    nextRunAt: "2026-11-30T09:00:00.000Z",
  });
});

test("pause and resume: conflicts, and resume does not catch up", async () => {
  const s = await mk();
  await rejects(svc.resume(or, s.key), { code: "not_paused", status: 409 });
  expect((await svc.pause(or, s.key)).state).toBe("paused");
  await rejects(svc.pause(or, s.key), { code: "already_paused", status: 409 });
  clock = new Date("2026-11-26T12:00:00Z"); // three weekday runs passed (Mon, Tue, Wed... Thu 09:00 too)
  const r = await svc.resume(or, s.key);
  expect(r).toMatchObject({
    state: "active",
    paused: false,
    nextRunAt: "2026-11-27T08:00:00.000Z",
  });
  const once = await mk({ cron: undefined, at: "2026-11-30T09:00", timezone: "UTC" });
  await t.sql`update schedules set next_run_at = null where number = ${Number(once.key.slice(2))}`;
  await rejects(svc.pause(or, once.key), { code: "schedule_done", status: 409 });
  await rejects(svc.resume(or, once.key), { code: "schedule_done", status: 409 });
});

test("delete is soft: excluded from lists, counts and the agent limit; its pending row stays pending", async () => {
  const s = await mk({}, agent("dev"));
  const row = await dbRow(s.key);
  await insertScheduledMessage(t.sql, { id: "pm", toAgentId: "ceo", scheduleId: row.id as string });
  const gone = await svc.remove(or, s.key);
  expect(gone).toMatchObject({ deleted: true, nextRunAt: null });
  expect((await svc.list()).items).toEqual([]);
  expect(await svc.listForAgent("dev")).toEqual([]);
  expect(await svc.scheduleCountFor("ceo")).toBe(0);
  expect(await svc.get(s.key)).toBeUndefined();
  expect((await svc.get(s.key, { includeDeleted: true }))?.deleted).toBe(true);
  const [m] = await t.sql`select state from messages where id = 'pm'`;
  expect(m?.state).toBe("pending");
  for (let i = 0; i < MAX_AGENT_SCHEDULES; i++)
    await svc.create(agent("dev"), { target: "ceo", ...weekday });
  await rejects(svc.edit(or, s.key, { body: "x" }), { code: "schedule_not_found", status: 404 });
  await rejects(svc.pause(or, s.key), { code: "schedule_not_found" });
  await rejects(svc.resume(or, s.key), { code: "schedule_not_found" });
  await rejects(svc.remove(or, s.key), { code: "schedule_not_found" });
});

test("restore recomputes from now and brings a passed one-shot back done", async () => {
  const s = await mk({}, agent("dev"));
  await svc.remove(or, s.key);
  clock = new Date("2026-11-24T12:00:00Z");
  const r = await svc.restore(or, s.key);
  expect(r).toMatchObject({ state: "active", nextRunAt: "2026-11-25T08:00:00.000Z" });
  expect(r.deleted).toBeUndefined();
  const once = await mk({ cron: undefined, at: "2026-11-30T09:00", timezone: "UTC" }, agent("dev"));
  await svc.remove(or, once.key);
  clock = new Date("2026-12-02T00:00:00Z");
  const done = await svc.restore(or, once.key);
  expect(done).toMatchObject({ state: "done", done: true, ran: false, nextRunAt: null });
});

test("a human-created schedule's restore isn't bound by an agent's limit", async () => {
  // dev's one active schedule, plus 19 more, puts it at its 20; the human's restore doesn't count against dev.
  await mk({}, agent("dev"));
  for (let i = 1; i < MAX_AGENT_SCHEDULES; i++)
    await svc.create(agent("dev"), { target: "ceo", ...weekday });
  await rejects(svc.create(agent("dev"), { target: "ceo", ...weekday }), {
    code: "schedule_limit",
  });
  const extra = await svc.create(or, { target: "ceo", ...weekday });
  await svc.remove(or, extra.item.key);
  expect(await svc.restore(or, extra.item.key)).toMatchObject({ state: "active" });
});

test("restore is refused when the target ended", async () => {
  await insertAgent(t.sql, { id: "kid", slug: "kid" });
  await t.sql`update agents set kind = 'ephemeral', reports_to = 'ceo', reports_to_user = null where id = 'kid'`;
  const s = await mk({ target: "kid" });
  await svc.remove(or, s.key);
  await t.sql`update agents set terminated_at = now(), terminated_by = '@or' where id = 'kid'`;
  await rejects(svc.restore(or, s.key), {
    code: "target_ended",
    status: 409,
    message: "@kid was terminated.",
  });
  const a = await mk({ target: "dev" });
  await svc.remove(or, a.key);
  await t.sql`update agents set archived_at = now() where id = 'dev'`;
  await rejects(svc.restore(or, a.key), { code: "target_ended", status: 409 });
});

test("cancelForAgent: own works, another's and a human's are refused with who can, unknown or deleted say so", async () => {
  const own = await mk({}, agent("dev"));
  const human = await mk();
  const other = await mk({}, agent("ceo"));
  await rejects(svc.cancelForAgent("dev", human.key), {
    message: `${human.key} was created by @or; only its creator or a human can cancel it.`,
  });
  await rejects(svc.cancelForAgent("dev", other.key), {
    message: `${other.key} was created by @ceo; only its creator or a human can cancel it.`,
  });
  await rejects(svc.cancelForAgent("dev", "S-999"), { message: "There is no schedule S-999." });
  expect(await svc.cancelForAgent("dev", own.key.toLowerCase())).toEqual({
    id: own.key,
    status: "cancelled",
  });
  await rejects(svc.cancelForAgent("dev", own.key), {
    message: `There is no schedule ${own.key}.`,
  });
});

test("list states, order, target and done filters", async () => {
  const a2 = await mk({ cron: "0 10 * * *" }); // later
  const a1 = await mk({ cron: "0 9 * * *" });
  const p = await mk({ cron: "0 8 * * *" });
  await svc.pause(or, p.key);
  const d1 = await mk({ cron: undefined, at: "2026-11-21T09:00", timezone: "UTC" });
  const d2 = await mk({ cron: undefined, at: "2026-11-22T09:00", timezone: "UTC" });
  await t.sql`update schedules set next_run_at = null, last_fired_at = ${"2026-11-21T09:00:00Z"} where number = ${Number(d1.key.slice(2))}`;
  await t.sql`update schedules set next_run_at = null where number = ${Number(d2.key.slice(2))}`; // never ran
  const arch = await mk({ target: "dev", cron: "0 11 * * *" });
  await t.sql`update agents set archived_at = now() where id = 'dev'`;
  const pending = await mk({ cron: "0 12 * * *" });
  await insertScheduledMessage(t.sql, {
    id: "pm",
    toAgentId: "ceo",
    scheduleId: (await dbRow(pending.key)).id as string,
  });
  statuses.ceo = "errored";

  const shown = (await svc.list()).items;
  expect(shown.map((i) => [i.key, i.state])).toEqual([
    [pending.key, "pending_errored"],
    [a1.key, "active"],
    [a2.key, "active"],
    [arch.key, "skipped_archived"],
    [p.key, "paused"],
  ]);
  const withDone = (await svc.list({ done: true })).items;
  expect(withDone.map((i) => [i.key, i.state, i.ran])).toEqual([
    [pending.key, "pending_errored", undefined],
    [a1.key, "active", undefined],
    [a2.key, "active", undefined],
    [arch.key, "skipped_archived", undefined],
    [p.key, "paused", undefined],
    [d2.key, "done", false],
    [d1.key, "done", true],
  ]);
  expect((await svc.list({ target: "dev" })).items.map((i) => i.key)).toEqual([arch.key]);
});

test("listForAgent: created by it or targeting it, not done, newest first; bodies capped at 2,000 characters", async () => {
  const mine = await mk({ target: "dev", body: "x".repeat(2500) }, agent("dev"));
  const toMe = await mk({ target: "dev" });
  const fromMe = await mk({ target: "ceo" }, agent("dev"));
  await mk({ target: "ceo" }, agent("ceo")); // unrelated
  const done = await mk({
    cron: undefined,
    at: "2026-11-21T09:00",
    timezone: "UTC",
    target: "dev",
  });
  await t.sql`update schedules set next_run_at = null where number = ${Number(done.key.slice(2))}`;
  const list = await svc.listForAgent("dev");
  expect(list.map((x) => x.id)).toEqual([fromMe.key, toMe.key, mine.key]);
  expect(list[2]).toMatchObject({
    to: "dev",
    created_by: "dev",
    by: "dev",
    cron: "0 9 * * 1-5",
    timezone: "Europe/Berlin",
    next_run: "2026-11-23T09:00:00+01:00",
    paused: false,
    yours: true,
    truncated: true,
  });
  expect(list[2]?.body).toHaveLength(2000);
  expect(list[1]).toMatchObject({ created_by: "@or", by: "@or", yours: false });
  expect(list[1]?.truncated).toBeUndefined();
});

test("scheduleCountFor counts what targets the agent: not deleted, not done", async () => {
  const a = await mk();
  await mk();
  const d = await mk({ cron: undefined, at: "2026-11-21T09:00", timezone: "UTC" });
  await t.sql`update schedules set next_run_at = null where number = ${Number(d.key.slice(2))}`;
  await svc.remove(or, a.key);
  expect(await svc.scheduleCountFor("ceo")).toBe(1);
});

test("every change calls onChanged once after its commit", async () => {
  const s = await mk();
  const before = changed;
  await svc.edit(or, s.key, { body: "y" });
  await svc.pause(or, s.key);
  await svc.resume(or, s.key);
  await svc.remove(or, s.key);
  await svc.restore(or, s.key);
  expect(changed - before).toBe(5);
});

test("review 1: a timezone-only change of a one-shot is refused (the time must be re-entered with the zone)", async () => {
  const s = await mk({ cron: undefined, at: "2026-12-01T09:00", timezone: "Europe/Berlin" });
  await rejects(svc.edit(or, s.key, { timezone: "Asia/Tokyo" }), {
    code: "invalid_schedule",
    status: 400,
    message: "Change the time as well when you change a one-time schedule's time zone.",
  });
  const ok = await svc.edit(or, s.key, { timezone: "Asia/Tokyo", at: "2026-12-01T09:00" });
  expect(ok).toMatchObject({ timezone: "Asia/Tokyo", at: "2026-12-01T00:00:00.000Z" });
});

test("review 3: restore can't push an agent past its 20 schedules (delete then restore beyond 20)", async () => {
  const first = await mk({}, agent("dev"));
  await svc.remove(or, first.key);
  for (let i = 0; i < MAX_AGENT_SCHEDULES; i++)
    await svc.create(agent("dev"), { target: "ceo", ...weekday });
  await rejects(svc.restore(or, first.key), {
    code: "schedule_limit",
    message: "@dev already has 20 schedules; delete one first.",
  });
  expect(await svc.get(first.key)).toBeUndefined();
});

test("review 7: list_schedules never cuts a body inside a surrogate pair", async () => {
  const s = await mk({ body: `${"x".repeat(1999)}😀tail` }, agent("dev"));
  const [v] = await svc.listForAgent("dev");
  expect(v?.id).toBe(s.key);
  expect(v?.truncated).toBe(true);
  expect(v?.body).toBe(`${"x".repeat(1999)}😀`); // 2,000 characters, the emoji whole
  expect(v?.body.at(-1)).not.toMatch(/[\ud800-\udbff]/);
});
