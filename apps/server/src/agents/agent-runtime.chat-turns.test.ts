import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { claimTestHandle } from "../test/handles.ts";
import { ev } from "./testing/fake-driver.ts";
import { RuntimeHarness, sendAs } from "./testing/runtime-harness.ts";

// I1 §6.3: every turn that read a message is stamped, however it ends, and the runtime knows whose message a turn is
// working on (D2, D3).

const h = new RuntimeHarness();
beforeAll(async () => {
  await h.setup();
  await claimTestHandle(h.t.db, "ann", "user");
  await h.t
    .sql`insert into users (id, name, email, handle) values ('u2', 'Ann', 'ann@x.io', 'ann')`;
});
afterAll(() => h.close());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return () => vi.useRealTimers();
});

type Turn = {
  id: string;
  ended_at: Date | null;
  is_error: boolean | null;
  terminal_reason: string | null;
  end_event_seq: number | null;
};
async function turnRows(): Promise<Turn[]> {
  return (await h.t.sql`select t.id, t.ended_at, t.is_error, t.terminal_reason, t.end_event_seq
    from turns t where t.agent_id = ${h.agentId}
    order by (select min(e.seq) from session_events e where e.turn_id = t.id) nulls last, t.id`) as never;
}
async function deliveredTurn(messageId: string) {
  const [r] = await h.t.sql`select delivered_turn_id from messages where id = ${messageId}`;
  return r?.delivered_turn_id as string | null;
}
async function eventSeq(turnId: string, type: string) {
  const [r] = await h.t
    .sql`select seq from session_events where turn_id = ${turnId} and type = ${type} order by seq desc limit 1`;
  return r?.seq as number | undefined;
}
/** Started, one human turn done, idle. */
async function idle() {
  await h.makeRuntime();
  await h.send("boot");
  h.driver.last.emit(...ev.fullTurn());
  await h.rt.settled();
}

test("a normal close stores end_event_seq = the turn_end event's seq", async () => {
  await idle();
  const turn = (await turnRows()).at(-1);
  expect(turn?.end_event_seq).not.toBeNull();
  expect(turn?.end_event_seq).toBe(await eventSeq(turn?.id ?? "", "turn_end"));
});

test("an exit mid-turn stamps the starting batch and closes with process_exited at the turn's last event", async () => {
  await idle();
  const m = await h.send("working on it");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  h.driver.last.exit(1, "boom");
  await h.rt.settled();
  const turn = (await turnRows()).at(-1);
  expect(turn).toMatchObject({ is_error: true, terminal_reason: "process_exited" });
  expect(turn?.ended_at).not.toBeNull();
  expect(await deliveredTurn(m.id)).toBe(turn?.id);
  const [last] = await h.t
    .sql`select max(seq) as seq from session_events where turn_id = ${turn?.id ?? ""}`;
  expect(turn?.end_event_seq).toBe(last?.seq);
});

test("an exit with a written batch and no turn creates a zero-length errored turn carrying the stamp", async () => {
  await idle();
  const before = (await turnRows()).length;
  const m = await h.send("never started");
  h.driver.last.exit(1, "boom");
  await h.rt.settled();
  const turns = await turnRows();
  expect(turns).toHaveLength(before + 1);
  const turn = turns.find(
    (t) => t.end_event_seq === null && t.terminal_reason === "process_exited",
  );
  expect(turn).toMatchObject({ is_error: true });
  expect(turn?.ended_at).not.toBeNull();
  expect(await deliveredTurn(m.id)).toBe(turn?.id);
});

test("an exit before session_started opens no turn and leaves the batch pending, unstamped", async () => {
  await h.makeRuntime();
  const before = (await turnRows()).length;
  const m = await h.send("cold");
  h.driver.last.exit(1, "boom");
  await h.rt.settled();
  expect(await turnRows()).toHaveLength(before);
  expect(await deliveredTurn(m.id)).toBeNull();
  const [r] = await h.t.sql`select state from messages where id = ${m.id}`;
  expect(r?.state).toBe("pending");
});

test("closeDanglingTurns leaves a stale delivered row from before an earlier closed turn unstamped", async () => {
  await idle();
  const stale = await h.send("stale");
  // Simulate a row delivered, then the server dying with no turn open: delivered and unstamped.
  await h.t
    .sql`update messages set state = 'delivered', delivered_turn_id = null where id = ${stale.id}`;
  h.driver.last.emit(...ev.fullTurn()); // a later turn closes normally (its end_event_seq is past the row)
  await h.rt.settled();
  await h.t.sql`update messages set delivered_turn_id = null where id = ${stale.id}`;
  const m = await h.send("in flight");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  await h.store.closeDanglingTurns();
  const turnId = (await turnRows()).at(-1)?.id ?? "";
  expect(await deliveredTurn(m.id)).toBe(turnId);
  expect(await deliveredTurn(stale.id)).toBeNull();
});

test("closeDanglingTurns stamps the dangling turn's delivered messages", async () => {
  await idle();
  const m = await h.send("in flight");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  const turnId = (await turnRows()).at(-1)?.id ?? "";
  expect(await deliveredTurn(m.id)).toBeNull(); // the starting batch is stamped at close
  await h.store.closeDanglingTurns();
  const turn = (await turnRows()).at(-1);
  expect(turn).toMatchObject({ terminal_reason: "factory_restarted", is_error: true });
  expect(turn?.end_event_seq).toBeGreaterThan(0);
  expect(await deliveredTurn(m.id)).toBe(turnId);
});

// workingFor(userId): the key (the user's first message in the batch) and the batch's write time (D3).

const sendU2 = (body: string) => sendAs(h.store, h.rt, { fromUserId: "u2", body, urgent: false });

test("workingFor is null before any write", async () => {
  await h.makeRuntime();
  expect(h.rt.workingFor("u1")).toBeNull();
});

test("workingFor is set from the batch write, before turn_started (cold start)", async () => {
  await h.makeRuntime();
  const m = await h.send("hello");
  const w = h.rt.workingFor("u1");
  expect(w?.key).toBe(m.id);
  expect(w?.since).toBe(new Date(Date.now()).toISOString());
  expect(h.rt.workingFor("u2")).toBeNull(); // another user's batch is not yours
});

test("the key survives turn_started and a cron turn starting meanwhile", async () => {
  await idle();
  const m = await h.send("hello");
  const before = h.rt.workingFor("u1");
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end({ originKind: "cron" }));
  await h.rt.settled();
  expect(h.rt.workingFor("u1")).toEqual(before);
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  expect(h.rt.workingFor("u1")).toEqual(before);
  expect(before?.key).toBe(m.id);
});

test("a batch with two of your messages keys on the first; another user's batch is null for you", async () => {
  await idle();
  h.driver.last.failWrites = true;
  const first = await h.send("one");
  await sendU2("not yours");
  h.driver.last.failWrites = false;
  await h.send("two");
  expect(h.driver.last.sent.at(-1)).toHaveLength(3);
  expect(h.rt.workingFor("u1")?.key).toBe(first.id);
  expect(h.rt.workingFor("u2")?.key).not.toBe(first.id);
  expect(h.rt.workingFor("u2")).not.toBeNull();
});

test("a message absorbed into the open turn is working until the turn closes", async () => {
  await idle();
  h.driver.last.emit(ev.turn()); // a self-started turn: nothing of yours awaits
  await h.rt.settled();
  expect(h.rt.workingFor("u1")).toBeNull();
  const m = await h.send("mid-turn");
  expect(h.rt.workingFor("u1")?.key).toBe(m.id);
  h.driver.last.emit(ev.usage(), ev.end());
  await h.rt.settled();
  expect(h.rt.workingFor("u1")).toBeNull();
});

test("null after turn_end's close commits", async () => {
  await idle();
  await h.send("hello");
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end());
  await h.rt.settled();
  expect(h.rt.workingFor("u1")).toBeNull();
});

test("during onExited's close the runtime still reports the closing turn's batch", async () => {
  await idle();
  const m = await h.send("hello");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  let entered!: () => void;
  const inClose = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const closeTurnWith = h.store.closeTurnWith.bind(h.store);
  vi.spyOn(h.store, "closeTurnWith").mockImplementation(async (...a) => {
    entered();
    await gate;
    return closeTurnWith(...a);
  });
  h.driver.last.exit(1, "boom");
  await inClose;
  expect(h.rt.workingFor("u1")?.key).toBe(m.id);
  expect(h.rt.workingFor("u2")).toBeNull();
  release();
  await h.rt.settled();
  vi.restoreAllMocks();
  expect(h.rt.workingFor("u1")).toBeNull();
});
