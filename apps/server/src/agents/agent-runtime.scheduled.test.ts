import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { claimTestHandleSql } from "../test/handles.ts";
import { createTestDb } from "../test/helpers.ts";
import { AgentRuntime } from "./agent-runtime.ts";
import { EventBus } from "./event-bus.ts";
import { EventStore } from "./event-store.ts";
import { liveCredentialId } from "./live-credential.ts";
import { ev, FakeDriver } from "./testing/fake-driver.ts";
import { insertAgent, insertSchedule, insertScheduledMessage } from "./testing/rows.ts";
import { noForward, noopTokens, testEffective } from "./testing/runtime-harness.ts";
import { unlimitedSlots } from "./testing/unlimited-slots.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
let n = 0;
beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  await claimTestHandleSql(t.sql, "or", "user");
  await t.sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
});
afterAll(() => t.close());

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
let driver: FakeDriver;
let rt: AgentRuntime;
let agentId: string;

async function makeRuntime(opts: { status?: string; sessionId?: string } = {}) {
  n += 1;
  agentId = `a${n}`;
  await insertAgent(t.sql, {
    id: agentId,
    slug: `dev${n}`,
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
  driver = new FakeDriver();
  const agent = await store.agentById(agentId);
  if (!agent) throw new Error("no agent");
  rt = new AgentRuntime({
    tokens: noopTokens,
    forward: noForward,
    agent,
    store,
    bus: new EventBus(),
    driver,
    prepareStart: async (a) => ({
      credentialId: liveCredentialId(a),
      agentId: a.id,
      slug: a.slug,
      cwd: "/w",
      env: {},
      claudeBin: "claude",
      runtime: "local",
      permissionMode: "auto",
      mounts: [],
      effective: testEffective(),
    }),
    log: silentLog,
    slots: unlimitedSlots,
  });
  await rt.init();
}

const scheduled = async (over: Partial<Parameters<typeof insertScheduledMessage>[1]> = {}) => {
  const sid = `s${n}`;
  await insertSchedule(t.sql, {
    id: sid,
    targetAgentId: agentId,
    timezone: "Europe/Berlin",
    cron: "0 9 * * 1-5",
  });
  await insertScheduledMessage(t.sql, {
    id: `sm${n}`,
    toAgentId: agentId,
    scheduleId: sid,
    ...over,
  });
  return store.pendingRow(`sm${n}`);
};
const events = async () => (await store.after(agentId, 0, 1000)).map((e) => e.event);

beforeEach(() => makeRuntime());

test("a scheduled row wakes a hibernated agent with reason scheduled and renders from @scheduler", async () => {
  const row = await scheduled({ firings: 3, late: true });
  expect(row.scheduleKey).toMatch(/^S-\d+$/);
  const item = await rt.deliver(row, {
    sender: "agent",
    fromLabel: "@scheduler",
    reason: "scheduled",
  });
  expect(item).toMatchObject({
    kind: "message",
    from: "@scheduler",
    fromKind: "factory",
    firings: 3,
    late: true,
  });
  expect(item?.scheduleKey).toBe(row.scheduleKey);
  driver.last.emit(ev.session(), ev.turn());
  await rt.settled();
  const started = (await events()).find((e) => e.type === "process_started");
  expect(started).toMatchObject({ reason: "scheduled" });
  const sent = driver.last.sent[0]?.[0];
  expect(sent).toMatchObject({
    from: "@scheduler",
    kind: "scheduled",
    scheduleKey: row.scheduleKey,
    by: "@or",
    byKind: "human",
    due: "2026-11-23T09:00:00+01:00",
    firings: 3,
    late: true,
  });
});

test("an agent author is the @slug in by", async () => {
  await claimTestHandleSql(t.sql, "author1", "agent");
  await t.sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, reports_to_user)
              select 'auth1', 'author1', 'A', template, config, runtime, credential_id, reports_to_user from agents where id = ${agentId}`;
  const row = await scheduled({ authorAgentId: "auth1" });
  expect(row.authorLabel).toBe("@author1");
  expect(row.authorKind).toBe("agent");
});

test("to an errored agent the row stays pending and nothing starts", async () => {
  await makeRuntime({ status: "errored", sessionId: "sess-1" });
  const row = await scheduled();
  await rt.deliver(row, { sender: "agent", fromLabel: "@scheduler", reason: "scheduled" });
  await rt.settled();
  expect(driver.starts).toHaveLength(0);
  expect((await events()).filter((e) => e.type === "process_started")).toHaveLength(0);
  expect(rt.queueItems().map((q) => q.id)).toEqual([row.id]);
  const [m] = await t.sql`select state from messages where id = ${row.id}`;
  expect(m?.state).toBe("pending");
});

test("bootWakes counts a scheduled row", async () => {
  await scheduled();
  const wakes = await store.bootWakes();
  expect(wakes.map((w) => w.id)).toContain(agentId);
});

test("the queue after init() carries the schedule fields, and messageLookup too", async () => {
  const row = await scheduled({ firings: 2 });
  await rt.init();
  const q = rt.queueItems().find((i) => i.id === row.id);
  expect(q).toMatchObject({
    scheduleKey: row.scheduleKey,
    firings: 2,
    from: "@scheduler",
    fromKind: "factory",
  });
  expect(q?.dueAt).toBe("2026-11-23T08:00:00.000Z");
  const look = await store.messageLookup(row.id);
  expect(look).toMatchObject({
    kind: "scheduled",
    from: "@scheduler",
    fromKind: "factory",
    scheduleKey: row.scheduleKey,
    firings: 2,
    dueAt: "2026-11-23T08:00:00.000Z",
  });
});

// ---------- replace, never stack: the runtime's side (S9 §8.2) ----------

const humanSend = async (body: string) => {
  const row = await store.createMessage({
    from: { userId: "u1" },
    toAgentId: agentId,
    recipients: ["@test"],
    body,
    urgent: false,
  });
  return rt.deliver(await store.pendingRow(row.id), { sender: "human", fromLabel: "@or" });
};
const asAgent = (row: Awaited<ReturnType<typeof store.pendingRow>>) =>
  rt.deliver(row, { sender: "agent", fromLabel: "@scheduler", reason: "scheduled" });

test("a hand-off for a queued row the runtime already holds refreshes it, monotonically", async () => {
  await makeRuntime({ status: "errored", sessionId: "sess-1" });
  const first = await scheduled({ firings: 1 });
  await asAgent(first);
  await t.sql`update messages set firings = 2, body = 'second' where id = ${first.id}`;
  const second = await store.pendingRow(first.id);
  await asAgent(second);
  expect(rt.queueItems().find((i) => i.id === first.id)).toMatchObject({
    firings: 2,
    body: "second",
  });
  // an older hand-off arriving after the newer one never regresses the entry
  await asAgent(first);
  expect(rt.queueItems().find((i) => i.id === first.id)).toMatchObject({
    firings: 2,
    body: "second",
  });
  // and init() having loaded a newer version is not regressed by a stale hand-off either
  await t.sql`update messages set firings = 5, body = 'fifth' where id = ${first.id}`;
  await rt.init();
  await asAgent(first);
  expect(rt.queueItems().find((i) => i.id === first.id)).toMatchObject({
    firings: 5,
    body: "fifth",
  });
});

test("flush renders the row's current content, not a stale entry; a row rejected meanwhile is dropped", async () => {
  const row = await scheduled({ firings: 1, body: "stale" });
  const other = await (async () => {
    await insertSchedule(t.sql, { id: `x${n}`, targetAgentId: agentId, cron: "0 9 * * *" });
    await insertScheduledMessage(t.sql, {
      id: `xm${n}`,
      toAgentId: agentId,
      scheduleId: `x${n}`,
      body: "doomed",
    });
    return store.pendingRow(`xm${n}`);
  })();
  await rt.init(); // loads both entries as they are now
  await t.sql`update messages set firings = 3, body = 'current' where id = ${row.id}`;
  await t.sql`update messages set state = 'rejected' where id = ${other.id}`;
  await humanSend("go");
  driver.last.emit(ev.session(), ev.turn());
  await rt.settled();
  const sent = driver.last.sent[0] ?? [];
  const sch = sent.filter((m) => m.kind === "scheduled");
  expect(sch).toHaveLength(1);
  expect(sch[0]).toMatchObject({ firings: 3, body: "current" });
  expect(sent.some((m) => m.body.includes("doomed"))).toBe(false);
});

test("a replacement that lands between rendering and the batch's commit is coalesced: the row says what the agent read", async () => {
  await humanSend("boot");
  driver.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
  await rt.settled();
  const proc = driver.last;
  const realSend = proc.send.bind(proc);
  let sendStarted!: () => void;
  const started = new Promise<void>((r) => (sendStarted = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  proc.send = async (m) => {
    sendStarted();
    await gate;
    return realSend(m);
  };
  const row = await scheduled({ firings: 2, body: "older body" });
  const delivering = asAgent(row);
  await started; // rendered (firings 2, "older body") and being written
  await t.sql`update messages set firings = 3, body = 'newer body' where id = ${row.id}`;
  release();
  await delivering;
  await rt.settled();
  const [m] = await t.sql`select state, firings, body from messages where id = ${row.id}`;
  expect(m).toMatchObject({ state: "delivered", firings: 2, body: "older body" });
});
