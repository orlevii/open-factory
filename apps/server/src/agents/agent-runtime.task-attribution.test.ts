import { randomUUID } from "node:crypto";
import type { ServerMessage } from "@open-factory/shared";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ev } from "./testing/fake-driver.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";

// S10 spec §5.2, AC 2, V4: a turn is attributed to task T only when it ends normally (turn_end without originKind)
// and every delivered non-system message stamped to it carries T. Exit and boot closes stay unattributed. I9 §4.8:
// every turn end, a self-started one's too, stamps the batches written before it began.

const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return () => vi.useRealTimers();
});

async function newTask(title = "Plan the migration") {
  const id = randomUUID();
  await h.t.sql`insert into tasks (id, title, created_by_user_id) values (${id}, ${title}, 'u1')`;
  return id;
}
/** A task message to the current runtime, handed over as the Router does (S8). */
async function sendTask(taskId: string) {
  const row = await h.store.createTaskMessage(h.t.db, {
    kind: "task_assigned",
    taskId,
    toAgentId: h.agentId,
    body: "@or assigned you a task",
  });
  await h.rt.deliver(row, { sender: "agent", fromLabel: "@factory", reason: "task_message" });
  return row;
}
/** The agent's turns in the order they opened (turn rows share a faked `started_at`). */
async function turnRows() {
  return h.t.sql`select t.id, t.task_id, t.ended_at from turns t where t.agent_id = ${h.agentId}
                 order by (select min(e.seq) from session_events e where e.turn_id = t.id)`;
}
async function lastTurnTask() {
  return (await turnRows()).at(-1)?.task_id as string | null | undefined;
}
async function deliveredTurn(messageId: string) {
  const [r] = await h.t.sql`select delivered_turn_id from messages where id = ${messageId}`;
  return r?.delivered_turn_id as string | null;
}
/** Started, one human turn done, idle. */
async function idle() {
  await h.makeRuntime();
  await h.send("boot");
  h.driver.last.emit(...ev.fullTurn());
  await h.rt.settled();
}

test("a single task message starts a turn: the turn is attributed to its task", async () => {
  await h.makeRuntime();
  const t1 = await newTask();
  const m = await sendTask(t1);
  h.driver.last.emit(...ev.fullTurn());
  await h.rt.settled();
  const [turn] = await turnRows();
  expect(turn?.task_id).toBe(t1);
  expect(await deliveredTurn(m.id)).toBe(turn?.id); // stamped before the close
});

test("one batch with messages of two tasks: NULL", async () => {
  await idle();
  const [t1, t2] = [await newTask("One"), await newTask("Two")];
  h.driver.last.failWrites = true;
  await sendTask(t1); // the write fails: it stays queued
  h.driver.last.failWrites = false;
  await sendTask(t2); // the flush writes both as one batch
  expect(h.driver.last.sent.at(-1)).toHaveLength(2);
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end());
  await h.rt.settled();
  expect(await lastTurnTask()).toBeNull();
});

test("a non-task human message plus a task message: NULL", async () => {
  await idle();
  const t1 = await newTask();
  h.driver.last.failWrites = true;
  await h.send("also, hi");
  h.driver.last.failWrites = false;
  await sendTask(t1);
  expect(h.driver.last.sent.at(-1)).toHaveLength(2);
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end());
  await h.rt.settled();
  expect(await lastTurnTask()).toBeNull();
});

test("a task message plus a system notice: the task", async () => {
  await idle();
  const t1 = await newTask();
  await h.rt.postNotice("crons_stopped", "@or stopped your crons: every 5 minutes.");
  await sendTask(t1);
  expect(h.driver.last.sent.at(-1)?.map((m) => m.kind)).toEqual(["system", "task_assigned"]);
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end());
  await h.rt.settled();
  expect(await lastTurnTask()).toBe(t1);
});

test("a task turn that absorbs a mid-turn human message: NULL", async () => {
  await idle();
  const t1 = await newTask();
  await sendTask(t1);
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  await h.send("mid-turn");
  h.driver.last.emit(ev.usage(), ev.end());
  await h.rt.settled();
  expect(await lastTurnTask()).toBeNull();
});

test("a mid-turn absorbed task message of the same task: the task, both batches stamped", async () => {
  await idle();
  const t1 = await newTask();
  const first = await sendTask(t1);
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  const second = await sendTask(t1);
  h.driver.last.emit(ev.usage(), ev.end());
  await h.rt.settled();
  const turn = (await turnRows()).at(-1);
  expect(turn?.task_id).toBe(t1);
  expect(await deliveredTurn(first.id)).toBe(turn?.id);
  expect(await deliveredTurn(second.id)).toBe(turn?.id);
});

test("a cron turn ends while a task batch awaits: the batch is stamped to it (settled at any turn end) and the cron turn stays NULL", async () => {
  await idle();
  const t1 = await newTask();
  const m = await sendTask(t1); // written, awaiting its turn
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end({ originKind: "cron" }));
  await h.rt.settled();
  const cronTurn = (await turnRows()).at(-1);
  expect(cronTurn?.task_id).toBeNull();
  expect(await deliveredTurn(m.id)).toBe(cronTurn?.id);
  expect(h.rt.statusFrame().status).toBe("idle");
});

test("a process exit with an open turn and an awaiting task batch: the batch is stamped and the task attributed (I1 §6.3)", async () => {
  await idle();
  const t1 = await newTask();
  const awaiting = await sendTask(t1);
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  const absorbed = await sendTask(t1); // stamped to the open turn at its write
  const turnId = (await turnRows()).at(-1)?.id;
  expect(await deliveredTurn(absorbed.id)).toBe(turnId);
  h.driver.last.exit(1, "boom");
  await h.rt.settled();
  const [row] = await h.t
    .sql`select task_id, ended_at, terminal_reason from turns where id = ${turnId ?? ""}`;
  expect(row).toMatchObject({ task_id: t1, terminal_reason: "process_exited" });
  expect(row?.ended_at).not.toBeNull();
  expect(await deliveredTurn(awaiting.id)).toBe(turnId);
});

test("a normal turn_end with no delivered messages (e.g. a manual /compact): NULL", async () => {
  await idle();
  await newTask(); // a task exists, but nothing of it reaches the turn
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end());
  await h.rt.settled();
  const turns = await turnRows();
  expect(turns).toHaveLength(2);
  expect(turns.at(-1)?.ended_at).not.toBeNull();
  expect(turns.at(-1)?.task_id).toBeNull();
  const [n] = await h.t
    .sql`select count(*)::int as n from messages where delivered_turn_id = ${turns.at(-1)?.id ?? ""}`;
  expect(n?.n).toBe(0);
});

test("closeDanglingTurns at boot: the turn is closed unattributed", async () => {
  await idle();
  const t1 = await newTask();
  await sendTask(t1);
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  await sendTask(t1); // stamped to the open turn
  const turnId = (await turnRows()).at(-1)?.id;
  await h.store.closeDanglingTurns();
  const [row] = await h.t.sql`select task_id, ended_at from turns where id = ${turnId ?? ""}`;
  expect(row?.ended_at).not.toBeNull();
  expect(row?.task_id).toBeNull();
});

test("V4: on the exit path, no agent_status says turnOpen false before the turn row is closed", async () => {
  // The cleanup (a Docker stop can take seconds) blocks; meanwhile a status is published from outside, as a
  // supervisor wake would. Every closed-turn frame must find the close already resolved.
  let entered!: () => void;
  const inCleanup = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await h.makeRuntime({
    cleanup: async () => {
      entered();
      await gate;
      return undefined;
    },
  });
  await h.send("boot");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  let closed = false;
  const closeTurn = h.store.closeTurn.bind(h.store);
  vi.spyOn(h.store, "closeTurn").mockImplementation(async (...a) => {
    await closeTurn(...a);
    closed = true;
  });
  const frames: boolean[] = []; // `closed` as each turnOpen:false frame left the runtime
  const off = h.bus.subscribeAll((m: ServerMessage) => {
    if (m.type === "agent_status" && m.agent === h.rt.agent.slug && m.turnOpen === false)
      frames.push(closed);
  });
  h.driver.last.exit(1, "boom"); // a crash: the leftovers are cleaned up
  await inCleanup;
  h.rt.publishStatus();
  const duringCleanup = frames.length;
  release();
  await h.rt.settled();
  off();
  vi.restoreAllMocks();
  expect(duringCleanup).toBeGreaterThan(0);
  expect(frames.length).toBeGreaterThan(duringCleanup);
  expect(frames.every(Boolean)).toBe(true);
});
