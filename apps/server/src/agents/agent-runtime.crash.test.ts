import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { AgentArchivedError } from "./errors.ts";
import { ev } from "./testing/fake-driver.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";
import { RecordingSlots } from "./testing/slots.ts";

const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const events = async () => (await h.store.after(h.agentId, 0, 1000)).map((e) => e.event);
const row = async () =>
  (
    await h.t
      .sql`select status, last_error, error_kind, attempting from agents where id = ${h.agentId}`
  )[0];

/** A started, idle process on session sess-1. */
async function idle() {
  await h.send("hi");
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await h.rt.settled();
}

test("idle crash with nothing live: hibernated, no turn, no notice", async () => {
  await h.makeRuntime();
  await idle();
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(h.rt.live().status).toBe("hibernated");
  expect(h.driver.starts).toHaveLength(1);
  expect(await h.store.pendingQueue(h.agentId)).toEqual([]);
  const evs = await events();
  expect(evs.at(-1)).toMatchObject({ type: "exited", code: 1 });
  expect(evs.map((e) => e.type)).not.toContain("background_work_lost");
  expect(await row()).toEqual({
    status: "hibernated",
    last_error: null,
    error_kind: null,
    attempting: false,
  });
});

test("mid-turn crash: errored + attempting (queued), one notice-led attempt, success clears", async () => {
  await h.makeRuntime();
  await idle();
  h.driver.last.emit(ev.turn());
  h.driver.last.exit(137);
  await h.rt.settled();
  expect(h.rt.live().status).not.toBe("errored"); // attempting → queued/working
  expect(await row()).toMatchObject({ status: "errored", error_kind: "crash", attempting: true });
  const p = h.driver.last;
  expect(h.driver.starts).toHaveLength(2);
  p.emit(ev.session(), ev.turn(), ev.end({ originKind: "task-notification" }));
  await h.rt.settled();
  expect(h.rt.live().errorKind).toBe("crash"); // orphan-report turn doesn't count
  p.emit(ev.turn(), ev.end());
  await h.rt.settled();
  expect(h.rt.live().status).toBe("idle");
  expect(h.rt.live().errorKind).toBeUndefined();
  expect(p.sent[0]?.[0]).toMatchObject({ kind: "system" });
  expect(p.sent[0]?.[0]?.body).toBe(
    "Your previous process stopped unexpectedly (exit code 137) during a turn. Check the state of that work and continue where you left off.",
  );
  expect(await row()).toEqual({
    status: "hibernated",
    last_error: null,
    error_kind: null,
    attempting: false,
  });
  const started = (await events()).filter((e) => e.type === "process_started");
  expect(started.at(-1)).toMatchObject({ reason: "crash_recovery", resumed: true });
});

test("idle crash with a live task: background_work_lost and a notice that names it", async () => {
  await h.makeRuntime();
  await idle();
  h.driver.last.emit(ev.background([{ taskId: "t1", description: "pnpm test" }]));
  await h.rt.settled();
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(await events()).toContainEqual({
    type: "background_work_lost",
    reason: "crash",
    tasks: [{ taskId: "t1", description: "pnpm test" }],
    crons: [],
  });
  expect(h.driver.last.sent[0]?.[0]?.body).toBe(
    "Your previous process stopped unexpectedly (exit code 1). These background tasks were stopped: `pnpm test`. Check the state of that work and continue where you left off.",
  );
});

test("crash during the attempt: errored, no further attempt", async () => {
  await h.makeRuntime();
  await idle();
  h.driver.last.emit(ev.turn());
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(2);
  h.driver.last.emit(ev.session(), ev.turn());
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(2);
  expect(h.rt.live()).toMatchObject({ status: "errored", errorKind: "crash" });
  expect(await row()).toMatchObject({ status: "errored", error_kind: "crash", attempting: false });
});

test("a human message makes one attempt; system notices never wake an errored agent", async () => {
  const slots = new RecordingSlots();
  await h.makeRuntime({ status: "errored", sessionId: "sess-1", slots });
  await h.rt.postNotice("restart", "a notice");
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(0);
  expect(h.rt.acceptsWake("queued_items")).toBe(false);
  expect(h.rt.acceptsWake("boot")).toBe(false);

  await h.send("hi"); // one attempt
  expect(h.driver.starts).toHaveLength(1);
  expect(await row()).toMatchObject({ attempting: true });
  // While attempting, only the attempt's own wake is accepted.
  expect(h.rt.acceptsWake("message")).toBe(true);
  expect(h.rt.acceptsWake("crash_recovery")).toBe(false);
  await h.send("again"); // no second start
  expect(h.driver.starts).toHaveLength(1);
  expect(slots.events.filter((e) => e[0] === "request")).toEqual([["request", "message"]]);

  h.driver.last.exit(1); // the attempt fails
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(1);
  expect(h.rt.live().status).toBe("errored");
  await h.send("third"); // another human message: one more attempt
  expect(h.driver.starts).toHaveLength(2);
});

test("ordinary resume failure: errored resume, no automatic attempt", async () => {
  await h.makeRuntime({ sessionId: "sess-1" });
  await h.send("hi");
  h.driver.last.emit({ type: "error", source: "resume", message: "Connection reset" });
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(1);
  expect(h.rt.live()).toMatchObject({ status: "errored", errorKind: "resume" });
  expect(await row()).toEqual({
    status: "errored",
    last_error: "Connection reset",
    error_kind: "resume",
    attempting: false,
  });
  await h.send("again"); // a human tries again
  expect(h.driver.starts).toHaveLength(2);
});

test("a failed resume during an attempt clears attempting and makes no attempt of its own", async () => {
  await h.makeRuntime({ status: "errored", sessionId: "sess-1" });
  await h.send("hi");
  expect(await row()).toMatchObject({ attempting: true });
  h.driver.last.emit({ type: "error", source: "resume", message: "Connection reset" });
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(1);
  expect(await row()).toMatchObject({ error_kind: "resume", attempting: false });
});

test("unrecoverable: later messages stay pending without an attempt", async () => {
  await h.makeRuntime({ sessionId: "sess-1" });
  await h.send("hi");
  h.driver.last.emit({
    type: "error",
    source: "resume",
    message: "No conversation found with session ID: sess-1",
  });
  await h.rt.settled();
  expect(h.rt.live()).toMatchObject({ status: "errored", errorKind: "resume_unrecoverable" });
  await h.send("later");
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(1);
  expect(h.rt.queueItems().map((q) => q.body)).toEqual(["hi", "later"]);
  expect(h.rt.acceptsWake("restart")).toBe(false);
  expect(h.rt.acceptsWake("message")).toBe(false);
  expect(h.rt.acceptsWake("reset")).toBe(true);
});

test("timed-out stop escalates (forceKill, stop_escalated); a failed escalation is stop_failed and keeps the slot", async () => {
  // Escalation succeeds: the exit follows and the hibernate's intent runs.
  let slots = new RecordingSlots();
  await h.makeRuntime({ slots });
  await idle();
  let p = h.driver.last;
  p.stopResult = { code: null, signal: null, timedOut: true };
  p.emitExitOnStop = false;
  expect(await h.rt.hibernate("warm_window")).toBe(true);
  await h.rt.settled();
  expect(p.forceKilled).toBe(true);
  const evs = await events();
  expect(evs).toContainEqual({ type: "stop_escalated", how: "sigkill" });
  expect(evs.at(-1)).toMatchObject({ type: "hibernated", reason: "warm_window" });
  expect(h.rt.live().status).toBe("hibernated");
  expect(slots.events.filter((e) => e[0] === "release")).toHaveLength(1);

  // Escalation fails: stop_failed, the slot is kept and every wake but Restart is refused.
  slots = new RecordingSlots();
  await h.makeRuntime({ slots });
  await idle();
  p = h.driver.last;
  p.stopResult = { code: null, signal: null, timedOut: true };
  p.emitExitOnStop = false;
  p.forceKill = async () => {
    throw new Error("EPERM");
  };
  await h.rt.hibernate("freed_slot");
  await h.rt.settled();
  expect(h.rt.live()).toMatchObject({ status: "errored", errorKind: "stop_failed" });
  expect(await row()).toMatchObject({ status: "errored", error_kind: "stop_failed" });
  expect(slots.events.filter((e) => e[0] === "release")).toHaveLength(0);
  expect(slots.events.at(-1)).toEqual(["stop_failed"]);
  expect(h.rt.isStopping()).toBe(false);
  expect(h.rt.acceptsWake("message")).toBe(false);
  expect(h.rt.acceptsWake("restart")).toBe(true);
  await h.send("x");
  expect(h.driver.starts).toHaveLength(1);

  // A late exit of that process releases the slot and leaves the agent errored, with no wake.
  p.exit(137);
  await h.rt.settled();
  expect(slots.events.filter((e) => e[0] === "release")).toHaveLength(1);
  expect(h.rt.live()).toMatchObject({ status: "errored", errorKind: "stop_failed" });
  expect(h.driver.starts).toHaveLength(1);
});

test("an escalation with no exit within 5 s is stop_failed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const slots = new RecordingSlots();
  await h.makeRuntime({ slots });
  await idle();
  const p = h.driver.last;
  p.stopResult = { code: null, signal: null, timedOut: true };
  p.emitExitOnStop = false;
  p.forceKill = async () => {
    p.forceKilled = true; // the signal is sent but the process never exits
  };
  await h.rt.hibernate("warm_window");
  await h.rt.settled();
  expect(p.forceKilled).toBe(true);
  expect(h.rt.live().errorKind).toBeUndefined();
  await vi.advanceTimersByTimeAsync(4_999);
  await h.rt.settled();
  expect(h.rt.live().errorKind).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await h.rt.settled();
  expect(h.rt.live()).toMatchObject({ status: "errored", errorKind: "stop_failed" });
  expect(slots.events.filter((e) => e[0] === "release")).toHaveLength(0);
});

test("a crash runs the cleanup port first and records it", async () => {
  const cleanup = vi.fn(async () => ({ killedProcesses: 2 }));
  await h.makeRuntime({ cleanup });
  await idle();
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(cleanup).toHaveBeenCalledTimes(1);
  const types = (await events()).map((e) => e.type);
  expect(types.slice(-2)).toEqual(["cleanup", "exited"]);
  expect(await events()).toContainEqual({ type: "cleanup", killedProcesses: 2 });
});

test("a failing crash cleanup is stop_failed and keeps the slot, with no attempt", async () => {
  const slots = new RecordingSlots();
  await h.makeRuntime({
    slots,
    cleanup: async () => {
      throw new Error("docker down");
    },
  });
  await idle();
  h.driver.last.emit(ev.turn());
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(h.rt.live()).toMatchObject({ status: "errored", errorKind: "stop_failed" });
  expect(slots.events.filter((e) => e[0] === "release")).toHaveLength(0);
  expect(h.driver.starts).toHaveLength(1);
});

test("a crash after a batch was written but before its turn began recovers it", async () => {
  await h.makeRuntime();
  await idle();
  await h.send("next"); // written after session_started, its turn not started yet
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(2);
  expect(h.driver.last.sent[0]?.[0]?.body).toBe(
    "Your previous process stopped unexpectedly (exit code 1). Check the state of that work and continue where you left off.",
  );
  const started = (await events()).filter((e) => e.type === "process_started");
  expect(started.at(-1)).toMatchObject({ reason: "crash_recovery" });
});

test("an attempt whose start is refused without an error clears attempting", async () => {
  await h.makeRuntime({ status: "errored", startError: new AgentArchivedError("x") });
  await expect(h.send("hi")).rejects.toBeInstanceOf(AgentArchivedError);
  expect(await row()).toMatchObject({ attempting: false });
  expect(h.rt.live().status).toBe("errored");
});

test("a human message during a failing start's stop makes its attempt at that exit", async () => {
  await h.makeRuntime({ sessionId: "sess-1" });
  await h.send("hi");
  const p = h.driver.last;
  p.holdStop = true;
  p.emit({ type: "error", source: "resume", message: "Connection reset" });
  await h.rt.settled();
  await h.send("again"); // the failing process hasn't exited yet
  expect(h.driver.starts).toHaveLength(1);
  p.releaseStop();
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(2);
  const started = (await events()).filter((e) => e.type === "process_started");
  expect(started.at(-1)).toMatchObject({ reason: "message" });
  expect(await row()).toMatchObject({ attempting: true });
});

test("a failed crash cleanup still records the lost work, with no notice", async () => {
  await h.makeRuntime({
    cleanup: async () => {
      throw new Error("docker down");
    },
  });
  await idle();
  h.driver.last.emit(ev.background([{ taskId: "t1", description: "pnpm test" }]));
  await h.rt.settled();
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(await events()).toContainEqual(
    expect.objectContaining({ type: "background_work_lost", reason: "crash" }),
  );
  expect(await h.store.pendingQueue(h.agentId)).toEqual([]);
  expect(h.rt.live().errorKind).toBe("stop_failed");
});

test("a signal exit: lastError and the notice both name the signal", async () => {
  await h.makeRuntime();
  await idle();
  const p = h.driver.last;
  p.emit(ev.turn(), {
    type: "exited",
    code: null,
    signal: "SIGKILL",
    stderrTail: "",
    expected: false,
  });
  p.events.end();
  await h.rt.settled();
  expect(h.rt.live().lastError).toBe("Exited unexpectedly (SIGKILL)");
  expect(h.driver.last.sent[0]?.[0]?.body).toContain("(signal SIGKILL) during a turn");
});

test("stop_failed names the pid and a later stop escalates again", async () => {
  await h.makeRuntime();
  await idle();
  const p = h.driver.last;
  p.stopResult = { code: null, signal: null, timedOut: true };
  p.emitExitOnStop = false;
  let kills = 0;
  p.forceKill = async () => {
    kills += 1;
    throw new Error("EPERM");
  };
  await h.rt.hibernate("warm_window");
  await h.rt.settled();
  expect(h.rt.live().lastError).toBe(
    "The agent's process can't be stopped. Check the host (pid 4242) or Docker, then restart again.",
  );
  await h.rt.stop();
  expect(kills).toBe(2);
});

test("Restart of a stop_failed agent with no process: one more cleanup; a failure keeps the slot and wakes nothing", async () => {
  const slots = new RecordingSlots();
  let fail = true;
  const cleanup = vi.fn(async () => {
    if (fail) throw new Error("docker down");
    return { container: "stopped" as const };
  });
  await h.makeRuntime({ slots, cleanup });
  await idle();
  h.driver.last.emit(ev.turn());
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(h.rt.live().errorKind).toBe("stop_failed");
  slots.events.length = 0;

  await h.rt.restart({ byHandle: "or", runtimeAllowed: true });
  await h.rt.settled();
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(h.rt.live()).toMatchObject({ status: "errored", errorKind: "stop_failed" });
  expect(slots.events).toEqual([["stop_failed"]]);
  expect(h.driver.starts).toHaveLength(1);
  expect(await row()).toMatchObject({ error_kind: "stop_failed", attempting: false });

  // The retry succeeds: the held slot is released, then the restart's wake follows as usual.
  fail = false;
  slots.events.length = 0;
  await h.rt.restart({ byHandle: "or", runtimeAllowed: true });
  await h.rt.settled();
  expect(slots.events.slice(0, 2)).toEqual([["release"], ["request", "restart"]]);
  expect(await events()).toContainEqual({ type: "cleanup", container: "stopped" });
  expect(h.driver.starts).toHaveLength(2);
  expect(h.driver.last.sent[0]?.[0]?.body).toBe("Restarted by @or after an error.");
  expect(await row()).toMatchObject({ attempting: true });
});
