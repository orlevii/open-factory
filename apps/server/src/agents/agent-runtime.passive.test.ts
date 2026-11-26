import { tagOf } from "@open-factory/shared/tags";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { principalSql, testRef } from "../test/principals.ts";
import { AgentRuntime } from "./agent-runtime.ts";
import { EventBus } from "./event-bus.ts";
import { EventStore } from "./event-store.ts";
import { liveCredentialId } from "./live-credential.ts";
import { notices } from "./notices.ts";
import { ev, FakeDriver } from "./testing/fake-driver.ts";
import { insertAgent } from "./testing/rows.ts";
import { noForward, noopTokens, sendAs, testEffective } from "./testing/runtime-harness.ts";
import { RecordingSlots } from "./testing/slots.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
let n = 0;
beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  await t.sql.unsafe(principalSql("u1", "human", "or"));
  await t.sql`insert into users (id, name, email) values ('u1', 'Or', 'or@x.io')`;
});
afterAll(() => t.close());

let driver: FakeDriver;
let rt: AgentRuntime;
let id: string;
const forwarded: unknown[] = [];
async function make(o: { spawned?: boolean } = {}) {
  n += 1;
  id = `p${n}`;
  if (o.spawned) {
    await insertAgent(t.sql, { id: `lead${n}`, slug: `lead${n}` });
    await insertAgent(t.sql, { id, slug: `pas${n}`, reportsTo: `lead${n}` });
    await t.sql`update agents set kind = 'ephemeral' where id = ${id}`;
  } else await insertAgent(t.sql, { id, slug: `pas${n}` });
  driver = new FakeDriver();
  forwarded.length = 0;
  const agent = await store.agentById(id);
  if (!agent) throw new Error("no agent");
  rt = new AgentRuntime({
    tokens: noopTokens,
    forward: async (f) => void forwarded.push(f),
    agent,
    store,
    bus: new EventBus(),
    driver,
    prepareStart: async (a) => ({
      credentialId: liveCredentialId(a),
      agentId: a.id,
      ref: a.id,
      cwd: "/w",
      env: {},
      claudeBin: "claude",
      runtime: "local",
      permissionMode: "auto",
      mounts: [],
      effective: testEffective(),
    }),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    slots: new RecordingSlots(),
  });
  await rt.init();
}
void noForward;
beforeEach(() => make());

const notice = () =>
  store.createNotice({
    toAgentId: id,
    notice: "crons_stopped",
    body: "@or stopped your crons: every 5 minutes.",
  });
const send = (body: string) => sendAs(store, rt, { fromUserId: "u1", body, urgent: false });
async function runIdle() {
  await send("boot");
  driver.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
  await rt.settled();
}

test("only the passive notice queued: not deliverable, no boot wake", async () => {
  await notice();
  await rt.init();
  expect(rt.hasDeliverable()).toBe(false);
  expect((await store.bootWakes()).map((w) => w.id)).not.toContain(id);
  // a real notice still counts
  await store.createNotice({ toAgentId: id, notice: "restart", body: "x" });
  expect((await store.bootWakes()).map((w) => w.id)).toContain(id);
});

test("a running idle process is never sent the passive notice alone; the exit doesn't wake it for it", async () => {
  await runIdle();
  await rt.postNotice("crons_stopped", "@or stopped your crons: every 5 minutes.");
  expect(driver.last.sent).toHaveLength(1); // only the boot batch
  expect(rt.queueItems().map((q) => q.kind)).toEqual(["notice"]);
  expect(rt.hibernatable()).toBe(true);
  await rt.hibernate("warm_window");
  await rt.settled();
  expect(driver.starts).toHaveLength(1); // no queued_items wake
  expect(rt.queueItems()).toHaveLength(1);
});

test("a later human message goes out as one batch with the notice first, then the message", async () => {
  await runIdle();
  await rt.postNotice("crons_stopped", "stopped");
  await send("hello again");
  driver.last.emit(ev.turn());
  await rt.settled();
  const batch = driver.last.sent[1] ?? [];
  expect(batch.map((m) => [m.kind, m.from])).toEqual([
    ["system", "@factory"],
    ["message", `<@${testRef("u1")}|or>`],
  ]);
});

test("a compact queued behind the passive notice still runs; the notice stays queued", async () => {
  await runIdle();
  await rt.postNotice("crons_stopped", "stopped");
  await rt.compact({ by: "<@or>" });
  await rt.settled();
  expect(driver.last.controls.map((c) => (c as { cmd: string }).cmd)).toContain("compact");
  expect(rt.queueItems().map((q) => q.kind)).toEqual(["notice"]);
});

test("a second notice of the type replaces the first: one pending row", async () => {
  await notice();
  await store.createNotice({ toAgentId: id, notice: "crons_stopped", body: "newer" });
  const rows =
    await t.sql`select body from messages where to_id = ${id} and notice = 'crons_stopped' and state = 'pending'`;
  expect(rows).toEqual([{ body: "newer" }]);
});

test("the Reaper may reap a spawned agent whose only queued item is the passive notice, not one with a real notice", async () => {
  await make({ spawned: true });
  await t.sql`update agents set last_activity_at = '2020-01-01' where id = ${id}`;
  await notice();
  await rt.init();
  expect(await rt.reaperCheck(Date.now())).toBe(true);
  await make({ spawned: true });
  await t.sql`update agents set last_activity_at = '2020-01-01' where id = ${id}`;
  await store.createNotice({ toAgentId: id, notice: "restart", body: "x" });
  await rt.init();
  expect(await rt.reaperCheck(Date.now())).toBe(false);
});

test("a queued report_config_changed never wakes the manager: not deliverable, no boot wake", async () => {
  await insertAgent(t.sql, { id: `rep${n}`, slug: `rep${n}`, reportsTo: id });
  await store.createNotice({
    toAgentId: id,
    notice: "report_config_changed",
    body: notices.reportConfigChanged({ by: "@hr", report: `rep${n}`, lines: ["added skill tdd"] }),
    subjectAgentId: `rep${n}`,
  });
  await rt.init();
  expect(rt.hasDeliverable()).toBe(false);
  expect((await store.bootWakes()).map((w) => w.id)).not.toContain(id);
});

test("recordReportNotice on a running idle manager queues the notice without sending it", async () => {
  await runIdle();
  await insertAgent(t.sql, { id: `rep${n}`, slug: `rep${n}`, reportsTo: id });
  await rt.recordReportNotice(`rep${n}`, "<@hr000000>", ["added skill tdd"]);
  expect(driver.last.sent).toHaveLength(1); // only the boot batch
  expect(rt.queueItems().map((q) => q.kind)).toEqual(["notice"]);
  expect(rt.hibernatable()).toBe(true);
  await send("hello again");
  driver.last.emit(ev.turn());
  await rt.settled();
  const batch = driver.last.sent[1] ?? [];
  expect(batch.map((m) => [m.kind, m.from, m.body])).toEqual([
    [
      "system",
      "@factory",
      `<@hr000000|unknown> changed <@${testRef(`rep${n}`)}|rep${n}>'s configuration:\n- added skill tdd`,
    ],
    ["message", `<@${testRef("u1")}|or>`, "hello again"],
  ]);
});
