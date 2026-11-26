import type { Envelope } from "@open-factory/shared";
import { tagOf } from "@open-factory/shared/tags";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { peerBody } from "../messaging/peer-body.ts";
import type { CredentialPause } from "../supervisor/slots.ts";
import { testRef } from "../test/principals.ts";
import { ev } from "./testing/fake-driver.ts";
import { insertAgent } from "./testing/rows.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";
import { RecordingSlots } from "./testing/slots.ts";

// I9 §4.8, AC 14: a member update reaches its manager after the debounce in every state, like a message.

const h = new RuntimeHarness();
const REPORT = "rep-mu";
const DEBOUNCE = 30_000;
let slots: RecordingSlots;
beforeAll(async () => {
  await h.setup();
  await insertAgent(h.t.sql, { id: REPORT, slug: "devrep" });
});
afterAll(() => h.close());
// The store's stamps are strictly increasing across tests, so each test's fake clock starts after the last one ended
// (a row stamped ahead of the clock would never be due).
let clockEnd = 0;
beforeEach(() => {
  // Only timers and the clock: setImmediate (settled()) and the DB driver keep running for real.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date"],
    now: Math.max(Date.now(), clockEnd + 1_000),
  });
  slots = new RecordingSlots();
});
afterEach(() => {
  clockEnd = Date.now();
  vi.useRealTimers();
});

/** A RecordingSlots whose credential pause the test sets. */
class PausableSlots extends RecordingSlots {
  paused: CredentialPause | undefined;
  override pauseOf(): CredentialPause | undefined {
    return this.paused;
  }
}

const updateRow = (body: string, agentId = h.agentId) =>
  h.store.createOrgRow({ kind: "member_update", toAgentId: agentId, fromAgentId: REPORT, body });
/** The report's update, persisted and handed to the manager as the Router does. */
async function update(body: string) {
  await h.receive(await updateRow(body));
}
async function peer(body: string) {
  await h.receive(
    await h.store.createOrgRow({
      kind: "peer_joined",
      toAgentId: h.agentId,
      subjectAgentId: REPORT,
      notice: "peer",
      body,
    }),
  );
}
const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await h.rt.settled();
};
/** The update bodies written to the current process, batch by batch. */
const updatesWritten = () =>
  h.driver.last.sent.flatMap((b) => b.filter((m) => m.kind === "member_update").map((m) => m.body));
const kinds = () => h.driver.last.sent.map((batch) => batch.map((m) => m.kind));
const messageIns = async () =>
  (await h.store.after(h.agentId, 0, 1000)).flatMap((e) =>
    e.event.type === "message_in" ? [{ seq: e.seq, messages: e.event.messages as Envelope[] }] : [],
  );
async function idle() {
  await h.send("hi");
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await h.rt.settled();
}

// ---------- the regression tests: every state ----------

test("an idle manager is sent its report's update once the debounce has passed, not before", async () => {
  await h.makeRuntime({ memberUpdateDebounceMs: DEBOUNCE });
  await idle();
  await update("done: PR #12 is green");
  await tick(DEBOUNCE - 1_000);
  expect(updatesWritten()).toEqual([]);
  await tick(1_500);
  expect(updatesWritten()).toEqual(["done: PR #12 is green"]);
  expect(h.driver.starts).toHaveLength(1);
});

test("a batch taken in by an origin-tagged turn leaves the manager idle: the next update is delivered and the warm window hibernates it", async () => {
  await h.makeRuntime({ memberUpdateDebounceMs: DEBOUNCE, warmWindowMinutes: 2 });
  await idle();
  await update("first");
  await tick(DEBOUNCE + 500);
  expect(updatesWritten()).toEqual(["first"]);
  // Claude takes the idle-written batch into a turn it started itself (a task notification).
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end({ originKind: "task-notification" }));
  await h.rt.settled();
  expect(h.rt.statusFrame().status).toBe("idle");
  await update("second");
  await tick(DEBOUNCE + 500);
  expect(updatesWritten()).toEqual(["first", "second"]);
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end({ originKind: "cron" }));
  await h.rt.settled();
  expect(h.rt.statusFrame().status).toBe("idle");
  await tick(120_000);
  expect(h.driver.last.stopped).toBe(true);
  expect(h.rt.statusFrame().status).toBe("hibernated");
});

test("a manager mid-turn is sent the update before its turn ends", async () => {
  await h.makeRuntime({ memberUpdateDebounceMs: DEBOUNCE });
  await idle();
  await h.send("work on it");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  await update("halfway there");
  await tick(DEBOUNCE + 500);
  expect(updatesWritten()).toEqual(["halfway there"]);
  expect(h.rt.statusFrame().status).toBe("working"); // the turn is still open
});

test("a hibernated manager is woken with the update after the debounce", async () => {
  await h.makeRuntime({ slots, memberUpdateDebounceMs: DEBOUNCE });
  await update("while you slept");
  await tick(DEBOUNCE - 1_000);
  expect(h.driver.starts).toHaveLength(0);
  await tick(1_500);
  expect(slots.events).toContainEqual(["request", "member_updates"]);
  expect(h.driver.starts).toHaveLength(1);
  expect(updatesWritten()).toEqual(["while you slept"]);
});

test("an errored manager starts one attempt for the update, as a human's message does", async () => {
  await h.makeRuntime({
    memberUpdateDebounceMs: DEBOUNCE,
    status: "errored",
    errorKind: "crash",
    sessionId: "sess-1",
  });
  await update("report is blocked");
  await tick(DEBOUNCE + 500);
  expect(h.driver.starts).toHaveLength(1);
  expect(updatesWritten()).toEqual(["report is blocked"]);
  // The attempt is recorded as made for the member update, not for a human's message.
  const started = (await h.store.after(h.agentId, 0, 100)).flatMap((e) =>
    e.event.type === "process_started" ? [e.event.reason] : [],
  );
  expect(started.at(-1)).toBe("member_updates");
  // The attempt's turn ends: the error clears.
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await h.rt.settled();
  expect(h.rt.statusFrame().status).toBe("idle");
});

test("a turn end with no open turn leaves the written batch awaiting: the manager still reads as working", async () => {
  await h.makeRuntime({ memberUpdateDebounceMs: 0 });
  await idle();
  await update("now");
  await tick(0);
  expect(updatesWritten()).toEqual(["now"]);
  h.driver.last.emit(ev.end());
  await h.rt.settled();
  expect(h.rt.statusFrame().status).toBe("working");
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end());
  await h.rt.settled();
  expect(h.rt.statusFrame().status).toBe("idle");
});

// ---------- the debounce ----------

test("the debounce runs from the oldest pending update; later ones go out in the same merged envelope", async () => {
  await h.makeRuntime({ memberUpdateDebounceMs: DEBOUNCE });
  await idle();
  await update("a");
  await tick(20_000);
  await update("b");
  await tick(9_000);
  expect(updatesWritten()).toEqual([]);
  await tick(1_500); // 30.5 s after "a", 10.5 s after "b"
  const last = h.driver.last.sent.at(-1) ?? [];
  expect(last).toHaveLength(1);
  expect(last[0]).toMatchObject({
    kind: "member_update",
    from: `<@${testRef(REPORT)}|devrep>`,
    body: "a\n\nb",
  });
  expect(last[0]?.ids).toHaveLength(2);
});

test("debounce 0: an update goes out at once, mid-turn too", async () => {
  await h.makeRuntime({ memberUpdateDebounceMs: 0 });
  await idle();
  await update("now");
  await tick(0);
  expect(updatesWritten()).toEqual(["now"]);
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  await update("later");
  await tick(0);
  expect(updatesWritten()).toEqual(["now", "later"]);
});

test("hand-offs out of order still go out in created order", async () => {
  await h.makeRuntime({ memberUpdateDebounceMs: DEBOUNCE });
  await idle();
  const a = await updateRow("a");
  const b = await updateRow("b");
  await Promise.all([h.rt.receive(b), h.rt.receive(a), h.rt.receive(b)]);
  await tick(DEBOUNCE + 500);
  expect(h.driver.last.sent.at(-1)).toEqual([
    expect.objectContaining({ body: "a\n\nb", ids: [a.id, b.id] }),
  ]);
});

test("a factory fact renders with about and its fact code, in its report's group", async () => {
  await h.makeRuntime({ memberUpdateDebounceMs: DEBOUNCE });
  await idle();
  await update("text");
  await h.receive(
    await h.store.createOrgRow({
      kind: "member_update",
      toAgentId: h.agentId,
      subjectAgentId: REPORT,
      notice: "denied",
      body: "Bash was denied for @devrep.",
    }),
  );
  await tick(DEBOUNCE + 500);
  expect(h.driver.last.sent.at(-1)?.map((m) => [m.from, m.about, m.fact])).toEqual([
    [`<@${testRef(REPORT)}|devrep>`, undefined, undefined],
    ["@factory", `<@${testRef(REPORT)}|devrep>`, "denied"],
  ]);
});

test("a window longer than setTimeout's maximum is clamped, never overflowing to a 1 ms busy loop", async () => {
  const MAX = 2 ** 31 - 1;
  await h.makeRuntime({ memberUpdateDebounceMs: 30 * 86_400_000 });
  await idle();
  const spy = vi.spyOn(globalThis, "setTimeout");
  try {
    await update("far");
    const delays = spy.mock.calls.map((c) => c[1] ?? 0);
    expect(delays).toContain(MAX);
    expect(delays.every((d) => d <= MAX)).toBe(true);
    spy.mockClear();
    await tick(1_000); // an overflowed timer would have fired (and re-armed) about a thousand times
    expect(spy.mock.calls.length).toBeLessThan(5);
    expect(updatesWritten()).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

// ---------- updates inside the debounce never hold the agent ----------

test("a manager with only updates inside the debounce hibernates; the timer wakes it and the first batch carries them", async () => {
  await h.makeRuntime({ slots, memberUpdateDebounceMs: DEBOUNCE });
  await idle();
  await update("while you slept");
  expect(h.rt.hibernatable()).toBe(true);
  expect(await h.rt.hibernate("warm_window")).toBe(true);
  await h.rt.settled();
  expect(h.driver.last.stopped).toBe(true);
  expect(slots.events).not.toContainEqual(["request", "member_updates"]);
  await tick(DEBOUNCE + 500);
  expect(slots.events).toContainEqual(["request", "member_updates"]);
  expect(h.driver.starts).toHaveLength(2);
  expect(kinds()).toEqual([["member_update"]]);
});

test("a wake granted while every update is inside the debounce gives the slot back", async () => {
  await h.makeRuntime({ slots, memberUpdateDebounceMs: DEBOUNCE });
  await update("young");
  await h.rt.grant("member_updates");
  expect(slots.events).toContainEqual(["release"]);
  expect(h.driver.starts).toHaveLength(0);
});

test("an idle crash with only updates inside the debounce is a plain hibernation", async () => {
  await h.makeRuntime({ slots, memberUpdateDebounceMs: DEBOUNCE });
  await idle();
  await update("young");
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(h.rt.statusFrame().status).toBe("hibernated");
  expect(slots.events).not.toContainEqual(["request", "crash_recovery"]);
});

test("the closing latch and archive clear the timer: nothing is written or woken", async () => {
  await h.makeRuntime({ slots, memberUpdateDebounceMs: DEBOUNCE });
  await update("a");
  h.rt.setNoStart();
  await tick(DEBOUNCE + 1_000);
  expect(slots.events).not.toContainEqual(["request", "member_updates"]);
  await h.makeRuntime({ slots, memberUpdateDebounceMs: DEBOUNCE });
  await update("b");
  h.rt.markArchived();
  await tick(DEBOUNCE + 1_000);
  expect(slots.events).not.toContainEqual(["request", "member_updates"]);
  expect(h.driver.starts).toHaveLength(0);
});

// ---------- rate limits and errors ----------

test("a rate-limited manager keeps due updates queued and gets them at the reset", async () => {
  const paused = new PausableSlots();
  await h.makeRuntime({ slots: paused, memberUpdateDebounceMs: DEBOUNCE });
  await idle();
  paused.paused = { until: new Date(Date.now() + 3_600_000), exact: true };
  await update("held by the pause");
  await tick(DEBOUNCE + 1_000);
  expect(updatesWritten()).toEqual([]);
  expect(h.rt.queueItems()).toEqual([
    expect.objectContaining({ kind: "message", from: "@devrep", body: "held by the pause" }),
  ]);
  paused.paused = undefined;
  h.rt.resumeAfterReset();
  await h.rt.settled();
  expect(updatesWritten()).toEqual(["held by the pause"]);
});

test("a hibernated rate-limited manager reads rate_limited once its update is due, and starts at the reset", async () => {
  const paused = new PausableSlots();
  paused.paused = { until: new Date(Date.now() + 3_600_000), exact: true };
  paused.answer = "queued";
  await h.makeRuntime({ slots: paused, memberUpdateDebounceMs: DEBOUNCE });
  await update("held while asleep");
  expect(h.rt.statusFrame().status).toBe("hibernated");
  await tick(DEBOUNCE + 1_000);
  expect(h.rt.statusFrame().status).toBe("rate_limited");
  expect(paused.events).toContainEqual(["request", "member_updates"]);
  expect(h.driver.starts).toHaveLength(0);
  paused.paused = undefined;
  paused.answer = "granted";
  h.rt.resumeAfterReset();
  await h.rt.settled();
  expect(paused.events).toContainEqual(["request", "rate_limit_reset"]);
  expect(updatesWritten()).toEqual(["held while asleep"]);
});

test("a manager whose recovery needs Start a new session keeps the update queued and gets it at the reset", async () => {
  await h.makeRuntime({
    slots,
    memberUpdateDebounceMs: DEBOUNCE,
    status: "errored",
    sessionId: "sess-1",
    errorKind: "resume_unrecoverable",
  });
  await update("due while errored");
  await tick(DEBOUNCE + 1_000);
  expect(h.driver.starts).toHaveLength(0);
  expect(h.rt.queueItems()).toEqual([expect.objectContaining({ from: "@devrep" })]);
  await h.rt.resetSession({ by: "<@or>" });
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(1);
  expect(updatesWritten()).toEqual(["due while errored"]);
});

// ---------- boot ----------

test("boot: init() re-arms the debounce for pending updates and delivers ones already due at once", async () => {
  await h.makeRuntime({
    slots,
    memberUpdateDebounceMs: DEBOUNCE,
    seed: (id) => updateRow("young", id).then(() => undefined),
  });
  expect(h.rt.hasDeliverable()).toBe(false);
  await tick(DEBOUNCE - 1_000);
  expect(slots.events).not.toContainEqual(["request", "member_updates"]);
  await tick(1_500);
  expect(slots.events).toContainEqual(["request", "member_updates"]);
  expect(updatesWritten()).toEqual(["young"]);

  slots = new RecordingSlots();
  await h.makeRuntime({
    slots,
    memberUpdateDebounceMs: DEBOUNCE,
    seed: async (id) => {
      await updateRow("old", id);
      vi.setSystemTime(Date.now() + DEBOUNCE + 1_000);
    },
  });
  await tick(0);
  expect(slots.events).toContainEqual(["request", "member_updates"]);
  expect(updatesWritten()).toEqual(["old"]);
});

test("loading an errored manager with pending updates starts nothing; they ride along with its Restart", async () => {
  await h.makeRuntime({
    slots,
    memberUpdateDebounceMs: DEBOUNCE,
    status: "errored",
    sessionId: "sess-1",
    errorKind: "crash",
    seed: (id) => updateRow("stuck report text", id).then(() => undefined),
  });
  await tick(DEBOUNCE + 1_000);
  expect(h.driver.starts).toHaveLength(0);
  expect(h.rt.queueItems()).toEqual([
    expect.objectContaining({ kind: "message", from: "@devrep", body: "stuck report text" }),
  ]);
  await h.rt.restartNow({ by: "@or", force: false, changes: [], runtimeAllowed: true });
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(1);
  expect(kinds()).toEqual([["system", "member_update"]]);
});

// ---------- peer events ----------

test("a peer event is a queued notice that never wakes or is written alone; it rides along with the next batch", async () => {
  await h.makeRuntime({ slots, memberUpdateDebounceMs: DEBOUNCE });
  await idle();
  await peer(`${tagOf(testRef(REPORT))} (Dev agent) joined as your peer.`);
  expect(h.rt.queueItems()).toEqual([
    expect.objectContaining({ kind: "notice", from: "@factory" }),
  ]);
  expect(h.rt.hasDeliverable()).toBe(false);
  await tick(120_000);
  expect(h.driver.last.sent.flat().some((m) => m.kind === "peer_joined")).toBe(false);
  await h.send("hello");
  expect(kinds().at(-1)).toEqual(["message", "peer_joined"]);
});

test("a peer_left envelope carries its subject, with the move target read back from the body", async () => {
  await h.makeRuntime({ slots, memberUpdateDebounceMs: DEBOUNCE });
  await idle();
  const LEAD_TAG = tagOf(testRef("leadx"));
  const body = peerBody(
    { ref: testRef(REPORT), displayName: "Dev agent" },
    "report",
    { kind: "peer_left", left: { reason: "moved", to: LEAD_TAG } },
    testRef("leadx"),
  );
  await h.receive(
    await h.store.createOrgRow({
      kind: "peer_left",
      toAgentId: h.agentId,
      subjectAgentId: REPORT,
      notice: "report",
      body,
    }),
  );
  await h.send("hello");
  const env = (await messageIns()).at(-1)?.messages.find((m) => m.kind === "peer_left");
  expect(env).toMatchObject({
    from: "@factory",
    body: `<@${testRef(REPORT)}|devrep> (Dev agent) left: now reports to <@${testRef("leadx")}|unknown>.`,
    subject: {
      slug: "devrep",
      displayName: "Dev agent",
      relation: "report",
      left: { reason: "moved", to: LEAD_TAG },
    },
  });
});

test("C3: every write records the message_in seq on its rows, before session_started too", async () => {
  await h.makeRuntime({ slots });
  const sent = await h.send("first"); // written before session_started
  const seqOf = async (id: string) =>
    (await h.t.sql`select delivered_event_seq from messages where id = ${id}`)[0]
      ?.delivered_event_seq;
  const [first] = await messageIns();
  expect(await seqOf(sent.id)).toBe(first?.seq);
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await h.rt.settled();
  const second = await h.send("second");
  expect(await seqOf(second.id)).toBe((await messageIns()).at(-1)?.seq);
});
