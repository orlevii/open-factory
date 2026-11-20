import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import type { MountCheckContext } from "../workspace/mounts.ts";
import type { DockerDeps } from "./agent-runtime.ts";
import { AgentTerminatedError } from "./errors.ts";
import { ev } from "./testing/fake-driver.ts";
import { okSpec, RuntimeHarness } from "./testing/runtime-harness.ts";
import { RecordingSlots } from "./testing/slots.ts";

/** S7 §8: the runtime side of a termination (the latch, the stop job, the exit path), over the fake driver. */
const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());
afterEach(() => {
  vi.restoreAllMocks();
});

const events = async () => (await h.store.after(h.agentId, 0, 1000)).map((e) => e.event);
const stateOf = async (id: string) =>
  (await h.t.sql<{ state: string }[]>`select state from messages where id = ${id}`)[0]?.state;

/** A fake ContainerManager port that records what the runtime asked of it. */
function fakeContainers() {
  const ops: string[] = [];
  const f = {
    ops,
    removeError: undefined as Error | undefined,
    port: {
      ensure: async () => {
        ops.push("ensure");
        return { containerId: "c1", action: "created" as const, imageId: "sha256:img" };
      },
      stopIfRunning: async () => {
        ops.push("stop");
        return true;
      },
      forceRemove: async () => {
        ops.push("forceRemove");
        return true;
      },
      remove: async () => {
        ops.push("remove");
        if (f.removeError) throw f.removeError;
        return true;
      },
    } satisfies DockerDeps["containers"],
  };
  return f;
}

async function dockerRuntime(slots = new RecordingSlots()) {
  const c = fakeContainers();
  await h.makeRuntime({
    slots,
    docker: { containers: c.port, claudeBin: "/usr/local/bin/claude" },
    spec: (a) => ({
      ...okSpec(a),
      runtime: "docker",
      launch: { image: "open-factory-base:dev", mountCheck: {} as MountCheckContext },
    }),
  });
  return { c, slots };
}

/** A started, idle process on session sess-1. */
async function idle() {
  await h.send("hi");
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await h.rt.settled();
}

test("terminateStop: the terminated event, a forced stop, and the exit removes the container", async () => {
  const { c, slots } = await dockerRuntime();
  await idle();
  const proc = h.driver.last;
  h.rt.markTerminated({ committed: true });
  expect(h.rt.live().status).toBe("terminated");
  await h.rt.terminateStop("@or");
  await h.rt.settled();
  expect(proc.stopped).toBe(true);
  expect(c.ops).toEqual(["ensure", "remove"]); // removed, never only stopped
  expect(slots.events.at(-1)).toEqual(["release"]);
  const types = (await events()).map((e) => e.type);
  // Its exit lines follow the terminated line.
  expect(types.slice(types.indexOf("terminated"))).toEqual(["terminated", "cleanup", "exited"]);
  expect((await events()).find((e) => e.type === "terminated")).toEqual({
    type: "terminated",
    by: "@or",
  });
  expect(h.forwarded).toEqual([]);
  expect(h.driver.starts).toHaveLength(1); // no wake after a terminating exit
});

test("a failed container removal keeps the slot (stop_failed) and forwards nothing", async () => {
  const { c, slots } = await dockerRuntime();
  await idle();
  c.removeError = new Error("Removing container c1 didn't finish within 15 s.");
  h.rt.markTerminated({ committed: true });
  await h.rt.terminateStop("@or");
  await h.rt.settled();
  expect(slots.events).not.toContainEqual(["release"]);
  expect(slots.events.at(-1)).toEqual(["stop_failed"]);
  expect(h.rt.live().status).toBe("terminated");
  expect(h.forwarded).toEqual([]); // no errored fact
});

test("with no process, terminateStop removes the container and releases the slot at once", async () => {
  const { c, slots } = await dockerRuntime();
  // Never started in this server: the row's runtime decides.
  await h.t.sql`update agents set runtime = 'docker' where id = ${h.agentId}`;
  await h.rt.reload();
  h.rt.markTerminated({ committed: true });
  await h.rt.terminateStop("@lead");
  expect(c.ops).toEqual(["remove"]);
  expect(slots.events).toEqual([["release"]]);
  expect(await events()).toEqual([
    { type: "terminated", by: "@lead" },
    { type: "cleanup", container: "removed" },
  ]);
});

test("ensureTerminatedEvent appends the event once", async () => {
  await h.makeRuntime();
  h.rt.markTerminated({ committed: true });
  await h.rt.terminateStop("@or");
  await h.rt.terminateStop("@or");
  expect((await events()).filter((e) => e.type === "terminated")).toHaveLength(1);
});

test("a crash exit after the latch takes the terminate path: no recovery, no notice, nothing forwarded", async () => {
  await h.makeRuntime();
  await idle();
  const proc = h.driver.last;
  proc.emit(ev.turn()); // mid-turn: a plain crash here would be recovered
  await h.rt.settled();
  h.rt.markTerminated({ committed: true });
  proc.exit(137); // before the stop job runs: no stop intent is recorded
  await h.rt.settled();
  await h.rt.terminateStop("@or");
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(1);
  expect(await h.store.pendingQueue(h.agentId)).toEqual([]);
  const row = (
    await h.t.sql`select status, error_kind, attempting from agents where id = ${h.agentId}`
  )[0];
  expect(row).toEqual({ status: "hibernated", error_kind: null, attempting: false });
  expect(h.forwarded).toEqual([]);
  expect(h.rt.live().status).toBe("terminated");
});

test("rows rolled back from an in-flight batch are rejected, not pending again", async () => {
  await h.makeRuntime();
  const sent = await h.send("first"); // written before session_started: in flight
  const proc = h.driver.last;
  h.rt.markTerminated({ committed: true });
  await h.rt.terminateStop("@or");
  await h.rt.settled();
  expect(proc.stopped).toBe(true);
  expect(await stateOf(sent.id)).toBe("rejected");
  expect(h.rt.queueItems()).toEqual([]);
  expect(h.driver.starts).toHaveLength(1);
});

test("live background work is recorded as lost (reason terminated) and not forwarded", async () => {
  await h.makeRuntime();
  await idle();
  h.driver.last.emit(ev.background([{ taskId: "t1", description: "build" }]));
  await h.rt.settled();
  h.rt.markTerminated({ committed: true });
  await h.rt.terminateStop("@or");
  await h.rt.settled();
  expect(await events()).toContainEqual({
    type: "background_work_lost",
    reason: "terminated",
    tasks: [{ taskId: "t1", description: "build" }],
    crons: [],
  });
  expect(h.forwarded).toEqual([]);
});

test("nothing is forwarded once latched, not even the agent's own text", async () => {
  await h.makeRuntime();
  await idle();
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  h.rt.markTerminated({ committed: false });
  h.driver.last.emit(ev.text("a late report"), ev.end());
  await h.rt.settled();
  expect(h.forwarded).toEqual([]);
});

test("a provisional latch queues an arriving row without a wake; unmarking delivers it", async () => {
  const slots = new RecordingSlots();
  await h.makeRuntime({ slots });
  h.rt.markTerminated({ committed: false });
  expect(h.rt.live().status).not.toBe("terminated"); // a provisional latch doesn't show
  expect(h.rt.acceptsWake("message")).toBe(false);
  const item = await h.send("during the window");
  expect(slots.events).toEqual([]);
  expect(h.driver.starts).toHaveLength(0);
  expect(h.rt.queueItems()).toEqual([expect.objectContaining({ id: item.id })]);
  expect(await stateOf(item.id)).toBe("pending");
  h.rt.unmarkTerminated();
  await h.rt.settled();
  expect(h.rt.isTerminated()).toBe(false);
  expect(slots.events).toContainEqual(["request", "queued_items"]);
  expect(h.driver.last.sent.flat().map((m) => m.body)).toEqual(["during the window"]);
});

test("unmarking with a running process flushes what arrived during the window", async () => {
  await h.makeRuntime();
  await idle();
  h.rt.markTerminated({ committed: false });
  await h.send("queued meanwhile");
  expect(h.driver.last.sent).toHaveLength(1); // only the first batch
  h.rt.unmarkTerminated();
  await h.rt.settled();
  expect(h.driver.last.sent.flat().map((m) => m.body)).toEqual(["hi", "queued meanwhile"]);
});

test("a committed latch rejects an arriving row; a held row is rejected too", async () => {
  await h.makeRuntime();
  h.rt.markTerminated({ committed: true });
  const row = await h.row("too late");
  await expect(h.rt.deliver(row, { sender: "human", fromLabel: "@or" })).rejects.toBeInstanceOf(
    AgentTerminatedError,
  );
  expect(await stateOf(row.id)).toBe("rejected");
  expect(h.rt.queueItems()).toEqual([]);
  const held = await h.store.createHeld({
    kind: "member_update",
    toAgentId: h.agentId,
    subjectAgentId: h.agentId,
    notice: "errored",
    body: "x",
  });
  await h.receive(held);
  expect(await stateOf(held.id)).toBe("rejected");
  expect(h.driver.starts).toHaveLength(0);
});

test("a committed latch drops what was queued and cancels a pending apply-restart", async () => {
  await h.makeRuntime();
  h.rt.markTerminated({ committed: false });
  await h.send("queued");
  expect(h.rt.queueItems()).toHaveLength(1);
  h.rt.markTerminated({ committed: true });
  expect(h.rt.queueItems()).toEqual([]);
  expect(h.rt.hasDeliverable()).toBe(false);
  h.rt.unmarkTerminated(); // a committed latch is never undone
  expect(h.rt.isTerminated()).toBe(true);
});

test("reload never clears the latch", async () => {
  await h.makeRuntime();
  h.rt.markTerminated({ committed: false });
  await h.rt.reload();
  expect(h.rt.isTerminated()).toBe(true);
});

test("reload latches a row terminated elsewhere", async () => {
  await h.makeRuntime();
  await h.t
    .sql`update agents set kind = 'ephemeral', reports_to = ${h.agentId}, terminated_at = now(), terminated_by = '@factory' where id = ${h.agentId}`;
  await h.rt.reload();
  expect(h.rt.isTerminated()).toBe(true);
  expect(h.rt.live().status).toBe("terminated");
});

test("compact, interrupt, restart and reset-session are refused once terminated", async () => {
  await h.makeRuntime({ errorKind: "resume", status: "errored" });
  h.rt.markTerminated({ committed: true });
  await expect(h.rt.compact({ byHandle: "or" })).rejects.toBeInstanceOf(AgentTerminatedError);
  await expect(h.rt.interrupt({ byHandle: "or" })).rejects.toBeInstanceOf(AgentTerminatedError);
  await expect(h.rt.restart({ byHandle: "or", runtimeAllowed: true })).rejects.toBeInstanceOf(
    AgentTerminatedError,
  );
  await expect(h.rt.resetSession({ byHandle: "or" })).rejects.toBeInstanceOf(AgentTerminatedError);
  expect(h.driver.starts).toHaveLength(0);
});

test("a start inside prepareStart when the latch lands stops before the launch", async () => {
  let open!: () => void;
  await h.makeRuntime();
  h.prepareGate = new Promise<void>((r) => {
    open = r;
  });
  const sending = h.send("hi");
  await h.prepared(1);
  h.rt.markTerminated({ committed: false });
  open();
  await expect(sending).rejects.toThrow("The agent was terminated.");
  expect(h.driver.starts).toHaveLength(0);
});
