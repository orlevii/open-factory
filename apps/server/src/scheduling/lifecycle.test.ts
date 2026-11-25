import { afterEach, expect, test } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp, signUp, type TestAppOptions } from "../test/helpers.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let driver: FakeDriver;
let clock: Date;
let userId: string;
const timers = { setTimer: () => ({}) as never, clearTimer: () => {} };
const weekday = { cron: "0 9 * * 1-5", timezone: "Europe/Berlin" };

async function boot(factorySettings: TestAppOptions["factorySettings"] = {}) {
  clock = new Date("2026-11-20T10:00:00Z");
  driver = new FakeDriver();
  h = await makeTestApp({
    harnessDriver: driver,
    clock: () => clock,
    schedulerTimers: timers,
    factorySettings,
  });
  userId = (await signUp(h.app, { handle: "or" })).user.id;
}
afterEach(() => h.close());

const idOf = async (slug: string) => (await h.app.store.agentBySlug(slug))?.id as string;
const fireAt = async (iso: string) => {
  clock = new Date(iso);
  await h.app.scheduler.tick();
  await h.app.scheduler.idle();
};
const rows = () =>
  h.sql`select id, state, firings, late, to_agent_id from messages where kind = 'scheduled' order by created_at`;
const make = (target: string, body = "Review", over: Record<string, unknown> = {}) =>
  h.app.schedules.create({ userId }, { target, ...weekday, body, ...over });
const settle = async (slug: string) => (await h.app.runtimes.bySlug(slug))?.settled();

test("terminating a spawned target soft-deletes its schedules and rejects its pending rows in the same transaction; Restore refuses", async () => {
  await boot();
  await h.seedAgent({ slug: "lead" });
  await h.seedAgent({ slug: "kid" });
  await h.sql`update agents set kind = 'ephemeral', reports_to = ${await idOf("lead")} where slug = 'kid'`;
  await h.sql`update agents set status = 'errored' where slug = 'kid'`; // keeps its row pending
  const { item } = await make("kid");
  await fireAt("2026-11-23T08:00:00Z");
  expect(await rows()).toMatchObject([{ state: "pending" }]);
  await h.app.terminator.terminate(await idOf("kid"), "@or");
  expect(await rows()).toMatchObject([{ state: "rejected" }]);
  const got = await h.app.schedules.get(item.key, { includeDeleted: true });
  expect(got).toMatchObject({ deleted: true, nextRunAt: null, target: { terminated: true } });
  expect(await h.app.schedules.get(item.key)).toBeUndefined();
  await expect(h.app.schedules.restore({ userId }, item.key)).rejects.toMatchObject({
    code: "target_ended",
    status: 409,
    message: "@kid was terminated.",
  });
});

test("archived target: firings skip; unarchive recomputes from now without catch-up", async () => {
  await boot();
  await h.seedAgent({ slug: "ceo" });
  const { item } = await make("ceo");
  await h.app.agents.archive("ceo", { kind: "human", handle: "or" });
  await fireAt("2026-11-23T08:00:00Z");
  expect(await rows()).toHaveLength(0);
  expect((await h.app.schedules.get(item.key))?.state).toBe("skipped_archived");
  clock = new Date("2026-11-26T12:00:00Z"); // three runs passed while archived
  await h.app.agents.unarchive("ceo", { kind: "human", handle: "or" });
  const s = await h.app.schedules.get(item.key);
  expect(s).toMatchObject({ state: "active", nextRunAt: "2026-11-27T08:00:00.000Z" });
  await h.app.scheduler.tick();
  await h.app.scheduler.idle();
  expect(await rows()).toHaveLength(0); // no catch-up
});

test("an archived persistent creator's schedules keep firing", async () => {
  await boot();
  await h.seedAgent({ slug: "ceo" });
  await h.seedAgent({ slug: "dev" });
  const { item } = await h.app.schedules.create(
    { agentId: await idOf("dev") },
    { target: "ceo", ...weekday, body: "x" },
  );
  await h.app.agents.archive("dev", { kind: "human", handle: "or" });
  await fireAt("2026-11-23T08:00:00Z");
  expect(await rows()).toHaveLength(1);
  expect((await h.app.schedules.get(item.key))?.createdBy).toMatchObject({
    kind: "agent",
    slug: "dev",
    archived: true,
  });
});

test("an errored target: the row is pending and the item says so; no attempt starts", async () => {
  await boot();
  await h.seedAgent({ slug: "ceo" });
  await h.sql`update agents set status = 'errored', error_kind = 'start' where slug = 'ceo'`;
  const { item } = await make("ceo");
  await fireAt("2026-11-23T08:00:00Z");
  await settle("ceo");
  expect(driver.starts).toHaveLength(0);
  expect(await h.app.schedules.get(item.key)).toMatchObject({
    state: "pending_errored",
    pendingFiring: true,
  });
});

test("a mid-turn target gets the row written at once", async () => {
  await boot();
  await h.seedAgent({ slug: "ceo" });
  await h.app.runtimes.bySlug("ceo");
  const row = await h.app.store.createMessage({
    from: { userId },
    toAgentId: await idOf("ceo"),
    recipients: ["@test"],
    body: "go",
    urgent: false,
  });
  await (await h.app.runtimes.bySlug("ceo"))?.deliver(await h.app.store.pendingRow(row.id), {
    sender: "human",
    fromLabel: "@or",
  });
  const p = driver.starts.at(-1);
  p?.emit(ev.session(), ev.turn()); // a turn is open
  await settle("ceo");
  await make("ceo", "mid-turn");
  await fireAt("2026-11-23T08:00:00Z");
  await settle("ceo");
  const sent = (p?.sent ?? []).flat().filter((m) => m.kind === "scheduled");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.body).toBe("mid-turn");
});

test("a server stopped between commit and hand-off: boot wakes the target and delivers the row exactly once", async () => {
  await boot();
  await h.seedAgent({ slug: "ceo" });
  await make("ceo");
  clock = new Date("2026-11-23T08:00:00Z");
  // Shutdown began: the committed row's hand-off is skipped (the scheduler is stopped after its tick started).
  const real = h.app.runtimes.deliver.bind(h.app.runtimes);
  let handedOver = 0;
  h.app.runtimes.deliver = (async (...a: Parameters<typeof real>) => {
    handedOver++;
    return real(...a);
  }) as typeof h.app.runtimes.deliver;
  // The frame is published right after the commit and before the hand-off: shutdown begins there.
  const publish = h.app.bus.publishAll.bind(h.app.bus);
  h.app.bus.publishAll = (m) => {
    if (m.type === "schedules_changed") h.app.scheduler.stop();
    publish(m);
  };
  const tick = h.app.scheduler.tick();
  await tick;
  await h.app.scheduler.idle();
  h.app.runtimes.deliver = real;
  const written = await rows();
  expect(written).toHaveLength(1);
  expect(handedOver).toBe(0);
  expect(driver.starts).toHaveLength(0);
  // the next boot: bootWakes counts the scheduled row and wakes the target
  const wakes = await h.app.store.bootWakes();
  expect(wakes.map((w) => w.slug)).toEqual(["ceo"]);
  await (await h.app.runtimes.bySlug("ceo"))?.bootWake("boot");
  await settle("ceo");
  expect(driver.starts).toHaveLength(1);
  const p = driver.starts.at(-1);
  p?.emit(ev.session(), ev.turn());
  await settle("ceo");
  expect((p?.sent ?? []).flat().filter((m) => m.kind === "scheduled")).toHaveLength(1);
  expect(await rows()).toMatchObject([{ state: "delivered" }]);
});
