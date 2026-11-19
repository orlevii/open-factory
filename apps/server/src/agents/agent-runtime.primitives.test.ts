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
});

test("process_started records the wake reason", async () => {
  await h.rt.compact({ byHandle: "or" });
  const started = (await h.store.after(h.agentId, 0, 100)).find(
    (e) => e.event.type === "process_started",
  );
  expect(started?.event).toEqual({ type: "process_started", resumed: false, reason: "compact" });
});
