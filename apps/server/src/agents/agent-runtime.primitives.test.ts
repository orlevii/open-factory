import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { AgentStartError } from "./errors.ts";
import { ev } from "./testing/fake-driver.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";
import { RecordingSlots } from "./testing/slots.ts";

const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());
beforeEach(async () => {
  await h.makeRuntime();
});

const startReasons = async () =>
  (await h.store.after(h.agentId, 0, 1000)).flatMap((e) =>
    e.event.type === "process_started" ? [e.event.reason] : [],
  );

/** A started, idle process on session sess-1. */
async function idle() {
  await h.send("hi");
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await h.rt.settled();
}

test("a start failure before launch releases the slot", async () => {
  const slots = new RecordingSlots();
  await h.makeRuntime({ slots, startError: new AgentStartError("nope") });
  await expect(h.send("hi")).rejects.toThrow(AgentStartError);
  expect(slots.events).toEqual([["request", "message"], ["release"]]);
});

test("every exit releases the slot once", async () => {
  const slots = new RecordingSlots();
  await h.makeRuntime({ slots });
  await h.send("hi");
  h.driver.last.emit(...ev.fullTurn());
  await h.rt.settled();
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(slots.events.filter((e) => e[0] === "release")).toHaveLength(1);
});

test("noStart blocks a start already inside prepareStart", async () => {
  let open!: () => void;
  h.prepareGate = new Promise((r) => {
    open = r;
  });
  const p = h.send("hi");
  await vi.waitFor(() => expect(h.prepareCalls).toBe(1)); // the send job is suspended in prepareStart
  h.rt.setNoStart();
  open();
  await expect(p).rejects.toThrow(/being stopped/);
  expect(h.driver.starts).toHaveLength(0);
});

test("a message sent during a hibernate's stop grace is not written to the closing process", async () => {
  await idle();
  h.driver.last.holdStop = true;
  void h.rt.hibernate("warm_window");
  const p = h.send("during");
  await h.rt.settled();
  expect(h.driver.starts[0]?.sent.flat().map((m) => m.body)).toEqual(["hi"]);
  h.driver.starts[0]?.releaseStop();
  await p;
  await h.rt.settled();
  // the hibernate's exit wakes the agent for what is queued and delivers it to the new process
  expect(h.driver.starts).toHaveLength(2);
  expect(h.driver.starts[1]?.sent.flat().map((m) => m.body)).toEqual(["during"]);
  expect((await startReasons()).at(-1)).toBe("queued_items");
});

test("a grant for an agent with nothing to deliver releases the slot once and starts nothing", async () => {
  const slots = new RecordingSlots();
  await h.makeRuntime({ slots });
  await h.rt.grant("boot");
  expect(slots.events).toEqual([["release"]]);
  expect(h.driver.starts).toHaveLength(0);
});

test("a grant for a running agent never releases the slot its process holds", async () => {
  const slots = new RecordingSlots();
  await h.makeRuntime({ slots });
  await idle();
  await h.rt.grant("boot");
  expect(slots.events.filter((e) => e[0] !== "hibernatable")).toEqual([["request", "message"]]);
  expect(h.driver.starts).toHaveLength(1);
});

test("a warm-window hibernate is refused while a turn is open", async () => {
  await idle();
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  expect(await h.rt.hibernate("warm_window")).toBe(false);
  expect(h.driver.last.stopped).toBe(false);
});

test("a warm-window hibernate is refused while a message is queued", async () => {
  await idle();
  h.driver.last.failWrites = true; // the write is rejected: the message stays at the head of the queue
  await h.send("queued");
  expect(h.rt.queueItems()).toHaveLength(1);
  expect(await h.rt.hibernate("warm_window")).toBe(false);
  expect(h.driver.last.stopped).toBe(false);
});

test("a failed start's exit releases the slot once and never wakes", async () => {
  const slots = new RecordingSlots();
  await h.makeRuntime({ slots });
  await h.send("hi");
  h.driver.last.emit({ type: "error", source: "resume", message: "No conversation found" });
  await h.rt.settled();
  expect(h.driver.last.stopped).toBe(true);
  expect(slots.events).toEqual([["request", "message"], ["release"]]);
  expect(h.driver.starts).toHaveLength(1);
  expect(h.rt.queueItems()).toHaveLength(1); // rolled back, waiting for a human
});

test("an internal stop after a job failure releases once and never wakes", async () => {
  const slots = new RecordingSlots();
  await h.makeRuntime({ slots });
  await h.send("hi");
  vi.spyOn(h.store, "append").mockRejectedValueOnce(new Error("db down"));
  h.driver.last.emit(ev.session());
  await h.rt.settled();
  vi.restoreAllMocks();
  expect(h.driver.last.stopped).toBe(true);
  expect(h.rt.live().status).toBe("errored");
  expect(slots.events).toEqual([["request", "message"], ["release"]]);
  expect(h.driver.starts).toHaveLength(1);
  expect(h.rt.queueItems()).toHaveLength(1);
});

test("stop() taking over a hibernate: its exit never wakes and the timeout job backs off", async () => {
  await idle();
  const p = h.driver.last;
  p.holdStop = true;
  p.stopResult = { code: null, signal: null, timedOut: true };
  expect(await h.rt.hibernate("warm_window")).toBe(true);
  await h.send("x"); // held: the process is stopping
  const stopping = h.rt.stop();
  p.releaseStop();
  await stopping;
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(1);
  expect(h.rt.live().status).toBe("hibernated");
  expect(h.rt.queueItems().map((i) => (i.kind === "message" ? i.body : i.kind))).toEqual(["x"]);
});

test("process_started records the wake reason", async () => {
  await h.rt.compact({ byHandle: "or" });
  const started = (await h.store.after(h.agentId, 0, 100)).find(
    (e) => e.event.type === "process_started",
  );
  expect(started?.event).toEqual({ type: "process_started", resumed: false, reason: "compact" });
});
