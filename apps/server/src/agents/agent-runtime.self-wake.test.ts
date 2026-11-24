import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { AgentRuntime } from "./agent-runtime.ts";
import type { EventStore } from "./event-store.ts";
import { notices } from "./notices.ts";
import { ev, type FakeDriver } from "./testing/fake-driver.ts";
import { RuntimeHarness, testEffective } from "./testing/runtime-harness.ts";

// I7 §9.5: a self-edit restart (`requestRestart({ wake: true })`) continues on its own after the hibernate.
const h = new RuntimeHarness();
let store: EventStore;
beforeAll(async () => {
  await h.setup();
  store = h.store;
});
afterAll(() => h.close());

let driver: FakeDriver;
let rt: AgentRuntime;
let agentId: string;
beforeEach(async () => {
  await h.makeRuntime();
  ({ driver, rt, agentId } = h);
});

const CHANGE = "model: sonnet → opus";
/** The snapshot a self-edit's `current` reads: the model differs from the one the process started with. */
const changed = async () => {
  const e = testEffective();
  return { doc: { ...e.doc, template: { model: "opus" } }, library: e.library };
};
const unchanged = async () => {
  const e = testEffective();
  return { doc: e.doc, library: e.library };
};
const batches = (p: { sent: { body: string }[][] } | undefined) =>
  (p?.sent ?? []).map((b) => b.map((m) => m.body));
const startReasons = async () =>
  (await store.after(agentId, 0, 1000)).flatMap((e) =>
    e.event.type === "process_started" ? [e.event.reason] : [],
  );
const hibernatedReasons = async () =>
  (await store.after(agentId, 0, 1000)).flatMap((e) =>
    e.event.type === "hibernated" ? [e.event.reason] : [],
  );
const noticeRows = () =>
  h.t.sql<{ notice: string; state: string }[]>`
    select notice, state from messages
    where to_agent_id = ${agentId} and kind = 'system' order by created_at`;

async function idle() {
  await h.send("hi", false);
  driver.last.emit(...ev.fullTurn("sess-1"));
  await rt.settled();
}

test("waits for a live background task, then restarts and wakes the agent with the passive notice, then config_continue", async () => {
  await idle();
  driver.last.emit(ev.background([{ taskId: "b1", description: "build" }]), ev.turn());
  await rt.settled();
  await rt.recordConfigNotice([CHANGE]);
  await rt.requestRestart({ current: changed, wake: true });
  driver.last.emit(ev.usage(), ev.end());
  await rt.settled();
  expect(driver.last.stopped).toBe(false); // the turn ended, the task did not
  expect(rt.live().restartPending).toBe(true);
  driver.last.emit(ev.taskFinished("b1"), ev.background([]));
  await rt.settled();
  expect(driver.last.stopped).toBe(false); // the task's notification turn is still owed
  driver.last.emit(ev.turn(), ev.usage(), ev.end({ originKind: "task-notification" }));
  await rt.settled();
  expect(driver.starts[0]?.stopped).toBe(true);
  expect(driver.starts).toHaveLength(2); // no human message: the agent was woken
  expect((await startReasons()).at(-1)).toBe("apply_changes");
  expect(batches(driver.last)).toEqual([
    [notices.configChanged([CHANGE]), notices.configContinue({ crons: [] })],
  ]);
  driver.last.emit(ev.session("sess-1"), ev.turn());
  await rt.settled();
  expect(rt.live().turnOpen).toBe(true); // a turn started with no human message
});

test("a request whose current finds no difference leaves no restart and no wake", async () => {
  await idle();
  await rt.requestRestart({ current: unchanged, wake: true });
  await rt.settled();
  expect(driver.last.stopped).toBe(false);
  expect(rt.live().restartPending).toBe(false);
  // a later plain restart must not inherit the wake
  await rt.requestRestart();
  await rt.settled();
  expect(driver.starts[0]?.stopped).toBe(true);
  expect(driver.starts).toHaveLength(1);
});

test("an in-session cron is named in config_continue, and no restart_crons notice is added", async () => {
  await idle();
  driver.last.emit(ev.cron("c1", { humanSchedule: "every 5 minutes" }));
  await rt.settled();
  await rt.requestRestart({ current: changed, wake: true });
  await rt.settled();
  expect(driver.starts).toHaveLength(2);
  const body = notices.configContinue({ crons: ["every 5 minutes"] });
  expect(body).toBe(
    "Restarted to apply your config changes. Continue where you left off. These crons were stopped: every 5 minutes; recreate them if you still need them.",
  );
  expect(batches(driver.last)).toEqual([[body]]);
  expect((await noticeRows()).map((r) => r.notice)).toEqual(["config_continue"]);
});

test("Stop crons taking over the apply hibernate keeps the wake: the agent continues, and the crons sentence is left to crons_stopped", async () => {
  await idle();
  driver.last.emit(ev.cron("c1", { humanSchedule: "every 5 minutes" }));
  await rt.settled();
  driver.last.holdStop = true;
  await rt.requestRestart({ current: changed, wake: true });
  expect(await rt.stopCrons("or")).toEqual({ status: "stopped" });
  driver.last.releaseStop();
  await rt.settled();
  expect(await hibernatedReasons()).toEqual(["crons_stopped"]);
  expect(driver.starts).toHaveLength(2); // woken by config_continue
  const [first] = batches(driver.last);
  expect(first).toHaveLength(2);
  expect(first?.[0]).toContain("stopped your crons: every 5 minutes");
  expect(first?.[1]).toBe(notices.configContinue({ crons: [] }));
});

test.each([
  ["a crash", async () => driver.last.exit(1)],
  ["an archive", () => rt.stop()],
] as const)("%s clears the wake: no config_continue is ever added", async (_n, exit) => {
  await idle();
  driver.last.emit(ev.turn());
  await rt.settled();
  await rt.requestRestart({ current: changed, wake: true });
  expect(rt.live().restartPending).toBe(true);
  await exit();
  await rt.settled();
  // the next, unrelated restart must not carry the old wake
  await h.send("again", false);
  driver.last.emit(...ev.fullTurn("sess-1"));
  await rt.settled();
  await rt.requestRestart();
  await rt.settled();
  expect((await noticeRows()).map((r) => r.notice)).not.toContain("config_continue");
  expect(driver.last.stopped).toBe(true);
});
