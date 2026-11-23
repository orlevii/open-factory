import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ev } from "./testing/fake-driver.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";

// I1 §6.3: every turn that read a message is stamped, however it ends, and the runtime knows whose message a turn is
// working on (D2, D3).

const h = new RuntimeHarness();
beforeAll(() => h.setup());
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
