import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ev } from "./testing/fake-driver.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";
import { RecordingSlots } from "./testing/slots.ts";

const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());
beforeEach(async () => {
  // Only timers and the clock: setImmediate (settled()) and the DB driver keep running for real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await h.makeRuntime({ warmWindowMinutes: 1 });
});
afterEach(() => {
  vi.useRealTimers();
});

const types = async () => (await h.store.after(h.agentId, 0, 1000)).map((e) => e.event.type);

/** A started, idle process on session sess-1. */
async function idle() {
  await h.send("hi");
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await h.rt.settled();
}

test("hibernates after the warm window when fully idle", async () => {
  await idle();
  await vi.advanceTimersByTimeAsync(60_000);
  await h.rt.settled();
  expect(h.driver.last.stopped).toBe(true);
  expect(await types()).toContain("hibernated");
});

test("doesn't hibernate before the warm window ends", async () => {
  await idle();
  await vi.advanceTimersByTimeAsync(59_000);
  await h.rt.settled();
  expect(h.driver.last.stopped).toBe(false);
});

// Without the busy input the agent would stop at 60 s; the owed notification holds it until its 30 s bound
// releases, then the warm window runs (stop at 90 s), so 89 s shows it held.
test.each([
  ["a live non-ambient task", 300_000, () => h.driver.last.emit(ev.background([{ taskId: "t" }]))],
  ["a live cron", 300_000, () => h.driver.last.emit(ev.cron("c1"))],
  [
    "an owed notification turn (under 30 s)",
    89_000,
    () => h.driver.last.emit(ev.taskFinished("t"), ev.background([])),
  ],
])("never hibernates with %s", async (_n, ms, busy) => {
  await idle();
  busy();
  await h.rt.settled();
  await vi.advanceTimersByTimeAsync(ms);
  await h.rt.settled();
  expect(h.driver.last.stopped).toBe(false);
});

test("the owed-notification bound releases after 30 s with no turn open", async () => {
  await idle();
  h.driver.last.emit(ev.taskFinished("t"), ev.background([]));
  await h.rt.settled();
  expect(h.rt.busy()).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  await h.rt.settled();
  expect(h.rt.busy()).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  await h.rt.settled();
  expect(h.driver.last.stopped).toBe(true);
});

test("the bound never fires during an open turn", async () => {
  await idle();
  h.driver.last.emit(ev.taskFinished("t"), ev.background([]), ev.turn());
  await h.rt.settled();
  await vi.advanceTimersByTimeAsync(40_000);
  await h.rt.settled();
  h.driver.last.emit(ev.end()); // not the notification turn: the counter is still owed
  await h.rt.settled();
  expect(h.rt.busy()).toBe(true);
  // re-armed at that turn_end
  await vi.advanceTimersByTimeAsync(30_000);
  await h.rt.settled();
  expect(h.rt.busy()).toBe(false);
});

test("the notification turn pays the owed counter", async () => {
  await idle();
  h.driver.last.emit(ev.taskFinished("t"), ev.background([]));
  h.driver.last.emit(ev.turn(), ev.end({ originKind: "task-notification" }));
  await h.rt.settled();
  expect(h.rt.busy()).toBe(false);
  expect(h.rt.hibernatable()).toBe(true);
});

test("an ambient task doesn't block; waitingOn excludes it", async () => {
  await idle();
  h.driver.last.emit(ev.background([{ taskId: "mon", ambient: true }]));
  await h.rt.settled();
  expect(h.rt.waitingOn()).toEqual({ tasks: [], crons: 0 });
  expect(h.rt.busy()).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  await h.rt.settled();
  expect(h.driver.last.stopped).toBe(true);
});

test("a one-shot cron unpins after its firing turn", async () => {
  await idle();
  h.driver.last.emit(ev.cron("once", { recurring: false, inMs: 10_000 }));
  await h.rt.settled();
  await vi.advanceTimersByTimeAsync(11_000);
  await h.rt.settled();
  expect(h.rt.pinned()).toBe(true); // its time passed, but its turn hasn't run yet
  h.driver.last.emit(ev.turn(), ev.end({ originKind: "cron" }));
  await h.rt.settled();
  expect(h.rt.pinned()).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  await h.rt.settled();
  expect(h.driver.last.stopped).toBe(true);
});

test("a cron turn before a one-shot's time doesn't unpin it", async () => {
  await idle();
  h.driver.last.emit(ev.cron("once", { recurring: false, inMs: 120_000 }));
  h.driver.last.emit(ev.turn(), ev.end({ originKind: "cron" }));
  await h.rt.settled();
  expect(h.rt.pinned()).toBe(true);
});

test("cron_deleted unpins; a recurring cron expires 7 days after it was created", async () => {
  await idle();
  h.driver.last.emit(ev.cron("c1"), ev.cron("c2"));
  await h.rt.settled();
  h.driver.last.emit({ type: "cron_deleted", cronId: "c1" });
  await h.rt.settled();
  expect(h.rt.waitingOn().crons).toBe(1);
  await vi.advanceTimersByTimeAsync(7 * 24 * 3_600_000);
  await h.rt.settled();
  expect(h.rt.pinned()).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  await h.rt.settled();
  expect(h.driver.last.stopped).toBe(true);
});

test("waitingOn reports tasks with startedAt and the cron count; the journal follows", async () => {
  await idle();
  const t0 = Date.now();
  h.driver.last.emit(ev.background([{ taskId: "t", description: "build" }]));
  await h.rt.settled();
  await vi.advanceTimersByTimeAsync(5_000);
  h.driver.last.emit(
    ev.background([
      { taskId: "t", description: "build" },
      { taskId: "u", description: "tests" },
      { taskId: "mon", ambient: true },
    ]),
    ev.cron("c1"),
  );
  await h.rt.settled();
  expect(h.rt.waitingOn()).toEqual({
    tasks: [
      { taskId: "t", description: "build", startedAt: new Date(t0).toISOString() },
      { taskId: "u", description: "tests", startedAt: new Date(t0 + 5_000).toISOString() },
    ],
    crons: 1,
  });
  expect(h.rt.live().waitingOn).toEqual(h.rt.waitingOn());
  const row = await h.store.agentById(h.agentId);
  expect(row?.runtimeJournal).toMatchObject({
    tasks: [
      { taskId: "t", description: "build" },
      { taskId: "u", description: "tests" },
    ],
    crons: [{ cronId: "c1", humanSchedule: "every 5 minutes" }],
  });
});

test("a clean exit clears the live sets and the journal", async () => {
  await idle();
  h.driver.last.emit(ev.background([{ taskId: "t" }]), ev.cron("c1"));
  await h.rt.settled();
  await h.rt.hibernate("shutdown");
  await h.rt.settled();
  expect(h.rt.waitingOn()).toEqual({ tasks: [], crons: 0 });
  expect((await h.store.agentById(h.agentId))?.runtimeJournal).toBeNull();
});

test("lastActivityAt moves on start, delivery and turn end", async () => {
  const t0 = Date.now();
  await idle();
  expect(h.rt.lastActivityAt).toBe(t0);
  await vi.advanceTimersByTimeAsync(10_000);
  h.driver.last.emit(ev.turn(), ev.end());
  await h.rt.settled();
  expect(h.rt.lastActivityAt).toBe(t0 + 10_000);
});

test("the Supervisor hears each false-to-true hibernatable edge once", async () => {
  const slots = new RecordingSlots();
  await h.makeRuntime({ slots, warmWindowMinutes: 1 });
  await idle();
  h.driver.last.emit(ev.background([]));
  await h.rt.settled();
  expect(slots.events.filter((e) => e[0] === "hibernatable")).toHaveLength(1);
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  expect(h.rt.hibernatable()).toBe(false);
  h.driver.last.emit(ev.end());
  await h.rt.settled();
  expect(slots.events.filter((e) => e[0] === "hibernatable")).toHaveLength(2);
});

test("a message arriving resets the warm window", async () => {
  await idle();
  await vi.advanceTimersByTimeAsync(50_000);
  await h.send("again");
  h.driver.last.emit(ev.turn(), ev.end());
  await h.rt.settled();
  await vi.advanceTimersByTimeAsync(50_000);
  await h.rt.settled();
  expect(h.driver.last.stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  await h.rt.settled();
  expect(h.driver.last.stopped).toBe(true);
});

test("the closing latch clears the warm timer", async () => {
  await idle();
  h.rt.setNoStart();
  await vi.advanceTimersByTimeAsync(120_000);
  await h.rt.settled();
  expect(h.driver.last.stopped).toBe(false);
});
