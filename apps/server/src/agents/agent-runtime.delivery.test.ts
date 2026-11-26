import { randomUUID } from "node:crypto";
import { renderEnvelopes } from "@open-factory/harness";
import type { ServerMessage } from "@open-factory/shared";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { principalSql, testRef } from "../test/principals.ts";
import { AgentRuntime } from "./agent-runtime.ts";
import { CompactingError, NoOpenTurnError } from "./errors.ts";
import { EventBus } from "./event-bus.ts";
import { EventStore } from "./event-store.ts";
import { liveCredentialId } from "./live-credential.ts";
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

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
let driver: FakeDriver;
let bus: EventBus;
let frames: ServerMessage[];
let rt: AgentRuntime;
let agentId: string;

async function makeRuntime(
  opts: { startError?: Error; sessionId?: string; status?: string; realHold?: boolean } = {},
) {
  n += 1;
  agentId = `a${n}`;
  await insertAgent(t.sql, {
    id: agentId,
    handle: `dev${n}`,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.status ? { status: opts.status } : {}),
  });
  driver = new FakeDriver();
  bus = new EventBus();
  frames = [];
  bus.subscribeAll((m) => frames.push(m));
  const agent = await store.agentById(agentId);
  if (!agent) throw new Error("no agent");
  bus.subscribe(agent.id, (m) => frames.push(m));
  rt = new AgentRuntime({
    tokens: noopTokens,
    forward: noForward,
    agent,
    store,
    bus,
    driver,
    prepareStart: async (a) => {
      if (opts.startError) throw opts.startError;
      return {
        credentialId: liveCredentialId(a),
        agentId: a.id,
        ref: a.id,
        cwd: "/w",
        env: { TOKEN_SEEN: "yes" },
        claudeBin: "claude",
        runtime: "local",
        permissionMode: "auto",
        mounts: [],
        effective: testEffective(),
      };
    },
    log: silentLog,
    slots: new RecordingSlots(),
    ...(opts.realHold ? {} : { holdTimeoutMs: 200 }),
  });
  await rt.init();
  return rt;
}
const OR_TAG = `<@${testRef("u1")}|or>`;
const send = (body: string, urgent = false) =>
  sendAs(store, rt, { fromUserId: "u1", fromHandle: "or", body, urgent });
const events = async () =>
  (await store.after(agentId, 0, 1000)).map((e) => ({
    seq: e.seq,
    turnId: e.turnId,
    type: e.event.type,
    event: e.event,
  }));
const types = async () => (await events()).map((e) => e.type);
const msgRows = () =>
  t.sql`select id, state, delivered_turn_id from messages where to_id = ${agentId} order by created_at`;

beforeEach(async () => {
  await makeRuntime();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
/** Only the hold timer is faked: Postgres I/O and setImmediate (used by settled()) stay real. */
const fakeHoldTimer = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

async function startedIdle() {
  await send("boot");
  driver.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
  await rt.settled();
}

test("a rejected write keeps the message pending at the head; the next flush sends it with the newer one as one batch", async () => {
  await startedIdle();
  driver.last.failWrites = true;
  const a = await send("a"); // write rejected: stays queued, delivery_failed appended once
  expect(rt.queueItems().map((q) => q.body)).toEqual(["a"]);
  const failed = (await events()).filter((e) => e.type === "delivery_failed");
  expect(failed.map((e) => e.event)).toEqual([
    { type: "delivery_failed", messageIds: [a.id], reason: "The agent process is not running" },
  ]);
  const rowA = (await msgRows()).find((r) => r.id === a.id);
  expect(rowA?.state).toBe("pending");
  driver.last.failWrites = false;
  await send("b");
  expect(driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["a", "b"]);
  expect(rt.queueItems()).toEqual([]);
});

test("compact is a barrier: written only with no open turn, and nothing passes it until its turn ends", async () => {
  await startedIdle();
  await send("long task");
  driver.last.emit(ev.turn());
  await rt.settled();
  await rt.compact({ focus: "keep the API", by: "<@or>" });
  await send("after compact");
  expect(driver.last.controls).toEqual([]); // turn open: compact waits
  expect(rt.queueItems().map((q) => q.kind)).toEqual(["compact", "message"]);
  driver.last.emit(ev.usage(), ev.end());
  await rt.settled();
  expect(driver.last.controls).toEqual([{ kind: "control", cmd: "compact", arg: "keep the API" }]);
  expect(driver.last.sent.at(-1)?.[0]?.body).toBe("long task"); // "after compact" not written yet
  expect(rt.live().status).toBe("working"); // compact in flight
  // a self-started turn ending meanwhile does not release the barrier
  driver.last.emit(ev.turn(), ev.usage(), ev.end({ originKind: "task-notification" }));
  await rt.settled();
  expect(driver.last.sent.at(-1)?.[0]?.body).toBe("long task");
  driver.last.emit(
    ev.turn(),
    { type: "compacted", trigger: "manual", preTokens: 100, postTokens: 10 },
    ev.usage(),
    ev.end({ command: "compact", terminalReason: undefined, numTurns: 0 }),
  );
  await rt.settled();
  expect(driver.last.sent.at(-1)?.[0]?.body).toBe("after compact");
  expect((await events()).find((e) => e.type === "control")?.event).toEqual({
    type: "control",
    cmd: "compact",
    arg: "keep the API",
    by: "<@or>",
  });
});

test("urgent while a turn is open: interrupt first, hold, then the message on the turn's result", async () => {
  await startedIdle();
  await send("long task");
  driver.last.emit(ev.turn(), { type: "tool_call", toolUseId: "t1", name: "Bash", input: {} });
  await rt.settled();
  await send("STOP", true);
  await send("and this");
  const w = driver.last.writes;
  expect(w.at(-1)).toEqual({ kind: "control", cmd: "interrupt" }); // nothing written after the interrupt yet
  expect(rt.queueItems().map((q) => q.body)).toEqual(["STOP", "and this"]);
  await send("third, urgent again", true);
  expect(driver.last.controls.filter((c) => c.cmd === "interrupt")).toHaveLength(1); // no second interrupt
  driver.last.emit(ev.usage(), ev.end({ isError: true, terminalReason: "aborted_tools" }));
  await rt.settled();
  expect(driver.last.sent.at(-1)?.map((m) => m.body)).toEqual([
    "STOP",
    "and this",
    "third, urgent again",
  ]);
});

test("a DB failure in the hold-timeout flush stops the process and marks errored", async () => {
  await makeRuntime({ realHold: true });
  await startedIdle();
  await send("long task");
  driver.last.emit(ev.turn());
  await rt.settled();
  fakeHoldTimer();
  await send("STOP", true);
  vi.spyOn(store, "transaction").mockRejectedValueOnce(new Error("db down"));
  await vi.advanceTimersByTimeAsync(10_000);
  await rt.settled();
  expect(driver.last.sent.at(-1)?.[0]?.body).toBe("STOP");
  expect(rt.live().status).toBe("errored");
  expect((await types()).at(-1)).toBe("exited");
});

async function startedWithOpenTurn() {
  await startedIdle();
  await send("long task");
  driver.last.emit(ev.turn());
  await rt.settled();
}
const queueFrames = () => frames.filter((f) => f.type === "queue");
const controlEvents = async () => (await events()).filter((e) => e.type === "control");

test("a plain interrupt holds later messages until the interrupted turn's result", async () => {
  await startedWithOpenTurn();
  fakeHoldTimer();
  await rt.interrupt({ by: "<@or>" });
  await send("steer");
  expect(driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["long task"]);
  expect(driver.last.writes.at(-1)).toEqual({ kind: "control", cmd: "interrupt" });
  expect(rt.queueItems().at(-1)).toMatchObject({ body: "steer", waitReason: "stopping" });
  driver.last.emit(ev.usage(), ev.end({ isError: true, terminalReason: "aborted_tools" }));
  await rt.settled();
  expect(driver.last.writes.at(-1)).toMatchObject({ kind: "send" });
  expect(driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["steer"]);
  expect(rt.queueItems()).toEqual([]);
});

test("a second interrupt during the hold writes nothing", async () => {
  await startedWithOpenTurn();
  fakeHoldTimer();
  await rt.interrupt({ by: "<@or>" });
  await rt.interrupt({ by: "<@or>" }); // resolves (202), no-op
  await send("STOP", true); // an urgent send during the hold doesn't interrupt again either
  expect(driver.last.controls).toEqual([{ kind: "control", cmd: "interrupt" }]);
  expect((await controlEvents()).map((e) => e.event)).toEqual([
    { type: "control", cmd: "interrupt", by: "<@or>" },
  ]);
});

test.each([
  [
    "a plain interrupt",
    "steer",
    async () => {
      await rt.interrupt({ by: "<@or>" });
      await send("steer");
    },
  ],
  ["an urgent send", "STOP", () => send("STOP", true)],
])(
  "the 10 s fallback after %s appends interrupt_unconfirmed, then sends the held messages",
  async (_name, held, trigger) => {
    await makeRuntime({ realHold: true });
    await startedWithOpenTurn();
    fakeHoldTimer();
    await trigger();
    await vi.advanceTimersByTimeAsync(9_999);
    await rt.settled();
    expect(await types()).not.toContain("interrupt_unconfirmed");
    expect(driver.last.sent.at(-1)?.[0]?.body).toBe("long task");
    await vi.advanceTimersByTimeAsync(1);
    await rt.settled();
    const after = (await types()).slice(-2);
    expect(after).toEqual(["interrupt_unconfirmed", "message_in"]); // the line lands before the held message
    expect(driver.last.sent.at(-1)?.map((m) => m.body)).toEqual([held]);
    expect(rt.queueItems()).toEqual([]);
  },
);

test("a hold ended by the turn's result never appends interrupt_unconfirmed afterwards", async () => {
  await makeRuntime({ realHold: true });
  await startedWithOpenTurn();
  fakeHoldTimer();
  await rt.interrupt({ by: "<@or>" });
  await send("steer");
  driver.last.emit(ev.usage(), ev.end({ isError: true, terminalReason: "aborted_tools" }));
  await rt.settled();
  expect(driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["steer"]);
  await vi.advanceTimersByTimeAsync(20_000);
  await rt.settled();
  expect(await types()).not.toContain("interrupt_unconfirmed");
});

test("interrupt during a compaction is 409 compacting and writes nothing", async () => {
  await startedIdle();
  await rt.compact({ by: "<@or>" });
  await expect(rt.interrupt({ by: "<@or>" })).rejects.toBeInstanceOf(CompactingError);
  driver.last.emit(ev.turn()); // the compact turn opens
  await rt.settled();
  await expect(rt.interrupt({ by: "<@or>" })).rejects.toMatchObject({ code: "compacting" });
  expect(driver.last.controls).toEqual([{ kind: "control", cmd: "compact" }]);
  expect(rt.live().status).not.toBe("errored");
});

test("publishQueue runs when the hold begins and when it ends", async () => {
  await startedWithOpenTurn();
  fakeHoldTimer();
  const before = queueFrames().length;
  await rt.interrupt({ by: "<@or>" });
  expect(queueFrames()).toHaveLength(before + 1);
  await send("steer");
  const held = queueFrames().at(-1);
  expect(held?.type === "queue" && held.items).toEqual([
    expect.objectContaining({ body: "steer", waitReason: "stopping" }),
  ]);
  const beforeEnd = queueFrames().length;
  driver.last.emit(ev.usage(), ev.end({ isError: true, terminalReason: "aborted_tools" }));
  await rt.settled();
  expect(queueFrames().length).toBeGreaterThan(beforeEnd);
  const released = queueFrames().at(-1);
  expect(released?.type === "queue" && released.items).toEqual([]);
});

test("a hold released by the turn's result, with nothing queued, still publishes the queue", async () => {
  await startedWithOpenTurn();
  fakeHoldTimer();
  await rt.interrupt({ by: "<@or>" });
  const before = queueFrames().length;
  driver.last.emit(ev.usage(), ev.end({ isError: true, terminalReason: "aborted_tools" }));
  await rt.settled();
  expect(queueFrames().length).toBeGreaterThan(before);
});

test("urgent while a compact is in flight does not interrupt it; it waits behind the barrier", async () => {
  await startedIdle();
  await rt.compact({ by: "<@or>" });
  expect(driver.last.controls).toEqual([{ kind: "control", cmd: "compact" }]);
  driver.last.emit(ev.turn()); // the compact turn opens
  await rt.settled();
  await send("STOP", true);
  expect(driver.last.controls).toEqual([{ kind: "control", cmd: "compact" }]); // no interrupt
  expect(rt.queueItems().map((q) => q.body)).toEqual(["STOP"]);
  driver.last.emit(
    ev.usage(),
    ev.end({ command: "compact", terminalReason: undefined, numTurns: 0 }),
  );
  await rt.settled();
  expect(driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["STOP"]);
});

test("a hand-off of a row this runtime already wrote (boot wakes got it first) never interrupts the turn reading it", async () => {
  await startedIdle();
  const row = await store.createMessage({
    from: { userId: "u1" },
    toAgentId: agentId,
    recipientIds: [agentId],
    body: "STOP",
    urgent: true,
  });
  // What boot reconciliation's wake did while the Router's send waited on `booted`: the row is loaded and written.
  await rt.deliver(row, { sender: "human", fromLabel: "@or" });
  expect(driver.last.sent.at(-1)?.[0]?.body).toBe("STOP");
  driver.last.emit(ev.turn()); // the turn reading it opens
  await rt.settled();
  const writes = driver.last.writes.length;
  await rt.deliver(row, { sender: "human", fromLabel: "@or" }); // the Router's late hand-off
  expect(driver.last.controls).toEqual([]);
  expect(driver.last.writes).toHaveLength(writes);
});

test("urgent while idle is a normal send", async () => {
  await startedIdle();
  await send("now", true);
  expect(driver.last.controls).toEqual([]);
  expect(driver.last.sent.at(-1)?.[0]).toMatchObject({ body: "now", urgent: true });
});

test("after an unexpected exit the dead process is never flushed; only the recovery attempt starts one", async () => {
  await makeRuntime({ realHold: true });
  await startedIdle();
  await send("long task");
  driver.last.emit(ev.turn());
  await rt.settled();
  fakeHoldTimer();
  await send("STOP", true);
  driver.last.exit(1);
  await rt.settled();
  // the exit clears the hold; even past its 10 s nothing is written to the dead process
  await vi.advanceTimersByTimeAsync(10_000);
  await rt.settled();
  expect(driver.starts).toHaveLength(2);
  expect(driver.starts[0]?.sent.flat().map((m) => m.body)).not.toContain("STOP");
  expect(driver.last.sent[0]?.map((m) => m.kind)).toEqual(["system", "message"]);
  expect(driver.last.sent[0]?.[1]?.body).toBe("STOP");
});

test("a rejected interrupt write (process going away) is not an internal error: urgent stays queued, Interrupt is 409", async () => {
  await startedIdle();
  await send("long task");
  driver.last.emit(ev.turn());
  await rt.settled();
  driver.last.failWrites = true; // the process is exiting; its `exited` has not been processed yet
  const item = await send("STOP", true); // resolves: no 500
  expect(item.body).toBe("STOP");
  await expect(rt.interrupt({ by: "<@or>" })).rejects.toBeInstanceOf(NoOpenTurnError);
  expect(driver.last.controls).toEqual([]);
  expect(rt.live().status).not.toBe("errored");
  expect(rt.queueItems().map((q) => q.body)).toEqual(["STOP"]);
  await rt.stop(); // the expected exit arrives (a shutdown mid-turn: it leaves the factory-restarted notice)
  expect(rt.live().status).toBe("hibernated");
  const [a] = await t.sql`select status from agents where id = ${agentId}`;
  expect(a?.status).toBe("hibernated");
  await send("next");
  expect(driver.starts).toHaveLength(2);
  expect(driver.last.sent.at(-1)?.map((m) => [m.kind, m.body])).toEqual([
    ["system", expect.stringContaining("The factory restarted")],
    ["message", "STOP"],
    ["message", "next"],
  ]);
});

test("a rejected interrupt write before an unexpected exit keeps the real exit reason", async () => {
  await startedIdle();
  await send("long task");
  driver.last.emit(ev.turn());
  await rt.settled();
  driver.last.failWrites = true;
  await send("STOP", true);
  driver.last.exit(1);
  await rt.settled();
  expect(rt.live()).toMatchObject({
    errorKind: "crash",
    lastError: "Exited unexpectedly (code 1)",
  });
});

test("the first batch after a notice begins with it, even ahead of an older pending message", async () => {
  await store.createMessage({
    from: { userId: "u1" },
    toAgentId: agentId,
    recipientIds: [agentId],
    body: "old",
    urgent: false,
  });
  await rt.init(); // as after a restart: "old" is pending
  await rt.postNotice("crash", "it crashed"); // no process: nothing is written
  expect(rt.queueItems().map((q) => [q.kind, q.from, q.body])).toEqual([
    ["notice", "@factory", "it crashed"],
    ["message", `<@${testRef("u1")}>`, "old"],
  ]);
  await send("new"); // starts the process
  expect(driver.last.sent[0]).toMatchObject([
    { from: "@factory", kind: "system", body: "it crashed" },
    { from: OR_TAG, kind: "message", body: "old" },
    { from: OR_TAG, kind: "message", body: "new" },
  ]);
});

test("a notice is written ahead of older pending messages in one batch", async () => {
  await startedIdle();
  driver.last.failWrites = true;
  await send("a");
  await send("b");
  driver.last.failWrites = false;
  await rt.postNotice("factory_restarted", "restarted");
  expect(driver.last.sent.at(-1)).toMatchObject([
    { from: "@factory", kind: "system", body: "restarted" },
    { from: OR_TAG, kind: "message", body: "a" },
    { from: OR_TAG, kind: "message", body: "b" },
  ]);
  const hist = (await events()).find(
    (e) => e.event.type === "message_in" && e.event.messages[0]?.kind === "system",
  );
  expect(hist).toBeDefined(); // history with a system message_in parses (rowsToDto validates)
});

test("a second notice of the same type replaces a pending one; an in-flight one is untouched", async () => {
  await startedIdle();
  driver.last.failWrites = true;
  await rt.postNotice("restart", "first");
  await rt.postNotice("restart", "second");
  expect(rt.queueItems().map((q) => q.body)).toEqual(["second"]);
  driver.last.failWrites = false;
  await rt.postNotice("crash", "x"); // flush writes [second, x]
  const sentBodies = driver.last.sent.at(-1)?.map((m) => m.body);
  expect(sentBodies).toEqual(["second", "x"]);
  await rt.postNotice("restart", "third"); // the earlier restart was written: a new row
  const rows =
    await t.sql`select body, state from messages where notice = 'restart' and to_id = ${agentId} order by created_at`;
  expect(rows.map((r) => r.body)).toEqual(["second", "third"]);
});

test("a notice written but not yet confirmed (no session_started) is never replaced: a new row is queued", async () => {
  await send("a"); // process started, no session_started yet: batches stay in flight
  await rt.postNotice("restart", "first"); // written, row still pending in the DB
  await rt.postNotice("restart", "second");
  expect(driver.last.sent.map((b) => b.map((m) => m.body))).toEqual([["a"], ["first"], ["second"]]);
  const rows =
    await t.sql`select body from messages where notice = 'restart' and to_id = ${agentId} order by created_at`;
  expect(rows.map((r) => r.body)).toEqual(["first", "second"]);
});

test("rolled-back batches go behind notices queued meanwhile", async () => {
  await send("a"); // in flight
  driver.last.failWrites = true;
  await rt.postNotice("restart", "c"); // write rejected: queued
  driver.last.exit();
  await rt.settled();
  // The recovery attempt's first batch: the notices (the crash one joins them), then the rolled-back batch.
  expect(driver.last.sent[0]?.map((m) => [m.kind, m.body])).toEqual([
    ["system", "c"],
    ["system", expect.stringContaining("stopped unexpectedly")],
    ["message", "a"],
  ]);
});

test("U3 §13.2: the queue item and the message_in envelope echo clientMessageId; the model's text never has it", async () => {
  await startedIdle();
  driver.last.emit(ev.turn());
  await rt.settled();
  fakeHoldTimer();
  await rt.interrupt({ by: "<@or>" }); // a hold, so the item is seen queued first
  const cid = randomUUID();
  const row = await store.createMessage({
    from: { userId: "u1" },
    toAgentId: agentId,
    recipientIds: [agentId],
    body: "with an id",
    urgent: false,
    clientMessageId: cid,
  });
  const item = await rt.deliver(row, { sender: "human", fromLabel: "@or" });
  expect(item).toMatchObject({ id: row.id, clientMessageId: cid });
  expect(rt.queueItems()).toEqual([expect.objectContaining({ clientMessageId: cid })]);
  driver.last.emit(ev.usage(), ev.end({ isError: true, terminalReason: "aborted_tools" }));
  await rt.settled();
  const sent = driver.last.sent.at(-1) ?? [];
  expect(sent).toEqual([expect.objectContaining({ id: row.id, clientMessageId: cid })]);
  const stored = (await events()).filter((e) => e.type === "message_in").at(-1)?.event;
  expect(stored).toMatchObject({ messages: [{ id: row.id, clientMessageId: cid }] });
  const text = renderEnvelopes(sent);
  expect(text).not.toContain(cid);
  expect(text).toBe(renderEnvelopes(sent.map(({ clientMessageId: _c, ...m }) => m)));
});

test("after a rename, a new delivery shows the new handle in from and in a body tag", async () => {
  await t.sql.unsafe(principalSql("rn-human", "human", "rn-old"));
  await t.sql`insert into users (id, name, email) values ('rn-human', 'Rn', 'rn@x.io')`;
  await insertAgent(t.sql, { id: "rn-peer", handle: "rn-peer-old" });
  const body = `ask <@${testRef("rn-peer")}> about it`;
  const human = `<@${testRef("rn-human")}`;
  const peer = `<@${testRef("rn-peer")}`;
  await sendAs(store, rt, { fromUserId: "rn-human", body, urgent: false });
  expect(driver.last.sent[0]?.[0]).toMatchObject({
    from: `${human}|rn-old>`,
    body: `ask ${peer}|rn-peer-old> about it`,
  });
  driver.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
  await rt.settled();
  // The endpoint comes in a later task: a rename is a write to principals.handle (agents.handle stays as it was).
  await t.sql`update principals set handle = 'rn-new' where id = 'rn-human'`;
  await t.sql`update principals set handle = 'rn-peer-new' where id = 'rn-peer'`;
  await sendAs(store, rt, { fromUserId: "rn-human", body, urgent: false });
  expect(driver.last.sent[1]?.[0]).toMatchObject({
    from: `${human}|rn-new>`,
    body: `ask ${peer}|rn-peer-new> about it`,
  });
});
