import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { principalSql } from "../test/principals.ts";
import { ev } from "./testing/fake-driver.ts";
import { deliverHuman, RuntimeHarness } from "./testing/runtime-harness.ts";
import { RecordingSlots } from "./testing/slots.ts";

const h = new RuntimeHarness();
beforeAll(async () => {
  await h.setup();
  await h.t.sql.unsafe(principalSql("u2", "human", "sam"));
  await h.t.sql`insert into users (id, name, email) values ('u2', 'Sam', 'sam@x.io')`;
});
afterAll(() => h.close());
// The store's stamps are strictly increasing across tests, so each test's fake clock starts after the last one ended.
let clockEnd = 0;
beforeEach(async () => {
  // Only timers and the clock: setImmediate (settled()) and the DB driver keep running for real.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date"],
    now: Math.max(Date.now(), clockEnd + 1_000),
  });
  await h.makeRuntime({ slots: new RecordingSlots() });
});
afterEach(() => {
  clockEnd = Date.now();
  vi.useRealTimers();
});

async function idle() {
  await h.send("hi");
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await h.rt.settled();
}

// U3 §6.4: cancel and restore a queued message.

/** A running agent with an open turn and a Stop's hold on: later sends stay queued, unwritten. */
async function stopped() {
  await idle();
  await h.send("work");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  await h.rt.interrupt({ by: "<@or>" });
}
const bodies = () => h.rt.queueItems().map((q) => q.body);
const stateOf = async (id: string) =>
  (await h.t.sql`select state from messages where id = ${id}`)[0]?.state;
const endTurn = async () => {
  h.driver.last.emit(ev.usage(), ev.end({ isError: true, terminalReason: "aborted_tools" }));
  await h.rt.settled();
};
const sentBodies = () => h.driver.last.sent.map((b) => b.map((m) => m.body));

test("the sender cancels a held message; another user can't", async () => {
  await stopped();
  const a = await h.send("A");
  const b = await h.send("B");
  await expect(h.rt.cancelQueued(b.id, "u2")).rejects.toMatchObject({ code: "not_sender" });
  expect(bodies()).toEqual(["A", "B"]);
  expect(await stateOf(b.id)).toBe("pending");
  const item = await h.rt.cancelQueued(b.id, "u1");
  expect(item).toMatchObject({
    id: b.id,
    kind: "message",
    body: "B",
    from: "@or",
    fromKind: "human",
  });
  expect(bodies()).toEqual(["A"]);
  expect(await stateOf(b.id)).toBe("cancelled");
  const frame = h.frames.filter((f) => f.type === "queue").at(-1);
  expect(frame?.type === "queue" && frame.items.map((q) => q.id)).toEqual([a.id]);
  await endTurn();
  expect(sentBodies().at(-1)).toEqual(["A"]); // the cancelled one is never written
  expect(h.rt.live().status).not.toBe("errored"); // a refusal is not a job failure
});

test("a written message can't be cancelled (already_delivered); cancelling a cancelled one again is a no-op", async () => {
  await stopped();
  const [work] = (await h.t
    .sql`select id from messages where body = 'work' and to_id = ${h.agentId}`) as unknown as {
    id: string;
  }[];
  if (!work) throw new Error("no row");
  await expect(h.rt.cancelQueued(work.id, "u1")).rejects.toMatchObject({
    code: "already_delivered",
  });
  expect(await stateOf(work.id)).toBe("delivered");
  const b = await h.send("B");
  await h.rt.cancelQueued(b.id, "u1");
  const frames = h.frames.length;
  // A second tab's DELETE: idempotent, the same item, and no new queue frame (it was never delivered).
  expect(await h.rt.cancelQueued(b.id, "u1")).toMatchObject({
    id: b.id,
    kind: "message",
    body: "B",
  });
  expect(h.frames.length).toBe(frames);
  expect(await stateOf(b.id)).toBe("cancelled");
  expect(h.rt.live().status).not.toBe("errored");
});

test("only kind='message' rows are cancellable: a human's task comment is not_sender", async () => {
  await stopped();
  const taskId = `t-${h.agentId}`;
  const commentId = `c-${h.agentId}`;
  await h.t.sql`insert into tasks (id, title, created_by_id) values (${taskId}, 'T', 'u1')`;
  await h.t
    .sql`insert into task_comments (id, task_id, author_id, body) values (${commentId}, ${taskId}, 'u1', 'look')`;
  const row = await h.store.createTaskMessage(h.t.db, {
    kind: "task_comment",
    taskId,
    commentId,
    from: { userId: "u1" },
    toAgentId: h.agentId,
    body: "look",
  });
  await deliverHuman(h.rt, row);
  expect(bodies()).toEqual(["look"]);
  await expect(h.rt.cancelQueued(row.id, "u1")).rejects.toMatchObject({ code: "not_sender" });
  await expect(h.rt.restoreQueued(row.id, "u1")).rejects.toMatchObject({ code: "not_sender" });
  expect(await stateOf(row.id)).toBe("pending");
  // An unknown id, and a message to another agent, say the same thing.
  await expect(h.rt.cancelQueued("nope", "u1")).rejects.toMatchObject({ code: "not_sender" });
});

test("restore re-inserts by createdAt among still-queued items", async () => {
  await stopped();
  await h.send("A");
  const b = await h.send("B");
  await h.send("C");
  await h.rt.cancelQueued(b.id, "u1");
  expect(bodies()).toEqual(["A", "C"]);
  await h.rt.restoreQueued(b.id, "u1");
  expect(bodies()).toEqual(["A", "B", "C"]);
  expect(await stateOf(b.id)).toBe("pending");
  const frame = h.frames.filter((f) => f.type === "queue").at(-1);
  expect(frame?.type === "queue" && frame.items.map((q) => q.body)).toEqual(["A", "B", "C"]);
  await endTurn();
  expect(sentBodies().at(-1)).toEqual(["A", "B", "C"]);
});

test("restore after later messages were written puts it next, with no interrupt", async () => {
  await stopped();
  await h.send("A");
  const b = await h.send("B", true); // urgent: its restore still never interrupts
  await h.send("C");
  await h.rt.cancelQueued(b.id, "u1");
  await endTurn();
  expect(sentBodies().at(-1)).toEqual(["A", "C"]);
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  await h.rt.restoreQueued(b.id, "u1");
  expect(sentBodies().at(-1)).toEqual(["B"]);
  expect(h.driver.last.controls).toEqual([{ kind: "control", cmd: "interrupt" }]); // only the Stop's
  expect(await stateOf(b.id)).toBe("delivered");
  // Restoring what isn't cancelled: delivered is 409; it is never written twice.
  await expect(h.rt.restoreQueued(b.id, "u1")).rejects.toMatchObject({ code: "already_delivered" });
  expect(
    sentBodies()
      .flat()
      .filter((s) => s === "B"),
  ).toHaveLength(1);
});

test("restore by another user is not_sender; restore on a terminated or archived agent is agent_ended", async () => {
  await stopped();
  const b = await h.send("B");
  await h.rt.cancelQueued(b.id, "u1");
  await expect(h.rt.restoreQueued(b.id, "u2")).rejects.toMatchObject({ code: "not_sender" });
  h.rt.markArchived();
  await expect(h.rt.restoreQueued(b.id, "u1")).rejects.toMatchObject({ code: "agent_ended" });
  await h.makeRuntime({ slots: new RecordingSlots() });
  await stopped();
  const c = await h.send("C");
  await h.rt.cancelQueued(c.id, "u1");
  h.rt.markTerminated({ committed: true });
  await expect(h.rt.restoreQueued(c.id, "u1")).rejects.toMatchObject({ code: "agent_ended" });
  expect(await stateOf(c.id)).toBe("cancelled");
});

test("cancel never withdraws a wake already under way", async () => {
  // A start under way (inside prepareStart): the cancel waits behind it, and the start goes on.
  let open!: () => void;
  h.prepareGate = new Promise((r) => {
    open = r;
  });
  const row = await h.row("go");
  const delivered = deliverHuman(h.rt, row);
  await h.prepared(1);
  const cancel = h.rt.cancelQueued(row.id, "u1");
  open();
  await delivered;
  await expect(cancel).rejects.toMatchObject({ code: "already_delivered" });
  expect(h.driver.starts).toHaveLength(1);
  expect(sentBodies()).toEqual([["go"]]);

  // A wake requested and queued by the Supervisor: the cancel removes the message and releases nothing.
  const queued = new RecordingSlots();
  queued.answer = "queued";
  await h.makeRuntime({ slots: queued });
  const m = await h.send("later");
  expect(queued.events).toEqual([["request", "message"]]);
  await h.rt.cancelQueued(m.id, "u1");
  expect(queued.events).toEqual([["request", "message"]]);
  expect(h.driver.starts).toHaveLength(0);
});
