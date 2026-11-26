import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ev } from "./testing/fake-driver.ts";
import { insertAgent } from "./testing/rows.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";

// S10 §8.2, AC4, Q8: the factory default warm window and the member-update debounce are read live, and a settings
// change re-arms an armed warm timer (only for a snapshot that omits the window) and the held-update timer.
const h = new RuntimeHarness();
const REPORT = "rep-live";
beforeAll(async () => {
  await h.setup();
  await insertAgent(h.t.sql, { id: REPORT, handle: "devrep" });
});
afterAll(() => h.close());

const settings = { warm: 70, debounceMs: 30_000 };
const getters = {
  defaultWarmWindowMinutes: () => settings.warm,
  memberUpdateDebounceMs: () => settings.debounceMs,
};

// The store's stamps are strictly increasing across tests, so each test's fake clock starts after the last one ended.
let clockEnd = 0;
beforeEach(() => {
  // Only timers and the clock: setImmediate (settled()) and the DB driver keep running for real.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date"],
    now: Math.max(Date.now(), clockEnd + 1_000),
  });
  settings.warm = 70;
  settings.debounceMs = 30_000;
});
afterEach(() => {
  clockEnd = Date.now();
  vi.useRealTimers();
});

const MIN = 60_000;
const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await h.rt.settled();
};
/** A started, idle process on session sess-1: the warm timer is armed when this returns. */
async function idle() {
  await h.send("hi");
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await h.rt.settled();
}
const hibernated = async () =>
  (await h.store.after(h.agentId, 0, 1000)).some((e) => e.event.type === "hibernated");
const change = async (patch: Partial<typeof settings>) => {
  Object.assign(settings, patch);
  await h.rt.settingsChanged();
  await h.rt.settled();
};

test("a snapshot without a warm window hibernates after the factory default", async () => {
  settings.warm = 5;
  await h.makeRuntime({ ...getters });
  await idle();
  await tick(5 * MIN - 1_000);
  expect(h.driver.last.stopped).toBe(false);
  await tick(1_000);
  expect(h.driver.last.stopped).toBe(true);
  expect(await hibernated()).toBe(true);
});

test("lowering the default re-arms the armed timer from when it was armed", async () => {
  await h.makeRuntime({ ...getters });
  await idle();
  await tick(3 * MIN);
  await change({ warm: 10 });
  await tick(7 * MIN - 1_000);
  expect(h.driver.last.stopped).toBe(false);
  await tick(1_000);
  expect(h.driver.last.stopped).toBe(true);
  expect(await hibernated()).toBe(true);
});

test("a default already past since the timer was armed hibernates at once", async () => {
  await h.makeRuntime({ ...getters });
  await idle();
  await tick(3 * MIN);
  await change({ warm: 2 });
  await tick(0);
  expect(h.driver.last.stopped).toBe(true);
  expect(await hibernated()).toBe(true);
});

test("raising the default re-arms for the longer window", async () => {
  settings.warm = 5;
  await h.makeRuntime({ ...getters });
  await idle();
  await tick(3 * MIN);
  await change({ warm: 20 });
  await tick(17 * MIN - 1_000);
  expect(h.driver.last.stopped).toBe(false);
  await tick(1_000);
  expect(h.driver.last.stopped).toBe(true);
});

test("a snapshot that holds 70 keeps its window", async () => {
  await h.makeRuntime({ ...getters, warmWindowMinutes: 70 });
  await idle();
  await tick(3 * MIN);
  await change({ warm: 2 });
  await tick(0);
  expect(h.driver.last.stopped).toBe(false);
  await tick(67 * MIN - 1_000);
  expect(h.driver.last.stopped).toBe(false);
  await tick(1_000);
  expect(h.driver.last.stopped).toBe(true);
});

/** Hands a member update to the runtime; returns its creation stamp (t0 of its debounce window). */
async function update(body: string): Promise<number> {
  const row = await h.store.createOrgRow({
    kind: "member_update",
    toAgentId: h.agentId,
    fromAgentId: REPORT,
    body,
  });
  await h.receive(row);
  return row.createdAt.getTime();
}
/** Advances the fake clock (running timers) to `at`. */
const tickTo = (at: number) => tick(at - Date.now());
const updateWritten = () =>
  h.driver.starts.some((p) => p.sent.flat().some((m) => m.kind === "member_update"));

test("lowering the debounce delivers a pending update from its creation time", async () => {
  await h.makeRuntime({ ...getters });
  await idle();
  const t0 = await update("u");
  await tickTo(t0 + 1_000);
  await change({ debounceMs: 5_000 });
  await tickTo(t0 + 5_000 - 1);
  expect(updateWritten()).toBe(false);
  await tickTo(t0 + 5_000);
  expect(updateWritten()).toBe(true);
});

test("a debounce of 0 delivers a pending update at once", async () => {
  await h.makeRuntime({ ...getters });
  await idle();
  const t0 = await update("u");
  await tickTo(t0 + 1_000);
  expect(updateWritten()).toBe(false);
  await change({ debounceMs: 0 });
  await tick(0);
  expect(updateWritten()).toBe(true);
});
