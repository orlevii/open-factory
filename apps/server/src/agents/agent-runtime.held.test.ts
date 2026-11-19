import type { Envelope } from "@open-factory/shared";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { peerBody } from "../messaging/peer-body.ts";
import type { CredentialPause } from "../supervisor/slots.ts";
import { ev } from "./testing/fake-driver.ts";
import { insertAgent } from "./testing/rows.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";
import { RecordingSlots } from "./testing/slots.ts";

const h = new RuntimeHarness();
const REPORT = "rep-held";
const LEAD = "lead-held";
let slots: RecordingSlots;
beforeAll(async () => {
  await h.setup();
  await insertAgent(h.t.sql, { id: REPORT, slug: "devrep" });
  await insertAgent(h.t.sql, { id: LEAD, slug: "leadx" });
});
afterAll(() => h.close());
// The store's stamps are strictly increasing across tests, so each test's fake clock starts after the last one ended
// (a row stamped ahead of the clock would never be due).
let clockEnd = 0;
beforeEach(async () => {
  // Only timers and the clock: setImmediate (settled()) and the DB driver keep running for real.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date"],
    now: Math.max(Date.now(), clockEnd + 1_000),
  });
  slots = new RecordingSlots();
  await h.makeRuntime({ slots });
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

async function update(body: string) {
  await h.receive(
    await h.store.createHeld({
      kind: "member_update",
      toAgentId: h.agentId,
      fromAgentId: REPORT,
      body,
    }),
  );
}
async function peer(body: string) {
  await h.receive(
    await h.store.createHeld({
      kind: "peer_joined",
      toAgentId: h.agentId,
      subjectAgentId: REPORT,
      notice: "peer",
      body,
    }),
  );
}
async function idle() {
  await h.send("hi");
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await h.rt.settled();
}
const kinds = () => h.driver.last.sent.map((batch) => batch.map((m) => m.kind));
const anyUpdateWritten = () =>
  h.driver.starts.some((p) => p.sent.flat().some((m) => m.kind === "member_update"));
const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await h.rt.settled();
};
/** Moves the clock without running any timer: a held update becomes due while its timer hasn't fired yet. */
const ageBy = (ms: number) => vi.setSystemTime(Date.now() + ms);
const messageIns = async () =>
  (await h.store.after(h.agentId, 0, 1000)).flatMap((e) =>
    e.event.type === "message_in" ? [{ seq: e.seq, messages: e.event.messages as Envelope[] }] : [],
  );

test("AC 2: never written mid-turn; written right after the manager's turn ends, as one merged envelope", async () => {
  await idle();
  await h.send("work on it");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  await update("narration 1");
  await update("narration 2");
  await update("final answer 42");
  expect(anyUpdateWritten()).toBe(false);
  h.driver.last.emit(ev.usage(), ev.end());
  await h.rt.settled();
  const last = h.driver.last.sent.at(-1) ?? [];
  expect(last).toHaveLength(1);
  expect(last[0]).toMatchObject({
    kind: "member_update",
    from: "devrep",
    body: "narration 1\n\nnarration 2\n\nfinal answer 42",
  });
  expect(last[0]?.ids).toHaveLength(3);
});

test("the gap between an idle write and turn_started counts as turn-open", async () => {
  await idle();
  await h.send("x"); // written, awaiting its turn: no turn_started yet
  await update("u");
  await tick(31_000);
  expect(anyUpdateWritten()).toBe(false);
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end()); // that turn ran a direct message: not update-only
  await h.rt.settled();
  expect(kinds().at(-1)).toEqual(["member_update"]);
});

test("a compact in flight counts as turn-open", async () => {
  await h.makeRuntime({ slots, memberUpdateDebounceMs: 0 });
  await idle();
  await h.rt.compact({ byHandle: "or" });
  await h.rt.settled();
  expect(h.driver.last.controls.at(-1)).toMatchObject({ cmd: "compact" });
  await update("u");
  expect(anyUpdateWritten()).toBe(false);
  h.driver.last.emit(ev.turn(), ev.end({ command: "compact" }));
  await h.rt.settled();
  expect(kinds().at(-1)).toEqual(["member_update"]);
});

test("idle manager: due after the window, fixed from the oldest pending update", async () => {
  await idle();
  await update("a");
  await tick(20_000);
  await update("b");
  await tick(9_000);
  expect(anyUpdateWritten()).toBe(false);
  await tick(1_500); // 30.5 s after "a", 10.5 s after "b"
  expect(h.driver.last.sent.at(-1)?.[0]).toMatchObject({ kind: "member_update", body: "a\n\nb" });
});

test("R5: after an update-only turn the window applies, not the turn-end rule", async () => {
  await idle();
  await update("a");
  await tick(30_500); // "a" written alone: the next turn is update-only
  expect(h.driver.last.sent.at(-1)?.[0]?.body).toBe("a");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  await update("b");
  h.driver.last.emit(ev.usage(), ev.end());
  await h.rt.settled();
  expect(h.driver.last.sent.at(-1)?.[0]?.body).toBe("a"); // b not written at that turn end
  await tick(30_500);
  expect(h.driver.last.sent.at(-1)?.[0]?.body).toBe("b");
});

test("held rows ride along with a batch written while idle; peer events are never due on their own", async () => {
  await idle();
  await peer("@devrep (Dev agent) joined as your peer.");
  await tick(120_000);
  expect(h.driver.last.sent.flat().some((m) => m.kind === "peer_joined")).toBe(false);
  await h.send("hello");
  expect(kinds().at(-1)).toEqual(["message", "peer_joined"]);
});

test("a peer_left envelope carries its subject, with the move target read back from the body", async () => {
  await idle();
  const body = peerBody({ slug: "devrep", displayName: "Dev agent" }, "report", {
    kind: "peer_left",
    left: { reason: "moved", to: "leadx" },
  });
  await h.receive(
    await h.store.createHeld({
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
    body,
    subject: {
      slug: "devrep",
      displayName: "Dev agent",
      relation: "report",
      left: { reason: "moved", to: "leadx" },
    },
  });
});

test("a factory fact renders with about and its fact code, in its report's group", async () => {
  await h.makeRuntime({ slots, memberUpdateDebounceMs: 0 });
  await idle();
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  await update("text");
  await h.receive(
    await h.store.createHeld({
      kind: "member_update",
      toAgentId: h.agentId,
      subjectAgentId: REPORT,
      notice: "denied",
      body: "Bash was denied for @devrep.",
    }),
  );
  h.driver.last.emit(ev.usage(), ev.end());
  await h.rt.settled();
  expect(h.driver.last.sent.at(-1)?.map((m) => [m.from, m.about, m.fact])).toEqual([
    ["devrep", undefined, undefined],
    ["@factory", "devrep", "denied"],
  ]);
});

test("hand-offs out of order still go out in created order", async () => {
  await idle();
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  const a = await h.store.createHeld({
    kind: "member_update",
    toAgentId: h.agentId,
    fromAgentId: REPORT,
    body: "a",
  });
  const b = await h.store.createHeld({
    kind: "member_update",
    toAgentId: h.agentId,
    fromAgentId: REPORT,
    body: "b",
  });
  await Promise.all([h.rt.receiveHeld(b), h.rt.receiveHeld(a), h.rt.receiveHeld(b)]);
  await h.rt.settled();
  h.driver.last.emit(ev.usage(), ev.end());
  await h.rt.settled();
  expect(h.driver.last.sent.at(-1)).toEqual([
    expect.objectContaining({ body: "a\n\nb", ids: [a.id, b.id] }),
  ]);
});

test("C17: a manager with only young updates is hibernatable; the timer wakes it and the first batch carries them", async () => {
  await idle();
  await update("while you slept");
  expect(h.rt.hasDeliverable()).toBe(false);
  expect(h.rt.hibernatable()).toBe(true); // §8.3 site: hibernatable
  expect(await h.rt.hibernate("warm_window")).toBe(true);
  await h.rt.settled();
  expect(h.driver.last.stopped).toBe(true);
  expect(h.rt.hibernatable()).toBe(false); // no process
  // §8.3 site: the post-hibernate re-wake doesn't fire for young updates
  expect(slots.events).not.toContainEqual(["request", "queued_items"]);
  expect(slots.events).not.toContainEqual(["request", "member_updates"]);
  await tick(30_500);
  expect(slots.events).toContainEqual(["request", "member_updates"]);
  expect(h.driver.starts).toHaveLength(2);
  expect(h.driver.last.sent[0]?.map((m) => m.kind)).toEqual(["member_update"]);
});

test("§8.3 post-hibernate re-wake: an apply-restart with a due update wakes and carries it", async () => {
  await idle();
  await update("due");
  ageBy(31_000); // due, its timer not run yet
  expect(h.rt.hasDeliverable()).toBe(true);
  expect(h.rt.hibernatable()).toBe(false); // §8.3 site: something due to deliver
  await h.rt.requestRestart();
  await h.rt.settled();
  expect(slots.events).toContainEqual(["request", "queued_items"]);
  expect(h.driver.starts).toHaveLength(2);
  expect(h.driver.last.sent[0]?.map((m) => m.kind)).toEqual(["member_update"]);
});

test("§8.3 grant: only young updates give the slot back; a due one starts", async () => {
  await h.makeRuntime({ slots, memberUpdateDebounceMs: 60_000 });
  await update("young");
  await h.rt.grant("member_updates");
  expect(slots.events).toContainEqual(["release"]);
  expect(h.driver.starts).toHaveLength(0);
  ageBy(61_000);
  await h.rt.grant("member_updates");
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(1);
  expect(h.driver.last.sent[0]?.map((m) => m.kind)).toEqual(["member_update"]);
});

test("§8.3 rate-limit reset re-wake: only for a due update", async () => {
  await update("young");
  h.rt.resumeAfterReset();
  await h.rt.settled();
  expect(slots.events).not.toContainEqual(["request", "rate_limit_reset"]);
  ageBy(31_000);
  h.rt.resumeAfterReset();
  await h.rt.settled();
  expect(slots.events).toContainEqual(["request", "rate_limit_reset"]);
  expect(h.driver.last.sent[0]?.map((m) => m.kind)).toEqual(["member_update"]);
});

test("§8.3 status: a paused hibernated agent reads rate_limited only once its update is due", async () => {
  const paused = new PausableSlots();
  paused.paused = { until: new Date(Date.now() + 3_600_000), exact: true };
  await h.makeRuntime({ slots: paused });
  await update("young");
  expect(h.rt.statusFrame().status).toBe("hibernated");
  ageBy(31_000);
  expect(h.rt.statusFrame().status).toBe("rate_limited");
});

test("§8.3 idle crash: young updates alone make it a plain hibernation", async () => {
  await idle();
  await update("young");
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(h.rt.statusFrame().status).toBe("hibernated");
  expect(slots.events).not.toContainEqual(["request", "crash_recovery"]);
});

test("§8.3 idle crash: a due update is work to recover", async () => {
  await idle();
  await update("due");
  ageBy(31_000);
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(slots.events).toContainEqual(["request", "crash_recovery"]);
  expect(h.driver.starts).toHaveLength(2);
  expect(h.driver.last.sent[0]?.map((m) => m.kind)).toEqual(["system", "member_update"]);
});

test("boot: init() arms the timer for young updates and wakes at once for due ones", async () => {
  const seed = (agentId: string) =>
    h.store
      .createHeld({ kind: "member_update", toAgentId: agentId, fromAgentId: REPORT, body: "b" })
      .then(() => undefined);
  await h.makeRuntime({ slots, seed });
  expect(h.rt.queueItems()).toEqual([expect.objectContaining({ kind: "held", count: 1 })]);
  await tick(29_000);
  expect(slots.events).not.toContainEqual(["request", "member_updates"]);
  await tick(1_500);
  expect(slots.events).toContainEqual(["request", "member_updates"]);
  expect(h.driver.last.sent[0]?.map((m) => m.kind)).toEqual(["member_update"]);

  slots = new RecordingSlots();
  await h.makeRuntime({
    slots,
    seed: async (id) => {
      await seed(id);
      ageBy(31_000);
    },
  });
  expect(h.rt.hasDeliverable()).toBe(true);
  await tick(0);
  expect(slots.events).toContainEqual(["request", "member_updates"]);
});

test("an errored manager is not woken by updates; after a Restart they ride with the notice", async () => {
  await h.makeRuntime({ slots, status: "errored", sessionId: "sess-1", errorKind: "crash" });
  await update("stuck report text");
  await tick(31_000);
  expect(slots.events).not.toContainEqual(["request", "member_updates"]);
  expect(h.driver.starts).toHaveLength(0);
  expect(h.rt.queueItems()[0]).toMatchObject({ kind: "held", waitReason: "errored" });
  await h.rt.restart({ byHandle: "or", runtimeAllowed: true });
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(1);
  expect(h.driver.last.sent[0]?.map((m) => m.kind)).toEqual(["system", "member_update"]);
});

test("rollback paths put held rows back into held, never into the FIFO queue", async () => {
  await idle();
  h.driver.last.failWrites = true;
  await update("a");
  await tick(30_500); // the write fails: "a" goes back to held
  expect(anyUpdateWritten()).toBe(false);
  h.driver.last.failWrites = false;
  h.driver.last.emit(ev.turn()); // a self-started turn opens
  await h.rt.settled();
  await h.send("mid-turn");
  expect(kinds().at(-1)).toEqual(["message"]); // absorbed alone, the update stays held
  h.driver.last.emit(ev.usage(), ev.end({ originKind: "task-notification" }));
  await h.rt.settled();
  expect(kinds().at(-1)).toEqual(["member_update"]);
});

test("the exited rollback re-partitions a batch written before session_started", async () => {
  await h.makeRuntime({ slots, memberUpdateDebounceMs: 0 });
  await update("u"); // due at once: the timer's wake writes it as the first batch
  await tick(0);
  expect(slots.events).toContainEqual(["request", "member_updates"]);
  expect(kinds()).toEqual([["member_update"]]);
  slots.answer = "dropped"; // the crash recovery's wake doesn't start, so the rolled-back rows stay visible
  h.driver.last.exit(1); // before session_started
  await h.rt.settled();
  expect(h.rt.queueItems()).toEqual([
    expect.objectContaining({ kind: "notice" }),
    expect.objectContaining({ kind: "held", count: 1 }),
  ]);
  slots.answer = "granted";
  await h.rt.restart({ byHandle: "or", runtimeAllowed: true });
  await h.rt.settled();
  // The notices first, the update riding along as a held row (not a FIFO message).
  expect(kinds()).toEqual([["system", "system", "member_update"]]); // crash and restart notices
});

test("the closing latch and archive clear the timer: nothing is written or woken", async () => {
  await update("a"); // never started: the timer would request a wake
  h.rt.setNoStart();
  await tick(31_000);
  expect(slots.events).not.toContainEqual(["request", "member_updates"]);
  await h.makeRuntime({ slots });
  await update("b");
  h.rt.markArchived();
  await tick(31_000);
  expect(slots.events).not.toContainEqual(["request", "member_updates"]);
  expect(h.driver.starts).toHaveLength(0);
});

test("debounce 0: due at once while idle, still never mid-turn", async () => {
  await h.makeRuntime({ slots, memberUpdateDebounceMs: 0 });
  await idle();
  await update("now");
  expect(h.driver.last.sent.at(-1)?.[0]?.body).toBe("now");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  await update("later");
  expect(h.driver.last.sent.at(-1)?.[0]?.body).toBe("now");
  h.driver.last.emit(ev.usage(), ev.end());
  await h.rt.settled();
  expect(h.driver.last.sent.at(-1)?.[0]?.body).toBe("later");
});

test("queue items: one held line per group with its wait reason", async () => {
  await idle();
  await update("a");
  await peer("@devrep (Dev agent) joined as your peer.");
  expect(h.rt.queueItems()).toEqual([
    expect.objectContaining({
      kind: "held",
      from: "devrep",
      count: 1,
      waitReason: "window",
      dueAt: expect.any(String),
    }),
    expect.objectContaining({ kind: "held", from: "@factory", count: 1, waitReason: "ride_along" }),
  ]);
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  expect(h.rt.queueItems()[0]).toMatchObject({ waitReason: "turn" });
});

test("C3: every write records the message_in seq on its rows, before session_started too", async () => {
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
